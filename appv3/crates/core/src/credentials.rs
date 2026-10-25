//! `credentials.yaml` — the one on-disk store for provider API keys, OAuth
//! accounts, and named secrets (MCP client secrets and `$VAR` values).
//!
//! Lookups give a variable exported in the server's real environment
//! precedence (a deployment pin), then the stored credential in use for the
//! provider. Nothing here writes to the process environment, so stored
//! secrets never reach shells, terminals, or plugins started by the server.
//!
//! Each provider holds an ordered list of credentials. The order is the
//! priority: the selection sticks to the credential in use until it fails
//! (see [`set_cooldown`]), then falls through to the next one that is ready.

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

pub const FILE_NAME: &str = "credentials.yaml";
pub const SCHEMA_VERSION: u32 = 1;

const HEADER: &str = "# OpenAgentd credentials: provider keys, OAuth accounts and named secrets.\n\
# Keep this file private. Manage it in Settings -> Providers, or edit it while\n\
# the server is stopped. Credentials are tried top to bottom per provider.\n";

/// The whole file.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CredentialsFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, deserialize_with = "null_default")]
    pub providers: IndexMap<String, Vec<Credential>>,
    #[serde(default, deserialize_with = "scalar_map")]
    pub secrets: IndexMap<String, String>,
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// One API key set or OAuth account of a provider.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Credential {
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub label: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub disabled: bool,
    /// Values named like the environment variables they stand in for
    /// (`OPENAI_API_KEY`, `ROUTER9_BASE_URL`, …).
    #[serde(default, skip_serializing_if = "IndexMap::is_empty", deserialize_with = "scalar_map")]
    pub values: IndexMap<String, String>,
    /// Provider-specific OAuth token document (same JSON shape the legacy
    /// `<provider>_oauth.json` files used).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<Value>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn null_default<'de, D: Deserializer<'de>, T: Default + Deserialize<'de>>(d: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// YAML turns `KEY: 0123` or `KEY: yes` into numbers and booleans; secrets
/// are always text, so accept any scalar and keep it as a string.
fn scalar_map<'de, D: Deserializer<'de>>(d: D) -> Result<IndexMap<String, String>, D::Error> {
    let raw = Option::<IndexMap<String, Value>>::deserialize(d)?.unwrap_or_default();
    let mut out = IndexMap::new();
    for (k, v) in raw {
        let s = match v {
            Value::Null => String::new(),
            Value::String(s) => s,
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            _ => return Err(serde::de::Error::custom(format!("'{k}' must be a single value"))),
        };
        out.insert(k, s);
    }
    Ok(out)
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("disabled", &self.disabled)
            .field("values", &self.values.keys().collect::<Vec<_>>())
            .field("oauth", &self.oauth.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl std::fmt::Debug for CredentialsFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialsFile").field("version", &self.version).field("providers", &self.providers).field("secrets", &self.secrets.keys().collect::<Vec<_>>()).finish()
    }
}

impl Credential {
    pub fn new(label: impl Into<String>) -> Self {
        Credential { id: new_id(), label: label.into(), ..Default::default() }
    }
    /// A stored, non-empty value.
    pub fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str).filter(|v| !v.is_empty())
    }
    /// Whether it holds anything usable (a value or an OAuth document).
    pub fn has_secret(&self) -> bool {
        self.oauth.is_some() || self.values.values().any(|v| !v.is_empty())
    }
}

impl CredentialsFile {
    pub fn provider(&self, provider_id: &str) -> &[Credential] {
        self.providers.get(provider_id).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn provider_mut(&mut self, provider_id: &str) -> &mut Vec<Credential> {
        self.providers.entry(provider_id.to_string()).or_default()
    }
    pub fn find(&self, provider_id: &str, id: &str) -> Option<&Credential> {
        self.provider(provider_id).iter().find(|c| c.id == id)
    }
    pub fn find_mut(&mut self, provider_id: &str, id: &str) -> Option<&mut Credential> {
        self.providers.get_mut(provider_id)?.iter_mut().find(|c| c.id == id)
    }
    /// Remove one credential; drops the provider key when it was the last.
    pub fn remove(&mut self, provider_id: &str, id: &str) -> Option<Credential> {
        let list = self.providers.get_mut(provider_id)?;
        let i = list.iter().position(|c| c.id == id)?;
        let c = list.remove(i);
        if list.is_empty() {
            self.providers.shift_remove(provider_id);
        }
        Some(c)
    }
    /// Credentials that may serve requests, in priority order.
    pub fn enabled(&self, provider_id: &str) -> Vec<&Credential> {
        self.provider(provider_id).iter().filter(|c| !c.disabled).collect()
    }

    pub fn parse(text: &str) -> Result<Self, CredentialsError> {
        let v = crate::pyyaml::safe_load(text).map_err(|e| CredentialsError::Malformed(e.message))?;
        if v.is_null() {
            return Ok(Self { version: SCHEMA_VERSION, ..Default::default() });
        }
        if !v.is_object() {
            return Err(CredentialsError::Malformed("the top level must be a mapping".into()));
        }
        let f: Self = serde_json::from_value(v).map_err(|e| CredentialsError::Malformed(e.to_string()))?;
        if f.version > SCHEMA_VERSION {
            return Err(CredentialsError::Malformed(format!("version {} is newer than this OpenAgentd supports ({SCHEMA_VERSION}); upgrade OpenAgentd", f.version)));
        }
        let mut seen = std::collections::HashSet::new();
        for (p, list) in &f.providers {
            for c in list {
                if c.id.trim().is_empty() {
                    return Err(CredentialsError::Malformed(format!("a credential of '{p}' has no id")));
                }
                if !seen.insert((p.as_str(), c.id.as_str())) {
                    return Err(CredentialsError::Malformed(format!("'{p}' lists credential id '{}' twice", c.id)));
                }
            }
        }
        Ok(f)
    }

    pub fn to_yaml(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            if o.get("secrets").and_then(|s| s.as_object()).is_some_and(|s| s.is_empty()) {
                o.remove("secrets");
            }
        }
        format!("{HEADER}{}", crate::pyyaml::safe_dump(&v))
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum CredentialsError {
    #[error("credentials.yaml is not valid: {0}")]
    Malformed(String),
    #[error("credentials.yaml: {0}")]
    Io(String),
}

impl From<CredentialsError> for std::io::Error {
    fn from(e: CredentialsError) -> Self {
        std::io::Error::other(e.to_string())
    }
}

/// `cred_` + 8 hex characters.
pub fn new_id() -> String {
    format!("cred_{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

// ── File access ─────────────────────────────────────────────────────────────

/// `{config_dir}/credentials.yaml`.
pub fn path() -> PathBuf {
    crate::settings().config_dir.join(FILE_NAME)
}

type CacheEntry = (Option<SystemTime>, u64, Arc<CredentialsFile>);

fn cache() -> &'static Mutex<HashMap<PathBuf, CacheEntry>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Read the file at `path` (cached until its size or mtime changes). A
/// missing file is an empty store; an unreadable or invalid one is an error.
pub fn load_from(path: &Path) -> Result<Arc<CredentialsFile>, CredentialsError> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            cache().lock().unwrap().remove(path);
            return Ok(Arc::new(CredentialsFile { version: SCHEMA_VERSION, ..Default::default() }));
        }
        Err(e) => return Err(CredentialsError::Io(e.to_string())),
    };
    let (mtime, len) = (meta.modified().ok(), meta.len());
    if let Some((m, l, f)) = cache().lock().unwrap().get(path) {
        if *m == mtime && *l == len && mtime.is_some() {
            return Ok(f.clone());
        }
    }
    let text = std::fs::read_to_string(path).map_err(|e| CredentialsError::Io(e.to_string()))?;
    let f = Arc::new(CredentialsFile::parse(&text)?);
    cache().lock().unwrap().insert(path.to_path_buf(), (mtime, len, f.clone()));
    Ok(f)
}

/// The active store; see [`load_from`].
pub fn load() -> Result<Arc<CredentialsFile>, CredentialsError> {
    load_from(&path())
}

/// The active store for reads that must not fail. An invalid file reads as
/// empty here (logged once per change); writes refuse to touch it.
pub fn snapshot() -> Arc<CredentialsFile> {
    snapshot_from(&path())
}

pub fn snapshot_from(path: &Path) -> Arc<CredentialsFile> {
    match load_from(path) {
        Ok(f) => f,
        Err(e) => {
            static LAST: Mutex<String> = Mutex::new(String::new());
            let msg = e.to_string();
            let mut last = LAST.lock().unwrap();
            if *last != msg {
                tracing::error!("credentials_unreadable path={} error={}", path.display(), msg);
                *last = msg;
            }
            Arc::new(CredentialsFile::default())
        }
    }
}

fn write_lock() -> &'static Mutex<()> {
    static L: Mutex<()> = Mutex::new(());
    &L
}

/// Read-modify-write under a process lock and an advisory file lock (the
/// CLI and the server may both write). The closure sees the latest file;
/// nothing is written when it leaves the store unchanged.
pub fn update_at<R>(path: &Path, f: impl FnOnce(&mut CredentialsFile) -> R) -> Result<R, CredentialsError> {
    let _g = write_lock().lock().unwrap_or_else(|p| p.into_inner());
    let io = |e: std::io::Error| CredentialsError::Io(e.to_string());
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(io)?;
    let lock_path = parent.join(format!(".{FILE_NAME}.lock"));
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let lock = opts.open(&lock_path).map_err(io)?;
    lock.lock().map_err(io)?;
    let current = match std::fs::read_to_string(path) {
        Ok(t) => CredentialsFile::parse(&t)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => CredentialsFile { version: SCHEMA_VERSION, ..Default::default() },
        Err(e) => return Err(io(e)),
    };
    let mut next = current.clone();
    let r = f(&mut next);
    if next != current {
        next.version = SCHEMA_VERSION;
        crate::secret_files::write_secret_file(path, &next.to_yaml()).map_err(io)?;
        cache().lock().unwrap().remove(path);
    }
    let _ = lock.unlock();
    Ok(r)
}

/// [`update_at`] on the active store.
pub fn update<R>(f: impl FnOnce(&mut CredentialsFile) -> R) -> Result<R, CredentialsError> {
    update_at(&path(), f)
}

// ── Selection state (process-wide, not persisted) ──────────────────────────

/// Why a credential is being skipped for now.
#[derive(Debug, Clone, PartialEq)]
pub struct Cooldown {
    /// Unix seconds when it becomes eligible again.
    pub until: f64,
    /// `rate_limit`, `quota`, `spend_limit`, or `auth`.
    pub reason: String,
}

#[derive(Default)]
struct PoolState {
    current: HashMap<String, String>,
    cooldowns: HashMap<(String, String), Cooldown>,
}

fn state() -> &'static Mutex<PoolState> {
    static S: OnceLock<Mutex<PoolState>> = OnceLock::new();
    S.get_or_init(Default::default)
}

pub fn now_s() -> f64 {
    SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Skip `id` until `until` (unix seconds). A later deadline wins.
pub fn set_cooldown(provider_id: &str, id: &str, until: f64, reason: &str) {
    let mut s = state().lock().unwrap();
    let key = (provider_id.to_string(), id.to_string());
    let keep = s.cooldowns.get(&key).is_some_and(|c| c.until >= until);
    if !keep {
        s.cooldowns.insert(key, Cooldown { until, reason: reason.to_string() });
    }
}

/// The active cooldown of a credential (expired ones are dropped).
pub fn cooldown(provider_id: &str, id: &str) -> Option<Cooldown> {
    let mut s = state().lock().unwrap();
    let key = (provider_id.to_string(), id.to_string());
    match s.cooldowns.get(&key) {
        Some(c) if c.until > now_s() => Some(c.clone()),
        Some(_) => {
            s.cooldowns.remove(&key);
            None
        }
        None => None,
    }
}

pub fn clear_cooldown(provider_id: &str, id: &str) {
    state().lock().unwrap().cooldowns.remove(&(provider_id.to_string(), id.to_string()));
}

/// The credential the provider's requests stick to.
pub fn current(provider_id: &str) -> Option<String> {
    state().lock().unwrap().current.get(provider_id).cloned()
}

pub fn set_current(provider_id: &str, id: &str) {
    state().lock().unwrap().current.insert(provider_id.to_string(), id.to_string());
}

/// Pick the credential to use: the sticky current one while it is ready,
/// else the first ready one in order, else (all cooling down) the one that
/// recovers first. `None` only when nothing is enabled.
pub fn select<'a>(provider_id: &str, enabled: &[&'a Credential]) -> Option<&'a Credential> {
    if enabled.is_empty() {
        return None;
    }
    let ready = |c: &Credential| cooldown(provider_id, &c.id).is_none();
    if let Some(cur) = current(provider_id) {
        if let Some(c) = enabled.iter().find(|c| c.id == cur && ready(c)) {
            return Some(c);
        }
    }
    let pick = enabled.iter().find(|c| ready(c)).copied().unwrap_or_else(|| {
        *enabled
            .iter()
            .min_by(|a, b| {
                let ua = cooldown(provider_id, &a.id).map(|c| c.until).unwrap_or(0.0);
                let ub = cooldown(provider_id, &b.id).map(|c| c.until).unwrap_or(0.0);
                ua.total_cmp(&ub)
            })
            .expect("non-empty")
    });
    set_current(provider_id, &pick.id);
    Some(pick)
}

/// After `failed_id` failed: the next ready credential after it in order
/// (wrapping), made current. `None` when no other credential is ready.
pub fn rotate_from<'a>(provider_id: &str, failed_id: &str, enabled: &[&'a Credential]) -> Option<&'a Credential> {
    let start = enabled.iter().position(|c| c.id == failed_id).map(|i| i + 1).unwrap_or(0);
    let n = enabled.len();
    for k in 0..n {
        let c = enabled[(start + k) % n];
        if c.id != failed_id && cooldown(provider_id, &c.id).is_none() {
            set_current(provider_id, &c.id);
            return Some(c);
        }
    }
    None
}

/// Seconds until the earliest cooling credential (other than `except`)
/// recovers; `None` when one is ready now or none is cooling.
pub fn earliest_recovery(provider_id: &str, enabled: &[&Credential], except: Option<&str>) -> Option<f64> {
    let now = now_s();
    let mut best: Option<f64> = None;
    for c in enabled.iter().filter(|c| Some(c.id.as_str()) != except) {
        let wait = cooldown(provider_id, &c.id).map(|cd| cd.until - now)?;
        best = Some(best.map_or(wait, |b: f64| b.min(wait)));
    }
    best
}

// ── Lookups ─────────────────────────────────────────────────────────────────

/// A non-empty value the user exported before starting the server (values
/// a `.env` file put into the environment are not counted).
pub fn env_override(name: &str) -> Option<String> {
    crate::env::os_environ(name).filter(|v| !v.is_empty())
}

/// The credential currently serving `provider_id` (see [`select`]).
pub fn active(provider_id: &str) -> Option<Credential> {
    let f = snapshot();
    let enabled = f.enabled(provider_id);
    select(provider_id, &enabled).cloned()
}

/// Resolve `name`: exported environment, then the active credential of
/// `provider_id` (or, without one, of whichever provider stores `name`),
/// then the named secrets. Empty when unset.
pub fn lookup(provider_id: Option<&str>, name: &str) -> String {
    if let Some(v) = env_override(name) {
        return v;
    }
    stored(provider_id, name).unwrap_or_default()
}

/// [`lookup`] without the environment.
pub fn stored(provider_id: Option<&str>, name: &str) -> Option<String> {
    let f = snapshot();
    let from = |pid: &str| -> Option<String> {
        let enabled = f.enabled(pid);
        select(pid, &enabled).and_then(|c| c.value(name)).map(String::from)
    };
    let hit = match provider_id.filter(|p| !p.is_empty()) {
        Some(pid) => from(pid),
        None => f.providers.keys().find_map(|pid| from(pid)),
    };
    hit.or_else(|| f.secrets.get(name).filter(|v| !v.is_empty()).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cred(id: &str, key: &str) -> Credential {
        let mut c = Credential { id: id.into(), label: id.into(), ..Default::default() };
        c.values.insert("OPENAI_API_KEY".into(), key.into());
        c
    }

    #[test]
    fn round_trips_through_yaml_and_keeps_order() {
        let mut f = CredentialsFile { version: 1, ..Default::default() };
        f.provider_mut("openai").push(cred("b", "sk-2"));
        f.provider_mut("openai").push(cred("a", "sk-1"));
        let mut oauth = Credential { id: "c".into(), label: "me@example.com".into(), ..Default::default() };
        oauth.oauth = Some(serde_json::json!({"access_token": "t", "refresh_token": "r", "expires_at": 1730000000.5, "account_id": null}));
        f.provider_mut("codex").push(oauth);
        f.secrets.insert("X_MCP_CLIENT_SECRET".into(), "s".into());
        let text = f.to_yaml();
        assert!(text.starts_with("# OpenAgentd credentials"));
        let back = CredentialsFile::parse(&text).unwrap();
        assert_eq!(back, f);
        assert_eq!(back.provider("openai").iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn yaml_scalars_that_look_like_numbers_stay_text() {
        let f = CredentialsFile::parse("providers:\n  openai:\n  - id: a\n    values:\n      OPENAI_API_KEY: 0123\n      FLAG: yes\n").unwrap();
        let c = &f.provider("openai")[0];
        assert_eq!(c.value("FLAG"), Some("true"));
        assert_eq!(c.value("OPENAI_API_KEY"), Some("83"), "YAML 1.1 octal; still a string, never a parse error");
    }

    #[test]
    fn malformed_files_are_errors_not_empty_stores() {
        assert!(matches!(CredentialsFile::parse("providers: [1, 2"), Err(CredentialsError::Malformed(_))));
        assert!(matches!(CredentialsFile::parse("- a\n- b\n"), Err(CredentialsError::Malformed(_))));
        assert!(matches!(CredentialsFile::parse("providers:\n  openai:\n  - label: x\n"), Err(CredentialsError::Malformed(_))));
        assert!(matches!(CredentialsFile::parse("providers:\n  openai:\n  - id: a\n  - id: a\n"), Err(CredentialsError::Malformed(_))));
        assert!(matches!(CredentialsFile::parse("version: 99\n"), Err(CredentialsError::Malformed(_))));
        assert_eq!(CredentialsFile::parse("").unwrap().providers.len(), 0);
    }

    #[test]
    fn debug_output_never_contains_secret_values() {
        let mut c = cred("a", "sk-very-secret");
        c.oauth = Some(serde_json::json!({"access_token": "oauth-secret"}));
        let mut f = CredentialsFile::default();
        f.provider_mut("openai").push(c);
        f.secrets.insert("S".into(), "named-secret".into());
        let dbg = format!("{f:?}");
        assert!(!dbg.contains("sk-very-secret") && !dbg.contains("oauth-secret") && !dbg.contains("named-secret"), "{dbg}");
    }

    #[test]
    fn update_writes_owner_only_and_skips_no_op_writes() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(FILE_NAME);
        update_at(&p, |_| ()).unwrap();
        assert!(!p.exists(), "an unchanged store is not written");
        update_at(&p, |f| f.provider_mut("openai").push(cred("a", "sk-1"))).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(load_from(&p).unwrap().provider("openai")[0].value("OPENAI_API_KEY"), Some("sk-1"));
        update_at(&p, |f| f.find_mut("openai", "a").unwrap().values.insert("OPENAI_API_KEY".into(), "sk-2".into())).unwrap();
        assert_eq!(load_from(&p).unwrap().provider("openai")[0].value("OPENAI_API_KEY"), Some("sk-2"), "the read cache sees the new write");
    }

    #[test]
    fn update_refuses_to_overwrite_a_malformed_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(FILE_NAME);
        std::fs::write(&p, "providers: [").unwrap();
        assert!(update_at(&p, |f| f.secrets.insert("A".into(), "b".into())).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "providers: [");
        assert!(load_from(&p).is_err());
        assert!(snapshot_from(&p).providers.is_empty());
    }

    #[test]
    fn selection_sticks_to_the_current_credential_then_falls_through() {
        let pid = "test-select-sticky";
        let (a, b, c) = (cred("a", "1"), cred("b", "2"), cred("c", "3"));
        let enabled = vec![&a, &b, &c];
        assert_eq!(select(pid, &enabled).unwrap().id, "a");
        set_cooldown(pid, "a", now_s() + 60.0, "quota");
        assert_eq!(rotate_from(pid, "a", &enabled).unwrap().id, "b");
        clear_cooldown(pid, "a");
        assert_eq!(select(pid, &enabled).unwrap().id, "b", "a recovered, but b keeps serving until it fails");
        set_cooldown(pid, "b", now_s() + 60.0, "quota");
        assert_eq!(rotate_from(pid, "b", &enabled).unwrap().id, "c", "fall through in order after the failed one");
    }

    #[test]
    fn when_everything_cools_down_the_first_to_recover_is_chosen() {
        let pid = "test-select-all-cooling";
        let (a, b) = (cred("a", "1"), cred("b", "2"));
        let enabled = vec![&a, &b];
        set_cooldown(pid, "a", now_s() + 600.0, "quota");
        set_cooldown(pid, "b", now_s() + 30.0, "rate_limit");
        assert!(rotate_from(pid, "a", &enabled).is_none());
        assert_eq!(select(pid, &enabled).unwrap().id, "b");
        let wait = earliest_recovery(pid, &enabled, None).unwrap();
        assert!((25.0..=30.0).contains(&wait), "{wait}");
        assert!(earliest_recovery(pid, &enabled, Some("b")).unwrap() > 500.0);
    }

    #[test]
    fn a_shorter_cooldown_does_not_shorten_a_longer_one() {
        let pid = "test-cooldown-max";
        set_cooldown(pid, "a", now_s() + 600.0, "quota");
        set_cooldown(pid, "a", now_s() + 5.0, "rate_limit");
        assert_eq!(cooldown(pid, "a").unwrap().reason, "quota");
    }
}
