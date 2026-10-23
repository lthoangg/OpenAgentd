//! `glob` — port of `filesystem/glob.py`.

use crate::args::Args;
use crate::grep::{is_gitignored, is_searchable_ignored_dir, load_gitignore, skipped_ignored_note, Ignores, NOISE_DIR_NAMES};
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use globset::{GlobBuilder, GlobMatcher};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const MAX_BRACE_VARIANTS: usize = 64;
const GLOB_TIMEOUT_S: u64 = 10;

pub fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let bytes: Vec<char> = pattern.chars().collect();
    let cstart = pattern[..start].chars().count();
    let mut depth = 0;
    let mut end = None;
    for (i, c) in bytes.iter().enumerate().skip(cstart) {
        if *c == '{' {
            depth += 1;
        } else if *c == '}' {
            depth -= 1;
            if depth == 0 {
                end = Some(i);
                break;
            }
        }
    }
    let Some(end) = end else {
        return vec![pattern.to_string()];
    };
    let prefix: String = bytes[..cstart].iter().collect();
    let body: Vec<char> = bytes[cstart + 1..end].to_vec();
    let suffix: String = bytes[end + 1..].iter().collect();
    let mut options = vec![];
    let mut cur = String::new();
    let mut d = 0;
    for c in body {
        if c == '{' {
            d += 1;
        } else if c == '}' {
            d -= 1;
        }
        if c == ',' && d == 0 {
            options.push(std::mem::take(&mut cur));
            continue;
        }
        cur.push(c);
    }
    options.push(cur);
    if options.len() == 1 {
        return vec![pattern.to_string()];
    }
    let mut out: Vec<String> = vec![];
    for o in options {
        for e in expand_braces(&format!("{prefix}{o}{suffix}")) {
            if !out.contains(&e) {
                out.push(e);
            }
            if out.len() >= MAX_BRACE_VARIANTS {
                return out;
            }
        }
    }
    out
}

fn matcher(p: &str) -> Option<GlobMatcher> {
    GlobBuilder::new(p).literal_separator(true).backslash_escape(true).build().ok().map(|g| g.compile_matcher())
}

/// Visible paths first, then dot paths, then gitignored ones.
fn rank(c: &Cand) -> (bool, bool, String) {
    (c.ignored, c.rel.split('/').any(|p| p.starts_with('.')), c.rel.clone())
}

fn has_wildcard(s: &str) -> bool {
    s.contains(['*', '?', '[', ']'])
}

fn literal_prefix(p: &str) -> Vec<String> {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    let mut out = vec![];
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 || has_wildcard(part) {
            break;
        }
        out.push(part.to_string());
    }
    out
}

fn shared_prefix(prefixes: &[Vec<String>]) -> Vec<String> {
    let Some(first) = prefixes.first() else {
        return vec![];
    };
    let mut out = vec![];
    for (i, seg) in first.iter().enumerate() {
        if prefixes.iter().all(|p| p.get(i) == Some(seg)) {
            out.push(seg.clone());
        } else {
            break;
        }
    }
    out
}

/// A candidate file: its path relative to the search directory, its path,
/// and whether it is gitignored.
#[derive(Clone, Debug, PartialEq)]
struct Cand {
    rel: String,
    path: PathBuf,
    ignored: bool,
}

/// What a walk found.
struct Walked {
    files: Vec<Cand>,
    timed_out: bool,
    /// Big gitignored directories left out, relative to the search directory.
    skipped: Vec<String>,
}

/// Shared state of one parallel walk.
struct Walk<'a> {
    base: &'a Path,
    allowed_noise: &'a BTreeSet<String>,
    expired: &'a (dyn Fn() -> bool + Sync),
    timed_out: AtomicBool,
    skipped: Mutex<Vec<String>>,
}

/// Every file under `root` (noise directories aside), in depth-first order.
/// With `gi`, gitignored files are flagged `ignored`, and gitignored
/// directories are walked only when small enough to be more than build
/// output (see [`is_searchable_ignored_dir`]); without it (a walk that starts
/// inside an ignored directory) everything is flagged and walked. Directories
/// are read in parallel: the walk is mostly `readdir` syscalls, and results
/// are ranked and sorted afterwards anyway. Stops descending once `expired`.
fn walk_files(root: &Path, base: &Path, gi: Option<&Ignores>, allowed_noise: &BTreeSet<String>, expired: &(dyn Fn() -> bool + Sync)) -> Walked {
    let w = Walk { base, allowed_noise, expired, timed_out: AtomicBool::new(false), skipped: Mutex::default() };
    let files = walk_dir(&w, root, gi, gi.is_none());
    let mut skipped = w.skipped.into_inner().unwrap_or_default();
    skipped.sort();
    Walked { files, timed_out: w.timed_out.into_inner(), skipped }
}

/// `gi` is `None` inside an ignored directory, where `ignored` is set.
fn walk_dir(w: &Walk, dir: &Path, gi: Option<&Ignores>, ignored: bool) -> Vec<Cand> {
    use rayon::prelude::*;
    if (w.expired)() {
        w.timed_out.store(true, Ordering::Relaxed);
        return vec![];
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let rel_dir = dir.strip_prefix(w.base).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let join = |n: &str| {
        if rel_dir.is_empty() {
            n.to_string()
        } else {
            format!("{rel_dir}/{n}")
        }
    };
    let mut dirs = vec![];
    let mut files = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        match e.file_type() {
            Ok(t) if t.is_dir() => dirs.push(name),
            Ok(_) => files.push(name),
            Err(_) => {}
        }
    }
    files.sort();
    let mut found: Vec<Cand> = files
        .into_iter()
        .map(|f| {
            let rel = join(&f);
            let ignored = ignored || gi.is_some_and(|gi| gi.matched(&rel, false));
            Cand { rel, path: dir.join(&f), ignored }
        })
        .collect();
    let mut kept: Vec<(String, bool)> = vec![];
    for d in dirs.into_iter().filter(|d| !NOISE_DIR_NAMES.contains(&d.as_str()) || w.allowed_noise.contains(d)) {
        let rel = join(&d);
        if !gi.is_some_and(|gi| gi.matched(&rel, true)) {
            kept.push((d, false));
        } else if is_searchable_ignored_dir(&dir.join(&d)) {
            kept.push((d, true));
        } else {
            w.skipped.lock().unwrap().push(rel);
        }
    }
    kept.sort_by(|(a, _), (b, _)| (a.starts_with('.'), a).cmp(&(b.starts_with('.'), b)));
    let subs: Vec<Vec<Cand>> =
        kept.par_iter().map(|(d, now_ignored)| if *now_ignored { walk_dir(w, &dir.join(d), None, true) } else { walk_dir(w, &dir.join(d), gi, ignored) }).collect();
    found.extend(subs.into_iter().flatten());
    found
}

/// The tool's text, noting when the walk stopped early.
fn partial_note(mut text: String, timed_out: bool) -> String {
    if timed_out {
        text.push_str(&format!("\n\n[glob stopped after {GLOB_TIMEOUT_S}s: these results are partial. Narrow the directory or pattern for a complete list.]"));
    }
    text
}

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "glob"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("glob", &args);
        let pattern = a.req_str(&["pattern", "glob"]);
        let directory = a.str_or(&["directory", "dir", "path"], ".");
        let mode = a.literal(&["match"], &["path", "name"], "path");
        let max_results = a.opt_int(&["max_results"], Some(1), None).unwrap_or(200) as usize;
        a.finish()?;
        let denied = ctx.denied.clone();
        let resolved = denied.validate_read_path(&directory)?;
        if !resolved.is_dir() {
            return Err(ToolError::Execution(format!("Not a directory: {}{}", denied.display_path(&resolved), denied.absolute_path_hint(&directory))));
        }
        if mode == "path" {
            if Path::new(&pattern).is_absolute() || pattern.starts_with('/') {
                return Err(ToolError::Execution(format!("Pattern must be relative to the search directory: {}", crate::py_repr_str(&pattern))));
            }
            if pattern.split('/').any(|p| p == "..") {
                return Err(ToolError::Execution(format!(
                    "'..' is not allowed in a pattern: {} — pass the 'directory' argument to search somewhere else.",
                    crate::py_repr_str(&pattern)
                )));
            }
        }
        let pat = pattern.clone();
        let (hits, dir_hints, timed_out, skipped) = tokio::task::spawn_blocking(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(GLOB_TIMEOUT_S);
            let gi = load_gitignore(&resolved);
            let variants = expand_braces(&pat);
            let allowed_noise: BTreeSet<String> =
                variants.iter().flat_map(|v| v.split('/').map(String::from).collect::<Vec<_>>()).filter(|s| NOISE_DIR_NAMES.contains(&s.as_str()) && s != ".git").collect();
            let prefix = if mode == "path" { shared_prefix(&variants.iter().map(|v| literal_prefix(v)).collect::<Vec<_>>()) } else { vec![] };
            let walk_root = prefix.iter().fold(resolved.clone(), |p, s| p.join(s));
            // A pattern that names a path inside a gitignored directory
            // (`target/doc/**`) searches it whatever its size.
            let mut in_ignored = false;
            if !prefix.is_empty() {
                let mut rel = String::new();
                for seg in &prefix {
                    rel = if rel.is_empty() { seg.clone() } else { format!("{rel}/{seg}") };
                    if NOISE_DIR_NAMES.contains(&seg.as_str()) && !allowed_noise.contains(seg) {
                        return (vec![], vec![], false, vec![]);
                    }
                    in_ignored |= is_gitignored(&gi, &rel, true);
                }
            }
            if !walk_root.is_dir() {
                return (vec![], vec![], false, vec![]);
            }
            let Walked { files: cands, timed_out, skipped } =
                walk_files(&walk_root, &resolved, (!in_ignored).then_some(&gi), &allowed_noise, &|| std::time::Instant::now() > deadline);
            let select = |pats: &[String]| -> Vec<Cand> {
                let mut hit: Vec<Cand> = if mode == "name" {
                    let rxs: Vec<regex::Regex> = pats.iter().filter_map(|p| regex::Regex::new(&crate::denied::fnmatch_translate(p)).ok()).collect();
                    cands.iter().filter(|c| rxs.iter().any(|r| r.is_match(&c.path.file_name().unwrap_or_default().to_string_lossy()))).cloned().collect()
                } else if pats.iter().any(|p| p.ends_with('/')) {
                    vec![]
                } else {
                    let ms: Vec<GlobMatcher> = pats.iter().filter_map(|p| matcher(p)).collect();
                    cands.iter().filter(|c| ms.iter().any(|m| m.is_match(&c.rel))).cloned().collect()
                };
                hit.sort_by_cached_key(rank);
                hit
            };
            let mut matched = select(&variants);
            if matched.is_empty() {
                let widened: Vec<String> = variants.iter().filter(|p| !p.contains('/') && !p.starts_with("**")).map(|p| format!("**/{p}")).collect();
                if !widened.is_empty() {
                    matched = select(&widened);
                }
            }
            let mut hits = vec![];
            for Cand { path: p, .. } in matched {
                if !p.is_file() || denied.is_denied_read_path(&p) {
                    continue;
                }
                hits.push(denied.display_path(&p));
                if hits.len() >= max_results {
                    break;
                }
            }
            if !hits.is_empty() || mode == "name" {
                return (hits, vec![], timed_out, skipped);
            }
            let mut dirs: BTreeSet<String> = BTreeSet::new();
            for c in &cands {
                let parts: Vec<&str> = c.rel.split('/').collect();
                for i in 1..parts.len() {
                    dirs.insert(parts[..i].join("/"));
                }
            }
            let ms: Vec<GlobMatcher> = variants.iter().filter_map(|p| matcher(p)).collect();
            (hits, dirs.into_iter().filter(|d| ms.iter().any(|m| m.is_match(d))).collect(), timed_out, skipped)
        })
        .await
        .map_err(ToolError::exec)?;
        if hits.is_empty() {
            let miss = format!("No files matching '{pattern}' in {}{}", ctx.denied.display_path(&ctx.denied.validate_read_path(&directory)?), skipped_ignored_note(&skipped));
            if !dir_hints.is_empty() {
                let named = dir_hints.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
                return Ok(ToolOutput::Text(partial_note(format!("{miss}; it matches directories ({named}) — use '{}/**' to list files inside", dir_hints[0]), timed_out)));
            }
            return Ok(ToolOutput::Text(partial_note(miss, timed_out)));
        }
        Ok(ToolOutput::Text(partial_note(hits.join("\n"), timed_out)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn braces_expand() {
        assert_eq!(expand_braces("src/**/*.{ts,tsx}"), vec!["src/**/*.ts", "src/**/*.tsx"]);
        assert_eq!(expand_braces("b{.py,}"), vec!["b.py", "b"]);
        assert_eq!(expand_braces("x{"), vec!["x{"]);
    }

    #[test]
    fn globs_like_pathlib() {
        let m = matcher("**/*.py").unwrap();
        assert!(m.is_match("a.py"));
        assert!(m.is_match("a/b/c.py"));
        let m = matcher("src/*.py").unwrap();
        assert!(!m.is_match("src/a/b.py"));
    }

    fn glob_tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for f in ["b.txt", "a.txt", ".hidden/c.txt", "sub/d.txt", "sub/deep/e.txt", "node_modules/x.txt", "ignored.txt", "src/m.rs", "src/n.rs"] {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        std::fs::write(d.path().join(".gitignore"), "ignored.txt\n").unwrap();
        d
    }

    async fn glob(ws: &Path, args: Value) -> Vec<String> {
        let ctx = crate::ToolContext {
            session_id: None,
            agent_name: "t".into(),
            tool_call_id: "c".into(),
            denied: std::sync::Arc::new(crate::denied::DeniedPaths::with(ws, None, Some(vec![]), Some(vec![]))),
            workspace: None,
            output: None,
            metadata: Default::default(),
            messages: None,
        };
        match GlobTool.run(&ctx, args).await.unwrap() {
            ToolOutput::Text(t) => t.lines().map(|l| l.replace('\\', "/")).collect(),
            o => panic!("{o:?}"),
        }
    }

    #[tokio::test]
    async fn ranks_visible_paths_first_and_honours_max() {
        let d = glob_tree();
        let all = glob(d.path(), serde_json::json!({"pattern": "**/*.txt"})).await;
        assert_eq!(all, ["a.txt", "b.txt", "sub/d.txt", "sub/deep/e.txt", ".hidden/c.txt", "ignored.txt"]);
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "**/*.txt", "max_results": 2})).await, ["a.txt", "b.txt"]);
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "src/*.{rs,txt}"})).await, ["src/m.rs", "src/n.rs"]);
    }

    #[tokio::test]
    async fn widens_bare_names_and_opens_named_noise_dirs() {
        let d = glob_tree();
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "e.txt"})).await, ["sub/deep/e.txt"]);
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "node_modules/*.txt"})).await, ["node_modules/x.txt"]);
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "c.txt", "match": "name"})).await, [".hidden/c.txt"]);
    }

    #[tokio::test]
    async fn misses_name_matching_directories() {
        let d = glob_tree();
        let miss = glob(d.path(), serde_json::json!({"pattern": "missing.txt"})).await;
        assert!(miss[0].starts_with("No files matching 'missing.txt'"), "{miss:?}");
        let dirs = glob(d.path(), serde_json::json!({"pattern": "s*"})).await;
        assert!(dirs[0].contains("it matches directories (src, sub)") && dirs[0].contains("use 'src/**'"), "{dirs:?}");
    }

    #[tokio::test]
    async fn finds_gitignored_files_but_skips_big_ignored_dirs_unless_named() {
        let d = glob_tree();
        std::fs::write(d.path().join(".gitignore"), "ignored.txt\nout/\ntarget/\n").unwrap();
        std::fs::create_dir_all(d.path().join("out")).unwrap();
        std::fs::write(d.path().join("out/clip.mp4"), "x").unwrap();
        std::fs::create_dir_all(d.path().join("target/debug")).unwrap();
        for i in 0..=crate::grep::MAX_IGNORED_DIR_FILES {
            std::fs::write(d.path().join(format!("target/debug/f{i}.o")), "x").unwrap();
        }
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "ignored.txt"})).await, ["ignored.txt"]);
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "**/*.mp4"})).await, ["out/clip.mp4"]);
        let miss = glob(d.path(), serde_json::json!({"pattern": "**/*.o"})).await;
        assert!(miss[0].contains("skipped large gitignored directories: target/"), "{miss:?}");
        assert_eq!(glob(d.path(), serde_json::json!({"pattern": "target/debug/f1.o"})).await, ["target/debug/f1.o"]);
    }

    #[tokio::test]
    async fn a_nested_gitignore_ranks_its_files_as_ignored() {
        let d = glob_tree();
        std::fs::write(d.path().join("sub/.gitignore"), "d.txt\n").unwrap();
        let all = glob(d.path(), serde_json::json!({"pattern": "**/*.txt"})).await;
        assert_eq!(all, ["a.txt", "b.txt", "sub/deep/e.txt", ".hidden/c.txt", "ignored.txt", "sub/d.txt"]);
    }

    #[test]
    fn a_timed_out_walk_keeps_what_it_found() {
        let d = glob_tree();
        let gi = load_gitignore(d.path());
        let Walked { files: all, timed_out, .. } = walk_files(d.path(), d.path(), Some(&gi), &BTreeSet::new(), &|| false);
        assert!(!timed_out);
        assert_eq!(all.len(), 9, "{all:?}");
        assert_eq!(all.iter().filter(|c| c.ignored).map(|c| c.rel.as_str()).collect::<Vec<_>>(), ["ignored.txt"]);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let Walked { files: partial, timed_out, .. } =
            walk_files(d.path(), d.path(), Some(&gi), &BTreeSet::new(), &|| calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 2);
        assert!(timed_out);
        assert!(!partial.is_empty() && partial.len() < all.len(), "{partial:?}");
        assert!(partial.iter().all(|p| all.contains(p)));
        assert_eq!(
            partial_note("a.txt".into(), true),
            format!("a.txt\n\n[glob stopped after {GLOB_TIMEOUT_S}s: these results are partial. Narrow the directory or pattern for a complete list.]")
        );
        assert_eq!(partial_note("a.txt".into(), false), "a.txt");
    }
}
