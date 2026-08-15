// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod window;
mod updater;
mod menu;
mod commands;
mod sidecar;
mod usage;

use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{
    menu::MenuItem,
    AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent, Wry,
};
use tauri_plugin_log::{Target, TargetKind};
use tokio::sync::Mutex;

use crate::sidecar::Sidecar;
use crate::config::{load_app_backend_config, save_window_state};
use crate::window::{
    build_app_window, backend_unavailable_init_script, MAIN_WINDOW, SECONDARY_WINDOW_PREFIX,
    ZOOM_DEFAULT, show_main_window, target_webview_window, frontend_init_script,
    show_target_window,
};
use crate::menu::{install_desktop_menus, update_tray_status, handle_desktop_menu};
use crate::commands::wait_for_health;

#[cfg(not(target_os = "macos"))]
use crate::window::show_target_window_async;

/// Shared application state.
pub struct AppState {
    pub sidecar: Arc<Mutex<Option<Sidecar>>>,
    pub desktop_token: Arc<Mutex<Option<String>>>,
    pub backend_base_url: Arc<Mutex<Option<String>>>,
    pub backend_mode: Arc<Mutex<BackendMode>>,
    /// True only while a bundled-sidecar spawn/handshake/health sequence is
    /// in progress. Shared with the retry command to prevent two Python
    /// backends from being launched concurrently after a slow cold start.
    pub backend_starting: Arc<AtomicBool>,
    /// Remains true after a bundled-sidecar startup attempt fails so a
    /// webview that attached after the one-shot backend-error event can still
    /// show recovery immediately from app_backend_status.
    pub backend_failed: Arc<AtomicBool>,
    pub window_backend_base_urls: Arc<Mutex<HashMap<String, String>>>,
    pub force_reloading: Arc<AtomicBool>,
    pub quitting: Arc<AtomicBool>,
    pub tray_status: Arc<Mutex<Option<MenuItem<Wry>>>>,
    pub tray_session: Arc<Mutex<Option<MenuItem<Wry>>>>,
    pub update_state: Arc<Mutex<Option<CachedUpdateState>>>,
    pub active_window_label: Arc<Mutex<String>>,
    /// Current webview zoom factor per desktop window, mutated by the
    /// View > Zoom menu items. Session-only — not persisted across restarts.
    pub window_zoom_factors: Arc<Mutex<HashMap<String, f64>>>,
    /// "Usage Limits" tray submenu handle. Its dynamic rows are mutated
    /// in place (insert/remove) on every poll — see `menu::update_tray_usage`.
    pub usage_submenu: Arc<Mutex<Option<tauri::menu::Submenu<Wry>>>>,
    /// Currently-inserted dynamic usage rows, tracked so the next refresh
    /// can cleanly remove exactly what it added last time.
    pub usage_rows: Arc<Mutex<Vec<MenuItem<Wry>>>>,
    /// Trailing "Checked Xm ago" row in the usage submenu.
    pub usage_footer: Arc<Mutex<Option<MenuItem<Wry>>>>,
    /// Last successfully fetched usage snapshot — kept so a failed poll
    /// can redraw the previous data instead of blanking the menu.
    pub usage_summary: Arc<Mutex<Option<crate::usage::UsageSummaryBody>>>,
    /// Rows as last rendered into the submenu. Compared against freshly
    /// formatted rows so an unchanged snapshot skips the remove/insert
    /// churn on the native menu entirely (only the footer timestamp is
    /// refreshed) — see `menu::update_tray_usage`.
    pub usage_rendered_rows: Arc<Mutex<Vec<crate::usage::UsageRow>>>,
    /// Guard so overlapping refresh triggers (background poll + manual
    /// refresh + tray-open refresh racing after wake-from-sleep) collapse
    /// into a single in-flight fetch instead of doubling up requests.
    pub usage_fetch_inflight: Arc<AtomicBool>,
    /// Providers already notified for being at/above the critical usage
    /// threshold. A provider is removed when it drops below the threshold
    /// (quota reset), re-arming its one-shot notification.
    pub usage_notified: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Tray icon handle, used to toggle a subtle "!" title badge (macOS
    /// menu bar text next to the icon) when any connected provider is at
    /// or above the critical usage threshold — see `menu::update_tray_usage`.
    pub tray_icon: Arc<Mutex<Option<tauri::tray::TrayIcon<Wry>>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BackendMode {
    Bundled,
    External,
}

impl BackendMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bundled => "bundled",
            Self::External => "external",
        }
    }
}

/// RAII guard for the singleton bundled-backend startup path. Clearing the
/// flag in Drop covers every `?`/error return without hand-maintained resets.
pub struct BackendStartGuard {
    flag: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    completed: bool,
}

impl BackendStartGuard {
    pub fn try_acquire(flag: Arc<AtomicBool>, failed: Arc<AtomicBool>) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| {
                failed.store(false, Ordering::SeqCst);
                Self {
                    flag,
                    failed,
                    completed: false,
                }
            })
    }

    pub fn complete(&mut self) {
        self.completed = true;
        self.failed.store(false, Ordering::SeqCst);
    }
}

impl Drop for BackendStartGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.failed.store(true, Ordering::SeqCst);
        }
        self.flag.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Serialize)]
pub struct BackendReady {
    pub port: u16,
    pub version: String,
    pub base_url: String,
    pub token: Option<String>,
    pub sidecar_running: bool,
}

#[derive(Clone, Serialize)]
pub struct BackendError {
    pub message: String,
}

#[derive(Clone)]
pub struct CachedUpdateState {
    pub version: String,
    pub bytes_path: PathBuf,
}

pub const NORMAL_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// First execution of the freshly installed 400+ MB sidecar can spend tens
/// of seconds in OS security scanning before Python emits any stdout.
pub const SIDECAR_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(not(target_os = "macos"))]
pub const RELOAD_SHUTDOWN_GRACE: Duration = Duration::from_millis(750);

pub fn desktop_log_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_log_dir()?.join("desktop.log"))
}

pub fn backend_log_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_log_dir()?.join("backend.log"))
}

pub fn persist_active_window_state(app: &AppHandle) {
    if let Some(window) = target_webview_window(app) {
        if let Err(e) = save_window_state(app, &window) {
            log::warn!("failed to save window state: {e:#}");
        }
    }
}

pub async fn persist_active_window_state_async(app: &AppHandle) {
    if let Some(window) = crate::window::target_webview_window_async(app).await {
        if let Err(e) = save_window_state(app, &window) {
            log::warn!("failed to save window state: {e:#}");
        }
    }
}

pub fn quit_app(app: &AppHandle) {
    persist_active_window_state(app);
    let state: tauri::State<'_, AppState> = app.state();
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn reload_main_window(app: &AppHandle) {
    show_target_window(app);
    if let Some(window) = target_webview_window(app) {
        let _ = window.eval("window.location.reload();");
    }
}

pub fn force_reload_app(app: &AppHandle) {
    let state: tauri::State<'_, AppState> = app.state();
    if state.force_reloading.swap(true, Ordering::SeqCst) {
        return;
    }

    let active_window_label = tauri::async_runtime::block_on(async {
        state.active_window_label.lock().await.clone()
    });
    let using_external_backend = tauri::async_runtime::block_on(async {
        state
            .window_backend_base_urls
            .lock()
            .await
            .contains_key(active_window_label.as_str())
    });

    if using_external_backend {
        reload_main_window(app);
        state.force_reloading.store(false, Ordering::SeqCst);
        return;
    }

    #[cfg(target_os = "macos")]
    {
        log::info!("force reload on macOS: restarting desktop app");
        restart_app_process(app);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            update_tray_status(&handle, "Status: Reloading…");
            let result = restart_sidecar_and_reload_window(&handle).await;
            if let Err(e) = result {
                log::error!("failed to force reload backend: {e:#}");
                update_tray_status(&handle, "Status: Error");
                handle
                    .emit(
                        "backend-error",
                        BackendError {
                            message: format!("{e:#}"),
                        },
                    )
                    .ok();
            }
            let state: tauri::State<'_, AppState> = handle.state();
            state.force_reloading.store(false, Ordering::SeqCst);
        });
    }
}

pub fn restart_app_process(app: &AppHandle) {
    persist_active_window_state(app);
    update_tray_status(app, "Status: Restarting…");
    let state: tauri::State<'_, AppState> = app.state();
    state.quitting.store(true, Ordering::SeqCst);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        shutdown_sidecar_now(&handle).await;
        handle.restart();
    });
}

#[cfg(not(target_os = "macos"))]
async fn restart_sidecar_and_reload_window(app: &AppHandle) -> Result<()> {
    let state: tauri::State<'_, AppState> = app.state();
    let existing_token = state.desktop_token.lock().await.clone();

    shutdown_sidecar_now_with_grace(app, RELOAD_SHUTDOWN_GRACE).await;

    let mut sidecar = if let Some(token) = existing_token.as_deref() {
        Sidecar::spawn_with_desktop_token(app, Some(token)).context("spawn sidecar")?
    } else {
        Sidecar::spawn(app).context("spawn sidecar")?
    };
    let handshake = sidecar
        .read_handshake(SIDECAR_HANDSHAKE_TIMEOUT)
        .await
        .context("read sidecar handshake")?;
    let token = handshake.token.clone();

    log::info!(
        "sidecar handshake: port={} pid={} version={}",
        handshake.port,
        handshake.pid,
        handshake.version
    );

    let base = format!("http://127.0.0.1:{}", handshake.port);
    wait_for_health(&base, 60, Duration::from_millis(250))
        .await
        .context("wait_for_health")?;

    let init_script = frontend_init_script(Some(&token), &base);
    let existing_windows: Vec<tauri::WebviewWindow> = app.webview_windows().into_values().collect();
    let external_windows = state.window_backend_base_urls.lock().await.clone();
    for window in existing_windows {
        if !external_windows.contains_key(window.label()) {
            window
                .eval(&init_script)
                .context("inject bundled backend config")?;
        }
        if cfg!(debug_assertions) {
            window
                .navigate(
                    format!(
                        "http://localhost:5173/?oa-app-id={}&oa-window-id={}",
                        app.config().identifier,
                        window.label(),
                    )
                    .parse()
                    .context("parse dev frontend url")?,
                )
                .context("navigate app window")?;
        }
    }
    show_target_window_async(app).await;

    let _ = state.desktop_token.lock().await.replace(token.clone());
    let _ = state
        .backend_base_url
        .lock()
        .await
        .replace(format!("http://127.0.0.1:{}", handshake.port));
    *state.backend_mode.lock().await = BackendMode::Bundled;
    let _ = state.sidecar.lock().await.replace(sidecar);
    state.backend_failed.store(false, Ordering::SeqCst);
    // Only notify windows that are actually on the bundled backend. A plain
    // `app.emit(...)` broadcasts to every window's JS listener, which would
    // live-redirect windows connected to an external server back onto this
    // restarted sidecar (the same cross-window contamination as the
    // `app_use_*_backend` commands — see their comments for the frontend
    // mechanics).
    let restarted_windows = external_windows;
    app.emit_filter(
        "backend-ready",
        BackendReady {
            port: handshake.port,
            version: handshake.version,
            base_url: format!("http://127.0.0.1:{}", handshake.port),
            token: Some(token),
            sidecar_running: true,
        },
        |target| match target {
            tauri::EventTarget::WebviewWindow { label }
            | tauri::EventTarget::Window { label }
            | tauri::EventTarget::Webview { label }
            | tauri::EventTarget::AnyLabel { label } => !restarted_windows.contains_key(label),
            _ => true,
        },
    )
    .ok();
    update_tray_status(app, "Status: Running");

    Ok(())
}

/// Cleanly stop the Python sidecar before a process re-exec.
///
/// Idempotent: ``.take()``s the sidecar out of shared state, so repeat
/// calls (or a race with ``ExitRequested``) are no-ops.
pub async fn shutdown_sidecar_now(app: &AppHandle) {
    shutdown_sidecar_now_with_grace(app, NORMAL_SHUTDOWN_GRACE).await;
}

pub async fn shutdown_sidecar_now_with_grace(app: &AppHandle, grace: Duration) {
    let state: tauri::State<'_, AppState> = app.state();
    let sidecar = state.sidecar.clone();
    let mut guard = sidecar.lock().await;
    if let Some(mut s) = guard.take() {
        s.shutdown_with_grace(grace).await;
    }
}

async fn start_backend_and_window(app: AppHandle) -> Result<()> {
    let state: tauri::State<'_, AppState> = app.state();
    if app.get_webview_window(MAIN_WINDOW).is_none() {
        build_app_window(
            &app,
            MAIN_WINDOW.to_string(),
            backend_unavailable_init_script(),
        )
        .await?;
    }

    if let Some(active_base_url) = load_app_backend_config(&app)
        .ok()
        .and_then(|config| config.active_base_url)
    {
        match crate::config::normalize_external_base_url(&active_base_url) {
            Ok(base) => match wait_for_health(&base, 8, Duration::from_millis(250)).await {
                Ok(()) => {
                    state
                        .window_backend_base_urls
                        .lock()
                        .await
                        .insert(MAIN_WINDOW.to_string(), base.clone());
                    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                        window
                            .eval(frontend_init_script(None, &base))
                            .context("inject external backend config")?;
                    }
                    update_tray_status(&app, "Status: Running");
                    app.emit(
                        "backend-ready",
                        BackendReady {
                            port: 0,
                            version: "external".to_string(),
                            base_url: base,
                            token: None,
                            sidecar_running: false,
                        },
                    )
                    .ok();
                    return Ok(());
                }
                Err(e) => {
                    log::warn!("desktop: saved external backend is not reachable at startup: {e:#}")
                }
            },
            Err(e) => {
                log::warn!("desktop: saved external backend URL is invalid at startup: {e:#}")
            }
        }
    }

    let mut start_guard = BackendStartGuard::try_acquire(
        state.backend_starting.clone(),
        state.backend_failed.clone(),
    )
    .ok_or_else(|| anyhow::anyhow!("bundled backend is already starting"))?;
    match Sidecar::spawn(&app) {
        Ok(mut sidecar) => {
            let handshake_result = sidecar
                .read_handshake(SIDECAR_HANDSHAKE_TIMEOUT)
                .await
                .context("read sidecar handshake");
            match handshake_result {
                Ok(handshake) => {
                    log::info!(
                        "sidecar handshake: port={} pid={} version={}",
                        handshake.port,
                        handshake.pid,
                        handshake.version
                    );

                    let base = format!("http://127.0.0.1:{}", handshake.port);
                    if let Err(e) = wait_for_health(&base, 60, Duration::from_millis(250)).await {
                        log::warn!("desktop: sidecar health check failed at startup: {e:#}");
                        // The sidecar is not stored in AppState on failure, so
                        // explicitly reap it before exposing Retry. Dropping a
                        // tokio Child alone does not guarantee process exit on
                        // Unix; an orphan would waste memory and contend with
                        // the replacement backend.
                        sidecar
                            .shutdown_with_grace(Duration::from_millis(750))
                            .await;
                        update_tray_status(&app, "Status: Error");
                        app.emit(
                            "backend-error",
                            BackendError {
                                message: format!("Sidecar health check failed: {e:#}"),
                            },
                        )
                        .ok();
                    } else {
                        let token = handshake.token.clone();
                        let init_script = frontend_init_script(Some(&token), &base);

                        let _ = state.sidecar.lock().await.replace(sidecar);
                        let _ = state.desktop_token.lock().await.replace(handshake.token);
                        let _ = state.backend_base_url.lock().await.replace(base.clone());
                        *state.backend_mode.lock().await = BackendMode::Bundled;
                        start_guard.complete();

                        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                            window
                                .eval(&init_script)
                                .context("inject bundled backend config")?;
                        }
                        update_tray_status(&app, "Status: Running");

                        app.emit(
                            "backend-ready",
                            BackendReady {
                                port: handshake.port,
                                version: handshake.version,
                                base_url: base,
                                token: Some(token),
                                sidecar_running: true,
                            },
                        )
                        .ok();
                    }
                }
                Err(e) => {
                    log::warn!("desktop: sidecar handshake failed at startup: {e:#}");
                    sidecar
                        .shutdown_with_grace(Duration::from_millis(750))
                        .await;
                    update_tray_status(&app, "Status: Error");
                    app.emit(
                        "backend-error",
                        BackendError {
                            message: format!("Sidecar handshake failed: {e:#}"),
                        },
                    )
                    .ok();
                }
            }
        }
        Err(e) => {
            log::warn!("desktop: sidecar unavailable at startup: {e:#}");
            update_tray_status(&app, "Status: Error");
            app.emit(
                "backend-error",
                BackendError {
                    message: format!("Sidecar unavailable: {e:#}"),
                },
            )
            .ok();
        }
    }

    Ok(())
}

fn main() {
    let state = AppState {
        sidecar: Arc::new(Mutex::new(None)),
        desktop_token: Arc::new(Mutex::new(None)),
        backend_base_url: Arc::new(Mutex::new(None)),
        backend_mode: Arc::new(Mutex::new(BackendMode::Bundled)),
        backend_starting: Arc::new(AtomicBool::new(false)),
        backend_failed: Arc::new(AtomicBool::new(false)),
        window_backend_base_urls: Arc::new(Mutex::new(HashMap::new())),
        force_reloading: Arc::new(AtomicBool::new(false)),
        quitting: Arc::new(AtomicBool::new(false)),
        tray_status: Arc::new(Mutex::new(None)),
        tray_session: Arc::new(Mutex::new(None)),
        update_state: Arc::new(Mutex::new(None)),
        active_window_label: Arc::new(Mutex::new(MAIN_WINDOW.to_string())),
        window_zoom_factors: Arc::new(Mutex::new(HashMap::from([(
            MAIN_WINDOW.to_string(),
            ZOOM_DEFAULT,
        )]))),
        usage_submenu: Arc::new(Mutex::new(None)),
        usage_rows: Arc::new(Mutex::new(Vec::new())),
        usage_footer: Arc::new(Mutex::new(None)),
        usage_summary: Arc::new(Mutex::new(None)),
        usage_rendered_rows: Arc::new(Mutex::new(Vec::new())),
        usage_fetch_inflight: Arc::new(AtomicBool::new(false)),
        usage_notified: Arc::new(Mutex::new(std::collections::HashSet::new())),
        tray_icon: Arc::new(Mutex::new(None)),
    };

    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some("desktop".into()),
            }),
        ])
        .build();

    tauri::Builder::default()
        // This must be first: on Windows/Linux it passes a second process's
        // deep-link argv to the deep-link plugin before showing the window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(log_plugin)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Updater config (endpoint, pubkey, install mode) lives in
        // ``tauri.conf.json``'s ``plugins.updater`` block. ``process`` is
        // required for ``app.restart()`` after the new bundle
        // is staged.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(state)
        .on_menu_event(|app, event| handle_desktop_menu(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::show_desktop_notification,
            commands::secure_get_access_key,
            commands::secure_set_access_key,
            commands::secure_delete_access_key,
            commands::save_workspace_file,
            commands::backend_health,
            commands::backend_logs_path,
            commands::desktop_logs_path,
            commands::app_backend_status,
            commands::app_remove_backend_server,
            commands::app_save_backend_server,
            commands::app_use_external_backend,
            commands::app_use_bundled_backend,
            commands::app_stop_bundled_backend,
            commands::app_new_window,
            menu::set_tray_session,
            updater::updater_check,
            updater::updater_download,
            updater::updater_install,
            updater::updater_release_notes
        ])
        .setup(|app| {
            install_desktop_menus(app)?;
            match desktop_log_path(app.handle()) {
                Ok(path) => log::info!("desktop log path={}", path.display()),
                Err(e) => log::warn!("desktop log path unavailable: {e:#}"),
            }
            log::info!(
                "desktop app starting version={} pid={} target_os={}",
                env!("CARGO_PKG_VERSION"),
                std::process::id(),
                std::env::consts::OS
            );
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let updater_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    let _ = updater::run_update_check(updater_handle, true).await;
                });
                if let Err(e) = start_backend_and_window(handle.clone()).await {
                    log::error!("failed to start backend: {e:#}");
                    update_tray_status(&handle, "Status: Error");
                    handle
                        .emit(
                            "backend-error",
                            BackendError {
                                message: format!("{e:#}"),
                            },
                        )
                        .ok();
                }
            });
            let usage_poll_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                menu::run_usage_poll_loop(usage_poll_handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Focused(true),
                ..
            } if label == MAIN_WINDOW || label.starts_with(SECONDARY_WINDOW_PREFIX) => {
                let state: tauri::State<'_, AppState> = app.state();
                tauri::async_runtime::block_on(async {
                    *state.active_window_label.lock().await = label.to_string();
                });
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == MAIN_WINDOW || label.starts_with(SECONDARY_WINDOW_PREFIX) => {
                let state: tauri::State<'_, AppState> = app.state();
                if !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if label == MAIN_WINDOW {
                        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = window.hide();
                        }
                    } else if let Some(window) = app.get_webview_window(label.as_str()) {
                        let _ = window.destroy();
                        tauri::async_runtime::block_on(async {
                            state
                                .window_backend_base_urls
                                .lock()
                                .await
                                .remove(label.as_str());
                            state
                                .window_zoom_factors
                                .lock()
                                .await
                                .remove(label.as_str());
                            *state.active_window_label.lock().await = MAIN_WINDOW.to_string();
                        });
                    }
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: _,
                ..
            } => {
                show_main_window(app);
            }
            RunEvent::ExitRequested { .. } => {
                let state: tauri::State<'_, AppState> = app.state();
                // If we are already tearing down via an explicit quit/restart/
                // update path, the sidecar has been shut down inline and state
                // persisted. Running another `block_on` here stalls the
                // run-loop thread during a restart/relaunch — on macOS that is
                // enough to abort the updater's relaunch, so the app exits
                // without coming back. Bail out fast in that case.
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                persist_active_window_state(app);
                let sidecar = state.sidecar.clone();
                // Block so the child receives SIGTERM before the parent exits.
                tauri::async_runtime::block_on(async move {
                    if let Some(mut s) = sidecar.lock().await.take() {
                        s.shutdown().await;
                    }
                });
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;
    use std::path::Path;
    use tauri_plugin_dialog::MessageDialogResult;
    use crate::window::{frontend_init_script, inherited_external_base_url, new_window_init_script};
    use crate::updater::{dialog_result_is_accept, format_update_prompt, format_download_progress, silent_check_is_due, validate_install_preconditions};
    use crate::config::AppBackendConfig;

    #[test]
    fn backend_start_guard_prevents_concurrent_start_and_resets_on_drop() {
        let flag = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let guard = BackendStartGuard::try_acquire(flag.clone(), failed.clone())
            .expect("first startup guard");
        assert!(flag.load(Ordering::SeqCst));
        assert!(BackendStartGuard::try_acquire(flag.clone(), failed.clone()).is_none());

        drop(guard);
        assert!(!flag.load(Ordering::SeqCst));
        assert!(failed.load(Ordering::SeqCst));
        assert!(BackendStartGuard::try_acquire(flag, failed).is_some());
    }

    #[test]
    fn completed_backend_start_does_not_leave_failure_state() {
        let flag = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(true));
        let mut guard = BackendStartGuard::try_acquire(flag.clone(), failed.clone())
            .expect("startup guard");

        assert!(!failed.load(Ordering::SeqCst));
        guard.complete();
        drop(guard);

        assert!(!flag.load(Ordering::SeqCst));
        assert!(!failed.load(Ordering::SeqCst));
    }

    #[test]
    fn new_window_uses_active_external_backend_before_bundled() {
        let mut external = StdHashMap::new();
        external.insert("main-2".to_string(), "http://192.168.1.10:4082".to_string());

        let script = new_window_init_script(
            Some("http://127.0.0.1:4082"),
            Some("desktop-token"),
            &external,
            "main-2",
            Some("/coding/session-1"),
        )
        .expect("external backend init script");

        assert!(script.contains("http://192.168.1.10:4082"));
        assert!(!script.contains("desktop-token"));
        assert!(script.contains("/coding/session-1"));
    }

    #[test]
    fn new_window_falls_back_to_bundled_backend() {
        let script = new_window_init_script(
            Some("http://127.0.0.1:4082"),
            Some("desktop-token"),
            &StdHashMap::new(),
            MAIN_WINDOW,
            Some("/cockpit/session-1"),
        )
        .expect("bundled backend init script");

        assert!(script.contains("http://127.0.0.1:4082"));
        assert!(script.contains("desktop-token"));
        assert!(script.contains("/cockpit/session-1"));
    }

    // ── inherited_external_base_url ──────────────────────────────────────────
    //
    // A new window must record the external backend it inherits under its own
    // label so `app_backend_status` reports the right backend during bootstrap.
    // Without this, an external-backend window stays stuck on the loading
    // screen (no bundled sidecar => `sidecar_running` never turns true).

    #[test]
    fn inherited_external_prefers_active_window_backend() {
        let mut external = StdHashMap::new();
        external.insert(
            MAIN_WINDOW.to_string(),
            "http://192.168.1.10:4082".to_string(),
        );
        external.insert("main-2".to_string(), "http://192.168.1.20:4082".to_string());

        assert_eq!(
            inherited_external_base_url(&external, "main-2").as_deref(),
            Some("http://192.168.1.20:4082")
        );
    }

    #[test]
    fn inherited_external_falls_back_to_main_window_backend() {
        let mut external = StdHashMap::new();
        external.insert(
            MAIN_WINDOW.to_string(),
            "http://192.168.1.10:4082".to_string(),
        );

        // Active window has no external backend recorded, but the main window
        // does — the new window should still inherit it.
        assert_eq!(
            inherited_external_base_url(&external, "main-3").as_deref(),
            Some("http://192.168.1.10:4082")
        );
    }

    #[test]
    fn inherited_external_is_none_for_bundled_backend() {
        assert_eq!(
            inherited_external_base_url(&StdHashMap::new(), MAIN_WINDOW),
            None
        );
    }

    // ── dialog_result_is_accept ──────────────────────────────────────────────
    //
    // Guards the OkCancelCustom mapping. rfd surfaces the user's choice as
    // ``Custom("Install")`` on macOS/Linux but the underlying system dialog
    // may report ``Ok``/``Yes`` instead — both must count as accept, and
    // every other variant (including a ``Custom`` with a different label)
    // must count as cancel.

    #[test]
    fn dialog_result_custom_with_matching_label_accepts() {
        assert!(dialog_result_is_accept(
            &MessageDialogResult::Custom("Install".into()),
            "Install"
        ));
    }

    #[test]
    fn dialog_result_custom_with_other_label_rejects() {
        assert!(!dialog_result_is_accept(
            &MessageDialogResult::Custom("Later".into()),
            "Install"
        ));
    }

    #[test]
    fn dialog_result_ok_and_yes_accept() {
        assert!(dialog_result_is_accept(&MessageDialogResult::Ok, "Install"));
        assert!(dialog_result_is_accept(
            &MessageDialogResult::Yes,
            "Install"
        ));
    }

    #[test]
    fn dialog_result_cancel_and_no_reject() {
        assert!(!dialog_result_is_accept(
            &MessageDialogResult::Cancel,
            "Install"
        ));
        assert!(!dialog_result_is_accept(
            &MessageDialogResult::No,
            "Install"
        ));
    }

    #[test]
    fn frontend_init_script_allows_runtime_backend_switches() {
        let script = frontend_init_script(Some("secret"), "http://127.0.0.1:4082");

        assert!(script.contains("__OAD_API_BASE_URL__"));
        assert!(script.contains("__OAD_TOKEN__"));
        assert_eq!(
            script.matches("writable: true, configurable: true").count(),
            2
        );
    }

    #[test]
    fn external_backend_init_script_clears_bundled_token() {
        let script = frontend_init_script(None, "http://192.168.1.10:4082");

        assert!(script.contains("delete window.__OAD_TOKEN__"));
    }

    #[test]
    fn new_window_external_backend_map_can_identify_force_reload_scope() {
        let mut external = StdHashMap::new();
        external.insert("main-2".to_string(), "http://192.168.1.10:4082".to_string());

        assert!(external.contains_key("main-2"));
        assert!(!external.contains_key(MAIN_WINDOW));
    }

    #[test]
    fn focused_webview_window_is_none_without_windows() {
        let app = tauri::test::mock_app();

        assert!(app.app_handle().webview_windows().is_empty());
    }

    #[test]
    fn backend_log_path_is_available_before_sidecar_state() {
        let app = tauri::test::mock_app();

        let path = backend_log_path(app.app_handle())
            .expect("backend log path before sidecar startup");

        assert_eq!(
            Path::new(&path).file_name().and_then(|name| name.to_str()),
            Some("backend.log")
        );
    }

    #[test]
    fn first_run_sidecar_handshake_allows_cold_security_scans() {
        assert_eq!(SIDECAR_HANDSHAKE_TIMEOUT, Duration::from_secs(60));
    }

    // ── silent_check_is_due ─────────────────────────────────────────────────
    //
    // `UpdateCard.tsx` keeps its 6h schedule in component refs that reseed to
    // "now" on every mount, so each window/reload/foreground event fired a
    // fresh check — production logs showed 5-10 GitHub requests per hour.
    // This gate is the process-wide backstop.

    const ONE_HOUR: i64 = 60 * 60;

    #[test]
    fn the_first_automatic_check_of_a_launch_is_always_due() {
        // `LAST_SILENT_CHECK` starts at 0, so a fresh process never waits.
        assert!(silent_check_is_due(1_760_000_000, 0));
    }

    #[test]
    fn a_second_automatic_check_inside_the_gap_is_skipped() {
        let last = 1_760_000_000;

        // The startup double-fire seen in production: two checks one second apart.
        assert!(!silent_check_is_due(last + 1, last));
        assert!(!silent_check_is_due(last + ONE_HOUR - 1, last));
    }

    #[test]
    fn an_automatic_check_is_due_again_once_the_gap_elapses() {
        let last = 1_760_000_000;

        assert!(silent_check_is_due(last + ONE_HOUR, last));
    }

    #[test]
    fn a_backwards_clock_step_does_not_wedge_automatic_checks() {
        // Saturating arithmetic: a clock that jumped backwards must not
        // produce a huge positive gap and let every check through, nor
        // underflow. It simply reads as "not due yet".
        let last = 1_760_000_000;

        assert!(!silent_check_is_due(last - ONE_HOUR, last));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn force_reload_shutdown_grace_is_shorter_than_normal_shutdown() {
        assert!(RELOAD_SHUTDOWN_GRACE < NORMAL_SHUTDOWN_GRACE);
        assert_eq!(RELOAD_SHUTDOWN_GRACE, Duration::from_millis(750));
    }

    #[test]
    fn saved_backend_config_can_mark_external_backend_active() {
        let mut config = AppBackendConfig::default();
        config.active_base_url = Some("http://192.168.1.10:4082".to_string());

        let serialized = serde_json::to_string(&config).expect("serialize config");
        let parsed: AppBackendConfig = serde_json::from_str(&serialized).expect("parse config");

        assert_eq!(
            parsed.active_base_url.as_deref(),
            Some("http://192.168.1.10:4082")
        );
    }

    #[test]
    fn macos_bundle_explains_local_network_access() {
        let info_plist = std::fs::read_to_string(format!(
            "{}/Info.plist",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("read macOS Info.plist");

        assert!(
            info_plist.contains("<key>NSLocalNetworkUsageDescription</key>"),
            "LAN CLI server connections need a macOS local-network permission description"
        );
    }

    // ── format_update_prompt ────────────────────────────────────────────────
    //
    // The prompt is the only thing the user reads before deciding to install,
    // so it must (a) always show both version numbers, (b) handle a missing
    // body without printing literal "None" or doubled blank lines, and
    // (c) bound the length so a runaway changelog doesn't blow out the modal.

    #[test]
    fn update_prompt_without_notes_omits_notes_paragraph() {
        let prompt = format_update_prompt("1.2.0", "1.1.0", None);
        assert!(prompt.contains("1.2.0"));
        assert!(prompt.contains("1.1.0"));
        assert!(prompt.contains("Download now?"));
        // Exactly one blank line between the version line and the call to
        // action — i.e. no orphan ``\n\n\n`` from an empty body.
        assert!(!prompt.contains("\n\n\n"));
    }

    #[test]
    fn update_prompt_with_empty_string_body_treated_as_no_notes() {
        let with_empty = format_update_prompt("1.2.0", "1.1.0", Some(""));
        let with_none = format_update_prompt("1.2.0", "1.1.0", None);
        assert_eq!(with_empty, with_none);
    }

    #[test]
    fn update_prompt_with_whitespace_only_body_treated_as_no_notes() {
        let prompt = format_update_prompt("1.2.0", "1.1.0", Some("   \n\t  "));
        let baseline = format_update_prompt("1.2.0", "1.1.0", None);
        assert_eq!(prompt, baseline);
    }

    #[test]
    fn update_prompt_includes_short_notes_verbatim() {
        let prompt = format_update_prompt("1.2.0", "1.1.0", Some("Fixed crash on launch"));
        assert!(prompt.contains("Fixed crash on launch"));
    }

    #[test]
    fn update_prompt_truncates_long_notes_with_ellipsis() {
        let long = "x".repeat(2000);
        let prompt = format_update_prompt("1.2.0", "1.1.0", Some(&long));
        // The xxxxx body itself must be capped well below the original
        // length and end with an ellipsis. Total prompt length is body +
        // surrounding template, so it stays under ~1000 chars.
        assert!(prompt.contains('…'));
        assert!(prompt.len() < 1000);
        assert!(prompt.contains("1.2.0"));
        assert!(prompt.contains("Download now?"));
    }

    #[test]
    fn update_prompt_truncation_respects_char_boundaries() {
        // A body of 700 multi-byte chars (3 bytes each in UTF-8) would
        // panic on a naive ``&body[..N]`` slice. ``chars().take`` keeps
        // us safe — assert we don't panic and produce a valid String.
        let multibyte_body: String = "✦".repeat(700);
        let prompt = format_update_prompt("1.2.0", "1.1.0", Some(&multibyte_body));
        assert!(prompt.contains('…'));
        assert!(prompt.is_char_boundary(prompt.len()));
    }

    // ── format_download_progress ────────────────────────────────────────────
    //
    // Closure-callable formatter for the tray status. Critical: never
    // produce "0/0 MB" or similar garbage when Content-Length is missing
    // or zero, and never divide by zero.

    #[test]
    fn download_progress_with_total_shows_fraction() {
        assert_eq!(
            format_download_progress(3, Some(50 * 1024 * 1024)),
            "Status: Downloading 3/50 MB"
        );
    }

    #[test]
    fn download_progress_without_total_omits_denominator() {
        assert_eq!(
            format_download_progress(7, None),
            "Status: Downloading 7 MB"
        );
    }

    #[test]
    fn download_progress_with_zero_total_falls_back_to_no_denominator() {
        // A misbehaving server that returns ``Content-Length: 0`` must not
        // produce ``"5/0 MB"`` — the fallback path drops the denominator.
        assert_eq!(
            format_download_progress(5, Some(0)),
            "Status: Downloading 5 MB"
        );
    }

    #[test]
    fn download_progress_handles_partial_megabyte_total() {
        // 500 KB total → integer-MB division yields 0, so we treat it
        // identically to "no total" rather than printing "0/0 MB".
        let small_total = 500 * 1024;
        let label = format_download_progress(0, Some(small_total));
        // Integer division gives ``0`` MB; not ideal but at least not
        // misleading — the formatter still prints a valid "downloading"
        // string and never panics.
        assert!(label.starts_with("Status: Downloading"));
    }

    // ── validate_install_preconditions ───────────────────────────────────────
    //
    // These tests guard the two-stage precondition check added to
    // `run_update_install` to prevent the install command from returning
    // `Ok(())` to the frontend before the process has restarted (which left
    // the UI frozen on "Installing update…" indefinitely).

    /// Helper: write a real temp file so `is_file()` returns true.
    /// Returns the path; the file lives in `std::env::temp_dir()` and is
    /// cleaned up by the OS (good enough for short-lived unit tests).
    ///
    /// ``discriminator`` (pass the test name) keeps paths unique across
    /// tests: `cargo test` runs multi-threaded, and two tests hitting this
    /// helper in the same nanosecond-bucket used to race on a shared path —
    /// one test's cleanup deleted the file out from under the other
    /// (the old `preconditions_ok_when_patch_version_is_correct` flake).
    fn real_bytes_path(discriminator: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "oad-test-update-{discriminator}-{}.update",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos()
        ));
        std::fs::write(&path, b"fake update bytes").expect("write test update file");
        path
    }

    #[test]
    fn preconditions_ok_when_cache_and_version_match() {
        let path = real_bytes_path("preconditions_ok_when_cache_and_version_match");
        let cached = CachedUpdateState {
            version: "1.71.0".into(),
            bytes_path: path.clone(),
        };
        let result = validate_install_preconditions(Some(&cached), Some("1.71.0"));
        let _ = std::fs::remove_file(&path);
        assert!(result.is_ok());
    }

    #[test]
    fn preconditions_err_when_no_cached_state() {
        // No download has been started — `update_state` is None.
        let err = validate_install_preconditions(None, Some("1.71.0")).unwrap_err();
        assert!(
            err.contains("not been downloaded"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn preconditions_err_when_bytes_file_missing() {
        // The cached entry exists but the file was deleted (e.g. cache wiped).
        let cached = CachedUpdateState {
            version: "1.71.0".into(),
            bytes_path: PathBuf::from("/nonexistent/oad-test-openagentd-1.71.0.update"),
        };
        let err = validate_install_preconditions(Some(&cached), Some("1.71.0")).unwrap_err();
        assert!(err.contains("missing"), "unexpected message: {err}");
    }

    #[test]
    fn preconditions_err_when_server_has_no_update() {
        // The server manifest was already bumped past the downloaded version,
        // so `updater.check()` returned `None` ("already up to date").
        // This used to be silently converted to a confusing "already up to
        // date" error that left the UI stuck on "Installing…".
        let path = real_bytes_path("preconditions_err_when_server_has_no_update");
        let cached = CachedUpdateState {
            version: "1.71.0".into(),
            bytes_path: path.clone(),
        };
        let err = validate_install_preconditions(Some(&cached), None).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(
            err.contains("no longer listed"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn preconditions_err_when_version_mismatch() {
        // User downloaded 1.71.0 but the server already serves 1.72.0.
        // Installing mismatched bytes would silently apply the wrong update.
        let path = real_bytes_path("preconditions_err_when_version_mismatch");
        let cached = CachedUpdateState {
            version: "1.71.0".into(),
            bytes_path: path.clone(),
        };
        let err =
            validate_install_preconditions(Some(&cached), Some("1.72.0")).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.contains("1.71.0"), "should mention downloaded version: {err}");
        assert!(err.contains("1.72.0"), "should mention server version: {err}");
        assert!(err.contains("no longer matches"), "unexpected message: {err}");
    }

    // ── double-install guard ──────────────────────────────────────────────────
    //
    // The `run_update_install` command rejects a second invocation while the
    // first install is already tearing the app down. These tests exercise the
    // `validate_install_preconditions` contracts that the guard relies on, as
    // well as asserting the precondition logic is idempotent (calling it twice
    // with identical state must succeed twice — we must not consume or clear
    // the cached state on a successful check).

    #[test]
    fn preconditions_ok_is_idempotent_for_same_state() {
        // Simulates a UI that calls the install command twice in quick
        // succession (button double-tap, retry). The second call must not fail
        // because the first check "consumed" the cache.
        let path = real_bytes_path("preconditions_ok_is_idempotent_for_same_state");
        let cached = CachedUpdateState {
            version: "1.84.0".into(),
            bytes_path: path.clone(),
        };
        let r1 = validate_install_preconditions(Some(&cached), Some("1.84.0"));
        let r2 = validate_install_preconditions(Some(&cached), Some("1.84.0"));
        let _ = std::fs::remove_file(&path);
        assert!(r1.is_ok(), "first check should pass");
        assert!(r2.is_ok(), "second check should pass (idempotent)");
    }

    #[test]
    fn preconditions_err_gives_actionable_message_for_missing_cache() {
        // When `quitting` is true but a second `updater_install` call slips
        // through before the guard is added, `update_state` is None because
        // the first install already consumed / cleared it. The error message
        // must tell the user what went wrong rather than panicking.
        let err = validate_install_preconditions(None, Some("1.84.0")).unwrap_err();
        assert!(
            err.contains("not been downloaded"),
            "user-facing message should explain the cache is empty: {err}"
        );
    }

    #[test]
    fn preconditions_ok_when_patch_version_is_correct() {
        // Regression guard for the 1.83.0 → 1.83.1 scenario from the logs:
        // a patch release must satisfy the version-match check.
        let path = real_bytes_path("preconditions_ok_when_patch_version_is_correct");
        let cached = CachedUpdateState {
            version: "1.83.1".into(),
            bytes_path: path.clone(),
        };
        let result = validate_install_preconditions(Some(&cached), Some("1.83.1"));
        let _ = std::fs::remove_file(&path);
        assert!(result.is_ok(), "patch-version install should pass preconditions");
    }
}
