//! Bounded subscriber queue with v2 asyncio.Queue drop semantics: a full
//! queue can always be terminated (oldest item dropped for the sentinel).

use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::Notify;

pub struct SubQueue<T> {
    items: Mutex<VecDeque<Option<T>>>,
    cap: usize,
    notify: Notify,
}

impl<T> SubQueue<T> {
    pub fn new(cap: usize) -> Self {
        Self { items: Mutex::new(VecDeque::new()), cap, notify: Notify::new() }
    }

    pub fn len(&self) -> usize {
        self.items.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[cfg(test)]
    pub(crate) fn items_for_test(&self) -> std::sync::MutexGuard<'_, VecDeque<Option<T>>> {
        self.items.lock().unwrap()
    }

    /// `put_nowait`; `false` when full.
    pub fn push(&self, item: T) -> bool {
        let mut q = self.items.lock().unwrap();
        if q.len() >= self.cap {
            return false;
        }
        q.push_back(Some(item));
        drop(q);
        self.notify.notify_one();
        true
    }

    /// Leave a terminal marker, dropping the oldest item if full.
    pub fn terminate(&self) {
        let mut q = self.items.lock().unwrap();
        if q.len() >= self.cap {
            q.pop_front();
        }
        q.push_back(None);
        drop(q);
        self.notify.notify_one();
    }

    /// Next item; `None` means the sentinel was reached.
    pub async fn recv(&self) -> Option<T> {
        loop {
            let notified = self.notify.notified();
            {
                let mut q = self.items.lock().unwrap();
                if let Some(item) = q.pop_front() {
                    return item;
                }
            }
            notified.await;
        }
    }
}
