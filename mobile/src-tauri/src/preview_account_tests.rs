//! The Preview tab on a computer of the account, end to end on the phone's
//! side: the preview relay tunnels to the computer's loopback bridge with
//! the bridge's key, and the bridge carries the WebSocket over a stream of
//! the account link. The computer here answers as a real server's connector
//! does (hyper with `keep_alive(false)`, so its 101 says
//! `connection: upgrade, close`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::routing::get;
use hyper_util::rt::TokioIo;
use openagentd_shell_core::{RelayRegistry, Via};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

use crate::cloud_bridge::{app_origin, Bridge, Io, Opener};

const ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

/// What reached the computer's tunnel route: the preview id, the relay
/// port, and whether a key came along.
type Seen = Arc<Mutex<Vec<(String, String, bool)>>>;

async fn echo(mut socket: WebSocket) {
    while let Some(Ok(m)) = socket.recv().await {
        if let Message::Binary(b) = m {
            let mut out = b"echo:".to_vec();
            out.extend_from_slice(&b);
            if socket.send(Message::Binary(out.into())).await.is_err() {
                break;
            }
        }
    }
}

/// A stand-in computer: each stream of the link is one HTTP exchange with
/// its router, as `appv3`'s cloud connector serves it.
fn computer(seen: Seen) -> Opener {
    let router = axum::Router::new().route(
        "/api/preview/{id}/tunnel",
        get(
            move |Path(id): Path<String>,
                  Query(q): Query<std::collections::HashMap<String, String>>,
                  headers: HeaderMap,
                  ws: WebSocketUpgrade| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push((
                        id,
                        q.get("port").cloned().unwrap_or_default(),
                        headers.contains_key("authorization") || q.contains_key("_token"),
                    ));
                    ws.on_upgrade(echo)
                }
            },
        ),
    );
    Arc::new(move || {
        let router = router.clone();
        Box::pin(async move {
            let (here, there) = tokio::io::duplex(64 * 1024);
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                    router.clone().oneshot(req.map(axum::body::Body::new))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .serve_connection(TokioIo::new(there), svc)
                    .with_upgrades()
                    .await;
            });
            Ok(Box::new(here) as Box<dyn Io>)
        })
    })
}

async fn roundtrip(port: u16, msg: &[u8]) -> Vec<u8> {
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(msg).await.unwrap();
    let mut buf = vec![0u8; 256];
    let n = tokio::time::timeout(Duration::from_secs(5), tcp.read(&mut buf))
        .await
        .expect("the page's bytes come back")
        .unwrap();
    buf[..n].to_vec()
}

#[tokio::test]
async fn a_preview_relay_reaches_an_account_computer_through_its_bridge() {
    let seen = Seen::default();
    let bridge = Bridge::start(computer(seen.clone()), app_origin).await.unwrap();
    let relays = RelayRegistry::default();
    let info = relays
        .open_via(Via::Account, "main", crate::relay_client(), &bridge.origin, bridge.key(), ID, 0)
        .await
        .expect("the relay opens through the bridge");
    assert_ne!(info.origin, bridge.origin, "the page is framed from the relay, never the bridge");
    assert_eq!(
        roundtrip(info.port, b"GET / HTTP/1.1\r\n\r\n").await,
        b"echo:GET / HTTP/1.1\r\n\r\n"
    );
    let seen = seen.lock().unwrap().clone();
    // The probe, then the browser connection.
    assert_eq!(seen.len(), 2);
    for (id, port, keyed) in seen {
        assert_eq!((id.as_str(), port), (ID, info.port.to_string()));
        assert!(!keyed, "the bridge key stays on the phone");
    }
    relays.close_all();
}

#[tokio::test]
async fn a_stale_bridge_key_says_to_open_the_computer_again() {
    let bridge = Bridge::start(computer(Seen::default()), app_origin).await.unwrap();
    let err = RelayRegistry::default()
        .open_via(Via::Account, "main", crate::relay_client(), &bridge.origin, "not-the-key", ID, 0)
        .await
        .unwrap_err();
    assert!(err.contains("Open the computer again") && !err.contains("access key"), "{err}");
}
