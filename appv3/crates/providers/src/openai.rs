//! OpenAI Chat Completions + Responses — port of `providers/openai/*`,
//! plus the thin compatible variants (deepseek, zai, xai, ollama, router9,
//! chat-completions-only gateways).

use crate::sse;
use crate::types::*;
use crate::usage::usage_to_dict;
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const API_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Wire-level dialect of a Chat Completions endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionsDialect {
    /// Native OpenAI / generic compatible (max_completion_tokens).
    OpenAi,
    /// Generic compatible gateway that still wants `max_tokens`.
    Legacy,
    /// DeepSeek (max_tokens, thinking + reasoning_effort, echo reasoning_content).
    DeepSeek,
    /// Z.ai (max_tokens, `thinking: {type: disabled}`).
    Zai,
}

/// Provider-specific handler behaviour (the v2 handler subclasses).
#[derive(Debug, Clone, Default)]
pub enum Flavor {
    #[default]
    Plain,
    /// `_CopilotCompletionsHandler` / `_CopilotResponsesHandler`.
    Copilot(CopilotModel),
    /// `_CodexResponsesHandler`.
    Codex(Arc<CodexTurn>),
    /// Grok Build: per-request conversation and request-id headers.
    Grok,
}

/// Copilot per-model capability resolved from the live `/models` catalog.
#[derive(Debug, Clone, Default)]
pub struct CopilotModel {
    pub supports_reasoning_effort: bool,
}

/// Codex per-handler state: the sticky-routing token of the turn in flight.
#[derive(Debug, Default)]
pub struct CodexTurn {
    pub turn_state: Mutex<Option<String>>,
    pub supports_reasoning_summary: bool,
}

const CODEX_TURN_STATE_HEADER: &str = "x-codex-turn-state";
const CODEX_NO_SERVICE_TIER: [&str; 6] = ["", "auto", "default", "none", "off", "standard"];

/// Python `str(value or "")`.
fn py_str_or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(true)) => "True".into(),
        Some(Value::Bool(false)) => String::new(),
        Some(Value::Number(n)) => {
            if n.as_f64() == Some(0.0) {
                String::new()
            } else {
                n.to_string()
            }
        }
        Some(Value::Array(a)) if a.is_empty() => String::new(),
        Some(Value::Object(o)) if o.is_empty() => String::new(),
        Some(other) => other.to_string(),
    }
}

fn content_has_image(content: Option<&Value>) -> bool {
    content.and_then(|c| c.as_array()).map(|a| a.iter().any(|p| matches!(p.get("type").and_then(|t| t.as_str()), Some("image_url" | "input_image" | "image")))).unwrap_or(false)
}

/// v2 copilot `_is_agent_initiated` → `(is_agent, is_vision)`.
pub fn copilot_initiator(items: &[Value], responses_api: bool) -> (bool, bool) {
    let Some(last) = items.last() else { return (false, false) };
    let is_vision = items.iter().filter(|i| i.is_object()).any(|i| {
        if responses_api {
            content_has_image(i.get("content")) || content_has_image(i.get("output"))
        } else {
            content_has_image(i.get("content"))
        }
    });
    let is_agent = last.get("role").and_then(|r| r.as_str()) != Some("user");
    (is_agent, is_vision)
}

fn copilot_headers(base: &[(String, String)], items: &[Value], responses_api: bool) -> Vec<(String, String)> {
    let (is_agent, is_vision) = copilot_initiator(items, responses_api);
    let mut h = base.to_vec();
    set_header(&mut h, "x-initiator", if is_agent { "agent" } else { "user" });
    if is_vision {
        set_header(&mut h, "Copilot-Vision-Request", "true");
    }
    h
}

/// dict-style header assignment (replace in place, else append).
pub fn set_header(h: &mut Vec<(String, String)>, k: &str, v: &str) {
    match h.iter_mut().find(|(n, _)| n == k) {
        Some(e) => e.1 = v.to_string(),
        None => h.push((k.to_string(), v.to_string())),
    }
}

// ── sanitization ────────────────────────────────────────────────────────────

/// v2 `sanitize_openai_tool_pairs`.
/// Strip assistant tool calls without a full set of results and drop orphan
/// tool rows. Borrows when nothing needs fixing (the normal case), so a
/// healthy transcript is not copied on every model call.
pub fn sanitize_tool_pairs(messages: &[ChatMessage]) -> std::borrow::Cow<'_, [ChatMessage]> {
    #[derive(Clone, Copy, PartialEq)]
    enum Fix {
        Keep,
        StripCalls,
        Drop,
    }
    let mut fixes = Vec::with_capacity(messages.len());
    let mut expected: HashSet<String> = HashSet::new();
    for (idx, msg) in messages.iter().enumerate() {
        let fix = match msg {
            ChatMessage::Assistant(a) => {
                expected.clear();
                let Some(tcs) = a.tool_calls.as_ref().filter(|t| !t.is_empty()) else {
                    fixes.push(Fix::Keep);
                    continue;
                };
                let ids: HashSet<String> = tcs.iter().filter(|t| !t.id.is_empty()).map(|t| t.id.clone()).collect();
                let mut following = HashSet::new();
                for next in &messages[idx + 1..] {
                    match next {
                        ChatMessage::Tool { tool_call_id, .. } => {
                            if !tool_call_id.is_empty() {
                                following.insert(tool_call_id.clone());
                            }
                        }
                        _ => break,
                    }
                }
                if !ids.is_empty() && ids.is_subset(&following) {
                    expected = ids;
                    Fix::Keep
                } else {
                    let mut sorted: Vec<_> = ids.into_iter().collect();
                    sorted.sort();
                    tracing::warn!("openai_strip_incomplete_assistant_tool_calls idx={} ids=[{}]", idx, sorted.join(", "));
                    Fix::StripCalls
                }
            }
            ChatMessage::Tool { tool_call_id, .. } => {
                if !tool_call_id.is_empty() && expected.remove(tool_call_id) {
                    Fix::Keep
                } else {
                    tracing::warn!("openai_drop_orphan_tool_message idx={} tool_call_id={}", idx, tool_call_id);
                    Fix::Drop
                }
            }
            _ => {
                expected.clear();
                Fix::Keep
            }
        };
        fixes.push(fix);
    }
    if fixes.iter().all(|f| *f == Fix::Keep) {
        return std::borrow::Cow::Borrowed(messages);
    }
    let fixed = messages
        .iter()
        .zip(fixes)
        .filter_map(|(m, fix)| match (fix, m) {
            (Fix::Keep, _) => Some(m.clone()),
            (Fix::StripCalls, ChatMessage::Assistant(a)) => Some(ChatMessage::Assistant(AssistantMessage { tool_calls: None, ..a.clone() })),
            _ => None,
        })
        .collect();
    std::borrow::Cow::Owned(fixed)
}

fn oai_parts(parts: &[ContentBlock]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| match p {
            ContentBlock::Text { text } => json!({"type": "text", "text": text}),
            ContentBlock::ImageUrl { url, detail, .. } => {
                let mut img = Map::new();
                img.insert("url".into(), json!(url));
                if let Some(d) = detail {
                    img.insert("detail".into(), json!(d));
                }
                json!({"type": "image_url", "image_url": img})
            }
            ContentBlock::ImageData { data, media_type } => {
                json!({"type": "image_url", "image_url": {"url": format!("data:{media_type};base64,{data}"), "detail": "auto"}})
            }
        })
        .collect()
}

fn oai_tool_calls(tcs: &[ToolCall]) -> Vec<Value> {
    tcs.iter().map(|tc| json!({"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}})).collect()
}

/// Canonical `{"type":"function","function":{...}}` → OpenAI tools.
pub fn convert_tools(tools: Option<&[ToolSpec]>) -> Option<Vec<Value>> {
    let tools = tools?;
    let out: Vec<Value> = tools
        .iter()
        .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("function"))
        .map(|t| {
            let f = &t["function"];
            let mut func = Map::new();
            func.insert("name".into(), f["name"].clone());
            func.insert("description".into(), f.get("description").cloned().unwrap_or(json!("")));
            if let Some(p) = f.get("parameters").filter(|p| !p.is_null()) {
                func.insert("parameters".into(), p.clone());
            }
            json!({"type": "function", "function": func})
        })
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// v2 `CompletionsHandler.convert_messages` (+ DeepSeek variant).
pub fn convert_messages(messages: &[ChatMessage], dialect: CompletionsDialect) -> Vec<Value> {
    let deepseek = dialect == CompletionsDialect::DeepSeek;
    let mut out = Vec::with_capacity(messages.len());
    for msg in messages {
        match msg {
            ChatMessage::System { content, .. } => {
                if deepseek {
                    let mut m = Map::new();
                    m.insert("role".into(), json!("system"));
                    if let Some(c) = content {
                        m.insert("content".into(), json!(c));
                    }
                    out.push(Value::Object(m));
                } else {
                    out.push(json!({"role": "system", "content": content.clone().unwrap_or_default()}));
                }
            }
            ChatMessage::User { content, parts, .. } => {
                if let Some(parts) = parts.as_ref().filter(|p| !p.is_empty()) {
                    out.push(json!({"role": "user", "content": oai_parts(parts)}));
                } else if deepseek {
                    let mut m = Map::new();
                    m.insert("role".into(), json!("user"));
                    if let Some(c) = content {
                        m.insert("content".into(), json!(c));
                    }
                    out.push(Value::Object(m));
                } else {
                    out.push(json!({"role": "user", "content": content.clone().unwrap_or_default()}));
                }
            }
            ChatMessage::Assistant(a) => {
                let tcs = a.tool_calls.as_ref().filter(|t| !t.is_empty());
                let mut m = Map::new();
                m.insert("role".into(), json!("assistant"));
                if deepseek {
                    m.insert("content".into(), json!(a.content.clone().unwrap_or_default()));
                    if let Some(tcs) = tcs {
                        m.insert("tool_calls".into(), json!(oai_tool_calls(tcs)));
                        if let Some(r) = a.reasoning_content.as_ref().filter(|r| !r.is_empty()) {
                            m.insert("reasoning_content".into(), json!(r));
                        }
                    }
                } else {
                    let content_empty = a.content.as_deref().map(str::is_empty).unwrap_or(true);
                    let content: Option<String> = if content_empty && tcs.is_none() {
                        Some(a.reasoning_content.clone().filter(|r| !r.is_empty()).unwrap_or_else(|| "...".into()))
                    } else if a.content.is_none() && tcs.is_some() {
                        Some(String::new())
                    } else {
                        a.content.clone()
                    };
                    if let Some(c) = content {
                        m.insert("content".into(), json!(c));
                    }
                    if let Some(tcs) = tcs {
                        m.insert("tool_calls".into(), json!(oai_tool_calls(tcs)));
                    }
                }
                out.push(Value::Object(m));
            }
            ChatMessage::Tool { content, tool_call_id, name, parts, .. } => {
                let mut m = Map::new();
                m.insert("role".into(), json!("tool"));
                if let Some(parts) = parts.as_ref().filter(|p| !p.is_empty()) {
                    m.insert("content".into(), json!(oai_parts(parts)));
                } else if deepseek {
                    if let Some(c) = content {
                        m.insert("content".into(), json!(c));
                    }
                } else {
                    m.insert("content".into(), json!(content.clone().unwrap_or_default()));
                }
                m.insert("tool_call_id".into(), json!(tool_call_id));
                if let Some(n) = name {
                    m.insert("name".into(), json!(n));
                }
                out.push(Value::Object(m));
            }
        }
    }
    out
}

pub fn usage_from_openai(u: &Value) -> Usage {
    usage_from_openai_ext(u, false)
}

/// `top_level_reasoning`: Copilot also reports `reasoning_tokens` at the top
/// level of `usage` (checked first).
pub fn usage_from_openai_ext(u: &Value, top_level_reasoning: bool) -> Usage {
    let i = |k: &str| u.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let cached = u.get("prompt_tokens_details").and_then(|d| d.get("cached_tokens")).and_then(|v| v.as_i64()).filter(|n| *n != 0);
    let top = if top_level_reasoning { u.get("reasoning_tokens").and_then(|v| v.as_i64()).filter(|n| *n != 0) } else { None };
    let thoughts = top.or_else(|| u.get("completion_tokens_details").and_then(|d| d.get("reasoning_tokens")).and_then(|v| v.as_i64()).filter(|n| *n != 0));
    Usage {
        prompt_tokens: i("prompt_tokens"),
        completion_tokens: i("completion_tokens"),
        total_tokens: i("total_tokens"),
        cached_tokens: cached,
        thoughts_tokens: thoughts,
        ..Default::default()
    }
}

#[derive(Debug, Clone)]
pub struct CompletionsHandler {
    pub model: String,
    pub base_url: String,
    pub headers: Vec<(String, String)>,
    pub dialect: CompletionsDialect,
    pub flavor: Flavor,
}

impl CompletionsHandler {
    pub fn new(model: &str, base_url: &str, headers: Vec<(String, String)>, dialect: CompletionsDialect) -> Self {
        Self { model: model.into(), base_url: base_url.into(), headers, dialect, flavor: Flavor::Plain }
    }

    fn copilot(&self) -> bool {
        matches!(self.flavor, Flavor::Copilot(_))
    }

    fn uses_max_completion_tokens(&self) -> bool {
        self.dialect == CompletionsDialect::OpenAi
    }

    pub fn build_request(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, stream: bool, merged: &Kwargs) -> Value {
        let mut body = Map::new();
        body.insert("model".into(), json!(self.model));
        body.insert("messages".into(), Value::Array(convert_messages(&sanitize_tool_pairs(messages), self.dialect)));
        if let Some(t) = convert_tools(tools) {
            body.insert("tools".into(), json!(t));
        }
        if let Some(mt) = merged.get("max_tokens").filter(|v| !v.is_null()) {
            let field = if self.uses_max_completion_tokens() { "max_completion_tokens" } else { "max_tokens" };
            body.insert(field.into(), mt.clone());
        }
        body.insert("stream".into(), json!(stream));
        if stream {
            body.insert("stream_options".into(), json!({"include_usage": true}));
        }
        if self.dialect != CompletionsDialect::DeepSeek {
            if let Some(tier) = kw_str(merged, "service_tier").filter(|s| !s.is_empty()) {
                if self.base_url.contains("api.openai.com") {
                    body.insert("service_tier".into(), json!(if tier == "fast" { "priority" } else { tier }));
                }
            }
        }
        if self.dialect != CompletionsDialect::DeepSeek {
            if let Some(k) = merged.get("prompt_cache_key").filter(|v| !v.is_null()) {
                body.insert("prompt_cache_key".into(), k.clone());
            }
        }
        if let Some(tc) = merged.get("tool_choice").filter(|v| !v.is_null()) {
            if body.contains_key("tools") {
                body.insert("tool_choice".into(), tc.clone());
            }
        }
        self.customize_thinking(merged, &mut body);
        Value::Object(body)
    }

    fn customize_thinking(&self, merged: &Kwargs, body: &mut Map<String, Value>) {
        let level = kw_str(merged, "thinking_level");
        if let Flavor::Copilot(meta) = &self.flavor {
            // Truthy, not none/off, and the model accepts reasoning_effort.
            let raw = merged.get("thinking_level").filter(|v| !v.is_null() && !py_str_or_empty(Some(v)).is_empty());
            if let Some(v) = raw {
                if !matches!(v.as_str(), Some("none" | "off")) && meta.supports_reasoning_effort {
                    body.insert("reasoning_effort".into(), v.clone());
                }
            }
            return;
        }
        match self.dialect {
            CompletionsDialect::Zai => {
                if body.get("tool_choice").and_then(|v| v.as_str()) != Some("auto") {
                    body.remove("tool_choice");
                }
                if level == Some("none") {
                    body.insert("thinking".into(), json!({"type": "disabled"}));
                }
            }
            CompletionsDialect::DeepSeek => match level {
                Some(l) if !matches!(l, "none" | "off" | "") => {
                    body.insert("thinking".into(), json!({"type": "enabled"}));
                    body.insert("reasoning_effort".into(), json!(l));
                }
                Some("none") | Some("off") => {
                    body.insert("thinking".into(), json!({"type": "disabled"}));
                }
                _ => {}
            },
            _ => match level {
                Some("none") | Some("off") => {
                    body.insert("reasoning_effort".into(), json!("none"));
                }
                Some(l) if !l.is_empty() => {
                    body.insert("reasoning_effort".into(), json!(l));
                }
                _ => {}
            },
        }
    }

    pub fn request_headers(&self, body: &Value, merged: &Kwargs) -> Vec<(String, String)> {
        if self.copilot() {
            let msgs = body.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
            return copilot_headers(&self.headers, &msgs, false);
        }
        if let Flavor::Grok = self.flavor {
            return crate::grok::request_headers(&self.headers, merged);
        }
        self.headers.clone()
    }

    fn request(&self, client: &reqwest::Client, body: &Value, merged: &Kwargs) -> reqwest::RequestBuilder {
        // Headers first: `json()` adds Content-Type only when absent, while
        // `header()` appends, so the reverse order sends it twice.
        let mut req = client.post(format!("{}/chat/completions", self.base_url));
        for (k, v) in self.request_headers(body, merged) {
            req = req.header(k, v);
        }
        req.json(body)
    }

    pub fn parse_response(&self, data: &Value, cost_model: Option<&str>) -> AssistantMessage {
        let Some(choice) = data.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first()) else {
            return AssistantMessage::default();
        };
        let msg = &choice["message"];
        let tool_calls: Vec<ToolCall> = msg
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(|tc| ToolCall::new(tc["id"].as_str().unwrap_or(""), tc["function"]["name"].as_str().unwrap_or(""), tc["function"]["arguments"].as_str().unwrap_or("")))
                    .collect()
            })
            .unwrap_or_default();
        let s = |k: &str| msg.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
        let mut a = AssistantMessage {
            content: s("content"),
            reasoning_content: s("reasoning_content").or_else(|| s("reasoning_text")),
            tool_calls: if tool_calls.is_empty() { None } else { Some(tool_calls) },
            ..Default::default()
        };
        if let Some(u) = data.get("usage").filter(|u| u.is_object()) {
            let mut extra = Map::new();
            extra.insert("usage".into(), usage_to_dict(&usage_from_openai_ext(u, self.copilot()), cost_model));
            a.meta.extra = Some(extra);
        }
        a
    }

    pub async fn chat(
        &self,
        client: &reqwest::Client,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
        merged: &Kwargs,
        cost_model: Option<&str>,
    ) -> ProviderResult<AssistantMessage> {
        let body = self.build_request(messages, tools, false, merged);
        let resp = sse::send_checked(self.request(client, &body, merged).timeout(DEFAULT_REQUEST_TIMEOUT), "openai_chat").await?;
        let data: Value = resp.json().await.map_err(ProviderError::from_reqwest)?;
        Ok(self.parse_response(&data, cost_model))
    }

    pub async fn stream(&self, client: &reqwest::Client, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, merged: &Kwargs) -> ProviderResult<ChunkStream> {
        let body = self.build_request(messages, tools, true, merged);
        let resp = sse::send_stream(self.request(client, &body, merged), Some(DEFAULT_REQUEST_TIMEOUT), "openai_stream").await?;
        let events = sse::data_json_idle(resp, Some("[DONE]"), false, Some(DEFAULT_REQUEST_TIMEOUT));
        let copilot = self.copilot();
        let s = async_stream::stream! {
            futures::pin_mut!(events);
            while let Some(ev) = events.next().await {
                let data = match ev { Ok(d) => d, Err(e) => { yield Err(e); return; } };
                yield Ok(parse_stream_chunk_ext(&data, copilot));
            }
        };
        Ok(Box::pin(s.filter_map(|r: ProviderResult<Option<ChatCompletionChunk>>| async move { r.transpose() })))
    }
}

/// Convert one OpenAI stream chunk JSON to the internal chunk (None = skip).
pub fn parse_stream_chunk(data: &Value) -> Option<ChatCompletionChunk> {
    parse_stream_chunk_ext(data, false)
}

pub fn parse_stream_chunk_ext(data: &Value, copilot_usage: bool) -> Option<ChatCompletionChunk> {
    let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let created = data.get("created").and_then(|v| v.as_i64()).unwrap_or(0);
    let model = data.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let usage = data.get("usage").filter(|u| u.is_object()).map(|u| usage_from_openai_ext(u, copilot_usage));
    let Some(choice) = data.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first()) else {
        return usage.map(|u| ChatCompletionChunk { id, created, model, choices: vec![], usage: Some(u), agent_name: None });
    };
    let d = &choice["delta"];
    let tcs: Vec<ToolCallDelta> = d
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|tc| ToolCallDelta {
                    index: tc.get("index").and_then(|v| v.as_i64()),
                    id: tc.get("id").and_then(|v| v.as_str()).map(String::from),
                    function: Some(FunctionCallDelta {
                        name: tc.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()).map(String::from),
                        arguments: tc.get("function").and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).map(String::from),
                        ..Default::default()
                    }),
                })
                .collect()
        })
        .unwrap_or_default();
    let str_of = |k: &str| d.get(k).and_then(|v| v.as_str()).map(String::from);
    // v2: `reasoning_content or reasoning_text` (empty string falls through).
    let reasoning = str_of("reasoning_content").filter(|s| !s.is_empty()).or_else(|| str_of("reasoning_text"));
    Some(ChatCompletionChunk {
        id,
        created,
        model,
        choices: vec![ChunkChoice {
            index: choice.get("index").and_then(|v| v.as_i64()).unwrap_or(0),
            delta: ChatCompletionDelta {
                content: str_of("content"),
                reasoning_content: reasoning,
                tool_calls: if tcs.is_empty() { None } else { Some(tcs) },
                ..Default::default()
            },
            finish_reason: choice.get("finish_reason").and_then(|v| v.as_str()).map(String::from),
        }],
        usage,
        agent_name: None,
    })
}

// ── Responses API ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ResponsesHandler {
    pub model: String,
    pub base_url: String,
    pub headers: Vec<(String, String)>,
    pub preserve_stateless_reasoning: bool,
    pub request_timeout: Duration,
    pub flavor: Flavor,
}

fn resp_parts(parts: &[ContentBlock]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| match p {
            ContentBlock::Text { text } => json!({"type": "input_text", "text": text}),
            ContentBlock::ImageUrl { url, detail, .. } => {
                json!({"type": "input_image", "image_url": url, "detail": detail.clone().unwrap_or_else(|| "auto".into())})
            }
            ContentBlock::ImageData { data, media_type } => {
                json!({"type": "input_image", "image_url": format!("data:{media_type};base64,{data}"), "detail": "auto"})
            }
        })
        .collect()
}

impl ResponsesHandler {
    pub fn new(model: &str, base_url: &str, headers: Vec<(String, String)>, preserve_stateless_reasoning: bool) -> Self {
        Self { model: model.into(), base_url: base_url.into(), headers, preserve_stateless_reasoning, request_timeout: DEFAULT_REQUEST_TIMEOUT, flavor: Flavor::Plain }
    }

    fn codex(&self) -> Option<&Arc<CodexTurn>> {
        match &self.flavor {
            Flavor::Codex(t) => Some(t),
            _ => None,
        }
    }

    pub fn convert_messages(&self, messages: &[ChatMessage]) -> Vec<Value> {
        let mut items = self.convert_messages_base(messages);
        if self.codex().is_some() {
            // Codex: tag message items and send text-only user turns as
            // explicit `input_text` parts.
            for item in items.iter_mut() {
                let Some(obj) = item.as_object_mut() else { continue };
                let role = obj.get("role").and_then(|r| r.as_str()).map(String::from);
                if matches!(role.as_deref(), Some("user" | "assistant")) && !obj.contains_key("type") {
                    obj.insert("type".into(), json!("message"));
                }
                if role.as_deref() == Some("user") {
                    if let Some(Value::String(s)) = obj.get("content") {
                        let s = s.clone();
                        obj.insert("content".into(), json!([{"type": "input_text", "text": s}]));
                    }
                }
            }
        }
        items
    }

    fn convert_messages_base(&self, messages: &[ChatMessage]) -> Vec<Value> {
        let mut items = vec![];
        for msg in messages {
            match msg {
                ChatMessage::System { content, .. } => items.push(json!({"role": "system", "content": content.clone().unwrap_or_default()})),
                ChatMessage::User { content, parts, .. } => {
                    if let Some(p) = parts.as_ref().filter(|p| !p.is_empty()) {
                        items.push(json!({"role": "user", "content": resp_parts(p)}));
                    } else {
                        items.push(json!({"role": "user", "content": content.clone().unwrap_or_default()}));
                    }
                }
                ChatMessage::Assistant(a) => {
                    for ri in a.reasoning_items.iter().flatten() {
                        let mut item = Map::new();
                        item.insert("type".into(), json!("reasoning"));
                        item.insert("summary".into(), json!(ri.summary));
                        item.insert("encrypted_content".into(), json!(ri.encrypted_content));
                        if let Some(id) = &ri.id {
                            item.insert("id".into(), json!(id));
                        }
                        items.push(Value::Object(item));
                    }
                    if let Some(c) = a.content.as_ref().filter(|c| !c.is_empty()) {
                        items.push(json!({"role": "assistant", "content": [{"type": "output_text", "text": c}]}));
                    }
                    for tc in a.tool_calls.iter().flatten() {
                        if !tc.id.is_empty() {
                            items.push(json!({"type": "function_call", "call_id": tc.id, "name": tc.function.name, "arguments": tc.function.arguments}));
                        }
                    }
                }
                ChatMessage::Tool { content, tool_call_id, parts, .. } => {
                    if tool_call_id.is_empty() {
                        continue;
                    }
                    let output = match parts.as_ref().filter(|p| !p.is_empty()) {
                        Some(p) => json!(resp_parts(p)),
                        None => json!(content.clone().unwrap_or_default()),
                    };
                    items.push(json!({"type": "function_call_output", "call_id": tool_call_id, "output": output}));
                }
            }
        }
        items
    }

    pub fn build_request(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, stream: bool, merged: &Kwargs) -> Value {
        let Some(turn) = self.codex() else {
            return Value::Object(self.build_request_base(messages, tools, stream, merged));
        };
        // `_CodexResponsesHandler.build_request`.
        let mut system_parts: Vec<String> = vec![];
        let mut non_system: Vec<ChatMessage> = vec![];
        for m in messages {
            match m {
                ChatMessage::System { content, .. } => {
                    if let Some(c) = content.as_ref().filter(|c| !c.is_empty()) {
                        system_parts.push(c.clone());
                    }
                }
                other => non_system.push(other.clone()),
            }
        }
        // A new turn (anything but a tool result last) drops the sticky token.
        if !matches!(non_system.last(), Some(ChatMessage::Tool { .. })) {
            *turn.turn_state.lock().unwrap() = None;
        }
        let mut body = self.build_request_base(&non_system, tools, stream, merged);
        body.shift_remove("max_output_tokens");
        let instructions = system_parts.join("\n\n");
        if !instructions.is_empty() {
            body.insert("instructions".into(), json!(instructions));
        } else {
            body.shift_remove("instructions");
        }
        body.insert("store".into(), json!(false));
        body.insert("tool_choice".into(), merged.get("tool_choice").cloned().unwrap_or(json!("auto")));
        body.insert("parallel_tool_calls".into(), json!(true));
        body.insert("include".into(), json!(["reasoning.encrypted_content"]));
        match merged.get("prompt_cache_key").filter(|v| !v.is_null()) {
            Some(k) => {
                body.insert("prompt_cache_key".into(), k.clone());
            }
            None => {
                if let Some(sid) = merged.get("session_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    body.insert("prompt_cache_key".into(), json!(sid));
                }
            }
        }
        let tier = py_str_or_empty(merged.get("service_tier")).to_lowercase();
        if !CODEX_NO_SERVICE_TIER.contains(&tier.as_str()) {
            body.insert("service_tier".into(), json!(if tier == "fast" { "priority".to_string() } else { tier }));
        }
        Value::Object(body)
    }

    fn build_request_base(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, stream: bool, merged: &Kwargs) -> Map<String, Value> {
        let mut body = Map::new();
        body.insert("model".into(), json!(self.model));
        body.insert("input".into(), Value::Array(self.convert_messages(&sanitize_tool_pairs(messages))));
        body.insert("stream".into(), json!(stream));
        if self.preserve_stateless_reasoning {
            body.insert("store".into(), json!(false));
            body.insert("include".into(), json!(["reasoning.encrypted_content"]));
        }
        let rtools: Vec<Value> = tools
            .unwrap_or(&[])
            .iter()
            .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("function"))
            .map(|t| {
                let f = &t["function"];
                json!({"type": "function", "name": f["name"], "description": f.get("description").cloned().unwrap_or(json!("")),
                       "parameters": f.get("parameters").cloned().unwrap_or(json!({}))})
            })
            .collect();
        if !rtools.is_empty() {
            body.insert("tools".into(), json!(rtools));
            if let Some(tc) = merged.get("tool_choice").filter(|v| !v.is_null()) {
                body.insert("tool_choice".into(), tc.clone());
            }
        }
        if let Some(k) = merged.get("prompt_cache_key").filter(|v| !v.is_null()) {
            body.insert("prompt_cache_key".into(), k.clone());
        }
        if let Some(mt) = merged.get("max_tokens").filter(|v| !v.is_null()) {
            body.insert("max_output_tokens".into(), mt.clone());
        }
        if let Some(tier) = kw_str(merged, "service_tier").filter(|s| !s.is_empty()) {
            if self.base_url.contains("api.openai.com") {
                body.insert("service_tier".into(), json!(if tier == "fast" { "priority" } else { tier }));
            }
        }
        self.customize_thinking(merged, &mut body);
        body
    }

    fn customize_thinking(&self, merged: &Kwargs, body: &mut Map<String, Value>) {
        if let Some(turn) = self.codex() {
            let level = merged.get("thinking_level").filter(|v| !v.is_null());
            if matches!(level.and_then(|v| v.as_str()), Some("none" | "off")) {
                body.insert("reasoning".into(), json!({"effort": "none"}));
                return;
            }
            let effort = match level {
                Some(v) if !py_str_or_empty(Some(v)).is_empty() => v.clone(),
                _ => json!("medium"),
            };
            let mut r = Map::new();
            r.insert("effort".into(), effort);
            if turn.supports_reasoning_summary {
                r.insert("summary".into(), json!("auto"));
            }
            body.insert("reasoning".into(), Value::Object(r));
            return;
        }
        match kw_str(merged, "thinking_level") {
            Some("none") | Some("off") => {
                body.insert("reasoning".into(), json!({"effort": "none"}));
            }
            Some(l) if !l.is_empty() => {
                body.insert("reasoning".into(), json!({"effort": l, "summary": "auto"}));
            }
            _ => {}
        }
    }

    /// `_prepare_request_headers(body)`.
    pub fn request_headers(&self, body: &Value, merged: &Kwargs) -> Vec<(String, String)> {
        match &self.flavor {
            Flavor::Plain => self.headers.clone(),
            Flavor::Grok => crate::grok::request_headers(&self.headers, merged),
            Flavor::Copilot(_) => {
                let items = body.get("input").and_then(|m| m.as_array()).cloned().unwrap_or_default();
                copilot_headers(&self.headers, &items, true)
            }
            Flavor::Codex(turn) => {
                let model = body.get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(&self.model);
                let mut hint = format!("model={model}");
                if let Some(t) = body.get("service_tier").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    hint.push_str(&format!(";tier={t}"));
                }
                let mut h = self.headers.clone();
                set_header(&mut h, "x-codex-routing-hint", &hint);
                if let Some(sid) = merged.get("session_id").and_then(|v| v.as_str()) {
                    if !sid.is_empty() {
                        set_header(&mut h, "session-id", sid);
                    }
                }
                if let Some(ts) = turn.turn_state.lock().unwrap().clone().filter(|s| !s.is_empty()) {
                    set_header(&mut h, CODEX_TURN_STATE_HEADER, &ts);
                }
                h
            }
        }
    }

    /// `on_response_headers` — Codex captures the turn's first sticky token.
    fn on_response_headers(&self, resp: &reqwest::Response) {
        let Some(turn) = self.codex() else { return };
        let mut ts = turn.turn_state.lock().unwrap();
        if ts.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
            return;
        }
        if let Some(v) = resp.headers().get(CODEX_TURN_STATE_HEADER).and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty()) {
            *ts = Some(v.to_string());
        }
    }

    fn request(&self, client: &reqwest::Client, body: &Value, merged: &Kwargs) -> reqwest::RequestBuilder {
        // Headers before `json()` (see `CompletionsHandler::request`): Codex
        // rejects a doubled Content-Type with HTTP 400.
        let mut req = client.post(format!("{}/responses", self.base_url));
        for (k, v) in self.request_headers(body, merged) {
            req = req.header(k, v);
        }
        req.json(body)
    }

    fn usage_of(u: &Value) -> Usage {
        let i = |k: &str| u.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        Usage {
            prompt_tokens: i("input_tokens"),
            completion_tokens: i("output_tokens"),
            total_tokens: i("total_tokens"),
            cached_tokens: u.pointer("/input_tokens_details/cached_tokens").and_then(|v| v.as_i64()).filter(|n| *n != 0),
            thoughts_tokens: u.pointer("/output_tokens_details/reasoning_tokens").and_then(|v| v.as_i64()).filter(|n| *n != 0),
            ..Default::default()
        }
    }

    pub fn parse_response(&self, data: &Value, cost_model: Option<&str>) -> AssistantMessage {
        let mut content = vec![];
        let mut reasoning = vec![];
        let mut items = vec![];
        let mut tcs = vec![];
        for item in data.get("output").and_then(|v| v.as_array()).into_iter().flatten() {
            match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "message" => {
                    for p in item.get("content").and_then(|v| v.as_array()).into_iter().flatten() {
                        if p["type"] == "output_text" {
                            content.push(p["text"].as_str().unwrap_or("").to_string());
                        }
                    }
                }
                "reasoning" => {
                    for s in item.get("summary").and_then(|v| v.as_array()).into_iter().flatten() {
                        if s["type"] == "summary_text" {
                            reasoning.push(s["text"].as_str().unwrap_or("").to_string());
                        }
                    }
                    if let Some(enc) = item.get("encrypted_content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        items.push(EncryptedReasoningItem {
                            id: item.get("id").and_then(|v| v.as_str()).map(String::from),
                            summary: item.get("summary").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
                            encrypted_content: enc.into(),
                        });
                    }
                }
                "function_call" => {
                    let id = item.get("call_id").or_else(|| item.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                    tcs.push(ToolCall::new(id, item["name"].as_str().unwrap_or(""), item.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}")));
                }
                _ => {}
            }
        }
        let mut extra = Map::new();
        if let Some(u) = data.get("usage").filter(|u| u.as_object().map(|o| !o.is_empty()).unwrap_or(false)) {
            extra.insert("usage".into(), usage_to_dict(&Self::usage_of(u), cost_model));
        }
        let mut a = AssistantMessage {
            content: if content.is_empty() { None } else { Some(content.join("\n")) },
            reasoning_content: if reasoning.is_empty() { None } else { Some(reasoning.join("\n\n")) },
            reasoning_items: if items.is_empty() { None } else { Some(items) },
            tool_calls: if tcs.is_empty() { None } else { Some(tcs) },
            ..Default::default()
        };
        a.meta.extra = if extra.is_empty() { None } else { Some(extra) };
        a.sync_reasoning_extra();
        a
    }

    pub async fn chat(
        &self,
        client: &reqwest::Client,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
        merged: &Kwargs,
        cost_model: Option<&str>,
    ) -> ProviderResult<AssistantMessage> {
        if self.codex().is_some() {
            return self.chat_via_stream(client, messages, tools, merged, cost_model).await;
        }
        let body = self.build_request(messages, tools, false, merged);
        let resp = sse::send_head(self.request(client, &body, merged).timeout(self.request_timeout), None).await?;
        self.on_response_headers(&resp);
        let resp = sse::check_status(resp, "openai_chat").await?;
        let data: Value = resp.json().await.map_err(ProviderError::from_reqwest)?;
        Ok(self.parse_response(&data, cost_model))
    }

    /// `_CodexResponsesHandler.chat`: the endpoint only streams, so the final
    /// message is assembled from the stream.
    async fn chat_via_stream(
        &self,
        client: &reqwest::Client,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
        merged: &Kwargs,
        cost_model: Option<&str>,
    ) -> ProviderResult<AssistantMessage> {
        let mut s = self.stream(client, messages, tools, merged).await?;
        let (mut content, mut reasoning) = (String::new(), String::new());
        let mut items: Vec<EncryptedReasoningItem> = vec![];
        let mut usage: Option<Usage> = None;
        let mut calls: std::collections::BTreeMap<i64, ToolCall> = std::collections::BTreeMap::new();
        while let Some(chunk) = s.next().await {
            let chunk = chunk?;
            if chunk.usage.is_some() {
                usage = chunk.usage.clone();
            }
            let Some(choice) = chunk.choices.first() else { continue };
            let d = &choice.delta;
            if let Some(c) = d.content.as_ref().filter(|c| !c.is_empty()) {
                content.push_str(c);
            }
            if let Some(r) = d.reasoning_content.as_ref().filter(|r| !r.is_empty()) {
                reasoning.push_str(r);
            }
            if let Some(ri) = &d.reasoning_item {
                items.push(ri.clone());
            }
            for tc in d.tool_calls.iter().flatten() {
                let index = tc.index.unwrap_or(calls.len() as i64);
                let call = calls.entry(index).or_insert_with(|| ToolCall::new(tc.id.clone().unwrap_or_default(), "", ""));
                if let Some(id) = tc.id.as_ref().filter(|s| !s.is_empty()) {
                    call.id = id.clone();
                }
                let Some(f) = &tc.function else { continue };
                if let Some(n) = f.name.as_ref().filter(|s| !s.is_empty()) {
                    call.function.name = n.clone();
                }
                if let Some(a) = f.arguments.as_ref().filter(|s| !s.is_empty()) {
                    call.function.arguments.push_str(a);
                }
            }
        }
        let mut extra = Map::new();
        if let Some(u) = &usage {
            extra.insert("usage".into(), usage_to_dict(u, cost_model));
        }
        if !items.is_empty() {
            extra.insert("reasoning_items".into(), Value::Array(items.iter().map(|i| serde_json::to_value(i).unwrap()).collect()));
        }
        let tcs: Vec<ToolCall> = calls.into_values().collect();
        let mut a = AssistantMessage {
            content: Some(content).filter(|s| !s.is_empty()),
            reasoning_content: Some(reasoning).filter(|s| !s.is_empty()),
            reasoning_items: if items.is_empty() { None } else { Some(items) },
            tool_calls: if tcs.is_empty() { None } else { Some(tcs) },
            ..Default::default()
        };
        a.meta.extra = if extra.is_empty() { None } else { Some(extra) };
        a.sync_reasoning_extra();
        Ok(a)
    }

    pub async fn stream(&self, client: &reqwest::Client, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, merged: &Kwargs) -> ProviderResult<ChunkStream> {
        let body = self.build_request(messages, tools, true, merged);
        let url = format!("{}/responses", self.base_url);
        let resp = sse::send_head(self.request(client, &body, merged), Some(self.request_timeout)).await?;
        self.on_response_headers(&resp);
        let resp = sse::check_status(resp, "openai_stream").await?;
        let model = self.model.clone();
        let lines = sse::lines_idle(resp, Some(self.request_timeout));
        let s = async_stream::stream! {
            futures::pin_mut!(lines);
            let mut p = ResponsesStreamParser::new(model);
            while let Some(line) = lines.next().await {
                let line = match line { Ok(l) => l, Err(e) => { yield Err(e); return; } };
                let line = line.trim();
                let Some(data) = line.strip_prefix("data: ") else { continue };
                if data == "[DONE]" { break; }
                let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
                match p.feed(&event, &url) {
                    Ok(chunks) => for c in chunks { yield Ok(c); },
                    Err(e) => { yield Err(e); return; }
                }
            }
        };
        Ok(Box::pin(s))
    }
}

/// Stateful parser for `/responses` SSE events (v2 `_parse_stream`).
pub struct ResponsesStreamParser {
    model: String,
    response_id: String,
    id_to_canonical: HashMap<String, String>,
    index_to_canonical: HashMap<i64, String>,
    current_index: i64,
    tool_call_map: HashMap<String, i64>,
    tool_names: HashMap<String, String>,
    had_deltas: HashSet<String>,
    reasoning_parts_seen: usize,
    /// Message items whose text already streamed; `""` when a delta had no
    /// `item_id`. Text in a finished item is emitted only when none streamed.
    text_items: HashSet<String>,
    /// Event counts, logged when a response ends with no text and no tools.
    events: std::collections::BTreeMap<String, usize>,
}

impl ResponsesStreamParser {
    pub fn new(model: String) -> Self {
        Self {
            model,
            response_id: String::new(),
            id_to_canonical: HashMap::new(),
            index_to_canonical: HashMap::new(),
            current_index: -1,
            tool_call_map: HashMap::new(),
            tool_names: HashMap::new(),
            had_deltas: HashSet::new(),
            reasoning_parts_seen: 0,
            text_items: HashSet::new(),
            events: std::collections::BTreeMap::new(),
        }
    }

    fn chunk(&self, delta: ChatCompletionDelta, finish: Option<&str>) -> ChatCompletionChunk {
        ChatCompletionChunk::delta(&self.response_id, &self.model, delta, finish.map(String::from), None)
    }

    /// Text for a message item that did not stream it, else `None`.
    fn unstreamed_text(&mut self, item_id: &str, text: String) -> Option<ChatCompletionChunk> {
        if text.is_empty() || self.text_items.contains(item_id) || self.text_items.contains("") {
            return None;
        }
        self.text_items.insert(item_id.to_string());
        Some(self.chunk(ChatCompletionDelta { content: Some(text), ..Default::default() }, None))
    }

    /// A response that produced neither text nor a tool call reads as an
    /// empty answer and is retried; record what the stream did carry.
    fn log_if_empty(&self, event: &Value) {
        if !self.text_items.is_empty() || !self.tool_call_map.is_empty() {
            return;
        }
        let response = event.get("response");
        let status = response.and_then(|r| r.get("status")).and_then(|v| v.as_str()).unwrap_or("");
        let reason = response.and_then(|r| r.pointer("/incomplete_details/reason")).and_then(|v| v.as_str()).unwrap_or("");
        let outputs: Vec<&str> =
            response.and_then(|r| r.get("output")).and_then(|v| v.as_array()).into_iter().flatten().filter_map(|i| i.get("type").and_then(|v| v.as_str())).collect();
        let events: Vec<String> = self.events.iter().map(|(k, n)| format!("{k}={n}")).collect();
        tracing::warn!(
            "responses_empty_output model={} response_id={} status={} reason={} output_types=[{}] events=[{}]",
            self.model,
            self.response_id,
            status,
            reason,
            outputs.join(","),
            events.join(",")
        );
    }

    fn resolve(&mut self, ev: &Value) -> (String, String) {
        let s = |k: &str| ev.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let raw_call = s("call_id");
        let raw_item = s("item_id");
        let out_idx = ev.get("output_index").and_then(|v| v.as_i64());
        let ext_id = if !raw_call.is_empty() { raw_call.clone() } else { raw_item.clone() };
        let inline = s("name");
        let lookup = |m: &HashMap<String, String>, k: &str| if k.is_empty() { None } else { m.get(k).cloned() };
        let canon = lookup(&self.id_to_canonical, &raw_call)
            .or_else(|| lookup(&self.id_to_canonical, &raw_item))
            .or_else(|| lookup(&self.id_to_canonical, &ext_id))
            .or_else(|| out_idx.and_then(|i| self.index_to_canonical.get(&i).cloned()))
            .filter(|s| !s.is_empty())
            .or_else(|| Some(ext_id.clone()).filter(|s| !s.is_empty()))
            .or_else(|| Some(raw_call.clone()).filter(|s| !s.is_empty()))
            .or_else(|| Some(raw_item.clone()).filter(|s| !s.is_empty()))
            .or_else(|| out_idx.map(|i| format!("call_{i}")))
            .unwrap_or_default();
        if !canon.is_empty() {
            for k in [&raw_call, &raw_item, &ext_id] {
                if !k.is_empty() {
                    self.id_to_canonical.insert(k.clone(), canon.clone());
                }
            }
            if let Some(i) = out_idx {
                self.index_to_canonical.insert(i, canon.clone());
            }
        }
        (canon, inline)
    }

    pub fn feed(&mut self, event: &Value, url: &str) -> ProviderResult<Vec<ChatCompletionChunk>> {
        let mut out = vec![];
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let delta_text = || event.get("delta").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let item_id = event.get("item_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        *self.events.entry(etype.to_string()).or_default() += 1;
        match etype {
            "response.created" => {
                self.response_id = event.pointer("/response/id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            }
            "response.output_item.added" => {
                let item = &event["item"];
                if item["type"] == "function_call" {
                    let out_idx = event.get("output_index").and_then(|v| v.as_i64());
                    let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let canon = if !call_id.is_empty() {
                        call_id.clone()
                    } else if !item_id.is_empty() {
                        item_id.clone()
                    } else {
                        out_idx.map(|i| format!("call_{i}")).unwrap_or_default()
                    };
                    if !item_id.is_empty() {
                        self.id_to_canonical.insert(item_id.clone(), canon.clone());
                    }
                    if !call_id.is_empty() {
                        self.id_to_canonical.insert(call_id.clone(), canon.clone());
                    }
                    if let Some(i) = out_idx {
                        self.index_to_canonical.insert(i, canon.clone());
                    }
                    if !name.is_empty() {
                        self.tool_names.insert(canon.clone(), name.clone());
                        if !item_id.is_empty() {
                            self.tool_names.insert(item_id, name.clone());
                        }
                        if !call_id.is_empty() {
                            self.tool_names.insert(call_id, name);
                        }
                    }
                }
            }
            "response.output_item.done" => {
                let item = &event["item"];
                if item["type"] == "message" {
                    let text: String = item
                        .get("content")
                        .and_then(|v| v.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|part| match part.get("type").and_then(|v| v.as_str()) {
                            Some("output_text") => part.get("text").and_then(|v| v.as_str()),
                            Some("refusal") => part.get("refusal").and_then(|v| v.as_str()),
                            _ => None,
                        })
                        .collect();
                    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    out.extend(self.unstreamed_text(&id, text));
                }
                if item["type"] == "reasoning" {
                    if let Some(enc) = item.get("encrypted_content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        out.push(self.chunk(
                            ChatCompletionDelta {
                                reasoning_item: Some(EncryptedReasoningItem {
                                    id: item.get("id").and_then(|v| v.as_str()).map(String::from),
                                    summary: item.get("summary").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
                                    encrypted_content: enc.into(),
                                }),
                                ..Default::default()
                            },
                            None,
                        ));
                    }
                }
            }
            "response.reasoning_summary_part.added" => {
                self.reasoning_parts_seen += 1;
                if self.reasoning_parts_seen > 1 {
                    out.push(self.chunk(ChatCompletionDelta { reasoning_content: Some("\n\n".into()), ..Default::default() }, None));
                }
            }
            "response.reasoning_text.delta" | "response.reasoning_summary.delta" | "response.reasoning_summary_text.delta" => {
                let t = delta_text();
                if !t.is_empty() {
                    out.push(self.chunk(ChatCompletionDelta { reasoning_content: Some(t), ..Default::default() }, None));
                }
            }
            "response.output_text.delta" => {
                let t = delta_text();
                if !t.is_empty() {
                    self.text_items.insert(item_id);
                    out.push(self.chunk(ChatCompletionDelta { content: Some(t), ..Default::default() }, None));
                }
            }
            "response.failed" => return Err(response_failed(event, url)),
            "response.function_call_arguments.delta" => {
                let (cid, inline) = self.resolve(event);
                let args = delta_text();
                let first = !self.tool_call_map.contains_key(&cid);
                if first {
                    self.current_index += 1;
                    self.tool_call_map.insert(cid.clone(), self.current_index);
                }
                let name = if !inline.is_empty() { inline } else { self.tool_names.get(&cid).cloned().unwrap_or_default() };
                if !name.is_empty() && !cid.is_empty() && !self.tool_names.contains_key(&cid) {
                    self.tool_names.insert(cid.clone(), name.clone());
                }
                self.had_deltas.insert(cid.clone());
                let idx = self.tool_call_map[&cid];
                let emit_name = if first && !name.is_empty() { Some(name) } else { None };
                out.push(self.chunk(
                    ChatCompletionDelta {
                        tool_calls: Some(vec![ToolCallDelta {
                            index: Some(idx),
                            id: if cid.is_empty() { None } else { Some(cid) },
                            function: Some(FunctionCallDelta { name: emit_name, arguments: Some(args), ..Default::default() }),
                        }]),
                        ..Default::default()
                    },
                    None,
                ));
            }
            "response.function_call_arguments.done" => {
                let (cid, inline) = self.resolve(event);
                let name = if !inline.is_empty() { inline } else { self.tool_names.get(&cid).cloned().unwrap_or_default() };
                let args = event.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}").to_string();
                if !self.tool_call_map.contains_key(&cid) {
                    self.current_index += 1;
                    self.tool_call_map.insert(cid.clone(), self.current_index);
                }
                if !name.is_empty() && !cid.is_empty() && !self.tool_names.contains_key(&cid) {
                    self.tool_names.insert(cid.clone(), name.clone());
                }
                let idx = self.tool_call_map[&cid];
                let emit_args = if self.had_deltas.contains(&cid) { None } else { Some(args) };
                out.push(self.chunk(
                    ChatCompletionDelta {
                        tool_calls: Some(vec![ToolCallDelta {
                            index: Some(idx),
                            id: Some(cid),
                            function: Some(FunctionCallDelta { name: Some(name), arguments: emit_args, ..Default::default() }),
                        }]),
                        ..Default::default()
                    },
                    None,
                ));
            }
            "response.output_text.done" => {
                let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                out.extend(self.unstreamed_text(&item_id, text));
                out.push(self.chunk(ChatCompletionDelta::default(), Some("stop")));
            }
            "response.completed" | "response.incomplete" => {
                self.log_if_empty(event);
                if let Some(u) = event.pointer("/response/usage").filter(|u| u.as_object().map(|o| !o.is_empty()).unwrap_or(false)) {
                    out.push(ChatCompletionChunk::usage_only(&self.response_id, &self.model, ResponsesHandler::usage_of(u)));
                }
            }
            _ => {}
        }
        Ok(out)
    }
}

fn response_failed(event: &Value, url: &str) -> ProviderError {
    let error = event.pointer("/response/error").filter(|v| v.is_object()).or_else(|| event.get("error")).cloned().unwrap_or(json!({}));
    let code = error.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let etype = error.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let message = error.get("message").and_then(|v| v.as_str()).unwrap_or("response.failed event received").to_string();
    let status = if matches!(code, "server_is_overloaded" | "slow_down") || etype == "service_unavailable_error" {
        503
    } else if matches!(code, "rate_limit_exceeded" | "insufficient_quota")
        || matches!(
            etype,
            "usage_limit_reached"
                | "usage_not_included"
                | "workspace_owner_credits_depleted"
                | "workspace_member_credits_depleted"
                | "workspace_owner_usage_limit_reached"
                | "workspace_member_usage_limit_reached"
        )
    {
        429
    } else {
        400
    };
    let _ = url;
    ProviderError::Http { status, body: json!({"error": error}).to_string(), headers: vec![], message }
}

// ── provider ────────────────────────────────────────────────────────────────

pub struct OpenAiProvider {
    pub model: String,
    pub provider_name: Option<String>,
    pub base_kwargs: Kwargs,
    pub use_responses: bool,
    pub completions: CompletionsHandler,
    pub responses: ResponsesHandler,
    client: reqwest::Client,
}

impl OpenAiProvider {
    /// `responses_allowed=false` → `ChatCompletionsOnlyProvider`.
    pub fn new(api_key: &str, model: &str, base_url: &str, model_kwargs: Kwargs, dialect: CompletionsDialect, responses_allowed: bool) -> ProviderResult<Self> {
        if api_key.is_empty() {
            return Err(ProviderError::Invalid("API key is required. Provide it via the provider's environment variable.".into()));
        }
        let headers = vec![("Authorization".to_string(), format!("Bearer {api_key}")), ("Content-Type".to_string(), "application/json".to_string())];
        Ok(Self::with_headers(model, base_url, headers, model_kwargs, dialect, responses_allowed))
    }

    /// Construct with explicit headers (v2 `_build_headers` override).
    pub fn with_headers(model: &str, base_url: &str, headers: Vec<(String, String)>, model_kwargs: Kwargs, dialect: CompletionsDialect, responses_allowed: bool) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        let use_responses = responses_allowed && should_use_responses(&model_kwargs);
        Self {
            model: model.into(),
            provider_name: None,
            completions: CompletionsHandler::new(model, &base_url, headers.clone(), dialect),
            responses: ResponsesHandler::new(model, &base_url, headers, base_url == API_BASE_URL),
            base_kwargs: model_kwargs,
            use_responses,
            client: shared_client(),
        }
    }
}

pub fn shared_client() -> reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().pool_idle_timeout(Duration::from_secs(90)).build().expect("reqwest client")).clone()
}

pub fn should_use_responses(kw: &Kwargs) -> bool {
    if let Some(v) = kw.get("responses_api") {
        return match v {
            Value::Bool(b) => *b,
            Value::Null => false,
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => n.as_f64() != Some(0.0),
            _ => true,
        };
    }
    matches!(kw_str(kw, "thinking_level"), Some(l) if !matches!(l, "none" | "off" | ""))
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    fn model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> Option<&str> {
        self.provider_name.as_deref()
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.base_kwargs
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        let merged = self.merged_kwargs(kwargs);
        // v2 handlers price with `provider_cost_model_id(handler)` — the
        // handler carries only the bare model id.
        let cm = Some(self.model.clone());
        if self.use_responses {
            self.responses.chat(&self.client, messages, tools, &merged, cm.as_deref()).await
        } else {
            self.completions.chat(&self.client, messages, tools, &merged, cm.as_deref()).await
        }
    }
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        let merged = self.merged_kwargs(kwargs);
        if self.use_responses {
            self.responses.stream(&self.client, messages, tools, &merged).await
        } else {
            self.completions.stream(&self.client, messages, tools, &merged).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(d: CompletionsDialect) -> CompletionsHandler {
        CompletionsHandler::new("m", "https://api.openai.com/v1", vec![], d)
    }

    fn content_types(req: &reqwest::Request) -> Vec<String> {
        req.headers().get_all(reqwest::header::CONTENT_TYPE).iter().map(|v| v.to_str().unwrap().to_string()).collect()
    }

    /// ChatGPT's Codex backend rejects a doubled header with HTTP 400
    /// "Unsupported content type"; `.json()` must not add a second one.
    #[test]
    fn codex_request_sends_one_content_type() {
        let headers = vec![("Content-Type".into(), "application/json".into()), ("Authorization".into(), "Bearer t".into())];
        let mut h = ResponsesHandler::new("m", "http://127.0.0.1:1", headers, false);
        h.flavor = Flavor::Codex(Arc::new(CodexTurn { turn_state: Default::default(), supports_reasoning_summary: true }));
        let req = h.request(&reqwest::Client::new(), &json!({"model": "m"}), &Kwargs::new()).build().unwrap();
        assert_eq!(content_types(&req), vec!["application/json"]);
    }

    #[test]
    fn completions_request_sends_one_content_type() {
        let headers = vec![("Content-Type".into(), "application/json".into())];
        let h = CompletionsHandler::new("m", "http://127.0.0.1:1", headers, CompletionsDialect::OpenAi);
        let req = h.request(&reqwest::Client::new(), &json!({"model": "m"}), &Kwargs::new()).build().unwrap();
        assert_eq!(content_types(&req), vec!["application/json"]);
    }

    #[test]
    fn grok_flavor_adds_request_headers_on_both_apis() {
        let mut kw = Kwargs::new();
        kw.insert("session_id".into(), json!("s1"));
        let has_conv = |req: &reqwest::Request| req.headers().get("x-grok-conv-id").and_then(|v| v.to_str().ok()) == Some("s1");
        let mut c = CompletionsHandler::new("m", "http://127.0.0.1:1", vec![], CompletionsDialect::OpenAi);
        c.flavor = Flavor::Grok;
        assert!(has_conv(&c.request(&reqwest::Client::new(), &json!({"model": "m"}), &kw).build().unwrap()));
        let mut r = ResponsesHandler::new("m", "http://127.0.0.1:1", vec![], true);
        r.flavor = Flavor::Grok;
        assert!(has_conv(&r.request(&reqwest::Client::new(), &json!({"model": "m"}), &kw).build().unwrap()));
    }

    #[test]
    fn assistant_content_rules_match_v2() {
        let tc = ToolCall::new("c1", "read", "{}");
        let msgs = vec![
            ChatMessage::user("hi"),
            ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![tc]), ..Default::default() }),
            ChatMessage::tool("c1", Some("read".into()), "ok"),
            ChatMessage::Assistant(AssistantMessage { reasoning_content: Some("thinking".into()), ..Default::default() }),
            ChatMessage::Assistant(AssistantMessage::default()),
        ];
        let out = convert_messages(&msgs, CompletionsDialect::OpenAi);
        assert_eq!(out[1]["content"], "");
        assert_eq!(out[1]["tool_calls"][0]["function"]["name"], "read");
        assert_eq!(out[2], json!({"role": "tool", "content": "ok", "tool_call_id": "c1", "name": "read"}));
        assert_eq!(out[3]["content"], "thinking");
        assert_eq!(out[4]["content"], "...");
    }

    #[test]
    fn request_fields_per_dialect() {
        let mut kw = Kwargs::new();
        kw.insert("max_tokens".into(), json!(100));
        kw.insert("thinking_level".into(), json!("high"));
        let b = h(CompletionsDialect::OpenAi).build_request(&[ChatMessage::user("x")], None, true, &kw);
        assert_eq!(b["max_completion_tokens"], 100);
        assert_eq!(b["reasoning_effort"], "high");
        assert_eq!(b["stream_options"], json!({"include_usage": true}));
        let b = h(CompletionsDialect::DeepSeek).build_request(&[ChatMessage::user("x")], None, true, &kw);
        assert_eq!(b["max_tokens"], 100);
        assert_eq!(b["thinking"], json!({"type": "enabled"}));
        let mut kw2 = Kwargs::new();
        kw2.insert("thinking_level".into(), json!("none"));
        let b = h(CompletionsDialect::Zai).build_request(&[ChatMessage::user("x")], None, false, &kw2);
        assert_eq!(b["thinking"], json!({"type": "disabled"}));
        assert!(b.get("reasoning_effort").is_none());
    }

    #[test]
    fn sanitize_drops_orphans() {
        let msgs = vec![
            ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("a", "x", "{}")]), ..Default::default() }),
            ChatMessage::user("interrupt"),
            ChatMessage::tool("a", None, "late"),
        ];
        let out = sanitize_tool_pairs(&msgs);
        assert_eq!(out.len(), 2);
        assert!(out[0].as_assistant().unwrap().tool_calls.is_none());
    }

    #[test]
    fn sanitize_borrows_a_well_paired_transcript() {
        let msgs = vec![
            ChatMessage::user("go"),
            ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("a", "x", "{}"), ToolCall::new("b", "y", "{}")]), ..Default::default() }),
            ChatMessage::tool("b", None, "rb"),
            ChatMessage::tool("a", None, "ra"),
            ChatMessage::Assistant(AssistantMessage { content: Some("done".into()), ..Default::default() }),
        ];
        assert!(matches!(sanitize_tool_pairs(&msgs), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn sanitize_keeps_good_pairs_while_fixing_bad_ones() {
        let msgs = vec![
            ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("a", "x", "{}")]), ..Default::default() }),
            ChatMessage::tool("a", None, "ra"),
            ChatMessage::tool("a", None, "duplicate"),
            ChatMessage::Assistant(AssistantMessage {
                content: Some("half".into()),
                tool_calls: Some(vec![ToolCall::new("b", "x", "{}"), ToolCall::new("c", "x", "{}")]),
                ..Default::default()
            }),
            ChatMessage::tool("b", None, "rb"),
            ChatMessage::user("next"),
        ];
        let out = sanitize_tool_pairs(&msgs);
        let shape: Vec<(String, Option<String>, bool)> =
            out.iter().map(|m| (m.role().to_string(), m.content().map(String::from), m.as_assistant().map(|a| a.tool_calls.is_some()).unwrap_or(false))).collect();
        assert_eq!(
            shape,
            vec![
                ("assistant".into(), None, true),
                ("tool".into(), Some("ra".into()), false),
                ("assistant".into(), Some("half".into()), false),
                ("user".into(), Some("next".into()), false),
            ]
        );
    }

    #[test]
    fn responses_stream_tool_call() {
        let mut p = ResponsesStreamParser::new("m".into());
        p.feed(&json!({"type": "response.created", "response": {"id": "r1"}}), "").unwrap();
        p.feed(&json!({"type": "response.output_item.added", "output_index": 0, "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read"}}), "")
            .unwrap();
        let c = p.feed(&json!({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 0, "delta": "{\"a\""}), "").unwrap();
        let d = &c[0].choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!(d.id.as_deref(), Some("call_1"));
        assert_eq!(d.function.as_ref().unwrap().name.as_deref(), Some("read"));
        let c = p.feed(&json!({"type": "response.function_call_arguments.done", "item_id": "fc_1", "arguments": "{\"a\":1}"}), "").unwrap();
        assert_eq!(c[0].choices[0].delta.tool_calls.as_ref().unwrap()[0].function.as_ref().unwrap().arguments, None);
    }

    fn streamed_text(chunks: &[ChatCompletionChunk]) -> String {
        chunks.iter().filter_map(|c| c.choices.first()).filter_map(|ch| ch.delta.content.clone()).collect()
    }

    /// A message delivered only as a finished item (no `output_text.delta`)
    /// used to read as an empty response and trigger retries.
    #[test]
    fn responses_stream_keeps_text_sent_only_in_the_finished_item() {
        let mut p = ResponsesStreamParser::new("m".into());
        p.feed(&json!({"type": "response.created", "response": {"id": "r1"}}), "").unwrap();
        let item = json!({"type": "message", "id": "msg_1", "role": "assistant", "content": [{"type": "output_text", "text": "CI is still running."}]});
        let c = p.feed(&json!({"type": "response.output_item.done", "output_index": 1, "item": item}), "").unwrap();
        assert_eq!(streamed_text(&c), "CI is still running.");
    }

    #[test]
    fn responses_stream_does_not_repeat_streamed_text_from_the_finished_item() {
        let mut p = ResponsesStreamParser::new("m".into());
        let mut all = vec![];
        all.extend(p.feed(&json!({"type": "response.output_text.delta", "item_id": "msg_1", "delta": "Hello"}), "").unwrap());
        all.extend(p.feed(&json!({"type": "response.output_text.done", "item_id": "msg_1", "text": "Hello"}), "").unwrap());
        let item = json!({"type": "message", "id": "msg_1", "content": [{"type": "output_text", "text": "Hello"}]});
        all.extend(p.feed(&json!({"type": "response.output_item.done", "item": item}), "").unwrap());
        assert_eq!(streamed_text(&all), "Hello");
    }

    #[test]
    fn responses_stream_keeps_text_sent_only_in_output_text_done() {
        let mut p = ResponsesStreamParser::new("m".into());
        let c = p.feed(&json!({"type": "response.output_text.done", "item_id": "msg_1", "text": "Done."}), "").unwrap();
        assert_eq!(streamed_text(&c), "Done.");
    }

    #[test]
    fn responses_stream_reads_usage_from_an_incomplete_response() {
        let mut p = ResponsesStreamParser::new("m".into());
        let ev = json!({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "usage": {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14}}});
        let c = p.feed(&ev, "").unwrap();
        assert!(c.iter().any(|c| c.usage.is_some()), "usage chunk missing");
    }

    /// Local SSE server: records request heads, answers with a Codex-style
    /// stream and a sticky `x-codex-turn-state` header.
    async fn codex_server(turn: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Default::default();
        let seen2 = seen.clone();
        tokio::spawn(async move {
            let mut n = 0;
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let mut got = 0;
                loop {
                    let k = s.read(&mut buf[got..]).await.unwrap();
                    got += k;
                    let text = String::from_utf8_lossy(&buf[..got]).to_string();
                    if let Some(h) = text.find("\r\n\r\n") {
                        let cl: usize = text[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                        if got >= h + 4 + cl || k == 0 {
                            seen2.lock().unwrap().push(text);
                            break;
                        }
                    }
                }
                n += 1;
                let body = concat!(
                    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\n",
                    "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc\",\"call_id\":\"c1\",\"name\":\"read\"}}\n\n",
                    "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"output_index\":0,\"delta\":\"{\\\"p\\\":\"}\n\n",
                    "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"output_index\":0,\"delta\":\"1}\"}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n",
                );
                let ts = format!("{turn}-{n}");
                let head = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nx-codex-turn-state: {ts}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                s.write_all(head.as_bytes()).await.unwrap();
                s.write_all(body.as_bytes()).await.unwrap();
                let _ = s.shutdown().await;
            }
        });
        (format!("http://{addr}"), seen)
    }

    #[tokio::test]
    async fn codex_turn_state_and_stream_assembly() {
        let (base, seen) = codex_server("tok").await;
        let turn = Arc::new(CodexTurn { turn_state: Default::default(), supports_reasoning_summary: true });
        let mut h = ResponsesHandler::new("gpt-5.4", &base, vec![("Authorization".into(), "Bearer t".into())], false);
        h.flavor = Flavor::Codex(turn.clone());
        let client = reqwest::Client::new();
        let mut kw = Kwargs::new();
        kw.insert("session_id".into(), json!("s1"));
        // Turn start: no sticky token sent; the first response's is captured.
        let msg = h.chat(&client, &[ChatMessage::system("sys"), ChatMessage::user("hi")], None, &kw, Some("gpt-5.4")).await.unwrap();
        let tc = &msg.tool_calls.as_ref().unwrap()[0];
        assert_eq!((tc.id.as_str(), tc.function.name.as_str(), tc.function.arguments.as_str()), ("c1", "read", "{\"p\":1}"));
        assert_eq!(msg.meta.extra.as_ref().unwrap()["usage"]["output"], 2);
        assert_eq!(turn.turn_state.lock().unwrap().as_deref(), Some("tok-1"));
        // Continuing the turn (tool result last): token echoed and not overwritten.
        let cont = vec![ChatMessage::user("hi"), ChatMessage::Assistant(msg.clone()), ChatMessage::tool("c1", Some("read".into()), "ok")];
        let s = h.stream(&client, &cont, None, &kw).await.unwrap();
        let _: Vec<_> = s.collect().await;
        assert_eq!(turn.turn_state.lock().unwrap().as_deref(), Some("tok-1"));
        // New user turn: token dropped, a fresh one captured.
        let s = h.stream(&client, &[ChatMessage::user("next")], None, &kw).await.unwrap();
        let _: Vec<_> = s.collect().await;
        assert_eq!(turn.turn_state.lock().unwrap().as_deref(), Some("tok-3"));
        let reqs = seen.lock().unwrap().clone();
        let has = |i: usize, h: &str| reqs[i].to_lowercase().contains(&h.to_lowercase());
        assert!(!has(0, "x-codex-turn-state") && has(1, "x-codex-turn-state: tok-1") && !has(2, "x-codex-turn-state"));
        assert!(has(0, "session-id: s1") && has(0, "x-codex-routing-hint: model=gpt-5.4"));
        assert!(reqs[0].contains("\"instructions\":\"sys\"") && reqs[0].contains("\"prompt_cache_key\":\"s1\""));
    }
}
