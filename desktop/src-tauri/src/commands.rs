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
    backend_log_path, AppState, BackendMode, BackendReady,
};
use crate::lifecycle::{AttemptCause, Commit, Refused};
use crate::sidecar::StartFailure;
use crate::config::{
    load_app_backend_config, normalize_external_base_url, normalize_server_name,
    remove_app_backend_server, save_app_backend_config, AppBackendStatus,
};
use crate::window::{create_app_window, frontend_init_script, show_main_window};
use crate::menu::update_tray_status;
use crate::servers::ServerId;
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

/// How long a question's notification waits for the server to say what its
/// options are; past it the notification shows with "Open to answer" alone.
const QUESTION_WAIT: Duration = Duration::from_secs(3);

/// A notification's buttons, in order, as (id, label): one per option of a
/// question that can be answered in place, and the way into the app. A click
/// on the notification itself is `default`, the same as that one.
///
/// With `open_first` the way into the app leads. macOS folds several actions
/// into one "Options" dropdown, and notify-rust answers a click on the
/// dropdown's face with the *first* action: that must open the app, never
/// answer a question by accident. Elsewhere the options lead.
fn notification_actions(choices: &[String], asks: bool, open_first: bool) -> Vec<(String, String)> {
    let mut actions: Vec<(String, String)> = choices
        .iter()
        .take(crate::answers::MAX_QUICK_CHOICES)
        .enumerate()
        .map(|(index, choice)| (format!("answer:{index}"), choice.clone()))
        .collect();
    let open = ("default".to_string(), if asks { "Open to answer" } else { "Open" }.to_string());
    if open_first {
        actions.insert(0, open);
    } else {
        actions.push(open);
    }
    actions
}

/// The option an action id picks (`answer:<index>`), if it is one.
fn picked_choice<'a>(action: &str, choices: &'a [String]) -> Option<&'a str> {
    let index: usize = action.strip_prefix("answer:")?.parse().ok()?;
    choices.get(index).map(String::as_str)
}

/// The question a notification is about, from the server, when it is one.
/// Runs on the notification's own thread, never the async runtime's.
fn open_question(app: &AppHandle, server: &ServerId, payload: &DesktopNotificationPayload) -> Option<crate::answers::OpenQuestion> {
    if payload.kind != "input_needed" {
        return None;
    }
    let session_id = payload.session_id.as_deref()?;
    match wait_on_thread(QUESTION_WAIT, crate::answers::fetch_question(app, server, session_id)) {
        Some(Ok(question)) => question,
        Some(Err(error)) => {
            log::debug!("desktop_notification_question_unavailable error={error:#}");
            None
        }
        None => None,
    }
}

/// Run `work` to completion from a plain thread, giving up after `wait`.
/// The timeout is made inside the future `block_on` drives: a Tokio timer
/// needs the runtime when it is created, and a plain thread has none.
fn wait_on_thread<F: std::future::Future>(wait: Duration, work: F) -> Option<F::Output> {
    tauri::async_runtime::block_on(async move { tokio::time::timeout(wait, work).await.ok() })
}

/// A click on a notification: open its session through the shared router
/// (the window that shows it, else the server's). With no session, or if the
/// router fails, bring the asking window (or any) forward.
fn open_from_notification(app: &AppHandle, sender: &str, server: ServerId, session_id: Option<&str>) {
    if let Some(session_id) = session_id {
        let opened = crate::island::open_session(app, server, session_id, crate::island::OpenIn::Existing, false);
        match tauri::async_runtime::block_on(opened) {
            Ok(()) => return,
            Err(error) => log::warn!("desktop_notification_open_failed error={error:#}"),
        }
    }
    match app.get_webview_window(sender) {
        Some(window) => crate::window::show_window(&window),
        None => show_main_window(app),
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
    // The desktop pet is on screen and shows this kind in its bubble
    // instead (its own feed gets the same event; each shows once).
    let bubble = crate::pet::bubble_from_request(
        &payload.kind,
        payload.notification_id.as_deref(),
        payload.session_id.as_deref(),
        &payload.title,
        &payload.body,
    );
    if crate::pet::take_banner(&app, window.label(), bubble) {
        return Ok(false);
    }
    // Past the cap the notification is still delivered, just without its
    // actions — with no actions `needs_response()` is false, so
    // `wait_for_action` sends and returns instead of parking the thread.
    // Losing click-routing on a backlogged notification beats leaking an
    // unbounded number of threads.
    let routes_clicks = claim_notification_slot();
    // The asking window is on the session's server, which the focused window
    // may not be: that is where the session, and its question, live.
    let sender = window.label().to_string();
    let server = crate::servers::window_server(&sender, &crate::servers::external_map(&app));
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        ensure_notification_application(&app);
        // A question the shell can answer gets its options as buttons: the
        // notification APIs carry them as actions (XDG actions on Linux, a
        // dropdown beside the macOS banner, buttons on a Windows toast).
        let question = if routes_clicks { open_question(&app, &server, &payload) } else { None };
        let choices = question.as_ref().map(|q| q.quick_choices()).unwrap_or_default();
        let asks = payload.kind == "input_needed" && payload.session_id.is_some();
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&crate::pet::display_title(&payload.kind, &payload.title))
            .body(&payload.body);
        if routes_clicks {
            for (id, label) in notification_actions(&choices, asks, cfg!(target_os = "macos")) {
                notification.action(&id, &label);
            }
        }

        match notification.show() {
            Ok(handle) => handle.wait_for_action(move |action| {
                if let (Some(choice), Some(question), Some(session_id)) =
                    (picked_choice(action, &choices), question.as_ref(), payload.session_id.as_deref())
                {
                    // A button: post the answer. If the server refuses it
                    // (not a "no longer open", which clears the question
                    // everywhere), open the session to answer it there.
                    let answers = vec![vec![choice.to_string()]];
                    let sent = crate::island::answer_question(&app, &server, session_id, &question.id, &answers);
                    if let Err(error) = tauri::async_runtime::block_on(sent) {
                        log::warn!("desktop_notification_answer_failed error={error:#}");
                        open_from_notification(&app, &sender, server, Some(session_id));
                    }
                    return;
                }
                if action != "default" {
                    return;
                }
                open_from_notification(&app, &sender, server, payload.session_id.as_deref());
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
    Ok(state.sidecar.alive().await)
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
    let sidecar_running = state.sidecar.alive().await;
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
    let sidecar_alive = state.sidecar.alive().await;

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

/// Why [`start_bundled`] did not produce a newly started backend.
#[derive(Debug)]
pub enum StartError {
    /// Not attempted: another attempt owns the start, a child already runs,
    /// or (recovery) a later stop/start superseded it.
    Refused(Refused),
    /// Spawn, handshake or health failed; the child is already reaped.
    Failed(StartFailure),
    /// Healthy, but a stop was decided meanwhile; the child was shut down.
    Superseded,
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refused) => std::fmt::Display::fmt(refused, f),
            Self::Failed(failure) => std::fmt::Display::fmt(failure, f),
            Self::Superseded => f.write_str("bundled backend was stopped while it started"),
        }
    }
}

/// Start the bundled sidecar (reusing the desktop token, so open windows
/// stay authenticated) as one owned attempt: spawn, handshake and health
/// via `sidecar::start_ready`, then publish unless a stop came first.
/// Shared by "use bundled backend", the crash watcher and update recovery.
pub async fn start_bundled(app: &AppHandle, cause: AttemptCause) -> Result<BackendReady, StartError> {
    let state: tauri::State<'_, AppState> = app.state();
    let attempt = state
        .sidecar
        .begin(cause, &state.backend_starting, &state.backend_failed)
        .await
        .map_err(StartError::Refused)?;
    let existing_token = state.desktop_token.lock().await.clone();
    // On failure `attempt` drops here, after the child was reaped.
    let started = crate::sidecar::start_ready(app, existing_token.as_deref(), attempt.superseded())
        .await
        .map_err(StartError::Failed)?;
    let Some(ready) = started else {
        // A stop came while it started; the child is already shut down.
        attempt.finish_superseded();
        return Err(StartError::Superseded);
    };
    let (handshake, base) = (ready.handshake, ready.base);
    match state.sidecar.commit(attempt, ready.sidecar).await {
        Commit::Published { replaced } => {
            if let Some(mut old) = replaced {
                old.shutdown_with_grace(Duration::from_millis(750)).await;
            }
        }
        Commit::Superseded(mut sidecar) => {
            log::info!("bundled backend start superseded by a stop; shutting it down");
            sidecar.shutdown_with_grace(Duration::from_millis(750)).await;
            return Err(StartError::Superseded);
        }
    }

    let token = handshake.token.clone();
    let _ = state.desktop_token.lock().await.replace(token.clone());
    let _ = state.backend_base_url.lock().await.replace(base.clone());
    update_tray_status(app, "Status: Running");
    crate::network_access::reapply(app);

    Ok(BackendReady {
        port: handshake.port,
        version: handshake.version,
        base_url: base,
        token: Some(token),
        sidecar_running: true,
    })
}

/// [`start_bundled`] on request. A backend that is already running counts
/// as started (a concurrent request won the race).
pub async fn start_bundled_sidecar(app: &AppHandle) -> Result<BackendReady, String> {
    match start_bundled(app, AttemptCause::Requested).await {
        Ok(ready) => Ok(ready),
        Err(StartError::Refused(Refused::AlreadyRunning)) => {
            let state: tauri::State<'_, AppState> = app.state();
            let base_url = state
                .backend_base_url
                .lock()
                .await
                .clone()
                .ok_or_else(|| "bundled backend is not ready".to_string())?;
            let token = state.desktop_token.lock().await.clone();
            Ok(BackendReady {
                port: 0,
                version: "bundled".to_string(),
                base_url,
                token,
                sidecar_running: true,
            })
        }
        Err(e) => Err(e.to_string()),
    }
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
    // One window per session: a window that already shows it comes forward
    // instead of a second one opening (⌘-click on a session that is open).
    if let Some(session_id) = initial_path.as_deref().and_then(crate::island::session_id_from_path) {
        if crate::island::focus_window_showing(&app, &session_id) {
            return Ok(());
        }
    }
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
        claim_notification_slot, first_notification_request, notification_actions, picked_choice,
        wait_on_thread, MAX_PENDING_NOTIFICATIONS, MAX_SEEN_NOTIFICATIONS, PENDING_NOTIFICATIONS,
    };
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    #[cfg(target_os = "macos")]
    use super::notification_application_identifier;

    // Access-key and download behaviour is tested once in
    // `openagentd-shell-core`; the desktop keeps only what is desktop-only.

    // ── wait_on_thread ──────────────────────────────────────────────────
    //
    // A notification asks the server for its question from its own std
    // thread, outside any Tokio context. A question notification panicked
    // there ("there is no reactor running") and never showed.

    #[test]
    fn a_timed_wait_runs_from_a_plain_thread() {
        let got = std::thread::spawn(|| wait_on_thread(Duration::from_secs(5), async { 7 }))
            .join()
            .expect("the wait must not panic outside the async runtime");
        assert_eq!(got, Some(7));
    }

    #[test]
    fn a_timed_wait_gives_up_after_its_limit() {
        let got = std::thread::spawn(|| wait_on_thread(Duration::from_millis(20), std::future::pending::<()>()))
            .join()
            .expect("the wait must not panic outside the async runtime");
        assert_eq!(got, None);
    }

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

    fn labels(actions: &[(String, String)]) -> Vec<&str> {
        actions.iter().map(|(_, label)| label.as_str()).collect()
    }

    #[test]
    fn a_notification_keeps_its_single_open_button_unless_it_asks_something() {
        let plain = notification_actions(&[], false, false);
        assert_eq!(plain, [("default".to_string(), "Open".to_string())]);
        // A question that can't be answered here still says what opening does.
        assert_eq!(labels(&notification_actions(&[], true, false)), ["Open to answer"]);
    }

    #[test]
    fn a_question_gets_one_button_per_option_and_a_way_into_the_app() {
        let choices = vec!["Wait for Work".to_string(), "Use Auto".to_string()];
        let actions = notification_actions(&choices, true, false);
        assert_eq!(labels(&actions), ["Wait for Work", "Use Auto", "Open to answer"]);
        assert_eq!(actions.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["answer:0", "answer:1", "default"]);

        // Windows toasts take five buttons; four options and Open fit.
        let many: Vec<String> = (0..9).map(|i| format!("Option {i}")).collect();
        assert_eq!(notification_actions(&many, true, false).len(), crate::answers::MAX_QUICK_CHOICES + 1);
    }

    // notify-rust turns a click on macOS's "Options" button itself into the
    // first action: that must not be an answer.
    #[test]
    fn on_macos_the_way_into_the_app_leads_so_a_stray_click_never_answers() {
        let choices = vec!["Wait for Work".to_string(), "Use Auto".to_string()];
        let actions = notification_actions(&choices, true, true);
        assert_eq!(actions[0].0, "default");
        assert_eq!(labels(&actions), ["Open to answer", "Wait for Work", "Use Auto"]);
    }

    #[test]
    fn a_clicked_action_picks_its_option_and_nothing_else_does() {
        let choices = vec!["Wait for Work".to_string(), "Use Auto".to_string()];
        assert_eq!(picked_choice("answer:1", &choices), Some("Use Auto"));
        for other in ["default", "__closed", "answer:2", "answer:x", "answer:", "Use Auto"] {
            assert_eq!(picked_choice(other, &choices), None, "{other}");
        }
    }
}
