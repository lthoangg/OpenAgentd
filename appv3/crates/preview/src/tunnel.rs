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
///
/// Each direction is copied on its own: a client that sends a whole request
/// body before reading, to a page that streams its answer meanwhile, would
/// stall a loop that waits on one write at a time.
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
    let up = async {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if ws_tx.send(Message::Binary(bytes::Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                        return;
                    }
                }
            }
        }
    };
    // `true` when the client sent a text frame.
    let down = async {
        while let Some(Ok(m)) = ws_rx.next().await {
            match m {
                Message::Binary(b) => {
                    if wr.write_all(&b).await.is_err() {
                        return false;
                    }
                }
                Message::Text(_) => return true,
                Message::Ping(_) | Message::Pong(_) => {}
                Message::Close(_) => return false,
            }
        }
        false
    };
    let text_frame = tokio::select! {
        _ = up => false,
        text = down => text,
        _ = stop.wait_for(|v| *v) => false,
    };
    if text_frame {
        close(&mut ws_tx, CLOSE_UNSUPPORTED, "Binary frames only").await;
    }
    let _ = wr.shutdown().await;
    let _ = ws_tx.close().await;
}
