//! Stream event payloads — port of `app/agent/schemas/events.py` and
//! `app/services/stream_envelope.py`.
//!
//! Payloads are JSON maps in v2 Pydantic field order (serde_json
//! `preserve_order`); every typed event carries `type` first and `metadata`
//! last, with `None` fields serialised as `null` like `model_dump(mode="json")`.

use serde_json::{json, Map, Value};
use std::sync::{Arc, OnceLock};

// ── Wire contract ───────────────────────────────────────────────────────────

const CONTRACT_JSON: &str = include_str!("../data/sse_events.json");

/// Which SSE stream an event travels on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    /// `/api/agent/{sid}/stream` (the stream store).
    Session,
    /// `/api/events/stream` (the broadcaster).
    Global,
    /// The response of `POST /api/agent/sessions/{sid}/btw`.
    SideQuestion,
}

type ContractLists = (Vec<String>, Vec<String>, Vec<String>);

fn contract() -> &'static ContractLists {
    static C: OnceLock<ContractLists> = OnceLock::new();
    C.get_or_init(|| {
        let v: Value = serde_json::from_str(CONTRACT_JSON).expect("sse_events.json");
        let names = |k: &str| v[k].as_array().expect(k).iter().map(|n| n.as_str().expect("event name").to_string()).collect::<Vec<_>>();
        (names("session_stream"), names("global_stream"), names("side_question_stream"))
    })
}

/// Whether `appv3/crates/agent/data/sse_events.json` lists `name` for `stream`.
pub fn in_contract(stream: Stream, name: &str) -> bool {
    let (session, global, side) = contract();
    let list = match stream {
        Stream::Session => session,
        Stream::Global => global,
        Stream::SideQuestion => side,
    };
    list.iter().any(|n| n == name)
}

/// Every emitted name must be in the shared contract so the web client can
/// be checked against it. Panics in debug builds (tests, `cargo run`) so a
/// new event cannot ship unregistered; release builds only log.
pub fn check_contract(stream: Stream, name: &str) {
    if !in_contract(stream, name) {
        tracing::error!("sse_event_not_in_contract stream={:?} event={}", stream, name);
        debug_assert!(false, "SSE event {name:?} ({stream:?} stream) is missing from appv3/crates/agent/data/sse_events.json");
    }
}

/// One SSE frame on the wire: `event:` line + compact JSON `data:`.
#[derive(Debug, Clone, PartialEq)]
pub struct WireEvent {
    pub event: String,
    pub data: String,
}

impl WireEvent {
    /// `event: X\ndata: Y\n\n` (sse_starlette framing, `\r\n` normalised to `\n`).
    pub fn to_sse(&self) -> String {
        let mut s = String::with_capacity(self.data.len() + self.event.len() + 16);
        s.push_str("event: ");
        s.push_str(&self.event);
        s.push_str("\r\n");
        for line in self.data.split('\n') {
            s.push_str("data: ");
            s.push_str(line);
            s.push_str("\r\n");
        }
        s.push_str("\r\n");
        s
    }
}

/// Typed wrapper around one event + parsed payload (v2 `StreamEnvelope`).
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub event: String,
    pub data: Map<String, Value>,
}

impl Envelope {
    /// `StreamEnvelope.from_parts`.
    pub fn from_parts(event: impl Into<String>, data: Value) -> Self {
        let data = match data {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        Self { event: event.into(), data }
    }
    /// `StreamEnvelope.from_event`: `event` mirrors `data["type"]`.
    pub fn typed(data: Value) -> Self {
        let event = data.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
        Self::from_parts(event, data)
    }
    pub fn agent(&self) -> &str {
        self.data.get("agent").and_then(|a| a.as_str()).unwrap_or("")
    }
    pub fn field(&self, name: &str) -> Option<&Value> {
        self.data.get(name)
    }
    pub fn str_field(&self, name: &str) -> Option<&str> {
        self.data.get(name).and_then(|v| v.as_str())
    }
    /// orjson-compatible compact encoding (non-ASCII kept verbatim).
    /// Serializes the map by reference: this runs once per token while a
    /// client is attached, so a clone of the payload here is pure overhead.
    pub fn to_wire(&self) -> Arc<WireEvent> {
        Arc::new(WireEvent { event: self.event.clone(), data: serde_json::to_string(&self.data).unwrap_or_else(|_| "{}".into()) })
    }
}

/// orjson.dumps equivalent for our payloads.
pub fn compact(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
}

fn meta(m: Option<Value>) -> Value {
    match m {
        Some(Value::Object(o)) => Value::Object(o),
        _ => Value::Object(Map::new()),
    }
}

// ── Builders (field order == v2 Pydantic models) ─────────────────────────────

pub fn session(session_id: &str) -> Envelope {
    Envelope::typed(json!({"type": "session", "session_id": session_id, "metadata": {}}))
}

pub fn thinking(agent: &str, text: &str, metadata: Option<Value>) -> Envelope {
    Envelope::typed(json!({"type": "thinking", "agent": agent, "text": text, "metadata": meta(metadata)}))
}

pub fn message(agent: &str, text: &str, metadata: Option<Value>) -> Envelope {
    Envelope::typed(json!({"type": "message", "agent": agent, "text": text, "metadata": meta(metadata)}))
}

pub fn tool_call(agent: &str, tool_call_id: Option<&str>, name: &str) -> Envelope {
    Envelope::typed(json!({"type": "tool_call", "agent": agent, "tool_call_id": tool_call_id, "name": name, "metadata": {}}))
}

pub fn tool_start(agent: &str, tool_call_id: Option<&str>, name: &str, arguments: Option<&str>) -> Envelope {
    Envelope::typed(json!({
        "type": "tool_start", "agent": agent, "tool_call_id": tool_call_id, "name": name,
        "arguments": arguments, "metadata": {}
    }))
}

pub fn tool_end(agent: &str, tool_call_id: Option<&str>, name: &str, result: Option<&str>, metadata: Option<Value>) -> Envelope {
    Envelope::typed(json!({
        "type": "tool_end", "agent": agent, "tool_call_id": tool_call_id, "name": name,
        "result": result, "metadata": meta(metadata)
    }))
}

pub fn tool_output_delta(agent: &str, tool_call_id: Option<&str>, name: &str, text: &str, sequence: i64) -> Envelope {
    Envelope::typed(json!({
        "type": "tool_output_delta", "agent": agent, "tool_call_id": tool_call_id, "name": name,
        "text": text, "stream": "combined", "sequence": sequence, "metadata": {}
    }))
}

#[derive(Debug, Clone, Default)]
pub struct UsageFrame {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: Option<i64>,
    pub thoughts_tokens: Option<i64>,
    pub tool_use_tokens: Option<i64>,
    pub estimated_cost_usd: Option<Value>,
}

pub fn usage(u: &UsageFrame, metadata: Value) -> Envelope {
    Envelope::typed(json!({
        "type": "usage",
        "prompt_tokens": u.prompt_tokens,
        "completion_tokens": u.completion_tokens,
        "total_tokens": u.total_tokens,
        "cached_tokens": u.cached_tokens,
        "thoughts_tokens": u.thoughts_tokens,
        "tool_use_tokens": u.tool_use_tokens,
        "estimated_cost_usd": u.estimated_cost_usd.clone().unwrap_or(Value::Null),
        "metadata": meta(Some(metadata)),
    }))
}

pub fn done(metadata: Option<Value>) -> Envelope {
    Envelope::typed(json!({"type": "done", "metadata": meta(metadata)}))
}

pub fn rate_limit(retry_after: i64, attempt: i64, max_attempts: i64) -> Envelope {
    Envelope::typed(json!({
        "type": "rate_limit", "retry_after": retry_after, "attempt": attempt,
        "max_attempts": max_attempts, "metadata": {}
    }))
}

#[derive(Debug, Clone, Default)]
pub struct ProviderStatus {
    pub status: String,
    pub model: Option<String>,
    pub attempt: Option<i64>,
    pub max_attempts: Option<i64>,
    pub delay_seconds: Option<f64>,
    pub error_type: Option<String>,
    pub status_code: Option<i64>,
    pub retry_after: Option<i64>,
    pub message: Option<String>,
    pub resets_at: Option<i64>,
}

pub fn provider_status(agent: &str, p: &ProviderStatus) -> Envelope {
    Envelope::typed(json!({
        "type": "provider_status",
        "agent": agent,
        "status": p.status,
        "model": p.model,
        "attempt": p.attempt,
        "max_attempts": p.max_attempts,
        "delay_seconds": p.delay_seconds,
        "error_type": p.error_type,
        "status_code": p.status_code,
        "retry_after": p.retry_after,
        "message": p.message,
        "resets_at": p.resets_at,
        "metadata": {},
    }))
}

pub fn agent_not_configured(agent: &str, message: &str) -> Envelope {
    Envelope::typed(json!({
        "type": "agent_not_configured", "agent": agent, "message": message,
        "action": {"type": "open_settings", "tab": "providers"}
    }))
}

pub fn agent_status(agent: &str, status: &str, metadata: Option<Value>) -> Envelope {
    Envelope::typed(json!({"type": "agent_status", "agent": agent, "status": status, "metadata": meta(metadata)}))
}

pub fn permission_asked(request_id: &str, session_id: &str, tool: &str, patterns: &[String], metadata: Value) -> Envelope {
    Envelope::typed(json!({
        "type": "permission_asked", "request_id": request_id, "session_id": session_id,
        "tool": tool, "patterns": patterns, "metadata": meta(Some(metadata))
    }))
}

pub fn question_asked(question_id: &str, session_id: &str, tool_call_id: &str, questions: &[Value]) -> Envelope {
    Envelope::typed(json!({
        "type": "question_asked", "question_id": question_id, "session_id": session_id,
        "tool_call_id": tool_call_id, "questions": questions, "metadata": {}
    }))
}

pub fn question_answered(question_id: &str, session_id: &str, answers: &Value) -> Envelope {
    Envelope::typed(json!({
        "type": "question_answered", "question_id": question_id, "session_id": session_id,
        "answers": answers, "metadata": {}
    }))
}

/// `question_asked` for a plan review: the same event, with `kind` and
/// `plan_revision` so clients show the Plan panel instead of a question card.
pub fn plan_review_asked(question_id: &str, session_id: &str, tool_call_id: &str, questions: &[Value], plan_revision: u64) -> Envelope {
    Envelope::typed(json!({
        "type": "question_asked", "question_id": question_id, "session_id": session_id,
        "tool_call_id": tool_call_id, "questions": questions, "kind": "plan_review",
        "plan_revision": plan_revision, "metadata": {}
    }))
}

/// The session's Plan/Code mode changed.
pub fn interaction_mode(agent: &str, mode: &str) -> Envelope {
    Envelope::typed(json!({"type": "interaction_mode", "agent": agent, "interaction_mode": mode}))
}

pub fn question_dismissed(question_id: &str, session_id: &str, reason: &str) -> Envelope {
    Envelope::typed(json!({
        "type": "question_dismissed", "question_id": question_id, "session_id": session_id,
        "reason": reason, "metadata": {}
    }))
}

pub fn summarization_start(agent: &str) -> Envelope {
    Envelope::typed(json!({"type": "summarization_start", "agent": agent, "metadata": {}}))
}

pub fn summarization_content(agent: &str, text: &str) -> Envelope {
    Envelope::typed(json!({"type": "summarization_content", "agent": agent, "text": text, "metadata": {}}))
}

pub fn summarization_end(agent: &str, summary: &str, metadata: Option<Value>) -> Envelope {
    Envelope::typed(json!({"type": "summarization_end", "agent": agent, "summary": summary, "metadata": meta(metadata)}))
}

// ── `/btw` side-question stream ──────────────────────────────────────────────

fn side(data: Value) -> Envelope {
    let e = Envelope::typed(data);
    check_contract(Stream::SideQuestion, &e.event);
    e
}

pub fn btw_start(id: &str, question: &str) -> Envelope {
    side(json!({"type": "btw_start", "id": id, "question": question}))
}

pub fn btw_delta(id: &str, text: &str) -> Envelope {
    side(json!({"type": "btw_delta", "id": id, "text": text}))
}

pub fn btw_done(id: &str, answer: &str, model: Option<&str>, usage: Option<&Value>) -> Envelope {
    side(json!({"type": "btw_done", "id": id, "answer": answer, "model": model, "usage": usage}))
}

/// The answer ended without completing: `status` is `error` or `stopped`,
/// and `answer` holds what was written before.
pub fn btw_error(id: &str, status: &str, message: &str, answer: &str) -> Envelope {
    side(json!({"type": "btw_error", "id": id, "status": status, "message": message, "answer": answer}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builder_emits_a_contract_name() {
        let builders = [
            session("s"),
            thinking("a", "t", None),
            message("a", "t", None),
            tool_call("a", None, "read"),
            tool_start("a", None, "read", None),
            tool_end("a", None, "read", None, None),
            tool_output_delta("a", None, "read", "x", 1),
            usage(&UsageFrame::default(), json!({})),
            done(None),
            rate_limit(1, 1, 3),
            provider_status("a", &ProviderStatus::default()),
            agent_not_configured("a", "m"),
            agent_status("a", "idle", None),
            permission_asked("r", "s", "read", &[], json!({})),
            question_asked("q", "s", "c", &[]),
            question_answered("q", "s", &json!({})),
            plan_review_asked("q", "s", "c", &[], 1),
            interaction_mode("a", "code"),
            question_dismissed("q", "s", "dismissed"),
            summarization_start("a"),
            summarization_content("a", "t"),
            summarization_end("a", "t", None),
        ];
        for e in builders {
            assert!(in_contract(Stream::Session, &e.event), "{}", e.event);
        }
        for e in [btw_start("i", "q"), btw_delta("i", "t"), btw_done("i", "a", None, None), btw_error("i", "error", "m", "")] {
            assert!(in_contract(Stream::SideQuestion, &e.event), "{}", e.event);
        }
    }

    #[test]
    fn contract_lists_are_unique() {
        let (session, global, side) = contract();
        for list in [session, global, side] {
            let mut sorted = list.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), list.len(), "duplicate event names: {list:?}");
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "missing from appv3/crates/agent/data/sse_events.json")]
    fn unregistered_events_fail_loudly_in_debug_builds() {
        check_contract(Stream::Global, "not_a_real_event");
    }

    #[test]
    fn field_order_and_nulls_match_v2() {
        let e = tool_start("code", Some("c1"), "read", None);
        assert_eq!(e.to_wire().data, r#"{"type":"tool_start","agent":"code","tool_call_id":"c1","name":"read","arguments":null,"metadata":{}}"#);
        let n = agent_not_configured("code", "m");
        assert_eq!(n.to_wire().data, r#"{"type":"agent_not_configured","agent":"code","message":"m","action":{"type":"open_settings","tab":"providers"}}"#);
        assert_eq!(message("a", "héllo", None).to_wire().data, r#"{"type":"message","agent":"a","text":"héllo","metadata":{}}"#);
    }
}
