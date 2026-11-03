//! MCP servers that plugins provide: they run next to the user's own from
//! the kernel's contributions, come and go with their plugin's module, never
//! touch the user's servers or `mcp.json`, and the `mcp` tool reaches them by
//! `<plugin>/<server>`.

use appv3_kernel::{Kernel, Module, Registrar};
use appv3_mcp::config::ServerConfig;
use appv3_mcp::hub::McpHubTool;
use appv3_mcp::{mcp_manager, PluginServers};
use appv3_tools::{Tool, ToolContext, ToolOutput};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// One tool, `where`, that answers `<working directory>|<PLUGIN_MARK>`.
const SERVER: &str = r#"import sys, json, os
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "t", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "where", "description": "Report the working directory", "annotations": {"readOnlyHint": True}, "inputSchema": {"type": "object", "properties": {}}}]}
    elif m["method"] == "tools/call":
        r = {"content": [{"type": "text", "text": os.getcwd() + "|" + os.environ.get("PLUGIN_MARK", "")}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#;

/// A plugin's module as the server has them: it registers its servers right
/// before it starts, and syncs the manager from its start and stop hooks.
struct PluginModule {
    id: String,
    plugin: String,
    servers: Vec<(String, ServerConfig)>,
}

impl PluginModule {
    fn new(plugin: &str, servers: Vec<(&str, ServerConfig)>) -> Self {
        Self { id: format!("plugin:{plugin}"), plugin: plugin.into(), servers: servers.into_iter().map(|(n, c)| (n.to_string(), c)).collect() }
    }
}

#[async_trait::async_trait]
impl Module for PluginModule {
    fn id(&self) -> &str {
        &self.id
    }
    fn register(&self, r: &mut Registrar) -> anyhow::Result<()> {
        r.add(PluginServers { plugin: self.plugin.clone(), servers: self.servers.clone() });
        Ok(())
    }
    async fn start(&self, _k: &Kernel) -> anyhow::Result<()> {
        mcp_manager().sync_plugin_servers().await;
        Ok(())
    }
    async fn stop(&self) {
        mcp_manager().sync_plugin_servers().await;
    }
}

fn python(path: &str) -> Option<String> {
    std::env::split_paths(path).map(|d| d.join("python3")).find(|p| p.is_file()).map(|p| p.display().to_string())
}

fn real(p: impl AsRef<Path>) -> PathBuf {
    std::fs::canonicalize(p).unwrap()
}

fn ctx() -> ToolContext {
    let mut meta = serde_json::Map::new();
    meta.insert("interaction_mode".into(), json!("plan"));
    ToolContext {
        session_id: None,
        agent_name: "code".into(),
        tool_call_id: "c".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(&std::env::temp_dir(), None)),
        workspace: None,
        output: None,
        metadata: Arc::new(Mutex::new(meta)),
        messages: None,
    }
}

async fn run(hub: &McpHubTool, args: Value) -> Result<String, String> {
    match hub.run(&ctx(), args).await {
        Ok(ToolOutput::Text(t)) => Ok(t),
        Ok(o) => Ok(format!("{o:?}")),
        Err(e) => Err(e.to_string()),
    }
}

fn started_at(name: &str) -> String {
    mcp_manager().get_status(name).unwrap_or_else(|| panic!("{name} is not listed")).started_at.unwrap_or_else(|| panic!("{name} never got ready"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_servers_run_beside_the_users_and_follow_their_plugin() {
    let path = std::env::var("PATH").unwrap_or_default();
    let Some(py) = python(&path) else { return };
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for (k, d) in [("OPENAGENTD_DATA_DIR", "data"), ("OPENAGENTD_CONFIG_DIR", "config"), ("OPENAGENTD_STATE_DIR", "state"), ("OPENAGENTD_CACHE_DIR", "cache")] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::fs::create_dir_all(root.join("config")).unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let script = root.join("srv.py");
    std::fs::write(&script, SERVER).unwrap();
    let mcp_json = root.join("config").join("mcp.json");
    let (kernel, m) = (appv3_kernel::global(), mcp_manager());

    // A plugin's server runs in the plugin's folder with the plugin's environment.
    let folder = |name: &str| {
        let d = root.join("plugins").join(name);
        std::fs::create_dir_all(&d).unwrap();
        d
    };
    let server = |dir: &Path, mark: &str, enabled: bool| {
        let mut env = IndexMap::new();
        env.insert("PATH".to_string(), path.clone());
        env.insert("PLUGIN_MARK".to_string(), mark.to_string());
        ServerConfig::Stdio { command: py.clone(), args: vec![script.display().to_string()], env, enabled, timeout: None, cwd: Some(dir.to_path_buf()) }
    };
    let (changelog, lint) = (folder("changelog-tools"), folder("lint"));

    // ── a plugin starts before the manager did, with no mcp.json at all ───
    kernel.add(PluginModule::new("changelog-tools", vec![("github", server(&changelog, "gh", true)), ("docs", server(&changelog, "docs", false))])).unwrap();
    kernel.start("plugin:changelog-tools").await.unwrap();
    m.wait_until_ready(Duration::from_secs(20)).await;
    let github = m.get_status("changelog-tools/github").unwrap();
    assert_eq!((github.state.as_str(), github.plugin.as_deref(), github.enabled), ("ready", Some("changelog-tools"), true), "{github:?}");
    assert_eq!(github.tool_names, ["changelog-tools/github_where"]);
    let docs = m.get_status("changelog-tools/docs").unwrap();
    assert_eq!((docs.state.as_str(), docs.plugin.as_deref(), docs.enabled), ("stopped", Some("changelog-tools"), false), "a disabled plugin server is listed, not started");
    // Starting the manager (nothing in mcp.json) leaves a running plugin server alone.
    let gh_at = started_at("changelog-tools/github");
    m.start().await;
    assert_eq!(started_at("changelog-tools/github"), gh_at);

    // ── the user's servers, loaded from mcp.json, run beside them ─────────
    std::fs::write(
        &mcp_json,
        serde_json::to_string_pretty(&json!({"servers": {"echoes": {"command": py, "args": [script.display().to_string()], "env": {"PATH": path}}}})).unwrap() + "\n",
    )
    .unwrap();
    let on_disk = std::fs::read_to_string(&mcp_json).unwrap();
    m.reload_from_config().await;
    m.wait_until_ready(Duration::from_secs(20)).await;
    assert_eq!(m.server_names(), ["echoes", "changelog-tools/github", "changelog-tools/docs"], "the user's first, then the plugins'");
    assert_eq!(started_at("changelog-tools/github"), gh_at, "reloading mcp.json does not drop or restart a plugin's server");
    let echoes_at = started_at("echoes");
    assert_eq!(m.get_status("echoes").unwrap().plugin, None);

    // ── a second plugin starts: the others are not restarted ──────────────
    kernel.add(PluginModule::new("lint", vec![("rules", server(&lint, "lint", true))])).unwrap();
    kernel.start("plugin:lint").await.unwrap();
    m.wait_until_ready(Duration::from_secs(20)).await;
    assert_eq!(m.server_names(), ["echoes", "changelog-tools/github", "changelog-tools/docs", "lint/rules"]);
    assert_eq!((started_at("echoes"), started_at("changelog-tools/github")), (echoes_at.clone(), gh_at.clone()), "a plugin starting leaves the other servers alone");

    // ── a plugin server whose folder is gone says so ──────────────────────
    let gone = root.join("plugins").join("gone");
    kernel.add(PluginModule::new("broken", vec![("srv", server(&gone, "x", true))])).unwrap();
    kernel.start("plugin:broken").await.unwrap();
    m.wait_until_ready(Duration::from_secs(20)).await;
    let broken = m.get_status("broken/srv").unwrap();
    assert_eq!(broken.state, "error", "{broken:?}");
    assert!(broken.error.unwrap().contains("No such file or directory: '"), "the missing directory is named");
    kernel.stop("plugin:broken").await;
    assert!(m.get_status("broken/srv").is_none());

    // ── the `mcp` tool lists and reaches them by `<plugin>/<server>` ──────
    let hub = McpHubTool::new(m.clone());
    let servers = run(&hub, json!({"action": "servers"})).await.unwrap();
    assert!(servers.contains("- echoes (stdio, ready) — 1 tools: echoes_where"), "{servers}");
    assert!(servers.contains("Servers from plugins (read-only"), "{servers}");
    assert!(servers.contains("- changelog-tools/github (stdio, ready, from plugin changelog-tools) — 1 tools: changelog-tools/github_where"), "{servers}");
    assert!(servers.contains("- changelog-tools/docs (stdio, disabled, from plugin changelog-tools)"), "{servers}");
    assert!(servers.contains("- lint/rules (stdio, ready, from plugin lint)"), "{servers}");
    assert!(!servers.contains("PLUGIN_MARK\":\"gh"), "a plugin's env values are masked for the agent: {servers}");
    let found = run(&hub, json!({"action": "search", "server": "lint/rules"})).await.unwrap();
    assert!(found.contains(r#""server":"lint/rules","tool":"where","read_only":true"#), "{found}");
    let got = run(&hub, json!({"action": "call", "server": "lint/rules", "tool": "where"})).await.unwrap();
    let (dir, mark) = got.split_once('|').unwrap();
    assert_eq!((real(dir), mark), (real(&lint), "lint"), "the server runs in the plugin's folder, with its environment");
    let own = run(&hub, json!({"action": "call", "server": "echoes", "tool": "where"})).await.unwrap();
    assert_eq!(real(own.split('|').next().unwrap()), real(std::env::current_dir().unwrap()), "a server with no directory keeps ours");
    let e = run(&hub, json!({"action": "remove", "server": "lint/rules"})).await.unwrap_err();
    assert!(e.contains("comes from plugin lint") && e.contains("Settings → Plugins"), "{e}");
    assert_eq!((m.plugin_of("lint/rules").as_deref(), m.plugin_of("echoes"), m.plugin_of("lint/nope")), (Some("lint"), None, None));

    // ── a plugin server can be restarted, an unknown one cannot ───────────
    let st = m.restart_server("lint/rules", Duration::from_secs(20)).await.unwrap();
    assert_eq!((st.state.as_str(), st.plugin.as_deref()), ("ready", Some("lint")), "{st:?}");
    assert!(m.restart_server("lint/nope", Duration::from_secs(1)).await.is_err());
    assert!(m.restart_server("nope", Duration::from_secs(1)).await.is_err());

    // ── a plugin stops: only its servers go ───────────────────────────────
    kernel.stop("plugin:changelog-tools").await;
    assert_eq!(m.server_names(), ["echoes", "lint/rules"]);
    assert_eq!((started_at("echoes"), m.get_status("lint/rules").unwrap().state), (echoes_at.clone(), "ready".to_string()), "the user's server was not restarted");
    // Restarting the module brings its servers back.
    kernel.restart("plugin:changelog-tools").await.unwrap();
    m.wait_until_ready(Duration::from_secs(20)).await;
    assert_eq!(m.server_names(), ["echoes", "lint/rules", "changelog-tools/github", "changelog-tools/docs"], "the plugins' servers in the order they started");
    assert_eq!(started_at("echoes"), echoes_at);

    // ── stopping the manager stops every server; starting it runs both kinds again ──
    m.stop().await;
    assert!(m.server_names().is_empty());
    m.start().await;
    m.wait_until_ready(Duration::from_secs(20)).await;
    assert_eq!(m.server_names(), ["echoes", "lint/rules", "changelog-tools/github", "changelog-tools/docs"]);
    assert_eq!(m.get_status("lint/rules").unwrap().state, "ready");

    // ── nothing of theirs ever reached mcp.json ───────────────────────────
    assert_eq!(std::fs::read_to_string(&mcp_json).unwrap(), on_disk);

    kernel.stop_all().await;
    assert_eq!(m.server_names(), ["echoes"]);
    m.stop().await;
    assert!(m.server_names().is_empty());
    for id in ["plugin:changelog-tools", "plugin:lint", "plugin:broken"] {
        kernel.remove(id).await;
    }
}
