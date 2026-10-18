//! Desktop "Network access": a second listener on `0.0.0.0:<port>` that
//! serves the same router as the sidecar's private loopback listener, so
//! devices on the LAN can connect without a separate CLI server.
//!
//! Only the desktop shell drives it (`routes::desktop`). While it is open,
//! its access key is accepted alongside the desktop token (see
//! [`Policy::authenticate`]). Closing it clears the key first, then cancels
//! every accepted socket — including upgraded WebSocket and long-lived SSE
//! connections, which axum would otherwise keep serving — and frees the port.

use crate::middleware::{ConnInfo, Policy};
use axum::Router;
use serde::Serialize;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

/// Preferred LAN port; the same default as the CLI's `server.yaml`.
pub const DEFAULT_PORT: u16 = 4082;
/// Tried in order when the preferred port is taken, before an OS-chosen port.
const FALLBACK_PORTS: std::ops::RangeInclusive<u16> = 4083..=4099;

// ── Cancellable connections ─────────────────────────────────────────────────

/// A TCP stream that fails every read and write once `cancel` fires, so a
/// connection (and anything upgraded from it) dies with the listener.
pub struct CancellableIo {
    io: TcpStream,
    cancel: CancellationToken,
    cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl CancellableIo {
    fn new(io: TcpStream, cancel: CancellationToken) -> Self {
        let cancelled = Box::pin(cancel.clone().cancelled_owned());
        Self { io, cancel, cancelled }
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.io.local_addr()
    }

    /// `Some(error)` once cancelled; otherwise registers the waker so a
    /// pending read or write wakes up when the listener closes.
    fn aborted(&mut self, cx: &mut Context<'_>) -> Option<io::Error> {
        if self.cancel.is_cancelled() || self.cancelled.as_mut().poll(cx).is_ready() {
            return Some(io::Error::new(io::ErrorKind::ConnectionAborted, "network access closed"));
        }
        None
    }
}

impl AsyncRead for CancellableIo {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if let Some(e) = self.aborted(cx) {
            return Poll::Ready(Err(e));
        }
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for CancellableIo {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        if let Some(e) = self.aborted(cx) {
            return Poll::Ready(Err(e));
        }
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        if let Some(e) = self.aborted(cx) {
            return Poll::Ready(Err(e));
        }
        Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(e) = self.aborted(cx) {
            return Poll::Ready(Err(e));
        }
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// The LAN listener: Nagle off (see `NoDelayTcpListener`), and every
/// accepted stream tied to the listener's cancellation token.
pub struct NetworkListener {
    inner: TcpListener,
    cancel: CancellationToken,
}

impl axum::serve::Listener for NetworkListener {
    type Io = CancellableIo;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, addr) = axum::serve::Listener::accept(&mut self.inner).await;
        if let Err(e) = io.set_nodelay(true) {
            tracing::debug!("tcp_nodelay_failed remote={} error={}", addr, e);
        }
        (CancellableIo::new(io, self.cancel.clone()), addr)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, NetworkListener>> for ConnInfo {
    fn connect_info(stream: axum::serve::IncomingStream<'_, NetworkListener>) -> Self {
        ConnInfo { local: stream.io().local_addr().ok(), remote: Some(*stream.remote_addr()) }
    }
}

// ── Port selection ──────────────────────────────────────────────────────────

/// Ports to try, in order: the preferred one, the one currently bound (so a
/// reapply keeps connected devices' URL), the fallback range, then `0`.
pub fn candidate_ports(preferred: u16, previous: Option<u16>, private_port: u16) -> Vec<u16> {
    let mut out: Vec<u16> = vec![];
    for p in std::iter::once(preferred).chain(previous).chain(FALLBACK_PORTS) {
        if p != 0 && p != private_port && !out.contains(&p) {
            out.push(p);
        }
    }
    out.push(0);
    out
}

/// Bind the first free candidate. Only "this port is unavailable" errors
/// move on to the next one.
async fn bind_with_fallback(host: &str, candidates: &[u16]) -> Result<(TcpListener, u16), String> {
    let mut last: Option<io::Error> = None;
    for &port in candidates {
        match TcpListener::bind((host, port)).await {
            Ok(l) => {
                let bound = l.local_addr().map(|a| a.port()).unwrap_or(port);
                return Ok((l, bound));
            }
            Err(e) if matches!(e.kind(), io::ErrorKind::AddrInUse | io::ErrorKind::AddrNotAvailable | io::ErrorKind::PermissionDenied) => last = Some(e),
            Err(e) => return Err(format!("Could not listen on {host}:{port}: {e}")),
        }
    }
    Err(match last {
        Some(e) => format!("Could not open a network port: {e}"),
        None => "Could not open a network port.".into(),
    })
}

// ── Controller ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Status {
    pub enabled: bool,
    /// The port the desktop asked for.
    pub requested_port: Option<u16>,
    /// The port actually listening (differs from `requested_port` after a fallback).
    pub port: Option<u16>,
    pub fallback: bool,
    pub listening: bool,
    pub error: Option<String>,
}

struct Active {
    port: u16,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Inner {
    active: Option<Active>,
    enabled: bool,
    requested_port: Option<u16>,
    error: Option<String>,
}

pub struct Controller {
    router: Router,
    policy: Policy,
    private_port: u16,
    host: String,
    inner: tokio::sync::Mutex<Inner>,
}

impl Controller {
    pub fn new(router: Router, policy: Policy, private_port: u16) -> Self {
        Self::with_host(router, policy, private_port, "0.0.0.0")
    }

    /// `new` with another bind host (tests bind loopback).
    pub fn with_host(router: Router, policy: Policy, private_port: u16, host: &str) -> Self {
        Self { router, policy, private_port, host: host.into(), inner: Default::default() }
    }

    /// The sidecar's private loopback port; the control route only answers there.
    pub fn private_port(&self) -> u16 {
        self.private_port
    }

    /// Close the current listener, then open one on `preferred` (or a
    /// fallback) when `enabled`. Any change restarts the listener, so
    /// sessions authenticated with an old key are cut off.
    pub async fn apply(&self, enabled: bool, preferred: u16, key: Option<String>) -> Status {
        let mut inner = self.inner.lock().await;
        let previous = inner.active.as_ref().map(|a| a.port);
        self.stop_locked(&mut inner).await;
        inner.enabled = enabled;
        inner.requested_port = enabled.then_some(preferred);
        inner.error = None;
        if !enabled {
            tracing::info!("network_access_disabled");
            return snapshot(&inner);
        }
        let Some(key) = key.filter(|k| !k.is_empty()) else {
            inner.error = Some("An access key is required.".into());
            return snapshot(&inner);
        };
        match bind_with_fallback(&self.host, &candidate_ports(preferred, previous, self.private_port)).await {
            Ok((listener, port)) => {
                self.policy.set_network_key(Some(key));
                appv3_preview::block_port(port);
                let cancel = CancellationToken::new();
                let listener = NetworkListener { inner: listener, cancel: cancel.clone() };
                let app = self.router.clone();
                let task = tokio::spawn(async move {
                    if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<ConnInfo>()).await {
                        tracing::warn!("network_access_serve_failed error={}", e);
                    }
                });
                tracing::info!("network_access_enabled host={} port={} requested_port={}", self.host, port, preferred);
                inner.active = Some(Active { port, cancel, task });
            }
            Err(e) => {
                tracing::warn!("network_access_bind_failed requested_port={} error={}", preferred, e);
                inner.error = Some(e);
            }
        }
        snapshot(&inner)
    }

    pub async fn status(&self) -> Status {
        let mut inner = self.inner.lock().await;
        // The accept loop only ends on its own when the listener broke.
        if inner.active.as_ref().is_some_and(|a| a.task.is_finished()) {
            self.stop_locked(&mut inner).await;
            inner.error = Some("The network listener stopped unexpectedly.".into());
        }
        snapshot(&inner)
    }

    /// Close the listener (server shutdown).
    pub async fn shutdown(&self) {
        let mut inner = self.inner.lock().await;
        self.stop_locked(&mut inner).await;
        inner.enabled = false;
    }

    /// Revoke the key, kill every connection, and wait until the listening
    /// socket is closed so the port can be bound again at once.
    async fn stop_locked(&self, inner: &mut Inner) {
        self.policy.set_network_key(None);
        if let Some(a) = inner.active.take() {
            a.cancel.cancel();
            a.task.abort();
            let _ = a.task.await;
        }
    }
}

fn snapshot(inner: &Inner) -> Status {
    let port = inner.active.as_ref().map(|a| a.port);
    Status {
        enabled: inner.enabled,
        requested_port: inner.requested_port,
        port,
        fallback: port.is_some() && port != inner.requested_port,
        listening: port.is_some(),
        error: inner.error.clone(),
    }
}

static CONTROLLER: OnceLock<Controller> = OnceLock::new();

/// Enable the control route. `server serve` calls this for desktop sessions only.
pub fn install(router: Router, policy: Policy, private_port: u16) {
    let _ = CONTROLLER.set(Controller::new(router, policy, private_port));
}

pub fn controller() -> Option<&'static Controller> {
    CONTROLLER.get()
}

pub async fn shutdown() {
    if let Some(c) = controller() {
        c.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn policy() -> Policy {
        Policy { token: Arc::new("desk".into()), allow_insecure_lan: false, max_bytes: crate::middleware::DEFAULT_MAX_BYTES, network_key: Arc::default() }
    }

    fn controller(p: Policy) -> Controller {
        let router = Router::new().route("/ping", axum::routing::get(|| async { "pong" }));
        Controller::with_host(router, p, 1, "127.0.0.1")
    }

    #[test]
    fn candidates_prefer_the_requested_then_the_current_port() {
        let c = candidate_ports(4082, None, 51000);
        assert_eq!(&c[..3], &[4082, 4083, 4084]);
        assert_eq!(c.last(), Some(&0));
        assert_eq!(c.len(), 1 + 17 + 1);

        let c = candidate_ports(4082, Some(4090), 51000);
        assert_eq!(&c[..3], &[4082, 4090, 4083]);
        assert_eq!(c.iter().filter(|&&p| p == 4090).count(), 1, "no duplicates");

        let c = candidate_ports(4082, None, 4083);
        assert!(!c.contains(&4083), "never the private port");
    }

    #[tokio::test]
    async fn a_cancelled_connection_fails_reads_and_writes() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let client = tokio::spawn(TcpStream::connect(addr));
        let (io, _) = l.accept().await.unwrap();
        let _client = client.await.unwrap().unwrap();
        let cancel = CancellationToken::new();
        let mut io = CancellableIo::new(io, cancel.clone());
        let pending_read = tokio::spawn(async move {
            let mut buf = [0u8; 8];
            let r = io.read(&mut buf).await;
            (r.map(|_| ()), io)
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cancel.cancel();
        let (r, mut io) = tokio::time::timeout(std::time::Duration::from_secs(2), pending_read).await.expect("the pending read wakes up").unwrap();
        assert_eq!(r.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
        assert_eq!(io.write(b"x").await.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
    }

    #[tokio::test]
    async fn apply_listens_installs_the_key_and_disable_revokes_it() {
        let p = policy();
        let c = controller(p.clone());
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let s = c.apply(true, free, Some("k".repeat(20))).await;
        assert!(s.listening && !s.fallback && s.error.is_none(), "{s:?}");
        assert_eq!(s.port, Some(free));
        assert!(p.authenticate(&"k".repeat(20)).is_some());
        assert!(TcpStream::connect(("127.0.0.1", free)).await.is_ok());

        // Re-applying the same port rebinds it immediately.
        let s = c.apply(true, free, Some("j".repeat(20))).await;
        assert_eq!(s.port, Some(free), "{s:?}");
        assert!(p.authenticate(&"k".repeat(20)).is_none(), "the old key is revoked");

        let s = c.apply(false, free, None).await;
        assert!(!s.listening && !s.enabled);
        assert!(p.authenticate(&"j".repeat(20)).is_none());
        assert!(TcpStream::connect(("127.0.0.1", free)).await.is_err(), "the port is closed");
    }

    #[tokio::test]
    async fn a_taken_port_falls_back_and_returns_when_free() {
        let c = controller(policy());
        let blocker = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let taken = blocker.local_addr().unwrap().port();
        let s = c.apply(true, taken, Some("k".repeat(20))).await;
        assert!(s.listening && s.fallback, "{s:?}");
        assert_ne!(s.port, Some(taken));
        assert_eq!(s.requested_port, Some(taken));
        let fallback = s.port;

        // Still taken: a reapply keeps the current port.
        let s = c.apply(true, taken, Some("k".repeat(20))).await;
        assert_eq!(s.port, fallback);

        drop(blocker);
        let s = c.apply(true, taken, Some("k".repeat(20))).await;
        assert_eq!(s.port, Some(taken), "back on the preferred port");
        assert!(!s.fallback);
        c.shutdown().await;
    }

    #[tokio::test]
    async fn a_bind_error_is_reported_and_no_key_is_installed() {
        let p = policy();
        let router = Router::new();
        let c = Controller::with_host(router, p.clone(), 1, "invalid host name.");
        let s = c.apply(true, 4082, Some("k".repeat(20))).await;
        assert!(!s.listening && s.error.is_some(), "{s:?}");
        assert!(p.authenticate(&"k".repeat(20)).is_none());
    }

    #[tokio::test]
    async fn enabling_without_a_key_is_refused() {
        let c = controller(policy());
        let s = c.apply(true, 4082, None).await;
        assert!(!s.listening && s.error.is_some());
    }

    #[tokio::test]
    async fn served_requests_reach_the_router() {
        let c = controller(policy());
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        c.apply(true, free, Some("k".repeat(20))).await;
        let mut s = TcpStream::connect(("127.0.0.1", free)).await.unwrap();
        s.write_all(b"GET /ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.ends_with("pong"), "{out}");
        c.shutdown().await;
    }
}
