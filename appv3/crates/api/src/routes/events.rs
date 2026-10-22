//! `app/api/routes/events.py` — live global event stream (no replay).
//!
//! With `?client_id=` the stream also carries the session streams the client
//! subscribes to (see `crate::mux`).

use crate::error::{ApiError, ApiResult};
use crate::mux;
use crate::sse::sse_response;
use crate::util::{body_value, json, py_uuid, Qs};
use crate::AppState;
use appv3_agent::broadcaster::broadcaster;
use appv3_agent::{store, WireEvent};
use appv3_db as db;
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, put};
use axum::Router;
use bytes::Bytes;
use futures::stream::{BoxStream, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;

pub fn router() -> Router<AppState> {
    Router::new().route("/stream", get(stream)).route("/subscriptions/{client_id}", put(subscribe))
}

async fn stream(qs: Qs) -> ApiResult<Response> {
    let events: BoxStream<'static, Arc<WireEvent>> = match qs.get("client_id") {
        None => {
            // The notch island's feed (and API clients): global events only.
            tracing::info!("events_stream_open kind=plain");
            let mut sub = broadcaster().attach();
            async_stream::stream! {
                while let Some(ev) = sub.next().await {
                    yield ev;
                }
            }
            .boxed()
        }
        Some(id) if mux::valid_id(id) => {
            // An app window's shared feed, which also carries session streams.
            tracing::info!("events_stream_open kind=app client_id={}", id);
            let (client, guard) = mux::register(id);
            let mut global = broadcaster().attach();
            async_stream::stream! {
                let _guard = guard;
                loop {
                    tokio::select! {
                        ev = global.next() => match ev {
                            Some(ev) => yield ev,
                            None => break,
                        },
                        ev = client.recv() => match ev {
                            Some(ev) => yield ev,
                            None => break,
                        },
                    }
                }
            }
            .boxed()
        }
        Some(_) => return Err(ApiError::bad_request("Invalid client id.")),
    };
    Ok(sse_response(events))
}

/// Replace the sessions a stream carries: `{"subs": [{"id", "session_id"}]}`.
async fn subscribe(State(st): State<AppState>, AxPath(client_id): AxPath<String>, body: Bytes) -> ApiResult<Response> {
    let Some(client) = mux::lookup(&client_id) else {
        return Err(ApiError::not_found("Stream is not open."));
    };
    let b = body_value(&body)?;
    let Some(items) = b.get("subs").and_then(Value::as_array) else {
        return Err(ApiError::unprocessable("Expected a `subs` list."));
    };
    if items.len() > mux::MAX_SUBSCRIPTIONS {
        return Err(ApiError::unprocessable(format!("At most {} subscriptions.", mux::MAX_SUBSCRIPTIONS)));
    }
    let mut wanted: Vec<(String, String)> = Vec::with_capacity(items.len());
    for it in items {
        let id = it.get("id").and_then(Value::as_str).filter(|s| mux::valid_id(s));
        let sid = it.get("session_id").and_then(Value::as_str).filter(|s| mux::valid_id(s));
        let (Some(id), Some(sid)) = (id, sid) else {
            return Err(ApiError::unprocessable("Each subscription needs a valid `id` and `session_id`."));
        };
        if wanted.iter().any(|(w, _)| w == id) {
            return Err(ApiError::unprocessable("Duplicate subscription id."));
        }
        wanted.push((id.to_string(), sid.to_string()));
    }
    // As on the per-session stream: a session parked on a question has a turn
    // to attach to even when nothing is running, and its attach replays the
    // question.
    for sid in client.new_session_ids(&wanted) {
        let Some(sid) = py_uuid(&sid) else { continue };
        match db::get_pending_question(&st.pool, &sid).await {
            Ok(Some(row)) => store().ensure_parked_turn(&sid, &row),
            Ok(None) => {}
            Err(e) => tracing::warn!("stream_ensure_turn_failed session_id={} error={}", sid, e),
        }
    }
    client.sync(&wanted);
    Ok(json(json!({"status": "ok", "active": client.active()})))
}
