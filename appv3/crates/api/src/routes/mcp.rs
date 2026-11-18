//! `/api/mcp`.

use crate::error::{verr, verr_ctx, ApiError, ApiResult};
use crate::schema::Body;
use crate::util::*;
use crate::AppState;
use appv3_mcp::admin::{merge_masked, store_oauth_secrets};
use appv3_mcp::config::{self as cfgmod, HttpKind, OAuthConfig, ServerConfig};
use appv3_mcp::{masked_config_body, mcp_manager, oauth, plugin_config_body, AppToolError, ServerStatus};
use axum::extract::{Path as AxPath, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/servers", get(list_servers).post(create_server))
        .route("/servers/{name}", get(get_server).put(update_server).delete(delete_server))
        .route("/servers/{name}/restart", post(restart_server))
        .route("/servers/{name}/approve", post(approve_server))
        .route("/servers/{name}/revoke", post(revoke_server))
        .route("/servers/{name}/oauth/connect", post(connect_oauth))
        .route("/app-tools/call", post(call_app_tool))
        .route("/app-frames", post(issue_app_frame))
        .route("/app-frames/{ticket}", get(app_frame))
        .route("/app-context", post(update_app_context))
        .route("/app-storage", post(update_app_storage))
        .route("/apply", post(apply))
        .merge(super::mcp_sign_in::router())
        .merge(super::mcp_gallery::router())
}

pub(super) fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::internal(e)
}

/// `ServerStatusResponse`. A server a plugin provides adds `plugin` (the
/// user's own have no such key), and its `config` is the plugin's: it has no
/// entry in `mcp.json`. A project's server adds `project` (its workspace and
/// its name there; `name` is its key) and shows its entry from the project's
/// `.agents/mcp.json`.
pub(super) fn status_json(st: &ServerStatus, cfg: Option<&ServerConfig>) -> Value {
    let config = if st.plugin.is_some() || st.project.is_some() { plugin_config_body(cfg) } else { masked_config_body(cfg) };
    let mut v = json!({
        "name": st.name, "transport": st.transport, "enabled": st.enabled, "state": st.state,
        "error": st.error, "tool_names": st.tool_names, "started_at": st.started_at,
        "config": config,
        // Holds a sign-in it can use (or refresh): what "Sign out" forgets.
        "signed_in": oauth::has_cached_oauth_tokens(&st.name),
        // The gallery entry it is, by address: the app shows its name and logo.
        "gallery": super::mcp_gallery::gallery_of(cfg),
    });
    if let Some(plugin) = &st.plugin {
        v["plugin"] = json!(plugin);
    }
    if let Some(p) = &st.project {
        v["project"] = json!({"workspace": p.workspace, "name": p.name});
    }
    v
}

/// The config `st` shows: the user's entry in `mcp.json`, or for a plugin's
/// server the one its plugin gave it, or for a project's its project's entry.
pub(super) fn config_of(st: &ServerStatus, user: &cfgmod::McpConfig) -> Option<ServerConfig> {
    if st.project.is_some() {
        return mcp_manager().project_server_config(&st.name);
    }
    match st.plugin {
        Some(_) => mcp_manager().plugin_server_config(&st.name),
        None => user.servers.get(&st.name).cloned(),
    }
}

fn list_json(cfg: &cfgmod::McpConfig) -> Value {
    let servers: Vec<Value> = mcp_manager().list_status().iter().map(|s| status_json(s, config_of(s, cfg).as_ref())).collect();
    json!({"servers": servers})
}

/// 409 when `name` is a server a plugin provides, or a project's: the plugin
/// or the project's file owns it, so the user's `mcp.json` has nothing to
/// edit or delete.
fn reject_plugin_server(name: &str) -> ApiResult<()> {
    if let Some(p) = mcp_manager().project_of(name) {
        return Err(ApiError::conflict(format!(
            "{} comes from {}; edit that file to change it",
            p.name,
            appv3_mcp::project::project_file(std::path::Path::new(&p.workspace)).display()
        )));
    }
    match mcp_manager().plugin_of(name) {
        Some(plugin) => Err(ApiError::conflict(appv3_mcp::plugin::managed_by_plugin_message(name, &plugin))),
        None => Ok(()),
    }
}

// ── body validation (`ServerBody` discriminated union) ──────────────────────

fn parse_server_body(v: Option<&Value>, errs: &mut Vec<Value>) -> Option<ServerConfig> {
    let loc = vec![json!("body"), json!("server")];
    let Some(v) = v else {
        errs.push(verr("missing", &loc, "Field required", Value::Null));
        return None;
    };
    let Some(obj) = v.as_object() else {
        errs.push(verr("model_attributes_type", &loc, "Input should be a valid dictionary or object to extract fields from", v.clone()));
        return None;
    };
    let tag = match obj.get("transport") {
        None => {
            errs.push(verr_ctx("union_tag_not_found", &loc, "Unable to extract tag using discriminator 'transport'", v.clone(), json!({"discriminator": "'transport'"})));
            return None;
        }
        Some(Value::String(t)) if t == "stdio" || t == "http" || t == "sse" => t.clone(),
        Some(t) => {
            let shown = t.as_str().map(String::from).unwrap_or_else(|| t.to_string());
            errs.push(verr_ctx(
                "union_tag_invalid",
                &loc,
                &format!("Input tag '{shown}' found using 'transport' does not match any of the expected tags: 'stdio', 'http', 'sse'"),
                v.clone(),
                json!({"discriminator": "'transport'", "tag": shown, "expected_tags": "'stdio', 'http', 'sse'"}),
            ));
            return None;
        }
    };
    let mut prefix = loc.clone();
    prefix.push(json!(tag));
    let mut b = Body::nested(v, prefix.clone()).ok()?;
    let cfg = if tag == "stdio" {
        let command = b.str_min1("command");
        let args = b.list_str("args");
        let env: IndexMap<String, String> = b.dict_str("env").into_iter().collect();
        let enabled = b.bool("enabled", Some(true));
        let timeout = b.opt_int("timeout");
        let mut e = b.into_errs(&["transport", "command", "args", "env", "enabled", "timeout"]);
        let timeout = check_timeout(timeout, &prefix, &mut e);
        let ok = e.is_empty();
        errs.extend(e);
        ok.then_some(ServerConfig::Stdio { command, args, env, enabled, timeout, cwd: None })
    } else {
        let url = b.str_min1("url");
        let headers: IndexMap<String, String> = b.dict_str("headers").into_iter().collect();
        let enabled = b.bool("enabled", Some(true));
        let timeout = b.opt_int("timeout");
        let mut e = b.into_errs(&["transport", "url", "headers", "oauth", "enabled", "timeout"]);
        let timeout = check_timeout(timeout, &prefix, &mut e);
        let oauth = match obj.get("oauth") {
            None | Some(Value::Null) => None,
            Some(o) => {
                let mut p = prefix.clone();
                p.push(json!("oauth"));
                match Body::nested(o, p) {
                    Err(x) => {
                        e.extend(x);
                        None
                    }
                    Ok(mut ob) => {
                        let c = OAuthConfig { client_id: ob.opt_str("client_id"), client_secret: ob.opt_str("client_secret") };
                        e.extend(ob.into_errs(&["client_id", "client_secret"]));
                        Some(c)
                    }
                }
            }
        };
        let ok = e.is_empty();
        errs.extend(e);
        let kind = if tag == "sse" { HttpKind::Sse } else { HttpKind::Auto };
        ok.then_some(ServerConfig::Http { url, headers, oauth, enabled, timeout, kind })
    };
    cfg
}

/// `timeout: int | None = Field(ge=1, le=MAX_TIMEOUT_S)`.
fn check_timeout(v: Option<i64>, prefix: &[Value], errs: &mut Vec<Value>) -> Option<u64> {
    let v = v?;
    let max = appv3_mcp::client::MAX_TIMEOUT_S as i64;
    let mut loc = prefix.to_vec();
    loc.push(json!("timeout"));
    if v < 1 {
        errs.push(verr_ctx("greater_than_equal", &loc, "Input should be greater than or equal to 1", json!(v), json!({"ge": 1})));
        return None;
    }
    if v > max {
        errs.push(verr_ctx("less_than_equal", &loc, &format!("Input should be less than or equal to {max}"), json!(v), json!({"le": max})));
        return None;
    }
    Some(v as u64)
}

// ── routes ──────────────────────────────────────────────────────────────────

/// The user's and plugins' servers; with `?workspace=`, that workspace's
/// project servers too (synced with its `.agents/mcp.json` first), and
/// `project_error` when that file cannot be used.
async fn list_servers(q: Qs) -> ApiResult<Response> {
    let cfg = cfgmod::load_config().map_err(internal)?;
    let mut out = list_json(&cfg);
    if let Some(ws) = q.opt("workspace").filter(|w| !w.is_empty()) {
        let m = mcp_manager();
        m.sync_project(&ws).await;
        let servers = out["servers"].as_array_mut().expect("a list");
        servers.extend(m.project_servers(&ws).iter().map(|(st, sc)| status_json(st, Some(sc))));
        if let Some(e) = m.project_error(&ws) {
            out["project_error"] = json!(e);
        }
    }
    Ok(json(out))
}

async fn get_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let Some(st) = mcp_manager().get_status(&name) else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
    if st.plugin.is_some() || st.project.is_some() {
        return Ok(json(status_json(&st, config_of(&st, &cfgmod::McpConfig::default()).as_ref())));
    }
    let cfg = cfgmod::load_config().map_err(internal)?;
    Ok(json(status_json(&st, cfg.servers.get(&name))))
}

async fn restart_to_response(name: &str, sc: &ServerConfig) -> ApiResult<Value> {
    let st = mcp_manager().restart_server(name, Duration::from_secs(15)).await.map_err(internal)?;
    Ok(status_json(&st, Some(sc)))
}

async fn create_server(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let name = b.str_min1("name");
    let mut errs = std::mem::take(&mut b.errs);
    let server = parse_server_body(v.get("server"), &mut errs);
    b.errs = errs;
    b.finish(&["name", "server"])?;
    let server = server.expect("validated");
    cfgmod::validate_server_name(&name).map_err(ApiError::unprocessable)?;
    let mut cfg = cfgmod::load_config().map_err(internal)?;
    if cfg.servers.contains_key(&name) {
        return Err(ApiError::conflict(format!("MCP server '{name}' already exists.")));
    }
    let sc = store_oauth_secrets(&name, server).map_err(internal)?;
    cfg.servers.insert(name.clone(), sc.clone());
    cfgmod::save_config(&cfg).map_err(internal)?;
    Ok(json_code(201, restart_to_response(&name, &sc).await?))
}

async fn update_server(AxPath(name): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    reject_plugin_server(&name)?;
    let v = body_value(&raw)?;
    let b = Body::new(&v)?;
    let mut errs = vec![];
    let server = parse_server_body(v.get("server"), &mut errs);
    let mut all = errs;
    all.extend(b.into_errs(&["server"]));
    if !all.is_empty() {
        return Err(ApiError::validation(all));
    }
    let mut cfg = cfgmod::load_config().map_err(internal)?;
    let Some(existing) = cfg.servers.get(&name).cloned() else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
    let mut sc = server.expect("validated");
    sc = merge_masked(sc, Some(&existing));
    if matches!(sc, ServerConfig::Http { .. }) {
        sc = store_oauth_secrets(&name, sc).map_err(internal)?;
    }
    cfg.servers.insert(name.clone(), sc.clone());
    cfgmod::save_config(&cfg).map_err(internal)?;
    Ok(json(restart_to_response(&name, &sc).await?))
}

async fn delete_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    reject_plugin_server(&name)?;
    let mut cfg = cfgmod::load_config().map_err(internal)?;
    if cfg.servers.shift_remove(&name).is_none() {
        return Err(ApiError::not_found(format!("MCP server '{name}' not found.")));
    }
    cfgmod::save_config(&cfg).map_err(internal)?;
    mcp_manager().remove_runner(&name).await;
    // Removing a connector forgets its sign-in too.
    oauth::disallow_interactive_oauth(&name);
    oauth::clear_cached_oauth(&name);
    appv3_agent::mcp_apps::remove_storage(&name).await;
    Ok(json(json!({"name": name})))
}

async fn restart_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    if mcp_manager().project_of(&name).is_some() {
        // A project's server restarts once approved; it is not in `mcp.json`.
        let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(ApiError::conflict)?;
        return Ok(json(status_json(&st, mcp_manager().project_server_config(&name).as_ref())));
    }
    if mcp_manager().plugin_of(&name).is_some() {
        // A plugin's server restarts like any other; it is not in `mcp.json`.
        let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(|_| ApiError::not_found(format!("MCP server '{name}' not found.")))?;
        return Ok(json(status_json(&st, mcp_manager().plugin_server_config(&name).as_ref())));
    }
    let cfg = cfgmod::load_config().map_err(internal)?;
    if !cfg.servers.contains_key(&name) {
        return Err(ApiError::not_found(format!("MCP server '{name}' not found.")));
    }
    let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(|_| ApiError::not_found(format!("MCP server '{name}' not found.")))?;
    let cfg = cfgmod::load_config().map_err(internal)?;
    Ok(json(status_json(&st, cfg.servers.get(&name))))
}

async fn connect_oauth(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    // A plugin's or project's server signs in like any other; it has no `mcp.json` entry to re-save.
    let owned = mcp_manager().project_server_config(&name).or_else(|| mcp_manager().plugin_of(&name).and_then(|_| mcp_manager().plugin_server_config(&name)));
    let (sc, user_cfg) = match owned {
        Some(sc) => (sc, None),
        None => {
            let cfg = cfgmod::load_config().map_err(internal)?;
            let Some(sc) = cfg.servers.get(&name).cloned() else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
            (sc, Some(cfg))
        }
    };
    if !sc.signs_in_with_oauth() {
        return Err(ApiError::bad_request(format!("MCP server '{name}' does not sign in with OAuth: it is a stdio server, or its Authorization header sets its credentials.")));
    }
    if mcp_manager().get_status(&name).is_some_and(|s| s.state == "needs_approval") {
        return Err(ApiError::conflict(format!("MCP server '{name}' needs approval before it can sign in.")));
    }
    oauth::allow_interactive_oauth(&name);
    oauth::clear_cached_oauth(&name);
    let res = mcp_manager().restart_server(&name, Duration::from_secs(300)).await;
    oauth::disallow_interactive_oauth(&name);
    let st = res.map_err(internal)?;
    if st.state != "ready" {
        return Err(ApiError::conflict(st.error.clone().unwrap_or_else(|| format!("MCP server '{name}' did not connect."))));
    }
    if let Some(cfg) = &user_cfg {
        cfgmod::save_config(cfg).map_err(internal)?;
    }
    Ok(json(status_json(&st, Some(&sc))))
}

/// Approve a project's server (keyed `name`) as its entry is now, and start it.
async fn approve_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let Some(p) = mcp_manager().project_of(&name) else { return Err(ApiError::not_found(format!("MCP server '{name}' is not a project's server."))) };
    let st = mcp_manager().approve_project_server(&p.workspace, &p.name, None, Duration::from_secs(15)).await.map_err(ApiError::conflict)?;
    let key = appv3_mcp::project::runner_key(&p.workspace, &p.name);
    let st = mcp_manager().get_status(&key).unwrap_or(st);
    Ok(json(status_json(&st, mcp_manager().project_server_config(&key).as_ref())))
}

/// Withdraw the approval of a project's server (keyed `name`): it stops.
async fn revoke_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let Some(p) = mcp_manager().project_of(&name) else { return Err(ApiError::not_found(format!("MCP server '{name}' is not a project's server."))) };
    mcp_manager().revoke_project_server(&p.workspace, &p.name).await.map_err(internal)?;
    let Some(st) = mcp_manager().get_status(&name) else { return Ok(json(json!({"name": name}))) };
    Ok(json(status_json(&st, mcp_manager().project_server_config(&name).as_ref())))
}

async fn apply() -> ApiResult<Response> {
    cfgmod::load_config().map_err(ApiError::unprocessable)?;
    mcp_manager().reload_from_config().await;
    let cfg = cfgmod::load_config().map_err(internal)?;
    Ok(json(list_json(&cfg)))
}

/// The `mcp_app` stored with the tool result of `tool_call_id`: what every
/// request from an app's panel is bound to.
async fn bound_app(pool: &appv3_db::DbPool, session_id: &str, tool_call_id: &str) -> ApiResult<Value> {
    let Some(sid) = py_uuid(session_id) else { return Err(ApiError::unprocessable("Invalid session_id.")) };
    let row = appv3_db::queries::messages::find_tool_message(pool, &sid, tool_call_id).await.map_err(internal)?;
    let app = row.and_then(|r| r.extra_json()).and_then(|e| e.get("mcp_app").filter(|a| a.is_object()).cloned());
    app.ok_or_else(|| ApiError::not_found("MCP app artifact not found."))
}

async fn call_app_tool(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let session_id = b.str("session_id", None);
    let tool_call_id = b.str("tool_call_id", None);
    let server = b.str_min1("server");
    let tool = b.str_min1("tool");
    let arguments = b.dict_any("arguments");
    b.finish(&["session_id", "tool_call_id", "server", "tool", "arguments"])?;
    let app = bound_app(&st.pool, &session_id, &tool_call_id).await?;
    if app.get("server") != Some(&json!(server)) {
        return Err(ApiError::new(403, "MCP app server mismatch."));
    }
    match mcp_manager().call_app_tool(&server, &tool, Value::Object(arguments)).await {
        Ok(r) => Ok(json(json!({"result": if r.is_object() { r } else { json!({"content": r}) }}))),
        Err(AppToolError::NotFound) => Err(ApiError::not_found("MCP server not found.")),
        Err(AppToolError::Forbidden(m)) => Err(ApiError::new(403, m)),
        Err(AppToolError::NotConnected(m)) => Err(ApiError::conflict(m)),
        Err(AppToolError::Failed(_)) => Err(ApiError::new(502, "MCP app tool call failed.")),
    }
}

// ── an app's page, for its frame ────────────────────────────────────────────

/// How long the web UI has to load the frame after asking for its address.
const FRAME_TICKET_TTL: Duration = Duration::from_secs(60);
const MAX_PENDING_FRAMES: usize = 64;
/// The host's own scripts for the page (storage stand-ins, key forwarding).
const MAX_FRAME_HEAD_BYTES: usize = 64 * 1024;

struct FrameTicket {
    session_id: String,
    tool_call_id: String,
    head: String,
    expiry: Instant,
}

fn frame_tickets() -> &'static Mutex<HashMap<String, FrameTicket>> {
    static T: OnceLock<Mutex<HashMap<String, FrameTicket>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Take the ticket: it opens the page once.
fn redeem_frame(ticket: &str) -> Option<FrameTicket> {
    let mut map = frame_tickets().lock().unwrap();
    let now = Instant::now();
    map.retain(|_, t| now <= t.expiry);
    let matched = map.keys().find(|k| appv3_core::auth::constant_time_eq(k, ticket)).cloned()?;
    map.remove(&matched)
}

/// `POST /app-frames`: a single-use address for the page of one stored app
/// result. The frame loads it without the access key, so the app never
/// holds one.
async fn issue_app_frame(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let session_id = b.str("session_id", None);
    let tool_call_id = b.str("tool_call_id", None);
    let head = b.opt_str("head").unwrap_or_default();
    b.finish(&["session_id", "tool_call_id", "head"])?;
    if head.len() > MAX_FRAME_HEAD_BYTES {
        return Err(ApiError::new(413, "MCP app frame head is too large."));
    }
    bound_app(&st.pool, &session_id, &tool_call_id).await?;
    let ticket = token_urlsafe();
    let mut map = frame_tickets().lock().unwrap();
    let now = Instant::now();
    map.retain(|_, t| now <= t.expiry);
    if map.len() >= MAX_PENDING_FRAMES {
        return Err(ApiError::new(429, "Too many MCP app frames are waiting to load."));
    }
    map.insert(ticket.clone(), FrameTicket { session_id, tool_call_id, head, expiry: now + FRAME_TICKET_TTL });
    Ok(json(json!({"ticket": ticket})))
}

/// `GET /app-frames/{ticket}`: the app's page, confined by its own policy.
async fn app_frame(State(st): State<AppState>, AxPath(ticket): AxPath<String>) -> ApiResult<Response> {
    let Some(t) = redeem_frame(&ticket) else { return Err(ApiError::not_found("MCP app frame not found.")) };
    let app = bound_app(&st.pool, &t.session_id, &t.tool_call_id).await?;
    let Some(html) = appv3_agent::mcp_apps::load_html(&app).await else { return Err(ApiError::not_found("MCP app page not found.")) };
    let csp = HeaderValue::from_str(&appv3_agent::mcp_apps::frame_csp(&app)).map_err(internal)?;
    // What the server's apps kept goes first, for the host's storage stand-in.
    let kept = match app.get("server").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(server) => appv3_agent::mcp_apps::storage_script(&appv3_agent::mcp_apps::load_storage(server).await),
        None => String::new(),
    };
    let mut resp = (StatusCode::OK, appv3_agent::mcp_apps::with_head(&html, &format!("{kept}{}", t.head))).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::CONTENT_SECURITY_POLICY, csp);
    // What the app may use is the frame's `allow` attribute, from the
    // permissions its resource declares.
    h.insert(HeaderName::from_static("permissions-policy"), HeaderValue::from_static("payment=()"));
    resp.extensions_mut().insert(crate::middleware::Frameable);
    Ok(resp)
}

/// `POST /app-context`: what an app's panel reports for the model. The
/// newest report of each panel goes with the session's next user message.
async fn update_app_context(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let session_id = b.str("session_id", None);
    let tool_call_id = b.str("tool_call_id", None);
    b.finish(&["session_id", "tool_call_id", "content", "structuredContent"])?;
    let app = bound_app(&st.pool, &session_id, &tool_call_id).await?;
    let part = |k: &str| app.get(k).and_then(Value::as_str).unwrap_or("?");
    let label = format!("{} · {}", part("server"), part("tool"));
    let text = appv3_agent::mcp_apps::context_text(v.get("content"), v.get("structuredContent"));
    appv3_agent::mcp_apps::report_model_context(&session_id, &tool_call_id, &label, &text);
    Ok(json(json!({})))
}

/// `POST /app-storage`: what an app did to its `localStorage`. It is kept
/// for the app's MCP server and handed back when one of its pages loads.
async fn update_app_storage(State(st): State<AppState>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let session_id = b.str("session_id", None);
    let tool_call_id = b.str("tool_call_id", None);
    b.finish(&["session_id", "tool_call_id", "clear", "remove", "set"])?;
    let app = bound_app(&st.pool, &session_id, &tool_call_id).await?;
    let Some(server) = app.get("server").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return Err(ApiError::not_found("MCP app server not found.")) };
    let strings = |v: &Value| v.as_str().map(String::from);
    let change = appv3_agent::mcp_apps::StorageChange {
        clear: v.get("clear").and_then(Value::as_bool).unwrap_or(false),
        remove: v.get("remove").and_then(Value::as_array).into_iter().flatten().filter_map(strings).collect(),
        set: v.get("set").and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), strings(v)?))).collect(),
    };
    appv3_agent::mcp_apps::change_storage(server, change).await;
    Ok(json(json!({})))
}

#[cfg(test)]
mod tests;
