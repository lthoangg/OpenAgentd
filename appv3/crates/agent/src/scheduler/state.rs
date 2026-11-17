//! A scheduled task's lifecycle (`appv3/AGENTS.md` → State machines).
//!
//! The row stores it as two columns, `enabled` and `status`; [`TaskState`]
//! is the one value they encode, and [`transition`] is the only writer of
//! either (the scheduler tests scan `mod.rs` for any other). `enabled` is
//! derived: a task is on its schedule while it is pending, running, or
//! failed with runs left.

use appv3_core::machine::{self, Machine};
use appv3_db::ScheduledTask;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    /// On its schedule, waiting for the next slot.
    Pending,
    /// A fire is in progress.
    Running,
    /// Off its schedule until resumed (paused, or saved switched off).
    Paused,
    /// Done: its runs are used up, or a one-time task ran.
    Completed,
    /// The last run failed. `retrying`: runs remain and the next slot fires;
    /// otherwise the task stopped on its last allowed run.
    Failed { retrying: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskEvent {
    /// A fire starts.
    Fire,
    /// A counted run ended. `at_limit`: it was the last run `max_runs`
    /// allows; `one_shot`: an `at` task.
    Ran {
        failed: bool,
        at_limit: bool,
        one_shot: bool,
    },
    /// The fire did not run in this slot (the session was busy): wait for the next.
    Skip,
    Pause,
    /// Resume: back on the schedule, unless its runs are used up.
    Resume {
        used_up: bool,
    },
    /// Run now on a task that is off its schedule: it goes back on and fires.
    RunNow,
    /// Saved with changes. `enabled` as saved; `used_up` after the change.
    Edit {
        enabled: bool,
        used_up: bool,
    },
}

pub struct TaskMachine;

impl Machine for TaskMachine {
    const NAME: &'static str = "scheduled task";
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] = &[
        ("pending", "fire", "running"),
        // A Run now over a row a crash left running.
        ("running", "fire", "running"),
        ("failed", "fire", "running"),
        ("running", "ran", "pending|completed|failed"),
        // Edited while a dispatched run was out: the run still counts.
        ("pending", "ran", "pending|completed|failed"),
        ("failed", "ran", "pending|completed|failed"),
        // Paused while it ran, or stopped on its last run: counted, stays.
        ("paused", "ran", "paused"),
        ("completed", "ran", "completed"),
        ("running", "skip", "pending"),
        ("pending", "skip", "pending"),
        ("failed", "skip", "pending|failed"),
        ("paused", "skip", "paused"),
        ("completed", "skip", "completed"),
        ("pending", "pause", "paused"),
        ("running", "pause", "paused"),
        ("paused", "pause", "paused"),
        ("completed", "pause", "paused"),
        ("failed", "pause", "paused"),
        ("pending", "resume", "pending|completed"),
        ("running", "resume", "pending|completed"),
        ("paused", "resume", "pending|completed"),
        ("completed", "resume", "pending|completed"),
        ("failed", "resume", "pending|completed"),
        ("pending", "run_now", "pending"),
        ("paused", "run_now", "pending"),
        ("failed", "run_now", "pending"),
        ("pending", "edit", "pending|paused|completed"),
        ("running", "edit", "pending|paused|completed"),
        ("paused", "edit", "pending|paused|completed"),
        ("completed", "edit", "completed"),
        ("failed", "edit", "failed"),
    ];
    type State = TaskState;
    type Event = TaskEvent;

    fn state_kind(s: &TaskState) -> &'static str {
        s.as_str()
    }

    fn event_kind(e: &TaskEvent) -> &'static str {
        match e {
            TaskEvent::Fire => "fire",
            TaskEvent::Ran { .. } => "ran",
            TaskEvent::Skip => "skip",
            TaskEvent::Pause => "pause",
            TaskEvent::Resume { .. } => "resume",
            TaskEvent::RunNow => "run_now",
            TaskEvent::Edit { .. } => "edit",
        }
    }

    fn step(s: &TaskState, e: &TaskEvent) -> Option<TaskState> {
        use TaskEvent as E;
        use TaskState as S;
        let on_schedule = |used_up: bool| if used_up { S::Completed } else { S::Pending };
        Some(match (*s, *e) {
            (S::Pending | S::Running | S::Failed { .. }, E::Fire) => S::Running,
            (S::Running | S::Pending | S::Failed { retrying: true }, E::Ran { failed, at_limit, one_shot }) => {
                if failed {
                    S::Failed { retrying: !at_limit }
                } else if at_limit || one_shot {
                    S::Completed
                } else {
                    S::Pending
                }
            }
            (S::Paused | S::Completed | S::Failed { retrying: false }, E::Ran { .. }) => *s,
            (S::Running | S::Pending | S::Failed { retrying: true }, E::Skip) => S::Pending,
            (S::Paused | S::Completed | S::Failed { retrying: false }, E::Skip) => *s,
            (_, E::Pause) => S::Paused,
            (_, E::Resume { used_up }) => on_schedule(used_up),
            (S::Pending | S::Paused | S::Failed { .. }, E::RunNow) => S::Pending,
            (S::Completed, E::Edit { .. }) => S::Completed,
            (S::Failed { .. }, E::Edit { enabled, .. }) => S::Failed { retrying: enabled },
            (S::Pending | S::Running | S::Paused, E::Edit { enabled, used_up }) => {
                if used_up {
                    S::Completed
                } else if enabled {
                    S::Pending
                } else {
                    S::Paused
                }
            }
            _ => return None,
        })
    }
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskState::Pending => "pending",
            TaskState::Running => "running",
            TaskState::Paused => "paused",
            TaskState::Completed => "completed",
            TaskState::Failed { .. } => "failed",
        }
    }

    /// On its schedule: its timer runs and a slot fires.
    pub fn enabled(&self) -> bool {
        matches!(self, TaskState::Pending | TaskState::Running | TaskState::Failed { retrying: true })
    }

    /// The state the row's two columns encode. An unknown status reads as
    /// pending (the database refuses one; see the status CHECK migration).
    pub fn of(t: &ScheduledTask) -> TaskState {
        match t.status.as_str() {
            "completed" => TaskState::Completed,
            "failed" => TaskState::Failed { retrying: t.enabled },
            "paused" => TaskState::Paused,
            "running" if t.enabled => TaskState::Running,
            _ if t.enabled => TaskState::Pending,
            _ => TaskState::Paused,
        }
    }
}

/// Its runs are done: completed, or `max_runs` reached on a task that did
/// not fail (a failed one keeps its error for Run now to retry).
pub fn exhausted(t: &ScheduledTask) -> bool {
    match TaskState::of(t) {
        TaskState::Completed => true,
        TaskState::Failed { .. } => false,
        _ => used_up(t),
    }
}

/// `max_runs` is reached.
pub fn used_up(t: &ScheduledTask) -> bool {
    matches!(t.max_runs, Some(m) if t.run_count >= m)
}

/// Move the task by `event` and write the columns that encode it.
pub fn transition(t: &mut ScheduledTask, event: TaskEvent) -> Result<TaskState, machine::IllegalTransition> {
    let mut state = TaskState::of(t);
    machine::apply::<TaskMachine>(&mut state, &event)?;
    t.enabled = state.enabled();
    t.status = state.as_str().to_string();
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATES: [TaskState; 6] =
        [TaskState::Pending, TaskState::Running, TaskState::Paused, TaskState::Completed, TaskState::Failed { retrying: true }, TaskState::Failed { retrying: false }];

    fn events() -> Vec<TaskEvent> {
        let mut events = vec![TaskEvent::Fire, TaskEvent::Skip, TaskEvent::Pause, TaskEvent::RunNow];
        for failed in [false, true] {
            for at_limit in [false, true] {
                for one_shot in [false, true] {
                    events.push(TaskEvent::Ran { failed, at_limit, one_shot });
                }
            }
        }
        for used_up in [false, true] {
            events.push(TaskEvent::Resume { used_up });
            for enabled in [false, true] {
                events.push(TaskEvent::Edit { enabled, used_up });
            }
        }
        events
    }

    /// `check_table` compares one target kind; a row's `a|b` lists the
    /// targets the event's data picks between.
    #[test]
    fn step_lands_only_where_the_table_says() {
        let mut wrong = Vec::new();
        let mut reached = std::collections::HashSet::new();
        for s in STATES {
            for e in events() {
                let (from, ev) = (TaskMachine::state_kind(&s), TaskMachine::event_kind(&e));
                let row = TaskMachine::TRANSITIONS.iter().find(|(f, k, _)| *f == from && *k == ev);
                match (row, TaskMachine::step(&s, &e)) {
                    (Some((_, _, to)), Some(next)) if to.split('|').any(|t| t == next.as_str()) => {
                        reached.insert((from, ev));
                    }
                    (None, None) => {}
                    (row, next) => wrong.push(format!("{from} --{e:?}--> table {:?}, step {next:?}", row.map(|r| r.2))),
                }
            }
        }
        let unreached: Vec<_> = TaskMachine::TRANSITIONS.iter().filter(|(f, e, _)| !reached.contains(&(*f, *e))).collect();
        assert!(wrong.is_empty() && unreached.is_empty(), "{wrong:#?}\nunreached: {unreached:?}");
    }

    #[test]
    fn a_failure_on_the_last_allowed_run_stops_the_task() {
        let next = TaskMachine::step(&TaskState::Running, &TaskEvent::Ran { failed: true, at_limit: true, one_shot: false });
        assert_eq!(next, Some(TaskState::Failed { retrying: false }));
        assert!(!next.unwrap().enabled());
    }

    #[test]
    fn a_completed_task_cannot_be_run_now_without_resuming() {
        assert_eq!(TaskMachine::step(&TaskState::Completed, &TaskEvent::RunNow), None);
        assert_eq!(TaskMachine::step(&TaskState::Running, &TaskEvent::RunNow), None);
    }

    #[test]
    fn the_columns_round_trip_every_state() {
        for s in STATES {
            let t = ScheduledTask { enabled: s.enabled(), status: s.as_str().into(), ..Default::default() };
            assert_eq!(TaskState::of(&t), s);
        }
    }
}
