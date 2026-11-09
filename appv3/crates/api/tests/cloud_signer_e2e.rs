//! A computer is the account's first device and approves the others, end
//! to end against the fake cloud of `native/cloud/tests/fake_cloud`:
//!
//! 1. this server signs in on an empty account (`POST /api/cloud/login`
//!    with both roles), shows the recovery code to this computer only, and
//!    creates the account once two groups are typed back
//!    (`POST /api/cloud/recovery`);
//! 2. a phone signs in; the server lists it as pending with the roles it
//!    asked for, both screens show the same code, a confirm that adds a role
//!    is refused, and the confirm with the asked roles adds it as a signer;
//! 3. the phone (a client) reaches the server through the relay;
//! 4. a server-only device joins the same way and cannot open a session to
//!    the server; then the server removes it (`POST /api/cloud/devices/remove`).

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
use openagentd_cloud::recovery;
use openagentd_cloud::relay::{self, Join, RelayError};
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

/// Signs `c` in and posts its request to join; returns it with the request.
async fn ask_to_join(fake: &Fake, c: Cloud, account: &str) -> (Member, flows::JoinRequest) {
    let code = c.device_code().await.unwrap();
    fake.approve(&code.user_code, account);
    let session = flows::wait_for_session(&c, &code).await.unwrap();
    let mut m = Member::new(c, None);
    let req = flows::request_to_join(&mut m, &session).await.unwrap();
    (m, req)
}

/// The server approves `m` through its routes with `grant`; `m` waits.
async fn approve_on_server(app: &axum::Router, m: &mut Member, req: &flows::JoinRequest, grant: Value) -> Value {
    let (s, rows) = local(app, "GET", "/api/cloud/pending", None).await;
    assert_eq!(s, StatusCode::OK, "{rows}");
    let row = rows.as_array().unwrap().iter().find(|r| r["enrollment_id"] == req.enrollment_id.as_str()).cloned().expect("the request is listed");
    let begin = tokio::spawn({
        let app = app.clone();
        let id = req.enrollment_id.clone();
        async move { local(&app, "POST", "/api/cloud/approve/begin", Some(json!({ "enrollment_id": id }))).await }
    });
    let joined = flows::await_signer(m, req, FAST).await.unwrap();
    let (s, view) = begin.await.unwrap();
    assert_eq!(s, StatusCode::OK, "{view}");
    assert_eq!(view["code"].as_str().unwrap(), joined.code, "both screens show the same code");
    assert_eq!((view["server"].clone(), view["client"].clone()), (row["server"].clone(), row["client"].clone()));
    let mut body = grant;
    body["enrollment_id"] = json!(req.enrollment_id);
    let confirm = tokio::spawn({
        let app = app.clone();
        async move { local(&app, "POST", "/api/cloud/approve/confirm", Some(body)).await }
    });
    let added = flows::await_added(m, joined, req, FAST).await.unwrap();
    let (s, v) = confirm.await.unwrap();
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(added.body.device(&m.cloud.device_id()).is_some());
    row
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_creates_the_account_and_approves_the_others() {
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

    // 1. This server signs in first, on an empty account.
    let account = fake.new_account();
    let (s, _) = local(&app, "POST", "/api/cloud/login", Some(json!({ "server": false, "client": false }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "a device needs a role");
    let (s, _) = local(&app, "POST", "/api/cloud/login", Some(json!({ "server": true, "client": true }))).await;
    assert_eq!(s, StatusCode::OK);
    let v = wait_for(&app, "the user code", |v| v["state"] == "signing_in").await;
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    let v = wait_for(&app, "the recovery step", |v| v["state"] == "recovery").await;
    let code = v["code"].as_str().unwrap().to_string();
    let check: Vec<usize> = v["check"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).collect();
    // Another device asking this server never sees the code.
    let (_, remote) = call(&app, "GET", "/api/cloud/status", None, "192.168.1.20:5000").await;
    assert_eq!(remote, json!({ "state": "recovery" }));
    let (s, _) = local(&app, "POST", "/api/cloud/recovery", Some(json!({ "first": "AAAA", "second": "BBBB" }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "wrong groups keep the step open");
    let group = |n: usize| recovery::group(&code, n).unwrap().to_string();
    let (s, v) = local(&app, "POST", "/api/cloud/recovery", Some(json!({ "first": group(check[0]), "second": group(check[1]) }))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let v = wait_for(&app, "online", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!((v["signer"].as_bool(), v["server"].as_bool(), v["client"].as_bool()), (Some(true), Some(true), Some(true)));
    assert_eq!(fake.account(&account).version, 1);

    // 2. A phone signs in; this server approves it.
    let (mut phone, req) = ask_to_join(&fake, cloud(&base, Roles::CLIENT), &account).await;
    let (s, rows) = call(&app, "GET", "/api/cloud/pending", None, "192.168.1.20:5000").await;
    assert_eq!(s, StatusCode::FORBIDDEN, "only this computer sees requests: {rows}");
    let (_, rows) = local(&app, "GET", "/api/cloud/pending", None).await;
    let row = rows.as_array().unwrap().iter().find(|r| r["enrollment_id"] == req.enrollment_id.as_str()).unwrap();
    assert_eq!((row["server"].as_bool(), row["client"].as_bool()), (Some(false), Some(true)));
    let begin = tokio::spawn({
        let app = app.clone();
        let id = req.enrollment_id.clone();
        async move { local(&app, "POST", "/api/cloud/approve/begin", Some(json!({ "enrollment_id": id }))).await }
    });
    let joined = flows::await_signer(&mut phone, &req, FAST).await.unwrap();
    let (_, view) = begin.await.unwrap();
    assert_eq!(view["code"].as_str().unwrap(), joined.code);
    // The approver cannot add a role the phone did not ask for.
    let more = json!({ "enrollment_id": req.enrollment_id, "signer": true, "server": true, "client": true });
    let (s, v) = local(&app, "POST", "/api/cloud/approve/confirm", Some(more)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    assert_eq!(fake.account(&account).version, 1, "nothing was written");
    let asked = json!({ "enrollment_id": req.enrollment_id, "signer": true, "server": false, "client": true });
    let confirm = tokio::spawn({
        let app = app.clone();
        async move { local(&app, "POST", "/api/cloud/approve/confirm", Some(asked)).await }
    });
    flows::await_added(&mut phone, joined, &req, FAST).await.unwrap();
    assert_eq!(confirm.await.unwrap().0, StatusCode::OK);
    assert!(phone.is_signer() && phone.is_client() && !phone.is_server());
    let (_, devices) = local(&app, "GET", "/api/cloud/devices", None).await;
    let devices = devices.as_array().unwrap().clone();
    assert_eq!(devices.len(), 2);
    let mine = devices.iter().find(|d| d["me"] == true).unwrap();
    assert_eq!((mine["signer"].as_bool(), mine["server"].as_bool()), (Some(true), Some(true)));

    // 3. The phone reaches this server through the relay.
    let server_id = mine["device_id"].as_str().unwrap().to_string();
    let hosts: Vec<_> = phone.roster.as_ref().unwrap().body.servers().map(|d| d.id.clone()).collect();
    assert_eq!(hosts, vec![server_id.clone()], "the phone lists only servers");
    let host_box = phone.box_of(&server_id).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server_id, &host_box, Join::default()).await;
    assert!(tunnel.is_ok(), "{:?}", tunnel.err());

    // 4. A server-only device joins, and cannot open sessions here.
    let (mut ci, req) = ask_to_join(&fake, cloud(&base, Roles::SERVER), &account).await;
    approve_on_server(&app, &mut ci, &req, json!({ "signer": false, "server": true, "client": false })).await;
    assert!(ci.is_server() && !ci.is_client());
    let r = relay::connect(&ci.cloud, &relay::http1_client(), &server_id, &host_box, Join::default()).await;
    assert!(matches!(r, Err(RelayError::Handshake) | Err(RelayError::Closed(4002))), "{:?}", r.err());
    let (s, _) = local(&app, "POST", "/api/cloud/devices/remove", Some(json!({ "device_id": ci.cloud.device_id() }))).await;
    assert_eq!(s, StatusCode::OK);
    let (_, devices) = local(&app, "GET", "/api/cloud/devices", None).await;
    assert_eq!(devices.as_array().unwrap().len(), 2);
    phone.cloud.leave().await.ok();
}
