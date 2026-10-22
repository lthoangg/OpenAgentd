//! Agent lifecycle hooks — port of `app/agent/hooks/base.py` + `state.py`.
//!
//! v2's `wrap_model_call` chains are only used to rewrite the system prompt
//! (date, workspace instructions), so they map to [`Hook::wrap_system_prompt`]
//! applied in hook order (outermost first). `wrap_tool_call` maps to
//! [`Hook::before_tool`] (hook order) + [`Hook::after_tool`] (reverse order).

pub mod basic;
pub mod lsp;
pub mod otel;
pub mod publisher;
pub mod summarization;
pub mod title;

use crate::events::ProviderStatus;
use appv3_providers::{AssistantMessage, ChatCompletionChunk, ChatMessage, ToolCall};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub type SharedMeta = Arc<Mutex<Map<String, Value>>>;

#[derive(Debug, Clone)]
pub struct RunContext {
    pub session_id: Option<String>,
    pub run_id: String,
    pub agent_name: String,
    /// Workspace root the turn runs in; recorded on the `agent_run`,
    /// `chat`, `execute_tool` and summarization spans so
    /// `/api/observability/*` can filter and break down by workspace.
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageInfo {
    pub last_prompt_tokens: i64,
    pub last_completion_tokens: i64,
    pub total_tokens: i64,
    pub last_usage: Option<Value>,
}

pub struct AgentState {
    pub messages: Vec<ChatMessage>,
    pub usage: UsageInfo,
    pub metadata: SharedMeta,
    pub system_prompt: String,
    pub tool_names: Vec<String>,
    pub tool_defs: Vec<Value>,
}

impl AgentState {
    pub fn new(messages: Vec<ChatMessage>, system_prompt: String) -> Self {
        Self { messages, usage: UsageInfo::default(), metadata: Arc::new(Mutex::new(Map::new())), system_prompt, tool_names: vec![], tool_defs: vec![] }
    }
    /// Messages visible to the LLM (no system, no excluded), as the model
    /// reads them (see [`summarization::for_model`]).
    pub fn messages_for_llm(&self) -> Vec<ChatMessage> {
        self.messages.iter().filter(|m| !m.meta().exclude_from_context && !matches!(m, ChatMessage::System { .. })).map(summarization::for_model).collect()
    }
    pub fn meta_get(&self, key: &str) -> Option<Value> {
        self.metadata.lock().unwrap().get(key).cloned()
    }
    pub fn meta_str(&self, key: &str) -> Option<String> {
        self.meta_get(key).and_then(|v| v.as_str().map(String::from))
    }
    pub fn meta_set(&self, key: &str, value: Value) {
        self.metadata.lock().unwrap().insert(key.to_string(), value);
    }
    pub fn meta_pop(&self, key: &str) -> Option<Value> {
        self.metadata.lock().unwrap().shift_remove(key)
    }
}

/// Immutable per-LLM-call view.
#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub messages: Vec<ChatMessage>,
    pub system_prompt: String,
}

/// Per-tool-call scratch space shared across `before_tool`/`after_tool`.
pub struct ToolCallScope {
    /// Id announced to the UI (resolved against streamed deltas).
    pub ui_id: String,
    pub started: Instant,
    pub output: Option<appv3_tools::OutputSink>,
    pub duration_ms: Option<f64>,
    pub mcp_app: Option<Value>,
}

#[async_trait]
pub trait Hook: Send + Sync {
    /// The OTel hook drives the model/tool spans from `Agent::run`.
    fn as_otel(&self) -> Option<&otel::OtelHook> {
        None
    }
    async fn before_agent(&self, _ctx: &RunContext, _state: &mut AgentState) {}
    async fn after_agent(&self, _ctx: &RunContext, _state: &mut AgentState, _resp: &AssistantMessage) {}
    async fn before_model(&self, _ctx: &RunContext, _state: &mut AgentState, _req: &ModelRequest) -> Option<ModelRequest> {
        None
    }
    /// `wrap_model_call` system-prompt rewrite.
    async fn wrap_system_prompt(&self, _ctx: &RunContext, _state: &AgentState, prompt: String) -> String {
        prompt
    }
    /// Innermost `wrap_model_call` work that runs with the final system
    /// prompt (summarisation). Returns `true` when `state.messages` changed
    /// and the request window must be rebuilt.
    async fn before_model_call(&self, _ctx: &RunContext, _state: &mut AgentState, _system_prompt: &str) -> bool {
        false
    }
    async fn on_model_delta(&self, _ctx: &RunContext, _state: &AgentState, _chunk: &ChatCompletionChunk) {}
    async fn after_model(&self, _ctx: &RunContext, _state: &mut AgentState, _resp: &mut AssistantMessage) {}
    async fn on_rate_limit(&self, _ctx: &RunContext, _retry_after: i64, _attempt: i64, _max_attempts: i64) {}
    async fn on_provider_retry(&self, _ctx: &RunContext, _info: &ProviderStatus) {}
    async fn on_provider_exhausted(&self, _ctx: &RunContext, _info: &ProviderStatus) {}
    /// Pre-execution half of `wrap_tool_call`. `Err(text)` short-circuits
    /// the call with that result (e.g. permission denied).
    async fn before_tool(&self, _ctx: &RunContext, _meta: &SharedMeta, _tc: &ToolCall, _scope: &mut ToolCallScope) -> Result<(), String> {
        Ok(())
    }
    /// Post-execution half of `wrap_tool_call` (runs innermost-first).
    async fn after_tool(&self, _ctx: &RunContext, _meta: &SharedMeta, _tc: &ToolCall, _scope: &mut ToolCallScope, _result: &mut String) {}
    /// A call still running when the user stopped the turn was dropped;
    /// `result` is the tool message recorded in its place (the output it
    /// had streamed, then a "Cancelled by user" note). `after_tool` never
    /// runs for such a call.
    async fn on_tool_cancelled(&self, _ctx: &RunContext, _tc: &ToolCall, _result: &str, _duration_ms: Option<f64>) {}
}

pub type HookRef = Arc<dyn Hook>;
