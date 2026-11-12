//! A TCP proxy in front of the fake relay that drops the client's WebSocket
//! protocol pings on upgraded connections, so no protocol pong ever comes
//! back: what a device sees when its pings get no answer it can read.
//! Everything else (the HTTP request, text and binary frames) passes as is.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const PING: u8 = 0x9;

/// Serves the proxy for `upstream` (an `http://host:port` base); returns
/// its own base URL.
pub async fn without_protocol_pongs(upstream: &str) -> String {
    let target = upstream.trim_start_matches("http://").to_string();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let target = target.clone();
            tokio::spawn(async move {
                if let Ok(server) = TcpStream::connect(&target).await {
                    let _ = proxy_one(client, server).await;
                }
            });
        }
    });
    format!("http://{addr}")
}

async fn proxy_one(client: TcpStream, server: TcpStream) -> std::io::Result<()> {
    let (mut from_client, mut to_client) = client.into_split();
    let (mut from_server, mut to_server) = server.into_split();
    let down = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut from_server, &mut to_client).await;
        let _ = to_client.shutdown().await;
    });
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    // The request head, as is.
    let head_end = loop {
        let n = from_client.read(&mut chunk).await?;
        if n == 0 {
            down.abort();
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let upgrade = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase().contains("upgrade: websocket");
    to_server.write_all(&buf[..head_end]).await?;
    let mut rest = buf.split_off(head_end);
    if !upgrade {
        to_server.write_all(&rest).await?;
        tokio::io::copy(&mut from_client, &mut to_server).await?;
        let _ = to_server.shutdown().await;
        let _ = down.await;
        return Ok(());
    }
    // WebSocket frames from the client: forward all but protocol pings.
    loop {
        while let Some(len) = frame_len(&rest) {
            if rest[0] & 0x0f != PING {
                to_server.write_all(&rest[..len]).await?;
            }
            rest.drain(..len);
        }
        let n = from_client.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        rest.extend_from_slice(&chunk[..n]);
    }
    let _ = to_server.shutdown().await;
    let _ = down.await;
    Ok(())
}

/// The length of the whole first frame in `b`, once it is all there.
fn frame_len(b: &[u8]) -> Option<usize> {
    if b.len() < 2 {
        return None;
    }
    let (len, mut at) = match b[1] & 0x7f {
        126 if b.len() >= 4 => (u16::from_be_bytes([b[2], b[3]]) as usize, 4),
        127 if b.len() >= 10 => (u64::from_be_bytes(b[2..10].try_into().unwrap()) as usize, 10),
        126 | 127 => return None,
        n => (n as usize, 2),
    };
    if b[1] & 0x80 != 0 {
        at += 4;
    }
    (b.len() >= at + len).then_some(at + len)
}

/// Serves a TCP proxy for `upstream` that holds every chunk `one_way`
/// before passing it on, each way: a network with a round trip of twice
/// `one_way`, order kept. Returns its own base URL.
#[allow(dead_code)]
pub async fn with_latency(upstream: &str, one_way: std::time::Duration) -> String {
    let target = upstream.trim_start_matches("http://").to_string();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let target = target.clone();
            tokio::spawn(async move {
                let Ok(server) = TcpStream::connect(&target).await else {
                    return;
                };
                let _ = client.set_nodelay(true);
                let _ = server.set_nodelay(true);
                let (cr, cw) = client.into_split();
                let (sr, sw) = server.into_split();
                tokio::join!(delayed(cr, sw, one_way, None), delayed(sr, cw, one_way, None));
            });
        }
    });
    format!("http://{addr}")
}

/// Serves a TCP proxy for `upstream` that drops every byte, both ways,
/// while the returned switch is on, and keeps the connections open: a
/// network that went away without a word (Wi-Fi gone, a sleep).
#[allow(dead_code)]
pub async fn freezable(upstream: &str) -> (String, std::sync::Arc<std::sync::atomic::AtomicBool>) {
    let target = upstream.trim_start_matches("http://").to_string();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let frozen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let f = frozen.clone();
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let (target, f) = (target.clone(), f.clone());
            tokio::spawn(async move {
                let Ok(server) = TcpStream::connect(&target).await else {
                    return;
                };
                let (cr, cw) = client.into_split();
                let (sr, sw) = server.into_split();
                let none = std::time::Duration::ZERO;
                tokio::join!(delayed(cr, sw, none, Some(f.clone())), delayed(sr, cw, none, Some(f)));
            });
        }
    });
    (format!("http://{addr}"), frozen)
}

async fn delayed(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    one_way: std::time::Duration,
    frozen: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(tokio::time::Instant, Vec<u8>)>();
    let writer = tokio::spawn(async move {
        while let Some((at, bytes)) = rx.recv().await {
            tokio::time::sleep_until(at + one_way).await;
            if to.write_all(&bytes).await.is_err() {
                return;
            }
        }
        let _ = to.shutdown().await;
    });
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match from.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(_) if frozen.as_ref().is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed)) => {}
            Ok(n) => {
                if tx.send((tokio::time::Instant::now(), chunk[..n].to_vec())).is_err() {
                    break;
                }
            }
        }
    }
    drop(tx);
    let _ = writer.await;
}
