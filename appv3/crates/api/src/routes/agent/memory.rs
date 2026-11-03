//! Memory routes (mounted at `/memory`).

use crate::error::{ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_memory as mem;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/memory/tree", get(tree))
        .route("/memory/file", get(get_file).put(put_file).delete(delete_file))
        .route("/memory/search", get(search))
        .route("/memory/lint", post(lint))
}

fn mem_err(e: mem::MemoryError) -> ApiError {
    ApiError::new(e.status(), e.to_string())
}

fn root() -> std::path::PathBuf {
    mem::global_memory_root()
}

fn page_json(p: &mem::Page) -> Response {
    let mut r = json(json!({
        "path": p.path,
        "content": p.content,
        "etag": p.etag,
        "frontmatter": p.frontmatter.as_ref().map(|f| json!({"title": f.title, "type": f.kind})),
    }));
    if let Ok(v) = HeaderValue::from_str(&p.etag) {
        r.headers_mut().insert("etag", v);
    }
    r
}

fn if_match(h: &HeaderMap) -> Option<String> {
    h.get("if-match").and_then(|v| v.to_str().ok()).map(String::from)
}

async fn tree() -> Response {
    let pages = blocking(|| mem::list_pages(&root())).await;
    let pages: Vec<Value> = pages
        .into_iter()
        .map(|p| json!({"path": p.get("path").cloned().unwrap_or(Value::Null), "title": p.get("title").cloned().unwrap_or(Value::Null), "type": p.get("type").cloned().unwrap_or(json!("general"))}))
        .collect();
    json(json!({"pages": pages}))
}

async fn get_file(q: Qs) -> ApiResult<Response> {
    let path = q.req("path")?;
    let page = blocking(move || mem::read_page(&root(), &path)).await.map_err(mem_err)?;
    Ok(page_json(&page))
}

async fn put_file(q: Qs, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let path = q.req("path")?;
    let b = body_value(&body)?;
    let content = match b.get("content") {
        Some(Value::String(s)) => s.clone(),
        None => return Err(crate::error::missing(&["body", "content"], b.clone())),
        Some(o) => {
            return Err(ApiError::validation(vec![crate::error::verr("string_type", &crate::error::loc(&["body", "content"]), "Input should be a valid string", o.clone())]))
        }
    };
    let (page, _) = mem::write_page(&root(), &path, &content, if_match(&headers).as_deref()).await.map_err(mem_err)?;
    Ok(page_json(&page))
}

async fn delete_file(q: Qs, headers: HeaderMap) -> ApiResult<Response> {
    let path = q.req("path")?;
    mem::delete_page(&root(), &path, if_match(&headers).as_deref()).await.map_err(mem_err)?;
    Ok(json(json!({"status": "deleted", "path": path})))
}

async fn search(q: Qs) -> ApiResult<Response> {
    let query = q.req("query")?;
    if query.is_empty() {
        return Err(ApiError::validation(vec![crate::error::verr_ctx(
            "string_too_short",
            &crate::error::loc(&["query", "query"]),
            "String should have at least 1 character",
            json!(query),
            json!({"min_length": 1}),
        )]));
    }
    let results = blocking(move || mem::search_memory(&root(), &query)).await;
    Ok(json(json!({"results": results})))
}

async fn lint() -> Response {
    let findings: Vec<Value> =
        blocking(|| mem::lint(&root())).await.into_iter().map(|f| json!({"code": f.get("code"), "path": f.get("path"), "message": f.get("message")})).collect();
    json(json!({"findings": findings}))
}
