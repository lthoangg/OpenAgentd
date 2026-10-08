//! Agent configuration loader — port of `app/agent/loader.py` + `drift.py`.

use crate::agent::Agent;
use crate::prompts;
use appv3_core::settings::settings;
use appv3_providers::factory::{build_provider, UnconfiguredProvider, UNCONFIGURED_TOKEN};
use appv3_providers::{Kwargs, LlmProvider, ProviderError};
use appv3_tools::ToolRef;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

pub const DEFAULT_NEW_USER_MODEL: &str = UNCONFIGURED_TOKEN;

/// Provider factory (`ProviderFactory`): `(model, model_kwargs)`.
pub type ProviderFactory = Arc<dyn Fn(Option<&str>, Kwargs) -> Result<Arc<dyn LlmProvider>, ProviderError> + Send + Sync>;

pub fn default_provider_factory() -> ProviderFactory {
    Arc::new(build_provider)
}

// ── MCP bridge ───────────────────────────────────────────────────────────────

/// Globally configured MCP servers (v2 `mcp_manager`), installed by the MCP crate.
pub trait McpSource: Send + Sync {
    fn server_names(&self) -> Vec<String>;
    fn tools_for_server(&self, name: &str) -> Vec<ToolRef>;
}

fn mcp_slot() -> &'static RwLock<Option<Arc<dyn McpSource>>> {
    static S: OnceLock<RwLock<Option<Arc<dyn McpSource>>>> = OnceLock::new();
    S.get_or_init(|| RwLock::new(None))
}

pub fn set_mcp_source(src: Arc<dyn McpSource>) {
    *mcp_slot().write().unwrap() = Some(src);
}

pub fn mcp_source() -> Option<Arc<dyn McpSource>> {
    mcp_slot().read().unwrap().clone()
}

// ── AgentConfig ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct AgentConfig {
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub tools: Vec<String>,
    pub mcp: Vec<String>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub responses_api: Option<bool>,
}

fn fm_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    // v2 `_FRONTMATTER_RE` without its always-matching `(.*)` body group; the
    // body is the rest of the text (see `skills::split_frontmatter`).
    RE.get_or_init(|| regex::Regex::new(r"(?s)\A\s*---\r?\n(.*?)\r?\n---\r?\n?").unwrap())
}

/// Split `(frontmatter, body)` with v2 `_FRONTMATTER_RE`.
pub fn split_frontmatter(text: &str) -> Option<(String, String, std::ops::Range<usize>)> {
    let c = fm_regex().captures(text)?;
    let m1 = c.get(1).unwrap();
    Some((m1.as_str().to_string(), text[c.get(0).unwrap().end()..].to_string(), m1.range()))
}

type Errs = Vec<(String, String)>;

fn str_list(v: Option<&Value>, field: &str, errs: &mut Errs) -> Vec<String> {
    match v {
        None => vec![],
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .filter_map(|(i, x)| match x {
                Value::String(s) => Some(s.clone()),
                _ => {
                    errs.push((format!("{field}.{i}"), "Input should be a valid string".into()));
                    None
                }
            })
            .collect(),
        _ => {
            errs.push((field.into(), "Input should be a valid list".into()));
            vec![]
        }
    }
}

fn opt_string(v: Option<&Value>, field: &str, errs: &mut Errs) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            errs.push((field.into(), "Input should be a valid string".into()));
            None
        }
    }
}

/// `AgentConfig.model_validate(raw_meta)`.
pub fn config_from_meta(meta: &Map<String, Value>) -> Result<AgentConfig, String> {
    config_from_meta_errors(meta).map_err(|errs| {
        let body: Vec<String> = errs.iter().map(|(l, m)| if l.is_empty() { format!("  {m}") } else { format!("{l}\n  {m}") }).collect();
        format!("{} validation error{} for AgentConfig\n{}", errs.len(), if errs.len() == 1 { "" } else { "s" }, body.join("\n"))
    })
}

/// `AgentConfig.model_validate` returning pydantic `(loc, msg)` error pairs
/// (`_validation_detail` joins the msgs with `"; "`).
pub fn config_from_meta_errors(meta: &Map<String, Value>) -> Result<AgentConfig, Vec<(String, String)>> {
    let mut errs = Vec::new();
    let name = match meta.get("name") {
        Some(Value::String(s)) => s.clone(),
        Some(v) => {
            errs.push(("name".into(), "Input should be a valid string".into()));
            crate::pystr::py_str(v)
        }
        None => {
            errs.push(("name".into(), "Field required".into()));
            String::new()
        }
    };
    let role = match meta.get("role") {
        None => "lead".to_string(),
        Some(Value::String(s)) if s == "lead" || s == "member" => s.clone(),
        Some(_) => {
            errs.push(("role".into(), "Input should be 'lead' or 'member'".into()));
            "lead".into()
        }
    };
    let system_prompt = match meta.get("system_prompt") {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => {
            errs.push(("system_prompt".into(), "Input should be a valid string".into()));
            String::new()
        }
    };
    let cfg = AgentConfig {
        name,
        role,
        description: opt_string(meta.get("description"), "description", &mut errs),
        system_prompt,
        tools: str_list(meta.get("tools"), "tools", &mut errs),
        mcp: str_list(meta.get("mcp"), "mcp", &mut errs),
        model: opt_string(meta.get("model"), "model", &mut errs),
        thinking_level: opt_string(meta.get("thinking_level"), "thinking_level", &mut errs),
        responses_api: match meta.get("responses_api") {
            None | Some(Value::Null) => None,
            Some(v) => appv3_tools::args::coerce_bool(v).or_else(|| {
                errs.push(("responses_api".into(), "Input should be a valid boolean".into()));
                None
            }),
        },
    };
    if !errs.is_empty() {
        return Err(errs);
    }
    if let Some(m) = &cfg.model {
        if !m.is_empty() && m != UNCONFIGURED_TOKEN && !m.contains(':') {
            return Err(vec![(
                String::new(),
                format!("Value error, Agent '{}': invalid model '{}' (expected format: 'provider:model', e.g. 'googlegenai:gemini-3.1-flash')", cfg.name, m),
            )]);
        }
    }
    Ok(cfg)
}

impl AgentConfig {
    /// `model_dump(exclude_none=True)` (field order of the pydantic model).
    pub fn dump_exclude_none(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("role".into(), json!(self.role));
        if let Some(d) = &self.description {
            m.insert("description".into(), json!(d));
        }
        m.insert("system_prompt".into(), json!(self.system_prompt));
        m.insert("tools".into(), json!(self.tools));
        m.insert("mcp".into(), json!(self.mcp));
        if let Some(v) = &self.model {
            m.insert("model".into(), json!(v));
        }
        if let Some(v) = &self.thinking_level {
            m.insert("thinking_level".into(), json!(v));
        }
        if let Some(v) = self.responses_api {
            m.insert("responses_api".into(), json!(v));
        }
        Value::Object(m)
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

/// Parse raw frontmatter as a mapping (errors use v2 texts).
pub fn parse_meta(path: &Path, text: &str) -> Result<(Map<String, Value>, String), String> {
    let Some((block, body, _)) = split_frontmatter(text) else {
        return Err(format!("Agent file '{}' is missing frontmatter block (---\\n...\\n---)", file_name(path)));
    };
    match appv3_core::pyyaml::safe_load(&block).map_err(|e| e.to_string())? {
        Value::Object(m) => Ok((m, body)),
        _ => Err(format!("Agent file '{}' frontmatter must be a YAML mapping", file_name(path))),
    }
}

/// `parse_agent_md`.
pub fn parse_agent_md(path: &Path) -> Result<AgentConfig, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let (mut meta, body) = parse_meta(path, &text)?;
    let blank = match meta.get("name") {
        None => true,
        Some(v) => crate::pystr::py_str(v).trim().is_empty(),
    };
    if blank {
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        meta.insert("name".into(), json!(stem));
    }
    let mut cfg = config_from_meta(&meta)?;
    cfg.system_prompt = body.trim().to_string();
    Ok(cfg)
}

/// `validate_canonical_code_profile`.
pub fn validate_canonical_code_profile(path: &Path) -> Result<AgentConfig, String> {
    let cfg = parse_agent_md(path)?;
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let explicit = parse_meta(path, &text).ok().and_then(|(m, _)| m.get("name").cloned());
    if explicit != Some(json!("code")) || cfg.name != "code" {
        return Err("Canonical agent profile 'code.md' must declare name 'code'".into());
    }
    Ok(cfg)
}

fn atomic_write_text(path: &Path, content: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".tmp{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)
}

/// `ensure_builtin_code_agent` — restore `code.md` only when missing.
pub fn ensure_builtin_code_agent(agents_dir: &Path) -> std::io::Result<bool> {
    let target = agents_dir.join("code.md");
    if target.exists() {
        return Ok(false);
    }
    atomic_write_text(&target, prompts::s("code_md"))?;
    tracing::info!("builtin_code_agent_materialized mode=coding path={}", target.display());
    Ok(true)
}

/// `ensure_builtin_member_agents`.
pub fn ensure_builtin_member_agents(agents_dir: &Path) -> std::io::Result<Vec<String>> {
    std::fs::create_dir_all(agents_dir)?;
    let mut written = vec![];
    if let Some(md) = prompts::contract()["member_md"].as_object() {
        for name in prompts::member_profiles().keys() {
            let target = agents_dir.join(format!("{name}.md"));
            if target.exists() {
                continue;
            }
            if let Some(text) = md.get(name).and_then(|v| v.as_str()) {
                atomic_write_text(&target, text)?;
                written.push(format!("{name}.md"));
                tracing::info!("builtin_member_agent_materialized name={} path={}", name, target.display());
            }
        }
    }
    Ok(written)
}

fn profile_str(bp: &Value, k: &str) -> String {
    bp.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
}
fn profile_tools(bp: &Value) -> Vec<String> {
    bp.get("tools").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

type MemberCache = HashMap<PathBuf, (Vec<(String, Option<i128>)>, Vec<(String, AgentConfig)>)>;

fn mtime_ns(path: &Path) -> Option<i128> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    let d = m.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_nanos() as i128)
}

fn md_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> =
        std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "md").unwrap_or(false) && p.is_file()).collect()).unwrap_or_default();
    v.sort();
    v
}

fn member_cache() -> &'static Mutex<MemberCache> {
    static CACHE: OnceLock<Mutex<MemberCache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// `clear_member_profiles_cache`.
pub fn clear_member_profiles_cache() {
    member_cache().lock().unwrap().clear();
}

/// `load_member_profiles` (sorted by name like the dict built from sorted files, then builtins).
pub fn load_member_profiles(agents_dir: &Path) -> Vec<(String, AgentConfig)> {
    let files = md_files(agents_dir);
    let mut sig: Vec<(String, Option<i128>)> = vec![("<dir>".into(), mtime_ns(agents_dir))];
    sig.extend(files.iter().map(|p| (file_name(p), mtime_ns(p))));
    let cache = member_cache();
    if let Some((s, profiles)) = cache.lock().unwrap().get(agents_dir) {
        if *s == sig {
            return profiles.clone();
        }
    }
    let builtins = prompts::member_profiles();
    let mut profiles: Vec<(String, AgentConfig)> = vec![];
    for path in &files {
        match parse_agent_md(path) {
            Ok(mut cfg) if cfg.role == "member" => {
                if let Some(bp) = builtins.get(&cfg.name) {
                    if cfg.tools.is_empty() {
                        cfg.tools = profile_tools(bp);
                    }
                    if cfg.system_prompt.trim().is_empty() {
                        cfg.system_prompt = profile_str(bp, "prompt");
                    }
                }
                if let Some(e) = profiles.iter_mut().find(|(n, _)| *n == cfg.name) {
                    e.1 = cfg;
                } else {
                    profiles.push((cfg.name.clone(), cfg));
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("failed_to_parse_member_md file={} error={}", path.display(), e),
        }
    }
    for (name, bp) in builtins {
        if !profiles.iter().any(|(n, _)| n == name) {
            profiles.push((
                name.clone(),
                AgentConfig {
                    name: profile_str(bp, "name"),
                    role: "member".into(),
                    description: Some(profile_str(bp, "description")),
                    system_prompt: profile_str(bp, "prompt"),
                    tools: profile_tools(bp),
                    mcp: vec![],
                    model: Some(DEFAULT_NEW_USER_MODEL.into()),
                    thinking_level: None,
                    responses_api: None,
                },
            ));
        }
    }
    cache.lock().unwrap().insert(agents_dir.to_path_buf(), (sig, profiles.clone()));
    profiles
}

/// `member_model_is_configured`.
pub fn member_model_is_configured(model: Option<&str>) -> bool {
    matches!(model.map(str::trim), Some(m) if !m.is_empty() && m != DEFAULT_NEW_USER_MODEL)
}

/// `configure_unconfigured_agent_models`.
pub fn configure_unconfigured_agent_models(agents_dir: &Path, provider_model: &str) -> Vec<String> {
    let unconfigured = [DEFAULT_NEW_USER_MODEL, "__PROVIDER_MODEL__", "opencode:big-pickle", "opencode:deepseek-v4-flash-free"];
    let mut updated = vec![];
    let mut files = vec![];
    fn walk(d: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().map(|e| e == "md").unwrap_or(false) {
                    out.push(p);
                }
            }
        }
    }
    walk(agents_dir, &mut files);
    files.sort();
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(cfg) = parse_agent_md(&path) else {
            continue;
        };
        let Some(model) = cfg.model.clone() else {
            continue;
        };
        if !unconfigured.contains(&model.as_str()) || model == provider_model {
            continue;
        }
        let Some((_, _, range)) = split_frontmatter(&text) else {
            continue;
        };
        let fm = text[range.clone()].replacen(&model, provider_model, 1);
        let new = format!("{}{}{}", &text[..range.start], fm, &text[range.end..]);
        if std::fs::write(&path, new).is_ok() {
            updated.push(path.strip_prefix(agents_dir).unwrap_or(&path).display().to_string());
        }
    }
    updated
}

// ── Drift ────────────────────────────────────────────────────────────────────

pub type ConfigStamp = Vec<(PathBuf, Option<i128>)>;

pub fn stamp_agent_files(agent_md: &Path, mcp_config: &Path) -> ConfigStamp {
    vec![(agent_md.to_path_buf(), mtime_ns(agent_md)), (mcp_config.to_path_buf(), mtime_ns(mcp_config))]
}

pub fn detect_drift(stamp: &ConfigStamp) -> Vec<PathBuf> {
    stamp.iter().filter(|(p, rec)| mtime_ns(p) != *rec).map(|(p, _)| p.clone()).collect()
}

// ── Build ────────────────────────────────────────────────────────────────────

const CONTEXT_INJECTED_TOOLS: &[&str] = &["skill", "todo_manage", "schedule_task", "lsp", "ask_user", "plan", "submit_plan", "send_to_workspace"];

/// `_default_tool_registry` (built-ins + MCP tools by name).
pub fn default_tool_registry() -> HashMap<String, ToolRef> {
    let mut reg: HashMap<String, ToolRef> = HashMap::new();
    for n in ["web_search", "web_fetch", "read", "grep", "glob", "patch", "shell", "todo_manage"] {
        if let Some(t) = appv3_tools::builtin_tool(n) {
            reg.insert(n.into(), t);
        }
    }
    reg.insert("skill".into(), Arc::new(crate::skills::SkillTool));
    reg.insert("schedule_task".into(), Arc::new(crate::scheduler::ScheduleTaskTool));
    for n in ["generate_image", "generate_video"] {
        if let Some(t) = appv3_tools::builtin_tool(n) {
            reg.insert(n.into(), t);
        }
    }
    if let Some(mcp) = mcp_source() {
        for s in mcp.server_names() {
            for t in mcp.tools_for_server(&s) {
                reg.insert(t.name().to_string(), t);
            }
        }
    }
    reg
}

/// `_prune_unknown_tools_from_file` — drop tool names the registry does not
/// know from the file's `tools:` list and rewrite it with `yaml.safe_dump`.
/// Failures are logged, never raised.
pub fn prune_unknown_tools_from_file(path: &Path, unknown: &[String]) {
    use appv3_core::pyyaml::{safe_dump_py, safe_load_py, Py};
    let run = || -> Result<(), String> {
        // `Path.read_text` applies universal newlines.
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?.replace("\r\n", "\n").replace('\r', "\n");
        let Some((block, body, _)) = split_frontmatter(&text) else { return Ok(()) };
        let meta = safe_load_py(&block).map_err(|e| e.to_string())?;
        let meta = if meta.truthy() { meta } else { Py::Dict(vec![]) };
        let Py::Dict(mut items) = meta else { return Err(format!("'{}' object has no attribute 'get'", meta.type_name())) };
        let Some(idx) = items.iter().position(|(k, _)| matches!(k, Py::Str(s) if s == "tools")) else { return Ok(()) };
        let Py::List(listed) = &items[idx].1 else { return Ok(()) };
        let mut kept = vec![];
        for t in listed {
            match t {
                Py::List(_) | Py::Dict(_) | Py::Set(_) => return Err(format!("unhashable type: '{}'", t.type_name())),
                Py::Str(s) if unknown.contains(s) => {}
                other => kept.push(other.clone()),
            }
        }
        if kept == *listed {
            return Ok(());
        }
        if kept.is_empty() {
            items.remove(idx);
        } else {
            items[idx].1 = Py::List(kept);
        }
        atomic_write_text(path, &format!("---\n{}---\n\n{body}", safe_dump_py(&Py::Dict(items)))).map_err(|e| e.to_string())
    };
    if let Err(e) = run() {
        tracing::warn!("agent_tools_prune_failed file={} error={}", path.display(), e);
    }
}

/// `_build_agent`.
pub fn build_agent(mut cfg: AgentConfig, registry: &HashMap<String, ToolRef>, factory: &ProviderFactory, source_path: Option<&Path>) -> Agent {
    let mut system_prompt = if cfg.system_prompt.trim().is_empty() { prompts::coding_prompt().to_string() } else { cfg.system_prompt.trim().to_string() };
    if cfg.name == "code" {
        if cfg.description.as_deref().map(|d| d.is_empty()).unwrap_or(true) {
            cfg.description = Some(prompts::coding_description().to_string());
        }
        let mut t = prompts::coding_tools();
        t.append(&mut cfg.tools);
        cfg.tools = t;
        if cfg.system_prompt.trim().is_empty() {
            system_prompt = prompts::coding_prompt().to_string();
        }
    }
    let pick = |n: &str| -> ToolRef { registry.get(n).cloned().unwrap_or_else(|| default_tool_registry()[n].clone()) };
    let mut tools: Vec<ToolRef> = vec![pick("skill"), pick("todo_manage"), pick("schedule_task")];
    let mut seen: std::collections::HashSet<String> = tools.iter().map(|t| t.name().to_string()).collect();
    let mut dedup = vec![];
    for t in &cfg.tools {
        if !dedup.contains(t) {
            dedup.push(t.clone());
        }
    }
    cfg.tools = dedup;
    let mut unknown_tools: Vec<String> = vec![];
    for name in &cfg.tools {
        if CONTEXT_INJECTED_TOOLS.contains(&name.as_str()) {
            continue;
        }
        let Some(t) = registry.get(name) else {
            unknown_tools.push(name.clone());
            continue;
        };
        if seen.insert(name.clone()) {
            tools.push(t.clone());
        }
    }
    if let (false, Some(path)) = (unknown_tools.is_empty(), source_path) {
        prune_unknown_tools_from_file(path, &unknown_tools);
    }
    let mut mcp_names = vec![];
    if let Some(mcp) = mcp_source() {
        for s in mcp.server_names() {
            if !mcp_names.contains(&s) {
                mcp_names.push(s);
            }
        }
        for s in &mcp_names {
            for t in mcp.tools_for_server(s) {
                if seen.insert(t.name().to_string()) {
                    tools.push(t);
                }
            }
        }
    }
    cfg.mcp = mcp_names;
    let mut kw = Kwargs::new();
    if let Some(tl) = cfg.thinking_level.as_deref().filter(|s| !s.is_empty()) {
        kw.insert("thinking_level".into(), json!(tl));
    }
    let provider: Arc<dyn LlmProvider> = match factory(cfg.model.as_deref(), kw) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("agent_provider_unavailable agent={} model={:?} error={}", cfg.name, cfg.model, e);
            let msg = e.to_string();
            Arc::new(UnconfiguredProvider::new(if msg.is_empty() { appv3_providers::factory::unconfigured_message(Some(&cfg.name)) } else { msg }))
        }
    };
    let mut agent = Agent::new(provider, &cfg.name, &system_prompt, tools, cfg.model.clone());
    agent.description = cfg.description.clone();
    agent.thinking_level = cfg.thinking_level.clone().filter(|s| !s.is_empty());
    agent.mcp_servers = cfg.mcp.clone();
    if let Some(sp) = source_path {
        agent.source_path = Some(sp.to_path_buf());
        agent.config_stamp = stamp_agent_files(sp, &settings().mcp_config_path());
    }
    agent
}

/// Load the canonical `code.md` agent (v2 `load_agent_from_dir` minus the
/// session wrapper). `Ok(None)` when the dir or `code.md` is missing.
pub fn load_code_agent(agents_dir: &Path, factory: &ProviderFactory) -> Result<Option<Agent>, String> {
    let dir = appv3_tools::denied::resolve(agents_dir);
    if !dir.exists() {
        return Ok(None);
    }
    let target = dir.join("code.md");
    if !target.is_file() {
        return Ok(None);
    }
    let cfg = validate_canonical_code_profile(&target)?;
    let registry = default_tool_registry();
    let agent = build_agent(cfg, &registry, factory, Some(&target));
    tracing::info!("agent_loaded name={} model={:?}", agent.name, agent.model_id);
    Ok(Some(agent))
}

/// `rebuild_agent_from_disk`.
pub fn rebuild_agent_from_disk(source: &Path, factory: &ProviderFactory) -> Result<Agent, String> {
    let cfg = parse_agent_md(source)?;
    Ok(build_agent(cfg, &default_tool_registry(), factory, Some(source)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_frontmatter_matches_v2_regex() {
        let oracle = regex::Regex::new(r"(?s)\A\s*---\r?\n(.*?)\r?\n---\r?\n?(.*)").unwrap();
        let big = format!("---\nname: a\n---\n{}", "body\n".repeat(50_000));
        for text in crate::skills::tests::FRONTMATTER_CASES.iter().copied().chain([big.as_str()]) {
            let want = oracle.captures(text).map(|c| (c[1].to_string(), c[2].to_string(), c.get(1).unwrap().range()));
            assert_eq!(split_frontmatter(text), want, "{text:?}");
        }
    }

    #[test]
    fn parse_and_validate() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("code.md");
        std::fs::write(&p, "---\nname: code\nmodel: openai:gpt-5\ntools: [read, read, shell]\n---\n\nHello\n").unwrap();
        let c = validate_canonical_code_profile(&p).unwrap();
        assert_eq!(c.system_prompt, "Hello");
        assert_eq!(c.tools, vec!["read", "read", "shell"]);
        std::fs::write(&p, "---\nmodel: gpt\n---\n").unwrap();
        let e = parse_agent_md(&p).unwrap_err();
        assert!(e.contains("invalid model 'gpt'"), "{e}");
        std::fs::write(&p, "no fm").unwrap();
        assert_eq!(parse_agent_md(&p).unwrap_err(), "Agent file 'code.md' is missing frontmatter block (---\\n...\\n---)");
        std::fs::write(&p, "---\nmodel: openai:x\n---\n").unwrap();
        assert!(validate_canonical_code_profile(&p).is_err());
    }

    #[test]
    fn built_agent_knows_its_thinking_level() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("code.md");
        let factory: ProviderFactory = Arc::new(|_, _| Ok(Arc::new(appv3_providers::mock::MockProvider::new(vec![])) as Arc<dyn LlmProvider>));
        std::fs::write(&p, "---\nname: code\nmodel: openai:gpt-5\nthinking_level: high\n---\n\nHi\n").unwrap();
        assert_eq!(rebuild_agent_from_disk(&p, &factory).unwrap().thinking_level.as_deref(), Some("high"));
        std::fs::write(&p, "---\nname: code\nmodel: openai:gpt-5\n---\n\nHi\n").unwrap();
        assert_eq!(rebuild_agent_from_disk(&p, &factory).unwrap().thinking_level, None);
    }

    #[test]
    fn materialize_builtins() {
        let d = tempfile::tempdir().unwrap();
        assert!(ensure_builtin_code_agent(d.path()).unwrap());
        assert!(!ensure_builtin_code_agent(d.path()).unwrap());
        let w = ensure_builtin_member_agents(d.path()).unwrap();
        assert_eq!(w, vec!["explorer.md", "researcher.md"]);
        let c = validate_canonical_code_profile(&d.path().join("code.md")).unwrap();
        assert_eq!(c.model.as_deref(), Some("__PROVIDER_MODEL__"));
        let members = load_member_profiles(d.path());
        assert_eq!(members.iter().map(|m| m.0.as_str()).collect::<Vec<_>>(), vec!["explorer", "researcher"]);
    }
}
