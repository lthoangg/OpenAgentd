//! Provider connection state & model discovery used by the settings/agents
//! routes — port of `app/services/provider_connection.py`,
//! `model_discovery.py` and `opencode/access.py`. `all_providers()` is the
//! builtin catalog plus native provider plugins.

use appv3_core::runtime_settings::{self as rs, ProviderUiSettings};
pub use appv3_providers::creds::CredentialStore;
use appv3_providers::plugin::find_provider_plugin;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

pub const OPENCODE_PROVIDER_IDS: [&str; 2] = ["opencode", "opencode-go"];
pub const DAEMON_PROVIDER_IDS: [&str; 3] = ["ollama", "router9", "cliproxy"];
const TIMEOUT: Duration = Duration::from_secs(3);

pub fn all_providers() -> &'static Vec<Value> {
    appv3_providers::catalog::all_providers()
}

pub fn find(id: &str) -> Option<&'static Value> {
    appv3_providers::catalog::find(id)
}

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

/// `provider_is_configured(entry)` — static, no network.
pub fn provider_is_configured(entry: &Value) -> bool {
    let kind = s(entry, "kind");
    let id = s(entry, "id");
    if let Some(plugin) = find_provider_plugin(id) {
        let store = CredentialStore::for_provider(id, HashMap::new());
        if let Some(ok) = plugin.is_configured(&store) {
            return ok;
        }
        return plugin.info().credentials.iter().filter(|f| f.required).all(|f| !store.get(&f.name).is_empty());
    }
    let env = |n: &str| appv3_core::env::os_environ(n).filter(|v| !v.is_empty()).is_some();
    let st = CredentialStore::for_provider(id, HashMap::new());
    match kind {
        "local" => true,
        "oauth" => {
            if id == "copilot" && appv3_providers::copilot::env_github_token().is_some() {
                return true;
            }
            appv3_providers::oauth::is_builtin(id) && appv3_core::credentials::snapshot().enabled(id).iter().any(|c| c.has_secret())
        }
        "cloud_creds" => {
            if id == "bedrock" {
                return !st.get("AWS_BEARER_TOKEN_BEDROCK").is_empty() || !st.get("AWS_BEDROCK_PROFILE").is_empty() || env("AWS_PROFILE");
            }
            entry.get("env_vars").and_then(|v| v.as_array()).map(|a| a.iter().all(|n| !st.get(n.as_str().unwrap_or("")).is_empty())).unwrap_or(true)
        }
        _ => {
            let var = s(entry, "env_var");
            !var.is_empty() && !st.get(var).is_empty()
        }
    }
}

/// `_provider_saved_overrides(entry)`.
pub fn saved_overrides(entry: &Value) -> HashMap<String, String> {
    let st = CredentialStore::for_provider(s(entry, "id"), HashMap::new());
    let mut names: Vec<String> = vec![];
    if !s(entry, "env_var").is_empty() {
        names.push(s(entry, "env_var").into());
    }
    for n in entry.get("env_vars").and_then(|v| v.as_array()).into_iter().flatten() {
        names.push(n.as_str().unwrap_or("").into());
    }
    for f in entry.get("credentials").and_then(|v| v.as_array()).into_iter().flatten() {
        let n = s(f, "name");
        if !n.is_empty() {
            names.push(n.into());
        }
    }
    names.extend(["OLLAMA_BASE_URL", "ROUTER9_BASE_URL", "CLIPROXY_BASE_URL"].map(String::from));
    names
        .into_iter()
        .filter_map(|n| {
            let v = st.get(&n);
            (!v.is_empty()).then_some((n, v))
        })
        .collect()
}

/// `_provider_saved_display_credentials(entry)`.
pub fn saved_display_credentials(entry: &Value) -> serde_json::Map<String, Value> {
    let saved = saved_overrides(entry);
    let visible: Vec<&str> = entry
        .get("credentials")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|f| !s(f, "name").is_empty() && !f.get("secret").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|f| s(f, "name"))
        .collect();
    let mut keys: Vec<&String> = saved.keys().filter(|k| visible.contains(&k.as_str())).collect();
    keys.sort_by_key(|k| visible.iter().position(|v| v == k));
    keys.into_iter().map(|k| (k.clone(), Value::String(saved[k].clone()))).collect()
}

const NON_AGENT_MARKERS: [&str; 16] =
    ["embedding", "embed", "rerank", "moderation", "whisper", "tts", "dall-e", "davinci", "gpt-audio", "gpt-image", "imagen", "image", "lyria", "nano-banana", "sora", "veo"];

pub fn is_agent_model_id(id: &str) -> bool {
    let l = id.to_lowercase();
    !NON_AGENT_MARKERS.iter().any(|m| l.contains(m))
}

pub fn filter_agent_model_ids(ids: Vec<String>) -> Vec<String> {
    ids.into_iter().filter(|m| is_agent_model_id(m)).collect()
}

/// `opencode.access.model_is_accessible`.
pub fn model_is_accessible(provider: &str, model: &str, has_credentials: bool) -> bool {
    if !OPENCODE_PROVIDER_IDS.contains(&provider) {
        return true;
    }
    if !has_credentials {
        return false;
    }
    !(provider == "opencode" && appv3_providers::registry::get_model_cost(Some(&format!("opencode:{model}"))).input == Some(0.0))
}

pub fn filter_opencode_models_for_access(provider: &str, models: &[String], has_credentials: bool) -> Vec<String> {
    if !OPENCODE_PROVIDER_IDS.contains(&provider) {
        return models.to_vec();
    }
    if !has_credentials {
        return vec![];
    }
    models.iter().filter(|m| model_is_accessible(provider, m, true)).cloned().collect()
}

fn resolve(overrides: &HashMap<String, String>, name: &str, default: &str) -> String {
    if let Some(v) = overrides.get(name) {
        return v.clone();
    }
    let owner = appv3_providers::credentials_migration::owner_of(name);
    Some(appv3_core::credentials::lookup(owner.as_deref(), name)).filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

async fn get_json(url: &str, headers: &[(&str, String)]) -> anyhow::Result<Value> {
    let client = reqwest_client();
    let mut req = client.get(url).timeout(TIMEOUT);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let resp = req.send().await?.error_for_status()?;
    Ok(resp.json::<Value>().await?)
}

pub fn reqwest_client() -> reqwest::Client {
    appv3_providers::openai::shared_client()
}

fn ids_from_data(v: &Value, key: &str) -> Vec<String> {
    let mut out: Vec<String> = v.get(key).and_then(|d| d.as_array()).into_iter().flatten().filter_map(|i| i.get("id").and_then(|x| x.as_str()).map(String::from)).collect();
    out.sort();
    out
}

async fn openai_compatible_models(base_url: &str, token: &str) -> anyhow::Result<Vec<String>> {
    let headers = if token.is_empty() { vec![] } else { vec![("Authorization", format!("Bearer {token}"))] };
    let v = get_json(&format!("{}/models", base_url.trim_end_matches('/')), &headers).await?;
    Ok(ids_from_data(&v, "data"))
}

/// `discover_provider_models(entry, overrides=...)` — `[]` on failure.
pub async fn discover_provider_models(entry: &Value, overrides: &HashMap<String, String>) -> Vec<String> {
    let id = s(entry, "id");
    let res: anyhow::Result<Vec<String>> = async {
        if id == "openai" {
            return openai_compatible_models("https://api.openai.com/v1", &resolve(overrides, "OPENAI_API_KEY", "")).await;
        }
        if let Some(spec) = appv3_providers::factory::compat_spec(id) {
            let base = match spec.base_url_env_var {
                Some(var) => resolve(overrides, var, spec.base_url),
                None => spec.base_url.to_string(),
            };
            let mut key = resolve(overrides, spec.env_var, "");
            if key.is_empty() {
                key = spec.default_api_key.to_string();
            }
            let models = openai_compatible_models(&base, &key).await?;
            return Ok(filter_opencode_models_for_access(id, &models, !key.is_empty()));
        }
        match id {
            "zai" => openai_compatible_models("https://api.z.ai/api/paas/v4", &resolve(overrides, "ZAI_API_KEY", "")).await,
            "googlegenai" => {
                let key = resolve(overrides, "GOOGLE_API_KEY", "");
                if key.is_empty() {
                    return Ok(vec![]);
                }
                let v = get_json("https://generativelanguage.googleapis.com/v1beta/models", &[("x-goog-api-key", key)]).await?;
                let mut out: Vec<String> = v
                    .get("models")
                    .and_then(|m| m.as_array())
                    .into_iter()
                    .flatten()
                    .filter(|i| i.get("supportedGenerationMethods").and_then(|m| m.as_array()).map(|a| a.iter().any(|x| x == "generateContent")).unwrap_or(false))
                    .filter_map(|i| i.get("name").and_then(|n| n.as_str()).map(|n| n.strip_prefix("models/").unwrap_or(n).to_string()))
                    .collect();
                out.sort();
                Ok(out)
            }
            "anthropic" => {
                let key = resolve(overrides, "ANTHROPIC_API_KEY", "");
                if key.is_empty() {
                    return Ok(vec![]);
                }
                let base = resolve(overrides, "ANTHROPIC_BASE_URL", "https://api.anthropic.com");
                let v = get_json(&format!("{}/v1/models", base.trim_end_matches('/')), &[("x-api-key", key), ("anthropic-version", "2023-06-01".into())]).await?;
                Ok(ids_from_data(&v, "data"))
            }
            "copilot" => Ok(appv3_providers::copilot::discover_models().await),
            "codex" => Ok(appv3_providers::codex::model_ids(appv3_providers::codex::load_catalog(false).await.as_ref())),
            "grok" => appv3_providers::grok::discover_models().await.map_err(|e| anyhow::anyhow!(e)),
            "bedrock" => appv3_providers::bedrock::discover_models(overrides).await.map_err(|e| anyhow::anyhow!(e)),
            _ => match find_provider_plugin(id) {
                Some(p) if p.has_discover_models() => {
                    let store = CredentialStore::for_provider(id, overrides.clone());
                    p.discover_models(&store).await.map_err(|e| anyhow::anyhow!(e))
                }
                _ => Ok(vec![]),
            },
        }
    }
    .await;
    match res {
        Ok(m) => filter_agent_model_ids(m),
        Err(e) => {
            tracing::info!("provider_models_unavailable provider={} error={}", id, e);
            vec![]
        }
    }
}

pub fn daemon_base_url(id: &str) -> String {
    let (var, default) = match id {
        "ollama" => ("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
        "router9" => ("ROUTER9_BASE_URL", "http://localhost:20128/v1"),
        "cliproxy" => ("CLIPROXY_BASE_URL", "http://localhost:8317/v1"),
        _ => return String::new(),
    };
    Some(appv3_core::credentials::lookup(Some(id), var)).filter(|v| !v.is_empty()).unwrap_or_else(|| default.into())
}

fn reach_cache() -> &'static std::sync::Mutex<HashMap<String, (std::time::Instant, bool)>> {
    static C: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (std::time::Instant, bool)>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

/// `_local_provider_reachable` (10 s cache, 1 s timeout).
pub async fn local_provider_reachable(id: &str) -> bool {
    let now = std::time::Instant::now();
    if let Some((t, ok)) = reach_cache().lock().unwrap().get(id).copied() {
        if now.duration_since(t) < Duration::from_secs(10) {
            return ok;
        }
    }
    let base = daemon_base_url(id);
    let mut ok = false;
    if !base.is_empty() {
        ok = match reqwest_client().get(format!("{}/models", base.trim_end_matches('/'))).timeout(Duration::from_secs(1)).send().await {
            Ok(r) => r.status().as_u16() < 500,
            Err(_) => false,
        };
    }
    reach_cache().lock().unwrap().insert(id.to_string(), (now, ok));
    ok
}

/// `_provider_is_reachable`.
pub async fn provider_is_reachable(entry: &Value) -> bool {
    let id = s(entry, "id");
    if DAEMON_PROVIDER_IDS.contains(&id) {
        if s(entry, "kind") == "api_key" && !provider_is_configured(entry) {
            return false;
        }
        return local_provider_reachable(id).await;
    }
    provider_is_configured(entry)
}

pub fn ui(cfg: &rs::RuntimeSettings, id: &str) -> ProviderUiSettings {
    cfg.providers.get(id).cloned().unwrap_or_default()
}

/// `is_registered_model_id(model_id)`.
pub fn is_registered_model_id(model_id: &str) -> bool {
    let Some((provider, model)) = model_id.split_once(':') else { return false };
    if provider.is_empty() || model.is_empty() {
        return false;
    }
    let Some(entry) = find(provider) else { return false };
    let cfg = rs::load_runtime_settings().unwrap_or_default();
    let pui = ui(&cfg, provider);
    if pui.is_disconnected {
        return false;
    }
    let configured = provider_is_configured(entry);
    if !configured {
        if !pui.cached_models.is_empty() {
            let _ = rs::forget_provider_models(provider);
        }
        if !OPENCODE_PROVIDER_IDS.contains(&provider) {
            return false;
        }
    }
    let visible = pui.effective_visible_models();
    if !visible.is_empty() && !visible.iter().any(|m| m == model) {
        return false;
    }
    if !model_is_accessible(provider, model, configured) {
        return false;
    }
    is_agent_model_id(model) && pui.cached_models.iter().any(|m| m == model)
}
