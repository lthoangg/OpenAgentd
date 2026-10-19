//! Persistent Markdown memory — port of `app/services/memory/*`
//! (store, context compilation, search, lint).

use appv3_core::pyyaml::Py;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

pub const MAX_MEMORY_PAGE_BYTES: u64 = 256 * 1024;
pub const MAX_TOTAL_CATALOG_CHARS: usize = 4000;
pub const MAX_PREFERENCES_CHARS: usize = 1500;
/// `user.md` is pinned in full up to this length, so the agent knows who
/// the user is without reading a page first.
pub const MAX_USER_PROFILE_CHARS: usize = 1000;
pub const MAX_COMPONENT_CATALOG_CHARS: usize = 2600;
pub const MAX_CATALOG_ENTRY_CHARS: usize = 200;

/// Pages pinned in full rather than listed in the catalog.
const PREFERENCES_PAGE: &str = "preferences.md";
const USER_PROFILE_PAGE: &str = "user.md";

/// Body of a fresh `preferences.md`, written at startup.
pub const PREFERENCES_TEMPLATE: &str = "# User Preferences\n\nStanding directives and preferences across all workspaces.\n";

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("{0}")]
    PreconditionRequired(String),
    #[error("{0}")]
    PreconditionFailed(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Scope(String),
    #[error("{0}")]
    Containment(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl MemoryError {
    /// HTTP status v2 maps each error to.
    pub fn status(&self) -> u16 {
        match self {
            MemoryError::PreconditionRequired(_) => 428,
            MemoryError::PreconditionFailed(_) => 412,
            MemoryError::NotFound(_) => 404,
            MemoryError::TooLarge(_) => 413,
            MemoryError::Scope(_) => 403,
            MemoryError::Containment(_) => 400,
            MemoryError::Io(_) => 500,
        }
    }
}

pub fn compute_etag(raw: &[u8]) -> String {
    let d = Sha256::digest(raw);
    format!("\"{}\"", d.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn canon(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| {
        // Python Path.resolve(strict=False): resolve the existing prefix.
        let mut existing = p.to_path_buf();
        let mut tail = Vec::new();
        while !existing.exists() {
            match (existing.file_name().map(|s| s.to_os_string()), existing.parent()) {
                (Some(n), Some(par)) => {
                    tail.push(n);
                    existing = par.to_path_buf();
                }
                _ => return p.to_path_buf(),
            }
        }
        let mut out = dunce::canonicalize(&existing).unwrap_or(existing);
        for n in tail.into_iter().rev() {
            out.push(n);
        }
        out
    })
}

/// `{OPENAGENTD_CONFIG_DIR}/memory` (resolved).
pub fn global_memory_root() -> PathBuf {
    canon(&canon(&appv3_core::settings().config_dir).join("memory"))
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Frontmatter {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default = "general", rename = "type")]
    pub kind: String,
}

fn general() -> String {
    "general".into()
}

/// `parse_frontmatter` → `(frontmatter, body)`.
pub fn parse_frontmatter(text: &str) -> (Option<Frontmatter>, String) {
    if !text.starts_with("---") {
        return (None, text.to_string());
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        return (None, text.to_string());
    }
    let Some(end) = (1..lines.len()).find(|&i| lines[i].trim() == "---") else { return (None, text.to_string()) };
    let yaml_text: String = lines[1..end].concat();
    let body: String = lines[end + 1..].concat().trim_start_matches(['\r', '\n']).to_string();
    // `MemoryFrontmatter.model_validate` (lax `str`: accepts str and bytes).
    let as_str = |p: &Py| match p {
        Py::Str(s) => Some(s.clone()),
        Py::Bytes(b) => String::from_utf8(b.clone()).ok(),
        _ => None,
    };
    match appv3_core::pyyaml::safe_load_py(&yaml_text) {
        Ok(m @ Py::Dict(_)) => {
            let title = match m.get("title") {
                None | Some(Py::None) => None,
                Some(p) => match as_str(p) {
                    Some(s) => Some(s),
                    None => return (None, text.to_string()),
                },
            };
            let kind = match m.get("type") {
                None => "general".into(),
                Some(p) => match as_str(p) {
                    Some(s) => s,
                    None => return (None, text.to_string()),
                },
            };
            (Some(Frontmatter { title, kind }), body)
        }
        _ => (None, text.to_string()),
    }
}

/// `normalize_text`.
pub fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").chars().filter(|&c| c == '\n' || c == '\t' || (c as u32 >= 32 && c as u32 != 127)).collect()
}

/// `html.escape(text, quote=False)`.
pub fn xml_escape(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn chars_len(s: &str) -> usize {
    s.chars().count()
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn extract_summary(content: &str, fallback: &str) -> (String, String) {
    let (fm, body) = parse_frontmatter(content);
    let mut title = fm.and_then(|f| f.title).filter(|t| !t.is_empty()).unwrap_or_default();
    let mut summary = String::new();
    for raw in body.lines() {
        let line = normalize_text(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }
        if let Some(t) = line.strip_prefix("# ") {
            if title.is_empty() {
                title = t.trim().to_string();
                continue;
            }
        }
        if let Some(t) = line.strip_prefix("## ") {
            if title.is_empty() {
                title = t.trim().to_string();
                continue;
            }
        }
        if !line.starts_with('#') {
            summary = line;
            break;
        }
    }
    if title.is_empty() {
        title = fallback.to_string();
    }
    if chars_len(&summary) > MAX_CATALOG_ENTRY_CHARS {
        summary = format!("{}...", truncate_chars(&summary, MAX_CATALOG_ENTRY_CHARS - 3));
    }
    (title, summary)
}

fn walk_md(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() || (ft.is_symlink() && p.is_dir()) {
            walk_md(&p, out);
        } else if p.extension().map(|x| x == "md").unwrap_or(false) {
            out.push(p);
        }
    }
}

fn rel_posix(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/")
}

/// Markdown pages under `root` in `rel` order, with the metadata of the one
/// `stat` that filters them.
fn markdown_files(root: &Path) -> Vec<(PathBuf, std::fs::Metadata)> {
    if !root.is_dir() {
        return vec![];
    }
    let mut all = Vec::new();
    walk_md(root, &mut all);
    let mut files: Vec<(String, PathBuf, std::fs::Metadata)> = all
        .into_iter()
        .filter_map(|p| {
            let rel = rel_posix(root, &p);
            if rel.split('/').any(|part| part.starts_with('.')) {
                return None;
            }
            let m = std::fs::metadata(&p).ok()?;
            (m.is_file() && m.len() <= MAX_MEMORY_PAGE_BYTES).then_some((rel, p, m))
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.into_iter().map(|(_, p, m)| (p, m)).collect()
}

/// `_iter_markdown_files`.
pub fn iter_markdown_files(root: &Path) -> Vec<PathBuf> {
    markdown_files(root).into_iter().map(|(p, _)| p).collect()
}

fn read_lossy(p: &Path) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&std::fs::read(p)?).to_string())
}

/// A page's `(modified, len)`: a change to either means re-reading it.
type Stamp = (Option<std::time::SystemTime>, u64);
type SummaryCache = std::collections::HashMap<PathBuf, (Stamp, String, String)>;

/// `(title, summary)` per page, so a turn re-reads only the pages that
/// changed since the last one. The walk and `stat` still run every time,
/// so edits made outside the app are picked up.
static SUMMARIES: std::sync::LazyLock<std::sync::Mutex<SummaryCache>> = std::sync::LazyLock::new(Default::default);

fn page_summary(p: &Path, meta: &std::fs::Metadata) -> Option<(String, String)> {
    let stamp: Stamp = (meta.modified().ok(), meta.len());
    let lock = || SUMMARIES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((s, title, summary)) = lock().get(p) {
        if *s == stamp {
            return Some((title.clone(), summary.clone()));
        }
    }
    let raw = read_lossy(p).ok()?;
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let (title, summary) = extract_summary(&raw, &stem);
    lock().insert(p.to_path_buf(), (stamp, title.clone(), summary.clone()));
    Some((title, summary))
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GlobalSnapshot {
    pub preferences_content: String,
    pub user_profile: String,
    pub knowledge_catalog: String,
}

/// The body of a pinned page, without frontmatter, cut to `max` chars.
fn pinned_page(root: &Path, rel: &str, max: usize) -> String {
    let p = root.join(rel);
    if !p.is_file() {
        return String::new();
    }
    let Ok(raw) = read_lossy(&p) else { return String::new() };
    let (_, body) = parse_frontmatter(&raw);
    let n = normalize_text(&body).trim().to_string();
    if chars_len(&n) > max {
        format!("{}...", truncate_chars(&n, max - 3))
    } else {
        n
    }
}

/// `compile_global_snapshot`.
pub fn compile_global_snapshot(root: &Path) -> GlobalSnapshot {
    let pref = pinned_page(root, PREFERENCES_PAGE, MAX_PREFERENCES_CHARS);
    let user_profile = pinned_page(root, USER_PROFILE_PAGE, MAX_USER_PROFILE_CHARS);
    let mut entries = Vec::new();
    let mut total = 0usize;
    let files = markdown_files(root);
    {
        let present: std::collections::HashSet<&Path> = files.iter().map(|(p, _)| p.as_path()).collect();
        SUMMARIES.lock().unwrap_or_else(|e| e.into_inner()).retain(|p, _| !p.starts_with(root) || present.contains(p.as_path()));
    }
    for (p, meta) in &files {
        let rel = rel_posix(root, p);
        if rel == PREFERENCES_PAGE || rel == USER_PROFILE_PAGE {
            continue;
        }
        let Some((title, summary)) = page_summary(p, meta) else { continue };
        let topic = rel.strip_suffix(".md").unwrap_or(&rel);
        let mut entry = format!("- [[global:{topic}]]: {title}");
        if !summary.is_empty() && summary != title {
            entry.push_str(&format!(" — {summary}"));
        }
        let esc = xml_escape(&entry);
        if total + chars_len(&esc) + 1 > MAX_COMPONENT_CATALOG_CHARS {
            entries.push("... [additional global pages available via /memory search]".to_string());
            break;
        }
        total += chars_len(&esc) + 1;
        entries.push(esc);
    }
    GlobalSnapshot { preferences_content: pref, user_profile, knowledge_catalog: entries.join("\n") }
}

/// `compose_memory_context`.
pub fn compose_memory_context(snap: &GlobalSnapshot, global_root: &Path) -> String {
    let root = global_root.to_string_lossy().replace('\\', "/");
    let roots_xml = format!("  <memory_roots>\n    <global_root>{root}</global_root>\n  </memory_roots>");
    let prefix = format!("<openagentd_memory>\n{roots_xml}\n");
    let suffix = "</openagentd_memory>";
    let overhead = chars_len(&prefix) + chars_len(suffix);
    let pref_xml =
        if snap.preferences_content.is_empty() { String::new() } else { format!("  <global_preferences>\n{}\n  </global_preferences>\n", xml_escape(&snap.preferences_content)) };
    let user_xml = if snap.user_profile.is_empty() { String::new() } else { format!("  <user_profile>\n{}\n  </user_profile>\n", xml_escape(&snap.user_profile)) };
    let avail = MAX_TOTAL_CATALOG_CHARS as i64 - overhead as i64 - chars_len(&pref_xml) as i64 - chars_len(&user_xml) as i64;
    let avail = avail.max(0);
    let g_budget = avail - chars_len("  <global_knowledge>\n\n  </global_knowledge>\n") as i64;
    const MORE: &str = "    ... [more global pages via /memory search]";
    let more_len = chars_len(MORE) as i64;
    let mut packed: Vec<(String, i64)> = Vec::new();
    let mut curr = 0i64;
    for line in snap.knowledge_catalog.lines().filter(|l| !l.is_empty()) {
        let l = chars_len(line) as i64;
        if curr + l < g_budget {
            packed.push((format!("    {line}"), l + 5));
            curr += l + 5;
        } else {
            // Make room for the marker so the block stays within budget.
            while curr + more_len > g_budget {
                let Some((_, n)) = packed.pop() else { break };
                curr -= n;
            }
            packed.push((MORE.to_string(), more_len + 1));
            break;
        }
    }
    let lines: Vec<String> = packed.into_iter().map(|(s, _)| s).collect();
    let g_xml = if lines.is_empty() { String::new() } else { format!("  <global_knowledge>\n{}\n  </global_knowledge>\n", lines.join("\n")) };
    format!("{prefix}{pref_xml}{user_xml}{g_xml}{suffix}")
}

/// The `<openagentd_memory>` block for the current disk state.
pub fn memory_context() -> String {
    let root = global_memory_root();
    compose_memory_context(&compile_global_snapshot(&root), &root)
}

/// `search_memory`.
pub fn search_memory(root: &Path, query: &str) -> Vec<Value> {
    let tokens: Vec<String> = query.split_whitespace().map(|t| t.to_lowercase()).collect();
    if tokens.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    for p in iter_markdown_files(root) {
        let rel = rel_posix(root, &p);
        let Ok(raw) = read_lossy(&p) else { continue };
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let (title, summary) = extract_summary(&raw, &stem);
        let blob = format!("{rel} {title} {summary} {raw}").to_lowercase();
        if tokens.iter().all(|t| blob.contains(t)) {
            out.push(json!({"path": rel, "title": title}));
        }
    }
    out
}

// ── Store ────────────────────────────────────────────────────────────────────

pub struct Page {
    pub path: String,
    pub content: String,
    pub frontmatter: Option<Frontmatter>,
    pub etag: String,
}

fn assert_no_symlinks(path: &Path) -> Result<(), MemoryError> {
    let mut cur = PathBuf::new();
    for c in path.components() {
        cur.push(c.as_os_str());
        if let Ok(md) = std::fs::symlink_metadata(&cur) {
            if md.file_type().is_symlink() {
                return Err(MemoryError::Containment(format!("Symlinks are strictly forbidden inside memory paths: {}", cur.display())));
            }
        }
    }
    Ok(())
}

/// `assert_authorized_memory_path` (used by file-mutating tools).
pub fn assert_authorized_memory_path(path: &Path) -> Result<(), MemoryError> {
    if path.extension().map(|e| e.to_string_lossy().to_lowercase() != "md").unwrap_or(true) {
        return Err(MemoryError::Containment(format!("Memory files must have a .md extension: {}", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())));
    }
    assert_no_symlinks(path)?;
    let root = global_memory_root();
    if !canon(path).starts_with(&root) {
        return Err(MemoryError::Scope(format!("Memory mutation is only allowed in global memory ({}): {}", root.display(), path.display())));
    }
    Ok(())
}

fn resolve_scope_file(root: &Path, rel: &str) -> Result<PathBuf, MemoryError> {
    let norm = Path::new(rel);
    if norm.is_absolute() || norm.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(MemoryError::Containment(format!("Path traversal detected: {rel}")));
    }
    let target = root.join(norm);
    assert_no_symlinks(&target)?;
    let resolved = canon(&target);
    if !resolved.starts_with(root) {
        return Err(MemoryError::Containment(format!("Path escapes memory root: {rel}")));
    }
    if resolved.extension().map(|e| e.to_string_lossy().to_lowercase() != "md").unwrap_or(true) {
        return Err(MemoryError::Containment(format!("Memory page must be a .md file: {rel}")));
    }
    Ok(resolved)
}

pub fn read_page(root: &Path, rel: &str) -> Result<Page, MemoryError> {
    let target = resolve_scope_file(root, rel)?;
    if !target.is_file() {
        return Err(MemoryError::NotFound(format!("Memory page not found: {rel}")));
    }
    let raw = std::fs::read(&target)?;
    let content = String::from_utf8_lossy(&raw).to_string();
    let (fm, _) = parse_frontmatter(&content);
    Ok(Page { path: rel.replace('\\', "/"), content, frontmatter: fm, etag: compute_etag(&raw) })
}

fn write_atomic(target: &Path, raw: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut tf = tempfile::Builder::new().prefix(".tmp_mem_").tempfile_in(parent)?;
    std::io::Write::write_all(&mut tf, raw)?;
    tf.persist(target).map_err(|e| e.error)?;
    Ok(())
}

/// `write_page` → `(page, is_no_op)`.
pub async fn write_page(root: &Path, rel: &str, content: &str, if_match: Option<&str>) -> Result<(Page, bool), MemoryError> {
    let target = resolve_scope_file(root, rel)?;
    let raw = content.as_bytes();
    if raw.len() as u64 > MAX_MEMORY_PAGE_BYTES {
        return Err(MemoryError::TooLarge(format!("Page size ({} bytes) exceeds limit ({} bytes)", raw.len(), MAX_MEMORY_PAGE_BYTES)));
    }
    let _g = appv3_core::path_lock(&target).await;
    if target.is_file() {
        let Some(im) = if_match else {
            return Err(MemoryError::PreconditionRequired("If-Match header is required to update an existing memory page.".into()));
        };
        let cur = std::fs::read(&target)?;
        let cur_etag = compute_etag(&cur);
        if im.trim() != cur_etag {
            return Err(MemoryError::PreconditionFailed(format!("ETag mismatch: current {cur_etag}, provided {im}")));
        }
        if cur == raw {
            let (fm, _) = parse_frontmatter(content);
            return Ok((Page { path: rel.replace('\\', "/"), content: content.into(), frontmatter: fm, etag: cur_etag }, true));
        }
        if compute_etag(&std::fs::read(&target)?) != cur_etag {
            return Err(MemoryError::PreconditionFailed("Target file was modified before commit.".into()));
        }
    }
    write_atomic(&target, raw)?;
    let (fm, _) = parse_frontmatter(content);
    Ok((Page { path: rel.replace('\\', "/"), content: content.into(), frontmatter: fm, etag: compute_etag(raw) }, false))
}

pub async fn delete_page(root: &Path, rel: &str, if_match: Option<&str>) -> Result<(), MemoryError> {
    let target = resolve_scope_file(root, rel)?;
    let _g = appv3_core::path_lock(&target).await;
    if !target.is_file() {
        return Err(MemoryError::NotFound(format!("Memory page not found: {rel}")));
    }
    let Some(im) = if_match else {
        return Err(MemoryError::PreconditionRequired("If-Match header is required to delete an existing memory page.".into()));
    };
    let cur_etag = compute_etag(&std::fs::read(&target)?);
    if im.trim() != cur_etag {
        return Err(MemoryError::PreconditionFailed(format!("ETag mismatch: current {cur_etag}, provided {im}")));
    }
    std::fs::remove_file(&target)?;
    Ok(())
}

/// `list_pages` → `[{path, title, type}]`.
pub fn list_pages(root: &Path) -> Vec<Value> {
    if !root.is_dir() {
        return vec![];
    }
    let mut all = Vec::new();
    walk_md(root, &mut all);
    all.sort_by_key(|p| rel_posix(root, p));
    let mut out = Vec::new();
    for p in all {
        if !p.is_file() {
            continue;
        }
        let rel = rel_posix(root, &p);
        if rel.split('/').any(|x| x.starts_with('.')) {
            continue;
        }
        let Ok(raw) = read_lossy(&p) else { continue };
        let (fm, _) = parse_frontmatter(&raw);
        let mut title = fm.as_ref().and_then(|f| f.title.clone()).filter(|t| !t.is_empty()).unwrap_or_default();
        if title.is_empty() {
            for line in raw.lines() {
                let s = line.trim();
                if let Some(t) = s.strip_prefix("# ") {
                    title = t.trim().into();
                    break;
                }
                if let Some(t) = s.strip_prefix("## ") {
                    title = t.trim().into();
                    break;
                }
            }
        }
        if title.is_empty() {
            title = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        }
        out.push(json!({"path": rel, "title": title, "type": fm.map(|f| f.kind).unwrap_or_else(general)}));
    }
    out
}

// ── Lint ─────────────────────────────────────────────────────────────────────

fn strip_fences(text: &str) -> String {
    let mut in_fence = false;
    let mut fc = String::new();
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        let s = line.trim();
        if s.starts_with("```") || s.starts_with("~~~") {
            let marker = &s[..3];
            if !in_fence {
                in_fence = true;
                fc = marker.to_string();
                continue;
            } else if marker == fc {
                in_fence = false;
                fc.clear();
                continue;
            }
        }
        if !in_fence {
            out.push_str(line);
        }
    }
    out
}

/// `lint_memory_scope` → `[{code, path, message}]`.
pub fn lint(root: &Path) -> Vec<Value> {
    static WL: OnceLock<Regex> = OnceLock::new();
    let wl = WL.get_or_init(|| Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
    let mut findings = Vec::new();
    if !root.is_dir() {
        return findings;
    }
    let mut all = Vec::new();
    walk_md(root, &mut all);
    all.sort();
    let f = |code: &str, path: &str, msg: String| json!({"code": code, "path": path, "message": msg});
    for p in all {
        if !p.is_file() {
            continue;
        }
        let rel = rel_posix(root, &p);
        match std::fs::metadata(&p) {
            Ok(m) if m.len() > MAX_MEMORY_PAGE_BYTES => {
                findings.push(f("PAGE_TOO_LARGE", &rel, format!("Memory page size ({} bytes) exceeds limit ({} bytes)", m.len(), MAX_MEMORY_PAGE_BYTES)));
                continue;
            }
            Err(e) => {
                findings.push(f("INVALID_PAGE", &rel, format!("Could not stat page: {e}")));
                continue;
            }
            _ => {}
        }
        let content = match std::fs::read_to_string(&p) {
            Ok(c) => c,
            Err(e) => {
                findings.push(f("INVALID_PAGE", &rel, format!("Could not read page: {e}")));
                continue;
            }
        };
        if content.starts_with("---") {
            let lines: Vec<&str> = content.split_inclusive('\n').collect();
            if let Some(end) = (1..lines.len()).find(|&i| lines[i].trim() == "---") {
                match appv3_core::pyyaml::safe_load_py(&lines[1..end].concat()) {
                    Ok(Py::None) | Ok(Py::Dict(_)) => {}
                    Ok(_) => findings.push(f("INVALID_FRONTMATTER", &rel, "Frontmatter must be a YAML mapping".into())),
                    Err(e) => findings.push(f("INVALID_FRONTMATTER", &rel, format!("Malformed YAML frontmatter: {e}"))),
                }
            }
        }
        for c in wl.captures_iter(&strip_fences(&content)) {
            let raw = c[1].trim();
            if raw.is_empty() {
                continue;
            }
            if raw.starts_with("workspace:") {
                findings.push(f("INVALID_WIKILINK_TARGET", &rel, format!("Workspace memory is not supported; use global memory: [[{raw}]]")));
                continue;
            }
            let sub = raw.strip_prefix("global:").map(str::trim).unwrap_or(raw);
            let tf = if sub.ends_with(".md") { root.join(sub) } else { root.join(format!("{sub}.md")) };
            if !tf.is_file() {
                findings.push(f("BROKEN_LINK", &rel, format!("Broken wikilink target not found: [[{raw}]]")));
            }
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_empty_and_catalog() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let s = compose_memory_context(&compile_global_snapshot(root), root);
        // v2 renders `global_root.as_posix()`.
        assert_eq!(
            s,
            format!("<openagentd_memory>\n  <memory_roots>\n    <global_root>{}</global_root>\n  </memory_roots>\n</openagentd_memory>", root.to_string_lossy().replace('\\', "/"))
        );
        std::fs::write(root.join("preferences.md"), "Use tabs <always>").unwrap();
        std::fs::write(root.join("db.md"), "---\ntitle: Database\n---\nPostgres notes").unwrap();
        let snap = compile_global_snapshot(root);
        assert_eq!(snap.preferences_content, "Use tabs <always>");
        assert_eq!(snap.knowledge_catalog, "- [[global:db]]: Database — Postgres notes");
        let s = compose_memory_context(&snap, root);
        assert!(s.contains("  <global_preferences>\nUse tabs &lt;always&gt;\n  </global_preferences>\n"));
        assert!(s.contains("  <global_knowledge>\n    - [[global:db]]: Database — Postgres notes\n  </global_knowledge>\n"));
    }

    #[test]
    fn preferences_are_pinned_up_to_1500_chars() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let long = "p".repeat(1400);
        std::fs::write(root.join("preferences.md"), &long).unwrap();
        assert_eq!(compile_global_snapshot(root).preferences_content, long);
        std::fs::write(root.join("preferences.md"), "q".repeat(1600)).unwrap();
        let pref = compile_global_snapshot(root).preferences_content;
        assert_eq!(pref.chars().count(), 1500);
        assert!(pref.ends_with("..."));
    }

    /// `user.md` is who the user is: the agent should know it from the first
    /// turn, not find a one-line catalog entry and have to go read the page.
    #[test]
    fn user_profile_is_pinned_in_full_and_left_out_of_the_catalog() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        std::fs::write(root.join("user.md"), "---\ntitle: About the user\n---\n# About the user\n\n- Name: Hoang\n- Role: maintains <OpenAgentd>\n- Time zone: Asia/Ho_Chi_Minh\n")
            .unwrap();
        std::fs::write(root.join("db.md"), "# Database\n\nPostgres notes").unwrap();
        let snap = compile_global_snapshot(root);
        assert_eq!(snap.user_profile, "# About the user\n\n- Name: Hoang\n- Role: maintains <OpenAgentd>\n- Time zone: Asia/Ho_Chi_Minh");
        assert_eq!(snap.knowledge_catalog, "- [[global:db]]: Database — Postgres notes");
        let s = compose_memory_context(&snap, root);
        assert!(s.contains("  <user_profile>\n# About the user\n\n- Name: Hoang\n- Role: maintains &lt;OpenAgentd&gt;\n- Time zone: Asia/Ho_Chi_Minh\n  </user_profile>\n"), "{s}");
        assert!(!s.contains("[[global:user]]"), "{s}");
    }

    #[test]
    fn user_profile_is_pinned_up_to_1000_chars() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        std::fs::write(root.join("user.md"), "u".repeat(1000)).unwrap();
        assert_eq!(compile_global_snapshot(root).user_profile, "u".repeat(1000));
        std::fs::write(root.join("user.md"), "v".repeat(1200)).unwrap();
        let profile = compile_global_snapshot(root).user_profile;
        assert_eq!(profile.chars().count(), 1000);
        assert!(profile.ends_with("..."));
    }

    #[test]
    fn memory_block_fits_its_budget_with_a_full_profile_and_catalog() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        std::fs::write(root.join("preferences.md"), "r".repeat(1400)).unwrap();
        std::fs::write(root.join("user.md"), "s".repeat(1000)).unwrap();
        for i in 0..40 {
            std::fs::write(root.join(format!("topic{i:02}.md")), format!("# Topic {i}\n\nNotes about topic number {i} and its details.")).unwrap();
        }
        let s = compose_memory_context(&compile_global_snapshot(root), root);
        assert!(s.chars().count() <= 4000, "block is {} chars", s.chars().count());
        assert!(s.contains(&"r".repeat(1400)), "preferences were truncated");
        assert!(s.contains(&"s".repeat(1000)), "the user profile was truncated");
        // Pinned pages must still leave room for the catalog.
        assert!(s.contains("[[global:topic00]]"));
        assert!(s.contains("more global pages via /memory search"));
    }

    /// Summaries are cached per page; an edit made outside the app (a new
    /// size or mtime) or a deleted page must show on the next compile.
    #[test]
    fn catalog_follows_edits_and_deletes() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        std::fs::write(root.join("db.md"), "# Database\n\nPostgres notes").unwrap();
        std::fs::write(root.join("ops.md"), "# Ops\n\nDeploy notes").unwrap();
        assert_eq!(compile_global_snapshot(root).knowledge_catalog, "- [[global:db]]: Database — Postgres notes\n- [[global:ops]]: Ops — Deploy notes");
        std::fs::write(root.join("db.md"), "# Database\n\nSQLite notes, longer").unwrap();
        std::fs::remove_file(root.join("ops.md")).unwrap();
        assert_eq!(compile_global_snapshot(root).knowledge_catalog, "- [[global:db]]: Database — SQLite notes, longer");
    }
}
