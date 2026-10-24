use anyhow::{Context, Result};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use crate::AppState;
use crate::config::{load_window_state, window_size, SavedWindowState};
use crate::servers::ServerId;

pub const MAIN_WINDOW: &str = "main";
pub const SECONDARY_WINDOW_PREFIX: &str = "main-";

/// Zoom factor bounds and step. ``ZOOM_STEP`` is the multiplier per
/// ⌘+/⌘- press (≈20%, matching Chrome). Bounds keep the factor from
/// reaching values where the UI becomes unusable.
pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 3.0;
pub const ZOOM_STEP: f64 = 1.2;
pub const ZOOM_DEFAULT: f64 = 1.0;

pub const THROTTLE_RESUME_SCRIPT: &str = r#"
try {
    document.documentElement.removeAttribute('data-app-hidden');
    document.dispatchEvent(new Event('visibilitychange'));
} catch (_) {}
"#;
/// Apply platform-specific window chrome.
///
/// macOS uses an overlay title-bar; the React app reserves a 70 pt left
/// inset for the traffic-lights. ``traffic_light_position`` must be set
/// from Rust because the JSON config value is ignored when the window is
/// built via ``WebviewWindowBuilder``. ``y`` is a *bottom* inset (tao
/// resizes the native title-bar to ``button_height + y`` — tao 0.35.x,
/// macos/view.rs:1152); 20 pt centres against our 36 pt header.
pub fn configure_window_chrome(
    builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    #[cfg(target_os = "macos")]
    {
        use tauri::{LogicalPosition, TitleBarStyle};
        builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(12.0, 20.0))
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

pub fn show_main_window(app: &AppHandle) {
    show_target_window(app);
}

pub fn target_webview_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    // Prefer the actually focused webview over the app-global
    // `active_window_label`. During multi-window reload/bootstrap churn,
    // focus events can race just enough that the cached active label still
    // points at another window, which can make reload-driven queries briefly
    // retarget the wrong backend.
    if let Some(window) = focused_webview_window(app) {
        // The tray popup (and the island) are shell surfaces, never a
        // navigation/command target: when the popup is focused (you just
        // clicked one of its buttons), actions must fall through to the real
        // app window instead of navigating/commanding the popup itself.
        if !is_overlay_window(window.label()) {
            return Some(window);
        }
    }
    let state: tauri::State<'_, AppState> = app.state();
    let label = state.active_window_label.lock().unwrap().clone();
    if let Some(window) = app.get_webview_window(&label) {
        if !is_overlay_window(window.label()) {
            return Some(window);
        }
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        return Some(window);
    }
    app.webview_windows().into_values().find(|window| !is_overlay_window(window.label()))
}

/// The tray popup and the notch island: shell surfaces, never app windows
/// that navigate, take commands, or hold a backend config.
pub fn is_overlay_window(label: &str) -> bool {
    label == crate::tray_popup::TRAY_POPUP_WINDOW || label == crate::island::ISLAND_WINDOW
}

pub fn focused_webview_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_values().find(|window| {
        window.is_focused().unwrap_or(false)
    })
}

pub fn show_target_window(app: &AppHandle) {
    if let Some(window) = target_webview_window(app) {
        show_window(&window);
    } else {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = create_app_window(&handle, None, None).await {
                log::error!("failed to create app window: {e:#}");
            }
        });
    }
}

/// Bring one window to the front.
pub fn show_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.eval(THROTTLE_RESUME_SCRIPT);
}

static NEXT_FRONTEND_COMMAND_ID: AtomicU64 = AtomicU64::new(1);

/// `desktop-command` payload. The web runs each `id` once (see
/// `web/src/lib/desktop-commands.ts`), so repeats below are harmless and a
/// second real press right after still runs.
#[derive(Clone, Debug, serde::Serialize)]
struct FrontendCommand {
    command: String,
    id: u64,
}

fn frontend_command(command: &str) -> FrontendCommand {
    FrontendCommand {
        command: command.to_string(),
        id: NEXT_FRONTEND_COMMAND_ID.fetch_add(1, Ordering::Relaxed),
    }
}

pub fn emit_frontend_command(app: &AppHandle, command: &str) {
    show_target_window(app);
    // Only the window the command is for: every window listens, and a global
    // emit would run the command in all of them. With no window yet, one is
    // being created and a global emit reaches it.
    let label = target_webview_window(app).map(|window| window.label().to_string());
    let payload = frontend_command(command);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // If a tray command summons a just-created or still-loading webview,
        // give React a short window to mount its event listener.
        for _ in 0..5 {
            let _ = match &label {
                Some(label) => handle.emit_to(
                    EventTarget::webview_window(label.as_str()),
                    "desktop-command",
                    payload.clone(),
                ),
                None => handle.emit("desktop-command", payload.clone()),
            };
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
}

/// The Vite dev server URL a debug build loads its UI from. It must stay under
/// `build.devUrl`: Tauri counts URLs there as the app's own origin, which is
/// what grants the dev window IPC without any remote capability.
/// Built from that setting, so `-c '{"build":{"devUrl":"…:5174"}}'` moves
/// every window when 5173 is taken.
pub fn frontend_dev_url(dev_url: Option<&str>, app_id: &str, window_label: &str) -> String {
    let base = dev_url.unwrap_or(DEFAULT_DEV_URL).trim_end_matches('/');
    format!("{base}/?oa-app-id={app_id}&oa-window-id={window_label}")
}

const DEFAULT_DEV_URL: &str = "http://localhost:5173";

/// `build.devUrl` from the running config.
pub fn configured_dev_url<R: tauri::Runtime>(app: &impl Manager<R>) -> Option<String> {
    app.config().build.dev_url.as_ref().map(|url| url.to_string())
}

pub fn frontend_webview_url(app: &AppHandle, window_label: &str) -> Result<WebviewUrl> {
    // Desktop windows share a webview origin. Pass both identifiers so frontend
    // localStorage preferences remain scoped to the individual app window.
    let app_id = &app.config().identifier;
    if cfg!(debug_assertions) {
        Ok(WebviewUrl::External(
            frontend_dev_url(configured_dev_url(app).as_deref(), app_id, window_label)
                .parse()
                .context("parse dev frontend url")?,
        ))
    } else {
        Ok(WebviewUrl::App(
            format!("index.html?oa-app-id={app_id}&oa-window-id={window_label}").into(),
        ))
    }
}

// ── Script-injection guard ──────────────────────────────────────────────
// Every dynamic value interpolated into a webview script (here and in any
// `eval()` call) MUST pass through `serde_json::to_string` first. A raw
// `format!` of a user/config-derived string into JS source is an injection
// vector — the JSON encoding is what makes these interpolations literals.
pub fn frontend_init_script(token: Option<&str>, base_url: &str) -> String {
    frontend_init_script_with_path(token, base_url, None)
}

/// Define the window's identity (`__OAD_APP_ID__` / `__OAD_WINDOW_ID__`) as
/// webview globals.
///
/// These are registered as an *initialization script* (see [`build_app_window`]),
/// so they are re-applied on every document load — including reloads and the
/// reload that follows a per-window backend switch. The frontend keys window
/// state (theme preference, last route) off this identity; the URL query
/// params are only the initial-load carrier and are dropped once the SPA
/// router rewrites `window.location` to a bare route path. Without this,
/// reloaded windows lost their scope and fell back to the shared legacy key.
///
/// Both values are interpolated through `serde_json::to_string` so a
/// window label can never break out of the JS string literal.
pub fn window_identity_init_script(app_id: &str, window_label: &str) -> String {
    format!(
        "Object.defineProperty(window, '__OAD_APP_ID__', {{ value: {app_id_json}, writable: true, configurable: true }});\
Object.defineProperty(window, '__OAD_WINDOW_ID__', {{ value: {window_id_json}, writable: true, configurable: true }});",
        app_id_json = serde_json::to_string(app_id).unwrap_or_else(|_| "\"\"".into()),
        window_id_json = serde_json::to_string(window_label).unwrap_or_else(|_| "\"\"".into()),
    )
}

pub fn frontend_init_script_with_path(
    token: Option<&str>,
    base_url: &str,
    initial_path: Option<&str>,
) -> String {
    let token_define = token.map_or_else(
        || "delete window.__OAD_TOKEN__;".to_string(),
        |t| {
            format!(
                "Object.defineProperty(window, '__OAD_TOKEN__', {{ value: {token_json}, writable: true, configurable: true }});",
                token_json = serde_json::to_string(t).unwrap_or_else(|_| "\"\"".into())
            )
        },
    );
    let route_define = initial_path.map(|r| {
        format!(
            "Object.defineProperty(window, '__OAD_INITIAL_ROUTE__', {{ value: {route_json}, writable: true, configurable: true }});",
            route_json = serde_json::to_string(r).unwrap_or_else(|_| "\"\"".into())
        )
    }).unwrap_or_default();
    format!(
        "Object.defineProperty(window, '__OAD_API_BASE_URL__', {{ value: {base_json}, writable: true, configurable: true }});{token_define}{route_define}",
        base_json = serde_json::to_string(base_url).unwrap_or_else(|_| "\"\"".into())
    )
}

pub fn backend_unavailable_init_script() -> String {
    "Object.defineProperty(window, '__OAD_BACKEND_UNAVAILABLE__', { value: true, writable: true, configurable: true });Object.defineProperty(window, '__OAD_INITIAL_ROUTE__', { value: \"/\", writable: true, configurable: true });".to_string()
}

/// Marks a window the user opened with New Window. Its first load shows an
/// empty new session instead of reopening the last workspace's latest
/// session (`web/src/lib/fresh-window.ts`). Reloads ignore the flag.
pub const FRESH_WINDOW_INIT_SCRIPT: &str =
    "Object.defineProperty(window, '__OAD_FRESH_WINDOW__', { value: true, writable: true, configurable: true });";

/// The script a new window starts with, on `server` (see
/// [`crate::servers::current_server`]). Without a server, or before the
/// builtin has an address, the window opens unconnected: its loading screen
/// offers Choose Server, and it connects once a backend is up.
pub fn new_window_init_script(
    server: Option<&ServerId>,
    bundled_base_url: Option<&str>,
    desktop_token: Option<&str>,
    initial_path: Option<&str>,
) -> String {
    let initial_path = initial_path.or(Some("/"));
    match (server, bundled_base_url) {
        (Some(ServerId::External(base)), _) => frontend_init_script_with_path(None, base, initial_path),
        (Some(ServerId::Bundled), Some(base)) => frontend_init_script_with_path(desktop_token, base, initial_path),
        _ => backend_unavailable_init_script(),
    }
}

pub fn next_window_label(app: &AppHandle) -> String {
    if app.get_webview_window(MAIN_WINDOW).is_none() {
        return MAIN_WINDOW.to_string();
    }
    for i in 2.. {
        let label = format!("{SECONDARY_WINDOW_PREFIX}{i}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
    unreachable!("unbounded window-label iterator should always return")
}

/// The boot page's background (`web/index.html`) for `theme`. The window
/// shows it until the page paints, so a dark launch does not flash light.
pub fn window_background(theme: tauri::Theme) -> tauri::window::Color {
    match theme {
        tauri::Theme::Dark => tauri::window::Color(0x15, 0x11, 0x0d, 0xff),
        _ => tauri::window::Color(0xfa, 0xf6, 0xec, 0xff),
    }
}

pub async fn build_app_window(
    app: &AppHandle,
    label: String,
    init_script: String,
) -> Result<tauri::WebviewWindow> {
    let saved_size = load_window_state(app).ok().flatten();
    build_app_window_sized(app, label, init_script, saved_size).await
}

async fn build_app_window_sized(
    app: &AppHandle,
    label: String,
    init_script: String,
    saved_size: Option<SavedWindowState>,
) -> Result<tauri::WebviewWindow> {
    let url = frontend_webview_url(app, &label)?;
    // Re-applied on every document load by the webview, so the frontend keeps
    // its window identity across reloads even when `window.location` no longer
    // carries the `oa-app-id` / `oa-window-id` query params.
    let identity_script = window_identity_init_script(&app.config().identifier, &label);
    let init_script = format!("{identity_script}{init_script}");
    let initial_size = saved_size.unwrap_or(SavedWindowState {
        width: 1280,
        height: 820,
    });
    let mut config = app.config().app.windows.first()
        .cloned()
        .unwrap_or_default();
    config.label = label;
    config.url = url;
    config.drag_drop_enabled = false;
    config.visible = false;
    if let Some(size) = saved_size {
        config.width = f64::from(size.width);
        config.height = f64::from(size.height);
    } else {
        config.width = f64::from(initial_size.width);
        config.height = f64::from(initial_size.height);
    }
    let builder = WebviewWindowBuilder::from_config(app, &config)?
        .initialization_script(&init_script)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                log::info!("startup: page loaded window={} at_ms={}", webview.label(), crate::launch_ms());
                if webview.label() == MAIN_WINDOW {
                    crate::tray_popup::prewarm_tray_popup(webview.app_handle());
                }
            }
        });
    let builder = configure_window_chrome(builder);
    let win = builder.build().context("build webview window")?;
    if let Some(size) = saved_size {
        win.set_size(PhysicalSize::new(size.width, size.height))
            .ok();
    }
    let state: tauri::State<'_, AppState> = app.state();
    let zoom = state
        .window_zoom_factors
        .lock()
        .unwrap()
        .get(win.label())
        .copied()
        .unwrap_or(ZOOM_DEFAULT);
    win.set_zoom(zoom).ok();
    // Windows keeps the app menu for keyboard accelerators, but the native
    // OpenAgentd/File/Edit/View/Window bar duplicates the in-app chrome.
    #[cfg(target_os = "windows")]
    win.hide_menu().context("hide Windows application menu")?;
    // The UI follows the system theme unless the user picked one, so the
    // system appearance is the best guess before the page has painted.
    let theme = win.theme().ok();
    if let Some(theme) = theme {
        win.set_background_color(Some(window_background(theme))).ok();
    }
    win.show().context("show window")?;
    win.set_focus().ok();
    log::info!("startup: window shown window={} theme={theme:?} at_ms={}", win.label(), crate::launch_ms());
    Ok(win)
}

pub async fn create_app_window(
    app: &AppHandle,
    label: Option<&str>,
    initial_path: Option<&str>,
) -> Result<tauri::WebviewWindow> {
    create_app_window_with(app, label, initial_path, false).await
}

/// New Window: a window that opens on an empty new session.
pub async fn create_fresh_app_window(app: &AppHandle) -> Result<tauri::WebviewWindow> {
    create_app_window_with(app, None, None, true).await
}

async fn create_app_window_with(
    app: &AppHandle,
    label: Option<&str>,
    initial_path: Option<&str>,
    fresh: bool,
) -> Result<tauri::WebviewWindow> {
    let state: tauri::State<'_, AppState> = app.state();
    let bundled_base_url = state.backend_base_url.lock().await.clone();
    let desktop_token = state.desktop_token.lock().await.clone();
    // The server of the window you are in, else the builtin while it runs.
    // Never a saved server: those connect only when you choose one.
    let bundled_running = crate::servers::bundled_running(app).await;
    let server = crate::servers::current_server(
        crate::servers::active_app_window(app).as_deref(),
        &crate::servers::external_map(app),
        bundled_running,
    );
    let mut init_script = new_window_init_script(
        server.as_ref(),
        bundled_base_url.as_deref(),
        desktop_token.as_deref(),
        initial_path,
    );
    if fresh {
        init_script.push_str(FRESH_WINDOW_INIT_SCRIPT);
    }
    let window_label = label
        .map(str::to_string)
        .unwrap_or_else(|| next_window_label(app));
    // Register an external server under the new window's own label *before*
    // its frontend bootstraps: `app_backend_status` reads it, and would
    // otherwise report the builtin and override the injected URL. The script
    // and this entry come from the same `server`, so they cannot disagree.
    if let Some(ServerId::External(base)) = server {
        state
            .window_backend_base_urls
            .lock()
            .unwrap()
            .insert(window_label.clone(), base);
    }
    // Open at the size of the window you are in, like a browser does; the
    // size saved on the last close/quit is the fallback when none is open.
    let size = target_webview_window(app)
        .and_then(|window| window_size(&window))
        .or_else(|| load_window_state(app).ok().flatten());
    build_app_window_sized(app, window_label, init_script, size).await
}

pub fn target_window_label(app: &AppHandle) -> String {
    let state: tauri::State<'_, AppState> = app.state();
    let label = state.active_window_label.lock().unwrap().clone();
    label
}

/// Multiply the active window's zoom factor by ``factor`` and apply it,
/// clamping to ``[ZOOM_MIN, ZOOM_MAX]`` so the user can't shrink the UI to
/// nothing or blow it up past readable.
pub fn adjust_zoom(app: &AppHandle, factor: f64) {
    let label = target_window_label(app);
    set_window_zoom(app, &label, move |current| current * factor);
}

pub fn set_zoom(app: &AppHandle, value: f64) {
    let label = target_window_label(app);
    set_window_zoom(app, &label, move |_| value);
}

pub fn set_window_zoom(app: &AppHandle, label: &str, update: impl FnOnce(f64) -> f64) {
    // Synchronous: the zoom map is a plain std mutex, so a ⌘+/⌘- press
    // applies immediately from the menu handler instead of taking a
    // spawn → lock → apply detour through the async runtime.
    let state: tauri::State<'_, AppState> = app.state();
    let next = {
        let mut guard = state.window_zoom_factors.lock().unwrap();
        let current = *guard.get(label).unwrap_or(&ZOOM_DEFAULT);
        let next = update(current).clamp(ZOOM_MIN, ZOOM_MAX);
        guard.insert(label.to_string(), next);
        next
    };
    apply_zoom_to_window(app, label, next);
}

pub fn apply_zoom_to_window(app: &AppHandle, label: &str, factor: f64) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(e) = window.set_zoom(factor) {
            log::warn!("set_zoom({factor}) failed for {}: {e}", window.label());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_commands_carry_a_fresh_id() {
        let first = frontend_command("terminal");
        let second = frontend_command("terminal");
        assert!(second.id > first.id);
        let json = serde_json::to_value(&first).unwrap();
        assert_eq!(json["command"], "terminal");
        assert_eq!(json["id"], first.id);
    }

    #[test]
    fn window_identity_script_defines_both_globals() {
        let script = window_identity_init_script("com.openagentd.desktop", "main-2");

        assert!(script.contains("__OAD_APP_ID__"));
        assert!(script.contains("__OAD_WINDOW_ID__"));
        assert!(script.contains("\"com.openagentd.desktop\""));
        assert!(script.contains("\"main-2\""));
    }

    #[test]
    fn window_identity_script_json_escapes_labels() {
        // A label containing quotes/backslashes must stay a valid JS string
        // literal — `serde_json::to_string` is what guarantees it.
        let script = window_identity_init_script("app", "main\"; alert(1); //");

        assert!(script.contains(r#""main\"; alert(1); //""#));
        assert!(!script.contains(r#"value: "main";"#));
    }

    // The web reads exactly this global (`web/src/lib/fresh-window.ts`).
    #[test]
    fn fresh_window_script_defines_the_web_flag() {
        assert!(FRESH_WINDOW_INIT_SCRIPT.contains("'__OAD_FRESH_WINDOW__', { value: true,"));
    }

    // Release windows load the bundled UI (`frontend_webview_url`) and debug
    // windows a URL under `devUrl`; Tauri counts both as the app's own
    // origin, so no other origin needs IPC. Each remote URL pattern is also
    // compiled once per allowed command at launch: twelve of them cost
    // ~380 ms.
    #[test]
    fn capability_grants_ipc_to_the_app_origin_only() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(capability.get("remote").is_none(), "remote origins granted IPC: {}", capability["remote"]);
    }

    #[test]
    fn dev_window_url_stays_under_dev_url() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let dev_url = config["build"]["devUrl"].as_str().expect("build.devUrl");
        let url = frontend_dev_url(Some(dev_url), "app", "main");
        assert!(
            url.starts_with(&format!("{}/", dev_url.trim_end_matches('/'))),
            "{url} is outside devUrl {dev_url}, so the dev window would get no IPC",
        );
        let moved = frontend_dev_url(Some("http://localhost:5174/"), "app", "main");
        assert!(moved.starts_with("http://localhost:5174/?"), "{moved} ignores an overridden devUrl");
    }

    // The page paints ~150 ms after the window shows; until then the window
    // shows its own background, so it must be the boot page's in each theme.
    #[test]
    fn window_background_matches_the_boot_page_in_both_themes() {
        let html = include_str!("../../../web/index.html").to_ascii_lowercase();
        let hex = |c: tauri::window::Color| format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2);
        let light = hex(window_background(tauri::Theme::Light));
        let dark = hex(window_background(tauri::Theme::Dark));
        assert!(html.contains(&format!("background: {light};")), "light {light} is not the boot page's");
        assert!(html.contains(&format!("background: {dark};")), "dark {dark} is not the boot page's");
        assert_ne!(light, dark);
    }
}
