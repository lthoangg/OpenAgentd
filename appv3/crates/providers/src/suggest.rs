//! The model a newly connected provider sets on agents that have none yet.
//!
//! Each catalog entry may list `suggested_models`: patterns tried in order,
//! where `*` stands for a version (digits, dots and dashes), so
//! `claude-sonnet-*` follows new releases without a code change. Among the
//! provider's live models that match the first pattern with any match, the
//! newest wins. With no pattern matching, the newest tool-calling model is
//! used, then the first listed one.

use std::cmp::Ordering;

/// What the model registry knows about one model.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelFacts {
    /// `YYYY-MM-DD`, when known.
    pub release_date: Option<String>,
    /// `Some(false)` when the model cannot call tools.
    pub tool_call: Option<bool>,
    /// `Some("deprecated")` and similar.
    pub status: Option<String>,
}

/// The catalog's `suggested_models` patterns for `provider_id`.
pub fn suggested_patterns(provider_id: &str) -> Vec<String> {
    crate::catalog::find(provider_id)
        .and_then(|e| e.get("suggested_models"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Registry facts for `provider_id:model`.
pub fn registry_facts(provider_id: &str, model: &str) -> ModelFacts {
    let id = format!("{provider_id}:{model}");
    let Some(entry) = crate::registry::get_model_entry(Some(&id)) else { return ModelFacts::default() };
    let f = entry.get("features");
    let s = |k: &str| f.and_then(|f| f.get(k)).and_then(|v| v.as_str()).map(String::from);
    ModelFacts { release_date: s("release_date"), tool_call: f.and_then(|f| f.get("tool_call")).and_then(|v| v.as_bool()), status: s("status") }
}

/// `provider_id:model` to set for a provider whose live models are `live`,
/// using the catalog patterns and registry facts. `None` when `live` is empty.
pub fn suggested_model(provider_id: &str, live: &[String]) -> Option<String> {
    let patterns = suggested_patterns(provider_id);
    pick_model(&patterns, live, |m| registry_facts(provider_id, m)).map(|m| format!("{provider_id}:{m}"))
}

/// The choice behind [`suggested_model`], with registry facts injected.
pub fn pick_model(patterns: &[String], live: &[String], facts: impl Fn(&str) -> ModelFacts) -> Option<String> {
    let usable: Vec<(&String, ModelFacts)> = live.iter().map(|m| (m, facts(m))).filter(|(_, f)| f.tool_call != Some(false) && f.status.as_deref() != Some("deprecated")).collect();
    let newest = |candidates: Vec<&(&String, ModelFacts)>| candidates.into_iter().max_by(|a, b| newer(a, b)).map(|(m, _)| (*m).clone());
    for pattern in patterns {
        let matching: Vec<_> = usable.iter().filter(|(m, _)| glob_version(pattern, m)).collect();
        if !matching.is_empty() {
            return newest(matching);
        }
    }
    let dated: Vec<_> = usable.iter().filter(|(_, f)| f.release_date.is_some() && f.tool_call == Some(true)).collect();
    if !dated.is_empty() {
        return newest(dated);
    }
    usable.first().map(|(m, _)| (*m).clone()).or_else(|| live.first().cloned())
}

fn newer(a: &(&String, ModelFacts), b: &(&String, ModelFacts)) -> Ordering {
    a.1.release_date.cmp(&b.1.release_date).then_with(|| natural_cmp(a.0, b.0)).then_with(|| b.0.len().cmp(&a.0.len()))
}

/// Orders `gpt-5.10` after `gpt-5.9`: digit runs compare as numbers.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.as_bytes(), b.as_bytes());
    loop {
        match (a.first(), b.first()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let na = a.iter().take_while(|c| c.is_ascii_digit()).count();
                let nb = b.iter().take_while(|c| c.is_ascii_digit()).count();
                let (da, db) = (trim_zeros(&a[..na]), trim_zeros(&b[..nb]));
                let ord = da.len().cmp(&db.len()).then_with(|| da.cmp(db));
                if ord != Ordering::Equal {
                    return ord;
                }
                a = &a[na..];
                b = &b[nb..];
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(y);
                }
                a = &a[1..];
                b = &b[1..];
            }
        }
    }
}

fn trim_zeros(d: &[u8]) -> &[u8] {
    let n = d.iter().take_while(|c| **c == b'0').count().min(d.len().saturating_sub(1));
    &d[n..]
}

/// `*` matches one or more version characters: digits, `.` and `-`.
fn glob_version(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some(b'*') => {
                let run = t.iter().take_while(|c| c.is_ascii_digit() || **c == b'.' || **c == b'-').count();
                (1..=run).any(|n| go(&p[1..], &t[n..]))
            }
            Some(c) => t.first().is_some_and(|x| x.eq_ignore_ascii_case(c)) && go(&p[1..], &t[1..]),
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn dated(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> ModelFacts {
        move |m| ModelFacts { release_date: pairs.iter().find(|(id, _)| *id == m).map(|(_, d)| d.to_string()), tool_call: Some(true), status: None }
    }

    #[test]
    fn a_version_pattern_follows_the_newest_release() {
        let live = ids(&["claude-haiku-5-5", "claude-sonnet-4-6", "claude-sonnet-5-5", "claude-opus-5-5"]);
        let facts = dated(&[("claude-sonnet-4-6", "2026-02-17"), ("claude-sonnet-5-5", "2026-09-28"), ("claude-opus-5-5", "2026-09-22"), ("claude-haiku-5-5", "2026-10-07")]);
        assert_eq!(pick_model(&ids(&["claude-sonnet-*"]), &live, facts).as_deref(), Some("claude-sonnet-5-5"));
    }

    #[test]
    fn the_wildcard_matches_versions_only() {
        assert!(glob_version("gemini-*-flash", "gemini-3.8-flash"));
        assert!(!glob_version("gemini-*-flash", "gemini-3.5-flash-lite"));
        assert!(glob_version("glm-*", "glm-5.3"));
        assert!(!glob_version("glm-*", "glm-5.3-flash"));
        assert!(glob_version("gpt-*-sol", "gpt-6.1-sol"));
        assert!(!glob_version("gpt-*-sol", "gpt-6.1-sol-pro"));
        assert!(glob_version("anthropic/claude-sonnet-*", "anthropic/claude-sonnet-5.5"));
    }

    #[test]
    fn without_dates_the_highest_version_wins() {
        let live = ids(&["gpt-5.9-sol", "gpt-5.10-sol", "gpt-5.2-sol"]);
        assert_eq!(pick_model(&ids(&["gpt-*-sol"]), &live, |_| ModelFacts::default()).as_deref(), Some("gpt-5.10-sol"));
    }

    #[test]
    fn later_patterns_apply_only_when_earlier_ones_match_nothing() {
        let live = ids(&["deepseek-v4-flash", "deepseek-v4-pro"]);
        let patterns = ids(&["deepseek-v*-pro", "deepseek-v*-flash"]);
        assert_eq!(pick_model(&patterns, &live, |_| ModelFacts::default()).as_deref(), Some("deepseek-v4-pro"));
        let live = ids(&["deepseek-v4-flash"]);
        assert_eq!(pick_model(&patterns, &live, |_| ModelFacts::default()).as_deref(), Some("deepseek-v4-flash"));
    }

    #[test]
    fn models_that_cannot_call_tools_or_are_deprecated_are_skipped() {
        let live = ids(&["grok-4.7", "grok-4.8"]);
        let facts = |m: &str| ModelFacts { release_date: None, tool_call: Some(m != "grok-4.8"), status: None };
        assert_eq!(pick_model(&ids(&["grok-*"]), &live, facts).as_deref(), Some("grok-4.7"));
        let facts = |m: &str| ModelFacts { release_date: None, tool_call: None, status: (m == "grok-4.8").then(|| "deprecated".to_string()) };
        assert_eq!(pick_model(&ids(&["grok-*"]), &live, facts).as_deref(), Some("grok-4.7"));
    }

    #[test]
    fn with_no_pattern_match_the_newest_tool_model_then_the_first_listed_wins() {
        let live = ids(&["old-model", "new-model"]);
        let facts = dated(&[("old-model", "2025-01-01"), ("new-model", "2026-01-01")]);
        assert_eq!(pick_model(&[], &live, facts).as_deref(), Some("new-model"));
        let live = ids(&["qwen3-coder:30b", "llama3.3:70b"]);
        assert_eq!(pick_model(&[], &live, |_| ModelFacts::default()).as_deref(), Some("qwen3-coder:30b"));
    }

    #[test]
    fn nothing_is_picked_from_an_empty_list() {
        assert_eq!(pick_model(&ids(&["claude-sonnet-*"]), &[], |_| ModelFacts::default()), None);
    }
}
