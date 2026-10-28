//! Changes the user confirms on a card before they apply.
//!
//! A tool that changes OpenAgentd's setup (an MCP server, a repository's
//! workspace groups) does not apply the change itself: it validates it,
//! stores it on a pending question of kind [`CONFIRM_KIND`] and pauses the
//! turn. The card is the ordinary question card with **Apply** and
//! **Cancel**. When the user answers, [`answer`] runs on the server: only
//! **Apply** runs the stored change, through the applier registered for its
//! `type`, which checks it against the current state first. The model never
//! sees an "apply" step it could take on its own.

use appv3_db::{self as db, DbPool, PendingQuestion};
use appv3_tools::{Suspension, ToolContext, ToolError, ToolOutput, ToolResult};
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

pub const CONFIRM_KIND: &str = "confirm_change";
pub const APPLY_LABEL: &str = "Apply";
pub const CANCEL_LABEL: &str = "Cancel";
/// Longest typed answer (the user's reason for not applying).
pub const MAX_ANSWER_CHARS: usize = 2000;

/// The tool result of a confirming call that was not run because another
/// call in the same response already waits on the user.
pub const CONFIRM_DEFERRED: &str =
    "Not run: this response already waits on the user (a question or another change to confirm), and they confirm one change at a time. Call it again after they answer.";

/// A change ready for the card: what the user reads, and what applies.
pub struct Proposal {
    /// One paragraph (inline Markdown) saying exactly what changes.
    pub question: String,
    /// The Apply option's description: the effect of applying.
    pub apply: String,
    /// Stored on the question; `type` names its applier.
    pub change: Value,
}

/// Applies a stored change, or says why it no longer can. `Ok` is the
/// outcome the agent reads (with no secrets in it).
pub type Applier = Arc<dyn Fn(DbPool, Value) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

fn appliers() -> &'static RwLock<HashMap<String, Applier>> {
    static A: OnceLock<RwLock<HashMap<String, Applier>>> = OnceLock::new();
    A.get_or_init(Default::default)
}

/// Register how changes of `change_type` apply (the MCP crate registers its own).
pub fn register_applier(change_type: &str, f: Applier) {
    appliers().write().unwrap().insert(change_type.to_string(), f);
}

fn applier(change_type: &str) -> Option<Applier> {
    if change_type == crate::workspace_groups::SET_GROUPS_CHANGE {
        return Some(Arc::new(|pool, change| Box::pin(async move { crate::workspace_groups::apply(&pool, &change).await })));
    }
    appliers().read().unwrap().get(change_type).cloned()
}

/// Whether `name(arguments)` opens a confirmation card, so the agent loop
/// runs it last, like a question.
pub fn opens(name: &str, arguments: &str) -> bool {
    let action = serde_json::from_str::<Value>(arguments).ok().and_then(|a| a.get("action").and_then(Value::as_str).map(|s| s.trim().to_string())).unwrap_or_default();
    match name {
        "mcp" => matches!(action.as_str(), "save" | "remove"),
        "workspace" => action == "set_groups",
        _ => false,
    }
}

/// The `pending_questions` payload of a confirmation card.
pub fn payload(p: &Proposal) -> Value {
    json!({
        "kind": CONFIRM_KIND,
        "change": p.change,
        "questions": [{
            "question": p.question,
            "header": "Confirm change",
            "options": [
                {"label": APPLY_LABEL, "description": p.apply, "recommended": false},
                {"label": CANCEL_LABEL, "description": "Change nothing.", "recommended": false},
            ],
            "multiple": false,
            "custom": true,
        }],
    })
}

fn in_plan_mode(ctx: &ToolContext) -> bool {
    ctx.metadata.lock().unwrap().get("interaction_mode").and_then(Value::as_str) == Some("plan")
}

/// Open the card for `proposal` and pause the turn. `pool` falls back to
/// the agent manager's.
pub async fn ask(ctx: &ToolContext, pool: Option<&DbPool>, tool_name: &str, proposal: Proposal) -> ToolResult {
    if in_plan_mode(ctx) {
        return Err(ToolError::Execution("Changes are unavailable in Plan mode; describe the change in the plan instead.".into()));
    }
    let pool = match pool.cloned().or_else(crate::manager::try_pool) {
        Some(p) => p,
        None => return Err(ToolError::Execution("This change needs the user's confirmation, and there is no session to ask in.".into())),
    };
    let Some(session_id) = ctx.session_id.clone().filter(|s| !s.is_empty()) else {
        return Err(ToolError::Execution("This change needs the user's confirmation, and there is no session to ask in.".into()));
    };
    if ctx.tool_call_id.is_empty() {
        return Ok(ToolOutput::text("The change could not be shown to the user (no tool call id). Nothing changed."));
    }
    let payload = payload(&proposal);
    let row = db::create_pending_question_with(&pool, &session_id, &ctx.tool_call_id, tool_name, &payload).await.map_err(ToolError::exec)?;
    let sid = db::codec::api_uuid(&db::codec::db_id(&session_id));
    let qid = db::codec::api_uuid(&row.id);
    let questions = payload["questions"].as_array().cloned().unwrap_or_default();
    crate::store().push_event(&sid, &crate::events::question_asked(&qid, &sid, &ctx.tool_call_id, &questions), false);
    let headline = proposal.question.clone();
    crate::tools::publish_input_needed(&pool, &session_id, &qid, "Confirm change", |_| headline).await;
    tracing::info!("confirm_change_opened session_id={} question_id={} type={}", sid, qid, proposal.change["type"].as_str().unwrap_or(""));
    Err(ToolError::Suspended(Suspension::Question { question_id: qid, session_id: sid }))
}

/// The user's answer to a card.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Apply,
    /// Cancel, with what they typed instead, if anything.
    Cancel(Option<String>),
}

/// Only a lone **Apply** applies; anything typed is a reason not to.
pub fn decision(answers: &[Vec<String>]) -> Decision {
    let picked: Vec<String> = answers.first().into_iter().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if picked.len() == 1 && picked[0] == APPLY_LABEL {
        return Decision::Apply;
    }
    let typed: Vec<&str> = picked.iter().map(String::as_str).filter(|s| *s != CANCEL_LABEL && *s != APPLY_LABEL).collect();
    Decision::Cancel(if typed.is_empty() { None } else { Some(typed.join("\n")) })
}

/// The tool result the agent reads after the user answered.
pub fn result_text(decision: &Decision, applied: Option<&Result<String, String>>) -> String {
    match (decision, applied) {
        (Decision::Apply, Some(Ok(outcome))) => format!("The user applied the change. {outcome}"),
        (Decision::Apply, Some(Err(why))) => format!("The user chose Apply, but the change was not applied: {why} Nothing changed."),
        (Decision::Apply, None) => "The user chose Apply, but the change was not applied. Nothing changed.".into(),
        (Decision::Cancel(None), _) => "The user cancelled the change; nothing changed. Don't propose it again unless they ask.".into(),
        (Decision::Cancel(Some(said)), _) => format!("The user did not apply the change; nothing changed. They said:\n\n{said}"),
    }
}

/// The change a card stores.
pub fn change_of(row: &PendingQuestion) -> Option<Value> {
    serde_json::from_str::<Value>(&row.payload).ok().and_then(|p| p.get("change").cloned()).filter(Value::is_object)
}

/// Close the open card `question_id` with `answers`, applying its change on
/// **Apply**. `None` when it was no longer open (already answered, or the
/// user moved on). One answer runs at a time, so a change applies at most once.
pub async fn answer(pool: &DbPool, session_id: &str, question_id: &str, answers: &[Vec<String>]) -> anyhow::Result<Option<String>> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = LOCK.lock().await;
    let Some(row) = db::get_question(pool, question_id).await?.filter(|r| r.status == "pending") else { return Ok(None) };
    let decision = decision(answers);
    let applied = match decision {
        Decision::Apply => Some(apply(pool, session_id, &row).await),
        Decision::Cancel(_) => None,
    };
    let text = result_text(&decision, applied.as_ref());
    let av = json!(answers);
    if db::resolve_pending_question_with(pool, question_id, "answered", Some(&av), Some(&text)).await?.is_none() {
        return Ok(None);
    }
    tracing::info!("confirm_change_answered session_id={} question_id={} applied={}", session_id, question_id, matches!(applied, Some(Ok(_))));
    Ok(Some(text))
}

async fn apply(pool: &DbPool, session_id: &str, row: &PendingQuestion) -> Result<String, String> {
    // The session may have switched to Plan mode while the card was open.
    if db::get_session(pool, session_id).await.ok().flatten().is_some_and(|s| s.interaction_mode == "plan") {
        return Err("the session is in Plan mode now.".into());
    }
    let change = change_of(row).ok_or("the card holds no change.")?;
    let ty = change["type"].as_str().unwrap_or_default().to_string();
    let f = applier(&ty).ok_or_else(|| format!("no way to apply a '{ty}' change."))?;
    f(pool.clone(), change).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(items: &[&str]) -> Vec<Vec<String>> {
        vec![items.iter().map(|s| s.to_string()).collect()]
    }

    #[test]
    fn only_a_lone_apply_applies() {
        assert_eq!(decision(&a(&["Apply"])), Decision::Apply);
        assert_eq!(decision(&a(&[" Apply "])), Decision::Apply);
        assert_eq!(decision(&a(&["Cancel"])), Decision::Cancel(None));
        assert_eq!(decision(&[]), Decision::Cancel(None));
        assert_eq!(decision(&a(&["apply"])), Decision::Cancel(Some("apply".into())), "a typed answer is not the option");
        assert_eq!(decision(&a(&["Apply", "but only on Monday"])), Decision::Cancel(Some("but only on Monday".into())));
        assert_eq!(decision(&a(&["Use port 9000"])), Decision::Cancel(Some("Use port 9000".into())));
    }

    #[test]
    fn the_result_says_whether_anything_changed() {
        assert_eq!(result_text(&Decision::Apply, Some(&Ok("Server 'x' is ready.".into()))), "The user applied the change. Server 'x' is ready.");
        assert!(result_text(&Decision::Apply, Some(&Err("it changed since.".into()))).ends_with("not applied: it changed since. Nothing changed."));
        assert!(result_text(&Decision::Cancel(None), None).starts_with("The user cancelled the change; nothing changed."));
        assert!(result_text(&Decision::Cancel(Some("Not now".into())), None).ends_with("They said:\n\nNot now"));
    }

    #[test]
    fn mutating_actions_open_a_card() {
        assert!(opens("mcp", r#"{"action": "save", "server": "x"}"#));
        assert!(opens("mcp", r#"{"action": "remove"}"#));
        assert!(!opens("mcp", r#"{"action": "servers"}"#));
        assert!(!opens("mcp", r#"{"action": "call"}"#));
        assert!(opens("workspace", r#"{"action": "set_groups"}"#));
        assert!(!opens("workspace", r#"{"action": "list"}"#));
        assert!(!opens("workspace", "not json"));
        assert!(!opens("shell", r#"{"action": "save"}"#));
    }

    #[test]
    fn the_card_is_a_question_with_apply_and_cancel() {
        let p = payload(&Proposal { question: "Add `x`.".into(), apply: "Starts it now.".into(), change: json!({"type": "t"}) });
        assert_eq!(p["kind"], CONFIRM_KIND);
        assert_eq!(p["change"], json!({"type": "t"}));
        let labels: Vec<&str> = p["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, vec![APPLY_LABEL, CANCEL_LABEL]);
    }
}
