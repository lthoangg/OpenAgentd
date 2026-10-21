//! Built-in agent tools.
//!
//! Model-facing definitions come from `data/tool_definitions.json`.
//! Session-bound tools (ask_user, delegate, skill, schedule_task, …) live in
//! the agent crate and implement the same [`Tool`] trait.

pub mod args;
pub mod denied;
pub mod glob;
pub mod grep;
pub mod ignores;
pub mod lsp;
pub mod multimodal;
pub mod patch;
pub mod read;
pub mod shell;
pub mod shell_snapshot;
pub mod todo;
pub mod web;

use appv3_providers::ContentBlock;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

pub use denied::DeniedPaths;

const CONTRACT_JSON: &str = include_str!("../data/tool_definitions.json");

/// v2 tool definition for *name*, exactly as v2 sends it to the LLM.
pub fn contract_definition(name: &str) -> Option<Value> {
    static C: OnceLock<serde_json::Map<String, Value>> = OnceLock::new();
    let map = C.get_or_init(|| serde_json::from_str(CONTRACT_JSON).expect("tool contract json"));
    let mut def = map.get(name).cloned()?;
    if name == "shell" {
        if let Some(desc) = def.pointer_mut("/function/description") {
            let s = desc.as_str().unwrap_or("").to_string();
            let base = s.split(" Environment: ").next().unwrap_or(&s).to_string();
            *desc = Value::String(format!("{base} {}", shell::environment_summary()));
        }
    }
    Some(def)
}

/// What keeps a tool definition from reaching every model as written: a
/// field without a description, or a schema key a provider adapter drops
/// (so its rule never reaches that provider's models). Empty when clean.
pub fn schema_problems(def: &Value) -> Vec<String> {
    fn walk(props: &serde_json::Map<String, Value>, path: &str, out: &mut Vec<String>) {
        for (name, field) in props {
            let at = format!("{path}.{name}");
            if field.get("description").and_then(Value::as_str).is_none_or(|d| d.trim().is_empty()) {
                out.push(format!("{at}: no description"));
            }
            for key in appv3_providers::google::UNSUPPORTED_SCHEMA_KEYS {
                if field.get(*key).is_some() {
                    out.push(format!("{at}: uses '{key}', which a provider adapter drops"));
                }
            }
            if let Some(inner) = field.pointer("/items/properties").and_then(Value::as_object) {
                walk(inner, &format!("{at}[]"), out);
            }
        }
    }
    let name = def.pointer("/function/name").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![];
    if let Some(props) = def.pointer("/function/parameters/properties").and_then(Value::as_object) {
        walk(props, name, &mut out);
    }
    out
}

/// Callback for streaming partial tool output (v2 `_tool_output`).
pub type OutputSink = Arc<dyn Fn(String) + Send + Sync>;

/// Runtime context injected into every tool call.
#[derive(Clone)]
pub struct ToolContext {
    pub session_id: Option<String>,
    pub agent_name: String,
    pub tool_call_id: String,
    pub denied: Arc<DeniedPaths>,
    /// Coding workspace (`_workspace`), when the session has one.
    pub workspace: Option<String>,
    pub output: Option<OutputSink>,
    /// Mutable per-run metadata (`state.metadata`), e.g. `end_turn`.
    pub metadata: Arc<std::sync::Mutex<serde_json::Map<String, Value>>>,
    /// Snapshot of `state.messages_for_llm` (only populated when a tool needs it).
    pub messages: Option<Arc<Vec<appv3_providers::ChatMessage>>>,
}

impl ToolContext {
    pub fn workspace_root(&self) -> PathBuf {
        self.denied.workspace_root.clone()
    }
    /// `{DATA_DIR}/sessions/<sid>` (or the sessions root when no session).
    pub fn artifacts_dir(&self) -> PathBuf {
        denied::session_artifacts_dir(self.session_id.as_deref())
    }
}

/// Tool return value (v2 `str | ToolResult`).
#[derive(Debug, Clone, PartialEq)]
pub enum ToolOutput {
    Text(String),
    Parts { parts: Vec<ContentBlock>, mcp_app: Option<Value> },
}

impl ToolOutput {
    pub fn text(s: impl Into<String>) -> Self {
        ToolOutput::Text(s.into())
    }
}

/// Control-flow suspensions that unwind the loop (not failures).
#[derive(Debug, Clone)]
pub enum Suspension {
    Question { question_id: String, session_id: String },
    Lead { question: String, options: Vec<String>, tool_call_id: Option<String> },
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ToolError {
    #[error("{0}")]
    Argument(String),
    #[error("{0}")]
    Execution(String),
    #[error("Tool '{0}' not found.")]
    NotFound(String),
    #[error("suspended")]
    Suspended(Suspension),
}

impl ToolError {
    pub fn exec(e: impl std::fmt::Display) -> Self {
        ToolError::Execution(e.to_string())
    }
}

impl From<std::io::Error> for ToolError {
    fn from(e: std::io::Error) -> Self {
        ToolError::Execution(e.to_string())
    }
}

pub type ToolResult = Result<ToolOutput, ToolError>;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    /// OpenAI-style definition `{"type":"function","function":{...}}`.
    fn definition(&self) -> Value {
        contract_definition(self.name()).unwrap_or_else(
            || serde_json::json!({"type": "function", "function": {"name": self.name(), "description": "", "parameters": {"type": "object", "properties": {}, "required": []}}}),
        )
    }
    /// Definition rendered for a specific run (v2 dynamic descriptions that
    /// read the active `DeniedPathsConfig`, e.g. `skill`).
    fn definition_for(&self, _ctx: &ToolContext) -> Value {
        self.definition()
    }
    /// Run with raw LLM arguments (already JSON-parsed).
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult;
}

pub type ToolRef = Arc<dyn Tool>;

/// Name → tool map, preserving registration order for the definitions list.
#[derive(Clone, Default)]
pub struct ToolSet {
    order: Vec<String>,
    map: HashMap<String, ToolRef>,
}

impl ToolSet {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn add(&mut self, t: ToolRef) {
        let n = t.name().to_string();
        if !self.map.contains_key(&n) {
            self.order.push(n.clone());
        }
        self.map.insert(n, t);
    }
    pub fn get(&self, name: &str) -> Option<&ToolRef> {
        self.map.get(name)
    }
    pub fn contains(&self, name: &str) -> bool {
        self.map.contains_key(name)
    }
    pub fn names(&self) -> Vec<String> {
        self.order.clone()
    }
    pub fn definitions(&self) -> Vec<Value> {
        self.order.iter().filter_map(|n| self.map.get(n)).map(|t| t.definition()).collect()
    }
    pub fn definitions_for(&self, ctx: &ToolContext) -> Vec<Value> {
        self.order.iter().filter_map(|n| self.map.get(n)).map(|t| t.definition_for(ctx)).collect()
    }
    pub fn remove(&mut self, name: &str) {
        self.map.remove(name);
        self.order.retain(|n| n != name);
    }
}

/// Built-in, session-independent tools by v2 name.
pub fn builtin_tool(name: &str) -> Option<ToolRef> {
    Some(match name {
        "read" => Arc::new(read::ReadTool),
        "grep" => Arc::new(grep::GrepTool),
        "glob" => Arc::new(glob::GlobTool),
        "patch" => Arc::new(patch::PatchTool),
        "shell" => Arc::new(shell::ShellTool),
        "web_search" => Arc::new(web::WebSearchTool),
        "web_fetch" => Arc::new(web::WebFetchTool),
        "todo_manage" => Arc::new(todo::TodoTool),
        "generate_image" => Arc::new(multimodal::GenerateImageTool),
        "generate_video" => Arc::new(multimodal::GenerateVideoTool),
        _ => return None,
    })
}

pub const TOOL_TIMEOUT_SECONDS: u64 = 300;

/// Result of executing one tool call (v2 `tool_executor.execute`).
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub text: String,
    pub parts: Option<Vec<ContentBlock>>,
    pub mcp_app: Option<Value>,
}

/// Innermost executor: parse args, look up, run, coerce result, format errors.
/// Returns `Err` only for suspensions.
pub async fn execute(tools: &ToolSet, ctx: &ToolContext, name: &str, raw_args: &str) -> Result<ExecOutcome, Suspension> {
    let start = std::time::Instant::now();
    tracing::info!("tool_start agent={} tool={} id={} args={}", ctx.agent_name, name, ctx.tool_call_id, raw_args.chars().take(500).collect::<String>());
    let res: Result<ToolOutput, ToolError> = async {
        let args: Value = if raw_args.is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(raw_args)
                .map_err(|e| ToolError::Argument(format!("Could not parse arguments for tool '{name}': {}. Raw: {}", py_json_error(&e), py_repr_str(raw_args))))?
        };
        let tool = tools.get(name).ok_or_else(|| ToolError::NotFound(name.to_string()))?;
        if raw_args.is_empty() {
            let def = tool.definition();
            let mut req: Vec<String> = def
                .pointer("/function/parameters/required")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if !req.is_empty() {
                req.sort();
                return Err(ToolError::Argument(format!("No arguments received for '{name}' (requires {}). Retry with a smaller payload.", req.join(", "))));
            }
        }
        if name == "shell" {
            tool.run(ctx, args).await
        } else {
            match tokio::time::timeout(std::time::Duration::from_secs(TOOL_TIMEOUT_SECONDS), tool.run(ctx, args)).await {
                Ok(r) => r,
                Err(_) => Err(ToolError::Execution(format!("Tool '{name}' timed out after {TOOL_TIMEOUT_SECONDS}.0s."))),
            }
        }
    }
    .await;
    let elapsed = start.elapsed().as_secs_f64();
    match res {
        Ok(ToolOutput::Text(t)) => {
            tracing::info!("tool_done agent={} tool={} elapsed={:.2}s result_len={}", ctx.agent_name, name, elapsed, t.chars().count());
            Ok(ExecOutcome { text: t, parts: None, mcp_app: None })
        }
        Ok(ToolOutput::Parts { mut parts, mcp_app }) => {
            // MCP/plugin images: header check inline, resize only oversized ones off the runtime.
            let t = std::time::Instant::now();
            let resized = appv3_providers::images::fit_tool_parts(&mut parts).await;
            if resized > 0 {
                tracing::debug!("tool_images_resized tool={name} count={resized} ms={}", t.elapsed().as_millis());
            }
            let mut text = parts
                .iter()
                .filter_map(|p| match p {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" ");
            if text.is_empty() {
                text = parts
                    .iter()
                    .filter_map(|p| match p {
                        ContentBlock::ImageUrl { media_type, .. } => Some(format!("[image_url: {}]", media_type.clone().unwrap_or_else(|| "?".into()))),
                        ContentBlock::ImageData { media_type, .. } => Some(format!("[image: {media_type}]")),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
            }
            Ok(ExecOutcome { text, parts: Some(parts), mcp_app })
        }
        Err(ToolError::Suspended(s)) => Err(s),
        Err(e) => {
            tracing::warn!("tool_error agent={} tool={} elapsed={:.2}s error={}", ctx.agent_name, name, elapsed, e);
            Ok(ExecOutcome { text: format!("Error: {e}"), parts: None, mcp_app: None })
        }
    }
}

/// Python `repr(str)` (single-quoted unless the string contains `'` only).
pub fn py_repr_str(s: &str) -> String {
    let use_double = s.contains('\'') && !s.contains('"');
    let q = if use_double { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// Approximate Python `json.JSONDecodeError` text: `Expecting value: line 1 column 1 (char 0)`.
pub(crate) fn py_json_error(e: &serde_json::Error) -> String {
    let msg = e.to_string();
    let base = msg.split(" at line ").next().unwrap_or(&msg);
    let py = match e.classify() {
        serde_json::error::Category::Eof => "Expecting value",
        _ if base.contains("expected value") || base.contains("expected ident") => "Expecting value",
        _ if base.contains("trailing characters") => "Extra data",
        _ if base.contains("key must be a string") => "Expecting property name enclosed in double quotes",
        _ if base.contains("expected `,` or `}`") => "Expecting ',' delimiter",
        _ if base.contains("expected `,` or `]`") => "Expecting ',' delimiter",
        _ if base.contains("expected `:`") => "Expecting ':' delimiter",
        _ if base.contains("control character") => "Invalid control character at",
        _ => base,
    };
    let keep = matches!(e.classify(), serde_json::error::Category::Eof) || base.contains("key must be a string");
    let col = e.column().saturating_sub(if keep { 0 } else { 1 });
    format!("{py}: line {} column {} (char {})", e.line(), col.max(1), col.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_providers::images::{dimensions_b64, fixtures};
    use base64::Engine;

    struct ImageTool(Vec<ContentBlock>);

    #[async_trait]
    impl Tool for ImageTool {
        fn name(&self) -> &str {
            "shot"
        }
        async fn run(&self, _: &ToolContext, _: Value) -> ToolResult {
            Ok(ToolOutput::Parts { parts: self.0.clone(), mcp_app: None })
        }
    }

    fn ctx(ws: &std::path::Path) -> ToolContext {
        ToolContext {
            session_id: None,
            agent_name: "t".into(),
            tool_call_id: "c".into(),
            denied: Arc::new(DeniedPaths::with(ws, None, Some(vec![]), Some(vec![]))),
            workspace: None,
            output: None,
            metadata: Default::default(),
            messages: None,
        }
    }

    #[tokio::test]
    async fn execute_shrinks_oversized_tool_images_and_keeps_small_ones() {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let small = ContentBlock::ImageData { data: b64(&fixtures::png(200, 100)).into(), media_type: "image/png".into() };
        let big = ContentBlock::ImageData { data: b64(&fixtures::png(2400, 1600)).into(), media_type: "image/png".into() };
        let mut set = ToolSet::new();
        set.add(Arc::new(ImageTool(vec![ContentBlock::text("[screenshot]"), big, small.clone()])));
        let d = tempfile::tempdir().unwrap();
        let out = execute(&set, &ctx(d.path()), "shot", "{}").await.unwrap();
        assert_eq!(out.text, "[screenshot]");
        let parts = out.parts.unwrap();
        let ContentBlock::ImageData { data, media_type } = &parts[1] else { panic!("image") };
        assert_eq!((dimensions_b64(data), media_type.as_str()), (Some((2000, 1333)), "image/png"));
        assert_eq!(parts[2], small);
    }

    #[test]
    fn schema_problems_flags_undescribed_fields_and_keys_a_provider_drops() {
        let def = serde_json::json!({"type": "function", "function": {"name": "t", "description": "d", "parameters": {"type": "object", "properties": {
            "ok": {"type": "integer", "minimum": 1, "description": "Fine."},
            "bare": {"type": "string"},
            "bound": {"type": "integer", "exclusiveMinimum": 0, "description": "Gemini never sees the bound."},
            "list": {"type": "array", "description": "Nested.", "items": {"type": "object", "properties": {"inner": {"type": "string", "description": ""}}}}
        }}}});

        let problems = schema_problems(&def);

        assert_eq!(
            problems,
            vec![
                "t.bare: no description".to_string(),
                "t.bound: uses 'exclusiveMinimum', which a provider adapter drops".to_string(),
                "t.list[].inner: no description".to_string(),
            ]
        );
        assert!(schema_problems(&contract_definition("glob").unwrap()).is_empty());
    }
}
