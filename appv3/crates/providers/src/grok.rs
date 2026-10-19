//! Grok Build (xAI subscription) — port of `providers/grok/*` (`grok.py`,
//! `oauth.py`, `usage.py`).

use crate::codex::say;
use crate::openai::{shared_client, should_use_responses, CompletionsDialect, OpenAiProvider};
use crate::plugin::*;
use crate::types::*;
use appv3_core::{settings, VERSION};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

pub const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const ISSUER: &str = "https://auth.x.ai";
pub const API_BASE: &str = "https://cli-chat-proxy.grok.com/v1";
pub const DEFAULT_MODEL: &str = "grok-4.5";
const SCOPES: [&str; 6] = ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"];
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

pub fn oauth_path() -> PathBuf {
    settings().cache_dir.join("grok_oauth.json")
}

fn now_s() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// `session_headers(access_token, model=...)`.
pub fn session_headers(token: &str, model: Option<&str>) -> Vec<(String, String)> {
    let mut h: Vec<(String, String)> = [
        ("Authorization", format!("Bearer {token}")),
        ("Content-Type", "application/json".into()),
        ("X-XAI-Token-Auth", "xai-grok-cli".into()),
        ("x-authenticateresponse", "authenticate-response".into()),
        ("x-grok-client-version", VERSION.into()),
        ("x-grok-client-identifier", "openagentd".into()),
        ("x-grok-client-mode", "interactive".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        h.push(("x-grok-model-override".into(), m.into()));
    }
    h
}

fn with_headers(mut req: reqwest::RequestBuilder, h: &[(String, String)]) -> reqwest::RequestBuilder {
    for (k, v) in h {
        req = req.header(k, v);
    }
    req
}

fn positive_seconds(v: Option<&Value>, default: i64) -> i64 {
    match v {
        Some(Value::Number(n)) if n.is_i64() || n.is_u64() => n.as_i64().filter(|x| *x > 0).unwrap_or(default),
        _ => default,
    }
}

// ── persistence ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GrokAuth {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: f64,
}

#[derive(Debug)]
pub enum RefreshError {
    /// `ValueError` (unrefreshable session / malformed response).
    Value(String),
    /// `httpx.HTTPError` (status or transport).
    Http(String),
}

impl std::fmt::Display for RefreshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RefreshError::Value(m) | RefreshError::Http(m) => f.write_str(m),
        }
    }
}

impl GrokAuth {
    pub fn load(path: &Path) -> Option<Self> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        let access_token = v.get("access_token")?.as_str()?.to_string();
        let refresh_token = match v.get("refresh_token") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return None,
        };
        let expires_at = match v.get("expires_at")? {
            Value::Number(n) => n.as_f64()?,
            Value::String(s) => s.trim().parse().ok()?,
            _ => return None,
        };
        Some(Self { access_token, refresh_token, expires_at })
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut m = Map::new();
        m.insert("access_token".into(), json!(self.access_token));
        m.insert("refresh_token".into(), json!(self.refresh_token));
        m.insert("expires_at".into(), Value::Number(serde_json::Number::from_f64(self.expires_at).unwrap_or_else(|| 0.into())));
        appv3_core::secret_files::write_secret_file(path, &(appv3_core::pyjson::dumps_indent(&Value::Object(m), 2) + "\n"))
    }

    pub fn is_expired(&self) -> bool {
        now_s() >= self.expires_at - 60.0
    }

    pub async fn refresh(&self, path: &Path) -> Result<Self, RefreshError> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _g = LOCK.lock().await;
        let current = Self::load(path);
        if let Some(c) = current.as_ref().filter(|c| !c.is_expired()) {
            return Ok(c.clone());
        }
        let source = current.unwrap_or_else(|| self.clone());
        let forget = || {
            let _ = std::fs::remove_file(path);
            let _ = appv3_core::runtime_settings::forget_provider_models("grok");
        };
        let Some(rt) = source.refresh_token.clone() else {
            forget();
            return Err(RefreshError::Value("Grok Build OAuth session cannot be refreshed. Reconnect it.".into()));
        };
        let url = format!("{ISSUER}/oauth2/token");
        let r = shared_client()
            .post(&url)
            .header("x-grok-client-version", VERSION)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(urlencode(&[("grant_type", "refresh_token"), ("refresh_token", &rt), ("client_id", CLIENT_ID)]))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| RefreshError::Http(e.to_string()))?;
        let st = r.status().as_u16();
        if st >= 400 {
            if st == 400 || st == 401 {
                forget();
            }
            return Err(RefreshError::Http(http_status_message(st, &url)));
        }
        let data: Value = r.json().await.map_err(|e| RefreshError::Value(e.to_string()))?;
        let Some(access) = data.get("access_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            return Err(RefreshError::Value("Grok Build token refresh returned no access token.".into()));
        };
        let rotated = data.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or(rt);
        let new = Self { access_token: access.into(), refresh_token: Some(rotated), expires_at: now_s() + positive_seconds(data.get("expires_in"), 3600) as f64 };
        new.save(path).map_err(|e| RefreshError::Value(e.to_string()))?;
        Ok(new)
    }
}

// ── provider ────────────────────────────────────────────────────────────────

/// `GrokBuildProvider` — OpenAI-compatible, re-reads the OAuth session
/// before every request and swaps headers when the token rotated.
pub struct GrokProvider {
    model: String,
    kw: Kwargs,
    pub provider_name: Option<String>,
    inner: RwLock<(String, Arc<OpenAiProvider>)>,
}

pub fn make_inner(model: &str, token: &str, kw: &Kwargs) -> Arc<OpenAiProvider> {
    let mut p = OpenAiProvider::with_headers(model, API_BASE, session_headers(token, Some(model)), kw.clone(), CompletionsDialect::OpenAi, true);
    p.use_responses = match kw.get("responses_api") {
        Some(v) => crate::plugin::truthy(v),
        None => model == "grok-4.5" || should_use_responses(kw),
    };
    p.responses.preserve_stateless_reasoning = true;
    p.provider_name = Some("grok".into());
    Arc::new(p)
}

async fn load_access_token() -> Result<String, String> {
    let path = oauth_path();
    let Some(mut auth) = GrokAuth::load(&path) else {
        return Err("Grok Build OAuth credentials not found. Run:\n  agentd auth grok\nto authenticate with your Grok subscription.".into());
    };
    if auth.is_expired() {
        auth = auth.refresh(&path).await.map_err(|_| "Grok Build token refresh failed. Run: agentd auth grok".to_string())?;
    }
    Ok(auth.access_token)
}

pub fn build(model: &str, model_kwargs: Kwargs) -> ProviderResult<Arc<dyn LlmProvider>> {
    // A valid token is a file read; only a refresh needs the async helper.
    let token = match GrokAuth::load(&oauth_path()) {
        Some(auth) if !auth.is_expired() => auth.access_token,
        _ => block_on_thread(load_access_token()).map_err(ProviderError::Invalid)?,
    };
    let inner = make_inner(model, &token, &model_kwargs);
    tracing::debug!("grok_build_provider model={}", model);
    Ok(Arc::new(GrokProvider { model: model.into(), kw: model_kwargs, provider_name: Some("grok".into()), inner: RwLock::new((token, inner)) }))
}

impl GrokProvider {
    /// `_refresh_session_if_needed`.
    async fn current(&self) -> ProviderResult<Arc<OpenAiProvider>> {
        let path = oauth_path();
        let Some(mut auth) = GrokAuth::load(&path) else {
            return Err(ProviderError::Invalid("Grok Build OAuth credentials not found. Run: agentd auth grok".into()));
        };
        if auth.is_expired() {
            auth = auth.refresh(&path).await.map_err(|_| ProviderError::Invalid("Grok Build token refresh failed. Run: agentd auth grok".into()))?;
        }
        {
            let g = self.inner.read().unwrap();
            if g.0 == auth.access_token {
                return Ok(g.1.clone());
            }
        }
        let inner = make_inner(&self.model, &auth.access_token, &self.kw);
        *self.inner.write().unwrap() = (auth.access_token, inner.clone());
        Ok(inner)
    }
}

#[async_trait]
impl LlmProvider for GrokProvider {
    fn model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> Option<&str> {
        self.provider_name.as_deref()
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        self.current().await?.chat(messages, tools, kwargs).await
    }
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        self.current().await?.stream(messages, tools, kwargs).await
    }
}

/// `model_discovery._grok_models()`.
pub async fn discover_models() -> Result<Vec<String>, String> {
    let path = oauth_path();
    let Some(mut auth) = GrokAuth::load(&path) else { return Ok(vec![]) };
    if auth.is_expired() {
        auth = auth.refresh(&path).await.map_err(|e| e.to_string())?;
    }
    let url = format!("{API_BASE}/models");
    let r = with_headers(shared_client().get(&url), &session_headers(&auth.access_token, None)).timeout(Duration::from_secs(3)).send().await.map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    if st >= 400 {
        return Err(http_status_message(st, &url));
    }
    let data: Value = r.json().await.map_err(|e| e.to_string())?;
    let mut out: Vec<String> = data.get("data").and_then(|d| d.as_array()).into_iter().flatten().filter_map(|i| i.get("id").and_then(|x| x.as_str()).map(String::from)).collect();
    out.sort();
    Ok(out)
}

// ── usage ───────────────────────────────────────────────────────────────────

pub use crate::codex::UsageError;

fn number(v: Option<&Value>) -> Option<f64> {
    v.filter(|x| x.is_number()).and_then(|x| x.as_f64())
}

fn wrapped(values: &Map<String, Value>, key: &str) -> Option<f64> {
    number(values.get(key)?.as_object()?.get("val"))
}

fn parse_ts(v: Option<&Value>) -> Option<i64> {
    v.filter(|x| x.as_str().map(|s| !s.is_empty()).unwrap_or(false)).and_then(|x| parse_iso_ts(Some(x)))
}

fn window(used: f64, start: Option<i64>, end: Option<i64>) -> UsageWindow {
    let minutes = match (start, end) {
        (Some(s), Some(e)) if e > s => Some((e - s).div_euclid(60)),
        _ => None,
    };
    UsageWindow { used_percent: used.clamp(0.0, 100.0), window_minutes: minutes, resets_at: end }
}

/// Python `f"{x:g}"`.
fn fmt_g(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let exp = x.abs().log10().floor() as i32;
    if !(-4..6).contains(&exp) {
        let s = format!("{:.5e}", x);
        let (m, e) = s.split_once('e').unwrap();
        let m = if m.contains('.') { m.trim_end_matches('0').trim_end_matches('.') } else { m };
        let e: i32 = e.parse().unwrap();
        return format!("{m}e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs());
    }
    let decimals = (5 - exp).max(0) as usize;
    let s = format!("{:.*}", decimals, x);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

fn limits(values: &Map<String, Value>) -> Vec<UsageLimit> {
    let period = values.get("currentPeriod").and_then(|p| p.as_object()).cloned().unwrap_or_default();
    let name = match period.get("type").and_then(|t| t.as_str()) {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => "Weekly usage period",
        Some("USAGE_PERIOD_TYPE_MONTHLY") => "Monthly usage period",
        _ => "Usage period",
    };
    let pick = |a: &str, b: &str| period.get(a).filter(|v| crate::plugin::truthy(v)).or_else(|| values.get(b)).cloned();
    let start = parse_ts(pick("start", "billingPeriodStart").as_ref());
    let end = parse_ts(pick("end", "billingPeriodEnd").as_ref());
    let reported = number(values.get("creditUsagePercent"));
    let mut out = vec![];
    if start.is_some() || end.is_some() || reported.is_some() {
        out.push(UsageLimit {
            limit_id: Some("grok_build".into()),
            limit_name: Some(name.into()),
            primary: reported.map(|r| window(r, start, end)),
            period_start_at: start,
            period_end_at: end,
            ..Default::default()
        });
    }
    let cap = wrapped(values, "onDemandCap");
    let used = wrapped(values, "onDemandUsed");
    if let (Some(c), Some(u)) = (cap.filter(|c| *c > 0.0), used) {
        out.push(UsageLimit {
            limit_id: Some("grok_on_demand".into()),
            limit_name: Some("On-demand cap".into()),
            primary: Some(window(100.0 * u / c, start, end)),
            period_start_at: start,
            period_end_at: end,
            ..Default::default()
        });
    }
    if let Some(b) = wrapped(values, "prepaidBalance").filter(|b| *b > 0.0) {
        out.push(UsageLimit {
            limit_id: Some("grok_prepaid".into()),
            limit_name: Some("Prepaid credits".into()),
            credits: Some(json!({"has_credits": true, "unlimited": false, "balance": format!("{} credits", fmt_g(b))})),
            ..Default::default()
        });
    }
    out
}

/// `grok.usage.get_usage()`.
pub async fn get_usage() -> Result<Value, UsageError> {
    let path = oauth_path();
    let Some(auth) = GrokAuth::load(&path) else { return Err(UsageError::Credentials("Grok Build OAuth credentials not found.".into())) };
    let res: Result<Value, String> = async {
        let auth = if auth.is_expired() { auth.refresh(&path).await.map_err(|e| e.to_string())? } else { auth };
        let url = format!("{API_BASE}/billing?format=credits");
        let r = with_headers(shared_client().get(&url), &session_headers(&auth.access_token, None)).timeout(Duration::from_secs(5)).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 400 {
            return Err(http_status_message(st, &url));
        }
        r.json::<Value>().await.map_err(|e| e.to_string())
    }
    .await;
    let payload = match res {
        Ok(p) => p,
        Err(e) => {
            tracing::info!("provider_usage_unavailable provider=grok error={}", e);
            return Err(UsageError::Unavailable("Provider usage unavailable.".into()));
        }
    };
    usage_from_payload(&payload)
}

/// The response-parsing half of `get_usage` (pure).
pub fn usage_from_payload(payload: &Value) -> Result<Value, UsageError> {
    let Some(config) = payload.as_object().and_then(|p| p.get("config")).and_then(|c| c.as_object()) else {
        return Err(UsageError::Unavailable("Provider usage response was invalid.".into()));
    };
    Ok(usage_response("grok", limits(config)))
}

// ── OAuth device login ──────────────────────────────────────────────────────

fn validate_verification_uri(uri: &str) -> Result<(), String> {
    if let Ok(u) = url::Url::parse(uri) {
        let host = u.host_str().unwrap_or("").to_lowercase();
        if u.scheme() == "https" && (host == "accounts.x.ai" || host == "auth.x.ai") {
            return Ok(());
        }
        if u.scheme() == "http" && (host == "localhost" || host == "127.0.0.1") {
            return Ok(());
        }
    }
    Err("Grok Build returned an unsafe verification URI.".into())
}

enum VerifyErr {
    Rejected,
    Warn,
}

async fn verify_access(token: &str) -> Result<(), VerifyErr> {
    let r = with_headers(shared_client().get(format!("{API_BASE}/models")), &session_headers(token, None))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| VerifyErr::Warn)?;
    match r.status().as_u16() {
        401 | 403 => Err(VerifyErr::Rejected),
        s if s >= 400 => Err(VerifyErr::Warn),
        _ => Ok(()),
    }
}

async fn success(auth: &GrokAuth, path: &Path, sink: Option<&OAuthSink>, already: bool) -> Result<(), String> {
    say(sink, "verifying", "Verifying Grok Build access...", json!({}));
    match verify_access(&auth.access_token).await {
        Err(VerifyErr::Rejected) => return Err("Grok Build rejected the saved OAuth session.".into()),
        Err(VerifyErr::Warn) => say(sink, "warning", "Authorization succeeded, but Grok Build could not be verified right now.", json!({})),
        Ok(()) => {}
    }
    auth.save(path).map_err(|e| e.to_string())?;
    say(
        sink,
        "success",
        &format!("Grok Build connected. Saved credentials to {}.", path.display()),
        json!({"oauth_path": path.display().to_string(), "suggested_model": format!("grok:{DEFAULT_MODEL}"), "already_authenticated": already}),
    );
    Ok(())
}

fn client_form(req: reqwest::RequestBuilder, surface: &str, form: &[(&str, &str)]) -> reqwest::RequestBuilder {
    req.header("x-grok-client-version", VERSION)
        .header("x-grok-client-surface", surface)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(urlencode(form))
        .timeout(Duration::from_secs(30))
}

async fn device_flow(path: &Path, sink: Option<&OAuthSink>) -> Result<(), String> {
    let surface = if sink.is_some() { "ui" } else { "cli" };
    say(sink, "requesting_device_code", "Requesting device code...", json!({}));
    let url = format!("{ISSUER}/oauth2/device/code");
    let scope = SCOPES.join(" ");
    let r = client_form(shared_client().post(&url), surface, &[("client_id", CLIENT_ID), ("scope", &scope), ("referrer", "openagentd")]).send().await.map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    if st >= 400 {
        return Err(http_status_message(st, &url));
    }
    let device: Value = r.json().await.map_err(|e| e.to_string())?;
    let Some(device_code) = device.get("device_code").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from) else {
        return Err("Grok Build returned no device code.".into());
    };
    let user_code = device.get("user_code").and_then(|v| v.as_str()).filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    let Some(user_code) = user_code.map(String::from) else { return Err("Grok Build returned an invalid user code.".into()) };
    let Some(verification_uri) = device.get("verification_uri").and_then(|v| v.as_str()).map(String::from) else {
        return Err("Grok Build returned no verification URI.".into());
    };
    validate_verification_uri(&verification_uri)?;
    let complete = match device.get("verification_uri_complete") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            validate_verification_uri(s)?;
            Some(s.clone())
        }
        Some(_) => return Err("Grok Build returned an invalid verification URI.".into()),
    };
    let display = complete.filter(|s| !s.is_empty()).unwrap_or(verification_uri);
    let expires_in = positive_seconds(device.get("expires_in"), 600);
    say(sink, "device_code", &format!("Open: {display}  Code: {user_code}"), json!({"verification_uri": display, "user_code": user_code, "expires_in": expires_in}));
    let mut interval = positive_seconds(device.get("interval"), 5) as u64;
    let started = std::time::Instant::now();
    let token_url = format!("{ISSUER}/oauth2/token");
    while started.elapsed().as_secs_f64() < expires_in as f64 {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        say(sink, "polling", "Waiting for Grok authorization...", json!({"elapsed_s": started.elapsed().as_secs()}));
        let r = client_form(shared_client().post(&token_url), surface, &[("grant_type", DEVICE_GRANT_TYPE), ("device_code", &device_code), ("client_id", CLIENT_ID)])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if (200..300).contains(&st) {
            let td: Value = r.json().await.map_err(|e| e.to_string())?;
            let Some(access) = td.get("access_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                return Err("Grok Build returned no access token.".into());
            };
            let auth = GrokAuth {
                access_token: access.into(),
                refresh_token: td.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from),
                expires_at: now_s() + positive_seconds(td.get("expires_in"), 3600) as f64,
            };
            say(sink, "token_acquired", "Grok Build token received.", json!({}));
            return success(&auth, path, sink, false).await;
        }
        let body = r.text().await.unwrap_or_default();
        let Ok(err) = serde_json::from_str::<Value>(&body) else {
            return Err(http_status_message(st, &token_url));
        };
        match err.get("error").and_then(|e| e.as_str()) {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                interval += 5;
                continue;
            }
            Some("access_denied") => return Err("Grok Build authorization was denied.".into()),
            Some("expired_token") => return Err("Grok Build device code expired. Try again.".into()),
            _ => return Err("Grok Build token exchange failed.".into()),
        }
    }
    Err("Grok Build device code expired. Try again.".into())
}

/// `grok.oauth.login(event_sink=...)` (RFC 8628 device flow).
pub async fn login(sink: Option<OAuthSink>) -> Result<(), String> {
    let sink = sink.as_ref();
    let path = oauth_path();
    say(sink, "started", "Starting Grok Build device login...", json!({}));
    if let Some(existing) = GrokAuth::load(&path) {
        let res: Result<(), String> = async {
            let auth = if existing.is_expired() { existing.refresh(&path).await.map_err(|e| e.to_string())? } else { existing };
            success(&auth, &path, sink, true).await
        }
        .await;
        if res.is_ok() {
            return Ok(());
        }
    }
    match device_flow(&path, sink).await {
        Ok(()) => Ok(()),
        Err(e) => {
            say(sink, "failed", &e, json!({"reason": "exception"}));
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_g_matches_python() {
        assert_eq!(fmt_g(12.0), "12");
        assert_eq!(fmt_g(12.5), "12.5");
        assert_eq!(fmt_g(1234567.0), "1.23457e+06");
        assert_eq!(fmt_g(0.0001), "0.0001");
        assert_eq!(fmt_g(100000.0), "100000");
    }

    #[test]
    fn usage_limits() {
        let cfg = json!({"currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-01-01T00:00:00Z", "end": "2026-01-08T00:00:00Z"},
                         "creditUsagePercent": 120, "onDemandCap": {"val": 10}, "onDemandUsed": {"val": 5}, "prepaidBalance": {"val": 3.5}});
        let l = limits(cfg.as_object().unwrap());
        assert_eq!(l.len(), 3);
        assert_eq!(l[0].primary.as_ref().unwrap().used_percent, 100.0);
        assert_eq!(l[0].primary.as_ref().unwrap().window_minutes, Some(7 * 24 * 60));
        assert_eq!(l[1].primary.as_ref().unwrap().used_percent, 50.0);
        assert_eq!(l[2].credits.as_ref().unwrap()["balance"], "3.5 credits");
    }
}
