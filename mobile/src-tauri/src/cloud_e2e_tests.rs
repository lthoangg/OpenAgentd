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
use std::sync::{Arc, Mutex};
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
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let fake = fake_cloud::Fake::new();
        let base = fake.serve().await;
        // Debug builds only: point the phone at the fake cloud.
        std::env::set_var("OPENAGENTD_CLOUD_API", &base);
        std::env::set_var("OPENAGENTD_CLOUD_ACCOUNT", "https://account.openagentd.dev");
        cloud::init(dir.path().to_path_buf());
        assert!(
            matches!(
                cloud::cloud_status(),
                Status::Guest {
                    notice: None,
                    supported: true
                }
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
        assert!(dir.path().join("cloud").join("identity.json").exists());

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
        let origin = cloud::open_bridge(&computer.cloud.device_id())
            .await
            .unwrap();
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
        assert!(dir.path().join("cloud").join("identity.json").exists());
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
        assert!(!dir.path().join("cloud").join("identity.json").exists());
    });
}
