use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
#[cfg(test)]
use tauri_plugin_dialog::MessageDialogResult;

use crate::{AppState, CachedUpdateState, persist_active_window_state};
use crate::menu::{now_unix, update_tray_status};
use crate::window::show_target_window;
use crate::shutdown_sidecar_now;

/// Minimum spacing between *automatic* update checks, process-wide.
///
/// The React card owns a 6h schedule, but it lives in component refs
/// (`UpdateCard.tsx`) that reseed to "now" on every mount — so every new
/// window, reload and foreground event fired another check. Production
/// logs showed 5-10 unauthenticated GitHub requests per hour against that
/// 6h policy, including a double-fire in the same second at startup
/// (Rust's own check racing the React one).
///
/// User-initiated checks ("Check for Updates…", Settings, "Try again")
/// pass `silent=false` and always run — the user explicitly asked.
const SILENT_CHECK_MIN_GAP: Duration = Duration::from_secs(60 * 60);

/// Unix-seconds timestamp of the last automatic check. `0` means never.
static LAST_SILENT_CHECK: AtomicI64 = AtomicI64::new(0);

/// Whether an automatic check may run, given when the last one ran.
pub fn silent_check_is_due(now: i64, last_check: i64) -> bool {
    now.saturating_sub(last_check) >= SILENT_CHECK_MIN_GAP.as_secs() as i64
}

/// Reserve the next automatic-check slot, or report that one ran too
/// recently. `compare_exchange` makes the reservation exclusive so two
/// checks racing at startup collapse into one.
fn claim_silent_check_slot() -> bool {
    let now = now_unix();
    let last = LAST_SILENT_CHECK.load(Ordering::SeqCst);
    if !silent_check_is_due(now, last) {
        return false;
    }
    LAST_SILENT_CHECK
        .compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

fn up_to_date_status() -> UpdateStatus {
    UpdateStatus {
        status: "up_to_date".into(),
        version: None,
        current_version: env!("CARGO_PKG_VERSION").into(),
        notes: None,
        downloaded_bytes: None,
        total_bytes: None,
        message: None,
    }
}

/// Minimum spacing between download-progress updates.
///
/// `tauri-plugin-updater` invokes the progress callback once per network
/// chunk (`updater.rs:705`, `while let Some(chunk) = stream.next()`),
/// which is thousands of calls for a 200 MB bundle. Each one was an IPC
/// round-trip to every window *plus* an `update_tray_status` task that
/// blocks on the main thread to set the menu text. 250ms is well past
/// what a human can read and cuts the traffic by two to three orders of
/// magnitude.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// Whether a progress update should be emitted now. `elapsed` is the time
/// since the last emit, or `None` for the first chunk. The chunk that
/// completes the download always emits so the bar reaches 100%.
pub fn should_emit_progress(elapsed: Option<Duration>, downloaded: u64, total: Option<u64>) -> bool {
    if total.is_some_and(|total| downloaded >= total) {
        return true;
    }
    elapsed.map_or(true, |elapsed| elapsed >= PROGRESS_EMIT_INTERVAL)
}

#[derive(Clone, Serialize)]
pub struct UpdateStatus {
    pub status: String,
    pub version: Option<String>,
    pub current_version: String,
    pub notes: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub message: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateStatusRequest {
    pub silent: Option<bool>,
}

#[derive(Serialize)]
pub struct ReleaseNotesResponse {
    pub version: String,
    pub url: String,
    pub body: String,
}

#[derive(Deserialize)]
pub struct GitHubRelease {
    pub html_url: String,
    pub body: Option<String>,
}

/// Pure precondition check extracted from `run_update_install` so it can be
/// unit-tested without a live AppHandle or network.
///
/// Returns `Ok(())` when the cached state is consistent with `server_version`
/// and the bytes file exists, or `Err(message)` for every failure case that
/// would abort the install before touching the filesystem.
pub fn validate_install_preconditions(
    cached: Option<&CachedUpdateState>,
    server_version: Option<&str>,
) -> Result<(), String> {
    let cached = cached.ok_or_else(|| "Update has not been downloaded yet.".to_string())?;

    if !cached.bytes_path.is_file() {
        return Err("Downloaded update file is missing. Download the update again.".into());
    }

    let server_version =
        server_version.ok_or_else(|| "The downloaded update is no longer listed as available. Try downloading again.".to_string())?;

    if cached.version != server_version {
        return Err(format!(
            "Downloaded version {} no longer matches the available version {}. Download the update again.",
            cached.version, server_version
        ));
    }

    Ok(())
}

/// Manual "Check for Updates…" flow triggered from the menu bar.
///
/// The React shell owns updater UI. Rust keeps the menu working by focusing
/// the main window and asking React to start a visible check.
pub fn request_update_check(app: &AppHandle) {
    show_target_window(app);
    let _ = app.emit("updater-check-requested", ());
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    request: Option<UpdateStatusRequest>,
) -> Result<UpdateStatus, String> {
    let silent = request.and_then(|r| r.silent).unwrap_or(false);
    run_update_check(app, silent).await
}

#[tauri::command]
pub async fn updater_download(app: AppHandle) -> Result<UpdateStatus, String> {
    run_update_download(app).await
}

#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), String> {
    // The error otherwise only reaches the UI: v3.19 → v3.20 install
    // failures left no trace in desktop.log.
    run_update_install(app)
        .await
        .inspect_err(|e| log::error!("updater install failed: {e}"))
}

#[tauri::command]
pub async fn updater_release_notes(version: String) -> Result<ReleaseNotesResponse, String> {
    fetch_release_notes(&version).await
}

pub async fn run_update_check(app: AppHandle, silent: bool) -> Result<UpdateStatus, String> {
    // Throttle automatic checks only. The caller ignores an `up_to_date`
    // result for silent checks (`UpdateCard.tsx`), so a skipped check is
    // indistinguishable from a completed one that found nothing — and an
    // update that lands inside the gap is still surfaced by the next check
    // or by the startup check's `updater-status` event.
    if silent && !claim_silent_check_slot() {
        log::debug!("updater check skipped: inside the automatic-check min gap");
        return Ok(up_to_date_status());
    }
    log::info!("updater check started silent={silent}");
    let updater = app
        .updater()
        .map_err(|e| format!("Updater unavailable: {e}"))?;
    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("updater check found version={}", update.version);
            let state: tauri::State<'_, AppState> = app.state();
            let cached = state.update_state.lock().await.clone();
            let status = if cached
                .as_ref()
                .is_some_and(|c| c.version == update.version && c.bytes_path.is_file())
            {
                UpdateStatus {
                    status: "downloaded".into(),
                    version: Some(update.version),
                    current_version: env!("CARGO_PKG_VERSION").into(),
                    notes: update.body,
                    downloaded_bytes: None,
                    total_bytes: None,
                    message: None,
                }
            } else {
                UpdateStatus {
                    status: "available".into(),
                    version: Some(update.version),
                    current_version: env!("CARGO_PKG_VERSION").into(),
                    notes: update.body,
                    downloaded_bytes: None,
                    total_bytes: None,
                    message: None,
                }
            };
            emit_update_status(&app, &status);
            Ok(status)
        }
        Ok(None) => {
            log::info!("updater check found no update silent={silent}");
            let status = UpdateStatus {
                message: if silent {
                    None
                } else {
                    Some("OpenAgentd is up to date.".into())
                },
                ..up_to_date_status()
            };
            if !silent {
                emit_update_status(&app, &status);
            }
            Ok(status)
        }
        Err(e) => {
            log::warn!("updater check failed: {e}");
            Err(format!("Couldn't check for updates: {e}"))
        }
    }
}

pub async fn run_update_download(app: AppHandle) -> Result<UpdateStatus, String> {
    log::info!("updater download started");
    let updater = app
        .updater()
        .map_err(|e| format!("Updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?
        .ok_or_else(|| "OpenAgentd is already up to date.".to_string())?;

    update_tray_status(&app, "Status: Downloading update…");
    let version = update.version.clone();
    log::info!("updater download available version={version}");
    let mut downloaded: u64 = 0;
    let mut last_emit: Option<std::time::Instant> = None;
    let app_for_progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if !should_emit_progress(last_emit.map(|at| at.elapsed()), downloaded, total) {
                    return;
                }
                last_emit = Some(std::time::Instant::now());
                let progress = UpdateStatus {
                    status: "downloading".into(),
                    version: Some(version.clone()),
                    current_version: env!("CARGO_PKG_VERSION").into(),
                    notes: None,
                    downloaded_bytes: Some(downloaded),
                    total_bytes: total,
                    message: None,
                };
                emit_update_status(&app_for_progress, &progress);
                update_tray_status(
                    &app_for_progress,
                    &format_download_progress((downloaded / (1024 * 1024)) as usize, total),
                );
            },
            {
                let app_for_finish = app.clone();
                move || update_tray_status(&app_for_finish, "Status: Update downloaded")
            },
        )
        .await
        .map_err(|e| {
            update_tray_status(&app, "Status: Running");
            format!("Failed to download update: {e}")
        })?;

    let path =
        cached_update_path(&app, &update.version).map_err(|e| format!("Cache update: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Write cached update: {e}"))?;
    log::info!("updater download cached version={} path={}", update.version, path.display());
    let state: tauri::State<'_, AppState> = app.state();
    *state.update_state.lock().await = Some(CachedUpdateState {
        version: update.version.clone(),
        bytes_path: path,
    });

    let status = UpdateStatus {
        status: "downloaded".into(),
        version: Some(update.version),
        current_version: env!("CARGO_PKG_VERSION").into(),
        notes: None,
        downloaded_bytes: None,
        total_bytes: None,
        message: None,
    };
    emit_update_status(&app, &status);
    Ok(status)
}

pub async fn run_update_install(app: AppHandle) -> Result<(), String> {
    log::info!("updater install started");
    let state: tauri::State<'_, AppState> = app.state();

    // Guard against a double-invoke: if the user hits "Install & Restart"
    // while a previous install is already tearing the app down, reject
    // immediately. Without this guard the second call queues a redundant
    // restart that fires *after* the new binary has already launched,
    // re-opening the old version on top of the fresh one.
    if state.quitting.load(Ordering::SeqCst) {
        log::info!("updater install skipped: already quitting");
        // Return Ok so the frontend doesn't show an error toast — the
        // install is in progress and the restart will happen on its own.
        return Ok(());
    }
    let cached_guard = state.update_state.lock().await;
    let cached = cached_guard.clone();
    drop(cached_guard);

    // Re-check to obtain a live `Update` object whose `install()` carries the
    // correct `extract_path` for this platform. We validate preconditions
    // BEFORE the network round-trip so that missing-cache errors are
    // immediate, and AFTER so that we can catch a genuine mid-install manifest
    // rollover (server already bumped to the next version).
    let updater = app
        .updater()
        .map_err(|e| format!("Updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;

    validate_install_preconditions(
        cached.as_ref(),
        update.as_ref().map(|u| u.version.as_str()),
    )?;

    // SAFETY: validate_install_preconditions returned Ok, so `update` is Some.
    let update = update.expect("update is Some after validate_install_preconditions");
    // SAFETY: validate_install_preconditions returned Ok, so `cached` is Some
    // and `cached.bytes_path.is_file()`.
    let cached = cached.expect("cached is Some after validate_install_preconditions");
    log::info!(
        "updater install preconditions ok version={} path={}",
        cached.version,
        cached.bytes_path.display()
    );

    let bytes =
        std::fs::read(&cached.bytes_path).map_err(|e| format!("Read cached update: {e}"))?;

    // `install()` checks the bytes against the published signature
    // (tauri-plugin-updater >= 2.14.0), so they go in exactly as downloaded:
    // CI already signs the macOS bundle with the stable identifier-only
    // requirement. Check them now, while the backend still runs, so a bad
    // download fails without taking the app down.
    update
        .verify(&bytes)
        .map_err(|e| format!("The downloaded update failed verification ({e}). Download it again."))?;

    // Flip the quit guard BEFORE the relaunch sequence so the window
    // `CloseRequested` handler stops calling `prevent_close()`. If it did not,
    // the bundle swap below could leave a hidden window alive and trap the exit
    // half-way, which is one way the relaunch silently fails.
    persist_active_window_state(&app);
    state.quitting.store(true, Ordering::SeqCst);

    // Shut the backend sidecar down *before* the bundle swap so the child
    // receives SIGTERM while we still own a clean process tree. Doing it after
    // `install()` races the relaunch.
    let had_sidecar = state.sidecar.lock().await.is_some();
    shutdown_sidecar_now(&app).await;

    update_tray_status(&app, "Status: Installing update…");
    log::info!("updater install applying version={}", update.version);

    // On macOS and Linux `install()` swaps the bundle and returns; on Windows
    // it launches the installer and exits. So restart exactly once, after it
    // returns: a second restart re-opened the old version on top of the new
    // one. Off-load to `spawn_blocking` so the runtime stays responsive
    // during decompression.
    let install_result = tokio::task::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| format!("Install task panicked: {e}"))
        .and_then(|result| result.map_err(|e| format!("Failed to install update: {e}")));
    if let Err(error) = install_result {
        recover_from_failed_install(&app, had_sidecar).await;
        return Err(error);
    }

    update_tray_status(&app, "Status: Restarting…");
    log::info!("updater install complete; dispatching app restart");
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        log::info!("updater restart executing on main thread");
        handle.restart();
    });

    // Keep the command pending while restart is in flight so the frontend
    // stays on "Installing / Restarting…" rather than resolving prematurely.
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

/// Undo the teardown after `install()` failed: the old version is still in
/// place, so keep running it. Before this, the app stayed up with its
/// backend stopped and the quit guard set until the user reloaded it.
async fn recover_from_failed_install(app: &AppHandle, had_sidecar: bool) {
    let state: tauri::State<'_, AppState> = app.state();
    state.quitting.store(false, Ordering::SeqCst);
    update_tray_status(app, "Status: Running");
    if !had_sidecar {
        return;
    }
    match crate::commands::start_bundled_sidecar(app).await {
        Ok(ready) => {
            log::info!("bundled backend restarted after a failed update on port {}", ready.port);
            crate::watchdog::notify_bundled_windows(app, ready);
        }
        Err(e) => {
            log::error!("bundled backend restart after a failed update failed: {e}");
            update_tray_status(app, "Status: Error");
        }
    }
}

pub async fn fetch_release_notes(version: &str) -> Result<ReleaseNotesResponse, String> {
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    let url = format!("https://api.github.com/repos/lthoangg/openagentd/releases/tags/{tag}");
    // Shared process-wide client (see `usage::shared_client`) — reuses the
    // warm connection pool and, unlike a bare `Client::new()`, carries a
    // 10s total timeout so a stalled GitHub API call can't pend forever.
    let release = crate::usage::shared_client()
        .get(&url)
        .header(reqwest::header::USER_AGENT, "OpenAgentd updater")
        .send()
        .await
        .map_err(|e| format!("Fetch release notes: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Fetch release notes: {e}"))?
        .json::<GitHubRelease>()
        .await
        .map_err(|e| format!("Read release notes: {e}"))?;
    Ok(ReleaseNotesResponse {
        version: version.to_string(),
        url: release.html_url,
        body: release
            .body
            .unwrap_or_else(|| "No release notes published for this version.".into()),
    })
}

pub fn emit_update_status(app: &AppHandle, status: &UpdateStatus) {
    let _ = app.emit("updater-status", status);
}

pub fn cached_update_path(app: &AppHandle, version: &str) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir()?.join("updater");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("openagentd-{version}.update")))
}

/// Delete update bundles left behind by previous runs, returning how many
/// were removed.
///
/// `AppState::update_state` — the only handle to a downloaded bundle — is
/// in-memory and starts as `None`, so a bundle that outlives its process
/// can never be matched by `validate_install_preconditions` again. Every
/// `.update` file present at startup is therefore unreachable garbage. A
/// production cache was holding a 205 MB bundle for the version already
/// running.
fn purge_update_bundles(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for path in entries.flatten().map(|entry| entry.path()) {
        if path.extension().is_some_and(|ext| ext == "update") {
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    log::info!("removed stale cached update {}", path.display());
                    removed += 1;
                }
                Err(e) => log::warn!("failed to remove {}: {e}", path.display()),
            }
        }
    }
    removed
}

/// Startup hook for [`purge_update_bundles`]. No-op when the cache
/// directory does not exist yet.
pub fn purge_cached_updates(app: &AppHandle) {
    let Ok(cache_dir) = app.path().app_cache_dir() else {
        return;
    };
    purge_update_bundles(&cache_dir.join("updater"));
}

/// Map a ``MessageDialogResult`` from an ``OkCancelCustom`` dialog to a
/// simple accept/cancel boolean.
///
/// ``OkCancelCustom`` yields ``Custom(label)`` matching the button text the
/// user pressed (rfd's behaviour, surfaced through tauri-plugin-dialog).
/// Some platforms still report a plain ``Ok``/``Cancel`` for the bundled
/// system dialog, so we accept either spelling of "yes".
#[cfg(test)]
pub fn dialog_result_is_accept(result: &MessageDialogResult, ok_label: &str) -> bool {
    match result {
        MessageDialogResult::Ok | MessageDialogResult::Yes => true,
        MessageDialogResult::Custom(s) => s == ok_label,
        MessageDialogResult::Cancel | MessageDialogResult::No => false,
    }
}

/// Build the "Update available" dialog body shown to the user.
///
/// Release notes are truncated to ~600 characters with an ellipsis so a
/// runaway changelog never produces a multi-screen modal. An empty/None
/// body collapses the notes paragraph entirely.
#[cfg(test)]
pub fn format_update_prompt(new_version: &str, current_version: &str, body: Option<&str>) -> String {
    const MAX_NOTES_CHARS: usize = 600;
    let notes = body.unwrap_or_default().trim();
    let trimmed = if notes.chars().count() > MAX_NOTES_CHARS {
        let mut s: String = notes.chars().take(MAX_NOTES_CHARS - 1).collect();
        s.push('…');
        s
    } else {
        notes.to_string()
    };
    if trimmed.is_empty() {
        format!(
            "OpenAgentd {new_version} is available (you have {current_version}).\n\nDownload now?"
        )
    } else {
        format!(
            "OpenAgentd {new_version} is available (you have {current_version}).\n\n{trimmed}\n\nDownload now?"
        )
    }
}

/// Format the tray status string shown during a bundle download.
///
/// ``total == Some(0)`` is treated the same as ``None`` — some HTTP
/// responses omit ``Content-Length`` and our caller passes whatever it
/// has — so we never produce a misleading ``"5/0 MB"`` label.
pub fn format_download_progress(downloaded_mb: usize, total_bytes: Option<u64>) -> String {
    match total_bytes {
        Some(total) if total > 0 => {
            let total_mb = total / (1024 * 1024);
            format!("Status: Downloading {downloaded_mb}/{total_mb} MB")
        }
        _ => format!("Status: Downloading {downloaded_mb} MB"),
    }
}

#[cfg(test)]
mod cache_tests {
    use super::purge_update_bundles;

    // A production cache held a 205 MB bundle for the version already
    // running: `update_state` is in-memory and starts as `None`, so nothing
    // could ever reach that file again.

    #[test]
    fn stale_bundles_are_removed_and_other_files_are_left_alone() {
        let dir = tempfile::tempdir().expect("create cache dir");
        let stale = dir.path().join("openagentd-1.133.0.update");
        let older = dir.path().join("openagentd-1.132.0.update");
        let unrelated = dir.path().join("notes.txt");
        std::fs::write(&stale, b"bundle").expect("write stale bundle");
        std::fs::write(&older, b"bundle").expect("write older bundle");
        std::fs::write(&unrelated, b"keep me").expect("write unrelated file");

        assert_eq!(purge_update_bundles(dir.path()), 2);

        assert!(!stale.exists());
        assert!(!older.exists());
        assert!(unrelated.exists(), "only .update bundles are purged");
    }

    #[test]
    fn a_missing_cache_directory_is_not_an_error() {
        let dir = tempfile::tempdir().expect("create temp root");

        assert_eq!(purge_update_bundles(&dir.path().join("updater")), 0);
    }
}
