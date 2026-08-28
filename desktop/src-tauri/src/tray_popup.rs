//! Custom webview tray popup (macOS).
//!
//! Tauri's native ``Menu``/``MenuItem`` maps to native OS menus, which cannot
//! be styled with CSS — a plain-text ceiling for a usage/status surface. On
//! macOS the tray instead toggles a small borderless, always-on-top webview
//! window anchored under the tray icon, rendered by the shared React web
//! bundle (``web/tray.html``). Windows/Linux keep the native tray menu
//! (see ``menu::install_native_tray``).
//!
//! The popup never receives the backend token: it talks to the backend only
//! indirectly, through IPC commands that run in the Rust process (which owns
//! the credential). ``get_tray_usage_summary`` hands back the cached snapshot
//! the usage poll loop maintains.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::AppState;

pub const TRAY_POPUP_WINDOW: &str = "tray-popup";

/// Event emitted right before the popup is shown so the (long-lived, hidden)
/// webview knows to refetch usage instead of showing a stale snapshot.
pub const TRAY_POPUP_REFRESH_EVENT: &str = "tray-popup-refresh";

/// Build the borderless popup window once at startup. It starts hidden and
/// stays alive (mounted) so toggling is cheap; the webview refetches on
/// every ``TRAY_POPUP_REFRESH_EVENT``.
#[cfg(target_os = "macos")]
pub fn create_tray_popup(app: &tauri::App) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        TRAY_POPUP_WINDOW,
        WebviewUrl::App("tray.html".into()),
    )
    .title("OpenAgentd")
    .inner_size(360.0, 480.0)
    .visible(false)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .shadow(true)
    // Requires the ``macos-private-api`` feature; transparent lets the CSS
    // draw rounded frosted corners instead of a rectangular webview.
    .transparent(true)
    .build()?;

    let hide_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = hide_window.hide();
        }
    });
    Ok(())
}

/// Toggle the popup open/closed, anchored under the tray icon.
#[cfg(target_os = "macos")]
pub fn toggle_tray_popup(app: &AppHandle) {
    use tauri_plugin_positioner::WindowExt;

    let Some(window) = app.get_webview_window(TRAY_POPUP_WINDOW) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    // The window stays mounted while hidden, so tell its React root to
    // refetch usage before we bring it up.
    let _ = app.emit(TRAY_POPUP_REFRESH_EVENT, ());
    let _ = window.move_window(tauri_plugin_positioner::Position::TrayBottomCenter);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Return the usage snapshot the popup renders along with the list of
/// available servers and the currently selected server.
#[tauri::command]
pub async fn get_tray_usage_summary(
    app: AppHandle,
    force: Option<bool>,
    target_server: Option<String>,
) -> Result<crate::usage::TrayUsageResult, String> {
    let state: tauri::State<'_, AppState> = app.state();
    let saved_config = crate::config::load_app_backend_config(&app).unwrap_or_default();
    let bundled_base = state.backend_base_url.lock().await.clone();
    let desktop_token = state.desktop_token.lock().await.clone();
    let sidecar_alive = {
        let mut guard = state.sidecar.lock().await;
        guard.as_mut().is_some_and(|s| s.is_alive())
    };

    // Probe saved external servers concurrently to keep only online & available ones.
    let mut join_set = tokio::task::JoinSet::new();
    for server in &saved_config.servers {
        let base_url = server.base_url.clone();
        join_set.spawn(async move {
            let alive = crate::usage::is_server_available(&base_url).await;
            (base_url, alive)
        });
    }
    let mut available_urls = std::collections::HashSet::new();
    while let Some(res) = join_set.join_next().await {
        if let Ok((url, true)) = res {
            available_urls.insert(url);
        }
    }

    // Determine current active endpoint
    let (active_name, active_id) = {
        let target_label = state.active_window_label.lock().unwrap().clone();
        let external_map = state.window_backend_base_urls.lock().unwrap().clone();
        if let Some(base) = external_map.get(&target_label).or_else(|| external_map.get(crate::window::MAIN_WINDOW)) {
            if available_urls.contains(base) {
                let name = crate::usage::resolve_server_display_name(base, &saved_config.servers);
                (name, base.clone())
            } else if sidecar_alive {
                ("Local Bundled".to_string(), "bundled".to_string())
            } else {
                ("No Server Connected".to_string(), "auto".to_string())
            }
        } else if let Some(ref base) = saved_config.active_base_url {
            if available_urls.contains(base) {
                let name = crate::usage::resolve_server_display_name(base, &saved_config.servers);
                (name, base.clone())
            } else if sidecar_alive {
                ("Local Bundled".to_string(), "bundled".to_string())
            } else {
                ("No Server Connected".to_string(), "auto".to_string())
            }
        } else if sidecar_alive {
            ("Local Bundled".to_string(), "bundled".to_string())
        } else {
            ("No Server Connected".to_string(), "auto".to_string())
        }
    };

    let mut available_servers = Vec::new();

    if sidecar_alive {
        available_servers.push(crate::usage::TrayServerOption {
            id: "bundled".to_string(),
            name: "Local Bundled".to_string(),
            detail: None,
        });
    }

    for server in &saved_config.servers {
        if available_urls.contains(&server.base_url) {
            let name = server.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| crate::usage::extract_host_port(&server.base_url));
            let host_port = crate::usage::extract_host_port(&server.base_url);
            available_servers.push(crate::usage::TrayServerOption {
                id: server.base_url.clone(),
                name,
                detail: Some(host_port),
            });
        }
    }

    let mut servers = Vec::new();
    if available_servers.len() > 1 {
        servers.push(crate::usage::TrayServerOption {
            id: "auto".to_string(),
            name: "Auto (Active Window)".to_string(),
            detail: if active_name != "No Server Connected" { Some(active_name.clone()) } else { None },
        });
    }
    servers.extend(available_servers);

    let mut selected = target_server.unwrap_or_else(|| "auto".to_string());
    if selected != "auto" && !servers.iter().any(|s| s.id == selected) {
        selected = "auto".to_string();
    }

    if selected == "auto" {
        let _ = crate::menu::refresh_usage_now(&app, force.unwrap_or(false)).await;
        let snapshot = state.usage_summary.lock().await.clone();
        return Ok(crate::usage::TrayUsageResult {
            summary: snapshot,
            server_name: active_name,
            server_id: active_id,
            servers,
            selected_server_id: "auto".to_string(),
            error: None,
        });
    }

    if selected == "bundled" {
        let name = "Local Bundled".to_string();
        if let Some(base) = bundled_base {
            match crate::usage::fetch_usage_summary(&base, desktop_token.as_deref(), force.unwrap_or(false)).await {
                Ok(summary) => Ok(crate::usage::TrayUsageResult {
                    summary: Some(summary),
                    server_name: name,
                    server_id: "bundled".to_string(),
                    servers,
                    selected_server_id: "bundled".to_string(),
                    error: None,
                }),
                Err(err) => Ok(crate::usage::TrayUsageResult {
                    summary: None,
                    server_name: name,
                    server_id: "bundled".to_string(),
                    servers,
                    selected_server_id: "bundled".to_string(),
                    error: Some(format!("{err:#}")),
                }),
            }
        } else {
            Ok(crate::usage::TrayUsageResult {
                summary: None,
                server_name: name,
                server_id: "bundled".to_string(),
                servers,
                selected_server_id: "bundled".to_string(),
                error: Some("Local bundled backend is not running".to_string()),
            })
        }
    } else {
        let base_url = selected.clone();
        let name = crate::usage::resolve_server_display_name(&base_url, &saved_config.servers);
        let access_key = crate::menu::external_usage_access_key(&base_url, crate::commands::secure_get_access_key);
        match crate::usage::fetch_usage_summary(&base_url, access_key.as_deref(), force.unwrap_or(false)).await {
            Ok(summary) => Ok(crate::usage::TrayUsageResult {
                summary: Some(summary),
                server_name: name,
                server_id: base_url.clone(),
                servers,
                selected_server_id: base_url,
                error: None,
            }),
            Err(err) => Ok(crate::usage::TrayUsageResult {
                summary: None,
                server_name: name,
                server_id: base_url.clone(),
                servers,
                selected_server_id: base_url,
                error: Some(format!("{err:#}")),
            }),
        }
    }
}

/// Dispatch a popup action by the same id strings the native menu uses
/// (``show``, ``new_window``, ``coding``, ``settings``, ``open_config_dir``,
/// ``quit``, ...), then close the popup — a menu closes after an item fires.
#[tauri::command]
pub fn tray_action(app: AppHandle, action: String) {
    crate::menu::handle_desktop_menu(&app, &action);
    if let Some(window) = app.get_webview_window(TRAY_POPUP_WINDOW) {
        let _ = window.hide();
    }
}
