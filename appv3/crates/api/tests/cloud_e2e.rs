//! The whole account story on a host, end to end, against the in-process
//! fake cloud of `native/cloud/tests/fake_cloud` (the same fake the
//! protocol crate's flow tests use):
//!
//! 1. a phone stand-in creates the account (genesis);
//! 2. this server signs in through `POST /api/cloud/login`, and the phone
//!    approves it after both sides show the same 6-digit code;
//! 3. the phone reaches the server's own router through the relay: the
//!    request arrives as a relayed device, with the credentials the phone
//!    sent removed, and may not touch the account routes;
//! 4. a notification the server raises arrives in the phone's mailbox as a
//!    sealed letter that only the phone can open;
//!    then the relay names the server as revoked, and closes its presence
//!    with 4001, while the signed roster still lists it: the server closes
//!    its sessions and keeps its keys (both signals are unsigned);
//! 5. the phone removes the server, which learns it from the relay, closes
//!    its sessions, confirms with a signed roster fetch (`device_revoked`)
//!    and erases its keys: back to guest, local data untouched;
//! 6. the server joins again by invitation link (`POST /api/cloud/join`, the
//!    desktop's way), added only once the phone picks it;
//! 7. another computer joins by link the way `agentd cloud join` does
//!    (`engine::join_invite`), and a relayed device cannot use the route.

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
use openagentd_cloud::flows::{self, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::letter::{self, Context, Kind};
use openagentd_cloud::relay::{self, Join};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

const FAST: Pace = Pace { every: Duration::from_millis(50), timeout: Duration::from_secs(20) };

async fn local(app: &axum::Router, method: &str, uri: &str) -> (StatusCode, Value) {
    local_with(app, method, uri, None).await
}

async fn local_with(app: &axum::Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let builder = Request::builder().method(method).uri(uri).header("host", "localhost:8000");
    let mut req = match body {
        Some(b) => builder.header("content-type", "application/json").body(Body::from(b.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let addr: SocketAddr = "127.0.0.1:8000".parse().unwrap();
    req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(addr), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn wait_for(app: &axum::Router, what: &str, ok: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..400 {
        let (_, v) = local(app, "GET", "/api/cloud/status").await;
        if ok(&v) {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

/// One HTTP exchange through the relay, as the phone's bridge sends it.
async fn relayed(tunnel: &relay::Tunnel, raw: &str) -> String {
    let mut s = tunnel.session.open().unwrap();
    s.write_all(raw.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut out)).await.expect("an answer").unwrap();
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn phone_and_server_through_the_account() {
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
    // Debug builds only: point this server at the fake cloud.
    std::env::set_var("OPENAGENTD_CLOUD_API", &base);
    std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");

    let pool = appv3_db::create_pool(&appv3_core::settings().database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    // A keyless server: it trusts loopback callers, so relayed requests
    // must never look like one.
    let app = create_app(AppState { pool }, Policy::from_env());
    appv3_api::cloud::install(app.clone(), 8000);
    let (_, v) = local(&app, "GET", "/api/cloud/status").await;
    assert_eq!(v["state"], "guest", "a fresh server is a guest");

    // 1. The phone creates the account.
    let account = fake.new_account();
    let mut phone = Member::new(Cloud::new(reqwest::Client::new(), Endpoints::custom(&base, "https://account.openagentd.dev"), DeviceKeys::generate(), None), None);
    phone.cloud.roles = Roles::CLIENT;
    let code = phone.cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&phone.cloud, &code).await.unwrap();
    assert!(matches!(flows::request_to_join(&mut phone, &session).await, Err(flows::FlowError::EmptyAccount)));
    flows::genesis(&mut phone, &session, GenesisDraft::new()).await.unwrap();

    // 2. The server signs in; the person approves its code in the browser.
    let (s, v) = local(&app, "POST", "/api/cloud/login").await;
    assert_eq!(s, StatusCode::OK);
    let v = if v["state"] == "signing_in" { v } else { wait_for(&app, "the user code", |v| v["state"] == "signing_in").await };
    let user_code = v["user_code"].as_str().unwrap().to_string();
    assert_eq!(v["url"], format!("https://account.openagentd.dev/device?code={user_code}"));
    fake.approve(&user_code, &account);
    wait_for(&app, "the join request", |v| v["state"] == "joining").await;
    let pending = loop {
        let list = phone.cloud.pending_list().await.unwrap();
        if let Some(p) = list.into_iter().next() {
            break p;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let mut approval = flows::begin_approval(&mut phone, pending).await.unwrap();
    let shown = flows::await_reveal(&mut phone, &mut approval, FAST).await.unwrap();
    let v = wait_for(&app, "the server's code", |v| v["code"].is_string()).await;
    assert_eq!(v["code"].as_str().unwrap(), shown.code, "both screens show the same 6-digit code");
    assert_eq!(v["fingerprint"].as_str().unwrap(), shown.fingerprint);
    assert_eq!(shown.roles, Roles::BOTH, "a computer asks to serve and to open sessions by default");
    flows::confirm_approval(&mut phone, approval, flows::Grant { signer: false, roles: Roles::BOTH }).await.unwrap();
    let v = wait_for(&app, "online", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!(v["signer"], false, "approved as a member");
    assert_eq!((v["server"].as_bool(), v["client"].as_bool()), (Some(true), Some(true)));
    let identity = temp.path().join("state").join("cloud").join("identity.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&identity).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let server_id = phone.roster.as_ref().unwrap().body.devices.iter().find(|d| !d.signer).unwrap().id.clone();

    // 3. The phone reaches the server through the relay.
    let host_box = phone.box_of(&server_id).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server_id, &host_box, Join::default()).await.unwrap();
    let out = relayed(
        &tunnel,
        "GET /api/cloud/status?_token=stolen HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer stolen\r\nX-Forwarded-For: 127.0.0.1\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.contains("\"state\":\"connected\""), "{out}");
    assert!(!out.to_ascii_lowercase().contains("content-encoding: gzip"), "nothing is compressed: {out}");
    let out = relayed(&tunnel, "POST /api/cloud/logout HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
    assert!(out.starts_with("HTTP/1.1 403"), "a relayed device cannot sign the server out: {out}");
    let out = relayed(&tunnel, "GET /api/health/live HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert!(out.starts_with("HTTP/1.1 400"), "{out}");
    let (_, v) = local(&app, "GET", "/api/cloud/status").await;
    assert_eq!(v["sessions"], 1, "one relay session is open");

    // 4. A notification on the server reaches the phone, sealed.
    let session_id = "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10";
    appv3_agent::broadcaster::publish(
        "desktop_notification",
        json!({"type": "desktop_notification", "notification_id": "n1", "kind": "assistant_done", "session_id": session_id, "title": "Done · api", "body": "Tests pass."}),
    );
    let got = loop {
        let letters = phone.cloud.letters().await.unwrap();
        if let Some(l) = letters.into_iter().next() {
            break l;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!((got.kind.as_str(), got.from.as_str()), ("done", server_id.as_str()));
    let sealed = openagentd_cloud::encoding::from_b64(&got.sealed).unwrap();
    assert!(letter::SIZES.contains(&sealed.len()));
    let me = phone.cloud.device_id();
    let ctx = Context { account_id: &account, sender_id: &server_id, recipient_id: &me, kind: Kind::Done };
    let text = letter::open(&phone.cloud.keys.r#box, &host_box, &ctx, &sealed).unwrap();
    assert_eq!((text.title.as_str(), text.body.as_str(), text.session.as_deref()), ("Done · api", "Tests pass.", Some(session_id)));
    // Another device's key cannot open it.
    let stranger = DeviceKeys::generate();
    assert!(letter::open(&stranger.r#box, &host_box, &ctx, &sealed).is_err());

    // 4b. Unsigned removal signals: the relay lists the server as revoked,
    // then closes its presence with 4001. The roster still lists it, so it
    // closes its sessions, keeps its keys and comes back online.
    let version = phone.roster.as_ref().unwrap().version();
    fake.notify_roster(version, vec![server_id.clone()]);
    let mut tunnel = tunnel;
    let code = tokio::time::timeout(Duration::from_secs(10), tunnel.wait_closed()).await.expect("sessions closed on the signal");
    assert_ne!(code, 4001, "the server does not tell the phone it was removed");
    assert!(identity.exists(), "a relay list alone erases nothing");
    wait_for(&app, "online after the check", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    fake.close_presence(4001);
    wait_for(&app, "offline after the close", |v| v["state"] == "connected" && v["relay"]["state"] == "offline").await;
    assert!(identity.exists(), "a 4001 close alone erases nothing");
    let v = wait_for(&app, "online after the close", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!(v["sessions"], 0);

    // 4c. Online means the presence socket opened, not a timer: while the
    // relay holds the upgrade the status stays connecting, then turns
    // online once the socket opens.
    fake.1.lock().unwrap().presence_delay = Some(Duration::from_secs(4));
    fake.close_presence(1001);
    wait_for(&app, "reconnecting", |v| v["state"] == "connected" && v["relay"]["state"] == "connecting").await;
    for _ in 0..30 {
        let (_, v) = local(&app, "GET", "/api/cloud/status").await;
        assert_ne!(v["relay"]["state"], "online", "not online before the socket opened");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    fake.1.lock().unwrap().presence_delay = None;
    wait_for(&app, "online once open", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server_id, &host_box, Join::default()).await.unwrap();
    let out = relayed(&tunnel, "GET /api/cloud/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
    assert!(out.contains("\"state\":\"connected\""), "{out}");

    // 5. The phone removes the server: it learns from the relay, closes its
    // sessions, confirms with a signed request, and erases its keys; local
    // data stays.
    phone.remove(&server_id).await.unwrap();
    let mut tunnel = tunnel;
    tokio::time::timeout(Duration::from_secs(10), tunnel.wait_closed()).await.expect("the session closed");
    let v = wait_for(&app, "guest again", |v| v["state"] == "guest").await;
    assert_eq!(v["notice"], "revoked");
    assert!(!identity.exists(), "the keys are erased");
    assert!(temp.path().join("state").exists(), "local data stays");
    // Signing out again is harmless.
    let (s, v) = local(&app, "POST", "/api/cloud/logout").await;
    assert_eq!((s, v["state"].as_str()), (StatusCode::OK, Some("guest")));

    // 6. The server joins again, by the invitation link the phone shows.
    let (s, _) = local_with(&app, "POST", "/api/cloud/join", Some(json!({ "link": "https://example.invalid/not-a-link" }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "only an invitation link is accepted");
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let (s, v) = local_with(&app, "POST", "/api/cloud/join", Some(json!({ "link": invite.link().as_str() }))).await;
    assert_eq!(s, StatusCode::OK);
    let v = if v["state"] == "invited" { v } else { wait_for(&app, "the claim", |v| v["state"] == "invited").await };
    let candidate = loop {
        if let flows::Candidates::One(c) = flows::check_candidates(&phone, &invite).await.unwrap() {
            break c;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    // Both screens show the same device.
    assert_eq!(v["fingerprint"].as_str().unwrap(), candidate.fingerprint);
    assert_eq!(v["kind"].as_str(), candidate.kind.as_deref());
    // Nothing is added until the person taps Add on the phone.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(local(&app, "GET", "/api/cloud/status").await.1["state"], "invited");
    flows::add_invited(&mut phone, invite, &candidate.enrollment_id, flows::Grant { signer: false, roles: Roles::BOTH }).await.unwrap();
    let v = wait_for(&app, "online again", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!(v["fingerprint"].as_str().unwrap(), candidate.fingerprint);
    assert!(identity.exists(), "the new keys are stored");
    let server_id = candidate_id(&phone, &candidate.fingerprint);
    let host_box = phone.box_of(&server_id).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server_id, &host_box, Join::default()).await.unwrap();
    let out = relayed(&tunnel, "GET /api/cloud/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
    assert!(out.contains("\"state\":\"connected\""), "the phone reaches it again: {out}");

    // 7. Another computer joins the way `agentd cloud join` does, and a
    // relayed device cannot make this server join anything.
    let body = r#"{"link":"agentd://invite?a=x"}"#;
    let raw = format!("POST /api/cloud/join HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let out = relayed(&tunnel, &raw).await;
    assert!(out.starts_with("HTTP/1.1 403"), "{out}");
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let link = invite.link();
    let cli = tokio::spawn({
        let base = base.clone();
        let link = link.to_string();
        async move {
            let mut fp = None;
            let r = appv3_api::cloud::engine::join_invite(Endpoints::custom(&base, "https://account.openagentd.dev"), reqwest::Client::new(), &link, Roles::BOTH, |e| {
                if let appv3_api::cloud::engine::Event::Invited { fingerprint, .. } = e {
                    fp = Some(fingerprint);
                }
            })
            .await;
            (r, fp)
        }
    });
    let candidate = loop {
        if let flows::Candidates::One(c) = flows::check_candidates(&phone, &invite).await.unwrap() {
            break c;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    flows::add_invited(&mut phone, invite, &candidate.enrollment_id, flows::Grant { signer: false, roles: Roles::BOTH }).await.unwrap();
    let (r, fp) = cli.await.unwrap();
    match r.unwrap() {
        appv3_api::cloud::engine::Outcome::Joined(id) => {
            assert_eq!(id.keys().unwrap().fingerprint(), candidate.fingerprint);
            assert_eq!(id.roster.as_deref(), phone.roster.as_ref().map(|r| r.blob.as_str()), "it holds the phone's roster");
        }
        _ => panic!("expected a join"),
    }
    assert_eq!(fp.as_deref(), Some(candidate.fingerprint.as_str()), "it showed the fingerprint the phone showed");
    assert_eq!(phone.roster.as_ref().unwrap().body.devices.len(), 3);
    phone.cloud.leave().await.ok();
}

/// The id of the roster device with this fingerprint.
fn candidate_id(phone: &Member, fingerprint: &str) -> String {
    phone.roster.as_ref().unwrap().body.devices.iter().find(|d| openagentd_cloud::keys::fingerprint(&d.id).as_deref() == Some(fingerprint)).unwrap().id.clone()
}
