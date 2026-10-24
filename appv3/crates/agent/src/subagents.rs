//! Subagent coordination — port of `app/services/subagent_service.py`
//! (the paths reachable from `delegate`, session callbacks and the API).

use crate::agent::Agent;
use crate::broadcaster;
use crate::events::Envelope;
use crate::loader::{self, ProviderFactory, DEFAULT_NEW_USER_MODEL};
use crate::session::{AgentSession, UserMessage};
use crate::stream_store::store;
use appv3_core::settings::settings;
use appv3_db::{self as db, DbPool};
use appv3_providers::Kwargs;
use appv3_tools::ToolRef;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

pub const MAX_CONCURRENT_MEMBERS: usize = 20;
pub const MAX_SUBAGENT_OUTPUT_CHARS: usize = 32_000;

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
    pub status: String,
    pub last_result: Option<String>,
    pub pending_lead_question: Option<Value>,
    pub last_error: Option<String>,
    pub question_delivered: bool,
    pub result_delivered: bool,
    pub pending_tool_call_id: Option<String>,
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
    r.live.get(lead).is_some_and(|m| m.values().any(|i| i.status == "working" && i.session.is_busy()))
}

/// Every lead with a subagent still running ([`has_working_subagents`]), as
/// API ids.
pub fn leads_with_working_subagents() -> HashSet<String> {
    let r = reg().lock().unwrap();
    r.live.iter().filter(|(_, m)| m.values().any(|i| i.status == "working" && i.session.is_busy())).map(|(lead, _)| db::codec::api_uuid(lead)).collect()
}

/// Whether a lead whose turn ended still has work coming back to it: a
/// subagent still running, or a reply another workspace still owes it.
/// Either starts another lead turn, so the lead is not finished yet.
pub fn has_pending_work(lead: &str) -> bool {
    has_working_subagents(lead) || crate::workspace_messages::has_outstanding_replies(lead)
}

/// Every session [`has_pending_work`], as API ids.
pub fn sessions_with_pending_work() -> HashSet<String> {
    let mut ids = leads_with_working_subagents();
    ids.extend(crate::workspace_messages::sessions_with_outstanding_replies());
    ids
}

/// Subagent sessions suspended on `ask_lead`, as API ids. Their turn is
/// still open (the stream store counts them as running), but they are
/// waiting on the lead, not working: session rows report them as
/// `needs_input`, the lead being who must answer.
pub fn subagents_waiting_on_lead() -> HashSet<String> {
    let r = reg().lock().unwrap();
    r.live.values().flat_map(|m| m.values()).filter(|i| i.status == "waiting_lead").map(|i| db::codec::api_uuid(&i.session_id)).collect()
}

/// `prune_subagent_output`.
pub fn prune_subagent_output(output: &str, child_session_id: &str, max_chars: usize) -> String {
    let n = output.chars().count();
    if n <= max_chars {
        return output.to_string();
    }
    let head_len = 500usize.max(max_chars.saturating_sub(1000));
    let tail_len = 400usize.min(max_chars.saturating_sub(head_len));
    let head = crate::util::head_chars(output, head_len).trim_end();
    let tail = if tail_len > 0 { crate::util::tail_chars(output, tail_len).trim_start() } else { "" };
    format!(
        "{head}\n\n[... Output truncated: {n} chars total exceeds lead message budget of {max_chars} chars. Full deliverable preserved in subagent session {child_session_id} ...]\n\n{tail}"
    )
}

/// The runtime's rules for every member, appended to its own prompt. It
/// holds the communication rules, so member prompts don't repeat them.
pub fn team_context(handle: &str, role: &str) -> String {
    format!(
        "## Team Context\nYou are instance **{handle}** (role: {role}), working for the lead agent. You see only the task the lead sent, not its conversation.\n\
         - Return your final deliverable in your response text. The lead receives at most {} characters of it, so keep it well under that: lead with the answer, and cite `path:line` instead of pasting large blocks.\n\
         - If you are blocked by ambiguity or need a decision, use `ask_lead`.\n\
         - You do not communicate with other members or the user.",
        crate::hooks::basic::thousands(MAX_SUBAGENT_OUTPUT_CHARS)
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

fn allocate_instance_handle(lead: &str, profile: &str, explicit: Option<&str>) -> String {
    let mut r = reg().lock().unwrap();
    let counters = r.counters.entry(lead.to_string()).or_default();
    if let Some(name) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((p, n)) = parse_instance_handle(name) {
            let cur = *counters.get(&p).unwrap_or(&1);
            counters.insert(p, cur.max(n + 1));
        }
        return name.to_string();
    }
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

/// `_build_member_tools`.
fn build_member_tools(allowed: &[String]) -> Vec<ToolRef> {
    let mut out: Vec<ToolRef> = vec![];
    let mut seen = HashSet::new();
    for n in allowed {
        if matches!(n.as_str(), "ask_user" | "delegate" | "schedule_task") {
            continue;
        }
        if !matches!(n.as_str(), "read" | "glob" | "grep" | "patch" | "shell" | "web_search" | "web_fetch") {
            continue;
        }
        if seen.insert(n.clone()) {
            if let Some(t) = appv3_tools::builtin_tool(n) {
                out.push(t);
            }
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
        i.status = "error".into();
        i.last_error = Some(error.to_string());
    });
    publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child, "handle": handle, "status": "error"}));
}

/// `spawn_subagent(..., wait=False)`.
#[allow(clippy::too_many_arguments)] // mirrors v2's spawn_subagent signature
pub async fn spawn_subagent(
    lead: &str,
    profile: &str,
    task: &str,
    name: Option<&str>,
    tools_override: Option<Vec<String>>,
    model_override: Option<String>,
    workspace: &str,
    pool: &DbPool,
    factory: &ProviderFactory,
) -> Result<Value, SubagentError> {
    let err = |e: anyhow::Error| SubagentError::General(e.to_string());
    reconcile_lead_instances(lead, pool).await.map_err(err)?;
    {
        let r = reg().lock().unwrap();
        let active = r.live.get(lead).map(|m| m.values().filter(|i| i.status == "working").count()).unwrap_or(0);
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
    let handle = allocate_instance_handle(lead, profile, name);
    let child_uuid = uuid::Uuid::now_v7();
    let child_sid = child_uuid.to_string();
    let effective_model = if let Some(m) = model_override.clone().filter(|m| !m.is_empty()) {
        m
    } else if let Some(m) = cfg.model.clone().filter(|m| !m.is_empty() && m != DEFAULT_NEW_USER_MODEL) {
        m
    } else if let Some(m) = lead_model.filter(|m| !m.is_empty()) {
        m
    } else {
        cfg.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_NEW_USER_MODEL.into())
    };
    let effective_thinking = cfg.thinking_level.clone().filter(|s| !s.is_empty()).or(lead_thinking);
    let allowed = tools_override.unwrap_or_else(|| cfg.tools.clone());
    let member_tools = build_member_tools(&allowed);
    let system_prompt = format!("{}\n\n{}", cfg.system_prompt.trim(), team_context(&handle, &cfg.role));
    let mut kw = Kwargs::new();
    if let Some(t) = &effective_thinking {
        kw.insert("thinking_level".into(), json!(t));
    }
    let provider = factory(Some(&effective_model), kw).map_err(|e| SubagentError::General(e.to_string()))?;
    let mut agent = Agent::new(provider, &handle, &system_prompt, member_tools, Some(effective_model.clone()));
    agent.description = cfg.description.clone();
    agent.thinking_level = effective_thinking.clone();
    let child = AgentSession::new(agent, Some(child_sid.clone()), Some(workspace.to_string()), pool.clone(), factory.clone(), Some(lead.to_string()));

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
        r.live.entry(lead.to_string()).or_default().insert(
            handle.clone(),
            SubagentInstance {
                handle: handle.clone(),
                profile_name: profile.to_string(),
                lead_session_id: lead.to_string(),
                session_id: child_sid.clone(),
                session: child.clone(),
                status: "working".into(),
                last_result: None,
                pending_lead_question: None,
                last_error: None,
                question_delivered: false,
                result_delivered: false,
                pending_tool_call_id: None,
            },
        );
        let order = r.order.entry(lead.to_string()).or_default();
        if !order.contains(&handle) {
            order.push(handle.clone());
        }
    }
    tracing::info!("subagent_spawned lead={} handle={} profile={} session_id={}", lead, handle, profile, child_sid);
    publish_both(
        lead,
        "subagent_spawned",
        json!({"lead_session_id": lead, "session_id": child_sid, "handle": handle, "profile": profile, "workspace": workspace, "title": title, "status": "working", "running": true}),
    );
    if let Err(e) = child
        .handle_user_message(UserMessage {
            content: format!("[Task from Lead]: {task}"),
            session_id: child_sid.clone(),
            workspace: Some(workspace.to_string()),
            model: if model_override.is_some() { Some(effective_model.clone()) } else { None },
            model_provided: model_override.is_some(),
            origin: "agent".into(),
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
    let handle = resolve_instance(lead, member_id)?;
    let (inst_session, waiting, tool_call_id, child_sid) = with_instance(lead, &handle, |i| {
        let waiting = i.status == "waiting_lead";
        let tcid = i.pending_tool_call_id.clone();
        i.status = "working".into();
        i.question_delivered = false;
        i.result_delivered = false;
        if waiting {
            i.pending_lead_question = None;
        }
        (i.session.clone(), waiting, tcid, i.session_id.clone())
    })
    .ok_or_else(|| SubagentError::NotFound(format!("Member '{member_id}' not found.")))?;
    if waiting {
        let tcid = tool_call_id.or_else(|| inst_session.lead_suspended().and_then(|l| l.get("tool_call_id").and_then(|v| v.as_str()).map(String::from)));
        if let Some(t) = tcid.filter(|t| !t.is_empty()) {
            db::insert_raw_tool_message(pool, &child_sid, &format!("Lead answered: {message}"), &t, "ask_lead").await.map_err(|e| SubagentError::General(e.to_string()))?;
        }
        inst_session.resume_after_question_answer().await;
        return Ok(json!({"status": "sent", "member_id": handle, "message": format!("Message delivered to '{handle}' in background.")}));
    }
    let content = format!("[Lead]: {message}");
    let _g = inst_session.user_message_lock.lock().await;
    // A member still working reads the follow-up when its turn ends. Starting
    // a turn beside it left one of the two running unseen: the session read
    // idle once the other ended, so Stop and deleting the lead skipped it.
    if inst_session.has_active_user_turn() {
        db::save_queued_user_message(pool, &child_sid, &content, None).await.map_err(|e| SubagentError::General(e.to_string()))?;
        // The turn may have ended between the check and the save.
        if !inst_session.has_active_user_turn() {
            inst_session.activate_queued_user_messages(&child_sid).await;
        }
    } else if let Err(e) = inst_session.handle_user_message(UserMessage { content, session_id: child_sid.clone(), origin: "agent".into(), ..Default::default() }).await {
        mark_turn_refused(lead, &handle, &child_sid, &e.to_string());
        return Err(SubagentError::General(e.to_string()));
    }
    Ok(json!({"status": "sent", "member_id": handle, "message": format!("Message delivered to '{handle}' in background.")}))
}

/// `deliver_message_to_lead`.
pub async fn deliver_message_to_lead(lead: &str, handle: &str, content: &str, pool: &DbPool) -> anyhow::Result<()> {
    let mut extra = serde_json::Map::new();
    extra.insert("from_agent".into(), json!(handle));
    deliver_agent_message(lead, content, extra, pool).await
}

/// Queue an agent-authored user row (`extra` names the sender) on a lead
/// session and start its turn when it is idle; a busy turn picks it up.
pub async fn deliver_agent_message(lead: &str, content: &str, extra: serde_json::Map<String, Value>, pool: &DbPool) -> anyhow::Result<()> {
    db::save_queued_user_message(pool, lead, content, Some(extra)).await?;
    let mut lead_session = crate::manager::find_live_session_serving_session(lead);
    if lead_session.is_none() {
        if let Some(row) = db::get_session(pool, lead).await? {
            let ws = if row.workspace.is_empty() { std::env::current_dir().unwrap_or_default().display().to_string() } else { row.workspace.clone() };
            match crate::manager::get_or_start_agent_session(&ws, Some(lead)).await {
                Ok(s) => lead_session = s,
                Err(e) => tracing::debug!("Failed to get_or_start_agent_session for lead={}: {}", lead, e),
            }
        }
    }
    if let Some(ls) = lead_session {
        let _g = ls.user_message_lock.lock().await;
        if !ls.has_active_user_turn() {
            if ls.session_id() != lead {
                ls.attach_to_session(lead, None).await?;
            }
            ls.activate_queued_user_messages(lead).await;
        }
    }
    Ok(())
}

/// `on_subagent_turn_completed`.
#[allow(clippy::too_many_arguments)]
pub async fn on_subagent_turn_completed(lead: &str, child: &str, status: &str, workspace: &str, handle: &str, pool: &DbPool, cancelled: bool) {
    let st = if status == "completed" { "completed" } else { "error" };
    let inst = find_by_session(lead, child, |i| {
        i.status = st.into();
        i.clone()
    });
    let effective_handle = match &inst {
        Some(i) => i.handle.clone(),
        None if !handle.is_empty() => handle.to_string(),
        None => format!("subagent-{}", crate::util::head_chars(child, 8)),
    };
    publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child, "handle": effective_handle, "status": st, "workspace": workspace}));
    if cancelled {
        return;
    }
    if let Some(i) = &inst {
        if i.status == "stopped" || i.status == "cancelled" || i.last_error.as_deref() == Some("Stopped by lead") {
            return;
        }
    }
    let output = if status == "completed" {
        // Read this turn's answer from the newest assistant row. `last_result`
        // holds what an earlier turn reported, so a follow-up from the lead must
        // never fall back to it and re-send a stale report.
        let out = db::last_assistant_content(pool, child).await.ok().flatten();
        let out = out.filter(|o| !o.trim().is_empty()).unwrap_or_else(|| format!("Subagent '{effective_handle}' completed task with no text output."));
        find_by_session(lead, child, |i| {
            i.last_result = Some(out.clone());
            i.result_delivered = true;
        });
        out
    } else {
        let e = inst.as_ref().and_then(|i| i.last_error.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Subagent turn failed with error.".into());
        find_by_session(lead, child, |i| i.result_delivered = true);
        format!("Subagent '{effective_handle}' encountered an error: {e}")
    };
    let deliverable = prune_subagent_output(&output, child, MAX_SUBAGENT_OUTPUT_CHARS);
    if let Err(e) = deliver_message_to_lead(lead, &effective_handle, &deliverable, pool).await {
        tracing::warn!("Failed to deliver subagent result to lead: {}", e);
    }
}

/// `on_subagent_question_asked`.
pub async fn on_subagent_question_asked(lead: &str, child: &str, data: &Value, pool: &DbPool) {
    let inst = find_by_session(lead, child, |i| {
        i.question_delivered = true;
        if let Some(t) = data.get("tool_call_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            i.pending_tool_call_id = Some(t.to_string());
        }
        (i.handle.clone(), i.profile_name.clone())
    });
    let (handle, profile) = inst.clone().unwrap_or_else(|| (format!("subagent-{}", crate::util::head_chars(child, 8)), "explorer".into()));
    // The turn stays open while it waits, so no turn event says so; without
    // this, every client but the one on the lead's stream shows it working.
    publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child, "handle": handle, "status": "waiting_lead"}));
    let q = data.get("question").map(crate::pystr::py_str).unwrap_or_default();
    let opts: Vec<String> = data.get("options").and_then(|o| o.as_array()).map(|a| a.iter().map(crate::pystr::py_str).collect()).unwrap_or_default();
    let opts_text = if opts.is_empty() { String::new() } else { format!(" (Options: {})", opts.join(", ")) };
    let content = format!("Question from {handle}: {q}{opts_text}\nTo reply, call delegate(profile='{profile}', target='{handle}', task='<your answer>').");
    if let Err(e) = deliver_message_to_lead(lead, &handle, &content, pool).await {
        tracing::warn!("Failed to deliver subagent question to lead: {}", e);
    }
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
                Some(i) => (i.status.clone(), i.last_error.clone(), i.pending_lead_question.is_some()),
                None => ("completed".into(), None, false),
            };
            let profile_name = parse_instance_handle(&handle).map(|p| p.0).unwrap_or_else(|| handle.clone());
            members.push(json!({
                "member_id": handle,
                "profile": profile_name,
                "title": row.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| handle.clone()),
                "status": status,
                "session_id": db::codec::api_uuid(&row.id),
                "created_at": db::codec::parse_dt(&row.created_at).map(|d| db::codec::py_isoformat(&d)),
                "last_error": last_error,
                "has_pending_question": pending,
            }));
        }
    }
    for (h, i) in &live {
        if !seen.contains(h) {
            members.push(json!({"member_id": h, "profile": i.profile_name, "title": h, "status": i.status, "session_id": i.session_id, "created_at": null, "last_error": i.last_error, "has_pending_question": i.pending_lead_question.is_some()}));
        }
    }
    json!({"available_profiles": summaries, "live_members": members.clone(), "subagents": members})
}

/// `stop_all_subagents`.
pub async fn stop_all_subagents(lead: &str) {
    let insts: Vec<SubagentInstance> = reg().lock().unwrap().live.get(lead).map(|m| m.values().cloned().collect()).unwrap_or_default();
    for i in &insts {
        // The session, not the registry status, knows whether a turn runs:
        // a status set by an earlier stop must not shield a turn still going.
        i.session.handle_stop().await;
        with_instance(lead, &i.handle, |x| x.status = "error".into());
    }
    tracing::info!("stopped_all_subagents lead_session_id={}", lead);
}

/// Stop every member of every lead and wait, up to `limit`, for their turns
/// to end. Server shutdown runs it before closing the database, so a stopped
/// turn's last save still lands.
pub async fn stop_all_members(limit: std::time::Duration) {
    let sessions: Vec<Arc<AgentSession>> = reg().lock().unwrap().live.values().flat_map(|m| m.values().map(|i| i.session.clone())).collect();
    for s in &sessions {
        s.handle_stop().await;
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
                if i.status != "completed" && i.status != "error" {
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
            if i.status != "completed" && i.status != "error" {
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
mod tests {
    use super::*;

    #[test]
    fn handles_and_pruning() {
        assert_eq!(parse_instance_handle("explorer#3"), Some(("explorer".into(), 3)));
        assert_eq!(parse_instance_handle("explorer"), None);
        assert_eq!(allocate_instance_handle("L", "explorer", None), "explorer#1");
        assert_eq!(allocate_instance_handle("L", "explorer", Some("explorer#5")), "explorer#5");
        assert_eq!(allocate_instance_handle("L", "explorer", None), "explorer#6");
        let long = "x".repeat(40_000);
        let p = prune_subagent_output(&long, "sid", MAX_SUBAGENT_OUTPUT_CHARS);
        assert!(p.contains("Output truncated: 40000 chars total"));
        assert_eq!(resolve_instance("L", "nobody").unwrap_err().to_string(), "Member 'nobody' not found. Live instances: None.");
    }

    /// A member is told the limit the lead's copy is actually cut at, and
    /// that it works from the task alone; nothing else told it either.
    #[test]
    fn team_context_states_the_limit_the_lead_enforces() {
        let text = team_context("explorer#1", "member");

        assert!(text.starts_with("## Team Context\nYou are instance **explorer#1** (role: member)"), "{text}");
        assert!(text.contains("at most 32,000 characters"), "{text}");
        assert_eq!(MAX_SUBAGENT_OUTPUT_CHARS, 32_000, "update the stated limit with the enforced one");
        assert!(text.contains("You see only the task the lead sent"), "{text}");
        assert!(text.contains("`ask_lead`"), "{text}");
    }

    #[tokio::test]
    async fn only_a_running_subagent_keeps_the_lead_working() {
        let root = tempfile::tempdir().unwrap();
        let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
        let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
        let p2 = provider.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
        let lead = "lead-working-subagents";
        let add = |handle: &str, status: &str, state: &str| {
            let agent = Agent::new(provider.clone(), handle, "", vec![], None);
            let session = AgentSession::new(agent, Some(format!("{handle}-sid")), None, pool.clone(), factory.clone(), Some(lead.into()));
            session.set_state(state);
            let inst = SubagentInstance {
                handle: handle.into(),
                profile_name: "explorer".into(),
                lead_session_id: lead.into(),
                session_id: format!("{handle}-sid"),
                session,
                status: status.into(),
                last_result: None,
                pending_lead_question: None,
                last_error: None,
                question_delivered: false,
                result_delivered: false,
                pending_tool_call_id: None,
            };
            reg().lock().unwrap().live.entry(lead.into()).or_default().insert(handle.into(), inst);
        };
        assert!(!has_working_subagents(lead), "no subagents");
        // Done (its report is on its way to the lead), or marked working with no turn left.
        add("explorer#1", "completed", "idle");
        add("explorer#2", "working", "idle");
        assert!(!has_working_subagents(lead));
        add("explorer#3", "working", "working");
        assert!(has_working_subagents(lead));
        assert!(!has_working_subagents("another-lead"));
        assert!(leads_with_working_subagents().contains(lead));
        assert!(has_pending_work(lead));
        assert!(sessions_with_pending_work().contains(lead));
    }

    /// The web refetches a lead's members as soon as `subagent_spawned`
    /// arrives, which is before the member's first turn has started (its
    /// workspace snapshot alone can take seconds). Listing it then once
    /// settled it as completed for good: the lead left the active list, and
    /// the notch called it finished while every member still worked.
    #[tokio::test]
    async fn listing_a_subagent_before_its_turn_starts_keeps_it_working() {
        let root = tempfile::tempdir().unwrap();
        let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
        let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
        let p2 = provider.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
        let lead_row = db::create_session(&pool, db::NewSession { workspace: "/tmp".into(), ..Default::default() }).await.unwrap();
        let lead = db::codec::api_uuid(&lead_row.id);
        let child_row = db::create_session(
            &pool,
            db::NewSession { parent_session_id: Some(lead.clone()), agent_name: Some("worker#1".into()), workspace: "/tmp".into(), ..Default::default() },
        )
        .await
        .unwrap();
        let child_sid = db::codec::api_uuid(&child_row.id);
        // Registered and marked working, its turn not spawned yet.
        let agent = Agent::new(provider.clone(), "worker#1", "", vec![], None);
        let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.clone()));
        let inst = SubagentInstance {
            handle: "worker#1".into(),
            profile_name: "worker".into(),
            lead_session_id: lead.clone(),
            session_id: child_sid,
            session: session.clone(),
            status: "working".into(),
            last_result: None,
            pending_lead_question: None,
            last_error: None,
            question_delivered: false,
            result_delivered: false,
            pending_tool_call_id: None,
        };
        reg().lock().unwrap().live.entry(lead.clone()).or_default().insert("worker#1".into(), inst);

        let listed = list_subagents(&lead, &pool).await;
        assert_eq!(listed["subagents"][0]["status"], json!("working"), "{listed}");

        // Its turn starts: the lead still has work coming back to it.
        session.set_state("working");
        assert!(has_working_subagents(&lead), "listing settled the starting member as done");
    }

    /// A member whose turn never starts never reports, so the failure is
    /// recorded where the turn was refused; listed as working, it would stay
    /// so for good.
    #[tokio::test]
    async fn a_follow_up_that_cannot_start_a_turn_marks_the_member_failed() {
        let root = tempfile::tempdir().unwrap();
        let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
        let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
        let p2 = provider.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
        let lead = "lead-follow-up-refused";
        let child = db::create_session(&pool, db::NewSession { workspace: "/tmp".into(), ..Default::default() }).await.unwrap();
        let child_sid = db::codec::api_uuid(&child.id);
        // An open question refuses machine-sent messages.
        db::create_pending_question(&pool, &child_sid, "call_q", &[json!({"question": "Which?"})]).await.unwrap();
        let agent = Agent::new(provider.clone(), "worker#1", "", vec![], None);
        let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.into()));
        let inst = SubagentInstance {
            handle: "worker#1".into(),
            profile_name: "worker".into(),
            lead_session_id: lead.into(),
            session_id: child_sid,
            session,
            status: "completed".into(),
            last_result: None,
            pending_lead_question: None,
            last_error: None,
            question_delivered: false,
            result_delivered: false,
            pending_tool_call_id: None,
        };
        reg().lock().unwrap().live.entry(lead.into()).or_default().insert("worker#1".into(), inst);

        assert!(send_subagent_message(lead, "worker#1", "one more thing", &pool).await.is_err());
        let (status, error) = with_instance(lead, "worker#1", |i| (i.status.clone(), i.last_error.clone())).unwrap();
        assert_eq!(status, "error");
        assert!(error.is_some_and(|e| !e.is_empty()));
    }

    #[tokio::test]
    async fn a_follow_up_turn_reports_its_own_answer() {
        let root = tempfile::tempdir().unwrap();
        let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
        let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
        let p2 = provider.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
        let lead = "lead-follow-up-report";
        let child = db::create_session(&pool, db::NewSession { title: Some("explorer#1".into()), workspace: "/tmp".into(), ..Default::default() }).await.unwrap();
        let child_sid = db::codec::api_uuid(&child.id);
        let agent = Agent::new(provider.clone(), "explorer#1", "", vec![], None);
        let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.into()));
        let inst = SubagentInstance {
            handle: "explorer#1".into(),
            profile_name: "explorer".into(),
            lead_session_id: lead.into(),
            session_id: child_sid.clone(),
            session,
            status: "working".into(),
            last_result: None,
            pending_lead_question: None,
            last_error: None,
            question_delivered: false,
            result_delivered: false,
            pending_tool_call_id: None,
        };
        reg().lock().unwrap().live.entry(lead.into()).or_default().insert("explorer#1".into(), inst);
        let reported = || find_by_session(lead, &child_sid, |i| i.last_result.clone()).flatten();

        db::save_message(&pool, &child_sid, db::NewMessage::assistant(Some("first report".into()))).await.unwrap();
        on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "explorer#1", &pool, false).await;
        assert_eq!(reported().as_deref(), Some("first report"));

        // The lead sends a follow-up and the subagent answers it in a new turn.
        db::save_message(&pool, &child_sid, db::NewMessage::assistant(Some("second report".into()))).await.unwrap();
        on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "explorer#1", &pool, false).await;
        assert_eq!(reported().as_deref(), Some("second report"));

        // A turn that ends without text says so instead of re-sending an old report.
        db::save_message(&pool, &child_sid, db::NewMessage::assistant(None)).await.unwrap();
        on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "explorer#1", &pool, false).await;
        assert_eq!(reported().as_deref(), Some("Subagent 'explorer#1' completed task with no text output."));
    }

    #[tokio::test]
    async fn a_subagent_asking_its_lead_reports_that_it_waits() {
        let root = tempfile::tempdir().unwrap();
        let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
        let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
        let p2 = provider.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
        let lead = "lead-waiting-subagent";
        let child_sid = uuid::Uuid::now_v7().to_string();
        let agent = Agent::new(provider.clone(), "explorer#1", "", vec![], None);
        let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.into()));
        let inst = SubagentInstance {
            handle: "explorer#1".into(),
            profile_name: "explorer".into(),
            lead_session_id: lead.into(),
            session_id: child_sid.clone(),
            session,
            // `ask_lead` sets this before the turn suspends.
            status: "waiting_lead".into(),
            last_result: None,
            pending_lead_question: Some(json!({"question": "Which branch?", "options": []})),
            last_error: None,
            question_delivered: false,
            result_delivered: false,
            pending_tool_call_id: None,
        };
        reg().lock().unwrap().live.entry(lead.into()).or_default().insert("explorer#1".into(), inst);
        assert!(subagents_waiting_on_lead().contains(&child_sid));

        let mut feed = broadcaster::broadcaster().attach();
        on_subagent_question_asked(lead, &child_sid, &json!({"question": "Which branch?"}), &pool).await;
        let status = loop {
            let ev = tokio::time::timeout(std::time::Duration::from_secs(5), feed.next()).await.expect("an event").expect("feed open");
            let data: Value = serde_json::from_str(&ev.data).unwrap();
            if ev.event == "subagent_status" && data["session_id"] == json!(child_sid) {
                break data;
            }
        };
        assert_eq!(status["status"], json!("waiting_lead"));
        assert_eq!(status["lead_session_id"], json!(lead));

        // The lead answers: the subagent works again and no longer waits.
        with_instance(lead, "explorer#1", |i| i.status = "working".into());
        assert!(!subagents_waiting_on_lead().contains(&child_sid));
    }
}
