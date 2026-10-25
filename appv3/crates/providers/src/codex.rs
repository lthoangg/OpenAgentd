//! OpenAI Codex (ChatGPT subscription) — port of `providers/codex/*`
//! (`codex.py`, `oauth.py`, `catalog.py`, `usage.py`).

use crate::oauth::TokenSlot;
use crate::openai::{shared_client, CodexTurn, CompletionsDialect, Flavor, OpenAiProvider};
use crate::plugin::*;
use crate::types::*;
use appv3_core::{settings, VERSION};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const ISSUER: &str = "https://auth.openai.com";
pub const OAUTH_PORT: u16 = 1455;
pub const ORIGINATOR: &str = "openagentd";
pub const API_BASE: &str = "https://chatgpt.com/backend-api/codex";
pub const MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const MODELS_CACHE_TTL_SECONDS: u64 = 60 * 60;
const EFFECTIVE_CONTEXT_WINDOW_PERCENT: i64 = 95;
const NO_REASONING_SUMMARY_MODELS: [&str; 1] = ["gpt-5.3-codex-spark"];
const CACHED_MODEL_FIELDS: [&str; 6] =
    ["slug", "context_window", "max_context_window", "effective_context_window_percent", "auto_compact_token_limit", "supports_reasoning_summary_parameter"];

fn user_agent() -> String {
    format!("openagentd/{VERSION}")
}

/// The Codex account currently serving requests.
pub fn oauth_slot() -> TokenSlot {
    TokenSlot::active("codex")
}

fn now_s() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

// ── persistence ─────────────────────────────────────────────────────────────

/// `CodexOAuth`.
#[derive(Debug, Clone)]
pub struct CodexAuth {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: f64,
    pub account_id: Option<String>,
}

impl CodexAuth {
    pub fn load(slot: &TokenSlot) -> Option<Self> {
        Self::from_doc(&slot.load()?)
    }

    pub fn from_doc(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        let expires_at = match v.get("expires_at")? {
            Value::Number(n) => n.as_f64()?,
            Value::String(s) => s.trim().parse().ok()?,
            _ => return None,
        };
        let account_id = match v.get("account_id") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return None,
        };
        Some(Self { access_token: s("access_token")?, refresh_token: s("refresh_token")?, expires_at, account_id })
    }

    pub fn to_doc(&self) -> Value {
        let mut m = Map::new();
        m.insert("access_token".into(), json!(self.access_token));
        m.insert("refresh_token".into(), json!(self.refresh_token));
        m.insert("expires_at".into(), Value::Number(serde_json::Number::from_f64(self.expires_at).unwrap_or_else(|| 0.into())));
        m.insert("account_id".into(), json!(self.account_id));
        Value::Object(m)
    }

    /// Store into `slot` (a known account is updated, not duplicated).
    pub fn save(&self, slot: &mut TokenSlot) -> std::io::Result<()> {
        slot.save(self.to_doc(), self.account_id.as_deref())
    }

    pub fn is_expired(&self) -> bool {
        now_s() >= self.expires_at - 60.0
    }

    /// Exchange the refresh token (once, under a process-wide lock) and persist.
    pub async fn refresh(&self, slot: &TokenSlot) -> Result<Self, String> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _g = LOCK.lock().await;
        let current = Self::load(slot);
        if let Some(c) = current.as_ref().filter(|c| !c.is_expired()) {
            return Ok(c.clone());
        }
        let source = current.unwrap_or_else(|| self.clone());
        let tokens = match token_request(&[("grant_type", "refresh_token"), ("refresh_token", &source.refresh_token), ("client_id", CLIENT_ID)]).await {
            Ok(t) => t,
            Err(TokenError::Status(st, msg)) => {
                // Another process (the CLI beside the server) may have used
                // and rotated this refresh token first; its save stands.
                let still_ours = Self::load(slot).is_none_or(|c| c.refresh_token == source.refresh_token);
                if (st == 400 || st == 401) && still_ours {
                    slot.revoke();
                    crate::oauth::forget_models_if_disconnected("codex");
                }
                return Err(msg);
            }
            Err(TokenError::Other(m)) => return Err(m),
        };
        let access = tokens.get("access_token").and_then(|v| v.as_str()).ok_or("'access_token'")?.to_string();
        let new = Self {
            access_token: access,
            refresh_token: tokens.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or(source.refresh_token.clone()),
            expires_at: now_s() + expires_in(&tokens),
            account_id: extract_account_id(&tokens).or(source.account_id.clone()),
        };
        new.save(&mut slot.clone()).map_err(|e| e.to_string())?;
        Ok(new)
    }
}

fn expires_in(tokens: &Map<String, Value>) -> f64 {
    tokens.get("expires_in").and_then(|v| v.as_f64()).unwrap_or(3600.0)
}

enum TokenError {
    Status(u16, String),
    Other(String),
}

async fn token_request(form: &[(&str, &str)]) -> Result<Map<String, Value>, TokenError> {
    let url = format!("{ISSUER}/oauth/token");
    let r = shared_client()
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(urlencode(form))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| TokenError::Other(e.to_string()))?;
    let st = r.status().as_u16();
    if st >= 400 {
        return Err(TokenError::Status(st, http_status_message(st, &url)));
    }
    match r.json::<Value>().await {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(TokenError::Other("invalid token response".into())),
        Err(e) => Err(TokenError::Other(e.to_string())),
    }
}

pub(crate) fn b64_lenient(s: &str) -> Option<Vec<u8>> {
    use base64::engine::{general_purpose::GeneralPurposeConfig, DecodePaddingMode, GeneralPurpose};
    use base64::Engine;
    let eng = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    eng.decode(s.trim_end_matches('=')).ok()
}

/// `_extract_account_id(tokens)` — from the id/access JWT claims.
pub fn extract_account_id(tokens: &Map<String, Value>) -> Option<String> {
    for key in ["id_token", "access_token"] {
        let Some(tok) = tokens.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else { continue };
        let parts: Vec<&str> = tok.split('.').collect();
        if parts.len() != 3 {
            continue;
        }
        let Some(payload) = b64_lenient(parts[1]).and_then(|b| String::from_utf8(b).ok()).and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { continue };
        let truthy_str = |v: Option<&Value>| v.and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from);
        let id = truthy_str(payload.get("chatgpt_account_id"))
            .or_else(|| truthy_str(payload.get("https://api.openai.com/auth").and_then(|a| a.get("chatgpt_account_id"))))
            .or_else(|| {
                let orgs = payload.get("organizations").and_then(|o| o.as_array()).filter(|a| !a.is_empty());
                truthy_str(orgs.and_then(|a| a[0].get("id")))
            });
        if id.is_some() {
            return id;
        }
    }
    None
}

/// `_load_token()` → `(access_token, account_id)`, refreshing when expired.
pub async fn load_token(slot: &TokenSlot) -> Result<(String, Option<String>), String> {
    let path = slot;
    let Some(mut auth) = CodexAuth::load(path) else {
        return Err("Codex OAuth credentials not found. Run:\n  agentd auth codex\nto authenticate with your ChatGPT account.".into());
    };
    if auth.is_expired() {
        tracing::info!("codex_token_expired refreshing");
        auth = auth.refresh(path).await.map_err(|e| format!("Codex token refresh failed: {e}\nRun: agentd auth codex"))?;
    }
    Ok((auth.access_token, auth.account_id))
}

// ── provider ────────────────────────────────────────────────────────────────

/// `CodexProvider(model, model_kwargs)`.
pub fn build(model: &str, model_kwargs: Kwargs) -> ProviderResult<Arc<dyn LlmProvider>> {
    build_for(model, model_kwargs, &oauth_slot())
}

/// The provider for one stored account.
pub fn build_for(model: &str, model_kwargs: Kwargs, slot: &TokenSlot) -> ProviderResult<Arc<dyn LlmProvider>> {
    // A valid token is a store read; only a refresh needs the async helper.
    let (token, account_id) = match CodexAuth::load(slot) {
        Some(auth) if !auth.is_expired() => (auth.access_token, auth.account_id),
        _ => block_on_thread({
            let s = slot.clone();
            async move { load_token(&s).await }
        })
        .map_err(ProviderError::Invalid)?,
    };
    let p = provider_for(model, &token, account_id, model_kwargs);
    tracing::debug!("codex_provider model={}", model);
    Ok(Arc::new(p))
}

/// The provider for a resolved token (no I/O besides the catalog cache read).
pub fn provider_for(model: &str, token: &str, account_id: Option<String>, model_kwargs: Kwargs) -> OpenAiProvider {
    let mut headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "text/event-stream".to_string()),
        ("User-Agent".to_string(), user_agent()),
        ("originator".to_string(), ORIGINATOR.to_string()),
        ("Authorization".to_string(), format!("Bearer {token}")),
    ];
    if let Some(a) = account_id.filter(|a| !a.is_empty()) {
        headers.push(("ChatGPT-Account-ID".to_string(), a));
    }
    let supports_summary = supports_reasoning_summary(cached_catalog().as_ref(), model).unwrap_or(!NO_REASONING_SUMMARY_MODELS.contains(&model));
    let mut p = OpenAiProvider::with_headers(model, API_BASE, headers, model_kwargs, CompletionsDialect::OpenAi, true);
    p.use_responses = true;
    p.responses.request_timeout = STREAM_IDLE_TIMEOUT;
    p.responses.flavor = Flavor::Codex(Arc::new(CodexTurn { turn_state: Default::default(), supports_reasoning_summary: supports_summary }));
    p.provider_name = Some("codex".into());
    p
}

// ── catalog ─────────────────────────────────────────────────────────────────

fn cache_path() -> PathBuf {
    settings().cache_dir.join("codex-models.json")
}

/// `cached_codex_catalog()` — no network or OAuth work.
pub fn cached_catalog() -> Option<Value> {
    let p = cache_path();
    match std::fs::read_to_string(&p) {
        Ok(t) => match serde_json::from_str(&t) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!("failed to read Codex model catalog cache {} ({})", p.display(), e);
                None
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            tracing::warn!("failed to read Codex model catalog cache {} ({})", p.display(), e);
            None
        }
    }
}

async fn fetch_catalog() -> Option<Value> {
    let path = oauth_slot();
    let mut auth = CodexAuth::load(&path)?;
    let res: Result<Value, String> = async {
        if auth.is_expired() {
            auth = auth.refresh(&path).await?;
        }
        let mut req = shared_client()
            .get(MODELS_URL)
            .query(&[("client_version", "1.0.0")])
            .header("Authorization", format!("Bearer {}", auth.access_token))
            .header("Content-Type", "application/json")
            .header("User-Agent", user_agent())
            .header("originator", ORIGINATOR)
            .timeout(Duration::from_secs(5));
        if let Some(a) = auth.account_id.as_ref().filter(|a| !a.is_empty()) {
            req = req.header("ChatGPT-Account-Id", a);
        }
        let r = req.send().await.map_err(|_| "ConnectError".to_string())?;
        if r.status().as_u16() >= 400 {
            return Err("HTTPStatusError".into());
        }
        r.json::<Value>().await.map_err(|_| "JSONDecodeError".to_string())
    }
    .await;
    match res {
        Ok(v) => Some(v),
        Err(kind) => {
            tracing::warn!("failed to fetch Codex model catalog ({})", kind);
            None
        }
    }
}

fn cacheable_catalog(data: &Value) -> Value {
    let models: Vec<Value> = data
        .get("models")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter(|i| i.get("slug").map(|s| s.is_string()).unwrap_or(false))
        .map(|i| {
            let mut m = Map::new();
            for f in CACHED_MODEL_FIELDS {
                if let Some(v) = i.get(f) {
                    m.insert(f.into(), v.clone());
                }
            }
            Value::Object(m)
        })
        .collect();
    json!({"models": models})
}

/// `load_codex_catalog(force=...)` — cached (1 h TTL) or freshly fetched.
pub async fn load_catalog(force: bool) -> Option<Value> {
    let path = cache_path();
    let cached = cached_catalog();
    if !settings().model_registry_refresh {
        return cached;
    }
    if cached.is_some() && !force {
        if let Ok(age) = std::fs::metadata(&path).and_then(|m| m.modified()).map(|t| t.elapsed().unwrap_or_default()) {
            if age.as_secs_f64() < MODELS_CACHE_TTL_SECONDS as f64 {
                return cached;
            }
        }
    }
    let Some(resp) = fetch_catalog().await else { return cached };
    let fetched = cacheable_catalog(&resp);
    let write = (|| {
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
        std::fs::write(&path, appv3_core::pyjson::dumps_compact(&fetched))
    })();
    if let Err(e) = write {
        tracing::warn!("failed to write Codex model catalog cache {} ({})", path.display(), e);
    }
    Some(fetched)
}

/// `model_ids(data)`.
pub fn model_ids(data: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> =
        data.and_then(|d| d.get("models")).and_then(|m| m.as_array()).into_iter().flatten().filter_map(|i| i.get("slug").and_then(|s| s.as_str()).map(String::from)).collect();
    out.sort();
    out
}

/// `supports_reasoning_summary(data, model)`.
pub fn supports_reasoning_summary(data: Option<&Value>, model: &str) -> Option<bool> {
    for item in data?.get("models")?.as_array()? {
        if item.get("slug").and_then(|s| s.as_str()) != Some(model) {
            continue;
        }
        return item.get("supports_reasoning_summary_parameter").and_then(|v| v.as_bool());
    }
    None
}

/// `isinstance(v, int)` (bools included, as in Python).
fn py_isint(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Bool(b)) => Some(i64::from(*b)),
        other => strict_int(other),
    }
}

fn strict_int(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) if n.is_i64() || n.is_u64() => n.as_i64(),
        _ => None,
    }
}

/// `model_registry_overlay(data)` — Codex context limits keyed `codex:<slug>`.
pub fn model_registry_overlay(data: Option<&Value>) -> Map<String, Value> {
    let mut reg = Map::new();
    let Some(models) = data.and_then(|d| d.get("models")).and_then(|m| m.as_array()) else { return reg };
    for m in models {
        if !m.is_object() {
            continue;
        }
        let Some(slug) = m.get("slug").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) else { continue };
        let ctx_v = match m.get("max_context_window") {
            None | Some(Value::Null) => m.get("context_window"),
            other => other,
        };
        let pct_v = m.get("effective_context_window_percent").filter(|v| !v.is_null());
        let Some(ctx) = strict_int(ctx_v).filter(|c| *c > 0) else { continue };
        let pct = match pct_v {
            None => EFFECTIVE_CONTEXT_WINDOW_PERCENT,
            Some(v) => match strict_int(Some(v)) {
                Some(p) if (1..=100).contains(&p) => p,
                _ => continue,
            },
        };
        reg.insert(format!("codex:{slug}").to_lowercase(), json!({"limits": {"context_length": ctx, "max_input_tokens": ctx * pct / 100}}));
    }
    reg
}

// ── usage ───────────────────────────────────────────────────────────────────

pub enum UsageError {
    Credentials(String),
    Unavailable(String),
}

async fn usage_headers(slot: &TokenSlot) -> Result<Vec<(String, String)>, UsageError> {
    let Some(mut auth) = CodexAuth::load(slot) else {
        return Err(UsageError::Credentials("Codex OAuth credentials not found.".into()));
    };
    if auth.is_expired() {
        auth = auth.refresh(slot).await.map_err(UsageError::Unavailable)?;
    }
    let mut h = vec![
        ("Authorization".to_string(), format!("Bearer {}", auth.access_token)),
        ("Accept".to_string(), "application/json".to_string()),
        ("User-Agent".to_string(), user_agent()),
        ("originator".to_string(), "openagentd".to_string()),
    ];
    if let Some(a) = auth.account_id.filter(|a| !a.is_empty()) {
        h.push(("ChatGPT-Account-Id".to_string(), a));
    }
    Ok(h)
}

fn with_headers(mut req: reqwest::RequestBuilder, h: &[(String, String)]) -> reqwest::RequestBuilder {
    for (k, v) in h {
        req = req.header(k, v);
    }
    req
}

fn usage_window(data: Option<&Value>) -> Option<UsageWindow> {
    let v = data?.as_object()?;
    let used = match v.get("used_percent")? {
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    let minutes = py_isint(v.get("limit_window_seconds")).filter(|s| *s > 0).map(|s| (s + 59).div_euclid(60));
    Some(UsageWindow { used_percent: used, window_minutes: minutes, resets_at: py_isint(v.get("reset_at")) })
}

fn usage_credits(data: Option<&Value>) -> Option<Value> {
    let v = data?.as_object()?;
    let has = v.get("has_credits")?.as_bool()?;
    let unl = v.get("unlimited")?.as_bool()?;
    Some(json!({"has_credits": has, "unlimited": unl, "balance": v.get("balance").and_then(|b| b.as_str())}))
}

/// `_as_float` — numbers and numeric strings (bools excluded).
fn as_float(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace('_', "").parse::<f64>().ok(),
        _ => None,
    }
}

fn usage_spend(data: Option<&Value>) -> Option<Value> {
    let v = data?.as_object()?;
    let reached = v.get("reached")?.as_bool()?;
    let Some(lim) = v.get("individual_limit").and_then(|l| l.as_object()) else {
        return Some(json!({"reached": reached, "source": null, "limit": null, "used": null, "remaining": null, "used_percent": null, "resets_at": null}));
    };
    Some(json!({
        "reached": reached,
        "source": lim.get("source").and_then(|s| s.as_str()),
        "limit": as_float(lim.get("limit")),
        "used": as_float(lim.get("used")),
        "remaining": as_float(lim.get("remaining")),
        "used_percent": as_float(lim.get("used_percent")),
        "resets_at": py_isint(lim.get("reset_at")),
    }))
}

#[allow(clippy::too_many_arguments)]
fn usage_limit(
    data: &Value,
    limit_id: Option<String>,
    limit_name: Option<String>,
    plan_type: Option<String>,
    reached_type: Option<String>,
    spend: Option<Value>,
    reset_credits: Option<i64>,
) -> Option<UsageLimit> {
    let values = data.as_object()?;
    let rl = values.get("rate_limit").filter(|r| r.is_object()).unwrap_or(data);
    let primary = usage_window(rl.get("primary_window"));
    let secondary = usage_window(rl.get("secondary_window"));
    let credits = usage_credits(values.get("credits"));
    if primary.is_none() && secondary.is_none() && credits.is_none() && spend.is_none() && reset_credits.is_none() {
        return None;
    }
    Some(UsageLimit {
        limit_id,
        limit_name,
        primary,
        secondary,
        credits,
        spend,
        plan_type,
        rate_limit_reached_type: reached_type,
        reset_credits_available: reset_credits,
        ..Default::default()
    })
}

/// `codex.usage.get_usage()` for the account in use.
pub async fn get_usage() -> Result<Value, UsageError> {
    get_usage_for(&oauth_slot()).await
}

/// Usage of one stored account.
pub async fn get_usage_for(slot: &TokenSlot) -> Result<Value, UsageError> {
    let res: Result<Value, UsageError> = async {
        let h = usage_headers(slot).await?;
        let r = with_headers(shared_client().get("https://chatgpt.com/backend-api/wham/usage"), &h)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| UsageError::Unavailable(e.to_string()))?;
        let st = r.status().as_u16();
        if st >= 400 {
            return Err(UsageError::Unavailable(http_status_message(st, "https://chatgpt.com/backend-api/wham/usage")));
        }
        r.json::<Value>().await.map_err(|e| UsageError::Unavailable(e.to_string()))
    }
    .await;
    let payload = match res {
        Ok(p) => p,
        Err(UsageError::Credentials(m)) => return Err(UsageError::Credentials(m)),
        Err(UsageError::Unavailable(e)) => {
            tracing::info!("provider_usage_unavailable provider=codex error={}", e);
            return Err(UsageError::Unavailable("Provider usage unavailable.".into()));
        }
    };
    usage_from_payload(&payload)
}

/// The response-parsing half of `get_usage` (pure).
pub fn usage_from_payload(payload: &Value) -> Result<Value, UsageError> {
    let Some(values) = payload.as_object() else {
        return Err(UsageError::Unavailable("Provider usage response was invalid.".into()));
    };
    let plan = values.get("plan_type").and_then(|v| v.as_str()).map(String::from);
    let reached = match values.get("rate_limit_reached_type") {
        Some(Value::Object(o)) => o.get("type").and_then(|t| t.as_str()).map(String::from),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let reset_credits = values.get("rate_limit_reset_credits").and_then(|r| r.as_object()).and_then(|r| strict_int(r.get("available_count")));
    let mut limits = vec![];
    if let Some(l) = usage_limit(payload, Some("codex".into()), None, plan.clone(), reached, usage_spend(values.get("spend_control")), reset_credits) {
        limits.push(l);
    }
    for item in values.get("additional_rate_limits").and_then(|a| a.as_array()).into_iter().flatten() {
        let Some(iv) = item.as_object() else { continue };
        let metered = iv.get("metered_feature").and_then(|v| v.as_str()).map(String::from);
        let name = iv.get("limit_name").and_then(|v| v.as_str()).map(String::from);
        if let Some(l) = usage_limit(item, metered, name, plan.clone(), None, None, None) {
            limits.push(l);
        }
    }
    Ok(usage_response("codex", limits))
}

/// `codex.usage.consume_reset()` — redeem one available reset credit.
pub async fn consume_reset(credit_id: Option<&str>, slot: &TokenSlot) -> Result<Value, UsageError> {
    let res: Result<(), UsageError> = async {
        let h = usage_headers(slot).await?;
        let un = |m: &str| UsageError::Unavailable(m.to_string());
        let list_url = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
        let r = with_headers(shared_client().get(list_url), &h)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| UsageError::Unavailable(format!("Failed to redeem reset: {e}")))?;
        let st = r.status().as_u16();
        if st >= 400 {
            return Err(UsageError::Unavailable(format!("Failed to redeem reset: {}", http_status_message(st, list_url))));
        }
        let data: Value = r.json().await.map_err(|e| UsageError::Unavailable(format!("Failed to redeem reset: {e}")))?;
        let Some(obj) = data.as_object() else { return Err(un("Invalid reset credits response.")) };
        let Some(credits) = obj.get("credits").and_then(|c| c.as_array()) else { return Err(un("No rate limit reset credits found.")) };
        let available: Vec<&Value> = credits.iter().filter(|c| c.is_object() && c.get("status").and_then(|s| s.as_str()) == Some("available")).collect();
        if available.is_empty() {
            return Err(un("No available rate limit reset credits to redeem."));
        }
        let target = match credit_id.filter(|c| !c.is_empty()) {
            Some(cid) => match available.iter().find(|c| c.get("id").and_then(|i| i.as_str()) == Some(cid)) {
                Some(t) => *t,
                None => return Err(UsageError::Unavailable(format!("Credit ID '{cid}' not found among available credits."))),
            },
            None => available[0],
        };
        let Some(target_id) = target.get("id").and_then(|i| i.as_str()) else { return Err(un("Invalid credit ID format.")) };
        let consume_url = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
        let r = with_headers(shared_client().post(consume_url), &h)
            .timeout(Duration::from_secs(10))
            .json(&json!({"credit_id": target_id, "redeem_request_id": uuid::Uuid::new_v4().to_string()}))
            .send()
            .await
            .map_err(|e| UsageError::Unavailable(format!("Failed to redeem reset: {e}")))?;
        let st = r.status().as_u16();
        if st >= 400 {
            return Err(UsageError::Unavailable(format!("Failed to redeem reset: {}", http_status_message(st, consume_url))));
        }
        Ok(())
    }
    .await;
    if let Err(e) = res {
        if let UsageError::Unavailable(m) = &e {
            if let Some(rest) = m.strip_prefix("Failed to redeem reset: ") {
                tracing::info!("codex_reset_consume_failed error={}", rest);
            }
        }
        return Err(e);
    }
    get_usage_for(slot).await
}

// ── OAuth login ─────────────────────────────────────────────────────────────

static CLI_FAILURE_REPORTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether a CLI-mode login already printed its `failed` message (v2 then
/// calls `sys.exit(1)` / re-raises), so the CLI need not print the error.
pub fn cli_failure_reported() -> bool {
    CLI_FAILURE_REPORTED.load(std::sync::atomic::Ordering::SeqCst)
}

/// `_say`: print (CLI) or push a typed event (UI).
pub fn say(sink: Option<&OAuthSink>, event: &str, message: &str, data: Value) {
    match sink {
        None => {
            if event == "failed" {
                CLI_FAILURE_REPORTED.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            println!("{message}")
        }
        Some(s) => {
            let mut payload = Map::new();
            payload.insert("message".into(), json!(message));
            if let Value::Object(d) = data {
                payload.extend(d);
            }
            s(event, Value::Object(payload));
        }
    }
}

fn generate_verifier() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    random_bytes(43).iter().map(|b| CHARS[*b as usize % CHARS.len()] as char).collect()
}

fn authorize_url(redirect_uri: &str, verifier: &str, state: &str) -> String {
    let challenge = pkce_challenge(verifier);
    let params = urlencode(&[
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", "openid profile email offline_access api.connectors.read api.connectors.invoke"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("state", state),
        ("originator", ORIGINATOR),
    ]);
    format!("{ISSUER}/oauth/authorize?{params}")
}

/// Open a URL in the user's browser (`webbrowser.open`).
pub fn open_browser(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    let _ = appv3_core::proctree::hide_window_std(&mut std::process::Command::new(cmd)).arg(url).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}

enum Callback {
    Code(String),
    Error(String),
}

pub async fn read_request_target(sock: &mut tokio::net::TcpStream) -> String {
    let mut buf = vec![0u8; 16384];
    let mut n = 0;
    loop {
        match sock.read(&mut buf[n..]).await {
            Ok(0) | Err(_) => break,
            Ok(k) => {
                n += k;
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == buf.len() {
                    break;
                }
            }
        }
    }
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string()
}

async fn serve_callback(listener: tokio::net::TcpListener, state: String) -> Callback {
    use crate::plugin::write_response;
    loop {
        let Ok((mut sock, _)) = listener.accept().await else { continue };
        let target = read_request_target(&mut sock).await;
        let no_frag = target.split_once('#').map(|(a, _)| a).unwrap_or(&target).to_string();
        let (path, query) = no_frag.split_once('?').map(|(p, q)| (p.to_string(), q.to_string())).unwrap_or((no_frag.clone(), String::new()));
        if path != "/auth/callback" {
            write_response(&mut sock, 404, "Not Found", None).await;
            continue;
        }
        let qs = parse_qs(&query);
        let error = qs_first(&qs, "error");
        if !error.is_empty() {
            write_response(&mut sock, 200, "OK", Some("<h1>Authorization failed</h1><p>You can close this window.</p>".into())).await;
            return Callback::Error(error);
        }
        let code = qs_first(&qs, "code");
        if code.is_empty() || qs_first(&qs, "state") != state {
            write_response(&mut sock, 400, "Bad Request", None).await;
            return Callback::Error("invalid_state_or_missing_code".into());
        }
        write_response(
            &mut sock,
            200,
            "OK",
            Some("<h1>Authorization successful</h1><p>You can close this window and return to the terminal.</p><script>setTimeout(()=>window.close(),2000)</script>".into()),
        )
        .await;
        return Callback::Code(code);
    }
}

async fn exchange_json(url: &str, form: &[(&str, &str)]) -> Result<Map<String, Value>, String> {
    let _ = url;
    token_request(form).await.map_err(|e| match e {
        TokenError::Status(_, m) | TokenError::Other(m) => m,
    })
}

fn save_tokens(tokens: &Map<String, Value>, slot: &mut TokenSlot, sink: Option<&OAuthSink>) -> Result<(), String> {
    let account_id = extract_account_id(tokens);
    let get = |k: &str| tokens.get(k).and_then(|v| v.as_str()).map(String::from).ok_or(format!("'{k}'"));
    let auth = CodexAuth { access_token: get("access_token")?, refresh_token: get("refresh_token")?, expires_at: now_s() + expires_in(tokens), account_id: account_id.clone() };
    auth.save(slot).map_err(|e| e.to_string())?;
    let suffix = account_id.as_ref().map(|a| format!(" (account: {a})")).unwrap_or_default();
    say(
        sink,
        "success",
        &format!("Saved to {}{suffix}. Use model: codex:gpt-5.4", slot.display()),
        json!({"credential_id": slot.credential_id, "account_label": slot.label(), "account_id": account_id.unwrap_or_default(), "suggested_model": "codex:gpt-5.4"}),
    );
    Ok(())
}

async fn pkce_login(path: &mut TokenSlot, sink: Option<&OAuthSink>) -> Result<(), String> {
    let redirect_uri = format!("http://localhost:{OAUTH_PORT}/auth/callback");
    let verifier = generate_verifier();
    let state = b64url(&random_bytes(32));
    let url = authorize_url(&redirect_uri, &verifier, &state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", OAUTH_PORT)).await.map_err(|e| e.to_string())?;
    say(sink, "browser_auth", &format!("Opening browser for authorization: {url}"), json!({"verification_uri": url}));
    if sink.is_none() {
        open_browser(&url);
    }
    let outcome = tokio::time::timeout(Duration::from_secs(300), serve_callback(listener, state)).await;
    let code = match outcome {
        Err(_) => {
            say(sink, "failed", "Timed out waiting for browser authorization.", json!({}));
            return Err("Timed out waiting for browser authorization.".into());
        }
        Ok(Callback::Error(e)) => {
            let msg = format!("Authorization failed: {e}");
            say(sink, "failed", &msg, json!({}));
            return Err(msg);
        }
        Ok(Callback::Code(c)) => c,
    };
    let tokens =
        exchange_json("", &[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", &redirect_uri), ("client_id", CLIENT_ID), ("code_verifier", &verifier)])
            .await?;
    save_tokens(&tokens, path, sink)
}

async fn post_json(url: &str, body: &Value) -> Result<reqwest::Response, String> {
    shared_client()
        .post(url)
        .header("Content-Type", "application/json")
        .header("User-Agent", user_agent())
        .json(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())
}

async fn device_login(path: &mut TokenSlot, sink: Option<&OAuthSink>) -> Result<(), String> {
    let url = format!("{ISSUER}/api/accounts/deviceauth/usercode");
    let r = post_json(&url, &json!({"client_id": CLIENT_ID})).await?;
    let st = r.status().as_u16();
    if st >= 400 {
        if sink.is_some() && st == 403 {
            return Box::pin(pkce_login(path, sink)).await;
        }
        return Err(http_status_message(st, &url));
    }
    let data: Value = r.json().await.map_err(|e| e.to_string())?;
    let field = |k: &str| data.get(k).and_then(|v| v.as_str()).map(String::from).ok_or(format!("'{k}'"));
    let device_auth_id = field("device_auth_id")?;
    let user_code = field("user_code")?;
    let interval = data.get("interval").map(|v| py_int(Some(v))).unwrap_or(5).max(1) as u64;
    let verification_uri = format!("{ISSUER}/codex/device");
    say(sink, "device_code", &format!("Open: {verification_uri}  Code: {user_code}"), json!({"verification_uri": verification_uri, "user_code": user_code}));
    say(sink, "polling_started", "Polling for authorization...", json!({}));
    let started = std::time::Instant::now();
    loop {
        tokio::time::sleep(Duration::from_secs(interval + 3)).await;
        if sink.is_some() {
            let el = started.elapsed().as_secs();
            say(sink, "polling", &format!("Waiting for authorization… {el}s"), json!({"elapsed_s": el}));
        }
        let poll = post_json(&format!("{ISSUER}/api/accounts/deviceauth/token"), &json!({"device_auth_id": device_auth_id, "user_code": user_code})).await?;
        let st = poll.status().as_u16();
        if st == 200 {
            let d: Value = poll.json().await.map_err(|e| e.to_string())?;
            let f = |k: &str| d.get(k).and_then(|v| v.as_str()).map(String::from).ok_or(format!("'{k}'"));
            let (code, verifier) = (f("authorization_code")?, f("code_verifier")?);
            let redirect = format!("{ISSUER}/deviceauth/callback");
            let tokens =
                exchange_json("", &[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", &redirect), ("client_id", CLIENT_ID), ("code_verifier", &verifier)])
                    .await?;
            return save_tokens(&tokens, path, sink);
        }
        if st != 403 && st != 404 {
            let msg = format!("Unexpected poll response: {st}");
            say(sink, "failed", &msg, json!({"status": st}));
            return Err(msg);
        }
    }
}

/// `codex.oauth.login(device=..., browser=..., event_sink=...)`.
/// `slot` is the account to reconnect, or a new one to add.
pub async fn login(sink: Option<OAuthSink>, device: bool, browser: bool, slot: TokenSlot) -> Result<(), String> {
    let sink = sink.as_ref();
    let mut path = slot;
    say(sink, "started", "=== OpenAI Codex OAuth Login ===", json!({}));
    if let Some(existing) = CodexAuth::load(&path) {
        if !existing.is_expired() {
            say(sink, "success", &format!("Valid token found in {}", path.display()), json!({"already_authenticated": true, "credential_id": path.credential_id}));
            return Ok(());
        }
        say(sink, "refreshing", "Token expired. Refreshing...", json!({}));
        match existing.refresh(&path).await {
            Ok(_) => {
                say(sink, "success", "Token refreshed successfully.", json!({}));
                return Ok(());
            }
            Err(e) => say(sink, "refresh_failed", &format!("Refresh failed ({e}), re-authenticating..."), json!({"detail": e})),
        }
    }
    if browser {
        return pkce_login(&mut path, sink).await;
    }
    if device || sink.is_some() {
        device_login(&mut path, sink).await
    } else {
        pkce_login(&mut path, sink).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_matches_v2_rules() {
        let data = json!({"models": [
            {"slug": "gpt-5.4", "context_window": 272000},
            {"slug": "GPT-X", "max_context_window": 1000, "effective_context_window_percent": 50},
            {"slug": "bad", "context_window": true},
            {"slug": "pct", "context_window": 100, "effective_context_window_percent": 0},
        ]});
        let o = model_registry_overlay(Some(&data));
        assert_eq!(o["codex:gpt-5.4"]["limits"]["max_input_tokens"], 258400);
        assert_eq!(o["codex:gpt-x"]["limits"]["max_input_tokens"], 500);
        assert!(!o.contains_key("codex:bad") && !o.contains_key("codex:pct"));
        assert_eq!(model_ids(Some(&data)), vec!["GPT-X", "bad", "gpt-5.4", "pct"]);
    }

    #[test]
    fn account_id_from_jwt() {
        let payload = b64url(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acc_1"}}"#);
        let mut t = Map::new();
        t.insert("id_token".into(), json!(format!("h.{payload}.s")));
        assert_eq!(extract_account_id(&t).as_deref(), Some("acc_1"));
    }

    #[test]
    fn token_document_keeps_the_legacy_shape() {
        let a = CodexAuth { access_token: "a".into(), refresh_token: "r".into(), expires_at: 1767225600.5, account_id: None };
        assert_eq!(appv3_core::pyjson::dumps_compact(&a.to_doc()), r#"{"access_token":"a","refresh_token":"r","expires_at":1767225600.5,"account_id":null}"#);
        let back = CodexAuth::from_doc(&a.to_doc()).unwrap();
        assert_eq!((back.access_token, back.expires_at), ("a".to_string(), 1767225600.5));
    }
}
