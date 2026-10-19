//! "Network access": lets devices on the LAN reach the builtin sidecar.
//!
//! The sidecar owns the listener (`appv3-api` `network_access`) and is
//! driven through `/api/desktop/network-access`, which only answers the
//! desktop token on the private loopback listener. This module keeps the
//! user's choice (`network-access.json`: on/off + preferred port), keeps the
//! access key in the OS credential store, and re-applies the choice after
//! every sidecar start (launch, watchdog restart, "use builtin", reload).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, UdpSocket};
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::AppState;

pub const DEFAULT_PORT: u16 = 4082;
const KEY_SERVICE: &str = "openagentd.desktop-network-access";
const KEY_ACCOUNT: &str = "builtin";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkAccessConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Preferred port; the sidecar may listen on a fallback when it is taken.
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for NetworkAccessConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT }
    }
}

/// What the sidecar reports (`GET/PUT /api/desktop/network-access`).
#[derive(Clone, Debug, Default, Deserialize)]
struct BackendStatus {
    #[serde(default)]
    requested_port: Option<u16>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    fallback: bool,
    #[serde(default)]
    listening: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NetworkAccessStatus {
    /// The saved switch position.
    pub enabled: bool,
    /// The saved preferred port.
    pub requested_port: u16,
    /// The port actually listening, if any.
    pub port: Option<u16>,
    pub fallback: bool,
    pub listening: bool,
    pub error: Option<String>,
    pub lan_urls: Vec<String>,
    pub has_key: bool,
    pub sidecar_running: bool,
}

// ── Config file ─────────────────────────────────────────────────────────────

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf> {
    crate::config::app_config_file(app, "network-access.json")
}

/// A missing or unreadable file means "off" on the default port.
pub fn load_config_from(path: &Path) -> NetworkAccessConfig {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<NetworkAccessConfig>(&b).ok())
        .filter(|c| c.port != 0)
        .unwrap_or_default()
}

pub fn save_config_to(path: &Path, cfg: &NetworkAccessConfig) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(cfg).context("serialize network access config")?;
    std::fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

fn load_config(app: &AppHandle) -> NetworkAccessConfig {
    config_path(app).map(|p| load_config_from(&p)).unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &NetworkAccessConfig) -> Result<(), String> {
    config_path(app)
        .and_then(|p| save_config_to(&p, cfg))
        .map_err(|e| format!("{e:#}"))
}

/// The switch stays on only when the sidecar actually listens, so a failed
/// first attempt does not come back on every launch.
pub fn config_after_apply(requested_enabled: bool, port: u16, listening: bool) -> NetworkAccessConfig {
    NetworkAccessConfig { enabled: requested_enabled && listening, port }
}

pub fn validate_port(port: u16) -> Result<(), String> {
    if port < 1024 {
        return Err("Choose a port between 1024 and 65535.".into());
    }
    Ok(())
}

// ── Access key ──────────────────────────────────────────────────────────────

/// Mirrors the sidecar's rule (`routes::desktop::validate_access_key`).
pub fn validate_key(key: &str) -> Result<(), String> {
    let len = key.chars().count();
    if len < 16 {
        return Err("The access key must be at least 16 characters.".into());
    }
    if len > 512 {
        return Err("The access key must be at most 512 characters.".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The access key cannot contain spaces or control characters.".into());
    }
    Ok(())
}

/// 32 random bytes, base64url without padding (43 characters).
pub fn generate_key() -> Result<String, String> {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("generate access key: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Linux keeps credentials in a Secret Service provider (GNOME Keyring,
/// KWallet, KeePassXC). Standard desktops run one; bare window-manager
/// setups often do not, so say what to install instead of a generic error.
pub fn credential_store_error(linux: bool) -> String {
    if linux {
        "No system keychain is available. Install and unlock GNOME Keyring or KWallet (any Secret Service provider), then try again.".into()
    } else {
        "credential store unavailable".into()
    }
}

fn store_unavailable() -> String {
    credential_store_error(cfg!(target_os = "linux"))
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).map_err(|_| store_unavailable())
}

/// Keychain calls can block (or prompt), so they run off the async workers.
async fn blocking<T: Send + 'static>(call: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(call)
        .await
        .map_err(|_| store_unavailable())?
}

pub async fn load_key() -> Result<Option<String>, String> {
    blocking(|| match key_entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            log::warn!("network_access_key_read_failed error={e}");
            Err(store_unavailable())
        }
    })
    .await
}

async fn store_key(key: String) -> Result<(), String> {
    blocking(move || {
        key_entry()?.set_password(&key).map_err(|e| {
            log::warn!("network_access_key_write_failed error={e}");
            store_unavailable()
        })
    })
    .await
}

async fn load_or_create_key() -> Result<String, String> {
    if let Some(k) = load_key().await? {
        return Ok(k);
    }
    let key = generate_key()?;
    store_key(key.clone()).await?;
    Ok(key)
}

// ── LAN addresses ───────────────────────────────────────────────────────────

/// The address of the interface that routes off this machine. A UDP
/// "connect" only picks a route; nothing is sent.
fn primary_lan_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

pub fn lan_urls(ip: Option<IpAddr>, port: Option<u16>) -> Vec<String> {
    match (ip, port) {
        (Some(ip), Some(port)) => vec![format!("http://{ip}:{port}")],
        _ => vec![],
    }
}

// ── Sidecar control ─────────────────────────────────────────────────────────

/// Base URL and desktop token of the running builtin sidecar.
async fn sidecar(app: &AppHandle) -> Option<(String, String)> {
    let state = app.state::<AppState>();
    let alive = state.sidecar.lock().await.as_mut().is_some_and(|s| s.is_alive());
    if !alive {
        return None;
    }
    let base = state.backend_base_url.lock().await.clone()?;
    let token = state.desktop_token.lock().await.clone()?;
    Some((base, token))
}

async fn backend_call(base: &str, token: &str, body: Option<serde_json::Value>) -> Result<BackendStatus, String> {
    let url = format!("{}/api/desktop/network-access", base.trim_end_matches('/'));
    let client = crate::usage::loopback_client();
    let req = match &body {
        Some(b) => client.put(&url).json(b),
        None => client.get(&url),
    };
    let res = req
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("builtin backend unreachable: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let detail = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from));
        return Err(detail.unwrap_or_else(|| format!("builtin backend answered {status}")));
    }
    res.json::<BackendStatus>()
        .await
        .map_err(|e| format!("unexpected network access response: {e}"))
}

fn combine(cfg: NetworkAccessConfig, backend: Option<BackendStatus>, error: Option<String>, has_key: bool) -> NetworkAccessStatus {
    let sidecar_running = backend.is_some() || error.is_some();
    let b = backend.unwrap_or_default();
    let port = b.port.filter(|_| b.listening);
    NetworkAccessStatus {
        enabled: cfg.enabled,
        requested_port: b.requested_port.unwrap_or(cfg.port),
        port,
        fallback: b.fallback && port.is_some(),
        listening: port.is_some(),
        error: error.or(b.error),
        lan_urls: lan_urls(port.and_then(|_| primary_lan_ip()), port),
        has_key,
        sidecar_running,
    }
}

pub async fn status(app: &AppHandle) -> Result<NetworkAccessStatus, String> {
    let cfg = load_config(app);
    let has_key = load_key().await.ok().flatten().is_some();
    let Some((base, token)) = sidecar(app).await else {
        return Ok(combine(cfg, None, None, has_key));
    };
    Ok(match backend_call(&base, &token, None).await {
        Ok(b) => combine(cfg, Some(b), None, has_key),
        Err(e) => combine(cfg, None, Some(e), has_key),
    })
}

/// Turn network access on or off from the UI and remember the choice.
pub async fn set(app: &AppHandle, enabled: bool, port: u16) -> Result<NetworkAccessStatus, String> {
    validate_port(port)?;
    let (base, token) = sidecar(app)
        .await
        .ok_or_else(|| "Start the builtin backend first.".to_string())?;
    let body = if enabled {
        let key = load_or_create_key().await?;
        serde_json::json!({"enabled": true, "port": port, "access_key": key})
    } else {
        serde_json::json!({"enabled": false, "port": port})
    };
    let b = backend_call(&base, &token, Some(body)).await?;
    let cfg = config_after_apply(enabled, port, b.listening);
    save_config(app, &cfg)?;
    log::info!(
        "network_access_set enabled={} requested_port={} port={:?} listening={}",
        enabled,
        port,
        b.port,
        b.listening
    );
    Ok(combine(cfg, Some(b), None, true))
}

/// Store `key` (or a fresh random one) and restart the listener with it, so
/// devices using the old key are disconnected.
pub async fn set_key(app: &AppHandle, key: Option<String>) -> Result<NetworkAccessStatus, String> {
    let key = match key {
        Some(k) => {
            let k = k.trim().to_string();
            validate_key(&k)?;
            k
        }
        None => generate_key()?,
    };
    store_key(key.clone()).await?;
    let cfg = load_config(app);
    if cfg.enabled {
        if let Some((base, token)) = sidecar(app).await {
            let body = serde_json::json!({"enabled": true, "port": cfg.port, "access_key": key});
            let b = backend_call(&base, &token, Some(body)).await?;
            return Ok(combine(cfg, Some(b), None, true));
        }
    }
    status(app).await
}

/// Re-open the listener after a sidecar start when the switch is on.
/// Failures surface through `status`; they never block startup.
pub fn reapply(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let cfg = load_config(&app);
        if !cfg.enabled {
            return;
        }
        let Some((base, token)) = sidecar(&app).await else {
            return;
        };
        let key = match load_or_create_key().await {
            Ok(k) => k,
            Err(e) => {
                log::warn!("network_access_reapply_failed error={e}");
                return;
            }
        };
        let body = serde_json::json!({"enabled": true, "port": cfg.port, "access_key": key});
        match backend_call(&base, &token, Some(body)).await {
            Ok(b) => log::info!(
                "network_access_reapplied requested_port={} port={:?} listening={} error={:?}",
                cfg.port,
                b.port,
                b.listening,
                b.error
            ),
            Err(e) => log::warn!("network_access_reapply_failed error={e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_off_on_4082() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network-access.json");
        assert_eq!(load_config_from(&path), NetworkAccessConfig { enabled: false, port: 4082 });
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load_config_from(&path), NetworkAccessConfig::default());
        std::fs::write(&path, br#"{"enabled": true}"#).unwrap();
        assert_eq!(load_config_from(&path), NetworkAccessConfig { enabled: true, port: 4082 });
    }

    #[test]
    fn config_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network-access.json");
        let cfg = NetworkAccessConfig { enabled: true, port: 5000 };
        save_config_to(&path, &cfg).unwrap();
        assert_eq!(load_config_from(&path), cfg);
    }

    #[test]
    fn the_switch_is_saved_on_only_when_listening() {
        assert!(config_after_apply(true, 4082, true).enabled);
        assert!(!config_after_apply(true, 4082, false).enabled);
        assert!(!config_after_apply(false, 4082, false).enabled);
        assert_eq!(config_after_apply(true, 5000, false).port, 5000);
    }

    #[test]
    fn generated_keys_are_long_random_and_url_safe() {
        let a = generate_key().unwrap();
        let b = generate_key().unwrap();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(validate_key(&a).is_ok());
    }

    #[test]
    fn custom_keys_follow_the_sidecar_rules() {
        assert!(validate_key("short").is_err());
        assert!(validate_key("has a space in it ok").is_err());
        assert!(validate_key(&"x".repeat(16)).is_ok());
        assert!(validate_key(&"x".repeat(513)).is_err());
    }

    #[test]
    fn ports_below_1024_are_refused() {
        assert!(validate_port(80).is_err());
        assert!(validate_port(4082).is_ok());
    }

    #[test]
    fn linux_keychain_errors_say_what_to_install() {
        let linux = credential_store_error(true);
        assert!(linux.contains("GNOME Keyring") && linux.contains("KWallet"), "{linux}");
        assert_eq!(credential_store_error(false), "credential store unavailable");
    }

    #[test]
    fn lan_urls_use_the_listening_port() {
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        assert_eq!(lan_urls(Some(ip), Some(4083)), vec!["http://192.168.1.20:4083"]);
        assert!(lan_urls(None, Some(4082)).is_empty());
        assert!(lan_urls(Some(ip), None).is_empty());
    }

    #[test]
    fn status_reports_the_listening_port_and_fallback() {
        let cfg = NetworkAccessConfig { enabled: true, port: 4082 };
        let b = BackendStatus { requested_port: Some(4082), port: Some(4083), fallback: true, listening: true, error: None };
        let s = combine(cfg, Some(b), None, true);
        assert_eq!((s.port, s.fallback, s.listening, s.requested_port), (Some(4083), true, true, 4082));
        assert!(s.sidecar_running);

        let s = combine(cfg, None, Some("boom".into()), false);
        assert!(!s.listening && s.port.is_none() && s.lan_urls.is_empty());
        assert_eq!(s.error.as_deref(), Some("boom"));
    }
}
