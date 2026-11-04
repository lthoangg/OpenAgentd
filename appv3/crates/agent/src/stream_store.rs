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
        s.push_event("x", &events::tool_call("a", Some("t1"), "read", None), false);
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

    /// A reconnect mid-tool still learns which model called the tool, so the
    /// prompt above a tool-only reply can name it.
    #[tokio::test]
    async fn replay_keeps_the_model_that_called_a_tool() {
        let s = leak();
        s.init_turn("m", false);
        let meta = json!({"model": "openai:gpt-5", "thinking_level": "high"});
        s.push_event("m", &events::tool_call("a", Some("t1"), "ask_user", Some(meta.clone())), false);
        let mut sub = s.attach("m").unwrap();
        let e = sub.next().await.unwrap();
        assert_eq!(e.event, "tool_call");
        let data: Value = serde_json::from_str(&e.data).unwrap();
        assert_eq!(data["metadata"], meta);
    }

    /// A reconnect during a `/compact` still learns it was forced.
    #[tokio::test]
    async fn replay_keeps_a_forced_compaction_forced() {
        let s = leak();
        s.init_turn("f", false);
        s.push_event("f", &events::summarization_start("a", true), false);
        s.push_event("f", &events::summarization_end("a", "sum", Some(json!({"forced": true}))), false);
        let mut sub = s.attach("f").unwrap();
        let mut forced = vec![];
        for _ in 0..2 {
            let e = sub.next().await.unwrap();
            let data: Value = serde_json::from_str(&e.data).unwrap();
            forced.push((e.event.clone(), data.get("metadata").and_then(|m| m.get("forced")).cloned()));
        }
        assert_eq!(forced, vec![("summarization_start".to_string(), Some(json!(true))), ("summarization_end".to_string(), Some(json!(true)))]);
    }

    #[tokio::test]
    async fn full_queue_drops_client_with_sentinel() {
        let s = leak();
        s.init_turn("y", false);
        let mut sub = s.attach("y").unwrap();
        // Events that are never joined, one frame each.
        for i in 0..(SUBSCRIBER_QUEUE_SIZE + 1) {
            s.push_event("y", &events::tool_call("a", Some(&i.to_string()), "read", None), false);
        }
        assert_eq!(s.debug_state("y").unwrap()["subscribers"], json!(0));
        let mut n = 0;
        while sub.next().await.is_some() {
            n += 1;
        }
        assert_eq!(n, SUBSCRIBER_QUEUE_SIZE - 1);
    }

    /// `(event, text)` of every frame already queued for `sub`.
    fn queued(sub: &Subscription) -> Vec<(String, String)> {
        let mut out = vec![];
        while let Some(Some(e)) = sub.queue.items_for_test().pop_front() {
            let data: Value = serde_json::from_str(&e.data).unwrap();
            out.push((e.event.clone(), data["text"].as_str().unwrap_or("").to_string()));
        }
        out
    }

    fn frames(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(e, t)| (e.to_string(), t.to_string())).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_delta_goes_out_at_once_and_the_rest_are_joined() {
        let s = leak();
        s.init_turn("j", false);
        let sub = s.attach("j").unwrap();
        for t in ["Hel", "lo, ", "wor", "ld"] {
            s.push_event("j", &events::message("a", t, None), false);
        }
        assert_eq!(queued(&sub), frames(&[("message", "Hel")]), "only the first piece is out before the window");
        tokio::time::sleep(DELTA_FLUSH_WINDOW).await;
        tokio::task::yield_now().await;
        assert_eq!(queued(&sub), frames(&[("message", "lo, world")]));
    }

    #[tokio::test(start_paused = true)]
    async fn tools_running_side_by_side_are_joined_each_on_its_own() {
        let s = leak();
        s.init_turn("p", false);
        let sub = s.attach("p").unwrap();
        for n in 1..=3 {
            for id in ["t1", "t2"] {
                s.push_event("p", &events::tool_output_delta("a", Some(id), "shell", &format!("{id}.{n} "), n), false);
            }
        }
        tokio::time::sleep(DELTA_FLUSH_WINDOW).await;
        tokio::task::yield_now().await;
        assert_eq!(
            queued(&sub),
            frames(&[("tool_output_delta", "t1.1 "), ("tool_output_delta", "t2.1 "), ("tool_output_delta", "t1.2 t1.3 "), ("tool_output_delta", "t2.2 t2.3 ")])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_joined_frame_keeps_its_stream_fields_and_the_last_sequence() {
        let s = leak();
        s.init_turn("q", false);
        let sub = s.attach("q").unwrap();
        for n in 1..=3 {
            s.push_event("q", &events::tool_output_delta("a", Some("t1"), "shell", &n.to_string(), n), false);
        }
        s.push_event("q", &events::tool_end("a", Some("t1"), "shell", Some("123"), None), false);
        let mut q = sub.queue.items_for_test();
        q.pop_front();
        let joined: Value = serde_json::from_str(&q.pop_front().unwrap().unwrap().data).unwrap();
        assert_eq!(joined, serde_json::from_str::<Value>(&events::tool_output_delta("a", Some("t1"), "shell", "23", 3).to_wire().data).unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn held_text_goes_out_before_the_next_event() {
        let s = leak();
        s.init_turn("o", false);
        let sub = s.attach("o").unwrap();
        s.push_event("o", &events::message("a", "a", None), false);
        s.push_event("o", &events::message("a", "b", None), false);
        s.push_event("o", &events::tool_call("a", Some("t1"), "read", None), false);
        s.push_event("o", &events::message("a", "c", None), false);
        s.push_event("o", &events::done(None), false);
        assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", "b"), ("tool_call", ""), ("message", "c"), ("done", "")]));
    }

    /// The client appends an agent's thinking and reply to one transcript in
    /// arrival order: held thinking sent after the reply's first words split
    /// both blocks (and the next attach's replay no longer matched them).
    #[tokio::test(start_paused = true)]
    async fn an_agents_held_thinking_goes_out_before_its_reply() {
        let s = leak();
        s.init_turn("r", false);
        let sub = s.attach("r").unwrap();
        s.push_event("r", &events::thinking("a", "r1 ", None), false);
        s.push_event("r", &events::thinking("a", "r2", None), false);
        s.push_event("r", &events::message("b", "member", None), false);
        s.push_event("r", &events::message("a", "t1", None), false);
        assert_eq!(queued(&sub), frames(&[("thinking", "r1 "), ("message", "member"), ("thinking", "r2"), ("message", "t1")]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_tools_held_output_keeps_its_pace_beside_the_agents_text() {
        let s = leak();
        s.init_turn("u", false);
        let sub = s.attach("u").unwrap();
        s.push_event("u", &events::tool_output_delta("a", Some("t1"), "shell", "o1 ", 1), false);
        s.push_event("u", &events::tool_output_delta("a", Some("t1"), "shell", "o2", 2), false);
        s.push_event("u", &events::message("a", "t1", None), false);
        assert_eq!(queued(&sub), frames(&[("tool_output_delta", "o1 "), ("message", "t1")]));
    }

    #[tokio::test(start_paused = true)]
    async fn ending_the_turn_sends_held_text_before_the_end() {
        let s = leak();
        s.init_turn("e", false);
        let mut sub = s.attach("e").unwrap();
        s.push_event("e", &events::message("a", "a", None), false);
        s.push_event("e", &events::message("a", "b", None), false);
        s.mark_done("e");
        assert_eq!(sub.next().await.unwrap().event, "message");
        let last: Value = serde_json::from_str(&sub.next().await.unwrap().data).unwrap();
        assert_eq!(last["text"], "b");
        assert!(sub.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn an_attach_mid_window_neither_repeats_nor_loses_text() {
        let s = leak();
        s.init_turn("m", false);
        let old = s.attach("m").unwrap();
        s.push_event("m", &events::message("a", "he", None), false);
        s.push_event("m", &events::message("a", "llo", None), false);
        let new = s.attach("m").unwrap();
        assert_eq!(queued(&old), frames(&[("message", "he"), ("message", "llo")]), "the old subscriber gets the held text");
        let replay: Vec<String> = new.replay.iter().map(|e| serde_json::from_str::<Value>(&e.data).unwrap()["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(replay, ["hello"]);
        tokio::time::sleep(DELTA_FLUSH_WINDOW * 2).await;
        tokio::task::yield_now().await;
        assert_eq!(queued(&new), vec![], "the new one has it from the replay only");
    }

    #[tokio::test(start_paused = true)]
    async fn a_large_held_piece_goes_out_without_waiting() {
        let s = leak();
        s.init_turn("b", false);
        let sub = s.attach("b").unwrap();
        s.push_event("b", &events::message("a", "a", None), false);
        let big = "x".repeat(DELTA_FLUSH_BYTES);
        s.push_event("b", &events::message("a", &big, None), false);
        assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", &big)]));
    }

    #[tokio::test(start_paused = true)]
    async fn other_metadata_starts_a_new_frame() {
        let s = leak();
        s.init_turn("d", false);
        let sub = s.attach("d").unwrap();
        let m1 = || Some(json!({"model": "a:one"}));
        s.push_event("d", &events::message("a", "a", m1()), false);
        s.push_event("d", &events::message("a", "b", m1()), false);
        s.push_event("d", &events::message("a", "c", Some(json!({"model": "a:two"}))), false);
        assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", "b")]));
        tokio::time::sleep(DELTA_FLUSH_WINDOW).await;
        tokio::task::yield_now().await;
        let q = sub.queue.items_for_test();
        let data: Value = serde_json::from_str(&q[0].as_ref().unwrap().data).unwrap();
        assert_eq!((data["text"].as_str(), data["metadata"]["model"].as_str()), (Some("c"), Some("a:two")));
    }

    #[test]
    fn without_a_runtime_every_delta_goes_out_as_it_comes() {
        let s = leak();
        s.init_turn("n", false);
        let sub = s.attach("n").unwrap();
        s.push_event("n", &events::message("a", "a", None), false);
        s.push_event("n", &events::message("a", "b", None), false);
        assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", "b")]));
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
        s.push_event("q", &events::tool_call("a", Some("c1"), "submit_plan", None), false);
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
        s.push_event("w", &events::tool_call("a", Some("t1"), "ask_user", None), false);
        s.push_event("w", &events::tool_end("a", Some("t1"), "ask_user", Some("by-id"), None), false);
        s.push_event("w", &events::tool_call("a", None, "update_goal", None), false);
        s.push_event("w", &events::tool_end("a", None, "update_goal", Some("by-name"), None), false);
        s.push_event("w", &events::tool_end("a", Some("t9"), "plan", Some("orphan"), None), false);
        let results: Vec<Value> = s.debug_state("w").unwrap()["tool_calls"].as_array().unwrap().iter().map(|tc| tc["result"].clone()).collect();
        assert_eq!(results, vec![json!("by-id"), json!("by-name"), json!("orphan")]);
    }

    #[tokio::test]
    async fn an_attach_replays_a_left_out_result_as_left_out() {
        let s = leak();
        s.init_turn("lo", false);
        s.push_event("lo", &events::tool_call("a", Some("t1"), "read", None), false);
        s.push_event("lo", &events::tool_start("a", Some("t1"), "read", Some("{}")), false);
        s.push_event("lo", &events::tool_end("a", Some("t1"), "read", Some("12345"), Some(json!({"duration_ms": 2}))), false);
        let sub = s.attach("lo").unwrap();
        let end = sub.replay.iter().find(|e| e.event == "tool_end").unwrap();
        let data: Value = serde_json::from_str(&end.data).unwrap();
        assert_eq!(data["result"], Value::Null);
        assert_eq!(data["metadata"], json!({"result_omitted": true, "result_bytes": 5}));
    }
}
