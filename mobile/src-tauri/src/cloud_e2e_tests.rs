// size-ceiling: 1144 — a test module: split it by journey
//! The phone's account story end to end, through the commands the web UI
//! calls, against the in-process fake cloud of
//! `native/cloud/tests/fake_cloud` and a stand-in computer:
//! sign in → recovery code (two groups typed back) → approve a computer
//! with the 6-digit code → reach it through the bridge and the relay →
//! remove it → sign out, back to guest with nothing left behind.
//! (Face ID itself needs a device; here the key store is the file store.)

#[path = "../../../native/cloud/tests/fake_cloud/mod.rs"]
pub(crate) mod fake_cloud;

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
pub(crate) static SERIAL: Mutex<()> = Mutex::new(());
static DATA_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

/// Starts the phone once per process; whether this call started it.
pub(crate) fn init_phone() -> (&'static std::path::Path, bool) {
    let mut fresh = false;
    let dir = DATA_DIR.get_or_init(|| {
        fresh = true;
        let dir = tempfile::tempdir().unwrap();
        cloud::init(dir.path().to_path_buf());
        dir
    });
    (dir.path(), fresh)
}

/// A computer that answers every request with the headers it received,
/// and a rename (`PUT /api/server/name`) with the name it now has.
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
                    if req.method() == hyper::Method::PUT && req.uri().path() == "/api/server/name" {
                        let body = r#"{"name":"Build box","default":"box","custom":true}"#;
                        return Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(body))));
                    }
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
        let s = cloud::cloud_status().await;
        if ok(&s) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}: {:?}", cloud::cloud_status().await);
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
                cloud::cloud_status().await,
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
        // Face ID cancelled: nothing is added, and the same approval can
        // be confirmed again.
        cloud::CANCEL_NEXT_UNLOCK.store(true, std::sync::atomic::Ordering::SeqCst);
        let cancelled = cloud::cloud_approve_confirm(
            pending[0].enrollment_id.clone(),
            Some(false),
            None,
            None,
        )
        .await;
        assert_eq!(cancelled.unwrap_err(), "Cancelled.");
        assert_eq!(cloud::cloud_devices().await.unwrap().len(), 1, "nothing added");
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

        // Renamed from the phone through the same link: the open bridge,
        // which the page is on, stays open afterwards.
        let renamed = cloud::rename_computer(&computer_id, "Build box").await.unwrap();
        assert_eq!(renamed["name"], "Build box");
        assert_eq!(cloud::bridge_key(&origin).as_deref(), Some(key.as_str()), "a bridge in use stays open");

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
                cloud::cloud_status().await,
                Status::Connected { signer: true, .. }
            ),
            "{:?}",
            cloud::cloud_status().await
        );
        assert!(dir.join("cloud").join("identity.json").exists());
        assert!(cloud::bridge_key(&origin).is_none(), "its links are closed");

        // Remove the computer: its session ends and the bridge goes away.
        // Face ID cancelled first: the computer stays in the account.
        cloud::CANCEL_NEXT_UNLOCK.store(true, std::sync::atomic::Ordering::SeqCst);
        let cancelled = cloud::cloud_remove_device(computer.cloud.device_id()).await;
        assert_eq!(cancelled.unwrap_err(), "Cancelled.");
        assert_eq!(cloud::cloud_devices().await.unwrap().len(), 2, "nothing removed");
        cloud::cloud_remove_device(computer.cloud.device_id())
            .await
            .unwrap();
        assert!(cloud::bridge_key(&origin).is_none());
        assert_eq!(cloud::cloud_devices().await.unwrap().len(), 1);

        // A computer shows a QR code: the phone scans it without a browser
        // approval on the computer, adds it, and shows the same number.
        let mut scanned = Member::new(
            Cloud::new(
                reqwest::Client::new(),
                Endpoints::custom(&base, "https://account.openagentd.dev"),
                DeviceKeys::generate(),
                None,
            ),
            None,
        );
        let code = scanned.cloud.device_code().await.unwrap();
        let scan = flows::scan_code(&scanned.cloud, &code);
        cloud::cloud_add_scanned(scan.link().to_string())
            .await
            .unwrap();
        let flows::SignIn::Offered(offer) = flows::wait_for_sign_in(&scanned.cloud, &code)
            .await
            .unwrap()
        else {
            panic!("offered")
        };
        let claim = flows::claim_offer(&mut scanned, &scan, offer)
            .await
            .unwrap();
        let cloud::InvitePoll::Candidate { candidate } = cloud::cloud_invite_poll().await.unwrap()
        else {
            panic!("candidate")
        };
        // Face ID cancelled on Add: the invitation stays open to retry.
        cloud::CANCEL_NEXT_UNLOCK.store(true, std::sync::atomic::Ordering::SeqCst);
        let cancelled = cloud::cloud_invite_add(
            candidate.enrollment_id.clone(),
            Some(false),
            Some(true),
            Some(true),
        )
        .await
        .map(|_| ());
        assert_eq!(cancelled.unwrap_err(), "Cancelled.");
        let added =
            cloud::cloud_invite_add(candidate.enrollment_id, Some(false), Some(true), Some(true))
                .await
                .unwrap();
        let joined = flows::await_scanned(&mut scanned, claim, FAST)
            .await
            .unwrap();
        assert_eq!(added.number.as_deref(), Some(joined.number.as_str()));
        assert!(cloud::cloud_devices()
            .await
            .unwrap()
            .iter()
            .any(|d| d.device_id == scanned.cloud.device_id()));

        // Cancel while the offer is still in flight: its late answer may
        // not leave an invitation open after the sheet is gone.
        let late = Member::new(
            Cloud::new(reqwest::Client::new(), Endpoints::custom(&base, "https://account.openagentd.dev"), DeviceKeys::generate(), None),
            None,
        );
        let code = late.cloud.device_code().await.unwrap();
        let scan = flows::scan_code(&late.cloud, &code);
        let seen = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let before = fake.0.lock().unwrap().invites.len();
        fake.0.lock().unwrap().offer_barrier = Some((seen.clone(), release.clone()));
        let offering = tauri::async_runtime::spawn(cloud::cloud_add_scanned(scan.link().to_string()));
        seen.notified().await;
        cloud::cloud_invite_cancel(None).await.unwrap();
        release.notify_one();
        assert!(offering.await.unwrap().is_err(), "the cancelled offer cannot open an invitation");
        assert_eq!(fake.0.lock().unwrap().invites.len(), before);
        assert_eq!(cloud::cloud_invite_poll().await.unwrap(), cloud::InvitePoll::Ended);
        fake.0.lock().unwrap().offer_barrier = None;

        // If IPC processes Cancel before it starts the offer, the sheet
        // cancels the returned generation. A stale sheet cannot cancel it.
        cloud::cloud_invite_cancel(None).await.unwrap();
        let code = late.cloud.device_code().await.unwrap();
        let scan = flows::scan_code(&late.cloud, &code);
        let generation = cloud::cloud_add_scanned(scan.link().to_string()).await.unwrap();
        cloud::cloud_invite_cancel(Some(generation - 1)).await.unwrap();
        assert_eq!(cloud::cloud_invite_poll().await.unwrap(), cloud::InvitePoll::Waiting);
        cloud::cloud_invite_cancel(Some(generation)).await.unwrap();
        assert_eq!(cloud::cloud_invite_poll().await.unwrap(), cloud::InvitePoll::Ended);

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
pub(crate) async fn signed_in_with_a_computer(fake: &fake_cloud::Fake, base: &str) -> Member {
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

        // What "Copy diagnostics" shows: the return, the bridge's check
        // and reopening, named by fingerprint; never the key or the id.
        let lines: Vec<String> = cloud::cloud_diagnostics()
            .into_iter()
            .map(|l| l.text)
            .collect();
        let fp = computer.cloud.keys.fingerprint();
        assert!(lines.iter().any(|l| l == "app back"), "{lines:#?}");
        assert!(
            lines
                .iter()
                .any(|l| *l == format!("bridge {fp}: reopened on the same address")),
            "{lines:#?}"
        );
        let all = lines.join("\n");
        assert!(!all.contains(&key) && !all.contains(&id), "{all}");

        drop(stop);
        cloud::cloud_sign_out().await.unwrap();
    });
}

/// A device of its own (not the phone), not in any account yet.
fn another_device(base: &str) -> Member {
    let mut m = Member::new(
        Cloud::new(
            reqwest::Client::new(),
            Endpoints::custom(base, "https://account.openagentd.dev"),
            DeviceKeys::generate(),
            None,
        ),
        None,
    );
    m.cloud.roles = openagentd_cloud::keys::Roles::BOTH;
    m
}

/// `member` creates `account` (its first roster) and answers the recovery
/// code it showed.
async fn account_created_by(fake: &fake_cloud::Fake, member: &mut Member, account: &str) -> String {
    let dc = member.cloud.device_code().await.unwrap();
    fake.approve(&dc.user_code, account);
    let session = flows::wait_for_session(&member.cloud, &dc).await.unwrap();
    let draft = flows::GenesisDraft::new();
    let code = draft.code.to_string();
    flows::genesis(member, &session, draft).await.unwrap();
    code
}

#[test]
fn a_device_that_left_is_no_longer_listed() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        init_phone();
        let computer = signed_in_with_a_computer(&fake, &base).await;
        let computer_id = computer.cloud.device_id();
        let rows = cloud::cloud_devices().await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|d| d.device_id == computer_id));

        // The computer leaves: the cloud still lists it as departed, the
        // roster still names it, and the phone shows only itself.
        computer.cloud.leave().await.unwrap();
        let rows = cloud::cloud_devices().await.unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert!(rows[0].me);
        assert!(
            matches!(
                cloud::cloud_status().await,
                Status::Connected { signer: true, .. }
            ),
            "listing never asks Face ID or changes the account: {:?}",
            cloud::cloud_status().await
        );

        cloud::cloud_sign_out().await.unwrap();
    });
}

#[test]
fn a_device_is_renamed_by_itself_or_by_the_phone_that_approves() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        init_phone();
        let computer = signed_in_with_a_computer(&fake, &base).await;
        let computer_id = computer.cloud.device_id();
        let rows = cloud::cloud_devices().await.unwrap();
        assert!(rows.iter().all(|d| d.name.is_none()), "unnamed at first");
        let me = rows.iter().find(|d| d.me).unwrap().device_id.clone();
        let name_of = |rows: &[cloud::DeviceRow], id: &str| {
            rows.iter()
                .find(|d| d.device_id == id)
                .unwrap()
                .name
                .clone()
        };

        // The phone names itself (no Face ID: the unlock is cancelled
        // here, and the rename still goes through) and the computer.
        cloud::CANCEL_NEXT_UNLOCK.store(true, std::sync::atomic::Ordering::SeqCst);
        let answer = cloud::cloud_rename_device(me.clone(), Some("  Hoang's \n iPhone ".into()))
            .await
            .unwrap();
        cloud::CANCEL_NEXT_UNLOCK.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            answer,
            serde_json::json!({ "device_id": me, "name": "Hoang's iPhone" })
        );
        let answer = cloud::cloud_rename_device(computer_id.clone(), Some("Studio".into()))
            .await
            .unwrap();
        assert_eq!(answer["name"], "Studio");
        let rows = cloud::cloud_devices().await.unwrap();
        assert_eq!(name_of(&rows, &me).as_deref(), Some("Hoang's iPhone"));
        assert_eq!(name_of(&rows, &computer_id).as_deref(), Some("Studio"));

        // An empty name clears it (null), and the answer says so.
        let answer = cloud::cloud_rename_device(computer_id.clone(), Some("   ".into()))
            .await
            .unwrap();
        assert_eq!(
            answer,
            serde_json::json!({ "device_id": computer_id, "name": null })
        );
        let answer = cloud::cloud_rename_device(computer_id.clone(), None)
            .await
            .unwrap();
        assert_eq!(answer["name"], serde_json::Value::Null);
        let rows = cloud::cloud_devices().await.unwrap();
        assert_eq!(name_of(&rows, &computer_id), None);

        // A device the account does not have, said plainly.
        let stranger = DeviceKeys::generate().id();
        let refused = cloud::cloud_rename_device(stranger, Some("Ghost".into())).await;
        assert_eq!(
            refused.unwrap_err(),
            "That device is no longer in your account."
        );

        cloud::cloud_sign_out().await.unwrap();
    });
}

#[test]
fn the_recovery_code_takes_the_account_over_on_the_phone() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        let (dir, _) = init_phone();
        let account = fake.new_account();
        let mut lost = another_device(&base);
        let code = account_created_by(&fake, &mut lost, &account).await;

        // Not a recovery code at all: nothing starts.
        let bad = cloud::cloud_recover("ABCD".into());
        assert_eq!(
            bad.unwrap_err(),
            "That is not a recovery code. Check it and type it again."
        );
        assert!(matches!(cloud::cloud_status().await, Status::Guest { .. }));

        cloud::cloud_recover(code).unwrap();
        let Status::SigningIn {
            user_code,
            recovering,
            ..
        } = wait("the user code", |s| matches!(s, Status::SigningIn { .. })).await
        else {
            unreachable!()
        };
        assert!(recovering, "the sign-in says it recovers");
        fake.approve(&user_code, &account);
        let s = wait("connected", |s| matches!(s, Status::Connected { .. })).await;
        assert!(
            matches!(
                s,
                Status::Connected {
                    signer: true,
                    recovered: true,
                    ..
                }
            ),
            "{s:?}"
        );
        assert!(dir.join("cloud").join("identity.json").exists());
        let rows = cloud::cloud_devices().await.unwrap();
        assert_eq!(rows.len(), 1, "this phone is the only device: {rows:?}");
        assert!(rows[0].me && rows[0].signer);

        // The other device is out.
        assert!(matches!(
            lost.sync().await,
            Err(flows::FlowError::Problem(AccountProblem::Revoked))
        ));

        // The page told the person: the flag goes, the account stays.
        let s = cloud::cloud_recovered_ack().unwrap();
        assert!(
            matches!(
                s,
                Status::Connected {
                    signer: true,
                    recovered: false,
                    ..
                }
            ),
            "{s:?}"
        );
        assert!(matches!(
            cloud::cloud_status().await,
            Status::Connected {
                recovered: false,
                ..
            }
        ));

        cloud::cloud_sign_out().await.unwrap();
        assert!(!dir.join("cloud").join("identity.json").exists());
    });
}

#[test]
fn a_wrong_recovery_code_leaves_the_account_alone_and_an_empty_account_sets_up() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        let (dir, _) = init_phone();
        let account = fake.new_account();
        let mut other = another_device(&base);
        account_created_by(&fake, &mut other, &account).await;

        // A well-formed code that is not this account's.
        let stranger = flows::GenesisDraft::new().code.to_string();
        cloud::cloud_recover(stranger).unwrap();
        let Status::SigningIn { user_code, .. } =
            wait("the user code", |s| matches!(s, Status::SigningIn { .. })).await
        else {
            unreachable!()
        };
        fake.approve(&user_code, &account);
        let s = wait("a guest again", |s| matches!(s, Status::Guest { .. })).await;
        assert!(
            matches!(
                s,
                Status::Guest {
                    notice: Some(cloud::Notice::WrongRecoveryCode),
                    ..
                }
            ),
            "{s:?}"
        );
        assert_eq!(
            serde_json::to_value(&s).unwrap()["notice"],
            "wrong_recovery_code"
        );
        assert!(!dir.join("cloud").join("identity.json").exists());
        assert!(other.sync().await.is_ok(), "the account kept its device");

        // An account with no roster yet: the same sign-in sets it up, with
        // its recovery code shown first (the recovery code typed is unused).
        let empty = fake.new_account();
        let typed = flows::GenesisDraft::new().code.to_string();
        cloud::cloud_recover(typed).unwrap();
        let Status::SigningIn { user_code, .. } =
            wait("the user code", |s| matches!(s, Status::SigningIn { .. })).await
        else {
            unreachable!()
        };
        fake.approve(&user_code, &empty);
        let Status::Recovery {
            check: [a, b],
            code,
            ..
        } = wait("the recovery code", |s| {
            matches!(s, Status::Recovery { .. })
        })
        .await
        else {
            unreachable!()
        };
        let s = cloud::cloud_confirm_recovery(
            recovery::group(&code, a).unwrap().into(),
            recovery::group(&code, b).unwrap().into(),
        )
        .await
        .unwrap();
        assert!(
            matches!(
                s,
                Status::Connected {
                    signer: true,
                    recovered: false,
                    ..
                }
            ),
            "setting up is not a recovery: {s:?}"
        );
        cloud::cloud_sign_out().await.unwrap();

        // Cancelling a recovering sign-in stops it.
        cloud::cloud_recover(flows::GenesisDraft::new().code.to_string()).unwrap();
        wait("the user code", |s| matches!(s, Status::SigningIn { .. })).await;
        let s = cloud::cloud_cancel().unwrap();
        assert!(matches!(s, Status::Guest { notice: None, .. }), "{s:?}");
    });
}

#[test]
fn the_phone_lets_a_computer_approve_others_after_face_id() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        init_phone();
        let computer = signed_in_with_a_computer(&fake, &base).await;
        let id = computer.cloud.device_id();
        let signer_of =
            |rows: &[cloud::DeviceRow]| rows.iter().find(|d| d.device_id == id).unwrap().signer;
        assert!(!signer_of(&cloud::cloud_devices().await.unwrap()));

        // Face ID cancelled: nothing changes.
        cloud::CANCEL_NEXT_UNLOCK.store(true, std::sync::atomic::Ordering::SeqCst);
        let cancelled = cloud::cloud_make_approver(id.clone()).await;
        assert_eq!(cancelled.unwrap_err(), "Cancelled.");
        assert!(!signer_of(&cloud::cloud_devices().await.unwrap()));

        cloud::cloud_make_approver(id.clone()).await.unwrap();
        let rows = cloud::cloud_devices().await.unwrap();
        assert!(signer_of(&rows), "{rows:?}");
        let row = rows.iter().find(|d| d.device_id == id).unwrap();
        assert!(row.server && row.client, "its roles are unchanged");

        // A device the account does not have is refused, in plain words.
        let stranger = DeviceKeys::generate().id();
        assert_eq!(
            cloud::cloud_make_approver(stranger).await.unwrap_err(),
            "That device is no longer in your account."
        );

        cloud::cloud_sign_out().await.unwrap();
    });
}

/// A device of an account that can add others, outside the phone: the
/// "old phone" that scans this one's code.
async fn signer_with_account(fake: &fake_cloud::Fake, base: &str) -> Member {
    let account = fake.new_account();
    let cloud = Cloud::new(
        reqwest::Client::new(),
        Endpoints::custom(base, "https://account.openagentd.dev"),
        DeviceKeys::generate(),
        None,
    );
    let code = cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&cloud, &code).await.unwrap();
    let mut member = Member::new(cloud, None);
    flows::genesis(&mut member, &session, flows::GenesisDraft::new())
        .await
        .unwrap();
    member
}

/// The other phone scans this one's code and taps Add: the number it shows.
async fn scan_and_add(signer: &mut Member, link: &str) -> String {
    let invite = flows::offer_scanned(signer, link).await.unwrap();
    let mut candidate = None;
    for _ in 0..400 {
        if let flows::Candidates::One(c) = flows::check_candidates(signer, &invite).await.unwrap() {
            candidate = Some(c);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let c = candidate.expect("the phone claimed the offer");
    let grant = flows::Grant {
        signer: true,
        roles: openagentd_cloud::keys::Roles::CLIENT,
    };
    flows::add_scanned(signer, invite, &c.enrollment_id, grant)
        .await
        .unwrap()
        .1
}

#[test]
fn a_new_phone_joins_when_another_phone_scans_its_code() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    tauri::async_runtime::block_on(async {
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        let (dir, _) = init_phone();
        let mut signer = signer_with_account(&fake, &base).await;

        // The new phone shows its code; the other phone scans it and adds it.
        cloud::cloud_sign_in().unwrap();
        let Status::SigningIn { add_link: Some(link), .. } =
            wait("the scan code", |s| matches!(s, Status::SigningIn { .. })).await
        else {
            panic!("a sign-in that is not a recovery shows a scan code")
        };
        assert!(link.starts_with("agentd://add?"), "{link}");
        let number = scan_and_add(&mut signer, &link).await;
        let Status::Confirming { choices } =
            wait("the number", |s| matches!(s, Status::Confirming { .. })).await
        else {
            unreachable!()
        };
        assert!(choices.contains(&number), "{choices:?} has {number}");
        assert!(
            !dir.join("cloud").join("identity.json").exists(),
            "nothing is stored before the person picks the number"
        );
        let s = cloud::cloud_pick_number(number).await.unwrap();
        assert!(matches!(s, Status::Connected { .. }), "{s:?}");
        assert!(dir.join("cloud").join("identity.json").exists());
        cloud::cloud_sign_out().await.unwrap();

        // A wrong pick: the phone leaves again and keeps nothing.
        cloud::cloud_sign_in().unwrap();
        let Status::SigningIn { add_link: Some(link), .. } =
            wait("the scan code", |s| matches!(s, Status::SigningIn { add_link: Some(_), .. })).await
        else {
            unreachable!()
        };
        let number = scan_and_add(&mut signer, &link).await;
        let Status::Confirming { choices } =
            wait("the number", |s| matches!(s, Status::Confirming { .. })).await
        else {
            unreachable!()
        };
        let wrong = choices.iter().find(|c| **c != number).unwrap().clone();
        let s = cloud::cloud_pick_number(wrong).await.unwrap();
        assert!(
            matches!(
                s,
                Status::Guest {
                    notice: Some(cloud::Notice::WrongNumber),
                    ..
                }
            ),
            "{s:?}"
        );
        assert!(!dir.join("cloud").join("identity.json").exists());
        assert!(cloud::cloud_pick_number("00".into()).await.is_err(), "one answer only");

        // Cancel while the number shows: not added either.
        cloud::cloud_sign_in().unwrap();
        let Status::SigningIn { add_link: Some(link), .. } =
            wait("the scan code", |s| matches!(s, Status::SigningIn { add_link: Some(_), .. })).await
        else {
            unreachable!()
        };
        scan_and_add(&mut signer, &link).await;
        wait("the number", |s| matches!(s, Status::Confirming { .. })).await;
        let s = cloud::cloud_cancel().unwrap();
        assert!(matches!(s, Status::Guest { notice: None, .. }), "{s:?}");
        assert!(!dir.join("cloud").join("identity.json").exists());
    });
}
