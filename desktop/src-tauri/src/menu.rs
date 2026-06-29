use anyhow::Result;
use std::path::PathBuf;
use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_opener::OpenerExt;

use crate::AppState;
use crate::window::{
    adjust_zoom, create_app_window, emit_frontend_command, navigate_main_window,
    set_zoom, show_main_window, ZOOM_DEFAULT, ZOOM_STEP,
};
use crate::reload_main_window;
use crate::updater::request_update_check;

pub const MENU_SHOW: &str = "show";
pub const MENU_NEW_WINDOW: &str = "new_window";
pub const MENU_HOME: &str = "home";
pub const MENU_CHAT: &str = "chat";
pub const MENU_CODING: &str = "coding";
pub const MENU_COMMAND_PALETTE: &str = "command_palette";
pub const MENU_WIKI: &str = "wiki";
pub const MENU_SCHEDULER: &str = "scheduler";
pub const MENU_AGENT_CAPABILITIES: &str = "agent_capabilities";
pub const MENU_SETTINGS: &str = "settings";
pub const MENU_PROVIDERS: &str = "providers";
pub const MENU_NOTIFICATIONS: &str = "notifications";
pub const MENU_TELEMETRY: &str = "telemetry";
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
        Some("CmdOrCtrl+N"),
    )?;
    let app_home = MenuItem::with_id(app, MENU_HOME, "Home", true, None::<&str>)?;
    let app_settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings", true, None::<&str>)?;
    let app_providers = MenuItem::with_id(app, MENU_PROVIDERS, "Providers", true, None::<&str>)?;
    let app_notifications =
        MenuItem::with_id(app, MENU_NOTIFICATIONS, "Notifications", true, None::<&str>)?;
    let app_telemetry = MenuItem::with_id(app, MENU_TELEMETRY, "Telemetry", true, None::<&str>)?;
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
        Some("CmdOrCtrl+N"),
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
        Some("Ctrl+P"),
    )?;
    let view_wiki = MenuItem::with_id(app, MENU_WIKI, "Wiki", true, Some("Ctrl+M"))?;
    let view_scheduler =
        MenuItem::with_id(app, MENU_SCHEDULER, "Scheduled Tasks", true, Some("Ctrl+S"))?;
    let view_agent_capabilities = MenuItem::with_id(
        app,
        MENU_AGENT_CAPABILITIES,
        "Session Settings",
        true,
        Some("Ctrl+A"),
    )?;
    let view_settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings", true, None::<&str>)?;
    let view_telemetry = MenuItem::with_id(app, MENU_TELEMETRY, "Telemetry", true, None::<&str>)?;
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
        .item(&app_providers)
        .item(&app_notifications)
        .item(&app_telemetry)
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
        .item(&view_wiki)
        .item(&view_scheduler)
        .item(&view_agent_capabilities)
        .separator()
        .item(&view_settings)
        .item(&view_telemetry)
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
    let tray_chat = MenuItem::with_id(app, MENU_CHAT, "Cockpit", true, None::<&str>)?;
    let tray_coding = MenuItem::with_id(app, MENU_CODING, "Coding", true, None::<&str>)?;
    let tray_command_palette = MenuItem::with_id(
        app,
        MENU_COMMAND_PALETTE,
        "Command Palette…",
        true,
        None::<&str>,
    )?;
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
    let tray_menu = Menu::with_items(
        app,
        &[
            &status,
            &session,
            &PredefinedMenuItem::separator(app)?,
            &tray_show,
            &tray_new_window,
            &tray_chat,
            &tray_coding,
            &tray_command_palette,
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
        .tooltip("OpenAgentd");
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone()).icon_as_template(true);
    }
    tray.build(app)?;

    let state: tauri::State<'_, AppState> = app.state();
    tauri::async_runtime::block_on(async {
        state.tray_status.lock().await.replace(status);
        state.tray_session.lock().await.replace(session);
    });
    Ok(())
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
        MENU_WIKI => emit_frontend_command(app, "wiki"),
        MENU_SCHEDULER => emit_frontend_command(app, "scheduler"),
        MENU_AGENT_CAPABILITIES => emit_frontend_command(app, "agent_capabilities"),
        MENU_SETTINGS => navigate_main_window(app, "/settings"),
        MENU_PROVIDERS => navigate_main_window(app, "/settings/providers"),
        MENU_NOTIFICATIONS => navigate_main_window(app, "/settings/notifications"),
        MENU_TELEMETRY => navigate_main_window(app, "/telemetry"),
        MENU_RELOAD => reload_main_window(app),
        MENU_FORCE_RELOAD => crate::force_reload_app(app),
        MENU_ZOOM_IN => adjust_zoom(app, ZOOM_STEP),
        MENU_ZOOM_OUT => adjust_zoom(app, 1.0 / ZOOM_STEP),
        MENU_ZOOM_RESET => set_zoom(app, ZOOM_DEFAULT),
        MENU_CHECK_UPDATES => request_update_check(app),
        MENU_OPEN_CONFIG_DIR => open_config_dir(app),
        MENU_REVEAL_DESKTOP_LOG => reveal_desktop_log(app),
        MENU_REVEAL_BACKEND_LOG => reveal_backend_log(app),
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
