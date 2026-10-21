//! The preview listener: reserved inspector routes, then either forwarding
//! to the dev server or serving workspace files.

use crate::agent::{AgentReply, MAX_RESULT_BYTES, POLL_WAIT};
use crate::console::{parse_batch, MAX_BATCH_BYTES};
use crate::inject::inject;
use crate::manager::Entry;
use crate::target::{Backend, UrlTarget};
use crate::{AGENT_PATH, CONSOLE_PATH, INSPECTOR_JS, INSPECTOR_PATH, RESERVED_PREFIX};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use futures::StreamExt;
use std::sync::{Arc, OnceLock};
use tokio::sync::watch;

/// Largest HTML document buffered for script injection; bigger ones stream
/// through unchanged.
pub const MAX_HTML_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;

/// Only the app (a loopback page or a Tauri webview) may frame a preview,
/// so a remote site cannot embed it and listen to the inspector's messages.
pub const FRAME_ANCESTORS: &str = "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* tauri: http://tauri.localhost https://tauri.localhost";

pub(crate) fn add_frame_ancestors(headers: &mut HeaderMap) {
    headers.append(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(FRAME_ANCESTORS));
}

pub(crate) async fn serve(listener: tokio::net::TcpListener, entry: Arc<Entry>, mut stop: watch::Receiver<bool>) {
    let app = Router::new().fallback(handle).with_state(entry.clone());
    let res = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = stop.wait_for(|v| *v).await;
        })
        .await;
    if let Err(e) = res {
        tracing::warn!("preview_listener_error id={} err={}", entry.id, e);
    }
}

pub(crate) fn plain(status: StatusCode, body: &str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], body.to_string()).into_response()
}

/// DNS-rebinding guard: only loopback names, on the listener's own port or
/// a device relay's port (see [`Entry::add_alias_port`]).
pub(crate) fn host_allowed(host: Option<&str>, accepts_port: impl Fn(u16) -> bool) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim().to_ascii_lowercase();
    let Some(port) = host.strip_prefix("127.0.0.1:").or_else(|| host.strip_prefix("localhost:")) else { return false };
    !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && port.parse::<u16>().is_ok_and(accepts_port)
}

pub(crate) fn is_ws_upgrade(headers: &HeaderMap) -> bool {
    headers.get(header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

async fn handle(State(entry): State<Arc<Entry>>, req: Request) -> Response {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).map(str::to_string);
    if !host_allowed(host.as_deref(), |p| entry.accepts_port(p)) {
        tracing::warn!("preview_foreign_host id={} host={:?}", entry.id, host);
        return plain(StatusCode::FORBIDDEN, "Host not allowed.");
    }
    let host = host.unwrap_or_default();
    let path = req.uri().path().to_string();
    if path == INSPECTOR_PATH {
        return (StatusCode::OK, [(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], INSPECTOR_JS).into_response();
    }
    if path == CONSOLE_PATH {
        if req.method() != Method::POST {
            return plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.");
        }
        let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_BATCH_BYTES + 1).await else {
            return plain(StatusCode::PAYLOAD_TOO_LARGE, "Console batch too large.");
        };
        return match parse_batch(&body) {
            Ok(entries) => {
                entry.push_console(entries);
                StatusCode::NO_CONTENT.into_response()
            }
            Err(e) => plain(StatusCode::BAD_REQUEST, &e),
        };
    }
    if path == AGENT_PATH {
        return agent_endpoint(&entry, req).await;
    }
    if path.starts_with(RESERVED_PREFIX) {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    }
    match entry.backend.clone() {
        Backend::Upstream(target) => {
            if is_ws_upgrade(req.headers()) {
                return crate::ws::proxy(entry, &target, req).await;
            }
            let _guard = entry.begin();
            forward(&target, &host, req).await
        }
        Backend::Static(root) => {
            let _guard = entry.begin();
            crate::static_files::serve(&entry, &root, req).await
        }
    }
}

/// `GET` is the page's long poll for the agent's next command (204 when
/// none arrives); `POST` carries a command's result. Polls count as
/// activity, so a preview open in a tab is never reaped as idle.
async fn agent_endpoint(entry: &Arc<Entry>, req: Request) -> Response {
    match *req.method() {
        Method::GET => {
            let _guard = entry.begin();
            match entry.agent.next(POLL_WAIT, entry.stop_rx()).await {
                Some(cmd) => (StatusCode::OK, [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], serde_json::to_string(&cmd).unwrap_or_default())
                    .into_response(),
                None => (StatusCode::NO_CONTENT, [(header::CACHE_CONTROL, "no-store")]).into_response(),
            }
        }
        Method::POST => {
            let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_RESULT_BYTES + 1).await else {
                return plain(StatusCode::PAYLOAD_TOO_LARGE, "Result too large.");
            };
            if body.len() > MAX_RESULT_BYTES {
                return plain(StatusCode::PAYLOAD_TOO_LARGE, "Result too large.");
            }
            match serde_json::from_slice::<AgentReply>(&body) {
                Ok(reply) => {
                    entry.agent.resolve(reply);
                    StatusCode::NO_CONTENT.into_response()
                }
                Err(e) => plain(StatusCode::BAD_REQUEST, &format!("Invalid result: {e}")),
            }
        }
        _ => plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed."),
    }
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // Loopback dev servers commonly use self-signed certificates.
            .danger_accept_invalid_certs(true)
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("preview http client")
    })
}

const HOP_BY_HOP: [&str; 9] = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

fn is_hop_by_hop(name: &HeaderName) -> bool {
    HOP_BY_HOP.contains(&name.as_str())
}

/// Headers sent upstream: hop-by-hop dropped, `Host`/`Origin`/`Referer`
/// pointed at the target, and no compression so HTML can be rewritten.
pub(crate) fn upstream_request_headers(incoming: &HeaderMap, target: &UrlTarget, proxy_origin: &str) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (k, v) in incoming {
        if is_hop_by_hop(k) || k == header::HOST || k == header::ACCEPT_ENCODING || k == header::CONTENT_LENGTH {
            continue;
        }
        if k == header::ORIGIN {
            if let Ok(v) = HeaderValue::from_str(&target.origin()) {
                out.insert(header::ORIGIN, v);
            }
            continue;
        }
        if k == header::REFERER {
            let raw = v.to_str().unwrap_or("");
            if let Some(rest) = raw.strip_prefix(proxy_origin) {
                if let Ok(v) = HeaderValue::from_str(&format!("{}{rest}", target.origin())) {
                    out.insert(header::REFERER, v);
                }
            }
            continue;
        }
        out.append(k.clone(), v.clone());
    }
    if let Ok(h) = HeaderValue::from_str(&target.authority()) {
        out.insert(header::HOST, h);
    }
    out.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    out
}

/// `frame-ancestors` would stop the dock from framing the page.
pub(crate) fn strip_frame_ancestors(csp: &str) -> Option<String> {
    let kept: Vec<&str> =
        csp.split(';').map(str::trim).filter(|d| !d.is_empty()).filter(|d| !d.split_whitespace().next().is_some_and(|n| n.eq_ignore_ascii_case("frame-ancestors"))).collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

/// Cookies scoped to `Domain=localhost` would not apply to `127.0.0.1`.
pub(crate) fn strip_cookie_domain(cookie: &str) -> String {
    cookie.split(';').map(str::trim).filter(|a| !a.to_ascii_lowercase().starts_with("domain=")).collect::<Vec<_>>().join("; ")
}

/// Response headers sent back to the frame.
pub(crate) fn downstream_response_headers(upstream: &HeaderMap, target: &UrlTarget, proxy_origin: &str) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (k, v) in upstream {
        if is_hop_by_hop(k) || k.as_str() == "x-frame-options" {
            continue;
        }
        if k == header::CONTENT_SECURITY_POLICY {
            if let Some(csp) = v.to_str().ok().and_then(strip_frame_ancestors) {
                if let Ok(v) = HeaderValue::from_str(&csp) {
                    out.append(k.clone(), v);
                }
            }
            continue;
        }
        if k == header::LOCATION {
            let raw = v.to_str().unwrap_or("");
            let rewritten = target.origin_aliases().iter().find_map(|o| raw.strip_prefix(o.as_str()).map(|rest| format!("{proxy_origin}{rest}")));
            match rewritten.and_then(|r| HeaderValue::from_str(&r).ok()) {
                Some(v) => out.append(k.clone(), v),
                None => out.append(k.clone(), v.clone()),
            };
            continue;
        }
        if k == header::SET_COOKIE {
            if let Ok(v) = HeaderValue::from_str(&strip_cookie_domain(v.to_str().unwrap_or(""))) {
                out.append(k.clone(), v);
            }
            continue;
        }
        out.append(k.clone(), v.clone());
    }
    add_frame_ancestors(&mut out);
    out
}

pub(crate) fn is_html(headers: &HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("text/html"))
}

fn wants_html(headers: &HeaderMap) -> bool {
    headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/html"))
}

/// Shown while nothing listens on the target; refreshes itself so the page
/// appears once the dev server starts.
pub(crate) fn not_running_page(target: &UrlTarget) -> Response {
    let authority = target.authority();
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"2\"><meta name=\"openagentd-preview\" content=\"upstream-down\"><title>Waiting for {authority}</title>\
<style>body{{font:14px/1.5 system-ui,sans-serif;color:#555;display:grid;place-items:center;height:100vh;margin:0;background:#fafaf8}}code{{font-family:ui-monospace,monospace}}</style></head>\
<body><div><p>Nothing is running on <code>{authority}</code> yet.</p><p>Start the dev server; this page retries every 2 seconds.</p></div></body></html>"
    );
    let body = inject(html.as_bytes());
    (StatusCode::BAD_GATEWAY, [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store"), (header::CONTENT_SECURITY_POLICY, FRAME_ANCESTORS)], body)
        .into_response()
}

async fn forward(target: &UrlTarget, host: &str, req: Request) -> Response {
    let proxy_origin = format!("http://{host}");
    let (parts, body) = req.into_parts();
    let path = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("{}{}", target.origin(), path);
    let Ok(body) = axum::body::to_bytes(body, MAX_REQUEST_BYTES).await else {
        return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large.");
    };
    let headers = upstream_request_headers(&parts.headers, target, &proxy_origin);
    let mut rb = client().request(parts.method.clone(), &url).headers(headers);
    if !body.is_empty() {
        rb = rb.body(body);
    }
    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!("preview_upstream_error url={} err={}", url, e);
            if parts.method == Method::GET && wants_html(&parts.headers) {
                return not_running_page(target);
            }
            return plain(StatusCode::BAD_GATEWAY, &format!("Could not reach {}.", target.authority()));
        }
    };
    let status = resp.status();
    let mut headers = downstream_response_headers(resp.headers(), target, &proxy_origin);
    let injectable = parts.method != Method::HEAD && is_html(resp.headers()) && status != StatusCode::NO_CONTENT && status != StatusCode::NOT_MODIFIED;
    if !injectable {
        let mut out = Response::new(Body::from_stream(resp.bytes_stream()));
        *out.status_mut() = status;
        *out.headers_mut() = headers;
        return out;
    }
    headers.remove(header::CONTENT_LENGTH);
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                buf.extend_from_slice(&c);
                if buf.len() > MAX_HTML_BYTES {
                    // Too big to rewrite: send what we have, then the rest.
                    let head = futures::stream::once(async move { Ok::<_, reqwest::Error>(bytes::Bytes::from(buf)) });
                    let mut out = Response::new(Body::from_stream(head.chain(stream)));
                    *out.status_mut() = status;
                    *out.headers_mut() = headers;
                    return out;
                }
            }
            Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("Upstream response failed: {e}")),
        }
    }
    let mut out = Response::new(Body::from(inject(&buf)));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::parse_url_target;

    fn target() -> UrlTarget {
        parse_url_target("http://localhost:5173").unwrap().0
    }

    #[test]
    fn host_guard() {
        let own = |p: u16| p == 4100 || p == 50123;
        assert!(host_allowed(Some("127.0.0.1:4100"), own));
        assert!(host_allowed(Some("LOCALHOST:4100"), own));
        assert!(host_allowed(Some("127.0.0.1:50123"), own));
        assert!(!host_allowed(Some("127.0.0.1:4101"), own));
        assert!(!host_allowed(Some("evil.example:4100"), own));
        assert!(!host_allowed(Some("evil.example:50123"), own));
        assert!(!host_allowed(Some("127.0.0.1:+4100"), own));
        assert!(!host_allowed(Some("127.0.0.1"), own));
        assert!(!host_allowed(None, own));
    }

    #[test]
    fn request_headers_point_at_the_target() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4100"));
        h.insert(header::ORIGIN, HeaderValue::from_static("http://127.0.0.1:4100"));
        h.insert(header::REFERER, HeaderValue::from_static("http://127.0.0.1:4100/a?b=1"));
        h.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip, br"));
        h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        h.insert(header::COOKIE, HeaderValue::from_static("sid=1"));
        let out = upstream_request_headers(&h, &target(), "http://127.0.0.1:4100");
        assert_eq!(out[header::HOST], "localhost:5173");
        assert_eq!(out[header::ORIGIN], "http://localhost:5173");
        assert_eq!(out[header::REFERER], "http://localhost:5173/a?b=1");
        assert_eq!(out[header::ACCEPT_ENCODING], "identity");
        assert_eq!(out[header::COOKIE], "sid=1");
        assert!(out.get(header::CONNECTION).is_none());
    }

    #[test]
    fn response_headers_allow_framing_and_stay_on_the_proxy() {
        let mut h = HeaderMap::new();
        h.insert("x-frame-options", HeaderValue::from_static("DENY"));
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'"));
        h.insert(header::LOCATION, HeaderValue::from_static("http://127.0.0.1:5173/login?next=/"));
        h.append(header::SET_COOKIE, HeaderValue::from_static("sid=1; Domain=localhost; Path=/; HttpOnly"));
        h.insert(header::TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
        let out = downstream_response_headers(&h, &target(), "http://127.0.0.1:4100");
        assert!(out.get("x-frame-options").is_none());
        let csp: Vec<_> = out.get_all(header::CONTENT_SECURITY_POLICY).iter().map(|v| v.to_str().unwrap().to_string()).collect();
        assert_eq!(csp, vec!["default-src 'self'".to_string(), FRAME_ANCESTORS.to_string()]);
        assert_eq!(out[header::LOCATION], "http://127.0.0.1:4100/login?next=/");
        assert_eq!(out[header::SET_COOKIE], "sid=1; Path=/; HttpOnly");
        assert!(out.get(header::TRANSFER_ENCODING).is_none());
    }

    #[test]
    fn external_redirects_are_left_alone_and_empty_csp_is_dropped() {
        let mut h = HeaderMap::new();
        h.insert(header::LOCATION, HeaderValue::from_static("https://accounts.example.com/"));
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("frame-ancestors 'self'"));
        let out = downstream_response_headers(&h, &target(), "http://127.0.0.1:4100");
        assert_eq!(out[header::LOCATION], "https://accounts.example.com/");
        let csp: Vec<_> = out.get_all(header::CONTENT_SECURITY_POLICY).iter().collect();
        assert_eq!(csp, vec![FRAME_ANCESTORS]);
    }
}
