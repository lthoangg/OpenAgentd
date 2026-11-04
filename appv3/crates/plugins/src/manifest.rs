//! Parsing of the Agent Plugins `plugin.json`. A fatal problem is an `Err`;
//! anything else becomes a warning on the returned [`Manifest`].

use std::path::Path;

use serde_json::{Map, Value};

use crate::permissions;
use crate::util::shorten;
use crate::{Permissions, NAMESPACE, PLUGIN_SCHEMA};

/// The Agent Plugins manifest, relative to the bundle root.
pub(crate) const AGENT_PLUGINS_FILE: &str = "plugin.json";

pub(crate) struct Manifest {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub permissions: Permissions,
    pub warnings: Vec<String>,
}

/// Parses and validates an Agent Plugins 1.0 `plugin.json`. `home` is what
/// `~/` in permission paths expands to.
pub(crate) fn parse_agent_plugins(value: Value, home: Option<&Path>) -> Result<Manifest, String> {
    const FILE: &str = AGENT_PLUGINS_FILE;
    let Value::Object(object) = value else {
        return Err(format!("{FILE}: must be a JSON object"));
    };

    match object.get("$schema") {
        Some(Value::String(schema)) if schema == PLUGIN_SCHEMA => {}
        Some(Value::String(schema)) => return Err(format!("unsupported Agent Plugins version: {}", shorten(schema, 200))),
        Some(other) => return Err(format!("unsupported Agent Plugins version: {}", shorten(&other.to_string(), 200))),
        None => return Err("unsupported Agent Plugins version: missing required field '$schema'".to_string()),
    }
    let name = match object.get("name") {
        Some(Value::String(name)) => name.clone(),
        Some(_) => return Err(format!("{FILE}: 'name' must be a string")),
        None => return Err(format!("{FILE}: missing required field 'name'")),
    };
    check_agent_plugins_name(&name).map_err(|why| format!("{FILE}: invalid 'name' ({why})"))?;

    let mut warnings = Vec::new();
    for (key, value) in &object {
        match key.as_str() {
            "$schema" | "name" | "extensions" => {}
            "version" | "description" | "homepage" | "repository" | "license" => {
                if !value.is_string() {
                    return Err(format!("{FILE}: '{key}' must be a string"));
                }
            }
            "author" => check_author(value).map_err(|why| format!("{FILE}: {why}"))?,
            "keywords" => {
                if !value.as_array().is_some_and(|items| items.iter().all(Value::is_string)) {
                    return Err(format!("{FILE}: 'keywords' must be an array of strings"));
                }
            }
            other => warnings.push(format!("{FILE}: unknown field '{other}' ignored")),
        }
    }

    let permissions = extension_permissions(&object, FILE, home, &mut warnings);
    Ok(Manifest { name, version: string_field(&object, "version"), description: string_field(&object, "description"), permissions, warnings })
}

/// 1 to 64 characters of `a-z 0-9 - .`, alphanumeric at both ends, no `--`
/// and no `..`.
fn check_agent_plugins_name(name: &str) -> Result<(), String> {
    let length = name.chars().count();
    if length == 0 || length > 64 {
        return Err("must be 1 to 64 characters long".to_string());
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.') {
        return Err("may only contain a-z, 0-9, '-' and '.'".to_string());
    }
    let alphanumeric = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    if !name.starts_with(alphanumeric) || !name.ends_with(alphanumeric) {
        return Err("must start and end with a letter or digit".to_string());
    }
    if name.contains("--") || name.contains("..") {
        return Err("must not contain '--' or '..'".to_string());
    }
    Ok(())
}

/// `author` is an object with only the optional string fields `name`,
/// `email`, and `url`.
fn check_author(value: &Value) -> Result<(), String> {
    let Some(author) = value.as_object() else {
        return Err("'author' must be an object".to_string());
    };
    for (key, field) in author {
        if !matches!(key.as_str(), "name" | "email" | "url") {
            return Err(format!("'author' has unknown field '{}'", shorten(key, 40)));
        }
        if !field.is_string() {
            return Err(format!("'author.{key}' must be a string"));
        }
    }
    Ok(())
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_string)
}

/// `extensions["dev.openagentd"].permissions`. Other namespaces are never
/// looked at. Anything wrong gives the default (no permissions) and a warning.
fn extension_permissions(object: &Map<String, Value>, file: &str, home: Option<&Path>, warnings: &mut Vec<String>) -> Permissions {
    let Some(extensions) = object.get("extensions") else {
        return Permissions::default();
    };
    let Some(extensions) = extensions.as_object() else {
        warnings.push(format!("{file}: 'extensions' is not an object; ignored"));
        return Permissions::default();
    };
    let Some(namespace) = extensions.get(NAMESPACE) else {
        return Permissions::default();
    };
    let Some(namespace) = namespace.as_object() else {
        warnings.push(format!("{file}: extensions[\"{NAMESPACE}\"] is not an object; ignored"));
        return Permissions::default();
    };
    let Some(permissions) = namespace.get("permissions") else {
        return Permissions::default();
    };
    match permissions::parse(permissions, home) {
        Ok((permissions, unknown)) => {
            for key in unknown {
                warnings.push(format!("{file}: unknown permission '{}' ignored", shorten(&key, 40)));
            }
            permissions
        }
        Err(why) => {
            warnings.push(format!("{file}: invalid permissions ({why}); the plugin's code gets no permissions"));
            Permissions::default()
        }
    }
}
