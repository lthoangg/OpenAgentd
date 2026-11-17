//! `/api/mcp/gallery`: the connector gallery (see [`crate::gallery`]), with
//! what is already turned on, and turning an entry on or updating it.
//! Turning one on writes an ordinary `mcp.json` entry, so it is edited,
//! turned off and removed like any connector.

use super::mcp::{config_of, internal, status_json};
use crate::error::{ApiError, ApiResult};
use crate::gallery::{self, Auth, Entry};
use crate::schema::Body;
use crate::util::*;
use crate::AppState;
use appv3_mcp::config::{self as cfgmod, HttpKind, ServerConfig};
use appv3_mcp::{mcp_manager, oauth};
use axum::extract::{Path as AxPath, Query};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

pub fn router() -> Router<AppState> {
    Router::new().route("/gallery", get(list)).route("/gallery/{id}/enable", post(enable)).route("/gallery/{id}/update", post(update))
}

/// Two connector addresses name the same server: scheme and host case,
/// default ports and a trailing slash do not matter.
pub fn same_url(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        reqwest::Url::parse(s.trim()).ok().map(|u| {
            let path = u.path().trim_end_matches('/').to_string();
            format!(
                "{}://{}{}{}?{}",
                u.scheme(),
                u.host_str().unwrap_or("").to_ascii_lowercase(),
                u.port().map(|p| format!(":{p}")).unwrap_or_default(),
                path,
                u.query().unwrap_or("")
            )
        })
    };
    matches!((norm(a), norm(b)), (Some(x), Some(y)) if x == y)
}

fn url_of(sc: &ServerConfig) -> Option<&str> {
    match sc {
        ServerConfig::Http { url, .. } => Some(url),
        ServerConfig::Stdio { .. } => None,
    }
}

/// What the gallery shows next to an entry: the connector it is (by
/// address), and one still on an old address of it.
fn installed(entry: &Entry, statuses: &[(appv3_mcp::ServerStatus, Option<ServerConfig>)]) -> (Option<Value>, Option<String>) {
    let mut current = None;
    let mut outdated = None;
    for (st, sc) in statuses {
        let Some(url) = sc.as_ref().and_then(url_of) else { continue };
        if current.is_none() && same_url(url, &entry.url) {
            current = Some(status_json(st, sc.as_ref()));
        } else if outdated.is_none() && st.plugin.is_none() && entry.previous_urls.iter().any(|p| same_url(url, p)) {
            outdated = Some(st.name.clone());
        }
    }
    (current, outdated)
}

async fn list(Query(q): Query<HashMap<String, String>>) -> ApiResult<Response> {
    let g = gallery::load(q.get("refresh").is_some_and(|v| v == "1" || v == "true")).await;
    let cfg = cfgmod::load_config().map_err(internal)?;
    let statuses: Vec<_> = mcp_manager()
        .list_status()
        .into_iter()
        .map(|s| {
            let sc = config_of(&s, &cfg);
            (s, sc)
        })
        .collect();
    let entries: Vec<Value> = g
        .entries
        .iter()
        .map(|e| {
            let (server, outdated) = installed(e, &statuses);
            let mut v = e.to_json();
            v["server"] = server.unwrap_or(Value::Null);
            v["update_for"] = json!(outdated);
            v
        })
        .collect();
    Ok(json(json!({"source": g.source, "entries": entries})))
}

async fn find_entry(id: &str) -> ApiResult<Entry> {
    gallery::load(false).await.entries.into_iter().find(|e| e.id == id).ok_or_else(|| ApiError::not_found(format!("No connector '{id}' in the gallery.")))
}

/// A free `mcp.json` name for `id`: itself, else `id-2`, `id-3`, …
fn free_name(id: &str, cfg: &cfgmod::McpConfig) -> String {
    let taken = |n: &str| cfg.servers.contains_key(n) || mcp_manager().get_status(n).is_some();
    if !taken(id) {
        return id.to_string();
    }
    (2..).map(|i| format!("{id}-{i}")).find(|n| !taken(n)).expect("some name is free")
}

async fn enable(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = if raw.is_empty() { json!({}) } else { body_value(&raw)? };
    let mut b = Body::new(&v)?;
    let key = b.opt_str("key").map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    b.finish(&["key"])?;
    let entry = find_entry(&id).await?;
    let mut cfg = cfgmod::load_config().map_err(internal)?;

    // Already there (added by hand too): turn it on.
    let existing = cfg.servers.iter().find(|(_, sc)| url_of(sc).is_some_and(|u| same_url(u, &entry.url))).map(|(n, _)| n.clone());
    if let Some(name) = existing {
        let sc = cfg.servers.get_mut(&name).expect("found above");
        if let ServerConfig::Http { enabled, .. } = sc {
            *enabled = true;
        }
        let sc = sc.clone();
        cfgmod::save_config(&cfg).map_err(internal)?;
        let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(internal)?;
        return Ok(json(status_json(&st, Some(&sc))));
    }
    if let Some(st) = mcp_manager()
        .list_status()
        .into_iter()
        .find(|s| s.plugin.is_some() && mcp_manager().plugin_server_config(&s.name).as_ref().and_then(url_of).is_some_and(|u| same_url(u, &entry.url)))
    {
        return Err(ApiError::conflict(format!("{} is already provided by the plugin '{}'.", entry.name, st.plugin.unwrap_or_default())));
    }

    let name = free_name(&entry.id, &cfg);
    let mut headers = IndexMap::new();
    if let Auth::Key { header, template, .. } = &entry.auth {
        let Some(key) = key else { return Err(ApiError::unprocessable(format!("{} needs a key.", entry.name))) };
        let reference = appv3_mcp::admin::store_api_key(&name, &key).map_err(internal)?;
        headers.insert(header.clone(), template.replace("{key}", &reference));
    }
    let sc = ServerConfig::Http { url: entry.url.clone(), headers, oauth: None, enabled: true, timeout: None, kind: HttpKind::Auto };
    cfg.servers.insert(name.clone(), sc.clone());
    cfgmod::save_config(&cfg).map_err(internal)?;
    let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(internal)?;
    Ok(json_code(201, status_json(&st, Some(&sc))))
}

/// Move a connector still on an old address of the entry to its new one.
/// It signs in again if the service asks.
async fn update(AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let entry = find_entry(&id).await?;
    let mut cfg = cfgmod::load_config().map_err(internal)?;
    let name = cfg
        .servers
        .iter()
        .find(|(_, sc)| url_of(sc).is_some_and(|u| entry.previous_urls.iter().any(|p| same_url(u, p))))
        .map(|(n, _)| n.clone())
        .ok_or_else(|| ApiError::not_found(format!("No connector is on an old address of {}.", entry.name)))?;
    let sc = cfg.servers.get_mut(&name).expect("found above");
    if let ServerConfig::Http { url, .. } = sc {
        *url = entry.url.clone();
    }
    let sc = sc.clone();
    cfgmod::save_config(&cfg).map_err(internal)?;
    oauth::clear_cached_oauth(&name);
    let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(internal)?;
    Ok(json(status_json(&st, Some(&sc))))
}

#[cfg(test)]
mod tests {
    use super::same_url;

    #[test]
    fn addresses_match_ignoring_case_and_a_trailing_slash() {
        assert!(same_url("https://MCP.Notion.com/mcp", "https://mcp.notion.com/mcp/"));
        assert!(same_url("https://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com/mcp"));
        assert!(same_url("https://x.example:443/mcp", "https://x.example/mcp"));
        assert!(!same_url("https://x.example/mcp", "https://x.example/sse"));
        assert!(!same_url("https://x.example/mcp", "http://x.example/mcp"));
        assert!(!same_url("https://x.example/mcp?a=1", "https://x.example/mcp"));
    }
}
