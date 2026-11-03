//! `load`: validate one plugin folder and assemble its [`Bundle`].

use std::fs;
use std::path::{Path, PathBuf};

use crate::manifest::{self, Manifest, AGENT_PLUGINS_FILE};
use crate::mcp::{self, Ctx};
use crate::skills::Scan;
use crate::util::{normalize, read_json, resolve_inside};
use crate::{fingerprint, Bundle, NAMESPACE};

/// Loads the Agent Plugins folder `root`, whose manifest is `root/plugin.json`.
/// `data_root` is where plugin data folders live; the bundle's own folder is
/// named by [`data_dir_name`] and is not created here.
///
/// `Err` carries the reason the plugin must be rejected: the manifest is
/// missing, outside the root, unreadable, or invalid. Problems with skills,
/// MCP servers, or code never fail the load; they become
/// [`Bundle::warnings`] and the component is left out.
pub fn load(root: &Path, data_root: &Path) -> Result<Bundle, String> {
    load_with(root, data_root, home_dir().as_deref())
}

/// The data folder name for a plugin: every character other than
/// `[A-Za-z0-9_-]` becomes `-`, so any manifest name is safe as one path
/// component. Names that differ only in such characters (`a.b`, `a-b`)
/// share a folder.
pub fn data_dir_name(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect()
}

/// What `~/` in permission paths expands to.
fn home_dir() -> Option<PathBuf> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// [`load`] with an explicit home folder (tests must not touch `$HOME`).
pub(crate) fn load_with(root: &Path, data_root: &Path, home: Option<&Path>) -> Result<Bundle, String> {
    let root = dunce::canonicalize(root).map_err(|e| format!("cannot open plugin folder {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }

    // A dangling `plugin.json` symlink counts as present here; `resolve_inside` below reports it.
    if fs::symlink_metadata(root.join(AGENT_PLUGINS_FILE)).is_err() {
        return Err(format!("no {AGENT_PLUGINS_FILE} found"));
    }
    let manifest_path = resolve_inside(&root, &root.join(AGENT_PLUGINS_FILE)).map_err(|why| format!("{AGENT_PLUGINS_FILE}: {why}"))?;
    if !manifest_path.is_file() {
        return Err(format!("{AGENT_PLUGINS_FILE}: not a regular file"));
    }
    let document = read_json(&manifest_path).map_err(|why| format!("{AGENT_PLUGINS_FILE}: {why}"))?;
    let Manifest { name, version, description, permissions, mut warnings } = manifest::parse_agent_plugins(document, home)?;

    // The manifest is valid: from here on nothing fails the load.
    let data_root = std::path::absolute(data_root).unwrap_or_else(|_| data_root.to_path_buf());
    let data_dir = normalize(&data_root.join(data_dir_name(&name)));
    let mut files = vec![manifest_path];

    let mut scan = Scan::new(&root, &mut warnings, &mut files);
    scan.container(&root.join("skills"));
    let skills = scan.finish();

    let mcp_servers = match (root.to_str(), data_dir.to_str()) {
        (Some(root_text), Some(data_text)) => {
            let ctx = Ctx { root: &root, root_text, data_dir: &data_dir, data_text };
            mcp::load_agent_plugins(&ctx, &mut warnings, &mut files)
        }
        _ => {
            warnings.push(format!("{}: the plugin or data folder path is not valid UTF-8; MCP servers ignored", root.display()));
            Vec::new()
        }
    };

    let code = find_code(&root, &mut warnings);
    let fingerprint = fingerprint::compute(&root, &files);
    Ok(Bundle { root, name, version, description, data_dir, skills, mcp_servers, code, permissions, warnings, fingerprint })
}

/// `dev.openagentd/plugin.ts`, else `dev.openagentd/plugin.js`: the first
/// that is a regular file resolving inside the root.
fn find_code(root: &Path, warnings: &mut Vec<String>) -> Option<PathBuf> {
    for file in ["plugin.ts", "plugin.js"] {
        let path = root.join(NAMESPACE).join(file);
        if fs::symlink_metadata(&path).is_err() {
            continue;
        }
        let label = format!("{NAMESPACE}/{file}");
        match resolve_inside(root, &path) {
            Ok(real) if real.is_file() => return Some(real),
            Ok(_) => warnings.push(format!("{label}: not a regular file; ignored")),
            Err(why) => warnings.push(format!("{label}: {why}; ignored")),
        }
    }
    None
}
