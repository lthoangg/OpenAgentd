//! Single-agent session runtime — port of `app/agent/session.py`.

mod control;
mod idle;
mod provider;
mod questions;
mod turn;

use questions::Suspension;

use self::control::{Control, ControlState, SessionStatus, Transition, TurnWork};
use self::provider::TurnSettings;
use crate::agent::Agent;
use crate::events::{self, Envelope};
use crate::hooks::HookRef;
use crate::idle_compaction::IDLE_COMPACTION_DELAY;
use crate::interaction_mode;
use crate::loader::{self, ProviderFactory};
use crate::stream_store::store;
use crate::util::Event;
use appv3_core::machine::{self, Machine};
use appv3_core::settings::settings;
use appv3_db::{self as db, DbPool, NewMessage};
use appv3_providers::LlmProvider;
use appv3_tools::ToolRef;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("Session {0} is awaiting answer to pending question.")]
    QuestionPending(String),
    #[error("{message}")]
    Precondition { message: String, status: u16 },
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl SessionError {
    fn precondition(m: impl Into<String>) -> Self {
        SessionError::Precondition { message: m.into(), status: 409 }
    }
}

/// `_normalize_question_status`.
pub fn normalize_question_status(s: &str) -> &'static str {
    match s {
        "answered" => "answered",
        "superseded" => "superseded",
        "expired" => "expired",
        _ => "dismissed",
    }
}

/// `session_workspace_dir(sid, workspace)`.
pub fn session_workspace_dir(session_id: &str, workspace: Option<&str>) -> PathBuf {
    match workspace.filter(|w| !w.is_empty()) {
        Some(w) => appv3_tools::denied::resolve(Path::new(w)),
        None => settings().session_workspace_dir(session_id),
    }
}

/// `session_uploads_dir(sid, workspace)`.
pub fn session_uploads_dir(session_id: &str, workspace: Option<&str>) -> PathBuf {
    session_workspace_dir(session_id, workspace).join("uploads")
}

/// Options for one `_run_turn`.
#[derive(Default, Clone)]
pub struct TurnOptions {
    /// This turn starts a new run (a message the user or a schedule sent, a
    /// Continue, a `/compact`), so it picks up agent config edited since the
    /// last one. Every other turn continues the current run (a queued steer
    /// or member report, an answered question, idle compaction) and keeps the
    /// agent it started with: switching the default model in Settings must
    /// not switch a session that is still running.
    pub starts_run: bool,
    pub force_compaction: bool,
    /// A background compaction started by the idle timer (see
    /// [`crate::idle_compaction`]); it sends no desktop notification.
    pub idle_compaction: bool,
    pub question_resume: bool,
    /// A scheduled task started this turn, so nobody is there to answer a
    /// question or review a plan (see [`crate::agent::UNATTENDED_META`]).
    pub unattended: bool,
    pub runtime_model: Option<String>,
    pub runtime_thinking_level: Option<String>,
    pub queued_activation_event: Option<Value>,
    /// A restart is continuing the turn the last server process left
    /// running (see [`crate::restart_resume`]).
    pub restart_resume: bool,
}

impl TurnOptions {
    fn work(&self) -> TurnWork {
        TurnWork::from_compaction(self.force_compaction, self.idle_compaction)
    }
}

/// `handle_user_message` arguments.
#[derive(Default, Clone)]
pub struct UserMessage {
    pub content: String,
    pub session_id: String,
    pub attachment_metas: Option<Vec<Value>>,
    pub mention_context_blocks: Option<Vec<String>>,
    pub workspace: Option<String>,
    pub model: Option<String>,
    pub model_provided: bool,
    pub thinking_level: Option<String>,
    pub thinking_level_provided: bool,
    pub service_tier: Option<String>,
    pub mentions: Option<Vec<String>>,
    /// `user` | `scheduler` | `agent` | `workspace` (another workspace's agent)
    pub origin: String,
    /// Extra keys stored on the message row (e.g. `sent_from`).
    pub extra: Option<Map<String, Value>>,
}

/// The provider a turn of this session calls (see
/// [`AgentSession::resolve_runtime_provider`]).
pub struct RuntimeProvider {
    /// The session's model, else the agent's.
    pub effective_model: Option<String>,
    /// Built for the session's model/thinking override; `None` uses the
    /// agent's own provider.
    pub runtime: Option<Arc<dyn LlmProvider>>,
    pub thinking_level: Option<String>,
}

impl RuntimeProvider {
    pub fn provider(&self, agent: &Agent) -> Arc<dyn LlmProvider> {
        self.runtime.clone().unwrap_or_else(|| agent.provider.clone())
    }
}

pub struct AgentSession {
    agent: RwLock<Arc<Agent>>,
    session_id: Mutex<String>,
    workspace: Mutex<String>,
    pub pool: DbPool,
    pub provider_factory: ProviderFactory,
    pub parent_session_id: Option<String>,
    control: Mutex<ControlState>,
    cancel: Event,
    hard_cancel: Event,
    pub user_message_lock: tokio::sync::Mutex<()>,
    command_lock: tokio::sync::Mutex<()>,
    /// When a turn last started or ended; the manager counts idle time
    /// from here as well as from the last lookup.
    last_turn_activity: Mutex<std::time::Instant>,
    active_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    turn_generation: tokio::sync::watch::Sender<u64>,
    config_dirty: AtomicBool,
    /// What the running turn will pause on when it ends, from its run
    /// metadata (an `ask_user` question wins over an `ask_lead` request).
    /// Cleared when a turn starts; moved into the status when it pauses.
    turn_suspension: Mutex<Suspension>,
    /// Held while a turn that asked a question decides how it ends, and
    /// while an answer decides whether to start the resumed turn: a question
    /// opens before the reply's other tool calls finish, so its answer can
    /// arrive while that turn still runs.
    question_gate: tokio::sync::Mutex<()>,
    /// The question (on-disk id) whose answer the turn that asked it already
    /// continued with; that answer's own resume call must start nothing.
    continued_question: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    /// The last failed turn's `format_agent_error` (message, title, code,
    /// category), which a member's failure report hands to its lead.
    last_error_info: Mutex<Option<Value>>,
    pending_interaction_mode: Mutex<Option<String>>,
    /// The session and the `seq` of its newest assistant row when the turn
    /// now running began: prompts after it started or steered this turn (see
    /// [`AgentSession::turn_is_quiet`]). Kept across queued activations and
    /// question resumes, cleared when the turn closes.
    turn_floor: Mutex<Option<(String, i64)>>,
    /// `<openagentd_memory>` as of this session's first turn. Frozen so the
    /// system prompt stays byte-identical across turns (prefix caching);
    /// pages saved mid-session show up in the next session.
    memory_snapshot: Mutex<Option<String>>,
    /// Pending idle-compaction timer; any new turn aborts it.
    idle_timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    idle_compaction_delay: Mutex<Duration>,
    /// How long a stopped turn may wind down before it is force-ended.
    stop_grace: Mutex<Duration>,
    /// Extra hooks for every turn (tests only).
    test_hooks: Mutex<Vec<HookRef>>,
    /// System prompt and tools of the lead's last model call, which `/btw`
    /// side questions reuse so they hit the same prompt cache.
    request_frame: crate::side_question::FrameSlot,
    /// The goal turn running now, if any (see [`crate::goal`]).
    goal_turn: Mutex<Option<crate::goal::GoalTurn>>,
    /// Held across each read-modify-write of the session's goal row: a
    /// turn's accounting, Stop, the API and `update_goal` all write it.
    /// It also guards the goal state that is not stored.
    goal_lock: tokio::sync::Mutex<crate::goal::GoalLocal>,
    me: Weak<AgentSession>,
}

/// Turn metadata key: the `seq` of the newest assistant row when the turn
/// began (a lead's turn only), for [`agent_only_since`].
pub const TURN_FLOOR_META: &str = "turn_floor_seq";

/// Whether only agents worked in the turn whose prompts come after
/// `after_seq`: nothing the user typed, in a session another workspace's
/// send started or with a request from one. Such a turn does not notify
/// (see `close_turn`), and `ask_user` sends its question back to the agent
/// that sent the request instead of to the user, who is not following it.
pub async fn agent_only_since(pool: &DbPool, session_id: &str, after_seq: i64) -> bool {
    let authors = match db::turn_prompt_authors(pool, session_id, after_seq).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("turn_prompt_authors_failed session_id={} error={}", session_id, e);
            return false;
        }
    };
    if authors.user {
        return false;
    }
    authors.workspace_agent || db::get_session(pool, session_id).await.ok().flatten().is_some_and(|s| s.sent_from_session_id.is_some())
}

/// A stopped turn that has not ended this long after Stop is force-ended:
/// its remaining work (a hook or checkpoint that never returns) is dropped
/// so the session cannot stay busy forever.
const STOP_GRACE: Duration = Duration::from_secs(10);

impl AgentSession {
    pub fn new(
        agent: Agent,
        session_id: Option<String>,
        workspace: Option<String>,
        pool: DbPool,
        provider_factory: ProviderFactory,
        parent_session_id: Option<String>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            agent: RwLock::new(Arc::new(agent)),
            session_id: Mutex::new(session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string())),
            workspace: Mutex::new(workspace.unwrap_or_default()),
            pool,
            provider_factory,
            parent_session_id,
            control: Mutex::new(ControlState::default()),
            cancel: Event::new(),
            hard_cancel: Event::new(),
            user_message_lock: tokio::sync::Mutex::new(()),
            command_lock: tokio::sync::Mutex::new(()),
            last_turn_activity: Mutex::new(std::time::Instant::now()),
            active_task: Mutex::new(None),
            turn_generation: tokio::sync::watch::channel(0).0,
            config_dirty: AtomicBool::new(false),
            turn_suspension: Mutex::new(Suspension::None),
            question_gate: tokio::sync::Mutex::new(()),
            continued_question: Mutex::new(None),
            last_error: Mutex::new(None),
            last_error_info: Mutex::new(None),
            pending_interaction_mode: Mutex::new(None),
            turn_floor: Mutex::new(None),
            memory_snapshot: Mutex::new(None),
            idle_timer: Mutex::new(None),
            idle_compaction_delay: Mutex::new(IDLE_COMPACTION_DELAY),
            stop_grace: Mutex::new(STOP_GRACE),
            test_hooks: Mutex::new(vec![]),
            request_frame: Default::default(),
            goal_turn: Mutex::new(None),
            goal_lock: tokio::sync::Mutex::new(Default::default()),
            me: me.clone(),
        })
    }

    // ── accessors ──
    pub fn agent(&self) -> Arc<Agent> {
        self.agent.read().unwrap().clone()
    }

    /// `<openagentd_memory>` as of the session's first turn (frozen so the
    /// system prompt stays byte-identical across turns).
    pub(crate) async fn memory_context(&self) -> String {
        let frozen = self.memory_snapshot.lock().unwrap().clone();
        match frozen {
            Some(m) => m,
            None => {
                // Reads every memory page; keep that disk walk off the async worker.
                let m = tokio::task::spawn_blocking(appv3_memory::memory_context).await.unwrap_or_default();
                *self.memory_snapshot.lock().unwrap() = Some(m.clone());
                m
            }
        }
    }

    /// Tools a turn of this session gets beside the agent's own.
    ///
    /// The same on every turn, whoever started it: tool definitions sit in
    /// the cached prompt prefix, so changing them between a scheduled turn
    /// and a user's turn would re-send the whole context at full price. A
    /// scheduled turn instead refuses the tools that wait on a person when
    /// they are called.
    pub(crate) fn injected_tools(&self, sid: &str, name: &str, workspace: &str, agent_mode: &str) -> Vec<ToolRef> {
        crate::tool_registry::session_tools(&crate::tool_registry::SessionCtx {
            sid,
            agent_name: name,
            workspace,
            agent_mode,
            lead: self.parent_session_id.as_deref(),
            pool: &self.pool,
            provider_factory: &self.provider_factory,
            session: &self.me,
        })
    }

    pub(crate) fn request_frame(&self) -> &crate::side_question::FrameSlot {
        &self.request_frame
    }

    pub(crate) fn goal_lock(&self) -> &tokio::sync::Mutex<crate::goal::GoalLocal> {
        &self.goal_lock
    }

    pub fn name(&self) -> String {
        self.agent().name.clone()
    }
    pub fn model_id(&self) -> String {
        self.agent().model_id.clone().unwrap_or_default()
    }
    pub fn session_id(&self) -> String {
        self.session_id.lock().unwrap().clone()
    }
    pub fn workspace(&self) -> String {
        self.workspace.lock().unwrap().clone()
    }
    pub fn state(&self) -> String {
        self.status().as_str().to_string()
    }

    fn status(&self) -> SessionStatus {
        self.control.lock().unwrap().status().clone()
    }

    fn owns_turn(&self) -> bool {
        self.control.lock().unwrap().owns_turn()
    }

    /// Make `event`, which must be legal ([`machine::apply`]: an illegal one
    /// is logged, panics in debug builds, and changes nothing).
    fn transition(&self, event: Transition) {
        self.move_by(event, true);
    }

    /// Make `event` when the table allows it now; `false`, and nothing
    /// changes, when it does not (a refusal that is an ordinary answer).
    fn try_transition(&self, event: Transition) -> bool {
        self.move_by(event, false)
    }

    fn move_by(&self, event: Transition, must: bool) -> bool {
        let (from, to, owns_turn, moved) = {
            let mut control = self.control.lock().unwrap();
            let from = Control::state_kind(&control);
            let moved = if must {
                machine::apply::<Control>(&mut control, &event).is_ok()
            } else if let Some(next) = Control::step(&control, &event) {
                *control = next;
                true
            } else {
                false
            };
            // A new claim starts with no Stop pending. Under the control lock,
            // so `is_stopping` never sees the claim with the last Stop still set.
            if moved && matches!(event, Transition::Begin | Transition::Resume | Transition::Claim) {
                self.clear_cancel();
            }
            (from, Control::state_kind(&control), control.owns_turn(), moved)
        };
        if moved && event.touches_turn_activity() {
            *self.last_turn_activity.lock().unwrap() = std::time::Instant::now();
            self.turn_generation.send_modify(|generation| *generation += 1);
        }
        tracing::debug!(session_id = %self.session_id(), event = Control::event_kind(&event), from, to, owns_turn, moved, "session_transition");
        moved
    }

    /// Claim a free session for a new turn (`Begin`): the busy check and the
    /// claim are one step, so two commands sent together cannot both start a
    /// turn. `false` when the session is busy. A claim whose setup then fails
    /// is handed back with [`Self::abandon_turn`].
    fn try_begin_turn(&self) -> bool {
        self.try_transition(Transition::Begin)
    }

    /// Hand back a claim from [`Self::try_begin_turn`] whose turn never started.
    fn abandon_turn(&self) {
        self.transition(Transition::Abandon);
    }

    /// Put the session in a status directly (tests only), as a session
    /// that got there by its own moves would be, without a turn task.
    #[cfg(test)]
    pub(crate) fn set_state(&self, s: &str) {
        let status = match s {
            "idle" => SessionStatus::Idle,
            "working" => SessionStatus::Working,
            "waiting_input" => SessionStatus::WaitingInput { question: Value::Null },
            "waiting_lead" => SessionStatus::WaitingLead { lead: Value::Null },
            "error" => SessionStatus::Error,
            "offline" => SessionStatus::Offline,
            _ => panic!("unknown test session state: {s}"),
        };
        *self.control.lock().unwrap() = ControlState::forced(status, false);
    }
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }
    pub fn last_error_info(&self) -> Option<Value> {
        self.last_error_info.lock().unwrap().clone()
    }
    /// The request a member waiting on its lead sent it.
    pub fn lead_suspended(&self) -> Option<Value> {
        match self.control.lock().unwrap().status() {
            SessionStatus::WaitingLead { lead } => Some(lead.clone()),
            _ => None,
        }
    }
    pub fn is_busy(&self) -> bool {
        self.control.lock().unwrap().is_busy()
    }
    pub fn has_active_user_turn(&self) -> bool {
        self.is_busy()
    }
    pub fn is_awaiting_question_answer(&self) -> bool {
        matches!(self.control.lock().unwrap().status(), SessionStatus::WaitingInput { .. })
    }
    pub fn pending_interaction_mode(&self) -> Option<String> {
        self.pending_interaction_mode.lock().unwrap().clone()
    }
    pub fn queue_interaction_mode(&self, mode: &str) {
        *self.pending_interaction_mode.lock().unwrap() = Some(interaction_mode::normalize(mode).to_string());
    }
    /// Drop a mode switch queued while the turn was busy; plan approval
    /// sets the mode itself and must not be undone when the turn ends.
    pub fn clear_pending_interaction_mode(&self) {
        *self.pending_interaction_mode.lock().unwrap() = None;
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_set()
    }
    /// Whether the spawned turn task is finished (or none was spawned).
    pub fn active_task_done(&self) -> bool {
        self.active_task.lock().unwrap().as_ref().map(|h| h.is_finished()).unwrap_or(true)
    }
    /// Resolve when the current turn's task (and any chained queued activation) finishes.
    pub async fn wait_turn_finished(&self) {
        let mut rx = self.turn_generation.subscribe();
        while self.owns_turn() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// A stop was requested and the stopped turn is still winding down (a
    /// cancelled tool can take seconds to drain and reap). `cancel` stays set
    /// after the turn ends, so the active turn is what marks the stop pending.
    pub fn is_stopping(&self) -> bool {
        self.control.lock().unwrap().is_stopping(self.cancel.is_set())
    }

    /// Wait up to `limit` for the current turn to end; `true` when none is active.
    pub async fn wait_for_stop(&self, limit: std::time::Duration) -> bool {
        tokio::time::timeout(limit, self.wait_turn_finished()).await.is_ok()
    }

    fn arc(&self) -> Arc<AgentSession> {
        self.me.upgrade().expect("session alive")
    }

    fn clear_cancel(&self) {
        self.cancel.clear();
        self.hard_cancel.clear();
    }

    /// When a turn last started or ended (session creation before any turn).
    pub fn last_turn_activity(&self) -> std::time::Instant {
        *self.last_turn_activity.lock().unwrap()
    }

    fn spawn_turn(&self, opts: TurnOptions) {
        self.cancel_idle_timer();
        let me = self.arc();
        let h = appv3_core::otel::spawn(async move { me.run_turn(opts).await });
        *self.active_task.lock().unwrap() = Some(h);
    }

    /// Override [`STOP_GRACE`] (tests only).
    #[doc(hidden)]
    pub fn set_stop_grace(&self, grace: Duration) {
        *self.stop_grace.lock().unwrap() = grace;
    }

    /// Run `hook` in every later turn (tests only).
    #[doc(hidden)]
    pub fn push_test_hook(&self, hook: HookRef) {
        self.test_hooks.lock().unwrap().push(hook);
    }

    /// Resolves [`STOP_GRACE`] after a hard stop.
    async fn force_stop_due(&self) {
        self.hard_cancel.wait().await;
        let grace = *self.stop_grace.lock().unwrap();
        tokio::time::sleep(grace).await;
    }

    // ── lifecycle ──
    pub async fn start(&self) {
        tracing::info!("agent_session_started agent={} session_id={}", self.name(), self.session_id());
    }

    pub async fn stop(&self) {
        self.cancel_idle_timer();
        self.cancel.set();
        self.hard_cancel.set();
        let handle = self.active_task.lock().unwrap().take();
        if let Some(mut h) = handle {
            if !h.is_finished() {
                // The turn force-ends itself after the grace period; abort is
                // the last resort for one stuck where no await is reached.
                let limit = *self.stop_grace.lock().unwrap() + Duration::from_secs(5);
                if tokio::time::timeout(limit, &mut h).await.is_err() {
                    tracing::warn!("agent_turn_aborted session_id={}", self.session_id());
                    h.abort();
                }
            }
        }
        if self.parent_session_id.is_none() {
            crate::subagents::stop_all_subagents(&self.session_id()).await;
        }
        self.transition(Transition::GoOffline);
        tracing::info!("agent_session_stopped session_id={}", self.session_id());
    }

    fn emit(&self, event: &str, status: Option<&str>, extra: Option<Map<String, Value>>) {
        let mut payload = Map::new();
        payload.insert("type".into(), json!(event));
        payload.insert("agent".into(), json!(self.name()));
        if let Some(s) = status {
            payload.insert("status".into(), json!(s));
        }
        if let Some(e) = extra {
            for (k, v) in e {
                payload.insert(k, v);
            }
        }
        store().push_event(&self.session_id(), &Envelope::from_parts(event, Value::Object(payload)), false);
    }

    pub async fn bind_session(&self, session_id: &str, workspace: Option<&str>, title: Option<&str>) -> anyhow::Result<()> {
        *self.session_id.lock().unwrap() = session_id.to_string();
        if let Some(w) = workspace {
            *self.workspace.lock().unwrap() = w.to_string();
        }
        self.ensure_db_session(title).await
    }

    pub async fn attach_to_session(&self, session_id: &str, title: Option<&str>) -> anyhow::Result<()> {
        let ws = self.workspace();
        self.bind_session(session_id, Some(&ws), title).await
    }

    async fn ensure_db_session(&self, title: Option<&str>) -> anyhow::Result<()> {
        let sid = self.session_id();
        let Some(uuid) = db::codec::parse_uuid(&sid) else {
            return Ok(());
        };
        let ws = self.workspace();
        match db::get_session(&self.pool, &sid).await? {
            None => {
                db::create_session(
                    &self.pool,
                    db::NewSession {
                        id: Some(uuid),
                        parent_session_id: self.parent_session_id.clone(),
                        agent_name: Some(self.name()),
                        title: title.map(String::from),
                        workspace: ws,
                        model: self.agent().model_id.clone(),
                        ..Default::default()
                    },
                )
                .await?;
            }
            Some(row) => {
                let mut upd = db::SessionUpdate::default();
                if !ws.is_empty() && row.workspace.is_empty() {
                    upd.workspace = Some(ws);
                }
                if let Some(t) = title.filter(|t| !t.is_empty()) {
                    if row.title.as_deref().map(|x| x.is_empty()).unwrap_or(true) {
                        upd.title = Some(Some(t.to_string()));
                    }
                }
                db::update_session(&self.pool, &sid, upd).await?;
            }
        }
        Ok(())
    }

    fn detect_config_drift(&self) {
        let agent = self.agent();
        if agent.source_path.is_none() || agent.config_stamp.is_empty() {
            return;
        }
        let drifted = loader::detect_drift(&agent.config_stamp);
        if !drifted.is_empty() {
            self.config_dirty.store(true, Ordering::SeqCst);
            tracing::info!("agent_config_dirty name={} paths={:?}", agent.name, drifted.iter().filter_map(|p| p.file_name()).collect::<Vec<_>>());
        }
    }

    fn refresh_agent_from_disk(&self) {
        let agent = self.agent();
        let Some(source) = agent.source_path.clone() else {
            self.config_dirty.store(false, Ordering::SeqCst);
            return;
        };
        match loader::rebuild_agent_from_disk(&source, &self.provider_factory) {
            Ok(new_agent) => {
                tracing::info!("agent_config_refreshed name={} model={:?} tools={:?}", new_agent.name, new_agent.model_id, {
                    let mut n = new_agent.tools.names();
                    n.sort();
                    n
                });
                *self.agent.write().unwrap() = Arc::new(new_agent);
            }
            Err(e) => {
                tracing::warn!("agent_config_refresh_failed name={} error={}", agent.name, e);
                let mut a = (*agent).clone();
                a.config_stamp = loader::stamp_agent_files(&source, &settings().mcp_config_path());
                *self.agent.write().unwrap() = Arc::new(a);
            }
        }
        self.config_dirty.store(false, Ordering::SeqCst);
    }

    /// Reload the agent when its files changed and no turn is running, so
    /// readers such as the agent registry see a model set since it loaded
    /// (a turn reloads on its own when it starts).
    pub fn refresh_config_if_idle(&self) {
        if self.is_busy() {
            return;
        }
        self.detect_config_drift();
        if self.config_dirty.load(Ordering::SeqCst) {
            self.refresh_agent_from_disk();
        }
    }

    /// `handle_user_message` → `(session_id, message_id)`. Starts a turn on
    /// a free session; a busy one refuses (callers send under
    /// `user_message_lock` and queue behind a running turn instead).
    pub async fn handle_user_message(&self, m: UserMessage) -> Result<(String, String), SessionError> {
        let sid = m.session_id.clone();
        // An open question: a machine message waits for the answer, and the
        // user's own message supersedes it (which ends the wait).
        if db::get_pending_question(&self.pool, &sid).await.ok().flatten().is_some() {
            if m.origin != "user" {
                tracing::info!("question_deferred_machine_message session_id={} origin={}", sid, m.origin);
                return Err(SessionError::QuestionPending(sid));
            }
            self.dismiss_pending_question("superseded", Some(&sid)).await;
        }
        // Claimed before the session is bound to `sid`: a refused message
        // must not rebind a session whose turn is running for another one.
        if !self.try_begin_turn() {
            tracing::warn!("user_message_refused_busy session_id={} state={}", sid, self.state());
            return Err(SessionError::precondition("The agent is still working on another turn."));
        }
        match self.start_user_turn(m).await {
            Ok(started) => Ok(started),
            Err(e) => {
                self.abandon_turn();
                Err(e)
            }
        }
    }

    /// The body of [`Self::handle_user_message`] once the session is claimed.
    async fn start_user_turn(&self, m: UserMessage) -> Result<(String, String), SessionError> {
        let sid = m.session_id.clone();
        let title: Option<String> = if m.content.is_empty() { None } else { Some(m.content.chars().take(100).collect()) };
        self.bind_session(&sid, m.workspace.as_deref(), title.as_deref()).await?;

        // The workspace snapshot (the state before this turn, for revert)
        // walks the whole tree; the database steps below never touch the
        // workspace, so they run alongside it. Both finish before the message
        // is saved and the turn starts, so no edit can land before the snapshot.
        let ws = self.workspace();
        let ws_dir = session_workspace_dir(&sid, Some(&ws));
        let prepare = async {
            crate::history::heal_orphaned_tool_calls(&self.pool, &sid).await?;
            // A switch queued while the last turn was paused on a question
            // (the review this message just superseded) applies to this turn,
            // not after it. A turn still winding down applies its own.
            if self.active_task_done() {
                self.apply_pending_interaction_mode().await;
            }
            let mut runtime = (m.model.clone().filter(|_| m.model_provided), m.thinking_level.clone().filter(|_| m.thinking_level_provided));
            if let Some(row) = db::get_session(&self.pool, &sid).await? {
                let mode = interaction_mode::follow_lead(&self.pool, &sid, &row).await?;
                if mode == "plan" {
                    interaction_mode::ensure_prompt(&self.pool, &sid, mode).await?;
                }
                let mut upd = db::SessionUpdate { workspace: Some(ws.clone()), ..Default::default() };
                if m.model_provided {
                    upd.model = Some(m.model.clone());
                }
                if m.thinking_level_provided {
                    upd.thinking_level = Some(m.thinking_level.clone());
                }
                let row = db::update_session(&self.pool, &sid, upd).await?.unwrap_or(row);
                runtime = (row.model, row.thinking_level);
            }
            db::cleanup_reverted_tail(&self.pool, &sid).await?;
            Ok::<_, SessionError>(TurnSettings::resolve(&self.agent(), runtime.0.as_deref(), runtime.1.as_deref()))
        };
        let (snapshot, prepared) = tokio::join!(crate::snapshot::track(&sid, &ws_dir), prepare);
        let settings = prepared?;

        let mut extra = m.extra.clone().unwrap_or_default();
        if let Some(a) = m.attachment_metas.as_ref().filter(|a| !a.is_empty()) {
            extra.insert("attachments".into(), Value::Array(a.clone()));
        }
        // The model and level this prompt runs with, whether or not this send
        // changed them, so the transcript can name them after a reload.
        if let Some(model) = settings.model.filter(|m| !m.is_empty()) {
            extra.insert("model".into(), json!(model));
        } else if m.model_provided {
            extra.insert("model".into(), Value::Null);
        }
        if let Some(level) = settings.thinking_level.filter(|t| !t.is_empty()) {
            extra.insert("thinking_level".into(), json!(level));
        } else if m.thinking_level_provided {
            extra.insert("thinking_level".into(), Value::Null);
        }
        if let Some(t) = &m.service_tier {
            extra.insert("service_tier".into(), json!(t));
        }
        if let Some(ms) = m.mentions.as_ref().filter(|x| !x.is_empty()) {
            extra.insert("mentions".into(), json!(ms));
        }
        if let Some(snap) = snapshot {
            extra.insert("snapshot".into(), Value::String(snap));
        }
        // Steers still queued (a failed turn, another device, a question that
        // was superseded) go first: saved after this message, the next model
        // call would promote them behind it, and the agent would read the
        // older text last.
        if let Err(e) = crate::snapshot::release_queued(&self.pool, &sid).await {
            tracing::warn!("release_queued_before_message_failed session_id={} error={}", sid, e);
        }
        let mut nm = NewMessage::user(m.content.clone());
        nm.extra = Some(extra);
        let persisted = db::save_message(&self.pool, &sid, nm).await?;

        if let Some(blocks) = m.mention_context_blocks.as_ref().filter(|b| !b.is_empty()) {
            let mut note_extra = Map::new();
            note_extra.insert("hidden_from_summary".into(), json!(true));
            if let Some(ms) = m.mentions.as_ref().filter(|x| !x.is_empty()) {
                note_extra.insert("mentions".into(), json!(ms));
            }
            let mut note = NewMessage::user(blocks.join("\n\n"));
            note.extra = Some(note_extra);
            note.kind = Some("note".into());
            note.pinned = Some(true);
            db::save_message(&self.pool, &sid, note).await?;
        }
        // What MCP app panels reported since the last message goes with this one.
        if let Some(text) = crate::mcp_apps::take_model_context(&sid) {
            let mut note = NewMessage::user(text);
            note.extra = Some(crate::mcp_apps::context_note_extra());
            note.kind = Some("note".into());
            db::save_message(&self.pool, &sid, note).await?;
        }
        store().init_turn(&sid, true);
        *self.turn_suspension.lock().unwrap() = Suspension::None;
        self.spawn_turn(TurnOptions { starts_run: true, unattended: m.origin == "scheduler", ..Default::default() });
        Ok((sid, db::codec::api_uuid(&persisted.id)))
    }

    pub async fn handle_stop(&self) -> bool {
        self.handle_stop_with(false).await
    }

    /// Stop & send: the user stops the turn only to add context, so the goal
    /// stays active and the message that follows is its next turn.
    pub async fn handle_stop_keeping_goal(&self) -> bool {
        self.handle_stop_with(true).await
    }

    async fn handle_stop_with(&self, keep_goal: bool) -> bool {
        // A turn task still running is stopped even if the state already
        // reads idle, or nothing could ever reach it.
        if !self.is_busy() && self.active_task_done() {
            return false;
        }
        self.cancel.set();
        self.hard_cancel.set();
        if self.parent_session_id.is_none() {
            Box::pin(crate::subagents::stop_all_subagents(&self.session_id())).await;
            if keep_goal {
                self.drop_goal_reminders_on_stop(&self.session_id()).await;
            } else {
                self.pause_goal_on_stop(&self.session_id()).await;
            }
        }
        self.dismiss_pending_question("dismissed", None).await;
        // A stopped member no longer waits on its lead: Stop leaves it idle.
        self.try_transition(Transition::RequestStop);
        self.emit("agent_status", Some("idle"), None);
        true
    }

    pub async fn handle_continue(
        &self,
        session_id: &str,
        workspace: Option<&str>,
        model: Option<String>,
        thinking_level: Option<String>,
    ) -> Result<(String, String), SessionError> {
        if !self.try_begin_turn() {
            return Err(SessionError::precondition("Cannot continue while agent is busy."));
        }
        if let Err(e) = self.bind_session(session_id, workspace, None).await {
            self.abandon_turn();
            return Err(e.into());
        }
        store().init_turn(session_id, true);
        self.spawn_turn(TurnOptions { starts_run: true, runtime_model: model, runtime_thinking_level: thinking_level, ..Default::default() });
        Ok((session_id.to_string(), uuid::Uuid::new_v4().to_string()))
    }

    pub async fn handle_compact(&self, session_id: &str, workspace: Option<&str>) -> Result<String, SessionError> {
        if !self.try_begin_turn() {
            return Err(SessionError::precondition("Cannot compact while agent is busy."));
        }
        if let Err(e) = self.bind_session(session_id, workspace, None).await {
            self.abandon_turn();
            return Err(e.into());
        }
        store().init_turn(session_id, true);
        self.spawn_turn(TurnOptions { starts_run: true, force_compaction: true, ..Default::default() });
        Ok(session_id.to_string())
    }

    /// Shared body of undo / redo / redo_all.
    pub async fn handle_boundary_command<F, Fut>(&self, session_id: &str, verb: &str, default_err: &str, op: F) -> Result<crate::revert::BoundaryShift, SessionError>
    where
        F: FnOnce(DbPool, String) -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<crate::revert::BoundaryShift>>,
    {
        if self.is_busy() {
            return Err(SessionError::precondition(format!("Cannot {verb} while agent is busy.")));
        }
        if self.parent_session_id.is_none() {
            crate::subagents::stop_all_subagents(session_id).await;
        }
        let _g = self.command_lock.lock().await;
        let shift = op(self.pool.clone(), session_id.to_string()).await?;
        if !shift.applied {
            return Err(SessionError::precondition(shift.error.clone().unwrap_or_else(|| default_err.to_string())));
        }
        Ok(shift)
    }

    /// `_activate_queued_user_messages`.
    pub async fn activate_queued_user_messages(&self, session_id: &str) -> bool {
        self.activate_queued_with(session_id, TurnOptions::default()).await
    }

    /// Start a turn on the queued rows with `opts` (its activation event is
    /// filled in here). `false` when nothing was queued.
    pub(crate) async fn activate_queued_with(&self, session_id: &str, opts: TurnOptions) -> bool {
        if self.session_id() != session_id {
            *self.session_id.lock().unwrap() = session_id.to_string();
        }
        let queued = match crate::snapshot::release_queued(&self.pool, session_id).await {
            Ok(q) => q,
            Err(e) => {
                tracing::warn!("activate_queued_failed session_id={} error={}", session_id, e);
                return false;
            }
        };
        if queued.is_empty() {
            return false;
        }
        // The UI shows only what the user wrote; the turn reads the rest from history.
        let visible: Vec<&db::SessionMessage> = queued.iter().filter(|r| !db::is_attached_row(r)).collect();
        let ids: Vec<String> = visible.iter().map(|r| db::codec::api_uuid(&r.id)).collect();
        let data: Vec<Value> =
            visible.iter().map(|r| json!({"id": db::codec::api_uuid(&r.id), "content": r.content.clone().unwrap_or_default(), "extra": r.extra_json()})).collect();
        self.transition(Transition::Claim);
        self.spawn_turn(TurnOptions { queued_activation_event: Some(json!({"type": "queued_turn_start", "agent": self.name(), "message_ids": ids, "messages": data})), ..opts });
        true
    }

    async fn apply_pending_interaction_mode(&self) {
        let Some(mode) = self.pending_interaction_mode.lock().unwrap().take() else {
            return;
        };
        let sid = self.session_id();
        match interaction_mode::set_mode(&self.pool, &sid, &mode).await {
            Ok((_, true)) => {
                let mut e = Map::new();
                e.insert("interaction_mode".into(), json!(mode));
                self.emit("interaction_mode", None, Some(e));
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("interaction_mode_apply_failed mode={} error={}", mode, e),
        }
    }
}
