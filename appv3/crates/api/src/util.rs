//! Request/response plumbing shared by the route modules: JSON rendering,
//! FastAPI-style query/body/path validation.

use crate::error::{loc, verr, verr_ctx, ApiError, ApiResult};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};

/// Compact JSON with non-ASCII kept verbatim.
pub fn json_status<T: serde::Serialize + ?Sized>(status: StatusCode, v: &T) -> Response {
    // Response bodies are Values or structs with string keys: never fails.
    let body = serde_json::to_vec(v).expect("response bodies always serialize");
    let mut r = (status, body).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

pub fn json(v: Value) -> Response {
    json_status(StatusCode::OK, &v)
}

pub fn json_code(code: u16, v: Value) -> Response {
    json_status(StatusCode::from_u16(code).unwrap_or(StatusCode::OK), &v)
}

/// Give a `200` response an `ETag` (a hash of its body) and answer `304 Not
/// Modified`, without the body, when the request's `If-None-Match` already
/// names it. For polled reads (file listings, git status) whose result
/// usually has not changed: the server still computes it, but the client
/// skips the transfer, the JSON parse and the re-render.
pub async fn with_etag(req: &axum::http::HeaderMap, resp: Response) -> Response {
    use std::hash::Hasher;
    if resp.status() != StatusCode::OK {
        return resp;
    }
    let (mut parts, body) = resp.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut h = std::hash::DefaultHasher::new();
    h.write(&bytes);
    let tag = format!("\"{:016x}\"", h.finish());
    let tag_value = HeaderValue::from_str(&tag).expect("hex etag is a valid header");
    parts.headers.insert(header::ETAG, tag_value.clone());
    parts.headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    let matches = req.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(|t| t.trim() == tag || t.trim() == "*"));
    if matches {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, tag_value), (header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))]).into_response();
    }
    Response::from_parts(parts, axum::body::Body::from(bytes))
}

/// [`with_etag`] for a handler result.
pub async fn etagged(req: &axum::http::HeaderMap, r: ApiResult<Response>) -> ApiResult<Response> {
    Ok(with_etag(req, r?).await)
}

pub fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

pub fn obj(m: Map<String, Value>) -> Value {
    Value::Object(m)
}

// ── query string ────────────────────────────────────────────────────────────

/// Raw query pairs (Starlette `QueryParams`; scalar lookups take the last).
#[derive(Debug, Clone, Default)]
pub struct Qs(pub Vec<(String, String)>);

impl<S: Send + Sync> FromRequestParts<S> for Qs {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(Qs::parse(parts.uri.query().unwrap_or("")))
    }
}

pub fn pydantic_bool(raw: &str) -> Option<bool> {
    match raw.to_ascii_lowercase().as_str() {
        "1" | "on" | "t" | "true" | "y" | "yes" => Some(true),
        "0" | "off" | "f" | "false" | "n" | "no" => Some(false),
        _ => None,
    }
}

pub fn int_parsing(l: &[&str], raw: &str) -> Value {
    verr("int_parsing", &loc(l), "Input should be a valid integer, unable to parse string as an integer", json!(raw))
}

pub fn bool_parsing(l: &[&str], raw: &str) -> Value {
    verr("bool_parsing", &loc(l), "Input should be a valid boolean, unable to interpret input", json!(raw))
}

pub fn check_range(l: &[&str], v: i64, raw: Value, ge: Option<i64>, le: Option<i64>) -> ApiResult<i64> {
    if let Some(g) = ge {
        if v < g {
            return Err(ApiError::validation(vec![verr_ctx("greater_than_equal", &loc(l), &format!("Input should be greater than or equal to {g}"), raw, json!({"ge": g}))]));
        }
    }
    if let Some(m) = le {
        if v > m {
            return Err(ApiError::validation(vec![verr_ctx("less_than_equal", &loc(l), &format!("Input should be less than or equal to {m}"), raw, json!({"le": m}))]));
        }
    }
    Ok(v)
}

impl Qs {
    pub fn parse(q: &str) -> Self {
        Qs(form_urlencoded::parse(q.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect())
    }
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().rev().find(|(key, _)| key == k).map(|(_, v)| v.as_str())
    }
    pub fn get_all(&self, k: &str) -> Vec<String> {
        self.0.iter().filter(|(key, _)| key == k).map(|(_, v)| v.clone()).collect()
    }
    pub fn has(&self, k: &str) -> bool {
        self.0.iter().any(|(key, _)| key == k)
    }
    pub fn opt(&self, k: &str) -> Option<String> {
        self.get(k).map(String::from)
    }
    pub fn req(&self, k: &str) -> ApiResult<String> {
        self.opt(k).ok_or_else(|| crate::error::missing(&["query", k], Value::Null))
    }
    pub fn opt_int(&self, k: &str, ge: Option<i64>, le: Option<i64>) -> ApiResult<Option<i64>> {
        match self.get(k) {
            None => Ok(None),
            Some(raw) => {
                let v: i64 = raw.trim().parse().map_err(|_| ApiError::validation(vec![int_parsing(&["query", k], raw)]))?;
                check_range(&["query", k], v, json!(raw), ge, le).map(Some)
            }
        }
    }
    pub fn int(&self, k: &str, default: i64, ge: Option<i64>, le: Option<i64>) -> ApiResult<i64> {
        Ok(self.opt_int(k, ge, le)?.unwrap_or(default))
    }
    pub fn bool(&self, k: &str, default: bool) -> ApiResult<bool> {
        match self.get(k) {
            None => Ok(default),
            Some(raw) => pydantic_bool(raw).ok_or_else(|| ApiError::validation(vec![bool_parsing(&["query", k], raw)])),
        }
    }
    pub fn opt_bool(&self, k: &str) -> ApiResult<Option<bool>> {
        match self.get(k) {
            None => Ok(None),
            Some(raw) => pydantic_bool(raw).map(Some).ok_or_else(|| ApiError::validation(vec![bool_parsing(&["query", k], raw)])),
        }
    }
}

// ── path params ─────────────────────────────────────────────────────────────

/// FastAPI `UUID` path param → canonical `str(UUID)`.
pub fn path_uuid(name: &str, raw: &str) -> ApiResult<String> {
    parse_uuid_loc(&["path", name], raw)
}

pub fn parse_uuid_loc(l: &[&str], raw: &str) -> ApiResult<String> {
    match uuid::Uuid::parse_str(raw) {
        Ok(u) => Ok(u.hyphenated().to_string()),
        Err(e) => {
            let err = e.to_string();
            Err(ApiError::validation(vec![verr_ctx("uuid_parsing", &loc(l), &format!("Input should be a valid UUID, {err}"), json!(raw), json!({"error": err}))]))
        }
    }
}

/// Python `uuid.UUID(raw)` (ValueError → `None`).
pub fn py_uuid(raw: &str) -> Option<String> {
    let t = raw.trim();
    let t = t.strip_prefix("urn:").unwrap_or(t);
    let t = t.strip_prefix("uuid:").unwrap_or(t);
    let hex: String = t.trim_matches(|c| c == '{' || c == '}').chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    uuid::Uuid::parse_str(&hex).ok().map(|u| u.hyphenated().to_string())
}

// ── JSON bodies ─────────────────────────────────────────────────────────────

/// Parse a JSON request body the way FastAPI does for a required model.
pub fn body_value(bytes: &[u8]) -> ApiResult<Value> {
    if bytes.is_empty() {
        return Err(crate::error::missing(&["body"], Value::Null));
    }
    serde_json::from_slice::<Value>(bytes).map_err(|e| {
        let pos = e.column().saturating_sub(1);
        ApiError::validation(vec![verr_ctx("json_invalid", &[json!("body"), json!(pos)], "JSON decode error", json!({}), json!({"error": "Expecting value"}))])
    })
}

/// Deserialize `v` into `T`, translating serde's first error into a
/// pydantic-shaped item.
pub fn model<T: DeserializeOwned>(v: Value) -> ApiResult<T> {
    if !v.is_object() {
        return Err(ApiError::validation(vec![verr("model_attributes_type", &loc(&["body"]), "Input should be a valid dictionary or object to extract fields from", v)]));
    }
    let input = v.clone();
    serde_json::from_value::<T>(v).map_err(|e| serde_to_pydantic(&e.to_string(), &input))
}

pub fn body<T: DeserializeOwned>(bytes: &[u8]) -> ApiResult<T> {
    model(body_value(bytes)?)
}

fn serde_to_pydantic(msg: &str, input: &Value) -> ApiError {
    static FIELD_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"`([^`]+)`").unwrap());
    let field_re = &*FIELD_RE;
    if let Some(rest) = msg.strip_prefix("missing field ") {
        let f = field_re.captures(rest).map(|c| c[1].to_string()).unwrap_or_default();
        return ApiError::validation(vec![verr("missing", &loc(&["body", &f]), "Field required", input.clone())]);
    }
    let (kind, text) = if msg.contains("expected a string") {
        ("string_type", "Input should be a valid string")
    } else if msg.contains("expected a boolean") {
        ("bool_type", "Input should be a valid boolean")
    } else if msg.contains("expected i64") || msg.contains("expected u") || msg.contains("expected i32") {
        ("int_type", "Input should be a valid integer")
    } else if msg.contains("expected a sequence") {
        ("list_type", "Input should be a valid list")
    } else if msg.contains("unknown variant") {
        ("literal_error", "Input should be a valid value")
    } else {
        ("value_error", msg)
    };
    ApiError::validation(vec![verr(kind, &loc(&["body"]), text, input.clone())])
}

/// `pydantic.ValidationError` raised from a model validator:
/// `Value error, {msg}` at `loc=("body",)`.
pub fn value_error(msg: &str, input: Value) -> ApiError {
    ApiError::validation(vec![verr_ctx("value_error", &loc(&["body"]), &format!("Value error, {msg}"), input, json!({"error": {}}))])
}

/// Strict JSON string/None field lookup helpers over a raw body object.
pub fn opt_str_field(v: &Value, k: &str) -> ApiResult<Option<String>> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(ApiError::validation(vec![verr("string_type", &loc(&["body", k]), "Input should be a valid string", other.clone())])),
    }
}

pub fn opt_bool_field(v: &Value, k: &str) -> ApiResult<Option<bool>> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(Value::Number(n)) if n.as_i64() == Some(0) || n.as_i64() == Some(1) => Ok(Some(n.as_i64() == Some(1))),
        Some(Value::String(s)) if pydantic_bool(s).is_some() => Ok(pydantic_bool(s)),
        Some(other) => Err(ApiError::validation(vec![verr("bool_parsing", &loc(&["body", k]), "Input should be a valid boolean, unable to interpret input", other.clone())])),
    }
}

pub fn opt_int_field(v: &Value, k: &str) -> ApiResult<Option<i64>> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => match n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)) {
            Some(i) => Ok(Some(i)),
            None => Err(ApiError::validation(vec![verr(
                "int_from_float",
                &loc(&["body", k]),
                "Input should be a valid integer, got a number with a fractional part",
                Value::Number(n.clone()),
            )])),
        },
        Some(Value::String(s)) => s.trim().parse::<i64>().map(Some).map_err(|_| ApiError::validation(vec![int_parsing(&["body", k], s)])),
        Some(other) => Err(ApiError::validation(vec![verr("int_type", &loc(&["body", k]), "Input should be a valid integer", other.clone())])),
    }
}

/// Python `str(path)` for display in `detail` strings.
pub fn pstr(p: &std::path::Path) -> String {
    p.display().to_string()
}

/// `Path.home()`.
pub fn home() -> std::path::PathBuf {
    appv3_core::home::home_dir_opt().unwrap_or_else(|| std::path::PathBuf::from("/"))
}

/// `Path(p).expanduser()`.
pub fn expanduser(p: &str) -> std::path::PathBuf {
    if p == "~" {
        return home();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest);
    }
    std::path::PathBuf::from(p)
}

/// `Path.resolve(strict=False)`.
pub fn resolve(p: &std::path::Path) -> std::path::PathBuf {
    appv3_tools::denied::resolve(p)
}

/// Run blocking filesystem work off the async runtime.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.expect("blocking task panicked")
}

/// `secrets.token_urlsafe(32)`.
pub fn token_urlsafe() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    for chunk in bytes.chunks_mut(16) {
        chunk.copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body_of(r: Response) -> String {
        String::from_utf8(axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn json_responses_are_compact_and_round_trip() {
        let v = json!({"text": "héllo \"q\"\n", "n": [1, 2.5, 1e16, 0.00001], "none": null});
        let r = json_status(StatusCode::CREATED, &v);
        assert_eq!(r.status(), StatusCode::CREATED);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "application/json");
        let body = body_of(r).await;
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), v);
        assert!(body.starts_with(r#"{"text":"héllo \"q\"\n","n":[1,2.5,"#), "compact, keys in order, non-ASCII verbatim: {body}");
    }
}
