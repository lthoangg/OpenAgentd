//! Parsing of `extensions["dev.openagentd"].permissions`.
//!
//! Strict on purpose: one invalid value invalidates the whole object, and
//! the caller then gives the bundle's code no permissions at all.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::util::{normalize, shorten};
use crate::{Net, Permissions};

/// Parses the `permissions` object. On success also returns the names of
/// keys this version does not know (they are ignored; the caller warns).
/// `home` is what `~/` expands to.
pub(crate) fn parse(value: &Value, home: Option<&Path>) -> Result<(Permissions, Vec<String>), String> {
    let object = value.as_object().ok_or("expected an object")?;
    let mut net = Net::None;
    let mut listen = false;
    let mut fs = Vec::new();
    let mut subprocess = Vec::new();
    let mut env = Vec::new();
    let mut unknown = Vec::new();
    for (key, value) in object {
        match key.as_str() {
            "net" => net = parse_net(value)?,
            "listen" => listen = value.as_bool().ok_or("listen: expected true or false")?,
            "fs" => fs = parse_fs(value, home)?,
            "subprocess" => subprocess = parse_names(value, "subprocess", check_command_name)?,
            "env" => env = parse_names(value, "env", check_env_name)?,
            other => unknown.push(other.to_string()),
        }
    }
    Ok((Permissions { net, listen, fs, subprocess, env }, unknown))
}

fn parse_net(value: &Value) -> Result<Net, String> {
    match value {
        Value::Bool(true) => Ok(Net::Any),
        Value::Bool(false) => Ok(Net::None),
        Value::Array(items) => {
            let mut hosts: Vec<String> = Vec::new();
            for (i, item) in items.iter().enumerate() {
                let text = item.as_str().ok_or_else(|| format!("net[{i}]: expected a string"))?;
                let host = parse_host(text).map_err(|why| format!("net[{i}]: {why}"))?;
                if !hosts.contains(&host) {
                    hosts.push(host);
                }
            }
            // An empty list allows exactly what `false` does; keep one form.
            Ok(if hosts.is_empty() { Net::None } else { Net::Hosts(hosts) })
        }
        _ => Err("net: expected true, false or an array of host names".to_string()),
    }
}

/// A lowercase host name (or IPv4 address), optionally `*.`-prefixed.
/// Schemes, ports, paths, and IPv6 literals are refused: they would never
/// match, and a silent miss is worse than a warning.
fn parse_host(text: &str) -> Result<String, String> {
    let host = text.to_ascii_lowercase();
    let base = host.strip_prefix("*.").unwrap_or(&host);
    let valid = !base.is_empty()
        && host.len() <= 253
        && base.split('.').all(|label| !label.is_empty() && !label.starts_with('-') && !label.ends_with('-') && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    if valid {
        Ok(host)
    } else {
        Err(format!("'{}' is not a host name (use names like 'api.example.com' or '*.example.com', without scheme, port or path)", shorten(text, 80)))
    }
}

fn parse_fs(value: &Value, home: Option<&Path>) -> Result<Vec<PathBuf>, String> {
    let items = value.as_array().ok_or("fs: expected an array of paths")?;
    let mut paths: Vec<PathBuf> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let text = item.as_str().ok_or_else(|| format!("fs[{i}]: expected a string"))?;
        let path = expand_fs_path(text, home).map_err(|why| format!("fs[{i}]: {why}"))?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// An absolute path or a `~/` path: canonical when it exists, else
/// normalised textually (so `..` cannot hide in it).
fn expand_fs_path(text: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    if text.contains('\0') {
        return Err("contains a NUL byte".to_string());
    }
    let path = if let Some(rest) = text.strip_prefix("~/") {
        home.ok_or("starts with '~/' but no home folder is known")?.join(rest)
    } else if Path::new(text).is_absolute() {
        PathBuf::from(text)
    } else {
        return Err(format!("'{}' is not an absolute path or a '~/' path", shorten(text, 80)));
    };
    Ok(dunce::canonicalize(&path).unwrap_or_else(|_| normalize(&path)))
}

fn parse_names(value: &Value, key: &str, check: fn(&str) -> Result<(), String>) -> Result<Vec<String>, String> {
    let items = value.as_array().ok_or_else(|| format!("{key}: expected an array of strings"))?;
    let mut names: Vec<String> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let name = item.as_str().ok_or_else(|| format!("{key}[{i}]: expected a string"))?;
        check(name).map_err(|why| format!("{key}[{i}]: {why}"))?;
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

/// A bare command name: no path separators, no whitespace.
fn check_command_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().any(|c| c == '/' || c == '\\' || c == '\0' || c.is_whitespace()) {
        return Err(format!("'{}' is not a bare command name (no '/', '\\' or spaces)", shorten(name, 80)));
    }
    Ok(())
}

fn check_env_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().any(|c| c == '=' || c == '\0' || c.is_whitespace()) {
        return Err(format!("'{}' is not an environment variable name", shorten(name, 80)));
    }
    Ok(())
}
