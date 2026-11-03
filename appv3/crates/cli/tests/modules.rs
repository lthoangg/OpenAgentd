//! `GET /api/modules` and the Modules section of `agentd doctor`, against the
//! real binary in throw-away `HOME`/XDG roots (the harness of
//! `serve_shutdown.rs`). Nothing here touches real user data.
#![cfg(unix)]

use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// The server's built-in modules, in start order.
const BUILTIN: [&str; 16] = [
    "workspace",
    "otel",
    "lsp",
    "mcp",
    "subagents",
    "sessions",
    "stream_store",
    "snapshots",
    "agents",
    "scheduler",
    "preview",
    "terminal",
    "model_registry",
    "shell_snapshot",
    "config_watch",
    "restart_resume",
];

/// The access key of the keyed server below.
const ACCESS_KEY: &str = "modules-test-key-0123456789";

/// Point `cmd` at throw-away `HOME`/XDG roots under `root`, and drop every
/// variable that could aim it at real data or hand it a real secret.
fn sandbox(cmd: &mut Command, root: &Path) {
    std::fs::create_dir_all(root.join("home")).unwrap();
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
    cmd.env("OPENAGENTD_ENV", "production").env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false").env("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false").env("NO_COLOR", "1");
    for k in [
        "OPENAGENTD_DESKTOP_TOKEN",
        "OPENAGENTD_ACCESS_KEY",
        "OPENAGENTD_HANDSHAKE_FILE",
        "DATABASE_URL",
        "OPENAGENTD_DATABASE_URL",
        "AGENTS_DIR",
        "OPENAGENTD_AGENTS_DIR",
        "SKILLS_DIR",
        "OPENAGENTD_SKILLS_DIR",
        "OPENAGENTD_PLUGINS_DIRS",
        "CHAT_WORKSPACE_DIR",
        "OPENAGENTD_CHAT_WORKSPACE_DIR",
        "APP_ENV",
        "RUST_LOG",
        "LOG_LEVEL",
        "OPENAGENTD_LOG_LEVEL",
        "OPENAI_API_KEY",
    ] {
        cmd.env_remove(k);
    }
}

/// A running `agentd server serve` in a sandbox. Stopped when dropped
/// (SIGTERM, then SIGKILL), so a failed assertion leaves no server behind.
struct Server {
    child: Child,
    port: u16,
    log: PathBuf,
    /// Kept open, so the server never writes to a closed pipe.
    _stdout: Option<BufReader<ChildStdout>>,
}

impl Server {
    /// Starts the server on a free port and waits for its handshake line.
    /// Its stderr goes to a file in `root`, shown when something fails.
    fn spawn(root: &Path, extra_env: &[(&str, &str)]) -> Server {
        let log = root.join("server.stderr");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentd"));
        cmd.args(["server", "serve", "--host", "127.0.0.1", "--port", "0", "--handshake"])
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&log).unwrap());
        sandbox(&mut cmd, root);
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let child = cmd.spawn().expect("spawn agentd");
        let mut server = Server { child, port: 0, log, _stdout: None };

        // A server stuck before its handshake must fail the test, not hang it.
        let stdout = server.child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let _ = tx.send((line, reader));
        });
        let Ok((line, reader)) = rx.recv_timeout(Duration::from_secs(90)) else { panic!("no handshake within 90 s\n{}", server.stderr()) };
        server._stdout = Some(reader);
        let json = line.strip_prefix("OPENAGENTD_HANDSHAKE ").unwrap_or_else(|| panic!("no handshake: {line:?}\n{}", server.stderr()));
        server.port = serde_json::from_str::<Value>(json).unwrap()["port"].as_u64().unwrap() as u16;
        server
    }

    /// What the server has written to stderr so far.
    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        use nix::sys::signal::{kill, Signal};
        let _ = kill(nix::unistd::Pid::from_raw(self.child.id() as i32), Signal::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(20);
        while matches!(self.child.try_wait(), Ok(None)) {
            if Instant::now() > deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// One `Connection: close` GET with an optional bearer key; returns (status, body).
fn http_get(port: u16, path: &str, key: Option<&str>) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let auth = key.map(|k| format!("Authorization: Bearer {k}\r\n")).unwrap_or_default();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Connection: close\r\n\r\n").as_bytes()).unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    let status = raw.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    (status, body)
}

/// The JSON object in a response body (a chunked body has size lines around it).
fn json_body(body: &str) -> Value {
    let (Some(start), Some(end)) = (body.find('{'), body.rfind('}')) else { panic!("no JSON in {body:?}") };
    serde_json::from_str(&body[start..=end]).unwrap_or_else(|e| panic!("bad JSON ({e}): {body}"))
}

/// The sandbox's `server.yaml`: the address `agentd doctor` probes, and the
/// access key it sends if given.
fn write_server_yaml(root: &Path, port: u16, access_key: Option<&str>) {
    let key = access_key.map(|k| format!("access_key: {k}\n")).unwrap_or_default();
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config/server.yaml"), format!("host: 127.0.0.1\nport: {port}\n{key}")).unwrap();
}

/// `agentd doctor` in the sandbox of `root`; its stdout.
fn doctor(root: &Path, extra_env: &[(&str, &str)]) -> String {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentd"));
    cmd.arg("doctor").current_dir(root).stdin(Stdio::null());
    sandbox(&mut cmd, root);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let o = cmd.output().expect("run agentd doctor");
    let (out, err) = (String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr));
    assert!(out.contains("agentd doctor"), "doctor did not run ({}):\n{out}\n{err}", o.status);
    out
}

/// The lines of doctor's Modules section: after its title, up to the blank line.
fn modules_section(out: &str) -> Vec<&str> {
    out.lines().skip_while(|l| l.trim() != "Modules").skip(1).take_while(|l| !l.trim().is_empty()).collect()
}

/// Doctor lists every built-in module as a running ✓ line, then counts them
/// all as running.
fn assert_all_running(out: &str) {
    let section = modules_section(out);
    for id in BUILTIN {
        let line = section.iter().find(|l| l.split_whitespace().nth(1) == Some(id)).unwrap_or_else(|| panic!("no {id} line in the Modules section:\n{out}"));
        assert_eq!(line.split_whitespace().collect::<Vec<_>>(), ["✓", id, "running"], "{out}");
    }
    let summary = section.last().expect("a summary line").trim();
    let total: usize = summary.split(' ').next().and_then(|n| n.parse().ok()).unwrap_or_else(|| panic!("no summary line in:\n{out}"));
    assert!(total >= BUILTIN.len(), "{out}");
    assert_eq!(summary, format!("{total} modules, {total} running"), "{out}");
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// A server from before `/api/modules`: answers every request with 404.
/// Returns its port and the request heads it has seen.
fn old_server() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(vec![]));
    let heads = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut head = vec![];
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                head.push(byte[0]);
            }
            heads.lock().unwrap().push(String::from_utf8_lossy(&head).into_owned());
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
    (port, seen)
}

#[test]
fn the_server_reports_every_builtin_module_as_running() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::spawn(root.path(), &[]);
    let (status, body) = http_get(server.port, "/api/modules", None);
    assert_eq!(status, 200, "{body}\n{}", server.stderr());
    let json = json_body(&body);
    let modules = json["modules"].as_array().unwrap_or_else(|| panic!("no module list: {json}"));
    let ids: Vec<&str> = modules.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids[0], "workspace", "the workspace exists before anything reads it: {ids:?}");
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len(), "an id twice: {ids:?}");
    for id in BUILTIN {
        let m = modules.iter().find(|m| m["id"] == id).unwrap_or_else(|| panic!("module {id} missing: {ids:?}"));
        assert_eq!(m["state"], "running", "{m}\n{}", server.stderr());
        assert!(m["error"].is_null(), "{m}");
    }
}

#[test]
fn doctor_lists_the_modules_of_a_running_server() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::spawn(root.path(), &[]);
    // Doctor finds the server through server.yaml; this one took a free port.
    write_server_yaml(root.path(), server.port, None);
    let out = doctor(root.path(), &[]);
    assert_all_running(&out);
    // The existing checks stay, ahead of the section.
    assert!(out.contains("Database:"), "{out}");
    assert!(out.find("Agents").unwrap() < out.find("Modules").unwrap(), "{out}");
}

#[test]
fn doctor_sends_the_access_key_the_server_needs() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::spawn(root.path(), &[("OPENAGENTD_ACCESS_KEY", ACCESS_KEY)]);
    write_server_yaml(root.path(), server.port, None);
    assert_eq!(http_get(server.port, "/api/modules", None).0, 401);
    assert_eq!(http_get(server.port, "/api/modules", Some(ACCESS_KEY)).0, 200);

    // Without the key doctor says what to set, and lists nothing.
    let out = doctor(root.path(), &[]);
    let section = modules_section(&out);
    assert!(section.len() == 1 && section[0].contains('⚠') && section[0].contains("OPENAGENTD_ACCESS_KEY"), "{out}");
    assert!(!out.contains("scheduler"), "{out}");

    // A wrong key is reported as such.
    let out = doctor(root.path(), &[("OPENAGENTD_ACCESS_KEY", "not-the-key")]);
    assert!(modules_section(&out)[0].contains("did not accept the access key"), "{out}");

    // The key from the environment, then from server.yaml.
    assert_all_running(&doctor(root.path(), &[("OPENAGENTD_ACCESS_KEY", ACCESS_KEY)]));
    write_server_yaml(root.path(), server.port, Some(ACCESS_KEY));
    let out = doctor(root.path(), &[]);
    assert_all_running(&out);
    assert!(!out.contains(ACCESS_KEY), "doctor printed the key:\n{out}");
}

#[test]
fn doctor_without_a_server_says_how_to_see_its_modules() {
    let root = tempfile::tempdir().unwrap();
    write_server_yaml(root.path(), free_port(), None);
    let out = doctor(root.path(), &[]);
    let section: Vec<&str> = modules_section(&out).into_iter().map(str::trim).collect();
    assert_eq!(section, ["Start the server to see its modules."], "{out}");
}

#[test]
fn doctor_says_when_a_server_does_not_report_modules() {
    let root = tempfile::tempdir().unwrap();
    let (port, requests) = old_server();
    write_server_yaml(root.path(), port, None);
    let out = doctor(root.path(), &[]);
    let section: Vec<&str> = modules_section(&out).into_iter().map(str::trim).collect();
    assert_eq!(section, ["This server does not report modules."], "{out}");
    let heads = requests.lock().unwrap();
    assert_eq!(heads.len(), 1, "{heads:?}");
    assert!(heads[0].starts_with("GET /api/modules HTTP/1.1\r\n"), "{heads:?}");
    assert!(!heads[0].to_ascii_lowercase().contains("authorization"), "no key is configured: {heads:?}");
}
