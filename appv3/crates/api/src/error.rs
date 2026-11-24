//! FastAPI-shaped errors: `HTTPException` → `{"detail": ...}` and
//! `RequestValidationError` → 422 `{"detail": [{type, loc, msg, input}]}`.

use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: Value,
    pub headers: Vec<(HeaderName, HeaderValue)>,
    /// Starlette's `ServerErrorMiddleware` answers unhandled exceptions with
    /// plain text, not JSON.
    pub plain: bool,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: u16, detail: impl Into<String>) -> Self {
        Self::with_detail(status, Value::String(detail.into()))
    }
    pub fn with_detail(status: u16, detail: Value) -> Self {
        Self { status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), detail, headers: vec![], plain: false }
    }
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(404, detail)
    }
    pub fn unprocessable(detail: impl Into<String>) -> Self {
        Self::new(422, detail)
    }
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(400, detail)
    }
    pub fn conflict(detail: impl Into<String>) -> Self {
        Self::new(409, detail)
    }
    /// Unhandled exception → `500 Internal Server Error` (text/plain).
    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!("unhandled_error error={}", err);
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, detail: Value::String("Internal Server Error".into()), headers: vec![], plain: true }
    }
    /// A `RequestValidationError` with the given pydantic error items.
    pub fn validation(items: Vec<Value>) -> Self {
        Self::with_detail(422, Value::Array(items))
    }
    pub fn header(mut self, name: &'static str, value: &str) -> Self {
        if let Ok(v) = HeaderValue::from_str(value) {
            self.headers.push((HeaderName::from_static(name), v));
        }
        self
    }
}

/// One pydantic error item (`include_url=False`).
pub fn verr(kind: &str, loc: &[Value], msg: &str, input: Value) -> Value {
    json!({"type": kind, "loc": loc, "msg": msg, "input": input})
}

pub fn verr_ctx(kind: &str, loc: &[Value], msg: &str, input: Value, ctx: Value) -> Value {
    json!({"type": kind, "loc": loc, "msg": msg, "input": input, "ctx": ctx})
}

pub fn loc(parts: &[&str]) -> Vec<Value> {
    parts.iter().map(|p| Value::String((*p).to_string())).collect()
}

/// `Field required` for `loc`.
pub fn missing(parts: &[&str], input: Value) -> ApiError {
    ApiError::validation(vec![verr("missing", &loc(parts), "Field required", input)])
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut resp = if self.plain {
            let text = self.detail.as_str().unwrap_or("Internal Server Error").to_string();
            (self.status, [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response()
        } else {
            crate::util::json_status(self.status, &json!({"detail": self.detail}))
        };
        for (k, v) in self.headers {
            resp.headers_mut().insert(k, v);
        }
        resp
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::internal(format!("{e:#}"))
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::internal(e)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError::internal(e)
    }
}

/// A credential store that cannot be read or written: 422 with where it is
/// wrong, from every route (the text holds no value from the file).
impl From<appv3_core::credentials::CredentialsError> for ApiError {
    fn from(e: appv3_core::credentials::CredentialsError) -> Self {
        ApiError::unprocessable(e.to_string())
    }
}
