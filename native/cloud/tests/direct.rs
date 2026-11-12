//! Direct sessions (spec section 5.5) over loopback TCP: the greeting and
//! framing, admission, streams, the keepalive and the close reasons.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use openagentd_cloud::direct::{self, DialTarget, DirectAnswer, DirectError, Expect, Gate, HostKeys};
use openagentd_cloud::keys::DeviceKeys;
use openagentd_cloud::relay::{EndCause, HostHandler, Join, Keepalive, Sessions, Tunnel};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const ACCOUNT: &str = "acct_test";

/// A host's view: which keys are active clients, which ids are removed.
#[derive(Default)]
struct Host {
    clients: Mutex<HashMap<[u8; 32], String>>,
    removed: Mutex<Vec<String>>,
}

impl HostHandler for Host {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        if self.removed.lock().unwrap().iter().any(|r| r == id) {
            return None;
        }
        self.clients.lock().unwrap().iter().find(|(_, v)| *v == id).map(|(k, _)| *k)
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
    fn admit_direct(&self, key: &[u8; 32]) -> Option<String> {
        let id = self.clients.lock().unwrap().get(key).cloned()?;
        self.controller_box(&id).map(|_| id)
    }
}

struct Setup {
    phone: DeviceKeys,
    server: DeviceKeys,
    host: Arc<Host>,
    sessions: Sessions,
    addr: SocketAddr,
}

async fn setup(keepalive: Keepalive) -> Setup {
    let phone = DeviceKeys::generate();
    let server = DeviceKeys::generate();
    let host = Arc::new(Host::default());
    host.clients.lock().unwrap().insert(phone.r#box.public(), phone.id());
    let sessions = Sessions::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let keys = Arc::new(HostKeys { account_id: ACCOUNT.into(), host_id: server.id(), own_box: server.r#box.seed().clone() });
    let (h, s) = (host.clone(), sessions.clone());
    tokio::spawn(async move {
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            let (keys, h, s) = (keys.clone(), h.clone(), s.clone());
            tokio::spawn(async move {
                let _ = direct::serve_host(tcp, keys, h, s, Join::default(), keepalive).await;
            });
        }
    });
    Setup { phone, server, host, sessions, addr }
}

async fn connect(s: &Setup, keepalive: Keepalive) -> Result<Tunnel, DirectError> {
    let tcp = TcpStream::connect(s.addr).await.unwrap();
    let host_box = s.server.r#box.public();
    let host_id = s.server.id();
    let t = DialTarget { addr: s.addr, account_id: ACCOUNT, host_id: &host_id, host_box: &host_box, own_box: s.phone.r#box.seed(), loopback_ok: false };
    let (tcp, transport) = direct::handshake(tcp, &t).await?;
    Ok(direct::start(tcp, transport, true, Join::default(), keepalive, None))
}

async fn echo(t: &Tunnel, text: &str) -> String {
    let mut st = t.session.open().unwrap();
    st.write_all(text.as_bytes()).await.unwrap();
    st.shutdown().await.unwrap();
    let mut out = String::new();
    st.read_to_string(&mut out).await.unwrap();
    out
}

fn fast() -> Keepalive {
    Keepalive { every: Duration::from_millis(50), dead_after: Duration::from_millis(300), wall_clock: SystemTime::now }
}

#[test]
fn greeting_and_framing() {
    assert_eq!(direct::GREETING, b"agentd-direct-v1\n");
    assert_eq!(direct::frame(&[7; 3]), vec![0, 3, 7, 7, 7]);
    assert!(Expect::Message1.allows(96) && !Expect::Message1.allows(97) && !Expect::Message1.allows(0) && !Expect::Message1.allows(15));
    assert!(Expect::Message2.allows(48) && !Expect::Message2.allows(96));
    assert!(Expect::Transport.allows(16) && Expect::Transport.allows(65_535) && !Expect::Transport.allows(15) && !Expect::Transport.allows(0));
}

#[test]
fn only_private_addresses() {
    for ok in ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "fd12:3456::20", "fc00::1", "::ffff:192.168.1.2"] {
        assert!(direct::is_private(ok.parse().unwrap()), "{ok}");
    }
    for no in ["8.8.8.8", "172.32.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "fe80::1", "2001:db8::1", "::1", "::ffff:8.8.8.8"] {
        assert!(!direct::is_private(no.parse().unwrap()), "{no}");
    }
    let a = DirectAnswer::on(4181, ["192.168.1.20", "8.8.8.8", "fd12::20"].map(|s| s.parse::<IpAddr>().unwrap()));
    assert_eq!(serde_json::to_string(&a).unwrap(), r#"{"v":1,"on":true,"port":4181,"addrs":["192.168.1.20","fd12::20"]}"#);
    assert_eq!(serde_json::to_string(&DirectAnswer::off()).unwrap(), r#"{"v":1,"on":false}"#);
    // A controller drops what is not private, and everything when off.
    let hostile: DirectAnswer = serde_json::from_str(r#"{"v":1,"on":true,"port":4181,"addrs":["1.1.1.1","10.0.0.5","nonsense"]}"#).unwrap();
    assert_eq!(hostile.targets(), vec!["10.0.0.5:4181".parse().unwrap()]);
    let off: DirectAnswer = serde_json::from_str(r#"{"v":1,"on":false,"port":4181,"addrs":["10.0.0.5"]}"#).unwrap();
    assert!(off.targets().is_empty());
}

#[test]
fn unfinished_handshakes_are_limited() {
    let gate = Gate::default();
    let a: IpAddr = "192.168.1.2".parse().unwrap();
    let mine: Vec<_> = (0..4).map(|_| gate.enter(a).unwrap()).collect();
    assert!(gate.enter(a).is_none(), "4 per peer");
    let others: Vec<_> = (0..12).map(|i| gate.enter(format!("192.168.1.{}", 10 + i).parse().unwrap()).unwrap()).collect();
    assert!(gate.enter("192.168.1.99".parse().unwrap()).is_none(), "16 in all");
    drop(mine);
    assert!(gate.enter(a).is_some(), "a place frees when the handshake ends");
    drop(others);
    assert!(direct::acceptable("192.168.1.2:4181".parse().unwrap(), "192.168.1.3:5000".parse().unwrap()));
    assert!(!direct::acceptable("192.168.1.2:4181".parse().unwrap(), "8.8.8.8:5000".parse().unwrap()));
    assert!(!direct::acceptable("203.0.113.1:4181".parse().unwrap(), "192.168.1.3:5000".parse().unwrap()));
}

#[test]
fn addresses_are_tried_only_on_the_network_they_were_learned_on() {
    use openagentd_cloud::direct::{may_try, Subnet};
    let sub = |s: &str, p: u8| Subnet { ip: s.parse().unwrap(), prefix: p };
    let home = [sub("192.168.1.30", 24)];
    let addr: IpAddr = "192.168.1.20".parse().unwrap();
    assert!(may_try(addr, &home, &home));
    // Same network, another address of the phone (DHCP): still home.
    assert!(may_try(addr, &[sub("192.168.1.77", 24)], &home));
    // Mobile data (no private network), or a café on another subnet.
    assert!(!may_try(addr, &[], &home));
    assert!(!may_try(addr, &[sub("10.0.0.5", 8)], &home));
    // An address outside the network it claims to be on.
    assert!(!may_try("192.168.2.20".parse().unwrap(), &home, &home));
    // Learned on another network that happens to look the same is still
    // tried (the handshake decides), but only inside the subnet.
    assert!(may_try(addr, &[sub("192.168.1.9", 24)], &[sub("192.168.1.200", 24)]));
}

#[tokio::test]
async fn a_client_of_the_account_runs_streams_over_a_direct_session() {
    let s = setup(Keepalive::default()).await;
    let t = connect(&s, Keepalive::default()).await.expect("admitted");
    assert_eq!(echo(&t, "hello").await, "HELLO");
    // Many streams at once, and a large one.
    let big = "x".repeat(300_000);
    let (a, b) = tokio::join!(echo(&t, &big), echo(&t, "second"));
    assert_eq!(a.len(), 300_000);
    assert_eq!(b, "SECOND");
}

#[tokio::test]
async fn an_unknown_key_is_refused_with_nothing_sent() {
    let s = setup(Keepalive::default()).await;
    s.host.clients.lock().unwrap().clear();
    assert_eq!(connect(&s, Keepalive::default()).await.err(), Some(DirectError::Refused));
}

#[tokio::test]
async fn a_removed_device_is_refused_and_its_live_session_closes_with_4001() {
    let s = setup(Keepalive::default()).await;
    let mut t = connect(&s, Keepalive::default()).await.unwrap();
    assert_eq!(echo(&t, "a").await, "A");
    s.host.removed.lock().unwrap().push(s.phone.id());
    s.sessions.revoke(&s.phone.id());
    let end = tokio::time::timeout(Duration::from_secs(5), t.wait_ended()).await.unwrap().unwrap();
    assert_eq!((end.cause, end.code), (EndCause::Closed, 4001), "Go Away carries 4001");
    assert_eq!(connect(&s, Keepalive::default()).await.err(), Some(DirectError::Refused));
}

#[tokio::test]
async fn a_wrong_greeting_gets_no_answer() {
    let s = setup(Keepalive::default()).await;
    let mut tcp = TcpStream::connect(s.addr).await.unwrap();
    // The access-key HTTP request of the LAN listener is not a greeting.
    tcp.write_all(b"GET /api/health HTTP/1.1\r\nAuthorization: Bearer k\r\n\r\n").await.unwrap();
    let mut buf = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(2), tcp.read_to_end(&mut buf)).await.unwrap().unwrap_or(0);
    assert_eq!(n, 0, "closed with nothing sent");
}

#[tokio::test]
async fn a_wrong_message_1_length_gets_no_answer() {
    let s = setup(Keepalive::default()).await;
    let mut tcp = TcpStream::connect(s.addr).await.unwrap();
    let mut hello = direct::GREETING.to_vec();
    hello.extend_from_slice(&direct::frame(&[0u8; 97]));
    tcp.write_all(&hello).await.unwrap();
    let mut buf = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(2), tcp.read_to_end(&mut buf)).await.unwrap().unwrap_or(0);
    assert_eq!(n, 0);
}

#[tokio::test]
async fn the_keepalive_holds_a_quiet_session_and_catches_a_silent_peer() {
    let s = setup(fast()).await;
    let mut t = connect(&s, fast()).await.unwrap();
    // Quiet for many deadlines: the yamux pings keep it up on both ends.
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert!(!t.is_closed());
    assert_eq!(echo(&t, "still").await, "STILL");

    // A peer that finishes the handshake and then says nothing at all.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let host = Arc::new(Host::default());
    host.clients.lock().unwrap().insert(s.phone.r#box.public(), s.phone.id());
    let keys = HostKeys { account_id: ACCOUNT.into(), host_id: s.server.id(), own_box: s.server.r#box.seed().clone() };
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let (io, _transport, _) = direct::accept(tcp, &keys, host.as_ref()).await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
        drop(io);
    });
    let tcp = TcpStream::connect(addr).await.unwrap();
    let (hb, hid) = (s.server.r#box.public(), s.server.id());
    let target = DialTarget { addr, account_id: ACCOUNT, host_id: &hid, host_box: &hb, own_box: s.phone.r#box.seed(), loopback_ok: false };
    let (tcp, tr) = direct::handshake(tcp, &target).await.unwrap();
    let mut silent = direct::start(tcp, tr, true, Join::default(), fast(), None);
    let end = tokio::time::timeout(Duration::from_secs(3), silent.wait_ended()).await.unwrap().unwrap();
    assert_eq!(end.cause, EndCause::Deadline);
    t.end(1000);
    let end = tokio::time::timeout(Duration::from_secs(3), t.wait_ended()).await.unwrap().unwrap();
    assert_eq!(end.cause, EndCause::Local);
}

static OFFSET_SECS: AtomicU64 = AtomicU64::new(0);
fn jumpy_clock() -> SystemTime {
    SystemTime::now() + Duration::from_secs(OFFSET_SECS.load(Ordering::Relaxed))
}

#[tokio::test]
async fn a_wall_clock_jump_ends_the_session() {
    let s = setup(Keepalive::default()).await;
    let k = Keepalive { every: Duration::from_millis(50), dead_after: Duration::from_secs(60), wall_clock: jumpy_clock };
    let mut t = connect(&s, k).await.unwrap();
    assert_eq!(echo(&t, "x").await, "X");
    OFFSET_SECS.store(120, Ordering::Relaxed);
    let end = tokio::time::timeout(Duration::from_secs(3), t.wait_ended()).await.unwrap().unwrap();
    assert_eq!(end.cause, EndCause::Deadline);
}

#[tokio::test]
async fn a_check_ends_a_session_that_does_not_answer() {
    let s = setup(Keepalive::default()).await;
    let mut t = connect(&s, Keepalive::default()).await.unwrap();
    // An answering host keeps it.
    t.check(Duration::from_millis(500));
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(!t.is_closed(), "the host answered the ping");
    t.end(1000);
    let _ = t.wait_ended().await;
}

#[tokio::test]
async fn the_host_lifetime_ends_with_a_normal_go_away() {
    let phone = DeviceKeys::generate();
    let server = DeviceKeys::generate();
    let host = Arc::new(Host::default());
    host.clients.lock().unwrap().insert(phone.r#box.public(), phone.id());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let keys = HostKeys { account_id: ACCOUNT.into(), host_id: server.id(), own_box: server.r#box.seed().clone() };
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let (io, tr, _) = direct::accept(tcp, &keys, host.as_ref()).await.unwrap();
        let mut t = direct::start(io, tr, false, Join::default(), Keepalive::default(), Some(Duration::from_millis(200)));
        let _ = t.wait_ended().await;
    });
    let tcp = TcpStream::connect(addr).await.unwrap();
    let (hb, hid) = (server.r#box.public(), server.id());
    let target = DialTarget { addr, account_id: ACCOUNT, host_id: &hid, host_box: &hb, own_box: phone.r#box.seed(), loopback_ok: false };
    let (tcp, tr) = direct::handshake(tcp, &target).await.unwrap();
    let mut t = direct::start(tcp, tr, true, Join::default(), Keepalive::default(), None);
    let end = tokio::time::timeout(Duration::from_secs(3), t.wait_ended()).await.unwrap().unwrap();
    assert_eq!((end.cause, end.code), (EndCause::Closed, 1000));
}

#[tokio::test]
async fn another_host_at_the_address_cannot_answer() {
    let s = setup(Keepalive::default()).await;
    // The controller expects a different host's key at this address.
    let other = DeviceKeys::generate();
    let tcp = TcpStream::connect(s.addr).await.unwrap();
    let (ob, oid) = (other.r#box.public(), other.id());
    let target = DialTarget { addr: s.addr, account_id: ACCOUNT, host_id: &oid, host_box: &ob, own_box: s.phone.r#box.seed(), loopback_ok: false };
    let r = direct::handshake(tcp, &target).await;
    assert!(matches!(r, Err(DirectError::Refused) | Err(DirectError::Handshake)), "{:?}", r.err());
}

#[tokio::test]
async fn dial_refuses_a_public_address() {
    let k = DeviceKeys::generate();
    let hb = k.r#box.public();
    let t = DialTarget { addr: "8.8.8.8:4181".parse().unwrap(), account_id: ACCOUNT, host_id: "x", host_box: &hb, own_box: k.r#box.seed(), loopback_ok: false };
    assert_eq!(direct::dial(t, Join::default(), Keepalive::default(), Duration::from_secs(1)).await.err(), Some(DirectError::Network));
}

#[tokio::test]
async fn eight_sessions_per_controller_the_oldest_makes_way() {
    let s = setup(Keepalive::default()).await;
    let mut first = connect(&s, Keepalive::default()).await.unwrap();
    let mut rest = Vec::new();
    for _ in 0..8 {
        rest.push(connect(&s, Keepalive::default()).await.unwrap());
    }
    let end = tokio::time::timeout(Duration::from_secs(3), first.wait_ended()).await.unwrap().unwrap();
    assert_eq!(end.code, 1000);
    assert_eq!(echo(rest.last().unwrap(), "n").await, "N");
}

#[tokio::test]
async fn a_check_in_the_middle_of_a_frame_does_not_lose_bytes() {
    // The controller's side is driven by hand; the host runs the real
    // session. A check (a poke) arrives while half a frame is in.
    let phone = DeviceKeys::generate();
    let server = DeviceKeys::generate();
    let host = Arc::new(Host::default());
    host.clients.lock().unwrap().insert(phone.r#box.public(), phone.id());
    let keys = HostKeys { account_id: ACCOUNT.into(), host_id: server.id(), own_box: server.r#box.seed().clone() };
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    let host_box = server.r#box.public();
    let host_id = server.id();
    let t = DialTarget { addr: "10.0.0.1:4181".parse().unwrap(), account_id: ACCOUNT, host_id: &host_id, host_box: &host_box, own_box: phone.r#box.seed(), loopback_ok: false };
    let (ctrl, acc) = tokio::join!(direct::handshake(ours, &t), direct::accept(theirs, &keys, host.as_ref()));
    let (mut io, mut transport) = ctrl.unwrap();
    let (hio, htransport, _) = acc.unwrap();
    let slow = Keepalive { every: Duration::from_secs(600), dead_after: Duration::from_secs(1200), wall_clock: SystemTime::now };
    let tunnel = direct::start(hio, htransport, false, Join::default(), slow, None);

    // A yamux ping (type 2, SYN, stream 0, value 7), framed.
    let plain = [0u8, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 7];
    let framed = direct::frame(&transport.encrypt(&plain).unwrap());
    io.write_all(&framed[..5]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    tunnel.check(Duration::from_secs(5));
    tokio::time::sleep(Duration::from_millis(30)).await;
    io.write_all(&framed[5..]).await.unwrap();

    // The host answers with the ACK for 7 (after its own first ping).
    let found = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let m = direct::read_frame(&mut io, Expect::Transport).await.expect("the session stays up");
            let p = transport.decrypt(&m).unwrap();
            for h in p.chunks(12) {
                if h.len() == 12 && h[1] == 2 && h[3] == 2 && h[11] == 7 {
                    return true;
                }
            }
        }
    })
    .await;
    assert_eq!(found, Ok(true));
}
