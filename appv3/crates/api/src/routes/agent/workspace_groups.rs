//! Workspace groups (v3 only): named tags on repositories that scope
//! cross-workspace messages (`appv3_agent::workspace_messages::can_reach`)
//! and colour the sidebar. Members are repository paths; a worktree is
//! tagged through its repository.

use super::helpers::validate_workspace_or_422;
use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_core::settings::settings;
use appv3_db::{self as db, GroupError};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, patch, put};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/workspace/groups", get(list_groups).post(create_group))
        .route("/workspace/groups/members", put(set_members))
        .route("/workspace/groups/{group_id}", patch(update_group).delete(delete_group))
}

fn group_err(e: GroupError) -> ApiError {
    match e {
        GroupError::Invalid(m) => ApiError::unprocessable(m),
        GroupError::NotFound => ApiError::not_found("Workspace group not found."),
        GroupError::Db(e) => ApiError::internal(e),
    }
}

fn obj_body(raw: &[u8]) -> ApiResult<Value> {
    let b = body_value(raw)?;
    if !b.is_object() {
        return Err(ApiError::validation(vec![verr("model_attributes_type", &loc(&["body"]), "Input should be a valid dictionary or object to extract fields from", b)]));
    }
    Ok(b)
}

/// `brief` / `color`: absent → leave as is, `null` → clear, string → set.
fn nullable_str_field(b: &Value, key: &str) -> ApiResult<Option<Option<String>>> {
    match b.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(other) => Err(ApiError::validation(vec![verr("string_type", &loc(&["body", key]), "Input should be a valid string", other.clone())])),
    }
}

/// Visible repository paths (not worktrees, not hidden or deleted).
async fn visible_repos(pool: &db::DbPool) -> ApiResult<HashSet<String>> {
    Ok(db::list_visible_coding_workspaces(pool).await?.into_iter().filter(|r| r.kind != "worktree").map(|r| r.path).collect())
}

async fn list_groups(State(st): State<AppState>) -> ApiResult<Response> {
    let groups = db::list_workspace_groups(&st.pool).await.map_err(group_err)?;
    let memberships = db::list_group_memberships(&st.pool).await.map_err(group_err)?;
    let visible = visible_repos(&st.pool).await?;
    let out: Vec<Value> = groups
        .iter()
        .map(|g| {
            let mut v = g.to_api();
            let members: Vec<&str> = memberships.iter().filter(|(id, p)| *id == g.id && visible.contains(p)).map(|(_, p)| p.as_str()).collect();
            v["members"] = json!(members);
            v
        })
        .collect();
    Ok(json(json!({"groups": out})))
}

async fn create_group(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = obj_body(&raw)?;
    let Some(name) = opt_str_field(&b, "name")? else {
        return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "name"]), "Field required", b.clone())]));
    };
    let brief = nullable_str_field(&b, "brief")?.flatten();
    let color = nullable_str_field(&b, "color")?.flatten();
    let g = db::create_workspace_group(&st.pool, &name, brief.as_deref(), color.as_deref()).await.map_err(group_err)?;
    let mut v = g.to_api();
    v["members"] = json!([]);
    Ok(json(v))
}

async fn update_group(State(st): State<AppState>, AxPath(raw_id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let id = path_uuid("group_id", &raw_id)?;
    let b = obj_body(&raw)?;
    let name = opt_str_field(&b, "name")?;
    let brief = nullable_str_field(&b, "brief")?;
    let color = nullable_str_field(&b, "color")?;
    let g = db::update_workspace_group(&st.pool, &id, name.as_deref(), brief.as_ref().map(|b| b.as_deref()), color.as_ref().map(|c| c.as_deref())).await.map_err(group_err)?;
    Ok(json(g.to_api()))
}

async fn delete_group(State(st): State<AppState>, AxPath(raw_id): AxPath<String>) -> ApiResult<Response> {
    let id = path_uuid("group_id", &raw_id)?;
    if !db::delete_workspace_group(&st.pool, &id).await.map_err(group_err)? {
        return Err(ApiError::not_found("Workspace group not found."));
    }
    Ok(json(json!({"deleted": true})))
}

/// Replace a repository's groups. A worktree path tags its repository.
async fn set_members(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = obj_body(&raw)?;
    let Some(ws) = opt_str_field(&b, "workspace")? else {
        return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "workspace"]), "Field required", b.clone())]));
    };
    let ids = match b.get("group_ids") {
        Some(Value::Array(items)) => {
            let mut ids = vec![];
            for (i, item) in items.iter().enumerate() {
                let parsed = item.as_str().and_then(py_uuid);
                let Some(id) = parsed else {
                    return Err(ApiError::validation(vec![verr("uuid_parsing", &[json!("body"), json!("group_ids"), json!(i)], "Input should be a valid UUID", item.clone())]));
                };
                ids.push(id);
            }
            ids
        }
        None => return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "group_ids"]), "Field required", b.clone())])),
        Some(other) => return Err(ApiError::validation(vec![verr("list_type", &loc(&["body", "group_ids"]), "Input should be a valid list", other.clone())])),
    };
    let mut workspace = validate_workspace_or_422(&ws, false)?;
    let s = settings();
    if s.is_chat_workspace(Some(Path::new(&workspace))) {
        return Err(ApiError::unprocessable("Chat can already message every workspace."));
    }
    if let Some(row) = db::get_workspace_by_path(&st.pool, &workspace).await? {
        if let Some(src) = row.source_path.filter(|p| row.kind == "worktree" && !p.is_empty()) {
            workspace = src;
        }
    }
    let group_ids = db::set_workspace_groups(&st.pool, &workspace, &ids).await.map_err(group_err)?;
    Ok(json(json!({"workspace": workspace, "group_ids": group_ids})))
}
