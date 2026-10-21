//! Gemini Developer API — port of `providers/googlegenai/googlegenai.py`.

use crate::openai::shared_client;
use crate::sse;
use crate::types::*;
use crate::usage::usage_to_dict;
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub const API_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Schema keys the Gemini API rejects, so `sanitize_schema` drops them.
pub const UNSUPPORTED_SCHEMA_KEYS: &[&str] =
    &["discriminator", "const", "exclusiveMinimum", "exclusiveMaximum", "additionalProperties", "$schema", "$id", "$ref", "contentEncoding", "contentMediaType"];

pub fn sanitize_schema(v: &Value) -> Value {
    sanitize_node(v, false)
}

/// Gemini rejects a nested `object` schema without properties ("should be
/// non-empty for OBJECT type"), so a free-form object (e.g. the `mcp` tool's
/// `arguments`) is declared as a JSON-encoded string instead.
fn sanitize_node(v: &Value, nested: bool) -> Value {
    match v {
        Value::Object(m) => {
            let open_object = m.get("type") == Some(&json!("object")) && m.get("properties").and_then(Value::as_object).is_none_or(|p| p.is_empty());
            if nested && open_object {
                let desc = m.get("description").and_then(Value::as_str).map(|d| format!("{d} ")).unwrap_or_default();
                return json!({"type": "string", "description": format!("{desc}Pass a JSON object encoded as a string.")});
            }
            Value::Object(m.iter().filter(|(k, _)| !UNSUPPORTED_SCHEMA_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), sanitize_node(v, true))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| sanitize_node(x, true)).collect()),
        o => o.clone(),
    }
}

/// A `functionCall`'s `args` as the tool-call argument string (`{}` when
/// absent): compact, non-ASCII verbatim.
fn function_call_args(fc: &Value) -> String {
    fc.get("args").map(Value::to_string).unwrap_or_else(|| "{}".into())
}

fn text_part(t: &str) -> Value {
    json!({"text": t})
}

fn media_parts(parts: &[ContentBlock]) -> Vec<Value> {
    let mut out = vec![];
    for p in parts {
        match p {
            ContentBlock::Text { text } => out.push(text_part(text)),
            ContentBlock::ImageData { data, media_type } => out.push(json!({"inlineData": {"mimeType": media_type, "data": data}})),
            ContentBlock::ImageUrl { url, media_type, .. } => {
                if let Some(rest) = url.strip_prefix("data:") {
                    let (header, b64) = rest.split_once(',').unwrap_or((rest, ""));
                    let mime = header.split(';').next().unwrap_or("");
                    out.push(json!({"inlineData": {"mimeType": mime, "data": b64}}));
                } else {
                    out.push(json!({"fileData": {"mimeType": media_type.clone().unwrap_or_else(|| "image/jpeg".into()), "fileUri": url}}));
                }
            }
        }
    }
    out
}

fn has_fn_response(c: &Value) -> bool {
    c["parts"].as_array().map(|p| p.iter().any(|x| x.get("functionResponse").is_some())).unwrap_or(false)
}

fn concat_parts(a: &Value, b: &Value) -> Value {
    let mut p = a["parts"].as_array().cloned().unwrap_or_default();
    p.extend(b["parts"].as_array().cloned().unwrap_or_default());
    json!(p)
}

/// v2 `_normalize_gemini_turns`.
pub fn normalize_turns(contents: Vec<Value>) -> Vec<Value> {
    let mut collapsed: Vec<Value> = vec![];
    for c in contents {
        if c["parts"].as_array().map(|p| p.is_empty()).unwrap_or(true) {
            continue;
        }
        if let Some(prev) = collapsed.last_mut() {
            if prev["role"] == c["role"] && has_fn_response(prev) == has_fn_response(&c) {
                let parts = concat_parts(prev, &c);
                *prev = json!({"role": c["role"], "parts": parts});
                continue;
            }
        }
        collapsed.push(c);
    }
    if collapsed.is_empty() {
        return vec![];
    }
    let mut normalized: Vec<Value> = vec![];
    if collapsed[0]["role"] != "user" {
        normalized.push(json!({"role": "user", "parts": [text_part("[Session context]")]}));
    }
    for c in collapsed {
        if let Some(prev) = normalized.last() {
            if prev["role"] == c["role"] {
                let (pf, cf) = (has_fn_response(prev), has_fn_response(&c));
                if pf && !cf {
                    normalized.push(json!({"role": "model", "parts": [text_part("Understood.")]}));
                } else if !pf && cf {
                    normalized.push(json!({"role": "model", "parts": [text_part("Acknowledged.")]}));
                } else {
                    let parts = concat_parts(prev, &c);
                    let last = normalized.last_mut().unwrap();
                    *last = json!({"role": c["role"], "parts": parts});
                    continue;
                }
            }
        }
        normalized.push(c);
    }
    normalized
}

/// v2 `_convert_messages_to_gemini` → (contents, system_instruction).
pub fn convert_messages(messages: &[ChatMessage]) -> (Vec<Value>, Option<Value>) {
    let mut contents = vec![];
    let mut system = None;
    for msg in messages {
        match msg {
            ChatMessage::System { content, .. } => {
                let mut part = Map::new();
                if let Some(c) = content {
                    part.insert("text".into(), json!(c));
                }
                system = Some(json!({"parts": [part]}));
            }
            ChatMessage::User { content, parts, .. } => {
                if let Some(p) = parts.as_ref().filter(|p| !p.is_empty()) {
                    contents.push(json!({"role": "user", "parts": media_parts(p)}));
                } else {
                    let mut part = Map::new();
                    if let Some(c) = content {
                        part.insert("text".into(), json!(c));
                    }
                    contents.push(json!({"role": "user", "parts": [part]}));
                }
            }
            ChatMessage::Assistant(a) => {
                let mut parts = vec![];
                let tcs = a.tool_calls.as_ref().filter(|t| !t.is_empty());
                if let Some(c) = a.content.as_ref().filter(|c| !c.is_empty()) {
                    if tcs.is_some() {
                        parts.push(json!({"text": c, "thought": true}));
                    } else {
                        parts.push(text_part(c));
                    }
                }
                if let Some(tcs) = tcs {
                    for tc in tcs {
                        let args = match serde_json::from_str::<Value>(&tc.function.arguments) {
                            Ok(Value::Object(m)) => Value::Object(m),
                            _ => json!({}),
                        };
                        if let Some(th) = tc.function.thought.as_ref().filter(|t| match t {
                            Value::Bool(b) => *b,
                            Value::String(s) => !s.is_empty(),
                            Value::Null => false,
                            _ => true,
                        }) {
                            let s = match th {
                                Value::Bool(true) => "True".to_string(),
                                Value::String(s) => s.clone(),
                                o => o.to_string(),
                            };
                            parts.push(json!({"text": s, "thought": true}));
                        }
                        let sig = tc.function.thought_signature.clone().filter(|s| !s.is_empty()).or_else(|| a.reasoning_signature.clone().filter(|s| !s.is_empty()));
                        let mut fc = Map::new();
                        fc.insert("name".into(), json!(tc.function.name));
                        fc.insert("args".into(), args);
                        if !tc.id.starts_with("call_") {
                            fc.insert("id".into(), json!(tc.id));
                        }
                        let mut part = Map::new();
                        if let Some(s) = sig {
                            part.insert("thoughtSignature".into(), json!(s));
                        }
                        part.insert("functionCall".into(), Value::Object(fc));
                        parts.push(Value::Object(part));
                    }
                } else if let Some(r) = a.reasoning_content.as_ref().filter(|r| !r.is_empty()) {
                    let mut part = Map::new();
                    part.insert("text".into(), json!(r));
                    part.insert("thought".into(), json!(true));
                    if let Some(s) = a.reasoning_signature.as_ref().filter(|s| !s.is_empty()) {
                        part.insert("thoughtSignature".into(), json!(s));
                    }
                    parts.push(Value::Object(part));
                }
                if parts.is_empty() {
                    continue;
                }
                contents.push(json!({"role": "model", "parts": parts}));
            }
            ChatMessage::Tool { content, tool_call_id, name, parts, .. } => {
                let result = match content.as_deref() {
                    None | Some("") => json!({"result": "No content"}),
                    Some(c) => match serde_json::from_str::<Value>(c) {
                        Ok(Value::Object(m)) => Value::Object(m),
                        Ok(other) => json!({"result": other}),
                        Err(_) => json!({"result": c}),
                    },
                };
                let mut tp = vec![json!({"functionResponse": {"name": name.clone().unwrap_or_else(|| "unknown".into()), "response": result, "id": tool_call_id}})];
                if let Some(p) = parts.as_ref().filter(|p| !p.is_empty()) {
                    tp.extend(media_parts(p));
                }
                contents.push(json!({"role": "user", "parts": tp}));
            }
        }
    }
    (normalize_turns(contents), system)
}

pub fn convert_tools(tools: Option<&[ToolSpec]>) -> Option<Vec<Value>> {
    let decls: Vec<Value> = tools
        .unwrap_or(&[])
        .iter()
        .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("function"))
        .map(|t| {
            let f = &t["function"];
            let mut d = Map::new();
            d.insert("name".into(), f["name"].clone());
            d.insert("description".into(), f.get("description").cloned().unwrap_or(json!("")));
            if let Some(p) = f.get("parameters").filter(|p| !p.is_null() && p.as_object().map(|o| !o.is_empty()).unwrap_or(true)) {
                d.insert("parameters".into(), sanitize_schema(p));
            }
            Value::Object(d)
        })
        .collect();
    if decls.is_empty() {
        None
    } else {
        Some(vec![json!({"functionDeclarations": decls})])
    }
}

pub struct GoogleGenAiProvider {
    pub model: String,
    pub provider_name: Option<String>,
    pub base_url: String,
    pub base_kwargs: Kwargs,
    /// Vertex AI: full model resource URL (`…/publishers/google/models/{m}`);
    /// `None` = Gemini Developer API (`{base}/models/{m}`).
    pub model_path: Option<String>,
    api_key: String,
    client: reqwest::Client,
}

impl GoogleGenAiProvider {
    pub fn new(api_key: &str, model: &str, base_url: &str, model_kwargs: Kwargs) -> ProviderResult<Self> {
        if api_key.is_empty() {
            return Err(ProviderError::Invalid("Google API key is required. Provide it or set GOOGLE_API_KEY.".into()));
        }
        Ok(Self {
            model: model.into(),
            provider_name: None,
            base_url: base_url.trim_end_matches('/').into(),
            base_kwargs: model_kwargs,
            model_path: None,
            api_key: api_key.into(),
            client: shared_client(),
        })
    }

    /// v2 `VertexAIProvider` (express mode without project, normal mode with).
    pub fn vertex(key: &str, model: &str, project: Option<&str>, location: &str, model_kwargs: Kwargs) -> ProviderResult<Self> {
        if key.is_empty() {
            return Err(ProviderError::Invalid("Vertex AI API key is required. Provide it or set VERTEXAI_API_KEY.".into()));
        }
        let project = project.filter(|p| !p.is_empty());
        let base_url = match project {
            Some(_) if location != "global" => format!("https://{location}-aiplatform.googleapis.com/v1"),
            _ => "https://aiplatform.googleapis.com/v1".to_string(),
        };
        let model_path = match project {
            Some(p) => format!("{base_url}/projects/{p}/locations/{location}/publishers/google/models/{model}"),
            None => format!("{base_url}/publishers/google/models/{model}"),
        };
        let mut p = Self::new(key, model, &base_url, model_kwargs)?;
        p.model_path = Some(model_path);
        Ok(p)
    }

    pub fn build_request(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kw: &Kwargs) -> Value {
        let (contents, system) = convert_messages(messages);
        let gtools = convert_tools(tools);
        let mut body = Map::new();
        body.insert("contents".into(), Value::Array(contents));
        if let Some(s) = system {
            body.insert("systemInstruction".into(), s);
        }
        let level = kw.get("thinking_level");
        let mut gc = Map::new();
        if let Some(mt) = kw.get("max_tokens").filter(|v| !v.is_null()) {
            gc.insert("maxOutputTokens".into(), mt.clone());
        }
        let no_thinking = level.and_then(|v| v.as_str()) == Some("none") || self.model.to_lowercase().contains("gemma");
        if !no_thinking {
            let mut tc = Map::new();
            tc.insert("includeThoughts".into(), json!(true));
            if let Some(l) = level.filter(|v| !v.is_null()) {
                tc.insert("thinkingLevel".into(), l.clone());
            }
            gc.insert("thinkingConfig".into(), Value::Object(tc));
        }
        body.insert("generationConfig".into(), Value::Object(gc));
        let has_tools = gtools.is_some();
        if let Some(t) = gtools {
            body.insert("tools".into(), json!(t));
        }
        if has_tools && kw_str(kw, "tool_choice") == Some("none") {
            body.insert("toolConfig".into(), json!({"functionCallingConfig": {"mode": "NONE"}}));
        }
        if let Some(tier) = kw.get("service_tier").filter(|v| !v.is_null()) {
            let t = if tier == "fast" { json!("priority") } else { tier.clone() };
            body.insert("serviceTier".into(), t);
        }
        Value::Object(body)
    }

    fn url(&self, method: &str) -> String {
        match &self.model_path {
            Some(p) => format!("{p}:{method}"),
            None => format!("{}/models/{}:{}", self.base_url, self.model, method),
        }
    }

    fn usage_of(meta: &Value) -> Usage {
        let i = |k: &str| meta.get(k).and_then(|v| v.as_i64());
        Usage {
            prompt_tokens: i("promptTokenCount").unwrap_or(0),
            completion_tokens: i("candidatesTokenCount").unwrap_or(0),
            total_tokens: i("totalTokenCount").unwrap_or(0),
            cached_tokens: i("cachedContentTokenCount"),
            thoughts_tokens: i("thoughtsTokenCount"),
            tool_use_tokens: i("toolUsePromptTokenCount"),
            ..Default::default()
        }
    }
}

#[async_trait]
impl LlmProvider for GoogleGenAiProvider {
    fn model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> Option<&str> {
        self.provider_name.as_deref()
    }
    fn support_interrupt(&self) -> bool {
        false
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.base_kwargs
    }

    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        let merged = self.merged_kwargs(kwargs);
        let body = self.build_request(messages, tools, &merged);
        let req = self.client.post(self.url("generateContent")).header("x-goog-api-key", &self.api_key).timeout(Duration::from_secs(120)).json(&body);
        let data: Value = sse::send_checked(req, "gemini_api").await?.json().await.map_err(ProviderError::from_reqwest)?;
        let Some(cand) = data.get("candidates").and_then(|c| c.as_array()).and_then(|c| c.first()) else {
            return Err(ProviderError::Other("Gemini API response contained no candidates".into()));
        };
        let (mut content, mut reasoning, mut sig) = (String::new(), String::new(), String::new());
        let mut tcs = vec![];
        for p in cand.pointer("/content/parts").and_then(|v| v.as_array()).into_iter().flatten() {
            if p.get("thought").and_then(|v| v.as_bool()).unwrap_or(false) {
                reasoning.push_str(p.get("text").and_then(|v| v.as_str()).unwrap_or(""));
                sig.push_str(p.get("thoughtSignature").and_then(|v| v.as_str()).unwrap_or(""));
            } else if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                content.push_str(t);
            }
            if let Some(fc) = p.get("functionCall") {
                let name = fc["name"].as_str().unwrap_or("");
                let id = fc.get("id").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| format!("call_{name}_{}", now_ts()));
                let mut tc = ToolCall::new(id, name, function_call_args(fc));
                tc.function.thought_signature = p.get("thoughtSignature").and_then(|v| v.as_str()).map(String::from);
                tcs.push(tc);
            }
        }
        let mut extra = Map::new();
        if let Some(meta) = data.get("usageMetadata").filter(|m| m.is_object()) {
            extra.insert("usage".into(), usage_to_dict(&Self::usage_of(meta), self.cost_model_id().as_deref()));
        }
        if !sig.is_empty() {
            extra.insert("reasoning_signature".into(), json!(sig));
        }
        let mut a = AssistantMessage {
            content: Some(content).filter(|s| !s.is_empty()),
            reasoning_content: Some(reasoning).filter(|s| !s.is_empty()),
            reasoning_signature: Some(sig).filter(|s| !s.is_empty()),
            tool_calls: if tcs.is_empty() { None } else { Some(tcs) },
            ..Default::default()
        };
        a.meta.extra = if extra.is_empty() { None } else { Some(extra) };
        Ok(a)
    }

    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        let merged = self.merged_kwargs(kwargs);
        let body = self.build_request(messages, tools, &merged);
        let req = self.client.post(format!("{}?alt=sse", self.url("streamGenerateContent"))).header("x-goog-api-key", &self.api_key).json(&body);
        let resp = sse::send_stream(req, Some(Duration::from_secs(120)), "gemini_api").await?;
        let model = self.model.clone();
        let events = sse::data_json(resp, None, false);
        let s = async_stream::stream! {
            futures::pin_mut!(events);
            let mut idx_by_id: HashMap<String, i64> = HashMap::new();
            let mut emitted: HashSet<String> = HashSet::new();
            while let Some(ev) = events.next().await {
                let data = match ev { Ok(d) => d, Err(e) => { yield Err(e); return; } };
                let Some(cand) = data.get("candidates").and_then(|c| c.as_array()).and_then(|c| c.first()).cloned() else { continue };
                let (mut dc, mut dr, mut ds) = (String::new(), String::new(), String::new());
                let mut dtc = vec![];
                for p in cand.pointer("/content/parts").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                    if p.get("thought").and_then(|v| v.as_bool()).unwrap_or(false) {
                        if let Some(t) = p.get("text").and_then(|v| v.as_str()) { dr.push_str(t); }
                        if let Some(t) = p.get("thoughtSignature").and_then(|v| v.as_str()) { ds.push_str(t); }
                    } else if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                        dc.push_str(t);
                    }
                    if let Some(fc) = p.get("functionCall") {
                        let name = fc["name"].as_str().unwrap_or("").to_string();
                        let id = fc.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| format!("call_{name}_{}", now_ts()));
                        let n = idx_by_id.len() as i64;
                        let idx = *idx_by_id.entry(id.clone()).or_insert(n);
                        let first = emitted.insert(id.clone());
                        dtc.push(ToolCallDelta { index: Some(idx), id: Some(id), function: Some(FunctionCallDelta {
                            name: if first { Some(name) } else { None },
                            arguments: if first { Some(function_call_args(fc)) } else { None },
                            thought_signature: p.get("thoughtSignature").and_then(|v| v.as_str()).map(String::from),
                            ..Default::default()
                        }) });
                    }
                }
                let usage = data.get("usageMetadata").filter(|m| m.is_object()).map(GoogleGenAiProvider::usage_of);
                let delta = ChatCompletionDelta {
                    content: Some(dc).filter(|s| !s.is_empty()),
                    reasoning_content: Some(dr).filter(|s| !s.is_empty()),
                    reasoning_signature: Some(ds).filter(|s| !s.is_empty()),
                    tool_calls: if dtc.is_empty() { None } else { Some(dtc) },
                    ..Default::default()
                };
                let fr = cand.get("finishReason").and_then(|v| v.as_str()).map(String::from);
                yield Ok(ChatCompletionChunk::delta("gemini-stream", &model, delta, fr, usage));
            }
        };
        Ok(Box::pin(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn function_call_args_are_compact_utf8() {
        assert_eq!(function_call_args(&json!({"name": "search", "args": {"q": "Tiếng Việt", "k": [1, 2]}})), r#"{"q":"Tiếng Việt","k":[1,2]}"#);
        assert_eq!(function_call_args(&json!({"name": "search"})), "{}");
    }

    #[test]
    fn nested_free_form_objects_become_json_strings() {
        let s = json!({"type": "object", "additionalProperties": false, "properties": {
            "arguments": {"type": "object", "default": null, "description": "Tool arguments."},
            "opts": {"type": "object", "properties": {"x": {"type": "string"}}},
            "list": {"type": "array", "items": {"type": "object"}},
        }});
        assert_eq!(
            sanitize_schema(&s),
            json!({"type": "object", "properties": {
                "arguments": {"type": "string", "description": "Tool arguments. Pass a JSON object encoded as a string."},
                "opts": {"type": "object", "properties": {"x": {"type": "string"}}},
                "list": {"type": "array", "items": {"type": "string", "description": "Pass a JSON object encoded as a string."}},
            }})
        );
        // The root object keeps its (empty) shape.
        assert_eq!(sanitize_schema(&json!({"type": "object", "properties": {}})), json!({"type": "object", "properties": {}}));
    }

    #[test]
    fn vertex_urls_match_v2() {
        let e = GoogleGenAiProvider::vertex("k", "gemini-3", None, "global", Kwargs::new()).unwrap();
        assert_eq!(e.url("generateContent"), "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3:generateContent");
        let g = GoogleGenAiProvider::vertex("k", "gemini-3", Some("p1"), "global", Kwargs::new()).unwrap();
        assert_eq!(g.url("x"), "https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-3:x");
        let r = GoogleGenAiProvider::vertex("k", "gemini-3", Some("p1"), "us-central1", Kwargs::new()).unwrap();
        assert_eq!(r.url("x"), "https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3:x");
    }

    #[test]
    fn normalizes_turn_alternation() {
        let msgs = vec![
            ChatMessage::user("a"),
            ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("call_x", "t", "{}")]), ..Default::default() }),
            ChatMessage::tool("call_x", Some("t".into()), "{\"ok\": 1}"),
            ChatMessage::user("next"),
        ];
        let (c, _) = convert_messages(&msgs);
        let roles: Vec<&str> = c.iter().map(|x| x["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["user", "model", "user", "model", "user"]);
        assert_eq!(c[3]["parts"][0]["text"], "Understood.");
        assert!(c[1]["parts"][0]["functionCall"].get("id").is_none());
        assert_eq!(c[2]["parts"][0]["functionResponse"]["response"], json!({"ok": 1}));
    }
}
