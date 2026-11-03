//! The `lsp` navigation tool.
//!
//! Like v2, this tool is not part of the default registry: `lsp` is a
//! context-injected name that no current runtime attaches. It is kept for
//! parity and so a future wiring change needs no new port.

use super::client::path_from_uri;
use super::manager::{lang_for_path, lsp_manager, py_suffix, EXTENSION_TO_LANG};
use super::py_strip;
use crate::args::Args;
use crate::denied::{resolve, DeniedPaths};
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_RESULTS: usize = 50;
const MAX_EXCERPT_CHARS: usize = 120;
const EXCERPT_OPERATIONS: &[&str] = &["go_to_definition", "find_references", "find_implementations"];
const OPERATIONS: &[&str] = &["go_to_definition", "find_references", "document_symbol", "workspace_symbol", "hover", "find_implementations"];

const KEYWORDS: &[&str] = &[
    "import",
    "from",
    "def",
    "class",
    "return",
    "async",
    "await",
    "function",
    "const",
    "let",
    "var",
    "export",
    "struct",
    "interface",
    "package",
    "pub",
    "fn",
    "type",
    "alias",
    "try",
    "except",
    "catch",
    "finally",
    "if",
    "else",
    "for",
    "while",
    "with",
    "as",
    "is",
    "in",
    "and",
    "or",
    "not",
    "pass",
    "raise",
    "yield",
    "lambda",
];

const SYMBOL_KIND_LABELS: &[(i64, &str)] = &[
    (1, "file"),
    (2, "module"),
    (3, "namespace"),
    (4, "package"),
    (5, "class"),
    (6, "method"),
    (7, "property"),
    (8, "field"),
    (9, "constructor"),
    (10, "enum"),
    (11, "interface"),
    (12, "function"),
    (13, "variable"),
    (14, "constant"),
    (15, "string"),
    (16, "number"),
    (17, "boolean"),
    (18, "array"),
    (19, "object"),
    (20, "key"),
    (21, "null"),
    (22, "enum member"),
    (23, "struct"),
    (24, "event"),
    (25, "operator"),
    (26, "type parameter"),
];

fn kind_label(id: i64) -> Option<&'static str> {
    SYMBOL_KIND_LABELS.iter().find(|(k, _)| *k == id).map(|(_, l)| *l)
}

fn ident_rx() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[A-Za-z_][A-Za-z0-9_]*").unwrap())
}

fn py_isspace(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python `str.splitlines()`.
fn splitlines(text: &str) -> Vec<String> {
    crate::read::splitlines_keepends(text)
        .into_iter()
        .map(|l| {
            let l = l.strip_suffix("\r\n").unwrap_or(l);
            let mut chars = l.chars();
            match chars.next_back() {
                Some('\n' | '\r' | '\x0b' | '\x0c' | '\x1c' | '\x1d' | '\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}') => chars.as_str().to_string(),
                _ => l.to_string(),
            }
        })
        .collect()
}

/// `(char_start, char_end, word)` identifier matches on a line.
fn words(line: &str) -> Vec<(usize, usize, String)> {
    ident_rx()
        .find_iter(line)
        .map(|m| {
            let s = line[..m.start()].chars().count();
            (s, s + m.as_str().chars().count(), m.as_str().to_string())
        })
        .collect()
}

fn as_int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) if !n.is_f64() => n.as_i64(),
        Value::Bool(b) => Some(*b as i64),
        _ => None,
    }
}

pub fn parse_kind_filters(kind: &str) -> Option<HashSet<i64>> {
    if kind.is_empty() {
        return None;
    }
    let mut ids = HashSet::new();
    for part in kind.replace('|', ",").split(',') {
        let part = py_strip(part).to_lowercase();
        if part.is_empty() {
            continue;
        }
        if let Some((id, _)) = SYMBOL_KIND_LABELS.iter().find(|(_, l)| *l == part) {
            ids.insert(*id);
        } else {
            for (id, l) in SYMBOL_KIND_LABELS {
                if l.contains(part.as_str()) {
                    ids.insert(*id);
                }
            }
        }
    }
    (!ids.is_empty()).then_some(ids)
}

fn hover_text(contents: Option<&Value>) -> String {
    match contents {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
        Some(Value::Array(a)) => a.iter().map(|i| hover_text(Some(i))).filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    }
}

fn normalize_hover_blocks(blocks: &[String]) -> Vec<String> {
    let mut cleaned: Vec<String> = blocks.iter().map(|b| py_strip(b).to_string()).filter(|b| !b.is_empty()).collect();
    if cleaned.is_empty() {
        return vec![];
    }
    if cleaned.iter().any(|b| !b.contains("Unknown")) {
        cleaned.retain(|b| !b.contains("Unknown") || !b.contains("def "));
    }
    let mut unique: Vec<String> = vec![];
    for b in cleaned {
        if unique.iter().any(|e| e.contains(b.as_str())) {
            continue;
        }
        unique.retain(|e| !b.contains(e.as_str()));
        unique.push(b);
    }
    unique
}

fn extract_reference_role(item: &Value) -> Option<String> {
    let o = item.as_object()?;
    let truthy = |k: &str| o.get(k).map(|v| !super::py_falsy(v)).unwrap_or(false);
    if truthy("isDefinition") {
        return Some("definition".into());
    }
    let role = o.get("role");
    if truthy("isWrite") || role.and_then(Value::as_str) == Some("write") {
        return Some("write".into());
    }
    if truthy("isRead") || role.and_then(Value::as_str) == Some("read") {
        return Some("read".into());
    }
    if let Some(Value::String(r)) = role {
        if !r.is_empty() {
            return Some(r.clone());
        }
    }
    if let Some(Value::String(k)) = o.get("kind") {
        if !k.is_empty() {
            return Some(k.clone());
        }
    }
    None
}

fn source_excerpt(workspace: &Path, display_path: &str, line_no: i64, cache: &mut HashMap<String, Vec<String>>) -> Option<String> {
    let lines = cache.entry(display_path.to_string()).or_insert_with(|| match std::fs::read(workspace.join(display_path)) {
        Ok(b) => splitlines(&String::from_utf8_lossy(&b)),
        Err(_) => vec![],
    });
    if line_no < 1 || line_no as usize > lines.len() {
        return None;
    }
    let text = py_strip(&lines[line_no as usize - 1]).to_string();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() > MAX_EXCERPT_CHARS {
        let head: String = text.chars().take(MAX_EXCERPT_CHARS - 1).collect();
        return Some(format!("{}…", head.trim_end_matches(py_isspace)));
    }
    Some(text)
}

fn match_quality(name: Option<&str>, query: &str) -> Option<String> {
    let name = name?;
    if query.is_empty() {
        return None;
    }
    let (lowered, wanted) = (name.to_lowercase(), query.to_lowercase());
    if lowered == wanted {
        return Some("exact".into());
    }
    if lowered.starts_with(&wanted) {
        return Some("prefix".into());
    }
    None
}

fn read_lines_strict(source: &Path) -> Option<Vec<String>> {
    let b = std::fs::read(source).ok()?;
    Some(splitlines(&String::from_utf8(b).ok()?))
}

fn extract_symbol_at_cursor(source: &Path, line: i64, character: i64) -> Option<String> {
    let lines = read_lines_strict(source)?;
    if line < 1 || line as usize > lines.len() {
        return None;
    }
    let idx = character - 1;
    words(&lines[line as usize - 1]).into_iter().find(|(s, e, _)| (*s as i64) <= idx && idx < *e as i64).map(|(_, _, w)| w)
}

fn diagnose_empty_location(source: &Path, line: i64, character: i64) -> Option<(&'static str, String)> {
    let lines = read_lines_strict(source)?;
    if lines.is_empty() {
        return Some(("file_empty", "file is empty".into()));
    }
    if line > lines.len() as i64 {
        let n = lines.len();
        return Some(("out_of_bounds", format!("line {line} is out of bounds (file has {n} line{})", if n != 1 { "s" } else { "" })));
    }
    let chars: Vec<char> = lines[(line - 1).max(0) as usize].chars().collect();
    let line_str: String = chars.iter().collect();
    let len = chars.len() as i64;
    if character > len + 1 {
        return Some(("out_of_bounds", format!("position {line}:{character} is beyond line length ({len} chars)")));
    }
    let idx = character - 1;
    if idx >= len || py_isspace(chars[idx as usize]) {
        return Some(("whitespace", format!("cursor at line {line}, character {character} is on whitespace")));
    }
    let head: String = chars[..(idx + 1) as usize].iter().collect();
    let head = head.trim_start_matches(py_isspace);
    let before: String = chars[..idx as usize].iter().collect();
    if head.starts_with('#') || head.starts_with("//") || head.starts_with("/*") || before.contains("/*") {
        return Some(("comment", format!("cursor at line {line}, character {character} is inside a comment")));
    }
    for (s, e, w) in words(&line_str) {
        if (s as i64) <= idx && idx < e as i64 {
            if KEYWORDS.contains(&w.as_str()) {
                return Some(("keyword", format!("cursor at line {line}, character {character} is on keyword '{w}'. Place cursor on a symbol identifier.")));
            }
            return Some(("unresolved_symbol", format!("unresolved symbol '{w}' at line {line}, character {character}")));
        }
    }
    Some(("not_symbol", format!("cursor at line {line}, character {character} is outside a supported symbol construct")))
}

fn relative_location(item: &Value, workspace: &Path, denied: &DeniedPaths) -> Option<(String, i64, i64)> {
    let o = item.as_object()?;
    let mut location = o.get("location").cloned().unwrap_or_else(|| item.clone());
    if let Some(t) = o.get("targetUri") {
        let range = o.get("targetSelectionRange").or_else(|| o.get("targetRange")).cloned().unwrap_or_else(|| serde_json::json!({}));
        location = serde_json::json!({"uri": t, "range": range});
    }
    let loc = location.as_object()?;
    let position = loc.get("range").and_then(|r| r.get("start")).cloned().unwrap_or_else(|| serde_json::json!({}));
    let uri = loc.get("uri").and_then(Value::as_str)?;
    if !uri.starts_with("file:") {
        return None;
    }
    let unresolved = path_from_uri(uri).ok()?;
    let path = resolve(&unresolved);
    if !path.starts_with(workspace) || denied.is_denied_path(&unresolved) || denied.is_denied_path(&path) {
        return None;
    }
    let pos = position.as_object()?;
    let (line, ch) = (as_int(pos.get("line"))?, as_int(pos.get("character"))?);
    let rel = path.strip_prefix(workspace).ok()?.to_string_lossy().into_owned();
    Some((if rel.is_empty() { ".".into() } else { rel }, line + 1, ch + 1))
}

fn perm(s: impl Into<String>) -> ToolError {
    ToolError::Execution(s.into())
}

pub struct LspTool;

#[derive(PartialEq, Eq, Hash)]
enum NameOrChar {
    Name(String),
    Char(i64),
}

#[async_trait]
impl Tool for LspTool {
    fn name(&self) -> &str {
        "lsp"
    }

    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("lsp", &args);
        let operation = if a.raw(&["operation"]).is_none() {
            a.err("operation", "Field required");
            String::new()
        } else {
            a.literal(&["operation"], OPERATIONS, "")
        };
        let path = a.req_str(&["path"]);
        let line = a.opt_int(&["line"], Some(1), None).unwrap_or(1);
        let character = a.opt_int(&["character"], Some(1), None).unwrap_or(1);
        let query = a.str_or(&["query"], "");
        let kind = a.str_or(&["kind"], "");
        a.finish()?;
        navigate(ctx, &operation, &path, line, character, &query, &kind).await.map(ToolOutput::Text)
    }
}

async fn navigate(ctx: &ToolContext, operation: &str, path: &str, line: i64, character: i64, query: &str, kind: &str) -> Result<String, ToolError> {
    let Some(ws) = ctx.workspace.as_deref().filter(|w| !w.is_empty()) else {
        return Err(perm("LSP navigation requires a coding workspace"));
    };
    let denied = &ctx.denied;
    let workspace = resolve(&denied.workspace_root);
    if resolve(Path::new(ws)) != workspace {
        return Err(perm("coding workspace is unavailable"));
    }
    if path.is_empty() {
        return Err(perm(format!("path is required for {operation}")));
    }
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() || candidate.components().any(|c| c.as_os_str() == "~") {
        return Err(perm("path is outside the coding workspace"));
    }
    if denied.is_denied_path(&denied.workspace_root.join(&candidate)) {
        return Err(perm(format!("Path '{path}' is inside a denied path")));
    }
    let source = denied.validate_path(path)?;
    if !source.starts_with(&workspace) {
        return Err(perm("path is outside the coding workspace"));
    }
    if source.is_dir() {
        return Err(perm(format!("Expected a source file, received a directory: '{path}'")));
    }
    if !source.is_file() {
        return Err(perm(format!("File not found: {path}. Paths are workspace-relative — use glob to locate the file first.")));
    }
    if lang_for_path(&source).is_none() {
        let mut exts: Vec<&str> = EXTENSION_TO_LANG.iter().map(|(e, _)| *e).collect();
        exts.sort();
        return Ok(format!("No language server support for '{}' files. Supported extensions: {}.", py_suffix(&source).unwrap_or_default(), exts.join(", ")));
    }
    let results = lsp_manager().navigation(operation, &workspace, Some(&source), line - 1, character - 1, query).await;

    if operation == "hover" {
        let raw: Vec<String> =
            results.iter().map(|item| py_strip(&hover_text(if item.is_object() { item.get("contents") } else { Some(item) })).to_string()).filter(|t| !t.is_empty()).collect();
        let blocks = normalize_hover_blocks(&raw);
        if !blocks.is_empty() {
            return Ok(blocks.join("\n\n---\n\n"));
        }
        let diag = diagnose_empty_location(&source, line, character);
        if let Some((_, msg)) = &diag {
            if !msg.contains("unresolved symbol") {
                return Ok(format!("No hover information available: {msg}."));
            }
        }
        return Ok("No hover information available.".into());
    }

    let kind_filters = parse_kind_filters(kind);
    let supports_kind = operation == "document_symbol" || operation == "workspace_symbol";
    let rel_source = source.strip_prefix(&workspace).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
    let mut excerpts: HashMap<String, Vec<String>> = HashMap::new();
    let mut seen: HashSet<(String, i64, NameOrChar, Option<String>)> = HashSet::new();
    let mut entries: Vec<((i64, i64, String), String)> = vec![];
    for item in &results {
        let Some((display, line_no, char_no)) = relative_location(item, &workspace, denied) else {
            continue;
        };
        let name = item.get("name").and_then(Value::as_str).map(String::from);
        let item_kind = item.get("kind");
        if supports_kind {
            if let Some(f) = &kind_filters {
                let k = item_kind.and_then(|k| match k {
                    Value::Number(n) => n.as_f64().filter(|x| x.fract() == 0.0).map(|x| x as i64),
                    Value::Bool(b) => Some(*b as i64),
                    _ => None,
                });
                if !k.map(|k| f.contains(&k)).unwrap_or(false) {
                    continue;
                }
            }
        }
        let label = as_int(item_kind).and_then(kind_label);
        let role = match operation {
            "find_references" => extract_reference_role(item),
            "go_to_definition" if display == rel_source && line_no == line && char_no == character => Some("definition".into()),
            "workspace_symbol" => match_quality(name.as_deref(), query),
            _ => None,
        };
        let role_tag = role.as_ref().map(|r| format!(" [{r}]")).unwrap_or_default();
        let mut line_text = match &name {
            Some(n) => {
                let l = match label {
                    Some(k) => format!("{n} ({k})"),
                    None => n.clone(),
                };
                format!("{l}{role_tag} | {display}:{line_no}:{char_no}")
            }
            None => format!("{display}:{line_no}:{char_no}"),
        };
        if EXCERPT_OPERATIONS.contains(&operation) {
            if let Some(ex) = source_excerpt(&workspace, &display, line_no, &mut excerpts) {
                line_text = format!("{line_text} | {ex}");
            }
        }
        let key = (display.clone(), line_no, name.clone().map(NameOrChar::Name).unwrap_or(NameOrChar::Char(char_no)), role.clone());
        if !seen.insert(key) {
            continue;
        }
        let sort_key = match operation {
            "document_symbol" => (line_no, char_no, String::new()),
            "workspace_symbol" => {
                let rank = match role.as_deref() {
                    Some("exact") => 0,
                    Some("prefix") => 1,
                    _ => 2,
                };
                (rank, 0, line_text.clone())
            }
            _ => (0, 0, line_text.clone()),
        };
        entries.push((sort_key, line_text));
    }

    if operation == "go_to_definition" && entries.len() == 1 {
        let (dp, ln, cn) = relative_location(&results[0], &workspace, denied).unwrap_or_default();
        if dp == rel_source && ln == line && cn == character {
            let sym = results[0].get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).or_else(|| extract_symbol_at_cursor(&source, line, character));
            let sym_str = sym.map(|s| format!("'{s}' ")).unwrap_or_default();
            return Ok(format!("No definition found: Symbol {sym_str}at line {line}, character {character} is already at its definition site."));
        }
    }

    if entries.is_empty() {
        let diag = diagnose_empty_location(&source, line, character);
        let human = diag.as_ref().map(|d| d.1.clone()).unwrap_or_else(|| "No results.".into());
        if operation == "find_implementations" {
            if let Some((code, _)) = &diag {
                if *code != "unresolved_symbol" {
                    return Ok(format!("No results: {human}."));
                }
            }
            let sym = extract_symbol_at_cursor(&source, line, character);
            let sym_str = sym.map(|s| format!("symbol '{s}'")).unwrap_or_else(|| format!("position {line}:{character}"));
            return Ok(format!("No results: {sym_str} is not an interface, abstract class, or overridable member."));
        }
        if (operation == "go_to_definition" || operation == "find_references") && diag.is_some() {
            return Ok(format!("No results: {human}."));
        }
        return Ok("No results.".into());
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let total = entries.len();
    let mut shown: Vec<String> = entries.into_iter().take(MAX_RESULTS).map(|(_, t)| t).collect();
    if total > MAX_RESULTS {
        shown.push(format!(
            "… truncated: showing {MAX_RESULTS} of {total} results ({} omitted). Narrow the search with 'kind', a more specific query, or grep.",
            total - MAX_RESULTS
        ));
    }
    Ok(shown.join("\n"))
}
