//! Row ⇄ runtime message conversion and LLM-window loading — port of
//! `chat_service_messages.py`, `get_messages_for_llm`, `save_message` (typed
//! form) and `heal_orphaned_tool_calls`.

use anyhow::Result;
use appv3_db::{self as db, DbPool, NewMessage, SessionMessage};
use appv3_providers::{AssistantMessage, ChatMessage, ContentBlock, EncryptedReasoningItem, MessageMeta, ToolCall};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub const INTERRUPTED_TOOL_RESULT: &str = "Tool execution was interrupted before a result could be recorded.";

fn meta_from_row(row: &SessionMessage) -> MessageMeta {
    let extra = match row.extra_json() {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    };
    MessageMeta { exclude_from_context: false, kind: row.kind.clone(), pinned: row.pinned, extra, db_id: Some(db::codec::api_uuid(&row.id)) }
}

fn parse_parts(v: Option<Value>) -> Option<Vec<ContentBlock>> {
    let Value::Array(arr) = v? else { return None };
    Some(arr.into_iter().filter_map(|p| serde_json::from_value(p).ok()).collect())
}

/// `_chat_message_from_row`. Takes the row so its text moves into the
/// message instead of being copied.
pub fn message_from_row(row: SessionMessage) -> Option<ChatMessage> {
    let mut meta = meta_from_row(&row);
    Some(match row.role.as_str() {
        "system" => ChatMessage::System { content: row.content, meta },
        "user" => ChatMessage::User { content: row.content, parts: None, meta },
        "assistant" => {
            let empty = Map::new();
            let extra = meta.extra.as_ref().unwrap_or(&empty);
            let signature = extra.get("reasoning_signature").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
            let redacted = extra.get("redacted_thinking_blocks").and_then(|v| v.as_array()).filter(|a| !a.is_empty()).cloned();
            let raw = extra.get("raw_content_blocks").and_then(|v| v.as_array()).filter(|a| !a.is_empty()).cloned();
            let mut items: Option<Vec<EncryptedReasoningItem>> = extra
                .get("reasoning_items")
                .and_then(|v| v.as_array())
                .filter(|a| !a.is_empty())
                .map(|a| a.iter().filter_map(|i| serde_json::from_value(i.clone()).ok()).collect());
            if items.is_none() {
                if let Some(enc) = extra.get("reasoning_encrypted_content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    let id = extra.get("reasoning_item_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
                    let summary = match &row.reasoning_content {
                        Some(r) if !r.is_empty() => {
                            vec![json!({"type": "summary_text", "text": r})]
                        }
                        _ => vec![],
                    };
                    items = Some(vec![EncryptedReasoningItem { id, summary, encrypted_content: enc.to_string() }]);
                }
            }
            let tool_calls: Option<Vec<ToolCall>> = row.tool_calls_json().and_then(|v| serde_json::from_value::<Vec<ToolCall>>(v).ok());
            ChatMessage::Assistant(AssistantMessage {
                content: row.content,
                reasoning_content: row.reasoning_content,
                reasoning_signature: signature,
                redacted_thinking_blocks: redacted,
                raw_content_blocks: raw,
                reasoning_items: items,
                tool_calls,
                agent_id: None,
                agent_name: None,
                meta,
            })
        }
        "tool" => {
            // `parts` (image data) lives on the message only; saving writes
            // it back into `extra` (`to_new_message`).
            let parts = parse_parts(meta.extra.as_mut().and_then(|e| e.shift_remove("parts")));
            ChatMessage::Tool { content: row.content, tool_call_id: row.tool_call_id.unwrap_or_default(), name: row.name, parts, meta }
        }
        other => {
            tracing::warn!("deserialize_skip_unknown_role session_id={} message_id={} role={}", row.session_id, row.id, other);
            return None;
        }
    })
}

/// `deserialize_messages`.
pub fn deserialize_messages(rows: Vec<SessionMessage>, sanitize_tool_pairs: bool) -> Vec<ChatMessage> {
    let mut result: Vec<ChatMessage> = rows.into_iter().filter_map(message_from_row).collect();
    let mut bad: HashSet<String> = HashSet::new();
    for msg in result.iter_mut() {
        if let ChatMessage::Assistant(a) = msg {
            if let Some(tcs) = &a.tool_calls {
                let clean: Vec<ToolCall> = tcs
                    .iter()
                    .filter(|tc| {
                        let ok = serde_json::from_str::<Value>(&tc.function.arguments).is_ok();
                        if !ok {
                            bad.insert(tc.id.clone());
                        }
                        ok
                    })
                    .cloned()
                    .collect();
                if clean.len() != tcs.len() {
                    a.tool_calls = if clean.is_empty() { None } else { Some(clean) };
                }
            }
        }
    }
    if !bad.is_empty() {
        result.retain(|m| !matches!(m, ChatMessage::Tool { tool_call_id, .. } if bad.contains(tool_call_id)));
    }
    if sanitize_tool_pairs {
        result = sanitize_tool_message_pairs(result);
    }
    result
}

/// `sanitize_tool_message_pairs`. Decides per message first, then moves the
/// kept ones, so the history is not copied.
pub fn sanitize_tool_message_pairs(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    enum Keep {
        Yes,
        No,
        WithoutToolCalls,
    }
    let mut keep = Vec::with_capacity(messages.len());
    let mut expected: HashSet<String> = HashSet::new();
    for idx in 0..messages.len() {
        keep.push(match &messages[idx] {
            ChatMessage::Assistant(a) => {
                expected.clear();
                match &a.tool_calls {
                    None => Keep::Yes,
                    Some(tcs) if tcs.is_empty() => Keep::Yes,
                    Some(tcs) => {
                        let ids: HashSet<String> = tcs.iter().filter(|t| !t.id.is_empty()).map(|t| t.id.clone()).collect();
                        let mut following = HashSet::new();
                        for m in &messages[idx + 1..] {
                            match m {
                                ChatMessage::Tool { tool_call_id, .. } => {
                                    if !tool_call_id.is_empty() {
                                        following.insert(tool_call_id.as_str());
                                    }
                                }
                                _ => break,
                            }
                        }
                        if !ids.is_empty() && ids.iter().all(|id| following.contains(id.as_str())) {
                            expected = ids;
                            Keep::Yes
                        } else if !a.content.as_deref().unwrap_or("").is_empty() {
                            Keep::WithoutToolCalls
                        } else {
                            Keep::No
                        }
                    }
                }
            }
            ChatMessage::Tool { tool_call_id, .. } => {
                if !tool_call_id.is_empty() && expected.remove(tool_call_id) {
                    Keep::Yes
                } else {
                    Keep::No
                }
            }
            _ => {
                expected.clear();
                Keep::Yes
            }
        });
    }
    messages
        .into_iter()
        .zip(keep)
        .filter_map(|(m, k)| match (k, m) {
            (Keep::Yes, m) => Some(m),
            (Keep::No, _) => None,
            (Keep::WithoutToolCalls, ChatMessage::Assistant(mut a)) => {
                a.tool_calls = None;
                Some(ChatMessage::Assistant(a))
            }
            (Keep::WithoutToolCalls, m) => Some(m),
        })
        .collect()
}

/// `_attachment_hint_parts`.
fn attachment_hint_parts(message: &str, attachments: &[Value]) -> Vec<ContentBlock> {
    let mut parts = Vec::new();
    for att in attachments {
        let category = att.get("category").and_then(|v| v.as_str()).unwrap_or("file");
        let original = att.get("original_name").and_then(|v| v.as_str()).or_else(|| att.get("filename").and_then(|v| v.as_str())).unwrap_or("file");
        let filename = att.get("filename").and_then(|v| v.as_str()).unwrap_or("");
        let hint = if filename.is_empty() { original.to_string() } else { format!("./uploads/{filename}") };
        parts.push(ContentBlock::text(format!("[Attached {category}: {original} — available at {hint}]")));
    }
    parts.push(ContentBlock::text(message));
    parts
}

/// `apply_llm_content_overrides`.
pub fn apply_llm_content_overrides(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut out = Vec::with_capacity(messages.len());
    for mut msg in messages {
        if let ChatMessage::User { content, parts, meta } = &mut msg {
            if let Some(extra) = meta.extra.as_ref() {
                let truthy = |k: &str| extra.get(k).map(crate::util::truthy).unwrap_or(false);
                if truthy("attachment_for_message_id") && !truthy("mention_context") {
                    continue;
                }
                if let Some(Value::Array(atts)) = extra.get("attachments") {
                    if !atts.is_empty() {
                        *parts = Some(attachment_hint_parts(content.as_deref().unwrap_or(""), atts));
                    }
                }
                if let Some(header) = workspace_message_header(extra) {
                    let c = content.clone().unwrap_or_default();
                    *content = Some(format!("{header}\n{c}"));
                } else if let Some(from) = extra.get("from_agent").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    let c = content.clone().unwrap_or_default();
                    if from != "user" && !c.starts_with(&format!("[{from}")) {
                        *content = Some(format!("[{from}]:\n{c}"));
                    }
                }
            }
        }
        out.push(msg);
    }
    out
}

/// The model-only header for a message from another workspace
/// (`sent_from`) or a reply to one (`reply_from`); the UI shows a chip.
fn workspace_message_header(extra: &serde_json::Map<String, Value>) -> Option<String> {
    let s = |o: &serde_json::Map<String, Value>, k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(Value::Object(r)) = extra.get("reply_from") {
        let status = s(r, "status");
        let what = if status == "completed" { "Reply" } else { "Status update" };
        return Some(format!("[{what} from the agent in workspace '{}' ({}), session {}, status {status}]:", s(r, "workspace_name"), s(r, "workspace"), s(r, "session_id")));
    }
    let Some(Value::Object(f)) = extra.get("sent_from") else { return None };
    let reply = f.get("reply").is_some_and(crate::util::truthy);
    let tail = if reply {
        "Your final answer is delivered back to it automatically, so end with a self-contained summary; do not call send_to_workspace to reply."
    } else {
        "No reply is expected."
    };
    Some(format!(
        "[Message from the agent in workspace '{}' ({}), session {}. Its files are readable by absolute path. {tail}]",
        s(f, "workspace_name"),
        s(f, "workspace"),
        s(f, "session_id")
    ))
}

/// `get_messages_for_llm`.
pub async fn get_messages_for_llm(pool: &DbPool, session_id: &str) -> Result<Vec<ChatMessage>> {
    let rows = db::llm_window_rows(pool, session_id, true).await?;
    Ok(apply_llm_content_overrides(deserialize_messages(rows, true)))
}

/// Rows → runtime messages without the pair sanitiser (queued injection).
pub fn rows_to_llm_messages(rows: Vec<SessionMessage>) -> Vec<ChatMessage> {
    apply_llm_content_overrides(deserialize_messages(rows, false))
}

// ── Persistence (typed save_message) ─────────────────────────────────────────

pub fn tool_call_dump(tc: &ToolCall) -> Value {
    json!({
        "id": tc.id,
        "type": tc.kind,
        "function": {
            "name": tc.function.name,
            "arguments": tc.function.arguments,
            "thought": tc.function.thought,
            "thought_signature": tc.function.thought_signature,
        }
    })
}

pub fn content_block_dump(b: &ContentBlock) -> Value {
    match b {
        ContentBlock::Text { text } => json!({"type": "text", "text": text}),
        ContentBlock::ImageUrl { url, media_type, detail } => {
            json!({"type": "image_url", "url": url, "media_type": media_type, "detail": detail})
        }
        ContentBlock::ImageData { data, media_type } => {
            json!({"type": "image_data", "data": data, "media_type": media_type})
        }
    }
}

/// Build the `NewMessage` v2's `save_message(db, sid, message, ...)` writes.
pub fn to_new_message(msg: &ChatMessage) -> NewMessage {
    let meta = msg.meta();
    let mut extra: Map<String, Value> = meta.extra.clone().unwrap_or_default();
    let mut nm = NewMessage { role: msg.role().to_string(), content: msg.content().map(String::from), ..Default::default() };
    match msg {
        ChatMessage::Assistant(a) => {
            nm.reasoning_content = a.reasoning_content.clone();
            if let Some(tcs) = a.tool_calls.as_ref().filter(|t| !t.is_empty()) {
                nm.tool_calls = Some(Value::Array(tcs.iter().map(tool_call_dump).collect()));
            }
        }
        ChatMessage::Tool { tool_call_id, name, parts, .. } => {
            nm.tool_call_id = Some(tool_call_id.clone());
            nm.name = name.clone();
            if let Some(p) = parts.as_ref().filter(|p| !p.is_empty()) {
                extra.insert("parts".into(), Value::Array(p.iter().map(content_block_dump).collect()));
            }
        }
        _ => {}
    }
    nm.extra = if extra.is_empty() { None } else { Some(extra) };
    nm
}

// ── heal_orphaned_tool_calls ─────────────────────────────────────────────────

/// Insert synthetic tool rows for unmatched tool_calls in the LLM window.
pub async fn heal_orphaned_tool_calls(pool: &DbPool, session_id: &str) -> Result<usize> {
    let rows = db::llm_window_tool_pairs(pool, session_id).await?;
    let assistants: Vec<&db::ToolPairRow> =
        rows.iter().filter(|r| r.role == "assistant" && r.tool_calls_json().map(|t| t.as_array().map(|a| !a.is_empty()).unwrap_or(false)).unwrap_or(false)).collect();
    if assistants.is_empty() {
        return Ok(0);
    }
    let mut expected: HashSet<String> = HashSet::new();
    for r in &assistants {
        for tc in r.tool_calls_json().and_then(|v| v.as_array().cloned()).unwrap_or_default() {
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                expected.insert(id.to_string());
            }
        }
    }
    if expected.is_empty() {
        return Ok(0);
    }
    let matched: HashSet<String> = rows.iter().filter(|r| r.role == "tool").filter_map(|r| r.tool_call_id.clone()).filter(|id| expected.contains(id)).collect();
    let mut healed = Vec::new();
    for r in assistants {
        let missing: Vec<Value> = r
            .tool_calls_json()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(|tc| !tc.get("id").and_then(|v| v.as_str()).map(|id| matched.contains(id)).unwrap_or(false))
            .collect();
        if missing.is_empty() {
            continue;
        }
        let next: Option<i64> =
            sqlx::query_scalar("SELECT MIN(seq) FROM session_messages WHERE session_id = ? AND seq > ?").bind(&r.session_id).bind(r.seq).fetch_one(pool).await?;
        let upper = next.unwrap_or(r.seq + 2 * db::SEQ_STEP);
        let mut anchor = r.seq;
        let created = db::codec::parse_dt(&r.created_at);
        for (i, tc) in missing.iter().enumerate() {
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            anchor = db::seq_between(anchor, upper).max(anchor);
            let created_at = created.map(|d| db::codec::dt_db(&(d + chrono::Duration::microseconds(i as i64 + 1))));
            db::save_message(pool, session_id, NewMessage { seq: Some(anchor), created_at, ..NewMessage::tool(id.clone(), name, INTERRUPTED_TOOL_RESULT) }).await?;
            healed.push(id);
        }
    }
    if !healed.is_empty() {
        tracing::warn!("tool_call_orphans_healed session_id={} count={} ids=[{}]", session_id, healed.len(), healed.join(", "));
    }
    Ok(healed.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_incomplete_pairs() {
        let mut a = AssistantMessage { content: Some("x".into()), ..Default::default() };
        a.tool_calls = Some(vec![ToolCall::new("1", "read", "{}"), ToolCall::new("2", "read", "{}")]);
        let msgs = vec![
            ChatMessage::user("hi"),
            ChatMessage::Assistant(a),
            ChatMessage::tool("1", Some("read".into()), "ok"),
            ChatMessage::user("next"),
            ChatMessage::tool("9", None, "orphan"),
        ];
        let out = sanitize_tool_message_pairs(msgs);
        assert_eq!(out.len(), 3);
        assert!(out[1].as_assistant().unwrap().tool_calls.is_none());
    }

    /// An image result is the bulk of a row; loading it into both `parts`
    /// and `meta.extra` doubled it in every copy of the history.
    #[test]
    fn tool_image_parts_load_once_and_save_back_unchanged() {
        let extra = json!({"duration_ms": 40, "parts": [{"type": "image_data", "data": "QUJD", "media_type": "image/png"}]});
        let row = SessionMessage {
            id: "0".repeat(32),
            session_id: "1".repeat(32),
            role: "tool".into(),
            content: Some("[Image: a.png]".into()),
            tool_call_id: Some("c1".into()),
            name: Some("read".into()),
            extra: Some(extra.to_string()),
            reasoning_content: None,
            tool_calls: None,
            created_at: "2026-01-01 00:00:00.000000".into(),
            seq: 1,
            kind: "chat".into(),
            pinned: false,
        };
        let msg = message_from_row(row).unwrap();
        let ChatMessage::Tool { parts, meta, .. } = &msg else { panic!("tool") };
        assert_eq!(parts.as_deref(), Some(&[ContentBlock::ImageData { data: "QUJD".into(), media_type: "image/png".into() }][..]));
        assert!(meta.extra.as_ref().unwrap().get("parts").is_none(), "{:?}", meta.extra);
        assert_eq!(Value::Object(to_new_message(&msg).extra.unwrap()), extra);
    }

    fn user_with(extra: Value) -> String {
        let mut m = ChatMessage::user("do it");
        if let ChatMessage::User { meta, .. } = &mut m {
            meta.extra = extra.as_object().cloned();
        }
        let out = apply_llm_content_overrides(vec![m]);
        match &out[0] {
            ChatMessage::User { content, .. } => content.clone().unwrap_or_default(),
            other => panic!("user: {other:?}"),
        }
    }

    #[test]
    fn workspace_messages_get_a_model_only_header() {
        let c = user_with(json!({"sent_from": {"session_id": "s1", "workspace": "/r/app", "workspace_name": "app", "reply": true, "hops": 1}}));
        assert!(c.starts_with("[Message from the agent in workspace 'app' (/r/app), session s1."), "{c}");
        assert!(c.contains("delivered back to it automatically") && c.ends_with("]\ndo it"), "{c}");
        let c = user_with(json!({"sent_from": {"session_id": "s1", "workspace": "/r/app", "workspace_name": "app", "reply": false}}));
        assert!(c.contains("No reply is expected."), "{c}");
        let c = user_with(json!({"from_agent": "infra", "reply_from": {"session_id": "s2", "workspace": "/r/infra", "workspace_name": "infra", "status": "completed"}}));
        assert_eq!(c, "[Reply from the agent in workspace 'infra' (/r/infra), session s2, status completed]:\ndo it");
        let c = user_with(json!({"from_agent": "infra", "reply_from": {"session_id": "s2", "workspace": "/r/infra", "workspace_name": "infra", "status": "error"}}));
        assert!(c.starts_with("[Status update from"), "{c}");
        assert_eq!(user_with(json!({"from_agent": "explorer#1"})), "[explorer#1]:\ndo it");
    }
}
