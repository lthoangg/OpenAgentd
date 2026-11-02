//! Opt-in system-wide shortcuts: bring OpenAgentd forward, and jump to the
//! next session that waits on you.
//!
//! Off until the user ticks "Global Shortcuts" in the app menu: these keys
//! are taken from every other app. The plugin is not even started while the
//! switch is off, so a platform without global hotkeys (Wayland with no
//! XWayland) can neither fail the launch nor cost anything.

use anyhow::{Context, Result};
use std::sync::{Mutex, OnceLock};
use tauri::{menu::CheckMenuItem, AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcut, Modifiers, Shortcut, ShortcutEvent, ShortcutState};

pub const MENU_GLOBAL_SHORTCUTS: &str = "global_shortcuts";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    /// Bring the app window forward, opening one if none is.
    ShowApp,
    /// Open the first session waiting on the user (`web/src/lib/desktop-commands.ts`).
    NextNeedsYou,
}

const ACTIONS: [Action; 2] = [Action::ShowApp, Action::NextNeedsYou];

/// The web handles this command by opening a session that needs the user.
const NEXT_NEEDS_YOU_COMMAND: &str = "next_needs_you";

impl Action {
    fn key(self) -> Code {
        match self {
            Action::ShowApp => Code::KeyO,
            Action::NextNeedsYou => Code::KeyJ,
        }
    }

    /// ⌥⌘ on macOS, Ctrl+Alt elsewhere: the combinations launchers and editors
    /// leave alone, and not one chord an app already claims on its own.
    fn shortcut(self) -> Shortcut {
        let modifiers = if cfg!(target_os = "macos") {
            Modifiers::ALT | Modifiers::SUPER
        } else {
            Modifiers::CONTROL | Modifiers::ALT
        };
        Shortcut::new(Some(modifiers), self.key())
    }

    fn hint(self) -> String {
        let letter = match self {
            Action::ShowApp => 'O',
            Action::NextNeedsYou => 'J',
        };
        if cfg!(target_os = "macos") {
            format!("⌥⌘{letter}")
        } else {
            format!("Ctrl+Alt+{letter}")
        }
    }

    fn from_shortcut_id(id: u32) -> Option<Self> {
        ACTIONS.into_iter().find(|action| action.shortcut().id() == id)
    }
}

/// The menu item's text. The keys are listed in the Keyboard Shortcuts sheet
/// and the docs, not here: a menu title carries no key text.
const MENU_LABEL: &str = "Global Shortcuts";

fn menu_item_slot() -> &'static Mutex<Option<CheckMenuItem<Wry>>> {
    static ITEM: OnceLock<Mutex<Option<CheckMenuItem<Wry>>>> = OnceLock::new();
    ITEM.get_or_init(|| Mutex::new(None))
}

/// The "Global Shortcuts" check item for the app menu, ticked as saved.
pub fn menu_item(app: &tauri::App) -> tauri::Result<CheckMenuItem<Wry>> {
    let enabled = crate::shell_prefs::load(app.handle()).global_shortcuts;
    let item = CheckMenuItem::with_id(app, MENU_GLOBAL_SHORTCUTS, MENU_LABEL, true, enabled, None::<&str>)?;
    if let Ok(mut slot) = menu_item_slot().lock() {
        *slot = Some(item.clone());
    }
    Ok(item)
}

/// Register the saved choice at launch (main thread).
pub fn start(app: &AppHandle) {
    if !crate::shell_prefs::load(app).global_shortcuts {
        return;
    }
    match register_all(app) {
        Ok(0) | Err(_) => log::warn!("global shortcuts are on, but none could be registered"),
        Ok(count) => log::info!("global shortcuts registered count={count}"),
    }
}

/// The menu item was clicked: flip the saved choice (main thread).
pub fn toggle(app: &AppHandle) {
    let want = !crate::shell_prefs::load(app).global_shortcuts;
    let enabled = if want { enable(app) } else { disable(app) };
    if let Err(e) = crate::shell_prefs::update(app, |prefs| prefs.global_shortcuts = enabled) {
        log::warn!("could not save the global shortcuts choice: {e:#}");
    }
    // The platform ticks a check item on click; say what is really so.
    let item = menu_item_slot().lock().ok().and_then(|slot| slot.clone());
    if let Some(item) = item {
        let _ = item.set_checked(enabled);
    }
}

fn enable(app: &AppHandle) -> bool {
    match register_all(app) {
        Ok(count) if count == ACTIONS.len() => true,
        // One taken: the other still works, and the user hears about it.
        Ok(count) if count > 0 => {
            report_conflict(app, true);
            true
        }
        outcome => {
            if let Err(e) = outcome {
                log::warn!("global shortcuts unavailable: {e:#}");
            }
            report_conflict(app, false);
            false
        }
    }
}

fn disable(app: &AppHandle) -> bool {
    if let Some(shortcuts) = app.try_state::<GlobalShortcut<Wry>>() {
        for action in ACTIONS {
            if let Err(e) = shortcuts.unregister(action.shortcut()) {
                log::warn!("could not release {}: {e}", action.hint());
            }
        }
    }
    false
}

/// Start the plugin once, on first use.
fn ensure_plugin(app: &AppHandle) -> Result<()> {
    if app.try_state::<GlobalShortcut<Wry>>().is_some() {
        return Ok(());
    }
    let plugin = tauri_plugin_global_shortcut::Builder::new().with_handler(on_shortcut).build();
    app.plugin(plugin).context("start the global shortcut service")
}

/// How many of the shortcuts are registered afterwards.
fn register_all(app: &AppHandle) -> Result<usize> {
    ensure_plugin(app)?;
    let shortcuts = app
        .try_state::<GlobalShortcut<Wry>>()
        .context("the global shortcut service is not running")?;
    let mut registered = 0;
    for action in ACTIONS {
        let shortcut = action.shortcut();
        if shortcuts.is_registered(shortcut) {
            registered += 1;
            continue;
        }
        match shortcuts.register(shortcut) {
            Ok(()) => registered += 1,
            Err(e) => log::warn!("could not register {}: {e}", action.hint()),
        }
    }
    Ok(registered)
}

fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    // Press only: the release of the same chord must not run it twice.
    if event.state != ShortcutState::Pressed {
        return;
    }
    match Action::from_shortcut_id(shortcut.id()) {
        Some(Action::ShowApp) => crate::window::show_main_window(app),
        Some(Action::NextNeedsYou) => crate::window::emit_frontend_command(app, NEXT_NEEDS_YOU_COMMAND),
        None => {}
    }
}

fn report_conflict(app: &AppHandle, partly: bool) {
    let keys = format!("{} and {}", Action::ShowApp.hint(), Action::NextNeedsYou.hint());
    let message = if partly {
        format!("Another app already uses one of {keys}, so only the other works.")
    } else {
        format!(
            "OpenAgentd could not claim {keys}. Another app may already use them, or the system \
             may not allow global shortcuts (Wayland, for one)."
        )
    };
    app.dialog()
        .message(message)
        .title("Global Shortcuts")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_action_has_its_own_chord_with_modifiers() {
        let show = Action::ShowApp.shortcut();
        let next = Action::NextNeedsYou.shortcut();
        assert_ne!(show.id(), next.id());
        for action in ACTIONS {
            // A bare letter would swallow typing in every app.
            assert!(!action.shortcut().mods.is_empty(), "{action:?}");
        }
    }

    #[test]
    fn a_fired_chord_maps_back_to_its_action() {
        for action in ACTIONS {
            assert_eq!(Action::from_shortcut_id(action.shortcut().id()), Some(action));
        }
        assert_eq!(Action::from_shortcut_id(0), None);
    }

    #[test]
    fn the_chords_are_spelled_for_the_platform() {
        for action in ACTIONS {
            let hint = action.hint();
            if cfg!(target_os = "macos") {
                assert!(hint.starts_with("⌥⌘"), "{hint}");
            } else {
                assert!(hint.starts_with("Ctrl+Alt+"), "{hint}");
            }
        }
        assert_eq!(Action::ShowApp.hint().chars().last(), Some('O'));
        assert_eq!(Action::NextNeedsYou.hint().chars().last(), Some('J'));
    }

    // The web matches this string (`web/src/lib/desktop-commands.ts`).
    #[test]
    fn the_next_needs_you_command_matches_the_web_bridge() {
        assert_eq!(NEXT_NEEDS_YOU_COMMAND, "next_needs_you");
    }
}
