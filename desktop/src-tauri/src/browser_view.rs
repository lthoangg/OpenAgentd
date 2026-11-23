//! Public sites in the Browser tab.
//!
//! A page from the public web is shown by a borderless child window of the
//! app window, placed over the Browser tab's page area. It is a window of
//! its own, not a second webview in the app window: with two webviews Tauri
//! stops treating the window as a `WebviewWindow`, which every command of
//! this shell takes.
//!
//! The pages are untrusted. They run in a browser profile of their own (no
//! cookie or storage shared with the app or with the user's browsers), their
//! window is in no capability, so no page can call a command, and they
//! never get the backend token. The app window drives a view through the
//! commands here and hears about it through [`EVENT`].
//!
//! Each page gets the preview script the backend's proxy adds to local
//! pages ([`PAGE_SCRIPT`]), which draws the agent's cursor, picks elements
//! for comments and runs the agent's commands. With no command to call, the
//! page cannot send anything: the script queues what it has to say, and
//! [`collect`] asks for it a few times a second. Everything read back from
//! a page is data a site chose, never an instruction.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::{Host, Url};

/// Labels of browser windows start with this; see [`is_browser_window`].
pub const BROWSER_WINDOW_PREFIX: &str = "browser/";
/// Event the owning app window receives: `{ id, kind, … }` ([`ViewEvent`]).
pub const EVENT: &str = "browser-view";

/// The profile's data store on macOS 14 and later (a fixed UUID: the same
/// store on every launch, so sign-ins are kept).
#[cfg(target_os = "macos")]
const PROFILE_STORE: [u8; 16] = [0x6f, 0x61, 0x64, 0x2d, 0x62, 0x72, 0x6f, 0x77, 0x73, 0x65, 0x72, 0x2d, 0x70, 0x72, 0x6f, 0x31];

/// The preview script, told that it runs in a native view. One source with
/// the backend's proxy, which adds the same file to local pages.
const PAGE_SCRIPT: &str = concat!("window.__openagentdNative = true;\n", include_str!("../../../appv3/crates/preview/assets/inspector.js"));
/// What the page has queued, as JSON text: `null` before the script runs,
/// `""` when there is nothing.
const DRAIN_SCRIPT: &str = "(function(){var b=window.__openagentdNativeBridge;return b?b.drain():null})()";
/// How often a view's page is asked for what it queued.
const COLLECT_EVERY: Duration = Duration::from_millis(150);
/// Most messages taken from one collection, and its largest size.
const MAX_MESSAGES: usize = 500;
const MAX_COLLECTED_BYTES: usize = 2 * 1024 * 1024;
/// How long a command waits for a page that is still loading its script.
const PAGE_READY_WAIT: Duration = Duration::from_secs(8);
/// How long one script evaluation may take to answer.
const EVAL_WAIT: Duration = Duration::from_secs(3);

pub fn is_browser_window(label: &str) -> bool {
    label.starts_with(BROWSER_WINDOW_PREFIX)
}

/// Where a view sits, as fractions of the app window's page (0 to 1), so
/// the page's zoom and the display's scale do not matter. `zoom` scales
/// the page inside it (1 when absent): a device size larger than the tab
/// is shown smaller, as a framed local preview is.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub zoom: Option<f64>,
}

impl Frame {
    fn checked(self) -> Result<Self, String> {
        let ok = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
        if !(ok(self.x) && ok(self.y) && ok(self.width) && ok(self.height)) {
            return Err("frame: each value must be between 0 and 1".to_string());
        }
        if self.zoom.is_some_and(|z| !z.is_finite() || !(0.1..=4.0).contains(&z)) {
            return Err("frame: zoom must be between 0.1 and 4".to_string());
        }
        Ok(self)
    }
}

/// The view's rectangle in physical pixels: `(x, y, width, height)`.
fn child_rect(inner_pos: (i32, i32), inner_size: (u32, u32), frame: Frame) -> (i32, i32, u32, u32) {
    let (w, h) = (f64::from(inner_size.0), f64::from(inner_size.1));
    let x = inner_pos.0 + (frame.x * w).round() as i32;
    let y = inner_pos.1 + (frame.y * h).round() as i32;
    let width = ((frame.width * w).round() as u32).max(1);
    let height = ((frame.height * h).round() as u32).max(1);
    (x, y, width, height)
}

struct View {
    owner: String,
    /// `None` while the view is out of sight.
    frame: Option<Frame>,
    /// The app window sent the view to an address: [`collect`] reports
    /// where the view is once more, so a load that failed at once (and so
    /// changed nothing) is still heard of.
    sent: bool,
}

/// The open views, by window label.
#[derive(Default)]
pub struct BrowserViews(Mutex<HashMap<String, View>>);

impl BrowserViews {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, View>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// What happened in a view, for the app window that owns it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ViewEvent {
    /// The main document started or finished loading.
    Load { phase: &'static str, url: String },
    Title { title: String },
    /// A navigation the view refused ([`navigation_allowed`]).
    Blocked { url: String },
    /// A download the view did not start.
    Download { url: String },
    /// Where the view is now: its address changed (a navigation, or the
    /// page's own history calls) or it started or stopped loading. `url` is
    /// empty when no page could be loaded; `loading` is absent where the
    /// engine does not say.
    Url {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        loading: Option<bool>,
    },
    /// What the page's script queued (`preview-protocol` messages and the
    /// agent's results), with the address they came from.
    Page { url: String, messages: Vec<Value> },
}

#[derive(Clone, Serialize)]
struct Envelope<'a> {
    id: &'a str,
    #[serde(flatten)]
    event: ViewEvent,
}

/// Sends a view's events to its app window, and to no other webview.
#[derive(Clone)]
struct Reporter {
    app: AppHandle,
    owner: String,
    id: String,
}

impl Reporter {
    fn send(&self, event: ViewEvent) {
        let _ = self.app.emit_to(EventTarget::webview_window(self.owner.as_str()), EVENT, Envelope { id: &self.id, event });
    }
}

/// The window label of view `id` of the app window `owner`.
fn view_label(owner: &str, id: &str) -> Result<String, String> {
    let valid = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return Err("id: use up to 64 letters, digits, '-' or '_'".to_string());
    }
    Ok(format!("{BROWSER_WINDOW_PREFIX}{owner}/{id}"))
}

fn is_this_computer(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Host::Ipv4(ip) => ip.is_loopback() || ip.is_unspecified(),
        Host::Ipv6(ip) => ip.is_loopback() || ip.is_unspecified() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_unspecified()),
    }
}

/// A page the view may show: `http` or `https`, on another machine. A
/// server on this computer is previewed through the backend's proxy, which
/// keeps it away from the OpenAgentd API; the view never loads one.
pub fn page_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("Invalid URL: {e}."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Only http and https pages can be opened, not '{}'.", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address cannot contain a user name or password.".to_string());
    }
    match url.host() {
        None => Err("The address has no host.".to_string()),
        Some(host) if is_this_computer(&host) => Err("Servers on this computer open as local previews.".to_string()),
        Some(_) => Ok(url),
    }
}

/// May a document in the view (the page or a frame in it) load `url`?
/// Besides pages, the inert schemes frames commonly use.
fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => page_url(url.as_str()).is_ok(),
        "about" | "blob" | "data" => true,
        _ => false,
    }
}

/// The messages in one answer to [`DRAIN_SCRIPT`]. The answer is JSON for
/// the script's return value, itself JSON text; anything else is nothing.
fn collected(raw: &str) -> Vec<Value> {
    if raw.len() > MAX_COLLECTED_BYTES {
        return Vec::new();
    }
    let inner = match serde_json::from_str::<Value>(raw) {
        Ok(Value::String(text)) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
        Ok(other) => other,
        Err(_) => Value::Null,
    };
    match inner {
        Value::Array(mut messages) => {
            messages.retain(Value::is_object);
            messages.truncate(MAX_MESSAGES);
            messages
        }
        _ => Vec::new(),
    }
}

/// Where a view is.
#[derive(Debug, Default, PartialEq)]
struct Address {
    /// None before a first page arrives and after one that could not be
    /// loaded.
    url: Option<Url>,
    /// None where the engine does not say.
    loading: Option<bool>,
}

impl Address {
    /// The host the page is on, as the server names it in a command.
    fn host(&self) -> String {
        self.url.as_ref().and_then(Url::host_str).map(|h| h.trim_end_matches('.').to_ascii_lowercase()).unwrap_or_default()
    }

    fn failed(&self) -> bool {
        self.url.is_none() && self.loading == Some(false)
    }
}

/// Where `view` is, or None when the view is going away. Asked of the
/// engine's own view: Tauri's `url()` panics on the main thread, ending the
/// app, while a WKWebView has no address (its first page did not load).
/// Waits for the main thread, so never call it there.
#[cfg(target_os = "macos")]
fn address(view: &WebviewWindow) -> Option<Address> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSURL;

    let (tx, rx) = std::sync::mpsc::channel::<(Option<String>, bool)>();
    view.with_webview(move |webview| {
        let inner = webview.inner().cast::<AnyObject>();
        if inner.is_null() {
            return;
        }
        // SAFETY: on macOS `inner()` is the window's live WKWebView, and
        // `with_webview` runs this on the main thread, where WebKit objects
        // may be used.
        let inner = unsafe { &*inner };
        // SAFETY: WKWebView's `URL` is a nullable NSURL and `isLoading` a BOOL.
        let url: Option<Retained<NSURL>> = unsafe { msg_send![inner, URL] };
        let loading: bool = unsafe { msg_send![inner, isLoading] };
        let _ = tx.send((url.and_then(|u| u.absoluteString()).map(|s| s.to_string()), loading));
    })
    .ok()?;
    let (url, loading) = rx.recv_timeout(EVAL_WAIT).ok()?;
    Some(Address { url: url.and_then(|raw| Url::parse(&raw).ok()), loading: Some(loading) })
}

#[cfg(not(target_os = "macos"))]
fn address(view: &WebviewWindow) -> Option<Address> {
    Some(Address { url: view.url().ok(), loading: None })
}

/// Ask the view's page, a few times a second, for what its script queued,
/// and report where the view is when that changes. Ends when the view is
/// gone.
fn collect(app: AppHandle, label: String, reporter: Reporter) {
    tauri::async_runtime::spawn(async move {
        // A view is built loading its first page.
        let mut last = (String::new(), Some(true));
        loop {
            tokio::time::sleep(COLLECT_EVERY).await;
            let Some(view) = app.get_webview_window(&label) else { break };
            // Read before the address: a view sent somewhere after this
            // line is reported by the next round, never as where it was.
            let sent = app.try_state::<BrowserViews>().is_some_and(|views| views.lock().get_mut(&label).is_some_and(|v| std::mem::take(&mut v.sent)));
            let Some(at) = address(&view) else { continue };
            let url = at.url.map(String::from).unwrap_or_default();
            let now = (url.clone(), at.loading);
            if sent || now != last {
                last = now;
                reporter.send(ViewEvent::Url { url: url.clone(), loading: at.loading });
            }
            let reporter = reporter.clone();
            let _ = view.eval_with_callback(DRAIN_SCRIPT, move |raw| {
                let messages = collected(&raw);
                if !messages.is_empty() {
                    reporter.send(ViewEvent::Page { url: url.clone(), messages });
                }
            });
        }
    });
}

/// Evaluate `script` in the view's page and return its value.
async fn eval_value(view: &WebviewWindow, script: String) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    view.eval_with_callback(script, move |raw| {
        if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(raw);
        }
    })
    .map_err(err)?;
    let raw = tokio::time::timeout(EVAL_WAIT, rx).await.map_err(|_| "The page did not answer.".to_string())?.map_err(|_| "The page went away.".to_string())?;
    Ok(serde_json::from_str(&raw).unwrap_or(Value::Null))
}

/// A call of the page script's bridge with one argument, which the script
/// parses as JSON. `serde_json` writes the argument as a string literal, so
/// nothing in it can end the literal and run as script.
fn bridge_call(method: &str, argument: &Value) -> String {
    let text = serde_json::to_string(&argument.to_string()).unwrap_or_else(|_| "\"null\"".to_string());
    format!("(function(){{var b=window.__openagentdNativeBridge;return b?b.{method}({text}):null}})()")
}

/// What [`run_call`] answers in a document of another site.
const MOVED: &str = "openagentd:moved";

/// The agent's command `envelope` for a document of `site`, and of no
/// other. The address the engine reports is not enough: while a page loads
/// it is the next page's, and a page can leave between the check and the
/// call. The script therefore checks its own document first; `location`
/// cannot be replaced by a page, and the test uses no function a page can.
fn run_call(site: &str, envelope: &Value) -> String {
    let site = serde_json::to_string(site).unwrap_or_else(|_| "\"\"".to_string());
    let moved = serde_json::to_string(MOVED).unwrap_or_default();
    let call = bridge_call("run", envelope);
    format!("(function(){{var h=location.hostname;if(h!=={site}&&h!=={site}+\".\")return {moved};return {call}}})()")
}

/// Why the command for `site` may not run on a page that is on `actual`.
fn wrong_site(site: Option<&str>, actual: &str) -> Option<String> {
    match site {
        None => Some("The command does not say which site it is for.".to_string()),
        Some(site) if site == actual => None,
        Some(site) => Some(format!("The page is on {} now, not {site}. Take a snapshot to continue there.", if actual.is_empty() { "another address" } else { actual })),
    }
}

/// Safari's user agent for this macOS. A bare WKWebView leaves out the
/// `Version/… Safari/…` part, and sites then treat it as an unsupported
/// browser.
#[cfg(target_os = "macos")]
fn user_agent(os_major: u32) -> String {
    // Safari took the system's version number with macOS 26.
    let safari = if os_major >= 26 { format!("{os_major}.0") } else { "18.6".to_string() };
    format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{safari} Safari/605.1.15")
}

/// The major version of this macOS (0 when it cannot be read).
#[cfg(target_os = "macos")]
fn macos_major() -> u32 {
    static MAJOR: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *MAJOR.get_or_init(|| {
        std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|v| v.trim().split('.').next().and_then(|major| major.parse().ok()))
            .unwrap_or(0)
    })
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Put the view over `frame` of its app window.
fn place(owner: &WebviewWindow, view: &WebviewWindow, frame: Frame) -> Result<(), String> {
    let pos = owner.inner_position().map_err(err)?;
    let size = owner.inner_size().map_err(err)?;
    let (x, y, width, height) = child_rect((pos.x, pos.y), (size.width, size.height), frame);
    view.set_size(PhysicalSize::new(width, height)).map_err(err)?;
    view.set_position(PhysicalPosition::new(x, y)).map_err(err)
}

/// Show or hide the view without changing which window has the keyboard.
/// On macOS showing a window makes it the key window, so the view stays
/// ordered in and is made transparent and click-through instead.
fn set_shown(app: &AppHandle, view: &WebviewWindow, shown: bool) {
    #[cfg(target_os = "macos")]
    {
        let view = view.clone();
        let _ = app.run_on_main_thread(move || {
            use objc2_app_kit::NSWindow;
            match view.ns_window() {
                // SAFETY: Tauri hands out the window's live NSWindow, and this
                // runs on the main thread, where AppKit objects may be used.
                Ok(ptr) if !ptr.is_null() => {
                    let ns = unsafe { &*(ptr as *const NSWindow) };
                    ns.setAlphaValue(if shown { 1.0 } else { 0.0 });
                    ns.setIgnoresMouseEvents(!shown);
                }
                _ => log::warn!("browser view: no native window"),
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = if shown { view.show() } else { view.hide() };
    }
}

/// Apply `frame` (`None` hides the view). A hidden view that had the
/// keyboard gives it back to its app window.
fn apply(app: &AppHandle, owner: &WebviewWindow, view: &WebviewWindow, frame: Option<Frame>) -> Result<(), String> {
    match frame {
        Some(frame) => {
            place(owner, view, frame)?;
            view.set_zoom(frame.zoom.unwrap_or(1.0)).map_err(err)?;
            set_shown(app, view, true);
        }
        None => {
            set_shown(app, view, false);
            if view.is_focused().unwrap_or(false) {
                let _ = owner.set_focus();
            }
        }
    }
    Ok(())
}

fn app_window(window: &WebviewWindow) -> Result<(), String> {
    if crate::window::is_overlay_window(window.label()) {
        return Err("Only an app window can show a page.".to_string());
    }
    Ok(())
}

fn build(app: &AppHandle, owner: &WebviewWindow, label: &str, id: &str, url: Url, frame: Option<Frame>) -> Result<WebviewWindow, String> {
    let reporter = Reporter { app: app.clone(), owner: owner.label().to_string(), id: id.to_string() };
    // Built at its place, so it never flashes somewhere else first. A view
    // opened out of sight covers the app window's page, transparent: a page
    // needs a real size to lay out, and the engine slows the timers of one
    // that is off the screen.
    let scale = owner.scale_factor().map_err(err)?;
    let pos = owner.inner_position().map_err(err)?;
    let size = owner.inner_size().map_err(err)?;
    let (x, y, width, height) = child_rect((pos.x, pos.y), (size.width, size.height), frame.unwrap_or(Frame { x: 0.0, y: 0.0, width: 1.0, height: 1.0, zoom: None }));
    let navigation = reporter.clone();
    let new_window = (app.clone(), label.to_string(), reporter.clone());
    let loads = reporter.clone();
    let titles = reporter.clone();
    let downloads = reporter.clone();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("OpenAgentd page")
        .parent(owner)
        .map_err(err)?
        .position(f64::from(x) / scale, f64::from(y) / scale)
        .inner_size(f64::from(width) / scale, f64::from(height) / scale)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .skip_taskbar(true)
        // The person may be typing in the chat when the agent opens a page.
        .focused(false)
        // The agent uses a page while the app is behind another one; the
        // engine would otherwise slow or stop that page's timers.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(PAGE_SCRIPT)
        .on_navigation(move |url| {
            let allowed = navigation_allowed(url);
            if !allowed {
                navigation.send(ViewEvent::Blocked { url: url.to_string() });
            }
            allowed
        })
        // A link that asks for a new window opens in this view.
        .on_new_window(move |url, _features| {
            let (app, label, reporter) = &new_window;
            if navigation_allowed(&url) && matches!(url.scheme(), "http" | "https") {
                if let Some(view) = app.get_webview_window(label) {
                    let _ = view.navigate(url);
                }
            } else {
                reporter.send(ViewEvent::Blocked { url: url.to_string() });
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_window, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            loads.send(ViewEvent::Load { phase, url: payload.url().to_string() });
        })
        .on_document_title_changed(move |_window, title| titles.send(ViewEvent::Title { title }))
        .on_download(move |_webview, event| {
            if let tauri::webview::DownloadEvent::Requested { url, .. } = event {
                downloads.send(ViewEvent::Download { url: url.to_string() });
            }
            false
        });
    #[cfg(target_os = "macos")]
    {
        let major = macos_major();
        builder = builder.user_agent(&user_agent(major));
        // Before macOS 14 a WKWebView cannot have a data store of its own
        // on disk: use one in memory, so nothing is shared with the app.
        builder = if major >= 14 { builder.data_store_identifier(PROFILE_STORE) } else { builder.incognito(true) };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let dir = app.path().app_data_dir().map_err(err)?.join("browser-profile");
        builder = builder.data_directory(dir);
    }
    // Hidden views are built transparent from their first frame.
    #[cfg(target_os = "macos")]
    if frame.is_none() {
        builder = builder.transparent(true);
    }
    let view = builder.build().map_err(err)?;
    match frame {
        Some(frame) => view.set_zoom(frame.zoom.unwrap_or(1.0)).map_err(err)?,
        None => set_shown(app, &view, false),
    }
    collect(app.clone(), label.to_string(), reporter);
    Ok(view)
}

/// Show `url` in view `id` of the calling app window, creating the view on
/// first use. `frame` is where it goes; without one it loads out of sight.
#[tauri::command]
pub async fn browser_view_open(
    app: AppHandle,
    window: WebviewWindow,
    views: tauri::State<'_, BrowserViews>,
    id: String,
    url: String,
    frame: Option<Frame>,
) -> Result<(), String> {
    app_window(&window)?;
    let label = view_label(window.label(), &id)?;
    let url = page_url(&url)?;
    let frame = frame.map(Frame::checked).transpose()?;
    match app.get_webview_window(&label) {
        Some(view) => {
            view.navigate(url).map_err(err)?;
            apply(&app, &window, &view, frame)?;
        }
        None => {
            build(&app, &window, &label, &id, url, frame)?;
            log::info!("browser view opened label={label}");
        }
    }
    views.lock().insert(label, View { owner: window.label().to_string(), frame, sent: true });
    Ok(())
}

fn existing(app: &AppHandle, window: &WebviewWindow, id: &str) -> Result<(String, WebviewWindow), String> {
    app_window(window)?;
    let label = view_label(window.label(), id)?;
    let view = app.get_webview_window(&label).ok_or_else(|| "This page is not open.".to_string())?;
    Ok((label, view))
}

/// Move view `id` (or hide it, with no `frame`).
#[tauri::command]
pub fn browser_view_frame(app: AppHandle, window: WebviewWindow, views: tauri::State<'_, BrowserViews>, id: String, frame: Option<Frame>) -> Result<(), String> {
    let (label, view) = existing(&app, &window, &id)?;
    let frame = frame.map(Frame::checked).transpose()?;
    if let Some(state) = views.lock().get_mut(&label) {
        state.frame = frame;
    }
    apply(&app, &window, &view, frame)
}

/// What the toolbar asks of a view.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Travel {
    Back,
    Forward,
    Reload,
}

#[tauri::command]
pub fn browser_view_go(app: AppHandle, window: WebviewWindow, id: String, to: Travel) -> Result<(), String> {
    let (_, view) = existing(&app, &window, &id)?;
    match to {
        Travel::Back => view.eval("history.back()"),
        Travel::Forward => view.eval("history.forward()"),
        Travel::Reload => view.reload(),
    }
    .map_err(err)
}

/// Run the agent's command `{ id, command }` in view `id`'s page. The
/// server names the site it allowed in `command.site`; the command runs
/// only while the page is on that host, so a page that moved to another
/// site is not acted on. The result arrives as a `page` event.
#[tauri::command]
pub async fn browser_view_run(app: AppHandle, window: WebviewWindow, id: String, envelope: Value) -> Result<(), String> {
    let (_, view) = existing(&app, &window, &id)?;
    let site = envelope.pointer("/command/site").and_then(Value::as_str).filter(|site| !site.is_empty()).map(str::to_string);
    let script = run_call(site.as_deref().unwrap_or_default(), &envelope);
    let deadline = tokio::time::Instant::now() + PAGE_READY_WAIT;
    loop {
        let at = address(&view).ok_or_else(|| "This page is not open.".to_string())?;
        if at.failed() {
            return Err("The page could not be loaded. Check the address.".to_string());
        }
        if let Some(refusal) = wrong_site(site.as_deref(), &at.host()) {
            return Err(refusal);
        }
        match eval_value(&view, script.clone()).await {
            Ok(Value::Bool(true)) => return Ok(()),
            Ok(Value::Bool(false)) => return Err("The page could not run the command.".to_string()),
            // The document is another site's: the page left since the check
            // above, or is still on its way to this site.
            Ok(Value::String(answer)) if answer == MOVED => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(wrong_site(site.as_deref(), "").unwrap_or_default());
                }
                tokio::time::sleep(COLLECT_EVERY).await;
            }
            // No script yet: the page is still loading.
            _ if tokio::time::Instant::now() >= deadline => return Err("The page did not finish loading in time. Try again, or take a snapshot.".to_string()),
            _ => tokio::time::sleep(COLLECT_EVERY).await,
        }
    }
}

/// A dock command for view `id`'s page script (comment mode, pins).
#[tauri::command]
pub fn browser_view_dock(app: AppHandle, window: WebviewWindow, id: String, command: Value) -> Result<(), String> {
    let (_, view) = existing(&app, &window, &id)?;
    view.eval(bridge_call("dock", &command)).map_err(err)
}

/// What an import did. Counts only: no cookie leaves the shell again.
#[derive(Debug, Serialize, PartialEq)]
pub struct ImportReport {
    /// The site the cookies were kept for.
    site: String,
    imported: usize,
    /// Cookies of other sites, which were left out.
    other_sites: usize,
    /// Entries that were not cookies this app can store.
    unreadable: usize,
}

/// Put the cookies of the pasted export `text` that belong to view `id`'s
/// site into the profile, and load the page again. For a site that will
/// not sign in inside the app: the user exports its cookies from a browser
/// where they are signed in.
#[tauri::command]
pub async fn browser_view_import_cookies(app: AppHandle, window: WebviewWindow, id: String, text: String) -> Result<ImportReport, String> {
    let (_, view) = existing(&app, &window, &id)?;
    let host = address(&view).unwrap_or_default().host();
    if host.is_empty() {
        return Err("Open a page of the site first.".to_string());
    }
    let (cookies, unreadable) = crate::browser_cookies::parse_export(&text)?;
    let (own, others): (Vec<_>, Vec<_>) = cookies.into_iter().partition(|c| crate::browser_cookies::belongs_to(&c.domain, &host));
    let site = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if own.is_empty() {
        return Err(format!("None of these cookies are for {site}. Open the site they are from, then import them there."));
    }
    let imported = own.iter().filter(|cookie| view.set_cookie(cookie.to_cookie()).is_ok()).count();
    if imported == 0 {
        return Err("The cookies could not be saved.".to_string());
    }
    view.reload().map_err(err)?;
    log::info!("browser view: cookies imported count={imported} other_sites={} unreadable={unreadable}", others.len());
    Ok(ImportReport { site, imported, other_sites: others.len(), unreadable })
}

/// Delete the cookies view `id`'s page is sent (which signs the user out
/// of that site) and load the page again. Returns how many there were.
#[tauri::command]
pub async fn browser_view_clear_cookies(app: AppHandle, window: WebviewWindow, id: String) -> Result<usize, String> {
    let (_, view) = existing(&app, &window, &id)?;
    let url = address(&view).and_then(|at| at.url).ok_or_else(|| "Open a page of the site first.".to_string())?;
    let cookies = view.cookies_for_url(url).map_err(err)?;
    for cookie in &cookies {
        let _ = view.delete_cookie(cookie.clone());
        // One that covers subdomains is stored with a leading dot, which
        // the cookie type drops (see `browser_cookies::to_cookie`).
        if let Some(domain) = cookie.domain() {
            let mut dotted = cookie.clone();
            dotted.set_domain(format!("..{domain}"));
            let _ = view.delete_cookie(dotted);
        }
    }
    view.reload().map_err(err)?;
    log::info!("browser view: site cookies cleared count={}", cookies.len());
    Ok(cookies.len())
}

/// Delete everything the profile holds (cookies, storage, caches): every
/// site in the Browser tab is signed out. Open pages load again.
#[tauri::command]
pub async fn browser_profile_clear(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    app_window(&window)?;
    let open: Vec<WebviewWindow> = app.webview_windows().into_iter().filter(|(label, _)| is_browser_window(label)).map(|(_, view)| view).collect();
    // The data is removed through a view of the profile; with none open, one is made for it.
    let (view, temporary) = match open.first() {
        Some(view) => (view.clone(), false),
        None => {
            let label = view_label(window.label(), "clear-data")?;
            let blank = Url::parse("about:blank").map_err(err)?;
            (build(&app, &window, &label, "clear-data", blank, None)?, true)
        }
    };
    view.clear_all_browsing_data().map_err(err)?;
    // The removal finishes a moment after the call returns.
    tokio::time::sleep(Duration::from_millis(600)).await;
    if temporary {
        let _ = view.destroy();
    }
    for view in &open {
        let _ = view.reload();
    }
    log::info!("browser view: profile cleared");
    Ok(())
}

fn close_view(app: &AppHandle, label: &str) {
    if let Some(view) = app.get_webview_window(label) {
        let _ = view.destroy();
    }
}

#[tauri::command]
pub fn browser_view_close(app: AppHandle, window: WebviewWindow, views: tauri::State<'_, BrowserViews>, id: String) -> Result<(), String> {
    app_window(&window)?;
    let label = view_label(window.label(), &id)?;
    views.lock().remove(&label);
    close_view(&app, &label);
    Ok(())
}

/// Close every view of the app window `owner` (it closed, or its page
/// loaded afresh and no longer knows them).
pub fn close_window(app: &AppHandle, owner: &str) {
    let Some(views) = app.try_state::<BrowserViews>() else { return };
    let labels: Vec<String> = {
        let mut all = views.lock();
        let labels: Vec<String> = all.iter().filter(|(_, v)| v.owner == owner).map(|(label, _)| label.clone()).collect();
        for label in &labels {
            all.remove(label);
        }
        labels
    };
    for label in labels {
        close_view(app, &label);
    }
}

/// The calling app window's page started afresh: close the views it had.
#[tauri::command]
pub fn browser_view_reset(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    app_window(&window)?;
    close_window(&app, window.label());
    Ok(())
}

/// The app window `owner` moved or changed size: its views follow.
pub fn owner_changed(app: &AppHandle, owner: &str) {
    let Some(views) = app.try_state::<BrowserViews>() else { return };
    let placed: Vec<(String, Frame)> = views.lock().iter().filter(|(_, v)| v.owner == owner).filter_map(|(label, v)| v.frame.map(|f| (label.clone(), f))).collect();
    if placed.is_empty() {
        return;
    }
    let Some(owner) = app.get_webview_window(owner) else { return };
    for (label, frame) in placed {
        if let Some(view) = app.get_webview_window(&label) {
            let _ = place(&owner, &view, frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_label_names_its_owner_and_refuses_odd_ids() {
        assert_eq!(view_label("main", "tab_1-a").unwrap(), "browser/main/tab_1-a");
        assert!(is_browser_window(&view_label("main-2", "t").unwrap()));
        assert!(!is_browser_window("main"));
        for id in ["", "a/b", "a b", "a:b", &"x".repeat(65)] {
            assert!(view_label("main", id).is_err(), "{id:?} should be refused");
        }
    }

    #[test]
    fn pages_are_http_on_another_machine() {
        for ok in ["https://example.com/a?b=1#c", "http://192.168.1.20:3000/", "https://sub.example.co.uk"] {
            assert!(page_url(ok).is_ok(), "{ok} should open");
        }
        for refused in [
            "",
            "example.com",
            "ftp://example.com/",
            "file:///etc/passwd",
            "tauri://localhost/",
            "javascript:alert(1)",
            "http://localhost:8000/",
            "http://app.localhost/",
            "http://LOCALHOST./",
            "http://127.0.0.1:4082/api",
            "http://127.8.9.1/",
            "http://0.0.0.0:5173/",
            "http://[::1]:5173/",
            "http://[::ffff:127.0.0.1]/",
            "https://user:[REDACTED]@example.com/",
        ] {
            assert!(page_url(refused).is_err(), "{refused} should be refused");
        }
    }

    #[test]
    fn frames_may_use_inert_schemes_but_nothing_else() {
        let allowed = |raw: &str| navigation_allowed(&Url::parse(raw).unwrap());
        assert!(allowed("https://example.com/"));
        assert!(allowed("about:blank"));
        assert!(allowed("blob:https://example.com/1234"));
        assert!(allowed("data:text/html,hi"));
        assert!(!allowed("http://127.0.0.1:4082/api/agent"));
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("tauri://localhost/index.html"));
        assert!(!allowed("openagentd://open"));
    }

    #[test]
    fn a_frame_maps_to_the_app_windows_pixels() {
        let frame = Frame { x: 0.5, y: 0.1, width: 0.5, height: 0.9, zoom: None };
        assert_eq!(child_rect((100, 50), (2000, 1000), frame), (1100, 150, 1000, 900));
        // Never an empty window.
        assert_eq!(child_rect((0, 0), (2000, 1000), Frame { x: 0.0, y: 0.0, width: 0.0, height: 0.0, zoom: None }), (0, 0, 1, 1));
        assert!(frame.checked().is_ok());
        assert!(Frame { zoom: Some(0.5), ..frame }.checked().is_ok());
        for bad in [Frame { x: -0.1, ..frame }, Frame { width: 1.5, ..frame }, Frame { y: f64::NAN, ..frame }, Frame { zoom: Some(0.0), ..frame }, Frame { zoom: Some(f64::INFINITY), ..frame }] {
            assert!(bad.checked().is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_user_agent_is_safaris() {
        assert!(user_agent(27).contains("Version/27.0 Safari/605.1.15"));
        assert!(user_agent(15).contains("Version/18.6 Safari/605.1.15"));
    }

    #[test]
    fn collected_messages_are_objects_from_json_text() {
        // A string result arrives as JSON for that string.
        let raw = serde_json::to_string(r#"[{"type":"ready"},{"type":"agent-reply","reply":{"id":"1","ok":true}}]"#).unwrap();
        let messages = collected(&raw);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["reply"]["id"], "1");
        // An engine that hands the array over directly works too.
        assert_eq!(collected(r#"[{"type":"ready"}, 3, "x"]"#).len(), 1);
        for nothing in ["null", "\"\"", "", "\"not json\"", "{\"a\":1}", "42"] {
            assert!(collected(nothing).is_empty(), "{nothing:?}");
        }
        let many = serde_json::to_string(&serde_json::to_string(&vec![serde_json::json!({}); MAX_MESSAGES + 20]).unwrap()).unwrap();
        assert_eq!(collected(&many).len(), MAX_MESSAGES);
    }

    #[test]
    fn a_bridge_call_cannot_be_broken_out_of() {
        let hostile = serde_json::json!({"id": "1", "command": {"action": "fill", "value": "\");alert(1);(\"</script>\u{2028}"}});
        let script = bridge_call("run", &hostile);
        // The argument is one string literal: its text parses back to the value.
        let start = script.find("b.run(").unwrap() + "b.run(".len();
        let end = script.rfind("):null").unwrap();
        let literal: String = serde_json::from_str(&script[start..end]).unwrap();
        // (`from_str` refuses text after the literal, so nothing follows it.)
        assert_eq!(serde_json::from_str::<Value>(&literal).unwrap(), hostile);
    }

    #[test]
    fn a_command_runs_only_on_the_site_it_was_allowed_for() {
        assert_eq!(wrong_site(Some("example.com"), "example.com"), None);
        assert!(wrong_site(Some("example.com"), "evil.example").unwrap().contains("evil.example"));
        assert!(wrong_site(Some("example.com"), "").unwrap().contains("another address"));
        assert!(wrong_site(None, "example.com").is_some());
    }

    #[test]
    fn a_command_checks_its_document_before_it_runs() {
        let envelope = serde_json::json!({"id": "1", "command": {"action": "snapshot", "site": "example.com"}});
        let script = run_call("example.com", &envelope);
        let guard = script.find(r#"if(h!=="example.com"&&h!=="example.com"+".")return "openagentd:moved";"#).expect("the guard");
        assert!(guard < script.find("b.run(").unwrap(), "the guard comes first: {script}");
        // A site name is one string literal, whatever it holds.
        let hostile = run_call("a\"||true||\"", &envelope);
        assert!(hostile.contains(r#"h!=="a\"||true||\""&&"#), "{hostile}");
    }

    #[test]
    fn an_address_names_its_host_and_a_page_that_did_not_load() {
        let at = |raw: &str, loading| Address { url: Url::parse(raw).ok(), loading };
        assert_eq!(at("https://WWW.Example.com./a", Some(false)).host(), "www.example.com");
        assert_eq!(at("", Some(true)).host(), "");
        assert!(at("", Some(false)).failed());
        // Still loading, loaded, or an engine that does not say: not a failure.
        assert!(!at("", Some(true)).failed());
        assert!(!at("https://example.com/", Some(false)).failed());
        assert!(!at("", None).failed());
    }

    #[test]
    fn events_carry_their_kind() {
        let event = serde_json::to_value(Envelope { id: "t1", event: ViewEvent::Load { phase: "finished", url: "https://example.com/".into() } }).unwrap();
        assert_eq!(event, serde_json::json!({"id": "t1", "kind": "load", "phase": "finished", "url": "https://example.com/"}));
        let event = serde_json::to_value(Envelope { id: "t1", event: ViewEvent::Title { title: "Example".into() } }).unwrap();
        assert_eq!(event, serde_json::json!({"id": "t1", "kind": "title", "title": "Example"}));
        let event = serde_json::to_value(Envelope { id: "t1", event: ViewEvent::Url { url: String::new(), loading: Some(false) } }).unwrap();
        assert_eq!(event, serde_json::json!({"id": "t1", "kind": "url", "url": "", "loading": false}));
        let event = serde_json::to_value(Envelope { id: "t1", event: ViewEvent::Url { url: "https://example.com/".into(), loading: None } }).unwrap();
        assert_eq!(event, serde_json::json!({"id": "t1", "kind": "url", "url": "https://example.com/"}));
    }
}
