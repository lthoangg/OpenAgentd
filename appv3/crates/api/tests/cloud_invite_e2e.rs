//! A computer that approves shows an invitation, end to end against the
//! fake cloud of `native/cloud/tests/fake_cloud`:
//!
//! 1. this server creates the account (it is the signer);
//! 2. `invite/start` and `invite/poll` answer only this computer, and only
//!    with the desktop app's proof (the link is a bearer secret, kept from
//!    an agent's shell); a relayed device and the LAN are refused;
//! 3. a phone claims the invitation with its own key; the server shows the
//!    candidate's kind and fingerprint, refuses to add it without the proof
//!    for exactly that request, and adds it with the proof;
//! 4. two devices that both prove the secret get nobody added, and the
//!    invitation is cancelled;
//! 5. cancel and the time limit close the invitation in the cloud;
//! 6. the link never reaches the logs.

#[path = "../../../../native/cloud/tests/fake_cloud/mod.rs"]
mod fake_cloud;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use appv3_api::middleware::RelayPeer;
use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use fake_cloud::Fake;
use http_body_util::BodyExt;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::approval::{self, Action};
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::recovery;
use serde_json::{json, Value};
use tower::ServiceExt;

const FAST: Pace = Pace { every: Duration::from_millis(50), timeout: Duration::from_secs(20) };
const KEY: [u8; approval::KEY_LEN] = [42; approval::KEY_LEN];

#[derive(Clone, Copy)]
enum From {
    Local,
    Lan,
    Relayed,
}

async fn call(app: &axum::Router, uri: &str, body: Option<Value>, from: From, proof: Option<String>) -> (StatusCode, Value) {
    let method = if uri.ends_with("/status") { "GET" } else { "POST" };
    let mut builder = Request::builder().method(method).uri(uri).header("host", "localhost:8000");
    if let Some(p) = proof {
        builder = builder.header(approval::HEADER, p);
    }
    let mut req = match body {
        Some(b) => builder.header("content-type", "application/json").body(Body::from(b.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let local: SocketAddr = "127.0.0.1:8000".parse().unwrap();
    match from {
        From::Local => {
            req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        }
        From::Lan => {
            req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some("192.168.1.20:5000".parse().unwrap()) }));
        }
        From::Relayed => {
            req.extensions_mut().insert(RelayPeer { device_id: "D-relayed".into() });
        }
    }
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn invite_proof(id: &str) -> Option<String> {
    Some(approval::proof(&KEY, Action::Invite, id))
}

fn add_proof(body: &Value) -> Option<String> {
    let flag = |k: &str| body[k].as_bool().unwrap();
    Some(approval::proof(&KEY, Action::Approve { signer: flag("signer"), server: flag("server"), client: flag("client") }, body["enrollment_id"].as_str().unwrap()))
}

async fn wait_for(app: &axum::Router, what: &str, ok: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..400 {
        let (_, v) = call(app, "/api/cloud/status", None, From::Local, None).await;
        if ok(&v) {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn start(app: &axum::Router) -> Value {
    let (s, v) = call(app, "/api/cloud/invite/start", None, From::Local, invite_proof("start")).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}

async fn poll(app: &axum::Router, slot: &str) -> Value {
    let (s, v) = call(app, "/api/cloud/invite/poll", Some(json!({ "slot_id": slot })), From::Local, invite_proof(slot)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}

fn phone(base: &str) -> Member {
    let mut c = Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None);
    c.roles = Roles::CLIENT;
    Member::new(c, None)
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
async fn a_computer_shows_an_invitation_and_adds_the_device_that_scanned_it() {
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
    appv3_api::cloud::approval::install_key(zeroize::Zeroizing::new(KEY));

    // 1. This server creates the account.
    let account = fake.new_account();
    let (s, _) = call(&app, "/api/cloud/login", Some(json!({ "server": true, "client": true })), From::Local, None).await;
    assert_eq!(s, StatusCode::OK);
    let v = wait_for(&app, "the user code", |v| v["state"] == "signing_in").await;
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    let v = wait_for(&app, "the recovery step", |v| v["state"] == "recovery").await;
    let code = v["code"].as_str().unwrap().to_string();
    let check: Vec<usize> = v["check"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).collect();
    let group = |n: usize| recovery::group(&code, n).unwrap().to_string();
    let (s, v) = call(&app, "/api/cloud/recovery", Some(json!({ "first": group(check[0]), "second": group(check[1]) })), From::Local, None).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    wait_for(&app, "connected", |v| v["state"] == "connected" && v["signer"] == true).await;

    // 2. Only this computer, and only the app, can open an invitation.
    for from in [From::Lan, From::Relayed] {
        let (s, _) = call(&app, "/api/cloud/invite/start", None, from, invite_proof("start")).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    let (s, v) = call(&app, "/api/cloud/invite/start", None, From::Local, None).await;
    assert_eq!((s, v["detail"].as_str()), (StatusCode::FORBIDDEN, Some(appv3_api::cloud::approval::INVITE_ELSEWHERE)), "an agent's shell has no proof");
    let (s, _) = call(&app, "/api/cloud/invite/start", None, From::Local, Some(approval::proof(&KEY, Action::Remove, "start"))).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "a proof for another action");
    assert!(fake.0.lock().unwrap().invites.is_empty(), "nothing was opened yet");

    let view = start(&app).await;
    let link = view["link"].as_str().unwrap().to_string();
    let slot = view["slot_id"].as_str().unwrap().to_string();
    assert!(link.starts_with("agentd://invite?"), "{link}");
    assert!(view["expires_at"].as_u64().unwrap() > 0);
    for from in [From::Lan, From::Relayed] {
        let (s, _) = call(&app, "/api/cloud/invite/poll", Some(json!({ "slot_id": slot })), from, invite_proof(&slot)).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    let (s, _) = call(&app, "/api/cloud/invite/poll", Some(json!({ "slot_id": slot })), From::Local, invite_proof("start")).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "the proof binds the slot");
    assert_eq!(poll(&app, &slot).await, json!({ "state": "waiting" }));

    // 3. A phone scans it; the server shows it and adds it only with the proof.
    let mut ours = phone(&base);
    let claim = flows::claim_invite(&mut ours, &link).await.unwrap();
    let v = poll(&app, &slot).await;
    assert_eq!(v["state"], "candidate", "{v}");
    let c = &v["candidate"];
    assert_eq!(c["fingerprint"].as_str().unwrap(), ours.cloud.keys.fingerprint());
    assert_eq!(c["kind"].as_str(), openagentd_cloud::api::this_kind());
    assert_eq!((c["server"].as_bool(), c["client"].as_bool()), (Some(false), Some(true)));
    let enrollment = c["enrollment_id"].as_str().unwrap().to_string();
    let body = json!({ "enrollment_id": enrollment, "signer": true, "server": false, "client": true });
    let (s, v) = call(&app, "/api/cloud/invite/add", Some(body.clone()), From::Local, None).await;
    assert_eq!((s, v["detail"].as_str()), (StatusCode::FORBIDDEN, Some(appv3_api::cloud::approval::APPROVE_ELSEWHERE)));
    let other = json!({ "enrollment_id": enrollment, "signer": true, "server": true, "client": true });
    let (s, _) = call(&app, "/api/cloud/invite/add", Some(body.clone()), From::Local, add_proof(&other)).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "a proof for other roles");
    let (s, _) = call(&app, "/api/cloud/invite/add", Some(body.clone()), From::Relayed, add_proof(&body)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(poll(&app, &slot).await["state"], "candidate", "a refused add leaves it open");
    let version = fake.account(&account).version;
    let joined = tokio::spawn(async move { flows::await_invited(&mut ours, claim, FAST).await.map(|r| r.version()) });
    let (s, v) = call(&app, "/api/cloud/invite/add", Some(body.clone()), From::Local, add_proof(&body)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(joined.await.unwrap().unwrap(), version + 1, "the phone is in, with the server's roster");
    assert_eq!(poll(&app, &slot).await, json!({ "state": "ended" }), "the invitation is spent");

    // 4. Two devices with the secret: nobody is added, it is cancelled.
    let view = start(&app).await;
    let (link, slot) = (view["link"].as_str().unwrap().to_string(), view["slot_id"].as_str().unwrap().to_string());
    flows::claim_invite(&mut phone(&base), &link).await.unwrap();
    flows::claim_invite(&mut phone(&base), &link).await.unwrap();
    assert_eq!(poll(&app, &slot).await, json!({ "state": "compromised" }));
    assert!(!appv3_api::cloud::invite::is_open().await);
    assert!(!fake.0.lock().unwrap().invites.contains_key(&slot), "cancelled in the cloud");
    assert_eq!(fake.account(&account).version, version + 1, "nobody was added");

    // 5. Cancel, and the time limit, close it in the cloud.
    let view = start(&app).await;
    let previous = view["slot_id"].as_str().unwrap().to_string();
    let view = start(&app).await;
    assert!(!fake.0.lock().unwrap().invites.contains_key(&previous), "a new one cancels the old one");
    let slot = view["slot_id"].as_str().unwrap().to_string();
    let (s, _) = call(&app, "/api/cloud/invite/cancel", None, From::Local, None).await;
    assert_eq!(s, StatusCode::OK);
    assert!(!fake.0.lock().unwrap().invites.contains_key(&slot));
    assert_eq!(poll(&app, &slot).await, json!({ "state": "ended" }));

    appv3_api::cloud::invite::set_ttl_for_tests(Duration::from_millis(300));
    let view = start(&app).await;
    let slot = view["slot_id"].as_str().unwrap().to_string();
    assert!(fake.0.lock().unwrap().invites.contains_key(&slot));
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!appv3_api::cloud::invite::is_open().await, "the timer closed it with no poll");
    assert!(!fake.0.lock().unwrap().invites.contains_key(&slot), "and cancelled it in the cloud");
    appv3_api::cloud::invite::set_ttl_for_tests(appv3_api::cloud::invite::INVITE_TTL);

    // A stopping server cancels an open one.
    let view = start(&app).await;
    let slot = view["slot_id"].as_str().unwrap().to_string();
    assert!(fake.0.lock().unwrap().invites.contains_key(&slot));
    appv3_api::cloud::stop().await;
    assert!(!appv3_api::cloud::invite::is_open().await);
    assert!(!fake.0.lock().unwrap().invites.contains_key(&slot));

    // 6. The links never reached the logs.
    let written = String::from_utf8_lossy(&logs.0.lock().unwrap()).to_string();
    assert!(written.contains("cloud_invite_opened"), "the test sees the logs");
    assert!(!written.contains("agentd://invite"), "an invitation link was logged");
    let secret = link.split(['?', '&']).find_map(|p| p.strip_prefix("k=")).unwrap();
    assert!(!written.contains(secret), "the invitation secret was logged");
}
