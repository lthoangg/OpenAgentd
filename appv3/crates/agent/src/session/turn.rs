//! One turn of a session, start to end: build its hooks and run the agent,
//! turn a failure into the session's error, then decide how the turn ends
//! (a question, a lead question, the next queued turn, idle) and tell
//! whoever waits on it (a desktop notification, the member's lead, a
//! workspace that sent the request, every client).

use super::control::{SessionStatus, Transition, TurnExit};
use super::provider::{forget_provider_credentials, forget_retired_model, provider_error_to_agent};
use super::questions::Suspension;
use super::{agent_only_since, session_workspace_dir, AgentSession, RuntimeProvider, TurnOptions, TURN_FLOOR_META};
use crate::agent::RunOptions;
use crate::broadcaster;
use crate::checkpointer::Checkpointer;
use crate::errors::{format_agent_error, AgentError};
use crate::events::{self, Envelope};
use crate::hooks::basic::{CurrentDateHook, MemoryContextHook, QueuedInjectionHook, RuntimeProtocolHook, ToolResultOffloadHook, WorkspaceInstructionsHook};
use crate::hooks::publisher::StreamPublisherHook;
use crate::hooks::summarization::build_summarization_hook;
use crate::hooks::title::{build_summary_retitle, build_title_generation_hook};
use crate::hooks::HookRef;
use crate::interaction_mode;
use crate::notification;
use crate::stream_store::store;
use appv3_core::settings::settings;
use appv3_db as db;
use appv3_tools::DeniedPaths;
use futures::FutureExt;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

impl AgentSession {
    pub(super) async fn run_turn(self: Arc<Self>, opts: TurnOptions) {
        let sid = self.session_id();
        // The session this turn marked in flight. The AgentSession can be
        // bound to another session while the turn runs, so the end clears
        // this one, not whatever `session_id()` reads by then.
        let marked_sid = sid.clone();
        if !sid.is_empty() {
            store().init_turn(&sid, true);
        }
        if !sid.is_empty() && self.parent_session_id.is_none() {
            let starts = self.turn_floor.lock().unwrap().as_ref().is_none_or(|(s, _)| *s != sid);
            if starts {
                match db::last_assistant_seq(&self.pool, &sid).await {
                    Ok(seq) => *self.turn_floor.lock().unwrap() = Some((sid.clone(), seq)),
                    Err(e) => tracing::warn!("turn_floor_failed session_id={} error={}", sid, e),
                }
            }
        }
        // Compactions are not continued after a restart: a forced one would
        // run as an ordinary turn, and an idle one is not worth the cost.
        let work = opts.work();
        let tracks_in_flight = !sid.is_empty() && work.is_conversation();
        if tracks_in_flight {
            if let Err(e) = db::mark_turn_in_flight(&self.pool, &sid, opts.restart_resume).await {
                tracing::warn!("turn_in_flight_mark_failed session_id={} error={}", sid, e);
            }
        }
        self.transition(Transition::TurnStarted);
        *self.turn_suspension.lock().unwrap() = Suspension::None;
        self.emit("agent_status", Some("working"), None);
        if !sid.is_empty() {
            let mut p = json!({"session_id": sid, "started_at": db::codec::py_isoformat(&chrono::Utc::now())});
            if opts.queued_activation_event.is_some() {
                p["source"] = json!("queued_activation");
            }
            if opts.idle_compaction {
                p["idle_compaction"] = json!(true);
            }
            if let Some(ps) = &self.parent_session_id {
                p["parent_session_id"] = json!(ps);
            }
            let ws = self.workspace();
            if !ws.is_empty() {
                p["workspace"] = json!(ws);
            }
            broadcaster::publish("session_turn_started", p);
        }
        if let Some(ev) = &opts.queued_activation_event {
            if !sid.is_empty() {
                store().push_event(&sid, &Envelope::from_parts("queued_turn_start", ev.clone()), false);
            }
        }
        self.detect_config_drift();
        if opts.starts_run && self.config_dirty.load(Ordering::SeqCst) {
            self.refresh_agent_from_disk();
        }

        let runtime_model = opts.runtime_model.clone();
        // A panic below (provider parser, tool, hook) must still reach the
        // error path and the `finally` block, or the session stays "working"
        // with no `done` event until the server restarts.
        let execute = std::panic::AssertUnwindSafe(self.execute_turn(&opts)).catch_unwind();
        let outcome = tokio::select! {
            r = execute => r.unwrap_or_else(|payload| {
                let msg = appv3_core::panic_message(payload.as_ref());
                tracing::error!("agent_turn_panicked name={} session_id={} panic={}", self.name(), sid, msg);
                Err(AgentError::Other(format!("Internal error: {msg}")))
            }),
            // Dropping `execute` drops its tool calls (a shell's process
            // group is killed, an MCP call is cancelled); the `finally` below
            // still ends the turn. Orphaned tool rows heal on the next turn.
            _ = self.force_stop_due() => {
                tracing::warn!("agent_turn_force_stopped name={} session_id={}", self.name(), sid);
                if !sid.is_empty() {
                    if let Err(e) = db::mark_turn_assistant_interrupted(&self.pool, &sid).await {
                        tracing::warn!("mark_interrupted_failed session_id={} error={}", sid, e);
                    }
                }
                Err(AgentError::Cancelled)
            }
        };
        if let Err(e) = outcome {
            if !matches!(e, AgentError::Cancelled) {
                if e.is_logged_as_warning() {
                    tracing::warn!("agent_session_error name={} error={}", self.name(), e);
                } else {
                    tracing::error!("agent_session_error name={} error={}", self.name(), e);
                }
                if let AgentError::Auth { provider: Some(p), .. } = &e {
                    forget_provider_credentials(Some(p));
                }
                if let AgentError::Request { status, message, .. } = &e {
                    if *status == Some(404) || crate::retry::blames_the_model(Some(message.as_str())) {
                        let m = runtime_model.clone().or_else(|| self.agent().model_id.clone());
                        forget_retired_model(m.as_deref());
                    }
                }
                self.transition(Transition::FailTurn);
                let info = format_agent_error(&e, Some(&self.name()));
                *self.last_error.lock().unwrap() = info["message"].as_str().map(String::from);
                *self.last_error_info.lock().unwrap() = Some(info.clone());
                let mut data = Map::new();
                for k in ["message", "title", "code", "category"] {
                    data.insert(k.into(), info[k].clone());
                }
                if let Some(details) = info.get("details") {
                    data.insert("details".into(), details.clone());
                }
                let mut with_meta = data.clone();
                with_meta.insert("metadata".into(), Value::Object(data.clone()));
                self.emit("agent_status", Some("error"), Some(with_meta));
                self.emit("error", None, Some(data));
            }
        }

        // ── finally ──
        let mut activated = false;
        let status = self.status();
        // Held to the end, so an answer arriving now either finds this turn
        // still running (and is read below) or finds it paused (and resumes it).
        let _gate = self.question_gate.lock().await;
        let suspension = self.turn_suspension.lock().unwrap().clone();
        let (mut qs, ls): (Option<Value>, Option<Value>) = match suspension {
            Suspension::Question(q) => (Some(q), None),
            Suspension::Lead(l) => (None, Some(l)),
            Suspension::None => (None, None),
        };
        // The question opened before the reply's other tool calls finished,
        // so it may be closed already: answered (the turn continues with the
        // answer) or superseded or dismissed (the turn ends without pausing).
        let mut answered_question = None;
        if let Some(qid) = qs.as_ref().and_then(|q| q.get("question_id")).and_then(Value::as_str).map(String::from) {
            if let Ok(Some(row)) = db::get_question(&self.pool, &qid).await {
                if row.status != "pending" {
                    tracing::info!("question_closed_before_pause session_id={} question_id={} status={}", sid, qid, row.status);
                    qs = None;
                    self.turn_suspension.lock().unwrap().clear_question();
                    if row.status == "answered" {
                        answered_question = Some(row.id);
                    }
                }
            }
        }
        let exit = TurnExit::decide(status == SessionStatus::Error, qs, ls);
        // A turn that continues with an early answer is accounted like one
        // that paused and resumed.
        let continues = matches!(exit, TurnExit::Ready) && answered_question.is_some() && !self.cancel.is_set();
        let suspended = exit.is_suspended() || continues;
        if !suspended {
            self.apply_pending_interaction_mode().await;
        }
        let sid = self.session_id();
        let errored = matches!(&exit, TurnExit::Failed);
        // A background compaction was not asked for, so it never notifies.
        let notify = work.should_notify();
        let mut completed = false;
        // Account a goal turn and queue the goal's next one before queued
        // messages start, so the continuation runs as the next turn.
        let goal_turn = self.goal_turn.lock().unwrap().take();
        let goal_id = goal_turn.as_ref().map(|t| t.goal_id.clone());
        if self.parent_session_id.is_none() && work.is_conversation() && !sid.is_empty() {
            use crate::goal::TurnEnd;
            let how = if errored {
                TurnEnd::Failed(self.last_error())
            } else if suspended {
                TurnEnd::Suspended
            } else if self.cancel.is_set() {
                TurnEnd::Stopped
            } else {
                TurnEnd::Completed
            };
            self.goal_turn_ended(&sid, goal_turn, how).await;
        }
        match &exit {
            TurnExit::Question(q) => {
                self.transition(Transition::WaitForQuestion(q.clone()));
                let mut e = Map::new();
                e.insert("question_id".into(), json!(crate::pystr::py_str(&q["question_id"])));
                self.emit("agent_status", Some("waiting_input"), Some(e));
            }
            TurnExit::Lead(data) => {
                self.transition(Transition::WaitForLead(data.clone()));
                self.emit("agent_status", Some("waiting_lead"), data.as_object().cloned());
                if let Some(lead) = &self.parent_session_id {
                    crate::subagents::report::on_subagent_question_asked(lead, &sid, data, &self.pool).await;
                }
            }
            TurnExit::Ready => {
                if continues {
                    // The answer's own resume call may still be on its way.
                    *self.continued_question.lock().unwrap() = answered_question.take();
                    self.transition(Transition::Claim);
                    self.spawn_turn(TurnOptions { question_resume: true, ..Default::default() });
                    activated = true;
                } else if exit.may_activate_queue(self.cancel.is_set(), !sid.is_empty()) {
                    activated = self.activate_queued_user_messages(&sid).await;
                }
                if !activated {
                    self.transition(Transition::Finish);
                    self.emit("agent_status", Some("idle"), None);
                    self.close_turn(&sid, "completed", notify, opts.idle_compaction, goal_id.as_deref()).await;
                    completed = true;
                }
            }
            TurnExit::Failed => {
                self.close_turn(&sid, "error", notify, opts.idle_compaction, goal_id.as_deref()).await;
            }
        }
        if !activated {
            // A turn the server's own shutdown stopped stays marked, so the
            // next start continues it; every other end clears the mark
            // (before the turn reads as over, so a new turn's mark survives).
            let stopped_by_shutdown = self.cancel.is_set() && crate::restart_resume::is_shutting_down();
            if tracks_in_flight && !stopped_by_shutdown {
                if let Err(e) = db::clear_turn_in_flight(&self.pool, &marked_sid).await {
                    tracing::warn!("turn_in_flight_clear_failed session_id={} error={}", marked_sid, e);
                }
            }
            // Read as idle only under the senders' lock, after a second look
            // at the queue. A sender that saw this turn running queued its row
            // for it, but the look above may have come first; without this the
            // row waits for the next message (a member's report delivered as
            // its lead's turn closed sat queued for good).
            let _senders = self.user_message_lock.lock().await;
            let may_continue = exit.may_activate_queue(self.cancel.is_set(), !sid.is_empty());
            if may_continue && self.activate_queued_user_messages(&sid).await {
                // The late row's turn is now the active one.
                completed = false;
            } else {
                self.transition(Transition::ReleaseTurn);
            }
        }
        let lead = self.parent_session_id.is_none();
        if completed && lead && !opts.force_compaction && !sid.is_empty() && !self.cancel.is_set() {
            self.arm_idle_compaction();
        }
        self.detect_config_drift();
    }

    async fn execute_turn(&self, opts: &TurnOptions) -> Result<(), AgentError> {
        let sid = self.session_id();
        let workspace = self.workspace();
        let agent = self.agent();
        let name = agent.name.clone();
        let mut interaction = "code".to_string();
        let agent_mode = settings().workspace_mode(if workspace.is_empty() { None } else { Some(Path::new(&workspace)) });
        let dberr = |e: anyhow::Error| AgentError::Other(e.to_string());

        let mut runtime_model = opts.runtime_model.clone().filter(|m| !m.is_empty());
        let mut runtime_thinking = opts.runtime_thinking_level.clone().filter(|m| !m.is_empty());
        let mut credential = None;
        db::cleanup_reverted_tail(&self.pool, &sid).await.map_err(dberr)?;
        if let Some(row) = db::get_session(&self.pool, &sid).await.map_err(dberr)? {
            interaction = interaction_mode::normalize(&row.interaction_mode).to_string();
            if interaction == "plan" {
                interaction_mode::ensure_prompt(&self.pool, &sid, &interaction).await.map_err(dberr)?;
            }
            if runtime_model.is_none() {
                runtime_model = row.model.clone();
            }
            if runtime_thinking.is_none() {
                runtime_thinking = row.thinking_level.clone();
            }
            self.release_stale_pin(&sid, &row).await;
            credential = self.pinned_credential(&row).await;
        }
        if self.parent_session_id.is_none() {
            let plan_dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
            if let Err(e) = crate::plan::announce_user_edits(&self.pool, &sid, &plan_dir).await {
                tracing::warn!("plan_edit_note_failed session_id={} error={}", sid, e);
            }
        }
        let history = crate::history::get_messages_for_llm(&self.pool, &sid).await.map_err(dberr)?;

        let RuntimeProvider { effective_model, runtime: runtime_provider, thinking_level } =
            self.resolve_runtime_provider(&agent, runtime_model.as_deref(), runtime_thinking.as_deref(), credential.as_deref()).map_err(provider_error_to_agent)?;
        let provider_for_hooks = runtime_provider.clone().unwrap_or_else(|| agent.provider.clone());
        let is_lead = self.parent_session_id.is_none();
        // A lead turn in Code mode while a goal is active works on it.
        let goal = if opts.work().is_conversation() { self.goal_for_turn(&sid, &interaction).await } else { None };

        let ws_path = session_workspace_dir(&sid, Some(&workspace));
        let denied = Arc::new(DeniedPaths::new(&ws_path, Some(sid.clone())));
        let memory = self.memory_context().await;
        let mut otel_hook = crate::hooks::otel::OtelHook::new(&name, effective_model.as_deref());
        if let Some(g) = &goal {
            otel_hook = otel_hook.with_run_attrs(crate::goal::run_span_attrs(g));
        }
        let mut hooks: Vec<HookRef> = vec![
            Arc::new(CurrentDateHook),
            Arc::new(StreamPublisherHook::new(&sid, &name, true)),
            Arc::new(otel_hook),
            Arc::new(crate::hooks::lsp::LspHook { enabled: agent_mode == "coding", denied: denied.clone() }),
            Arc::new(RuntimeProtocolHook { lead: is_lead }),
            Arc::new(MemoryContextHook { content: memory, lead: is_lead }),
        ];
        if is_lead {
            let me = self.me.clone();
            let agent_for_switch = agent.clone();
            let resolve: crate::hooks::basic::ResolveModel = Arc::new(move |model, thinking, credential| {
                let me = me.upgrade().ok_or_else(|| "session gone".to_string())?;
                let rp = me.resolve_runtime_provider(&agent_for_switch, model, thinking, credential).map_err(|e| e.to_string())?;
                Ok(crate::hooks::ModelSwitch { provider: rp.provider(&agent_for_switch), model_id: rp.effective_model, thinking_level: rp.thinking_level })
            });
            hooks.push(Arc::new(QueuedInjectionHook {
                session_id: sid.clone(),
                agent_name: name.clone(),
                pool: self.pool.clone(),
                support_interrupt: provider_for_hooks.support_interrupt(),
                switch: Some(crate::hooks::basic::SteerSwitch {
                    resolve,
                    current: std::sync::Mutex::new(crate::hooks::basic::RunChoice {
                        model: runtime_model.clone().filter(|m| !m.is_empty()),
                        thinking_level: runtime_thinking.clone().filter(|t| !t.is_empty()),
                        credential: credential.clone(),
                    }),
                }),
            }));
            if let Some(t) = build_title_generation_hook(provider_for_hooks.clone(), self.pool.clone(), credential.as_deref()) {
                hooks.push(Arc::new(t));
            }
        } else if let Some(lead) = &self.parent_session_id {
            hooks.push(Arc::new(crate::subagents::stall::MemberStallHook::new(lead, &name, self.pool.clone())));
        }
        hooks.push(Arc::new(WorkspaceInstructionsHook::new(Some(&workspace), agent_mode == "coding")));
        if let Some(g) = &goal {
            let counters = Arc::new(crate::goal::TurnCounters::default());
            hooks.push(Arc::new(crate::goal::GoalTurnHook { counters: counters.clone() }));
            *self.goal_turn.lock().unwrap() = Some(crate::goal::GoalTurn { goal_id: g.id.clone(), started: std::time::Instant::now(), counters });
        }
        hooks.extend(self.test_hooks.lock().unwrap().iter().cloned());
        let checkpointer = Checkpointer::new(self.pool.clone(), Some(sid.clone()), Some(name.clone()))
            .stop_when_session_gone(self.cancel.clone())
            .stop_when_session_gone(self.hard_cancel.clone());
        checkpointer.mark_loaded(&history);
        hooks.push(Arc::new(ToolResultOffloadHook::default()));
        if is_lead {
            let plan_dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
            if let Some(h) = build_summarization_hook(provider_for_hooks.clone(), agent_mode, effective_model.as_deref(), provider_for_hooks.support_interrupt()) {
                let mut h = h.with_plan_dir(plan_dir);
                if let Some(retitle) = build_summary_retitle(provider_for_hooks.clone(), self.pool.clone(), credential.as_deref()) {
                    h = h.with_on_summary(retitle);
                }
                hooks.push(Arc::new(h));
            }
            hooks.push(Arc::new(crate::side_question::RequestFrameHook::new(self.request_frame.clone())));
        }

        let injected = self.injected_tools(&sid, &name, &workspace, agent_mode);

        let mut meta = Map::new();
        meta.insert("session_id".into(), json!(sid));
        meta.insert("interaction_mode".into(), json!(interaction));
        // Where this turn's prompts begin, for `ask_user` (see [`agent_only_since`]).
        if let Some((_, seq)) = self.turn_floor.lock().unwrap().as_ref().filter(|(s, _)| *s == sid) {
            meta.insert(TURN_FLOOR_META.into(), json!(seq));
        }
        if let Some(t) = thinking_level.filter(|t| !t.is_empty()) {
            meta.insert("thinking_level".into(), json!(t));
        }
        if opts.question_resume {
            meta.insert("question_resume".into(), json!(true));
        }
        if opts.unattended {
            meta.insert(crate::agent::UNATTENDED_META.into(), json!(true));
        } else if goal.is_some() && !appv3_core::runtime_settings::goal_settings().allow_questions {
            // Nobody watches a goal by default: questions and plan reviews refuse.
            meta.insert(crate::agent::UNATTENDED_META.into(), json!(true));
            meta.insert(crate::agent::UNATTENDED_REASON_META.into(), json!(crate::agent::UNATTENDED_GOAL));
        }
        if opts.force_compaction {
            meta.insert("force_summarization".into(), json!(true));
            meta.insert("stop_after_before_model".into(), json!(true));
        }
        if !workspace.is_empty() {
            meta.insert("workspace".into(), json!(workspace));
        }
        let result = agent
            .run(
                history,
                RunOptions {
                    session_id: Some(sid.clone()),
                    metadata: meta,
                    hooks,
                    injected_tools: injected,
                    interrupt: Some(self.cancel.clone()),
                    hard_cancel: Some(self.hard_cancel.clone()),
                    checkpointer: Some(&checkpointer),
                    provider: runtime_provider,
                    model_id: effective_model.clone(),
                    denied,
                    workspace: if workspace.is_empty() { None } else { Some(workspace.clone()) },
                },
            )
            .await;
        let cancelled_hard = matches!(result, Err(AgentError::Cancelled));
        match result {
            Ok(out) => {
                let question = match out.metadata.get("question_suspended") {
                    Some(Value::Object(q)) => Some(json!({"question_id": q.get("question_id"), "session_id": q.get("session_id")})),
                    _ => None,
                };
                let lead = out.metadata.get("lead_suspended").filter(|l| l.is_object()).cloned();
                self.turn_suspension.lock().unwrap().record(question, lead);
            }
            Err(AgentError::Cancelled) => {}
            Err(e) => return Err(e),
        }
        if self.cancel.is_set() || cancelled_hard {
            if let Err(e) = db::mark_last_assistant_interrupted(&self.pool, &sid).await {
                tracing::warn!("mark_interrupted_failed session_id={} error={}", sid, e);
            }
        }
        Ok(())
    }
    /// `idle_compaction` marks a background compaction turn on the event, so
    /// clients do not flag the session as having something new to read.
    /// `goal_id`: the turn worked on that goal, so its notification names
    /// what became of the goal.
    async fn close_turn(&self, session_id: &str, status: &str, notify: bool, idle_compaction: bool, goal_id: Option<&str>) {
        store().push_event(session_id, &events::done(Some(json!({"session_id": session_id}))), true);
        store().mark_done(session_id);
        let floor = self.turn_floor.lock().unwrap().take();
        let quiet = self.parent_session_id.is_none() && self.turn_is_quiet(session_id, floor).await;
        match &self.parent_session_id {
            None => {
                // Requests from other workspaces get their answer first; a
                // final answer wakes the sender, whose turn notifies instead.
                let last_error = self.last_error();
                let replied = crate::workspace_messages::on_turn_closed(&self.pool, session_id, status, self.cancel.is_set(), last_error.as_deref()).await;
                let label = if notify && !replied && !quiet { self.notification_status(session_id, status) } else { None };
                // A goal's last turn says what became of the goal instead of "Done".
                let goal = match (label, goal_id) {
                    (Some("Done"), Some(id)) => self.goal_outcome(session_id, id).await,
                    _ => None,
                };
                if let Some(label) = goal.map(notification::goal_status).or(label) {
                    let mut payload = self.completion_notification(session_id, label).await;
                    payload["outcome"] = json!(notification::outcome(status == "error", goal));
                    if let Some(goal) = goal {
                        payload["goal"] = json!(goal);
                    }
                    broadcaster::publish("desktop_notification", payload);
                }
            }
            Some(lead) => {
                let error = if status == "error" { self.last_error_info() } else { None };
                crate::subagents::report::on_subagent_turn_completed(lead, session_id, status, &self.workspace(), &self.name(), &self.pool, self.cancel.is_set(), error.as_ref())
                    .await;
            }
        }
        let mut payload = json!({"session_id": session_id, "status": status});
        if let Some(p) = &self.parent_session_id {
            payload["parent_session_id"] = json!(p);
        }
        if idle_compaction {
            payload["idle_compaction"] = json!(true);
        }
        if quiet {
            payload["quiet"] = json!(true);
        }
        // A turn can fail before any client has attached to its stream (e.g.
        // a missing provider key fails in milliseconds) and the error is not
        // persisted, so clients on the global stream get the text here.
        if status == "error" {
            if let Some(err) = self.last_error() {
                payload["error"] = json!(err);
            }
        }
        broadcaster::publish("session_turn_completed", payload);
    }

    /// A turn only agents worked in: every prompt that started or steered it
    /// came from another agent, in a session another workspace's send
    /// started or with a request from one. It does not notify and does not
    /// read as unread; once the user writes into a turn it notifies as usual.
    /// Its `ask_user` goes back to the sending agent instead (see
    /// [`agent_only_since`]).
    async fn turn_is_quiet(&self, session_id: &str, floor: Option<(String, i64)>) -> bool {
        let Some((_, seq)) = floor.filter(|(s, _)| s == session_id) else { return false };
        agent_only_since(&self.pool, session_id, seq).await
    }

    /// The notification status for a lead turn that just ended, or `None`
    /// when it should not notify: the user stopped it, or subagents are still
    /// working and their reports will run the lead again (that last turn
    /// notifies instead). A failed turn notifies: the user may be away.
    fn notification_status(&self, session_id: &str, status: &str) -> Option<&'static str> {
        if self.cancel.is_set() {
            return None;
        }
        match status {
            "completed" if crate::subagents::has_pending_work(session_id) => None,
            "completed" => Some("Done"),
            "error" => Some("Failed"),
            _ => None,
        }
    }

    /// What became of goal `goal_id` after its last turn (see [`notification::goal_outcome`]).
    async fn goal_outcome(&self, session_id: &str, goal_id: &str) -> Option<&'static str> {
        match db::get_session_goal(&self.pool, session_id, goal_id).await {
            Ok(Some(g)) => notification::goal_outcome(&g.status, g.pause_reason.as_deref()),
            Ok(None) => None,
            Err(e) => {
                tracing::warn!("goal_notification_lookup_failed session_id={} error={}", session_id, e);
                None
            }
        }
    }

    /// `kind` stays `assistant_done` for a failed turn so clients that only
    /// know the original kinds still show it; the caller adds `outcome`,
    /// which says how the turn ended.
    async fn completion_notification(&self, session_id: &str, status: &str) -> Value {
        let (title, workspace) = match db::get_session(&self.pool, session_id).await {
            Ok(Some(r)) => (r.title, Some(r.workspace)),
            Ok(None) => (None, None),
            Err(e) => {
                tracing::warn!("completion_notification_metadata_failed session_id={} error={}", session_id, e);
                (None, None)
            }
        };
        let body = title.as_deref().and_then(notification::body).unwrap_or_else(|| format!("Session {}", crate::util::head_chars(session_id, 8)));
        json!({
            "type": "desktop_notification",
            "notification_id": uuid::Uuid::new_v4().to_string(),
            "kind": "assistant_done",
            "session_id": session_id,
            "title": notification::title(status, workspace.as_deref()),
            "body": body,
        })
    }
}
