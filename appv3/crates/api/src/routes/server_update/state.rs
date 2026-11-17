//! Whether this server is starting an update (`appv3/AGENTS.md` → State
//! machines). One value replaces the in-flight flag and the pending desktop
//! request it used to keep beside it. Once the helper is spawned, or the
//! desktop app collects its request, the status file (`upgrade-status.json`)
//! carries the run until it finishes.

use appv3_core::machine::{self, Machine};
use serde_json::Value;
use std::time::{Duration, Instant};

/// How long a request waits for the desktop app (it collects every 2 s)
/// before the run is settled as not started.
pub const PICKUP_WITHIN: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateState {
    Idle,
    /// A POST is recording the run and starting it.
    Starting,
    /// The request waits for the desktop app: `{target, started_at}`.
    Requested {
        request: Value,
        at: Instant,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateEvent {
    Begin,
    /// Recorded for the desktop app to collect.
    Request {
        request: Value,
        at: Instant,
    },
    /// The POST is done with it: the helper runs (the status file says so)
    /// or could not start.
    Release,
    /// The desktop app collected the request.
    Collect,
    /// The app did not collect it within [`PICKUP_WITHIN`].
    Expire,
}

pub struct UpdateMachine;

impl Machine for UpdateMachine {
    const NAME: &'static str = "server update";
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] = &[
        ("idle", "begin", "starting"),
        ("starting", "request", "requested"),
        ("starting", "release", "idle"),
        // The request was handed over (or expired) before the POST let go.
        ("idle", "release", "idle"),
        ("requested", "release", "requested"),
        ("requested", "collect", "idle"),
        ("requested", "expire", "idle"),
    ];
    type State = UpdateState;
    type Event = UpdateEvent;

    fn state_kind(s: &UpdateState) -> &'static str {
        match s {
            UpdateState::Idle => "idle",
            UpdateState::Starting => "starting",
            UpdateState::Requested { .. } => "requested",
        }
    }

    fn event_kind(e: &UpdateEvent) -> &'static str {
        match e {
            UpdateEvent::Begin => "begin",
            UpdateEvent::Request { .. } => "request",
            UpdateEvent::Release => "release",
            UpdateEvent::Collect => "collect",
            UpdateEvent::Expire => "expire",
        }
    }

    fn step(s: &UpdateState, e: &UpdateEvent) -> Option<UpdateState> {
        use UpdateEvent as E;
        use UpdateState as S;
        Some(match (s, e) {
            (S::Idle, E::Begin) => S::Starting,
            (S::Starting, E::Request { request, at }) => S::Requested { request: request.clone(), at: *at },
            (S::Starting | S::Idle, E::Release) => S::Idle,
            (S::Requested { .. }, E::Release) => s.clone(),
            (S::Requested { .. }, E::Collect | E::Expire) => S::Idle,
            _ => return None,
        })
    }
}

impl UpdateState {
    /// A request the app should have collected by `now`.
    pub fn overdue(&self, now: Instant) -> bool {
        matches!(self, UpdateState::Requested { at, .. } if now.saturating_duration_since(*at) >= PICKUP_WITHIN)
    }
}

/// Begin an update, unless one is already starting or waiting: `false` then
/// (an ordinary refusal, answered 409).
pub fn try_begin(state: &mut UpdateState) -> bool {
    match UpdateMachine::step(state, &UpdateEvent::Begin) {
        Some(next) => {
            *state = next;
            true
        }
        None => false,
    }
}

/// Move `state` by `event`, which must be legal.
pub fn apply(state: &mut UpdateState, event: UpdateEvent) {
    let _ = machine::apply::<UpdateMachine>(state, &event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_core::machine::check_table;
    use serde_json::json;

    #[test]
    fn step_allows_exactly_the_table() {
        let now = Instant::now();
        let requested = UpdateState::Requested { request: json!({}), at: now };
        check_table::<UpdateMachine>(
            &[UpdateState::Idle, UpdateState::Starting, requested],
            &[UpdateEvent::Begin, UpdateEvent::Request { request: json!({}), at: now }, UpdateEvent::Release, UpdateEvent::Collect, UpdateEvent::Expire],
        );
    }

    #[test]
    fn a_second_update_cannot_begin_while_one_starts_or_waits() {
        let requested = UpdateState::Requested { request: json!({}), at: Instant::now() };
        for s in [UpdateState::Starting, requested] {
            assert_eq!(UpdateMachine::step(&s, &UpdateEvent::Begin), None, "{s:?}");
        }
    }

    #[test]
    fn a_request_is_overdue_only_after_the_pickup_window() {
        let at = Instant::now();
        let s = UpdateState::Requested { request: json!({}), at };
        assert!(!s.overdue(at + PICKUP_WITHIN - Duration::from_secs(1)));
        assert!(s.overdue(at + PICKUP_WITHIN));
        assert!(!UpdateState::Idle.overdue(at + PICKUP_WITHIN * 2));
    }
}
