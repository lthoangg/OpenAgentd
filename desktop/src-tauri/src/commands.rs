use anyhow::{anyhow, Result};
use openagentd_shell_core::{resolve_download_bytes, safe_download_filename, DownloadSource};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{
    backend_log_path, AppState, BackendMode, BackendReady, BackendStartGuard, SIDECAR_HANDSHAKE_TIMEOUT,
};
use crate::sidecar::Sidecar;
use crate::config::{
    load_app_backend_config, normalize_external_base_url, normalize_server_name,
    remove_app_backend_server, save_app_backend_config, AppBackendStatus,
};
use crate::window::{create_app_window, frontend_init_script, show_main_window};
use crate::menu::update_tray_status;
use crate::shutdown_sidecar_now;

#[cfg(target_os = "macos")]
fn notification_application_identifier(dev: bool, identifier: &str) -> &str {
    if dev {
        // Development builds are not bundled applications, so macOS only
        // delivers their notifications when attributed to Terminal.
        "com.apple.Terminal"
    } else {
        identifier
    }
}

/// Register the notification-delivering application exactly once.
///
/// `mac_notification_sys::set_application` is itself guarded by a
/// `call_once`, so every call after the first returns `AlreadySet` — a
/// single production log carried 65 of those warnings. Match its one-shot
/// semantics rather than retrying (and warning) per notification.
#[cfg(target_os = "macos")]
fn ensure_notification_application(app: &AppHandle) {
    static REGISTERED: std::sync::Once = std::sync::Once::new();
    REGISTERED.call_once(|| {
        let identifier =
            notification_application_identifier(tauri::is_dev(), &app.config().identifier);
        if let Err(error) = notify_rust::set_application(identifier) {
            log::warn!("desktop_notification_application_failed error={error:#}");
        }
    });
}

/// Ceiling on notification threads parked waiting for user interaction.
///
/// On macOS `Notification::show()` only wraps the notification in a handle
/// — delivery happens inside `wait_for_action`, which blocks its thread
/// until the user acts (notify-rust maps our single action to a
/// `MainButton`, which sets mac-notification-sys' `should_wait`). macOS
/// keeps unacted notifications in Notification Center indefinitely, so an
/// ignored notification parks its thread for the life of the process.
const MAX_PENDING_NOTIFICATIONS: usize = 8;

static PENDING_NOTIFICATIONS: AtomicUsize = AtomicUsize::new(0);

/// Reserve a slot for a notification that waits on user interaction.
/// Returns false once `MAX_PENDING_NOTIFICATIONS` are already parked.
fn claim_notification_slot() -> bool {
    PENDING_NOTIFICATIONS
        .fetch_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |pending| (pending < MAX_PENDING_NOTIFICATIONS).then_some(pending + 1),
        )
        .is_ok()
}

/// Notification ids already shown, newest last.
const MAX_SEEN_NOTIFICATIONS: usize = 64;
static SEEN_NOTIFICATIONS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Record `id`; false when it was already shown. Every app window receives
/// the same backend event and asks for the same notification.
fn first_notification_request(id: &str) -> bool {
    let mut seen = SEEN_NOTIFICATIONS.lock().unwrap_or_else(|e| e.into_inner());
    if seen.iter().any(|s| s == id) {
        return false;
    }
    if seen.len() == MAX_SEEN_NOTIFICATIONS {
        seen.pop_front();
    }
    seen.push_back(id.to_string());
    true
}

/// Whether an app window other than `caller`, on the same server, has
/// focus. The user is then looking at the app, and that window got the same
/// event and decides for itself whether to notify (it knows which session is
/// on screen). A focused window on another server never sees the event.
fn another_app_window_focused(app: &AppHandle, caller: &str) -> bool {
    let focused = crate::servers::focused_app_window(app);
    crate::servers::focused_window_covers(caller, focused.as_deref(), &crate::servers::external_map(app))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPayload {
    kind: String,
    session_id: Option<String>,
    mode: Option<String>,
    title: String,
    body: String,
    #[serde(default)]
    notification_id: Option<String>,
}

/// Shows the notification and returns true, or returns false when another
/// window already showed it or has the user's focus.
#[tauri::command]
pub fn show_desktop_notification(
    app: AppHandle,
    window: tauri::WebviewWindow,
    payload: DesktopNotificationPayload,
) -> Result<bool, String> {
    if another_app_window_focused(&app, window.label()) {
        return Ok(false);
    }
    if let Some(id) = payload.notification_id.as_deref() {
        if !first_notification_request(id) {
            return Ok(false);
        }
    }
    // Past the cap the notification is still delivered, just without the
    // "Open" action — with no actions `needs_response()` is false, so
    // `wait_for_action` sends and returns instead of parking the thread.
    // Losing click-routing on a backlogged notification beats leaking an
    // unbounded number of threads.
    let routes_clicks = claim_notification_slot();
    // A click opens the session in the window that asked: it is on the
    // session's server, which the focused window may not be.
    let sender = window.label().to_string();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        ensure_notification_application(&app);
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&payload.title)
            .body(&payload.body);
        if routes_clicks {
            notification.action("default", "Open");
        }

        match notification.show() {
            Ok(handle) => handle.wait_for_action(move |action| {
                if action != "default" {
                    return;
                }
                let target = match app.get_webview_window(&sender) {
                    Some(window) => {
                        crate::window::show_window(&window);
                        Some(window)
                    }
                    None => {
                        show_main_window(&app);
                        crate::window::target_webview_window(&app)
                    }
                };
                let Some(target) = target.filter(|_| payload.session_id.is_some()) else {
                    return;
                };
                if let Err(error) = app.emit_to(target.label(), "desktop-notification-clicked", payload) {
                    log::warn!("desktop_notification_click_emit_failed error={error:#}");
                }
            }),
            Err(error) => log::warn!("desktop_notification_failed error={error:#}"),
        }
        if routes_clicks {
            PENDING_NOTIFICATIONS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    });
    Ok(true)
}

// Access keys live in `access-keys.json`, a user-only file in the app config
// dir, keyed by canonical origin (see `openagentd_shell_core::access_key` for
// why not the macOS keychain). The commands still run the file I/O on the
// blocking pool, off the main thread.

async fn off_main_thread<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(call)
        .await
        .map_err(|_| "credential store unavailable".to_string())?
}

#[tauri::command]
pub async fn secure_get_access_key(origin: String) -> Result<Option<String>, String> {
    off_main_thread(move || openagentd_shell_core::get_access_key(&origin)).await
}

/// The page's theme preference for its window: `"light"`, `"dark"`, or
/// `"system"`. Paints the native window background to match now, and saves
/// an explicit pick so the next launch opens without a flash of the other
/// theme (see `config::saved_window_theme`).
#[tauri::command]
pub async fn set_window_theme(
    app: AppHandle,
    window: tauri::WebviewWindow,
    preference: String,
) -> Result<(), String> {
    let theme = match preference.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        "system" => None,
        other => return Err(format!("unknown theme preference: {other}")),
    };
    let painted = theme.or_else(|| window.theme().ok()).unwrap_or(tauri::Theme::Light);
    window
        .set_background_color(Some(crate::window::window_background(painted)))
        .ok();
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::config::save_window_theme(&app, &label, theme).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("save window theme: {e}"))?
}

#[tauri::command]
pub async fn secure_set_access_key(origin: String, key: String) -> Result<(), String> {
    off_main_thread(move || openagentd_shell_core::set_access_key(&origin, &key)).await
}

#[tauri::command]
pub async fn secure_delete_access_key(origin: String) -> Result<(), String> {
    off_main_thread(move || openagentd_shell_core::delete_access_key(&origin)).await
}

#[derive(Deserialize)]
pub struct SaveWorkspaceFileRequest {
    /// Pre-encoded base64 payload. The frontend sends this for `blob:`
    /// sources (attachment previews), which only exist inside the webview
    /// and cannot be fetched from Rust.
    pub base64: Option<String>,
    /// Remote `http(s)` URL, or a `data:` URI.
    pub url: Option<String>,
    pub filename: String,
}

/// Total budget for one workspace download. Overrides `shared_client`'s
/// 10s default, which is sized for the usage-summary poll and would abort
/// any sizeable file.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[tauri::command]
pub async fn save_workspace_file(
    app: AppHandle,
    request: SaveWorkspaceFileRequest,
) -> Result<bool, String> {
    let filename = safe_download_filename(&request.filename);
    // Callback + oneshot instead of `blocking_save_file`, which parks a
    // tokio worker thread for as long as the user leaves the dialog open.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save file")
        .set_file_name(filename)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(target) = rx
        .await
        .map_err(|_| "Save dialog closed unexpectedly".to_string())?
    else {
        return Ok(false);
    };
    let path = target
        .into_path()
        .map_err(|_| "Selected destination is not a local file path".to_string())?;
    let bytes = resolve_download_bytes(
        crate::usage::shared_client(),
        DownloadSource {
            base64: request.base64.as_deref(),
            url: request.url.as_deref(),
        },
        DOWNLOAD_TIMEOUT,
    )
    .await?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("Write {}: {e}", path.display()))?;
    Ok(true)
}

#[tauri::command]
pub async fn backend_health(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let mut guard = state.sidecar.lock().await;
    match guard.as_mut() {
        Some(s) => Ok(s.is_alive()),
        None => Ok(false),
    }
}

#[tauri::command]
pub fn backend_logs_path(app: AppHandle) -> Result<String, String> {
    backend_log_path(&app)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| format!("backend log path unavailable: {e}"))
}

#[tauri::command]
pub fn desktop_logs_path(app: AppHandle) -> Result<String, String> {
    crate::desktop_log_path(&app)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("desktop log path unavailable: {e}"))
}

#[tauri::command]
pub async fn app_backend_status(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<AppBackendStatus, String> {
    app_backend_status_for_window(app, state, window.label()).await
}

pub async fn app_backend_status_for_window(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    window_label: &str,
) -> Result<AppBackendStatus, String> {
    let bundled_base_url = state.backend_base_url.lock().await.clone();
    let window_base_url = state
        .window_backend_base_urls
        .lock()
        .unwrap()
        .get(window_label)
        .cloned();
    let external = window_base_url.is_some();
    let base_url = window_base_url
        .or(bundled_base_url)
        .unwrap_or_else(|| "".to_string());
    let sidecar_running = state
        .sidecar
        .lock()
        .await
        .as_mut()
        .is_some_and(|s| s.is_alive());
    let mode = if external {
        BackendMode::External
    } else {
        BackendMode::Bundled
    };
    let servers = load_app_backend_config(&app)
        .unwrap_or_default()
        .servers;
    let token = if external {
        None
    } else {
        state.desktop_token.lock().await.clone()
    };
    Ok(AppBackendStatus {
        base_url,
        token,
        mode: mode.as_str().to_string(),
        sidecar_running,
        backend_starting: state
            .backend_starting
            .load(std::sync::atomic::Ordering::SeqCst),
        backend_failed: mode == BackendMode::Bundled
            && state
                .backend_failed
                .load(std::sync::atomic::Ordering::SeqCst),
        external: mode == BackendMode::External,
        supports_bundled: true,
        servers,
    })
}

#[tauri::command]
pub async fn app_save_backend_server(
    app: AppHandle,
    window: tauri::WebviewWindow,
    base_url: String,
    name: Option<String>,
) -> Result<AppBackendStatus, String> {
    let normalized = normalize_external_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    save_app_backend_config(
        &app,
        Some(&normalized),
        normalize_server_name(name).as_deref(),
        false,
    )
    .map_err(|e| format!("{e:#}"))?;
    crate::island::servers_changed(&app);
    app_backend_status_for_window(app.clone(), app.state(), window.label())
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Switch a saved server's background watching on or off. The notch follows
/// the change at once.
#[tauri::command]
pub async fn app_set_backend_server_enabled(
    app: AppHandle,
    window: tauri::WebviewWindow,
    base_url: String,
    enabled: bool,
) -> Result<AppBackendStatus, String> {
    let normalized = normalize_external_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    crate::config::set_app_backend_server_enabled(&app, &normalized, enabled).map_err(|e| format!("{e:#}"))?;
    crate::island::servers_changed(&app);
    app_backend_status_for_window(app.clone(), app.state(), window.label())
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn app_use_external_backend(
    app: AppHandle,
    window: tauri::WebviewWindow,
    base_url: String,
    name: Option<String>,
    persist: Option<bool>,
) -> Result<AppBackendStatus, String> {
    let normalized = normalize_external_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    let state: tauri::State<'_, AppState> = app.state();
    let previous = state
        .window_backend_base_urls
        .lock()
        .unwrap()
        .insert(window.label().to_string(), normalized.clone());
    // Previews of the previous server must not stay reachable.
    if previous.as_deref() != Some(normalized.as_str()) {
        crate::preview_relay::close_window(&app, window.label());
    }

    if persist.unwrap_or(true) {
        // Keep it in the server list only. It never becomes a server the app
        // connects to on its own (`active_base_url` is left alone): the next
        // launch opens on the builtin, and this server stays one Connect away.
        save_app_backend_config(
            &app,
            Some(&normalized),
            normalize_server_name(name).as_deref(),
            false,
        )
        .map_err(|e| format!("{e:#}"))?;
        crate::island::servers_changed(&app);
    }

    let init_script = frontend_init_script(None, &normalized);
    window
        .eval(&init_script)
        .map_err(|e| format!("inject external backend config: {e:#}"))?;
    update_tray_status(&app, "Status: Running");
    
    #[derive(Clone, Serialize)]
    struct BackendReady {
        port: u16,
        version: String,
        base_url: String,
        token: Option<String>,
        sidecar_running: bool,
    }

    // Target this window only. A plain `.emit(...)` broadcasts to every
    // window's JS listeners; `useAppBackendBootstrap` on the frontend applies
    // whatever `backend-ready` payload it receives, so a broadcast here would
    // live-redirect every other open window to this window's server.
    window
        .emit_to(
            window.label(),
            "backend-ready",
            BackendReady {
                port: 0,
                version: "external".to_string(),
                base_url: normalized,
                token: None,
                sidecar_running: false,
            },
        )
        .ok();

    app_backend_status_for_window(app.clone(), app.state(), window.label())
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn app_remove_backend_server(
    app: AppHandle,
    window: tauri::WebviewWindow,
    base_url: String,
) -> Result<AppBackendStatus, String> {
    let normalized = normalize_external_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    remove_app_backend_server(&app, &normalized).map_err(|e| format!("{e:#}"))?;
    let state: tauri::State<'_, AppState> = app.state();
    let mut detached = Vec::new();
    state
        .window_backend_base_urls
        .lock()
        .unwrap()
        .retain(|label, active| {
            let keep = normalize_external_base_url(active).map_or(true, |active| active != normalized);
            if !keep {
                detached.push(label.clone());
            }
            keep
        });
    for label in detached {
        crate::preview_relay::close_window(&app, &label);
    }
    crate::island::servers_changed(&app);
    app_backend_status_for_window(app.clone(), app.state(), window.label())
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn app_use_bundled_backend(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let state: tauri::State<'_, AppState> = app.state();

    let existing_token = state.desktop_token.lock().await.clone();
    let sidecar_alive = {
        let mut guard = state.sidecar.lock().await;
        guard.as_mut().is_some_and(|sidecar| sidecar.is_alive())
    };

    let backend_ready = if sidecar_alive {
        state
            .backend_failed
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let base = state
            .backend_base_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| "bundled backend is not ready".to_string())?;
        BackendReady {
            port: 0,
            version: "bundled".to_string(),
            base_url: base,
            token: existing_token,
            sidecar_running: true,
        }
    } else {
        start_bundled_sidecar(&app).await?
    };

    state
        .window_backend_base_urls
        .lock()
        .unwrap()
        .remove(window.label());
    crate::preview_relay::close_window(&app, window.label());
    let init_script = frontend_init_script(backend_ready.token.as_deref(), &backend_ready.base_url);
    window
        .eval(&init_script)
        .map_err(|e| format!("inject bundled backend config: {e:#}"))?;
    // Target this window only — see the comment in `app_use_external_backend`
    // for why a broadcast `.emit(...)` here would affect other open windows.
    window
        .emit_to(window.label(), "backend-ready", backend_ready)
        .ok();
    Ok(())
}

/// Spawn the bundled sidecar (reusing the desktop token, so open windows
/// stay authenticated), wait until it is healthy, and store it as the
/// bundled backend. Shared by "use bundled backend" and the crash watcher.
pub async fn start_bundled_sidecar(app: &AppHandle) -> Result<BackendReady, String> {
    let state: tauri::State<'_, AppState> = app.state();
    let existing_token = state.desktop_token.lock().await.clone();
    let mut start_guard = BackendStartGuard::try_acquire(
        state.backend_starting.clone(),
        state.backend_failed.clone(),
    )
    .ok_or_else(|| "bundled backend is already starting".to_string())?;
    let mut sidecar = if let Some(token) = existing_token.as_deref() {
        Sidecar::spawn_with_desktop_token(app, Some(token)).map_err(|e| format!("{e:#}"))?
    } else {
        Sidecar::spawn(app).map_err(|e| format!("{e:#}"))?
    };
    let handshake = match sidecar.read_handshake(SIDECAR_HANDSHAKE_TIMEOUT).await {
        Ok(handshake) => handshake,
        Err(e) => {
            sidecar
                .shutdown_with_grace(Duration::from_millis(750))
                .await;
            return Err(format!("{e:#}"));
        }
    };
    let base = format!("http://127.0.0.1:{}", handshake.port);
    if let Err(e) = wait_for_health(&base, 60, Duration::from_millis(250)).await {
        sidecar
            .shutdown_with_grace(Duration::from_millis(750))
            .await;
        return Err(format!("{e:#}"));
    }

    let token = handshake.token.clone();
    let _ = state.sidecar.lock().await.replace(sidecar);
    let _ = state.desktop_token.lock().await.replace(token.clone());
    let _ = state.backend_base_url.lock().await.replace(base.clone());
    update_tray_status(app, "Status: Running");
    start_guard.complete();
    crate::network_access::reapply(app);

    Ok(BackendReady {
        port: handshake.port,
        version: handshake.version,
        base_url: base,
        token: Some(token),
        sidecar_running: true,
    })
}

#[tauri::command]
pub async fn app_stop_bundled_backend(app: AppHandle) -> Result<(), String> {
    shutdown_sidecar_now(&app).await;
    Ok(())
}

// "Network access" for the builtin sidecar; logic in `network_access`.

#[tauri::command]
pub async fn app_network_access_status(
    app: AppHandle,
) -> Result<crate::network_access::NetworkAccessStatus, String> {
    crate::network_access::status(&app).await
}

#[tauri::command]
pub async fn app_set_network_access(
    app: AppHandle,
    enabled: bool,
    port: u16,
) -> Result<crate::network_access::NetworkAccessStatus, String> {
    crate::network_access::set(&app, enabled, port).await
}

/// The LAN access key, for Show/Copy. `None` until network access was first enabled.
#[tauri::command]
pub async fn app_network_access_key(app: AppHandle) -> Result<Option<String>, String> {
    off_main_thread(move || crate::network_access::load_key(&app)).await
}

/// Store a custom key, or generate a new one when `key` is `None`.
#[tauri::command]
pub async fn app_set_network_access_key(
    app: AppHandle,
    key: Option<String>,
) -> Result<crate::network_access::NetworkAccessStatus, String> {
    crate::network_access::set_key(&app, key).await
}

#[tauri::command]
pub async fn app_new_window(app: AppHandle, initial_path: Option<String>) -> Result<(), String> {
    create_app_window(&app, None, initial_path.as_deref())
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
}

/// Wait until the bundled sidecar at `base` (loopback) answers its health check.
pub async fn wait_for_health(base: &str, attempts: u32, delay: Duration) -> Result<()> {
    wait_for_health_with(crate::usage::loopback_client(), base, attempts, delay).await
}

async fn wait_for_health_with(client: &reqwest::Client, base: &str, attempts: u32, delay: Duration) -> Result<()> {
    // The short per-attempt deadline is applied per request rather than
    // baking a dedicated 2 s client just for health checks.
    let url = format!("{base}/api/health/live");
    for i in 0..attempts {
        match client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) => log::debug!("health attempt {i} got status {}", r.status()),
            Err(e) => log::debug!("health attempt {i} failed: {e}"),
        }
        tokio::time::sleep(delay).await;
    }
    Err(anyhow!(
        "backend did not become healthy after {attempts} attempts"
    ))
}

#[cfg(test)]
mod health_tests {
    // Inputs here fail before the store is reached, so the test never
    // touches a real access-key file.
    #[tokio::test]
    async fn access_key_commands_are_awaited_and_keep_shell_core_errors() {
        let invalid = Err("invalid backend origin".to_string());
        assert_eq!(super::secure_get_access_key("not a url".into()).await, invalid);
        assert_eq!(super::secure_delete_access_key("ftp://example.com".into()).await, Err("invalid backend origin".to_string()));
        assert_eq!(
            super::secure_set_access_key("https://example.com".into(), "  \n".into()).await,
            Err("access key is required".to_string())
        );
    }
}

#[cfg(test)]
mod notification_tests {
    use super::{
        claim_notification_slot, first_notification_request, MAX_PENDING_NOTIFICATIONS,
        MAX_SEEN_NOTIFICATIONS, PENDING_NOTIFICATIONS,
    };
    use std::sync::atomic::Ordering;
    #[cfg(target_os = "macos")]
    use super::notification_application_identifier;

    // Access-key and download behaviour is tested once in
    // `openagentd-shell-core`; the desktop keeps only what is desktop-only.

    #[cfg(target_os = "macos")]
    #[test]
    fn dev_notifications_use_terminal_as_the_registered_application() {
        assert_eq!(
            notification_application_identifier(true, "com.openagentd.desktop.dev"),
            "com.apple.Terminal"
        );
        assert_eq!(
            notification_application_identifier(false, "com.openagentd.desktop"),
            "com.openagentd.desktop"
        );
    }

    // ── claim_notification_slot ─────────────────────────────────────────
    //
    // `wait_for_action` parks its thread until the user acts, and macOS
    // keeps unacted notifications in Notification Center indefinitely, so
    // the number of threads that can be parked has to be bounded.

    #[test]
    fn notification_slots_are_capped_and_released() {
        for slot in 0..MAX_PENDING_NOTIFICATIONS {
            assert!(claim_notification_slot(), "slot {slot} should be free");
        }

        // Over the cap: the notification is still delivered, just without
        // the action that would park another thread.
        assert!(!claim_notification_slot());

        // A thread finishing frees exactly one slot.
        PENDING_NOTIFICATIONS.fetch_sub(1, Ordering::SeqCst);
        assert!(claim_notification_slot());
        assert!(!claim_notification_slot());

        PENDING_NOTIFICATIONS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn each_notification_id_is_shown_once() {
        assert!(first_notification_request("dedupe-a"));
        assert!(!first_notification_request("dedupe-a"), "a second window asks for the same id");
        assert!(first_notification_request("dedupe-b"));

        // The oldest id is forgotten once the list is full.
        for n in 0..MAX_SEEN_NOTIFICATIONS {
            assert!(first_notification_request(&format!("dedupe-fill-{n}")));
        }
        assert!(first_notification_request("dedupe-a"));
    }
}
