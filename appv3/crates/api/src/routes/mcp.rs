//! `/api/mcp`.

use crate::error::{verr, verr_ctx, ApiError, ApiResult};
use crate::schema::Body;
use crate::util::*;
use crate::AppState;
use appv3_mcp::admin::{merge_masked, store_oauth_secrets};
use appv3_mcp::config::{self as cfgmod, OAuthConfig, ServerConfig};
use appv3_mcp::{masked_config_body, mcp_manager, oauth, plugin_config_body, AppToolError, ServerStatus};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::time::Duration;

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

/// `ServerStatusResponse`. A server a plugin provides adds `plugin` (the
/// user's own have no such key), and its `config` is the plugin's: it has no
/// entry in `mcp.json`.
fn status_json(st: &ServerStatus, cfg: Option<&ServerConfig>) -> Value {
    let config = if st.plugin.is_some() { plugin_config_body(cfg) } else { masked_config_body(cfg) };
    let mut v = json!({
        "name": st.name, "transport": st.transport, "enabled": st.enabled, "state": st.state,
        "error": st.error, "tool_names": st.tool_names, "started_at": st.started_at,
        "config": config,
    });
    if let Some(plugin) = &st.plugin {
        v["plugin"] = json!(plugin);
    }
    v
}

/// The config `st` shows: the user's entry in `mcp.json`, or for a plugin's
/// server the one its plugin gave it.
fn config_of(st: &ServerStatus, user: &cfgmod::McpConfig) -> Option<ServerConfig> {
    match st.plugin {
        Some(_) => mcp_manager().plugin_server_config(&st.name),
        None => user.servers.get(&st.name).cloned(),
    }
}

fn list_json(cfg: &cfgmod::McpConfig) -> Value {
    let servers: Vec<Value> = mcp_manager().list_status().iter().map(|s| status_json(s, config_of(s, cfg).as_ref())).collect();
    json!({"servers": servers})
}

/// 409 when `name` is a server a plugin provides: the plugin owns it, so
/// the user's `mcp.json` has nothing to edit or delete.
fn reject_plugin_server(name: &str) -> ApiResult<()> {
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

// ── routes ──────────────────────────────────────────────────────────────────

async fn list_servers() -> ApiResult<Response> {
    let cfg = cfgmod::load_config().map_err(internal)?;
    Ok(json(list_json(&cfg)))
}

async fn get_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let Some(st) = mcp_manager().get_status(&name) else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
    if st.plugin.is_some() {
        return Ok(json(status_json(&st, mcp_manager().plugin_server_config(&name).as_ref())));
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
    if matches!(sc, ServerConfig::Http { .. }) {
        sc = merge_masked(sc, Some(&existing));
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
    Ok(json(json!({"name": name})))
}

async fn restart_server(AxPath(name): AxPath<String>) -> ApiResult<Response> {
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
    // A plugin's server signs in like any other; it has no `mcp.json` entry to re-save.
    let (sc, user_cfg) = match mcp_manager().plugin_of(&name).and_then(|_| mcp_manager().plugin_server_config(&name)) {
        Some(sc) => (sc, None),
        None => {
            let cfg = cfgmod::load_config().map_err(internal)?;
            let Some(sc) = cfg.servers.get(&name).cloned() else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
            (sc, Some(cfg))
        }
    };
    if !matches!(sc, ServerConfig::Http { oauth: Some(_), .. }) {
        return Err(ApiError::bad_request(format!("MCP server '{name}' is not configured for OAuth.")));
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

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_kernel::{Module, Registrar};
    use appv3_mcp::PluginServers;
    use axum::body::Body as HttpBody;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// A plugin's module as far as the kernel sees it: it contributes its
    /// servers when it starts (the sync is called by the test, as the real
    /// module's hooks do).
    struct PluginModule {
        id: String,
        plugin: String,
        servers: Vec<(String, ServerConfig)>,
    }

    impl Module for PluginModule {
        fn id(&self) -> &str {
            &self.id
        }
        fn register(&self, r: &mut Registrar) -> anyhow::Result<()> {
            r.add(PluginServers { plugin: self.plugin.clone(), servers: self.servers.clone() });
            Ok(())
        }
    }

    /// A server that is disabled, so it never starts a process.
    fn plugin_server() -> ServerConfig {
        let mut env = IndexMap::new();
        env.insert("TOKEN".to_string(), "s3cret".to_string());
        ServerConfig::Stdio { command: "npx".into(), args: vec!["-y".into(), "srv".into()], env, enabled: false, timeout: None, cwd: Some("/plugins/routes-mcp".into()) }
    }

    fn status(plugin: Option<&str>) -> ServerStatus {
        ServerStatus {
            name: "n".into(),
            transport: "stdio".into(),
            enabled: true,
            state: "ready".into(),
            error: None,
            tool_names: vec!["n_t".into()],
            started_at: None,
            plugin: plugin.map(String::from),
        }
    }

    async fn send(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(v) => {
                req = req.header("content-type", "application/json");
                HttpBody::from(v.to_string())
            }
            None => HttpBody::empty(),
        };
        let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// The user's servers read as they always did; a plugin's adds `plugin`.
    #[test]
    fn only_a_plugins_server_carries_a_plugin_label() {
        let cfg = ServerConfig::Stdio { command: "x".into(), args: vec![], env: IndexMap::new(), enabled: true, timeout: None, cwd: None };
        let user = status_json(&status(None), Some(&cfg));
        assert!(user.get("plugin").is_none());
        assert_eq!(
            user.to_string(),
            r#"{"name":"n","transport":"stdio","enabled":true,"state":"ready","error":null,"tool_names":["n_t"],"started_at":null,"config":{"transport":"stdio","command":"x","args":[],"env":{},"enabled":true}}"#
        );
        let plugin = status_json(&status(Some("p")), Some(&cfg));
        assert_eq!(plugin["plugin"], "p");
        assert_eq!(plugin.to_string(), format!(r#"{},"plugin":"p"}}"#, user.to_string().strip_suffix('}').unwrap()), "the label is the only difference");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn plugin_servers_are_listed_read_only_and_reached_by_their_encoded_full_name() {
        let kernel = appv3_kernel::global();
        let module = "plugin:routes-mcp";
        kernel.add(PluginModule { id: module.into(), plugin: "routes-mcp".into(), servers: vec![("github".into(), plugin_server())] }).unwrap();
        kernel.start(module).await.unwrap();
        mcp_manager().sync_plugin_servers().await;

        let dir = tempfile::tempdir().unwrap();
        let pool = appv3_db::create_pool(dir.path().join("oad.db")).await.unwrap();
        let app = crate::routes::router().with_state(AppState { pool });
        // `encodeURIComponent("routes-mcp/github")`: the `/` stays inside one path segment.
        let uri = "/api/mcp/servers/routes-mcp%2Fgithub";

        let (st, v) = send(&app, "GET", uri, None).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(
            (v["name"].as_str(), v["plugin"].as_str(), v["transport"].as_str(), v["state"].as_str()),
            (Some("routes-mcp/github"), Some("routes-mcp"), Some("stdio"), Some("stopped")),
            "{v}"
        );
        assert_eq!((v["config"]["command"].as_str(), v["config"]["cwd"].as_str()), (Some("npx"), Some("/plugins/routes-mcp")));
        assert_eq!(v["config"]["env"], json!({"TOKEN": "********"}));
        assert!(!v.to_string().contains("s3cret"), "{v}");

        // Read-only: neither a change nor a delete, and nothing happens to the server.
        let detail = "routes-mcp/github comes from plugin routes-mcp; manage it in Settings → Plugins";
        let put = json!({"server": {"transport": "stdio", "command": "x", "args": [], "env": {}, "enabled": true}});
        assert_eq!(send(&app, "PUT", uri, Some(put)).await, (StatusCode::CONFLICT, json!({"detail": detail})));
        assert_eq!(send(&app, "DELETE", uri, None).await, (StatusCode::CONFLICT, json!({"detail": detail})));
        assert_eq!(mcp_manager().get_status("routes-mcp/github").unwrap().plugin.as_deref(), Some("routes-mcp"));

        // A restart is allowed.
        let (st, v) = send(&app, "POST", &format!("{uri}/restart"), None).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!((v["name"].as_str(), v["plugin"].as_str()), (Some("routes-mcp/github"), Some("routes-mcp")), "{v}");

        // Signing in resolves the name too (this server has no OAuth block).
        let (st, v) = send(&app, "POST", &format!("{uri}/oauth/connect"), None).await;
        assert_eq!((st, v), (StatusCode::BAD_REQUEST, json!({"detail": "MCP server 'routes-mcp/github' is not configured for OAuth."})));

        // The list carries it with its label.
        let list = list_json(&cfgmod::McpConfig::default());
        let listed = list["servers"].as_array().unwrap().iter().find(|s| s["name"] == "routes-mcp/github").expect("listed");
        assert_eq!(listed["plugin"], "routes-mcp");

        // Another server of the same plugin is not there.
        let (st, v) = send(&app, "GET", "/api/mcp/servers/routes-mcp%2Fnope", None).await;
        assert_eq!((st, v), (StatusCode::NOT_FOUND, json!({"detail": "MCP server 'routes-mcp/nope' not found."})));

        // The plugin stops (the kernel drops its contribution, the hook syncs): the server is gone.
        kernel.stop(module).await;
        mcp_manager().sync_plugin_servers().await;
        let (st, _) = send(&app, "GET", uri, None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert!(list_json(&cfgmod::McpConfig::default())["servers"].as_array().unwrap().iter().all(|s| s["name"] != "routes-mcp/github"));
        kernel.remove(module).await;
    }
}
