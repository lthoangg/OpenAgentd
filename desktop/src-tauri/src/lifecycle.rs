//! Who owns the bundled sidecar.
//!
//! Every ownership decision about the bundled backend goes through
//! [`SidecarSlot`]: a deliberate stop (Stop, quit, restart, update), the
//! watchdog taking a crashed child, a force reload replacing the child, and
//! an attempt publishing the child it started. The slot counts those
//! decisions. An [`Attempt`] remembers the count it began from and may only
//! publish while nothing was decided since; otherwise its child is handed
//! back to be shut down, so a stop is never undone by an older start.
//!
//! The slot also knows, under the same lock, whether an attempt is in
//! flight and whether a crashed child awaits recovery. So the watchdog
//! cannot take a crash out from under a running start, and a stop can say
//! whether a bundled backend was wanted even when it interrupted a start
//! rather than a running child. An in-flight attempt is told about a stop
//! through [`Attempt::superseded`], so it can shut its child down at once
//! instead of after its handshake and health wait.
//!
//! Phase projections stay where the UI reads them: `backend_starting` and
//! `backend_failed` (owned by [`BackendStartGuard`], one per attempt, only
//! changed under the slot lock) and a live child in the slot. Whole-app
//! intent (quitting, force reload, update install) lives beside it in
//! `AppState` and is not a sidecar phase.
//!
//! The process layer (spawn, handshake, health, cleanup) is `sidecar.rs`.

use std::future::Future;
use std::process::ExitStatus;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::BackendStartGuard;

/// The process facts the slot needs. `Sidecar` in the app, a fake in tests.
pub trait OwnedChild {
    fn is_alive(&mut self) -> bool;
    /// Exit status once the child exited on its own (reaping it).
    fn exit_status(&mut self) -> Option<ExitStatus>;
    /// The child is now the published backend: the slot owns its lifetime,
    /// so it is no longer an attempt's to clean up when dropped.
    fn published(&mut self);
}

/// Why an attempt runs. Spawn, handshake, health and cleanup are the same
/// for all of them (`sidecar::start_ready`); only the guards differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptCause {
    /// Launch, Retry / "use builtin", or recovery after a failed update.
    Requested,
    /// The watchdog restarting the child it took at decision `observed`.
    /// Any later decision (a stop, another start) supersedes it.
    Recovery { observed: u64 },
    /// Force reload: replaces the running child inside its own attempt.
    Reload,
}

/// Why an attempt was not started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    AlreadyStarting,
    AlreadyRunning,
    /// A stop or another start was decided after the crash it would recover.
    Superseded,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::AlreadyStarting => "bundled backend is already starting",
            Self::AlreadyRunning => "bundled backend is already running",
            Self::Superseded => "bundled backend was stopped or started again",
        })
    }
}

struct SlotState<T> {
    child: Option<T>,
    decisions: u64,
    /// An [`Attempt`] exists (begun, not yet committed or dropped).
    in_flight: bool,
    /// The watchdog took a crashed child and no start or stop came since.
    recovery_pending: bool,
    /// The start flag of the attempt in flight, released under the lock.
    guard: Option<BackendStartGuard>,
}

impl<T> SlotState<T> {
    fn decide(&mut self, decided: &watch::Sender<u64>) {
        self.decisions += 1;
        decided.send_replace(self.decisions);
    }

    /// End the attempt in flight. `completed`: it published or was
    /// superseded, so it is not a failed start.
    fn end_attempt(&mut self, completed: bool) {
        self.in_flight = false;
        if let Some(mut guard) = self.guard.take() {
            if completed {
                guard.complete();
            }
        }
    }
}

struct Shared<T> {
    state: Mutex<SlotState<T>>,
    /// The decision count, for attempts waiting to learn they were superseded.
    decided: watch::Sender<u64>,
}

impl<T> Shared<T> {
    fn lock(&self) -> std::sync::MutexGuard<'_, SlotState<T>> {
        // Every critical section only moves plain data; a panic in one
        // leaves the state consistent, so keep going.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One start attempt. Dropping it without a commit records a failed start
/// (the guard's `backend_failed`) and frees the start.
pub struct Attempt<T> {
    cause: AttemptCause,
    decided_at: u64,
    shared: Arc<Shared<T>>,
    ended: bool,
}

impl<T> Attempt<T> {
    /// Resolves once a stop or another decision supersedes this attempt
    /// (immediately if one already did). Take it after `take_for_reload`.
    pub fn superseded(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut decided = self.shared.decided.subscribe();
        let at = self.decided_at;
        async move {
            let changed = decided.wait_for(|d| *d != at).await.is_ok();
            if !changed {
                // The slot is gone with the app; nothing will decide again.
                std::future::pending::<()>().await;
            }
        }
    }

    /// The attempt stopped because it was superseded and already shut its
    /// child down: not a failed start, so no recovery screen.
    pub fn finish_superseded(mut self) {
        self.ended = true;
        self.shared.lock().end_attempt(true);
    }
}

impl<T> Drop for Attempt<T> {
    fn drop(&mut self) {
        if !self.ended {
            self.shared.lock().end_attempt(false);
        }
    }
}

/// What became of an attempt's healthy child.
#[derive(Debug)]
pub enum Commit<T> {
    /// Stored as the bundled backend. `replaced` is a child that was still
    /// in the slot (normally `None`); the caller shuts it down.
    Published { replaced: Option<T> },
    /// A stop or another start was decided meanwhile: not published; the
    /// caller shuts the child down.
    Superseded(T),
}

/// What a stop took.
pub struct Stopped<T> {
    /// The child to shut down, if one was published.
    pub child: Option<T>,
    /// A bundled backend was running, starting, or awaiting crash recovery:
    /// what to bring back if the reason for the stop is undone (a failed
    /// update install).
    pub had_backend: bool,
}

pub struct SidecarSlot<T> {
    shared: Arc<Shared<T>>,
}

impl<T> Default for SidecarSlot<T> {
    fn default() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(SlotState {
                    child: None,
                    decisions: 0,
                    in_flight: false,
                    recovery_pending: false,
                    guard: None,
                }),
                decided: watch::Sender::new(0),
            }),
        }
    }
}

impl<T: OwnedChild> SidecarSlot<T> {
    /// A child is stored and still running.
    pub async fn alive(&self) -> bool {
        self.shared.lock().child.as_mut().is_some_and(|c| c.is_alive())
    }

    /// Start an attempt, or say why not. Checked under the slot lock, so it
    /// is atomic with stops, commits and the watchdog taking a crash.
    pub async fn begin(
        &self,
        cause: AttemptCause,
        starting: &Arc<AtomicBool>,
        failed: &Arc<AtomicBool>,
    ) -> Result<Attempt<T>, Refused> {
        let mut state = self.shared.lock();
        if let AttemptCause::Recovery { observed } = cause {
            if state.decisions != observed {
                return Err(Refused::Superseded);
            }
        }
        if state.in_flight {
            return Err(Refused::AlreadyStarting);
        }
        if cause != AttemptCause::Reload && state.child.as_mut().is_some_and(|c| c.is_alive()) {
            return Err(Refused::AlreadyRunning);
        }
        let guard = BackendStartGuard::try_acquire(starting.clone(), failed.clone())
            .ok_or(Refused::AlreadyStarting)?;
        state.guard = Some(guard);
        state.in_flight = true;
        // The attempt now carries the intent a pending recovery held.
        state.recovery_pending = false;
        Ok(Attempt { cause, decided_at: state.decisions, shared: self.shared.clone(), ended: false })
    }

    /// Take the running child out for a reload attempt to shut down. The
    /// reload's own decision does not supersede it. (macOS reloads by
    /// restarting the whole app instead.)
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub async fn take_for_reload(&self, attempt: &mut Attempt<T>) -> Option<T> {
        debug_assert_eq!(attempt.cause, AttemptCause::Reload);
        let mut state = self.shared.lock();
        if state.decisions != attempt.decided_at {
            // Something else decided first; commit will report it.
            return None;
        }
        state.decide(&self.shared.decided);
        attempt.decided_at = state.decisions;
        state.child.take()
    }

    /// Publish a healthy child, unless a later decision superseded the attempt.
    pub async fn commit(&self, mut attempt: Attempt<T>, mut child: T) -> Commit<T> {
        let mut state = self.shared.lock();
        attempt.ended = true;
        // Superseded is not a failed start: the user (or a newer attempt)
        // decided, so no recovery screen.
        state.end_attempt(true);
        if state.decisions != attempt.decided_at {
            return Commit::Superseded(child);
        }
        state.decide(&self.shared.decided);
        child.published();
        Commit::Published { replaced: state.child.replace(child) }
    }

    /// A deliberate stop: take the child (the caller shuts it down) and
    /// supersede every attempt and pending recovery that began before it.
    pub async fn stop(&self) -> Stopped<T> {
        let mut state = self.shared.lock();
        state.decide(&self.shared.decided);
        let child = state.child.take();
        let had_backend = child.is_some() || state.in_flight || state.recovery_pending;
        state.recovery_pending = false;
        Stopped { child, had_backend }
    }

    /// Take the child if it exited on its own. Returns its status and the
    /// decision a recovery attempt must still be current at. Nothing while
    /// an attempt is in flight: that attempt owns what runs next, and its
    /// commit hands the dead child back for cleanup.
    pub async fn take_exited(&self) -> Option<(ExitStatus, u64)> {
        let mut state = self.shared.lock();
        if state.in_flight {
            return None;
        }
        let status = state.child.as_mut()?.exit_status()?;
        state.child.take();
        state.decide(&self.shared.decided);
        state.recovery_pending = true;
        Some((status, state.decisions))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    /// A child that is alive until `exited` is set.
    #[derive(Debug, PartialEq)]
    struct Fake {
        id: u32,
        exited: bool,
        published: bool,
    }

    fn fake(id: u32) -> Fake {
        Fake { id, exited: false, published: false }
    }

    fn crashed(id: u32) -> Fake {
        Fake { id, exited: true, published: true }
    }

    impl OwnedChild for Fake {
        fn is_alive(&mut self) -> bool {
            !self.exited
        }
        fn exit_status(&mut self) -> Option<ExitStatus> {
            self.exited.then(exit_status)
        }
        fn published(&mut self) {
            self.published = true;
        }
    }

    #[cfg(unix)]
    fn exit_status() -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(1 << 8)
    }

    #[cfg(windows)]
    fn exit_status() -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(1)
    }

    struct Flags {
        starting: Arc<AtomicBool>,
        failed: Arc<AtomicBool>,
    }

    fn flags() -> Flags {
        Flags { starting: Arc::default(), failed: Arc::default() }
    }

    async fn begin(slot: &SidecarSlot<Fake>, f: &Flags, cause: AttemptCause) -> Result<Attempt<Fake>, Refused> {
        slot.begin(cause, &f.starting, &f.failed).await
    }

    fn set_child(slot: &SidecarSlot<Fake>, child: Fake) {
        slot.shared.lock().child = Some(child);
    }

    fn child_id(slot: &SidecarSlot<Fake>) -> Option<u32> {
        slot.shared.lock().child.as_ref().map(|c| c.id)
    }

    fn published(commit: Commit<Fake>) -> Option<Fake> {
        match commit {
            Commit::Published { replaced } => replaced,
            Commit::Superseded(child) => panic!("expected publish, got superseded {child:?}"),
        }
    }

    /// Whether `fut` has resolved, without waiting for it.
    async fn resolved(fut: impl Future<Output = ()>) -> bool {
        tokio::time::timeout(Duration::ZERO, fut).await.is_ok()
    }

    #[tokio::test]
    async fn a_second_start_while_one_runs_is_refused_and_owns_nothing() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let first = begin(&slot, &f, AttemptCause::Requested).await.expect("first");

        assert_eq!(begin(&slot, &f, AttemptCause::Requested).await.err(), Some(Refused::AlreadyStarting));
        assert_eq!(begin(&slot, &f, AttemptCause::Reload).await.err(), Some(Refused::AlreadyStarting));

        assert_eq!(published(slot.commit(first, fake(1)).await), None);
        assert!(slot.alive().await);
        assert!(!f.starting.load(Ordering::SeqCst));
        assert!(!f.failed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_published_child_is_marked_as_owned_by_the_slot() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let attempt = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        published(slot.commit(attempt, fake(1)).await);

        assert!(slot.shared.lock().child.as_ref().unwrap().published);
    }

    #[tokio::test]
    async fn a_start_after_another_published_finds_it_running_instead_of_spawning() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let first = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        published(slot.commit(first, fake(1)).await);

        assert_eq!(begin(&slot, &f, AttemptCause::Requested).await.err(), Some(Refused::AlreadyRunning));
        assert!(!f.starting.load(Ordering::SeqCst), "a refused start leaves no start flag");
    }

    #[tokio::test]
    async fn a_stop_during_a_start_is_not_undone_when_the_start_finishes() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let attempt = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        assert!(slot.stop().await.child.is_none());

        match slot.commit(attempt, fake(1)).await {
            Commit::Superseded(child) => {
                assert_eq!(child.id, 1, "the caller gets its child back to shut down");
                assert!(!child.published, "an unpublished child stays the attempt's to clean up");
            }
            Commit::Published { .. } => panic!("an old attempt published over a newer stop"),
        }
        assert!(!slot.alive().await);
        assert!(!f.starting.load(Ordering::SeqCst));
        assert!(!f.failed.load(Ordering::SeqCst), "a stopped start is not a failed start");
    }

    #[tokio::test]
    async fn a_stop_wakes_the_attempt_it_supersedes() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let attempt = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        let superseded = attempt.superseded();
        tokio::pin!(superseded);
        assert!(!resolved(&mut superseded).await, "nothing decided yet");

        slot.stop().await;

        assert!(resolved(&mut superseded).await, "the attempt learns of the stop while it waits");
        attempt.finish_superseded();
        assert!(!f.starting.load(Ordering::SeqCst));
        assert!(!f.failed.load(Ordering::SeqCst), "a stopped start is not a failed start");
        assert!(begin(&slot, &f, AttemptCause::Requested).await.is_ok(), "the start is free again");
    }

    #[tokio::test]
    async fn a_reload_is_not_woken_by_taking_its_own_child() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let a = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        published(slot.commit(a, fake(1)).await);
        let mut reload = begin(&slot, &f, AttemptCause::Reload).await.unwrap();
        slot.take_for_reload(&mut reload).await;

        let superseded = reload.superseded();
        tokio::pin!(superseded);
        assert!(!resolved(&mut superseded).await);
        slot.stop().await;
        assert!(resolved(&mut superseded).await);
    }

    #[tokio::test]
    async fn a_stop_that_interrupts_a_start_reports_that_a_backend_was_wanted() {
        // An update tearing down while a Retry / recovery is starting: a
        // failed install must bring the backend back, not leave none.
        let (slot, f) = (SidecarSlot::<Fake>::default(), flags());
        let _attempt = begin(&slot, &f, AttemptCause::Requested).await.unwrap();

        let stopped = slot.stop().await;

        assert!(stopped.child.is_none());
        assert!(stopped.had_backend);
    }

    #[tokio::test]
    async fn a_stop_during_the_watchdog_backoff_reports_that_a_backend_was_wanted() {
        let slot = SidecarSlot::<Fake>::default();
        set_child(&slot, crashed(1));
        slot.take_exited().await.expect("crash observed");

        assert!(slot.stop().await.had_backend);
        assert!(!slot.stop().await.had_backend, "the first stop consumed the pending recovery");
    }

    #[tokio::test]
    async fn a_stop_with_nothing_running_or_starting_reports_no_backend() {
        let (slot, f) = (SidecarSlot::<Fake>::default(), flags());
        assert!(!slot.stop().await.had_backend);

        drop(begin(&slot, &f, AttemptCause::Requested).await.unwrap()); // failed start
        assert!(!slot.stop().await.had_backend);
    }

    #[tokio::test]
    async fn a_stop_of_a_running_child_hands_it_over() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let a = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        published(slot.commit(a, fake(1)).await);

        let stopped = slot.stop().await;

        assert_eq!(stopped.child.map(|c| c.id), Some(1));
        assert!(stopped.had_backend);
        assert!(!slot.alive().await);
    }

    #[tokio::test]
    async fn a_failed_attempt_frees_the_start_and_records_the_failure() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let attempt = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        assert!(f.starting.load(Ordering::SeqCst));

        drop(attempt); // handshake or health failed; the child was cleaned up

        assert!(!f.starting.load(Ordering::SeqCst));
        assert!(f.failed.load(Ordering::SeqCst));
        assert!(begin(&slot, &f, AttemptCause::Requested).await.is_ok(), "Retry can start again");
    }

    #[tokio::test]
    async fn the_watchdog_recovers_a_crash_nobody_acted_on() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let a = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        published(slot.commit(a, fake(1)).await);
        assert_eq!(slot.take_exited().await.map(|(_, at)| at), None, "a live child is left alone");

        slot.shared.lock().child.as_mut().unwrap().exited = true;
        let (_, observed) = slot.take_exited().await.expect("crash observed");
        assert!(!slot.alive().await);

        let recovery = begin(&slot, &f, AttemptCause::Recovery { observed }).await.expect("recovery");
        assert_eq!(published(slot.commit(recovery, fake(2)).await), None);
        assert!(slot.alive().await);
    }

    #[tokio::test]
    async fn the_watchdog_leaves_a_crash_to_the_start_already_in_flight() {
        // Retry began while the old child lay dead in the slot. Taking the
        // crash now would supersede Retry while the watchdog's own restart
        // is refused as AlreadyStarting: no backend at all.
        let (slot, f) = (SidecarSlot::default(), flags());
        set_child(&slot, crashed(1));
        let retry = begin(&slot, &f, AttemptCause::Requested).await.expect("a dead child does not block a start");

        assert_eq!(slot.take_exited().await.map(|(_, at)| at), None);

        let replaced = published(slot.commit(retry, fake(2)).await);
        assert_eq!(replaced.map(|c| c.id), Some(1), "the dead child comes back for cleanup");
        assert_eq!(child_id(&slot), Some(2));
        assert!(slot.alive().await);
    }

    #[tokio::test]
    async fn a_stop_during_the_watchdog_backoff_is_not_undone() {
        let (slot, f) = (SidecarSlot::<Fake>::default(), flags());
        set_child(&slot, crashed(1));
        let (_, observed) = slot.take_exited().await.unwrap();

        slot.stop().await; // "Stop bundled backend" while the watchdog sleeps

        assert_eq!(
            begin(&slot, &f, AttemptCause::Recovery { observed }).await.err(),
            Some(Refused::Superseded)
        );
        assert!(!f.failed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_manual_start_during_the_watchdog_backoff_wins() {
        let (slot, f) = (SidecarSlot::<Fake>::default(), flags());
        set_child(&slot, crashed(1));
        let (_, observed) = slot.take_exited().await.unwrap();
        let manual = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        assert_eq!(
            begin(&slot, &f, AttemptCause::Recovery { observed }).await.err(),
            Some(Refused::AlreadyStarting),
            "the watchdog yields while the manual start runs"
        );
        published(slot.commit(manual, fake(2)).await);

        assert_eq!(
            begin(&slot, &f, AttemptCause::Recovery { observed }).await.err(),
            Some(Refused::Superseded),
            "no second child replaces (and orphans) the manual one"
        );
        assert_eq!(child_id(&slot), Some(2));
    }

    #[tokio::test]
    async fn a_recovery_that_began_is_superseded_by_a_stop_before_it_publishes() {
        let (slot, f) = (SidecarSlot::<Fake>::default(), flags());
        set_child(&slot, crashed(1));
        let (_, observed) = slot.take_exited().await.unwrap();
        let recovery = begin(&slot, &f, AttemptCause::Recovery { observed }).await.unwrap();

        assert!(slot.stop().await.had_backend, "the recovery in flight was the wanted backend");

        assert!(matches!(slot.commit(recovery, fake(2)).await, Commit::Superseded(_)));
        assert!(!slot.alive().await);
    }

    #[tokio::test]
    async fn a_reload_replaces_the_running_child_within_its_own_attempt() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let a = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        published(slot.commit(a, fake(1)).await);

        let mut reload = begin(&slot, &f, AttemptCause::Reload).await.expect("reload of a running child");
        assert_eq!(slot.take_for_reload(&mut reload).await.map(|c| c.id), Some(1));
        assert!(!slot.alive().await);

        assert_eq!(published(slot.commit(reload, fake(2)).await), None);
        assert_eq!(child_id(&slot), Some(2));
    }

    #[tokio::test]
    async fn a_stop_during_a_reload_is_not_undone() {
        let (slot, f) = (SidecarSlot::default(), flags());
        let a = begin(&slot, &f, AttemptCause::Requested).await.unwrap();
        published(slot.commit(a, fake(1)).await);
        let mut reload = begin(&slot, &f, AttemptCause::Reload).await.unwrap();
        slot.take_for_reload(&mut reload).await;

        assert!(slot.stop().await.had_backend);

        assert!(matches!(slot.commit(reload, fake(2)).await, Commit::Superseded(_)));
    }
}
