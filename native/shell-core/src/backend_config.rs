//! Persisted list of known backend servers plus the one to use at startup.
//!
//! One file format, one set of rules, shared by both shells:
//!
//! * base URLs are normalised (trimmed, no trailing `/`, a pasted `/api`
//!   suffix dropped, `http(s)` only) before they are compared or stored;
//! * an empty server list falls back to the default "Local CLI server";
//! * the legacy `servers: ["url", …]` shape written by early desktop builds
//!   is migrated on read.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

pub const DEFAULT_LOCAL_BASE_URL: &str = "http://127.0.0.1:4082";
pub const DEFAULT_LOCAL_NAME: &str = "Local CLI server";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedAppServer {
    pub base_url: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppBackendConfig {
    pub active_base_url: Option<String>,
    pub servers: Vec<SavedAppServer>,
}

impl Default for AppBackendConfig {
    fn default() -> Self {
        Self {
            active_base_url: None,
            servers: vec![SavedAppServer {
                base_url: DEFAULT_LOCAL_BASE_URL.to_string(),
                name: Some(DEFAULT_LOCAL_NAME.to_string()),
            }],
        }
    }
}

/// Normalise a user-entered backend URL.
///
/// Trims whitespace and trailing slashes, drops a pasted `/api` suffix (the
/// UI adds it back per request; keeping it produced `…/api/api/health/live`
/// and an opaque "not reachable" error), and accepts only `http(s)`.
pub fn normalize_base_url(base_url: &str) -> Result<String> {
    let mut trimmed = base_url.trim().trim_end_matches('/');
    if let Some(stripped) = trimmed.strip_suffix("/api") {
        trimmed = stripped.trim_end_matches('/');
    }
    if trimmed.is_empty() {
        return Err(anyhow!("base URL is required"));
    }
    let parsed = url::Url::parse(trimmed).context("parse base URL")?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        scheme => Err(anyhow!("unsupported URL scheme: {scheme}")),
    }
}

pub fn normalize_server_name(name: Option<String>) -> Option<String> {
    name.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn with_default_servers(mut config: AppBackendConfig) -> AppBackendConfig {
    if config.servers.is_empty() {
        config.servers = AppBackendConfig::default().servers;
    }
    config
}

/// Read the config at `path`; a missing file is the default config.
pub fn load_backend_config_from(path: &Path) -> Result<AppBackendConfig> {
    if !path.exists() {
        return Ok(AppBackendConfig::default());
    }
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    let legacy_string_servers = value
        .get("servers")
        .and_then(|servers| servers.as_array())
        .and_then(|servers| servers.first())
        .is_some_and(|server| server.is_string());
    let config = if legacy_string_servers {
        AppBackendConfig {
            active_base_url: value
                .get("active_base_url")
                .and_then(|url| url.as_str())
                .map(str::to_string),
            servers: value
                .get("servers")
                .and_then(|servers| servers.as_array())
                .into_iter()
                .flatten()
                .filter_map(|server| server.as_str())
                .map(|base_url| SavedAppServer {
                    base_url: base_url.to_string(),
                    name: None,
                })
                .collect(),
        }
    } else {
        serde_json::from_value(value).with_context(|| format!("parse {}", path.display()))?
    };
    Ok(with_default_servers(config))
}

fn write_backend_config(path: &Path, config: &AppBackendConfig) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(config).context("serialize backend config")?;
    std::fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

/// Mutate `config` in place: upsert `base_url`/`name` into the known-servers
/// list, and only touch `active_base_url` when `activate` is true.
///
/// Pure (no I/O) so the activate/no-activate branching — which keeps one
/// desktop window's backend choice from leaking into the persisted startup
/// config applied to the main window — is testable on its own.
pub fn apply_backend_config_update(
    config: &mut AppBackendConfig,
    base_url: Option<&str>,
    name: Option<&str>,
    activate: bool,
) {
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
}

/// Load, apply [`apply_backend_config_update`], and write back.
pub fn save_backend_config_to(
    path: &Path,
    base_url: Option<&str>,
    name: Option<&str>,
    activate: bool,
) -> Result<()> {
    let mut config = load_backend_config_from(path).unwrap_or_default();
    apply_backend_config_update(&mut config, base_url, name, activate);
    write_backend_config(path, &config)
}

/// Remove every saved server whose normalised URL equals `base_url` (which
/// the caller has already normalised), clear `active_base_url` if it pointed
/// there, and refill the default entry if the list ends up empty.
pub fn remove_backend_server_at(path: &Path, base_url: &str) -> Result<()> {
    let mut config = load_backend_config_from(path).unwrap_or_default();
    config.servers.retain(|server| {
        normalize_base_url(&server.base_url).map_or(true, |saved| saved != base_url)
    });
    if config
        .active_base_url
        .as_deref()
        .and_then(|active| normalize_base_url(active).ok())
        .as_deref()
        == Some(base_url)
    {
        config.active_base_url = None;
    }
    write_backend_config(path, &with_default_servers(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn config_file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("backend.json");
        (dir, path)
    }

    // ── normalize_base_url ──────────────────────────────────────────────

    #[test]
    fn normalize_base_url_accepts_http_and_https() {
        assert_eq!(
            normalize_base_url("http://example.com").unwrap(),
            "http://example.com"
        );
        assert_eq!(
            normalize_base_url("https://example.com/path").unwrap(),
            "https://example.com/path"
        );
    }

    #[test]
    fn normalize_base_url_trims_whitespace_and_trailing_slashes() {
        assert_eq!(
            normalize_base_url("  https://example.com/path///  ").unwrap(),
            "https://example.com/path"
        );
    }

    #[test]
    fn normalize_base_url_drops_a_pasted_api_suffix() {
        // Previously desktop-only; mobile accepted `/api` verbatim and then
        // probed `…/api/api/health/live`.
        assert_eq!(
            normalize_base_url("http://host:4082/api").unwrap(),
            "http://host:4082"
        );
        assert_eq!(
            normalize_base_url("http://host:4082/api/").unwrap(),
            "http://host:4082"
        );
    }

    #[test]
    fn normalize_base_url_rejects_empty_scheme_and_invalid_urls() {
        assert!(normalize_base_url("   ").is_err());
        assert!(normalize_base_url("/api").is_err());
        assert!(normalize_base_url("file:///tmp/test").is_err());
        assert!(normalize_base_url("ftp://example.com").is_err());
        assert!(normalize_base_url("not a url").is_err());
    }

    #[test]
    fn normalize_server_name_trims_and_drops_empty_values() {
        assert_eq!(
            normalize_server_name(Some("  My Server  ".to_string())),
            Some("My Server".to_string())
        );
        assert_eq!(normalize_server_name(Some("   ".to_string())), None);
        assert_eq!(normalize_server_name(None), None);
    }

    // ── apply_backend_config_update ─────────────────────────────────────

    #[test]
    fn activate_false_leaves_active_base_url_untouched() {
        let mut config = AppBackendConfig {
            active_base_url: Some("http://127.0.0.1:4082".to_string()),
            servers: vec![],
        };
        apply_backend_config_update(
            &mut config,
            Some("http://192.168.1.10:5000"),
            Some("Window B server"),
            false,
        );
        assert_eq!(
            config.active_base_url.as_deref(),
            Some("http://127.0.0.1:4082"),
            "a non-activating save must not change which server is used on next launch"
        );
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers[0].base_url, "http://192.168.1.10:5000");
        assert_eq!(config.servers[0].name.as_deref(), Some("Window B server"));
    }

    #[test]
    fn activate_true_sets_or_clears_active_base_url() {
        let mut config = AppBackendConfig {
            active_base_url: None,
            servers: vec![],
        };
        apply_backend_config_update(&mut config, Some("http://127.0.0.1:9000"), None, true);
        assert_eq!(
            config.active_base_url.as_deref(),
            Some("http://127.0.0.1:9000")
        );
        // Switching the main window back to bundled clears the persisted
        // external URL so the app doesn't reconnect to it on next launch.
        apply_backend_config_update(&mut config, None, None, true);
        assert_eq!(config.active_base_url, None);
    }

    #[test]
    fn saving_an_existing_server_updates_its_name_without_duplicating() {
        let mut config = AppBackendConfig {
            active_base_url: None,
            servers: vec![SavedAppServer {
                base_url: "http://127.0.0.1:4082".to_string(),
                name: Some("Old name".to_string()),
            }],
        };
        apply_backend_config_update(
            &mut config,
            Some("http://127.0.0.1:4082"),
            Some("New name"),
            false,
        );
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers[0].name.as_deref(), Some("New name"));
    }

    // ── file round-trips ────────────────────────────────────────────────

    #[test]
    fn load_backend_config_returns_default_when_missing() {
        let (_dir, path) = config_file();
        let config = load_backend_config_from(&path).unwrap();
        assert_eq!(config, AppBackendConfig::default());
        assert_eq!(config.servers[0].base_url, DEFAULT_LOCAL_BASE_URL);
        assert_eq!(config.servers[0].name.as_deref(), Some(DEFAULT_LOCAL_NAME));
    }

    #[test]
    fn load_backend_config_migrates_legacy_string_servers() {
        let (_dir, path) = config_file();
        std::fs::write(
            &path,
            br#"{"active_base_url":"http://a:1","servers":["http://a:1","http://b:2"]}"#,
        )
        .unwrap();
        let config = load_backend_config_from(&path).unwrap();
        assert_eq!(config.active_base_url.as_deref(), Some("http://a:1"));
        assert_eq!(
            config.servers,
            vec![
                SavedAppServer {
                    base_url: "http://a:1".into(),
                    name: None
                },
                SavedAppServer {
                    base_url: "http://b:2".into(),
                    name: None
                },
            ]
        );
    }

    #[test]
    fn load_backend_config_rejects_corrupt_json() {
        let (_dir, path) = config_file();
        std::fs::write(&path, b"{not json").unwrap();
        assert!(load_backend_config_from(&path).is_err());
    }

    #[test]
    fn save_backend_config_adds_new_server_without_activating() {
        let (_dir, path) = config_file();
        save_backend_config_to(&path, Some("https://example.com"), Some("Example"), false).unwrap();
        let config = load_backend_config_from(&path).unwrap();
        assert_eq!(config.active_base_url, None);
        assert!(config.servers.iter().any(|server| {
            server.base_url == "https://example.com" && server.name.as_deref() == Some("Example")
        }));
    }

    #[test]
    fn save_backend_config_can_activate_server_and_rename_it() {
        let (_dir, path) = config_file();
        save_backend_config_to(&path, Some("https://example.com"), Some("Before"), true).unwrap();
        save_backend_config_to(&path, Some("https://example.com"), Some("After"), false).unwrap();
        let config = load_backend_config_from(&path).unwrap();
        assert_eq!(
            config.active_base_url.as_deref(),
            Some("https://example.com")
        );
        let matching: Vec<_> = config
            .servers
            .iter()
            .filter(|server| server.base_url == "https://example.com")
            .collect();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].name.as_deref(), Some("After"));
    }

    #[test]
    fn remove_backend_server_clears_active_base_url_when_matching() {
        let (_dir, path) = config_file();
        save_backend_config_to(&path, Some("https://example.com"), Some("Example"), true).unwrap();
        remove_backend_server_at(&path, "https://example.com").unwrap();
        let config = load_backend_config_from(&path).unwrap();
        assert_eq!(config.active_base_url, None);
        assert!(!config
            .servers
            .iter()
            .any(|server| server.base_url == "https://example.com"));
    }

    #[test]
    fn remove_backend_server_matches_on_normalised_urls() {
        // A server saved by an older build with a trailing slash or `/api`
        // still goes away when the user removes its normalised form.
        let (_dir, path) = config_file();
        std::fs::write(
            &path,
            serde_json::to_vec(&AppBackendConfig {
                active_base_url: Some("https://example.com/api/".to_string()),
                servers: vec![SavedAppServer {
                    base_url: "https://example.com/".to_string(),
                    name: None,
                }],
            })
            .unwrap(),
        )
        .unwrap();
        remove_backend_server_at(&path, "https://example.com").unwrap();
        let config = load_backend_config_from(&path).unwrap();
        assert_eq!(config.active_base_url, None);
        assert_eq!(config.servers, AppBackendConfig::default().servers);
    }

    #[test]
    fn empty_servers_list_falls_back_to_default_on_load_and_after_remove() {
        let (_dir, path) = config_file();
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&AppBackendConfig {
                active_base_url: Some("https://example.com".to_string()),
                servers: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        let loaded = load_backend_config_from(&path).unwrap();
        assert_eq!(loaded.servers.len(), 1);
        assert_eq!(loaded.servers[0].base_url, DEFAULT_LOCAL_BASE_URL);

        save_backend_config_to(&path, Some("https://example.com"), Some("Example"), true).unwrap();
        remove_backend_server_at(&path, "https://example.com").unwrap();
        let after_remove = load_backend_config_from(&path).unwrap();
        assert_eq!(after_remove.active_base_url, None);
        assert_eq!(after_remove.servers.len(), 1);
        assert_eq!(after_remove.servers[0].base_url, DEFAULT_LOCAL_BASE_URL);
    }
}
