//! Commands from the agent to the page loaded for a preview.
//!
//! There is no headless browser: the inspector running in the page (the
//! Preview tab, or the app's background copy of it) long-polls its own
//! preview origin ([`crate::AGENT_PATH`]) for the next command and posts the
//! result back. A command therefore runs only while the page is loaded, and
//! [`AgentChannel::run`] fails fast when no inspector has polled recently;
//! callers that expect a page to appear soon use
//! [`AgentChannel::wait_connected`] first.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, watch, Notify};

/// How long one poll from the page waits for a command.
pub const POLL_WAIT: Duration = Duration::from_secs(25);
/// A page that last polled longer ago than this is treated as closed.
pub const STALE_AFTER: Duration = Duration::from_secs(10);
/// Largest accepted result body.
pub const MAX_RESULT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct AgentCommand {
    pub id: String,
    /// `{ "action": "click", "ref": "e3", ... }`
    pub command: Value,
}

/// A result posted by the page.
#[derive(Debug, Deserialize)]
pub struct AgentReply {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Value,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    /// No page has polled recently (nothing has loaded this preview yet, or
    /// the page was closed).
    NotConnected,
    /// The command waited in the queue without a page taking it.
    NotPickedUp,
    /// The page took the command but did not answer (it may have navigated).
    NoAnswer,
    /// The page answered with an error.
    Page(String),
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AgentError::NotConnected => f.write_str("No page is connected for this preview yet. Call preview with action 'open' again to load it, then retry."),
            AgentError::NotPickedUp => f.write_str("The page did not pick up the command. It may be closed or still loading; try again or call preview with action 'open'."),
            AgentError::NoAnswer => f.write_str("The page did not answer, probably because it navigated or reloaded. Call preview with action 'snapshot' to see the current page."),
            AgentError::Page(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for AgentError {}

#[derive(Default)]
struct State {
    queue: VecDeque<AgentCommand>,
    waiting: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    /// Commands handed to a page and not answered yet.
    taken: HashSet<String>,
    pollers: usize,
    last_poll: Option<Instant>,
}

#[derive(Default)]
pub struct AgentChannel {
    state: Mutex<State>,
    notify: Notify,
    /// Signalled (to all waiters) whenever a page starts a poll.
    polled: Notify,
}

struct PollGuard<'a>(&'a AgentChannel);

impl Drop for PollGuard<'_> {
    fn drop(&mut self) {
        let mut s = self.0.lock();
        s.pollers = s.pollers.saturating_sub(1);
        s.last_poll = Some(Instant::now());
    }
}

/// One command's bookkeeping, owned by the [`AgentChannel::run`] call that
/// sent it: however that call ends (answer, timeout, or its caller going
/// away), the command leaves the queue and the maps, so a page never runs a
/// command nobody waits for and nothing accumulates.
struct Pending<'a> {
    channel: &'a AgentChannel,
    id: String,
}

impl Pending<'_> {
    /// Takes the command back and tells whether a page had taken it, in one
    /// critical section: a page cannot take it between the answer and the
    /// withdrawal, so `NotPickedUp` always means the page never ran it.
    fn withdraw(&self) -> bool {
        let mut s = self.channel.lock();
        s.waiting.remove(&self.id);
        s.queue.retain(|c| c.id != self.id);
        s.taken.remove(&self.id)
    }
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.withdraw();
    }
}

impl AgentChannel {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Is a page polling now, or did one poll within [`STALE_AFTER`]?
    pub fn connected(&self) -> bool {
        let s = self.lock();
        s.pollers > 0 || s.last_poll.is_some_and(|t| t.elapsed() < STALE_AFTER)
    }

    /// When a page last polled (`None` if never).
    pub fn last_seen(&self) -> Option<Instant> {
        let s = self.lock();
        if s.pollers > 0 {
            return Some(Instant::now());
        }
        s.last_poll
    }

    /// Wait until a page is connected (see [`Self::connected`]); `true` as
    /// soon as one is, `false` if none connects within `within`.
    pub async fn wait_connected(&self, within: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let polled = self.polled.notified();
            tokio::pin!(polled);
            polled.as_mut().enable();
            if self.connected() {
                return true;
            }
            tokio::select! {
                _ = &mut polled => {}
                _ = tokio::time::sleep_until(deadline) => return self.connected(),
            }
        }
    }

    fn take(&self) -> Option<AgentCommand> {
        let mut s = self.lock();
        while let Some(cmd) = s.queue.pop_front() {
            // Skip commands whose caller already gave up.
            if s.waiting.contains_key(&cmd.id) {
                s.taken.insert(cmd.id.clone());
                return Some(cmd);
            }
        }
        None
    }

    /// The page's long poll: the next command, or `None` after `wait` or
    /// when the preview stops.
    pub async fn next(&self, wait: Duration, mut stop: watch::Receiver<bool>) -> Option<AgentCommand> {
        {
            let mut s = self.lock();
            s.pollers += 1;
            s.last_poll = Some(Instant::now());
        }
        self.polled.notify_waiters();
        let _guard = PollGuard(self);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(cmd) = self.take() {
                return Some(cmd);
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => return None,
                _ = stop.wait_for(|v| *v) => return None,
            }
        }
    }

    /// A result from the page. Unknown ids are ignored.
    pub fn resolve(&self, reply: AgentReply) {
        let tx = {
            let mut s = self.lock();
            s.taken.remove(&reply.id);
            s.waiting.remove(&reply.id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(if reply.ok { Ok(reply.result) } else { Err(reply.error.unwrap_or_else(|| "The page reported an error.".into())) });
        }
    }

    /// Send `command` to the page and wait up to `timeout` for its result.
    pub async fn run(&self, command: Value, timeout: Duration) -> Result<Value, AgentError> {
        let id = uuid::Uuid::new_v4().to_string();
        let (rx, pending) = {
            let mut s = self.lock();
            let live = s.pollers > 0 || s.last_poll.is_some_and(|t| t.elapsed() < STALE_AFTER);
            if !live {
                return Err(AgentError::NotConnected);
            }
            let (tx, rx) = oneshot::channel();
            s.waiting.insert(id.clone(), tx);
            s.queue.push_back(AgentCommand { id: id.clone(), command });
            (rx, Pending { channel: self, id })
        };
        self.notify.notify_one();
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result.map_err(AgentError::Page),
            _ => Err(if pending.withdraw() { AgentError::NoAnswer } else { AgentError::NotPickedUp }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn never_stop() -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        std::mem::forget(tx);
        rx
    }

    #[tokio::test]
    async fn fails_fast_without_a_page() {
        let ch = AgentChannel::default();
        assert!(!ch.connected());
        assert_eq!(ch.run(json!({"action": "snapshot"}), Duration::from_secs(5)).await, Err(AgentError::NotConnected));
    }

    #[tokio::test]
    async fn wait_connected_returns_when_a_page_polls_or_after_the_wait() {
        let ch = Arc::new(AgentChannel::default());
        assert!(!ch.wait_connected(Duration::from_millis(30)).await);
        let late = {
            let ch = ch.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                ch.next(Duration::from_millis(20), never_stop()).await
            })
        };
        let start = std::time::Instant::now();
        assert!(ch.wait_connected(Duration::from_secs(5)).await);
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(late.await.unwrap().is_none());
        // Already connected: returns at once.
        assert!(ch.wait_connected(Duration::ZERO).await);
    }

    #[tokio::test]
    async fn delivers_commands_to_the_polling_page_and_returns_its_result() {
        let ch = Arc::new(AgentChannel::default());
        let page = {
            let ch = ch.clone();
            tokio::spawn(async move {
                let cmd = ch.next(Duration::from_secs(5), never_stop()).await.unwrap();
                assert_eq!(cmd.command["action"], "click");
                ch.resolve(AgentReply { id: cmd.id, ok: true, result: json!({"clicked": true}), error: None });
            })
        };
        // Let the page start polling.
        while !ch.connected() {
            tokio::task::yield_now().await;
        }
        let out = ch.run(json!({"action": "click", "ref": "e1"}), Duration::from_secs(5)).await.unwrap();
        assert_eq!(out, json!({"clicked": true}));
        page.await.unwrap();
    }

    #[tokio::test]
    async fn reports_page_errors_and_unanswered_commands() {
        let ch = Arc::new(AgentChannel::default());
        let page = {
            let ch = ch.clone();
            tokio::spawn(async move {
                let first = ch.next(Duration::from_secs(5), never_stop()).await.unwrap();
                ch.resolve(AgentReply { id: first.id, ok: false, result: Value::Null, error: Some("No element e9.".into()) });
                // Take the second command and never answer (the page navigated).
                ch.next(Duration::from_secs(5), never_stop()).await.unwrap();
            })
        };
        while !ch.connected() {
            tokio::task::yield_now().await;
        }
        assert_eq!(ch.run(json!({"action": "click"}), Duration::from_secs(5)).await, Err(AgentError::Page("No element e9.".into())));
        assert_eq!(ch.run(json!({"action": "click"}), Duration::from_millis(200)).await, Err(AgentError::NoAnswer));
        page.await.unwrap();
        // Recently polled, but nobody takes it.
        assert_eq!(ch.run(json!({"action": "click"}), Duration::from_millis(100)).await, Err(AgentError::NotPickedUp));
        assert!(ch.lock().queue.is_empty() && ch.lock().waiting.is_empty() && ch.lock().taken.is_empty());
    }

    #[tokio::test]
    async fn polls_end_on_timeout_or_stop() {
        let ch = AgentChannel::default();
        assert!(ch.next(Duration::from_millis(20), never_stop()).await.is_none());
        assert!(ch.connected());
        let (tx, rx) = watch::channel(false);
        let poll = ch.next(Duration::from_secs(30), rx);
        tokio::pin!(poll);
        tokio::select! {
            _ = &mut poll => panic!("returned early"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
        tx.send(true).unwrap();
        assert!(poll.await.is_none());
    }

    /// A caller that stops waiting (the agent's Stop drops the tool call)
    /// takes its command back: the page never runs it and nothing is kept.
    #[tokio::test]
    async fn a_command_whose_caller_went_away_is_withdrawn() {
        let ch = Arc::new(AgentChannel::default());
        assert!(ch.next(Duration::ZERO, never_stop()).await.is_none(), "a page polled just now");
        let caller = {
            let ch = ch.clone();
            tokio::spawn(async move { ch.run(json!({"action": "click"}), Duration::from_secs(60)).await })
        };
        while ch.lock().waiting.is_empty() {
            tokio::task::yield_now().await;
        }
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        {
            let s = ch.lock();
            assert!(s.queue.is_empty() && s.waiting.is_empty() && s.taken.is_empty());
        }
        assert!(ch.take().is_none(), "the page got a command nobody waits for");
    }

    /// Same once the page has taken it: its late answer finds nothing.
    #[tokio::test]
    async fn a_taken_command_whose_caller_went_away_is_forgotten() {
        let ch = Arc::new(AgentChannel::default());
        assert!(ch.next(Duration::ZERO, never_stop()).await.is_none());
        let caller = {
            let ch = ch.clone();
            tokio::spawn(async move { ch.run(json!({"action": "click"}), Duration::from_secs(60)).await })
        };
        let cmd = ch.next(Duration::from_secs(5), never_stop()).await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        {
            let s = ch.lock();
            assert!(s.queue.is_empty() && s.waiting.is_empty() && s.taken.is_empty());
        }
        ch.resolve(AgentReply { id: cmd.id, ok: true, result: Value::Null, error: None });
    }

    /// How a timeout is reported matches what the page could do: after
    /// `NotPickedUp` the page can no longer get the command (so a retry does
    /// not run it twice); `NoAnswer` only for a command the page took.
    #[tokio::test(start_paused = true)]
    async fn a_timed_out_command_is_reported_by_whether_the_page_took_it() {
        let ch = Arc::new(AgentChannel::default());
        assert!(ch.next(Duration::ZERO, never_stop()).await.is_none(), "a page polled just now");
        let send = |ch: &Arc<AgentChannel>| {
            let ch = ch.clone();
            tokio::spawn(async move { ch.run(json!({"action": "click"}), Duration::from_secs(1)).await })
        };

        let caller = send(&ch);
        assert_eq!(caller.await.unwrap(), Err(AgentError::NotPickedUp));
        assert!(ch.take().is_none(), "a command reported as not picked up was still handed out");

        let caller = send(&ch);
        while ch.lock().waiting.is_empty() {
            tokio::task::yield_now().await;
        }
        let cmd = ch.take().expect("the page takes the command");
        assert_eq!(caller.await.unwrap(), Err(AgentError::NoAnswer));
        {
            let s = ch.lock();
            assert!(s.queue.is_empty() && s.waiting.is_empty() && s.taken.is_empty());
        }
        ch.resolve(AgentReply { id: cmd.id, ok: true, result: Value::Null, error: None });
    }

    /// The timeout's classification and withdrawal are one step: whatever
    /// `withdraw` reports, the command is gone from the queue and the maps.
    #[test]
    fn withdrawing_reports_whether_the_page_took_the_command() {
        let ch = AgentChannel::default();
        for page_takes in [false, true] {
            let (tx, _rx) = oneshot::channel();
            let id = format!("c-{page_takes}");
            {
                let mut s = ch.lock();
                s.waiting.insert(id.clone(), tx);
                s.queue.push_back(AgentCommand { id: id.clone(), command: Value::Null });
            }
            if page_takes {
                assert_eq!(ch.take().map(|c| c.id), Some(id.clone()));
            }
            let pending = Pending { channel: &ch, id };
            assert_eq!(pending.withdraw(), page_takes);
            drop(pending);
            let s = ch.lock();
            assert!(s.queue.is_empty() && s.waiting.is_empty() && s.taken.is_empty());
            drop(s);
            assert!(ch.take().is_none());
        }
    }
}
