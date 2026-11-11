//! This server opening another computer of its account, end to end,
//! against the in-process fake cloud of `native/cloud/tests/fake_cloud`:
//! the desktop app's "Your computers" → Use.
//!
//! One process holds one server's account, so the host is a stand-in (the
//! protocol crate's relay host with a tiny HTTP answer) and this server is
//! the controller:
//!
//! 1. a phone creates the account, a host joins it as a server, and this
//!    server signs in (both roles, the desktop's default);
//! 2. the host is offline: opening it fails at once with the phone's words;
//! 3. the host comes online: the device list says so, opening it gives a
//!    loopback bridge, and a request through the bridge reaches the host
//!    with the bridge key removed;
//! 4. a device that is not a server is not opened, the bridge refuses a
//!    request without its key, and a relayed device cannot open anything
//!    through this server;
//! 5. closing the computer ends its bridge.

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
use openagentd_cloud::flows::{self, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::mux::Stream;
use openagentd_cloud::relay::{self, HostHandler, HostOptions, Join, Sessions};
use openagentd_cloud::roster::Roster;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

const FAST: Pace = Pace { every: Duration::from_millis(50), timeout: Duration::from_secs(20) };
const ACCOUNT_SITE: &str = "https://account.openagentd.dev";

async fn local(app: &axum::Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
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
        let (_, v) = local(app, "GET", "/api/cloud/status", None).await;
        if ok(&v) {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

fn cloud(base: &str, keys: DeviceKeys, account: Option<String>) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, ACCOUNT_SITE), keys, account)
}

/// The host stand-in: answers every request with what it received.
struct Host {
    roster: Mutex<Roster>,
    me: String,
}

impl HostHandler for Host {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        (id != self.me).then(|| self.roster.lock().unwrap().body.client(id).map(|d| d.box_key())).flatten()
    }
    fn serve(&self, mut stream: Stream, _from: String) {
        tokio::spawn(async move {
            let mut got = Vec::new();
            let mut buf = [0u8; 1024];
            while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => got.extend_from_slice(&buf[..n]),
                }
            }
            let body = format!("from the host\n{}", String::from_utf8_lossy(&got));
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(reply.as_bytes()).await;
            let _ = stream.shutdown().await;
        });
    }
    fn on_roster(&self, _: u64, _: Vec<String>) {}
}

async fn raw(origin: &str, request: String) -> String {
    let addr = origin.trim_start_matches("http://");
    let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    tcp.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), tcp.read_to_end(&mut out)).await.expect("an answer").unwrap();
    String::from_utf8_lossy(&out).into_owned()
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
async fn this_server_opens_another_computer_of_its_account() {
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
    std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", ACCOUNT_SITE);
    let pool = appv3_db::create_pool(&appv3_core::settings().database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    let app = create_app(AppState { pool }, Policy::from_env());
    appv3_api::cloud::install(app.clone(), 8000);

    // 1. The phone creates the account.
    let account = fake.new_account();
    let mut phone = Member::new(cloud(&base, DeviceKeys::generate(), None), None);
    phone.cloud.roles = Roles::CLIENT;
    let code = phone.cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&phone.cloud, &code).await.unwrap();
    assert!(matches!(flows::request_to_join(&mut phone, &session).await, Err(flows::FlowError::EmptyAccount)));
    flows::genesis(&mut phone, &session, GenesisDraft::new()).await.unwrap();

    // The host joins as a server.
    let mut host = Member::new(cloud(&base, DeviceKeys::generate(), None), None);
    host.cloud.roles = Roles::SERVER;
    let code = host.cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let s = flows::wait_for_session(&host.cloud, &code).await.unwrap();
    let req = flows::request_to_join(&mut host, &s).await.unwrap();
    let p = phone.cloud.pending_list().await.unwrap().remove(0);
    let mut a = flows::begin_approval(&mut phone, p).await.unwrap();
    let jc = flows::await_signer(&mut host, &req, FAST).await.unwrap();
    flows::await_reveal(&mut phone, &mut a, FAST).await.unwrap();
    let (r1, r2) = tokio::join!(flows::confirm_approval(&mut phone, a, flows::Grant { signer: false, roles: Roles::SERVER }), flows::await_added(&mut host, jc, &req, FAST));
    r1.unwrap();
    r2.unwrap();
    let host_id = host.cloud.device_id();

    // This server signs in with both roles; the phone approves it.
    let (s, v) = local(&app, "POST", "/api/cloud/login", None).await;
    assert_eq!(s, StatusCode::OK);
    let v = if v["state"] == "signing_in" { v } else { wait_for(&app, "the user code", |v| v["state"] == "signing_in").await };
    fake.approve(v["user_code"].as_str().unwrap(), &account);
    wait_for(&app, "the join request", |v| v["state"] == "joining").await;
    let pending = loop {
        if let Some(p) = phone.cloud.pending_list().await.unwrap().into_iter().next() {
            break p;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let mut approval = flows::begin_approval(&mut phone, pending).await.unwrap();
    flows::await_reveal(&mut phone, &mut approval, FAST).await.unwrap();
    wait_for(&app, "the code", |v| v["code"].is_string()).await;
    flows::confirm_approval(&mut phone, approval, flows::Grant { signer: false, roles: Roles::BOTH }).await.unwrap();
    let v = wait_for(&app, "online", |v| v["state"] == "connected" && v["relay"]["state"] == "online").await;
    assert_eq!(v["client"], true, "a desktop signs in to open other computers too");

    // 2. The host is offline: opening it fails at once, in the phone's words.
    let (s, v) = local(&app, "POST", "/api/cloud/open", Some(json!({ "device_id": host_id }))).await;
    assert_eq!(s, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["detail"], "This computer is offline, or not signed in to your account.", "{v}");

    // 3. The host comes online (it learns this server from its roster).
    host.sync().await.unwrap();
    let handler = Arc::new(Host { roster: Mutex::new(host.roster.clone().unwrap()), me: host_id.clone() });
    let (_stop, stop_rx) = tokio::sync::oneshot::channel();
    let (opened_tx, mut opened) = tokio::sync::watch::channel(false);
    let host_cloud = Arc::new(cloud(&base, host.cloud.keys.clone(), host.cloud.account_id.clone()));
    tokio::spawn(relay::host_with(host_cloud, relay::http1_client(), handler, Sessions::default(), stop_rx, HostOptions { opened: Some(opened_tx), ..HostOptions::default() }));
    tokio::time::timeout(Duration::from_secs(10), opened.wait_for(|o| *o)).await.expect("presence opened").unwrap();

    let (s, devices) = local(&app, "GET", "/api/cloud/devices", None).await;
    assert_eq!(s, StatusCode::OK, "{devices}");
    let row = |id: &str| devices.as_array().unwrap().iter().find(|d| d["device_id"] == id).cloned().unwrap();
    assert_eq!((row(&host_id)["server"].as_bool(), row(&host_id)["online"].as_bool()), (Some(true), Some(true)), "{devices}");
    let phone_id = phone.cloud.device_id();
    assert!(row(&phone_id)["online"].is_null(), "only a server has a dot: {devices}");
    assert_eq!(devices.as_array().unwrap().iter().filter(|d| d["me"] == true).count(), 1);

    let (s, opened) = local(&app, "POST", "/api/cloud/open", Some(json!({ "device_id": host_id }))).await;
    assert_eq!(s, StatusCode::OK, "{opened}");
    let origin = opened["origin"].as_str().unwrap().to_string();
    let key = opened["key"].as_str().unwrap().to_string();
    assert!(origin.starts_with("http://127.0.0.1:"), "{origin}");
    assert_eq!(opened["device"]["fingerprint"].as_str(), openagentd_cloud::keys::fingerprint(&host_id).as_deref());
    let out =
        raw(&origin, format!("GET /api/health?_token={key} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: tauri://localhost\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n"))
            .await;
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.contains("from the host\nGET /api/health HTTP/1.1"), "{out}");
    assert!(!out.contains(&key), "the bridge key reached the host: {out}");
    assert!(out.to_ascii_lowercase().contains("access-control-allow-origin: tauri://localhost"), "{out}");
    // Opening it again reuses the bridge.
    let (_, again) = local(&app, "POST", "/api/cloud/open", Some(json!({ "device_id": host_id }))).await;
    assert_eq!(again["origin"].as_str(), Some(origin.as_str()));

    // 4. Not a server: not opened. No key: refused. A relayed device: no hop.
    let (s, v) = local(&app, "POST", "/api/cloud/open", Some(json!({ "device_id": phone_id }))).await;
    assert_eq!((s, v["detail"].as_str()), (StatusCode::CONFLICT, Some("This computer is not in your account.")));
    let out = raw(&origin, "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".into()).await;
    assert!(out.starts_with("HTTP/1.1 401"), "{out}");
    let out =
        raw(&origin, format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://attacker.example\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n")).await;
    assert!(out.starts_with("HTTP/1.1 403"), "{out}");
    let me = devices.as_array().unwrap().iter().find(|d| d["me"] == true).unwrap()["device_id"].as_str().unwrap().to_string();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &me, &phone.box_of(&me).unwrap(), Join::default()).await.unwrap();
    let body = json!({ "device_id": host_id }).to_string();
    let req = format!("POST /api/cloud/open HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let out = relayed(&tunnel, &req).await;
    assert!(out.starts_with("HTTP/1.1 403"), "a relayed device cannot open another computer: {out}");

    // 5. Closing it ends the bridge.
    let (s, _) = local(&app, "POST", "/api/cloud/close", Some(json!({ "device_id": host_id }))).await;
    assert_eq!(s, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(tokio::net::TcpStream::connect(origin.trim_start_matches("http://")).await.is_err(), "the bridge stopped listening");
    phone.cloud.leave().await.ok();
}
