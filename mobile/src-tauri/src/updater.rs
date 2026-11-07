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
//! * **iOS**: apps cannot install their own updates. `updater_check` reads
//!   the SideStore source feed on `latest-ios` (both the TestFlight and the
//!   SideStore builds come from the same release), and `updater_install`
//!   opens TestFlight. A copy SideStore installed is told, every check, that
//!   OpenAgentd has moved to TestFlight, and the button opens the iOS
//!   download page instead.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const REPO: &str = "lthoangg/openagentd";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ANDROID_FEED: &str =
    "https://github.com/lthoangg/openagentd/releases/download/latest-android/latest.json";
#[cfg_attr(target_os = "android", allow(dead_code))]
const IOS_FEED: &str =
    "https://github.com/lthoangg/openagentd/releases/download/latest-ios/source.json";
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const TESTFLIGHT_URL: &str = "itms-beta://";
/// Where a SideStore copy is sent: the iOS page links the TestFlight beta.
#[cfg_attr(target_os = "android", allow(dead_code))]
const MOVED_TO_TESTFLIGHT_URL: &str = "https://openagentd.dev/download/ios/";
#[cfg_attr(target_os = "android", allow(dead_code))]
const MOVED_TO_TESTFLIGHT_MESSAGE: &str = "OpenAgentd for iPhone and iPad now comes from TestFlight, and SideStore copies get no more updates. Install it from TestFlight, then delete this copy; your sessions live on your server.";
/// Build-time override of the Android feed, for testing an update end to
/// end against a local server. Release builds never set it; when set, the
/// APK URL check only requires an `.apk` path.
const FEED_OVERRIDE: Option<&str> = option_env!("OAD_UPDATER_FEED_URL");
/// The same for the iOS source feed.
#[cfg_attr(target_os = "android", allow(dead_code))]
const IOS_FEED_OVERRIDE: Option<&str> = option_env!("OAD_UPDATER_IOS_FEED_URL");
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
    /// `apk`, `testflight`, or `sidestore`.
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
#[cfg_attr(target_os = "android", allow(dead_code))]
enum Found {
    Android { manifest: AndroidManifest, path: Option<PathBuf> },
    Ios { version: String, open_url: String },
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

/// Newest version and its notes from an AltStore/SideStore source feed.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn ios_latest(source: &serde_json::Value) -> Option<(String, Option<String>)> {
    let versions = source.get("apps")?.get(0)?.get("versions")?.as_array()?;
    versions
        .iter()
        .filter_map(|v| {
            let version = v.get("version")?.as_str()?.to_string();
            parse_version(&version)?;
            let notes = v.get("localizedDescription").and_then(|n| n.as_str()).map(str::to_string);
            Some((version, notes))
        })
        .max_by_key(|(v, _)| parse_version(v))
}

/// SideStore/AltStore add `ALTDeviceID` to the Info.plist of apps they sign.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn installed_by_sidestore(info_plist: &[u8]) -> bool {
    info_plist.windows(b"ALTDeviceID".len()).any(|w| w == b"ALTDeviceID")
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
    let current = current_version(&app);
    let found = match check_feed().await {
        Ok(found) => found,
        // Before the first release with a feed, say so instead of failing.
        Err(e) if e == NO_FEED => {
            return Ok(UpdateStatus {
                message: Some("No update has been published for this app yet.".into()),
                ..status(&app, "up_to_date")
            })
        }
        Err(e) => return Err(e),
    };
    let (version, notes, channel) = match &found {
        Found::Android { manifest, .. } => {
            (manifest.version.clone(), manifest.notes.clone(), "apk".to_string())
        }
        Found::Ios { version, open_url } => {
            let channel = if open_url == MOVED_TO_TESTFLIGHT_URL { "sidestore" } else { "testflight" };
            (version.clone(), None, channel.to_string())
        }
    };
    // SideStore copies always see the move, whatever the version.
    if channel == "sidestore" {
        *state.0.lock().unwrap() = Some(found);
        return Ok(UpdateStatus {
            version: Some(version),
            channel: Some(channel),
            message: Some(MOVED_TO_TESTFLIGHT_MESSAGE.into()),
            ..status(&app, "available")
        });
    }
    if !is_newer(&version, &current) {
        *state.0.lock().unwrap() = None;
        return Ok(status(&app, "up_to_date"));
    }
    *state.0.lock().unwrap() = Some(found);
    Ok(UpdateStatus {
        version: Some(version),
        notes,
        channel: Some(channel),
        ..status(&app, "available")
    })
}

#[cfg(target_os = "android")]
async fn check_feed() -> Result<Found, String> {
    let manifest: AndroidManifest = fetch_json(FEED_OVERRIDE.unwrap_or(ANDROID_FEED)).await?;
    validate_apk_url(&manifest.url)?;
    Ok(Found::Android { manifest, path: None })
}

#[cfg(not(target_os = "android"))]
async fn check_feed() -> Result<Found, String> {
    let source: serde_json::Value = fetch_json(IOS_FEED_OVERRIDE.unwrap_or(IOS_FEED)).await?;
    let (version, _notes) =
        ios_latest(&source).ok_or("The update feed lists no versions")?;
    let sidestore = std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::read(exe.parent()?.join("Info.plist")).ok())
        .is_some_and(|plist| installed_by_sidestore(&plist));
    let open_url = if sidestore {
        MOVED_TO_TESTFLIGHT_URL.to_string()
    } else {
        TESTFLIGHT_URL.to_string()
    };
    Ok(Found::Ios { version, open_url })
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
        Some(Found::Ios { open_url, .. }) => {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(open_url, None::<&str>)
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
    fn ios_latest_picks_the_highest_version() {
        let source = serde_json::json!({"apps": [{"versions": [
            {"version": "3.48.0", "localizedDescription": "old"},
            {"version": "3.49.0", "localizedDescription": "new"},
            {"version": "not-a-version"}
        ]}]});
        assert_eq!(ios_latest(&source), Some(("3.49.0".into(), Some("new".into()))));
        assert_eq!(ios_latest(&serde_json::json!({"apps": []})), None);
    }

    #[test]
    fn sidestore_is_detected_from_info_plist() {
        assert!(installed_by_sidestore(b"<key>ALTDeviceID</key><string>x</string>"));
        assert!(!installed_by_sidestore(b"<key>CFBundleIdentifier</key>"));
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
