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

/// Record that the server itself put `key` into its environment (a `.env`
/// value, or a provider/MCP secret saved through the API). Such values are
/// server configuration, not part of the user's environment, so commands
/// the agent or the user runs must not inherit them.
pub fn mark_server_set(key: &str) {
    server_set().lock().unwrap().insert(key.to_string());
}

/// Variables no shell or terminal child may inherit: the server's auth
/// variables plus every key from [`mark_server_set`]. Variables the user
/// exported before starting the server are not listed and pass through.
pub fn child_env_blocklist() -> Vec<String> {
    let mut keys: Vec<String> = crate::auth::CHILD_ENV_SECRETS.iter().map(|k| k.to_string()).collect();
    keys.extend(server_set().lock().unwrap().iter().cloned());
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
                if std::env::var(key).is_err() {
                    std::env::set_var(key, val);
                    injected().lock().unwrap().insert(key.to_string(), val.to_string());
                    mark_server_set(key);
                }
            }
        }
    }
}

/// Load `.env` files with v2 (pydantic-settings) precedence:
/// real environment > `~/.config/openagentd/.env` > project `.env`.
///
/// `load_env_file` never overwrites an existing variable, so the
/// higher-priority file is loaded first.
pub fn init_env() {
    if let Some(home) = crate::home::home_dir_opt() {
        load_env_file(&home.join(".config").join("openagentd").join(".env"));
    }
    load_env_file(Path::new(".env"));
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
