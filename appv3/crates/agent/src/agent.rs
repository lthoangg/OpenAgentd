//! The agent loop — port of `app/agent/agent_loop/core.py` (+ tool dispatch
//! and the tool-executor plan-mode gate).

use crate::checkpointer::Checkpointer;
use crate::errors::AgentError;
use crate::hooks::otel::RunEnd;
use crate::hooks::{AgentState, HookRef, ModelRequest, RunContext, SharedMeta, ToolCallScope};
use crate::interaction_mode::tool_allowed_in_mode;
use crate::streaming::{stream_and_assemble, ModelError, StreamArgs};
use crate::util::Event;
use appv3_providers::{usage::usage_to_dict, AssistantMessage, ChatMessage, ContentBlock, LlmProvider, MessageMeta, ToolCall, Usage};
use appv3_tools::{DeniedPaths, Suspension, ToolContext, ToolRef, ToolSet};
use futures::stream::{FuturesUnordered, StreamExt};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const MAX_AGENT_ITERATIONS: usize = 5000;
pub const MAX_CONCURRENT_TOOLS: usize = 10;
/// Most streamed output a cancelled call keeps (its tail), well under the
/// tool-result offload threshold.
const CANCELLED_OUTPUT_MAX_BYTES: usize = 16_384;
pub const ASK_USER: &str = "ask_user";
pub const ASK_LEAD: &str = "ask_lead";
pub const SUBMIT_PLAN: &str = crate::tools::plan::SUBMIT_PLAN_TOOL;
pub const ASK_MERGED_INTO_PRIMARY: &str = "Merged into your other ask_user call — the user sees a single card with every question.";
pub const SUBMIT_DEFERRED: &str = "Not submitted: this response also asks the user a question. Call submit_plan again after they answer.";
pub const SUBMIT_MERGED: &str = "Merged into your other submit_plan call.";
/// Hidden notes after a reply hit `max_tokens`, with and without a tool call.
pub const TRUNCATED_TOOL_CALL_NOTICE: &str = "Error: Your tool call was truncated and could not be executed because you exceeded the maximum output token limit (max_tokens). Retry in smaller steps, for example several smaller `patch` calls instead of one large one.";
pub const TRUNCATED_REPLY_NOTICE: &str =
    "Error: Your response was cut off because you exceeded the maximum output token limit (max_tokens). Please continue your response from where you left off.";

/// Tool names only the session injects; an agent config cannot claim them.
const RESERVED_TOOLS: [&str; 4] = [ASK_USER, ASK_LEAD, crate::tools::plan::PLAN_TOOL, SUBMIT_PLAN];

#[derive(Clone)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub provider: Arc<dyn LlmProvider>,
    pub model_id: Option<String>,
    /// The level `provider` was built with (agent config), if any.
    pub thinking_level: Option<String>,
    pub system_prompt: String,
    pub tools: ToolSet,
    pub mcp_servers: Vec<String>,
    pub max_iterations: usize,
    pub source_path: Option<PathBuf>,
    pub config_stamp: Vec<(PathBuf, Option<i128>)>,
}

impl Agent {
    pub fn new(provider: Arc<dyn LlmProvider>, name: &str, system_prompt: &str, tools: Vec<ToolRef>, model_id: Option<String>) -> Self {
        let mut set = ToolSet::new();
        for t in tools {
            if RESERVED_TOOLS.contains(&t.name()) {
                tracing::warn!("reserved_tool_name_rejected agent={} tool={}", name, t.name());
                continue;
            }
            set.add(t);
        }
        Self {
            id: uuid::Uuid::now_v7().to_string(),
            name: name.to_string(),
            description: None,
            provider,
            model_id,
            thinking_level: None,
            system_prompt: system_prompt.to_string(),
            tools: set,
            mcp_servers: vec![],
            max_iterations: MAX_AGENT_ITERATIONS,
            source_path: None,
            config_stamp: vec![],
        }
    }
}

pub struct RunOptions<'a> {
    pub session_id: Option<String>,
    pub metadata: Map<String, Value>,
    pub hooks: Vec<HookRef>,
    pub injected_tools: Vec<ToolRef>,
    pub interrupt: Option<Event>,
    pub hard_cancel: Option<Event>,
    pub checkpointer: Option<&'a Checkpointer>,
    pub provider: Option<Arc<dyn LlmProvider>>,
    pub model_id: Option<String>,
    pub denied: Arc<DeniedPaths>,
    pub workspace: Option<String>,
}

#[derive(Debug, Default)]
pub struct RunOutcome {
    pub messages: Vec<ChatMessage>,
    /// Run metadata written by the loop (`question_suspended`, `lead_suspended`).
    pub metadata: Map<String, Value>,
}

struct ToolRunResult {
    text: String,
    parts: Option<Vec<ContentBlock>>,
    mcp_app: Option<Value>,
    duration_ms: Option<f64>,
}

/// Ends the run's `agent_run` span when the run's future is dropped (a
/// hard stop) or panics. A run that returns ends it in [`Agent::run`]
/// first, which makes this a no-op.
pub(crate) struct RunSpanGuard(Vec<HookRef>);

impl RunSpanGuard {
    pub(crate) fn new(hooks: Vec<HookRef>) -> Self {
        Self(hooks)
    }

    fn end(&self, outcome: RunEnd<'_>) {
        if let Some(o) = self.0.iter().find_map(|h| h.as_otel()) {
            o.end_run(outcome);
        }
    }
}

impl Drop for RunSpanGuard {
    fn drop(&mut self) {
        self.end(RunEnd::Cancelled);
    }
}

enum Dispatch {
    Ok,
    Cancelled,
    Suspended,
}

/// A dispatched call's progress, kept outside its future: when the user
/// stops the turn the future is dropped, and this is what is left of it.
#[derive(Default)]
struct ToolProgress {
    started: Mutex<Option<Instant>>,
    /// Tail of the streamed output, and how many bytes fell off its front.
    output: Mutex<(String, usize)>,
}

impl ToolProgress {
    fn start(&self) {
        *self.started.lock().unwrap() = Some(Instant::now());
    }

    fn record(&self, text: &str) {
        let mut out = self.output.lock().unwrap();
        out.0.push_str(text);
        // Trim in batches; `cancelled` cuts to the exact size.
        if out.0.len() > 2 * CANCELLED_OUTPUT_MAX_BYTES {
            let cut = tail_start(&out.0, CANCELLED_OUTPUT_MAX_BYTES);
            out.0.drain(..cut);
            out.1 += cut;
        }
    }

    /// `(duration_ms, tool message)` for a call dropped by a stop: the
    /// output it streamed, then how long it ran. A call that never started
    /// (still queued for a slot) is just "Cancelled by user."
    fn cancelled(&self) -> (Option<f64>, String) {
        let Some(started) = *self.started.lock().unwrap() else {
            return (None, "Cancelled by user.".into());
        };
        let elapsed = started.elapsed().as_secs_f64();
        let note = format!("Cancelled by user after {elapsed:.1} seconds.");
        let out = self.output.lock().unwrap();
        let cut = tail_start(&out.0, CANCELLED_OUTPUT_MAX_BYTES);
        let tail = out.0[cut..].trim_end();
        let omitted = out.1 + cut;
        let text = if tail.trim().is_empty() {
            note
        } else if omitted > 0 {
            format!("...output truncated ({omitted} bytes omitted)...\n{tail}\n\n{note}")
        } else {
            format!("{tail}\n\n{note}")
        };
        (Some(round3(elapsed * 1000.0)), text)
    }
}

/// Byte offset where the last `max` bytes of `s` start (on a char boundary).
fn tail_start(s: &str, max: usize) -> usize {
    let mut cut = s.len().saturating_sub(max);
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    cut
}

fn round3(x: f64) -> f64 {
    appv3_core::pymath::py_round(x, 3)
}

fn has_payload(a: &AssistantMessage) -> bool {
    a.content.as_deref().map(|c| !c.trim().is_empty()).unwrap_or(false)
        || a.reasoning_content.as_deref().map(|c| !c.trim().is_empty()).unwrap_or(false)
        || a.tool_calls.as_ref().map(|t| !t.is_empty()).unwrap_or(false)
}

fn opt_str(s: Option<&str>) -> String {
    s.map(String::from).unwrap_or_else(|| "None".into())
}

fn tool_msg(tc: &ToolCall, content: &str) -> ChatMessage {
    ChatMessage::Tool { content: Some(content.to_string()), tool_call_id: tc.id.clone(), name: Some(tc.function.name.clone()), parts: None, meta: MessageMeta::default() }
}

/// `_merge_question_calls`.
fn merge_question_calls(primary: &mut ToolCall, dups: &[ToolCall]) {
    let parse = |s: &str| serde_json::from_str::<Value>(if s.is_empty() { "{}" } else { s });
    let Ok(mut merged) = parse(&primary.function.arguments) else {
        return;
    };
    let mut qs: Vec<Value> = merged.get("questions").and_then(|q| q.as_array()).cloned().unwrap_or_default();
    for tc in dups {
        match parse(&tc.function.arguments) {
            Ok(v) => qs.extend(v.get("questions").and_then(|q| q.as_array()).cloned().unwrap_or_default()),
            Err(_) => return,
        }
    }
    qs.truncate(4);
    if let Some(o) = merged.as_object_mut() {
        o.insert("questions".into(), Value::Array(qs));
        primary.function.arguments = merged.to_string();
    }
}

impl Agent {
    async fn sync(cp: Option<&Checkpointer>, ctx: &RunContext, state: &mut AgentState) {
        if let Some(c) = cp {
            c.sync(ctx, state).await;
        }
    }

    async fn system_prompt_for_call(hooks: &[HookRef], ctx: &RunContext, state: &AgentState, base: String) -> String {
        let mut p = base;
        for h in hooks {
            p = h.wrap_system_prompt(ctx, state, p).await;
        }
        p
    }

    /// Innermost model-call prep: final prompt + `before_model_call` hooks.
    async fn prepare_call(hooks: &[HookRef], ctx: &RunContext, state: &mut AgentState, mut req: ModelRequest) -> ModelRequest {
        let prompt = Self::system_prompt_for_call(hooks, ctx, state, req.system_prompt.clone()).await;
        let mut changed = false;
        for h in hooks {
            changed |= h.before_model_call(ctx, state, &prompt).await;
        }
        if changed {
            req.messages = state.messages_for_llm();
        }
        req.system_prompt = prompt;
        req
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_tool(
        &self,
        ctx: &RunContext,
        meta: &SharedMeta,
        hooks: &[HookRef],
        tools: &ToolSet,
        base: &ToolContext,
        tc: &ToolCall,
        sem: &tokio::sync::Semaphore,
        progress: Option<&Arc<ToolProgress>>,
    ) -> Result<ToolRunResult, Suspension> {
        let _permit = sem.acquire().await.ok();
        let Some(o) = hooks.iter().find_map(|h| h.as_otel()) else {
            return self.run_tool_inner(ctx, meta, hooks, tools, base, tc, progress).await;
        };
        let span = o.start_tool_span(ctx, tc);
        let t0 = Instant::now();
        let r = appv3_core::otel::scope(Some(span.ctx()), self.run_tool_inner(ctx, meta, hooks, tools, base, tc, progress)).await;
        use crate::hooks::otel::ToolOutcome;
        match &r {
            Ok(res) => o.end_tool_span(&span, &tc.function.name, t0, ToolOutcome::Ok(&res.text)),
            Err(Suspension::Question { question_id, .. }) => {
                o.end_tool_span(&span, &tc.function.name, t0, ToolOutcome::QuestionSuspended(&format!("Turn suspended awaiting user answer ({question_id})")))
            }
            Err(Suspension::Lead { question, .. }) => {
                o.end_tool_span(&span, &tc.function.name, t0, ToolOutcome::LeadSuspended(&format!("Turn suspended awaiting lead answer: {question}")))
            }
        }
        r
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_tool_inner(
        &self,
        ctx: &RunContext,
        meta: &SharedMeta,
        hooks: &[HookRef],
        tools: &ToolSet,
        base: &ToolContext,
        tc: &ToolCall,
        progress: Option<&Arc<ToolProgress>>,
    ) -> Result<ToolRunResult, Suspension> {
        if let Some(p) = progress {
            p.start();
        }
        let mut scope = ToolCallScope { ui_id: tc.id.clone(), started: Instant::now(), output: None, duration_ms: None, mcp_app: None };
        for h in hooks {
            if let Err(text) = h.before_tool(ctx, meta, tc, &mut scope).await {
                return Ok(ToolRunResult { text: format!("Error: {text}"), parts: None, mcp_app: None, duration_ms: None });
            }
        }
        // Tee streamed output into the progress record, so a stop mid-call
        // still reports what the tool printed.
        if let Some(p) = progress.cloned() {
            let sink = scope.output.take();
            scope.output = Some(Arc::new(move |text: String| {
                p.record(&text);
                if let Some(sink) = &sink {
                    sink(text);
                }
            }));
        }
        let mode = meta.lock().unwrap().get("interaction_mode").and_then(|v| v.as_str()).map(String::from);
        let exec = |call: ToolCall| {
            let mut tctx = base.clone();
            tctx.tool_call_id = call.id.clone();
            tctx.output = scope.output.clone();
            let mode = mode.clone();
            async move {
                match mode {
                    Some(m) if !tool_allowed_in_mode(&m, &call.function.name) => Ok((format!("Error: Tool '{}' is unavailable in Plan mode.", call.function.name), (None, None))),
                    _ => {
                        let out = appv3_tools::execute(tools, &tctx, &call.function.name, &call.function.arguments).await?;
                        Ok::<_, Suspension>((out.text, (out.parts, out.mcp_app)))
                    }
                }
            }
        };
        let plugins = crate::plugins::tool_plugins();
        let (mut text, (parts, mcp_app)) = if plugins.is_empty() {
            exec(tc.clone()).await?
        } else {
            let pctx =
                crate::plugins::PluginCtx { tool: &tc.function.name, session_id: ctx.session_id.as_deref(), run_id: &ctx.run_id, agent_name: &ctx.agent_name, call_id: &tc.id };
            crate::plugins::wrap_tool_call(plugins, pctx, tc, exec).await?
        };
        scope.mcp_app = mcp_app.clone();
        for h in hooks.iter().rev() {
            h.after_tool(ctx, meta, tc, &mut scope, &mut text).await;
        }
        Ok(ToolRunResult { text, parts, mcp_app, duration_ms: scope.duration_ms })
    }

    /// `Agent.run` for one turn.
    pub async fn run(&self, history: Vec<ChatMessage>, opts: RunOptions<'_>) -> Result<RunOutcome, AgentError> {
        // A fresh contextvar-like slot: the OTel hook attaches the agent_run
        // span to it for the rest of the run.
        let guard = RunSpanGuard::new(opts.hooks.clone());
        let stop = opts.interrupt.clone();
        let result = appv3_core::otel::inherit(self.run_inner(history, opts)).await;
        // Every run ends its span here, including compaction-only and failed
        // runs. A soft Stop returns Ok with the partial answer, so the stop
        // event (not the result) marks it cancelled.
        match &result {
            Ok(_) if stop.as_ref().is_some_and(Event::is_set) => guard.end(RunEnd::Cancelled),
            Ok(_) => guard.end(RunEnd::Ok),
            Err(AgentError::Cancelled) => guard.end(RunEnd::Cancelled),
            Err(e) => {
                let (name, qualified) = crate::errors::python_exception_names(e);
                guard.end(RunEnd::Err(name, &qualified, &e.to_string()));
            }
        }
        result
    }

    async fn run_inner(&self, history: Vec<ChatMessage>, opts: RunOptions<'_>) -> Result<RunOutcome, AgentError> {
        let provider = opts.provider.clone().unwrap_or_else(|| self.provider.clone());
        let active_model = opts.model_id.clone().or_else(|| self.model_id.clone());
        let hooks = opts.hooks.clone();
        let mut run_tools = self.tools.clone();
        for t in &opts.injected_tools {
            run_tools.add(t.clone());
        }
        let messages: Vec<ChatMessage> = history.into_iter().filter(|m| !matches!(m, ChatMessage::System { .. })).collect();
        let ctx = RunContext { session_id: opts.session_id.clone(), run_id: uuid::Uuid::now_v7().to_string(), agent_name: self.name.clone(), workspace: opts.workspace.clone() };
        let mut state = AgentState::new(messages, self.system_prompt.clone());
        let base_ctx = ToolContext {
            session_id: ctx.session_id.clone(),
            agent_name: self.name.clone(),
            tool_call_id: String::new(),
            denied: opts.denied.clone(),
            workspace: opts.workspace.clone(),
            output: None,
            metadata: state.metadata.clone(),
            messages: None,
        };
        let tool_defs = run_tools.definitions_for(&base_ctx);
        state.tool_names = {
            let mut n = run_tools.names();
            n.sort();
            n
        };
        state.tool_defs = tool_defs.clone();
        {
            let mut m = state.metadata.lock().unwrap();
            if let Some(s) = &ctx.session_id {
                m.insert("session_id".into(), json!(s));
            }
            m.insert("agent_name".into(), json!(self.name));
            if let Some(em) = active_model.as_deref().filter(|s| !s.is_empty()) {
                m.insert("effective_model".into(), json!(em));
            }
            for (k, v) in &opts.metadata {
                m.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        if let Some(cp) = opts.checkpointer {
            cp.seed_state(&mut state);
        }
        let run_start = Instant::now();
        tracing::info!("agent_run_start agent={} message_count={} tools={} session={:?}", self.name, state.messages.len(), run_tools.names().len(), ctx.session_id);
        for h in &hooks {
            h.before_agent(&ctx, &mut state).await;
        }
        let sem = tokio::sync::Semaphore::new(MAX_CONCURRENT_TOOLS);
        let interrupted = || opts.interrupt.as_ref().map(|e| e.is_set()).unwrap_or(false);
        let label = active_model.clone().unwrap_or_else(|| "primary".into());

        let mut iteration = 0usize;
        let mut empty_retries = 0u32;
        let mut total_tokens = 0i64;
        let mut last_assistant: Option<AssistantMessage> = None;

        while iteration < self.max_iterations {
            if interrupted() {
                tracing::info!("agent_iteration_interrupted agent={} iteration={}", self.name, iteration);
                break;
            }
            iteration += 1;
            let iter_start = Instant::now();
            let mut req = ModelRequest { messages: state.messages_for_llm(), system_prompt: state.system_prompt.clone() };
            let mut hook_updated = false;
            for h in &hooks {
                if let Some(r) = h.before_model(&ctx, &mut state, &req).await {
                    req = r;
                    hook_updated = true;
                }
            }
            if hook_updated {
                Self::sync(opts.checkpointer, &ctx, &mut state).await;
            }
            let otel_hook = hooks.iter().find_map(|h| h.as_otel());
            if state.meta_get("stop_after_before_model") == Some(Value::Bool(true)) {
                match otel_hook {
                    Some(o) => {
                        let span = o.start_model_span(&ctx, &req);
                        let t0 = Instant::now();
                        let _ = appv3_core::otel::scope(Some(span.ctx()), Self::prepare_call(&hooks, &ctx, &mut state, req)).await;
                        let stub = AssistantMessage::default();
                        o.end_model_span(&span, t0, crate::hooks::otel::ModelOutcome::Ok(&stub, Default::default()));
                    }
                    None => {
                        let _ = Self::prepare_call(&hooks, &ctx, &mut state, req).await;
                    }
                }
                Self::sync(opts.checkpointer, &ctx, &mut state).await;
                tracing::info!("agent_iteration_done agent={} iteration={} action=before_model_only", self.name, iteration);
                break;
            }

            // ── model call with transient-failure resume ──
            let model_span = otel_hook.map(|o| (o, o.start_model_span(&ctx, &req), Instant::now()));
            let span_ctx = model_span.as_ref().map(|(_, s, _)| s.ctx()).or_else(appv3_core::otel::current);
            let call = appv3_core::otel::scope(span_ctx, async {
                let ModelRequest { messages, system_prompt } = Self::prepare_call(&hooks, &ctx, &mut state, req).await;
                stream_and_assemble(StreamArgs {
                    ctx: &ctx,
                    state: &state,
                    hooks: &hooks,
                    interrupt: opts.interrupt.as_ref(),
                    hard_cancel: opts.hard_cancel.as_ref(),
                    system_prompt: &system_prompt,
                    messages,
                    tool_defs: &tool_defs,
                    provider: provider.clone(),
                    label: &label,
                    agent_name: &self.name,
                    agent_id: &self.id,
                })
                .await
            })
            .await;
            if let Some((o, span, t0)) = &model_span {
                use crate::hooks::otel::ModelOutcome;
                match &call {
                    Ok((a, _, timing)) => o.end_model_span(span, *t0, ModelOutcome::Ok(a, *timing)),
                    Err(ModelError::Agent(AgentError::Cancelled)) => {
                        span.exit_with_exception("asyncio.exceptions.CancelledError", "");
                    }
                    Err(ModelError::Agent(e)) => {
                        let (name, qual) = crate::errors::python_exception_names(e);
                        o.end_model_span(span, *t0, ModelOutcome::Err(name, &qual, &e.to_string()));
                    }
                    Err(ModelError::Transient { error_type, message }) => o.end_model_span(span, *t0, ModelOutcome::Err(error_type, &format!("httpx2.{error_type}"), message)),
                }
            }
            let (mut assistant, usage): (AssistantMessage, Option<Usage>) = match call {
                Ok((a, u, _)) => (a, u),
                Err(ModelError::Agent(e)) => return Err(e),
                // The turn's stream retries transport failures until the
                // network is back or the user stops, so it does not end here.
                Err(ModelError::Transient { error_type, .. }) => {
                    return Err(AgentError::Connection {
                        message: format!(
                            "Could not reach the LLM provider after a transient connectivity failure ({error_type}). Check your network connection and the provider's base URL in Settings → Providers."
                        ),
                        error_type: Some(error_type),
                        provider: Some(label.clone()),
                    });
                }
            };

            // ── _finish_model_iteration ──
            let tc_list = assistant.tool_calls.clone().unwrap_or_default();
            let effective = state.meta_str("effective_model");
            tracing::info!(
                "llm_response agent={} iteration={} elapsed={:.2}s content_len={} tool_calls={} tokens={}/{}",
                self.name,
                iteration,
                iter_start.elapsed().as_secs_f64(),
                assistant.content.as_deref().map(|c| c.len()).unwrap_or(0),
                tc_list.len(),
                usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0),
                usage.as_ref().map(|u| u.completion_tokens).unwrap_or(0)
            );
            let extra = assistant.meta.extra.clone().unwrap_or_default();
            // A safety classifier cut the response off. Anthropic requires the
            // refused turn to leave the context (replaying it is refused
            // again), and any tool call in it is truncated: drop it, keep the
            // usage, and end the turn on an error the user can act on.
            if extra.get("finish_reason").and_then(|v| v.as_str()) == Some("refusal") {
                let details = extra.get("stop_details");
                let field = |k: &str| details.and_then(|d| d.get(k)).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
                tracing::warn!("agent_model_refusal agent={} iteration={} category={:?} dropped_tool_calls={}", self.name, iteration, field("category"), tc_list.len());
                if let Some(u) = &usage {
                    total_tokens += u.total_tokens;
                    state.usage.total_tokens = total_tokens;
                    state.meta_set("total_tokens", json!(total_tokens));
                }
                Self::sync(opts.checkpointer, &ctx, &mut state).await;
                let who = effective.clone().or_else(|| active_model.clone()).unwrap_or_else(|| "The model".into());
                let reason = match field("explanation") {
                    Some(e) => format!(": {}", e.trim_end_matches('.')),
                    None => String::new(),
                };
                return Err(AgentError::Refusal {
                    message: format!(
                        "{who} declined to continue{reason}. Sending the same request again usually gets declined too: rephrase the request or switch to another model."
                    ),
                    provider: active_model.clone(),
                });
            }
            let dropped = extra.get("dropped_tool_calls").map(crate::util::truthy).unwrap_or(false);
            if !has_payload(&assistant) && !dropped {
                let aborted = !extra.get("finish_reason").map(crate::util::truthy).unwrap_or(false);
                let prev_tool = matches!(state.messages.last(), Some(ChatMessage::Tool { .. }));
                if aborted || prev_tool {
                    empty_retries += 1;
                    if empty_retries <= 3 {
                        tracing::warn!("agent_empty_response_retry agent={} iteration={} attempt={}/3 aborted={}", self.name, iteration, empty_retries, aborted);
                        continue;
                    }
                    if aborted {
                        let who = effective.clone().or_else(|| active_model.clone());
                        return Err(AgentError::Request {
                            message: format!(
                                "{} returned an empty response {} times in a row, each time disconnecting before signalling end-of-turn.",
                                opt_str(who.as_deref()),
                                empty_retries
                            ),
                            status: None,
                            provider: active_model.clone(),
                        });
                    }
                }
            } else if has_payload(&assistant) {
                empty_retries = 0;
            }
            let mut extra = extra;
            extra.insert("duration_ms".into(), json!(round3(run_start.elapsed().as_secs_f64() * 1000.0)));
            let model_for_msg = effective.clone().or_else(|| active_model.clone());
            extra.insert("model".into(), model_for_msg.clone().map(Value::String).unwrap_or(Value::Null));
            // Additive v3 key (see REPORT.md §3); v2 readers ignore it.
            if let Some(t) = state.meta_str("thinking_level") {
                extra.insert("thinking_level".into(), json!(t));
            }
            if let Some(u) = &usage {
                let ud = usage_to_dict(u, model_for_msg.as_deref());
                extra.insert("usage".into(), ud.clone());
                total_tokens += u.total_tokens;
                state.usage.last_prompt_tokens = u.prompt_tokens;
                state.usage.last_completion_tokens = u.completion_tokens;
                state.usage.total_tokens = total_tokens;
                state.usage.last_usage = Some(ud.clone());
                state.meta_set("total_tokens", json!(total_tokens));
                state.meta_set("last_usage", ud);
            }
            assistant.meta.extra = Some(extra);
            for h in &hooks {
                h.after_model(&ctx, &mut state, &mut assistant).await;
            }
            state.messages.push(ChatMessage::Assistant(assistant.clone()));
            last_assistant = Some(assistant.clone());

            // ── _handle_finish_reason ──
            let finish = assistant.meta.extra.as_ref().and_then(|e| e.get("finish_reason")).and_then(|v| v.as_str()).map(String::from);
            if tc_list.is_empty() {
                if finish.as_deref() == Some("pause_turn") {
                    continue;
                }
                if matches!(finish.as_deref(), Some("max_tokens") | Some("length")) {
                    let dropped_tcs = assistant.meta.extra.as_ref().and_then(|e| e.get("dropped_tool_calls")).map(crate::util::truthy).unwrap_or(false);
                    let content = if dropped_tcs { TRUNCATED_TOOL_CALL_NOTICE } else { TRUNCATED_REPLY_NOTICE };
                    let mut meta = MessageMeta::default();
                    let mut e = Map::new();
                    e.insert("hidden_from_user".into(), json!(true));
                    meta.extra = Some(e);
                    state.messages.push(ChatMessage::User { content: Some(content.into()), parts: None, meta });
                    Self::sync(opts.checkpointer, &ctx, &mut state).await;
                    continue;
                }
                Self::sync(opts.checkpointer, &ctx, &mut state).await;
                break;
            }

            if interrupted() {
                for tc in &tc_list {
                    state.messages.push(tool_msg(tc, "Cancelled by user."));
                }
                Self::sync(opts.checkpointer, &ctx, &mut state).await;
                break;
            }

            // ── _dispatch_tools ──
            tracing::info!("tool_dispatch agent={} count={}", self.name, tc_list.len());
            // Calls that pause the turn run last, one at a time.
            let (pausing_calls, other_calls): (Vec<ToolCall>, Vec<ToolCall>) =
                tc_list.iter().cloned().partition(|tc| matches!(tc.function.name.as_str(), ASK_USER | ASK_LEAD | SUBMIT_PLAN));
            let meta = state.metadata.clone();
            let mut base_ctx = base_ctx.clone();
            if tc_list.iter().any(|tc| tc.function.name == "skill") {
                base_ctx.messages = Some(Arc::new(state.messages_for_llm()));
            }
            let base_ctx = &base_ctx;
            let mut results: Vec<Option<Result<ToolRunResult, Suspension>>> = (0..other_calls.len()).map(|_| None).collect();
            let progress: Vec<Arc<ToolProgress>> = other_calls.iter().map(|_| Arc::default()).collect();
            {
                let mut futs: FuturesUnordered<_> = other_calls
                    .iter()
                    .zip(&progress)
                    .enumerate()
                    .map(|(i, (tc, p))| {
                        let fut = self.run_tool(&ctx, &meta, &hooks, &run_tools, base_ctx, tc, &sem, Some(p));
                        async move { (i, fut.await) }
                    })
                    .collect();
                loop {
                    let next = match &opts.interrupt {
                        Some(ev) => tokio::select! {
                            biased;
                            _ = ev.wait() => None,
                            n = futs.next() => Some(n),
                        },
                        None => Some(futs.next().await),
                    };
                    match next {
                        None => break,
                        Some(None) => break,
                        Some(Some((i, r))) => results[i] = Some(r),
                    }
                }
            }
            // Leaving the block above dropped any call a stop interrupted.
            for ((tc, r), p) in other_calls.iter().zip(results).zip(&progress) {
                match r {
                    None => {
                        let (duration_ms, text) = p.cancelled();
                        for h in &hooks {
                            h.on_tool_cancelled(&ctx, tc, &text, duration_ms).await;
                        }
                        let mut m = tool_msg(tc, &text);
                        if let (Some(d), ChatMessage::Tool { meta, .. }) = (duration_ms, &mut m) {
                            meta.extra = Some(Map::from_iter([("duration_ms".to_string(), json!(d))]));
                        }
                        state.messages.push(m);
                    }
                    Some(Err(_)) => {
                        // A non-ask tool suspending is unexpected; record it like v2's gather error (dropped).
                        tracing::error!("tool_gather_error error=unexpected suspension tool={}", tc.function.name);
                    }
                    Some(Ok(r)) => {
                        let mut m = tool_msg(tc, &r.text);
                        if let ChatMessage::Tool { parts, meta, .. } = &mut m {
                            let mut e = Map::new();
                            if let Some(d) = r.duration_ms {
                                e.insert("duration_ms".into(), json!(d));
                            }
                            if let Some(app) = r.mcp_app {
                                e.insert("mcp_app".into(), app);
                            }
                            if !e.is_empty() {
                                meta.extra = Some(e);
                            }
                            *parts = r.parts;
                        }
                        state.messages.push(m);
                    }
                }
            }
            let dispatch = if interrupted() {
                Dispatch::Cancelled
            } else if pausing_calls.is_empty() {
                Dispatch::Ok
            } else {
                // ── _dispatch_question ──
                // A question wins over a plan submission: the answer may
                // change the plan, so the submission waits for it.
                let (submit_calls, ask_calls): (Vec<ToolCall>, Vec<ToolCall>) = pausing_calls.into_iter().partition(|tc| tc.function.name == SUBMIT_PLAN);
                let primary = if let Some(first) = ask_calls.first() {
                    let mut primary = first.clone();
                    let dups = &ask_calls[1..];
                    if !dups.is_empty() {
                        merge_question_calls(&mut primary, dups);
                        for tc in dups {
                            state.messages.push(tool_msg(tc, ASK_MERGED_INTO_PRIMARY));
                        }
                    }
                    for tc in &submit_calls {
                        state.messages.push(tool_msg(tc, SUBMIT_DEFERRED));
                    }
                    primary
                } else {
                    for tc in &submit_calls[1..] {
                        state.messages.push(tool_msg(tc, SUBMIT_MERGED));
                    }
                    submit_calls[0].clone()
                };
                Self::sync(opts.checkpointer, &ctx, &mut state).await;
                match self.run_tool(&ctx, &meta, &hooks, &run_tools, base_ctx, &primary, &sem, None).await {
                    Err(Suspension::Question { question_id, session_id }) => {
                        let s = json!({"question_id": question_id, "session_id": session_id, "tool_call_id": primary.id});
                        state.meta_set("question_suspended", s);
                        tracing::info!("question_suspended agent={} question_id={}", self.name, question_id);
                        Dispatch::Suspended
                    }
                    Err(Suspension::Lead { question, options, tool_call_id }) => {
                        let s = json!({"question": question, "options": options, "tool_call_id": tool_call_id.unwrap_or_else(|| primary.id.clone())});
                        state.meta_set("lead_suspended", s);
                        Dispatch::Suspended
                    }
                    Ok(r) => {
                        state.messages.push(tool_msg(&primary, &r.text));
                        Dispatch::Ok
                    }
                }
            };
            match dispatch {
                Dispatch::Cancelled => {
                    Self::sync(opts.checkpointer, &ctx, &mut state).await;
                    break;
                }
                Dispatch::Suspended => break,
                Dispatch::Ok => {}
            }
            Self::sync(opts.checkpointer, &ctx, &mut state).await;
            let end_turn = state.meta_pop("end_turn").map(|v| crate::util::truthy(&v)).unwrap_or(false);
            let sleep = matches!(assistant.content.as_deref().map(str::trim), Some("<sleep>") | Some("[sleep]"));
            if end_turn || sleep {
                break;
            }
        }

        // ── _finalize_run ──
        if let Some(last) = &last_assistant {
            for h in &hooks {
                h.after_agent(&ctx, &mut state, last).await;
            }
        }
        Self::sync(opts.checkpointer, &ctx, &mut state).await;
        tracing::info!(
            "agent_run_done agent={} elapsed={:.2}s iterations={} total_messages={} total_tokens={}",
            self.name,
            run_start.elapsed().as_secs_f64(),
            iteration,
            state.messages.len(),
            total_tokens
        );
        let metadata = state.metadata.lock().unwrap().clone();
        Ok(RunOutcome { messages: state.messages, metadata })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_question_calls_keep_non_ascii_text_verbatim() {
        let mut primary = ToolCall::new("a", "ask_user", r#"{"questions":[{"question":"Chọn màu?"}]}"#);
        let dup = ToolCall::new("b", "ask_user", r#"{"questions": [{"question": "Größe?"}]}"#);
        merge_question_calls(&mut primary, &[dup]);
        assert_eq!(primary.function.arguments, r#"{"questions":[{"question":"Chọn màu?"},{"question":"Größe?"}]}"#);
    }
}
