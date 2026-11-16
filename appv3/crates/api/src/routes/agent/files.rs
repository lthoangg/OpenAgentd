//! A session's uploads and media, a workspace's files and its file listing
//! (Quick Open, the `@` picker), cached per watcher generation. The git
//! panels are in `git`.

use crate::error::{ApiError, ApiResult};
use crate::fileresp::{file_response, FileOpts};
use crate::util::*;
use crate::AppState;
use appv3_agent::manager;
use appv3_agent::session::session_workspace_dir;
use appv3_db as db;
use appv3_tools::grep::{load_gitignore, MAX_IGNORED_DIR_FILES, NOISE_DIR_NAMES};
use axum::extract::{Path as AxPath, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use git::{commit_diff, git_diff, git_diff_files, git_discard, git_history, git_revert, git_undo, workspace_status};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

mod git;

const MAX_FILES_LISTED: usize = 5_000;
// A gitignored directory holding more than `MAX_IGNORED_DIR_FILES` is build
// output or a cache (`target/`, `dist/`), not something to browse, so it is
// left out whole rather than crowding out other ignored files. The agent's
// `grep` / `glob` and the file watcher use the same cap.
const JUNK_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// Ignored files never listed: OS clutter, and `.env` / `.env.*` secrets,
/// which stay out of Quick Open and the `@` picker as they did before ignored
/// files were listed (a tracked `.env.example` is visible, not ignored).
fn is_unlisted_ignored_name(name: &str) -> bool {
    JUNK_FILE_NAMES.contains(&name) || name == ".env" || name.starts_with(".env.")
}
/// Global flags for the panels' read-only git calls, which run after every
/// agent tool call. Without them `git status` and `git diff` take
/// `.git/index.lock` to save a refreshed index, so the agent's own `git
/// add`/`commit` collides with them, and a killed call strands the lock.
/// `git diff` ignores `--no-optional-locks`, hence `diff.autoRefreshIndex`.
const READ_ONLY_GIT: [&str; 3] = ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{session_id}/uploads/{filename}", get(get_upload))
        .route("/{session_id}/media/{*file_path}", get(get_media))
        .route("/{session_id}/files", get(|st: State<AppState>, sid: AxPath<String>, h: HeaderMap| async move { etagged(&h, list_session_files(st, sid).await).await }))
        .route("/workspace/files/read", get(read_workspace_file))
        // Polled after every tool call: ETag / 304 (see `with_etag`).
        .route("/workspace/files/list", get(|h: HeaderMap, q: Qs| async move { etagged(&h, list_workspace_files(q).await).await }))
        .route("/workspace/git-diff/view", get(|h: HeaderMap, q: Qs| async move { etagged(&h, git_diff(q).await).await }))
        .route("/workspace/git-diff/files", get(|h: HeaderMap, q: Qs| async move { etagged(&h, git_diff_files(q).await).await }))
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

/// MIME type guess (TypeScript overrides the stdlib's `video/mp2t`).
fn guess_mime(p: &Path) -> String {
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
    // Each upload gets a name of its own (`dedupe_upload_filename`), so the
    // bytes behind a URL do not change: the browser keeps them.
    let cache = &[("cache-control", "private, max-age=31536000, immutable")];
    Ok(file_response(&resolved, &headers, FileOpts { media_type: &mime, filename: Some(&name), disposition: "attachment", extra_headers: cache }).await)
}

async fn get_media(State(st): State<AppState>, AxPath((sid, file_path)): AxPath<(String, String)>, q: Qs, headers: HeaderMap) -> ApiResult<Response> {
    let download = q.bool("download", false)?;
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let resolved = safe_resolve(&session_workspace(&st, &sid).await?, &file_path)?;
    let mime = guess_mime(&resolved);
    let name = name_of(&resolved);
    // A workspace file can change under the same path: revalidate (a 304 when it did not).
    let cache = &[("cache-control", "private, no-cache")];
    Ok(file_response(&resolved, &headers, FileOpts { media_type: &mime, filename: Some(&name), disposition: if download { "attachment" } else { "inline" }, extra_headers: cache })
        .await)
}

// ── listings ────────────────────────────────────────────────────────────────

fn git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    #[cfg(test)]
    tests::count_git_spawn(cwd);
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
    // Two independent git spawns (~10 ms each): run them side by side. `-t`
    // tags untracked paths `? `. The ignored ones need a call of their own:
    // `--ignored` next to `--cached` would mean "tracked yet ignored".
    let (listed, ignored) = std::thread::scope(|s| {
        let listed = s.spawn(|| git_stdout(base, &["ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard"]));
        let ignored = git_stdout(base, &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
        (listed.join().ok().flatten(), ignored)
    });
    let (listed, ignored) = (listed?, ignored?);
    if ignored.split('\0').any(|r| r == "./") {
        return None;
    }
    let mut paths = BTreeSet::new();
    for row in listed.split('\0') {
        // `<tag> <path>`: one row per stage of a conflicted path, deduplicated here.
        let Some((tag, rel)) = row.split_once(' ') else { continue };
        if tag != "?" {
            paths.insert(rel.to_string());
            continue;
        }
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
        let (ignored_dirs, visible_dirs): (Vec<String>, Vec<String>) = dirs.into_iter().partition(|d| gi.matched(&rel_of(&current.join(d)), true));
        let mut dirs = visible_dirs;
        dirs.sort();
        files.sort();
        for f in files {
            if out.full() {
                out.truncated = true;
                return;
            }
            let entry = current.join(&f);
            if gi.matched(&rel_of(&entry), false) {
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

/// Workspaces whose listing is kept: the file watcher's cap.
const MAX_CACHED_LISTINGS: usize = 16;

/// `(size, mtime_ns)` of a file, `None` when it is missing.
type FileSig = Option<(u64, i128)>;

fn file_sig(p: &Path) -> FileSig {
    let m = std::fs::metadata(p).ok()?;
    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as i128).unwrap_or(0);
    Some((m.len(), mtime))
}

/// A workspace listing and what it was computed against.
struct CachedListing {
    generation: u64,
    /// The git index and its signature. The watcher skips `.git/index` (git
    /// status rewrites it), but `git rm --cached` / `git add -f` move a file
    /// between visible and ignored without touching the work tree.
    index: Option<(PathBuf, FileSig)>,
    files: Vec<Value>,
    truncated: bool,
    used: Instant,
}

fn listings() -> &'static Mutex<HashMap<PathBuf, CachedListing>> {
    static L: LazyLock<Mutex<HashMap<PathBuf, CachedListing>>> = LazyLock::new(Mutex::default);
    &L
}

/// The index file of the repo holding `root` (also for a subdirectory or a
/// linked worktree, whose index lives outside it); `None` outside git.
fn git_index_path(root: &Path) -> Option<PathBuf> {
    let out = git_stdout(root, &["rev-parse", "--git-path", "index"])?;
    let p = PathBuf::from(out.trim_end_matches(['\n', '\r']));
    Some(if p.is_absolute() { p } else { root.join(p) })
}

/// The file listing of `root`. It is polled after every `patch`/`shell`
/// call, so while the workspace's watcher reports no change and the git
/// index is untouched, the last listing is reused: no git process, no stat
/// per file. A change that lands just before a poll can still be missed
/// until the watcher's event arrives; that event also makes the UI fetch
/// the listing again, by when the generation has moved.
fn list_files(root: &Path) -> (Vec<Value>, bool) {
    if !root.is_dir() {
        return (vec![], false);
    }
    let Ok(key) = dunce::canonicalize(root) else { return list_files_now(root) };
    let Some(generation) = crate::watch::generation(&key) else {
        listings().lock().unwrap().remove(&key);
        return list_files_now(root);
    };
    let known_index = {
        let mut cache = listings().lock().unwrap();
        let entry = cache.get_mut(&key);
        let known_index = entry.as_ref().and_then(|c| c.index.as_ref()).map(|(p, _)| p.clone());
        if let Some(hit) = entry.filter(|c| c.generation == generation && c.index.as_ref().is_none_or(|(p, sig)| file_sig(p) == *sig)) {
            hit.used = Instant::now();
            return (hit.files.clone(), hit.truncated);
        }
        known_index
    };
    // Read before listing: a change made meanwhile moves them, so the entry
    // stored below is not reused past it.
    let index = known_index.filter(|p| index_path_still_holds(root, p)).or_else(|| git_index_path(root)).map(|p| {
        let sig = file_sig(&p);
        (p, sig)
    });
    let (files, truncated) = list_files_now(root);
    let mut cache = listings().lock().unwrap();
    cache.insert(key, CachedListing { generation, index, files: files.clone(), truncated, used: Instant::now() });
    while cache.len() > MAX_CACHED_LISTINGS {
        let Some(oldest) = cache.iter().min_by_key(|(_, c)| c.used).map(|(k, _)| k.clone()) else { break };
        cache.remove(&oldest);
    }
    (files, truncated)
}

/// Whether the index path found for `root` earlier can be reused without
/// asking git again (a `git rev-parse` per miss, and every `patch` makes the
/// next poll miss). It moves only when its repo goes away or `root` gets a
/// repo of its own (`git init` in a subdirectory workspace). A root that had
/// no repo is always asked again, so a `git init` there is noticed.
fn index_path_still_holds(root: &Path, index: &Path) -> bool {
    let own_git = root.join(".git");
    index.parent().is_some_and(Path::is_dir) && (!own_git.is_dir() || index.starts_with(&own_git))
}

fn list_files_now(root: &Path) -> (Vec<Value>, bool) {
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

#[cfg(test)]
mod tests;
