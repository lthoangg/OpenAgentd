//! `{CONFIG_DIR}/mcp.json` schema and I/O.

use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub struct OAuthConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

/// Which MCP HTTP transport a server speaks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HttpKind {
    /// Streamable HTTP; when `initialize` is refused with 400, 404 or 405,
    /// the legacy HTTP+SSE transport (the MCP spec's backwards
    /// compatibility rule). `mcp.json`'s `http` and `streamable-http`.
    #[default]
    Auto,
    /// Streamable HTTP only: a plugin's declared `streamable-http` (Agent
    /// Plugins defines no fallback).
    Streamable,
    /// The legacy HTTP+SSE transport (MCP 2024-11-05): `sse`.
    Sse,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServerConfig {
    /// `cwd` is the child's working directory (`None`: this process's). Only
    /// plugin servers set it: `mcp.json` has no such key, so it is neither
    /// read from nor written to that file.
    Stdio {
        command: String,
        args: Vec<String>,
        env: IndexMap<String, String>,
        enabled: bool,
        timeout: Option<u64>,
        cwd: Option<PathBuf>,
    },
    Http {
        url: String,
        headers: IndexMap<String, String>,
        oauth: Option<OAuthConfig>,
        enabled: bool,
        timeout: Option<u64>,
        kind: HttpKind,
    },
}

impl ServerConfig {
    pub fn transport(&self) -> &'static str {
        match self {
            ServerConfig::Stdio { .. } => "stdio",
            ServerConfig::Http { kind: HttpKind::Sse, .. } => "sse",
            ServerConfig::Http { .. } => "http",
        }
    }
    pub fn enabled(&self) -> bool {
        match self {
            ServerConfig::Stdio { enabled, .. } | ServerConfig::Http { enabled, .. } => *enabled,
        }
    }
    /// Tool-call deadline in seconds (`None`: the client default).
    pub fn timeout(&self) -> Option<u64> {
        match self {
            ServerConfig::Stdio { timeout, .. } | ServerConfig::Http { timeout, .. } => *timeout,
        }
    }
    /// Working directory of a stdio server's child; `None` keeps this process's.
    pub fn cwd(&self) -> Option<&Path> {
        match self {
            ServerConfig::Stdio { cwd, .. } => cwd.as_deref(),
            ServerConfig::Http { .. } => None,
        }
    }
    /// Whether the server signs in with OAuth when it asks to (a 401, per
    /// MCP authorization): every HTTP server, without an `oauth` block too,
    /// except one the user gave an `Authorization` header, which handles its
    /// own credentials.
    pub fn signs_in_with_oauth(&self) -> bool {
        match self {
            ServerConfig::Http { oauth: Some(_), .. } => true,
            ServerConfig::Http { headers, .. } => !headers.keys().any(|k| k.eq_ignore_ascii_case("authorization")),
            ServerConfig::Stdio { .. } => false,
        }
    }
    /// `model_dump(mode="json")` in field order; `timeout` only when set.
    pub fn dump(&self) -> Value {
        let mut v = self.dump_fields();
        if let Some(t) = self.timeout() {
            v["timeout"] = json!(t);
        }
        v
    }
    fn dump_fields(&self) -> Value {
        match self {
            ServerConfig::Stdio { command, args, env, enabled, .. } => json!({"transport": "stdio", "command": command, "args": args, "env": env, "enabled": enabled}),
            ServerConfig::Http { url, headers, oauth, enabled, .. } => json!({
                "transport": self.transport(), "url": url, "headers": headers,
                "oauth": oauth.as_ref().map(|o| json!({"client_id": o.client_id, "client_secret": o.client_secret})),
                "enabled": enabled,
            }),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct McpConfig {
    pub servers: IndexMap<String, ServerConfig>,
}

fn name_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_-]*$").unwrap())
}

/// Python `repr(str)` (single quotes unless the text contains one).
pub fn py_repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// `validate_server_name`.
pub fn validate_server_name(name: &str) -> Result<(), String> {
    let core = name.strip_suffix('\n').unwrap_or(name);
    if !name_re().is_match(core) {
        return Err(format!("Invalid MCP server name {}: must match ^[a-zA-Z][a-zA-Z0-9_-]*$ (letters, digits, underscore, hyphen; starting with a letter).", py_repr_str(name)));
    }
    Ok(())
}

pub fn config_path() -> PathBuf {
    appv3_core::settings().config_dir.join("mcp.json")
}

// ── validation (pydantic-shaped error text) ─────────────────────────────────

struct Errs(Vec<(String, String)>);

impl Errs {
    fn push(&mut self, loc: String, msg: &str) {
        self.0.push((loc, msg.to_string()));
    }
}

fn s_field(m: &Map<String, Value>, k: &str, loc: &str, required: bool, min1: bool, e: &mut Errs) -> String {
    match m.get(k) {
        None if required => {
            e.push(format!("{loc}.{k}"), "Field required");
            String::new()
        }
        None => String::new(),
        Some(Value::String(s)) => {
            if min1 && s.is_empty() {
                e.push(format!("{loc}.{k}"), "String should have at least 1 character");
            }
            s.clone()
        }
        Some(_) => {
            e.push(format!("{loc}.{k}"), "Input should be a valid string");
            String::new()
        }
    }
}

fn b_field(m: &Map<String, Value>, k: &str, loc: &str, e: &mut Errs) -> bool {
    match m.get(k) {
        None => true,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) || n.as_f64() == Some(1.0) => n.as_f64() == Some(1.0),
        Some(Value::String(s)) => match s.to_lowercase().as_str() {
            "0" | "off" | "f" | "false" | "n" | "no" => false,
            "1" | "on" | "t" | "true" | "y" | "yes" => true,
            _ => {
                e.push(format!("{loc}.{k}"), "Input should be a valid boolean, unable to interpret input");
                true
            }
        },
        Some(_) => {
            e.push(format!("{loc}.{k}"), "Input should be a valid boolean");
            true
        }
    }
}

fn list_field(m: &Map<String, Value>, k: &str, loc: &str, e: &mut Errs) -> Vec<String> {
    match m.get(k) {
        None => vec![],
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .filter_map(|(i, x)| match x {
                Value::String(s) => Some(s.clone()),
                _ => {
                    e.push(format!("{loc}.{k}.{i}"), "Input should be a valid string");
                    None
                }
            })
            .collect(),
        Some(_) => {
            e.push(format!("{loc}.{k}"), "Input should be a valid list");
            vec![]
        }
    }
}

fn dict_field(m: &Map<String, Value>, k: &str, loc: &str, e: &mut Errs) -> IndexMap<String, String> {
    match m.get(k) {
        None => IndexMap::new(),
        Some(Value::Object(o)) => o
            .iter()
            .filter_map(|(kk, x)| match x {
                Value::String(s) => Some((kk.clone(), s.clone())),
                _ => {
                    e.push(format!("{loc}.{k}.{kk}"), "Input should be a valid string");
                    None
                }
            })
            .collect(),
        Some(_) => {
            e.push(format!("{loc}.{k}"), "Input should be a valid dictionary");
            IndexMap::new()
        }
    }
}

fn extra(m: &Map<String, Value>, allowed: &[&str], loc: &str, e: &mut Errs) {
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            e.push(if loc.is_empty() { k.clone() } else { format!("{loc}.{k}") }, "Extra inputs are not permitted");
        }
    }
}

fn opt_s(m: &Map<String, Value>, k: &str, loc: &str, e: &mut Errs) -> Option<String> {
    match m.get(k) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            e.push(format!("{loc}.{k}"), "Input should be a valid string");
            None
        }
    }
}

/// Optional `timeout` in whole seconds, `1..=MAX_TIMEOUT_S`.
fn timeout_field(m: &Map<String, Value>, loc: &str, e: &mut Errs) -> Option<u64> {
    let max = crate::client::MAX_TIMEOUT_S;
    match m.get("timeout") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => match n.as_i64() {
            Some(i) if i < 1 => {
                e.push(format!("{loc}.timeout"), "Input should be greater than or equal to 1");
                None
            }
            Some(i) if i as u64 > max => {
                e.push(format!("{loc}.timeout"), &format!("Input should be less than or equal to {max}"));
                None
            }
            Some(i) => Some(i as u64),
            None => {
                e.push(format!("{loc}.timeout"), "Input should be a valid integer");
                None
            }
        },
        Some(_) => {
            e.push(format!("{loc}.timeout"), "Input should be a valid integer");
            None
        }
    }
}

/// Validate one server entry (discriminated by `transport`, default stdio
/// when absent — pydantic's smart-union picks whichever variant validates).
/// `type` is read as `transport`, as other MCP clients' files spell it, and
/// `streamable-http` as `http`.
fn parse_server(v: &Value, loc: &str, e: &mut Errs) -> Option<ServerConfig> {
    let Value::Object(m) = v else {
        e.push(loc.to_string(), "Input should be a valid dictionary or object to extract fields from");
        return None;
    };
    let key = match (m.get("transport"), m.get("type")) {
        (Some(t), Some(ty)) if t != ty => {
            e.push(format!("{loc}.type"), "Input should match 'transport' (give one of them)");
            return None;
        }
        (None, Some(_)) => "type",
        _ => "transport",
    };
    let transport = match m.get(key) {
        Some(Value::String(t)) => t.as_str(),
        None => {
            if m.contains_key("url") && !m.contains_key("command") {
                "http"
            } else {
                "stdio"
            }
        }
        Some(_) => "",
    };
    let start = e.0.len();
    let cfg = match transport {
        "stdio" => {
            let l = format!("{loc}.StdioServerConfig");
            let command = s_field(m, "command", &l, true, true, e);
            let args = list_field(m, "args", &l, e);
            let env = dict_field(m, "env", &l, e);
            let enabled = b_field(m, "enabled", &l, e);
            let timeout = timeout_field(m, &l, e);
            extra(m, &["transport", "type", "command", "args", "env", "enabled", "timeout"], &l, e);
            ServerConfig::Stdio { command, args, env, enabled, timeout, cwd: None }
        }
        "http" | "streamable-http" | "sse" => {
            let kind = if transport == "sse" { HttpKind::Sse } else { HttpKind::Auto };
            let l = format!("{loc}.HttpServerConfig");
            let url = s_field(m, "url", &l, true, true, e);
            let headers = dict_field(m, "headers", &l, e);
            let oauth = match m.get("oauth") {
                None | Some(Value::Null) => None,
                Some(Value::Object(o)) => {
                    let ol = format!("{l}.oauth");
                    let c = OAuthConfig { client_id: opt_s(o, "client_id", &ol, e), client_secret: opt_s(o, "client_secret", &ol, e) };
                    extra(o, &["client_id", "client_secret"], &ol, e);
                    Some(c)
                }
                Some(_) => {
                    e.push(format!("{l}.oauth"), "Input should be a valid dictionary or object to extract fields from");
                    None
                }
            };
            let enabled = b_field(m, "enabled", &l, e);
            let timeout = timeout_field(m, &l, e);
            extra(m, &["transport", "type", "url", "headers", "oauth", "enabled", "timeout"], &l, e);
            ServerConfig::Http { url, headers, oauth, enabled, timeout, kind }
        }
        _ => {
            e.push(format!("{loc}.StdioServerConfig.transport"), "Input should be 'stdio'");
            e.push(format!("{loc}.HttpServerConfig.transport"), "Input should be 'http', 'streamable-http' or 'sse'");
            return None;
        }
    };
    (e.0.len() == start).then_some(cfg)
}

/// Parse the already-decoded JSON object (`MCPConfig.model_validate`).
pub fn parse_config(raw: &Value) -> Result<McpConfig, String> {
    let Value::Object(top) = raw else { return Err("expected a JSON object at top level".into()) };
    let mut e = Errs(vec![]);
    let mut cfg = McpConfig::default();
    match top.get("servers") {
        None => {}
        Some(Value::Object(servers)) => {
            for (name, v) in servers {
                if let Some(s) = parse_server(v, &format!("servers.{name}"), &mut e) {
                    cfg.servers.insert(name.clone(), s);
                }
            }
        }
        Some(_) => e.push("servers".into(), "Input should be a valid dictionary"),
    }
    extra(top, &["servers"], "", &mut e);
    if !e.0.is_empty() {
        let n = e.0.len();
        let body: Vec<String> = e.0.iter().map(|(l, m)| format!("{l}\n  {m}")).collect();
        return Err(format!("{n} validation error{} for MCPConfig\n{}", if n == 1 { "" } else { "s" }, body.join("\n")));
    }
    for name in cfg.servers.keys() {
        validate_server_name(name)?;
    }
    Ok(cfg)
}

/// `load_config()` — empty when missing; `Err(ValueError text)` on bad files.
pub fn load_config_from(path: &Path) -> Result<McpConfig, String> {
    if !path.exists() {
        return Ok(McpConfig::default());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| format!("Invalid JSON in {}: {e}", path.display()))?;
    if !raw.is_object() {
        return Err(format!("{}: expected a JSON object at top level", path.display()));
    }
    parse_config(&raw)
}

pub fn load_config() -> Result<McpConfig, String> {
    load_config_from(&config_path())
}

fn sort_keys(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sort_keys(&m[k]))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(sort_keys).collect()),
        o => o.clone(),
    }
}

/// `json.dumps(obj, indent=2, sort_keys=True)` (ASCII-escaped like Python).
pub fn py_dumps_indent2_sorted(v: &Value) -> String {
    let pretty = serde_json::to_string_pretty(&sort_keys(v)).unwrap_or_default();
    let mut out = String::with_capacity(pretty.len());
    for c in pretty.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for u in c.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{:04x}", u));
            }
        }
    }
    out
}

/// Write `cfg` to `path` as it is, owner-only. [`save_config`] is the save
/// that also keeps secrets out of the file.
pub fn save_config_to(cfg: &McpConfig, path: &Path) -> Result<(), String> {
    for name in cfg.servers.keys() {
        validate_server_name(name)?;
    }
    let servers: Map<String, Value> = cfg.servers.iter().map(|(k, v)| (k.clone(), v.dump())).collect();
    let text = py_dumps_indent2_sorted(&json!({"servers": servers})) + "\n";
    appv3_core::secret_files::write_secret_file(path, &text).map_err(|e| e.to_string())?;
    tracing::info!("mcp_config_saved path={} servers={:?}", path.display(), cfg.servers.keys().collect::<Vec<_>>());
    Ok(())
}

/// Save the user's `mcp.json`: literal `env`, header and OAuth client values
/// go to `credentials.yaml` and the file keeps `${NAME}` references; a
/// stored secret the file no longer references is deleted.
pub fn save_config(cfg: &McpConfig) -> Result<(), String> {
    save_config_at(cfg, &config_path(), &appv3_core::credentials::path())
}

/// [`save_config`] with `mcp.json` at `path` and the credential store at `creds`.
/// The secrets are written before the file that references them, so a crash
/// in between loses nothing.
pub fn save_config_at(cfg: &McpConfig, path: &Path, creds: &Path) -> Result<(), String> {
    let before = load_config_from(path).ok();
    let (cfg, store, moved) = take_literal_secrets(cfg);
    if !store.is_empty() {
        appv3_core::credentials::update_at(creds, |f| {
            for (k, v) in store {
                f.secrets.insert(k, v);
            }
        })
        .map_err(|e| e.to_string())?;
        tracing::info!("mcp_secrets_stored entries={:?}", moved);
    }
    save_config_to(&cfg, path)?;
    let now = referenced_names(&cfg);
    let gone: Vec<String> = before.as_ref().map(referenced_names).unwrap_or_default().into_iter().filter(|n| is_stored_secret_name(n) && !now.contains(n)).collect();
    if !gone.is_empty() {
        appv3_core::credentials::update_at(creds, |f| {
            for n in &gone {
                f.secrets.shift_remove(n);
            }
        })
        .map_err(|e| e.to_string())?;
        tracing::info!("mcp_secrets_forgotten names={:?}", gone);
    }
    Ok(())
}

/// Move the literal secrets out of the user's `mcp.json` (an older file, or
/// one edited by hand) and make it owner-only. Returns the `server.key`s
/// moved. A file that does not parse is left as it is.
pub fn migrate_literal_secrets() -> Result<Vec<String>, String> {
    migrate_literal_secrets_at(&config_path(), &appv3_core::credentials::path())
}

pub fn migrate_literal_secrets_at(path: &Path, creds: &Path) -> Result<Vec<String>, String> {
    if !path.is_file() {
        return Ok(vec![]);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).map_err(|e| e.to_string())?.permissions().mode();
        if mode & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
    }
    let cfg = load_config_from(path)?;
    let (_, store, moved) = take_literal_secrets(&cfg);
    if store.is_empty() {
        return Ok(vec![]);
    }
    save_config_at(&cfg, path, creds)?;
    Ok(moved)
}

// ── secrets kept in credentials.yaml ────────────────────────────────────────

/// The named secret that holds `field` of server `server`: `<SERVER>_MCP_<FIELD>`.
pub fn secret_name(server: &str, field: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"[^A-Za-z0-9]+").unwrap());
    let norm = |s: &str| re.replace_all(s, "_").trim_matches('_').to_uppercase();
    let p = norm(server);
    format!("{}_MCP_{}", if p.is_empty() { "MCP".to_string() } else { p }, norm(field))
}

/// Whether `name` is one OpenAgentd stores for an MCP server ([`secret_name`]).
pub fn is_stored_secret_name(name: &str) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[A-Z0-9_]+_MCP_(CLIENT_ID|CLIENT_SECRET|API_KEY|ENV_[A-Z0-9_]+|HEADER_[A-Z0-9_]+)$").unwrap()).is_match(name)
}

/// Whether `value` is exactly `${NAME}` for a secret OpenAgentd stored
/// ([`is_stored_secret_name`]): Settings shows it masked, like the value.
pub fn is_stored_secret_ref(value: &str) -> bool {
    value.strip_prefix("${").and_then(|v| v.strip_suffix('}')).is_some_and(is_stored_secret_name)
}

/// A value to keep in `credentials.yaml`: not empty, not the mask, and with
/// no `$NAME` / `${NAME}` reference (one with a reference is written by hand
/// and kept as written).
fn is_literal(value: &str) -> bool {
    !value.is_empty() && value != "********" && !env_ref_re().is_match(value)
}

/// The names `cfg` references in `env`, headers and OAuth client fields.
fn referenced_names(cfg: &McpConfig) -> HashSet<String> {
    let mut out = HashSet::new();
    for sc in cfg.servers.values() {
        for v in secret_values(sc) {
            for c in env_ref_re().captures_iter(v) {
                out.insert(c.get(1).or_else(|| c.get(2)).unwrap().as_str().to_string());
            }
        }
    }
    out
}

/// The values of `sc` that may hold a secret.
pub fn secret_values(sc: &ServerConfig) -> Vec<&str> {
    match sc {
        ServerConfig::Stdio { env, .. } => env.values().map(String::as_str).collect(),
        ServerConfig::Http { headers, oauth, .. } => {
            let o = oauth.iter().flat_map(|o| [o.client_id.as_deref(), o.client_secret.as_deref()]).flatten();
            headers.values().map(String::as_str).chain(o).collect()
        }
    }
}

/// `cfg` with each literal secret replaced by a `${NAME}` reference, the
/// `(NAME, value)`s to store, and the `server.key`s moved.
pub fn take_literal_secrets(cfg: &McpConfig) -> (McpConfig, Vec<(String, String)>, Vec<String>) {
    let mut used = referenced_names(cfg);
    let mut store = vec![];
    let mut moved = vec![];
    let mut out = cfg.clone();
    for (server, sc) in out.servers.iter_mut() {
        let mut take = |field: String, label: &str, value: &mut String| {
            if !is_literal(value) {
                return;
            }
            let base = secret_name(server, &field);
            let name = (1..).map(|i| if i == 1 { base.clone() } else { format!("{base}_{i}") }).find(|n| !used.contains(n)).expect("some name is free");
            used.insert(name.clone());
            store.push((name.clone(), std::mem::replace(value, format!("${{{name}}}"))));
            moved.push(format!("{server}.{label}"));
        };
        match sc {
            ServerConfig::Stdio { env, .. } => {
                for (k, v) in env.iter_mut() {
                    take(format!("ENV_{k}"), k, v);
                }
            }
            ServerConfig::Http { headers, oauth, .. } => {
                for (k, v) in headers.iter_mut() {
                    take(format!("HEADER_{k}"), k, v);
                }
                if let Some(o) = oauth {
                    if let Some(v) = o.client_id.as_mut() {
                        take("CLIENT_ID".into(), "oauth.client_id", v);
                    }
                    if let Some(v) = o.client_secret.as_mut() {
                        take("CLIENT_SECRET".into(), "oauth.client_secret", v);
                    }
                }
            }
        }
    }
    (out, store, moved)
}

/// `url` for a log line: no query, fragment or user info, which may carry a key.
pub fn url_for_log(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut u) => {
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.to_string()
        }
        Err(_) => url.split(['?', '#']).next().unwrap_or_default().to_string(),
    }
}

// ── env refs ────────────────────────────────────────────────────────────────

fn env_ref_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)").unwrap())
}

/// `resolve_secret_refs` — expand `$VAR` / `${VAR}` from the environment,
/// then `credentials.yaml` (named secrets, then provider values).
pub fn resolve_secret_refs(value: &str) -> String {
    resolve_secret_refs_with(value, true)
}

/// [`resolve_secret_refs`]; without `providers`, the stored model provider
/// keys are not consulted (a project's server: only the environment and
/// the named secrets its approval card listed).
pub fn resolve_secret_refs_with(value: &str, providers: bool) -> String {
    if !env_ref_re().is_match(value) {
        return value.to_string();
    }
    env_ref_re()
        .replace_all(value, |c: &regex::Captures| {
            let name = c.get(1).or_else(|| c.get(2)).unwrap().as_str();
            if let Ok(v) = std::env::var(name) {
                return v;
            }
            let stored = if providers { appv3_core::credentials::stored(None, name) } else { appv3_core::credentials::stored_secret(name) };
            stored.unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

pub fn resolve_env_dict(env: &IndexMap<String, String>) -> IndexMap<String, String> {
    resolve_env_dict_with(env, true)
}

pub fn resolve_env_dict_with(env: &IndexMap<String, String>, providers: bool) -> IndexMap<String, String> {
    env.iter().map(|(k, v)| (k.clone(), resolve_secret_refs_with(v, providers))).collect()
}

#[cfg(test)]
mod tests;
