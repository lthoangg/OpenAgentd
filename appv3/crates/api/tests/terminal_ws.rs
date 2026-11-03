//! The terminal WebSocket against a real listener and real shells: protocol
//! v2 (sessions that survive a disconnect, replay on reattach, takeover,
//! flow control, list/kill routes) and the original protocol, which still
//! ties the shell to the socket.
//!
//! Settings and the terminal registry are process-global (and capped at 8
//! sessions), so everything runs in one test, one scenario after another.
#![cfg(unix)]

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use appv3_terminal::{HIGH_WATER, LOW_WATER};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message as M;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Fixture {
    addr: SocketAddr,
    /// The workspace tickets are issued for.
    ws: String,
    other_ws: String,
    http: reqwest::Client,
}

impl Fixture {
    async fn req(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut r = self.http.request(method.parse().unwrap(), format!("http://{}{path}", self.addr));
        if let Some(b) = body {
            r = r.header("content-type", "application/json").body(b.to_string());
        }
        let resp = r.send().await.unwrap();
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn ticket(&self, extra: Value) -> (u16, Value) {
        let mut body = json!({"workspace": self.ws, "rows": 24, "cols": 80});
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        self.req("POST", "/api/terminal/ticket", Some(body)).await
    }

    async fn sessions(&self) -> Vec<Value> {
        let q: String = form_urlencoded::byte_serialize(self.ws.as_bytes()).collect();
        let (st, v) = self.req("GET", &format!("/api/terminal/sessions?workspace={q}"), None).await;
        assert_eq!(st, 200, "{v}");
        v["sessions"].as_array().unwrap().clone()
    }

    async fn wait_for_sessions(&self, what: &str, done: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let started = Instant::now();
        loop {
            let s = self.sessions().await;
            if done(&s) {
                return s;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting for {what}: {s:?}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// A fresh protocol-2 session.
    async fn open_new(&self) -> Conn {
        let (st, t) = self.ticket(json!({})).await;
        assert_eq!(st, 200, "{t}");
        assert_eq!(t["protocol"], json!(2), "{t}");
        assert!(t.get("session_id").is_none(), "a new session has no id until it attaches: {t}");
        Conn::open(self, t["ticket"].as_str().unwrap()).await
    }

    /// Reattach with `since`.
    async fn reattach(&self, sid: &str, since: u64) -> Conn {
        let (st, t) = self.ticket(json!({"session_id": sid, "since": since})).await;
        assert_eq!(st, 200, "{t}");
        assert_eq!((t["protocol"].clone(), t["session_id"].clone()), (json!(2), json!(sid)), "{t}");
        Conn::open(self, t["ticket"].as_str().unwrap()).await
    }
}

/// One WebSocket event.
#[derive(Debug)]
enum Ev {
    Text(Value),
    Bin(u64, Vec<u8>),
    Close(Option<u16>),
    Idle,
}

struct Conn {
    ws: Ws,
    session_id: String,
    /// `seq` of the next output byte expected: frames must be contiguous.
    seq: u64,
    /// Output received so far.
    seen: Vec<u8>,
}

impl Conn {
    async fn connect(f: &Fixture, ticket: &str, v2: bool) -> Ws {
        let proto = if v2 { "&proto=2" } else { "" };
        tokio_tungstenite::connect_async(format!("ws://{}/api/terminal/ws?ticket={ticket}{proto}", f.addr)).await.unwrap().0
    }

    /// Connect (protocol 2) and read the `attached` frame and the initial `busy`.
    async fn open(f: &Fixture, ticket: &str) -> Conn {
        let mut c = Conn { ws: Self::connect(f, ticket, true).await, session_id: String::new(), seq: 0, seen: vec![] };
        let Ev::Text(a) = c.ev(Duration::from_secs(10)).await else { panic!("no attached frame") };
        assert_eq!(a["type"], json!("attached"), "{a}");
        c.session_id = a["session_id"].as_str().unwrap().to_string();
        c.seq = a["seq"].as_u64().unwrap();
        let Ev::Text(b) = c.ev(Duration::from_secs(10)).await else { panic!("no initial busy frame") };
        assert_eq!(b["type"], json!("busy"), "busy support is announced right after attached: {b}");
        c
    }

    async fn ev(&mut self, within: Duration) -> Ev {
        loop {
            match tokio::time::timeout(within, self.ws.next()).await {
                Err(_) => return Ev::Idle,
                Ok(None) | Ok(Some(Err(_))) => return Ev::Close(None),
                Ok(Some(Ok(M::Text(t)))) => return Ev::Text(serde_json::from_str(t.as_str()).unwrap_or(Value::Null)),
                Ok(Some(Ok(M::Binary(b)))) => {
                    assert!(b.len() > 8, "a binary frame is a seq plus at least one byte");
                    assert!(b.len() <= 8 + 64 * 1024, "frames are at most 64 KiB: {}", b.len());
                    let seq = u64::from_be_bytes(b[..8].try_into().unwrap());
                    return Ev::Bin(seq, b[8..].to_vec());
                }
                Ok(Some(Ok(M::Close(f)))) => return Ev::Close(f.map(|f| u16::from(f.code))),
                Ok(Some(Ok(_))) => {}
            }
        }
    }

    async fn send(&mut self, v: Value) {
        self.ws.send(M::text(v.to_string())).await.unwrap();
    }

    async fn input(&mut self, data: &str) {
        self.send(json!({"type": "input", "data": data})).await;
    }

    /// Take one output frame into `seen`, checking it follows the last.
    fn take(&mut self, seq: u64, payload: &[u8]) {
        assert_eq!(seq, self.seq, "output must be contiguous (a gap or a repeat)");
        self.seq += payload.len() as u64;
        self.seen.extend_from_slice(payload);
    }

    /// Read output until `marker` appears.
    async fn until(&mut self, marker: &str) {
        let started = Instant::now();
        while !contains(&self.seen, marker) {
            assert!(started.elapsed() < Duration::from_secs(20), "timed out waiting for {marker:?}; saw {:?}", String::from_utf8_lossy(&self.seen));
            match self.ev(Duration::from_secs(5)).await {
                Ev::Bin(seq, p) => self.take(seq, &p),
                Ev::Text(_) | Ev::Idle => {}
                Ev::Close(c) => panic!("closed ({c:?}) while waiting for {marker:?}; saw {:?}", String::from_utf8_lossy(&self.seen)),
            }
        }
    }

    async fn expect_close(&mut self) -> Option<u16> {
        let started = Instant::now();
        loop {
            assert!(started.elapsed() < Duration::from_secs(10), "no close frame");
            if let Ev::Close(c) = self.ev(Duration::from_secs(5)).await {
                return c;
            }
        }
    }
}

fn contains(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

async fn fixture(root: &std::path::Path) -> Fixture {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("OPENAGENTD_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    std::env::set_var("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false");
    // A plain shell: login rc files can swallow scripted input.
    std::env::set_var("SHELL", "/bin/sh");
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL"] {
        std::env::remove_var(k);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    let app = create_app(AppState { pool }, Policy::from_env());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app.into_make_service_with_connect_info::<ConnInfo>()).await.unwrap() });
    let dir = |name: &str| {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(d).unwrap().display().to_string()
    };
    Fixture { addr, ws: dir("proj"), other_ws: dir("other"), http: reqwest::Client::builder().no_proxy().build().unwrap() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_sessions_survive_the_socket_and_the_old_protocol_does_not() {
    let root = tempfile::tempdir().unwrap();
    let f = fixture(root.path()).await;
    session_survives_a_disconnect_and_replays_what_was_missed(&f).await;
    shell_exit_ends_the_socket_and_the_session(&f).await;
    acks_window_the_output(&f).await;
    the_original_protocol_kills_the_shell_with_the_socket(&f).await;
}

async fn session_survives_a_disconnect_and_replays_what_was_missed(f: &Fixture) {
    // ── a new session: attached at seq 0, output arrives as seq-tagged bytes ──
    let mut c = f.open_new().await;
    assert_eq!(c.seq, 0, "a new session starts at seq 0");
    let sid = c.session_id.clone();
    c.input("echo oad_$((40+2))_a\n").await;
    c.until("oad_42_a").await;
    assert!(c.seq > 0);

    let listed = f.sessions().await;
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!((listed[0]["session_id"].clone(), listed[0]["workspace"].clone(), listed[0]["attached"].clone()), (json!(sid), json!(f.ws), json!(true)));
    chrono::DateTime::parse_from_rfc3339(listed[0]["created_at"].as_str().unwrap()).expect("created_at is RFC 3339");
    assert!(listed[0]["busy"].is_boolean());
    // Other workspaces see nothing; the workspace is required.
    let q: String = form_urlencoded::byte_serialize(f.other_ws.as_bytes()).collect();
    let (st, v) = f.req("GET", &format!("/api/terminal/sessions?workspace={q}"), None).await;
    assert_eq!((st, v["sessions"].clone()), (200, json!([])));
    assert_eq!(f.req("GET", "/api/terminal/sessions", None).await.0, 422);

    // ── disconnect with a command still to print ────────────────────────────
    c.input("sleep 1; echo oad_$((40+2))_b\n").await;
    c.until("sleep 1; echo oad_").await;
    let since = c.seq;
    drop(c);
    let listed = f.wait_for_sessions("the session to detach", |s| s.len() == 1 && s[0]["attached"] == json!(false)).await;
    assert_eq!(listed[0]["session_id"], json!(sid), "the shell outlives its socket");

    // ── reattach: replay from `since`, no gap and no repeat ─────────────────
    let mut c = f.reattach(&sid, since).await;
    assert_eq!((c.session_id.as_str(), c.seq), (sid.as_str(), since), "attached seq is the requested one while the ring still holds it");
    c.until("oad_42_b").await;
    let text = String::from_utf8_lossy(&c.seen).to_string();
    assert!(!text.contains("oad_42_a"), "output before `since` must not be replayed: {text:?}");
    assert_eq!(text.matches("oad_42_b").count(), 1, "{text:?}");

    // ── bad frames are ignored, not fatal ───────────────────────────────────
    for bad in [
        M::text("not json"),
        M::text(r#"{"type":"bogus"}"#),
        M::text(r#"{"type":"input"}"#),
        M::text(r#"{"type":"ack","seq":"x"}"#),
        M::text("[1,2]"),
        M::binary(vec![0xff, 0x00, 0xfe]),
    ] {
        c.ws.send(bad).await.unwrap();
    }
    c.input("echo oad_$((40+2))_c\n").await;
    c.until("oad_42_c").await;

    // ── a second ticket takes the session over: the older socket gets 4409 ──
    let mut c2 = f.reattach(&sid, c.seq).await;
    assert_eq!(c2.seq, c.seq, "continues where the first socket stopped");
    assert_eq!(c.expect_close().await, Some(4409));
    c2.input("echo oad_$((40+2))_d\n").await;
    c2.until("oad_42_d").await;
    assert_eq!(f.sessions().await[0]["attached"], json!(true));

    // ── `since` beyond what exists is clamped to the end ────────────────────
    let mut c3 = f.reattach(&sid, 1_000_000_000_000).await;
    assert_eq!(c2.expect_close().await, Some(4409));
    assert!(c3.seq >= c2.seq, "clamped to the total produced ({} vs {})", c3.seq, c2.seq);
    c3.input("echo oad_$((40+2))_e\n").await;
    c3.until("oad_42_e").await;
    assert!(!String::from_utf8_lossy(&c3.seen).contains("oad_42_d"), "nothing is replayed past the end");

    // ── unknown ids and other workspaces' sessions are 404 ──────────────────
    let (st, v) = f.ticket(json!({"session_id": "nope"})).await;
    assert_eq!((st, v), (404, json!({"detail": "Terminal session not found."})));
    let (st, v) = f.req("POST", "/api/terminal/ticket", Some(json!({"workspace": f.other_ws, "session_id": sid}))).await;
    assert_eq!((st, v), (404, json!({"detail": "Terminal session not found."})));

    // ── explicit kill ───────────────────────────────────────────────────────
    assert_eq!(f.req("DELETE", &format!("/api/terminal/sessions/{sid}"), None).await.0, 204);
    let mut saw_exit = false;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        match c3.ev(Duration::from_secs(5)).await {
            Ev::Text(v) if v["type"] == json!("exit") => saw_exit = true,
            Ev::Close(_) => break,
            _ => {}
        }
    }
    assert!(saw_exit, "an attached socket is told the session ended");
    assert_eq!(f.sessions().await.len(), 0);
    assert_eq!(f.req("DELETE", &format!("/api/terminal/sessions/{sid}"), None).await.0, 404);
    assert_eq!(f.ticket(json!({"session_id": sid})).await.0, 404);
}

async fn shell_exit_ends_the_socket_and_the_session(f: &Fixture) {
    let mut c = f.open_new().await;
    c.input("exit\n").await;
    let mut saw_exit = false;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        match c.ev(Duration::from_secs(5)).await {
            Ev::Bin(seq, p) => c.take(seq, &p),
            Ev::Text(v) if v["type"] == json!("exit") => saw_exit = true,
            Ev::Close(code) => {
                assert!(saw_exit, "exit must come before the close ({code:?})");
                break;
            }
            _ => {}
        }
    }
    assert!(saw_exit);
    f.wait_for_sessions("the exited session to go", |s| s.is_empty()).await;
}

async fn acks_window_the_output(f: &Fixture) {
    let mut c = f.open_new().await;
    c.input("head -c 3000000 /dev/zero | tr '\\0' x; echo oad_$((40+2))_done\n").await;

    // Without acks the server stops once more than HIGH_WATER is in flight
    // (by at most one 64 KiB frame).
    loop {
        match c.ev(Duration::from_millis(800)).await {
            Ev::Bin(seq, p) => c.take(seq, &p),
            Ev::Idle => break,
            Ev::Text(_) => {}
            Ev::Close(code) => panic!("closed early: {code:?}"),
        }
    }
    let stalled_at = c.seq;
    assert!(stalled_at > HIGH_WATER && stalled_at <= HIGH_WATER + 64 * 1024, "stalled after {stalled_at} bytes");

    // Acking down to just above the low water is not enough to resume…
    c.send(json!({"type": "ack", "seq": stalled_at - LOW_WATER - 1})).await;
    assert!(matches!(c.ev(Duration::from_millis(500)).await, Ev::Idle), "resumed above the low water");
    // …at the low water it is.
    c.send(json!({"type": "ack", "seq": stalled_at - LOW_WATER})).await;
    match c.ev(Duration::from_secs(5)).await {
        Ev::Bin(seq, p) => c.take(seq, &p),
        other => panic!("did not resume at the low water: {other:?}"),
    }
    // A client that keeps acking receives everything, in order, once.
    let started = Instant::now();
    let mut tail = Vec::<u8>::new();
    while !contains(&tail, "oad_42_done") {
        assert!(started.elapsed() < Duration::from_secs(60), "timed out; got {} bytes", c.seq);
        match c.ev(Duration::from_secs(5)).await {
            Ev::Bin(seq, p) => {
                c.take(seq, &p);
                tail.extend_from_slice(&p);
                if tail.len() > 256 {
                    tail.drain(..tail.len() - 256);
                }
                let ack = c.seq;
                c.send(json!({"type": "ack", "seq": ack})).await;
            }
            Ev::Text(_) => {}
            other => panic!("unexpected {other:?} after {} bytes", c.seq),
        }
    }
    assert!(c.seq >= 3_000_000, "{}", c.seq);
    assert!(c.seen.iter().filter(|b| **b == b'x').count() >= 3_000_000);
    assert_eq!(f.req("DELETE", &format!("/api/terminal/sessions/{}", c.session_id), None).await.0, 204);
}

async fn the_original_protocol_kills_the_shell_with_the_socket(f: &Fixture) {
    for how in ["the socket closing", "a non-JSON frame"] {
        let (st, t) = f.ticket(json!({})).await;
        assert_eq!(st, 200, "{t}");
        let mut ws = Conn::connect(f, t["ticket"].as_str().unwrap(), false).await;
        ws.send(M::text(json!({"type": "input", "data": "echo oad_$((40+2))_old\n"}).to_string())).await.unwrap();
        // Old frames: JSON `output` text frames, no `attached`.
        let mut out = String::new();
        let started = Instant::now();
        while !out.contains("oad_42_old") {
            assert!(started.elapsed() < Duration::from_secs(20), "timed out: {out:?}");
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
                Ok(Some(Ok(M::Text(t)))) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    assert_ne!(v["type"], json!("attached"), "the original protocol has no attached frame");
                    if v["type"] == json!("output") {
                        out.push_str(v["data"].as_str().unwrap());
                    }
                }
                Ok(Some(Ok(M::Binary(_)))) => panic!("the original protocol has no binary frames"),
                Ok(other) => panic!("unexpected {other:?}"),
                Err(_) => {}
            }
        }
        let live = appv3_terminal::list_sessions();
        assert_eq!(live.len(), 1, "one live session");
        let shell = live[0].clone();
        if how == "a non-JSON frame" {
            ws.send(M::text("garbage")).await.unwrap();
            // Keep the socket open: the garbage alone must end the session.
        } else {
            drop(ws);
        }
        let started = Instant::now();
        while appv3_terminal::get_session(&shell.session_id).is_some() || shell.alive() {
            assert!(started.elapsed() < Duration::from_secs(10), "the shell survived {how}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(f.sessions().await.len(), 0);
    }
}
