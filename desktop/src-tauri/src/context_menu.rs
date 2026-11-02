//! The application menu as a pop-up on Windows and Linux, where the menu bar
//! is hidden (`show_app_menu`).
//!
//! The page's own menus (right-click, ⋯, long-press sheets) are drawn by the
//! page in every shell: native is the feel, not the OS widget. Only the
//! window's menu bar, which belongs to the shell, pops up here.

use anyhow::{Context, Result};
use tauri::{menu::Menu, AppHandle, LogicalPosition, Manager, WebviewWindow, Wry};

use crate::window::{is_overlay_window, ZOOM_DEFAULT};
use crate::AppState;

/// No window is larger than this in CSS pixels; a coordinate beyond it is a bug.
const MAX_COORDINATE: f64 = 20_000.0;

/// A point in CSS pixels of the page, as the window-relative logical point the
/// menu code wants. Page zoom scales CSS pixels, so ⌘+ must move the menu too.
pub(crate) fn window_point(x: f64, y: f64, zoom: f64) -> Result<LogicalPosition<f64>, String> {
    let valid = |v: f64| v.is_finite() && (0.0..=MAX_COORDINATE).contains(&v);
    if !valid(x) || !valid(y) {
        return Err("Invalid menu position.".into());
    }
    let zoom = if zoom.is_finite() && zoom > 0.0 { zoom } else { ZOOM_DEFAULT };
    Ok(LogicalPosition::new(x * zoom, y * zoom))
}

pub(crate) fn zoom_of(app: &AppHandle, label: &str) -> f64 {
    let state: tauri::State<'_, AppState> = app.state();
    let zoom = state.window_zoom_factors.lock().unwrap().get(label).copied();
    zoom.unwrap_or(ZOOM_DEFAULT)
}

/// Pop the application menu up at (`x`, `y`), CSS pixels from the page's
/// top-left corner. Windows and Linux hide the menu bar (`window.rs`), so the
/// header's ☰ button and a bare Alt tap open it here instead. The items run
/// through the app's usual menu listener, so nothing comes back.
#[tauri::command]
pub async fn show_app_menu(app: AppHandle, window: WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    if is_overlay_window(window.label()) {
        return Err("Only app windows can show the application menu.".into());
    }
    let at = window_point(x, y, zoom_of(&app, window.label()))?;
    run_popup(&app, &window, move |handle| {
        let menu = handle.menu().context("the application menu is not installed")?;
        Ok((menu, at))
    })
    .await
    .inspect_err(|e| log::warn!("could not show the application menu: {e}"))
}

/// Build a menu with `prepare` and pop it up on the main thread, where the
/// platform's menu loop must run. Resolves once the menu has closed.
async fn run_popup(
    app: &AppHandle,
    window: &WebviewWindow,
    prepare: impl FnOnce(&AppHandle) -> Result<(Menu<Wry>, LogicalPosition<f64>)> + Send + 'static,
) -> Result<(), String> {
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let (handle, window) = (app.clone(), window.clone());
    app.run_on_main_thread(move || {
        let result = prepare(&handle).and_then(|(menu, at)| {
            window.popup_menu_at(&menu, at).context("pop up the menu")
        });
        let _ = done_tx.send(result.map_err(|e| format!("{e:#}")));
    })
    .map_err(|e| e.to_string())?;
    done_rx.await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_pixels_become_window_points_at_the_pages_zoom() {
        let at = window_point(100.0, 40.0, 1.5).unwrap();
        assert_eq!((at.x, at.y), (150.0, 60.0));
        let at = window_point(8.0, 8.0, 1.0).unwrap();
        assert_eq!((at.x, at.y), (8.0, 8.0));
        // A broken zoom does not move the menu off the click.
        let at = window_point(8.0, 8.0, f64::NAN).unwrap();
        assert_eq!((at.x, at.y), (8.0, 8.0));
    }

    #[test]
    fn positions_off_the_page_are_refused() {
        assert!(window_point(f64::NAN, 1.0, 1.0).is_err());
        assert!(window_point(1.0, f64::INFINITY, 1.0).is_err());
        assert!(window_point(-1.0, 1.0, 1.0).is_err());
        assert!(window_point(1.0, MAX_COORDINATE + 1.0, 1.0).is_err());
    }
}
