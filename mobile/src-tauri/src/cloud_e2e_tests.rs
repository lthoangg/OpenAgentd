//! The phone's account story end to end, through the commands the web UI
//! calls, against the in-process fake cloud of
//! `native/cloud/tests/fake_cloud` and a stand-in computer:
//! sign in → recovery code (two groups typed back) → approve a computer
//! with the 6-digit code → reach it through the bridge and the relay →
//! remove it → sign out, back to guest with nothing left behind.
//! (Face ID itself needs a device; here the key store is the file store.)

#[path = "../../../native/cloud/tests/fake_cloud/mod.rs"]
mod fake_cloud;

use std::convert::Infallible;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, Member, Pace};
use openagentd_cloud::keys::DeviceKeys;
use openagentd_cloud::mux::Stream;
use openagentd_cloud::recovery;
use openagentd_cloud::relay::{self, HostHandler, Join, Sessions};
use openagentd_cloud::roster::Roster;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::cloud::{self, Status};

const FAST: Pace = Pace {
    every: Duration::from_millis(50),
    timeout: Duration::from_secs(20),
};

/// The phone's state is one per process (`cloud::init`): the tests that
/// use it take turns, on one data directory.
static SERIAL: Mutex<()> = Mutex::new(());
static DATA_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

/// Starts the phone once per process; whether this call started it.
fn init_phone() -> (&'static std::path::Path, bool) {
    let mut fresh = false;
    let dir = DATA_DIR.get_or_init(|| {
        fresh = true;
        let dir = tempfile::tempdir().unwrap();
        cloud::init(dir.path().to_path_buf());
        dir
    });
    (dir.path(), fresh)
}

/// A computer that answers every request with the headers it received.
struct Computer {
    roster: Mutex<Roster>,
    me: String,
}

impl HostHandler for Computer {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        if id == self.me {
            return None;
        }
        self.roster
            .lock()
            .unwrap()
            .body
            .client(id)
            .map(|d| d.box_key())
    }
    fn serve(&self, stream: Stream, _from: String) {
        tokio::spawn(async move {
            let svc =
                hyper::service::service_fn(|req: Request<hyper::body::Incoming>| async move {
                    let mut seen = format!("{} {}\n", req.method(), req.uri());
                    for (k, v) in req.headers() {
                        seen += &format!("{}: {}\n", k, v.to_str().unwrap_or(""));
                    }
                    Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(seen))))
                });
            let _ = hyper::server::conn::http1::Builder::new()
                .keep_alive(false)
                .serve_connection(TokioIo::new(stream), svc)
                .await;
        });
    }
    fn on_roster(&self, _: u64, _: Vec<String>) {}
}

async fn wait(what: &str, ok: impl Fn(&Status) -> bool) -> Status {
    for _ in 0..400 {
        let s = cloud::cloud_status();
        if ok(&s) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}: {:?}", cloud::cloud_status());
}

#[test]
fn phone_account_end_to_end() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        // Debug builds only: point the phone at the fake cloud.
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        let (dir, fresh) = init_phone();
        assert!(
            matches!(
                cloud::cloud_status(),
                Status::Guest {
                    notice,
                    supported: true,
                    ..
                } if notice.is_none() || !fresh
            ),
            "a guest by default"
        );
        let account = fake.new_account();

        // Sign in; the person approves the code in the browser.
        cloud::cloud_sign_in().unwrap();
        let Status::SigningIn { user_code, url, .. } =
            wait("the user code", |s| matches!(s, Status::SigningIn { .. })).await
        else {
            unreachable!()
        };
        assert_eq!(
            url,
            format!("https://account.openagentd.dev/device?code={user_code}")
        );
        fake.approve(&user_code, &account);

        // An empty account: this phone sets it up after the recovery code.
        let Status::Recovery {
            code,
            check: [a, b],
        } = wait("the recovery code", |s| {
            matches!(s, Status::Recovery { .. })
        })
        .await
        else {
            unreachable!()
        };
        let wrong = cloud::cloud_confirm_recovery("AAAA".into(), "BBBB".into()).await;
        assert!(wrong.is_err(), "wrong groups are refused");
        let s = cloud::cloud_confirm_recovery(
            recovery::group(&code, a).unwrap().into(),
            recovery::group(&code, b).unwrap().into(),
        )
        .await
        .unwrap();
        assert!(matches!(s, Status::Connected { signer: true, .. }), "{s:?}");
        assert!(dir.join("cloud").join("identity.json").exists());

        // A computer asks to join; the phone approves after comparing codes.
        let mut computer = Member::new(
            Cloud::new(
                reqwest::Client::new(),
                Endpoints::custom(&base, "https://account.openagentd.dev"),
                DeviceKeys::generate(),
                None,
            ),
            None,
        );
        computer.cloud.roles = openagentd_cloud::keys::Roles::BOTH;
        let dc = computer.cloud.device_code().await.unwrap();
        fake.approve(&dc.user_code, &account);
        let session = flows::wait_for_session(&computer.cloud, &dc).await.unwrap();
        let req = flows::request_to_join(&mut computer, &session)
            .await
            .unwrap();
        let pending = cloud::cloud_pending().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].fingerprint, computer.cloud.keys.fingerprint());
        assert!(
            pending[0].server && pending[0].client,
            "a computer asks for both roles"
        );
        let (phone_code, joined) = tokio::join!(
            cloud::cloud_approve_begin(pending[0].enrollment_id.clone()),
            flows::await_signer(&mut computer, &req, FAST)
        );
        let joined = joined.unwrap();
        let view = phone_code.unwrap();
        assert_eq!(view.code, joined.code, "both screens show the same code");
        assert!(view.server && view.client);
        // A role the computer did not ask for is refused before Face ID;
        // here it asked for both, so turning none on is the only check:
        // no role at all is refused too.
        let none = cloud::cloud_approve_confirm(
            pending[0].enrollment_id.clone(),
            Some(false),
            Some(false),
            Some(false),
        )
        .await;
        assert!(none.is_err(), "a device needs a role");
        let (confirmed, added) = tokio::join!(
            cloud::cloud_approve_confirm(pending[0].enrollment_id.clone(), Some(false), None, None),
            flows::await_added(&mut computer, joined, &req, FAST)
        );
        confirmed.unwrap();
        added.unwrap();
        let devices = cloud::cloud_devices().await.unwrap();
        assert_eq!(devices.len(), 2);
        let phone_row = devices.iter().find(|d| d.me).unwrap();
        assert!(
            phone_row.client && !phone_row.server,
            "the phone is a client only"
        );
        assert!(
            devices.iter().any(|d| d.me && d.signer) && devices.iter().any(|d| !d.me && !d.signer)
        );

        // The computer goes online; the phone opens it through the bridge.
        let host = Arc::new(Cloud::new(
            reqwest::Client::new(),
            computer.cloud.endpoints.clone(),
            computer.cloud.keys.clone(),
            computer.cloud.account_id.clone(),
        ));
        let handler = Arc::new(Computer {
            roster: Mutex::new(computer.roster.clone().unwrap()),
            me: computer.cloud.device_id(),
        });
        let sessions = Sessions::default();
        let (_stop, stop_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(relay::host(
            host,
            relay::http1_client(),
            handler,
            sessions.clone(),
            Join::default(),
            stop_rx,
        ));
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Opened twice at once (a tapped notification and the launch's
        // account fallback): one bridge, one relay session, and the origin
        // either caller got keeps working.
        let computer_id = computer.cloud.device_id();
        let (first, second) = tokio::join!(
            cloud::open_bridge(&computer_id),
            cloud::open_bridge(&computer_id)
        );
        let origin = first.unwrap();
        assert_eq!(second.unwrap(), origin, "one bridge per computer");
        let key = cloud::bridge_key(&origin).expect("the web UI gets the bridge key");
        let mut tcp = tokio::net::TcpStream::connect(origin.trim_start_matches("http://"))
            .await
            .unwrap();
        tcp.write_all(format!("GET /api/health?_token={key} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: tauri://localhost\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), tcp.read_to_end(&mut out))
            .await
            .unwrap()
            .unwrap();
        let out = String::from_utf8_lossy(&out);
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(
            out.contains("GET /api/health\n") && out.contains("host: localhost\n"),
            "{out}"
        );
        assert!(
            !out.contains(&key),
            "the bridge key never reaches the computer: {out}"
        );
        assert_eq!(sessions.count(), 1);

        // The computer closes the phone's session with 4001. That is
        // unsigned: the phone closes its links, asks with a signed roster
        // fetch, and stays signed in with its keys.
        let me = cloud::cloud_devices()
            .await
            .unwrap()
            .into_iter()
            .find(|d| d.me)
            .unwrap()
            .device_id;
        sessions.revoke(&me);
        let said = cloud::on_problem(AccountProblem::RemovalSignal).await;
        assert!(said.contains("cannot be reached"), "{said}");
        assert!(
            matches!(
                cloud::cloud_status(),
                Status::Connected { signer: true, .. }
            ),
            "{:?}",
            cloud::cloud_status()
        );
        assert!(dir.join("cloud").join("identity.json").exists());
        assert!(cloud::bridge_key(&origin).is_none(), "its links are closed");

        // Remove the computer: its session ends and the bridge goes away.
        cloud::cloud_remove_device(computer.cloud.device_id())
            .await
            .unwrap();
        assert!(cloud::bridge_key(&origin).is_none());
        assert_eq!(cloud::cloud_devices().await.unwrap().len(), 1);

        // Sign out: guest again, keys erased.
        let s = cloud::cloud_sign_out().await.unwrap();
        assert!(
            matches!(
                s,
                Status::Guest {
                    notice: Some(cloud::Notice::SignedOut),
                    ..
                }
            ),
            "{s:?}"
        );
        assert!(!dir.join("cloud").join("identity.json").exists());
    });
}

/// Signs the phone in to a new account of `fake` and adds a computer to
/// it; the computer's member.
async fn signed_in_with_a_computer(fake: &fake_cloud::Fake, base: &str) -> Member {
    let account = fake.new_account();
    cloud::cloud_sign_in().unwrap();
    let Status::SigningIn { user_code, .. } =
        wait("the user code", |s| matches!(s, Status::SigningIn { .. })).await
    else {
        unreachable!()
    };
    fake.approve(&user_code, &account);
    let Status::Recovery {
        code,
        check: [a, b],
    } = wait("the recovery code", |s| {
        matches!(s, Status::Recovery { .. })
    })
    .await
    else {
        unreachable!()
    };
    cloud::cloud_confirm_recovery(
        recovery::group(&code, a).unwrap().into(),
        recovery::group(&code, b).unwrap().into(),
    )
    .await
    .unwrap();
    let mut computer = Member::new(
        Cloud::new(
            reqwest::Client::new(),
            Endpoints::custom(base, "https://account.openagentd.dev"),
            DeviceKeys::generate(),
            None,
        ),
        None,
    );
    computer.cloud.roles = openagentd_cloud::keys::Roles::BOTH;
    let dc = computer.cloud.device_code().await.unwrap();
    fake.approve(&dc.user_code, &account);
    let session = flows::wait_for_session(&computer.cloud, &dc).await.unwrap();
    let req = flows::request_to_join(&mut computer, &session)
        .await
        .unwrap();
    let pending = cloud::cloud_pending().await.unwrap();
    let (_, joined) = tokio::join!(
        cloud::cloud_approve_begin(pending[0].enrollment_id.clone()),
        flows::await_signer(&mut computer, &req, FAST)
    );
    let joined = joined.unwrap();
    let (confirmed, added) = tokio::join!(
        cloud::cloud_approve_confirm(pending[0].enrollment_id.clone(), Some(false), None, None),
        flows::await_added(&mut computer, joined, &req, FAST)
    );
    confirmed.unwrap();
    added.unwrap();
    computer
}

/// Puts the computer online (its presence socket); drop or fire the
/// sender to take it offline.
async fn computer_online(computer: &Member) -> tokio::sync::oneshot::Sender<()> {
    let host = Arc::new(Cloud::new(
        reqwest::Client::new(),
        computer.cloud.endpoints.clone(),
        computer.cloud.keys.clone(),
        computer.cloud.account_id.clone(),
    ));
    let handler = Arc::new(Computer {
        roster: Mutex::new(computer.roster.clone().unwrap()),
        me: computer.cloud.device_id(),
    });
    let (stop, stop_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(relay::host(
        host,
        relay::http1_client(),
        handler,
        Sessions::default(),
        Join::default(),
        stop_rx,
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop
}

/// The phone's relay socket to the computer ends (the relay closes it).
fn session_lost(fake: &fake_cloud::Fake) {
    let to_phone = fake.1.lock().unwrap().to_controller.last().unwrap().clone();
    let _ = to_phone.send(axum::extract::ws::Message::Close(Some(
        axum::extract::ws::CloseFrame {
            code: 1011,
            reason: "".into(),
        },
    )));
}

/// What the page sends through a bridge: the status line it gets back, or
/// `None` without an answer.
async fn page_request(origin: &str, key: &str) -> Option<String> {
    let exchange = async {
        let mut tcp = tokio::net::TcpStream::connect(origin.trim_start_matches("http://"))
            .await
            .ok()?;
        tcp.write_all(format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: tauri://localhost\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n").as_bytes())
            .await
            .ok()?;
        let mut out = Vec::new();
        tcp.read_to_end(&mut out).await.ok()?;
        String::from_utf8_lossy(&out)
            .lines()
            .next()
            .map(str::to_string)
    };
    tokio::time::timeout(Duration::from_secs(10), exchange)
        .await
        .ok()
        .flatten()
}

async fn link_state(
    link: &openagentd_cloud::link::Link,
    what: &str,
    ok: impl Fn(&openagentd_cloud::link::LinkState) -> bool,
) {
    let mut rx = link.state();
    if tokio::time::timeout(Duration::from_secs(10), rx.wait_for(|s| ok(s)))
        .await
        .is_err()
    {
        panic!("timed out waiting for {what}: {:?}", *link.state().borrow());
    }
}

/// Faults 2 and 4 of the 3.53.1 brief: an open that fails must not close
/// the bridge the page is on, a bridge started again keeps its origin and
/// key, and an open ends a link's background mode.
#[test]
fn the_page_keeps_its_bridge_and_key_through_failed_opens_restarts_and_the_background() {
    use openagentd_cloud::link::{DownReason, LinkState, Poke};
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        init_phone();
        let computer = signed_in_with_a_computer(&fake, &base).await;
        let id = computer.cloud.device_id();
        let stop = computer_online(&computer).await;

        let origin = cloud::open_bridge(&id).await.unwrap();
        let key = cloud::bridge_key(&origin).expect("the page's key");
        assert_eq!(
            page_request(&origin, &key).await.as_deref(),
            Some("HTTP/1.1 200 OK")
        );
        let (_, link) = cloud::start_bridge(&id).await.unwrap();

        // The computer goes offline and the session ends: an open fails,
        // and the bridge the page is on stays, with its key.
        let _ = stop.send(());
        session_lost(&fake);
        link_state(&link, "host offline", |s| {
            matches!(
                s,
                LinkState::Down {
                    reason: DownReason::HostOffline,
                    ..
                }
            )
        })
        .await;
        assert!(
            cloud::open_bridge(&id).await.is_err(),
            "the computer is offline"
        );
        assert_eq!(
            cloud::bridge_key(&origin).as_deref(),
            Some(key.as_str()),
            "a failed open leaves the bridge in use alone"
        );
        // Back online: the next open succeeds on the same origin and key.
        let stop = computer_online(&computer).await;
        assert_eq!(cloud::open_bridge(&id).await.unwrap(), origin);
        assert_eq!(cloud::bridge_key(&origin).as_deref(), Some(key.as_str()));
        assert_eq!(
            page_request(&origin, &key).await.as_deref(),
            Some("HTTP/1.1 200 OK")
        );

        // Closed and started again in the same run: same origin, same key.
        cloud::drop_bridge(&id).await;
        assert_eq!(cloud::open_bridge(&id).await.unwrap(), origin);
        assert_eq!(cloud::bridge_key(&origin).as_deref(), Some(key.as_str()));
        assert_eq!(
            page_request(&origin, &key).await.as_deref(),
            Some("HTTP/1.1 200 OK")
        );

        // The page reloaded (its last word was "background") and the
        // session ended: an open brings the link up again, on the same
        // bridge and key.
        let (_, link) = cloud::start_bridge(&id).await.unwrap();
        link.poke(Poke::Background);
        session_lost(&fake);
        link_state(&link, "down in the background", |s| {
            matches!(s, LinkState::Down { retry_at: None, .. })
        })
        .await;
        assert_eq!(cloud::open_bridge(&id).await.unwrap(), origin);
        assert_eq!(cloud::bridge_key(&origin).as_deref(), Some(key.as_str()));
        assert_eq!(
            page_request(&origin, &key).await.as_deref(),
            Some("HTTP/1.1 200 OK")
        );

        // The app goes away: the bridge stops listening, and a request is
        // refused at once. Back in front, it answers on the same origin
        // with the same key.
        cloud::cloud_poke("background".into()).await.unwrap();
        assert_eq!(page_request(&origin, &key).await, None);
        let moved = cloud::cloud_poke("resumed".into()).await.unwrap();
        assert!(moved.is_empty(), "{moved:?}");
        assert_eq!(cloud::bridge_key(&origin).as_deref(), Some(key.as_str()));
        assert_eq!(
            page_request(&origin, &key).await.as_deref(),
            Some("HTTP/1.1 200 OK")
        );

        drop(stop);
        cloud::cloud_sign_out().await.unwrap();
    });
}
