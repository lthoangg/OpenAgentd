//! The sidebar's workspaces: validating and browsing for a folder, hiding,
//! relocating and registering a repository, and the workspace tree.

use super::super::helpers::*;
use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::manager;
use appv3_core::settings;
use appv3_db::{self as db, DbPool};
use axum::extract::State;
use axum::response::Response;
use bytes::Bytes;
use serde_json::{json, Map, Value};
use std::path::Path;

// ── workspace pickers ───────────────────────────────────────────────────────

pub(super) async fn validate_workspace(q: Qs) -> ApiResult<Response> {
    let ws = q.req("workspace")?;
    let resolved = manager::validate_workspace(&ws, true).map_err(ApiError::unprocessable)?;
    Ok(json(json!({"workspace": resolved})))
}

pub(super) async fn browse_workspace(q: Qs) -> ApiResult<Response> {
    let path = q.opt("path").filter(|p| !p.is_empty());
    blocking(move || {
        let root = match &path {
            Some(p) => resolve(&expanduser(p)),
            None => resolve(&home()),
        };
        if !root.is_dir() {
            return Err(ApiError::unprocessable(format!("Not a directory: {}", root.display())));
        }
        let rd = std::fs::read_dir(&root).map_err(|_| ApiError::new(403, format!("Cannot read directory: {}", root.display())))?;
        let mut entries: Vec<std::fs::DirEntry> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        let mut dirs = vec![];
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if e.path().is_dir() {
                dirs.push(json!({"name": name, "path": resolve(&e.path()).display().to_string()}));
            }
        }
        let parent = root.parent().filter(|p| *p != root.as_path()).map(|p| p.display().to_string());
        Ok(json(json!({"path": root.display().to_string(), "parent": parent, "directories": dirs})))
    })
    .await
}

pub(super) async fn update_visibility(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = body_value(&raw)?;
    let mut errs = vec![];
    let ws = match b.get("workspace") {
        Some(Value::String(s)) => s.clone(),
        None => {
            errs.push(verr("missing", &loc(&["body", "workspace"]), "Field required", b.clone()));
            String::new()
        }
        Some(o) => {
            errs.push(verr("string_type", &loc(&["body", "workspace"]), "Input should be a valid string", o.clone()));
            String::new()
        }
    };
    let hidden = match b.get("hidden") {
        None => {
            errs.push(verr("missing", &loc(&["body", "hidden"]), "Field required", b.clone()));
            false
        }
        Some(_) => match opt_bool_field(&b, "hidden") {
            Ok(v) => v.unwrap_or(false),
            Err(e) => return Err(e),
        },
    };
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let workspace = validate_workspace_or_422(&ws, !hidden)?;
    if hidden {
        db::hide_coding_workspace(&st.pool, &workspace).await?;
    } else {
        register_session_workspace(&st.pool, &workspace).await?;
    }
    Ok(json(json!({"workspace": workspace, "hidden": hidden})))
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// `POST /agent/workspace/relocate {from, to, dry_run?}` (v3 addition): a
/// sidebar repository whose folder is gone (renamed, moved) takes the
/// folder `to`, keeping its sessions, worktrees, scheduled tasks and
/// groups. `dry_run` answers what would move, for the confirmation.
pub(super) async fn relocate_workspace(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let b = body_value(&raw)?;
    let mut errs = vec![];
    let mut field = |k: &str| match b.get(k) {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        None => {
            errs.push(verr("missing", &loc(&["body", k]), "Field required", b.clone()));
            String::new()
        }
        Some(o) => {
            errs.push(verr("string_type", &loc(&["body", k]), "Input should be a non-empty string", o.clone()));
            String::new()
        }
    };
    let (from, to) = (field("from"), field("to"));
    let dry_run = opt_bool_field(&b, "dry_run")?.unwrap_or(false);
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    use appv3_agent::worktrees::RelocateError;
    let report = appv3_agent::worktrees::relocate_repository(&st.pool, &from, &to, dry_run).await.map_err(|e| match e {
        RelocateError::Invalid(d) => ApiError::unprocessable(d),
        RelocateError::Busy(titles) => ApiError::conflict(format!("Stop the running sessions first: {}.", titles.join(", "))),
    })?;
    let s = &report.summary;
    Ok(json(json!({
        "from": from,
        "workspace": report.workspace,
        "dry_run": dry_run,
        "sessions": s.sessions,
        "scheduled_tasks": s.scheduled_tasks,
        "worktrees": s.worktrees.iter().map(|(p, managed)| json!({"path": p, "managed": managed})).collect::<Vec<_>>(),
        "groups": s.groups,
        "merge": s.merge,
        "target_sessions": s.target_sessions,
        "moved_worktrees": report.moved.iter().map(|(old, new)| json!({"from": old, "to": new})).collect::<Vec<_>>(),
        "warnings": report.warnings,
    })))
}

/// Whether `path` is inside a Git working tree: it or a parent holds `.git`
/// (a folder in a repository, a file in a worktree). Stats only, so the tree
/// can say it for every workspace without starting `git`.
fn in_git_work_tree(path: &Path) -> bool {
    path.ancestors().any(|dir| dir.join(".git").exists())
}

pub(super) async fn workspace_tree(State(st): State<AppState>) -> ApiResult<Response> {
    let s = settings();
    let chat_path = s.chat_workspace_root().display().to_string();
    let rows = db::list_visible_coding_workspaces(&st.pool).await?;
    // Workspace groups: each repository's tags plus the groups themselves.
    let memberships = db::list_group_memberships(&st.pool).await.map_err(ApiError::internal)?;
    let group_ids = |path: &str| -> Vec<String> { memberships.iter().filter(|(_, p)| p == path).map(|(g, _)| db::codec::api_uuid(g)).collect() };
    let groups: Vec<Value> = db::list_workspace_groups(&st.pool)
        .await
        .map_err(ApiError::internal)?
        .iter()
        .map(|g| json!({"id": db::codec::api_uuid(&g.id), "name": g.name, "brief": g.brief, "color": g.color}))
        .collect();
    let mut repos: Vec<(String, Map<String, Value>)> = vec![];
    let mut pending = vec![];
    for row in rows {
        if s.is_chat_workspace(Some(Path::new(&row.path))) || s.is_chat_workspace(row.source_path.as_deref().map(Path::new)) {
            continue;
        }
        if row.kind == "worktree" || row.kind == "folder" {
            pending.push(row);
            continue;
        }
        let name = row.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| basename(&row.path));
        let entry = json!({
            "path": row.path,
            "name": name,
            "worktrees": [],
            "group_ids": group_ids(&row.path),
            "missing": !Path::new(&row.path).is_dir(),
            // The client offers the Changes view and worktrees only where there is Git.
            "git": in_git_work_tree(Path::new(&row.path)),
        });
        match repos.iter_mut().find(|(p, _)| *p == row.path) {
            Some(slot) => slot.1 = entry.as_object().unwrap().clone(),
            None => repos.push((row.path.clone(), entry.as_object().unwrap().clone())),
        }
    }
    for row in pending {
        let Some(source) = row.source_path.clone().filter(|p| !p.is_empty()) else { continue };
        if !repos.iter().any(|(p, _)| *p == source) {
            let missing = !Path::new(&source).is_dir();
            repos.push((
                source.clone(),
                json!({"path": source, "name": basename(&source), "worktrees": [], "group_ids": group_ids(&source), "missing": missing, "git": in_git_work_tree(Path::new(&source))})
                    .as_object()
                    .unwrap()
                    .clone(),
            ));
        }
        // A subfolder shows its path inside the repository (`web/app`).
        let rel = Path::new(&row.path).strip_prefix(&source).ok().map(|r| r.display().to_string()).filter(|r| !r.is_empty());
        let default_name = match (row.kind.as_str(), rel) {
            ("folder", Some(r)) => r,
            _ => basename(&row.path),
        };
        let name = row.name.clone().filter(|n| !n.is_empty() && !(row.kind == "folder" && *n == basename(&row.path))).unwrap_or(default_name);
        let slot = repos.iter_mut().find(|(p, _)| *p == source).unwrap();
        slot.1.get_mut("worktrees").unwrap().as_array_mut().unwrap().push(json!({
            "path": row.path,
            "name": name,
            "managed": row.managed,
            "kind": row.kind,
            "missing": !Path::new(&row.path).is_dir(),
        }));
    }
    Ok(json(json!({
        "repositories": repos.into_iter().map(|(_, m)| Value::Object(m)).collect::<Vec<_>>(),
        "chat": {"path": chat_path, "name": "Chat"},
        "groups": groups,
    })))
}

/// Record a session's folder as a sidebar workspace, filed under its
/// repository when it is a worktree or a subfolder of one. The Chat
/// workspace is never listed.
pub(super) async fn register_session_workspace(pool: &DbPool, workspace: &str) -> ApiResult<()> {
    appv3_agent::worktrees::register_workspace(pool, workspace).await.map_err(ApiError::internal)
}
