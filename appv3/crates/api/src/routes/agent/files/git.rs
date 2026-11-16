//! The git panels: the workspace's status, its changed files and their
//! diffs, the branch history and one commit's diff, and the discard, undo
//! and revert actions.

use super::super::worktrees::run_git_timeout;
use super::{safe_resolve, validated, MAX_FILES_LISTED, READ_ONLY_GIT};
use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::*;
use axum::response::Response;
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

const MAX_GIT_DIFF_CHARS: usize = 512 * 1024;
const MAX_UNTRACKED_DIFF_BYTES: u64 = 256 * 1024;
/// Bytes of untracked files read to count their lines for the changed-files
/// list; past it the remaining untracked files are listed without counts.
const UNTRACKED_COUNT_BUDGET_BYTES: u64 = 8 * 1024 * 1024;

static SHA_RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[a-fA-F0-9]{4,64}$").unwrap());

/// Run git: stdout on success, `None` on any failure. Read-only calls only.
async fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let args: Vec<&str> = READ_ONLY_GIT.iter().chain(args).copied().collect();
    let o = run_git_timeout(Path::new(cwd), &args, Duration::from_secs(5)).await.ok()?;
    (o.code == 0).then_some(o.stdout)
}

/// `os.path.normpath` (posix).
fn normpath(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let abs = p.starts_with('/');
    let mut parts: Vec<&str> = vec![];
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                if parts.last().map(|l| *l != "..").unwrap_or(false) {
                    parts.pop();
                } else if !abs {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    let lead = if abs {
        if p.starts_with("//") && !p.starts_with("///") {
            "//"
        } else {
            "/"
        }
    } else {
        ""
    };
    let out = format!("{lead}{joined}");
    if out.is_empty() {
        ".".into()
    } else {
        out
    }
}

async fn bounded_git_diff(cwd: &str, args: &[&str], max_bytes: usize) -> ApiResult<(String, String, i32, bool)> {
    use tokio::io::AsyncReadExt;
    let mut child = appv3_core::proctree::hide_window(&mut tokio::process::Command::new("git"))
        .arg("-C")
        .arg(cwd)
        .args(READ_ONLY_GIT)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| ApiError::new(500, format!("git diff failed: {e}")))?;
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let limit = max_bytes + 1;
    let fut = async {
        let mut out = vec![];
        let mut err = vec![];
        let mut exceeded = false;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = so.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            let remaining = limit.saturating_sub(out.len());
            out.extend_from_slice(&buf[..n.min(remaining)]);
            if n > remaining {
                exceeded = true;
                break;
            }
        }
        if exceeded {
            let _ = child.start_kill();
        }
        let _ = (&mut se).take(64 * 1024).read_to_end(&mut err).await;
        let status = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        (out, err, status, exceeded)
    };
    match tokio::time::timeout(Duration::from_secs(10), fut).await {
        Ok((o, e, c, x)) => Ok((String::from_utf8_lossy(&o).to_string(), String::from_utf8_lossy(&e).to_string(), c, x)),
        Err(_) => Err(ApiError::new(500, format!("git diff failed: Command '{:?}' timed out after 10.0 seconds", args))),
    }
}

fn format_range(start: usize, stop: usize) -> String {
    let mut beginning = start + 1;
    let length = stop - start;
    if length == 1 {
        return beginning.to_string();
    }
    if length == 0 {
        beginning -= 1;
    }
    format!("{beginning},{length}")
}

fn untracked_diff(root: &Path, paths: &[String]) -> String {
    let mut chunks: Vec<String> = vec![];
    let mut size = 0usize;
    for path in paths {
        if size > MAX_GIT_DIFF_CHARS {
            break;
        }
        let binary = |kind: &str| format!("\ndiff --git a/{path} b/{path}\nnew file mode 100644\nBinary or {kind} file not shown: {path}\n");
        let text = match safe_resolve(root, path) {
            Ok(fp) => {
                if !fp.is_file() || std::fs::metadata(&fp).map(|m| m.len()).unwrap_or(0) > MAX_UNTRACKED_DIFF_BYTES {
                    let c = binary("large");
                    size += c.chars().count();
                    chunks.push(c);
                    continue;
                }
                std::fs::read(&fp).ok().and_then(|b| String::from_utf8(b).ok())
            }
            Err(_) => None,
        };
        let Some(text) = text else {
            let c = binary("unreadable");
            size += c.chars().count();
            chunks.push(c);
            continue;
        };
        // Python read_text uses universal newlines.
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        let body = if lines.is_empty() {
            String::new()
        } else {
            let mut b = format!("--- /dev/null\n+++ b/{path}\n@@ -{} +{} @@\n", format_range(0, 0), format_range(0, lines.len()));
            for l in &lines {
                b.push('+');
                b.push_str(l);
            }
            b
        };
        let c = format!("\ndiff --git a/{path} b/{path}\nnew file mode 100644\n{body}");
        size += c.chars().count();
        chunks.push(c);
    }
    chunks.concat().chars().take(MAX_GIT_DIFF_CHARS + 1).collect()
}

pub(super) async fn git_diff(q: Qs) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let resolved = validated(&workspace)?;
    crate::watch::touch_workspace(Path::new(&resolved), &workspace);
    let root = PathBuf::from(&resolved);
    if !root.join(".git").exists() {
        return Ok(json(json!({"workspace": resolved, "is_git_repo": false, "diff": "", "untracked": [], "truncated": false})));
    }
    let mut scoped = vec![];
    for raw in q.get_all("paths") {
        if raw.is_empty() {
            continue;
        }
        let n = normpath(&raw);
        if n.starts_with("..") || n.starts_with('/') {
            return Err(ApiError::unprocessable(format!("invalid path in scoped diff: {raw}")));
        }
        scoped.push(n);
    }
    let diff_paths: Vec<String> = if scoped.is_empty() { vec![".".into()] } else { scoped.clone() };
    // Listing untracked files doesn't depend on the diff, so it runs with the
    // HEAD probe. `-z`: unquoted paths, as the scope and the files read them.
    let (head, listed) = tokio::join!(git(&resolved, &["rev-parse", "--verify", "HEAD"]), git(&resolved, &["ls-files", "-z", "--others", "--exclude-standard"]));
    let has_head = head.is_some();
    // A scoped path is a file name, not a pattern (`app/[id].tsx`).
    let mut args: Vec<&str> = if has_head { vec!["--literal-pathspecs", "diff", "HEAD"] } else { vec!["--literal-pathspecs", "diff"] };
    args.push("--");
    args.extend(diff_paths.iter().map(String::as_str));
    let (tracked, stderr, code, tracked_trunc) = bounded_git_diff(&resolved, &args, MAX_GIT_DIFF_CHARS).await?;
    if code != 0 && !tracked_trunc {
        let e = stderr.trim();
        return Err(ApiError::new(500, if e.is_empty() { "git diff failed".to_string() } else { e.to_string() }));
    }
    let mut untracked: Vec<String> = listed.map(|o| o.split('\0').filter(|p| !p.is_empty()).map(String::from).collect()).unwrap_or_default();
    if !scoped.is_empty() {
        untracked.retain(|u| scoped.contains(u));
    }
    // Past the cap there is no room for untracked bodies, but the files are
    // still listed.
    let mut full = tracked;
    if !tracked_trunc {
        let (r, u) = (root.clone(), untracked.clone());
        full.push_str(&blocking(move || untracked_diff(&r, &u)).await);
    }
    let nchars = full.chars().count();
    let truncated = tracked_trunc || nchars > MAX_GIT_DIFF_CHARS;
    let diff: String = if nchars > MAX_GIT_DIFF_CHARS { full.chars().take(MAX_GIT_DIFF_CHARS).collect() } else { full };
    Ok(json(json!({"workspace": resolved, "is_git_repo": true, "diff": diff, "untracked": untracked, "truncated": truncated})))
}

/// Every changed path with its status and line counts, read from git's file
/// lists rather than the diff text: a diff too big to send still lists every
/// file. The Review dock polls this after each write and fetches a body from
/// `git-diff/view?paths=…` only for a file the user opens.
pub(super) async fn git_diff_files(q: Qs) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let resolved = validated(&workspace)?;
    crate::watch::touch_workspace(Path::new(&resolved), &workspace);
    let root = PathBuf::from(&resolved);
    if !root.join(".git").exists() {
        return Ok(json(json!({"workspace": resolved, "is_git_repo": false, "files": [], "total": 0, "truncated": false})));
    }
    let (head, untracked) = tokio::join!(git(&resolved, &["rev-parse", "--verify", "HEAD"]), git(&resolved, &["ls-files", "-z", "--others", "--exclude-standard"]));
    // `--no-renames`: a rename lists as a delete plus an add, as the diff
    // bodies show it.
    let base: &[&str] = if head.is_some() { &["diff", "HEAD", "--no-renames", "-z"] } else { &["diff", "--no-renames", "-z"] };
    let with = |flag: &'static str| -> Vec<&'static str> { base.iter().copied().chain([flag]).collect() };
    let (name_args, count_args) = (with("--name-status"), with("--numstat"));
    let (names, counts) = tokio::join!(git(&resolved, &name_args), git(&resolved, &count_args));
    let (Some(names), Some(counts)) = (names, counts) else {
        return Err(ApiError::new(500, "git diff failed"));
    };
    let untracked = untracked.unwrap_or_default();
    let (files, total) = blocking(move || changed_files(&root, &names, &counts, &untracked)).await;
    let truncated = total > files.len();
    Ok(json(json!({"workspace": resolved, "is_git_repo": true, "files": files, "total": total, "truncated": truncated})))
}

/// Rows for `git_diff_files` from `--name-status -z`, `--numstat -z` and
/// `ls-files -z --others` output, sorted by path and capped at
/// [`MAX_FILES_LISTED`]; also returns the uncapped total.
fn changed_files(root: &Path, names: &str, counts: &str, untracked: &str) -> (Vec<Value>, usize) {
    let mut status: BTreeMap<&str, &str> = BTreeMap::new();
    let mut fields = names.split('\0');
    while let (Some(s), Some(path)) = (fields.next(), fields.next()) {
        if s.is_empty() || path.is_empty() {
            break;
        }
        status.insert(
            path,
            if s.starts_with('A') {
                "A"
            } else if s.starts_with('D') {
                "D"
            } else {
                "M"
            },
        );
    }
    let mut lines: HashMap<&str, (u64, u64)> = HashMap::new();
    for rec in counts.split('\0') {
        let mut f = rec.splitn(3, '\t');
        if let (Some(a), Some(d), Some(path)) = (f.next(), f.next(), f.next()) {
            // Binary files report `-`.
            lines.insert(path, (a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
        }
    }
    let untracked: HashSet<&str> = untracked.split('\0').filter(|p| !p.is_empty()).collect();
    for path in &untracked {
        status.insert(path, "A");
    }
    let mut budget = UNTRACKED_COUNT_BUDGET_BYTES;
    let files = status
        .iter()
        .take(MAX_FILES_LISTED)
        .map(|(path, s)| {
            let (additions, deletions) = if untracked.contains(path) {
                let a = untracked_lines(root, path, &mut budget);
                (a, a.map(|_| 0))
            } else {
                let (a, d) = lines.get(path).copied().unwrap_or((0, 0));
                (Some(a), Some(d))
            };
            json!({"path": path, "status": s, "additions": additions, "deletions": deletions})
        })
        .collect();
    (files, status.len())
}

/// Lines an untracked file adds, counted as `untracked_diff` renders it:
/// `0` for a binary, unreadable or too-large file, `None` once the read
/// budget is spent.
fn untracked_lines(root: &Path, rel: &str, budget: &mut u64) -> Option<u64> {
    let Ok(fp) = safe_resolve(root, rel) else { return Some(0) };
    let size = std::fs::metadata(&fp).map(|m| m.len()).unwrap_or(0);
    if size > MAX_UNTRACKED_DIFF_BYTES {
        return Some(0);
    }
    if size > *budget {
        return None;
    }
    *budget -= size;
    let Some(text) = std::fs::read(&fp).ok().and_then(|b| String::from_utf8(b).ok()) else { return Some(0) };
    Some(text.replace("\r\n", "\n").replace('\r', "\n").split_inclusive('\n').count() as u64)
}

struct Porcelain {
    branch: Option<String>,
    staged: i64,
    unstaged: i64,
    untracked: i64,
    upstream: Option<String>,
    ahead: Option<i64>,
    behind: Option<i64>,
}

fn parse_porcelain_v2(out: &str) -> Porcelain {
    let mut p = Porcelain { branch: None, staged: 0, unstaged: 0, untracked: 0, upstream: None, ahead: None, behind: None };
    for line in out.lines() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            let h = h.trim();
            p.branch = (h != "(detached)").then(|| h.to_string());
        } else if let Some(u) = line.strip_prefix("# branch.upstream ") {
            p.upstream = Some(u.trim().to_string()).filter(|s| !s.is_empty());
        } else if line.starts_with("# branch.ab ") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 4 && parts[2].starts_with('+') && parts[3].starts_with('-') {
                match (parts[2][1..].parse::<i64>(), parts[3][1..].parse::<i64>()) {
                    (Ok(a), Ok(b)) => {
                        p.ahead = Some(a);
                        p.behind = Some(b);
                    }
                    _ => {
                        p.ahead = None;
                        p.behind = None;
                    }
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let parts: Vec<&str> = line.splitn(3, ' ').collect();
            if parts.len() >= 2 && parts[1].chars().count() == 2 {
                let xy: Vec<char> = parts[1].chars().collect();
                if xy[0] != '.' {
                    p.staged += 1;
                }
                if xy[1] != '.' {
                    p.unstaged += 1;
                }
            }
        } else if line.starts_with("? ") {
            p.untracked += 1;
        }
    }
    p
}

fn parse_counts(s: &str) -> Option<(i64, i64)> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() == 2 && parts.iter().all(|c| c.chars().all(|x| x.is_ascii_digit()) && !c.is_empty()) {
        return Some((parts[0].parse().ok()?, parts[1].parse().ok()?));
    }
    None
}

pub(super) async fn workspace_status(q: Qs) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let resolved = validated(&workspace)?;
    crate::watch::touch_workspace(Path::new(&resolved), &workspace);
    let root = PathBuf::from(&resolved);
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| resolved.clone());
    let not_git = || {
        json(
            json!({"workspace": resolved, "name": name, "is_git_repo": false, "branch": null, "dirty": null, "head": null, "commits_ahead": null, "commits_behind": null, "upstream": null}),
        )
    };
    if !root.join(".git").exists() {
        return Ok(not_git());
    }
    // This runs after every agent tool call, and each git spawn costs ~10 ms,
    // so independent calls run side by side.
    let (status_out, log) = tokio::join!(git(&resolved, &["status", "--porcelain=v2", "--branch"]), git(&resolved, &["log", "-1", "--format=%h%x00%s%x00%ct"]));
    let Some(status_out) = status_out else { return Ok(not_git()) };
    let mut p = parse_porcelain_v2(&status_out);
    let mut head = Value::Null;
    if let Some(log) = log.filter(|l| !l.is_empty()) {
        let parts: Vec<&str> = log.trim_end_matches('\n').split('\0').collect();
        if parts.len() == 3 {
            if let Ok(ts) = parts[2].trim().parse::<i64>() {
                head = json!({"sha": parts[0], "subject": parts[1], "timestamp": ts});
            }
        }
    }
    if p.upstream.is_none() || p.ahead.is_none() || p.behind.is_none() {
        let mut upstream_ref: Option<String> = Some("@{u}".into());
        // Fallback refs in priority order, probed alongside `@{u}`.
        let mut candidates: Vec<String> = vec![];
        if let Some(b) = &p.branch {
            candidates.push(format!("origin/{b}"));
        }
        candidates.extend(["origin/HEAD", "origin/main", "origin/master", "main", "master"].map(String::from));
        let mut seen = HashSet::new();
        candidates.retain(|c| p.branch.as_deref() != Some(c.as_str()) && seen.insert(c.clone()));
        let cwd = resolved.as_str();
        let (div, exists) = tokio::join!(
            git(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
            futures::future::join_all(candidates.iter().map(|c| async move { git(cwd, &["rev-parse", "--verify", c]).await }))
        );
        if let Some(d) = &div {
            if let Some((a, b)) = parse_counts(d) {
                p.ahead = Some(a);
                p.behind = Some(b);
            }
        }
        if div.is_none() {
            upstream_ref = None;
            for (c, _) in candidates.into_iter().zip(exists).filter(|(_, e)| e.is_some()) {
                if let Some((a, b)) = git(&resolved, &["rev-list", "--left-right", "--count", &format!("HEAD...{c}")]).await.as_deref().and_then(parse_counts) {
                    p.ahead = Some(a);
                    p.behind = Some(b);
                    upstream_ref = Some(c);
                    break;
                }
            }
        }
        if let (Some(r), Some(_), Some(_)) = (&upstream_ref, p.ahead, p.behind) {
            if r == "@{u}" {
                p.upstream =
                    Some(git(&resolved, &["rev-parse", "--abbrev-ref", "@{u}"]).await.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).unwrap_or_else(|| "@{u}".into()));
            } else {
                p.upstream = Some(r.clone());
            }
        }
    }
    Ok(json(json!({
        "workspace": resolved,
        "name": name,
        "is_git_repo": true,
        "branch": p.branch,
        "dirty": {"staged": p.staged, "unstaged": p.unstaged, "untracked": p.untracked},
        "head": head,
        "commits_ahead": p.ahead,
        "commits_behind": p.behind,
        "upstream": p.upstream,
    })))
}

/// The current branch's commits, newest first, `limit` at a time; `cursor` is
/// the last SHA of the previous page. (Before v3.40.0 this also returned a
/// `git log --graph` and took `all` for every branch; an older client's `all`
/// is now ignored.)
pub(super) async fn git_history(q: Qs) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let limit = q.int("limit", 50, Some(1), Some(500))?;
    let cursor = q.opt("cursor");
    let resolved = validated(&workspace)?;
    if let Some(c) = cursor.as_deref().filter(|c| !c.is_empty()) {
        if !SHA_RE.is_match(c) {
            return Err(ApiError::unprocessable("Invalid cursor SHA format."));
        }
    }
    if !Path::new(&resolved).join(".git").exists() {
        return Ok(json(json!({"workspace": resolved, "is_git_repo": false, "commits": [], "next_cursor": null})));
    }
    let cur = cursor.clone().filter(|c| !c.is_empty());
    let mut log_args: Vec<String> = vec!["log".into()];
    if let Some(c) = &cur {
        log_args.extend([c.clone(), "--skip=1".into()]);
    }
    log_args.extend(["-n".into(), (limit + 1).to_string(), "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%d%x1e".into()]);
    let la: Vec<&str> = log_args.iter().map(String::as_str).collect();
    let log = git(&resolved, &la).await;
    let mut commits: Vec<Value> = vec![];
    let mut shas: Vec<String> = vec![];
    if let Some(out) = log.filter(|o| !o.is_empty()) {
        for rec in out.split('\x1e') {
            let rec = rec.trim_matches('\n');
            if rec.is_empty() {
                continue;
            }
            let parts: Vec<&str> = rec.split('\0').collect();
            if parts.len() < 6 {
                continue;
            }
            let ts = parts[4].trim().parse::<i64>().unwrap_or(0);
            let body = parts.get(6).map(|b| b.trim()).filter(|b| !b.is_empty());
            let refs = parts.get(7).filter(|r| !r.trim().is_empty()).map(|r| r.trim_matches(|c| c == ' ' || c == '(' || c == ')' || c == '\n').to_string());
            shas.push(parts[0].to_string());
            commits.push(json!({"sha": parts[0], "short_sha": parts[1], "author_name": parts[2], "author_email": parts[3], "timestamp": ts, "subject": parts[5], "body": body, "refs": refs}));
        }
    }
    let mut next = Value::Null;
    if commits.len() as i64 > limit {
        next = json!(shas[(limit - 1) as usize]);
        commits.truncate(limit as usize);
    }
    Ok(json(json!({"workspace": resolved, "is_git_repo": true, "commits": commits, "next_cursor": next})))
}

fn req_fields(raw: &[u8], names: &[&str]) -> ApiResult<Vec<String>> {
    let b = body_value(raw)?;
    let mut errs = vec![];
    let mut out = vec![];
    for n in names {
        match b.get(*n) {
            Some(Value::String(s)) => out.push(s.clone()),
            None => {
                errs.push(verr("missing", &loc(&["body", n]), "Field required", b.clone()));
                out.push(String::new())
            }
            Some(o) => {
                errs.push(verr("string_type", &loc(&["body", n]), "Input should be a valid string", o.clone()));
                out.push(String::new())
            }
        }
    }
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    Ok(out)
}

pub(super) async fn git_discard(raw: Bytes) -> ApiResult<Response> {
    let f = req_fields(&raw, &["workspace", "path", "status"])?;
    let (workspace, rel, status) = (&f[0], &f[1], &f[2]);
    if workspace.is_empty() || rel.is_empty() {
        return Err(ApiError::bad_request("workspace and path are required."));
    }
    let rw = validated(workspace)?;
    let root = PathBuf::from(&rw);
    if !root.join(".git").exists() {
        return Err(ApiError::bad_request("Not a git repository."));
    }
    if rel.starts_with('/') || rel.split('/').any(|p| p == "..") {
        return Err(ApiError::bad_request("Invalid file path."));
    }
    let abs = resolve(&root.join(rel));
    if !abs.starts_with(resolve(&root)) {
        return Err(ApiError::bad_request("Path escapes workspace root."));
    }
    if status == "A" {
        match std::fs::remove_file(&abs) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(ApiError::new(500, format!("Could not delete file: {e}"))),
        }
    } else {
        let o = run_git_timeout(&root, &["checkout", "--", rel], Duration::from_secs(10)).await?;
        if o.code != 0 {
            return Err(ApiError::new(500, format!("git checkout failed: {}", o.stderr.trim())));
        }
    }
    Ok(json(json!({"workspace": workspace, "path": rel, "status": status})))
}

pub(super) async fn commit_diff(q: Qs) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let sha = q.req("sha")?;
    let resolved = validated(&workspace)?;
    if !SHA_RE.is_match(&sha) {
        return Err(ApiError::unprocessable("Invalid commit SHA format."));
    }
    if !Path::new(&resolved).join(".git").exists() {
        return Err(ApiError::bad_request("Not a git repository."));
    }
    let diff = git(&resolved, &["show", "--no-notes", "--pretty=format:", &sha]).await.ok_or_else(|| ApiError::not_found("Commit not found or failed to retrieve diff."))?;
    Ok(json(json!({"sha": sha, "diff": diff})))
}

pub(super) async fn git_undo(raw: Bytes) -> ApiResult<Response> {
    let f = req_fields(&raw, &["workspace"])?;
    let workspace = &f[0];
    if workspace.is_empty() {
        return Err(ApiError::bad_request("workspace is required."));
    }
    let resolved = validated(workspace)?;
    if !Path::new(&resolved).join(".git").exists() {
        return Err(ApiError::bad_request("Not a git repository."));
    }
    if git(&resolved, &["rev-parse", "--verify", "HEAD"]).await.is_none() {
        return Err(ApiError::bad_request("No commits to undo."));
    }
    let args: &[&str] = if git(&resolved, &["rev-parse", "--verify", "HEAD~1"]).await.is_some() { &["reset", "--soft", "HEAD~1"] } else { &["update-ref", "-d", "HEAD"] };
    let o = run_git_timeout(Path::new(&resolved), args, Duration::from_secs(10)).await?;
    if o.code != 0 {
        let d = if o.stderr.trim().is_empty() { o.stdout.trim() } else { o.stderr.trim() };
        return Err(ApiError::new(500, format!("git reset failed: {d}")));
    }
    Ok(json(json!({"workspace": workspace, "success": true})))
}

pub(super) async fn git_revert(raw: Bytes) -> ApiResult<Response> {
    let f = req_fields(&raw, &["workspace", "sha"])?;
    let (workspace, sha) = (&f[0], &f[1]);
    if workspace.is_empty() || sha.is_empty() {
        return Err(ApiError::bad_request("workspace and sha are required."));
    }
    if !SHA_RE.is_match(sha) {
        return Err(ApiError::unprocessable("Invalid commit SHA format."));
    }
    let resolved = validated(workspace)?;
    if !Path::new(&resolved).join(".git").exists() {
        return Err(ApiError::bad_request("Not a git repository."));
    }
    let o = run_git_timeout(Path::new(&resolved), &["revert", "--no-edit", sha], Duration::from_secs(15)).await?;
    if o.code != 0 {
        let _ = run_git_timeout(Path::new(&resolved), &["revert", "--abort"], Duration::from_secs(15)).await;
        let d = if o.stderr.trim().is_empty() { o.stdout.trim() } else { o.stderr.trim() };
        return Err(ApiError::bad_request(format!("Revert failed (likely due to conflicts):\n{d}")));
    }
    Ok(json(json!({"workspace": workspace, "sha": sha, "success": true})))
}

#[cfg(test)]
mod tests;
