//! MCP tool adapter — port of `app/agent/mcp/tools.py` and
//! `app/agent/tools/schema.py::sanitize_tool_schema`.

use crate::client::McpClient;
use appv3_providers::ContentBlock;
use appv3_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Weak};

pub const MCP_APP_MIME_TYPE: &str = "text/html;profile=mcp-app";

// ── schema sanitization ─────────────────────────────────────────────────────

fn strip_titles(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(k, _)| *k != "title").map(|(k, x)| (k.clone(), strip_titles(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(strip_titles).collect()),
        o => o.clone(),
    }
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default()
}

/// `resolve_top_level_combinators`.
pub fn resolve_top_level_combinators(schema: &Map<String, Value>) -> Map<String, Value> {
    let mut result = schema.clone();
    while ["allOf", "oneOf", "anyOf"].iter().any(|k| result.contains_key(*k)) {
        let mut props: Map<String, Value> = result.get("properties").and_then(|p| p.as_object()).cloned().unwrap_or_default();
        let mut required: Vec<String> = if result.get("required").map(|r| r.is_array()).unwrap_or(false) { str_list(result.get("required")) } else { vec![] };
        if let Some(Value::Array(all)) = result.shift_remove("allOf") {
            let mut set: BTreeSet<String> = required.iter().cloned().collect();
            for sub in all.iter().filter_map(|s| s.as_object()) {
                let flat = resolve_top_level_combinators(sub);
                if let Some(sp) = flat.get("properties").and_then(|p| p.as_object()) {
                    for (k, v) in sp {
                        if !props.contains_key(k) {
                            props.insert(k.clone(), v.clone());
                        }
                    }
                }
                if flat.get("required").map(|r| r.is_array()).unwrap_or(false) {
                    set.extend(str_list(flat.get("required")));
                }
            }
            required = set.into_iter().collect();
        }
        for comb in ["oneOf", "anyOf"] {
            let Some(Value::Array(branches)) = result.shift_remove(comb) else { continue };
            if branches.is_empty() {
                continue;
            }
            let mut sets: Vec<BTreeSet<String>> = vec![];
            for sub in branches.iter().filter_map(|s| s.as_object()) {
                let flat = resolve_top_level_combinators(sub);
                if let Some(sp) = flat.get("properties").and_then(|p| p.as_object()) {
                    for (k, v) in sp {
                        if !props.contains_key(k) {
                            props.insert(k.clone(), v.clone());
                        }
                    }
                }
                sets.push(if flat.get("required").map(|r| r.is_array()).unwrap_or(false) { str_list(flat.get("required")).into_iter().collect() } else { BTreeSet::new() });
            }
            if let Some(first) = sets.first().cloned() {
                let common: BTreeSet<String> = sets.iter().skip(1).fold(first, |acc, s| acc.intersection(s).cloned().collect());
                let mut all: BTreeSet<String> = required.iter().cloned().collect();
                all.extend(common);
                required = all.into_iter().collect();
            }
        }
        result.insert("properties".into(), Value::Object(props));
        result.insert("required".into(), json!(required));
        result.insert("type".into(), json!("object"));
    }
    result
}

fn is_null_branch(b: &Value) -> bool {
    b == &json!({"type": "null"}) || b.get("type") == Some(&json!("null"))
}

fn simplify_nullable(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut cleaned: Map<String, Value> = m.iter().map(|(k, x)| (k.clone(), simplify_nullable(x))).collect();
            if let Some(Value::Array(any)) = cleaned.get("anyOf").cloned() {
                if !any.is_empty() {
                    let non_null: Vec<Value> = any.iter().filter(|b| !is_null_branch(b)).cloned().collect();
                    if non_null.len() == 1 && non_null[0].is_object() {
                        let mut out = non_null[0].as_object().unwrap().clone();
                        for (k, x) in &cleaned {
                            if k != "anyOf" && !out.contains_key(k) {
                                out.insert(k.clone(), x.clone());
                            }
                        }
                        return Value::Object(out);
                    } else if !non_null.is_empty() && non_null.len() < any.len() {
                        cleaned.insert("anyOf".into(), Value::Array(non_null));
                        return Value::Object(cleaned);
                    }
                }
            }
            if let Some(Value::Array(all)) = cleaned.get("allOf").cloned() {
                if all.len() == 1 && all[0].is_object() {
                    let mut out = all[0].as_object().unwrap().clone();
                    for (k, x) in &cleaned {
                        if k != "allOf" && !out.contains_key(k) {
                            out.insert(k.clone(), x.clone());
                        }
                    }
                    return Value::Object(out);
                }
            }
            Value::Object(cleaned)
        }
        Value::Array(a) => Value::Array(a.iter().map(simplify_nullable).collect()),
        o => o.clone(),
    }
}

/// `sanitize_tool_schema`.
pub fn sanitize_tool_schema(schema: Option<&Value>) -> Value {
    let Some(Value::Object(m)) = schema.filter(|s| s.as_object().map(|o| !o.is_empty()).unwrap_or(false)) else {
        return json!({"type": "object", "properties": {}, "required": []});
    };
    let mut r = m.clone();
    r.entry("type").or_insert(json!("object"));
    r.entry("properties").or_insert(json!({}));
    r.entry("required").or_insert(json!([]));
    r.shift_remove("$schema");
    r.shift_remove("$id");
    simplify_nullable(&strip_titles(&Value::Object(resolve_top_level_combinators(&r))))
}

// ── content extraction ──────────────────────────────────────────────────────

fn py_block_str(b: &Value) -> String {
    b.to_string()
}

fn mime_of(v: &Value) -> Option<String> {
    v.get("mimeType").or_else(|| v.get("mime_type")).and_then(|m| m.as_str()).filter(|s| !s.is_empty()).map(String::from)
}

/// `_extract_text`.
pub fn extract_text(content: Option<&Value>) -> String {
    let Some(content) = content else { return String::new() };
    let Value::Array(blocks) = content else {
        return if content.is_null() { String::new() } else { content.to_string() };
    };
    let mut parts = vec![];
    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => parts.push(b.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string()),
            Some("image") => parts.push(format!("[image: {}]", mime_of(b).unwrap_or_else(|| "image/*".into()))),
            Some("resource") => {
                let uri = b.get("resource").and_then(|r| r.get("uri")).and_then(|u| u.as_str()).filter(|s| !s.is_empty()).unwrap_or("?");
                parts.push(format!("[resource: {uri}]"));
            }
            _ => parts.push(py_block_str(b)),
        }
    }
    parts.join("\n")
}

fn normalize_image_mime(mime: Option<&str>) -> String {
    let Some(m) = mime.filter(|m| !m.is_empty()) else { return "image/png".into() };
    let clean = m.split(';').next().unwrap_or("").trim().to_lowercase();
    if clean == "image/jpg" {
        return "image/jpeg".into();
    }
    if !clean.contains('/') {
        if clean == "jpg" || clean == "jpeg" {
            return "image/jpeg".into();
        }
        return format!("image/{clean}");
    }
    clean
}

/// `_extract_parts`.
pub fn extract_parts(content: Option<&Value>) -> Vec<ContentBlock> {
    let Some(content) = content.filter(|c| !c.is_null()) else { return vec![] };
    let Value::Array(blocks) = content else { return vec![ContentBlock::text(content.to_string())] };
    let mut parts = vec![];
    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => parts.push(ContentBlock::text(b.get("text").and_then(|t| t.as_str()).unwrap_or(""))),
            Some("image") => {
                let mime = mime_of(b);
                match b.get("data").and_then(|d| d.as_str()).filter(|d| !d.is_empty()) {
                    Some(data) => parts.push(ContentBlock::ImageData { data: data.into(), media_type: normalize_image_mime(mime.as_deref()) }),
                    None => parts.push(ContentBlock::text(format!("[image: {}]", mime.unwrap_or_else(|| "image/*".into())))),
                }
            }
            Some("resource") => {
                let res = b.get("resource").cloned().unwrap_or(Value::Null);
                let blob = res.get("blob").and_then(|x| x.as_str()).filter(|s| !s.is_empty());
                let uri = res.get("uri").and_then(|u| u.as_str()).filter(|s| !s.is_empty()).unwrap_or("?").to_string();
                let mut mime = mime_of(&res);
                if mime.is_none() && uri != "?" {
                    mime = appv3_core::mimetypes::guess_type(&uri);
                }
                match (blob, &mime) {
                    (Some(blob), Some(m)) if m.starts_with("image/") || !m.contains('/') => {
                        parts.push(ContentBlock::ImageData { data: blob.into(), media_type: normalize_image_mime(Some(m)) })
                    }
                    _ => match res.get("text").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
                        Some(t) => parts.push(ContentBlock::text(t)),
                        None => parts.push(ContentBlock::text(format!("[resource: {uri}]"))),
                    },
                }
            }
            _ => parts.push(ContentBlock::text(py_block_str(b))),
        }
    }
    parts
}

/// `_get_ui_meta`.
pub fn ui_meta(tool: &Value) -> Map<String, Value> {
    let Some(meta) = tool.get("_meta").and_then(|m| m.as_object()) else { return Map::new() };
    if let Some(ui) = meta.get("ui").and_then(|u| u.as_object()) {
        return ui.clone();
    }
    match meta.get("ui/resourceUri").and_then(|u| u.as_str()) {
        Some(u) => {
            let mut m = Map::new();
            m.insert("resourceUri".into(), json!(u));
            m
        }
        None => Map::new(),
    }
}

fn extract_app_resource(res: &Value, uri: &str) -> Option<Map<String, Value>> {
    for c in res.get("contents")?.as_array()? {
        if c.get("mimeType").and_then(|m| m.as_str()) != Some(MCP_APP_MIME_TYPE) {
            continue;
        }
        let html = match c.get("text").and_then(|t| t.as_str()) {
            Some(t) => Some(t.to_string()),
            None => c.get("blob").and_then(|b| b.as_str()).and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok()).and_then(|b| String::from_utf8(b).ok()),
        };
        let Some(html) = html.filter(|h| !h.is_empty()) else { continue };
        let mut m = Map::new();
        m.insert("resourceUri".into(), json!(c.get("uri").and_then(|u| u.as_str()).unwrap_or(uri)));
        m.insert("mimeType".into(), json!(MCP_APP_MIME_TYPE));
        m.insert("html".into(), json!(html));
        m.insert("resourceMeta".into(), c.get("_meta").filter(|x| x.is_object()).cloned().unwrap_or(Value::Null));
        return Some(m);
    }
    None
}

fn drop_nulls(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(_, x)| !x.is_null()).map(|(k, x)| (k.clone(), drop_nulls(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(drop_nulls).collect()),
        o => o.clone(),
    }
}

/// `CallToolResult.model_dump(by_alias=True, exclude_none=True)` approximation.
pub fn dump_call_result(result: &Value) -> Value {
    let mut v = drop_nulls(result);
    if let Some(o) = v.as_object_mut() {
        o.entry("content").or_insert(json!([]));
        o.entry("isError").or_insert(json!(false));
    }
    v
}

// ── tool ────────────────────────────────────────────────────────────────────

/// Resolves the live client of the owning runner (`session_provider`).
pub trait SessionProvider: Send + Sync {
    fn client(&self) -> Option<Arc<McpClient>>;
}

pub struct McpTool {
    pub server_name: String,
    pub remote_name: String,
    pub name: String,
    pub description: String,
    pub def: Value,
    /// The model-facing definition. Sanitizing the input schema deep-clones it
    /// several times; tool definitions are listed on every turn and agent
    /// listing, and `def` never changes after connect, so build it once.
    definition: Value,
    session: Weak<dyn SessionProvider>,
}

impl McpTool {
    pub fn new(server_name: &str, def: Value, session: Weak<dyn SessionProvider>) -> Self {
        let remote = def.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        let description = def
            .get("description")
            .and_then(|d| d.as_str())
            .filter(|d| !d.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("Tool '{remote}' from MCP server '{server_name}'."));
        let name = format!("{server_name}_{remote}");
        let definition = json!({"type": "function", "function": {"name": name, "description": description, "parameters": sanitize_tool_schema(def.get("inputSchema"))}});
        McpTool { server_name: server_name.into(), name, remote_name: remote, description, def, definition, session }
    }

    /// The sanitized input schema the model is given for this tool.
    pub fn input_schema(&self) -> Value {
        self.definition["function"]["parameters"].clone()
    }

    /// The server marks the tool `annotations.readOnlyHint: true` (a hint
    /// the server sets; nothing verifies it).
    pub fn read_only(&self) -> bool {
        self.def.pointer("/annotations/readOnlyHint") == Some(&Value::Bool(true))
    }
}

#[async_trait]
impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn definition(&self) -> Value {
        self.definition.clone()
    }

    async fn run(&self, _ctx: &ToolContext, args: Value) -> ToolResult {
        let Some(client) = self.session.upgrade().and_then(|s| s.client()) else {
            return Err(ToolError::Execution(format!("MCP server '{}' is not connected.", self.server_name)));
        };
        let args = if args.is_object() { args } else { json!({}) };
        tracing::debug!("mcp_tool_call server={} tool={} args={:?}", self.server_name, self.remote_name, args.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()));
        let result = client.call_tool(&self.remote_name, args.clone()).await.map_err(|e| ToolError::Execution(format!("MCP tool '{}' failed: {}", self.name, e.formatted())))?;
        let content = result.get("content");
        if result.get("isError").and_then(|b| b.as_bool()).unwrap_or(false) {
            let text = extract_text(content);
            return Err(ToolError::Execution(format!("MCP tool '{}' returned error: {}", self.name, if text.is_empty() { "(no message)" } else { &text })));
        }
        let parts = extract_parts(content);
        let has_images = parts.iter().any(|p| matches!(p, ContentBlock::ImageData { .. }));
        let summary = extract_text(content);
        let meta = ui_meta(&self.def);
        if let Some(uri) = meta.get("resourceUri").and_then(|u| u.as_str()).filter(|u| !u.is_empty()) {
            match client.read_resource(uri).await {
                Ok(res) => {
                    if let Some(mut app) = extract_app_resource(&res, uri) {
                        if app.get("resourceMeta").map(|m| m.is_null()).unwrap_or(true) {
                            let listing = client.list_resources().await.ok().and_then(|l| {
                                l.get("resources")?
                                    .as_array()?
                                    .iter()
                                    .find(|r| r.get("uri").and_then(|u| u.as_str()) == Some(uri))
                                    .map(|r| r.get("_meta").filter(|m| m.is_object()).cloned().unwrap_or(Value::Null))
                            });
                            app.insert("resourceMeta".into(), listing.unwrap_or(Value::Null));
                        }
                        let mut app_parts = parts.clone();
                        if !app_parts.iter().any(|p| matches!(p, ContentBlock::Text { .. })) {
                            app_parts.insert(0, ContentBlock::text(summary.clone()));
                        }
                        let mcp_app = json!({
                            "server": self.server_name, "tool": self.remote_name, "name": self.name,
                            "resourceUri": uri, "html": app["html"], "mimeType": app.get("mimeType"),
                            "resourceMeta": app.get("resourceMeta"), "toolMeta": meta, "tool_input": args,
                            "result": dump_call_result(&result),
                        });
                        return Ok(ToolOutput::Parts { parts: app_parts, mcp_app: Some(mcp_app) });
                    }
                }
                Err(e) => tracing::warn!("mcp_app_resource_fetch_failed server={} tool={} uri={} error={}", self.server_name, self.remote_name, uri, e),
            }
        }
        if has_images {
            return Ok(ToolOutput::Parts { parts, mcp_app: None });
        }
        Ok(ToolOutput::Text(summary))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize() {
        assert_eq!(sanitize_tool_schema(None), json!({"type": "object", "properties": {}, "required": []}));
        let s = json!({"$schema": "x", "title": "T", "properties": {"a": {"title": "A", "anyOf": [{"type": "string"}, {"type": "null"}], "description": "d"}}});
        assert_eq!(sanitize_tool_schema(Some(&s)), json!({"properties": {"a": {"type": "string", "description": "d"}}, "type": "object", "required": []}));
        let s = json!({"oneOf": [{"properties": {"x": {"type": "string"}}, "required": ["x"]}, {"properties": {"y": {}}, "required": ["x", "y"]}]});
        let r = sanitize_tool_schema(Some(&s));
        assert_eq!(r["required"], json!(["x"]));
        assert_eq!(r["type"], "object");
    }

    #[test]
    fn text_and_parts() {
        let c = json!([{"type": "text", "text": "hi"}, {"type": "image", "data": "AAA", "mimeType": "image/jpg"}, {"type": "resource", "resource": {"uri": "file:///a.txt", "text": "body"}}]);
        assert_eq!(extract_text(Some(&c)), "hi\n[image: image/jpg]\n[resource: file:///a.txt]");
        let p = extract_parts(Some(&c));
        assert_eq!(p[1], ContentBlock::ImageData { data: "AAA".into(), media_type: "image/jpeg".into() });
        assert_eq!(p[2], ContentBlock::text("body"));
    }

    struct NoSession;
    impl SessionProvider for NoSession {
        fn client(&self) -> Option<Arc<McpClient>> {
            None
        }
    }

    #[test]
    fn definition_names_the_tool_and_sanitizes_its_schema() {
        let session: Arc<dyn SessionProvider> = Arc::new(NoSession);
        let def = json!({"name": "search", "inputSchema": {"title": "T", "properties": {"q": {"title": "Q", "type": "string"}}}});
        let tool = McpTool::new("docs", def, Arc::downgrade(&session));
        assert_eq!(
            tool.definition(),
            json!({"type": "function", "function": {
                "name": "docs_search",
                "description": "Tool 'search' from MCP server 'docs'.",
                "parameters": {"properties": {"q": {"type": "string"}}, "type": "object", "required": []},
            }})
        );
    }
}
