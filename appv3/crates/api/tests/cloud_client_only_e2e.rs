//! A computer that signs in with only "Use as client" runs no connector
//! (spec 3.4): it is connected, its relay state is `off`, and no session
//! reaches it. Against the fake cloud of `native/cloud/tests/fake_cloud`.

#[path = "../../../../native/cloud/tests/fake_cloud/mod.rs"]
mod fake_cloud;

use std::net::SocketAddr;
use std::time::Duration;

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use fake_cloud::Fake;
use http_body_util::BodyExt;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::relay::{self, Join};
use serde_json::{json, Value};
use tower::ServiceExt;

const FAST: Pace = Pace { every: Duration::from_millis(50), timeout: Duration::from_secs(20) };

async fn call(app: &axum::Router, method: &str, uri: &str, body: Option<Value>, remote: &str) -> (StatusCode, Value) {
    let builder = Request::builder().method(method).uri(uri).header("host", "localhost:8000");
    let mut req = match body {
        Some(b) => builder.header("content-type", "application/json").body(Body::from(b.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let addr: SocketAddr = "127.0.0.1:8000".parse().unwrap();
    req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(addr), remote: Some(remote.parse().unwrap()) }));
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn local(app: &axum::Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    call(app, method, uri, body, "127.0.0.1:50000").await
}

async fn wait_for(app: &axum::Router, what: &str, ok: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..400 {
        let (_, v) = local(app, "GET", "/api/cloud/status", None).await;
        if ok(&v) {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

fn cloud(base: &str, roles: Roles) -> Cloud {
    let mut c = Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None);
    c.roles = roles;
    c
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_only_computer_runs_no_connector() {
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
    let fake = Fake::new();
    let base = fake.serve().await;
    std::env::set_var("OPENAGENTD_CLOUD_API", &base);
    std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
    let pool = appv3_db::create_pool(&appv3_core::settings().database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    let app = create_app(AppState { pool }, Policy::from_env());
    appv3_api::cloud::install(app.clone(), 8000);

    // A phone creates the account.
    let account = fake.new_account();
    let mut phone = Member::new(cloud(&base, Roles::CLIENT), None);
    let code = phone.cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&phone.cloud, &code).await.unwrap();
    flows::genesis(&mut phone, &session, flows::GenesisDraft::new()).await.unwrap();

    // This computer signs in as a client only; the phone approves it.
    let (s, _) = local(&app, "POST", "/api/cloud/login", Some(json!({ "server": false, "client": true }))).await;
    assert_eq!(s, StatusCode::OK);
    let v = wait_for(&app, "the user code", |v| v["state"] == "signing_in").await;
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    wait_for(&app, "the join request", |v| v["state"] == "joining").await;
    let pending = phone.cloud.pending_list().await.unwrap().remove(0);
    let mut approval = flows::begin_approval(&mut phone, pending).await.unwrap();
    let shown = flows::await_reveal(&mut phone, &mut approval, FAST).await.unwrap();
    assert_eq!(shown.roles, Roles::CLIENT);
    flows::confirm_approval(&mut phone, approval, flows::Grant { signer: true, roles: Roles::CLIENT }).await.unwrap();
    let v = wait_for(&app, "connected without a connector", |v| v["state"] == "connected" && v["relay"]["state"] == "off").await;
    assert_eq!((v["server"].as_bool(), v["client"].as_bool(), v["signer"].as_bool()), (Some(false), Some(true), Some(true)));

    // Nothing reaches it through the relay: it has no presence, and the
    // phone does not list it as a computer.
    let me = phone.roster.as_ref().unwrap().body.devices.iter().find(|d| d.id != phone.cloud.device_id()).unwrap().clone();
    assert!(!me.server);
    assert_eq!(phone.roster.as_ref().unwrap().body.servers().count(), 0);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let r = relay::connect(&phone.cloud, &relay::http1_client(), &me.id, &me.box_key(), Join::default()).await;
    assert!(r.is_err(), "no connector answers");
    phone.cloud.leave().await.ok();
}
