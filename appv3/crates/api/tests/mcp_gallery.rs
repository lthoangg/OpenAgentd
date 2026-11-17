//! The connector gallery over HTTP: a signed list served from "the cloud"
//! (a local fake with a test key), what turning an entry on writes, a new
//! entry published later, a tampered list, a key entry and an address move.
//!
//! Settings and managers are process-global, so everything runs in one test.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

/// What the fake cloud serves: the list's bytes and its signature.
#[derive(Clone, Default)]
struct Cloud {
    list: Arc<Mutex<(String, String)>>,
}

async fn handle(State(c): State<Cloud>, uri: Uri, body: String) -> Response {
    match uri.path() {
        "/connectors/v1.json" => c.list.lock().unwrap().0.clone().into_response(),
        "/connectors/v1.json.sig" => c.list.lock().unwrap().1.clone().into_response(),
        "/mcp" | "/mcp2" => {
            let m: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let Some(id) = m.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
            let result = match m["method"].as_str() {
                Some("initialize") => json!({"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "docs", "version": "1"}}),
                _ => json!({"tools": [{"name": "lookup", "description": "Look up", "inputSchema": {"type": "object"}}]}),
            };
            Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn publish(c: &Cloud, key: &SigningKey, entries: Value) {
    let body = json!({"version": 1, "entries": entries}).to_string();
    let sig = base64::engine::general_purpose::STANDARD.encode(key.sign(body.as_bytes()).to_bytes());
    *c.list.lock().unwrap() = (body, sig);
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            b = b.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let mut req = b.body(body).unwrap();
    req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some("127.0.0.1:8000".parse().unwrap()), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
    let resp = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = resp.into_parts();
    (parts.status, serde_json::from_slice(&body.collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
}

fn entry<'a>(v: &'a Value, id: &str) -> Option<&'a Value> {
    v["entries"].as_array().unwrap().iter().find(|e| e["id"] == id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_gallery_comes_from_the_signed_cloud_list() {
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
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAGENTD_GALLERY"] {
        std::env::remove_var(k);
    }
    let cloud = Cloud::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(any(handle)).with_state(cloud.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let key = SigningKey::from_bytes(&[9u8; 32]);
    std::env::set_var("OPENAGENTD_GALLERY_URL", format!("{base}/connectors/v1.json"));
    std::env::set_var("OPENAGENTD_GALLERY_KEY", base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes()));

    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    appv3_api::startup::startup(&pool).await.unwrap();
    let app = create_app(AppState { pool: pool.clone() }, Policy::from_env());

    let docs = json!({"type": "connector", "id": "docs", "name": "Docs", "category": "docs", "description": "Free docs.", "url": format!("{base}/mcp"), "auth": "none"});
    publish(&cloud, &key, json!([docs]));

    // ── the cloud list, and turning an entry on ──────────────────────────
    let (st, v) = call(&app, "GET", "/api/mcp/gallery", None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["source"], "cloud", "{v}");
    assert_eq!(entry(&v, "docs").unwrap()["server"], Value::Null);
    assert!(entry(&v, "notion").is_none(), "the cloud list replaces the shipped one");

    let (st, v) = call(&app, "POST", "/api/mcp/gallery/docs/enable", None).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert_eq!((v["name"].as_str(), v["state"].as_str()), (Some("docs"), Some("ready")), "{v}");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(s.mcp_config_path()).unwrap()).unwrap();
    assert_eq!(saved["servers"]["docs"]["url"], format!("{base}/mcp"), "an ordinary mcp.json entry: {saved}");
    let (st, v) = call(&app, "POST", "/api/mcp/gallery/docs/enable", None).await;
    assert_eq!(st, StatusCode::OK, "turning it on again keeps the one connector: {v}");
    let (_, v) = call(&app, "GET", "/api/mcp/gallery", None).await;
    assert_eq!(entry(&v, "docs").unwrap()["server"]["state"], "ready", "{v}");

    // ── a connector published later shows up without an update ───────────
    let github_like = json!({"type": "connector", "id": "keyed", "name": "Keyed", "description": "Needs a key.", "url": format!("{base}/mcp2"),
        "auth": {"header": "Authorization", "template": "Bearer {key}", "key_url": "https://example.com/tokens"}});
    publish(&cloud, &key, json!([docs, github_like]));
    let (_, v) = call(&app, "GET", "/api/mcp/gallery", None).await;
    assert!(entry(&v, "keyed").is_none(), "a fresh cache is used for 15 minutes: {v}");
    let (_, v) = call(&app, "GET", "/api/mcp/gallery?refresh=1", None).await;
    assert_eq!(v["source"], "cloud");
    assert!(entry(&v, "keyed").is_some(), "opening the gallery fetches it: {v}");

    // ── a key entry stores the key as a secret ───────────────────────────
    let (st, v) = call(&app, "POST", "/api/mcp/gallery/keyed/enable", Some(json!({}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = call(&app, "POST", "/api/mcp/gallery/keyed/enable", Some(json!({"key": "ghp_secret"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let raw = std::fs::read_to_string(s.mcp_config_path()).unwrap();
    assert!(!raw.contains("ghp_secret"), "mcp.json keeps a reference, not the key: {raw}");
    assert!(raw.contains("Bearer ${KEYED_MCP_API_KEY}"), "{raw}");

    // ── a tampered list is ignored; the last good one stays ──────────────
    let tampered =
        json!({"version": 1, "entries": [{"type": "connector", "id": "evil", "name": "Evil", "description": "x", "url": "https://evil.example/mcp", "auth": "none"}]}).to_string();
    let good_sig = cloud.list.lock().unwrap().1.clone();
    *cloud.list.lock().unwrap() = (tampered, good_sig);
    let (_, v) = call(&app, "GET", "/api/mcp/gallery?refresh=1", None).await;
    assert_eq!(v["source"], "cache", "{v}");
    assert!(entry(&v, "evil").is_none() && entry(&v, "keyed").is_some(), "{v}");

    // ── the provider moves: the connector on the old address is offered the update
    let moved = json!({"type": "connector", "id": "docs", "name": "Docs", "description": "Free docs.", "url": format!("{base}/mcp2"), "previous_urls": [format!("{base}/mcp")], "auth": "none"});
    publish(&cloud, &key, json!([moved]));
    let (_, v) = call(&app, "GET", "/api/mcp/gallery?refresh=1", None).await;
    let docs = entry(&v, "docs").unwrap();
    assert_eq!(docs["update_for"], "docs", "{v}");
    let (st, v) = call(&app, "POST", "/api/mcp/gallery/docs/update", None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["config"]["url"], format!("{base}/mcp2"), "{v}");

    // ── off: only the shipped copy, no call out ──────────────────────────
    std::env::set_var("OPENAGENTD_GALLERY", "off");
    let (_, v) = call(&app, "GET", "/api/mcp/gallery?refresh=1", None).await;
    assert_eq!(v["source"], "bundled", "{v}");
    assert!(entry(&v, "notion").is_some() && entry(&v, "context7").is_some(), "{v}");
}
