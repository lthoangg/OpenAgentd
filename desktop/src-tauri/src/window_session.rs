//! The windows that were open, so the next launch opens them again
//! (`desktop-windows.json`): each window's label, frame, the computer it was
//! on and the session it showed.
//!
//! Written wherever the app is about to go away (quit, restart, an update,
//! the last window closing) and when a window is closed by hand, which takes
//! it off the list. A save with no window open keeps the file as it is: on
//! macOS the app outlives its windows, and "what was open last" is the
//! window closed last.
//!
//! A launch restores every window on the computer it was on: the built-in
//! server, a saved server, or a computer of the account (through its bridge,
//! opened again first). A computer that cannot be opened again does not lose
//! its window: the window opens on this computer instead. A launch at login
//! opens none; they come back the first time the app is asked for a window.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::config::SavedWindowState;
use crate::servers::ServerId;
use crate::window::{MAIN_WINDOW, SECONDARY_WINDOW_PREFIX};

const FILE: &str = "desktop-windows.json";
const VERSION: u32 = 1;
/// More windows than anyone keeps open: a damaged file must not open hundreds.
const MAX_WINDOWS: usize = 16;

/// The computer a window was on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SavedServer {
    /// The built-in server.
    Builtin,
    /// A server saved by address.
    Saved { base_url: String },
    /// A computer of the account, reached through a bridge of the built-in server.
    Account { device_id: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedWindow {
    pub label: String,
    /// None for a window that was minimized or maximized: it opens at the default size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<SavedWindowState>,
    pub server: SavedServer,
    /// The session it showed; none for a window on no session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl SavedWindow {
    /// The page the window opens on: its session, else the start page.
    pub fn path(&self) -> String {
        self.session_id.as_deref().map_or_else(|| "/".to_string(), |id| format!("/{id}"))
    }
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    windows: Vec<SavedWindow>,
}

/// A label this app gives its windows: `main`, or `main-<n>`.
fn is_app_window_label(label: &str) -> bool {
    label == MAIN_WINDOW
        || label
            .strip_prefix(SECONDARY_WINDOW_PREFIX)
            .is_some_and(|n| !n.is_empty() && n.len() <= 6 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// A session id as the server makes them, and nothing that could be read as
/// another route (`settings`, `a/b`, a query).
pub fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// The windows in `bytes`, in the order they were saved (the active one
/// last). A missing, unreadable or newer file is no windows; an entry this
/// app could not have written is dropped (or loses the part that is wrong),
/// never trusted.
pub fn windows_from(bytes: Option<&[u8]>) -> Vec<SavedWindow> {
    let Some(file) = bytes.and_then(|b| serde_json::from_slice::<File>(b).ok()) else {
        return Vec::new();
    };
    if file.version != VERSION {
        return Vec::new();
    }
    let mut seen = std::collections::HashSet::new();
    file.windows
        .into_iter()
        .filter(|w| is_app_window_label(&w.label) && seen.insert(w.label.clone()))
        .take(MAX_WINDOWS)
        .map(|mut w| {
            w.session_id = w.session_id.filter(|id| valid_session_id(id));
            w.frame = w.frame.filter(|f| f.width >= 760 && f.height >= 560);
            w
        })
        .collect()
}

fn bytes_of(windows: &[SavedWindow]) -> Vec<u8> {
    serde_json::to_vec_pretty(&File { version: VERSION, windows: windows.to_vec() }).unwrap_or_default()
}

/// What a window on `base` (none: the built-in server) is saved as.
/// `bridge_device` names the account computer behind a bridge's address.
pub fn saved_server(base: Option<&str>, bridge_device: impl Fn(&str) -> Option<String>) -> SavedServer {
    match base {
        None => SavedServer::Builtin,
        Some(base) => match bridge_device(base) {
            Some(device_id) => SavedServer::Account { device_id },
            None => SavedServer::Saved { base_url: base.to_string() },
        },
    }
}

/// `windows` with the active one last, so it is built last and ends in front.
pub fn active_last(mut windows: Vec<SavedWindow>, active: &str) -> Vec<SavedWindow> {
    windows.sort_by_key(|w| w.label == active);
    windows
}

/// The session each window shows, as the page reported it (`island_viewing`).
fn shown() -> &'static Mutex<HashMap<String, String>> {
    static SHOWN: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    SHOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A window reports the session it shows (none: no session).
pub fn note_session(label: &str, session_id: Option<&str>) {
    let mut shown = shown().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match session_id.filter(|id| valid_session_id(id)) {
        Some(id) => shown.insert(label.to_string(), id.to_string()),
        None => shown.remove(label),
    };
}

/// A closed window shows nothing; its label may be reused.
pub fn forget_window(label: &str) {
    shown().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(label);
}

/// `label` came back on the session it was saved with. Its page reports
/// only once it has loaded and reached its server, and a save before that
/// (a quick quit, a computer that is off) must not lose the session.
pub fn came_back(windows: &[SavedWindow], label: &str) {
    if let Some(window) = windows.iter().find(|w| w.label == label) {
        note_session(label, window.session_id.as_deref());
    }
}

/// The app windows open now.
fn open_windows(app: &AppHandle) -> Vec<SavedWindow> {
    let state: tauri::State<'_, crate::AppState> = app.state();
    let external = state.window_backend_base_urls.lock().unwrap().clone();
    let active = state.active_window_label.lock().unwrap().clone();
    let shown = shown().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let mut windows: Vec<SavedWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| is_app_window_label(label))
        .map(|(label, window)| SavedWindow {
            frame: crate::config::window_size(&window),
            server: saved_server(external.get(&label).map(String::as_str), |base| {
                crate::account::account_device(base).map(|device| device.device_id)
            }),
            session_id: shown.get(&label).cloned(),
            label,
        })
        .collect();
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    active_last(windows, &active)
}

/// Write `windows` as the list to come back to. With none the file stays as
/// it is, and so it does while the last run's windows are still due
/// ([`restore_later`]): the windows open now are not all of them.
fn write(app: &AppHandle, windows: &[SavedWindow]) {
    if windows.is_empty() || PENDING.load(Ordering::SeqCst) {
        return;
    }
    let written = crate::config::app_config_file(app, FILE).and_then(|path| Ok(std::fs::write(path, bytes_of(windows))?));
    match written {
        Ok(()) => log::info!("windows: saved count={}", windows.len()),
        Err(e) => log::warn!("windows: could not save the open windows: {e:#}"),
    }
}

/// Save the windows open now.
pub fn save(app: &AppHandle) {
    write(app, &open_windows(app));
}

/// `windows` once `closing` is closed by hand: without it, unless it is the
/// only one, which is what the next launch opens.
pub fn after_close(windows: Vec<SavedWindow>, closing: &str) -> Vec<SavedWindow> {
    if windows.iter().all(|w| w.label == closing) {
        return windows;
    }
    windows.into_iter().filter(|w| w.label != closing).collect()
}

/// The window `label` is about to be closed by hand. Call it while the
/// window and its server entry still exist.
pub fn window_closing(app: &AppHandle, label: &str) {
    write(app, &after_close(open_windows(app), label));
    forget_window(label);
}

/// The windows saved by the last run, the one that was active last.
pub fn load(app: &AppHandle) -> Vec<SavedWindow> {
    let bytes = crate::config::app_config_file(app, FILE).ok().and_then(|path| std::fs::read(path).ok());
    windows_from(bytes.as_deref())
}

/// The main window a launch builds while the built-in server starts: its
/// page and frame. With nothing saved that is the start page; with a saved
/// main window on the built-in server, where it was. None when the saved
/// windows have no main window or it was on another computer: every window
/// then waits for [`restore`].
pub fn first_window(windows: &[SavedWindow]) -> Option<(String, Option<SavedWindowState>)> {
    if windows.is_empty() {
        return Some(("/".to_string(), None));
    }
    windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW && w.server == SavedServer::Builtin)
        .map(|w| (w.path(), w.frame))
}

/// Where a saved window opens.
#[derive(Debug, PartialEq, Eq)]
pub struct Placement {
    pub server: ServerId,
    pub path: String,
}

/// Where `window` opens: on its own computer and session when that computer
/// can still be opened, else on this one's start page (its session is the
/// other computer's). `saved_servers` are the addresses in the server list;
/// `bridge` is the account bridge opened for it, when it was on an account
/// computer (the error when that computer could not be opened).
pub fn placement(window: &SavedWindow, saved_servers: &[String], bridge: Option<Result<String, String>>) -> Placement {
    let here = || Placement { server: ServerId::Bundled, path: "/".to_string() };
    match (&window.server, bridge) {
        (SavedServer::Builtin, _) => Placement { server: ServerId::Bundled, path: window.path() },
        (SavedServer::Saved { base_url }, _) if saved_servers.contains(base_url) => {
            Placement { server: ServerId::External(base_url.clone()), path: window.path() }
        }
        // Removed from the server list since: nothing vouches for the address.
        (SavedServer::Saved { .. }, _) => here(),
        (SavedServer::Account { .. }, Some(Ok(origin))) => Placement { server: ServerId::External(origin), path: window.path() },
        (SavedServer::Account { .. }, _) => here(),
    }
}

/// A launch at login opened no window: the saved ones are still to come,
/// the first time the app is asked for one.
static PENDING: AtomicBool = AtomicBool::new(false);

pub fn restore_later() {
    PENDING.store(true, Ordering::SeqCst);
}

/// Open the saved windows now if a launch at login left them for later, and
/// say whether that opened any. False when there is nothing to do here: the
/// caller opens a window its own way. The built-in server must be up first
/// (its windows need its address, and account bridges are its); until then
/// the windows stay due.
pub async fn restore_if_pending(app: &AppHandle) -> bool {
    static RESTORING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    if !PENDING.load(Ordering::SeqCst) {
        return false;
    }
    // Two asks at once (the Dock and a notification): one opens them, the
    // other waits for it instead of opening a window of its own.
    let _one = RESTORING.lock().await;
    let open = |app: &AppHandle| app.webview_windows().keys().any(|label| is_app_window_label(label));
    if !PENDING.load(Ordering::SeqCst) {
        return open(app);
    }
    if !crate::servers::bundled_running(app).await {
        return false;
    }
    PENDING.store(false, Ordering::SeqCst);
    let windows = load(app);
    restore(app, &windows).await;
    open(app)
}

/// Open every window of `windows` that is not open yet, each where it was,
/// and bring the one that was active to the front. Call it once the
/// built-in server has started or failed to.
pub async fn restore(app: &AppHandle, windows: &[SavedWindow]) {
    let saved_servers: Vec<String> = crate::config::load_app_backend_config(app)
        .map(|config| config.servers.into_iter().map(|server| server.base_url).collect())
        .unwrap_or_default();
    let bundled = crate::servers::bundled_running(app).await;
    for window in windows {
        if app.get_webview_window(&window.label).is_some() {
            continue;
        }
        let bridge = match &window.server {
            SavedServer::Account { device_id } => {
                let opened = crate::account::open_bridge(app, device_id).await;
                if let Err(e) = &opened {
                    log::warn!("windows: {} opens on this computer, its own could not be opened: {e}", window.label);
                }
                Some(opened)
            }
            _ => None,
        };
        let place = placement(window, &saved_servers, bridge);
        if place.server == ServerId::Bundled && !bundled {
            // Nothing to show it on; the main window says the server did not start.
            log::warn!("windows: {} not restored, the built-in server is not running", window.label);
            continue;
        }
        match crate::window::restore_app_window(app, &window.label, &place.server, &place.path, window.frame).await {
            Ok(_) => {
                log::info!("windows: restored {} path={}", window.label, place.path);
                if place.path == window.path() {
                    came_back(windows, &window.label);
                }
            }
            Err(e) => log::warn!("windows: could not restore {}: {e:#}", window.label),
        }
    }
    if let Some(front) = windows.last().and_then(|window| app.get_webview_window(&window.label)) {
        crate::window::show_window(&front);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0199f3a2-7c4e-7b61-9f0e-2f6c1d3a4b5c";

    fn window(label: &str, server: SavedServer) -> SavedWindow {
        SavedWindow {
            label: label.to_string(),
            frame: Some(SavedWindowState { width: 1280, height: 820, x: Some(40), y: Some(60) }),
            server,
            session_id: Some(SESSION.to_string()),
        }
    }

    #[test]
    fn the_list_survives_a_round_trip_with_each_kind_of_computer() {
        let saved = vec![
            window("main", SavedServer::Builtin),
            window("main-2", SavedServer::Saved { base_url: "http://studio.local:8000".into() }),
            window("main-3", SavedServer::Account { device_id: "dev_abc".into() }),
        ];
        assert_eq!(windows_from(Some(&bytes_of(&saved))), saved);
        let text = String::from_utf8(bytes_of(&saved)).unwrap();
        assert!(text.contains(r#""kind": "account""#), "{text}");
    }

    #[test]
    fn a_missing_damaged_or_newer_file_is_no_windows() {
        assert!(windows_from(None).is_empty());
        assert!(windows_from(Some(b"not json")).is_empty());
        assert!(windows_from(Some(br#"{"version": 2, "windows": []}"#)).is_empty());
        assert!(windows_from(Some(br#"{"version": 1}"#)).is_empty());
    }

    #[test]
    fn the_windows_keep_the_order_they_were_saved_in() {
        let saved = vec![window("main-3", SavedServer::Builtin), window("main", SavedServer::Builtin), window("main-2", SavedServer::Builtin)];
        let labels: Vec<String> = windows_from(Some(&bytes_of(&saved))).into_iter().map(|w| w.label).collect();
        assert_eq!(labels, ["main-3", "main", "main-2"]);
    }

    #[test]
    fn entries_this_app_could_not_have_written_are_dropped() {
        let saved = vec![
            window("main", SavedServer::Builtin),
            window("main", SavedServer::Builtin),
            window("island", SavedServer::Builtin),
            window("main-", SavedServer::Builtin),
            window("main-2x", SavedServer::Builtin),
            window("main-2", SavedServer::Builtin),
        ];
        let labels: Vec<String> = windows_from(Some(&bytes_of(&saved))).into_iter().map(|w| w.label).collect();
        assert_eq!(labels, ["main", "main-2"]);
    }

    #[test]
    fn a_wrong_session_or_frame_is_dropped_and_the_window_kept() {
        let mut odd = window("main", SavedServer::Builtin);
        odd.session_id = Some("settings/models?x=1".into());
        odd.frame = Some(SavedWindowState { width: 20, height: 10, x: None, y: None });
        let restored = windows_from(Some(&bytes_of(&[odd])));
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].session_id, None);
        assert_eq!(restored[0].frame, None);
        assert_eq!(restored[0].path(), "/");
    }

    #[test]
    fn a_damaged_file_cannot_open_hundreds_of_windows() {
        let many: Vec<SavedWindow> = (2..400).map(|n| window(&format!("main-{n}"), SavedServer::Builtin)).collect();
        assert_eq!(windows_from(Some(&bytes_of(&many))).len(), MAX_WINDOWS);
    }

    #[test]
    fn a_window_opens_on_its_session_or_the_start_page() {
        let mut w = window("main-2", SavedServer::Builtin);
        assert_eq!(w.path(), format!("/{SESSION}"));
        w.session_id = None;
        assert_eq!(w.path(), "/");
        assert!(valid_session_id(SESSION));
        for bad in ["", "abc", "settings", "../../etc", "a/b", "0199f3a2?x=1", &"a".repeat(65)] {
            assert!(!valid_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_window_is_saved_with_the_computer_it_is_on() {
        let bridge = |base: &str| (base == "http://127.0.0.1:53111").then(|| "dev_abc".to_string());
        assert_eq!(saved_server(None, bridge), SavedServer::Builtin);
        assert_eq!(saved_server(Some("http://127.0.0.1:53111"), bridge), SavedServer::Account { device_id: "dev_abc".into() });
        assert_eq!(saved_server(Some("http://studio.local:8000"), bridge), SavedServer::Saved { base_url: "http://studio.local:8000".into() });
    }

    #[test]
    fn the_active_window_is_built_last() {
        let windows = vec![window("main", SavedServer::Builtin), window("main-2", SavedServer::Builtin), window("main-3", SavedServer::Builtin)];
        let labels: Vec<String> = active_last(windows, "main-2").into_iter().map(|w| w.label).collect();
        assert_eq!(labels, ["main", "main-3", "main-2"]);
    }

    #[test]
    fn a_window_closed_by_hand_leaves_the_list_unless_it_is_the_last() {
        let open = vec![window("main", SavedServer::Builtin), window("main-2", SavedServer::Builtin)];
        let labels = |windows: Vec<SavedWindow>| windows.into_iter().map(|w| w.label).collect::<Vec<_>>();
        assert_eq!(labels(after_close(open.clone(), "main")), ["main-2"]);
        assert_eq!(labels(after_close(open, "main-9")), ["main", "main-2"]);
        assert_eq!(labels(after_close(vec![window("main-2", SavedServer::Builtin)], "main-2")), ["main-2"]);
        assert!(after_close(Vec::new(), "main").is_empty());
    }

    #[test]
    fn the_launch_builds_the_main_window_first_only_on_the_builtin_server() {
        // Nothing saved: the start page, as before windows were saved.
        assert_eq!(first_window(&[]), Some(("/".to_string(), None)));
        let main = window("main", SavedServer::Builtin);
        let other = window("main-2", SavedServer::Builtin);
        assert_eq!(first_window(&[other.clone(), main.clone()]), Some((format!("/{SESSION}"), main.frame)));
        // Its page must not hear the built-in server's `backend-ready`.
        let away = window("main", SavedServer::Saved { base_url: "http://studio.local:8000".into() });
        assert_eq!(first_window(&[away]), None);
        // The main window was closed and another kept: no empty main beside it.
        assert_eq!(first_window(&[other]), None);
    }

    #[test]
    fn a_window_comes_back_on_its_own_computer_and_session() {
        let saved = ["http://studio.local:8000".to_string()];
        let session = format!("/{SESSION}");
        assert_eq!(
            placement(&window("main", SavedServer::Builtin), &saved, None),
            Placement { server: ServerId::Bundled, path: session.clone() }
        );
        assert_eq!(
            placement(&window("main-2", SavedServer::Saved { base_url: saved[0].clone() }), &saved, None),
            Placement { server: ServerId::External(saved[0].clone()), path: session.clone() }
        );
        let account = window("main-3", SavedServer::Account { device_id: "dev_abc".into() });
        assert_eq!(
            placement(&account, &saved, Some(Ok("http://127.0.0.1:53111".into()))),
            Placement { server: ServerId::External("http://127.0.0.1:53111".into()), path: session }
        );
    }

    #[test]
    fn a_window_whose_computer_is_gone_opens_here_without_its_session() {
        let here = Placement { server: ServerId::Bundled, path: "/".to_string() };
        // Removed from the server list since the window was saved.
        let removed = window("main-2", SavedServer::Saved { base_url: "http://gone.local:8000".into() });
        assert_eq!(placement(&removed, &["http://studio.local:8000".to_string()], None), here);
        let account = window("main-3", SavedServer::Account { device_id: "dev_abc".into() });
        assert_eq!(placement(&account, &[], Some(Err("offline".into()))), here);
        assert_eq!(placement(&account, &[], None), here);
    }

    #[test]
    fn the_shown_session_follows_what_the_page_reports() {
        note_session("test-window-a", Some(SESSION));
        assert_eq!(shown().lock().unwrap().get("test-window-a").map(String::as_str), Some(SESSION));
        // Not a session id: nothing to come back to.
        note_session("test-window-a", Some("settings"));
        assert!(!shown().lock().unwrap().contains_key("test-window-a"));
        note_session("test-window-a", Some(SESSION));
        forget_window("test-window-a");
        assert!(!shown().lock().unwrap().contains_key("test-window-a"));
    }

    #[test]
    fn a_window_that_came_back_keeps_its_session_until_its_page_reports() {
        let saved = [window("test-window-b", SavedServer::Saved { base_url: "http://studio.local:8000".into() })];
        came_back(&saved, "test-window-b");
        assert_eq!(shown().lock().unwrap().get("test-window-b").map(String::as_str), Some(SESSION));
        // The page loaded and shows no session.
        note_session("test-window-b", None);
        assert!(!shown().lock().unwrap().contains_key("test-window-b"));
        // Not one of the saved windows: nothing to keep.
        came_back(&saved, "test-window-c");
        assert!(!shown().lock().unwrap().contains_key("test-window-c"));
    }
}
