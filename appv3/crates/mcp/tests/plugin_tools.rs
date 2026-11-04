//! Plugin tools reach the model through the `mcp` tool, under the plugin's
//! name: `search` and `call` use the live tools, so a plugin installed or
//! edited mid-session is usable at once, and the tools block a session
//! sends never changes. Without plugin tools it reads as it always did.

use appv3_agent::loader::{self, ProviderFactory};
use appv3_agent::plugins::{ExtraRun, ExtraTool};
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::store;
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::{ToolContext, ToolOutput, ToolResult};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Settings, the kernel and the MCP manager are process-wide: one root, one
/// test at a time.
fn root() -> &'static Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ] {
            std::env::set_var(k, root.path().join(d));
        }
        std::env::set_var("HOME", root.path().join("home"));
        std::env::set_var("OPENAGENTD_SHELL_SNAPSHOT", "false");
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        std::fs::create_dir_all(root.path().join("config")).unwrap();
        std::fs::write(root.path().join("config/settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
        std::fs::create_dir_all(root.path().join("agents")).unwrap();
        // Registers the manager as the agents' MCP source, so leads get `mcp`.
        appv3_mcp::mcp_manager();
        root
    })
    .path()
}

fn serial() -> &'static tokio::sync::Mutex<()> {
    static M: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    M.get_or_init(Default::default)
}

struct Reply(&'static str);

#[async_trait::async_trait]
impl ExtraRun for Reply {
    async fn run(&self, _: &ToolContext, args: Value) -> ToolResult {
        Ok(ToolOutput::text(format!("{} {args}", self.0)))
    }
}

fn tool(name: &str, read_only: bool, reply: &'static str) -> ExtraTool {
    ExtraTool {
        plugin: "test-kit".into(),
        name: name.into(),
        description: format!("The {name} tool"),
        input_schema: json!({"type": "object", "properties": {"since": {"type": "string", "description": "A tag"}}, "required": ["since"]}),
        read_only,
        runner: Arc::new(Reply(reply)),
    }
}

/// A plugin's module: hands the kernel its tools each time it starts.
struct Kit(Vec<ExtraTool>);

#[async_trait::async_trait]
impl appv3_kernel::Module for Kit {
    fn id(&self) -> &str {
        "plugin:test-kit"
    }
    fn register(&self, r: &mut appv3_kernel::Registrar) -> anyhow::Result<()> {
        for t in &self.0 {
            r.add(t.clone());
        }
        Ok(())
    }
}

/// Installs (or reloads) the test plugin with `tools`.
async fn install(tools: Vec<ExtraTool>) {
    let k = appv3_kernel::global();
    k.stop("plugin:test-kit").await;
    k.add(Kit(tools)).unwrap();
    k.start("plugin:test-kit").await.unwrap();
}

async fn uninstall() {
    appv3_kernel::global().remove("plugin:test-kit").await;
}

struct Lead {
    session: Arc<AgentSession>,
    pool: appv3_db::DbPool,
    sid: String,
    mock: Arc<MockProvider>,
}

impl Lead {
    async fn new(name: &str) -> Self {
        let root = root();
        let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
        let ws = root.join("project");
        std::fs::create_dir_all(&ws).unwrap();
        let mock = Arc::new(MockProvider::new(vec![]));
        let provider: Arc<dyn LlmProvider> = mock.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
        let md = root.join("agents").join(format!("{name}.md"));
        std::fs::write(&md, format!("---\nname: {name}\nmodel: mock:mock\n---\n")).unwrap();
        let agent = loader::rebuild_agent_from_disk(&md, &factory).unwrap();
        let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
        let id = uuid::Uuid::now_v7();
        appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), ..Default::default() }).await.unwrap();
        Lead { session, pool, sid: id.to_string(), mock }
    }

    /// One user turn in which the model answers with `turns`.
    async fn turn(&self, turns: Vec<MockTurn>) {
        self.mock.turns.lock().unwrap().extend(turns);
        self.session.handle_user_message(UserMessage { content: "go".into(), session_id: self.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
        if let Some(mut sub) = store().attach(&self.sid) {
            let _ = tokio::time::timeout(Duration::from_secs(20), async { while sub.next().await.is_some() {} }).await;
        }
        tokio::time::timeout(Duration::from_secs(20), self.session.wait_turn_finished()).await.expect("turn finishes");
    }

    /// The tool definitions of each model call so far.
    fn tools_blocks(&self) -> Vec<Value> {
        self.mock.calls.lock().unwrap().iter().map(|(_, tools, _)| serde_json::to_value(tools).unwrap()).collect()
    }

    /// The `mcp` tool's description in model call `call`.
    fn mcp_description(&self, call: usize) -> String {
        let block = &self.tools_blocks()[call];
        let mcp = block.as_array().unwrap().iter().find(|t| t["function"]["name"] == "mcp").unwrap_or_else(|| panic!("no mcp tool in {block}"));
        mcp["function"]["description"].as_str().unwrap().to_string()
    }

    /// The tool results the model has been sent, in order.
    fn tool_results(&self) -> Vec<String> {
        let calls = self.mock.calls.lock().unwrap();
        let last = &calls.last().expect("the model was called").0;
        last.iter()
            .filter_map(|m| match m {
                ChatMessage::Tool { content, .. } => Some(content.clone().unwrap_or_default()),
                _ => None,
            })
            .collect()
    }
}

fn call(id: &str, tool: &str) -> MockTurn {
    MockProvider::tool_call(id, "mcp", &json!({"action": "call", "server": "test-kit", "tool": tool, "arguments": {"since": "v1.2.0"}}).to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plugin_installed_mid_session_is_callable_at_once_and_the_tools_block_stays_the_same() {
    let _g = serial().lock().await;
    uninstall().await;
    let lead = Lead::new("before").await;
    lead.turn(vec![MockProvider::text("Hi.")]).await;
    assert!(lead.mcp_description(0).ends_with("\n\nNo MCP servers are configured."), "without plugin tools it reads as before");

    install(vec![tool("notes", true, "notes")]).await;
    lead.turn(vec![call("c1", "notes"), MockProvider::text("Done.")]).await;
    assert_eq!(lead.tool_results(), [r#"notes {"since":"v1.2.0"}"#]);
    let blocks = lead.tools_blocks();
    assert!(blocks.iter().all(|b| *b == blocks[0]), "a plugin installed mid-session leaves the tools block alone");

    let fresh = Lead::new("after").await;
    fresh.turn(vec![MockProvider::text("Hi.")]).await;
    assert!(fresh.mcp_description(0).ends_with("\n\nServers: test-kit. Search with a server and an empty query to list its tools."), "{}", fresh.mcp_description(0));
    uninstall().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_lists_plugin_tools_and_call_runs_one() {
    let _g = serial().lock().await;
    install(vec![tool("notes", true, "notes ran")]).await;
    let lead = Lead::new("lists").await;
    lead.turn(vec![MockProvider::tool_call("c1", "mcp", r#"{"action": "search", "query": "notes"}"#), call("c2", "notes"), MockProvider::text("Done.")]).await;
    let results = lead.tool_results();
    assert!(results[0].starts_with("1 tool (run one with action='call', server, tool and arguments):"), "{}", results[0]);
    assert!(results[0].contains(r#""server":"test-kit""#) && results[0].contains(r#""tool":"notes""#) && results[0].contains(r#""input_schema":{"#), "{}", results[0]);
    assert_eq!(results[1], r#"notes ran {"since":"v1.2.0"}"#);
    uninstall().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reloaded_plugin_runs_its_new_code_and_the_session_request_stays_the_same() {
    let _g = serial().lock().await;
    install(vec![tool("notes", true, "v1")]).await;
    let lead = Lead::new("reloads").await;
    lead.turn(vec![call("c1", "notes"), MockProvider::text("Done.")]).await;

    install(vec![tool("notes", true, "v2"), tool("publish", false, "published")]).await;
    lead.turn(vec![call("c2", "notes"), call("c3", "publish"), MockProvider::text("Done.")]).await;
    assert_eq!(lead.tool_results(), [r#"v1 {"since":"v1.2.0"}"#, r#"v2 {"since":"v1.2.0"}"#, r#"published {"since":"v1.2.0"}"#]);
    let blocks = lead.tools_blocks();
    assert!(blocks.iter().all(|b| *b == blocks[0]), "every request of the session sends the same tools block");
    uninstall().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plan_mode_runs_only_the_plugin_tools_marked_read_only() {
    let _g = serial().lock().await;
    install(vec![tool("notes", true, "notes ran"), tool("publish", false, "published")]).await;
    let lead = Lead::new("plans").await;
    appv3_agent::interaction_mode::set_mode(&lead.pool, &lead.sid, "plan").await.unwrap();
    lead.turn(vec![call("c1", "publish"), call("c2", "notes"), MockProvider::text("Done.")]).await;
    assert_eq!(lead.tool_results(), ["Error: Plugin tool 'test-kit.publish' is not marked read-only, so it is unavailable in Plan mode.", r#"notes ran {"since":"v1.2.0"}"#]);
    uninstall().await;
}
