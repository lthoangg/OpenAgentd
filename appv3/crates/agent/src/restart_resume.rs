//! Continue the turns a server restart cut off (v3 only).
//!
//! Every turn records itself in `inflight_turns` when it starts and clears
//! the row when it ends (see `AgentSession::run_turn`). A turn the server's
//! own shutdown stopped keeps its row, and so does one a crash or a
//! SIGKILL cut off, so the rows left at the next start are the turns that
//! were running. [`resume_after_restart`] then:
//!
//! - continues each lead session's turn once: cut-off tool calls get a
//!   result saying a restart stopped them, and a note (`extra.restart_resume`)
//!   tells the agent and the transcript what happened. A turn that a restart
//!   already continued is not continued again, so a turn that brings the
//!   server down cannot restart it forever;
//! - tells each lead whose member (subagent) was cut off, so the lead is
//!   not left waiting for a report that never comes (members are tracked in
//!   memory only, so they are not restarted themselves);
//! - keeps active goals running (see [`crate::goal::continue_after_restart`]).
//!
//! A turn the user stopped clears its row like any other ending, so it is
//! never continued.

use crate::session::TurnOptions;
use appv3_db::{self as db, DbPool, NewMessage};
use serde_json::{json, Map};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// `extra` key of the note a restart leaves in the transcript:
/// `{"continued": bool}`.
pub const NOTE_KEY: &str = "restart_resume";

/// The result of a tool call a restart cut off.
pub const RESTART_TOOL_RESULT: &str =
    "Tool execution was interrupted by a server restart before a result could be recorded. It may have partly run: check its effects before running it again.";

/// What the agent reads when its turn is continued.
pub const CONTINUE_NOTE: &str =
    "The server restarted while you were working, which cut off your last step. Tool calls that were running then were stopped and may have partly run. \
Continue the task from where you left off, and check the current state before repeating anything.";

/// What the transcript keeps when a turn is not continued again.
pub const NOT_CONTINUED_NOTE: &str = "The server restarted again before the continued turn finished, so it was not continued automatically.";

/// How many times a restart may continue the same turn.
pub const MAX_RESUMES: i64 = 1;

/// Pause between two continued sessions, so a restart with many running
/// sessions does not send every request to the provider at once.
const RESUME_SPACING: Duration = Duration::from_millis(250);

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// The server is shutting down: turns it stops from now on stay marked.
pub fn begin_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}

pub fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

/// What [`resume_after_restart`] did, by session id (API form).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    /// Lead sessions whose turn is running again.
    pub continued: Vec<String>,
    /// Lead sessions whose turn stays stopped (continued once already, or
    /// no agent could run it).
    pub not_continued: Vec<String>,
    /// Members whose lead was told they were stopped.
    pub members_reported: Vec<String>,
}

enum Outcome {
    Continued,
    NotContinued,
    /// Parked on a question: not running, and its answer resumes it.
    Parked,
}

/// Continue what the last server process left running. Call once, after
/// [`crate::manager::init`] and once tools (MCP) are up.
pub async fn resume_after_restart(pool: &DbPool) -> Report {
    let rows = match db::list_inflight_turns(pool).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("restart_resume_query_failed error={}", e);
            vec![]
        }
    };
    let mut report = Report::default();
    let mut members = vec![];
    let mut spaced = false;
    for row in rows {
        let sid = db::codec::api_uuid(&row.session_id);
        let session = match db::get_session(pool, &sid).await {
            Ok(Some(s)) => s,
            Ok(None) => {
                clear(pool, &sid).await;
                continue;
            }
            Err(e) => {
                tracing::warn!("restart_resume_session_failed session_id={} error={}", sid, e);
                continue;
            }
        };
        if let Some(lead) = session.parent_session_id.clone() {
            members.push((sid, db::codec::api_uuid(&lead), session.agent_name.clone()));
            continue;
        }
        if spaced {
            tokio::time::sleep(RESUME_SPACING).await;
        }
        spaced = true;
        match resume_lead(pool, &sid, &session, row.restart_resumes).await {
            Outcome::Continued => report.continued.push(sid),
            Outcome::NotContinued => report.not_continued.push(sid),
            Outcome::Parked => {}
        }
    }
    // After the leads: a report to a lead that is running again joins its turn.
    for (sid, lead, handle) in members {
        clear(pool, &sid).await;
        let handle = handle.filter(|h| !h.is_empty()).unwrap_or_else(|| format!("subagent-{}", crate::util::head_chars(&sid, 8)));
        match crate::subagents::deliver_message_to_lead(&lead, &handle, &member_notice(&handle), pool).await {
            Ok(()) => {
                tracing::info!("restart_member_reported lead={} handle={} session_id={}", lead, handle, sid);
                report.members_reported.push(sid);
            }
            Err(e) => tracing::warn!("restart_member_report_failed lead={} handle={} error={}", lead, handle, e),
        }
    }
    crate::goal::continue_after_restart(pool, &report.continued, &report.not_continued).await;
    if !report.continued.is_empty() || !report.not_continued.is_empty() || !report.members_reported.is_empty() {
        tracing::info!("restart_resume_done continued={} not_continued={} members_reported={}", report.continued.len(), report.not_continued.len(), report.members_reported.len());
    }
    report
}

/// The report a lead gets for a member a restart stopped.
pub fn member_notice(handle: &str) -> String {
    format!(
        "{handle} was stopped by a server restart before it finished its task. Its session and work so far are kept, but it is no longer running and cannot be messaged. \
To finish its task, delegate it again (a new member starts)."
    )
}

async fn resume_lead(pool: &DbPool, sid: &str, row: &db::ChatSession, resumes: i64) -> Outcome {
    if let Err(e) = crate::history::heal_orphaned_tool_calls_with(pool, sid, RESTART_TOOL_RESULT).await {
        tracing::warn!("restart_resume_heal_failed session_id={} error={}", sid, e);
    }
    if db::get_pending_question(pool, sid).await.ok().flatten().is_some() {
        clear(pool, sid).await;
        return Outcome::Parked;
    }
    if resumes >= MAX_RESUMES {
        clear(pool, sid).await;
        save_note(pool, sid, NOT_CONTINUED_NOTE, false).await;
        tracing::warn!("restart_resume_skipped session_id={} reason=already_continued", sid);
        return Outcome::NotContinued;
    }
    let ws = if row.workspace.is_empty() { std::env::current_dir().unwrap_or_default().display().to_string() } else { row.workspace.clone() };
    let agent = match crate::manager::get_or_start_agent_session(&ws, Some(sid)).await {
        Ok(Some(a)) => a,
        Ok(None) => {
            tracing::warn!("restart_resume_skipped session_id={} reason=no_agent", sid);
            clear(pool, sid).await;
            return Outcome::NotContinued;
        }
        Err(e) => {
            tracing::warn!("restart_resume_skipped session_id={} reason=agent_failed error={}", sid, e);
            clear(pool, sid).await;
            return Outcome::NotContinued;
        }
    };
    if let Err(e) = db::count_restart_resume(pool, sid).await {
        tracing::warn!("restart_resume_count_failed session_id={} error={}", sid, e);
    }
    let mut extra = Map::new();
    extra.insert(NOTE_KEY.into(), json!({"continued": true}));
    if let Err(e) = db::save_queued_user_message(pool, sid, CONTINUE_NOTE, Some(extra)).await {
        tracing::warn!("restart_resume_note_failed session_id={} error={}", sid, e);
        clear(pool, sid).await;
        return Outcome::NotContinued;
    }
    let _g = agent.user_message_lock.lock().await;
    // Something started a turn first: it picks the note up from the queue.
    if agent.has_active_user_turn() {
        tracing::info!("restart_resume_joined_running_turn session_id={}", sid);
        return Outcome::Continued;
    }
    if agent.session_id() != sid {
        if let Err(e) = agent.attach_to_session(sid, None).await {
            tracing::warn!("restart_resume_attach_failed session_id={} error={}", sid, e);
        }
    }
    let opts = TurnOptions { restart_resume: true, unattended: row.scheduled_task_name.is_some(), ..Default::default() };
    if agent.activate_queued_with(sid, opts).await {
        tracing::info!("restart_resume_continued session_id={}", sid);
        Outcome::Continued
    } else {
        clear(pool, sid).await;
        Outcome::NotContinued
    }
}

async fn save_note(pool: &DbPool, sid: &str, text: &str, continued: bool) {
    let mut extra = Map::new();
    extra.insert(NOTE_KEY.into(), json!({"continued": continued}));
    if let Err(e) = db::save_message(pool, sid, NewMessage { extra: Some(extra), ..NewMessage::user(text) }).await {
        tracing::warn!("restart_resume_note_failed session_id={} error={}", sid, e);
    }
}

async fn clear(pool: &DbPool, sid: &str) {
    if let Err(e) = db::clear_turn_in_flight(pool, sid).await {
        tracing::warn!("turn_in_flight_clear_failed session_id={} error={}", sid, e);
    }
}
