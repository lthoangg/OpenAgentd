//! Cross-workspace messages (v3 only): a lead sends a user prompt to a
//! session in another registered workspace (`send_to_workspace`) and, when
//! it asks for one, gets that session's final answer back as a report.
//!
//! The request row in the target carries `extra.sent_from`; the reply link
//! lives there too (`reply`, `replied_at`, `error_notified_at`), so a target
//! paused on a question still replies after a restart.

use crate::manager;
use crate::service::{dispatch_user_message, Dispatch, DispatchError};
use crate::session::SessionError;
use appv3_core::settings::settings;
use appv3_db::{self as db, codec, DbPool, SessionMessage};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Workspaces a request may pass through before a send is refused.
pub const MAX_HOPS: i64 = 3;
pub const MAX_MESSAGE_CHARS: usize = 100_000;
/// Sends one lead turn may make (runaway fan-out guard).
pub const MAX_SENDS_PER_TURN: usize = 10;
/// Reply budget in the sender's history.
pub const MAX_REPLY_CHARS: usize = 32_000;
const LIST_WORKSPACES_MAX: usize = 50;
const LIST_SESSIONS_MAX: i64 = 10;

/// A workspace a lead may message: the Chat workspace plus every visible
/// registered repository and worktree.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub path: String,
    pub name: String,
    /// `chat` | `repo` | `worktree`
    pub kind: String,
    pub source_path: Option<String>,
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string())
}

/// The workspaces a lead may message, Chat first.
pub async fn registered_workspaces(pool: &DbPool) -> anyhow::Result<Vec<Target>> {
    let s = settings();
    let chat = s.chat_workspace_root().display().to_string();
    let mut out = vec![Target { path: chat, name: "Chat".into(), kind: "chat".into(), source_path: None }];
    for row in db::list_visible_coding_workspaces(pool).await? {
        if s.is_chat_workspace(Some(Path::new(&row.path))) {
            continue;
        }
        let name = row.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| basename(&row.path));
        out.push(Target { path: row.path, name, kind: row.kind, source_path: row.source_path });
    }
    Ok(out)
}

fn looks_like_path(q: &str) -> bool {
    q.starts_with('~') || q.contains('/') || q.contains('\\') || Path::new(q).is_absolute()
}

/// Resolve `query` (a workspace name, case-insensitive, or a path) against
/// the registered workspaces.
pub fn resolve_in(targets: &[Target], query: &str) -> Result<Target, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("workspace is required. Call action='list' to see the workspaces you can message.".into());
    }
    if looks_like_path(q) {
        let resolved = db::resolve_path(q);
        return targets.iter().find(|t| t.path == resolved || db::resolve_path(&t.path) == resolved).cloned().ok_or_else(|| {
            format!(
                "Workspace '{resolved}' is not registered in OpenAgentd. Ask the user to open it in the app first, or call action='list' to see the workspaces you can message."
            )
        });
    }
    let matches: Vec<&Target> = targets.iter().filter(|t| t.name.eq_ignore_ascii_case(q)).collect();
    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => {
            let names: Vec<&str> = targets.iter().map(|t| t.name.as_str()).collect();
            Err(format!("No registered workspace is named '{q}'. Available: {}. Call action='list' for paths.", names.join(", ")))
        }
        _ => {
            let paths: Vec<&str> = matches.iter().map(|t| t.path.as_str()).collect();
            Err(format!("Several workspaces are named '{q}': {}. Pass the path instead.", paths.join(", ")))
        }
    }
}

/// Hop count for a message sent from a session whose newest incoming
/// request carries `latest` (`extra.sent_from`).
pub fn next_hops(latest: Option<&Value>) -> i64 {
    latest.and_then(|v| v.get("hops")).and_then(Value::as_i64).unwrap_or(0).max(0) + 1
}

// ── outstanding replies (notification suppression only) ─────────────────────

fn outstanding() -> &'static Mutex<HashMap<String, usize>> {
    static O: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    O.get_or_init(Default::default)
}

fn key(sid: &str) -> String {
    codec::api_uuid(sid)
}

/// Whether `session_id` still waits on a reply it asked another workspace
/// for. In memory: after a restart this is false, which costs at most one
/// extra notification.
pub fn has_outstanding_replies(session_id: &str) -> bool {
    outstanding().lock().unwrap().get(&key(session_id)).is_some_and(|n| *n > 0)
}

fn add_outstanding(session_id: &str) {
    *outstanding().lock().unwrap().entry(key(session_id)).or_insert(0) += 1;
}

fn settle_outstanding(session_id: &str) {
    let mut o = outstanding().lock().unwrap();
    let k = key(session_id);
    if let Some(n) = o.get_mut(&k) {
        *n = n.saturating_sub(1);
        if *n == 0 {
            o.remove(&k);
        }
    }
}

// ── send ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct SendRequest {
    pub source_session_id: String,
    pub source_workspace: String,
    /// Target workspace name or path.
    pub workspace: String,
    pub message: String,
    /// Continue this top-level session instead of starting one.
    pub session_id: Option<String>,
    pub reply: bool,
    /// `code` | `plan` (new sessions only).
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// A new session started on the message.
    Started,
    /// An idle session started a turn on the message.
    Delivered,
    /// The session is busy or waits on the user; the message runs next.
    Queued,
}

#[derive(Debug, Clone)]
pub struct Sent {
    pub target: Target,
    pub session_id: String,
    pub delivery: Delivery,
}

fn same_path(a: &str, b: &str) -> bool {
    a == b || db::resolve_path(a) == db::resolve_path(b)
}

/// Send `req.message` to a session in another workspace as a user prompt.
pub async fn send(pool: &DbPool, req: SendRequest) -> Result<Sent, String> {
    let err = |e: anyhow::Error| e.to_string();
    if req.message.trim().is_empty() {
        return Err("message must not be blank.".into());
    }
    if req.message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(format!("message is longer than {MAX_MESSAGE_CHARS} characters. Point the other agent at files by absolute path instead of pasting them."));
    }
    let targets = registered_workspaces(pool).await.map_err(err)?;
    let target = resolve_in(&targets, &req.workspace)?;
    let ws = manager::validate_workspace(&target.path, true)?;

    let hops = next_hops(db::latest_sent_from(pool, &req.source_session_id).await.map_err(err)?.as_ref());
    if hops > MAX_HOPS {
        return Err(format!("Refused: this request has already passed through {MAX_HOPS} workspaces. Finish the work here or ask the user to take it further."));
    }
    let source_row = db::get_session(pool, &req.source_session_id).await.map_err(err)?;
    let source_name = targets.iter().find(|t| same_path(&t.path, &req.source_workspace)).map(|t| t.name.clone()).unwrap_or_else(|| basename(&req.source_workspace));
    let mut sent_from = Map::new();
    sent_from.insert("session_id".into(), json!(codec::api_uuid(&req.source_session_id)));
    sent_from.insert("workspace".into(), json!(req.source_workspace));
    sent_from.insert("workspace_name".into(), json!(source_name));
    sent_from.insert("session_title".into(), json!(source_row.as_ref().and_then(|r| r.title.clone())));
    sent_from.insert("reply".into(), json!(req.reply));
    sent_from.insert("hops".into(), json!(hops));
    let mut extra = Map::new();
    extra.insert("sent_from".into(), Value::Object(sent_from));

    let source_uuid = codec::parse_uuid(&req.source_session_id);
    let (sid, existing) = match req.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let Some(u) = codec::parse_uuid(raw) else {
                return Err(format!("session_id must be a UUID; got '{raw}'."));
            };
            if Some(u) == source_uuid {
                return Err("session_id is this session. Message another session or omit session_id to start one.".into());
            }
            let sid = u.to_string();
            let Some(row) = db::get_session(pool, &sid).await.map_err(err)? else {
                return Err(format!("Session {sid} not found. Call action='list' with workspace='{}' to see its sessions.", target.name));
            };
            if row.parent_session_id.is_some() {
                return Err(format!("Session {sid} is a subagent session. Message its lead session instead."));
            }
            if !same_path(&row.workspace, &ws) {
                return Err(format!("Session {sid} belongs to workspace '{}', not '{}'.", row.workspace, target.name));
            }
            (sid, true)
        }
        None => (uuid::Uuid::now_v7().to_string(), false),
    };

    let agent = match manager::get_or_start_agent_session(&ws, Some(&sid)).await {
        Ok(Some(a)) => a,
        Ok(None) => return Err("No agent is configured, so the other workspace cannot run a session.".into()),
        Err(e) => return Err(e.to_string()),
    };
    if !existing {
        if let Some(mode) = req.mode.as_deref().filter(|m| *m == "plan") {
            crate::interaction_mode::set_mode(pool, &sid, mode).await.map_err(err)?;
        }
    }
    let delivery = {
        let _g = agent.user_message_lock.lock().await;
        if existing {
            db::cleanup_reverted_tail(pool, &sid).await.map_err(err)?;
        }
        let queue = |extra: Map<String, Value>| {
            let agent = agent.clone();
            let (sid, message) = (sid.clone(), req.message.clone());
            async move {
                db::save_queued_user_message(pool, &sid, &message, Some(extra)).await.map_err(err)?;
                if !agent.has_active_user_turn() {
                    agent.activate_queued_user_messages(&sid).await;
                }
                Ok::<Delivery, String>(Delivery::Queued)
            }
        };
        if existing && agent.has_active_user_turn() && !agent.is_awaiting_question_answer() {
            queue(extra).await?
        } else {
            let d = Dispatch {
                content: req.message.clone(),
                session_id: Some(sid.clone()),
                workspace: Some(ws.clone()),
                origin: "workspace".into(),
                extra: Some(extra.clone()),
                ..Default::default()
            };
            match dispatch_user_message(&agent, d).await {
                Ok(_) if existing => Delivery::Delivered,
                Ok(_) => Delivery::Started,
                // Waiting on the user: the message runs once they answer.
                Err(DispatchError::Session(SessionError::QuestionPending(_))) => queue(extra).await?,
                Err(e) => return Err(e.to_string()),
            }
        }
    };
    if req.reply {
        add_outstanding(&req.source_session_id);
    }
    tracing::info!(
        "workspace_message_sent source_session_id={} target_workspace={} target_session_id={} delivery={:?} reply={} hops={}",
        req.source_session_id,
        ws,
        sid,
        delivery,
        req.reply,
        hops
    );
    Ok(Sent { target, session_id: sid, delivery })
}

// ── list ─────────────────────────────────────────────────────────────────────

/// `action='list'`: the workspaces, or one workspace's recent sessions.
pub async fn list(pool: &DbPool, current_workspace: &str, workspace: Option<&str>) -> Result<String, String> {
    let err = |e: anyhow::Error| e.to_string();
    let targets = registered_workspaces(pool).await.map_err(err)?;
    let Some(q) = workspace.map(str::trim).filter(|q| !q.is_empty()) else {
        let mut lines = vec!["Workspaces you can message (name — path):".to_string()];
        for t in targets.iter().take(LIST_WORKSPACES_MAX) {
            let mut line = format!("- {} — {}", t.name, t.path);
            if t.kind == "worktree" {
                if let Some(src) = t.source_path.as_deref() {
                    let of = targets.iter().find(|x| same_path(&x.path, src)).map(|x| x.name.clone()).unwrap_or_else(|| basename(src));
                    line.push_str(&format!(" (worktree of {of})"));
                }
            }
            if same_path(&t.path, current_workspace) {
                line.push_str(" (current)");
            }
            lines.push(line);
        }
        if targets.len() > LIST_WORKSPACES_MAX {
            lines.push(format!("… and {} more; pass a path to reach them.", targets.len() - LIST_WORKSPACES_MAX));
        }
        return Ok(lines.join("\n"));
    };
    let target = resolve_in(&targets, q)?;
    let ws = manager::validate_workspace(&target.path, false)?;
    let (rows, _, more) = db::list_sessions_page(pool, None, LIST_SESSIONS_MAX, std::slice::from_ref(&ws), None).await.map_err(err)?;
    if rows.is_empty() {
        return Ok(format!("No sessions yet in '{}' ({ws}). Omit session_id to start one.", target.name));
    }
    let mut lines = vec![format!("Recent sessions in '{}' ({ws}), newest first (id | title | updated | state):", target.name)];
    for r in rows {
        let id = codec::api_uuid(&r.id);
        let state = match manager::find_live_session(&ws, Some(&id)) {
            Some(s) if s.is_awaiting_question_answer() => "needs input",
            Some(s) if s.is_busy() => "running",
            _ => "idle",
        };
        let updated = codec::parse_dt(&r.updated_at).map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_default();
        lines.push(format!("- {id} | {} | {updated} | {state}", r.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".into())));
    }
    if more {
        lines.push("Older sessions are not listed.".into());
    }
    Ok(lines.join("\n"))
}

// ── replies ──────────────────────────────────────────────────────────────────

/// Trim a reply to the sender's budget, keeping the head and the tail.
pub fn prune_reply(output: &str, session_id: &str) -> String {
    let n = output.chars().count();
    if n <= MAX_REPLY_CHARS {
        return output.to_string();
    }
    let head = crate::util::head_chars(output, MAX_REPLY_CHARS - 1000).trim_end();
    let tail = crate::util::tail_chars(output, 400).trim_start();
    format!("{head}\n\n[... Reply truncated: {n} chars total. The full answer is in session {session_id} ...]\n\n{tail}")
}

/// How the turn that consumed a request ended.
pub fn reply_status(status: &str, cancelled: bool) -> &'static str {
    if cancelled {
        "stopped"
    } else if status == "completed" {
        "completed"
    } else {
        "error"
    }
}

/// The interim notice for a failed or stopped turn.
pub fn interim_notice(status: &str, workspace_name: &str, error: Option<&str>) -> String {
    match status {
        "stopped" => format!("The session in '{workspace_name}' was stopped before it finished. If it is continued there, its final answer will follow."),
        _ => format!(
            "The session in '{workspace_name}' failed: {}. If it is retried there, its final answer will follow.",
            error.map(|e| e.trim().trim_end_matches('.')).filter(|e| !e.is_empty()).unwrap_or("unknown error")
        ),
    }
}

fn sent_from(row: &SessionMessage) -> Option<(Map<String, Value>, Map<String, Value>)> {
    let extra = row.extra_json()?.as_object()?.clone();
    let sf = extra.get("sent_from")?.as_object()?.clone();
    Some((extra, sf))
}

async fn stamp(pool: &DbPool, row: &SessionMessage, field: &str) {
    let Some((mut extra, mut sf)) = sent_from(row) else { return };
    sf.insert(field.into(), json!(codec::py_isoformat(&chrono::Utc::now())));
    extra.insert("sent_from".into(), Value::Object(sf));
    if let Err(e) = db::update_message_content(pool, &row.id, row.content.as_deref(), Some(&extra)).await {
        tracing::warn!("workspace_message_stamp_failed message_id={} field={} error={}", row.id, field, e);
    }
}

/// A top-level turn in `session_id` ended: answer the requests it consumed.
/// Returns whether a final answer went out (the caller then skips its own
/// "Done" notification; the sender's next turn notifies instead).
///
/// A turn that ends while subagents still work is not the final one, so the
/// reply waits for the turn their reports start. A failed or stopped turn
/// sends one interim notice and leaves the request pending for a retry.
pub async fn on_turn_closed(pool: &DbPool, session_id: &str, status: &str, cancelled: bool, last_error: Option<&str>) -> bool {
    let outcome = reply_status(status, cancelled);
    if outcome == "completed" && crate::subagents::has_working_subagents(session_id) {
        return false;
    }
    let rows = match db::pending_reply_requests(pool, session_id).await {
        Ok(r) if !r.is_empty() => r,
        Ok(_) => return false,
        Err(e) => {
            tracing::warn!("workspace_message_pending_failed session_id={} error={}", session_id, e);
            return false;
        }
    };
    let target_ws = db::get_session(pool, session_id).await.ok().flatten().map(|r| r.workspace).unwrap_or_default();
    let target_name =
        registered_workspaces(pool).await.ok().and_then(|ts| ts.into_iter().find(|t| same_path(&t.path, &target_ws)).map(|t| t.name)).unwrap_or_else(|| basename(&target_ws));
    let sid = codec::api_uuid(session_id);
    let answer = if outcome == "completed" {
        let out = db::last_assistant_content(pool, session_id).await.ok().flatten().filter(|s| !s.trim().is_empty());
        Some(out.map(|o| prune_reply(&o, &sid)).unwrap_or_else(|| format!("The session in '{target_name}' finished without a text answer.")))
    } else {
        None
    };

    // One reply per sender, however many of its requests this turn answered.
    let mut groups: Vec<(String, Vec<SessionMessage>)> = vec![];
    for row in rows {
        let Some(src) = sent_from(&row).and_then(|(_, sf)| sf.get("session_id").and_then(Value::as_str).map(String::from)) else { continue };
        match groups.iter_mut().find(|(s, _)| *s == src) {
            Some(g) => g.1.push(row),
            None => groups.push((src, vec![row])),
        }
    }
    let mut delivered = false;
    for (source, rows) in groups {
        if db::get_session(pool, &source).await.ok().flatten().is_none() {
            tracing::info!("workspace_message_reply_dropped source_session_id={} target_session_id={} reason=source_gone", source, sid);
            for r in &rows {
                stamp(pool, r, "replied_at").await;
            }
            continue;
        }
        let content = match &answer {
            Some(a) => a.clone(),
            None => {
                if rows.iter().all(|r| sent_from(r).is_some_and(|(_, sf)| sf.get("error_notified_at").is_some_and(|v| !v.is_null()))) {
                    continue;
                }
                interim_notice(outcome, &target_name, last_error)
            }
        };
        let mut extra = Map::new();
        extra.insert("from_agent".into(), json!(target_name));
        extra.insert("reply_from".into(), json!({"session_id": sid, "workspace": target_ws, "workspace_name": target_name, "status": outcome}));
        if let Err(e) = crate::subagents::deliver_agent_message(&source, &content, extra, pool).await {
            tracing::warn!("workspace_message_reply_failed source_session_id={} target_session_id={} error={}", source, sid, e);
            continue;
        }
        let field = if answer.is_some() { "replied_at" } else { "error_notified_at" };
        for r in &rows {
            stamp(pool, r, field).await;
            if answer.is_some() {
                settle_outstanding(&source);
            }
        }
        delivered |= answer.is_some();
        tracing::info!("workspace_message_replied source_session_id={} target_session_id={} status={}", source, sid, outcome);
    }
    delivered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(path: &str, name: &str, kind: &str) -> Target {
        Target { path: path.into(), name: name.into(), kind: kind.into(), source_path: None }
    }

    #[test]
    fn resolves_by_name_and_path() {
        let ts =
            vec![t("/nonexistent/chat", "Chat", "chat"), t("/nonexistent/infra", "infra", "repo"), t("/nonexistent/a/api", "api", "repo"), t("/nonexistent/b/api", "api", "repo")];
        assert_eq!(resolve_in(&ts, "INFRA").unwrap().path, "/nonexistent/infra");
        assert_eq!(resolve_in(&ts, "chat").unwrap().kind, "chat");
        assert_eq!(resolve_in(&ts, "/nonexistent/b/api").unwrap().path, "/nonexistent/b/api");
        assert_eq!(resolve_in(&ts, "/nonexistent/b/../a/api").unwrap().path, "/nonexistent/a/api");
        let amb = resolve_in(&ts, "api").unwrap_err();
        assert!(amb.contains("/nonexistent/a/api") && amb.contains("/nonexistent/b/api"), "{amb}");
        assert!(resolve_in(&ts, "web").unwrap_err().contains("Available: Chat, infra, api, api"));
        assert!(resolve_in(&ts, "/nonexistent/web").unwrap_err().contains("not registered"));
        assert!(resolve_in(&ts, "  ").is_err());
    }

    #[test]
    fn hops_count_up_from_the_latest_request() {
        assert_eq!(next_hops(None), 1);
        assert_eq!(next_hops(Some(&json!({"hops": 2}))), 3);
        assert_eq!(next_hops(Some(&json!({}))), 1);
    }

    #[test]
    fn reply_texts() {
        assert_eq!(reply_status("completed", false), "completed");
        assert_eq!(reply_status("completed", true), "stopped");
        assert_eq!(reply_status("error", false), "error");
        assert!(interim_notice("error", "infra", Some("rate limited")).contains("failed: rate limited"));
        assert!(interim_notice("error", "infra", Some("Set the key.")).contains("failed: Set the key. If it"));
        assert!(interim_notice("error", "infra", None).contains("unknown error"));
        assert!(interim_notice("stopped", "infra", None).contains("was stopped"));
        let long = "x".repeat(MAX_REPLY_CHARS + 10);
        let p = prune_reply(&long, "sid");
        assert!(p.contains("Reply truncated") && p.chars().count() < MAX_REPLY_CHARS + 200);
        assert_eq!(prune_reply("short", "sid"), "short");
    }

    #[test]
    fn outstanding_counter() {
        let sid = uuid::Uuid::now_v7().to_string();
        assert!(!has_outstanding_replies(&sid));
        add_outstanding(&sid);
        add_outstanding(&sid);
        settle_outstanding(&sid);
        assert!(has_outstanding_replies(&sid));
        settle_outstanding(&sid);
        settle_outstanding(&sid);
        assert!(!has_outstanding_replies(&sid));
    }
}
