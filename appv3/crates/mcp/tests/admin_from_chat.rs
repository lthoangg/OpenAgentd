//! Adding, changing and removing MCP servers from chat: `mcp(action='save' |
//! 'remove')` only opens a card, the change applies on Apply (to the live
//! manager and `mcp.json`), the agent never reads a secret, and the tool's
//! definition stays byte-identical for the session.

use appv3_agent::confirm;
use appv3_mcp::hub::McpHubTool;
use appv3_mcp::mcp_manager;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext, ToolError, ToolOutput};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const SERVER: &str = r#"import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "t", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {}}}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#;

fn python() -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::split_paths(&path).map(|d| d.join("python3")).find(|p| p.is_file()).map(|p| p.display().to_string())
}

fn ctx(sid: &str, call: &str, plan: bool) -> ToolContext {
    let mut meta = serde_json::Map::new();
    if plan {
        meta.insert("interaction_mode".into(), json!("plan"));
    }
    ToolContext {
        session_id: Some(sid.into()),
        agent_name: "code".into(),
        tool_call_id: call.into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(&std::env::temp_dir(), None)),
        workspace: None,
        output: None,
        metadata: Arc::new(Mutex::new(meta)),
        messages: None,
    }
}

async fn run(hub: &McpHubTool, c: &ToolContext, args: Value) -> Result<String, String> {
    match hub.run(c, args).await {
        Ok(ToolOutput::Text(t)) => Ok(t),
        Ok(o) => Ok(format!("{o:?}")),
        Err(ToolError::Suspended(_)) => Ok("<card>".into()),
        Err(e) => Err(e.to_string()),
    }
}

fn mcp_json(root: &std::path::Path) -> String {
    std::fs::read_to_string(root.join("config").join("mcp.json")).unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn servers_are_added_changed_and_removed_only_on_apply() {
    let Some(py) = python() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for (k, d) in [("OPENAGENTD_DATA_DIR", "data"), ("OPENAGENTD_CONFIG_DIR", "config"), ("OPENAGENTD_STATE_DIR", "state"), ("OPENAGENTD_CACHE_DIR", "cache")] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::fs::create_dir_all(root.join("config")).unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![]));
    appv3_agent::manager::init(pool.clone(), Arc::new(move |_, _| Ok(provider.clone())));
    let script = root.join("srv.py");
    std::fs::write(&script, SERVER).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();

    let sid = uuid::Uuid::now_v7();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(sid), workspace: root.display().to_string(), ..Default::default() }).await.unwrap();
    let sid = sid.to_string();
    let hub = McpHubTool::new(mcp_manager());
    let definition = serde_json::to_string(&hub.definition_for(&ctx(&sid, "c0", false))).unwrap();
    assert!(definition.contains("No MCP servers are configured."), "{definition}");
    let card = |call: &str| {
        let pool = pool.clone();
        let sid = sid.clone();
        let call = call.to_string();
        async move {
            let row = appv3_db::get_pending_question(&pool, &sid).await.unwrap().expect("an open card");
            assert_eq!((row.kind().as_deref(), row.tool_call_id.as_str()), (Some(confirm::CONFIRM_KIND), call.as_str()));
            row
        }
    };
    let answer = |row: appv3_db::PendingQuestion, a: &str| {
        let pool = pool.clone();
        let sid = sid.clone();
        let a = a.to_string();
        async move { confirm::answer(&pool, &sid, &appv3_db::codec::api_uuid(&row.id), &[vec![a]]).await.unwrap().expect("the card was open") }
    };

    // ── add: nothing changes until Apply ────────────────────────────────
    let config = json!({"command": py, "args": [script.display().to_string()], "env": {"PATH": path, "TOKEN": "s3cret-token"}});
    assert_eq!(run(&hub, &ctx(&sid, "c1", false), json!({"action": "save", "server": "echoes", "config": config})).await.unwrap(), "<card>");
    assert!(!mcp_json(root).contains("echoes"), "saved before Apply");
    let row = card("c1").await;
    let q = row.questions()[0]["question"].as_str().unwrap().to_string();
    assert!(q.starts_with("Add MCP server **echoes**: runs `") && q.contains("with environment variables `PATH`, `TOKEN`") && q.contains("It starts now"), "{q}");
    assert!(!q.contains("s3cret"), "{q}");
    let text = answer(row, "Apply").await;
    assert_eq!(text, "The user applied the change. MCP server 'echoes' is ready with 1 tool: echoes_echo. Find them with mcp(action='search', server='echoes').");
    assert!(mcp_json(root).contains("\"echoes\"") && mcp_json(root).contains("s3cret-token"));
    assert_eq!(mcp_manager().get_status("echoes").unwrap().state, "ready");

    // ── the agent's view masks the secret, and the definition is frozen ──
    let servers = run(&hub, &ctx(&sid, "c2", true), json!({"action": "servers"})).await.unwrap();
    assert!(servers.contains("- echoes (stdio, ready) — 1 tools: echoes_echo") && servers.contains("\"TOKEN\":\"********\""), "{servers}");
    assert!(!servers.contains("s3cret"), "{servers}");
    assert_eq!(serde_json::to_string(&hub.definition_for(&ctx(&sid, "c2", false))).unwrap(), definition, "the session's tool definition changed");
    let fresh = serde_json::to_string(&hub.definition_for(&ctx(&uuid::Uuid::now_v7().to_string(), "c", false))).unwrap();
    assert!(fresh.contains("Servers: echoes."), "a new session sees the new server: {fresh}");

    // ── Plan mode lists but never changes ────────────────────────────────
    let e = run(&hub, &ctx(&sid, "c3", true), json!({"action": "remove", "server": "echoes"})).await.unwrap_err();
    assert!(e.contains("unavailable in Plan mode"), "{e}");
    assert!(appv3_db::get_pending_question(&pool, &sid).await.unwrap().is_none());

    // ── update keeps a masked secret ─────────────────────────────────────
    let masked = json!({"command": py, "args": [script.display().to_string()], "env": {"PATH": "********", "TOKEN": "********", "MODE": "debug"}});
    run(&hub, &ctx(&sid, "c4", false), json!({"action": "save", "server": "echoes", "config": masked})).await.unwrap();
    let row = card("c4").await;
    assert!(row.questions()[0]["question"].as_str().unwrap().starts_with("Update MCP server **echoes**"));
    assert!(answer(row, "Apply").await.contains("is ready"));
    assert!(mcp_json(root).contains("s3cret-token") && mcp_json(root).contains("\"MODE\": \"debug\""), "{}", mcp_json(root));
    let e = run(&hub, &ctx(&sid, "c5", false), json!({"action": "save", "server": "other", "config": {"command": "x", "env": {"K": "********"}}})).await.unwrap_err();
    assert!(e.contains("stands for a stored value, and 'other' has none"), "{e}");

    // ── remove re-checks the entry, and Cancel keeps it ──────────────────
    run(&hub, &ctx(&sid, "c6", false), json!({"action": "remove", "server": "echoes"})).await.unwrap();
    let row = card("c6").await;
    let edited = mcp_json(root).replace("\"debug\"", "\"trace\"");
    std::fs::write(root.join("config").join("mcp.json"), edited).unwrap();
    let text = answer(row, "Apply").await;
    assert!(text.contains("not applied: MCP server 'echoes' changed since this was proposed."), "{text}");
    assert!(mcp_json(root).contains("echoes"));
    run(&hub, &ctx(&sid, "c7", false), json!({"action": "remove", "server": "echoes"})).await.unwrap();
    assert!(answer(card("c7").await, "Cancel").await.starts_with("The user cancelled the change"));
    assert!(mcp_json(root).contains("echoes"));
    run(&hub, &ctx(&sid, "c8", false), json!({"action": "remove", "server": "echoes"})).await.unwrap();
    assert_eq!(answer(card("c8").await, "Apply").await, "The user applied the change. MCP server 'echoes' is removed and stopped.");
    assert!(!mcp_json(root).contains("echoes"));
    assert!(mcp_manager().get_status("echoes").is_none());
    assert_eq!(serde_json::to_string(&hub.definition_for(&ctx(&sid, "c9", false))).unwrap(), definition);
}
