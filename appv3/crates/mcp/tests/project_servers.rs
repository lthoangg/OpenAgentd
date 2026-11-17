//! Servers a project ships in `.agents/mcp.json`: they run only after the
//! user approves them on a card, only for sessions in that workspace, and a
//! changed entry needs approval again; a turn nobody attends never starts
//! one; deleting the file stops them.

use appv3_agent::confirm;
use appv3_mcp::hub::McpHubTool;
use appv3_mcp::mcp_manager;
use appv3_mcp::project::runner_key;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext, ToolError, ToolOutput};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SERVER: &str = r#"import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "t", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "Echo text back", "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}}}]}
    elif m["method"] == "tools/call":
        import os
        r = {"content": [{"type": "text", "text": "got " + m["params"]["arguments"].get("x", "") + " in " + os.path.basename(os.getcwd())}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#;

fn python() -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::split_paths(&path).map(|d| d.join("python3")).find(|p| p.is_file()).map(|p| p.display().to_string())
}

fn ctx(sid: &str, call: &str, workspace: &Path, unattended: bool) -> ToolContext {
    let mut meta = serde_json::Map::new();
    if unattended {
        meta.insert(appv3_agent::agent::UNATTENDED_META.into(), json!(true));
    }
    ToolContext {
        session_id: Some(sid.into()),
        agent_name: "code".into(),
        tool_call_id: call.into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(workspace, None)),
        workspace: Some(workspace.display().to_string()),
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

fn write_project(ws: &Path, entry: Value) {
    std::fs::create_dir_all(ws.join(".agents")).unwrap();
    std::fs::write(ws.join(".agents").join("mcp.json"), json!({"mcpServers": {"echoes": entry}}).to_string()).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_projects_server_runs_after_approval_in_its_workspace_only() {
    let Some(py) = python() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for (k, d) in [("OPENAGENTD_DATA_DIR", "data"), ("OPENAGENTD_CONFIG_DIR", "config"), ("OPENAGENTD_STATE_DIR", "state"), ("OPENAGENTD_CACHE_DIR", "cache")] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("OAD_PROJECT_TEST_TOKEN", "s3cret-token");
    std::fs::create_dir_all(root.join("config")).unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![]));
    appv3_agent::manager::init(pool.clone(), Arc::new(move |_, _| Ok(provider.clone())));
    let script = root.join("srv.py");
    std::fs::write(&script, SERVER).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    let app = root.join("app");
    let other = root.join("other");
    std::fs::create_dir_all(&other).unwrap();
    let entry = json!({"command": py, "args": [script.display().to_string()], "env": {"PATH": path, "TOKEN": "${OAD_PROJECT_TEST_TOKEN}"}});
    write_project(&app, entry.clone());
    let app_ws = app.display().to_string();
    let key = runner_key(&app_ws, "echoes");

    let session = |ws: &Path| {
        let pool = pool.clone();
        let ws = ws.display().to_string();
        async move {
            let sid = uuid::Uuid::now_v7();
            appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(sid), workspace: ws, ..Default::default() }).await.unwrap();
            sid.to_string()
        }
    };
    let sid = session(&app).await;
    let hub = McpHubTool::new(mcp_manager());

    // ── the session's description names it; nothing runs yet ────────────
    let definition = serde_json::to_string(&hub.definition_for(&ctx(&sid, "c0", &app, false))).unwrap();
    assert!(definition.contains("Servers: echoes."), "{definition}");
    let servers = run(&hub, &ctx(&sid, "c1", &app, false), json!({"action": "servers"})).await.unwrap();
    assert!(servers.contains("Servers from this project's .agents/mcp.json") && servers.contains("- echoes (stdio, needs_approval)"), "{servers}");
    assert_eq!(mcp_manager().get_status(&key).unwrap().state, "needs_approval");

    // ── a turn nobody attends is refused, and starts nothing ─────────────
    let e = run(&hub, &ctx(&sid, "c2", &app, true), json!({"action": "search", "query": "", "server": "echoes"})).await.unwrap_err();
    assert!(e.contains("has not approved it") && e.contains("Nobody is there"), "{e}");
    let e = run(&hub, &ctx(&sid, "c3", &app, true), json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "hi"}})).await.unwrap_err();
    assert!(e.contains("has not approved it"), "{e}");
    assert_eq!(mcp_manager().get_status(&key).unwrap().state, "needs_approval");
    assert!(appv3_db::get_pending_question(&pool, &sid).await.unwrap().is_none());

    // ── asking opens a card that names the command and variables ─────────
    assert_eq!(run(&hub, &ctx(&sid, "c4", &app, false), json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "hi"}})).await.unwrap(), "<card>");
    let row = appv3_db::get_pending_question(&pool, &sid).await.unwrap().expect("an open card");
    assert_eq!((row.kind().as_deref(), row.tool_call_id.as_str()), (Some(confirm::CONFIRM_KIND), "c4"));
    let q = row.questions()[0]["question"].as_str().unwrap().to_string();
    assert!(q.starts_with("Allow MCP server **echoes** from this project's `") && q.contains(".agents/mcp.json") && q.contains("runs `"), "{q}");
    assert!(q.contains("`OAD_PROJECT_TEST_TOKEN`") && !q.contains("s3cret"), "{q}");
    let text = confirm::answer(&pool, &sid, &appv3_db::codec::api_uuid(&row.id), &[vec!["Apply".into()]]).await.unwrap().unwrap();
    assert!(text.starts_with("The user applied the change. MCP server 'echoes' is ready with 1 tool"), "{text}");
    let approvals = std::fs::read_to_string(root.join("config").join("mcp-project-approvals.json")).unwrap();
    assert!(approvals.contains(&app_ws), "kept in the user's config: {approvals}");
    assert_eq!(std::fs::read_dir(app.join(".agents")).unwrap().count(), 1, "nothing written to the repository");

    // ── it works there, by its plain name, in the workspace ──────────────
    let out = run(&hub, &ctx(&sid, "c5", &app, false), json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "hi"}})).await.unwrap();
    assert_eq!(out, "got hi in app");
    assert_eq!(serde_json::to_string(&hub.definition_for(&ctx(&sid, "c5", &app, false))).unwrap(), definition, "the description stays frozen");

    // ── and not in another workspace ─────────────────────────────────────
    let other_sid = session(&other).await;
    let e = run(&hub, &ctx(&other_sid, "o1", &other, false), json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "hi"}})).await.unwrap_err();
    assert!(e.contains("'echoes' is not configured") || e.contains("No MCP servers are configured"), "{e}");
    let found = run(&hub, &ctx(&other_sid, "o2", &other, false), json!({"action": "search", "query": "echo"})).await.unwrap();
    assert!(!found.contains("\"server\":\"echoes\""), "{found}");
    let other_def = serde_json::to_string(&hub.definition_for(&ctx(&other_sid, "o3", &other, false))).unwrap();
    assert!(!other_def.contains("echoes"), "{other_def}");
    assert!(mcp_manager().list_status().iter().all(|s| s.project.is_none()), "the global list holds no project's server");

    // ── a changed entry needs approval again ─────────────────────────────
    let mut changed = entry.clone();
    changed["args"] = json!([script.display().to_string(), "--verbose"]);
    write_project(&app, changed);
    let servers = run(&hub, &ctx(&sid, "c6", &app, false), json!({"action": "servers"})).await.unwrap();
    assert!(servers.contains("- echoes (stdio, needs_approval)"), "{servers}");
    let e = run(&hub, &ctx(&sid, "c7", &app, true), json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "hi"}})).await.unwrap_err();
    assert!(e.contains("has not approved it"), "{e}");

    // ── a card for an entry that changed after it was shown applies nothing
    assert_eq!(run(&hub, &ctx(&sid, "c8", &app, false), json!({"action": "search", "query": "", "server": "echoes"})).await.unwrap(), "<card>");
    let row = appv3_db::get_pending_question(&pool, &sid).await.unwrap().expect("an open card");
    write_project(&app, entry.clone());
    let text = confirm::answer(&pool, &sid, &appv3_db::codec::api_uuid(&row.id), &[vec!["Apply".into()]]).await.unwrap().unwrap();
    assert!(text.contains("not applied") && text.contains("changed in .agents/mcp.json since this was shown"), "{text}");

    // ── the original entry is still approved; deleting the file stops it ─
    let out = run(&hub, &ctx(&sid, "c9", &app, false), json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "back"}})).await.unwrap();
    assert_eq!(out, "got back in app", "approved as it was before");
    std::fs::remove_file(app.join(".agents").join("mcp.json")).unwrap();
    let e = run(&hub, &ctx(&sid, "c10", &app, false), json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "hi"}})).await.unwrap_err();
    assert!(e.contains("not configured") || e.contains("No MCP servers are configured"), "{e}");
    assert!(mcp_manager().get_status(&key).is_none(), "its server stopped");

    // ── revoking stops it, and it waits for approval again ───────────────
    write_project(&app, entry);
    mcp_manager().sync_project(&app_ws).await;
    mcp_manager().wait_until_ready(Duration::from_secs(20)).await;
    assert_eq!(mcp_manager().get_status(&key).unwrap().state, "ready");
    mcp_manager().revoke_project_server(&app_ws, "echoes").await.unwrap();
    assert_eq!(mcp_manager().get_status(&key).unwrap().state, "needs_approval");
}
