//! A computer that approves keeps the roster tidy, and brings an account
//! back with its recovery code, end to end against the fake cloud of
//! `native/cloud/tests/fake_cloud`:
//!
//! 1. a phone creates the account and keeps its recovery code; this server
//!    joins and is approved as a device that approves others;
//! 2. another device joins and leaves: within one contact this server, a
//!    signer, writes the roster without it (no prompt);
//! 3. the phone is "lost": this server signs out, and as a fresh computer
//!    recovers the account (`POST /api/cloud/recover`): a mistyped code is
//!    refused at once, another account's code ends in a notice with nothing
//!    changed, and the real one (typed as people type it) makes this
//!    computer the account's only device, one that approves, with the
//!    phone signed out and the status saying the account was recovered
//!    until `POST /api/cloud/recovered/ack`;
//! 4. recovering an account with no devices goes on to create it.

#[path = "../../../../native/cloud/tests/fake_cloud/mod.rs"]
mod fake_cloud;

use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use appv3_api::cloud::engine;
use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use fake_cloud::Fake;
use http_body_util::BodyExt;
use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, FlowError, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use serde_json::{json, Value};
use tower::ServiceExt;

const FAST: Pace = Pace { every: Duration::from_millis(50), timeout: Duration::from_secs(20) };
const ACCOUNT_PAGES: &str = "https://account.openagentd.dev";
const REMOTE: &str = "192.168.1.20:5000";

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

/// Polls `f` until it answers `Some`.
async fn eventually<T, F: Future<Output = Option<T>>>(what: &str, mut f: impl FnMut() -> F) -> T {
    for _ in 0..300 {
        if let Some(v) = f().await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Tells the host's presence socket the roster is current: a reason for
/// it to check in with the cloud (the test shortens the wait between two).
fn nudge(fake: &Fake, account: &str) {
    fake.notify_roster(fake.account(account).version, vec![]);
}

/// The devices the account's stored roster lists.
fn roster_ids(fake: &Fake, account: &str) -> Vec<String> {
    let r = openagentd_cloud::roster::parse(&fake.account(account).roster.expect("a roster")).unwrap();
    r.body.devices.iter().map(|d| d.id.clone()).collect()
}

/// Adds a device to the phone's account by invitation (the way `agentd
/// cloud join` does); answers its identity.
async fn add_by_invite(phone: &mut Member, base: &str) -> openagentd_cloud::store::Identity {
    let invite = flows::start_invite(phone).await.unwrap();
    let link = invite.link().to_string();
    let joiner = tokio::spawn({
        let base = base.to_string();
        async move { engine::join_invite(Endpoints::custom(&base, ACCOUNT_PAGES), reqwest::Client::new(), &link, Roles::BOTH, |_| {}).await }
    });
    let candidate = eventually("the claim", || async {
        match flows::check_candidates(phone, &invite).await.unwrap() {
            flows::Candidates::One(c) => Some(c),
            _ => None,
        }
    })
    .await;
    flows::add_invited(phone, invite, &candidate.enrollment_id, flows::Grant { signer: false, roles: Roles::BOTH }).await.unwrap();
    match joiner.await.unwrap().unwrap() {
        engine::Outcome::Joined(id) => id,
        _ => panic!("expected a join"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_signer_drops_departed_devices_and_the_recovery_code_brings_the_account_back() {
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
    std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", ACCOUNT_PAGES);
    // Check in with the cloud every moment, not every minute.
    appv3_api::cloud::set_contact_every(Duration::from_millis(300));
    let pool = appv3_db::create_pool(&appv3_core::settings().database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    let app = create_app(AppState { pool }, Policy::from_env());
    appv3_api::cloud::install(app.clone(), 8000);

    // 1. The phone creates the account, keeping the recovery code it showed.
    let account = fake.new_account();
    let mut phone = Member::new(Cloud::new(reqwest::Client::new(), Endpoints::custom(&base, ACCOUNT_PAGES), DeviceKeys::generate(), None), None);
    phone.cloud.roles = Roles::CLIENT;
    let code = phone.cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&phone.cloud, &code).await.unwrap();
    assert!(matches!(flows::request_to_join(&mut phone, &session).await, Err(FlowError::EmptyAccount)));
    let draft = GenesisDraft::new();
    let recovery_code = draft.code.to_string();
    flows::genesis(&mut phone, &session, draft).await.unwrap();
    let phone_id = phone.cloud.device_id();

    // This server joins and the phone approves it as a device that approves.
    let (s, _) = local(&app, "POST", "/api/cloud/login", None).await;
    assert_eq!(s, StatusCode::OK);
    let v = wait_for(&app, "the user code", |v| v["state"] == "signing_in").await;
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    wait_for(&app, "the join request", |v| v["state"] == "joining").await;
    let pending = eventually("the request", || async { phone.cloud.pending_list().await.unwrap().into_iter().next() }).await;
    let mut approval = flows::begin_approval(&mut phone, pending).await.unwrap();
    flows::await_reveal(&mut phone, &mut approval, FAST).await.unwrap();
    flows::confirm_approval(&mut phone, approval, flows::Grant { signer: true, roles: Roles::BOTH }).await.unwrap();
    let v = wait_for(&app, "online", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!(v["signer"], true);
    assert!(v.get("recovered").is_none(), "joining is not recovering: {v}");

    // 2. A device joins and leaves: this server, a signer, drops it within one contact.
    let other = add_by_invite(&mut phone, &base).await;
    let other_id = other.keys().unwrap().id();
    assert!(roster_ids(&fake, &account).contains(&other_id));
    Cloud::new(reqwest::Client::new(), Endpoints::custom(&base, ACCOUNT_PAGES), other.keys().unwrap(), other.account_id.clone()).leave().await.unwrap();
    let version = fake.account(&account).version;
    eventually("the roster without the device that left", || async {
        nudge(&fake, &account);
        (!roster_ids(&fake, &account).contains(&other_id)).then_some(())
    })
    .await;
    assert_eq!(fake.account(&account).version, version + 1, "one roster, written once");
    let ids = roster_ids(&fake, &account);
    assert!(ids.contains(&phone_id) && ids.len() == 2, "the others stay: {ids:?}");
    phone.sync().await.unwrap();
    assert!(phone.roster.as_ref().unwrap().body.device(&other_id).is_none(), "the phone reads the tidy roster");
    let (_, rows) = local(&app, "GET", "/api/cloud/devices", None).await;
    assert_eq!(rows.as_array().unwrap().len(), 2, "{rows}");
    wait_for(&app, "online after the write", |v| v["state"] == "connected").await;

    // 3. The phone is lost. This server signs out and recovers as a fresh computer.
    let (_, v) = local(&app, "POST", "/api/cloud/logout", None).await;
    assert_eq!((v["state"].as_str(), v["notice"].as_str()), (Some("guest"), Some("signed_out")));
    let recover = |code: &str| {
        let app = app.clone();
        let body = json!({ "code": code });
        async move { local(&app, "POST", "/api/cloud/recover", Some(body)).await }
    };
    // A mistyped code is refused before any sign-in.
    let (s, v) = recover("ABCD-EFGH").await;
    assert_eq!((s, v["detail"].as_str()), (StatusCode::BAD_REQUEST, Some("That is not a recovery code. Check it and type it again.")));
    assert_eq!(local(&app, "GET", "/api/cloud/status", None).await.1["state"], "guest");
    let (s, _) = call(&app, "POST", "/api/cloud/recover", Some(json!({ "code": recovery_code })), REMOTE).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "only this computer recovers the account");
    let (s, _) = local(&app, "POST", "/api/cloud/recover", Some(json!({ "code": recovery_code, "server": false, "client": false }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "a device needs a role");

    // Another account's code: a notice, nothing changed.
    let version = fake.account(&account).version;
    let (s, v) = recover(&GenesisDraft::new().code).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let v = if v["state"] == "signing_in" { v } else { wait_for(&app, "the user code", |v| v["state"] == "signing_in").await };
    assert_eq!(v["recovering"], true);
    assert!(v.get("add_link").is_none(), "no scan code when recovering: {v}");
    assert_eq!(call(&app, "GET", "/api/cloud/status", None, REMOTE).await.1, json!({ "state": "signing_in", "fingerprint": v["fingerprint"] }), "another device sees no code");
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    let v = wait_for(&app, "the wrong code's notice", |v| v["state"] == "guest").await;
    assert_eq!(v["notice"], "wrong_recovery_code");
    assert_eq!(fake.account(&account).version, version, "nothing was written");

    // The real code, typed as people type it.
    let typed = format!("  {}  ", recovery_code.to_lowercase().replace('-', " "));
    let (s, v) = recover(&typed).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let v = if v["state"] == "signing_in" { v } else { wait_for(&app, "the user code", |v| v["state"] == "signing_in").await };
    assert_eq!(v["recovering"], true);
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    let v = wait_for(&app, "connected", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!((v["signer"].as_bool(), v["server"].as_bool(), v["client"].as_bool(), v["recovered"].as_bool()), (Some(true), Some(true), Some(true), Some(true)), "{v}");
    assert_eq!(fake.account(&account).version, version + 1);
    let (s, _) = call(&app, "POST", "/api/cloud/recovered/ack", None, REMOTE).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(local(&app, "GET", "/api/cloud/status", None).await.1["recovered"], true, "still shown until acknowledged");
    let (s, v) = local(&app, "POST", "/api/cloud/recovered/ack", None).await;
    assert_eq!(s, StatusCode::OK);
    assert!(v["state"] == "connected" && v.get("recovered").is_none(), "{v}");

    // The phone is out; this computer is the account's only device and approves.
    assert!(matches!(phone.sync().await, Err(FlowError::Problem(AccountProblem::Revoked))));
    let (_, rows) = local(&app, "GET", "/api/cloud/devices", None).await;
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!((rows[0]["me"].as_bool(), rows[0]["signer"].as_bool()), (Some(true), Some(true)));
    let host_id = rows[0]["device_id"].as_str().unwrap().to_string();
    assert_eq!(roster_ids(&fake, &account), vec![host_id.clone()]);
    // It names itself in the account once it is in.
    let (_, name) = local(&app, "GET", "/api/server/name", None).await;
    eventually("the computer's name in the account", || async {
        nudge(&fake, &account);
        (fake.account(&account).names.get(&host_id).map(String::as_str) == name["name"].as_str()).then_some(())
    })
    .await;

    // 4. An account with no devices: recovering goes on to create it.
    local(&app, "POST", "/api/cloud/logout", None).await;
    let empty = fake.new_account();
    let (s, v) = recover(&GenesisDraft::new().code).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let v = if v["state"] == "signing_in" { v } else { wait_for(&app, "the user code", |v| v["state"] == "signing_in").await };
    fake.approve(v["user_code"].as_str().unwrap(), &empty);
    let v = wait_for(&app, "the recovery step", |v| v["state"] == "recovery").await;
    assert!(v["code"].is_string() && v["check"].is_array(), "{v}");
    let (_, v) = local(&app, "POST", "/api/cloud/login/cancel", None).await;
    assert_eq!(v["state"], "guest");
}
