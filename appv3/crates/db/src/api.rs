//! Row → wire JSON, matching v2's Pydantic response models field-for-field
//! (declaration order, `_ExcludeNoneModel` null-stripping, UUID/datetime
//! rendering). Keep in sync with `app/api/schemas/*.py`.

use crate::codec::{api_dt, api_uuid, parse_dt, py_isoformat};
use crate::models::{kind, ChatSession, CodingWorkspace, PendingQuestion, ScheduledTask, SessionMessage};
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};

/// Live, non-persisted session state merged into `SessionResponse`.
#[derive(Debug, Default, Clone)]
pub struct SessionOverlay {
    pub running: bool,
    pub needs_input: bool,
    pub pending_interaction_mode: Option<String>,
    pub estimated_cost_usd: Option<f64>,
    pub completion_tokens: Option<i64>,
    pub agent_name: Option<String>,
    pub subagents: Vec<Value>,
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        if !v.is_null() {
            map.insert(key.to_string(), v);
        }
    }
}

/// `SessionResponse` (an `_ExcludeNoneModel`).
pub fn session_response(s: &ChatSession, o: &SessionOverlay) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(api_uuid(&s.id)));
    put(&mut m, "parent_session_id", s.parent_session_id.as_deref().map(|p| Value::String(api_uuid(p))));
    put(&mut m, "title", s.title.clone().map(Value::String));
    let agent_name = o.agent_name.clone().or_else(|| s.agent_name.clone());
    put(&mut m, "agent_name", agent_name.map(Value::String));
    put(&mut m, "scheduled_task_name", s.scheduled_task_name.clone().map(Value::String));
    m.insert("workspace".into(), Value::String(s.workspace.clone()));
    let mode = if s.interaction_mode == "plan" { "plan" } else { "code" };
    m.insert("interaction_mode".into(), Value::String(mode.into()));
    put(&mut m, "pending_interaction_mode", o.pending_interaction_mode.clone().map(Value::String));
    put(&mut m, "model", s.model.clone().map(Value::String));
    put(&mut m, "thinking_level", s.thinking_level.clone().map(Value::String));
    put(&mut m, "revert", s.revert_json());
    m.insert("running".into(), Value::Bool(o.running));
    put(&mut m, "estimated_cost_usd", o.estimated_cost_usd.map(|c| serde_json::json!(c)));
    put(&mut m, "completion_tokens", o.completion_tokens.map(|c| serde_json::json!(c)));
    m.insert("needs_input".into(), Value::Bool(o.needs_input));
    m.insert("subagents".into(), Value::Array(o.subagents.clone()));
    m.insert("created_at".into(), Value::String(api_dt(&s.created_at)));
    m.insert("updated_at".into(), Value::String(api_dt(&s.updated_at)));
    // v3 addition: the activity time (see `ChatSession::last_message_at`).
    put(&mut m, "last_message_at", s.last_message_at.as_deref().map(|t| Value::String(api_dt(t))));
    // v3 addition, omitted when unpinned so v2 response shapes are unchanged.
    put(&mut m, "pinned_at", s.pinned_at.as_deref().map(|p| Value::String(api_dt(p))));
    m
}

const INTERNAL_ATTACHMENT_FIELDS: [&str; 3] = ["converted_text", "path", "workspace_path"];
const DISPLAY_STRIPPED_EXTRA_FIELDS: [&str; 1] = ["parts"];

/// `MessageResponse` via `_message_response` (strips `extra.parts`, internal
/// attachment fields, and continuation reasoning).
pub fn message_response(r: &SessionMessage) -> Map<String, Value> {
    match serde_json::to_value(MessageView(r)) {
        Ok(Value::Object(m)) => m,
        _ => unreachable!("MessageView always serializes to an object"),
    }
}

/// A row rendered as `MessageResponse` straight from its columns. Serialize
/// this instead of building a `Value`: strings are borrowed, and
/// `tool_calls`/`extra` go out as the stored JSON text unless `extra` holds
/// a key that display rewrites.
pub struct MessageView<'a>(pub &'a SessionMessage);

/// A page of rows, serialized as a JSON array of [`MessageView`]s.
pub struct MessagesView<'a>(pub &'a [SessionMessage]);

impl Serialize for MessagesView<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(MessageView))
    }
}

enum Json<'a> {
    Raw(&'a RawValue),
    Owned(Value),
}

impl Serialize for Json<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Raw(r) => r.serialize(s),
            Json::Owned(v) => v.serialize(s),
        }
    }
}

/// A stored JSON column as raw text, or `None` for SQL/JSON null, blank, or
/// malformed text (as [`crate::codec::json_col`] decodes it).
fn raw_col(raw: Option<&str>) -> Option<&RawValue> {
    let text = raw?.trim();
    serde_json::from_str::<&RawValue>(text).ok().filter(|v| v.get() != "null")
}

/// What display does to `extra`: the field itself, the public attachments,
/// and whether continuation reasoning is hidden.
struct DisplayExtra<'a> {
    extra: Option<Json<'a>>,
    attachments: Option<Value>,
    hide_reasoning: bool,
}

impl<'a> DisplayExtra<'a> {
    fn of(raw: Option<&'a str>) -> Self {
        let pass = |extra| DisplayExtra { extra, attachments: None, hide_reasoning: false };
        let Some(text) = raw else { return pass(None) };
        // Rows without these keys go out untouched; stored keys are plain
        // ASCII, so a substring check is a safe filter.
        if !["\"parts\"", "\"attachments\"", "\"is_continuation\""].iter().any(|k| text.contains(k)) {
            return pass(raw_col(raw).map(Json::Raw));
        }
        let Some(mut extra) = crate::codec::json_col(raw) else { return pass(None) };
        let mut out = DisplayExtra { extra: None, attachments: None, hide_reasoning: false };
        if let Value::Object(ref mut e) = extra {
            out.hide_reasoning = e.get("is_continuation").map(truthy).unwrap_or(false);
            let mut stripped = false;
            for key in DISPLAY_STRIPPED_EXTRA_FIELDS {
                stripped |= e.remove(key).is_some();
            }
            if let Some(Value::Array(atts)) = e.get_mut("attachments") {
                for a in atts.iter_mut() {
                    if let Value::Object(obj) = a {
                        obj.retain(|k, _| !INTERNAL_ATTACHMENT_FIELDS.contains(&k.as_str()));
                    }
                }
                out.attachments = Some(Value::Array(atts.clone()));
            }
            // Only the display-stripping branch collapses `{}` to None (v2
            // does `resp.extra = extra or None` there); `{}` as stored stays.
            if stripped && e.is_empty() {
                return out;
            }
        }
        out.extra = Some(Json::Owned(extra));
        out
    }
}

impl Serialize for MessageView<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let r = self.0;
        let display = DisplayExtra::of(r.extra.as_deref());
        let tool_calls = raw_col(r.tool_calls.as_deref()).filter(|v| v.get().starts_with('['));
        let reasoning = r.reasoning_content.as_deref().filter(|_| !display.hide_reasoning);
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("id", &api_uuid(&r.id))?;
        m.serialize_entry("session_id", &api_uuid(&r.session_id))?;
        m.serialize_entry("role", &r.role)?;
        if let Some(v) = &r.content {
            m.serialize_entry("content", v)?;
        }
        if let Some(v) = reasoning {
            m.serialize_entry("reasoning_content", v)?;
        }
        if let Some(v) = tool_calls {
            m.serialize_entry("tool_calls", v)?;
        }
        if let Some(v) = &r.tool_call_id {
            m.serialize_entry("tool_call_id", v)?;
        }
        if let Some(v) = &r.name {
            m.serialize_entry("name", v)?;
        }
        m.serialize_entry("seq", &r.seq)?;
        m.serialize_entry("kind", &r.kind)?;
        m.serialize_entry("is_summary", &(r.kind == kind::SUMMARY))?;
        if let Some(v) = &display.extra {
            m.serialize_entry("extra", v)?;
        }
        m.serialize_entry("created_at", &api_dt(&r.created_at))?;
        if let Some(v) = &display.attachments {
            m.serialize_entry("attachments", v)?;
        }
        m.serialize_entry("file_message", &display.attachments.is_some())?;
        m.end()
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `PendingQuestionResponse.from_row` (note: `created_at` is Python
/// `isoformat()`, i.e. `+00:00`, not `Z`).
pub fn pending_question_response(q: &PendingQuestion) -> Value {
    let created = parse_dt(&q.created_at).map(|d| py_isoformat(&d)).unwrap_or_else(|| q.created_at.clone());
    let mut v = serde_json::json!({
        "id": api_uuid(&q.id),
        "session_id": api_uuid(&q.session_id),
        "tool_call_id": q.tool_call_id,
        "questions": q.questions(),
        "created_at": created,
    });
    // v3 plan reviews only, so `ask_user` rows keep v2's exact shape.
    if let Some(kind) = q.kind() {
        v["kind"] = Value::String(kind);
        v["plan_revision"] = q.plan_revision().map(Value::from).unwrap_or(Value::Null);
    }
    v
}

fn opt_dt(v: &Option<String>) -> Value {
    v.as_deref().map(|d| Value::String(api_dt(d))).unwrap_or(Value::Null)
}

/// `ScheduledTaskResponse` (a plain `BaseModel` — nulls are kept).
pub fn scheduled_task_response(t: &ScheduledTask) -> Value {
    serde_json::json!({
        "id": api_uuid(&t.id),
        "slug": t.slug,
        "name": t.name,
        "workspace": t.workspace,
        "schedule_type": t.schedule_type,
        "at_datetime": opt_dt(&t.at_datetime),
        "every_seconds": t.every_seconds,
        "cron_expression": t.cron_expression,
        "timezone": t.timezone,
        "prompt": t.prompt,
        "session_id": t.session_id,
        "max_runs": t.max_runs,
        "enabled": t.enabled,
        "status": t.status,
        "run_count": t.run_count,
        "last_run_at": opt_dt(&t.last_run_at),
        "last_error": t.last_error,
        "next_fire_at": opt_dt(&t.next_fire_at),
        "created_at": api_dt(&t.created_at),
        "updated_at": api_dt(&t.updated_at),
    })
}

/// Display name for a coding workspace row (`row.name or Path(row.path).name`).
pub fn workspace_display_name(w: &CodingWorkspace) -> String {
    w.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| std::path::Path::new(&w.path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const SID: &str = "fedcba9876543210fedcba9876543210";

    fn row(role: &str) -> SessionMessage {
        SessionMessage {
            id: ID.into(),
            session_id: SID.into(),
            role: role.into(),
            content: None,
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            extra: None,
            created_at: "2026-09-23 06:56:28.225815".into(),
            seq: 7,
            kind: kind::CHAT.into(),
            pinned: false,
        }
    }

    fn keys(v: &Map<String, Value>) -> Vec<&str> {
        v.keys().map(String::as_str).collect()
    }

    #[test]
    fn message_response_plain_row() {
        let mut r = row("user");
        r.content = Some("hi ✓".into());
        let m = message_response(&r);
        assert_eq!(keys(&m), ["id", "session_id", "role", "content", "seq", "kind", "is_summary", "created_at", "file_message"]);
        assert_eq!(
            Value::Object(m),
            json!({"id": "01234567-89ab-cdef-0123-456789abcdef", "session_id": "fedcba98-7654-3210-fedc-ba9876543210", "role": "user", "content": "hi ✓", "seq": 7, "kind": "chat", "is_summary": false, "created_at": "2026-09-23T06:56:28.225815Z", "file_message": false})
        );
    }

    #[test]
    fn message_response_full_assistant_row() {
        let mut r = row("assistant");
        r.content = Some("done".into());
        r.reasoning_content = Some("think".into());
        // Python json.dumps style from older rows.
        r.tool_calls = Some(r#"[{"id": "c1", "function": {"name": "read", "arguments": "{\"p\": \"Vi\u1ec7t\"}"}}]"#.into());
        r.tool_call_id = Some("c0".into());
        r.name = Some("read".into());
        r.extra = Some(r#"{"usage": {"total_tokens": 3}, "model": "m"}"#.into());
        r.kind = kind::SUMMARY.into();
        let m = message_response(&r);
        assert_eq!(
            keys(&m),
            ["id", "session_id", "role", "content", "reasoning_content", "tool_calls", "tool_call_id", "name", "seq", "kind", "is_summary", "extra", "created_at", "file_message"]
        );
        assert_eq!(m["tool_calls"], json!([{"id": "c1", "function": {"name": "read", "arguments": "{\"p\": \"Việt\"}"}}]));
        assert_eq!(m["extra"], json!({"usage": {"total_tokens": 3}, "model": "m"}));
        assert_eq!(m["is_summary"], json!(true));
        assert_eq!(m["reasoning_content"], json!("think"));
    }

    #[test]
    fn message_response_drops_continuation_reasoning() {
        let mut r = row("assistant");
        r.reasoning_content = Some("think".into());
        r.extra = Some(r#"{"is_continuation": true}"#.into());
        let m = message_response(&r);
        assert!(!m.contains_key("reasoning_content"));
        assert_eq!(m["extra"], json!({"is_continuation": true}));
        r.extra = Some(r#"{"is_continuation": 0}"#.into());
        assert_eq!(message_response(&r)["reasoning_content"], json!("think"));
    }

    #[test]
    fn message_response_strips_parts_and_collapses_to_none() {
        let mut r = row("user");
        r.extra = Some(r#"{"parts": [{"type": "text"}]}"#.into());
        assert!(!message_response(&r).contains_key("extra"));
        r.extra = Some(r#"{"parts": [], "from_agent": "lead"}"#.into());
        assert_eq!(message_response(&r)["extra"], json!({"from_agent": "lead"}));
        // Stored as `{}` with nothing stripped: kept.
        r.extra = Some("{}".into());
        assert_eq!(message_response(&r)["extra"], json!({}));
    }

    #[test]
    fn message_response_filters_attachments() {
        let mut r = row("user");
        r.extra = Some(r#"{"attachments": [{"name": "a.pdf", "path": "/x", "converted_text": "t", "workspace_path": "w", "size": 3}, "odd"], "k": 1}"#.into());
        let m = message_response(&r);
        let public = json!([{"name": "a.pdf", "size": 3}, "odd"]);
        assert_eq!(m["extra"], json!({"attachments": public, "k": 1}));
        assert_eq!(m["attachments"], public);
        assert_eq!(m["file_message"], json!(true));
        assert_eq!(keys(&m).last(), Some(&"file_message"));
        assert_eq!(keys(&m)[keys(&m).len() - 2], "attachments");
    }

    #[test]
    fn message_response_skips_unusable_json_columns() {
        let mut r = row("assistant");
        for (tc, extra) in [(r#"{"a": 1}"#, "null"), ("nope", "{broken"), ("null", "  "), ("", "")] {
            r.tool_calls = Some(tc.into());
            r.extra = Some(extra.into());
            let m = message_response(&r);
            assert!(!m.contains_key("tool_calls"), "{tc}");
            assert!(!m.contains_key("extra"), "{extra}");
        }
        r.tool_calls = Some(" [] ".into());
        assert_eq!(message_response(&r)["tool_calls"], json!([]));
    }

    #[test]
    fn messages_view_bytes_match_message_response() {
        let mut a = row("assistant");
        a.tool_calls = Some(r#"[{"id": "c1", "args": "Vi\u1ec7t"}]"#.into());
        a.extra = Some(r#"{"usage": {"n": 1.5}, "model": "m"}"#.into());
        let mut b = row("user");
        b.content = Some("x".into());
        b.extra = Some(r#"{"attachments": [{"name": "a", "path": "/p"}], "parts": []}"#.into());
        let rows = [a, b];
        let bytes = serde_json::to_vec(&MessagesView(&rows)).unwrap();
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed, Value::Array(rows.iter().map(|r| Value::Object(message_response(r))).collect()));
        // Key order survives the raw path too.
        let first: Map<String, Value> = serde_json::from_slice::<Vec<Map<String, Value>>>(&bytes).unwrap().remove(0);
        assert_eq!(keys(&first), keys(&message_response(&rows[0])));
    }
}
