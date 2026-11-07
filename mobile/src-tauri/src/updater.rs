//! In-app updates for the mobile shell.
//!
//! The commands share their names and `UpdateStatus` shape with the desktop
//! updater, so the web UI (`web/src/lib/updater.ts`) drives both:
//!
//! * **Android**: `updater_check` reads `latest.json` from the rolling
//!   `latest-android` release (written by `mobile/scripts/publish-apk.sh`),
//!   `updater_download` fetches the APK into the cache directory and checks
//!   its SHA-256, and `updater_install` hands it to the system installer.
//!   Android only installs it over the app when the signing key matches.
//! * **iOS**: apps cannot install their own updates, and one binary ships to
//!   TestFlight and then, unchanged, to the App Store. So the channel is read
//!   at run time from the bundle (`ios_channel`): an App Store copy never
//!   checks (the App Store updates it, and App Review rejects pointers to
//!   other installers), a development build has nothing to update from, and
//!   a TestFlight copy compares itself with the server's version, which the
//!   web UI passes in, and `updater_install` opens TestFlight.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const REPO: &str = "lthoangg/openagentd";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ANDROID_FEED: &str =
    "https://github.com/lthoangg/openagentd/releases/download/latest-android/latest.json";
const TESTFLIGHT_URL: &str = "itms-beta://";
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
    /// `apk` on Android; `testflight`, `appstore` or `dev` on iOS.
    pub channel: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateStatusRequest {
    #[allow(dead_code)]
    pub silent: Option<bool>,
    /// The connected server's version: a TestFlight copy older than its
    /// server offers the update.
    #[allow(dead_code)]
    pub server_version: Option<String>,
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
#[cfg_attr(target_os = "android", allow(dead_code))]
enum Found {
    Android { manifest: AndroidManifest, path: Option<PathBuf> },
    Ios,
}

#[derive(Default)]
pub struct UpdaterState(Mutex<Option<Found>>);

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

/// How this iOS copy was installed. TestFlight names its receipt
/// `sandboxReceipt` (the receipt file itself may not exist yet, so only the
/// URL's name counts), a development install embeds its provisioning
/// profile, and an App Store copy has neither (Apple strips the profile).
/// Unknown shapes count as the App Store, which shows no update notice.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn ios_channel(receipt_name: Option<&str>, app_dir: &std::path::Path) -> &'static str {
    if receipt_name == Some("sandboxReceipt") {
        "testflight"
    } else if app_dir.join("embedded.mobileprovision").is_file() {
        "dev"
    } else {
        "appstore"
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

/// What an iOS copy on `channel` reports, given the connected server's
/// version: `(status, newer version, message)`.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn ios_check(
    channel: &str,
    current: &str,
    server_version: Option<&str>,
) -> (&'static str, Option<String>, Option<&'static str>) {
    match channel {
        "testflight" => match server_version {
            Some(server) if is_newer(server, current) => ("available", Some(server.to_string()), None),
            _ => ("up_to_date", None, None),
        },
        "dev" => ("up_to_date", None, Some("This is a development build, so it does not check for updates.")),
        _ => ("up_to_date", None, Some("The App Store keeps OpenAgentd up to date.")),
    }
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    request: Option<UpdateStatusRequest>,
) -> Result<UpdateStatus, String> {
    #[cfg(not(target_os = "android"))]
    {
        let channel = updater_channel();
        let server = request.and_then(|r| r.server_version);
        let current = current_version(&app);
        let (kind, version, message) = ios_check(channel, &current, server.as_deref());
        *state.0.lock().unwrap() = version.clone().map(|_| Found::Ios);
        Ok(UpdateStatus {
            version,
            message: message.map(str::to_string),
            channel: Some(channel.to_string()),
            ..status(&app, kind)
        })
    }
    #[cfg(target_os = "android")]
    {
        let _ = request;
        android_check(app, state).await
    }
}

/// `apk` on Android; on iOS how this copy was installed (`ios_channel`).
#[tauri::command]
pub fn updater_channel() -> &'static str {
    #[cfg(target_os = "android")]
    {
        "apk"
    }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(target_os = "ios")]
        let receipt = ios_receipt_name();
        #[cfg(not(target_os = "ios"))]
        let receipt: Option<String> = None;
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| ios_channel(receipt.as_deref(), dir)))
            .unwrap_or("appstore")
    }
}

/// The last path component of the bundle's App Store receipt URL.
#[cfg(target_os = "ios")]
#[allow(deprecated)] // appStoreReceiptURL: deprecated for StoreKit 2 but still answers.
fn ios_receipt_name() -> Option<String> {
    use objc2_foundation::NSBundle;
    let url = NSBundle::mainBundle().appStoreReceiptURL()?;
    Some(url.lastPathComponent()?.to_string())
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
        *state.0.lock().unwrap() = None;
        return Ok(status(&app, "up_to_date"));
    }
    let (version, notes) = (manifest.version.clone(), manifest.notes.clone());
    *state.0.lock().unwrap() = Some(Found::Android { manifest, path: None });
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
    let found = state.0.lock().unwrap().clone();
    let Some(Found::Android { manifest, .. }) = found else {
        return Err("No update to download. Check for updates first.".into());
    };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cache dir: {e}"))?
        .join("updates");
    let path = dir.join(format!("OpenAgentd_{}.apk", manifest.version));
    let bytes = download(&app, &manifest).await?;
    let digest = sha256_hex(&bytes);
    if !digest.eq_ignore_ascii_case(manifest.sha256.trim()) {
        return Err("The download is corrupt (checksum mismatch). Try again.".into());
    }
    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Drop APKs of earlier updates.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Create {}: {e}", dir.display()))?;
        std::fs::write(&write_path, &bytes).map_err(|e| format!("Write update: {e}"))
    })
    .await
    .map_err(|e| format!("Write task failed: {e}"))??;

    let version = manifest.version.clone();
    let notes = manifest.notes.clone();
    *state.0.lock().unwrap() = Some(Found::Android { manifest, path: Some(path) });
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
    let found = state.0.lock().unwrap().clone();
    match found {
        Some(Found::Android { path: Some(path), .. }) => install_apk(&app, path).await,
        Some(Found::Android { path: None, .. }) => {
            Err("Download the update before installing it.".into())
        }
        Some(Found::Ios) => {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(TESTFLIGHT_URL, None::<&str>)
                .map_err(|e| format!("Could not open the App Store app: {e}"))
        }
        None => Err("No update found. Check for updates first.".into()),
    }
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
    fn ios_channel_reads_the_bundle() {
        let dir = std::env::temp_dir().join(format!("oad-channel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(ios_channel(None, &dir), "appstore");
        assert_eq!(ios_channel(Some("receipt"), &dir), "appstore");
        std::fs::write(dir.join("embedded.mobileprovision"), b"x").unwrap();
        assert_eq!(ios_channel(Some("receipt"), &dir), "dev");
        assert_eq!(ios_channel(Some("sandboxReceipt"), &dir), "testflight");
        std::fs::remove_file(dir.join("embedded.mobileprovision")).unwrap();
        assert_eq!(ios_channel(Some("sandboxReceipt"), &dir), "testflight");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_testflight_offers_an_update_from_a_newer_server() {
        assert_eq!(ios_check("testflight", "3.49.0", Some("3.50.0")), ("available", Some("3.50.0".into()), None));
        assert_eq!(ios_check("testflight", "3.49.0", Some("3.49.0")).0, "up_to_date");
        assert_eq!(ios_check("testflight", "3.49.0", None).0, "up_to_date");
        let (kind, version, message) = ios_check("appstore", "3.49.0", Some("9.0.0"));
        assert_eq!((kind, version), ("up_to_date", None));
        assert!(!message.unwrap().contains("TestFlight"));
        assert_eq!(ios_check("dev", "3.49.0", Some("9.0.0")).0, "up_to_date");
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
}
