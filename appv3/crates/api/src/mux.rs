//! Session streams carried on the global event stream.
//!
//! A webview opens few connections per host, so one connection per session
//! stream does not scale across windows. A client opens
//! `GET /api/events/stream?client_id=<id>` and then states which sessions it
//! wants with `PUT /api/events/subscriptions/<id>`. Each subscription gets
//! its own `attach` to the stream store, so it replays exactly as
//! `GET /api/agent/{sid}/stream` does; its frames arrive on the shared stream
//! as `session_event` (`{sub_id, type, data}`) and a `session_stream_end`
//! (`{sub_id}`) when the turn is over or there is none.

use appv3_agent::events::WireEvent;
use appv3_agent::queue::SubQueue;
use appv3_agent::store;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::task::JoinHandle;

/// One client fans in every session it watches, so this holds many more
/// frames than a single session's queue. A client that falls this far behind
/// is dropped and reconnects, as with a session stream.
pub const QUEUE_SIZE: usize = 8192;
pub const MAX_SUBSCRIPTIONS: usize = 64;
pub const MAX_ID_LEN: usize = 64;

/// Client and subscription ids are chosen by the client and echoed back.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

type Queue = Arc<SubQueue<Arc<WireEvent>>>;

pub struct MuxClient {
    /// The client id, for the log.
    id: String,
    queue: Queue,
    /// subscription id → (session id, forwarder)
    subs: Mutex<HashMap<String, (String, JoinHandle<()>)>>,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<MuxClient>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<MuxClient>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Removes the client when its stream is dropped, on a normal end and on
/// disconnect, and stops every forwarder.
pub struct MuxGuard {
    id: String,
    client: Arc<MuxClient>,
}

impl Drop for MuxGuard {
    fn drop(&mut self) {
        let mut reg = registry().lock().unwrap();
        if reg.get(&self.id).is_some_and(|c| Arc::ptr_eq(c, &self.client)) {
            reg.remove(&self.id);
        }
        drop(reg);
        self.client.stop_all();
    }
}

/// A client that reconnects under the same id replaces the old one.
pub fn register(id: &str) -> (Arc<MuxClient>, MuxGuard) {
    let client = Arc::new(MuxClient { id: id.to_string(), queue: Arc::new(SubQueue::new(QUEUE_SIZE)), subs: Mutex::new(HashMap::new()) });
    let previous = registry().lock().unwrap().insert(id.to_string(), client.clone());
    if let Some(old) = previous {
        old.queue.terminate();
        old.stop_all();
    }
    (client.clone(), MuxGuard { id: id.to_string(), client })
}

pub fn lookup(id: &str) -> Option<Arc<MuxClient>> {
    registry().lock().unwrap().get(id).cloned()
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// The frame's payload is already JSON, so it is embedded as is: parsing and
/// re-encoding every token delta would cost more than the framing.
fn wrap(sub_id: &str, ev: &WireEvent) -> Arc<WireEvent> {
    let data = format!("{{\"sub_id\":{},\"type\":{},\"data\":{}}}", json_str(sub_id), json_str(&ev.event), ev.data);
    Arc::new(WireEvent { event: "session_event".into(), data })
}

fn end_frame(sub_id: &str) -> Arc<WireEvent> {
    Arc::new(WireEvent { event: "session_stream_end".into(), data: format!("{{\"sub_id\":{}}}", json_str(sub_id)) })
}

async fn forward(queue: Queue, client_id: String, sub_id: String, session_id: String) {
    let attached = store().attach(&session_id);
    let had_turn = attached.is_some();
    if let Some(mut sub) = attached {
        while let Some(ev) = sub.next().await {
            if !queue.push(wrap(&sub_id, &ev)) {
                tracing::warn!("mux_subscriber_queue_full session_id={}", session_id);
                queue.terminate();
                return;
            }
        }
    }
    // No streaming turn (the database is authoritative) or the turn ended.
    tracing::info!("mux_subscription_ended client_id={} sub_id={} session_id={} reason={}", client_id, sub_id, session_id, if had_turn { "turn_over" } else { "no_turn" });
    queue.push(end_frame(&sub_id));
}

impl MuxClient {
    /// Subscription ids in `wanted` that are not attached yet.
    pub fn new_session_ids(&self, wanted: &[(String, String)]) -> Vec<String> {
        let subs = self.subs.lock().unwrap();
        wanted.iter().filter(|(id, sid)| subs.get(id).map(|(s, _)| s != sid).unwrap_or(true)).map(|(_, sid)| sid.clone()).collect()
    }

    /// Make the attached set equal `wanted` (`(subscription id, session id)`):
    /// the full desired state, so a repeated or reordered request is harmless.
    pub fn sync(&self, wanted: &[(String, String)]) {
        let mut subs = self.subs.lock().unwrap();
        let before = subs.len();
        subs.retain(|id, (_, handle)| {
            let keep = wanted.iter().any(|(w, _)| w == id);
            if !keep {
                handle.abort();
            }
            keep
        });
        let removed = before - subs.len();
        let mut added = 0;
        for (id, sid) in wanted {
            if subs.get(id).is_some_and(|(s, _)| s == sid) {
                continue;
            }
            if let Some((_, old)) = subs.remove(id) {
                old.abort();
            }
            let handle = tokio::spawn(forward(self.queue.clone(), self.id.clone(), id.clone(), sid.clone()));
            subs.insert(id.clone(), (sid.clone(), handle));
            added += 1;
        }
        // The only trace of which sessions a window's shared stream carries:
        // a chat that shows nothing is a subscription that never arrived here,
        // or one that ended.
        if added > 0 || removed > 0 {
            tracing::info!("mux_subscriptions_synced client_id={} added={} removed={} active={}", self.id, added, removed, subs.len());
        }
    }

    pub fn active(&self) -> usize {
        self.subs.lock().unwrap().len()
    }

    fn stop_all(&self) {
        for (_, (_, handle)) in self.subs.lock().unwrap().drain() {
            handle.abort();
        }
    }

    pub async fn recv(&self) -> Option<Arc<WireEvent>> {
        self.queue.recv().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_agent::{events, Envelope};
    use serde_json::json;

    fn session() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    async fn next(c: &MuxClient) -> (String, serde_json::Value) {
        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), c.recv()).await.expect("frame").expect("open");
        (ev.event.clone(), serde_json::from_str(&ev.data).unwrap())
    }

    #[test]
    fn ids_are_short_and_plain() {
        assert!(valid_id("a1-B_2.c"));
        assert!(!valid_id(""));
        assert!(!valid_id("a b"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(&"x".repeat(MAX_ID_LEN + 1)));
    }

    #[tokio::test]
    async fn a_subscription_replays_then_streams_and_ends_with_the_turn() {
        let sid = session();
        store().init_turn(&sid, false);
        store().push_event(&sid, &events::message("lead", "he", None), false);
        let (client, _guard) = register(&format!("c-{sid}"));
        client.sync(&[("s1".into(), sid.clone())]);

        // Replay of what the turn had so far, tagged with the subscription.
        let (name, v) = next(&client).await;
        assert_eq!((name.as_str(), v["sub_id"].as_str(), v["type"].as_str()), ("session_event", Some("s1"), Some("message")));
        assert_eq!(v["data"]["text"], "he");

        store().push_event(&sid, &events::message("lead", "llo", None), false);
        let (_, v) = next(&client).await;
        assert_eq!(v["data"]["text"], "llo");

        store().push_event(&sid, &Envelope::from_parts("done", json!({})), false);
        store().mark_done(&sid);
        let (_, v) = next(&client).await;
        assert_eq!(v["type"], "done");
        let (name, v) = next(&client).await;
        assert_eq!((name.as_str(), v["sub_id"].as_str()), ("session_stream_end", Some("s1")));
    }

    #[tokio::test]
    async fn a_session_with_no_turn_ends_at_once() {
        let (client, _guard) = register(&format!("c-{}", session()));
        client.sync(&[("s1".into(), session())]);
        let (name, v) = next(&client).await;
        assert_eq!((name.as_str(), v["sub_id"].as_str()), ("session_stream_end", Some("s1")));
    }

    #[tokio::test]
    async fn the_same_session_can_be_watched_twice_each_with_its_own_replay() {
        let sid = session();
        store().init_turn(&sid, false);
        store().push_event(&sid, &events::message("lead", "hi", None), false);
        let (client, _guard) = register(&format!("c-{sid}"));
        client.sync(&[("a".into(), sid.clone()), ("b".into(), sid.clone())]);
        let mut seen = vec![next(&client).await.1["sub_id"].as_str().unwrap().to_string(), next(&client).await.1["sub_id"].as_str().unwrap().to_string()];
        seen.sort();
        assert_eq!(seen, ["a", "b"]);
        store().clear(&sid);
    }

    #[tokio::test]
    async fn removing_a_subscription_detaches_it() {
        let sid = session();
        store().init_turn(&sid, false);
        let (client, _guard) = register(&format!("c-{sid}"));
        client.sync(&[("s1".into(), sid.clone())]);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(store().debug_state(&sid).unwrap()["subscribers"], 1);
        assert_eq!(client.active(), 1);

        client.sync(&[]);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(store().debug_state(&sid).unwrap()["subscribers"], 0);
        assert_eq!(client.active(), 0);
        store().clear(&sid);
    }

    #[tokio::test]
    async fn dropping_the_stream_unregisters_the_client_and_detaches_its_sessions() {
        let sid = session();
        store().init_turn(&sid, false);
        let id = format!("c-{sid}");
        let (client, guard) = register(&id);
        client.sync(&[("s1".into(), sid.clone())]);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(lookup(&id).is_some());

        drop(guard);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(lookup(&id).is_none());
        assert_eq!(store().debug_state(&sid).unwrap()["subscribers"], 0);
        store().clear(&sid);
    }

    #[tokio::test]
    async fn reconnecting_under_the_same_id_replaces_the_old_client() {
        let id = format!("c-{}", session());
        let (old, old_guard) = register(&id);
        let (_new, new_guard) = register(&id);
        assert!(old.recv().await.is_none(), "the replaced client's stream ends");
        drop(old_guard);
        assert!(lookup(&id).is_some(), "the old guard must not remove the new client");
        drop(new_guard);
        assert!(lookup(&id).is_none());
    }
}
