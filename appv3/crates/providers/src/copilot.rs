//! GitHub Copilot — port of `providers/copilot/*` (`copilot.py`, `oauth.py`,
//! `usage.py`).

use crate::codex::say;
use crate::oauth::TokenSlot;
use crate::openai::{shared_client, CompletionsDialect, CopilotModel, Flavor, OpenAiProvider};
use crate::plugin::*;
use crate::types::*;
use appv3_core::env::os_environ;
use appv3_core::VERSION;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const API_BASE: &str = "https://api.githubcopilot.com";
pub const API_VERSION: &str = "2026-06-01";
const CLIENT_ID: &str = "Ov23li8tweQw6odWQebz";
const SCOPE: &str = "read:user";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
/// Environment variables that supply a GitHub token instead of the OAuth file.
pub const TOKEN_ENV: [&str; 4] = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN"];
/// v2 re-fetches `/models` on every call; v3 keeps it for a short while.
const CATALOG_TTL: Duration = Duration::from_secs(300);

const REASONING_EFFORT_MODELS: [&str; 4] = ["gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.4-mini"];
const MODEL_ENDPOINT_MAP: [(&str, &str); 15] = [
    ("gpt-5-mini", "completions"),
    ("gpt-5.1", "completions"),
    ("gpt-5.2", "completions"),
    ("claude-sonnet-4", "completions"),
    ("claude-sonnet-4.5", "completions"),
    ("claude-opus-4.5", "completions"),
    ("claude-haiku-4.5", "completions"),
    ("gemini-3.1-pro-preview", "completions"),
    ("gemini-3-flash-preview", "completions"),
    ("gemini-2.5-pro", "completions"),
    ("grok-code-fast-1", "completions"),
    ("gpt-5.4-mini", "responses"),
    ("gpt-5.4", "responses"),
    ("gpt-5.2-codex", "responses"),
    ("gpt-5.3-codex", "responses"),
];

fn user_agent() -> String {
    format!("opencode/{VERSION}")
}

/// The Copilot account currently serving requests.
pub fn oauth_slot() -> TokenSlot {
    TokenSlot::active("copilot")
}

// ── enterprise URLs ─────────────────────────────────────────────────────────

/// `(netloc, path)` of a URL the way `urllib.parse.urlparse` splits it.
fn netloc_path(url: &str) -> (String, String) {
    let Some((_, rest)) = url.split_once("://") else { return (String::new(), url.to_string()) };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let netloc = rest[..end].to_string();
    let after = &rest[end..];
    let pend = after.find(['?', '#']).unwrap_or(after.len());
    (netloc, after[..pend].to_string())
}

pub fn normalize_enterprise_url(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let full = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
    let (netloc, path) = netloc_path(&full);
    let host = if netloc.is_empty() { path } else { netloc };
    if host.is_empty() {
        return None;
    }
    Some(format!("https://{}", host.trim_end_matches('/')))
}

pub fn api_base(enterprise_url: Option<&str>) -> String {
    match normalize_enterprise_url(enterprise_url) {
        None => API_BASE.to_string(),
        Some(n) => format!("https://copilot-api.{}", netloc_path(&n).0),
    }
}

fn device_urls(enterprise_url: Option<&str>) -> (String, String) {
    match normalize_enterprise_url(enterprise_url) {
        None => (DEVICE_CODE_URL.into(), ACCESS_TOKEN_URL.into()),
        Some(n) => (format!("{n}/login/device/code"), format!("{n}/login/oauth/access_token")),
    }
}

// ── persistence ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CopilotAuth {
    pub github_token: String,
    pub enterprise_url: Option<String>,
}

impl CopilotAuth {
    pub fn load(slot: &TokenSlot) -> Option<Self> {
        Self::from_doc(&slot.load()?)
    }

    pub fn from_doc(v: &Value) -> Option<Self> {
        let github_token = v.get("github_token")?.as_str()?.to_string();
        let enterprise_url = match v.get("enterprise_url") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return None,
        };
        Some(Self { github_token, enterprise_url: normalize_enterprise_url(enterprise_url.as_deref()) })
    }

    pub fn to_doc(&self) -> Value {
        let mut m = Map::new();
        m.insert("github_token".into(), json!(self.github_token));
        m.insert("enterprise_url".into(), json!(normalize_enterprise_url(self.enterprise_url.as_deref())));
        Value::Object(m)
    }

    pub fn save(&self, slot: &mut TokenSlot) -> std::io::Result<()> {
        slot.save(self.to_doc(), None)
    }
}

/// A GitHub token exported in the environment pins Copilot to it.
pub fn env_github_token() -> Option<(String, String)> {
    let tok = TOKEN_ENV.iter().find_map(|n| os_environ(n).filter(|v| !v.is_empty()))?;
    let ent = ["COPILOT_ENTERPRISE_URL", "GH_ENTERPRISE_URL", "GITHUB_ENTERPRISE_URL"].iter().find_map(|n| os_environ(n).filter(|v| !v.is_empty()));
    Some((tok, api_base(ent.as_deref())))
}

/// `(token, api_base)` of one stored account (a token pasted as a value, or
/// the device-login document).
pub fn slot_github_token(slot: &TokenSlot) -> Option<(String, String)> {
    if let Some(auth) = CopilotAuth::load(slot) {
        return Some((auth.github_token.clone(), api_base(auth.enterprise_url.as_deref()))).filter(|(t, _)| !t.is_empty());
    }
    let c = appv3_core::credentials::snapshot().find(&slot.provider_id, &slot.credential_id).cloned()?;
    let tok = ["COPILOT_GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN"].iter().find_map(|n| c.value(n).map(String::from))?;
    Some((tok, api_base(c.value("COPILOT_ENTERPRISE_URL"))))
}

/// `_resolve_github_token(None)` → `(token, api_base)`: env vars, then the
/// account in use.
pub fn resolve_github_token() -> Option<(String, String)> {
    env_github_token().or_else(|| slot_github_token(&oauth_slot()))
}

// ── /models catalog ─────────────────────────────────────────────────────────

/// Normalized subset of `copilot_model_catalog()` entries.
#[derive(Debug, Clone, Default)]
pub struct CopilotModelInfo {
    pub supported_endpoints: Vec<String>,
    pub policy_state: Option<String>,
    pub limit_input: Value,
    pub limit_output: Value,
    pub tool_calls: bool,
    pub reasoning_effort: Vec<String>,
    pub restricted_to: Vec<String>,
}

pub type Catalog = HashMap<String, CopilotModelInfo>;

/// (base URL, token) → (fetched at, catalogue).
type CatalogCache = Mutex<HashMap<(String, String), (Instant, Arc<Catalog>)>>;

fn catalog_cache() -> &'static CatalogCache {
    static C: std::sync::OnceLock<CatalogCache> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

fn normalize_item(item: &Value) -> Option<(String, CopilotModelInfo)> {
    let id = item.get("id")?.as_str()?.to_string();
    let obj = |v: Option<&Value>| v.filter(|x| x.is_object()).cloned().unwrap_or(json!({}));
    let caps = obj(item.get("capabilities"));
    let limits = obj(caps.get("limits"));
    let supports = obj(caps.get("supports"));
    let policy = obj(item.get("policy"));
    let billing = obj(item.get("billing"));
    let strs = |v: Option<&Value>| -> Vec<String> { v.and_then(|a| a.as_array()).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect() };
    let endpoints: Vec<String> = match item.get("supported_endpoints") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec![],
    };
    Some((
        id,
        CopilotModelInfo {
            supported_endpoints: endpoints,
            policy_state: policy.get("state").and_then(|s| s.as_str()).map(String::from),
            limit_input: limits.get("max_prompt_tokens").cloned().unwrap_or(Value::Null),
            limit_output: limits.get("max_output_tokens").cloned().unwrap_or(Value::Null),
            tool_calls: supports.get("tool_calls") == Some(&json!(true)),
            reasoning_effort: strs(supports.get("reasoning_effort")),
            restricted_to: strs(billing.get("restricted_to")),
        },
    ))
}

async fn fetch_catalog(token: &str, base: &str) -> Catalog {
    let r = shared_client()
        .get(format!("{base}/models"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", user_agent())
        .header("X-GitHub-Api-Version", API_VERSION)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let Ok(r) = r else { return Catalog::new() };
    if r.status().as_u16() >= 400 {
        return Catalog::new();
    }
    let Ok(data) = r.json::<Value>().await else { return Catalog::new() };
    data.get("data").and_then(|d| d.as_array()).into_iter().flatten().filter_map(normalize_item).collect()
}

/// `copilot_model_catalog()` (short-lived cache).
pub async fn model_catalog() -> Arc<Catalog> {
    let Some((token, base)) = resolve_github_token() else { return Arc::new(Catalog::new()) };
    if let Some(c) = fresh_cached_catalog(&token, &base) {
        return c;
    }
    let cat = Arc::new(fetch_catalog(&token, &base).await);
    catalog_cache().lock().unwrap().insert((crate::plugin::sha256_hex(&token), base), (Instant::now(), cat.clone()));
    cat
}

/// The cached `/models` catalog for this token, if younger than the TTL.
fn fresh_cached_catalog(token: &str, base: &str) -> Option<Arc<Catalog>> {
    let key = (crate::plugin::sha256_hex(token), base.to_string());
    catalog_cache().lock().unwrap().get(&key).filter(|(t, _)| t.elapsed() < CATALOG_TTL).map(|(_, c)| c.clone())
}

fn endpoint_for_model(cat: &Catalog, model: &str) -> &'static str {
    if let Some(m) = cat.get(model) {
        let norm: HashSet<&str> = m.supported_endpoints.iter().map(|e| e.trim_start_matches('/')).collect();
        if norm.contains("v1/responses") || norm.contains("responses") {
            return "responses";
        }
        if norm.contains("v1/chat/completions") || norm.contains("chat/completions") {
            return "completions";
        }
    }
    MODEL_ENDPOINT_MAP.iter().find(|(k, _)| *k == model).map(|(_, v)| *v).unwrap_or("completions")
}

fn supports_reasoning_effort(cat: &Catalog, model: &str) -> bool {
    match cat.get(model) {
        Some(m) => !m.reasoning_effort.is_empty(),
        None => REASONING_EFFORT_MODELS.contains(&model),
    }
}

/// Python `bool(value)`.
fn py_bool(v: &Value) -> bool {
    crate::plugin::truthy(v)
}

/// `CopilotProvider(model, model_kwargs)`.
pub fn build(model: &str, model_kwargs: Kwargs) -> ProviderResult<Arc<dyn LlmProvider>> {
    build_with(model, model_kwargs, resolve_github_token())
}

/// The provider for one stored account.
pub fn build_for(model: &str, model_kwargs: Kwargs, slot: &TokenSlot) -> ProviderResult<Arc<dyn LlmProvider>> {
    build_with(model, model_kwargs, slot_github_token(slot))
}

fn build_with(model: &str, model_kwargs: Kwargs, resolved: Option<(String, String)>) -> ProviderResult<Arc<dyn LlmProvider>> {
    let Some((token, base)) = resolved else {
        return Err(ProviderError::Invalid("GitHub token not found.  Run:\n  agentd auth copilot\nOr set COPILOT_GITHUB_TOKEN env var.".into()));
    };
    // Only a cache miss needs the network (and the async helper).
    let cat = fresh_cached_catalog(&token, &base).unwrap_or_else(|| block_on_thread(model_catalog()));
    Ok(Arc::new(provider_for(model, &token, &base, model_kwargs, &cat)))
}

/// The provider for a resolved token + `/models` catalog snapshot.
pub fn provider_for(model: &str, token: &str, base: &str, model_kwargs: Kwargs, cat: &Catalog) -> OpenAiProvider {
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("User-Agent".to_string(), user_agent()),
        ("Openai-Intent".to_string(), "conversation-edits".to_string()),
        ("x-initiator".to_string(), "user".to_string()),
        ("X-GitHub-Api-Version".to_string(), API_VERSION.to_string()),
        ("Authorization".to_string(), format!("Bearer {token}")),
    ];
    let use_responses = match model_kwargs.get("responses_api") {
        Some(v) => py_bool(v),
        None => endpoint_for_model(cat, model) == "responses",
    };
    let meta = CopilotModel { supports_reasoning_effort: supports_reasoning_effort(cat, model) };
    let mut p = OpenAiProvider::with_headers(model, base, headers, model_kwargs, CompletionsDialect::OpenAi, true);
    p.use_responses = use_responses;
    p.responses.preserve_stateless_reasoning = false;
    p.completions.flavor = Flavor::Copilot(meta.clone());
    p.responses.flavor = Flavor::Copilot(meta);
    p.provider_name = Some("copilot".into());
    p
}

// ── usage ───────────────────────────────────────────────────────────────────

pub use crate::codex::UsageError;

const PLAN_ALIASES: [(&str, &[&str]); 7] = [
    ("free", &["free", "student", "education", "edu"]),
    ("student", &["student", "education", "edu", "free"]),
    ("education", &["education", "edu", "student", "free"]),
    ("edu", &["edu", "education", "student", "free"]),
    ("business", &["business", "enterprise", "team"]),
    ("enterprise", &["enterprise", "business", "team"]),
    ("team", &["team", "business", "enterprise"]),
];

fn normalize_plan(plan: Option<&Value>) -> Option<String> {
    let n = plan?.as_str()?.trim().to_lowercase().replace(['-', ' '], "_");
    Some(n).filter(|s| !s.is_empty())
}

/// `model_allowed_for_plan(restricted_to, plan_type)`.
pub fn model_allowed_for_plan(restricted_to: &[String], plan_type: Option<&str>) -> Option<bool> {
    let allowed: HashSet<String> = restricted_to.iter().filter_map(|v| normalize_plan(Some(&json!(v)))).collect();
    if allowed.is_empty() {
        return Some(true);
    }
    let plan = plan_type.and_then(|p| normalize_plan(Some(&json!(p))))?;
    let mut values: HashSet<String> = HashSet::from([plan.clone()]);
    if let Some((_, al)) = PLAN_ALIASES.iter().find(|(k, _)| *k == plan) {
        values.extend(al.iter().map(|s| s.to_string()));
    }
    Some(!allowed.is_disjoint(&values))
}

fn usage_token(slot: &TokenSlot) -> Option<String> {
    match slot_github_token(slot) {
        Some((t, _)) => Some(t),
        None => env_github_token().map(|(t, _)| t),
    }
}

async fn usage_payload(slot: &TokenSlot) -> Result<Map<String, Value>, UsageError> {
    let Some(token) = usage_token(slot) else { return Err(UsageError::Credentials("Copilot OAuth credentials not found.".into())) };
    let url = "https://api.github.com/copilot_internal/user";
    let res: Result<Value, String> = async {
        let r = shared_client()
            .get(url)
            .header("Authorization", format!("token {token}"))
            .header("Accept", "application/json")
            .header("User-Agent", user_agent())
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 400 {
            return Err(http_status_message(st, url));
        }
        r.json::<Value>().await.map_err(|e| e.to_string())
    }
    .await;
    match res {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(UsageError::Unavailable("Provider usage response was invalid.".into())),
        Err(e) => {
            tracing::info!("provider_usage_unavailable provider=copilot error={}", e);
            Err(UsageError::Unavailable("Provider usage unavailable.".into()))
        }
    }
}

fn extract_plan_type(p: &Map<String, Value>) -> Option<String> {
    let plan = p.get("copilot_plan").filter(|v| crate::plugin::truthy(v)).or_else(|| p.get("access_type_sku"));
    normalize_plan(plan)
}

/// `model_plan_type()`.
pub async fn model_plan_type() -> Option<String> {
    usage_payload(&oauth_slot()).await.ok().as_ref().and_then(extract_plan_type)
}

fn as_number(v: Option<&Value>) -> Option<f64> {
    v.filter(|x| x.is_number()).and_then(|x| x.as_f64())
}

fn parse_ts(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Bool(true) => Some(1),
        Value::Number(n) if n.is_i64() || n.is_u64() => n.as_i64().filter(|x| *x > 0),
        Value::String(_) => parse_iso_ts(v),
        _ => None,
    }
}

fn usage_limit(name: &str, data: &Value, plan_type: Option<String>, fallback_reset: Option<i64>) -> Option<UsageLimit> {
    let values = data.as_object()?;
    let unlimited = values.get("unlimited") == Some(&json!(true));
    let remaining = as_number(values.get("remaining"));
    let entitlement = as_number(values.get("entitlement"));
    let credits_used = as_number(values.get("credits_used"));
    let has_entitlement = entitlement.map(|e| e > 0.0).unwrap_or(false);
    let used_percent = as_number(values.get("percent_remaining")).map(|p| (100.0 - p).clamp(0.0, 100.0));
    let fake_zero = used_percent == Some(0.0) && !has_entitlement && (unlimited || credits_used.is_some());
    let primary = match used_percent {
        Some(u) if !fake_zero => Some(UsageWindow { used_percent: u, window_minutes: None, resets_at: parse_ts(values.get("quota_reset_at")).or(fallback_reset) }),
        _ => None,
    };
    let balance = if let (Some(r), Some(e)) = (remaining, entitlement.filter(|e| *e > 0.0)) {
        Some(format!("{}/{}", r as i64, e as i64))
    } else if let Some(cu) = credits_used {
        let used = cu as i64;
        match entitlement.filter(|e| *e > 0.0) {
            Some(e) => Some(format!("{used}/{}", e as i64)),
            None if unlimited => Some(format!("{used}/\u{221e}")),
            None => Some(used.to_string()),
        }
    } else {
        None
    };
    let has_credits = unlimited || remaining.map(|r| r > 0.0).unwrap_or(false) || credits_used.is_some();
    Some(UsageLimit {
        limit_id: Some(values.get("quota_id").and_then(|q| q.as_str()).unwrap_or(name).to_string()),
        limit_name: Some("Premium requests".into()),
        primary,
        credits: Some(json!({"has_credits": has_credits, "unlimited": unlimited, "balance": balance})),
        plan_type,
        ..Default::default()
    })
}

/// `copilot.usage.get_usage()` for the account in use.
pub async fn get_usage() -> Result<Value, UsageError> {
    get_usage_for(&oauth_slot()).await
}

/// Usage of one stored account.
pub async fn get_usage_for(slot: &TokenSlot) -> Result<Value, UsageError> {
    Ok(usage_from_payload(&usage_payload(slot).await?))
}

/// The response-parsing half of `get_usage` (pure).
pub fn usage_from_payload(payload: &Map<String, Value>) -> Value {
    let plan = extract_plan_type(payload);
    let reset = parse_ts(payload.get("quota_reset_date_utc"));
    let mut limits = vec![];
    if let Some(item) = payload.get("quota_snapshots").and_then(|s| s.as_object()).and_then(|s| s.get("premium_interactions")) {
        if !item.is_null() {
            if let Some(l) = usage_limit("premium_interactions", item, plan, reset) {
                limits.push(l);
            }
        }
    }
    usage_response("copilot", limits)
}

/// `model_discovery._copilot_models()`.
pub async fn discover_models() -> Vec<String> {
    let cat = model_catalog().await;
    let plan = model_plan_type().await;
    let mut out: Vec<String> = cat
        .iter()
        .filter(|(_, i)| !i.limit_input.is_null() && !i.limit_output.is_null() && i.tool_calls && i.policy_state.as_deref() != Some("disabled"))
        .filter(|(_, i)| model_allowed_for_plan(&i.restricted_to, plan.as_deref()) != Some(false))
        .map(|(k, _)| k.clone())
        .collect();
    out.sort();
    out
}

// ── OAuth device login ──────────────────────────────────────────────────────

fn oauth_headers(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header("Accept", "application/json").header("Content-Type", "application/json").header("User-Agent", user_agent()).header("X-GitHub-Api-Version", API_VERSION)
}

async fn verify_access(token: &str, enterprise_url: Option<&str>, cli: bool) -> bool {
    let r = shared_client()
        .get(format!("{}/models", api_base(enterprise_url)))
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", user_agent())
        .header("Accept", "application/json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match r {
        Ok(r) if r.status().as_u16() == 200 => {
            let data: Value = r.json().await.unwrap_or(json!({}));
            let models: Vec<Value> = data.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
            let avail: Vec<&Value> = models.iter().filter(|m| m.is_object() && m.pointer("/policy/state").and_then(|s| s.as_str()) != Some("disabled")).collect();
            if cli {
                println!("  Copilot OK — {} models available\n", avail.len());
                for m in avail {
                    let eps: Vec<String> = m.get("supported_endpoints").and_then(|e| e.as_array()).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
                    let ep = if eps.is_empty() { "?".to_string() } else { eps.join(", ") };
                    println!("    {:30}  [{ep}]", m.get("id").and_then(|i| i.as_str()).unwrap_or(""));
                }
            }
            true
        }
        Ok(r) => {
            if cli {
                let st = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                println!("  Copilot verification failed: {st}");
                println!("  Response: {}", body.chars().take(200).collect::<String>());
            }
            false
        }
        Err(e) => {
            if cli {
                println!("  Copilot verification error: {e}");
            }
            false
        }
    }
}

async fn poll_for_token(device_code: &str, mut interval: u64, expires_in: u64, sink: Option<&OAuthSink>, enterprise_url: Option<&str>) -> Result<String, String> {
    let (_, token_url) = device_urls(enterprise_url);
    let deadline = Instant::now() + Duration::from_secs(expires_in);
    let started = Instant::now();
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if sink.is_some() {
            let el = started.elapsed().as_secs();
            say(sink, "polling", &format!("Waiting for authorization… {el}s"), json!({"elapsed_s": el}));
        }
        let r = oauth_headers(shared_client().post(&token_url))
            .json(&json!({"client_id": CLIENT_ID, "device_code": device_code, "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 400 {
            return Err(http_status_message(st, &token_url));
        }
        let data: Value = r.json().await.map_err(|e| e.to_string())?;
        if let Some(tok) = data.get("access_token") {
            return Ok(tok.as_str().map(String::from).unwrap_or_else(|| appv3_core::pyjson::dumps(tok)));
        }
        let error = data.get("error").and_then(|e| e.as_str()).unwrap_or("");
        match error {
            "authorization_pending" => continue,
            "slow_down" => {
                interval += 5;
                continue;
            }
            "expired_token" => {
                say(sink, "failed", "Device code expired. Run again.", json!({"reason": "expired"}));
                return Err("device_code_expired".into());
            }
            "access_denied" => {
                say(sink, "failed", "User denied access.", json!({"reason": "denied"}));
                return Err("access_denied".into());
            }
            other => {
                say(sink, "failed", &format!("Unexpected error: {other}"), json!({"reason": "unexpected", "detail": other}));
                return Err(format!("unexpected:{other}"));
            }
        }
    }
    say(sink, "failed", "Timed out waiting for authorization.", json!({"reason": "timeout"}));
    Err("timeout".into())
}

/// `copilot.oauth.login(event_sink=..., enterprise_url=...)`.
/// `slot` is the account to reconnect, or a new one to add.
pub async fn login(sink: Option<OAuthSink>, enterprise_url: Option<&str>, slot: TokenSlot) -> Result<(), String> {
    let sink = sink.as_ref();
    let cli = sink.is_none();
    let mut path = slot;
    let enterprise = normalize_enterprise_url(enterprise_url);
    say(sink, "started", "=== GitHub Copilot Device Login ===\n", json!({}));
    if let Some(existing) = CopilotAuth::load(&path) {
        say(sink, "checking_existing", &format!("Existing token found in {}", path.display()), json!({}));
        let ent = normalize_enterprise_url(existing.enterprise_url.as_deref());
        if verify_access(&existing.github_token, ent.as_deref(), cli).await {
            say(sink, "success", "Existing token still valid. No action needed.", json!({"already_authenticated": true, "enterprise_url": ent}));
            return Ok(());
        }
        say(sink, "reauthenticating", "Existing token invalid. Re-authenticating...", json!({}));
    }
    say(sink, "requesting_device_code", "Requesting device code...", json!({}));
    let (code_url, _) = device_urls(enterprise.as_deref());
    let r = oauth_headers(shared_client().post(&code_url))
        .json(&json!({"client_id": CLIENT_ID, "scope": SCOPE}))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    if st >= 400 {
        return Err(http_status_message(st, &code_url));
    }
    let data: Value = r.json().await.map_err(|e| e.to_string())?;
    let field = |k: &str| data.get(k).map(|v| v.as_str().map(String::from).unwrap_or_else(|| appv3_core::pyjson::dumps(v))).ok_or(format!("'{k}'"));
    let device_code = field("device_code")?;
    let user_code = field("user_code")?;
    let verification_uri = field("verification_uri")?;
    let interval = data.get("interval").map(|v| py_int(Some(v))).unwrap_or(5).max(0) as u64;
    let expires_in_v = data.get("expires_in").cloned().unwrap_or(json!(900));
    let expires_in = py_int(Some(&expires_in_v)).max(0) as u64;
    say(
        sink,
        "device_code",
        &format!("Open: {verification_uri}  Code: {user_code}"),
        json!({"verification_uri": verification_uri, "user_code": user_code, "expires_in": expires_in_v, "enterprise_url": enterprise}),
    );
    let token = poll_for_token(&device_code, interval, expires_in, sink, enterprise.as_deref()).await?;
    let chars: Vec<char> = token.chars().collect();
    let head: String = chars.iter().take(8).collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    say(sink, "token_acquired", &format!("GitHub token acquired: {head}...{tail}"), json!({}));
    say(sink, "verifying", "Verifying Copilot access...", json!({}));
    if !verify_access(&token, enterprise.as_deref(), cli).await {
        say(
            sink,
            "warning",
            "Token obtained but Copilot access failed. Make sure you have an active GitHub Copilot subscription. Saving token anyway — you can retry later.",
            json!({"copilot_access_ok": false}),
        );
    }
    CopilotAuth { github_token: token, enterprise_url: enterprise.clone() }.save(&mut path).map_err(|e| e.to_string())?;
    say(
        sink,
        "success",
        &format!("Saved to {}. Use model: copilot:gpt-4.1", path.display()),
        json!({"credential_id": path.credential_id, "account_label": path.label(), "suggested_model": "copilot:gpt-4.1", "enterprise_url": enterprise}),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enterprise_urls() {
        assert_eq!(normalize_enterprise_url(Some(" ghe.corp.com/ ")), Some("https://ghe.corp.com".into()));
        assert_eq!(normalize_enterprise_url(Some("https://ghe.corp.com/path")), Some("https://ghe.corp.com".into()));
        assert_eq!(api_base(Some("ghe.corp.com")), "https://copilot-api.ghe.corp.com");
        assert_eq!(api_base(None), API_BASE);
    }

    #[test]
    fn plan_gating() {
        assert_eq!(model_allowed_for_plan(&[], None), Some(true));
        assert_eq!(model_allowed_for_plan(&["business".into()], None), None);
        assert_eq!(model_allowed_for_plan(&["Enterprise".into()], Some("team")), Some(true));
        assert_eq!(model_allowed_for_plan(&["pro".into()], Some("free")), Some(false));
    }

    #[test]
    fn premium_limit() {
        let l = usage_limit("premium_interactions", &json!({"percent_remaining": 75.0, "remaining": 225, "entitlement": 300}), Some("pro".into()), Some(5)).unwrap();
        assert_eq!(l.primary.as_ref().unwrap().used_percent, 25.0);
        assert_eq!(l.credits.as_ref().unwrap()["balance"], "225/300");
        let l = usage_limit("p", &json!({"percent_remaining": 100, "unlimited": true, "credits_used": 7}), None, None).unwrap();
        assert!(l.primary.is_none());
        assert_eq!(l.credits.as_ref().unwrap()["balance"], "7/\u{221e}");
    }
}
