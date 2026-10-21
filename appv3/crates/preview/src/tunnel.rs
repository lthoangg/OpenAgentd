//! Raw TCP through a WebSocket, for clients that cannot reach the preview
//! listener's loopback port (the mobile app, a desktop app on another
//! computer).
//!
//! The API authenticates the WebSocket (`/api/preview/{id}/tunnel`) and
//! hands it here. Each tunnel is one TCP connection to the listener; the
//! client's native relay copies the bytes of one browser connection into
//! it, so HTTP keep-alive, long polls and dev-server WebSockets need no
//! special handling. Only binary frames carry data.

use crate::manager::{Entry, MAX_TUNNELS};
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Largest WebSocket message accepted from a tunnel client.
pub const MAX_TUNNEL_MESSAGE: usize = 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

/// Close codes sent to the client.
const CLOSE_UNSUPPORTED: u16 = 1003;
const CLOSE_INTERNAL: u16 = 1011;
const CLOSE_TRY_AGAIN: u16 = 1013;

async fn close(socket: &mut futures::stream::SplitSink<WebSocket, Message>, code: u16, reason: &str) {
    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
}

/// Pipe `socket` to a new TCP connection to `entry`'s listener until either
/// side closes or the preview stops.
pub async fn pipe(entry: Arc<Entry>, socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let Some(_slot) = entry.reserve_tunnel() else {
        tracing::warn!("preview_tunnel_limit id={} max={}", entry.id, MAX_TUNNELS);
        return close(&mut ws_tx, CLOSE_TRY_AGAIN, "Too many tunnels").await;
    };
    let _guard = entry.begin();
    let tcp = match tokio::net::TcpStream::connect(("127.0.0.1", entry.port)).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("preview_tunnel_connect_failed id={} err={}", entry.id, e);
            return close(&mut ws_tx, CLOSE_INTERNAL, "Preview unavailable").await;
        }
    };
    let _ = tcp.set_nodelay(true);
    let (mut rd, mut wr) = tcp.into_split();
    let mut stop = entry.stop_rx();
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        tokio::select! {
            m = ws_rx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    if wr.write_all(&b).await.is_err() { break }
                }
                Some(Ok(Message::Text(_))) => {
                    close(&mut ws_tx, CLOSE_UNSUPPORTED, "Binary frames only").await;
                    break;
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => break,
            },
            n = rd.read(&mut buf) => match n {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_tx.send(Message::Binary(bytes::Bytes::copy_from_slice(&buf[..n]))).await.is_err() { break }
                }
            },
            _ = async { stop.wait_for(|v| *v).await.map(|_| ()) } => break,
        }
    }
    let _ = wr.shutdown().await;
    let _ = ws_tx.close().await;
}
