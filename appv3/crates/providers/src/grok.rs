//! Grok Build (xAI subscription) — port of `providers/grok/*` (`grok.py`,
//! `oauth.py`, `usage.py`).

use crate::codex::say;
use crate::oauth::TokenSlot;
use crate::openai::{set_header, shared_client, CompletionsDialect, Flavor, OpenAiProvider};
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
/// Grok Build's default model since 1.0.40; the live `/models` catalog wins when it disagrees.
pub const DEFAULT_MODEL: &str = "grok-4.7";
const MODELS_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const SCOPES: [&str; 6] = ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"];
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// The Grok account currently serving requests.
pub fn oauth_slot() -> TokenSlot {
    TokenSlot::active("grok")
}

fn now_s() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// The access token's `sub` claim (the xAI user id), read without verification.
pub(crate) fn token_subject(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&crate::codex::b64_lenient(payload)?).ok()?;
    claims.get("sub")?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// `session_headers(access_token, model=...)` — what every cli-chat-proxy
/// request carries (Grok Build's `inject_proxy_headers` plus `x-userid`).
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
    if let Some(sub) = token_subject(token) {
        h.push(("x-userid".into(), sub));
    }
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        h.push(("x-grok-model-override".into(), m.into()));
    }
    h
}

/// Per-request sampling headers (Grok Build's `GrokRequestHeaders`): the
/// conversation and session the request belongs to, and a fresh request id.
pub fn request_headers(base: &[(String, String)], merged: &Kwargs) -> Vec<(String, String)> {
    let mut h = base.to_vec();
    if let Some(sid) = merged.get("session_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        set_header(&mut h, "x-grok-conv-id", sid);
        set_header(&mut h, "x-grok-session-id", sid);
    }
    set_header(&mut h, "x-grok-req-id", &uuid::Uuid::new_v4().to_string());
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

/// How a failed refresh is handled, per Grok Build's `classify_terminal`.
#[derive(Debug)]
enum RefreshFailure {
    /// The IdP rejected the refresh token or client: the session is gone.
    Terminal,
    /// 5xx, 429, a bare 4xx, or any other OAuth error code: retry, keep the session.
    Transient,
}

fn refresh_failure(status: u16, body: &str) -> RefreshFailure {
    let code = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from));
    match code.as_deref() {
        Some("invalid_grant" | "invalid_client") if status < 500 => RefreshFailure::Terminal,
        _ => RefreshFailure::Transient,
    }
}

/// Backoff before each retry: Grok Build makes up to three attempts.
const REFRESH_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(200), Duration::from_secs(1)];

impl GrokAuth {
    pub fn load(slot: &TokenSlot) -> Option<Self> {
        Self::from_doc(&slot.load()?)
    }

    pub fn from_doc(v: &Value) -> Option<Self> {
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

    pub fn to_doc(&self) -> Value {
        let mut m = Map::new();
        m.insert("access_token".into(), json!(self.access_token));
        m.insert("refresh_token".into(), json!(self.refresh_token));
        m.insert("expires_at".into(), Value::Number(serde_json::Number::from_f64(self.expires_at).unwrap_or_else(|| 0.into())));
        Value::Object(m)
    }

    /// Store into `slot` (the same xAI user is updated, not duplicated).
    pub fn save(&self, slot: &mut TokenSlot) -> std::io::Result<()> {
        let sub = token_subject(&self.access_token);
        slot.save(self.to_doc(), sub.as_deref())
    }

    pub fn is_expired(&self) -> bool {
        now_s() >= self.expires_at - 60.0
    }

    pub async fn refresh(&self, slot: &TokenSlot) -> Result<Self, RefreshError> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _g = LOCK.lock().await;
        let current = Self::load(slot);
        if let Some(c) = current.as_ref().filter(|c| !c.is_expired()) {
            return Ok(c.clone());
        }
        let source = current.unwrap_or_else(|| self.clone());
        let forget = || {
            slot.revoke();
            crate::oauth::forget_models_if_disconnected("grok");
        };
        let Some(rt) = source.refresh_token.clone() else {
            forget();
            return Err(RefreshError::Value("Grok Build OAuth session cannot be refreshed. Reconnect it.".into()));
        };
        let url = format!("{ISSUER}/oauth2/token");
        let mut attempt = 0;
        let r = loop {
            let res = shared_client()
                .post(&url)
                .header("x-grok-client-version", VERSION)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(urlencode(&[("grant_type", "refresh_token"), ("refresh_token", &rt), ("client_id", CLIENT_ID)]))
                .timeout(Duration::from_secs(15))
                .send()
                .await;
            let err = match res {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) => {
                    let st = r.status().as_u16();
                    let body = r.text().await.unwrap_or_default();
                    if let RefreshFailure::Terminal = refresh_failure(st, &body) {
                        forget();
                        return Err(RefreshError::Value("Grok Build OAuth session was revoked. Reconnect it.".into()));
                    }
                    RefreshError::Http(http_status_message(st, &url))
                }
                Err(e) => RefreshError::Http(e.to_string()),
            };
            let Some(delay) = REFRESH_RETRY_DELAYS.get(attempt) else { return Err(err) };
            tracing::info!("grok_token_refresh_retry attempt={} error={}", attempt + 1, err);
            attempt += 1;
            tokio::time::sleep(*delay).await;
        };
        let data: Value = r.json().await.map_err(|e| RefreshError::Value(e.to_string()))?;
        let Some(access) = data.get("access_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            return Err(RefreshError::Value("Grok Build token refresh returned no access token.".into()));
        };
        let rotated = data.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or(rt);
        let new = Self { access_token: access.into(), refresh_token: Some(rotated), expires_at: now_s() + positive_seconds(data.get("expires_in"), 3600) as f64 };
        new.save(&mut slot.clone()).map_err(|e| RefreshError::Value(e.to_string()))?;
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
    slot: TokenSlot,
}

pub fn make_inner(model: &str, token: &str, kw: &Kwargs) -> Arc<OpenAiProvider> {
    let mut p = OpenAiProvider::with_headers(model, API_BASE, session_headers(token, Some(model)), kw.clone(), CompletionsDialect::OpenAi, true);
    p.use_responses = match kw.get("responses_api") {
        Some(v) => crate::plugin::truthy(v),
        None => uses_responses(cached_catalog().as_ref(), model),
    };
    p.responses.preserve_stateless_reasoning = true;
    p.completions.flavor = Flavor::Grok;
    p.responses.flavor = Flavor::Grok;
    p.provider_name = Some("grok".into());
    Arc::new(p)
}

async fn load_access_token(slot: &TokenSlot) -> Result<String, String> {
    let path = slot;
    let Some(mut auth) = GrokAuth::load(path) else {
        return Err("Grok Build OAuth credentials not found. Run:\n  agentd auth grok\nto authenticate with your Grok subscription.".into());
    };
    if auth.is_expired() {
        auth = auth.refresh(path).await.map_err(|_| "Grok Build token refresh failed. Run: agentd auth grok".to_string())?;
    }
    Ok(auth.access_token)
}

pub fn build(model: &str, model_kwargs: Kwargs) -> ProviderResult<Arc<dyn LlmProvider>> {
    build_for(model, model_kwargs, &oauth_slot())
}

/// The provider for one stored account.
pub fn build_for(model: &str, model_kwargs: Kwargs, slot: &TokenSlot) -> ProviderResult<Arc<dyn LlmProvider>> {
    // A valid token is a store read; only a refresh needs the async helper.
    let token = match GrokAuth::load(slot) {
        Some(auth) if !auth.is_expired() => auth.access_token,
        _ => block_on_thread({
            let s = slot.clone();
            async move { load_access_token(&s).await }
        })
        .map_err(ProviderError::Invalid)?,
    };
    let inner = make_inner(model, &token, &model_kwargs);
    tracing::debug!("grok_build_provider model={}", model);
    Ok(Arc::new(GrokProvider { model: model.into(), kw: model_kwargs, provider_name: Some("grok".into()), inner: RwLock::new((token, inner)), slot: slot.clone() }))
}

impl GrokProvider {
    /// `_refresh_session_if_needed`.
    async fn current(&self) -> ProviderResult<Arc<OpenAiProvider>> {
        let path = &self.slot;
        let Some(mut auth) = GrokAuth::load(path) else {
            return Err(ProviderError::Invalid("Grok Build OAuth credentials not found. Run: agentd auth grok".into()));
        };
        if auth.is_expired() {
            auth = auth.refresh(path).await.map_err(|_| ProviderError::Invalid("Grok Build token refresh failed. Run: agentd auth grok".into()))?;
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

// ── /models catalog ─────────────────────────────────────────────────────────
//
// Grok Build's `/v1/models` carries per-model routing and limits
// (`api_backend`, `context_window[s]`, `reasoning_efforts`). A trimmed copy
// is cached on disk so provider construction and the model registry never
// need the network.

fn catalog_cache_path() -> PathBuf {
    settings().cache_dir.join("grok-models.json")
}

fn str_field<'a>(item: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| item.get(*k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
}

fn positive_int(v: Option<&Value>) -> Option<u64> {
    v.and_then(|v| v.as_u64()).filter(|n| *n > 0)
}

/// One `/models` item → `{id, api_backend, context_window, context_windows, reasoning_efforts}`.
fn normalize_model(item: &Value) -> Option<Value> {
    let id = str_field(item, &["id", "model", "modelId"])?;
    let windows: Vec<u64> =
        ["context_windows", "contextWindows"].iter().find_map(|k| item.get(*k).and_then(|v| v.as_array())).into_iter().flatten().filter_map(|v| positive_int(Some(v))).collect();
    let context_window = ["context_window", "contextWindow"].iter().find_map(|k| positive_int(item.get(*k))).or_else(|| windows.first().copied());
    let efforts: Vec<&str> = ["reasoning_efforts", "reasoningEfforts"]
        .iter()
        .find_map(|k| item.get(*k).and_then(|v| v.as_array()))
        .into_iter()
        .flatten()
        .filter_map(|e| e.as_str().or_else(|| e.get("value").and_then(|v| v.as_str())).filter(|s| !s.is_empty()))
        .collect();
    Some(json!({
        "id": id,
        "api_backend": str_field(item, &["api_backend", "apiBackend"]),
        "context_window": context_window,
        "context_windows": windows,
        "reasoning_efforts": efforts,
    }))
}

fn cacheable_catalog(data: &Value) -> Value {
    let models: Vec<Value> = data.get("data").and_then(|d| d.as_array()).into_iter().flatten().filter_map(normalize_model).collect();
    json!({"models": models})
}

/// The cached catalog — no network or OAuth work.
pub fn cached_catalog() -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(catalog_cache_path()).ok()?).ok()
}

fn write_catalog(cat: &Value) {
    let path = catalog_cache_path();
    let res = std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).and_then(|_| std::fs::write(&path, appv3_core::pyjson::dumps_compact(cat)));
    if let Err(e) = res {
        tracing::warn!("failed to write Grok Build model catalog cache {} ({})", path.display(), e);
    }
}

fn catalog_models(cat: Option<&Value>) -> impl Iterator<Item = &Value> {
    cat.and_then(|c| c.get("models")).and_then(|m| m.as_array()).into_iter().flatten()
}

fn catalog_entry<'a>(cat: Option<&'a Value>, model: &str) -> Option<&'a Value> {
    catalog_models(cat).find(|m| m.get("id").and_then(|v| v.as_str()) == Some(model))
}

pub fn model_ids(cat: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = catalog_models(cat).filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from)).collect();
    out.sort();
    out
}

/// Responses unless the catalog routes the model to Chat Completions. A
/// listed model without `api_backend` follows Grok Build's default (Chat
/// Completions); an unlisted one gets the current Grok family's Responses.
pub fn uses_responses(cat: Option<&Value>, model: &str) -> bool {
    match catalog_entry(cat, model) {
        Some(m) => m.get("api_backend").and_then(|v| v.as_str()) == Some("responses"),
        None => true,
    }
}

const EFFORT_ORDER: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// `grok:<id>` registry entries: Grok Build's default context window (it
/// is smaller than the API's maximum) and its reasoning-effort menu.
pub fn model_registry_overlay(cat: Option<&Value>) -> Map<String, Value> {
    let mut reg = Map::new();
    for m in catalog_models(cat) {
        let Some(id) = m.get("id").and_then(|v| v.as_str()) else { continue };
        let mut entry = Map::new();
        if let Some(cw) = positive_int(m.get("context_window")) {
            entry.insert("limits".into(), json!({"context_length": cw}));
        }
        let mut levels: Vec<&str> = m.get("reasoning_efforts").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str()).collect();
        levels.sort_by_key(|l| EFFORT_ORDER.iter().position(|o| o == l).unwrap_or(EFFORT_ORDER.len()));
        if !levels.is_empty() {
            entry.insert("thinking".into(), json!({"levels": levels}));
        }
        if !entry.is_empty() {
            reg.insert(format!("grok:{id}").to_lowercase(), Value::Object(entry));
        }
    }
    reg
}

async fn fetch_models(token: &str, timeout: Duration) -> Result<Value, (Option<u16>, String)> {
    let url = format!("{API_BASE}/models");
    let r = with_headers(shared_client().get(&url), &session_headers(token, None)).timeout(timeout).send().await.map_err(|e| (None, e.to_string()))?;
    let st = r.status().as_u16();
    if st >= 400 {
        return Err((Some(st), http_status_message(st, &url)));
    }
    let data: Value = r.json().await.map_err(|e| (None, e.to_string()))?;
    let cat = cacheable_catalog(&data);
    write_catalog(&cat);
    Ok(cat)
}

/// Fetch and cache the live catalog; `Ok(None)` when not signed in.
async fn fetch_catalog() -> Result<Option<Value>, String> {
    let path = oauth_slot();
    let Some(mut auth) = GrokAuth::load(&path) else { return Ok(None) };
    if auth.is_expired() {
        auth = auth.refresh(&path).await.map_err(|e| e.to_string())?;
    }
    fetch_models(&auth.access_token, Duration::from_secs(5)).await.map(Some).map_err(|(_, e)| e)
}

/// The cached catalog, refetched when older than an hour (or `force`).
pub async fn load_catalog(force: bool) -> Option<Value> {
    let cached = cached_catalog();
    if !settings().model_registry_refresh {
        return cached;
    }
    let fresh = || std::fs::metadata(catalog_cache_path()).and_then(|m| m.modified()).map(|t| t.elapsed().unwrap_or_default() < MODELS_CACHE_TTL).unwrap_or(false);
    if cached.is_some() && !force && fresh() {
        return cached;
    }
    match fetch_catalog().await {
        Ok(Some(cat)) => Some(cat),
        Ok(None) => cached,
        Err(e) => {
            tracing::warn!("failed to fetch Grok Build model catalog ({})", e);
            cached
        }
    }
}

/// `model_discovery._grok_models()` — also refreshes the cached catalog.
pub async fn discover_models() -> Result<Vec<String>, String> {
    let Some(cat) = fetch_catalog().await? else { return Ok(vec![]) };
    crate::registry::clear_model_registry_caches();
    Ok(model_ids(Some(&cat)))
}

// ── usage ───────────────────────────────────────────────────────────────────

pub use crate::codex::UsageError;

fn number(v: Option<&Value>) -> Option<f64> {
    v.filter(|x| x.is_number()).and_then(|x| x.as_f64())
}

/// A billing `Cent` (`{"val": <USD cents>}`). proto3 JSON drops zero
/// scalars, so a present `{}` is 0; `None` only when the field is absent.
/// Billing stores credit balances as negative cents (accounting convention).
fn cents(values: &Map<String, Value>, key: &str) -> Option<i64> {
    let obj = values.get(key)?.as_object()?;
    Some(match obj.get("val") {
        None | Some(Value::Null) => 0,
        Some(Value::String(s)) => s.trim().parse().ok()?,
        Some(v) => v.as_f64()?.round() as i64,
    })
}

/// Whole dollars as `$N`, otherwise `$N.NN` (Grok Build's `fmt_dollars`).
fn fmt_dollars(cents: i64) -> String {
    let cents = cents.unsigned_abs();
    if cents.is_multiple_of(100) {
        format!("${}", cents / 100)
    } else {
        format!("${}.{:02}", cents / 100, cents % 100)
    }
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

/// Mirrors Grok Build's `credit_balance_from_config`: prefer
/// `creditUsagePercent`, fall back to the deprecated `used`/`monthlyLimit`,
/// and read an omitted percentage as 0% (proto3 drops zero values).
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
    let monthly_limit = cents(values, "monthlyLimit").unwrap_or(0);
    let used = cents(values, "used").unwrap_or(0);
    let legacy = (monthly_limit > 0).then(|| used as f64 / monthly_limit as f64 * 100.0);
    let mut out = vec![];
    if start.is_some() || end.is_some() || reported.is_some() || legacy.is_some() {
        out.push(UsageLimit {
            limit_id: Some("grok_build".into()),
            limit_name: Some(name.into()),
            primary: Some(window(reported.or(legacy).unwrap_or(0.0), start, end)),
            period_start_at: start,
            period_end_at: end,
            ..Default::default()
        });
    }
    if let Some(cap) = cents(values, "onDemandCap").filter(|c| *c > 0) {
        let on_demand_used = cents(values, "onDemandUsed").map(i64::abs).unwrap_or((used - monthly_limit).max(0));
        out.push(UsageLimit {
            limit_id: Some("grok_on_demand".into()),
            limit_name: Some("On-demand cap".into()),
            primary: Some(window(100.0 * on_demand_used as f64 / cap as f64, start, end)),
            period_start_at: start,
            period_end_at: end,
            ..Default::default()
        });
    }
    if let Some(balance) = cents(values, "prepaidBalance").filter(|b| *b != 0) {
        out.push(UsageLimit {
            limit_id: Some("grok_prepaid".into()),
            limit_name: Some("Prepaid credits".into()),
            credits: Some(json!({"has_credits": true, "unlimited": false, "balance": fmt_dollars(balance)})),
            ..Default::default()
        });
    }
    out
}

/// `grok.usage.get_usage()` for the account in use.
pub async fn get_usage() -> Result<Value, UsageError> {
    get_usage_for(&oauth_slot()).await
}

/// Usage of one stored account.
pub async fn get_usage_for(slot: &TokenSlot) -> Result<Value, UsageError> {
    let Some(auth) = GrokAuth::load(slot) else { return Err(UsageError::Credentials("Grok Build OAuth credentials not found.".into())) };
    let res: Result<Value, String> = async {
        let auth = if auth.is_expired() { auth.refresh(slot).await.map_err(|e| e.to_string())? } else { auth };
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
    match fetch_models(token, Duration::from_secs(15)).await {
        Ok(_) => {
            crate::registry::clear_model_registry_caches();
            Ok(())
        }
        Err((Some(401 | 403), _)) => Err(VerifyErr::Rejected),
        Err(_) => Err(VerifyErr::Warn),
    }
}

/// `DEFAULT_MODEL` unless the account's catalog lists other models only.
fn suggested_model() -> String {
    let ids = model_ids(cached_catalog().as_ref());
    if ids.is_empty() || ids.iter().any(|m| m == DEFAULT_MODEL) {
        return DEFAULT_MODEL.into();
    }
    ids[0].clone()
}

async fn success(auth: &GrokAuth, path: &mut TokenSlot, sink: Option<&OAuthSink>, already: bool) -> Result<(), String> {
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
        json!({"credential_id": path.credential_id, "account_label": path.label(), "suggested_model": format!("grok:{}", suggested_model()), "already_authenticated": already}),
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

async fn device_flow(path: &mut TokenSlot, sink: Option<&OAuthSink>) -> Result<(), String> {
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

/// `grok.oauth.login(event_sink=...)` (RFC 8628 device flow). `slot` is
/// the account to reconnect, or a new one to add.
pub async fn login(sink: Option<OAuthSink>, slot: TokenSlot) -> Result<(), String> {
    let sink = sink.as_ref();
    let mut path = slot;
    say(sink, "started", "Starting Grok Build device login...", json!({}));
    if let Some(existing) = GrokAuth::load(&path) {
        let res: Result<(), String> = async {
            let auth = if existing.is_expired() { existing.refresh(&path).await.map_err(|e| e.to_string())? } else { existing };
            success(&auth, &mut path.clone(), sink, true).await
        }
        .await;
        if res.is_ok() {
            return Ok(());
        }
    }
    match device_flow(&mut path, sink).await {
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
    fn fmt_dollars_matches_grok_build() {
        assert_eq!(fmt_dollars(1200), "$12");
        assert_eq!(fmt_dollars(1250), "$12.50");
        assert_eq!(fmt_dollars(-5), "$0.05");
    }

    #[test]
    fn usage_limits() {
        let cfg = json!({"currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-01-01T00:00:00Z", "end": "2026-01-08T00:00:00Z"},
                         "creditUsagePercent": 120, "onDemandCap": {"val": 1000}, "onDemandUsed": {"val": 500}, "prepaidBalance": {"val": -350}});
        let l = limits(cfg.as_object().unwrap());
        assert_eq!(l.len(), 3);
        assert_eq!(l[0].primary.as_ref().unwrap().used_percent, 100.0);
        assert_eq!(l[0].primary.as_ref().unwrap().window_minutes, Some(7 * 24 * 60));
        assert_eq!(l[1].primary.as_ref().unwrap().used_percent, 50.0);
        assert_eq!(l[2].credits.as_ref().unwrap()["balance"], "$3.50");
    }

    /// The live credits payload: proto3 JSON omits `creditUsagePercent` when it is 0.
    #[test]
    fn omitted_credit_usage_percent_reads_as_zero_used() {
        let cfg = json!({"currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-10-22T00:00:00+00:00", "end": "2026-10-29T00:00:00+00:00"},
                         "onDemandCap": {"val": 0}, "onDemandUsed": {"val": 0}, "isUnifiedBillingUser": true, "prepaidBalance": {"val": 0},
                         "billingPeriodStart": "2026-10-22T00:00:00+00:00", "billingPeriodEnd": "2026-10-29T00:00:00+00:00"});
        let l = limits(cfg.as_object().unwrap());
        assert_eq!(l.len(), 1);
        let w = l[0].primary.as_ref().expect("a measurable weekly window");
        assert_eq!(w.used_percent, 0.0);
        assert_eq!(w.window_minutes, Some(7 * 24 * 60));
    }

    #[test]
    fn empty_cent_object_counts_as_zero_on_demand_spend() {
        let cfg = json!({"creditUsagePercent": 40, "onDemandCap": {"val": 1000}, "onDemandUsed": {}});
        let l = limits(cfg.as_object().unwrap());
        let od = l.iter().find(|x| x.limit_id.as_deref() == Some("grok_on_demand")).expect("on-demand cap stays visible at $0 used");
        assert_eq!(od.primary.as_ref().unwrap().used_percent, 0.0);
    }

    #[test]
    fn negative_prepaid_cents_show_as_dollars() {
        let cfg = json!({"creditUsagePercent": 100, "prepaidBalance": {"val": -1250}});
        let l = limits(cfg.as_object().unwrap());
        let p = l.iter().find(|x| x.limit_id.as_deref() == Some("grok_prepaid")).expect("prepaid balance row");
        assert_eq!(p.credits.as_ref().unwrap()["balance"], "$12.50");
        let whole = limits(json!({"prepaidBalance": {"val": -10000}}).as_object().unwrap());
        assert_eq!(whole.iter().find(|x| x.limit_id.as_deref() == Some("grok_prepaid")).unwrap().credits.as_ref().unwrap()["balance"], "$100");
    }

    #[test]
    fn legacy_monthly_limit_derives_usage_percent() {
        let cfg = json!({"monthlyLimit": {"val": 2000}, "used": {"val": 500}, "billingPeriodStart": "2026-10-01T00:00:00Z", "billingPeriodEnd": "2026-11-01T00:00:00Z"});
        let l = limits(cfg.as_object().unwrap());
        assert_eq!(l[0].primary.as_ref().unwrap().used_percent, 25.0);
    }

    /// Trimmed live `/v1/models` item (2026-10).
    fn live_models() -> Value {
        json!({"object": "list", "data": [
            {"id": "grok-4.7", "object": "model", "owned_by": "xAI", "model": "grok-4.7", "name": "Grok 4.7",
             "context_window": 256000, "context_windows": [256000, 500000], "api_backend": "responses",
             "reasoning_effort": "high", "supports_reasoning_effort": true,
             "reasoning_efforts": [{"value": "xhigh"}, {"value": "high", "default": true}, {"value": "medium"}, {"value": "low"}]},
            {"id": "grok-chat", "model": "grok-chat", "contextWindow": 131072, "apiBackend": "chat_completions"},
            {"object": "model"}
        ]})
    }

    #[test]
    fn catalog_keeps_routing_and_limits_per_model() {
        let cat = cacheable_catalog(&live_models());
        assert_eq!(model_ids(Some(&cat)), vec!["grok-4.7", "grok-chat"]);
        let m = catalog_entry(Some(&cat), "grok-4.7").unwrap();
        assert_eq!(m["api_backend"], "responses");
        assert_eq!(m["context_window"], 256000);
        assert_eq!(m["reasoning_efforts"], json!(["xhigh", "high", "medium", "low"]));
        assert_eq!(catalog_entry(Some(&cat), "grok-chat").unwrap()["context_window"], 131072);
    }

    #[test]
    fn api_backend_comes_from_the_catalog() {
        let cat = cacheable_catalog(&live_models());
        assert!(uses_responses(Some(&cat), "grok-4.7"));
        assert!(!uses_responses(Some(&cat), "grok-chat"));
        // Unknown to the catalog (or no catalog yet): current Grok models are Responses-only.
        assert!(uses_responses(Some(&cat), "grok-4.8"));
        assert!(uses_responses(None, "grok-4.7"));
    }

    #[test]
    fn registry_overlay_uses_the_grok_build_default_context_window() {
        let o = model_registry_overlay(Some(&cacheable_catalog(&live_models())));
        assert_eq!(o["grok:grok-4.7"]["limits"]["context_length"], 256000);
        assert_eq!(o["grok:grok-4.7"]["thinking"]["levels"], json!(["low", "medium", "high", "xhigh"]));
        assert_eq!(o["grok:grok-chat"]["limits"]["context_length"], 131072);
        assert!(o["grok:grok-chat"].get("thinking").is_none());
    }

    #[test]
    fn only_rejected_grants_end_the_session() {
        assert!(matches!(refresh_failure(400, r#"{"error":"invalid_grant"}"#), RefreshFailure::Terminal));
        assert!(matches!(refresh_failure(401, r#"{"error":"invalid_client"}"#), RefreshFailure::Terminal));
        // Everything else is retried and keeps the saved session (as Grok Build does).
        assert!(matches!(refresh_failure(400, r#"{"error":"temporarily_unavailable"}"#), RefreshFailure::Transient));
        assert!(matches!(refresh_failure(401, ""), RefreshFailure::Transient));
        assert!(matches!(refresh_failure(429, ""), RefreshFailure::Transient));
        assert!(matches!(refresh_failure(503, "<html>"), RefreshFailure::Transient));
    }

    fn jwt(payload: Value) -> String {
        format!("e30.{}.sig", b64url(payload.to_string().as_bytes()))
    }

    fn header<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
        h.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    #[test]
    fn session_headers_carry_the_token_subject_as_user_id() {
        let h = session_headers(&jwt(json!({"sub": "user-1", "team_id": "t"})), Some("grok-4.7"));
        assert_eq!(header(&h, "x-userid"), Some("user-1"));
        assert_eq!(header(&h, "x-grok-model-override"), Some("grok-4.7"));
        assert_eq!(header(&session_headers("opaque-token", None), "x-userid"), None);
    }

    #[test]
    fn request_headers_tag_the_conversation_and_each_request() {
        let base = vec![("Authorization".to_string(), "Bearer t".to_string())];
        let mut kw = Kwargs::new();
        kw.insert("session_id".into(), json!("sess-1"));
        let a = request_headers(&base, &kw);
        let b = request_headers(&base, &kw);
        assert_eq!(header(&a, "Authorization"), Some("Bearer t"));
        assert_eq!(header(&a, "x-grok-conv-id"), Some("sess-1"));
        assert_eq!(header(&a, "x-grok-session-id"), Some("sess-1"));
        assert_ne!(header(&a, "x-grok-req-id"), header(&b, "x-grok-req-id"));
        let anon = request_headers(&base, &Kwargs::new());
        assert_eq!(header(&anon, "x-grok-conv-id"), None);
        assert!(header(&anon, "x-grok-req-id").is_some());
    }
}
