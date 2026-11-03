//! `discover`: find the candidate plugin folders inside configured folders.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::manifest::AGENT_PLUGINS_FILE;

/// The plugin folders directly inside each of `dirs`: immediate subfolders
/// holding `plugin.json`.
///
/// Each directory's folders are sorted by name and the directories keep the
/// order given. A folder reached twice (the same directory listed twice, or a
/// symlink) is returned once, at its first position. Names starting with `.`
/// or `_` are skipped, and so are missing directories. The paths are as
/// listed (not canonicalised); [`load`](crate::load) canonicalises.
/// This only looks for the manifest file; [`load`](crate::load) validates it.
pub fn discover(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for dir in dirs {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(dir = %dir.display(), error = %e, "cannot list plugin folder");
                }
                continue;
            }
        };
        let mut folders: Vec<(OsString, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                if matches!(name.as_encoded_bytes().first(), Some(b'.' | b'_')) {
                    return None;
                }
                let path = entry.path();
                (path.is_dir() && has_manifest(&path)).then_some((name, path))
            })
            .collect();
        folders.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, path) in folders {
            if seen.insert(dunce::canonicalize(&path).unwrap_or_else(|_| path.clone())) {
                found.push(path);
            }
        }
    }
    found
}

fn has_manifest(folder: &Path) -> bool {
    folder.join(AGENT_PLUGINS_FILE).is_file()
}
