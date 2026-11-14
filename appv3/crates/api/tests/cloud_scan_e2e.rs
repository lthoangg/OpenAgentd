//! Scan to add (spec 4.3.1) on a computer, end to end against the fake
//! cloud of `native/cloud/tests/fake_cloud`:
//!
//! 1. `POST /api/cloud/login` shows a scan code next to the browser way,
//!    to this computer's own callers only;
//! 2. a phone that approves scans it and adds the computer; the computer
//!    asks for the number (`confirming`) with the phone's number among
//!    three, and stores nothing until it is picked;
//! 3. a wrong pick makes it leave the account: back to guest with
//!    `wrong_number`, nothing stored;
//! 4. the right pick joins: `connected`, identity stored;
//! 5. the scan code never reaches the logs.

#[path = "../../../../native/cloud/tests/fake_cloud/mod.rs"]
mod fake_cloud;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use fake_cloud::Fake;
use http_body_util::BodyExt;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, Candidates, GenesisDraft, Grant, Member};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use serde_json::{json, Value};
use tower::ServiceExt;

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

/// A phone that created an account: its only signer.
async fn phone_with_account(fake: &Fake, base: &str) -> (Member, String) {
    let account = fake.new_account();
    let mut c = Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None);
    c.roles = Roles::CLIENT;
    let code = c.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&c, &code).await.unwrap();
    let mut m = Member::new(c, None);
    flows::genesis(&mut m, &session, GenesisDraft::new()).await.unwrap();
    (m, account)
}

/// The phone scans `link`, waits for the computer's claim and adds it;
/// returns the number it shows and the computer's device id.
async fn phone_adds(phone: &mut Member, link: &str) -> (String, String) {
    let invite = flows::offer_scanned(phone, link).await.unwrap();
    let id = invite.scanned().unwrap().to_string();
    let mut candidate = None;
    for _ in 0..400 {
        if let Candidates::One(c) = flows::check_candidates(phone, &invite).await.unwrap() {
            candidate = Some(c);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let c = candidate.expect("the computer claimed");
    let (_, number) = flows::add_scanned(phone, invite, &c.enrollment_id, Grant { signer: false, roles: Roles::BOTH }).await.unwrap();
    (number, id)
}

/// Every log line this test process writes.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_phone_adds_this_computer_by_scanning_and_the_person_picks_the_number() {
    let logs = Logs::default();
    let writer = logs.clone();
    tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_writer(move || writer.clone()).init();

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
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let stored = || appv3_api::cloud::identity_store().path().exists();

    // 1. The sign-in step shows a scan code, to this computer only.
    let (s, _) = local(&app, "POST", "/api/cloud/number", Some(json!({ "number": "12" }))).await;
    assert_eq!(s, StatusCode::CONFLICT, "no number is asked for yet");
    let (s, _) = local(&app, "POST", "/api/cloud/login", Some(json!({ "server": true, "client": true }))).await;
    assert_eq!(s, StatusCode::OK);
    let v = wait_for(&app, "the scan code", |v| v["state"] == "signing_in").await;
    let link = v["add_link"].as_str().expect("a scan code").to_string();
    assert!(link.starts_with("agentd://add?"), "{link}");
    assert!(v["url"].as_str().is_some(), "the browser way is still there");
    let (_, lan) = call(&app, "GET", "/api/cloud/status", None, "192.168.1.20:5000").await;
    assert!(lan.get("add_link").is_none(), "{lan}");

    // 2. The phone scans and adds it; the computer asks for the number.
    let (number, id) = phone_adds(&mut phone, &link).await;
    let v = wait_for(&app, "the number step", |v| v["state"] == "confirming").await;
    let choices: Vec<String> = v["choices"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
    assert_eq!(choices.iter().filter(|c| **c == number).count(), 1, "{choices:?} has {number}");
    assert!(!stored(), "nothing is stored before the pick");
    let (_, lan) = call(&app, "GET", "/api/cloud/status", None, "192.168.1.20:5000").await;
    assert!(lan.get("choices").is_none(), "{lan}");

    // 3. A wrong pick leaves the account.
    let wrong = choices.iter().find(|c| **c != number).unwrap().clone();
    let (s, v) = local(&app, "POST", "/api/cloud/number", Some(json!({ "number": wrong }))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let v = wait_for(&app, "guest again", |v| v["state"] == "guest").await;
    assert_eq!(v["notice"], "wrong_number");
    assert!(!stored());
    assert!(!fake.account(&account).devices[&id].1, "the computer left");

    // Cancel on the number step also leaves, then a fresh sign-in works.
    local(&app, "POST", "/api/cloud/login", Some(json!({ "server": true, "client": true }))).await;
    let v = wait_for(&app, "a code to cancel", |v| v["state"] == "signing_in").await;
    let (_, cancelled_id) = phone_adds(&mut phone, v["add_link"].as_str().unwrap()).await;
    wait_for(&app, "the number step to cancel", |v| v["state"] == "confirming").await;
    local(&app, "POST", "/api/cloud/login/cancel", None).await;
    flows::settle_withdrawals(Duration::from_secs(5)).await;
    assert_eq!(local(&app, "GET", "/api/cloud/status", None).await.1["state"], "guest");
    assert!(!fake.account(&account).devices[&cancelled_id].1);
    assert!(!stored());

    // 4. Again, and this time the right pick joins.
    local(&app, "POST", "/api/cloud/login", Some(json!({ "server": true, "client": true }))).await;
    let v = wait_for(&app, "a new scan code", |v| v["state"] == "signing_in").await;
    let link2 = v["add_link"].as_str().unwrap().to_string();
    assert_ne!(link2, link, "a new code and secret");
    let (number, id) = phone_adds(&mut phone, &link2).await;
    wait_for(&app, "the number step", |v| v["state"] == "confirming").await;
    let (s, v) = local(&app, "POST", "/api/cloud/number", Some(json!({ "number": number }))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    wait_for(&app, "connected", |v| v["state"] == "connected").await;
    assert!(stored());
    assert!(fake.account(&account).devices[&id].1, "in the account");
    let (s, _) = local(&app, "POST", "/api/cloud/number", Some(json!({ "number": number }))).await;
    assert_eq!(s, StatusCode::CONFLICT, "one answer only");

    // 5. The scan codes' secrets never reach the logs.
    let text = String::from_utf8_lossy(&logs.0.lock().unwrap()).to_string();
    for l in [&link, &link2] {
        let k = l.split("&k=").nth(1).unwrap();
        assert!(!text.contains(k), "the secret was logged");
    }
}
