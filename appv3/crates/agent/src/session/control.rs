//! The session lifecycle: one state value and one table of moves
//! (`appv3/AGENTS.md` → State machines).
//!
//! The state is two things that move together: the display status the API
//! and `agent_status` report, and whether a turn task owns the session.
//! They stay separate on purpose: Stop shows idle before the task has
//! drained, a suspended question keeps the session busy after its task
//! ends, and a member waiting on its lead does not. What a session waits on
//! (the question, the lead's request) lives inside that status, so it
//! cannot outlive it.
//!
//! [`Control::TRANSITIONS`] is the table, recorded from the moves the test
//! suites make and checked against [`Control::step`] by `check_table`.
//! `Begin` is how a caller outside a turn starts one: the busy check and the
//! claim are one step, so two callers can never both start a turn.

use appv3_core::machine::Machine;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) enum SessionStatus {
    #[default]
    Idle,
    Working,
    /// Suspended on `ask_user`: the question (`question_id`, `session_id`).
    WaitingInput {
        question: Value,
    },
    /// A member suspended on `ask_lead`: the request it sent its lead.
    WaitingLead {
        lead: Value,
    },
    Error,
    Offline,
}

impl SessionStatus {
    /// Every status, in `data/session_states.json` order.
    #[cfg(test)]
    pub(super) const ALL: [Self; 6] =
        [Self::Idle, Self::Working, Self::WaitingInput { question: Value::Null }, Self::WaitingLead { lead: Value::Null }, Self::Error, Self::Offline];

    pub(super) fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::WaitingInput { .. } => "waiting_input",
            Self::WaitingLead { .. } => "waiting_lead",
            Self::Error => "error",
            Self::Offline => "offline",
        }
    }
}

/// What moves the session. Only [`Control::step`] turns one into a state.
#[derive(Clone, Debug)]
pub(super) enum Transition {
    /// A caller outside any turn starts one (a message, compact, continue,
    /// idle compaction). Refused while the session is busy.
    Begin,
    /// The answer to what the session waits on (its question, or the lead's
    /// reply to a member) starts its turn again. Also from a free idle
    /// session: a stored question answered after a restart.
    Resume,
    /// Queued messages start a turn: from a free session, or handed off by
    /// the turn that is ending (it already owns the session).
    Claim,
    /// The turn task itself has started.
    TurnStarted,
    RequestStop,
    WaitForQuestion(Value),
    WaitForLead(Value),
    FailTurn,
    /// The turn ended with nothing to wait on.
    Finish,
    /// The question the session waits on was dismissed or superseded.
    DismissQuestion,
    /// A `Begin` whose setup failed before the turn task started.
    Abandon,
    /// The turn task has drained.
    ReleaseTurn,
    GoOffline,
}

impl Transition {
    pub(super) fn touches_turn_activity(&self) -> bool {
        matches!(self, Self::Begin | Self::Resume | Self::Claim | Self::Abandon | Self::ReleaseTurn)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ControlState {
    status: SessionStatus,
    owned: bool,
}

impl ControlState {
    /// A state reached without its moves (tests only: `AgentSession::set_state`).
    #[cfg(test)]
    pub(super) fn forced(status: SessionStatus, owned: bool) -> Self {
        Self { status, owned }
    }

    pub(super) fn status(&self) -> &SessionStatus {
        &self.status
    }

    pub(super) fn owns_turn(&self) -> bool {
        self.owned
    }

    pub(super) fn is_busy(&self) -> bool {
        self.owned || matches!(self.status, SessionStatus::Working | SessionStatus::WaitingInput { .. })
    }

    pub(super) fn is_stopping(&self, cancelled: bool) -> bool {
        cancelled && self.owned
    }
}

/// The session lifecycle machine.
pub(super) struct Control;

impl Machine for Control {
    const NAME: &'static str = "session";
    #[rustfmt::skip]
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] = &[
        ("idle+released", "begin", "working+owned"),
        ("error+released", "begin", "working+owned"),
        ("waiting_lead+released", "begin", "working+owned"),
        ("waiting_input+released", "resume", "working+owned"),
        ("waiting_lead+released", "resume", "working+owned"),
        // A stored question answered after a restart: the fresh session is idle.
        ("idle+released", "resume", "working+owned"),
        ("error+released", "resume", "working+owned"),
        ("idle+released", "claim", "idle+owned"),
        ("error+released", "claim", "error+owned"),
        ("waiting_lead+released", "claim", "waiting_lead+owned"),
        ("idle+owned", "claim", "idle+owned"),
        ("working+owned", "claim", "working+owned"),
        ("idle+owned", "turn_started", "working+owned"),
        ("working+owned", "turn_started", "working+owned"),
        ("error+owned", "turn_started", "working+owned"),
        ("waiting_lead+owned", "turn_started", "working+owned"),
        ("working+owned", "request_stop", "idle+owned"),
        ("idle+owned", "request_stop", "idle+owned"),
        ("error+owned", "request_stop", "idle+owned"),
        ("waiting_input+owned", "request_stop", "idle+owned"),
        ("waiting_input+released", "request_stop", "idle+released"),
        ("waiting_lead+owned", "request_stop", "idle+owned"),
        ("waiting_lead+released", "request_stop", "idle+released"),
        ("working+owned", "wait_for_question", "waiting_input+owned"),
        ("working+owned", "wait_for_lead", "waiting_lead+owned"),
        ("working+owned", "fail_turn", "error+owned"),
        ("idle+owned", "fail_turn", "error+owned"),
        ("working+owned", "finish", "idle+owned"),
        ("idle+owned", "finish", "idle+owned"),
        ("waiting_input+owned", "dismiss_question", "idle+owned"),
        ("waiting_input+released", "dismiss_question", "idle+released"),
        ("working+owned", "abandon", "idle+released"),
        ("idle+owned", "release_turn", "idle+released"),
        ("error+owned", "release_turn", "error+released"),
        ("waiting_input+owned", "release_turn", "waiting_input+released"),
        ("waiting_lead+owned", "release_turn", "waiting_lead+released"),
        // Cleanup runs again on a session already released: nothing to do.
        ("idle+released", "release_turn", "idle+released"),
        ("error+released", "release_turn", "error+released"),
        ("waiting_input+released", "release_turn", "waiting_input+released"),
        ("waiting_lead+released", "release_turn", "waiting_lead+released"),
        ("idle+released", "go_offline", "offline+released"),
        ("idle+owned", "go_offline", "offline+released"),
        ("working+released", "go_offline", "offline+released"),
        ("working+owned", "go_offline", "offline+released"),
        ("waiting_input+released", "go_offline", "offline+released"),
        ("waiting_input+owned", "go_offline", "offline+released"),
        ("waiting_lead+released", "go_offline", "offline+released"),
        ("waiting_lead+owned", "go_offline", "offline+released"),
        ("error+released", "go_offline", "offline+released"),
        ("error+owned", "go_offline", "offline+released"),
        ("offline+released", "go_offline", "offline+released"),
        ("offline+owned", "go_offline", "offline+released"),
    ];
    type State = ControlState;
    type Event = Transition;

    fn state_kind(s: &ControlState) -> &'static str {
        use SessionStatus as S;
        match (&s.status, s.owned) {
            (S::Idle, false) => "idle+released",
            (S::Idle, true) => "idle+owned",
            (S::Working, false) => "working+released",
            (S::Working, true) => "working+owned",
            (S::WaitingInput { .. }, false) => "waiting_input+released",
            (S::WaitingInput { .. }, true) => "waiting_input+owned",
            (S::WaitingLead { .. }, false) => "waiting_lead+released",
            (S::WaitingLead { .. }, true) => "waiting_lead+owned",
            (S::Error, false) => "error+released",
            (S::Error, true) => "error+owned",
            (S::Offline, false) => "offline+released",
            (S::Offline, true) => "offline+owned",
        }
    }

    fn event_kind(e: &Transition) -> &'static str {
        match e {
            Transition::Begin => "begin",
            Transition::Resume => "resume",
            Transition::Claim => "claim",
            Transition::TurnStarted => "turn_started",
            Transition::RequestStop => "request_stop",
            Transition::WaitForQuestion(_) => "wait_for_question",
            Transition::WaitForLead(_) => "wait_for_lead",
            Transition::FailTurn => "fail_turn",
            Transition::Finish => "finish",
            Transition::DismissQuestion => "dismiss_question",
            Transition::Abandon => "abandon",
            Transition::ReleaseTurn => "release_turn",
            Transition::GoOffline => "go_offline",
        }
    }

    fn step(s: &ControlState, e: &Transition) -> Option<ControlState> {
        use SessionStatus as S;
        let to = |status: SessionStatus, owned: bool| Some(ControlState { status, owned });
        match (e, &s.status, s.owned) {
            (Transition::Begin, S::Idle | S::Error | S::WaitingLead { .. }, false) => to(S::Working, true),
            (Transition::Resume, S::WaitingInput { .. } | S::WaitingLead { .. } | S::Idle | S::Error, false) => to(S::Working, true),
            (Transition::Claim, S::Idle | S::Error | S::WaitingLead { .. }, false) | (Transition::Claim, S::Idle | S::Working, true) => to(s.status.clone(), true),
            (Transition::TurnStarted, S::Idle | S::Working | S::Error | S::WaitingLead { .. }, true) => to(S::Working, true),
            (Transition::RequestStop, S::Working | S::Idle | S::Error | S::WaitingInput { .. } | S::WaitingLead { .. }, true)
            | (Transition::RequestStop, S::WaitingInput { .. } | S::WaitingLead { .. }, false) => to(S::Idle, s.owned),
            (Transition::WaitForQuestion(q), S::Working, true) => to(S::WaitingInput { question: q.clone() }, true),
            (Transition::WaitForLead(l), S::Working, true) => to(S::WaitingLead { lead: l.clone() }, true),
            (Transition::FailTurn, S::Working | S::Idle, true) => to(S::Error, true),
            (Transition::Finish, S::Working | S::Idle, true) => to(S::Idle, true),
            (Transition::DismissQuestion, S::WaitingInput { .. }, owned) => to(S::Idle, owned),
            (Transition::Abandon, S::Working, true) => to(S::Idle, false),
            (Transition::ReleaseTurn, S::Idle | S::Error | S::WaitingInput { .. } | S::WaitingLead { .. }, _) => to(s.status.clone(), false),
            (Transition::GoOffline, _, _) => to(S::Offline, false),
            _ => None,
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

    use appv3_core::machine::{apply, check_table};
    use serde_json::json;

    fn state(status: SessionStatus, owned: bool) -> ControlState {
        ControlState { status, owned }
    }

    fn every_state() -> Vec<ControlState> {
        SessionStatus::ALL.into_iter().flat_map(|s| [state(s.clone(), false), state(s, true)]).collect()
    }

    fn every_event() -> Vec<Transition> {
        use Transition as T;
        vec![
            T::Begin,
            T::Resume,
            T::Claim,
            T::TurnStarted,
            T::RequestStop,
            T::WaitForQuestion(json!({"question_id": "q"})),
            T::WaitForLead(json!({"tool_call_id": "c"})),
            T::FailTurn,
            T::Finish,
            T::DismissQuestion,
            T::Abandon,
            T::ReleaseTurn,
            T::GoOffline,
        ]
    }

    /// The web reads the same list (`web/src/__tests__/api/session-states-contract.test.ts`).
    #[test]
    fn the_statuses_are_the_ones_the_contract_lists() {
        let contract: serde_json::Value = serde_json::from_str(include_str!("../../data/session_states.json")).unwrap();
        let listed: Vec<&str> = contract["agent_status"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(SessionStatus::ALL.iter().map(SessionStatus::as_str).collect::<Vec<_>>(), listed);
        // `ALL` is every variant: a new one must be added there (and to the contract).
        for status in SessionStatus::ALL {
            match status {
                SessionStatus::Idle
                | SessionStatus::Working
                | SessionStatus::WaitingInput { .. }
                | SessionStatus::WaitingLead { .. }
                | SessionStatus::Error
                | SessionStatus::Offline => {}
            }
        }
    }

    #[test]
    fn step_makes_exactly_the_moves_in_the_table() {
        check_table::<Control>(&every_state(), &every_event());
    }

    /// The double-turn bug: a caller outside the turn may only start one on
    /// a free session, whatever the session is doing.
    #[test]
    fn begin_is_refused_while_the_session_is_busy() {
        for s in every_state().into_iter().filter(ControlState::is_busy) {
            assert_eq!(Control::step(&s, &Transition::Begin), None, "Begin from {}", Control::state_kind(&s));
        }
        assert_eq!(Control::step(&state(SessionStatus::Idle, false), &Transition::Begin), Some(state(SessionStatus::Working, true)));
    }

    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "illegal_transition: session: begin is not allowed in offline+released"))]
    fn an_offline_session_starts_no_turn() {
        let mut s = state(SessionStatus::Offline, false);
        assert!(apply::<Control>(&mut s, &Transition::Begin).is_err());
        assert_eq!(s, state(SessionStatus::Offline, false));
    }

    /// Dismissing a question opened while the turn's other tools still run
    /// must not flip the running session to idle.
    #[test]
    fn dismissing_a_question_moves_only_a_session_waiting_on_it() {
        assert_eq!(Control::step(&state(SessionStatus::Working, true), &Transition::DismissQuestion), None);
        let waiting = state(SessionStatus::WaitingInput { question: json!({"question_id": "q"}) }, false);
        assert_eq!(Control::step(&waiting, &Transition::DismissQuestion), Some(state(SessionStatus::Idle, false)));
    }

    #[test]
    fn what_the_session_waits_on_lives_in_its_status() {
        let mut s = state(SessionStatus::Working, true);
        apply::<Control>(&mut s, &Transition::WaitForLead(json!({"tool_call_id": "c1"}))).unwrap();
        assert_eq!(s.status(), &SessionStatus::WaitingLead { lead: json!({"tool_call_id": "c1"}) });
        apply::<Control>(&mut s, &Transition::ReleaseTurn).unwrap();
        apply::<Control>(&mut s, &Transition::Begin).unwrap();
        assert_eq!(s.status(), &SessionStatus::Working, "a new turn leaves nothing to wait on");
    }

    #[test]
    fn status_and_ownership_have_distinct_busy_projections() {
        for s in every_state() {
            let status_busy = matches!(s.status, SessionStatus::Working | SessionStatus::WaitingInput { .. });
            assert_eq!(s.is_busy(), status_busy || s.owned);
            assert!(!s.is_stopping(false));
            assert_eq!(s.is_stopping(true), s.owned);
        }
    }

    #[test]
    fn stop_retains_ownership_until_cleanup_and_then_allows_a_new_begin() {
        let mut s = state(SessionStatus::Idle, false);
        for event in [Transition::Begin, Transition::TurnStarted, Transition::RequestStop] {
            apply::<Control>(&mut s, &event).unwrap();
        }
        assert_eq!((s.status(), s.is_busy(), s.is_stopping(true)), (&SessionStatus::Idle, true, true));
        apply::<Control>(&mut s, &Transition::ReleaseTurn).unwrap();
        assert!(!s.is_busy() && !s.is_stopping(true));
        apply::<Control>(&mut s, &Transition::Begin).unwrap();
        assert!(s.is_busy());
    }

    #[test]
    fn only_execution_boundaries_touch_the_activity_generation() {
        for event in every_event() {
            let boundary = matches!(event, Transition::Begin | Transition::Resume | Transition::Claim | Transition::Abandon | Transition::ReleaseTurn);
            assert_eq!(event.touches_turn_activity(), boundary, "{event:?}");
        }
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
