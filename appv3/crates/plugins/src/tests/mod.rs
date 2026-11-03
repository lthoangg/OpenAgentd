//! Unit tests, grouped by the part of the format they cover. Each builds a
//! throw-away plugin folder with [`Fixture`].

mod code;
mod discover;
mod fingerprint;
mod manifest;
mod mcp;
mod permissions;
mod remote;
mod skills;
mod state;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tempfile::TempDir;

use crate::{Bundle, Transport, MCP_SCHEMA, PLUGIN_SCHEMA};

/// A plugin folder in a temporary directory, with a data root beside it.
struct Fixture {
    dir: TempDir,
    data: TempDir,
}

impl Fixture {
    /// An empty folder.
    fn empty() -> Self {
        Fixture { dir: tempfile::tempdir().unwrap(), data: tempfile::tempdir().unwrap() }
    }

    /// A folder with the smallest valid Agent Plugins manifest.
    fn agent_plugins(name: &str) -> Self {
        let fixture = Self::empty();
        fixture.write_json("plugin.json", &json!({ "$schema": PLUGIN_SCHEMA, "name": name }));
        fixture
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn data_root(&self) -> &Path {
        self.data.path()
    }

    /// The canonical root: what `Bundle::root` holds.
    fn real_root(&self) -> PathBuf {
        dunce::canonicalize(self.root()).unwrap()
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root().join(relative)
    }

    /// Writes a file (and its folders) relative to the root.
    fn write(&self, relative: &str, text: &str) -> &Self {
        let path = self.path(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        self
    }

    fn write_json(&self, relative: &str, value: &Value) -> &Self {
        self.write(relative, &serde_json::to_string_pretty(value).unwrap())
    }

    /// An Agent Plugins manifest: the minimal one plus the fields of `extra`.
    fn manifest(&self, name: &str, extra: Value) -> &Self {
        let mut manifest = json!({ "$schema": PLUGIN_SCHEMA, "name": name });
        manifest.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        self.write_json("plugin.json", &manifest)
    }

    /// `skills/<name>/SKILL.md` with a description.
    fn skill(&self, name: &str, description: &str) -> &Self {
        self.write(&format!("skills/{name}/SKILL.md"), &format!("---\nname: {name}\ndescription: {description}\n---\n\nBody.\n"))
    }

    /// An executable file (a shell script on Unix).
    fn script(&self, relative: &str) -> &Self {
        self.write(relative, "#!/bin/sh\nexit 0\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(self.path(relative), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        self
    }

    /// `mcp.json` with the given `mcpServers`.
    fn mcp(&self, servers: Value) -> &Self {
        self.write_json("mcp.json", &json!({ "$schema": MCP_SCHEMA, "mcpServers": servers }))
    }

    /// Makes `link` (relative to the root) a symlink to `target`.
    #[cfg(unix)]
    fn symlink(&self, target: &Path, link: &str) -> &Self {
        let link = self.path(link);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, link).unwrap();
        self
    }

    fn load(&self) -> Result<Bundle, String> {
        crate::load(self.root(), self.data_root())
    }

    fn bundle(&self) -> Bundle {
        self.load().unwrap_or_else(|e| panic!("the plugin should load: {e}"))
    }
}

/// Whether some warning contains `needle`.
fn warned(bundle: &Bundle, needle: &str) -> bool {
    bundle.warnings.iter().any(|w| w.contains(needle))
}

/// The transport of the server called `name`.
fn transport<'a>(bundle: &'a Bundle, name: &str) -> &'a Transport {
    &bundle.mcp_servers.iter().find(|server| server.name == name).unwrap_or_else(|| panic!("no server '{name}' among {:?}", bundle.mcp_servers)).transport
}

/// Server names, in bundle order.
fn server_names(bundle: &Bundle) -> Vec<&str> {
    bundle.mcp_servers.iter().map(|server| server.name.as_str()).collect()
}

/// The parts of a stdio server.
struct Stdio<'a> {
    command: &'a str,
    args: &'a [String],
    env: &'a BTreeMap<String, String>,
    cwd: &'a Path,
}

/// The stdio server called `name`; panics if it is not stdio.
fn stdio<'a>(bundle: &'a Bundle, name: &str) -> Stdio<'a> {
    match transport(bundle, name) {
        Transport::Stdio { command, args, env, cwd } => Stdio { command, args, env, cwd },
        other => panic!("server '{name}' is not a stdio server: {other:?}"),
    }
}

/// The URL and headers of the HTTP server called `name`; panics if it is not HTTP.
fn http<'a>(bundle: &'a Bundle, name: &str) -> (&'a str, &'a BTreeMap<String, String>) {
    match transport(bundle, name) {
        Transport::Http { url, headers } => (url, headers),
        other => panic!("server '{name}' is not an HTTP server: {other:?}"),
    }
}

/// Skill names, in bundle order.
fn skill_names(bundle: &Bundle) -> Vec<&str> {
    bundle.skills.iter().map(|skill| skill.name.as_str()).collect()
}
