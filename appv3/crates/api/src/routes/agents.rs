//! `/api/agents` — port of `app/api/routes/agents.py` + `app/services/agent_fs.py`
//! (agent half).

use crate::error::{ApiError, ApiResult};
use crate::providers::{self as prov, s};
use crate::routes::library::{discover_runtime_skills, py_strip, write_body};
use crate::util::*;
use crate::AppState;
use appv3_agent::hooks::summarization::resolve_prompt_token_threshold;
use appv3_agent::loader::{self, AgentConfig};
use appv3_agent::prompts;
use appv3_core::runtime_settings as rs;
use appv3_core::settings;
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_agents).post(create_agent))
        // Static segments shadow `/{name}` in axum; FastAPI falls through to
        // `/{name}` for the other methods, so forward them explicitly.
        .route("/registry", get(get_registry).put(|b: Bytes| update_by_name("registry".into(), b)).delete(|| delete_by_name("registry".into())))
        .route("/members", get(list_members).post(create_member).put(|b: Bytes| update_by_name("members".into(), b)).delete(|| delete_by_name("members".into())))
        .route("/code", get(get_code).put(update_code).delete(|| delete_by_name("code".into())))
        .route("/members/{name}", get(get_member).put(update_member).delete(delete_member))
        .route("/{name}", get(get_by_name).put(|AxPath(n): AxPath<String>, b: Bytes| update_by_name(n, b)).delete(|AxPath(n): AxPath<String>| delete_by_name(n)))
}

// ── agent_fs ────────────────────────────────────────────────────────────────

enum FsError {
    Path(String),
    NotFound(String),
    Conflict(String),
}

impl FsError {
    fn msg(&self) -> String {
        match self {
            FsError::Path(m) | FsError::NotFound(m) | FsError::Conflict(m) => m.clone(),
        }
    }
    /// Standard mapping: path → 400, not found → 404, conflict → 409.
    fn api(self) -> ApiError {
        match self {
            FsError::Path(m) => ApiError::bad_request(m),
            FsError::NotFound(m) => ApiError::not_found(m),
            FsError::Conflict(m) => ApiError::conflict(m),
        }
    }
}

struct Record {
    name: String,
    path: String,
    content: String,
}

fn name_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$").unwrap())
}

fn validate_name(n: &str) -> Result<(), FsError> {
    // Python `re.match` with `$` also accepts one trailing "\n".
    let core = n.strip_suffix('\n').unwrap_or(n);
    if n.is_empty() || !name_re().is_match(core) {
        return Err(FsError::Path(format!("Invalid name '{n}'. Use letters, digits, '.', '_', '-' only (1-64 chars, must start with letter/digit).")));
    }
    Ok(())
}

/// `Path(name).parts`.
fn path_parts(name: &str) -> Vec<String> {
    let mut parts = vec![];
    if name.starts_with('/') {
        parts.push("/".to_string());
    }
    parts.extend(name.split('/').filter(|p| !p.is_empty() && *p != ".").map(String::from));
    parts
}

/// `PurePath.with_suffix(".md")` on the last component.
fn with_md_suffix(last: &str) -> String {
    match last.rfind('.') {
        Some(i) if i > 0 && i < last.len() - 1 => format!("{}.md", &last[..i]),
        _ => format!("{last}.md"),
    }
}

pub fn agents_dir() -> PathBuf {
    resolve(&settings().agents_dir)
}

fn agent_file(name: &str) -> Result<PathBuf, FsError> {
    let parts = path_parts(name);
    if parts.is_empty() {
        return Err(FsError::Path("Agent name cannot be empty.".into()));
    }
    for p in &parts {
        validate_name(p)?;
    }
    let root = agents_dir();
    let mut rel = PathBuf::new();
    for p in &parts[..parts.len() - 1] {
        rel.push(p);
    }
    rel.push(with_md_suffix(parts.last().unwrap()));
    let file = resolve(&root.join(rel));
    if !file.starts_with(&root) {
        return Err(FsError::Path(format!("Path escapes agents directory: '{name}'.")));
    }
    Ok(file)
}

fn list_agent_names() -> Vec<String> {
    let root = agents_dir();
    if !root.exists() {
        return vec![];
    }
    fn walk(d: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "md").unwrap_or(false) && p.file_stem().is_some() {
                out.push(p.clone());
            }
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                walk(&p, out);
            }
        }
    }
    let mut files = vec![];
    walk(&root, &mut files);
    let mut names: Vec<String> = files
        .iter()
        .filter_map(|p| {
            let rel = p.strip_prefix(&root).ok()?;
            let mut s = rel.to_string_lossy().replace('\\', "/");
            s.truncate(s.len() - 3);
            (!s.is_empty()).then_some(s)
        })
        .collect();
    names.sort();
    names
}

fn read_agent(name: &str) -> Result<Record, FsError> {
    let file = agent_file(name)?;
    if !file.is_file() {
        return Err(FsError::NotFound(format!("Agent '{name}' not found.")));
    }
    let content = std::fs::read_to_string(&file).map_err(|e| FsError::NotFound(e.to_string()))?;
    Ok(Record { name: name.into(), path: pstr(&file), content })
}

fn write_agent(name: &str, content: &str, create: bool) -> Result<Record, FsError> {
    let file = agent_file(name)?;
    if create && file.exists() {
        return Err(FsError::Conflict(format!("Agent '{name}' already exists.")));
    }
    appv3_core::secret_files::write_atomic(&file, content).map_err(|e| FsError::Path(e.to_string()))?;
    tracing::info!("agent_fs_write name={} bytes={}", name, content.chars().count());
    Ok(Record { name: name.into(), path: pstr(&file), content: content.into() })
}

fn delete_agent_file(name: &str) -> Result<(), FsError> {
    let file = agent_file(name)?;
    if !file.is_file() {
        return Err(FsError::NotFound(format!("Agent '{name}' not found.")));
    }
    std::fs::remove_file(&file).map_err(|e| FsError::Path(e.to_string()))?;
    tracing::info!("agent_fs_delete name={}", name);
    Ok(())
}

// ── parsing & effective config ──────────────────────────────────────────────

fn py_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// A frontmatter exception `_parse_content` lets escape its callers'
/// `except ValueError` (`KeyError` from `!!bool maybe`, …) → v2 answers 500.
fn escaping_yaml_error(content: &str) -> Option<String> {
    let (block, _, _) = loader::split_frontmatter(content)?;
    match appv3_core::pyyaml::safe_load_py(&block) {
        Err(e) if !e.is_yaml_error() && e.kind != "ValueError" => Some(format!("{}: {}", e.kind, e)),
        _ => None,
    }
}

fn check_escaping(content: &str) -> ApiResult<()> {
    match escaping_yaml_error(content) {
        Some(e) => Err(ApiError::internal(e)),
        None => Ok(()),
    }
}

/// `_parse_content`.
fn parse_content(content: &str, expected_name: Option<&str>) -> Result<AgentConfig, String> {
    let Some((block, body, _)) = loader::split_frontmatter(content) else {
        return Err("Missing YAML frontmatter. Expected '---\\n<yaml>\\n---\\n<system prompt>'.".into());
    };
    let mut raw = match appv3_core::pyyaml::safe_load(&block) {
        Ok(v) => v,
        Err(e) if e.is_yaml_error() => return Err(format!("Invalid YAML frontmatter: {e}")),
        Err(e) => return Err(e.to_string()),
    };
    if !py_truthy(&raw) {
        raw = Value::Object(Map::new());
    }
    let Value::Object(mut meta) = raw else { return Err("Frontmatter must be a YAML mapping.".into()) };
    match expected_name.filter(|n| !n.is_empty()) {
        Some(expected) => {
            let stem = path_parts(expected).last().cloned().unwrap_or_default();
            if let Some(actual) = meta.get("name").filter(|v| py_truthy(v)) {
                let ok = matches!(actual, Value::String(a) if a == expected || *a == stem);
                if !ok {
                    let shown = match actual {
                        Value::String(a) => a.clone(),
                        other => appv3_agent::pystr::py_str(other),
                    };
                    return Err(format!("Agent profile declared name '{shown}', expected '{expected}'"));
                }
            }
            if !meta.contains_key("name") {
                meta.insert("name".into(), json!(stem));
            }
        }
        None => {
            if !meta.contains_key("name") {
                meta.insert("name".into(), json!("code"));
            }
        }
    }
    let body = py_strip(&body);
    meta.insert("system_prompt".into(), json!(if body.is_empty() { "You are a helpful assistant.".to_string() } else { body }));
    loader::config_from_meta_errors(&meta).map_err(|errs| errs.into_iter().map(|(_, m)| m).collect::<Vec<_>>().join("; "))
}

fn dedup(v: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.into_iter().filter(|x| seen.insert(x.clone())).collect()
}

fn or_empty(v: &Option<String>, fallback: &str) -> Option<String> {
    match v {
        Some(s) if !s.is_empty() => Some(s.clone()),
        _ => Some(fallback.to_string()),
    }
}

/// `_effective_config(cfg, mode="coding")`.
fn effective_config(cfg: &AgentConfig) -> AgentConfig {
    let mut d = cfg.clone();
    if d.role == "lead" {
        let mut tools: Vec<String> = ["skill", "todo_manage", "schedule_task", "note"].map(String::from).to_vec();
        tools.append(&mut d.tools);
        d.tools = tools;
        if d.name == "code" {
            d.description = or_empty(&d.description, prompts::coding_description());
            if d.system_prompt.is_empty() {
                d.system_prompt = prompts::coding_prompt().to_string();
            }
            let mut t = prompts::coding_tools();
            t.append(&mut d.tools);
            d.tools = dedup(t);
            d.mcp = dedup(std::mem::take(&mut d.mcp));
        }
    } else if d.role == "member" {
        if let Some(bp) = prompts::member_profiles().get(&d.name) {
            let bs = |k: &str| bp.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            d.description = or_empty(&d.description, &bs("description"));
            if d.system_prompt.is_empty() || prompts::is_shipped_member_prompt(&d.name, &d.system_prompt) {
                d.system_prompt = bs("prompt");
            }
            if d.tools.is_empty() {
                d.tools = bp.get("tools").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            }
        }
    }
    d.tools = dedup(std::mem::take(&mut d.tools));
    d
}

fn detail(r: &Record, config: Option<Value>, error: Option<String>) -> Value {
    json!({"name": r.name, "path": r.path, "content": r.content, "config": config, "error": error})
}

/// Read + parse into an `AgentDetail` (parse errors land in `error`).
fn read_detail(r: &Record, expected: Option<&str>) -> Value {
    match parse_content(&r.content, expected) {
        Ok(cfg) => detail(r, Some(effective_config(&cfg).dump_exclude_none()), None),
        Err(e) => detail(r, None, Some(e)),
    }
}

/// `_validate_or_restore`.
fn validate_or_restore(rollback_name: Option<&str>, rollback_content: Option<&str>) -> ApiResult<()> {
    let dir = match rollback_name {
        None => agents_dir(),
        Some(n) => {
            let parts = path_parts(n);
            if parts.len() <= 1 {
                agents_dir()
            } else {
                let mut d = agents_dir();
                for p in &parts[..parts.len() - 1] {
                    d.push(p);
                }
                d
            }
        }
    };
    let check = || -> Result<(), String> {
        let resolved = resolve(&dir);
        let target = resolved.join("code.md");
        if !resolved.exists() || !target.is_file() {
            return Err(format!("No agents would remain in '{}'. At least one .md file is required.", pstr(&dir)));
        }
        loader::validate_canonical_code_profile(&target).map(|_| ())
    };
    if let Err(e) = check() {
        match (rollback_name, rollback_content) {
            (Some(n), Some(c)) => {
                if let Err(err) = write_agent(n, c, false) {
                    tracing::error!("agents_rollback_failed name={} error={}", n, err.msg());
                }
            }
            (Some(n), None) => {
                if let Err(err) = delete_agent_file(n) {
                    tracing::error!("agents_rollback_delete_failed name={} error={}", n, err.msg());
                }
            }
            _ => {}
        }
        return Err(ApiError::unprocessable(e));
    }
    Ok(())
}

// ── registry ────────────────────────────────────────────────────────────────

const HIDDEN_TOOLS: [&str; 4] = ["skill", "todo_manage", "schedule_task", "note"];

fn settings_err(e: impl std::fmt::Display) -> ApiError {
    ApiError::internal(e)
}

/// `_warm_provider_model_cache`.
async fn warm_provider_model_cache() -> ApiResult<()> {
    let rt = rs::load_runtime_settings().map_err(settings_err)?;
    let mut candidates: Vec<&'static Value> = vec![];
    for entry in prov::all_providers() {
        let id = s(entry, "id");
        let pui = prov::ui(&rt, id);
        if !prov::provider_is_configured(entry) {
            if !pui.cached_models.is_empty() {
                let _ = rs::forget_provider_models(id);
            }
            continue;
        }
        if !pui.is_disconnected && pui.cached_models.is_empty() {
            candidates.push(entry);
        }
    }
    if candidates.is_empty() {
        return Ok(());
    }
    let reach = futures::future::join_all(candidates.iter().map(|e| async move {
        if prov::DAEMON_PROVIDER_IDS.contains(&s(e, "id")) {
            prov::provider_is_reachable(e).await
        } else {
            true
        }
    }))
    .await;
    let configured: Vec<&Value> = candidates.into_iter().zip(reach).filter(|(_, ok)| *ok).map(|(e, _)| e).collect();
    let found = futures::future::join_all(configured.iter().map(|e| async move { prov::discover_provider_models(e, &prov::saved_overrides(e)).await })).await;
    for (entry, models) in configured.into_iter().zip(found) {
        let cleaned = prov::filter_agent_model_ids(models);
        if !cleaned.is_empty() {
            let _ = rs::set_provider_cached_models(s(entry, "id"), &cleaned);
        }
    }
    Ok(())
}

fn member_entries() -> Vec<Value> {
    let mut profiles = loader::load_member_profiles(&agents_dir());
    profiles.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    profiles.into_iter().map(|(_, p)| json!({"name": p.name, "description": p.description, "tools": p.tools, "model": p.model})).collect()
}

/// Built-in and MCP tools agents can enable, sorted, minus the ones the
/// runtime injects on its own.
fn tool_catalog() -> Vec<Value> {
    let mut catalog: Vec<(String, String)> = loader::default_tool_registry()
        .into_values()
        .map(|tool| {
            let desc = tool.definition()["function"]["description"].as_str().unwrap_or("").to_string();
            (tool.name().to_string(), desc)
        })
        .filter(|(n, _)| !HIDDEN_TOOLS.contains(&n.as_str()))
        .collect();
    catalog.sort_by(|a, b| a.0.cmp(&b.0));
    catalog.into_iter().map(|(n, d)| json!({"name": n, "description": d})).collect()
}

async fn get_registry() -> ApiResult<Response> {
    drop(crate::registry_refresh_gate().read().await);
    warm_provider_model_cache().await?;
    let rt = rs::load_runtime_settings().map_err(settings_err)?;
    let custom = rt.summarization.prompt_token_threshold;

    let tools = tool_catalog();

    let mut skills: Vec<(String, String)> = blocking(discover_runtime_skills).await.into_iter().map(|i| (i.name, i.description)).collect();
    skills.sort_by(|a, b| a.0.cmp(&b.0));
    let skills: Vec<Value> = skills.into_iter().map(|(n, d)| json!({"name": n, "description": d})).collect();

    let entries = prov::all_providers();
    let mut providers: Vec<String> = entries.iter().map(|e| s(e, "id").to_string()).collect();
    providers.sort();
    providers.dedup();
    let fast: HashSet<&str> = entries.iter().filter(|e| e.get("supports_fast_mode").and_then(|v| v.as_bool()).unwrap_or(false)).map(|e| s(e, "id")).collect();

    let mut seen = HashSet::new();
    let mut models: Vec<(String, String, Value)> = vec![];
    let mut append = |provider: &str, model: &str| {
        let id = format!("{provider}:{model}");
        if !seen.insert(id.clone()) {
            return;
        }
        let caps = appv3_providers::registry::capabilities_dict(Some(&id));
        let b = |a: &str, k: &str| caps[a][k].as_bool().unwrap_or(false);
        models.push((
            provider.to_string(),
            model.to_string(),
            json!({
                "id": id,
                "provider": provider,
                "model": model,
                "vision": b("input", "vision"),
                "output_image": b("output", "image"),
                "output_video": b("output", "video"),
                "thinking_levels": appv3_providers::registry::get_model_thinking_levels(Some(&id)),
                "summary_trigger_tokens": resolve_prompt_token_threshold(Some(&id), custom),
                "fast_mode": fast.contains(provider),
            }),
        ));
    };
    let registry = appv3_providers::registry::load_model_registry();
    for provider in &providers {
        let Some(entry) = prov::find(provider) else { continue };
        let pui = prov::ui(&rt, provider);
        if pui.is_disconnected {
            continue;
        }
        let configured = prov::provider_is_configured(entry);
        if !configured {
            if !pui.cached_models.is_empty() {
                let _ = rs::forget_provider_models(provider);
            }
            if !prov::OPENCODE_PROVIDER_IDS.contains(&provider.as_str()) {
                continue;
            }
        }
        let visible: HashSet<String> = pui.effective_visible_models().into_iter().collect();
        for model in &pui.cached_models {
            if !prov::model_is_accessible(provider, model, configured) {
                continue;
            }
            if prov::is_agent_model_id(&format!("{provider}:{model}")) && (visible.is_empty() || visible.contains(model)) {
                append(provider, model);
            }
        }
        for key in registry.keys() {
            let Some((p, m)) = key.split_once(':') else { continue };
            if p.to_lowercase() != provider.to_lowercase() || !prov::model_is_accessible(provider, m, configured) {
                continue;
            }
            let caps = appv3_providers::registry::capabilities_dict(Some(key));
            if caps["output"]["image"].as_bool().unwrap_or(false) || caps["output"]["video"].as_bool().unwrap_or(false) {
                append(provider, m);
            }
        }
    }
    models.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    let models: Vec<Value> = models.into_iter().map(|(_, _, v)| v).collect();
    let members = blocking(member_entries).await;
    Ok(json(json!({"tools": tools, "skills": skills, "providers": providers, "models": models, "member_profiles": members})))
}

async fn list_members() -> Response {
    json(Value::Array(blocking(member_entries).await))
}

// ── CRUD ────────────────────────────────────────────────────────────────────

async fn get_code() -> ApiResult<Response> {
    let r = read_agent("code").map_err(FsError::api)?;
    check_escaping(&r.content)?;
    Ok(json(read_detail(&r, None)))
}

async fn update_code(raw: Bytes) -> ApiResult<Response> {
    let (bname, content) = write_body(&raw)?;
    do_update_code(bname, content)
}

fn do_update_code(bname: String, content: String) -> ApiResult<Response> {
    let name = "code";
    if bname != name {
        return Err(ApiError::unprocessable(format!("URL name '{name}' does not match body name '{bname}'.")));
    }
    let previous = read_agent(name).map_err(FsError::api)?;
    check_escaping(&content)?;
    let cfg = parse_content(&content, None).map_err(ApiError::unprocessable)?;
    let record = write_agent(name, &content, false).map_err(FsError::api)?;
    validate_or_restore(Some(name), Some(&previous.content))?;
    Ok(json(detail(&record, Some(cfg.dump_exclude_none()), None)))
}

async fn get_member(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let r = read_agent(&name).map_err(FsError::api)?;
    check_escaping(&r.content)?;
    Ok(json(read_detail(&r, Some(&name))))
}

async fn update_member(AxPath(name): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let (bname, content) = write_body(&raw)?;
    do_update_member(&name, bname, content)
}

fn do_update_member(name: &str, bname: String, content: String) -> ApiResult<Response> {
    if bname != name {
        return Err(ApiError::unprocessable(format!("URL name '{name}' does not match body name '{bname}'.")));
    }
    let previous = read_agent(name).map_err(FsError::api)?;
    check_escaping(&content)?;
    let cfg = parse_content(&content, Some(name)).map_err(ApiError::unprocessable)?;
    let record = write_agent(name, &content, false).map_err(FsError::api)?;
    validate_or_restore(Some(name), Some(&previous.content))?;
    loader::clear_member_profiles_cache();
    Ok(json(detail(&record, Some(cfg.dump_exclude_none()), None)))
}

async fn create_member(raw: Bytes) -> ApiResult<Response> {
    let (bname, content) = write_body(&raw)?;
    do_create_member(bname, content)
}

fn do_create_member(bname: String, content: String) -> ApiResult<Response> {
    let name = py_strip(&bname);
    check_escaping(&content)?;
    let cfg = parse_content(&content, Some(&name)).map_err(ApiError::unprocessable)?;
    let record = write_agent(&name, &content, true).map_err(FsError::api)?;
    validate_or_restore(Some(&name), None)?;
    loader::clear_member_profiles_cache();
    Ok(json_code(201, detail(&record, Some(effective_config(&cfg).dump_exclude_none()), None)))
}

async fn delete_member(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    do_delete_member(&name)
}

fn do_delete_member(name: &str) -> ApiResult<Response> {
    if name == "code" {
        return Err(ApiError::bad_request("Cannot delete canonical coding agent 'code'."));
    }
    delete_agent_file(name).map_err(FsError::api)?;
    loader::clear_member_profiles_cache();
    Ok(no_content())
}

fn summary(name: &str) -> Value {
    let fallback_role = if name == "code" { "lead" } else { "member" };
    let res = read_agent(name).map_err(|e| e.msg()).and_then(|r| parse_content(&r.content, Some(name)));
    match res {
        Ok(cfg) => {
            let eff = effective_config(&cfg);
            let role = if cfg.role.is_empty() { fallback_role.to_string() } else { cfg.role.clone() };
            json!({"name": name, "role": role, "description": eff.description, "model": eff.model, "tools": eff.tools, "valid": true, "error": null})
        }
        Err(e) => json!({"name": name, "role": fallback_role, "description": null, "model": null, "tools": [], "valid": false, "error": e}),
    }
}

async fn list_agents() -> ApiResult<Response> {
    let agents = blocking(|| -> Result<Vec<Value>, String> {
        let root = agents_dir();
        if root.exists() {
            loader::ensure_builtin_code_agent(&root).map_err(|e| e.to_string())?;
            loader::ensure_builtin_member_agents(&root).map_err(|e| e.to_string())?;
        }
        let names = list_agent_names();
        let mut ordered: Vec<&String> = names.iter().filter(|n| *n == "code").take(1).collect();
        ordered.extend(names.iter().filter(|n| *n != "code"));
        Ok(ordered.into_iter().map(|n| summary(n)).collect())
    })
    .await
    .map_err(ApiError::internal)?;
    Ok(json(json!({"agents": agents})))
}

async fn create_agent(raw: Bytes) -> ApiResult<Response> {
    let (bname, content) = write_body(&raw)?;
    if py_strip(&bname) == "code" {
        return Err(ApiError::conflict("Canonical coding agent 'code' already exists."));
    }
    do_create_member(bname, content)
}

async fn get_by_name(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    if name == "code" {
        return get_code().await;
    }
    let r = read_agent(&name).map_err(|e| ApiError::not_found(e.msg()))?;
    check_escaping(&r.content)?;
    Ok(json(read_detail(&r, Some(&name))))
}

async fn update_by_name(name: String, raw: Bytes) -> ApiResult<Response> {
    let (bname, content) = write_body(&raw)?;
    if name == "code" {
        return do_update_code(bname, content);
    }
    do_update_member(&name, bname, content)
}

async fn delete_by_name(name: String) -> ApiResult<Response> {
    do_delete_member(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_catalog_lists_registry_tools_sorted_without_hidden_ones() {
        let tools = tool_catalog();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        for n in ["generate_image", "generate_video", "read", "shell"] {
            let t = tools.iter().find(|t| t["name"] == n).unwrap_or_else(|| panic!("{n} missing: {names:?}"));
            assert!(!t["description"].as_str().unwrap().is_empty(), "{n}");
        }
        assert!(names.iter().all(|n| !HIDDEN_TOOLS.contains(n)), "{names:?}");
    }

    #[test]
    fn parse_content_rules() {
        assert_eq!(parse_content("nope", None).unwrap_err(), "Missing YAML frontmatter. Expected '---\\n<yaml>\\n---\\n<system prompt>'.");
        let c = parse_content("---\nrole: member\n---\n", Some("x")).unwrap();
        assert_eq!(c.name, "x");
        assert_eq!(c.system_prompt, "You are a helpful assistant.");
        assert_eq!(parse_content("---\nname: y\n---\nhi", Some("x")).unwrap_err(), "Agent profile declared name 'y', expected 'x'");
        assert_eq!(parse_content("---\n- a\n---\n", None).unwrap_err(), "Frontmatter must be a YAML mapping.");
        let e = parse_content("---\nmodel: bad\ntools: 3\n---\n", None).unwrap_err();
        assert_eq!(e, "Input should be a valid list");
        let e = parse_content("---\nmodel: bad\n---\n", None).unwrap_err();
        assert!(e.starts_with("Value error, Agent 'code': invalid model 'bad'"), "{e}");
        let c = parse_content("---\n---\n", None);
        assert!(c.is_err() || c.unwrap().name == "code");
    }

    #[test]
    fn effective_lead_tools() {
        let c = parse_content("---\nname: other\ntools: [read, skill]\n---\nx", None).unwrap();
        let e = effective_config(&c);
        assert_eq!(e.tools, vec!["skill", "todo_manage", "schedule_task", "note", "read"]);
        let dump = e.dump_exclude_none();
        let keys: Vec<&String> = dump.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["name", "role", "system_prompt", "tools", "mcp"]);
    }

    #[test]
    fn names() {
        assert_eq!(with_md_suffix("my.agent"), "my.md");
        assert_eq!(with_md_suffix("code"), "code.md");
        assert!(validate_name("bad name").is_err());
        assert_eq!(path_parts("a//./b"), vec!["a", "b"]);
    }
}
