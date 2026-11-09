//! The loopback bridge (plan decision D7): the web UI reaches an account
//! computer through `http://127.0.0.1:<port>`, and each request becomes one
//! stream of the end-to-end encrypted relay session.
//!
//! Only the app's own webview may use it. Every request must carry a random
//! key made when the bridge starts (`Authorization: Bearer` or `?_token=`),
//! given to the web UI as this origin's access key and never stored. The
//! bridge removes the key before the request enters the tunnel, answers CORS
//! preflights itself (the computer's connector drops `Origin`), refuses any
//! other page's origin, and passes WebSocket upgrades and event streams
//! through unbuffered.

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

/// The query parameter the web UI uses where it cannot set a header
/// (EventSource, WebSocket), as the server names it.
pub const KEY_PARAM: &str = "_token";

/// The webview origins of the mobile app (iOS, then Android).
pub const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// A byte stream to the computer: one relay stream per request.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Io for T {}

pub type OpenFuture = Pin<Box<dyn Future<Output = io::Result<Box<dyn Io>>> + Send>>;
pub type Opener = Arc<dyn Fn() -> OpenFuture + Send + Sync>;

type Body = BoxBody<Bytes, hyper::Error>;

/// A running bridge. Dropping it stops accepting connections.
pub struct Bridge {
    pub origin: String,
    key: Arc<Zeroizing<String>>,
    task: tokio::task::JoinHandle<()>,
}

impl std::fmt::Debug for Bridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Bridge({}, key [redacted])", self.origin)
    }
}

impl Bridge {
    pub async fn start(opener: Opener) -> io::Result<Bridge> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        let raw: [u8; 32] = openagentd_cloud::keys::random_bytes();
        let key = Arc::new(Zeroizing::new(
            raw.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        ));
        let k = key.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, peer)) = listener.accept().await else {
                    continue;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let _ = tcp.set_nodelay(true);
                let key = k.clone();
                let opener = opener.clone();
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |req| {
                        let key = key.clone();
                        let opener = opener.clone();
                        async move { Ok::<_, Infallible>(handle(req, &key, opener).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tcp), svc)
                        .with_upgrades()
                        .await;
                });
            }
        });
        Ok(Bridge { origin, key, task })
    }

    pub fn key(&self) -> &str {
        self.key.as_str()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn text(status: StatusCode, body: &'static str) -> Response<Body> {
    let mut r = Response::new(
        Full::new(Bytes::from_static(body.as_bytes()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r
}

fn cors(resp: &mut Response<Body>, origin: Option<&str>) {
    let Some(origin) = origin.and_then(|o| HeaderValue::from_str(o).ok()) else {
        return;
    };
    let h = resp.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    h.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    h.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Accept-Ranges, Content-Range, Content-Length, ETag"),
    );
    h.append(header::VARY, HeaderValue::from_static("Origin"));
}

fn preflight(origin: Option<&str>, req: &Request<Incoming>) -> Response<Body> {
    let mut r = text(StatusCode::NO_CONTENT, "");
    r.headers_mut().remove(header::CONTENT_TYPE);
    cors(&mut r, origin);
    let h = r.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    if let Some(asked) = req.headers().get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, asked.clone());
    }
    h.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    r
}

/// The key the request presents, if any.
fn presented(req: &Request<Incoming>) -> Option<String> {
    if let Some(v) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(t) = v
            .strip_prefix("Bearer ")
            .or_else(|| v.strip_prefix("bearer "))
        {
            return Some(t.trim().to_string());
        }
    }
    let q = req.uri().query()?;
    form_urlencoded::parse(q.as_bytes())
        .find(|(k, _)| k == KEY_PARAM)
        .map(|(_, v)| v.into_owned())
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
        let kept: Vec<(String, String)> = form_urlencoded::parse(q.as_bytes())
            .filter(|(k, _)| k != KEY_PARAM)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let new_q = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(kept)
            .finish();
        let path = req.uri().path().to_string();
        let pq = if new_q.is_empty() {
            path
        } else {
            format!("{path}?{new_q}")
        };
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

async fn handle(mut req: Request<Incoming>, key: &str, opener: Opener) -> Response<Body> {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let allowed = origin.as_deref().filter(|o| APP_ORIGINS.contains(o));
    if origin.is_some() && allowed.is_none() {
        // Another page on this phone: never forwarded, whatever it sends.
        return text(StatusCode::FORBIDDEN, "Forbidden");
    }
    if req.method() == Method::OPTIONS {
        return preflight(allowed, &req);
    }
    let ok = presented(&req).is_some_and(|p| bool::from(p.as_bytes().ct_eq(key.as_bytes())));
    if !ok {
        let mut r = text(StatusCode::UNAUTHORIZED, "Unauthorized");
        cors(&mut r, allowed);
        return r;
    }
    strip(&mut req);
    let upgrade = req
        .headers()
        .contains_key(header::UPGRADE)
        .then(|| hyper::upgrade::on(&mut req));
    let mut resp = match forward(req, opener).await {
        Ok(r) => r,
        Err(_) => {
            let mut r = text(
                StatusCode::BAD_GATEWAY,
                "This computer cannot be reached through your account right now.",
            );
            cors(&mut r, allowed);
            return r;
        }
    };
    if resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(from_page) = upgrade {
            let to_computer = hyper::upgrade::on(&mut resp);
            tokio::spawn(async move {
                if let (Ok(a), Ok(b)) = tokio::join!(from_page, to_computer) {
                    let _ =
                        tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b))
                            .await;
                }
            });
        }
    }
    let mut resp = resp.map(|b| b.boxed());
    cors(&mut resp, allowed);
    resp
}

async fn forward(req: Request<Incoming>, opener: Opener) -> io::Result<Response<Incoming>> {
    let stream = opener().await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(io::Error::other)?;
    tokio::spawn(conn.with_upgrades());
    sender.send_request(req).await.map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
                    let _ = hyper::server::conn::http1::Builder::new()
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(there), svc)
                        .await;
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
        let b = Bridge::start(echo_computer()).await.unwrap();
        let none = raw(
            &b.origin,
            "GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".into(),
        )
        .await;
        assert!(none.starts_with("HTTP/1.1 401"), "{none}");
        let wrong = raw(&b.origin, "GET /api/health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer nope\r\nConnection: close\r\n\r\n".into()).await;
        assert!(wrong.starts_with("HTTP/1.1 401"), "{wrong}");
    }

    #[tokio::test]
    async fn forwards_with_the_key_stripped_and_host_set() {
        let b = Bridge::start(echo_computer()).await.unwrap();
        let key = b.key().to_string();
        let out = raw(
            &b.origin,
            format!("GET /api/events?a=1&_token={key} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: tauri://localhost\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n"),
        )
        .await;
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.contains("GET /api/events?a=1\n"), "{out}");
        assert!(out.contains("host: localhost\n"), "{out}");
        assert!(
            !out.contains(&key),
            "the bridge key reached the computer: {out}"
        );
        let echoed = out
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            !echoed.contains("origin:") && !echoed.contains("authorization:"),
            "{out}"
        );
        assert!(
            out.to_ascii_lowercase()
                .contains("access-control-allow-origin: tauri://localhost"),
            "{out}"
        );
    }

    #[tokio::test]
    async fn answers_preflights_itself_and_refuses_other_pages() {
        let b = Bridge::start(echo_computer()).await.unwrap();
        let pre = raw(&b.origin, "OPTIONS /api/x HTTP/1.1\r\nHost: x\r\nOrigin: tauri://localhost\r\nAccess-Control-Request-Headers: authorization\r\nConnection: close\r\n\r\n".into()).await;
        assert!(pre.starts_with("HTTP/1.1 204"), "{pre}");
        assert!(
            pre.to_ascii_lowercase()
                .contains("access-control-allow-headers: authorization"),
            "{pre}"
        );
        let key = b.key().to_string();
        let evil = raw(&b.origin, format!("GET /api/x HTTP/1.1\r\nHost: x\r\nOrigin: https://attacker.example\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n")).await;
        assert!(evil.starts_with("HTTP/1.1 403"), "{evil}");
    }

    #[tokio::test]
    async fn a_closed_session_answers_bad_gateway() {
        let gone: Opener = Arc::new(|| Box::pin(async { Err(io::Error::other("closed")) }));
        let b = Bridge::start(gone).await.unwrap();
        let key = b.key().to_string();
        let out = raw(&b.origin, format!("GET / HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n")).await;
        assert!(out.starts_with("HTTP/1.1 502"), "{out}");
    }
}
