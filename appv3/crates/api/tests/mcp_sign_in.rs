//! A connector's sign-in over HTTP, driven by the client: from another
//! device (the code comes back through the relay page and the client's
//! `finish`), from this machine (the loopback listener, here by a pasted
//! address), and sign-out. A fake MCP server is its own authorization server.
//!
//! Settings and managers are process-global, so everything runs in one test.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Method, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[derive(Clone, Default)]
struct Fake {
    base: Arc<Mutex<String>>,
    clients: Arc<Mutex<HashMap<String, Vec<String>>>>,
    codes: Arc<Mutex<HashMap<String, (String, String)>>>,
}

async fn handle(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: String) -> Response {
    let base = f.base.lock().unwrap().clone();
    match (method.as_str(), uri.path()) {
        ("GET", p) if p.starts_with("/.well-known/oauth-protected-resource") => Json(json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]})).into_response(),
        ("GET", "/.well-known/oauth-authorization-server") => Json(json!({
            "issuer": base, "authorization_endpoint": format!("{base}/authorize"), "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"), "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"],
        }))
        .into_response(),
        ("POST", "/register") => {
            let v: Value = serde_json::from_str(&body).unwrap();
            let uris: Vec<String> = v["redirect_uris"].as_array().unwrap().iter().map(|u| u.as_str().unwrap().to_string()).collect();
            let id = format!("client-{}", f.clients.lock().unwrap().len() + 1);
            f.clients.lock().unwrap().insert(id.clone(), uris.clone());
            (StatusCode::CREATED, Json(json!({"client_id": id, "redirect_uris": uris, "token_endpoint_auth_method": "none"}))).into_response()
        }
        ("POST", "/token") => {
            let p: HashMap<String, String> = reqwest::Url::parse(&format!("http://x/?{body}")).unwrap().query_pairs().into_owned().collect();
            let Some((client, redirect)) = f.codes.lock().unwrap().remove(&p["code"]) else { return (StatusCode::BAD_REQUEST, "bad code").into_response() };
            if p["client_id"] != client || p["redirect_uri"] != redirect {
                return (StatusCode::BAD_REQUEST, "redirect_uri mismatch").into_response();
            }
            Json(json!({"access_token": "tok-1", "token_type": "Bearer", "expires_in": 3600})).into_response()
        }
        ("POST", "/mcp") => {
            if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer tok-1") {
                let www = format!(r#"Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp""#);
                return (StatusCode::UNAUTHORIZED, [("www-authenticate", www)]).into_response();
            }
            let m: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let Some(id) = m.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
            let result = match m["method"].as_str() {
                Some("initialize") => json!({"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake", "version": "1"}}),
                _ => json!({"tools": [{"name": "search", "description": "Search", "inputSchema": {"type": "object"}}]}),
            };
            Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The user approves on the service's page: a code for the redirect_uri the
/// authorization named, which must be one the client registered.
fn approve(f: &Fake, auth_url: &str) -> (String, String, String) {
    let u = reqwest::Url::parse(auth_url).unwrap();
    let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
    assert!(f.clients.lock().unwrap()[&q["client_id"]].contains(&q["redirect_uri"]));
    let code = format!("code-{}", f.codes.lock().unwrap().len() + 100);
    f.codes.lock().unwrap().insert(code.clone(), (q["client_id"].clone(), q["redirect_uri"].clone()));
    (code, q["state"].clone(), q["redirect_uri"].clone())
}

struct Client {
    app: Router,
}

impl Client {
    /// `via_proxy`: the request crossed a network (a reverse proxy, the relay).
    async fn json(&self, method: &str, uri: &str, body: Option<Value>, via_proxy: bool) -> (StatusCode, Value) {
        let mut b = Request::builder().method(method).uri(uri);
        if via_proxy {
            b = b.header("x-forwarded-for", "203.0.113.7");
        }
        let body = match body {
            Some(v) => {
                b = b.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let mut req = b.body(body).unwrap();
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some("127.0.0.1:8000".parse().unwrap()), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        (parts.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connector_signs_in_from_any_client() {
    let root = tempfile::tempdir().unwrap();
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.path().join(d));
    }
    std::env::set_var("HOME", root.path().join("home"));
    std::env::set_var("OPENAGENTD_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    std::env::set_var("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false");
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAGENTD_MCP_OAUTH_CALLBACK"] {
        std::env::remove_var(k);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    appv3_api::startup::startup(&pool).await.unwrap();
    let c = Client { app: create_app(AppState { pool: pool.clone() }, Policy::from_env()) };

    let fake = Fake::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    *fake.base.lock().unwrap() = base.clone();
    let app = Router::new().fallback(any(handle)).with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    // A new connector that needs sign-in waits for it.
    let (st, v) = c
        .json("POST", "/api/mcp/servers", Some(json!({"name": "notes", "server": {"transport": "http", "url": format!("{base}/mcp"), "headers": {}, "enabled": true}})), false)
        .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert_eq!(v["state"], "auth_required", "{v}");

    // ── from another device: the relay page ──────────────────────────────
    let (st, v) = c.json("POST", "/api/mcp/servers/notes/oauth/start", Some(json!({})), true).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "another device must say where to return: {v}");
    let (st, v) = c.json("POST", "/api/mcp/servers/notes/oauth/start", Some(json!({"return_to": "https://evil.example/steal"})), true).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");

    let (st, v) = c.json("POST", "/api/mcp/servers/notes/oauth/start", Some(json!({"return_to": "http://192.168.1.20:7681/oauth-done.html"})), true).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!((v["status"].as_str(), v["return"].as_str()), (Some("sign_in"), Some("relay")), "{v}");
    let (code, state, redirect) = approve(&fake, v["auth_url"].as_str().unwrap());
    assert_eq!(redirect, "https://account.openagentd.dev/oauth/callback");
    let (_, st_v) = c.json("GET", "/api/mcp/servers/notes/oauth/status", None, true).await;
    assert_eq!(st_v["status"], "waiting");

    let (st, v) = c.json("POST", "/api/mcp/oauth/finish", Some(json!({"code": code, "state": "forged"})), true).await;
    assert_eq!(st, StatusCode::CONFLICT, "a code for no waiting sign-in is refused: {v}");
    let (st, v) = c.json("POST", "/api/mcp/oauth/finish", Some(json!({"code": code, "state": state})), true).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "done", "{v}");
    assert_eq!(v["server"]["state"], "ready", "{v}");
    assert_eq!(v["server"]["tool_names"], json!(["notes_search"]), "{v}");
    let (st, _) = c.json("POST", "/api/mcp/oauth/finish", Some(json!({"code": code, "state": state})), true).await;
    assert_eq!(st, StatusCode::CONFLICT, "single use");

    // ── sign out keeps the connector, drops the sign-in ──────────────────
    let (st, v) = c.json("POST", "/api/mcp/servers/notes/oauth/sign-out", None, false).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["state"], "auth_required", "{v}");
    let (_, v) = c.json("GET", "/api/mcp/servers", None, false).await;
    assert!(v["servers"].as_array().unwrap().iter().any(|s| s["name"] == "notes"));

    // ── from this machine: localhost, finished by a pasted address ───────
    let (st, v) = c.json("POST", "/api/mcp/servers/notes/oauth/start", None, false).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["return"], "loopback", "{v}");
    let (code, state, redirect) = approve(&fake, v["auth_url"].as_str().unwrap());
    assert!(redirect.starts_with("http://localhost:"), "{redirect}");
    let pasted = format!("{redirect}?code={code}&state={state}");
    let (st, v) = c.json("POST", "/api/mcp/oauth/finish", Some(json!({"url": pasted})), false).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["server"]["state"], "ready", "{v}");

    // ── a cancelled sign-in fails instead of waiting ─────────────────────
    let (st, v) = c.json("POST", "/api/mcp/servers/notes/oauth/start", Some(json!({"return_to": "openagentd://mcp-oauth"})), true).await;
    // Starting clears the old sign-in, so it asks again; cancelling ends it.
    assert_eq!((st, v["status"].as_str()), (StatusCode::OK, Some("sign_in")), "{v}");
    let (st, _) = c.json("POST", "/api/mcp/servers/notes/oauth/cancel", None, true).await;
    assert_eq!(st, StatusCode::OK);
    let mut last = Value::Null;
    for _ in 0..100 {
        let (_, v) = c.json("GET", "/api/mcp/servers/notes/oauth/status", None, true).await;
        last = v;
        if last["status"] != "waiting" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(last["status"], "failed", "{last}");
}
