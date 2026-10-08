//! `settings.yaml` — port of `app/core/runtime_settings.py`.
//!
//! Field set, defaults and serialisation order match the Pydantic models
//! (`model_dump(mode="json", exclude_none=True, exclude={"server"})`), so a
//! file written by v3 is identical to one written by v2.

use crate::secret_files::write_secret_file;
use crate::settings::settings;
use anyhow::{bail, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const PROVIDER_MODEL_PLACEHOLDER: &str = "__PROVIDER_MODEL__";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TitleGenerationSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub wait_timeout_seconds: f64,
}
impl Default for TitleGenerationSettings {
    fn default() -> Self {
        Self { enabled: true, model: None, wait_timeout_seconds: 3.0 }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SummarizationSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_token_threshold: Option<i64>,
}

/// `workspace_messages` — the lead's `send_to_workspace` tool (v3 only).
/// Written only when it differs from the default, so files stay unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct WorkspaceMessagesSettings {
    pub enabled: bool,
}
impl Default for WorkspaceMessagesSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}
impl WorkspaceMessagesSettings {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderUiSettings {
    pub visible_models: Vec<String>,
    pub cached_models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_listed_at: Option<i64>,
    pub is_disconnected: bool,
}

impl ProviderUiSettings {
    fn worth_keeping(&self) -> bool {
        self.is_disconnected || !self.visible_models.is_empty() || !self.cached_models.is_empty() || self.last_listed_at.is_some()
    }
    /// `effective_visible_models`.
    pub fn effective_visible_models(&self) -> Vec<String> {
        if self.cached_models.is_empty() {
            return self.visible_models.clone();
        }
        self.visible_models.iter().filter(|m| self.cached_models.contains(m)).cloned().collect()
    }
}

/// Legacy `server:` block — read for migration, never written.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LegacyServerBlock {
    pub host: Option<String>,
    #[serde(default, deserialize_with = "lax_int_opt")]
    pub port: Option<i64>,
    pub access_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RuntimeSettings {
    pub title_generation: TitleGenerationSettings,
    pub summarization: SummarizationSettings,
    #[serde(skip_serializing)]
    pub server: Option<LegacyServerBlock>,
    pub providers: IndexMap<String, ProviderUiSettings>,
    pub lsp: IndexMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "WorkspaceMessagesSettings::is_default")]
    pub workspace_messages: WorkspaceMessagesSettings,
}

pub fn load_runtime_settings_from(path: &Path) -> Result<RuntimeSettings> {
    if !path.exists() {
        return Ok(RuntimeSettings::default());
    }
    let text = std::fs::read_to_string(path)?;
    let raw = load_yaml_or_empty(&text, "settings.yaml")?;
    match raw {
        serde_json::Value::Object(_) => Ok(serde_json::from_value(raw)?),
        _ => bail!("settings.yaml must contain a YAML mapping."),
    }
}

pub fn load_runtime_settings() -> Result<RuntimeSettings> {
    load_runtime_settings_from(&settings().runtime_settings_path())
}

pub fn save_runtime_settings_to(cfg: &RuntimeSettings, path: &Path) -> Result<()> {
    let text = to_pyyaml(cfg)?;
    write_secret_file(path, &text)?;
    Ok(())
}

pub fn save_runtime_settings(cfg: &RuntimeSettings) -> Result<()> {
    save_runtime_settings_to(cfg, &settings().runtime_settings_path())
}

/// Whether lead agents get `send_to_workspace` (default on; unreadable
/// settings fall back to the default).
pub fn workspace_messages_enabled() -> bool {
    load_runtime_settings().map(|c| c.workspace_messages.enabled).unwrap_or(true)
}

fn cleaned_sorted(models: &[String]) -> Vec<String> {
    let mut set: Vec<String> = models.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
    set.sort();
    set.dedup();
    set
}

pub fn provider_ui(provider_id: &str) -> ProviderUiSettings {
    load_runtime_settings().ok().and_then(|c| c.providers.get(provider_id).cloned()).unwrap_or_default()
}

fn store(cfg: &mut RuntimeSettings, provider_id: &str, ui: ProviderUiSettings) {
    if ui.worth_keeping() {
        cfg.providers.insert(provider_id.to_string(), ui);
    } else {
        cfg.providers.shift_remove(provider_id);
    }
}

pub fn set_provider_visible_models(provider_id: &str, models: &[String]) -> Result<Vec<String>> {
    let mut cfg = load_runtime_settings()?;
    let mut ui = cfg.providers.get(provider_id).cloned().unwrap_or_default();
    ui.visible_models = cleaned_sorted(models);
    let out = ui.visible_models.clone();
    store(&mut cfg, provider_id, ui);
    save_runtime_settings(&cfg)?;
    Ok(out)
}

pub fn set_provider_cached_models(provider_id: &str, models: &[String]) -> Result<()> {
    let mut cfg = load_runtime_settings()?;
    let mut ui = cfg.providers.get(provider_id).cloned().unwrap_or_default();
    let cleaned = cleaned_sorted(models);
    ui.visible_models.retain(|m| cleaned.contains(m));
    ui.cached_models = cleaned;
    ui.last_listed_at = Some(chrono::Utc::now().timestamp());
    store(&mut cfg, provider_id, ui);
    save_runtime_settings(&cfg)?;
    Ok(())
}

pub fn clear_provider_cached_models(provider_id: &str) -> Result<()> {
    let mut cfg = load_runtime_settings()?;
    let Some(mut ui) = cfg.providers.get(provider_id).cloned() else {
        return Ok(());
    };
    ui.cached_models.clear();
    ui.last_listed_at = None;
    if !ui.visible_models.is_empty() {
        cfg.providers.insert(provider_id.into(), ui);
    } else {
        cfg.providers.shift_remove(provider_id);
    }
    save_runtime_settings(&cfg)
}

pub fn forget_provider_models(provider_id: &str) -> Result<()> {
    let mut cfg = load_runtime_settings()?;
    let Some(mut ui) = cfg.providers.get(provider_id).cloned() else {
        return Ok(());
    };
    if ui.cached_models.is_empty() && ui.visible_models.is_empty() {
        return Ok(());
    }
    ui.cached_models.clear();
    ui.visible_models.clear();
    ui.last_listed_at = None;
    if ui.is_disconnected {
        cfg.providers.insert(provider_id.into(), ui);
    } else {
        cfg.providers.shift_remove(provider_id);
    }
    save_runtime_settings(&cfg)
}

pub fn remove_provider_model(provider_id: &str, model: &str) -> Result<()> {
    let mut cfg = load_runtime_settings()?;
    let Some(mut ui) = cfg.providers.get(provider_id).cloned() else {
        return Ok(());
    };
    let name = model.split_once(':').map(|(_, m)| m.trim()).unwrap_or(model.trim()).to_string();
    let before = (ui.cached_models.clone(), ui.visible_models.clone());
    ui.cached_models.retain(|m| m != &name && m != model);
    ui.visible_models.retain(|m| m != &name && m != model);
    if (ui.cached_models.clone(), ui.visible_models.clone()) == before {
        return Ok(());
    }
    store(&mut cfg, provider_id, ui);
    save_runtime_settings(&cfg)
}

pub fn provider_is_disconnected(provider_id: &str) -> bool {
    provider_ui(provider_id).is_disconnected
}

pub fn set_provider_disconnected(provider_id: &str, disconnected: bool) -> Result<()> {
    let mut cfg = load_runtime_settings()?;
    let mut ui = cfg.providers.get(provider_id).cloned().unwrap_or_default();
    ui.is_disconnected = disconnected;
    store(&mut cfg, provider_id, ui);
    save_runtime_settings(&cfg)
}

/// `ensure_runtime_settings` — seed a fresh file on first run.
pub fn ensure_runtime_settings(path: &Path, provider_model: &str) -> Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    let pm = provider_model.trim();
    let model = if pm.is_empty() || pm == PROVIDER_MODEL_PLACEHOLDER { None } else { Some(pm.to_string()) };
    let cfg = RuntimeSettings { title_generation: TitleGenerationSettings { model, ..Default::default() }, ..Default::default() };
    save_runtime_settings_to(&cfg, path)?;
    Ok(true)
}

// ── server.yaml ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ServerYaml {
    pub host: String,
    #[serde(deserialize_with = "lax_int")]
    pub port: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_key: Option<String>,
}
impl Default for ServerYaml {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 4082, access_key: None }
    }
}

/// pydantic lax-mode `int`: ints, bools, integral floats, integer strings.
fn lax_int_value(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Bool(b) => Some(*b as i64),
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.2e18).map(|f| f as i64)),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn lax_int<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<i64, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    lax_int_value(&v).ok_or_else(|| serde::de::Error::custom("Input should be a valid integer"))
}

fn lax_int_opt<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<i64>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    if v.is_null() {
        return Ok(None);
    }
    lax_int_value(&v).map(Some).ok_or_else(|| serde::de::Error::custom("Input should be a valid integer"))
}

/// `load_server_settings` (including the one-time migration of a legacy
/// `server:` block out of `settings.yaml`).
pub fn load_server_settings() -> Result<ServerYaml> {
    let path = settings().server_settings_path();
    let legacy_path = settings().runtime_settings_path();
    if path.exists() {
        let text = std::fs::read_to_string(&path)?;
        let raw = load_yaml_or_empty(&text, "server.yaml")?;
        let mut current: ServerYaml = match raw {
            serde_json::Value::Object(_) => serde_json::from_value(raw)?,
            _ => bail!("server.yaml must contain a YAML mapping."),
        };
        if let Some(legacy) = pop_legacy_server(&legacy_path)? {
            if current.access_key.is_none() {
                if let Some(k) = legacy.access_key.filter(|k| !k.is_empty()) {
                    current.access_key = Some(k);
                    save_server_settings(&current)?;
                }
            }
        }
        return Ok(current);
    }
    if let Some(legacy) = pop_legacy_server(&legacy_path)? {
        let migrated = ServerYaml { host: legacy.host.unwrap_or_else(|| "127.0.0.1".into()), port: legacy.port.unwrap_or(4082), access_key: legacy.access_key };
        save_server_settings(&migrated)?;
        return Ok(migrated);
    }
    Ok(ServerYaml::default())
}

fn pop_legacy_server(path: &Path) -> Result<Option<LegacyServerBlock>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)?;
    let mut raw = load_yaml_or_empty(&text, "settings.yaml")?;
    let Some(map) = raw.as_object_mut() else {
        bail!("settings.yaml must contain a YAML mapping.");
    };
    let Some(server) = map.shift_remove("server").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    write_secret_file(path, &crate::pyyaml::safe_dump(&raw))?;
    Ok(serde_json::from_value(server).ok())
}

/// `yaml.safe_load(text) or {}` with v2's `"{file} YAML parse error: …"` text.
fn load_yaml_or_empty(text: &str, file: &str) -> Result<serde_json::Value> {
    match crate::pyyaml::safe_load_py(text) {
        Ok(p) if !p.truthy() => Ok(serde_json::Value::Object(Default::default())),
        Ok(p) => Ok(p.to_json()),
        Err(e) if e.is_yaml_error() => bail!("{file} YAML parse error: {e}"),
        Err(e) => bail!("{e}"),
    }
}

/// Serialize like `yaml.safe_dump(model.model_dump(), sort_keys=False)`.
pub fn to_pyyaml<T: Serialize>(v: &T) -> Result<String> {
    Ok(crate::pyyaml::safe_dump(&serde_json::to_value(v)?))
}

pub fn save_server_settings(cfg: &ServerYaml) -> Result<()> {
    write_secret_file(&settings().server_settings_path(), &to_pyyaml(cfg)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_like_pydantic_model_dump() {
        let mut cfg = RuntimeSettings::default();
        cfg.providers.insert("openai".into(), ProviderUiSettings { visible_models: vec!["gpt-5".into()], ..Default::default() });
        let text = to_pyyaml(&cfg).unwrap();
        assert_eq!(
            text,
            "title_generation:\n  enabled: true\n  wait_timeout_seconds: 3.0\nsummarization: {}\nproviders:\n  openai:\n    visible_models:\n    - gpt-5\n    cached_models: []\n    is_disconnected: false\nlsp: {}\n"
        );
    }

    #[test]
    fn reads_v2_file_with_unknown_and_legacy_keys() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.yaml");
        std::fs::write(&p, "title_generation:\n  model: codex:gpt-5.4-mini\nserver:\n  access_key: k\nsomething_else: 1\n").unwrap();
        let cfg = load_runtime_settings_from(&p).unwrap();
        assert_eq!(cfg.title_generation.model.as_deref(), Some("codex:gpt-5.4-mini"));
        assert!(cfg.title_generation.enabled);
        assert_eq!(cfg.server.unwrap().access_key.as_deref(), Some("k"));
        assert!(cfg.workspace_messages.enabled, "workspace messages default on");
    }

    #[test]
    fn workspace_messages_written_only_when_disabled() {
        let mut cfg = RuntimeSettings::default();
        assert!(!to_pyyaml(&cfg).unwrap().contains("workspace_messages"));
        cfg.workspace_messages.enabled = false;
        let text = to_pyyaml(&cfg).unwrap();
        assert!(text.ends_with("workspace_messages:\n  enabled: false\n"), "{text}");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.yaml");
        std::fs::write(&p, &text).unwrap();
        assert!(!load_runtime_settings_from(&p).unwrap().workspace_messages.enabled);
    }
}
