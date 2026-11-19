// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod diagnostics;
mod answers;
mod window;
mod updater;
mod menu;
mod commands;
mod sidecar;
mod lifecycle;
mod usage;
mod tray_popup;
mod island;
mod pet;
mod watchdog;
mod remote_update;
mod network_access;
mod preview_relay;
mod servers;
mod shell_prefs;
mod badge;
mod context_menu;
mod app_menu;
mod account;
mod approval;
mod presence;
mod haptics;
mod global_shortcuts;
mod caption;
mod autostart;
mod window_session;
mod notifications;

use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex, OnceLock,
};
use std::time::{Duration, Instant};
use tauri::{
    menu::MenuItem,
    AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent, Wry,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tokio::sync::Mutex;

use crate::lifecycle::{Attempt, AttemptCause, Commit, SidecarSlot};
use crate::sidecar::Sidecar;
use crate::config::save_window_state;
use crate::window::{
    build_app_window, backend_unavailable_init_script_at, MAIN_WINDOW, SECONDARY_WINDOW_PREFIX,
    ZOOM_DEFAULT, show_main_window, target_webview_window, frontend_init_script,
    show_target_window,
};
use crate::menu::{install_desktop_menus, update_tray_status, handle_desktop_menu};

static LAUNCHED: OnceLock<Instant> = OnceLock::new();

/// Milliseconds since launch, so `desktop.log` (whole seconds) shows where a
/// slow start spends its time.
pub fn launch_ms() -> u128 {
    LAUNCHED.get_or_init(Instant::now).elapsed().as_millis()
}

/// Write panics to `desktop.log` as well. Release builds use the Windows GUI
/// subsystem and are started from Finder or the Start menu, so the default
/// hook's stderr output goes nowhere. The previous hook still runs.
fn log_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        previous(info);
    }));
}

/// WebKitGTK's DMA-BUF renderer draws a blank or white window with the
/// proprietary NVIDIA driver (common on Wayland). Turn it off there, before
/// any webview starts, unless the user already chose a value.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn dmabuf_workaround_needed(already_set: bool, nvidia_driver: bool) -> bool {
    !already_set && nvidia_driver
}

#[cfg(target_os = "linux")]
fn apply_linux_webview_workarounds() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if dmabuf_workaround_needed(std::env::var_os(VAR).is_some(), nvidia) {
        // Still single-threaded: nothing else reads the environment yet.
        std::env::set_var(VAR, "1");
    }
}

/// Shared application state.
pub struct AppState {
    /// The bundled sidecar and every decision about who owns it (see
    /// `lifecycle`). Start, stop, crash takeover and reload go through it.
    pub sidecar: Arc<SidecarSlot<Sidecar>>,
    pub desktop_token: Arc<Mutex<Option<String>>>,
    pub backend_base_url: Arc<Mutex<Option<String>>>,
    pub backend_mode: Arc<Mutex<BackendMode>>,
    /// True only while a bundled-sidecar spawn/handshake/health sequence is
    /// in progress. Shared with the retry command to prevent two sidecar
    /// backends from being launched concurrently after a slow cold start.
    pub backend_starting: Arc<AtomicBool>,
    /// Remains true after a bundled-sidecar startup attempt fails so a
    /// webview that attached after the one-shot backend-error event can still
    /// show recovery immediately from app_backend_status.
    pub backend_failed: Arc<AtomicBool>,
    /// Plain-data window metadata (std mutexes, not tokio): the critical
    /// sections are short clone/insert/remove only and are never held
    /// across an `await`, so the main-thread event handlers (focus, close,
    /// menu) can lock them directly instead of `block_on`-ing the async
    /// runtime — which stalls the UI thread whenever a background task
    /// holds the lock.
    pub window_backend_base_urls: Arc<StdMutex<HashMap<String, String>>>,
    /// Whole-app intent, independent of the sidecar's phase: a force
    /// reload is running.
    pub force_reloading: Arc<AtomicBool>,
    /// Whole-app intent: the app is exiting or re-executing (quit, restart,
    /// an update past verification). Windows close for real and the
    /// watchdog stops recovering.
    pub quitting: Arc<AtomicBool>,
    /// The one update install operation in flight (`updater::InstallLease`).
    /// Separate from `quitting`: an install owns this from its first
    /// precondition and only sets `quitting` once the bytes are verified.
    pub update_install: Arc<AtomicBool>,
    pub tray_status: Arc<Mutex<Option<MenuItem<Wry>>>>,
    pub tray_session: Arc<Mutex<Option<MenuItem<Wry>>>>,
    pub update_state: Arc<Mutex<Option<CachedUpdateState>>>,
    pub active_window_label: Arc<StdMutex<String>>,
    /// Current webview zoom factor per desktop window, mutated by the
    /// View > Zoom menu items. Session-only — not persisted across restarts.
    pub window_zoom_factors: Arc<StdMutex<HashMap<String, f64>>>,
    /// "Usage Limits" tray submenu handle. Its dynamic rows are mutated
    /// in place (insert/remove) on every poll — see `menu::update_tray_usage`.
    pub usage_submenu: Arc<Mutex<Option<tauri::menu::Submenu<Wry>>>>,
    /// Currently-inserted dynamic usage rows, tracked so the next refresh
    /// can cleanly remove exactly what it added last time.
    pub usage_rows: Arc<Mutex<Vec<MenuItem<Wry>>>>,
    /// Trailing "Checked Xm ago" row in the usage submenu.
    pub usage_footer: Arc<Mutex<Option<MenuItem<Wry>>>>,
    /// Usage readings per server: the last good snapshot (so a failed poll
    /// can redraw the previous data instead of blanking the menu), the
    /// latest error, and which providers were already alerted on.
    pub usage: Arc<Mutex<crate::usage::UsageCache>>,
    /// Rows as last rendered into the submenu. Compared against freshly
    /// formatted rows so an unchanged snapshot skips the remove/insert
    /// churn on the native menu entirely (only the footer timestamp is
    /// refreshed) — see `menu::update_tray_usage`.
    pub usage_rendered_rows: Arc<Mutex<Vec<crate::usage::UsageRow>>>,
    /// Usage fetches in flight (see `usage::InflightFetches`).
    pub usage_fetch_inflight: Arc<crate::usage::InflightFetches>,
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
/// Size cap for one `desktop.log` generation. The plugin's 40 KB default
/// kept less than a day of history.
pub const DESKTOP_LOG_MAX_BYTES: u128 = 5 * 1024 * 1024;
/// First execution of a freshly installed sidecar can spend tens of seconds
/// in OS security scanning (Gatekeeper, Defender) before it emits stdout.
pub const SIDECAR_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(not(target_os = "macos"))]
pub const RELOAD_SHUTDOWN_GRACE: Duration = Duration::from_millis(750);

pub fn desktop_log_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_log_dir()?.join("desktop.log"))
}

pub fn backend_log_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_log_dir()?.join("backend.log"))
}

/// Before the app goes away (quit, restart, an update): keep the active
/// window's frame for the next new window, and the list of open windows for
/// the next launch (`window_session`).
pub fn persist_active_window_state(app: &AppHandle) {
    if let Some(window) = target_webview_window(app) {
        if let Err(e) = save_window_state(app, &window) {
            log::warn!("failed to save window state: {e:#}");
        }
    }
    window_session::save(app);
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

    // Runs on the menu-event (main) thread — plain std mutexes, no
    // `block_on` of the async runtime here (see the AppState field docs).
    let using_external_backend = {
        let active_window_label = state.active_window_label.lock().unwrap().clone();
        state
            .window_backend_base_urls
            .lock()
            .unwrap()
            .contains_key(active_window_label.as_str())
    };

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
                update_tray_status(&handle, crate::menu::TRAY_STATUS_FAILED);
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
    // One owned attempt: no other start can spawn a second child meanwhile,
    // and a Stop during the reload is not undone by it.
    let mut attempt = match state
        .sidecar
        .begin(AttemptCause::Reload, &state.backend_starting, &state.backend_failed)
        .await
    {
        Ok(attempt) => attempt,
        Err(crate::lifecycle::Refused::AlreadyStarting) => {
            log::info!("force reload skipped: a bundled backend start is in progress");
            return Ok(());
        }
        Err(refused) => anyhow::bail!("{refused}"),
    };
    let existing_token = state.desktop_token.lock().await.clone();

    if let Some(mut old) = state.sidecar.take_for_reload(&mut attempt).await {
        old.shutdown_with_grace(RELOAD_SHUTDOWN_GRACE).await;
    }

    // A failed attempt is already reaped; dropping `attempt` records it.
    let started = crate::sidecar::start_ready(app, existing_token.as_deref(), attempt.superseded())
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.startup_message()))?;
    let Some(ready) = started else {
        log::info!("force reload superseded by a stop while it started");
        attempt.finish_superseded();
        return Ok(());
    };
    let crate::sidecar::Ready { sidecar, handshake, base } = ready;
    match state.sidecar.commit(attempt, sidecar).await {
        Commit::Published { replaced } => {
            if let Some(mut old) = replaced {
                old.shutdown_with_grace(RELOAD_SHUTDOWN_GRACE).await;
            }
        }
        Commit::Superseded(mut sidecar) => {
            log::info!("force reload superseded by a stop; shutting the new backend down");
            sidecar.shutdown_with_grace(RELOAD_SHUTDOWN_GRACE).await;
            return Ok(());
        }
    }
    let token = handshake.token.clone();

    let init_script = frontend_init_script(Some(&token), &base);
    // Overlays (tray popup, island) never hold the backend token.
    let existing_windows: Vec<tauri::WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| !crate::window::is_overlay_window(w.label()))
        .collect();
    let external_windows = state.window_backend_base_urls.lock().unwrap().clone();
    for window in existing_windows {
        if !external_windows.contains_key(window.label()) {
            window
                .eval(&init_script)
                .context("inject bundled backend config")?;
        }
        if cfg!(debug_assertions) {
            window
                .navigate(
                    crate::window::frontend_dev_url(
                        crate::window::configured_dev_url(app).as_deref(),
                        &app.config().identifier,
                        window.label(),
                    )
                    .parse()
                    .context("parse dev frontend url")?,
                )
                .context("navigate app window")?;
        }
    }
    show_target_window(app);

    let _ = state.desktop_token.lock().await.replace(token.clone());
    let _ = state
        .backend_base_url
        .lock()
        .await
        .replace(format!("http://127.0.0.1:{}", handshake.port));
    *state.backend_mode.lock().await = BackendMode::Bundled;
    crate::network_access::reapply(app);
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

/// Deliberately stop the backend sidecar (Stop, restart, update).
///
/// Idempotent: takes the sidecar out of shared state, so repeat calls (or a
/// race with ``ExitRequested``) are no-ops. It also supersedes any start
/// attempt or crash recovery that began earlier, so none of them brings
/// the backend back afterwards; an attempt in flight shuts its own child
/// down. Returns whether a bundled backend was running, starting or
/// awaiting crash recovery (what a failed update brings back).
pub async fn shutdown_sidecar_now(app: &AppHandle) -> bool {
    shutdown_sidecar_now_with_grace(app, NORMAL_SHUTDOWN_GRACE).await
}

pub async fn shutdown_sidecar_now_with_grace(app: &AppHandle, grace: Duration) -> bool {
    let state: tauri::State<'_, AppState> = app.state();
    let stopped = state.sidecar.stop().await;
    if let Some(mut s) = stopped.child {
        s.shutdown_with_grace(grace).await;
    }
    stopped.had_backend
}

/// The backend a launch settled on, before it is published to the window.
enum StartedBackend {
    Bundled {
        ready: Box<crate::sidecar::Ready>,
        attempt: Attempt<crate::sidecar::Sidecar>,
    },
    /// A stop came while it started; the child is already shut down.
    Superseded,
    /// Why the bundled backend could not start (shown with Retry).
    Failed(String),
}

/// Build the main window while `backend` starts, publish the backend, then
/// open the other windows of the last run (`window_session`). A main window
/// that was on another computer waits for the backend too: the page of a
/// window on an external server must not hear the built-in server's
/// `backend-ready`. A launch at login passes `with_window` false and builds
/// none; its windows come back when the app is first opened.
///
/// `backend` must be spawned outside the runtime (from `setup`). Building a
/// window blocks this task's worker until the main thread has built it, and a
/// task spawned from a worker waits in that worker's LIFO slot, which other
/// workers cannot steal, so it would not start before the window.
async fn start_backend_and_window(
    app: AppHandle,
    backend: tauri::async_runtime::JoinHandle<Result<StartedBackend>>,
    with_window: bool,
) -> Result<()> {
    let saved = if with_window { window_session::load(&app) } else { Vec::new() };
    let first = window_session::first_window(&saved).filter(|_| with_window && app.get_webview_window(MAIN_WINDOW).is_none());
    let window = match first {
        Some((path, frame)) => {
            let built = build_app_window(&app, MAIN_WINDOW.to_string(), backend_unavailable_init_script_at(&path), frame).await;
            window_session::came_back(&saved, MAIN_WINDOW);
            built.map(|_| ())
        }
        None => Ok(()),
    };
    let started = backend.await.map_err(|e| anyhow::anyhow!("backend start task: {e}"))??;
    publish_backend(&app, started).await?;
    window?;
    if with_window {
        window_session::restore(&app, &saved).await;
        if crate::servers::app_window_labels(&app).is_empty() {
            // None of them could open (their computers are gone and the
            // built-in server did not start): the main window says so.
            crate::window::create_app_window(&app, Some(MAIN_WINDOW), None).await?;
        }
    }
    Ok(())
}

/// Spawn the bundled sidecar and wait until it is healthy. Touches no
/// window, so it can run while one builds. The app itself never picks a
/// saved server: a window is on one only because the person chose it in
/// Choose Server, in this run or in the one whose windows come back.
async fn start_backend(app: AppHandle) -> Result<StartedBackend> {
    let state: tauri::State<'_, AppState> = app.state();
    let attempt = state
        .sidecar
        .begin(AttemptCause::Requested, &state.backend_starting, &state.backend_failed)
        .await
        .map_err(|refused| anyhow::anyhow!("{refused}"))?;
    // A launch generates a fresh desktop token.
    match crate::sidecar::start_ready(&app, None, attempt.superseded()).await {
        Ok(Some(ready)) => Ok(StartedBackend::Bundled { ready: Box::new(ready), attempt }),
        Ok(None) => {
            attempt.finish_superseded();
            Ok(StartedBackend::Superseded)
        }
        Err(failure) => {
            // The child is already reaped; dropping `attempt` records the
            // failure so a late webview still sees Retry.
            log::warn!("desktop: sidecar start failed at startup: {}", failure.startup_message());
            Ok(StartedBackend::Failed(failure.startup_message()))
        }
    }
}

/// Hand the backend to the main window, the tray and the frontend.
async fn publish_backend(app: &AppHandle, started: StartedBackend) -> Result<()> {
    let state: tauri::State<'_, AppState> = app.state();
    match started {
        StartedBackend::Bundled { ready, attempt } => {
            let crate::sidecar::Ready { sidecar, handshake, base } = *ready;
            match state.sidecar.commit(attempt, sidecar).await {
                Commit::Published { replaced } => {
                    if let Some(mut old) = replaced {
                        old.shutdown_with_grace(Duration::from_millis(750)).await;
                    }
                }
                Commit::Superseded(mut sidecar) => {
                    log::info!("startup: bundled backend stopped before it was published");
                    sidecar.shutdown_with_grace(Duration::from_millis(750)).await;
                    return Ok(());
                }
            }
            let token = handshake.token.clone();
            let init_script = frontend_init_script(Some(&token), &base);

            let _ = state.desktop_token.lock().await.replace(handshake.token);
            let _ = state.backend_base_url.lock().await.replace(base.clone());
            *state.backend_mode.lock().await = BackendMode::Bundled;
            crate::network_access::reapply(app);

            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                window
                    .eval(&init_script)
                    .context("inject bundled backend config")?;
            }
            update_tray_status(app, "Status: Running");
            log::info!("startup: bundled backend ready at_ms={}", launch_ms());

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
        StartedBackend::Superseded => {
            log::info!("startup: bundled backend stopped while it started");
        }
        StartedBackend::Failed(message) => {
            update_tray_status(app, crate::menu::TRAY_STATUS_FAILED);
            app.emit("backend-error", BackendError { message }).ok();
        }
    }
    Ok(())
}

fn main() {
    LAUNCHED.get_or_init(Instant::now);
    log_panics();
    #[cfg(target_os = "linux")]
    apply_linux_webview_workarounds();
    let state = AppState {
        sidecar: Arc::new(SidecarSlot::default()),
        desktop_token: Arc::new(Mutex::new(None)),
        backend_base_url: Arc::new(Mutex::new(None)),
        backend_mode: Arc::new(Mutex::new(BackendMode::Bundled)),
        backend_starting: Arc::new(AtomicBool::new(false)),
        backend_failed: Arc::new(AtomicBool::new(false)),
        window_backend_base_urls: Arc::new(StdMutex::new(HashMap::new())),
        force_reloading: Arc::new(AtomicBool::new(false)),
        quitting: Arc::new(AtomicBool::new(false)),
        update_install: Arc::new(AtomicBool::new(false)),
        tray_status: Arc::new(Mutex::new(None)),
        tray_session: Arc::new(Mutex::new(None)),
        update_state: Arc::new(Mutex::new(None)),
        active_window_label: Arc::new(StdMutex::new(MAIN_WINDOW.to_string())),
        window_zoom_factors: Arc::new(StdMutex::new(HashMap::from([(
            MAIN_WINDOW.to_string(),
            ZOOM_DEFAULT,
        )]))),
        usage_submenu: Arc::new(Mutex::new(None)),
        usage_rows: Arc::new(Mutex::new(Vec::new())),
        usage_footer: Arc::new(Mutex::new(None)),
        usage: Arc::new(Mutex::new(crate::usage::UsageCache::default())),
        usage_rendered_rows: Arc::new(Mutex::new(Vec::new())),
        usage_fetch_inflight: Arc::new(crate::usage::InflightFetches::default()),
        tray_icon: Arc::new(Mutex::new(None)),
    };

    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        // The plugin defaults to a 40 KB cap with `KeepOne`, which silently
        // discards the previous file — a production `desktop.log` held under
        // a day of history, so anything older than the last 40 KB was gone
        // before a user could report it. "View Desktop Log" is the primary
        // support artifact; give it room and keep a few generations.
        .max_file_size(DESKTOP_LOG_MAX_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(3))
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
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Updater config (endpoint, pubkey, install mode) lives in
        // ``tauri.conf.json``'s ``plugins.updater`` block.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(state)
        .manage(preview_relay::PreviewRelays::default())
        .on_menu_event(|app, event| {
            if !island::handle_menu_event(app, event.id().as_ref()) && !pet::handle_menu_event(app, event.id().as_ref()) {
                handle_desktop_menu(app, event.id().as_ref());
            }
        })
        .invoke_handler(tauri::generate_handler![
            notifications::show_desktop_notification,
            commands::secure_get_access_key,
            commands::secure_set_access_key,
            commands::secure_delete_access_key,
            commands::set_window_theme,
            commands::save_workspace_file,
            commands::backend_logs_path,
            commands::app_backend_status,
            commands::app_remove_backend_server,
            commands::app_save_backend_server,
            commands::app_set_backend_server_enabled,
            commands::app_remember_computer_name,
            commands::app_use_external_backend,
            commands::app_use_bundled_backend,
            commands::app_stop_bundled_backend,
            commands::app_start_bundled_backend,
            account::cloud_open_computer,
            account::cloud_rename_computer,
            account::desktop_cloud_call,
            account::cloud_poke,
            account::cloud_link_route,
            commands::app_new_window,
            commands::app_network_access_status,
            commands::app_set_network_access,
            commands::app_network_access_key,
            commands::app_set_network_access_key,
            preview_relay::preview_relay_open,
            preview_relay::preview_relay_close,
            menu::set_tray_session,
            app_menu::set_menu_text_size,
            context_menu::show_app_menu,
            caption::show_snap_layouts,
            badge::set_attention_badge,
            presence::cloud_approval_proof,
            haptics::haptic_alignment,
            tray_popup::get_tray_usage_summary,
            tray_popup::tray_action,
            tray_popup::tray_fit,
            island::island_state,
            island::island_fit,
            island::island_open_session,
            island::island_retry,
            island::island_fix_key,
            island::island_context_menu,
            island::island_viewing,
            island::session_read,
            island::island_settings,
            island::island_update_settings,
            island::app_server_watch_states,
            pet::pet_state,
            pet::pet_fit,
            pet::pet_open,
            pet::pet_dismiss,
            pet::pet_drag_end,
            pet::pet_menu,
            pet::pet_settings,
            pet::pet_update_settings,
            updater::updater_check,
            updater::updater_download,
            updater::updater_install,
            updater::updater_release_notes,
            autostart::autostart_enabled,
            autostart::autostart_set
        ])
        .setup(|app| {
            log::info!("startup: setup at_ms={}", launch_ms());
            #[cfg(target_os = "linux")]
            crate::window::remember_desktop_font();
            log::info!(
                "desktop app starting version={} pid={} target_os={}",
                env!("CARGO_PKG_VERSION"),
                std::process::id(),
                std::env::consts::OS
            );
            match crate::config::app_config_file(app.handle(), "access-keys.json") {
                Ok(path) => openagentd_shell_core::use_file_store(path),
                Err(e) => log::error!("access key store unavailable: {e:#}"),
            }
            // The backend and the HTTP client's TLS roots (~190 ms on macOS)
            // are the slowest parts of a launch, so they start before the
            // menus. Nothing is published to the tray or a window before
            // `setup` returns: the main window can only be created after it.
            std::thread::spawn(|| {
                crate::usage::shared_client();
            });
            let handle = app.handle().clone();
            let backend = tauri::async_runtime::spawn(start_backend(handle.clone()));
            // But the window's task reads the app menu while `setup` still
            // runs, and on Windows and Linux that menu is the window's bar
            // and its shortcuts (Ctrl+Q, Ctrl+=…): install it before the
            // task starts, or the main window often had none.
            install_desktop_menus(app)?;
            log::info!("startup: menus built at_ms={}", launch_ms());
            // Started by "Open at login": everything runs, with no window
            // until the person opens the app (Dock, tray, a second launch).
            let at_login = autostart::launched_at_login(std::env::args());
            if at_login {
                log::info!("startup: launched at login, staying in the background");
                window_session::restore_later();
            }
            autostart::refresh(app.handle());
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_backend_and_window(handle.clone(), backend, !at_login).await {
                    log::error!("failed to start backend: {e:#}");
                    update_tray_status(&handle, crate::menu::TRAY_STATUS_FAILED);
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
            match desktop_log_path(app.handle()) {
                Ok(path) => log::info!("desktop log path={}", path.display()),
                Err(e) => log::warn!("desktop log path unavailable: {e:#}"),
            }
            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Bundles from previous runs are unreachable (`update_state`
                // is in-memory and starts empty), so reclaim their disk.
                updater::purge_cached_updates(&updater_handle);
                tokio::time::sleep(Duration::from_secs(5)).await;
                let _ = updater::run_update_check(updater_handle, true).await;
            });
            let usage_poll_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                menu::run_usage_poll_loop(usage_poll_handle).await;
            });
            let watchdog_handle = app.handle().clone();
            tauri::async_runtime::spawn(watchdog::run(watchdog_handle));
            if remote_update::supported() {
                tauri::async_runtime::spawn(remote_update::run(app.handle().clone()));
            }
            island::start(app.handle());
            pet::start(app.handle());
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
                *state.active_window_label.lock().unwrap() = label.to_string();
                island::on_app_focus_changed(app);
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Focused(false),
                ..
            } if label == MAIN_WINDOW || label.starts_with(SECONDARY_WINDOW_PREFIX) => {
                island::on_app_focus_changed(app);
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == MAIN_WINDOW || label.starts_with(SECONDARY_WINDOW_PREFIX) => {
                let state: tauri::State<'_, AppState> = app.state();
                if !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window(label.as_str()) {
                        let _ = save_window_state(app, &window);
                        window_session::window_closing(app, label.as_str());
                        let _ = window.destroy();
                        state
                            .window_backend_base_urls
                            .lock()
                            .unwrap()
                            .remove(label.as_str());
                        preview_relay::close_window(app, label.as_str());
                        account::release_unused(app);
                        island::forget_window(label.as_str());
                        state
                            .window_zoom_factors
                            .lock()
                            .unwrap()
                            .remove(label.as_str());
                        let remaining = app
                            .webview_windows()
                            .into_iter()
                            .find(|(k, _)| k != label.as_str() && !crate::window::is_overlay_window(k))
                            .map(|(k, _)| k)
                            .unwrap_or_else(|| MAIN_WINDOW.to_string());
                        *state.active_window_label.lock().unwrap() = remaining;
                    }
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                show_target_window(app);
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
                    // An attempt in flight is superseded and shuts its own
                    // child down; this exit does not wait for it, so a child
                    // still starting is left to `--parent-pid` / the Job Object.
                    if let Some(mut s) = sidecar.stop().await.child {
                        s.shutdown().await;
                    }
                });
            }
            _ => {}
        });
}

#[cfg(test)]
#[path = "tests/main.rs"]
mod tests;
