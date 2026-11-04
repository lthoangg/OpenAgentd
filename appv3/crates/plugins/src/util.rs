//! Filesystem and text helpers shared by the parsers: containment checks,
//! lexical path normalisation, and size-capped reads.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// Largest manifest or MCP file that is read; a bigger one is refused.
const MAX_JSON_BYTES: u64 = 1024 * 1024;

/// Canonicalizes `path` and requires the result to lie inside `root` (which
/// must itself be canonical). The error is a short phrase that completes
/// `<path> <error>`, for use in warnings.
pub(crate) fn resolve_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    match dunce::canonicalize(path) {
        Ok(real) if real.starts_with(root) => Ok(real),
        Ok(_) => Err("resolves outside the plugin folder".to_string()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err("does not exist".to_string()),
        Err(e) => Err(format!("cannot be resolved ({e})")),
    }
}

/// Like `canonicalize`, but the tail of `path` may not exist yet: the
/// deepest existing ancestor is canonicalized (so symlinks there are
/// followed) and the missing components are appended as written.
pub(crate) fn resolve_lenient(path: &Path) -> io::Result<PathBuf> {
    let mut missing: Vec<&OsStr> = Vec::new();
    let mut current = path;
    loop {
        match dunce::canonicalize(current) {
            Ok(mut real) => {
                real.extend(missing.iter().rev().copied());
                return Ok(real);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => match (current.file_name(), current.parent()) {
                (Some(name), Some(parent)) => {
                    missing.push(name);
                    current = parent;
                }
                _ => return Err(e),
            },
            Err(e) => return Err(e),
        }
    }
}

/// Resolves `.` and `..` textually, without touching the filesystem.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path` relative to `root`, with `/` separators (`.` for the root itself);
/// used as the file label in warnings.
pub(crate) fn display_rel(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let text = relative.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    if text.is_empty() {
        ".".to_string()
    } else {
        text
    }
}

/// Whether `dir` has an entry named exactly `name`. A plain `join` + `exists`
/// would also match `skill.md` on a case-insensitive filesystem.
pub(crate) fn has_entry(dir: &Path, name: &str) -> bool {
    fs::read_dir(dir).map(|entries| entries.flatten().any(|e| e.file_name() == OsStr::new(name))).unwrap_or(false)
}

/// Reads and parses a JSON file of at most 1 MiB (a UTF-8 BOM is accepted).
/// The error is a short phrase that completes `<path> <error>`.
pub(crate) fn read_json(path: &Path) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let read = fs::File::open(path).and_then(|file| file.take(MAX_JSON_BYTES + 1).read_to_end(&mut bytes));
    if let Err(e) = read {
        return Err(format!("cannot be read ({e})"));
    }
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err(format!("is larger than {} KiB", MAX_JSON_BYTES / 1024));
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    serde_json::from_slice(body).map_err(|e| format!("is not valid JSON ({e})"))
}

/// The first `limit` bytes of a file as text (invalid UTF-8 is replaced).
pub(crate) fn read_head(path: &Path, limit: u64) -> io::Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(limit).read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `text` cut to `max` characters, with an ellipsis when cut.
pub(crate) fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}…")
}
