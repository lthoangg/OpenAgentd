//! Internal chat message and provider delta schemas — port of
//! `app/agent/schemas/chat.py`. These are NOT part of the public API.

use async_trait::async_trait;
use futures::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::pin::Pin;
use std::sync::Arc;

// ── Multimodal content blocks ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    #[serde(rename = "image_data")]
    /// Base64 bytes, shared: the agent copies its history into every request,
    /// and an image is usually the largest thing in it.
    ImageData { data: Arc<str>, media_type: String },
}

impl ContentBlock {
    pub fn text(s: impl Into<String>) -> Self {
        ContentBlock::Text { text: s.into() }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
    #[serde(default)]
    pub cached_tokens: Option<i64>,
    #[serde(default)]
    pub cache_write_tokens: Option<i64>,
    #[serde(default)]
    pub thoughts_tokens: Option<i64>,
    #[serde(default)]
    pub tool_use_tokens: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
    /// `bool | str | None` in v2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "function_type")]
    pub kind: String,
    pub function: FunctionCall,
}

fn function_type() -> String {
    "function".into()
}

impl ToolCall {
    pub fn new(id: impl Into<String>, name: impl Into<String>, arguments: impl Into<String>) -> Self {
        Self { id: id.into(), kind: "function".into(), function: FunctionCall { name: name.into(), arguments: arguments.into(), thought: None, thought_signature: None } }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FunctionCallDelta {
    pub name: Option<String>,
    pub arguments: Option<String>,
    pub thought: Option<Value>,
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolCallDelta {
    pub index: Option<i64>,
    pub id: Option<String>,
    pub function: Option<FunctionCallDelta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EncryptedReasoningItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub summary: Vec<Value>,
    pub encrypted_content: String,
}

// ── Messages ────────────────────────────────────────────────────────────────

/// Internal flags carried by every message (v2 `BaseMessage` exclude=True fields).
#[derive(Debug, Clone, PartialEq)]
pub struct MessageMeta {
    pub exclude_from_context: bool,
    /// chat | note | queued | summary | reverted
    pub kind: String,
    pub pinned: bool,
    pub extra: Option<Map<String, Value>>,
    /// hex/hyphenated uuid of the DB row, if persisted.
    pub db_id: Option<String>,
}

impl Default for MessageMeta {
    fn default() -> Self {
        Self { exclude_from_context: false, kind: "chat".into(), pinned: false, extra: None, db_id: None }
    }
}

impl MessageMeta {
    pub fn is_summary(&self) -> bool {
        self.kind == "summary"
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AssistantMessage {
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub reasoning_signature: Option<String>,
    pub redacted_thinking_blocks: Option<Vec<Value>>,
    pub raw_content_blocks: Option<Vec<Value>>,
    pub reasoning_items: Option<Vec<EncryptedReasoningItem>>,
    pub tool_calls: Option<Vec<ToolCall>>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub meta: MessageMeta,
}

impl AssistantMessage {
    /// v2 `_sync_reasoning_extra` validator.
    pub fn sync_reasoning_extra(&mut self) {
        if let Some(items) = &self.reasoning_items {
            if !items.is_empty() {
                let extra = self.meta.extra.get_or_insert_with(Map::new);
                extra.insert("reasoning_items".into(), Value::Array(items.iter().map(|i| serde_json::to_value(i).unwrap()).collect()));
                return;
            }
        }
        let Some(extra) = &self.meta.extra else { return };
        if let Some(Value::Array(raw)) = extra.get("reasoning_items") {
            let items: Vec<EncryptedReasoningItem> = raw.iter().filter(|v| v.get("encrypted_content").is_some()).filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
            if !items.is_empty() {
                self.reasoning_items = Some(items);
            }
        } else if let Some(Value::String(enc)) = extra.get("reasoning_encrypted_content") {
            if !enc.is_empty() {
                let id = extra.get("reasoning_item_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
                let summary = match &self.reasoning_content {
                    Some(r) if !r.is_empty() => vec![serde_json::json!({"type": "summary_text", "text": r})],
                    _ => vec![],
                };
                self.reasoning_items = Some(vec![EncryptedReasoningItem { id, summary, encrypted_content: enc.clone() }]);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatMessage {
    System { content: Option<String>, meta: MessageMeta },
    User { content: Option<String>, parts: Option<Vec<ContentBlock>>, meta: MessageMeta },
    Assistant(AssistantMessage),
    Tool { content: Option<String>, tool_call_id: String, name: Option<String>, parts: Option<Vec<ContentBlock>>, meta: MessageMeta },
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        ChatMessage::System { content: Some(content.into()), meta: MessageMeta::default() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        ChatMessage::User { content: Some(content.into()), parts: None, meta: MessageMeta::default() }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        ChatMessage::Assistant(AssistantMessage { content: Some(content.into()), ..Default::default() })
    }
    pub fn tool(tool_call_id: impl Into<String>, name: Option<String>, content: impl Into<String>) -> Self {
        ChatMessage::Tool { content: Some(content.into()), tool_call_id: tool_call_id.into(), name, parts: None, meta: MessageMeta::default() }
    }

    pub fn role(&self) -> &'static str {
        match self {
            ChatMessage::System { .. } => "system",
            ChatMessage::User { .. } => "user",
            ChatMessage::Assistant(_) => "assistant",
            ChatMessage::Tool { .. } => "tool",
        }
    }

    pub fn content(&self) -> Option<&str> {
        match self {
            ChatMessage::System { content, .. } | ChatMessage::User { content, .. } | ChatMessage::Tool { content, .. } => content.as_deref(),
            ChatMessage::Assistant(a) => a.content.as_deref(),
        }
    }

    pub fn set_content(&mut self, value: Option<String>) {
        match self {
            ChatMessage::System { content, .. } | ChatMessage::User { content, .. } | ChatMessage::Tool { content, .. } => *content = value,
            ChatMessage::Assistant(a) => a.content = value,
        }
    }

    pub fn meta(&self) -> &MessageMeta {
        match self {
            ChatMessage::System { meta, .. } | ChatMessage::User { meta, .. } | ChatMessage::Tool { meta, .. } => meta,
            ChatMessage::Assistant(a) => &a.meta,
        }
    }

    pub fn meta_mut(&mut self) -> &mut MessageMeta {
        match self {
            ChatMessage::System { meta, .. } | ChatMessage::User { meta, .. } | ChatMessage::Tool { meta, .. } => meta,
            ChatMessage::Assistant(a) => &mut a.meta,
        }
    }

    pub fn as_assistant(&self) -> Option<&AssistantMessage> {
        match self {
            ChatMessage::Assistant(a) => Some(a),
            _ => None,
        }
    }

    /// v2 `HumanMessage.text_content`.
    pub fn text_content(&self) -> Option<String> {
        if let ChatMessage::User { content, parts: Some(parts), .. } = self {
            if !parts.is_empty() {
                let texts: Vec<&str> = parts
                    .iter()
                    .filter_map(|p| match p {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                return if texts.is_empty() { content.clone() } else { Some(texts.join(" ")) };
            }
        }
        self.content().map(String::from)
    }
}

// ── Provider delta (internal streaming format) ──────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatCompletionDelta {
    pub role: Option<String>,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub reasoning_signature: Option<String>,
    pub redacted_thinking_block: Option<Value>,
    pub anthropic_raw_blocks: Option<Vec<Value>>,
    pub reasoning_item: Option<EncryptedReasoningItem>,
    pub tool_calls: Option<Vec<ToolCallDelta>>,
    /// Anthropic `stop_details` (`{type, category, explanation}`), sent with
    /// `stop_reason: "refusal"`.
    pub stop_details: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChunkChoice {
    pub index: i64,
    pub delta: ChatCompletionDelta,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatCompletionChunk {
    pub id: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<ChunkChoice>,
    pub usage: Option<Usage>,
    pub agent_name: Option<String>,
}

impl ChatCompletionChunk {
    pub fn delta(id: &str, model: &str, delta: ChatCompletionDelta, finish_reason: Option<String>, usage: Option<Usage>) -> Self {
        Self { id: id.to_string(), created: now_ts(), model: model.to_string(), choices: vec![ChunkChoice { index: 0, delta, finish_reason }], usage, agent_name: None }
    }
    pub fn usage_only(id: &str, model: &str, usage: Usage) -> Self {
        Self { id: id.to_string(), created: now_ts(), model: model.to_string(), choices: vec![], usage: Some(usage), agent_name: None }
    }
}

pub fn now_ts() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, thiserror::Error)]
pub enum ProviderError {
    /// HTTP status error (mirrors `httpx.HTTPStatusError`).
    #[error("{message}")]
    Http { status: u16, body: String, headers: Vec<(String, String)>, message: String },
    /// Transport-level failure worth retrying (mirrors `httpx.RequestError`).
    #[error("{0}")]
    Network(String),
    /// Transport failure that is NOT transient (bad URL, TLS cert, decoding).
    #[error("{0}")]
    NetworkPermanent(String),
    /// Provider has no usable credentials / model (`UnconfiguredProviderError`).
    #[error("{0}")]
    Unconfigured(String),
    /// Invalid configuration (`ValueError`).
    #[error("{0}")]
    Invalid(String),
    /// `ProviderAuthenticationError(message)` raised by a provider itself
    /// (e.g. an OAuth refresh that was rejected).
    #[error("{0}")]
    Auth(String),
    #[error("{0}")]
    Other(String),
}

impl ProviderError {
    pub fn status(&self) -> Option<u16> {
        match self {
            ProviderError::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        match self {
            ProviderError::Http { headers, .. } => headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()),
            _ => None,
        }
    }
    pub fn body(&self) -> &str {
        match self {
            ProviderError::Http { body, .. } => body,
            _ => "",
        }
    }
    pub fn from_reqwest(e: reqwest::Error) -> Self {
        if e.is_builder() || e.is_redirect() || e.is_decode() {
            ProviderError::NetworkPermanent(e.to_string())
        } else {
            ProviderError::Network(e.to_string())
        }
    }
    /// A failed read of a streamed response body. reqwest labels every such
    /// failure (connection reset, truncated chunk, timeout) "error decoding
    /// response body", but it is a dropped connection, so it is retryable.
    pub fn from_body_read(e: reqwest::Error) -> Self {
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(": ");
            msg.push_str(&s.to_string());
            src = s.source();
        }
        ProviderError::Network(msg)
    }
    /// Build an HTTP error matching httpx's message format.
    pub fn http(status: u16, url: &str, body: String, headers: Vec<(String, String)>) -> Self {
        let reason = reqwest::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("");
        let kind = if status >= 500 {
            "Server error"
        } else if status >= 400 {
            "Client error"
        } else {
            "Error"
        };
        let message = format!("{kind} '{status} {reason}' for url '{url}'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/{status}");
        ProviderError::Http { status, body, headers, message }
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;
pub type ChunkStream = Pin<Box<dyn Stream<Item = ProviderResult<ChatCompletionChunk>> + Send>>;

/// Merged provider kwargs (`named params → model_kwargs → call kwargs`).
pub type Kwargs = Map<String, Value>;

pub fn kw_str<'a>(kw: &'a Kwargs, key: &str) -> Option<&'a str> {
    kw.get(key).and_then(|v| v.as_str())
}

pub fn kw_i64(kw: &Kwargs, key: &str) -> Option<i64> {
    kw.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

/// Canonical tool definition as sent to providers:
/// `{"type":"function","function":{"name","description","parameters"}}`.
pub type ToolSpec = Value;

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Bare model id (`self.model`).
    fn model(&self) -> &str;
    /// Registry provider name set by the factory (`provider_name`).
    fn provider_name(&self) -> Option<&str>;
    /// Whether the loop may abort an in-flight stream on interrupt.
    fn support_interrupt(&self) -> bool {
        true
    }
    /// Provider-level kwargs (max_tokens + model_kwargs).
    fn base_kwargs(&self) -> &Kwargs;
    fn merged_kwargs(&self, call: &Kwargs) -> Kwargs {
        let mut m = self.base_kwargs().clone();
        for (k, v) in call {
            m.insert(k.clone(), v.clone());
        }
        m
    }
    /// Fully-qualified `provider:model` for cost lookups.
    fn cost_model_id(&self) -> Option<String> {
        match self.provider_name() {
            Some(p) if !p.is_empty() && !self.model().is_empty() => Some(format!("{p}:{}", self.model())),
            _ => Some(self.model().to_string()),
        }
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage>;
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream>;
}
