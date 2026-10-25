//! Provider usage snapshots — port of `app/services/provider_usage.py` plus
//! the usage modules (`openrouter`, `deepseek`, `codex`, `copilot`, `grok`).

use crate::providers::{self as prov, CredentialStore};
use appv3_core::runtime_settings as rs;
use appv3_providers::oauth::TokenSlot;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub enum UsageError {
    Unsupported(String),
    Credentials(String),
    Unavailable(String),
}

impl UsageError {
    pub fn msg(&self) -> String {
        match self {
            UsageError::Unsupported(m) | UsageError::Credentials(m) | UsageError::Unavailable(m) => m.clone(),
        }
    }
}

const BUILTIN_USAGE_PROVIDERS: [(&str, &str); 5] =
    [("codex", "OpenAI Codex"), ("copilot", "GitHub Copilot"), ("grok", "Grok Build"), ("openrouter", "OpenRouter"), ("deepseek", "DeepSeek")];

fn oauth_err(e: appv3_providers::codex::UsageError) -> UsageError {
    match e {
        appv3_providers::codex::UsageError::Credentials(m) => UsageError::Credentials(m),
        appv3_providers::codex::UsageError::Unavailable(m) => UsageError::Unavailable(m),
    }
}

fn limit(limit_id: &str, limit_name: &str, credits: Value, spend: Value, plan_type: &str) -> Value {
    json!({
        "limit_id": limit_id, "limit_name": limit_name, "primary": null, "secondary": null,
        "credits": credits, "spend": spend, "plan_type": plan_type, "rate_limit_reached_type": null,
        "reset_credits_available": null, "period_start_at": null, "period_end_at": null,
    })
}

fn resolve_key(given: Option<&str>, var: &str, missing: &str, credential: Option<(&str, &str)>) -> Result<String, UsageError> {
    if let Some(k) = given.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(k.to_string());
    }
    if let Some((pid, cid)) = credential {
        let f = appv3_core::credentials::snapshot();
        let Some(c) = f.find(pid, cid) else { return Err(UsageError::Credentials(format!("Credential '{cid}' not found."))) };
        return c.value(var).map(String::from).ok_or_else(|| UsageError::Credentials(missing.into()));
    }
    let owner = appv3_providers::credentials_migration::owner_of(var);
    let k = CredentialStore::for_provider(owner.as_deref().unwrap_or(""), HashMap::new()).get(var);
    if k.is_empty() {
        return Err(UsageError::Credentials(missing.into()));
    }
    Ok(k)
}

fn client() -> reqwest::Client {
    prov::reqwest_client()
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.filter(|x| x.is_number()).and_then(|x| x.as_f64())
}

fn fmt_balance(a: f64) -> String {
    if 0.0 < a && a < 0.01 {
        format!("${a:.4}")
    } else {
        format!("${a:.2}")
    }
}

async fn openrouter_usage(given: Option<&str>, credential_id: Option<&str>) -> Result<Value, UsageError> {
    let key = resolve_key(given, "OPENROUTER_API_KEY", "OpenRouter API key not configured.", credential_id.map(|c| ("openrouter", c)))?;
    let auth = format!("Bearer {key}");
    let c = client();
    let get = |url: &'static str| c.get(url).header("Authorization", auth.clone()).header("Accept", "application/json").timeout(Duration::from_secs(5)).send();
    let mut credits: Option<Value> = None;
    if let Ok(r) = get("https://openrouter.ai/api/v1/credits").await {
        if r.status().as_u16() == 200 {
            if let Ok(b) = r.json::<Value>().await {
                credits = b.get("data").filter(|d| d.is_object()).cloned();
            }
        }
    }
    let mut keyd: Option<Value> = None;
    match get("https://openrouter.ai/api/v1/auth/key").await {
        Err(e) => return Err(UsageError::Unavailable(e.to_string())),
        Ok(r) => {
            let st = r.status().as_u16();
            if st == 401 || st == 403 {
                return Err(UsageError::Credentials("Invalid OpenRouter API key.".into()));
            }
            if st == 200 {
                let b = r.json::<Value>().await.map_err(|e| UsageError::Unavailable(e.to_string()))?;
                keyd = b.get("data").filter(|d| d.is_object()).cloned();
            } else if st >= 500 {
                return Err(UsageError::Unavailable(format!("OpenRouter key API returned HTTP {st}")));
            }
        }
    }
    if credits.is_none() && keyd.is_none() {
        return Err(UsageError::Unavailable("Unable to reach OpenRouter usage API.".into()));
    }
    let (mut balance, mut has_credits, mut unlimited) = (None::<String>, true, false);
    if let Some(cd) = &credits {
        if let Some(tc) = num(cd.get("total_credits")) {
            let used = num(cd.get("total_usage")).unwrap_or(0.0);
            let remaining = (tc - used).max(0.0);
            balance = Some(fmt_balance(remaining));
            has_credits = remaining > 0.0 || tc > used;
        }
    }
    let (mut spend, mut label, mut free) = (Value::Null, None::<String>, false);
    if let Some(kd) = &keyd {
        label = kd.get("label").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        free = kd.get("is_free_tier").map(|v| v.as_bool().unwrap_or(!v.is_null())).unwrap_or(false);
        let key_limit = num(kd.get("limit"));
        let key_usage = num(kd.get("usage")).unwrap_or(0.0);
        let remaining = num(kd.get("limit_remaining"));
        match key_limit {
            Some(l) if l > 0.0 => {
                let rem = remaining.unwrap_or((l - key_usage).max(0.0));
                let reached = key_usage >= l || remaining.map(|r| r <= 0.0).unwrap_or(false);
                spend = json!({"reached": reached, "source": null, "limit": l, "used": key_usage, "remaining": rem, "used_percent": key_usage / l * 100.0, "resets_at": null});
            }
            Some(0.0) => {
                spend = json!({"reached": true, "source": null, "limit": 0.0, "used": key_usage, "remaining": 0.0, "used_percent": 100.0, "resets_at": null});
            }
            _ => {}
        }
        if balance.is_none() {
            if let Some(r) = remaining {
                balance = Some(fmt_balance(r));
                has_credits = r > 0.0;
                unlimited = false;
            } else if key_limit.is_none() {
                has_credits = true;
                unlimited = true;
                if key_usage > 0.0 {
                    balance = Some(format!("{} used", fmt_balance(key_usage)));
                }
            } else {
                has_credits = true;
                unlimited = false;
            }
        }
    }
    let plan = if free { "Free tier".to_string() } else { label.clone().unwrap_or_else(|| "Pay-as-you-go".into()) };
    let name = match &label {
        Some(l) => format!("OpenRouter ({l})"),
        None => "OpenRouter Credits".into(),
    };
    let credits_obj = json!({"has_credits": has_credits, "unlimited": unlimited, "balance": balance});
    Ok(json!({"provider": "openrouter", "limits": [limit("openrouter", &name, credits_obj, spend, &plan)]}))
}

fn py_float(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

fn fmt_currency(amount: &Value, currency: &str) -> String {
    let Some(val) = py_float(amount) else {
        let shown = match amount {
            Value::String(s) => s.clone(),
            o => appv3_agent::pystr::py_str(o),
        };
        return format!("{shown} {currency}");
    };
    match currency.to_uppercase().as_str() {
        "USD" => format!("${val:.2}"),
        "CNY" => format!("¥{val:.2}"),
        _ => format!("{val:.2} {currency}"),
    }
}

async fn deepseek_usage(given: Option<&str>, credential_id: Option<&str>) -> Result<Value, UsageError> {
    let key = resolve_key(given, "DEEPSEEK_API_KEY", "DeepSeek API key not configured.", credential_id.map(|c| ("deepseek", c)))?;
    let r = client()
        .get("https://api.deepseek.com/user/balance")
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| UsageError::Unavailable(e.to_string()))?;
    let st = r.status().as_u16();
    if st == 401 || st == 403 {
        return Err(UsageError::Credentials("Invalid DeepSeek API key.".into()));
    }
    if st != 200 {
        return Err(UsageError::Unavailable(format!("DeepSeek balance API returned HTTP {st}")));
    }
    let data: Value = r.json().await.map_err(|e| UsageError::Unavailable(e.to_string()))?;
    if !data.is_object() {
        return Err(UsageError::Unavailable("Malformed DeepSeek balance response".into()));
    }
    let available = data.get("is_available").map(|v| v.as_bool().unwrap_or(!v.is_null())).unwrap_or(false);
    let infos: Vec<Value> = data.get("balance_infos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut formatted = vec![];
    let mut positive = false;
    for item in &infos {
        if !item.is_object() {
            continue;
        }
        let currency = item.get("currency").map(|c| c.as_str().map(String::from).unwrap_or_else(|| appv3_agent::pystr::py_str(c))).unwrap_or_else(|| "USD".into());
        let total = item.get("total_balance").cloned().unwrap_or(json!("0.00"));
        if py_float(&total).unwrap_or(0.0) > 0.0 {
            positive = true;
            formatted.push(fmt_currency(&total, &currency));
        }
    }
    let balance = if !formatted.is_empty() {
        formatted.join(" / ")
    } else if let Some(first) = infos.first() {
        let curr = first.get("currency").and_then(|c| c.as_str()).unwrap_or("USD");
        let tot = first.get("total_balance").cloned().unwrap_or(json!("0.00"));
        fmt_currency(&tot, curr)
    } else {
        "$0.00".into()
    };
    let credits = json!({"has_credits": available || positive, "unlimited": false, "balance": balance});
    Ok(json!({"provider": "deepseek", "limits": [limit("deepseek", "DeepSeek Balance", credits, Value::Null, "Pay-as-you-go")]}))
}

/// The OAuth account `credential_id` names, else the one in use.
fn slot(provider_id: &str, credential_id: Option<&str>) -> Result<TokenSlot, UsageError> {
    match credential_id {
        Some(cid) => {
            let s = TokenSlot::new(provider_id, cid);
            if !s.exists() {
                return Err(UsageError::Credentials(format!("Credential '{cid}' not found.")));
            }
            Ok(s)
        }
        None => Ok(TokenSlot::active(provider_id)),
    }
}

/// `get_provider_usage` — of one stored credential when `credential_id`
/// is given, else of the credential in use.
pub async fn get_provider_usage(provider_id: &str, token: Option<&str>, credential_id: Option<&str>) -> Result<Value, UsageError> {
    match provider_id {
        "openrouter" => openrouter_usage(token, credential_id).await,
        "deepseek" => deepseek_usage(token, credential_id).await,
        "codex" => appv3_providers::codex::get_usage_for(&slot("codex", credential_id)?).await.map_err(oauth_err),
        "copilot" => appv3_providers::copilot::get_usage_for(&slot("copilot", credential_id)?).await.map_err(oauth_err),
        "grok" => appv3_providers::grok::get_usage_for(&slot("grok", credential_id)?).await.map_err(oauth_err),
        id => match appv3_providers::plugin::find_provider_plugin(id) {
            Some(p) if p.has_usage() => {
                let store = CredentialStore::for_provider(id, HashMap::new());
                p.get_usage(&store).await.map_err(|e| match e {
                    appv3_providers::plugin::PluginUsageError::Value(m) => UsageError::Credentials(m),
                    appv3_providers::plugin::PluginUsageError::Other(m) => UsageError::Unavailable(m),
                })
            }
            _ => Err(UsageError::Unsupported(id.to_string())),
        },
    }
}

/// `consume_provider_reset` — codex only.
pub async fn consume_provider_reset(provider_id: &str, credential_id: Option<&str>) -> Result<Value, UsageError> {
    if provider_id == "codex" {
        let res = appv3_providers::codex::consume_reset(None, &slot("codex", credential_id)?).await.map_err(oauth_err)?;
        let mut st = state().lock().unwrap();
        st.cache = None;
        st.last_good.remove(provider_id);
        return Ok(res);
    }
    Err(UsageError::Unsupported(format!("Rate limit reset unsupported for '{provider_id}'.")))
}

// ── summary ─────────────────────────────────────────────────────────────────

const TTL: Duration = Duration::from_secs(45);
const STALE_TTL: Duration = Duration::from_secs(15 * 60);
const LAST_GOOD_MAX_AGE: Duration = Duration::from_secs(30 * 60);
const ITEM_TIMEOUT: Duration = Duration::from_secs(6);

struct SummaryState {
    cache: Option<(Instant, Value)>,
    last_good: HashMap<String, (Instant, Value)>,
    refreshing: bool,
}

fn state() -> &'static Mutex<SummaryState> {
    static S: std::sync::OnceLock<Mutex<SummaryState>> = std::sync::OnceLock::new();
    S.get_or_init(|| Mutex::new(SummaryState { cache: None, last_good: HashMap::new(), refreshing: false }))
}

fn fetch_lock() -> &'static tokio::sync::Mutex<()> {
    static L: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(Default::default)
}

fn candidates(rt: &rs::RuntimeSettings) -> Vec<(String, String)> {
    let mut out = vec![];
    for (id, fallback) in BUILTIN_USAGE_PROVIDERS {
        if rt.providers.get(id).map(|p| p.is_disconnected).unwrap_or(false) {
            continue;
        }
        let owned;
        let entry = match prov::find(id) {
            Some(e) => e,
            None => {
                owned = json!({"id": id, "label": fallback, "kind": "oauth"});
                &owned
            }
        };
        if !prov::provider_is_configured(entry) {
            continue;
        }
        let label = entry.get("label").and_then(|v| v.as_str()).unwrap_or(fallback);
        out.push((id.to_string(), label.to_string()));
    }
    for p in appv3_providers::plugin::provider_plugins() {
        if !p.has_usage() {
            continue;
        }
        let info = p.info();
        if rt.providers.get(&info.id).map(|x| x.is_disconnected).unwrap_or(false) {
            continue;
        }
        let owned;
        let entry = match prov::find(&info.id) {
            Some(e) => e,
            None => {
                owned = json!({"id": info.id, "label": info.label, "kind": info.kind});
                &owned
            }
        };
        if !prov::provider_is_configured(entry) {
            continue;
        }
        out.push((info.id.clone(), info.label.clone()));
    }
    out
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

fn filter_visible(mut usage: Value, visible: &[String]) -> Value {
    let vis: Vec<String> = visible.iter().map(|m| norm(m)).filter(|m| !m.is_empty()).collect();
    let Some(limits) = usage.get("limits").and_then(|l| l.as_array()).cloned() else { return usage };
    if vis.is_empty() || limits.is_empty() {
        return usage;
    }
    let kept: Vec<Value> = limits
        .into_iter()
        .filter(|l| {
            let n = l.get("limit_id").and_then(|v| v.as_str()).map(norm).unwrap_or_default();
            !n.is_empty() && vis.iter().any(|v| n.contains(v.as_str()) || v.contains(n.as_str()))
        })
        .collect();
    if !kept.is_empty() {
        usage["limits"] = Value::Array(kept);
    }
    usage
}

fn item(provider: &str, label: &str, status: &str, error: Option<String>, usage: Value) -> Value {
    json!({"provider": provider, "label": label, "status": status, "error": error, "usage": usage, "stale": false})
}

fn last_good(provider: &str, error: &str) -> Option<Value> {
    let st = state().lock().unwrap();
    let (at, it) = st.last_good.get(provider)?;
    if at.elapsed() > LAST_GOOD_MAX_AGE {
        return None;
    }
    let mut it = it.clone();
    it["stale"] = json!(true);
    it["error"] = json!(error);
    Some(it)
}

async fn fetch_item(provider: String, label: String, visible: Vec<String>) -> Value {
    let res = tokio::time::timeout(ITEM_TIMEOUT, get_provider_usage(&provider, None, None)).await;
    let err = match res {
        Ok(Ok(u)) => {
            let it = item(&provider, &label, "ok", None, filter_visible(u, &visible));
            state().lock().unwrap().last_good.insert(provider.clone(), (Instant::now(), it.clone()));
            return it;
        }
        Ok(Err(UsageError::Credentials(m))) => return item(&provider, &label, "credentials_missing", Some(m), Value::Null),
        Ok(Err(e)) => e.msg(),
        Err(_) => "Timed out waiting for provider usage.".to_string(),
    };
    last_good(&provider, &err).unwrap_or_else(|| item(&provider, &label, "unavailable", Some(err), Value::Null))
}

async fn fresh_snapshot() -> Value {
    let rt = rs::load_runtime_settings().unwrap_or_default();
    let cands = candidates(&rt);
    let items = futures::future::join_all(cands.into_iter().map(|(p, l)| {
        let vis = rt.providers.get(&p).map(|x| x.visible_models.clone()).unwrap_or_default();
        fetch_item(p, l, vis)
    }))
    .await;
    json!({"items": items, "checked_at": chrono::Utc::now().timestamp(), "cached": false})
}

fn with_cached(mut v: Value) -> Value {
    v["cached"] = json!(true);
    v
}

fn schedule_background_refresh() {
    {
        let mut st = state().lock().unwrap();
        if st.refreshing {
            return;
        }
        st.refreshing = true;
    }
    tokio::spawn(async {
        let _g = fetch_lock().lock().await;
        let fresh = state().lock().unwrap().cache.as_ref().map(|(at, _)| at.elapsed() < TTL).unwrap_or(false);
        if !fresh {
            let body = fresh_snapshot().await;
            state().lock().unwrap().cache = Some((Instant::now(), body));
        }
        state().lock().unwrap().refreshing = false;
    });
}

/// `get_connected_provider_usage_summary`.
pub async fn usage_summary(force_refresh: bool) -> Value {
    if !force_refresh {
        let cached = state().lock().unwrap().cache.clone();
        if let Some((at, body)) = cached {
            let age = at.elapsed();
            if age < TTL {
                return with_cached(body);
            }
            if age < STALE_TTL {
                schedule_background_refresh();
                return with_cached(body);
            }
        }
    }
    let _g = fetch_lock().lock().await;
    if !force_refresh {
        if let Some((at, body)) = state().lock().unwrap().cache.clone() {
            if at.elapsed() < TTL {
                return with_cached(body);
            }
        }
    }
    let body = fresh_snapshot().await;
    state().lock().unwrap().cache = Some((Instant::now(), body.clone()));
    body
}
