//! `agentd plugin`: install, remove, list, and check plugin bundles.
//!
//! A plugin is a folder with a manifest (`plugin.json`) that adds skills, MCP
//! servers and, in `dev.openagentd/`, code with tools. Nothing here starts
//! what a plugin ships. `add` and `check` read the manifest (the loader only
//! reads files) and run the plugin's code once, in a sandbox that grants
//! nothing and with a scratch data folder, only to list its tools. A running
//! server picks a change up through `POST /api/plugins/reload`.
//!
//! What a plugin supplies is untrusted text, and the summary is what the user
//! approves an install on: it reaches the terminal only through
//! [`render::exact`] and [`render::inline`], which show control and
//! direction-changing characters as escapes instead of acting on them.

mod check;
mod list;
mod render;
mod server;
mod summary;

use crate::cli::PluginCmd;
use anyhow::Result;
use appv3_plugins::{discover, load, Bundle};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

pub fn plugin(cmd: &PluginCmd) -> Result<ExitCode> {
    match cmd {
        PluginCmd::List => list::list(),
        PluginCmd::Check(a) => check::check(a),
    }
}

// ── where plugins are, and what is installed ────────────────────────────────

struct Ctx {
    /// Where plugins live; `add` installs into the first.
    dirs: Vec<PathBuf>,
    config_dir: PathBuf,
    /// Plugin data folders, one per plugin.
    data_root: PathBuf,
}

impl Ctx {
    fn new() -> Self {
        // As `agentd doctor`: settings may come from the config dir's `.env`.
        appv3_core::env::init_env();
        let s = appv3_core::settings();
        appv3_core::env::load_config_env(&s.config_dir);
        let absolute = |p: &PathBuf| std::path::absolute(p).unwrap_or_else(|_| p.clone());
        Ctx { dirs: s.plugins_dirs.iter().map(absolute).collect(), config_dir: s.config_dir.clone(), data_root: s.data_dir.join("plugin-data") }
    }
}

/// A folder in a plugins folder that holds a manifest, loaded or not.
struct Installed {
    folder: PathBuf,
    bundle: Result<Bundle, String>,
}

impl Installed {
    fn folder_name(&self) -> String {
        self.folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

fn installed(dirs: &[PathBuf], data_root: &Path) -> Vec<Installed> {
    discover(dirs).into_iter().map(|folder| Installed { bundle: load(&folder, data_root), folder }).collect()
}

/// What the unit tests of several modules share.
#[cfg(test)]
mod testing {
    use super::render::{plain_text, Line};
    use appv3_plugins::{MCP_SCHEMA, PLUGIN_SCHEMA};
    use serde_json::json;
    use std::path::Path;

    pub(super) fn put(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A plugin that asks for everything, with hostile text in it.
    pub(super) fn demo_plugin(root: &Path) {
        let manifest = json!({
            "$schema": PLUGIN_SCHEMA,
            "name": "demo",
            "version": "1.2.3",
            "description": "Demo\u{1b}[31m plugin\nwith two lines",
            "mystery": true,
            "extensions": {"dev.openagentd": {"permissions": {
                "net": ["api.example.com", "*.example.org"], "listen": true, "fs": ["/tmp/oad-shared"], "subprocess": ["git"], "env": ["HOME", "TOKEN"]
            }}}
        });
        put(root, "plugin.json", &manifest.to_string());
        put(root, "skills/helper/SKILL.md", "---\nname: helper\ndescription: Helps.\n---\nBody\n");
        let servers = json!({
            "$schema": MCP_SCHEMA,
            "mcpServers": {
                "local": {
                    "type": "stdio", "command": "npx",
                    "args": ["-y", "@acme/server", "--label", "two words", "it's", "${PLUGIN_ROOT}/data"],
                    "env": {"API_KEY": "${GITHUB_TOKEN}", "MODE": "fast", "OTHER": "$OTHER_VAR and ${PLUGIN_DATA}"}
                },
                "remote": {"type": "streamable-http", "url": "https://mcp.example.com/api", "headers": {"Authorization": "Bearer ${REMOTE_KEY}"}}
            }
        });
        put(root, "mcp.json", &servers.to_string());
    }

    pub(super) fn text(lines: &[Line]) -> Vec<String> {
        plain_text(lines)
    }
}
