use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use openagentd_shell_core::{
    load_backend_config_from, normalize_base_url, normalize_server_name,
    remove_backend_server_at, resolve_download_bytes, safe_download_filename,
    save_backend_config_to, unique_cache_path, AppBackendConfig, DownloadSource,
    RelayInfo, RelayRegistry, SavedAppServer,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

mod widgets;

/// Total budget for one workspace download. Mobile talks to a remote
/// server over whatever network the phone has, so keep this shorter than
/// the desktop's 300 s.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// Process-wide HTTP client shared by the backend health check and file
/// downloads. Building a `reqwest::Client` per request throws away its
/// connection pool (and pays a fresh TLS handshake) every time — mirrors
/// the desktop shell's `usage::shared_client`. Operation-specific
/// deadlines are applied per request via `.timeout(...)`.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

// Access keys live in the OS credential store, keyed by canonical origin;
// the logic is shared with the desktop shell in `openagentd-shell-core`.
// The commands are async so the keychain call (and any unlock prompt) runs
// on the blocking pool, not the main thread; see the desktop's `commands.rs`.

async fn off_main_thread<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(call)
        .await
        .map_err(|_| "credential store unavailable".to_string())?
}

#[tauri::command]
async fn secure_get_access_key(origin: String) -> Result<Option<String>, String> {
    off_main_thread(move || openagentd_shell_core::get_access_key(&origin)).await
}

#[tauri::command]
async fn secure_set_access_key(origin: String, key: String) -> Result<(), String> {
    off_main_thread(move || openagentd_shell_core::set_access_key(&origin, &key)).await
}

#[tauri::command]
async fn secure_delete_access_key(origin: String) -> Result<(), String> {
    off_main_thread(move || openagentd_shell_core::delete_access_key(&origin)).await
}

// ── Web preview relay ───────────────────────────────────────────────────
//
// A server's preview listeners bind *its* loopback, which the phone cannot
// reach. The relay (`openagentd_shell_core::preview_relay`) listens on the
// phone's own 127.0.0.1 and tunnels each connection to the server with the
// access key, which never reaches the previewed page. The server URL and key
// come from native state, never from the webview.

/// Open preview relays. The phone has one window, so one scope.
#[derive(Default)]
struct PreviewRelays(RelayRegistry);

const RELAY_SCOPE: &str = "main";

static RELAY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// HTTP/1.1 only (a WebSocket upgrade cannot happen on HTTP/2) and no total
/// timeout: tunnels stay open for as long as the page uses them.
fn relay_client() -> &'static reqwest::Client {
    RELAY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// The connected server a relay tunnels to.
fn relay_base_url(
    runtime_base_url: Option<String>,
    persisted_base_url: Option<String>,
) -> Result<String, String> {
    let base = resolve_active_base_url(runtime_base_url, persisted_base_url);
    if base.is_empty() {
        return Err("No server is connected.".to_string());
    }
    normalize_base_url(&base).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn preview_relay_open(
    app: AppHandle,
    state: tauri::State<'_, MobileBackendState>,
    relays: tauri::State<'_, PreviewRelays>,
    preview_id: String,
    port: u16,
) -> Result<RelayInfo, String> {
    let runtime_base_url = state
        .active_base_url
        .lock()
        .map_err(|_| "backend state unavailable".to_string())?
        .clone();
    let persisted = load_backend_config(&app)
        .map_err(|e| format!("{e:#}"))?
        .active_base_url;
    let base_url = relay_base_url(runtime_base_url, persisted)?;
    let origin = base_url.clone();
    let key = off_main_thread(move || openagentd_shell_core::get_access_key(&origin))
        .await?
        .ok_or_else(|| "Previews on this device need this server's access key.".to_string())?;
    relays
        .0
        .open(
            RELAY_SCOPE,
            relay_client(),
            &base_url,
            &key,
            &preview_id,
            port,
        )
        .await
}

#[tauri::command]
fn preview_relay_close(relays: tauri::State<'_, PreviewRelays>, preview_id: String) -> bool {
    relays.0.close(RELAY_SCOPE, &preview_id)
}

/// Save what the home-screen widgets show (see `widgets.rs`).
#[tauri::command]
async fn widget_update_snapshot(
    app: AppHandle,
    snapshot: widgets::WidgetSnapshot,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || widgets::publish(&app, snapshot))
        .await
        .map_err(|e| format!("Widget update failed: {e}"))?
}

#[derive(Clone, Serialize)]
struct AppBackendStatus {
    base_url: String,
    sidecar_running: bool,
    external: bool,
    supports_bundled: bool,
    servers: Vec<SavedAppServer>,
}

#[derive(Default)]
struct MobileBackendState {
    active_base_url: Mutex<Option<String>>,
}

fn resolve_active_base_url(
    runtime_base_url: Option<String>,
    persisted_base_url: Option<String>,
) -> String {
    runtime_base_url.or(persisted_base_url).unwrap_or_default()
}

#[tauri::command]
fn app_backend_status(
    app: AppHandle,
    state: tauri::State<'_, MobileBackendState>,
) -> Result<AppBackendStatus, String> {
    let config = load_backend_config(&app).map_err(|e| format!("{e:#}"))?;
    let runtime_base_url = state
        .active_base_url
        .lock()
        .map_err(|_| "backend state unavailable".to_string())?
        .clone();
    Ok(AppBackendStatus {
        base_url: resolve_active_base_url(runtime_base_url, config.active_base_url),
        sidecar_running: false,
        external: true,
        supports_bundled: false,
        servers: config.servers,
    })
}

#[tauri::command]
fn app_save_backend_server(
    app: AppHandle,
    state: tauri::State<'_, MobileBackendState>,
    base_url: String,
    name: Option<String>,
) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    save_backend_config(
        &app,
        Some(&normalized),
        normalize_server_name(name).as_deref(),
        false,
    )
    .map_err(|e| format!("{e:#}"))?;
    app_backend_status(app, state)
}

#[tauri::command]
async fn app_use_external_backend(
    app: AppHandle,
    state: tauri::State<'_, MobileBackendState>,
    relays: tauri::State<'_, PreviewRelays>,
    base_url: String,
    name: Option<String>,
    persist: Option<bool>,
) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    // Confirm the server answers *before* persisting it. Without this a
    // mistyped host became the persisted startup backend, and the app
    // reopened onto a loading screen on every launch with no in-app route
    // back. The desktop shell has always health-checked here.
    ensure_backend_reachable(&normalized).await?;
    if persist.unwrap_or(true) {
        save_backend_config(
            &app,
            Some(&normalized),
            normalize_server_name(name).as_deref(),
            true,
        )
        .map_err(|e| format!("{e:#}"))?;
    }
    let previous = state
        .active_base_url
        .lock()
        .map_err(|_| "backend state unavailable".to_string())?
        .replace(normalized.clone());
    // Previews of the previous server must not stay reachable.
    if previous.as_deref() != Some(normalized.as_str()) {
        relays.0.close_all();
    }
    app_backend_status(app, state)
}

#[tauri::command]
fn app_remove_backend_server(
    app: AppHandle,
    state: tauri::State<'_, MobileBackendState>,
    relays: tauri::State<'_, PreviewRelays>,
    base_url: String,
) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    let path = config_path(&app).map_err(|e| format!("{e:#}"))?;
    remove_backend_server_at(&path, &normalized).map_err(|e| format!("{e:#}"))?;
    let mut active = state
        .active_base_url
        .lock()
        .map_err(|_| "backend state unavailable".to_string())?;
    if active.as_deref() == Some(normalized.as_str()) {
        *active = None;
        relays.0.close_all();
    }
    drop(active);
    app_backend_status(app, state)
}

/// Confirm a server answers `GET /api/health/live`.
///
/// A single attempt is enough here: unlike the desktop shell — which
/// races a sidecar that is still starting and therefore retries — mobile
/// only ever talks to an already-running remote server.
async fn ensure_backend_reachable(base_url: &str) -> Result<(), String> {
    shared_client()
        .get(format!(
            "{}/api/health/live",
            base_url.trim_end_matches('/')
        ))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Backend is not reachable: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Backend is not reachable: {e}"))?;
    Ok(())
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
    load_backend_config_from(&config_path(app)?)
}

fn save_backend_config(
    app: &AppHandle,
    base_url: Option<&str>,
    name: Option<&str>,
    activate: bool,
) -> Result<()> {
    save_backend_config_to(&config_path(app)?, base_url, name, activate)
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
    let filename = safe_download_filename(&request.filename);
    let bytes = resolve_download_bytes(
        shared_client(),
        DownloadSource {
            base64: request.base64.as_deref(),
            url: request.url.as_deref(),
        },
        DOWNLOAD_TIMEOUT,
    )
    .await?;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Get cache dir: {e}"))?;
    // Directory scan + up-to-100 MB write are blocking FS work — keep them
    // off the async runtime's worker threads.
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        std::fs::create_dir_all(&cache_dir)
            .with_context(|| format!("Create cache dir {}", cache_dir.display()))
            .map_err(|e| format!("{e:#}"))?;
        let path = unique_cache_path(&cache_dir, &filename).map_err(|e| format!("{e}"))?;
        std::fs::write(&path, &bytes)
            .with_context(|| format!("Write {}", path.display()))
            .map_err(|e| format!("{e:#}"))?;
        Ok(path)
    })
    .await
    .map_err(|e| format!("Write task failed: {e}"))??;

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

    #[cfg(target_os = "android")]
    {
        // tauri-plugin-opener cannot open a local path on Android; share it
        // through a FileProvider and the system chooser instead (the
        // counterpart of the iOS share sheet). The JNI call blocks until the
        // chooser is up, so keep it off the async workers.
        use tauri_plugin_openagentd_android::AndroidShellExt;
        let path_str = path.to_string_lossy().into_owned();
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || app.android_shell().share_file(&path_str))
            .await
            .map_err(|e| format!("Share task failed: {e}"))??;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
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
    let builder = tauri::Builder::default();
    // Registered first: it installs the Keystore-backed keyring store that
    // the access-key commands rely on (keyring has no Android backend).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_openagentd_android::init());
    builder
        .manage(MobileBackendState::default())
        .manage(PreviewRelays::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_haptics::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            secure_get_access_key,
            secure_set_access_key,
            secure_delete_access_key,
            app_backend_status,
            app_save_backend_server,
            app_use_external_backend,
            app_remove_backend_server,
            save_workspace_file,
            preview_relay_open,
            preview_relay_close,
            widget_update_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenAgentd mobile");
}

#[cfg(test)]
mod tests {
    use super::{ensure_backend_reachable, relay_base_url, resolve_active_base_url};

    // Everything about config files, URL normalisation, access keys, and
    // download limits is tested once in `openagentd-shell-core`; only the
    // mobile-specific runtime state and reachability gate live here.

    #[test]
    fn runtime_backend_overrides_persisted_startup_backend() {
        assert_eq!(
            resolve_active_base_url(
                Some("https://runtime.example".to_string()),
                Some("https://persisted.example".to_string()),
            ),
            "https://runtime.example",
        );
    }

    #[test]
    fn persisted_backend_is_used_without_runtime_override() {
        assert_eq!(
            resolve_active_base_url(None, Some("https://persisted.example".to_string())),
            "https://persisted.example",
        );
    }

    #[test]
    fn relays_tunnel_to_the_connected_server_only() {
        assert_eq!(
            relay_base_url(Some("http://192.168.1.5:4082/".to_string()), None).unwrap(),
            "http://192.168.1.5:4082",
        );
        assert_eq!(
            relay_base_url(None, Some("https://box.example/oad".to_string())).unwrap(),
            "https://box.example/oad",
        );
        assert!(relay_base_url(None, None).is_err());
    }

    /// The webview loads the bundled UI (or devUrl, which Tauri counts as
    /// local). A remote pattern would grant IPC, `secure_get_access_key`
    /// included, to server pages or a relayed preview on 127.0.0.1.
    #[test]
    fn capability_grants_ipc_to_the_app_origin_only() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(
            capability.get("remote").is_none(),
            "remote origins granted IPC: {}",
            capability["remote"]
        );
    }

    // ── ensure_backend_reachable ────────────────────────────────────────
    //
    // Guards the ordering in `app_use_external_backend`: a server that does
    // not answer must be rejected before it can be written to
    // `active_base_url`, which is what the app reconnects to on launch.

    #[tokio::test]
    async fn an_unreachable_backend_is_rejected() {
        // Port 1 is reserved and never listening — connection refused.
        let error = ensure_backend_reachable("http://127.0.0.1:1")
            .await
            .expect_err("an unreachable backend must not be accepted");

        assert!(error.starts_with("Backend is not reachable"), "unexpected: {error}");
    }
}
