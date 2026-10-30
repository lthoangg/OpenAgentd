//! `grep` — port of `filesystem/grep.py` (+ `_ignore.py`).

use crate::args::Args;
use crate::denied::fnmatch_translate;
use crate::denied::DeniedPaths;
pub use crate::ignores::Ignores;
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const NOISE_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".tox",
    ".nox",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".gradle",
    ".terraform",
];
const MAX_PATTERN_LEN: usize = 500;
const SCAN_TIMEOUT_S: u64 = 10;
const BINARY_SNIFF_BYTES: usize = 4096;
/// Files are read this much at a time (rounded to whole lines), so a large
/// log costs ~1 MB per scanning thread instead of several times its size.
const SCAN_CHUNK_BYTES: usize = 1 << 20;
/// A gitignored directory holding more files than this is build output or a
/// cache (`target/`, `dist/`): `grep` and `glob` skip it unless asked to
/// search inside it. Smaller ignored directories (`out/`, local notes) and
/// ignored files are searched, after the visible tree.
pub const MAX_IGNORED_DIR_FILES: usize = 500;

/// Git's ignore rules for a search rooted at `root`: nested `.gitignore`s,
/// the ones above it up to the repository root, `.git/info/exclude` and the
/// global excludes file (see [`Ignores`]).
pub fn load_gitignore(root: &Path) -> Ignores {
    Ignores::load(root)
}

/// Whether `rel` (relative to the search root) or a directory above it is
/// gitignored.
pub fn is_gitignored(gi: &Ignores, rel: &str, is_dir: bool) -> bool {
    gi.matched_or_any_parent(rel, is_dir)
}

/// Whether the gitignored directory `dir` is small enough to search: at most
/// [`MAX_IGNORED_DIR_FILES`] files outside noise directories. Counts with
/// `readdir` alone and stops at the limit, so a huge `target/` costs little.
pub fn is_searchable_ignored_dir(dir: &Path) -> bool {
    let mut files = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if !NOISE_DIR_NAMES.contains(&e.file_name().to_string_lossy().as_ref()) {
                        stack.push(e.path());
                    }
                }
                Ok(_) => {
                    files += 1;
                    if files > MAX_IGNORED_DIR_FILES {
                        return false;
                    }
                }
                Err(_) => {}
            }
        }
    }
    true
}

/// A no-match message's note naming the big gitignored directories skipped.
pub fn skipped_ignored_note(skipped: &[String]) -> String {
    if skipped.is_empty() {
        return String::new();
    }
    let named = skipped.iter().take(3).map(|d| format!("{d}/")).collect::<Vec<_>>().join(", ");
    let more = if skipped.len() > 3 { format!(" and {} more", skipped.len() - 3) } else { String::new() };
    format!(" (skipped large gitignored directories: {named}{more} — pass one as 'directory' to search inside it)")
}

/// A compiled grep pattern with Python `re.search` semantics per line.
///
/// Patterns the linear-time `regex` crate accepts run on it (no
/// catastrophic backtracking, whole-file prefilter). Patterns that need
/// lookaround or backreferences fall back to `fancy_regex`, whose
/// backtracking is bounded by its step limit.
pub enum Matcher {
    /// `needs_nl`: the pattern can match the line's own `\n` (see
    /// [`can_use_trailing_newline`]), so a line that fails is tried again
    /// with it.
    Linear {
        line: regex::Regex,
        prefilter: Option<regex::bytes::Regex>,
        needs_nl: bool,
    },
    Fancy(fancy_regex::Regex),
}

impl Matcher {
    fn is_match(&self, text: &str) -> bool {
        match self {
            Matcher::Linear { line, .. } => line.is_match(text),
            Matcher::Fancy(rx) => rx.is_match(text).unwrap_or(false),
        }
    }

    fn needs_trailing_newline(&self) -> bool {
        match self {
            Matcher::Linear { needs_nl, .. } => *needs_nl,
            Matcher::Fancy(_) => true,
        }
    }

    /// Cheap whole-file check; `false` only if no line can match.
    fn may_match_file(&self, data: &[u8]) -> bool {
        match self {
            Matcher::Linear { prefilter: Some(pf), .. } => std::str::from_utf8(data).is_err() || pf.is_match(data),
            _ => true,
        }
    }
}

pub fn compile_pattern(pattern: &str) -> Result<Matcher, ToolError> {
    if pattern.chars().count() > MAX_PATTERN_LEN {
        return Err(ToolError::Execution(format!(
            "Pattern too long ({} chars, max {MAX_PATTERN_LEN}). Split a long a|b|c alternation into several grep calls, or search a shorter distinctive substring",
            pattern.chars().count()
        )));
    }
    if let Ok(line) = regex::Regex::new(pattern) {
        // Multi-line form over the whole (newline-normalised) file: every
        // per-line match is also a match here, except for anchors that mean
        // "start/end of text", which then skip the prefilter.
        let anchored = ["\\A", "\\z", "\\Z"].iter().any(|a| pattern.contains(a));
        let prefilter = if anchored { None } else { regex::bytes::Regex::new(&format!("(?m:{pattern})")).ok() };
        return Ok(Matcher::Linear { line, prefilter, needs_nl: can_use_trailing_newline(pattern) });
    }
    fancy_regex::Regex::new(pattern).map(Matcher::Fancy).map_err(|e| ToolError::Execution(format!("Invalid regex: {e}")))
}

/// Whether matching `line + "\n"` can succeed where `line` alone fails:
/// only if the pattern can match a `\n` itself (a literal, `\s`, a negated
/// class, `(?s).`) or uses multi-line `^`/`$`, which can match around it.
/// Other assertions see `\n` and end-of-text alike. Unparsable: assume yes.
fn can_use_trailing_newline(pattern: &str) -> bool {
    use regex_syntax::hir::{Class, Hir, HirKind, Look};
    fn walk(h: &Hir) -> bool {
        match h.kind() {
            HirKind::Empty => false,
            HirKind::Literal(l) => l.0.contains(&b'\n'),
            HirKind::Class(Class::Unicode(c)) => c.ranges().iter().any(|r| r.start() <= '\n' && '\n' <= r.end()),
            HirKind::Class(Class::Bytes(c)) => c.ranges().iter().any(|r| r.start() <= b'\n' && b'\n' <= r.end()),
            HirKind::Look(l) => matches!(l, Look::StartLF | Look::EndLF | Look::StartCRLF | Look::EndCRLF),
            HirKind::Repetition(r) => walk(&r.sub),
            HirKind::Capture(c) => walk(&c.sub),
            HirKind::Concat(hs) | HirKind::Alternation(hs) => hs.iter().any(walk),
        }
    }
    regex_syntax::parse(pattern).map(|h| walk(&h)).unwrap_or(true)
}

/// Python universal newlines: `\r\n` and lone `\r` become `\n`.
fn normalise_newlines(data: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    if memchr::memchr(b'\r', data).is_none() {
        return std::borrow::Cow::Borrowed(data);
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b == b'\r' {
            out.push(b'\n');
            if data.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
        } else {
            out.push(b);
        }
        i += 1;
    }
    std::borrow::Cow::Owned(out)
}

/// Search one file like v2 (`TextIOWrapper(errors="replace")` +
/// `compiled.search(line)`, where `line` keeps its `\n`). Returns hits in
/// line order, at most `max`.
fn scan_file(m: &Matcher, fpath: &Path, display: &str, max: usize) -> Vec<String> {
    match std::fs::File::open(fpath) {
        Ok(f) => scan_reader(m, f, display, max, SCAN_CHUNK_BYTES),
        Err(_) => vec![],
    }
}

/// Where a chunk can end: after its last `\n`, or after a lone `\r` (one
/// not at the very end, which may be the first half of `\r\n`). At EOF,
/// everything left.
fn chunk_cut(buf: &[u8], eof: bool) -> Option<usize> {
    if eof {
        return Some(buf.len());
    }
    if let Some(i) = memchr::memrchr(b'\n', buf) {
        return Some(i + 1);
    }
    memchr::memrchr(b'\r', &buf[..buf.len().saturating_sub(1)]).map(|i| i + 1)
}

/// [`scan_file`] over any reader, `chunk` bytes at a time. Chunks hold whole
/// lines, so the per-chunk prefilter and the line numbers match a scan of
/// the whole file; reading stops at `max` hits.
fn scan_reader(m: &Matcher, mut r: impl Read, display: &str, max: usize, chunk: usize) -> Vec<String> {
    let mut hits = vec![];
    let mut buf: Vec<u8> = Vec::new();
    let mut line_no = 0usize;
    let mut first = true;
    let mut with_nl = String::new();
    loop {
        let want = if first { chunk.max(BINARY_SNIFF_BYTES) } else { chunk };
        let n = match r.by_ref().take(want as u64).read_to_end(&mut buf) {
            Ok(n) => n,
            Err(_) => return hits,
        };
        if first {
            if buf[..buf.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
                return hits;
            }
            first = false;
        }
        let eof = n == 0;
        let Some(cut) = chunk_cut(&buf, eof) else { continue };
        let region = normalise_newlines(&buf[..cut]);
        if !m.may_match_file(&region) {
            line_no += memchr::memchr_iter(b'\n', &region).count() + usize::from(eof && !region.is_empty() && !region.ends_with(b"\n"));
        } else {
            let text = String::from_utf8_lossy(&region);
            let ends_with_nl = text.ends_with('\n');
            let mut lines: Vec<&str> = text.split('\n').collect();
            if ends_with_nl || text.is_empty() {
                lines.pop();
            }
            let last = lines.len().saturating_sub(1);
            for (i, line) in lines.iter().enumerate() {
                line_no += 1;
                let has_nl = i < last || ends_with_nl;
                // `$` in Python also matches before the final `\n`; patterns
                // that consume the newline (`\s$`, `\n`) need the line with it.
                let hit = m.is_match(line)
                    || (has_nl && m.needs_trailing_newline() && {
                        with_nl.clear();
                        with_nl.push_str(line);
                        with_nl.push('\n');
                        m.is_match(&with_nl)
                    });
                if hit {
                    let shown: String = line.trim_end().chars().take(200).collect();
                    hits.push(format!("{display}:{line_no}: {shown}"));
                    if hits.len() >= max {
                        return hits;
                    }
                }
            }
        }
        drop(region);
        buf.drain(..cut);
        if eof {
            return hits;
        }
    }
}

/// Why a search stopped before walking everything.
enum Stop {
    Full,
    TimedOut,
}

/// One tree search: the files found so far wait in `pending` and are
/// scanned in parallel `batch`es into `hits`.
struct Scan<'a> {
    root: &'a Path,
    include: &'a regex::Regex,
    denied: &'a DeniedPaths,
    m: &'a Matcher,
    max: usize,
    batch: usize,
    expired: &'a dyn Fn() -> bool,
    hits: Vec<String>,
    pending: Vec<PathBuf>,
    /// Big gitignored directories left out, relative to `root`.
    skipped: Vec<String>,
}

impl Scan<'_> {
    fn queue(&mut self, fp: PathBuf) {
        if !self.denied.is_denied_read_path(&fp) {
            self.pending.push(fp);
        }
    }

    fn flush_if_ready(&mut self) -> Result<(), Stop> {
        if self.pending.len() >= self.batch {
            if scan_batch(self.m, &self.pending, self.denied, self.max, &mut self.hits) {
                return Err(Stop::Full);
            }
            self.pending.clear();
            if (self.expired)() {
                return Err(Stop::TimedOut);
            }
        }
        Ok(())
    }

    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(self.root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
    }

    /// Walk `start` like v2's `os.walk` (a directory's files, then its
    /// subdirectories, depth first, names sorted). With `gi`, gitignored
    /// files and directories go to `ignored` (`true` for a directory) in
    /// walk order instead of being searched now.
    fn walk(&mut self, start: &Path, gi: Option<&Ignores>, ignored: &mut Vec<(PathBuf, bool)>) -> Result<(), Stop> {
        let mut stack = vec![start.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if (self.expired)() {
                return Err(Stop::TimedOut);
            }
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut dirs = vec![];
            let mut files = vec![];
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                // os.walk follows neither dir symlinks; file symlinks count as files
                let name = e.file_name().to_string_lossy().to_string();
                if ft.is_dir() {
                    dirs.push(name);
                } else if ft.is_file() || (ft.is_symlink() && e.path().is_file()) {
                    files.push(name);
                }
            }
            files.sort();
            dirs.sort();
            let rel_dir = self.rel(&dir);
            let join = |n: &str| if rel_dir.is_empty() { n.to_string() } else { format!("{rel_dir}/{n}") };
            for f in files {
                if !self.include.is_match(&f) {
                    continue;
                }
                if gi.is_some_and(|gi| gi.matched(&join(&f), false)) {
                    ignored.push((dir.join(&f), false));
                } else {
                    self.queue(dir.join(&f));
                }
            }
            self.flush_if_ready()?;
            let mut kept = vec![];
            for d in dirs.into_iter().filter(|d| !NOISE_DIR_NAMES.contains(&d.as_str())) {
                if gi.is_some_and(|gi| gi.matched(&join(&d), true)) {
                    ignored.push((dir.join(&d), true));
                } else {
                    kept.push(d);
                }
            }
            kept.reverse();
            stack.extend(kept.into_iter().map(|d| dir.join(d)));
        }
        Ok(())
    }

    /// The visible tree first, then what it ignores: ignored files, and
    /// ignored directories small enough to be more than build output.
    fn run(&mut self, gi: &Ignores) -> Result<(), Stop> {
        let mut ignored = vec![];
        self.walk(self.root, Some(gi), &mut ignored)?;
        for (p, is_dir) in ignored {
            if !is_dir {
                self.queue(p);
                self.flush_if_ready()?;
            } else if is_searchable_ignored_dir(&p) {
                self.walk(&p, None, &mut vec![])?;
            } else {
                self.skipped.push(self.rel(&p));
            }
        }
        Ok(())
    }
}

/// What a tree search found: hits in walk order, whether it timed out (the
/// hits so far are kept), and the big gitignored directories it skipped.
struct TreeHits {
    hits: Vec<String>,
    timed_out: bool,
    skipped: Vec<String>,
}

/// Search the tree under `root` in walk order, gitignored files after the
/// rest (see [`Scan::run`]), with names sorted so the order — and which hits
/// survive `max` — is the same on every OS. Files are scanned in parallel
/// `batch`es as the walk finds them, so a search with early hits stops
/// without walking the rest.
#[allow(clippy::too_many_arguments)]
fn search_tree(root: &Path, include: &regex::Regex, gi: &Ignores, denied: &DeniedPaths, m: &Matcher, max: usize, batch: usize, expired: &dyn Fn() -> bool) -> TreeHits {
    let mut s = Scan { root, include, denied, m, max, batch, expired, hits: vec![], pending: vec![], skipped: vec![] };
    let timed_out = match s.run(gi) {
        Ok(()) => {
            scan_batch(m, &s.pending, denied, max, &mut s.hits);
            false
        }
        Err(Stop::Full) => false,
        Err(Stop::TimedOut) => true,
    };
    TreeHits { hits: s.hits, timed_out, skipped: s.skipped }
}

fn timeout_error() -> ToolError {
    ToolError::Execution(format!("grep_files scan timed out after {SCAN_TIMEOUT_S}s — pattern may be too complex or directory too large"))
}

/// Scan `files` in parallel into `hits`, keeping their order. True once
/// `max` hits are in.
fn scan_batch(m: &Matcher, files: &[PathBuf], denied: &DeniedPaths, max: usize, hits: &mut Vec<String>) -> bool {
    use rayon::prelude::*;
    let left = max - hits.len();
    let per_file: Vec<Vec<String>> = files.par_iter().map(|fp| scan_file(m, fp, &denied.display_path(fp), left)).collect();
    for line in per_file.into_iter().flatten() {
        hits.push(line);
        if hits.len() >= max {
            return true;
        }
    }
    false
}

/// The tool's text for `hits`, noting when the search stopped early.
fn render_hits(hits: Vec<String>, timed_out: bool) -> String {
    let mut out = hits.join("\n");
    if timed_out {
        out.push_str(&format!("\n\n[grep stopped after {SCAN_TIMEOUT_S}s: these results are partial. Narrow the directory or include pattern for a complete search.]"));
    }
    out
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("grep", &args);
        let pattern = a.req_str(&["pattern", "query", "regex"]);
        let directory = a.str_or(&["directory", "dir", "path"], ".");
        let include = a.str_or(&["include", "glob", "file_pattern"], "*");
        let max_results = a.opt_int(&["max_results"], Some(1), None).unwrap_or(100) as usize;
        let compiled = compile_pattern(&pattern);
        if let Err(ToolError::Execution(e)) = &compiled {
            a.err("pattern", &format!("Value error, {e}"));
        }
        a.finish()?;
        let m = compiled?;
        let denied = ctx.denied.clone();
        let resolved = denied.validate_read_path(&directory)?;
        if !resolved.exists() {
            return Err(ToolError::Execution(format!("File or directory not found: {}{}", denied.display_path(&resolved), denied.absolute_path_hint(&directory))));
        }
        let no_match = format!("No matches for pattern '{pattern}' in {} (include={include})", denied.display_path(&resolved));
        let task = tokio::task::spawn_blocking(move || -> Result<TreeHits, ToolError> {
            if resolved.is_file() {
                return Ok(TreeHits { hits: scan_file(&m, &resolved, &denied.display_path(&resolved), max_results), timed_out: false, skipped: vec![] });
            }
            let deadline = Instant::now() + std::time::Duration::from_secs(SCAN_TIMEOUT_S);
            let gi = load_gitignore(&resolved);
            let inc = regex::Regex::new(&fnmatch_translate(&include)).map_err(ToolError::exec)?;
            let batch = (rayon::current_num_threads() * 16).max(16);
            Ok(search_tree(&resolved, &inc, &gi, &denied, &m, max_results, batch, &|| Instant::now() > deadline))
        });
        // The walk keeps its own deadline and returns partial hits; this is
        // only a backstop for a single file that will not finish.
        let TreeHits { hits, timed_out, skipped } = match tokio::time::timeout(std::time::Duration::from_secs(SCAN_TIMEOUT_S + 5), task).await {
            Ok(r) => r.map_err(ToolError::exec)??,
            Err(_) => return Err(timeout_error()),
        };
        if hits.is_empty() {
            if timed_out {
                return Err(timeout_error());
            }
            return Ok(ToolOutput::Text(no_match + &skipped_ignored_note(&skipped)));
        }
        Ok(ToolOutput::Text(render_hits(hits, timed_out)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ctx(ws: &Path) -> ToolContext {
        ToolContext {
            session_id: None,
            agent_name: "t".into(),
            tool_call_id: "c".into(),
            denied: Arc::new(DeniedPaths::with(ws, None, Some(vec![]), Some(vec![]))),
            workspace: None,
            output: None,
            metadata: Default::default(),
            messages: None,
        }
    }

    async fn grep(ws: &Path, args: Value) -> String {
        match GrepTool.run(&ctx(ws), args).await.unwrap() {
            ToolOutput::Text(t) => t,
            o => panic!("{o:?}"),
        }
    }

    fn lines_of(out: &str) -> Vec<String> {
        // "path:line: text" with the workspace prefix stripped to the file name
        out.lines().map(|l| l.rsplit(['/', '\\']).next().unwrap_or(l).to_string()).collect()
    }

    #[tokio::test]
    async fn python_line_semantics_including_crlf() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("crlf.txt"), b"foo\r\nbar\r\nold\rmac\n").unwrap();
        std::fs::write(d.path().join("lf.txt"), b"x foo \nlast foo").unwrap();
        // `$` before a CRLF / lone CR, like Python universal newlines.
        let out = grep(d.path(), serde_json::json!({"pattern": "foo$|^mac$"})).await;
        assert_eq!(lines_of(&out), vec!["crlf.txt:1: foo", "crlf.txt:4: mac", "lf.txt:2: last foo"], "{out}");
        // `\s$` can consume the line's own newline (v2 searches `line` with `\n`).
        let out = grep(d.path(), serde_json::json!({"pattern": "foo\\s$", "include": "lf.txt"})).await;
        assert_eq!(lines_of(&out), vec!["lf.txt:1: x foo"], "{out}");
        // `^` anchors per line (prefilter must not drop line 2).
        let out = grep(d.path(), serde_json::json!({"pattern": "^bar", "include": "crlf.txt"})).await;
        assert_eq!(lines_of(&out), vec!["crlf.txt:2: bar"], "{out}");
    }

    #[tokio::test]
    async fn fancy_fallback_and_linear_time() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "foobar\nfoobaz\n").unwrap();
        let out = grep(d.path(), serde_json::json!({"pattern": "foo(?=baz)"})).await;
        assert_eq!(lines_of(&out), vec!["a.txt:2: foobaz"], "{out}");
        assert!(matches!(compile_pattern("foo(?=baz)").unwrap(), Matcher::Fancy(_)));
        assert!(matches!(compile_pattern("fo+").unwrap(), Matcher::Linear { .. }));
        // Catastrophic for a backtracking engine; linear here.
        std::fs::write(d.path().join("evil.txt"), format!("{}b\n", "a".repeat(5000))).unwrap();
        let t = Instant::now();
        let out = grep(d.path(), serde_json::json!({"pattern": "(a+)+$", "include": "evil.txt"})).await;
        assert!(out.starts_with("No matches"), "{out}");
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "{:?}", t.elapsed());
        let err = GrepTool.run(&ctx(d.path()), serde_json::json!({"pattern": "(unclosed"})).await.unwrap_err();
        assert!(format!("{err:?}").contains("Invalid regex"), "{err:?}");
    }

    /// Models hit the length cap with long `a|b|c|…` alternations and,
    /// given no hint, resend the same pattern.
    #[tokio::test]
    async fn too_long_pattern_says_how_to_split_it() {
        let d = tempfile::tempdir().unwrap();
        let pattern = (0..80).map(|i| format!("symbol_{i}")).collect::<Vec<_>>().join("|");
        let err = GrepTool.run(&ctx(d.path()), serde_json::json!({"pattern": pattern})).await.unwrap_err();
        let e = format!("{err}");
        assert!(e.contains("Pattern too long"), "{e}");
        assert!(e.contains("Split a long a|b|c alternation into several grep calls"), "{e}");
    }

    /// Files are scanned in chunks of whole lines; the hits, line numbers
    /// and newline handling must not depend on where a chunk ends.
    #[test]
    fn chunked_scan_matches_a_whole_file_scan() {
        let contents: [&[u8]; 6] = [
            b"foo\r\nbar\r\nold\rmac\nx foo \nlast foo",
            b"a\nfoo\n\nfoo bar\nTi\xe1\xba\xbfng foo Vi\xe1\xbb\x87t\n",
            b"\r\r\nfoo\r",
            b"no trailing newline foo",
            b"foo\n",
            b"\xff\xfe broken utf8 foo\nfoo\n",
        ];
        for pattern in ["foo$", "foo\\s$", "^foo", "foo", "^$", "t$"] {
            let m = compile_pattern(pattern).unwrap();
            for data in contents {
                let whole = scan_reader(&m, data, "f", 100, usize::MAX);
                for chunk in [1, 2, 3, 5, 8, 64] {
                    assert_eq!(scan_reader(&m, data, "f", 100, chunk), whole, "pattern {pattern:?} chunk {chunk} data {:?}", String::from_utf8_lossy(data));
                }
                assert_eq!(scan_reader(&m, data, "f", 1, 2), whole.into_iter().take(1).collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn newline_check_is_kept_only_for_patterns_that_can_use_it() {
        for p in ["foo", "foo$", "^foo", "^$", "a.b", "\\bfoo\\b", "[a-z]+", "(?i)todo|fixme", "x\\z"] {
            assert!(!can_use_trailing_newline(p), "{p}");
        }
        for p in ["foo\\s$", "[^a]", "\\n", "(?m)^$", "(?m)foo$", "(?s)a.b", "\\W", "\\D", "a[\\s,]b", "(unclosed"] {
            assert!(can_use_trailing_newline(p), "{p}");
        }
    }

    #[test]
    fn skipping_the_newline_check_never_changes_hits() {
        let data: &[u8] = b"foo\r\nbar \nold\rmac\nx foo \nTi\xe1\xba\xbfng\n\nlast foo";
        for pattern in ["foo", "foo$", "^foo", "^$", "a.b", "\\bfoo\\b", "t$", "ac$", "^\\w+$"] {
            let fast = compile_pattern(pattern).unwrap();
            assert!(matches!(fast, Matcher::Linear { needs_nl: false, .. }), "{pattern}");
            let Matcher::Linear { line, prefilter, .. } = compile_pattern(pattern).unwrap() else { unreachable!() };
            let always = Matcher::Linear { line, prefilter, needs_nl: true };
            assert_eq!(scan_reader(&fast, data, "f", 100, 7), scan_reader(&always, data, "f", 100, 7), "{pattern}");
        }
    }

    #[tokio::test]
    async fn deterministic_walk_order_and_limit() {
        let d = tempfile::tempdir().unwrap();
        for f in ["b.txt", "a.txt", "sub/z.txt", "sub/deeper/y.txt", "c.txt", "node_modules/n.txt"] {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "hit\n").unwrap();
        }
        std::fs::write(d.path().join(".gitignore"), "c.txt\n").unwrap();
        let out = grep(d.path(), serde_json::json!({"pattern": "hit"})).await;
        // A directory's files first (sorted), then its subdirectories, then
        // gitignored files; noise dirs skipped.
        assert_eq!(lines_of(&out), vec!["a.txt:1: hit", "b.txt:1: hit", "z.txt:1: hit", "y.txt:1: hit", "c.txt:1: hit"], "{out}");
        let out = grep(d.path(), serde_json::json!({"pattern": "hit", "max_results": 3})).await;
        assert_eq!(lines_of(&out), vec!["a.txt:1: hit", "b.txt:1: hit", "z.txt:1: hit"], "{out}");
    }

    #[tokio::test]
    async fn searches_small_ignored_dirs_and_names_skipped_big_ones() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".gitignore"), "out/\ntarget/\n").unwrap();
        std::fs::write(d.path().join("src.txt"), "hit\n").unwrap();
        std::fs::create_dir_all(d.path().join("out/sub")).unwrap();
        std::fs::write(d.path().join("out/sub/report.txt"), "hit\nneedle\n").unwrap();
        std::fs::create_dir_all(d.path().join("target/debug")).unwrap();
        for i in 0..=MAX_IGNORED_DIR_FILES {
            std::fs::write(d.path().join(format!("target/debug/f{i}.txt")), "needle\n").unwrap();
        }
        let out = grep(d.path(), serde_json::json!({"pattern": "hit"})).await;
        assert_eq!(lines_of(&out), vec!["src.txt:1: hit", "report.txt:1: hit"], "{out}");
        let out = grep(d.path(), serde_json::json!({"pattern": "nothing-here"})).await;
        assert!(out.starts_with("No matches") && out.contains("skipped large gitignored directories: target/"), "{out}");
        assert!(!out.contains("out/"), "{out}");
        // Named explicitly, a big ignored directory is searched in full.
        let out = grep(d.path(), serde_json::json!({"pattern": "needle", "directory": "target", "max_results": 1000})).await;
        assert_eq!(out.lines().count(), MAX_IGNORED_DIR_FILES + 1, "{out}");
    }

    #[tokio::test]
    async fn a_subfolder_search_honours_the_repository_gitignore() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".git")).unwrap();
        std::fs::write(d.path().join(".gitignore"), "app/out/\n").unwrap();
        for f in ["app/out/a.txt", "app/src/b.txt"] {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "hit\n").unwrap();
        }
        // Only the root `.gitignore` names `app/out/`: it still ranks last.
        let out = grep(d.path(), serde_json::json!({"pattern": "hit", "directory": "app"})).await;
        assert_eq!(lines_of(&out), vec!["b.txt:1: hit", "a.txt:1: hit"], "{out}");
    }

    fn hit_tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for f in ["a.txt", "b.txt", "sub/c.txt", "sub/d.txt", "sub/deeper/e.txt", "z/f.txt"] {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "hit\n").unwrap();
        }
        d
    }

    fn search(root: &Path, max: usize, batch: usize, expired: &dyn Fn() -> bool) -> (Vec<String>, bool) {
        let denied = DeniedPaths::with(root, None, Some(vec![]), Some(vec![]));
        let inc = regex::Regex::new(&fnmatch_translate("*")).unwrap();
        let t = search_tree(root, &inc, &load_gitignore(root), &denied, &compile_pattern("hit").unwrap(), max, batch, expired);
        (t.hits, t.timed_out)
    }

    #[test]
    fn search_keeps_walk_order_for_any_batch_size() {
        let d = hit_tree();
        let (all, timed_out) = search(d.path(), 100, 1000, &|| false);
        assert!(!timed_out);
        assert_eq!(lines_of(&all.join("\n")), ["a.txt:1: hit", "b.txt:1: hit", "c.txt:1: hit", "d.txt:1: hit", "e.txt:1: hit", "f.txt:1: hit"]);
        for batch in [1, 2, 3] {
            assert_eq!(search(d.path(), 100, batch, &|| false).0, all, "batch {batch}");
            assert_eq!(search(d.path(), 4, batch, &|| false).0, all[..4], "batch {batch}");
        }
    }

    #[test]
    fn a_timed_out_search_keeps_what_it_found() {
        let d = hit_tree();
        let (all, _) = search(d.path(), 100, 1000, &|| false);
        let calls = std::cell::Cell::new(0);
        let (partial, timed_out) = search(d.path(), 100, 1, &|| {
            calls.set(calls.get() + 1);
            calls.get() > 3
        });
        assert!(timed_out);
        assert!(!partial.is_empty() && partial.len() < all.len(), "{partial:?}");
        assert_eq!(partial, all[..partial.len()]);
    }

    #[test]
    fn partial_results_say_so() {
        assert_eq!(render_hits(vec!["a:1: x".into()], false), "a:1: x");
        let out = render_hits(vec!["a:1: x".into(), "b:2: y".into()], true);
        assert!(out.starts_with("a:1: x\nb:2: y\n\n") && out.contains("stopped after 10s"), "{out}");
    }
}
