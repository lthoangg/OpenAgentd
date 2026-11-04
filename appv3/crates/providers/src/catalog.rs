//! Provider catalog (`data/provider_catalog.json`).

use serde_json::Value;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../data/provider_catalog.json");

pub fn builtin_providers() -> &'static Vec<Value> {
    static C: OnceLock<Vec<Value>> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("provider catalog json"))
}

/// Whether `id` is a built-in provider's id, ignoring ASCII case: a plugin bundle may not take it. Ids that
/// differ in case only are one id to the file system (`provider-plugins/<id>` is the same folder on a
/// case-insensitive one), so they are one here.
pub(crate) fn is_builtin_id(id: &str) -> bool {
    builtin_providers().iter().any(|e| e["id"].as_str().is_some_and(|b| b.eq_ignore_ascii_case(id)))
}

/// The catalog entry of `provider_id`: a builtin, a single-file plugin, or the
/// provider of a running plugin bundle.
pub fn find(provider_id: &str) -> Option<Value> {
    if let Some(e) = process_providers().iter().find(|e| e["id"] == provider_id) {
        return Some(e.clone());
    }
    crate::plugin::provider_plugins().into_iter().find(|p| p.info().id == provider_id).map(|p| crate::plugin::catalog_entry(p.info()))
}

/// Builtins and single-file plugins (display order), built once per process.
fn process_providers() -> &'static Vec<Value> {
    static C: OnceLock<Vec<Value>> = OnceLock::new();
    C.get_or_init(|| {
        let mut entries = builtin_providers().clone();
        for p in crate::plugin::single_file_plugins() {
            let info = p.info();
            if entries.iter().any(|e| e["id"] == info.id.as_str()) {
                continue;
            }
            entries.push(crate::plugin::catalog_entry(info));
        }
        entries
    })
}

/// Builtins, single-file plugins, then the provider of each running plugin
/// bundle (display order). Owned: a bundle's entry comes and goes with its
/// module, so only the first two are cached.
pub fn all_providers() -> Vec<Value> {
    let mut entries = process_providers().clone();
    for p in crate::plugin::provider_plugins() {
        let info = p.info();
        if entries.iter().any(|e| e["id"] == info.id.as_str()) {
            continue;
        }
        entries.push(crate::plugin::catalog_entry(info));
    }
    entries
}

/// `PROVIDER_KEY_VAR`: provider id → primary env var.
pub fn provider_key_var(provider_id: &str) -> Option<&'static str> {
    builtin_providers().iter().find(|e| e["id"] == provider_id).and_then(|e| e.get("env_var")).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// Supported provider ids (sorted, for identical error text).
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
