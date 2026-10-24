//! Custom webview tray popup (macOS).
//!
//! Tauri's native ``Menu``/``MenuItem`` maps to native OS menus, which cannot
//! be styled with CSS — a plain-text ceiling for a usage/status surface. On
//! macOS the tray instead toggles a small borderless, always-on-top webview
//! window anchored under the tray icon, rendered by the shared React web
//! bundle (``web/tray.html``). Windows/Linux keep the native tray menu
//! (see ``menu::install_native_tray``).
//!
//! The popup never receives the backend token: it talks to the backend only
//! indirectly, through IPC commands that run in the Rust process (which owns
//! the credential). ``get_tray_usage_summary`` hands back the cached snapshot
//! the usage poll loop maintains, and refreshes it in the background.
//!
//! "Auto" is the server the app is on: the active window's, else the
//! builtin (``servers::current_server``), never a saved server on its own.
//! Its name, numbers and error all come from that one server, so the label
//! can't name one server over another's numbers.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::AppState;
use crate::servers::{ServerId, BUNDLED_KEY};

pub const TRAY_POPUP_WINDOW: &str = "tray-popup";

/// What the popup calls the builtin sidecar.
const BUNDLED_NAME: &str = "Local Bundled";
const AUTO_ID: &str = "auto";
const NO_SERVER_NAME: &str = "No Server Connected";

/// Event emitted right before the popup is shown so the (long-lived, hidden)
/// webview knows to refetch usage instead of showing a stale snapshot.
pub const TRAY_POPUP_REFRESH_EVENT: &str = "tray-popup-refresh";

/// The popup's own Esc: hide it without running a menu command.
const TRAY_HIDE_ACTION: &str = "hide";

/// Popup width, and the bounds of its height. The webview reports its
/// content height through ``tray_fit``; past the max its list scrolls, and
/// ``tray.css`` caps the surface at the same 600px.
const TRAY_WIDTH: f64 = 360.0;
const TRAY_MIN_HEIGHT: f64 = 160.0;
const TRAY_MAX_HEIGHT: f64 = 600.0;

/// How long after the main window's page loads the popup is built, so its
/// own page load does not compete with the main window's.
#[cfg(target_os = "macos")]
const PREWARM_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

/// How long a saved server's probe result counts as current. An older
/// result is still shown, and the server is re-probed in the background.
const AVAILABILITY_TTL: Duration = Duration::from_secs(30);

/// Minimum gap between the background usage refreshes that opening the
/// popup starts. The Refresh button bypasses it.
const USAGE_OPEN_REFRESH_GAP: Duration = Duration::from_secs(30);

/// What the popup remembers between opens, so an open answers at once.
/// Without it every open waited for a health probe of each saved server,
/// which is the full 2 s timeout for one that drops packets (a VPN address
/// while off the VPN).
#[derive(Default)]
struct TrayCache {
    /// Saved server base URL → (reachable, when that was decided).
    availability: HashMap<String, (bool, Instant)>,
    last_usage_refresh: Option<Instant>,
}

#[derive(Debug, Default)]
struct ProbePlan {
    /// Never probed: probe before answering.
    probe_now: Vec<String>,
    /// Known but past the TTL: answer with the old result, re-probe after.
    revalidate: Vec<String>,
}

impl TrayCache {
    fn plan_probes(&mut self, urls: &[String], now: Instant) -> ProbePlan {
        let mut plan = ProbePlan::default();
        for url in urls {
            match self.availability.get_mut(url) {
                None => plan.probe_now.push(url.clone()),
                Some((_, at)) if now.duration_since(*at) >= AVAILABILITY_TTL => {
                    // Claim the re-probe so an overlapping open doesn't repeat it.
                    *at = now;
                    plan.revalidate.push(url.clone());
                }
                Some(_) => {}
            }
        }
        plan
    }

    /// Store a probe result; true when it changes what the popup shows.
    fn record_probe(&mut self, url: &str, alive: bool, now: Instant) -> bool {
        let previous = self.availability.insert(url.to_string(), (alive, now));
        previous.map(|(was, _)| was) != Some(alive)
    }

    fn is_available(&self, url: &str) -> bool {
        self.availability.get(url).is_some_and(|(alive, _)| *alive)
    }

    /// True (and the slot taken) when a popup open may refresh usage now.
    fn claim_usage_refresh(&mut self, now: Instant) -> bool {
        let due = self
            .last_usage_refresh
            .map_or(true, |last| now.duration_since(last) >= USAGE_OPEN_REFRESH_GAP);
        if due {
            self.last_usage_refresh = Some(now);
        }
        due
    }
}

fn tray_cache() -> &'static Mutex<TrayCache> {
    static CACHE: OnceLock<Mutex<TrayCache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Whether two snapshots show the same numbers. The backend's ``cached``
/// flag flips between identical bodies, so it doesn't count.
fn same_reading(
    a: Option<&crate::usage::UsageSummaryBody>,
    b: Option<&crate::usage::UsageSummaryBody>,
) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.checked_at == b.checked_at && a.items == b.items,
        (None, None) => true,
        _ => false,
    }
}

type Reading = (Option<crate::usage::UsageSummaryBody>, Option<String>);

/// Whether the popup would show the same thing for two readings.
fn same_view(a: &Reading, b: &Reading) -> bool {
    same_reading(a.0.as_ref(), b.0.as_ref()) && a.1 == b.1
}

/// The picker's options. "Auto" leads when there is a choice to make, and
/// also when Auto's server is not among the live ones: a single live server
/// would otherwise lock the picker on Auto's offline one.
fn picker_servers(
    available: Vec<crate::usage::TrayServerOption>,
    auto: Option<&ServerId>,
    auto_name: &str,
) -> Vec<crate::usage::TrayServerOption> {
    let auto_offline = auto.is_some_and(|server| {
        !available.iter().any(|option| match server {
            ServerId::Bundled => option.id == BUNDLED_KEY,
            ServerId::External(_) => option.id != BUNDLED_KEY && ServerId::external(&option.id) == *server,
        })
    });
    let mut servers = Vec::new();
    if available.len() > 1 || (auto_offline && !available.is_empty()) {
        servers.push(crate::usage::TrayServerOption {
            id: AUTO_ID.to_string(),
            name: "Auto (Active Window)".to_string(),
            detail: auto.map(|_| auto_name.to_string()),
        });
    }
    servers.extend(available);
    servers
}

/// Probe saved servers concurrently and record the results. Returns true
/// when any result changed.
async fn probe_servers(urls: Vec<String>) -> bool {
    let mut join_set = tokio::task::JoinSet::new();
    for base_url in urls {
        join_set.spawn(async move {
            let alive = crate::usage::is_server_available(&base_url).await;
            (base_url, alive)
        });
    }
    let mut changed = false;
    while let Some(res) = join_set.join_next().await {
        if let Ok((url, alive)) = res {
            changed |= tray_cache().lock().unwrap().record_probe(&url, alive, Instant::now());
        }
    }
    changed
}

/// Ask the popup to load again after a background refresh changed what it
/// shows. A hidden popup reloads on its next open anyway. The second load
/// finds everything fresh, so it starts no further refresh.
fn notify_popup(app: &AppHandle) {
    let visible = app
        .get_webview_window(TRAY_POPUP_WINDOW)
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        let _ = app.emit_to(TRAY_POPUP_WINDOW, TRAY_POPUP_REFRESH_EVENT, ());
    }
}

/// The borderless popup window, built on first use. It starts hidden and
/// stays alive (mounted) so toggling is cheap; the webview refetches on
/// every ``TRAY_POPUP_REFRESH_EVENT``.
///
/// Call it on the main thread only: the tray click and the prewarm both run
/// there, so the check and the build cannot race.
#[cfg(target_os = "macos")]
pub fn ensure_tray_popup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(TRAY_POPUP_WINDOW) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        TRAY_POPUP_WINDOW,
        WebviewUrl::App("tray.html".into()),
    )
    .title("OpenAgentd")
    // The webview fits it to its content (tray_fit) once it has rendered.
    .inner_size(TRAY_WIDTH, 480.0)
    .visible(false)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .shadow(true)
    // Requires the ``macos-private-api`` feature; transparent lets the CSS
    // draw rounded frosted corners instead of a rectangular webview.
    .transparent(true)
    .build()?;

    let hide_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = hide_window.hide();
        }
    });
    log::info!("startup: tray popup built at_ms={}", crate::launch_ms());
    Ok(window)
}

/// Build the popup shortly after the main window has loaded, so a first
/// tray click finds it ready. Building it during `setup` held the main
/// window back by ~50 ms of main-thread work.
pub fn prewarm_tray_popup(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PREWARM_DELAY).await;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(e) = ensure_tray_popup(&handle) {
                    log::warn!("tray popup prewarm failed: {e:#}");
                }
            });
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Toggle the popup open/closed, anchored under the tray icon.
#[cfg(target_os = "macos")]
pub fn toggle_tray_popup(app: &AppHandle) {
    use tauri_plugin_positioner::WindowExt;

    let window = match ensure_tray_popup(app) {
        Ok(window) => window,
        Err(e) => {
            log::warn!("tray popup unavailable: {e:#}");
            return;
        }
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    // The window stays mounted while hidden, so tell its React root to
    // refetch usage before we bring it up.
    let _ = app.emit(TRAY_POPUP_REFRESH_EVENT, ());
    let _ = window.move_window(tauri_plugin_positioner::Position::TrayBottomCenter);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Return the usage snapshot the popup renders along with the list of
/// available servers and the currently selected server.
#[tauri::command]
pub async fn get_tray_usage_summary(
    app: AppHandle,
    force: Option<bool>,
    target_server: Option<String>,
) -> Result<crate::usage::TrayUsageResult, String> {
    let state: tauri::State<'_, AppState> = app.state();
    let saved_config = crate::config::load_app_backend_config(&app).unwrap_or_default();
    let bundled_base = state.backend_base_url.lock().await.clone();
    let desktop_token = state.desktop_token.lock().await.clone();
    let sidecar_alive = {
        let mut guard = state.sidecar.lock().await;
        guard.as_mut().is_some_and(|s| s.is_alive())
    };

    // Keep only saved servers that are online. Only a server never probed
    // is waited on; a known one is answered from the cache and re-probed in
    // the background once its result is older than the TTL.
    let urls: Vec<String> = saved_config.servers.iter().map(|s| s.base_url.clone()).collect();
    let plan = tray_cache().lock().unwrap().plan_probes(&urls, Instant::now());
    if !plan.probe_now.is_empty() {
        probe_servers(plan.probe_now).await;
    }
    if !plan.revalidate.is_empty() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if probe_servers(plan.revalidate).await {
                notify_popup(&app);
            }
        });
    }
    let mut available_urls = HashSet::new();
    {
        let cache = tray_cache().lock().unwrap();
        for url in urls.into_iter().filter(|url| cache.is_available(url)) {
            if let Ok(norm) = crate::config::normalize_external_base_url(&url) {
                available_urls.insert(norm);
            }
            available_urls.insert(url);
        }
    }

    // "Auto": the server the app is on, named and read from the same place.
    let auto = crate::servers::app_current_server(&app).await;
    let (active_name, active_id) = match &auto {
        Some(server) => (server.display_name(BUNDLED_NAME, &saved_config.servers), server.key().to_string()),
        None => (NO_SERVER_NAME.to_string(), AUTO_ID.to_string()),
    };

    let mut available_servers = Vec::new();

    if sidecar_alive {
        available_servers.push(crate::usage::TrayServerOption {
            id: BUNDLED_KEY.to_string(),
            name: BUNDLED_NAME.to_string(),
            detail: None,
        });
    }

    for server in &saved_config.servers {
        if available_urls.contains(&server.base_url) {
            let name = server.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| crate::usage::extract_host_port(&server.base_url));
            let host_port = crate::usage::extract_host_port(&server.base_url);
            available_servers.push(crate::usage::TrayServerOption {
                id: server.base_url.clone(),
                name,
                detail: Some(host_port),
            });
        }
    }

    let servers = picker_servers(available_servers, auto.as_ref(), &active_name);

    let mut selected = target_server.unwrap_or_else(|| AUTO_ID.to_string());
    if selected != AUTO_ID && !servers.iter().any(|s| s.id == selected) {
        selected = AUTO_ID.to_string();
    }

    if selected == AUTO_ID {
        let Some(server) = auto else {
            return Ok(crate::usage::TrayUsageResult {
                summary: None,
                server_name: active_name,
                server_id: active_id,
                servers,
                selected_server_id: AUTO_ID.to_string(),
                error: Some("No server is connected.".to_string()),
            });
        };
        let force = force.unwrap_or(false);
        let cached = state.usage.lock().await.reading(&server);
        let (summary, error) = match cached {
            // Answer with the snapshot now; refresh behind it at most every
            // USAGE_OPEN_REFRESH_GAP and reload the popup if it changed.
            (Some(_), _) if !force => {
                if tray_cache().lock().unwrap().claim_usage_refresh(Instant::now()) {
                    let app = app.clone();
                    let before = cached.clone();
                    let server = server.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::menu::refresh_server_usage(&app, &server, false).await;
                        let after = app.state::<AppState>().usage.lock().await.reading(&server);
                        if !same_view(&before, &after) {
                            notify_popup(&app);
                        }
                    });
                }
                cached
            }
            // Nothing to show yet, or the Refresh button: wait for the fetch.
            _ => {
                tray_cache().lock().unwrap().claim_usage_refresh(Instant::now());
                let _ = crate::menu::refresh_server_usage(&app, &server, force).await;
                state.usage.lock().await.reading(&server)
            }
        };
        return Ok(crate::usage::TrayUsageResult {
            summary,
            server_name: active_name,
            server_id: active_id,
            servers,
            selected_server_id: AUTO_ID.to_string(),
            error,
        });
    }

    if selected == BUNDLED_KEY {
        let name = BUNDLED_NAME.to_string();
        if let Some(base) = bundled_base {
            match crate::usage::fetch_usage_summary(&base, desktop_token.as_deref(), force.unwrap_or(false)).await {
                Ok(summary) => Ok(crate::usage::TrayUsageResult {
                    summary: Some(summary),
                    server_name: name,
                    server_id: BUNDLED_KEY.to_string(),
                    servers,
                    selected_server_id: BUNDLED_KEY.to_string(),
                    error: None,
                }),
                Err(err) => Ok(crate::usage::TrayUsageResult {
                    summary: None,
                    server_name: name,
                    server_id: BUNDLED_KEY.to_string(),
                    servers,
                    selected_server_id: BUNDLED_KEY.to_string(),
                    error: Some(format!("{err:#}")),
                }),
            }
        } else {
            Ok(crate::usage::TrayUsageResult {
                summary: None,
                server_name: name,
                server_id: BUNDLED_KEY.to_string(),
                servers,
                selected_server_id: BUNDLED_KEY.to_string(),
                error: Some("Local bundled backend is not running".to_string()),
            })
        }
    } else {
        let base_url = selected.clone();
        let name = crate::usage::resolve_server_display_name(&base_url, &saved_config.servers);
        let access_key = crate::menu::external_usage_access_key(
            crate::commands::secure_get_access_key(base_url.clone()).await,
        );
        match crate::usage::fetch_usage_summary(&base_url, access_key.as_deref(), force.unwrap_or(false)).await {
            Ok(summary) => Ok(crate::usage::TrayUsageResult {
                summary: Some(summary),
                server_name: name,
                server_id: base_url.clone(),
                servers,
                selected_server_id: base_url,
                error: None,
            }),
            Err(err) => Ok(crate::usage::TrayUsageResult {
                summary: None,
                server_name: name,
                server_id: base_url.clone(),
                servers,
                selected_server_id: base_url,
                error: Some(format!("{err:#}")),
            }),
        }
    }
}

/// The native menu command a popup action runs; ``hide`` runs none.
fn menu_command(action: &str) -> Option<&str> {
    (action != TRAY_HIDE_ACTION).then_some(action)
}

/// Dispatch a popup action by the same id strings the native menu uses
/// (``show``, ``new_session``, ``settings``, ``usage_manage``, ``quit``,
/// ...), then close the popup — a menu closes after an item fires. ``hide``
/// only closes it (Esc).
#[tauri::command]
pub fn tray_action(app: AppHandle, action: String) {
    if let Some(command) = menu_command(&action) {
        crate::menu::handle_desktop_menu(&app, command);
    }
    if let Some(window) = app.get_webview_window(TRAY_POPUP_WINDOW) {
        let _ = window.hide();
    }
}

/// The window height for a popup whose content is ``requested`` px tall.
fn popup_height(requested: f64) -> f64 {
    if requested.is_finite() {
        requested.clamp(TRAY_MIN_HEIGHT, TRAY_MAX_HEIGHT)
    } else {
        TRAY_MIN_HEIGHT
    }
}

/// Size the popup window to its content, then put it back under the tray
/// icon: macOS keeps a window's bottom edge when it resizes, so without the
/// re-anchor a taller popup would grow up over the menu bar. Only the popup
/// may call it.
#[tauri::command]
pub fn tray_fit(window: WebviewWindow, height: f64) {
    if window.label() != TRAY_POPUP_WINDOW {
        return;
    }
    let size = tauri::LogicalSize::new(TRAY_WIDTH, popup_height(height));
    if let Err(e) = window.set_size(size) {
        log::warn!("tray popup resize failed: {e:#}");
        return;
    }
    #[cfg(target_os = "macos")]
    if window.is_visible().unwrap_or(false) {
        use tauri_plugin_positioner::WindowExt;
        let _ = window.move_window(tauri_plugin_positioner::Position::TrayBottomCenter);
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn urls(list: &[&str]) -> Vec<String> {
        list.iter().map(|u| u.to_string()).collect()
    }

    #[test]
    fn a_server_never_probed_is_probed_before_answering() {
        let mut cache = TrayCache::default();
        let plan = cache.plan_probes(&urls(&["http://a", "http://b"]), Instant::now());
        assert_eq!(plan.probe_now, urls(&["http://a", "http://b"]));
        assert!(plan.revalidate.is_empty());
    }

    #[test]
    fn a_fresh_result_is_answered_without_probing() {
        let mut cache = TrayCache::default();
        let t0 = Instant::now();
        cache.record_probe("http://a", true, t0);
        let plan = cache.plan_probes(&urls(&["http://a"]), t0 + Duration::from_secs(5));
        assert!(plan.probe_now.is_empty());
        assert!(plan.revalidate.is_empty());
        assert!(cache.is_available("http://a"));
    }

    #[test]
    fn a_stale_result_is_answered_and_reprobed_once_in_the_background() {
        let mut cache = TrayCache::default();
        let t0 = Instant::now();
        cache.record_probe("http://a", true, t0);
        let later = t0 + AVAILABILITY_TTL + Duration::from_secs(1);

        let plan = cache.plan_probes(&urls(&["http://a"]), later);
        assert!(plan.probe_now.is_empty(), "a known server never holds the popup up");
        assert_eq!(plan.revalidate, urls(&["http://a"]));
        assert!(cache.is_available("http://a"), "the old result is served meanwhile");

        let again = cache.plan_probes(&urls(&["http://a"]), later);
        assert!(again.revalidate.is_empty(), "an overlapping open must not probe it again");
    }

    #[test]
    fn recording_reports_whether_the_popup_would_change() {
        let mut cache = TrayCache::default();
        let t0 = Instant::now();
        assert!(cache.record_probe("http://a", false, t0), "first result");
        assert!(!cache.record_probe("http://a", false, t0), "same result");
        assert!(cache.record_probe("http://a", true, t0), "came online");
    }

    #[test]
    fn background_usage_refreshes_are_spaced_out() {
        let mut cache = TrayCache::default();
        let t0 = Instant::now();
        assert!(cache.claim_usage_refresh(t0));
        assert!(!cache.claim_usage_refresh(t0 + Duration::from_secs(10)));
        assert!(cache.claim_usage_refresh(t0 + USAGE_OPEN_REFRESH_GAP));
    }

    #[test]
    fn a_reading_ignores_the_backend_cached_flag() {
        let a = crate::usage::UsageSummaryBody { items: vec![], checked_at: 5, cached: false };
        let b = crate::usage::UsageSummaryBody { cached: true, ..a.clone() };
        let c = crate::usage::UsageSummaryBody { checked_at: 6, ..a.clone() };
        assert!(same_reading(Some(&a), Some(&b)));
        assert!(!same_reading(Some(&a), Some(&c)));
        assert!(!same_reading(None, Some(&a)));
    }

    #[test]
    fn the_popup_height_follows_its_content_within_bounds() {
        assert_eq!(popup_height(312.0), 312.0);
        assert_eq!(popup_height(40.0), TRAY_MIN_HEIGHT);
        assert_eq!(popup_height(2_000.0), TRAY_MAX_HEIGHT);
        assert_eq!(popup_height(f64::NAN), TRAY_MIN_HEIGHT);
    }

    #[test]
    fn hide_only_closes_the_popup_and_every_other_action_is_a_menu_command() {
        assert_eq!(menu_command(TRAY_HIDE_ACTION), None);
        assert_eq!(menu_command("settings"), Some("settings"));
        assert_eq!(menu_command("quit"), Some("quit"));
    }

    fn option(id: &str, name: &str) -> crate::usage::TrayServerOption {
        crate::usage::TrayServerOption { id: id.into(), name: name.into(), detail: None }
    }

    fn ids(servers: &[crate::usage::TrayServerOption]) -> Vec<&str> {
        servers.iter().map(|s| s.id.as_str()).collect()
    }

    // With Auto's server down and only the builtin answering, the picker
    // used to hold one option and lock. Auto must stay beside it.
    #[test]
    fn an_offline_auto_server_keeps_the_picker_open() {
        let remote = ServerId::External("http://192.168.1.30:4082".into());
        let servers = picker_servers(vec![option(BUNDLED_KEY, BUNDLED_NAME)], Some(&remote), "LAN server");
        assert_eq!(ids(&servers), [AUTO_ID, BUNDLED_KEY]);
        assert_eq!(servers[0].detail.as_deref(), Some("LAN server"));
    }

    #[test]
    fn a_single_live_server_that_is_auto_needs_no_picker() {
        let servers = picker_servers(vec![option(BUNDLED_KEY, BUNDLED_NAME)], Some(&ServerId::Bundled), BUNDLED_NAME);
        assert_eq!(ids(&servers), [BUNDLED_KEY]);

        let remote = ServerId::External("http://192.168.1.30:4082".into());
        let servers = picker_servers(vec![option("http://192.168.1.30:4082/", "LAN server")], Some(&remote), "LAN server");
        assert_eq!(ids(&servers), ["http://192.168.1.30:4082/"], "saved URLs compare normalized");
    }

    #[test]
    fn two_live_servers_offer_auto_first() {
        let available = vec![option(BUNDLED_KEY, BUNDLED_NAME), option("http://192.168.1.30:4082", "LAN server")];
        assert_eq!(ids(&picker_servers(available, None, NO_SERVER_NAME)), [AUTO_ID, BUNDLED_KEY, "http://192.168.1.30:4082"]);
    }

    #[test]
    fn the_popup_reloads_when_only_the_error_changed() {
        let body = crate::usage::UsageSummaryBody { items: vec![], checked_at: 5, cached: false };
        let ok: Reading = (Some(body.clone()), None);
        let failed: Reading = (Some(body), Some("timed out".into()));
        assert!(same_view(&ok, &ok.clone()));
        assert!(!same_view(&ok, &failed));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn the_popup_is_built_on_first_use_and_reused() {
        let app = tauri::test::mock_app();
        assert!(app.get_webview_window(TRAY_POPUP_WINDOW).is_none());

        let first = ensure_tray_popup(app.handle()).unwrap();
        let second = ensure_tray_popup(app.handle()).unwrap();

        assert_eq!(first.label(), TRAY_POPUP_WINDOW);
        assert_eq!(second.label(), TRAY_POPUP_WINDOW);
        assert_eq!(app.webview_windows().len(), 1);
    }
}
