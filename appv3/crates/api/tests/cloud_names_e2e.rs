//! Device names and departed devices on a host, end to end against the fake
//! cloud of `native/cloud/tests/fake_cloud`:
//!
//! 1. a phone creates the account; this server joins as a member (the
//!    phone approves it);
//! 2. a computer that joins names itself in the account (its cloud name is
//!    empty, so the contact pushes its server name);
//! 3. a rename made in the account reaches the computer's server name, and
//!    one made here (`PUT /api/server/name`) reaches the account;
//! 4. another device joins and leaves: the device list hides it and shows
//!    the names;
//! 5. `POST /api/cloud/devices/name`: a member cannot rename another
//!    device (403, in words); renaming this computer names it in both
//!    places, and clearing it gives it the host name again.

#[path = "../../../../native/cloud/tests/fake_cloud/mod.rs"]
mod fake_cloud;

use std::collections::HashMap;
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
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use serde_json::{json, Value};
use tower::ServiceExt;

const FAST: Pace = Pace { every: Duration::from_millis(50), timeout: Duration::from_secs(20) };
const ACCOUNT_PAGES: &str = "https://account.openagentd.dev";

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

/// The names the account keeps, by device id.
async fn names_in_account(phone: &Member) -> HashMap<String, Option<String>> {
    phone.cloud.devices().await.unwrap().into_iter().map(|d| (d.device_id, d.name)).collect()
}

/// The name of this server, and whether someone chose it.
async fn server_name(app: &axum::Router) -> (String, bool) {
    let (s, v) = local(app, "GET", "/api/server/name", None).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    (v["name"].as_str().unwrap_or_default().to_string(), v["custom"].as_bool().unwrap())
}

fn stored_identity() -> openagentd_cloud::store::Identity {
    openagentd_cloud::store::load(&appv3_api::cloud::identity_store()).unwrap().expect("an identity")
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
async fn names_follow_the_account_and_departed_devices_are_hidden() {
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
    let (hostname, custom) = server_name(&app).await;
    assert!(!hostname.is_empty() && !custom, "a host name to start with");

    // 1. The phone creates the account; this server joins as a member.
    let account = fake.new_account();
    let mut phone = Member::new(Cloud::new(reqwest::Client::new(), Endpoints::custom(&base, ACCOUNT_PAGES), DeviceKeys::generate(), None), None);
    phone.cloud.roles = Roles::CLIENT;
    let code = phone.cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&phone.cloud, &code).await.unwrap();
    assert!(matches!(flows::request_to_join(&mut phone, &session).await, Err(flows::FlowError::EmptyAccount)));
    flows::genesis(&mut phone, &session, GenesisDraft::new()).await.unwrap();
    let phone_id = phone.cloud.device_id();
    phone.cloud.set_device_name(&phone_id, Some("Hoang's iPhone")).await.unwrap();

    let (s, _) = local(&app, "POST", "/api/cloud/login", None).await;
    assert_eq!(s, StatusCode::OK);
    let v = wait_for(&app, "the user code", |v| v["state"] == "signing_in").await;
    assert!(v.get("recovering").is_none(), "a plain sign-in is not a recovery: {v}");
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    wait_for(&app, "the join request", |v| v["state"] == "joining").await;
    let pending = eventually("the request", || async { phone.cloud.pending_list().await.unwrap().into_iter().next() }).await;
    let mut approval = flows::begin_approval(&mut phone, pending).await.unwrap();
    flows::await_reveal(&mut phone, &mut approval, FAST).await.unwrap();
    flows::confirm_approval(&mut phone, approval, flows::Grant { signer: false, roles: Roles::BOTH }).await.unwrap();
    let v = wait_for(&app, "online", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!(v["signer"], false, "a member");
    let (_, rows) = local(&app, "GET", "/api/cloud/devices", None).await;
    let host_id = rows.as_array().unwrap().iter().find(|d| d["me"] == true).unwrap()["device_id"].as_str().unwrap().to_string();

    // 2. A computer that joined names itself: the account had no name for it.
    let named = eventually("the computer's own name in the account", || async {
        nudge(&fake, &account);
        names_in_account(&phone).await[&host_id].clone()
    })
    .await;
    assert_eq!(named, hostname);
    assert_eq!(stored_identity().name_synced.as_deref(), Some(hostname.as_str()), "what both agree on is remembered");

    // 3. A rename in the account reaches this computer, and one here reaches the account.
    phone.cloud.set_device_name(&host_id, Some("Work Mac")).await.unwrap();
    eventually("the account's name here", || async {
        nudge(&fake, &account);
        (server_name(&app).await == ("Work Mac".to_string(), true)).then_some(())
    })
    .await;
    assert_eq!(stored_identity().name_synced.as_deref(), Some("Work Mac"));
    let (s, v) = local(&app, "PUT", "/api/server/name", Some(json!({ "name": "Studio B" }))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    eventually("the new server name in the account", || async { (names_in_account(&phone).await[&host_id].as_deref() == Some("Studio B")).then_some(()) }).await;
    eventually("what both agree on", || async { (stored_identity().name_synced.as_deref() == Some("Studio B")).then_some(()) }).await;
    // Back to the name the account gave, for the next steps.
    phone.cloud.set_device_name(&host_id, Some("Work Mac")).await.unwrap();
    eventually("the account's name here again", || async {
        nudge(&fake, &account);
        (server_name(&app).await.0 == "Work Mac").then_some(())
    })
    .await;

    // 4. Another device joins and leaves: the list hides it and shows names.
    let other = add_by_invite(&mut phone, &base).await;
    let other_id = other.keys().unwrap().id();
    let (_, rows) = local(&app, "GET", "/api/cloud/devices", None).await;
    assert!(rows.as_array().unwrap().iter().any(|d| d["device_id"] == other_id.as_str()), "{rows}");
    Cloud::new(reqwest::Client::new(), Endpoints::custom(&base, ACCOUNT_PAGES), other.keys().unwrap(), other.account_id.clone()).leave().await.unwrap();
    let (s, rows) = local(&app, "GET", "/api/cloud/devices", None).await;
    assert_eq!(s, StatusCode::OK, "{rows}");
    let rows = rows.as_array().unwrap();
    assert!(!rows.iter().any(|d| d["device_id"] == other_id.as_str()), "a device that left is not listed: {rows:?}");
    let name_of = |id: &str| rows.iter().find(|d| d["device_id"] == id).map(|d| d["name"].clone());
    assert_eq!(name_of(&phone_id), Some(json!("Hoang's iPhone")));
    assert_eq!(name_of(&host_id), Some(json!("Work Mac")));
    // A member writes no roster, so it is still listed there.
    let r = openagentd_cloud::roster::parse(&fake.account(&account).roster.unwrap()).unwrap();
    assert!(r.body.device(&other_id).is_some(), "only a device that approves drops it");

    // 5. Renaming through the route.
    let rename = |id: &str, name: Value| {
        let app = app.clone();
        let id = id.to_string();
        async move { local(&app, "POST", "/api/cloud/devices/name", Some(json!({ "device_id": id, "name": name }))).await }
    };
    let (s, v) = rename(&phone_id, json!("Mine now")).await;
    assert_eq!((s, v["detail"].as_str()), (StatusCode::FORBIDDEN, Some("Only a device that approves others can rename this device.")));
    assert_eq!(names_in_account(&phone).await[&phone_id].as_deref(), Some("Hoang's iPhone"), "nothing changed");
    let (s, _) = rename("not a device id", json!("x")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = call(&app, "POST", "/api/cloud/devices/name", Some(json!({ "device_id": host_id, "name": "x" })), "192.168.1.20:5000").await;
    assert_eq!(s, StatusCode::FORBIDDEN, "only this computer renames");
    let version = fake.account(&account).version;
    let (s, v) = rename(&host_id, json!("  Desk\n  Mac ")).await;
    assert_eq!((s, v.clone()), (StatusCode::OK, json!({ "device_id": host_id, "name": "Desk Mac" })));
    assert_eq!(fake.account(&account).version, version, "no roster was written");
    assert_eq!(server_name(&app).await, ("Desk Mac".to_string(), true), "the server name follows");
    assert_eq!(names_in_account(&phone).await[&host_id].as_deref(), Some("Desk Mac"));
    assert_eq!(stored_identity().name_synced.as_deref(), Some("Desk Mac"));
    // Clearing it gives the computer its host name back, here and then in the account.
    let (s, v) = rename(&host_id, Value::Null).await;
    assert_eq!((s, v), (StatusCode::OK, json!({ "device_id": host_id, "name": null })));
    assert_eq!(server_name(&app).await, (hostname.clone(), false));
    eventually("the host name in the account", || async {
        nudge(&fake, &account);
        (names_in_account(&phone).await[&host_id].as_deref() == Some(hostname.as_str())).then_some(())
    })
    .await;
    let (s, v) = rename(&host_id, json!(" ")).await;
    assert_eq!((s, v["name"].clone()), (StatusCode::OK, Value::Null), "an empty name clears it too");
    phone.cloud.leave().await.ok();
}
