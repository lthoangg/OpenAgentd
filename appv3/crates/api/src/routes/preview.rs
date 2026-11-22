//! `/api/preview`: start, list, and close built-in web previews (v3 only),
//! and tunnel into one from another device.
//!
//! Each preview is a loopback listener owned by `appv3-preview`; these
//! routes only validate the workspace and target and shape the response.
//! `/{id}/tunnel` lets a native relay on a phone or another computer reach
//! that listener: an access key is required, and the WebSocket carries raw
//! TCP to the listener only (never to a caller-chosen address).
//!
//! A site (a page on another machine) has no listener and is never fetched
//! here: the desktop app shows it in its own browser view. `/{id}/agent`,
//! `/{id}/console` and `/{id}/page` are how that app takes the agent's
//! commands for the page and hands back results, console output and the
//! page's address, which the page of a local preview does itself.

use crate::error::{ApiError, ApiResult};
use crate::middleware::{ws_reject, AuthenticatedBy};
use crate::routes::agent::helpers::validate_workspace_or_422;
use crate::util::{json, no_content, Qs};
use crate::AppState;
use appv3_preview::agent::{AgentReply, MAX_RESULT_BYTES, POLL_WAIT};
use appv3_preview::console::{parse_batch, MAX_BATCH_BYTES};
use appv3_preview::{parse_site_url, parse_url_target, resolve_workspace_file, static_backend, url_path, Backend, Entry, PreviewError, PreviewInfo};
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::Path as AxPath;
use axum::http::Extensions;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use bytes::Bytes;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_previews).post(open_preview))
        .route("/{id}", delete(close_preview))
        .route("/{id}/tunnel", get(tunnel))
        .route("/{id}/agent", get(next_command).post(command_result))
        .route("/{id}/console", post(console))
        .route("/{id}/page", post(page_address))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequest {
    workspace: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    preferred_port: Option<u16>,
}

fn preview_json(info: &PreviewInfo, path: &str) -> Value {
    let entry = appv3_preview::global().get(&info.id);
    let errors = entry.as_ref().map(|e| e.console_error_count()).unwrap_or(0);
    json!({
        "id": info.id,
        "workspace": info.workspace,
        "kind": info.kind,
        "target": info.target,
        "port": info.port,
        "origin": info.origin,
        "path": path,
        "url": format!("{}{}", info.origin, path),
        "console_errors": errors,
        // What the agent opened here and still uses (`PreviewTarget`), or
        // null: an app window keeps it loaded while no Preview tab shows it.
        "agent_page": entry.and_then(|e| e.agent_page()),
    })
}

fn preview_err(e: PreviewError) -> ApiError {
    match e {
        PreviewError::Invalid(m) => ApiError::unprocessable(m),
        PreviewError::Bind(m) => ApiError::internal(m),
    }
}

async fn open_preview(raw: Bytes) -> ApiResult<Response> {
    let req: OpenRequest = serde_json::from_slice(&raw).map_err(|e| ApiError::unprocessable(format!("Invalid preview request: {e}")))?;
    let workspace = validate_workspace_or_422(&req.workspace, true)?;
    let (backend, path) = match (req.url.as_deref().filter(|s| !s.trim().is_empty()), req.path.as_deref().filter(|s| !s.trim().is_empty())) {
        (Some(url), None) => match parse_url_target(url) {
            Ok((target, path)) => (Backend::Upstream(target), path),
            // Not a server on this computer: a site, when it is an address at all.
            Err(local) => match parse_site_url(url) {
                Ok((site, full)) => {
                    let path = full.strip_prefix(site.origin.as_str()).unwrap_or("/").to_string();
                    (Backend::Site(site), path)
                }
                Err(_) => return Err(ApiError::unprocessable(local.to_string())),
            },
        },
        (None, Some(rel)) => {
            let rel = resolve_workspace_file(Path::new(&workspace), rel).map_err(ApiError::unprocessable)?;
            (static_backend(Path::new(&workspace)), url_path(&rel))
        }
        _ => return Err(ApiError::unprocessable("Give either url or path.")),
    };
    let info = appv3_preview::global().ensure(&workspace, backend, req.preferred_port).await.map_err(preview_err)?;
    Ok(json(preview_json(&info, &path)))
}

async fn list_previews(q: Qs) -> ApiResult<Response> {
    let workspace = match q.get("workspace") {
        Some(w) => Some(validate_workspace_or_422(w, false)?),
        None => None,
    };
    let previews: Vec<Value> = appv3_preview::global().list(workspace.as_deref()).iter().map(|e| preview_json(&e.info(), "/")).collect();
    Ok(json(json!({ "previews": previews })))
}

/// `?keep_agent_page=1` (a Preview tab closing): a listener whose page the
/// agent still uses stays open, and the answer says so (`{"kept": true}`),
/// so the app keeps the page loaded out of sight instead.
async fn close_preview(AxPath(id): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let keep = q.get("keep_agent_page").is_some_and(|v| v == "1" || v == "true");
    if keep && appv3_preview::global().get(&id).is_some_and(|e| e.agent_page().is_some()) {
        return Ok(json(json!({ "kept": true })));
    }
    if appv3_preview::global().close(&id) {
        Ok(no_content())
    } else {
        Err(ApiError::not_found("Preview not found."))
    }
}

/// `GET /{id}/tunnel?port=<relay port>`: a WebSocket of raw TCP into the
/// preview listener. Needs an access key, so a keyless server (which
/// trusts only loopback callers) never opens one. `port` is the relay's
/// loopback port on the client device; the listener accepts it as `Host`.
async fn tunnel(AxPath(id): AxPath<String>, q: Qs, ext: Extensions, ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>) -> Response {
    if ext.get::<AuthenticatedBy>().is_none() {
        tracing::warn!("preview_tunnel_unauthenticated id={}", id);
        return ws_reject();
    }
    let Some(entry) = appv3_preview::global().get(&id) else {
        return ApiError::not_found("Preview not found.").into_response();
    };
    let Ok(ws) = ws else {
        return ApiError::bad_request("A WebSocket upgrade is required.").into_response();
    };
    let port = q.get("port").and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 1024);
    let Some(port) = port else {
        return ApiError::unprocessable("port must be the relay's loopback port (above 1024).").into_response();
    };
    entry.add_alias_port(port);
    ws.max_message_size(appv3_preview::tunnel::MAX_TUNNEL_MESSAGE).on_upgrade(move |socket| appv3_preview::tunnel::pipe(entry, socket))
}

/// The site preview `id`: only a site's page is driven through the API (a
/// local preview's page polls its own listener).
fn site_entry(id: &str) -> ApiResult<Arc<Entry>> {
    appv3_preview::global().get(id).filter(|e| e.is_site()).ok_or_else(|| ApiError::not_found("Preview not found."))
}

/// `GET /{id}/agent`: the app's long poll for the agent's next command for
/// a site's page (`{ id, command }`), or 204 when none arrives in time.
/// Polls count as activity, so the preview is not closed as idle.
async fn next_command(AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let entry = site_entry(&id)?;
    let _guard = entry.begin();
    match entry.agent.next(POLL_WAIT, entry.stop_rx()).await {
        Some(command) => Ok(json(json!(command))),
        None => Ok(no_content()),
    }
}

/// `POST /{id}/agent`: a command's result, as the page reported it.
async fn command_result(AxPath(id): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    let entry = site_entry(&id)?;
    if body.len() > MAX_RESULT_BYTES {
        return Err(ApiError::unprocessable("Result too large."));
    }
    let reply: AgentReply = serde_json::from_slice(&body).map_err(|e| ApiError::unprocessable(format!("Invalid result: {e}")))?;
    entry.agent.resolve(reply);
    Ok(no_content())
}

/// `POST /{id}/console`: console entries from a site's page.
async fn console(AxPath(id): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    let entry = site_entry(&id)?;
    if body.len() > MAX_BATCH_BYTES {
        return Err(ApiError::unprocessable("Console batch too large."));
    }
    entry.push_console(parse_batch(&body).map_err(ApiError::unprocessable)?);
    Ok(no_content())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageAddress {
    url: String,
}

/// `POST /{id}/page`: where a site's page is now. The agent's next command
/// is allowed (or asked about) for that address's host.
async fn page_address(AxPath(id): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    let entry = site_entry(&id)?;
    let req: PageAddress = serde_json::from_slice(&body).map_err(|e| ApiError::unprocessable(format!("Invalid page address: {e}")))?;
    let (_, url) = parse_site_url(&req.url).map_err(|e| ApiError::unprocessable(e.to_string()))?;
    entry.set_page_url(url);
    Ok(no_content())
}
