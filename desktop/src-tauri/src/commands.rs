use anyhow::{anyhow, Result};
use openagentd_shell_core::{resolve_download_bytes, safe_download_filename, DownloadSource};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicUsize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{
    backend_log_path, AppState, BackendMode, BackendStartGuard, SIDECAR_HANDSHAKE_TIMEOUT,
};
use crate::sidecar::Sidecar;
use crate::config::{
    load_app_backend_config, normalize_external_base_url, normalize_server_name,
    remove_app_backend_server, save_app_backend_config, AppBackendStatus,
};
use crate::window::{create_app_window, frontend_init_script, show_main_window, MAIN_WINDOW};
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
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPayload {
    kind: String,
    session_id: Option<String>,
    mode: Option<String>,
    title: String,
    body: String,
}

#[tauri::command]
pub fn show_desktop_notification(
    app: AppHandle,
    payload: DesktopNotificationPayload,
) -> Result<(), String> {
    // Past the cap the notification is still delivered, just without the
    // "Open" action — with no actions `needs_response()` is false, so
    // `wait_for_action` sends and returns instead of parking the thread.
    // Losing click-routing on a backlogged notification beats leaking an
    // unbounded number of threads.
    let routes_clicks = claim_notification_slot();
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
                show_main_window(&app);
                if payload.session_id.is_some() {
                    if let Some(target) = crate::window::target_webview_window(&app) {
                        if let Err(error) = app.emit_to(target.label(), "desktop-notification-clicked", payload) {
                            log::warn!("desktop_notification_click_emit_failed error={error:#}");
                        }
                    }
                }
            }),
            Err(error) => log::warn!("desktop_notification_failed error={error:#}"),
        }
        if routes_clicks {
            PENDING_NOTIFICATIONS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    });
    Ok(())
}

// Access keys live in the OS credential store, keyed by canonical origin;
// the logic is shared with the mobile shell in `openagentd-shell-core`.

#[tauri::command]
pub fn secure_get_access_key(origin: String) -> Result<Option<String>, String> {
    openagentd_shell_core::get_access_key(&origin)
}

#[tauri::command]
pub fn secure_set_access_key(origin: String, key: String) -> Result<(), String> {
    openagentd_shell_core::set_access_key(&origin, &key)
}

#[tauri::command]
pub fn secure_delete_access_key(origin: String) -> Result<(), String> {
    openagentd_shell_core::delete_access_key(&origin)
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
    wait_for_health(&normalized, 8, Duration::from_millis(250))
        .await
        .map_err(|e| format!("External backend is not reachable: {e:#}"))?;

    let state: tauri::State<'_, AppState> = app.state();
    state
        .window_backend_base_urls
        .lock()
        .unwrap()
        .insert(window.label().to_string(), normalized.clone());

    if persist.unwrap_or(true) {
        // `active_base_url` is only read at startup and applied to the
        // *main* window (see `start_backend_and_window`), so only activate it
        // when this switch happened in the main window. Doing so from a
        // secondary window would silently redirect the main window (and any
        // future windows) to this window's chosen server on the next app
        // launch, even though the two windows are meant to be independent.
        let activate = window.label() == MAIN_WINDOW;
        save_app_backend_config(
            &app,
            Some(&normalized),
            normalize_server_name(name).as_deref(),
            activate,
        )
        .map_err(|e| format!("{e:#}"))?;
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
    state
        .window_backend_base_urls
        .lock()
        .unwrap()
        .retain(|_, active| {
            normalize_external_base_url(active).map_or(true, |active| active != normalized)
        });
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

    #[derive(Clone, Serialize)]
    struct BackendReady {
        port: u16,
        version: String,
        base_url: String,
        token: Option<String>,
        sidecar_running: bool,
    }

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
        let mut start_guard = BackendStartGuard::try_acquire(
            state.backend_starting.clone(),
            state.backend_failed.clone(),
        )
        .ok_or_else(|| "bundled backend is already starting".to_string())?;
        let mut sidecar = if let Some(token) = existing_token.as_deref() {
            Sidecar::spawn_with_desktop_token(&app, Some(token)).map_err(|e| format!("{e:#}"))?
        } else {
            Sidecar::spawn(&app).map_err(|e| format!("{e:#}"))?
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
        update_tray_status(&app, "Status: Running");
        start_guard.complete();

        BackendReady {
            port: handshake.port,
            version: handshake.version,
            base_url: base,
            token: Some(token),
            sidecar_running: true,
        }
    };

    state
        .window_backend_base_urls
        .lock()
        .unwrap()
        .remove(window.label());
    // Only clear the persisted `active_base_url` when the *main* window
    // switched back to bundled — that field is only ever read at startup and
    // applied to the main window, so clearing it from a secondary window
    // would silently redirect the main window to the bundled sidecar on the
    // next app launch. Other windows keep their own state in the per-window
    // `window_backend_base_urls` map, which is the source of truth while the
    // app is running.
    if window.label() == MAIN_WINDOW {
        save_app_backend_config(&app, None, None, true).map_err(|e| format!("{e:#}"))?;
    }
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

#[tauri::command]
pub async fn app_stop_bundled_backend(app: AppHandle) -> Result<(), String> {
    shutdown_sidecar_now(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn app_new_window(app: AppHandle, initial_path: Option<String>) -> Result<(), String> {
    create_app_window(&app, None, initial_path.as_deref())
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
}

pub async fn wait_for_health(base: &str, attempts: u32, delay: Duration) -> Result<()> {
    // Shared process-wide client (see `usage::shared_client`); the short
    // per-attempt deadline is applied per-request rather than baking a
    // dedicated 2s client just for health checks.
    let client = crate::usage::shared_client();
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
mod notification_tests {
    use super::{claim_notification_slot, MAX_PENDING_NOTIFICATIONS, PENDING_NOTIFICATIONS};
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
}
