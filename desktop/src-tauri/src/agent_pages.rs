//! The agent's local pages while no app window is open.
//!
//! An app window keeps the pages the agent uses loaded out of sight (the
//! web's `PreviewKeepAlive`), so the agent can drive them with the Browser
//! tab closed. With every app window closed the shell does it instead: one
//! hidden window per page, loading `agent-page.html`, which frames the
//! page from the bundled server's preview listener. Framed, the page's
//! injected script polls the server for the agent's commands by itself.
//!
//! The server lists the pages (`GET /api/preview`, `agent_page`) and says
//! when the list changes (`preview_agent_pages` on the event stream the
//! island feed follows). A page leaves the list when the agent closes it,
//! its session is deleted, or it lapses unused.
//!
//! Rules:
//! - No copies while an app window is open: its hidden frame takes over.
//! - No copies unless another shell window (tray popup, island, pet)
//!   already keeps the app running: a hidden window must not stop closing
//!   the last window from quitting the app where it quits today.
//! - Local pages of the bundled server only; public sites stay in the app
//!   window's browser view.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Label prefix of the hidden windows (no capability matches it).
pub const AGENT_PAGE_PREFIX: &str = "agent-page/";
/// The web page that frames an agent's page (`web/agent-page.html`).
const HOST_PAGE: &str = "agent-page.html";
/// The list is read again this often, as app windows do.
const RESYNC_EVERY: Duration = Duration::from_secs(60);
/// How long a list or open request may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A page lays out at a real desktop size.
const PAGE_SIZE: (f64, f64) = (1280.0, 800.0);

pub fn is_agent_page_window(label: &str) -> bool {
    label.starts_with(AGENT_PAGE_PREFIX)
}

fn label_of(preview_id: &str) -> String {
    format!("{AGENT_PAGE_PREFIX}{preview_id}")
}

/// One row of `GET /api/preview`.
#[derive(Debug, Clone, Deserialize)]
pub struct PreviewRow {
    pub id: String,
    pub workspace: String,
    pub kind: String,
    #[serde(default)]
    pub agent_page: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct PreviewList {
    previews: Vec<PreviewRow>,
}

/// `POST /api/preview`'s answer: where the listener serves the page.
#[derive(Deserialize)]
struct Opened {
    origin: String,
    path: String,
}

/// Whether hidden copies may run, from the labels of the windows that stay
/// open: none while an app window is open, and only while another shell
/// window keeps the app running (browser views and copies do not count).
pub fn copies_allowed<'a>(labels: impl IntoIterator<Item = &'a str>) -> bool {
    let mut keeps_app = false;
    for label in labels {
        if !crate::window::is_overlay_window(label) {
            return false;
        }
        if !is_agent_page_window(label) && !crate::browser_view::is_browser_window(label) {
            keeps_app = true;
        }
    }
    keeps_app
}

/// The pages that get a hidden copy: the local pages an agent holds.
pub fn wanted(rows: &[PreviewRow]) -> Vec<&PreviewRow> {
    rows.iter().filter(|row| row.kind != "site" && row.agent_page.as_ref().is_some_and(|page| !page.is_null())).collect()
}

/// What to do to go from `current` to `wanted` copies (preview id to the
/// address each frames).
#[derive(Debug, Default, PartialEq)]
pub struct Changes {
    pub open: Vec<(String, String)>,
    pub navigate: Vec<(String, String)>,
    pub close: Vec<String>,
}

pub fn changes(current: &HashMap<String, String>, wanted: &HashMap<String, String>) -> Changes {
    let mut out = Changes::default();
    for (id, src) in wanted {
        match current.get(id) {
            None => out.open.push((id.clone(), src.clone())),
            Some(old) if old != src => out.navigate.push((id.clone(), src.clone())),
            Some(_) => {}
        }
    }
    out.close = current.keys().filter(|id| !wanted.contains_key(*id)).cloned().collect();
    out.open.sort();
    out.navigate.sort();
    out.close.sort();
    out
}

/// Navigation a copy's window allows. The policy sees the framed page's
/// own loads too, so web addresses pass; the frame's sandbox already stops
/// the page from moving the window. Of the app's own pages only the host
/// page loads: a copy never becomes an app window.
pub fn navigation_allowed(url: &tauri::Url) -> bool {
    let app_origin = matches!(url.scheme(), "tauri" | "asset") || matches!(url.host_str(), Some("tauri.localhost"));
    if app_origin {
        return url.path().trim_start_matches('/') == HOST_PAGE;
    }
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob")
}

/// The host page's address for a copy that frames `src`.
fn host_path(src: &str) -> String {
    let query: String = url::form_urlencoded::Serializer::new(String::new()).append_pair("src", src).finish();
    format!("{HOST_PAGE}?{query}")
}

/// What each open copy frames, by preview id.
fn copies() -> &'static Mutex<HashMap<String, String>> {
    static COPIES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    COPIES.get_or_init(Default::default)
}

fn wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

/// Start keeping copies in step with the server and the windows.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().unwrap_or_default();
        loop {
            let _ = tokio::time::timeout(RESYNC_EVERY, wake().notified()).await;
            sync(&app, &client).await;
        }
    });
}

/// The server's list or the windows changed: check the copies now.
pub fn changed() {
    wake().notify_one();
}

/// The island feed of `server` connected or dropped (`event` None), or
/// carried `event`. Only the bundled server's pages get copies; its feed
/// connecting or dropping means the pages may have changed unseen.
pub fn feed_changed(server: &crate::servers::ServerId, event: Option<&str>) {
    if *server == crate::servers::ServerId::Bundled && matches!(event, None | Some(AGENT_PAGES_EVENT)) {
        changed();
    }
}

/// The server's event that the list of agent pages changed.
const AGENT_PAGES_EVENT: &str = "preview_agent_pages";

/// An app window is closing. When no copy may run once it is gone, the
/// copies close first, so the app quits as it does without them.
pub fn app_window_closing(app: &AppHandle, label: &str) {
    let windows = app.webview_windows();
    if !copies_allowed(windows.keys().map(String::as_str).filter(|l| *l != label)) {
        apply(app, &HashMap::new());
    }
    changed();
}

async fn sync(app: &AppHandle, client: &reqwest::Client) {
    let state: tauri::State<'_, crate::AppState> = app.state();
    let quitting = state.quitting.load(std::sync::atomic::Ordering::SeqCst);
    if quitting || !copies_allowed(app.webview_windows().keys().map(String::as_str)) {
        apply(app, &HashMap::new());
        return;
    }
    let Some((base, token)) = crate::servers::endpoint(app, &crate::servers::ServerId::Bundled).await else {
        apply(app, &HashMap::new());
        return;
    };
    let base = base.trim_end_matches('/');
    let rows = match list(client, base, token.as_deref()).await {
        Ok(rows) => rows,
        Err(e) => {
            // The server may be restarting: keep what is there until it answers.
            log::debug!("agent pages: could not list pages: {e:#}");
            return;
        }
    };
    let mut next = HashMap::new();
    for row in wanted(&rows) {
        let Some(target) = row.agent_page.as_ref() else { continue };
        match open(client, base, token.as_deref(), &row.workspace, target).await {
            Ok(src) => {
                next.insert(row.id.clone(), src);
            }
            Err(e) => log::warn!("agent pages: could not open {}: {e:#}", row.id),
        }
    }
    // Windows may have opened while the server answered.
    if copies_allowed(app.webview_windows().keys().map(String::as_str)) {
        apply(app, &next);
    } else {
        apply(app, &HashMap::new());
    }
}

async fn list(client: &reqwest::Client, base: &str, token: Option<&str>) -> anyhow::Result<Vec<PreviewRow>> {
    let mut request = client.get(format!("{base}/api/preview"));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    Ok(request.send().await?.error_for_status()?.json::<PreviewList>().await?.previews)
}

/// Where the listener serves `target` (`{"kind": "url", "url"}` or
/// `{"kind": "file", "path"}`), as an app window's hidden frame asks.
async fn open(client: &reqwest::Client, base: &str, token: Option<&str>, workspace: &str, target: &serde_json::Value) -> anyhow::Result<String> {
    let mut body = serde_json::json!({"workspace": workspace});
    match target["kind"].as_str() {
        Some("url") => body["url"] = target["url"].clone(),
        Some("file") => body["path"] = target["path"].clone(),
        other => anyhow::bail!("unknown page kind {other:?}"),
    }
    let mut request = client.post(format!("{base}/api/preview")).json(&body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let opened: Opened = request.send().await?.error_for_status()?.json().await?;
    Ok(format!("{}{}", opened.origin, opened.path))
}

/// Open, move and close copies until they match `next`. The lock covers
/// only the bookkeeping: building a window waits for the main thread, which
/// may itself be closing an app window and calling this.
fn apply(app: &AppHandle, next: &HashMap<String, String>) {
    let current = || copies().lock().unwrap_or_else(|e| e.into_inner());
    let todo = {
        let mut current = current();
        // A copy whose window went away (closed by the system, crashed) is opened again.
        current.retain(|id, _| app.get_webview_window(&label_of(id)).is_some());
        changes(&current, next)
    };
    for id in &todo.close {
        if let Some(window) = app.get_webview_window(&label_of(id)) {
            let _ = window.destroy();
        }
        current().remove(id);
        log::info!("agent pages: closed the hidden copy of {id}");
    }
    for (id, src) in &todo.navigate {
        if let Some(window) = app.get_webview_window(&label_of(id)) {
            if let Ok(url) = window.url().and_then(|now| now.join(&format!("/{}", host_path(src))).map_err(|e| tauri::Error::Anyhow(e.into()))) {
                let _ = window.navigate(url);
            }
        }
        current().insert(id.clone(), src.clone());
    }
    for (id, src) in &todo.open {
        match build(app, id, src) {
            Ok(()) => {
                current().insert(id.clone(), src.clone());
                log::info!("agent pages: loading {id} in a hidden window");
            }
            Err(e) => log::warn!("agent pages: could not open a hidden window for {id}: {e:#}"),
        }
    }
}

fn build(app: &AppHandle, id: &str, src: &str) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, label_of(id), WebviewUrl::App(host_path(src).into()))
        .title("OpenAgentd page")
        .inner_size(PAGE_SIZE.0, PAGE_SIZE.1)
        .position(0.0, 0.0)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .skip_taskbar(true)
        .focused(false)
        // The agent uses the page while nothing shows it: the engine would
        // otherwise slow or stop the page's timers.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(navigation_allowed);
    #[cfg(target_os = "macos")]
    let builder = builder.transparent(true);
    // Elsewhere hidden as browser views are (unverified: whether the engine
    // slows a hidden page there).
    #[cfg(not(target_os = "macos"))]
    let builder = builder.visible(false);
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    hide_on_screen(app, &window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

/// macOS slows the timers of a page whose window is ordered out or off the
/// screen (about nine times, measured), so the window stays on screen,
/// transparent, click-through and behind every other window, on every Space,
/// and out of Mission Control and window cycling.
#[cfg(target_os = "macos")]
fn hide_on_screen(app: &AppHandle, window: &tauri::WebviewWindow) {
    let window = window.clone();
    let _ = app.run_on_main_thread(move || {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        match window.ns_window() {
            // SAFETY: Tauri hands out the window's live NSWindow, and this
            // runs on the main thread, where AppKit objects may be used.
            Ok(ptr) if !ptr.is_null() => {
                let ns = unsafe { &*(ptr as *const NSWindow) };
                ns.setAlphaValue(0.0);
                ns.setIgnoresMouseEvents(true);
                ns.setExcludedFromWindowsMenu(true);
                ns.setCollectionBehavior(
                    NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Transient | NSWindowCollectionBehavior::IgnoresCycle,
                );
                ns.orderBack(None);
            }
            _ => log::warn!("agent pages: no native window"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, kind: &str, page: Option<serde_json::Value>) -> PreviewRow {
        PreviewRow { id: id.into(), workspace: "/w".into(), kind: kind.into(), agent_page: page }
    }

    #[test]
    fn copies_run_only_with_no_app_window_and_something_keeping_the_app() {
        assert!(!copies_allowed(["main"].iter().copied()), "an app window loads the pages");
        assert!(!copies_allowed(["main-2", crate::island::ISLAND_WINDOW].iter().copied()));
        assert!(copies_allowed([crate::island::ISLAND_WINDOW].iter().copied()));
        assert!(copies_allowed([crate::tray_popup::TRAY_POPUP_WINDOW, "agent-page/a"].iter().copied()));
        assert!(copies_allowed([crate::pet::PET_WINDOW].iter().copied()));
        assert!(!copies_allowed(std::iter::empty()), "nothing keeps the app: closing the last window quits it");
        assert!(!copies_allowed(["agent-page/a"].iter().copied()), "a copy does not keep the app by itself");
    }

    #[test]
    fn only_local_pages_an_agent_holds_get_a_copy() {
        let rows = vec![
            row("held", "url", Some(serde_json::json!({"kind": "url", "url": "http://localhost:5173"}))),
            row("file", "file", Some(serde_json::json!({"kind": "file", "path": "a.html"}))),
            row("users", "url", None),
            row("null", "url", Some(serde_json::Value::Null)),
            row("site", "site", Some(serde_json::json!({"kind": "url", "url": "https://example.com"}))),
        ];
        let ids: Vec<&str> = wanted(&rows).iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["held", "file"]);
    }

    #[test]
    fn changes_open_move_and_close_copies() {
        let current = HashMap::from([("a".to_string(), "http://127.0.0.1:1/".to_string()), ("b".to_string(), "http://127.0.0.1:2/".to_string())]);
        let next = HashMap::from([("b".to_string(), "http://127.0.0.1:3/".to_string()), ("c".to_string(), "http://127.0.0.1:4/x".to_string())]);
        assert_eq!(
            changes(&current, &next),
            Changes {
                open: vec![("c".into(), "http://127.0.0.1:4/x".into())],
                navigate: vec![("b".into(), "http://127.0.0.1:3/".into())],
                close: vec!["a".into()],
            }
        );
        assert_eq!(changes(&next, &next), Changes::default());
        assert_eq!(changes(&next, &HashMap::new()).close, ["b", "c"]);
    }

    #[test]
    fn a_copy_loads_the_host_page_and_web_addresses_only() {
        let ok = |s: &str| navigation_allowed(&tauri::Url::parse(s).unwrap());
        assert!(ok("tauri://localhost/agent-page.html?src=x"));
        assert!(ok("http://tauri.localhost/agent-page.html"));
        assert!(ok("http://127.0.0.1:52011/pricing"), "the framed page");
        assert!(ok("https://www.youtube.com/embed/x"), "the page's own embeds");
        assert!(ok("about:blank"));
        assert!(!ok("tauri://localhost/index.html"), "never the app itself");
        assert!(!ok("http://tauri.localhost/"));
        assert!(!ok("file:///etc/passwd"));
    }

    #[test]
    fn the_host_page_gets_the_address_encoded() {
        assert_eq!(host_path("http://127.0.0.1:5/a?b=c&d"), "agent-page.html?src=http%3A%2F%2F127.0.0.1%3A5%2Fa%3Fb%3Dc%26d");
    }

    #[test]
    fn copies_are_shell_windows_not_app_windows() {
        assert!(crate::window::is_overlay_window("agent-page/x"));
        // The page in a copy may call no app command: no capability names it.
        for file in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/island.json"),
            include_str!("../capabilities/pet.json"),
            include_str!("../capabilities/tray.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(file).unwrap();
            for pattern in capability["windows"].as_array().unwrap().iter().filter_map(|w| w.as_str()) {
                let matches = match pattern.strip_suffix('*') {
                    Some(prefix) => "agent-page/x".starts_with(prefix),
                    None => pattern == "agent-page/x",
                };
                assert!(!matches, "{pattern} matches a copy");
            }
        }
    }
}
