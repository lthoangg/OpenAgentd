//! The questions a session waits on: an `ask_user` card the user answers
//! or dismisses, and the turn that resumes with the answer. What a running
//! turn will pause on when it ends is its [`Suspension`].

use super::*;

impl AgentSession {
    pub(crate) async fn has_open_question(&self) -> bool {
        db::get_pending_question(&self.pool, &self.session_id()).await.ok().flatten().is_some()
    }

    pub async fn dismiss_pending_question(&self, reason: &str, session_id: Option<&str>) {
        let sid = session_id.map(String::from).unwrap_or_else(|| self.session_id());
        if sid.is_empty() {
            return;
        }
        match db::get_pending_question(&self.pool, &sid).await {
            Ok(Some(q)) => {
                let status = normalize_question_status(reason);
                match db::resolve_pending_question(&self.pool, &q.id, status, None).await {
                    Ok(Some(_)) => {
                        // Tell every connected client, or the card stays open
                        // and answerable (the answer would 409).
                        let api_sid = db::codec::api_uuid(&db::codec::db_id(&sid));
                        let qid = db::codec::api_uuid(&q.id);
                        store().push_event(&api_sid, &events::question_dismissed(&qid, &api_sid, status), true);
                        // This session no longer waits on it (a turn running
                        // beside the question reads it closed when it ends).
                        if db::codec::db_id(&sid) == db::codec::db_id(&self.session_id()) {
                            self.turn_suspension.lock().unwrap().clear_question();
                            self.try_transition(Transition::DismissQuestion);
                        }
                    }
                    Ok(None) => {}
                    Err(e) => tracing::warn!("dismiss_pending_question_failed error={}", e),
                }
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("dismiss_pending_question_failed error={}", e),
        }
    }

    pub async fn handle_question_answer(&self, question_id: &str, answers: &Value) -> anyhow::Result<()> {
        if db::resolve_pending_question(&self.pool, question_id, "answered", Some(answers)).await?.is_some() {
            self.resume_after_answer(question_id).await;
        }
        Ok(())
    }

    /// Continue the turn after `question_id` was answered. A turn that is
    /// still running (the question opened beside other tool calls) picks the
    /// answer up itself when those calls finish, so nothing starts here.
    pub async fn resume_after_answer(&self, question_id: &str) {
        let _gate = self.question_gate.lock().await;
        let qid = db::codec::db_id(question_id);
        let continued = {
            let mut slot = self.continued_question.lock().unwrap();
            let hit = slot.as_deref() == Some(qid.as_str());
            if hit {
                *slot = None;
            }
            hit
        };
        if continued || self.owns_turn() {
            tracing::info!("question_answer_left_to_running_turn session_id={} question_id={}", self.session_id(), question_id);
            return;
        }
        self.resume_after_question_answer().await;
    }

    /// Start the turn again with the answer to what the session waits on (a
    /// question, or the lead's reply to a member). The turn that paused may
    /// still be winding down (it tells the lead before it lets go), so the
    /// resume waits for it: claiming on top of it, its cleanup released the
    /// new turn's claim.
    pub async fn resume_after_question_answer(&self) {
        if self.owns_turn() {
            self.wait_turn_finished().await;
        }
        *self.turn_suspension.lock().unwrap() = Suspension::None;
        // Not waiting any more (dismissed meanwhile, or a turn took over):
        // there is nothing to resume.
        if !self.try_transition(Transition::Resume) {
            tracing::info!("question_resume_skipped session_id={} state={}", self.session_id(), self.state());
            return;
        }
        self.emit("agent_status", Some("working"), None);
        self.spawn_turn(TurnOptions { question_resume: true, ..Default::default() });
    }

    pub async fn handle_question_dismiss(&self, question_id: &str, reason: &str) -> anyhow::Result<()> {
        if db::resolve_pending_question(&self.pool, question_id, normalize_question_status(reason), None).await?.is_none() {
            return Ok(());
        }
        self.turn_suspension.lock().unwrap().clear_question();
        // Only a session paused on the question becomes idle: one opened
        // while the turn's other tools still run is left to that turn, which
        // reads the closed question when it ends.
        if self.try_transition(Transition::DismissQuestion) {
            self.emit("agent_status", Some("idle"), None);
        }
        Ok(())
    }
}

/// What a running turn will pause on when it ends (`AgentSession::turn_suspension`).
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) enum Suspension {
    #[default]
    None,
    /// An `ask_user` question: `{question_id, session_id}`.
    Question(Value),
    /// An `ask_lead` request (a member only).
    Lead(Value),
}

impl Suspension {
    /// Record what the run's metadata says it paused on; a question wins
    /// over a lead request, and the first of each is kept.
    pub(super) fn record(&mut self, question: Option<Value>, lead: Option<Value>) {
        match (&*self, question, lead) {
            (Suspension::Question(_), _, _) => {}
            (_, Some(q), _) => *self = Suspension::Question(q),
            (Suspension::None, None, Some(l)) => *self = Suspension::Lead(l),
            _ => {}
        }
    }

    pub(super) fn clear_question(&mut self) {
        if matches!(self, Suspension::Question(_)) {
            *self = Suspension::None;
        }
    }
}
