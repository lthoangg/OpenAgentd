//! Provider catalog (`data/provider_catalog.json`).

use serde_json::Value;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../data/provider_catalog.json");

pub fn builtin_providers() -> &'static Vec<Value> {
    static C: OnceLock<Vec<Value>> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("provider catalog json"))
}

pub fn find(provider_id: &str) -> Option<&'static Value> {
    all_providers().iter().find(|e| e["id"] == provider_id)
}

/// v2 `all_providers()`: builtins + provider plugins (display order).
pub fn all_providers() -> &'static Vec<Value> {
    static C: OnceLock<Vec<Value>> = OnceLock::new();
    C.get_or_init(|| {
        let mut entries = builtin_providers().clone();
        for p in crate::plugin::provider_plugins() {
            let info = p.info();
            if builtin_providers().iter().any(|e| e["id"] == info.id.as_str()) {
                continue;
            }
            entries.push(crate::plugin::catalog_entry(info));
        }
        entries
    })
}

/// `PROVIDER_KEY_VAR`: provider id → primary env var.
pub fn provider_key_var(provider_id: &str) -> Option<&'static str> {
    builtin_providers().iter().find(|e| e["id"] == provider_id).and_then(|e| e.get("env_var")).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// v2 `SUPPORTED_PROVIDERS` (sorted, for identical error text).
pub const SUPPORTED_PROVIDERS: &[&str] = &[
    "anthropic",
    "bedrock",
    "cliproxy",
    "codex",
    "copilot",
    "deepseek",
    "googlegenai",
    "grok",
    "nvidia",
    "ollama",
    "openai",
    "opencode",
    "opencode-go",
    "openrouter",
    "router9",
    "vertexai",
    "xai",
    "zai",
];
