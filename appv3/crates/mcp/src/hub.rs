//! The `mcp` tool: the lead agent's one entry point to every configured MCP
//! server. `search` returns matching tools with their input schemas; `call`
//! runs one. It reads the live manager on every call, so a server that
//! connects after the agent was built is usable at once, and the model's
//! tool list stays the same however many servers and tools there are.
//! `servers` lists the servers with their state; `save` and `remove`
//! propose a change the user confirms on a card (see [`crate::admin`]).

use crate::tool::McpTool;
use crate::{McpManager, ServerStatus};
use appv3_tools::args::Args;
use appv3_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub const MCP_TOOL: &str = "mcp";
const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 20;
/// Longest tool description a search result carries (characters).
const RESULT_DESCRIPTION_MAX: usize = 800;

const DESCRIPTION: &str = "Use tools from the user's MCP servers. action='search' finds tools by keywords (or, with an empty query and a server, lists that server's tools) and returns each tool's input_schema. action='call' runs one tool: server, tool (its name as search returned it) and arguments matching its input_schema. Search before calling a tool whose schema you have not seen. In Plan mode only tools marked read_only can be called. action='servers' shows each server's state, errors and config; action='save' (server, config) adds or replaces one and action='remove' deletes one, after the user applies it on a card.";
/// Freezes the description for a session (see [`crate::McpHubTool::definition_for`]).
const FROZEN_KEY: &str = "mcp_tool_description";

fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(String::from).collect()
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// Rank `tools` for `query`: an exact tool name scores 10, then each query
/// word found in the tool name 3, the server name 2, the description 1. An
/// empty query lists every tool. Ties keep `tools` order; no-match tools drop.
pub fn rank(query: &str, server: Option<&str>, tools: &[Arc<McpTool>], limit: usize) -> Vec<Arc<McpTool>> {
    let q = query.trim().to_lowercase();
    let words = tokens(&q);
    let mut scored: Vec<(usize, usize, &Arc<McpTool>)> = vec![];
    for (i, t) in tools.iter().enumerate() {
        if server.is_some_and(|s| s != t.server_name) {
            continue;
        }
        let score = if words.is_empty() {
            1
        } else {
            let (name, srv, desc) = (t.remote_name.to_lowercase(), t.server_name.to_lowercase(), t.description.to_lowercase());
            let mut s = if name == q { 10 } else { 0 };
            for w in &words {
                s += 3 * name.contains(w.as_str()) as usize + 2 * srv.contains(w.as_str()) as usize + desc.contains(w.as_str()) as usize;
            }
            s
        };
        if score > 0 {
            scored.push((score, i, t));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, _, t)| t.clone()).collect()
}

fn state_note(st: &ServerStatus) -> String {
    match st.state.as_str() {
        "stopped" if !st.enabled => "disabled".into(),
        "auth_required" => "needs sign-in: connect it in Settings → MCP".into(),
        "error" => "failed to start".into(),
        s => s.into(),
    }
}

/// The enabled servers, for the tool description. Names only: the
/// description opens the cached prompt prefix, so it must not change as a
/// server starts, connects, needs sign-in or fails. `search` and `call`
/// report a server's state when it matters.
pub fn describe_servers(statuses: &[ServerStatus]) -> String {
    if statuses.is_empty() {
        return "No MCP servers are configured.".into();
    }
    let mut names: Vec<&str> = statuses.iter().filter(|s| s.enabled).map(|s| s.name.as_str()).collect();
    if names.is_empty() {
        return "No MCP servers are enabled.".into();
    }
    names.sort_unstable();
    names.dedup();
    format!("Servers: {}. Search with a server and an empty query to list its tools.", names.join(", "))
}

/// The model-facing definition, with `servers` (see [`describe_servers`]).
pub fn definition(servers: &str) -> Value {
    json!({"type": "function", "function": {
        "name": MCP_TOOL,
        "description": format!("{DESCRIPTION}\n\n{servers}"),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["search", "call", "servers", "save", "remove"], "description": "'search' finds tools and returns their input schemas; 'call' runs one tool; 'servers', 'save' and 'remove' manage the servers."},
                "query": {"type": "string", "default": null, "description": "[search] Keywords matched against server, tool name and description. Leave empty, with server set, to list that server's tools."},
                "server": {"type": "string", "default": null, "description": "[search] Only search this server. [call, save, remove] The server's name (required)."},
                "tool": {"type": "string", "default": null, "description": "[call] The tool name exactly as search returned it (required)."},
                "arguments": {"type": "object", "default": null, "description": "[call] Arguments matching the tool's input_schema."},
                "config": {"type": "object", "default": null, "description": "[save] The mcp.json entry: {command, args, env} (stdio) or {url, headers, oauth} (http), plus enabled. Never put a secret here; keep ******** values as servers showed them."},
                "limit": {"type": "integer", "default": DEFAULT_LIMIT, "minimum": 1, "maximum": MAX_LIMIT, "description": "[search] Most tools to return (defaults to 8)."}
            },
            "required": ["action"]
        }
    }})
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn search_entry(t: &McpTool) -> Value {
    json!({
        "server": t.server_name,
        "tool": t.remote_name,
        "read_only": t.read_only(),
        "description": truncate(&t.description, RESULT_DESCRIPTION_MAX),
        "input_schema": t.input_schema(),
    })
}

/// `arguments` as an object; a JSON-encoded string is accepted too (Gemini
/// is given a string, since it rejects an object schema without properties).
fn parse_arguments(v: Option<&Value>) -> Result<Map<String, Value>, ToolError> {
    let bad = || ToolError::Argument("arguments must be a JSON object.".into());
    match v {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Map::new()),
        Some(Value::String(s)) => match serde_json::from_str(s) {
            Ok(Value::Object(m)) => Ok(m),
            _ => Err(bad()),
        },
        Some(_) => Err(bad()),
    }
}

pub struct McpHubTool {
    manager: Arc<McpManager>,
}

impl McpHubTool {
    pub fn new(manager: Arc<McpManager>) -> Self {
        Self { manager }
    }

    fn check_server(&self, server: &str) -> Result<(), ToolError> {
        let Some(st) = self.manager.get_status(server) else {
            let names = self.manager.server_names();
            return Err(ToolError::Execution(if names.is_empty() {
                "No MCP servers are configured.".into()
            } else {
                format!("MCP server '{server}' is not configured. Servers: {}.", names.join(", "))
            }));
        };
        if st.state != "ready" {
            let detail = st.error.as_deref().filter(|e| !e.is_empty()).map(|e| format!(": {e}")).unwrap_or_default();
            return Err(ToolError::Execution(format!("MCP server '{server}' is not ready ({}){detail}", state_note(&st))));
        }
        Ok(())
    }

    fn search(&self, query: &str, server: Option<&str>, limit: usize) -> ToolResult {
        if let Some(s) = server {
            self.check_server(s)?;
        }
        let hits = rank(query, server, &self.manager.ready_tools(server), limit);
        let statuses = self.manager.list_status();
        let mut out = if hits.is_empty() {
            let mut out = if query.trim().is_empty() { "No MCP tools are available.".to_string() } else { format!("No MCP tools match '{}'.", query.trim()) };
            let ready: Vec<String> =
                statuses.iter().filter(|s| s.state == "ready").map(|s| format!("{} ({} tool{})", s.name, s.tool_names.len(), plural(s.tool_names.len()))).collect();
            if !ready.is_empty() {
                out.push_str(&format!(" Ready servers: {}. Try other words, or an empty query with a server to list its tools.", ready.join(", ")));
            }
            out
        } else {
            let mut out = format!("{} tool{} (run one with action='call', server, tool and arguments):", hits.len(), plural(hits.len()));
            for t in &hits {
                out.push('\n');
                out.push_str(&search_entry(t).to_string());
            }
            out
        };
        let waiting: Vec<String> =
            statuses.iter().filter(|s| s.enabled && s.state != "ready" && server.is_none_or(|x| x == s.name)).map(|s| format!("{} ({})", s.name, state_note(s))).collect();
        if !waiting.is_empty() {
            out.push_str(&format!("\nNot ready: {}.", waiting.join(", ")));
        }
        Ok(ToolOutput::Text(out))
    }

    async fn call(&self, ctx: &ToolContext, server: &str, tool: &str, arguments: Option<&Value>) -> ToolResult {
        self.check_server(server)?;
        let tools = self.manager.ready_tools(Some(server));
        // Also take the `<server>_<tool>` name older transcripts used.
        let bare = tool.strip_prefix(&format!("{server}_")).or_else(|| tool.strip_prefix(&format!("{server}.")));
        let found = tools.iter().find(|t| t.remote_name == tool).or_else(|| bare.and_then(|b| tools.iter().find(|t| t.remote_name == b))).cloned();
        let Some(t) = found else {
            let close: Vec<String> = rank(tool, Some(server), &tools, 3).iter().map(|t| t.remote_name.clone()).collect();
            let hint = if close.is_empty() { " Search to see its tools.".to_string() } else { format!(" Closest: {}.", close.join(", ")) };
            return Err(ToolError::Execution(format!("MCP server '{server}' has no tool '{tool}'.{hint}")));
        };
        let plan = ctx.metadata.lock().unwrap().get("interaction_mode").and_then(Value::as_str) == Some("plan");
        if plan && !t.read_only() {
            return Err(ToolError::Execution(format!("MCP tool '{server}.{}' is not marked read-only, so it is unavailable in Plan mode.", t.remote_name)));
        }
        let args = parse_arguments(arguments)?;
        let schema = t.input_schema();
        let missing: Vec<&str> = schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|k| !args.contains_key(*k)).collect();
        if !missing.is_empty() {
            return Err(ToolError::Argument(format!("MCP tool '{server}.{}' is missing required arguments: {}. Its input_schema: {schema}", t.remote_name, missing.join(", "))));
        }
        t.run(ctx, Value::Object(args)).await
    }
}

#[async_trait]
impl Tool for McpHubTool {
    fn name(&self) -> &str {
        MCP_TOOL
    }

    fn definition(&self) -> Value {
        definition(&describe_servers(&self.manager.list_status()))
    }

    /// The description lists the servers, and it opens the cached prompt
    /// prefix: it is fixed for a session, so adding or removing a server
    /// (from chat or Settings) does not re-send the session's context. The
    /// `save` result and `servers` report the current ones.
    fn definition_for(&self, ctx: &ToolContext) -> Value {
        let servers = appv3_agent::session_frozen::get_or_freeze(ctx.session_id.as_deref(), FROZEN_KEY, || describe_servers(&self.manager.list_status()));
        definition(&servers)
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new(MCP_TOOL, &args);
        let action = a.req_str(&["action"]);
        let query = a.opt_str(&["query"]).unwrap_or_default();
        let server = a.opt_str(&["server"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let tool = a.opt_str(&["tool"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let limit = a.opt_int(&["limit"], Some(1), Some(MAX_LIMIT as i64));
        a.finish()?;
        match action.as_str() {
            "search" => self.search(&query, server.as_deref(), limit.map(|l| l as usize).unwrap_or(DEFAULT_LIMIT)),
            "call" => {
                let (Some(server), Some(tool)) = (server, tool) else {
                    return Err(ToolError::Argument("action='call' needs server and tool; search first to find them.".into()));
                };
                self.call(ctx, &server, &tool, args.get("arguments")).await
            }
            "servers" => Ok(ToolOutput::Text(crate::admin::servers_text(&self.manager))),
            "save" | "remove" => {
                let Some(server) = server else { return Err(ToolError::Argument(format!("action='{action}' needs server (the server's name)."))) };
                let proposal = if action == "save" {
                    match args.get("config") {
                        Some(c) if !c.is_null() => crate::admin::propose_save(&server, &parse_config_arg(c)?),
                        _ => return Err(ToolError::Argument("action='save' needs config, the server's mcp.json entry.".into())),
                    }
                } else {
                    crate::admin::propose_remove(&server)
                };
                match proposal {
                    Ok(p) => appv3_agent::confirm::ask(ctx, None, MCP_TOOL, p).await,
                    Err(e) => Err(ToolError::Execution(e)),
                }
            }
            other => Err(ToolError::Argument(format!("Unknown action '{other}': use 'search', 'call', 'servers', 'save' or 'remove'."))),
        }
    }
}

/// `config` as an object; a JSON-encoded string is accepted too.
fn parse_config_arg(v: &Value) -> Result<Value, ToolError> {
    match v {
        Value::String(s) => serde_json::from_str::<Value>(s).ok().filter(Value::is_object).ok_or_else(|| ToolError::Argument("config must be a JSON object.".into())),
        other => Ok(other.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::SessionProvider;
    use crate::{config, Runner};

    struct NoSession;
    impl SessionProvider for NoSession {
        fn client(&self) -> Option<Arc<crate::client::McpClient>> {
            None
        }
    }

    fn tool(server: &str, name: &str, desc: &str) -> Arc<McpTool> {
        let s: Arc<dyn SessionProvider> = Arc::new(NoSession);
        Arc::new(McpTool::new(server, json!({"name": name, "description": desc}), Arc::downgrade(&s)))
    }

    fn names(tools: &[Arc<McpTool>]) -> Vec<String> {
        tools.iter().map(|t| format!("{}.{}", t.server_name, t.remote_name)).collect()
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
        }
    }

    /// The description sits in the cached tools block: a server starting,
    /// connecting, needing sign-in or failing must not change it, or every
    /// session's next call re-sends its whole context.
    #[test]
    fn the_description_names_enabled_servers_whatever_their_state() {
        let s = describe_servers(&[status("slack", "auth_required", &[]), status("docs", "ready", &["search", "fetch"]), status("old", "disabled", &[])]);
        assert_eq!(s, "Servers: docs, slack. Search with a server and an empty query to list its tools.");
        for (docs, slack) in [("starting", "starting"), ("ready", "ready"), ("error", "auth_required")] {
            assert_eq!(describe_servers(&[status("docs", docs, &["search"]), status("slack", slack, &["post"])]), s, "{docs}/{slack}");
        }
        assert_ne!(describe_servers(&[status("docs", "ready", &[]), status("slack", "disabled", &[])]), s, "disabling a server is a config change");
        assert_eq!(describe_servers(&[status("old", "disabled", &[])]), "No MCP servers are enabled.");
        assert_eq!(describe_servers(&[]), "No MCP servers are configured.");
    }

    #[test]
    fn read_only_reads_the_annotation() {
        let s: Arc<dyn SessionProvider> = Arc::new(NoSession);
        let t = |def: Value| McpTool::new("s", def, Arc::downgrade(&s)).read_only();
        assert!(t(json!({"name": "a", "annotations": {"readOnlyHint": true}})));
        assert!(!t(json!({"name": "a", "annotations": {"readOnlyHint": false}})));
        assert!(!t(json!({"name": "a"})));
    }

    /// A manager with one ready server whose tools have no live client.
    fn manager_with(server: &str, defs: Vec<Value>) -> Arc<McpManager> {
        let m = Arc::new(McpManager::default());
        let cfg = config::parse_config(&json!({"servers": {server: {"command": "x"}}})).unwrap();
        let runner = Runner::new(server, &cfg.servers[server], "ready");
        let weak = Arc::downgrade(&(runner.clone() as Arc<dyn SessionProvider>));
        let tools: Vec<Arc<McpTool>> = defs.into_iter().map(|d| Arc::new(McpTool::new(server, d, weak.clone()))).collect();
        runner.status.lock().unwrap().tool_names = tools.iter().map(|t| t.name.clone()).collect();
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
        assert!(e.contains("missing required arguments: q. Its input_schema: {"), "{e}");
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
}
