//! In-memory SSE stream store.
//!
//! Per-session turn blob for reconnect replay plus live subscriber fan-out.
//! Single-process only, like v2.
//!
//! Live text deltas are joined before fan-out: a provider streams a few
//! characters per chunk, and each frame costs ~170 bytes of framing plus a
//! network write (a billed message through a relay). The first delta of a
//! stream (an agent's message, one tool's output) goes out at once; the
//! ones that follow within [`DELTA_FLUSH_WINDOW`] are held and sent as one
//! frame. The replay blob still takes every chunk, so replay is unchanged.

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

/// How long a live delta may wait to be joined with the ones after it.
pub const DELTA_FLUSH_WINDOW: Duration = Duration::from_millis(50);
/// Held text past this size goes out without waiting for the window.
pub const DELTA_FLUSH_BYTES: usize = 8 * 1024;

type Sub = Arc<SubQueue<Arc<WireEvent>>>;

/// Events whose `text` is a piece of a longer stream: consecutive pieces
/// with the same key and the same other fields can be joined.
fn is_delta(event: &str) -> bool {
    matches!(event, "message" | "thinking" | "tool_output_delta" | "summarization_content")
}

/// One stream of deltas: an agent's message or thinking, one tool's output.
#[derive(Clone, PartialEq, Eq)]
struct DeltaKey {
    event: String,
    agent: String,
    tool_call_id: Option<String>,
}

impl DeltaKey {
    fn of(env: &Envelope) -> Self {
        Self { event: env.event.clone(), agent: env.agent().to_string(), tool_call_id: env.str_field("tool_call_id").map(String::from) }
    }

    /// An agent's text streams (reply, thinking, summary) land in one
    /// transcript in arrival order, so one must not overtake another. A
    /// tool's output goes to its own card and keeps its own pace.
    fn shares_order_with(&self, other: &DeltaKey) -> bool {
        self.agent == other.agent && self.event != "tool_output_delta" && other.event != "tool_output_delta"
    }
}

/// Deltas held back from the live subscribers: the first piece's envelope
/// with the later pieces' text appended (and the last `sequence`).
struct PendingDelta {
    key: DeltaKey,
    env: Envelope,
    text: String,
    opened: tokio::time::Instant,
}

impl PendingDelta {
    fn open(key: DeltaKey, env: &Envelope, now: tokio::time::Instant) -> Self {
        Self { key, env: env.clone(), text: env.str_field("text").unwrap_or("").to_string(), opened: now }
    }

    /// Whether `env` continues this one: every field but `text` and
    /// `sequence` is the same (agent, tool, model metadata).
    fn continues(&self, env: &Envelope) -> bool {
        let (a, b) = (&self.env.data, &env.data);
        a.len() == b.len() && a.iter().all(|(k, v)| matches!(k.as_str(), "text" | "sequence") || b.get(k) == Some(v))
    }

    fn append(&mut self, env: &Envelope) {
        self.text.push_str(env.str_field("text").unwrap_or(""));
        if let Some(seq) = env.field("sequence") {
            self.env.data.insert("sequence".into(), seq.clone());
        }
    }

    fn into_wire(mut self) -> Arc<WireEvent> {
        self.env.data.insert("text".into(), Value::String(self.text));
        self.env.to_wire()
    }
}

/// Live deltas in a turn, before and after joining (`stream_deltas` log).
#[derive(Default)]
struct DeltaStats {
    received: u64,
    sent: u64,
}

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
    /// Deltas waiting to be joined, in the order their streams were opened.
    pending: Vec<PendingDelta>,
    /// When each delta stream last sent a frame live: a stream quiet for a
    /// window sends its next piece at once.
    last_sent: Vec<(DeltaKey, tokio::time::Instant)>,
    delta_stats: DeltaStats,
    created_at: Option<Instant>,
    deadline: Option<Instant>,
}

#[derive(Clone, Default)]
struct Summ {
    text: String,
    done: bool,
    error: bool,
    /// A `/compact` or idle compaction; see [`events::summarization_start`].
    forced: bool,
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
        self.last_sent.clear();
        self.delta_stats = DeltaStats::default();
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

    /// Send `wire` to every live subscriber, dropping any whose queue is full.
    fn broadcast(&mut self, session_id: &str, wire: Arc<WireEvent>) {
        let event = &wire.event;
        self.subscribers.retain(|q| {
            if q.push(wire.clone()) {
                true
            } else {
                tracing::warn!("sse_subscriber_queue_full session_id={} event_type={} dropping_client qsize={}", session_id, event, q.len());
                q.terminate();
                false
            }
        });
    }

    fn send_delta(&mut self, session_id: &str, key: DeltaKey, wire: Arc<WireEvent>, now: tokio::time::Instant) {
        self.delta_stats.sent += 1;
        match self.last_sent.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = now,
            None => self.last_sent.push((key, now)),
        }
        self.broadcast(session_id, wire);
    }

    /// Send every held delta, oldest stream first. Runs before anything else
    /// goes out, so held text always precedes the event that follows it.
    fn flush_pending(&mut self, session_id: &str) {
        if self.pending.is_empty() {
            return;
        }
        let now = tokio::time::Instant::now();
        for p in std::mem::take(&mut self.pending) {
            let key = p.key.clone();
            self.send_delta(session_id, key, p.into_wire(), now);
        }
    }

    /// Send the held deltas whose window has passed.
    fn flush_due(&mut self, session_id: &str, now: tokio::time::Instant) {
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].opened + DELTA_FLUSH_WINDOW <= now {
                let p = self.pending.remove(i);
                let key = p.key.clone();
                self.send_delta(session_id, key, p.into_wire(), now);
            } else {
                i += 1;
            }
        }
    }

    /// A live delta: send it, join it to the held piece of its stream, or
    /// hold it. `true` when a new piece is held and needs a flush timer.
    fn push_delta(&mut self, session_id: &str, env: &Envelope, can_wait: bool) -> bool {
        self.delta_stats.received += 1;
        let now = tokio::time::Instant::now();
        let key = DeltaKey::of(env);
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].key != key && self.pending[i].key.shares_order_with(&key) {
                let p = self.pending.remove(i);
                let held = p.key.clone();
                self.send_delta(session_id, held, p.into_wire(), now);
            } else {
                i += 1;
            }
        }
        if let Some(i) = self.pending.iter().position(|p| p.key == key) {
            if self.pending[i].continues(env) {
                self.pending[i].append(env);
                if self.pending[i].text.len() >= DELTA_FLUSH_BYTES {
                    let p = self.pending.remove(i);
                    self.send_delta(session_id, key, p.into_wire(), now);
                }
                return false;
            }
            // Same stream, other metadata (a model switch): close the held
            // piece and start a new one.
            let p = self.pending.remove(i);
            self.send_delta(session_id, key.clone(), p.into_wire(), now);
        }
        let recent = self.last_sent.iter().any(|(k, at)| *k == key && now.duration_since(*at) < DELTA_FLUSH_WINDOW);
        let small = env.str_field("text").map_or(0, str::len) < DELTA_FLUSH_BYTES;
        if recent && can_wait && small {
            self.pending.push(PendingDelta::open(key, env, now));
            return true;
        }
        self.send_delta(session_id, key, env.to_wire(), now);
        false
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

/// `_tool_state.match_tool_end`. `omitted_bytes`: the result stayed on the
/// server, so the replay says so too.
fn match_tool_end(tcs: &mut Vec<Map<String, Value>>, id: Option<&str>, name: &str, result: Value, omitted_bytes: Option<Value>, agent: &str) {
    let by_id = id.filter(|s| !s.is_empty()).and_then(|i| tcs.iter().rposition(|tc| tc_str(tc, "tool_call_id") == Some(i)));
    let hit = by_id.or_else(|| tcs.iter().rposition(|tc| tc_str(tc, "name") == Some(name) && !tc_bool(tc, "done")));
    if let Some(i) = hit {
        let tc = &mut tcs[i];
        tc.insert("done".into(), Value::Bool(true));
        tc.insert("result".into(), result);
        if let Some(bytes) = omitted_bytes {
            tc.insert("result_bytes".into(), bytes);
        }
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
    if let Some(bytes) = omitted_bytes {
        m.insert("result_bytes".into(), bytes);
    }
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
            old.flush_pending(session_id);
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
    pub fn push_event(&'static self, session_id: &str, env: &Envelope, create_if_missing: bool) {
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
                if let Some(meta) = data.get("metadata").filter(|v| v.as_object().is_some_and(|o| !o.is_empty())) {
                    m.insert("metadata".into(), meta.clone());
                }
                state.tool_calls.push(m);
            }
            "tool_start" => {
                match_tool_start(&mut state.tool_calls, get_str("tool_call_id"), get_str("name").unwrap_or(""), data.get("arguments").cloned().unwrap_or(Value::Null), agent)
            }
            "tool_end" => {
                let meta = data.get("metadata");
                let omitted = meta.filter(|m| m.get("result_omitted") == Some(&Value::Bool(true))).and_then(|m| m.get("result_bytes")).cloned();
                match_tool_end(&mut state.tool_calls, get_str("tool_call_id"), get_str("name").unwrap_or(""), data.get("result").cloned().unwrap_or(Value::Null), omitted, agent)
            }
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
                let forced = data.get("metadata").and_then(|m| m.get("forced")).map(truthy).unwrap_or(false);
                *entry(&mut state.summarization, agent) = Summ { forced, ..Summ::default() };
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
            state.pending.clear();
            return;
        }
        if is_delta(&env.event) {
            // Holding needs a timer to flush; without a runtime (sync
            // tests), every delta goes out as it comes.
            let runtime = tokio::runtime::Handle::try_current().ok();
            if state.push_delta(session_id, env, runtime.is_some()) {
                if let Some(rt) = runtime {
                    let sid = session_id.to_string();
                    rt.spawn(async move {
                        tokio::time::sleep(DELTA_FLUSH_WINDOW).await;
                        self.flush_due(&sid);
                    });
                }
            }
            return;
        }
        state.flush_pending(session_id);
        state.broadcast(session_id, env.to_wire());
    }

    /// Timer side of delta joining: send what has waited a full window.
    fn flush_due(&self, session_id: &str) {
        if let Some(state) = self.turns.lock().unwrap().get_mut(session_id) {
            state.flush_due(session_id, tokio::time::Instant::now());
        }
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
            (Some(crate::secret_request::SECRET_KIND), _) => {
                events::secret_request_asked(&qid, session_id, &row.tool_call_id, &questions, &row.secret_request().unwrap_or_default())
            }
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
        state.flush_pending(session_id);
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
        state.flush_pending(session_id);
        let s = &state.delta_stats;
        if s.received > 0 {
            tracing::info!("stream_deltas session_id={} received={} sent={}", session_id, s.received, s.sent);
        }
        state.is_streaming = false;
        state.deadline = Some(Instant::now() + FINISHED_TURN_TTL);
        for q in &state.subscribers {
            q.terminate();
        }
    }

    /// `clear`.
    pub fn clear(&self, session_id: &str) {
        if let Some(mut state) = self.turns.lock().unwrap().remove(session_id) {
            state.flush_pending(session_id);
            for q in &state.subscribers {
                q.terminate();
            }
        }
    }

    pub fn close_all(&self) {
        let mut turns = self.turns.lock().unwrap();
        for (sid, state) in turns.iter_mut() {
            state.flush_pending(sid);
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
            st.flush_pending(sid);
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
        // Held text goes to the subscribers already here; the new one gets
        // it in the replay below, so it must not get it again.
        state.flush_pending(session_id);
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
            replay.push(events::summarization_start(agent, s.forced));
            if !s.text.is_empty() && !s.done {
                replay.push(events::summarization_content(agent, &s.text));
            }
            if s.done {
                let mut meta = json!({});
                if s.error {
                    meta["error"] = json!(true);
                }
                if s.forced {
                    meta["forced"] = json!(true);
                }
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
            replay.push(events::tool_call(agent, id, name, tc.get("metadata").cloned()));
            if tc_bool(tc, "started") {
                let mut e = events::tool_start(agent, id, name, None);
                e.data.insert("arguments".into(), tc.get("arguments").cloned().unwrap_or(Value::Null));
                replay.push(e);
            }
            if tc_bool(tc, "done") {
                let metadata = tc.get("result_bytes").map(|bytes| json!({"result_omitted": true, "result_bytes": bytes}));
                let mut e = events::tool_end(agent, id, name, None, metadata);
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
mod tests;
