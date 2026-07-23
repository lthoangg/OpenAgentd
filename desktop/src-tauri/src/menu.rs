use anyhow::Result;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_opener::OpenerExt;

use crate::usage::{
    backoff_delay, critical_providers, fetch_usage_summary, format_failed_footer,
    format_footer, format_notification_body, format_summary_rows, has_critical_usage,
    notification_transitions, UsageRow, UsageSummaryBody,
};
use crate::window::{
    adjust_zoom, create_app_window, emit_frontend_command, navigate_main_window,
    set_zoom, show_main_window, ZOOM_DEFAULT, ZOOM_STEP,
};
use crate::reload_main_window;
use crate::updater::request_update_check;
use crate::AppState;

pub const MENU_SHOW: &str = "show";
pub const MENU_NEW_WINDOW: &str = "new_window";
pub const MENU_HOME: &str = "home";
pub const MENU_CHAT: &str = "chat";
pub const MENU_CODING: &str = "coding";
pub const MENU_COMMAND_PALETTE: &str = "command_palette";
pub const MENU_SCHEDULER: &str = "scheduler";
pub const MENU_AGENT_CAPABILITIES: &str = "agent_capabilities";
pub const MENU_SETTINGS: &str = "settings";
pub const MENU_STATUS: &str = "status";
pub const MENU_SESSION: &str = "session";
pub const MENU_RELOAD: &str = "reload";
pub const MENU_FORCE_RELOAD: &str = "force_reload";
pub const MENU_ZOOM_IN: &str = "zoom_in";
pub const MENU_ZOOM_OUT: &str = "zoom_out";
pub const MENU_ZOOM_RESET: &str = "zoom_reset";
pub const MENU_CHECK_UPDATES: &str = "check_updates";
pub const MENU_OPEN_CONFIG_DIR: &str = "open_config_dir";
pub const MENU_REVEAL_DESKTOP_LOG: &str = "reveal_desktop_log";
pub const MENU_REVEAL_BACKEND_LOG: &str = "reveal_backend_log";
pub const MENU_QUIT: &str = "quit";
pub const MENU_USAGE_REFRESH: &str = "usage_refresh";
pub const MENU_USAGE_MANAGE: &str = "usage_manage";
/// Prefix for informational (disabled) usage rows. Never actually
/// dispatched — they exist purely so every dynamically inserted
/// `MenuItem` has a stable, unique id.
const USAGE_ROW_ID_PREFIX: &str = "usage_row:";

/// How often the tray refreshes connected-provider usage in the
/// background. Deliberately relaxed: opening the tray menu triggers an
/// opportunistic refresh (see the ``TrayIconEvent`` hook in ``main.rs``),
/// so the background cadence only has to keep the critical-usage badge
/// and notifications reasonably current — not the menu contents.
const USAGE_POLL_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Minimum spacing between tray-open-triggered refreshes. Opening the
/// menu repeatedly within this window reuses whatever is rendered
/// (which the backend's stale-while-revalidate keeps warm anyway).
const USAGE_TRAY_OPEN_MIN_GAP: Duration = Duration::from_secs(30);
/// Startup probe cadence: instead of a fixed grace period, the poll loop
/// probes for a resolvable backend endpoint every this-often and fires
/// its first refresh as soon as one appears…
const USAGE_POLL_STARTUP_PROBE: Duration = Duration::from_secs(1);
/// …bounded by this ceiling so an unconfigured backend doesn't keep the
/// startup probe spinning forever (the normal poll cadence takes over).
const USAGE_POLL_STARTUP_WAIT_MAX: Duration = Duration::from_secs(60);
/// Ceiling for the exponential backoff applied after consecutive poll
/// failures (upstream outage, expired OAuth token the user hasn't
/// reconnected yet, backend briefly unreachable during a reload, …).
/// Without a ceiling a long-running app could end up polling once a day;
/// 30 minutes still recovers promptly once the underlying issue clears.
const USAGE_POLL_MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);

/// Label shown in the tray when no chat/coding session is active.
pub const TRAY_SESSION_IDLE: &str = "No active session";

/// Hard cap on tray session label width. Keeps the menu from stretching
/// uncomfortably wide when a session title or workspace name is long.
pub const TRAY_SESSION_MAX_LEN: usize = 60;

pub fn install_desktop_menus(app: &tauri::App) -> Result<()> {
    let about_metadata = {
        let mut builder = AboutMetadataBuilder::new()
            .name(Some("OpenAgentd"))
            .version(Some(env!("CARGO_PKG_VERSION")))
            .copyright(Some("Copyright (c) 2026 OpenAgentd contributors"))
            .website(Some("https://github.com/lthoangg/openagentd"))
            .website_label(Some("openagentd on GitHub"));
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(Some(icon.clone()));
        }
        builder.build()
    };
    let app_about = PredefinedMenuItem::about(app, Some("About OpenAgentd"), Some(about_metadata))?;

    // Per Apple HIG, "Check for Updates…" sits directly below About.
    let app_check_updates = MenuItem::with_id(
        app,
        MENU_CHECK_UPDATES,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let app_show = MenuItem::with_id(app, MENU_SHOW, "Show OpenAgentd", true, None::<&str>)?;
    let app_new_window = MenuItem::with_id(
        app,
        MENU_NEW_WINDOW,
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let app_home = MenuItem::with_id(app, MENU_HOME, "Home", true, None::<&str>)?;
    let app_settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings", true, Some("CmdOrCtrl+,"))?;
    let app_open_config_dir = MenuItem::with_id(
        app,
        MENU_OPEN_CONFIG_DIR,
        "View Config Folder",
        true,
        None::<&str>,
    )?;
    let app_reveal_desktop_log = MenuItem::with_id(
        app,
        MENU_REVEAL_DESKTOP_LOG,
        "View Desktop Log",
        true,
        None::<&str>,
    )?;
    let app_reveal_backend_log = MenuItem::with_id(
        app,
        MENU_REVEAL_BACKEND_LOG,
        "View Backend Log",
        true,
        None::<&str>,
    )?;
    let app_quit = MenuItem::with_id(app, MENU_QUIT, "Quit OpenAgentd", true, Some("CmdOrCtrl+Q"))?;
    let file_new_window = MenuItem::with_id(
        app,
        MENU_NEW_WINDOW,
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let file_home = MenuItem::with_id(app, MENU_HOME, "Home", true, Some("CmdOrCtrl+Shift+H"))?;
    let file_chat = MenuItem::with_id(app, MENU_CHAT, "Cockpit", true, Some("CmdOrCtrl+Shift+C"))?;
    let file_coding =
        MenuItem::with_id(app, MENU_CODING, "Coding", true, Some("CmdOrCtrl+Shift+K"))?;
    let file_quit =
        MenuItem::with_id(app, MENU_QUIT, "Quit OpenAgentd", true, Some("CmdOrCtrl+Q"))?;
    let view_command_palette = MenuItem::with_id(
        app,
        MENU_COMMAND_PALETTE,
        "Command Palette…",
        true,
        Some("CmdOrCtrl+P"),
    )?;
    let view_scheduler = MenuItem::with_id(
        app,
        MENU_SCHEDULER,
        "Scheduled Tasks",
        true,
        Some("CmdOrCtrl+S"),
    )?;
    // Bare CmdOrCtrl+A is "Select All" on macOS, so Session Settings
    // requires Shift to avoid clobbering it — matches the in-app
    // ⌘⇧A / Ctrl+Shift+A binding (see web/src/lib/keyboard-shortcut.ts).
    let view_agent_capabilities = MenuItem::with_id(
        app,
        MENU_AGENT_CAPABILITIES,
        "Session Settings",
        true,
        Some("CmdOrCtrl+Shift+A"),
    )?;
    let view_reload = MenuItem::with_id(app, MENU_RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?;
    let view_force_reload = MenuItem::with_id(
        app,
        MENU_FORCE_RELOAD,
        "Force Reload",
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    // ``CmdOrCtrl+=`` (not ``CmdOrCtrl++``) so the shortcut fires from the
    // bare ``=`` key — matches Chrome/Safari/VS Code and avoids requiring
    // Shift on US layouts.
    let view_zoom_in = MenuItem::with_id(app, MENU_ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?;
    let view_zoom_out =
        MenuItem::with_id(app, MENU_ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let view_zoom_reset = MenuItem::with_id(
        app,
        MENU_ZOOM_RESET,
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;

    // Edit submenu is required on macOS so ⌘A/⌘C/⌘V/⌘X/⌘Z reach the webview.
    let edit_undo = PredefinedMenuItem::undo(app, None)?;
    let edit_redo = PredefinedMenuItem::redo(app, None)?;
    let edit_cut = PredefinedMenuItem::cut(app, None)?;
    let edit_copy = PredefinedMenuItem::copy(app, None)?;
    let edit_paste = PredefinedMenuItem::paste(app, None)?;
    let edit_select_all = PredefinedMenuItem::select_all(app, None)?;

    let app_menu = SubmenuBuilder::new(app, "OpenAgentd")
        .item(&app_about)
        .item(&app_check_updates)
        .separator()
        .item(&app_show)
        .item(&app_new_window)
        .item(&app_home)
        .separator()
        .item(&app_settings)
        .separator()
        .item(&app_open_config_dir)
        .item(&app_reveal_desktop_log)
        .item(&app_reveal_backend_log)
        .separator()
        .item(&app_quit)
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&file_new_window)
        .separator()
        .item(&file_home)
        .item(&file_chat)
        .item(&file_coding)
        .separator()
        .item(&file_quit)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&edit_undo)
        .item(&edit_redo)
        .separator()
        .item(&edit_cut)
        .item(&edit_copy)
        .item(&edit_paste)
        .item(&edit_select_all)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&view_reload)
        .item(&view_force_reload)
        .separator()
        .item(&view_zoom_in)
        .item(&view_zoom_out)
        .item(&view_zoom_reset)
        .separator()
        .item(&view_command_palette)
        .item(&view_scheduler)
        .item(&view_agent_capabilities)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window_with_text("Hide to Tray")
        .build()?;
    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )?;
    app.set_menu(menu)?;

    let status = MenuItem::with_id(app, MENU_STATUS, "Status: Starting", false, None::<&str>)?;
    // Informational only; updated from ``set_tray_session``.
    let session = MenuItem::with_id(app, MENU_SESSION, TRAY_SESSION_IDLE, false, None::<&str>)?;
    let tray_show = MenuItem::with_id(app, MENU_SHOW, "Show OpenAgentd", true, None::<&str>)?;
    let tray_new_window =
        MenuItem::with_id(app, MENU_NEW_WINDOW, "New Window", true, None::<&str>)?;
    let tray_settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings", true, None::<&str>)?;
    let tray_open_config_dir = MenuItem::with_id(
        app,
        MENU_OPEN_CONFIG_DIR,
        "View Config Folder",
        true,
        None::<&str>,
    )?;
    let tray_reveal_desktop_log = MenuItem::with_id(
        app,
        MENU_REVEAL_DESKTOP_LOG,
        "View Desktop Log",
        true,
        None::<&str>,
    )?;
    let tray_reveal_backend_log = MenuItem::with_id(
        app,
        MENU_REVEAL_BACKEND_LOG,
        "View Backend Log",
        true,
        None::<&str>,
    )?;
    let tray_reload = MenuItem::with_id(app, MENU_RELOAD, "Reload Window", true, None::<&str>)?;
    let tray_quit = MenuItem::with_id(app, MENU_QUIT, "Quit OpenAgentd", true, None::<&str>)?;

    // "Usage Limits" — dynamic OAuth provider usage submenu. Starts with a
    // single placeholder row; ``run_usage_poll_loop`` / the manual refresh
    // action mutate the submenu's children in place from here on (see
    // ``update_tray_usage``), so this initial shape is the only thing built
    // statically.
    let usage_placeholder_row = MenuItem::with_id(
        app,
        format!("{USAGE_ROW_ID_PREFIX}placeholder"),
        "Checking usage…",
        false,
        None::<&str>,
    )?;
    let usage_footer = MenuItem::with_id(app, "usage_footer", "Not checked yet", false, None::<&str>)?;
    let usage_refresh = MenuItem::with_id(
        app,
        MENU_USAGE_REFRESH,
        "Refresh Usage Now",
        true,
        None::<&str>,
    )?;
    let usage_manage = MenuItem::with_id(
        app,
        MENU_USAGE_MANAGE,
        "Manage Providers…",
        true,
        None::<&str>,
    )?;
    let usage_submenu = SubmenuBuilder::new(app, "Usage Limits")
        .item(&usage_placeholder_row)
        .separator()
        .item(&usage_footer)
        .item(&usage_refresh)
        .item(&usage_manage)
        .build()?;

    let tray_menu = Menu::with_items(
        app,
        &[
            &status,
            &session,
            &PredefinedMenuItem::separator(app)?,
            &usage_submenu,
            &PredefinedMenuItem::separator(app)?,
            &tray_show,
            &tray_new_window,
            &PredefinedMenuItem::separator(app)?,
            &tray_settings,
            &tray_open_config_dir,
            &tray_reveal_desktop_log,
            &tray_reveal_backend_log,
            &tray_reload,
            &PredefinedMenuItem::separator(app)?,
            &tray_quit,
        ],
    )?;
    // Left-click opens the menu so the icon acts as a status surface, not
    // a launcher. We deliberately do not register ``on_menu_event`` here —
    // the app-level handler in ``main()`` already receives tray events,
    // so adding one would fire ``handle_desktop_menu`` twice.
    let mut tray = TrayIconBuilder::new()
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        // Opportunistic usage refresh at the moment the user actually
        // looks at the menu (rate-limited; see refresh_usage_on_tray_open).
        // This is a tray-*icon* event handler, distinct from the menu-item
        // event handler deliberately not registered here (see below).
        .on_tray_icon_event(|tray, event| {
            if matches!(event, tauri::tray::TrayIconEvent::Click { .. }) {
                refresh_usage_on_tray_open(tray.app_handle());
            }
        })
        .tooltip("OpenAgentd");
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(macos_tray_icon()?).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    let tray_icon = tray.build(app)?;

    let state: tauri::State<'_, AppState> = app.state();
    tauri::async_runtime::block_on(async {
        state.tray_status.lock().await.replace(status);
        state.tray_session.lock().await.replace(session);
        state.usage_submenu.lock().await.replace(usage_submenu);
        state.usage_footer.lock().await.replace(usage_footer);
        *state.usage_rows.lock().await = vec![usage_placeholder_row];
        state.tray_icon.lock().await.replace(tray_icon);
    });
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn macos_tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
}

pub fn update_tray_status(app: &AppHandle, text: &str) {
    let state: tauri::State<'_, AppState> = app.state();
    let text = text.to_string();
    let status = state.tray_status.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(item) = status.lock().await.as_ref() {
            let _ = item.set_text(text);
        }
    });
}

pub fn update_tray_session(app: &AppHandle, text: &str) {
    let state: tauri::State<'_, AppState> = app.state();
    let text = text.to_string();
    let session = state.tray_session.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(item) = session.lock().await.as_ref() {
            let _ = item.set_text(text);
        }
    });
}

/// Frontend command: update the tray's session-label item.
///
/// Empty input falls back to the idle placeholder; long input is truncated
/// to ``TRAY_SESSION_MAX_LEN`` so the menu width stays sane.
#[tauri::command]
pub fn set_tray_session(app: AppHandle, text: String) -> Result<(), String> {
    let trimmed = text.trim();
    let label = if trimmed.is_empty() {
        TRAY_SESSION_IDLE.to_string()
    } else if trimmed.chars().count() > TRAY_SESSION_MAX_LEN {
        let mut s: String = trimmed.chars().take(TRAY_SESSION_MAX_LEN - 1).collect();
        s.push('…');
        s
    } else {
        trimmed.to_string()
    };
    update_tray_session(&app, &label);
    Ok(())
}

pub fn handle_desktop_menu(app: &AppHandle, id: &str) {
    match id {
        MENU_SHOW => show_main_window(app),
        MENU_NEW_WINDOW => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = create_app_window(&handle, None, None).await {
                    log::error!("failed to create new window: {e:#}");
                }
            });
        }
        MENU_HOME => navigate_main_window(app, "/"),
        MENU_CHAT => navigate_main_window(app, "/cockpit"),
        MENU_CODING => navigate_main_window(app, "/coding"),
        MENU_COMMAND_PALETTE => emit_frontend_command(app, "command_palette"),
        MENU_SCHEDULER => emit_frontend_command(app, "scheduler"),
        MENU_AGENT_CAPABILITIES => emit_frontend_command(app, "agent_capabilities"),
        MENU_SETTINGS => emit_frontend_command(app, "settings"),
        MENU_RELOAD => reload_main_window(app),
        MENU_FORCE_RELOAD => crate::force_reload_app(app),
        MENU_ZOOM_IN => adjust_zoom(app, ZOOM_STEP),
        MENU_ZOOM_OUT => adjust_zoom(app, 1.0 / ZOOM_STEP),
        MENU_ZOOM_RESET => set_zoom(app, ZOOM_DEFAULT),
        MENU_CHECK_UPDATES => request_update_check(app),
        MENU_OPEN_CONFIG_DIR => open_config_dir(app),
        MENU_REVEAL_DESKTOP_LOG => reveal_desktop_log(app),
        MENU_REVEAL_BACKEND_LOG => reveal_backend_log(app),
        MENU_USAGE_REFRESH => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = refresh_usage_now(&handle, true).await;
            });
        }
        MENU_USAGE_MANAGE => emit_frontend_command(app, "settings_providers"),
        MENU_QUIT => crate::quit_app(app),
        _ => {}
    }
}

pub fn open_config_dir(app: &AppHandle) {
    let config_dir = std::env::var("OPENAGENTD_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            app.path()
                .home_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".config")
                .join("openagentd")
        });
    if let Err(e) = std::fs::create_dir_all(&config_dir) {
        log::warn!("failed to create config dir {}: {e}", config_dir.display());
        return;
    }
    if let Err(e) = app
        .opener()
        .open_path(config_dir.to_string_lossy().into_owned(), None::<&str>)
    {
        log::warn!("failed to open config dir {}: {e}", config_dir.display());
    }
}

pub fn reveal_desktop_log(app: &AppHandle) {
    match crate::desktop_log_path(app) {
        Ok(path) => {
            if let Err(e) = app.opener().reveal_item_in_dir(&path) {
                log::warn!("failed to reveal desktop log {}: {e}", path.display());
            }
        }
        Err(e) => log::warn!("desktop log path unavailable: {e:#}"),
    }
}

pub fn reveal_backend_log(app: &AppHandle) {
    let state: tauri::State<'_, AppState> = app.state();
    let sidecar = state.sidecar.clone();
    let app_for_open = app.clone();
    tauri::async_runtime::spawn(async move {
        let path = sidecar
            .lock()
            .await
            .as_ref()
            .map(|s| s.log_path().to_path_buf());
        let Some(path) = path else {
            log::warn!("backend log path unavailable; sidecar not started");
            return;
        };
        if let Err(e) = app_for_open.opener().reveal_item_in_dir(&path) {
            log::warn!("failed to reveal backend log {}: {e}", path.display());
        }
    });
}

/// Load the saved access key for an external backend without exposing it in
/// the tray's state or logs. A credential-store failure leaves the request
/// unauthenticated; the backend response remains the source of truth.
fn external_usage_access_key(
    base_url: &str,
    load: impl FnOnce(String) -> std::result::Result<Option<String>, String>,
) -> Option<String> {
    match load(base_url.to_string()) {
        Ok(key) => key,
        Err(_) => {
            log::debug!("usage_summary_access_key_unavailable");
            None
        }
    }
}

/// Resolve the ``(base_url, bearer_token)`` pair the tray should use to
/// reach the OpenAgentd backend right now: the main window's external
/// server if one is configured, otherwise the bundled sidecar (with its
/// desktop session token). Returns ``None`` while the backend hasn't
/// finished starting yet.
async fn resolve_backend_endpoint(app: &AppHandle) -> Option<(String, Option<String>)> {
    let state: tauri::State<'_, AppState> = app.state();
    if let Some(base) = state
        .window_backend_base_urls
        .lock()
        .await
        .get(crate::window::MAIN_WINDOW)
        .cloned()
    {
        let access_key = external_usage_access_key(&base, |origin| crate::commands::secure_get_access_key(app.clone(), origin));
        return Some((base, access_key));
    }
    let base = state.backend_base_url.lock().await.clone()?;
    let token = state.desktop_token.lock().await.clone();
    Some((base, token))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Redraw the "Usage Limits" submenu from a fetch outcome.
///
/// On success the fresh snapshot is cached in ``AppState`` and rendered.
/// On failure the *previous* snapshot (if any) is re-rendered — a
/// transient network hiccup shouldn't blank out numbers the user was
/// just looking at — with the footer surfacing the error instead.
/// Toggle the tray icon's subtle "!" title badge (macOS shows tray-icon
/// titles as text right next to the icon in the menu bar) when any
/// connected provider's usage is at or above the critical threshold.
/// Idempotent — safe to call every poll regardless of whether the state
/// actually changed since the underlying Tauri call is cheap.
async fn update_tray_critical_badge(state: &tauri::State<'_, AppState>, critical: bool) {
    let Some(tray_icon) = state.tray_icon.lock().await.clone() else {
        return;
    };
    if critical {
        let _ = tray_icon.set_title(Some("!"));
        let _ = tray_icon.set_tooltip(Some("OpenAgentd — a connected provider is near its usage limit"));
    } else {
        let _ = tray_icon.set_title(None::<&str>);
        let _ = tray_icon.set_tooltip(Some("OpenAgentd"));
    }
}

/// Fire one native notification for providers that newly crossed the
/// critical usage threshold, and re-arm providers that dropped back
/// below it (quota window reset). Dedup state lives in
/// ``AppState.usage_notified`` — the pure transition logic is
/// ``usage::notification_transitions`` (unit-tested).
async fn notify_critical_crossings(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    body: &UsageSummaryBody,
) {
    let current = critical_providers(body);
    let mut notified = state.usage_notified.lock().await;
    let (to_notify, next) = notification_transitions(&current, &notified);
    *notified = next;
    drop(notified);
    if to_notify.is_empty() {
        return;
    }
    let labels: Vec<String> = body
        .items
        .iter()
        .filter(|item| to_notify.contains(&item.provider))
        .map(|item| item.label.clone())
        .collect();
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app
        .notification()
        .builder()
        .title("Provider usage limit almost reached")
        .body(format_notification_body(&labels))
        .show()
    {
        log::warn!("usage_critical_notification_failed error={e:#}");
    }
}

async fn update_tray_usage(app: &AppHandle, result: Result<UsageSummaryBody, String>) {
    let state: tauri::State<'_, AppState> = app.state();
    let Some(submenu) = state.usage_submenu.lock().await.clone() else {
        return;
    };

    let now = now_unix();
    let (rows, footer_text, critical) = match result {
        Ok(body) => {
            let rows = format_summary_rows(&body, now);
            let footer = format_footer(&body, now);
            let critical = has_critical_usage(&body);
            notify_critical_crossings(app, &state, &body).await;
            *state.usage_summary.lock().await = Some(body);
            (rows, footer, critical)
        }
        Err(err) => {
            // Keep the last-known-good rows on screen — users care about
            // the numbers, not the fetch status; only the footer reports
            // the failure. (The backend additionally substitutes per-
            // provider last-good data for transient upstream failures.)
            let cached = state.usage_summary.lock().await.clone();
            let rows = cached
                .as_ref()
                .map(|body| format_summary_rows(body, now))
                .unwrap_or_default();
            let critical = cached.as_ref().is_some_and(has_critical_usage);
            log::warn!("usage_summary_fetch_failed error={err}");
            let footer = format_failed_footer(cached.as_ref(), now, &err);
            (rows, footer, critical)
        }
    };
    update_tray_critical_badge(&state, critical).await;

    let entries: Vec<UsageRow> = if rows.is_empty() {
        vec![UsageRow {
            id_suffix: "empty".to_string(),
            text: "No connected OAuth providers with usage data".to_string(),
        }]
    } else {
        rows
    };

    // Skip the native-menu churn entirely when nothing changed — usage
    // percentages rarely move between polls, so most refreshes only need
    // the footer timestamp updated.
    let mut rendered_guard = state.usage_rendered_rows.lock().await;
    if *rendered_guard != entries {
        let mut rows_guard = state.usage_rows.lock().await;
        for old_row in rows_guard.drain(..) {
            let _ = submenu.remove(&old_row);
        }
        let mut new_rows = Vec::with_capacity(entries.len());
        for (idx, row) in entries.iter().enumerate() {
            match MenuItem::with_id(
                app,
                format!("{USAGE_ROW_ID_PREFIX}{}", row.id_suffix),
                &row.text,
                false,
                None::<&str>,
            ) {
                Ok(item) => {
                    if submenu.insert(&item, idx).is_ok() {
                        new_rows.push(item);
                    }
                }
                Err(e) => log::warn!("failed to build usage row menu item: {e:#}"),
            }
        }
        *rows_guard = new_rows;
        drop(rows_guard);
        *rendered_guard = entries;
    }
    drop(rendered_guard);

    let footer_guard = state.usage_footer.lock().await;
    if let Some(footer) = footer_guard.as_ref() {
        let _ = footer.set_text(footer_text);
    }
}

/// Fetch usage now and redraw the tray submenu. Used by both the manual
/// "Refresh Usage Now" action (``force_refresh=true``, bypassing the
/// backend's short-lived cache) and the periodic background poll
/// (``force_refresh=false``, happy to reuse a recent cached snapshot).
///
/// Returns whether the fetch succeeded, so the background poll loop can
/// back off after repeated failures instead of hammering an unreachable
/// backend or a provider stuck returning errors every 5 minutes forever.
pub async fn refresh_usage_now(app: &AppHandle, force_refresh: bool) -> bool {
    let state: tauri::State<'_, AppState> = app.state();
    // Collapse overlapping triggers (background poll + manual refresh +
    // tray-open refresh racing after wake-from-sleep) into one in-flight
    // fetch. compare_exchange wins exactly once; losers simply skip —
    // the winner's redraw covers them within seconds.
    if state
        .usage_fetch_inflight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::debug!("usage_summary_skip_poll reason=fetch_already_inflight");
        return true; // don't count a skipped poll as a failure for backoff
    }
    let result = async {
        let Some((base_url, token)) = resolve_backend_endpoint(app).await else {
            log::debug!("usage_summary_skip_poll reason=backend_not_ready");
            return false;
        };
        let outcome = fetch_usage_summary(&base_url, token.as_deref(), force_refresh).await;
        let success = outcome.is_ok();
        update_tray_usage(app, outcome.map_err(|e| format!("{e:#}"))).await;
        success
    }
    .await;
    state.usage_fetch_inflight.store(false, Ordering::SeqCst);
    result
}

/// Unix-seconds timestamp of the last tray-open-triggered refresh.
/// Module-local because it only rate-limits this one trigger source.
static LAST_TRAY_OPEN_REFRESH: std::sync::atomic::AtomicI64 =
    std::sync::atomic::AtomicI64::new(0);

/// Opportunistic refresh when the user opens the tray menu — the moment
/// the data is actually looked at. Non-forced (happy to hit the backend's
/// warm cache) and rate-limited by ``USAGE_TRAY_OPEN_MIN_GAP`` so click
/// spam doesn't queue refreshes.
pub fn refresh_usage_on_tray_open(app: &AppHandle) {
    let now = now_unix();
    let last = LAST_TRAY_OPEN_REFRESH.load(Ordering::SeqCst);
    if now - last < USAGE_TRAY_OPEN_MIN_GAP.as_secs() as i64 {
        return;
    }
    LAST_TRAY_OPEN_REFRESH.store(now, Ordering::SeqCst);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = refresh_usage_now(&handle, false).await;
    });
}

/// Background loop: poll connected-provider usage for the lifetime of the
/// app. Intentionally never returns — spawned once from `main()`'s setup
/// hook. Backs off exponentially (capped at `USAGE_POLL_MAX_BACKOFF`)
/// after consecutive failures, and resets to the normal cadence as soon
/// as a poll succeeds again.
pub async fn run_usage_poll_loop(app: AppHandle) {
    // Wait for the backend endpoint to be resolvable instead of sleeping
    // a fixed grace period — the first poll lands as soon as the sidecar
    // (or external server) is actually reachable, and never earlier.
    // Bounded so an unconfigured/never-starting backend doesn't spin here.
    for _ in 0..(USAGE_POLL_STARTUP_WAIT_MAX.as_secs() / USAGE_POLL_STARTUP_PROBE.as_secs()) {
        if resolve_backend_endpoint(&app).await.is_some() {
            break;
        }
        tokio::time::sleep(USAGE_POLL_STARTUP_PROBE).await;
    }
    let mut consecutive_failures: u32 = 0;
    loop {
        let succeeded = refresh_usage_now(&app, false).await;
        consecutive_failures = if succeeded { 0 } else { consecutive_failures + 1 };
        let delay = backoff_delay(
            USAGE_POLL_INTERVAL,
            consecutive_failures,
            USAGE_POLL_MAX_BACKOFF,
        );
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{external_usage_access_key, macos_tray_icon};

    #[test]
    fn macos_tray_template_icon_preserves_transparent_background() {
        let icon = macos_tray_icon().expect("decode embedded macOS tray icon");
        let mut alpha = icon.rgba().chunks_exact(4).map(|pixel| pixel[3]);

        assert_eq!((icon.width(), icon.height()), (64, 64));
        assert!(
            alpha.clone().any(|value| value == 0),
            "a macOS template icon needs transparent background pixels"
        );
        assert!(
            alpha.any(|value| value > 0),
            "a macOS template icon needs visible foreground pixels"
        );
    }

    #[test]
    fn external_usage_access_key_loads_the_key_for_the_current_backend() {
        let key = external_usage_access_key("https://agents.example.com", |origin| {
            assert_eq!(origin, "https://agents.example.com");
            Ok(Some("access-key".to_string()))
        });

        assert_eq!(key.as_deref(), Some("access-key"));
    }
}
