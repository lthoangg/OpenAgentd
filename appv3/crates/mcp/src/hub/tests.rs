use super::*;
use crate::tool::SessionProvider;
use crate::{config, Runner, RunnerState};

struct NoSession;
impl SessionProvider for NoSession {
    fn client(&self) -> Option<Arc<crate::client::McpClient>> {
        None
    }
}

fn tool(server: &str, name: &str, desc: &str) -> Found {
    let s: Arc<dyn SessionProvider> = Arc::new(NoSession);
    Found::Mcp(Arc::new(McpTool::new(server, json!({"name": name, "description": desc}), Arc::downgrade(&s))))
}

fn names(tools: &[Found]) -> Vec<String> {
    tools.iter().map(|t| format!("{}.{}", t.server(), t.tool())).collect()
}

#[test]
fn rank_scores_names_servers_and_descriptions() {
    let tools = vec![
        tool("github", "list_issues", "List issues in a repository"),
        tool("github", "create_issue", "Open a new issue"),
        tool("docs", "search", "Search the docs for an issue"),
        tool("docs", "fetch", "Fetch a page"),
    ];
    assert_eq!(names(&rank("create issue", None, &tools, 8)), ["github.create_issue", "github.list_issues", "docs.search"]);
    assert_eq!(names(&rank("search", None, &tools, 8)), ["docs.search"], "an exact name wins and no-match tools drop");
    assert_eq!(names(&rank("issue", Some("docs"), &tools, 8)), ["docs.search"]);
    assert_eq!(names(&rank("", Some("docs"), &tools, 8)), ["docs.search", "docs.fetch"], "empty query lists the server");
    assert_eq!(names(&rank("", None, &tools, 2)), ["github.list_issues", "github.create_issue"]);
    assert!(rank("nothing", None, &tools, 8).is_empty());
}

fn status(name: &str, state: &str, tools: &[&str]) -> ServerStatus {
    ServerStatus {
        name: name.into(),
        transport: "stdio".into(),
        enabled: state != "disabled",
        state: if state == "disabled" { "stopped".into() } else { state.into() },
        error: None,
        tool_names: tools.iter().map(|t| format!("{name}_{t}")).collect(),
        started_at: None,
        plugin: None,
        project: None,
    }
}

/// The description sits in the cached tools block: a server starting,
/// connecting, needing sign-in or failing must not change it, or every
/// session's next call re-sends its whole context.
#[test]
fn the_description_names_enabled_servers_whatever_their_state() {
    let s = describe_servers(&[status("slack", "auth_required", &[]), status("docs", "ready", &["search", "fetch"]), status("old", "disabled", &[])], &[]);
    assert_eq!(s, "Servers: docs, slack. Search with a server and an empty query to list its tools.");
    for (docs, slack) in [("starting", "starting"), ("ready", "ready"), ("error", "auth_required")] {
        assert_eq!(describe_servers(&[status("docs", docs, &["search"]), status("slack", slack, &["post"])], &[]), s, "{docs}/{slack}");
    }
    assert_ne!(describe_servers(&[status("docs", "ready", &[]), status("slack", "disabled", &[])], &[]), s, "disabling a server is a config change");
    assert_eq!(describe_servers(&[status("old", "disabled", &[])], &[]), "No MCP servers are enabled.");
    assert_eq!(describe_servers(&[], &[]), "No MCP servers are configured.");
}

#[test]
fn the_description_names_the_plugins_with_tools_among_the_servers() {
    let kit = ["test-kit".to_string()];
    assert_eq!(describe_servers(&[status("docs", "ready", &[])], &kit), "Servers: docs, test-kit. Search with a server and an empty query to list its tools.");
    assert_eq!(describe_servers(&[], &kit), "Servers: test-kit. Search with a server and an empty query to list its tools.");
    assert_eq!(describe_servers(&[status("old", "disabled", &[])], &kit), "Servers: test-kit. Search with a server and an empty query to list its tools.");
}

#[test]
fn read_only_reads_the_annotation() {
    let s: Arc<dyn SessionProvider> = Arc::new(NoSession);
    let t = |def: Value| McpTool::new("s", def, Arc::downgrade(&s)).read_only();
    assert!(t(json!({"name": "a", "annotations": {"readOnlyHint": true}})));
    assert!(!t(json!({"name": "a", "annotations": {"readOnlyHint": false}})));
    assert!(!t(json!({"name": "a"})));
}

/// A manager with one ready server whose tools have no live client. A
/// name with a `/` is a plugin's server (`<plugin>/<server>`).
fn manager_with(server: &str, defs: Vec<Value>) -> Arc<McpManager> {
    let m = Arc::new(McpManager::default());
    let cfg = config::parse_config(&json!({"servers": {"s": {"command": "x"}}})).unwrap();
    let runner = Runner::new(server, &cfg.servers["s"], RunnerState::Ready, server.split_once('/').map(|(plugin, _)| plugin));
    let weak = Arc::downgrade(&(runner.clone() as Arc<dyn SessionProvider>));
    let tools: Vec<Arc<McpTool>> = defs.into_iter().map(|d| Arc::new(McpTool::new(server, d, weak.clone()))).collect();
    runner.details.lock().unwrap().tool_names = crate::model_tool_names(&tools);
    *runner.tools.lock().unwrap() = tools;
    m.runners.write().unwrap().insert(server.into(), runner);
    m
}

fn ctx(plan: bool) -> ToolContext {
    let mut meta = Map::new();
    if plan {
        meta.insert("interaction_mode".into(), json!("plan"));
    }
    ToolContext {
        session_id: None,
        agent_name: "t".into(),
        tool_call_id: "c".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(&std::env::temp_dir(), None)),
        workspace: None,
        output: None,
        metadata: Arc::new(std::sync::Mutex::new(meta)),
        messages: None,
    }
}

async fn run(hub: &McpHubTool, plan: bool, args: Value) -> Result<String, String> {
    match hub.run(&ctx(plan), args).await {
        Ok(ToolOutput::Text(t)) => Ok(t),
        Ok(other) => Ok(format!("{other:?}")),
        Err(e) => Err(e.to_string()),
    }
}

struct Echo;

#[async_trait]
impl appv3_agent::plugins::ExtraRun for Echo {
    async fn run(&self, _: &ToolContext, args: Value) -> ToolResult {
        Ok(ToolOutput::text(format!("ran {args}")))
    }
}

fn plugin_tool(name: &str, description: &str, read_only: bool) -> Arc<ExtraTool> {
    Arc::new(ExtraTool {
        plugin: "test-kit".into(),
        name: name.into(),
        description: description.into(),
        input_schema: json!({"type": "object", "properties": {"since": {"type": "string", "description": "A tag"}}, "required": ["since"]}),
        read_only,
        runner: Arc::new(Echo),
    })
}

fn test_kit() -> Vec<Arc<ExtraTool>> {
    vec![plugin_tool("draft_notes", "Draft release notes from merged PRs", true), plugin_tool("publish", "Publish the notes", false)]
}

/// The hub over `manager`, with test-kit's tools as the plugins' tools.
fn hub_with_test_kit(manager: Arc<McpManager>) -> McpHubTool {
    McpHubTool { manager, plugin_tools: test_kit }
}

/// `_meta.ui.visibility` says who may call a tool. The agent is never
/// offered a tool meant for the app's panel, and the panel cannot call a
/// tool meant for the agent alone.
#[tokio::test]
async fn app_only_tools_are_hidden_from_the_agent_and_kept_for_the_app() {
    let m = manager_with(
        "canvas",
        vec![
            json!({"name": "exec", "description": "Run code on the canvas"}),
            json!({"name": "save_checkpoint", "description": "Save the canvas", "_meta": {"ui": {"visibility": ["app"]}}}),
            json!({"name": "plan", "description": "Plan a drawing", "_meta": {"ui": {"visibility": ["model"]}}}),
            json!({"name": "both", "description": "Refresh the canvas", "_meta": {"ui": {"visibility": ["model", "app"]}}}),
        ],
    );
    let agent_tools = ["canvas_exec", "canvas_plan", "canvas_both"];
    assert_eq!(m.tools_for_server("canvas").unwrap().iter().map(|t| t.name().to_string()).collect::<Vec<_>>(), agent_tools);
    assert_eq!(m.ready_tools(None).iter().map(|t| t.name.clone()).collect::<Vec<_>>(), agent_tools);
    assert_eq!(m.get_status("canvas").unwrap().tool_names, agent_tools);

    let hub = hub_with_test_kit(m.clone());
    let listed = run(&hub, false, json!({"action": "search", "server": "canvas"})).await.unwrap();
    assert!(!listed.contains("save_checkpoint"), "{listed}");
    let refused = run(&hub, false, json!({"action": "call", "server": "canvas", "tool": "save_checkpoint", "arguments": {}})).await.unwrap_err();
    assert!(refused.contains("save_checkpoint") && !refused.contains("not connected"), "{refused}");

    let runner = m.runners.read().unwrap().get("canvas").cloned().unwrap();
    assert_eq!(["exec", "save_checkpoint", "plan", "both", "nope"].map(|t| runner.app_may_call(t)), [true, true, false, true, false]);
}

/// A call or search refused because the server waits on sign-in names it
/// in the words the transcript recognizes, and that answer (as a failed
/// call is stored, `Error: …`) rides with the call, so Sign in shows there.
#[tokio::test]
async fn a_call_refused_for_sign_in_rides_with_the_call() {
    let m = Arc::new(McpManager::default());
    let cfg = config::parse_config(&json!({"servers": {"s": {"command": "x"}}})).unwrap();
    m.runners.write().unwrap().insert("excalidraw".into(), Runner::new("excalidraw", &cfg.servers["s"], RunnerState::AuthRequired, None));
    let hub = hub_with_test_kit(m);
    for args in [json!({"action": "call", "server": "excalidraw", "tool": "create_view"}), json!({"action": "search", "server": "excalidraw"})] {
        let answer = format!("Error: {}", run(&hub, false, args).await.unwrap_err());
        assert!(answer.starts_with("Error: MCP server 'excalidraw' is not ready (") && answer.contains(appv3_core::MCP_SIGN_IN_NOTE), "{answer}");
        assert!(appv3_db::api::result_rides_inline("mcp", &answer), "{answer}");
    }
}

#[tokio::test]
async fn plugin_tools_are_searched_and_called_under_the_plugins_name() {
    let lookup = json!({"name": "lookup", "description": "Look up a page", "annotations": {"readOnlyHint": true}});
    let hub = hub_with_test_kit(manager_with("docs", vec![lookup]));
    assert!(hub.definition()["function"]["description"].as_str().unwrap().ends_with("\n\nServers: docs, test-kit. Search with a server and an empty query to list its tools."));

    let all = run(&hub, false, json!({"action": "search"})).await.unwrap();
    let entries: Vec<Value> = all.lines().skip(1).map(|l| serde_json::from_str(l).unwrap()).collect();
    let found: Vec<(&str, &str)> = entries.iter().map(|e| (e["server"].as_str().unwrap(), e["tool"].as_str().unwrap())).collect();
    assert_eq!(found, [("docs", "lookup"), ("test-kit", "draft_notes"), ("test-kit", "publish")], "the servers' tools, then the plugins'");
    assert_eq!(entries[1]["read_only"], true);
    assert_eq!(entries[1]["input_schema"]["required"], json!(["since"]));
    let kit = run(&hub, false, json!({"action": "search", "server": "test-kit", "query": "draft release"})).await.unwrap();
    assert!(kit.starts_with("1 tool ") && kit.contains(r#""tool":"draft_notes""#), "{kit}");

    let args = json!({"since": "v1.2.0"});
    for tool in ["draft_notes", "test-kit/draft_notes", "test-kit.draft_notes"] {
        let ran = run(&hub, false, json!({"action": "call", "server": "test-kit", "tool": tool, "arguments": args})).await.unwrap();
        assert_eq!(ran, r#"ran {"since":"v1.2.0"}"#, "{tool}");
    }
    let e = run(&hub, false, json!({"action": "call", "server": "test-kit", "tool": "publish"})).await.unwrap_err();
    assert!(e.contains("Plugin tool 'test-kit.publish' got invalid arguments: 'since' is required. Its input_schema: {"), "{e}");
    let e = run(&hub, true, json!({"action": "call", "server": "test-kit", "tool": "publish", "arguments": args})).await.unwrap_err();
    assert!(e.contains("Plugin tool 'test-kit.publish' is not marked read-only, so it is unavailable in Plan mode."), "{e}");
    assert_eq!(run(&hub, true, json!({"action": "call", "server": "test-kit", "tool": "draft_notes", "arguments": args})).await.unwrap(), r#"ran {"since":"v1.2.0"}"#);
    let e = run(&hub, false, json!({"action": "call", "server": "test-kit", "tool": "publish_now", "arguments": args})).await.unwrap_err();
    assert!(e.contains("Plugin 'test-kit' has no tool 'publish_now'. Closest: publish."), "{e}");
    let e = run(&hub, false, json!({"action": "call", "server": "nope", "tool": "x"})).await.unwrap_err();
    assert!(e.contains("MCP server 'nope' is not configured. Servers: docs, test-kit."), "{e}");
}

#[tokio::test]
async fn a_users_server_named_like_a_plugin_hides_the_plugins_tools() {
    let lookup = json!({"name": "lookup", "description": "Look up a page"});
    let hub = hub_with_test_kit(manager_with("test-kit", vec![lookup]));
    assert!(hub.definition()["function"]["description"].as_str().unwrap().ends_with("\n\nServers: test-kit. Search with a server and an empty query to list its tools."));
    let all = run(&hub, false, json!({"action": "search"})).await.unwrap();
    assert!(all.starts_with("1 tool ") && all.contains(r#""tool":"lookup""#), "{all}");
    let e = run(&hub, false, json!({"action": "call", "server": "test-kit", "tool": "draft_notes", "arguments": {"since": "v1"}})).await.unwrap_err();
    assert!(e.contains("MCP server 'test-kit' has no tool 'draft_notes'."), "{e}");
}

#[test]
fn servers_lists_each_plugins_tools() {
    assert_eq!(
        plugin_tools_text(&test_kit()),
        "Tools from plugins (call them with the plugin's name as server; the user manages them in Settings → Plugins):\n- test-kit — 2 tools: draft_notes, publish"
    );
}

fn strict_kit() -> Vec<Arc<ExtraTool>> {
    let schema = json!({"type": "object", "properties": {
        "since": {"type": "string", "description": "A tag"},
        "limit": {"type": "integer", "minimum": 1, "description": "Most notes"},
        "format": {"type": "string", "enum": ["md", "txt"], "description": "Output format"}
    }, "required": ["since"], "additionalProperties": false});
    vec![Arc::new(ExtraTool { input_schema: schema, ..(*plugin_tool("notes", "Draft notes", true)).clone() })]
}

#[tokio::test]
async fn call_names_every_argument_problem_before_running_the_tool() {
    let hub = McpHubTool { manager: Arc::new(McpManager::default()), plugin_tools: strict_kit };
    let call = |arguments: Value| json!({"action": "call", "server": "test-kit", "tool": "notes", "arguments": arguments});
    let e = run(&hub, false, call(json!({"since": 5, "limit": 0, "format": "pdf", "colour": "red"}))).await.unwrap_err();
    assert!(
        e.contains(r#"Plugin tool 'test-kit.notes' got invalid arguments: 'since' must be a string, not a number; 'limit' must be at least 1; 'format' must be one of "md", "txt"; 'colour' is not an allowed argument. Its input_schema: {"#),
        "{e}"
    );
    assert_eq!(
        run(&hub, false, call(json!({"since": "v1", "limit": 3, "format": null}))).await.unwrap(),
        r#"ran {"since":"v1","limit":3,"format":null}"#,
        "a null optional argument passes"
    );
}

/// A model sometimes writes one of the tool's arguments beside
/// `arguments`. Dropped silently, an "edit this one" call became a
/// "make a new one" call.
#[tokio::test]
async fn call_takes_a_tools_argument_written_beside_arguments() {
    let hub = McpHubTool { manager: Arc::new(McpManager::default()), plugin_tools: strict_kit };
    let call = |extra: Value| {
        let mut args = json!({"action": "call", "server": "test-kit", "tool": "notes", "arguments": {"since": "v1"}});
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        args
    };
    assert_eq!(run(&hub, false, call(json!({"format": "md"}))).await.unwrap(), r#"ran {"since":"v1","format":"md"}"#);
    // The tool's `limit` is not the search `limit` of this tool.
    assert_eq!(run(&hub, false, call(json!({"limit": 3}))).await.unwrap(), r#"ran {"since":"v1"}"#);

    let e = run(&hub, false, call(json!({"colour": "red"}))).await.unwrap_err();
    assert!(e.contains("'colour' is not a field of the mcp tool. Put the arguments of 'test-kit.notes' inside `arguments`. Its input_schema: {"), "{e}");
    let e = run(&hub, false, call(json!({"since": "v2"}))).await.unwrap_err();
    assert!(e.contains("'since' is not a field of the mcp tool."), "given twice, it is not guessed: {e}");
}

#[tokio::test]
async fn search_returns_schemas_and_call_checks_before_running() {
    let hub = McpHubTool::new(manager_with(
        "docs",
        vec![
            json!({"name": "lookup", "description": "Look up a page", "annotations": {"readOnlyHint": true}, "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}}),
            json!({"name": "delete_page", "description": "Delete a page"}),
        ],
    ));
    assert!(hub.definition()["function"]["description"].as_str().unwrap().ends_with("\n\nServers: docs. Search with a server and an empty query to list its tools."));
    assert_eq!(appv3_tools::schema_problems(&hub.definition()), Vec::<String>::new());

    let found = run(&hub, false, json!({"action": "search", "query": "look up"})).await.unwrap();
    let mut lines = found.lines();
    assert_eq!(lines.next(), Some("1 tool (run one with action='call', server, tool and arguments):"));
    let entry: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    assert_eq!(entry["tool"], "lookup");
    assert_eq!(entry["read_only"], true);
    assert_eq!(entry["input_schema"]["required"], json!(["q"]));
    assert!(run(&hub, false, json!({"action": "search", "query": "zzz"})).await.unwrap().starts_with("No MCP tools match 'zzz'. Ready servers: docs (2 tools)."));
    assert!(run(&hub, false, json!({"action": "search", "server": "nope"})).await.unwrap_err().contains("'nope' is not configured. Servers: docs."));

    let e = run(&hub, false, json!({"action": "call", "server": "docs", "tool": "lookup", "arguments": {}})).await.unwrap_err();
    assert!(e.contains("MCP tool 'docs.lookup' got invalid arguments: 'q' is required. Its input_schema: {"), "{e}");
    let e = run(&hub, true, json!({"action": "call", "server": "docs", "tool": "delete_page"})).await.unwrap_err();
    assert!(e.contains("not marked read-only, so it is unavailable in Plan mode"), "{e}");
    // Read-only in Plan mode, a JSON-string `arguments`, and the old
    // prefixed name all pass the checks and reach the (absent) client.
    let e = run(&hub, true, json!({"action": "call", "server": "docs", "tool": "docs_lookup", "arguments": "{\"q\": \"x\"}"})).await.unwrap_err();
    assert!(e.contains("MCP server 'docs' is not connected."), "{e}");
    let e = run(&hub, false, json!({"action": "call", "server": "docs", "tool": "delete"})).await.unwrap_err();
    assert!(e.contains("has no tool 'delete'. Closest: delete_page."), "{e}");
    assert!(run(&hub, false, json!({"action": "call", "server": "docs"})).await.unwrap_err().contains("needs server and tool"));
    assert!(run(&hub, false, json!({"action": "call", "server": "docs", "tool": "lookup", "arguments": [1]})).await.unwrap_err().contains("must be a JSON object"));
    assert!(run(&hub, false, json!({"action": "nope"})).await.unwrap_err().contains("Unknown action 'nope'"));
}

/// A plugin's server is `<plugin>/<server>`, and the `/` (and a `.` in
/// either part) must not trip the tool's lookups: the name search
/// returned is the one `call` takes.
#[tokio::test]
async fn a_plugin_servers_full_name_works_for_search_call_and_the_listing() {
    let lookup = json!({"name": "lookup", "description": "Look up a commit", "annotations": {"readOnlyHint": true}, "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}});
    let hub = McpHubTool::new(manager_with("changelog-tools/git.hub", vec![lookup]));
    assert!(hub.definition()["function"]["description"]
        .as_str()
        .unwrap()
        .ends_with("\n\nServers: changelog-tools/git.hub. Search with a server and an empty query to list its tools."));

    let found = run(&hub, false, json!({"action": "search", "server": "changelog-tools/git.hub"})).await.unwrap();
    let entry: Value = serde_json::from_str(found.lines().nth(1).unwrap()).unwrap();
    assert_eq!((entry["server"].as_str(), entry["tool"].as_str()), (Some("changelog-tools/git.hub"), Some("lookup")));
    assert!(
        run(&hub, false, json!({"action": "search", "query": "changelog commit"})).await.unwrap().contains(r#""tool":"lookup""#),
        "the words of the plugin's name find its tools"
    );

    // The name as search returned it, and both older `<server>_<tool>` / `<server>.<tool>` forms.
    for tool in ["lookup", "changelog-tools/git.hub_lookup", "changelog-tools/git.hub.lookup"] {
        let e = run(&hub, false, json!({"action": "call", "server": "changelog-tools/git.hub", "tool": tool, "arguments": {"q": "x"}})).await.unwrap_err();
        assert!(e.contains("MCP server 'changelog-tools/git.hub' is not connected."), "{tool}: {e}");
    }
    let e = run(&hub, false, json!({"action": "call", "server": "changelog-tools", "tool": "lookup"})).await.unwrap_err();
    assert!(e.contains("'changelog-tools' is not configured. Servers: changelog-tools/git.hub."), "{e}");
}

/// A plugin's server belongs to the plugin: the model cannot save over
/// it or remove it, and no card opens.
#[tokio::test]
async fn the_agent_cannot_save_or_remove_a_plugins_server() {
    let hub = McpHubTool::new(manager_with("changelog-tools/github", vec![]));
    for args in [json!({"action": "remove", "server": "changelog-tools/github"}), json!({"action": "save", "server": "changelog-tools/github", "config": {"command": "x"}})] {
        let e = run(&hub, false, args).await.unwrap_err();
        assert!(e.contains("comes from plugin changelog-tools") && e.contains("Settings → Plugins"), "{e}");
    }
}

/// In its workspace, a project's server takes the place of the user's
/// server of the same name; everywhere else the user's stays.
#[test]
fn a_projects_server_replaces_a_same_named_one_in_its_workspace_only() {
    let m = manager_with("docs", vec![json!({"name": "global_search"})]);
    let cfg = config::parse_config(&json!({"servers": {"s": {"command": "x"}}})).unwrap();
    let key = project::runner_key("/repo", "docs");
    let runner = Runner::build(&key, &cfg.servers["s"], RunnerState::Ready, None, Some(project::ProjectRef { workspace: "/repo".into(), name: "docs".into() }));
    let weak = Arc::downgrade(&(runner.clone() as Arc<dyn SessionProvider>));
    *runner.tools.lock().unwrap() = vec![Arc::new(McpTool::new("docs", json!({"name": "project_search"}), weak).on_runner(&key))];
    m.runners.write().unwrap().insert(key.clone(), runner);

    let tools = |ws: Option<&str>| m.ready_tools_in(Some("docs"), ws).iter().map(|t| t.remote_name.clone()).collect::<Vec<_>>();
    assert_eq!(tools(Some("/repo")), ["project_search"]);
    assert_eq!(tools(Some("/elsewhere")), ["global_search"]);
    assert_eq!(tools(None), ["global_search"]);
    let names = |ws: Option<&str>| m.statuses_in(ws).into_iter().map(|s| s.name).collect::<Vec<_>>();
    assert_eq!(names(Some("/repo")), ["docs"], "one docs, the project's");
    assert_eq!(m.status_in("docs", Some("/repo")).unwrap().project.unwrap().workspace, "/repo");
    assert!(m.status_in("docs", None).unwrap().project.is_none());
    assert_eq!(m.list_status().len(), 1, "the global list leaves the project's out");
    assert_eq!(m.ready_tools_in(None, Some("/repo"))[0].runner, key, "an app calls back through the project's runner");
}
