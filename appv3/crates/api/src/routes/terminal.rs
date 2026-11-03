//! `/api/terminal` — port of `app/api/routes/terminal.py` (single-use
//! tickets + PTY over WebSocket).
//!
//! v3 adds a `{"type": "busy", "busy": bool}` frame, sent whenever a command
//! starts or stops running in the shell, so the client can keep a terminal
//! with a running command open.
//!
//! # Protocol v2 (`/ws?ticket=…&proto=2`)
//!
//! Shells outlive their socket. `POST /ticket` takes an optional
//! `session_id` (reattach; 404 if unknown or in another workspace) and
//! `since` (a `seq`, default 0), and answers `{ticket, expires_in,
//! protocol: 2[, session_id]}`. `GET /sessions?workspace=` lists live
//! sessions and `DELETE /sessions/{id}` kills one.
//!
//! Server → client:
//! - text `{"type":"attached","session_id","seq"}` first: `seq` is the offset
//!   of the first output byte that follows (0 for a new session, else
//!   `max(since, ring start)` with `since` clamped to the bytes produced);
//! - text `{"type":"busy","busy":bool}`: once right after `attached` (Unix
//!   only, so the client learns it is supported), then on every change;
//! - binary: 8 bytes big-endian `seq` of the payload's first byte, then at
//!   most 64 KiB of raw PTY bytes (the client decodes). A `seq` gap means
//!   output was dropped while detached;
//! - text `{"type":"exit"}` when the shell exits, then close;
//! - text `{"type":"error","message"}` then close 4429 (spawn failed) or
//!   4404 (reattach target gone);
//! - close 4409 "attached elsewhere" when another ticket takes the session.
//!
//! Client → server (text JSON): `input`, `resize`, and `{"type":"ack","seq"}`
//! (the `seq` just past the last byte processed). Output stops while more
//! than 512 KiB is unacknowledged and resumes at 128 KiB. Malformed or
//! unknown frames are ignored. Ending the socket detaches; the session is
//! closed after `DETACHED_GRACE` without a reattach.
//!
//! Without `proto=2` the original protocol applies unchanged (JSON `output`
//! frames, the first non-JSON frame or the socket ending kills the shell),
//! for older clients and remote servers on another version.

use crate::error::{ApiError, ApiResult};
use crate::schema::Body;
use crate::util::*;
use crate::AppState;
use appv3_agent::manager;
use appv3_terminal::{Attachment, Flow, Next, TerminalSession, CHUNK_BYTES};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const TICKET_TTL: Duration = Duration::from_secs(30);
const MAX_PENDING_TICKETS: usize = 32;
/// How often the socket checks whether a command is running in the shell.
const BUSY_POLL: Duration = Duration::from_millis(500);

struct Ticket {
    workspace: String,
    expiry: Instant,
    rows: i64,
    cols: i64,
    /// Reattach to this session instead of spawning one.
    session_id: Option<String>,
    since: u64,
}

fn tickets() -> &'static Mutex<HashMap<String, Ticket>> {
    static T: OnceLock<Mutex<HashMap<String, Ticket>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

fn prune(map: &mut HashMap<String, Ticket>) {
    let now = Instant::now();
    map.retain(|_, t| now <= t.expiry);
}

pub fn router() -> Router<AppState> {
    Router::new().route("/ticket", post(issue_ticket)).route("/ws", get(terminal_ws)).route("/sessions", get(list_sessions)).route("/sessions/{session_id}", delete(kill_session))
}

fn int_field(b: &mut Body, k: &str, default: i64, ge: i64, le: i64) -> i64 {
    let v = b.opt_int(k).unwrap_or(default);
    if b.obj.contains_key(k) && b.errs.is_empty() {
        let input = b.obj[k].clone();
        if v < ge {
            b.errs.push(crate::error::verr_ctx(
                "greater_than_equal",
                &[json!("body"), json!(k)],
                &format!("Input should be greater than or equal to {ge}"),
                input,
                json!({"ge": ge}),
            ));
        } else if v > le {
            b.errs.push(crate::error::verr_ctx("less_than_equal", &[json!("body"), json!(k)], &format!("Input should be less than or equal to {le}"), input, json!({"le": le})));
        }
    }
    v
}

async fn issue_ticket(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let workspace = b.str_min1("workspace");
    let rows = int_field(&mut b, "rows", 24, 1, 1000);
    let cols = int_field(&mut b, "cols", 80, 1, 4000);
    let session_id = b.opt_str("session_id");
    let since = int_field(&mut b, "since", 0, 0, i64::MAX) as u64;
    // TicketRequest allows extras (plain BaseModel): ignore unknown keys.
    let allowed: Vec<&str> = b.obj.keys().map(String::as_str).collect();
    b.finish(&allowed)?;
    let resolved = manager::validate_workspace(&workspace, true).map_err(ApiError::bad_request)?;
    if let Some(id) = &session_id {
        // Another workspace's session is as good as unknown.
        if !appv3_terminal::get_session(id).is_some_and(|s| s.workspace == resolved && s.alive()) {
            return Err(not_found());
        }
    }
    let mut map = tickets().lock().unwrap();
    prune(&mut map);
    if map.len() >= MAX_PENDING_TICKETS {
        return Err(ApiError::new(429, "Too many pending tickets."));
    }
    let t = crate::util::token_urlsafe();
    let mut resp = json!({"ticket": t, "expires_in": TICKET_TTL.as_secs_f64(), "protocol": 2});
    if let Some(id) = &session_id {
        resp["session_id"] = json!(id);
    }
    map.insert(t.clone(), Ticket { workspace: resolved, expiry: Instant::now() + TICKET_TTL, rows, cols, session_id, since });
    Ok(json(resp))
}

fn not_found() -> ApiError {
    ApiError::not_found("Terminal session not found.")
}

async fn list_sessions(q: Qs) -> ApiResult<Response> {
    let workspace = manager::validate_workspace(&q.req("workspace")?, false).map_err(ApiError::bad_request)?;
    let sessions: Vec<Value> = appv3_terminal::list_sessions()
        .iter()
        .filter(|s| s.workspace == workspace)
        .map(|s| {
            json!({
                "session_id": s.session_id,
                "workspace": s.workspace,
                "created_at": chrono::DateTime::<chrono::Utc>::from(s.created_at).to_rfc3339(),
                "attached": s.is_attached(),
                "busy": s.busy(),
            })
        })
        .collect();
    Ok(json(json!({ "sessions": sessions })))
}

async fn kill_session(AxPath(session_id): AxPath<String>) -> ApiResult<Response> {
    let Some(s) = appv3_terminal::get_session(&session_id) else { return Err(not_found()) };
    s.close().await;
    Ok(no_content())
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `_redeem_ticket` — pop on first use; constant-time comparison.
fn redeem(ticket: &str) -> Option<Ticket> {
    let mut map = tickets().lock().unwrap();
    prune(&mut map);
    let mut matched = None;
    for k in map.keys() {
        if ct_eq(k.as_bytes(), ticket.as_bytes()) {
            matched = Some(k.clone());
        }
    }
    let t = map.remove(&matched?)?;
    (Instant::now() <= t.expiry).then_some(t)
}

async fn terminal_ws(q: Qs, ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>) -> Response {
    // A websocket-only route never matches plain HTTP in Starlette.
    let Ok(ws) = ws else { return json_code(404, json!({"detail": "Not Found"})) };
    let ticket = q.opt("ticket").unwrap_or_default();
    let redeemed = if ticket.is_empty() { None } else { redeem(&ticket) };
    let Some(t) = redeemed else {
        // Closing before accept → the handshake is answered with HTTP 403.
        return crate::middleware::ws_reject();
    };
    let v2 = q.get("proto") == Some("2");
    ws.on_upgrade(move |socket| run_socket(socket, t, v2))
}

async fn send_json(tx: &mut futures::stream::SplitSink<WebSocket, Message>, v: Value) -> bool {
    tx.send(Message::Text(v.to_string().into())).await.is_ok()
}

/// Incremental UTF-8 decoding (`codecs.getincrementaldecoder("utf-8")(errors="replace")`).
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn decode(&mut self, chunk: &[u8], last: bool) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..good]).unwrap());
                    match e.error_len() {
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..good + bad);
                        }
                        None => {
                            self.pending.drain(..good);
                            if last {
                                out.push('\u{FFFD}');
                                self.pending.clear();
                            }
                            return out;
                        }
                    }
                }
            }
        }
    }
}

type WsTx = futures::stream::SplitSink<WebSocket, Message>;

fn close_message(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: reason.to_string().into() }))
}

/// Report a failure to open the session, then close with `code`. The
/// original protocol shows it as terminal output; v2 as an `error` frame.
async fn fail(tx: &mut WsTx, v2: bool, message: &str, code: u16) {
    let frame = if v2 { json!({"type": "error", "message": message}) } else { json!({"type": "output", "data": format!("\r\n{message}\r\n")}) };
    let _ = send_json(tx, frame).await;
    let _ = tx.send(close_message(code, "")).await;
}

async fn run_socket(socket: WebSocket, t: Ticket, v2: bool) {
    let (mut tx, rx) = socket.split();
    let (session, since) = match &t.session_id {
        Some(id) => match appv3_terminal::get_session(id).filter(|s| s.workspace == t.workspace && s.alive()) {
            Some(s) => {
                s.resize(t.rows, t.cols);
                (s, t.since)
            }
            None => {
                fail(&mut tx, v2, "Terminal session not found.", 4404).await;
                return;
            }
        },
        None => {
            let ws_path = t.workspace.clone();
            match tokio::task::spawn_blocking(move || appv3_terminal::create_session(&ws_path, t.rows, t.cols)).await {
                Ok(Ok(s)) => (s, 0),
                Ok(Err(e)) => {
                    tracing::warn!("terminal_spawn_failed workspace={} err={}", t.workspace, e);
                    fail(&mut tx, v2, &e, 4429).await;
                    return;
                }
                Err(e) => {
                    tracing::warn!("terminal_spawn_failed workspace={} err={}", t.workspace, e);
                    let _ = tx.send(close_message(4429, "")).await;
                    return;
                }
            }
        }
    };
    tracing::info!("terminal_ws_connected session_id={} workspace={} proto={}", session.session_id, t.workspace, if v2 { 2 } else { 1 });
    // Attaching supersedes (and so closes) whichever socket had the session.
    let att = session.attach(since);
    if v2 {
        run_v2(tx, rx, session, att).await;
    } else {
        run_v1(tx, rx, session, att).await;
    }
}

/// How a v2 socket's output side ended.
enum End {
    /// The shell exited (or the session was killed): `exit` was sent.
    Exit,
    /// Another ticket took the session; the socket was closed with 4409.
    Superseded,
    /// The client went away.
    Gone,
}

/// Handle one client frame. `Err` ends the socket.
async fn client_frame(session: &TerminalSession, v: &Value, ack: Option<&tokio::sync::watch::Sender<u64>>) -> Result<(), std::io::Error> {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("input") => {
            if let Some(d) = v.get("data").and_then(|d| d.as_str()).filter(|d| !d.is_empty()) {
                session.write(d.as_bytes().to_vec()).await?;
            }
        }
        Some("resize") => {
            let is_int = |x: Option<&Value>| x.and_then(|n| n.as_i64());
            if let (Some(r), Some(c)) = (is_int(v.get("rows")), is_int(v.get("cols"))) {
                session.resize(r, c);
            }
        }
        Some("ack") => {
            if let (Some(ack), Some(seq)) = (ack, v.get("seq").and_then(|n| n.as_u64())) {
                ack.send_if_modified(|cur| {
                    let moved = seq > *cur;
                    *cur = (*cur).max(seq);
                    moved
                });
            }
        }
        _ => {}
    }
    Ok(())
}

/// Client frames → shell. The original protocol ends on the first non-JSON
/// frame; v2 (`ack` is `Some`) ignores it.
async fn to_pty(mut rx: futures::stream::SplitStream<WebSocket>, session: Arc<TerminalSession>, ack: Option<tokio::sync::watch::Sender<u64>>) {
    while let Some(Ok(msg)) = rx.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            if ack.is_some() {
                tracing::debug!("terminal_ws_bad_frame session_id={} len={}", session.session_id, text.len());
                continue;
            }
            break;
        };
        if ack.is_some() && !matches!(v.get("type").and_then(|t| t.as_str()), Some("input" | "resize" | "ack")) {
            tracing::debug!("terminal_ws_unknown_frame session_id={}", session.session_id);
        }
        if let Err(e) = client_frame(&session, &v, ack.as_ref()).await {
            tracing::warn!("terminal_ws_error session_id={} err={}", session.session_id, e);
            break;
        }
    }
}

async fn run_v2(mut tx: WsTx, rx: futures::stream::SplitStream<WebSocket>, session: Arc<TerminalSession>, att: Attachment) {
    let hello = json!({"type": "attached", "session_id": session.session_id, "seq": att.start_seq()});
    if !send_json(&mut tx, hello).await {
        return;
    }
    // The first busy frame also tells the client busy detection works here.
    let mut busy = session.busy();
    if cfg!(unix) && !send_json(&mut tx, json!({"type": "busy", "busy": busy})).await {
        return;
    }
    let (ack_tx, mut ack_rx) = tokio::sync::watch::channel(att.start_seq());
    let s_out = session.clone();
    let to_ws = async move {
        let mut flow = Flow::new(att.start_seq());
        let mut poll = tokio::time::interval(BUSY_POLL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let end = loop {
            let may_send = flow.may_send(att.cursor());
            tokio::select! {
                _ = att.superseded() => {
                    let _ = tx.send(close_message(4409, "attached elsewhere")).await;
                    break End::Superseded;
                }
                _ = ack_rx.changed() => {
                    let seq = *ack_rx.borrow_and_update();
                    flow.ack(seq);
                }
                next = att.next(CHUNK_BYTES), if may_send => match next {
                    Next::Data { seq, bytes } => {
                        let mut frame = Vec::with_capacity(8 + bytes.len());
                        frame.extend_from_slice(&seq.to_be_bytes());
                        frame.extend_from_slice(&bytes);
                        if tx.send(Message::Binary(frame.into())).await.is_err() {
                            break End::Gone;
                        }
                    }
                    Next::Eof => {
                        let _ = send_json(&mut tx, json!({"type": "exit"})).await;
                        break End::Exit;
                    }
                    Next::Superseded => {
                        let _ = tx.send(close_message(4409, "attached elsewhere")).await;
                        break End::Superseded;
                    }
                },
                _ = poll.tick() => {
                    let now = s_out.busy();
                    if now != busy {
                        busy = now;
                        if !send_json(&mut tx, json!({"type": "busy", "busy": now})).await {
                            break End::Gone;
                        }
                    }
                }
            }
        };
        (tx, end)
    };
    let pty = to_pty(rx, session.clone(), Some(ack_tx));
    tokio::select! {
        (mut tx, end) = to_ws => match end {
            End::Exit => {
                let _ = tx.send(Message::Close(None)).await;
                session.close().await;
            }
            End::Superseded | End::Gone => {}
        },
        // The socket ended: dropping the attachment detaches, the shell lives on.
        _ = pty => {}
    }
}

/// The original protocol: JSON `output` frames, and the shell dies with the socket.
async fn run_v1(mut tx: WsTx, rx: futures::stream::SplitStream<WebSocket>, session: Arc<TerminalSession>, att: Attachment) {
    let s_out = session.clone();
    let to_ws = async move {
        let mut dec = Utf8Decoder { pending: vec![] };
        let mut busy = false;
        let mut poll = tokio::time::interval(BUSY_POLL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                next = att.next(CHUNK_BYTES) => match next {
                    Next::Data { bytes, .. } => {
                        let text = dec.decode(&bytes, false);
                        if !send_json(&mut tx, json!({"type": "output", "data": text})).await {
                            return tx;
                        }
                    }
                    Next::Eof | Next::Superseded => {
                        let tail = dec.decode(&[], true);
                        if !tail.is_empty() {
                            let _ = send_json(&mut tx, json!({"type": "output", "data": tail})).await;
                        }
                        let _ = send_json(&mut tx, json!({"type": "exit"})).await;
                        return tx;
                    }
                },
                _ = poll.tick() => {
                    let now = s_out.busy();
                    if now != busy {
                        busy = now;
                        if !send_json(&mut tx, json!({"type": "busy", "busy": now})).await {
                            return tx;
                        }
                    }
                }
            }
        }
    };
    let sink = tokio::select! {
        tx = to_ws => Some(tx),
        _ = to_pty(rx, session.clone(), None) => None,
    };
    session.close().await;
    if let Some(mut tx) = sink {
        let _ = tx.send(Message::Close(None)).await;
    }
}
