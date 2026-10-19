//! `server start|stop|restart|status|logs`. `start` runs this binary's
//! `server serve` as a background daemon.

use crate::cli::{LogsArgs, StartArgs, StatusArgs};
use crate::net::{display_host, http_get, is_port_reachable, require_loopback_or_auth, resolve_addr, server_addresses, server_settings};
use crate::paths::{clear_pids, find_pids, pid_alive, server_log, write_pids};
use crate::ui::{bold, cyan, dim, field, green, print_banner, red, yellow, Checks};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::borrow::Cow;
use std::process::{Child, ExitCode};
use std::time::{Duration, Instant};

/// Env marker telling the spawned `server serve` it runs as the CLI daemon,
/// so it skips the sidecar stdio line and keeps log records out of stderr.
pub const DAEMON_ENV: &str = "OPENAGENTD_CLI_DAEMON_CHILD";

const READY_TIMEOUT: Duration = Duration::from_secs(30);

fn env_set(k: &str) -> bool {
    std::env::var(k).is_ok_and(|v| !v.is_empty())
}

fn code(ok: bool) -> ExitCode {
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Bound to every interface, so LAN clients can connect.
fn all_interfaces(host: &str) -> bool {
    host == "0.0.0.0" || host == "::"
}

fn pid_list(pids: &[i32]) -> String {
    pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")
}

fn prompt_access_key() -> Result<String> {
    let key = crate::ui::read_secret("OpenAgentd LAN access key: ").context("read the access key")?.trim().to_string();
    if key.is_empty() {
        bail!("the access key cannot be empty");
    }
    Ok(key)
}

fn exe() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|_| "agentd".into())
}

pub fn start(args: &StartArgs) -> Result<ExitCode> {
    start_daemon(args).map(code)
}

/// `Ok(false)` when `--wait` saw the server die or time out.
fn start_daemon(args: &StartArgs) -> Result<bool> {
    if !find_pids().is_empty() {
        println!("  {}  (run {} first)", yellow("already running"), bold("agentd server stop"));
        if args.qr {
            println!("  {}  run {}", dim("QR code:"), bold("agentd server status --qr"));
        }
        return Ok(true);
    }
    let mut cfg = server_settings()?;
    let host_arg = if args.public { Some("0.0.0.0") } else { args.addr.host.as_deref().filter(|h| !h.is_empty()) };
    if let Some(h) = host_arg {
        cfg.host = h.into();
    }
    if let Some(p) = args.addr.port {
        cfg.port = p.into();
    }
    if args.key {
        cfg.access_key = Some(prompt_access_key()?);
    }
    let (host, port) = resolve_addr(None, None, &cfg);
    let has_key = cfg.access_key.as_deref().is_some_and(|k| !k.is_empty());
    require_loopback_or_auth(&host, env_set("OPENAGENTD_DESKTOP_TOKEN") || env_set("OPENAGENTD_ACCESS_KEY") || has_key)?;
    if host_arg.is_some() || args.addr.port.is_some() || args.key {
        appv3_core::runtime_settings::save_server_settings(&cfg).context("save server.yaml")?;
    }

    let srv_log = server_log();
    print_banner(&host, port);
    if let Some(p) = srv_log.parent() {
        std::fs::create_dir_all(p).with_context(|| format!("create {}", p.display()))?;
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&srv_log).with_context(|| format!("open {}", srv_log.display()))?;
    let mut cmd = std::process::Command::new(exe());
    // APP_ENV is inherited (main defaults it to production), so the daemon
    // uses the same state dir as this process's PID file and log.
    cmd.args(["server", "serve", "--host", &host, "--port", &port.to_string()]).env(DAEMON_ENV, "1");
    if has_key && !env_set("OPENAGENTD_ACCESS_KEY") {
        cmd.env("OPENAGENTD_ACCESS_KEY", cfg.access_key.as_deref().unwrap_or(""));
    }
    if let Some(dir) = exe().parent() {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    // Windows: detach from the caller's console group, and give the server a
    // hidden console so the shells it spawns don't open windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().context("start the server process")?;
    let _ = write_pids(&[child.id()]);
    field("Logs:", &srv_log.display().to_string());
    if all_interfaces(&host) {
        if let Some(lan) = server_addresses(&host, port).lan.first() {
            field("LAN:", &bold(lan));
            field("Mobile:", MOBILE_HINT);
        }
    }
    field("Stop:", &bold("agentd server stop"));
    println!();
    let ready = !args.wait || wait_ready(&mut child, &host, port);
    if args.qr && ready {
        show_connect_qr(&host, port);
    }
    Ok(ready)
}

const MOBILE_HINT: &str = "scan with --qr, or enter the LAN address in the mobile app";

fn warn(msg: &str) {
    println!("  {}: {msg}", bold(&yellow("warning")));
    println!();
}

/// The `openagentd://connect` QR code for the server on `bind_host:port`.
/// Problems are warnings: the server itself is fine either way.
fn show_connect_qr(bind_host: &str, port: u16) {
    if !all_interfaces(bind_host) {
        return warn(&format!("--qr needs a LAN host; start the server with {}", bold("--public")));
    }
    let lan = server_addresses(bind_host, port).lan;
    if lan.is_empty() {
        return warn("no LAN address found; QR code skipped");
    }
    // What the server enforces: desktop token > access-key env > server.yaml.
    let key = appv3_core::auth::configured_access_token();
    if key.is_empty() {
        return warn("the access key is unknown in this shell (set OPENAGENTD_ACCESS_KEY or start with --key); QR code skipped");
    }
    match crate::qr::render(&crate::qr::connect_link(&lan, &key), crate::ui::color()) {
        Ok(code) => {
            for line in code.lines() {
                println!("  {line}");
            }
            println!();
            println!("  {}", dim("Scan with your phone's camera to open OpenAgentd and connect. The code contains the access key."));
            println!();
        }
        Err(e) => warn(&format!("{e:#}")),
    }
}

fn wait_ready(child: &mut Child, host: &str, port: u16) -> bool {
    let poll_host = display_host(host);
    field("Status:", "waiting for the server to become ready...");
    let started = Instant::now();
    let ready = loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            println!("  {}: the server process exited; see {}", bold(&red("error")), bold("agentd server logs"));
            break false;
        }
        if matches!(http_get(&poll_host, port, "/api/health/ready", Duration::from_secs(1)), Some((200, _))) {
            field("Status:", &format!("{} (took {:.2}s)", green("started and ready"), started.elapsed().as_secs_f64()));
            break true;
        }
        if started.elapsed() >= READY_TIMEOUT {
            println!("  {}: the server was not ready within {}s; see {}", bold(&yellow("warning")), READY_TIMEOUT.as_secs(), bold("agentd server logs"));
            break false;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    println!();
    ready
}

#[cfg(unix)]
fn kill_pid(pid: i32, sig: nix::sys::signal::Signal) {
    use nix::unistd::Pid;
    let p = Pid::from_raw(pid);
    if let Ok(pgid) = nix::unistd::getpgid(Some(p)) {
        if pgid == p {
            let _ = nix::sys::signal::killpg(pgid, sig);
            return;
        }
    }
    let _ = nix::sys::signal::kill(p, sig);
}

pub fn stop() -> Result<()> {
    let alive = find_pids();
    if alive.is_empty() {
        println!("  {}", yellow("not running"));
        return Ok(());
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::Signal;
        for &pid in &alive {
            kill_pid(pid, Signal::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive.iter().any(|&p| pid_alive(p)) {
            if Instant::now() > deadline {
                for &pid in &alive {
                    if pid_alive(pid) {
                        kill_pid(pid, Signal::SIGKILL);
                    }
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    // Windows has no SIGTERM. `/T` also ends the server's children (shells,
    // MCP and LSP servers).
    #[cfg(windows)]
    {
        for &pid in &alive {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive.iter().any(|&p| pid_alive(p)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    clear_pids();
    println!("  {}", green("stopped"));
    Ok(())
}

pub fn restart(args: &StartArgs) -> Result<ExitCode> {
    println!();
    println!("  {}", bold(&cyan("Restarting OpenAgentd")));
    println!();
    if find_pids().is_empty() {
        println!("  {}  starting fresh", yellow("not running"));
    } else {
        stop()?;
    }
    let ok = start_daemon(args)?;
    if ok {
        println!("  {}", green("restart complete"));
    }
    Ok(code(ok))
}

/// `(status, JSON body)`; status 0 when the server did not answer.
fn fetch_json(host: &str, port: u16, path: &str) -> (u16, Option<Value>) {
    match http_get(host, port, path, Duration::from_secs(2)) {
        Some((status, body)) => (status, serde_json::from_slice(&body).ok()),
        None => (0, None),
    }
}

/// Process, addresses, and (when running) port / live / ready / LAN checks.
/// Exits 1 when the server is stopped or a check fails. `--qr` adds the
/// connect QR code at the end.
pub fn status(args: &StatusArgs) -> Result<ExitCode> {
    let addr = &args.addr;
    let cfg = server_settings()?;
    let (bind_host, port) = resolve_addr(addr.host.as_deref(), addr.port, &cfg);
    let host = display_host(&bind_host);
    let alive = find_pids();
    println!();
    println!("  {}  {}", bold(&cyan("OpenAgentd server")), dim(&format!("v{}", appv3_core::VERSION)));
    println!();
    if alive.is_empty() {
        field("Status:", &yellow("stopped"));
        field("Start:", &format!("{}  or  {}", bold("agentd server start"), bold("agentd server start --public --key --qr")));
        println!();
        return Ok(ExitCode::FAILURE);
    }
    let lan_bound = all_interfaces(&bind_host);
    let addresses = server_addresses(&bind_host, port);
    field("Status:", &format!("{}  pid {}", green("running"), pid_list(&alive)));
    field("Local:", &bold(&addresses.local));
    if lan_bound {
        for (i, url) in addresses.lan.iter().enumerate() {
            field(if i == 0 { "LAN:" } else { "" }, &green(url));
        }
        if !addresses.lan.is_empty() {
            field("Mobile:", MOBILE_HINT);
        }
    }
    field("Logs:", &server_log().display().to_string());
    println!();

    let mut checks = Checks::default();
    let name = |n: &str, detail: &str| format!("{}  {}", bold(&format!("{n:<9}")), dim(detail));
    if is_port_reachable(&host, port) {
        checks.ok(&name("Port", &format!("{host}:{port} accepts connections")));
    } else {
        checks.fail(&name("Port", &format!("{host}:{port} is not reachable")));
    }
    match fetch_json(&host, port, "/api/health/live") {
        (200, payload) => {
            let version = payload.as_ref().and_then(|p| p.get("version")).and_then(Value::as_str).map(|v| format!(" · v{v}")).unwrap_or_default();
            checks.ok(&name("API live", &format!("live endpoint ok{version}")));
        }
        _ => checks.fail(&name("API live", "no healthy /api/health/live response")),
    }
    match fetch_json(&host, port, "/api/health/ready") {
        (200, _) => checks.ok(&name("API ready", "database and runtime checks passed")),
        (0, _) => checks.fail(&name("API ready", "no /api/health/ready response")),
        (_, payload) => checks.warn(&name("API ready", &payload.map(|p| p.to_string()).unwrap_or_else(|| "readiness degraded".into()))),
    }
    if lan_bound {
        if addresses.lan.is_empty() {
            checks.warn(&name("LAN", "listening on all interfaces, but no LAN IP was found"));
        } else {
            checks.ok(&name("LAN", &addresses.lan.join(", ")));
        }
    }
    println!();
    println!("  {}", checks.summary());
    println!();
    if args.qr {
        show_connect_qr(&bind_host, port);
    }
    Ok(code(checks.failures == 0))
}

pub fn logs(args: &LogsArgs) -> Result<()> {
    let log = server_log();
    if !log.is_file() {
        bail!("no server log at {}; start the server with `agentd server start`", log.display());
    }
    match follow_log(&log, args.lines) {
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        r => r.with_context(|| format!("read {}", log.display())),
    }
}

/// `tail -n <lines> -f`, rendering structured records. Runs until killed.
fn follow_log(path: &std::path::Path, lines: usize) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    let mut out = std::io::stdout().lock();
    let data = std::fs::read(path)?;
    let mut pending = Vec::new();
    emit_lines(&mut out, &data[tail_start(&data, lines)..], &mut pending)?;
    let mut pos = data.len() as u64;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let Ok(mut f) = std::fs::File::open(path) else { continue };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < pos {
            // Rotated or truncated: start over at the new file's beginning.
            pos = 0;
            pending.clear();
        }
        if len > pos && f.seek(SeekFrom::Start(pos)).is_ok() {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                pos += buf.len() as u64;
                emit_lines(&mut out, &buf, &mut pending)?;
            }
        }
    }
}

/// Print every complete line of `pending + chunk`; keep the partial tail.
fn emit_lines(out: &mut impl std::io::Write, chunk: &[u8], pending: &mut Vec<u8>) -> std::io::Result<()> {
    pending.extend_from_slice(chunk);
    while let Some(i) = pending.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = pending.drain(..=i).collect();
        let text = String::from_utf8_lossy(&line[..i]);
        writeln!(out, "{}", render_log_line(text.trim_end_matches('\r')))?;
    }
    out.flush()
}

/// A structured record (`{"text": ..., "record": ...}`) as its `text`;
/// anything else verbatim.
fn render_log_line(line: &str) -> Cow<'_, str> {
    if line.starts_with('{') {
        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(line) {
            if let Some(Value::String(t)) = m.get("text") {
                return Cow::Owned(t.trim_end_matches(['\r', '\n']).to_string());
            }
        }
    }
    Cow::Borrowed(line)
}

/// Byte offset where the last `lines` lines of `data` begin (`tail -n`).
fn tail_start(data: &[u8], lines: usize) -> usize {
    if lines == 0 {
        return data.len();
    }
    let body = data.strip_suffix(b"\n").unwrap_or(data);
    let mut seen = 0;
    for (i, &b) in body.iter().enumerate().rev() {
        if b == b'\n' {
            seen += 1;
            if seen == lines {
                return i + 1;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_start_matches_tail_n() {
        let d = b"a\nb\nc\n";
        assert_eq!(&d[tail_start(d, 2)..], b"b\nc\n");
        assert_eq!(&d[tail_start(d, 5)..], b"a\nb\nc\n");
        assert_eq!(&d[tail_start(d, 0)..], b"");
        let e = b"a\nb";
        assert_eq!(&e[tail_start(e, 1)..], b"b");
    }

    #[test]
    fn structured_records_render_as_their_text() {
        let rec = r#"{"text": "2026-09-29 09:56:04.022 | INFO     | appv3_agent:<module>:481 - llm_response agent=code\n", "record": {"line": 481}}"#;
        assert_eq!(render_log_line(rec), "2026-09-29 09:56:04.022 | INFO     | appv3_agent:<module>:481 - llm_response agent=code");
        assert_eq!(render_log_line("error: address already in use"), "error: address already in use");
        assert_eq!(render_log_line(r#"{"no_text": 1}"#), r#"{"no_text": 1}"#);
        assert_eq!(render_log_line("{not json"), "{not json");
    }

    #[test]
    fn partial_lines_wait_for_their_newline() {
        let mut out = Vec::new();
        let mut pending = Vec::new();
        emit_lines(&mut out, b"{\"text\": \"one\\n\"}\r\ntw", &mut pending).unwrap();
        assert_eq!(out, b"one\n");
        emit_lines(&mut out, b"o\n", &mut pending).unwrap();
        assert_eq!(out, b"one\ntwo\n");
        assert!(pending.is_empty());
    }
}
