use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{AppState, BackendMode, BackendStartGuard};
use crate::sidecar::Sidecar;
use crate::config::{
    load_app_backend_config, normalize_external_base_url, normalize_server_name,
    remove_app_backend_server, save_app_backend_config, AppBackendStatus,
};
use crate::window::{create_app_window, frontend_init_script, show_main_window, MAIN_WINDOW};
use crate::menu::update_tray_status;
use crate::shutdown_sidecar_now;

const ACCESS_KEY_SERVICE: &str = "openagentd.backend-access-key";

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
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            let identifier = notification_application_identifier(
                tauri::is_dev(),
                &app.config().identifier,
            );
            if let Err(error) = notify_rust::set_application(identifier) {
                log::warn!("desktop_notification_application_failed error={error:#}");
            }
        }
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&payload.title)
            .body(&payload.body)
            .action("default", "Open");

        match notification.show() {
            Ok(handle) => handle.wait_for_action(move |action| {
                if action != "default" {
                    return;
                }
                show_main_window(&app);
                if payload.session_id.is_some() {
                    if let Err(error) = app.emit_to(MAIN_WINDOW, "desktop-notification-clicked", payload) {
                        log::warn!("desktop_notification_click_emit_failed error={error:#}");
                    }
                }
            }),
            Err(error) => log::warn!("desktop_notification_failed error={error:#}"),
        }
    });
    Ok(())
}

fn access_key_entry(origin: &str) -> Result<keyring::Entry, String> {
    let parsed = url::Url::parse(origin).map_err(|_| "invalid backend origin".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.origin().ascii_serialization() != origin
    {
        return Err("invalid backend origin".to_string());
    }
    keyring::Entry::new(ACCESS_KEY_SERVICE, origin)
        .map_err(|_| "credential store unavailable".to_string())
}

#[tauri::command]
pub fn secure_get_access_key(origin: String) -> Result<Option<String>, String> {
    match access_key_entry(&origin)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("credential store unavailable".to_string()),
    }
}

#[tauri::command]
pub fn secure_set_access_key(origin: String, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("access key is required".to_string());
    }
    access_key_entry(&origin)?
        .set_password(key.trim())
        .map_err(|_| "credential store unavailable".to_string())
}

#[tauri::command]
pub fn secure_delete_access_key(origin: String) -> Result<(), String> {
    match access_key_entry(&origin)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("credential store unavailable".to_string()),
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[tauri::command]
pub fn request_voice_permissions() -> Result<bool, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use objc2_speech::{SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};
    use std::sync::mpsc;

    let audio_type = unsafe { AVMediaTypeAudio.expect("AVMediaTypeAudio is available") };
    let microphone_status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio_type) };
    let microphone_granted = if microphone_status == AVAuthorizationStatus::Authorized {
        true
    } else if microphone_status == AVAuthorizationStatus::Denied
        || microphone_status == AVAuthorizationStatus::Restricted
    {
        false
    } else {
        let (tx, rx) = mpsc::channel();
        let handler: RcBlock<dyn Fn(Bool)> = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(audio_type, &handler);
        }
        rx.recv()
            .map_err(|_| "microphone permission request was cancelled".to_string())?
    };

    let speech_status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    let speech_granted = if speech_status == SFSpeechRecognizerAuthorizationStatus::Authorized {
        true
    } else if speech_status == SFSpeechRecognizerAuthorizationStatus::Denied
        || speech_status == SFSpeechRecognizerAuthorizationStatus::Restricted
    {
        false
    } else {
        let (tx, rx) = mpsc::channel();
        let handler: RcBlock<dyn Fn(SFSpeechRecognizerAuthorizationStatus)> =
            RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
                let _ = tx.send(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
            });
        unsafe {
            SFSpeechRecognizer::requestAuthorization(&handler);
        }
        rx.recv()
            .map_err(|_| "speech recognition permission request was cancelled".to_string())?
    };

    Ok(microphone_granted && speech_granted)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
#[tauri::command]
pub fn request_voice_permissions() -> Result<bool, String> {
    Ok(true)
}

#[derive(Deserialize)]
pub struct SaveWorkspaceFileRequest {
    pub url: String,
    pub filename: String,
}

#[tauri::command]
pub async fn save_workspace_file(
    app: AppHandle,
    request: SaveWorkspaceFileRequest,
) -> Result<bool, String> {
    let filename = Path::new(&request.filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download")
        .to_string();
    let target = app
        .dialog()
        .file()
        .set_title("Save file")
        .set_file_name(filename)
        .blocking_save_file();
    let Some(target) = target else {
        return Ok(false);
    };
    let path = target
        .into_path()
        .map_err(|_| "Selected destination is not a local file path".to_string())?;
    let bytes = reqwest::get(&request.url)
        .await
        .map_err(|e| format!("Download file: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download file: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Read downloaded file: {e}"))?;
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
pub async fn backend_logs_path(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.sidecar.lock().await;
    match guard.as_ref() {
        Some(s) => Ok(s.log_path().to_string_lossy().into_owned()),
        None => Err("backend not started".into()),
    }
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
        .await
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
        .await
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
        .await
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
        let _start_guard = BackendStartGuard::try_acquire(state.backend_starting.clone())
            .ok_or_else(|| "bundled backend is already starting".to_string())?;
        let mut sidecar = if let Some(token) = existing_token.as_deref() {
            Sidecar::spawn_with_desktop_token(&app, Some(token)).map_err(|e| format!("{e:#}"))?
        } else {
            Sidecar::spawn(&app).map_err(|e| format!("{e:#}"))?
        };
        let handshake = match sidecar.read_handshake(Duration::from_secs(30)).await {
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
        .await
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
mod credential_tests {
    use super::access_key_entry;
    #[cfg(target_os = "macos")]
    use super::notification_application_identifier;

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

    #[test]
    fn access_key_origin_must_be_a_canonical_http_origin() {
        assert!(access_key_entry("https://example.com").is_ok());
        assert!(access_key_entry("https://example.com/api").is_err());
        assert!(access_key_entry("ftp://example.com").is_err());
        assert!(access_key_entry("https://example.com/").is_err());
    }
}
