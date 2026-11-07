//! Row → wire JSON, matching v2's Pydantic response models field-for-field
//! (declaration order, null-stripping, UUID/datetime
//! rendering). Keep the wire shapes in sync with the web client's types.

use crate::codec::{api_dt, api_uuid, parse_dt, py_isoformat};
use crate::models::{ChatSession, CodingWorkspace, PendingQuestion, ScheduledTask, SessionMessage};
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};

/// Live, non-persisted session state merged into `SessionResponse`.
#[derive(Debug, Default, Clone)]
pub struct SessionOverlay {
    pub running: bool,
    pub needs_input: bool,
    /// The session's own turn ended, but work it started will run it again
    /// (subagents still running, or a reply another workspace owes it).
    pub background_work: bool,
    pub pending_interaction_mode: Option<String>,
    pub estimated_cost_usd: Option<f64>,
    pub completion_tokens: Option<i64>,
    pub agent_name: Option<String>,
    pub subagents: Vec<Value>,
    /// The session's live goal status (`active` or `paused`), if any.
    pub goal_status: Option<String>,
    /// The live goal's `(turns_used, max_turns)`, if any.
    pub goal_turns: Option<(i64, i64)>,
    /// The session in another workspace whose send started this one:
    /// `{session_id, workspace, title}` (v3 addition, omitted when none).
    pub sent_from: Option<Value>,
    /// Sessions in other workspaces this one's sends started, directly or
    /// down a chain, oldest first (v3 addition, omitted when empty).
    pub linked_sessions: Vec<Value>,
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
    // v3 addition, omitted on Auto: the credential the session is pinned to.
    put(&mut m, "credential_id", s.credential_id.clone().map(Value::String));
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
    // v3 addition, omitted when false for the same reason.
    if o.background_work {
        m.insert("background_work".into(), Value::Bool(true));
    }
    // v3 addition, omitted without a live goal.
    put(&mut m, "goal_status", o.goal_status.clone().map(Value::String));
    if let Some((used, max)) = o.goal_turns {
        m.insert("goal_turns_used".into(), serde_json::json!(used));
        m.insert("goal_max_turns".into(), serde_json::json!(max));
    }
    put(&mut m, "sent_from", o.sent_from.clone());
    if !o.linked_sessions.is_empty() {
        m.insert("linked_sessions".into(), Value::Array(o.linked_sessions.clone()));
    }
    m
}

/// The `sent_from` value of a session whose send started another: who sent
/// it, and where.
pub fn sent_from_json(origin: &ChatSession) -> Value {
    let mut m = Map::new();
    m.insert("session_id".into(), Value::String(api_uuid(&origin.id)));
    m.insert("workspace".into(), Value::String(origin.workspace.clone()));
    put(&mut m, "title", origin.title.clone().map(Value::String));
    Value::Object(m)
}

const INTERNAL_ATTACHMENT_FIELDS: [&str; 3] = ["converted_text", "path", "workspace_path"];

/// Whether a call to `tool` that answered `content` carries it to clients.
/// Only answers a collapsed card or a follow-up is built from do, each
/// matching the web parser that reads it; every other output (reads, shell,
/// search, fetches, todo and schedule lists, MCP and plugin tools) is fetched
/// when the user opens the call. Former tool names are matched too.
pub fn result_rides_inline(tool: &str, content: &str) -> bool {
    let text = content.trim_start();
    let first = text.lines().next().unwrap_or_default();
    // A confirmation card's row while its question waits (`useShowsConfirmationCard`);
    // once settled the call is an ordinary row.
    let awaits_answer = text.starts_with(crate::queries::questions::PLACEHOLDER_RESULT);
    match tool {
        // Cards that are the answer: `AskUser`, `PlanReviewCard` (and a plan's
        // "Started a new plan"), `GoalClaimCard`.
        "ask_user" | "plan" | "submit_plan" | "update_goal" => true,
        // `isPreviewOpenSuccess`: the Open link and auto-open.
        "preview" => content.starts_with("Opening "),
        // `parseSendResult`: the link to the session a send reached.
        "workspace" | "send_to_workspace" => text.starts_with("Sent to '") || awaits_answer,
        // A call refused because its server needs sign-in: Sign in at the call.
        "mcp" => awaits_answer || (text.starts_with("Error: MCP server '") && first.contains(appv3_core::MCP_SIGN_IN_NOTE)),
        // `teamMemberFromResult`: the subagent row under the call.
        "team" | "delegate" => names_subagent(first),
        t if t.starts_with("team_") => names_subagent(first),
        // `isFailedResult`: a failed patch shows no diff stats and no changed files.
        "patch" => {
            let first = first.to_ascii_lowercase();
            ["error:", "[failed", "[error", "[timed out"].iter().any(|p| first.starts_with(p))
        }
        _ => false,
    }
}

/// A team answer's first line names the subagent it reached (not an error or a roster).
fn names_subagent(first: &str) -> bool {
    let lower = first.to_ascii_lowercase();
    !lower.starts_with("error") && !lower.starts_with('{') && !lower.starts_with('[') && lower.contains("subagent '")
}
/// `extra` keys no client reads: a tool result's image `parts`, the
/// provider replay state (Anthropic raw blocks and thinking signatures,
/// OpenAI reasoning items), which the agent reads from the database, and
/// server bookkeeping (the stop reason, the credential id, the undo
/// snapshot). `attachments` goes out beside `extra` instead.
const DISPLAY_STRIPPED_EXTRA_FIELDS: [&str; 8] =
    ["parts", "raw_content_blocks", "reasoning_signature", "reasoning_items", "finish_reason", "credential_id", "snapshot", "attachments"];
/// The `usage` fields the web reads (`utils/messages.ts`); of `cost`, only
/// `estimated_usd`. Change them together.
const DISPLAY_USAGE_FIELDS: [&str; 5] = ["input", "output", "cache", "cache_percent", "estimated_cost_usd"];
/// The stored keys that send `extra` through the rewriting path, quoted as
/// they appear in the JSON text.
const DISPLAY_REWRITTEN_EXTRA_KEYS: [&str; 10] = [
    "\"parts\"",
    "\"raw_content_blocks\"",
    "\"reasoning_signature\"",
    "\"reasoning_items\"",
    "\"finish_reason\"",
    "\"credential_id\"",
    "\"snapshot\"",
    "\"attachments\"",
    "\"is_continuation\"",
    "\"usage\"",
];

/// Trims `usage` to [`DISPLAY_USAGE_FIELDS`] and `cost.estimated_usd`;
/// whether anything was removed.
fn trim_usage(usage: &mut Map<String, Value>) -> bool {
    let before = usage.len();
    let estimated = usage.get("cost").and_then(|c| c.get("estimated_usd")).cloned();
    usage.retain(|k, _| DISPLAY_USAGE_FIELDS.contains(&k.as_str()));
    let mut changed = usage.len() != before;
    if let Some(v) = estimated {
        changed |= usage.get("cost").and_then(Value::as_object).is_none_or(|c| c.len() != 1);
        usage.insert("cost".into(), serde_json::json!({ "estimated_usd": v }));
    }
    changed
}

/// The `MessageResponse` wire shape (strips `extra.parts`, internal
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
        if !DISPLAY_REWRITTEN_EXTRA_KEYS.iter().any(|k| text.contains(k)) {
            return pass(raw_col(raw).map(Json::Raw));
        }
        let Some(mut extra) = crate::codec::json_col(raw) else { return pass(None) };
        let mut out = DisplayExtra { extra: None, attachments: None, hide_reasoning: false };
        if let Value::Object(ref mut e) = extra {
            out.hide_reasoning = e.get("is_continuation").map(truthy).unwrap_or(false);
            if let Some(Value::Array(atts)) = e.get("attachments") {
                let public = atts
                    .iter()
                    .map(|a| match a {
                        Value::Object(obj) => {
                            Value::Object(obj.iter().filter(|(k, _)| !INTERNAL_ATTACHMENT_FIELDS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect())
                        }
                        other => other.clone(),
                    })
                    .collect();
                out.attachments = Some(Value::Array(public));
            }
            let mut stripped = false;
            for key in DISPLAY_STRIPPED_EXTRA_FIELDS {
                stripped |= e.remove(key).is_some();
            }
            if let Some(Value::Object(usage)) = e.get_mut("usage") {
                stripped |= trim_usage(usage);
                if usage.is_empty() {
                    e.remove("usage");
                }
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

/// Bytes `extra` takes on the wire once display has rewritten it.
pub fn display_extra_len(raw: Option<&str>) -> usize {
    match DisplayExtra::of(raw).extra {
        None => 0,
        Some(Json::Raw(r)) => r.get().len(),
        Some(Json::Owned(v)) => serde_json::to_vec(&v).map_or(0, |b| b.len()),
    }
}

/// The stored `tool_calls` with long arguments sent short
/// ([`crate::tool_args::display_args`]), each such call carrying
/// `arguments_bytes`; `None` when every call goes out as stored.
fn display_tool_calls(raw: &RawValue) -> Option<Value> {
    let text = raw.get();
    // Tool names are plain ASCII: a call to none of these leaves the text alone.
    if !["\"shell\"", "\"patch\"", "\"plan\""].iter().any(|n| text.contains(n)) {
        return None;
    }
    let Ok(Value::Array(mut calls)) = serde_json::from_str::<Value>(text) else { return None };
    let mut changed = false;
    for call in calls.iter_mut() {
        let Some(call) = call.as_object_mut() else { continue };
        let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) else { continue };
        let (Some(name), Some(args)) = (function.get("name").and_then(Value::as_str), function.get("arguments").and_then(Value::as_str)) else {
            continue;
        };
        let Some(short) = crate::tool_args::display_args(name, args) else { continue };
        let full = args.len();
        function.insert("arguments".into(), Value::String(short));
        call.insert("arguments_bytes".into(), Value::from(full));
        changed = true;
    }
    changed.then_some(Value::Array(calls))
}

/// The stored `tool_calls` column as display shapes it: `None` when it is
/// not a JSON array.
fn tool_calls_json(raw: Option<&str>) -> Option<Json<'_>> {
    let v = raw_col(raw).filter(|v| v.get().starts_with('['))?;
    Some(display_tool_calls(v).map_or(Json::Raw(v), Json::Owned))
}

/// Bytes `tool_calls` takes on the wire once display has shortened it.
pub fn display_tool_calls_len(raw: Option<&str>) -> usize {
    match tool_calls_json(raw) {
        None => 0,
        Some(Json::Raw(r)) => r.get().len(),
        Some(Json::Owned(v)) => serde_json::to_vec(&v).map_or(0, |b| b.len()),
    }
}

impl Serialize for MessageView<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let r = self.0;
        let display = DisplayExtra::of(r.extra.as_deref());
        let tool_calls = tool_calls_json(r.tool_calls.as_deref());
        let reasoning = r.reasoning_content.as_deref().filter(|_| !display.hide_reasoning);
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("id", &api_uuid(&r.id))?;
        m.serialize_entry("role", &r.role)?;
        if let Some(v) = &r.content {
            if r.role == "tool" && !r.name.as_deref().is_some_and(|n| result_rides_inline(n, v)) {
                m.serialize_entry("result_omitted", &true)?;
                m.serialize_entry("result_bytes", &v.len())?;
            } else {
                m.serialize_entry("content", v)?;
            }
        }
        if let Some(v) = reasoning {
            m.serialize_entry("reasoning_content", v)?;
        }
        if let Some(v) = &tool_calls {
            m.serialize_entry("tool_calls", v)?;
        }
        if let Some(v) = &r.tool_call_id {
            m.serialize_entry("tool_call_id", v)?;
        }
        if let Some(v) = &r.name {
            m.serialize_entry("name", v)?;
        }
        m.serialize_entry("seq", &r.seq)?;
        // A summary is `kind: "summary"`; clients read that.
        m.serialize_entry("kind", &r.kind)?;
        if let Some(v) = &display.extra {
            m.serialize_entry("extra", v)?;
        }
        m.serialize_entry("created_at", &api_dt(&r.created_at))?;
        if let Some(v) = &display.attachments {
            m.serialize_entry("attachments", v)?;
        }
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

/// The `PendingQuestionResponse` wire shape (note: `created_at` uses
/// `isoformat()` form, i.e. `+00:00`, not `Z`).
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
    use crate::models::kind;
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
        assert_eq!(keys(&m), ["id", "role", "content", "seq", "kind", "created_at"]);
        assert_eq!(
            Value::Object(m),
            json!({"id": "01234567-89ab-cdef-0123-456789abcdef", "role": "user", "content": "hi ✓", "seq": 7, "kind": "chat", "created_at": "2026-09-23T06:56:28.225815Z"})
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
        r.extra = Some(r#"{"usage": {"output": 3}, "model": "m"}"#.into());
        r.kind = kind::SUMMARY.into();
        let m = message_response(&r);
        assert_eq!(keys(&m), ["id", "role", "content", "reasoning_content", "tool_calls", "tool_call_id", "name", "seq", "kind", "extra", "created_at"]);
        assert_eq!(m["tool_calls"], json!([{"id": "c1", "function": {"name": "read", "arguments": "{\"p\": \"Việt\"}"}}]));
        assert_eq!(m["extra"], json!({"usage": {"output": 3}, "model": "m"}));
        assert_eq!(m["kind"], json!("summary"));
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
        // Sent once, beside `extra` rather than inside it.
        assert_eq!(m["extra"], json!({"k": 1}));
        assert_eq!(m["attachments"], public);
        assert_eq!(keys(&m).last(), Some(&"attachments"));
        r.extra = Some(r#"{"attachments": [{"name": "a.pdf"}]}"#.into());
        let m = message_response(&r);
        assert!(!m.contains_key("extra"));
        assert_eq!(m["attachments"], json!([{"name": "a.pdf"}]));
    }

    /// A tool's output is read on demand: history carries how big it was,
    /// not the text. Tools whose card is built from their answer keep it.
    #[test]
    fn message_response_leaves_out_tool_output_but_keeps_answers_cards_need() {
        let mut r = row("tool");
        r.name = Some("read".into());
        r.tool_call_id = Some("c1".into());
        r.content = Some("[1-2/2]\nVi\u{1ec7}t\nb".into());
        r.extra = Some(r#"{"duration_ms": 4}"#.into());
        let m = message_response(&r);
        assert!(!m.contains_key("content"));
        assert_eq!(m["result_omitted"], json!(true));
        assert_eq!(m["result_bytes"], json!("[1-2/2]\nVi\u{1ec7}t\nb".len()));
        assert_eq!(m["extra"], json!({"duration_ms": 4}));
        for name in ["ask_user", "plan", "submit_plan", "update_goal"] {
            r.name = Some(name.into());
            let m = message_response(&r);
            assert_eq!(m["content"], json!("[1-2/2]\nVi\u{1ec7}t\nb"), "{name}");
            assert!(!m.contains_key("result_omitted"), "{name}");
        }
        for name in ["todo", "todo_manage", "schedule", "schedule_task"] {
            r.name = Some(name.into());
            assert!(!message_response(&r).contains_key("content"), "{name}");
        }
        r.name = None;
        assert!(!message_response(&r).contains_key("content"), "an unnamed tool row is output too");
        let mut user = row("user");
        user.content = Some("hi".into());
        assert_eq!(message_response(&user)["content"], json!("hi"));
    }

    /// Some cards read one kind of answer only (an opened preview, the
    /// session a send reached, a failed patch): that one comes with the call,
    /// the rest of the tool's output is fetched on open.
    #[test]
    fn only_the_answers_a_card_reads_ride_with_the_call() {
        let inline = [
            ("preview", "Opening src/a.html in the user's Preview tab (served at http://127.0.0.1:1/a.html)."),
            ("workspace", "Sent to 'web' (/r/web) \u{2014} new session 01a00000-0000-7000-8000-000000000001 started."),
            ("send_to_workspace", "Sent to 'web' (/r/web) \u{2014} delivered to session 01a00000-0000-7000-8000-000000000001."),
            ("workspace", crate::queries::questions::PLACEHOLDER_RESULT),
            ("mcp", crate::queries::questions::PLACEHOLDER_RESULT),
            // The transcript offers Sign in at a call refused for it.
            ("mcp", "Error: MCP server 'excalidraw' is not ready (needs sign-in: connect it in Settings \u{2192} MCP)"),
            ("mcp", "Error: MCP server 'slack' is not ready (needs sign-in: connect it in Settings \u{2192} MCP): token expired"),
            ("team", "Subagent 'explorer#1' dispatched. Its deliverable arrives as a message."),
            ("team_send", "Message delivered to subagent 'worker#4'. It is working."),
            ("delegate", "Subagent 'researcher#2' dispatched with task: Research X"),
            ("patch", "Error: Could not find scope in src/a.rs"),
        ];
        for (name, text) in inline {
            assert!(result_rides_inline(name, text), "{name}: {text}");
        }
        let fetched = [
            ("preview", "Console for http://localhost:5173 (newest first, 0 of 4 entries):\n(no entries)"),
            ("preview", "Error: No element matches [data-hero-video]."),
            ("workspace", "Workspaces you can message (name \u{2014} path):\n- Chat"),
            ("workspace", "The user applied the change. 'openagentd' is now in group x."),
            ("mcp", "1 tool (run one with action='call', server, tool and arguments):"),
            ("mcp", "The user applied the change. MCP server 'atlassian' saved."),
            ("mcp", "Error: MCP server 'docs' is not ready (failed to start): exit 1"),
            ("mcp", "2 tools (run one with action='call', server, tool and arguments):\n{}\nNot ready: slack (needs sign-in: connect it in Settings \u{2192} MCP)."),
            ("team", "- explorer#1: done (report delivered)\n- explorer#2: working"),
            ("team", "Error delegating to subagent: Member 'worker#8' not found"),
            ("patch", "@@ openagentd-diff-meta {\"files\":[]}\nPatch applied successfully. Updated paths:\na.rs"),
            ("todo", "Created task_1"),
            ("schedule", "Scheduled tasks (2):"),
            ("read", "[1-2/2]\na\nb"),
        ];
        for (name, text) in fetched {
            assert!(!result_rides_inline(name, text), "{name}: {text}");
        }
    }

    #[test]
    fn message_response_sends_long_tool_arguments_short_with_their_size() {
        let shell = json!({"command": "cargo test --workspace", "description": "Run every test"}).to_string();
        let read = json!({"path": "src/a.rs"}).to_string();
        let calls = json!([
            {"id": "c1", "type": "function", "function": {"name": "shell", "arguments": shell}},
            {"id": "c2", "type": "function", "function": {"name": "read", "arguments": read}},
        ]);
        let mut r = row("assistant");
        r.tool_calls = Some(calls.to_string());
        let m = message_response(&r);
        assert_eq!(
            m["tool_calls"],
            json!([
                {"id": "c1", "type": "function", "function": {"name": "shell", "arguments": r#"{"description":"Run every test"}"#}, "arguments_bytes": shell.len()},
                {"id": "c2", "type": "function", "function": {"name": "read", "arguments": read}},
            ])
        );
        assert_eq!(display_tool_calls_len(r.tool_calls.as_deref()), serde_json::to_string(&m["tool_calls"]).unwrap().len());

        // Nothing to cut: the stored text goes out unchanged.
        let stored = r#"[{"id": "c2", "function": {"name": "read", "arguments": "{\"path\": \"a\"}"}}]"#;
        r.tool_calls = Some(stored.into());
        assert!(serde_json::to_string(&MessageView(&r)).unwrap().contains(stored));
        assert_eq!(display_tool_calls_len(Some(stored)), stored.len());
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

    /// What a provider needs to replay its own turn (Anthropic's raw blocks
    /// and thinking signatures, OpenAI's reasoning items) is read from the
    /// database by the agent, never by a client; on the wire it was almost
    /// half of every history page.
    #[test]
    fn message_response_leaves_out_provider_replay_state() {
        let mut r = row("assistant");
        r.extra = Some(
            r#"{"raw_content_blocks": [{"type": "thinking", "thinking": "t", "signature": "s"}], "reasoning_signature": "sig", "reasoning_items": [{"id": "rs_1"}], "model": "m"}"#
                .into(),
        );
        assert_eq!(message_response(&r)["extra"], json!({"model": "m"}));
        r.extra = Some(r#"{"reasoning_signature": "sig"}"#.into());
        assert!(!message_response(&r).contains_key("extra"));
    }

    /// Usage goes out as the fields a turn's footer and the session total
    /// read (`utils/messages.ts`); the cost breakdown, cache writes, the
    /// stop reason, the pinned credential and the undo snapshot stay on
    /// the server.
    #[test]
    fn message_response_sends_only_the_extra_clients_read() {
        let mut r = row("assistant");
        r.extra = Some(
            r#"{"usage": {"input": 73984, "output": 293, "cache": 73033, "cache_write": 949, "thoughts": 12, "cache_percent": 98.7, "estimated_cost_usd": 0.02, "cost": {"estimated_usd": 0.0252196, "cache_read_usd": 0.0146, "cache_write_usd": 0.0047, "input_usd": 8e-6, "output_usd": 0.0058}}, "finish_reason": "tool_calls", "duration_ms": 76745.8, "model": "claude:x", "thinking_level": "high", "credential_id": "cred_1", "credential_label": "fyc", "thinking_duration_ms": 5.8}"#
                .into(),
        );
        assert_eq!(
            message_response(&r)["extra"],
            json!({"usage": {"input": 73984, "output": 293, "cache": 73033, "cache_percent": 98.7, "estimated_cost_usd": 0.02, "cost": {"estimated_usd": 0.0252196}}, "duration_ms": 76745.8, "model": "claude:x", "thinking_level": "high", "credential_label": "fyc", "thinking_duration_ms": 5.8})
        );
        // Nothing a client reads: no `usage` and no `extra` at all.
        r.extra = Some(r#"{"usage": {"cache_write": 1, "cost": {"input_usd": 1}}, "finish_reason": "stop"}"#.into());
        assert!(!message_response(&r).contains_key("extra"));
        let mut user = row("user");
        user.extra = Some(r#"{"snapshot": "abc123", "mentions": ["a.rs"]}"#.into());
        assert_eq!(message_response(&user)["extra"], json!({"mentions": ["a.rs"]}));
        assert_eq!(display_extra_len(user.extra.as_deref()), r#"{"mentions":["a.rs"]}"#.len());
    }

    #[test]
    fn messages_view_bytes_match_message_response() {
        let mut a = row("assistant");
        a.tool_calls = Some(r#"[{"id": "c1", "args": "Vi\u1ec7t"}]"#.into());
        a.extra = Some(r#"{"usage": {"output": 1.5, "cache_write": 2}, "model": "m"}"#.into());
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
