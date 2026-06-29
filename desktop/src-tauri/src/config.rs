use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedAppServer {
    pub base_url: String,
    pub name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AppBackendConfig {
    pub active_base_url: Option<String>,
    pub servers: Vec<SavedAppServer>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct SavedWindowState {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
pub struct AppBackendStatus {
    pub base_url: String,
    pub token: Option<String>,
    pub mode: String,
    pub sidecar_running: bool,
    pub external: bool,
    pub supports_bundled: bool,
    pub servers: Vec<SavedAppServer>,
}

impl Default for AppBackendConfig {
    fn default() -> Self {
        Self {
            active_base_url: None,
            servers: vec![SavedAppServer {
                base_url: "http://127.0.0.1:4082".to_string(),
                name: Some("Local CLI server".to_string()),
            }],
        }
    }
}

pub fn normalize_external_base_url(base_url: &str) -> Result<String> {
    let mut trimmed = base_url.trim().trim_end_matches('/');
    if let Some(stripped) = trimmed.strip_suffix("/api") {
        trimmed = stripped.trim_end_matches('/');
    }
    if trimmed.is_empty() {
        return Err(anyhow!("base URL is required"));
    }
    let parsed = reqwest::Url::parse(trimmed).context("parse base URL")?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        scheme => Err(anyhow!("unsupported URL scheme: {scheme}")),
    }
}

pub fn normalize_server_name(name: Option<String>) -> Option<String> {
    name.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn app_config_file(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("resolve app config dir")?;
    std::fs::create_dir_all(&dir).context("create app config dir")?;
    Ok(dir.join(name))
}

pub fn app_backend_config_path(app: &AppHandle) -> Result<PathBuf> {
    app_config_file(app, "desktop-backend.json")
}

pub fn window_state_path(app: &AppHandle) -> Result<PathBuf> {
    app_config_file(app, "window-state.json")
}

pub fn load_window_state(app: &AppHandle) -> Result<Option<SavedWindowState>> {
    let path = window_state_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let state: SavedWindowState =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    if state.width < 760 || state.height < 560 {
        return Ok(None);
    }
    Ok(Some(state))
}

pub fn save_window_state(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<()> {
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return Ok(());
    }
    let size = window.inner_size().context("read window inner size")?;
    if size.width < 760 || size.height < 560 {
        return Ok(());
    }
    let path = window_state_path(app)?;
    let state = SavedWindowState {
        width: size.width,
        height: size.height,
    };
    let bytes = serde_json::to_vec_pretty(&state).context("serialize window state")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}

pub fn load_app_backend_config(app: &AppHandle) -> Result<AppBackendConfig> {
    let path = app_backend_config_path(app)?;
    if !path.exists() {
        return Ok(AppBackendConfig::default());
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    let config = if value
        .get("servers")
        .and_then(|servers| servers.as_array())
        .and_then(|servers| servers.first())
        .is_some_and(|server| server.is_string())
    {
        let active_base_url = value
            .get("active_base_url")
            .and_then(|url| url.as_str())
            .map(str::to_string);
        let servers = value
            .get("servers")
            .and_then(|servers| servers.as_array())
            .into_iter()
            .flatten()
            .filter_map(|server| server.as_str())
            .map(|base_url| SavedAppServer {
                base_url: base_url.to_string(),
                name: None,
            })
            .collect();
        AppBackendConfig {
            active_base_url,
            servers,
        }
    } else {
        serde_json::from_value(value).with_context(|| format!("parse {}", path.display()))?
    };
    Ok(config)
}

pub fn save_app_backend_config(
    app: &AppHandle,
    base_url: Option<&str>,
    name: Option<&str>,
    activate: bool,
) -> Result<()> {
    let path = app_backend_config_path(app)?;
    let mut config = load_app_backend_config(app).unwrap_or_default();
    if activate {
        config.active_base_url = base_url.map(str::to_string);
    }
    if let Some(url) = base_url {
        if let Some(saved) = config
            .servers
            .iter_mut()
            .find(|saved| saved.base_url == url)
        {
            if let Some(name) = name {
                saved.name = Some(name.to_string());
            }
        } else {
            config.servers.push(SavedAppServer {
                base_url: url.to_string(),
                name: name.map(str::to_string),
            });
        }
    }
    let bytes = serde_json::to_vec_pretty(&config).context("serialize desktop backend config")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}

pub fn remove_app_backend_server(app: &AppHandle, base_url: &str) -> Result<()> {
    let path = app_backend_config_path(app)?;
    let mut config = load_app_backend_config(app).unwrap_or_default();
    config.servers.retain(|server| {
        normalize_external_base_url(&server.base_url).map_or(true, |saved| saved != base_url)
    });
    if config
        .active_base_url
        .as_deref()
        .and_then(|active| normalize_external_base_url(active).ok())
        .as_deref()
        == Some(base_url)
    {
        config.active_base_url = None;
    }
    let bytes = serde_json::to_vec_pretty(&config).context("serialize desktop backend config")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}
