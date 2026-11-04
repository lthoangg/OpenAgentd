//! The MCP HTTP transports against fake servers: Streamable HTTP, the legacy
//! HTTP+SSE transport (and the fallback to it), and the OAuth sign-in every
//! HTTP server may ask for with a 401.

use appv3_mcp::client::McpClient;
use appv3_mcp::config::{HttpKind, OAuthConfig};
use appv3_mcp::oauth::build_oauth_provider;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

/// What a fake server does with a request to `/mcp`.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Streamable HTTP, no sign-in.
    Streamable,
    /// Asks for OAuth on every request.
    NeedsOAuth,
    /// Legacy HTTP+SSE: POST to `/mcp` is refused with 405, GET opens the stream.
    Legacy,
    /// Legacy, but the stream names an endpoint on another origin.
    LegacyElsewhere,
}

#[derive(Clone)]
struct Fake {
    mode: Mode,
    /// `METHOD path` of every request, in order.
    log: Arc<Mutex<Vec<String>>>,
    /// The open legacy stream.
    stream: Arc<Mutex<Option<mpsc::UnboundedSender<Event>>>>,
    /// The client's reply to the server's `ping`.
    pong: Arc<Mutex<Option<Value>>>,
    pong_seen: Arc<tokio::sync::Notify>,
}

fn reply(m: &Value) -> Option<Value> {
    let id = m.get("id")?.clone();
    let result = match m["method"].as_str()? {
        "initialize" => json!({"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "fake", "version": "1"}}),
        "tools/list" => json!({"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}),
        "tools/call" => json!({"content": [{"type": "text", "text": m["params"]["arguments"]["text"]}]}),
        _ => json!({}),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

async fn handle(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: String) -> Response {
    f.log.lock().unwrap().push(format!("{method} {}", uri.path()));
    let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    match (f.mode, method.as_str(), uri.path()) {
        (Mode::NeedsOAuth, _, _) => {
            (StatusCode::UNAUTHORIZED, [("www-authenticate", r#"Bearer resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp""#)]).into_response()
        }
        (Mode::Streamable, "POST", "/mcp") => match reply(&msg) {
            Some(r) => Json(r).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
        (Mode::Legacy | Mode::LegacyElsewhere, "POST", "/mcp") => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        (Mode::Legacy | Mode::LegacyElsewhere, "GET", "/mcp") => {
            assert_eq!(headers.get("accept").and_then(|v| v.to_str().ok()), Some("text/event-stream"));
            let (tx, rx) = mpsc::unbounded_channel();
            let endpoint = if f.mode == Mode::Legacy { "/messages?session=1" } else { "http://elsewhere.invalid/messages" };
            tx.send(Event::default().event("endpoint").data(endpoint)).unwrap();
            *f.stream.lock().unwrap() = Some(tx);
            Sse::new(UnboundedReceiverStream::new(rx).map(Ok::<_, Infallible>)).into_response()
        }
        (Mode::Legacy, "POST", "/messages") => {
            let tx = f.stream.lock().unwrap().clone().expect("the stream is open");
            if msg.get("method").is_none() {
                // The client's answer to the server's request.
                *f.pong.lock().unwrap() = Some(msg);
                f.pong_seen.notify_one();
            } else {
                if msg["method"] == "tools/call" {
                    // A server request first: the client must answer it.
                    tx.send(Event::default().data(json!({"jsonrpc": "2.0", "id": "p1", "method": "ping"}).to_string())).unwrap();
                }
                if let Some(r) = reply(&msg) {
                    tx.send(Event::default().data(r.to_string())).unwrap();
                }
            }
            StatusCode::ACCEPTED.into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn serve(mode: Mode) -> (String, Fake) {
    let fake = Fake { mode, log: Arc::default(), stream: Arc::default(), pong: Arc::default(), pong_seen: Arc::default() };
    let app = Router::new().fallback(any(handle)).with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, fake)
}

fn log(f: &Fake) -> Vec<String> {
    f.log.lock().unwrap().clone()
}

/// The OAuth provider every HTTP server without its own `Authorization` header gets.
fn discovered(name: &str, url: &str) -> Option<appv3_mcp::oauth::OAuthProvider> {
    build_oauth_provider(name, url, Some(&OAuthConfig { client_id: None, client_secret: None })).unwrap()
}

#[tokio::test]
async fn a_public_streamable_server_connects_with_sign_in_on_hand() {
    let (url, fake) = serve(Mode::Streamable).await;
    let client = McpClient::http(&url, &[], discovered("t-public", &url), HttpKind::Auto).unwrap();
    client.initialize().await.unwrap();
    assert_eq!(client.list_tools().await.unwrap()[0]["name"], "echo");
    client.close().await;
    assert!(log(&fake).iter().all(|l| l == "POST /mcp" || l == "GET /mcp"), "no sign-in for a server that does not ask: {:?}", log(&fake));
}

#[tokio::test]
async fn a_server_asking_for_oauth_waits_for_connect_without_registering() {
    let (url, fake) = serve(Mode::NeedsOAuth).await;
    let client = McpClient::http(&url, &[], discovered("t-needs-oauth", &url), HttpKind::Auto).unwrap();
    let e = client.initialize().await.unwrap_err();
    assert_eq!(e.type_name(), "OAuthRequiredError", "{e}");
    assert!(e.to_string().contains("Sign in"), "{e}");
    // A background start discovers and registers nothing: that waits for the user's Connect.
    assert_eq!(log(&fake), ["POST /mcp"]);
}

#[tokio::test]
async fn an_sse_server_speaks_the_legacy_transport() {
    let (url, fake) = serve(Mode::Legacy).await;
    let client = McpClient::http(&url, &[], None, HttpKind::Sse).unwrap();
    client.initialize().await.unwrap();
    assert_eq!(client.list_tools().await.unwrap()[0]["name"], "echo");
    let out = client.call_tool("echo", json!({"text": "hi"})).await.unwrap();
    assert_eq!(out["content"][0]["text"], "hi");
    // The answer is sent on its own; the call's reply can arrive first.
    tokio::time::timeout(std::time::Duration::from_secs(5), fake.pong_seen.notified()).await.expect("the client answers the server's ping");
    assert_eq!(fake.pong.lock().unwrap().clone(), Some(json!({"jsonrpc": "2.0", "id": "p1", "result": {}})), "the server's ping is answered");
    client.close().await;
    let log = log(&fake);
    assert_eq!(log[0], "GET /mcp", "{log:?}");
    assert!(log[1..].iter().all(|l| l == "POST /messages"), "{log:?}");
}

#[tokio::test]
async fn an_http_server_refusing_streamable_http_falls_back_to_sse() {
    let (url, fake) = serve(Mode::Legacy).await;
    let client = McpClient::http(&url, &[], discovered("t-fallback", &url), HttpKind::Auto).unwrap();
    client.initialize().await.unwrap();
    let out = client.call_tool("echo", json!({"text": "back"})).await.unwrap();
    assert_eq!(out["content"][0]["text"], "back");
    client.close().await;
    let log = log(&fake);
    assert_eq!(log[..2], ["POST /mcp", "GET /mcp"], "{log:?}");
}

#[tokio::test]
async fn a_declared_streamable_server_does_not_fall_back() {
    let (url, fake) = serve(Mode::Legacy).await;
    let client = McpClient::http(&url, &[], None, HttpKind::Streamable).unwrap();
    let e = client.initialize().await.unwrap_err();
    assert!(e.to_string().contains("HTTP 405"), "{e}");
    assert_eq!(log(&fake), ["POST /mcp"]);
}

#[tokio::test]
async fn an_sse_endpoint_on_another_origin_is_not_used() {
    let (url, _fake) = serve(Mode::LegacyElsewhere).await;
    let client = McpClient::http(&url, &[], None, HttpKind::Sse).unwrap();
    let e = client.initialize().await.unwrap_err();
    assert!(e.to_string().contains("is not on the server's origin"), "{e}");
}
