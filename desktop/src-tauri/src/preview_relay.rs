//! Web preview for windows connected to a remote server.
//!
//! A server's preview listeners bind *its* loopback, so a window on another
//! computer cannot frame them. The relay (`openagentd_shell_core::
//! preview_relay`) listens on this computer's 127.0.0.1 and tunnels each
//! connection to the window's server with the access key, which never
//! reaches the previewed page. A window on a computer of the account
//! (`crate::account`) tunnels to that computer's loopback bridge with the
//! bridge's key: the bridge has a local address, but the preview listeners
//! are on the far computer. Bundled-backend windows frame the listener
//! directly and never call these commands. Relays are scoped per window and
//! close with it, or when it changes server.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use openagentd_shell_core::{RelayInfo, RelayRegistry, Via};
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

/// What a window's relay tunnels to, and the key for it: an account
/// bridge's key (in memory, this launch only), else the server's saved
/// access key. `Ok(None)` when the server has no saved key.
fn relay_upstream(
    bridge_key: Option<String>,
    saved_key: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<(Via, String)>, String> {
    match bridge_key {
        Some(key) => Ok(Some((Via::Account, key))),
        None => Ok(saved_key()?.map(|key| (Via::Server, key))),
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
    let bridge_key = crate::account::bridge_key(&origin);
    let (via, key) = tauri::async_runtime::spawn_blocking(move || {
        relay_upstream(bridge_key, || openagentd_shell_core::get_access_key(&origin))
    })
    .await
    .map_err(|_| "credential store unavailable".to_string())??
    .ok_or_else(|| "Previews from this window need the server's access key.".to_string())?;
    let relays: tauri::State<'_, PreviewRelays> = app.state();
    relays
        .0
        .open_via(via, window.label(), relay_client(), &base_url, &key, &preview_id, port)
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
    use super::{relay_upstream, window_server};
    use openagentd_shell_core::Via;
    use std::collections::HashMap;

    #[test]
    fn an_account_bridge_uses_its_own_key_and_a_server_its_saved_one() {
        assert_eq!(
            relay_upstream(Some("bridge".into()), || panic!("a bridge has no saved key")).unwrap(),
            Some((Via::Account, "bridge".to_string()))
        );
        assert_eq!(
            relay_upstream(None, || Ok(Some("saved".to_string()))).unwrap(),
            Some((Via::Server, "saved".to_string()))
        );
        assert_eq!(relay_upstream(None, || Ok(None)).unwrap(), None);
        assert!(relay_upstream(None, || Err("locked".into())).is_err());
    }

    #[test]
    fn relays_only_serve_external_windows() {
        let external = HashMap::from([("main".to_string(), "http://192.168.1.5:4082".to_string())]);
        assert_eq!(window_server(&external, "main").unwrap(), "http://192.168.1.5:4082");
        assert!(window_server(&external, "main-2").unwrap_err().contains("built-in server"));
    }
}
