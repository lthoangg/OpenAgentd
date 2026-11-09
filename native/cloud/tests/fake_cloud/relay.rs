//! The fake relay: presence sockets, pairing, and opaque forwarding of
//! binary frames, like the real relay (which never parses them).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use super::{err, Fake};

#[derive(Default)]
pub struct Relay {
    /// host device id → its presence socket's outbox.
    pub presence: HashMap<String, mpsc::UnboundedSender<Message>>,
    /// session id → where the host's data socket goes.
    pub waiting: HashMap<String, oneshot::Sender<WebSocket>>,
    /// Control messages the test sends to the host side of a paired
    /// session (pause / resume), newest session last.
    pub to_host: Vec<mpsc::UnboundedSender<Message>>,
    /// Sizes of the binary messages the host side sent, in order.
    pub host_frames: Vec<usize>,
}

pub type Shared = Arc<Mutex<Relay>>;

fn token_of(f: &Fake, headers: &HeaderMap) -> Option<(String, String)> {
    let t = headers.get("authorization").and_then(|v| v.to_str().ok())?.strip_prefix("Bearer ")?;
    f.0.lock().unwrap().tokens.get(t).cloned()
}

pub async fn presence(State(f): State<Fake>, Path(host): Path<String>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let Some((account, _)) = token_of(&f, &headers) else {
        return err(401, "invalid_token");
    };
    if let Some(p) = super::problem(&f.account(&account)) {
        return p;
    }
    let relay = f.1.clone();
    ws.on_upgrade(move |socket| async move {
        let (mut tx, mut rx) = socket.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        relay.lock().unwrap().presence.insert(host.clone(), out);
        let writer = tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                let closing = matches!(m, Message::Close(_));
                if tx.send(m).await.is_err() || closing {
                    break;
                }
            }
        });
        while let Some(Ok(m)) = rx.next().await {
            if matches!(m, Message::Close(_)) {
                break;
            }
        }
        relay.lock().unwrap().presence.remove(&host);
        writer.abort();
    })
    .into_response()
}

pub async fn data(State(f): State<Fake>, Path((host, session)): Path<(String, String)>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let Some((account, from)) = token_of(&f, &headers) else {
        return err(401, "invalid_token");
    };
    if let Some(p) = super::problem(&f.account(&account)) {
        return p;
    }
    let relay = f.1.clone();
    let waiting = relay.lock().unwrap().waiting.remove(&session);
    if let Some(slot) = waiting {
        // The host joining an offered session.
        return ws.on_upgrade(move |socket| async move {
            let _ = slot.send(socket);
        });
    }
    let Some(presence) = relay.lock().unwrap().presence.get(&host).cloned() else {
        return err(409, "host_offline");
    };
    // A controller: offer the session to the host, then pair.
    ws.on_upgrade(move |controller| async move {
        let (slot, host_socket) = oneshot::channel();
        relay.lock().unwrap().waiting.insert(session.clone(), slot);
        let _ = presence.send(Message::Text(json!({"type":"offer","session_id":session,"from":from}).to_string().into()));
        let Ok(Ok(host_ws)) = tokio::time::timeout(std::time::Duration::from_secs(5), host_socket).await else {
            return;
        };
        pair(relay, controller, host_ws).await;
    })
    .into_response()
}

async fn pair(relay: Shared, controller: WebSocket, host: WebSocket) {
    let (c_tx, c_rx) = controller.split();
    let (h_tx, h_rx) = host.split();
    // One writer task per side, fed by a channel, so the test can inject.
    let writer = |mut tx: futures_util::stream::SplitSink<WebSocket, Message>| {
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let closing = matches!(m, Message::Close(_));
                if tx.send(m).await.is_err() || closing {
                    break;
                }
            }
        });
        out
    };
    let to_c = writer(c_tx);
    let to_h = writer(h_tx);
    relay.lock().unwrap().to_host.push(to_h.clone());
    let paired = || Message::Text(json!({"type":"paired"}).to_string().into());
    let _ = to_c.send(paired());
    let _ = to_h.send(paired());
    let forward = |mut rx: futures_util::stream::SplitStream<WebSocket>, tx: mpsc::UnboundedSender<Message>, from_host: bool| {
        let relay = relay.clone();
        async move {
            while let Some(Ok(m)) = rx.next().await {
                match m {
                    Message::Binary(ref b) => {
                        if from_host {
                            relay.lock().unwrap().host_frames.push(b.len());
                        }
                        if tx.send(m).is_err() {
                            break;
                        }
                    }
                    Message::Close(frame) => {
                        // Closing either side closes the other with the same code.
                        let code = frame.as_ref().map(|f| f.code).unwrap_or(1000);
                        let _ = tx.send(Message::Close(Some(CloseFrame { code, reason: "".into() })));
                        break;
                    }
                    _ => {} // acks and pings are the relay's business
                }
            }
        }
    };
    let one = forward(c_rx, to_h, false);
    let two = forward(h_rx, to_c, true);
    tokio::select! {
        _ = one => {}
        _ = two => {}
    }
}
