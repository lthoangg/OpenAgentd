//! Small helpers shared across the agent crate.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

pub use appv3_core::pyjson::truthy;

/// `asyncio.Event` equivalent.
#[derive(Clone, Default)]
pub struct Event {
    inner: Arc<EventInner>,
}

#[derive(Default)]
struct EventInner {
    flag: AtomicBool,
    notify: Notify,
}

impl Event {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set(&self) {
        self.inner.flag.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }
    pub fn clear(&self) {
        self.inner.flag.store(false, Ordering::SeqCst);
    }
    pub fn is_set(&self) -> bool {
        self.inner.flag.load(Ordering::SeqCst)
    }
    pub async fn wait(&self) {
        loop {
            let n = self.inner.notify.notified();
            if self.is_set() {
                return;
            }
            n.await;
        }
    }
    /// `True` when the event fired before `d` elapsed.
    pub async fn wait_timeout(&self, d: std::time::Duration) -> bool {
        tokio::time::timeout(d, self.wait()).await.is_ok()
    }
}

/// Python `str[:n]` by characters.
pub fn head_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Python `str[-n:]` by characters.
pub fn tail_chars(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    if count <= n {
        return s;
    }
    let skip = count - n;
    match s.char_indices().nth(skip) {
        Some((i, _)) => &s[i..],
        None => "",
    }
}
