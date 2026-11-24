//! `/api/secrets`: the secrets the user gives the agent.
//!
//! The only route that ever takes a secret's value (`PUT`); nothing here
//! returns one. Settings → Secrets and the agent's secret card both use it.
//! Request bodies are never logged.

use crate::error::{ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::secret_request::project_name;
use appv3_core::agent_secrets::{self, Change, ALL_PROJECTS};
use axum::extract::{Path as AxPath, Query};
use axum::response::Response;
use axum::routing::{delete, get, put};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(list)).route("/{name}", put(save)).route("/{name}/{id}", delete(remove))
}

/// A project as the client sees it: its key, folder name, and whether the
/// folder is still there.
fn project_json(key: &str) -> Value {
    json!({"key": key, "name": project_name(key), "missing": !Path::new(key).exists()})
}

/// Every value, names and projects only. `?workspace=` also returns that
/// folder's project key, and which names it can use.
async fn list(Query(q): Query<HashMap<String, String>>) -> ApiResult<Response> {
    let f = appv3_core::credentials::load()?;
    let secrets: Vec<Value> = agent_secrets::entries(&f)
        .into_iter()
        .map(|(name, s)| {
            json!({
                "name": name, "id": s.id, "all": s.for_all(),
                "projects": s.projects.iter().filter(|p| *p != ALL_PROJECTS).map(|p| project_json(p)).collect::<Vec<_>>(),
                "updated": s.updated, "source": s.source,
            })
        })
        .collect();
    let mut out = json!({"secrets": secrets});
    if let Some(ws) = q.get("workspace").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let key = agent_secrets::project_of(Path::new(ws));
        out["project"] = project_json(&key);
        out["usable"] = json!(agent_secrets::usable_names(&f, &key));
    }
    Ok(json(out))
}

/// A project entry from a client: `*`, a project key, or any folder inside
/// a project (normalized to its project while the folder exists).
fn normalize_project(p: &str) -> String {
    let p = p.trim();
    if p == ALL_PROJECTS || !Path::new(p).exists() {
        return p.to_string();
    }
    agent_secrets::project_of(Path::new(p))
}

/// Save a new value of `name` (`value` and `projects`), or edit value `id`
/// (a new `value`, new `projects`, or both).
async fn save(AxPath(name): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let b = body_value(&raw)?;
    let Some(o) = b.as_object() else { return Err(ApiError::unprocessable("Expected an object.")) };
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "value" | "projects" | "id" | "source")) {
        return Err(ApiError::unprocessable(format!("Unknown field '{k}'.")));
    }
    let value = match o.get("value") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            // A single-line key loses the space or newline a paste brings
            // along; a multi-line one (a PEM key) is kept as it is.
            let t = s.trim();
            Some(if t.contains('\n') { s.clone() } else { t.to_string() })
        }
        Some(_) => return Err(ApiError::unprocessable("'value' must be a string.")),
    };
    let projects = match o.get("projects") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(
            a.iter().map(|v| v.as_str().map(normalize_project).ok_or_else(|| ApiError::unprocessable("'projects' must be a list of strings."))).collect::<ApiResult<Vec<_>>>()?,
        ),
        Some(_) => return Err(ApiError::unprocessable("'projects' must be a list of strings.")),
    };
    let id = o.get("id").and_then(Value::as_str).map(String::from);
    let source = o.get("source").and_then(Value::as_str).filter(|s| matches!(*s, "chat" | "settings")).unwrap_or("settings").to_string();
    let change = Change { id, value, projects, source };
    let saved = appv3_core::credentials::update(|f| agent_secrets::set(f, &name, change))?.map_err(ApiError::unprocessable)?;
    tracing::info!("agent_secret_saved name={} id={}", name, saved);
    Ok(json(json!({"name": name, "id": saved})))
}

async fn remove(AxPath((name, id)): AxPath<(String, String)>) -> ApiResult<Response> {
    let removed = appv3_core::credentials::update(|f| agent_secrets::remove(f, &name, &id))?;
    if !removed {
        return Err(ApiError::not_found(format!("{name} has no saved value '{id}'.")));
    }
    tracing::info!("agent_secret_deleted name={} id={}", name, id);
    Ok(json(json!({"status": "ok"})))
}
