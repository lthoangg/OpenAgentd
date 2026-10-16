//! JSON form of the internal chat schema, as seen by JS plugins (snake_case,
//! the v2 pydantic field names). Round-trips losslessly: optional fields are
//! omitted when `None`; `meta` is present only when it differs from the default.

use crate::types::*;
use serde_json::{json, Map, Value};

fn meta_to_json(m: &MessageMeta) -> Option<Value> {
    if *m == MessageMeta::default() {
        return None;
    }
    Some(json!({"exclude_from_context": m.exclude_from_context, "kind": m.kind, "pinned": m.pinned, "extra": m.extra, "db_id": m.db_id}))
}

fn meta_from_json(v: Option<&Value>) -> MessageMeta {
    let mut m = MessageMeta::default();
    let Some(o) = v.and_then(|v| v.as_object()) else { return m };
    if let Some(b) = o.get("exclude_from_context").and_then(|x| x.as_bool()) {
        m.exclude_from_context = b;
    }
    if let Some(k) = o.get("kind").and_then(|x| x.as_str()) {
        m.kind = k.to_string();
    }
    if let Some(b) = o.get("pinned").and_then(|x| x.as_bool()) {
        m.pinned = b;
    }
    m.extra = o.get("extra").and_then(|x| x.as_object()).cloned();
    m.db_id = o.get("db_id").and_then(|x| x.as_str()).map(String::from);
    m
}

fn put<T: serde::Serialize>(o: &mut Map<String, Value>, k: &str, v: &Option<T>) {
    if let Some(v) = v {
        o.insert(k.into(), serde_json::to_value(v).unwrap_or(Value::Null));
    }
}

fn opt_str(o: &Map<String, Value>, k: &str) -> Option<String> {
    o.get(k).and_then(|x| x.as_str()).map(String::from)
}

fn opt_de<T: serde::de::DeserializeOwned>(o: &Map<String, Value>, k: &str) -> Result<Option<T>, String> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| format!("invalid '{k}': {e}")),
    }
}

pub fn assistant_to_json(a: &AssistantMessage) -> Value {
    let mut o = Map::new();
    o.insert("role".into(), json!("assistant"));
    o.insert("content".into(), json!(a.content));
    put(&mut o, "reasoning_content", &a.reasoning_content);
    put(&mut o, "reasoning_signature", &a.reasoning_signature);
    put(&mut o, "redacted_thinking_blocks", &a.redacted_thinking_blocks);
    put(&mut o, "raw_content_blocks", &a.raw_content_blocks);
    put(&mut o, "reasoning_items", &a.reasoning_items);
    put(&mut o, "tool_calls", &a.tool_calls);
    put(&mut o, "agent_id", &a.agent_id);
    put(&mut o, "agent_name", &a.agent_name);
    if let Some(m) = meta_to_json(&a.meta) {
        o.insert("meta".into(), m);
    }
    Value::Object(o)
}

pub fn assistant_from_json(v: &Value) -> Result<AssistantMessage, String> {
    let o = v.as_object().ok_or("assistant message must be an object")?;
    Ok(AssistantMessage {
        content: opt_str(o, "content"),
        reasoning_content: opt_str(o, "reasoning_content"),
        reasoning_signature: opt_str(o, "reasoning_signature"),
        redacted_thinking_blocks: opt_de(o, "redacted_thinking_blocks")?,
        raw_content_blocks: opt_de(o, "raw_content_blocks")?,
        reasoning_items: opt_de(o, "reasoning_items")?,
        tool_calls: opt_de(o, "tool_calls")?,
        agent_id: opt_str(o, "agent_id"),
        agent_name: opt_str(o, "agent_name"),
        meta: meta_from_json(o.get("meta")),
    })
}

pub fn message_to_json(m: &ChatMessage) -> Value {
    let (mut o, meta) = match m {
        ChatMessage::Assistant(a) => return assistant_to_json(a),
        ChatMessage::System { content, meta } => {
            let mut o = Map::new();
            o.insert("role".into(), json!("system"));
            o.insert("content".into(), json!(content));
            (o, meta)
        }
        ChatMessage::User { content, parts, meta } => {
            let mut o = Map::new();
            o.insert("role".into(), json!("user"));
            o.insert("content".into(), json!(content));
            put(&mut o, "parts", parts);
            (o, meta)
        }
        ChatMessage::Tool { content, tool_call_id, name, parts, meta } => {
            let mut o = Map::new();
            o.insert("role".into(), json!("tool"));
            o.insert("content".into(), json!(content));
            o.insert("tool_call_id".into(), json!(tool_call_id));
            put(&mut o, "name", name);
            put(&mut o, "parts", parts);
            (o, meta)
        }
    };
    if let Some(mj) = meta_to_json(meta) {
        o.insert("meta".into(), mj);
    }
    Value::Object(o)
}

pub fn message_from_json(v: &Value) -> Result<ChatMessage, String> {
    let o = v.as_object().ok_or("message must be an object")?;
    let meta = meta_from_json(o.get("meta"));
    Ok(match o.get("role").and_then(|r| r.as_str()) {
        Some("system") => ChatMessage::System { content: opt_str(o, "content"), meta },
        Some("user") => ChatMessage::User { content: opt_str(o, "content"), parts: opt_de(o, "parts")?, meta },
        Some("assistant") => ChatMessage::Assistant(assistant_from_json(v)?),
        Some("tool") => ChatMessage::Tool {
            content: opt_str(o, "content"),
            tool_call_id: opt_str(o, "tool_call_id").unwrap_or_default(),
            name: opt_str(o, "name"),
            parts: opt_de(o, "parts")?,
            meta,
        },
        other => return Err(format!("unknown message role {other:?}")),
    })
}

pub fn messages_to_json(ms: &[ChatMessage]) -> Value {
    Value::Array(ms.iter().map(message_to_json).collect())
}

pub fn messages_from_json(v: &Value) -> Result<Vec<ChatMessage>, String> {
    v.as_array().ok_or("messages must be an array")?.iter().map(message_from_json).collect()
}

pub fn delta_to_json(d: &ChatCompletionDelta) -> Value {
    let mut o = Map::new();
    put(&mut o, "role", &d.role);
    put(&mut o, "content", &d.content);
    put(&mut o, "reasoning_content", &d.reasoning_content);
    put(&mut o, "reasoning_signature", &d.reasoning_signature);
    put(&mut o, "redacted_thinking_block", &d.redacted_thinking_block);
    put(&mut o, "anthropic_raw_blocks", &d.anthropic_raw_blocks);
    put(&mut o, "reasoning_item", &d.reasoning_item);
    put(&mut o, "tool_calls", &d.tool_calls);
    put(&mut o, "stop_details", &d.stop_details);
    Value::Object(o)
}

pub fn delta_from_json(v: &Value) -> Result<ChatCompletionDelta, String> {
    let empty = Map::new();
    let o = match v {
        Value::Null => &empty,
        Value::Object(o) => o,
        _ => return Err("delta must be an object".into()),
    };
    Ok(ChatCompletionDelta {
        role: opt_str(o, "role"),
        content: opt_str(o, "content"),
        reasoning_content: opt_str(o, "reasoning_content"),
        reasoning_signature: opt_str(o, "reasoning_signature"),
        redacted_thinking_block: o.get("redacted_thinking_block").filter(|x| !x.is_null()).cloned(),
        anthropic_raw_blocks: opt_de(o, "anthropic_raw_blocks")?,
        reasoning_item: opt_de(o, "reasoning_item")?,
        tool_calls: opt_de(o, "tool_calls")?,
        stop_details: o.get("stop_details").filter(|x| !x.is_null()).cloned(),
    })
}

pub fn chunk_to_json(c: &ChatCompletionChunk) -> Value {
    json!({
        "id": c.id,
        "created": c.created,
        "model": c.model,
        "choices": c.choices.iter().map(|ch| json!({"index": ch.index, "delta": delta_to_json(&ch.delta), "finish_reason": ch.finish_reason})).collect::<Vec<_>>(),
        "usage": c.usage,
        "agent_name": c.agent_name,
    })
}

pub fn chunk_from_json(v: &Value) -> Result<ChatCompletionChunk, String> {
    let o = v.as_object().ok_or("chunk must be an object")?;
    let mut choices = vec![];
    for ch in o.get("choices").and_then(|c| c.as_array()).into_iter().flatten() {
        choices.push(ChunkChoice {
            index: ch.get("index").and_then(|x| x.as_i64()).unwrap_or(0),
            delta: delta_from_json(ch.get("delta").unwrap_or(&Value::Null))?,
            finish_reason: ch.get("finish_reason").and_then(|x| x.as_str()).map(String::from),
        });
    }
    Ok(ChatCompletionChunk {
        id: opt_str(o, "id").unwrap_or_default(),
        created: o.get("created").and_then(|x| x.as_i64()).unwrap_or_else(now_ts),
        model: opt_str(o, "model").unwrap_or_default(),
        choices,
        usage: opt_de(o, "usage")?,
        agent_name: opt_str(o, "agent_name"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip() {
        let mut a =
            AssistantMessage { content: None, reasoning_content: Some("r".into()), tool_calls: Some(vec![ToolCall::new("c1", "read", "{\"p\": 1}")]), ..Default::default() };
        a.tool_calls.as_mut().unwrap()[0].function.thought_signature = Some("sig".into());
        a.raw_content_blocks = Some(vec![json!({"type": "text", "text": "x"})]);
        a.meta.extra = Some(Map::from_iter([("usage".to_string(), json!({"a": 1}))]));
        a.meta.db_id = Some("abc".into());
        let msgs = vec![
            ChatMessage::system("sys"),
            ChatMessage::User {
                content: Some("hi".into()),
                parts: Some(vec![ContentBlock::text("hi"), ContentBlock::ImageData { data: "d".into(), media_type: "image/png".into() }]),
                meta: MessageMeta { pinned: true, ..Default::default() },
            },
            ChatMessage::Assistant(a),
            ChatMessage::Tool {
                content: Some("out".into()),
                tool_call_id: "c1".into(),
                name: Some("read".into()),
                parts: None,
                meta: MessageMeta { kind: "note".into(), exclude_from_context: true, ..Default::default() },
            },
        ];
        let j = messages_to_json(&msgs);
        assert_eq!(messages_from_json(&j).unwrap(), msgs);
        assert_eq!(j[0], json!({"role": "system", "content": "sys"}));
    }

    #[test]
    fn chunks_round_trip() {
        let d = ChatCompletionDelta {
            role: Some("assistant".into()),
            content: Some("x".into()),
            tool_calls: Some(vec![ToolCallDelta { index: Some(0), id: Some("i".into()), function: Some(FunctionCallDelta { name: Some("n".into()), ..Default::default() }) }]),
            ..Default::default()
        };
        let c = ChatCompletionChunk::delta("id", "m", d, Some("stop".into()), Some(Usage { prompt_tokens: 3, ..Default::default() }));
        assert_eq!(chunk_from_json(&chunk_to_json(&c)).unwrap(), c);
    }
}
