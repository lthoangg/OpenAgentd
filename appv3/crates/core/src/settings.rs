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
    /// `CORS_ORIGINS` when set. `None` lets the API pick its default, which
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
    pub database_path: PathBuf,
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn env_bool(key: &str, default: bool) -> bool {
    match env_str(key) {
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
        let database_path = match env_str("DATABASE_URL") {
            Some(url) => {
                let path = url.strip_prefix("sqlite+aiosqlite:///").or_else(|| url.strip_prefix("sqlite:///")).unwrap_or(&url);
                PathBuf::from(path)
            }
            None => data_dir.join("openagentd.db"),
        };
        let cors_origins = env_str("CORS_ORIGINS").map(|raw| {
            // pydantic-settings parses list env vars as JSON.
            serde_json::from_str::<Vec<String>>(&raw).unwrap_or_else(|_| raw.split(',').map(|s| s.trim().to_string()).collect())
        });
        let sep = if cfg!(windows) { ';' } else { ':' };
        let plugins_dirs = env_str("OPENAGENTD_PLUGINS_DIRS")
            .map(|raw| raw.split(sep).filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect())
            .unwrap_or_else(|| vec![config_dir.join("plugins")]);
        Self {
            api_host: env_str("API_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            api_port: env_str("API_PORT").and_then(|p| p.parse().ok()).unwrap_or(4082),
            api_allow_insecure_lan: env_bool("API_ALLOW_INSECURE_LAN", false),
            cors_origins,
            agents_dir: env_str("AGENTS_DIR").map(|p| abs(&p)).unwrap_or_else(|| config_dir.join("agents")),
            skills_dir: env_str("SKILLS_DIR").map(|p| abs(&p)).unwrap_or_else(|| config_dir.join("skills")),
            plugins_dirs,
            chat_workspace_dir: env_str("CHAT_WORKSPACE_DIR").map(|p| abs(&p)),
            web_fetch_allow_private_network: env_bool("WEB_FETCH_ALLOW_PRIVATE_NETWORK", false),
            model_registry_refresh: env_bool("OPENAGENTD_MODEL_REGISTRY_REFRESH", true),
            log_level: env_str("LOG_LEVEL").unwrap_or_else(|| "INFO".into()),
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
    /// Root of the prebuilt Chat workspace (`CHAT_WORKSPACE_DIR` or `~`).
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
