//! The `patch` tool.

use crate::args::Args;
use crate::denied::DeniedPaths;
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Add,
    Update,
    Delete,
}

#[derive(Debug, Default, Clone)]
pub struct Chunk {
    pub old: Vec<String>,
    pub new: Vec<String>,
    pub raw_old: Vec<String>,
    pub raw_new: Vec<String>,
    pub scope_anchor: Option<String>,
    pub scope_is_literal: bool,
    pub context_pairs: Vec<(usize, usize)>,
}

#[derive(Debug, Clone)]
pub struct FilePatch {
    pub kind: Kind,
    pub path: String,
    pub move_to: Option<String>,
    pub contents: Vec<String>,
    pub chunks: Vec<Chunk>,
}

fn verr(s: impl Into<String>) -> ToolError {
    ToolError::Execution(s.into())
}

pub fn clean_patch_text(t: &str) -> String {
    let mut text = t.trim().to_string();
    if text.starts_with("```") {
        let mut lines: Vec<&str> = text.split('\n').collect();
        if lines.first().map(|l| l.starts_with("```")).unwrap_or(false) {
            lines.remove(0);
        }
        if lines.last().map(|l| l.trim().starts_with("```")).unwrap_or(false) {
            lines.pop();
        }
        text = lines.join("\n").trim().to_string();
    }
    // The closing marker starts its line. Text that only mentions it inside
    // a line is content, and must not cut the patch short there.
    let starts_line = |at: usize| text[..at].rsplit('\n').next().is_some_and(|before| before.trim().is_empty());
    let (b, e) = (text.find("*** Begin Patch"), text.rmatch_indices("*** End Patch").map(|(at, _)| at).find(|at| starts_line(*at)));
    if let (Some(b), Some(e)) = (b, e) {
        if e >= b {
            text = text[b..e + "*** End Patch".len()].to_string();
        }
    }
    text
}

pub fn parse_patch(patch_text: &str) -> Result<Vec<FilePatch>, ToolError> {
    let cleaned = clean_patch_text(patch_text);
    let norm = cleaned.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = norm.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() {
        return Err(verr("Patch must start with '*** Begin Patch' and end with '*** End Patch'."));
    }
    // Name the missing marker and quote where the text starts, so a model
    // that dropped it resends the whole patch rather than guessing.
    let quote = |l: &str| l.trim().chars().take(80).collect::<String>();
    if lines[0].trim() != "*** Begin Patch" {
        return Err(verr(format!(
            "patch_text does not start with '*** Begin Patch'; it starts with: `{}`. Resend the whole patch with '*** Begin Patch' as its first line.",
            quote(lines[0])
        )));
    }
    // The closing line is optional: models sometimes leave it out of a
    // complete patch, and text cut off mid-reply never gets here (a tool
    // call whose arguments are not whole JSON is dropped before it runs).
    let end = if lines.len() > 1 && lines[lines.len() - 1].trim() == "*** End Patch" { lines.len() - 1 } else { lines.len() };
    // The marker written as a hunk line would become a line of the file.
    let last = lines[lines.len() - 1];
    if end == lines.len() && last.strip_prefix(['+', '-']).is_some_and(|rest| rest.trim() == "*** End Patch") {
        return Err(verr(format!(
            "patch_text has no closing line: its last line is `{}`. Put '*** End Patch' on a line of its own, with nothing before it. If that text is meant as a line of the file, add the closing line after it.",
            quote(last)
        )));
    }
    let mut patches: Vec<FilePatch> = vec![];
    let mut chunk: Option<Chunk> = None;
    macro_rules! finish {
        () => {
            if let Some(c) = chunk.take() {
                if let Some(cur) = patches.last_mut() {
                    cur.chunks.push(c);
                }
            }
        };
    }
    for line in &lines[1..end] {
        let line = *line;
        let header = [("*** Add File: ", Kind::Add), ("*** Update File: ", Kind::Update), ("*** Delete File: ", Kind::Delete)]
            .iter()
            .find_map(|(p, k)| line.strip_prefix(p).map(|rest| (*k, rest.trim().to_string())));
        if let Some((kind, path)) = header {
            finish!();
            patches.push(FilePatch { kind, path, move_to: None, contents: vec![], chunks: vec![] });
            continue;
        }
        let Some(cur) = patches.last_mut() else {
            return Err(verr("Patch content must follow a file operation header."));
        };
        if let Some(rest) = line.strip_prefix("*** Move to: ") {
            if cur.kind != Kind::Update {
                return Err(verr("Move is only valid inside an update operation."));
            }
            cur.move_to = Some(rest.trim().to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("@@ in:") {
            finish!();
            let anchor = rest.trim();
            if anchor.is_empty() {
                return Err(verr("A scoped hunk must include an anchor after '@@ in:'."));
            }
            chunk = Some(Chunk { scope_anchor: Some(anchor.into()), scope_is_literal: true, ..Default::default() });
            continue;
        }
        if let Some(rest) = line.strip_prefix("@@") {
            finish!();
            let a = rest.strip_prefix(' ').unwrap_or(rest).trim();
            chunk = Some(Chunk { scope_anchor: if a.is_empty() { None } else { Some(a.into()) }, ..Default::default() });
            continue;
        }
        let cur = patches.last_mut().unwrap();
        match cur.kind {
            Kind::Add => {
                if let Some(r) = line.strip_prefix('+') {
                    cur.contents.push(r.into());
                } else if line.starts_with('*') {
                    return Err(verr(format!(
                        "Unexpected '*'-prefixed line inside an Add File section (malformed header?): {}. Prefix content lines with '+'.",
                        crate::py_repr_str(line)
                    )));
                } else {
                    cur.contents.push(line.into());
                }
                continue;
            }
            Kind::Delete => return Err(verr("Delete file operations must not include content.")),
            Kind::Update => {}
        }
        let Some(c) = chunk.as_mut() else {
            return Err(verr("Update operations must include an '@@' hunk before changes."));
        };
        if let Some(r) = line.strip_prefix('+') {
            c.new.push(r.into());
            c.raw_new.push(r.into());
        } else if let Some(r) = line.strip_prefix('-') {
            c.old.push(r.into());
            c.raw_old.push(r.into());
        } else {
            let text = line.strip_prefix(' ').unwrap_or(line);
            c.context_pairs.push((c.old.len(), c.new.len()));
            c.old.push(text.into());
            c.new.push(text.into());
            c.raw_old.push(line.into());
            c.raw_new.push(line.into());
        }
    }
    finish!();
    if patches.is_empty() {
        return Err(verr("Patch contains no file operations."));
    }
    for p in &patches {
        if p.kind == Kind::Update && p.move_to.is_none() && !p.chunks.iter().any(|c| c.old != c.new) {
            let detail = if p.chunks.is_empty() { "it has no '@@' hunk" } else { "no hunk line starts with '-' or '+', so every line reads as unchanged context" };
            return Err(verr(format!(
                "Update section for {} would change nothing: {detail}. Prefix every line you want removed with '-' and every line you want added with '+', or use '*** Move to: <path>' to rename the file.",
                p.path
            )));
        }
    }
    Ok(patches)
}

fn lines_to_text(lines: &[String]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n") + "\n"
    }
}

fn strip_line_numbers(lines: &[String]) -> Option<Vec<String>> {
    static RX: OnceLock<Regex> = OnceLock::new();
    let rx = RX.get_or_init(|| Regex::new(r"^\s*\d+:\s?").unwrap());
    if lines.is_empty() {
        return None;
    }
    lines.iter().map(|l| rx.find(l).map(|m| l[m.end()..].to_string())).collect()
}

fn find_matches(content: &[String], old: &[String], trimmed: bool) -> Vec<usize> {
    if old.is_empty() || old.len() > content.len() {
        return vec![];
    }
    let target: Vec<&str> = old.iter().map(|l| if trimmed { l.trim_end() } else { l.as_str() }).collect();
    (0..=content.len() - old.len()).filter(|&i| content[i..i + old.len()].iter().zip(&target).all(|(c, t)| if trimmed { c.trim_end() == *t } else { c == t })).collect()
}

fn indent_len(s: &str) -> usize {
    s.len() - s.trim_start().len()
}

fn find_indent_tolerant(content: &[String], old: &[String]) -> Vec<usize> {
    if old.is_empty() || old.len() > content.len() {
        return vec![];
    }
    let st: Vec<&str> = old.iter().map(|l| l.trim()).collect();
    if !st.iter().any(|s| !s.is_empty()) {
        return vec![];
    }
    let mut out = vec![];
    for i in 0..=content.len() - old.len() {
        let w = &content[i..i + old.len()];
        if w.iter().map(|l| l.trim()).collect::<Vec<_>>() != st {
            continue;
        }
        let deltas: std::collections::HashSet<i64> =
            w.iter().zip(old).filter(|(c, e)| !c.trim().is_empty() && !e.trim().is_empty()).map(|(c, e)| indent_len(c) as i64 - indent_len(e) as i64).collect();
        if deltas.len() == 1 {
            out.push(i);
        }
    }
    out
}

fn adjust_indent(window: &[String], old: &[String], new: &[String]) -> Vec<String> {
    for (c, o) in window.iter().zip(old) {
        if !c.trim().is_empty() && !o.trim().is_empty() {
            let delta = indent_len(c) as i64 - indent_len(o) as i64;
            if delta > 0 {
                let pad = " ".repeat(delta as usize);
                return new.iter().map(|l| if l.trim().is_empty() { l.clone() } else { format!("{pad}{l}") }).collect();
            }
            if delta < 0 {
                let trim = " ".repeat((-delta) as usize);
                return new.iter().map(|l| l.strip_prefix(trim.as_str()).map(String::from).unwrap_or_else(|| l.clone())).collect();
            }
            break;
        }
    }
    new.to_vec()
}

fn lines_str(starts: &[usize]) -> String {
    let mut s = starts.iter().take(5).map(|i| format!("line {}", i + 1)).collect::<Vec<_>>().join(", ");
    if starts.len() > 5 {
        s.push_str(&format!(" (and {} more)", starts.len() - 5));
    }
    s
}

fn find_anchor(content: &[String], anchor: &str, path: &str, scope_start: usize, literal: bool) -> Result<usize, ToolError> {
    let a = vec![anchor.to_string()];
    let mut starts: Vec<usize> = find_matches(content, &a, false).into_iter().filter(|s| *s >= scope_start).collect();
    if starts.is_empty() {
        starts = content.iter().enumerate().filter(|(i, l)| *i >= scope_start && l.trim_end() == anchor.trim_end()).map(|(i, _)| i).collect();
    }
    if starts.is_empty() && !literal {
        let needle = anchor.trim();
        starts = content
            .iter()
            .enumerate()
            .filter(|(i, l)| {
                let s = l.trim();
                *i >= scope_start
                    && s.starts_with(needle)
                    && (s.len() == needle.len() || {
                        let c = s[needle.len()..].chars().next().unwrap();
                        !c.is_alphanumeric() && c != '_'
                    })
            })
            .map(|(i, _)| i)
            .collect();
    }
    if starts.is_empty() {
        return Err(verr(format!("Could not find scope anchor in {path}: {}. Check that it matches a unique line in the current file.", crate::py_repr_str(anchor))));
    }
    if starts.len() > 1 {
        let hint = if literal { "Use a unique literal anchor after '@@ in:'." } else { "Use a unique literal anchor after '@@'." };
        return Err(verr(format!("Scope anchor is ambiguous in {path}. Found {} matching locations at {}. {hint}", starts.len(), lines_str(&starts))));
    }
    Ok(starts[0])
}

fn sample(old: &[String]) -> String {
    let n = old.len().min(5);
    let mut s = old[..n].iter().map(|l| format!("  | {l}")).collect::<Vec<_>>().join("\n");
    if old.len() > n {
        s.push_str(&format!("\n  | ... ({} more lines)", old.len() - n));
    }
    s
}

fn miss_error(path: &str, content: &[String], old: &[String]) -> ToolError {
    let mut hint = String::new();
    if let Some(first) = old.iter().map(|l| l.trim()).find(|l| !l.is_empty()) {
        let cands: Vec<usize> = content.iter().enumerate().filter(|(_, l)| l.contains(first)).map(|(i, _)| i + 1).collect();
        if !cands.is_empty() {
            let s = cands.iter().take(3).map(|i| format!("line {i}")).collect::<Vec<_>>().join(", ");
            hint = format!("\nNote: Similar text found at {s} in {path}, but surrounding context differed.");
        }
    }
    verr(format!(
        "Could not find patch context in {path}.\nThe patch was looking for this block:\n{}{hint}\nCheck that context lines match the current file contents exactly.",
        sample(old)
    ))
}

fn ambiguous_error(path: &str, starts: &[usize], old: &[String]) -> ToolError {
    verr(format!(
        "Patch context is ambiguous in {path}.\nFound {} matching locations at {}.\nThe ambiguous block was:\n{}\nAdd more surrounding context lines above or below this block to uniquely identify the target location.",
        starts.len(),
        lines_str(starts),
        sample(old)
    ))
}

pub fn apply_chunks(content: &str, chunks: &[Chunk], path: &str) -> Result<(String, Vec<Value>), ToolError> {
    let crlf = content.contains("\r\n");
    let norm = content.replace("\r\n", "\n").replace('\r', "\n");
    let trailing = norm.ends_with('\n') || norm.is_empty();
    let mut lines: Vec<String> = norm.split('\n').map(String::from).collect();
    if trailing && lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    let mut delta: i64 = 0;
    let mut cursor = 0usize;
    let mut hunks = vec![];
    for c in chunks {
        let (mut old, mut new) = (c.old.clone(), c.new.clone());
        let mut scope_start = cursor;
        if let Some(a) = &c.scope_anchor {
            scope_start = find_anchor(&lines, a, path, cursor, c.scope_is_literal)? + 1;
        }
        let in_scope = |v: Vec<usize>| -> Vec<usize> { v.into_iter().filter(|s| *s >= scope_start).collect() };
        let or_else = |a: Vec<usize>, b: &dyn Fn() -> Vec<usize>| if a.is_empty() { b() } else { a };
        if old == new {
            if old.is_empty() {
                cursor = scope_start;
                continue;
            }
            let mut starts = or_else(in_scope(find_matches(&lines, &old, false)), &|| in_scope(find_matches(&lines, &old, true)));
            if starts.is_empty() && c.raw_old != c.old {
                starts = or_else(in_scope(find_matches(&lines, &c.raw_old, false)), &|| in_scope(find_matches(&lines, &c.raw_old, true)));
            }
            if starts.is_empty() {
                return Err(miss_error(path, &lines, &old));
            }
            if starts.len() > 1 {
                return Err(ambiguous_error(path, &starts, &old));
            }
            cursor = starts[0] + old.len();
            continue;
        }
        let start;
        let actual_new: Vec<String>;
        if old.is_empty() {
            start = scope_start;
            actual_new = new.clone();
        } else {
            let mut starts = in_scope(find_matches(&lines, &old, false));
            if starts.is_empty() {
                starts = in_scope(find_matches(&lines, &old, true));
            }
            if starts.is_empty() && c.raw_old != c.old {
                starts = or_else(in_scope(find_matches(&lines, &c.raw_old, false)), &|| in_scope(find_matches(&lines, &c.raw_old, true)));
                if !starts.is_empty() {
                    old = c.raw_old.clone();
                    new = c.raw_new.clone();
                }
            }
            if starts.is_empty() {
                if let Some(bare) = strip_line_numbers(&old) {
                    let bs = or_else(in_scope(find_matches(&lines, &bare, false)), &|| in_scope(find_matches(&lines, &bare, true)));
                    if !bs.is_empty() {
                        starts = bs;
                        old = bare;
                        new = strip_line_numbers(&new).unwrap_or(new);
                    }
                }
            }
            if starts.is_empty() {
                let is = in_scope(find_indent_tolerant(&lines, &old));
                if is.len() == 1 {
                    starts = is;
                    old = lines[starts[0]..starts[0] + old.len()].to_vec();
                    new = adjust_indent(&old, &c.old, &new);
                }
            }
            if starts.is_empty() {
                return Err(miss_error(path, &lines, &c.old));
            }
            if starts.len() > 1 {
                return Err(ambiguous_error(path, &starts, &c.old));
            }
            start = starts[0];
            let window = lines[start..start + old.len()].to_vec();
            let mut an = new.clone();
            for (oi, ni) in &c.context_pairs {
                if *oi < window.len() && *ni < an.len() {
                    an[*ni] = window[*oi].clone();
                }
            }
            actual_new = an;
        }
        let new_start = start as i64 + 1;
        hunks.push(json!({"old_start": new_start - delta, "new_start": new_start}));
        delta += actual_new.len() as i64 - old.len() as i64;
        let n = actual_new.len();
        lines.splice(start..start + old.len(), actual_new);
        cursor = start + n;
    }
    let mut next = lines.join("\n");
    if trailing && !lines.is_empty() {
        next.push('\n');
    }
    if crlf {
        next = next.replace('\n', "\r\n");
    }
    Ok((next, hunks))
}

#[derive(Clone)]
struct Snap {
    content: Vec<u8>,
    mode: u32,
}

#[derive(Clone)]
struct VFile {
    content: Vec<u8>,
    mode: u32,
}

const DEFAULT_FILE_MODE: u32 = 0o644;

fn file_mode(p: &Path) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).map(|m| m.permissions().mode() & 0o7777).unwrap_or(DEFAULT_FILE_MODE)
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        DEFAULT_FILE_MODE
    }
}

fn snapshot(p: &Path) -> Result<Option<Snap>, ToolError> {
    if !p.exists() {
        return Ok(None);
    }
    if !p.is_file() {
        return Err(verr(format!("Path is a directory: {}", p.display())));
    }
    let content = std::fs::read(p)?;
    Ok(Some(Snap { content, mode: file_mode(p) }))
}

/// Flush staged bytes before the rename so a crash can't publish a truncated
/// file. On Apple platforms `sync_all` is `F_FULLFSYNC` (~5 ms per file, it
/// also drains the drive cache); plain `fsync(2)` (~0.5 ms) is enough for
/// workspace edits, so the full flush is kept only for memory pages.
fn flush_staged(f: &std::fs::File, full: bool) -> std::io::Result<()> {
    #[cfg(target_vendor = "apple")]
    if !full {
        return nix::unistd::fsync(f).map_err(std::io::Error::from);
    }
    let _ = full;
    f.sync_all()
}

fn stage_file(path: &Path, data: &[u8], mode: u32, full_sync: bool) -> std::io::Result<PathBuf> {
    let parent = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut tmp = tempfile::Builder::new().prefix(&format!(".{}.", path.file_name().unwrap_or_default().to_string_lossy())).suffix(".tmp").tempfile_in(parent)?;
    use std::io::Write;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file().set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    let _ = mode;
    tmp.write_all(data)?;
    flush_staged(tmp.as_file(), full_sync)?;
    let (_, p) = tmp.keep().map_err(|e| e.error)?;
    Ok(p)
}

fn is_memory_path(p: &Path) -> bool {
    let root = appv3_core::settings().config_dir.join("memory");
    if crate::denied::resolve(p).starts_with(crate::denied::resolve(&root)) {
        return true;
    }
    let s = p.to_string_lossy();
    s.contains("/.openagentd/memory") || s.contains("\\.openagentd\\memory")
}

pub const MAX_MEMORY_PAGE_BYTES: usize = 256 * 1024;

/// Where Plan mode lets `patch` write, relative to the workspace root: the
/// plans folder, one folder down (a plan's attachments).
pub const PLAN_ATTACHMENTS_ROOT: &str = ".agents/plans";

/// Why Plan mode refuses to write `resolved`, or `None` when it is a plan
/// attachment (a file inside a folder under `<root>/.agents/plans/`) or a
/// page under the global `memory_root`. Memory lives outside the project,
/// and the memory rules have the lead save in the same turn in every mode.
/// The plan files themselves (`.agents/plans/*.md`) belong to the `plan`
/// tool, which tracks their revisions. `resolved` must already be resolved
/// (symlinks followed), as [`DeniedPaths::validate_path`] returns it.
pub fn plan_mode_refusal(root: &Path, resolved: &Path, memory_root: &Path) -> Option<String> {
    if resolved.starts_with(crate::denied::resolve(memory_root)) {
        return None;
    }
    let root = crate::denied::resolve(root);
    let plans = crate::denied::resolve(&root.join(PLAN_ATTACHMENTS_ROOT));
    let inside = plans.starts_with(&root).then(|| resolved.strip_prefix(&plans).ok()).flatten();
    let shown = resolved.strip_prefix(&root).map(|r| r.display().to_string()).unwrap_or_else(|_| resolved.display().to_string());
    match inside.map(|rel| rel.components().count()) {
        Some(n) if n >= 2 => None,
        Some(_) => Some(format!("In Plan mode, write the plan itself with the plan tool; patch only writes its attachments (files in .agents/plans/<plan-name>/), not '{shown}'.")),
        None => Some(format!(
            "In Plan mode, patch only writes plan attachments: files in .agents/plans/<plan-name>/ (for example a mockup or diagram). '{shown}' is outside it; project files stay unchanged until the plan is approved."
        )),
    }
}

/// Synchronous apply (caller holds path locks). Returns (result text, changed paths).
pub fn apply_patch(denied: &DeniedPaths, patch_text: &str) -> Result<(String, Vec<PathBuf>), ToolError> {
    let patches = parse_patch(patch_text)?;
    let mut original: HashMap<PathBuf, Option<Snap>> = HashMap::new();
    let mut virt: HashMap<PathBuf, Option<VFile>> = HashMap::new();
    let mut touched: Vec<PathBuf> = vec![];
    let mut metadata: Vec<Value> = vec![];
    let load =
        |p: &PathBuf, original: &mut HashMap<PathBuf, Option<Snap>>, virt: &mut HashMap<PathBuf, Option<VFile>>, touched: &mut Vec<PathBuf>| -> Result<Option<VFile>, ToolError> {
            if !virt.contains_key(p) {
                let s = snapshot(p)?;
                virt.insert(p.clone(), s.as_ref().map(|s| VFile { content: s.content.clone(), mode: s.mode }));
                original.insert(p.clone(), s);
                touched.push(p.clone());
            }
            Ok(virt[p].clone())
        };
    for fp in &patches {
        let resolved = denied.validate_path(&fp.path)?;
        let target = match &fp.move_to {
            Some(m) => Some(denied.validate_path(m)?),
            None => None,
        };
        let current = load(&resolved, &mut original, &mut virt, &mut touched)?;
        match fp.kind {
            Kind::Add => {
                if current.is_some() {
                    return Err(verr(format!("Path already exists: {}", denied.display_path(&resolved))));
                }
                virt.insert(resolved.clone(), Some(VFile { content: lines_to_text(&fp.contents).into_bytes(), mode: DEFAULT_FILE_MODE }));
                metadata.push(json!({"path": fp.path, "hunks": [{"old_start": 1, "new_start": 1}]}));
                continue;
            }
            Kind::Delete => {
                if current.is_none() {
                    return Err(verr(format!("File not found: {}{}", denied.display_path(&resolved), denied.absolute_path_hint(&fp.path))));
                }
                virt.insert(resolved.clone(), None);
                continue;
            }
            Kind::Update => {}
        }
        let Some(cur) = current else {
            return Err(verr(format!("File not found: {}{}", denied.display_path(&resolved), denied.absolute_path_hint(&fp.path))));
        };
        let content = String::from_utf8(cur.content.clone()).map_err(|e| verr(format!("'utf-8' codec can't decode byte: {e}")))?;
        let (new_content, hunks) = apply_chunks(&content, &fp.chunks, &fp.path)?;
        let updated = VFile { content: new_content.into_bytes(), mode: cur.mode };
        match target {
            None => {
                virt.insert(resolved.clone(), Some(updated));
            }
            Some(t) if t == resolved => {
                if updated.content == cur.content {
                    return Err(verr(format!("Move for {} has the same path and no content change", fp.path)));
                }
                virt.insert(resolved.clone(), Some(updated));
            }
            Some(t) => {
                if load(&t, &mut original, &mut virt, &mut touched)?.is_some() {
                    return Err(verr(format!("Move destination already exists: {}", denied.display_path(&t))));
                }
                virt.insert(resolved.clone(), None);
                virt.insert(t.clone(), Some(updated));
                if !touched.contains(&t) {
                    touched.push(t);
                }
            }
        }
        metadata.push(json!({"path": fp.path, "hunks": hunks}));
    }
    for p in &touched {
        if is_memory_path(p) {
            if crate::read::ext_of(p) != ".md" {
                return Err(verr(format!("Memory files must have a .md extension: {}", p.file_name().unwrap_or_default().to_string_lossy())));
            }
            if let Some(Some(v)) = virt.get(p) {
                if v.content.len() > MAX_MEMORY_PAGE_BYTES {
                    return Err(verr(format!("Memory page exceeds maximum size of 256 KiB: {} ({} bytes)", p.file_name().unwrap_or_default().to_string_lossy(), v.content.len())));
                }
            }
        }
    }
    let changed: Vec<PathBuf> = touched
        .iter()
        .filter(|p| match (&original[*p], &virt[*p]) {
            (None, None) => false,
            (Some(b), Some(a)) => b.content != a.content || b.mode != a.mode,
            _ => true,
        })
        .cloned()
        .collect();
    let mut staged: Vec<(PathBuf, PathBuf)> = vec![];
    let mut created_dirs: Vec<PathBuf> = vec![];
    let mut applied: Vec<PathBuf> = vec![];
    let result: Result<(), ToolError> = (|| {
        for p in touched.iter().filter(|p| virt[*p].is_some() && changed.contains(p)) {
            let mut parent = p.parent().map(Path::to_path_buf);
            while let Some(pp) = parent {
                if pp.exists() {
                    break;
                }
                created_dirs.push(pp.clone());
                parent = pp.parent().map(Path::to_path_buf);
            }
            let f = virt[p].as_ref().unwrap();
            staged.push((p.clone(), stage_file(p, &f.content, f.mode, is_memory_path(p))?));
        }
        for (p, snap) in &original {
            match snap {
                None => {
                    if p.exists() {
                        return Err(verr(format!("Path changed during patch: {} was created", p.display())));
                    }
                }
                Some(s) => {
                    if !p.is_file() {
                        return Err(verr(format!("Path changed during patch: {} was removed", p.display())));
                    }
                    let c = std::fs::read(p)?;
                    if c != s.content || file_mode(p) != s.mode {
                        return Err(verr(format!("Path changed during patch: {}", p.display())));
                    }
                }
            }
        }
        for p in touched.iter().filter(|p| virt[*p].is_none() && changed.contains(p)) {
            if p.exists() {
                std::fs::remove_file(p)?;
                applied.push(p.clone());
            }
        }
        for (p, tmp) in &staged {
            std::fs::rename(tmp, p)?;
            applied.push(p.clone());
        }
        Ok(())
    })();
    if let Err(e) = result {
        for (_, tmp) in &staged {
            let _ = std::fs::remove_file(tmp);
        }
        for p in applied.iter().rev() {
            match &original[p] {
                None => {
                    let _ = std::fs::remove_file(p);
                }
                Some(s) => {
                    if let Ok(t) = stage_file(p, &s.content, s.mode, is_memory_path(p)) {
                        let _ = std::fs::rename(t, p);
                    }
                }
            }
        }
        created_dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for d in created_dirs {
            let _ = std::fs::remove_dir(d);
        }
        return Err(e);
    }
    tracing::info!("patch_applied files={}", changed.len());
    let summary = changed.iter().map(|p| denied.display_path(p)).collect::<Vec<_>>().join("\n");
    let meta = appv3_core::pyjson::dumps_compact(&json!({"files": metadata}));
    Ok((format!("@@ openagentd-diff-meta {meta}\nPatch applied successfully. Updated paths:\n{summary}"), changed))
}

pub struct PatchTool;

#[async_trait]
impl Tool for PatchTool {
    fn name(&self) -> &str {
        "patch"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("patch", &args);
        let text = match a.raw(&["patch_text", "patch", "text", "content", "diff"]) {
            None => {
                a.err("patch_text", "Field required");
                String::new()
            }
            Some(Value::String(s)) => {
                if let Err(e) = parse_patch(s) {
                    a.err("patch_text", &format!("Value error, {e}"));
                }
                s.clone()
            }
            Some(_) => {
                a.err("patch_text", "Value error, patch_text must be a string.");
                String::new()
            }
        };
        a.finish()?;
        let plan_mode = ctx.metadata.lock().unwrap().get("interaction_mode").and_then(Value::as_str) == Some("plan");
        let mut paths: Vec<PathBuf> = vec![];
        for p in parse_patch(&text)? {
            paths.push(ctx.denied.validate_path(&p.path)?);
            if let Some(m) = &p.move_to {
                paths.push(ctx.denied.validate_path(m)?);
            }
        }
        if plan_mode {
            let memory_root = appv3_core::settings().config_dir.join("memory");
            if let Some(refusal) = paths.iter().find_map(|p| plan_mode_refusal(&ctx.denied.workspace_root, p, &memory_root)) {
                return Err(ToolError::Execution(refusal));
            }
        }
        paths.sort();
        paths.dedup();
        let _guards = appv3_core::acquire_all_locks(&paths).await;
        let denied = ctx.denied.clone();
        let (out, _changed) = tokio::task::spawn_blocking(move || apply_patch(&denied, &text)).await.map_err(ToolError::exec)??;
        Ok(ToolOutput::Text(out))
    }
}

#[cfg(test)]
mod tests;
