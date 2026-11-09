//! `/api/server/update` against the real binary: who may update itself, and
//! the whole one-click flow — a background server, a fake release feed, the
//! POST, and the server coming back after the binary was swapped.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const DIRS: [(&str, &str); 6] = [
    ("OPENAGENTD_DATA_DIR", "data"),
    ("OPENAGENTD_CONFIG_DIR", "config"),
    ("OPENAGENTD_STATE_DIR", "state"),
    ("OPENAGENTD_CACHE_DIR", "cache"),
    ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ("HOME", "home"),
];

fn command(bin: &Path, root: &Path, releases: &str) -> Command {
    let mut cmd = Command::new(bin);
    cmd.current_dir(root).stdin(Stdio::null());
    for (k, d) in DIRS {
        cmd.env(k, root.join(d));
    }
    cmd.env("OPENAGENTD_ENV", "production")
        .env("NO_COLOR", "1")
        .env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false")
        .env("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false")
        .env("OPENAGENTD_RELEASES_URL", releases);
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAGENTD_HANDSHAKE_FILE", "OPENAGENTD_UPGRADE_STAGE"] {
        cmd.env_remove(k);
    }
    cmd
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// One `Connection: close` request → (status, body); `None` while nothing answers.
fn http(port: u16, method: &str, path: &str, token: Option<&str>) -> Option<(u16, serde_json::Value)> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(30))).ok()?;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    s.write_all(format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).ok()?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).ok()?;
    let status = raw.split(' ').nth(1).and_then(|c| c.parse().ok())?;
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    Some((status, serde_json::from_str(&body).unwrap_or(serde_json::Value::Null)))
}

fn wait_for<T>(what: &str, timeout: Duration, mut f: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(start.elapsed() < timeout, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

#[test]
fn a_foreground_or_desktop_server_says_why_it_cannot_update_itself() {
    let root = tempfile::tempdir().unwrap();
    for (token, reason) in [(None, "foreground"), (Some("t0k3n-for-the-desktop-app"), "desktop_sidecar")] {
        let port = free_port();
        let mut cmd = command(Path::new(env!("CARGO_BIN_EXE_agentd")), root.path(), "http://127.0.0.1:9");
        cmd.args(["server", "serve", "--host", "127.0.0.1", "--port", &port.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
        if let Some(t) = token {
            cmd.env("OPENAGENTD_DESKTOP_TOKEN", t);
        }
        let mut child = cmd.spawn().unwrap();
        let (status, body) = wait_for("the server", Duration::from_secs(60), || http(port, "GET", "/api/server/update", token));
        assert_eq!(status, 200, "{body}");
        assert_eq!((body["can_upgrade"].as_bool(), body["reason"].as_str()), (Some(false), Some(reason)), "{body}");
        assert_eq!(body["latest"], serde_json::Value::Null, "the feed is unreachable: {body}");
        assert!(body["check_error"].is_string(), "{body}");
        let (status, body) = http(port, "POST", "/api/server/update", token).unwrap();
        assert_eq!(status, 422, "{body}");
        assert_eq!(body["detail"]["reason"], reason);
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGTERM).unwrap();
        let _ = child.wait();
    }
}

/// A `.tar.gz` holding `bin` as `agentd`, the shape of a release archive.
fn release_archive(bin: &Path) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none()));
    let data = std::fs::read(bin).unwrap();
    let mut h = tar::Header::new_gnu();
    h.set_size(data.len() as u64);
    h.set_mode(0o755);
    h.set_cksum();
    builder.append_data(&mut h, "agentd", data.as_slice()).unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

/// GitHub's shape: `/latest` → `/tag/v<latest>`, files under `/download/v<latest>/`.
fn fake_releases(latest: &'static str, archive: Vec<u8>) -> String {
    use axum::{extract::Path as P, response::Redirect, routing::get, Router};
    use sha2::Digest;
    let target = if cfg!(target_os = "macos") { "aarch64-apple-darwin" } else { "x86_64-unknown-linux-gnu" };
    let name = format!("openagentd-{latest}-{target}.tar.gz");
    let sha = format!("{}  {name}\n", sha2::Sha256::digest(&archive).iter().map(|b| format!("{b:02x}")).collect::<String>());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let app = Router::new()
                .route("/latest", get(move || async move { Redirect::temporary(&format!("/tag/v{latest}")) }))
                .route("/tag/{tag}", get(|| async { "release page" }))
                .route(
                    "/download/{tag}/{file}",
                    get(move |P((_tag, file)): P<(String, String)>| {
                        let (archive, sha, name) = (archive.clone(), sha.clone(), name.clone());
                        async move {
                            if file == name {
                                Ok(archive)
                            } else if file == format!("{name}.sha256") {
                                Ok(sha.into_bytes())
                            } else {
                                Err(axum::http::StatusCode::NOT_FOUND)
                            }
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    format!("http://{}", rx.recv().unwrap())
}

fn pid(root: &Path) -> Option<String> {
    std::fs::read_to_string(root.join("state/openagentd.pid")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn status_file(root: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(root.join("state/upgrade-status.json")).ok()?).ok()
}

#[test]
fn one_click_update_swaps_the_binary_and_restarts_the_background_server() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    // A copy to swap, so the test never touches the build's binary.
    let bin_dir = root.join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let bin: PathBuf = bin_dir.join("agentd");
    std::fs::copy(env!("CARGO_BIN_EXE_agentd"), &bin).unwrap();
    let releases = fake_releases("99.0.0", release_archive(Path::new(env!("CARGO_BIN_EXE_agentd"))));
    let port = free_port();

    let o = command(&bin, root, &releases).args(["server", "start", "--port", &port.to_string(), "--wait"]).output().unwrap();
    assert!(o.status.success(), "{}", text(&o));
    let first_pid = pid(root).expect("a pid file");
    let inode_before = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&bin).unwrap());

    let (status, body) = http(port, "GET", "/api/server/update", None).unwrap();
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["can_upgrade"].as_bool(), body["available"].as_bool(), body["latest"].as_str(), body["method"].as_str()),
        (Some(true), Some(true), Some("99.0.0"), Some("release")),
        "{body}"
    );

    let (status, body) = http(port, "POST", "/api/server/update", None).unwrap();
    assert_eq!(status, 202, "{body}");
    assert_eq!((body["target"].as_str(), body["from"].as_str()), (Some("99.0.0"), Some(env!("CARGO_PKG_VERSION"))));
    let started_at = body["started_at"].as_str().unwrap().to_string();
    // A second click while it runs is refused.
    let again = http(port, "POST", "/api/server/update", None);
    assert!(again.as_ref().is_none_or(|(s, _)| *s == 409), "{again:?}");

    let done = wait_for("the update to finish", Duration::from_secs(150), || status_file(root).filter(|s| s["state"] == "finished"));
    let log = std::fs::read_to_string(root.join("state/logs/upgrade.log")).unwrap_or_default();
    assert_eq!(done["ok"], true, "{done}\n{log}");
    assert_eq!((done["to"].as_str(), done["started_at"].as_str()), (Some("99.0.0"), Some(started_at.as_str())), "{done}");
    assert!(log.contains("Updated") && log.contains("Server running again"), "{log}");

    // The same path now holds the new file, and a new server answers on it.
    let inode_after = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&bin).unwrap());
    assert_ne!(inode_before, inode_after, "the binary was replaced");
    let second_pid = pid(root).expect("the restarted server's pid");
    assert_ne!(first_pid, second_pid);
    let (status, body) = wait_for("the restarted server", Duration::from_secs(30), || http(port, "GET", "/api/server/update", None));
    assert_eq!(status, 200, "{body}");
    assert_eq!((body["in_progress"].as_bool(), body["last"]["ok"].as_bool()), (Some(false), Some(true)), "{body}");

    let o = command(&bin, root, &releases).args(["server", "stop"]).output().unwrap();
    assert!(o.status.success(), "{}", text(&o));
}
