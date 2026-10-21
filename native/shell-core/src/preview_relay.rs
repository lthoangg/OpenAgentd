//! Loopback relay for the built-in web preview of a remote server.
//!
//! A preview listener binds the *server's* `127.0.0.1`, which a phone or
//! another computer cannot reach. The relay listens on this device's own
//! `127.0.0.1:<port>`; the Preview tab frames that origin, and every TCP
//! connection the webview opens becomes one WebSocket to
//! `<server>/api/preview/{id}/tunnel`, which carries the raw bytes to the
//! listener. HTTP keep-alive, the inspector's long poll and dev-server
//! WebSockets therefore pass through unchanged.
//!
//! The access key goes only into the tunnel's handshake; the page never
//! sees it and can reach only that one preview, never `/api`. Any process
//! on this device can connect to the relay while it is open (the same
//! trust as the server-side listener), so a relay closes with its Preview
//! tab, on a server change, and after [`IDLE_CLOSE`] without connections.
//!
//! Everything here spawns on the ambient Tokio runtime: call it from the
//! shells' async commands.

use futures_util::{SinkExt, StreamExt};
use reqwest::header::{
    CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// Most browser connections one relay carries at once.
pub const MAX_CONNECTIONS: usize = 32;
/// A relay with no open connection for this long closes.
pub const IDLE_CLOSE: Duration = Duration::from_secs(10 * 60);
/// Keeps tunnels alive through reverse proxies that drop idle sockets.
pub const PING_EVERY: Duration = Duration::from_secs(30);
const READ_CHUNK: usize = 64 * 1024;
/// The server accepts messages up to 1 MiB; chunks stay far below that.
const MAX_MESSAGE: usize = 1024 * 1024;

/// Where the Preview tab frames a relayed preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RelayInfo {
    pub port: u16,
    pub origin: String,
}

type Tunnel = WebSocketStream<reqwest::Upgraded>;

struct Relay {
    base_url: String,
    key: String,
    info: RelayInfo,
    alive: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
}

impl Relay {
    fn stop(&self) {
        // `send_replace` also lands before `serve` has subscribed.
        self.stop.send_replace(true);
    }
}

/// Open relays, keyed by a caller scope (a desktop window label; mobile
/// uses one scope) and preview id.
pub struct RelayRegistry {
    relays: Mutex<HashMap<Slot, Relay>>,
    /// One `open` per slot at a time, so overlapping opens (React StrictMode,
    /// a Retry during a load) reuse one relay instead of each binding a port
    /// and stopping the other's.
    opening: Mutex<HashMap<Slot, Arc<tokio::sync::Mutex<()>>>>,
    idle_close: Duration,
}

type Slot = (String, String);

/// A caller's turn to open a slot; forgets the slot's gate when no other
/// caller waits on it.
struct OpenTurn<'a> {
    opening: &'a Mutex<HashMap<Slot, Arc<tokio::sync::Mutex<()>>>>,
    slot: Slot,
    turn: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for OpenTurn<'_> {
    fn drop(&mut self) {
        let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
        // The map and this turn hold the only references: nobody waits.
        if Arc::strong_count(tokio::sync::OwnedMutexGuard::mutex(&self.turn)) == 2 {
            opening.remove(&self.slot);
        }
    }
}

impl Default for RelayRegistry {
    fn default() -> Self {
        Self::with_idle_close(IDLE_CLOSE)
    }
}

/// Whether `id` is a UUID, the only form a preview id takes.
pub fn is_preview_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// `<base>/api/preview/{id}/tunnel?port=<port>`, keeping a base path prefix
/// (a server behind a reverse proxy at `https://host/oad`).
pub fn tunnel_url(base_url: &str, preview_id: &str, port: u16) -> Result<String, String> {
    let mut url = url::Url::parse(base_url.trim()).map_err(|_| "invalid server URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("invalid server URL".to_string());
    }
    let path = format!(
        "{}/api/preview/{preview_id}/tunnel",
        url.path().trim_end_matches('/')
    );
    url.set_path(&path);
    url.set_query(Some(&format!("port={port}")));
    url.set_fragment(None);
    Ok(url.to_string())
}

fn status_error(status: u16) -> String {
    match status {
        401 | 403 => format!(
            "The server refused the preview ({status}). Previews on this device need the server to have an access key, and this app to have the same key."
        ),
        404 => "The server has no such preview, or is too old to share previews with this device (404). Update the server, then retry.".to_string(),
        _ => format!("The server could not open the preview ({status})."),
    }
}

/// One WebSocket to the tunnel route, over the shell's own HTTP client (and
/// so its TLS roots). The client must speak HTTP/1.1 only: an upgrade
/// cannot happen on HTTP/2.
async fn open_tunnel(client: &reqwest::Client, url: &str, key: &str) -> Result<Tunnel, String> {
    let ws_key = generate_key();
    let resp = client
        .get(url)
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header(SEC_WEBSOCKET_VERSION, "13")
        .header(SEC_WEBSOCKET_KEY, &ws_key)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Could not reach the server for the preview: {}",
                e.without_url()
            )
        })?;
    let status = resp.status().as_u16();
    if status != 101 {
        return Err(status_error(status));
    }
    let expected = derive_accept_key(ws_key.as_bytes());
    if resp
        .headers()
        .get(SEC_WEBSOCKET_ACCEPT)
        .and_then(|v| v.to_str().ok())
        != Some(expected.as_str())
    {
        return Err(
            "The server answered the preview with an invalid WebSocket handshake.".to_string(),
        );
    }
    let upgraded = resp
        .upgrade()
        .await
        .map_err(|e| format!("The preview connection failed: {}", e.without_url()))?;
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE));
    Ok(WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await)
}

async fn bind(preferred: u16) -> Result<TcpListener, String> {
    if preferred > 1024 {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", preferred)).await {
            return Ok(l);
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Could not start the preview relay: {e}"))
}

/// Copy one browser connection to and from its tunnel.
///
/// Each direction is copied on its own: a browser that sends a whole
/// request body before reading, to a server that streams its answer
/// meanwhile, would stall a loop that waits on one write at a time.
async fn pipe(tcp: TcpStream, tunnel: Tunnel, mut stop: watch::Receiver<bool>) {
    let _ = tcp.set_nodelay(true);
    let (mut rd, mut wr) = tcp.into_split();
    let (mut tx, mut rx) = tunnel.split();
    let up = async {
        let mut ping =
            tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            let msg = tokio::select! {
                n = rd.read(&mut buf) => match n {
                    Ok(0) | Err(_) => return,
                    Ok(n) => Message::binary(buf[..n].to_vec()),
                },
                _ = ping.tick() => Message::Ping(Vec::new().into()),
            };
            if tx.send(msg).await.is_err() {
                return;
            }
        }
    };
    let down = async {
        while let Some(Ok(m)) = rx.next().await {
            match m {
                Message::Binary(b) => {
                    if wr.write_all(&b).await.is_err() {
                        return;
                    }
                }
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                _ => return,
            }
        }
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
        _ = stop.wait_for(|v| *v) => {}
    }
    let _ = wr.shutdown().await;
    let _ = tx.close().await;
}

/// Errors that end one pending connection, not the listener.
fn connection_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionReset
    )
}

/// Other `accept` errors in a row before the listener counts as dead (iOS
/// reclaims it in the background). Short runs, such as running out of
/// file descriptors, are waited out.
const MAX_ACCEPT_FAILURES: u32 = 10;
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

struct Activity {
    open: AtomicUsize,
    last: Mutex<Instant>,
}

impl Activity {
    fn touch(&self) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }
    fn idle_for(&self) -> Duration {
        self.last
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed()
    }
}

struct OpenGuard(Arc<Activity>);

impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::SeqCst);
        self.0.touch();
    }
}

/// Where a relay's connections go.
struct Upstream {
    client: reqwest::Client,
    url: String,
    key: String,
}

/// Accept browser connections until stopped or idle.
async fn serve(
    listener: TcpListener,
    upstream: Arc<Upstream>,
    idle_close: Duration,
    alive: Arc<AtomicBool>,
    stop_tx: watch::Sender<bool>,
) {
    let mut stop = stop_tx.subscribe();
    let activity = Arc::new(Activity {
        open: AtomicUsize::new(0),
        last: Mutex::new(Instant::now()),
    });
    let mut check = tokio::time::interval((idle_close / 4).max(Duration::from_millis(10)));
    let mut failures = 0;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let tcp = match accepted {
                    Ok((tcp, _)) => {
                        failures = 0;
                        tcp
                    }
                    Err(e) if connection_error(&e) => continue,
                    Err(_) => {
                        failures += 1;
                        if failures >= MAX_ACCEPT_FAILURES {
                            break;
                        }
                        tokio::time::sleep(ACCEPT_RETRY).await;
                        continue;
                    }
                };
                if activity.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    activity.open.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let guard = OpenGuard(activity.clone());
                activity.touch();
                let (upstream, stop) = (upstream.clone(), stop.clone());
                tokio::spawn(async move {
                    let _guard = guard;
                    if let Ok(tunnel) = open_tunnel(&upstream.client, &upstream.url, &upstream.key).await {
                        pipe(tcp, tunnel, stop).await;
                    }
                });
            }
            _ = check.tick() => {
                if activity.open.load(Ordering::SeqCst) == 0 && activity.idle_for() >= idle_close {
                    break;
                }
            }
            _ = async { stop.wait_for(|v| *v).await.map(|_| ()) } => break,
        }
    }
    alive.store(false, Ordering::SeqCst);
    // Ends the connections still open (idle close or a dead listener).
    stop_tx.send_replace(true);
}

impl RelayRegistry {
    pub fn with_idle_close(idle_close: Duration) -> Self {
        Self {
            relays: Mutex::new(HashMap::new()),
            opening: Mutex::new(HashMap::new()),
            idle_close,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Slot, Relay>> {
        self.relays.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn turn(&self, slot: &Slot) -> OpenTurn<'_> {
        let gate = self
            .opening
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(slot.clone())
            .or_default()
            .clone();
        OpenTurn {
            opening: &self.opening,
            slot: slot.clone(),
            turn: gate.lock_owned().await,
        }
    }

    /// Start (or reuse) the relay for `preview_id` on `base_url`. It tries
    /// `preferred_port` (the server's preview port) first, so the page
    /// keeps its origin, cookies and storage across launches. One tunnel is
    /// opened before returning, so a wrong key or an old server is reported
    /// here rather than as a blank frame.
    pub async fn open(
        &self,
        scope: &str,
        client: &reqwest::Client,
        base_url: &str,
        key: &str,
        preview_id: &str,
        preferred_port: u16,
    ) -> Result<RelayInfo, String> {
        if !is_preview_id(preview_id) {
            return Err("invalid preview id".to_string());
        }
        let key = key.trim();
        if key.is_empty() {
            return Err("Previews on this device need this server's access key.".to_string());
        }
        let slot = (scope.to_string(), preview_id.to_string());
        let _turn = self.turn(&slot).await;
        {
            let mut relays = self.lock();
            if let Some(r) = relays.get(&slot) {
                if r.alive.load(Ordering::SeqCst) && r.base_url == base_url && r.key == key {
                    return Ok(r.info.clone());
                }
                if let Some(old) = relays.remove(&slot) {
                    old.stop();
                }
            }
        }
        let listener = bind(preferred_port).await?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Could not start the preview relay: {e}"))?
            .port();
        let url = tunnel_url(base_url, preview_id, port)?;
        let mut probe = open_tunnel(client, &url, key).await?;
        let _ = probe.close(None).await;

        let info = RelayInfo {
            port,
            origin: format!("http://127.0.0.1:{port}"),
        };
        let alive = Arc::new(AtomicBool::new(true));
        let (stop, _) = watch::channel(false);
        let upstream = Arc::new(Upstream {
            client: client.clone(),
            url,
            key: key.to_string(),
        });
        tokio::spawn(serve(
            listener,
            upstream,
            self.idle_close,
            alive.clone(),
            stop.clone(),
        ));
        let relay = Relay {
            base_url: base_url.to_string(),
            key: key.to_string(),
            info: info.clone(),
            alive,
            stop,
        };
        if let Some(old) = self.lock().insert(slot, relay) {
            old.stop();
        }
        Ok(info)
    }

    /// Stop one relay and its connections.
    pub fn close(&self, scope: &str, preview_id: &str) -> bool {
        let removed = self
            .lock()
            .remove(&(scope.to_string(), preview_id.to_string()));
        removed.map(|r| r.stop()).is_some()
    }

    /// Stop every relay of `scope` (a server change, a closed window).
    pub fn close_scope(&self, scope: &str) {
        self.lock().retain(|(s, _), r| {
            let keep = s != scope;
            if !keep {
                r.stop();
            }
            keep
        });
    }

    /// Stop every relay.
    pub fn close_all(&self) {
        for (_, r) in self.lock().drain() {
            r.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

    const ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .http1_only()
            .no_proxy()
            .build()
            .unwrap()
    }

    /// Each tunnel request's URI and `Authorization` header.
    type Requests = Vec<(String, Option<String>)>;

    #[derive(Clone, Default)]
    struct Seen(Arc<Mutex<Requests>>);

    /// A fake tunnel route: checks the Bearer key, records the request,
    /// then answers every binary message with `echo:<message>`.
    // tungstenite's callback signature returns its large `ErrorResponse`.
    #[allow(clippy::result_large_err)]
    async fn fake_server(refuse: Option<u16>) -> (u16, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Seen::default();
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let callback =
                        move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                            let auth = req
                                .headers()
                                .get("authorization")
                                .and_then(|v| v.to_str().ok())
                                .map(String::from);
                            log.0.lock().unwrap().push((req.uri().to_string(), auth));
                            match refuse {
                                Some(code) => {
                                    let mut r = ErrorResponse::new(None);
                                    *r.status_mut() = reqwest::StatusCode::from_u16(code).unwrap();
                                    Err(r)
                                }
                                None => Ok(resp),
                            }
                        };
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, callback).await
                    else {
                        return;
                    };
                    while let Some(Ok(m)) = ws.next().await {
                        if let Message::Binary(b) = m {
                            let mut out = b"echo:".to_vec();
                            out.extend_from_slice(&b);
                            if ws.send(Message::binary(out)).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        });
        (port, seen)
    }

    async fn roundtrip(port: u16, msg: &[u8]) -> std::io::Result<Vec<u8>> {
        let mut tcp = TcpStream::connect(("127.0.0.1", port)).await?;
        tcp.write_all(msg).await?;
        let mut buf = vec![0u8; 256];
        let n = tokio::time::timeout(Duration::from_secs(5), tcp.read(&mut buf))
            .await
            .map_err(|_| std::io::ErrorKind::TimedOut)??;
        Ok(buf[..n].to_vec())
    }

    #[test]
    fn builds_tunnel_urls_and_checks_ids() {
        assert_eq!(
            tunnel_url("http://192.168.1.5:4082", ID, 50000).unwrap(),
            format!("http://192.168.1.5:4082/api/preview/{ID}/tunnel?port=50000")
        );
        assert_eq!(
            tunnel_url("https://box.example/oad/", ID, 50000).unwrap(),
            format!("https://box.example/oad/api/preview/{ID}/tunnel?port=50000")
        );
        assert!(tunnel_url("ftp://x", ID, 1).is_err());
        assert!(is_preview_id(ID));
        assert!(!is_preview_id("../../api/agents"));
        assert!(!is_preview_id(&ID.replace('-', "x")));
    }

    #[test]
    fn only_connection_errors_skip_straight_to_the_next_accept() {
        use std::io::{Error, ErrorKind};
        for kind in [
            ErrorKind::ConnectionAborted,
            ErrorKind::ConnectionReset,
            ErrorKind::ConnectionRefused,
        ] {
            assert!(connection_error(&Error::from(kind)), "{kind:?}");
        }
        // Out of descriptors, a reclaimed socket: retried, then fatal.
        assert!(!connection_error(&Error::from_raw_os_error(24)));
        assert!(!connection_error(&Error::from(ErrorKind::InvalidInput)));
    }

    #[tokio::test]
    async fn relays_bytes_with_the_key_and_reuses_the_relay() {
        let (server, seen) = fake_server(None).await;
        let reg = RelayRegistry::default();
        let base = format!("http://127.0.0.1:{server}/prefix");
        let info = reg
            .open("w", &client(), &base, " secret ", ID, 0)
            .await
            .unwrap();
        assert_eq!(info.origin, format!("http://127.0.0.1:{}", info.port));
        assert_eq!(
            roundtrip(info.port, b"GET / HTTP/1.1\r\n\r\n")
                .await
                .unwrap(),
            b"echo:GET / HTTP/1.1\r\n\r\n"
        );
        let seen = seen.0.lock().unwrap().clone();
        // The probe, then the browser connection.
        assert_eq!(seen.len(), 2);
        for (uri, auth) in seen {
            assert_eq!(
                uri,
                format!("/prefix/api/preview/{ID}/tunnel?port={}", info.port)
            );
            assert_eq!(auth.as_deref(), Some("Bearer secret"));
        }
        assert_eq!(
            reg.open("w", &client(), &base, "secret", ID, 0)
                .await
                .unwrap(),
            info,
            "same server and key reuse the relay"
        );
        let other = reg
            .open("w", &client(), &base, "rotated", ID, 0)
            .await
            .unwrap();
        assert_ne!(other.port, info.port, "a new key starts a new relay");
        reg.close_all();
    }

    #[tokio::test]
    async fn prefers_the_given_port_and_falls_back_when_busy() {
        let (server, _) = fake_server(None).await;
        let busy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let busy_port = busy.local_addr().unwrap().port();
        let reg = RelayRegistry::default();
        let base = format!("http://127.0.0.1:{server}");
        let fallback = reg
            .open("w", &client(), &base, "k", ID, busy_port)
            .await
            .unwrap();
        assert_ne!(fallback.port, busy_port);
        drop(busy);
        reg.close("w", ID);
        let preferred = reg
            .open("w", &client(), &base, "k", ID, busy_port)
            .await
            .unwrap();
        assert_eq!(preferred.port, busy_port);
        reg.close_all();
    }

    /// StrictMode runs the tab's load effect twice, and Retry can overlap a
    /// load: both opens must agree on one live relay on the preferred port.
    #[tokio::test]
    async fn concurrent_opens_share_one_relay() {
        let (server, _) = fake_server(None).await;
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let preferred = free.local_addr().unwrap().port();
        drop(free);
        let reg = RelayRegistry::default();
        let base = format!("http://127.0.0.1:{server}");
        let c = client();
        let (a, b) = tokio::join!(
            reg.open("w", &c, &base, "k", ID, preferred),
            reg.open("w", &c, &base, "k", ID, preferred),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a, b, "both callers frame the same relay");
        assert_eq!(a.port, preferred);
        assert_eq!(roundtrip(a.port, b"z").await.unwrap(), b"echo:z");
        assert!(
            reg.opening.lock().unwrap().is_empty(),
            "gates are forgotten"
        );
        reg.close_all();
    }

    /// A browser that sends a whole request body before reading, to a
    /// server that streams its answer while still reading: the relay must
    /// move both directions at once, or each side waits on the other.
    #[tokio::test]
    async fn moves_both_directions_at_once() {
        const SIZE: usize = 16 * 1024 * 1024;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    let (mut tx, mut rx) = ws.split();
                    let send = async move {
                        let chunk = vec![7u8; READ_CHUNK];
                        for _ in 0..SIZE / READ_CHUNK {
                            if tx.send(Message::binary(chunk.clone())).await.is_err() {
                                return;
                            }
                        }
                    };
                    let drain = async move { while let Some(Ok(_)) = rx.next().await {} };
                    tokio::join!(send, drain);
                });
            }
        });
        let reg = RelayRegistry::default();
        let info = reg
            .open(
                "w",
                &client(),
                &format!("http://127.0.0.1:{server}"),
                "k",
                ID,
                0,
            )
            .await
            .unwrap();
        let mut tcp = TcpStream::connect(("127.0.0.1", info.port)).await.unwrap();
        let exchange = async {
            tcp.write_all(&vec![1u8; SIZE]).await?;
            let mut got = vec![0u8; SIZE];
            tcp.read_exact(&mut got).await?;
            std::io::Result::Ok(())
        };
        tokio::time::timeout(Duration::from_secs(20), exchange)
            .await
            .expect("the relay stalled with both directions full")
            .unwrap();
        reg.close_all();
    }

    #[tokio::test]
    async fn reports_refusals_and_bad_input() {
        for (code, needle) in [(403, "access key"), (404, "too old")] {
            let (server, _) = fake_server(Some(code)).await;
            let err = RelayRegistry::default()
                .open(
                    "w",
                    &client(),
                    &format!("http://127.0.0.1:{server}"),
                    "k",
                    ID,
                    0,
                )
                .await
                .unwrap_err();
            assert!(
                err.contains(&code.to_string()) && err.contains(needle),
                "{err}"
            );
        }
        let reg = RelayRegistry::default();
        assert!(reg
            .open("w", &client(), "http://127.0.0.1:1", "k", "nope", 0)
            .await
            .unwrap_err()
            .contains("preview id"));
        assert!(reg
            .open("w", &client(), "http://127.0.0.1:1", "  ", ID, 0)
            .await
            .unwrap_err()
            .contains("access key"));
    }

    #[tokio::test]
    async fn rejects_a_bad_handshake() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = tcp.read(&mut buf).await;
            let _ = tcp.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bogus\r\n\r\n").await;
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let err = RelayRegistry::default()
            .open(
                "w",
                &client(),
                &format!("http://127.0.0.1:{port}"),
                "k",
                ID,
                0,
            )
            .await
            .unwrap_err();
        assert!(err.contains("invalid WebSocket handshake"), "{err}");
    }

    #[tokio::test]
    async fn close_drops_connections_and_idle_relays_close() {
        let (server, _) = fake_server(None).await;
        let base = format!("http://127.0.0.1:{server}");
        let reg = RelayRegistry::default();
        let info = reg.open("w", &client(), &base, "k", ID, 0).await.unwrap();
        let mut tcp = TcpStream::connect(("127.0.0.1", info.port)).await.unwrap();
        tcp.write_all(b"x").await.unwrap();
        let mut buf = [0u8; 16];
        let n = tcp.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"echo:x");
        reg.close_scope("w");
        let n = tokio::time::timeout(Duration::from_secs(5), tcp.read(&mut buf))
            .await
            .expect("closed")
            .unwrap_or(0);
        assert_eq!(n, 0, "the open connection ends");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            TcpStream::connect(("127.0.0.1", info.port)).await.is_err(),
            "the port is free"
        );

        let quick = RelayRegistry::with_idle_close(Duration::from_millis(100));
        let info = quick.open("w", &client(), &base, "k", ID, 0).await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            TcpStream::connect(("127.0.0.1", info.port)).await.is_err(),
            "an idle relay closes"
        );
        let again = quick.open("w", &client(), &base, "k", ID, 0).await.unwrap();
        assert_eq!(
            roundtrip(again.port, b"y").await.unwrap(),
            b"echo:y",
            "reopening rebinds a closed relay"
        );
    }
}
