//! `StreamPublisherHook` — publishes agent events to the stream store.

use super::{AgentState, Hook, ModelRequest, RunContext, SharedMeta, ToolCallScope};
use crate::events::{self, Envelope, ProviderStatus, UsageFrame};
use crate::stream_store::store;
use appv3_providers::{AssistantMessage, ChatCompletionChunk, ToolCall};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// FIFO tool_call_id resolution (`app/agent/tool_id_resolver.py`).
#[derive(Default)]
pub struct ToolIdResolver {
    queues: HashMap<String, Vec<String>>,
    resolved: HashMap<String, String>,
}

impl ToolIdResolver {
    pub fn register(&mut self, name: &str, id: &str) -> bool {
        let q = self.queues.entry(name.to_string()).or_default();
        if q.iter().any(|x| x == id) {
            return false;
        }
        q.push(id.to_string());
        true
    }
    pub fn resolve_start(&mut self, name: &str, internal: &str) -> String {
        let q = self.queues.entry(name.to_string()).or_default();
        let id = if let Some(i) = q.iter().position(|x| x == internal) {
            q.remove(i);
            internal.to_string()
        } else if !q.is_empty() {
            q.remove(0)
        } else {
            internal.to_string()
        };
        if q.is_empty() {
            self.queues.remove(name);
        }
        self.resolved.insert(internal.to_string(), id.clone());
        id
    }
    pub fn resolve_end(&mut self, internal: &str) -> String {
        self.resolved.remove(internal).unwrap_or_else(|| internal.to_string())
    }
}

#[derive(Default)]
struct Totals {
    prompt: i64,
    completion: i64,
    cached: Option<i64>,
    thoughts: Option<i64>,
    tool_use: Option<i64>,
    count: i64,
    models: BTreeSet<String>,
    current_model: Option<String>,
}

pub struct StreamPublisherHook {
    session_id: String,
    agent: String,
    publish_reasoning: bool,
    resolver: Mutex<ToolIdResolver>,
    turn_started: Mutex<Option<Instant>>,
    model_started: Mutex<Option<Instant>>,
    /// First reasoning delta of the current model call, and the first
    /// content or tool-call delta after it; their gap is how long it thought.
    reasoning_span: Mutex<(Option<Instant>, Option<Instant>)>,
    totals: Mutex<Totals>,
}

impl StreamPublisherHook {
    pub fn new(session_id: &str, agent: &str, publish_reasoning: bool) -> Self {
        Self {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            publish_reasoning,
            resolver: Mutex::new(ToolIdResolver::default()),
            turn_started: Mutex::new(None),
            model_started: Mutex::new(None),
            reasoning_span: Mutex::new((None, None)),
            totals: Mutex::new(Totals::default()),
        }
    }

    fn push(&self, e: Envelope) {
        store().push_event(&self.session_id, &e, false);
    }

    fn publish_usage(&self, usage: &Value, state: &AgentState) {
        let int = |k: &str| usage.get(k).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)));
        let prompt = int("input").unwrap_or(0);
        let completion = int("output").unwrap_or(0);
        let cached = int("cache");
        let thoughts = int("thoughts");
        let tool_use = int("tool_use");
        let cost = usage.get("cost").and_then(|c| c.as_object()).and_then(|c| c.get("estimated_usd")).cloned();
        let display_model = {
            let mut t = self.totals.lock().unwrap();
            t.prompt += prompt;
            t.completion += completion;
            if let Some(c) = cached {
                t.cached = Some(t.cached.unwrap_or(0) + c);
            }
            if let Some(c) = thoughts {
                t.thoughts = Some(t.thoughts.unwrap_or(0) + c);
            }
            if let Some(c) = tool_use {
                t.tool_use = Some(t.tool_use.unwrap_or(0) + c);
            }
            t.count += 1;
            t.current_model.clone().or_else(|| state.meta_str("effective_model"))
        };
        let mut metadata = json!({"agent": self.agent});
        if let Some(m) = display_model.filter(|m| !m.is_empty()) {
            metadata["model"] = json!(m);
        }
        self.push(events::usage(
            &UsageFrame {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: prompt + completion,
                cached_tokens: cached,
                thoughts_tokens: thoughts,
                tool_use_tokens: tool_use,
                estimated_cost_usd: cost,
            },
            metadata,
        ));
    }
}

#[async_trait]
impl Hook for StreamPublisherHook {
    async fn before_agent(&self, _ctx: &RunContext, _state: &mut AgentState) {
        *self.turn_started.lock().unwrap() = Some(Instant::now());
    }

    async fn before_model(&self, _ctx: &RunContext, _state: &mut AgentState, _req: &ModelRequest) -> Option<ModelRequest> {
        *self.model_started.lock().unwrap() = Some(Instant::now());
        *self.reasoning_span.lock().unwrap() = (None, None);
        None
    }

    async fn after_model(&self, _ctx: &RunContext, state: &mut AgentState, resp: &mut AssistantMessage) {
        let started = self.turn_started.lock().unwrap().or(*self.model_started.lock().unwrap());
        if let Some(s) = started {
            let ms = appv3_core::pymath::py_round(s.elapsed().as_secs_f64() * 1000.0, 3);
            resp.meta.extra.get_or_insert_with(Default::default).insert("duration_ms".into(), json!(ms));
        }
        // Additive v3 key (see REPORT.md §3); v2 readers ignore it.
        if let (Some(from), until) = *self.reasoning_span.lock().unwrap() {
            let elapsed = until.unwrap_or_else(Instant::now).duration_since(from);
            let ms = appv3_core::pymath::py_round(elapsed.as_secs_f64() * 1000.0, 3);
            resp.meta.extra.get_or_insert_with(Default::default).insert("thinking_duration_ms".into(), json!(ms));
        }
        let usage = resp.meta.extra.as_ref().and_then(|e| e.get("usage")).filter(|u| u.is_object()).cloned();
        if let Some(u) = usage {
            self.publish_usage(&u, state);
        }
    }

    async fn on_model_delta(&self, _ctx: &RunContext, state: &AgentState, chunk: &ChatCompletionChunk) {
        let display_model = {
            let mut t = self.totals.lock().unwrap();
            let dm = if !chunk.model.is_empty() { Some(chunk.model.clone()) } else { t.current_model.clone().or_else(|| state.meta_str("effective_model")) };
            if !chunk.model.is_empty() {
                t.current_model = Some(chunk.model.clone());
                t.models.insert(chunk.model.clone());
            }
            dm
        };
        let Some(choice) = chunk.choices.first() else {
            return;
        };
        let mut metadata = json!({});
        if let Some(m) = display_model.filter(|m| !m.is_empty()) {
            metadata["model"] = json!(m);
        }
        if let Some(t) = state.meta_str("thinking_level") {
            metadata["thinking_level"] = json!(t);
        }
        let d = &choice.delta;
        {
            let mut span = self.reasoning_span.lock().unwrap();
            if d.reasoning_content.as_deref().is_some_and(|r| !r.is_empty()) {
                span.0.get_or_insert_with(Instant::now);
            } else if span.0.is_some() && span.1.is_none() && (d.content.as_deref().is_some_and(|c| !c.is_empty()) || d.tool_calls.is_some()) {
                span.1 = Some(Instant::now());
            }
        }
        if self.publish_reasoning {
            if let Some(r) = d.reasoning_content.as_deref().filter(|s| !s.is_empty()) {
                self.push(events::thinking(&self.agent, r, Some(metadata.clone())));
            }
        }
        if let Some(c) = d.content.as_deref().filter(|s| !s.is_empty()) {
            self.push(events::message(&self.agent, c, Some(metadata.clone())));
        }
        for tc in d.tool_calls.iter().flatten() {
            let name = tc.function.as_ref().and_then(|f| f.name.clone()).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let id = match tc.id.as_deref().filter(|s| !s.is_empty()) {
                Some(i) => i.to_string(),
                None => format!("{}:{}:{}", self.agent, name, tc.index.map(|i| i.to_string()).unwrap_or_else(|| "None".into())),
            };
            if !self.resolver.lock().unwrap().register(&name, &id) {
                continue;
            }
            self.push(events::tool_call(&self.agent, Some(&id), &name, Some(metadata.clone())));
        }
    }

    async fn before_tool(&self, _ctx: &RunContext, _meta: &SharedMeta, tc: &ToolCall, scope: &mut ToolCallScope) -> Result<(), String> {
        let name = tc.function.name.clone();
        let ui_id = self.resolver.lock().unwrap().resolve_start(&name, &tc.id);
        scope.ui_id = ui_id.clone();
        // Permission patterns (AutoAllowPermissionService still announces).
        let args: Value = serde_json::from_str(if tc.function.arguments.is_empty() { "{}" } else { &tc.function.arguments }).unwrap_or(json!({}));
        let pattern = if let Some(cmd) = args.get("command") {
            let s = match cmd {
                Value::String(s) => s.trim().to_string(),
                other => crate::pystr::py_str(other).trim().to_string(),
            };
            if s.is_empty() {
                name.clone()
            } else {
                crate::util::head_chars(&s, 200).to_string()
            }
        } else if args.get("path").is_some() || args.get("file_path").is_some() {
            let p = args.get("path").filter(|v| crate::util::truthy(v)).or_else(|| args.get("file_path").filter(|v| crate::util::truthy(v)));
            match p {
                Some(Value::String(s)) => s.clone(),
                Some(other) => crate::pystr::py_str(other),
                None => name.clone(),
            }
        } else {
            name.clone()
        };
        scope.started = Instant::now();
        self.push(events::tool_start(&self.agent, Some(&ui_id), &name, Some(&tc.function.arguments)));
        self.push(events::permission_asked(&uuid::Uuid::new_v4().to_string(), &self.session_id, &name, &[pattern], json!({"tool_call_id": ui_id, "agent": self.agent})));
        let seq = Arc::new(AtomicI64::new(0));
        let sid = self.session_id.clone();
        let agent = self.agent.clone();
        let tname = name.clone();
        let tid = ui_id.clone();
        scope.output = Some(Arc::new(move |text: String| {
            if text.is_empty() {
                return;
            }
            let n = seq.fetch_add(1, Ordering::SeqCst) + 1;
            store().push_event(&sid, &events::tool_output_delta(&agent, Some(&tid), &tname, &text, n), false);
        }));
        Ok(())
    }

    async fn after_tool(&self, _ctx: &RunContext, _meta: &SharedMeta, tc: &ToolCall, scope: &mut ToolCallScope, result: &mut String) {
        let ms = appv3_core::pymath::py_round(scope.started.elapsed().as_secs_f64() * 1000.0, 3);
        scope.duration_ms = Some(ms);
        let mut metadata = json!({"duration_ms": ms});
        if let Some(app) = &scope.mcp_app {
            metadata["mcp_app"] = app.clone();
        }
        let end_id = self.resolver.lock().unwrap().resolve_end(&tc.id);
        let r = if result.is_empty() { None } else { Some(result.as_str()) };
        self.push(events::tool_end(&self.agent, Some(&end_id), &tc.function.name, r, Some(metadata)));
    }

    async fn on_tool_cancelled(&self, _ctx: &RunContext, tc: &ToolCall, result: &str, duration_ms: Option<f64>) {
        let end_id = self.resolver.lock().unwrap().resolve_end(&tc.id);
        let metadata = duration_ms.map(|ms| json!({"duration_ms": ms}));
        self.push(events::tool_end(&self.agent, Some(&end_id), &tc.function.name, Some(result), metadata));
    }

    async fn on_rate_limit(&self, _ctx: &RunContext, retry_after: i64, attempt: i64, max_attempts: i64) {
        self.push(events::rate_limit(retry_after, attempt, max_attempts));
    }

    async fn on_provider_retry(&self, _ctx: &RunContext, info: &ProviderStatus) {
        self.push(events::provider_status(&self.agent, info));
    }

    async fn on_provider_exhausted(&self, _ctx: &RunContext, info: &ProviderStatus) {
        self.push(events::provider_status(&self.agent, info));
    }

    async fn after_agent(&self, _ctx: &RunContext, _state: &mut AgentState, _resp: &AssistantMessage) {
        let t = std::mem::take(&mut *self.totals.lock().unwrap());
        if t.count > 1 && (t.prompt != 0 || t.completion != 0) {
            let models: Value = if t.models.is_empty() { Value::Null } else { json!(t.models.iter().collect::<Vec<_>>()) };
            self.push(events::usage(
                &UsageFrame {
                    prompt_tokens: t.prompt,
                    completion_tokens: t.completion,
                    total_tokens: t.prompt + t.completion,
                    cached_tokens: t.cached,
                    thoughts_tokens: t.thoughts,
                    tool_use_tokens: t.tool_use,
                    estimated_cost_usd: None,
                },
                json!({"turn_total": true, "agent": self.agent, "models": models}),
            ));
        }
    }
}
