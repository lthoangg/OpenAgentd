use anyhow::Result;
use std::path::PathBuf;
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Manager,
};
#[cfg(not(target_os = "macos"))]
use tauri::tray::TrayIconBuilder;
use tauri_plugin_opener::OpenerExt;

use crate::usage::{
    backoff_delay, fetch_usage_summary, format_failed_footer, format_footer,
    format_notification_body, format_summary_rows, has_critical_usage, UsageRow,
    UsageSummaryBody,
};
use crate::servers::ServerId;
use crate::window::{
    adjust_zoom, create_fresh_app_window, emit_frontend_command, set_zoom,
    show_main_window, ZOOM_DEFAULT, ZOOM_STEP,
};
use crate::reload_main_window;
use crate::updater::request_update_check;
use crate::AppState;

pub const MENU_SHOW: &str = "show";
pub const MENU_NEW_WINDOW: &str = "new_window";
pub const MENU_NEW_SESSION: &str = "new_session";
pub const MENU_OPEN_WORKSPACE: &str = "open_workspace";
pub const MENU_TOGGLE_SIDEBAR: &str = "toggle_sidebar";
pub const MENU_TERMINAL: &str = "terminal";
pub const MENU_QUICK_OPEN: &str = "quick_open";
pub const MENU_COMMAND_PALETTE: &str = "command_palette";
pub const MENU_SWITCH_WORKSPACE: &str = "switch_workspace";
pub const MENU_WORKSPACE_SESSIONS: &str = "workspace_sessions";
pub const MENU_SCHEDULER: &str = "scheduler";
pub const MENU_AGENT_CAPABILITIES: &str = "agent_capabilities";
pub const MENU_SETTINGS: &str = "settings";
#[cfg(not(target_os = "macos"))]
pub const MENU_STATUS: &str = "status";
#[cfg(not(target_os = "macos"))]
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
pub const MENU_HELP_WEBSITE: &str = "help_website";
pub const MENU_HELP_GITHUB: &str = "help_github";
pub const MENU_HELP_RELEASE_NOTES: &str = "help_release_notes";
pub const MENU_HELP_REPORT_ISSUE: &str = "help_report_issue";
pub const MENU_QUIT: &str = "quit";
pub const MENU_USAGE_REFRESH: &str = "usage_refresh";
pub const MENU_USAGE_MANAGE: &str = "usage_manage";

const WEBSITE_URL: &str = "https://openagentd.dev";
const REPO_URL: &str = "https://github.com/lthoangg/openagentd";
const RELEASE_NOTES_URL: &str = "https://github.com/lthoangg/openagentd/releases";
const REPORT_ISSUE_URL: &str = "https://github.com/lthoangg/openagentd/issues/new";
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
#[cfg(not(target_os = "macos"))]
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
            .website(Some(WEBSITE_URL))
            .website_label(Some("openagentd.dev"));
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
    let app_settings =
        MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_quit = MenuItem::with_id(app, MENU_QUIT, "Quit OpenAgentd", true, Some("CmdOrCtrl+Q"))?;

    // In-app shortcuts are listed here too. The webview sees a key press
    // first and its handler calls `preventDefault`, which stops the native
    // accelerator; the menu item only fires when clicked or when no web
    // handler claimed the key.
    let file_new_session = MenuItem::with_id(
        app,
        MENU_NEW_SESSION,
        "New Session",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let file_new_window = MenuItem::with_id(
        app,
        MENU_NEW_WINDOW,
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let file_open_workspace = MenuItem::with_id(
        app,
        MENU_OPEN_WORKSPACE,
        "Open Workspace…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let view_quick_open = MenuItem::with_id(
        app,
        MENU_QUICK_OPEN,
        "Quick Open…",
        true,
        Some("CmdOrCtrl+P"),
    )?;
    let view_command_palette = MenuItem::with_id(
        app,
        MENU_COMMAND_PALETTE,
        "Command Palette…",
        true,
        Some("CmdOrCtrl+K"),
    )?;
    let view_switch_workspace = MenuItem::with_id(
        app,
        MENU_SWITCH_WORKSPACE,
        "Switch Workspace/Session…",
        true,
        Some("CmdOrCtrl+L"),
    )?;
    let view_workspace_sessions = MenuItem::with_id(
        app,
        MENU_WORKSPACE_SESSIONS,
        "Sessions in This Workspace…",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let view_scheduler = MenuItem::with_id(
        app,
        MENU_SCHEDULER,
        "Scheduled Tasks",
        true,
        None::<&str>,
    )?;
    let view_toggle_sidebar = MenuItem::with_id(
        app,
        MENU_TOGGLE_SIDEBAR,
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let view_terminal = MenuItem::with_id(
        app,
        MENU_TERMINAL,
        "Open Terminal",
        true,
        Some("CmdOrCtrl+Shift+`"),
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
    // No accelerators: a stray ⌘R would drop the UI state of a live turn and
    // Force Reload restarts the app. Both stay reachable from here and the
    // command palette.
    let view_reload = MenuItem::with_id(app, MENU_RELOAD, "Reload", true, None::<&str>)?;
    let view_force_reload = MenuItem::with_id(
        app,
        MENU_FORCE_RELOAD,
        "Force Reload",
        true,
        None::<&str>,
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

    let window_show = MenuItem::with_id(app, MENU_SHOW, "Show OpenAgentd", true, None::<&str>)?;

    let help_website =
        MenuItem::with_id(app, MENU_HELP_WEBSITE, "OpenAgentd Website", true, None::<&str>)?;
    let help_github =
        MenuItem::with_id(app, MENU_HELP_GITHUB, "OpenAgentd on GitHub", true, None::<&str>)?;
    let help_release_notes =
        MenuItem::with_id(app, MENU_HELP_RELEASE_NOTES, "Release Notes", true, None::<&str>)?;
    let help_report_issue =
        MenuItem::with_id(app, MENU_HELP_REPORT_ISSUE, "Report an Issue…", true, None::<&str>)?;
    let help_open_config_dir = MenuItem::with_id(
        app,
        MENU_OPEN_CONFIG_DIR,
        "View Config Folder",
        true,
        None::<&str>,
    )?;
    let help_reveal_desktop_log = MenuItem::with_id(
        app,
        MENU_REVEAL_DESKTOP_LOG,
        "View Desktop Log",
        true,
        None::<&str>,
    )?;
    let help_reveal_backend_log = MenuItem::with_id(
        app,
        MENU_REVEAL_BACKEND_LOG,
        "View Backend Log",
        true,
        None::<&str>,
    )?;

    let app_menu = SubmenuBuilder::new(app, "OpenAgentd")
        .item(&app_about)
        .item(&app_check_updates)
        .separator()
        .item(&app_settings)
        .separator();
    // Services / Hide / Hide Others / Show All only work on macOS; elsewhere
    // they would render as inert rows.
    #[cfg(target_os = "macos")]
    let app_menu = app_menu
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator();
    let app_menu = app_menu.item(&app_quit).build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&file_new_session)
        .item(&file_new_window)
        .separator()
        .item(&file_open_workspace)
        .separator()
        // Predefined ⌘W: an open dock tab claims the key first, so ⌘W closes
        // the tab and falls back to the window when none is open. The app
        // keeps running in the menu bar / tray either way.
        .close_window()
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
        .item(&view_command_palette)
        .item(&view_quick_open)
        .item(&view_switch_workspace)
        .item(&view_workspace_sessions)
        .separator()
        .item(&view_toggle_sidebar)
        .item(&view_terminal)
        .item(&view_agent_capabilities)
        .item(&view_scheduler)
        .separator()
        .item(&view_zoom_in)
        .item(&view_zoom_out)
        .item(&view_zoom_reset)
        .separator()
        .item(&view_reload)
        .item(&view_force_reload)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&window_show);
    #[cfg(target_os = "macos")]
    let window_menu = window_menu.bring_all_to_front();
    let window_menu = window_menu.build()?;
    // Help is recognised by its title on macOS, which adds the search field.
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&help_website)
        .item(&help_github)
        .item(&help_release_notes)
        .item(&help_report_issue)
        .separator()
        .item(&help_open_config_dir)
        .item(&help_reveal_desktop_log)
        .item(&help_reveal_backend_log)
        .build()?;
    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    app.set_menu(menu)?;
    // macOS lists open windows in the Window menu.
    #[cfg(target_os = "macos")]
    window_menu.set_as_windows_menu_for_nsapp()?;

    #[cfg(target_os = "macos")]
    {
        install_macos_tray(app)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        install_native_tray(app)?;
    }
    Ok(())
}

/// macOS: the tray icon is a status surface, not a menu. Left-click toggles
/// a custom borderless webview popup (see ``tray_popup``); there is no native
/// tray menu, so the status/session/usage native items are never created.
/// The usage poll loop still updates the critical badge, notifications, and
/// the cached summary the popup reads.
#[cfg(target_os = "macos")]
fn install_macos_tray(app: &tauri::App) -> Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let tray = TrayIconBuilder::new()
        .icon(macos_tray_icon()?)
        .icon_as_template(true)
        .tooltip("OpenAgentd")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // The positioner plugin needs every tray event to remember the
            // icon's current bounds for ``TrayBottomCenter`` anchoring.
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::tray_popup::toggle_tray_popup(tray.app_handle());
            }
        })
        .build(app)?;

    let state: tauri::State<'_, AppState> = app.state();
    tauri::async_runtime::block_on(async {
        state.tray_icon.lock().await.replace(tray);
    });
    Ok(())
}

/// Windows/Linux: keep the native tray menu (Tauri ``Menu``/``MenuItem`` maps
/// to native OS menus, the only supported surface on these platforms).
#[cfg(not(target_os = "macos"))]
fn install_native_tray(app: &tauri::App) -> Result<()> {
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
        // `set_text` blocks on the main thread, so clone the (Arc-backed)
        // handle out and release the lock before calling it.
        let item = status.lock().await.clone();
        if let Some(item) = item {
            let _ = item.set_text(text);
        }
    });
}

pub fn update_tray_session(app: &AppHandle, text: &str) {
    let state: tauri::State<'_, AppState> = app.state();
    let text = text.to_string();
    let session = state.tray_session.clone();
    tauri::async_runtime::spawn(async move {
        let item = session.lock().await.clone();
        if let Some(item) = item {
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
                if let Err(e) = create_fresh_app_window(&handle).await {
                    log::error!("failed to create new window: {e:#}");
                }
            });
        }
        MENU_NEW_SESSION => emit_frontend_command(app, "new_session"),
        MENU_OPEN_WORKSPACE => emit_frontend_command(app, "open_workspace"),
        MENU_TOGGLE_SIDEBAR => emit_frontend_command(app, "toggle_sidebar"),
        MENU_TERMINAL => emit_frontend_command(app, "terminal"),
        MENU_QUICK_OPEN => emit_frontend_command(app, "quick_open"),
        MENU_COMMAND_PALETTE => emit_frontend_command(app, "command_palette"),
        MENU_SWITCH_WORKSPACE => emit_frontend_command(app, "switch_workspace"),
        MENU_WORKSPACE_SESSIONS => emit_frontend_command(app, "workspace_sessions"),
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
        MENU_HELP_WEBSITE => open_help_url(app, WEBSITE_URL),
        MENU_HELP_GITHUB => open_help_url(app, REPO_URL),
        MENU_HELP_RELEASE_NOTES => open_help_url(app, RELEASE_NOTES_URL),
        MENU_HELP_REPORT_ISSUE => open_help_url(app, REPORT_ISSUE_URL),
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
    match crate::backend_log_path(app) {
        Ok(path) => {
            if let Err(e) = app.opener().reveal_item_in_dir(&path) {
                log::warn!("failed to reveal backend log {}: {e}", path.display());
            }
        }
        Err(e) => log::warn!("backend log path unavailable: {e:#}"),
    }
}

fn open_help_url(app: &AppHandle, url: &str) {
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        log::warn!("failed to open {url}: {e}");
    }
}

/// The saved access key for an external backend, from a
/// ``secure_get_access_key`` result, without exposing it in the tray's state
/// or logs. A credential-store failure leaves the request unauthenticated;
/// the backend response remains the source of truth.
pub(crate) fn external_usage_access_key(
    loaded: std::result::Result<Option<String>, String>,
) -> Option<String> {
    match loaded {
        Ok(key) => key,
        Err(_) => {
            log::debug!("usage_summary_access_key_unavailable");
            None
        }
    }
}

pub(crate) fn now_unix() -> i64 {
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

/// Fire one native notification for the providers that newly crossed the
/// critical usage threshold (``to_notify``, from ``UsageCache::record``,
/// which keeps the dedup state per server).
fn notify_critical_crossings(app: &AppHandle, body: &UsageSummaryBody, to_notify: &[String]) {
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

async fn update_tray_usage(app: &AppHandle, server: &ServerId, result: Result<UsageSummaryBody, String>) {
    let state: tauri::State<'_, AppState> = app.state();

    let now = now_unix();
    let (rows, footer_text, critical) = match result {
        Ok(body) => {
            let rows = format_summary_rows(&body, now);
            let footer = format_footer(&body, now);
            let critical = has_critical_usage(&body);
            let to_notify = state.usage.lock().await.record(server, body.clone());
            notify_critical_crossings(app, &body, &to_notify);
            (rows, footer, critical)
        }
        Err(err) => {
            // Keep the last-known-good rows on screen — users care about
            // the numbers, not the fetch status; only the footer reports
            // the failure. (The backend additionally substitutes per-
            // provider last-good data for transient upstream failures.)
            let cached = {
                let mut usage = state.usage.lock().await;
                usage.record_failure(server, err.clone());
                usage.reading(server).0
            };
            let rows = cached
                .as_ref()
                .map(|body| format_summary_rows(body, now))
                .unwrap_or_default();
            let critical = cached.as_ref().is_some_and(has_critical_usage);
            log::warn!("usage_summary_fetch_failed server={} error={err}", server.key());
            let footer = format_failed_footer(cached.as_ref(), now, &err);
            (rows, footer, critical)
        }
    };
    update_tray_critical_badge(&state, critical).await;

    // The rest only drives the native tray submenu (Windows/Linux). On macOS
    // there is no native submenu — the popup reads the cached summary — so
    // the cache/badge/notify work above still ran and we bail here.
    let Some(submenu) = state.usage_submenu.lock().await.clone() else {
        return;
    };

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
    //
    // Every menu mutation below blocks on the main thread (Tauri's
    // `run_main_thread!` / `run_item_main_thread!`), so the state locks are
    // taken, drained and released *first*. Holding an async mutex across a
    // main-thread hop is one half of a deadlock: the other half is the main
    // thread's own `block_on` of an `AppState` mutex in the `RunEvent`
    // handlers and `install_desktop_menus`.
    let stale_rows = {
        let mut rendered_guard = state.usage_rendered_rows.lock().await;
        if *rendered_guard == entries {
            None
        } else {
            *rendered_guard = entries.clone();
            Some(std::mem::take(&mut *state.usage_rows.lock().await))
        }
    };
    if let Some(stale_rows) = stale_rows {
        for old_row in stale_rows {
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
        *state.usage_rows.lock().await = new_rows;
    }

    // Same rule for the footer: clone the handle out, then release.
    let footer = state.usage_footer.lock().await.clone();
    if let Some(footer) = footer {
        let _ = footer.set_text(footer_text);
    }
}

/// Fetch usage from the server the app is on (the active window's, see
/// ``servers::current_server``) and redraw the tray submenu. Used by both
/// the manual "Refresh Usage Now" action (``force_refresh=true``, bypassing
/// the backend's short-lived cache) and the periodic background poll
/// (``force_refresh=false``, happy to reuse a recent cached snapshot).
///
/// Returns whether the fetch succeeded, so the background poll loop can
/// back off after repeated failures instead of hammering an unreachable
/// backend or a provider stuck returning errors every 5 minutes forever.
pub async fn refresh_usage_now(app: &AppHandle, force_refresh: bool) -> bool {
    let Some(server) = crate::servers::app_current_server(app).await else {
        log::debug!("usage_summary_skip_poll reason=no_server");
        return false;
    };
    refresh_server_usage(app, &server, force_refresh).await
}

/// Fetch usage from one server and record it under that server.
pub async fn refresh_server_usage(app: &AppHandle, server: &ServerId, force_refresh: bool) -> bool {
    let state: tauri::State<'_, AppState> = app.state();
    // Collapse overlapping triggers (background poll + manual refresh +
    // tray-open refresh racing after wake-from-sleep) into one in-flight
    // fetch per server; losers simply skip — the winner's redraw covers
    // them within seconds.
    if !state.usage_fetch_inflight.lock().unwrap().insert(server.clone()) {
        log::debug!("usage_summary_skip_poll reason=fetch_already_inflight");
        return true; // don't count a skipped poll as a failure for backoff
    }
    let outcome = match crate::servers::endpoint(app, server).await {
        Some((base_url, token)) => fetch_usage_summary(&base_url, token.as_deref(), force_refresh)
            .await
            .map_err(|e| format!("{e:#}")),
        None => Err("The builtin backend is not running.".to_string()),
    };
    let success = outcome.is_ok();
    update_tray_usage(app, server, outcome).await;
    state.usage_fetch_inflight.lock().unwrap().remove(server);
    success
}

/// Unix-seconds timestamp of the last tray-open-triggered refresh.
/// Module-local because it only rate-limits this one trigger source.
#[cfg(not(target_os = "macos"))]
static LAST_TRAY_OPEN_REFRESH: std::sync::atomic::AtomicI64 =
    std::sync::atomic::AtomicI64::new(0);

/// Opportunistic refresh when the user opens the tray menu — the moment
/// the data is actually looked at. Non-forced (happy to hit the backend's
/// warm cache) and rate-limited by ``USAGE_TRAY_OPEN_MIN_GAP`` so click
/// spam doesn't queue refreshes.
#[cfg(not(target_os = "macos"))]
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
        let reachable = match crate::servers::app_current_server(&app).await {
            Some(server) => crate::servers::endpoint(&app, &server).await.is_some(),
            None => false,
        };
        if reachable {
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
    use super::{
        external_usage_access_key, macos_tray_icon, MENU_NEW_SESSION, MENU_NEW_WINDOW,
        MENU_OPEN_WORKSPACE, MENU_TERMINAL, MENU_TOGGLE_SIDEBAR,
    };

    #[test]
    fn menu_command_ids_match_the_frontend_bridge() {
        // `emit_frontend_command` payloads are matched by string in
        // web/src/lib/desktop-commands.ts.
        assert_eq!(MENU_NEW_SESSION, "new_session");
        assert_eq!(MENU_NEW_WINDOW, "new_window");
        assert_eq!(MENU_OPEN_WORKSPACE, "open_workspace");
        assert_eq!(MENU_TOGGLE_SIDEBAR, "toggle_sidebar");
        assert_eq!(MENU_TERMINAL, "terminal");
    }

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
    fn external_usage_access_key_uses_the_stored_key_and_drops_store_errors() {
        assert_eq!(
            external_usage_access_key(Ok(Some("access-key".to_string()))).as_deref(),
            Some("access-key")
        );
        assert_eq!(external_usage_access_key(Ok(None)), None);
        assert_eq!(
            external_usage_access_key(Err("credential store unavailable".to_string())),
            None,
            "a store failure leaves the request unauthenticated"
        );
    }
}
