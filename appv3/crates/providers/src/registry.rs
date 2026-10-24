//! Model registry — port of `model_registry.py`, `model_metadata.py`,
//! `capabilities.py`.
//!
//! Precedence: cached models.dev → provider aliases → user
//! `{config}/model_registry.yaml` overlay (final authority).

use crate::catalog;
use chrono::{DateTime, Datelike, Timelike, Utc, Weekday};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";
pub const MODELS_DEV_CACHE_TTL_SECONDS: u64 = 24 * 60 * 60;

pub type Registry = Map<String, Value>;

static REGISTRY: RwLock<Option<Arc<Registry>>> = RwLock::new(None);

fn deep_merge(base: &Value, over: &Value) -> Value {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            let mut r = b.clone();
            for (k, v) in o {
                let merged = match r.get(k) {
                    Some(cur) if cur.is_object() && v.is_object() => deep_merge(cur, v),
                    _ => v.clone(),
                };
                r.insert(k.clone(), merged);
            }
            Value::Object(r)
        }
        _ => over.clone(),
    }
}

fn merge_into(reg: &mut Registry, key: &str, value: &Value) {
    let cur = reg.get(key).cloned().unwrap_or_else(|| json!({}));
    reg.insert(key.to_string(), deep_merge(&cur, value));
}

fn provider_id_aliases() -> HashMap<String, String> {
    let mut m = HashMap::new();
    for e in catalog::all_providers() {
        if let (Some(id), Some(src)) = (e["id"].as_str(), e.get("models_dev_provider_id").and_then(|v| v.as_str())) {
            if !src.is_empty() {
                m.insert(src.to_lowercase(), id.to_lowercase());
            }
        }
    }
    m
}

fn apply_aliases(reg: &Registry, overwrite: bool) -> Registry {
    let mut provider_aliases: Vec<(String, String)> = vec![];
    let mut model_aliases: Vec<(String, String)> = vec![];
    for e in catalog::all_providers() {
        let Some(pid) = e["id"].as_str() else { continue };
        let target = pid.to_lowercase();
        if let Some(src) = e.get("metadata_source_provider").and_then(|v| v.as_str()) {
            if !src.is_empty() {
                provider_aliases.push((target.clone(), src.to_lowercase()));
            }
        }
        if let Some(Value::Object(al)) = e.get("model_registry_aliases") {
            for (tm, sk) in al {
                if let Some(sk) = sk.as_str() {
                    let tk = if tm.contains(':') { tm.clone() } else { format!("{target}:{tm}") };
                    model_aliases.push((tk.to_lowercase(), sk.to_lowercase()));
                }
            }
        }
    }
    let mut result = reg.clone();
    for (key, value) in reg {
        let Some((pid, mid)) = key.split_once(':') else { continue };
        for (tp, sp) in &provider_aliases {
            if pid != sp {
                continue;
            }
            let tk = format!("{tp}:{mid}");
            if overwrite {
                merge_into(&mut result, &tk, value);
            } else if !result.contains_key(&tk) {
                result.insert(tk, value.clone());
            }
        }
    }
    for (tk, sk) in model_aliases {
        if let Some(src) = result.get(&sk).cloned() {
            if overwrite {
                merge_into(&mut result, &tk, &src);
            } else if !result.contains_key(&tk) {
                result.insert(tk, src);
            }
        }
    }
    result
}

fn pos_int(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| if v.is_boolean() { None } else { v.as_i64() }).filter(|n| *n > 0)
}

fn normalize_models_dev(data: &Value) -> Registry {
    let mut reg = Registry::new();
    let Some(obj) = data.as_object() else { return reg };
    let aliases = provider_id_aliases();
    for (pkey, provider) in obj {
        let Some(p) = provider.as_object() else { continue };
        let src_pid = p.get("id").and_then(|v| v.as_str()).unwrap_or(pkey).to_lowercase();
        let pid = aliases.get(&src_pid).cloned().unwrap_or_else(|| src_pid.clone());
        let Some(models) = p.get("models").and_then(|v| v.as_object()) else { continue };
        for (mkey, model) in models {
            let Some(m) = model.as_object() else { continue };
            let mid = m.get("id").and_then(|v| v.as_str()).unwrap_or(mkey);
            let mut entry = Map::new();
            // capabilities
            if let Some(Value::Object(mods)) = m.get("modalities") {
                let inp: Vec<&str> = mods.get("input").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
                let out: Vec<&str> = mods.get("output").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
                let mut caps = Map::new();
                let mut ic = Map::new();
                for (k, n) in [("vision", "image"), ("audio", "audio"), ("video", "video")] {
                    if inp.contains(&n) {
                        ic.insert(k.into(), Value::Bool(true));
                    }
                }
                if !ic.is_empty() {
                    caps.insert("input".into(), Value::Object(ic));
                }
                let (oi, oa, ov) = (out.contains(&"image"), out.contains(&"audio"), out.contains(&"video"));
                if oi || oa || ov {
                    caps.insert("output".into(), json!({"text": out.contains(&"text"), "image": oi, "audio": oa, "video": ov}));
                }
                if !caps.is_empty() {
                    entry.insert("capabilities".into(), Value::Object(caps));
                }
            }
            if let Some(Value::Object(limit)) = m.get("limit") {
                let mut l = Map::new();
                if let Some(c) = pos_int(limit.get("context")) {
                    l.insert("context_length".into(), c.into());
                }
                if let Some(c) = pos_int(limit.get("input")) {
                    l.insert("max_input_tokens".into(), c.into());
                }
                if let Some(c) = pos_int(limit.get("output")) {
                    l.insert("max_completion_tokens".into(), c.into());
                }
                if !l.is_empty() {
                    entry.insert("limits".into(), Value::Object(l));
                }
            }
            if let Some(Value::Object(cost)) = m.get("cost") {
                let mut c = Map::new();
                for k in ["input", "output", "cache_read", "cache_write"] {
                    if let Some(v) = cost.get(k).filter(|v| v.is_number()).and_then(|v| v.as_f64()) {
                        c.insert(k.into(), json!(v));
                    }
                }
                if !c.is_empty() {
                    entry.insert("cost".into(), Value::Object(c));
                }
            }
            let mut f = Map::new();
            for k in ["tool_call", "attachment", "temperature", "reasoning"] {
                if let Some(b) = m.get(k).and_then(|v| v.as_bool()) {
                    f.insert(k.into(), Value::Bool(b));
                }
            }
            for k in ["status", "release_date"] {
                if let Some(s) = m.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    f.insert(k.into(), Value::String(s.into()));
                }
            }
            if !f.is_empty() {
                entry.insert("features".into(), Value::Object(f));
            }
            if let Some(Value::Array(opts)) = m.get("reasoning_options") {
                let mut levels: Vec<String> = vec![];
                let (mut budget, mut toggle) = (false, false);
                for o in opts {
                    match o.get("type").and_then(|v| v.as_str()) {
                        Some("budget_tokens") => budget = true,
                        Some("toggle") => toggle = true,
                        Some("effort") => {
                            if let Some(vals) = o.get("values").and_then(|v| v.as_array()) {
                                for v in vals.iter().filter_map(|v| v.as_str()) {
                                    if !v.is_empty() && !levels.iter().any(|l| l == v) {
                                        levels.push(v.into());
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if toggle && !levels.iter().any(|l| l == "none") {
                    levels.insert(0, "none".into());
                }
                if !levels.is_empty() {
                    entry.insert("thinking".into(), json!({"levels": levels}));
                } else if budget {
                    entry.insert("thinking".into(), json!({"levels": ["none", "low", "medium", "high"]}));
                }
            }
            // transport
            if src_pid == "amazon-bedrock" {
                // `_mantle_transport(model["provider"])`.
                if let Some(mp) = m.get("provider").and_then(|v| v.as_object()) {
                    let variant = match mp.get("api").and_then(|v| v.as_str()) {
                        Some("https://bedrock-mantle.${AWS_REGION}.api.aws/v1") => Some("default"),
                        Some("https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1") => Some("openai"),
                        _ => None,
                    };
                    if let (Some(v), Some("responses")) = (variant, mp.get("shape").and_then(|s| s.as_str())) {
                        entry.insert("transport".into(), json!({"endpoint_variant": v, "api_family": "responses"}));
                    }
                }
            } else if src_pid == "opencode" || src_pid == "opencode-go" {
                let documented = match format!("{src_pid}:{mid}").as_str() {
                    "opencode:grok-build-0.1" => Some("responses"),
                    "opencode-go:grok-4.5" => Some("chat_completions"),
                    _ => None,
                };
                let family = documented.unwrap_or_else(|| {
                    let pkg = m
                        .get("provider")
                        .and_then(|mp| mp.get("npm"))
                        .and_then(|v| v.as_str())
                        .or_else(|| p.get("npm").and_then(|v| v.as_str()))
                        .unwrap_or("@ai-sdk/openai-compatible");
                    match pkg {
                        "@ai-sdk/anthropic" => "messages",
                        "@ai-sdk/google" => "generate_content",
                        "@ai-sdk/openai" => "responses",
                        _ => "chat_completions",
                    }
                });
                entry.insert("transport".into(), json!({"endpoint_variant": "default", "api_family": family}));
            }
            if !entry.is_empty() {
                reg.insert(format!("{pid}:{mid}").to_lowercase(), Value::Object(entry));
            }
        }
    }
    reg
}

fn cache_path() -> PathBuf {
    appv3_core::settings().cache_dir.join("models-dev.json")
}

fn overlay_path() -> PathBuf {
    appv3_core::settings().config_dir.join("model_registry.yaml")
}

fn read_models_dev() -> Option<Value> {
    let text = std::fs::read_to_string(cache_path()).ok()?;
    serde_json::from_str(&text).ok()
}

fn load_overlay() -> Registry {
    let Ok(text) = std::fs::read_to_string(overlay_path()) else { return Registry::new() };
    use appv3_core::pyyaml::Py;
    let parsed = match appv3_core::pyyaml::safe_load_py(&text) {
        Ok(p) if !p.truthy() => Py::Dict(vec![]),
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("failed to read model registry overlay ({e})");
            return Registry::new();
        }
    };
    // `_coerce_registry`: keep `str` keys with mapping values.
    let mut reg = Registry::new();
    match parsed {
        Py::Dict(items) => {
            for (k, v) in items {
                match (k, &v) {
                    (Py::Str(k), Py::Dict(_)) => {
                        reg.insert(k.to_lowercase(), v.to_json());
                    }
                    (k, _) => tracing::warn!("model_registry.yaml: skipping malformed entry key={}", k.json_key()),
                }
            }
        }
        _ => tracing::warn!("model_registry.yaml did not parse to a mapping; ignoring"),
    }
    reg
}

/// Build the merged registry from explicit sources (testable).
pub fn build_registry(models_dev: Option<&Value>, overlay: &Registry) -> Registry {
    build_registry_with(models_dev, &Registry::new(), overlay)
}

/// `load_model_registry` with the provider-owned runtime overlay (Codex
/// context limits) applied after aliasing and before the user overlay.
pub fn build_registry_with(models_dev: Option<&Value>, provider_overlay: &Registry, overlay: &Registry) -> Registry {
    let md = models_dev.map(normalize_models_dev).unwrap_or_default();
    let mut reg = Registry::new();
    for (k, v) in &md {
        merge_into(&mut reg, k, v);
    }
    reg = apply_aliases(&reg, true);
    for (k, v) in overlay {
        merge_into(&mut reg, k, v);
    }
    reg = apply_aliases(&reg, true);
    for (k, v) in overlay {
        merge_into(&mut reg, k, v);
    }
    for (k, v) in provider_overlay {
        merge_into(&mut reg, k, v);
    }
    for (k, v) in overlay {
        merge_into(&mut reg, k, v);
    }
    reg
}

pub fn load_model_registry() -> Arc<Registry> {
    if let Some(r) = REGISTRY.read().unwrap().as_ref() {
        return r.clone();
    }
    let mut provider_overlay: Registry = crate::codex::model_registry_overlay(crate::codex::cached_catalog().as_ref()).into_iter().collect();
    provider_overlay.extend(crate::grok::model_registry_overlay(crate::grok::cached_catalog().as_ref()));
    let reg = Arc::new(build_registry_with(read_models_dev().as_ref(), &provider_overlay, &load_overlay()));
    *REGISTRY.write().unwrap() = Some(reg.clone());
    reg
}

pub fn clear_model_registry_caches() {
    *REGISTRY.write().unwrap() = None;
}

/// Install an explicit registry (tests).
pub fn install_registry(reg: Registry) {
    *REGISTRY.write().unwrap() = Some(Arc::new(reg));
}

/// v2 `_load_models_dev_data` + `refresh_model_registry`.
pub async fn refresh_model_registry(force: bool) {
    let s = appv3_core::settings();
    if !s.model_registry_refresh {
        return;
    }
    let path = cache_path();
    let mut fresh = false;
    if !force {
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(age) = meta.modified().map(|m| m.elapsed().unwrap_or_default()) {
                fresh = age.as_secs() < MODELS_DEV_CACHE_TTL_SECONDS;
            }
        }
    }
    if fresh {
        let _ = crate::codex::load_catalog(force).await;
        let _ = crate::grok::load_catalog(force).await;
        clear_model_registry_caches();
        return;
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build();
    let fetched = match client {
        Ok(c) => match c.get(MODELS_DEV_URL).send().await.and_then(|r| r.error_for_status()) {
            Ok(r) => r.json::<Value>().await.ok(),
            Err(e) => {
                tracing::warn!("failed to fetch models.dev registry ({e})");
                None
            }
        },
        Err(_) => None,
    };
    if let Some(v) = fetched {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, serde_json::to_string(&v).unwrap_or_default());
    }
    // `refresh_runtime_model_metadata(force)`.
    let _ = crate::codex::load_catalog(force).await;
    let _ = crate::grok::load_catalog(force).await;
    clear_model_registry_caches();
}

// ── metadata resolution ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelLimits {
    pub context_length: Option<i64>,
    pub max_input_tokens: Option<i64>,
    pub max_completion_tokens: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelCost {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

impl ModelCost {
    fn priced(&self) -> bool {
        self.input.is_some() || self.output.is_some()
    }
}

const BARE_PREF: &[&str] = &["openai", "anthropic", "google", "googlegenai", "deepseek", "xai", "zai", "codex", "meta", "mistral", "groq"];

fn cost_of(v: &Value) -> ModelCost {
    let c = v.get("cost");
    let f = |k: &str| c.and_then(|c| c.get(k)).filter(|v| v.is_number()).and_then(|v| v.as_f64());
    ModelCost { input: f("input"), output: f("output"), cache_read: f("cache_read"), cache_write: f("cache_write") }
}

/// v2 `get_model_metadata` — returns the raw registry entry.
pub fn get_model_entry(model_id: Option<&str>) -> Option<Value> {
    let id = model_id.filter(|s| !s.is_empty())?.to_lowercase();
    let reg = load_model_registry();
    if let Some(v) = reg.get(&id) {
        return Some(v.clone());
    }
    if id.contains(':') {
        return None;
    }
    for p in BARE_PREF {
        if let Some(v) = reg.get(&format!("{p}:{id}")) {
            if cost_of(v).priced() {
                return Some(v.clone());
            }
        }
    }
    let suffix = format!(":{id}");
    for (k, v) in reg.iter() {
        if k.ends_with(&suffix) && cost_of(v).priced() {
            return Some(v.clone());
        }
    }
    reg.iter().find(|(k, _)| k.ends_with(&suffix)).map(|(_, v)| v.clone())
}

pub fn get_model_limits(model_id: Option<&str>) -> ModelLimits {
    let Some(v) = get_model_entry(model_id) else { return ModelLimits::default() };
    let l = v.get("limits");
    let g = |k: &str| pos_int(l.and_then(|l| l.get(k)));
    ModelLimits { context_length: g("context_length"), max_input_tokens: g("max_input_tokens"), max_completion_tokens: g("max_completion_tokens") }
}

pub fn get_model_cost(model_id: Option<&str>) -> ModelCost {
    deepseek_peak_cost(model_id).unwrap_or_else(|| get_model_entry(model_id).map(|v| cost_of(&v)).unwrap_or_default())
}

/// The price in effect at `at`: [`get_model_cost`], except that DeepSeek's
/// own models cost half outside its peak hours.
pub fn get_model_cost_at(model_id: Option<&str>, at: DateTime<Utc>) -> ModelCost {
    match deepseek_peak_cost(model_id) {
        Some(peak) if deepseek_off_peak(at) => ModelCost {
            input: peak.input.map(|p| p / 2.0),
            output: peak.output.map(|p| p / 2.0),
            cache_read: peak.cache_read.map(|p| p / 2.0),
            cache_write: peak.cache_write.map(|p| p / 2.0),
        },
        Some(peak) => peak,
        None => get_model_cost(model_id),
    }
}

/// DeepSeek's peak prices (USD per 1M tokens), from
/// <https://api-docs.deepseek.com/quick_start/pricing>. models.dev lists the
/// off-peak price as the base, so its DeepSeek entries are not used. The
/// retired `deepseek-v4-flash` names are served and billed as Flash.
fn deepseek_peak_cost(model_id: Option<&str>) -> Option<ModelCost> {
    let (p, m) = model_id?.split_once(':')?;
    if !p.eq_ignore_ascii_case("deepseek") {
        return None;
    }
    let (input, output, cache_read) = match m.to_lowercase().as_str() {
        "deepseek-flash" | "deepseek-v4-flash" | "deepseek-v4-flash-vision-exp" => (0.30, 1.20, 0.006),
        "deepseek-v4-pro" => (1.32, 3.96, 0.044),
        _ => return None,
    };
    Some(ModelCost { input: Some(input), output: Some(output), cache_read: Some(cache_read), cache_write: None })
}

/// DeepSeek's peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday to
/// Friday; everything else costs half. Chinese public holidays are also
/// off-peak, but are not tracked here, so those days are priced as peak.
fn deepseek_off_peak(at: DateTime<Utc>) -> bool {
    let weekend = matches!(at.weekday(), Weekday::Sat | Weekday::Sun);
    weekend || !matches!(at.hour(), 1..=3 | 6..=9)
}

pub fn get_model_thinking_levels(model_id: Option<&str>) -> Vec<String> {
    get_model_entry(model_id)
        .and_then(|v| v.get("thinking").and_then(|t| t.get("levels")).and_then(|l| l.as_array()).cloned())
        .map(|a| a.into_iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Returns `api_family` when the catalog defines a transport.
pub fn get_model_transport(model_id: Option<&str>) -> Option<String> {
    get_model_entry(model_id)?.get("transport")?.get("api_family")?.as_str().map(String::from)
}

/// `(endpoint_variant, api_family)` when the catalog defines a valid transport.
pub fn get_model_transport_full(model_id: Option<&str>) -> Option<(String, String)> {
    let t = get_model_entry(model_id)?.get("transport")?.clone();
    let v = t.get("endpoint_variant")?.as_str()?.to_string();
    let f = t.get("api_family")?.as_str()?.to_string();
    (matches!(v.as_str(), "default" | "openai") && matches!(f.as_str(), "chat_completions" | "generate_content" | "messages" | "responses")).then_some((v, f))
}

/// v2 `ModelMetadata.to_dict()`.
pub fn metadata_dict(model_id: Option<&str>) -> Value {
    let e = get_model_entry(model_id).unwrap_or_else(|| json!({}));
    let l = get_model_limits(model_id);
    let c = cost_of(&e);
    let f = e.get("features").cloned().unwrap_or_else(|| json!({}));
    json!({
        "limits": {"context_length": l.context_length, "max_input_tokens": l.max_input_tokens, "max_completion_tokens": l.max_completion_tokens},
        "thinking": {"levels": get_model_thinking_levels(model_id)},
        "cost": {"input": c.input, "output": c.output, "cache_read": c.cache_read, "cache_write": c.cache_write},
        "features": {
            "tool_call": f.get("tool_call").cloned().unwrap_or(Value::Null),
            "attachment": f.get("attachment").cloned().unwrap_or(Value::Null),
            "temperature": f.get("temperature").cloned().unwrap_or(Value::Null),
            "reasoning": f.get("reasoning").cloned().unwrap_or(Value::Null),
            "status": f.get("status").cloned().unwrap_or(Value::Null),
            "release_date": f.get("release_date").cloned().unwrap_or(Value::Null),
        },
    })
}

/// v2 `get_capabilities(model_id).to_dict()` — exact match only.
pub fn capabilities_dict(model_id: Option<&str>) -> Value {
    let reg = load_model_registry();
    let caps = model_id.and_then(|m| reg.get(&m.to_lowercase())).and_then(|v| v.get("capabilities")).cloned().unwrap_or(json!({}));
    let i = caps.get("input").cloned().unwrap_or(json!({}));
    let o = caps.get("output").cloned().unwrap_or(json!({}));
    let b = |v: &Value, k: &str, d: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
    json!({
        "input": {"vision": b(&i, "vision", false), "document_text": b(&i, "document_text", true), "audio": b(&i, "audio", false), "video": b(&i, "video", false)},
        "output": {"text": b(&o, "text", true), "image": b(&o, "image", false), "audio": b(&o, "audio", false), "video": b(&o, "video", false)},
    })
}

pub fn supports_vision(model_id: Option<&str>) -> bool {
    capabilities_dict(model_id)["input"]["vision"].as_bool().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_models_dev_with_aliases() {
        let md = json!({
            "google": {"id": "google", "models": {"gemini-x": {"id": "gemini-x", "limit": {"context": 1000, "output": 100},
              "cost": {"input": 1.0, "output": 2}, "modalities": {"input": ["text", "image"], "output": ["text"]},
              "reasoning_options": [{"type": "budget_tokens"}]}}},
            "openai": {"models": {"gpt-z": {"cost": {"input": 3}}}}
        });
        let reg = build_registry(Some(&md), &Registry::new());
        let g = &reg["googlegenai:gemini-x"];
        assert_eq!(g["limits"]["context_length"], 1000);
        assert_eq!(g["capabilities"]["input"]["vision"], true);
        assert_eq!(g["thinking"]["levels"], json!(["none", "low", "medium", "high"]));
        // codex inherits openai metadata via metadata_source_provider
        assert!(reg.contains_key("codex:gpt-z"));
    }

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        use chrono::TimeZone;
        Utc.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    fn cost(input: f64, output: f64, cache_read: f64) -> ModelCost {
        ModelCost { input: Some(input), output: Some(output), cache_read: Some(cache_read), cache_write: None }
    }

    #[test]
    fn deepseek_peak_hours_are_weekday_mornings_utc() {
        // Monday 2026-10-26.
        for (h, min) in [(1, 0), (2, 0), (3, 59), (6, 0), (9, 59)] {
            assert!(!deepseek_off_peak(utc(2026, 10, 26, h, min)), "{h}:{min:02} is peak");
        }
        for (h, min) in [(0, 59), (4, 0), (5, 0), (10, 0), (12, 0), (23, 0)] {
            assert!(deepseek_off_peak(utc(2026, 10, 26, h, min)), "{h}:{min:02} is off-peak");
        }
        // Friday morning is peak; all of Saturday is off-peak.
        assert!(!deepseek_off_peak(utc(2026, 10, 23, 2, 0)));
        assert!(deepseek_off_peak(utc(2026, 10, 24, 2, 0)));
    }

    #[test]
    fn deepseek_uses_the_official_peak_prices_and_halves_them_off_peak() {
        let peak = utc(2026, 10, 26, 2, 0);
        let off = utc(2026, 10, 24, 2, 0);
        for m in ["deepseek:deepseek-flash", "deepseek:deepseek-v4-flash", "DeepSeek:deepseek-v4-flash-vision-exp"] {
            assert_eq!(get_model_cost_at(Some(m), peak), cost(0.30, 1.20, 0.006), "{m}");
            assert_eq!(get_model_cost_at(Some(m), off), cost(0.15, 0.60, 0.003), "{m}");
            assert_eq!(get_model_cost(Some(m)), cost(0.30, 1.20, 0.006), "{m} lists the peak price");
        }
        assert_eq!(get_model_cost_at(Some("deepseek:deepseek-v4-pro"), peak), cost(1.32, 3.96, 0.044));
        assert_eq!(get_model_cost_at(Some("deepseek:deepseek-v4-pro"), off), cost(0.66, 1.98, 0.022));
    }

    #[test]
    fn only_the_deepseek_table_gets_the_off_peak_discount() {
        let off = utc(2026, 10, 24, 2, 0);
        // Registry prices (a future DeepSeek model, another provider) are used as listed.
        for m in ["deepseek:deepseek-v9", "openrouter:deepseek/deepseek-v4-flash", "openai:gpt-5"] {
            assert_eq!(get_model_cost_at(Some(m), off), get_model_cost(Some(m)), "{m}");
        }
    }
}
