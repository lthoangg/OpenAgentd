//! Git worktree routes.

use crate::error::{loc, verr, verr_ctx, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::manager;
use appv3_db::{self as db, DbPool};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use appv3_agent::worktrees as wt;
pub use appv3_agent::worktrees::{
    canonical, find_managed_worktree_source, has_ancestor, is_managed_for, list_entries as git_list_entries, worktree_root, GitError, GitOut, WorktreeInfo, OWN_BRANCH_PREFIXES,
};

impl From<GitError> for ApiError {
    fn from(e: GitError) -> Self {
        ApiError::new(e.status, e.detail)
    }
}

/// `subprocess.run(["git", "-C", ws, *args], timeout=20)`.
pub async fn run_git(ws: &Path, args: &[&str]) -> ApiResult<GitOut> {
    Ok(wt::run_git(ws, args).await?)
}

/// See [`appv3_agent::worktrees::run_git_timeout`].
pub async fn run_git_timeout(ws: &Path, args: &[&str], timeout: Duration) -> ApiResult<GitOut> {
    Ok(wt::run_git_timeout(ws, args, timeout).await?)
}

async fn require_git_repo(ws: &Path) -> ApiResult<()> {
    Ok(wt::require_git_repo(ws).await?)
}

async fn list_entries(source: &Path) -> ApiResult<Vec<(String, Option<String>)>> {
    Ok(git_list_entries(source).await?)
}

pub fn router() -> Router<AppState> {
    Router::new().route("/workspace/worktrees", get(list_worktrees).delete(remove_worktree).patch(rename_worktree).post(create_worktree_route))
}

fn validated_source(ws: &str) -> ApiResult<PathBuf> {
    manager::validate_workspace(ws, true).map(PathBuf::from).map_err(ApiError::unprocessable)
}

async fn list_worktrees(q: Qs) -> ApiResult<Response> {
    let source = validated_source(&q.req("source_workspace")?)?;
    require_git_repo(&source).await?;
    let source_real = resolve(&source);
    let mut out = vec![];
    for (dir, branch) in list_entries(&source).await? {
        if dir.is_empty() || resolve(Path::new(&dir)) == source_real {
            continue;
        }
        let r = resolve(Path::new(&dir));
        out.push(json!({
            "name": r.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            "directory": r.display().to_string(),
            "branch": branch,
            "managed": is_managed_for(&r, &source),
        }));
    }
    Ok(json(Value::Array(out)))
}

fn req_str(b: &Value, k: &str, errs: &mut Vec<Value>) -> String {
    match b.get(k) {
        Some(Value::String(s)) => s.clone(),
        None => {
            errs.push(verr("missing", &loc(&["body", k]), "Field required", b.clone()));
            String::new()
        }
        Some(o) => {
            errs.push(verr("string_type", &loc(&["body", k]), "Input should be a valid string", o.clone()));
            String::new()
        }
    }
}

fn obj_body(raw: &[u8]) -> ApiResult<Value> {
    let b = body_value(raw)?;
    if !b.is_object() {
        return Err(ApiError::validation(vec![verr("model_attributes_type", &loc(&["body"]), "Input should be a valid dictionary or object to extract fields from", b)]));
    }
    Ok(b)
}

async fn remove_worktree(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = obj_body(&raw)?;
    let mut errs = vec![];
    let src = req_str(&b, "source_workspace", &mut errs);
    let dir = req_str(&b, "directory", &mut errs);
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let source = validated_source(&src)?;
    require_git_repo(&source).await?;
    let directory = canonical(Path::new(&dir));
    if !is_managed_for(&directory, &source) {
        return Err(ApiError::new(403, "Only OpenAgentd-managed worktrees can be removed."));
    }
    // `dry_run` reports what the removal would do to the branch, for the
    // confirmation dialog.
    let dry_run = opt_bool_field(&b, "dry_run")?.unwrap_or(false);
    let done = wt::remove_worktree(&source, &directory, dry_run).await?;
    if !dry_run {
        db::mark_coding_workspace_deleted(&st.pool, &directory.display().to_string()).await?;
    }
    Ok(json(json!({"removed": !dry_run, "branch": done.branch, "branch_deleted": done.branch_deleted, "unmerged_commits": done.unmerged_commits})))
}

async fn rename_worktree(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = obj_body(&raw)?;
    let mut errs = vec![];
    let dir = req_str(&b, "directory", &mut errs);
    let name = req_str(&b, "name", &mut errs);
    if errs.is_empty() {
        let n = name.chars().count();
        if n < 1 {
            errs.push(verr_ctx("string_too_short", &loc(&["body", "name"]), "String should have at least 1 character", json!(name), json!({"min_length": 1})));
        } else if n > 255 {
            errs.push(verr_ctx("string_too_long", &loc(&["body", "name"]), "String should have at most 255 characters", json!(name), json!({"max_length": 255})));
        }
    }
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let directory = canonical(Path::new(&dir));
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::unprocessable("Worktree title is required."));
    }
    let row = db::rename_coding_workspace(&st.pool, &directory.display().to_string(), name).await?;
    let display = row.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| directory.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    Ok(json(json!({"name": display, "directory": row.path, "branch": null, "managed": row.managed})))
}

/// `create_coding_workspace_worktree` (shared with `/sessions/resolve`).
pub async fn create_worktree(pool: &DbPool, source_workspace: &str, name: Option<&str>, branch: Option<&str>, detached: bool) -> ApiResult<WorktreeInfo> {
    Ok(wt::create_worktree(pool, source_workspace, name, branch, detached).await?)
}

async fn create_worktree_route(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = obj_body(&raw)?;
    let mut errs = vec![];
    let src = req_str(&b, "source_workspace", &mut errs);
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let name = opt_str_field(&b, "name")?;
    if name.as_ref().map(|n| n.chars().count() > 80).unwrap_or(false) {
        return Err(ApiError::validation(vec![verr_ctx(
            "string_too_long",
            &loc(&["body", "name"]),
            "String should have at most 80 characters",
            json!(name),
            json!({"max_length": 80}),
        )]));
    }
    let branch = opt_str_field(&b, "branch")?;
    if branch.as_ref().map(|n| n.chars().count() > 255).unwrap_or(false) {
        return Err(ApiError::validation(vec![verr_ctx(
            "string_too_long",
            &loc(&["body", "branch"]),
            "String should have at most 255 characters",
            json!(branch),
            json!({"max_length": 255}),
        )]));
    }
    let detached = opt_bool_field(&b, "detached")?.unwrap_or(false);
    let info = create_worktree(&st.pool, &src, name.as_deref(), branch.as_deref(), detached).await?;
    let source = validated_source(&src)?;
    Ok(json(json!({
        "name": info.name,
        "directory": info.directory,
        "branch": info.branch,
        "managed": true,
        "source_workspace": source.display().to_string(),
    })))
}
