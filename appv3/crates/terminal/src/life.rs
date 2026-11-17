//! A terminal session's life (`appv3/AGENTS.md` → State machines): the one
//! answer to "is it alive?". Its shell's output ending and the process
//! being gone are what the session observes; [`Life::Exited`] records them,
//! and closing moves through [`Life::Closing`] to [`Life::Closed`] once.

use appv3_core::machine::Machine;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Life {
    Running,
    /// The shell exited or its output ended; not closed yet.
    Exited,
    /// `close` is stopping the shell and releasing the PTY.
    Closing,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifeEvent {
    /// The output ended or the process is gone.
    Exit,
    /// `close` began.
    Close,
    /// `close` released the PTY.
    Released,
}

pub struct LifeMachine;

impl Machine for LifeMachine {
    const NAME: &'static str = "terminal session";
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] = &[
        ("running", "exit", "exited"),
        // Observed again, or after close began: nothing changes.
        ("exited", "exit", "exited"),
        ("closing", "exit", "closing"),
        ("closed", "exit", "closed"),
        ("running", "close", "closing"),
        ("exited", "close", "closing"),
        ("closing", "released", "closed"),
    ];
    type State = Life;
    type Event = LifeEvent;

    fn state_kind(s: &Life) -> &'static str {
        match s {
            Life::Running => "running",
            Life::Exited => "exited",
            Life::Closing => "closing",
            Life::Closed => "closed",
        }
    }

    fn event_kind(e: &LifeEvent) -> &'static str {
        match e {
            LifeEvent::Exit => "exit",
            LifeEvent::Close => "close",
            LifeEvent::Released => "released",
        }
    }

    fn step(s: &Life, e: &LifeEvent) -> Option<Life> {
        Some(match (s, e) {
            (Life::Running, LifeEvent::Exit) => Life::Exited,
            (Life::Exited | Life::Closing | Life::Closed, LifeEvent::Exit) => *s,
            (Life::Running | Life::Exited, LifeEvent::Close) => Life::Closing,
            (Life::Closing, LifeEvent::Released) => Life::Closed,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_core::machine::check_table;

    #[test]
    fn step_allows_exactly_the_table() {
        check_table::<LifeMachine>(&[Life::Running, Life::Exited, Life::Closing, Life::Closed], &[LifeEvent::Exit, LifeEvent::Close, LifeEvent::Released]);
    }

    #[test]
    fn a_session_closes_once() {
        assert_eq!(LifeMachine::step(&Life::Closing, &LifeEvent::Close), None);
        assert_eq!(LifeMachine::step(&Life::Closed, &LifeEvent::Close), None);
    }
}
