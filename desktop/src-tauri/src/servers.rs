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
//!
//! One computer can be reached at two addresses (saved twice, or saved and
//! opened through the account). The island follows it once: a server that
//! answers with the account fingerprint of one already followed is dropped
//! (`followed_servers`, from what `learn_identity` heard).

use std::collections::HashMap;
use std::sync::{Mutex as StdMutex, OnceLock};

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
    /// `bundled_name` for the builtin. A computer opened through the account
    /// is named as its row under "Your computers" is.
    pub fn display_name(&self, bundled_name: &str, saved: &[crate::config::SavedAppServer]) -> String {
        match self {
            Self::Bundled => bundled_name.to_string(),
            Self::External(base) if crate::account::account_device(base).is_some() => {
                crate::account::account_device(base).map(|d| d.label()).unwrap_or_default()
            }
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

/// The servers the island follows: the builtin whenever it runs, every app
/// window's server, and every saved server marked enabled, each once. The
/// builtin is local and always reachable, so its sessions show whatever
/// windows are open (none, or only windows on an external server). A
/// disabled saved server is followed only while a window is on it.
///
/// Each computer once, too: `identity` gives the account fingerprint a
/// server answered with (when known); a second server with the same one is
/// left out, keeping the builtin, then a window's server, then an enabled
/// one, so a session opens in the window that shows its computer.
pub fn followed_servers(
    app_windows: &[String],
    external: &HashMap<String, String>,
    bundled_running: bool,
    enabled: &[ServerId],
    identity: &HashMap<ServerId, String>,
) -> Vec<ServerId> {
    let mut windows: Vec<ServerId> = app_windows
        .iter()
        .map(|label| window_server(label, external))
        .filter(|server| *server != ServerId::Bundled)
        .collect();
    windows.sort();
    let mut enabled: Vec<ServerId> = enabled.iter().filter(|server| **server != ServerId::Bundled).cloned().collect();
    enabled.sort();
    // In order of preference.
    let candidates = bundled_running.then_some(ServerId::Bundled).into_iter().chain(windows).chain(enabled);
    let mut servers: Vec<ServerId> = Vec::new();
    let mut computers: Vec<&String> = Vec::new();
    for server in candidates {
        if servers.contains(&server) {
            continue;
        }
        if let Some(computer) = identity.get(&server) {
            if computers.contains(&computer) {
                continue;
            }
            computers.push(computer);
        }
        servers.push(server);
    }
    servers.sort();
    servers
}

/// Account fingerprints servers answered with, normalized (`3F9A21C4`).
fn identities() -> &'static StdMutex<HashMap<ServerId, String>> {
    static IDS: OnceLock<StdMutex<HashMap<ServerId, String>>> = OnceLock::new();
    IDS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// What `server` answered when the island connected: the account
/// fingerprint of its computer, or `None` (not signed in, an older server).
pub fn learn_identity(server: &ServerId, fingerprint: Option<String>) {
    let mut ids = identities().lock().unwrap();
    match fingerprint.map(|f| normalize_fingerprint(&f)).filter(|f| !f.is_empty()) {
        Some(f) => ids.insert(server.clone(), f),
        None => ids.remove(server),
    };
}

/// `3f9a 21c4` and `3F9A-21C4` are the same fingerprint.
pub fn normalize_fingerprint(fingerprint: &str) -> String {
    fingerprint.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase()
}

/// The known computer of each server: what each answered, and the computer
/// behind each account bridge.
fn known_identities() -> HashMap<ServerId, String> {
    let mut ids = identities().lock().unwrap().clone();
    for (origin, device) in crate::account::bridged_devices() {
        ids.insert(ServerId::external(&origin), normalize_fingerprint(&device.fingerprint));
    }
    ids
}

/// The account fingerprint a server's computer is signed in with, from its
/// `GET /api/cloud/status`. `None` when it is not signed in or does not say.
pub async fn server_fingerprint(client: &reqwest::Client, base: &str, token: Option<&str>) -> Option<String> {
    let mut request = client.get(format!("{}/api/cloud/status", base.trim_end_matches('/'))).timeout(std::time::Duration::from_secs(5));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let body: serde_json::Value = request.send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
    let enrolled = matches!(body["state"].as_str(), Some("connected" | "closing" | "unavailable"));
    enrolled.then(|| body["fingerprint"].as_str().map(str::to_string)).flatten()
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

/// The open app window that shows the session `key` (an [`island::id_key`]),
/// from what every window reported (`viewing`): the focused one if it is
/// among them, else the first by label. Any server: a session id is a UUID,
/// and one machine's server reached by two URLs is one server to the user.
///
/// [`island::id_key`]: crate::island::id_key
pub fn window_showing_session(
    key: &str,
    viewing: &HashMap<String, String>,
    focused: Option<&str>,
    app_windows: &[String],
) -> Option<String> {
    let shows = |label: &&str| viewing.get(*label).is_some_and(|shown| shown == key);
    focused
        .into_iter()
        .chain(app_windows.iter().map(String::as_str))
        .filter(|label| app_windows.iter().any(|w| w.as_str() == *label))
        .find(shows)
        .map(str::to_string)
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
    let running = state.sidecar.alive().await;
    running
}

/// [`current_server`] for the running app.
pub async fn app_current_server(app: &AppHandle) -> Option<ServerId> {
    let running = bundled_running(app).await;
    current_server(active_app_window(app).as_deref(), &external_map(app), running)
}

/// [`followed_servers`] for the running app, with `enabled` saved servers.
pub async fn app_followed_servers(app: &AppHandle, enabled: &[ServerId]) -> Vec<ServerId> {
    let running = bundled_running(app).await;
    followed_servers(&app_window_labels(app), &external_map(app), running, enabled, &known_identities())
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

    fn follow(windows: &[String], map: &HashMap<String, String>, running: bool, enabled: &[ServerId]) -> Vec<ServerId> {
        followed_servers(windows, map, running, enabled, &HashMap::new())
    }

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
        let followed = follow(&labels(&["main", "main-2", "main-3"]), &map, true, &[]);
        assert_eq!(followed, [ServerId::Bundled, ServerId::External(REMOTE.into())]);
    }

    #[test]
    fn a_stopped_builtin_is_not_followed() {
        let map = external(&[("main-2", REMOTE)]);
        let followed = follow(&labels(&["main", "main-2"]), &map, false, &[]);
        assert_eq!(followed, [ServerId::External(REMOTE.into())]);
        assert!(follow(&[], &map, false, &[]).is_empty(), "no window, no builtin: nothing");
        assert_eq!(follow(&[], &map, true, &[]), [ServerId::Bundled]);
    }

    #[test]
    fn the_builtin_is_followed_while_it_runs_with_only_external_windows_open() {
        let map = external(&[("main-2", REMOTE)]);
        let remote = ServerId::External(REMOTE.into());
        let followed = follow(&labels(&["main-2"]), &map, true, &[]);
        assert_eq!(followed, [ServerId::Bundled, remote.clone()]);
        let enabled = std::slice::from_ref(&remote);
        assert_eq!(follow(&labels(&["main-2"]), &map, true, enabled), [ServerId::Bundled, remote.clone()]);
        assert_eq!(follow(&labels(&["main-2"]), &map, false, enabled), [remote]);
    }

    #[test]
    fn an_enabled_saved_server_is_followed_with_no_window_open() {
        let lab = ServerId::External(LAB.into());
        let enabled = std::slice::from_ref(&lab);
        assert_eq!(follow(&[], &HashMap::new(), false, enabled), std::slice::from_ref(&lab));
        assert_eq!(follow(&[], &HashMap::new(), true, enabled), [ServerId::Bundled, lab.clone()]);
    }

    #[test]
    fn an_enabled_server_with_a_window_on_it_is_followed_once() {
        let map = external(&[("main-2", REMOTE)]);
        let remote = ServerId::External(REMOTE.into());
        let followed = follow(&labels(&["main", "main-2"]), &map, true, std::slice::from_ref(&remote));
        assert_eq!(followed, [ServerId::Bundled, remote.clone()]);
    }

    #[test]
    fn a_disabled_server_is_followed_only_while_a_window_is_on_it() {
        let saved = |enabled| vec![crate::config::SavedAppServer { base_url: REMOTE.into(), name: None, enabled }];
        assert!(enabled_servers(&saved(false)).is_empty());
        assert_eq!(enabled_servers(&saved(true)), [ServerId::External(REMOTE.into())]);
        let map = external(&[("main-2", REMOTE)]);
        let with_window = follow(&labels(&["main", "main-2"]), &map, true, &enabled_servers(&saved(false)));
        assert!(with_window.contains(&ServerId::External(REMOTE.into())));
        let closed = follow(&labels(&["main"]), &HashMap::new(), true, &enabled_servers(&saved(false)));
        assert_eq!(closed, [ServerId::Bundled]);
    }

    // home-away item 14: one machine saved under two addresses showed its
    // sessions twice in the notch.
    #[test]
    fn one_computer_at_two_addresses_is_followed_once() {
        let lab = ServerId::External(LAB.into());
        let remote = ServerId::External(REMOTE.into());
        let same: HashMap<ServerId, String> = [(lab.clone(), "3F9A21C4".to_string()), (remote.clone(), "3F9A21C4".to_string())].into();
        let both = [lab.clone(), remote.clone()];
        // Both enabled: one is kept.
        assert_eq!(followed_servers(&[], &HashMap::new(), false, &both, &same).len(), 1);
        // A window on one of them: that one is kept.
        let map = external(&[("main-2", REMOTE)]);
        assert_eq!(followed_servers(&labels(&["main-2"]), &map, false, &both, &same), std::slice::from_ref(&remote));
        // The builtin is this computer: a saved address of it is not followed again.
        let me: HashMap<ServerId, String> = [(ServerId::Bundled, "AAAA".to_string()), (lab.clone(), "AAAA".to_string())].into();
        assert_eq!(followed_servers(&[], &HashMap::new(), true, std::slice::from_ref(&lab), &me), [ServerId::Bundled]);
        // Different computers, or one not known yet: each is followed.
        let apart: HashMap<ServerId, String> = [(lab.clone(), "AAAA".to_string()), (remote.clone(), "BBBB".to_string())].into();
        assert_eq!(followed_servers(&[], &HashMap::new(), false, &both, &apart), both);
        let one: HashMap<ServerId, String> = [(lab.clone(), "AAAA".to_string())].into();
        assert_eq!(followed_servers(&[], &HashMap::new(), false, &both, &one), both);
    }

    #[test]
    fn fingerprints_compare_without_spaces_dashes_or_case() {
        assert_eq!(normalize_fingerprint("3f9a 21c4"), normalize_fingerprint("3F9A-21C4"));
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

    fn viewing(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(label, key)| (label.to_string(), key.to_string())).collect()
    }

    // One session lives in one window: every way to open it asks first which
    // window already shows it.
    #[test]
    fn the_window_that_shows_a_session_is_found_among_the_open_ones() {
        let windows = labels(&["main", "main-2", "main-3"]);
        let shown = viewing(&[("main", "aa"), ("main-2", "bb"), ("main-3", "bb")]);
        assert_eq!(window_showing_session("aa", &shown, None, &windows).as_deref(), Some("main"));
        assert_eq!(window_showing_session("bb", &shown, None, &windows).as_deref(), Some("main-2"), "first by label");
        assert_eq!(window_showing_session("bb", &shown, Some("main-3"), &windows).as_deref(), Some("main-3"), "the focused one wins a tie");
        assert_eq!(window_showing_session("cc", &shown, None, &windows), None);
    }

    #[test]
    fn a_window_that_closed_or_shows_nothing_never_counts() {
        let windows = labels(&["main"]);
        let shown = viewing(&[("main-2", "bb")]);
        assert_eq!(window_showing_session("bb", &shown, Some("main-2"), &windows), None, "closed, though it still reports");
        assert_eq!(window_showing_session("bb", &viewing(&[]), None, &windows), None);
    }
}
