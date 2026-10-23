//! Port of `app/agent/hooks/otel.py` — GenAI-convention spans and metrics
//! for every agent run. The `wrap_model_call` / `wrap_tool_call` halves are
//! driven from `Agent::run` via [`Hook::as_otel`] so the span can be made
//! current for the wrapped future.

use super::{AgentState, Hook, ModelRequest, RunContext};
use crate::streaming::StreamTiming;
use appv3_core::otel::{self, Span, SpanCtx, SpanKind};
use appv3_providers::{AssistantMessage, ChatMessage, ToolCall};
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Span attribute naming the turn's workspace root (v3 addition; GenAI
/// semantic conventions have no workspace notion).
pub const WORKSPACE_ATTR: &str = "openagentd.workspace";
/// `chat` span attribute (GenAI semconv): seconds from issuing the request
/// to the first chunk carrying output (see [`StreamTiming::ttft`]).
pub const TTFT_ATTR: &str = "gen_ai.response.time_to_first_chunk";
/// `chat` span attribute (v3 addition): output tokens per second while the
/// model streamed output (see [`StreamTiming::output_tokens_per_second`]).
pub const OUTPUT_TPS_ATTR: &str = "openagentd.response.output_tokens_per_second";
/// `agent_run` span attribute (v3 addition): the run was stopped before it
/// finished. A stop is not a failure, so such runs keep status OK.
pub const RUN_CANCELLED_ATTR: &str = "openagentd.run.cancelled";
/// `chat` span attribute (v3 addition): short hash of the final system prompt.
pub const SYSTEM_SHA_ATTR: &str = "openagentd.request.system_sha";
/// `chat` span attribute (v3 addition): short hash of the tool definitions.
pub const TOOLS_SHA_ATTR: &str = "openagentd.request.tools_sha";
/// `chat` span attribute (v3 addition): what changed in the part of the
/// previous call's request this call sends again (`tools`, `system`,
/// `messages@N` for the first changed message). Absent when the previous
/// request is an unchanged prefix, which is what a prompt cache needs.
pub const PREFIX_CHANGE_ATTR: &str = "openagentd.request.prefix_change";

fn short_sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// Hashes of one model request's cacheable parts: the system prompt, the
/// tool definitions, and every message, in request order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestFingerprint {
    pub system: String,
    pub tools: String,
    pub messages: Vec<String>,
}

impl RequestFingerprint {
    pub fn of(system_prompt: &str, tool_defs: &[Value], messages: &[ChatMessage]) -> Self {
        Self {
            system: short_sha(system_prompt.as_bytes()),
            tools: short_sha(serde_json::to_string(tool_defs).unwrap_or_default().as_bytes()),
            messages: messages.iter().map(|m| short_sha(format!("{m:?}").as_bytes())).collect(),
        }
    }

    /// What differs from `prev` in the part this request re-sends, or `None`
    /// when `prev` is an unchanged prefix of this request.
    pub fn change_since(&self, prev: &Self) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        if self.tools != prev.tools {
            parts.push("tools".into());
        }
        if self.system != prev.system {
            parts.push("system".into());
        }
        let common = prev.messages.iter().zip(&self.messages).take_while(|(a, b)| a == b).count();
        if common < prev.messages.len() {
            parts.push(format!("messages@{common}"));
        }
        (!parts.is_empty()).then(|| parts.join(","))
    }
}

/// The last request fingerprint per `(conversation, agent)`. Global because
/// hooks are rebuilt for every turn, and a cache miss usually happens across
/// turns.
fn last_requests() -> &'static Mutex<HashMap<String, RequestFingerprint>> {
    static M: OnceLock<Mutex<HashMap<String, RequestFingerprint>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

const MAX_TRACKED_REQUESTS: usize = 512;

/// `set_usage_span_attributes` (usage dict from `usage_to_dict`).
pub fn set_usage_span_attributes(span: &Span, usage: &Value) {
    let get = |k: &str| usage.get(k).cloned().unwrap_or(json!(0));
    let truthy = |v: &Value| match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    };
    for (key, attr) in [
        ("input", "gen_ai.usage.input_tokens"),
        ("output", "gen_ai.usage.output_tokens"),
        ("cache", "gen_ai.usage.cache_read.input_tokens"),
        ("cache_write", "gen_ai.usage.cache_creation.input_tokens"),
        ("thoughts", "gen_ai.usage.reasoning_tokens"),
        ("tool_use", "gen_ai.usage.tool_use_tokens"),
    ] {
        let v = get(key);
        if truthy(&v) {
            span.set_attr(attr, v);
        }
    }
    if let Some(Value::Number(n)) = usage.get("cost").and_then(|c| c.get("estimated_usd")) {
        if n.as_f64().map(|f| f > 0.0).unwrap_or(false) {
            span.set_attr("gen_ai.usage.estimated_cost_usd", Value::Number(n.clone()));
        }
    }
}

/// `_parse_model_id`.
pub fn parse_model_id(model_id: Option<&str>) -> (String, String) {
    match model_id {
        None | Some("") => ("unknown".into(), "unknown".into()),
        Some(m) => match m.split_once(':') {
            Some((p, rest)) => (if p.is_empty() { "unknown".into() } else { p.into() }, if rest.is_empty() { "unknown".into() } else { rest.into() }),
            None => ("unknown".into(), m.into()),
        },
    }
}

struct Instruments {
    op_duration: otel::Histogram,
    time_to_first_chunk: otel::Histogram,
    token_usage: otel::Histogram,
    tool_duration: otel::Histogram,
    runs: otel::Counter,
}

fn instruments() -> &'static Instruments {
    static I: OnceLock<Instruments> = OnceLock::new();
    I.get_or_init(|| Instruments {
        op_duration: otel::histogram("gen_ai.client.operation.duration", "GenAI operation duration", "s"),
        time_to_first_chunk: otel::histogram("gen_ai.client.operation.time_to_first_chunk", "Time to receive the first chunk of a streaming response", "s"),
        token_usage: otel::histogram("gen_ai.client.token.usage", "Number of input and output tokens used", "{token}"),
        tool_duration: otel::histogram("openagentd.tool.execution.duration", "Tool execution duration", "s"),
        runs: otel::counter("openagentd.agent.runs.total", "Total completed agent runs"),
    })
}

/// How a wrapped model call ended.
pub enum ModelOutcome<'a> {
    Ok(&'a AssistantMessage, StreamTiming),
    /// `(python class name, qualified name, message)`.
    Err(&'a str, &'a str, &'a str),
}

/// How a wrapped tool call ended.
pub enum ToolOutcome<'a> {
    Ok(&'a str),
    QuestionSuspended(&'a str),
    LeadSuspended(&'a str),
}

/// How an agent run ended, for its `agent_run` span.
pub enum RunEnd<'a> {
    Ok,
    /// Stopped by the user, or the run's future was dropped.
    Cancelled,
    /// `(python class name, qualified name, message)`.
    Err(&'a str, &'a str, &'a str),
}

pub struct OtelHook {
    agent_name: String,
    provider: String,
    model: String,
    /// The current run's span; kept after it ends so [`Self::end_run`] is
    /// idempotent.
    agent_span: Mutex<Option<Span>>,
    token: Mutex<Option<Option<SpanCtx>>>,
    run_start: Mutex<Option<Instant>>,
}

impl OtelHook {
    pub fn new(agent_name: &str, model_id: Option<&str>) -> Self {
        let (provider, model) = parse_model_id(model_id);
        instruments();
        Self { agent_name: agent_name.into(), provider, model, agent_span: Mutex::new(None), token: Mutex::new(None), run_start: Mutex::new(None) }
    }

    fn conv(ctx: &RunContext) -> String {
        ctx.session_id.clone().unwrap_or_else(|| "no-session".into())
    }

    /// The current run's `agent_run` span, or the last one once it ended.
    pub fn run_span(&self) -> Option<Span> {
        self.agent_span.lock().unwrap().clone()
    }

    /// End the run's `agent_run` span, once. [`Agent::run`](crate::agent::Agent::run)
    /// calls it for every run — a run without a span leaves its spend and
    /// failure unattributed. Later calls (and calls before the run started)
    /// do nothing.
    pub fn end_run(&self, outcome: RunEnd<'_>) {
        let Some(span) = self.agent_span.lock().unwrap().clone().filter(Span::is_recording) else { return };
        match outcome {
            RunEnd::Ok => {
                span.set_ok();
                span.end();
            }
            RunEnd::Cancelled => {
                span.set_attr(RUN_CANCELLED_ATTR, true);
                span.record_exception("asyncio.exceptions.CancelledError", "");
                span.set_ok();
                span.end();
            }
            RunEnd::Err(name, qualified, message) => {
                span.set_attr("error.type", name);
                span.exit_with_exception(qualified, message);
            }
        }
        if let Some(prev) = self.token.lock().unwrap().take() {
            otel::attach(prev);
        }
        instruments().runs.add(1, vec![("gen_ai.agent.name", json!(self.agent_name)), ("gen_ai.provider.name", json!(self.provider)), ("gen_ai.request.model", json!(self.model))]);
    }

    /// `(WORKSPACE_ATTR, workspace)` when the run has a workspace.
    fn workspace_attr(ctx: &RunContext) -> Option<(&'static str, Value)> {
        ctx.workspace.as_deref().filter(|w| !w.is_empty()).map(|w| (WORKSPACE_ATTR, json!(w)))
    }

    pub fn start_model_span(&self, ctx: &RunContext, req: &ModelRequest) -> Span {
        let mut attrs = vec![
            ("gen_ai.operation.name", json!("chat")),
            ("gen_ai.provider.name", json!(self.provider)),
            ("gen_ai.request.model", json!(self.model)),
            ("gen_ai.conversation.id", json!(Self::conv(ctx))),
            ("run_id", json!(ctx.run_id)),
            ("gen_ai.agent.name", json!(self.agent_name)),
            ("gen_ai.request.message_count", json!(req.messages.len())),
        ];
        // On the span itself too: a turn still running has no `agent_run`
        // span yet to attribute its spend through.
        attrs.extend(Self::workspace_attr(ctx));
        Span::start(format!("chat {}", self.model), SpanKind::Client, attrs)
    }

    /// Records the final request's fingerprint on `span`, and what changed
    /// in the part of this agent's previous request it sends again.
    pub fn record_request(&self, span: &Span, ctx: &RunContext, system_prompt: &str, tool_defs: &[Value], messages: &[ChatMessage]) {
        let fp = RequestFingerprint::of(system_prompt, tool_defs, messages);
        span.set_attr(SYSTEM_SHA_ATTR, json!(fp.system));
        span.set_attr(TOOLS_SHA_ATTR, json!(fp.tools));
        let key = format!("{}\u{0}{}", Self::conv(ctx), self.agent_name);
        let mut last = last_requests().lock().unwrap();
        if let Some(change) = last.get(&key).and_then(|prev| fp.change_since(prev)) {
            tracing::info!("request_prefix_changed agent={} session={:?} change={}", self.agent_name, ctx.session_id, change);
            span.set_attr(PREFIX_CHANGE_ATTR, json!(change));
        }
        if last.len() >= MAX_TRACKED_REQUESTS && !last.contains_key(&key) {
            last.clear();
        }
        last.insert(key, fp);
    }

    pub fn end_model_span(&self, span: &Span, started: Instant, outcome: ModelOutcome<'_>) {
        match outcome {
            ModelOutcome::Err(name, qualified, msg) => {
                span.set_attr("error.type", name);
                span.set_error();
                span.exit_with_exception(qualified, msg);
            }
            ModelOutcome::Ok(result, timing) => {
                let elapsed = started.elapsed().as_secs_f64();
                let usage = result.meta.extra.as_ref().and_then(|e| e.get("usage")).cloned().unwrap_or(json!({}));
                set_usage_span_attributes(span, &usage);
                if let Some(m) = result.meta.extra.as_ref().and_then(|e| e.get("model")).filter(|m| crate::util::truthy(m)) {
                    span.set_attr("gen_ai.response.model", m.clone());
                }
                if let Some(ttft) = timing.ttft {
                    span.set_attr(TTFT_ATTR, ttft.as_secs_f64());
                }
                let output_tokens = usage.get("output").and_then(Value::as_i64).unwrap_or(0);
                if let Some(tps) = timing.output_tokens_per_second(output_tokens) {
                    span.set_attr(OUTPUT_TPS_ATTR, appv3_core::pymath::py_round(tps, 1));
                }
                span.set_ok();
                span.end();
                let attrs = || vec![("gen_ai.operation.name", json!("chat")), ("gen_ai.provider.name", json!(self.provider)), ("gen_ai.request.model", json!(self.model))];
                instruments().op_duration.record_in(Some(span.ctx()), elapsed, attrs());
                if let Some(ttft) = timing.ttft {
                    instruments().time_to_first_chunk.record_in(Some(span.ctx()), ttft.as_secs_f64(), attrs());
                }
                let input = usage.get("input").cloned().unwrap_or(json!(0));
                let output = usage.get("output").cloned().unwrap_or(json!(0));
                if crate::util::truthy(&input) {
                    let mut a = attrs();
                    a.push(("gen_ai.token.type", json!("input")));
                    instruments().token_usage.record_in(Some(span.ctx()), input, a);
                }
                if crate::util::truthy(&output) {
                    let mut a = attrs();
                    a.push(("gen_ai.token.type", json!("output")));
                    instruments().token_usage.record_in(Some(span.ctx()), output, a);
                }
            }
        }
    }

    pub fn start_tool_span(&self, ctx: &RunContext, tc: &ToolCall) -> Span {
        let mut attrs = vec![
            ("gen_ai.operation.name", json!("execute_tool")),
            ("gen_ai.tool.name", json!(tc.function.name)),
            ("gen_ai.tool.call.id", json!(tc.id)),
            ("gen_ai.agent.name", json!(self.agent_name)),
            ("gen_ai.conversation.id", json!(Self::conv(ctx))),
            ("run_id", json!(ctx.run_id)),
        ];
        attrs.extend(Self::workspace_attr(ctx));
        Span::start(format!("execute_tool {}", tc.function.name), SpanKind::Internal, attrs)
    }

    pub fn end_tool_span(&self, span: &Span, tool_name: &str, started: Instant, outcome: ToolOutcome<'_>) {
        match outcome {
            ToolOutcome::QuestionSuspended(msg) => {
                span.set_attr("tool.suspended", true);
                span.set_ok();
                span.exit_with_exception("app.agent.errors.QuestionSuspended", msg);
            }
            ToolOutcome::LeadSuspended(msg) => {
                span.set_attr("error.type", "LeadSuspended");
                span.set_error();
                span.exit_with_exception("app.agent.errors.LeadSuspended", msg);
            }
            ToolOutcome::Ok(result) => {
                span.set_attr("tool.result.length", result.chars().count());
                span.set_ok();
                span.end();
                instruments().tool_duration.record_in(
                    Some(span.ctx()),
                    started.elapsed().as_secs_f64(),
                    vec![("gen_ai.tool.name", json!(tool_name)), ("gen_ai.agent.name", json!(self.agent_name))],
                );
            }
        }
    }
}

#[async_trait]
impl Hook for OtelHook {
    fn as_otel(&self) -> Option<&OtelHook> {
        Some(self)
    }

    async fn before_agent(&self, ctx: &RunContext, _state: &mut AgentState) {
        *self.run_start.lock().unwrap() = Some(Instant::now());
        let mut attrs = vec![
            ("gen_ai.agent.name", json!(self.agent_name)),
            ("gen_ai.provider.name", json!(self.provider)),
            ("gen_ai.request.model", json!(self.model)),
            ("gen_ai.conversation.id", json!(Self::conv(ctx))),
            ("run_id", json!(ctx.run_id)),
        ];
        attrs.extend(Self::workspace_attr(ctx));
        let span = Span::start(format!("agent_run {}", self.agent_name), SpanKind::Internal, attrs);
        *self.token.lock().unwrap() = otel::attach(Some(span.ctx()));
        *self.agent_span.lock().unwrap() = Some(span);
    }

    async fn after_agent(&self, ctx: &RunContext, state: &mut AgentState, _resp: &AssistantMessage) {
        if let Some(span) = self.run_span() {
            if state.usage.last_prompt_tokens != 0 {
                span.set_attr("gen_ai.usage.input_tokens", state.usage.last_prompt_tokens);
            }
            if state.usage.last_completion_tokens != 0 {
                span.set_attr("gen_ai.usage.output_tokens", state.usage.last_completion_tokens);
            }
        }
        let elapsed = self.run_start.lock().unwrap().map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0);
        tracing::debug!("otel_agent_run_complete agent={} session={:?} elapsed_s={:.3}", self.agent_name, ctx.session_id, elapsed);
    }

    async fn on_rate_limit(&self, _ctx: &RunContext, retry_after: i64, attempt: i64, max_attempts: i64) {
        if let Some(span) = self.agent_span.lock().unwrap().as_ref() {
            span.add_event("rate_limit", vec![("retry_after_s", json!(retry_after as f64)), ("attempt", json!(attempt)), ("max_attempts", json!(max_attempts))]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{Agent, RunOptions};
    use crate::hooks::HookRef;
    use appv3_core::otel::StatusCode;
    use appv3_providers::mock::{MockProvider, MockTurn};
    use appv3_providers::{ChatMessage, LlmProvider, ProviderError};
    use std::sync::Arc;
    use std::time::Duration;

    fn run_opts(hook: &Arc<OtelHook>, metadata: serde_json::Map<String, Value>) -> RunOptions<'static> {
        RunOptions {
            session_id: Some("s-1".into()),
            metadata,
            hooks: vec![hook.clone() as HookRef],
            injected_tools: vec![],
            interrupt: None,
            hard_cancel: None,
            checkpointer: None,
            provider: None,
            model_id: Some("mock:mock".into()),
            denied: Arc::new(appv3_tools::DeniedPaths::new(std::path::Path::new("/tmp"), None)),
            workspace: Some("/w/app".into()),
        }
    }

    fn agent(turns: Vec<MockTurn>) -> Agent {
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(turns));
        Agent::new(provider, "lead", "You are a test agent.", vec![], Some("mock:mock".into()))
    }

    #[tokio::test]
    async fn failed_run_ends_its_run_span_as_an_error() {
        let hook = Arc::new(OtelHook::new("lead", Some("mock:mock")));
        let res = agent(vec![MockTurn::Error(ProviderError::Auth("bad key".into()))]).run(vec![ChatMessage::user("hi")], run_opts(&hook, Default::default())).await;
        assert!(res.is_err());
        let span = hook.run_span().expect("run span started");
        assert!(!span.is_recording(), "a failed run must still write its agent_run span");
        assert_eq!(span.status(), StatusCode::Error);
        assert_eq!(span.attr("error.type"), Some(json!("ProviderAuthenticationError")));
        assert_eq!(span.attr(WORKSPACE_ATTR), Some(json!("/w/app")));
    }

    #[tokio::test]
    async fn compaction_only_run_ends_its_run_span() {
        let hook = Arc::new(OtelHook::new("lead", Some("mock:mock")));
        let meta = serde_json::Map::from_iter([("stop_after_before_model".to_string(), json!(true))]);
        let res = agent(vec![]).run(vec![ChatMessage::user("hi")], run_opts(&hook, meta)).await;
        assert!(res.is_ok());
        let span = hook.run_span().expect("run span started");
        assert!(!span.is_recording(), "a run without an answer must still write its agent_run span");
        assert_eq!(span.status(), StatusCode::Ok);
    }

    #[tokio::test]
    async fn answered_run_ends_ok_with_usage() {
        let hook = Arc::new(OtelHook::new("lead", Some("mock:mock")));
        let res = agent(vec![MockProvider::text("hello")]).run(vec![ChatMessage::user("hi")], run_opts(&hook, Default::default())).await;
        assert!(res.is_ok());
        let span = hook.run_span().unwrap();
        assert!(!span.is_recording());
        assert_eq!(span.status(), StatusCode::Ok);
        assert!(span.has_attr("gen_ai.usage.input_tokens"));
    }

    #[tokio::test]
    async fn dropped_run_ends_its_run_span_as_cancelled() {
        let hook = Arc::new(OtelHook::new("lead", Some("mock:mock")));
        let ctx = RunContext { session_id: Some("s-1".into()), run_id: "r".into(), agent_name: "lead".into(), workspace: None };
        let mut state = AgentState::new(vec![], String::new());
        appv3_core::otel::scope(None, async {
            hook.before_agent(&ctx, &mut state).await;
            drop(crate::agent::RunSpanGuard::new(vec![hook.clone() as HookRef]));
        })
        .await;
        let span = hook.run_span().unwrap();
        assert!(!span.is_recording());
        assert_eq!(span.status(), StatusCode::Ok, "a stop is not a failure");
        assert_eq!(span.attr(RUN_CANCELLED_ATTR), Some(json!(true)));
    }

    /// Presses Stop as the first chunk streams, like the user mid-answer.
    struct StopOnFirstChunk(crate::util::Event);

    #[async_trait::async_trait]
    impl crate::hooks::Hook for StopOnFirstChunk {
        async fn on_model_delta(&self, _ctx: &RunContext, _state: &AgentState, _chunk: &appv3_providers::ChatCompletionChunk) {
            self.0.set();
        }
    }

    #[tokio::test]
    async fn run_stopped_mid_answer_ends_its_run_span_as_cancelled() {
        let hook = Arc::new(OtelHook::new("lead", Some("mock:mock")));
        let stop = crate::util::Event::new();
        let mut opts = run_opts(&hook, Default::default());
        opts.interrupt = Some(stop.clone());
        opts.hooks.push(Arc::new(StopOnFirstChunk(stop)));
        let res = agent(vec![MockProvider::text("hello")]).run(vec![ChatMessage::user("hi")], opts).await;
        assert!(res.is_ok(), "a soft stop keeps the partial answer");
        let span = hook.run_span().unwrap();
        assert!(!span.is_recording());
        assert_eq!(span.status(), StatusCode::Ok, "a stop is not a failure");
        assert_eq!(span.attr(RUN_CANCELLED_ATTR), Some(json!(true)));
    }

    #[tokio::test]
    async fn run_stopped_before_its_first_call_ends_its_run_span_as_cancelled() {
        let hook = Arc::new(OtelHook::new("lead", Some("mock:mock")));
        let stop = crate::util::Event::new();
        stop.set();
        let mut opts = run_opts(&hook, Default::default());
        opts.interrupt = Some(stop);
        let res = agent(vec![]).run(vec![ChatMessage::user("hi")], opts).await;
        assert!(res.is_ok());
        let span = hook.run_span().unwrap();
        assert!(!span.is_recording());
        assert_eq!(span.attr(RUN_CANCELLED_ATTR), Some(json!(true)));
    }

    #[test]
    fn chat_and_tool_spans_carry_the_workspace() {
        let hook = OtelHook::new("lead", Some("mock:mock"));
        let mut ctx = RunContext { session_id: Some("s-1".into()), run_id: "r".into(), agent_name: "lead".into(), workspace: Some("/w/app".into()) };
        let req = ModelRequest { messages: vec![], system_prompt: String::new() };
        let tc = ToolCall::new("c1", "read", "{}");
        assert_eq!(hook.start_model_span(&ctx, &req).attr(WORKSPACE_ATTR), Some(json!("/w/app")));
        assert_eq!(hook.start_tool_span(&ctx, &tc).attr(WORKSPACE_ATTR), Some(json!("/w/app")));
        ctx.workspace = None;
        assert!(!hook.start_model_span(&ctx, &req).has_attr(WORKSPACE_ATTR));
        assert!(!hook.start_tool_span(&ctx, &tc).has_attr(WORKSPACE_ATTR));
    }

    fn answer(output_tokens: i64) -> AssistantMessage {
        let mut a = AssistantMessage::default();
        a.meta.extra = Some(serde_json::Map::from_iter([("usage".to_string(), json!({"input": 10, "output": output_tokens}))]));
        a
    }

    #[test]
    fn chat_span_records_time_to_first_chunk_and_output_speed() {
        let hook = OtelHook::new("lead", Some("mock:mock"));
        let timing = StreamTiming { ttft: Some(Duration::from_millis(800)), generation: Some(Duration::from_secs(2)) };
        let span = Span::start_with_parent("chat mock", SpanKind::Client, None, vec![]);
        hook.end_model_span(&span, Instant::now(), ModelOutcome::Ok(&answer(100), timing));
        assert!(span.has_attr(TTFT_ATTR));
        assert!(span.has_attr(OUTPUT_TPS_ATTR));

        // Nothing streamed (or no usage): neither is recorded.
        let span = Span::start_with_parent("chat mock", SpanKind::Client, None, vec![]);
        hook.end_model_span(&span, Instant::now(), ModelOutcome::Ok(&answer(0), StreamTiming::default()));
        assert!(!span.has_attr(TTFT_ATTR));
        assert!(!span.has_attr(OUTPUT_TPS_ATTR));
    }

    #[test]
    fn an_appended_turn_is_not_a_prefix_change() {
        let tools = vec![json!({"name": "read"})];
        let prev = RequestFingerprint::of("sys", &tools, &[ChatMessage::user("a")]);
        let next = RequestFingerprint::of("sys", &tools, &[ChatMessage::user("a"), ChatMessage::user("b")]);
        assert_eq!(next.change_since(&prev), None);
    }

    #[test]
    fn prefix_change_names_the_changed_parts() {
        let tools = vec![json!({"name": "read"})];
        let prev = RequestFingerprint::of("sys", &tools, &[ChatMessage::user("a"), ChatMessage::user("b")]);
        let edited = RequestFingerprint::of("sys v2", &tools, &[ChatMessage::user("a"), ChatMessage::user("b")]);
        assert_eq!(edited.change_since(&prev).as_deref(), Some("system"));
        let more_tools = RequestFingerprint::of("sys", &[json!({"name": "read"}), json!({"name": "grep"})], &[ChatMessage::user("a"), ChatMessage::user("b")]);
        assert_eq!(more_tools.change_since(&prev).as_deref(), Some("tools"));
        let rewritten = RequestFingerprint::of("sys", &tools, &[ChatMessage::user("a"), ChatMessage::user("B"), ChatMessage::user("c")]);
        assert_eq!(rewritten.change_since(&prev).as_deref(), Some("messages@1"));
    }

    #[test]
    fn chat_span_records_request_hashes_and_the_change_since_the_last_call() {
        let hook = OtelHook::new("lead", Some("mock:mock"));
        let ctx = RunContext { session_id: Some("fp-session".into()), run_id: "r".into(), agent_name: "lead".into(), workspace: None };
        let first = Span::start_with_parent("chat mock", SpanKind::Client, None, vec![]);
        hook.record_request(&first, &ctx, "sys", &[], &[ChatMessage::user("a")]);
        assert!(first.has_attr(SYSTEM_SHA_ATTR));
        assert!(first.has_attr(TOOLS_SHA_ATTR));
        assert!(!first.has_attr(PREFIX_CHANGE_ATTR), "nothing to compare the first call with");

        let second = Span::start_with_parent("chat mock", SpanKind::Client, None, vec![]);
        hook.record_request(&second, &ctx, "sys", &[], &[ChatMessage::user("a"), ChatMessage::user("b")]);
        assert!(!second.has_attr(PREFIX_CHANGE_ATTR));

        let third = Span::start_with_parent("chat mock", SpanKind::Client, None, vec![]);
        hook.record_request(&third, &ctx, "sys, edited", &[], &[ChatMessage::user("a"), ChatMessage::user("b")]);
        assert_eq!(third.attr(PREFIX_CHANGE_ATTR), Some(json!("system")));
    }
}
