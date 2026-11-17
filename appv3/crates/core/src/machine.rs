//! One lifecycle, one state value, one table of moves (`appv3/AGENTS.md` →
//! State machines).
//!
//! A machine is an enum of states (data inside the variant that owns it), an
//! enum of events, a written table of the allowed moves, and one function,
//! [`Machine::step`], that makes them. Nothing else changes the state: keep
//! the field private to the module that owns the machine, so the compiler
//! refuses a write from anywhere else.
//!
//! - [`Machine::step`] answers "may this happen now?" without side effects:
//!   use it where a refusal is an ordinary outcome (a busy session refusing a
//!   second turn).
//! - [`apply`] makes a move that must be legal. One outside the table leaves
//!   the state as it was and logs `illegal_transition machine=… from=…
//!   event=…` (telemetry picks it up); debug builds panic, as an unlisted SSE
//!   event does, so tests catch it.
//! - [`check_table`] is the test: `step` must allow exactly the moves in
//!   [`Machine::TRANSITIONS`], landing where the table says.

/// A lifecycle written as one state value and one table of allowed moves.
pub trait Machine {
    /// The machine's name in logs and test failures.
    const NAME: &'static str;
    /// Every allowed move, as `(from, event, to)` kinds: the table to read
    /// first. [`check_table`] holds [`Machine::step`] to it.
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)];
    type State;
    type Event;
    /// The state's kind: its variant's name in `TRANSITIONS`.
    fn state_kind(state: &Self::State) -> &'static str;
    /// The event's kind: its variant's name in `TRANSITIONS`.
    fn event_kind(event: &Self::Event) -> &'static str;
    /// The state after `event`, or `None` when `event` is not allowed in
    /// `state`. Pure: the only place a next state is decided.
    fn step(state: &Self::State, event: &Self::Event) -> Option<Self::State>;
}

/// A move the table does not allow.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{machine}: {event} is not allowed in {from}")]
pub struct IllegalTransition {
    pub machine: &'static str,
    pub from: &'static str,
    pub event: &'static str,
}

/// Move `state` by `event`, which must be legal. An illegal move leaves
/// `state` unchanged, is logged, and panics in debug builds.
pub fn apply<M: Machine>(state: &mut M::State, event: &M::Event) -> Result<(), IllegalTransition> {
    match M::step(state, event) {
        Some(next) => {
            *state = next;
            Ok(())
        }
        None => {
            let err = IllegalTransition { machine: M::NAME, from: M::state_kind(state), event: M::event_kind(event) };
            tracing::warn!(machine = err.machine, from = err.from, event = err.event, "illegal_transition");
            debug_assert!(false, "illegal_transition: {err}");
            Err(err)
        }
    }
}

/// Test helper: for every state in `states` and event in `events`, `step`
/// allows the move exactly when `TRANSITIONS` lists it, and lands on the
/// listed kind. Panics naming each disagreement, and any table row that no
/// sample reached (a sample is missing, or the row is dead).
pub fn check_table<M: Machine>(states: &[M::State], events: &[M::Event]) {
    let mut wrong = Vec::new();
    let mut reached = std::collections::HashSet::new();
    for state in states {
        for event in events {
            let (from, ev) = (M::state_kind(state), M::event_kind(event));
            let listed = M::TRANSITIONS.iter().find(|(f, e, _)| *f == from && *e == ev).map(|(_, _, to)| *to);
            let actual = M::step(state, event).map(|next| M::state_kind(&next));
            if listed != actual {
                wrong.push(format!("{from} --{ev}--> table: {listed:?}, step: {actual:?}"));
            }
            if listed.is_some() {
                reached.insert((from, ev));
            }
        }
    }
    let unreached: Vec<_> = M::TRANSITIONS.iter().filter(|(f, e, _)| !reached.contains(&(*f, *e))).collect();
    assert!(wrong.is_empty() && unreached.is_empty(), "{} disagrees with its table:\n{}\nrows no sample reached: {unreached:?}", M::NAME, wrong.join("\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A door: the smallest machine with data in a state.
    #[derive(Debug, Clone, PartialEq)]
    enum Door {
        Open,
        Closed,
        Locked { key: u8 },
    }
    enum DoorEvent {
        Close,
        Open,
        Lock(u8),
        Unlock(u8),
    }
    struct DoorMachine;
    impl Machine for DoorMachine {
        const NAME: &'static str = "door";
        const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] =
            &[("open", "close", "closed"), ("closed", "open", "open"), ("closed", "lock", "locked"), ("locked", "unlock", "closed")];
        type State = Door;
        type Event = DoorEvent;
        fn state_kind(s: &Door) -> &'static str {
            match s {
                Door::Open => "open",
                Door::Closed => "closed",
                Door::Locked { .. } => "locked",
            }
        }
        fn event_kind(e: &DoorEvent) -> &'static str {
            match e {
                DoorEvent::Close => "close",
                DoorEvent::Open => "open",
                DoorEvent::Lock(_) => "lock",
                DoorEvent::Unlock(_) => "unlock",
            }
        }
        fn step(s: &Door, e: &DoorEvent) -> Option<Door> {
            match (s, e) {
                (Door::Open, DoorEvent::Close) => Some(Door::Closed),
                (Door::Closed, DoorEvent::Open) => Some(Door::Open),
                (Door::Closed, DoorEvent::Lock(key)) => Some(Door::Locked { key: *key }),
                // The wrong key is a refusal, not a different move: still `None`.
                (Door::Locked { key }, DoorEvent::Unlock(k)) if k == key => Some(Door::Closed),
                _ => None,
            }
        }
    }

    #[test]
    fn apply_makes_a_listed_move() {
        let mut door = Door::Closed;
        apply::<DoorMachine>(&mut door, &DoorEvent::Lock(7)).unwrap();
        assert_eq!(door, Door::Locked { key: 7 });
    }

    #[test]
    fn step_refuses_a_move_without_changing_anything() {
        assert_eq!(DoorMachine::step(&Door::Open, &DoorEvent::Lock(1)), None);
    }

    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "illegal_transition: door: lock is not allowed in open"))]
    fn apply_refuses_an_illegal_move_and_keeps_the_state() {
        let mut door = Door::Open;
        let err = apply::<DoorMachine>(&mut door, &DoorEvent::Lock(1)).unwrap_err();
        assert_eq!((err.from, err.event, door), ("open", "lock", Door::Open));
    }

    #[test]
    fn check_table_passes_when_step_and_the_table_agree() {
        check_table::<DoorMachine>(&[Door::Open, Door::Closed, Door::Locked { key: 3 }], &[DoorEvent::Close, DoorEvent::Open, DoorEvent::Lock(3), DoorEvent::Unlock(3)]);
    }

    #[test]
    #[should_panic(expected = "rows no sample reached")]
    fn check_table_names_a_row_no_sample_reached() {
        check_table::<DoorMachine>(&[Door::Open, Door::Closed], &[DoorEvent::Close, DoorEvent::Open, DoorEvent::Lock(3)]);
    }
}
