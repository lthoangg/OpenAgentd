//! `/api/cloud/*` through the real router: anyone who may use the API reads
//! the status, but only the machine itself signs in or out. A relayed
//! device and a LAN client with the access key are both refused.

use appv3_api::cloud::connector;
use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use std::net::SocketAddr;
use tower::ServiceExt;

const KEY: &str = "test-access-key-0123456789";

async fn send(app: &axum::Router, method: &str, uri: &str, remote: &str, key: Option<&str>) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri).header("host", "localhost:8000");
    if let Some(k) = key {
        b = b.header("authorization", format!("Bearer {k}"));
    }
    let mut req = b.body(Body::empty()).unwrap();
    let local: SocketAddr = "127.0.0.1:8000".parse().unwrap();
    req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some(remote.parse().unwrap()) }));
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn relayed(app: &axum::Router, method: &str, uri: &str, key: Option<&str>) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri).header("host", "localhost");
    if let Some(k) = key {
        b = b.header("authorization", format!("Bearer {k}"));
    }
    let resp = connector::handle(app.clone(), "D-relayed".into(), b.body(Body::empty()).unwrap()).await;
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn account_routes_answer_only_this_computer() {
    let temp = tempfile::tempdir().unwrap();
    for (key, name) in [("CONFIG", "config"), ("DATA", "data"), ("CACHE", "cache"), ("STATE", "state"), ("WORKSPACE", "workspace")] {
        std::fs::create_dir_all(temp.path().join(name)).unwrap();
        std::env::set_var(format!("OPENAGENTD_{key}_DIR"), temp.path().join(name));
    }
    std::env::set_var("HOME", temp.path().join("home"));
    std::env::set_var("OPENAGENTD_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    for key in ["OPENAGENTD_ACCESS_KEY", "OPENAGENTD_DESKTOP_TOKEN", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAGENTD_ALLOW_INSECURE_LAN"] {
        std::env::remove_var(key);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let pool = appv3_db::create_pool(&appv3_core::settings().database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();

    // A keyless server: it trusts loopback callers, never relayed ones.
    let open = create_app(AppState { pool: pool.clone() }, Policy::from_env());
    appv3_api::cloud::install(open.clone(), 8000);
    let (s, v) = send(&open, "GET", "/api/cloud/status", "127.0.0.1:50000", None).await;
    assert_eq!((s, v["state"].as_str()), (StatusCode::OK, Some("guest")), "{v}");
    let (s, _) = send(&open, "POST", "/api/cloud/login/cancel", "127.0.0.1:50000", None).await;
    assert_eq!(s, StatusCode::OK, "the machine itself may manage its account");
    let (s, v) = relayed(&open, "GET", "/api/cloud/status", None).await;
    assert_eq!((s, v["state"].as_str()), (StatusCode::OK, Some("guest")), "a relayed device reads the status");
    for path in ["/api/cloud/login", "/api/cloud/login/cancel", "/api/cloud/logout", "/api/cloud/reload"] {
        let (s, _) = relayed(&open, "POST", path, None).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "relayed {path}");
    }
    // Desktop-token-only routes never answer a relayed device.
    let (s, _) = relayed(&open, "GET", "/api/desktop/network-access", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // A server with an access key: the LAN client presenting it, and a
    // relayed device presenting it, still cannot change the account.
    let mut policy = Policy::from_env();
    policy.token = std::sync::Arc::new(KEY.into());
    let keyed = create_app(AppState { pool }, policy);
    let (s, _) = send(&keyed, "GET", "/api/cloud/status", "192.168.1.20:50000", Some(KEY)).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = send(&keyed, "POST", "/api/cloud/logout", "192.168.1.20:50000", Some(KEY)).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "a LAN client is not this computer");
    let (s, _) = relayed(&keyed, "POST", "/api/cloud/logout", Some(KEY)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // The relayed request is authenticated by its session, not the key it sent.
    let (s, _) = relayed(&keyed, "GET", "/api/cloud/status", None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = send(&keyed, "POST", "/api/cloud/login/cancel", "127.0.0.1:50000", Some(KEY)).await;
    assert_eq!(s, StatusCode::OK);
}
