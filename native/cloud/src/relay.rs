//! Relay sessions (the API's "Relay"; spec section 5): the host's presence
//! socket, one data socket per session, the Noise IK handshake on it, flow
//! control acks and pause/resume, and a yamux session inside.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::header::{CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::account_state::{self, AccountProblem};
use crate::api::{ApiError, Cloud};
use crate::encoding::b64;
use crate::keys::random_bytes;
use crate::mux::{Session, Stream};
use crate::noise::{self, Initiator, Responder, Transport, MAX_PLAINTEXT};

/// Ack after this many received bytes…
pub const ACK_BYTES: usize = 256 * 1024;
/// …or after this long without new bytes.
pub const ACK_IDLE: Duration = Duration::from_millis(500);
/// WebSocket pings from the device keep sockets alive.
pub const PING_EVERY: Duration = Duration::from_secs(25);
/// Largest WebSocket message the relay forwards.
const MAX_WS_MESSAGE: usize = 1024 * 1024;

type Ws = WebSocketStream<reqwest::Upgraded>;

/// Why a socket could not be opened, or closed.
#[derive(Debug, Clone, PartialEq)]
pub enum RelayError {
    /// The upgrade was refused with an API error (`host_offline`, …).
    Refused(ApiError),
    /// The socket closed with this code.
    Closed(u16),
    /// The other side failed the Noise handshake, or its key is not the one
    /// in the verified roster.
    Handshake,
    Network,
}

impl RelayError {
    /// The account problem this names, if any.
    pub fn problem(&self) -> Option<AccountProblem> {
        match self {
            RelayError::Refused(e) => e.problem(),
            RelayError::Closed(code) => account_state::from_close_code(*code),
            _ => None,
        }
    }
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayError::Refused(e) => write!(f, "relay refused: {e}"),
            RelayError::Closed(c) => write!(f, "relay closed ({c})"),
            RelayError::Handshake => f.write_str("relay handshake failed"),
            RelayError::Network => f.write_str("relay unreachable"),
        }
    }
}

impl std::error::Error for RelayError {}

/// An HTTP/1.1-only client: a WebSocket upgrade cannot happen on HTTP/2.
pub fn http1_client() -> reqwest::Client {
    reqwest::Client::builder().http1_only().connect_timeout(Duration::from_secs(15)).build().expect("an HTTP client")
}

/// Opens a relay WebSocket at `path` with a fresh relay token (in the
/// `Authorization` header, never the URL).
pub async fn open_socket(cloud: &Cloud, http1: &reqwest::Client, path: &str) -> Result<Ws, RelayError> {
    let token = cloud.relay_token().await.map_err(RelayError::Refused)?;
    let key = generate_key();
    let resp = http1
        .get(format!("{}{}", cloud.endpoints.api, path))
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header(SEC_WEBSOCKET_VERSION, "13")
        .header(SEC_WEBSOCKET_KEY, &key)
        .bearer_auth(token.token.expose())
        .send()
        .await
        .map_err(|_| RelayError::Network)?;
    if resp.status().as_u16() != 101 {
        let status = resp.status().as_u16();
        let body: Option<Value> = resp.json().await.ok();
        let code = body.as_ref().and_then(|b| b.get("error")).and_then(|e| e.as_str()).unwrap_or("unknown").to_string();
        return Err(RelayError::Refused(ApiError { status, code, body, retry_after: None }));
    }
    let expected = derive_accept_key(key.as_bytes());
    if resp.headers().get(SEC_WEBSOCKET_ACCEPT).and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return Err(RelayError::Network);
    }
    let upgraded = resp.upgrade().await.map_err(|_| RelayError::Network)?;
    let config = WebSocketConfig::default().max_message_size(Some(MAX_WS_MESSAGE)).max_frame_size(Some(MAX_WS_MESSAGE));
    Ok(WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await)
}

fn close_code(frame: Option<&CloseFrame>) -> u16 {
    frame.map(|f| u16::from(f.code)).unwrap_or(1005)
}

async fn close(ws: &mut Ws, code: u16, reason: &'static str) {
    let _ = ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
}

/// Waits for `{"type":"paired"}`; pause/resume before it are harmless.
async fn await_paired(ws: &mut Ws) -> Result<(), RelayError> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or_default();
                match v["type"].as_str() {
                    Some("paired") => return Ok(()),
                    Some("pause") | Some("resume") => continue,
                    _ => return Err(RelayError::Handshake),
                }
            }
            Some(Ok(Message::Close(f))) => return Err(RelayError::Closed(close_code(f.as_ref()))),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(_)) => return Err(RelayError::Handshake),
            Some(Err(_)) | None => return Err(RelayError::Network),
        }
    }
}

/// The next binary message (the handshake), skipping pause/resume.
async fn next_binary(ws: &mut Ws) -> Result<Vec<u8>, RelayError> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Binary(b))) => return Ok(b.to_vec()),
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or_default();
                if !matches!(v["type"].as_str(), Some("pause") | Some("resume")) {
                    return Err(RelayError::Handshake);
                }
            }
            Some(Ok(Message::Close(f))) => return Err(RelayError::Closed(close_code(f.as_ref()))),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Err(RelayError::Network),
        }
    }
}

/// How a tunnel joins its writes (spec section 5.4: 50 ms or up to 65,519
/// bytes, whichever comes first).
#[derive(Debug, Clone, Copy)]
pub struct Join(pub Duration);

impl Default for Join {
    fn default() -> Self {
        Join(Duration::from_millis(50))
    }
}

/// A paired, handshaken data socket carrying one yamux session.
pub struct Tunnel {
    pub session: Session,
    closer: mpsc::UnboundedSender<u16>,
    /// Resolves with the close code once the socket closes.
    pub closed: watch::Receiver<Option<u16>>,
}

impl Tunnel {
    fn start(ws: Ws, transport: Transport, client: bool, join: Join) -> Tunnel {
        let (session, mut outbound) = Session::new(client);
        let (closer, mut close_rx) = mpsc::unbounded_channel::<u16>();
        let (closed_tx, closed) = watch::channel(None);
        let transport = Arc::new(Mutex::new(transport));
        let (mut sink, mut stream) = ws.split();
        let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<Message>();
        let (pause_tx, mut pause_rx) = watch::channel(false);

        // Writer: joins yamux frames, encrypts, honours pause, sends acks.
        let t_out = transport.clone();
        let writer = tokio::spawn(async move {
            let mut ping = tokio::time::interval(PING_EVERY);
            ping.tick().await;
            let mut pending: Vec<u8> = Vec::new();
            let mut deadline: Option<tokio::time::Instant> = None;
            loop {
                let flush_now = pending.len() >= MAX_PLAINTEXT;
                let sleep = async {
                    match deadline {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    biased;
                    code = close_rx.recv() => {
                        let code = code.unwrap_or(1000);
                        let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() }))).await;
                        return;
                    }
                    Some(msg) = ctl_rx.recv() => {
                        if sink.send(msg).await.is_err() { return; }
                        continue;
                    }
                    _ = ping.tick() => {
                        if sink.send(Message::Ping(Vec::new().into())).await.is_err() { return; }
                        continue;
                    }
                    bytes = outbound.recv(), if !flush_now => {
                        match bytes {
                            Some(b) => {
                                pending.extend_from_slice(&b);
                                deadline.get_or_insert_with(|| tokio::time::Instant::now() + join.0);
                                if pending.len() < MAX_PLAINTEXT { continue; }
                            }
                            None => return,
                        }
                    }
                    _ = sleep => {}
                }
                // Flush what is pending, in messages of at most MAX_PLAINTEXT.
                deadline = None;
                let mut at = 0;
                while at < pending.len() {
                    // Paused: hold data, but still send acks and honour a close.
                    while *pause_rx.borrow() {
                        tokio::select! {
                            r = pause_rx.changed() => if r.is_err() { return; },
                            code = close_rx.recv() => {
                                let code = code.unwrap_or(1000);
                                let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() }))).await;
                                return;
                            }
                            Some(msg) = ctl_rx.recv() => {
                                if sink.send(msg).await.is_err() { return; }
                            }
                        }
                    }
                    let end = (at + MAX_PLAINTEXT).min(pending.len());
                    let msg = match t_out.lock().expect("noise lock").encrypt(&pending[at..end]) {
                        Ok(m) => m,
                        Err(_) => return,
                    };
                    if sink.send(Message::Binary(msg.into())).await.is_err() {
                        return;
                    }
                    at = end;
                }
                pending.clear();
            }
        });

        // Reader: decrypts into the session, counts bytes for acks.
        let s_in = session.clone();
        let closer_in = closer.clone();
        tokio::spawn(async move {
            let mut unacked = 0usize;
            let mut code = 1006u16;
            loop {
                let next = if unacked > 0 {
                    match tokio::time::timeout(ACK_IDLE, stream.next()).await {
                        Ok(n) => n,
                        Err(_) => {
                            let _ = ctl_tx.send(Message::Text(json!({"type":"ack","bytes":unacked}).to_string().into()));
                            unacked = 0;
                            continue;
                        }
                    }
                } else {
                    stream.next().await
                };
                match next {
                    Some(Ok(Message::Binary(b))) => {
                        unacked += b.len();
                        if unacked >= ACK_BYTES {
                            let _ = ctl_tx.send(Message::Text(json!({"type":"ack","bytes":unacked}).to_string().into()));
                            unacked = 0;
                        }
                        let plain = transport.lock().expect("noise lock").decrypt(&b);
                        match plain {
                            Ok(p) => {
                                if s_in.receive(&p).is_err() {
                                    let _ = closer_in.send(4002);
                                    code = 4002;
                                    break;
                                }
                            }
                            Err(_) => {
                                let _ = closer_in.send(4002);
                                code = 4002;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap_or_default();
                        match v["type"].as_str() {
                            Some("pause") => {
                                let _ = pause_tx.send(true);
                            }
                            Some("resume") => {
                                let _ = pause_tx.send(false);
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(f))) => {
                        code = close_code(f.as_ref());
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
            s_in.close();
            let _ = pause_tx.send(false);
            let _ = closed_tx.send(Some(code));
            writer.abort();
        });
        Tunnel { session, closer, closed }
    }

    /// Go Away, then close the socket with `code`.
    pub fn end(&self, code: u16) {
        self.session.go_away();
        let _ = self.closer.send(code);
    }

    /// A handle that closes this tunnel from elsewhere (revocation).
    pub fn closer(&self) -> Closer {
        Closer(self.closer.clone())
    }

    pub async fn wait_closed(&mut self) -> u16 {
        loop {
            if let Some(code) = *self.closed.borrow() {
                return code;
            }
            if self.closed.changed().await.is_err() {
                return 1006;
            }
        }
    }
}

/// Closes a tunnel.
#[derive(Clone)]
pub struct Closer(mpsc::UnboundedSender<u16>);

impl Closer {
    pub fn close(&self, code: u16) {
        let _ = self.0.send(code);
    }
}

/// The controller side: opens a session to `host_id`, whose `box` key
/// comes from the controller's verified roster.
pub async fn connect(cloud: &Cloud, http1: &reqwest::Client, host_id: &str, host_box: &[u8; 32], join: Join) -> Result<Tunnel, RelayError> {
    let account = cloud.account_id.clone().ok_or(RelayError::Handshake)?;
    let session_id = b64(&random_bytes::<16>());
    let mut ws = open_socket(cloud, http1, &format!("/v1/relay/host/{host_id}/data/{session_id}")).await?;
    await_paired(&mut ws).await?;
    let prologue = noise::prologue(&account, &session_id, &cloud.device_id(), host_id);
    let mut init = Initiator::new(cloud.keys.r#box.seed(), host_box, &prologue, None).map_err(|_| RelayError::Handshake)?;
    let m1 = init.write_message1().map_err(|_| RelayError::Handshake)?;
    ws.send(Message::Binary(m1.into())).await.map_err(|_| RelayError::Network)?;
    let m2 = next_binary(&mut ws).await?;
    match init.read_message2(&m2) {
        Ok(t) => Ok(Tunnel::start(ws, t, true, join)),
        Err(_) => {
            close(&mut ws, 4002, "handshake").await;
            Err(RelayError::Handshake)
        }
    }
}

/// What a host decides and does, from its verified roster.
pub trait HostHandler: Send + Sync + 'static {
    /// The `box` key of an active controller in the host's verified
    /// roster, or `None` to refuse it.
    fn controller_box(&self, device_id: &str) -> Option<[u8; 32]>;
    /// Serves one stream (one HTTP exchange) from `from`.
    fn serve(&self, stream: Stream, from: String);
    /// The relay says the roster or floor changed.
    fn on_roster(&self, version: u64, revoked: Vec<String>);
}

/// Open sessions by controller, so a removed device loses them at once.
#[derive(Default, Clone)]
pub struct Sessions(Arc<Mutex<HashMap<String, Vec<Closer>>>>);

impl Sessions {
    fn add(&self, device: &str, closer: Closer) {
        self.0.lock().expect("sessions lock").entry(device.to_string()).or_default().push(closer);
    }

    /// Forgets a session that ended.
    fn remove(&self, device: &str, closer: &Closer) {
        let mut map = self.0.lock().expect("sessions lock");
        if let Some(list) = map.get_mut(device) {
            list.retain(|c| !c.0.same_channel(&closer.0));
            if list.is_empty() {
                map.remove(device);
            }
        }
    }

    /// Closes every session of `device` with 4001.
    pub fn revoke(&self, device: &str) {
        if let Some(list) = self.0.lock().expect("sessions lock").remove(device) {
            for c in list {
                c.close(4001);
            }
        }
    }

    pub fn close_all(&self, code: u16) {
        for (_, list) in self.0.lock().expect("sessions lock").drain() {
            for c in list {
                c.close(code);
            }
        }
    }

    pub fn count(&self) -> usize {
        self.0.lock().expect("sessions lock").values().map(Vec::len).sum()
    }
}

/// The host side: holds the presence socket and serves each offer until
/// presence closes. Returns how it ended.
pub async fn host(cloud: Arc<Cloud>, http1: reqwest::Client, handler: Arc<dyn HostHandler>, sessions: Sessions, join: Join, stop: oneshot::Receiver<()>) -> RelayError {
    let path = format!("/v1/relay/host/{}/presence", cloud.device_id());
    let mut ws = match open_socket(&cloud, &http1, &path).await {
        Ok(ws) => ws,
        Err(e) => return e,
    };
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut stop = stop;
    loop {
        tokio::select! {
            _ = &mut stop => {
                close(&mut ws, 1000, "stop").await;
                sessions.close_all(1000);
                return RelayError::Closed(1000);
            }
            _ = ping.tick() => {
                if ws.send(Message::Ping(Vec::new().into())).await.is_err() { return RelayError::Network; }
            }
            msg = ws.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap_or_default();
                    match v["type"].as_str() {
                        Some("offer") => {
                            let (Some(sid), Some(from)) = (v["session_id"].as_str(), v["from"].as_str()) else { continue };
                            let (sid, from) = (sid.to_string(), from.to_string());
                            let (cloud, http1, handler, sessions) = (cloud.clone(), http1.clone(), handler.clone(), sessions.clone());
                            tokio::spawn(async move { let _ = join_session(&cloud, &http1, &sid, &from, handler, sessions, join).await; });
                        }
                        Some("roster") => {
                            let revoked: Vec<String> = v["revoked"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                            for d in &revoked {
                                sessions.revoke(d);
                            }
                            handler.on_roster(v["version"].as_u64().unwrap_or(0), revoked);
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(f))) => {
                    let code = close_code(f.as_ref());
                    sessions.close_all(code);
                    return RelayError::Closed(code);
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => {
                    sessions.close_all(1006);
                    return RelayError::Network;
                }
            }
        }
    }
}

async fn join_session(
    cloud: &Cloud,
    http1: &reqwest::Client,
    session_id: &str,
    from: &str,
    handler: Arc<dyn HostHandler>,
    sessions: Sessions,
    join: Join,
) -> Result<(), RelayError> {
    let known = handler.controller_box(from);
    let account = cloud.account_id.clone().ok_or(RelayError::Handshake)?;
    let mut ws = open_socket(cloud, http1, &format!("/v1/relay/host/{}/data/{session_id}", cloud.device_id())).await?;
    await_paired(&mut ws).await?;
    let prologue = noise::prologue(&account, session_id, from, &cloud.device_id());
    let mut resp = Responder::new(cloud.keys.r#box.seed(), &prologue, None).map_err(|_| RelayError::Handshake)?;
    let m1 = next_binary(&mut ws).await?;
    // The initiator must be the offer's device, with the box key our
    // roster lists, and still active.
    match (resp.read_message1(&m1), known) {
        (Ok(rs), Some(k)) if bool::from(subtle::ConstantTimeEq::ct_eq(&rs[..], &k[..])) => {}
        _ => {
            close(&mut ws, 4002, "handshake").await;
            return Err(RelayError::Handshake);
        }
    }
    let (m2, transport) = resp.write_message2().map_err(|_| RelayError::Handshake)?;
    ws.send(Message::Binary(m2.into())).await.map_err(|_| RelayError::Network)?;
    let mut tunnel = Tunnel::start(ws, transport, false, join);
    let closer = tunnel.closer();
    sessions.add(from, closer.clone());
    // A removal between the handshake and `add` was missed by `revoke`.
    if handler.controller_box(from).is_none() {
        closer.close(4001);
    }
    let session = tunnel.session.clone();
    let from_owned = from.to_string();
    let h = handler.clone();
    let on_removed = closer.clone();
    tokio::spawn(async move {
        while let Some(stream) = session.accept().await {
            // Each new stream re-checks that the controller is still active.
            if h.controller_box(&from_owned).is_none() {
                on_removed.close(4001);
                break;
            }
            h.serve(stream, from_owned.clone());
        }
    });
    let code = tunnel.wait_closed().await;
    sessions.remove(from, &closer);
    Err(RelayError::Closed(code))
}
