//! Provider factory — port of `app/agent/providers/factory.py`.

use crate::anthropic::{AnthropicProvider, ANTHROPIC_API_BASE};
use crate::catalog::SUPPORTED_PROVIDERS;
use crate::creds::CredentialStore;
use crate::google::{GoogleGenAiProvider, API_BASE_URL as GOOGLE_BASE};
use crate::oauth::TokenSlot;
use crate::openai::{CompletionsDialect, OpenAiProvider, API_BASE_URL as OPENAI_BASE};
use crate::registry::{get_model_cost, get_model_limits, get_model_transport};
use crate::types::*;
use serde_json::json;
use std::sync::{Arc, OnceLock};

pub struct CompatSpec {
    pub provider_id: &'static str,
    pub label: &'static str,
    pub env_var: &'static str,
    pub base_url: &'static str,
    pub base_url_env_var: Option<&'static str>,
    pub default_api_key: &'static str,
}

pub const COMPAT_SPECS: &[CompatSpec] = &[
    CompatSpec {
        provider_id: "opencode",
        label: "OpenCode Zen",
        env_var: "OPENCODE_ZEN_API_KEY",
        base_url: "https://opencode.ai/zen/v1",
        base_url_env_var: None,
        default_api_key: "",
    },
    CompatSpec {
        provider_id: "opencode-go",
        label: "OpenCode Go",
        env_var: "OPENCODE_GO_API_KEY",
        base_url: "https://opencode.ai/zen/go/v1",
        base_url_env_var: None,
        default_api_key: "",
    },
    CompatSpec {
        provider_id: "openrouter",
        label: "OpenRouter",
        env_var: "OPENROUTER_API_KEY",
        base_url: "https://openrouter.ai/api/v1",
        base_url_env_var: None,
        default_api_key: "",
    },
    CompatSpec { provider_id: "nvidia", label: "NVIDIA", env_var: "NVIDIA_API_KEY", base_url: "https://integrate.api.nvidia.com/v1", base_url_env_var: None, default_api_key: "" },
    CompatSpec {
        provider_id: "router9",
        label: "9Router",
        env_var: "ROUTER9_API_KEY",
        base_url: "http://localhost:20128/v1",
        base_url_env_var: Some("ROUTER9_BASE_URL"),
        default_api_key: "",
    },
    CompatSpec {
        provider_id: "cliproxy",
        label: "CLIProxyAPI",
        env_var: "CLIPROXY_API_KEY",
        base_url: "http://localhost:8317/v1",
        base_url_env_var: Some("CLIPROXY_BASE_URL"),
        default_api_key: "",
    },
    CompatSpec {
        provider_id: "ollama",
        label: "Ollama",
        env_var: "OLLAMA_API_KEY",
        base_url: "http://localhost:11434/v1",
        base_url_env_var: Some("OLLAMA_BASE_URL"),
        default_api_key: "ollama",
    },
    CompatSpec { provider_id: "xai", label: "xAI", env_var: "XAI_API_KEY", base_url: "https://api.x.ai/v1", base_url_env_var: None, default_api_key: "" },
    CompatSpec { provider_id: "deepseek", label: "DeepSeek", env_var: "DEEPSEEK_API_KEY", base_url: "https://api.deepseek.com/v1", base_url_env_var: None, default_api_key: "" },
];

pub fn compat_spec(id: &str) -> Option<&'static CompatSpec> {
    COMPAT_SPECS.iter().find(|s| s.provider_id == id)
}

/// v2 `require_api_key`, reading `creds` (overrides → exported env →
/// `credentials.yaml`).
pub fn require_api_key(creds: &CredentialStore, env_var: &str, label: &str) -> ProviderResult<String> {
    let v = creds.get(env_var);
    if !v.is_empty() {
        return Ok(v);
    }
    Err(ProviderError::Unconfigured(format!("{label} API key is required. Add one in Settings → Providers, or export {env_var}.")))
}

pub const UNCONFIGURED_TOKEN: &str = "__PROVIDER_MODEL__";

pub fn unconfigured_message(agent_name: Option<&str>) -> String {
    format!("Agent '{}' has no model configured. Open Settings → Providers in the UI to add a provider and select a model.", agent_name.unwrap_or("?"))
}

fn named<P: LlmProvider + 'static>(p: P) -> Arc<dyn LlmProvider> {
    Arc::new(p)
}

/// Build a provider for `"<provider>:<model>"` with the stored credentials.
pub fn build_provider(model_str: Option<&str>, model_kwargs: Kwargs) -> ProviderResult<Arc<dyn LlmProvider>> {
    let (name, model) = parse_model_str(model_str)?;
    crate::pool::build_pooled(name, model, model_kwargs)
}

/// Build with explicit candidate values (validating credentials before they
/// are saved): `overrides` win over the exported env and the store.
pub fn build_provider_with_overrides(model_str: Option<&str>, model_kwargs: Kwargs, overrides: std::collections::HashMap<String, String>) -> ProviderResult<Arc<dyn LlmProvider>> {
    let (name, model) = parse_model_str(model_str)?;
    build_member(name, model, model_kwargs, &CredentialStore::for_provider(name, overrides), None)
}

/// Split and validate `"<provider>:<model>"`.
pub fn parse_model_str(model_str: Option<&str>) -> ProviderResult<(&str, &str)> {
    let model_str = model_str.unwrap_or("");
    if model_str.is_empty() {
        return Err(ProviderError::Invalid(
            "No model specified. Set 'model' in the agent's .md frontmatter (format: 'provider:model', e.g. 'googlegenai:gemini-3.1-flash').".into(),
        ));
    }
    if model_str.contains(UNCONFIGURED_TOKEN) {
        return Err(ProviderError::Unconfigured(unconfigured_message(None)));
    }
    let Some((name, model)) = model_str.split_once(':') else {
        return Err(ProviderError::Invalid(format!("Invalid model format '{model_str}'. Expected 'provider:model' (e.g. 'zai:glm-5-turbo', 'googlegenai:gemini-3.1-flash').")));
    };
    Ok((name, model))
}

/// Build one concrete provider: API keys and settings come from `creds`,
/// an OAuth provider's tokens from `slot` (the account in use when `None`).
pub fn build_member(name: &str, model: &str, model_kwargs: Kwargs, creds: &CredentialStore, slot: Option<&TokenSlot>) -> ProviderResult<Arc<dyn LlmProvider>> {
    let env = |n: &str| creds.get(n);
    let kw = model_kwargs;
    let pname = Some(name.to_string());
    match name {
        "openai" => {
            let key = require_api_key(creds, "OPENAI_API_KEY", "OpenAI")?;
            let mut p = OpenAiProvider::new(&key, model, OPENAI_BASE, kw, CompletionsDialect::OpenAi, true)?;
            p.provider_name = pname;
            Ok(named(p))
        }
        _ if compat_spec(name).is_some() => {
            let spec = compat_spec(name).unwrap();
            let mut key = spec.default_api_key.to_string();
            let configured = env(spec.env_var);
            if !configured.is_empty() {
                key = configured;
            }
            if spec.default_api_key.is_empty() {
                key = require_api_key(creds, spec.env_var, spec.label)?;
            }
            let base_url = spec.base_url_env_var.map(&env).filter(|s| !s.is_empty()).unwrap_or_else(|| spec.base_url.to_string());
            match name {
                "opencode" | "opencode-go" => build_opencode(name, model, &key, &base_url, kw),
                "deepseek" => {
                    let mut p = OpenAiProvider::new(&key, model, spec.base_url, kw, CompletionsDialect::DeepSeek, false)?;
                    p.provider_name = pname;
                    Ok(named(p))
                }
                "xai" => {
                    let mut p = OpenAiProvider::new(&key, model, spec.base_url, kw, CompletionsDialect::OpenAi, true)?;
                    p.provider_name = pname;
                    Ok(named(p))
                }
                "ollama" => {
                    let key = if key.is_empty() { "ollama".to_string() } else { key };
                    let mut p = OpenAiProvider::new(&key, model, &base_url, kw, CompletionsDialect::Legacy, true)?;
                    p.provider_name = pname;
                    Ok(named(p))
                }
                _ => {
                    let mut p = OpenAiProvider::new(&key, model, &base_url, kw, CompletionsDialect::OpenAi, false)?;
                    p.provider_name = pname;
                    Ok(named(p))
                }
            }
        }
        "anthropic" => {
            let key = require_api_key(creds, "ANTHROPIC_API_KEY", "Anthropic")?;
            let base = Some(env("ANTHROPIC_BASE_URL")).filter(|s| !s.is_empty()).unwrap_or_else(|| ANTHROPIC_API_BASE.into());
            let mut p = AnthropicProvider::new(&key, model, &base, kw)?;
            p.provider_name = pname;
            Ok(named(p))
        }
        "googlegenai" => {
            let key = require_api_key(creds, "GOOGLE_API_KEY", "Google")?;
            let mut p = GoogleGenAiProvider::new(&key, model, GOOGLE_BASE, kw)?;
            p.provider_name = pname;
            Ok(named(p))
        }
        "vertexai" => {
            let key = require_api_key(creds, "VERTEXAI_API_KEY", "Vertex AI")?;
            let project = Some(env("GOOGLE_CLOUD_PROJECT")).filter(|s| !s.is_empty());
            let location = Some(env("GOOGLE_CLOUD_LOCATION")).filter(|s| !s.is_empty()).unwrap_or_else(|| "global".into());
            let mut p = GoogleGenAiProvider::vertex(&key, model, project.as_deref(), &location, kw)?;
            p.provider_name = pname;
            Ok(named(p))
        }
        // OAuth / cloud-credential providers name themselves in their builders;
        // `_with_provider_name` then overwrites with the registry name.
        "copilot" => match slot {
            Some(s) => crate::copilot::build_for(model, kw, s),
            None => crate::copilot::build(model, kw),
        },
        "codex" => crate::codex::build_for(model, kw, &slot.cloned().unwrap_or_else(crate::codex::oauth_slot)),
        "grok" => crate::grok::build_for(model, kw, &slot.cloned().unwrap_or_else(crate::grok::oauth_slot)),
        "bedrock" => crate::bedrock::build(model, kw, creds),
        "zai" => {
            let key = require_api_key(creds, "ZAI_API_KEY", "ZAI")?;
            let mut p = OpenAiProvider::new(&key, model, "https://api.z.ai/api/paas/v4", kw, CompletionsDialect::Zai, true)?;
            p.provider_name = pname;
            Ok(named(p))
        }
        _ => match crate::plugin::find_provider_plugin(name) {
            Some(plugin) => plugin.build(crate::plugin::BuildContext { provider_id: name.to_string(), model: model.to_string(), model_kwargs: kw, credentials: creds.clone() }),
            None => Err(ProviderError::Unconfigured(format!("Unsupported provider '{name}'. Supported providers: {}", SUPPORTED_PROVIDERS.join(", ")))),
        },
    }
}

fn build_opencode(pid: &str, model: &str, key: &str, base_url: &str, kw: Kwargs) -> ProviderResult<Arc<dyn LlmProvider>> {
    if key.is_empty() {
        let env_var = if pid == "opencode-go" { "OPENCODE_GO_API_KEY" } else { "OPENCODE_ZEN_API_KEY" };
        return Err(ProviderError::Invalid(format!("OpenCode API key is required. Set {env_var}.")));
    }
    let model_id = format!("{pid}:{model}");
    if pid == "opencode" && get_model_cost(Some(&model_id)).input == Some(0.0) {
        return Err(ProviderError::Invalid(format!("OpenCode Zen model '{model}' is not supported; free OpenCode models only open using OpenCode's own harness.")));
    }
    let base = base_url.trim_end_matches('/');
    let pname = Some(pid.to_string());
    match get_model_transport(Some(&model_id)).as_deref().unwrap_or("chat_completions") {
        "messages" => {
            let mut kw = kw;
            if !kw.contains_key("max_tokens") {
                if let Some(m) = get_model_limits(Some(&model_id)).max_completion_tokens {
                    kw.insert("max_tokens".into(), json!(m));
                }
            }
            let mut p = AnthropicProvider::new(key, model, base.strip_suffix("/v1").unwrap_or(base), kw)?;
            p.provider_name = pname;
            Ok(named(p))
        }
        "generate_content" => {
            let mut p = GoogleGenAiProvider::new(key, model, base, kw)?;
            p.provider_name = pname;
            Ok(named(p))
        }
        "responses" => {
            let mut p = OpenAiProvider::new(key, model, base, kw, CompletionsDialect::OpenAi, true)?;
            p.use_responses = true;
            p.responses.preserve_stateless_reasoning = true;
            p.provider_name = pname;
            Ok(named(p))
        }
        _ => {
            let dialect = if model.starts_with("deepseek-") { CompletionsDialect::DeepSeek } else { CompletionsDialect::OpenAi };
            let mut p = OpenAiProvider::new(key, model, base, kw, dialect, false)?;
            p.provider_name = pname;
            Ok(named(p))
        }
    }
}

/// Stub used when an agent has no usable model (v2 `UnconfiguredProvider`).
pub struct UnconfiguredProvider {
    pub message: String,
    kw: Kwargs,
}

impl UnconfiguredProvider {
    pub fn new(message: String) -> Self {
        Self { message, kw: Kwargs::new() }
    }
}

#[async_trait::async_trait]
impl LlmProvider for UnconfiguredProvider {
    fn model(&self) -> &str {
        "__unconfigured__"
    }
    fn provider_name(&self) -> Option<&str> {
        None
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<AssistantMessage> {
        Err(ProviderError::Unconfigured(self.message.clone()))
    }
    async fn stream(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<ChunkStream> {
        Err(ProviderError::Unconfigured(self.message.clone()))
    }
}

/// Builds the real provider; called again until it succeeds.
pub type ProviderBuilder = Arc<dyn Fn() -> ProviderResult<Arc<dyn LlmProvider>> + Send + Sync>;

/// Stand-in for a provider that failed to build (expired OAuth login, missing
/// key, network blip). Each call retries the build, so fixing credentials
/// takes effect without restarting the app. The first successful build is
/// kept and every later call goes straight to it.
pub struct RetryingProvider {
    builder: ProviderBuilder,
    /// Shown when a failed build gives no message of its own.
    fallback_message: String,
    built: OnceLock<Arc<dyn LlmProvider>>,
    kw: Kwargs,
}

impl RetryingProvider {
    pub fn new(builder: ProviderBuilder, fallback_message: String) -> Self {
        Self { builder, fallback_message, built: OnceLock::new(), kw: Kwargs::new() }
    }

    async fn provider(&self) -> ProviderResult<&Arc<dyn LlmProvider>> {
        if let Some(p) = self.built.get() {
            return Ok(p);
        }
        // Plugin builds block on the JS runtime (an OAuth refresh can take a
        // network round trip), so keep them off the async workers.
        let builder = self.builder.clone();
        let built = tokio::task::spawn_blocking(move || builder()).await.map_err(|e| ProviderError::Other(e.to_string()))?;
        match built {
            Ok(p) => {
                tracing::info!("provider_build_recovered model={}", p.model());
                Ok(self.built.get_or_init(|| p))
            }
            Err(e) => {
                let msg = e.to_string();
                Err(ProviderError::Unconfigured(if msg.is_empty() { self.fallback_message.clone() } else { msg }))
            }
        }
    }
}

#[async_trait::async_trait]
impl LlmProvider for RetryingProvider {
    fn model(&self) -> &str {
        self.built.get().map(|p| p.model()).unwrap_or("__unconfigured__")
    }
    fn provider_name(&self) -> Option<&str> {
        self.built.get().and_then(|p| p.provider_name())
    }
    fn support_interrupt(&self) -> bool {
        self.built.get().map(|p| p.support_interrupt()).unwrap_or(true)
    }
    fn base_kwargs(&self) -> &Kwargs {
        self.built.get().map(|p| p.base_kwargs()).unwrap_or(&self.kw)
    }
    fn merged_kwargs(&self, call: &Kwargs) -> Kwargs {
        match self.built.get() {
            Some(p) => p.merged_kwargs(call),
            None => call.clone(),
        }
    }
    fn cost_model_id(&self) -> Option<String> {
        match self.built.get() {
            Some(p) => p.cost_model_id(),
            None => Some(self.model().to_string()),
        }
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        self.provider().await?.chat(messages, tools, kwargs).await
    }
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        self.provider().await?.stream(messages, tools, kwargs).await
    }
    fn rotate_credential(&self, err: &ProviderError, reason: &str, cooldown_secs: f64) -> Option<String> {
        self.built.get()?.rotate_credential(err, reason, cooldown_secs)
    }
    fn credential_recovery_secs(&self) -> Option<f64> {
        self.built.get()?.credential_recovery_secs()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_match_v2() {
        let e = build_provider(Some("gpt"), Kwargs::new()).err().unwrap();
        assert!(e.to_string().starts_with("Invalid model format 'gpt'."));
        let e = build_provider(Some("nope:x"), Kwargs::new()).err().unwrap();
        assert!(e.to_string().starts_with("Unsupported provider 'nope'. Supported providers: anthropic, bedrock"));
        assert!(matches!(build_provider(Some("__PROVIDER_MODEL__"), Kwargs::new()), Err(ProviderError::Unconfigured(_))));
    }
}
