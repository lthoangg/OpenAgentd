//! A goal's lifecycle (`appv3/AGENTS.md` → State machines).
//!
//! The row keeps it in `status`, `pause_reason` and `ended_at`; [`GoalState`]
//! is the one value they encode and [`transition`] the only writer of them
//! (a test scans goal.rs and check.rs for any other). At most one goal per
//! session is live (active or paused); achieved and cleared are final.

use appv3_core::machine::{self, Machine};
use appv3_db::codec::now_db;
use appv3_db::{SessionGoal, GOAL_ACHIEVED, GOAL_ACTIVE, GOAL_CLEARED, GOAL_PAUSED};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalState {
    Active,
    /// Waiting for the user, for `reason` (`goal::reason`).
    Paused {
        reason: String,
    },
    Achieved {
        at: String,
    },
    Cleared {
        at: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalEvent {
    /// Stop working toward it until the user resumes it; a later reason
    /// replaces an earlier one.
    Pause {
        reason: String,
    },
    /// The completion check confirmed it.
    Achieve,
    /// The user cleared it, or undid the message that set it.
    Clear,
    Resume,
}

pub struct GoalMachine;

impl Machine for GoalMachine {
    const NAME: &'static str = "goal";
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] = &[
        ("active", "pause", "paused"),
        ("paused", "pause", "paused"),
        ("active", "achieve", "achieved"),
        ("active", "clear", "cleared"),
        ("paused", "clear", "cleared"),
        ("paused", "resume", "active"),
    ];
    type State = GoalState;
    type Event = GoalEvent;

    fn state_kind(s: &GoalState) -> &'static str {
        match s {
            GoalState::Active => GOAL_ACTIVE,
            GoalState::Paused { .. } => GOAL_PAUSED,
            GoalState::Achieved { .. } => GOAL_ACHIEVED,
            GoalState::Cleared { .. } => GOAL_CLEARED,
        }
    }

    fn event_kind(e: &GoalEvent) -> &'static str {
        match e {
            GoalEvent::Pause { .. } => "pause",
            GoalEvent::Achieve => "achieve",
            GoalEvent::Clear => "clear",
            GoalEvent::Resume => "resume",
        }
    }

    fn step(s: &GoalState, e: &GoalEvent) -> Option<GoalState> {
        use GoalEvent as E;
        use GoalState as S;
        Some(match (s, e) {
            (S::Active | S::Paused { .. }, E::Pause { reason }) => S::Paused { reason: reason.clone() },
            // Only an active goal is achieved: a pause during the check stands.
            (S::Active, E::Achieve) => S::Achieved { at: now_db() },
            (S::Active | S::Paused { .. }, E::Clear) => S::Cleared { at: now_db() },
            (S::Paused { .. }, E::Resume) => S::Active,
            _ => return None,
        })
    }
}

impl GoalState {
    /// The state the row encodes. An unknown status reads as cleared, which
    /// is not live (the database refuses one; see the status CHECK migration).
    pub fn of(goal: &SessionGoal) -> GoalState {
        match goal.status.as_str() {
            GOAL_ACTIVE => GoalState::Active,
            GOAL_PAUSED => GoalState::Paused { reason: goal.pause_reason.clone().unwrap_or_default() },
            GOAL_ACHIEVED => GoalState::Achieved { at: goal.ended_at.clone().unwrap_or_default() },
            _ => GoalState::Cleared { at: goal.ended_at.clone().unwrap_or_default() },
        }
    }
}

/// Move `goal` by `event` and write the columns that encode it.
pub fn transition(goal: &mut SessionGoal, event: GoalEvent) -> Result<(), machine::IllegalTransition> {
    let mut state = GoalState::of(goal);
    machine::apply::<GoalMachine>(&mut state, &event)?;
    goal.status = GoalMachine::state_kind(&state).to_string();
    (goal.pause_reason, goal.ended_at) = match state {
        GoalState::Active => (None, None),
        GoalState::Paused { reason } => (Some(reason), None),
        GoalState::Achieved { at } | GoalState::Cleared { at } => (None, Some(at)),
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_core::machine::check_table;

    fn states() -> Vec<GoalState> {
        vec![GoalState::Active, GoalState::Paused { reason: "stopped".into() }, GoalState::Achieved { at: "t".into() }, GoalState::Cleared { at: "t".into() }]
    }

    fn events() -> Vec<GoalEvent> {
        vec![GoalEvent::Pause { reason: "blocked".into() }, GoalEvent::Achieve, GoalEvent::Clear, GoalEvent::Resume]
    }

    #[test]
    fn step_allows_exactly_the_table() {
        check_table::<GoalMachine>(&states(), &events());
    }

    #[test]
    fn a_paused_goal_cannot_be_achieved() {
        assert_eq!(GoalMachine::step(&GoalState::Paused { reason: "stopped".into() }, &GoalEvent::Achieve), None);
    }

    #[test]
    fn an_ended_goal_takes_no_more_moves() {
        for s in [GoalState::Achieved { at: "t".into() }, GoalState::Cleared { at: "t".into() }] {
            assert!(events().iter().all(|e| GoalMachine::step(&s, e).is_none()), "{s:?}");
        }
    }

    /// Goal status is written only by `transition` (`appv3/AGENTS.md` → State machines).
    #[test]
    fn only_the_goal_machine_writes_the_status() {
        for (file, src) in [("goal.rs", include_str!("../goal.rs")), ("check.rs", include_str!("check.rs"))] {
            let writes: Vec<&str> =
                src.lines().filter(|l| !l.trim_start().starts_with("//") && (l.contains(".status = ") || l.contains(".pause_reason = ") || l.contains(".ended_at = "))).collect();
            assert!(writes.is_empty(), "{file}: write through goal::state::transition instead: {writes:#?}");
        }
    }
}
