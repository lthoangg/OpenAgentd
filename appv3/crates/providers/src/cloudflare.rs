//! Cloudflare (`cf`): Workers AI (`@cf/…`) and third-party models
//! (`openai/…`, `anthropic/…`) through Cloudflare's REST API, routed via an
//! AI Gateway. One OpenAI-compatible endpoint serves both kinds of model:
//! `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1`.
//!
//! Two settings: the account ID and an API token with Account → Workers AI →
//! Read, which every `/accounts/{id}/ai/*` endpoint requires (a token holding
//! only AI Gateway permissions gets 401 code 10000).

use crate::creds::CredentialStore;
use crate::openai::{CompletionsDialect, OpenAiProvider};
use crate::types::*;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub const PROVIDER_ID: &str = "cf";
pub const ACCOUNT_VAR: &str = "CLOUDFLARE_ACCOUNT_ID";
pub const TOKEN_VAR: &str = "CLOUDFLARE_API_TOKEN";
/// Workers AI requests must name a gateway in `cf-aig-gateway-id`; Cloudflare
/// creates `default` on an account's first request, so no setting is needed.
pub const GATEWAY: &str = "default";
const API_ROOT: &str = "https://api.cloudflare.com/client/v4/accounts";

/// The settings one request needs.
#[derive(Debug, Clone, PartialEq)]
pub struct CfSettings {
    pub account_id: String,
    pub token: String,
}

impl CfSettings {
    /// Read from `creds`; names every missing required field.
    pub fn from_creds(creds: &CredentialStore) -> ProviderResult<Self> {
        let get = |n: &str| creds.get(n).trim().to_string();
        let (account_id, token) = (get(ACCOUNT_VAR), get(TOKEN_VAR));
        let missing: Vec<String> = [("Account ID", ACCOUNT_VAR, &account_id), ("API token", TOKEN_VAR, &token)]
            .into_iter()
            .filter(|(_, _, v)| v.is_empty())
            .map(|(label, var, _)| format!("its {label} ({var})"))
            .collect();
        if !missing.is_empty() {
            return Err(ProviderError::Unconfigured(format!("Cloudflare needs {}. Add it in Settings → Models, or export it.", missing.join(" and "))));
        }
        Ok(Self { account_id, token })
    }

    /// `…/accounts/{account}/ai/v1`.
    pub fn base_url(&self) -> String {
        format!("{API_ROOT}/{}/ai/v1", self.account_id)
    }

    /// Bearer token plus the gateway the request is routed through
    /// (required for Workers AI models, honoured for third-party ones).
    pub fn headers(&self) -> Vec<(String, String)> {
        vec![("Authorization".into(), format!("Bearer {}", self.token)), ("Content-Type".into(), "application/json".into()), ("cf-aig-gateway-id".into(), GATEWAY.into())]
    }
}

/// Factory entry. Every model, Workers AI or third-party, uses chat
/// completions: the one format both kinds support.
pub fn build(model: &str, model_kwargs: Kwargs, creds: &CredentialStore) -> ProviderResult<Arc<dyn LlmProvider>> {
    Ok(Arc::new(build_openai(model, model_kwargs, creds)?))
}

fn build_openai(model: &str, model_kwargs: Kwargs, creds: &CredentialStore) -> ProviderResult<OpenAiProvider> {
    let s = CfSettings::from_creds(creds)?;
    let mut p = OpenAiProvider::with_headers(model, &s.base_url(), s.headers(), model_kwargs, CompletionsDialect::OpenAi, false);
    p.provider_name = Some(PROVIDER_ID.into());
    Ok(p)
}

/// What models.dev says about tool calling for `cf:<model>`: `None` when the
/// registry has no entry or no `tool_call` flag.
fn registry_tool_call(reg: &crate::registry::Registry, model: &str) -> Option<bool> {
    reg.get(&format!("cf:{model}")).and_then(|e| e.get("features")).and_then(|f| f.get("tool_call")).and_then(|v| v.as_bool())
}

/// Whether a model-search result can drive an agent (call tools). Cloudflare
/// lists `function_calling` among a model's `properties` only when it is
/// supported, so a properties list without it means no tools. A result with
/// no properties at all says nothing: models.dev decides, and a model neither
/// knows is kept.
fn workers_ai_model_calls_tools(m: &Value, model: &str, reg: &crate::registry::Registry) -> bool {
    match m.get("properties").and_then(|p| p.as_array()) {
        Some(props) => props.iter().any(|p| {
            let on = match p.get("value") {
                Some(Value::Bool(b)) => *b,
                Some(Value::String(s)) => s == "true",
                _ => false,
            };
            p.get("property_id").and_then(|i| i.as_str()) == Some("function_calling") && on
        }),
        None => registry_tool_call(reg, model) != Some(false),
    }
}

/// Workers AI text-generation model names from a model-search response,
/// keeping only models that call tools (Clairic, Llama Guard and chat-only
/// models share the "Text Generation" task but cannot run an agent).
fn workers_ai_ids(v: &Value, reg: &crate::registry::Registry) -> Vec<String> {
    v.get("result")
        .and_then(|r| r.as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(|n| (m, n)))
        .filter(|(m, n)| n.starts_with("@cf/") && workers_ai_model_calls_tools(m, n, reg))
        .map(|(_, n)| n.to_string())
        .collect()
}

/// Third-party model ids the registry knows for `cf` (from the models.dev
/// `cloudflare-ai-gateway` list): every `cf:` key that is not a Workers AI
/// one, except models models.dev marks as unable to call tools.
fn gateway_ids(reg: &crate::registry::Registry) -> Vec<String> {
    reg.keys().filter_map(|k| k.strip_prefix("cf:")).filter(|m| !m.starts_with("@cf/") && registry_tool_call(reg, m) != Some(false)).map(String::from).collect()
}

/// Workers AI models first, then third-party ones; sorted within each, no duplicates.
pub fn merge_model_ids(mut workers: Vec<String>, mut gateway: Vec<String>) -> Vec<String> {
    workers.sort();
    workers.dedup();
    gateway.sort();
    gateway.dedup();
    gateway.retain(|g| !workers.contains(g));
    workers.extend(gateway);
    workers
}

/// Live Workers AI text models from the account, plus the known third-party
/// gateway models. A failed Workers AI request is an error: it means the
/// account ID or token is wrong.
pub async fn discover_models(creds: &CredentialStore) -> Result<Vec<String>, String> {
    let s = CfSettings::from_creds(creds).map_err(|e| e.to_string())?;
    let url = format!("{API_ROOT}/{}/ai/models/search", s.account_id);
    let r = crate::openai::shared_client()
        .get(&url)
        .query(&[("task", "Text Generation"), ("per_page", "500")])
        .header("Authorization", format!("Bearer {}", s.token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    if st >= 400 {
        return Err(crate::plugin::http_status_message(st, &url));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let reg = crate::registry::load_model_registry();
    Ok(merge_model_ids(workers_ai_ids(&v, &reg), gateway_ids(&reg)))
}

/// A store that reads exactly `values` for the two Cloudflare settings
/// (missing ones read empty), whatever the environment or stored files hold.
pub fn store_from(values: &HashMap<String, String>) -> CredentialStore {
    let exact = [ACCOUNT_VAR, TOKEN_VAR].into_iter().map(|n| (n.to_string(), values.get(n).cloned().unwrap_or_default())).collect();
    CredentialStore::for_provider(PROVIDER_ID, exact)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn creds(pairs: &[(&str, &str)]) -> CredentialStore {
        store_from(&pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    fn header<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
        h.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn workers_ai_and_gateway_models_share_one_url_and_header_set() {
        let c = creds(&[(ACCOUNT_VAR, "abc123"), (TOKEN_VAR, "tok")]);
        for model in ["@cf/deepseek-ai/deepseek-v4.1-flash-1017", "openai/gpt-4.1", "anthropic/claude-sonnet-4.6"] {
            let p = build_openai(model, Kwargs::new(), &c).unwrap();
            assert_eq!(p.model, model, "the model id is sent unchanged");
            assert!(!p.use_responses, "{model} uses chat completions");
            assert_eq!(p.completions.base_url, "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1");
            let h = &p.completions.headers;
            assert_eq!(header(h, "Authorization"), Some("Bearer tok"));
            assert_eq!(header(h, "cf-aig-gateway-id"), Some("default"));
            assert_eq!(p.provider_name.as_deref(), Some("cf"));
        }
    }

    #[test]
    fn missing_credentials_are_named() {
        let e = build("x", Kwargs::new(), &creds(&[(TOKEN_VAR, "tok")])).err().unwrap();
        assert!(matches!(e, ProviderError::Unconfigured(_)));
        assert!(e.to_string().contains("Account ID (CLOUDFLARE_ACCOUNT_ID)") && !e.to_string().contains(TOKEN_VAR), "{e}");
        let e = build("x", Kwargs::new(), &creds(&[])).err().unwrap().to_string();
        assert!(e.contains(ACCOUNT_VAR) && e.contains("API token (CLOUDFLARE_API_TOKEN)"), "{e}");
    }

    #[test]
    fn the_card_asks_for_two_fields_and_says_where_to_get_them() {
        let entry = crate::catalog::all_providers().into_iter().find(|e| e["id"] == PROVIDER_ID).expect("cf in the catalogue");
        let fields = entry["credentials"].as_array().unwrap();
        let names: Vec<&str> = fields.iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert_eq!(names, [ACCOUNT_VAR, TOKEN_VAR]);
        for f in fields {
            assert_eq!(f["required"], true, "{f}");
            assert!(f["help"].as_str().is_some_and(|h| !h.is_empty()), "{f} says where to get it");
            assert!(f["help_url"].as_str().is_some_and(|u| u.starts_with("https://dash.cloudflare.com/")), "{f}");
        }
        assert_eq!(fields[1]["secret"], true);
        assert!(fields[1]["help"].as_str().unwrap().contains("Workers AI → Read"), "the token help names its permission");
    }

    #[test]
    fn model_list_puts_workers_ai_first_and_drops_duplicates() {
        let search = json!({"success": true, "result": [
            {"name": "@cf/qwen/qwq-32b"}, {"name": "@cf/deepseek-ai/deepseek-v4.1-flash-1017"}, {"name": "not-a-cf-model"}, {"id": "no-name"}
        ]});
        let mut reg = crate::registry::Registry::new();
        for k in ["cf:openai/gpt-4.1", "cf:anthropic/claude-sonnet-4.6", "cf:@cf/qwen/qwq-32b", "openai:gpt-4.1"] {
            reg.insert(k.into(), json!({}));
        }
        let ids = merge_model_ids(workers_ai_ids(&search, &reg), gateway_ids(&reg));
        assert_eq!(ids, ["@cf/deepseek-ai/deepseek-v4.1-flash-1017", "@cf/qwen/qwq-32b", "anthropic/claude-sonnet-4.6", "openai/gpt-4.1"]);
    }

    /// Trimmed from a real `/ai/models/search?task=Text Generation` response:
    /// Cloudflare lists `function_calling` only for models that support it.
    fn live_search() -> Value {
        let fc = json!({"property_id": "function_calling", "value": "true"});
        let ctx = json!({"property_id": "context_window", "value": "65536"});
        json!({"success": true, "result": [
            {"name": "@cf/deepseek-ai/deepseek-v4.1-flash-1017", "properties": [ctx, fc]},
            {"name": "@cf/openai/gpt-oss-120b", "properties": [fc, ctx]},
            {"name": "@cf/cloudflare/clairic-flash", "properties": [ctx, {"property_id": "vision", "value": "true"}]},
            {"name": "@cf/cloudflare/clef", "properties": [ctx, {"property_id": "info", "value": "https://x"}]},
            {"name": "@cf/meta/llama-guard-3-8b", "properties": [ctx, {"property_id": "lora", "value": "true"}]},
            {"name": "@cf/meta/llama-3.2-11b-vision-instruct", "properties": [ctx]},
            {"name": "@cf/qwen/qwen2.5-coder-32b-instruct", "properties": [ctx]},
            {"name": "@cf/aisingapore/gemma-sea-lion-v4-27b-it", "properties": [ctx]},
            {"name": "@cf/x/flag-off", "properties": [{"property_id": "function_calling", "value": "false"}]}
        ]})
    }

    #[test]
    fn cloudflare_function_calling_property_decides_workers_ai_models() {
        // models.dev claiming tools cannot resurrect a model Cloudflare lists without them.
        let mut reg = crate::registry::Registry::new();
        reg.insert("cf:@cf/cloudflare/clairic-flash".into(), json!({"features": {"tool_call": true}}));
        let ids = workers_ai_ids(&live_search(), &reg);
        assert_eq!(ids, ["@cf/deepseek-ai/deepseek-v4.1-flash-1017", "@cf/openai/gpt-oss-120b"]);
    }

    #[test]
    fn without_cloudflare_properties_models_dev_decides_and_unknown_is_kept() {
        let search = json!({"result": [
            {"name": "@cf/cloudflare/clairic-flash"}, {"name": "@cf/meta/llama-guard-3-8b"}, {"name": "@cf/zai-org/glm-4.7-flash"}, {"name": "@cf/new/unknown-model"}
        ]});
        let mut reg = crate::registry::Registry::new();
        reg.insert("cf:@cf/cloudflare/clairic-flash".into(), json!({"features": {"tool_call": false}}));
        reg.insert("cf:@cf/meta/llama-guard-3-8b".into(), json!({"features": {"tool_call": false}}));
        reg.insert("cf:@cf/zai-org/glm-4.7-flash".into(), json!({"features": {"tool_call": true}}));
        assert_eq!(workers_ai_ids(&search, &reg), ["@cf/zai-org/glm-4.7-flash", "@cf/new/unknown-model"]);
    }

    #[test]
    fn gateway_models_without_tool_calling_are_hidden() {
        let mut reg = crate::registry::Registry::new();
        reg.insert("cf:openai/gpt-4.1".into(), json!({"features": {"tool_call": true}}));
        reg.insert("cf:openai/text-only".into(), json!({"features": {"tool_call": false}}));
        reg.insert("cf:anthropic/unknown".into(), json!({}));
        let mut ids = gateway_ids(&reg);
        ids.sort();
        assert_eq!(ids, ["anthropic/unknown", "openai/gpt-4.1"]);
    }
}
