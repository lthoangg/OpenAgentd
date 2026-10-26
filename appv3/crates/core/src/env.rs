use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

fn injected() -> &'static Mutex<HashMap<String, String>> {
    static I: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    I.get_or_init(Default::default)
}

fn server_set() -> &'static Mutex<BTreeSet<String>> {
    static S: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn notices() -> &'static Mutex<Vec<String>> {
    static N: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    N.get_or_init(Default::default)
}

/// Report a skipped or deprecated environment source (logged, and listed by
/// [`env_notices`]). Repeats are dropped.
pub fn notice(text: String) {
    let mut n = notices().lock().unwrap();
    if !n.contains(&text) {
        // Before logging starts this goes nowhere; `serve` logs the list
        // once it does. Settings read later (OTEL, snapshots) log here.
        tracing::warn!("env_notice {text}");
        n.push(text);
    }
}

/// `.env` files and keys the server skipped, for the log and `agentd doctor`
/// (both start after the files are read).
pub fn env_notices() -> Vec<String> {
    notices().lock().unwrap().clone()
}

/// Keys a `.env` file may not set: the mode picks the config dir the file
/// lives in, so only the real environment can choose it. `APP_ENV` is also
/// kept from child processes (see [`child_env_blocklist`]).
const ENV_ONLY_KEYS: [&str; 2] = [crate::settings::MODE_ENV, "APP_ENV"];

/// Record that the server itself put `key` into its environment (a `.env`
/// value, or a provider/MCP secret saved through the API). Such values are
/// server configuration, not part of the user's environment, so commands
/// the agent or the user runs must not inherit them.
pub fn mark_server_set(key: &str) {
    server_set().lock().unwrap().insert(key.to_string());
}

/// Variables no shell or terminal child may inherit: the server's auth
/// variables, every key from [`mark_server_set`], and the server's own mode
/// and `OPENAGENTD_*` variables. Its launcher sets those, and a child would
/// otherwise carry the installed app's `production` mode and paths into the
/// user's projects and into development builds started from the agent's
/// shell. Other variables the user exported before starting the server pass
/// through.
pub fn child_env_blocklist() -> Vec<String> {
    let mut keys: Vec<String> = crate::auth::CHILD_ENV_SECRETS.iter().map(|k| k.to_string()).collect();
    keys.extend(server_set().lock().unwrap().iter().cloned());
    keys.extend(ENV_ONLY_KEYS.iter().map(|k| k.to_string()));
    keys.extend(std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| k.starts_with("OPENAGENTD_")));
    keys
}

/// v2 `os.environ.get(name)`: the process environment *without* values that
/// only exist because a `.env` file was loaded into it. v2 reads those files
/// through pydantic-settings, which never touches `os.environ`, so checks
/// such as "is this provider configured" must not see them.
pub fn os_environ(name: &str) -> Option<String> {
    let v = std::env::var(name).ok()?;
    match injected().lock().unwrap().get(name) {
        Some(inj) if *inj == v => None,
        _ => Some(v),
    }
}

/// Names a dotenv file put into this process's environment (sorted).
pub fn injected_keys() -> Vec<String> {
    let mut keys: Vec<String> = injected().lock().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

/// Load key-value pairs from an env file without overwriting existing environment variables.
pub fn load_env_file(path: &Path) {
    if !path.exists() {
        return;
    }
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, val)) = line.split_once('=') {
                let key = key.trim();
                let mut val = val.trim();
                if (val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')) {
                    val = &val[1..val.len() - 1];
                }
                if ENV_ONLY_KEYS.contains(&key) {
                    notice(format!("{key} in {} is ignored; set it in the environment", path.display()));
                    continue;
                }
                if std::env::var(key).is_err() {
                    std::env::set_var(key, val);
                    injected().lock().unwrap().insert(key.to_string(), val.to_string());
                    mark_server_set(key);
                }
            }
        }
    }
}

/// Load the active config dir's `.env` (the real environment wins). It is
/// read before the settings are built so it can still set paths such as
/// `OPENAGENTD_DATA_DIR`.
///
/// Earlier versions also read `.env` from the working directory and always
/// `~/.config/openagentd/.env`. Neither is read now: a project's `.env`
/// names that project's database and ports (`DATABASE_URL`, `API_PORT`),
/// and the installed app's file must not configure a development server.
/// Skipped files are reported through [`env_notices`].
pub fn init_env() {
    let config_env = crate::settings::config_dir_from_env(&crate::settings::app_env_from_env()).join(".env");
    load_env_file(&config_env);
    let mut skipped = vec![std::env::current_dir().unwrap_or_default().join(".env")];
    if let Some(home) = crate::home::home_dir_opt() {
        skipped.push(home.join(".config").join("openagentd").join(".env"));
    }
    for path in skipped {
        if path.is_file() && !same_file(&path, &config_env) {
            notice(format!("{} is not read; only the config dir's .env ({}) is", path.display(), config_env.display()));
        }
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Load the active config dir's `.env` (non-secret settings; provider keys
/// moved to `credentials.yaml`, and any left here are not used for them).
pub fn load_config_env(config_dir: &Path) {
    load_env_file(&config_dir.join(".env"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_load_env_file() {
        let dir = tempdir().unwrap();
        let env_path = dir.path().join(".env");
        std::fs::write(&env_path, "TEST_OPENAGENTD_KEY=secret_value_123\n# comment\nOTHER_KEY=\"quoted\"\n").unwrap();

        load_env_file(&env_path);
        assert_eq!(std::env::var("TEST_OPENAGENTD_KEY").unwrap(), "secret_value_123");
        assert_eq!(std::env::var("OTHER_KEY").unwrap(), "quoted");
        let blocked = child_env_blocklist();
        assert!(blocked.iter().any(|k| k == "TEST_OPENAGENTD_KEY"), "{blocked:?}");
        assert!(blocked.iter().any(|k| k == "OPENAGENTD_DESKTOP_TOKEN"), "{blocked:?}");
    }

    #[test]
    fn env_file_does_not_claim_variables_the_user_exported() {
        let dir = tempdir().unwrap();
        let env_path = dir.path().join(".env");
        std::env::set_var("TEST_OPENAGENTD_USER_EXPORTED", "from_user");
        std::fs::write(&env_path, "TEST_OPENAGENTD_USER_EXPORTED=from_file\n").unwrap();
        load_env_file(&env_path);
        assert_eq!(std::env::var("TEST_OPENAGENTD_USER_EXPORTED").unwrap(), "from_user");
        assert!(!child_env_blocklist().iter().any(|k| k == "TEST_OPENAGENTD_USER_EXPORTED"));
    }
}
