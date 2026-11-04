//! Functional tool plugins over JS/TS plugin files (`appv3-jsplugin`).
//!
//! A `*.ts` / `*.js` file in `settings.plugins_dirs` whose `plugin()` factory
//! returns hooks is a tool plugin. Plugins wrap only the tool executor:
//! `tool.before` may mutate the call's JSON args (re-serialised before
//! dispatch), `tool.after` may rewrite the result string. Order matches v2:
//! files sorted by name, the first file is the outermost wrapper.
//!
//! A plugin bundle's code (plugin API v2) adds the same hooks from its
//! default export's `hooks`, after the single-file plugins' ([`ToolHooks`]),
//! and tools the `mcp` tool finds and calls ([`bundle_tools`]).

use appv3_jsplugin::{JsPlugin, Mode, Target, ToolCtx};
use appv3_providers::{ContentBlock, ToolCall};
use appv3_tools::{ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub struct PluginCtx<'a> {
    pub tool: &'a str,
    pub session_id: Option<&'a str>,
    pub run_id: &'a str,
    pub agent_name: &'a str,
    pub call_id: &'a str,
}

#[async_trait]
pub trait ToolPlugin: Send + Sync {
    fn id(&self) -> &str;
    /// Plugin file this hook set came from (plugin status API).
    fn source(&self) -> Option<&std::path::Path> {
        None
    }
    fn has_before(&self) -> bool {
        false
    }
    fn has_after(&self) -> bool {
        false
    }
    /// `applies_to(agent_name, role)`.
    fn applies_to(&self, _agent_name: &str) -> bool {
        true
    }
    /// `tool.before(input, {"args": args})`; `Err` aborts the call.
    async fn before(&self, _ctx: &PluginCtx<'_>, _args: &mut Value) -> Result<(), String> {
        Ok(())
    }
    /// `tool.after(input, {"output": result})`.
    async fn after(&self, _ctx: &PluginCtx<'_>, _args: &Value, _output: &mut String) -> Result<(), String> {
        Ok(())
    }
}

pub type ToolPluginRef = Arc<dyn ToolPlugin>;

/// v2 never sets a role for plugin filtering, so `applies_to` always sees
/// `current_role()`'s default.
const DEFAULT_ROLE: &str = "agent";

/// A JS/TS file's tool hooks: the object returned by its `plugin()` factory
/// (v2's functional contract: `{"tool.before", "tool.after", "applies_to"}`),
/// or a plugin bundle's `hooks`.
pub struct JsToolPlugin {
    js: Arc<JsPlugin>,
    id: String,
    /// The hooks object: kept from the factory call, or the bundle's export.
    hooks: Target,
    before: bool,
    after: bool,
    applies_to: bool,
    applies_cache: Mutex<HashMap<String, bool>>,
}

const EVENT_BEFORE: &str = "tool.before";
const EVENT_AFTER: &str = "tool.after";
/// Longest a `tool.before` / `tool.after` hook may take. The plugin watchdog
/// stops busy JavaScript; this bounds a hook awaiting something that never
/// settles (an unbounded `fetch`), which would otherwise stall the tool call.
const HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// A hook call that fails like a thrown error once [`HOOK_TIMEOUT`] passes.
async fn hook_call(
    event: &str,
    call: impl std::future::Future<Output = Result<appv3_jsplugin::CallResult, appv3_jsplugin::JsError>>,
) -> Result<appv3_jsplugin::CallResult, String> {
    match tokio::time::timeout(HOOK_TIMEOUT, call).await {
        Ok(r) => r.map_err(|e| e.message),
        Err(_) => Err(format!("plugin hook '{event}' timed out after {} s", HOOK_TIMEOUT.as_secs())),
    }
}

impl JsToolPlugin {
    fn load(js: &Arc<JsPlugin>) -> Result<Option<Self>, String> {
        let d = &js.describe;
        // Provider plugins share the directory but are loaded by the provider registry.
        if d.get("provider").is_some() || d.get("providerInvalid").is_some() {
            return Ok(None);
        }
        let Some(factory) = d.get("pluginFactory").and_then(|f| f.as_str()) else {
            return Err(format!("{} exposes no recognised plugin contract (expected `export async function plugin()`)", js.file_name));
        };
        let r = js.call_blocking(&Target::export(""), factory, &[], Mode::Keep).map_err(|e| e.message)?;
        let handle = r.handle.ok_or_else(|| format!("plugin() in {} must return an object", js.file_name))?;
        let mut unknown: Vec<String> =
            r.value.as_object().map(|o| o.keys().filter(|k| ![EVENT_BEFORE, EVENT_AFTER, "applies_to"].contains(&k.as_str())).cloned().collect()).unwrap_or_default();
        unknown.extend(r.methods.iter().filter(|k| ![EVENT_BEFORE, EVENT_AFTER, "applies_to"].contains(&k.as_str())).cloned());
        unknown.sort();
        unknown.dedup();
        if !unknown.is_empty() {
            tracing::warn!("plugin_unknown_events plugin={} events={:?}", js.stem, unknown);
        }
        if r.value.get("applies_to").is_some_and(|v| !v.is_null()) {
            js.release(handle);
            return Err(format!("applies_to in {} must be callable", js.file_name));
        }
        let has = |m: &str| r.methods.iter().any(|x| x == m);
        Ok(Some(Self {
            js: js.clone(),
            id: js.stem.clone(),
            hooks: Target::Handle(handle),
            before: has(EVENT_BEFORE),
            after: has(EVENT_AFTER),
            applies_to: has("applies_to"),
            applies_cache: Mutex::default(),
        }))
    }

    /// A plugin bundle's hooks (its default export's `hooks` object), or
    /// `None` when it has no `tool.before` or `tool.after`.
    pub fn from_bundle(js: &Arc<JsPlugin>, plugin: &str) -> Result<Option<Self>, String> {
        let default = js.describe.get("default");
        if let Some(t) = default.and_then(|d| d.get("hooksInvalid")).and_then(Value::as_str) {
            return Err(format!("hooks must be an object, got {t}"));
        }
        let Some(names) = default.and_then(|d| d.get("hooks")).and_then(Value::as_array) else { return Ok(None) };
        let has = |m: &str| names.iter().any(|n| n == m);
        if !has(EVENT_BEFORE) && !has(EVENT_AFTER) {
            return Ok(None);
        }
        Ok(Some(Self {
            js: js.clone(),
            id: plugin.to_string(),
            hooks: Target::export("default.hooks"),
            before: has(EVENT_BEFORE),
            after: has(EVENT_AFTER),
            applies_to: has("applies_to"),
            applies_cache: Mutex::default(),
        }))
    }

    fn input(ctx: &PluginCtx<'_>) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("tool".into(), json!(ctx.tool));
        m.insert("session_id".into(), json!(ctx.session_id));
        m.insert("run_id".into(), json!(ctx.run_id));
        m.insert("agent_name".into(), json!(ctx.agent_name));
        m.insert("call_id".into(), json!(ctx.call_id));
        m
    }
}

#[async_trait]
impl ToolPlugin for JsToolPlugin {
    fn id(&self) -> &str {
        &self.id
    }
    fn source(&self) -> Option<&std::path::Path> {
        Some(&self.js.path)
    }
    fn has_before(&self) -> bool {
        self.before
    }
    fn has_after(&self) -> bool {
        self.after
    }
    fn applies_to(&self, agent_name: &str) -> bool {
        if !self.applies_to {
            return true;
        }
        if let Some(v) = self.applies_cache.lock().unwrap().get(agent_name) {
            return *v;
        }
        let ok = match self.js.call_blocking(&self.hooks, "applies_to", &[json!(agent_name), json!(DEFAULT_ROLE)], Mode::Value) {
            Ok(r) => appv3_providers::plugin::truthy(&r.value),
            Err(e) => {
                tracing::warn!("plugin_applies_to_failed plugin={} error={}", self.id, e);
                false
            }
        };
        self.applies_cache.lock().unwrap().insert(agent_name.to_string(), ok);
        ok
    }
    async fn before(&self, ctx: &PluginCtx<'_>, args: &mut Value) -> Result<(), String> {
        let output = json!({"args": args.clone()});
        let r = hook_call(EVENT_BEFORE, self.js.call(&self.hooks, EVENT_BEFORE, &[Value::Object(Self::input(ctx)), output], Mode::Args)).await?;
        if let Some(new) = r.args.as_ref().and_then(|a| a.get(1)).and_then(|o| o.get("args")) {
            *args = new.clone();
        }
        Ok(())
    }
    async fn after(&self, ctx: &PluginCtx<'_>, args: &Value, output: &mut String) -> Result<(), String> {
        let mut input = Self::input(ctx);
        input.insert("args".into(), args.clone());
        let r = hook_call(EVENT_AFTER, self.js.call(&self.hooks, EVENT_AFTER, &[Value::Object(input), json!({"output": output.clone()})], Mode::Args)).await?;
        match r.args.as_ref().and_then(|a| a.get(1)).and_then(|o| o.get("output")) {
            Some(Value::String(s)) => *output = s.clone(),
            Some(other) => *output = crate::pystr::py_str(other),
            None => return Err("'output'".into()),
        }
        Ok(())
    }
}

fn load() -> Vec<ToolPluginRef> {
    let mut out: Vec<ToolPluginRef> = vec![];
    for js in appv3_jsplugin::plugins() {
        match JsToolPlugin::load(js) {
            Ok(Some(p)) => {
                tracing::info!("plugin_loaded file={}", js.file_name);
                out.push(Arc::new(p));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("plugin_load_failed file={} error={}", js.path.display(), e);
                appv3_jsplugin::report_problem(&js.path, e);
            }
        }
    }
    out
}

/// Process-wide plugin list (v2 caches per agent; `applies_to` is cached per agent name).
pub fn tool_plugins() -> &'static Vec<ToolPluginRef> {
    static P: OnceLock<Vec<ToolPluginRef>> = OnceLock::new();
    P.get_or_init(load)
}

/// Tool hooks a running plugin bundle adds: a kernel contribution of its module.
pub struct ToolHooks(pub ToolPluginRef);

/// The hooks of the running plugin bundles, in the order they were added.
pub fn bundle_tool_hooks() -> Vec<ToolPluginRef> {
    appv3_kernel::global().contributions::<ToolHooks>().iter().map(|h| h.0.clone()).collect()
}

/// What runs an [`ExtraTool`].
#[async_trait]
pub trait ExtraRun: Send + Sync {
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult;
}

/// A tool a plugin's code adds outside the model's tools block: a kernel
/// contribution of the plugin's module. The `mcp` tool lists and calls it
/// under the plugin's name, as if the plugin were a server.
#[derive(Clone)]
pub struct ExtraTool {
    /// The plugin that adds it.
    pub plugin: String,
    /// Its name within the plugin.
    pub name: String,
    pub description: String,
    /// The JSON Schema of its arguments (`"type": "object"`).
    pub input_schema: Value,
    /// It only reads, so Plan mode may run it.
    pub read_only: bool,
    pub runner: Arc<dyn ExtraRun>,
}

/// The extra tools of the running modules, by plugin, then name.
pub fn extra_tools() -> Vec<Arc<ExtraTool>> {
    let mut tools = appv3_kernel::global().contributions::<ExtraTool>();
    tools.sort_by(|a, b| (&a.plugin, &a.name).cmp(&(&b.plugin, &b.name)));
    tools
}

/// One tool of a plugin bundle's code, run in the bundle's QuickJS runtime.
struct JsTool {
    js: Arc<JsPlugin>,
    name: String,
}

#[async_trait]
impl ExtraRun for JsTool {
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let tctx = ToolCtx { session_id: ctx.session_id.clone(), agent_name: ctx.agent_name.clone(), workspace: ctx.workspace.clone(), call_id: ctx.tool_call_id.clone() };
        match self.js.run_tool(&self.name, args, tctx).await {
            Ok(Value::String(text)) => Ok(ToolOutput::Text(text)),
            Ok(Value::Array(blocks)) => Ok(ToolOutput::Parts { parts: blocks.iter().filter_map(content_block).collect(), mcp_app: None }),
            Ok(other) => Ok(ToolOutput::Text(other.to_string())),
            Err(e) => Err(ToolError::Execution(e.message)),
        }
    }
}

/// A block a tool returned: `{"type": "text", "text"}` or
/// `{"type": "image", "data", "mimeType"}` (`run_tool` checked the shape).
fn content_block(v: &Value) -> Option<ContentBlock> {
    let field = |k: &str| v.get(k).and_then(Value::as_str);
    match field("type")? {
        "text" => Some(ContentBlock::Text { text: field("text")?.to_string() }),
        "image" => Some(ContentBlock::ImageData { data: field("data")?.into(), media_type: field("mimeType")?.to_string() }),
        _ => None,
    }
}

/// The tools of a bundle's code, as the `mcp` tool offers them.
pub fn bundle_tools(plugin: &str, js: &Arc<JsPlugin>) -> Vec<ExtraTool> {
    js.tools()
        .iter()
        .map(|t| ExtraTool {
            plugin: plugin.to_string(),
            name: t.name.clone(),
            description: t.description.clone(),
            input_schema: t.input_schema.clone(),
            read_only: t.read_only,
            runner: Arc::new(JsTool { js: js.clone(), name: t.name.clone() }),
        })
        .collect()
}

/// The result of the innermost handler.
pub type HandlerOut<P> = (String, P);

/// Run `handler` wrapped by every plugin (`_FunctionalPluginAdapter.wrap_tool_call`).
/// `P` carries the executor's extra outputs (parts, mcp app …); an aborted
/// call yields `P::default()`.
pub async fn wrap_tool_call<P, E, F, Fut>(plugins: &[ToolPluginRef], ctx: PluginCtx<'_>, tc: &ToolCall, handler: F) -> Result<HandlerOut<P>, E>
where
    P: Default,
    F: FnOnce(ToolCall) -> Fut,
    Fut: std::future::Future<Output = Result<HandlerOut<P>, E>>,
{
    // Enter each wrapper in order, remembering what its `after` needs.
    let mut entered: Vec<(usize, Value)> = vec![];
    let mut call = tc.clone();
    let mut aborted: Option<String> = None;
    for (i, p) in plugins.iter().enumerate() {
        if (!p.has_before() && !p.has_after()) || !p.applies_to(ctx.agent_name) {
            continue;
        }
        let raw = &call.function.arguments;
        let (mut args, parsed) = if raw.is_empty() {
            (Value::Object(Map::new()), true)
        } else {
            match serde_json::from_str::<Value>(raw) {
                Ok(v) => (v, true),
                Err(_) => (Value::Object(Map::new()), false),
            }
        };
        if p.has_before() && parsed {
            let pctx = PluginCtx { tool: &call.function.name, ..ctx_ref(&ctx) };
            if let Err(e) = p.before(&pctx, &mut args).await {
                tracing::info!("plugin_tool_before_aborted plugin={} tool={} reason={}", p.id(), call.function.name, e);
                aborted = Some(format!("Error: {e}"));
                break;
            }
            let mut rebuilt = call.clone();
            rebuilt.function.arguments = args.to_string();
            call = rebuilt;
        }
        entered.push((i, args));
    }
    let (mut result, extra) = match aborted {
        Some(text) => (text, P::default()),
        None => handler(call.clone()).await?,
    };
    for (i, args) in entered.iter().rev() {
        let p = &plugins[*i];
        if !p.has_after() {
            continue;
        }
        let pctx = PluginCtx { tool: &call.function.name, ..ctx_ref(&ctx) };
        let mut out = result.clone();
        match p.after(&pctx, args, &mut out).await {
            Ok(()) => result = out,
            Err(e) => tracing::warn!("plugin_tool_after_failed plugin={} tool={} error={}", p.id(), call.function.name, e),
        }
    }
    Ok((result, extra))
}

fn ctx_ref<'a>(c: &PluginCtx<'a>) -> PluginCtx<'a> {
    PluginCtx { tool: c.tool, session_id: c.session_id, run_id: c.run_id, agent_name: c.agent_name, call_id: c.call_id }
}
