//! Web preview for windows connected to a remote server.
//!
//! A server's preview listeners bind *its* loopback, so a window on another
//! computer cannot frame them. The relay (`openagentd_shell_core::
//! preview_relay`) listens on this computer's 127.0.0.1 and tunnels each
//! connection to the window's server with the access key, which never
//! reaches the previewed page. Bundled-backend windows frame the listener
//! directly and never call these commands. Relays are scoped per window and
//! close with it, or when it changes server.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use openagentd_shell_core::{RelayInfo, RelayRegistry};
use tauri::{AppHandle, Manager};

use crate::AppState;

#[derive(Default)]
pub struct PreviewRelays(RelayRegistry);

static RELAY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// HTTP/1.1 only (a WebSocket upgrade cannot happen on HTTP/2) and no total
/// timeout: tunnels stay open for as long as the page uses them.
fn relay_client() -> &'static reqwest::Client {
    RELAY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// The external server of `window`; bundled windows need no relay.
fn window_server(external: &HashMap<String, String>, window: &str) -> Result<String, String> {
    external
        .get(window)
        .cloned()
        .ok_or_else(|| "This window uses the built-in server, so its previews need no relay.".to_string())
}

/// Stop the relays of `window` (closed, or switched to another server).
pub fn close_window(app: &AppHandle, window: &str) {
    if let Some(relays) = app.try_state::<PreviewRelays>() {
        relays.0.close_scope(window);
    }
}

#[tauri::command]
pub async fn preview_relay_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    preview_id: String,
    port: u16,
) -> Result<RelayInfo, String> {
    let base_url = {
        let state: tauri::State<'_, AppState> = app.state();
        let external = state.window_backend_base_urls.lock().unwrap();
        window_server(&external, window.label())?
    };
    let origin = base_url.clone();
    let key = tauri::async_runtime::spawn_blocking(move || openagentd_shell_core::get_access_key(&origin))
        .await
        .map_err(|_| "credential store unavailable".to_string())??
        .ok_or_else(|| "Previews from this window need the server's access key.".to_string())?;
    let relays: tauri::State<'_, PreviewRelays> = app.state();
    relays
        .0
        .open(window.label(), relay_client(), &base_url, &key, &preview_id, port)
        .await
}

#[tauri::command]
pub fn preview_relay_close(
    window: tauri::WebviewWindow,
    relays: tauri::State<'_, PreviewRelays>,
    preview_id: String,
) -> bool {
    relays.0.close(window.label(), &preview_id)
}

#[cfg(test)]
mod tests {
    use super::window_server;
    use std::collections::HashMap;

    #[test]
    fn relays_only_serve_external_windows() {
        let external = HashMap::from([("main".to_string(), "http://192.168.1.5:4082".to_string())]);
        assert_eq!(window_server(&external, "main").unwrap(), "http://192.168.1.5:4082");
        assert!(window_server(&external, "main-2").unwrap_err().contains("built-in server"));
    }
}
