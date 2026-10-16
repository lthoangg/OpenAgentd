//! `/api/commands`, `/api/snippets`, `/api/skills` — markdown libraries.

use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::manager;
use appv3_agent::skills::{self, StrictFrontmatter};
use appv3_core::settings;
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub fn commands_router() -> Router<AppState> {
    Router::new().route("/", get(list_commands)).route("/{*rest}", post(render_command_route))
}

pub fn snippets_router() -> Router<AppState> {
    Router::new().route("/", get(list_snippets)).route("/{*rest}", post(render_snippet_route))
}

pub fn skills_router() -> Router<AppState> {
    Router::new().route("/", get(list_skills).post(create_skill)).route("/{*name}", get(get_skill).put(update_skill).delete(delete_skill))
}

// ── shared markdown helpers (`app/services/commands.py`) ────────────────────

/// `commands._parse_frontmatter` — YAML errors escape (v2 has no `except`).
pub fn parse_frontmatter(text: &str) -> Result<(Map<String, Value>, String), appv3_core::pyyaml::LoadError> {
    // v2's pattern without the always-matching `(.*)$` body group (see `skills::split_frontmatter`).
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?s)\A---\s*\n(.*?)\n---\s*\n").unwrap());
    let Some(c) = re.captures(text) else { return Ok((Map::new(), py_strip(text))) };
    let meta = appv3_core::pyyaml::safe_load(&c[1])?.as_object().cloned().unwrap_or_default();
    Ok((meta, py_strip(&text[c.get(0).map_or(text.len(), |m| m.end())..])))
}

/// Python `str.strip()` (whitespace set close enough to `char::is_whitespace`).
pub fn py_strip(s: &str) -> String {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{1c}' || c == '\u{1d}' || c == '\u{1e}' || c == '\u{1f}').to_string()
}

fn description_of(meta: &Map<String, Value>) -> String {
    match meta.get("description") {
        Some(Value::String(s)) => py_strip(s),
        _ => String::new(),
    }
}

fn collect_md(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            collect_md(&p, out);
        } else if p.extension().map(|x| x == "md").unwrap_or(false) && p.is_file() {
            out.push(p);
        }
    }
}

/// `_iter_md(root)`: `(path, name)` for `*.md` at most one level deep.
pub fn iter_md(root: &Path) -> Vec<(PathBuf, String)> {
    if !root.is_dir() {
        return vec![];
    }
    let mut all = vec![];
    collect_md(root, &mut all);
    all.sort_by(|a, b| a.components().cmp(b.components()));
    all.into_iter()
        .filter_map(|p| {
            let rel = p.strip_prefix(root).ok()?.with_extension("");
            if rel.components().count() > 2 {
                return None;
            }
            Some((p.clone(), rel.to_string_lossy().replace('\\', "/")))
        })
        .collect()
}

fn workspace_path(ws: Option<&str>) -> ApiResult<Option<PathBuf>> {
    match ws {
        None => Ok(None),
        Some(w) => manager::validate_workspace(w, true).map(|p| Some(PathBuf::from(p))).map_err(ApiError::unprocessable),
    }
}

/// Command/snippet roots in precedence order. `.agents/` is the only project
/// folder read; `.openagentd/` and OpenCode folders are not.
fn library_roots(kind: &str, workspace: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
    let h = home();
    let cfg = &settings().config_dir;
    let mut roots = vec![];
    if let Some(ws) = workspace {
        if !settings().is_chat_workspace(Some(ws)) {
            roots.push((ws.join(".agents").join(kind), "project-agents"));
        }
    }
    roots.push((cfg.join(kind), "global-openagentd"));
    roots.push((h.join(".agents").join(kind), "global-agents"));
    roots
}

pub struct MdItem {
    pub name: String,
    pub description: String,
    pub body: String,
    pub source: String,
}

fn discover(kind: &str, workspace: Option<&Path>) -> Result<Vec<MdItem>, ApiError> {
    let mut out: Vec<MdItem> = vec![];
    for (root, source) in library_roots(kind, workspace) {
        for (path, name) in iter_md(&root) {
            if out.iter().any(|i| i.name == name) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let (meta, body) = parse_frontmatter(&text).map_err(|e| ApiError::internal(format!("{}: {e}", e.kind)))?;
            out.push(MdItem { name, description: description_of(&meta), body, source: source.into() });
        }
    }
    Ok(out)
}

fn builtin_commands() -> &'static Value {
    static B: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    B.get_or_init(|| serde_json::from_str(include_str!("../../../../contract/builtin_commands.json")).unwrap())
}

fn summaries(mut items: Vec<MdItem>) -> Vec<Value> {
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items.into_iter().map(|i| json!({"name": i.name, "description": i.description, "source": i.source})).collect()
}

async fn list_commands(q: Qs) -> ApiResult<Response> {
    let ws = workspace_path(q.get("workspace"))?;
    let items = blocking(move || discover("commands", ws.as_deref())).await?;
    Ok(json(json!({"commands": summaries(items)})))
}

fn strip_render(rest: &str) -> Option<&str> {
    rest.strip_suffix("/render").filter(|n| !n.is_empty())
}

/// `render_command`.
pub fn render_command(body: &str, arguments: &str) -> String {
    let args = py_strip(arguments);
    if body.contains("$ARGUMENTS") {
        return body.replace("$ARGUMENTS", &args);
    }
    if !args.is_empty() {
        return format!("{body}\n\n{args}");
    }
    body.to_string()
}

/// `render_memory_command`.
fn render_memory(arguments: &str) -> String {
    let root = appv3_memory::global_memory_root();
    let args = py_strip(arguments);
    let (sub, sub_arg) = match args.split_once(char::is_whitespace) {
        Some((a, b)) => (a.to_lowercase(), py_strip(b)),
        None => (args.to_lowercase(), String::new()),
    };
    match sub.as_str() {
        "" => {
            let c = appv3_memory::memory_context();
            if c.is_empty() {
                "No memory pages found.".into()
            } else {
                c
            }
        }
        "show" => {
            if sub_arg.is_empty() {
                return "Usage: /memory show <page> (e.g. /memory show preferences.md)".into();
            }
            let mut page_path = sub_arg.clone();
            if let Some((scope, p)) = sub_arg.split_once(':') {
                if scope == "workspace" {
                    return "Error: Workspace memory has been removed. Only global memory is supported.".into();
                } else if scope != "global" {
                    return format!("Error: Unknown memory scope '{scope}'. Use 'global' or omit prefix.");
                }
                page_path = p.to_string();
            }
            if !page_path.ends_with(".md") {
                page_path.push_str(".md");
            }
            match appv3_memory::read_page(&root, &page_path) {
                Ok(page) => {
                    let mut content = page.content.clone();
                    if content.chars().count() > 2000 {
                        content = content.chars().take(2000).collect::<String>() + "\n\n... [Truncated at 2,000 characters]";
                    }
                    format!("### Memory: {}\n\n{content}", page.path)
                }
                Err(e) => format!("Error reading memory page '{sub_arg}': {e}"),
            }
        }
        "search" => {
            if sub_arg.is_empty() {
                return "Usage: /memory search <query>".into();
            }
            let results = appv3_memory::search_memory(&root, &sub_arg);
            if results.is_empty() {
                return format!("No memory pages matching '{sub_arg}' found.");
            }
            let mut lines = vec![format!("### Memory Search Results for '{sub_arg}':\n")];
            for r in results {
                lines.push(format!("- **{}** — {}", r["path"].as_str().unwrap_or(""), r["title"].as_str().unwrap_or("")));
            }
            lines.join("\n")
        }
        "lint" => {
            let findings = appv3_memory::lint(&root);
            if findings.is_empty() {
                return "### Memory Lint Report\n\nNo issues found! All memory pages and links are valid.".into();
            }
            let mut lines = vec!["### Memory Lint Report\n".to_string()];
            for f in findings {
                lines.push(format!("- **[{}]** `{}`: {}", f["code"].as_str().unwrap_or(""), f["path"].as_str().unwrap_or(""), f["message"].as_str().unwrap_or("")));
            }
            lines.join("\n")
        }
        other => format!("Unknown /memory subcommand '{other}'. Supported subcommands: show, search, lint."),
    }
}

async fn render_command_route(AxPath(rest): AxPath<String>, q: Qs, body: Bytes) -> ApiResult<Response> {
    let Some(name) = strip_render(&rest).map(String::from) else { return Err(ApiError::not_found("Not Found")) };
    let b = body_value(&body)?;
    let arguments = match b.get("arguments") {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(o) => return Err(ApiError::validation(vec![verr("string_type", &loc(&["body", "arguments"]), "Input should be a valid string", o.clone())])),
    };
    let ws = workspace_path(q.get("workspace"))?;
    let found = {
        let (ws, name) = (ws.clone(), name.clone());
        blocking(move || discover("commands", ws.as_deref()).map(|v| v.into_iter().find(|c| c.name == name))).await?
    };
    let (cmd_body, builtin) = match found {
        Some(c) => (c.body, false),
        None => match builtin_commands().get(&name) {
            Some(b) => (b["body"].as_str().unwrap_or("").to_string(), true),
            None => return Err(ApiError::not_found(format!("Command '{name}' not found."))),
        },
    };
    if builtin && name == "memory" {
        let content = blocking(move || render_memory(&arguments)).await;
        return Ok(json(json!({"name": name, "content": content})));
    }
    Ok(json(json!({"name": name, "content": render_command(&cmd_body, &arguments)})))
}

fn snippet_ws(ws: Option<&str>) -> ApiResult<PathBuf> {
    match ws {
        None => Err(ApiError::unprocessable("Snippet workspace is required.")),
        Some(w) => manager::validate_workspace(w, true).map(PathBuf::from).map_err(ApiError::unprocessable),
    }
}

async fn list_snippets(q: Qs) -> ApiResult<Response> {
    let ws = snippet_ws(q.get("workspace"))?;
    let items = blocking(move || discover("snippets", Some(&ws))).await?;
    Ok(json(json!({"snippets": summaries(items)})))
}

async fn render_snippet_route(AxPath(rest): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let Some(name) = strip_render(&rest).map(String::from) else { return Err(ApiError::not_found("Not Found")) };
    let ws = snippet_ws(q.get("workspace"))?;
    let n2 = name.clone();
    let found = blocking(move || discover("snippets", Some(&ws)).map(|v| v.into_iter().find(|s| s.name == n2))).await?;
    match found {
        Some(s) => Ok(json(json!({"name": s.name, "content": s.body}))),
        None => Err(ApiError::not_found(format!("Snippet '{name}' not found."))),
    }
}

// ── skills ──────────────────────────────────────────────────────────────────

/// `skill._project_root()` outside an agent run: the default
/// `DeniedPathsConfig` workspace, or `Path.cwd()` while constructing that
/// (process-wide, cached once built) singleton raises.
fn default_project_root() -> PathBuf {
    static BUILT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !BUILT.load(std::sync::atomic::Ordering::Relaxed) {
        if appv3_tools::denied::default_config_escapes() {
            return std::env::current_dir().unwrap_or_default();
        }
        BUILT.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    std::env::temp_dir().join("openagentd-default-workspace")
}

pub fn discover_runtime_skills() -> Vec<skills::SkillInfo> {
    let root = default_project_root();
    let _ = std::fs::create_dir_all(&root);
    skills::discover_skills(Some(&root))
}

fn rel_to(path: &Path, root: &Path) -> bool {
    resolve(path).starts_with(resolve(root))
}

/// Resolved `(root, label)` pairs checked by `_skill_source`, in order.
/// Resolved once per request so listing N skills costs N+5 realpaths, not 10N.
fn source_roots() -> Vec<(PathBuf, &'static str)> {
    let s = settings();
    let pr = default_project_root();
    let h = home();
    [
        (pr.join(".agents/skills"), "project-agents"),
        (s.skills_dir.clone(), "global-openagentd"),
        (h.join(".agents/skills"), "global-agents"),
        (skills::builtin_skills_dir(), "builtin"),
        (s.config_dir.clone(), "global-openagentd"),
    ]
    .into_iter()
    .map(|(p, l)| (resolve(&p), l))
    .collect()
}

/// `(source, editable)` for a SKILL.md path against pre-resolved roots.
fn classify(path: &Path, roots: &[(PathBuf, &'static str)]) -> (&'static str, bool) {
    let rp = resolve(path);
    let source = roots.iter().find(|(r, _)| rp.starts_with(r)).map(|(_, l)| *l).unwrap_or("unknown");
    // `editable` = not under the builtin root.
    let builtin = roots.iter().any(|(r, l)| *l == "builtin" && rp.starts_with(r));
    (source, !builtin)
}

fn skill_source(path: &Path) -> &'static str {
    classify(path, &source_roots()).0
}

fn editable(path: &Path) -> bool {
    !rel_to(path, &skills::builtin_skills_dir())
}

/// `_parse_skill` → (description, error).
fn parse_skill(name: &str, content: &str) -> (String, Option<String>) {
    match skills::parse_frontmatter_strict(content) {
        StrictFrontmatter::YamlError(e) => (String::new(), Some(format!("Invalid frontmatter: {e}"))),
        StrictFrontmatter::NotMapping(..) => (String::new(), Some("Frontmatter must be a YAML mapping.".into())),
        StrictFrontmatter::Mapping(meta, _) => {
            let desc = match meta.get("description") {
                None => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(_) => return (String::new(), Some("'description' must be a string.".into())),
            };
            let fm_name = meta.get("name").cloned().unwrap_or(Value::String(name.into()));
            if fm_name != Value::String(name.into()) {
                let shown = match &fm_name {
                    Value::String(s) => s.clone(),
                    other => appv3_agent::pystr::py_str(other),
                };
                return (desc, Some(format!("Frontmatter name '{shown}' does not match directory name '{name}'.")));
            }
            (py_strip(&desc), None)
        }
    }
}

const NAME_RE: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$";

fn validate_name(n: &str) -> Result<(), String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if n.is_empty() || !RE.get_or_init(|| regex::Regex::new(NAME_RE).unwrap()).is_match(n) {
        return Err(format!("Invalid name '{n}'. Use letters, digits, '.', '_', '-' only (1-64 chars, must start with letter/digit)."));
    }
    Ok(())
}

/// `agent_fs._skill_file` path validation.
pub fn skill_file(name: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() > 2 {
        return Err(format!("Skill name '{name}' is nested more than one level deep. Only one level of nesting is allowed (e.g. 'parent/sub')."));
    }
    if parts[0].is_empty() {
        return Err("Skill name cannot be empty.".into());
    }
    for p in &parts {
        validate_name(p)?;
    }
    let root = resolve(&settings().skills_dir);
    let file = resolve(&root.join(name).join("SKILL.md"));
    if !file.starts_with(&root) {
        return Err(format!("Path escapes skills directory: '{name}'."));
    }
    Ok(file)
}

pub fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    appv3_core::secret_files::write_atomic(path, content)
}

fn skill_detail(name: &str, path: &Path, content: &str, desc: &str, error: Option<String>) -> Value {
    let source = skill_source(path);
    json!({"name": name, "path": path.display().to_string(), "content": content, "description": desc, "error": error, "built_in": source == "builtin", "editable": editable(path), "source": source})
}

async fn list_skills() -> Response {
    let rows = blocking(|| {
        let mut rows = vec![];
        let roots = source_roots();
        for info in discover_runtime_skills() {
            let path = info.dir.join("SKILL.md");
            let (source, can_edit) = classify(&path, &roots);
            match std::fs::read_to_string(&path) {
                Err(e) => rows.push((info.name.clone(), json!({"name": info.name, "description": "", "valid": false, "error": e.to_string(), "built_in": source == "builtin", "editable": false, "source": source}))),
                Ok(text) => {
                    let (desc, err) = parse_skill(&info.name, &text);
                    rows.push((info.name.clone(), json!({"name": info.name, "description": desc, "valid": err.is_none(), "error": err, "built_in": source == "builtin", "editable": can_edit, "source": source})));
                }
            }
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows.into_iter().map(|(_, v)| v).collect::<Vec<_>>()
    })
    .await;
    json(json!({"skills": rows}))
}

fn validate_route_name(name: &str) -> ApiResult<()> {
    skill_file(name).map(|_| ()).map_err(ApiError::bad_request)
}

fn find_skill(name: &str) -> Option<skills::SkillInfo> {
    discover_runtime_skills().into_iter().find(|s| s.name == name)
}

async fn get_skill(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    validate_route_name(&name)?;
    let n = name.clone();
    let Some(info) = blocking(move || find_skill(&n)).await else { return Err(ApiError::not_found(format!("Skill '{name}' not found."))) };
    let path = info.dir.join("SKILL.md");
    let content = std::fs::read_to_string(&path).map_err(|e| ApiError::not_found(e.to_string()))?;
    let (desc, err) = parse_skill(&name, &content);
    Ok(json(skill_detail(&name, &path, &content, &desc, err)))
}

pub fn write_body(raw: &[u8]) -> ApiResult<(String, String)> {
    let b = body_value(raw)?;
    let mut errs = vec![];
    let mut get = |k: &str| match b.get(k) {
        Some(Value::String(s)) => s.clone(),
        None => {
            errs.push(verr("missing", &loc(&["body", k]), "Field required", b.clone()));
            String::new()
        }
        Some(o) => {
            errs.push(verr("string_type", &loc(&["body", k]), "Input should be a valid string", o.clone()));
            String::new()
        }
    };
    let (n, c) = (get("name"), get("content"));
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    Ok((n, c))
}

async fn create_skill(raw: Bytes) -> ApiResult<Response> {
    let (name, content) = write_body(&raw)?;
    let (desc, err) = parse_skill(&name, &content);
    if let Some(e) = err {
        return Err(ApiError::unprocessable(e));
    }
    let file = skill_file(&name).map_err(ApiError::bad_request)?;
    if file.exists() {
        return Err(ApiError::conflict(format!("Skill '{name}' already exists.")));
    }
    atomic_write(&file, &content).map_err(|e| ApiError::bad_request(e.to_string()))?;
    tracing::info!("skill_fs_write name={} bytes={}", name, content.len());
    Ok(json_code(
        201,
        json!({"name": name, "path": file.display().to_string(), "content": content, "description": desc, "error": null, "built_in": false, "editable": true, "source": "global-openagentd"}),
    ))
}

async fn update_skill(AxPath(name): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    validate_route_name(&name)?;
    let (bname, content) = write_body(&raw)?;
    if bname != name {
        return Err(ApiError::unprocessable(format!("URL name '{name}' does not match body name '{bname}'.")));
    }
    let n = name.clone();
    let Some(info) = blocking(move || find_skill(&n)).await else { return Err(ApiError::not_found(format!("Skill '{name}' not found."))) };
    let path = info.dir.join("SKILL.md");
    if !editable(&path) {
        return Err(ApiError::new(403, format!("Skill '{name}' is read-only because it comes from {}.", skill_source(&path))));
    }
    let (desc, err) = parse_skill(&name, &content);
    if let Some(e) = err {
        return Err(ApiError::unprocessable(e));
    }
    atomic_write(&path, &content).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let source = skill_source(&path);
    Ok(json(
        json!({"name": name, "path": path.display().to_string(), "content": content, "description": desc, "error": null, "built_in": source == "builtin", "editable": true, "source": source}),
    ))
}

async fn delete_skill(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    validate_route_name(&name)?;
    let n = name.clone();
    let Some(info) = blocking(move || find_skill(&n)).await else { return Err(ApiError::not_found(format!("Skill '{name}' not found."))) };
    let path = info.dir.join("SKILL.md");
    if !editable(&path) {
        return Err(ApiError::new(403, format!("Skill '{name}' is read-only because it comes from {}.", skill_source(&path))));
    }
    if !path.is_file() {
        return Err(ApiError::not_found(format!("Skill '{}' not found.", path.display())));
    }
    std::fs::remove_file(&path).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let parent = path.parent().unwrap().to_path_buf();
    if std::fs::remove_dir(&parent).is_ok() {
        let grand = parent.parent().map(Path::to_path_buf);
        let source = skill_source(&parent);
        let pr = default_project_root();
        let root = match source {
            "project-agents" => Some(pr.join(".agents/skills")),
            "global-openagentd" => Some(settings().skills_dir.clone()),
            "global-agents" => Some(home().join(".agents/skills")),
            _ => None,
        };
        if let (Some(root), Some(g)) = (root, grand) {
            if resolve(&g) != resolve(&root) {
                let _ = std::fs::remove_dir(&g);
            }
        }
    }
    Ok(json(json!({"name": name})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_roots_only_agents_and_config() {
        let d = tempfile::tempdir().unwrap();
        for kind in ["commands", "snippets"] {
            let roots = library_roots(kind, Some(d.path()));
            let labels: Vec<&str> = roots.iter().map(|(_, l)| *l).collect();
            assert_eq!(labels, ["project-agents", "global-openagentd", "global-agents"], "{kind}");
            assert_eq!(roots[0].0, d.path().join(".agents").join(kind));
            assert!(roots.iter().all(|(p, _)| !p.to_string_lossy().contains("opencode") && !p.ends_with(Path::new(".openagentd").join(kind))), "{roots:?}");
        }
    }

    #[test]
    fn classify_finds_builtin_by_label() {
        let roots = source_roots();
        let builtin = skills::builtin_skills_dir().join("self-healing/SKILL.md");
        assert_eq!(classify(&builtin, &roots), ("builtin", false));
        let global = settings().skills_dir.join("mine/SKILL.md");
        assert_eq!(classify(&global, &roots), ("global-openagentd", true));
    }
}
