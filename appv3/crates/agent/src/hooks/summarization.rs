//! `SummarizationHook` — context-window summarization.

use super::{AgentState, Hook, ModelRequest, RunContext};
use crate::events::{self, UsageFrame};
use crate::plan;
use crate::prompts;
use crate::stream_store::store;
use crate::streaming::{merge_consecutive_user_messages, RetryItem, RetryStream};
use appv3_providers::{registry::get_model_limits, usage::usage_to_dict, ChatMessage, ContentBlock, Kwargs, LlmProvider, MessageMeta};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use super::otel::{set_usage_span_attributes, WORKSPACE_ATTR};
use appv3_core::otel::{self, Span, SpanKind};

/// Who a summarization span belongs to. The LLM-call span carries it too:
/// a compaction-only run's spend must stay attributable to its session
/// and workspace even if nothing else in the trace says so.
fn span_identity(ctx: &RunContext) -> Vec<(&'static str, Value)> {
    let mut attrs =
        vec![("gen_ai.agent.name", json!(ctx.agent_name)), ("gen_ai.conversation.id", json!(ctx.session_id.clone().unwrap_or_default())), ("run_id", json!(ctx.run_id))];
    if let Some(ws) = ctx.workspace.as_deref().filter(|w| !w.is_empty()) {
        attrs.push((WORKSPACE_ATTR, json!(ws)));
    }
    attrs
}

/// A failed summariser LLM call (`type(exc).__name__`, qualified name, `str(exc)`).
struct LlmFailure {
    name: String,
    qualified: String,
    message: String,
    cancelled: bool,
}

pub const DEFAULT_PROMPT_TOKEN_THRESHOLD: i64 = 250_000;
pub const CONTEXT_RATIO: f64 = 0.9;
pub const DEFAULT_KEEP_LAST_ASSISTANTS: usize = 3;
pub const CODING_KEEP_LAST_ASSISTANTS: usize = 0;
pub const DEFAULT_MAX_TOKEN_LENGTH: i64 = 16_000;
/// Smallest summary budget worth asking for when the context is nearly full.
pub const MIN_SUMMARY_TOKENS: i64 = 1_024;
pub const DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY: usize = 4;
/// Follows the summary in what the model reads. Most compactions happen
/// mid-turn, where the agent resumes from the summary alone; without this a
/// bare `## Goal…` user message reads like a new request.
const SUMMARY_HANDOFF_NOTE: &str =
    "This summary replaces the earlier conversation; it is not a new message from the user. If the latest request is unfinished, continue from its next steps.";
/// Ends the summary request when the user wrote nothing after the earlier note.
const NO_NEW_PROMPT_RULE: &str = "The user has sent no new message since the earlier handoff note: keep its latest user request unchanged and update only its status.";
/// Follows the `runtime_notes` prompt, which names the user-role messages
/// the user did not write. The summariser otherwise quoted a Code-mode note
/// or a goal reminder as the user's latest request.
const RUNTIME_NOTES_RULE: &str = "Never quote or record them as the user's words.";
/// Longest latest request repeated in the summary request; the full text is
/// in the conversation above it.
const MAX_LATEST_PROMPT_CHARS: usize = 4_000;

/// What the summariser is told about the user's latest request.
enum LatestPrompt {
    /// The newest message the user wrote, header removed.
    Wrote(String),
    /// A prior summary is newer than any message the user wrote.
    NoneSinceSummary,
    /// Neither: nothing to point at.
    Unknown,
}

impl LatestPrompt {
    fn text(&self) -> Option<&str> {
        match self {
            Self::Wrote(t) => Some(t),
            _ => None,
        }
    }
}

/// The newest message the user wrote among `ids`.
fn latest_prompt(messages: &[ChatMessage], ids: &[usize]) -> LatestPrompt {
    for &i in ids.iter().rev() {
        let m = &messages[i];
        if m.meta().is_summary() {
            return LatestPrompt::NoneSinceSummary;
        }
        if crate::history::is_user_prompt(m) {
            if let Some(text) = crate::history::prompt_text(m).map(str::trim).filter(|t| !t.is_empty()) {
                return LatestPrompt::Wrote(text.to_string());
            }
        }
    }
    LatestPrompt::Unknown
}

/// The part of the summary request that says which message the user wrote.
fn latest_prompt_hint(latest: &LatestPrompt) -> String {
    let notes = format!("{} {RUNTIME_NOTES_RULE}", prompts::s("runtime_notes"));
    match latest {
        LatestPrompt::Wrote(text) => {
            let head = crate::util::head_chars(text, MAX_LATEST_PROMPT_CHARS);
            let cut = if head.len() < text.len() { "\n[…cut; the full message is in the conversation above]" } else { "" };
            let quoted = crate::goal::fence(head, &["latest_user_message"]);
            format!("{notes}\nThe user's most recent message, which is their latest request:\n<latest_user_message>\n{quoted}{cut}\n</latest_user_message>")
        }
        LatestPrompt::NoneSinceSummary => format!("{notes}\n{NO_NEW_PROMPT_RULE}"),
        LatestPrompt::Unknown => notes,
    }
}

/// `m` as the model reads it: a summary is framed as a handoff note. Applied
/// on every request (never stored), so the prompt-cache prefix stays stable
/// and the UI keeps showing the plain summary.
pub fn for_model(m: &ChatMessage) -> ChatMessage {
    let mut out = m.clone();
    if m.meta().is_summary() {
        if let ChatMessage::User { content: Some(text), .. } = &m {
            out.set_content(Some(format!("<conversation_summary>\n{text}\n</conversation_summary>\n{SUMMARY_HANDOFF_NOTE}")));
        }
    }
    out
}
/// Chars per token assumed for text no reported usage covers. Low on
/// purpose: over-counting the prompt only makes the summary budget smaller.
const FALLBACK_CHARS_PER_TOKEN: usize = 3;
/// Chars an image counts as; its base64 size says nothing about its token
/// cost (~1-2k tokens on current providers).
const IMAGE_CHARS: usize = 6_000;

fn blocks_chars(parts: Option<&[ContentBlock]>) -> usize {
    parts
        .unwrap_or_default()
        .iter()
        .map(|p| match p {
            ContentBlock::Text { text } => text.len(),
            _ => IMAGE_CHARS,
        })
        .sum()
}

/// Prompt text a message contributes, for proportional token estimates.
fn message_chars(m: &ChatMessage) -> usize {
    let len = |s: &Option<String>| s.as_deref().map_or(0, str::len);
    match m {
        ChatMessage::System { content, .. } => len(content),
        ChatMessage::User { content, parts, .. } => len(content) + blocks_chars(parts.as_deref()),
        ChatMessage::Tool { content, parts, name, .. } => len(content) + len(name) + blocks_chars(parts.as_deref()),
        ChatMessage::Assistant(a) => {
            len(&a.content) + len(&a.reasoning_content) + a.tool_calls.iter().flatten().map(|tc| tc.function.name.len() + tc.function.arguments.len()).sum::<usize>()
        }
    }
}

/// Prompt tokens the provider reported for the call that produced `m`.
fn reported_prompt_tokens(m: &ChatMessage) -> Option<i64> {
    let ChatMessage::Assistant(a) = m else { return None };
    a.meta.extra.as_ref()?.get("usage")?.get("input")?.as_i64().filter(|n| *n > 0)
}

/// Estimated prompt tokens of the summariser `request`.
///
/// The newest reply with reported usage gives the token count of everything
/// visible before it; messages after it are estimated from their length.
/// The request is a subset of that context (minus the keep window, plus the
/// summary instructions), so it scales by its share of the context's text.
fn estimate_request_tokens(visible: &[ChatMessage], system_prompt: &str, tools_chars: usize, request: &[ChatMessage]) -> i64 {
    let request_chars = request.iter().map(message_chars).sum::<usize>() + tools_chars;
    let fallback = |chars: usize| chars.div_ceil(FALLBACK_CHARS_PER_TOKEN) as i64;
    let Some((anchor, reported)) = visible.iter().enumerate().rev().find_map(|(i, m)| reported_prompt_tokens(m).map(|t| (i, t))) else {
        return fallback(request_chars);
    };
    let seen_chars = system_prompt.len() + tools_chars + visible[..anchor].iter().map(message_chars).sum::<usize>();
    let tail_chars: usize = visible[anchor..].iter().map(message_chars).sum();
    let context_tokens = reported + fallback(tail_chars);
    let context_chars = (seen_chars + tail_chars).max(1);
    (context_tokens as f64 * request_chars as f64 / context_chars as f64).ceil() as i64
}

/// Output budget for a summary whose request is `prompt_tokens` long: `cap`,
/// shrunk to what the context window leaves (minus a margin for estimate
/// error), but never below [`MIN_SUMMARY_TOKENS`]. `None` sends no limit:
/// with an unknown context window a fixed cap may not fit, while the
/// provider's default does.
fn summary_max_tokens(cap: i64, context_window: Option<i64>, prompt_tokens: i64) -> Option<i64> {
    if cap <= 0 {
        return None;
    }
    let window = context_window?;
    let margin = (prompt_tokens / 50).max(512);
    Some((window - prompt_tokens - margin).clamp(MIN_SUMMARY_TOKENS.min(cap), cap))
}

pub fn prompt_token_threshold_for_model(model_id: Option<&str>) -> i64 {
    let l = get_model_limits(model_id);
    let known: Vec<i64> = [l.context_length, l.max_input_tokens].into_iter().flatten().collect();
    match known.iter().min() {
        Some(m) => (*m as f64 * CONTEXT_RATIO) as i64,
        None => DEFAULT_PROMPT_TOKEN_THRESHOLD,
    }
}

pub fn resolve_prompt_token_threshold(model_id: Option<&str>, custom: Option<i64>) -> i64 {
    let auto = prompt_token_threshold_for_model(model_id);
    match custom {
        Some(c) if c < auto => c,
        _ => auto,
    }
}

/// Source of the user's `summarization.prompt_token_threshold` override.
pub type CustomThreshold = Arc<dyn Fn() -> Option<i64> + Send + Sync>;

fn custom_threshold_from_settings() -> Option<i64> {
    cached_custom_threshold(&appv3_core::settings::settings().runtime_settings_path())
}

/// Files modified this recently are always re-read: on filesystems with
/// coarse mtimes a second save in the same tick keeps the same stamp.
const RACY_WINDOW: Duration = Duration::from_secs(2);

struct CachedThreshold {
    path: PathBuf,
    /// `(mtime, len)` of `settings.yaml`, `None` when it could not be stat'ed.
    stamp: Option<(SystemTime, u64)>,
    value: Option<i64>,
}

static CUSTOM_THRESHOLD_CACHE: Mutex<Option<CachedThreshold>> = Mutex::new(None);

fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// `summarization.prompt_token_threshold` from `path`, re-parsed only when the
/// file's mtime or size changes (a stat is ~1µs; a parse is ~1ms).
fn cached_custom_threshold(path: &Path) -> Option<i64> {
    let stamp = file_stamp(path);
    let racy = stamp.is_some_and(|(mtime, _)| SystemTime::now().duration_since(mtime).map_or(true, |age| age < RACY_WINDOW));
    let mut cache = CUSTOM_THRESHOLD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(hit) = cache.as_ref().filter(|c| !racy && c.path == path && c.stamp == stamp) {
        return hit.value;
    }
    let value = appv3_core::runtime_settings::load_runtime_settings_from(path).ok().and_then(|s| s.summarization.prompt_token_threshold);
    *cache = Some(CachedThreshold { path: path.to_path_buf(), stamp, value });
    value
}

/// Called with `(session_id, summary)` after each successful compaction of a
/// session, and the newest message the user wrote that it covered (`None`
/// when it covered none); see [`crate::hooks::title::build_summary_retitle`].
pub type OnSummary = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

pub struct SummarizationHook {
    provider: Arc<dyn LlmProvider>,
    model_id: Option<String>,
    /// Read on every model call so a settings change applies mid-turn.
    custom_threshold: CustomThreshold,
    keep_last: usize,
    summary_prompt: String,
    /// Upper bound on the summary's `max_tokens`; 0 sends none.
    max_token_length: i64,
    /// Model context window (prompt + output), when the registry knows it.
    context_window: Option<i64>,
    min_since_last: usize,
    support_interrupt: bool,
    at_last_summary: Mutex<usize>,
    pending: Mutex<bool>,
    /// Session artifacts directory holding `plan.md`; see [`crate::plan`].
    plan_dir: Option<PathBuf>,
    on_summary: Option<OnSummary>,
}

/// `build_summarization_hook`.
pub fn build_summarization_hook(provider: Arc<dyn LlmProvider>, mode: &str, model_id: Option<&str>, support_interrupt: bool) -> Option<SummarizationHook> {
    let limits = get_model_limits(model_id);
    let max_len = limits.max_completion_tokens.map(|m| m.min(DEFAULT_MAX_TOKEN_LENGTH)).unwrap_or(DEFAULT_MAX_TOKEN_LENGTH);
    let threshold = resolve_prompt_token_threshold(model_id, custom_threshold_from_settings());
    tracing::info!(
        "summarization_config model={:?} context_length={:?} max_input_tokens={:?} effective_threshold={}",
        model_id,
        limits.context_length,
        limits.max_input_tokens,
        threshold
    );
    let coding = mode == "coding";
    Some(SummarizationHook {
        provider,
        model_id: model_id.map(String::from),
        custom_threshold: Arc::new(custom_threshold_from_settings),
        keep_last: if coding { CODING_KEEP_LAST_ASSISTANTS } else { DEFAULT_KEEP_LAST_ASSISTANTS },
        summary_prompt: prompts::s(if coding { "summary_coding" } else { "summary_chat" }).to_string(),
        max_token_length: max_len,
        context_window: limits.context_length,
        min_since_last: DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY,
        support_interrupt,
        at_last_summary: Mutex::new(0),
        pending: Mutex::new(false),
        plan_dir: None,
        on_summary: None,
    })
}

fn extra_truthy(m: &ChatMessage, key: &str) -> bool {
    m.meta().extra.as_ref().and_then(|e| e.get(key)).map(crate::util::truthy).unwrap_or(false)
}

/// Assistant-turn cutoff over `msgs` (indices into eligible).
fn find_assistant_cutoff(msgs: &[&ChatMessage], keep_last: usize) -> usize {
    if keep_last == 0 {
        return msgs.len();
    }
    let mut remaining = keep_last;
    for i in (0..msgs.len()).rev() {
        if msgs[i].role() == "assistant" {
            remaining -= 1;
            if remaining == 0 {
                return i;
            }
        }
    }
    0
}

/// Expand tool call/result pair ids over state indices.
fn expand_tool_pairs(messages: &[ChatMessage], pool: &[usize], seed: HashSet<usize>) -> HashSet<usize> {
    if seed.is_empty() {
        return seed;
    }
    let mut a_by: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut t_by: HashMap<String, HashSet<usize>> = HashMap::new();
    for &i in pool {
        match &messages[i] {
            ChatMessage::Assistant(a) => {
                for tc in a.tool_calls.iter().flatten() {
                    if !tc.id.is_empty() {
                        a_by.entry(tc.id.clone()).or_default().insert(i);
                    }
                }
            }
            ChatMessage::Tool { tool_call_id, .. } if !tool_call_id.is_empty() => {
                t_by.entry(tool_call_id.clone()).or_default().insert(i);
            }
            _ => {}
        }
    }
    let mut expanded = seed;
    loop {
        let mut changed = false;
        for &i in pool {
            if !expanded.contains(&i) {
                continue;
            }
            let mut related = HashSet::new();
            match &messages[i] {
                ChatMessage::Assistant(a) => {
                    for tc in a.tool_calls.iter().flatten() {
                        related.extend(t_by.get(&tc.id).cloned().unwrap_or_default());
                    }
                }
                ChatMessage::Tool { tool_call_id, .. } if !tool_call_id.is_empty() => {
                    related.extend(a_by.get(tool_call_id).cloned().unwrap_or_default());
                }
                _ => {}
            }
            for r in related {
                if expanded.insert(r) {
                    changed = true;
                }
            }
        }
        if !changed {
            return expanded;
        }
    }
}

/// Tool call/result pair ids of `skill` calls.
fn skill_tool_pairs(messages: &[ChatMessage], pool: &[usize]) -> HashSet<usize> {
    let mut call_ids = HashSet::new();
    let mut ids = HashSet::new();
    let mut seen = HashSet::new();
    for &i in pool {
        if let ChatMessage::Assistant(a) = &messages[i] {
            for tc in a.tool_calls.iter().flatten() {
                if tc.id.is_empty() || tc.function.name != "skill" {
                    continue;
                }
                let args: Value = serde_json::from_str(if tc.function.arguments.is_empty() { "{}" } else { &tc.function.arguments }).unwrap_or(Value::Null);
                let Some(name) = args.get("skill_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                    continue;
                };
                if !seen.insert(name.to_string()) {
                    continue;
                }
                call_ids.insert(tc.id.clone());
                ids.insert(i);
            }
        }
    }
    if call_ids.is_empty() {
        return HashSet::new();
    }
    for &i in pool {
        if let ChatMessage::Tool { tool_call_id, .. } = &messages[i] {
            if call_ids.contains(tool_call_id) {
                ids.insert(i);
            }
        }
    }
    expand_tool_pairs(messages, pool, ids)
}

/// The newest Plan/Code instruction note in `pool`, if any.
///
/// The note is appended once per mode switch and is not re-added while it
/// exists in history, so compacting it away would leave the model without
/// the active mode's rules (Plan mode's read-only workflow and
/// plan tools) until the next switch. Older notes are
/// superseded and compact like anything else.
fn active_mode_note(messages: &[ChatMessage], pool: &[usize]) -> Option<usize> {
    pool.iter().rev().copied().find(|&i| extra_truthy(&messages[i], "interaction_mode_prompt"))
}

/// Restate the session plan in a pinned note just before the summary at
/// `summary_at`, so the summary (latest progress and request) is still read
/// last and the plan survives the reload window like the mode note does.
///
/// Skipped while an earlier plan note is still in the kept window. Earlier
/// notes that were summarised are already excluded and unpinned like any
/// other message.
fn carry_plan(state: &mut AgentState, summary_at: usize, note: Option<String>) -> bool {
    let Some(note) = note else {
        return false;
    };
    let in_context = state.messages.iter().filter(|m| !m.meta().exclude_from_context).any(|m| extra_truthy(m, plan::SESSION_PLAN_KEY));
    if in_context {
        return false;
    }
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert(plan::SESSION_PLAN_KEY.into(), json!(true));
    let meta = MessageMeta { kind: "note".into(), pinned: true, extra: Some(extra), ..Default::default() };
    state.messages.insert(summary_at, ChatMessage::User { content: Some(note), parts: None, meta });
    true
}

/// `extra` key of the note [`carry_commands`] writes.
pub const BACKGROUND_COMMANDS_KEY: &str = "background_commands";

/// Place `note` (the background commands still running) right after the
/// newest summary. It is not pinned: the next compaction summarises it and
/// writes a fresh one for what still runs then.
fn carry_commands(state: &mut AgentState, note: Option<String>) -> bool {
    let (Some(note), Some(summary_at)) = (note, state.messages.iter().rposition(|m| m.meta().is_summary())) else {
        return false;
    };
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert(BACKGROUND_COMMANDS_KEY.into(), json!(true));
    let meta = MessageMeta { kind: "note".into(), extra: Some(extra), ..Default::default() };
    state.messages.insert(summary_at + 1, ChatMessage::User { content: Some(note), parts: None, meta });
    true
}

impl SummarizationHook {
    /// Effective trigger for the next model call.
    fn threshold(&self) -> i64 {
        resolve_prompt_token_threshold(self.model_id.as_deref(), (self.custom_threshold)())
    }

    pub fn with_plan_dir(mut self, dir: PathBuf) -> Self {
        self.plan_dir = Some(dir);
        self
    }

    pub fn with_on_summary(mut self, f: OnSummary) -> Self {
        self.on_summary = Some(f);
        self
    }

    fn at_user_turn_boundary(state: &AgentState) -> bool {
        let visible = state.messages_for_llm();
        let Some(last) = visible.last() else {
            return true;
        };
        if !matches!(last, ChatMessage::User { .. }) || last.meta().is_summary() {
            return false;
        }
        if extra_truthy(last, "hidden_from_summary") {
            return false;
        }
        match last.meta().extra.as_ref().and_then(|e| e.get("from_agent")) {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s == "user",
            _ => false,
        }
    }

    /// The LLM call inside the `summarization_llm_call` CLIENT span.
    async fn call_llm(&self, ctx: &RunContext, messages: Vec<ChatMessage>, tools: Option<&[Value]>, max_tokens: Option<i64>) -> Result<(String, Option<Value>), LlmFailure> {
        let span = Span::start("summarization_llm_call", SpanKind::Client, span_identity(ctx));
        let t0 = std::time::Instant::now();
        let model_id = self.model_id.clone().or_else(|| self.provider.cost_model_id()).filter(|m| !m.is_empty());
        let mut provider_name = self.provider.provider_name().filter(|p| !p.is_empty()).map(String::from);
        span.set_attr("gen_ai.operation.name", "summarization");
        if let Some(p) = &provider_name {
            span.set_attr("gen_ai.provider.name", p.as_str());
        }
        if let Some(mid) = &model_id {
            let mut model_name = mid.clone();
            if let Some((pp, pm)) = mid.split_once(':') {
                if provider_name.is_none() {
                    provider_name = Some(pp.to_string()).filter(|p| !p.is_empty());
                }
                if !pm.is_empty() {
                    model_name = pm.to_string();
                }
            }
            span.set_attr("gen_ai.request.model", model_name);
            if let Some(p) = &provider_name {
                span.set_attr("gen_ai.provider.name", p.as_str());
            }
        }
        if let Some(m) = max_tokens {
            span.set_attr("gen_ai.request.max_tokens", m);
        }
        let res =
            otel::scope(Some(span.ctx()), self.call_llm_inner(ctx, messages, tools, max_tokens, model_id.clone(), crate::streaming::routes_by_session(provider_name.as_deref())))
                .await;
        match res {
            Err(f) => {
                if f.cancelled {
                    span.exit_with_exception("asyncio.exceptions.CancelledError", "");
                } else {
                    span.set_attr("error.type", f.name.as_str());
                    span.set_error();
                    span.exit_with_exception(&f.qualified, &f.message);
                }
                Err(f)
            }
            Ok((text, last_usage)) => {
                span.set_attr("summarization.llm_duration_s", json!(appv3_core::pymath::py_round(t0.elapsed().as_secs_f64(), 3)));
                span.set_attr("summarization.response_length", text.chars().count());
                let usage = last_usage.map(|u| usage_to_dict(&u, model_id.as_deref()));
                if let Some(u) = &usage {
                    tracing::info!(
                        "summarization_usage model={:?} input={:?} output={:?} cache={}",
                        model_id,
                        u.get("input"),
                        u.get("output"),
                        u.get("cache").cloned().unwrap_or(json!(0))
                    );
                    set_usage_span_attributes(&span, u);
                }
                span.set_ok();
                span.end();
                Ok((text.trim().to_string(), usage))
            }
        }
    }

    async fn call_llm_inner(
        &self,
        ctx: &RunContext,
        messages: Vec<ChatMessage>,
        tools: Option<&[Value]>,
        max_tokens: Option<i64>,
        model_id: Option<String>,
        send_session_id: bool,
    ) -> Result<(String, Option<appv3_providers::Usage>), LlmFailure> {
        let mut kw = Kwargs::new();
        if let Some(m) = max_tokens {
            kw.insert("max_tokens".into(), json!(m));
        }
        kw.insert("tool_choice".into(), json!("none"));
        if send_session_id {
            if let Some(s) = &ctx.session_id {
                kw.insert("session_id".into(), json!(s));
            }
        }
        let label = model_id.clone().unwrap_or_else(|| "summarizer".into());
        let messages = crate::streaming::fit_request_images(messages, &label).await;
        let mut rs = RetryStream::new(self.provider.clone(), label, &messages, tools, kw, None, None);
        let mut text = String::new();
        let mut last_usage = None;
        loop {
            match rs.next().await {
                Ok(Some(RetryItem::Restart)) => text.clear(),
                Ok(Some(RetryItem::Chunk(c))) => {
                    if c.usage.is_some() {
                        last_usage = c.usage.clone();
                    }
                    if let Some(content) = c.choices.first().and_then(|ch| ch.delta.content.clone()).filter(|s| !s.is_empty()) {
                        text.push_str(&content);
                        if let Some(sid) = &ctx.session_id {
                            store().push_event(sid, &events::summarization_content(&ctx.agent_name, &content), false);
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    return Err(match e {
                        crate::streaming::ModelError::Agent(a) => {
                            let (name, qualified) = crate::errors::python_exception_names(&a);
                            LlmFailure { name: name.into(), qualified, message: a.to_string(), cancelled: matches!(a, crate::errors::AgentError::Cancelled) }
                        }
                        crate::streaming::ModelError::Transient { error_type, message } => {
                            LlmFailure { qualified: format!("httpx2.{error_type}"), name: error_type, message, cancelled: false }
                        }
                    })
                }
            }
        }
        Ok((text, last_usage))
    }

    fn emit_end(&self, ctx: &RunContext, summary: &str, error: bool, forced: bool) {
        if let Some(sid) = &ctx.session_id {
            let mut meta = json!({});
            if error {
                meta["error"] = json!(true);
            }
            if forced {
                meta["forced"] = json!(true);
            }
            store().push_event(sid, &events::summarization_end(&ctx.agent_name, summary, Some(meta)), false);
        }
    }

    async fn summarise(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str) -> bool {
        tracing::info!("summarization_started session_id={:?} agent={}", ctx.session_id, ctx.agent_name);
        let mut attrs = span_identity(ctx);
        attrs.push(("summarization.prompt_tokens", json!(state.usage.last_prompt_tokens)));
        attrs.push(("summarization.threshold", json!(self.threshold())));
        let span = Span::start("summarization", SpanKind::Internal, attrs);
        let (done, cancelled) = otel::scope(Some(span.ctx()), self.summarise_inner(ctx, state, system_prompt, &span)).await;
        if cancelled {
            span.exit_with_exception("asyncio.exceptions.CancelledError", "");
        } else {
            span.end();
        }
        done
    }

    /// Returns `(summarised, cancelled)`.
    async fn summarise_inner(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str, span: &Span) -> (bool, bool) {
        // `/compact` and idle compaction run alone, not inside an agent run.
        let forced = state.meta_get("force_summarization") == Some(Value::Bool(true));
        // Every visible message, runtime notes included: the request must
        // match the main turn's history to read its prompt cache.
        let eligible: Vec<usize> =
            (0..state.messages.len()).filter(|&i| !state.messages[i].meta().exclude_from_context && !matches!(state.messages[i], ChatMessage::System { .. })).collect();
        if eligible.is_empty() {
            tracing::debug!("summarization_skipped_no_messages session_id={:?}", ctx.session_id);
            span.set_attr("summarization.skipped", "no_messages");
            span.set_ok();
            return (false, false);
        }
        let refs: Vec<&ChatMessage> = eligible.iter().map(|&i| &state.messages[i]).collect();
        let cutoff = find_assistant_cutoff(&refs, self.keep_last);
        let seed: HashSet<usize> = if cutoff > 0 { eligible[..cutoff].iter().copied().collect() } else { eligible.iter().copied().collect() };
        let to_ids = expand_tool_pairs(&state.messages, &eligible, seed);
        let mut retained = skill_tool_pairs(&state.messages, &eligible);
        // A mode note already in the kept window stays where it is; retaining
        // it would move the summary below it.
        retained.extend(active_mode_note(&state.messages, &eligible).filter(|i| to_ids.contains(i)));
        let to_summarise: Vec<usize> = eligible.iter().copied().filter(|i| to_ids.contains(i)).collect();
        if to_summarise.is_empty() {
            tracing::debug!("summarization_skipped_all_messages_in_keep_window session_id={:?}", ctx.session_id);
            span.set_attr("summarization.skipped", "all_in_keep_window");
            span.set_ok();
            return (false, false);
        }
        let has_prior = to_summarise.iter().any(|&i| state.messages[i].meta().is_summary());
        let request_line = prompts::s(if has_prior { "summary_merge" } else { "summary_request" });
        let plan_note = self.plan_dir.as_deref().and_then(plan::carry_note);
        let mut prefix = Vec::new();
        if !system_prompt.is_empty() {
            prefix.push(ChatMessage::system(system_prompt));
        }
        // Exactly what the main turn sent (an earlier plan note included;
        // `for_model` keeps a prior summary as the turn framed it), so the
        // request shares that turn's prompt-cache prefix.
        prefix.extend(to_summarise.iter().map(|&i| for_model(&state.messages[i])));
        let mut msgs = merge_consecutive_user_messages(prefix);
        // The hint goes in the final instruction, never into the
        // conversation above it, which shares the main turn's prompt cache.
        let latest = latest_prompt(&state.messages, &to_summarise);
        let mut request = format!("{request_line}\n\n{}\n\n{}", self.summary_prompt, latest_prompt_hint(&latest));
        if plan_note.is_some() {
            request.push_str("\n\n");
            request.push_str(plan::PLAN_SUMMARY_RULE);
        }
        msgs.push(ChatMessage::user(request));
        span.set_attr("summarization.messages_to_summarise", to_summarise.len());
        span.set_attr("summarization.keep_last_assistants", self.keep_last);
        span.set_attr("summarization.has_prior_summary", has_prior);

        if let Some(sid) = &ctx.session_id {
            store().push_event(sid, &events::summarization_start(&ctx.agent_name, forced), false);
        }
        let tools = if state.tool_defs.is_empty() { None } else { Some(state.tool_defs.as_slice()) };
        let tools_chars = tools.map_or(0, |t| serde_json::to_string(t).map_or(0, |s| s.len()));
        let estimated_prompt = estimate_request_tokens(&state.messages_for_llm(), system_prompt, tools_chars, &msgs);
        let max_tokens = summary_max_tokens(self.max_token_length, self.context_window, estimated_prompt);
        span.set_attr("summarization.estimated_prompt_tokens", estimated_prompt);
        let (text, usage) = match self.call_llm(ctx, msgs, tools, max_tokens).await {
            Ok(r) => r,
            Err(e) if e.cancelled => return (false, true),
            Err(e) => {
                tracing::error!("summarization_llm_failed session_id={:?} error={}", ctx.session_id, e.message);
                span.set_attr("error.type", e.name.as_str());
                span.set_error();
                self.emit_end(ctx, "", true, forced);
                return (false, false);
            }
        };
        if text.is_empty() {
            tracing::warn!("summarization_skipped_empty_response session_id={:?} agent={}", ctx.session_id, ctx.agent_name);
            span.set_attr("summarization.skipped", "empty_llm_response");
            span.set_ok();
            self.emit_end(ctx, "", true, forced);
            return (false, false);
        }
        let to_set: HashSet<usize> = to_summarise.iter().copied().collect();
        for (i, m) in state.messages.iter_mut().enumerate() {
            if to_set.contains(&i) && !retained.contains(&i) {
                let meta = m.meta_mut();
                meta.exclude_from_context = true;
                meta.pinned = false;
            }
        }
        for (i, m) in state.messages.iter_mut().enumerate() {
            if m.meta().is_summary() && !to_set.contains(&i) {
                m.meta_mut().exclude_from_context = true;
            }
        }
        let mut first_kept = match retained.iter().max() {
            Some(&mx) => mx + 1,
            None => state.messages.iter().position(|m| !m.meta().exclude_from_context).unwrap_or(state.messages.len()),
        };
        let last_excluded = state.messages.iter().rposition(|m| m.meta().exclude_from_context).map(|i| i as i64).unwrap_or(-1);
        first_kept = first_kept.max((last_excluded + 1) as usize);
        for m in state.messages[..first_kept].iter_mut() {
            if !m.meta().exclude_from_context && !matches!(m, ChatMessage::System { .. }) {
                m.meta_mut().pinned = true;
            }
        }
        // Every turn still sent was answered before this summary existed, so
        // its signed thinking is bound to a conversation the model no longer
        // sees (Anthropic rejects it). History loading does the same for the
        // saved rows (`history::get_messages_for_llm`).
        for m in state.messages.iter_mut() {
            if let ChatMessage::Assistant(a) = m {
                a.drop_signed_thinking();
            }
        }
        let mut meta = MessageMeta { kind: "summary".into(), ..Default::default() };
        let mut e = Map::new();
        if let Some(u) = &usage {
            e.insert("usage".into(), u.clone());
        }
        if forced {
            e.insert("forced".into(), json!(true));
        }
        if !e.is_empty() {
            meta.extra = Some(e);
        }
        state.messages.insert(first_kept, ChatMessage::User { content: Some(text.clone()), parts: None, meta });
        let plan_carried = carry_plan(state, first_kept, plan_note);
        carry_commands(state, ctx.session_id.as_deref().and_then(crate::background_commands::carry_note));
        *self.at_last_summary.lock().unwrap() = state.messages.len();
        span.set_attr("summarization.summary_length", text.chars().count());
        span.set_attr("summarization.kept", eligible.len() - to_summarise.len());
        span.set_attr("summarization.plan_carried", plan_carried);
        span.set_ok();

        if let Some(sid) = &ctx.session_id {
            if let Some(u) = &usage {
                let int = |k: &str| u.get(k).and_then(|v| v.as_i64());
                let mut md = json!({"agent": ctx.agent_name, "summarization": true});
                if let Some(m) = self.model_id.clone().or_else(|| self.provider.cost_model_id()).filter(|m| !m.is_empty()) {
                    md["model"] = json!(m);
                }
                let p = int("input").unwrap_or(0);
                let c = int("output").unwrap_or(0);
                store().push_event(
                    sid,
                    &events::usage(
                        &UsageFrame {
                            prompt_tokens: p,
                            completion_tokens: c,
                            total_tokens: p + c,
                            cached_tokens: int("cache"),
                            thoughts_tokens: int("thoughts"),
                            tool_use_tokens: None,
                            estimated_cost_usd: u.get("cost").and_then(|c| c.get("estimated_usd")).cloned(),
                        },
                        md,
                    ),
                    false,
                );
            }
            self.emit_end(ctx, &text, false, forced);
            if let Some(f) = &self.on_summary {
                f(sid, &text, latest.text());
            }
        }
        tracing::info!("summarization_complete session_id={:?} summarised={}", ctx.session_id, to_summarise.len());
        (true, false)
    }
}

#[async_trait]
impl Hook for SummarizationHook {
    async fn before_model(&self, ctx: &RunContext, state: &mut AgentState, _req: &ModelRequest) -> Option<ModelRequest> {
        let force = state.meta_get("force_summarization") == Some(Value::Bool(true));
        // A steer may have switched the turn's model; its window sets the trigger.
        let threshold = match state.meta_str("effective_model") {
            Some(m) if Some(&m) != self.model_id.as_ref() => resolve_prompt_token_threshold(Some(&m), (self.custom_threshold)()),
            _ => self.threshold(),
        };
        if threshold <= 0 && !force {
            return None;
        }
        if state.usage.last_prompt_tokens < threshold && !force {
            return None;
        }
        if self.min_since_last > 0 && !force {
            let at = *self.at_last_summary.lock().unwrap();
            if at > 0 && state.messages.len().saturating_sub(at) < self.min_since_last {
                return None;
            }
        }
        if !self.support_interrupt && !force && !Self::at_user_turn_boundary(state) {
            return None;
        }
        tracing::info!("summarization_triggered agent={} last_prompt_tokens={}", ctx.agent_name, state.usage.last_prompt_tokens);
        *self.pending.lock().unwrap() = true;
        None
    }

    async fn before_model_call(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str) -> bool {
        let pending = std::mem::replace(&mut *self.pending.lock().unwrap(), false);
        if !pending {
            return false;
        }
        self.summarise(ctx, state, system_prompt).await
    }
}

#[cfg(test)]
mod tests;
