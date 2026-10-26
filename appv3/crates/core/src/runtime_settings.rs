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
    /// Retitle a session from its summary after each compaction (v3 only,
    /// opt-in). Written only when on, so existing files stay unchanged.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub update_after_compaction: bool,
}
impl Default for TitleGenerationSettings {
    fn default() -> Self {
        Self { enabled: true, model: None, wait_timeout_seconds: 3.0, update_after_compaction: false }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SummarizationSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_token_threshold: Option<i64>,
    /// Compact an idle lead session before its prompt cache expires (v3 only,
    /// opt-in). Written only when on, so existing files stay unchanged.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub idle_compaction: bool,
    /// Share of the effective compaction trigger (1-100) a session must reach
    /// before idle compaction runs; `None` means
    /// [`DEFAULT_IDLE_COMPACTION_PERCENT`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_compaction_percent: Option<i64>,
}

pub const DEFAULT_IDLE_COMPACTION_PERCENT: i64 = 70;

impl SummarizationSettings {
    /// The effective idle-compaction percent. A hand-edited value outside
    /// 1-100 falls back to the default rather than failing settings loads.
    pub fn idle_compaction_percent(&self) -> i64 {
        match self.idle_compaction_percent {
            Some(p) if (1..=100).contains(&p) => p,
            Some(p) => {
                tracing::warn!("idle_compaction_percent_out_of_range value={} using={}", p, DEFAULT_IDLE_COMPACTION_PERCENT);
                DEFAULT_IDLE_COMPACTION_PERCENT
            }
            None => DEFAULT_IDLE_COMPACTION_PERCENT,
        }
    }
}

/// `workspace_messages` — the lead's `workspace` tool (v3 only).
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

/// `goals` — limits of the goal an approved plan runs ("Keep going until
/// done"), whether goal turns may ask questions, and whether the review
/// starts with Keep going ticked (v3 only). Written only when it differs
/// from the default, so files stay unchanged. The completion check always
/// runs on the session's own model, so it reuses the turn's prompt cache.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GoalSettings {
    /// Turns a new goal may run; `None` means [`DEFAULT_GOAL_MAX_TURNS`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<i64>,
    /// New tokens (uncached input plus output) a new goal may spend before
    /// it pauses; `None` means no budget.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<i64>,
    /// Let the agent ask the user questions during a goal. Off: goal turns
    /// run unattended: `ask_user` refuses, and `plan` saves without a review.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub allow_questions: bool,
    /// The plan review starts with "Keep going until done" ticked.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub keep_going_default: bool,
}

pub const DEFAULT_GOAL_MAX_TURNS: i64 = 50;
/// Largest accepted `max_turns`.
pub const MAX_GOAL_MAX_TURNS: i64 = 1000;

impl GoalSettings {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
    /// The effective turn limit. A hand-edited value outside
    /// 1..=[`MAX_GOAL_MAX_TURNS`] falls back to the default.
    pub fn max_turns(&self) -> i64 {
        match self.max_turns {
            Some(n) if (1..=MAX_GOAL_MAX_TURNS).contains(&n) => n,
            _ => DEFAULT_GOAL_MAX_TURNS,
        }
    }
    /// The default budget for a new goal. A hand-edited value below 1 means
    /// no budget.
    pub fn token_budget(&self) -> Option<i64> {
        self.token_budget.filter(|n| *n >= 1)
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
    #[serde(skip_serializing_if = "GoalSettings::is_default")]
    pub goals: GoalSettings,
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

/// Whether lead agents get `workspace` (default on; unreadable
/// settings fall back to the default).
pub fn workspace_messages_enabled() -> bool {
    load_runtime_settings().map(|c| c.workspace_messages.enabled).unwrap_or(true)
}

/// Goal settings (defaults when the file is unreadable).
pub fn goal_settings() -> GoalSettings {
    load_runtime_settings().map(|c| c.goals).unwrap_or_default()
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
    /// Browser origins allowed besides the first-party ones
    /// (`OPENAGENTD_CORS_ORIGINS` overrides). The four fields below moved
    /// here from `.env` in v3.32.0; unset ones are not written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cors_origins: Option<Vec<String>>,
    /// Allow LAN origins without an access key (`OPENAGENTD_ALLOW_INSECURE_LAN`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_insecure_lan: Option<bool>,
    /// Console log level (`OPENAGENTD_LOG_LEVEL`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// `app.log` level (`OPENAGENTD_FILE_LOG_LEVEL`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_log_level: Option<String>,
}
impl Default for ServerYaml {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 4082, access_key: None, cors_origins: None, allow_insecure_lan: None, log_level: None, file_log_level: None }
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
        let migrated =
            ServerYaml { host: legacy.host.unwrap_or_else(|| "127.0.0.1".into()), port: legacy.port.unwrap_or(4082), access_key: legacy.access_key, ..Default::default() };
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
    save_server_yaml_at(&settings().server_settings_path(), cfg)
}

fn save_server_yaml_at(path: &Path, cfg: &ServerYaml) -> Result<()> {
    write_secret_file(path, &to_pyyaml(cfg)?)?;
    Ok(())
}

/// `server.yaml` at `path`, without the legacy migration and without
/// touching the process settings (which are built from it). `None` when it
/// is missing; `Err` when it cannot be read or parsed.
fn try_read_server_yaml_at(path: &Path) -> Result<Option<ServerYaml>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = load_yaml_or_empty(&std::fs::read_to_string(path)?, "server.yaml")?;
    match raw {
        serde_json::Value::Object(_) => Ok(Some(serde_json::from_value(raw)?)),
        _ => bail!("server.yaml must contain a YAML mapping."),
    }
}

/// [`try_read_server_yaml_at`] for building settings: a missing or broken
/// file gives `None` (the server then uses its defaults; `agentd doctor`
/// reports the broken file).
pub fn read_server_yaml_at(path: &Path) -> Option<ServerYaml> {
    try_read_server_yaml_at(path).ok().flatten()
}

/// Kept next to `.env` when [`migrate_dotenv_server_keys`] rewrites it.
pub const DOTENV_BACKUP: &str = ".env.v3.32.bak";

/// `.env` variables `server.yaml` holds since v3.32.0: (field, new name, old name).
const SERVER_YAML_ENV: [(&str, &str, &str); 4] = [
    ("cors_origins", "OPENAGENTD_CORS_ORIGINS", "CORS_ORIGINS"),
    ("allow_insecure_lan", "OPENAGENTD_ALLOW_INSECURE_LAN", "API_ALLOW_INSECURE_LAN"),
    ("log_level", "OPENAGENTD_LOG_LEVEL", "LOG_LEVEL"),
    ("file_log_level", "OPENAGENTD_FILE_LOG_LEVEL", "FILE_LOG_LEVEL"),
];

/// `CORS_ORIGINS` text: a JSON list (pydantic-settings) or comma-separated.
pub fn parse_origins(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_else(|_| raw.split(',').map(|s| s.trim().to_string()).collect())
}

/// Boolean variable text, as the server reads it.
pub fn parse_env_bool(raw: &str) -> bool {
    matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on" | "t" | "y")
}

/// Move the server settings in `config_dir/.env` (old or new names) into
/// `server.yaml`, once. A value `server.yaml` already has stays; the `.env`
/// line goes either way, and the original file is kept as
/// [`DOTENV_BACKUP`]. Returns the keys still in `.env`, in file order.
pub fn migrate_dotenv_server_keys(config_dir: &Path) -> Result<Vec<String>> {
    let env_path = config_dir.join(".env");
    let Ok(text) = std::fs::read_to_string(&env_path) else { return Ok(vec![]) };
    // (line index, key, value) for each assignment.
    let entries: Vec<(usize, String, String)> = text
        .lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (k, v) = line.split_once('=')?;
            let v = v.trim();
            let quoted = v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
            let v = if quoted { &v[1..v.len() - 1] } else { v };
            Some((i, k.trim().to_string(), v.to_string()))
        })
        .collect();
    let is_server_key = |k: &str| SERVER_YAML_ENV.iter().any(|(_, new, old)| k == *new || k == *old);
    let left: Vec<String> = entries.iter().filter(|(_, k, _)| !is_server_key(k)).map(|(_, k, _)| k.clone()).collect();
    if !entries.iter().any(|(_, k, _)| is_server_key(k)) {
        return Ok(left);
    }

    let yaml_path = config_dir.join("server.yaml");
    let mut y = try_read_server_yaml_at(&yaml_path)?.unwrap_or_default();
    let value = |name: &str| entries.iter().rev().find(|(_, k, _)| k == name).map(|(_, _, v)| v.clone());
    for (field, new, old) in SERVER_YAML_ENV {
        let Some(v) = value(new).or_else(|| value(old)) else { continue };
        match field {
            "cors_origins" => y.cors_origins = y.cors_origins.take().or_else(|| Some(parse_origins(&v))),
            "allow_insecure_lan" => y.allow_insecure_lan = y.allow_insecure_lan.or(Some(parse_env_bool(&v))),
            "log_level" => y.log_level = y.log_level.take().or(Some(v)),
            _ => y.file_log_level = y.file_log_level.take().or(Some(v)),
        }
    }
    write_secret_file(&config_dir.join(DOTENV_BACKUP), &text)?;
    save_server_yaml_at(&yaml_path, &y)?;
    let moved: std::collections::BTreeSet<usize> = entries.iter().filter(|(_, k, _)| is_server_key(k)).map(|(i, _, _)| *i).collect();
    let kept: Vec<&str> = text.lines().enumerate().filter(|(i, _)| !moved.contains(i)).map(|(_, l)| l).collect();
    write_secret_file(&env_path, &if kept.is_empty() { String::new() } else { kept.join("\n") + "\n" })?;
    tracing::info!("dotenv_server_keys_migrated path={}", yaml_path.display());
    Ok(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotenv_server_keys_move_into_server_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let env = "# mine\nCORS_ORIGINS=[\"https://a.example\"]\nLOG_LEVEL=WARNING\nOPENAGENTD_LOG_LEVEL=DEBUG\nAPI_ALLOW_INSECURE_LAN=true\nFILE_LOG_LEVEL='INFO'\nOPENAGENTD_DATA_DIR=/x\n";
        std::fs::write(dir.path().join(".env"), env).unwrap();
        std::fs::write(dir.path().join("server.yaml"), "host: 127.0.0.1\nport: 4090\naccess_key: k\n").unwrap();

        let left = migrate_dotenv_server_keys(dir.path()).unwrap();

        assert_eq!(left, vec!["OPENAGENTD_DATA_DIR".to_string()]);
        let y = read_server_yaml_at(&dir.path().join("server.yaml")).unwrap();
        assert_eq!((y.port, y.access_key.as_deref()), (4090, Some("k")), "existing fields are kept");
        assert_eq!(y.cors_origins, Some(vec!["https://a.example".to_string()]));
        assert_eq!(y.log_level.as_deref(), Some("DEBUG"), "the new name wins over the old one");
        assert_eq!(y.allow_insecure_lan, Some(true));
        assert_eq!(y.file_log_level.as_deref(), Some("INFO"));
        assert_eq!(std::fs::read_to_string(dir.path().join(".env")).unwrap(), "# mine\nOPENAGENTD_DATA_DIR=/x\n");
        assert_eq!(std::fs::read_to_string(dir.path().join(DOTENV_BACKUP)).unwrap(), env, "the original is kept");
    }

    #[test]
    fn dotenv_migration_keeps_values_already_in_server_yaml() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "LOG_LEVEL=DEBUG\n").unwrap();
        std::fs::write(dir.path().join("server.yaml"), "log_level: ERROR\n").unwrap();
        assert!(migrate_dotenv_server_keys(dir.path()).unwrap().is_empty());
        assert_eq!(read_server_yaml_at(&dir.path().join("server.yaml")).unwrap().log_level.as_deref(), Some("ERROR"));
        assert_eq!(std::fs::read_to_string(dir.path().join(".env")).unwrap(), "");
    }

    #[test]
    fn dotenv_migration_with_nothing_to_move_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "OPENAGENTD_DATA_DIR=/x\n").unwrap();
        assert_eq!(migrate_dotenv_server_keys(dir.path()).unwrap(), vec!["OPENAGENTD_DATA_DIR".to_string()]);
        assert!(!dir.path().join("server.yaml").exists());
        assert!(!dir.path().join(DOTENV_BACKUP).exists());
        assert!(migrate_dotenv_server_keys(tempfile::tempdir().unwrap().path()).unwrap().is_empty(), "no .env at all");
    }

    #[test]
    fn a_broken_server_yaml_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "LOG_LEVEL=DEBUG\n").unwrap();
        std::fs::write(dir.path().join("server.yaml"), "port: [\n").unwrap();
        assert!(migrate_dotenv_server_keys(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("server.yaml")).unwrap(), "port: [\n");
        assert_eq!(std::fs::read_to_string(dir.path().join(".env")).unwrap(), "LOG_LEVEL=DEBUG\n");
    }

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

    #[test]
    fn update_after_compaction_written_only_when_on() {
        let mut cfg = RuntimeSettings::default();
        assert!(!to_pyyaml(&cfg).unwrap().contains("update_after_compaction"));
        cfg.title_generation.update_after_compaction = true;
        let text = to_pyyaml(&cfg).unwrap();
        assert!(text.starts_with("title_generation:\n  enabled: true\n  wait_timeout_seconds: 3.0\n  update_after_compaction: true\n"), "{text}");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.yaml");
        std::fs::write(&p, &text).unwrap();
        assert!(load_runtime_settings_from(&p).unwrap().title_generation.update_after_compaction);
    }

    #[test]
    fn goal_settings_written_only_when_set() {
        let mut cfg = RuntimeSettings::default();
        assert!(!to_pyyaml(&cfg).unwrap().contains("goals"));
        assert_eq!(cfg.goals.max_turns(), DEFAULT_GOAL_MAX_TURNS);
        assert!(!cfg.goals.allow_questions);
        cfg.goals = GoalSettings { max_turns: Some(20), token_budget: Some(500_000), allow_questions: true, keep_going_default: true };
        let text = to_pyyaml(&cfg).unwrap();
        assert!(text.ends_with("goals:\n  max_turns: 20\n  token_budget: 500000\n  allow_questions: true\n  keep_going_default: true\n"), "{text}");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.yaml");
        std::fs::write(&p, &text).unwrap();
        let back = load_runtime_settings_from(&p).unwrap().goals;
        assert_eq!((back.max_turns(), back.token_budget(), back.allow_questions, back.keep_going_default), (20, Some(500_000), true, true));
    }

    #[test]
    fn a_goal_token_budget_below_one_means_no_budget() {
        let with = |n: Option<i64>| GoalSettings { token_budget: n, ..Default::default() }.token_budget();
        assert_eq!(with(None), None);
        assert_eq!(with(Some(0)), None);
        assert_eq!(with(Some(-3)), None);
        assert_eq!(with(Some(80_000)), Some(80_000));
    }

    #[test]
    fn goal_max_turns_out_of_range_falls_back_to_default() {
        let with = |n: Option<i64>| GoalSettings { max_turns: n, ..Default::default() }.max_turns();
        assert_eq!(with(None), 50);
        assert_eq!(with(Some(0)), 50);
        assert_eq!(with(Some(5000)), 50);
        assert_eq!(with(Some(7)), 7);
    }

    #[test]
    fn idle_compaction_keys_written_only_when_set() {
        let mut cfg = RuntimeSettings::default();
        assert!(to_pyyaml(&cfg).unwrap().contains("summarization: {}\n"));
        cfg.summarization.idle_compaction = true;
        cfg.summarization.idle_compaction_percent = Some(60);
        let text = to_pyyaml(&cfg).unwrap();
        assert!(text.contains("summarization:\n  idle_compaction: true\n  idle_compaction_percent: 60\n"), "{text}");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.yaml");
        std::fs::write(&p, &text).unwrap();
        let back = load_runtime_settings_from(&p).unwrap().summarization;
        assert!(back.idle_compaction);
        assert_eq!(back.idle_compaction_percent(), 60);
    }

    #[test]
    fn idle_compaction_percent_falls_back_to_default() {
        let with = |p: Option<i64>| SummarizationSettings { idle_compaction_percent: p, ..Default::default() }.idle_compaction_percent();
        assert_eq!(with(None), DEFAULT_IDLE_COMPACTION_PERCENT);
        assert_eq!(with(Some(0)), 70);
        assert_eq!(with(Some(150)), 70);
        assert_eq!(with(Some(85)), 85);
        assert_eq!(with(Some(100)), 100);
    }
}
