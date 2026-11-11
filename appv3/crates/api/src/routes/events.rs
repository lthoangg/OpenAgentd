//! Live global event stream. It starts with a `stream_resume` event; with
//! `?since=<id>` (the last event id a client saw) it then replays the
//! events after that one, when the server still has them (see
//! `appv3_agent::broadcaster`), so a reconnecting client misses nothing.
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

/// An id this server hands out: `<boot>-<seq>`. Anything else is ignored.
fn since_param(qs: &Qs) -> Option<&str> {
    qs.get("since").filter(|s| (3..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

async fn stream(qs: Qs) -> ApiResult<Response> {
    let since = since_param(&qs);
    let events: BoxStream<'static, Arc<WireEvent>> = match qs.get("client_id") {
        None => {
            // The notch island's feed (and API clients): global events only.
            let (mut sub, resume) = broadcaster().attach_since(since);
            tracing::info!("events_stream_open kind=plain resumed={} replayed={} resync={}", since.is_some(), resume.replayed, resume.resync);
            async_stream::stream! {
                for ev in resume.head {
                    yield ev;
                }
                while let Some(ev) = sub.next().await {
                    yield ev;
                }
            }
            .boxed()
        }
        Some(id) if mux::valid_id(id) => {
            // An app window's shared feed, which also carries session streams.
            let (client, guard) = mux::register(id);
            let (mut global, resume) = broadcaster().attach_since(since);
            tracing::info!("events_stream_open kind=app client_id={} resumed={} replayed={} resync={}", id, since.is_some(), resume.replayed, resume.resync);
            async_stream::stream! {
                let _guard = guard;
                for ev in resume.head {
                    yield ev;
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The stream's first write: `stream_resume`, then any replayed events.
    async fn first_write(query: &str) -> String {
        let resp = stream(Qs::parse(query)).await.unwrap();
        let mut body = resp.into_body().into_data_stream();
        String::from_utf8(body.next().await.unwrap().unwrap().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn a_reconnecting_client_gets_what_it_missed() {
        let (mut seen, _) = broadcaster().attach_since(None);
        broadcaster().publish("title_update", json!({"session_id": "replay-a", "title": "one"}));
        broadcaster().publish("title_update", json!({"session_id": "replay-b", "title": "two"}));
        let first = seen.next().await.unwrap();
        while seen.next().await.unwrap().data.contains("replay-a") {}
        let since = first.id.clone().unwrap();

        let frame = first_write(&format!("since={since}")).await;
        assert!(frame.starts_with("event: stream_resume\r\ndata: {\"replay\":"), "{frame}");
        assert!(frame.contains("\"resync\":false"), "{frame}");
        assert!(frame.contains("\"session_id\":\"replay-b\""), "{frame}");
        assert!(!frame.contains("\"session_id\":\"replay-a\""), "{frame}");

        // The app's shared feed resumes the same way.
        let frame = first_write(&format!("client_id=resume-test&since={since}")).await;
        assert!(frame.contains("\"session_id\":\"replay-b\""), "{frame}");
    }

    #[tokio::test]
    async fn a_position_the_server_cannot_serve_asks_for_a_refresh() {
        let frame = first_write("since=deadbeef-1").await;
        assert!(frame.contains("\"resync\":true"), "{frame}");
        // A new stream, or a malformed position, just says where it starts.
        for query in ["", "since=a%2Fb"] {
            let frame = first_write(query).await;
            assert!(frame.starts_with("id: "), "{frame}");
            assert!(frame.contains("\"resync\":false"), "{frame}");
        }
    }
}
