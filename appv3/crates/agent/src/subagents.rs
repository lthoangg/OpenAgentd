//! Subagent coordination (the paths reachable from `team`, session callbacks and the API).

pub(crate) mod report;
pub(crate) mod stall;
mod state;

use crate::agent::Agent;
use crate::broadcaster;
use crate::events::Envelope;
use crate::loader::{self, ProviderFactory, DEFAULT_NEW_USER_MODEL};
use crate::session::{AgentSession, StopCause, UserMessage};
use crate::stream_store::store;
use appv3_core::settings::settings;
use appv3_db::{self as db, DbPool};
use appv3_providers::Kwargs;
use appv3_tools::ToolRef;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use state::MemberEvent;

pub const MAX_CONCURRENT_MEMBERS: usize = 20;
pub const MAX_SUBAGENT_OUTPUT_CHARS: usize = 32_000;
/// How long a member whose report reached its lead stays in memory.
/// Follow-ups mostly come right after a report.
pub const UNLOAD_FINISHED_AFTER: Duration = Duration::from_secs(5 * 60);
/// How long `interrupt` waits for the member's current step to wind down.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(15);

#[derive(Debug, thiserror::Error)]
pub enum SubagentError {
    #[error("{0}")]
    General(String),
    #[error("{0}")]
    Ambiguous(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    MaxConcurrent(String),
}

#[derive(Clone)]
pub struct SubagentInstance {
    pub handle: String,
    pub profile_name: String,
    pub lead_session_id: String,
    pub session_id: String,
    pub session: Arc<AgentSession>,
    /// Its lifecycle; only [`Self::apply`] (`subagents/state.rs`) moves it.
    status: MemberStatus,
    pub last_result: Option<String>,
    pub pending_lead_question: Option<Value>,
    pub last_error: Option<String>,
    pub question_delivered: bool,
    pub result_delivered: bool,
    pub pending_tool_call_id: Option<String>,
    /// Why the member can't reach its model right now (it keeps retrying).
    pub stall: Option<String>,
    /// When its current work started (spawn, or the last message sent to it).
    pub working_since: Option<std::time::Instant>,
    /// A server restart cut its turn off; the next message resumes it.
    pub stopped_by_restart: bool,
    /// When its completed turn's report reached the lead; unset while it works.
    reported_at: Option<std::time::Instant>,
}

impl SubagentInstance {
    pub fn new(handle: &str, profile: &str, lead: &str, session_id: &str, session: Arc<AgentSession>, status: MemberStatus) -> Self {
        Self {
            handle: handle.into(),
            profile_name: profile.into(),
            lead_session_id: lead.into(),
            session_id: session_id.into(),
            session,
            status,
            last_result: None,
            pending_lead_question: None,
            last_error: None,
            question_delivered: false,
            result_delivered: false,
            pending_tool_call_id: None,
            stall: None,
            working_since: (status == MemberStatus::Working).then(std::time::Instant::now),
            stopped_by_restart: false,
            reported_at: None,
        }
    }

    pub fn status(&self) -> MemberStatus {
        self.status
    }

    /// `ask_lead` suspends its turn on `question`: it waits for the lead's
    /// answer, which arrives through [`send_subagent_message`].
    pub fn wait_on_lead(&mut self, question: Value, tool_call_id: Option<String>) {
        let _ = self.apply(MemberEvent::AskLead { question, tool_call_id });
    }

    /// The lead sent it new work: it is working again, and nothing is owed
    /// from its earlier turns.
    fn start_follow_up(&mut self) {
        let _ = self.apply(MemberEvent::FollowUp);
    }

    /// Whether it can leave memory at `now`: its turn completed, the report
    /// reached the lead [`UNLOAD_FINISHED_AFTER`] ago, and nobody is sending
    /// it a message. A member that failed, was stopped or waits on its lead
    /// stays: only the registry holds its error, question and resume state.
    fn unload_due(&self, now: std::time::Instant) -> bool {
        self.status == MemberStatus::Completed
            && self.reported_at.is_some_and(|t| now.saturating_duration_since(t) >= UNLOAD_FINISHED_AFTER)
            && !self.session.is_busy()
            && self.session.user_message_lock.try_lock().is_ok()
    }
}

/// A member's lifecycle as the registry records it. The registry owns this
/// and report delivery; the member's `AgentSession` owns execution (whether
/// a turn runs). [`MemberStatus::as_str`] is the string the API, SSE
/// `subagent_status` and `team(action='list')` show.
/// A member missing from the registry (it was unloaded after it finished,
/// or a restart emptied the registry) is listed as [`UNREGISTERED_MEMBER_STATUS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberStatus {
    Working,
    /// Suspended on `ask_lead`: its turn stays open until the lead answers.
    WaitingLead,
    /// Its last turn completed and the report went to the lead.
    Completed,
    /// Its last turn failed (or was refused) and the failure went to the lead.
    Error,
    /// Stopped by the lead or a restart; no report. A message resumes it.
    Stopped,
}

/// The status of a member the registry does not hold, in every list and when
/// it is loaded back: its work is over as far as this process knows.
pub const UNREGISTERED_MEMBER_STATUS: MemberStatus = MemberStatus::Completed;

impl MemberStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::WaitingLead => "waiting_lead",
            Self::Completed => "completed",
            Self::Error => "error",
            Self::Stopped => "stopped",
        }
    }

    /// How a member's closed turn ends: stopped (cancelled), completed, or failed.
    /// `status` is the session's turn status: anything but `completed` failed.
    pub fn turn_end(status: &str, cancelled: bool) -> Self {
        if cancelled {
            Self::Stopped
        } else if status == "completed" {
            Self::Completed
        } else {
            Self::Error
        }
    }

    /// Whether a turn that ended this way reports to the lead. A stopped turn
    /// sends nothing; the member keeps its conversation.
    pub fn reports(self) -> bool {
        matches!(self, Self::Completed | Self::Error)
    }

    /// Whether the member holds a turn the lead is owed an end for: working,
    /// or suspended on `ask_lead`. Stopping it settles it as stopped.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Working | Self::WaitingLead)
    }

    /// Whether a turn may still run, so dropping the member must stop its
    /// session. Only a reported end (completed, error) rules that out.
    pub fn may_still_run(self) -> bool {
        !self.reports()
    }

    /// The member's status once a turn ended as `self`. A completed turn's
    /// last look at the queue starts a follow-up queued for it, so with one
    /// queued the member is still working; failed and stopped turns leave
    /// the queue alone.
    pub fn after_turn(self, follow_up_queued: bool) -> Self {
        if self == Self::Completed && follow_up_queued {
            Self::Working
        } else {
            self
        }
    }

    /// Whether a follow-up queued behind the member's running turn will run
    /// next, given the status the registry holds after the queueing: the
    /// turn is still running (`Working`) or closed as completed and has yet
    /// to look at the queue. A failed or stopped close never reads it.
    fn follow_up_runs_next(self) -> bool {
        matches!(self, Self::Working | Self::Completed)
    }
}

#[derive(Default)]
struct Registry {
    live: HashMap<String, BTreeMap<String, SubagentInstance>>,
    /// Insertion order of handles per lead (Python dict order).
    order: HashMap<String, Vec<String>>,
    counters: HashMap<String, HashMap<String, i64>>,
    reconciled: HashSet<String>,
}

fn reg() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Run `f` on a live instance (by lead + handle) if present.
pub fn with_instance<R>(lead: &str, handle: &str, f: impl FnOnce(&mut SubagentInstance) -> R) -> Option<R> {
    let mut r = reg().lock().unwrap();
    r.live.get_mut(lead).and_then(|m| m.get_mut(handle)).map(f)
}

fn find_by_session<R>(lead: &str, child: &str, f: impl FnOnce(&mut SubagentInstance) -> R) -> Option<R> {
    let mut r = reg().lock().unwrap();
    r.live.get_mut(lead).and_then(|m| m.values_mut().find(|i| i.session_id == child)).map(f)
}

/// Whether a subagent of `lead` is still running. Its report will start
/// another lead turn, so the lead's work is not finished yet. A subagent that
/// just ended is already marked done before its report reaches the lead.
pub fn has_working_subagents(lead: &str) -> bool {
    let r = reg().lock().unwrap();
    r.live.get(lead).is_some_and(|m| m.values().any(|i| i.status == MemberStatus::Working && i.session.is_busy()))
}

/// Every lead with a subagent still running ([`has_working_subagents`]), as
/// API ids.
pub fn leads_with_working_subagents() -> HashSet<String> {
    let r = reg().lock().unwrap();
    r.live.iter().filter(|(_, m)| m.values().any(|i| i.status == MemberStatus::Working && i.session.is_busy())).map(|(lead, _)| db::codec::api_uuid(lead)).collect()
}

/// The subagents of `lead` still running ([`has_working_subagents`]), as
/// `(handle, session id)` in handle order.
pub fn working_members(lead: &str) -> Vec<(String, String)> {
    let r = reg().lock().unwrap();
    r.live
        .get(lead)
        .map(|m| m.values().filter(|i| i.status == MemberStatus::Working && i.session.is_busy()).map(|i| (i.handle.clone(), db::codec::api_uuid(&i.session_id))).collect())
        .unwrap_or_default()
}

/// Whether a lead whose turn ended still has work coming back to it: a
/// subagent still running, a reply another workspace still owes it, or a
/// background command it waits for. Each starts another lead turn, so the
/// lead is not finished yet.
pub fn has_pending_work(lead: &str) -> bool {
    has_working_subagents(lead) || crate::workspace_messages::has_outstanding_replies(lead) || crate::background_commands::has_waited(lead)
}

/// Every session [`has_pending_work`], as API ids.
pub fn sessions_with_pending_work() -> HashSet<String> {
    let mut ids = leads_with_working_subagents();
    ids.extend(crate::workspace_messages::sessions_with_outstanding_replies());
    ids.extend(crate::background_commands::sessions_waiting());
    ids
}

/// Subagent sessions suspended on `ask_lead`, as API ids. Their turn is
/// still open (the stream store counts them as running), but they are
/// waiting on the lead, not working: session rows report them as
/// `needs_input`, the lead being who must answer.
pub fn subagents_waiting_on_lead() -> HashSet<String> {
    let r = reg().lock().unwrap();
    r.live.values().flat_map(|m| m.values()).filter(|i| i.status == MemberStatus::WaitingLead).map(|i| db::codec::api_uuid(&i.session_id)).collect()
}

/// The runtime's rules for every member, appended to its own prompt. It
/// holds the communication rules, so member prompts don't repeat them.
pub fn team_context(handle: &str, role: &str) -> String {
    format!(
        "## Team Context\nYou are instance **{handle}** (role: {role}), working for the lead agent. You see only the task the lead sent, not its conversation.\n\
         - Return your final deliverable in your response text. The lead receives at most {} characters of it, so keep it well under that: lead with the answer, and cite `path:line` instead of pasting large blocks.\n\
         - If you are blocked by ambiguity or need a decision, use `ask_lead`.\n\
         - You do not communicate with other members or the user.",
        appv3_core::pystr::thousands(MAX_SUBAGENT_OUTPUT_CHARS)
    )
}

pub fn parse_instance_handle(handle: &str) -> Option<(String, i64)> {
    let (p, n) = handle.trim().rsplit_once('#')?;
    if p.is_empty() || p.contains('#') || n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((p.to_string(), n.parse().ok()?))
}

async fn reconcile_lead_instances(lead: &str, pool: &DbPool) -> anyhow::Result<()> {
    if reg().lock().unwrap().reconciled.contains(lead) {
        return Ok(());
    }
    let children = db::list_child_sessions(pool, &[lead.to_string()]).await?;
    let mut r = reg().lock().unwrap();
    let counters = r.counters.entry(lead.to_string()).or_default();
    for c in children {
        if let Some((p, n)) = c.agent_name.as_deref().filter(|s| !s.is_empty()).and_then(parse_instance_handle) {
            let cur = *counters.get(&p).unwrap_or(&1);
            counters.insert(p, cur.max(n + 1));
        }
    }
    r.reconciled.insert(lead.to_string());
    Ok(())
}

fn allocate_instance_handle(lead: &str, profile: &str) -> String {
    let mut r = reg().lock().unwrap();
    let counters = r.counters.entry(lead.to_string()).or_default();
    let next = *counters.get(profile).unwrap_or(&1);
    counters.insert(profile.to_string(), next + 1);
    format!("{profile}#{next}")
}

fn py_list(items: &[String]) -> String {
    crate::pystr::py_repr(&json!(items))
}

/// `resolve_instance` → handle.
pub fn resolve_instance(lead: &str, target: &str) -> Result<String, SubagentError> {
    let r = reg().lock().unwrap();
    let empty = BTreeMap::new();
    let instances = r.live.get(lead).unwrap_or(&empty);
    let t = target.trim();
    if instances.contains_key(t) {
        return Ok(t.to_string());
    }
    let order = r.order.get(lead).cloned().unwrap_or_default();
    let matching: Vec<String> = order.iter().filter(|h| instances.get(*h).map(|i| i.profile_name == t).unwrap_or(false)).cloned().collect();
    if matching.len() == 1 {
        return Ok(matching[0].clone());
    }
    if matching.len() > 1 {
        return Err(SubagentError::Ambiguous(format!("Multiple live instances for '{t}': {}. Address one explicitly (e.g. '{}').", py_list(&matching), matching[0])));
    }
    let available: Vec<String> = instances.keys().cloned().collect();
    let avail = if available.is_empty() { "None".to_string() } else { py_list(&available) };
    Err(SubagentError::NotFound(format!("Member '{t}' not found. Live instances: {avail}.")))
}

pub fn agents_dir() -> std::path::PathBuf {
    appv3_tools::denied::resolve(&settings().agents_dir)
}

/// Tools given to a member agent: the ones its file lists that a member
/// may have (`tool_registry::member_tool`), then the ones every agent gets.
fn build_member_tools(allowed: &[String]) -> Vec<ToolRef> {
    let mut out: Vec<ToolRef> = vec![];
    let mut seen = HashSet::new();
    for n in allowed {
        let Some(t) = crate::tool_registry::member_tool(n) else { continue };
        if seen.insert(n.clone()) {
            out.push(t);
        }
    }
    for t in crate::tool_registry::member_always_tools() {
        if seen.insert(t.name().to_string()) {
            out.push(t);
        }
    }
    out
}

fn publish_both(lead: &str, event: &str, payload: Value) {
    broadcaster::publish(event, payload.clone());
    store().push_event(lead, &Envelope::from_parts(event, payload), true);
}

/// A member whose turn was refused never runs, so nothing else will report
/// it: record the failure, or it stays listed as working for good.
fn mark_turn_refused(lead: &str, handle: &str, child: &str, error: &str) {
    with_instance(lead, handle, |i| {
        let _ = i.apply(MemberEvent::Refused { error: error.to_string() });
    });
    publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child, "handle": handle, "status": MemberStatus::Error.as_str()}));
}

/// The model a member runs on when the lead names none: its profile's own
/// model, else the lead's, else the default.
fn member_model(cfg: &loader::AgentConfig, lead_model: Option<String>) -> String {
    if let Some(m) = cfg.model.clone().filter(|m| !m.is_empty() && m != DEFAULT_NEW_USER_MODEL) {
        m
    } else if let Some(m) = lead_model.filter(|m| !m.is_empty()) {
        m
    } else {
        cfg.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_NEW_USER_MODEL.into())
    }
}

/// Build a member's agent session (prompt, tools, model) on `child_sid`.
#[allow(clippy::too_many_arguments)]
fn build_member_session(
    handle: &str,
    cfg: &loader::AgentConfig,
    model: &str,
    thinking: Option<&str>,
    allowed: &[String],
    child_sid: &str,
    workspace: &str,
    lead: &str,
    pool: &DbPool,
    factory: &ProviderFactory,
) -> Result<Arc<AgentSession>, SubagentError> {
    let member_tools = build_member_tools(allowed);
    let system_prompt = format!("{}\n\n{}", cfg.system_prompt.trim(), team_context(handle, &cfg.role));
    let mut kw = Kwargs::new();
    if let Some(t) = thinking {
        kw.insert("thinking_level".into(), json!(t));
    }
    let provider = factory(Some(model), kw).map_err(|e| SubagentError::General(e.to_string()))?;
    let mut agent = Agent::new(provider, handle, &system_prompt, member_tools, Some(model.to_string()));
    agent.description = cfg.description.clone();
    agent.thinking_level = thinking.map(String::from);
    Ok(AgentSession::new(agent, Some(child_sid.to_string()), Some(workspace.to_string()), pool.clone(), factory.clone(), Some(lead.to_string())))
}

/// Bring back an earlier member of `lead` that is not in the live list (it
/// was unloaded after it finished, or a server restart emptied the list),
/// from its saved session: same handle, same session, full transcript. One a
/// restart cut off is listed as stopped until a message starts it. `NotFound`
/// when the lead never had a member by that handle.
pub async fn rehydrate_member(lead: &str, handle: &str, pool: &DbPool, factory: &ProviderFactory, stopped_by_restart: bool) -> Result<String, SubagentError> {
    let handle = handle.trim();
    if with_instance(lead, handle, |_| ()).is_some() {
        return Ok(handle.to_string());
    }
    let not_found = || SubagentError::NotFound(format!("Member '{handle}' not found."));
    let Some((profile, _)) = parse_instance_handle(handle) else { return Err(not_found()) };
    let err = |e: anyhow::Error| SubagentError::General(e.to_string());
    reconcile_lead_instances(lead, pool).await.map_err(err)?;
    let children = db::list_child_sessions(pool, &[lead.to_string()]).await.map_err(err)?;
    // The newest one, should a handle ever have been reused.
    let Some(row) = children.into_iter().filter(|c| c.agent_name.as_deref() == Some(handle)).max_by(|a, b| a.created_at.cmp(&b.created_at)) else {
        return Err(not_found());
    };
    let child_sid = db::codec::api_uuid(&row.id);
    let profiles = loader::load_member_profiles(&agents_dir());
    let Some(cfg) = profiles.iter().find(|(n, _)| *n == profile).map(|(_, c)| c.clone()) else {
        return Err(SubagentError::General(format!(
            "{handle}'s profile '{profile}' no longer exists, so it cannot be resumed. Delegate the task to another profile, or do it yourself."
        )));
    };
    let workspace = if row.workspace.is_empty() { std::env::current_dir().unwrap_or_default().display().to_string() } else { row.workspace.clone() };
    let status = if stopped_by_restart { MemberStatus::Stopped } else { UNREGISTERED_MEMBER_STATUS };
    let thinking = row.thinking_level.clone().filter(|s| !s.is_empty()).or_else(|| cfg.thinking_level.clone().filter(|s| !s.is_empty()));
    let saved_model = row.model.clone().filter(|m| !m.is_empty());
    let session = match saved_model.as_deref().map(|m| build_member_session(handle, &cfg, m, thinking.as_deref(), &cfg.tools, &child_sid, &workspace, lead, pool, factory)) {
        Some(Ok(s)) => s,
        // Its model is gone from the config: pick one the way a spawn does.
        _ => {
            let lead_model = db::get_session(pool, lead).await.ok().flatten().and_then(|r| r.model);
            let model = member_model(&cfg, lead_model);
            build_member_session(handle, &cfg, &model, thinking.as_deref(), &cfg.tools, &child_sid, &workspace, lead, pool, factory)?
        }
    };
    {
        let mut r = reg().lock().unwrap();
        let live = r.live.entry(lead.to_string()).or_default();
        if live.contains_key(handle) {
            return Ok(handle.to_string());
        }
        let mut inst = SubagentInstance::new(handle, &profile, lead, &child_sid, session, status);
        inst.stopped_by_restart = stopped_by_restart;
        live.insert(handle.to_string(), inst);
        let order = r.order.entry(lead.to_string()).or_default();
        if !order.iter().any(|h| h == handle) {
            order.push(handle.to_string());
        }
    }
    tracing::info!("subagent_rehydrated lead={} handle={} session_id={}", lead, handle, child_sid);
    publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child_sid, "handle": handle, "status": status.as_str(), "workspace": workspace}));
    Ok(handle.to_string())
}

/// [`resolve_instance`], bringing back an earlier member named by its exact
/// handle when the live list no longer has it.
async fn resolve_or_rehydrate(lead: &str, target: &str, pool: &DbPool) -> Result<String, SubagentError> {
    let missing = match resolve_instance(lead, target) {
        Err(SubagentError::NotFound(m)) => m,
        other => return other,
    };
    let Some(factory) = crate::manager::try_provider_factory() else { return Err(SubagentError::NotFound(missing)) };
    match rehydrate_member(lead, target, pool, &factory, false).await {
        Err(SubagentError::NotFound(_)) => Err(SubagentError::NotFound(missing)),
        other => other,
    }
}

/// `extra` on a row the lead sends a member: UI metadata linking the row back
/// to the lead (`from_lead.session_id`, the API form of the id, the route the
/// client opens). Not `from_agent`: that makes a row a report, and the model
/// reads it under a `[handle]:` header.
fn from_lead_extra(lead: &str) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("from_lead".into(), json!({"session_id": db::codec::api_uuid(lead)}));
    extra
}

/// Start a new member of `lead` on `task`, in the background: its profile
/// gives the tools, and the model when it names one (else the lead's).
pub async fn spawn_subagent(lead: &str, profile: &str, task: &str, workspace: &str, pool: &DbPool, factory: &ProviderFactory) -> Result<Value, SubagentError> {
    let err = |e: anyhow::Error| SubagentError::General(e.to_string());
    reconcile_lead_instances(lead, pool).await.map_err(err)?;
    {
        let r = reg().lock().unwrap();
        let active = r.live.get(lead).map(|m| m.values().filter(|i| i.status == MemberStatus::Working).count()).unwrap_or(0);
        if active >= MAX_CONCURRENT_MEMBERS {
            return Err(SubagentError::MaxConcurrent(format!("Reached maximum concurrent members limit ({MAX_CONCURRENT_MEMBERS}).")));
        }
    }
    let profiles = loader::load_member_profiles(&agents_dir());
    let Some(cfg) = profiles.iter().find(|(n, _)| n == profile).map(|(_, c)| c.clone()) else {
        let mut names: Vec<String> = profiles.iter().map(|(n, _)| n.clone()).collect();
        names.sort();
        return Err(SubagentError::General(format!("Profile '{profile}' not found. Available member profiles: {}.", py_list(&names))));
    };
    let lead_row = db::get_session(pool, lead).await.map_err(err)?;
    let (lead_model, lead_mode, lead_thinking) = match &lead_row {
        Some(r) => (r.model.clone(), Some(r.interaction_mode.clone()), r.thinking_level.clone()),
        None => (None, None, None),
    };
    let handle = allocate_instance_handle(lead, profile);
    let child_uuid = uuid::Uuid::now_v7();
    let child_sid = child_uuid.to_string();
    let effective_model = member_model(&cfg, lead_model);
    let effective_thinking = cfg.thinking_level.clone().filter(|s| !s.is_empty()).or(lead_thinking);
    let child = build_member_session(&handle, &cfg, &effective_model, effective_thinking.as_deref(), &cfg.tools, &child_sid, workspace, lead, pool, factory)?;

    let clean_task = task.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = format!("{handle}: {}", clean_task.chars().take(60).collect::<String>());
    db::create_session(
        pool,
        db::NewSession {
            id: Some(child_uuid),
            parent_session_id: Some(lead.to_string()),
            agent_name: Some(handle.clone()),
            title: Some(title.clone()),
            workspace: workspace.to_string(),
            model: Some(effective_model.clone()),
            thinking_level: effective_thinking.clone(),
            interaction_mode: Some(lead_mode.filter(|m| !m.is_empty()).unwrap_or_else(|| "code".into())),
            ..Default::default()
        },
    )
    .await
    .map_err(err)?;
    {
        let mut r = reg().lock().unwrap();
        r.live.entry(lead.to_string()).or_default().insert(handle.clone(), SubagentInstance::new(&handle, profile, lead, &child_sid, child.clone(), MemberStatus::Working));
        let order = r.order.entry(lead.to_string()).or_default();
        if !order.contains(&handle) {
            order.push(handle.clone());
        }
    }
    tracing::info!("subagent_spawned lead={} handle={} profile={} session_id={}", lead, handle, profile, child_sid);
    publish_both(
        lead,
        "subagent_spawned",
        json!({"lead_session_id": lead, "session_id": child_sid, "handle": handle, "profile": profile, "workspace": workspace, "title": title, "status": MemberStatus::Working.as_str(), "running": true}),
    );
    if let Err(e) = child
        .handle_user_message(UserMessage {
            content: format!("[Task from Lead]: {task}"),
            session_id: child_sid.clone(),
            workspace: Some(workspace.to_string()),
            origin: "agent".into(),
            extra: Some(from_lead_extra(lead)),
            ..Default::default()
        })
        .await
    {
        mark_turn_refused(lead, &handle, &child_sid, &e.to_string());
        return Err(SubagentError::General(e.to_string()));
    }
    Ok(json!({"status": "spawned", "member_id": handle, "profile": profile, "session_id": child_sid, "message": format!("Subagent '{handle}' spawned in background.")}))
}

/// `send_subagent_message(..., wait=False)`.
pub async fn send_subagent_message(lead: &str, member_id: &str, message: &str, pool: &DbPool) -> Result<Value, SubagentError> {
    let handle = resolve_or_rehydrate(lead, member_id, pool).await?;
    // A member waiting on `ask_lead` takes the message as its answer and is
    // working again at once. Any other member is marked working only once the
    // message is queued or its turn is starting (below): its running turn may
    // close in between, and that close must not overwrite the follow-up.
    let (inst_session, waiting, tool_call_id, child_sid) = with_instance(lead, &handle, |i| {
        let waiting = i.status == MemberStatus::WaitingLead;
        let tcid = i.pending_tool_call_id.clone();
        if waiting {
            i.start_follow_up();
            i.pending_lead_question = None;
        }
        (i.session.clone(), waiting, tcid, i.session_id.clone())
    })
    .ok_or_else(|| SubagentError::NotFound(format!("Member '{member_id}' not found.")))?;
    if waiting {
        let tcid = tool_call_id.or_else(|| inst_session.lead_suspended().and_then(|l| l.get("tool_call_id").and_then(|v| v.as_str()).map(String::from)));
        if let Some(t) = tcid.filter(|t| !t.is_empty()) {
            // A fresh `seq` puts the answer right after the waiting call.
            db::save_message(pool, &child_sid, db::NewMessage::tool(t, "ask_lead", format!("Lead answered: {message}")))
                .await
                .map_err(|e| SubagentError::General(e.to_string()))?;
        }
        inst_session.resume_after_question_answer().await;
        return Ok(json!({"status": "sent", "member_id": handle, "message": format!("Message delivered to '{handle}' in background.")}));
    }
    let content = format!("[Lead]: {message}");
    let _g = inst_session.user_message_lock.lock().await;
    // A member still working reads the follow-up when its turn ends. Starting
    // a turn beside it left one of the two running unseen: the session read
    // idle once the other ended, so Stop and deleting the lead skipped it.
    let queued = inst_session.has_active_user_turn();
    if queued {
        db::save_queued_user_message(pool, &child_sid, &content, Some(from_lead_extra(lead))).await.map_err(|e| SubagentError::General(e.to_string()))?;
        // The turn may have ended between the check and the save.
        if inst_session.has_active_user_turn() {
            // Saved under the lock the turn's last look at the queue takes:
            // that look starts it unless the turn failed or was stopped.
            with_instance(lead, &handle, |i| {
                if i.status.follow_up_runs_next() {
                    i.start_follow_up();
                }
            });
        } else {
            with_instance(lead, &handle, SubagentInstance::start_follow_up);
            inst_session.activate_queued_user_messages(&child_sid).await;
        }
    } else {
        // No turn runs, so no close can race this mark; the new turn's own
        // close comes after it.
        if with_instance(lead, &handle, SubagentInstance::start_follow_up).is_none() {
            // It left the list between the lookup and the lock (unloaded, or
            // its session was deleted): look it up again.
            drop(_g);
            return Box::pin(send_subagent_message(lead, &handle, message, pool)).await;
        }
        if let Err(e) = inst_session
            .handle_user_message(UserMessage { content, session_id: child_sid.clone(), origin: "agent".into(), extra: Some(from_lead_extra(lead)), ..Default::default() })
            .await
        {
            mark_turn_refused(lead, &handle, &child_sid, &e.to_string());
            return Err(SubagentError::General(e.to_string()));
        }
    }
    Ok(json!({"status": "sent", "member_id": handle, "queued": queued, "message": format!("Message delivered to '{handle}' in background.")}))
}

/// Stop one member's turn. It sends no report, and keeps its conversation:
/// the next message sent to it resumes with full context.
pub async fn stop_subagent(lead: &str, member_id: &str, pool: &DbPool) -> Result<Value, SubagentError> {
    let handle = match resolve_instance(lead, member_id) {
        // Unloaded after it finished: nothing of it runs.
        Err(SubagentError::NotFound(_)) if saved_handles(lead, pool).await.iter().any(|h| h == member_id.trim()) => {
            return Ok(json!({"status": UNREGISTERED_MEMBER_STATUS.as_str(), "member_id": member_id.trim(), "was_running": false}));
        }
        other => other?,
    };
    let (session, child, status) =
        with_instance(lead, &handle, |i| (i.session.clone(), i.session_id.clone(), i.status)).ok_or_else(|| SubagentError::NotFound(format!("Member '{member_id}' not found.")))?;
    let ran = session.handle_stop().await;
    let active = ran || status.is_active();
    if !ran && status == MemberStatus::WaitingLead {
        // Its turn stayed open while it waited on `ask_lead`; nothing else
        // will close it now, so clients would keep showing it running.
        store().push_event(&child, &Envelope::from_parts("done", json!({})), true);
        store().mark_done(&child);
        broadcaster::publish("session_turn_completed", json!({"session_id": child, "status": "stopped", "parent_session_id": lead}));
    }
    with_instance(lead, &handle, |i| {
        if active {
            let _ = i.apply(MemberEvent::Stop);
        } else {
            i.settle_stopped();
        }
    });
    if active {
        publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child, "handle": handle, "status": MemberStatus::Stopped.as_str()}));
    }
    tracing::info!("subagent_stopped lead={} handle={} was_running={}", lead, handle, active);
    let status = if active { MemberStatus::Stopped } else { status };
    Ok(json!({"status": status.as_str(), "member_id": handle, "was_running": active}))
}

/// Cut a member's current step short and start it on `message` at once. The
/// interrupted turn sends no report; the new message's turn does. A member
/// waiting on `ask_lead` takes `message` as the answer.
pub async fn interrupt_subagent(lead: &str, member_id: &str, message: &str, pool: &DbPool) -> Result<Value, SubagentError> {
    let handle = resolve_or_rehydrate(lead, member_id, pool).await?;
    let (session, waiting) = with_instance(lead, &handle, |i| (i.session.clone(), i.status == MemberStatus::WaitingLead))
        .ok_or_else(|| SubagentError::NotFound(format!("Member '{member_id}' not found.")))?;
    if waiting {
        return send_subagent_message(lead, &handle, message, pool).await;
    }
    let ran = session.handle_stop().await;
    if !session.wait_for_stop(INTERRUPT_SETTLE).await {
        return Err(SubagentError::General(format!("'{handle}' is still winding down its interrupted step. Try again in a moment.")));
    }
    let mut out = send_subagent_message(lead, &handle, message, pool).await?;
    out["interrupted"] = json!(ran);
    tracing::info!("subagent_interrupted lead={} handle={} was_running={}", lead, handle, ran);
    Ok(out)
}

/// The handle of every member `lead` ever had, oldest first, from their
/// saved sessions.
async fn saved_handles(lead: &str, pool: &DbPool) -> Vec<String> {
    match db::list_child_sessions(pool, &[lead.to_string()]).await {
        Ok(rows) => rows.into_iter().filter_map(|c| c.agent_name).filter(|h| parse_instance_handle(h).is_some()).collect(),
        Err(e) => {
            tracing::warn!("subagent_saved_handles_failed lead={} error={}", lead, e);
            vec![]
        }
    }
}

/// One line per member the lead can address, for `team(action='list')`,
/// oldest first: the loaded ones with their state, and the ones no longer in
/// memory as done (a message to one loads it back).
pub async fn describe_subagents(lead: &str, pool: &DbPool) -> String {
    let saved = saved_handles(lead, pool).await;
    let r = reg().lock().unwrap();
    let none = BTreeMap::new();
    let live = r.live.get(lead).unwrap_or(&none);
    let order = r.order.get(lead).cloned().unwrap_or_default();
    let unsaved = order.iter().chain(live.keys().filter(|h| !order.contains(h))).filter(|h| live.contains_key(*h) && !saved.contains(h));
    let handles = saved.iter().chain(unsaved);
    let lines: Vec<String> = handles
        .map(|h| {
            let Some(i) = live.get(h) else { return format!("- {h}: done (send it a task to continue)") };
            let state = match i.status {
                MemberStatus::Working => {
                    let since = i.working_since.map(|t| format!(" for {}", crate::retry::format_duration(t.elapsed().as_secs_f64()))).unwrap_or_default();
                    match &i.stall {
                        Some(s) => format!("working{since}, stalled: {s}"),
                        None => format!("working{since}"),
                    }
                }
                MemberStatus::WaitingLead => {
                    let q = i.pending_lead_question.as_ref().and_then(|q| q.get("question")).and_then(Value::as_str).unwrap_or("");
                    if q.is_empty() {
                        "waiting for your answer".to_string()
                    } else {
                        format!("waiting for your answer: {q}")
                    }
                }
                MemberStatus::Error => format!("failed: {}", i.last_error.as_deref().filter(|e| !e.is_empty()).unwrap_or("unknown error")),
                MemberStatus::Stopped if i.stopped_by_restart => "stopped by a server restart (send it a task to resume)".to_string(),
                MemberStatus::Stopped => "stopped (send it a task to resume)".to_string(),
                MemberStatus::Completed => "done (report delivered)".to_string(),
            };
            format!("- {}: {state}", i.handle)
        })
        .collect();
    if lines.is_empty() {
        return "No subagents yet.".into();
    }
    lines.join("\n")
}

/// Drop from memory every member that can leave it at `now`
/// ([`SubagentInstance::unload_due`]), and return how many left. Its saved
/// session stays, so it is still listed as done and a message to its handle
/// loads it back ([`rehydrate_member`]). Handle counters stay too: a new
/// member never takes an earlier one's handle.
pub async fn unload_finished(now: std::time::Instant) -> usize {
    let dropped: Vec<SubagentInstance> = {
        let mut guard = reg().lock().unwrap();
        let r = &mut *guard;
        let mut out = vec![];
        for (lead, members) in r.live.iter_mut() {
            let due: Vec<String> = members.iter().filter(|(_, i)| i.unload_due(now)).map(|(h, _)| h.clone()).collect();
            if let Some(order) = r.order.get_mut(lead) {
                order.retain(|h| !due.contains(h));
            }
            out.extend(due.iter().filter_map(|h| members.remove(h)));
        }
        r.live.retain(|_, members| !members.is_empty());
        out
    };
    for i in &dropped {
        // Ends its timers, so nothing keeps the session alive.
        i.session.stop().await;
        tracing::info!("subagent_unloaded lead={} handle={} session_id={}", i.lead_session_id, i.handle, i.session_id);
    }
    dropped.len()
}

/// `list_subagents`.
pub async fn list_subagents(lead: &str, pool: &DbPool) -> Value {
    let mut profiles = loader::load_member_profiles(&agents_dir());
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    let summaries: Vec<Value> = profiles.iter().map(|(n, p)| json!({"name": n, "description": p.description, "tools": p.tools})).collect();
    let live: BTreeMap<String, SubagentInstance> = reg().lock().unwrap().live.get(lead).cloned().unwrap_or_default();
    let mut members: Vec<Value> = vec![];
    let mut seen = HashSet::new();
    if let Ok(rows) = db::list_child_sessions(pool, &[lead.to_string()]).await {
        for row in rows {
            let handle = row.agent_name.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| db::codec::api_uuid(&row.id));
            seen.insert(handle.clone());
            let (status, last_error, pending) = match live.get(&handle) {
                // The status is the member's lifecycle as its turns report
                // it. No turn task is not "done": a member is listed working
                // before its first turn spawns (the web refetches on
                // `subagent_spawned`), and inferring completion there kept the
                // lead off the active list while its members still worked.
                Some(i) => (i.status, i.last_error.clone(), i.pending_lead_question.is_some()),
                None => (UNREGISTERED_MEMBER_STATUS, None, false),
            };
            let profile_name = parse_instance_handle(&handle).map(|p| p.0).unwrap_or_else(|| handle.clone());
            members.push(json!({
                "member_id": handle,
                "profile": profile_name,
                "title": row.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| handle.clone()),
                "status": status.as_str(),
                "session_id": db::codec::api_uuid(&row.id),
                "created_at": db::codec::parse_dt(&row.created_at).map(|d| db::codec::py_isoformat(&d)),
                "last_error": last_error,
                "has_pending_question": pending,
            }));
        }
    }
    for (h, i) in &live {
        if !seen.contains(h) {
            members.push(json!({"member_id": h, "profile": i.profile_name, "title": h, "status": i.status.as_str(), "session_id": i.session_id, "created_at": null, "last_error": i.last_error, "has_pending_question": i.pending_lead_question.is_some()}));
        }
    }
    json!({"available_profiles": summaries, "live_members": members.clone(), "subagents": members})
}

/// `stop_all_subagents`.
pub async fn stop_all_subagents(lead: &str) {
    stop_subagents(lead, StopCause::User).await
}

/// Stop `lead`'s members; at shutdown with the shutdown token, so their
/// turns are continued by the next start.
pub(crate) async fn stop_subagents(lead: &str, cause: StopCause) {
    let insts: Vec<SubagentInstance> = reg().lock().unwrap().live.get(lead).map(|m| m.values().cloned().collect()).unwrap_or_default();
    for i in &insts {
        // The session, not the registry status, knows whether a turn runs:
        // a status set by an earlier stop must not shield a turn still going.
        match cause {
            StopCause::User => i.session.handle_stop().await,
            StopCause::Shutdown => i.session.handle_stop_for_shutdown().await,
        };
        with_instance(lead, &i.handle, |x| {
            if x.status.is_active() {
                let _ = x.apply(MemberEvent::Stop);
            } else {
                x.stall = None;
                x.working_since = None;
            }
        });
    }
    tracing::info!("stopped_all_subagents lead_session_id={}", lead);
}

/// Stop every member of every lead and wait, up to `limit`, for their turns
/// to end. Server shutdown runs it before closing the database, so a stopped
/// turn's last save still lands.
pub async fn stop_all_members(limit: std::time::Duration) {
    let sessions: Vec<Arc<AgentSession>> = reg().lock().unwrap().live.values().flat_map(|m| m.values().map(|i| i.session.clone())).collect();
    for s in &sessions {
        s.handle_stop_for_shutdown().await;
    }
    let waits = sessions.iter().map(|s| s.wait_for_stop(limit));
    let settled = futures::future::join_all(waits).await;
    let pending = settled.iter().filter(|done| !**done).count();
    if pending > 0 {
        tracing::warn!("subagents_stop_timeout pending={}", pending);
    }
}

/// `remove_subagent`.
pub fn remove_subagent(child: &str) -> bool {
    let mut removed = false;
    let mut r = reg().lock().unwrap();
    let leads: Vec<String> = r.live.keys().cloned().collect();
    for lead in leads {
        let m = r.live.get_mut(&lead).unwrap();
        let handles: Vec<String> = m.iter().filter(|(_, i)| i.session_id == child).map(|(h, _)| h.clone()).collect();
        for h in handles {
            if let Some(i) = m.remove(&h) {
                removed = true;
                if i.status.may_still_run() {
                    let s = i.session.clone();
                    tokio::spawn(async move {
                        s.handle_stop().await;
                    });
                }
            }
        }
        if m.is_empty() {
            r.live.remove(&lead);
        }
    }
    removed
}

/// `cleanup_lead_session`.
pub fn cleanup_lead_session(lead: &str) {
    let mut r = reg().lock().unwrap();
    if let Some(m) = r.live.remove(lead) {
        for i in m.into_values() {
            if i.status.may_still_run() {
                let s = i.session.clone();
                tokio::spawn(async move {
                    s.handle_stop().await;
                });
            }
        }
    }
    r.order.remove(lead);
    r.counters.remove(lead);
    r.reconciled.remove(lead);
}

#[cfg(test)]
mod tests;
