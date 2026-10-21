//! Single-agent session runtime — port of `app/agent/session.py`.

use crate::agent::{Agent, RunOptions};
use crate::broadcaster;
use crate::checkpointer::Checkpointer;
use crate::errors::{format_agent_error, AgentError};
use crate::events::{self, Envelope};
use crate::hooks::basic::{CurrentDateHook, MemoryContextHook, QueuedInjectionHook, RuntimeProtocolHook, ToolResultOffloadHook, WorkspaceInstructionsHook};
use crate::hooks::publisher::StreamPublisherHook;
use crate::hooks::summarization::build_summarization_hook;
use crate::hooks::summarization::resolve_prompt_token_threshold;
use crate::hooks::title::build_title_generation_hook;
use crate::hooks::HookRef;
use crate::idle_compaction::{idle_prompt_tokens, should_compact, IDLE_COMPACTION_DELAY};
use crate::interaction_mode;
use crate::loader::{self, ProviderFactory};
use crate::notification;
use crate::stream_store::store;
use crate::util::Event;
use appv3_core::settings::settings;
use appv3_db::{self as db, DbPool, NewMessage};
use appv3_providers::{Kwargs, LlmProvider, ProviderError};
use appv3_tools::{DeniedPaths, ToolRef};
use futures::FutureExt;
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

fn split_provider_model(model_id: Option<&str>) -> Option<(String, String)> {
    let m = model_id?;
    let (p, rest) = m.split_once(':')?;
    if p.is_empty() || rest.is_empty() {
        return None;
    }
    Some((p.to_string(), rest.to_string()))
}

fn forget_provider_credentials(model_id: Option<&str>) {
    let Some((pid, _)) = split_provider_model(model_id) else {
        return;
    };
    let _ = appv3_core::runtime_settings::forget_provider_models(&pid);
    let cache = &settings().cache_dir;
    let file = match pid.as_str() {
        "codex" => Some(cache.join("codex_oauth.json")),
        "copilot" => Some(cache.join("copilot_oauth.json")),
        "grok" => Some(cache.join("grok_oauth.json")),
        _ => None,
    };
    if let Some(f) = file {
        let _ = std::fs::remove_file(f);
    }
}

fn forget_retired_model(model_id: Option<&str>) {
    if let Some((p, m)) = split_provider_model(model_id) {
        let _ = appv3_core::runtime_settings::remove_provider_model(&p, &m);
    }
}

fn provider_error_to_agent(e: ProviderError) -> AgentError {
    match e {
        ProviderError::Unconfigured(m) => AgentError::Unconfigured(m),
        ProviderError::Auth(m) => AgentError::Auth { message: m, status: None, provider: None },
        other => AgentError::Other(other.to_string()),
    }
}

/// Options for one `_run_turn`.
#[derive(Default, Clone)]
pub struct TurnOptions {
    pub force_compaction: bool,
    /// A background compaction started by the idle timer (see
    /// [`crate::idle_compaction`]); it sends no desktop notification.
    pub idle_compaction: bool,
    pub question_resume: bool,
    pub runtime_model: Option<String>,
    pub runtime_thinking_level: Option<String>,
    pub queued_activation_event: Option<Value>,
}

/// `handle_user_message` arguments.
#[derive(Default, Clone)]
pub struct UserMessage {
    pub content: String,
    pub session_id: String,
    pub interrupt: bool,
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
    state: Mutex<String>,
    cancel: Event,
    hard_cancel: Event,
    pub user_message_lock: tokio::sync::Mutex<()>,
    command_lock: tokio::sync::Mutex<()>,
    has_active_turn: AtomicBool,
    /// When a turn last started or ended; the manager counts idle time
    /// from here as well as from the last lookup.
    last_turn_activity: Mutex<std::time::Instant>,
    active_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    turn_generation: tokio::sync::watch::Sender<u64>,
    config_dirty: AtomicBool,
    question_suspended: Mutex<Option<Value>>,
    lead_suspended: Mutex<Option<Value>>,
    last_error: Mutex<Option<String>>,
    pending_interaction_mode: Mutex<Option<String>>,
    is_scheduler_session: AtomicBool,
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
    me: Weak<AgentSession>,
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
            state: Mutex::new("idle".into()),
            cancel: Event::new(),
            hard_cancel: Event::new(),
            user_message_lock: tokio::sync::Mutex::new(()),
            command_lock: tokio::sync::Mutex::new(()),
            has_active_turn: AtomicBool::new(false),
            last_turn_activity: Mutex::new(std::time::Instant::now()),
            active_task: Mutex::new(None),
            turn_generation: tokio::sync::watch::channel(0).0,
            config_dirty: AtomicBool::new(false),
            question_suspended: Mutex::new(None),
            lead_suspended: Mutex::new(None),
            last_error: Mutex::new(None),
            pending_interaction_mode: Mutex::new(None),
            is_scheduler_session: AtomicBool::new(false),
            memory_snapshot: Mutex::new(None),
            idle_timer: Mutex::new(None),
            idle_compaction_delay: Mutex::new(IDLE_COMPACTION_DELAY),
            stop_grace: Mutex::new(STOP_GRACE),
            test_hooks: Mutex::new(vec![]),
            request_frame: Default::default(),
            me: me.clone(),
        })
    }

    // ── accessors ──
    pub fn agent(&self) -> Arc<Agent> {
        self.agent.read().unwrap().clone()
    }

    /// The provider for the session's `model` / `thinking_level` overrides
    /// (from its row), or the agent's own when neither changes anything.
    pub fn resolve_runtime_provider(&self, agent: &Agent, runtime_model: Option<&str>, runtime_thinking: Option<&str>) -> Result<RuntimeProvider, ProviderError> {
        let runtime_model = runtime_model.filter(|m| !m.is_empty());
        let runtime_thinking = runtime_thinking.map(String::from);
        let effective_model = runtime_model.map(String::from).or_else(|| agent.model_id.clone());
        let overridden = runtime_model.is_some_and(|m| Some(m) != agent.model_id.as_deref()) || runtime_thinking.is_some();
        let mut runtime = None;
        if overridden {
            if let Some(em) = effective_model.as_deref().filter(|m| !m.is_empty()) {
                let mut kw = Kwargs::new();
                if let Some(t) = &runtime_thinking {
                    kw.insert("thinking_level".into(), json!(t));
                }
                runtime = Some((self.provider_factory)(Some(em), kw)?);
            }
        }
        // A runtime provider carries only the session's level; the agent's
        // own level applies only to the agent's own provider.
        let thinking_level = if runtime.is_some() { runtime_thinking } else { agent.thinking_level.clone() };
        Ok(RuntimeProvider { effective_model, runtime, thinking_level })
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
    pub(crate) fn injected_tools(&self, sid: &str, name: &str, workspace: &str, agent_mode: &str) -> Vec<ToolRef> {
        let is_lead = self.parent_session_id.is_none();
        let mut injected: Vec<ToolRef> = vec![];
        if !self.is_scheduler_session.load(Ordering::SeqCst) && is_lead {
            injected.push(Arc::new(crate::tools::ask_user::AskUserTool { session_id: sid.to_string(), pool: self.pool.clone(), agent_name: name.to_string() }));
            injected.push(Arc::new(crate::tools::team::DelegateTool {
                lead_session_id: sid.to_string(),
                pool: self.pool.clone(),
                provider_factory: self.provider_factory.clone(),
            }));
            // Sessions without a user workspace keep the plan in the data dir.
            injected.push(Arc::new(crate::tools::plan::PlanTool { session_id: sid.to_string(), coding: agent_mode == "coding" && !workspace.is_empty() }));
            injected.push(Arc::new(crate::tools::plan::SubmitPlanTool { session_id: sid.to_string(), pool: self.pool.clone() }));
            if agent_mode == "coding" && !workspace.is_empty() {
                injected.push(Arc::new(crate::tools::preview::PreviewTool));
            }
        } else if let Some(lead) = &self.parent_session_id {
            injected.push(Arc::new(crate::tools::team::AskLeadTool { lead_session_id: lead.clone(), member_handle: name.to_string() }));
        }
        if is_lead && appv3_core::runtime_settings::workspace_messages_enabled() {
            injected.push(Arc::new(crate::tools::send_to_workspace::SendToWorkspaceTool::new(sid.to_string(), self.pool.clone())));
        }
        injected
    }

    pub(crate) fn request_frame(&self) -> &crate::side_question::FrameSlot {
        &self.request_frame
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
        self.state.lock().unwrap().clone()
    }
    pub(crate) fn set_state(&self, s: &str) {
        *self.state.lock().unwrap() = s.to_string();
    }
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }
    pub fn lead_suspended(&self) -> Option<Value> {
        self.lead_suspended.lock().unwrap().clone()
    }
    pub fn is_busy(&self) -> bool {
        let s = self.state();
        s == "working" || s == "waiting_input" || self.has_active_turn.load(Ordering::SeqCst)
    }
    pub fn has_active_user_turn(&self) -> bool {
        self.has_active_turn.load(Ordering::SeqCst) || self.is_busy()
    }
    pub fn is_awaiting_question_answer(&self) -> bool {
        self.state() == "waiting_input"
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
        while self.has_active_turn.load(Ordering::SeqCst) {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// A stop was requested and the stopped turn is still winding down (a
    /// cancelled tool can take seconds to drain and reap). `cancel` stays set
    /// after the turn ends, so the active turn is what marks the stop pending.
    pub fn is_stopping(&self) -> bool {
        self.cancel.is_set() && self.has_active_turn.load(Ordering::SeqCst)
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

    fn set_active_turn(&self, v: bool) {
        self.has_active_turn.store(v, Ordering::SeqCst);
        *self.last_turn_activity.lock().unwrap() = std::time::Instant::now();
        self.turn_generation.send_modify(|g| *g += 1);
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

    /// Override the idle-compaction delay (tests only).
    #[doc(hidden)]
    pub fn set_idle_compaction_delay(&self, delay: Duration) {
        *self.idle_compaction_delay.lock().unwrap() = delay;
    }

    fn cancel_idle_timer(&self) {
        if let Some(h) = self.idle_timer.lock().unwrap().take() {
            h.abort();
        }
    }

    /// Start the idle-compaction timer for the turn that just completed. The
    /// setting is read when it fires, so enabling it mid-idle still applies.
    fn arm_idle_compaction(&self) {
        let generation = *self.turn_generation.borrow();
        let delay = *self.idle_compaction_delay.lock().unwrap();
        let me = self.me.clone();
        let h = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(s) = me.upgrade() {
                s.try_idle_compaction(generation).await;
            }
        });
        if let Some(old) = self.idle_timer.lock().unwrap().replace(h) {
            old.abort();
        }
    }

    /// Run `/compact` in the background when the session has stayed idle
    /// since the turn that armed the timer and its context reached the
    /// configured share of the compaction trigger.
    async fn try_idle_compaction(&self, generation: u64) {
        if *self.turn_generation.borrow() != generation {
            return;
        }
        // This task is the pending timer; drop its handle so the turn
        // started below does not abort it.
        self.idle_timer.lock().unwrap().take();
        let sid = self.session_id();
        let skip = |reason: &str| tracing::debug!("idle_compaction_skipped session_id={} reason={}", sid, reason);
        let Ok(_guard) = self.user_message_lock.try_lock() else {
            return skip("message_in_flight");
        };
        if sid.is_empty() || *self.turn_generation.borrow() != generation || self.is_busy() || self.state() != "idle" || self.cancel.is_set() {
            return skip("not_idle");
        }
        let cfg = match appv3_core::runtime_settings::load_runtime_settings() {
            Ok(c) => c.summarization,
            Err(e) => {
                tracing::warn!("idle_compaction_settings_failed session_id={} error={}", sid, e);
                return;
            }
        };
        if !cfg.idle_compaction {
            return skip("disabled");
        }
        if crate::subagents::has_working_subagents(&sid) || crate::workspace_messages::has_outstanding_replies(&sid) {
            return skip("awaiting_work");
        }
        if self.has_open_question().await {
            return skip("question_open");
        }
        let history = match crate::history::get_messages_for_llm(&self.pool, &sid).await {
            Ok(h) => h,
            Err(e) => {
                tracing::warn!("idle_compaction_history_failed session_id={} error={}", sid, e);
                return;
            }
        };
        let Some(tokens) = idle_prompt_tokens(&history) else {
            return skip("no_usage_or_compacted");
        };
        let row_model = match db::get_session(&self.pool, &sid).await {
            Ok(Some(r)) => r.model.filter(|m| !m.is_empty()),
            _ => None,
        };
        let model = row_model.or_else(|| self.agent().model_id.clone());
        let threshold = resolve_prompt_token_threshold(model.as_deref(), cfg.prompt_token_threshold);
        let percent = cfg.idle_compaction_percent();
        if !should_compact(tokens, threshold, percent) {
            return skip("below_percent");
        }
        tracing::info!("idle_compaction_started session_id={} tokens={} threshold={} percent={}", sid, tokens, threshold, percent);
        store().init_turn(&sid, true);
        self.set_state("working");
        self.clear_cancel();
        self.set_active_turn(true);
        self.spawn_turn(TurnOptions { force_compaction: true, idle_compaction: true, ..Default::default() });
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
        self.set_state("offline");
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

    async fn has_open_question(&self) -> bool {
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
                    }
                    Ok(None) => {}
                    Err(e) => tracing::warn!("dismiss_pending_question_failed error={}", e),
                }
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("dismiss_pending_question_failed error={}", e),
        }
    }

    /// `handle_user_message` → `(session_id, message_id)`.
    pub async fn handle_user_message(&self, m: UserMessage) -> Result<(String, String), SessionError> {
        let sid = m.session_id.clone();
        let title: Option<String> = if m.content.is_empty() { None } else { Some(m.content.chars().take(100).collect()) };
        self.bind_session(&sid, m.workspace.as_deref(), title.as_deref()).await?;

        if self.has_open_question().await {
            if m.origin != "user" {
                tracing::info!("question_deferred_machine_message session_id={} origin={}", sid, m.origin);
                return Err(SessionError::QuestionPending(sid));
            }
            self.dismiss_pending_question("superseded", None).await;
        }
        if m.interrupt && self.is_busy() {
            self.cancel.set();
            self.dismiss_pending_question("dismissed", None).await;
        }

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
                self.is_scheduler_session.store(row.scheduled_task_name.is_some(), Ordering::SeqCst);
                db::update_session(&self.pool, &sid, upd).await?;
            }
            db::cleanup_reverted_tail(&self.pool, &sid).await?;
            Ok::<(), SessionError>(())
        };
        let (snapshot, prepared) = tokio::join!(crate::snapshot::track(&sid, &ws_dir), prepare);
        prepared?;

        let mut extra = m.extra.clone().unwrap_or_default();
        if let Some(a) = m.attachment_metas.as_ref().filter(|a| !a.is_empty()) {
            extra.insert("attachments".into(), Value::Array(a.clone()));
        }
        if m.model_provided {
            extra.insert("model".into(), m.model.clone().map(Value::String).unwrap_or(Value::Null));
        }
        if m.thinking_level_provided {
            extra.insert("thinking_level".into(), m.thinking_level.clone().map(Value::String).unwrap_or(Value::Null));
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

        store().init_turn(&sid, true);
        self.set_state("working");
        *self.question_suspended.lock().unwrap() = None;
        *self.lead_suspended.lock().unwrap() = None;
        self.clear_cancel();
        self.set_active_turn(true);
        self.spawn_turn(TurnOptions::default());
        Ok((sid, db::codec::api_uuid(&persisted.id)))
    }

    pub async fn handle_stop(&self) -> bool {
        if !self.is_busy() {
            return false;
        }
        self.cancel.set();
        self.hard_cancel.set();
        if self.parent_session_id.is_none() {
            Box::pin(crate::subagents::stop_all_subagents(&self.session_id())).await;
        }
        self.dismiss_pending_question("dismissed", None).await;
        *self.lead_suspended.lock().unwrap() = None;
        self.set_state("idle");
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
        if self.is_busy() {
            return Err(SessionError::precondition("Cannot continue while agent is busy."));
        }
        self.bind_session(session_id, workspace, None).await?;
        store().init_turn(session_id, true);
        self.set_state("working");
        self.clear_cancel();
        self.set_active_turn(true);
        self.spawn_turn(TurnOptions { runtime_model: model, runtime_thinking_level: thinking_level, ..Default::default() });
        Ok((session_id.to_string(), uuid::Uuid::new_v4().to_string()))
    }

    pub async fn handle_compact(&self, session_id: &str, workspace: Option<&str>) -> Result<String, SessionError> {
        if self.is_busy() {
            return Err(SessionError::precondition("Cannot compact while agent is busy."));
        }
        self.bind_session(session_id, workspace, None).await?;
        store().init_turn(session_id, true);
        self.set_state("working");
        self.clear_cancel();
        self.set_active_turn(true);
        self.spawn_turn(TurnOptions { force_compaction: true, ..Default::default() });
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
        self.clear_cancel();
        self.set_active_turn(true);
        self.spawn_turn(TurnOptions {
            queued_activation_event: Some(json!({"type": "queued_turn_start", "agent": self.name(), "message_ids": ids, "messages": data})),
            ..Default::default()
        });
        true
    }

    pub async fn handle_question_answer(&self, question_id: &str, answers: &Value) -> anyhow::Result<()> {
        db::resolve_pending_question(&self.pool, question_id, "answered", Some(answers)).await?;
        self.resume_after_question_answer().await;
        Ok(())
    }

    pub async fn resume_after_question_answer(&self) {
        *self.question_suspended.lock().unwrap() = None;
        *self.lead_suspended.lock().unwrap() = None;
        self.set_state("working");
        self.emit("agent_status", Some("working"), None);
        self.clear_cancel();
        self.set_active_turn(true);
        self.spawn_turn(TurnOptions { question_resume: true, ..Default::default() });
    }

    pub async fn handle_question_dismiss(&self, question_id: &str, reason: &str) -> anyhow::Result<()> {
        db::resolve_pending_question(&self.pool, question_id, normalize_question_status(reason), None).await?;
        *self.question_suspended.lock().unwrap() = None;
        self.set_state("idle");
        self.emit("agent_status", Some("idle"), None);
        Ok(())
    }

    pub async fn end_turn_after_question_dismissed(&self, session_id: &str) -> bool {
        if self.session_id() != session_id {
            return false;
        }
        *self.question_suspended.lock().unwrap() = None;
        if self.state() == "waiting_input" {
            self.set_state("idle");
        }
        self.emit("agent_status", Some("idle"), None);
        if !self.cancel.is_set() && self.activate_queued_user_messages(session_id).await {
            return true;
        }
        self.set_active_turn(false);
        // The user ended the turn by dismissing the question; nothing new to tell them.
        self.close_turn(session_id, "completed", false).await;
        true
    }

    async fn close_turn(&self, session_id: &str, status: &str, notify: bool) {
        store().push_event(session_id, &events::done(Some(json!({"session_id": session_id}))), true);
        store().mark_done(session_id);
        match &self.parent_session_id {
            None => {
                // Requests from other workspaces get their answer first; a
                // final answer wakes the sender, whose turn notifies instead.
                let last_error = self.last_error();
                let replied = crate::workspace_messages::on_turn_closed(&self.pool, session_id, status, self.cancel.is_set(), last_error.as_deref()).await;
                let label = if notify && !replied { self.notification_status(session_id, status) } else { None };
                if let Some(label) = label {
                    broadcaster::publish("desktop_notification", self.completion_notification(session_id, label).await);
                }
            }
            Some(lead) => {
                crate::subagents::on_subagent_turn_completed(lead, session_id, status, &self.workspace(), &self.name(), &self.pool, self.cancel.is_set()).await;
            }
        }
        let mut payload = json!({"session_id": session_id, "status": status});
        if let Some(p) = &self.parent_session_id {
            payload["parent_session_id"] = json!(p);
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

    /// The notification status for a lead turn that just ended, or `None`
    /// when it should not notify: the user stopped it, or subagents are still
    /// working and their reports will run the lead again (that last turn
    /// notifies instead). A failed turn notifies: the user may be away.
    fn notification_status(&self, session_id: &str, status: &str) -> Option<&'static str> {
        if self.cancel.is_set() {
            return None;
        }
        match status {
            "completed" if crate::subagents::has_working_subagents(session_id) => None,
            // A reply from another workspace will run this lead again.
            "completed" if crate::workspace_messages::has_outstanding_replies(session_id) => None,
            "completed" => Some("Done"),
            "error" => Some("Failed"),
            _ => None,
        }
    }

    /// `kind` stays `assistant_done` for a failed turn so clients that only
    /// know the original kinds still show it.
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

    async fn run_turn(self: Arc<Self>, opts: TurnOptions) {
        let sid = self.session_id();
        if !sid.is_empty() {
            store().init_turn(&sid, true);
        }
        self.set_state("working");
        *self.question_suspended.lock().unwrap() = None;
        *self.lead_suspended.lock().unwrap() = None;
        self.emit("agent_status", Some("working"), None);
        if !sid.is_empty() {
            let mut p = json!({"session_id": sid, "started_at": db::codec::py_isoformat(&chrono::Utc::now())});
            if opts.queued_activation_event.is_some() {
                p["source"] = json!("queued_activation");
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
        if self.config_dirty.load(Ordering::SeqCst) {
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
                self.set_state("error");
                let info = format_agent_error(&e, Some(&self.name()));
                *self.last_error.lock().unwrap() = info["message"].as_str().map(String::from);
                let mut data = Map::new();
                for k in ["message", "title", "code", "category"] {
                    data.insert(k.into(), info[k].clone());
                }
                let mut with_meta = data.clone();
                with_meta.insert("metadata".into(), Value::Object(data.clone()));
                self.emit("agent_status", Some("error"), Some(with_meta));
                self.emit("error", None, Some(data));
            }
        }

        // ── finally ──
        let mut activated = false;
        let state = self.state();
        let qs = self.question_suspended.lock().unwrap().clone();
        let ls = self.lead_suspended.lock().unwrap().clone();
        if state == "error" || (qs.is_none() && ls.is_none()) {
            self.apply_pending_interaction_mode().await;
        }
        let sid = self.session_id();
        let errored = state == "error";
        // A background compaction was not asked for, so it never notifies.
        let notify = !opts.idle_compaction;
        let mut completed = false;
        if let Some(q) = qs.as_ref().filter(|_| !errored) {
            self.set_state("waiting_input");
            let mut e = Map::new();
            e.insert("question_id".into(), json!(crate::pystr::py_str(&q["question_id"])));
            self.emit("agent_status", Some("waiting_input"), Some(e));
        } else if let Some(data) = ls.filter(|_| !errored) {
            self.set_state("waiting_lead");
            self.emit("agent_status", Some("waiting_lead"), data.as_object().cloned());
            if let Some(lead) = &self.parent_session_id {
                crate::subagents::on_subagent_question_asked(lead, &sid, &data, &self.pool).await;
            }
        } else if !errored {
            if !sid.is_empty() && !self.cancel.is_set() {
                activated = self.activate_queued_user_messages(&sid).await;
            }
            if !activated {
                self.set_state("idle");
                self.emit("agent_status", Some("idle"), None);
                self.close_turn(&sid, "completed", notify).await;
                completed = true;
            }
        } else {
            self.close_turn(&sid, "error", notify).await;
        }
        if !activated {
            self.set_active_turn(false);
        }
        let lead = self.parent_session_id.is_none() && !self.is_scheduler_session.load(Ordering::SeqCst);
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
        }
        if self.parent_session_id.is_none() {
            let plan_dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
            if let Err(e) = crate::plan::announce_user_edits(&self.pool, &sid, &plan_dir).await {
                tracing::warn!("plan_edit_note_failed session_id={} error={}", sid, e);
            }
        }
        let history = crate::history::get_messages_for_llm(&self.pool, &sid).await.map_err(dberr)?;

        let RuntimeProvider { effective_model, runtime: runtime_provider, thinking_level } =
            self.resolve_runtime_provider(&agent, runtime_model.as_deref(), runtime_thinking.as_deref()).map_err(provider_error_to_agent)?;
        let provider_for_hooks = runtime_provider.clone().unwrap_or_else(|| agent.provider.clone());
        let is_lead = self.parent_session_id.is_none();

        let ws_path = session_workspace_dir(&sid, Some(&workspace));
        let denied = Arc::new(DeniedPaths::new(&ws_path, Some(sid.clone())));
        let memory = self.memory_context().await;
        let mut hooks: Vec<HookRef> = vec![
            Arc::new(CurrentDateHook),
            Arc::new(StreamPublisherHook::new(&sid, &name, true)),
            Arc::new(crate::hooks::otel::OtelHook::new(&name, effective_model.as_deref())),
            Arc::new(crate::hooks::lsp::LspHook { enabled: agent_mode == "coding", denied: denied.clone() }),
            Arc::new(RuntimeProtocolHook),
            Arc::new(MemoryContextHook { content: memory, lead: is_lead }),
        ];
        if is_lead {
            hooks.push(Arc::new(QueuedInjectionHook {
                session_id: sid.clone(),
                agent_name: name.clone(),
                pool: self.pool.clone(),
                support_interrupt: provider_for_hooks.support_interrupt(),
            }));
            if let Some(t) = build_title_generation_hook(provider_for_hooks.clone(), self.pool.clone()) {
                hooks.push(Arc::new(t));
            }
        }
        hooks.push(Arc::new(WorkspaceInstructionsHook::new(Some(&workspace), agent_mode == "coding")));
        hooks.extend(self.test_hooks.lock().unwrap().iter().cloned());
        let checkpointer = Checkpointer::new(self.pool.clone(), Some(sid.clone()), Some(name.clone()));
        checkpointer.mark_loaded(&history);
        hooks.push(Arc::new(ToolResultOffloadHook::default()));
        if is_lead {
            let plan_dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
            if let Some(h) = build_summarization_hook(provider_for_hooks.clone(), agent_mode, effective_model.as_deref(), provider_for_hooks.support_interrupt()) {
                hooks.push(Arc::new(h.with_plan_dir(plan_dir)));
            }
            hooks.push(Arc::new(crate::side_question::RequestFrameHook::new(self.request_frame.clone())));
        }

        let injected = self.injected_tools(&sid, &name, &workspace, agent_mode);

        let mut meta = Map::new();
        meta.insert("session_id".into(), json!(sid));
        meta.insert("interaction_mode".into(), json!(interaction));
        if let Some(t) = thinking_level.filter(|t| !t.is_empty()) {
            meta.insert("thinking_level".into(), json!(t));
        }
        if opts.question_resume {
            meta.insert("question_resume".into(), json!(true));
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
                if let Some(Value::Object(q)) = out.metadata.get("question_suspended") {
                    let mut qs = self.question_suspended.lock().unwrap();
                    if qs.is_none() {
                        *qs = Some(json!({"question_id": q.get("question_id"), "session_id": q.get("session_id")}));
                    }
                }
                if let Some(l @ Value::Object(_)) = out.metadata.get("lead_suspended") {
                    let mut ls = self.lead_suspended.lock().unwrap();
                    if ls.is_none() {
                        *ls = Some(l.clone());
                    }
                }
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
}
