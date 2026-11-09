//! The full scenario against a real development cloud, run by the owner:
//!
//! ```text
//! OPENAGENTD_CLOUD_API=<dev api> OPENAGENTD_CLOUD_ACCOUNT=<dev account pages> \
//!   cargo test --test dev_cloud -- --ignored --nocapture --test-threads 1
//! ```
//!
//! Debug builds only read those variables (release builds pin production),
//! and no development host is named in this repository. Each sign-in prints
//! a page and a code to approve in a browser signed in to a test account
//! that has no devices yet. Nothing here is recorded.
//!
//! Covers: a phone stand-in creates the account (genesis), a server joins
//! through the 6-digit code, the phone reaches the server through the relay,
//! the server leaves a sealed letter the phone opens, the phone removes the
//! server, and both leave.

use std::time::Duration;

use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::DeviceKeys;
use openagentd_cloud::letter::{self, Context, Kind, Text};
use openagentd_cloud::relay::{self, HostHandler, Join, Sessions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn endpoints() -> Endpoints {
    let e = Endpoints::current();
    assert_ne!(e, Endpoints::production(), "set OPENAGENTD_CLOUD_API and OPENAGENTD_CLOUD_ACCOUNT to a development cloud");
    e
}

async fn sign_in(who: &str, cloud: &Cloud) -> flows::Session {
    let code = cloud.device_code().await.expect("device code");
    eprintln!("\n[{who}] open {} and approve {} (device {})\n", code.url, code.user_code, code.fingerprint);
    flows::wait_for_session(cloud, &code).await.expect("approved")
}

struct Echo(std::sync::Mutex<openagentd_cloud::roster::Roster>, String);

impl HostHandler for Echo {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        (id != self.1).then(|| self.0.lock().unwrap().body.device(id).map(|d| d.box_key())).flatten()
    }
    fn serve(&self, mut s: openagentd_cloud::mux::Stream, _from: String) {
        tokio::spawn(async move {
            let mut got = Vec::new();
            let _ = s.read_to_end(&mut got).await;
            let _ = s.write_all(&got.to_ascii_uppercase()).await;
            let _ = s.shutdown().await;
        });
    }
    fn on_roster(&self, _: u64, _: Vec<String>) {}
}

#[tokio::test]
#[ignore = "needs a development cloud and a person to approve sign-ins"]
async fn full_scenario() {
    let e = endpoints();
    let http = reqwest::Client::new();
    let pace = Pace { every: Duration::from_secs(2), timeout: Duration::from_secs(300) };

    // The phone creates the account.
    let mut phone = Member::new(Cloud::new(http.clone(), e.clone(), DeviceKeys::generate(), None), None);
    let s = sign_in("phone", &phone.cloud).await;
    assert!(matches!(flows::request_to_join(&mut phone, &s).await, Err(flows::FlowError::EmptyAccount)), "use an account with no devices");
    flows::genesis(&mut phone, &s, GenesisDraft::new()).await.expect("genesis");

    // The server joins; both sides compute the same code.
    let mut server = Member::new(Cloud::new(http.clone(), e.clone(), DeviceKeys::generate(), None), None);
    let s = sign_in("server", &server.cloud).await;
    let req = flows::request_to_join(&mut server, &s).await.expect("join request");
    let pending = loop {
        if let Some(p) = phone.cloud.pending_list().await.expect("pending").into_iter().find(|p| p.enrollment_id == req.enrollment_id) {
            break p;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    let mut approval = flows::begin_approval(&mut phone, pending).await.expect("n_a");
    let joined = flows::await_signer(&mut server, &req, pace).await.expect("n_n");
    let shown = flows::await_reveal(&mut phone, &mut approval, pace).await.expect("reveal");
    assert_eq!(shown.code, joined.code, "the 6-digit codes match");
    let (a, b) = tokio::join!(flows::confirm_approval(&mut phone, approval, false), flows::await_added(&mut server, joined, &req, pace));
    a.expect("roster write");
    b.expect("server sees itself added");

    // The phone reaches the server through the relay.
    let host = std::sync::Arc::new(Cloud::new(http.clone(), e.clone(), server.cloud.keys.clone(), server.cloud.account_id.clone()));
    let handler = std::sync::Arc::new(Echo(std::sync::Mutex::new(server.roster.clone().unwrap()), server.cloud.device_id()));
    let (stop, stop_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(relay::host(host, relay::http1_client(), handler, Sessions::default(), Join::default(), stop_rx));
    tokio::time::sleep(Duration::from_secs(3)).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await.expect("relay");
    let mut st = tunnel.session.open().unwrap();
    st.write_all(b"get /api/health").await.unwrap();
    st.shutdown().await.unwrap();
    let mut back = Vec::new();
    st.read_to_end(&mut back).await.unwrap();
    assert_eq!(back, b"GET /API/HEALTH");
    tunnel.end(1000);
    let _ = stop.send(());

    // A sealed letter from the server opens on the phone.
    let account = phone.account_id().unwrap().to_string();
    let text = Text { v: 1, title: "Done · staging".into(), body: "Scenario".into(), session: None, at: 1 };
    let ctx = Context { account_id: &account, sender_id: &server.cloud.device_id(), recipient_id: &phone.cloud.device_id(), kind: Kind::Done };
    let sealed = letter::seal(&server.cloud.keys.r#box, &phone.cloud.keys.r#box.public(), &ctx, &text).unwrap();
    server.cloud.send_letter(&phone.cloud.device_id(), Kind::Done, &sealed, None).await.expect("letter");
    let got = phone.cloud.letters().await.expect("mailbox").into_iter().last().expect("a letter");
    let raw = openagentd_cloud::encoding::from_b64(&got.sealed).unwrap();
    let server_box = phone.box_of(&got.from).unwrap();
    assert_eq!(letter::open(&phone.cloud.keys.r#box, &server_box, &ctx, &raw).unwrap(), text);
    phone.cloud.ack_letters(&[got.id]).await.unwrap();

    // The phone removes the server; then both leave.
    phone.remove(&server.cloud.device_id()).await.expect("remove");
    let _ = server.cloud.leave().await;
    phone.cloud.leave().await.expect("leave");
}
