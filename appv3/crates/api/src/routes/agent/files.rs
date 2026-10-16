//! `app/api/routes/agent/files.py` — uploads/media serving, workspace file
//! listings, and the git panels.

use super::worktrees::run_git_timeout;
use crate::error::{loc, verr, ApiError, ApiResult};
use crate::fileresp::{file_response, FileOpts};
use crate::util::*;
use crate::AppState;
use appv3_agent::manager;
use appv3_agent::session::session_workspace_dir;
use appv3_db as db;
use appv3_tools::grep::{is_gitignored, load_gitignore, NOISE_DIR_NAMES};
use axum::extract::{Path as AxPath, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

const MAX_FILES_LISTED: usize = 5_000;
/// A gitignored directory holding more files than this is build output or a
/// cache (`target/`, `dist/`), not something to browse, so it is left out
/// whole rather than letting it crowd out other ignored files.
const MAX_IGNORED_DIR_FILES: usize = 500;
const JUNK_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// Ignored files never listed: OS clutter, and `.env` / `.env.*` secrets,
/// which stay out of Quick Open and the `@` picker as they did before ignored
/// files were listed (a tracked `.env.example` is visible, not ignored).
fn is_unlisted_ignored_name(name: &str) -> bool {
    JUNK_FILE_NAMES.contains(&name) || name == ".env" || name.starts_with(".env.")
}
const MAX_GIT_DIFF_CHARS: usize = 512 * 1024;
const MAX_UNTRACKED_DIFF_BYTES: u64 = 256 * 1024;
/// Global flags for the panels' read-only git calls, which run after every
/// agent tool call. Without them `git status` and `git diff` take
/// `.git/index.lock` to save a refreshed index, so the agent's own `git
/// add`/`commit` collides with them, and a killed call strands the lock.
/// `git diff` ignores `--no-optional-locks`, hence `diff.autoRefreshIndex`.
const READ_ONLY_GIT: [&str; 3] = ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false"];
static SHA_RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[a-fA-F0-9]{4,64}$").unwrap());

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{session_id}/uploads/{filename}", get(get_upload))
        .route("/{session_id}/media/{*file_path}", get(get_media))
        .route("/{session_id}/files", get(|st: State<AppState>, sid: AxPath<String>, h: HeaderMap| async move { etagged(&h, list_session_files(st, sid).await).await }))
        .route("/workspace/files/read", get(read_workspace_file))
        // Polled after every tool call: ETag / 304 (see `with_etag`).
        .route("/workspace/files/list", get(|h: HeaderMap, q: Qs| async move { etagged(&h, list_workspace_files(q).await).await }))
        .route("/workspace/git-diff/view", get(|h: HeaderMap, q: Qs| async move { etagged(&h, git_diff(q).await).await }))
        .route("/workspace/status", get(|h: HeaderMap, q: Qs| async move { etagged(&h, workspace_status(q).await).await }))
        .route("/workspace/git/history", get(git_history))
        .route("/workspace/git/discard", post(git_discard))
        .route("/workspace/git/commit-diff", get(commit_diff))
        .route("/workspace/git/undo", post(git_undo))
        .route("/workspace/git/revert", post(git_revert))
}

fn safe_resolve(root: &Path, rel: &str) -> ApiResult<PathBuf> {
    if rel.trim().is_empty() {
        return Err(ApiError::bad_request("Empty media path."));
    }
    if rel.starts_with('/') || (rel.len() >= 2 && rel.as_bytes()[1] == b':') {
        return Err(ApiError::bad_request("Absolute media paths rejected."));
    }
    let resolved = resolve(&root.join(rel));
    if !resolved.starts_with(resolve(root)) {
        return Err(ApiError::bad_request("Media path escapes session root."));
    }
    if !resolved.is_file() {
        return Err(ApiError::not_found("Media file not found."));
    }
    Ok(resolved)
}

/// `_guess_mime` (TypeScript overrides the stdlib's `video/mp2t`).
pub fn guess_mime(p: &Path) -> String {
    let suffix = p.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default();
    if [".ts", ".mts", ".cts", ".tsx"].contains(&suffix.as_str()) {
        return "text/typescript".into();
    }
    appv3_core::mimetypes::guess_type(&p.to_string_lossy()).unwrap_or_else(|| "application/octet-stream".into())
}

async fn session_workspace(st: &AppState, sid: &str) -> ApiResult<PathBuf> {
    let row = match py_uuid(sid) {
        Some(u) => db::get_session(&st.pool, &u).await.ok().flatten(),
        None => None,
    };
    match row.filter(|r| !r.workspace.is_empty()) {
        Some(r) => Ok(session_workspace_dir(sid, Some(&r.workspace))),
        None => Err(ApiError::not_found("Session not found.")),
    }
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

async fn get_upload(State(st): State<AppState>, AxPath((sid, filename)): AxPath<(String, String)>, headers: HeaderMap) -> ApiResult<Response> {
    if filename.contains('/') || filename.contains('\\') || ["", ".", ".."].contains(&filename.as_str()) {
        return Err(ApiError::bad_request("Invalid upload filename."));
    }
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let ws = session_workspace(&st, &sid).await?;
    let resolved = safe_resolve(&ws.join("uploads"), &filename)?;
    let mime = guess_mime(&resolved);
    let name = name_of(&resolved);
    Ok(file_response(&resolved, &headers, FileOpts { media_type: &mime, filename: Some(&name), disposition: "attachment", extra_headers: &[] }).await)
}

async fn get_media(State(st): State<AppState>, AxPath((sid, file_path)): AxPath<(String, String)>, q: Qs, headers: HeaderMap) -> ApiResult<Response> {
    let download = q.bool("download", false)?;
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let resolved = safe_resolve(&session_workspace(&st, &sid).await?, &file_path)?;
    let mime = guess_mime(&resolved);
    let name = name_of(&resolved);
    Ok(file_response(&resolved, &headers, FileOpts { media_type: &mime, filename: Some(&name), disposition: if download { "attachment" } else { "inline" }, extra_headers: &[] })
        .await)
}

// ── listings ────────────────────────────────────────────────────────────────

fn git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = appv3_core::proctree::hide_window_std(&mut std::process::Command::new("git"))
        .arg("-C")
        .arg(cwd)
        .args(READ_ONLY_GIT)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

/// Tracked + untracked paths, then gitignored ones. Ignored directories come
/// back as `dir/` (git does not descend into them); noise directories and OS
/// clutter are dropped here.
///
/// `base` may be a subdirectory of the work tree: git then lists paths
/// relative to it and still applies every `.gitignore` above it, which the
/// root-only fallback walk cannot (a workspace at `repo/app` would otherwise
/// list `app/target/` because only `repo/.gitignore` names it). `None` outside
/// a work tree, or when `base` itself is ignored (git would only report `./`).
fn git_listed_paths(base: &Path) -> Option<(Vec<String>, Vec<String>)> {
    // Three independent git spawns (~10 ms each): run them side by side.
    let (tracked, untracked, ignored) = std::thread::scope(|s| {
        let tracked = s.spawn(|| git_stdout(base, &["ls-files", "-z", "--cached"]));
        let untracked = s.spawn(|| git_stdout(base, &["ls-files", "-z", "--others", "--exclude-standard"]));
        let ignored = git_stdout(base, &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
        (tracked.join().ok().flatten(), untracked.join().ok().flatten(), ignored)
    });
    let (tracked, untracked, ignored) = (tracked?, untracked?, ignored?);
    if ignored.split('\0').any(|r| r == "./") {
        return None;
    }
    let mut paths: BTreeSet<String> = tracked.split('\0').filter(|r| !r.is_empty()).map(String::from).collect();
    for rel in untracked.split('\0').filter(|r| !r.is_empty()) {
        let parts: Vec<&str> = rel.trim_end_matches('/').split('/').collect();
        if !parts[..parts.len().saturating_sub(1)].iter().any(|p| NOISE_DIR_NAMES.contains(p)) {
            paths.insert(rel.to_string());
        }
    }
    let ignored = ignored.split('\0').filter(|r| !r.is_empty() && !is_noise_path(r)).map(String::from).collect();
    Some((paths.into_iter().collect(), ignored))
}

/// A path inside a noise directory (`node_modules`, `.venv`, …), or an
/// ignored file that is never listed (see [`is_unlisted_ignored_name`]).
fn is_noise_path(rel: &str) -> bool {
    let mut parts = rel.trim_end_matches('/').split('/');
    let name = parts.next_back().unwrap_or_default();
    let is_dir = rel.ends_with('/');
    parts.any(|p| NOISE_DIR_NAMES.contains(&p)) || (if is_dir { NOISE_DIR_NAMES.contains(&name) } else { is_unlisted_ignored_name(name) })
}

fn file_info(entry: &Path, root: &Path, root_resolved: &Path, meta: std::fs::Metadata, ignored: bool) -> Option<Value> {
    let meta = if meta.file_type().is_symlink() {
        let r = resolve(entry);
        if !r.starts_with(root_resolved) || !r.is_file() {
            return None;
        }
        std::fs::metadata(&r).ok()?
    } else if !meta.is_file() {
        return None;
    } else {
        meta
    };
    let rel = entry.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as f64 + d.subsec_nanos() as f64 * 1e-9).unwrap_or(0.0);
    let mut info = json!({"path": rel, "name": name_of(entry), "size": meta.len(), "mtime": mtime, "mime": guess_mime(entry)});
    if ignored {
        info["ignored"] = Value::Bool(true);
    }
    Some(info)
}

/// The listing being built: visible files in walk order, then gitignored ones
/// (flagged `ignored`) once every visible file has a place under the cap.
/// Ignored entries (files and `dir/`s) are only collected during the walk and
/// expanded in [`Listing::finish`], in parallel and only if there is room.
#[derive(Default)]
struct Listing {
    files: Vec<Value>,
    ignored: Vec<PathBuf>,
    truncated: bool,
}

impl Listing {
    fn full(&self) -> bool {
        self.files.len() >= MAX_FILES_LISTED
    }

    fn finish(mut self, root: &Path) -> (Vec<Value>, bool) {
        use rayon::prelude::*;
        let room = MAX_FILES_LISTED.saturating_sub(self.files.len());
        if room == 0 {
            self.truncated |= !self.ignored.is_empty();
            return (self.files, self.truncated);
        }
        let rr = resolve(root);
        // An ignored file, or every file of an ignored directory unless it is
        // too big to be anything but build output.
        let found: Vec<Vec<Value>> = self
            .ignored
            .par_iter()
            .map(|entry| match std::fs::symlink_metadata(entry) {
                Ok(meta) if meta.is_dir() => walk_ignored_dir(root, &rr, entry).unwrap_or_default(),
                Ok(meta) => file_info(entry, root, &rr, meta, true).into_iter().collect(),
                Err(_) => vec![],
            })
            .collect();
        let mut seen = HashSet::new();
        for info in found.into_iter().flatten() {
            if !seen.insert(info["path"].as_str().unwrap_or_default().to_string()) {
                continue;
            }
            if self.files.len() >= MAX_FILES_LISTED {
                self.truncated = true;
                break;
            }
            self.files.push(info);
        }
        (self.files, self.truncated)
    }
}

/// Every file under the gitignored directory `dir`, skipping noise
/// directories and OS clutter. `None` once it holds more than
/// [`MAX_IGNORED_DIR_FILES`]: names are counted with `readdir` alone, so an
/// oversized `target/` is rejected before a single file is stat'ed.
/// Symlinked directories are not followed.
fn walk_ignored_dir(root: &Path, rr: &Path, dir: &Path) -> Option<Vec<Value>> {
    let mut paths = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&current) else { continue };
        let (mut dirs, mut files) = (vec![], vec![]);
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if !NOISE_DIR_NAMES.contains(&n.as_str()) {
                        dirs.push(n);
                    }
                }
                Ok(_) if !is_unlisted_ignored_name(&n) => files.push(n),
                _ => {}
            }
        }
        if paths.len() + files.len() > MAX_IGNORED_DIR_FILES {
            return None;
        }
        files.sort();
        dirs.sort();
        paths.extend(files.iter().map(|f| current.join(f)));
        stack.extend(dirs.into_iter().rev().map(|d| current.join(d)));
    }
    Some(paths.into_iter().filter_map(|p| file_info(&p, root, rr, std::fs::symlink_metadata(&p).ok()?, true)).collect())
}

/// Fills `out`; returns once the visible files reach the cap.
fn collect_files(root: &Path, base: &Path, out: &mut Listing) {
    match git_listed_paths(base) {
        None => walk_files(root, base, out),
        Some((listed, ignored)) => {
            let rr = resolve(root);
            for rel in listed {
                if out.full() {
                    out.truncated = true;
                    return;
                }
                let entry = base.join(rel.trim_end_matches('/'));
                let Ok(meta) = std::fs::symlink_metadata(&entry) else { continue };
                if meta.is_dir() {
                    collect_files(root, &entry, out);
                    if out.truncated {
                        return;
                    }
                    continue;
                }
                if let Some(info) = file_info(&entry, root, &rr, meta, false) {
                    out.files.push(info);
                }
            }
            out.ignored.extend(ignored.iter().map(|rel| base.join(rel.trim_end_matches('/'))));
        }
    }
}

fn walk_files(root: &Path, base: &Path, out: &mut Listing) {
    let rr = resolve(root);
    let gi = load_gitignore(base);
    let rel_of = |p: &Path| p.strip_prefix(base).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let mut stack = vec![base.to_path_buf()];
    // os.walk is top-down, depth-first in sorted-dirname order.
    while let Some(current) = stack.pop() {
        let cur_res = if current == root { rr.clone() } else { resolve(&current) };
        if !cur_res.starts_with(&rr) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&current) else { continue };
        let (mut dirs, mut files): (Vec<String>, Vec<String>) = (vec![], vec![]);
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                dirs.push(n);
            } else {
                files.push(n);
            }
        }
        dirs.retain(|d| !NOISE_DIR_NAMES.contains(&d.as_str()));
        let (ignored_dirs, visible_dirs): (Vec<String>, Vec<String>) = dirs.into_iter().partition(|d| is_gitignored(&gi, &rel_of(&current.join(d)), true));
        let mut dirs = visible_dirs;
        dirs.sort();
        files.sort();
        for f in files {
            if out.full() {
                out.truncated = true;
                return;
            }
            let entry = current.join(&f);
            if is_gitignored(&gi, &rel_of(&entry), false) {
                if !is_unlisted_ignored_name(&f) {
                    out.ignored.push(entry);
                }
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&entry) else { continue };
            if let Some(info) = file_info(&entry, root, &rr, meta, false) {
                out.files.push(info);
            }
        }
        out.ignored.extend(ignored_dirs.into_iter().map(|d| current.join(d)));
        for d in dirs.into_iter().rev() {
            stack.push(current.join(d));
        }
    }
}

fn list_files(root: &Path) -> (Vec<Value>, bool) {
    if !root.is_dir() {
        return (vec![], false);
    }
    let mut out = Listing::default();
    collect_files(root, root, &mut out);
    out.finish(root)
}

async fn list_session_files(State(st): State<AppState>, AxPath(sid): AxPath<String>) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let root = session_workspace(&st, &sid).await?;
    crate::watch::touch_session(&root, &sid);
    let (files, truncated) = blocking(move || list_files(&root)).await;
    Ok(json(json!({"session_id": sid, "files": files, "truncated": truncated})))
}

fn validated(ws: &str) -> ApiResult<String> {
    manager::validate_workspace(ws, true).map_err(ApiError::unprocessable)
}

async fn read_workspace_file(q: Qs, headers: HeaderMap) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let path = q.req("path")?;
    let download = q.bool("download", false)?;
    let root = resolve(Path::new(&validated(&workspace)?));
    let target = resolve(&root.join(&path));
    if !target.starts_with(&root) {
        return Err(ApiError::bad_request("Path escapes workspace root."));
    }
    if !target.is_file() {
        return Err(ApiError::not_found("File not found."));
    }
    let mime = guess_mime(&target);
    let name = name_of(&target);
    Ok(file_response(
        &target,
        &headers,
        FileOpts { media_type: &mime, filename: download.then_some(name.as_str()), disposition: "attachment", extra_headers: &[("cache-control", "no-store")] },
    )
    .await)
}

async fn list_workspace_files(q: Qs) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let resolved = validated(&workspace)?;
    crate::watch::touch_workspace(Path::new(&resolved), &workspace);
    let r2 = resolved.clone();
    let (files, truncated) = blocking(move || list_files(Path::new(&r2))).await;
    Ok(json(json!({"workspace": resolved, "files": files, "truncated": truncated})))
}

// ── git ─────────────────────────────────────────────────────────────────────

/// `_run_git`: stdout on success, `None` on any failure. Read-only calls only.
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

async fn git_diff(q: Qs) -> ApiResult<Response> {
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
    // HEAD probe; a truncated diff just drops the list.
    let (head, listed) = tokio::join!(git(&resolved, &["rev-parse", "--verify", "HEAD"]), git(&resolved, &["ls-files", "--others", "--exclude-standard"]));
    let has_head = head.is_some();
    let mut args: Vec<&str> = if has_head { vec!["diff", "HEAD"] } else { vec!["diff"] };
    args.push("--");
    args.extend(diff_paths.iter().map(String::as_str));
    let (tracked, stderr, code, tracked_trunc) = bounded_git_diff(&resolved, &args, MAX_GIT_DIFF_CHARS).await?;
    if code != 0 && !tracked_trunc {
        let e = stderr.trim();
        return Err(ApiError::new(500, if e.is_empty() { "git diff failed".to_string() } else { e.to_string() }));
    }
    let mut untracked: Vec<String> = vec![];
    let mut full = tracked;
    if !tracked_trunc {
        untracked = listed.map(|o| o.lines().map(String::from).collect()).unwrap_or_default();
        if !scoped.is_empty() {
            untracked.retain(|u| scoped.contains(u));
        }
        let (r, u) = (root.clone(), untracked.clone());
        full.push_str(&blocking(move || untracked_diff(&r, &u)).await);
    }
    let nchars = full.chars().count();
    let truncated = tracked_trunc || nchars > MAX_GIT_DIFF_CHARS;
    let diff: String = if nchars > MAX_GIT_DIFF_CHARS { full.chars().take(MAX_GIT_DIFF_CHARS).collect() } else { full };
    Ok(json(json!({"workspace": resolved, "is_git_repo": true, "diff": diff, "untracked": untracked, "truncated": truncated})))
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

async fn workspace_status(q: Qs) -> ApiResult<Response> {
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

async fn git_history(q: Qs) -> ApiResult<Response> {
    let workspace = q.req("workspace")?;
    let limit = q.int("limit", 50, Some(1), Some(500))?;
    let cursor = q.opt("cursor");
    let all = q.bool("all", false)?;
    let resolved = validated(&workspace)?;
    static OFF_RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^all:([0-9]{1,9})$").unwrap());
    let off = cursor.as_deref().and_then(|c| OFF_RE.captures(c)).map(|c| c[1].parse::<i64>().unwrap_or(0));
    let offset = off.unwrap_or(0);
    if let Some(c) = cursor.as_deref().filter(|c| !c.is_empty()) {
        if !(SHA_RE.is_match(c) || all && off.is_some()) {
            return Err(ApiError::unprocessable("Invalid cursor SHA format."));
        }
    }
    if !Path::new(&resolved).join(".git").exists() {
        return Ok(json(json!({"workspace": resolved, "is_git_repo": false, "commits": [], "next_cursor": null, "graph": ""})));
    }
    let cur = cursor.clone().filter(|c| !c.is_empty());
    let mut log_args: Vec<String> = vec!["log".into()];
    if off.is_some() {
        log_args.push(format!("--skip={offset}"));
    } else if let Some(c) = &cur {
        log_args.extend([c.clone(), "--skip=1".into()]);
    }
    log_args.extend(["-n".into(), (limit + 1).to_string(), "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%d%x1e".into()]);
    if all {
        log_args.extend(["--exclude=refs/stash".into(), "--all".into()]);
    }
    let mut g: Vec<String> = ["log", "--graph", "--oneline", "--decorate", "--color=never", "-n"].map(String::from).to_vec();
    g.push(limit.to_string());
    if off.is_some() {
        g.push(format!("--skip={offset}"));
    } else if let Some(c) = &cur {
        g.extend([c.clone(), "--skip=1".into()]);
    }
    if all {
        g.extend(["--exclude=refs/stash".into(), "--all".into()]);
    }
    let la: Vec<&str> = log_args.iter().map(String::as_str).collect();
    let ga: Vec<&str> = g.iter().map(String::as_str).collect();
    let (log, graph) = tokio::join!(git(&resolved, &la), git(&resolved, &ga));
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
        next = if all { json!(format!("all:{}", offset + limit)) } else { json!(shas[(limit - 1) as usize]) };
        commits.truncate(limit as usize);
    }
    let graph = graph.unwrap_or_default();
    Ok(json(json!({"workspace": resolved, "is_git_repo": true, "commits": commits, "next_cursor": next, "graph": graph})))
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

async fn git_discard(raw: Bytes) -> ApiResult<Response> {
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

async fn commit_diff(q: Qs) -> ApiResult<Response> {
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

async fn git_undo(raw: Bytes) -> ApiResult<Response> {
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

async fn git_revert(raw: Bytes) -> ApiResult<Response> {
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
mod tests {
    use super::*;

    #[test]
    fn normpath_matches_python() {
        assert_eq!(normpath("a/./b/../c"), "a/c");
        assert_eq!(normpath("../x"), "../x");
        assert_eq!(normpath("/a/../../b"), "/b");
        assert_eq!(normpath(""), ".");
    }

    #[test]
    fn porcelain() {
        let p = parse_porcelain_v2("# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 M. N... a\n1 .M N... b\n? c\n");
        assert_eq!((p.branch.as_deref(), p.staged, p.unstaged, p.untracked, p.ahead, p.behind), (Some("main"), 1, 1, 1, Some(2), Some(1)));
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let o = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }

    /// A repo whose index is stale for `a.txt`: same content, newer mtime.
    /// Any git call that refreshes the index here rewrites `.git/index`,
    /// which it can only do while holding `.git/index.lock`.
    fn stat_dirty_repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        git_ok(d.path(), &["init", "-q"]);
        std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
        git_ok(d.path(), &["add", "a.txt"]);
        git_ok(d.path(), &["commit", "-qm", "init"]);
        let f = std::fs::File::options().write(true).open(d.path().join("a.txt")).unwrap();
        f.set_modified(std::time::SystemTime::now() + Duration::from_secs(60)).unwrap();
        d
    }

    /// The status endpoint runs on every agent tool call. If it takes
    /// `.git/index.lock`, the agent's own `git add`/`commit` collides with
    /// it, and a killed status strands the lock.
    #[tokio::test]
    async fn status_does_not_lock_the_index() {
        let d = stat_dirty_repo();
        let index = d.path().join(".git/index");
        let before = std::fs::read(&index).unwrap();
        assert!(git(d.path().to_str().unwrap(), &["status", "--porcelain=v2", "--branch"]).await.is_some());
        assert!(std::fs::read(&index).unwrap() == before, "`git status` refreshed .git/index, so it held index.lock");
    }

    /// `git diff` ignores `--no-optional-locks` and refreshes the index on
    /// its own unless `diff.autoRefreshIndex` is off.
    #[tokio::test]
    async fn diff_does_not_lock_the_index() {
        let d = stat_dirty_repo();
        let index = d.path().join(".git/index");
        let before = std::fs::read(&index).unwrap();
        let (_, stderr, code, _) = bounded_git_diff(d.path().to_str().unwrap(), &["diff", "HEAD", "--", "."], 1024).await.unwrap();
        assert_eq!(code, 0, "{stderr}");
        assert!(std::fs::read(&index).unwrap() == before, "`git diff` refreshed .git/index, so it held index.lock");
    }

    fn repo_on_main() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        git_ok(d.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
        git_ok(d.path(), &["add", "a.txt"]);
        git_ok(d.path(), &["commit", "-qm", "init"]);
        d
    }

    fn commit(dir: &Path, file: &str) {
        std::fs::write(dir.join(file), file).unwrap();
        git_ok(dir, &["add", file]);
        git_ok(dir, &["commit", "-qm", file]);
    }

    fn ws_query(dir: &Path, extra: &str) -> Qs {
        Qs::parse(&format!("workspace={}{extra}", form_urlencoded::byte_serialize(dir.to_str().unwrap().as_bytes()).collect::<String>()))
    }

    async fn body_of(r: Response) -> Value {
        serde_json::from_slice(&axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    async fn status_of(dir: &Path) -> Value {
        body_of(workspace_status(ws_query(dir, "")).await.unwrap()).await
    }

    fn upstream_fields(v: &Value) -> (Value, Value, Value) {
        (v["upstream"].clone(), v["commits_ahead"].clone(), v["commits_behind"].clone())
    }

    #[tokio::test]
    async fn status_on_main_without_remote_has_no_upstream() {
        let d = repo_on_main();
        std::fs::write(d.path().join("a.txt"), "changed\n").unwrap();
        std::fs::write(d.path().join("new.txt"), "n").unwrap();
        let v = status_of(d.path()).await;
        assert_eq!(v["branch"], "main");
        assert_eq!(v["dirty"], json!({"staged": 0, "unstaged": 1, "untracked": 1}));
        assert_eq!(v["head"]["subject"], "init");
        assert_eq!(upstream_fields(&v), (Value::Null, Value::Null, Value::Null));
    }

    #[tokio::test]
    async fn status_without_remote_compares_a_branch_with_local_main() {
        let d = repo_on_main();
        git_ok(d.path(), &["checkout", "-qb", "feature"]);
        commit(d.path(), "b.txt");
        commit(d.path(), "c.txt");
        assert_eq!(upstream_fields(&status_of(d.path()).await), (json!("main"), json!(2), json!(0)));
    }

    #[tokio::test]
    async fn status_uses_the_tracking_upstream() {
        let origin = repo_on_main();
        let d = tempfile::tempdir().unwrap();
        git_ok(d.path(), &["clone", "-q", origin.path().to_str().unwrap(), "."]);
        commit(d.path(), "b.txt");
        commit(origin.path(), "o.txt");
        git_ok(d.path(), &["fetch", "-q"]);
        assert_eq!(upstream_fields(&status_of(d.path()).await), (json!("origin/main"), json!(1), json!(1)));
    }

    #[tokio::test]
    async fn status_prefers_origin_branch_when_nothing_is_tracked() {
        let origin = repo_on_main();
        git_ok(origin.path(), &["checkout", "-qb", "feature"]);
        commit(origin.path(), "f.txt");
        git_ok(origin.path(), &["checkout", "-q", "main"]);
        let d = tempfile::tempdir().unwrap();
        git_ok(d.path(), &["clone", "-q", origin.path().to_str().unwrap(), "."]);
        // Local `feature` with no tracking config, one commit past origin/feature.
        git_ok(d.path(), &["checkout", "-q", "--no-track", "-b", "feature", "origin/feature"]);
        commit(d.path(), "g.txt");
        assert_eq!(upstream_fields(&status_of(d.path()).await), (json!("origin/feature"), json!(1), json!(0)));
    }

    #[tokio::test]
    async fn history_pages_commits_with_a_graph() {
        let d = repo_on_main();
        commit(d.path(), "b.txt");
        commit(d.path(), "c.txt");
        let v = body_of(git_history(ws_query(d.path(), "&limit=2")).await.unwrap()).await;
        let subjects: Vec<&str> = v["commits"].as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap()).collect();
        assert_eq!(subjects, ["c.txt", "b.txt"]);
        assert_eq!(v["commits"][0]["refs"], "HEAD -> main");
        assert_eq!(v["next_cursor"], v["commits"][1]["sha"]);
        let graph = v["graph"].as_str().unwrap();
        assert_eq!(graph.lines().count(), 2);
        assert!(graph.starts_with("* ") && graph.contains("c.txt"), "{graph}");
        let cursor = v["next_cursor"].as_str().unwrap().to_string();
        let next = body_of(git_history(ws_query(d.path(), &format!("&limit=2&cursor={cursor}"))).await.unwrap()).await;
        assert_eq!(next["commits"].as_array().unwrap().len(), 1);
        assert_eq!(next["commits"][0]["subject"], "init");
        assert_eq!(next["next_cursor"], Value::Null);
        assert!(next["graph"].as_str().unwrap().contains("init"));
        let all = body_of(git_history(ws_query(d.path(), "&limit=1&all=true")).await.unwrap()).await;
        assert_eq!(all["next_cursor"], "all:1");
    }

    #[tokio::test]
    async fn diff_covers_tracked_and_untracked_changes() {
        let d = repo_on_main();
        std::fs::write(d.path().join("a.txt"), "changed\n").unwrap();
        std::fs::write(d.path().join("new.txt"), "n\n").unwrap();
        let v = body_of(git_diff(ws_query(d.path(), "")).await.unwrap()).await;
        let diff = v["diff"].as_str().unwrap();
        assert!(diff.contains("+changed") && diff.contains("new.txt"), "{diff}");
        assert_eq!(v["untracked"], json!(["new.txt"]));
        assert_eq!(v["truncated"], false);
        let scoped = body_of(git_diff(ws_query(d.path(), "&paths=new.txt")).await.unwrap()).await;
        assert_eq!(scoped["untracked"], json!(["new.txt"]));
        assert!(!scoped["diff"].as_str().unwrap().contains("+changed"));
    }

    #[tokio::test]
    async fn diff_works_before_the_first_commit() {
        let d = tempfile::tempdir().unwrap();
        git_ok(d.path(), &["init", "-q"]);
        std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
        git_ok(d.path(), &["add", "a.txt"]);
        std::fs::write(d.path().join("b.txt"), "b\n").unwrap();
        let v = body_of(git_diff(ws_query(d.path(), "")).await.unwrap()).await;
        assert_eq!(v["is_git_repo"], true);
        assert_eq!(v["untracked"], json!(["b.txt"]));
        assert!(v["diff"].as_str().unwrap().contains("b.txt"));
    }

    fn listed(root: &Path) -> Vec<String> {
        list_files(root).0.iter().map(|f| f["path"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn list_files_merges_tracked_and_untracked_in_git_order() {
        let d = repo_on_main();
        std::fs::create_dir_all(d.path().join("src/deep")).unwrap();
        std::fs::create_dir_all(d.path().join("node_modules/x")).unwrap();
        std::fs::write(d.path().join("src/deep/t.rs"), "t").unwrap();
        commit(d.path(), "src/deep/t.rs");
        std::fs::write(d.path().join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(d.path().join("b.txt"), "b").unwrap();
        std::fs::write(d.path().join("skip.log"), "l").unwrap();
        std::fs::write(d.path().join("node_modules/x/i.js"), "i").unwrap();
        // Gitignored files come last; untracked noise directories never.
        assert_eq!(listed(d.path()), [".gitignore", "a.txt", "b.txt", "src/deep/t.rs", "skip.log"]);
        // A subdirectory is git-listed too, so the root's ignore rules apply.
        std::fs::write(d.path().join("src/u.rs"), "u").unwrap();
        assert_eq!(listed(&d.path().join("src")), ["deep/t.rs", "u.rs"]);
    }

    #[test]
    fn a_subdirectory_workspace_honours_the_repo_root_gitignore() {
        let d = repo_on_main();
        std::fs::write(d.path().join(".gitignore"), "app/target/\nout/\n").unwrap();
        for f in ["app/src/m.rs", "app/target/debug/a.o", "out/clip.mp4"] {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        for i in 0..=MAX_IGNORED_DIR_FILES {
            std::fs::write(d.path().join(format!("app/target/debug/{i}.o")), "o").unwrap();
        }
        // Only the root `.gitignore` names `app/target/`: the old root-only
        // walk of `app/` listed every build artefact as a visible file.
        assert_eq!(listed(&d.path().join("app")), ["src/m.rs"]);
        // A workspace that is itself ignored is walked as before.
        assert_eq!(listed(&d.path().join("out")), ["clip.mp4"]);
    }

    /// Paths flagged `ignored` in a listing.
    fn ignored_of(root: &Path) -> Vec<String> {
        list_files(root).0.iter().filter(|f| f["ignored"] == true).map(|f| f["path"].as_str().unwrap().to_string()).collect()
    }

    /// Ignored media, a nested noise dir, OS clutter and an oversized build dir.
    fn ignored_tree(root: &Path) {
        std::fs::write(root.join(".gitignore"), "out/\nbuild/\n*.log\n.DS_Store\nnode_modules/\n.env\n").unwrap();
        for f in [
            "out/clip.mp4",
            "out/nested/frame.png",
            "out/node_modules/p.js",
            "out/.DS_Store",
            "web/node_modules/q.js",
            "debug.log",
            ".DS_Store",
            "keep.txt",
            ".env",
            "out/.env.local",
        ] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        std::fs::create_dir_all(root.join("build")).unwrap();
        for i in 0..=MAX_IGNORED_DIR_FILES {
            std::fs::write(root.join(format!("build/{i}.o")), "o").unwrap();
        }
    }

    #[test]
    fn list_files_appends_gitignored_files_after_visible_ones() {
        let d = repo_on_main();
        ignored_tree(d.path());
        let all = listed(d.path());
        assert_eq!(all, [".gitignore", "a.txt", "keep.txt", "debug.log", "out/clip.mp4", "out/nested/frame.png"]);
        assert_eq!(ignored_of(d.path()), ["debug.log", "out/clip.mp4", "out/nested/frame.png"]);
    }

    #[test]
    fn walked_listing_appends_gitignored_files_after_visible_ones() {
        let d = tempfile::tempdir().unwrap();
        ignored_tree(d.path());
        assert_eq!(listed(d.path()), [".gitignore", "keep.txt", "debug.log", "out/clip.mp4", "out/nested/frame.png"]);
        assert_eq!(ignored_of(d.path()), ["debug.log", "out/clip.mp4", "out/nested/frame.png"]);
    }

    #[test]
    fn ignored_files_never_displace_visible_ones() {
        let d = tempfile::tempdir().unwrap();
        for f in ["i1", "i2"] {
            std::fs::write(d.path().join(f), "x").unwrap();
        }
        let mut l = Listing { files: (0..MAX_FILES_LISTED - 1).map(|i| json!({"path": format!("v{i}")})).collect(), ..Default::default() };
        l.ignored = vec![d.path().join("i1"), d.path().join("i1"), d.path().join("i2")];
        let (files, truncated) = l.finish(d.path());
        assert_eq!(files.len(), MAX_FILES_LISTED);
        assert_eq!(files.last().unwrap()["path"], "i1");
        assert_eq!(files.last().unwrap()["ignored"], true);
        assert!(truncated);
        // With the visible files at the cap, ignored entries are not expanded.
        let full = Listing { files: (0..MAX_FILES_LISTED).map(|i| json!({"path": format!("v{i}")})).collect(), ignored: vec![d.path().join("i1")], truncated: true };
        assert_eq!(full.finish(d.path()).0.len(), MAX_FILES_LISTED);
    }

    #[tokio::test]
    async fn listing_answers_304_while_unchanged() {
        let d = repo_on_main();
        let first = with_etag(&HeaderMap::new(), list_workspace_files(ws_query(d.path(), "")).await.unwrap()).await;
        assert_eq!(first.status(), 200);
        let tag = first.headers()[axum::http::header::ETAG].clone();
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::IF_NONE_MATCH, tag.clone());
        let again = with_etag(&h, list_workspace_files(ws_query(d.path(), "")).await.unwrap()).await;
        assert_eq!(again.status(), 304);
        assert!(axum::body::to_bytes(again.into_body(), usize::MAX).await.unwrap().is_empty());
        std::fs::write(d.path().join("new.txt"), "n").unwrap();
        let changed = with_etag(&h, list_workspace_files(ws_query(d.path(), "")).await.unwrap()).await;
        assert_eq!(changed.status(), 200);
        assert_ne!(changed.headers()[axum::http::header::ETAG], tag);
    }
}
