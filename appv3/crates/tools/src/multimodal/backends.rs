//! Provider backends (`multimodalities/backends/*`). Every entry point
//! returns the payload bytes or a user-facing `Error: ...` string.

use super::{api_key, endpoints, py_b64decode, py_repr, take_chars, MediaSection};
use serde_json::{json, Map, Value};
use std::time::Duration;

pub type Overrides = Vec<(String, String)>;
pub type Named = (String, Vec<u8>);

fn client(timeout: Duration, follow: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(timeout)
        .read_timeout(timeout)
        .redirect(if follow { reqwest::redirect::Policy::limited(20) } else { reqwest::redirect::Policy::none() })
        .build()
        .unwrap_or_default()
}

fn b64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn guess(name: &str) -> Option<String> {
    appv3_core::mimetypes::guess_type(name)
}

/// Response JSON → value, with Python `json` error text.
fn parse_json(body: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(body).map_err(|e| crate::py_json_error(&e))
}

/// `str(KeyError(k))`.
fn key_error(k: &str) -> String {
    crate::py_repr_str(k)
}

/// Merge YAML string extras with truthy overrides for `keys` (overrides win).
fn merge_extras(cfg: &MediaSection, overrides: Option<&Overrides>, keys: &[&str], require_truthy_yaml: bool) -> Map<String, Value> {
    let mut out = Map::new();
    for k in keys {
        if let Some(v) = cfg.extra_str(k) {
            if !require_truthy_yaml || !v.is_empty() {
                out.insert((*k).into(), json!(v));
            }
        }
    }
    for (k, v) in overrides.into_iter().flatten() {
        if keys.contains(&k.as_str()) && !v.is_empty() {
            out.insert(k.clone(), json!(v));
        }
    }
    out
}

// ── OpenAI Images ───────────────────────────────────────────────────────────

const OPENAI_TIMEOUT: Duration = Duration::from_secs(120);
const OPENAI_MAX_EDIT: usize = 16;
const OPENAI_KEYS: [&str; 3] = ["size", "quality", "output_format"];

fn openai_missing_key() -> String {
    "Error: OPENAI_API_KEY is unset — cannot call OpenAI Images API. Set it in .env or the environment.".into()
}

async fn openai_decode(resp: reqwest::Response) -> Result<Vec<u8>, String> {
    let status = resp.status().as_u16();
    let body = resp.bytes().await.unwrap_or_default();
    if status != 200 {
        let text = take_chars(&String::from_utf8_lossy(&body), 400);
        tracing::warn!("openai_image_api_error status={} body={}", status, text);
        return Err(format!("Error: OpenAI Images API returned {status}: {text}"));
    }
    let shape = || -> Result<Value, String> {
        let data = parse_json(&body)?;
        let list = data.get("data").ok_or_else(|| key_error("data"))?;
        let first = match list {
            Value::Array(a) => a.first().ok_or("list index out of range")?,
            Value::Object(o) => o.get("0").ok_or("0")?,
            _ => return Err("0".into()),
        };
        first.get("b64_json").cloned().ok_or_else(|| key_error("b64_json"))
    };
    let b64v = match shape() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("openai_image_bad_response err={}", e);
            return Err(format!("Error: unexpected OpenAI response shape: {e}"));
        }
    };
    decode_b64_value(&b64v)
}

fn decode_b64_value(v: &Value) -> Result<Vec<u8>, String> {
    let Some(s) = v.as_str() else {
        return Err(format!("Error: could not decode base64 image payload: argument should be a bytes-like object or ASCII string, not '{}'", py_type(v)));
    };
    py_b64decode(s).map_err(|e| format!("Error: could not decode base64 image payload: {e}"))
}

fn py_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

pub async fn generate_openai(cfg: &MediaSection, prompt: &str, overrides: Option<&Overrides>) -> Result<Vec<u8>, String> {
    let key = api_key("OPENAI_API_KEY");
    if key.is_empty() {
        return Err(openai_missing_key());
    }
    let mut payload = Map::new();
    payload.insert("model".into(), json!(cfg.model));
    payload.insert("prompt".into(), json!(prompt));
    payload.insert("n".into(), json!(1));
    payload.extend(merge_extras(cfg, overrides, &OPENAI_KEYS, false));
    let resp = client(OPENAI_TIMEOUT, false)
        .post(endpoints().openai_generate)
        .header("Authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&Value::Object(payload)).unwrap_or_default())
        .send()
        .await;
    match resp {
        Ok(r) => openai_decode(r).await,
        Err(e) => {
            tracing::warn!("openai_generate_http_error err={}", e);
            Err(format!("Error: network failure calling OpenAI Images: {e}"))
        }
    }
}

pub async fn edit_openai(cfg: &MediaSection, prompt: &str, images: &[Named], overrides: Option<&Overrides>) -> Result<Vec<u8>, String> {
    if images.is_empty() {
        return Err("Error: edit requires at least one input image.".into());
    }
    if images.len() > OPENAI_MAX_EDIT {
        return Err(format!("Error: OpenAI edit supports up to {OPENAI_MAX_EDIT} input images ({} provided).", images.len()));
    }
    let key = api_key("OPENAI_API_KEY");
    if key.is_empty() {
        return Err(openai_missing_key());
    }
    let mut fields: Vec<(String, String)> = vec![("model".into(), cfg.model.clone()), ("prompt".into(), prompt.to_string()), ("n".into(), "1".into())];
    for (k, v) in merge_extras(cfg, overrides, &OPENAI_KEYS, false) {
        let v = v.as_str().unwrap_or("").to_string();
        match fields.iter_mut().find(|(n, _)| *n == k) {
            Some(f) => f.1 = v,
            None => fields.push((k, v)),
        }
    }
    let files: Vec<(String, String, &[u8])> =
        images.iter().map(|(name, blob)| (name.clone(), guess(name).unwrap_or_else(|| "application/octet-stream".into()), blob.as_slice())).collect();
    let (ctype, body) = multipart_body(&fields, "image[]", &files);
    let resp = client(OPENAI_TIMEOUT, false).post(endpoints().openai_edit).header("Authorization", format!("Bearer {key}")).header("content-type", ctype).body(body).send().await;
    match resp {
        Ok(r) => openai_decode(r).await,
        Err(e) => {
            tracing::warn!("openai_edit_http_error err={}", e);
            Err(format!("Error: network failure calling OpenAI Images edit: {e}"))
        }
    }
}

/// httpx `_format_form_param` escaping for names / filenames.
fn form_param(v: &str) -> String {
    let mut out = String::new();
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("%22"),
            c if (c as u32) < 0x20 && c as u32 != 0x1b => out.push_str(&format!("%{:02X}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// httpx multipart encoding: data fields first, then file parts.
fn multipart_body(fields: &[(String, String)], file_field: &str, files: &[(String, String, &[u8])]) -> (String, Vec<u8>) {
    let boundary: String = appv3_providers::plugin::random_bytes(16).iter().map(|b| format!("{b:02x}")).collect();
    let mut body = vec![];
    for (k, v) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n", form_param(k)).as_bytes());
        body.extend_from_slice(v.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    for (name, ctype, blob) in files {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {ctype}\r\n\r\n", form_param(file_field), form_param(name))
                .as_bytes(),
        );
        body.extend_from_slice(blob);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

// ── Codex (ChatGPT subscription) ────────────────────────────────────────────

const CODEX_TIMEOUT: Duration = Duration::from_secs(180);
const CODEX_KEYS: [&str; 4] = ["size", "quality", "background", "output_format"];

async fn codex_auth() -> Result<(String, Option<String>), String> {
    use appv3_providers::codex::{oauth_path, CodexAuth};
    let path = oauth_path();
    let Some(mut auth) = CodexAuth::load(&path) else {
        return Err("Error: Codex OAuth credentials not found. Run `agentd auth codex` to authenticate with your ChatGPT account.".into());
    };
    if auth.is_expired() {
        tracing::info!("codex_image_token_expired refreshing");
        auth = auth.refresh(&path).await.map_err(|e| {
            tracing::warn!("codex_image_token_refresh_failed err={}", e);
            format!("Error: Codex token refresh failed: {e}. Run `agentd auth codex` to re-authenticate.")
        })?;
    }
    Ok((auth.access_token, auth.account_id))
}

/// `_build_request_body`.
pub fn codex_request_body(cfg: &MediaSection, prompt: &str, ref_urls: &[String], overrides: Option<&Overrides>) -> Value {
    let mut content = vec![];
    for (i, url) in ref_urls.iter().enumerate() {
        content.push(json!({"type": "input_text", "text": format!("<image name=image{}>", i + 1)}));
        content.push(json!({"type": "input_image", "image_url": url, "detail": "high"}));
        content.push(json!({"type": "input_text", "text": "</image>"}));
    }
    content.push(json!({"type": "input_text", "text": prompt}));
    let merged = merge_extras(cfg, overrides, &CODEX_KEYS, true);
    let mut tool = Map::new();
    tool.insert("type".into(), json!("image_generation"));
    tool.insert("output_format".into(), json!(merged.get("output_format").and_then(|v| v.as_str()).unwrap_or("png").to_lowercase()));
    for k in ["size", "quality", "background"] {
        if let Some(v) = merged.get(k) {
            tool.insert(k.into(), v.clone());
        }
    }
    json!({
        "model": cfg.model,
        "instructions": "",
        "input": [{"type": "message", "role": "user", "content": content}],
        "tools": [Value::Object(tool)],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "prompt_cache_key": uuid::Uuid::new_v4().to_string(),
        "stream": true,
        "store": false,
        "reasoning": null,
    })
}

fn data_url(name: &str, blob: &[u8]) -> String {
    let mime = guess(name).filter(|m| m.starts_with("image/")).unwrap_or_else(|| "image/png".into());
    format!("data:{mime};base64,{}", b64(blob))
}

/// `_parse_sse_image` over already-decoded stream text chunks.
#[derive(Default)]
pub struct CodexSse {
    buffer: String,
    image_b64: Option<String>,
    last_event: Option<String>,
}

impl CodexSse {
    pub fn feed(&mut self, chunk: &str) {
        self.buffer.push_str(chunk);
        while let Some(pos) = self.buffer.find("\n\n") {
            let block = self.buffer[..pos].to_string();
            self.buffer.drain(..pos + 2);
            let mut event: Option<String> = None;
            let mut data = String::new();
            for line in block.split('\n') {
                if let Some(e) = line.strip_prefix("event:") {
                    event = Some(py_strip(e));
                } else if let Some(d) = line.strip_prefix("data:") {
                    data.push_str(&py_strip(d));
                }
            }
            let Some(event) = event.filter(|e| !e.is_empty()) else {
                continue;
            };
            if self.last_event.as_deref() != Some(event.as_str()) {
                tracing::debug!("codex_image_progress event={}", event);
                self.last_event = Some(event.clone());
            }
            if event == "response.output_item.done" && !data.is_empty() {
                let Ok(v) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                let item = v.get("item").filter(|i| super::py_truthy(i)).cloned().unwrap_or(json!({}));
                if item.get("type").and_then(|t| t.as_str()) == Some("image_generation_call") {
                    if let Some(r) = item.get("result").filter(|r| super::py_truthy(r)) {
                        self.image_b64 = Some(r.as_str().map(String::from).unwrap_or_else(|| r.to_string()));
                    }
                }
            }
        }
    }

    pub fn finish(self) -> Result<Vec<u8>, String> {
        let Some(b) = self.image_b64 else {
            return Err("Error: Codex did not return an image. Account may not be entitled (Plus/Pro required for image generation).".into());
        };
        py_b64decode(&b).map_err(|e| format!("Error: could not decode base64 image payload: {e}"))
    }
}

fn py_strip(s: &str) -> String {
    super::py_strip(s)
}

async fn codex_post(body: Value, token: &str, account_id: Option<&str>) -> Result<Vec<u8>, String> {
    use futures::StreamExt;
    let resp = client(CODEX_TIMEOUT, false)
        .post(endpoints().codex_responses)
        .header("accept", "text/event-stream, application/json")
        .header("authorization", format!("Bearer {token}"))
        .header("chatgpt-account-id", account_id.unwrap_or(""))
        .header("content-type", "application/json")
        .header("originator", "codex_cli_rs")
        .header("session_id", uuid::Uuid::new_v4().to_string())
        .header("user-agent", "codex-imagen/0.2.6")
        .header("version", "0.122.0")
        .header("x-client-request-id", uuid::Uuid::new_v4().to_string())
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("codex_image_http_error err={}", e);
            return Err(format!("Error: network failure calling Codex Images: {e}"));
        }
    };
    let status = resp.status().as_u16();
    if status != 200 {
        let text = resp.bytes().await.map(|b| take_chars(&String::from_utf8_lossy(&b), 400)).unwrap_or_default();
        tracing::warn!("codex_image_api_error status={} body={}", status, text);
        return Err(format!("Error: Codex Images API returned {status}: {text}"));
    }
    let mut sse = CodexSse::default();
    let mut stream = resp.bytes_stream();
    let mut pending: Vec<u8> = vec![];
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                pending.extend_from_slice(&c);
                // Decode complete UTF-8 prefixes only (`aiter_text`).
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    Err(_) => pending.len(),
                };
                let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                sse.feed(&text);
            }
            Err(e) => {
                tracing::warn!("codex_image_stream_error err={}", e);
                return Err(format!("Error: Codex stream interrupted: {e}"));
            }
        }
    }
    if !pending.is_empty() {
        sse.feed(&String::from_utf8_lossy(&pending));
    }
    sse.finish()
}

pub async fn generate_codex(cfg: &MediaSection, prompt: &str, overrides: Option<&Overrides>) -> Result<Vec<u8>, String> {
    let (token, account) = codex_auth().await?;
    codex_post(codex_request_body(cfg, prompt, &[], overrides), &token, account.as_deref()).await
}

pub async fn edit_codex(cfg: &MediaSection, prompt: &str, images: &[Named], overrides: Option<&Overrides>) -> Result<Vec<u8>, String> {
    if images.is_empty() {
        return Err("Error: edit requires at least one input image.".into());
    }
    let (token, account) = codex_auth().await?;
    let urls: Vec<String> = images.iter().map(|(n, b)| data_url(n, b)).collect();
    codex_post(codex_request_body(cfg, prompt, &urls, overrides), &token, account.as_deref()).await
}

// ── Google GenAI (Gemini) images ────────────────────────────────────────────

const GEMINI_TIMEOUT: Duration = Duration::from_secs(120);
const GEMINI_MAX_EDIT: usize = 14;

fn gemini_missing_key() -> String {
    "Error: GOOGLE_API_KEY is unset — cannot call Gemini Images API. Set it in .env or the environment.".into()
}

fn gemini_generation_config(cfg: &MediaSection, overrides: Option<&Overrides>) -> Value {
    let mut img = Map::new();
    for (snake, camel) in [("aspect_ratio", "aspectRatio"), ("image_size", "imageSize")] {
        if let Some(v) = cfg.extra_str(snake).filter(|v| !v.is_empty()) {
            img.insert(camel.into(), json!(v));
        }
    }
    for (k, v) in overrides.into_iter().flatten() {
        let camel = match k.as_str() {
            "aspect_ratio" => "aspectRatio",
            "image_size" => "imageSize",
            _ => continue,
        };
        if !v.is_empty() {
            img.insert(camel.into(), json!(v));
        }
    }
    let mut g = Map::new();
    g.insert("responseModalities".into(), json!(["TEXT", "IMAGE"]));
    if !img.is_empty() {
        g.insert("imageConfig".into(), Value::Object(img));
    }
    Value::Object(g)
}

async fn gemini_decode(resp: reqwest::Response) -> Result<Vec<u8>, String> {
    let status = resp.status().as_u16();
    let body = resp.bytes().await.unwrap_or_default();
    if status != 200 {
        let text = take_chars(&String::from_utf8_lossy(&body), 400);
        tracing::warn!("gemini_image_api_error status={} body={}", status, text);
        return Err(format!("Error: Gemini Images API returned {status}: {text}"));
    }
    let data = match parse_json(&body) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("gemini_image_bad_response err={}", e);
            return Err(format!("Error: unexpected Gemini response shape: {e}"));
        }
    };
    let candidates = data.get("candidates").filter(|c| super::py_truthy(c)).cloned().unwrap_or(json!([]));
    let Some(first) = candidates.as_array().and_then(|a| a.first()) else {
        return Err("Error: Gemini response had no candidates.".into());
    };
    let parts = first.get("content").and_then(|c| c.get("parts")).filter(|p| super::py_truthy(p)).and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let mut text = String::new();
    let mut image: Option<String> = None;
    for part in &parts {
        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            text.push_str(t);
        }
        let Some(inline) = part.get("inline_data").filter(|v| super::py_truthy(v)).or_else(|| part.get("inlineData").filter(|v| super::py_truthy(v))) else {
            continue;
        };
        let mime = inline.get("mime_type").and_then(|m| m.as_str()).filter(|m| !m.is_empty()).or_else(|| inline.get("mimeType").and_then(|m| m.as_str())).unwrap_or("");
        if !mime.starts_with("image/") {
            continue;
        }
        if let Some(d) = inline.get("data").and_then(|d| d.as_str()).filter(|d| !d.is_empty()) {
            image = Some(d.to_string());
            break;
        }
    }
    let Some(image) = image else {
        if !text.is_empty() {
            tracing::info!("gemini_image_text_only text={}", take_chars(&text, 200));
        }
        return Err("Error: Gemini response had no image part.".into());
    };
    py_b64decode(&image).map_err(|e| format!("Error: could not decode base64 image payload: {e}"))
}

async fn gemini_post(model: &str, payload: Value, net_label: &str) -> Result<Vec<u8>, String> {
    let key = api_key("GOOGLE_API_KEY");
    let resp = client(GEMINI_TIMEOUT, false)
        .post(format!("{}/{model}:generateContent", endpoints().gemini_models))
        .header("x-goog-api-key", key)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&payload).unwrap_or_default())
        .send()
        .await;
    match resp {
        Ok(r) => gemini_decode(r).await,
        Err(e) => {
            tracing::warn!("gemini_{}_http_error err={}", if net_label.ends_with("edit") { "edit" } else { "generate" }, e);
            Err(format!("Error: network failure calling {net_label}: {e}"))
        }
    }
}

pub async fn generate_googlegenai(cfg: &MediaSection, prompt: &str, overrides: Option<&Overrides>) -> Result<Vec<u8>, String> {
    if api_key("GOOGLE_API_KEY").is_empty() {
        return Err(gemini_missing_key());
    }
    let payload = json!({"contents": [{"parts": [{"text": prompt}]}], "generationConfig": gemini_generation_config(cfg, overrides)});
    gemini_post(&cfg.model, payload, "Gemini Images").await
}

pub async fn edit_googlegenai(cfg: &MediaSection, prompt: &str, images: &[Named], overrides: Option<&Overrides>) -> Result<Vec<u8>, String> {
    if images.is_empty() {
        return Err("Error: edit requires at least one input image.".into());
    }
    if images.len() > GEMINI_MAX_EDIT {
        return Err(format!("Error: Gemini edit supports up to {GEMINI_MAX_EDIT} input images ({} provided).", images.len()));
    }
    if api_key("GOOGLE_API_KEY").is_empty() {
        return Err(gemini_missing_key());
    }
    let mut parts = vec![json!({"text": prompt})];
    for (name, blob) in images {
        parts.push(json!({"inline_data": {"mime_type": guess(name).unwrap_or_else(|| "application/octet-stream".into()), "data": b64(blob)}}));
    }
    let payload = json!({"contents": [{"parts": parts}], "generationConfig": gemini_generation_config(cfg, overrides)});
    gemini_post(&cfg.model, payload, "Gemini Images edit").await
}

/// httpx's URL validation errors (`UnsupportedProtocol`) for request URLs.
fn httpx_url_error(url: &str) -> Option<String> {
    let scheme = url.split_once("://").map(|(s, _)| s.to_lowercase());
    match scheme.as_deref() {
        Some("http" | "https") => None,
        Some(s) if !s.is_empty() && !s.contains(['/', '?', '#']) => Some(format!("Request URL has an unsupported protocol '{s}://'.")),
        _ => Some("Request URL is missing an 'http://' or 'https://' protocol.".into()),
    }
}

// ── Google GenAI (Veo) video ────────────────────────────────────────────────

const VEO_TIMEOUT: Duration = Duration::from_secs(60);
const VEO_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const VEO_MAX_REFS: usize = 3;
const VEO_PARAMS: [(&str, &str); 6] = [
    ("aspect_ratio", "aspectRatio"),
    ("resolution", "resolution"),
    ("duration_seconds", "durationSeconds"),
    ("person_generation", "personGeneration"),
    ("negative_prompt", "negativePrompt"),
    ("seed", "seed"),
];

/// Python `int(s)` for a string (whitespace, sign, single underscores).
fn py_int(s: &str) -> Option<i64> {
    let t = super::py_strip(s);
    let (sign, digits) = match t.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, t.strip_prefix('+').unwrap_or(&t)),
    };
    if digits.is_empty() || digits.starts_with('_') || digits.ends_with('_') || digits.contains("__") || !digits.chars().all(|c| c.is_ascii_digit() || c == '_') {
        return None;
    }
    digits.replace('_', "").parse::<i64>().ok().map(|n| sign * n)
}

/// Python `float(s)` for a string.
fn py_float(s: &str) -> Option<f64> {
    let t = super::py_strip(s);
    let low = t.to_lowercase();
    let body = low.trim_start_matches(['+', '-']);
    if matches!(body, "inf" | "infinity" | "nan") {
        return None; // `json.dumps(allow_nan=False)` would reject these anyway
    }
    if t.contains("__") || t.starts_with('_') || t.ends_with('_') {
        return None;
    }
    t.replace('_', "").parse::<f64>().ok().filter(|f| f.is_finite())
}

fn coerce_param(camel: &str, v: &Value) -> Value {
    if !matches!(camel, "durationSeconds" | "seed") {
        return v.clone();
    }
    match v {
        Value::String(s) => py_int(s).map(|i| json!(i)).or_else(|| py_float(s).and_then(serde_json::Number::from_f64).map(Value::Number)).unwrap_or_else(|| v.clone()),
        _ => v.clone(),
    }
}

/// `_build_parameters`.
pub fn veo_parameters(cfg: &MediaSection, overrides: Option<&Overrides>) -> Map<String, Value> {
    let mut out = Map::new();
    for (snake, camel) in VEO_PARAMS {
        match cfg.extras.get(snake) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) if s.is_empty() => continue,
            Some(v) => {
                out.insert(camel.into(), coerce_param(camel, v));
            }
        }
    }
    for (k, v) in overrides.into_iter().flatten() {
        if let Some((_, camel)) = VEO_PARAMS.iter().find(|(s, _)| s == k) {
            if !v.is_empty() {
                out.insert((*camel).into(), coerce_param(camel, &json!(v)));
            }
        }
    }
    out
}

fn inline_image(name: &str, blob: &[u8]) -> Value {
    json!({"bytesBase64Encoded": b64(blob), "mimeType": guess(name).unwrap_or_else(|| "application/octet-stream".into())})
}

/// `_build_instance`.
pub fn veo_instance(prompt: &str, image: Option<&Named>, last_frame: Option<&Named>, refs: Option<&[Named]>, extend: Option<&str>) -> Value {
    let mut inst = Map::new();
    inst.insert("prompt".into(), json!(prompt));
    if let Some((n, b)) = image {
        inst.insert("image".into(), inline_image(n, b));
    }
    if let Some((n, b)) = last_frame {
        inst.insert("lastFrame".into(), inline_image(n, b));
    }
    if let Some(r) = refs.filter(|r| !r.is_empty()) {
        inst.insert("referenceImages".into(), Value::Array(r.iter().map(|(n, b)| json!({"image": inline_image(n, b), "referenceType": "asset"})).collect()));
    }
    if let Some(u) = extend {
        inst.insert("video".into(), json!({"uri": u}));
    }
    Value::Object(inst)
}

/// `_extract_video_uri`.
fn veo_video_uri(v: &Value) -> Option<String> {
    let first = v.get("response")?.as_object()?.get("generateVideoResponse")?.as_object()?.get("generatedSamples")?.as_array()?.first()?.as_object()?;
    first.get("video")?.as_object()?.get("uri")?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

async fn veo_poll(http: &reqwest::Client, op: &str, key: &str) -> Result<Value, String> {
    let ep = endpoints();
    let url = format!("{}/{}", ep.gemini_base, op.trim_start_matches('/'));
    let deadline = tokio::time::Instant::now() + ep.veo_max_wait;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let resp = match http.get(&url).header("x-goog-api-key", key).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("veo_poll_http_error attempt={} err={}", attempt, e);
                return Err(format!("Error: network failure polling Veo operation: {e}"));
            }
        };
        let status = resp.status().as_u16();
        let body = resp.bytes().await.unwrap_or_default();
        if status != 200 {
            let text = take_chars(&String::from_utf8_lossy(&body), 400);
            tracing::warn!("veo_poll_api_error status={} body={}", status, text);
            return Err(format!("Error: Veo operation poll returned {status}: {text}"));
        }
        let data = parse_json(&body).map_err(|e| format!("Error: unexpected Veo operation response: {e}"))?;
        if data.get("done") == Some(&Value::Bool(true)) {
            if let Some(err) = data.get("error").filter(|e| e.is_object()) {
                let msg = err.get("message").filter(|m| super::py_truthy(m)).map(|m| m.as_str().map(String::from).unwrap_or_else(|| py_repr(m))).unwrap_or_else(|| py_repr(err));
                return Err(format!("Error: Veo operation failed: {msg}"));
            }
            return Ok(data);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("Error: Veo operation '{op}' did not complete within {}s.", ep.veo_max_wait.as_secs()));
        }
        tracing::debug!("veo_polling operation={} attempt={} interval={}s", op, attempt, ep.veo_poll_interval.as_secs_f64());
        tokio::time::sleep(ep.veo_poll_interval).await;
    }
}

pub struct VideoInputs<'a> {
    pub image: Option<&'a Named>,
    pub last_frame: Option<&'a Named>,
    pub reference_images: Option<&'a [Named]>,
    pub extend_video: Option<&'a str>,
}

/// Veo `generate` → `(mp4, files_api_uri)`.
pub async fn generate_video_googlegenai(cfg: &MediaSection, prompt: &str, inp: VideoInputs<'_>, overrides: Option<&Overrides>) -> Result<(Vec<u8>, String), String> {
    let key = api_key("GOOGLE_API_KEY");
    if key.is_empty() {
        return Err("Error: GOOGLE_API_KEY is unset — cannot call Gemini Veo API. Set it in .env or the environment.".into());
    }
    let refs = inp.reference_images.filter(|r| !r.is_empty());
    if let Some(r) = refs {
        if r.len() > VEO_MAX_REFS {
            return Err(format!("Error: Veo supports up to {VEO_MAX_REFS} reference images ({} provided).", r.len()));
        }
    }
    if inp.last_frame.is_some() && inp.image.is_none() {
        return Err("Error: last_frame requires a first-frame image (pass it as images[0]).".into());
    }
    if refs.is_some() && inp.last_frame.is_some() {
        return Err("Error: reference_images and last_frame are mutually exclusive on Veo.".into());
    }
    if inp.extend_video.is_some() && (inp.image.is_some() || inp.last_frame.is_some() || refs.is_some()) {
        return Err("Error: extend_video is mutually exclusive with image, last_frame, and reference_images.".into());
    }
    let instance = veo_instance(prompt, inp.image, inp.last_frame, inp.reference_images, inp.extend_video);
    let params = veo_parameters(cfg, overrides);
    let mut payload = Map::new();
    payload.insert("instances".into(), json!([instance]));
    if !params.is_empty() {
        payload.insert("parameters".into(), Value::Object(params.clone()));
    }
    let http = client(VEO_TIMEOUT, false);
    let ep = endpoints();
    let resp = http
        .post(format!("{}/models/{}:predictLongRunning", ep.gemini_base, cfg.model))
        .header("x-goog-api-key", &key)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&Value::Object(payload)).unwrap_or_default())
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("veo_start_http_error err={}", e);
            return Err(format!("Error: network failure calling Veo: {e}"));
        }
    };
    let status = resp.status().as_u16();
    let body = resp.bytes().await.unwrap_or_default();
    if status != 200 {
        let text = take_chars(&String::from_utf8_lossy(&body), 400);
        tracing::warn!("veo_start_api_error status={} body={}", status, text);
        return Err(format!("Error: Veo API returned {status}: {text}"));
    }
    let start = parse_json(&body).map_err(|e| format!("Error: unexpected Veo start response: {e}"))?;
    let Some(op) = start.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()).map(String::from) else {
        return Err("Error: Veo start response had no operation name.".into());
    };
    let params_repr = py_repr(&Value::Object(params));
    tracing::info!("veo_operation_started operation={} model={} params={}", op, cfg.model, params_repr);
    let done = veo_poll(&http, &op, &key).await?;
    let Some(uri) = veo_video_uri(&done) else {
        tracing::warn!("veo_no_video_uri final_keys={:?}", done.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default());
        return Err("Error: Veo operation completed but no video URI was returned.".into());
    };
    tracing::info!("veo_operation_complete operation={}", op);
    if let Some(msg) = httpx_url_error(&uri) {
        tracing::warn!("veo_download_http_error err={}", msg);
        return Err(format!("Error: network failure downloading Veo video: {msg}"));
    }
    let dl = match client(VEO_DOWNLOAD_TIMEOUT, true).get(&uri).header("x-goog-api-key", &key).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("veo_download_http_error err={}", e);
            return Err(format!("Error: network failure downloading Veo video: {e}"));
        }
    };
    let status = dl.status().as_u16();
    let bytes = match dl.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => return Err(format!("Error: network failure downloading Veo video: {e}")),
    };
    if status != 200 {
        let text = take_chars(&String::from_utf8_lossy(&bytes), 200);
        tracing::warn!("veo_download_api_error status={} body={}", status, text);
        return Err(format!("Error: Veo video download returned {status}: {text}"));
    }
    Ok((bytes, uri))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_sse_parse() {
        let mut s = CodexSse::default();
        s.feed("event: response.created\ndata: {}\n\nevent: response.output_item.done\ndata: {\"item\":{\"type\":\"image_generation_call\",\"result\":\"aGk=\"}}\n");
        s.feed("\n");
        assert_eq!(s.finish().unwrap(), b"hi");
        let mut s = CodexSse::default();
        s.feed("event: response.output_item.done\r\ndata: {\"item\":{\"type\":\"image_generation_call\",\"result\":\"aGk=\"}}\r\n\r\n");
        assert!(s.finish().is_err());
    }

    #[test]
    fn veo_params() {
        let mut extras = Map::new();
        extras.insert("duration_seconds".into(), json!("8"));
        extras.insert("seed".into(), json!(" 4_2 "));
        extras.insert("aspect_ratio".into(), json!("16:9"));
        extras.insert("negative_prompt".into(), json!(""));
        let cfg = MediaSection { provider: "googlegenai".into(), model: "veo".into(), extras };
        let p = veo_parameters(&cfg, Some(&vec![("resolution".into(), "1080p".into()), ("duration_seconds".into(), "6".into())]));
        assert_eq!(Value::Object(p).to_string(), r#"{"aspectRatio":"16:9","durationSeconds":6,"seed":42,"resolution":"1080p"}"#);
    }
}
