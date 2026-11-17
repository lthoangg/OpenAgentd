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
//!
//! In a workspace whose `.agents/mcp.json` ships servers, those are reached
//! by their plain names too, and take the place of a user's or plugin's
//! server of the same name there. One the user has not approved does not
//! run: searching or calling it asks them on a card (see [`crate::project`]),
//! and in a turn nobody attends it is refused.

use crate::tool::McpTool;
use crate::{project, McpManager, RunnerState, ServerStatus};
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

const DESCRIPTION: &str = "Use tools from the user's MCP servers. action='search' finds tools by keywords (or, with an empty query and a server, lists that server's tools) and returns each tool's input_schema. action='call' runs one tool: server, tool (its name as search returned it) and arguments matching its input_schema. Search before calling a tool whose schema you have not seen. In Plan mode only tools marked read_only can be called. action='servers' shows each server's state, errors and config, and ready-made connectors the user can turn on; action='save' (server, config) adds or replaces one and action='remove' deletes one, after the user applies it on a card.";
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
        "needs_approval" => "from this project, not approved yet: search or call it to ask the user".into(),
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

/// The fields of this tool itself; anything else in a call is not its own.
const OWN_FIELDS: [&str; 7] = ["action", "query", "server", "tool", "arguments", "config", "limit"];

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

    /// The servers the agent in `workspace` can reach, for the description:
    /// the ones running, plus the project's entries (they may not have been
    /// synced yet when a session's description is frozen).
    fn describe(&self, workspace: Option<&str>) -> String {
        let mut statuses = self.manager.statuses_in(workspace);
        for name in workspace.map(project::enabled_names).unwrap_or_default() {
            if !statuses.iter().any(|s| s.name == name && s.enabled) {
                statuses.push(ServerStatus {
                    name,
                    transport: String::new(),
                    enabled: true,
                    state: "needs_approval".into(),
                    error: None,
                    tool_names: vec![],
                    started_at: None,
                    plugin: None,
                    project: None,
                });
            }
        }
        describe_servers(&statuses, &plugin_names(&self.plugin_tools()))
    }

    fn check_server(&self, server: &str, plugins: &[String], workspace: Option<&str>) -> Result<(), ToolError> {
        let Some(st) = self.manager.status_in(server, workspace) else {
            let mut names: Vec<String> = self.manager.statuses_in(workspace).into_iter().map(|s| s.name).collect();
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
    fn candidates(&self, server: Option<&str>, plugin_tools: &[Arc<ExtraTool>], workspace: Option<&str>) -> Vec<Found> {
        let mcp = self.manager.ready_tools_in(server, workspace).into_iter().map(Found::Mcp);
        mcp.chain(plugin_tools.iter().filter(|t| server.is_none_or(|s| s == t.plugin)).cloned().map(Found::Plugin)).collect()
    }

    /// When `server` is a project's server the user has not approved: the
    /// card asking them (it pauses the turn), or, with nobody there, a
    /// refusal. `None` lets the action go on.
    async fn approval_gate(&self, ctx: &ToolContext, server: &str) -> Option<ToolResult> {
        let runner = self.manager.runner_in(server, ctx.workspace.as_deref())?;
        // A project's server starts when its workspace is synced, which may
        // be this very call: wait for it, as the agent cannot see it starting.
        if runner.project.is_some() && runner.state() == RunnerState::Starting {
            runner.wait_settled(crate::APP_CALL_WAITS_FOR_SERVER).await;
        }
        if runner.state() != RunnerState::NeedsApproval {
            return None;
        }
        let p = runner.project.clone()?;
        let unattended = ctx.metadata.lock().unwrap().get(appv3_agent::agent::UNATTENDED_META).and_then(Value::as_bool).unwrap_or(false);
        if unattended {
            return Some(Err(ToolError::Execution(format!(
                "MCP server '{server}' comes from this project's .agents/mcp.json and the user has not approved it, so it does not run. Nobody is there to approve it in this turn: carry on without it and say so in your final reply."
            ))));
        }
        tracing::info!("mcp_project_server_approval_asked workspace={} server={}", p.workspace, p.name);
        Some(appv3_agent::confirm::ask(ctx, None, MCP_TOOL, project::propose_approval(&p.workspace, &p.name, &runner.config)).await)
    }

    async fn search(&self, ctx: &ToolContext, query: &str, server: Option<&str>, limit: usize) -> ToolResult {
        let workspace = ctx.workspace.as_deref();
        let plugin_tools = self.plugin_tools();
        let plugins = plugin_names(&plugin_tools);
        if let Some(s) = server.filter(|s| !plugins.iter().any(|p| p == s)) {
            if let Some(gated) = self.approval_gate(ctx, s).await {
                return gated;
            }
            self.check_server(s, &plugins, workspace)?;
        }
        let hits = rank(query, server, &self.candidates(server, &plugin_tools, workspace), limit);
        let statuses = self.manager.statuses_in(workspace);
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

    async fn call(&self, ctx: &ToolContext, server: &str, tool: &str, call: &Value) -> ToolResult {
        let workspace = ctx.workspace.as_deref();
        let plugin_tools = self.plugin_tools();
        let plugins = plugin_names(&plugin_tools);
        let from_plugin = plugins.iter().any(|p| p == server);
        if !from_plugin {
            if let Some(gated) = self.approval_gate(ctx, server).await {
                return gated;
            }
            self.check_server(server, &plugins, workspace)?;
        }
        let tools = self.candidates(Some(server), &plugin_tools, workspace);
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
        let schema = t.input_schema();
        let mut arguments = parse_arguments(call.get("arguments"))?;
        // A model sometimes writes one of the tool's arguments beside
        // `arguments`. Dropped silently, the tool ran without it; it is
        // taken when the tool declares it, and named otherwise.
        let declared = schema.get("properties").and_then(Value::as_object);
        let mut stray: Vec<&str> = vec![];
        for (key, value) in call.as_object().into_iter().flatten().filter(|(k, _)| !OWN_FIELDS.contains(&k.as_str())) {
            if declared.is_some_and(|p| p.contains_key(key)) && !arguments.contains_key(key) {
                arguments.insert(key.clone(), value.clone());
            } else {
                stray.push(key);
            }
        }
        if !stray.is_empty() {
            let names = stray.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ");
            let verb = if stray.len() == 1 { "is not a field" } else { "are not fields" };
            return Err(ToolError::Argument(format!(
                "{names} {verb} of the mcp tool. Put the arguments of '{server}.{}' inside `arguments`. Its input_schema: {schema}",
                t.tool()
            )));
        }
        let args = Value::Object(arguments);
        // Every problem at once, before the server or plugin sees the call.
        let problems = appv3_tools::arg_check::problems(&schema, &args);
        if !problems.is_empty() {
            return Err(ToolError::Argument(format!("{} '{server}.{}' got invalid arguments: {}. Its input_schema: {schema}", t.kind(), t.tool(), problems.join("; "))));
        }
        t.run(ctx, args).await
    }

    fn servers(&self, workspace: Option<&str>) -> String {
        let text = crate::admin::servers_text(&self.manager);
        let text = match workspace.map(|ws| crate::admin::project_servers_text(&self.manager, ws)).filter(|t| !t.is_empty()) {
            Some(p) => format!("{text}\n{p}"),
            None => text,
        };
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
        definition(&self.describe(None))
    }

    /// The description lists the servers, and it opens the cached prompt
    /// prefix: it is fixed for a session, so adding or removing a server
    /// (from chat or Settings) does not re-send the session's context. The
    /// `save` result and `servers` report the current ones.
    fn definition_for(&self, ctx: &ToolContext) -> Value {
        let workspace = ctx.workspace.as_deref().filter(|w| !w.is_empty());
        let servers = appv3_agent::session_frozen::get_or_freeze(ctx.session_id.as_deref(), FROZEN_KEY, || {
            // A session starting in a workspace brings its approved project servers up.
            if let (Some(ws), Ok(rt)) = (workspace, tokio::runtime::Handle::try_current()) {
                let (m, ws) = (self.manager.clone(), ws.to_string());
                rt.spawn(async move { m.sync_project(&ws).await });
            }
            self.describe(workspace)
        });
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
        // Picks up edits to the workspace's .agents/mcp.json and approvals.
        if let Some(ws) = ctx.workspace.as_deref().filter(|w| !w.is_empty()) {
            self.manager.sync_project(ws).await;
        }
        match action.as_str() {
            "search" => self.search(ctx, &query, server.as_deref(), limit.map(|l| l as usize).unwrap_or(DEFAULT_LIMIT)).await,
            "call" => {
                let (Some(server), Some(tool)) = (server, tool) else {
                    return Err(ToolError::Argument("action='call' needs server and tool; search first to find them.".into()));
                };
                self.call(ctx, &server, &tool, &args).await
            }
            "servers" => Ok(ToolOutput::Text(self.servers(ctx.workspace.as_deref()))),
            "save" | "remove" => {
                let Some(server) = server else { return Err(ToolError::Argument(format!("action='{action}' needs server (the server's name)."))) };
                if self.manager.runner_in(&server, ctx.workspace.as_deref()).is_some_and(|r| r.project.is_some()) {
                    return Err(ToolError::Execution(format!(
                        "MCP server '{server}' comes from this project's .agents/mcp.json, so save and remove do not apply to it: edit that file instead (the user approves a changed entry again)."
                    )));
                }
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
mod tests;
