//! Direct sessions on the home network (spec section 5.5): the same Noise
//! IK session and yamux streams as a relay session, carried over TCP
//! instead of the relay.
//!
//! This module is the direct **carrier**: the greeting, the length
//! framing, the yamux keepalive and the Go Away reasons. Who may connect
//! is the host's admission question ([`HostHandler::admit_direct`]); which
//! route to use is the link's ([`crate::link`]).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU16, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};

use crate::keys::Seed;
use crate::mux::Session;
use crate::noise::{self, Initiator, Responder, Transport, MAX_MESSAGE, MAX_PLAINTEXT};
use crate::relay::{close_code_of, EndCause, Flush, HostHandler, Join, Keepalive, Probe, SendRule, Sessions, Tunnel, TunnelEnd};

/// The 17 bytes a controller sends first.
pub const GREETING: &[u8; 17] = b"agentd-direct-v1\n";
/// The port a host prefers for direct sessions (outside the LAN listener's
/// 4082 to 4099).
pub const DEFAULT_PORT: u16 = 4181;
/// A connection must deliver the greeting and message 1 within this long.
pub const HELLO_DEADLINE: Duration = Duration::from_secs(5);
/// How long the Go Away of our own close may take to leave before the
/// connection is dropped anyway.
const CLOSE_FLUSH: Duration = Duration::from_secs(5);
/// A controller waits this long for message 2 before using the relay.
pub const DIAL_WAIT: Duration = Duration::from_secs(2);
/// Unfinished handshakes a host holds at once, in all and per peer address.
pub const MAX_PENDING: usize = 16;
pub const MAX_PENDING_PER_PEER: usize = 4;
/// Direct sessions a host keeps per controller and in all.
pub const MAX_PER_CONTROLLER: usize = 8;
pub const MAX_SESSIONS: usize = 32;
/// A host ends a direct session after this long (there is no rekey).
pub const MAX_LIFETIME: Duration = Duration::from_secs(24 * 3600);
/// A host stops accepting direct sessions this long after its last
/// contact with the cloud.
pub const CONTACT_VALID: Duration = Duration::from_secs(7 * 24 * 3600);
/// Most addresses in an answer.
pub const MAX_ADDRS: usize = 8;

const M1_LEN: usize = 96;
const M2_LEN: usize = 48;

/// Why a direct session could not be opened.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DirectError {
    #[error("direct connection failed")]
    Network,
    #[error("direct connection timed out")]
    TimedOut,
    /// The other end closed before message 2 (refused, or not that host).
    #[error("direct session refused")]
    Refused,
    #[error("direct handshake failed")]
    Handshake,
    /// Wrong greeting or framing (host side).
    #[error("not a direct session")]
    Protocol,
}

/// Whether `ip` is a private address (spec section 5.5): 10/8, 172.16/12,
/// 192.168/16, fc00::/7, with IPv4-mapped IPv6 read as IPv4.
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.is_private(),
            None => (v6.segments()[0] & 0xfe00) == 0xfc00,
        },
    }
}

/// What `GET /api/cloud/direct` answers (spec section 5.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectAnswer {
    pub v: u32,
    pub on: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addrs: Vec<String>,
}

impl DirectAnswer {
    pub fn off() -> DirectAnswer {
        DirectAnswer { v: 1, on: false, port: None, addrs: Vec::new() }
    }

    /// An answer for `port` and the private ones of `ips` (at most
    /// [`MAX_ADDRS`]).
    pub fn on(port: u16, ips: impl IntoIterator<Item = IpAddr>) -> DirectAnswer {
        let addrs = ips.into_iter().filter(|ip| is_private(*ip)).take(MAX_ADDRS).map(|ip| ip.to_string()).collect();
        DirectAnswer { v: 1, on: true, port: Some(port), addrs }
    }

    /// The addresses to dial, as a controller reads them: version 1, on,
    /// a port, private addresses only (anything else is dropped).
    pub fn targets(&self) -> Vec<SocketAddr> {
        let Some(port) = self.port.filter(|p| *p != 0 && self.on && self.v == 1) else { return Vec::new() };
        self.addrs.iter().take(MAX_ADDRS).filter_map(|a| a.parse::<IpAddr>().ok()).filter(|ip| is_private(*ip)).map(|ip| SocketAddr::new(ip, port)).collect()
    }
}

/// Writes one framed message: a 2-byte big-endian length, then the bytes.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, msg: &[u8]) -> std::io::Result<()> {
    let len = u16::try_from(msg.len()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let mut buf = Vec::with_capacity(2 + msg.len());
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(msg);
    w.write_all(&buf).await
}

/// The framed bytes of `msg` (for the vectors).
pub fn frame(msg: &[u8]) -> Vec<u8> {
    let mut out = (msg.len() as u16).to_be_bytes().to_vec();
    out.extend_from_slice(msg);
    out
}

/// Which lengths a message may have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    Message1,
    Message2,
    Transport,
}

impl Expect {
    pub fn allows(self, len: usize) -> bool {
        match self {
            Expect::Message1 => len == M1_LEN,
            Expect::Message2 => len == M2_LEN,
            Expect::Transport => (16..=MAX_MESSAGE).contains(&len),
        }
    }
}

/// Reads one framed message; a length `expect` does not allow is an error
/// before anything else is read.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R, expect: Expect) -> Result<Vec<u8>, DirectError> {
    let mut len = [0u8; 2];
    r.read_exact(&mut len).await.map_err(|_| DirectError::Network)?;
    let len = u16::from_be_bytes(len) as usize;
    if !expect.allows(len) {
        return Err(DirectError::Protocol);
    }
    let mut msg = vec![0u8; len];
    r.read_exact(&mut msg).await.map_err(|_| DirectError::Network)?;
    Ok(msg)
}

/// Who the controller is and whom it dials.
pub struct DialTarget<'a> {
    pub addr: SocketAddr,
    pub account_id: &'a str,
    pub host_id: &'a str,
    /// The host's `box` key from the controller's verified roster.
    pub host_box: &'a [u8; 32],
    pub own_box: &'a Seed,
    /// Tests only: also dial a loopback address (hosts never listen there,
    /// and an app never sets this).
    #[doc(hidden)]
    pub loopback_ok: bool,
}

/// The controller side: connects, greets, and runs the handshake within
/// `wait` (spec section 5.5). A close before message 2 is
/// [`DirectError::Refused`]: not reachable directly.
pub async fn dial(t: DialTarget<'_>, join: Join, keepalive: Keepalive, wait: Duration) -> Result<Tunnel, DirectError> {
    if !is_private(t.addr.ip()) && !(t.loopback_ok && t.addr.ip().is_loopback()) {
        return Err(DirectError::Network);
    }
    let addr = t.addr;
    let step = async move {
        let tcp = TcpStream::connect(addr).await.map_err(|_| DirectError::Network)?;
        let _ = tcp.set_nodelay(true);
        handshake(tcp, &t).await
    };
    let (tcp, transport) = tokio::time::timeout(wait, step).await.map_err(|_| DirectError::TimedOut)??;
    Ok(start(tcp, transport, true, join, keepalive, None))
}

/// The controller's greeting and handshake over a connected `io`.
pub async fn handshake<S>(mut io: S, t: &DialTarget<'_>) -> Result<(S, Transport), DirectError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let prologue = noise::direct_prologue(t.account_id, t.host_id);
    let mut init = Initiator::new(t.own_box, t.host_box, &prologue, None).map_err(|_| DirectError::Handshake)?;
    let m1 = init.write_message1().map_err(|_| DirectError::Handshake)?;
    let mut hello = GREETING.to_vec();
    hello.extend_from_slice(&frame(&m1));
    io.write_all(&hello).await.map_err(|_| DirectError::Network)?;
    let m2 = match read_frame(&mut io, Expect::Message2).await {
        Ok(m) => m,
        Err(DirectError::Network) => return Err(DirectError::Refused),
        Err(e) => return Err(e),
    };
    let transport = init.read_message2(&m2).map_err(|_| DirectError::Handshake)?;
    Ok((io, transport))
}

/// What a host needs to answer direct sessions.
pub struct HostKeys {
    pub account_id: String,
    pub host_id: String,
    pub own_box: Seed,
}

/// The host side of one accepted connection, until the handshake: reads
/// the greeting and message 1 within [`HELLO_DEADLINE`], asks `handler`
/// whether the key may connect, and answers with message 2. Anything
/// refused is closed with nothing sent.
pub async fn accept<S>(mut io: S, keys: &HostKeys, handler: &dyn HostHandler) -> Result<(S, Transport, String), DirectError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let hello = async {
        let mut greeting = [0u8; 17];
        io.read_exact(&mut greeting).await.map_err(|_| DirectError::Network)?;
        // Checked before any key work.
        if &greeting != GREETING {
            return Err(DirectError::Protocol);
        }
        read_frame(&mut io, Expect::Message1).await
    };
    let m1 = tokio::time::timeout(HELLO_DEADLINE, hello).await.map_err(|_| DirectError::TimedOut)??;
    let prologue = noise::direct_prologue(&keys.account_id, &keys.host_id);
    let mut resp = Responder::new(&keys.own_box, &prologue, None).map_err(|_| DirectError::Handshake)?;
    let rs = resp.read_message1(&m1).map_err(|_| DirectError::Handshake)?;
    let Some(device) = handler.admit_direct(&rs) else {
        return Err(DirectError::Refused);
    };
    let (m2, transport) = resp.write_message2().map_err(|_| DirectError::Handshake)?;
    tokio::time::timeout(HELLO_DEADLINE, write_frame(&mut io, &m2)).await.map_err(|_| DirectError::TimedOut)?.map_err(|_| DirectError::Network)?;
    Ok((io, transport, device))
}

/// The host side after [`accept`], still an unfinished handshake: waits
/// [`HELLO_DEADLINE`] for the first transport message and decrypts it. A
/// replayed message 1 gets a message 2 but never gets here, so it counts
/// toward no limit and replaces no session (spec section 5.5). Returns the
/// plaintext for [`serve_accepted`].
pub async fn confirm<S>(mut io: S, mut transport: Transport) -> Result<(S, Transport, Vec<u8>), DirectError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let msg = tokio::time::timeout(HELLO_DEADLINE, read_frame(&mut io, Expect::Transport)).await.map_err(|_| DirectError::TimedOut)??;
    let plain = transport.decrypt(&msg).map_err(|_| DirectError::Protocol)?;
    Ok((io, transport, plain))
}

/// Serves one accepted TCP connection as a direct session until it ends:
/// the handshake ([`accept`], [`confirm`]), the limits, then every stream
/// through `handler.serve`, re-checking the controller before each one as
/// relay sessions do. `sessions` holds direct sessions only.
pub async fn serve_host<S>(io: S, keys: Arc<HostKeys>, handler: Arc<dyn HostHandler>, sessions: Sessions, join: Join, keepalive: Keepalive) -> Result<(), DirectError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (io, transport, from) = accept(io, &keys, handler.as_ref()).await?;
    let (io, transport, first) = confirm(io, transport).await?;
    serve_accepted(io, transport, first, from, handler, sessions, join, keepalive).await
}

/// [`serve_host`] after [`accept`] and [`confirm`]: the caller may hold a
/// place in a [`Gate`] only until then. `first` is what [`confirm`] read.
#[allow(clippy::too_many_arguments)]
pub async fn serve_accepted<S>(io: S, transport: Transport, first: Vec<u8>, from: String, handler: Arc<dyn HostHandler>, sessions: Sessions, join: Join, keepalive: Keepalive) -> Result<(), DirectError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut tunnel = start_with(io, transport, false, join, keepalive, Some(MAX_LIFETIME), Some(first));
    let closer = tunnel.closer();
    if !sessions.add_capped(&from, closer.clone(), MAX_PER_CONTROLLER, MAX_SESSIONS, 1000) {
        tunnel.end(1000);
        return Err(DirectError::Refused);
    }
    // A removal between the admission and the registration found nothing
    // to close: ask again now that a removal would reach this session.
    if handler.controller_box(&from).is_none() {
        closer.close(4001);
    }
    let session = tunnel.session.clone();
    let h = handler.clone();
    let from_owned = from.clone();
    let on_removed = closer.clone();
    tokio::spawn(async move {
        while let Some(stream) = session.accept().await {
            if h.controller_box(&from_owned).is_none() {
                on_removed.close(4001);
                break;
            }
            h.serve(stream, from_owned.clone());
        }
    });
    let end = tunnel.wait_ended().await;
    sessions.remove(&from, &closer);
    if let Some(end) = &end {
        handler.on_session_end(&from, end);
    }
    Ok(())
}

/// Runs the session over `io` (after the handshake): the writer sends what
/// the session queued by the 2 ms join (no rate limit) and pings; the
/// reader decrypts into the session and watches the keepalive. `lifetime`
/// ends it with Go Away 0 (the host's 24 hours).
pub fn start<S>(io: S, transport: Transport, client: bool, join: Join, keepalive: Keepalive, lifetime: Option<Duration>) -> Tunnel
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    start_with(io, transport, client, join, keepalive, lifetime, None)
}

/// [`start`], with a first plaintext already read and decrypted.
fn start_with<S>(io: S, transport: Transport, client: bool, join: Join, keepalive: Keepalive, lifetime: Option<Duration>, first: Option<Vec<u8>>) -> Tunnel
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (session, outbound) = Session::new(client);
    let (closer, mut close_rx) = mpsc::unbounded_channel::<u16>();
    let (closed_tx, closed) = watch::channel(None);
    let (ended_tx, ended) = watch::channel(None);
    let (ping_now, mut ping_rx) = mpsc::unbounded_channel::<()>();
    let probe = Arc::new(Probe::default());
    let local = Arc::new(AtomicU16::new(0));
    let started = Instant::now();
    let transport = Arc::new(Mutex::new(transport));
    let (mut rd, mut wr) = tokio::io::split(io);
    let counter = Arc::new(AtomicU32::new(0));

    let t_out = transport.clone();
    let local_out = local.clone();
    let s_out = session.clone();
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(keepalive.every);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut rule = SendRule::unlimited(join, tokio::time::Instant::now());
        let mut since: Option<tokio::time::Instant> = None;
        let end_at = lifetime.map(|l| tokio::time::Instant::now() + l);
        let mut closing: Option<u16> = None;
        loop {
            let now = tokio::time::Instant::now();
            let queued = outbound.queued();
            let mut wake = None;
            if queued == 0 {
                since = None;
                if closing.is_some() {
                    let _ = wr.shutdown().await;
                    return;
                }
                if outbound.is_done() {
                    let _ = wr.shutdown().await;
                    return;
                }
            } else {
                let first = *since.get_or_insert(now);
                // Closing: what waits (the Go Away) leaves at once.
                let decision = if closing.is_some() { Flush::Small } else { rule.decide(now, queued, first) };
                match decision {
                    Flush::Full | Flush::Small => {
                        let plain = outbound.take(MAX_PLAINTEXT);
                        let Ok(msg) = t_out.lock().expect("noise lock").encrypt(&plain) else { return };
                        if write_frame(&mut wr, &msg).await.is_err() {
                            return;
                        }
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
            let life = async {
                match end_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                code = close_rx.recv(), if closing.is_none() => {
                    let code = code.unwrap_or(1000);
                    // The Go Away (sent once) goes out before the socket closes.
                    local_out.store(code, Ordering::Relaxed);
                    s_out.go_away_with(crate::relay::go_away_reason(code));
                    closing = Some(code);
                }
                _ = life, if closing.is_none() => {
                    local_out.store(1000, Ordering::Relaxed);
                    s_out.go_away_with(0);
                    closing = Some(1000);
                }
                Some(()) = ping_rx.recv() => s_out.ping(counter.fetch_add(1, Ordering::Relaxed)),
                _ = ping.tick() => s_out.ping(counter.fetch_add(1, Ordering::Relaxed)),
                _ = outbound.pushed() => {}
                _ = sleep => {}
            }
        }
    });

    let s_in = session.clone();
    let closer_in = closer.clone();
    let probe_in = probe.clone();
    // Frames are read by a task of their own that is never cancelled: a
    // half-read frame must not be dropped when the keepalive or a check
    // wakes the loop below (read_exact is not cancel-safe).
    let (frames_tx, mut frames) = mpsc::channel::<Result<Vec<u8>, DirectError>>(4);
    let pump = tokio::spawn(async move {
        loop {
            let r = read_frame(&mut rd, Expect::Transport).await;
            let failed = r.is_err();
            if frames_tx.send(r).await.is_err() || failed {
                return;
            }
        }
    });
    tokio::spawn(async move {
        let mut code = 1006u16;
        let mut cause = EndCause::Network;
        let mut last_in = tokio::time::Instant::now();
        let mut wall = (keepalive.wall_clock)();
        let mut first = first;
        loop {
            if let Some(p) = first.take() {
                let ok = s_in.receive(&p).is_ok();
                if let Some(reason) = s_in.peer_go_away() {
                    (code, cause) = (close_code_of(reason), EndCause::Closed);
                    break;
                }
                if !ok {
                    (code, cause) = (4002, EndCause::Protocol);
                    break;
                }
            }
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
            if let Some(by) = checked_by {
                wake = wake.min(by);
            }
            let changed = probe_in.changed.notified();
            let next = tokio::select! {
                n = tokio::time::timeout_at(wake, frames.recv()) => n,
                _ = changed => continue,
            };
            let msg = match next {
                Err(_) => {
                    let now = tokio::time::Instant::now();
                    if now >= dead_at || checked_by.is_some_and(|by| now >= by) {
                        cause = EndCause::Deadline;
                        break;
                    }
                    continue;
                }
                Ok(Some(Err(DirectError::Protocol))) => {
                    (code, cause) = (4002, EndCause::Protocol);
                    break;
                }
                Ok(None) | Ok(Some(Err(_))) => break,
                Ok(Some(Ok(m))) => m,
            };
            last_in = tokio::time::Instant::now();
            probe_in.answered();
            let plain = transport.lock().expect("noise lock").decrypt(&msg);
            let ok = match plain {
                Ok(p) => s_in.receive(&p).is_ok(),
                Err(_) => false,
            };
            if let Some(reason) = s_in.peer_go_away() {
                (code, cause) = (close_code_of(reason), EndCause::Closed);
                break;
            }
            if !ok {
                // Nothing is sent after a message that does not decrypt.
                (code, cause) = (4002, EndCause::Protocol);
                break;
            }
        }
        let by_us = local.load(Ordering::Relaxed);
        if by_us != 0 && matches!(cause, EndCause::Closed | EndCause::Network) {
            (cause, code) = (EndCause::Local, by_us);
        }
        s_in.close();
        pump.abort();
        let end = TunnelEnd { cause, code, lived: started.elapsed(), quiet: last_in.elapsed(), ponged: false };
        let _ = ended_tx.send(Some(end));
        let _ = closed_tx.send(Some(code));
        if cause != EndCause::Local {
            writer.abort();
        } else {
            // Our own close: the writer flushes the Go Away, but a peer that
            // stops reading must not hold it (and the socket) open.
            tokio::spawn(async move {
                tokio::time::sleep(CLOSE_FLUSH).await;
                writer.abort();
            });
        }
        drop(closer_in);
    });
    Tunnel::from_parts(session, closer, closed, ended, ping_now, probe)
}

/// Limits unfinished handshakes (spec section 5.5): [`MAX_PENDING`] in all,
/// [`MAX_PENDING_PER_PEER`] from one address.
#[derive(Default, Clone)]
pub struct Gate(Arc<Mutex<HashMap<IpAddr, usize>>>);

/// A place in the [`Gate`], given back when dropped.
pub struct Pass {
    gate: Gate,
    ip: IpAddr,
}

impl Gate {
    pub fn enter(&self, ip: IpAddr) -> Option<Pass> {
        let mut map = self.0.lock().expect("gate lock");
        let total: usize = map.values().sum();
        let mine = map.get(&ip).copied().unwrap_or(0);
        if total >= MAX_PENDING || mine >= MAX_PENDING_PER_PEER {
            return None;
        }
        *map.entry(ip).or_default() += 1;
        Some(Pass { gate: self.clone(), ip })
    }
}

impl Drop for Pass {
    fn drop(&mut self) {
        let mut map = self.gate.0.lock().expect("gate lock");
        if let Some(n) = map.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                map.remove(&self.ip);
            }
        }
    }
}

/// Whether a connection from `peer` to `local` may be accepted: both
/// private (spec section 5.5).
pub fn acceptable(local: SocketAddr, peer: SocketAddr) -> bool {
    is_private(local.ip()) && is_private(peer.ip())
}

/// One private network this device is on: an address and its prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Subnet {
    pub ip: IpAddr,
    pub prefix: u8,
}

impl Subnet {
    /// The network part only, so two devices on one network compare equal.
    pub fn network(self) -> Subnet {
        Subnet { ip: mask(self.ip, self.prefix), prefix: self.prefix }
    }

    pub fn contains(self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        ip.is_ipv4() == self.ip.is_ipv4() && mask(ip, self.prefix) == mask(self.ip, self.prefix)
    }
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

fn mask(ip: IpAddr, prefix: u8) -> IpAddr {
    match canonical(ip) {
        IpAddr::V4(v4) => {
            let bits = u32::from(v4);
            let m = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix.min(32) as u32) };
            IpAddr::V4((bits & m).into())
        }
        IpAddr::V6(v6) => {
            let bits = u128::from(v6);
            let m = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix.min(128) as u32) };
            IpAddr::V6((bits & m).into())
        }
    }
}

/// This device's private networks, from its interfaces (no loopback, no
/// link-local, no public address).
pub fn local_subnets() -> Vec<Subnet> {
    let Ok(ifaces) = if_addrs::get_if_addrs() else { return Vec::new() };
    let mut out: Vec<Subnet> = Vec::new();
    for i in ifaces {
        let (ip, prefix) = match &i.addr {
            if_addrs::IfAddr::V4(a) => (IpAddr::V4(a.ip), a.prefixlen),
            if_addrs::IfAddr::V6(a) => (IpAddr::V6(a.ip), a.prefixlen),
        };
        if is_private(ip) && !out.iter().any(|s| s.ip == ip) {
            out.push(Subnet { ip, prefix });
        }
    }
    out
}

/// Whether a controller on `current` networks may try `addr`, learned
/// while it was on `learned` (spec section 5.5, "only on that network"):
/// `addr` lies in one of the current networks, and that network is one it
/// learned the address on.
pub fn may_try(addr: IpAddr, current: &[Subnet], learned: &[Subnet]) -> bool {
    current.iter().any(|c| c.contains(addr) && learned.iter().any(|l| l.network() == c.network()))
}
