use super::*;

/// Tiny MCP server over stdio implemented as a shell script.
#[tokio::test]
async fn stdio_roundtrip() {
    let d = tempfile::tempdir().unwrap();
    let script = d.path().join("srv.py");
    std::fs::write(
        &script,
        r#"import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "t", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}}}]}
    elif m["method"] == "tools/call":
        r = {"content": [{"type": "text", "text": "got " + m["params"]["arguments"].get("x", "")}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#,
    )
    .unwrap();
    let Some(py) = which_in("python3", &std::env::var("PATH").unwrap_or_default()) else { return };
    let c = McpClient::stdio(&py, &[script.display().to_string()], &[]).unwrap();
    c.initialize().await.unwrap();
    let tools = c.list_tools().await.unwrap();
    assert_eq!(tools[0]["name"], "echo");
    let r = c.call_tool("echo", json!({"x": "hi"})).await.unwrap();
    assert_eq!(tool::extract_text(r.get("content")), "got hi");
    c.close().await;
    assert!(c.list_tools().await.is_err());
}

/// The `mcp` tool searches and calls a live stdio server end to end.
#[tokio::test]
async fn hub_searches_and_calls_a_live_server() {
    let d = tempfile::tempdir().unwrap();
    let script = d.path().join("srv.py");
    std::fs::write(
            &script,
            r#"import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "t", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "Echo text back", "annotations": {"readOnlyHint": True}, "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}}]}
    elif m["method"] == "tools/call":
        r = {"content": [{"type": "text", "text": "got " + m["params"]["arguments"].get("x", "")}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#,
        )
        .unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    let Some(py) = which_in("python3", &path) else { return };
    let cfg = config::parse_config(&json!({"servers": {"echoes": {"command": py, "args": [script.display().to_string()], "env": {"PATH": path}}}})).unwrap();
    let m = Arc::new(McpManager::default());
    m.spawn_runner("echoes", &cfg.servers["echoes"]);
    m.wait_until_ready(Duration::from_secs(20)).await;
    assert_eq!(m.get_status("echoes").unwrap().state, "ready");

    let hub = hub::McpHubTool::new(m.clone());
    let text = |r: appv3_tools::ToolResult| match r {
        Ok(appv3_tools::ToolOutput::Text(t)) => t,
        other => panic!("{other:?}"),
    };
    let mut meta = serde_json::Map::new();
    meta.insert("interaction_mode".into(), json!("plan"));
    let ctx = appv3_tools::ToolContext {
        session_id: None,
        agent_name: "t".into(),
        tool_call_id: "c".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(d.path(), None)),
        workspace: None,
        output: None,
        metadata: Arc::new(Mutex::new(meta)),
        messages: None,
    };
    use appv3_tools::Tool;
    let found = text(hub.run(&ctx, json!({"action": "search", "query": "echo"})).await);
    assert!(found.contains(r#""server":"echoes","tool":"echo","read_only":true"#), "{found}");
    // Read-only, so Plan mode may call it.
    let got = text(hub.run(&ctx, json!({"action": "call", "server": "echoes", "tool": "echo", "arguments": {"x": "hi"}})).await);
    assert_eq!(got, "got hi");
    m.stop_all().await;
}

/// A server that answers the handshake but never `tools/call`, logging
/// every method it receives (with the cancelled request's id).
fn silent_server(d: &std::path::Path) -> Option<(String, std::path::PathBuf, std::path::PathBuf)> {
    let script = d.join("silent.py");
    let log = d.join("methods.log");
    let src = r#"import sys, json
log = open(sys.argv[1], "a")
for line in sys.stdin:
    m = json.loads(line)
    log.write(m.get("method", "") + " " + json.dumps((m.get("params") or {}).get("requestId")) + "\n"); log.flush()
    if "id" not in m or m["method"] == "tools/call": continue
    r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "t", "version": "1"}} if m["method"] == "initialize" else {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#;
    std::fs::write(&script, src).unwrap();
    let py = which_in("python3", &std::env::var("PATH").unwrap_or_default())?;
    Some((py, script, log))
}

async fn logged_cancel(log: &std::path::Path) -> String {
    for _ in 0..50 {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        if text.contains("notifications/cancelled") {
            return text;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    std::fs::read_to_string(log).unwrap_or_default()
}

#[test]
fn initialize_waits_for_a_sign_in_in_progress() {
    let wait = std::time::Duration::from_secs(600);
    let c = McpClient::http("https://example.invalid/mcp", &[], None, config::HttpKind::Streamable).unwrap();
    assert_eq!(c.deadline("initialize").as_secs(), 30);
    let c = c.with_sign_in_wait(Some(wait));
    // The user approves in a browser during `initialize`'s first 401.
    assert_eq!(c.deadline("initialize"), wait);
    assert_eq!(c.deadline("tools/list").as_secs(), 30);
}

#[tokio::test]
async fn stdio_tool_call_times_out_and_is_cancelled() {
    let d = tempfile::tempdir().unwrap();
    let Some((py, script, log)) = silent_server(d.path()) else { return };
    let c = McpClient::stdio(&py, &[script.display().to_string(), log.display().to_string()], &[]).unwrap();
    // Handshake on the default deadline: Python can take over 1 s to start on Windows.
    c.initialize().await.unwrap();
    let c = c.with_timeout(Some(1));
    let e = c.call_tool("echo", json!({})).await.unwrap_err();
    assert!(e.to_string().contains("timed out after 1 s"), "{e}");
    assert_eq!(c.pending_len(), 0);
    // `tools/call` was request 2 (after `initialize`).
    let text = logged_cancel(&log).await;
    assert!(text.contains("notifications/cancelled 2"), "{text}");
    c.close().await;
}

#[tokio::test]
async fn dropping_a_stdio_call_cancels_it() {
    let d = tempfile::tempdir().unwrap();
    let Some((py, script, log)) = silent_server(d.path()) else { return };
    let c = McpClient::stdio(&py, &[script.display().to_string(), log.display().to_string()], &[]).unwrap();
    c.initialize().await.unwrap();
    assert!(tokio::time::timeout(std::time::Duration::from_millis(300), c.call_tool("echo", json!({}))).await.is_err());
    assert_eq!(c.pending_len(), 0);
    let text = logged_cancel(&log).await;
    assert!(text.contains("notifications/cancelled 2"), "{text}");
    c.close().await;
}

#[test]
fn server_timeout_is_validated_and_round_trips() {
    let ok = config::parse_config(&json!({"servers": {"a": {"command": "x", "timeout": 120}}})).unwrap();
    assert_eq!(ok.servers["a"].timeout(), Some(120));
    assert_eq!(ok.servers["a"].dump()["timeout"], 120);
    let none = config::parse_config(&json!({"servers": {"a": {"command": "x"}}})).unwrap();
    assert!(none.servers["a"].dump().get("timeout").is_none());
    for bad in [json!(0), json!(271), json!("x")] {
        assert!(config::parse_config(&json!({"servers": {"a": {"command": "x", "timeout": bad}}})).is_err(), "{bad}");
    }
}

/// A server whose one tool reports the directory it runs in and the
/// `PLUGIN_MARK` of its environment, as `<directory>|<mark>`.
const WHERE_SERVER: &str = r#"import sys, json, os
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

fn real(path: impl AsRef<Path>) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap()
}

#[tokio::test]
async fn a_stdio_server_starts_in_its_working_directory_when_it_has_one() {
    let Some(py) = which_in("python3", &std::env::var("PATH").unwrap_or_default()) else { return };
    let d = tempfile::tempdir().unwrap();
    let script = d.path().join("srv.py");
    std::fs::write(&script, WHERE_SERVER).unwrap();
    let work = d.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let args = [script.display().to_string()];
    let said = |c: McpClient| async move {
        c.initialize().await.unwrap();
        let r = c.call_tool("where", json!({})).await.unwrap();
        c.close().await;
        tool::extract_text(r.get("content"))
    };
    let in_work = said(McpClient::stdio_in(&py, &args, &[], Some(&work)).unwrap()).await;
    assert_eq!(real(in_work.split('|').next().unwrap()), real(&work));
    // No directory: the child keeps this process's, as it always did.
    let here = said(McpClient::stdio(&py, &args, &[]).unwrap()).await;
    assert_eq!(real(here.split('|').next().unwrap()), real(std::env::current_dir().unwrap()));
}

#[test]
fn a_relative_program_path_is_looked_for_in_the_servers_directory() {
    let dir = Path::new("/plugins/p");
    assert_eq!(program_in("./bin/server", Some(dir)), dir.join("./bin/server").display().to_string());
    assert_eq!(program_in("bin/server", Some(dir)), dir.join("bin/server").display().to_string());
    assert_eq!(program_in("node", Some(dir)), "node", "a bare name is looked up on PATH");
    assert_eq!(program_in("./bin/server", None), "./bin/server", "without a directory nothing changes");
    assert_eq!(program_in("node", None), "node");
    #[cfg(unix)]
    assert_eq!(program_in("/usr/bin/node", Some(dir)), "/usr/bin/node");
}

/// A plugin's server runs in its directory with its environment, and the
/// `mcp` tool searches and calls it by its `<plugin>/<server>` name.
#[tokio::test]
async fn a_plugin_server_runs_live_and_the_mcp_tool_reaches_it_by_its_full_name() {
    let path = std::env::var("PATH").unwrap_or_default();
    let Some(py) = which_in("python3", &path) else { return };
    let d = tempfile::tempdir().unwrap();
    let script = d.path().join("srv.py");
    std::fs::write(&script, WHERE_SERVER).unwrap();
    let work = d.path().join("plugins").join("changelog-tools");
    std::fs::create_dir_all(&work).unwrap();
    let mut env = IndexMap::new();
    env.insert("PATH".to_string(), path);
    env.insert("PLUGIN_MARK".to_string(), "from-plugin".to_string());
    let cfg = ServerConfig::Stdio { command: py, args: vec![script.display().to_string()], env, enabled: true, timeout: None, cwd: Some(work.clone()) };
    let m = Arc::new(McpManager::default());
    m.apply_plugin_servers(vec![plugin::Wanted { name: "changelog-tools/github".into(), plugin: "changelog-tools".into(), config: cfg }]).await;
    m.wait_until_ready(Duration::from_secs(20)).await;
    let st = m.get_status("changelog-tools/github").unwrap();
    assert_eq!((st.state.as_str(), st.plugin.as_deref()), ("ready", Some("changelog-tools")), "{st:?}");
    assert_eq!(st.tool_names, ["changelog-tools/github_where"]);

    let hub = hub::McpHubTool::new(m.clone());
    let text = |r: appv3_tools::ToolResult| match r {
        Ok(appv3_tools::ToolOutput::Text(t)) => t,
        other => panic!("{other:?}"),
    };
    let mut meta = serde_json::Map::new();
    meta.insert("interaction_mode".into(), json!("plan"));
    let ctx = appv3_tools::ToolContext {
        session_id: None,
        agent_name: "t".into(),
        tool_call_id: "c".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(d.path(), None)),
        workspace: None,
        output: None,
        metadata: Arc::new(Mutex::new(meta)),
        messages: None,
    };
    use appv3_tools::Tool;
    let found = text(hub.run(&ctx, json!({"action": "search", "server": "changelog-tools/github"})).await);
    assert!(found.contains(r#""server":"changelog-tools/github","tool":"where","read_only":true"#), "{found}");
    let got = text(hub.run(&ctx, json!({"action": "call", "server": "changelog-tools/github", "tool": "where"})).await);
    let (dir, mark) = got.split_once('|').unwrap();
    assert_eq!((real(dir), mark), (real(&work), "from-plugin"));
    // The `<server>_<tool>` name older transcripts used reaches it too.
    let older = text(hub.run(&ctx, json!({"action": "call", "server": "changelog-tools/github", "tool": "changelog-tools/github_where"})).await);
    assert_eq!(older, got);

    m.apply_plugin_servers(vec![]).await;
    assert!(m.get_status("changelog-tools/github").is_none());
}

use RunnerState::*;

/// Every runner starts once: only `starting` settles, and only a ready
/// server can still stop. A settled runner never changes again.
#[test]
fn runner_transitions_follow_the_lifecycle() {
    let all = [Stopped, Starting, Ready, Error, AuthRequired];
    let allowed = [(Starting, Ready), (Starting, Stopped), (Starting, Error), (Starting, AuthRequired), (Ready, Stopped)];
    for from in all {
        for to in all {
            assert_eq!(from.can_become(to), allowed.contains(&(from, to)), "{from:?} -> {to:?}");
        }
    }
    assert_eq!(all.map(RunnerState::as_str), ["stopped", "starting", "ready", "error", "auth_required"]);
    assert_eq!(all.map(RunnerState::settled), [true, false, true, true, true]);
}

#[tokio::test]
async fn a_late_completion_does_not_overwrite_a_settled_runner() {
    let cfg = config::parse_config(&json!({"servers": {"s": {"command": "x"}}})).unwrap();
    let runner = Runner::new("s", &cfg.servers["s"], Starting, None);
    assert!(!runner.wait_settled(Duration::from_millis(10)).await, "starting is not settled");
    assert!(runner.settle(Error, Some("boom".into())));
    assert!(!runner.settle(Stopped, None), "a stale stop is ignored");
    let st = runner.status();
    assert_eq!((st.state.as_str(), st.error.as_deref()), ("error", Some("boom")));
    assert!(runner.wait_settled(Duration::from_millis(10)).await);
}

/// A start attempt that fails has settled, but the server is not ready.
#[tokio::test]
async fn a_server_that_cannot_start_settles_as_an_error() {
    let d = tempfile::tempdir().unwrap();
    let missing = d.path().join("no-such-server").display().to_string();
    let cfg = config::parse_config(&json!({"servers": {"broken": {"command": missing, "env": {"PATH": d.path().display().to_string()}}}})).unwrap();
    let m = McpManager::default();
    m.spawn_runner("broken", &cfg.servers["broken"]);
    m.wait_until_ready(Duration::from_secs(20)).await;
    let st = m.get_status("broken").unwrap();
    assert_eq!(st.state, "error", "{st:?}");
    assert!(st.error.is_some());
    assert_eq!(m.tools_for_server("broken").map(|t| t.len()), Some(0));
}

/// Stopping a ready server leaves the runner stopped, without its tools
/// or client, rather than still claiming `ready`.
#[tokio::test]
async fn stopping_a_ready_server_leaves_it_stopped_without_tools() {
    let path = std::env::var("PATH").unwrap_or_default();
    let py = which_in("python3", &path).expect("this test needs python3 on PATH: it runs a small stdio MCP server");
    let d = tempfile::tempdir().unwrap();
    let script = d.path().join("srv.py");
    std::fs::write(&script, WHERE_SERVER).unwrap();
    let cfg = config::parse_config(&json!({"servers": {"w": {"command": py, "args": [script.display().to_string()], "env": {"PATH": path}}}})).unwrap();
    let m = McpManager::default();
    m.spawn_runner("w", &cfg.servers["w"]);
    m.wait_until_ready(Duration::from_secs(20)).await;
    let runner = m.runners.read().unwrap().get("w").cloned().unwrap();
    assert_eq!(m.get_status("w").unwrap().state, "ready");

    McpManager::stop_runner(&runner).await;
    let st = m.get_status("w").unwrap();
    assert_eq!(st.state, "stopped", "{st:?}");
    assert!(st.tool_names.is_empty());
    assert_eq!(m.tools_for_server("w").map(|t| t.len()), Some(0));
    assert!(runner.client().is_none());
}

/// A Streamable HTTP server that keeps sessions: `initialize` opens one,
/// every other request needs one it knows, and DELETE ends it. Returns
/// its URL, the requests it got (`<what> <session>`), and its sessions.
async fn session_server() -> (String, Arc<Mutex<Vec<String>>>, Arc<Mutex<Vec<String>>>) {
    use axum::http::{HeaderMap, Method, StatusCode};
    use axum::response::IntoResponse;
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let open: Arc<Mutex<Vec<String>>> = Arc::default();
    let opened = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (log2, open2) = (log.clone(), open.clone());
    let handle = move |method: Method, headers: HeaderMap, body: String| {
        let (log, open, opened) = (log2.clone(), open2.clone(), opened.clone());
        async move {
            let session = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let known = open.lock().unwrap().contains(&session);
            if method == Method::DELETE {
                log.lock().unwrap().push(format!("DELETE {session}"));
                open.lock().unwrap().retain(|s| *s != session);
                return StatusCode::OK.into_response();
            }
            if method != Method::POST {
                return StatusCode::METHOD_NOT_ALLOWED.into_response();
            }
            let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let (Some(id), Some(what)) = (msg.get("id").cloned(), msg["method"].as_str()) else { return StatusCode::ACCEPTED.into_response() };
            if what == "initialize" {
                let session = format!("s-{}", opened.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1);
                log.lock().unwrap().push(format!("initialize {session}"));
                open.lock().unwrap().push(session.clone());
                let result = json!({"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake", "version": "1"}});
                return ([("mcp-session-id", session)], axum::Json(json!({"jsonrpc": "2.0", "id": id, "result": result}))).into_response();
            }
            log.lock().unwrap().push(format!("{what} {session}"));
            if !known {
                return StatusCode::NOT_FOUND.into_response();
            }
            let result = json!({"tools": [{"name": "draw", "description": "Draw on the canvas"}]});
            axum::Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, axum::Router::new().fallback(axum::routing::any(handle))).await.unwrap() });
    (url, log, open)
}

/// A server keeps state for a session (a canvas an app drew on). Ending
/// the session with every restart of this process lost that state.
#[tokio::test]
async fn an_http_servers_session_outlives_a_restart_of_the_process() {
    let (url, log, open) = session_server().await;
    let dir = tempfile::tempdir().unwrap();
    let cfg = config::parse_config(&json!({"servers": {"t-kept-session": {"url": url}}})).unwrap();
    // One process: its manager, with the sessions file every process shares.
    let process = || async {
        let m = McpManager { sessions: Arc::new(sessions::SessionStore::at(dir.path().join("mcp-sessions.json"))), ..Default::default() };
        m.spawn_runner("t-kept-session", &cfg.servers["t-kept-session"]);
        m.wait_until_ready(Duration::from_secs(20)).await;
        let st = m.get_status("t-kept-session").unwrap();
        assert_eq!((st.state.as_str(), st.tool_names.len()), ("ready", 1), "{st:?}");
        m
    };
    let seen = || std::mem::take(&mut *log.lock().unwrap());

    let first = process().await;
    first.stop().await;
    assert_eq!(seen(), ["initialize s-1", "tools/list s-1"], "stopping the process does not end the session");

    let second = process().await;
    assert_eq!(seen(), ["tools/list s-1"], "the next process goes on with it");

    // Stopping the one server (a restart, a removal) ends its session.
    let runner = second.runners.read().unwrap().get("t-kept-session").cloned().unwrap();
    McpManager::stop_runner(&runner).await;
    assert_eq!(seen(), ["DELETE s-1"]);
    let third = process().await;
    assert_eq!(seen(), ["initialize s-2", "tools/list s-2"]);

    // A session the server dropped meanwhile is replaced by a new one.
    third.stop().await;
    open.lock().unwrap().clear();
    let fourth = process().await;
    assert_eq!(seen(), ["tools/list s-2", "initialize s-3", "tools/list s-3"]);
    fourth.stop().await;
    assert_eq!(process().await.get_status("t-kept-session").unwrap().state, "ready");
    assert_eq!(seen(), ["tools/list s-3"]);
}

#[tokio::test]
async fn an_apps_call_waits_for_a_server_that_is_still_connecting() {
    let (url, _, _) = session_server().await;
    let dir = tempfile::tempdir().unwrap();
    let cfg = config::parse_config(&json!({"servers": {"t-app-waits": {"url": url}}})).unwrap();
    let m = McpManager { sessions: Arc::new(sessions::SessionStore::at(dir.path().join("mcp-sessions.json"))), ..Default::default() };
    m.spawn_runner("t-app-waits", &cfg.servers["t-app-waits"]);
    assert_eq!(m.get_status("t-app-waits").unwrap().state, "starting");
    let answer = m.call_app_tool("t-app-waits", "draw", json!({})).await;
    assert!(answer.is_ok(), "{answer:?}");
    m.stop().await;
}
