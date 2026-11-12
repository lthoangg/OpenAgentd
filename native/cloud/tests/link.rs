//! Links, tokens, pings and the send rule end to end through the fake
//! relay: a link reconnects by itself and backs off, a poke skips the wait,
//! close 4013 reconnects at once, links connect in parallel, one relay token
//! serves many sockets, and a dead or sleeping socket is noticed.

mod fake_cloud;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::ws::{CloseFrame, Message};
use fake_cloud::Fake;
use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::link::{DownReason, Link, LinkDeps, LinkOptions, LinkState, Poke, Route, Target};
use openagentd_cloud::mux::Stream;
use openagentd_cloud::relay::{self, EndCause, HostHandler, HostOptions, Join, Keepalive, Sessions, Waits};
use openagentd_cloud::roster::Roster;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

const FAST: Pace = Pace { every: Duration::from_millis(20), timeout: Duration::from_secs(10) };

fn cloud(base: &str) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None)
}

fn cloud_via(member: &Member, base: &str) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), member.cloud.keys.clone(), member.cloud.account_id.clone())
}

async fn sign_in(fake: &Fake, c: &Cloud, account: &str) -> flows::Session {
    let code = c.device_code().await.unwrap();
    fake.approve(&code.user_code, account);
    flows::wait_for_session(c, &code).await.unwrap()
}

/// A phone (signer, client) and a server in one account.
async fn account(fake: &Fake, base: &str) -> (Member, Member) {
    let account = fake.new_account();
    let mut phone = Member::new(cloud(base), None);
    phone.cloud.roles = Roles::CLIENT;
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

/// Echoes each stream back uppercased; or, for a stream that starts with
/// `chatty`, writes 10 bytes 50 times, 10 ms apart.
struct Echo {
    roster: Mutex<Roster>,
    me: String,
}

impl HostHandler for Echo {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        (id != self.me).then(|| self.roster.lock().unwrap().body.client(id).map(|d| d.box_key())).flatten()
    }
    fn serve(&self, mut stream: Stream, _from: String) {
        tokio::spawn(async move {
            let mut got = Vec::new();
            let _ = stream.read_to_end(&mut got).await;
            if got.starts_with(b"chatty") {
                for _ in 0..50 {
                    let _ = stream.write_all(b"0123456789").await;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            } else {
                let _ = stream.write_all(&got.to_ascii_uppercase()).await;
            }
            let _ = stream.shutdown().await;
        });
    }
    fn on_roster(&self, _: u64, _: Vec<String>) {}
    fn admit_direct(&self, key: &[u8; 32]) -> Option<String> {
        let id = self.roster.lock().unwrap().body.devices.iter().find(|d| d.box_key() == *key)?.id.clone();
        self.controller_box(&id).map(|_| id)
    }
}

async fn start_host_via(server: &Member, base: &str, opts: HostOptions) -> oneshot::Sender<()> {
    let handler = Arc::new(Echo { roster: Mutex::new(server.roster.clone().unwrap()), me: server.cloud.device_id() });
    let (stop, stop_rx) = oneshot::channel();
    tokio::spawn(relay::host_with(Arc::new(cloud_via(server, base)), relay::http1_client(), handler, Sessions::default(), stop_rx, opts));
    tokio::time::sleep(Duration::from_millis(200)).await;
    stop
}

async fn start_host(server: &Member, base: &str) -> oneshot::Sender<()> {
    start_host_via(server, base, HostOptions::default()).await
}

struct Deps {
    target: Target,
    problems: Mutex<Vec<AccountProblem>>,
}

impl LinkDeps for Deps {
    fn target(&self, _device_id: &str) -> Result<Target, DownReason> {
        Ok(self.target.clone())
    }
    fn on_problem(&self, problem: AccountProblem) {
        self.problems.lock().unwrap().push(problem);
    }
}

fn deps(phone: &Member, server: &Member, base: &str) -> Arc<Deps> {
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    Arc::new(Deps { target: Target { cloud: Arc::new(cloud_via(phone, base)), http1: relay::http1_client(), host_box, direct: vec![] }, problems: Mutex::new(vec![]) })
}

fn quick(backoff_first: Duration) -> LinkOptions {
    LinkOptions { backoff_first, backoff_max: backoff_first * 8, direct_loopback: true, ..LinkOptions::default() }
}

async fn wait_for(link: &Link, within: Duration, what: impl Fn(&LinkState) -> bool) -> LinkState {
    let mut rx = link.state();
    let got = tokio::time::timeout(within, rx.wait_for(|s| what(s))).await;
    match got {
        Ok(Ok(s)) => s.clone(),
        _ => panic!("not reached within {within:?}: {:?}", *link.state().borrow()),
    }
}

fn up(s: &LinkState) -> bool {
    matches!(s, LinkState::Up { .. })
}

async fn round_trip(link: &Link, text: &str) {
    let mut s = link.open_stream(Duration::from_secs(5)).await.unwrap();
    s.write_all(text.as_bytes()).await.unwrap();
    s.shutdown().await.unwrap();
    let mut back = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut back)).await.unwrap().unwrap();
    assert_eq!(back, text.to_ascii_uppercase().into_bytes());
}

fn close_controller(fake: &Fake, code: u16) {
    let to_c = fake.1.lock().unwrap().to_controller.last().unwrap().clone();
    let _ = to_c.send(Message::Close(Some(CloseFrame { code, reason: "".into() })));
}

#[tokio::test]
async fn a_link_reconnects_by_itself_after_the_tunnel_dies() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let link = Link::start_with(deps(&phone, &server, &base), server.cloud.device_id(), quick(Duration::from_millis(200)));
    wait_for(&link, Duration::from_secs(5), up).await;
    round_trip(&link, "first").await;
    close_controller(&fake, 1011);
    let down = wait_for(&link, Duration::from_secs(2), |s| matches!(s, LinkState::Down { .. })).await;
    assert!(matches!(down, LinkState::Down { reason: DownReason::Network, retry_at: Some(_) }), "{down:?}");
    wait_for(&link, Duration::from_secs(3), up).await;
    round_trip(&link, "again").await;
    assert_eq!(fake.1.lock().unwrap().data_opens, 2);
}

#[tokio::test]
async fn a_link_backs_off_while_the_host_is_offline() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let link = Link::start_with(deps(&phone, &server, &base), server.cloud.device_id(), quick(Duration::from_millis(100)));
    let down = wait_for(&link, Duration::from_secs(2), |s| matches!(s, LinkState::Down { .. })).await;
    assert!(matches!(down, LinkState::Down { reason: DownReason::HostOffline, retry_at: Some(_) }), "{down:?}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    // Waits of 50-100, 100-200, 200-400, then 400-800 ms.
    let opens = fake.1.lock().unwrap().data_opens;
    assert!((4..=8).contains(&opens), "{opens} attempts in 1.5 s");
    // And a request does not wait for a link that will not be up in time.
    let t = Instant::now();
    let r = link.open_stream(Duration::from_millis(10)).await;
    assert!(r.is_err() && t.elapsed() < Duration::from_millis(500));
}

#[tokio::test]
async fn a_poke_skips_the_wait() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let link = Link::start_with(deps(&phone, &server, &base), server.cloud.device_id(), quick(Duration::from_secs(20)));
    wait_for(&link, Duration::from_secs(2), |s| matches!(s, LinkState::Down { reason: DownReason::HostOffline, .. })).await;
    let _host = start_host(&server, &base).await;
    link.poke(Poke::Resumed);
    wait_for(&link, Duration::from_secs(2), up).await;
    round_trip(&link, "poked").await;
}

#[tokio::test]
async fn the_link_stops_trying_in_the_background() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let link = Link::start_with(deps(&phone, &server, &base), server.cloud.device_id(), quick(Duration::from_millis(50)));
    wait_for(&link, Duration::from_secs(2), |s| matches!(s, LinkState::Down { .. })).await;
    link.poke(Poke::Background);
    wait_for(&link, Duration::from_secs(2), |s| matches!(s, LinkState::Down { retry_at: None, .. })).await;
    let opens = fake.1.lock().unwrap().data_opens;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(fake.1.lock().unwrap().data_opens, opens, "no attempt in the background");
    let _host = start_host(&server, &base).await;
    link.poke(Poke::Resumed);
    wait_for(&link, Duration::from_secs(2), up).await;
}

#[tokio::test]
async fn close_4013_reconnects_at_once_and_another_close_waits() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let link = Link::start_with(deps(&phone, &server, &base), server.cloud.device_id(), quick(Duration::from_secs(20)));
    wait_for(&link, Duration::from_secs(5), up).await;
    let mut state = link.state();
    state.borrow_and_update();
    close_controller(&fake, relay::CLOSE_SILENT);
    // Down for a moment at most, then up again on a new session.
    state.changed().await.unwrap();
    wait_for(&link, Duration::from_secs(2), up).await;
    assert_eq!(fake.1.lock().unwrap().data_opens, 2);
    round_trip(&link, "back").await;
    // A plain close waits out the backoff (10 to 20 s here).
    close_controller(&fake, 1011);
    let down = wait_for(&link, Duration::from_secs(2), |s| matches!(s, LinkState::Down { .. })).await;
    let LinkState::Down { retry_at: Some(at), .. } = down else { panic!("{down:?}") };
    assert!(at.duration_since(SystemTime::now()).unwrap() > Duration::from_secs(5));
}

#[tokio::test]
async fn two_links_connect_at_the_same_time() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let d = deps(&phone, &server, &base);
    // Warm the token, so only the slow upgrades count.
    d.target.cloud.relay_token().await.unwrap();
    fake.1.lock().unwrap().data_delay = Some(Duration::from_millis(1000));
    let t = Instant::now();
    let a = Link::start(d.clone(), server.cloud.device_id());
    let b = Link::start(d, server.cloud.device_id());
    wait_for(&a, Duration::from_secs(5), up).await;
    wait_for(&b, Duration::from_secs(5), up).await;
    assert!(t.elapsed() < Duration::from_millis(1800), "one after the other: {:?}", t.elapsed());
}

fn phone_tokens(fake: &Fake, phone: &Member) -> usize {
    let me = phone.cloud.device_id();
    fake.0.lock().unwrap().tokens.values().filter(|(_, d)| *d == me).count()
}

#[tokio::test]
async fn ten_sessions_share_one_token_and_a_refused_token_is_fetched_once_more() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let http1 = relay::http1_client();
    for _ in 0..10 {
        let t = relay::connect(&phone.cloud, &http1, &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
        t.end(1000);
    }
    assert_eq!(phone_tokens(&fake, &phone), 1);
    // The relay forgets every token: the next upgrade is refused with 401,
    // and one new token is fetched.
    fake.0.lock().unwrap().tokens.clear();
    let t = relay::connect(&phone.cloud, &http1, &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
    t.end(1000);
    assert_eq!(phone_tokens(&fake, &phone), 1, "exactly one new token");
    let t = relay::connect(&phone.cloud, &http1, &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
    t.end(1000);
    assert_eq!(phone_tokens(&fake, &phone), 1, "and it is reused");
    // A token that is refused again is not retried in a loop.
    let account = phone.account_id().unwrap().to_string();
    fake.set_problem(&account, Some((401, serde_json::json!({"error": "revoked"}))));
    let before = fake.0.lock().unwrap().relay_tokens_issued;
    let r = relay::connect(&phone.cloud, &http1, &server.cloud.device_id(), &host_box, Join::default()).await;
    assert!(r.is_err());
    assert!(fake.0.lock().unwrap().relay_tokens_issued - before <= 1);
}

/// Ping every 30 ms; a long deadline, so only what a test does ends it.
const PINGY: Keepalive = Keepalive { every: Duration::from_millis(30), dead_after: Duration::from_secs(60), wall_clock: SystemTime::now };

#[tokio::test]
async fn a_paused_writer_still_pings() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host_via(&server, &base, HostOptions { keepalive: PINGY, ..HostOptions::default() }).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let tunnel = relay::connect_with(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default(), PINGY).await.unwrap();
    let to_host = fake.1.lock().unwrap().to_host.last().unwrap().clone();
    let _ = to_host.send(Message::Text(serde_json::json!({"type": "pause"}).to_string().into()));
    tokio::time::sleep(Duration::from_millis(50)).await;
    // The host has data waiting and is paused.
    let mut s = tunnel.session.open().unwrap();
    s.write_all(b"chatty").await.unwrap();
    s.shutdown().await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = fake.1.lock().unwrap().host_text_pings;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let pings = fake.1.lock().unwrap().host_text_pings - before;
    assert!(pings >= 5, "{pings} pings while paused");
    let _ = to_host.send(Message::Text(serde_json::json!({"type": "resume"}).to_string().into()));
    let mut back = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut back)).await.unwrap().unwrap();
    assert_eq!(back.len(), 500);
}

#[tokio::test]
async fn the_first_ping_goes_out_as_soon_as_a_socket_is_up() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    assert!(fake.1.lock().unwrap().text_pings >= 1, "presence pinged at once");
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let _t = relay::connect(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = fake.1.lock().unwrap();
    assert!(r.data_text_pings - r.host_text_pings >= 1, "the phone pinged at once");
    assert!(r.host_text_pings >= 1, "the host pinged at once");
}

static SLEPT_MS: AtomicU64 = AtomicU64::new(0);

fn slept_clock() -> SystemTime {
    SystemTime::now() + Duration::from_millis(SLEPT_MS.load(Ordering::Relaxed))
}

#[tokio::test]
async fn a_wall_clock_jump_ends_the_tunnel() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let keepalive = Keepalive { wall_clock: slept_clock, ..PINGY };
    let mut tunnel = relay::connect_with(&phone.cloud, &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default(), keepalive).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!tunnel.is_closed());
    SLEPT_MS.store(61_000, Ordering::Relaxed);
    let end = tokio::time::timeout(Duration::from_secs(2), tunnel.wait_ended()).await.expect("the jump ends it").unwrap();
    assert_eq!(end.cause, EndCause::Deadline);
}

#[tokio::test]
async fn a_check_ends_a_dead_tunnel_in_seconds_and_keeps_a_live_one() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let (via, frozen) = fake_cloud::proxy::freezable(&base).await;
    let host_box = phone.box_of(&server.cloud.device_id()).unwrap();
    let mut tunnel = relay::connect(&cloud_via(&phone, &via), &relay::http1_client(), &server.cloud.device_id(), &host_box, Join::default()).await.unwrap();
    tunnel.check(Duration::from_millis(500));
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!tunnel.is_closed(), "a live tunnel answers: {:?}", *tunnel.ended.borrow());
    frozen.store(true, Ordering::Relaxed);
    let t = Instant::now();
    tunnel.check(Duration::from_millis(500));
    let end = tokio::time::timeout(Duration::from_secs(2), tunnel.wait_ended()).await.expect("the check ends it").unwrap();
    assert_eq!(end.cause, EndCause::Deadline);
    assert!(t.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn a_network_change_on_a_dead_tunnel_brings_the_link_back() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let (via, frozen) = fake_cloud::proxy::freezable(&base).await;
    let waits = Waits { open: Duration::from_millis(500), pair: Duration::from_millis(500), handshake: Duration::from_millis(500) };
    let opts = LinkOptions { check_within: Duration::from_millis(300), waits, ..quick(Duration::from_millis(100)) };
    let link = Link::start_with(deps(&phone, &server, &via), server.cloud.device_id(), opts);
    wait_for(&link, Duration::from_secs(5), up).await;
    frozen.store(true, Ordering::Relaxed);
    link.poke(Poke::NetworkChanged);
    wait_for(&link, Duration::from_secs(2), |s| !up(s)).await;
    frozen.store(false, Ordering::Relaxed);
    link.poke(Poke::NetworkChanged);
    wait_for(&link, Duration::from_secs(5), up).await;
    round_trip(&link, "back").await;
}

/// A direct listener for `server` on one of this machine's private
/// addresses (port `port`, 0 for any), serving like the host; `None` when
/// the machine has no private address. Abort the handle and close the
/// sessions to take it down.
async fn direct_host(server: &Member, port: u16) -> Option<(std::net::SocketAddr, tokio::task::JoinHandle<()>, Sessions)> {
    use openagentd_cloud::direct::{self, HostKeys};
    // Loopback: the macOS application firewall holds incoming connections
    // on a LAN address for an unsigned test binary. The link dials it only
    // with `direct_loopback` (tests); the route logic is the same.
    let _ = direct::local_subnets;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.ok()?;
    let addr = listener.local_addr().ok()?;
    let handler: Arc<dyn HostHandler> = Arc::new(Echo { roster: Mutex::new(server.roster.clone().unwrap()), me: server.cloud.device_id() });
    let keys = Arc::new(HostKeys { account_id: server.cloud.account_id.clone().unwrap(), host_id: server.cloud.device_id(), own_box: server.cloud.keys.r#box.seed().clone() });
    let sessions = Sessions::default();
    let s2 = sessions.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let (k, h, s) = (keys.clone(), handler.clone(), s2.clone());
            tokio::spawn(async move {
                let _ = direct::serve_host(tcp, k, h, s, Join::default(), Keepalive::default()).await;
            });
        }
    });
    Some((addr, task, sessions))
}

fn direct_deps(phone: &Member, server: &Member, base: &str, addr: std::net::SocketAddr) -> Arc<Deps> {
    let d = deps(phone, server, base);
    let mut target = d.target.clone();
    target.direct = vec![addr];
    Arc::new(Deps { target, problems: Mutex::new(vec![]) })
}

fn on_direct(s: &LinkState) -> bool {
    matches!(s, LinkState::Up { route: Route::Direct { .. }, .. })
}

fn on_relay(s: &LinkState) -> bool {
    matches!(s, LinkState::Up { route: Route::Relay, .. })
}

#[tokio::test]
async fn direct_wins_falls_back_to_the_relay_and_comes_back_on_a_poke() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    let Some((addr, task, sessions)) = direct_host(&server, 0).await else {
        eprintln!("no reachable private address on this machine: skipped");
        return;
    };
    let link = Link::start_with(direct_deps(&phone, &server, &base, addr), server.cloud.device_id(), quick(Duration::from_millis(200)));
    // Direct wins the race.
    wait_for(&link, Duration::from_secs(5), on_direct).await;
    round_trip(&link, "at home").await;
    // Wi-Fi off, in effect: the direct host goes away. The relay takes over
    // within seconds, and the same link serves the next request.
    task.abort();
    sessions.close_all(1001);
    let t = Instant::now();
    wait_for(&link, Duration::from_secs(5), on_relay).await;
    eprintln!("direct to relay in {:?}", t.elapsed());
    round_trip(&link, "away").await;
    // Back home: a poke tries direct again and it takes over; the relay
    // drains.
    let (_addr2, _task2, _s2) = direct_host(&server, addr.port()).await.expect("the same port again");
    link.poke(Poke::NetworkChanged);
    let t = Instant::now();
    wait_for(&link, Duration::from_secs(5), on_direct).await;
    eprintln!("relay to direct in {:?}", t.elapsed());
    round_trip(&link, "home again").await;
}

#[tokio::test]
async fn a_dead_address_does_not_delay_the_relay() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    let _host = start_host(&server, &base).await;
    // An address where nothing answers any more.
    let Some((addr, task, _)) = direct_host(&server, 0).await else {
        eprintln!("no reachable private address on this machine: skipped");
        return;
    };
    task.abort();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let link = Link::start_with(direct_deps(&phone, &server, &base, addr), server.cloud.device_id(), quick(Duration::from_millis(200)));
    let t = Instant::now();
    wait_for(&link, Duration::from_secs(5), on_relay).await;
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    round_trip(&link, "relay").await;
}
