//! Process-local global SSE fan-out.
//!
//! Every event gets an id (`<boot>-<seq>`), and the last few minutes of
//! events are kept, so a client that lost its connection (a phone in the
//! background, a laptop that slept, a dropped relay) resumes from the last id
//! it saw instead of missing what happened meanwhile (`attach_since`). A
//! restarted server has a new boot id; a gap older than what is kept, or an
//! id from another boot, asks the client to refresh everything instead.

use crate::events::{compact, WireEvent};
use crate::queue::SubQueue;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const QUEUE_SIZE: usize = 256;
/// Events kept for a client that resumes.
pub const REPLAY_MAX_EVENTS: usize = 500;
/// How long an event is kept for a client that resumes.
pub const REPLAY_MAX_AGE: Duration = Duration::from_secs(15 * 60);
/// The event that starts every global stream: where it resumes from.
pub const RESUME_EVENT: &str = "stream_resume";

type Sub = Arc<SubQueue<Arc<WireEvent>>>;

pub struct Broadcaster {
    subs: Mutex<Vec<Sub>>,
    /// Recent events for clients that resume. Locked after `subs`.
    ring: Mutex<Ring>,
    /// Set on server shutdown: open streams end and new ones end at once,
    /// so they cannot hold the graceful drain open.
    closed: AtomicBool,
    /// In-process listeners for one event (see [`Broadcaster::tap`]). Not
    /// clients: they do not count in [`Broadcaster::subscriber_count`].
    taps: Mutex<Vec<(String, tokio::sync::mpsc::UnboundedSender<Value>)>>,
}

impl Default for Broadcaster {
    fn default() -> Self {
        let boot = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        Broadcaster { subs: Mutex::default(), ring: Mutex::new(Ring::new(boot)), closed: AtomicBool::new(false), taps: Mutex::default() }
    }
}

struct Ring {
    boot: String,
    /// The last id handed out (0: none yet).
    seq: u64,
    /// Contiguous: the newest event has `seq`.
    events: VecDeque<(Instant, Arc<WireEvent>)>,
}

impl Ring {
    fn new(boot: String) -> Self {
        Ring { boot, seq: 0, events: VecDeque::new() }
    }

    fn id(&self, seq: u64) -> String {
        format!("{}-{}", self.boot, seq)
    }

    fn prune(&mut self, now: Instant) {
        while self.events.len() > REPLAY_MAX_EVENTS || self.events.front().is_some_and(|(at, _)| now.duration_since(*at) > REPLAY_MAX_AGE) {
            self.events.pop_front();
        }
    }

    /// The events after `since`, or `None` when some of them are gone (or
    /// `since` is from another boot, or is not an id).
    fn after(&mut self, since: &str, now: Instant) -> Option<Vec<Arc<WireEvent>>> {
        self.prune(now);
        let (boot, seq) = since.rsplit_once('-')?;
        if boot != self.boot {
            return None;
        }
        let seq: u64 = seq.parse().ok()?;
        if seq > self.seq {
            return None;
        }
        let missed = (self.seq - seq) as usize;
        if missed > self.events.len() {
            return None;
        }
        Some(self.events.iter().skip(self.events.len() - missed).map(|(_, e)| e.clone()).collect())
    }
}

/// What a client that opens the global stream gets before live events.
pub struct Resume {
    /// The `stream_resume` event, then the events it missed.
    pub head: Vec<Arc<WireEvent>>,
    /// Events replayed (0 for a client with nothing to resume).
    pub replayed: usize,
    /// The client must refresh everything: it asked to resume from an id
    /// that cannot be served.
    pub resync: bool,
}

pub fn broadcaster() -> &'static Broadcaster {
    static B: OnceLock<Broadcaster> = OnceLock::new();
    B.get_or_init(Broadcaster::default)
}

/// Shorthand for `broadcaster().publish`.
pub fn publish(event: &str, data: Value) {
    broadcaster().publish(event, data);
}

/// Session ids in the form the API uses. A session bound from a database
/// row carries the stored (hex) id, and clients match events against the
/// API's hyphenated ids: unread marks, "already notified", and a tapped
/// notification all key on it.
fn api_session_ids(data: &mut Value) {
    for key in ["session_id", "parent_session_id"] {
        if let Some(Value::String(id)) = data.get_mut(key) {
            let api = appv3_db::codec::api_uuid(id);
            if api != *id {
                *id = api;
            }
        }
    }
}

/// A message was queued on `session_id` (`at` is its stored time) without
/// starting a turn. Saving it moved the session's `last_message_at`, so
/// clients that sort sessions by activity move it up without a refetch.
/// Turns announce themselves (`session_turn_started`); this covers the rest.
pub fn publish_session_activity(session_id: &str, at: &str) {
    publish("session_activity", serde_json::json!({"session_id": appv3_db::codec::api_uuid(session_id), "last_message_at": appv3_db::codec::api_dt(at)}));
}

impl Broadcaster {
    pub fn publish(&self, event: &str, mut data: Value) {
        crate::events::check_contract(crate::events::Stream::Global, event);
        api_session_ids(&mut data);
        {
            let mut taps = self.taps.lock().unwrap();
            taps.retain(|(name, tx)| name != event || tx.send(data.clone()).is_ok());
        }
        let mut subs = self.subs.lock().unwrap();
        let wire = {
            let mut ring = self.ring.lock().unwrap();
            ring.seq += 1;
            let wire = Arc::new(WireEvent { event: event.to_string(), data: compact(&data), id: Some(ring.id(ring.seq)) });
            let now = Instant::now();
            ring.events.push_back((now, wire.clone()));
            ring.prune(now);
            wire
        };
        subs.retain(|q| {
            if q.push(wire.clone()) {
                true
            } else {
                tracing::warn!("global_sse_subscriber_queue_full event={}", event);
                q.terminate();
                false
            }
        });
    }

    pub fn attach(&'static self) -> GlobalSubscription {
        self.attach_since(None).0
    }

    /// Attach, with what to send first: a `stream_resume` event, then (when
    /// `since` is the id of an event still kept) every event after it.
    /// Taken under the same lock `publish` holds, so nothing falls between
    /// the replay and the live events.
    pub fn attach_since(&'static self, since: Option<&str>) -> (GlobalSubscription, Resume) {
        let q: Sub = Arc::new(SubQueue::new(QUEUE_SIZE));
        let mut subs = self.subs.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            q.terminate();
        } else {
            subs.push(q.clone());
        }
        let resume = {
            let mut ring = self.ring.lock().unwrap();
            let missed = since.map(|s| ring.after(s, Instant::now()));
            let (events, resync) = match missed {
                None => (Vec::new(), false),
                Some(Some(events)) => (events, false),
                Some(None) => (Vec::new(), true),
            };
            // With nothing to replay the client's position is now; after a
            // replay it is the last replayed event's id.
            let id = events.is_empty().then(|| ring.id(ring.seq));
            let data = serde_json::json!({"replay": events.len(), "resync": resync});
            let mut head = vec![Arc::new(WireEvent { event: RESUME_EVENT.to_string(), data: compact(&data), id })];
            let replayed = events.len();
            head.extend(events);
            Resume { head, replayed, resync }
        };
        drop(subs);
        (GlobalSubscription { owner: self, queue: q }, resume)
    }

    /// Every later `event`'s data, for in-process listeners (the cloud
    /// module forwards notifications to the person's phone). Dropping the
    /// receiver removes the tap at the next matching event.
    pub fn tap(&self, event: &str) -> tokio::sync::mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.taps.lock().unwrap().push((event.to_string(), tx));
        rx
    }

    pub fn subscriber_count(&self) -> usize {
        self.subs.lock().unwrap().len()
    }

    pub fn close(&self) {
        let subs: Vec<Sub> = {
            let mut guard = self.subs.lock().unwrap();
            self.closed.store(true, Ordering::SeqCst);
            std::mem::take(&mut *guard)
        };
        for q in subs {
            q.terminate();
        }
    }
}

pub struct GlobalSubscription {
    owner: &'static Broadcaster,
    queue: Sub,
}

impl GlobalSubscription {
    pub async fn next(&mut self) -> Option<Arc<WireEvent>> {
        self.queue.recv().await
    }
}

impl Drop for GlobalSubscription {
    fn drop(&mut self) {
        self.owner.subs.lock().unwrap().retain(|q| !Arc::ptr_eq(q, &self.queue));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn close_ends_open_and_later_subscriptions() {
        let b: &'static Broadcaster = Box::leak(Box::default());
        let mut open = b.attach();
        b.publish("config_changed", serde_json::json!({}));
        b.close();
        assert_eq!(open.next().await.map(|e| e.event.clone()).as_deref(), Some("config_changed"));
        assert!(open.next().await.is_none());
        let mut late = b.attach();
        assert!(late.next().await.is_none());
        assert_eq!(b.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn a_tap_gets_its_event_and_is_not_a_client() {
        let b: &'static Broadcaster = Box::leak(Box::default());
        let mut tap = b.tap("desktop_notification");
        b.publish("config_changed", serde_json::json!({}));
        b.publish("desktop_notification", serde_json::json!({"title": "Done"}));
        assert_eq!(tap.recv().await.unwrap()["title"], "Done");
        assert_eq!(b.subscriber_count(), 0);
        drop(tap);
        b.publish("desktop_notification", serde_json::json!({}));
        assert!(b.taps.lock().unwrap().is_empty());
    }

    fn leaked() -> &'static Broadcaster {
        Box::leak(Box::default())
    }

    #[tokio::test]
    async fn session_ids_go_out_in_the_form_the_api_uses() {
        // A session bound from a database row has the stored (hex) id;
        // clients match events to the API's hyphenated ids.
        let b = leaked();
        let mut live = b.attach();
        let mut tap = b.tap("desktop_notification");
        let hex = "0192f5a0b1c27d3e8f40a1b2c3d4e5f6";
        let api = "0192f5a0-b1c2-7d3e-8f40-a1b2c3d4e5f6"; // gitleaks:allow (a session id)
        b.publish("desktop_notification", serde_json::json!({"session_id": hex, "parent_session_id": hex, "title": "Done"}));
        let ev = live.next().await.unwrap();
        let data: Value = serde_json::from_str(&ev.data).unwrap();
        assert_eq!((data["session_id"].as_str(), data["parent_session_id"].as_str()), (Some(api), Some(api)));
        assert_eq!(tap.recv().await.unwrap()["session_id"], api);
        // Anything that is not a UUID is left alone.
        b.publish("title_update", serde_json::json!({"session_id": "not-a-uuid"}));
        assert!(live.next().await.unwrap().data.contains(r#""session_id":"not-a-uuid""#));
    }

    fn ids(events: &[Arc<WireEvent>]) -> Vec<String> {
        events.iter().map(|e| format!("{}:{}", e.event, e.id.as_deref().unwrap_or("-"))).collect()
    }

    #[tokio::test]
    async fn every_global_event_has_an_id_and_a_new_stream_starts_with_its_position() {
        let b = leaked();
        let boot = b.ring.lock().unwrap().boot.clone();
        let (_sub, resume) = b.attach_since(None);
        assert_eq!(ids(&resume.head), [format!("stream_resume:{boot}-0")]);
        assert_eq!(resume.head[0].data, r#"{"replay":0,"resync":false}"#);

        let mut live = b.attach();
        b.publish("config_changed", serde_json::json!({}));
        let ev = live.next().await.unwrap();
        assert_eq!(ev.id.as_deref(), Some(format!("{boot}-1").as_str()));
        assert!(ev.to_sse().starts_with(&format!("id: {boot}-1\r\nevent: config_changed\r\n")));
    }

    #[tokio::test]
    async fn a_client_that_resumes_gets_what_it_missed_then_live_events() {
        let b = leaked();
        let boot = b.ring.lock().unwrap().boot.clone();
        for n in 1..=4 {
            b.publish("title_update", serde_json::json!({"n": n}));
        }
        let (mut sub, resume) = b.attach_since(Some(&format!("{boot}-2")));
        assert_eq!((resume.replayed, resume.resync), (2, false));
        assert_eq!(ids(&resume.head), ["stream_resume:-".to_string(), format!("title_update:{boot}-3"), format!("title_update:{boot}-4")]);
        assert_eq!(resume.head[0].data, r#"{"replay":2,"resync":false}"#);
        b.publish("title_update", serde_json::json!({"n": 5}));
        assert_eq!(sub.next().await.unwrap().id.as_deref(), Some(format!("{boot}-5").as_str()));

        // Up to date: nothing to replay, and the position stays.
        let (_sub, resume) = b.attach_since(Some(&format!("{boot}-5")));
        assert_eq!(ids(&resume.head), [format!("stream_resume:{boot}-5")]);
    }

    #[test]
    fn a_position_that_cannot_be_served_asks_for_a_refresh() {
        let b = leaked();
        let boot = b.ring.lock().unwrap().boot.clone();
        for n in 0..(REPLAY_MAX_EVENTS + 3) {
            b.publish("title_update", serde_json::json!({"n": n}));
        }
        // Too old (the oldest kept event is 4), another boot, ahead of this
        // server, or not an id at all.
        for since in [format!("{boot}-2"), "deadbeef-3".to_string(), format!("{boot}-99999"), "garbage".to_string()] {
            let (_sub, resume) = b.attach_since(Some(&since));
            assert!(resume.resync, "{since}");
            assert_eq!(resume.replayed, 0);
            assert_eq!(resume.head[0].data, r#"{"replay":0,"resync":true}"#);
        }
        // The oldest still kept is fine.
        let (_sub, resume) = b.attach_since(Some(&format!("{boot}-3")));
        assert_eq!((resume.replayed, resume.resync), (REPLAY_MAX_EVENTS, false));
        assert_eq!(b.ring.lock().unwrap().events.len(), REPLAY_MAX_EVENTS);
    }

    #[test]
    fn events_older_than_the_window_are_not_replayed() {
        let mut ring = Ring::new("b00t".into());
        let start = Instant::now();
        for n in 1..=3u64 {
            ring.seq = n;
            let at = start + Duration::from_secs(n * 60);
            ring.events.push_back((at, Arc::new(WireEvent { event: "x".into(), data: "{}".into(), id: Some(ring.id(n)) })));
        }
        let later = start + Duration::from_secs(60) + REPLAY_MAX_AGE + Duration::from_secs(1);
        // Event 1 has expired: resuming from before it cannot be served.
        assert!(ring.after("b00t-0", later).is_none());
        assert_eq!(ring.after("b00t-1", later).map(|e| e.len()), Some(2));
    }
}
