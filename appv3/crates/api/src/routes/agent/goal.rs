//! `/api/agent/sessions/{sid}/goal` — a session's `/goal` (v3 only). A goal
//! is set by sending its objective through `POST /chat` with `goal=true`;
//! these routes read, pause, resume, and clear it.

use super::helpers::{goal_err, resolve_agent_for_existing_session};
use crate::error::{ApiError, ApiResult};
use crate::util::{json, no_content, path_uuid};
use crate::AppState;
use appv3_db::{self as db, DbPool};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sessions/{session_id}/goal", get(get_goal).delete(clear_goal))
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
