use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
struct SavedAppServer {
    base_url: String,
    name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct AppBackendConfig {
    active_base_url: Option<String>,
    servers: Vec<SavedAppServer>,
}

#[derive(Clone, Serialize)]
struct AppBackendStatus {
    base_url: String,
    sidecar_running: bool,
    external: bool,
    supports_bundled: bool,
    servers: Vec<SavedAppServer>,
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

#[tauri::command]
fn app_backend_status(app: AppHandle) -> Result<AppBackendStatus, String> {
    let config = load_backend_config(&app).map_err(|e| format!("{e:#}"))?;
    Ok(AppBackendStatus {
        base_url: config.active_base_url.unwrap_or_default(),
        sidecar_running: false,
        external: true,
        supports_bundled: false,
        servers: config.servers,
    })
}

#[tauri::command]
fn app_save_backend_server(app: AppHandle, base_url: String, name: Option<String>) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    save_backend_config(&app, Some(&normalized), normalize_server_name(name).as_deref())
        .map_err(|e| format!("{e:#}"))?;
    app_backend_status(app)
}

#[tauri::command]
fn app_use_external_backend(app: AppHandle, base_url: String, name: Option<String>, persist: Option<bool>) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    if persist.unwrap_or(true) {
        save_backend_config(&app, Some(&normalized), normalize_server_name(name).as_deref())
            .map_err(|e| format!("{e:#}"))?;
    }
    app_backend_status(app)
}

#[tauri::command]
fn app_remove_backend_server(app: AppHandle, base_url: String) -> Result<AppBackendStatus, String> {
    let normalized = normalize_base_url(&base_url).map_err(|e| format!("{e:#}"))?;
    remove_backend_server(&app, &normalized).map_err(|e| format!("{e:#}"))?;
    app_backend_status(app)
}

fn normalize_base_url(base_url: &str) -> Result<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("base URL is required"));
    }
    let parsed = url::Url::parse(trimmed).context("parse base URL")?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        scheme => Err(anyhow!("unsupported URL scheme: {scheme}")),
    }
}

fn normalize_server_name(name: Option<String>) -> Option<String> {
    name.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("resolve app config directory")?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir.join("app-backend.json"))
}

fn load_backend_config(app: &AppHandle) -> Result<AppBackendConfig> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppBackendConfig::default());
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let mut config: AppBackendConfig = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse {}", path.display()))?;
    if config.servers.is_empty() {
        config.servers = AppBackendConfig::default().servers;
    }
    Ok(config)
}

fn save_backend_config(app: &AppHandle, base_url: Option<&str>, name: Option<&str>) -> Result<()> {
    let path = config_path(app)?;
    let mut config = load_backend_config(app).unwrap_or_default();
    config.active_base_url = base_url.map(str::to_string);
    if let Some(url) = base_url {
        if let Some(saved) = config.servers.iter_mut().find(|saved| saved.base_url == url) {
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
    let bytes = serde_json::to_vec_pretty(&config).context("serialize backend config")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}

fn remove_backend_server(app: &AppHandle, base_url: &str) -> Result<()> {
    let path = config_path(app)?;
    let mut config = load_backend_config(app).unwrap_or_default();
    config.servers.retain(|server| server.base_url != base_url);
    if config.active_base_url.as_deref() == Some(base_url) {
        config.active_base_url = None;
    }
    if config.servers.is_empty() {
        config.servers = AppBackendConfig::default().servers;
    }
    let bytes = serde_json::to_vec_pretty(&config).context("serialize backend config")?;
    std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_haptics::init())
        .invoke_handler(tauri::generate_handler![
            app_backend_status,
            app_save_backend_server,
            app_use_external_backend,
            app_remove_backend_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenAgentd mobile");
}
