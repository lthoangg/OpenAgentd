//! Built-in prompt strings (`data/builtin_prompts.json`).

use serde_json::Value;
use std::sync::OnceLock;

const JSON: &str = include_str!("../data/builtin_prompts.json");

pub fn contract() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(JSON).expect("builtin_prompts.json"))
}

pub fn s(key: &str) -> &'static str {
    contract().get(key).and_then(|v| v.as_str()).unwrap_or("")
}

pub fn coding_prompt() -> &'static str {
    s("coding_prompt")
}
pub fn coding_description() -> &'static str {
    s("coding_description")
}
pub fn coding_tools() -> Vec<String> {
    contract()["coding_tools"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}
/// Rules the runtime appends for every agent (v3 only; see REPORT.md §3).
pub fn runtime_protocol() -> &'static str {
    s("runtime_protocol")
}
/// How to use `<openagentd_memory>`: the lead saves, delegated agents only read.
pub fn memory_protocol(lead: bool) -> &'static str {
    s(if lead { "memory_protocol_lead" } else { "memory_protocol_member" })
}
/// `BUILTIN_MEMBER_PROFILES` (insertion order: explorer, researcher).
pub fn member_profiles() -> &'static serde_json::Map<String, Value> {
    contract()["members"].as_object().expect("members")
}

/// Whether `body` is a member prompt an earlier release wrote into the
/// user's agent file. Such a file follows the built-in prompt, so prompt
/// updates reach installs whose member files were never edited. (New
/// installs get an empty body, which means the same thing.)
pub fn is_shipped_member_prompt(name: &str, body: &str) -> bool {
    use sha2::{Digest, Sha256};
    let normalized = body.replace("\r\n", "\n");
    let digest: String = Sha256::digest(normalized.trim().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    contract()["member_prompt_history_sha256"][name].as_array().is_some_and(|known| known.iter().any(|h| h.as_str() == Some(digest.as_str())))
}
