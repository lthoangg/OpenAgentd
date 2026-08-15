use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
#[cfg(test)]
use tauri_plugin_dialog::MessageDialogResult;

use crate::{AppState, CachedUpdateState, persist_active_window_state_async};
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

#[cfg(target_os = "macos")]
fn resolve_macos_signing_identity() -> String {
    let local_cert_name = "OpenAgentd Local Signer";

    if let Ok(output) = std::process::Command::new("security")
        .args(["find-identity", "-v", "-p", "codesigning"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains(local_cert_name) {
            return local_cert_name.to_string();
        }
        for line in stdout.lines() {
            if line.contains("Apple Development:") {
                if let Some(start) = line.find('"') {
                    if let Some(end) = line[start + 1..].find('"') {
                        return line[start + 1..start + 1 + end].to_string();
                    }
                }
            }
        }
    }

    if let Ok(tmp_dir) = tempfile::tempdir() {
        let cert_cnf = tmp_dir.path().join("cert.cnf");
        let key_file = tmp_dir.path().join("oad.key");
        let crt_file = tmp_dir.path().join("oad.crt");
        let p12_file = tmp_dir.path().join("oad.p12");

        let cnf_content = "[req]\ndistinguished_name = req_distinguished_name\nprompt = no\n\n[req_distinguished_name]\nCN = OpenAgentd Local Signer\nO = OpenAgentd Local\n\n[v3_req]\nbasicConstraints = CA:FALSE\nkeyUsage = digitalSignature\nextendedKeyUsage = codeSigning\n";
        if std::fs::write(&cert_cnf, cnf_content).is_ok() {
            let req_ok = std::process::Command::new("openssl")
                .args([
                    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
                    "-config", cert_cnf.to_str().unwrap(),
                    "-extensions", "v3_req",
                    "-keyout", key_file.to_str().unwrap(),
                    "-out", crt_file.to_str().unwrap(),
                ])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if req_ok {
                let p12_ok = std::process::Command::new("openssl")
                    .args([
                        "pkcs12", "-export", "-legacy",
                        "-inkey", key_file.to_str().unwrap(),
                        "-in", crt_file.to_str().unwrap(),
                        "-name", local_cert_name,
                        "-out", p12_file.to_str().unwrap(),
                        "-passout", "pass:oadsecret",
                    ])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);

                if p12_ok {
                    let home = std::env::var("HOME").unwrap_or_default();
                    let keychain = format!("{home}/Library/Keychains/login.keychain-db");
                    let import_ok = std::process::Command::new("security")
                        .args([
                            "import", p12_file.to_str().unwrap(),
                            "-k", &keychain,
                            "-P", "oadsecret",
                            "-T", "/usr/bin/codesign",
                        ])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);

                    if import_ok {
                        let _ = std::process::Command::new("security")
                            .args([
                                "add-trusted-cert", "-d", "-r", "trustRoot",
                                "-p", "codeSign",
                                "-k", &keychain,
                                crt_file.to_str().unwrap(),
                            ])
                            .output();
                        return local_cert_name.to_string();
                    }
                }
            }
        }
    }

    "-".to_string()
}

#[cfg(target_os = "macos")]
fn prepare_macos_update_archive(bytes: Vec<u8>, bundle_id: &str) -> Result<Vec<u8>, String> {
    use flate2::{read::GzDecoder, write::GzEncoder, Compression};
    use std::ffi::OsStr;

    let temp_dir = tempfile::tempdir().map_err(|e| format!("Create update staging dir: {e}"))?;
    let mut archive = tar::Archive::new(GzDecoder::new(bytes.as_slice()));
    archive
        .unpack(temp_dir.path())
        .map_err(|e| format!("Extract macOS update: {e}"))?;

    let app_bundles = std::fs::read_dir(temp_dir.path())
        .map_err(|e| format!("Read macOS update contents: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension() == Some(OsStr::new("app")))
        .collect::<Vec<_>>();
    let [app_bundle] = app_bundles.as_slice() else {
        return Err(format!(
            "Expected one .app bundle in macOS update, found {}",
            app_bundles.len()
        ));
    };

    let entitlements = app_bundle.join("Contents/Resources/entitlements.plist");
    if !entitlements.is_file() {
        return Err("macOS update is missing entitlements.plist".to_string());
    }

    let signature = std::process::Command::new("codesign")
        .args(["-d", "-r", "-"])
        .arg(app_bundle)
        .output()
        .map_err(|e| format!("Inspect macOS update signature: {e}"))?;
    if !signature.status.success() {
        return Err(format!(
            "Inspect macOS update signature: {}",
            String::from_utf8_lossy(&signature.stderr).trim()
        ));
    }
    let signature_info = format!(
        "{}\n{}",
        String::from_utf8_lossy(&signature.stdout),
        String::from_utf8_lossy(&signature.stderr)
    );
    let stable_requirement = format!("designated => identifier \"{bundle_id}\"");
    let designated = signature_info
        .lines()
        .find(|line| line.trim_start().starts_with("designated =>"))
        .map(str::trim)
        .unwrap_or("");
    // Leave the signature untouched only when its designated requirement is
    // already stable across updates: an Apple-anchored chain (Developer ID)
    // or the exact identifier-only requirement we apply below. Anything else
    // — ad-hoc ``cdhash H"…"`` or a local-cert ``certificate root = H"…"`` —
    // changes between builds or cert regenerations, which invalidates the
    // keychain "Always Allow" ACL and re-prompts the user after every update.
    let required_identifier = format!("identifier \"{bundle_id}\"");
    if designated == stable_requirement
        || (designated.contains(&required_identifier) && designated.contains("anchor apple"))
    {
        return Ok(bytes);
    }

    // Pass the explicit identifier-only requirement for *every* local signing
    // identity (persistent local cert, Apple Development, ad-hoc). Without
    // ``-r=`` codesign derives a default requirement that pins the signing
    // certificate, and self-signed local certs are not stable across machines
    // or regenerations.
    let identity = resolve_macos_signing_identity();
    let output = std::process::Command::new("codesign")
        .args(["--force", "--deep", "--sign", &identity, "--options", "runtime"])
        .arg(format!("-r={stable_requirement}"))
        .arg("--entitlements")
        .arg(&entitlements)
        .arg(app_bundle)
        .output()
        .map_err(|e| format!("Run codesign for macOS update: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Sign macOS update: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut rebuilt = tar::Builder::new(encoder);
    let app_name = app_bundle
        .file_name()
        .ok_or_else(|| "macOS update bundle has no filename".to_string())?;
    rebuilt
        .append_dir_all(app_name, app_bundle)
        .map_err(|e| format!("Rebuild macOS update: {e}"))?;
    let encoder = rebuilt
        .into_inner()
        .map_err(|e| format!("Finalize macOS update archive: {e}"))?;
    encoder
        .finish()
        .map_err(|e| format!("Compress macOS update archive: {e}"))
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
    run_update_install(app).await
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
    let app_for_progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
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

    // Give ad-hoc update bundles a stable identity before the updater swaps
    // them into place. TCC sees the new signature on first launch, while an
    // existing Developer ID or already-stable signature is left untouched.
    #[cfg(target_os = "macos")]
    let bytes = {
        let bundle_id = app.config().identifier.clone();
        tokio::task::spawn_blocking(move || prepare_macos_update_archive(bytes, &bundle_id))
            .await
            .map_err(|e| format!("Prepare macOS update task panicked: {e}"))??
    };

    // Flip the quit guard BEFORE the relaunch sequence so the window
    // `CloseRequested` handler stops calling `prevent_close()`. If it did not,
    // the bundle swap below could leave a hidden window alive and trap the exit
    // half-way, which is one way the relaunch silently fails.
    persist_active_window_state_async(&app).await;
    state.quitting.store(true, Ordering::SeqCst);

    // Shut the Python sidecar down *before* the bundle swap so the child
    // receives SIGTERM while we still own a clean process tree. Doing it after
    // `install()` races the updater's relaunch.
    shutdown_sidecar_now(&app).await;

    update_tray_status(&app, "Status: Installing update…");
    log::info!("updater install applying version={}", update.version);

    // `tauri_plugin_updater`'s `install()` on macOS performs the bundle swap
    // and then *itself* relaunches the app (via NSTask / execve inside the
    // plugin). It does NOT return to this callsite — the process is replaced.
    // Calling `app.restart()` afterwards (as the old code did) therefore
    // queued a second restart that raced the plugin's own relaunch: whichever
    // relaunch won caused the new binary to start, and the loser restarted the
    // *old* binary on top of it — producing the "restarted at old version"
    // symptom visible in the logs.
    //
    // The correct sequence on macOS is: call `install()` directly on a
    // blocking thread and let the plugin handle the relaunch. On other
    // platforms `install()` does NOT relaunch by itself, so we issue an
    // explicit `app.restart()` via `run_on_main_thread` after it returns.
    //
    // Off-load to `spawn_blocking` in both cases so the tokio runtime remains
    // responsive during the heavy FS work (decompression, codesign).
    #[cfg(target_os = "macos")]
    {
        // On macOS, install() replaces the process — this line never returns
        // on success. Spawn on a blocking thread so the async executor stays
        // alive long enough for the plugin to complete the bundle swap.
        let install_result = tokio::task::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| format!("Install task panicked: {e}"))?;
        // Only reached on install failure (success = process replaced).
        install_result.map_err(|e| {
            update_tray_status(&app, "Status: Running");
            format!("Failed to install update: {e}")
        })?;
        // If install() returned Ok without replacing the process (shouldn't
        // happen on macOS but be defensive), fall through to an explicit restart.
        update_tray_status(&app, "Status: Restarting…");
        log::info!("updater install complete (macOS fallback restart)");
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            handle.restart();
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        // On Windows/Linux, install() swaps the bundle but does NOT relaunch.
        // We must call restart() ourselves after it returns.
        let install_result = tokio::task::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| format!("Install task panicked: {e}"))?;
        install_result.map_err(|e| {
            update_tray_status(&app, "Status: Running");
            format!("Failed to install update: {e}")
        })?;

        update_tray_status(&app, "Status: Restarting…");
        log::info!("updater install complete; dispatching app restart");
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            log::info!("updater restart executing on main thread");
            handle.restart();
        });
    }

    // Keep the command pending while restart is in flight so the frontend
    // stays on "Installing / Restarting…" rather than resolving prematurely.
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

pub async fn fetch_release_notes(version: &str) -> Result<ReleaseNotesResponse, String> {
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    let url = format!("https://api.github.com/repos/lthoangg/openagentd/releases/tags/{tag}");
    let release = reqwest::Client::new()
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

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::prepare_macos_update_archive;
    use flate2::{read::GzDecoder, write::GzEncoder, Compression};

    #[test]
    fn prepared_update_uses_a_stable_designated_requirement() {
        let source = tempfile::tempdir().expect("create source dir");
        let app = source.path().join("OpenAgentd.app");
        let macos = app.join("Contents/MacOS");
        let resources = app.join("Contents/Resources");
        std::fs::create_dir_all(&macos).expect("create MacOS dir");
        std::fs::create_dir_all(&resources).expect("create Resources dir");
        std::fs::copy("/usr/bin/true", macos.join("OpenAgentd")).expect("copy test executable");
        std::fs::write(
            app.join("Contents/Info.plist"),
            br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OpenAgentd</string>
<key>CFBundleIdentifier</key><string>com.openagentd.desktop</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>"#,
        )
        .expect("write Info.plist");
        std::fs::write(
            resources.join("entitlements.plist"),
            br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict></dict></plist>"#,
        )
        .expect("write entitlements");

        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        archive
            .append_dir_all("OpenAgentd.app", &app)
            .expect("archive test app");
        let input = archive
            .into_inner()
            .expect("finalize input tar")
            .finish()
            .expect("compress input tar");

        let prepared = prepare_macos_update_archive(input, "com.openagentd.desktop")
            .expect("prepare update archive");
        let prepared_again =
            prepare_macos_update_archive(prepared.clone(), "com.openagentd.desktop")
                .expect("recheck prepared update archive");
        assert_eq!(
            prepared_again, prepared,
            "an update with a stable requirement must not be re-signed"
        );
        let extracted = tempfile::tempdir().expect("create extraction dir");
        tar::Archive::new(GzDecoder::new(prepared_again.as_slice()))
            .unpack(extracted.path())
            .expect("extract prepared update");
        let output = std::process::Command::new("codesign")
            .args(["-d", "-r", "-"])
            .arg(extracted.path().join("OpenAgentd.app"))
            .output()
            .expect("inspect prepared signature");
        assert!(output.status.success(), "codesign inspection failed");
        let requirement = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let designated = requirement
            .lines()
            .find(|line| line.trim_start().starts_with("designated =>"))
            .unwrap_or("")
            .trim();
        // The requirement must be *exactly* identifier-only. Any extra
        // clause (``cdhash H"…"``, ``certificate root = H"…"``) pins the
        // binary or the local signing certificate — both change across
        // updates, invalidating the keychain "Always Allow" ACL and
        // re-prompting the user after every update.
        assert_eq!(
            designated, "designated => identifier \"com.openagentd.desktop\"",
            "designated requirement must be identifier-only and stable: {requirement}"
        );
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
