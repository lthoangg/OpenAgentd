//! In-memory SSE stream store — port of `app/services/memory_stream_store.py`.
//!
//! Per-session turn blob for reconnect replay plus live subscriber fan-out.
//! Single-process only, like v2.

use crate::events::{self, Envelope, WireEvent};
use crate::queue::SubQueue;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const STREAM_TTL: Duration = Duration::from_secs(3600);
pub const FINISHED_TURN_TTL: Duration = Duration::from_secs(60);
pub const MAX_TURN_LIFETIME: Duration = Duration::from_secs(4 * 3600);
pub const SUBSCRIBER_QUEUE_SIZE: usize = 2048;

type Sub = Arc<SubQueue<Arc<WireEvent>>>;

#[derive(Default)]
struct TurnState {
    is_streaming: bool,
    // IndexMap-like ordering: v2 dicts keep insertion order.
    content: Vec<(String, String)>,
    thinking: Vec<(String, String)>,
    tool_calls: Vec<Map<String, Value>>,
    agent_statuses: Vec<(String, String)>,
    agent_errors: HashMap<String, Value>,
    summarization: Vec<(String, Summ)>,
    usage: Option<Map<String, Value>>,
    error: Option<String>,
    agent_not_configured: Option<Map<String, Value>>,
    queued_turns: Vec<Map<String, Value>>,
    /// The turn's open `question_asked` (question id, frame), replayed last on
    /// every attach: a client that missed the live frame (a reattach, a feed
    /// that went quiet) otherwise saw the agent waiting with no card to answer.
    open_question: Option<(String, Arc<WireEvent>)>,
    subscribers: Vec<Sub>,
    created_at: Option<Instant>,
    deadline: Option<Instant>,
}

#[derive(Clone, Default)]
struct Summ {
    text: String,
    done: bool,
    error: bool,
}

fn entry<'a, T: Default>(v: &'a mut Vec<(String, T)>, key: &str) -> &'a mut T {
    if let Some(i) = v.iter().position(|(k, _)| k == key) {
        return &mut v[i].1;
    }
    v.push((key.to_string(), T::default()));
    &mut v.last_mut().unwrap().1
}

fn remove<T>(v: &mut Vec<(String, T)>, key: &str) -> Option<T> {
    v.iter().position(|(k, _)| k == key).map(|i| v.remove(i).1)
}

impl TurnState {
    fn fresh(now: Instant) -> Self {
        Self { is_streaming: true, created_at: Some(now), deadline: Some(now + STREAM_TTL), ..Default::default() }
    }
    fn reset_for_next_turn(&mut self) {
        self.is_streaming = true;
        self.content.clear();
        self.thinking.clear();
        self.tool_calls.clear();
        self.agent_statuses.clear();
        self.agent_errors.clear();
        self.summarization.clear();
        self.usage = None;
        self.error = None;
        self.agent_not_configured = None;
        self.queued_turns.clear();
        self.open_question = None;
    }
    fn clear_replay_payload(&mut self) {
        self.content.clear();
        self.thinking.clear();
        self.tool_calls.clear();
        self.summarization.clear();
        self.usage = None;
        self.error = None;
        self.agent_not_configured = None;
        self.queued_turns.clear();
    }
}

fn tc_str<'a>(tc: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    tc.get(k).and_then(|v| v.as_str())
}
fn tc_bool(tc: &Map<String, Value>, k: &str) -> bool {
    tc.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// `_tool_state.match_tool_start`.
fn match_tool_start(tcs: &mut Vec<Map<String, Value>>, id: Option<&str>, name: &str, arguments: Value, agent: &str) {
    for tc in tcs.iter_mut().rev() {
        let hit = match id {
            Some(i) if !i.is_empty() => tc_str(tc, "tool_call_id") == Some(i),
            _ => tc_str(tc, "name") == Some(name) && !tc_bool(tc, "started"),
        };
        if hit {
            tc.insert("arguments".into(), arguments);
            tc.insert("started".into(), Value::Bool(true));
            if !agent.is_empty() && tc_str(tc, "agent").map(|a| a.is_empty()).unwrap_or(true) {
                tc.insert("agent".into(), Value::String(agent.into()));
            }
            return;
        }
    }
    let mut m = Map::new();
    m.insert("tool_call_id".into(), id.map(|s| Value::String(s.into())).unwrap_or(Value::Null));
    m.insert("name".into(), Value::String(name.into()));
    m.insert("arguments".into(), arguments);
    m.insert("agent".into(), Value::String(agent.into()));
    m.insert("started".into(), Value::Bool(true));
    m.insert("done".into(), Value::Bool(false));
    tcs.push(m);
}

/// `_tool_state.match_tool_end`.
fn match_tool_end(tcs: &mut Vec<Map<String, Value>>, id: Option<&str>, name: &str, result: Value, agent: &str) {
    let by_id = id.filter(|s| !s.is_empty()).and_then(|i| tcs.iter().rposition(|tc| tc_str(tc, "tool_call_id") == Some(i)));
    let hit = by_id.or_else(|| tcs.iter().rposition(|tc| tc_str(tc, "name") == Some(name) && !tc_bool(tc, "done")));
    if let Some(i) = hit {
        let tc = &mut tcs[i];
        tc.insert("done".into(), Value::Bool(true));
        tc.insert("result".into(), result);
        if !agent.is_empty() && tc_str(tc, "agent").map(|a| a.is_empty()).unwrap_or(true) {
            tc.insert("agent".into(), Value::String(agent.into()));
        }
        return;
    }
    let mut m = Map::new();
    m.insert("tool_call_id".into(), id.map(|s| Value::String(s.into())).unwrap_or(Value::Null));
    m.insert("name".into(), Value::String(name.into()));
    m.insert("arguments".into(), Value::Null);
    m.insert("result".into(), result);
    m.insert("agent".into(), Value::String(agent.into()));
    m.insert("started".into(), Value::Bool(true));
    m.insert("done".into(), Value::Bool(true));
    tcs.push(m);
}

const REPLAYABLE_STATUSES: [&str; 5] = ["idle", "working", "waiting_input", "offline", "error"];

#[derive(Default)]
pub struct StreamStore {
    turns: Mutex<HashMap<String, TurnState>>,
}

pub fn store() -> &'static StreamStore {
    static S: OnceLock<StreamStore> = OnceLock::new();
    S.get_or_init(StreamStore::default)
}

impl StreamStore {
    /// `init_turn`.
    pub fn init_turn(&self, session_id: &str, keep_subscribers: bool) {
        let now = Instant::now();
        let mut turns = self.turns.lock().unwrap();
        if let Some(old) = turns.get_mut(session_id) {
            if keep_subscribers {
                old.reset_for_next_turn();
                old.created_at = Some(now);
                old.deadline = Some(now + STREAM_TTL);
                return;
            }
            for q in &old.subscribers {
                q.terminate();
            }
        }
        turns.insert(session_id.to_string(), TurnState::fresh(now));
    }

    /// `ensure_turn`.
    pub fn ensure_turn(&self, session_id: &str) {
        let exists = self.turns.lock().unwrap().contains_key(session_id);
        if !exists {
            self.init_turn(session_id, false);
        }
    }

    pub fn has_turn(&self, session_id: &str) -> bool {
        self.turns.lock().unwrap().contains_key(session_id)
    }

    /// `push_event`.
    pub fn push_event(&self, session_id: &str, env: &Envelope, create_if_missing: bool) {
        crate::events::check_contract(crate::events::Stream::Session, &env.event);
        let now = Instant::now();
        let mut turns = self.turns.lock().unwrap();
        if !turns.contains_key(session_id) {
            if !create_if_missing {
                return;
            }
            turns.insert(session_id.to_string(), TurnState::fresh(now));
        }
        let state = turns.get_mut(session_id).unwrap();
        let data = &env.data;
        let agent = env.agent();
        let get_str = |k: &str| data.get(k).and_then(|v| v.as_str());
        match env.event.as_str() {
            "message" => {
                if let Some(t) = get_str("text").filter(|t| !t.is_empty()) {
                    entry(&mut state.content, agent).push_str(t);
                }
            }
            "thinking" => {
                if let Some(t) = get_str("text").filter(|t| !t.is_empty()) {
                    entry(&mut state.thinking, agent).push_str(t);
                }
            }
            "tool_call" => {
                let mut m = Map::new();
                m.insert("tool_call_id".into(), data.get("tool_call_id").cloned().unwrap_or(Value::Null));
                m.insert("name".into(), Value::String(get_str("name").unwrap_or("").into()));
                m.insert("arguments".into(), Value::Null);
                m.insert("agent".into(), Value::String(agent.into()));
                m.insert("started".into(), Value::Bool(false));
                m.insert("done".into(), Value::Bool(false));
                state.tool_calls.push(m);
            }
            "tool_start" => {
                match_tool_start(&mut state.tool_calls, get_str("tool_call_id"), get_str("name").unwrap_or(""), data.get("arguments").cloned().unwrap_or(Value::Null), agent)
            }
            "tool_end" => match_tool_end(&mut state.tool_calls, get_str("tool_call_id"), get_str("name").unwrap_or(""), data.get("result").cloned().unwrap_or(Value::Null), agent),
            "usage" => state.usage = Some(data.clone()),
            "error" => state.error = Some(get_str("message").unwrap_or("error").to_string()),
            "done" => state.is_streaming = false,
            "agent_not_configured" => state.agent_not_configured = Some(data.clone()),
            "queued_turn_start" => state.queued_turns.push(data.clone()),
            "question_asked" => {
                if let Some(qid) = get_str("question_id") {
                    state.open_question = Some((qid.to_string(), env.to_wire()));
                }
            }
            "question_answered" | "question_dismissed" => {
                let resolved = get_str("question_id");
                if state.open_question.as_ref().is_some_and(|(qid, _)| resolved.is_none_or(|r| r == qid)) {
                    state.open_question = None;
                }
            }
            "agent_status" => {
                let status = get_str("status").unwrap_or("");
                if !agent.is_empty() && !status.is_empty() {
                    *entry(&mut state.agent_statuses, agent) = status.to_string();
                    if status == "error" {
                        let meta = data.get("metadata").filter(|m| m.as_object().map(|o| !o.is_empty()).unwrap_or(false));
                        let err = match meta {
                            Some(m) => m.clone(),
                            None => json!({
                                "message": data.get("message"),
                                "title": data.get("title"),
                                "code": data.get("code"),
                                "category": data.get("category"),
                            }),
                        };
                        state.agent_errors.insert(agent.to_string(), err);
                    } else {
                        state.agent_errors.remove(agent);
                    }
                }
            }
            "summarization_start" if !agent.is_empty() => {
                *entry(&mut state.summarization, agent) = Summ::default();
            }
            "summarization_content" => {
                let text = get_str("text").unwrap_or("");
                if !agent.is_empty() && !text.is_empty() {
                    entry(&mut state.summarization, agent).text.push_str(text);
                }
            }
            "summarization_end" if !agent.is_empty() => {
                let e = entry(&mut state.summarization, agent);
                if let Some(s) = get_str("summary").filter(|s| !s.is_empty()) {
                    e.text = s.to_string();
                }
                e.done = true;
                let err = data.get("metadata").and_then(|m| m.get("error"));
                if err.map(truthy).unwrap_or(false) {
                    e.error = true;
                }
            }
            _ => {}
        }
        // Sliding TTL, capped at the hard lifetime.
        let created = state.created_at.unwrap_or(now);
        state.deadline = Some((now + STREAM_TTL).min(created + MAX_TURN_LIFETIME));

        if state.subscribers.is_empty() {
            return;
        }
        let wire = env.to_wire();
        state.subscribers.retain(|q| {
            if q.push(wire.clone()) {
                true
            } else {
                tracing::warn!("sse_subscriber_queue_full session_id={} event_type={} dropping_client qsize={}", session_id, env.event, q.len());
                q.terminate();
                false
            }
        });
    }

    /// A session parked on the open question `row`: make sure it has a turn
    /// to attach to (nothing is running) and that the attach replays the
    /// question, so the card shows on any client that attaches.
    ///
    /// Only a turn created here is seeded. An existing turn is either the
    /// suspended one, which already holds the live frame, or a new turn that
    /// superseded `row` after it was read; seeding that one would replay a
    /// closed question. Check and insert happen under one lock for the same
    /// reason.
    pub fn ensure_parked_turn(&self, session_id: &str, row: &appv3_db::PendingQuestion) {
        let qid = appv3_db::codec::api_uuid(&row.id);
        let questions = row.questions();
        let env = match (row.kind().as_deref(), row.plan_revision()) {
            (Some(crate::plan::PLAN_REVIEW_KIND), Some(revision)) => events::plan_review_asked(&qid, session_id, &row.tool_call_id, &questions, revision),
            _ => events::question_asked(&qid, session_id, &row.tool_call_id, &questions),
        };
        let mut turns = self.turns.lock().unwrap();
        if turns.contains_key(session_id) {
            return;
        }
        let mut state = TurnState::fresh(Instant::now());
        state.open_question = Some((qid, env.to_wire()));
        turns.insert(session_id.to_string(), state);
    }

    /// `commit_agent_content`.
    pub fn commit_agent_content(&self, session_id: &str, agent: &str) {
        let mut turns = self.turns.lock().unwrap();
        let Some(state) = turns.get_mut(session_id) else {
            return;
        };
        remove(&mut state.content, agent);
        remove(&mut state.thinking, agent);
        if let Some(i) = state.summarization.iter().position(|(k, _)| k == agent) {
            let s = &state.summarization[i].1;
            if s.done && !s.error {
                state.summarization.remove(i);
            }
        }
        state.tool_calls.retain(|tc| tc_str(tc, "agent") != Some(agent));
    }

    /// `mark_done`.
    pub fn mark_done(&self, session_id: &str) {
        let mut turns = self.turns.lock().unwrap();
        let Some(state) = turns.get_mut(session_id) else {
            return;
        };
        state.is_streaming = false;
        state.deadline = Some(Instant::now() + FINISHED_TURN_TTL);
        for q in &state.subscribers {
            q.terminate();
        }
    }

    /// `clear`.
    pub fn clear(&self, session_id: &str) {
        if let Some(state) = self.turns.lock().unwrap().remove(session_id) {
            for q in &state.subscribers {
                q.terminate();
            }
        }
    }

    pub fn close_all(&self) {
        let mut turns = self.turns.lock().unwrap();
        for state in turns.values() {
            for q in &state.subscribers {
                q.terminate();
            }
        }
        turns.clear();
    }

    pub fn running_session_ids(&self) -> Vec<String> {
        self.turns.lock().unwrap().iter().filter(|(_, s)| s.is_streaming).map(|(k, _)| k.clone()).collect()
    }

    pub fn is_running(&self, session_id: &str) -> bool {
        self.turns.lock().unwrap().get(session_id).map(|s| s.is_streaming).unwrap_or(false)
    }

    pub fn get_agent_statuses(&self, session_id: &str) -> Vec<(String, String)> {
        match self.turns.lock().unwrap().get(session_id) {
            Some(s) if s.is_streaming => s.agent_statuses.clone(),
            _ => Vec::new(),
        }
    }

    /// Expiry pass (replaces v2's per-turn `call_later` timers).
    pub fn sweep(&self, now: Instant) {
        let mut turns = self.turns.lock().unwrap();
        let mut expired = Vec::new();
        for (sid, st) in turns.iter_mut() {
            if st.deadline.map(|d| d > now).unwrap_or(true) {
                continue;
            }
            if st.is_streaming && !st.subscribers.is_empty() {
                st.clear_replay_payload();
                st.created_at = Some(now);
                st.deadline = Some(now + STREAM_TTL);
            } else {
                expired.push(sid.clone());
            }
        }
        for sid in expired {
            turns.remove(&sid);
        }
    }

    /// Background sweeper task (1s resolution).
    pub fn spawn_sweeper(&'static self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                self.sweep(Instant::now());
            }
        })
    }

    /// `attach`: registers a subscriber and snapshots the replay frames.
    /// `None` when there is no streaming turn (the DB is authoritative).
    pub fn attach(&'static self, session_id: &str) -> Option<Subscription> {
        let mut turns = self.turns.lock().unwrap();
        let state = turns.get_mut(session_id)?;
        if !state.is_streaming {
            return None;
        }
        let q: Sub = Arc::new(SubQueue::new(SUBSCRIBER_QUEUE_SIZE));
        state.subscribers.push(q.clone());
        let mut replay: Vec<Envelope> = Vec::new();
        for (agent, status) in &state.agent_statuses {
            if agent.is_empty() || !REPLAYABLE_STATUSES.contains(&status.as_str()) {
                continue;
            }
            let meta = state.agent_errors.get(agent).cloned().unwrap_or_else(|| json!({}));
            replay.push(events::agent_status(agent, status, Some(meta)));
        }
        if let Some(nc) = &state.agent_not_configured {
            let agent = nc.get("agent").and_then(|v| v.as_str()).unwrap_or("");
            let message = nc.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let mut e = events::agent_not_configured(agent, message);
            if let Some(a) = nc.get("action") {
                e.data.insert("action".into(), a.clone());
            }
            replay.push(e);
        }
        for (agent, s) in &state.summarization {
            if agent.is_empty() {
                continue;
            }
            replay.push(events::summarization_start(agent));
            if !s.text.is_empty() && !s.done {
                replay.push(events::summarization_content(agent, &s.text));
            }
            if s.done {
                let meta = if s.error { json!({"error": true}) } else { json!({}) };
                replay.push(events::summarization_end(agent, &s.text, Some(meta)));
            }
        }
        for qt in &state.queued_turns {
            replay.push(Envelope::from_parts("queued_turn_start", Value::Object(qt.clone())));
        }
        for (agent, text) in &state.thinking {
            if !text.is_empty() {
                replay.push(events::thinking(agent, text, None));
            }
        }
        for (agent, text) in &state.content {
            if !text.is_empty() {
                replay.push(events::message(agent, text, None));
            }
        }
        for tc in &state.tool_calls {
            let agent = tc_str(tc, "agent").unwrap_or("");
            let id = tc_str(tc, "tool_call_id");
            let name = tc_str(tc, "name").unwrap_or("");
            replay.push(events::tool_call(agent, id, name));
            if tc_bool(tc, "started") {
                let mut e = events::tool_start(agent, id, name, None);
                e.data.insert("arguments".into(), tc.get("arguments").cloned().unwrap_or(Value::Null));
                replay.push(e);
            }
            if tc_bool(tc, "done") {
                let mut e = events::tool_end(agent, id, name, None, None);
                e.data.insert("result".into(), tc.get("result").cloned().unwrap_or(Value::Null));
                replay.push(e);
            }
        }
        let mut replay: std::collections::VecDeque<Arc<WireEvent>> = replay.into_iter().map(|e| e.to_wire()).collect();
        if let Some((_, frame)) = &state.open_question {
            replay.push_back(frame.clone());
        }
        Some(Subscription { store: self, session_id: session_id.to_string(), replay, queue: q })
    }

    fn detach(&self, session_id: &str, q: &Sub) {
        if let Some(state) = self.turns.lock().unwrap().get_mut(session_id) {
            state.subscribers.retain(|s| !Arc::ptr_eq(s, q));
        }
    }

    /// Test/diagnostic view of the replay blob.
    pub fn debug_state(&self, session_id: &str) -> Option<Value> {
        let turns = self.turns.lock().unwrap();
        let s = turns.get(session_id)?;
        Some(json!({
            "is_streaming": s.is_streaming,
            "content": s.content.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<Map<_, _>>(),
            "tool_calls": s.tool_calls,
            "subscribers": s.subscribers.len(),
            "usage": s.usage,
            "error": s.error,
        }))
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

/// Live attachment to one session's turn. Dropping detaches.
pub struct Subscription {
    store: &'static StreamStore,
    session_id: String,
    replay: std::collections::VecDeque<Arc<WireEvent>>,
    queue: Sub,
}

impl Subscription {
    /// Next frame, or `None` once the turn finished / the client was dropped.
    pub async fn next(&mut self) -> Option<Arc<WireEvent>> {
        if let Some(r) = self.replay.pop_front() {
            return Some(r);
        }
        self.queue.recv().await
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.store.detach(&self.session_id, &self.queue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leak() -> &'static StreamStore {
        Box::leak(Box::new(StreamStore::default()))
    }

    #[tokio::test]
    async fn replay_order_and_commit() {
        let s = leak();
        s.push_event("x", &events::message("a", "dropped", None), false);
        assert!(!s.has_turn("x"));
        s.init_turn("x", false);
        s.push_event("x", &events::agent_status("a", "working", None), false);
        s.push_event("x", &events::thinking("a", "th", None), false);
        s.push_event("x", &events::message("a", "he", None), false);
        s.push_event("x", &events::message("a", "llo", None), false);
        s.push_event("x", &events::tool_call("a", Some("t1"), "read"), false);
        s.push_event("x", &events::tool_start("a", Some("t1"), "read", Some("{}")), false);
        let mut sub = s.attach("x").unwrap();
        let mut got = vec![];
        for _ in 0..5 {
            got.push(sub.next().await.unwrap().event.clone());
        }
        assert_eq!(got, vec!["agent_status", "thinking", "message", "tool_call", "tool_start"]);
        s.push_event("x", &events::tool_end("a", Some("t1"), "read", Some("r"), None), false);
        assert_eq!(sub.next().await.unwrap().event, "tool_end");
        s.commit_agent_content("x", "a");
        let st = s.debug_state("x").unwrap();
        assert_eq!(st["tool_calls"], json!([]));
        s.mark_done("x");
        assert!(sub.next().await.is_none());
        drop(sub);
        assert!(s.attach("x").is_none());
    }

    #[tokio::test]
    async fn full_queue_drops_client_with_sentinel() {
        let s = leak();
        s.init_turn("y", false);
        let mut sub = s.attach("y").unwrap();
        for i in 0..(SUBSCRIBER_QUEUE_SIZE + 1) {
            s.push_event("y", &events::message("a", &i.to_string(), None), false);
        }
        assert_eq!(s.debug_state("y").unwrap()["subscribers"], json!(0));
        let mut n = 0;
        while sub.next().await.is_some() {
            n += 1;
        }
        assert_eq!(n, SUBSCRIBER_QUEUE_SIZE - 1);
    }

    #[tokio::test]
    async fn replay_joins_many_chunks_per_agent_in_order() {
        let s = leak();
        s.init_turn("z", false);
        for i in 0..500 {
            s.push_event("z", &events::message("a", &format!("{i},"), None), false);
            s.push_event("z", &events::thinking("a", "t", None), false);
            s.push_event("z", &events::message("b", "é", None), false);
        }
        s.push_event("z", &events::message("a", "", None), false);
        let mut sub = s.attach("z").unwrap();
        let mut frames = vec![];
        for _ in 0..3 {
            frames.push(sub.next().await.unwrap());
        }
        let expected_a: String = (0..500).map(|i| format!("{i},")).collect();
        assert_eq!(frames[0].data, events::thinking("a", &"t".repeat(500), None).to_wire().data);
        assert_eq!(frames[1].data, events::message("a", &expected_a, None).to_wire().data);
        assert_eq!(frames[2].data, events::message("b", &"é".repeat(500), None).to_wire().data);
        assert_eq!(s.debug_state("z").unwrap()["content"]["a"], json!(expected_a));
    }

    fn replay_names(s: &'static StreamStore, sid: &str) -> Vec<String> {
        let sub = s.attach(sid).unwrap();
        sub.replay.iter().map(|e| e.event.clone()).collect()
    }

    #[tokio::test]
    async fn an_attach_replays_the_open_question_last() {
        let s = leak();
        s.init_turn("q", false);
        s.push_event("q", &events::agent_status("a", "working", None), false);
        s.push_event("q", &events::tool_call("a", Some("c1"), "submit_plan"), false);
        s.push_event("q", &events::plan_review_asked("q1", "q", "c1", &[json!({"question": "Review plan revision 2."})], 2), false);
        s.push_event("q", &events::agent_status("a", "waiting_input", None), false);

        let sub = s.attach("q").unwrap();
        let last = sub.replay.back().unwrap();
        assert_eq!(last.event, "question_asked");
        let data: Value = serde_json::from_str(&last.data).unwrap();
        assert_eq!((data["question_id"].as_str(), data["kind"].as_str(), data["plan_revision"].as_u64()), (Some("q1"), Some("plan_review"), Some(2)));
    }

    #[tokio::test]
    async fn a_resolved_question_is_not_replayed() {
        let s = leak();
        for (sid, resolution) in [("r1", events::question_answered("q1", "r1", &json!([["Approve"]]))), ("r2", events::question_dismissed("q1", "r2", "dismissed"))] {
            s.init_turn(sid, false);
            s.push_event(sid, &events::question_asked("q1", sid, "c1", &[json!({"question": "Which?"})]), false);
            s.push_event(sid, &resolution, false);
            assert!(!replay_names(s, sid).contains(&"question_asked".to_string()), "{sid}");
        }
    }

    #[tokio::test]
    async fn a_new_turn_forgets_the_question() {
        let s = leak();
        s.init_turn("n", false);
        s.push_event("n", &events::question_asked("q1", "n", "c1", &[json!({"question": "Which?"})]), false);
        s.init_turn("n", true);
        assert!(!replay_names(s, "n").contains(&"question_asked".to_string()));
    }

    fn pending_row(qid: &str, payload: Value) -> appv3_db::PendingQuestion {
        appv3_db::PendingQuestion {
            id: qid.into(),
            session_id: "01a163cc269b7076a8b797a60845113c".into(),
            tool_call_id: "c1".into(),
            payload: payload.to_string(),
            status: "pending".into(),
            answers: None,
            created_at: String::new(),
            answered_at: None,
        }
    }

    #[tokio::test]
    async fn a_parked_session_with_no_turn_gets_one_that_replays_its_question() {
        let s = leak();
        s.ensure_parked_turn("p", &pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"questions": [{"question": "Which?"}]})));
        assert_eq!(replay_names(s, "p"), vec!["question_asked"]);
    }

    /// The row was read just before a new message superseded it and started
    /// a turn: that turn must not replay the closed question.
    #[tokio::test]
    async fn a_row_read_before_a_new_turn_is_not_seeded_into_it() {
        let s = leak();
        s.init_turn("t", false);
        s.push_event("t", &events::agent_status("a", "working", None), false);
        s.ensure_parked_turn("t", &pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"questions": [{"question": "Which?"}]})));
        assert_eq!(replay_names(s, "t"), vec!["agent_status"]);
    }

    #[tokio::test]
    async fn a_live_turn_keeps_its_own_question() {
        let s = leak();
        s.init_turn("l", false);
        s.push_event("l", &events::question_asked("q-live", "l", "c1", &[json!({"question": "Which?"})]), false);
        s.ensure_parked_turn("l", &pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"questions": [{"question": "Other?"}]})));
        let sub = s.attach("l").unwrap();
        assert_eq!(sub.replay.len(), 1);
        assert!(sub.replay[0].data.contains("\"q-live\""));
    }

    #[tokio::test]
    async fn a_parked_plan_review_row_replays_as_a_plan_review() {
        let s = leak();
        let row = pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"kind": "plan_review", "plan_revision": 4, "questions": [{"question": "Review plan revision 4."}]}));
        s.ensure_parked_turn("01a163cc-269b-7076-a8b7-97a60845113c", &row);
        let sub = s.attach("01a163cc-269b-7076-a8b7-97a60845113c").unwrap();
        let data: Value = serde_json::from_str(&sub.replay.back().unwrap().data).unwrap();
        assert_eq!(data["question_id"], "01a163e0-7957-72a9-a175-6a6f30bd379e");
        assert_eq!(data["session_id"], "01a163cc-269b-7076-a8b7-97a60845113c");
        assert_eq!((data["kind"].as_str(), data["plan_revision"].as_u64(), data["tool_call_id"].as_str()), (Some("plan_review"), Some(4), Some("c1")));
    }

    #[tokio::test]
    async fn tool_end_keeps_its_result_on_every_match_path() {
        let s = leak();
        s.init_turn("w", false);
        s.push_event("w", &events::tool_call("a", Some("t1"), "read"), false);
        s.push_event("w", &events::tool_end("a", Some("t1"), "read", Some("by-id"), None), false);
        s.push_event("w", &events::tool_call("a", None, "grep"), false);
        s.push_event("w", &events::tool_end("a", None, "grep", Some("by-name"), None), false);
        s.push_event("w", &events::tool_end("a", Some("t9"), "glob", Some("orphan"), None), false);
        let results: Vec<Value> = s.debug_state("w").unwrap()["tool_calls"].as_array().unwrap().iter().map(|tc| tc["result"].clone()).collect();
        assert_eq!(results, vec![json!("by-id"), json!("by-name"), json!("orphan")]);
    }
}
