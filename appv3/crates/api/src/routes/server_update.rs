//! `GET|POST /api/server/update`: update this server to the latest release
//! from a client (v3 only; `api.server_update` in the health capabilities).
//!
//! Only a server `agentd server start` launched (the CLI background server)
//! updates itself: the CLI knows how to stop, upgrade and start that one.
//! The desktop app updates its own sidecar, and a foreground server (`server
//! serve`, systemd, Docker) has nobody to start it again, so those report a
//! `reason` and the client says what to do instead.
//!
//! POST takes no input. It starts `agentd upgrade --from-server`, which
//! leaves this server's process tree, stops the server, installs the
//! release (`brew upgrade`, or the sha256-verified archive) and starts the
//! server again; restart-resume then continues the turns it cut off. The
//! helper records how it went in `upgrade-status.json`, which the server that
//! comes back reports as `last`.

use crate::error::{ApiError, ApiResult};
use crate::util::{json, json_code, Qs};
use crate::AppState;
use appv3_core::release::{self, InstallMethod};
use appv3_core::VERSION;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::{json as j, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub fn router() -> Router<AppState> {
    Router::new().route("/update", get(status).post(start))
}

/// How this server was launched, set once by `server serve`.
#[derive(Debug, Clone, Default)]
pub struct Launch {
    /// Started by `agentd server start`.
    pub cli_daemon: bool,
    /// The desktop app's sidecar (session token or parent watch).
    pub desktop_sidecar: bool,
    /// The access key from the environment, read before the child-env
    /// scrub: the restarted server needs it when server.yaml lacks it.
    pub access_key: Option<String>,
}

static LAUNCH: OnceLock<Launch> = OnceLock::new();
/// Held while a POST records and spawns the helper. After that the status
/// file says `running` until the helper writes how it went, so a helper that
/// fails without stopping this server does not block the next try.
static IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct StartGuard;

impl Drop for StartGuard {
    fn drop(&mut self) {
        IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

pub fn set_launch(launch: Launch) {
    let _ = LAUNCH.set(launch);
}

fn launch() -> Launch {
    LAUNCH.get().cloned().unwrap_or_default()
}

/// Why this server cannot update itself, if it cannot.
fn blocker(launch: &Launch, method: InstallMethod, target: &str) -> Option<&'static str> {
    if launch.desktop_sidecar || method == InstallMethod::DesktopBundled {
        Some("desktop_sidecar")
    } else if !launch.cli_daemon {
        Some("foreground")
    } else if method == InstallMethod::Release && target == "unsupported" {
        Some("unsupported_platform")
    } else {
        None
    }
}

fn install_method() -> InstallMethod {
    static M: OnceLock<InstallMethod> = OnceLock::new();
    *M.get_or_init(|| release::install_method(&release::current_exe()))
}

// ── latest release (cached) ─────────────────────────────────────────────────

const FRESH_FOR: Duration = Duration::from_secs(60 * 60);
const FAILED_FRESH_FOR: Duration = Duration::from_secs(5 * 60);

type Cached = (Instant, Result<String, String>);

fn cache() -> &'static Mutex<Option<Cached>> {
    static C: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

async fn fetch_latest() -> Result<String, String> {
    let client = reqwest::Client::builder().user_agent(format!("openagentd/{VERSION}")).timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{}/latest", release::releases_base())).send().await.map_err(|e| format!("could not reach the release feed: {e}"))?;
    let resp = resp.error_for_status().map_err(|e| format!("the release feed answered {e}"))?;
    release::version_from_tag_url(resp.url().path()).ok_or_else(|| format!("unexpected latest release URL: {}", resp.url().path()))
}

async fn latest(refresh: bool) -> Result<String, String> {
    if !refresh {
        if let Some((at, hit)) = cache().lock().unwrap().as_ref() {
            let ttl = if hit.is_ok() { FRESH_FOR } else { FAILED_FRESH_FOR };
            if at.elapsed() < ttl {
                return hit.clone();
            }
        }
    }
    let got = fetch_latest().await;
    if let Err(e) = &got {
        tracing::warn!("server_update_check_failed error={}", e);
    }
    *cache().lock().unwrap() = Some((Instant::now(), got.clone()));
    got
}

// ── status file ─────────────────────────────────────────────────────────────

/// A helper that has not finished within this long is taken for dead.
const RUNNING_FOR_AT_MOST: chrono::TimeDelta = chrono::TimeDelta::minutes(15);

fn last_upgrade() -> Option<Value> {
    let text = std::fs::read_to_string(release::upgrade_status_path()).ok()?;
    serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
}

/// A helper (this server's or the one before it) is still working.
fn helper_running(last: Option<&Value>) -> bool {
    let Some(last) = last.filter(|l| l["state"] == "running") else { return false };
    let started = last["started_at"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
    started.is_some_and(|t| chrono::Utc::now().signed_duration_since(t) < RUNNING_FOR_AT_MOST)
}

fn write_status(v: &Value) {
    let path = release::upgrade_status_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, serde_json::to_vec_pretty(v).unwrap_or_default());
}

// ── handlers ────────────────────────────────────────────────────────────────

fn body(launch: &Launch, method: InstallMethod, latest: &Result<String, String>, last: Option<Value>) -> Value {
    let reason = blocker(launch, method, release::target_triple());
    let latest_v = latest.as_ref().ok();
    let available = latest_v.is_some_and(|l| release::is_newer(l, VERSION));
    let in_progress = IN_PROGRESS.load(Ordering::SeqCst) || helper_running(last.as_ref());
    j!({
        "current": VERSION,
        "latest": latest_v,
        "available": available,
        "can_upgrade": reason.is_none(),
        "method": (method != InstallMethod::DesktopBundled).then(|| method.as_str()),
        "reason": reason,
        "check_error": latest.as_ref().err(),
        "in_progress": in_progress,
        "release_url": latest_v.map(|v| release::release_page(v)),
        "log": release::upgrade_log_path().display().to_string(),
        "last": last,
    })
}

async fn status(q: Qs) -> ApiResult<Response> {
    let refresh = q.bool("refresh", false)?;
    let launch = launch();
    let method = tokio::task::spawn_blocking(install_method).await.unwrap_or(InstallMethod::Release);
    Ok(json(body(&launch, method, &latest(refresh).await, last_upgrade())))
}

async fn start() -> ApiResult<Response> {
    let launch = launch();
    let method = tokio::task::spawn_blocking(install_method).await.unwrap_or(InstallMethod::Release);
    if let Some(reason) = blocker(&launch, method, release::target_triple()) {
        return Err(ApiError::with_detail(422, j!({"message": "This server cannot update itself.", "reason": reason})));
    }
    let target = latest(true).await.map_err(|e| ApiError::new(502, e))?;
    if !release::is_newer(&target, VERSION) {
        return Err(ApiError::conflict(format!("Already on the latest release (v{VERSION}).")));
    }
    if IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err(ApiError::conflict("An update is already running."));
    }
    let _guard = StartGuard;
    if helper_running(last_upgrade().as_ref()) {
        return Err(ApiError::conflict("An update is already running."));
    }
    let started_at = chrono::Utc::now().to_rfc3339();
    write_status(&j!({"state": "running", "from": VERSION, "to": target, "started_at": started_at}));
    if let Err(e) = spawn_helper(&launch) {
        let message = format!("could not start the updater: {e}");
        write_status(
            &j!({"state": "finished", "ok": false, "from": VERSION, "to": target, "message": message, "started_at": started_at, "finished_at": chrono::Utc::now().to_rfc3339()}),
        );
        return Err(ApiError::internal(message));
    }
    tracing::info!("server_update_started from={} to={} method={}", VERSION, target, method.as_str());
    Ok(json_code(202, j!({"status": "started", "from": VERSION, "target": target, "started_at": started_at})))
}

/// Start stage one of `agentd upgrade --from-server`, which starts stage two
/// outside this process tree and exits.
fn spawn_helper(launch: &Launch) -> std::io::Result<()> {
    let log_path = release::upgrade_log_path();
    if let Some(dir) = log_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
    let mut cmd = std::process::Command::new(release::current_exe());
    cmd.args(["upgrade", "--from-server"])
        .env(appv3_core::settings::MODE_ENV, &appv3_core::settings().app_env)
        .env_remove(release::UPGRADE_STAGE_ENV)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if let Some(key) = launch.access_key.as_deref().filter(|k| !k.is_empty()) {
        cmd.env(appv3_core::auth::ACCESS_KEY_ENV, key);
    }
    appv3_core::proctree::hide_window_std(&mut cmd);
    let mut child = cmd.spawn()?;
    // Reap stage one; it exits as soon as stage two is running.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn daemon() -> Launch {
        Launch { cli_daemon: true, ..Default::default() }
    }

    #[test]
    fn only_the_cli_background_server_updates_itself() {
        let target = "x86_64-unknown-linux-gnu";
        assert_eq!(blocker(&daemon(), InstallMethod::Release, target), None);
        assert_eq!(blocker(&daemon(), InstallMethod::Brew, target), None);
        assert_eq!(blocker(&Launch::default(), InstallMethod::Release, target), Some("foreground"));
        assert_eq!(blocker(&Launch { desktop_sidecar: true, ..daemon() }, InstallMethod::Release, target), Some("desktop_sidecar"));
        assert_eq!(blocker(&daemon(), InstallMethod::DesktopBundled, target), Some("desktop_sidecar"));
        assert_eq!(blocker(&daemon(), InstallMethod::Release, "unsupported"), Some("unsupported_platform"));
        assert_eq!(blocker(&daemon(), InstallMethod::Brew, "unsupported"), None, "brew builds from source");
    }

    #[test]
    fn status_says_what_is_available_and_why_not() {
        let v = body(&daemon(), InstallMethod::Release, &Ok("99.0.0".into()), None);
        assert_eq!((v["available"].as_bool(), v["can_upgrade"].as_bool(), v["reason"].is_null()), (Some(true), Some(true), true));
        assert_eq!(v["latest"], "99.0.0");
        assert_eq!(v["method"], "release");
        assert!(v["release_url"].as_str().unwrap().ends_with("/tag/v99.0.0"));

        let v = body(&Launch::default(), InstallMethod::Brew, &Ok(VERSION.into()), None);
        assert_eq!((v["available"].as_bool(), v["can_upgrade"].as_bool(), v["reason"].as_str()), (Some(false), Some(false), Some("foreground")));

        let v = body(&daemon(), InstallMethod::Release, &Err("offline".into()), None);
        assert_eq!((v["latest"].is_null(), v["available"].as_bool(), v["check_error"].as_str()), (true, Some(false), Some("offline")));
    }

    #[test]
    fn a_running_helper_counts_until_it_is_stale() {
        let now = chrono::Utc::now();
        let running = |at: chrono::DateTime<chrono::Utc>| j!({"state": "running", "started_at": at.to_rfc3339()});
        assert!(helper_running(Some(&running(now))));
        assert!(!helper_running(Some(&running(now - chrono::TimeDelta::minutes(20)))));
        assert!(!helper_running(Some(&j!({"state": "finished", "started_at": now.to_rfc3339()}))));
        assert!(!helper_running(None));
    }
}
