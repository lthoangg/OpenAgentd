//! `{CONFIG_DIR}/mcp.json` schema and I/O — port of `app/agent/mcp/config.py`.

use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub struct OAuthConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServerConfig {
    Stdio { command: String, args: Vec<String>, env: IndexMap<String, String>, enabled: bool, timeout: Option<u64> },
    Http { url: String, headers: IndexMap<String, String>, oauth: Option<OAuthConfig>, enabled: bool, timeout: Option<u64> },
}

impl ServerConfig {
    pub fn transport(&self) -> &'static str {
        match self {
            ServerConfig::Stdio { .. } => "stdio",
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
                "transport": "http", "url": url, "headers": headers,
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
fn parse_server(v: &Value, loc: &str, e: &mut Errs) -> Option<ServerConfig> {
    let Value::Object(m) = v else {
        e.push(loc.to_string(), "Input should be a valid dictionary or object to extract fields from");
        return None;
    };
    let transport = match m.get("transport") {
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
            extra(m, &["transport", "command", "args", "env", "enabled", "timeout"], &l, e);
            ServerConfig::Stdio { command, args, env, enabled, timeout }
        }
        "http" => {
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
            extra(m, &["transport", "url", "headers", "oauth", "enabled", "timeout"], &l, e);
            ServerConfig::Http { url, headers, oauth, enabled, timeout }
        }
        _ => {
            e.push(format!("{loc}.StdioServerConfig.transport"), "Input should be 'stdio'");
            e.push(format!("{loc}.HttpServerConfig.transport"), "Input should be 'http'");
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

pub fn save_config_to(cfg: &McpConfig, path: &Path) -> Result<(), String> {
    for name in cfg.servers.keys() {
        validate_server_name(name)?;
    }
    let servers: Map<String, Value> = cfg.servers.iter().map(|(k, v)| (k.clone(), v.dump())).collect();
    let text = py_dumps_indent2_sorted(&json!({"servers": servers})) + "\n";
    appv3_core::secret_files::write_atomic(path, &text).map_err(|e| e.to_string())?;
    tracing::info!("mcp_config_saved path={} servers={:?}", path.display(), cfg.servers.keys().collect::<Vec<_>>());
    Ok(())
}

pub fn save_config(cfg: &McpConfig) -> Result<(), String> {
    save_config_to(cfg, &config_path())
}

// ── env refs ────────────────────────────────────────────────────────────────

fn env_ref_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)").unwrap())
}

fn dotenv_snapshot() -> HashMap<String, String> {
    let path = appv3_core::settings().config_dir.join(".env");
    let mut out = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else { return out };
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let t = t.strip_prefix("export ").unwrap_or(t);
        let Some((k, v)) = t.split_once('=') else { continue };
        let mut v = v.trim().to_string();
        if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
            let dq = v.starts_with('"');
            v = v[1..v.len() - 1].to_string();
            if dq {
                v = v.replace("\\\"", "\"").replace("\\\\", "\\");
            }
        }
        out.insert(k.trim().to_string(), v);
    }
    out
}

/// `resolve_secret_refs` — expand `$VAR` / `${VAR}` from env, then `.env`.
pub fn resolve_secret_refs(value: &str) -> String {
    if !env_ref_re().is_match(value) {
        return value.to_string();
    }
    let snap = OnceLock::new();
    env_ref_re()
        .replace_all(value, |c: &regex::Captures| {
            let name = c.get(1).or_else(|| c.get(2)).unwrap().as_str();
            if let Ok(v) = std::env::var(name) {
                return v;
            }
            snap.get_or_init(dotenv_snapshot).get(name).cloned().unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

pub fn resolve_env_dict(env: &IndexMap<String, String>) -> IndexMap<String, String> {
    env.iter().map(|(k, v)| (k.clone(), resolve_secret_refs(v))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_errors() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("mcp.json");
        assert!(load_config_from(&p).unwrap().servers.is_empty());
        std::fs::write(&p, r#"{"servers":{"fs":{"command":"npx","args":["-y"]},"gh":{"transport":"http","url":"https://x","headers":{"A":"é"}}}}"#).unwrap();
        let c = load_config_from(&p).unwrap();
        assert_eq!(c.servers["fs"].transport(), "stdio");
        save_config_to(&c, &p).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"A\": \"\\u00e9\""), "{text}");
        assert!(text.starts_with("{\n  \"servers\": {\n    \"fs\": {\n      \"args\": [\n        \"-y\"\n      ],"), "{text}");
        assert_eq!(load_config_from(&p).unwrap(), c);
        std::fs::write(&p, r#"{"servers":{"1bad":{"command":"x"}}}"#).unwrap();
        assert!(load_config_from(&p).unwrap_err().starts_with("Invalid MCP server name '1bad'"));
        std::fs::write(&p, r#"{"servers":{"a":{"command":""}}}"#).unwrap();
        assert!(load_config_from(&p).unwrap_err().contains("String should have at least 1 character"));
    }

    #[test]
    fn env_refs() {
        std::env::set_var("OAD_MCP_TEST_X", "v");
        assert_eq!(resolve_secret_refs("a ${OAD_MCP_TEST_X} $OAD_MCP_TEST_X $NOPE_OAD_Z"), "a v v $NOPE_OAD_Z");
    }
}
