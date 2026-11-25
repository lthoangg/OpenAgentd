//! Built-in prompt strings (`data/builtin_prompts.json`).

use serde_json::Value;
use std::sync::OnceLock;

const JSON: &str = include_str!("../data/builtin_prompts.json");

pub fn contract() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(JSON).expect("builtin_prompts.json"))
}

/// The built-in text under `key`. A key the file lacks is a bug in the
/// caller: it stops a debug build (so any test that reaches it fails), and
/// `every_prompt_key_in_the_source_exists` finds it without running the path.
pub fn s(key: &str) -> &'static str {
    let text = contract().get(key).and_then(|v| v.as_str());
    debug_assert!(text.is_some(), "appv3/crates/agent/data/builtin_prompts.json has no text under {key:?}: add it, or fix the key");
    text.unwrap_or("")
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
/// What the app renders and makes clickable in a reply, for lead agents.
/// The only place this is stated: tool descriptions and other prompts must
/// not repeat any of it.
pub fn app_guide() -> &'static str {
    s("app_guide")
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

#[cfg(test)]
mod key_tests {
    use super::*;

    fn sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// `s` returns "" for a key the file lacks in a release build, so a
    /// misspelt key would send the model an empty instruction. Every key
    /// written in the source is checked here, reached by a test or not.
    #[test]
    fn every_prompt_key_in_the_source_exists() {
        let call = regex::Regex::new(r#"\bs\(((?:[^()]|\([^()]*\))*)\)"#).unwrap();
        let literal = regex::Regex::new(r#""([a-z][a-z0-9_]*)""#).unwrap();
        let mut files = vec![];
        sources(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        let mut checked = 0;
        // This file defines `s` and only describes calls to it.
        for file in files.into_iter().filter(|f| !f.ends_with("prompts.rs")) {
            let text = std::fs::read_to_string(&file).unwrap();
            // `prompts::s("key")` and `prompts::s(if x { "a" } else { "b" })`.
            for found in call.captures_iter(&text) {
                let whole = found.get(0).unwrap();
                if !text[..whole.start()].ends_with("prompts::") {
                    continue;
                }
                for key in literal.captures_iter(&found[1]) {
                    // A literal compared with `==` is a condition, not a key.
                    if found[1][..key.get(0).unwrap().start()].trim_end().ends_with("==") {
                        continue;
                    }
                    checked += 1;
                    assert!(
                        contract().get(&key[1]).is_some_and(|v| v.is_string()),
                        "{}: builtin_prompts.json has no text under {:?}: add it to appv3/crates/agent/data/builtin_prompts.json, or fix the key",
                        file.display(),
                        &key[1]
                    );
                }
            }
        }
        assert!(checked >= 25, "the scan found only {checked} keys: it no longer matches how prompts::s is called");
    }

    /// The lead's own reading costs many times an explorer's per model call,
    /// so the Delegating rule names when to hand reading off and when not.
    #[test]
    fn the_lead_hands_reading_it_will_not_edit_to_an_explorer() {
        let prompt = coding_prompt();
        assert!(prompt.contains("more than about five files you will not edit"), "{prompt}");
        assert!(prompt.contains("send an explorer one precise question and the answer format"), "{prompt}");
        assert!(prompt.contains("Read files yourself when you will edit them or need their exact text"), "{prompt}");
    }

    /// Whole-file reads fill an explorer's context call after call.
    #[test]
    fn an_explorer_reads_the_lines_it_needs() {
        let explorer = member_profiles()["explorer"]["prompt"].as_str().unwrap();
        assert!(explorer.contains("`grep` with `context`, or `read` with `offset` and `limit` around a match"), "{explorer}");
        assert!(explorer.contains("Read a whole file only when the question is about all of it."), "{explorer}");
    }
}
