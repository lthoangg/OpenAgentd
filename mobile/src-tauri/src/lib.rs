use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
    if !path.exists() {
        return Ok(AppBackendConfig::default());
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let mut config: AppBackendConfig = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse {}", path.display()))?;
    if config.servers.is_empty() {
        config.servers = AppBackendConfig::default().servers;
    }
    Ok(config)
}

fn save_backend_config(app: &AppHandle, base_url: Option<&str>, name: Option<&str>) -> Result<()> {
    let path = config_path(app)?;
    let mut config = load_backend_config(app).unwrap_or_default();
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
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}

fn remove_backend_server(app: &AppHandle, base_url: &str) -> Result<()> {
    let path = config_path(app)?;
    let mut config = load_backend_config(app).unwrap_or_default();
    config.servers.retain(|server| server.base_url != base_url);
    if config.active_base_url.as_deref() == Some(base_url) {
        config.active_base_url = None;
    }
    if config.servers.is_empty() {
        config.servers = AppBackendConfig::default().servers;
    }
    let bytes = serde_json::to_vec_pretty(&config).context("serialize backend config")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
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
    let filename = std::path::Path::new(&request.filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download")
        .to_string();

    // Resolve the file bytes: base64 payload, data: URI, or remote URL fetch.
    let bytes: Vec<u8> = match (request.base64, request.url) {
        (Some(b64), _) => {
            use base64::Engine;
            base64::prelude::BASE64_STANDARD
                .decode(&b64)
                .map_err(|e| format!("Decode base64: {e}"))?
        }
        (None, Some(url)) if url.starts_with("data:") => {
            // data:<mime>;base64,<payload>
            use base64::Engine;
            let payload = url.splitn(2, ',').nth(1)
                .ok_or("Invalid data URI: missing comma")?;
            base64::prelude::BASE64_STANDARD
                .decode(payload)
                .map_err(|e| format!("Decode data URI: {e}"))?
        }
        (None, Some(url)) => {
            reqwest::get(&url)
                .await
                .map_err(|e| format!("Fetch file: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Fetch file: {e}"))?
                .bytes()
                .await
                .map_err(|e| format!("Read fetched file: {e}"))?
                .to_vec()
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
    let path = cache_dir.join(&filename);

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
