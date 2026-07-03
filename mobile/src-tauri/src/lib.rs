use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_FILENAME_COLLISION_ATTEMPTS: usize = 1000;

#[derive(Clone, Serialize, Deserialize)]
struct SavedAppServer {
    base_url: String,
    name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct AppBackendConfig {
    active_base_url: Option<String>,
    servers: Vec<SavedAppServer>,
}

#[derive(Clone, Serialize)]
struct AppBackendStatus {
    base_url: String,
    sidecar_running: bool,
    external: bool,
    supports_bundled: bool,
    servers: Vec<SavedAppServer>,
}

impl Default for AppBackendConfig {
    fn default() -> Self {
        Self {
            active_base_url: None,
            servers: vec![SavedAppServer {
                base_url: "http://127.0.0.1:4082".to_string(),
                name: Some("Local CLI server".to_string()),
            }],
        }
    }
}

#[tauri::command]
fn app_backend_status(app: AppHandle) -> Result<AppBackendStatus, String> {
    let config = load_backend_config(&app).map_err(|e| format!("{e:#}"))?;
    Ok(AppBackendStatus {
        base_url: config.active_base_url.unwrap_or_default(),
        sidecar_running: false,
        external: true,
        supports_bundled: false,
        servers: config.servers,
    })
}

#[tauri::command]
fn app_save_backend_server(app: AppHandle, base_url: String, name: Option<String>) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    save_backend_config(&app, Some(&normalized), normalize_server_name(name).as_deref())
        .map_err(|e| format!("{e:#}"))?;
    app_backend_status(app)
}

#[tauri::command]
fn app_use_external_backend(app: AppHandle, base_url: String, name: Option<String>, persist: Option<bool>) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    if persist.unwrap_or(true) {
        save_backend_config(&app, Some(&normalized), normalize_server_name(name).as_deref())
            .map_err(|e| format!("{e:#}"))?;
    }
    app_backend_status(app)
}

#[tauri::command]
fn app_remove_backend_server(app: AppHandle, base_url: String) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    remove_backend_server(&app, &normalized).map_err(|e| format!("{e:#}"))?;
    app_backend_status(app)
}

fn normalize_base_url(base_url: &str) -> Result<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("base URL is required"));
    }
    let parsed = url::Url::parse(trimmed).context("parse base URL")?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        scheme => Err(anyhow!("unsupported URL scheme: {scheme}")),
    }
}

fn normalize_server_name(name: Option<String>) -> Option<String> {
    name.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("resolve app config directory")?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir.join("app-backend.json"))
}

fn load_backend_config(app: &AppHandle) -> Result<AppBackendConfig> {
    let path = config_path(app)?;
    load_backend_config_from(&path)
}

fn save_backend_config(app: &AppHandle, base_url: Option<&str>, name: Option<&str>) -> Result<()> {
    let path = config_path(app)?;
    save_backend_config_to(&path, base_url, name)
}

fn load_backend_config_from(path: &std::path::Path) -> Result<AppBackendConfig> {
    if !path.exists() {
        return Ok(AppBackendConfig::default());
    }
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut config: AppBackendConfig =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    if config.servers.is_empty() {
        config.servers = AppBackendConfig::default().servers;
    }
    Ok(config)
}

fn save_backend_config_to(path: &std::path::Path, base_url: Option<&str>, name: Option<&str>) -> Result<()> {
    let mut config = load_backend_config_from(path).unwrap_or_default();
    config.active_base_url = base_url.map(str::to_string);
    if let Some(url) = base_url {
        if let Some(saved) = config.servers.iter_mut().find(|saved| saved.base_url == url) {
            if let Some(name) = name {
                saved.name = Some(name.to_string());
            }
        } else {
            config.servers.push(SavedAppServer {
                base_url: url.to_string(),
                name: name.map(str::to_string),
            });
        }
    }
    let bytes = serde_json::to_vec_pretty(&config).context("serialize backend config")?;
    std::fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

fn remove_backend_server(app: &AppHandle, base_url: &str) -> Result<()> {
    let path = config_path(app)?;
    remove_backend_server_at(&path, base_url)
}

fn remove_backend_server_at(path: &std::path::Path, base_url: &str) -> Result<()> {
    let mut config = load_backend_config_from(path).unwrap_or_default();
    config.servers.retain(|server| server.base_url != base_url);
    if config.active_base_url.as_deref() == Some(base_url) {
        config.active_base_url = None;
    }
    if config.servers.is_empty() {
        config.servers = AppBackendConfig::default().servers;
    }
    let bytes = serde_json::to_vec_pretty(&config).context("serialize backend config")?;
    std::fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

fn ensure_max_download_size(size: usize) -> Result<()> {
    if size > MAX_DOWNLOAD_BYTES {
        Err(anyhow!("File exceeds 100 MB limit"))
    } else {
        Ok(())
    }
}

fn ensure_content_length_limit(content_length: Option<u64>) -> Result<()> {
    if let Some(length) = content_length {
        let length = usize::try_from(length).map_err(|_| anyhow!("File exceeds 100 MB limit"))?;
        ensure_max_download_size(length)?;
    }
    Ok(())
}

fn unique_cache_path(dir: &Path, filename: &str) -> Result<PathBuf> {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return Ok(candidate);
    }

    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or(filename);
    let ext = path.extension().and_then(|value| value.to_str());

    for index in 1..=MAX_FILENAME_COLLISION_ATTEMPTS {
        let candidate_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem} ({index}).{ext}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = dir.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(anyhow!("Could not find a unique filename after 1000 attempts"))
}

#[derive(Deserialize)]
struct SaveWorkspaceFileRequest {
    /// Pre-encoded base64 payload (used by FileLightbox which already has the blob).
    base64: Option<String>,
    /// Remote URL to fetch (used by workspace-download helpers).
    url: Option<String>,
    filename: String,
}

#[tauri::command]
async fn save_workspace_file(
    app: AppHandle,
    request: SaveWorkspaceFileRequest,
) -> Result<bool, String> {
    let filename = Path::new(&request.filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download")
        .to_string();

    // Resolve the file bytes: base64 payload, data: URI, or remote URL fetch.
    let bytes: Vec<u8> = match (request.base64, request.url) {
        (Some(b64), _) => {
            use base64::Engine;
            let bytes = base64::prelude::BASE64_STANDARD
                .decode(&b64)
                .map_err(|e| format!("Decode base64: {e}"))?;
            ensure_max_download_size(bytes.len()).map_err(|e| format!("Decode base64: {e}"))?;
            bytes
        }
        (None, Some(url)) if url.starts_with("data:") => {
            // data:<mime>;base64,<payload>
            use base64::Engine;
            let payload = url
                .split_once(',')
                .map(|(_, payload)| payload)
                .ok_or("Invalid data URI: missing comma")?;
            let bytes = base64::prelude::BASE64_STANDARD
                .decode(payload)
                .map_err(|e| format!("Decode data URI: {e}"))?;
            ensure_max_download_size(bytes.len()).map_err(|e| format!("Decode data URI: {e}"))?;
            bytes
        }
        (None, Some(url)) => {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| format!("Fetch file: {e}"))?;
            let mut response = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("Fetch file: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Fetch file: {e}"))?;
            ensure_content_length_limit(response.content_length())
                .map_err(|e| format!("Fetch file: {e}"))?;

            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| format!("Read fetched file: {e}"))?
            {
                let new_len = bytes
                    .len()
                    .checked_add(chunk.len())
                    .ok_or_else(|| "Read fetched file: File exceeds 100 MB limit".to_string())?;
                ensure_max_download_size(new_len)
                    .map_err(|e| format!("Read fetched file: {e}"))?;
                bytes.extend_from_slice(&chunk);
            }
            bytes
        }
        (None, None) => return Err("save_workspace_file: must supply either base64 or url".to_string()),
    };

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Get cache dir: {e}"))?;
    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("Create cache dir {}", cache_dir.display()))
        .map_err(|e| format!("{e:#}"))?;
    let path = unique_cache_path(&cache_dir, &filename).map_err(|e| format!("{e}"))?;

    std::fs::write(&path, &bytes)
        .with_context(|| format!("Write {}", path.display()))
        .map_err(|e| format!("{e:#}"))?;

    #[cfg(target_os = "ios")]
    {
        // `share_file_ios` must run on the main thread (UIKit requirement).
        // Tauri async commands run on a background thread, so we dispatch
        // synchronously to the main queue and wait for the result.
        let path_str = path.to_string_lossy().into_owned();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        dispatch_main(move || {
            let _ = tx.send(share_file_ios(&path_str));
        });
        rx.recv().map_err(|_| "Main thread dispatch failed".to_string())??;
    }

    #[cfg(not(target_os = "ios"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(path.to_string_lossy().to_string(), None::<String>)
            .map_err(|e| format!("Open file: {e}"))?;
    }

    Ok(true)
}

/// Dispatch a closure synchronously on the main GCD queue and wait for it.
/// Required for all UIKit calls made from a background thread.
#[cfg(target_os = "ios")]
fn dispatch_main<F: FnOnce() + Send + 'static>(f: F) {
    dispatch2::DispatchQueue::main().exec_sync(f);
}

#[cfg(target_os = "ios")]
fn share_file_ios(path: &str) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::MainThreadOnly;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use objc2_ui_kit::{
        UIActivityViewController, UIApplication, UIPopoverArrowDirection,
        UIViewController, UIWindowScene,
    };

    unsafe {
        // Build file URL and wrap as AnyObject for the untyped NSArray
        let ns_path = NSString::from_str(path);
        let url: Retained<NSURL> = NSURL::fileURLWithPath(&ns_path);
        let url_as_any: Retained<objc2::runtime::AnyObject> = Retained::cast_unchecked(url);
        let items: Retained<NSArray> = NSArray::from_retained_slice(&[url_as_any]);

        // Need a MainThreadMarker — this command is called from a background
        // thread so we use the unsafe constructor. The iOS share sheet must
        // be shown on the main thread; Tauri's invoke handler guarantees that
        // for async commands only when they use `dispatch_main`, so we wrap
        // the presentation in dispatch_async(main_queue) via GCD instead.
        let mtm = objc2::MainThreadMarker::new()
            .ok_or("share_file_ios must run on the main thread")?;

        // Create UIActivityViewController
        let vc = UIActivityViewController::initWithActivityItems_applicationActivities(
            UIActivityViewController::alloc(mtm),
            &items,
            None,
        );

        // Find root view controller: UIApplication → connectedScenes → UIWindowScene → keyWindow
        let app = UIApplication::sharedApplication(mtm);
        let root_vc: Retained<UIViewController> = app
            .connectedScenes()
            .iter()
            .find_map(|scene| {
                scene
                    .downcast::<UIWindowScene>()
                    .ok()
                    .and_then(|ws| ws.keyWindow())
                    .and_then(|w| w.rootViewController())
            })
            .ok_or("Root view controller not found")?;

        // On iPad, anchor the popover to the centre of the root view
        if let Some(popover) = vc.popoverPresentationController() {
            if let Some(view) = root_vc.view() {
                popover.setSourceView(Some(&view));
                let bounds: CGRect = view.bounds();
                let centre = CGRect::new(
                    CGPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
                    CGSize::new(0.0, 0.0),
                );
                popover.setSourceRect(centre);
                popover.setPermittedArrowDirections(UIPopoverArrowDirection::empty());
            }
        }

        root_vc.presentViewController_animated_completion(&vc, true, None);
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_haptics::init())
        .invoke_handler(tauri::generate_handler![
            app_backend_status,
            app_save_backend_server,
            app_use_external_backend,
            app_remove_backend_server,
            save_workspace_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenAgentd mobile");
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_max_download_size, load_backend_config_from, normalize_base_url,
        normalize_server_name, remove_backend_server_at, save_backend_config_to,
        unique_cache_path, AppBackendConfig, MAX_DOWNLOAD_BYTES,
    };
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn config_file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("app-backend.json");
        (dir, path)
    }

    #[test]
    fn normalize_base_url_accepts_http_and_https() {
        assert_eq!(normalize_base_url("http://example.com").unwrap(), "http://example.com");
        assert_eq!(normalize_base_url("https://example.com/path").unwrap(), "https://example.com/path");
    }

    #[test]
    fn normalize_base_url_trims_whitespace_and_trailing_slashes() {
        assert_eq!(normalize_base_url("  https://example.com/path///  ").unwrap(), "https://example.com/path");
    }

    #[test]
    fn normalize_base_url_rejects_empty_scheme_and_invalid_urls() {
        assert!(normalize_base_url("   ").is_err());
        assert!(normalize_base_url("file:///tmp/test").is_err());
        assert!(normalize_base_url("ftp://example.com").is_err());
        assert!(normalize_base_url("not a url").is_err());
    }

    #[test]
    fn normalize_server_name_trims_and_drops_empty_values() {
        assert_eq!(normalize_server_name(Some("  My Server  ".to_string())), Some("My Server".to_string()));
        assert_eq!(normalize_server_name(Some("   ".to_string())), None);
        assert_eq!(normalize_server_name(None), None);
    }

    #[test]
    fn load_backend_config_returns_default_when_missing() {
        let (_dir, path) = config_file();

        let config = load_backend_config_from(&path).unwrap();

        assert_eq!(config.active_base_url, None);
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers[0].base_url, "http://127.0.0.1:4082");
        assert_eq!(config.servers[0].name.as_deref(), Some("Local CLI server"));
    }

    #[test]
    fn save_backend_config_adds_new_server() {
        let (_dir, path) = config_file();

        save_backend_config_to(&path, Some("https://example.com"), Some("Example")).unwrap();
        let config = load_backend_config_from(&path).unwrap();

        assert_eq!(config.active_base_url.as_deref(), Some("https://example.com"));
        assert!(config.servers.iter().any(|server| {
            server.base_url == "https://example.com" && server.name.as_deref() == Some("Example")
        }));
    }

    #[test]
    fn save_backend_config_updates_existing_server_name() {
        let (_dir, path) = config_file();

        save_backend_config_to(&path, Some("https://example.com"), Some("Before")).unwrap();
        save_backend_config_to(&path, Some("https://example.com"), Some("After")).unwrap();
        let config = load_backend_config_from(&path).unwrap();
        let matching: Vec<_> = config
            .servers
            .iter()
            .filter(|server| server.base_url == "https://example.com")
            .collect();

        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].name.as_deref(), Some("After"));
    }

    #[test]
    fn remove_backend_server_clears_active_base_url_when_matching() {
        let (_dir, path) = config_file();

        save_backend_config_to(&path, Some("https://example.com"), Some("Example")).unwrap();
        remove_backend_server_at(&path, "https://example.com").unwrap();
        let config = load_backend_config_from(&path).unwrap();

        assert_eq!(config.active_base_url, None);
        assert!(!config.servers.iter().any(|server| server.base_url == "https://example.com"));
    }

    #[test]
    fn empty_servers_list_falls_back_to_default_on_load_and_after_remove() {
        let (_dir, path) = config_file();

        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&AppBackendConfig {
                active_base_url: Some("https://example.com".to_string()),
                servers: vec![],
            })
            .unwrap(),
        )
        .unwrap();

        let loaded = load_backend_config_from(&path).unwrap();
        assert_eq!(loaded.servers.len(), 1);
        assert_eq!(loaded.servers[0].base_url, "http://127.0.0.1:4082");

        save_backend_config_to(&path, Some("https://example.com"), Some("Example")).unwrap();
        remove_backend_server_at(&path, "https://example.com").unwrap();
        let after_remove = load_backend_config_from(&path).unwrap();

        assert_eq!(after_remove.active_base_url, None);
        assert_eq!(after_remove.servers.len(), 1);
        assert_eq!(after_remove.servers[0].base_url, "http://127.0.0.1:4082");
    }

    #[test]
    fn load_backend_config_rejects_corrupt_json() {
        let (_dir, path) = config_file();
        std::fs::write(&path, b"{not json").unwrap();

        assert!(load_backend_config_from(&path).is_err());
    }

    #[test]
    fn unique_cache_path_returns_original_when_no_collision() {
        let dir = tempdir().unwrap();

        let path = unique_cache_path(dir.path(), "report.txt").unwrap();

        assert_eq!(path, dir.path().join("report.txt"));
    }

    #[test]
    fn unique_cache_path_adds_suffix_for_single_collision() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("report.txt"), b"existing").unwrap();

        let path = unique_cache_path(dir.path(), "report.txt").unwrap();

        assert_eq!(path, dir.path().join("report (1).txt"));
    }

    #[test]
    fn unique_cache_path_skips_to_next_available_suffix() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("report.txt"), b"existing").unwrap();
        std::fs::write(dir.path().join("report (1).txt"), b"existing").unwrap();
        std::fs::write(dir.path().join("report (2).txt"), b"existing").unwrap();

        let path = unique_cache_path(dir.path(), "report.txt").unwrap();

        assert_eq!(path, dir.path().join("report (3).txt"));
    }

    #[test]
    fn unique_cache_path_preserves_extension() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("archive.tar.gz"), b"existing").unwrap();

        let path = unique_cache_path(dir.path(), "archive.tar.gz").unwrap();

        assert_eq!(path, dir.path().join("archive.tar (1).gz"));
    }

    #[test]
    fn unique_cache_path_handles_names_without_extension() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("download"), b"existing").unwrap();

        let path = unique_cache_path(dir.path(), "download").unwrap();

        assert_eq!(path, dir.path().join("download (1)"));
    }

    #[test]
    fn ensure_max_download_size_rejects_oversized_payload() {
        assert!(ensure_max_download_size(MAX_DOWNLOAD_BYTES).is_ok());
        assert!(ensure_max_download_size(MAX_DOWNLOAD_BYTES + 1).is_err());
    }
}
