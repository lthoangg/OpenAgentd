//! WebSocket passthrough, mostly for dev-server hot reload (Vite's
//! `vite-hmr`, Next.js `/_next/webpack-hmr`).

use crate::manager::Entry;
use crate::proxy::plain;
use crate::target::UrlTarget;
use axum::extract::ws::{CloseFrame as ACloseFrame, Message as AMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as TCloseFrame;
use tokio_tungstenite::tungstenite::Message as TMsg;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Upstream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub(crate) async fn proxy(entry: Arc<Entry>, target: &UrlTarget, req: Request) -> Response {
    if target.scheme != "http" {
        return plain(StatusCode::BAD_GATEWAY, "The preview cannot relay secure WebSockets (wss) yet.");
    }
    let (mut parts, _body) = req.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let path = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("ws://{}{}", target.authority(), path);
    let mut up_req = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("Invalid upstream WebSocket URL: {e}")),
    };
    let h = up_req.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&target.origin()) {
        h.insert(header::ORIGIN, v);
    }
    for name in [header::SEC_WEBSOCKET_PROTOCOL, header::COOKIE, header::USER_AGENT] {
        if let Some(v) = parts.headers.get(&name) {
            h.insert(name, v.clone());
        }
    }
    let (upstream, resp) = match tokio_tungstenite::connect_async(up_req).await {
        Ok(pair) => pair,
        Err(e) => {
            if let Some(skipped) = crate::log_throttle::upstream_error(&target.authority()) {
                tracing::debug!("preview_ws_upstream_error url={} err={} skipped_since_last={}", url, e, skipped);
            }
            return plain(StatusCode::BAD_GATEWAY, &format!("Could not open a WebSocket to {}.", target.authority()));
        }
    };
    let upgrade = match resp.headers().get(header::SEC_WEBSOCKET_PROTOCOL).and_then(|v| v.to_str().ok()) {
        Some(p) => upgrade.protocols([p.to_string()]),
        None => upgrade,
    };
    let guard = entry.begin();
    let stop = entry.stop_rx();
    upgrade.on_upgrade(move |client| async move {
        let _guard = guard;
        pump(client, upstream, stop).await;
    })
}

fn to_upstream(m: AMsg) -> TMsg {
    match m {
        AMsg::Text(t) => TMsg::text(t.as_str().to_owned()),
        AMsg::Binary(b) => TMsg::Binary(b),
        AMsg::Ping(b) => TMsg::Ping(b),
        AMsg::Pong(b) => TMsg::Pong(b),
        AMsg::Close(f) => TMsg::Close(f.map(|f| TCloseFrame { code: f.code.into(), reason: f.reason.as_str().to_owned().into() })),
    }
}

fn to_client(m: TMsg) -> Option<AMsg> {
    Some(match m {
        TMsg::Text(t) => AMsg::Text(t.as_str().to_owned().into()),
        TMsg::Binary(b) => AMsg::Binary(b),
        TMsg::Ping(b) => AMsg::Ping(b),
        TMsg::Pong(b) => AMsg::Pong(b),
        TMsg::Close(f) => AMsg::Close(f.map(|f| ACloseFrame { code: f.code.into(), reason: f.reason.as_str().to_owned().into() })),
        TMsg::Frame(_) => return None,
    })
}

async fn pump(client: WebSocket, upstream: Upstream, mut stop: watch::Receiver<bool>) {
    let (mut c_tx, mut c_rx) = client.split();
    let (mut u_tx, mut u_rx) = upstream.split();
    loop {
        tokio::select! {
            m = c_rx.next() => match m {
                Some(Ok(m)) => {
                    let close = matches!(m, AMsg::Close(_));
                    if u_tx.send(to_upstream(m)).await.is_err() || close { break }
                }
                _ => break,
            },
            m = u_rx.next() => match m {
                Some(Ok(m)) => {
                    let close = matches!(m, TMsg::Close(_));
                    if let Some(m) = to_client(m) {
                        if c_tx.send(m).await.is_err() || close { break }
                    }
                }
                _ => break,
            },
            _ = async { stop.wait_for(|v| *v).await.map(|_| ()) } => break,
        }
    }
    let _ = u_tx.close().await;
    let _ = c_tx.close().await;
}
