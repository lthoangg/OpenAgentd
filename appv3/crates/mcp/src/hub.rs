//! The `mcp` tool: the lead agent's one entry point to every configured MCP
//! server. `search` returns matching tools with their input schemas; `call`
//! runs one. It reads the live manager on every call, so a server that
//! connects after the agent was built is usable at once, and the model's
//! tool list stays the same however many servers and tools there are.
//! `servers` lists the servers with their state; `save` and `remove`
//! propose a change the user confirms on a card (see [`crate::admin`]).
//!
//! The tools plugins' code adds are reached the same way, listed under the
//! plugin's name as if the plugin were a server: plugins never grow the
//! tools block, and a plugin installed or edited mid-session is usable at
//! once. A server of the user's with a plugin's name hides that plugin's
//! tools.

use crate::tool::McpTool;
use crate::{McpManager, ServerStatus};
use appv3_agent::plugins::{extra_tools, ExtraTool};
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

/// A tool `search` finds and `call` runs: an MCP server's, or one a
/// plugin's code adds (its server is the plugin's name).
#[derive(Clone)]
enum Found {
    Mcp(Arc<McpTool>),
    Plugin(Arc<ExtraTool>),
}

impl Found {
    fn server(&self) -> &str {
        match self {
            Found::Mcp(t) => &t.server_name,
            Found::Plugin(t) => &t.plugin,
        }
    }

    fn tool(&self) -> &str {
        match self {
            Found::Mcp(t) => &t.remote_name,
            Found::Plugin(t) => &t.name,
        }
    }

    fn description(&self) -> &str {
        match self {
            Found::Mcp(t) => &t.description,
            Found::Plugin(t) => &t.description,
        }
    }

    fn read_only(&self) -> bool {
        match self {
            Found::Mcp(t) => t.read_only(),
            Found::Plugin(t) => t.read_only,
        }
    }

    fn input_schema(&self) -> Value {
        match self {
            Found::Mcp(t) => t.input_schema(),
            Found::Plugin(t) => t.input_schema.clone(),
        }
    }

    /// How errors name it.
    fn kind(&self) -> &'static str {
        match self {
            Found::Mcp(_) => "MCP tool",
            Found::Plugin(_) => "Plugin tool",
        }
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        match self {
            Found::Mcp(t) => t.run(ctx, args).await,
            Found::Plugin(t) => t.runner.run(ctx, args).await,
        }
    }
}

/// Rank `tools` for `query`: an exact tool name scores 10, then each query
/// word found in the tool name 3, the server name 2, the description 1. An
/// empty query lists every tool. Ties keep `tools` order; no-match tools drop.
fn rank(query: &str, server: Option<&str>, tools: &[Found], limit: usize) -> Vec<Found> {
    let q = query.trim().to_lowercase();
    let words = tokens(&q);
    let mut scored: Vec<(usize, usize, &Found)> = vec![];
    for (i, t) in tools.iter().enumerate() {
        if server.is_some_and(|s| s != t.server()) {
            continue;
        }
        let score = if words.is_empty() {
            1
        } else {
            let (name, srv, desc) = (t.tool().to_lowercase(), t.server().to_lowercase(), t.description().to_lowercase());
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
        "auth_required" => appv3_core::MCP_SIGN_IN_NOTE.into(),
        "error" => "failed to start".into(),
        s => s.into(),
    }
}

/// The enabled servers and the plugins with tools, for the tool
/// description. Names only: the description opens the cached prompt prefix,
/// so it must not change as a server starts, connects, needs sign-in or
/// fails. `search` and `call` report a server's state when it matters.
pub fn describe_servers(statuses: &[ServerStatus], plugins: &[String]) -> String {
    if statuses.is_empty() && plugins.is_empty() {
        return "No MCP servers are configured.".into();
    }
    let mut names: Vec<&str> = statuses.iter().filter(|s| s.enabled).map(|s| s.name.as_str()).chain(plugins.iter().map(String::as_str)).collect();
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

fn search_entry(t: &Found) -> Value {
    json!({
        "server": t.server(),
        "tool": t.tool(),
        "read_only": t.read_only(),
        "description": truncate(t.description(), RESULT_DESCRIPTION_MAX),
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

/// The plugins `tools` come from, in order.
fn plugin_names(tools: &[Arc<ExtraTool>]) -> Vec<String> {
    let mut names: Vec<String> = vec![];
    for t in tools {
        if !names.contains(&t.plugin) {
            names.push(t.plugin.clone());
        }
    }
    names
}

/// What `servers` adds for the plugins' tools.
fn plugin_tools_text(tools: &[Arc<ExtraTool>]) -> String {
    let mut out = "Tools from plugins (call them with the plugin's name as server; the user manages them in Settings → Plugins):".to_string();
    for p in plugin_names(tools) {
        let names: Vec<&str> = tools.iter().filter(|t| t.plugin == p).map(|t| t.name.as_str()).collect();
        out.push_str(&format!("\n- {p} — {} tool{}: {}", names.len(), plural(names.len()), names.join(", ")));
    }
    out
}

pub struct McpHubTool {
    manager: Arc<McpManager>,
    /// The tools plugins' code adds: the running plugins' (tests pass their own).
    plugin_tools: fn() -> Vec<Arc<ExtraTool>>,
}

impl McpHubTool {
    pub fn new(manager: Arc<McpManager>) -> Self {
        Self { manager, plugin_tools: extra_tools }
    }

    /// The plugins' tools the agent can reach: a server of the user's with
    /// a plugin's name hides that plugin's tools (Settings → Plugins says so).
    fn plugin_tools(&self) -> Vec<Arc<ExtraTool>> {
        (self.plugin_tools)().into_iter().filter(|t| self.manager.get_status(&t.plugin).is_none()).collect()
    }

    fn describe(&self) -> String {
        describe_servers(&self.manager.list_status(), &plugin_names(&self.plugin_tools()))
    }

    fn check_server(&self, server: &str, plugins: &[String]) -> Result<(), ToolError> {
        let Some(st) = self.manager.get_status(server) else {
            let mut names = self.manager.server_names();
            names.extend(plugins.iter().cloned());
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

    /// The tools `search` and `call` look at: the ready servers' (just
    /// `server`'s when given), then the plugins'.
    fn candidates(&self, server: Option<&str>, plugin_tools: &[Arc<ExtraTool>]) -> Vec<Found> {
        let mcp = self.manager.ready_tools(server).into_iter().map(Found::Mcp);
        mcp.chain(plugin_tools.iter().filter(|t| server.is_none_or(|s| s == t.plugin)).cloned().map(Found::Plugin)).collect()
    }

    fn search(&self, query: &str, server: Option<&str>, limit: usize) -> ToolResult {
        let plugin_tools = self.plugin_tools();
        let plugins = plugin_names(&plugin_tools);
        if let Some(s) = server.filter(|s| !plugins.iter().any(|p| p == s)) {
            self.check_server(s, &plugins)?;
        }
        let hits = rank(query, server, &self.candidates(server, &plugin_tools), limit);
        let statuses = self.manager.list_status();
        let mut out = if hits.is_empty() {
            let mut out = if query.trim().is_empty() { "No MCP tools are available.".to_string() } else { format!("No MCP tools match '{}'.", query.trim()) };
            let mut ready: Vec<String> =
                statuses.iter().filter(|s| s.state == "ready").map(|s| format!("{} ({} tool{})", s.name, s.tool_names.len(), plural(s.tool_names.len()))).collect();
            for p in &plugins {
                let n = plugin_tools.iter().filter(|t| t.plugin == *p).count();
                ready.push(format!("{p} ({n} tool{})", plural(n)));
            }
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
        let plugin_tools = self.plugin_tools();
        let plugins = plugin_names(&plugin_tools);
        let from_plugin = plugins.iter().any(|p| p == server);
        if !from_plugin {
            self.check_server(server, &plugins)?;
        }
        let tools = self.candidates(Some(server), &plugin_tools);
        // Also take the `<server>_<tool>` name older transcripts used, and
        // `<plugin>/<tool>`, how Settings names a plugin's tool.
        let bare = ["_", ".", "/"].iter().find_map(|sep| tool.strip_prefix(&format!("{server}{sep}")));
        let found = tools.iter().find(|t| t.tool() == tool).or_else(|| bare.and_then(|b| tools.iter().find(|t| t.tool() == b))).cloned();
        let Some(t) = found else {
            let close: Vec<String> = rank(tool, Some(server), &tools, 3).iter().map(|t| t.tool().to_string()).collect();
            let hint = if close.is_empty() { " Search to see its tools.".to_string() } else { format!(" Closest: {}.", close.join(", ")) };
            let owner = if from_plugin { format!("Plugin '{server}'") } else { format!("MCP server '{server}'") };
            return Err(ToolError::Execution(format!("{owner} has no tool '{tool}'.{hint}")));
        };
        let plan = ctx.metadata.lock().unwrap().get("interaction_mode").and_then(Value::as_str) == Some("plan");
        if plan && !t.read_only() {
            return Err(ToolError::Execution(format!("{} '{server}.{}' is not marked read-only, so it is unavailable in Plan mode.", t.kind(), t.tool())));
        }
        let args = Value::Object(parse_arguments(arguments)?);
        let schema = t.input_schema();
        // Every problem at once, before the server or plugin sees the call.
        let problems = appv3_tools::arg_check::problems(&schema, &args);
        if !problems.is_empty() {
            return Err(ToolError::Argument(format!("{} '{server}.{}' got invalid arguments: {}. Its input_schema: {schema}", t.kind(), t.tool(), problems.join("; "))));
        }
        t.run(ctx, args).await
    }

    fn servers(&self) -> String {
        let text = crate::admin::servers_text(&self.manager);
        let plugin_tools = self.plugin_tools();
        if plugin_tools.is_empty() {
            text
        } else {
            format!("{text}\n{}", plugin_tools_text(&plugin_tools))
        }
    }
}

#[async_trait]
impl Tool for McpHubTool {
    fn name(&self) -> &str {
        MCP_TOOL
    }

    fn definition(&self) -> Value {
        definition(&self.describe())
    }

    /// The description lists the servers, and it opens the cached prompt
    /// prefix: it is fixed for a session, so adding or removing a server
    /// (from chat or Settings) does not re-send the session's context. The
    /// `save` result and `servers` report the current ones.
    fn definition_for(&self, ctx: &ToolContext) -> Value {
        let servers = appv3_agent::session_frozen::get_or_freeze(ctx.session_id.as_deref(), FROZEN_KEY, || self.describe());
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
            "servers" => Ok(ToolOutput::Text(self.servers())),
            "save" | "remove" => {
                let Some(server) = server else { return Err(ToolError::Argument(format!("action='{action}' needs server (the server's name)."))) };
                if let Some(plugin) = self.manager.plugin_of(&server) {
                    return Err(ToolError::Execution(format!(
                        "MCP server '{server}' comes from plugin {plugin}, so it cannot be saved or removed from chat: the user manages it in Settings → Plugins."
                    )));
                }
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
        runner.details.lock().unwrap().tool_names = tools.iter().map(|t| t.name.clone()).collect();
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
}
