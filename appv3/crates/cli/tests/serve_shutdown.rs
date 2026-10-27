//! `agentd server serve` lifecycle against the real binary, the way the
//! desktop app drives it (handshake on stdout, SIGTERM on quit).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn spawn_server(root: &std::path::Path, desktop_token: Option<&str>) -> (Child, BufReader<std::process::ChildStdout>, u16) {
    spawn_server_with(root, desktop_token, &[])
}

fn spawn_server_with(root: &std::path::Path, desktop_token: Option<&str>, extra_env: &[(&str, &str)]) -> (Child, BufReader<std::process::ChildStdout>, u16) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentd"));
    cmd.args(["server", "serve", "--host", "127.0.0.1", "--port", "0", "--handshake"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ("HOME", "home"),
    ] {
        cmd.env(k, root.join(d));
    }
    cmd.env("OPENAGENTD_ENV", "production").env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false").env("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false");
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAGENTD_HANDSHAKE_FILE"] {
        cmd.env_remove(k);
    }
    if let Some(t) = desktop_token {
        cmd.env("OPENAGENTD_DESKTOP_TOKEN", t);
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn openagentd");
    let mut line = String::new();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    stdout.read_line(&mut line).unwrap();
    let json = line.strip_prefix("OPENAGENTD_HANDSHAKE ").unwrap_or_else(|| panic!("no handshake: {line:?}"));
    let port = serde_json::from_str::<serde_json::Value>(json).unwrap()["port"].as_u64().unwrap() as u16;
    (child, stdout, port)
}

/// One `Connection: close` GET; returns (status, body).
fn http_get(port: u16, path: &str, token: Option<&str>) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Connection: close\r\n\r\n").as_bytes()).unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    let status = raw.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    (status, body)
}

fn terminate(child: &mut Child) {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGTERM).unwrap();
    let _ = child.wait();
}

/// Open `/api/events/stream` and wait for the response head, like the web UI.
fn open_event_stream(port: u16) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(b"GET /api/events/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n").unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        s.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    assert!(head.starts_with(b"HTTP/1.1 200"), "{}", String::from_utf8_lossy(&head));
    s
}

#[test]
fn sigterm_with_an_open_event_stream_exits_promptly_after_shutdown_hooks() {
    let root = tempfile::tempdir().unwrap();
    let (mut child, _stdout, port) = spawn_server(root.path(), None);
    let _stream = open_event_stream(port);

    let started = Instant::now();
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGTERM).unwrap();
    let status = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break st;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "server never exited");
        std::thread::sleep(Duration::from_millis(20));
    };
    let elapsed = started.elapsed();
    let mut stderr = String::new();
    child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();

    assert!(status.success(), "{status:?}\n{stderr}");
    // The desktop force-kills after 750 ms on backend restart and 5 s on
    // quit, so an open SSE stream must not hold the drain open.
    assert!(elapsed < Duration::from_millis(1500), "shutdown took {elapsed:?}\n{stderr}");
    assert!(stderr.contains("server_shutdown"), "shutdown hooks did not run:\n{stderr}");
}

#[test]
fn the_desktop_token_still_guards_the_api_after_leaving_the_environment() {
    let root = tempfile::tempdir().unwrap();
    let (mut child, _stdout, port) = spawn_server(root.path(), Some("desk-tok"));
    assert_eq!(http_get(port, "/api/agents", None).0, 401);
    assert_eq!(http_get(port, "/api/agents", Some("desk-tok")).0, 200);
    let (st, body) = http_get(port, "/api/diagnostics", Some("desk-tok"));
    assert_eq!(st, 200, "{body}");
    assert!(body.contains(r#""desktop_session":true"#), "{body}");
    terminate(&mut child);
}

/// One `Connection: close` request with an optional bearer token and JSON body.
fn http(port: u16, method: &str, path: &str, token: Option<&str>, body: Option<&str>) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let body = body.unwrap_or("");
    s.write_all(
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
            .as_bytes(),
    )
    .unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    let status = raw.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    (status, body)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

const LAN_KEY: &str = "lan-key-0123456789abcdef";

fn enable_body(port: u16, key: &str) -> String {
    format!(r#"{{"enabled":true,"port":{port},"access_key":"{key}"}}"#)
}

#[test]
fn the_network_access_route_exists_only_on_desktop_sessions() {
    let root = tempfile::tempdir().unwrap();
    let (mut child, _stdout, port) = spawn_server(root.path(), None);
    assert_eq!(http(port, "GET", "/api/desktop/network-access", None, None).0, 404);
    terminate(&mut child);
}

#[test]
fn the_desktop_opens_a_key_protected_lan_listener_and_closes_it() {
    let root = tempfile::tempdir().unwrap();
    let (mut child, _stdout, port) = spawn_server(root.path(), Some("desk-tok"));
    let lan = free_port();

    let (st, body) = http(port, "PUT", "/api/desktop/network-access", Some("desk-tok"), Some(&enable_body(lan, LAN_KEY)));
    assert_eq!(st, 200, "{body}");
    assert!(body.contains(&format!(r#""port":{lan}"#)) && body.contains(r#""listening":true"#), "{body}");

    // The LAN listener: health is open, the API needs the key (or the desktop token).
    assert_eq!(http(lan, "GET", "/api/health/live", None, None).0, 200);
    assert_eq!(http(lan, "GET", "/api/agents", None, None).0, 401);
    assert_eq!(http(lan, "GET", "/api/agents", Some(LAN_KEY), None).0, 200);
    assert_eq!(http(lan, "GET", "/api/agents", Some("desk-tok"), None).0, 200);

    // Only the desktop, on the private listener, with the desktop token may drive it.
    assert_eq!(http(port, "GET", "/api/desktop/network-access", Some(LAN_KEY), None).0, 404);
    assert_eq!(http(lan, "GET", "/api/desktop/network-access", Some(LAN_KEY), None).0, 404);
    assert_eq!(http(lan, "GET", "/api/desktop/network-access", Some("desk-tok"), None).0, 404);
    assert_eq!(http(port, "GET", "/api/desktop/network-access", Some("desk-tok"), None).0, 200);
    assert_eq!(http(port, "PUT", "/api/desktop/network-access", Some("desk-tok"), Some(&enable_body(lan, "short"))).0, 422);

    // A new key revokes the old one.
    let new_key = "another-lan-key-0123456789";
    assert_eq!(http(port, "PUT", "/api/desktop/network-access", Some("desk-tok"), Some(&enable_body(lan, new_key))).0, 200);
    assert_eq!(http(lan, "GET", "/api/agents", Some(LAN_KEY), None).0, 401);
    assert_eq!(http(lan, "GET", "/api/agents", Some(new_key), None).0, 200);

    // An open event stream on the LAN listener ends when access is turned off.
    let mut stream = TcpStream::connect(("127.0.0.1", lan)).unwrap();
    stream.write_all(format!("GET /api/events/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {new_key}\r\nAccept: text/event-stream\r\n\r\n").as_bytes()).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).unwrap();
    assert_eq!(&head, b"HTTP/1.1 200");

    let (st, body) = http(port, "PUT", "/api/desktop/network-access", Some("desk-tok"), Some(&format!(r#"{{"enabled":false,"port":{lan}}}"#)));
    assert_eq!(st, 200, "{body}");
    assert!(body.contains(r#""listening":false"#), "{body}");
    let mut rest = Vec::new();
    let started = Instant::now();
    let _ = stream.read_to_end(&mut rest);
    assert!(started.elapsed() < Duration::from_secs(5), "the stream was not cut off");
    assert!(TcpStream::connect(("127.0.0.1", lan)).is_err(), "the LAN port is closed");
    // The desktop's own listener is untouched.
    assert_eq!(http(port, "GET", "/api/agents", Some("desk-tok"), None).0, 200);
    terminate(&mut child);
}

/// An OpenAI-compatible chat endpoint that never answers its first request
/// (a turn still running when the server stops) and answers the rest with
/// `reply`. Returns its port and how many chat requests it has had.
fn fake_provider(reply: &'static str) -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let count = std::sync::Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    std::thread::spawn(move || {
        let mut held = vec![];
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let (mut request_line, mut line, mut len) = (String::new(), String::new(), 0usize);
            let _ = reader.read_line(&mut request_line);
            while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                line.clear();
            }
            let mut body = vec![0; len];
            let _ = reader.read_exact(&mut body);
            if !request_line.contains("/chat/completions") {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                held.push(stream);
                continue;
            }
            let chunk = |delta: &str, finish: &str| {
                format!(r#"data: {{"id":"c","object":"chat.completion.chunk","created":0,"model":"mock-1","choices":[{{"index":0,"delta":{delta},"finish_reason":{finish}}}]}}"#)
                    + "\n\n"
            };
            let sse = chunk(&format!(r#"{{"role":"assistant","content":"{reply}"}}"#), "null") + &chunk("{}", r#""stop""#) + "data: [DONE]\n\n";
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", sse.len());
            let _ = stream.write_all((head + &sse).as_bytes());
        }
    });
    (port, count)
}

/// `POST /api/agent/chat` as the web sends it (multipart form).
fn send_chat(port: u16, message: &str, workspace: &str) -> (u16, String) {
    let boundary = "oadboundary";
    let mut body = String::new();
    for (k, v) in [("message", message), ("workspace", workspace)] {
        body += &format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n");
    }
    body += &format!("--{boundary}--\r\n");
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(
        format!(
            "POST /api/agent/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
    .unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    let status = raw.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    (status, raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
}

fn wait_until(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < limit, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `agentd server restart` and the desktop's Stop then Connect both stop
/// the server with SIGTERM and start it again on the same data.
#[test]
fn a_turn_running_when_the_server_restarts_continues_after_it() {
    turn_continues_after(nix::sys::signal::Signal::SIGTERM);
}

/// The desktop kills a server that outlives its shutdown grace, and a crash
/// gives no warning at all: the turn still continues.
#[test]
fn a_turn_cut_off_by_a_killed_server_continues_after_it() {
    turn_continues_after(nix::sys::signal::Signal::SIGKILL);
}

fn turn_continues_after(signal: nix::sys::signal::Signal) {
    use std::sync::atomic::Ordering;
    let root = tempfile::tempdir().unwrap();
    let (fake, chats) = fake_provider("Back at it.");
    let base = format!("http://127.0.0.1:{fake}/v1");
    let env = [("OLLAMA_BASE_URL", base.as_str())];
    let (mut child, _stdout, port) = spawn_server_with(root.path(), None, &env);
    assert_eq!(http(port, "POST", "/api/settings/default-model", None, Some(r#"{"provider_model":"ollama:mock-1"}"#)).0, 200);
    let titles = r#"{"enabled":false,"model":"ollama:mock-1","wait_timeout_seconds":0}"#;
    assert_eq!(http(port, "PUT", "/api/settings/title-generation", None, Some(titles)).0, 200);
    let ws = root.path().join("proj");
    std::fs::create_dir_all(&ws).unwrap();
    let (st, body) = send_chat(port, "do the long thing", &ws.display().to_string());
    assert_eq!(st, 202, "{body}");
    let sid = serde_json::from_str::<serde_json::Value>(body.trim()).ok().and_then(|v| v["session_id"].as_str().map(String::from)).unwrap_or_else(|| {
        // A chunked body: the JSON sits between the size lines.
        let start = body.find('{').unwrap();
        let end = body.rfind('}').unwrap();
        serde_json::from_str::<serde_json::Value>(&body[start..=end]).unwrap()["session_id"].as_str().unwrap().to_string()
    });
    wait_until("the model request", Duration::from_secs(10), || chats.load(Ordering::SeqCst) == 1);

    nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), signal).unwrap();
    wait_until("the server to exit", Duration::from_secs(30), || child.try_wait().unwrap().is_some());

    let (mut child, _stdout, port) = spawn_server_with(root.path(), None, &env);
    let history = format!("/api/agent/{sid}/history");
    wait_until("the continued turn's reply", Duration::from_secs(20), || http(port, "GET", &history, None, None).1.contains("Back at it."));
    let (_, body) = http(port, "GET", &history, None, None);
    assert!(body.contains("The server restarted while you were working"), "{body}");
    assert!(body.contains("restart_resume"), "{body}");
    assert_eq!(chats.load(Ordering::SeqCst), 2, "the continued turn asked the model once more");
    terminate(&mut child);
}
