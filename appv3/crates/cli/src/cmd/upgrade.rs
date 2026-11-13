//! `agentd upgrade`: stop the server, update, start it again. Homebrew
//! installs run `brew upgrade`; every other install updates itself from the
//! GitHub release archives (`self_update`).
//!
//! `--from-server` is the server's update API (`/api/server/update`) asking:
//! the first stage starts a second one outside the server's process tree
//! (which `server stop` may end) and exits; the second waits for the API's
//! answer to go out, upgrades, starts the server and waits for it, and records
//! the outcome in `upgrade-status.json` for the server that comes back.

use crate::cli::UpgradeArgs;
use crate::cmd::self_update::{self, Outcome};
use crate::paths::find_pids;
use crate::ui::{self, bold, dim};
use anyhow::{Context, Result};
use appv3_core::release::{self, InstallMethod};
use appv3_core::which::which;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

/// What one upgrade did.
struct Report {
    from: String,
    /// The version installed now (`from` when already up to date).
    to: Option<String>,
    ok: bool,
    message: String,
}

pub fn upgrade(args: &UpgradeArgs) -> Result<ExitCode> {
    if args.from_server {
        return from_server();
    }
    let exe = release::current_exe();
    if release::is_desktop_bundled(&exe) {
        ui::header("Upgrade agentd", &format!("v{}", appv3_core::VERSION));
        ui::mark_line(&ui::idle_mark(), "This agentd ships inside the desktop app, which updates it: Settings → About → Check for updates.");
        println!();
        return Ok(ExitCode::SUCCESS);
    }
    let report = run(&exe)?;
    Ok(if report.ok { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

/// Stop (if running), update, start again. Prints each step.
fn run(exe: &Path) -> Result<Report> {
    let from = appv3_core::VERSION.to_string();
    let method = release::install_method(exe);
    let via = if method == InstallMethod::Brew { "Homebrew" } else { "GitHub releases" };
    ui::header("Upgrade agentd", &format!("v{from} · {via}"));

    let was_running = !find_pids().is_empty();
    if was_running {
        crate::cmd::server::stop_quietly()?;
        ui::mark_line(&ui::ok_mark(), "Stopped the server");
    }

    let mut report = match method {
        InstallMethod::Brew => brew_upgrade(&from)?,
        _ => release_upgrade(exe, &from),
    };

    if was_running {
        let restart = restart_command(exe, method);
        match run_captured(&restart) {
            Ok((0, _)) => {
                let addr = crate::net::server_settings().map(|cfg| crate::net::resolve_addr(None, None, &cfg)).ok();
                let at = addr.map(|(h, p)| format!("  {}", dim(&format!("http://{}:{p}", crate::net::display_host(&h))))).unwrap_or_default();
                let what = if report.ok { "Server running again" } else { "Server running again on the old version" };
                ui::mark_line(&ui::ok_mark(), &format!("{what}{at}"));
            }
            Ok((code, output)) => {
                ui::mark_line(&ui::fail_mark(), &format!("The server did not start again (exit {code})"));
                for line in output.lines().filter(|l| !l.trim().is_empty()).take(12) {
                    println!("     {}", dim(line.trim_end()));
                }
                ui::next("Start it:", "agentd server start");
                report.ok = false;
                report.message = format!("{} The server did not start again (exit {code}).", report.message).trim().to_string();
            }
            Err(e) => {
                ui::mark_line(&ui::fail_mark(), &format!("Could not start the server again: {e:#}"));
                report.ok = false;
                report.message = format!("{} Could not start the server again.", report.message).trim().to_string();
            }
        }
    }
    if let Some(to) = report.to.as_deref().filter(|to| *to != from && report.ok) {
        ui::hint(&format!("What's new: {}", release::release_page(to)));
    }
    println!();
    Ok(report)
}

/// Update this binary from the release archives.
fn release_upgrade(exe: &Path, from: &str) -> Report {
    let fail = |message: String| Report { from: from.to_string(), to: None, ok: false, message };
    let Some(dir) = exe.parent() else { return fail("cannot tell where agentd is installed".into()) };
    self_update::cleanup_old(dir);
    let base = self_update::releases_base();
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(e.to_string()),
    };
    match rt.block_on(self_update::update(&base, from, dir)) {
        Ok(Outcome::UpToDate(v)) => {
            ui::mark_line(&ui::ok_mark(), &format!("Already up to date  {}", dim(&format!("v{v}"))));
            Report { from: from.to_string(), to: Some(v), ok: true, message: "Already on the latest release.".into() }
        }
        Ok(Outcome::Updated { from, to }) => {
            ui::mark_line(&ui::ok_mark(), &format!("Updated {} → {}  {}", dim(&format!("v{from}")), bold(&format!("v{to}")), dim(&ui::tilde(dir))));
            Report { message: format!("Updated v{from} → v{to}."), from, to: Some(to), ok: true }
        }
        Err(e) => {
            ui::mark_line(&ui::fail_mark(), &format!("Update failed: {e:#}"));
            fail(format!("{e:#}"))
        }
    }
}

/// `brew update` then `brew upgrade`; their output shows as it runs.
fn brew_upgrade(from: &str) -> Result<Report> {
    for args in [&["update"][..], &["upgrade", "--formula", "lthoangg/tap/openagentd"][..]] {
        println!("  {}  {}", ui::idle_mark(), dim(&format!("brew {}", args.join(" "))));
        let status = Command::new("brew").args(args).status().context("run brew")?;
        if !status.success() {
            let message = format!("brew {} failed (exit {})", args[0], status.code().unwrap_or(1));
            ui::mark_line(&ui::fail_mark(), &message);
            return Ok(Report { from: from.to_string(), to: None, ok: false, message });
        }
    }
    let to = installed_version().unwrap_or_else(|| from.to_string());
    if to == from {
        ui::mark_line(&ui::ok_mark(), &format!("Already up to date  {}", dim(&format!("v{to}"))));
    } else {
        ui::mark_line(&ui::ok_mark(), &format!("Updated {} → {}", dim(&format!("v{from}")), bold(&format!("v{to}"))));
    }
    let message = if to == from { "Already on the latest release.".to_string() } else { format!("Updated v{from} → v{to}.") };
    Ok(Report { from: from.to_string(), to: Some(to), ok: true, message })
}

/// `agentd --version` of the agentd on PATH (`agentd v3.1.0` → `3.1.0`).
fn installed_version() -> Option<String> {
    let agentd = which("agentd")?;
    let (code, out) = run_captured(&[agentd.to_string_lossy().into_owned(), "--version".into()]).ok()?;
    (code == 0).then(|| out.split_whitespace().last().map(|v| v.trim_start_matches('v').to_string())).flatten()
}

/// `agentd server start` with the new binary: the same path for a release
/// install (it was replaced in place), the one on PATH for Homebrew (the
/// Cellar path carries the old version). It returns once the server answers.
fn restart_command(exe: &Path, method: InstallMethod) -> Vec<String> {
    let bin: PathBuf = match method {
        InstallMethod::Brew => which("agentd").unwrap_or_else(|| exe.to_path_buf()),
        _ => exe.to_path_buf(),
    };
    vec![bin.to_string_lossy().into_owned(), "server".into(), "start".into()]
}

/// Run → `(exit code, stdout + stderr)`; 1 when killed by a signal.
fn run_captured(cmd: &[String]) -> Result<(i32, String)> {
    let out = Command::new(&cmd[0]).args(&cmd[1..]).stdin(Stdio::null()).output().with_context(|| format!("run {}", cmd[0]))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code().unwrap_or(1), text))
}

// ── --from-server ───────────────────────────────────────────────────────────

fn from_server() -> Result<ExitCode> {
    if std::env::var(release::UPGRADE_STAGE_ENV).as_deref() != Ok("2") {
        spawn_detached_stage()?;
        return Ok(ExitCode::SUCCESS);
    }
    // Let the API's 202 reach the client before the server stops.
    std::thread::sleep(Duration::from_millis(1500));
    println!("── {} upgrade requested by the server (pid {}) ──", chrono::Utc::now().to_rfc3339(), std::process::id());
    let started_at = read_status().and_then(|s| s["started_at"].as_str().map(String::from)).unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let exe = release::current_exe();
    let report = run(&exe).unwrap_or_else(|e| Report { from: appv3_core::VERSION.into(), to: None, ok: false, message: format!("{e:#}") });
    write_status(&json!({
        "state": "finished",
        "ok": report.ok,
        "from": report.from,
        "to": report.to,
        "message": report.message,
        "started_at": started_at,
        "finished_at": chrono::Utc::now().to_rfc3339(),
    }));
    Ok(if report.ok { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

fn read_status() -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(release::upgrade_status_path()).ok()?).ok()
}

fn write_status(v: &serde_json::Value) {
    let path = release::upgrade_status_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_vec_pretty(v).unwrap_or_default());
}

/// Start stage two in a session of its own (no parent the server's stop
/// reaches), keeping this process's stdout/stderr (upgrade.log).
fn spawn_detached_stage() -> Result<()> {
    let mut cmd = Command::new(release::current_exe());
    cmd.args(["upgrade", "--from-server"]).env(release::UPGRADE_STAGE_ENV, "2").stdin(Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
        if let Ok(child) = cmd.spawn() {
            drop(child);
            return Ok(());
        }
        // The job does not allow breakaway: stay in it (the server is no job's).
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    cmd.spawn().context("start the upgrade")?;
    Ok(())
}
