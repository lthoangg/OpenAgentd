//! Relay sessions (the API's "Relay"; spec section 5): the host's presence
//! socket, one data socket per session, the Noise IK handshake on it, flow
//! control acks and pause/resume, and a yamux session inside.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use futures_util::{SinkExt, StreamExt};
use reqwest::header::{CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::account_state::{self, AccountProblem};
use crate::api::{ApiError, Cloud};
use crate::encoding::b64;
use crate::keys::random_bytes;
use crate::mux::{Session, Stream};
use crate::noise::{self, Initiator, Responder, Transport, MAX_PLAINTEXT};

/// Ack after this many received bytes…
pub const ACK_BYTES: usize = 256 * 1024;
/// …or after this long without new bytes.
pub const ACK_IDLE: Duration = Duration::from_millis(500);
/// WebSocket pings from the device keep sockets alive.
pub const PING_EVERY: Duration = Duration::from_secs(25);
/// The text keepalive (`tunnel.md` section 5): every relay socket also
/// sends this every [`PING_EVERY`]. The relay answers [`TEXT_PONG`] itself,
/// so presence tells it a host is there (protocol pings never reach it),
/// and a quiet data socket has a frame to count even where no protocol
/// pong comes back.
pub const TEXT_PING: &str = "ping";
pub const TEXT_PONG: &str = "pong";
/// What a relay from before the text keepalive closes a socket with.
const UNSUPPORTED_DATA: u16 = 1003;
/// A socket that brought no frame at all (not even a pong) for this long
/// is dead: two missed pongs and a margin. After Wi-Fi changes or a sleep
/// a socket can stay half open, with nothing to say it closed.
pub const DEAD_AFTER: Duration = Duration::from_secs(60);
/// Largest WebSocket message the relay forwards.
const MAX_WS_MESSAGE: usize = 1024 * 1024;
/// Longest wait to open a relay socket: the relay token, the upgrade
/// request and its answer. A network that swallows packets would otherwise
/// leave the status on "Connecting" for good.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest wait for `paired`. The relay ends an offer nobody joins after 30
/// seconds (4004); a little more lets that answer arrive first.
pub const PAIR_TIMEOUT: Duration = Duration::from_secs(35);
/// Longest wait for the Noise handshake once paired.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a socket has to answer a ping sent because the app came back
/// to the front or the network changed ([`Tunnel::check`]).
pub const CHECK_WITHIN: Duration = Duration::from_secs(3);

/// How long a sender holds the first waiting byte for more to join it
/// (spec section 5.4).
pub const JOIN_HOLD: Duration = Duration::from_millis(2);
/// Small messages (below a full Noise message) a sender may send back to
/// back before [`SMALL_PER_SECOND`] applies (spec section 5.4).
pub const SMALL_BURST: u32 = 8;
/// Small messages a second once the burst is spent.
pub const SMALL_PER_SECOND: u32 = 20;

/// Presence replaced by a newer socket: another copy of this host (same
/// keys) connected.
pub const CLOSE_REPLACED: u16 = 4000;
/// The host's daily relay allowance is used up.
pub const CLOSE_QUOTA: u16 = 4010;
/// The relay ended the session because the other side sent text pings and
/// then none for 70 seconds: it went away without a close. Reconnect at
/// once; a relay from before this code never sends it.
pub const CLOSE_SILENT: u16 = 4013;

type Ws = WebSocketStream<reqwest::Upgraded>;

/// Why a socket could not be opened, or closed.
#[derive(Debug, Clone, PartialEq)]
pub enum RelayError {
    /// The upgrade was refused with an API error (`host_offline`, …).
    Refused(ApiError),
    /// The socket closed with this code.
    Closed(u16),
    /// The other side failed the Noise handshake, or its key is not the one
    /// in the verified roster.
    Handshake,
    Network,
    /// Opening, pairing or the handshake took too long.
    TimedOut,
}

impl RelayError {
    /// The account problem this names, if any.
    pub fn problem(&self) -> Option<AccountProblem> {
        match self {
            RelayError::Refused(e) => e.problem(),
            RelayError::Closed(code) => account_state::from_close_code(*code),
            _ => None,
        }
    }

    /// Another copy of this host took its presence over (close 4000).
    pub fn replaced(&self) -> bool {
        *self == RelayError::Closed(CLOSE_REPLACED)
    }

    /// The host's daily relay allowance is used up: `Some(paused_until)`
    /// (Unix ms, `None` when the relay did not say), from a refused upgrade
    /// or token (`quota_exhausted`) or a close with 4010.
    pub fn paused(&self) -> Option<Option<u64>> {
        match self {
            RelayError::Refused(e) if e.is("quota_exhausted") => Some(e.body.as_ref().and_then(|b| b.get("paused_until")).and_then(|v| v.as_u64())),
            RelayError::Closed(CLOSE_QUOTA) => Some(None),
            _ => None,
        }
    }
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayError::Refused(e) => write!(f, "relay refused: {e}"),
            RelayError::Closed(c) => write!(f, "relay closed ({c})"),
            RelayError::Handshake => f.write_str("relay handshake failed"),
            RelayError::Network => f.write_str("relay unreachable"),
            RelayError::TimedOut => f.write_str("relay timed out"),
        }
    }
}

impl std::error::Error for RelayError {}

/// An HTTP/1.1-only client: a WebSocket upgrade cannot happen on HTTP/2.
/// Keep one per process (or per account) and pass clones, so the TLS
/// sessions and connections it pools are reused.
pub fn http1_client() -> reqwest::Client {
    reqwest::Client::builder().http1_only().connect_timeout(Duration::from_secs(15)).build().expect("an HTTP client")
}

/// Opens a relay WebSocket at `path` with the client's relay token (in the
/// `Authorization` header, never the URL), within [`OPEN_TIMEOUT`].
pub async fn open_socket(cloud: &Cloud, http1: &reqwest::Client, path: &str) -> Result<Ws, RelayError> {
    open_socket_within(cloud, http1, path, OPEN_TIMEOUT).await
}

async fn open_socket_within(cloud: &Cloud, http1: &reqwest::Client, path: &str, limit: Duration) -> Result<Ws, RelayError> {
    tokio::time::timeout(limit, open_socket_now(cloud, http1, path)).await.unwrap_or(Err(RelayError::TimedOut))
}

async fn open_socket_now(cloud: &Cloud, http1: &reqwest::Client, path: &str) -> Result<Ws, RelayError> {
    let token = cloud.relay_token().await.map_err(RelayError::Refused)?;
    match upgrade(cloud, http1, path, &token.token).await {
        // The token in use was refused (expired early, invalidated, or this
        // device revoked): drop it and try once more with a new one.
        Err(RelayError::Refused(e)) if e.status == 401 => {
            cloud.forget_relay_token_if(&token.token);
            let token = cloud.relay_token().await.map_err(RelayError::Refused)?;
            upgrade(cloud, http1, path, &token.token).await
        }
        other => other,
    }
}

async fn upgrade(cloud: &Cloud, http1: &reqwest::Client, path: &str, token: &crate::api::Secret) -> Result<Ws, RelayError> {
    let key = generate_key();
    let resp = http1
        .get(format!("{}{}", cloud.endpoints.api, path))
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header(SEC_WEBSOCKET_VERSION, "13")
        .header(SEC_WEBSOCKET_KEY, &key)
        .bearer_auth(token.expose())
        .send()
        .await
        .map_err(|_| RelayError::Network)?;
    if resp.status().as_u16() != 101 {
        let status = resp.status().as_u16();
        let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
        // An error body is read up to the API's cap; a larger one is dropped.
        let body: Option<Value> = crate::api::read_body(resp).await.ok().and_then(|b| serde_json::from_slice(&b).ok());
        let code = body.as_ref().and_then(|b| b.get("error")).and_then(|e| e.as_str()).unwrap_or("unknown").to_string();
        return Err(RelayError::Refused(ApiError { status, code, body, retry_after }));
    }
    let expected = derive_accept_key(key.as_bytes());
    if resp.headers().get(SEC_WEBSOCKET_ACCEPT).and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return Err(RelayError::Network);
    }
    let upgraded = resp.upgrade().await.map_err(|_| RelayError::Network)?;
    let config = WebSocketConfig::default().max_message_size(Some(MAX_WS_MESSAGE)).max_frame_size(Some(MAX_WS_MESSAGE));
    Ok(WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await)
}

fn close_code(frame: Option<&CloseFrame>) -> u16 {
    frame.map(|f| u16::from(f.code)).unwrap_or(1005)
}

/// `step`, or [`RelayError::TimedOut`] once `limit` passes.
async fn within<T>(limit: Duration, step: impl std::future::Future<Output = Result<T, RelayError>>) -> Result<T, RelayError> {
    tokio::time::timeout(limit, step).await.unwrap_or(Err(RelayError::TimedOut))
}

async fn close(ws: &mut Ws, code: u16, reason: &'static str) {
    let _ = ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
}

/// Waits for `{"type":"paired"}`; pause/resume before it are harmless.
async fn await_paired(ws: &mut Ws) -> Result<(), RelayError> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or_default();
                match v["type"].as_str() {
                    Some("paired") => return Ok(()),
                    Some("pause") | Some("resume") => continue,
                    _ => return Err(RelayError::Handshake),
                }
            }
            Some(Ok(Message::Close(f))) => return Err(RelayError::Closed(close_code(f.as_ref()))),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(_)) => return Err(RelayError::Handshake),
            Some(Err(_)) | None => return Err(RelayError::Network),
        }
    }
}

/// The next binary message (the handshake), skipping pause/resume.
async fn next_binary(ws: &mut Ws) -> Result<Vec<u8>, RelayError> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Binary(b))) => return Ok(b.to_vec()),
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or_default();
                if !matches!(v["type"].as_str(), Some("pause") | Some("resume")) {
                    return Err(RelayError::Handshake);
                }
            }
            Some(Ok(Message::Close(f))) => return Err(RelayError::Closed(close_code(f.as_ref()))),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Err(RelayError::Network),
        }
    }
}

/// How long a tunnel holds the first waiting byte for more writes to join
/// it (spec section 5.4: [`JOIN_HOLD`], or until 65,519 bytes wait,
/// whichever comes first). Small messages are also kept to
/// [`SMALL_PER_SECOND`] after a burst of [`SMALL_BURST`]; see [`SendRule`].
#[derive(Debug, Clone, Copy)]
pub struct Join(pub Duration);

impl Default for Join {
    fn default() -> Self {
        Join(JOIN_HOLD)
    }
}

/// When a sender sends what waits (spec section 5.4): after the hold, a
/// small message only when the rate allows it (a token bucket of
/// [`SMALL_BURST`], refilled at [`SMALL_PER_SECOND`]); a full message at
/// once, without counting. The rule is local to the sender, so devices with
/// and without it work together.
#[derive(Debug, Clone, Copy)]
pub struct SendRule {
    hold: Duration,
    tokens: f64,
    at: tokio::time::Instant,
    /// No rate limit (a direct session: there is no relay allowance).
    unlimited: bool,
}

/// What a sender does with the bytes that wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flush {
    /// A full message: send it now.
    Full,
    /// A small message: send it now (a token was spent).
    Small,
    /// Keep joining until then.
    At(tokio::time::Instant),
    /// Nothing waits.
    Idle,
}

impl SendRule {
    pub fn new(join: Join, now: tokio::time::Instant) -> SendRule {
        SendRule { hold: join.0, tokens: SMALL_BURST as f64, at: now, unlimited: false }
    }

    /// The hold of `join` without the rate limit (spec section 5.5).
    pub fn unlimited(join: Join, now: tokio::time::Instant) -> SendRule {
        SendRule { unlimited: true, ..SendRule::new(join, now) }
    }

    fn refill(&mut self, now: tokio::time::Instant) {
        let gained = now.saturating_duration_since(self.at).as_secs_f64() * SMALL_PER_SECOND as f64;
        self.tokens = (self.tokens + gained).min(SMALL_BURST as f64);
        self.at = now;
    }

    /// `queued` bytes wait, the oldest since `since`.
    pub fn decide(&mut self, now: tokio::time::Instant, queued: usize, since: tokio::time::Instant) -> Flush {
        if queued >= MAX_PLAINTEXT {
            return Flush::Full;
        }
        if queued == 0 {
            return Flush::Idle;
        }
        if self.unlimited {
            let held = since + self.hold;
            return if now >= held { Flush::Small } else { Flush::At(held) };
        }
        self.refill(now);
        let held = since + self.hold;
        if now >= held && self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return Flush::Small;
        }
        let allowed = if self.tokens >= 1.0 { now } else { now + Duration::from_secs_f64((1.0 - self.tokens) / SMALL_PER_SECOND as f64) };
        Flush::At(held.max(allowed))
    }
}

/// How a relay socket (presence or a data tunnel) keeps alive and notices
/// it died.
#[derive(Debug, Clone, Copy)]
pub struct Keepalive {
    /// How often it pings (the first ping goes out as soon as it opens).
    pub every: Duration,
    /// No frame for this long, or a wall-clock jump this long, ends it.
    pub dead_after: Duration,
    /// The wall clock a tunnel checks for a sleep (see [`HostOptions`]).
    pub wall_clock: fn() -> SystemTime,
}

impl Default for Keepalive {
    fn default() -> Self {
        Keepalive { every: PING_EVERY, dead_after: DEAD_AFTER, wall_clock: SystemTime::now }
    }
}

/// How [`host_with`] runs.
pub struct HostOptions {
    pub join: Join,
    pub keepalive: Keepalive,
    /// The wall clock. The monotonic clock stands still while macOS or iOS
    /// sleeps; the wall clock does not, so a jump says the machine slept.
    pub wall_clock: fn() -> SystemTime,
    /// Set to true once the presence socket is open, and back to false when
    /// presence ends: what a status can say "online" from.
    pub opened: Option<watch::Sender<bool>>,
    /// Longest wait to open the presence socket ([`OPEN_TIMEOUT`]).
    pub open_timeout: Duration,
}

impl Default for HostOptions {
    fn default() -> Self {
        HostOptions { join: Join::default(), keepalive: Keepalive::default(), wall_clock: SystemTime::now, opened: None, open_timeout: OPEN_TIMEOUT }
    }
}

/// Says presence is open while it lives, and closed once dropped (also when
/// the task running it is aborted).
struct OpenFlag(Option<watch::Sender<bool>>);

impl OpenFlag {
    fn set(&self) {
        if let Some(tx) = &self.0 {
            tx.send_replace(true);
        }
    }
}

impl Drop for OpenFlag {
    fn drop(&mut self) {
        if let Some(tx) = &self.0 {
            tx.send_replace(false);
        }
    }
}

/// A paired, handshaken data socket carrying one yamux session.
pub struct Tunnel {
    pub session: Session,
    closer: mpsc::UnboundedSender<u16>,
    /// Resolves with the close code once the socket closes.
    pub closed: watch::Receiver<Option<u16>>,
    /// How it ended, once it has (for the logs).
    pub ended: watch::Receiver<Option<TunnelEnd>>,
    ping_now: mpsc::UnboundedSender<()>,
    probe: Arc<Probe>,
    /// Go Away carries the close reason (a direct session, spec 5.5).
    go_away_reasons: bool,
}

/// A check in progress ([`Tunnel::check`]): the reader ends the tunnel
/// unless a frame comes in by the deadline.
#[derive(Default)]
pub(crate) struct Probe {
    deadline: Mutex<Option<tokio::time::Instant>>,
    pub(crate) changed: tokio::sync::Notify,
}

impl Probe {
    pub(crate) fn deadline(&self) -> Option<tokio::time::Instant> {
        *self.deadline.lock().expect("probe lock")
    }

    pub(crate) fn expect_by(&self, by: tokio::time::Instant) {
        let mut d = self.deadline.lock().expect("probe lock");
        if d.is_none_or(|old| by < old) {
            *d = Some(by);
        }
        drop(d);
        self.changed.notify_one();
    }

    pub(crate) fn answered(&self) {
        self.deadline.lock().expect("probe lock").take();
    }
}

/// The keepalive: a protocol ping, which keeps the socket open on any
/// relay, and the text ping the relay answers itself (a frame to count
/// while the session has nothing to say), unless an older relay refused it.
async fn send_pings<S>(sink: &mut S, text_off: &AtomicBool) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    sink.send(Message::Ping(Vec::new().into())).await.map_err(|_| ())?;
    if !text_off.load(Ordering::Relaxed) {
        sink.send(Message::Text(TEXT_PING.into())).await.map_err(|_| ())?;
    }
    Ok(())
}

/// Why a tunnel ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndCause {
    /// This side closed it (revocation, sign-out, stop).
    Local,
    /// A close frame came from the other end or the relay.
    Closed,
    /// No frame came for the keepalive's `dead_after`: this side gave the
    /// socket up.
    Deadline,
    /// The socket failed or ended without a close frame.
    Network,
    /// A message that did not decrypt, or broke the mux.
    Protocol,
}

impl EndCause {
    pub fn as_str(self) -> &'static str {
        match self {
            EndCause::Local => "local",
            EndCause::Closed => "closed",
            EndCause::Deadline => "deadline",
            EndCause::Network => "network",
            EndCause::Protocol => "protocol",
        }
    }
}

/// How a tunnel ended: what a log line says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TunnelEnd {
    pub cause: EndCause,
    pub code: u16,
    /// How long the tunnel was open.
    pub lived: Duration,
    /// How long before the end the last frame came in.
    pub quiet: Duration,
    /// Whether the relay answered a text `ping` on this socket.
    pub ponged: bool,
}

impl fmt::Display for TunnelEnd {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "cause={} code={} secs={:.1} quiet_secs={:.1} ponged={}", self.cause.as_str(), self.code, self.lived.as_secs_f64(), self.quiet.as_secs_f64(), self.ponged)
    }
}

impl Tunnel {
    /// `text_off` is the client's text keepalive switch
    /// ([`Cloud::turn_off_text_keepalive`]).
    fn start(ws: Ws, transport: Transport, client: bool, join: Join, keepalive: Keepalive, text_off: Arc<AtomicBool>) -> Tunnel {
        let (session, outbound) = Session::new(client);
        let (closer, mut close_rx) = mpsc::unbounded_channel::<u16>();
        let (closed_tx, closed) = watch::channel(None);
        let (ended_tx, ended) = watch::channel(None);
        let (ping_now, mut ping_rx) = mpsc::unbounded_channel::<()>();
        let probe = Arc::new(Probe::default());
        // The code this side closed with, if it did (0: it did not).
        let local = Arc::new(AtomicU16::new(0));
        let started = Instant::now();
        let transport = Arc::new(Mutex::new(transport));
        let (mut sink, mut stream) = ws.split();
        let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<Message>();
        let (pause_tx, mut pause_rx) = watch::channel(false);

        // Writer: sends what the session queued by the send rule, encrypted;
        // holds data while paused, but still pings, acks and closes.
        let t_out = transport.clone();
        let local_out = local.clone();
        let text_out = text_off.clone();
        let writer = tokio::spawn(async move {
            // The first tick is at once: a socket pings as soon as it is up.
            let mut ping = tokio::time::interval(keepalive.every);
            ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut rule = SendRule::new(join, tokio::time::Instant::now());
            // When the oldest waiting byte started waiting.
            let mut since: Option<tokio::time::Instant> = None;
            let mut paused = false;
            loop {
                let mut wake = None;
                if !paused {
                    let now = tokio::time::Instant::now();
                    let queued = outbound.queued();
                    if queued == 0 {
                        since = None;
                        if outbound.is_done() {
                            return;
                        }
                    }
                    let first = *since.get_or_insert(now);
                    match rule.decide(now, queued, first) {
                        Flush::Full | Flush::Small => {
                            let plain = outbound.take(MAX_PLAINTEXT);
                            let msg = match t_out.lock().expect("noise lock").encrypt(&plain) {
                                Ok(m) => m,
                                Err(_) => return,
                            };
                            if sink.send(Message::Binary(msg.into())).await.is_err() {
                                return;
                            }
                            // What is left waited already; it goes by the rate.
                            since = (outbound.queued() > 0).then_some(first);
                            continue;
                        }
                        Flush::At(at) => wake = Some(at),
                        Flush::Idle => since = None,
                    }
                }
                let sleep = async {
                    match wake {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    biased;
                    code = close_rx.recv() => {
                        let code = code.unwrap_or(1000);
                        local_out.store(code, Ordering::Relaxed);
                        let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() }))).await;
                        return;
                    }
                    Some(msg) = ctl_rx.recv() => {
                        if sink.send(msg).await.is_err() { return; }
                    }
                    r = pause_rx.changed() => {
                        if r.is_err() { return; }
                        paused = *pause_rx.borrow_and_update();
                    }
                    Some(()) = ping_rx.recv() => {
                        if send_pings(&mut sink, &text_out).await.is_err() { return; }
                    }
                    _ = ping.tick() => {
                        if send_pings(&mut sink, &text_out).await.is_err() { return; }
                    }
                    _ = outbound.pushed(), if !paused => {}
                    _ = sleep => {}
                }
            }
        });

        // Reader: decrypts into the session, counts bytes for acks.
        let s_in = session.clone();
        let closer_in = closer.clone();
        let probe_in = probe.clone();
        tokio::spawn(async move {
            let mut unacked = 0usize;
            let mut code = 1006u16;
            let mut cause = EndCause::Network;
            let mut ponged = false;
            let text_keepalive = !text_off.load(Ordering::Relaxed);
            // Pings go out every `keepalive.every` (the writer); with no
            // frame back for `keepalive.dead_after` the socket is dead.
            let mut last_in = tokio::time::Instant::now();
            // The monotonic clock stands still while the machine sleeps; a
            // wall-clock gap longer than the deadline says it slept, and the
            // other side (and the relay) gave the session up meanwhile.
            let mut wall = (keepalive.wall_clock)();
            loop {
                let now_wall = (keepalive.wall_clock)();
                if now_wall.duration_since(wall).is_ok_and(|gap| gap > keepalive.dead_after) {
                    cause = EndCause::Deadline;
                    break;
                }
                wall = now_wall;
                let now = tokio::time::Instant::now();
                let dead_at = last_in + keepalive.dead_after;
                let checked_by = probe_in.deadline();
                let mut wake = dead_at.min(now + keepalive.every);
                if unacked > 0 {
                    wake = wake.min(last_in + ACK_IDLE);
                }
                if let Some(by) = checked_by {
                    wake = wake.min(by);
                }
                let changed = probe_in.changed.notified();
                let next = tokio::select! {
                    n = tokio::time::timeout_at(wake, stream.next()) => n,
                    _ = changed => continue,
                };
                let next = match next {
                    Ok(n) => n,
                    Err(_) => {
                        let now = tokio::time::Instant::now();
                        if now >= dead_at || checked_by.is_some_and(|by| now >= by) {
                            cause = EndCause::Deadline;
                            break;
                        }
                        if unacked > 0 && now >= last_in + ACK_IDLE {
                            let _ = ctl_tx.send(Message::Text(json!({"type":"ack","bytes":unacked}).to_string().into()));
                            unacked = 0;
                        }
                        continue;
                    }
                };
                last_in = tokio::time::Instant::now();
                probe_in.answered();
                match next {
                    // The keepalive's answer: not a JSON message.
                    Some(Ok(Message::Text(t))) if t.as_str() == TEXT_PONG => ponged = true,
                    Some(Ok(Message::Binary(b))) => {
                        unacked += b.len();
                        if unacked >= ACK_BYTES {
                            let _ = ctl_tx.send(Message::Text(json!({"type":"ack","bytes":unacked}).to_string().into()));
                            unacked = 0;
                        }
                        let plain = transport.lock().expect("noise lock").decrypt(&b);
                        match plain {
                            Ok(p) => {
                                if s_in.receive(&p).is_err() {
                                    let _ = closer_in.send(4002);
                                    code = 4002;
                                    cause = EndCause::Protocol;
                                    break;
                                }
                            }
                            Err(_) => {
                                let _ = closer_in.send(4002);
                                code = 4002;
                                cause = EndCause::Protocol;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap_or_default();
                        match v["type"].as_str() {
                            Some("pause") => {
                                let _ = pause_tx.send(true);
                            }
                            Some("resume") => {
                                let _ = pause_tx.send(false);
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(f))) => {
                        code = close_code(f.as_ref());
                        cause = EndCause::Closed;
                        // A relay from before the text keepalive refuses the
                        // text ping: protocol pings only from now on (the
                        // caller reconnects as usual). After a `pong`, 1003 is
                        // a real protocol error.
                        if code == UNSUPPORTED_DATA && text_keepalive && !ponged {
                            text_off.store(true, Ordering::Relaxed);
                        }
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
            let by_us = local.load(Ordering::Relaxed);
            if by_us != 0 && matches!(cause, EndCause::Closed | EndCause::Network) {
                (cause, code) = (EndCause::Local, by_us);
            }
            s_in.close();
            let _ = pause_tx.send(false);
            let end = TunnelEnd { cause, code, lived: started.elapsed(), quiet: last_in.elapsed(), ponged };
            let _ = ended_tx.send(Some(end));
            let _ = closed_tx.send(Some(code));
            writer.abort();
        });
        Tunnel { session, closer, closed, ended, ping_now, probe, go_away_reasons: false }
    }

    /// Pings now, and ends the tunnel (as a missed deadline) unless a frame
    /// comes back within `within`: after the app came back to the front or
    /// the network changed, a socket can be dead with nothing to say so.
    pub fn check(&self, within: Duration) {
        self.probe.expect_by(tokio::time::Instant::now() + within);
        let _ = self.ping_now.send(());
    }

    /// Whether the tunnel ended.
    pub fn is_closed(&self) -> bool {
        self.closed.borrow().is_some() || self.session.is_closed()
    }

    /// A tunnel over another carrier (spec section 5.5): its own tasks
    /// feed these channels.
    pub(crate) fn from_parts(
        session: Session,
        closer: mpsc::UnboundedSender<u16>,
        closed: watch::Receiver<Option<u16>>,
        ended: watch::Receiver<Option<TunnelEnd>>,
        ping_now: mpsc::UnboundedSender<()>,
        probe: Arc<Probe>,
    ) -> Tunnel {
        Tunnel { session, closer, closed, ended, ping_now, probe, go_away_reasons: true }
    }

    /// Go Away, then close the socket with `code`. On a direct session the
    /// Go Away carries the reason (spec section 5.5).
    pub fn end(&self, code: u16) {
        if self.go_away_reasons {
            self.session.go_away_with(go_away_reason(code));
        } else {
            self.session.go_away();
        }
        let _ = self.closer.send(code);
    }

    /// A handle that closes this tunnel from elsewhere (revocation).
    pub fn closer(&self) -> Closer {
        Closer(self.closer.clone())
    }

    pub async fn wait_closed(&mut self) -> u16 {
        loop {
            if let Some(code) = *self.closed.borrow() {
                return code;
            }
            if self.closed.changed().await.is_err() {
                return 1006;
            }
        }
    }

    /// How the tunnel ended, once it has.
    pub async fn wait_ended(&mut self) -> Option<TunnelEnd> {
        self.ended.wait_for(Option::is_some).await.ok().and_then(|e| *e)
    }
}

/// The Go Away reason of a direct session for a close code (spec section
/// 5.5): removed and account closing keep their code; anything else is a
/// normal end.
pub fn go_away_reason(code: u16) -> u32 {
    match code {
        4001 | 4011 => code as u32,
        _ => 0,
    }
}

/// The close code a direct session's Go Away reason stands for.
pub fn close_code_of(reason: u32) -> u16 {
    match reason {
        0 => 1000,
        1 | 2 => 4002,
        4001 => 4001,
        4011 => 4011,
        _ => 1000,
    }
}

/// Closes a tunnel.
#[derive(Clone)]
pub struct Closer(mpsc::UnboundedSender<u16>);

impl Closer {
    pub fn close(&self, code: u16) {
        let _ = self.0.send(code);
    }
}

/// The controller side: opens a session to `host_id`, whose `box` key
/// comes from the controller's verified roster.
pub async fn connect(cloud: &Cloud, http1: &reqwest::Client, host_id: &str, host_box: &[u8; 32], join: Join) -> Result<Tunnel, RelayError> {
    connect_with(cloud, http1, host_id, host_box, join, Keepalive::default()).await
}

/// [`connect`] with the keepalive timings chosen.
pub async fn connect_with(cloud: &Cloud, http1: &reqwest::Client, host_id: &str, host_box: &[u8; 32], join: Join, keepalive: Keepalive) -> Result<Tunnel, RelayError> {
    connect_within(cloud, http1, host_id, host_box, join, keepalive, Waits::default()).await
}

/// How long each step of opening a session may take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Waits {
    /// The relay token and the upgrade.
    pub open: Duration,
    /// `paired`.
    pub pair: Duration,
    /// The Noise handshake.
    pub handshake: Duration,
}

impl Waits {
    /// While someone waits for the session: 10 s at most per step, and the
    /// caller tries again by itself (a [`crate::link::Link`]).
    pub const INTERACTIVE: Waits = Waits { open: Duration::from_secs(10), pair: Duration::from_secs(10), handshake: Duration::from_secs(10) };
}

impl Default for Waits {
    fn default() -> Self {
        Waits { open: OPEN_TIMEOUT, pair: PAIR_TIMEOUT, handshake: HANDSHAKE_TIMEOUT }
    }
}

/// [`connect_with`] with the waits chosen.
pub async fn connect_within(
    cloud: &Cloud,
    http1: &reqwest::Client,
    host_id: &str,
    host_box: &[u8; 32],
    join: Join,
    keepalive: Keepalive,
    waits: Waits,
) -> Result<Tunnel, RelayError> {
    let account = cloud.account_id.clone().ok_or(RelayError::Handshake)?;
    let session_id = b64(&random_bytes::<16>());
    let mut ws = open_socket_within(cloud, http1, &format!("/v1/relay/host/{host_id}/data/{session_id}"), waits.open).await?;
    within(waits.pair, await_paired(&mut ws)).await?;
    let prologue = noise::prologue(&account, &session_id, &cloud.device_id(), host_id);
    let mut init = Initiator::new(cloud.keys.r#box.seed(), host_box, &prologue, None).map_err(|_| RelayError::Handshake)?;
    let m1 = init.write_message1().map_err(|_| RelayError::Handshake)?;
    let m2 = within(waits.handshake, async {
        ws.send(Message::Binary(m1.into())).await.map_err(|_| RelayError::Network)?;
        next_binary(&mut ws).await
    })
    .await?;
    match init.read_message2(&m2) {
        Ok(t) => Ok(Tunnel::start(ws, t, true, join, keepalive, cloud.text_keepalive_switch())),
        Err(_) => {
            close(&mut ws, 4002, "handshake").await;
            Err(RelayError::Handshake)
        }
    }
}

/// What a host decides and does, from its verified roster.
pub trait HostHandler: Send + Sync + 'static {
    /// The `box` key of an active device with `client: true` in the host's
    /// verified roster (`Member::controller_box`), or `None` to refuse it.
    fn controller_box(&self, device_id: &str) -> Option<[u8; 32]>;
    /// Serves one stream (one HTTP exchange) from `from`.
    fn serve(&self, stream: Stream, from: String);
    /// The relay says the roster or floor changed.
    fn on_roster(&self, version: u64, revoked: Vec<String>);
    /// A session from `from` ended (for the logs).
    fn on_session_end(&self, _from: &str, _end: &TunnelEnd) {}
    /// Direct sessions (spec section 5.5): the device whose `box` key is
    /// `static_key`, if it may open a session now (active, `client`, not
    /// departed, and direct sessions allowed on this host). The host's one
    /// admission question for a key it did not expect.
    fn admit_direct(&self, _static_key: &[u8; 32]) -> Option<String> {
        None
    }
}

/// Open sessions by controller, so a removed device loses them at once.
#[derive(Default, Clone)]
pub struct Sessions(Arc<Mutex<HashMap<String, Vec<Closer>>>>);

impl Sessions {
    pub(crate) fn add(&self, device: &str, closer: Closer) {
        self.0.lock().expect("sessions lock").entry(device.to_string()).or_default().push(closer);
    }

    /// Adds a session within limits: at most `per_device` for `device`
    /// (the oldest is closed with `close_oldest`) and `total` in all.
    /// Returns false, adding nothing, when `total` is reached.
    pub(crate) fn add_capped(&self, device: &str, closer: Closer, per_device: usize, total: usize, close_oldest: u16) -> bool {
        let mut map = self.0.lock().expect("sessions lock");
        let list = map.entry(device.to_string()).or_default();
        if list.len() >= per_device {
            list.remove(0).close(close_oldest);
        }
        let count: usize = map.values().map(Vec::len).sum();
        if count >= total {
            return false;
        }
        map.entry(device.to_string()).or_default().push(closer);
        true
    }

    /// Forgets a session that ended.
    pub(crate) fn remove(&self, device: &str, closer: &Closer) {
        let mut map = self.0.lock().expect("sessions lock");
        if let Some(list) = map.get_mut(device) {
            list.retain(|c| !c.0.same_channel(&closer.0));
            if list.is_empty() {
                map.remove(device);
            }
        }
    }

    /// Closes every session of `device` with 4001.
    pub fn revoke(&self, device: &str) {
        if let Some(list) = self.0.lock().expect("sessions lock").remove(device) {
            for c in list {
                c.close(4001);
            }
        }
    }

    pub fn close_all(&self, code: u16) {
        for (_, list) in self.0.lock().expect("sessions lock").drain() {
            for c in list {
                c.close(code);
            }
        }
    }

    pub fn count(&self) -> usize {
        self.0.lock().expect("sessions lock").values().map(Vec::len).sum()
    }
}

/// Most entries read from a presence `revoked` list. The relay repeats a
/// device for about 16 minutes after it goes, so a real list stays short.
const MAX_REVOKED: usize = 16;

/// The device ids of a presence message's `revoked` list: id-shaped
/// entries only, from the newest [`MAX_REVOKED`] entries of the list (the
/// rest is ignored). The relay sends at most [`MAX_REVOKED`], newest first;
/// a relay from before that sent every recent one, oldest first, so from a
/// longer list the last [`MAX_REVOKED`] are the newest.
fn revoked_list(v: &Value) -> Vec<String> {
    let Some(list) = v.as_array() else { return Vec::new() };
    let newest = &list[list.len().saturating_sub(MAX_REVOKED)..];
    newest.iter().filter_map(Value::as_str).filter(|s| crate::keys::is_device_id(s)).map(String::from).collect()
}

/// The host side: holds the presence socket and serves each offer until
/// presence closes. Returns how it ended.
///
/// Paired sessions do not depend on presence: the relay keeps them open
/// when presence drops (it only ends offers nobody joined yet, with 4005),
/// so a presence blip or the daily presence recycle (4008) leaves them up,
/// and only new offers wait until presence is back. Presence ending closes
/// the sessions too only when every socket of this host is done for: this
/// host removed (4001), the account locked (4011, 4012), a stop, or a
/// machine that slept past the keepalive deadline (the other ends gave up).
pub async fn host(cloud: Arc<Cloud>, http1: reqwest::Client, handler: Arc<dyn HostHandler>, sessions: Sessions, join: Join, stop: oneshot::Receiver<()>) -> RelayError {
    host_with(cloud, http1, handler, sessions, stop, HostOptions { join, ..HostOptions::default() }).await
}

/// Whether a presence close with `code` ends this host's sessions too.
fn ends_sessions(code: u16) -> bool {
    matches!(code, 4001 | 4011 | 4012)
}

/// [`host`] with its timings and clock chosen.
pub async fn host_with(cloud: Arc<Cloud>, http1: reqwest::Client, handler: Arc<dyn HostHandler>, sessions: Sessions, stop: oneshot::Receiver<()>, opts: HostOptions) -> RelayError {
    let HostOptions { join, keepalive, wall_clock, opened, open_timeout } = opts;
    // The host's sessions watch the same clock for a sleep.
    let keepalive = Keepalive { wall_clock, ..keepalive };
    let opened = OpenFlag(opened);
    let path = format!("/v1/relay/host/{}/presence", cloud.device_id());
    let mut ws = match open_socket_within(&cloud, &http1, &path, open_timeout).await {
        Ok(ws) => ws,
        Err(e) => return e,
    };
    opened.set();
    // Text pings unless an older relay already refused one (once per client).
    let text_keepalive = cloud.text_keepalive();
    let mut ponged = false;
    // The first tick is at once: presence pings as soon as it is up.
    let mut ping = tokio::time::interval(keepalive.every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut stop = stop;
    let mut last_in = tokio::time::Instant::now();
    let mut wall = wall_clock();
    loop {
        // Between two turns of this loop at most `every` passes; a longer
        // wall-clock gap is a sleep the monotonic clock did not count.
        let now = wall_clock();
        if now.duration_since(wall).is_ok_and(|gap| gap > keepalive.dead_after) {
            // The machine slept past the deadline: the controllers have
            // given these sessions up already.
            sessions.close_all(1006);
            return RelayError::Network;
        }
        wall = now;
        tokio::select! {
            _ = &mut stop => {
                close(&mut ws, 1000, "stop").await;
                sessions.close_all(1000);
                return RelayError::Closed(1000);
            }
            // Presence went quiet: give it up so the caller opens a fresh
            // one. Paired sessions have their own keepalive.
            _ = tokio::time::sleep_until(last_in + keepalive.dead_after) => return RelayError::Network,
            _ = ping.tick() => {
                // The protocol ping keeps the socket alive on any relay.
                if ws.send(Message::Ping(Vec::new().into())).await.is_err() { return RelayError::Network; }
                if text_keepalive && ws.send(Message::Text(TEXT_PING.into())).await.is_err() { return RelayError::Network; }
            }
            msg = ws.next() => {
                if matches!(msg, Some(Ok(_))) {
                    last_in = tokio::time::Instant::now();
                }
                match msg {
                // The keepalive's answer: not a JSON message.
                Some(Ok(Message::Text(t))) if t.as_str() == TEXT_PONG => ponged = true,
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap_or_default();
                    match v["type"].as_str() {
                        Some("offer") => {
                            let (Some(sid), Some(from)) = (v["session_id"].as_str(), v["from"].as_str()) else { continue };
                            let (sid, from) = (sid.to_string(), from.to_string());
                            let (cloud, http1, handler, sessions) = (cloud.clone(), http1.clone(), handler.clone(), sessions.clone());
                            tokio::spawn(async move { let _ = join_session(&cloud, &http1, &sid, &from, handler, sessions, (join, keepalive)).await; });
                        }
                        Some("roster") => {
                            // The roster changed: the next socket gets a
                            // token for the new one.
                            cloud.forget_relay_token();
                            let revoked = revoked_list(&v["revoked"]);
                            for d in &revoked {
                                sessions.revoke(d);
                            }
                            handler.on_roster(v["version"].as_u64().unwrap_or(0), revoked);
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(f))) => {
                    let code = close_code(f.as_ref());
                    // An older relay refuses the text ping: stop sending it
                    // and reconnect as usual. After a `pong`, 1003 is a real
                    // protocol error, handled like any other close.
                    if code == UNSUPPORTED_DATA && text_keepalive && !ponged {
                        cloud.turn_off_text_keepalive();
                    }
                    if ends_sessions(code) {
                        sessions.close_all(code);
                    }
                    return RelayError::Closed(code);
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return RelayError::Network,
            }
            }
        }
    }
}

async fn join_session(
    cloud: &Cloud,
    http1: &reqwest::Client,
    session_id: &str,
    from: &str,
    handler: Arc<dyn HostHandler>,
    sessions: Sessions,
    (join, keepalive): (Join, Keepalive),
) -> Result<(), RelayError> {
    let known = handler.controller_box(from);
    let account = cloud.account_id.clone().ok_or(RelayError::Handshake)?;
    let mut ws = open_socket(cloud, http1, &format!("/v1/relay/host/{}/data/{session_id}", cloud.device_id())).await?;
    within(PAIR_TIMEOUT, await_paired(&mut ws)).await?;
    let prologue = noise::prologue(&account, session_id, from, &cloud.device_id());
    let mut resp = Responder::new(cloud.keys.r#box.seed(), &prologue, None).map_err(|_| RelayError::Handshake)?;
    let m1 = within(HANDSHAKE_TIMEOUT, next_binary(&mut ws)).await?;
    // The initiator must be the offer's device, with the box key our
    // roster lists, and still active.
    match (resp.read_message1(&m1), known) {
        (Ok(rs), Some(k)) if bool::from(subtle::ConstantTimeEq::ct_eq(&rs[..], &k[..])) => {}
        _ => {
            close(&mut ws, 4002, "handshake").await;
            return Err(RelayError::Handshake);
        }
    }
    let (m2, transport) = resp.write_message2().map_err(|_| RelayError::Handshake)?;
    within(HANDSHAKE_TIMEOUT, async { ws.send(Message::Binary(m2.into())).await.map_err(|_| RelayError::Network) }).await?;
    let mut tunnel = Tunnel::start(ws, transport, false, join, keepalive, cloud.text_keepalive_switch());
    let closer = tunnel.closer();
    sessions.add(from, closer.clone());
    // A removal between the handshake and `add` was missed by `revoke`.
    if handler.controller_box(from).is_none() {
        closer.close(4001);
    }
    let session = tunnel.session.clone();
    let from_owned = from.to_string();
    let h = handler.clone();
    let on_removed = closer.clone();
    tokio::spawn(async move {
        while let Some(stream) = session.accept().await {
            // Each new stream re-checks that the controller is still active.
            if h.controller_box(&from_owned).is_none() {
                on_removed.close(4001);
                break;
            }
            h.serve(stream, from_owned.clone());
        }
    });
    let end = tunnel.wait_ended().await;
    sessions.remove(from, &closer);
    if let Some(end) = &end {
        handler.on_session_end(from, end);
    }
    Err(RelayError::Closed(end.map_or(1006, |e| e.code)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Runs the send rule over `writes` (times after the start, in ms, of
    /// writes of `size` bytes each), as the writer does; returns the times
    /// at which messages leave.
    fn simulate(writes: &[f64], size: usize, until_ms: f64) -> Vec<f64> {
        let start = tokio::time::Instant::now();
        let at = |ms: f64| start + Duration::from_secs_f64(ms / 1000.0);
        let mut rule = SendRule::new(Join::default(), start);
        let (mut queued, mut since, mut sent) = (0usize, None::<f64>, Vec::new());
        let mut next = 0;
        let mut now = 0.0;
        while now <= until_ms {
            while next < writes.len() && writes[next] <= now {
                queued += size;
                since.get_or_insert(writes[next]);
                next += 1;
            }
            match since.map(|s| rule.decide(at(now), queued, at(s))) {
                Some(Flush::Full) => {
                    queued -= MAX_PLAINTEXT;
                    sent.push(now);
                    continue;
                }
                Some(Flush::Small) => {
                    queued = 0;
                    since = None;
                    sent.push(now);
                    continue;
                }
                _ => {}
            }
            now += 0.1;
        }
        sent
    }

    #[test]
    fn a_lone_write_leaves_after_the_hold() {
        let sent = simulate(&[0.0], 100, 100.0);
        assert_eq!(sent.len(), 1);
        assert!((2.0..2.2).contains(&sent[0]), "{sent:?}");
    }

    #[test]
    fn a_burst_of_small_writes_makes_at_most_nine_messages_in_50_ms() {
        // 20 writes, one every 2.5 ms: each would leave on its own.
        let writes: Vec<f64> = (0..20).map(|i| i as f64 * 2.5).collect();
        let sent = simulate(&writes, 100, 1000.0);
        let first_50 = sent.iter().filter(|&&t| t < 50.0).count();
        assert!(first_50 <= 9, "{sent:?}");
        assert!(first_50 >= 8, "the burst is spent first: {sent:?}");
    }

    #[test]
    fn a_long_run_of_small_writes_makes_20_messages_a_second() {
        let writes: Vec<f64> = (0..10_000).map(|i| i as f64).collect();
        let sent = simulate(&writes, 50, 10_000.0);
        // 8 at once, then 20 a second.
        let per_second = (sent.len() - SMALL_BURST as usize) as f64 / 10.0;
        assert!((19.0..=21.0).contains(&per_second), "{} messages", sent.len());
    }

    #[test]
    fn a_full_message_leaves_at_once_and_does_not_count() {
        let start = tokio::time::Instant::now();
        let mut rule = SendRule::new(Join::default(), start);
        for _ in 0..SMALL_BURST {
            assert_eq!(rule.decide(start + JOIN_HOLD, 10, start), Flush::Small);
        }
        assert!(matches!(rule.decide(start + JOIN_HOLD, 10, start), Flush::At(_)), "the burst is spent");
        for _ in 0..100 {
            assert_eq!(rule.decide(start, MAX_PLAINTEXT, start), Flush::Full);
        }
        // The next small one waits at most 50 ms.
        match rule.decide(start + JOIN_HOLD, 10, start) {
            Flush::At(at) => assert!(at - start <= Duration::from_millis(50) + JOIN_HOLD, "{:?}", at - start),
            other => panic!("{other:?}"),
        }
        assert_eq!(rule.decide(start, 0, start), Flush::Idle);
    }

    #[test]
    fn the_revoked_list_keeps_id_shaped_entries_from_the_newest_16() {
        let id = |i: u8| crate::encoding::b64(&[i; 16]);
        let mixed = json!([id(1), "not-an-id", 7, "x\ny", crate::encoding::b64(&[2; 17]), id(2)]);
        assert_eq!(revoked_list(&mixed), vec![id(1), id(2)]);
        // A relay that sends newest first sends at most 16: all are read.
        let newest_first: Vec<String> = (0..16).rev().map(id).collect();
        assert_eq!(revoked_list(&json!(newest_first)), newest_first);
        // A longer list comes from a relay that sends every recent one,
        // oldest first: its last 16 are the newest.
        let long: Vec<String> = (0..40).map(id).collect();
        assert_eq!(revoked_list(&json!(long)), long[24..].to_vec());
        // Junk entries count towards the cap: older entries are ignored.
        let mut padded = vec![json!(id(3))];
        padded.extend(vec![json!("junk"); 16]);
        assert!(revoked_list(&json!(padded)).is_empty());
        assert!(revoked_list(&json!({"a": 1})).is_empty());
    }

    #[test]
    fn only_removal_and_a_locked_account_end_the_sessions_with_presence() {
        for code in [4001, 4011, 4012] {
            assert!(ends_sessions(code), "{code}");
        }
        // Replaced, recycled after 24 h, over the allowance (the relay
        // closes those sessions itself), and any blip: sessions stay.
        for code in [1000, 1001, 1003, 1006, 4000, 4008, 4009, 4010] {
            assert!(!ends_sessions(code), "{code}");
        }
    }

    #[test]
    fn presence_ends_say_replaced_and_paused() {
        assert!(RelayError::Closed(4000).replaced());
        assert!(!RelayError::Closed(4001).replaced() && !RelayError::Network.replaced());
        assert_eq!(RelayError::Closed(4010).paused(), Some(None));
        let refused = |code: &str, body: serde_json::Value| RelayError::Refused(ApiError { status: 429, code: code.into(), body: Some(body), retry_after: None });
        assert_eq!(refused("quota_exhausted", json!({"error": "quota_exhausted", "paused_until": 1_800_000_000_000u64})).paused(), Some(Some(1_800_000_000_000)));
        assert_eq!(refused("rate_limited", json!({"error": "rate_limited"})).paused(), None);
        assert_eq!(RelayError::Closed(4008).paused(), None);
    }
}
