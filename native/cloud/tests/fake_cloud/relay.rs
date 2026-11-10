//! The fake relay: presence sockets, pairing, and opaque forwarding of
//! binary frames, like the real relay (which never parses them).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use super::{err, Fake};

/// How the fake relay treats a presence socket.
#[derive(Default, Clone, Copy, PartialEq, Debug)]
pub enum PresenceMode {
    /// Reads it, so protocol pings get their pong.
    #[default]
    Answer,
    /// Accepts the upgrade and never reads again: no pong ever comes back,
    /// like a socket left half open by a sleep or a network change.
    Silent,
    /// A relay from before the text keepalive: closes presence with 1003
    /// on any text but a `reject`.
    Old,
}

#[derive(Default)]
pub struct Relay {
    /// host device id → its presence socket's outbox.
    pub presence: HashMap<String, mpsc::UnboundedSender<Message>>,
    /// Hosts that have opened presence at least once (the usage view lists them).
    pub seen: HashSet<String>,
    /// How presence sockets are treated.
    pub mode: PresenceMode,
    /// Presence sockets opened so far.
    pub presence_opens: usize,
    /// Text `ping`s received on presence sockets.
    pub text_pings: usize,
    /// Holds each presence upgrade this long before answering it.
    pub presence_delay: Option<std::time::Duration>,
    /// session id → where the host's data socket goes.
    pub waiting: HashMap<String, oneshot::Sender<WebSocket>>,
    /// Control messages the test sends to the host side of a paired
    /// session (pause / resume), newest session last.
    pub to_host: Vec<mpsc::UnboundedSender<Message>>,
    /// Sizes of the binary messages the host side sent, in order.
    pub host_frames: Vec<usize>,
    /// Text `ping`s received on data sockets (either side).
    pub data_text_pings: usize,
    /// A relay from before the text keepalive: a text `ping` on a data
    /// socket is not a JSON ack, so it closes the session with 1003.
    pub data_old: bool,
}

pub type Shared = Arc<Mutex<Relay>>;

fn token_of(f: &Fake, headers: &HeaderMap) -> Option<(String, String)> {
    let t = headers.get("authorization").and_then(|v| v.to_str().ok())?.strip_prefix("Bearer ")?;
    f.0.lock().unwrap().tokens.get(t).cloned()
}

pub async fn presence(State(f): State<Fake>, Path(host): Path<String>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let delay = f.1.lock().unwrap().presence_delay;
    if let Some(d) = delay {
        tokio::time::sleep(d).await;
    }
    let Some((account, _)) = token_of(&f, &headers) else {
        return err(401, "invalid_token");
    };
    if let Some(p) = super::problem(&f.account(&account)) {
        return p;
    }
    let relay = f.1.clone();
    ws.on_upgrade(move |socket| async move {
        let mode = {
            let mut r = relay.lock().unwrap();
            r.presence_opens += 1;
            r.mode
        };
        if mode == PresenceMode::Silent {
            // Hold the socket without reading it, so nothing answers.
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            drop(socket);
            return;
        }
        let (mut tx, mut rx) = socket.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let reply = out.clone();
        {
            let mut r = relay.lock().unwrap();
            r.presence.insert(host.clone(), out);
            r.seen.insert(host.clone());
        }
        let writer = tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                let closing = matches!(m, Message::Close(_));
                if tx.send(m).await.is_err() || closing {
                    break;
                }
            }
        });
        let mut refused = false;
        while let Some(Ok(m)) = rx.next().await {
            match m {
                Message::Close(_) => break,
                Message::Text(t) => {
                    if t.as_str() == "ping" {
                        relay.lock().unwrap().text_pings += 1;
                    }
                    let reject = serde_json::from_str::<serde_json::Value>(t.as_str()).is_ok_and(|v| v["type"] == "reject");
                    if mode == PresenceMode::Old && !reject {
                        let _ = reply.send(Message::Close(Some(CloseFrame { code: 1003, reason: "".into() })));
                        refused = true;
                        break;
                    }
                    if t.as_str() == "ping" {
                        let _ = reply.send(Message::Text("pong".into()));
                    }
                }
                _ => {}
            }
        }
        relay.lock().unwrap().presence.remove(&host);
        if refused {
            // Let the writer send the close frame first.
            let _ = writer.await;
        } else {
            writer.abort();
        }
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
    // `tx` is the other side, `back` the sender's own side.
    let forward = |mut rx: futures_util::stream::SplitStream<WebSocket>, tx: mpsc::UnboundedSender<Message>, back: mpsc::UnboundedSender<Message>, from_host: bool| {
        let relay = relay.clone();
        async move {
            while let Some(Ok(m)) = rx.next().await {
                match m {
                    Message::Text(ref t) if t.as_str() == "ping" => {
                        let old = {
                            let mut r = relay.lock().unwrap();
                            r.data_text_pings += 1;
                            r.data_old
                        };
                        if old {
                            let close = || Message::Close(Some(CloseFrame { code: 1003, reason: "".into() }));
                            let _ = back.send(close());
                            let _ = tx.send(close());
                            break;
                        }
                        // The real relay's auto-response, on any socket.
                        let _ = back.send(Message::Text("pong".into()));
                    }
                    Message::Binary(ref b) => {
                        if from_host {
                            relay.lock().unwrap().host_frames.push(b.len());
                        }
                        if tx.send(m).is_err() {
                            break;
                        }
                    }
                    Message::Close(frame) => {
                        // Closing either side closes the other with the same
                        // code, and answers the sender's close (as any
                        // WebSocket server does).
                        let code = frame.as_ref().map(|f| f.code).unwrap_or(1000);
                        let _ = tx.send(Message::Close(Some(CloseFrame { code, reason: "".into() })));
                        let _ = back.send(Message::Close(Some(CloseFrame { code, reason: "".into() })));
                        break;
                    }
                    _ => {} // acks and pings are the relay's business
                }
            }
        }
    };
    let one = forward(c_rx, to_h.clone(), to_c.clone(), false);
    let two = forward(h_rx, to_c, to_h, true);
    tokio::select! {
        _ = one => {}
        _ = two => {}
    }
}
