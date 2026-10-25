//! Provider plugins — port of `plugin_api.py` + `plugin_registry.py`.
//!
//! v2 loads Python modules exposing `provider = ProviderPlugin(...)`. v3 loads
//! JavaScript/TypeScript files exporting `provider` (see `appv3-jsplugin` and
//! [`crate::js_plugin`]) from the same `settings.plugins_dirs`; the `*.py`
//! files are never read, so both versions can share a plugins directory.

use crate::creds::CredentialStore;
use crate::types::*;
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// `OAuthEventSink = Callable[[str, dict], None]`.
pub type OAuthSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub fn noop_sink() -> OAuthSink {
    Arc::new(|_, _| {})
}

#[derive(Debug, Clone)]
pub struct CredentialField {
    pub name: String,
    pub label: String,
    pub secret: bool,
    pub required: bool,
    pub placeholder: String,
}

#[derive(Debug, Clone, Default)]
pub struct PluginInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    /// `api_key` | `oauth`
    pub kind: String,
    pub credentials: Vec<CredentialField>,
    pub models_dev_provider_id: String,
    pub metadata_source_provider: String,
    pub model_registry_aliases: Vec<(String, String)>,
    pub docs_url: String,
    pub oauth_command: String,
    pub supports_fast_mode: bool,
    pub supports_prompt_cache_key: bool,
    pub supports_multiple_credentials: bool,
}

/// `ProviderBuildContext`.
pub struct BuildContext {
    pub provider_id: String,
    pub model: String,
    pub model_kwargs: Kwargs,
    pub credentials: CredentialStore,
}

/// Error raised by a plugin `get_usage` (`ValueError` → credentials problem).
pub enum PluginUsageError {
    Value(String),
    Other(String),
}

#[async_trait]
pub trait ProviderPlugin: Send + Sync {
    fn info(&self) -> &PluginInfo;
    /// Plugin file this provider came from (plugin status API).
    fn source(&self) -> Option<&std::path::Path> {
        None
    }
    fn build(&self, ctx: BuildContext) -> ProviderResult<Arc<dyn LlmProvider>>;
    fn has_login(&self) -> bool {
        false
    }
    async fn login(&self, _sink: OAuthSink) -> Result<(), String> {
        Ok(())
    }
    async fn login_for(&self, sink: OAuthSink, _store: CredentialStore) -> Result<(), String> {
        self.login(sink).await
    }
    fn has_oauth_callback(&self) -> bool {
        false
    }
    async fn oauth_callback(&self, _code: &str, _sink: OAuthSink) -> Result<(), String> {
        Ok(())
    }
    async fn oauth_callback_for(&self, code: &str, sink: OAuthSink, _store: CredentialStore) -> Result<(), String> {
        self.oauth_callback(code, sink).await
    }
    /// `None` when the plugin defines no `is_configured`.
    fn is_configured(&self, _store: &CredentialStore) -> Option<bool> {
        None
    }
    fn has_discover_models(&self) -> bool {
        false
    }
    async fn discover_models(&self, _store: &CredentialStore) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    fn has_usage(&self) -> bool {
        false
    }
    async fn get_usage(&self, _store: &CredentialStore) -> Result<Value, PluginUsageError> {
        Err(PluginUsageError::Other("unsupported".into()))
    }
}

pub type PluginRef = Arc<dyn ProviderPlugin>;

fn load() -> Vec<PluginRef> {
    crate::js_plugin::register_natives();
    let mut loaded: Vec<PluginRef> = vec![];
    for js in appv3_jsplugin::plugins() {
        let Some(plugin) = crate::js_plugin::JsProviderPlugin::from_plugin(js) else { continue };
        let id = plugin.info().id.clone();
        if loaded.iter().any(|p| p.info().id == id) {
            tracing::warn!("provider_plugin_duplicate id={} file={}", id, js.path.display());
            appv3_jsplugin::report_problem(&js.path, format!("duplicate provider id {id:?}; another plugin file already provides it"));
            continue;
        }
        loaded.push(Arc::new(plugin));
    }
    loaded
}

/// `provider_plugins()` — cached for the process lifetime (as in v2).
pub fn provider_plugins() -> &'static Vec<PluginRef> {
    static CACHE: OnceLock<Vec<PluginRef>> = OnceLock::new();
    CACHE.get_or_init(load)
}

pub fn find_provider_plugin(id: &str) -> Option<PluginRef> {
    provider_plugins().iter().find(|p| p.info().id == id).cloned()
}

/// `credential_map(fields)`.
pub fn credential_map(fields: &[CredentialField]) -> Value {
    Value::Array(fields.iter().map(|f| json!({"name": f.name, "label": f.label, "secret": f.secret, "required": f.required, "placeholder": f.placeholder})).collect())
}

/// Catalog entry for a plugin (v2 `catalog.all_providers`).
pub fn catalog_entry(p: &PluginInfo) -> Value {
    let mut aliases = Map::new();
    for (k, v) in &p.model_registry_aliases {
        aliases.insert(k.clone(), json!(v));
    }
    json!({
        "id": p.id,
        "label": p.label,
        "description": p.description,
        "kind": p.kind,
        "env_var": p.credentials.first().map(|f| f.name.clone()).unwrap_or_default(),
        "env_vars": p.credentials.iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
        "oauth_command": p.oauth_command,
        "docs_url": p.docs_url,
        "models_dev_provider_id": p.models_dev_provider_id,
        "metadata_source_provider": p.metadata_source_provider,
        "model_registry_aliases": aliases,
        "supports_fast_mode": p.supports_fast_mode,
        "supports_prompt_cache_key": p.supports_prompt_cache_key,
        "supports_multiple_credentials": p.supports_multiple_credentials,
        "credentials": credential_map(&p.credentials),
    })
}

// ── usage response schema (`app/api/schemas/settings.py`) ──────────────────

#[derive(Debug, Clone, Serialize, Default)]
pub struct UsageWindow {
    pub used_percent: f64,
    pub window_minutes: Option<i64>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UsageLimit {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub credits: Option<Value>,
    pub spend: Option<Value>,
    pub plan_type: Option<String>,
    pub rate_limit_reached_type: Option<String>,
    pub reset_credits_available: Option<i64>,
    pub period_start_at: Option<i64>,
    pub period_end_at: Option<i64>,
}

pub fn usage_response(provider: &str, limits: Vec<UsageLimit>) -> Value {
    json!({"provider": provider, "limits": limits})
}

// ── helpers shared by the OAuth plugins ────────────────────────────────────

pub fn b64url(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

pub fn sha256_hex(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    b
}

/// `(verifier, challenge)` like `_generate_pkce`.
pub fn generate_pkce() -> (String, String) {
    use sha2::Digest;
    let verifier = b64url(&random_bytes(64));
    let challenge = b64url(&sha2::Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn pkce_challenge(verifier: &str) -> String {
    use sha2::Digest;
    b64url(&sha2::Sha256::digest(verifier.as_bytes()))
}

/// Python `urllib.parse.quote_plus`.
pub fn quote_plus(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Python `urlencode(dict)`.
pub fn urlencode(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", quote_plus(k), quote_plus(v))).collect::<Vec<_>>().join("&")
}

fn unquote_plus(s: &str) -> String {
    let s = s.replace('+', " ");
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hexv = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hexv(bytes[i + 1]), hexv(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Python `parse_qs(qs)` (blank values dropped) → key → values.
pub fn parse_qs(qs: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for pair in qs.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => continue,
        };
        if v.is_empty() {
            continue;
        }
        out.entry(unquote_plus(k)).or_default().push(unquote_plus(v));
    }
    out
}

pub fn qs_first(q: &HashMap<String, Vec<String>>, key: &str) -> String {
    q.get(key).and_then(|v| v.first()).cloned().unwrap_or_default()
}

/// `urlparse(text).query`.
pub fn url_query(text: &str) -> &str {
    let no_frag = text.split_once('#').map(|(a, _)| a).unwrap_or(text);
    no_frag.split_once('?').map(|(_, q)| q).unwrap_or("")
}

/// `int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())`.
pub fn parse_iso_ts(value: Option<&Value>) -> Option<i64> {
    let s = value?.as_str().filter(|s| !s.is_empty())?;
    let s = s.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
        return Some(dt.timestamp());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%d %H:%M:%S%.f%:z"] {
        if let Ok(dt) = chrono::DateTime::parse_from_str(&s, fmt) {
            return Some(dt.timestamp());
        }
    }
    // Naive timestamps are local time in Python.
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(&s, fmt) {
            use chrono::TimeZone;
            return chrono::Local.from_local_datetime(&ndt).single().map(|d| d.timestamp());
        }
    }
    // Date-only → local midnight (`datetime.fromisoformat("2026-01-01")`).
    if let Ok(d) = chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d") {
        use chrono::TimeZone;
        return chrono::Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).single().map(|d| d.timestamp());
    }
    None
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Python `int(x or 0)` on a JSON value.
pub fn py_int(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or_else(|| n.as_f64().map(|f| f as i64).unwrap_or(0)),
        Some(Value::String(s)) if !s.is_empty() => s.trim().parse().unwrap_or(0),
        Some(Value::Bool(b)) => i64::from(*b),
        _ => 0,
    }
}

/// Load a JSON object file (`{}` on any error / non-object).
pub fn load_json_obj(path: &std::path::Path) -> Map<String, Value> {
    match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// `json.dump(data, fh)` (Python default separators).
pub fn save_json_obj(path: &std::path::Path, data: &Map<String, Value>) -> std::io::Result<()> {
    std::fs::write(path, appv3_core::pyjson::dumps(&Value::Object(data.clone())))
}

/// Run a future to completion on a private runtime thread — used where v2
/// performs synchronous `httpx` calls from sync code (e.g. provider build).
/// Run `fut` to completion from sync code (provider builders) on a helper
/// thread with its own runtime, since the caller may already be inside one.
/// On a multi-thread runtime the wait uses `block_in_place`, so the caller's
/// worker hands its other tasks to another thread instead of stalling them.
/// Pass lazy futures (`async fn` calls): a timer created eagerly here binds to
/// the caller's runtime.
pub fn block_on_thread<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let run = move || {
        std::thread::spawn(move || tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(fut)).join().expect("block_on_thread panicked")
    };
    match tokio::runtime::Handle::try_current() {
        Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => tokio::task::block_in_place(run),
        _ => run(),
    }
}

/// Python truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Write a minimal `http.server.BaseHTTPRequestHandler`-style response and
/// close the socket (local OAuth redirect listeners).
pub async fn write_response(sock: &mut tokio::net::TcpStream, status: u16, reason: &str, html: Option<String>) {
    use tokio::io::AsyncWriteExt;
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT");
    let mut head = format!("HTTP/1.0 {status} {reason}\r\nServer: BaseHTTP/0.6 Python/3.14\r\nDate: {date}\r\n");
    if html.is_some() {
        head.push_str("Content-Type: text/html\r\n");
    }
    head.push_str("\r\n");
    let _ = sock.write_all(head.as_bytes()).await;
    if let Some(b) = html {
        let _ = sock.write_all(b.as_bytes()).await;
    }
    let _ = sock.shutdown().await;
}

/// Python `repr(str)` (single-quoted unless the string contains `'` only).
pub fn py_repr_str(s: &str) -> String {
    let use_double = s.contains('\'') && !s.contains('"');
    let q = if use_double { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// httpx `HTTPStatusError` message for a response (`raise_for_status`).
pub fn http_status_message(status: u16, url: &str) -> String {
    ProviderError::http(status, url, String::new(), vec![]).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qs_helpers_match_python() {
        assert_eq!(quote_plus("a b:c/d~*"), "a+b%3Ac%2Fd~%2A");
        let q = parse_qs("code=a%20b&state=x+y&empty=");
        assert_eq!(qs_first(&q, "code"), "a b");
        assert_eq!(qs_first(&q, "state"), "x y");
        assert!(!q.contains_key("empty"));
        assert_eq!(url_query("https://x/cb?code=1&state=2#frag"), "code=1&state=2");
        assert_eq!(url_query("abc#def"), "");
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(parse_iso_ts(Some(&json!("2026-01-01T00:00:00Z"))), Some(1767225600));
        assert_eq!(parse_iso_ts(Some(&json!("2026-01-01T00:00:00.123456+00:00"))), Some(1767225600));
        assert_eq!(parse_iso_ts(Some(&json!("nope"))), None);
    }

    async fn answer() -> u32 {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        42
    }

    #[test]
    fn block_on_thread_works_outside_any_runtime() {
        assert_eq!(block_on_thread(answer()), 42);
    }

    #[test]
    fn block_on_thread_works_inside_a_current_thread_runtime() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert_eq!(rt.block_on(async { block_on_thread(answer()) }), 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn block_on_thread_works_on_workers_and_blocking_threads() {
        assert_eq!(tokio::spawn(async { block_on_thread(answer()) }).await.unwrap(), 42);
        assert_eq!(tokio::task::spawn_blocking(|| block_on_thread(answer())).await.unwrap(), 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn waiting_on_block_on_thread_does_not_stall_the_worker() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let ticks = std::sync::Arc::new(AtomicUsize::new(0));
        let t = ticks.clone();
        let ticker = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                t.fetch_add(1, SeqCst);
            }
        });
        let t = ticks.clone();
        let during = tokio::spawn(async move {
            let before = t.load(SeqCst);
            // Lazy (async block): an eagerly built Sleep binds to this
            // runtime's timer, which the blocked worker could never fire.
            block_on_thread(async { tokio::time::sleep(std::time::Duration::from_millis(150)).await });
            t.load(SeqCst) - before
        })
        .await
        .unwrap();
        ticker.abort();
        assert!(during >= 3, "other tasks on the worker advanced only {during} times during the wait");
    }
}
