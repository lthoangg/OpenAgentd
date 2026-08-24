use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use crate::AppState;
use crate::config::{load_window_state, SavedWindowState};

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

pub const THROTTLE_PAUSE_SCRIPT: &str = r#"
try {
    document.documentElement.setAttribute('data-app-hidden', 'true');
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
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval(THROTTLE_RESUME_SCRIPT);
    }
}

pub fn target_webview_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    // Prefer the actually focused webview over the app-global
    // `active_window_label`. During multi-window reload/bootstrap churn,
    // focus events can race just enough that the cached active label still
    // points at another window, which can make reload-driven queries briefly
    // retarget the wrong backend.
    if let Some(window) = focused_webview_window(app) {
        return Some(window);
    }
    let state: tauri::State<'_, AppState> = app.state();
    let label = state.active_window_label.lock().unwrap().clone();
    app.get_webview_window(&label)
        .or_else(|| app.get_webview_window(MAIN_WINDOW))
}

pub fn focused_webview_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_values().find(|window| {
        window.is_focused().unwrap_or(false)
    })
}

pub fn show_target_window(app: &AppHandle) {
    if let Some(window) = target_webview_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval(THROTTLE_RESUME_SCRIPT);
    } else {
        show_main_window(app);
    }
}

pub fn navigate_main_window(app: &AppHandle, path: &str) {
    show_target_window(app);
    if let Some(window) = target_webview_window(app) {
        let path_json = serde_json::to_string(path).unwrap_or_else(|_| "\"/\"".into());
        let _ = window.eval(format!("window.location.assign({path_json});"));
    }
}

pub fn emit_frontend_command(app: &AppHandle, command: &str) {
    show_target_window(app);
    let command = command.to_string();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // If a tray command summons a just-created or still-loading webview,
        // give React a short window to mount its event listener.
        for _ in 0..5 {
            let _ = handle.emit("desktop-command", command.as_str());
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
}

pub fn frontend_webview_url(app: &AppHandle, window_label: &str) -> Result<WebviewUrl> {
    // Desktop windows share a webview origin. Pass both identifiers so frontend
    // localStorage preferences remain scoped to the individual app window.
    let app_id = &app.config().identifier;
    if cfg!(debug_assertions) {
        Ok(WebviewUrl::External(
            format!("http://localhost:5173/?oa-app-id={app_id}&oa-window-id={window_label}")
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
    "Object.defineProperty(window, '__OAD_BACKEND_UNAVAILABLE__', { value: true, writable: true, configurable: true });Object.defineProperty(window, '__OAD_INITIAL_ROUTE__', { value: \"/coding\", writable: true, configurable: true });".to_string()
}

pub fn new_window_init_script(
    bundled_base_url: Option<&str>,
    desktop_token: Option<&str>,
    external_window_base_urls: &HashMap<String, String>,
    active_window_label: &str,
    initial_path: Option<&str>,
) -> Result<String> {
    let initial_path = initial_path.or(Some("/coding"));
    if let Some(base) = external_window_base_urls.get(active_window_label) {
        return Ok(frontend_init_script_with_path(None, base, initial_path));
    }
    if let Some(base) = bundled_base_url {
        return Ok(frontend_init_script_with_path(
            desktop_token,
            base,
            initial_path,
        ));
    }
    if let Some(base) = external_window_base_urls.get(MAIN_WINDOW) {
        return Ok(frontend_init_script_with_path(None, base, initial_path));
    }
    Err(anyhow!("backend is not ready"))
}

pub fn next_window_label(app: &AppHandle) -> String {
    for i in 2.. {
        let label = format!("{SECONDARY_WINDOW_PREFIX}{i}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
    unreachable!("unbounded window-label iterator should always return")
}

pub async fn build_app_window(
    app: &AppHandle,
    label: String,
    init_script: String,
) -> Result<tauri::WebviewWindow> {
    let url = frontend_webview_url(app, &label)?;
    let saved_size = load_window_state(app).ok().flatten();
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
        .initialization_script(&init_script);
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
    win.show().context("show window")?;
    win.set_focus().ok();
    Ok(win)
}

/// Resolve the external backend a freshly created window should inherit, if
/// any. Mirrors the precedence used by [`new_window_init_script`]: prefer the
/// active window's external backend, then fall back to the main window's
/// external backend. Returns `None` when the new window should use the bundled
/// sidecar.
pub fn inherited_external_base_url(
    external_window_base_urls: &HashMap<String, String>,
    active_window_label: &str,
) -> Option<String> {
    external_window_base_urls
        .get(active_window_label)
        .or_else(|| external_window_base_urls.get(MAIN_WINDOW))
        .cloned()
}

pub async fn create_app_window(
    app: &AppHandle,
    label: Option<&str>,
    initial_path: Option<&str>,
) -> Result<tauri::WebviewWindow> {
    let state: tauri::State<'_, AppState> = app.state();
    let bundled_base_url = state.backend_base_url.lock().await.clone();
    let desktop_token = state.desktop_token.lock().await.clone();
    let external_window_base_urls = state.window_backend_base_urls.lock().unwrap().clone();
    let active_window_label = state.active_window_label.lock().unwrap().clone();
    let init_script = new_window_init_script(
        bundled_base_url.as_deref(),
        desktop_token.as_deref(),
        &external_window_base_urls,
        &active_window_label,
        initial_path,
    )?;
    let inherited_external =
        inherited_external_base_url(&external_window_base_urls, &active_window_label);
    let window_label = label
        .map(str::to_string)
        .unwrap_or_else(|| next_window_label(app));
    // When the new window inherits an external backend, register it under the
    // new window's own label *before* its frontend bootstraps. Otherwise
    // `app_backend_status` would report the bundled backend for this label,
    // overwriting the injected external base URL — and, when no bundled sidecar
    // is running, the window would stay stuck on the loading screen because
    // `sidecar_running` never becomes true.
    if let Some(base) = inherited_external {
        state
            .window_backend_base_urls
            .lock()
            .unwrap()
            .insert(window_label.clone(), base);
    }
    build_app_window(app, window_label, init_script).await
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
