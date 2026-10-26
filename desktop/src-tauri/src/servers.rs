//! Which backend server each app window uses.
//!
//! An app window talks to one server: the external server recorded for it
//! in `AppState::window_backend_base_urls`, or else the builtin sidecar. The
//! notch island, the tray's "Auto" usage, new windows and notification
//! routing all ask this module, so they agree on it.
//!
//! A saved server is a choice in the server lists. Nothing here connects a
//! window to it on its own: a window is on it only after the user pressed
//! Connect in that window (or opened a new window from one that is). The one
//! exception is watching: the island also follows saved servers the user
//! enabled, with or without a window (`followed_servers`).

use std::collections::HashMap;

use tauri::{AppHandle, Manager};

use crate::AppState;

/// The tray's id for the builtin sidecar.
pub const BUNDLED_KEY: &str = "bundled";

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ServerId {
    /// The builtin sidecar, whatever port it runs on now: a restart after a
    /// crash is still the same server.
    Bundled,
    /// An external server, by its normalized base URL.
    External(String),
}

impl ServerId {
    pub fn external(base_url: &str) -> Self {
        let normalized = crate::config::normalize_external_base_url(base_url)
            .unwrap_or_else(|_| base_url.trim().trim_end_matches('/').to_string());
        Self::External(normalized)
    }

    /// The tray's id for it: [`BUNDLED_KEY`], or the base URL.
    pub fn key(&self) -> &str {
        match self {
            Self::Bundled => BUNDLED_KEY,
            Self::External(base) => base,
        }
    }

    /// The name the user saved it under (else its host and port), or
    /// `bundled_name` for the builtin.
    pub fn display_name(&self, bundled_name: &str, saved: &[crate::config::SavedAppServer]) -> String {
        match self {
            Self::Bundled => bundled_name.to_string(),
            Self::External(base) => crate::usage::resolve_server_display_name(base, saved),
        }
    }
}

/// The server an app window uses.
pub fn window_server(label: &str, external: &HashMap<String, String>) -> ServerId {
    external.get(label).map_or(ServerId::Bundled, |base| ServerId::external(base))
}

/// The server the app is on now: the active window's, else the builtin
/// while it runs. `None`: not connected. New windows open on it, and the
/// tray's "Auto" reads its usage.
pub fn current_server(
    active_window: Option<&str>,
    external: &HashMap<String, String>,
    bundled_running: bool,
) -> Option<ServerId> {
    match active_window {
        Some(label) => Some(window_server(label, external)),
        None => bundled_running.then_some(ServerId::Bundled),
    }
}

/// The servers the island follows: every app window's, plus every saved
/// server marked enabled, each once (the builtin only while it runs). With
/// no window open, the builtin while it runs: that is where a click would
/// open a window. A disabled saved server is followed only while a window
/// is on it.
pub fn followed_servers(
    app_windows: &[String],
    external: &HashMap<String, String>,
    bundled_running: bool,
    enabled: &[ServerId],
) -> Vec<ServerId> {
    let mut servers: Vec<ServerId> = app_windows
        .iter()
        .map(|label| window_server(label, external))
        .filter(|server| *server != ServerId::Bundled || bundled_running)
        .collect();
    if app_windows.is_empty() && bundled_running {
        servers.push(ServerId::Bundled);
    }
    servers.extend(enabled.iter().filter(|server| **server != ServerId::Bundled).cloned());
    servers.sort();
    servers.dedup();
    servers
}

/// The saved servers marked enabled, as server ids.
pub fn enabled_servers(saved: &[crate::config::SavedAppServer]) -> Vec<ServerId> {
    saved.iter().filter(|s| s.enabled).map(|s| ServerId::external(&s.base_url)).collect()
}

/// The window to open a session of `server` in: the focused window, then
/// the active one, then any other on that server.
pub fn window_for_server(
    server: &ServerId,
    focused: Option<&str>,
    active: Option<&str>,
    app_windows: &[String],
    external: &HashMap<String, String>,
) -> Option<String> {
    let on_server = |label: &&str| window_server(label, external) == *server;
    focused
        .into_iter()
        .chain(active)
        .chain(app_windows.iter().map(String::as_str))
        .filter(|label| app_windows.iter().any(|w| w.as_str() == *label))
        .find(on_server)
        .map(str::to_string)
}

/// Whether the focused app window stands in for `caller`'s notification:
/// it is another window on the same server, so it got the same event and
/// knows whether its session is on screen. A window on another server never
/// sees the event, so it must not silence it.
pub fn focused_window_covers(caller: &str, focused: Option<&str>, external: &HashMap<String, String>) -> bool {
    focused.is_some_and(|label| label != caller && window_server(label, external) == window_server(caller, external))
}

// ── App state ───────────────────────────────────────────────────────────────

/// Labels of the open app windows (not the tray popup or the island), sorted.
pub fn app_window_labels(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| !crate::window::is_overlay_window(label))
        .collect();
    labels.sort();
    labels
}

pub fn external_map(app: &AppHandle) -> HashMap<String, String> {
    let state: tauri::State<'_, AppState> = app.state();
    let map = state.window_backend_base_urls.lock().unwrap().clone();
    map
}

/// The active app window, if it is still open.
pub fn active_app_window(app: &AppHandle) -> Option<String> {
    let state: tauri::State<'_, AppState> = app.state();
    let label = state.active_window_label.lock().unwrap().clone();
    app.get_webview_window(&label)
        .filter(|window| !crate::window::is_overlay_window(window.label()))
        .map(|_| label)
}

/// The focused app window, if one is.
pub fn focused_app_window(app: &AppHandle) -> Option<String> {
    crate::window::focused_webview_window(app)
        .map(|window| window.label().to_string())
        .filter(|label| !crate::window::is_overlay_window(label))
}

/// The builtin sidecar is up. `backend_base_url` outlives a Stop, so it is
/// not the test.
pub async fn bundled_running(app: &AppHandle) -> bool {
    let state: tauri::State<'_, AppState> = app.state();
    let mut sidecar = state.sidecar.lock().await;
    sidecar.as_mut().is_some_and(|s| s.is_alive())
}

/// [`current_server`] for the running app.
pub async fn app_current_server(app: &AppHandle) -> Option<ServerId> {
    let running = bundled_running(app).await;
    current_server(active_app_window(app).as_deref(), &external_map(app), running)
}

/// [`followed_servers`] for the running app, with `enabled` saved servers.
pub async fn app_followed_servers(app: &AppHandle, enabled: &[ServerId]) -> Vec<ServerId> {
    let running = bundled_running(app).await;
    followed_servers(&app_window_labels(app), &external_map(app), running, enabled)
}

/// Base URL and bearer token for `server`: the builtin's desktop token, or
/// the access key saved for an external server. `None` while the builtin
/// is not running.
pub async fn endpoint(app: &AppHandle, server: &ServerId) -> Option<(String, Option<String>)> {
    match server {
        ServerId::Bundled => {
            if !bundled_running(app).await {
                return None;
            }
            let state: tauri::State<'_, AppState> = app.state();
            let base = state.backend_base_url.lock().await.clone()?;
            let token = state.desktop_token.lock().await.clone();
            Some((base, token))
        }
        ServerId::External(base) => {
            let key = crate::menu::external_usage_access_key(
                crate::commands::secure_get_access_key(base.clone()).await,
            );
            Some((base.clone(), key))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REMOTE: &str = "http://192.168.1.30:4082";
    const LAB: &str = "http://192.168.1.20:4082";

    fn labels(list: &[&str]) -> Vec<String> {
        list.iter().map(|l| l.to_string()).collect()
    }

    fn external(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(label, base)| (label.to_string(), base.to_string())).collect()
    }

    #[test]
    fn a_window_without_an_external_server_uses_the_builtin() {
        let map = external(&[("main", REMOTE)]);
        assert_eq!(window_server("main", &map), ServerId::External(REMOTE.into()));
        assert_eq!(window_server("main-2", &map), ServerId::Bundled);
    }

    #[test]
    fn external_servers_compare_by_their_normalized_url() {
        assert_eq!(ServerId::external("http://192.168.1.30:4082/api/"), ServerId::External(REMOTE.into()));
        assert_eq!(ServerId::external(REMOTE).key(), REMOTE);
        assert_eq!(ServerId::Bundled.key(), BUNDLED_KEY);
    }

    // `main` on another server (or a saved default) used to win over the
    // window actually in use.
    #[test]
    fn a_builtin_window_uses_builtin_even_when_main_is_on_another_server() {
        let map = external(&[("main", REMOTE)]);
        assert_eq!(current_server(Some("main-2"), &map, true), Some(ServerId::Bundled));
    }

    #[test]
    fn an_external_window_uses_its_own_server() {
        let map = external(&[("main-2", LAB)]);
        assert_eq!(current_server(Some("main-2"), &map, true), Some(ServerId::External(LAB.into())));
    }

    #[test]
    fn with_no_window_open_the_app_is_on_the_builtin_or_on_nothing() {
        let map = HashMap::new();
        assert_eq!(current_server(None, &map, true), Some(ServerId::Bundled));
        assert_eq!(current_server(None, &map, false), None, "a saved server is never picked");
    }

    #[test]
    fn windows_on_two_servers_are_each_followed_once() {
        let map = external(&[("main-2", REMOTE), ("main-3", REMOTE)]);
        let followed = followed_servers(&labels(&["main", "main-2", "main-3"]), &map, true, &[]);
        assert_eq!(followed, [ServerId::Bundled, ServerId::External(REMOTE.into())]);
    }

    #[test]
    fn a_stopped_builtin_is_not_followed() {
        let map = external(&[("main-2", REMOTE)]);
        let followed = followed_servers(&labels(&["main", "main-2"]), &map, false, &[]);
        assert_eq!(followed, [ServerId::External(REMOTE.into())]);
        assert!(followed_servers(&[], &map, false, &[]).is_empty(), "no window, no builtin: nothing");
        assert_eq!(followed_servers(&[], &map, true, &[]), [ServerId::Bundled]);
    }

    #[test]
    fn an_enabled_saved_server_is_followed_with_no_window_open() {
        let lab = ServerId::External(LAB.into());
        let enabled = std::slice::from_ref(&lab);
        assert_eq!(followed_servers(&[], &HashMap::new(), false, enabled), std::slice::from_ref(&lab));
        assert_eq!(followed_servers(&[], &HashMap::new(), true, enabled), [ServerId::Bundled, lab.clone()]);
    }

    #[test]
    fn an_enabled_server_with_a_window_on_it_is_followed_once() {
        let map = external(&[("main-2", REMOTE)]);
        let remote = ServerId::External(REMOTE.into());
        let followed = followed_servers(&labels(&["main", "main-2"]), &map, true, std::slice::from_ref(&remote));
        assert_eq!(followed, [ServerId::Bundled, remote.clone()]);
    }

    #[test]
    fn a_disabled_server_is_followed_only_while_a_window_is_on_it() {
        let saved = |enabled| vec![crate::config::SavedAppServer { base_url: REMOTE.into(), name: None, enabled }];
        assert!(enabled_servers(&saved(false)).is_empty());
        assert_eq!(enabled_servers(&saved(true)), [ServerId::External(REMOTE.into())]);
        let map = external(&[("main-2", REMOTE)]);
        let with_window = followed_servers(&labels(&["main", "main-2"]), &map, true, &enabled_servers(&saved(false)));
        assert!(with_window.contains(&ServerId::External(REMOTE.into())));
        let closed = followed_servers(&labels(&["main"]), &HashMap::new(), true, &enabled_servers(&saved(false)));
        assert_eq!(closed, [ServerId::Bundled]);
    }

    #[test]
    fn a_session_opens_in_a_window_on_its_server() {
        let map = external(&[("main-2", REMOTE)]);
        let windows = labels(&["main", "main-2", "main-3"]);
        let remote = ServerId::External(REMOTE.into());
        // Focused on a builtin window: a remote session still opens on its server.
        assert_eq!(window_for_server(&remote, Some("main"), Some("main"), &windows, &map).as_deref(), Some("main-2"));
        // The focused window wins when it is on the right server, then the active one.
        assert_eq!(window_for_server(&ServerId::Bundled, Some("main-3"), Some("main"), &windows, &map).as_deref(), Some("main-3"));
        assert_eq!(window_for_server(&ServerId::Bundled, None, Some("main-3"), &windows, &map).as_deref(), Some("main-3"));
        assert_eq!(window_for_server(&ServerId::External(LAB.into()), None, None, &windows, &map), None);
    }

    #[test]
    fn a_closed_window_is_never_picked() {
        let map = HashMap::new();
        let windows = labels(&["main-2"]);
        assert_eq!(window_for_server(&ServerId::Bundled, None, Some("main"), &windows, &map).as_deref(), Some("main-2"));
    }

    #[test]
    fn a_focused_window_on_another_server_does_not_suppress_a_notification() {
        let map = external(&[("main-2", REMOTE)]);
        assert!(!focused_window_covers("main-2", Some("main"), &map), "main never sees the remote server's events");
        assert!(focused_window_covers("main-3", Some("main"), &map), "both on the builtin");
        assert!(!focused_window_covers("main", Some("main"), &map), "the caller itself decides");
        assert!(!focused_window_covers("main", None, &map));
    }
}
