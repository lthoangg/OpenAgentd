//! What a member sends its lead: the report of a finished turn (its answer,
//! cut to the lead's budget, or why it failed), a question from `ask_lead`,
//! and the delivery that queues an agent-authored row on the lead and
//! starts its turn when it is idle.

use super::state::MemberEvent;
use super::{find_by_session, publish_both, MemberStatus, MAX_SUBAGENT_OUTPUT_CHARS};
use appv3_db::{self as db, DbPool};
use serde_json::{json, Value};

/// A report cut to what the lead receives: its head and tail around a notice
/// that says how to get the rest. The whole text stays in the subagent's own
/// conversation, which the lead cannot read, so it asks `handle` for it.
pub(super) fn prune_subagent_output(output: &str, handle: &str, max_chars: usize) -> String {
    let n = output.chars().count();
    if n <= max_chars {
        return output.to_string();
    }
    let head_len = 500usize.max(max_chars.saturating_sub(1000));
    let tail_len = 400usize.min(max_chars.saturating_sub(head_len));
    let head = crate::util::head_chars(output, head_len).trim_end();
    let tail = if tail_len > 0 { crate::util::tail_chars(output, tail_len).trim_start() } else { "" };
    format!(
        "{head}\n\n[... Output truncated: {n} chars total exceeds lead message budget of {max_chars} chars. {handle} still has the whole text: ask it for the part you need with team(target='{handle}', task='...') ...]\n\n{tail}"
    )
}

/// Whether running the failed turn again could succeed, from its error code.
fn retry_may_help(code: &str) -> Option<bool> {
    match code {
        "provider_rate_limit" | "provider_connection_failed" | "agent_execution_failed" => Some(true),
        "provider_auth_failed" | "agent_not_configured" | "model_refusal" | "provider_request_failed" => Some(false),
        _ => None,
    }
}

/// What the lead reads when a member's turn fails: the reason, and what it
/// can do next. `error` is the turn's `format_agent_error`; `fallback` the
/// reason recorded without one (a turn that was refused before it ran).
pub(super) fn failure_report(handle: &str, error: Option<&Value>, fallback: Option<&str>) -> String {
    let text = |k: &str| error.and_then(|e| e.get(k)).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let message = text("message").or(fallback.map(str::trim).filter(|s| !s.is_empty())).unwrap_or("its turn failed with an unknown error");
    let reason = match text("title") {
        Some(t) => format!("{t}: {}", message.trim_end_matches('.')),
        None => message.trim_end_matches('.').to_string(),
    };
    let next = match text("code").and_then(retry_may_help) {
        Some(true) => format!("Retrying may help: team(target='{handle}', task='continue'). Or give the task to another profile, or do it yourself."),
        Some(false) => "Retrying won't help until its model or provider is fixed. Give the task to another profile, or do it yourself.".to_string(),
        None => format!("Retry it with team(target='{handle}', task='continue'), give the task to another profile, or do it yourself."),
    };
    format!("{handle} failed: {reason}. Its work so far is kept in its session. {next}")
}

/// `deliver_message_to_lead`.
pub(crate) async fn deliver_message_to_lead(lead: &str, handle: &str, content: &str, pool: &DbPool) -> anyhow::Result<()> {
    let mut extra = serde_json::Map::new();
    extra.insert("from_agent".into(), json!(handle));
    deliver_agent_message(lead, content, extra, pool).await
}

/// Queue an agent-authored user row (`extra` names the sender) on a lead
/// session and start its turn when it is idle; a busy turn picks it up.
pub(crate) async fn deliver_agent_message(lead: &str, content: &str, extra: serde_json::Map<String, Value>, pool: &DbPool) -> anyhow::Result<()> {
    let row = db::save_queued_user_message(pool, lead, content, Some(extra)).await?;
    crate::broadcaster::publish_session_activity(lead, &row.created_at);
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
///
/// `error` is the failed turn's `format_agent_error`, so the lead learns
/// why its member failed, not just that it did.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn on_subagent_turn_completed(lead: &str, child: &str, status: &str, workspace: &str, handle: &str, pool: &DbPool, cancelled: bool, error: Option<&Value>) {
    let end = MemberStatus::turn_end(status, cancelled);
    // Settle the member under its senders' lock: a follow-up is either queued
    // before the look at the queue below, or queued after the member is
    // settled, where `send_subagent_message` reads this end and marks it
    // working. Unlocked, a send landing between the look and the write was
    // overwritten. The report below is sent after the lock is released.
    let member = find_by_session(lead, child, |i| i.session.clone());
    let senders = match &member {
        Some(s) => Some(s.user_message_lock.lock().await),
        None => None,
    };
    // A follow-up the lead queued while this turn ran starts next (see
    // `send_subagent_message`); this turn still reports its own answer.
    let follow_up_queued = end == MemberStatus::Completed
        && match db::has_queued_user_messages(pool, child).await {
            Ok(queued) => queued,
            Err(e) => {
                // The turn's own end stands; the turn's last look at the
                // queue still starts any follow-up.
                tracing::warn!("subagent_follow_up_check_failed lead={} session_id={} error={}", lead, child, e);
                false
            }
        };
    let next = end.after_turn(follow_up_queued);
    let st = next.as_str();
    let message = error.and_then(|e| e.get("message")).and_then(Value::as_str).map(str::to_string);
    let inst = find_by_session(lead, child, |i| {
        let _ = i.apply(MemberEvent::TurnEnded { end, follow_up_queued, error: message.clone() });
        i.clone()
    });
    let effective_handle = match &inst {
        Some(i) => i.handle.clone(),
        None if !handle.is_empty() => handle.to_string(),
        None => format!("subagent-{}", crate::util::head_chars(child, 8)),
    };
    publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child, "handle": effective_handle, "status": st, "workspace": workspace}));
    drop(senders);
    // A stopped turn reports nothing; the member keeps its conversation.
    if !end.reports() {
        return;
    }
    let output = if end == MemberStatus::Completed {
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
        find_by_session(lead, child, |i| i.result_delivered = true);
        failure_report(&effective_handle, error, inst.as_ref().and_then(|i| i.last_error.as_deref()))
    };
    let deliverable = prune_subagent_output(&output, &effective_handle, MAX_SUBAGENT_OUTPUT_CHARS);
    match deliver_message_to_lead(lead, &effective_handle, &deliverable, pool).await {
        // From here the lead has its answer: the member may leave memory.
        Ok(()) if end == MemberStatus::Completed => {
            find_by_session(lead, child, |i| i.reported_at = Some(std::time::Instant::now()));
        }
        Ok(()) => {}
        Err(e) => tracing::warn!("Failed to deliver subagent result to lead: {}", e),
    }
}

/// `on_subagent_question_asked`.
pub(crate) async fn on_subagent_question_asked(lead: &str, child: &str, data: &Value, pool: &DbPool) {
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
    publish_both(lead, "subagent_status", json!({"lead_session_id": lead, "session_id": child, "handle": handle, "status": MemberStatus::WaitingLead.as_str()}));
    let q = data.get("question").map(crate::pystr::py_str).unwrap_or_default();
    let opts: Vec<String> = data.get("options").and_then(|o| o.as_array()).map(|a| a.iter().map(crate::pystr::py_str).collect()).unwrap_or_default();
    let opts_text = if opts.is_empty() { String::new() } else { format!(" (Options: {})", opts.join(", ")) };
    let content = format!("Question from {handle}: {q}{opts_text}\nTo reply, call team(profile='{profile}', target='{handle}', task='<your answer>').");
    if let Err(e) = deliver_message_to_lead(lead, &handle, &content, pool).await {
        tracing::warn!("Failed to deliver subagent question to lead: {}", e);
    }
}
