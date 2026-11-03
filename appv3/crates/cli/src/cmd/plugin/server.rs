//! The local server as the plugin commands see it: where it is, how it
//! answered, and the few accessors its JSON is read with.

use super::render::Tone;
use crate::net::{display_host, resolve_addr, server_settings};
use anyhow::Result;
use serde_json::Value;
use std::time::Duration;

/// How the local server answered.
#[derive(Debug, PartialEq)]
pub(super) enum Reply {
    /// Nothing is listening.
    Down,
    Json(Value),
    /// 401: the server wants an access key (`key_sent`: ours was refused).
    Denied {
        key_sent: bool,
    },
    /// 404: a server that predates the route.
    NotFound,
    Failed(u16),
}

fn classify(answer: Option<(u16, &[u8])>, key_sent: bool) -> Reply {
    match answer {
        None => Reply::Down,
        Some((200, body)) => serde_json::from_slice(body).map(Reply::Json).unwrap_or(Reply::Failed(200)),
        Some((401, _)) => Reply::Denied { key_sent },
        Some((404, _)) => Reply::NotFound,
        Some((status, _)) => Reply::Failed(status),
    }
}

/// A request function of `net` (`http_get_with_headers`, `http_post_with_headers`).
pub(super) type Request = fn(&str, u16, &str, &[(&str, &str)], Duration) -> Option<(u16, Vec<u8>)>;

/// The local server, found as `agentd doctor` finds it (`server.yaml`), with
/// the access key it enforces.
pub(super) struct Api {
    pub(super) host: String,
    pub(super) port: u16,
    key: String,
}

impl Api {
    pub(super) fn find() -> Result<Api> {
        let cfg = server_settings()?;
        let (host, port) = resolve_addr(None, None, &cfg);
        Ok(Api { host: display_host(&host), port, key: appv3_core::auth::configured_access_token() })
    }

    pub(super) fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    pub(super) fn call(&self, request: Request, path: &str, timeout: Duration) -> Reply {
        let bearer = format!("Bearer {}", self.key);
        let headers: Vec<(&str, &str)> = if self.key.is_empty() { vec![] } else { vec![("Authorization", bearer.as_str())] };
        let answer = request(&self.host, self.port, path, &headers, timeout);
        classify(answer.as_ref().map(|(status, body)| (*status, body.as_slice())), !self.key.is_empty())
    }
}

pub(super) fn state_tone(state: &str) -> (Tone, &'static str) {
    match state {
        "running" => (Tone::Good, "✓"),
        "failed" => (Tone::Bad, "✗"),
        "blocked" | "disabled" => (Tone::Warn, "⚠"),
        _ => (Tone::Dim, "·"),
    }
}

pub(super) fn text_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("unknown").to_string()
}

pub(super) fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replies_are_told_apart() {
        assert_eq!(classify(None, false), Reply::Down);
        assert_eq!(classify(Some((200, br#"{"bundles": []}"#)), false), Reply::Json(json!({"bundles": []})));
        assert_eq!(classify(Some((200, b"not json")), false), Reply::Failed(200));
        assert_eq!(classify(Some((401, b"{}")), true), Reply::Denied { key_sent: true });
        assert_eq!(classify(Some((401, b"{}")), false), Reply::Denied { key_sent: false });
        assert_eq!(classify(Some((404, b"")), false), Reply::NotFound);
        assert_eq!(classify(Some((503, b"")), false), Reply::Failed(503));
    }
}
