//! Minimal MCP client (JSON-RPC 2.0) over stdio and Streamable HTTP — the
//! subset of the Python `mcp` SDK `ClientSession` that v2 uses.

use appv3_core::otel::{self, Span, SpanKind};
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

/// `LATEST_HANDSHAKE_VERSION` of the v2 SDK (mcp 2.2).
pub const PROTOCOL_VERSION: &str = "2025-11-25";
const HANDSHAKE_PROTOCOL_VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// The `MCP send …` span. In the v2 SDK, JSON-RPC error responses are raised
/// after the span has closed and transport / OAuth failures happen in the
/// transport task (the waiter only sees the connection close), so the span
/// always ends UNSET; only a dropped (cancelled) future records an exception.
struct SpanGuard(Option<Span>);

impl SpanGuard {
    fn finish(mut self) {
        if let Some(span) = self.0.take() {
            span.end();
        }
    }
}

impl Drop for SpanGuard {
    fn drop(&mut self) {
        if let Some(span) = self.0.take() {
            span.exit_with_exception("asyncio.exceptions.CancelledError", "");
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum McpError {
    /// JSON-RPC error response (`mcp.shared.exceptions.MCPError`).
    #[error("{0}")]
    Rpc(String),
    /// Raised by the session itself (not the transport task group), so the
    /// connection still shuts down cleanly.
    #[error("{1}")]
    Session(&'static str, String),
    /// Transport failure; `.0` is the Python exception type name.
    #[error("{1}")]
    Transport(&'static str, String),
}

impl McpError {
    /// `f"{type(exc).__name__}: {exc}"`.
    pub fn formatted(&self) -> String {
        match self {
            McpError::Rpc(m) => format!("MCPError: {m}"),
            McpError::Session(kind, m) => format!("{kind}: {m}"),
            McpError::Transport(kind, m) => format!("{kind}: {m}"),
        }
    }
    pub fn type_name(&self) -> &'static str {
        match self {
            McpError::Rpc(_) => "MCPError",
            McpError::Transport(k, _) | McpError::Session(k, _) => k,
        }
    }
}

#[derive(Default)]
struct PendingInner {
    closed: bool,
    map: HashMap<i64, oneshot::Sender<Result<Value, McpError>>>,
}

type Pending = Arc<Mutex<PendingInner>>;

/// Takes the message by value so the result moves out: tool results can carry
/// multi-MB base64 images, and cloning them doubled every response.
fn rpc_result(mut msg: Value) -> Result<Value, McpError> {
    if let Some(err) = msg.get("error") {
        return Err(McpError::Rpc(err.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown error").to_string()));
    }
    Ok(msg.as_object_mut().and_then(|m| m.remove("result")).unwrap_or(json!({})))
}

// ── stdio ───────────────────────────────────────────────────────────────────

struct Stdio {
    stdin: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>,
    child: tokio::sync::Mutex<tokio::process::Child>,
    tree: appv3_core::proctree::ProcessTree,
    pending: Pending,
}

/// `mcp.client.stdio.DEFAULT_INHERITED_ENV_VARS`.
#[cfg(windows)]
const INHERITED_ENV: &[&str] =
    &["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE"];
#[cfg(not(windows))]
const INHERITED_ENV: &[&str] = &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/// `mcp.client.stdio.get_default_environment()`.
fn default_environment() -> HashMap<String, String> {
    INHERITED_ENV.iter().filter_map(|k| std::env::var(k).ok().filter(|v| !v.starts_with("()")).map(|v| (k.to_string(), v))).collect()
}

impl Stdio {
    fn spawn(command: &str, args: &[String], env: &[(String, String)]) -> Result<Self, McpError> {
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(args).env_clear().envs(default_environment()).envs(env.iter().cloned());
        cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit());
        cmd.kill_on_drop(true);
        appv3_core::proctree::configure(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            // v2 (anyio.open_process) surfaces the errno text without the filename.
            std::io::ErrorKind::NotFound => McpError::Transport("FileNotFoundError", "[Errno 2] No such file or directory".into()),
            std::io::ErrorKind::PermissionDenied => McpError::Transport("PermissionError", "[Errno 13] Permission denied".into()),
            _ => McpError::Transport("OSError", e.to_string()),
        })?;
        let tree = appv3_core::proctree::ProcessTree::attach(&child);
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take().expect("piped stdout");
        let pending: Pending = Arc::default();
        let p2 = pending.clone();
        let w2 = stdin.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    tracing::debug!("mcp_stdio_unparsed_line line={}", line.chars().take(200).collect::<String>());
                    continue;
                };
                match (msg.get("id"), msg.get("method").and_then(|m| m.as_str())) {
                    (Some(id), None) => {
                        let tx = id.as_i64().and_then(|id| p2.lock().unwrap().map.remove(&id));
                        if let Some(tx) = tx {
                            let _ = tx.send(rpc_result(msg));
                        }
                    }
                    // Server → client request: answer ping, reject the rest.
                    (Some(id), Some(method)) => {
                        let reply = if method == "ping" {
                            json!({"jsonrpc": "2.0", "id": id, "result": {}})
                        } else {
                            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})
                        };
                        let mut g = w2.lock().await;
                        if let Some(w) = g.as_mut() {
                            let mut line = reply.to_string();
                            line.push('\n');
                            let _ = w.write_all(line.as_bytes()).await;
                            let _ = w.flush().await;
                        }
                    }
                    _ => {}
                }
            }
            let mut g = p2.lock().unwrap();
            g.closed = true;
            for (_, tx) in g.map.drain() {
                let _ = tx.send(Err(McpError::Rpc("Connection closed".into())));
            }
        });
        Ok(Stdio { stdin, child: tokio::sync::Mutex::new(child), tree, pending })
    }

    /// Write one message. The write runs in its own task, so a caller that is
    /// dropped mid-write (a stopped turn, a timeout) never leaves half a line
    /// on the pipe to corrupt every later message.
    async fn write(&self, msg: &Value) -> Result<(), McpError> {
        let mut line = serde_json::to_string(msg).unwrap_or_default();
        line.push('\n');
        tokio::spawn(write_line(self.stdin.clone(), line)).await.unwrap_or_else(|e| Err(McpError::Transport("BrokenResourceError", e.to_string())))
    }

    async fn close(&self) {
        self.stdin.lock().await.take();
        let mut child = self.child.lock().await;
        // MCP shutdown: close stdin, wait, then kill the whole process tree.
        if tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await.is_err() {
            self.tree.terminate(&mut child, std::time::Duration::from_secs(2)).await;
        }
    }
}

async fn write_line(stdin: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>, line: String) -> Result<(), McpError> {
    let mut g = stdin.lock().await;
    let Some(w) = g.as_mut() else { return Err(McpError::Rpc("Connection closed".into())) };
    w.write_all(line.as_bytes()).await.map_err(|e| McpError::Transport("BrokenResourceError", e.to_string()))?;
    w.flush().await.map_err(|e| McpError::Transport("BrokenResourceError", e.to_string()))
}

// ── Streamable HTTP ─────────────────────────────────────────────────────────
//
// Port of `mcp.client.streamable_http` (SDK 2.2): non-2xx replies become
// JSON-RPC errors, redirects are followed only within the endpoint's origin,
// SSE responses resolve on the first response/error event (resuming with
// `Last-Event-ID`), and a standalone GET stream carries server requests.

const MAX_RECONNECTION_ATTEMPTS: u32 = 2;
const DEFAULT_RECONNECTION_DELAY_MS: u64 = 1000;
const MAX_REDIRECTS: usize = 20;

struct Http {
    url: String,
    /// POST / DELETE: follows only method-preserving (307/308) in-origin redirects.
    client: reqwest::Client,
    /// GET streams: follows any in-origin redirect.
    client_get: reqwest::Client,
    session_id: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
    auth: Option<crate::oauth::OAuthProvider>,
    get_stream: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// In-flight replies to server requests (part of v2's transport task group).
    replies: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// reqwest failure → httpx-style exception name.
pub(crate) fn transport_err(e: reqwest::Error) -> McpError {
    McpError::Transport(if e.is_timeout() { "ReadTimeout" } else { "ConnectError" }, e.to_string())
}

fn rpc_err(m: impl Into<String>) -> McpError {
    McpError::Rpc(m.into())
}

/// `_within_origin` (+ the userinfo rule of `next_request_within_origin`).
fn within_origin(sent: &url::Url, next: &url::Url) -> bool {
    if (!next.username().is_empty() || next.password().is_some()) && (next.username(), next.password()) != (sent.username(), sent.password()) {
        return false;
    }
    let same = sent.scheme() == next.scheme() && sent.host_str() == next.host_str() && sent.port() == next.port();
    same || (sent.host_str() == next.host_str() && sent.scheme() == "http" && sent.port().is_none() && next.scheme() == "https" && next.port().is_none())
}

fn origin_policy(any_status: bool) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        let keeps_method = any_status || matches!(attempt.status().as_u16(), 307 | 308);
        let prev = attempt.previous().last().cloned();
        if attempt.previous().len() > MAX_REDIRECTS || !keeps_method || !prev.map(|p| within_origin(&p, attempt.url())).unwrap_or(false) {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}

/// `_unfollowed_redirect`.
fn unfollowed_redirect(resp: &reqwest::Response) -> Option<String> {
    if !matches!(resp.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let loc = resp.headers().get("location")?.to_str().ok()?;
    let mut location = resp.url().join(loc).ok()?;
    let _ = location.set_username("");
    let _ = location.set_password(None);
    location.set_query(None);
    location.set_fragment(None);
    if resp.url().scheme() == "https" && location.scheme() == "http" {
        let mut https = location.clone();
        let _ = https.set_scheme("https");
        return Some(format!(
            "Redirect to {location} not followed: it would downgrade this HTTPS endpoint to plain HTTP.\nThe server is likely behind a TLS-terminating proxy whose forwarded headers it does not trust,\noften combined with a trailing-slash difference. Try {https} instead, or fix the proxy settings."
        ));
    }
    Some(format!("Redirect to {location} not followed; use that URL as the endpoint if it is the intended server"))
}

/// Message of a well-formed `JSONRPCError` (`jsonrpc_message_adapter` shape).
fn jsonrpc_error_message(v: &Value) -> Option<String> {
    let o = v.as_object()?;
    if o.get("jsonrpc")?.as_str()? != "2.0" || !o.contains_key("id") || o.contains_key("result") || o.contains_key("method") {
        return None;
    }
    let id = &o["id"];
    if !(id.is_null() || id.is_string() || id.is_i64() || id.is_u64()) {
        return None;
    }
    let err = o.get("error")?.as_object()?;
    err.get("code")?.as_i64()?;
    err.get("message")?.as_str().map(String::from)
}

fn content_type(resp: &reqwest::Response) -> String {
    resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase()
}

#[derive(Default)]
struct SseEvent {
    event: String,
    data: String,
    id: Option<String>,
    retry: Option<u64>,
}

/// Incremental SSE parser (`httpx_sse` field rules).
#[derive(Default)]
struct SseParser {
    // Splits on bytes, so a UTF-8 char split across chunks stays intact.
    lines: appv3_providers::sse::LineBuf,
    event: Option<String>,
    data: Vec<String>,
    id: Option<String>,
    retry: Option<u64>,
}

impl SseParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let mut lines = Vec::new();
        self.lines.push(chunk, &mut lines);
        let mut out = vec![];
        for line in lines {
            if line.is_empty() {
                if self.event.is_none() && self.data.is_empty() && self.id.is_none() && self.retry.is_none() {
                    continue;
                }
                out.push(SseEvent {
                    event: self.event.take().unwrap_or_else(|| "message".into()),
                    data: std::mem::take(&mut self.data).join("\n"),
                    id: self.id.take(),
                    retry: self.retry.take(),
                });
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f.to_string(), v.strip_prefix(' ').unwrap_or(v).to_string()),
                None => (line.clone(), String::new()),
            };
            match field.as_str() {
                "event" => self.event = Some(value),
                "data" => self.data.push(value),
                "id" if !value.contains('\0') => self.id = Some(value),
                "retry" => self.retry = value.parse().ok(),
                _ => {}
            }
        }
        out
    }
}

enum SseOutcome {
    Done(Result<Value, McpError>),
    Ended { last_event_id: Option<String>, retry_ms: Option<u64> },
}

impl Http {
    fn new(url: &str, headers: &[(String, String)], auth: Option<crate::oauth::OAuthProvider>) -> Result<Self, McpError> {
        let mut hm = reqwest::header::HeaderMap::new();
        for (k, v) in headers {
            let (Ok(name), Ok(val)) = (reqwest::header::HeaderName::from_bytes(k.as_bytes()), reqwest::header::HeaderValue::from_str(v)) else {
                return Err(McpError::Transport("LocalProtocolError", format!("Illegal header value {}", crate::config::py_repr_str(k))));
            };
            hm.insert(name, val);
        }
        let build = |any_status: bool| {
            reqwest::Client::builder()
                .default_headers(hm.clone())
                .connect_timeout(std::time::Duration::from_secs(30))
                .read_timeout(std::time::Duration::from_secs(300))
                .redirect(origin_policy(any_status))
                .build()
                .map_err(|e| McpError::Transport("ConnectError", e.to_string()))
        };
        Ok(Http {
            url: url.to_string(),
            client: build(false)?,
            client_get: build(true)?,
            session_id: Mutex::new(None),
            protocol: Mutex::new(None),
            auth,
            get_stream: Mutex::new(None),
            replies: Mutex::new(vec![]),
        })
    }

    async fn send(&self, rb: reqwest::RequestBuilder, get: bool, started: Option<oneshot::Sender<()>>) -> Result<reqwest::Response, McpError> {
        let req = rb.build().map_err(transport_err)?;
        let client = if get { &self.client_get } else { &self.client };
        match &self.auth {
            Some(a) => a.send(client, req, started).await,
            None => {
                let r = client.execute(req).await.map_err(transport_err);
                if let Some(tx) = started {
                    let _ = tx.send(());
                }
                r
            }
        }
    }

    /// `_prepare_headers` — applied to every transport request.
    fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let client = if method == reqwest::Method::GET { &self.client_get } else { &self.client };
        let mut r = client.request(method, &self.url).header("accept", "application/json, text/event-stream").header("content-type", "application/json");
        if let Some(sid) = self.session_id.lock().unwrap().clone() {
            r = r.header("mcp-session-id", sid);
        }
        if let Some(v) = self.protocol.lock().unwrap().clone() {
            r = r.header("mcp-protocol-version", v);
        }
        r
    }

    fn sse_get(&self, last_event_id: Option<&str>) -> reqwest::RequestBuilder {
        let mut rb = self.request(reqwest::Method::GET).header("cache-control", "no-store");
        if let Some(id) = last_event_id {
            rb = rb.header("last-event-id", id);
        }
        rb
    }

    /// `_handle_post_request`. `want_id` is `None` for notifications and replies.
    async fn post(self: &Arc<Self>, msg: &Value, want_id: Option<i64>) -> Result<Option<Value>, McpError> {
        let rb = self.request(reqwest::Method::POST).body(serde_json::to_vec(msg).unwrap_or_default());
        let resp = self.send(rb, false, None).await?;
        let status = resp.status().as_u16();
        let is_request = want_id.is_some();
        if status == 202 {
            return if is_request { Err(rpc_err("server answered a request with 202 Accepted")) } else { Ok(None) };
        }
        if let Some(note) = unfollowed_redirect(&resp) {
            tracing::warn!("{note}");
            return if is_request { Err(rpc_err(note)) } else { Ok(None) };
        }
        if status >= 400 {
            if !is_request {
                return Ok(None);
            }
            if content_type(&resp).starts_with("application/json") {
                if let Ok(body) = resp.bytes().await {
                    if let Some(m) = serde_json::from_slice::<Value>(&body).ok().as_ref().and_then(jsonrpc_error_message) {
                        return Err(rpc_err(m));
                    }
                }
                tracing::debug!("Non-2xx body was not a JSON-RPC error; using fallback");
            }
            return Err(rpc_err(match status {
                404 if self.session_id.lock().unwrap().is_none() => "Not Found",
                404 => "Session terminated",
                _ => "Server returned an error response",
            }));
        }
        if msg.get("method").and_then(|m| m.as_str()) == Some("initialize") {
            if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty()) {
                *self.session_id.lock().unwrap() = Some(sid.to_string());
            }
        }
        if !is_request {
            return Ok(None);
        }
        let ctype = content_type(&resp);
        if ctype.starts_with("application/json") {
            let body = resp.bytes().await.map_err(|e| rpc_err(format!("Failed to parse JSON response: {e}")))?;
            let v: Value = serde_json::from_slice(&body).map_err(|e| rpc_err(format!("Failed to parse JSON response: {e}")))?;
            if !v.is_object() || v.get("jsonrpc").is_none() {
                return Err(rpc_err("Failed to parse JSON response: invalid JSON-RPC message"));
            }
            if v.get("method").is_some() {
                self.handle_server_message(&v);
                return Err(rpc_err("Connection closed"));
            }
            return rpc_result(v).map(Some);
        }
        if ctype.starts_with("text/event-stream") {
            let mut outcome = self.read_sse(resp, true).await;
            let mut attempt = 0;
            loop {
                match outcome {
                    SseOutcome::Done(r) => return r.map(Some),
                    SseOutcome::Ended { last_event_id: None, .. } => return Err(rpc_err("SSE stream ended without a response")),
                    SseOutcome::Ended { last_event_id: Some(id), retry_ms } => {
                        // `_handle_reconnection`
                        if attempt >= MAX_RECONNECTION_ATTEMPTS {
                            return Err(rpc_err("SSE stream ended and reconnection attempts were exhausted"));
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(retry_ms.unwrap_or(DEFAULT_RECONNECTION_DELAY_MS))).await;
                        match self.send(self.sse_get(Some(&id)), true, None).await {
                            Ok(r) if r.status().is_success() => {
                                attempt = 0;
                                outcome = match self.read_sse(r, true).await {
                                    SseOutcome::Ended { last_event_id, retry_ms: rm } => SseOutcome::Ended { last_event_id: last_event_id.or(Some(id)), retry_ms: rm.or(retry_ms) },
                                    done => done,
                                };
                            }
                            _ => {
                                attempt += 1;
                                outcome = SseOutcome::Ended { last_event_id: Some(id), retry_ms };
                            }
                        }
                    }
                }
            }
        }
        tracing::error!("Unexpected content type: {ctype}");
        Err(rpc_err(format!("Unexpected content type: {ctype}")))
    }

    /// Read an SSE body; `for_request` resolves on the first response/error.
    async fn read_sse(self: &Arc<Self>, resp: reqwest::Response, for_request: bool) -> SseOutcome {
        let mut stream = resp.bytes_stream();
        let mut parser = SseParser::default();
        let (mut last_event_id, mut retry_ms) = (None, None);
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            for ev in parser.feed(&chunk) {
                if let Some(id) = ev.id.filter(|s| !s.is_empty()) {
                    last_event_id = Some(id);
                }
                if ev.retry.is_some() {
                    retry_ms = ev.retry;
                }
                if ev.event != "message" {
                    tracing::warn!("Unknown SSE event: {}", ev.event);
                    continue;
                }
                if ev.data.is_empty() {
                    continue;
                }
                let msg = match serde_json::from_str::<Value>(&ev.data) {
                    Ok(m) if m.is_object() && m.get("jsonrpc").is_some() => m,
                    Ok(_) | Err(_) => {
                        tracing::error!("Error parsing SSE message");
                        if for_request {
                            return SseOutcome::Done(Err(rpc_err("Failed to parse SSE message: invalid JSON-RPC message")));
                        }
                        continue;
                    }
                };
                if msg.get("method").is_some() {
                    self.handle_server_message(&msg);
                } else if for_request && msg.get("id").is_some() {
                    return SseOutcome::Done(rpc_result(msg));
                }
            }
        }
        SseOutcome::Ended { last_event_id, retry_ms }
    }

    /// Server → client request: answer `ping`, reject the rest; drop notifications.
    fn handle_server_message(self: &Arc<Self>, msg: &Value) {
        let (Some(id), Some(method)) = (msg.get("id").cloned(), msg.get("method").and_then(|m| m.as_str())) else { return };
        let reply = if method == "ping" {
            json!({"jsonrpc": "2.0", "id": id, "result": {}})
        } else {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})
        };
        let me = self.clone();
        let h = tokio::spawn(async move {
            let _ = me.post(&reply, None).await;
        });
        let mut g = self.replies.lock().unwrap();
        g.retain(|t| !t.is_finished());
        g.push(h);
    }

    /// `handle_get_stream` — standalone GET SSE stream with auto-reconnect.
    async fn run_get_stream(self: Arc<Self>, mut started: Option<oneshot::Sender<()>>) {
        let mut attempt = 0;
        let mut last_event_id: Option<String> = None;
        let mut retry_ms: Option<u64> = None;
        while attempt < MAX_RECONNECTION_ATTEMPTS {
            if self.session_id.lock().unwrap().is_none() {
                return;
            }
            match self.send(self.sse_get(last_event_id.as_deref()), true, started.take()).await {
                Ok(resp) => {
                    if let Some(note) = unfollowed_redirect(&resp) {
                        tracing::warn!("GET stream not opened: {note}");
                        return;
                    }
                    if resp.status().is_success() && content_type(&resp).starts_with("text/event-stream") {
                        if let SseOutcome::Ended { last_event_id: l, retry_ms: r } = self.read_sse(resp, false).await {
                            last_event_id = l.or(last_event_id);
                            retry_ms = r.or(retry_ms);
                        }
                        attempt = 0;
                    } else {
                        tracing::debug!("GET stream error");
                        attempt += 1;
                    }
                }
                Err(_) => attempt += 1,
            }
            if attempt >= MAX_RECONNECTION_ATTEMPTS {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(retry_ms.unwrap_or(DEFAULT_RECONNECTION_DELAY_MS))).await;
        }
    }

    async fn close(&self, terminate: bool) {
        if let Some(h) = self.get_stream.lock().unwrap().take() {
            h.abort();
        }
        let replies: Vec<_> = std::mem::take(&mut *self.replies.lock().unwrap());
        if terminate {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), futures::future::join_all(replies)).await;
        } else {
            replies.iter().for_each(|h| h.abort());
        }
        if terminate && self.session_id.lock().unwrap().is_some() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), self.send(self.request(reqwest::Method::DELETE), false, None)).await;
        }
    }
}

// ── session ─────────────────────────────────────────────────────────────────

enum Transport {
    Stdio(Box<Stdio>),
    Http(Arc<Http>),
}

pub struct McpClient {
    transport: Transport,
    next_id: AtomicI64,
    tool_timeout: std::time::Duration,
}

/// Default deadline for `tools/call`; a server's `timeout` overrides it.
pub const DEFAULT_TOOL_TIMEOUT_S: u64 = 210;
/// Default deadline for every other request (`initialize`, `tools/list`, …).
pub const DEFAULT_REQUEST_TIMEOUT_S: u64 = 30;
/// Upper bound for a configured `timeout`.
pub const MAX_TIMEOUT_S: u64 = 270;

/// Cancels a request whose caller gave up (dropped or timed out) before the
/// reply: forgets its pending slot and sends `notifications/cancelled`, so
/// the server can stop the work. Disarmed once a reply (or a transport
/// error) settles the request.
struct CancelGuard<'a> {
    client: &'a McpClient,
    id: i64,
    method: &'a str,
    reason: &'static str,
    armed: bool,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.client.cancel_request(self.id, self.method, self.reason);
        }
    }
}

impl McpClient {
    pub fn stdio(command: &str, args: &[String], env: &[(String, String)]) -> Result<Self, McpError> {
        Ok(McpClient::with_transport(Transport::Stdio(Box::new(Stdio::spawn(command, args, env)?))))
    }

    pub fn http(url: &str, headers: &[(String, String)], auth: Option<crate::oauth::OAuthProvider>) -> Result<Self, McpError> {
        Ok(McpClient::with_transport(Transport::Http(Arc::new(Http::new(url, headers, auth)?))))
    }

    fn with_transport(transport: Transport) -> Self {
        McpClient { transport, next_id: AtomicI64::new(1), tool_timeout: std::time::Duration::from_secs(DEFAULT_TOOL_TIMEOUT_S) }
    }

    /// Use the server's configured `timeout` (seconds, clamped to
    /// [`MAX_TIMEOUT_S`]) for tool calls; `None` keeps the default.
    pub fn with_timeout(mut self, secs: Option<u64>) -> Self {
        if let Some(s) = secs {
            self.tool_timeout = std::time::Duration::from_secs(s.clamp(1, MAX_TIMEOUT_S));
        }
        self
    }

    /// Requests still waiting for a stdio reply (tests only).
    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        match &self.transport {
            Transport::Stdio(s) => s.pending.lock().unwrap().map.len(),
            Transport::Http(_) => 0,
        }
    }

    fn deadline(&self, method: &str) -> std::time::Duration {
        if method == "tools/call" {
            self.tool_timeout
        } else {
            self.tool_timeout.min(std::time::Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_S))
        }
    }

    /// See [`CancelGuard`]. `initialize` is never cancelled (MCP spec).
    fn cancel_request(&self, id: i64, method: &str, reason: &'static str) {
        let msg = json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": id, "reason": reason}});
        let send = method != "initialize";
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        match &self.transport {
            Transport::Stdio(s) => {
                let closed = {
                    let mut g = s.pending.lock().unwrap();
                    g.map.remove(&id);
                    g.closed
                };
                if send && !closed {
                    let mut line = msg.to_string();
                    line.push('\n');
                    rt.spawn(write_line(s.stdin.clone(), line));
                }
            }
            Transport::Http(h) => {
                if send {
                    let h = h.clone();
                    rt.spawn(async move {
                        let _ = h.post(&msg, None).await;
                    });
                }
            }
        }
    }

    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        // `JSONRPCDispatcher.send_raw_request`: `_meta` is always on the wire,
        // carrying the W3C `traceparent` of the `MCP send …` CLIENT span.
        let mut out_params = match params {
            Some(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        let mut meta = match out_params.get("_meta") {
            Some(Value::Object(m)) => m.clone(),
            _ => serde_json::Map::new(),
        };
        let target = out_params.get("name").and_then(|v| v.as_str()).map(|s| format!(" {s}")).unwrap_or_default();
        let span = SpanGuard(Some(Span::start(
            format!("MCP send {method}{target}"),
            SpanKind::Client,
            vec![("mcp.method.name", json!(method)), ("jsonrpc.request.id", json!(id.to_string()))],
        )));
        let sp = span.0.as_ref().expect("span");
        meta.insert("traceparent".into(), json!(sp.ctx().traceparent()));
        out_params.insert("_meta".into(), Value::Object(meta));
        let deadline = self.deadline(method);
        let mut guard = CancelGuard { client: self, id, method, reason: "The request was cancelled by the client.", armed: true };
        let res = match tokio::time::timeout(deadline, otel::scope(Some(sp.ctx()), self.request_inner(id, method, Value::Object(out_params)))).await {
            Ok(r) => {
                guard.armed = false;
                r
            }
            Err(_) => {
                guard.reason = "The request timed out.";
                Err(McpError::Rpc(format!("MCP request '{method}' timed out after {} s", deadline.as_secs())))
            }
        };
        drop(guard);
        span.finish();
        res
    }

    async fn request_inner(&self, id: i64, method: &str, params: Value) -> Result<Value, McpError> {
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        match &self.transport {
            Transport::Stdio(s) => {
                let (tx, rx) = oneshot::channel();
                {
                    let mut g = s.pending.lock().unwrap();
                    if g.closed {
                        return Err(McpError::Rpc("Connection closed".into()));
                    }
                    g.map.insert(id, tx);
                }
                if let Err(e) = s.write(&msg).await {
                    s.pending.lock().unwrap().map.remove(&id);
                    return Err(e);
                }
                rx.await.unwrap_or_else(|_| Err(McpError::Rpc("Connection closed".into())))
            }
            Transport::Http(h) => h.post(&msg, Some(id)).await.map(|v| v.unwrap_or(json!({}))),
        }
    }

    pub async fn notify(&self, method: &str) -> Result<(), McpError> {
        let msg = json!({"jsonrpc": "2.0", "method": method});
        match &self.transport {
            Transport::Stdio(s) => s.write(&msg).await,
            Transport::Http(h) => {
                let res = h.post(&msg, None).await.map(|_| ());
                if method == "notifications/initialized" && res.is_ok() {
                    // v2 starts the GET stream as the notification is sent; let it
                    // reach the wire before the next request.
                    let (tx, rx) = oneshot::channel();
                    let task = tokio::spawn(h.clone().run_get_stream(Some(tx)));
                    if let Some(old) = h.get_stream.lock().unwrap().replace(task) {
                        old.abort();
                    }
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), rx).await;
                }
                res
            }
        }
    }

    pub async fn initialize(&self) -> Result<Value, McpError> {
        let res = self.request("initialize", Some(json!({"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "mcp", "version": "0.1.0"}}))).await?;
        let negotiated = res.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
        if !HANDSHAKE_PROTOCOL_VERSIONS.contains(&negotiated) {
            return Err(McpError::Session("RuntimeError", format!("Unsupported protocol version from the server: {negotiated}")));
        }
        if let Transport::Http(h) = &self.transport {
            *h.protocol.lock().unwrap() = Some(negotiated.to_string());
        }
        self.notify("notifications/initialized").await?;
        Ok(res)
    }

    /// First page of `tools/list` (v2 never follows `nextCursor`).
    pub async fn list_tools(&self) -> Result<Vec<Value>, McpError> {
        let r = self.request("tools/list", None).await?;
        Ok(r.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default())
    }

    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, McpError> {
        self.request("tools/call", Some(json!({"name": name, "arguments": arguments}))).await
    }

    pub async fn read_resource(&self, uri: &str) -> Result<Value, McpError> {
        self.request("resources/read", Some(json!({"uri": uri}))).await
    }

    pub async fn list_resources(&self) -> Result<Value, McpError> {
        self.request("resources/list", None).await
    }

    pub async fn close(&self) {
        match &self.transport {
            Transport::Stdio(s) => s.close().await,
            Transport::Http(h) => h.close(true).await,
        }
    }

    /// Tear down after a transport failure. v2's task group is cancelled by
    /// the failing POST, so the session DELETE never goes out.
    pub async fn abort(&self) {
        match &self.transport {
            Transport::Stdio(s) => s.close().await,
            Transport::Http(h) => h.close(false).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&[u8]]) -> Vec<(String, String)> {
        let mut p = SseParser::default();
        chunks.iter().flat_map(|c| p.feed(c)).map(|e| (e.event, e.data)).collect()
    }

    #[test]
    fn sse_keeps_a_multibyte_char_split_across_chunks() {
        assert_eq!(events(&[b"data: {\"t\":\"\xC3", b"\xA9\"}\n\n"]), vec![("message".to_string(), "{\"t\":\"é\"}".to_string())]);
    }

    #[test]
    fn sse_joins_data_lines_and_names_events() {
        let got = events(&[b": ping\r\nevent: msg\r\nid: 7\r\ndata: a\r\nda", b"ta: b\r\n\r\n\ndata: c\n\n"]);
        assert_eq!(got, vec![("msg".to_string(), "a\nb".to_string()), ("message".to_string(), "c".to_string())]);
    }
}
