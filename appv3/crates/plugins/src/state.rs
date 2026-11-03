//! `plugins.json`: which plugins the user turned off.
//!
//! `{config_dir}/plugins.json` is `{"disabled": ["name", …]}`. Reading is
//! forgiving (a missing or broken file means nothing is disabled); writing
//! is atomic.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;

use serde_json::{Map, Value};

const FILE: &str = "plugins.json";

/// Serialises writers in this process, so two `set_enabled` calls cannot
/// lose each other's change. The rename makes each write atomic on disk.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The names of the disabled plugins, from `{config_dir}/plugins.json`. A
/// missing or invalid file disables nothing.
pub fn disabled(config_dir: &Path) -> BTreeSet<String> {
    let path = config_dir.join(FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                tracing::warn!(path = %path.display(), error = %e, "cannot read the plugin state file");
            }
            return BTreeSet::new();
        }
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(document) => names(document.get("disabled")),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "the plugin state file is not valid JSON; no plugin is disabled");
            BTreeSet::new()
        }
    }
}

/// Enables or disables the plugin `name` and writes `plugins.json`
/// atomically (a temporary file, then a rename), creating `config_dir` if
/// needed. Other keys in an existing file are kept; an invalid file is
/// replaced.
pub fn set_enabled(config_dir: &Path, name: &str, enabled: bool) -> io::Result<()> {
    if name.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the plugin name is empty"));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    fs::create_dir_all(config_dir)?;
    let path = config_dir.join(FILE);

    let mut document = match fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let mut set = names(document.get("disabled"));
    if enabled {
        set.remove(name);
    } else {
        set.insert(name.to_string());
    }
    document.insert("disabled".to_string(), Value::Array(set.into_iter().map(Value::String).collect()));

    let mut text = serde_json::to_string_pretty(&Value::Object(document)).map_err(io::Error::other)?;
    text.push('\n');
    write_atomic(&path, text.as_bytes())
}

fn names(value: Option<&Value>) -> BTreeSet<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = fs::File::create(&temporary).and_then(|mut file| {
        file.write_all(data)?;
        file.sync_all()
    });
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
