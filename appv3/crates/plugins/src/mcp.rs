//! MCP servers: the `mcp.json` of an Agent Plugins bundle.
//!
//! Every server entry is checked on its own: a bad one is skipped with a
//! warning and never affects the others. A bad file only costs its servers.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

use crate::remote;
use crate::util::{normalize, read_json, resolve_inside, resolve_lenient, shorten};
use crate::{McpServer, Transport, MCP_SCHEMA};

const STDIO_FIELDS: &[&str] = &["type", "command", "args", "env", "cwd"];
const HTTP_FIELDS: &[&str] = &["type", "url", "headers"];

const ROOT_PLACEHOLDER: &str = "${PLUGIN_ROOT}";
const DATA_PLACEHOLDER: &str = "${PLUGIN_DATA}";

/// What server entries are resolved against.
pub(crate) struct Ctx<'a> {
    /// The canonical bundle root.
    pub root: &'a Path,
    pub root_text: &'a str,
    /// The bundle's data folder: absolute and normalised, and possibly not
    /// created yet.
    pub data_dir: &'a Path,
    pub data_text: &'a str,
}

impl Ctx<'_> {
    /// Replaces `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`; other `${…}` text stays.
    fn expand(&self, text: &str) -> String {
        expand(text, &[(ROOT_PLACEHOLDER, self.root_text), (DATA_PLACEHOLDER, self.data_text)])
    }

    /// The variables the client always sets; they win over configured ones.
    fn overlay(&self, env: &mut BTreeMap<String, String>) {
        env.insert("PLUGIN_ROOT".to_string(), self.root_text.to_string());
        env.insert("PLUGIN_DATA".to_string(), self.data_text.to_string());
    }
}

/// One pass over `text`: each exact placeholder in `substitutions` is
/// replaced, and the replacement is not scanned again.
pub(crate) fn expand(text: &str, substitutions: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        match substitutions.iter().find(|(placeholder, _)| tail.starts_with(placeholder)) {
            Some((placeholder, value)) => {
                out.push_str(value);
                rest = &tail[placeholder.len()..];
            }
            None => {
                out.push_str("${");
                rest = &tail[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `mcp.json` of an Agent Plugins bundle. Any problem with the file as a
/// whole means no servers, with one warning.
pub(crate) fn load_agent_plugins(ctx: &Ctx, warnings: &mut Vec<String>, files: &mut Vec<PathBuf>) -> Vec<McpServer> {
    const FILE: &str = "mcp.json";
    const IGNORED: &str = "MCP servers ignored";
    let path = ctx.root.join(FILE);
    if fs::symlink_metadata(&path).is_err() {
        return Vec::new();
    }
    let Some(document) = read_config(ctx.root, &path, FILE, IGNORED, warnings, files) else {
        return Vec::new();
    };
    let Value::Object(top) = document else {
        warnings.push(format!("{FILE}: must be a JSON object; {IGNORED}"));
        return Vec::new();
    };
    match top.get("$schema") {
        Some(Value::String(schema)) if schema == MCP_SCHEMA => {}
        Some(other) => {
            let shown = match other {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            warnings.push(format!("{FILE}: unsupported '$schema' {}; {IGNORED}", shorten(&shown, 200)));
            return Vec::new();
        }
        None => {
            warnings.push(format!("{FILE}: missing '$schema'; {IGNORED}"));
            return Vec::new();
        }
    }
    if let Some(extra) = top.keys().find(|key| !matches!(key.as_str(), "$schema" | "mcpServers")) {
        warnings.push(format!("{FILE}: unknown top-level field '{}'; {IGNORED}", shorten(extra, 40)));
        return Vec::new();
    }
    let servers = match top.get("mcpServers") {
        Some(Value::Object(servers)) => servers,
        Some(_) => {
            warnings.push(format!("{FILE}: 'mcpServers' must be an object; {IGNORED}"));
            return Vec::new();
        }
        None => {
            warnings.push(format!("{FILE}: missing 'mcpServers'; {IGNORED}"));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    add_servers(ctx, FILE, servers, &mut out, warnings);
    out
}

/// Validates every entry of `map`; the good ones are added, the bad ones
/// reported.
fn add_servers(ctx: &Ctx, label: &str, map: &Map<String, Value>, servers: &mut Vec<McpServer>, warnings: &mut Vec<String>) {
    for (name, value) in map {
        if name.is_empty() || name.chars().any(char::is_control) {
            warnings.push(format!("{label}: a server has an invalid name; skipped"));
            continue;
        }
        match parse_entry(ctx, value) {
            Ok(transport) => servers.push(McpServer { name: name.clone(), transport }),
            Err(problem) => warnings.push(format!("{label}: server '{}' {problem}; skipped", shorten(name, 40))),
        }
    }
}

/// Reads a JSON config file that must be a regular file inside the root,
/// and records it for the fingerprint. `label` names the file in warnings
/// and `consequence` says what happens to its servers.
fn read_config(root: &Path, path: &Path, label: &str, consequence: &str, warnings: &mut Vec<String>, files: &mut Vec<PathBuf>) -> Option<Value> {
    let real = match resolve_inside(root, path) {
        Ok(real) => real,
        Err(why) => {
            warnings.push(format!("{label}: {why}; {consequence}"));
            return None;
        }
    };
    if !real.is_file() {
        warnings.push(format!("{label}: not a regular file; {consequence}"));
        return None;
    }
    files.push(real.clone());
    match read_json(&real) {
        Ok(value) => Some(value),
        Err(why) => {
            warnings.push(format!("{label}: {why}; {consequence}"));
            None
        }
    }
}

/// Checks one `mcpServers` entry. The error completes `server '<name>' …`
/// (the caller adds "; skipped").
fn parse_entry(ctx: &Ctx, value: &Value) -> Result<Transport, String> {
    let Some(object) = value.as_object() else {
        return Err("is not an object".to_string());
    };
    let kind = match object.get("type") {
        Some(Value::String(kind)) => kind.as_str(),
        Some(_) => return Err("has a 'type' that is not a string".to_string()),
        None => return Err("is missing 'type'".to_string()),
    };
    match kind {
        "stdio" => stdio(ctx, object),
        "streamable-http" => remote(object, kind).map(|(url, headers)| Transport::Http { url, headers }),
        "sse" => remote(object, kind).map(|(url, headers)| Transport::Sse { url, headers }),
        _ => Err(format!("has unknown type '{}'", shorten(kind, 40))),
    }
}

/// Rejects fields outside the variant: a field of the other variant or an
/// unknown one invalidates the entry.
fn check_fields(object: &Map<String, Value>, own: &[&str], other: &[&str], kind: &str) -> Result<(), String> {
    for key in object.keys() {
        if own.contains(&key.as_str()) {
            continue;
        }
        if other.contains(&key.as_str()) {
            return Err(format!("has field '{key}', which does not belong to a {kind} server"));
        }
        return Err(format!("has unknown field '{}'", shorten(key, 40)));
    }
    Ok(())
}

fn stdio(ctx: &Ctx, object: &Map<String, Value>) -> Result<Transport, String> {
    check_fields(object, STDIO_FIELDS, HTTP_FIELDS, "stdio")?;
    let command = match object.get("command") {
        Some(Value::String(command)) => command,
        Some(_) => return Err("has a 'command' that is not a string".to_string()),
        None => return Err("is missing 'command'".to_string()),
    };
    let command = resolve_command(ctx, command).map_err(|why| format!("has an invalid 'command' ({why})"))?;

    let mut args = Vec::new();
    if let Some(value) = object.get("args") {
        let items = value.as_array().ok_or("has an 'args' that is not an array of strings")?;
        for item in items {
            let arg = item.as_str().ok_or("has an 'args' that is not an array of strings")?;
            if arg.contains('\0') {
                return Err("has a NUL byte in 'args'".to_string());
            }
            args.push(ctx.expand(arg));
        }
    }

    let mut env = BTreeMap::new();
    if let Some(value) = object.get("env") {
        let entries = value.as_object().ok_or("has an 'env' that is not an object of strings")?;
        for (key, text) in entries {
            let text = text.as_str().ok_or_else(|| format!("has a value for env '{}' that is not a string", shorten(key, 40)))?;
            if key.is_empty() || key.contains(['=', '\0']) || text.contains('\0') {
                return Err(format!("has an invalid env entry '{}'", shorten(key, 40)));
            }
            if is_reserved_env(key) {
                return Err(format!("sets '{key}' in 'env', but the client provides it"));
            }
            env.insert(key.clone(), ctx.expand(text));
        }
    }
    ctx.overlay(&mut env);

    let cwd = match object.get("cwd") {
        None => ctx.root.to_path_buf(),
        Some(Value::String(cwd)) => resolve_cwd(ctx, cwd).map_err(|why| format!("has an invalid 'cwd' ({why})"))?,
        Some(_) => return Err("has a 'cwd' that is not a string".to_string()),
    };
    Ok(Transport::Stdio { command, args, env, cwd })
}

/// The URL and headers of a `streamable-http` or `sse` entry: both take the same fields.
fn remote(object: &Map<String, Value>, kind: &str) -> Result<(String, BTreeMap<String, String>), String> {
    check_fields(object, HTTP_FIELDS, STDIO_FIELDS, kind)?;
    // The URL and the header values are used as written: no placeholder is expanded in them.
    let url = match object.get("url") {
        Some(Value::String(url)) => url.clone(),
        Some(_) => return Err("has a 'url' that is not a string".to_string()),
        None => return Err("is missing 'url'".to_string()),
    };
    remote::check_url(&url).map_err(|why| format!("has an invalid 'url' ({why})"))?;
    let headers = match object.get("headers") {
        None => BTreeMap::new(),
        Some(Value::Object(map)) => remote::check_headers(map, &|text| text.to_string()).map_err(|why| format!("has {why}"))?,
        Some(_) => return Err("has 'headers' that is not an object of strings".to_string()),
    };
    Ok((url, headers))
}

/// `PLUGIN_ROOT` and `PLUGIN_DATA` belong to the client. (Environment names
/// are case-insensitive on Windows only.)
fn is_reserved_env(key: &str) -> bool {
    ["PLUGIN_ROOT", "PLUGIN_DATA"].iter().any(|reserved| if cfg!(windows) { key.eq_ignore_ascii_case(reserved) } else { key == *reserved })
}

/// One executable token: a bare name or a `./` path inside the root, never
/// expanded.
fn resolve_command(ctx: &Ctx, command: &str) -> Result<String, String> {
    if command.is_empty() {
        return Err("it is empty".to_string());
    }
    if command.contains('\0') {
        return Err("it contains a NUL byte".to_string());
    }
    if command.starts_with("./") {
        return command_in_root(ctx, command);
    }
    if command.contains(['/', '\\']) || command.chars().any(char::is_whitespace) {
        return Err("it must be one bare command name or a './' path inside the plugin; arguments go in 'args'".to_string());
    }
    Ok(command.to_string())
}

/// An existing file inside the root, as an absolute canonical path.
fn command_in_root(ctx: &Ctx, command: &str) -> Result<String, String> {
    let shown = shorten(command, 80);
    let real = resolve_inside(ctx.root, &ctx.root.join(command)).map_err(|why| format!("'{shown}' {why}"))?;
    if !real.is_file() {
        return Err(format!("'{shown}' is not a file"));
    }
    real.to_str().map(str::to_string).ok_or_else(|| format!("'{shown}' has a path that is not valid UTF-8"))
}

/// The working directory. After expansion it must be inside the root
/// (`./…`, `${PLUGIN_ROOT}…`) or inside the data folder (`${PLUGIN_DATA}…`).
fn resolve_cwd(ctx: &Ctx, cwd: &str) -> Result<PathBuf, String> {
    if cwd.contains('\0') {
        return Err("it contains a NUL byte".to_string());
    }
    // The form is decided on the text as written; only the rest is expanded.
    if let Some(rest) = cwd.strip_prefix(ROOT_PLACEHOLDER).filter(|rest| rest.is_empty() || rest.starts_with('/')) {
        return inside_root(ctx, &ctx.expand(rest));
    }
    if let Some(rest) = cwd.strip_prefix(DATA_PLACEHOLDER).filter(|rest| rest.is_empty() || rest.starts_with('/')) {
        return inside_data(ctx, &ctx.expand(rest));
    }
    if let Some(rest) = cwd.strip_prefix("./") {
        return inside_root(ctx, &ctx.expand(rest));
    }
    Err("it must start with './', '${PLUGIN_ROOT}' or '${PLUGIN_DATA}'".to_string())
}

/// `rest` (relative, possibly with a leading `/`) below the root. The path
/// is resolved the way the OS would, symlinks included, but may name a
/// folder that does not exist yet.
fn inside_root(ctx: &Ctx, rest: &str) -> Result<PathBuf, String> {
    let relative = Path::new(rest.trim_start_matches('/'));
    if relative.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)) {
        return Err("it must be a path inside the plugin folder".to_string());
    }
    contained_in_root(ctx, &ctx.root.join(relative))
}

fn contained_in_root(ctx: &Ctx, target: &Path) -> Result<PathBuf, String> {
    let real = resolve_lenient(target).map_err(|e| format!("it cannot be resolved ({e})"))?;
    if real.starts_with(ctx.root) {
        Ok(real)
    } else {
        Err("it resolves outside the plugin folder".to_string())
    }
}

/// `rest` below the data folder, checked textually (after `.` and `..` are
/// resolved) because the folder may not exist yet.
fn inside_data(ctx: &Ctx, rest: &str) -> Result<PathBuf, String> {
    let relative = Path::new(rest.trim_start_matches('/'));
    if relative.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)) {
        return Err("it must be a path inside the plugin data folder".to_string());
    }
    let target = normalize(&ctx.data_dir.join(relative));
    if target.starts_with(ctx.data_dir) {
        Ok(target)
    } else {
        Err("it resolves outside the plugin data folder".to_string())
    }
}
