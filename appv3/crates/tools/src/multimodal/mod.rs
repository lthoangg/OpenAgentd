//! Multimodal generation tools — port of `app/agent/tools/multimodalities`
//! (`generate_image`, `generate_video`) and their provider backends.
//!
//! Config lives in `{CONFIG_DIR}/multimodal.yaml` and is read at call time.

pub mod backends;
pub mod image;
pub mod video;

use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

pub use image::GenerateImageTool;
pub use video::GenerateVideoTool;

/// Span + metrics bookkeeping shared by `generate_image` / `generate_video`
/// (v2 `_fail` / `_record_duration` / `_metrics.py`).
pub(crate) struct MediaObs {
    pub span: appv3_core::otel::Span,
    kind: &'static str,
    t0: std::time::Instant,
    /// `(provider, model, mode)` dimensions resolved so far.
    pub dims: Mutex<(Option<String>, Option<String>, Option<String>)>,
}

fn media_histograms(kind: &str) -> &'static (appv3_core::otel::Histogram, appv3_core::otel::Histogram) {
    use appv3_core::otel::histogram;
    static IMAGE: OnceLock<(appv3_core::otel::Histogram, appv3_core::otel::Histogram)> = OnceLock::new();
    static VIDEO: OnceLock<(appv3_core::otel::Histogram, appv3_core::otel::Histogram)> = OnceLock::new();
    if kind == "image" {
        IMAGE.get_or_init(|| {
            (
                histogram("openagentd.image.generation.duration", "generate_image tool duration (includes backend HTTP + disk write)", "s"),
                histogram("openagentd.image.output.bytes", "generate_image output file size (success only)", "By"),
            )
        })
    } else {
        VIDEO.get_or_init(|| {
            (
                histogram("openagentd.video.generation.duration", "generate_video tool duration (predictLongRunning + poll + download)", "s"),
                histogram("openagentd.video.output.bytes", "generate_video output file size (success only)", "By"),
            )
        })
    }
}

impl MediaObs {
    pub fn start(kind: &'static str) -> Self {
        let span = appv3_core::otel::Span::start(format!("generate_{kind}"), appv3_core::otel::SpanKind::Internal, vec![]);
        span.set_attr("gen_ai.operation.name", format!("generate_{kind}"));
        Self { span, kind, t0: std::time::Instant::now(), dims: Mutex::new((None, None, None)) }
    }

    pub fn set_provider(&self, provider: &str) {
        self.dims.lock().unwrap().0 = Some(provider.into());
    }
    pub fn set_model(&self, model: &str) {
        self.dims.lock().unwrap().1 = Some(model.into());
    }
    pub fn set_mode(&self, mode: &str) {
        self.dims.lock().unwrap().2 = Some(mode.into());
    }

    fn record_duration(&self, status: &str) {
        let (p, m, mode) = self.dims.lock().unwrap().clone();
        let unk = |v: Option<String>| serde_json::json!(v.unwrap_or_else(|| "unknown".into()));
        media_histograms(self.kind).0.record_in(
            Some(self.span.ctx()),
            self.t0.elapsed().as_secs_f64(),
            vec![
                ("gen_ai.provider.name", unk(p)),
                ("gen_ai.request.model", unk(m)),
                (if self.kind == "image" { "image.mode" } else { "video.mode" }, unk(mode)),
                ("status", serde_json::json!(status)),
            ],
        );
    }

    /// `_fail`: ERROR status + duration point; returns the framed text.
    pub fn fail(&self, error_type: &str, message: &str) -> crate::ToolResult {
        self.span.set_attr("error.type", error_type);
        self.span.set_attr("error.message", take_chars(message, 200));
        self.span.set_error();
        self.record_duration("error");
        Ok(crate::ToolOutput::text(format!("Error: {message}")))
    }

    /// Success tail: output bytes attr, OK, duration + size histograms.
    pub fn ok(&self, output_bytes: usize) {
        self.span.set_attr(&format!("{}.output_bytes", self.kind), output_bytes);
        self.span.set_ok();
        self.record_duration("ok");
        let (p, m, mode) = self.dims.lock().unwrap().clone();
        media_histograms(self.kind).1.record_in(
            Some(self.span.ctx()),
            output_bytes,
            vec![
                ("gen_ai.provider.name", serde_json::json!(p.unwrap_or_default())),
                ("gen_ai.request.model", serde_json::json!(m.unwrap_or_default())),
                (if self.kind == "image" { "image.mode" } else { "video.mode" }, serde_json::json!(mode.unwrap_or_default())),
            ],
        );
    }

    /// Close the span: an `Err` escaping the body is recorded like an
    /// exception leaving `start_as_current_span`.
    pub fn finish(self, res: crate::ToolResult) -> crate::ToolResult {
        match &res {
            Err(e) => self.span.exit_with_exception("PermissionError", &e.to_string()),
            Ok(_) => self.span.end(),
        }
        res
    }
}

/// Resolved config for one media kind (`MediaSectionConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct MediaSection {
    pub provider: String,
    pub model: String,
    pub extras: Map<String, Value>,
}

impl MediaSection {
    /// `cfg.extras.get(key)` when it is a string.
    pub fn extra_str(&self, key: &str) -> Option<&str> {
        self.extras.get(key).and_then(|v| v.as_str())
    }
}

pub fn config_path() -> PathBuf {
    appv3_core::settings().config_dir.join("multimodal.yaml")
}

type Cache = Option<((PathBuf, i128), Option<Map<String, Value>>)>;

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn py_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `_load_raw` — parse with an mtime-keyed cache; `None` when missing/invalid.
fn load_raw() -> Option<Map<String, Value>> {
    let path = config_path();
    let Ok(meta) = std::fs::metadata(&path) else {
        *cache().lock().unwrap() = Some(((path, 0), None));
        return None;
    };
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as i128).unwrap_or(0);
    let key = (path.clone(), mtime);
    if let Some((k, v)) = cache().lock().unwrap().as_ref() {
        if *k == key {
            return v.clone();
        }
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let data = match appv3_core::pyyaml::safe_load(&text) {
        Ok(v) if !py_truthy(&v) => Value::Object(Map::new()),
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("multimodal_yaml_invalid path={} err={}", path.display(), e);
            *cache().lock().unwrap() = Some((key, None));
            return None;
        }
    };
    let Value::Object(map) = data else {
        tracing::warn!("multimodal_yaml_not_mapping path={}", path.display());
        *cache().lock().unwrap() = Some((key, None));
        return None;
    };
    *cache().lock().unwrap() = Some((key, Some(map.clone())));
    Some(map)
}

/// `get_section(kind)`.
pub fn get_section(kind: &str) -> Option<MediaSection> {
    let raw = load_raw().filter(|m| !m.is_empty())?;
    let section = raw.get(kind)?.as_object()?;
    if section.contains_key("provider") {
        tracing::warn!("multimodal_section_legacy_shape kind={} hint='provider' key is no longer accepted — use 'model: <provider>:<name>' (e.g. 'openai:gpt-image-2')", kind);
        return None;
    }
    let Some(model_str) = section.get("model").and_then(|m| m.as_str()) else {
        tracing::warn!("multimodal_section_model_missing kind={}", kind);
        return None;
    };
    let Some((provider, name)) = model_str.split_once(':') else {
        tracing::warn!("multimodal_section_model_invalid kind={} model={} hint=expected 'provider:name' (e.g. 'openai:gpt-image-2')", kind, model_str);
        return None;
    };
    let (provider, name) = (py_strip(provider), py_strip(name));
    if provider.is_empty() || name.is_empty() {
        tracing::warn!("multimodal_section_model_invalid kind={} model={}", kind, model_str);
        return None;
    }
    let extras = section.iter().filter(|(k, _)| *k != "model").map(|(k, v)| (k.clone(), v.clone())).collect();
    Some(MediaSection { provider, model: name, extras })
}

/// Python `str.strip()` (whitespace per `str.isspace`).
fn py_strip(s: &str) -> String {
    s.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)).to_string()
}

// ── endpoints (overridable for differential tests) ──────────────────────────

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub openai_generate: String,
    pub openai_edit: String,
    pub codex_responses: String,
    /// `.../v1beta/models` (image `:generateContent`).
    pub gemini_models: String,
    /// `.../v1beta` (Veo `predictLongRunning` + operations).
    pub gemini_base: String,
    pub veo_poll_interval: Duration,
    pub veo_max_wait: Duration,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            openai_generate: "https://api.openai.com/v1/images/generations".into(),
            openai_edit: "https://api.openai.com/v1/images/edits".into(),
            codex_responses: "https://chatgpt.com/backend-api/codex/responses".into(),
            gemini_models: "https://generativelanguage.googleapis.com/v1beta/models".into(),
            gemini_base: "https://generativelanguage.googleapis.com/v1beta".into(),
            veo_poll_interval: Duration::from_secs(10),
            veo_max_wait: Duration::from_secs(600),
        }
    }
}

fn endpoints_lock() -> &'static RwLock<Endpoints> {
    static E: OnceLock<RwLock<Endpoints>> = OnceLock::new();
    E.get_or_init(Default::default)
}

pub fn endpoints() -> Endpoints {
    endpoints_lock().read().unwrap().clone()
}

pub fn set_endpoints(e: Endpoints) {
    *endpoints_lock().write().unwrap() = e;
}

// ── shared helpers ──────────────────────────────────────────────────────────

/// `_SAFE_NAME_RE` sanitiser (`_sanitise_filename`).
pub(crate) fn sanitise_filename(raw: Option<&str>, prefix: &str, ext: &str) -> String {
    let random = || format!("{prefix}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return format!("{}.{ext}", random());
    };
    let stem = raw.rsplit_once('.').map(|(a, _)| a).unwrap_or(raw);
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"[^a-zA-Z0-9_-]+").unwrap());
    let mut stem = re.replace_all(stem, "-").trim_matches('-').to_string();
    if stem.is_empty() {
        stem = random();
    }
    format!("{stem}.{ext}")
}

pub(crate) const MAX_INPUT_BYTES: u64 = 5 * 1024 * 1024;

/// Per-path sandbox resolution + read (`_load_input_image(s)`).
pub(crate) fn load_input_image(denied: &crate::DeniedPaths, raw: &str, empty_msg: &str) -> Result<(String, Vec<u8>), String> {
    if py_strip(raw).is_empty() {
        return Err(format!("Error: {empty_msg}"));
    }
    let resolved = denied.validate_path(raw).map_err(|e| format!("Error: input image '{raw}' rejected by sandbox: {e}"))?;
    if !resolved.exists() {
        return Err(format!("Error: input image '{raw}' does not exist in the workspace."));
    }
    if !resolved.is_file() {
        return Err(format!("Error: input image '{raw}' is not a regular file."));
    }
    let size = std::fs::metadata(&resolved).map(|m| m.len()).unwrap_or(0);
    if size > MAX_INPUT_BYTES {
        return Err(format!("Error: input image '{raw}' is {} bytes (max {}).", crate::read::fmt_thousands(size as usize), crate::read::fmt_thousands(MAX_INPUT_BYTES as usize)));
    }
    let name = resolved.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let bytes = std::fs::read(&resolved).map_err(|e| format!("Error: {e}"))?;
    Ok((name, bytes))
}

/// Python `repr()` of a JSON value.
pub(crate) fn py_repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match n.as_f64().filter(|_| n.is_f64()) {
            Some(f) => appv3_core::pyjson::float_repr(f),
            None => n.to_string(),
        },
        Value::String(s) => crate::py_repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", crate::py_repr_str(k), py_repr(v))).collect::<Vec<_>>().join(", ")),
    }
}

/// `base64.b64decode(s)` (non-validating: drops non-alphabet bytes).
pub(crate) fn py_b64decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let mut data = String::new();
    let mut pads = 0;
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => {
                if pads > 0 {
                    // Data after padding: binascii stops at complete quads.
                    break;
                }
                data.push(c)
            }
            '=' => pads += 1,
            _ => {}
        }
    }
    let n = data.len();
    if n % 4 == 1 {
        return Err(format!("Invalid base64-encoded string: number of data characters ({n}) cannot be 1 more than a multiple of 4"));
    }
    let need = (4 - n % 4) % 4;
    if pads < need {
        return Err("Incorrect padding".into());
    }
    let padded = format!("{data}{}", "=".repeat(need));
    base64::engine::general_purpose::STANDARD.decode(padded).map_err(|e| e.to_string())
}

/// Python `str[:n]` (characters).
pub(crate) fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Optional `Literal[...]` argument (pydantic message on mismatch).
pub(crate) fn opt_literal(a: &mut crate::args::Args, name: &str, allowed: &[&str]) -> Option<String> {
    match a.raw(&[name]) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if allowed.contains(&s.as_str()) => Some(s.clone()),
        Some(_) => {
            let quoted: Vec<String> = allowed.iter().map(|x| format!("'{x}'")).collect();
            let list = if quoted.len() > 1 { format!("{} or {}", quoted[..quoted.len() - 1].join(", "), quoted[quoted.len() - 1]) } else { quoted.join("") };
            a.err(name, &format!("Input should be {list}"));
            None
        }
    }
}

/// Optional `list[str]` argument.
pub(crate) fn opt_str_list(a: &mut crate::args::Args, name: &str) -> Option<Vec<String>> {
    match a.raw(&[name]) {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            let mut out = vec![];
            let mut ok = true;
            for (i, it) in items.iter().enumerate() {
                match it {
                    Value::String(s) => out.push(s.clone()),
                    _ => {
                        a.err(&format!("{name} -> {i}"), "Input should be a valid string");
                        ok = false;
                    }
                }
            }
            ok.then_some(out)
        }
        Some(_) => {
            a.err(name, "Input should be a valid list");
            None
        }
    }
}

/// An exported `<KEY>`, then the stored credential in use for the
/// provider that owns it (`OPENAI_API_KEY` → OpenAI, …).
pub(crate) fn api_key(name: &str) -> String {
    let owner = appv3_providers::credentials_migration::owner_of(name);
    appv3_core::credentials::lookup(owner.as_deref(), name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64() {
        assert_eq!(py_b64decode("aGk=").unwrap(), b"hi");
        assert_eq!(py_b64decode("aGk").unwrap_err(), "Incorrect padding");
        assert!(py_b64decode("a").unwrap_err().contains("(1) cannot be 1 more"));
        assert_eq!(py_b64decode("aG\nk=").unwrap(), b"hi");
    }

    #[test]
    fn filenames() {
        assert_eq!(sanitise_filename(Some("my cat.png"), "image", "png"), "my-cat.png");
        assert_eq!(sanitise_filename(Some("a.b.c"), "image", "webp"), "a-b.webp");
        assert!(sanitise_filename(Some("..."), "image", "png").starts_with("image-"));
        assert!(sanitise_filename(None, "video", "mp4").ends_with(".mp4"));
    }
}
