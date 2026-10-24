//! `/btw` side questions: a quick question answered from what the session
//! already holds, without tools, kept out of the transcript.
//!
//! The request is the session's next model call as a turn would send it
//! (same system prompt, tools, history and provider), followed by the earlier
//! side questions and the new one, so a warm prompt cache covers everything
//! but the question. No `tool_choice` is forced: on Anthropic that would
//! invalidate the cached messages. The prompt forbids tools, and a tool call
//! the model makes anyway is dropped with a note.
//!
//! Generation runs in its own task, independent of the HTTP response: a
//! client that reloads mid-answer finds it stored when it finishes. Rows live
//! in `side_questions`; nothing touches `session_messages`, the session
//! stream, or the session's turn state.

use crate::agent::Agent;
use crate::events::{self, Envelope};
use crate::hooks::basic::{CurrentDateHook, MemoryContextHook, RuntimeProtocolHook, WorkspaceInstructionsHook};
use crate::hooks::{AgentState, Hook, RunContext};
use crate::session::{session_workspace_dir, AgentSession, SessionError};
use crate::streaming::{fit_request_images, merge_consecutive_user_messages, ModelError, RetryItem, RetryStream};
use crate::util::Event;
use appv3_core::otel::{Span, SpanKind};
use appv3_core::settings::settings;
use appv3_db::{self as db, DbPool, SideOutcome, SideQuestion};
use appv3_providers::{usage::usage_to_dict, ChatMessage, Kwargs, LlmProvider, ProviderError};
use appv3_tools::{DeniedPaths, ToolContext};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::mpsc;

/// Longest accepted question, in characters.
pub const MAX_QUESTION_CHARS: usize = 20_000;
/// Earlier answered side questions replayed with a new one.
pub const THREAD_LEN: i64 = 20;
/// Side questions kept per session; older ones are pruned on insert.
pub const KEEP_PER_SESSION: i64 = 100;

/// Appended when the model called a tool anyway.
const TOOL_CALL_NOTE: &str = "_(The model tried to use a tool. Side questions cannot run tools, so nothing was executed.)_";

// ── Request frame ────────────────────────────────────────────────────────────

/// System prompt and tool definitions of the lead's last model call.
#[derive(Debug, Clone, Default)]
pub struct RequestFrame {
    pub session_id: String,
    pub system_prompt: String,
    pub tool_defs: Arc<Vec<Value>>,
}

pub type FrameSlot = Arc<Mutex<Option<RequestFrame>>>;

/// Records the [`RequestFrame`] of each lead turn: the tools once per run,
/// the final system prompt on each model call.
pub struct RequestFrameHook {
    slot: FrameSlot,
}

impl RequestFrameHook {
    pub fn new(slot: FrameSlot) -> Self {
        Self { slot }
    }
}

#[async_trait]
impl Hook for RequestFrameHook {
    async fn before_agent(&self, ctx: &RunContext, state: &mut AgentState) {
        let Some(sid) = &ctx.session_id else { return };
        *self.slot.lock().unwrap() = Some(RequestFrame { session_id: sid.clone(), system_prompt: String::new(), tool_defs: Arc::new(state.tool_defs.clone()) });
    }

    async fn before_model_call(&self, ctx: &RunContext, _state: &mut AgentState, system_prompt: &str) -> bool {
        if let Some(f) = self.slot.lock().unwrap().as_mut() {
            if ctx.session_id.as_deref() == Some(f.session_id.as_str()) && f.system_prompt != system_prompt {
                f.system_prompt = system_prompt.to_string();
            }
        }
        false
    }
}

/// The frame a turn of `sid` would send now, rebuilt the way
/// `execute_turn` builds it. Used when no turn ran in this process yet.
pub(crate) async fn rebuild_frame(session: &AgentSession, agent: &Agent, sid: &str, workspace: &str) -> RequestFrame {
    let ws = (!workspace.is_empty()).then(|| workspace.to_string());
    let agent_mode = settings().workspace_mode(ws.as_deref().map(Path::new));
    let ctx = RunContext { session_id: Some(sid.to_string()), run_id: "side_question".into(), agent_name: agent.name.clone(), workspace: ws.clone() };
    let mut state = AgentState::new(vec![], agent.system_prompt.clone());
    RuntimeProtocolHook.before_agent(&ctx, &mut state).await;
    MemoryContextHook { content: session.memory_context().await, lead: session.parent_session_id.is_none() }.before_agent(&ctx, &mut state).await;
    let mut prompt = state.system_prompt.clone();
    prompt = CurrentDateHook.wrap_system_prompt(&ctx, &state, prompt).await;
    prompt = WorkspaceInstructionsHook::new(Some(workspace), agent_mode == "coding").wrap_system_prompt(&ctx, &state, prompt).await;

    let mut tools = agent.tools.clone();
    for t in session.injected_tools(sid, &agent.name, workspace, agent_mode) {
        tools.add(t);
    }
    let ws_path = session_workspace_dir(sid, Some(workspace));
    let tctx = ToolContext {
        session_id: Some(sid.to_string()),
        agent_name: agent.name.clone(),
        tool_call_id: String::new(),
        denied: Arc::new(DeniedPaths::new(&ws_path, Some(sid.to_string()))),
        workspace: ws,
        output: None,
        metadata: state.metadata.clone(),
        messages: None,
    };
    RequestFrame { session_id: sid.to_string(), system_prompt: prompt, tool_defs: Arc::new(tools.definitions_for(&tctx)) }
}

// ── Running side questions ───────────────────────────────────────────────────

struct Running {
    session_id: String,
    cancel: Event,
}

/// Side questions being answered in this process, by on-disk id.
fn running() -> &'static Mutex<HashMap<String, Running>> {
    static R: OnceLock<Mutex<HashMap<String, Running>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

pub fn is_running(id: &str) -> bool {
    running().lock().unwrap().contains_key(&db::codec::db_id(id))
}

/// Stop one running side question of `session_id`. False when it is not running.
pub fn stop(session_id: &str, id: &str) -> bool {
    let sid = db::codec::db_id(session_id);
    match running().lock().unwrap().get(&db::codec::db_id(id)) {
        Some(r) if r.session_id == sid => {
            r.cancel.set();
            true
        }
        _ => false,
    }
}

/// Stop every running side question of `session_id`.
pub fn stop_session(session_id: &str) -> usize {
    let sid = db::codec::db_id(session_id);
    let map = running().lock().unwrap();
    let mut n = 0;
    for r in map.values().filter(|r| r.session_id == sid) {
        r.cancel.set();
        n += 1;
    }
    n
}

/// The newest `limit` side questions of a session, oldest first. A row left
/// `streaming` by a process that is gone is stored and returned as `stopped`.
pub async fn list(pool: &DbPool, session_id: &str, limit: i64) -> anyhow::Result<Vec<SideQuestion>> {
    let mut rows = db::list_side_questions(pool, session_id, limit).await?;
    for r in rows.iter_mut().filter(|r| r.status == db::SIDE_STREAMING && !is_running(&r.id)) {
        let out = SideOutcome { status: db::SIDE_STOPPED, answer: &r.answer, ..Default::default() };
        db::finish_side_question(pool, session_id, &r.id, out).await?;
        r.status = db::SIDE_STOPPED.into();
    }
    Ok(rows)
}

/// Stop and delete every side question of a session.
pub async fn clear(pool: &DbPool, session_id: &str) -> anyhow::Result<u64> {
    stop_session(session_id);
    db::clear_side_questions(pool, session_id).await
}

// ── Asking ───────────────────────────────────────────────────────────────────

/// A started side question: its API id and the events of its answer. The
/// answer keeps going (and is stored) when `events` is dropped.
pub struct SideAsk {
    pub id: String,
    pub events: mpsc::UnboundedReceiver<Envelope>,
}

fn precondition(message: impl Into<String>, status: u16) -> SessionError {
    SessionError::Precondition { message: message.into(), status }
}

fn provider_error(e: ProviderError) -> SessionError {
    match e {
        ProviderError::Unconfigured(m) | ProviderError::Auth(m) => precondition(m, 400),
        other => precondition(other.to_string(), 400),
    }
}

/// The request: the turn's system prompt and window, then the earlier side
/// questions, then this one.
fn build_messages(system_prompt: &str, history: Vec<ChatMessage>, prior: &[SideQuestion], question: &str) -> Vec<ChatMessage> {
    // The window a turn's first model call sends (`state.messages_for_llm()`).
    let state = AgentState::new(history.into_iter().filter(|m| !matches!(m, ChatMessage::System { .. })).collect(), String::new());
    let mut msgs = Vec::with_capacity(state.messages.len() + prior.len() * 2 + 2);
    msgs.push(ChatMessage::system(system_prompt));
    msgs.extend(state.messages_for_llm());
    for p in prior {
        msgs.push(ChatMessage::user(format!("[Side question] {}", p.question)));
        msgs.push(ChatMessage::assistant(p.answer.clone()));
    }
    msgs.push(ChatMessage::user(crate::prompts::s("btw_prompt").replace("{question}", question)));
    merge_consecutive_user_messages(msgs)
}

impl AgentSession {
    /// Start answering `question` for `session_id`.
    pub async fn ask_side_question(&self, session_id: &str, question: &str) -> Result<SideAsk, SessionError> {
        let pool = self.pool.clone();
        let row = db::get_session(&pool, session_id).await?.ok_or_else(|| precondition("Session not found.", 404))?;
        let agent = self.agent();
        let rp = self.resolve_runtime_provider(&agent, row.model.as_deref(), row.thinking_level.as_deref()).map_err(provider_error)?;
        let provider = rp.provider(&agent);
        let sid = db::codec::api_uuid(&row.id);
        let recorded = self.request_frame().lock().unwrap().clone().filter(|f| f.session_id == sid && !f.system_prompt.is_empty());
        let frame = match recorded {
            Some(f) => f,
            None => rebuild_frame(self, &agent, &sid, &row.workspace).await,
        };
        let history = crate::history::get_messages_for_llm(&pool, &sid).await?;
        let prior = db::recent_done_side_questions(&pool, &sid, THREAD_LEN).await?;
        let messages = build_messages(&frame.system_prompt, history, &prior, question);

        let rec = db::insert_side_question(&pool, &sid, question).await?;
        if let Err(e) = db::prune_side_questions(&pool, &sid, KEEP_PER_SESSION).await {
            tracing::warn!("side_question_prune_failed session_id={} error={}", sid, e);
        }
        let cancel = Event::new();
        running().lock().unwrap().insert(rec.id.clone(), Running { session_id: rec.session_id.clone(), cancel: cancel.clone() });
        let (tx, rx) = mpsc::unbounded_channel();
        let id = db::codec::api_uuid(&rec.id);
        let _ = tx.send(events::btw_start(&id, question));
        let mut kwargs = Kwargs::new();
        if crate::streaming::routes_by_session(provider.provider_name()) {
            kwargs.insert("session_id".into(), json!(sid));
        }
        let job = Job {
            pool,
            session_id: sid,
            id: id.clone(),
            question: question.to_string(),
            agent_name: agent.name.clone(),
            model: rp.effective_model.clone(),
            provider,
            messages,
            tool_defs: frame.tool_defs,
            kwargs,
            cancel,
            tx,
        };
        tokio::spawn(job.run());
        Ok(SideAsk { id, events: rx })
    }
}

struct Job {
    pool: DbPool,
    session_id: String,
    /// API form.
    id: String,
    question: String,
    agent_name: String,
    model: Option<String>,
    provider: Arc<dyn LlmProvider>,
    messages: Vec<ChatMessage>,
    tool_defs: Arc<Vec<Value>>,
    kwargs: Kwargs,
    cancel: Event,
    tx: mpsc::UnboundedSender<Envelope>,
}

#[derive(Default)]
struct Answer {
    text: String,
    usage: Option<appv3_providers::Usage>,
    called_tool: bool,
    cancelled: bool,
    error: Option<String>,
}

impl Job {
    async fn run(self) {
        let span = Span::start(
            "side_question",
            SpanKind::Client,
            vec![
                ("gen_ai.operation.name", json!("side_question")),
                ("gen_ai.conversation.id", json!(self.session_id)),
                ("gen_ai.agent.name", json!(self.agent_name)),
                ("side_question.question_length", json!(self.question.chars().count())),
            ],
        );
        let model_id = self.model.clone().or_else(|| self.provider.cost_model_id()).filter(|m| !m.is_empty());
        let mut provider_name = self.provider.provider_name().filter(|p| !p.is_empty()).map(String::from);
        if let Some((p, m)) = model_id.as_deref().and_then(|m| m.split_once(':')) {
            provider_name.get_or_insert_with(|| p.to_string());
            span.set_attr("gen_ai.request.model", m);
        }
        if let Some(p) = &provider_name {
            span.set_attr("gen_ai.provider.name", p.as_str());
        }
        let answer = appv3_core::otel::scope(Some(span.ctx()), self.stream(model_id.as_deref())).await;

        let usage = answer.usage.as_ref().map(|u| usage_to_dict(u, model_id.as_deref()));
        if let Some(u) = &usage {
            crate::hooks::otel::set_usage_span_attributes(&span, u);
        }
        let mut text = answer.text;
        if answer.called_tool {
            text = if text.trim().is_empty() { TOOL_CALL_NOTE.to_string() } else { format!("{}\n\n{TOOL_CALL_NOTE}", text.trim_end()) };
        }
        span.set_attr("side_question.answer_length", text.chars().count());
        let (status, event) = if let Some(err) = &answer.error {
            span.set_attr("error.type", "SideQuestionError");
            span.set_error();
            (db::SIDE_ERROR, events::btw_error(&self.id, db::SIDE_ERROR, err, &text))
        } else if answer.cancelled {
            span.set_attr("side_question.stopped", true);
            span.set_ok();
            (db::SIDE_STOPPED, events::btw_error(&self.id, db::SIDE_STOPPED, "Stopped.", &text))
        } else {
            span.set_ok();
            (db::SIDE_DONE, events::btw_done(&self.id, &text, self.model.as_deref(), usage.as_ref()))
        };
        span.end();
        let out = SideOutcome { status, answer: &text, error: answer.error.as_deref(), model: self.model.as_deref(), usage: usage.as_ref() };
        if let Err(e) = db::finish_side_question(&self.pool, &self.session_id, &self.id, out).await {
            tracing::warn!("side_question_save_failed session_id={} id={} error={}", self.session_id, self.id, e);
        }
        running().lock().unwrap().remove(&db::codec::db_id(&self.id));
        let _ = self.tx.send(event);
        tracing::info!("side_question_finished session_id={} id={} status={}", self.session_id, self.id, status);
    }

    async fn stream(&self, model_id: Option<&str>) -> Answer {
        let label = model_id.unwrap_or("side_question").to_string();
        let wire = fit_request_images(self.messages.clone(), &label).await;
        let tools = if self.tool_defs.is_empty() { None } else { Some(self.tool_defs.as_slice()) };
        let mut rs = RetryStream::new(self.provider.clone(), label, &wire, tools, self.kwargs.clone(), None, Some(self.cancel.clone()));
        let mut a = Answer::default();
        loop {
            let item = tokio::select! {
                biased;
                _ = self.cancel.wait() => {
                    a.cancelled = true;
                    break;
                }
                r = rs.next() => r,
            };
            match item {
                Ok(None) => break,
                Ok(Some(RetryItem::Restart)) => {
                    a.text.clear();
                    a.called_tool = false;
                    let _ = self.tx.send(events::btw_start(&self.id, &self.question));
                }
                Ok(Some(RetryItem::Chunk(c))) => {
                    if c.usage.is_some() {
                        a.usage = c.usage.clone();
                    }
                    let Some(choice) = c.choices.first() else { continue };
                    if choice.delta.tool_calls.as_ref().is_some_and(|t| !t.is_empty()) {
                        a.called_tool = true;
                    }
                    if let Some(text) = choice.delta.content.as_deref().filter(|s| !s.is_empty()) {
                        a.text.push_str(text);
                        let _ = self.tx.send(events::btw_delta(&self.id, text));
                    }
                }
                Err(ModelError::Agent(crate::errors::AgentError::Cancelled)) => {
                    a.cancelled = true;
                    break;
                }
                Err(ModelError::Agent(e)) => {
                    a.error = Some(e.to_string());
                    break;
                }
                Err(ModelError::Transient { message, .. }) => {
                    a.error = Some(message);
                    break;
                }
            }
        }
        if self.cancel.is_set() && a.error.is_none() {
            a.cancelled = true;
        }
        a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(q: &str, a: &str) -> SideQuestion {
        SideQuestion {
            session_id: "s".into(),
            id: "i".into(),
            question: q.into(),
            answer: a.into(),
            status: db::SIDE_DONE.into(),
            error: None,
            model: None,
            usage: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn messages_are_the_turn_window_then_the_thread_then_the_question() {
        let mut hidden = ChatMessage::user("compacted away");
        hidden.meta_mut().exclude_from_context = true;
        let history = vec![ChatMessage::system("old system"), hidden, ChatMessage::user("fix the build"), ChatMessage::assistant("Fixed config.yaml.")];
        let msgs = build_messages("SYS", history, &[row("which file?", "config.yaml")], "and the test?");
        let texts: Vec<(&str, &str)> = msgs.iter().map(|m| (m.role(), m.content().unwrap_or(""))).collect();
        assert_eq!(texts[0], ("system", "SYS"));
        assert_eq!(texts[1], ("user", "fix the build"));
        assert_eq!(texts[2], ("assistant", "Fixed config.yaml."));
        assert_eq!(texts[3], ("user", "[Side question] which file?"));
        assert_eq!(texts[4], ("assistant", "config.yaml"));
        assert_eq!(texts[5].0, "user");
        assert!(texts[5].1.starts_with("<side_question>") && texts[5].1.ends_with("Side question: and the test?"), "{}", texts[5].1);
        assert_eq!(msgs.len(), 6);
    }

    #[test]
    fn a_trailing_user_message_merges_with_the_question() {
        let msgs = build_messages("SYS", vec![ChatMessage::user("still waiting for a reply")], &[], "q");
        assert_eq!(msgs.len(), 2);
        let last = msgs[1].content().unwrap();
        assert!(last.starts_with("still waiting for a reply") && last.ends_with("Side question: q"), "{last}");
    }
}
