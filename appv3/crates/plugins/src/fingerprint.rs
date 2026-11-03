//! The bundle fingerprint: a hash of (relative path, length, modification
//! time) over every file that defines the bundle.
//!
//! Only metadata is read, so hashing stays cheap enough to repeat on every
//! refresh. The hash is for change detection within one build; it is not
//! meant to be stored across toolchain upgrades.

use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::util::{display_rel, resolve_inside};
use crate::NAMESPACE;

/// Folders under `dev.openagentd/` that are never hashed: dependencies and
/// version-control data change without the bundle changing.
const SKIPPED_DIRS: [&str; 2] = ["node_modules", ".git"];

/// Most files hashed under `dev.openagentd/`, so a huge tree cannot make
/// every refresh slow.
const MAX_CODE_FILES: usize = 10_000;

/// The deepest folder level walked under `dev.openagentd/`.
const MAX_DEPTH: usize = 32;

/// `files` are canonical paths inside `root` that were read (the manifest,
/// MCP files, `SKILL.md` files); the code folder is walked here.
pub(crate) fn compute(root: &Path, files: &[PathBuf]) -> u64 {
    let mut entries: BTreeMap<String, (u64, u128)> = BTreeMap::new();
    for file in files {
        if let Ok(metadata) = fs::metadata(file) {
            entries.insert(display_rel(root, file), (metadata.len(), modified(&metadata)));
        }
    }

    let code_dir = root.join(NAMESPACE);
    if resolve_inside(root, &code_dir).is_ok_and(|real| real.is_dir()) {
        let mut budget = MAX_CODE_FILES;
        walk(root, &code_dir, 0, &mut budget, &mut entries);
    }

    let mut hasher = DefaultHasher::new();
    for (path, (length, modified)) in &entries {
        path.hash(&mut hasher);
        length.hash(&mut hasher);
        modified.hash(&mut hasher);
    }
    hasher.finish()
}

/// Adds every file under `dir`. Real folders are entered (except the
/// skipped ones); symlinks to files count with their target's metadata, and
/// symlinks to folders are not followed.
fn walk(root: &Path, dir: &Path, depth: usize, budget: &mut usize, entries: &mut BTreeMap<String, (u64, u128)>) {
    let Ok(children) = fs::read_dir(dir) else {
        return;
    };
    for child in children.flatten() {
        if *budget == 0 {
            return;
        }
        let path = child.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            let skipped = SKIPPED_DIRS.iter().any(|name| child.file_name() == *name);
            if !skipped && depth < MAX_DEPTH {
                walk(root, &path, depth + 1, budget, entries);
            }
            continue;
        }
        let metadata = if metadata.file_type().is_symlink() {
            match fs::metadata(&path) {
                Ok(target) => target,
                Err(_) => continue,
            }
        } else {
            metadata
        };
        if metadata.is_file() {
            *budget -= 1;
            entries.insert(display_rel(root, &path), (metadata.len(), modified(&metadata)));
        }
    }
}

/// Modification time in nanoseconds since the epoch (0 when unknown).
fn modified(metadata: &fs::Metadata) -> u128 {
    metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)
}
