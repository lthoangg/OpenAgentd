//! Relay sessions end to end through the fake relay: presence, offer,
//! Noise IK against the verified roster, yamux streams, and revocation.

mod fake_cloud;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use fake_cloud::relay::PresenceMode;
use fake_cloud::Fake;
use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, FlowError, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::mux::Stream;
use openagentd_cloud::relay::{self, HostHandler, HostOptions, Join, Keepalive, RelayError, Sessions};
use openagentd_cloud::roster::Roster;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

const FAST: Pace = Pace { every: Duration::from_millis(20), timeout: Duration::from_secs(10) };

fn cloud(base: &str) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None)
}

async fn sign_in(fake: &Fake, c: &Cloud, account: &str) -> flows::Session {
    let code = c.device_code().await.unwrap();
    fake.approve(&code.user_code, account);
    flows::wait_for_session(c, &code).await.unwrap()
}

/// A phone (signer, client) and a server (member, server only) in one account.
async fn account(fake: &Fake, base: &str) -> (Member, Member) {
    account_with(fake, base, Roles::CLIENT).await
}

/// Like [`account`], with the first device's roles chosen.
async fn account_with(fake: &Fake, base: &str, first: Roles) -> (Member, Member) {
    let account = fake.new_account();
    let mut phone = Member::new(cloud(base), None);
    phone.cloud.roles = first;
    let s = sign_in(fake, &phone.cloud, &account).await;
    flows::genesis(&mut phone, &s, GenesisDraft::new()).await.unwrap();
    let mut server = Member::new(cloud(base), None);
    server.cloud.roles = Roles::SERVER;
    let s = sign_in(fake, &server.cloud, &account).await;
    let req = flows::request_to_join(&mut server, &s).await.unwrap();
    let p = phone.cloud.pending_list().await.unwrap().remove(0);
    let mut a = flows::begin_approval(&mut phone, p).await.unwrap();
    let jc = flows::await_signer(&mut server, &req, FAST).await.unwrap();
    flows::await_reveal(&mut phone, &mut a, FAST).await.unwrap();
    let (r1, r2) = tokio::join!(flows::confirm_approval(&mut phone, a, flows::Grant { signer: false, roles: Roles::SERVER }), flows::await_added(&mut server, jc, &req, FAST));
    r1.unwrap();
    r2.unwrap();
    (phone, server)
}

/// A host that echoes each stream back, uppercased, from its roster.
struct Echo {
    roster: Mutex<Roster>,
    me: String,
    rosters: Mutex<Vec<(u64, Vec<String>)>>,
}

impl HostHandler for Echo {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        if id == self.me {
            return None;
        }
        self.roster.lock().unwrap().body.client(id).map(|d| d.box_key())
    }
    fn serve(&self, mut stream: Stream, _from: String) {
        tokio::spawn(async move {
            let mut got = Vec::new();
            stream.read_to_end(&mut got).await.unwrap();
            stream.write_all(&got.to_ascii_uppercase()).await.unwrap();
            stream.shutdown().await.unwrap();
        });
    }
    fn on_roster(&self, version: u64, revoked: Vec<String>) {
        self.rosters.lock().unwrap().push((version, revoked));
    }
}

async fn start_host(server: &Member) -> (Arc<Echo>, Sessions, oneshot::Sender<()>) {
    let handler = Arc::new(Echo { roster: Mutex::new(server.roster.clone().unwrap()), me: server.cloud.device_id(), rosters: Mutex::new(vec![]) });
    let sessions = Sessions::default();
    let (stop, stop_rx) = oneshot::channel();
    let c = Arc::new(Cloud::new(reqwest::Client::new(), server.cloud.endpoints.clone(), server.cloud.keys.clone(), server.cloud.account_id.clone()));
    tokio::spawn(relay::host(c, relay::http1_client(), handler.clone(), sessions.clone(), Join(Duration::from_millis(2)), stop_rx));
    tokio::time::sleep(Duration::from_millis(200)).await;
    (handler, sessions, stop)
}

#[tokio::test]
async fn a_controller_reaches_the_host_through_the_relay() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let (_h, sessions, _stop) = start_host(&server).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join(Duration::from_millis(2))).await.unwrap();
    for i in 0..3 {
        let mut s = tunnel.session.open().unwrap();
        let body = format!("get /api/health {i} ").repeat(10_000);
        s.write_all(body.as_bytes()).await.unwrap();
        s.shutdown().await.unwrap();
        let mut back = Vec::new();
        s.read_to_end(&mut back).await.unwrap();
        assert_eq!(back, body.to_ascii_uppercase().into_bytes());
    }
    assert_eq!(sessions.count(), 1);
}

#[tokio::test]
async fn the_usage_view_says_which_hosts_are_online() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let host = server.cloud.device_id();
    // Never opened presence: not listed (the caller reads that as offline).
    let usage = phone.cloud.relay_usage().await.unwrap();
    assert!(usage.hosts.is_empty(), "{usage:?}");
    assert_eq!(usage.online().unwrap().get(&host), None);
    let (_h, _sessions, stop) = start_host(&server).await;
    let online = phone.cloud.relay_usage().await.unwrap().online().unwrap();
    assert_eq!(online.get(&host), Some(&true));
    stop.send(()).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let online = phone.cloud.relay_usage().await.unwrap().online().unwrap();
    assert_eq!(online.get(&host), Some(&false));
    // A cloud that does not say: unknown, not offline.
    fake.0.lock().unwrap().usage_without_online = true;
    let usage = phone.cloud.relay_usage().await.unwrap();
    assert_eq!(usage.hosts.len(), 1);
    assert_eq!(usage.online(), None);
}

#[tokio::test]
async fn a_server_only_device_cannot_open_sessions() {
    let fake = Fake::new();
    let base = fake.serve().await;
    // The first device is a computer that only serves.
    let (computer, server) = account_with(&fake, &base, Roles::SERVER).await;
    assert!(!computer.is_client());
    let (_h, sessions, _stop) = start_host(&server).await;
    let host_box = computer.box_of(&server.cloud.device_id()).unwrap();
    let r = relay::connect(&computer.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await;
    assert!(matches!(r, Err(RelayError::Handshake) | Err(RelayError::Closed(4002))), "{:?}", r.err());
    assert_eq!(sessions.count(), 0);
}

#[tokio::test]
async fn a_controller_with_the_wrong_host_key_fails_the_handshake() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let (_h, _s, _stop) = start_host(&server).await;
    // A box key that is not the host's: the cloud could not answer for it.
    let wrong = DeviceKeys::generate().r#box.public();
    let r = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &wrong, Join::default()).await;
    assert!(matches!(r, Err(RelayError::Handshake) | Err(RelayError::Closed(_))), "{:?}", r.err());
}

#[tokio::test]
async fn removing_a_device_closes_its_sessions_with_4001() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, server) = account(&fake, &base).await;
    let (handler, sessions, _stop) = start_host(&server).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let mut tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
    // The host's own decision: revoke the controller's sessions.
    sessions.revoke(&phone.cloud.device_id());
    let code = tokio::time::timeout(Duration::from_secs(5), tunnel.wait_closed()).await.unwrap();
    assert_eq!(code, 4001);
    // A 4001 is unsigned (here the host sent it): only a signal, and the
    // signed roster fetch says the phone is still in the account.
    assert_eq!(openagentd_cloud::account_state::from_close_code(code), Some(AccountProblem::RemovalSignal));
    assert!(matches!(phone.confirm_removal().await, flows::Removal::NotRemoved(_)));
    // A roster write reaches the host's presence socket.
    phone.remove(&server.cloud.device_id()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = handler.rosters.lock().unwrap().clone();
    assert_eq!(seen.last().unwrap().1, vec![server.cloud.device_id()]);
    // The server checks with a signed request, and that confirms it.
    let mut server = server;
    assert!(matches!(server.confirm_removal().await, flows::Removal::Removed));
}

#[tokio::test]
async fn a_removal_signal_without_a_signed_answer_keeps_the_keys() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, mut server) = account(&fake, &base).await;
    // The cloud cannot be reached: no signed answer, so no erase.
    server.cloud.endpoints = Endpoints::custom("http://127.0.0.1:9", "https://account.openagentd.dev");
    assert!(matches!(server.confirm_removal().await, flows::Removal::Unsure(_)));
    // A relay `revoked` answer to a signed request is still only a signal.
    server.cloud.endpoints = Endpoints::custom(&base, "https://account.openagentd.dev");
    let account = server.account_id().unwrap().to_string();
    fake.set_problem(&account, Some((401, serde_json::json!({"error": "revoked"}))));
    assert!(matches!(server.confirm_removal().await, flows::Removal::Unsure(FlowError::Problem(AccountProblem::RemovalSignal))));
    fake.set_problem(&account, None);
    assert!(matches!(server.confirm_removal().await, flows::Removal::NotRemoved(_)));
}

#[tokio::test]
async fn a_leave_is_announced_without_a_new_version() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    let (handler, _sessions, _stop) = start_host(&server).await;
    let version = server.roster.as_ref().unwrap().version();
    server.cloud.leave().await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = handler.rosters.lock().unwrap().clone();
    // The stored version is unchanged; the host itself is listed.
    assert_eq!(seen.last().unwrap(), &(version, vec![server.cloud.device_id()]));
}

#[tokio::test]
async fn an_unavailable_account_refuses_the_relay() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let account = phone.account_id().unwrap().to_string();
    fake.set_problem(&account, Some((403, serde_json::json!({"error": "account_unavailable"}))));
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let r = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await;
    assert_eq!(r.err().and_then(|e| e.problem()), Some(AccountProblem::Unavailable));
}

/// A host whose streams write `n` small chunks back, separately.
struct Chatty {
    roster: Mutex<Roster>,
    me: String,
    n: usize,
}

impl HostHandler for Chatty {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        if id == self.me {
            return None;
        }
        self.roster.lock().unwrap().body.client(id).map(|d| d.box_key())
    }
    fn serve(&self, mut stream: Stream, _from: String) {
        let n = self.n;
        tokio::spawn(async move {
            let mut one = [0u8; 1];
            let _ = stream.read(&mut one).await;
            for _ in 0..n {
                stream.write_all(b"0123456789").await.unwrap();
                stream.flush().await.unwrap();
            }
            stream.shutdown().await.unwrap();
        });
    }
    fn on_roster(&self, _: u64, _: Vec<String>) {}
}

async fn start_chatty(server: &Member, n: usize, join: Join) -> (Sessions, oneshot::Sender<()>) {
    let handler = Arc::new(Chatty { roster: Mutex::new(server.roster.clone().unwrap()), me: server.cloud.device_id(), n });
    let sessions = Sessions::default();
    let (stop, stop_rx) = oneshot::channel();
    let c = Arc::new(Cloud::new(reqwest::Client::new(), server.cloud.endpoints.clone(), server.cloud.keys.clone(), server.cloud.account_id.clone()));
    tokio::spawn(relay::host(c, relay::http1_client(), handler, sessions.clone(), join, stop_rx));
    tokio::time::sleep(Duration::from_millis(200)).await;
    (sessions, stop)
}

#[tokio::test]
async fn small_writes_are_joined_into_few_messages() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let (_s, _stop) = start_chatty(&server, 200, Join::default()).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
    let before = fake.1.lock().unwrap().host_frames.len();
    let mut s = tunnel.session.open().unwrap();
    s.write_all(b"go").await.unwrap();
    let mut back = Vec::new();
    s.read_to_end(&mut back).await.unwrap();
    assert_eq!(back.len(), 2000);
    let frames = fake.1.lock().unwrap().host_frames[before..].to_vec();
    // 200 writes (plus window updates and FIN) in a few 50 ms windows.
    assert!(frames.len() <= 8, "{frames:?}");
    assert!(frames.iter().all(|&n| n <= openagentd_cloud::noise::MAX_MESSAGE), "{frames:?}");
}

#[tokio::test]
async fn large_writes_are_split_at_the_noise_limit() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let (_h, _s, _stop) = start_host(&server).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
    let mut s = tunnel.session.open().unwrap();
    let body = vec![b'a'; 200_000];
    s.write_all(&body).await.unwrap();
    s.shutdown().await.unwrap();
    let mut back = Vec::new();
    s.read_to_end(&mut back).await.unwrap();
    assert_eq!(back.len(), body.len());
    let frames = fake.1.lock().unwrap().host_frames.clone();
    assert!(frames.iter().all(|&n| n <= openagentd_cloud::noise::MAX_MESSAGE));
    assert!(frames.contains(&openagentd_cloud::noise::MAX_MESSAGE), "a full message was sent: {frames:?}");
}

#[tokio::test]
async fn pause_holds_the_hosts_writes_until_resume() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let (sessions, _stop) = start_chatty(&server, 5, Join(Duration::from_millis(2))).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let tunnel = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join(Duration::from_millis(2))).await.unwrap();
    let to_host = fake.1.lock().unwrap().to_host.last().unwrap().clone();
    let ctl = |t: &str| axum::extract::ws::Message::Text(serde_json::json!({"type": t}).to_string().into());
    // A resume with nothing paused is harmless; pause twice is one pause.
    to_host.send(ctl("resume")).unwrap();
    to_host.send(ctl("pause")).unwrap();
    to_host.send(ctl("pause")).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = fake.1.lock().unwrap().host_frames.len();
    let mut s = tunnel.session.open().unwrap();
    s.write_all(b"go").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.1.lock().unwrap().host_frames.len(), before, "nothing is written while paused");
    to_host.send(ctl("resume")).unwrap();
    to_host.send(ctl("resume")).unwrap();
    let mut back = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut back)).await.unwrap().unwrap();
    assert_eq!(back.len(), 50);

    // A revoke while paused still closes the session.
    to_host.send(ctl("pause")).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut s2 = tunnel.session.open().unwrap();
    s2.write_all(b"go").await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    sessions.revoke(&phone.cloud.device_id());
    let mut tunnel = tunnel;
    let code = tokio::time::timeout(Duration::from_secs(5), tunnel.wait_closed()).await.unwrap();
    assert_eq!(code, 4001);
}

/// Keepalive timings a test can wait out: ping every 30 ms, dead after 150 ms.
const QUICK: Keepalive = Keepalive { every: Duration::from_millis(30), dead_after: Duration::from_millis(150) };

/// The client a host's presence runs with (one per process in the app).
fn presence_cloud(server: &Member) -> Arc<Cloud> {
    Arc::new(Cloud::new(reqwest::Client::new(), server.cloud.endpoints.clone(), server.cloud.keys.clone(), server.cloud.account_id.clone()))
}

/// Starts presence for `server` with `opts`; the handle says how it ended.
fn spawn_presence(server: &Member, opts: HostOptions) -> (tokio::task::JoinHandle<RelayError>, oneshot::Sender<()>) {
    spawn_presence_on(presence_cloud(server), server, opts)
}

fn spawn_presence_on(c: Arc<Cloud>, server: &Member, opts: HostOptions) -> (tokio::task::JoinHandle<RelayError>, oneshot::Sender<()>) {
    let handler = Arc::new(Echo { roster: Mutex::new(server.roster.clone().unwrap()), me: server.cloud.device_id(), rosters: Mutex::new(vec![]) });
    let (stop, stop_rx) = oneshot::channel();
    (tokio::spawn(relay::host_with(c, relay::http1_client(), handler, Sessions::default(), stop_rx, opts)), stop)
}

#[tokio::test]
async fn the_deadline_fires_when_neither_pong_nor_protocol_pong_arrives() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    fake.1.lock().unwrap().mode = PresenceMode::Silent;
    let (presence, _stop) = spawn_presence(&server, HostOptions { keepalive: QUICK, ..HostOptions::default() });
    let ended = tokio::time::timeout(Duration::from_secs(3), presence).await.expect("presence gives up a silent socket").unwrap();
    assert_eq!(ended, RelayError::Network);
}

#[tokio::test]
async fn presence_stays_up_past_several_deadlines_while_the_relay_answers() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    let (presence, stop) = spawn_presence(&server, HostOptions { keepalive: QUICK, ..HostOptions::default() });
    tokio::time::sleep(QUICK.dead_after * 6).await;
    assert!(!presence.is_finished(), "pongs keep it alive");
    assert_eq!(fake.1.lock().unwrap().presence_opens, 1);
    stop.send(()).unwrap();
    assert_eq!(presence.await.unwrap(), RelayError::Closed(1000));
}

/// Milliseconds the test clock is ahead of the real wall clock.
static SLEPT_MS: AtomicU64 = AtomicU64::new(0);

fn slept_clock() -> SystemTime {
    SystemTime::now() + Duration::from_millis(SLEPT_MS.load(Ordering::Relaxed))
}

#[tokio::test]
async fn presence_reconnects_at_once_when_the_wall_clock_says_the_machine_slept() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    // A long deadline: only the clock jump can end it within the test.
    let keepalive = Keepalive { every: Duration::from_millis(30), dead_after: Duration::from_secs(60) };
    let (presence, _stop) = spawn_presence(&server, HostOptions { keepalive, wall_clock: slept_clock, ..HostOptions::default() });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!presence.is_finished());
    SLEPT_MS.store(61_000, Ordering::Relaxed);
    let ended = tokio::time::timeout(Duration::from_secs(2), presence).await.expect("the jump ends it at the next ping").unwrap();
    assert_eq!(ended, RelayError::Network);
}

#[tokio::test]
async fn presence_says_open_only_once_the_socket_opened_and_closed_once_it_ends() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    fake.1.lock().unwrap().presence_delay = Some(Duration::from_millis(600));
    let (opened_tx, mut opened) = tokio::sync::watch::channel(false);
    let (presence, stop) = spawn_presence(&server, HostOptions { opened: Some(opened_tx), ..HostOptions::default() });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!*opened.borrow(), "not open while the upgrade is pending");
    tokio::time::timeout(Duration::from_secs(5), opened.wait_for(|open| *open)).await.expect("open once the upgrade answers").unwrap();
    stop.send(()).unwrap();
    presence.await.unwrap();
    assert!(!*opened.borrow(), "closed once presence ended");
}

#[tokio::test]
async fn the_host_sends_text_pings_and_stays_connected_to_a_relay_that_answers_pong() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    let c = presence_cloud(&server);
    let (presence, stop) = spawn_presence_on(c.clone(), &server, HostOptions { keepalive: QUICK, ..HostOptions::default() });
    tokio::time::sleep(QUICK.dead_after * 6).await;
    assert!(!presence.is_finished(), "still connected");
    let (text_pings, opens) = {
        let r = fake.1.lock().unwrap();
        (r.text_pings, r.presence_opens)
    };
    assert!(text_pings >= 3, "text pings sent: {text_pings}");
    assert_eq!(opens, 1);
    assert!(c.text_keepalive());
    stop.send(()).unwrap();
    assert_eq!(presence.await.unwrap(), RelayError::Closed(1000));
}

#[tokio::test]
async fn an_old_relay_that_closes_1003_on_a_text_ping_gets_one_reconnect_and_no_more_text_pings() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    fake.1.lock().unwrap().mode = PresenceMode::Old;
    let c = presence_cloud(&server);
    let (presence, _stop) = spawn_presence_on(c.clone(), &server, HostOptions { keepalive: QUICK, ..HostOptions::default() });
    let ended = tokio::time::timeout(Duration::from_secs(3), presence).await.expect("the old relay closes it").unwrap();
    assert_eq!(ended, RelayError::Closed(1003));
    assert!(!c.text_keepalive(), "no text keepalive from now on");
    // The caller reconnects as usual: protocol pings only, and it stays up.
    let (presence, stop) = spawn_presence_on(c.clone(), &server, HostOptions { keepalive: QUICK, ..HostOptions::default() });
    tokio::time::sleep(QUICK.dead_after * 6).await;
    assert!(!presence.is_finished(), "the reconnect stays up");
    let (text_pings, opens) = {
        let r = fake.1.lock().unwrap();
        (r.text_pings, r.presence_opens)
    };
    assert_eq!(text_pings, 1, "one text ping, before the downgrade");
    assert_eq!(opens, 2, "one reconnect");
    stop.send(()).unwrap();
    assert_eq!(presence.await.unwrap(), RelayError::Closed(1000));
}

#[tokio::test]
async fn a_1003_after_a_pong_is_a_real_close_not_a_downgrade() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_phone, server) = account(&fake, &base).await;
    let c = presence_cloud(&server);
    let (presence, _stop) = spawn_presence_on(c.clone(), &server, HostOptions { keepalive: QUICK, ..HostOptions::default() });
    while fake.1.lock().unwrap().text_pings == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // The pong is answered at once; give it time to arrive.
    tokio::time::sleep(Duration::from_millis(200)).await;
    fake.close_presence(1003);
    let ended = tokio::time::timeout(Duration::from_secs(3), presence).await.unwrap().unwrap();
    assert_eq!(ended, RelayError::Closed(1003));
    assert!(c.text_keepalive(), "the relay had answered pong: keep the text keepalive");
}
