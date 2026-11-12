//! The loopback bridge (plan decision D7): the web UI reaches an account
//! computer through `http://127.0.0.1:<port>`, and each request becomes one
//! stream of the end-to-end encrypted relay session. The phone shell runs
//! one per opened computer, and so does a computer's server for the desktop
//! app (feature `bridge`).
//!
//! Only the app's own webview may use it. Every request must carry a random
//! key made when the bridge starts (`Authorization: Bearer` or `?_token=`),
//! given to the web UI as this origin's access key and never stored. The
//! bridge removes the key before the request enters the tunnel, answers CORS
//! preflights itself (the computer's connector drops `Origin`), refuses any
//! page whose origin the caller's check does not allow, and passes WebSocket
//! upgrades and event streams through unbuffered.

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use zeroize::Zeroizing;

/// The query parameter the web UI uses where it cannot set a header
/// (EventSource, WebSocket), as the server names it.
pub const KEY_PARAM: &str = "_token";

/// Which page origins may use a bridge: the app's own webview.
pub type OriginCheck = fn(&str) -> bool;

/// A byte stream to the computer: one relay stream per request.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Io for T {}

pub type OpenFuture = Pin<Box<dyn Future<Output = io::Result<Box<dyn Io>>> + Send>>;
pub type Opener = Arc<dyn Fn() -> OpenFuture + Send + Sync>;

type Body = BoxBody<Bytes, hyper::Error>;

/// What every connection of a bridge shares, across its listeners.
struct Shared {
    key: Zeroizing<String>,
    opener: Opener,
    allowed: OriginCheck,
    served: AtomicU64,
    unauthorized: AtomicU64,
    forbidden: AtomicU64,
    hooks: Hooks,
}

/// Test seams: a listener the system took (it stops accepting, the port
/// stays bound), and `accept` errors.
#[derive(Default)]
struct Hooks {
    stall: Notify,
    fail_accepts: AtomicUsize,
    accepts: AtomicUsize,
}

/// Requests a bridge answered since it started.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    /// Requests other than preflights (so not the self-check), refused or not.
    pub served: u64,
    /// Refused for a missing or wrong key (401).
    pub unauthorized: u64,
    /// Refused for another page's origin (403).
    pub forbidden: u64,
}

/// A running bridge. Dropping it stops accepting connections.
///
/// iOS reclaims the listening sockets of a suspended app and may not tell
/// it (Apple TN2277): the listener then never accepts again. The phone
/// pauses a bridge in the background ([`Bridge::pause`]) and makes it
/// listen again in front ([`Bridge::listen_again`]): the same port, key,
/// opener and origin check. [`Bridge::check`] tells whether it still
/// answers. Connections already accepted are not touched by either.
pub struct Bridge {
    pub origin: String,
    port: u16,
    shared: Arc<Shared>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl std::fmt::Debug for Bridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Bridge({}, key [redacted])", self.origin)
    }
}

/// How long [`Bridge::listen_again`] tries for the same port before it
/// takes another (a reclaimed socket may hold it for a moment).
const REBIND_TRIES: u32 = 10;
const REBIND_WAIT: Duration = Duration::from_millis(50);
/// `accept` errors in a row (not of one connection) before the accept loop
/// opens a new listener on the same port; it waits between them.
const ACCEPT_FAILURES_BEFORE_RELISTEN: u32 = 4;
const ACCEPT_RETRY_FIRST: Duration = Duration::from_millis(100);
const ACCEPT_RETRY_MAX: Duration = Duration::from_secs(1);

impl Bridge {
    /// Listens on a new loopback port. `allowed`: the page origins that may
    /// use it; a request with any other `Origin` is refused.
    pub async fn start(opener: Opener, allowed: OriginCheck) -> io::Result<Bridge> {
        Bridge::start_on(opener, allowed, None).await
    }

    /// Like [`Bridge::start`], on `port` when it is free, else on a port
    /// the system picks: one computer keeps one origin across launches
    /// (and routes), so the page never reloads and its web storage stays.
    pub async fn start_on(opener: Opener, allowed: OriginCheck, port: Option<u16>) -> io::Result<Bridge> {
        Bridge::start_keyed(opener, allowed, port, None).await
    }

    /// Like [`Bridge::start_on`], with `key` when given (a bridge that
    /// starts again for the same computer in the same app run keeps the key
    /// the page already holds), else a new random one.
    pub async fn start_keyed(opener: Opener, allowed: OriginCheck, port: Option<u16>, key: Option<&str>) -> io::Result<Bridge> {
        let listener = match port {
            Some(p) => match TcpListener::bind(("127.0.0.1", p)).await {
                Ok(l) => l,
                Err(_) => TcpListener::bind("127.0.0.1:0").await?,
            },
            None => TcpListener::bind("127.0.0.1:0").await?,
        };
        let port = listener.local_addr()?.port();
        let key = match key.filter(|k| !k.is_empty()) {
            Some(k) => k.to_string(),
            None => {
                let raw: [u8; 32] = crate::keys::random_bytes();
                raw.iter().map(|b| format!("{b:02x}")).collect::<String>()
            }
        };
        let shared = Arc::new(Shared {
            key: Zeroizing::new(key),
            opener,
            allowed,
            served: AtomicU64::new(0),
            unauthorized: AtomicU64::new(0),
            forbidden: AtomicU64::new(0),
            hooks: Hooks::default(),
        });
        let task = tokio::spawn(serve(listener, port, shared.clone()));
        Ok(Bridge { origin: origin_of(port), port, shared, task: Some(task) })
    }

    pub fn key(&self) -> &str {
        self.shared.key.as_str()
    }

    /// Whether it has a listener (it is not paused).
    pub fn is_listening(&self) -> bool {
        self.task.is_some()
    }

    /// Requests answered since it started.
    pub fn counts(&self) -> Counts {
        Counts {
            served: self.shared.served.load(Ordering::Relaxed),
            unauthorized: self.shared.unauthorized.load(Ordering::Relaxed),
            forbidden: self.shared.forbidden.load(Ordering::Relaxed),
        }
    }

    /// Stops listening (the app went to the background): a connection is
    /// refused at once instead of waiting on a socket the system may take.
    /// [`Bridge::listen_again`] listens again.
    pub async fn pause(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            // Once it has finished, its listener is closed.
            let _ = task.await;
        }
    }

    /// Closes the listener, whatever state it is in, and listens again on
    /// the same port with the same key, opener and origin check. If the
    /// port cannot be had again within about half a second, it listens on
    /// another one and `origin` changes: `Ok(true)`, and the caller must
    /// tell the page.
    pub async fn listen_again(&mut self) -> io::Result<bool> {
        self.pause().await;
        let mut bound = None;
        for i in 0..REBIND_TRIES {
            if i > 0 {
                tokio::time::sleep(REBIND_WAIT).await;
            }
            if let Ok(l) = TcpListener::bind(("127.0.0.1", self.port)).await {
                bound = Some(l);
                break;
            }
        }
        let (listener, moved) = match bound {
            Some(l) => (l, false),
            None => (TcpListener::bind("127.0.0.1:0").await?, true),
        };
        self.port = listener.local_addr()?.port();
        self.origin = origin_of(self.port);
        self.task = Some(tokio::spawn(serve(listener, self.port, self.shared.clone())));
        Ok(moved)
    }

    /// Whether the bridge answers a request on its own port within
    /// `within`: a preflight, which it answers itself, so nothing enters
    /// the tunnel. A bare connect proves nothing: the kernel accepts for a
    /// listener nobody reads.
    pub async fn check(&self, within: Duration) -> bool {
        let addr = ("127.0.0.1", self.port);
        let probe = async {
            let mut tcp = tokio::net::TcpStream::connect(addr).await.ok()?;
            tcp.write_all(b"OPTIONS /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await.ok()?;
            let mut head = [0u8; 12];
            tcp.read_exact(&mut head).await.ok()?;
            Some(head.starts_with(b"HTTP/1.1 204"))
        };
        matches!(tokio::time::timeout(within, probe).await, Ok(Some(true)))
    }

    /// Test seam: the system takes the listener underneath the bridge. It
    /// stays bound (the kernel still accepts connections) but is never read.
    #[doc(hidden)]
    pub fn stall_for_test(&self) {
        self.shared.hooks.stall.notify_one();
    }

    /// Test seam: the next `n` accepts fail with an error that is not of
    /// one connection (`usize::MAX`: all of them; 0 ends it).
    #[doc(hidden)]
    pub fn fail_accepts_for_test(&self, n: usize) {
        self.shared.hooks.fail_accepts.store(n, Ordering::SeqCst);
    }

    /// Test seam: accepts tried so far.
    #[doc(hidden)]
    pub fn accepts_for_test(&self) -> usize {
        self.shared.hooks.accepts.load(Ordering::SeqCst)
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn origin_of(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Errors that end one pending connection, not the listener.
fn connection_error(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::ConnectionAborted | io::ErrorKind::ConnectionRefused | io::ErrorKind::ConnectionReset | io::ErrorKind::Interrupted)
}

async fn accept(listener: &TcpListener, hooks: &Hooks) -> io::Result<(tokio::net::TcpStream, std::net::SocketAddr)> {
    hooks.accepts.fetch_add(1, Ordering::SeqCst);
    let failing = hooks.fail_accepts.load(Ordering::SeqCst);
    if failing > 0 {
        if failing != usize::MAX {
            hooks.fail_accepts.store(failing - 1, Ordering::SeqCst);
        }
        return Err(io::Error::other("accept failed (test)"));
    }
    listener.accept().await
}

/// The accept loop. It never spins: an error of one connection goes on at
/// once; any other waits, longer each time, and a few in a row replace the
/// listener with a new one on the same port (iOS may have taken it).
async fn serve(listener: TcpListener, port: u16, shared: Arc<Shared>) {
    let mut listener = Some(listener);
    let mut failures = 0u32;
    loop {
        let Some(l) = listener.as_ref() else {
            // Listen again on the same port; it never moves by itself (the
            // page would not know), so it keeps trying.
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(l) => listener = Some(l),
                Err(_) => tokio::time::sleep(ACCEPT_RETRY_MAX).await,
            }
            continue;
        };
        let got = tokio::select! {
            got = accept(l, &shared.hooks) => got,
            _ = shared.hooks.stall.notified() => {
                std::future::pending::<()>().await;
                continue;
            }
        };
        let (tcp, peer) = match got {
            Ok(c) => {
                failures = 0;
                c
            }
            Err(e) if connection_error(&e) => continue,
            Err(_) => {
                failures += 1;
                if failures % ACCEPT_FAILURES_BEFORE_RELISTEN == 0 {
                    listener = None;
                }
                let wait = ACCEPT_RETRY_FIRST.saturating_mul(1 << (failures - 1).min(4)).min(ACCEPT_RETRY_MAX);
                tokio::time::sleep(wait).await;
                continue;
            }
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let _ = tcp.set_nodelay(true);
        let shared = shared.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let shared = shared.clone();
                async move { Ok::<_, Infallible>(handle(req, &shared).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tcp), svc).with_upgrades().await;
        });
    }
}

fn text(status: StatusCode, body: &'static str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from_static(body.as_bytes())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

fn cors(resp: &mut Response<Body>, origin: Option<&str>) {
    let Some(origin) = origin.and_then(|o| HeaderValue::from_str(o).ok()) else {
        return;
    };
    let h = resp.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    h.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("Accept-Ranges, Content-Range, Content-Length, ETag"));
    h.append(header::VARY, HeaderValue::from_static("Origin"));
}

fn preflight(origin: Option<&str>, req: &Request<Incoming>) -> Response<Body> {
    let mut r = text(StatusCode::NO_CONTENT, "");
    r.headers_mut().remove(header::CONTENT_TYPE);
    cors(&mut r, origin);
    let h = r.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"));
    if let Some(asked) = req.headers().get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, asked.clone());
    }
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    r
}

/// The key the request presents, if any.
fn presented(req: &Request<Incoming>) -> Option<String> {
    if let Some(v) = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(t) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) {
            return Some(t.trim().to_string());
        }
    }
    let q = req.uri().query()?;
    form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == KEY_PARAM).map(|(_, v)| v.into_owned())
}

/// Removes the bridge key (header and query) and points the request at the
/// computer (`Host: localhost`, spec section 5.4).
fn strip(req: &mut Request<Incoming>) {
    let h = req.headers_mut();
    h.remove(header::AUTHORIZATION);
    h.remove(header::ORIGIN);
    h.remove(header::COOKIE);
    h.insert(header::HOST, HeaderValue::from_static("localhost"));
    if let Some(q) = req.uri().query().filter(|q| q.contains(KEY_PARAM)) {
        let kept: Vec<(String, String)> = form_urlencoded::parse(q.as_bytes()).filter(|(k, _)| k != KEY_PARAM).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let new_q = form_urlencoded::Serializer::new(String::new()).extend_pairs(kept).finish();
        let path = req.uri().path().to_string();
        let pq = if new_q.is_empty() { path } else { format!("{path}?{new_q}") };
        if let Ok(uri) = pq.parse() {
            *req.uri_mut() = uri;
        }
    } else if let Some(pq) = req.uri().path_and_query().map(|p| p.as_str().to_string()) {
        // Origin-form only: the tunnel never sees the loopback authority.
        if let Ok(uri) = pq.parse() {
            *req.uri_mut() = uri;
        }
    }
}

async fn handle(mut req: Request<Incoming>, shared: &Shared) -> Response<Body> {
    let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_string);
    let allowed = origin.as_deref().filter(|o| (shared.allowed)(o));
    if origin.is_some() && allowed.is_none() {
        // Another page on this device: never forwarded, whatever it sends.
        shared.forbidden.fetch_add(1, Ordering::Relaxed);
        return text(StatusCode::FORBIDDEN, "Forbidden");
    }
    if req.method() == Method::OPTIONS {
        return preflight(allowed, &req);
    }
    shared.served.fetch_add(1, Ordering::Relaxed);
    let key = shared.key.as_str();
    let ok = presented(&req).is_some_and(|p| bool::from(p.as_bytes().ct_eq(key.as_bytes())));
    if !ok {
        shared.unauthorized.fetch_add(1, Ordering::Relaxed);
        let mut r = text(StatusCode::UNAUTHORIZED, "Unauthorized");
        cors(&mut r, allowed);
        return r;
    }
    strip(&mut req);
    let upgrade = req.headers().contains_key(header::UPGRADE).then(|| hyper::upgrade::on(&mut req));
    let mut resp = match forward(req, shared.opener.clone()).await {
        Ok(r) => r,
        Err(Failed::Link(e)) => {
            // No session to the computer within the link's wait: 503 with
            // a JSON error, which the web UI shows as "Can't reach …".
            let mut r = link_down(&e.to_string());
            cors(&mut r, allowed);
            return r;
        }
        Err(Failed::Exchange) => {
            let mut r = text(StatusCode::BAD_GATEWAY, "This computer cannot be reached through your account right now.");
            cors(&mut r, allowed);
            return r;
        }
    };
    if resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(from_page) = upgrade {
            let to_computer = hyper::upgrade::on(&mut resp);
            tokio::spawn(async move {
                if let (Ok(a), Ok(b)) = tokio::join!(from_page, to_computer) {
                    let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b)).await;
                }
            });
        }
    }
    let mut resp = resp.map(|b| b.boxed());
    cors(&mut resp, allowed);
    resp
}

/// Why a request did not get an answer from the computer.
enum Failed {
    /// No stream: the link to the computer is down.
    Link(io::Error),
    /// The stream failed during the exchange.
    Exchange,
}

/// `503` with `{"detail": message, "error": "link_down"}`.
fn link_down(message: &str) -> Response<Body> {
    let body = serde_json::json!({ "detail": message, "error": "link_down" }).to_string();
    let mut r = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
    *r.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

async fn forward(req: Request<Incoming>, opener: Opener) -> Result<Response<Incoming>, Failed> {
    let stream = opener().await.map_err(Failed::Link)?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|_| Failed::Exchange)?;
    tokio::spawn(conn.with_upgrades());
    sender.send_request(req).await.map_err(|_| Failed::Exchange)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn app_origin(origin: &str) -> bool {
        origin == "tauri://localhost"
    }

    /// A stand-in computer: answers each stream with what it received, as
    /// one HTTP response (so headers that reached it can be checked).
    fn echo_computer() -> Opener {
        Arc::new(|| {
            Box::pin(async {
                let (here, there) = tokio::io::duplex(64 * 1024);
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(|req: Request<Incoming>| async move {
                        let mut seen = format!("{} {}\n", req.method(), req.uri());
                        for (k, v) in req.headers() {
                            seen += &format!("{}: {}\n", k, v.to_str().unwrap_or(""));
                        }
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(seen))))
                    });
                    let _ = hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(there), svc).await;
                });
                Ok(Box::new(here) as Box<dyn Io>)
            })
        })
    }

    async fn raw(origin: &str, request: String) -> String {
        let addr = origin.trim_start_matches("http://");
        let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        tcp.write_all(request.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tcp.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn refuses_a_missing_or_wrong_key() {
        let b = Bridge::start(echo_computer(), app_origin).await.unwrap();
        let none = raw(&b.origin, "GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".into()).await;
        assert!(none.starts_with("HTTP/1.1 401"), "{none}");
        let wrong = raw(&b.origin, "GET /api/health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer nope\r\nConnection: close\r\n\r\n".into()).await;
        assert!(wrong.starts_with("HTTP/1.1 401"), "{wrong}");
    }

    #[tokio::test]
    async fn keeps_its_port_across_restarts_and_moves_only_when_taken() {
        let first = Bridge::start(echo_computer(), app_origin).await.unwrap();
        let port: u16 = first.origin.rsplit(':').next().unwrap().parse().unwrap();
        drop(first);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let again = Bridge::start_on(echo_computer(), app_origin, Some(port)).await.unwrap();
        assert_eq!(again.origin, format!("http://127.0.0.1:{port}"));
        // Taken by the bridge still running: another one gets a new port.
        let other = Bridge::start_on(echo_computer(), app_origin, Some(port)).await.unwrap();
        assert_ne!(other.origin, again.origin);
    }

    #[tokio::test]
    async fn forwards_with_the_key_stripped_and_host_set() {
        let b = Bridge::start(echo_computer(), app_origin).await.unwrap();
        let key = b.key().to_string();
        let out = raw(
            &b.origin,
            format!("GET /api/events?a=1&_token={key} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: tauri://localhost\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n"),
        )
        .await;
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.contains("GET /api/events?a=1\n"), "{out}");
        assert!(out.contains("host: localhost\n"), "{out}");
        assert!(!out.contains(&key), "the bridge key reached the computer: {out}");
        let echoed = out.split("\r\n\r\n").nth(1).unwrap_or_default().to_ascii_lowercase();
        assert!(!echoed.contains("origin:") && !echoed.contains("authorization:"), "{out}");
        assert!(out.to_ascii_lowercase().contains("access-control-allow-origin: tauri://localhost"), "{out}");
    }

    #[tokio::test]
    async fn answers_preflights_itself_and_refuses_other_pages() {
        let b = Bridge::start(echo_computer(), app_origin).await.unwrap();
        let pre =
            raw(&b.origin, "OPTIONS /api/x HTTP/1.1\r\nHost: x\r\nOrigin: tauri://localhost\r\nAccess-Control-Request-Headers: authorization\r\nConnection: close\r\n\r\n".into())
                .await;
        assert!(pre.starts_with("HTTP/1.1 204"), "{pre}");
        assert!(pre.to_ascii_lowercase().contains("access-control-allow-headers: authorization"), "{pre}");
        let key = b.key().to_string();
        let evil = raw(&b.origin, format!("GET /api/x HTTP/1.1\r\nHost: x\r\nOrigin: https://attacker.example\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n")).await;
        assert!(evil.starts_with("HTTP/1.1 403"), "{evil}");
    }

    #[tokio::test]
    async fn a_link_that_stays_down_answers_503_with_json() {
        let gone: Opener = Arc::new(|| Box::pin(async { Err(io::Error::new(io::ErrorKind::NotConnected, "This computer is offline, or not signed in to your account.")) }));
        let b = Bridge::start(gone, app_origin).await.unwrap();
        let key = b.key().to_string();
        let out = raw(&b.origin, format!("GET / HTTP/1.1\r\nHost: x\r\nOrigin: tauri://localhost\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n")).await;
        assert!(out.starts_with("HTTP/1.1 503"), "{out}");
        assert!(out.contains(r#""error":"link_down""#), "{out}");
        assert!(out.contains("This computer is offline"), "{out}");
        assert!(out.to_ascii_lowercase().contains("access-control-allow-origin: tauri://localhost"), "{out}");
    }

    #[tokio::test]
    async fn a_request_into_a_down_link_answers_503_within_10_s() {
        use crate::link::{DownReason, Link, LinkDeps, Target};
        // A link with nothing to connect with: it never comes up.
        struct Nothing;
        impl LinkDeps for Nothing {
            fn target(&self, _: &str) -> Result<Target, DownReason> {
                Err(DownReason::Network)
            }
            fn on_problem(&self, _: crate::account_state::AccountProblem) {}
        }
        let link = Link::start(Arc::new(Nothing), "computer".into());
        let opener: Opener = Arc::new(move || {
            let link = link.clone();
            Box::pin(async move {
                link.open_stream(std::time::Duration::from_secs(10))
                    .await
                    .map(|s| Box::new(s) as Box<dyn Io>)
                    .map_err(|e| io::Error::new(io::ErrorKind::NotConnected, e.to_string()))
            })
        });
        let b = Bridge::start(opener, app_origin).await.unwrap();
        let key = b.key().to_string();
        let t = std::time::Instant::now();
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(11),
            raw(&b.origin, format!("GET /api/health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n")),
        )
        .await
        .expect("an answer within 10 s");
        assert!(out.starts_with("HTTP/1.1 503"), "{out}");
        assert!(t.elapsed() < std::time::Duration::from_secs(10));
    }
}
