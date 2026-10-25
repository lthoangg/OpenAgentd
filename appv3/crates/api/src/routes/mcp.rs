//! `/api/mcp` — port of `app/api/routes/mcp.py`.

use crate::error::{verr, verr_ctx, ApiError, ApiResult};
use crate::schema::Body;
use crate::util::*;
use crate::AppState;
use appv3_mcp::config::{self as cfgmod, OAuthConfig, ServerConfig};
use appv3_mcp::{masked_config_body, mcp_manager, oauth, AppToolError, ServerStatus};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::time::Duration;

const MASK: &str = "********";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/servers", get(list_servers).post(create_server))
        .route("/servers/{name}", get(get_server).put(update_server).delete(delete_server))
        .route("/servers/{name}/restart", post(restart_server))
        .route("/servers/{name}/oauth/connect", post(connect_oauth))
        .route("/app-tools/call", post(call_app_tool))
        .route("/apply", post(apply))
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::internal(e)
}

fn status_json(st: &ServerStatus, cfg: Option<&ServerConfig>) -> Value {
    json!({
        "name": st.name, "transport": st.transport, "enabled": st.enabled, "state": st.state,
        "error": st.error, "tool_names": st.tool_names, "started_at": st.started_at,
        "config": masked_config_body(cfg),
    })
}

fn list_json(cfg: &cfgmod::McpConfig) -> Value {
    let servers: Vec<Value> = mcp_manager().list_status().iter().map(|s| status_json(s, cfg.servers.get(&s.name))).collect();
    json!({"servers": servers})
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
        Some(Value::String(t)) if t == "stdio" || t == "http" => t.clone(),
        Some(t) => {
            let shown = t.as_str().map(String::from).unwrap_or_else(|| t.to_string());
            errs.push(verr_ctx(
                "union_tag_invalid",
                &loc,
                &format!("Input tag '{shown}' found using 'transport' does not match any of the expected tags: 'stdio', 'http'"),
                v.clone(),
                json!({"discriminator": "'transport'", "tag": shown, "expected_tags": "'stdio', 'http'"}),
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
        ok.then_some(ServerConfig::Stdio { command, args, env, enabled, timeout })
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
        ok.then_some(ServerConfig::Http { url, headers, oauth, enabled, timeout })
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

// ── OAuth secret storage ────────────────────────────────────────────────────

fn env_ref_re() -> &'static regex::Regex {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$").unwrap());
    &RE
}

fn oauth_env_key(name: &str, field: &str) -> String {
    let re = regex::Regex::new(r"[^A-Za-z0-9]+").unwrap();
    let p = re.replace_all(name, "_").trim_matches('_').to_uppercase();
    format!("{}_MCP_{field}", if p.is_empty() { "MCP".to_string() } else { p })
}

/// Store MCP client secrets as named secrets in `credentials.yaml`;
/// `mcp.json` keeps only the `${NAME}` references.
fn save_env_values(values: &[(String, String)]) -> std::io::Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    let values = values.to_vec();
    appv3_core::credentials::update(move |f| {
        for (k, v) in values {
            f.secrets.insert(k, v);
        }
    })?;
    Ok(())
}

/// `_store_oauth_secrets`.
fn store_oauth_secrets(name: &str, cfg: ServerConfig) -> std::io::Result<ServerConfig> {
    let ServerConfig::Http { url, headers, oauth: Some(o), enabled, timeout } = cfg else { return Ok(cfg) };
    let re = env_ref_re();
    let mut env = vec![];
    let mut client_id = o.client_id.clone();
    let mut client_secret = o.client_secret.clone();
    if let Some(id) = client_id.clone().filter(|v| !v.is_empty() && v != MASK && !re.is_match(v)) {
        let key = oauth_env_key(name, "CLIENT_ID");
        env.push((key.clone(), id));
        client_id = Some(format!("${{{key}}}"));
    }
    if let Some(sec) = client_secret.clone().filter(|v| !v.is_empty() && v != MASK && !re.is_match(v)) {
        let key = oauth_env_key(name, "CLIENT_SECRET");
        env.push((key.clone(), sec));
        client_secret = Some(format!("${{{key}}}"));
    }
    save_env_values(&env)?;
    Ok(ServerConfig::Http { url, headers, oauth: Some(OAuthConfig { client_id, client_secret }), enabled, timeout })
}

/// `_merge_masked_http_headers` + `_merge_masked_oauth`.
fn merge_masked(new: ServerConfig, existing: Option<&ServerConfig>) -> ServerConfig {
    let (ServerConfig::Http { url, headers, oauth, enabled, timeout }, Some(ServerConfig::Http { headers: old_h, oauth: old_o, .. })) = (new.clone(), existing) else { return new };
    let headers: IndexMap<String, String> = headers.into_iter().map(|(k, v)| if v == MASK && old_h.contains_key(&k) { (k.clone(), old_h[&k].clone()) } else { (k, v) }).collect();
    let oauth = match (oauth, old_o) {
        (Some(n), Some(o)) => Some(OAuthConfig {
            client_id: if n.client_id.as_deref() == Some(MASK) { o.client_id.clone() } else { n.client_id },
            client_secret: if n.client_secret.as_deref() == Some(MASK) { o.client_secret.clone() } else { n.client_secret },
        }),
        (n, _) => n,
    };
    ServerConfig::Http { url, headers, oauth, enabled, timeout }
}

// ── routes ──────────────────────────────────────────────────────────────────

async fn list_servers() -> ApiResult<Response> {
    let cfg = cfgmod::load_config().map_err(internal)?;
    Ok(json(list_json(&cfg)))
}

async fn get_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let Some(st) = mcp_manager().get_status(&name) else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
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
    if matches!(sc, ServerConfig::Http { .. }) {
        sc = merge_masked(sc, Some(&existing));
        sc = store_oauth_secrets(&name, sc).map_err(internal)?;
    }
    cfg.servers.insert(name.clone(), sc.clone());
    cfgmod::save_config(&cfg).map_err(internal)?;
    Ok(json(restart_to_response(&name, &sc).await?))
}

async fn delete_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let mut cfg = cfgmod::load_config().map_err(internal)?;
    if cfg.servers.shift_remove(&name).is_none() {
        return Err(ApiError::not_found(format!("MCP server '{name}' not found.")));
    }
    cfgmod::save_config(&cfg).map_err(internal)?;
    mcp_manager().remove_runner(&name).await;
    Ok(json(json!({"name": name})))
}

async fn restart_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let cfg = cfgmod::load_config().map_err(internal)?;
    if !cfg.servers.contains_key(&name) {
        return Err(ApiError::not_found(format!("MCP server '{name}' not found.")));
    }
    let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(|_| ApiError::not_found(format!("MCP server '{name}' not found.")))?;
    let cfg = cfgmod::load_config().map_err(internal)?;
    Ok(json(status_json(&st, cfg.servers.get(&name))))
}

async fn connect_oauth(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let cfg = cfgmod::load_config().map_err(internal)?;
    let Some(sc) = cfg.servers.get(&name) else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
    if !matches!(sc, ServerConfig::Http { oauth: Some(_), .. }) {
        return Err(ApiError::bad_request(format!("MCP server '{name}' is not configured for OAuth.")));
    }
    let sc = sc.clone();
    oauth::allow_interactive_oauth(&name);
    oauth::clear_cached_oauth(&name);
    let res = mcp_manager().restart_server(&name, Duration::from_secs(300)).await;
    oauth::disallow_interactive_oauth(&name);
    let st = res.map_err(internal)?;
    if st.state != "ready" {
        return Err(ApiError::conflict(st.error.clone().unwrap_or_else(|| format!("MCP server '{name}' did not connect."))));
    }
    cfgmod::save_config(&cfg).map_err(internal)?;
    Ok(json(status_json(&st, Some(&sc))))
}

async fn apply() -> ApiResult<Response> {
    cfgmod::load_config().map_err(ApiError::unprocessable)?;
    mcp_manager().reload_from_config().await;
    let cfg = cfgmod::load_config().map_err(internal)?;
    Ok(json(list_json(&cfg)))
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
    let Some(sid) = py_uuid(&session_id) else { return Err(ApiError::unprocessable("Invalid session_id.")) };
    let row = appv3_db::queries::messages::find_tool_message(&st.pool, &sid, &tool_call_id).await.map_err(internal)?;
    let app = row.and_then(|r| r.extra_json()).and_then(|e| e.get("mcp_app").filter(|a| a.is_object()).cloned());
    let Some(app) = app else { return Err(ApiError::not_found("MCP app artifact not found.")) };
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
