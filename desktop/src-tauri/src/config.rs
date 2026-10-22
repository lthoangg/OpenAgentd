use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// Backend-server config, URL normalisation, and their file format are shared
// with the mobile shell in `openagentd-shell-core`; this module keeps the
// desktop names and adds the `AppHandle` → path adapters.
pub use openagentd_shell_core::backend_config::normalize_base_url as normalize_external_base_url;
pub use openagentd_shell_core::backend_config::{
    normalize_server_name, AppBackendConfig, SavedAppServer,
};
use openagentd_shell_core::backend_config::{
    load_backend_config_from, remove_backend_server_at, save_backend_config_to,
};

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct SavedWindowState {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
pub struct AppBackendStatus {
    pub base_url: String,
    pub token: Option<String>,
    pub mode: String,
    pub sidecar_running: bool,
    pub backend_starting: bool,
    pub backend_failed: bool,
    pub external: bool,
    pub supports_bundled: bool,
    pub servers: Vec<SavedAppServer>,
}

pub fn app_config_file(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("resolve app config dir")?;
    std::fs::create_dir_all(&dir).context("create app config dir")?;
    Ok(dir.join(name))
}

pub fn app_backend_config_path(app: &AppHandle) -> Result<PathBuf> {
    app_config_file(app, "desktop-backend.json")
}

pub fn window_state_path(app: &AppHandle) -> Result<PathBuf> {
    app_config_file(app, "window-state.json")
}

pub fn load_window_state(app: &AppHandle) -> Result<Option<SavedWindowState>> {
    let path = window_state_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let state: SavedWindowState =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    if state.width < 760 || state.height < 560 {
        return Ok(None);
    }
    Ok(Some(state))
}

/// The size worth remembering for a window in this state: `None` while it is
/// minimized or maximized, or smaller than the minimum we restore.
pub fn rememberable_size(
    width: u32,
    height: u32,
    minimized: bool,
    maximized: bool,
) -> Option<SavedWindowState> {
    if minimized || maximized || width < 760 || height < 560 {
        return None;
    }
    Some(SavedWindowState { width, height })
}

/// The current size of `window`, if it is one worth remembering.
pub fn window_size(window: &tauri::WebviewWindow) -> Option<SavedWindowState> {
    let size = window.inner_size().ok()?;
    rememberable_size(
        size.width,
        size.height,
        window.is_minimized().unwrap_or(false),
        window.is_maximized().unwrap_or(false),
    )
}

pub fn save_window_state(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<()> {
    let Some(state) = window_size(window) else {
        return Ok(());
    };
    let path = window_state_path(app)?;
    let bytes = serde_json::to_vec_pretty(&state).context("serialize window state")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}

pub fn load_app_backend_config(app: &AppHandle) -> Result<AppBackendConfig> {
    load_backend_config_from(&app_backend_config_path(app)?)
}

pub fn save_app_backend_config(
    app: &AppHandle,
    base_url: Option<&str>,
    name: Option<&str>,
    activate: bool,
) -> Result<()> {
    save_backend_config_to(&app_backend_config_path(app)?, base_url, name, activate)
}

pub fn remove_app_backend_server(app: &AppHandle, base_url: &str) -> Result<()> {
    remove_backend_server_at(&app_backend_config_path(app)?, base_url)
}

/// The notch island's settings (`desktop-island.json`). A missing or
/// unreadable file, or a missing key, takes the default.
fn island_settings_from(bytes: Option<&[u8]>) -> crate::island::IslandSettings {
    bytes
        .and_then(|b| serde_json::from_slice(b).ok())
        .unwrap_or_default()
}

pub fn load_island_settings(app: &AppHandle) -> crate::island::IslandSettings {
    let bytes = app_config_file(app, "desktop-island.json")
        .ok()
        .and_then(|path| std::fs::read(path).ok());
    island_settings_from(bytes.as_deref())
}

pub fn save_island_settings(app: &AppHandle, settings: &crate::island::IslandSettings) -> Result<()> {
    let path = app_config_file(app, "desktop-island.json")?;
    let bytes = serde_json::to_vec_pretty(settings).context("serialize island settings")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn island_settings_default_per_key_and_read_older_files() {
        let defaults = crate::island::IslandSettings::default();
        assert_eq!(island_settings_from(None), defaults);
        assert_eq!(island_settings_from(Some(b"not json")), defaults);
        // The first version stored only the switch.
        let old = island_settings_from(Some(br#"{"enabled": false}"#));
        assert_eq!(old, crate::island::IslandSettings { enabled: false, ..defaults });
        let opted_in = island_settings_from(Some(br#"{"showWhenFrontmost": true}"#));
        assert!(opted_in.enabled && opted_in.show_when_frontmost);
    }

    #[test]
    fn a_normal_window_size_is_remembered() {
        let size = rememberable_size(1600, 1000, false, false).unwrap();
        assert_eq!((size.width, size.height), (1600, 1000));
    }

    #[test]
    fn minimized_maximized_or_tiny_windows_are_not_remembered() {
        assert!(rememberable_size(1600, 1000, true, false).is_none());
        assert!(rememberable_size(1600, 1000, false, true).is_none());
        assert!(rememberable_size(700, 1000, false, false).is_none());
        assert!(rememberable_size(1600, 500, false, false).is_none());
    }
}
