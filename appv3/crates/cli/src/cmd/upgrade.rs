//! `agentd upgrade`: stop the server, update, restart it. Homebrew
//! installs run `brew upgrade`; every other install updates itself from the
//! GitHub release archives (`self_update`).

use crate::cmd::self_update::{self, Outcome};
use crate::paths::find_pids;
use crate::ui::{bold, cyan, dim, green};
use anyhow::{Context, Result};
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use appv3_core::which::which;

/// Run with a 5 s timeout → `(exit code, stdout)`.
fn capture(cmd: &[&str]) -> Option<(i32, String)> {
    let mut child = Command::new(cmd[0]).args(&cmd[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            let out = child.wait_with_output().ok()?;
            return Some((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned()));
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn is_brew_managed() -> bool {
    let Some(brew) = which("brew") else { return false };
    let exe = std::env::current_exe().ok().and_then(|p| dunce::canonicalize(p).ok()).unwrap_or_default();
    let parts: Vec<String> = exe.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.iter().any(|p| p == "Cellar") || (parts.iter().any(|p| p == "Homebrew") && parts.iter().any(|p| p == "opt")) {
        return true;
    }
    capture(&[&brew.to_string_lossy(), "list", "--formula", "openagentd"]).is_some_and(|(c, _)| c == 0)
}

/// `brew upgrade` (after `brew update`); returns the exit code.
fn brew_upgrade() -> Result<i32> {
    let pre = vec!["brew".to_string(), "update".to_string()];
    println!("  {}", dim(&pre.join(" ")));
    let code = run(&pre)?;
    if code != 0 {
        return Ok(code);
    }
    let cmd: Vec<String> = ["brew", "upgrade", "--formula", "lthoangg/tap/openagentd"].iter().map(|s| s.to_string()).collect();
    println!("  {}", dim(&cmd.join(" ")));
    run(&cmd)
}

/// Update this binary from the release archives; returns the exit code.
fn release_upgrade(exe: &std::path::Path) -> i32 {
    let Some(dir) = exe.parent() else { return 1 };
    self_update::cleanup_old(dir);
    let base = self_update::releases_base();
    println!("  {}", dim(&format!("{base}/latest → {}", self_update::target_triple())));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(self_update::update(&base, appv3_core::VERSION, dir)) {
        Ok(Outcome::UpToDate(v)) => {
            println!("  {} (v{v})", green("Already up to date"));
            0
        }
        Ok(Outcome::Updated { from, to }) => {
            println!("  {} v{from} → v{to} ({})", green("Updated"), dir.display());
            0
        }
        Err(e) => {
            eprintln!("  Upgrade failed: {e:#}");
            1
        }
    }
}

fn restart_command() -> Vec<String> {
    let exe = which("agentd")
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| std::env::args().next().filter(|a| std::path::Path::new(a).is_file()))
        .unwrap_or_else(|| "agentd".into());
    vec![exe, "server".into(), "start".into()]
}

/// The command's exit code (1 when killed by a signal).
fn run(cmd: &[String]) -> Result<i32> {
    let status = Command::new(&cmd[0]).args(&cmd[1..]).status().with_context(|| format!("run {}", cmd[0]))?;
    Ok(status.code().unwrap_or(1))
}

fn exit_code(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code & 0xff).unwrap_or(1))
}

pub fn upgrade() -> Result<ExitCode> {
    let exe = std::env::current_exe().ok().and_then(|p| dunce::canonicalize(p).ok()).unwrap_or_default();
    if self_update::is_desktop_bundled(&exe) {
        println!("  This agentd is bundled with the desktop app, which updates it (Settings → About).");
        return Ok(ExitCode::SUCCESS);
    }
    let was_running = !find_pids().is_empty();
    if was_running {
        println!("  {} before upgrade ...", bold("Stopping agentd"));
        crate::cmd::server::stop()?;
    }
    let manager = if is_brew_managed() { "brew" } else { "GitHub releases" };
    println!("  {} via {} ...", bold("Upgrading agentd"), cyan(manager));
    let code = if manager == "brew" { brew_upgrade()? } else { release_upgrade(&exe) };
    let mut restart_code = 0;
    if was_running {
        let restart = restart_command();
        if code == 0 {
            println!("  {} ...", bold("Restarting agentd"));
        } else {
            println!("  {} after failed upgrade ...", bold("Restarting agentd"));
        }
        println!("  {}", dim(&restart.join(" ")));
        restart_code = run(&restart)?;
    }
    Ok(exit_code(if code != 0 { code } else { restart_code }))
}
