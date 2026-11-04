//! Plugin bundles: a folder with a manifest that adds skills, MCP servers,
//! and (in `dev.openagentd/`) QuickJS code to the server.
//!
//! The folder follows Agent Plugins 1.0 (`plugin.json`, `skills/`,
//! `mcp.json`). Everything specific to this server lives under the
//! `dev.openagentd` extension namespace: the manifest's
//! `extensions["dev.openagentd"]` object and the `dev.openagentd/` folder.
//!
//! The crate is pure. [`discover`] lists candidate folders and [`load`]
//! validates one into a [`Bundle`]; both only read files. Nothing here
//! starts a process or opens a socket, and the one write is
//! [`set_enabled`], which updates `plugins.json`. Every path a bundle
//! supplies (manifest, MCP files, `SKILL.md`, code, `./` commands and
//! working directories) must resolve inside the bundle's canonical root;
//! a manifest that does not is rejected, anything else is skipped with a
//! warning in [`Bundle::warnings`].

mod find;
mod fingerprint;
mod loader;
mod manifest;
mod mcp;
mod permissions;
mod remote;
mod skills;
mod state;
mod util;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::PathBuf;

pub use find::discover;
pub use loader::{data_dir_name, load};
pub use state::{disabled, set_enabled, STATE_FILE};

/// The extension namespace: the manifest `extensions` key and the folder.
pub const NAMESPACE: &str = "dev.openagentd";

/// What a bundle's code may do, from
/// `extensions["dev.openagentd"].permissions`. The default allows nothing
/// beyond reading the bundle's own files and writing its data folder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Permissions {
    /// Hosts `fetch` may reach.
    pub net: Net,
    /// May open a local listening port (an OAuth callback).
    pub listen: bool,
    /// More folders the code may read and write (absolute paths).
    pub fs: Vec<PathBuf>,
    /// Commands, by bare name, the code may run.
    pub subprocess: Vec<String>,
    /// Environment variables the code may read.
    pub env: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Net {
    /// No network access (the default).
    #[default]
    None,
    /// Only these hosts; `*.example.com` also matches subdomains.
    Hosts(Vec<String>),
    /// Any host (`"net": true`).
    Any,
}

/// The `$schema` value of an Agent Plugins 1.0 `plugin.json`.
pub const PLUGIN_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/// The `$schema` value of an Agent Plugins 1.0 `mcp.json`.
pub const MCP_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/// A validated plugin folder: what [`load`] returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    /// The canonical bundle root (`dunce::canonicalize`).
    pub root: PathBuf,
    /// The manifest `name`.
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    /// The bundle's persistent data folder: `data_root.join(data_dir_name(&name))`.
    /// [`load`] does not create it.
    pub data_dir: PathBuf,
    pub skills: Vec<Skill>,
    pub mcp_servers: Vec<McpServer>,
    /// The canonical `dev.openagentd/plugin.ts`, else `dev.openagentd/plugin.js`,
    /// when one exists inside the root.
    pub code: Option<PathBuf>,
    /// From `extensions["dev.openagentd"].permissions`; the default (nothing
    /// allowed) when absent or invalid.
    pub permissions: Permissions,
    /// Non-fatal problems, each starting with the file they concern, e.g.
    /// `plugin.json: unknown field 'commands' ignored`.
    pub warnings: Vec<String>,
    /// Changes when a file that defines the bundle changes: the manifest,
    /// every MCP file and `SKILL.md` that was read, and everything under
    /// `dev.openagentd/` (except `node_modules` and `.git`). Computed from
    /// each file's relative path, length, and modification time.
    pub fingerprint: u64,
}

/// One skill: a folder holding a `SKILL.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    /// The folder name. A different `name:` in the frontmatter only warns.
    pub name: String,
    /// The canonical skill folder, inside the bundle root.
    pub dir: PathBuf,
    /// From the `SKILL.md` frontmatter; never empty.
    pub description: String,
}

/// One MCP server a bundle declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServer {
    /// The key in `mcpServers`.
    pub name: String,
    pub transport: Transport,
}

/// How to reach an MCP server, with every placeholder already expanded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    /// A local process.
    ///
    /// `command` is the absolute path for a `./` command (always inside the
    /// root), else the bare name as written. `env` is the configured
    /// environment (placeholders expanded) overlaid with `PLUGIN_ROOT` and
    /// `PLUGIN_DATA`. `cwd` is the plugin root when not configured.
    Stdio { command: String, args: Vec<String>, env: BTreeMap<String, String>, cwd: PathBuf },
    /// A remote `"streamable-http"` server. The URL is absolute `http(s)`,
    /// without user information or a fragment, and plain `http` only for
    /// loopback.
    Http { url: String, headers: BTreeMap<String, String> },
    /// A remote `"sse"` server (the legacy HTTP+SSE transport); the same
    /// fields and checks as [`Transport::Http`].
    Sse { url: String, headers: BTreeMap<String, String> },
}
