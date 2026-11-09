//! HTTP middleware stack and desktop-token auth.
//!
//! Layer order mirrors v2's `add_middleware` sequence (last added =
//! outermost): CORS → SecurityHeaders → DesktopToken → TagPeer →
//! SkipGzipForLoopback → GZip → RequestSizeLimit → NetworkBindGuard → router.

use crate::util::json_status;
use appv3_core::auth::{
    authority_host, configured_access_token, constant_time_eq, is_first_party_origin, is_local_host_name, is_loopback_host, path_is_api, path_is_exempt, QS_TOKEN_PARAM,
};
use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{header, HeaderName, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;

pub const DEFAULT_MAX_BYTES: u64 = 56 * 1024 * 1024;

/// Per-connection addresses (uvicorn's `scope["server"]` / `scope["client"]`).
#[derive(Clone, Copy, Debug)]
pub struct ConnInfo {
    pub local: Option<SocketAddr>,
    pub remote: Option<SocketAddr>,
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, tokio::net::TcpListener>> for ConnInfo {
    fn connect_info(stream: axum::serve::IncomingStream<'_, tokio::net::TcpListener>) -> Self {
        ConnInfo { local: stream.io().local_addr().ok(), remote: Some(*stream.remote_addr()) }
    }
}

/// A TCP listener whose connections have Nagle's algorithm off. SSE frames
/// (one per streamed token) are tiny writes; with Nagle on, the kernel can
/// hold each one back until the previous write is ACKed, which adds delay
/// and jitter to streaming. axum leaves `TCP_NODELAY` unset.
pub struct NoDelayTcpListener(pub tokio::net::TcpListener);

impl axum::serve::Listener for NoDelayTcpListener {
    type Io = tokio::net::TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, addr) = axum::serve::Listener::accept(&mut self.0).await;
        if let Err(e) = io.set_nodelay(true) {
            tracing::debug!("tcp_nodelay_failed remote={} error={}", addr, e);
        }
        (io, addr)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, NoDelayTcpListener>> for ConnInfo {
    fn connect_info(stream: axum::serve::IncomingStream<'_, NoDelayTcpListener>) -> Self {
        ConnInfo { local: stream.io().local_addr().ok(), remote: Some(*stream.remote_addr()) }
    }
}

fn is_ws_upgrade(req: &Request) -> bool {
    req.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).map(|v| v.eq_ignore_ascii_case("websocket")).unwrap_or(false)
}

/// Where a request came from, for gzip and for the transfer logs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Peer {
    /// The TCP peer is on this machine.
    pub loopback: bool,
    /// The request carries proxy headers: a local reverse proxy or tunnel
    /// relaying it for a remote user.
    pub proxied: bool,
}

impl Peer {
    pub fn of(req: &Request) -> Self {
        let loopback = req.extensions().get::<ConnectInfo<ConnInfo>>().and_then(|c| c.0.remote).is_some_and(|a| a.ip().to_canonical().is_loopback());
        let h = req.headers();
        // A relayed request is remote: its bytes cross the relay.
        let relayed = req.extensions().get::<RelayPeer>().is_some();
        let proxied = relayed || h.contains_key(header::FORWARDED) || h.contains_key("x-forwarded-for") || h.contains_key(header::VIA);
        Peer { loopback: loopback && !relayed, proxied }
    }

    /// The bytes cross a network to reach the user.
    pub fn remote(&self) -> bool {
        !self.loopback || self.proxied
    }
}

/// Records the request's [`Peer`] for handlers, and labels an SSE response's
/// transfer counters with its path and peer, so `sse_stream_close` says
/// which stream it was and whether it went over the network.
pub async fn tag_peer(mut req: Request, next: Next) -> Response {
    let peer = Peer::of(&req);
    let path = req.uri().path().to_string();
    req.extensions_mut().insert(peer);
    let resp = next.run(req).await;
    if let Some(stats) = resp.extensions().get::<Arc<crate::sse::SseStats>>() {
        stats.label(format!("path={} remote={}", path, peer.remote()));
    }
    resp
}

/// Closing a WebSocket before `accept()` makes the ASGI server answer the
/// handshake with HTTP 403.
/// uvicorn's reply: `403`, empty `text/plain; charset=utf-8`, `Connection: close`.
pub fn ws_reject() -> Response {
    let mut r = (StatusCode::FORBIDDEN, Body::empty()).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    h.insert(header::CONNECTION, HeaderValue::from_static("close"));
    r
}

fn detail(status: StatusCode, msg: &str) -> Response {
    json_status(status, &json!({"detail": msg}))
}

// ── NetworkBindGuard ────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Policy {
    pub token: Arc<String>,
    pub allow_insecure_lan: bool,
    pub max_bytes: u64,
    /// Access key of the desktop's LAN listener (`network_access`), accepted
    /// alongside `token` only while that listener is open.
    pub network_key: Arc<std::sync::RwLock<Option<String>>>,
}

/// Which secret authenticated a request; set by [`desktop_token`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticatedBy {
    DesktopToken,
    NetworkKey,
    /// A device of this server's OpenAgentd Cloud account, through the
    /// relay: authenticated by the Noise session against the verified
    /// roster (`cloud::connector`). Same rights as `NetworkKey`.
    RelayDevice,
}

/// Marks a request the cloud connector serves in-process for a relayed
/// device. Only `cloud::connector` attaches it; no header can produce it.
/// Such a request has no `ConnectInfo`, so it never counts as loopback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayPeer {
    pub device_id: String,
}

impl Policy {
    pub fn from_env() -> Self {
        let token = configured_access_token();
        if !token.is_empty() {
            tracing::info!("desktop_token_auth_enabled token_len={}", token.len());
        }
        Policy { token: Arc::new(token), allow_insecure_lan: appv3_core::settings().api_allow_insecure_lan, max_bytes: DEFAULT_MAX_BYTES, network_key: Arc::default() }
    }

    /// Install or clear the LAN listener's access key.
    pub fn set_network_key(&self, key: Option<String>) {
        *self.network_key.write().unwrap_or_else(|e| e.into_inner()) = key;
    }

    /// Which configured secret `presented` matches, compared in constant time.
    pub fn authenticate(&self, presented: &str) -> Option<AuthenticatedBy> {
        if !self.token.is_empty() && constant_time_eq(presented, &self.token) {
            return Some(AuthenticatedBy::DesktopToken);
        }
        let key = self.network_key.read().unwrap_or_else(|e| e.into_inner());
        key.as_deref().filter(|k| !k.is_empty() && constant_time_eq(presented, k)).map(|_| AuthenticatedBy::NetworkKey)
    }

    /// No access key and no `OPENAGENTD_ALLOW_INSECURE_LAN` opt-out: only loopback
    /// callers reach the API and nothing authenticates them, so browser
    /// requests are screened by `Origin`/`Host` instead.
    pub fn trusts_loopback_callers(&self) -> bool {
        self.token.is_empty() && !self.allow_insecure_lan
    }
}

/// DNS-rebinding guard: a page on `attacker.example` whose name now resolves
/// to 127.0.0.1 sends same-origin requests (no `Origin` on GET) carrying its
/// own `Host`. `None` when the header is absent (non-browser clients).
fn foreign_host(req: &Request) -> Option<String> {
    let raw = req.headers().get(header::HOST).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).or_else(|| req.uri().authority().map(|a| a.to_string()))?;
    (!authority_host(raw.trim()).is_some_and(is_local_host_name)).then_some(raw)
}

pub async fn network_bind_guard(policy: axum::extract::State<Policy>, req: Request, next: Next) -> Response {
    if !policy.token.is_empty() || policy.allow_insecure_lan {
        return next.run(req).await;
    }
    let host = req.extensions().get::<ConnectInfo<ConnInfo>>().and_then(|c| c.0.local).map(|a| a.ip().to_string());
    if let Some(h) = host.filter(|h| !is_loopback_host(h)) {
        tracing::error!("non_loopback_bind_rejected host={}", h);
        if is_ws_upgrade(&req) {
            return ws_reject();
        }
        return detail(StatusCode::SERVICE_UNAVAILABLE, "Non-loopback binding requires an access key.");
    }
    if let Some(h) = foreign_host(&req) {
        tracing::warn!("foreign_host_rejected host={:?}", h);
        if is_ws_upgrade(&req) {
            return ws_reject();
        }
        return detail(StatusCode::FORBIDDEN, "Host not allowed.");
    }
    next.run(req).await
}

// ── RequestSizeLimit ────────────────────────────────────────────────────────

pub async fn request_size_limit(policy: axum::extract::State<Policy>, req: Request, next: Next) -> Response {
    if !is_ws_upgrade(&req) {
        if let Some(len) = req.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<i128>().ok()) {
            if len > policy.max_bytes as i128 {
                tracing::warn!("request_too_large content_length={} limit={}", len, policy.max_bytes);
                return detail(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large.");
            }
        }
    }
    let resp = next.run(req).await;
    // Streamed bodies that overflow are cut by `DefaultBodyLimit`; surface
    // them with v2's JSON 413 rather than axum's plain-text rejection.
    if resp.status() == StatusCode::PAYLOAD_TOO_LARGE && resp.headers().get(header::CONTENT_TYPE).map(|v| v.as_bytes().starts_with(b"text/plain")).unwrap_or(false) {
        tracing::warn!("request_too_large received_bytes>limit limit={}", policy.max_bytes);
        return detail(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large.");
    }
    resp
}

// ── DesktopToken ────────────────────────────────────────────────────────────

fn extract_token(req: &Request) -> Option<String> {
    if let Some(v) = req.headers().get(header::AUTHORIZATION) {
        let raw = String::from_utf8_lossy(v.as_bytes()).to_string();
        let (scheme, token) = raw.split_once(' ').unwrap_or((raw.as_str(), ""));
        if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() {
            return Some(token.trim().to_string());
        }
    }
    let q = req.uri().query().unwrap_or("");
    if q.contains(QS_TOKEN_PARAM) {
        for (k, v) in form_urlencoded::parse(q.as_bytes()) {
            if k == QS_TOKEN_PARAM && !v.is_empty() {
                return Some(v.into_owned());
            }
        }
    }
    None
}

fn strip_token(req: &mut Request) {
    let Some(q) = req.uri().query() else { return };
    if !q.contains(QS_TOKEN_PARAM) {
        return;
    }
    let kept: Vec<(String, String)> = form_urlencoded::parse(q.as_bytes()).filter(|(k, _)| k != QS_TOKEN_PARAM).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let new_q = form_urlencoded::Serializer::new(String::new()).extend_pairs(kept).finish();
    let path = req.uri().path().to_string();
    let pq = if new_q.is_empty() { path } else { format!("{path}?{new_q}") };
    let mut parts = req.uri().clone().into_parts();
    if let Ok(v) = pq.parse() {
        parts.path_and_query = Some(v);
        if let Ok(u) = Uri::from_parts(parts) {
            *req.uri_mut() = u;
        }
    }
}

pub async fn desktop_token(policy: axum::extract::State<Policy>, mut req: Request, next: Next) -> Response {
    // A relayed device is authenticated by its session, never by a key it
    // sent (the connector removed any).
    if req.extensions().get::<RelayPeer>().is_some() {
        req.extensions_mut().insert(AuthenticatedBy::RelayDevice);
        strip_token(&mut req);
        return next.run(req).await;
    }
    if policy.token.is_empty() {
        return next.run(req).await;
    }
    let path = req.uri().path().to_string();
    if is_ws_upgrade(&req) {
        if !path_is_api(&path) {
            return ws_reject();
        }
        let presented = extract_token(&req);
        match presented.as_deref().and_then(|t| policy.authenticate(t)) {
            Some(by) => {
                req.extensions_mut().insert(by);
            }
            None => {
                tracing::warn!("desktop_token_rejected_ws path={} has_token={}", path, presented.is_some());
                return ws_reject();
            }
        }
        strip_token(&mut req);
        return next.run(req).await;
    }
    if path_is_exempt(&path) {
        return next.run(req).await;
    }
    let presented = extract_token(&req);
    match presented.as_deref().and_then(|t| policy.authenticate(t)) {
        Some(by) => {
            req.extensions_mut().insert(by);
        }
        None => {
            tracing::warn!("desktop_token_rejected path={} has_token={}", path, presented.is_some());
            return detail(StatusCode::UNAUTHORIZED, "Unauthorized — OpenAgentd access key required.");
        }
    }
    strip_token(&mut req);
    next.run(req).await
}

// ── SecurityHeaders ─────────────────────────────────────────────────────────

// `frame-src` admits the built-in web preview, which runs on its own
// loopback listener (`appv3-preview`).
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'self' http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

const SECURITY_HEADERS: [(&str, &str); 7] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("permissions-policy", "geolocation=(), camera=(), microphone=(), payment=()"),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "cross-origin"),
    ("content-security-policy", CSP),
];

pub async fn security_headers(req: Request, next: Next) -> Response {
    if is_ws_upgrade(&req) {
        return next.run(req).await;
    }
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    for (k, v) in SECURITY_HEADERS {
        let name = HeaderName::from_static(k);
        if !h.contains_key(&name) {
            h.insert(name, HeaderValue::from_static(v));
        }
    }
    resp
}

// ── CORS ────────────────────────────────────────────────────────────────────

/// Port of Starlette's `CORSMiddleware` as configured by v2
/// (`allow_credentials=True`, `allow_methods=["*"]`, `allow_headers=["*"]`,
/// `expose_headers=[Accept-Ranges, Content-Range, Content-Length]`,
/// `max_age=600`), plus `ETag` exposed so a cross-origin client (the phone
/// app's `tauri://localhost`) can revalidate with `If-None-Match`. Requests
/// without `Origin` pass through untouched.
///
/// Allowed origins: first-party clients (Tauri webviews, loopback pages),
/// every entry of `OPENAGENTD_CORS_ORIGINS`, and — when it is unset — any
/// origin if an access key protects the server. Without a key the server
/// trusts its loopback callers, so a disallowed origin is refused outright:
/// a "simple" cross-site POST skips the preflight and would otherwise run.
#[derive(Clone)]
pub struct Cors {
    origins: Arc<Vec<String>>,
    allow_all: bool,
    reject_disallowed: bool,
}

impl Cors {
    pub fn new(configured: Option<&[String]>, policy: &Policy) -> Self {
        let loopback_only = policy.trusts_loopback_callers();
        let allow_all = match configured {
            Some(list) => list.iter().any(|o| o == "*"),
            None => !loopback_only,
        };
        Self { allow_all, origins: Arc::new(configured.unwrap_or_default().to_vec()), reject_disallowed: loopback_only }
    }
    fn allowed(&self, origin: &str) -> bool {
        self.allow_all || is_first_party_origin(origin) || self.origins.iter().any(|o| o == origin)
    }
}

const CORS_METHODS: [&str; 7] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

fn hv(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn add_vary_origin(h: &mut axum::http::HeaderMap) {
    let v = match h.get(header::VARY).and_then(|v| v.to_str().ok()) {
        Some(existing) => format!("{existing}, Origin"),
        None => "Origin".into(),
    };
    h.insert(header::VARY, hv(&v));
}

pub async fn cors(axum::extract::State(c): axum::extract::State<Cors>, req: Request, next: Next) -> Response {
    let Some(origin) = req.headers().get(header::ORIGIN).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()) else {
        return next.run(req).await;
    };
    let rh = req.headers();
    if req.method() == axum::http::Method::OPTIONS && rh.contains_key(header::ACCESS_CONTROL_REQUEST_METHOD) {
        // preflight_response(); preflight_explicit_allow_origin is always true
        // here because allow_credentials=True.
        let method = String::from_utf8_lossy(rh[header::ACCESS_CONTROL_REQUEST_METHOD].as_bytes()).into_owned();
        let req_headers = rh.get(header::ACCESS_CONTROL_REQUEST_HEADERS).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
        let private = rh.contains_key("access-control-request-private-network");
        let mut failures: Vec<&str> = vec![];
        let mut resp_headers: Vec<(HeaderName, HeaderValue)> = vec![
            (header::VARY, hv("Origin")),
            (header::ACCESS_CONTROL_ALLOW_METHODS, hv(&CORS_METHODS.join(", "))),
            (header::ACCESS_CONTROL_MAX_AGE, hv("600")),
            (header::ACCESS_CONTROL_ALLOW_CREDENTIALS, hv("true")),
        ];
        if c.allowed(&origin) {
            resp_headers.push((header::ACCESS_CONTROL_ALLOW_ORIGIN, hv(&origin)));
        } else {
            failures.push("origin");
        }
        if !CORS_METHODS.contains(&method.as_str()) {
            failures.push("method");
        }
        if let Some(h) = req_headers {
            resp_headers.push((header::ACCESS_CONTROL_ALLOW_HEADERS, hv(&h)));
        }
        if private {
            failures.push("private-network");
        }
        let (status, text) = if failures.is_empty() { (StatusCode::OK, "OK".to_string()) } else { (StatusCode::BAD_REQUEST, format!("Disallowed CORS {}", failures.join(", "))) };
        // Each preflight is a round trip (and, through a relay, a billed
        // message); the browser caches it per URL for `max-age`.
        tracing::debug!("cors_preflight path={} method={} ok={}", req.uri().path(), method, failures.is_empty());
        let mut resp = Response::new(Body::from(text.clone()));
        *resp.status_mut() = status;
        let h = resp.headers_mut();
        for (k, v) in resp_headers {
            h.insert(k, v);
        }
        h.insert(header::CONTENT_LENGTH, hv(&text.len().to_string()));
        h.insert(header::CONTENT_TYPE, hv("text/plain; charset=utf-8"));
        return resp;
    }
    if c.reject_disallowed && !c.allowed(&origin) {
        tracing::warn!("cross_origin_request_rejected origin={:?} path={}", origin, req.uri().path());
        if is_ws_upgrade(&req) {
            return ws_reject();
        }
        return detail(StatusCode::FORBIDDEN, "Cross-origin request refused. Protect the server with an access key or add this origin to OPENAGENTD_CORS_ORIGINS.");
    }
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, hv("true"));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, hv("Accept-Ranges, Content-Range, Content-Length, ETag"));
    if c.allowed(&origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, hv(&origin));
        add_vary_origin(h);
    }
    resp
}

// ── GZip ────────────────────────────────────────────────────────────────────

pub fn gzip_layer() -> tower_http::compression::CompressionLayer<impl tower_http::compression::Predicate> {
    use tower_http::compression::predicate::{NotForContentType, Predicate, SizeAbove};
    use tower_http::CompressionLevel;
    // Media and archives are already compressed; gzipping them again burns
    // CPU for nothing. Fastest keeps most of the ratio on JSON at about a
    // quarter of the default level's cost, and the server is usually local.
    let worth_compressing = |_: StatusCode, _: axum::http::Version, h: &axum::http::HeaderMap, _: &axum::http::Extensions| {
        let ct = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        let compressed_already = (ct.starts_with("image/") && !ct.starts_with("image/svg"))
            || [
                "video/",
                "audio/",
                "font/woff",
                "application/zip",
                "application/gzip",
                "application/x-gzip",
                "application/pdf",
                "application/octet-stream",
                "application/x-7z",
                "application/x-rar",
                "application/zstd",
            ]
            .iter()
            .any(|p| ct.starts_with(p));
        !compressed_already
    };
    // Only `compression-gzip` is compiled in, so gzip is the only encoding
    // the layer can negotiate.
    tower_http::compression::CompressionLayer::new()
        .quality(CompressionLevel::Fastest)
        .compress_when(SizeAbove::new(1000).and(NotForContentType::SSE).and(NotForContentType::GRPC).and(worth_compressing))
}

/// Sends identity bodies to clients on this machine. On loopback, gzip at
/// Fastest nearly doubles a 1.3 MB history page's latency (4.6 → 8.2 ms) and
/// server CPU, and the client still has to inflate it. A request with
/// proxy headers came through a local reverse proxy or tunnel for a remote
/// user, so it keeps gzip. Runs outside `gzip_layer`, which then sees no
/// `Accept-Encoding` and leaves the body alone.
pub async fn skip_gzip_for_loopback(mut req: Request, next: Next) -> Response {
    if !Peer::of(&req).remote() {
        req.headers_mut().remove(header::ACCEPT_ENCODING);
    }
    next.run(req).await
}

/// Whether an `Accept-Encoding` value takes gzip (and does not refuse it with `q=0`).
fn accepts_gzip(value: &str) -> bool {
    value.split(',').any(|item| {
        let mut parts = item.split(';').map(str::trim);
        parts.next().is_some_and(|name| name.eq_ignore_ascii_case("gzip"))
            && !parts.any(|p| p.strip_prefix("q=").and_then(|q| q.trim().parse::<f32>().ok()).is_some_and(|q| q <= 0.0))
    })
}

/// Gzips event streams for remote clients, which `gzip_layer` leaves alone
/// because a compressor holds bytes back until it has enough to work with.
/// Here every frame is followed by a sync flush, so the client reads it the
/// moment it is sent, and one deflate context lives as long as the stream:
/// the event names and JSON keys that repeat in every frame cost a few
/// bytes after the first. Loopback requests arrive without
/// `Accept-Encoding` (`skip_gzip_for_loopback`) and stay identity.
pub async fn gzip_event_stream(req: Request, next: Next) -> Response {
    let wants_gzip = req.headers().get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).is_some_and(accepts_gzip);
    let resp = next.run(req).await;
    let is_event_stream =
        resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| ct.trim_start().to_ascii_lowercase().starts_with("text/event-stream"));
    if !wants_gzip || !is_event_stream || resp.headers().contains_key(header::CONTENT_ENCODING) {
        return resp;
    }
    let (mut parts, body) = resp.into_parts();
    parts.headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    parts.headers.append(header::VARY, HeaderValue::from_static("accept-encoding"));
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, gzip_frames(body))
}

/// Bytes in and out of one gzipped event stream, logged when it ends
/// (`sse_gzip_closed`) however it ends.
struct GzipTally {
    raw: u64,
    sent: u64,
}

impl Drop for GzipTally {
    fn drop(&mut self) {
        tracing::info!("sse_gzip_closed raw_bytes={} sent_bytes={}", self.raw, self.sent);
    }
}

fn gzip_frames(body: Body) -> Body {
    use futures::StreamExt;
    use std::io::Write;
    let mut frames = body.into_data_stream();
    Body::from_stream(async_stream::stream! {
        let mut tally = GzipTally { raw: 0, sent: 0 };
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        while let Some(frame) = frames.next().await {
            let frame = match frame {
                Ok(f) => f,
                Err(e) => {
                    yield Err(std::io::Error::other(e));
                    return;
                }
            };
            tally.raw += frame.len() as u64;
            // `flush` is a deflate sync flush: everything written so far
            // becomes decodable without ending the stream.
            if let Err(e) = gz.write_all(&frame).and_then(|_| gz.flush()) {
                yield Err(e);
                return;
            }
            let out = std::mem::take(gz.get_mut());
            tally.sent += out.len() as u64;
            yield Ok(bytes::Bytes::from(out));
        }
        match gz.finish() {
            Ok(rest) => {
                tally.sent += rest.len() as u64;
                yield Ok(bytes::Bytes::from(rest));
            }
            Err(e) => yield Err(e),
        }
    })
}

// ── Panics ──────────────────────────────────────────────────────────────────

fn panic_response(payload: Box<dyn std::any::Any + Send + 'static>) -> Response {
    tracing::error!("request_handler_panicked panic={}", appv3_core::panic_message(payload.as_ref()));
    crate::ApiError::internal("handler panicked").into_response()
}

/// A panicking handler answers `500 Internal Server Error` (Starlette's
/// `ServerErrorMiddleware` text) instead of dropping the connection.
pub fn catch_panic_layer() -> tower_http::catch_panic::CatchPanicLayer<fn(Box<dyn std::any::Any + Send + 'static>) -> Response> {
    tower_http::catch_panic::CatchPanicLayer::custom(panic_response as fn(_) -> Response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    /// `Content-Encoding` the gzip layer gives a 4 KB body of `content_type`.
    async fn encoding_for(content_type: &'static str, partial: bool) -> Option<String> {
        let app = axum::Router::new()
            .route(
                "/f",
                axum::routing::get(move || async move {
                    let mut r = Response::new(Body::from("a".repeat(4096)));
                    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
                    if partial {
                        *r.status_mut() = StatusCode::PARTIAL_CONTENT;
                        r.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_static("bytes 0-4095/9000"));
                    }
                    r
                }),
            )
            .layer(gzip_layer());
        let req = Request::get("/f").header(header::ACCEPT_ENCODING, "gzip").body(Body::empty()).unwrap();
        let resp = app.oneshot(req).await.unwrap();
        resp.headers().get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn gzip_covers_text_and_skips_already_compressed_media() {
        for ct in ["application/json", "text/html; charset=utf-8", "image/svg+xml", "application/javascript"] {
            assert_eq!(encoding_for(ct, false).await.as_deref(), Some("gzip"), "{ct}");
        }
        for ct in ["image/png", "image/jpeg", "video/mp4", "audio/mpeg", "application/zip", "application/pdf", "application/octet-stream", "font/woff2", "text/event-stream"] {
            assert_eq!(encoding_for(ct, false).await, None, "{ct}");
        }
    }

    #[tokio::test]
    async fn gzip_leaves_partial_content_alone() {
        // Content-Range counts identity bytes; encoding the slice breaks seeking.
        assert_eq!(encoding_for("application/json", true).await, None);
    }

    /// `Content-Encoding` for a 4 KB JSON body sent from `peer`, through the
    /// same layer order as `create_app`, with optional extra request headers.
    async fn encoding_from(peer: Option<&str>, extra: &[(&'static str, &'static str)]) -> Option<String> {
        let app = axum::Router::new()
            .route("/f", axum::routing::get(|| async { ([(header::CONTENT_TYPE, "application/json")], "a".repeat(4096)) }))
            .layer(gzip_layer())
            .layer(axum::middleware::from_fn(skip_gzip_for_loopback));
        let mut req = Request::get("/f").header(header::ACCEPT_ENCODING, "gzip");
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        let mut req = req.body(Body::empty()).unwrap();
        if let Some(p) = peer {
            req.extensions_mut().insert(ConnectInfo(ConnInfo { local: None, remote: Some(p.parse().unwrap()) }));
        }
        let resp = app.oneshot(req).await.unwrap();
        resp.headers().get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn loopback_clients_get_identity_responses() {
        assert_eq!(encoding_from(Some("127.0.0.1:50000"), &[]).await, None);
        assert_eq!(encoding_from(Some("[::1]:50000"), &[]).await, None);
        assert_eq!(encoding_from(Some("[::ffff:127.0.0.1]:50000"), &[]).await, None);
    }

    #[tokio::test]
    async fn remote_and_proxied_clients_keep_gzip() {
        assert_eq!(encoding_from(Some("192.168.1.20:50000"), &[]).await.as_deref(), Some("gzip"));
        assert_eq!(encoding_from(None, &[]).await.as_deref(), Some("gzip"));
        // A reverse proxy or tunnel on this machine connects from loopback but
        // relays to remote users, who still need the smaller body.
        for h in [("x-forwarded-for", "203.0.113.7"), ("forwarded", "for=203.0.113.7"), ("via", "1.1 proxy")] {
            assert_eq!(encoding_from(Some("127.0.0.1:50000"), &[h]).await.as_deref(), Some("gzip"), "{}", h.0);
        }
    }

    /// An event stream from `peer` whose frames the test sends one at a time,
    /// through the same layer order as `create_app`.
    async fn event_stream_from(peer: &str, accept: Option<&'static str>) -> (tokio::sync::mpsc::UnboundedSender<&'static str>, Response) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
        let rx = Arc::new(std::sync::Mutex::new(Some(rx)));
        let app = axum::Router::new()
            .route(
                "/s",
                axum::routing::get(move || {
                    let rx = rx.lock().unwrap().take().unwrap();
                    async move {
                        use futures::StreamExt;
                        let frames = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(|f| Ok::<_, std::io::Error>(bytes::Bytes::from_static(f.as_bytes())));
                        ([(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")], Body::from_stream(frames))
                    }
                }),
            )
            .layer(gzip_layer())
            .layer(axum::middleware::from_fn(gzip_event_stream))
            .layer(axum::middleware::from_fn(skip_gzip_for_loopback));
        let mut req = Request::get("/s");
        if let Some(a) = accept {
            req = req.header(header::ACCEPT_ENCODING, a);
        }
        let mut req = req.body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: None, remote: Some(peer.parse().unwrap()) }));
        (tx, app.oneshot(req).await.unwrap())
    }

    async fn next_bytes(body: &mut Body) -> Option<bytes::Bytes> {
        use http_body_util::BodyExt;
        loop {
            match body.frame().await {
                None => return None,
                Some(f) => {
                    if let Ok(d) = f.unwrap().into_data() {
                        return Some(d);
                    }
                }
            }
        }
    }

    /// A remote client's event stream is gzipped, and every frame can be read
    /// as soon as it is sent: a frame held in the compressor until more text
    /// arrived would stall the reply on the phone.
    #[tokio::test]
    async fn remote_event_streams_are_gzipped_and_readable_frame_by_frame() {
        use std::io::Write;
        let (tx, resp) = event_stream_from("192.168.1.20:50000", Some("gzip, deflate, br")).await;
        assert_eq!(resp.headers().get(header::CONTENT_ENCODING).unwrap(), "gzip");
        assert!(resp.headers().get(header::CONTENT_LENGTH).is_none());
        let mut body = resp.into_body();
        let mut inflate = flate2::write::GzDecoder::new(Vec::new());
        for frame in ["event: message\ndata: {\"text\":\"Hello\"}\n\n", "event: message\ndata: {\"text\":\" world\"}\n\n", ": ping\r\n\r\n"] {
            tx.send(frame).unwrap();
            inflate.write_all(&next_bytes(&mut body).await.unwrap()).unwrap();
            inflate.flush().unwrap();
            assert_eq!(String::from_utf8(std::mem::take(inflate.get_mut())).unwrap(), frame);
        }
        drop(tx);
        while let Some(rest) = next_bytes(&mut body).await {
            inflate.write_all(&rest).unwrap();
        }
        assert!(inflate.finish().unwrap().is_empty(), "the stream ends with a complete gzip trailer");
    }

    #[tokio::test]
    async fn event_streams_stay_identity_on_loopback_or_without_gzip() {
        for (peer, accept) in [("127.0.0.1:50000", Some("gzip")), ("192.168.1.20:50000", None), ("192.168.1.20:50000", Some("gzip;q=0, br"))] {
            let (tx, resp) = event_stream_from(peer, accept).await;
            assert!(resp.headers().get(header::CONTENT_ENCODING).is_none(), "{peer} {accept:?}");
            let mut body = resp.into_body();
            tx.send("data: x\n\n").unwrap();
            assert_eq!(next_bytes(&mut body).await.unwrap(), "data: x\n\n");
        }
    }

    /// The label `tag_peer` gives an SSE response from `peer`.
    async fn sse_label_from(peer: &str, extra: &[(&'static str, &'static str)]) -> Option<String> {
        let app = axum::Router::new().route("/s", axum::routing::get(|| async { crate::sse::sse_response(futures::stream::empty()) })).layer(axum::middleware::from_fn(tag_peer));
        let mut req = Request::get("/s");
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        let mut req = req.body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: None, remote: Some(peer.parse().unwrap()) }));
        let resp = app.oneshot(req).await.unwrap();
        resp.extensions().get::<Arc<crate::sse::SseStats>>().and_then(|s| s.labelled().map(String::from))
    }

    #[tokio::test]
    async fn sse_streams_are_labelled_with_path_and_peer() {
        assert_eq!(sse_label_from("192.168.1.20:50000", &[]).await.as_deref(), Some("path=/s remote=true"));
        assert_eq!(sse_label_from("127.0.0.1:50000", &[]).await.as_deref(), Some("path=/s remote=false"));
        assert_eq!(sse_label_from("127.0.0.1:50000", &[("x-forwarded-for", "203.0.113.7")]).await.as_deref(), Some("path=/s remote=true"));
    }

    #[tokio::test]
    async fn a_panicking_handler_answers_500() {
        async fn boom() -> &'static str {
            panic!("handler bug")
        }
        let app = axum::Router::new().route("/boom", axum::routing::get(boom)).layer(catch_panic_layer());
        let resp = app.oneshot(Request::get("/boom").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = http_body_util::BodyExt::collect(resp.into_body()).await.unwrap().to_bytes();
        assert_eq!(&body[..], b"Internal Server Error");
    }

    #[tokio::test]
    async fn accepted_connections_have_nagle_off() {
        use axum::serve::Listener;
        let mut listener = NoDelayTcpListener(tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap());
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(tokio::net::TcpStream::connect(addr));
        let (io, _) = listener.accept().await;
        assert!(io.nodelay().unwrap());
        drop(client.await.unwrap().unwrap());
    }

    fn policy(token: &str, insecure_lan: bool) -> Policy {
        Policy { token: Arc::new(token.into()), allow_insecure_lan: insecure_lan, max_bytes: DEFAULT_MAX_BYTES, network_key: Arc::default() }
    }

    #[test]
    fn the_network_key_is_accepted_only_while_installed() {
        let p = policy("desk", false);
        assert_eq!(p.authenticate("desk"), Some(AuthenticatedBy::DesktopToken));
        assert_eq!(p.authenticate("lan-key-0123456789"), None);
        p.set_network_key(Some("lan-key-0123456789".into()));
        assert_eq!(p.authenticate("lan-key-0123456789"), Some(AuthenticatedBy::NetworkKey));
        assert_eq!(p.authenticate("desk"), Some(AuthenticatedBy::DesktopToken));
        assert_eq!(p.authenticate("lan-key-012345678"), None);
        p.set_network_key(None);
        assert_eq!(p.authenticate("lan-key-0123456789"), None);
    }

    #[test]
    fn an_empty_token_or_key_never_authenticates() {
        let p = policy("", false);
        p.set_network_key(Some(String::new()));
        assert_eq!(p.authenticate(""), None);
    }

    #[test]
    fn cors_defaults_follow_the_access_key() {
        let open = Cors::new(None, &policy("", false));
        assert!(open.reject_disallowed);
        assert!(!open.allowed("https://evil.example"));
        assert!(open.allowed("tauri://localhost") && open.allowed("http://localhost:5173"));

        let keyed = Cors::new(None, &policy("k", false));
        assert!(!keyed.reject_disallowed);
        assert!(keyed.allowed("https://evil.example"), "the key is the boundary");

        let lan = Cors::new(None, &policy("", true));
        assert!(!lan.reject_disallowed && lan.allowed("http://192.168.1.10:5173"), "API_ALLOW_INSECURE_LAN keeps v2 behaviour");
    }

    #[test]
    fn explicit_cors_origins_extend_the_first_party_set() {
        let list = vec!["https://ui.example".to_string()];
        for p in [policy("", false), policy("k", false)] {
            let c = Cors::new(Some(&list), &p);
            assert!(c.allowed("https://ui.example") && c.allowed("tauri://localhost"));
            assert!(!c.allowed("https://evil.example"));
        }
        let star = vec!["*".to_string()];
        assert!(Cors::new(Some(&star), &policy("", false)).allowed("https://evil.example"), "explicit opt-out");
    }
}
