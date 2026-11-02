//! The View → Text Size submenu: three check items that show the page's text
//! size.
//!
//! The page owns the setting (`useDisplayPrefsStore`, kept in webview storage
//! the shell cannot read), so a click only emits a command for the page to
//! apply, and the page reports the value back with `set_menu_text_size`
//! whenever it changes or a window takes focus. Exactly one item is ticked.

use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Submenu, SubmenuBuilder},
    AppHandle, Wry,
};

/// Prefix of the three items' ids; the rest is the size name the page uses.
pub const MENU_TEXT_SIZE_PREFIX: &str = "text_size:";

/// Size names as `useDisplayPrefsStore` spells them, with their menu titles.
const TEXT_SIZES: [(&str, &str); 3] = [("compact", "Compact"), ("default", "Default"), ("large", "Large")];
const DEFAULT_TEXT_SIZE: &str = "default";

static ITEMS: Mutex<Vec<(&'static str, CheckMenuItem<Wry>)>> = Mutex::new(Vec::new());

fn size_name(id: &str) -> Option<&'static str> {
    let name = id.strip_prefix(MENU_TEXT_SIZE_PREFIX)?;
    TEXT_SIZES.iter().map(|(size, _)| *size).find(|size| *size == name)
}

/// The command the page runs to apply `size` (`web/src/lib/desktop-commands.ts`).
fn page_command(size: &str) -> String {
    format!("text_size_{size}")
}

/// The "Text Size" submenu, with the default size ticked until the page says otherwise.
pub fn text_size_submenu(app: &tauri::App) -> tauri::Result<Submenu<Wry>> {
    let mut menu = SubmenuBuilder::new(app, "Text Size");
    let mut items = Vec::with_capacity(TEXT_SIZES.len());
    for (size, title) in TEXT_SIZES {
        let item = CheckMenuItem::with_id(
            app,
            format!("{MENU_TEXT_SIZE_PREFIX}{size}"),
            title,
            true,
            size == DEFAULT_TEXT_SIZE,
            None::<&str>,
        )?;
        menu = menu.item(&item);
        items.push((size, item));
    }
    let submenu = menu.build()?;
    if let Ok(mut slot) = ITEMS.lock() {
        *slot = items;
    }
    Ok(submenu)
}

/// Tick `size` and untick the others. A check item flips itself on click, so
/// clicking the ticked size would otherwise leave none ticked.
fn show_size(size: &str) {
    let items: Vec<_> = ITEMS.lock().map(|slot| slot.clone()).unwrap_or_default();
    for (name, item) in items {
        let _ = item.set_checked(name == size);
    }
}

/// Called by the app's single menu listener. False when `id` is not a text
/// size item.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some(size) = size_name(id) else {
        return false;
    };
    show_size(size);
    crate::window::emit_frontend_command(app, &page_command(size));
    true
}

/// The page's text size changed (or a window took focus): tick it in the menu.
#[tauri::command]
pub fn set_menu_text_size(app: AppHandle, size: String) -> Result<(), String> {
    let Some((size, _)) = TEXT_SIZES.iter().find(|(name, _)| *name == size) else {
        return Err(format!("Unknown text size: {size}"));
    };
    let size = *size;
    // Menus are only touched on the main thread.
    app.run_on_main_thread(move || show_size(size)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_size_ids_name_the_pages_sizes_and_nothing_else() {
        assert_eq!(size_name("text_size:compact"), Some("compact"));
        assert_eq!(size_name("text_size:default"), Some("default"));
        assert_eq!(size_name("text_size:large"), Some("large"));
        assert_eq!(size_name("text_size:huge"), None);
        assert_eq!(size_name("zoom_in"), None);
    }

    // The page matches these strings (`web/src/lib/desktop-commands.ts`).
    #[test]
    fn page_commands_match_the_web_bridge() {
        assert_eq!(page_command("compact"), "text_size_compact");
        assert_eq!(page_command("default"), "text_size_default");
        assert_eq!(page_command("large"), "text_size_large");
    }

    #[test]
    fn the_default_size_is_one_of_the_menu_sizes() {
        assert!(TEXT_SIZES.iter().any(|(size, _)| *size == DEFAULT_TEXT_SIZE));
    }
}
