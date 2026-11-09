//! Session execution ownership and its compatibility display status.
//!
//! Stop shows idle before the task has drained. A suspended question keeps
//! the session busy even after its task ends; a member waiting on its lead
//! does not. These projections must not be replaced by one running flag.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum SessionStatus {
    #[default]
    Idle,
    Working,
    WaitingInput,
    WaitingLead,
    Error,
    Offline,
}

impl SessionStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::WaitingInput => "waiting_input",
            Self::WaitingLead => "waiting_lead",
            Self::Error => "error",
            Self::Offline => "offline",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Execution {
    #[default]
    Released,
    Owned,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Transition {
    ClaimTurn,
    StartTurn,
    RequestStop,
    WaitForQuestion,
    WaitForLead,
    FailTurn,
    BecomeIdle,
    ReleaseTurn,
    GoOffline,
}

impl Transition {
    pub(super) fn touches_turn_activity(self) -> bool {
        matches!(self, Self::ClaimTurn | Self::ReleaseTurn)
    }
}

#[derive(Debug, Default)]
pub(super) struct ControlState {
    status: SessionStatus,
    execution: Execution,
}

impl ControlState {
    pub(super) fn status(&self) -> SessionStatus {
        self.status
    }

    pub(super) fn owns_turn(&self) -> bool {
        self.execution == Execution::Owned
    }

    pub(super) fn is_busy(&self) -> bool {
        self.owns_turn() || matches!(self.status, SessionStatus::Working | SessionStatus::WaitingInput)
    }

    pub(super) fn is_stopping(&self, cancelled: bool) -> bool {
        cancelled && self.owns_turn()
    }

    pub(super) fn apply(&mut self, event: Transition) {
        match event {
            Transition::ClaimTurn => self.execution = Execution::Owned,
            Transition::ReleaseTurn => self.execution = Execution::Released,
            Transition::StartTurn => self.status = SessionStatus::Working,
            Transition::RequestStop | Transition::BecomeIdle => self.status = SessionStatus::Idle,
            Transition::WaitForQuestion => self.status = SessionStatus::WaitingInput,
            Transition::WaitForLead => self.status = SessionStatus::WaitingLead,
            Transition::FailTurn => self.status = SessionStatus::Error,
            Transition::GoOffline => self.status = SessionStatus::Offline,
        }
    }
}

/// Failure/suspension routing. Cancellation is re-read at each activation
/// decision, because asynchronous finalization can receive Stop meanwhile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TurnExit<T> {
    Failed,
    Question(T),
    Lead(T),
    Ready,
}

impl<T> TurnExit<T> {
    pub(super) fn decide(failed: bool, question: Option<T>, lead: Option<T>) -> Self {
        match (failed, question, lead) {
            (true, _, _) => Self::Failed,
            (false, Some(question), _) => Self::Question(question),
            (false, None, Some(lead)) => Self::Lead(lead),
            (false, None, None) => Self::Ready,
        }
    }

    pub(super) fn is_suspended(&self) -> bool {
        matches!(self, Self::Question(_) | Self::Lead(_))
    }

    pub(super) fn may_activate_queue(&self, cancelled: bool, has_session: bool) -> bool {
        matches!(self, Self::Ready) && !cancelled && has_session
    }
}

/// Work type is independent of attendance, resume cause, and config refresh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TurnWork {
    Conversation,
    ManualCompaction,
    IdleCompaction,
}

impl TurnWork {
    pub(super) fn from_compaction(force: bool, idle: bool) -> Self {
        match (force, idle) {
            (_, true) => Self::IdleCompaction,
            (true, false) => Self::ManualCompaction,
            (false, false) => Self::Conversation,
        }
    }

    pub(super) fn is_conversation(self) -> bool {
        self == Self::Conversation
    }

    pub(super) fn should_notify(self) -> bool {
        self != Self::IdleCompaction
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_ownership_have_distinct_busy_projections() {
        for (status, wire, status_busy) in [
            (SessionStatus::Idle, "idle", false),
            (SessionStatus::Working, "working", true),
            (SessionStatus::WaitingInput, "waiting_input", true),
            (SessionStatus::WaitingLead, "waiting_lead", false),
            (SessionStatus::Error, "error", false),
            (SessionStatus::Offline, "offline", false),
        ] {
            assert_eq!(status.as_str(), wire);
            for execution in [Execution::Released, Execution::Owned] {
                let state = ControlState { status, execution };
                assert_eq!(state.is_busy(), status_busy || execution == Execution::Owned);
                assert!(!state.is_stopping(false));
                assert_eq!(state.is_stopping(true), execution == Execution::Owned);
            }
        }
    }

    #[test]
    fn only_release_turn_releases_execution_ownership() {
        let mut state = ControlState::default();
        state.apply(Transition::ClaimTurn);
        for (event, status) in [
            (Transition::StartTurn, SessionStatus::Working),
            (Transition::RequestStop, SessionStatus::Idle),
            (Transition::WaitForQuestion, SessionStatus::WaitingInput),
            (Transition::WaitForLead, SessionStatus::WaitingLead),
            (Transition::FailTurn, SessionStatus::Error),
            (Transition::BecomeIdle, SessionStatus::Idle),
            (Transition::GoOffline, SessionStatus::Offline),
        ] {
            state.apply(event);
            assert_eq!(state.status(), status);
            assert!(state.owns_turn(), "{event:?} released a task that has not drained");
        }
        state.apply(Transition::ReleaseTurn);
        assert!(!state.owns_turn());
        assert_eq!(state.status(), SessionStatus::Offline);
        state.apply(Transition::ReleaseTurn);
        assert!(!state.owns_turn(), "repeated cleanup is idempotent");
    }

    #[test]
    fn stop_retains_ownership_until_cleanup_and_then_allows_a_new_claim() {
        let mut state = ControlState::default();
        state.apply(Transition::ClaimTurn);
        state.apply(Transition::StartTurn);
        state.apply(Transition::RequestStop);
        assert_eq!(state.status(), SessionStatus::Idle);
        assert!(state.is_busy());
        assert!(state.is_stopping(true));
        state.apply(Transition::ReleaseTurn);
        assert!(!state.is_busy());
        assert!(!state.is_stopping(true));
        state.apply(Transition::ClaimTurn);
        assert!(state.is_busy(), "a queued handoff claims work before the task starts");
    }

    #[test]
    fn only_execution_boundaries_touch_the_activity_generation() {
        for event in [
            Transition::StartTurn,
            Transition::RequestStop,
            Transition::WaitForQuestion,
            Transition::WaitForLead,
            Transition::FailTurn,
            Transition::BecomeIdle,
            Transition::GoOffline,
        ] {
            assert!(!event.touches_turn_activity(), "{event:?} would invalidate an idle timer");
        }
        assert!(Transition::ClaimTurn.touches_turn_activity());
        assert!(Transition::ReleaseTurn.touches_turn_activity());
    }

    #[test]
    fn finalization_prioritizes_failure_then_question_then_lead() {
        for failed in [false, true] {
            for question in [false, true] {
                for lead in [false, true] {
                    let exit = TurnExit::decide(failed, question.then_some(()), lead.then_some(()));
                    let expected = if failed {
                        TurnExit::Failed
                    } else if question {
                        TurnExit::Question(())
                    } else if lead {
                        TurnExit::Lead(())
                    } else {
                        TurnExit::Ready
                    };
                    assert_eq!(exit, expected);
                    assert_eq!(exit.is_suspended(), !failed && (question || lead));
                    for cancelled in [false, true] {
                        for has_session in [false, true] {
                            assert_eq!(exit.may_activate_queue(cancelled, has_session), !failed && !question && !lead && !cancelled && has_session);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn compaction_work_controls_accounting_and_notifications_independently() {
        for (force, idle, expected, conversation, notify) in [
            (false, false, TurnWork::Conversation, true, true),
            (true, false, TurnWork::ManualCompaction, false, true),
            (true, true, TurnWork::IdleCompaction, false, false),
            (false, true, TurnWork::IdleCompaction, false, false),
        ] {
            let work = TurnWork::from_compaction(force, idle);
            assert_eq!(work, expected);
            assert_eq!(work.is_conversation(), conversation);
            assert_eq!(work.should_notify(), notify);
        }
    }
}
