//! A member's lifecycle in the registry (`appv3/AGENTS.md` → State
//! machines): [`MemberStatus`] and the events that move it. A move also
//! resets the side fields that belong to the state it leaves (the question
//! it waited on, its stall note, what it owes the lead), so they cannot
//! drift from the status. [`SubagentInstance::apply`] is the only writer of
//! the status (a test scans the module for any other).

use super::{MemberStatus, SubagentInstance};
use appv3_core::machine::{IllegalTransition, Machine};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum MemberEvent {
    /// Its running turn called `ask_lead` and suspends on the question.
    AskLead { question: Value, tool_call_id: Option<String> },
    /// The lead sent it new work.
    FollowUp,
    /// Its turn closed as `end` (completed, error or stopped).
    TurnEnded { end: MemberStatus, follow_up_queued: bool, error: Option<String> },
    /// The session refused the turn it was given: it never runs.
    Refused { error: String },
    /// The lead or a restart stopped the turn it held.
    Stop,
}

pub struct MemberMachine;

impl Machine for MemberMachine {
    const NAME: &'static str = "subagent member";
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] = &[
        ("working", "ask_lead", "waiting_lead"),
        ("waiting_lead", "ask_lead", "waiting_lead"),
        ("working", "follow_up", "working"),
        ("waiting_lead", "follow_up", "working"),
        ("completed", "follow_up", "working"),
        ("error", "follow_up", "working"),
        ("stopped", "follow_up", "working"),
        // The session reports how its turn closed; the registry follows it.
        ("working", "turn_ended", "completed|error|stopped|working"),
        ("waiting_lead", "turn_ended", "completed|error|stopped|working"),
        ("completed", "turn_ended", "completed|error|stopped|working"),
        ("error", "turn_ended", "completed|error|stopped|working"),
        ("stopped", "turn_ended", "completed|error|stopped|working"),
        ("working", "refused", "error"),
        ("error", "refused", "error"),
        // A turn may run whatever the registry last recorded (the session knows).
        ("working", "stop", "stopped"),
        ("waiting_lead", "stop", "stopped"),
        ("completed", "stop", "stopped"),
        ("error", "stop", "stopped"),
        ("stopped", "stop", "stopped"),
    ];
    type State = MemberStatus;
    type Event = MemberEvent;

    fn state_kind(s: &MemberStatus) -> &'static str {
        s.as_str()
    }

    fn event_kind(e: &MemberEvent) -> &'static str {
        match e {
            MemberEvent::AskLead { .. } => "ask_lead",
            MemberEvent::FollowUp => "follow_up",
            MemberEvent::TurnEnded { .. } => "turn_ended",
            MemberEvent::Refused { .. } => "refused",
            MemberEvent::Stop => "stop",
        }
    }

    fn step(s: &MemberStatus, e: &MemberEvent) -> Option<MemberStatus> {
        use MemberStatus as S;
        Some(match (s, e) {
            // Only a running turn asks: a member that finished cannot wait on its lead.
            (S::Working | S::WaitingLead, MemberEvent::AskLead { .. }) => S::WaitingLead,
            (_, MemberEvent::FollowUp) => S::Working,
            (_, MemberEvent::TurnEnded { end: end @ (S::Completed | S::Error | S::Stopped), follow_up_queued, .. }) => end.after_turn(*follow_up_queued),
            (S::Working | S::Error, MemberEvent::Refused { .. }) => S::Error,
            (_, MemberEvent::Stop) => S::Stopped,
            _ => return None,
        })
    }
}

impl SubagentInstance {
    /// Move the member by `event`, and reset the side fields of the state it
    /// leaves. An event the table does not list changes nothing.
    pub(super) fn apply(&mut self, event: MemberEvent) -> Result<MemberStatus, IllegalTransition> {
        let Some(next) = MemberMachine::step(&self.status, &event) else {
            let err = IllegalTransition { machine: MemberMachine::NAME, from: self.status.as_str(), event: MemberMachine::event_kind(&event) };
            // Refused, not a bug: a late event for a turn the member no longer runs.
            tracing::info!(machine = err.machine, from = err.from, event = err.event, "illegal_transition");
            return Err(err);
        };
        self.status = next;
        match event {
            MemberEvent::AskLead { question, tool_call_id } => {
                self.pending_lead_question = Some(question);
                if tool_call_id.is_some() {
                    self.pending_tool_call_id = tool_call_id;
                }
            }
            MemberEvent::FollowUp => {
                self.stopped_by_restart = false;
                self.question_delivered = false;
                self.result_delivered = false;
                self.last_error = None;
                self.stall = None;
                self.working_since = Some(std::time::Instant::now());
                self.reported_at = None;
            }
            MemberEvent::TurnEnded { end, error, .. } => {
                self.stall = None;
                self.working_since = (next == MemberStatus::Working).then(std::time::Instant::now);
                self.reported_at = None;
                if end == MemberStatus::Error {
                    if let Some(m) = error.filter(|m| !m.is_empty()) {
                        self.last_error = Some(m);
                    }
                }
            }
            MemberEvent::Refused { error } => self.last_error = Some(error),
            MemberEvent::Stop => self.settle_stopped(),
        }
        Ok(next)
    }

    /// What a stop clears, whether or not the member held a turn.
    pub(super) fn settle_stopped(&mut self) {
        self.stall = None;
        self.working_since = None;
        self.pending_lead_question = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATES: [MemberStatus; 5] = [MemberStatus::Working, MemberStatus::WaitingLead, MemberStatus::Completed, MemberStatus::Error, MemberStatus::Stopped];

    fn events() -> Vec<MemberEvent> {
        let mut events =
            vec![MemberEvent::AskLead { question: Value::Null, tool_call_id: None }, MemberEvent::FollowUp, MemberEvent::Refused { error: "no".into() }, MemberEvent::Stop];
        for end in [MemberStatus::Completed, MemberStatus::Error, MemberStatus::Stopped] {
            for follow_up_queued in [false, true] {
                events.push(MemberEvent::TurnEnded { end, follow_up_queued, error: None });
            }
        }
        events
    }

    /// A row's `a|b` lists the targets the event's data picks between.
    #[test]
    fn step_lands_only_where_the_table_says() {
        let mut wrong = Vec::new();
        let mut reached = std::collections::HashSet::new();
        for s in STATES {
            for e in events() {
                let (from, ev) = (MemberMachine::state_kind(&s), MemberMachine::event_kind(&e));
                let row = MemberMachine::TRANSITIONS.iter().find(|(f, k, _)| *f == from && *k == ev);
                match (row, MemberMachine::step(&s, &e)) {
                    (Some((_, _, to)), Some(next)) if to.split('|').any(|t| t == next.as_str()) => {
                        reached.insert((from, ev));
                    }
                    (None, None) => {}
                    (row, next) => wrong.push(format!("{from} --{e:?}--> table {:?}, step {next:?}", row.map(|r| r.2))),
                }
            }
        }
        let unreached: Vec<_> = MemberMachine::TRANSITIONS.iter().filter(|(f, e, _)| !reached.contains(&(*f, *e))).collect();
        assert!(wrong.is_empty() && unreached.is_empty(), "{wrong:#?}\nunreached: {unreached:?}");
    }

    #[test]
    fn a_member_that_finished_cannot_wait_on_its_lead() {
        for s in [MemberStatus::Completed, MemberStatus::Error, MemberStatus::Stopped] {
            assert_eq!(MemberMachine::step(&s, &MemberEvent::AskLead { question: Value::Null, tool_call_id: None }), None, "{s:?}");
        }
    }

    #[test]
    fn a_turn_end_is_never_working_itself() {
        assert_eq!(MemberMachine::step(&MemberStatus::Working, &MemberEvent::TurnEnded { end: MemberStatus::Working, follow_up_queued: false, error: None }), None);
    }

    /// The status is written only by `apply` (`appv3/AGENTS.md` → State machines).
    #[test]
    fn only_apply_writes_the_status() {
        for (file, src) in [("subagents.rs", include_str!("../subagents.rs")), ("report.rs", include_str!("report.rs"))] {
            let writes: Vec<&str> = src.lines().filter(|l| !l.trim_start().starts_with("//") && l.contains(".status = ")).collect();
            assert!(writes.is_empty(), "{file}: move the member with SubagentInstance::apply instead: {writes:#?}");
        }
    }
}
