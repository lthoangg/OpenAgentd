//! Process-local global SSE fan-out.
//! Retains no state: clients only see events published while connected.

use crate::events::{compact, WireEvent};
use crate::queue::SubQueue;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const QUEUE_SIZE: usize = 256;

type Sub = Arc<SubQueue<Arc<WireEvent>>>;

#[derive(Default)]
pub struct Broadcaster {
    subs: Mutex<Vec<Sub>>,
    /// Set on server shutdown: open streams end and new ones end at once,
    /// so they cannot hold the graceful drain open.
    closed: AtomicBool,
    /// In-process listeners for one event (see [`Broadcaster::tap`]). Not
    /// clients: they do not count in [`Broadcaster::subscriber_count`].
    taps: Mutex<Vec<(String, tokio::sync::mpsc::UnboundedSender<Value>)>>,
}

pub fn broadcaster() -> &'static Broadcaster {
    static B: OnceLock<Broadcaster> = OnceLock::new();
    B.get_or_init(Broadcaster::default)
}

/// Shorthand for `broadcaster().publish`.
pub fn publish(event: &str, data: Value) {
    broadcaster().publish(event, data);
}

/// A message was queued on `session_id` (`at` is its stored time) without
/// starting a turn. Saving it moved the session's `last_message_at`, so
/// clients that sort sessions by activity move it up without a refetch.
/// Turns announce themselves (`session_turn_started`); this covers the rest.
pub fn publish_session_activity(session_id: &str, at: &str) {
    publish("session_activity", serde_json::json!({"session_id": appv3_db::codec::api_uuid(session_id), "last_message_at": appv3_db::codec::api_dt(at)}));
}

impl Broadcaster {
    pub fn publish(&self, event: &str, data: Value) {
        crate::events::check_contract(crate::events::Stream::Global, event);
        {
            let mut taps = self.taps.lock().unwrap();
            taps.retain(|(name, tx)| name != event || tx.send(data.clone()).is_ok());
        }
        let wire = Arc::new(WireEvent { event: event.to_string(), data: compact(&data) });
        let mut subs = self.subs.lock().unwrap();
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
        let q: Sub = Arc::new(SubQueue::new(QUEUE_SIZE));
        let mut subs = self.subs.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            q.terminate();
        } else {
            subs.push(q.clone());
        }
        drop(subs);
        GlobalSubscription { owner: self, queue: q }
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
}
