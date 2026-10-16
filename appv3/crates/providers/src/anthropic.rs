//! Anthropic Messages API — port of `providers/anthropic/anthropic.py`.

use crate::openai::shared_client;
use crate::registry::get_model_limits;
use crate::sse;
use crate::types::*;
use crate::usage::usage_to_dict;
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub const ANTHROPIC_API_BASE: &str = "https://api.anthropic.com";
pub const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS: i64 = 32000;

fn parse_args(s: &str) -> Value {
    if s.is_empty() {
        return json!({});
    }
    serde_json::from_str(s).unwrap_or(json!({}))
}

fn tool_use_block(tc: &ToolCall) -> Value {
    json!({"type": "tool_use", "id": tc.id, "name": tc.function.name, "input": parse_args(&tc.function.arguments)})
}

/// Append a streamed delta to a raw content block's string field in place.
/// Rebuilding the field (`cur + t`) copied the whole accumulated block on
/// every delta, which is quadratic over a long thinking or text block.
fn append_block_text(block: &mut Value, key: &str, text: &str) {
    match block.get_mut(key) {
        Some(Value::String(s)) => s.push_str(text),
        _ => block[key] = Value::String(text.to_string()),
    }
}

fn image_blocks(parts: &[ContentBlock]) -> Vec<Value> {
    let mut blocks = vec![];
    for p in parts {
        match p {
            ContentBlock::Text { text } => {
                if !text.is_empty() {
                    blocks.push(json!({"type": "text", "text": text}));
                }
            }
            ContentBlock::ImageUrl { url, media_type, .. } => {
                let mut src = Map::new();
                src.insert("type".into(), json!("url"));
                src.insert("url".into(), json!(url));
                if let Some(mt) = media_type {
                    src.insert("media_type".into(), json!(mt));
                }
                blocks.push(json!({"type": "image", "source": src}));
            }
            ContentBlock::ImageData { data, media_type } => {
                blocks.push(json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}));
            }
        }
    }
    blocks
}

fn blocks_from_raw(a: &AssistantMessage, valid: &HashSet<String>) -> Vec<Value> {
    let by_id: HashMap<&str, &ToolCall> = a.tool_calls.iter().flatten().filter(|t| !t.id.is_empty()).map(|t| (t.id.as_str(), t)).collect();
    let mut blocks = vec![];
    for raw in a.raw_content_blocks.iter().flatten() {
        match raw.get("type").and_then(|v| v.as_str()) {
            Some("thinking") => {
                let sig = raw.get("signature").and_then(|v| v.as_str()).unwrap_or("");
                if !sig.is_empty() {
                    blocks.push(json!({"type": "thinking", "thinking": raw.get("thinking").and_then(|v| v.as_str()).unwrap_or(""), "signature": sig}));
                }
            }
            Some("redacted_thinking") => blocks.push(json!({"type": "redacted_thinking", "data": raw.get("data").cloned().unwrap_or(json!(""))})),
            Some("text") => {
                if let Some(t) = raw.get("text").and_then(|v| v.as_str()).filter(|t| !t.is_empty()) {
                    blocks.push(json!({"type": "text", "text": t}));
                }
            }
            Some("tool_use_ref") => {
                let id = raw.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(tc) = by_id.get(id) {
                    if valid.contains(&tc.id) {
                        blocks.push(tool_use_block(tc));
                    }
                }
            }
            Some("tool_use") => {
                let id = raw.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() || !valid.contains(id) {
                    continue;
                }
                match by_id.get(id) {
                    Some(tc) => blocks.push(tool_use_block(tc)),
                    None => blocks.push(raw.clone()),
                }
            }
            _ => {}
        }
    }
    blocks
}

/// v2 `_split_messages` → (system blocks, messages).
pub fn split_messages(messages: &[ChatMessage]) -> (Option<Vec<Value>>, Vec<Value>) {
    let valid: HashSet<String> = messages
        .iter()
        .filter_map(|m| match m {
            ChatMessage::Tool { tool_call_id, .. } if !tool_call_id.is_empty() => Some(tool_call_id.clone()),
            _ => None,
        })
        .collect();
    let mut system_parts: Vec<String> = vec![];
    let mut out: Vec<Value> = vec![];
    for msg in messages {
        match msg {
            ChatMessage::System { content, .. } => {
                if let Some(c) = content.as_ref().filter(|c| !c.is_empty()) {
                    system_parts.push(c.clone());
                }
            }
            ChatMessage::User { content, parts, .. } => {
                let content = content.clone().unwrap_or_default();
                if let Some(parts) = parts.as_ref().filter(|p| !p.is_empty()) {
                    let blocks = image_blocks(parts);
                    if blocks.is_empty() && content.is_empty() {
                        continue;
                    }
                    let c = if blocks.is_empty() { vec![json!({"type": "text", "text": content})] } else { blocks };
                    out.push(json!({"role": "user", "content": c}));
                } else {
                    if content.is_empty() {
                        continue;
                    }
                    out.push(json!({"role": "user", "content": [{"type": "text", "text": content}]}));
                }
            }
            ChatMessage::Assistant(a) if a.raw_content_blocks.as_ref().map(|b| !b.is_empty()).unwrap_or(false) => {
                let blocks = blocks_from_raw(a, &valid);
                if !blocks.is_empty() {
                    out.push(json!({"role": "assistant", "content": blocks}));
                }
            }
            ChatMessage::Assistant(a) if a.tool_calls.as_ref().map(|t| !t.is_empty()).unwrap_or(false) => {
                let mut blocks = vec![];
                if let (Some(r), Some(s)) = (a.reasoning_content.as_ref().filter(|x| !x.is_empty()), a.reasoning_signature.as_ref().filter(|x| !x.is_empty())) {
                    blocks.push(json!({"type": "thinking", "thinking": r, "signature": s}));
                }
                if let Some(r) = &a.redacted_thinking_blocks {
                    blocks.extend(r.iter().cloned());
                }
                if let Some(c) = a.content.as_ref().filter(|c| !c.is_empty()) {
                    blocks.push(json!({"type": "text", "text": c}));
                }
                for tc in a.tool_calls.iter().flatten() {
                    if valid.contains(&tc.id) {
                        blocks.push(tool_use_block(tc));
                    }
                }
                if !blocks.is_empty() {
                    out.push(json!({"role": "assistant", "content": blocks}));
                }
            }
            ChatMessage::Assistant(a) => {
                let content = a.content.clone().unwrap_or_default();
                let redacted: Vec<Value> = a.redacted_thinking_blocks.clone().unwrap_or_default();
                if let (Some(r), Some(s)) = (a.reasoning_content.as_ref().filter(|x| !x.is_empty()), a.reasoning_signature.as_ref().filter(|x| !x.is_empty())) {
                    let mut c = vec![json!({"type": "thinking", "thinking": r, "signature": s})];
                    c.extend(redacted);
                    if !content.is_empty() {
                        c.push(json!({"type": "text", "text": content}));
                    }
                    out.push(json!({"role": "assistant", "content": c}));
                    continue;
                }
                if a.redacted_thinking_blocks.is_some() && !redacted.is_empty() {
                    let mut c = redacted;
                    if !content.is_empty() {
                        c.push(json!({"type": "text", "text": content}));
                    }
                    out.push(json!({"role": "assistant", "content": c}));
                    continue;
                }
                if content.is_empty() {
                    continue;
                }
                out.push(json!({"role": "assistant", "content": [{"type": "text", "text": content}]}));
            }
            ChatMessage::Tool { content, tool_call_id, parts, .. } => {
                let text = content.clone().unwrap_or_default();
                let mut tool_content = json!(text);
                if let Some(parts) = parts.as_ref().filter(|p| !p.is_empty()) {
                    let blocks = image_blocks(parts);
                    if !blocks.is_empty() {
                        tool_content = json!(blocks);
                    }
                }
                let mut rb = Map::new();
                rb.insert("type".into(), json!("tool_result"));
                rb.insert("tool_use_id".into(), json!(tool_call_id));
                rb.insert("content".into(), tool_content);
                if text.starts_with("Error:") {
                    rb.insert("is_error".into(), json!(true));
                }
                let merge = out.last().map(|l| l["role"] == "user" && l["content"].as_array().map(|c| !c.is_empty() && c[0]["type"] == "tool_result").unwrap_or(false));
                if merge == Some(true) {
                    out.last_mut().unwrap()["content"].as_array_mut().unwrap().push(Value::Object(rb));
                } else {
                    out.push(json!({"role": "user", "content": [Value::Object(rb)]}));
                }
            }
        }
    }
    let system_text = system_parts.join("\n\n");
    let system = if system_text.is_empty() { None } else { Some(vec![json!({"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}})]) };
    if !out.is_empty() && matches!(messages.last(), Some(ChatMessage::Assistant(_))) {
        let last = out.last_mut().unwrap();
        if last["role"] == "assistant" {
            if let Some(c) = last["content"].as_array() {
                let sanitized: Vec<Value> = c.iter().filter(|b| !matches!(b["type"].as_str(), Some("thinking") | Some("redacted_thinking"))).cloned().collect();
                if sanitized.is_empty() {
                    out.pop();
                } else {
                    last["content"] = json!(sanitized);
                }
            }
        }
    }
    if let Some(last) = out.last_mut() {
        if let Some(c) = last["content"].as_array_mut() {
            if let Some(fb) = c.last_mut() {
                if matches!(fb["type"].as_str(), Some("text") | Some("tool_result")) {
                    fb["cache_control"] = json!({"type": "ephemeral"});
                }
            }
        }
    }
    (system, out)
}

pub fn anthropic_tools(tools: Option<&[ToolSpec]>) -> Option<Vec<Value>> {
    let out: Vec<Value> = tools
        .unwrap_or(&[])
        .iter()
        .filter_map(|t| t.get("function").filter(|f| f.is_object()))
        .map(|f| {
            json!({
                "name": f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "description": f.get("description").cloned().unwrap_or(json!("")),
                "input_schema": f.get("parameters").filter(|p| !p.is_null() && p.as_object().map(|o| !o.is_empty()).unwrap_or(true)).cloned().unwrap_or(json!({"type": "object", "properties": {}})),
            })
        })
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn model_name(model: &str) -> String {
    let l = model.to_lowercase();
    l.strip_prefix("anthropic.").map(String::from).unwrap_or(l)
}

fn uses_adaptive(model: &str) -> bool {
    let n = model_name(model);
    ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-fable-5", "claude-mythos"]
        .iter()
        .any(|p| n.starts_with(p))
}

fn thinking_budget(level: &str, max_tokens: i64) -> i64 {
    let ratio = match level {
        "low" => 0.25,
        "medium" => 0.4,
        "high" => 0.6,
        "xhigh" => 0.75,
        "max" => 0.8,
        _ => 0.4,
    };
    let budget = (max_tokens as f64 * ratio) as i64;
    1024.max(budget.min(max_tokens - 1))
}

fn apply_thinking(model: &str, kw: &Kwargs, payload: &mut Map<String, Value>) -> bool {
    let level = kw_str(kw, "thinking_level").unwrap_or("").to_lowercase();
    if level.is_empty() {
        return false;
    }
    let n = model_name(model);
    if level == "none" || level == "off" {
        if n.starts_with("claude-sonnet-5") {
            payload.insert("thinking".into(), json!({"type": "disabled"}));
        }
        return false;
    }
    if uses_adaptive(model) {
        payload.insert("thinking".into(), json!({"type": "adaptive", "display": "summarized"}));
        payload.insert("output_config".into(), json!({"effort": level}));
        return true;
    }
    let max_tokens = payload["max_tokens"].as_i64().unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
    payload.insert("thinking".into(), json!({"type": "enabled", "budget_tokens": thinking_budget(&level, max_tokens), "display": "summarized"}));
    if n.starts_with("claude-opus-4-5") {
        payload.insert("output_config".into(), json!({"effort": level}));
    }
    true
}

fn finish_reason(stop: Option<&str>) -> Option<String> {
    stop.map(|s| if s == "tool_use" { "tool_calls".to_string() } else { s.to_string() })
}

/// `stop_details` of a `message_delta` (sent with `stop_reason: "refusal"`):
/// on the delta, or top-level on older shapes.
fn stop_details(event: &Value) -> Option<Value> {
    event.pointer("/delta/stop_details").or_else(|| event.get("stop_details")).filter(|v| v.is_object()).cloned()
}

fn prompt_usage(raw: &Value) -> (i64, Option<i64>, Option<i64>) {
    let g = |k: &str| raw.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let (nc, cr, cw) = (g("input_tokens"), g("cache_read_input_tokens"), g("cache_creation_input_tokens"));
    (nc + cr + cw, Some(cr).filter(|n| *n != 0), Some(cw).filter(|n| *n != 0))
}

fn stream_error(event: &Value, raw: &str) -> ProviderError {
    let err = event.get("error").filter(|e| e.is_object()).cloned().unwrap_or(json!({}));
    let etype = err.get("type").and_then(|v| v.as_str()).unwrap_or("api_error").to_string();
    let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("stream error").to_string();
    let status = match etype.as_str() {
        "invalid_request_error" => 400,
        "authentication_error" => 401,
        "permission_error" => 403,
        "not_found_error" => 404,
        "request_too_large" => 413,
        "rate_limit_error" => 429,
        "api_error" => 500,
        "overloaded_error" => 529,
        _ => 500,
    };
    ProviderError::Http {
        status,
        body: raw.to_string(),
        headers: vec![("content-type".into(), "application/json".into())],
        message: format!("Anthropic stream error (HTTP {status}): {etype}: {msg}"),
    }
}

pub struct AnthropicProvider {
    pub model: String,
    pub provider_name: Option<String>,
    pub base_url: String,
    pub base_kwargs: Kwargs,
    headers: std::sync::RwLock<Vec<(String, String)>>,
    /// Always use `/v1/messages?beta=true` (v2 `beta=True`).
    pub beta: bool,
    /// Request timeout; `None` = no timeout (v2 `timeout=None`).
    pub timeout: Option<Duration>,
    client: reqwest::Client,
}

/// v2 `_headers(api_key, extra, use_api_key_header=...)`.
pub fn build_headers(api_key: &str, extra: &[(String, String)], use_api_key_header: bool) -> Vec<(String, String)> {
    let mut h: Vec<(String, String)> = vec![("anthropic-version".into(), ANTHROPIC_API_VERSION.into()), ("content-type".into(), "application/json".into())];
    for (k, v) in extra {
        match h.iter_mut().find(|(hk, _)| hk == k) {
            Some(slot) => slot.1 = v.clone(),
            None => h.push((k.clone(), v.clone())),
        }
    }
    if use_api_key_header {
        match h.iter_mut().find(|(hk, _)| hk == "x-api-key") {
            Some(slot) => slot.1 = api_key.to_string(),
            None => h.push(("x-api-key".into(), api_key.to_string())),
        }
    }
    h
}

impl AnthropicProvider {
    pub fn new(api_key: &str, model: &str, base_url: &str, model_kwargs: Kwargs) -> ProviderResult<Self> {
        Self::with_options(api_key, model, base_url, model_kwargs, &[], true, false, Some(Duration::from_secs(120)))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_options(
        api_key: &str,
        model: &str,
        base_url: &str,
        model_kwargs: Kwargs,
        extra_headers: &[(String, String)],
        use_api_key_header: bool,
        beta: bool,
        timeout: Option<Duration>,
    ) -> ProviderResult<Self> {
        if api_key.is_empty() {
            return Err(ProviderError::Invalid("Anthropic API key is required. Set ANTHROPIC_API_KEY.".into()));
        }
        Ok(Self {
            model: model.into(),
            provider_name: None,
            base_url: base_url.trim_end_matches('/').into(),
            base_kwargs: model_kwargs,
            headers: std::sync::RwLock::new(build_headers(api_key, extra_headers, use_api_key_header)),
            beta,
            timeout,
            client: shared_client(),
        })
    }

    /// Replace the request headers (OAuth plugins refresh them per call).
    pub fn set_headers(&self, headers: Vec<(String, String)>) {
        *self.headers.write().unwrap() = headers;
    }

    fn max_output_default(&self) -> i64 {
        get_model_limits(Some(&format!("anthropic:{}", model_name(&self.model)))).max_completion_tokens.unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
    }

    pub fn payload(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kw: &Kwargs) -> Value {
        let (system, msgs) = split_messages(messages);
        let limits = get_model_limits(Some(&format!("anthropic:{}", self.model)));
        let max_tokens = match kw_i64(kw, "max_tokens") {
            Some(r) => match limits.max_completion_tokens {
                Some(l) => r.min(l),
                None => r,
            },
            None => self.max_output_default(),
        };
        let mut p = Map::new();
        p.insert("model".into(), json!(self.model));
        p.insert("messages".into(), Value::Array(msgs));
        p.insert("max_tokens".into(), json!(max_tokens));
        if let Some(s) = system {
            p.insert("system".into(), json!(s));
        }
        if let Some(t) = anthropic_tools(tools) {
            p.insert("tools".into(), json!(t));
            match kw.get("tool_choice") {
                Some(Value::String(s)) if s == "none" => {
                    p.insert("tool_choice".into(), json!({"type": "none"}));
                }
                Some(v) if !v.is_null() => {
                    p.insert("tool_choice".into(), v.clone());
                }
                _ => {}
            }
        }
        if let Some(tier) = kw_str(kw, "service_tier").filter(|s| !s.is_empty()) {
            if self.base_url.contains("api.anthropic.com") {
                p.insert("service_tier".into(), json!(if tier == "fast" { "auto" } else { tier }));
            }
        }
        apply_thinking(&self.model, kw, &mut p);
        Value::Object(p)
    }

    fn path(&self, kw: &Kwargs) -> String {
        let beta = kw.get("anthropic_beta").map(|v| !v.is_null() && v != &json!(false) && v != &json!("")).unwrap_or(false);
        if beta || self.beta {
            "/v1/messages?beta=true".into()
        } else {
            "/v1/messages".into()
        }
    }

    fn request(&self, url: &str, body: &Value) -> reqwest::RequestBuilder {
        // Headers before `json()`, which would otherwise add a second Content-Type.
        let mut r = self.client.post(url);
        for (k, v) in self.headers.read().unwrap().iter() {
            r = r.header(k, v);
        }
        r.json(body)
    }

    pub fn parse_response(&self, data: &Value) -> AssistantMessage {
        let blocks = data.get("content").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let join = |t: &str, k: &str| blocks.iter().filter(|b| b["type"] == t).map(|b| b.get(k).and_then(|v| v.as_str()).unwrap_or("")).collect::<String>();
        let text = join("text", "text");
        let reasoning = join("thinking", "thinking");
        let sig = join("thinking", "signature");
        let redacted: Vec<Value> =
            blocks.iter().filter(|b| b["type"] == "redacted_thinking").map(|b| json!({"type": "redacted_thinking", "data": b.get("data").cloned().unwrap_or(json!(""))})).collect();
        let tcs: Vec<ToolCall> = blocks
            .iter()
            .filter(|b| b["type"] == "tool_use")
            .map(|b| {
                ToolCall::new(
                    b["id"].as_str().unwrap_or(""),
                    b["name"].as_str().unwrap_or(""),
                    b.get("input").filter(|v| !v.is_null()).map(Value::to_string).unwrap_or_else(|| "{}".into()),
                )
            })
            .collect();
        let raw: Vec<Value> = blocks
            .iter()
            .filter_map(|b| match b["type"].as_str() {
                Some("thinking") => {
                    Some(json!({"type": "thinking", "thinking": b.get("thinking").cloned().unwrap_or(json!("")), "signature": b.get("signature").cloned().unwrap_or(json!(""))}))
                }
                Some("redacted_thinking") => Some(json!({"type": "redacted_thinking", "data": b.get("data").cloned().unwrap_or(json!(""))})),
                Some("text") => Some(json!({"type": "text", "text": b.get("text").cloned().unwrap_or(json!(""))})),
                Some("tool_use") => Some(json!({"type": "tool_use_ref", "id": b["id"].as_str().unwrap_or("")})),
                _ => None,
            })
            .collect();
        let mut a = AssistantMessage {
            content: Some(text).filter(|s| !s.is_empty()),
            reasoning_content: Some(reasoning).filter(|s| !s.is_empty()),
            reasoning_signature: Some(sig).filter(|s| !s.is_empty()),
            tool_calls: if tcs.is_empty() { None } else { Some(tcs) },
            redacted_thinking_blocks: if redacted.is_empty() { None } else { Some(redacted) },
            raw_content_blocks: if raw.is_empty() { None } else { Some(raw) },
            ..Default::default()
        };
        if let Some(u) = data.get("usage").filter(|u| u.is_object()) {
            let (pt, cr, cw) = prompt_usage(u);
            let ct = u.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let usage = Usage { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, cached_tokens: cr, cache_write_tokens: cw, ..Default::default() };
            let mut extra = Map::new();
            extra.insert("usage".into(), usage_to_dict(&usage, self.cost_model_id().as_deref()));
            a.meta.extra = Some(extra);
        }
        a
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
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
        let body = self.payload(messages, tools, &merged);
        let url = format!("{}{}", self.base_url, self.path(&merged));
        let mut req = self.request(&url, &body);
        if let Some(t) = self.timeout {
            req = req.timeout(t);
        }
        let resp = sse::send_checked(req, "anthropic_chat").await?;
        let data: Value = resp.json().await.map_err(ProviderError::from_reqwest)?;
        Ok(self.parse_response(&data))
    }

    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        let merged = self.merged_kwargs(kwargs);
        let mut body = self.payload(messages, tools, &merged);
        body["stream"] = json!(true);
        let url = format!("{}{}", self.base_url, self.path(&merged));
        // httpx timeouts bound each read, not the whole stream.
        let resp = sse::send_stream(self.request(&url, &body), self.timeout, "anthropic_stream").await?;
        let model = self.model.clone();
        let chunk_id = format!("anthropic-{}", now_ts());
        let lines = sse::lines_idle(resp, self.timeout);
        let s = async_stream::stream! {
            futures::pin_mut!(lines);
            let mut usage = Usage::default();
            let mut tool_idx: HashMap<i64, i64> = HashMap::new();
            let mut raw_blocks: HashMap<i64, Value> = HashMap::new();
            let mut order: Vec<i64> = vec![];
            let mk = |delta: ChatCompletionDelta, usage: Option<Usage>, fr: Option<String>| ChatCompletionChunk::delta(&chunk_id, &model, delta, fr, usage);
            while let Some(line) = lines.next().await {
                let line = match line { Ok(l) => l, Err(e) => { yield Err(e); return; } };
                let Some(raw) = line.strip_prefix("data: ") else { continue };
                if raw == "[DONE]" { break; }
                let event: Value = match serde_json::from_str(raw) {
                    Ok(v) => v,
                    Err(e) => { yield Err(ProviderError::Other(format!("{e}"))); return; }
                };
                let et = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if et == "error" { yield Err(stream_error(&event, raw)); return; }
                match et {
                    "message_start" => {
                        if let Some(u) = event.pointer("/message/usage").filter(|u| u.is_object()) {
                            let (pt, cr, cw) = prompt_usage(u);
                            usage.prompt_tokens = pt; usage.cached_tokens = cr; usage.cache_write_tokens = cw;
                        }
                    }
                    "content_block_start" => {
                        let cb = &event["content_block"];
                        if !cb.is_object() { continue; }
                        let bi = event.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                        match cb["type"].as_str() {
                            Some("redacted_thinking") => {
                                let b = json!({"type": "redacted_thinking", "data": cb.get("data").cloned().unwrap_or(json!(""))});
                                raw_blocks.insert(bi, b.clone()); order.push(bi);
                                yield Ok(mk(ChatCompletionDelta { redacted_thinking_block: Some(b), ..Default::default() }, None, None));
                            }
                            Some("thinking") => { raw_blocks.insert(bi, json!({"type": "thinking", "thinking": "", "signature": ""})); order.push(bi); }
                            Some("text") => { raw_blocks.insert(bi, json!({"type": "text", "text": ""})); order.push(bi); }
                            Some("tool_use") => {
                                let id = cb.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                raw_blocks.insert(bi, json!({"type": "tool_use_ref", "id": id})); order.push(bi);
                                let n = tool_idx.len() as i64;
                                let ti = *tool_idx.entry(bi).or_insert(n);
                                yield Ok(mk(ChatCompletionDelta { tool_calls: Some(vec![ToolCallDelta { index: Some(ti), id: Some(id),
                                    function: Some(FunctionCallDelta { name: Some(cb.get("name").and_then(|v| v.as_str()).unwrap_or("").into()), arguments: Some(String::new()), ..Default::default() }) }]), ..Default::default() }, None, None));
                            }
                            _ => {}
                        }
                    }
                    "message_delta" => {
                        let stop = event.pointer("/delta/stop_reason").and_then(|v| v.as_str());
                        if let Some(u) = event.get("usage").filter(|u| u.is_object()) {
                            usage.completion_tokens = u.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                            usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
                        }
                        let delta = ChatCompletionDelta { stop_details: stop_details(&event), ..Default::default() };
                        yield Ok(mk(delta, Some(usage.clone()), finish_reason(stop)));
                    }
                    _ => {
                        let Some(delta) = event.get("delta").filter(|d| d.is_object()) else { continue };
                        let dt = delta.get("type").and_then(|v| v.as_str());
                        let bi = event.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                        if let Some(t) = delta.get("thinking").and_then(|v| v.as_str()) {
                            if let Some(b) = raw_blocks.get_mut(&bi).filter(|b| b["type"] == "thinking") {
                                append_block_text(b, "thinking", t);
                            }
                            yield Ok(mk(ChatCompletionDelta { reasoning_content: Some(t.into()), ..Default::default() }, None, None));
                        } else if dt == Some("signature_delta") && delta.get("signature").map(|v| v.is_string()).unwrap_or(false) {
                            let s = delta["signature"].as_str().unwrap();
                            if let Some(b) = raw_blocks.get_mut(&bi).filter(|b| b["type"] == "thinking") {
                                append_block_text(b, "signature", s);
                            }
                            yield Ok(mk(ChatCompletionDelta { reasoning_signature: Some(s.into()), ..Default::default() }, None, None));
                        } else if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                            if let Some(b) = raw_blocks.get_mut(&bi).filter(|b| b["type"] == "text") {
                                append_block_text(b, "text", t);
                            }
                            yield Ok(mk(ChatCompletionDelta { content: Some(t.into()), ..Default::default() }, None, None));
                        } else if dt == Some("input_json_delta") && delta.get("partial_json").map(|v| v.is_string()).unwrap_or(false) {
                            let n = tool_idx.len() as i64;
                            let ti = *tool_idx.entry(bi).or_insert(n);
                            yield Ok(mk(ChatCompletionDelta { tool_calls: Some(vec![ToolCallDelta { index: Some(ti), id: None,
                                function: Some(FunctionCallDelta { arguments: Some(delta["partial_json"].as_str().unwrap().into()), ..Default::default() }) }]), ..Default::default() }, None, None));
                        }
                    }
                }
            }
            if !order.is_empty() {
                let blocks: Vec<Value> = order.iter().filter_map(|i| raw_blocks.remove(i)).collect();
                yield Ok(mk(ChatCompletionDelta { anthropic_raw_blocks: Some(blocks), ..Default::default() }, None, None));
            }
        };
        Ok(Box::pin(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_sends_one_content_type() {
        let p = AnthropicProvider::new("k", "claude-x", "http://127.0.0.1:1", Kwargs::new()).unwrap();
        let req = p.request("http://127.0.0.1:1/v1/messages", &json!({})).build().unwrap();
        assert_eq!(req.headers().get_all(reqwest::header::CONTENT_TYPE).iter().count(), 1);
    }

    #[test]
    fn split_merges_tool_results_and_marks_cache() {
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::user("hi"),
            ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("t1", "a", "{\"x\":1}"), ToolCall::new("t2", "b", "")]), ..Default::default() }),
            ChatMessage::tool("t1", None, "ok"),
            ChatMessage::tool("t2", None, "Error: bad"),
        ];
        let (sys, out) = split_messages(&msgs);
        assert_eq!(sys.unwrap()[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(out.len(), 3);
        assert_eq!(out[1]["content"][0]["input"], json!({"x": 1}));
        let results = out[2]["content"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[1]["is_error"], true);
        assert_eq!(results[1]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn thinking_budget_matches_v2() {
        assert_eq!(thinking_budget("low", 32000), 8000);
        assert_eq!(thinking_budget("high", 1000), 1024);
    }

    #[test]
    fn streamed_text_appends_onto_the_raw_block() {
        let mut block = json!({"type": "thinking", "thinking": "", "signature": ""});
        for part in ["Let ", "me ", "think."] {
            append_block_text(&mut block, "thinking", part);
        }
        append_block_text(&mut block, "signature", "sig");
        assert_eq!(block, json!({"type": "thinking", "thinking": "Let me think.", "signature": "sig"}));

        // A field the start event did not create starts empty.
        let mut text = json!({"type": "text"});
        append_block_text(&mut text, "text", "hi");
        assert_eq!(text["text"], "hi");
    }

    #[test]
    fn tool_use_input_becomes_compact_utf8_arguments() {
        let p = AnthropicProvider::new("k", "claude-sonnet-4-5", "http://127.0.0.1:9", Kwargs::new()).unwrap();
        let msg = p.parse_response(&json!({"content": [{"type": "tool_use", "id": "t1", "name": "patch", "input": {"note": "Cài đặt ✓", "n": 1}}]}));
        assert_eq!(msg.tool_calls.unwrap()[0].function.arguments, r#"{"note":"Cài đặt ✓","n":1}"#);
    }

    #[test]
    fn refusal_message_delta_carries_stop_details() {
        let details = json!({"type": "refusal", "category": "cyber", "explanation": "Declined."});
        let on_delta = json!({"type": "message_delta", "delta": {"stop_reason": "refusal", "stop_details": details}});
        assert_eq!(stop_details(&on_delta), Some(details.clone()));
        let top_level = json!({"type": "message_delta", "delta": {"stop_reason": "refusal"}, "stop_details": details});
        assert_eq!(stop_details(&top_level), Some(details));
        // Category and explanation may be null; the object still comes through.
        let nulls = json!({"delta": {"stop_details": {"type": "refusal", "category": null, "explanation": null}}});
        assert_eq!(stop_details(&nulls).unwrap()["type"], "refusal");
        assert_eq!(stop_details(&json!({"delta": {"stop_reason": "end_turn", "stop_details": null}})), None);
    }
}
