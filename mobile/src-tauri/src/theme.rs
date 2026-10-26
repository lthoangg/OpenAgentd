//! The app's theme pick on native surfaces.
//!
//! The web UI keeps the light / dark / system preference in its own storage
//! and reports it with `set_app_theme` whenever it loads or changes. The
//! shell then makes the native surfaces match the page instead of the system
//! appearance: the status bar (and on iOS the keyboard and system sheets),
//! and the webview background painted before the page.
//!
//! iOS stores the pick here so the next launch paints the right background;
//! Android stores it in the Kotlin `ShellPlugin`, which paints the webview
//! before Rust gets a say.

use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

/// `Some(true)` for dark, `Some(false)` for light, `None` to follow the
/// system.
pub type ThemePick = Option<bool>;

pub fn parse_preference(preference: &str) -> Result<ThemePick, String> {
    match preference {
        "dark" => Ok(Some(true)),
        "light" => Ok(Some(false)),
        "system" => Ok(None),
        other => Err(format!("unknown theme preference: {other}")),
    }
}

fn pick_from(bytes: Option<&[u8]>) -> ThemePick {
    match bytes.and_then(|b| std::str::from_utf8(b).ok()).map(str::trim) {
        Some("dark") => Some(true),
        Some("light") => Some(false),
        _ => None,
    }
}

fn pick_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("resolve app config directory")?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir.join("app-theme"))
}

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn saved_pick(app: &AppHandle) -> ThemePick {
    let bytes = pick_path(app).ok().and_then(|path| std::fs::read(path).ok());
    pick_from(bytes.as_deref())
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn save_pick(app: &AppHandle, pick: ThemePick) -> Result<()> {
    let path = pick_path(app)?;
    match pick {
        Some(dark) => std::fs::write(&path, if dark { "dark" } else { "light" })
            .with_context(|| format!("write {}", path.display())),
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(e).with_context(|| format!("remove {}", path.display()))
            }
            _ => Ok(()),
        },
    }
}

#[tauri::command]
pub async fn set_app_theme(app: AppHandle, preference: String) -> Result<(), String> {
    let pick = parse_preference(&preference)?;
    #[cfg(target_os = "android")]
    {
        let _ = pick;
        use tauri_plugin_openagentd_android::AndroidShellExt;
        tauri::async_runtime::spawn_blocking(move || app.android_shell().set_app_theme(&preference))
            .await
            .map_err(|e| format!("Theme task failed: {e}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let saving = app.clone();
        tauri::async_runtime::spawn_blocking(move || save_pick(&saving, pick))
            .await
            .map_err(|e| format!("Theme task failed: {e}"))?
            .map_err(|e| format!("{e:#}"))?;
        #[cfg(target_os = "ios")]
        ios::apply(&app, pick);
        Ok(())
    }
}

/// Paint the webview for the saved pick, or the system appearance, before
/// the page does. The config's `backgroundColor` is light only.
#[cfg(target_os = "ios")]
pub fn paint_launch_background(app: &AppHandle) {
    let dark = saved_pick(app).unwrap_or_else(ios::system_is_dark);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_background_color(Some(paper(dark)));
    }
}

/// The boot page's paper tone (`web/index.html`).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn paper(dark: bool) -> tauri::window::Color {
    if dark {
        tauri::window::Color(0x15, 0x11, 0x0d, 0xff)
    } else {
        tauri::window::Color(0xfa, 0xf6, 0xec, 0xff)
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use objc2::MainThreadMarker;
    use objc2_ui_kit::{UIApplication, UITraitCollection, UIUserInterfaceStyle, UIWindowScene};
    use tauri::{AppHandle, Manager};

    use super::{paper, ThemePick};

    /// The system appearance. Call on the main thread.
    pub fn system_is_dark() -> bool {
        // SAFETY: reads UIKit state; the caller is on the main thread.
        unsafe { UITraitCollection::currentTraitCollection().userInterfaceStyle() == UIUserInterfaceStyle::Dark }
    }

    /// Pin every window's appearance to the pick (unpin for the system).
    /// The status bar, keyboard, and system sheets follow the window.
    pub fn apply(app: &AppHandle, pick: ThemePick) {
        let app = app.clone();
        dispatch2::DispatchQueue::main().exec_async(move || {
            let Some(mtm) = MainThreadMarker::new() else { return };
            let style = match pick {
                Some(true) => UIUserInterfaceStyle::Dark,
                Some(false) => UIUserInterfaceStyle::Light,
                None => UIUserInterfaceStyle::Unspecified,
            };
            for scene in UIApplication::sharedApplication(mtm).connectedScenes().iter() {
                if let Ok(scene) = scene.downcast::<UIWindowScene>() {
                    for window in scene.windows().iter() {
                        window.setOverrideUserInterfaceStyle(style);
                    }
                }
            }
            let dark = pick.unwrap_or_else(system_is_dark);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(paper(dark)));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_preference, pick_from};

    #[test]
    fn preferences_map_to_a_pick_or_the_system() {
        assert_eq!(parse_preference("dark"), Ok(Some(true)));
        assert_eq!(parse_preference("light"), Ok(Some(false)));
        assert_eq!(parse_preference("system"), Ok(None));
        assert!(parse_preference("sepia").is_err());
    }

    #[test]
    fn a_missing_or_unknown_saved_pick_follows_the_system() {
        assert_eq!(pick_from(Some(b"dark\n")), Some(true));
        assert_eq!(pick_from(Some(b"light")), Some(false));
        assert_eq!(pick_from(Some(b"sepia")), None);
        assert_eq!(pick_from(None), None);
    }
}
