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

/// Return the cached usage snapshot the popup renders. Triggers an
/// opportunistic (non-forced, rate-limited) refresh first so the numbers are
/// current, but always returns the last-known-good snapshot immediately.
/// ``force`` bypasses the backend's short-lived cache (used by the popup's
/// manual refresh button).
#[tauri::command]
pub async fn get_tray_usage_summary(
    app: AppHandle,
    force: Option<bool>,
) -> Result<Option<crate::usage::UsageSummaryBody>, String> {
    let _ = crate::menu::refresh_usage_now(&app, force.unwrap_or(false)).await;
    let state: tauri::State<'_, AppState> = app.state();
    let snapshot = state.usage_summary.lock().await.clone();
    Ok(snapshot)
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
