//! MCP servers a project ships in `<workspace>/.agents/mcp.json`.
//!
//! The file has the same entries as the user's `mcp.json` (its top-level key
//! may be `servers` or `mcpServers`). A project's server runs only for
//! sessions in that workspace, and only after the user approves it: an
//! approval is kept in the user's config dir (never in the repository) with a
//! fingerprint of the exact entry, so a changed entry needs approval again.
//!
//! A project's server runs under a key of its own, `<name>@<workspace hash>`
//! ([`runner_key`]): two workspaces may both have a `db`, and each keeps its
//! own process, sign-in and HTTP session. Inside its workspace the agent
//! reaches it by its plain name, and it takes the place of a user's or
//! plugin's server of the same name there.

use crate::config::{self as cfgmod, McpConfig, ServerConfig};
use crate::tool::McpTool;
use crate::{publish_status, McpManager, Runner, RunnerState, ServerStatus};
use appv3_agent::confirm::Proposal;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The change type of the card that approves a project's server.
pub const APPROVE_CHANGE: &str = "mcp_project_approve";
/// How long approving waits for the server to become ready.
const START_WAIT: Duration = Duration::from_secs(15);

/// A project's server: the workspace that ships it and its name there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRef {
    pub workspace: String,
    pub name: String,
}

/// `<workspace>/.agents/mcp.json`.
pub fn project_file(workspace: &Path) -> PathBuf {
    workspace.join(".agents").join("mcp.json")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The key a project's server runs under: `<name>@<first 10 hex digits of
/// the workspace path's SHA-256>`. A name from `mcp.json` has no `@`, and a
/// plugin's has a `/`, so it never meets either.
pub fn runner_key(workspace: &str, name: &str) -> String {
    let digest = Sha256::digest(workspace.as_bytes());
    format!("{name}@{}", &hex(&digest)[..10])
}

/// Whether `key` is a project server's [`runner_key`].
pub fn is_project_key(key: &str) -> bool {
    key.contains('@')
}

/// A fingerprint of an entry, stable across runs: what an approval is for.
pub fn fingerprint(cfg: &ServerConfig) -> String {
    let mut v = cfg.dump();
    if let Some(dir) = cfg.cwd() {
        v["cwd"] = Value::String(dir.display().to_string());
    }
    hex(&Sha256::digest(cfgmod::py_dumps_indent2_sorted(&v).as_bytes()))
}

/// Validate a project file's JSON. `mcpServers` is read as `servers` (and
/// `$schema` is allowed), so another client's `.mcp.json` can be copied in
/// as it is. A stdio server runs in the workspace.
pub fn parse_project_config(raw: &Value, workspace: &Path) -> Result<McpConfig, String> {
    let Value::Object(top) = raw else { return Err("expected a JSON object at top level".into()) };
    if top.contains_key("servers") && top.contains_key("mcpServers") {
        return Err("give the servers under `servers` or `mcpServers`, not both".into());
    }
    let mut top: Map<String, Value> = top.clone();
    top.remove("$schema");
    if let Some(servers) = top.remove("mcpServers") {
        top.insert("servers".into(), servers);
    }
    let mut cfg = cfgmod::parse_config(&Value::Object(top))?;
    for sc in cfg.servers.values_mut() {
        if let ServerConfig::Stdio { cwd, .. } = sc {
            *cwd = Some(workspace.to_path_buf());
        }
    }
    Ok(cfg)
}

/// The workspace's project servers: empty without a file, `Err` (naming the
/// file) when it cannot be read or is invalid.
pub fn load_project_config(workspace: &Path) -> Result<McpConfig, String> {
    let path = project_file(workspace);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(McpConfig::default()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("Invalid JSON in {}: {e}", path.display()))?;
    parse_project_config(&raw, workspace).map_err(|e| format!("{}: {e}", path.display()))
}

// ── approvals ───────────────────────────────────────────────────────────────

/// The user's approvals: `{"<workspace>": {"<server>": "<fingerprint>"}}`,
/// in a file of the user's config dir.
#[derive(Debug, Clone)]
pub struct Approvals {
    path: PathBuf,
}

fn store_lock() -> &'static std::sync::Mutex<()> {
    static L: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &L
}

impl Approvals {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `{config dir}/mcp-project-approvals.json`.
    pub fn user() -> Self {
        Self::at(appv3_core::settings().config_dir.join("mcp-project-approvals.json"))
    }

    fn read(&self) -> Map<String, Value> {
        std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }

    fn write(&self, all: &Map<String, Value>) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        appv3_core::secret_files::write_atomic(&self.path, &(cfgmod::py_dumps_indent2_sorted(&Value::Object(all.clone())) + "\n"))
    }

    /// Whether the user approved `name` in `workspace` exactly as `cfg` is.
    pub fn approved(&self, workspace: &str, name: &str, cfg: &ServerConfig) -> bool {
        self.read().get(workspace).and_then(|w| w.get(name)).and_then(Value::as_str) == Some(fingerprint(cfg).as_str())
    }

    /// Approve `name` in `workspace` as `cfg` is now.
    pub fn approve(&self, workspace: &str, name: &str, cfg: &ServerConfig) -> std::io::Result<()> {
        let _g = store_lock().lock().unwrap();
        let mut all = self.read();
        let ws = all.entry(workspace.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if !ws.is_object() {
            *ws = Value::Object(Map::new());
        }
        ws.as_object_mut().expect("an object").insert(name.to_string(), Value::String(fingerprint(cfg)));
        self.write(&all)
    }

    /// Forget the approval of `name` in `workspace`.
    pub fn revoke(&self, workspace: &str, name: &str) -> std::io::Result<()> {
        let _g = store_lock().lock().unwrap();
        let mut all = self.read();
        let Some(ws) = all.get_mut(workspace).and_then(Value::as_object_mut) else { return Ok(()) };
        if ws.shift_remove(name).is_none() {
            return Ok(());
        }
        if ws.is_empty() {
            all.remove(workspace);
        }
        self.write(&all)
    }
}

/// The `${NAME}` / `$NAME` references in a server's `env`, headers and OAuth
/// client fields (the values filled in from the environment and named
/// secrets when it starts), in order, once each: what the approval card
/// names. Their values are never shown.
pub fn referenced_variables(cfg: &ServerConfig) -> Vec<String> {
    let re = regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    let mut out: Vec<String> = vec![];
    for t in crate::config::secret_values(cfg) {
        for c in re.captures_iter(t) {
            let name = c.get(1).or_else(|| c.get(2)).unwrap().as_str().to_string();
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// The enabled servers in `workspace`'s file, by name (none when it is
/// missing or invalid): what the `mcp` tool's description names.
pub fn enabled_names(workspace: &str) -> Vec<String> {
    load_project_config(Path::new(workspace)).map(|c| c.servers.iter().filter(|(_, s)| s.enabled()).map(|(n, _)| n.clone()).collect()).unwrap_or_default()
}

impl McpManager {
    /// Where approvals are kept.
    pub fn approvals(&self) -> Approvals {
        self.approvals.read().unwrap().clone().unwrap_or_else(Approvals::user)
    }

    /// Keep approvals in `store` instead of the user's config dir.
    pub fn use_approvals(&self, store: Approvals) {
        *self.approvals.write().unwrap() = Some(store);
    }

    /// Why `workspace`'s `.agents/mcp.json` could not be used, as of the last sync.
    pub fn project_error(&self, workspace: &str) -> Option<String> {
        self.project_errors.read().unwrap().get(workspace).cloned()
    }

    fn project_runners(&self, workspace: &str) -> Vec<(String, Arc<Runner>)> {
        self.runners.read().unwrap().iter().filter(|(_, r)| r.project.as_ref().is_some_and(|p| p.workspace == workspace)).map(|(n, r)| (n.clone(), r.clone())).collect()
    }

    /// Brings `workspace`'s servers in line with its `.agents/mcp.json` and
    /// the user's approvals: an approved entry runs, an unapproved one waits
    /// (`needs_approval`) without running, and a server whose entry is gone,
    /// changed or no longer approved is stopped first. A file that cannot be
    /// read stops them all and is reported by [`McpManager::project_error`].
    /// Nothing else is touched, and nothing restarts when nothing changed.
    pub async fn sync_project(&self, workspace: &str) {
        let _g = self.lock.lock().await;
        let cfg = match load_project_config(Path::new(workspace)) {
            Ok(c) => {
                self.project_errors.write().unwrap().remove(workspace);
                c
            }
            Err(e) => {
                tracing::warn!("mcp_project_config_invalid workspace={} err={}", workspace, e);
                self.project_errors.write().unwrap().insert(workspace.to_string(), e);
                McpConfig::default()
            }
        };
        let approvals = self.approvals();
        let desired: Vec<(String, ProjectRef, ServerConfig, bool)> = cfg
            .servers
            .iter()
            .map(|(n, sc)| (runner_key(workspace, n), ProjectRef { workspace: workspace.to_string(), name: n.clone() }, sc.clone(), approvals.approved(workspace, n, sc)))
            .collect();
        let current = self.project_runners(workspace);
        let same = |key: &str, r: &Runner| desired.iter().any(|(k, _, c, ok)| k == key && *c == r.config && *ok == (r.state() != RunnerState::NeedsApproval));
        let (kept, doomed): (Vec<_>, Vec<_>) = current.into_iter().partition(|(k, r)| same(k, r));
        futures::future::join_all(doomed.iter().map(|(_, r)| Self::stop_runner(r))).await;
        {
            let mut runners = self.runners.write().unwrap();
            for (k, _) in &doomed {
                runners.shift_remove(k);
            }
        }
        for (k, _) in &doomed {
            publish_status(k, "stopped");
        }
        let mut started = vec![];
        for (key, project, sc, ok) in desired {
            if kept.iter().any(|(k, _)| *k == key) {
                continue;
            }
            if ok {
                self.spawn_owned(&key, &sc, None, Some(project));
            } else {
                self.runners.write().unwrap().insert(key.clone(), Runner::build(&key, &sc, RunnerState::NeedsApproval, None, Some(project)));
            }
            if let Some(st) = self.get_status(&key) {
                publish_status(&key, &st.state);
            }
            started.push(key);
        }
        if !doomed.is_empty() || !started.is_empty() {
            tracing::info!("mcp_project_servers_synced workspace={} stopped={:?} added={:?}", workspace, doomed.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), started);
        }
    }

    /// The runner the agent in `workspace` means by `name`: the project's
    /// server of that name, else the user's or a plugin's.
    pub(crate) fn runner_in(&self, name: &str, workspace: Option<&str>) -> Option<Arc<Runner>> {
        let runners = self.runners.read().unwrap();
        if let Some(r) = workspace.and_then(|ws| runners.get(&runner_key(ws, name))) {
            return Some(r.clone());
        }
        runners.get(name).filter(|r| r.project.is_none()).cloned()
    }

    /// `name`'s status as the agent in `workspace` sees it (named as it knows it).
    pub fn status_in(&self, name: &str, workspace: Option<&str>) -> Option<ServerStatus> {
        self.runner_in(name, workspace).map(|r| {
            let mut st = r.status();
            st.name = r.display_name().to_string();
            st
        })
    }

    /// Every server the agent in `workspace` can reach, named as it knows
    /// them: the user's and plugins' (but one a project server of the same
    /// name replaces), then the project's.
    pub fn statuses_in(&self, workspace: Option<&str>) -> Vec<ServerStatus> {
        let project: Vec<Arc<Runner>> = workspace.map(|ws| self.project_runners(ws).into_iter().map(|(_, r)| r).collect()).unwrap_or_default();
        let shadowed = |n: &str| project.iter().any(|r| r.display_name() == n);
        let mut out: Vec<ServerStatus> = self.ordered_runners().into_iter().filter(|(n, _)| !shadowed(n)).map(|(_, r)| r.status()).collect();
        out.extend(project.iter().map(|r| {
            let mut st = r.status();
            st.name = r.display_name().to_string();
            st
        }));
        out
    }

    /// Tools of the ready servers the agent in `workspace` can reach (just
    /// `server`'s when given).
    pub fn ready_tools_in(&self, server: Option<&str>, workspace: Option<&str>) -> Vec<Arc<McpTool>> {
        let runners: Vec<Arc<Runner>> = match server {
            Some(s) => self.runner_in(s, workspace).into_iter().collect(),
            None => {
                let names: Vec<String> = self.statuses_in(workspace).into_iter().map(|s| s.name).collect();
                names.iter().filter_map(|n| self.runner_in(n, workspace)).collect()
            }
        };
        runners.iter().filter(|r| r.state() == RunnerState::Ready).flat_map(|r| r.model_tools()).collect()
    }

    /// `workspace`'s servers with their configs, as the settings API lists
    /// them: each named by its key.
    pub fn project_servers(&self, workspace: &str) -> Vec<(ServerStatus, ServerConfig)> {
        self.project_runners(workspace).into_iter().map(|(_, r)| (r.status(), r.config.clone())).collect()
    }

    /// The config of the project's server keyed `key`, if it is one.
    pub fn project_server_config(&self, key: &str) -> Option<ServerConfig> {
        self.runners.read().unwrap().get(key).filter(|r| r.project.is_some()).map(|r| r.config.clone())
    }

    /// The project that ships the server keyed `key`, if one does.
    pub fn project_of(&self, key: &str) -> Option<ProjectRef> {
        self.runners.read().unwrap().get(key).and_then(|r| r.project.clone())
    }

    /// Approve `name` from `workspace`'s file as it is now and start it.
    /// With `expected`, only while its entry still has that fingerprint (the
    /// one a card showed). Waits up to `wait` for it to settle.
    pub async fn approve_project_server(&self, workspace: &str, name: &str, expected: Option<&str>, wait: Duration) -> Result<ServerStatus, String> {
        let cfg = load_project_config(Path::new(workspace))?;
        let Some(sc) = cfg.servers.get(name) else { return Err(format!("This project's .agents/mcp.json has no server '{name}'.")) };
        if expected.is_some_and(|fp| fp != fingerprint(sc)) {
            return Err(format!("MCP server '{name}' changed in .agents/mcp.json since this was shown. Search for it again to see the new entry."));
        }
        self.approvals().approve(workspace, name, sc).map_err(|e| e.to_string())?;
        tracing::info!("mcp_project_server_approved workspace={} server={}", workspace, name);
        self.sync_project(workspace).await;
        let runner = self.runners.read().unwrap().get(&runner_key(workspace, name)).cloned();
        let Some(runner) = runner else { return Err(format!("MCP server '{name}' is approved but did not start.")) };
        runner.wait_settled(wait).await;
        let mut st = runner.status();
        st.name = name.to_string();
        Ok(st)
    }

    /// Withdraw the approval of `name` in `workspace`: it stops, and waits
    /// for approval again.
    pub async fn revoke_project_server(&self, workspace: &str, name: &str) -> Result<(), String> {
        self.approvals().revoke(workspace, name).map_err(|e| e.to_string())?;
        tracing::info!("mcp_project_server_revoked workspace={} server={}", workspace, name);
        self.sync_project(workspace).await;
        Ok(())
    }
}

/// The card that asks the user to approve `name` from `workspace`'s file.
pub fn propose_approval(workspace: &str, name: &str, sc: &ServerConfig) -> Proposal {
    let file = project_file(Path::new(workspace));
    let mut q = format!("Allow MCP server **{name}** from this project's `{}`? It {}.", file.display(), crate::admin::describe(sc));
    let vars = referenced_variables(sc);
    if !vars.is_empty() {
        let list = vars.iter().map(|v| format!("`{v}`")).collect::<Vec<_>>().join(", ");
        q.push_str(&format!(" It is given the values of {list} from your environment or stored secrets."));
    }
    q.push_str(" It runs for this workspace only, until its entry changes or you revoke it.");
    Proposal {
        question: q,
        apply: "Approve it for this project and start it.".into(),
        change: serde_json::json!({"type": APPROVE_CHANGE, "workspace": workspace, "name": name, "fingerprint": fingerprint(sc)}),
    }
}

/// Apply a confirmed approval card on `m`, if the entry is still the one it showed.
pub async fn apply_approval(m: &McpManager, change: &Value) -> Result<String, String> {
    let workspace = change["workspace"].as_str().unwrap_or_default();
    let name = change["name"].as_str().unwrap_or_default();
    let st = m.approve_project_server(workspace, name, change["fingerprint"].as_str(), START_WAIT).await?;
    Ok(crate::admin::status_sentence(&st).replace("is saved", "is approved"))
}

#[cfg(test)]
mod tests;
