//! Native pop-up menus for the app windows: the page's own context menus
//! (`show_context_menu`) and, on Windows and Linux where the menu bar is
//! hidden, the application menu (`show_app_menu`).
//!
//! Both pop up at a point in the calling window and keep their IPC promise
//! pending until the menu closes. The page's items come back as the ids it
//! chose, so the page keeps the actions and only borrows the OS's menu
//! (keyboard navigation, accessibility, the platform's look and feel).

use anyhow::{Context, Result};
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, LogicalPosition, Manager, WebviewWindow, Wry,
};

use crate::window::{is_overlay_window, ZOOM_DEFAULT};
use crate::AppState;

/// Native ids of the page's items. The prefix keeps them apart from the app
/// menu's ids (`menu.rs`), which share the one menu-event listener.
const ID_PREFIX: &str = "ctx:";

/// More than this is not a context menu.
const MAX_ITEMS: usize = 100;
const MAX_TEXT_CHARS: usize = 300;
/// No window is larger than this in CSS pixels; a coordinate beyond it is a bug.
const MAX_COORDINATE: f64 = 20_000.0;

/// How long after the menu closes the chosen item's event may still be on its
/// way: the platform runs the menu's own loop, then the click reaches the one
/// app-level listener through the event queue.
const SELECTION_GRACE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
    /// What the page gets back when this item is chosen. Unused by separators.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Present: a check item showing this state.
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub separator: bool,
}

/// Why `items` cannot be a menu, if it cannot.
fn validate_items(items: &[ContextMenuItem]) -> Result<(), String> {
    if items.len() > MAX_ITEMS {
        return Err(format!("A menu has at most {MAX_ITEMS} items."));
    }
    let mut actionable = 0;
    for item in items.iter().filter(|item| !item.separator) {
        if item.id.trim().is_empty() || item.label.trim().is_empty() {
            return Err("Every menu item needs an id and a label.".into());
        }
        if item.id.chars().count() > MAX_TEXT_CHARS || item.label.chars().count() > MAX_TEXT_CHARS {
            return Err("A menu item is too long.".into());
        }
        actionable += 1;
    }
    if actionable == 0 {
        return Err("A menu needs at least one item.".into());
    }
    Ok(())
}

/// `label` as a menu title. Windows and Linux read a single `&` as a keyboard
/// mnemonic and drop it; a session titled "R&D" must keep its ampersand.
/// macOS strips single ones too, and every platform reads `&&` as a literal.
fn menu_title(label: &str) -> String {
    label.replace('&', "&&")
}

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

fn native_id(seq: u64, index: usize) -> String {
    format!("{ID_PREFIX}{seq}:{index}")
}

/// The call and item index a native id stands for.
fn parse_native_id(id: &str) -> Option<(u64, usize)> {
    let (seq, index) = id.strip_prefix(ID_PREFIX)?.split_once(':')?;
    Some((seq.parse().ok()?, index.parse().ok()?))
}

/// The one menu waiting for a choice. A new call replaces it (its caller then
/// sees the menu as dismissed), so a stale click can never answer a later menu.
struct Pending {
    seq: u64,
    ids: Vec<String>,
    chosen: tokio::sync::oneshot::Sender<String>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

fn lock_pending() -> std::sync::MutexGuard<'static, Option<Pending>> {
    PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Forget the pending menu if it is still call `seq`'s.
fn clear_pending(seq: u64) {
    let mut slot = lock_pending();
    if slot.as_ref().is_some_and(|pending| pending.seq == seq) {
        *slot = None;
    }
}

/// Called by the app's single menu listener. False when `id` is not one of
/// the page's items.
pub fn handle_menu_event(id: &str) -> bool {
    let Some((seq, index)) = parse_native_id(id) else {
        return false;
    };
    let mut slot = lock_pending();
    if slot.as_ref().is_some_and(|pending| pending.seq == seq) {
        if let Some(pending) = slot.take() {
            if let Some(chosen) = pending.ids.get(index) {
                let _ = pending.chosen.send(chosen.clone());
            }
        }
    }
    true
}

fn build_menu(app: &AppHandle, seq: u64, items: &[ContextMenuItem]) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for (index, item) in items.iter().enumerate() {
        if item.separator {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            continue;
        }
        let (id, title, enabled) = (native_id(seq, index), menu_title(&item.label), item.enabled.unwrap_or(true));
        match item.checked {
            Some(checked) => menu.append(&CheckMenuItem::with_id(app, id, title, enabled, checked, None::<&str>)?)?,
            None => menu.append(&MenuItem::with_id(app, id, title, enabled, None::<&str>)?)?,
        }
    }
    Ok(menu)
}

/// Pop a native menu up in `window` and resolve with the id of the item the
/// user chose, or `None` when the menu was dismissed. `x` and `y` are CSS
/// pixels from the page's top-left corner.
#[tauri::command]
pub async fn show_context_menu(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<ContextMenuItem>,
    x: f64,
    y: f64,
) -> Result<Option<String>, String> {
    if is_overlay_window(window.label()) {
        return Err("Only app windows can show a context menu.".into());
    }
    validate_items(&items)?;
    let at = window_point(x, y, zoom_of(&app, window.label()))?;
    let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
    let (chosen_tx, mut chosen_rx) = tokio::sync::oneshot::channel();
    *lock_pending() = Some(Pending {
        seq,
        ids: items.iter().map(|item| item.id.clone()).collect(),
        chosen: chosen_tx,
    });
    let shown = run_popup(&app, &window, move |handle| Ok((build_menu(handle, seq, &items)?, at))).await;
    if let Err(e) = shown {
        log::warn!("could not show a context menu: {e}");
        clear_pending(seq);
        return Err(e);
    }
    let chosen = tokio::time::timeout(SELECTION_GRACE, &mut chosen_rx)
        .await
        .ok()
        .and_then(Result::ok);
    clear_pending(seq);
    Ok(chosen)
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

    fn item(id: &str, label: &str) -> ContextMenuItem {
        ContextMenuItem { id: id.into(), label: label.into(), enabled: None, checked: None, separator: false }
    }

    fn separator() -> ContextMenuItem {
        ContextMenuItem { id: String::new(), label: String::new(), enabled: None, checked: None, separator: true }
    }

    #[test]
    fn the_pages_json_shape_deserializes_with_optional_fields() {
        let items: Vec<ContextMenuItem> = serde_json::from_str(
            r#"[{"id":"rename","label":"Rename"},
                {"separator":true},
                {"id":"pin","label":"Pinned","checked":true,"enabled":false}]"#,
        )
        .unwrap();
        assert_eq!(items.len(), 3);
        assert!(items[1].separator && items[1].id.is_empty());
        assert_eq!((items[2].checked, items[2].enabled), (Some(true), Some(false)));
        assert_eq!(items[0].checked, None);
    }

    #[test]
    fn native_ids_carry_the_call_and_the_position_and_stay_out_of_the_app_menus_way() {
        let id = native_id(7, 3);
        assert_eq!(parse_native_id(&id), Some((7, 3)));
        assert!(id.starts_with(ID_PREFIX));
        // The app menu's own ids never parse as one of ours.
        for app_id in [crate::menu::MENU_SETTINGS, crate::menu::MENU_QUIT, "text_size:large", "global_shortcuts"] {
            assert_eq!(parse_native_id(app_id), None, "{app_id}");
        }
        assert_eq!(parse_native_id("ctx:7"), None);
        assert_eq!(parse_native_id("ctx:x:1"), None);
        assert_eq!(parse_native_id("island:open:ctx:1:2"), None);
    }

    #[test]
    fn a_choice_answers_only_the_menu_that_is_open() {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        *lock_pending() = Some(Pending { seq: 41, ids: vec!["a".into(), "b".into()], chosen: tx });
        // A click from an earlier menu is consumed but answers nothing.
        assert!(handle_menu_event(&native_id(40, 0)));
        assert!(rx.try_recv().is_err());
        assert!(handle_menu_event(&native_id(41, 1)));
        assert_eq!(rx.try_recv().ok().as_deref(), Some("b"));
        // Ids that are not ours fall through to the app menu.
        assert!(!handle_menu_event("settings"));
        assert!(lock_pending().is_none());
    }

    #[test]
    fn items_are_checked_before_a_menu_is_built() {
        assert!(validate_items(&[item("open", "Open"), separator(), item("close", "Close")]).is_ok());
        assert!(validate_items(&[]).is_err());
        assert!(validate_items(&[separator()]).is_err());
        assert!(validate_items(&[item("", "Open")]).is_err());
        assert!(validate_items(&[item("open", "  ")]).is_err());
        assert!(validate_items(&[item("open", &"x".repeat(MAX_TEXT_CHARS + 1))]).is_err());
        let many: Vec<_> = (0..=MAX_ITEMS).map(|i| item(&i.to_string(), "Item")).collect();
        assert!(validate_items(&many).is_err());
    }

    #[test]
    fn an_ampersand_in_a_label_is_not_a_mnemonic() {
        assert_eq!(menu_title("R&D notes"), "R&&D notes");
        assert_eq!(menu_title("Plain"), "Plain");
    }

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
