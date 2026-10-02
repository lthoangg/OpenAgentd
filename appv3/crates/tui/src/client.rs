//! HTTP client for the `openagentd` API: the same endpoints the web UI uses.

use crate::sse::SseParser;
use anyhow::{bail, Context, Result};
use futures::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

/// `POST /chat` result: `accepted` starts a turn now, `queued` waits for the
/// running one.
#[derive(Debug, Clone)]
pub struct ChatReply {
    pub status: String,
    pub session_id: String,
    pub message_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub running: bool,
    pub model: Option<String>,
}

/// What a stream task reports: one event, or the stream ending.
pub enum StreamMsg {
    Event(String, Value),
    /// `ok` is false when the connection failed rather than closed.
    Closed {
        ok: bool,
        events: usize,
    },
}

impl Client {
    pub fn new(base: &str, token: Option<String>) -> Result<Self> {
        let base = base.trim_end_matches('/').to_string();
        let url = reqwest::Url::parse(&base).with_context(|| format!("invalid server URL {base:?}"))?;
        let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(5));
        // A proxy must not see loopback traffic (the network guard would also
        // refuse the proxy's Host header).
        if url.host_str().is_some_and(|h| h == "localhost" || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())) {
            b = b.no_proxy();
        }
        Ok(Self { http: b.build()?, base, token: token.filter(|t| !t.is_empty()) })
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let r = self.http.request(method, format!("{}{path}", self.base));
        match &self.token {
            Some(t) => r.bearer_auth(t),
            None => r,
        }
    }

    async fn send_json(&self, rb: reqwest::RequestBuilder) -> Result<Value> {
        let resp = rb.timeout(Duration::from_secs(30)).send().await?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("{} ({})", detail(&body), status.as_u16());
        }
        Ok(body)
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.send_json(self.req(reqwest::Method::GET, path).query(query)).await
    }

    pub async fn health(&self) -> Result<Value> {
        self.get("/api/health/ready", &[]).await
    }

    pub async fn chat(&self, workspace: &str, session_id: Option<&str>, message: &str, mentions: &[String], model: Option<&str>) -> Result<ChatReply> {
        let mut form: Vec<(&str, String)> = vec![("workspace", workspace.into()), ("message", message.into())];
        if let Some(m) = model {
            form.push(("model", m.into()));
        }
        if let Some(s) = session_id {
            form.push(("session_id", s.into()));
        }
        if !mentions.is_empty() {
            form.push(("mentions", json!(mentions).to_string()));
        }
        let v = self.send_json(self.req(reqwest::Method::POST, "/api/agent/chat").form(&form)).await?;
        Ok(ChatReply { status: str_of(&v, "status"), session_id: str_of(&v, "session_id"), message_id: v.get("message_id").and_then(Value::as_str).map(String::from) })
    }

    pub async fn interrupt(&self, workspace: &str, session_id: &str) -> Result<()> {
        let form = [("workspace", workspace), ("session_id", session_id), ("interrupt", "true")];
        self.send_json(self.req(reqwest::Method::POST, "/api/agent/chat").form(&form)).await.map(drop)
    }

    pub async fn history(&self, session_id: &str) -> Result<Value> {
        self.get(&format!("/api/agent/{session_id}/history"), &[]).await
    }

    pub async fn latest_session(&self, workspace: &str) -> Result<Option<String>> {
        Ok(self.sessions(Some(workspace), 1).await?.into_iter().next().map(|s| s.id))
    }

    /// Newest sessions first, in `workspace` or (with `None`) in every folder.
    pub async fn sessions(&self, workspace: Option<&str>, limit: usize) -> Result<Vec<SessionRow>> {
        let limit = limit.to_string();
        let mut query = vec![("limit", limit.as_str())];
        if let Some(ws) = workspace {
            query.push(("workspace", ws));
        }
        let v = self.get("/api/agent/sessions", &query).await?;
        let rows = v.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(rows
            .iter()
            .map(|r| SessionRow {
                id: str_of(r, "id"),
                title: str_of(r, "title"),
                updated_at: str_of(r, "updated_at"),
                running: r.get("running").and_then(Value::as_bool).unwrap_or(false),
                model: r.get("model").and_then(Value::as_str).filter(|m| is_model_id(m)).map(String::from),
            })
            .collect())
    }

    /// Chat model ids from the registry (the web's model picker list).
    pub async fn models(&self) -> Result<Vec<String>> {
        let v = self.get("/api/agents/registry", &[]).await?;
        Ok(v.get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|m| m.get("output_image") != Some(&Value::Bool(true)) && m.get("output_video") != Some(&Value::Bool(true)))
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
            .collect())
    }

    /// Workspace-relative file paths for `@` mentions.
    pub async fn files(&self, workspace: &str) -> Result<Vec<String>> {
        let v = self.get("/api/agent/workspace/files/list", &[("workspace", workspace)]).await?;
        Ok(v.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(|f| f.get("path").and_then(Value::as_str).map(String::from)).collect())
    }

    pub async fn title(&self, session_id: &str) -> Result<String> {
        Ok(str_of(&self.get(&format!("/api/agent/sessions/{session_id}"), &[]).await?, "title"))
    }

    pub async fn plan(&self, session_id: &str) -> Result<Option<String>> {
        let v = self.get(&format!("/api/agent/sessions/{session_id}/plan"), &[]).await?;
        Ok(v.get("plan").and_then(|p| p.get("content")).and_then(Value::as_str).map(String::from))
    }

    pub async fn answer(&self, session_id: &str, question_id: &str, answers: &[Vec<String>]) -> Result<()> {
        let path = format!("/api/agent/{session_id}/question/{question_id}/answer");
        self.send_json(self.req(reqwest::Method::POST, &path).json(&json!({"answers": answers}))).await.map(drop)
    }

    pub async fn dismiss(&self, session_id: &str, question_id: &str) -> Result<()> {
        let path = format!("/api/agent/{session_id}/question/{question_id}/dismiss");
        self.send_json(self.req(reqwest::Method::POST, &path).json(&json!({}))).await.map(drop)
    }

    /// Read an SSE endpoint until it ends, sending each event through `tx`
    /// wrapped by `wrap`. Returns when the stream closes or the receiver is gone.
    pub async fn stream<T>(&self, path: &str, tx: UnboundedSender<T>, wrap: impl Fn(StreamMsg) -> T) {
        let mut events = 0;
        let resp = match self.req(reqwest::Method::GET, path).header("Accept", "text/event-stream").send().await {
            Ok(r) if r.status().is_success() => r,
            _ => {
                let _ = tx.send(wrap(StreamMsg::Closed { ok: false, events }));
                return;
            }
        };
        let mut parser = SseParser::default();
        let mut body = resp.bytes_stream();
        let mut ok = true;
        while let Some(chunk) = body.next().await {
            let Ok(chunk) = chunk else {
                ok = false;
                break;
            };
            for (name, data) in parser.feed(&chunk) {
                events += 1;
                if tx.send(wrap(StreamMsg::Event(name, data))).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(wrap(StreamMsg::Closed { ok, events }));
    }
}

/// A real `provider:model` id, not the unconfigured placeholder.
pub fn is_model_id(m: &str) -> bool {
    m.contains(':') && m != "__PROVIDER_MODEL__"
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The API's error text: `{"detail": "..."}` or a validation list.
fn detail(body: &Value) -> String {
    match body.get("detail") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items.iter().filter_map(|i| i.get("msg").and_then(Value::as_str)).collect::<Vec<_>>().join("; "),
        _ => "request failed".into(),
    }
}
