use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
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

/// Ownership of the one update install. Taken before any asynchronous
/// precondition, so a second "Install & Restart" (another window, a
/// double tap) cannot run a parallel install. Dropped (released) on every
/// failure; on success the app restarts while holding it.
///
/// Deliberately not the app's `quitting` flag: setting that at entry would
/// close windows for real and stop crash recovery before the bytes were
/// verified.
pub struct InstallLease {
    flag: Arc<AtomicBool>,
}

impl Drop for InstallLease {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

/// How an install request starts.
pub enum InstallEntry {
    Proceed(InstallLease),
    /// Another install owns the operation; it restarts the app on success.
    AlreadyInstalling,
    /// The app is already exiting or restarting.
    Quitting,
}

pub fn begin_install(install: &Arc<AtomicBool>, quitting: &AtomicBool) -> InstallEntry {
    if quitting.load(Ordering::SeqCst) {
        return InstallEntry::Quitting;
    }
    match install.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => InstallEntry::Proceed(InstallLease { flag: install.clone() }),
        Err(_) => InstallEntry::AlreadyInstalling,
    }
}

/// The effects of one install, in the order [`install_verified`] runs them.
/// The app's are `AppInstall`; tests record them.
pub(crate) trait InstallSteps {
    type Update;
    fn version(update: &Self::Update) -> &str;
    /// The live listing (`None`: nothing available any more).
    async fn check(&mut self) -> Result<Option<Self::Update>, String>;
    async fn read(&mut self, path: PathBuf) -> Result<Vec<u8>, String>;
    fn verify(&mut self, update: &Self::Update, bytes: &[u8]) -> Result<(), String>;
    /// Set the quit intent and stop the backend. Returns whether a bundled
    /// backend was running, starting or awaiting crash recovery.
    async fn teardown(&mut self) -> bool;
    async fn install(&mut self, update: Self::Update, bytes: Vec<u8>) -> Result<(), String>;
    /// Undo `teardown` after a failed install: the old version still runs.
    async fn recover(&mut self, had_sidecar: bool);
}

/// Check, read and verify the downloaded bytes while the app and backend
/// keep running; only then tear down and install those same bytes. A
/// failure before teardown changes nothing; one after it is recovered.
pub(crate) async fn install_verified<S: InstallSteps>(
    steps: &mut S,
    cached: Option<CachedUpdateState>,
) -> Result<(), String> {
    // Re-check to obtain a live `Update` object whose `install()` carries
    // the correct `extract_path` for this platform, and to catch a manifest
    // that moved on since the download.
    let update = steps.check().await?;
    validate_install_preconditions(cached.as_ref(), update.as_ref().map(S::version))?;
    let (Some(update), Some(cached)) = (update, cached) else {
        unreachable!("validate_install_preconditions requires both");
    };
    log::info!(
        "updater install preconditions ok version={} path={}",
        cached.version,
        cached.bytes_path.display()
    );
    let bytes = steps.read(cached.bytes_path).await?;
    // `install()` checks the bytes against the published signature
    // (tauri-plugin-updater >= 2.14.0), so they go in exactly as downloaded.
    // Check them now, while the backend still runs, so a bad download fails
    // without taking the app down.
    steps.verify(&update, &bytes).map_err(|e| {
        format!("The downloaded update failed verification ({e}). Download it again.")
    })?;
    let had_sidecar = steps.teardown().await;
    log::info!("updater install applying version={}", S::version(&update));
    if let Err(error) = steps.install(update, bytes).await {
        steps.recover(had_sidecar).await;
        return Err(error);
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
    // A new download is refused while an install holds its lease. A download
    // that was already running may still finish and rewrite the cache; the
    // install is unaffected because it reads the bytes once and verifies and
    // installs exactly those (`install_verified`).
    if app.state::<AppState>().update_install.load(Ordering::SeqCst) {
        return Err("An update is being installed.".into());
    }
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
    // Tens of MB: write on the blocking pool, not an async worker.
    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&write_path, bytes))
        .await
        .map_err(|e| format!("Write cached update: {e}"))?
        .map_err(|e| format!("Write cached update: {e}"))?;
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

    // Guard against a double-invoke: a second "Install & Restart" while an
    // install is checking, verifying or tearing the app down must not run
    // another one. A second install queued a redundant restart that fired
    // *after* the new binary had launched, re-opening the old version on
    // top of the fresh one. The lease is taken here, before any await; the
    // `quitting` flag is only set once the bytes are verified.
    let _lease = match begin_install(&state.update_install, &state.quitting) {
        InstallEntry::Proceed(lease) => lease,
        // Ok, so the frontend doesn't show an error toast: the owning
        // install is in progress and restarts the app on its own.
        InstallEntry::AlreadyInstalling => {
            log::info!("updater install skipped: another install is in progress");
            return Ok(());
        }
        InstallEntry::Quitting => {
            log::info!("updater install skipped: already quitting");
            return Ok(());
        }
    };
    let cached_guard = state.update_state.lock().await;
    let cached = cached_guard.clone();
    drop(cached_guard);

    install_verified(&mut AppInstall { app: app.clone() }, cached).await?;

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

/// The app's install effects for [`install_verified`].
struct AppInstall {
    app: AppHandle,
}

impl InstallSteps for AppInstall {
    type Update = tauri_plugin_updater::Update;

    fn version(update: &Self::Update) -> &str {
        update.version.as_str()
    }

    async fn check(&mut self) -> Result<Option<Self::Update>, String> {
        self.app
            .updater()
            .map_err(|e| format!("Updater unavailable: {e}"))?
            .check()
            .await
            .map_err(|e| format!("Couldn't check for updates: {e}"))
    }

    async fn read(&mut self, path: PathBuf) -> Result<Vec<u8>, String> {
        tauri::async_runtime::spawn_blocking(move || std::fs::read(path))
            .await
            .map_err(|e| format!("Read cached update: {e}"))?
            .map_err(|e| format!("Read cached update: {e}"))
    }

    fn verify(&mut self, update: &Self::Update, bytes: &[u8]) -> Result<(), String> {
        update.verify(bytes).map_err(|e| e.to_string())
    }

    async fn teardown(&mut self) -> bool {
        let state: tauri::State<'_, AppState> = self.app.state();
        // Flip the quit guard BEFORE the relaunch sequence so the window
        // `CloseRequested` handler stops calling `prevent_close()`. If it did
        // not, the bundle swap could leave a hidden window alive and trap the
        // exit half-way, which is one way the relaunch silently fails.
        persist_active_window_state(&self.app);
        state.quitting.store(true, Ordering::SeqCst);
        // Shut the backend sidecar down *before* the bundle swap so the child
        // receives SIGTERM while we still own a clean process tree. Doing it
        // after `install()` races the relaunch.
        let had_sidecar = shutdown_sidecar_now(&self.app).await;
        update_tray_status(&self.app, "Status: Installing update…");
        had_sidecar
    }

    async fn install(&mut self, update: Self::Update, bytes: Vec<u8>) -> Result<(), String> {
        // On macOS and Linux `install()` swaps the bundle and returns; on
        // Windows it launches the installer and exits. So restart exactly
        // once, after it returns: a second restart re-opened the old version
        // on top of the new one. Off-load to `spawn_blocking` so the runtime
        // stays responsive during decompression.
        tokio::task::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| format!("Install task panicked: {e}"))
            .and_then(|result| result.map_err(|e| format!("Failed to install update: {e}")))
    }

    async fn recover(&mut self, had_sidecar: bool) {
        recover_from_failed_install(&self.app, had_sidecar).await;
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
            update_tray_status(app, crate::menu::TRAY_STATUS_FAILED);
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
mod install_tests {
    use super::*;

    /// Records the effects of an install, in order.
    #[derive(Default)]
    struct Recorder {
        events: Vec<String>,
        listed: Option<&'static str>,
        bytes_on_disk: Vec<u8>,
        verify_ok: bool,
        install_ok: bool,
        had_sidecar: bool,
        installed: Option<Vec<u8>>,
    }

    impl InstallSteps for Recorder {
        type Update = &'static str;
        fn version(update: &Self::Update) -> &str {
            update
        }
        async fn check(&mut self) -> Result<Option<&'static str>, String> {
            self.events.push("check".into());
            Ok(self.listed)
        }
        async fn read(&mut self, _path: PathBuf) -> Result<Vec<u8>, String> {
            self.events.push("read".into());
            Ok(self.bytes_on_disk.clone())
        }
        fn verify(&mut self, _update: &&'static str, _bytes: &[u8]) -> Result<(), String> {
            self.events.push("verify".into());
            if self.verify_ok { Ok(()) } else { Err("bad signature".into()) }
        }
        async fn teardown(&mut self) -> bool {
            self.events.push("teardown".into());
            self.had_sidecar
        }
        async fn install(&mut self, _update: &'static str, bytes: Vec<u8>) -> Result<(), String> {
            self.events.push("install".into());
            self.installed = Some(bytes);
            if self.install_ok { Ok(()) } else { Err("Failed to install update: disk full".into()) }
        }
        async fn recover(&mut self, had_sidecar: bool) {
            self.events.push(format!("recover had_sidecar={had_sidecar}"));
        }
    }

    fn cached(dir: &tempfile::TempDir, version: &str) -> CachedUpdateState {
        let bytes_path = dir.path().join(format!("openagentd-{version}.update"));
        std::fs::write(&bytes_path, b"bundle").expect("write bundle");
        CachedUpdateState { version: version.into(), bytes_path }
    }

    fn recorder(listed: &'static str) -> Recorder {
        Recorder {
            listed: Some(listed),
            bytes_on_disk: b"signed bundle bytes".to_vec(),
            verify_ok: true,
            install_ok: true,
            had_sidecar: true,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn the_bytes_are_verified_before_the_app_is_torn_down_and_installed_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut steps = recorder("1.2.0");

        install_verified(&mut steps, Some(cached(&dir, "1.2.0"))).await.expect("install");

        assert_eq!(steps.events, ["check", "read", "verify", "teardown", "install"]);
        assert_eq!(steps.installed.as_deref(), Some(&b"signed bundle bytes"[..]));
    }

    #[tokio::test]
    async fn bytes_that_fail_verification_leave_the_app_and_backend_running() {
        let dir = tempfile::tempdir().unwrap();
        let mut steps = Recorder { verify_ok: false, ..recorder("1.2.0") };

        let err = install_verified(&mut steps, Some(cached(&dir, "1.2.0"))).await.unwrap_err();

        assert!(err.contains("failed verification"), "{err}");
        assert_eq!(steps.events, ["check", "read", "verify"], "no teardown, no install");
    }

    #[tokio::test]
    async fn a_listing_that_moved_on_stops_before_reading_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut steps = recorder("1.3.0");

        let err = install_verified(&mut steps, Some(cached(&dir, "1.2.0"))).await.unwrap_err();

        assert!(err.contains("no longer matches"), "{err}");
        assert_eq!(steps.events, ["check"]);
    }

    #[tokio::test]
    async fn a_failed_install_after_teardown_recovers_the_previous_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let mut steps = Recorder { install_ok: false, had_sidecar: false, ..recorder("1.2.0") };

        let err = install_verified(&mut steps, Some(cached(&dir, "1.2.0"))).await.unwrap_err();

        assert!(err.contains("disk full"), "{err}");
        assert_eq!(
            steps.events,
            ["check", "read", "verify", "teardown", "install", "recover had_sidecar=false"]
        );
    }

    #[test]
    fn a_second_install_is_refused_while_the_first_still_verifies() {
        let flag = Arc::new(AtomicBool::new(false));
        let quitting = AtomicBool::new(false);

        let first = begin_install(&flag, &quitting);
        assert!(matches!(first, InstallEntry::Proceed(_)));
        // `quitting` is still false: the first install has not verified yet.
        assert!(matches!(begin_install(&flag, &quitting), InstallEntry::AlreadyInstalling));
        assert!(!quitting.load(Ordering::SeqCst), "taking the lease is not a quit");
    }

    #[test]
    fn a_failed_install_releases_only_its_own_lease() {
        let flag = Arc::new(AtomicBool::new(false));
        let quitting = AtomicBool::new(false);

        let InstallEntry::Proceed(lease) = begin_install(&flag, &quitting) else { panic!("first install") };
        drop(lease); // the install returned an error

        assert!(matches!(begin_install(&flag, &quitting), InstallEntry::Proceed(_)), "the user can retry");
    }

    #[test]
    fn no_install_starts_while_the_app_is_quitting() {
        let flag = Arc::new(AtomicBool::new(false));
        let quitting = AtomicBool::new(true);

        assert!(matches!(begin_install(&flag, &quitting), InstallEntry::Quitting));
        assert!(!flag.load(Ordering::SeqCst));
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
