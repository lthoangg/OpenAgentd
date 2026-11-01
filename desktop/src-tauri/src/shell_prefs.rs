//! Small shell-level preferences that outlive a session (`desktop-shell.json`).
//!
//! Only what the shell itself acts on lives here: the page keeps its own
//! preferences in webview storage, which the shell cannot read before a page
//! loads. Today that is the last zoom factor (a new window opens at it) and
//! the opt-in global shortcuts switch.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::window::{ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN};

const FILE: &str = "desktop-shell.json";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellPrefs {
    /// The zoom factor last chosen in any window.
    pub zoom: f64,
    /// Global shortcuts are off until the user turns them on: they take keys
    /// from every other app.
    pub global_shortcuts: bool,
}

impl Default for ShellPrefs {
    fn default() -> Self {
        Self { zoom: ZOOM_DEFAULT, global_shortcuts: false }
    }
}

/// `zoom` within the bounds the menu enforces. A hand-edited or corrupt value
/// (NaN, 0, 40) must not open every window unreadably small or huge.
pub fn clamp_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() {
        zoom.clamp(ZOOM_MIN, ZOOM_MAX)
    } else {
        ZOOM_DEFAULT
    }
}

/// The prefs in `bytes`; a missing or unreadable file, or a missing key, takes
/// the default.
fn prefs_from(bytes: Option<&[u8]>) -> ShellPrefs {
    let prefs: ShellPrefs = bytes
        .and_then(|b| serde_json::from_slice(b).ok())
        .unwrap_or_default();
    ShellPrefs { zoom: clamp_zoom(prefs.zoom), ..prefs }
}

// Zoom and the shortcuts switch are written from different threads (menu
// handler, command); each read-modify-write holds this so neither drops the
// other's change.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn read(app: &AppHandle) -> ShellPrefs {
    let bytes = crate::config::app_config_file(app, FILE)
        .ok()
        .and_then(|path| std::fs::read(path).ok());
    prefs_from(bytes.as_deref())
}

pub fn load(app: &AppHandle) -> ShellPrefs {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    read(app)
}

/// Apply `change` to the saved prefs and write them back when they differ.
pub fn update(app: &AppHandle, change: impl FnOnce(&mut ShellPrefs)) -> Result<ShellPrefs> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = read(app);
    let mut after = before;
    change(&mut after);
    after.zoom = clamp_zoom(after.zoom);
    if after != before {
        let path = crate::config::app_config_file(app, FILE)?;
        let bytes = serde_json::to_vec_pretty(&after).context("serialize shell prefs")?;
        std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_unreadable_files_take_the_defaults() {
        let defaults = ShellPrefs::default();
        assert_eq!(prefs_from(None), defaults);
        assert_eq!(prefs_from(Some(b"not json")), defaults);
        assert_eq!(defaults.zoom, 1.0);
        assert!(!defaults.global_shortcuts, "global shortcuts are opt-in");
    }

    #[test]
    fn each_key_defaults_on_its_own() {
        let only_zoom = prefs_from(Some(br#"{"zoom": 1.44}"#));
        assert_eq!(only_zoom, ShellPrefs { zoom: 1.44, global_shortcuts: false });
        let only_shortcuts = prefs_from(Some(br#"{"globalShortcuts": true}"#));
        assert_eq!(only_shortcuts, ShellPrefs { zoom: 1.0, global_shortcuts: true });
    }

    #[test]
    fn a_saved_zoom_is_held_to_the_menu_bounds() {
        assert_eq!(prefs_from(Some(br#"{"zoom": 40}"#)).zoom, ZOOM_MAX);
        assert_eq!(prefs_from(Some(br#"{"zoom": 0.01}"#)).zoom, ZOOM_MIN);
        assert_eq!(prefs_from(Some(br#"{"zoom": -2}"#)).zoom, ZOOM_MIN);
        assert_eq!(clamp_zoom(f64::NAN), ZOOM_DEFAULT);
        assert_eq!(clamp_zoom(f64::INFINITY), ZOOM_DEFAULT);
    }

    #[test]
    fn prefs_survive_a_round_trip() {
        let saved = ShellPrefs { zoom: 1.728, global_shortcuts: true };
        let bytes = serde_json::to_vec(&saved).unwrap();
        assert_eq!(prefs_from(Some(&bytes)), saved);
        assert!(String::from_utf8(bytes).unwrap().contains("globalShortcuts"));
    }
}
