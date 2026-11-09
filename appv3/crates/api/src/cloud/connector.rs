//! The connector (spec section 5.4): serves one relay stream, one HTTP
//! exchange, with this server's own router, in-process.
//!
//! A relayed request must never count as a loopback caller: with no access
//! key set, the server trusts every loopback caller. So the connector does
//! not open a TCP connection to the server. The request has no socket
//! address (no `ConnectInfo`), it carries a [`RelayPeer`] marker that only
//! this code can attach, and it loses every header a controller could use
//! to steer trust before the router sees it.

use std::convert::Infallible;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use tower::ServiceExt;

use crate::middleware::RelayPeer;

/// Headers a controller may not send through the tunnel: credentials come
/// only from the session, and proxy hints would change trust decisions.
pub const STRIPPED: &[&str] =
    &["authorization", "cookie", "origin", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "via", "accept-encoding"];

/// The SSE keep-alive comment the server writes; the controller keeps its
/// event source alive itself, so it is not relayed.
const PING_FRAME: &[u8] = b": ping\r\n\r\n";

/// Whether the request is for this host (`Host: localhost`).
pub fn for_this_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else { return false };
    let name = host.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map(|(n, _)| n).unwrap_or(host);
    name.eq_ignore_ascii_case("localhost")
}

/// Removes every stripped header and the access-key query parameter.
pub fn sanitize<B>(req: &mut Request<B>) {
    let h = req.headers_mut();
    for name in STRIPPED {
        h.remove(HeaderName::from_static(name));
    }
    let names: Vec<HeaderName> = h.keys().filter(|k| k.as_str().starts_with("x-forwarded-")).cloned().collect();
    for n in names {
        h.remove(n);
    }
    strip_query_token(req);
}

fn strip_query_token<B>(req: &mut Request<B>) {
    let param = appv3_core::auth::QS_TOKEN_PARAM;
    let Some(q) = req.uri().query() else { return };
    if !q.contains(param) {
        return;
    }
    let kept: Vec<(String, String)> = form_urlencoded::parse(q.as_bytes()).filter(|(k, _)| k != param).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let new_q = form_urlencoded::Serializer::new(String::new()).extend_pairs(kept).finish();
    let path = req.uri().path().to_string();
    let pq = if new_q.is_empty() { path } else { format!("{path}?{new_q}") };
    if let Ok(uri) = pq.parse() {
        *req.uri_mut() = uri;
    }
}

fn bad_request() -> Response<Body> {
    let mut r = Response::new(Body::from("Bad Request"));
    *r.status_mut() = StatusCode::BAD_REQUEST;
    r.headers_mut().insert(header::CONNECTION, header::HeaderValue::from_static("close"));
    r
}

/// Drops the SSE keep-alive frames from an event stream.
fn without_pings(resp: Response<Body>) -> Response<Body> {
    let is_sse = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("text/event-stream"));
    if !is_sse {
        return resp;
    }
    let (parts, body) = resp.into_parts();
    use futures::StreamExt;
    let filtered = body.into_data_stream().filter(|frame| std::future::ready(!matches!(frame, Ok(b) if b.as_ref() == PING_FRAME)));
    Response::from_parts(parts, Body::from_stream(filtered))
}

/// One relayed request, as the router will see it.
pub async fn handle(router: axum::Router, device_id: String, mut req: Request<Body>) -> Response<Body> {
    if !for_this_host(req.headers()) {
        return bad_request();
    }
    sanitize(&mut req);
    req.extensions_mut().insert(RelayPeer { device_id });
    match router.oneshot(req).await {
        Ok(resp) => without_pings(resp),
        Err(never) => match never {},
    }
}

/// Serves one stream until the exchange ends.
pub async fn serve(stream: openagentd_cloud::mux::Stream, device_id: String) {
    let Some(router) = super::router() else { return };
    let svc = tower::service_fn(move |req: Request<hyper::body::Incoming>| {
        let router = router.clone();
        let device_id = device_id.clone();
        async move { Ok::<_, Infallible>(handle(router, device_id, req.map(Body::new)).await) }
    });
    let conn = hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(stream), TowerToHyperService::new(svc)).with_upgrades();
    if let Err(e) = conn.await {
        // A malformed request: hyper answered 400 and closed the stream.
        tracing::debug!("cloud_stream_ended error={e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::{desktop_token, tag_peer, AuthenticatedBy, Peer, Policy};
    use axum::routing::get;
    use axum::Router;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};

    /// The real auth middleware in front of a handler that reports what it saw.
    fn echo(policy: Policy) -> Router {
        async fn seen(ext: axum::http::Extensions, uri: axum::http::Uri, headers: HeaderMap) -> axum::Json<Value> {
            let names: Vec<String> = headers.keys().map(|k| k.as_str().to_string()).collect();
            let peer = ext.get::<Peer>().copied();
            axum::Json(json!({
                "by": format!("{:?}", ext.get::<AuthenticatedBy>()),
                "loopback": peer.map(|p| p.loopback),
                "remote": peer.map(|p| p.remote()),
                "device": ext.get::<RelayPeer>().map(|r| r.device_id.clone()),
                "headers": names,
                "query": uri.query(),
            }))
        }
        Router::new().route("/api/echo", get(seen)).layer(axum::middleware::from_fn(tag_peer)).layer(axum::middleware::from_fn_with_state(policy, desktop_token))
    }

    fn policy(token: &str) -> Policy {
        Policy { token: std::sync::Arc::new(token.into()), allow_insecure_lan: false, max_bytes: 1 << 20, network_key: Default::default() }
    }

    async fn body_json(resp: Response<Body>) -> Value {
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    fn hostile(host: &str) -> Request<Body> {
        Request::get(format!("/api/echo?a=1&{}=host-key-0123456789", appv3_core::auth::QS_TOKEN_PARAM))
            .header("host", host)
            .header("authorization", "Bearer host-key-0123456789")
            .header("cookie", "s=1")
            .header("origin", "https://attacker.example")
            .header("x-forwarded-for", "127.0.0.1")
            .header("x-forwarded-host", "localhost")
            .header("x-forwarded-whatever", "1")
            .header("forwarded", "for=127.0.0.1")
            .header("via", "1.1 proxy")
            .header("x-real-ip", "127.0.0.1")
            .header("accept-encoding", "gzip")
            .header("x-keep", "yes")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn relayed_request_loses_steering_headers_and_is_a_relay_device() {
        for token in ["", "host-key-0123456789"] {
            let resp = handle(echo(policy(token)), "D-test".into(), hostile("localhost")).await;
            assert_eq!(resp.status(), StatusCode::OK, "token={token:?}");
            let v = body_json(resp).await;
            assert_eq!(v["by"], "Some(RelayDevice)");
            assert_eq!(v["loopback"], false, "a relayed request is never loopback");
            assert_eq!(v["remote"], true);
            assert_eq!(v["device"], "D-test");
            assert_eq!(v["query"], "a=1");
            let names: Vec<&str> = v["headers"].as_array().unwrap().iter().map(|h| h.as_str().unwrap()).collect();
            for gone in STRIPPED.iter().copied().chain(["x-forwarded-whatever"]) {
                assert!(!names.contains(&gone), "{gone} reached the handler: {names:?}");
            }
            assert!(names.contains(&"x-keep") && names.contains(&"host"));
        }
    }

    #[tokio::test]
    async fn foreign_host_is_refused() {
        for host in ["attacker.example", "localhost.attacker.example", "127.0.0.1", "localhost:abc"] {
            let resp = handle(echo(policy("")), "D-test".into(), hostile(host)).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{host}");
            assert_eq!(resp.headers()[header::CONNECTION], "close");
        }
        let mut no_host = hostile("localhost");
        no_host.headers_mut().remove(header::HOST);
        assert_eq!(handle(echo(policy("")), "D".into(), no_host).await.status(), StatusCode::BAD_REQUEST);
        assert!(for_this_host(&{
            let mut h = HeaderMap::new();
            h.insert(header::HOST, "LOCALHOST:8000".parse().unwrap());
            h
        }));
    }

    #[tokio::test]
    async fn sse_keepalive_pings_are_not_relayed() {
        async fn events() -> Response<Body> {
            let frames: Vec<Result<bytes::Bytes, std::io::Error>> =
                vec![Ok(b"event: a\ndata: 1\n\n".as_slice().into()), Ok(PING_FRAME.into()), Ok(b"event: b\ndata: 2\n\n".as_slice().into())];
            Response::builder().header(header::CONTENT_TYPE, "text/event-stream").body(Body::from_stream(futures::stream::iter(frames))).unwrap()
        }
        let router = Router::new().route("/api/events", get(events));
        let req = Request::get("/api/events").header("host", "localhost").body(Body::empty()).unwrap();
        let body = handle(router, "D".into(), req).await.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    }

    #[tokio::test]
    async fn serves_over_a_byte_stream_with_hyper() {
        // The same path `serve` takes, over an in-memory duplex pipe.
        let (client, server) = tokio::io::duplex(64 * 1024);
        let router = echo(policy(""));
        let svc = tower::service_fn(move |req: Request<hyper::body::Incoming>| {
            let router = router.clone();
            async move { Ok::<_, Infallible>(handle(router, "D-pipe".into(), req.map(Body::new)).await) }
        });
        tokio::spawn(hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(server), TowerToHyperService::new(svc)));
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut client = client;
        client.write_all(b"GET /api/echo HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.contains("\"by\":\"Some(RelayDevice)\"") && text.contains("\"device\":\"D-pipe\""), "{text}");
        assert!(!text.contains("authorization"), "{text}");
    }
}
