//! In-app updates for the mobile shell.
//!
//! The commands share their names and `UpdateStatus` shape with the desktop
//! updater, so the web UI (`web/src/lib/updater.ts`) drives both:
//!
//! * **Android**: `updater_check` reads `latest.json` from the rolling
//!   `latest-android` release (written by `mobile/scripts/publish-apk.sh`),
//!   `updater_download` fetches the APK into the cache directory and checks
//!   its SHA-256, and `updater_install` re-checks that SHA-256 and hands it
//!   to the system installer, which reads it after the hand-off.
//!   Android only installs it over the app when the signing key matches.
//! * **iOS**: no in-app updates. TestFlight and the App Store deliver and
//!   announce new builds themselves, so the web UI hides the updater there
//!   and `updater_check` only answers that.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const REPO: &str = "lthoangg/openagentd";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ANDROID_FEED: &str =
    "https://github.com/lthoangg/openagentd/releases/download/latest-android/latest.json";
/// Build-time override of the Android feed, for testing an update end to
/// end against a local server. Release builds never set it; when set, the
/// APK URL check only requires an `.apk` path.
const FEED_OVERRIDE: Option<&str> = option_env!("OAD_UPDATER_FEED_URL");
/// Bound on the APK download (today's APK is ~40 MB).
const MAX_APK_BYTES: u64 = 300 * 1024 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Clone, Serialize, Default, Debug, PartialEq)]
pub struct UpdateStatus {
    pub status: String,
    pub version: Option<String>,
    pub current_version: String,
    pub notes: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub message: Option<String>,
    /// `apk` on Android.
    pub channel: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateStatusRequest {
    #[allow(dead_code)]
    pub silent: Option<bool>,
}

/// `latest.json` on `latest-android`.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct AndroidManifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// The latest release the check found, kept for download and install.
#[derive(Clone, Debug)]
enum Found {
    Android { manifest: AndroidManifest, path: Option<PathBuf> },
}

/// What the last check selected. `generation` changes whenever the selected
/// release changes, so a download started for an older selection cannot
/// publish its APK over a newer one. One download runs at a time, and each
/// writes its own file, so no download overwrites an APK another step
/// still uses.
#[derive(Default)]
struct Selection {
    generation: u64,
    found: Option<Found>,
    downloading: bool,
    /// Downloads started, for unique APK file names.
    downloads: u64,
    /// The APK an install is checking and handing to the system installer.
    installing: Option<PathBuf>,
    /// The APK last handed to the system installer, which reads it after
    /// `install_apk` returns.
    handed_off: Option<PathBuf>,
}

#[derive(Default)]
pub struct UpdaterState(Mutex<Selection>);

impl UpdaterState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Selection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records a check result (`None` = up to date). Re-finding the same
    /// manifest keeps the selection, its downloaded APK and any running
    /// download; anything else replaces it.
    fn record_check(&self, manifest: Option<AndroidManifest>) {
        let mut s = self.lock();
        let unchanged = match (&s.found, &manifest) {
            (Some(Found::Android { manifest: old, .. }), Some(new)) => old == new,
            (None, None) => true,
            _ => false,
        };
        if unchanged {
            return;
        }
        s.generation += 1;
        s.found = manifest.map(|manifest| Found::Android { manifest, path: None });
    }

    /// Claims the single download slot for the current selection.
    fn begin_download(&self) -> Result<DownloadTicket<'_>, String> {
        let mut s = self.lock();
        let Some(Found::Android { manifest, .. }) = s.found.clone() else {
            return Err("No update to download. Check for updates first.".into());
        };
        if s.downloading {
            return Err("The update is already downloading.".into());
        }
        s.downloading = true;
        s.downloads += 1;
        Ok(DownloadTicket { state: self, generation: s.generation, id: s.downloads, manifest })
    }

    /// Claims the downloaded APK for one install. `Ok(None)`: another
    /// install is opening the installer already.
    fn begin_install(&self) -> Result<Option<InstallTicket<'_>>, String> {
        let mut s = self.lock();
        let (path, sha256) = match &s.found {
            Some(Found::Android { path: Some(path), manifest }) => (path.clone(), manifest.sha256.clone()),
            Some(Found::Android { path: None, .. }) => {
                return Err("Download the update before installing it.".into())
            }
            None => return Err("No update found. Check for updates first.".into()),
        };
        if s.installing.is_some() {
            return Ok(None);
        }
        s.installing = Some(path.clone());
        Ok(Some(InstallTicket { state: self, path, sha256 }))
    }

    /// APKs that cleanup must keep: the selected download, the one an
    /// install is handing over and the one the installer may still read.
    fn protected(&self) -> Vec<PathBuf> {
        let s = self.lock();
        let selected = match &s.found {
            Some(Found::Android { path, .. }) => path.clone(),
            None => None,
        };
        [selected, s.installing.clone(), s.handed_off.clone()].into_iter().flatten().collect()
    }
}

/// The running download. Dropping it (error, cancellation or done) frees
/// the download slot; hold it until its own file is published or removed.
struct DownloadTicket<'a> {
    state: &'a UpdaterState,
    generation: u64,
    id: u64,
    manifest: AndroidManifest,
}

impl DownloadTicket<'_> {
    /// This download's own file name. `stamp` (the time) keeps it unique
    /// across app runs, `id` within one.
    fn file_name(&self, stamp: u128) -> String {
        format!("OpenAgentd_{}_{stamp}_{}.apk", self.manifest.version, self.id)
    }

    /// Records the verified APK if the selection is still the one this
    /// download started for. `false` means a newer check replaced it; the
    /// caller owns `path` and must discard it.
    fn publish(&self, path: PathBuf) -> bool {
        let mut s = self.state.lock();
        if s.generation != self.generation {
            return false;
        }
        if let Some(Found::Android { path: slot, .. }) = &mut s.found {
            *slot = Some(path);
            return true;
        }
        false
    }
}

impl Drop for DownloadTicket<'_> {
    fn drop(&mut self) {
        self.state.lock().downloading = false;
    }
}

/// One install: its APK is kept from cleanup until it is handed over.
struct InstallTicket<'a> {
    state: &'a UpdaterState,
    path: PathBuf,
    sha256: String,
}

impl InstallTicket<'_> {
    /// The installer has the APK; keep it for the installer to read.
    fn handed_off(self) {
        self.state.lock().handed_off = Some(self.path.clone());
    }

    /// The APK is missing or no longer the verified bytes: forget it, so
    /// the next step is a new download rather than the same failure.
    fn discard(self) {
        let mut s = self.state.lock();
        if let Some(Found::Android { path, .. }) = &mut s.found {
            if path.as_deref() == Some(self.path.as_path()) {
                *path = None;
            }
        }
    }
}

impl Drop for InstallTicket<'_> {
    fn drop(&mut self) {
        self.state.lock().installing = None;
    }
}

// ── Update files (unit-tested on a temp dir) ───────────────────────────────

fn write_apk(dir: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Create {}: {e}", dir.display()))?;
    std::fs::write(path, bytes).map_err(|e| {
        let _ = std::fs::remove_file(path);
        format!("Write update: {e}")
    })
}

/// Drop APKs of earlier updates, except the ones still in use (`keep`).
fn remove_other_apks(dir: &Path, keep: &[PathBuf]) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        if path.is_file() && !keep.contains(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The APK at `path` is still exactly the download that passed the feed's
/// SHA-256 (re-read just before it goes to the installer).
fn check_apk(path: &Path, sha256: &str) -> Result<(), String> {
    const CHANGED: &str = "The downloaded update is missing or changed. Download it again.";
    let bytes = std::fs::read(path).map_err(|_| CHANGED.to_string())?;
    if sha256_hex(&bytes).eq_ignore_ascii_case(sha256.trim()) {
        Ok(())
    } else {
        Err(CHANGED.into())
    }
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// Whether `candidate` is a newer release than `current`.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// The download URL must be this repository's immutable release asset.
pub fn validate_apk_url(url: &str) -> Result<(), String> {
    if FEED_OVERRIDE.is_some() && url.ends_with(".apk") {
        return Ok(());
    }
    let prefix = format!("https://github.com/{REPO}/releases/download/v");
    if url.starts_with(&prefix) && url.ends_with(".apk") {
        Ok(())
    } else {
        Err(format!("Refusing an update from an unexpected URL: {url}"))
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// ── Commands ───────────────────────────────────────────────────────────────

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn status(app: &AppHandle, kind: &str) -> UpdateStatus {
    UpdateStatus {
        status: kind.into(),
        current_version: current_version(app),
        ..Default::default()
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("OpenAgentd mobile updater")
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))
}

/// Marks a feed that does not exist (yet): not an error for the user.
const NO_FEED: &str = "no-feed";

async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let response = client()?
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Could not reach the update feed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(NO_FEED.into());
    }
    response
        .error_for_status()
        .map_err(|e| format!("Could not reach the update feed: {e}"))?
        .json::<T>()
        .await
        .map_err(|e| format!("Could not read the update feed: {e}"))
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    request: Option<UpdateStatusRequest>,
) -> Result<UpdateStatus, String> {
    let _ = request;
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Ok(UpdateStatus {
            message: Some("TestFlight and the App Store keep OpenAgentd up to date.".into()),
            ..status(&app, "up_to_date")
        })
    }
    #[cfg(target_os = "android")]
    android_check(app, state).await
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn android_check(app: AppHandle, state: State<'_, UpdaterState>) -> Result<UpdateStatus, String> {
    let current = current_version(&app);
    let manifest: AndroidManifest = match fetch_json(FEED_OVERRIDE.unwrap_or(ANDROID_FEED)).await {
        Ok(manifest) => manifest,
        // Before the first release with a feed, say so instead of failing.
        Err(e) if e == NO_FEED => {
            return Ok(UpdateStatus {
                message: Some("No update has been published for this app yet.".into()),
                ..status(&app, "up_to_date")
            })
        }
        Err(e) => return Err(e),
    };
    validate_apk_url(&manifest.url)?;
    if !is_newer(&manifest.version, &current) {
        state.record_check(None);
        return Ok(status(&app, "up_to_date"));
    }
    let (version, notes) = (manifest.version.clone(), manifest.notes.clone());
    state.record_check(Some(manifest));
    Ok(UpdateStatus {
        version: Some(version),
        notes,
        channel: Some("apk".into()),
        ..status(&app, "available")
    })
}

#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<UpdateStatus, String> {
    let ticket = state.inner().begin_download()?;
    let manifest = ticket.manifest.clone();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cache dir: {e}"))?
        .join("updates");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let path = dir.join(ticket.file_name(stamp));
    let bytes = download(&app, &manifest).await?;
    let digest = sha256_hex(&bytes);
    if !digest.eq_ignore_ascii_case(manifest.sha256.trim()) {
        return Err("The download is corrupt (checksum mismatch). Try again.".into());
    }
    // Until publish, the previous download stays selected and on disk, so a
    // failed re-download leaves it installable.
    let (write_dir, write_path) = (dir.clone(), path.clone());
    tauri::async_runtime::spawn_blocking(move || write_apk(&write_dir, &write_path, &bytes))
        .await
        .map_err(|e| format!("Write task failed: {e}"))??;

    // `ticket` stays held through the cleanup below, so no other download
    // starts until this one's file is published or removed.
    if !ticket.publish(path.clone()) {
        let _ = std::fs::remove_file(&path);
        return Err("A newer check replaced this update. Download it again.".into());
    }
    // Drop APKs of earlier updates, except any an install still uses.
    let keep = state.protected();
    let _ = tauri::async_runtime::spawn_blocking(move || remove_other_apks(&dir, &keep)).await;
    drop(ticket);
    let version = manifest.version.clone();
    let notes = manifest.notes.clone();
    Ok(UpdateStatus {
        version: Some(version),
        notes,
        channel: Some("apk".into()),
        ..status(&app, "downloaded")
    })
}

async fn download(app: &AppHandle, manifest: &AndroidManifest) -> Result<Vec<u8>, String> {
    validate_apk_url(&manifest.url)?;
    let mut response = client()?
        .get(&manifest.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = response.content_length().or(manifest.size);
    if total.is_some_and(|t| t > MAX_APK_BYTES) {
        return Err("The update is larger than expected; refusing it.".into());
    }
    let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut last = Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_APK_BYTES {
            return Err("The update is larger than expected; refusing it.".into());
        }
        if last.elapsed() >= PROGRESS_EVERY {
            last = Instant::now();
            let _ = app.emit(
                "updater-status",
                UpdateStatus {
                    version: Some(manifest.version.clone()),
                    downloaded_bytes: Some(bytes.len() as u64),
                    total_bytes: total,
                    channel: Some("apk".into()),
                    ..status(app, "downloading")
                },
            );
        }
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn updater_install(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let Some(ticket) = state.inner().begin_install()? else {
        // Another tap is already opening the installer.
        return Ok(());
    };
    // Re-check the bytes the installer will read: the cache is ours, but
    // only the download that matched the feed's SHA-256 may be installed.
    let (path, sha256) = (ticket.path.clone(), ticket.sha256.clone());
    let checked = tauri::async_runtime::spawn_blocking(move || check_apk(&path, &sha256))
        .await
        .map_err(|e| format!("Install task failed: {e}"))?;
    if let Err(e) = checked {
        ticket.discard();
        return Err(e);
    }
    install_apk(&app, ticket.path.clone()).await?;
    ticket.handed_off();
    Ok(())
}

#[cfg(target_os = "android")]
async fn install_apk(app: &AppHandle, path: PathBuf) -> Result<(), String> {
    use tauri_plugin_openagentd_android::AndroidShellExt;
    let app = app.clone();
    let path = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || app.android_shell().install_apk(&path))
        .await
        .map_err(|e| format!("Install task failed: {e}"))?
}

#[cfg(not(target_os = "android"))]
async fn install_apk(_app: &AppHandle, _path: PathBuf) -> Result<(), String> {
    Err("APK updates only install on Android.".into())
}

#[derive(Serialize)]
pub struct ReleaseNotesResponse {
    pub version: String,
    pub url: String,
    pub body: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    html_url: String,
    body: Option<String>,
}

#[tauri::command]
pub async fn updater_release_notes(version: String) -> Result<ReleaseNotesResponse, String> {
    let tag = if version.starts_with('v') { version.clone() } else { format!("v{version}") };
    let release: GitHubRelease =
        fetch_json(&format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}"))
            .await
            .map_err(|e| if e == NO_FEED { format!("No release notes for {tag}.") } else { e })?;
    Ok(ReleaseNotesResponse {
        version,
        url: release.html_url,
        body: release
            .body
            .unwrap_or_else(|| "No release notes published for this version.".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_compares_numerically() {
        assert!(is_newer("3.49.0", "3.48.9"));
        assert!(is_newer("3.10.0", "3.9.0"));
        assert!(is_newer("v4.0.0", "3.99.99"));
        assert!(!is_newer("3.49.0", "3.49.0"));
        assert!(!is_newer("3.48.0", "3.49.0"));
        assert!(!is_newer("garbage", "3.49.0"));
    }

    #[test]
    fn only_this_repositorys_release_apks_are_accepted() {
        assert!(validate_apk_url(
            "https://github.com/lthoangg/openagentd/releases/download/v3.49.0/OpenAgentd_3.49.0_Android.apk"
        )
        .is_ok());
        assert!(validate_apk_url("https://evil.example/OpenAgentd.apk").is_err());
        assert!(validate_apk_url(
            "https://github.com/lthoangg/openagentd/releases/download/latest-android/x.apk"
        )
        .is_err());
        assert!(validate_apk_url("http://github.com/lthoangg/openagentd/releases/download/v1/a.apk").is_err());
    }

    #[test]
    fn sha256_matches_known_digest() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn android_manifest_parses_the_published_shape() {
        let m: AndroidManifest = serde_json::from_str(
            r#"{"version":"3.49.0","pub_date":"2026-11-07T00:00:00Z","notes":"n","url":"https://x/a.apk","sha256":"ab","size":3}"#,
        )
        .unwrap();
        assert_eq!(m.version, "3.49.0");
        assert_eq!(m.size, Some(3));
    }

    fn manifest(version: &str, sha256: &str) -> AndroidManifest {
        AndroidManifest {
            version: version.into(),
            notes: None,
            url: format!("https://github.com/{REPO}/releases/download/v{version}/a.apk"),
            sha256: sha256.into(),
            size: None,
        }
    }

    /// The APK an install would get, releasing the install right away.
    fn install_path(state: &UpdaterState) -> Result<PathBuf, String> {
        state.begin_install().map(|ticket| ticket.expect("no install running").path.clone())
    }

    #[test]
    fn a_published_download_is_what_install_uses() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let ticket = state.begin_download().unwrap();
        assert_eq!(ticket.manifest.version, "3.49.0");
        assert!(ticket.publish(PathBuf::from("/c/3.49.0.apk")));
        assert_eq!(install_path(&state).unwrap(), PathBuf::from("/c/3.49.0.apk"));
    }

    #[test]
    fn a_newer_check_rejects_the_older_download() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let ticket = state.begin_download().unwrap();
        state.record_check(Some(manifest("3.50.0", "bb")));
        assert!(!ticket.publish(PathBuf::from("/c/3.49.0.apk")));
        assert_eq!(
            install_path(&state).unwrap_err(),
            "Download the update before installing it."
        );
    }

    #[test]
    fn a_changed_digest_for_the_same_version_rejects_the_older_download() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let ticket = state.begin_download().unwrap();
        state.record_check(Some(manifest("3.49.0", "bb")));
        assert!(!ticket.publish(PathBuf::from("/c/3.49.0.apk")));
        assert!(install_path(&state).is_err());
    }

    #[test]
    fn an_up_to_date_check_rejects_the_running_download() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let ticket = state.begin_download().unwrap();
        state.record_check(None);
        assert!(!ticket.publish(PathBuf::from("/c/3.49.0.apk")));
        assert_eq!(
            install_path(&state).unwrap_err(),
            "No update found. Check for updates first."
        );
    }

    #[test]
    fn rechecking_the_same_release_keeps_the_download() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let ticket = state.begin_download().unwrap();
        state.record_check(Some(manifest("3.49.0", "aa")));
        assert!(ticket.publish(PathBuf::from("/c/3.49.0.apk")));
        state.record_check(Some(manifest("3.49.0", "aa")));
        assert_eq!(install_path(&state).unwrap(), PathBuf::from("/c/3.49.0.apk"));
    }

    #[test]
    fn one_download_runs_at_a_time_and_a_failed_one_frees_the_slot() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let ticket = state.begin_download().unwrap();
        assert_eq!(
            state.begin_download().err().unwrap(),
            "The update is already downloading."
        );
        drop(ticket); // download failed or was cancelled
        assert!(state.begin_download().is_ok());
    }

    #[test]
    fn downloading_needs_a_check_first() {
        let state = UpdaterState::default();
        assert_eq!(
            state.begin_download().err().unwrap(),
            "No update to download. Check for updates first."
        );
        assert_eq!(
            install_path(&state).unwrap_err(),
            "No update found. Check for updates first."
        );
    }

    // ── Files: what a download, a stale download and an install leave ──────

    fn apk(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        write_apk(dir, &path, bytes).unwrap();
        path
    }

    #[test]
    fn every_download_writes_its_own_file() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let first = state.begin_download().unwrap().file_name(7);
        let second = state.begin_download().unwrap().file_name(7);
        assert_ne!(first, second, "a retry of the same version never reuses a path");
        assert!(first.starts_with("OpenAgentd_3.49.0_") && first.ends_with(".apk"));
    }

    #[test]
    fn a_stale_download_removes_only_its_own_file_while_it_still_holds_the_slot() {
        let dir = tempfile::tempdir().unwrap();
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let stale = state.begin_download().unwrap();
        let stale_path = apk(dir.path(), &stale.file_name(1), b"old");
        state.record_check(Some(manifest("3.49.0", "bb"))); // same version, new build

        assert!(!stale.publish(stale_path.clone()));
        assert_eq!(
            state.begin_download().err().unwrap(),
            "The update is already downloading.",
            "no newer download can start until the stale one cleaned up"
        );
        std::fs::remove_file(&stale_path).unwrap();
        drop(stale);

        let fresh = state.begin_download().unwrap();
        let fresh_path = apk(dir.path(), &fresh.file_name(1), b"new");
        assert_ne!(fresh_path, stale_path);
        assert!(fresh.publish(fresh_path.clone()));
        assert!(fresh_path.is_file());
        assert_eq!(install_path(&state).unwrap(), fresh_path);
    }

    #[test]
    fn a_failed_re_download_leaves_the_previous_apk_installable() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"apk v1";
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", &sha256_hex(bytes))));
        let first = state.begin_download().unwrap();
        let first_path = apk(dir.path(), &first.file_name(1), bytes);
        assert!(first.publish(first_path.clone()));
        drop(first);

        drop(state.begin_download().unwrap()); // network error, nothing written

        let install = state.begin_install().unwrap().unwrap();
        assert_eq!(install.path, first_path);
        assert!(check_apk(&install.path, &install.sha256).is_ok());
    }

    #[test]
    fn cleanup_after_a_download_keeps_every_apk_still_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let handed = apk(dir.path(), "handed.apk", b"1");
        let installing = apk(dir.path(), "installing.apk", b"2");
        let leftover = apk(dir.path(), "OpenAgentd_3.48.0.apk", b"0");
        {
            let mut s = state.lock();
            s.handed_off = Some(handed.clone());
            s.installing = Some(installing.clone());
        }
        let download = state.begin_download().unwrap();
        let new = apk(dir.path(), &download.file_name(1), b"3");
        assert!(download.publish(new.clone()));

        remove_other_apks(dir.path(), &state.protected());

        assert!(new.is_file(), "the new download");
        assert!(installing.is_file(), "the APK an install is checking");
        assert!(handed.is_file(), "the APK the system installer may still read");
        assert!(!leftover.exists(), "an earlier update's APK");
    }

    #[test]
    fn an_install_keeps_its_apk_from_a_download_that_finishes_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"apk v1";
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", &sha256_hex(bytes))));
        let first = state.begin_download().unwrap();
        let first_path = apk(dir.path(), &first.file_name(1), bytes);
        assert!(first.publish(first_path.clone()));
        drop(first);
        let install = state.begin_install().unwrap().unwrap();

        let again = state.begin_download().unwrap();
        let again_path = apk(dir.path(), &again.file_name(1), bytes);
        assert!(again.publish(again_path.clone()));
        remove_other_apks(dir.path(), &state.protected());
        drop(again);

        assert!(check_apk(&install.path, &install.sha256).is_ok(), "the install's bytes are untouched");
        install.handed_off();
        remove_other_apks(dir.path(), &state.protected());
        assert!(first_path.is_file(), "the installer may still be reading it");
    }

    #[test]
    fn one_install_at_a_time() {
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", "aa")));
        let download = state.begin_download().unwrap();
        assert!(download.publish(PathBuf::from("/c/a.apk")));
        drop(download);

        let install = state.begin_install().unwrap().expect("first install");
        assert!(state.begin_install().unwrap().is_none(), "a second tap does not open a second installer");
        drop(install); // the installer failed to open
        assert!(state.begin_install().unwrap().is_some());
    }

    #[test]
    fn an_apk_that_changed_on_disk_is_not_installed_and_is_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let state = UpdaterState::default();
        state.record_check(Some(manifest("3.49.0", &sha256_hex(b"verified"))));
        let download = state.begin_download().unwrap();
        let path = apk(dir.path(), &download.file_name(1), b"verified");
        assert!(download.publish(path.clone()));
        drop(download);
        std::fs::write(&path, b"tampered").unwrap();

        let install = state.begin_install().unwrap().unwrap();
        assert_eq!(
            check_apk(&install.path, &install.sha256).unwrap_err(),
            "The downloaded update is missing or changed. Download it again."
        );
        install.discard();

        assert_eq!(install_path(&state).unwrap_err(), "Download the update before installing it.");
    }

    #[test]
    fn a_missing_apk_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check_apk(&dir.path().join("gone.apk"), &sha256_hex(b"x")).is_err());
    }

    #[test]
    fn a_write_that_cannot_create_the_folder_fails_and_leaves_no_apk() {
        let dir = tempfile::tempdir().unwrap();
        let not_a_dir = apk(dir.path(), "file", b"x");
        let path = not_a_dir.join("a.apk");
        assert!(write_apk(&not_a_dir, &path, b"apk").is_err());
        assert!(!path.exists());
    }
}
