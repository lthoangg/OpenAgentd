//! Skill discovery + the `skill` tool (port of `tools/builtin/skill.py`).

use crate::tools::invalid_args;
use appv3_core::settings::settings;
use appv3_providers::ChatMessage;
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Bundled read-only skill files (`<skill>/<path>` → content), compiled in
/// from `contract/builtin_skills` (v3 wording; v2's `app/agent/builtin_skills`
/// is frozen). Agents read the reference files through the read-only root in
/// `appv3_tools::denied`.
const BUNDLED: &[(&str, &str)] = &[
    ("self-healing/SKILL.md", include_str!("../../../contract/builtin_skills/self-healing/SKILL.md")),
    ("self-healing/references/agents.md", include_str!("../../../contract/builtin_skills/self-healing/references/agents.md")),
    ("self-healing/references/mcp.md", include_str!("../../../contract/builtin_skills/self-healing/references/mcp.md")),
    ("self-healing/references/media.md", include_str!("../../../contract/builtin_skills/self-healing/references/media.md")),
    ("self-healing/references/plugins.md", include_str!("../../../contract/builtin_skills/self-healing/references/plugins.md")),
    ("self-healing/references/skills.md", include_str!("../../../contract/builtin_skills/self-healing/references/skills.md")),
    ("self-healing/references/openagentd.d.ts", appv3_jsplugin::TYPES),
];

/// Bundled files whose source is not under `contract/builtin_skills`.
#[cfg(test)]
const BUNDLED_EXTERNAL: &[&str] = &["self-healing/references/openagentd.d.ts"];

/// Bundled read-only skills, materialised once under the cache dir.
pub fn builtin_skills_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = appv3_tools::denied::builtin_skills_root();
        materialize(&dir, BUNDLED);
        dir
    })
    .clone()
}

/// Write every file that differs, then delete everything else under `dir`,
/// so a skill dropped from the bundle (v3.2's `skill-installer`) stops being
/// discovered.
fn materialize(dir: &Path, files: &[(&str, &str)]) {
    for (rel, body) in files {
        let f = dir.join(rel);
        if std::fs::read_to_string(&f).ok().as_deref() != Some(*body) {
            if let Some(parent) = f.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(&f, body) {
                tracing::warn!("builtin_skill_write_failed path={} error={}", f.display(), e);
            }
        }
    }
    prune_unbundled(dir, dir, files);
}

fn prune_unbundled(root: &Path, dir: &Path, files: &[(&str, &str)]) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        // `DirEntry::file_type` does not follow symlinks, so a link is removed, not descended.
        let removed = if e.file_type().is_ok_and(|t| t.is_dir()) {
            let prefix = format!("{rel}/");
            if files.iter().any(|(f, _)| f.starts_with(&prefix)) {
                prune_unbundled(root, &path, files);
                continue;
            }
            std::fs::remove_dir_all(&path)
        } else if files.iter().any(|(f, _)| *f == rel) {
            continue;
        } else {
            std::fs::remove_file(&path)
        };
        match removed {
            Ok(()) => tracing::info!("builtin_skill_stale_removed path={}", path.display()),
            Err(e) => tracing::warn!("builtin_skill_stale_remove_failed path={} error={}", path.display(), e),
        }
    }
}

fn home() -> PathBuf {
    appv3_core::home::home_dir()
}

fn resolve(p: &Path) -> PathBuf {
    appv3_tools::denied::resolve(p)
}

/// The project skill root. `.agents/` is the only project folder read;
/// `.openagentd/skills` and `.opencode/skills` are not.
fn project_roots(workspace: &Path) -> [PathBuf; 1] {
    [workspace.join(".agents/skills")]
}

/// `_iter_skill_roots` in precedence order.
pub fn skill_roots(workspace: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(ws) = workspace {
        if !settings().is_chat_workspace(Some(ws)) {
            roots.extend(project_roots(ws));
        }
    }
    roots.push(settings().skills_dir.clone());
    roots.push(home().join(".agents/skills"));
    roots.push(builtin_skills_dir());
    roots
}

/// `_iter_skill_paths`: flat `{name}/SKILL.md` and nested `{p}/{s}/SKILL.md`.
pub fn iter_skill_paths(directory: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let sorted_dirs = |p: &Path| -> Vec<(String, PathBuf)> {
        let Ok(rd) = std::fs::read_dir(p) else {
            return vec![];
        };
        let mut v: Vec<(String, PathBuf)> = rd.flatten().filter(|e| e.path().is_dir()).map(|e| (e.file_name().to_string_lossy().to_string(), e.path())).collect();
        v.sort();
        v
    };
    for (name, sub) in sorted_dirs(directory) {
        let f = sub.join("SKILL.md");
        if f.is_file() {
            out.push((f, name.clone()));
        }
        for (nname, nested) in sorted_dirs(&sub) {
            let nf = nested.join("SKILL.md");
            if nf.is_file() {
                out.push((nf, format!("{name}/{nname}")));
            }
        }
    }
    out
}

/// `_lenient_frontmatter`.
fn lenient_frontmatter(block: &str) -> Map<String, Value> {
    static KEY_RE: OnceLock<regex::Regex> = OnceLock::new();
    let key_re = KEY_RE.get_or_init(|| regex::Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());
    let mut meta: Map<String, Value> = Map::new();
    let mut last: Option<String> = None;
    let fold = |meta: &mut Map<String, Value>, k: &str, line: &str| {
        let prev = meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        meta.insert(k.into(), Value::String(format!("{prev} {}", line.trim()).trim().to_string()));
    };
    for raw in block.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if (raw.starts_with(' ') || raw.starts_with('\t')) && last.is_some() {
            fold(&mut meta, last.as_deref().unwrap(), line);
            continue;
        }
        match line.split_once(':') {
            Some((k, v)) if key_re.is_match(k.trim()) => {
                let k = k.trim().to_string();
                let v = v.trim().trim_matches(|c| c == '\'' || c == '"').to_string();
                meta.insert(k.clone(), Value::String(v));
                last = Some(k);
            }
            _ => {
                if let Some(k) = last.clone() {
                    fold(&mut meta, &k, line);
                }
            }
        }
    }
    meta
}

/// Result of strict parsing (write/validation API).
pub enum StrictFrontmatter {
    Mapping(Map<String, Value>, String),
    NotMapping(Value, String),
    YamlError(String),
}

fn split_frontmatter(text: &str) -> Option<(String, String)> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    // v2's pattern minus its `(.*)$` body group: that group always matches,
    // so dropping it changes neither group 1 nor the match end, but a capture
    // search no longer runs the PikeVM over the whole body (it dominated
    // `/api/skills` and per-turn skill listing).
    let re = RE.get_or_init(|| regex::Regex::new(r"(?s)\A---\s*\n(.*?)\n---\s*\n").unwrap());
    // Python `\s*` after `---` may also swallow newlines; handle the common case.
    let c = re.captures(text)?;
    Some((c[1].to_string(), text[c.get(0)?.end()..].trim().to_string()))
}

/// `_parse_frontmatter(text)` in lenient (discovery) mode. `Err` carries the
/// non-YAML exceptions v2 lets escape (`ValueError` from a bad timestamp, …).
pub fn try_parse_frontmatter(text: &str) -> Result<(Map<String, Value>, String), appv3_core::pyyaml::LoadError> {
    let Some((block, body)) = split_frontmatter(text) else {
        return Ok((Map::new(), text.trim().to_string()));
    };
    match appv3_core::pyyaml::safe_load_py(&block) {
        Err(e) if e.is_yaml_error() => {
            tracing::warn!("skill_frontmatter_yaml_invalid_recovered error={}", e);
            Ok((lenient_frontmatter(&block), body))
        }
        Err(e) => Err(e),
        Ok(p) if !p.truthy() => Ok((Map::new(), body)),
        Ok(p) => match p.to_json() {
            Value::Object(m) => Ok((m, body)),
            other => {
                tracing::warn!("skill_frontmatter_not_mapping type={}", crate::pystr::py_type_name(&other));
                Ok((Map::new(), body))
            }
        },
    }
}

/// [`try_parse_frontmatter`] with escaping exceptions treated as no metadata.
pub fn parse_frontmatter(text: &str) -> (Map<String, Value>, String) {
    match try_parse_frontmatter(text) {
        Ok(r) => r,
        Err(_) => (Map::new(), split_frontmatter(text).map(|(_, b)| b).unwrap_or_else(|| text.trim().to_string())),
    }
}

/// `_parse_frontmatter(text, strict=True)`.
pub fn parse_frontmatter_strict(text: &str) -> StrictFrontmatter {
    let Some((block, body)) = split_frontmatter(text) else {
        return StrictFrontmatter::Mapping(Map::new(), text.trim().to_string());
    };
    match appv3_core::pyyaml::safe_load_py(&block) {
        Err(e) => StrictFrontmatter::YamlError(e.to_string()),
        Ok(p) if !p.truthy() => StrictFrontmatter::Mapping(Map::new(), body),
        Ok(p) => match p.to_json() {
            Value::Object(m) => StrictFrontmatter::Mapping(m, body),
            other => StrictFrontmatter::NotMapping(other, body),
        },
    }
}

/// `_render_tokens`.
pub fn render_tokens(text: &str, skill_dir: Option<&Path>, workspace: Option<&Path>) -> String {
    if text.is_empty() {
        return String::new();
    }
    let s = settings();
    let mut tokens: Vec<(&str, String)> =
        vec![("OPENAGENTD_CONFIG_DIR", s.config_dir.display().to_string()), ("AGENTS_DIR", s.agents_dir.display().to_string()), ("SKILLS_DIR", s.skills_dir.display().to_string())];
    if let Some(dir) = skill_dir {
        let rdir = resolve(dir);
        let mut value = rdir.display().to_string();
        if let Some(ws) = workspace {
            if !s.is_chat_workspace(Some(ws)) {
                let is_project = project_roots(ws).iter().any(|r| rdir.starts_with(resolve(r)));
                if is_project {
                    if let Ok(rel) = rdir.strip_prefix(resolve(ws)) {
                        value = rel.display().to_string();
                    }
                }
            }
        }
        tokens.push(("SKILL_DIR", value));
    }
    let mut out = text.to_string();
    for (name, value) in tokens {
        out = out.replace(&format!("${{{name}}}"), &value);
        out = out.replace(&format!("{{{name}}}"), &value);
    }
    out
}

#[derive(Debug, Clone)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// Path of SKILL.md relative to its root.
    pub file: String,
    pub dir: PathBuf,
}

impl SkillInfo {
    pub fn to_json(&self) -> Value {
        json!({"name": self.name, "description": self.description, "file": self.file, "dir": self.dir.display().to_string()})
    }
}

fn meta_str(meta: &Map<String, Value>, key: &str) -> Option<String> {
    meta.get(key).map(|v| match v {
        Value::String(s) => s.clone(),
        other => crate::pystr::py_str(other),
    })
}

fn discover_in(roots: &[PathBuf], workspace: Option<&Path>) -> Vec<SkillInfo> {
    let mut skills: Vec<SkillInfo> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for dir in roots.iter().filter(|r| r.is_dir()) {
        for (path, stem) in iter_skill_paths(dir) {
            let (name, description) = match std::fs::read_to_string(&path) {
                Ok(text) => match try_parse_frontmatter(&text) {
                    Ok((meta, _)) => {
                        let name = meta_str(&meta, "name").unwrap_or_else(|| stem.clone());
                        let desc = render_tokens(&meta_str(&meta, "description").unwrap_or_default(), path.parent(), workspace);
                        (name, desc)
                    }
                    Err(e) => {
                        tracing::warn!("skill_discovery_skipped path={} error={}", path.display(), e);
                        (stem.clone(), String::new())
                    }
                },
                Err(e) => {
                    tracing::warn!("skill_discovery_skipped path={} error={}", path.display(), e);
                    (stem.clone(), String::new())
                }
            };
            if !seen.insert(name.clone()) {
                continue;
            }
            skills.push(SkillInfo {
                name,
                description,
                file: path.strip_prefix(dir).unwrap_or(&path).display().to_string(),
                dir: path.parent().map(Path::to_path_buf).unwrap_or_default(),
            });
        }
    }
    skills
}

/// `discover_skills()` (insertion order = precedence walk order).
pub fn discover_skills(workspace: Option<&Path>) -> Vec<SkillInfo> {
    discover_in(&skill_roots(workspace), workspace)
}

/// `discover_skills(skills_dir)` for one explicit root.
pub fn discover_skills_in(dir: &Path) -> Vec<SkillInfo> {
    discover_in(&[dir.to_path_buf()], None)
}

/// `Path.as_uri()`.
fn as_uri(p: &Path) -> String {
    let mut out = String::from("file://");
    for b in p.display().to_string().bytes() {
        if b.is_ascii_alphanumeric() || b"_.-~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `format_available_skills`.
pub fn format_available_skills(workspace: Option<&Path>, verbose: bool) -> String {
    let mut skills: Vec<SkillInfo> = discover_skills(workspace).into_iter().filter(|s| !s.description.trim().is_empty()).collect();
    if skills.is_empty() {
        return "No skills are currently available.".into();
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    if verbose {
        let mut lines = vec!["<available_skills>".to_string()];
        for s in &skills {
            lines.push("  <skill>".into());
            lines.push(format!("    <name>{}</name>", s.name));
            lines.push(format!("    <description>{}</description>", s.description));
            lines.push(format!("    <location>{}</location>", as_uri(&s.dir)));
            lines.push("  </skill>".into());
        }
        lines.push("</available_skills>".into());
        return lines.join("\n");
    }
    let mut lines = vec!["## Available Skills".to_string()];
    lines.extend(skills.iter().map(|s| format!("- **{}**: {}", s.name, s.description)));
    lines.join("\n")
}

pub fn skill_tool_description(workspace: Option<&Path>) -> String {
    [
        "Load specialized instructions for a matching available skill.",
        "",
        "Call this at most once per skill. If already loaded in the visible conversation, reuse those instructions instead of calling this tool again; repeated loads return the same content.",
        "",
        &format_available_skills(workspace, false),
    ]
    .join("\n")
}

/// `_loaded_skills_from_messages`.
fn loaded_from_messages(messages: &[ChatMessage]) -> BTreeMap<String, String> {
    let mut loaded: BTreeMap<String, String> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut pending: std::collections::HashMap<String, String> = Default::default();
    for m in messages {
        if let ChatMessage::Assistant(a) = m {
            for tc in a.tool_calls.iter().flatten() {
                if tc.function.name != "skill" {
                    continue;
                }
                let args: Value = match serde_json::from_str(if tc.function.arguments.is_empty() { "{}" } else { &tc.function.arguments }) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(name) = args.get("skill_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    if !loaded.contains_key(name) {
                        loaded.insert(name.into(), String::new());
                        order.push(name.into());
                        if !tc.id.is_empty() {
                            pending.insert(tc.id.clone(), name.into());
                        }
                    }
                }
            }
        }
        if let ChatMessage::Tool { tool_call_id, content, .. } = m {
            if let Some(name) = pending.remove(tool_call_id) {
                if let Some(c) = content.as_deref().filter(|c| !c.is_empty()) {
                    loaded.insert(name, c.to_string());
                }
            }
        }
    }
    loaded
}

pub struct SkillTool;

fn ctx_workspace(ctx: &ToolContext) -> PathBuf {
    ctx.denied.workspace_root.clone()
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        "skill"
    }
    fn definition_for(&self, ctx: &ToolContext) -> Value {
        let mut def = self.definition();
        if let Some(d) = def.pointer_mut("/function/description") {
            *d = Value::String(skill_tool_description(Some(&ctx_workspace(ctx))));
        }
        def
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let obj = args.as_object().cloned().unwrap_or_default();
        let raw = obj.get("skill_name").or_else(|| obj.get("name")).or_else(|| obj.get("skill"));
        let skill_name = match raw {
            None => return Err(invalid_args("skill", &["skill_name: Field required".into()])),
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err(invalid_args("skill", &["skill_name: Input should be a valid string".into()])),
        };
        let workspace = ctx_workspace(ctx);
        // state.metadata.setdefault("loaded_skills", ...)
        {
            let mut meta = ctx.metadata.lock().unwrap();
            if !meta.contains_key("loaded_skills") {
                let from_msgs = ctx.messages.as_deref().map(|m| loaded_from_messages(m)).unwrap_or_default();
                let m: Map<String, Value> = from_msgs.into_iter().map(|(k, v)| (k, Value::String(v))).collect();
                meta.insert("loaded_skills".into(), Value::Object(m));
            }
            if let Some(hit) = meta.get("loaded_skills").and_then(|l| l.get(&skill_name)).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                tracing::info!("skill_reused name={}", skill_name);
                return Ok(ToolOutput::text(hit.to_string()));
            }
        }
        let roots: Vec<PathBuf> = skill_roots(Some(&workspace)).into_iter().filter(|r| r.is_dir()).collect();
        if roots.is_empty() {
            return Ok(ToolOutput::text("Skills directory not found."));
        }
        for dir in &roots {
            for (path, stem) in iter_skill_paths(dir) {
                let text = tokio::fs::read_to_string(&path).await.map_err(appv3_tools::ToolError::exec)?;
                let (meta, body) = try_parse_frontmatter(&text).map_err(appv3_tools::ToolError::exec)?;
                let name = meta_str(&meta, "name").unwrap_or_else(|| stem.clone());
                if name == skill_name || stem == skill_name {
                    tracing::info!("skill_loaded name={} file={}", name, path.strip_prefix(dir).unwrap_or(&path).display());
                    let rendered = render_tokens(&body, path.parent(), Some(&workspace));
                    let dir_value = render_tokens("{SKILL_DIR}", path.parent(), Some(&workspace));
                    let rendered = format!("Skill directory: {dir_value}\n\n{rendered}");
                    let mut meta = ctx.metadata.lock().unwrap();
                    if let Some(Value::Object(l)) = meta.get_mut("loaded_skills") {
                        l.insert(skill_name.clone(), json!(rendered));
                        l.insert(name.clone(), json!(rendered));
                        l.insert(stem.clone(), json!(rendered));
                    }
                    return Ok(ToolOutput::text(rendered));
                }
            }
        }
        let available: Vec<Value> = discover_skills(Some(&workspace)).into_iter().map(|s| Value::String(s.name)).collect();
        Ok(ToolOutput::text(format!("Skill '{skill_name}' not found. Available: {}", crate::pystr::py_repr(&Value::Array(available)))))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Edge cases for the `---` frontmatter splitters: backtracking inside
    /// whitespace runs, CRLF, missing closers, trailing text, empty blocks.
    pub(crate) const FRONTMATTER_CASES: &[&str] = &[
        "---\nname: a\n---\nbody\n",
        "---\nname: a\n---\n",
        "---\n\n---\nbody",
        "---\n---\nbody",
        "---  \n \n name: a\n---  \n\n  body  \n",
        "---\nname: a\n---\t\n\t\nbody\n---\nmore\n",
        "---\r\nname: a\r\n---\r\nbody\r\n",
        "--- \nx: 1\n--- trailing\n---\nbody",
        "no frontmatter\n",
        "  ---\nname: a\n---\nbody",
        "---\nname: a\n",
        "---\n",
        "",
        "---\na: |\n  ---\n  x\n---\n\n\nbody\n\n",
    ];

    #[test]
    fn split_frontmatter_matches_v2_regex() {
        let oracle = regex::Regex::new(r"(?s)\A---\s*\n(.*?)\n---\s*\n(.*)\z").unwrap();
        let big = format!("---\nname: a\ndescription: d\n---\n{}", "line of body text\n".repeat(20_000));
        for text in FRONTMATTER_CASES.iter().copied().chain([big.as_str()]) {
            let want = oracle.captures(text).map(|c| (c[1].to_string(), c[2].trim().to_string()));
            assert_eq!(split_frontmatter(text), want, "{text:?}");
        }
    }

    #[test]
    fn lenient_and_strict_frontmatter() {
        let t = "---\nname: x\ndescription: Renders clips. Typical jobs: teaser\n---\nbody\n";
        let (m, b) = parse_frontmatter(t);
        assert_eq!(m["description"], "Renders clips. Typical jobs: teaser");
        assert_eq!(b, "body");
        assert!(matches!(parse_frontmatter_strict(t), StrictFrontmatter::YamlError(_)));
        let (m, b) = parse_frontmatter("no fm\n");
        assert!(m.is_empty());
        assert_eq!(b, "no fm");
    }

    #[test]
    fn loaded_skills_scan() {
        let a = appv3_providers::AssistantMessage { tool_calls: Some(vec![appv3_providers::ToolCall::new("c1", "skill", r#"{"skill_name":"foo"}"#)]), ..Default::default() };
        let msgs = vec![ChatMessage::Assistant(a), ChatMessage::tool("c1", Some("skill".into()), "BODY")];
        assert_eq!(loaded_from_messages(&msgs).get("foo").map(String::as_str), Some("BODY"));
    }

    #[test]
    fn project_skills_only_from_agents_dir() {
        let d = tempfile::tempdir().unwrap();
        let ws = d.path();
        for (dir, name) in [(".openagentd/skills", "a"), (".opencode/skills", "b"), (".agents/skills", "c")] {
            let p = ws.join(dir).join(name);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join("SKILL.md"), format!("---\nname: {name}\ndescription: d\n---\nbody\n")).unwrap();
        }
        let names: Vec<String> = discover_in(&project_roots(ws), Some(ws)).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["c".to_string()]);
        assert!(skill_roots(None).iter().all(|r| !r.to_string_lossy().contains("opencode")));
    }

    #[test]
    fn bundled_files_match_contract_dir() {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    out.push(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/builtin_skills");
        let mut on_disk = vec![];
        walk(&root, &root, &mut on_disk);
        on_disk.sort();
        let mut listed: Vec<String> = BUNDLED.iter().map(|(p, _)| p.to_string()).filter(|p| !BUNDLED_EXTERNAL.contains(&p.as_str())).collect();
        listed.sort();
        assert_eq!(on_disk, listed, "every file under contract/builtin_skills must be listed in BUNDLED");
    }

    #[test]
    fn bundled_skills_parse_and_index_their_references() {
        let link = regex::Regex::new(r"\{SKILL_DIR\}/([A-Za-z0-9_./-]+[A-Za-z0-9_-])").unwrap();
        for (rel, body) in BUNDLED.iter().filter(|(p, _)| p.ends_with("/SKILL.md")) {
            let skill = rel.trim_end_matches("/SKILL.md");
            match parse_frontmatter_strict(body) {
                StrictFrontmatter::Mapping(meta, rest) => {
                    assert_eq!(meta.get("name").and_then(Value::as_str), Some(skill), "{rel}: frontmatter name");
                    assert!(meta.get("description").and_then(Value::as_str).is_some_and(|d| !d.trim().is_empty()), "{rel}: description");
                    assert!(!rest.is_empty(), "{rel}: body");
                }
                _ => panic!("{rel}: frontmatter must be a strict YAML mapping"),
            }
            let prefix = format!("{skill}/");
            let mut files: Vec<&str> = BUNDLED.iter().filter_map(|(p, _)| p.strip_prefix(prefix.as_str())).filter(|p| *p != "SKILL.md").collect();
            files.sort();
            let mut linked: Vec<&str> = link.captures_iter(body).map(|c| c.get(1).unwrap().as_str()).collect();
            linked.sort();
            linked.dedup();
            assert_eq!(linked, files, "{rel} must link every bundled reference, and only those");
        }
    }

    #[test]
    fn bundled_references_have_no_render_tokens() {
        // Only SKILL.md goes through `render_tokens`; references are opened with
        // `read`, so path tokens would stay literal. (`{SKILL_DIR}` is allowed:
        // the skills reference documents it for skill authors.)
        for (rel, body) in BUNDLED.iter().filter(|(p, _)| p.ends_with(".md") && !p.ends_with("/SKILL.md")) {
            for t in ["OPENAGENTD_CONFIG_DIR", "AGENTS_DIR", "SKILLS_DIR"] {
                assert!(!body.contains(&format!("{{{t}}}")), "{rel}: `{{{t}}}` is not rendered in references");
            }
        }
    }

    #[test]
    fn materialize_writes_bundle_and_prunes_stale_entries() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        std::fs::create_dir_all(root.join("skill-installer")).unwrap();
        std::fs::write(root.join("skill-installer/SKILL.md"), "old").unwrap();
        std::fs::create_dir_all(root.join("a/references")).unwrap();
        std::fs::write(root.join("a/references/gone.md"), "old").unwrap();
        std::fs::write(root.join("a/SKILL.md"), "stale").unwrap();
        materialize(root, &[("a/SKILL.md", "new"), ("a/references/x.md", "x")]);
        assert_eq!(std::fs::read_to_string(root.join("a/SKILL.md")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(root.join("a/references/x.md")).unwrap(), "x");
        assert!(!root.join("skill-installer").exists());
        assert!(!root.join("a/references/gone.md").exists());
    }
}
