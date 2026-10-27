//! `/api/agent/sessions/{sid}/goal` — a session's goal (v3 only). A goal
//! starts when the user approves a plan review with `keep_going`
//! (`questions.rs`), or later by running the approved plan as a goal (`POST`
//! here); these routes also read, pause, resume, and clear it.

use super::helpers::{goal_err, resolve_agent_for_existing_session};
use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::{body_value, json, json_code, no_content, path_uuid};
use crate::AppState;
use appv3_agent::plan;
use appv3_db::{self as db, DbPool};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sessions/{session_id}/goal", get(get_goal).post(start_goal).delete(clear_goal))
        .route("/sessions/{session_id}/goal/pause", post(pause_goal))
        .route("/sessions/{session_id}/goal/resume", post(resume_goal))
}

/// A top-level session's id; goals never belong to members.
async fn lead_session_id(pool: &DbPool, raw: &str) -> ApiResult<String> {
    let sid = path_uuid("session_id", raw)?;
    match db::get_session(pool, &sid).await? {
        Some(s) if s.parent_session_id.is_none() => Ok(sid),
        _ => Err(ApiError::not_found("Session not found.")),
    }
}

async fn require_live_goal(pool: &DbPool, sid: &str) -> ApiResult<()> {
    match db::live_session_goal(pool, sid).await? {
        Some(_) => Ok(()),
        None => Err(ApiError::not_found("The session has no goal.")),
    }
}

/// The session's newest goal, ended ones included (`null` when it never had
/// one). Clients hide a cleared goal.
async fn get_goal(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = lead_session_id(&st.pool, &raw).await?;
    let goal = db::latest_session_goal(&st.pool, &sid).await?;
    Ok(json(json!({"goal": goal.as_ref().map(db::SessionGoal::to_api)})))
}

/// Run the session's approved plan as a goal: its Done when is the objective,
/// and the turn limit comes from the body's `max_turns` or Settings. The
/// plan must be approved at its current revision (an edit since approval
/// needs a new review), and the session must have no live goal. The goal
/// starts its first turn when the session is idle and in Code mode; a running
/// turn continues it when it ends.
async fn start_goal(State(st): State<AppState>, AxPath(raw): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    let sid = lead_session_id(&st.pool, &raw).await?;
    let body = if body.is_empty() { json!({}) } else { body_value(&body)? };
    let max_turns = match body.get("max_turns") {
        None | Some(Value::Null) => None,
        Some(n) => Some(n.as_i64().ok_or_else(|| ApiError::validation(vec![verr("int_parsing", &loc(&["body", "max_turns"]), "max_turns should be a valid integer", n.clone())]))?),
    };
    if db::live_session_goal(&st.pool, &sid).await?.is_some() {
        return Err(ApiError::conflict("The session already has a goal."));
    }
    let dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
    let doc = plan::sync(&dir).ok_or_else(|| ApiError::unprocessable("The session has no plan."))?;
    if doc.approved_revision != Some(doc.revision) {
        return Err(ApiError::unprocessable("Approve the plan first: a goal runs the approved plan."));
    }
    let objective = plan::done_when(&doc.content).unwrap_or_default();
    appv3_agent::goal::validate(&objective, max_turns).map_err(goal_err)?;
    let agent = resolve_agent_for_existing_session(&st.pool, &sid).await?;
    agent.start_goal_from_plan(&sid, &objective, max_turns).await.map_err(goal_err)?;
    agent.kick_goal(&sid, false).await;
    let goal = db::latest_session_goal(&st.pool, &sid).await?.ok_or_else(|| ApiError::internal(anyhow::anyhow!("the goal just started is missing")))?;
    Ok(json_code(201, goal.to_api()))
}

/// The current turn finishes; no new goal turn starts.
async fn pause_goal(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = lead_session_id(&st.pool, &raw).await?;
    require_live_goal(&st.pool, &sid).await?;
    let agent = resolve_agent_for_existing_session(&st.pool, &sid).await?;
    let goal = agent.pause_goal(&sid).await.map_err(goal_err)?;
    Ok(json(goal.to_api()))
}

/// Make the goal active again and start its next turn when the session is idle.
async fn resume_goal(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = lead_session_id(&st.pool, &raw).await?;
    require_live_goal(&st.pool, &sid).await?;
    let agent = resolve_agent_for_existing_session(&st.pool, &sid).await?;
    let goal = agent.resume_goal(&sid).await.map_err(goal_err)?;
    Ok(json(goal.to_api()))
}

/// End the live goal; a running turn finishes first. Idempotent.
async fn clear_goal(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = lead_session_id(&st.pool, &raw).await?;
    if db::live_session_goal(&st.pool, &sid).await?.is_some() {
        let agent = resolve_agent_for_existing_session(&st.pool, &sid).await?;
        agent.clear_goal(&sid).await.map_err(goal_err)?;
    }
    Ok(no_content())
}
