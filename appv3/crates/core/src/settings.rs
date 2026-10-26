//! Process settings — port of `app/core/config.py::Settings`.
//!
//! The mode comes from the build (see [`mode_from_env`]) and picks the XDG
//! roots; the real environment wins over the active config dir's `.env`
//! (see [`crate::env::init_env`]).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct Settings {
    pub app_env: String,
    pub api_host: String,
    pub api_port: u16,
    pub api_allow_insecure_lan: bool,
    /// `OPENAGENTD_CORS_ORIGINS` when set. `None` lets the API pick its default, which
    /// depends on whether an access key protects the server.
    pub cors_origins: Option<Vec<String>>,
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub agents_dir: PathBuf,
    pub skills_dir: PathBuf,
    pub plugins_dirs: Vec<PathBuf>,
    pub chat_workspace_dir: Option<PathBuf>,
    pub web_fetch_allow_private_network: bool,
    pub model_registry_refresh: bool,
    pub log_level: String,
    /// `app.log` threshold (the console uses `log_level`).
    pub file_log_level: String,
    pub database_path: PathBuf,
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Variables moved to the `OPENAGENTD_` prefix in v3.32.0, as (new, old).
/// The old names are generic (`API_PORT`, `DATABASE_URL`, `LOG_LEVEL`), so a
/// project's variables could configure the app. Standard names of other
/// tools keep theirs (`OTEL_EXPORTER_OTLP_ENDPOINT`, `RUST_LOG`, `NO_COLOR`,
/// provider `*_API_KEY` / `*_BASE_URL`). `APP_ENV` is handled by
/// [`mode_from_env`].
pub const RENAMED_ENV: [(&str, &str); 23] = [
    ("OPENAGENTD_HOST", "API_HOST"),
    ("OPENAGENTD_PORT", "API_PORT"),
    ("OPENAGENTD_ALLOW_INSECURE_LAN", "API_ALLOW_INSECURE_LAN"),
    ("OPENAGENTD_CORS_ORIGINS", "CORS_ORIGINS"),
    ("OPENAGENTD_LOG_LEVEL", "LOG_LEVEL"),
    ("OPENAGENTD_FILE_LOG_LEVEL", "FILE_LOG_LEVEL"),
    ("OPENAGENTD_DATABASE_URL", "DATABASE_URL"),
    ("OPENAGENTD_AGENTS_DIR", "AGENTS_DIR"),
    ("OPENAGENTD_SKILLS_DIR", "SKILLS_DIR"),
    ("OPENAGENTD_CHAT_WORKSPACE_DIR", "CHAT_WORKSPACE_DIR"),
    ("OPENAGENTD_WEB_FETCH_ALLOW_PRIVATE_NETWORK", "WEB_FETCH_ALLOW_PRIVATE_NETWORK"),
    ("OPENAGENTD_SNAPSHOT_ENGINE", "SNAPSHOT_ENGINE"),
    ("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "SNAPSHOT_MAINTENANCE_ENABLED"),
    ("OPENAGENTD_SNAPSHOT_SEED_OBJECTS", "SNAPSHOT_SEED_OBJECTS"),
    ("OPENAGENTD_SNAPSHOT_MAINTENANCE_INTERVAL_HOURS", "SNAPSHOT_MAINTENANCE_INTERVAL_HOURS"),
    ("OPENAGENTD_SNAPSHOT_MAINTENANCE_START_DELAY_SECONDS", "SNAPSHOT_MAINTENANCE_START_DELAY_SECONDS"),
    ("OPENAGENTD_SNAPSHOT_MAX_BYTES", "SNAPSHOT_MAX_BYTES"),
    ("OPENAGENTD_OTEL_RETENTION_ENABLED", "OTEL_RETENTION_ENABLED"),
    ("OPENAGENTD_OTEL_SLOW_SPAN_MS", "OTEL_SLOW_SPAN_MS"),
    ("OPENAGENTD_OTEL_SPAN_SAMPLE_RATIO", "OTEL_SPAN_SAMPLE_RATIO"),
    ("OPENAGENTD_OTEL_SPAN_RETENTION_DAYS", "OTEL_SPAN_RETENTION_DAYS"),
    ("OPENAGENTD_OTEL_METRIC_RETENTION_DAYS", "OTEL_METRIC_RETENTION_DAYS"),
    ("OPENAGENTD_OTEL_RETENTION_SWEEP_INTERVAL_HOURS", "OTEL_RETENTION_SWEEP_INTERVAL_HOURS"),
];

/// A setting's value: `name`, else its pre-v3.32.0 name from
/// [`RENAMED_ENV`] (noting the rename). Empty values count as unset.
pub fn env_var(name: &str) -> Option<String> {
    if let Some(v) = env_str(name) {
        return Some(v);
    }
    let (_, old) = RENAMED_ENV.iter().find(|(new, _)| *new == name)?;
    let v = env_str(old)?;
    crate::env::notice(format!("{old} is deprecated; set {name} instead"));
    Some(v)
}

fn env_bool(key: &str, default: bool) -> bool {
    match env_var(key) {
        Some(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on" | "t" | "y"),
        None => default,
    }
}

fn home() -> PathBuf {
    crate::home::home_dir()
}

/// `_default_dirs(app_env)`: (data, workspace, config, state, cache).
pub fn default_dirs(app_env: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
    if app_env == "production" {
        let h = home();
        (
            h.join(".local/share/openagentd"),
            h.join(".local/share/openagentd-workspace"),
            h.join(".config/openagentd"),
            h.join(".local/state/openagentd"),
            h.join(".cache/openagentd"),
        )
    } else {
        let root = std::env::current_dir().unwrap_or_default().join(".openagentd").join("dev");
        (root.join("data"), root.join("workspace"), root.join("config"), root.join("state"), root.join("cache"))
    }
}

fn abs(p: &str) -> PathBuf {
    let path = PathBuf::from(p);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

/// Overrides the mode the build picks (`production` or `development`).
pub const MODE_ENV: &str = "OPENAGENTD_ENV";
/// The mode's name before v3.32.0. A generic name other programs use too, so
/// only `production` and `development` count, and a note asks for the new one.
const OLD_MODE_ENV: &str = "APP_ENV";

/// The build picks the mode: the installed app (a release build) is
/// production and `cargo run` (a debug build) is development, whatever the
/// shell it starts from inherited.
pub fn build_default_mode() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    }
}

fn is_mode(v: &str) -> bool {
    matches!(v, "production" | "development")
}

/// The mode from the real environment: `OPENAGENTD_ENV`, else a
/// `production`/`development` `APP_ENV`, else [`build_default_mode`].
/// `Err` names an `OPENAGENTD_ENV` that is not a mode; the CLI refuses to
/// start on it. Read before any `.env` file: the mode picks the config dir
/// whose `.env` is read, so a file cannot pick it.
pub fn mode_from_env() -> Result<String, String> {
    if let Some(v) = env_str(MODE_ENV) {
        return if is_mode(&v) { Ok(v) } else { Err(format!("{MODE_ENV}={v} is not a mode; use production or development")) };
    }
    match env_str(OLD_MODE_ENV) {
        Some(v) if is_mode(&v) => {
            crate::env::notice(format!("{OLD_MODE_ENV} is deprecated; set {MODE_ENV}={v} instead"));
            Ok(v)
        }
        _ => Ok(build_default_mode().into()),
    }
}

/// [`mode_from_env`], with the build's mode for a value the CLI already refused.
pub fn app_env_from_env() -> String {
    mode_from_env().unwrap_or_else(|_| build_default_mode().into())
}

/// The config dir for `app_env`: `OPENAGENTD_CONFIG_DIR`, or the mode's default.
pub fn config_dir_from_env(app_env: &str) -> PathBuf {
    env_str("OPENAGENTD_CONFIG_DIR").map(|p| abs(&p)).unwrap_or_else(|| default_dirs(app_env).2)
}

impl Settings {
    /// Build from the current process environment (call [`crate::env::init_env`] first).
    pub fn from_env() -> Self {
        let app_env = app_env_from_env();
        let (d_data, d_ws, d_cfg, d_state, d_cache) = default_dirs(&app_env);
        let data_dir = env_str("OPENAGENTD_DATA_DIR").map(|p| abs(&p)).unwrap_or(d_data);
        let config_dir = env_str("OPENAGENTD_CONFIG_DIR").map(|p| abs(&p)).unwrap_or(d_cfg);
        let state_dir = env_str("OPENAGENTD_STATE_DIR").map(|p| abs(&p)).unwrap_or(d_state);
        let cache_dir = env_str("OPENAGENTD_CACHE_DIR").map(|p| abs(&p)).unwrap_or(d_cache);
        let workspace_dir = env_str("OPENAGENTD_WORKSPACE_DIR").map(|p| abs(&p)).unwrap_or(d_ws);
        let database_path = match env_var("OPENAGENTD_DATABASE_URL") {
            Some(url) => {
                let path = url.strip_prefix("sqlite+aiosqlite:///").or_else(|| url.strip_prefix("sqlite:///")).unwrap_or(&url);
                PathBuf::from(path)
            }
            None => data_dir.join("openagentd.db"),
        };
        // Server settings: the environment wins over `server.yaml`.
        let server_yaml = crate::runtime_settings::read_server_yaml_at(&config_dir.join("server.yaml")).unwrap_or_default();
        let cors_origins = env_var("OPENAGENTD_CORS_ORIGINS").map(|raw| crate::runtime_settings::parse_origins(&raw)).or(server_yaml.cors_origins);
        let sep = if cfg!(windows) { ';' } else { ':' };
        let plugins_dirs = env_str("OPENAGENTD_PLUGINS_DIRS")
            .map(|raw| raw.split(sep).filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect())
            .unwrap_or_else(|| vec![config_dir.join("plugins")]);
        Self {
            api_host: env_var("OPENAGENTD_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            api_port: env_var("OPENAGENTD_PORT").and_then(|p| p.parse().ok()).unwrap_or(4082),
            api_allow_insecure_lan: env_var("OPENAGENTD_ALLOW_INSECURE_LAN")
                .map(|v| crate::runtime_settings::parse_env_bool(&v))
                .or(server_yaml.allow_insecure_lan)
                .unwrap_or(false),
            cors_origins,
            agents_dir: env_var("OPENAGENTD_AGENTS_DIR").map(|p| abs(&p)).unwrap_or_else(|| config_dir.join("agents")),
            skills_dir: env_var("OPENAGENTD_SKILLS_DIR").map(|p| abs(&p)).unwrap_or_else(|| config_dir.join("skills")),
            plugins_dirs,
            chat_workspace_dir: env_var("OPENAGENTD_CHAT_WORKSPACE_DIR").map(|p| abs(&p)),
            web_fetch_allow_private_network: env_bool("OPENAGENTD_WEB_FETCH_ALLOW_PRIVATE_NETWORK", false),
            model_registry_refresh: env_bool("OPENAGENTD_MODEL_REGISTRY_REFRESH", true),
            log_level: env_var("OPENAGENTD_LOG_LEVEL").or(server_yaml.log_level).unwrap_or_else(|| "INFO".into()),
            file_log_level: env_var("OPENAGENTD_FILE_LOG_LEVEL").or(server_yaml.file_log_level).unwrap_or_else(|| "DEBUG".into()),
            app_env,
            data_dir,
            config_dir,
            state_dir,
            cache_dir,
            workspace_dir,
            database_path,
        }
    }

    pub fn is_production(&self) -> bool {
        self.app_env == "production"
    }

    pub fn runtime_settings_path(&self) -> PathBuf {
        self.config_dir.join("settings.yaml")
    }
    pub fn server_settings_path(&self) -> PathBuf {
        self.config_dir.join("server.yaml")
    }
    pub fn denied_paths_path(&self) -> PathBuf {
        self.config_dir.join("denied_paths.yaml")
    }
    pub fn multimodal_path(&self) -> PathBuf {
        self.config_dir.join("multimodal.yaml")
    }
    pub fn mcp_config_path(&self) -> PathBuf {
        self.config_dir.join("mcp.json")
    }
    pub fn env_file(&self) -> PathBuf {
        self.config_dir.join(".env")
    }
    pub fn memory_dir(&self) -> PathBuf {
        self.config_dir.join("memory")
    }
    pub fn commands_dir(&self) -> PathBuf {
        self.config_dir.join("commands")
    }
    pub fn snippets_dir(&self) -> PathBuf {
        self.config_dir.join("snippets")
    }
    /// Root of the prebuilt Chat workspace (`OPENAGENTD_CHAT_WORKSPACE_DIR` or `~`).
    pub fn chat_workspace_root(&self) -> PathBuf {
        let raw = self.chat_workspace_dir.as_ref().map(|p| p.to_string_lossy().trim().to_string()).unwrap_or_default();
        let p = if raw.is_empty() || raw.trim_end_matches('/') == "~" {
            home()
        } else if let Some(rest) = raw.strip_prefix("~/") {
            home().join(rest)
        } else {
            PathBuf::from(raw)
        };
        dunce::canonicalize(&p).unwrap_or(p)
    }
    /// v2 `is_chat_workspace`: never errors, `None`/empty → false.
    pub fn is_chat_workspace(&self, workspace: Option<&Path>) -> bool {
        let Some(w) = workspace else { return false };
        let raw = w.to_string_lossy().trim().to_string();
        if raw.is_empty() {
            return false;
        }
        let p = if raw == "~" {
            home()
        } else if let Some(rest) = raw.strip_prefix("~/") {
            home().join(rest)
        } else {
            PathBuf::from(raw)
        };
        let resolved = dunce::canonicalize(&p).unwrap_or(p);
        resolved == self.chat_workspace_root()
    }
    /// v2 `workspace_mode`: `"chat"` or `"coding"`.
    pub fn workspace_mode(&self, workspace: Option<&Path>) -> &'static str {
        if self.is_chat_workspace(workspace) {
            "chat"
        } else {
            "coding"
        }
    }
    /// Per-session agent workspace (`{workspace}/<sid>`), used when a session
    /// has no user workspace.
    pub fn session_workspace_dir(&self, session_id: &str) -> PathBuf {
        self.workspace_dir.join(session_id)
    }
    pub fn uploads_dir(&self, session_id: &str) -> PathBuf {
        self.session_workspace_dir(session_id).join("uploads")
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for d in [&self.data_dir, &self.config_dir, &self.state_dir, &self.cache_dir, &self.workspace_dir, &self.agents_dir, &self.skills_dir] {
            std::fs::create_dir_all(d)?;
        }
        if let Some(parent) = self.database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }
}

static SETTINGS: OnceLock<Settings> = OnceLock::new();

/// Process-wide settings, computed once from the environment.
pub fn settings() -> &'static Settings {
    SETTINGS.get_or_init(Settings::from_env)
}

/// Install explicit settings (tests, CLI overrides). No-op if already set.
pub fn install(s: Settings) -> &'static Settings {
    let _ = SETTINGS.set(s);
    settings()
}

/// Whether `path` is inside `root` (both canonicalised when possible).
pub fn path_within(path: &Path, root: &Path) -> bool {
    let p = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let r = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    p.starts_with(r)
}
