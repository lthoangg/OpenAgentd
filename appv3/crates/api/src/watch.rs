//! Live workspace change notifications (v3-only; v2 has no OS watcher).
//!
//! The web UI only refreshes its file tree, git status and diff after the
//! agent's own file-mutating tools. This module watches workspaces the UI is
//! looking at and publishes a debounced `workspace_files_changed` global event
//! when anything else (an editor, a terminal, `git`) changes them. It is purely
//! an accelerator: every consumer still re-reads the disk, so a missed event
//! only means the old refresh-on-focus behaviour.
//!
//! Backends per OS (one filter/debounce pipeline for all of them):
//! - **macOS**: one recursive FSEvents stream; kernel drops arrive as
//!   `Flag::Rescan` and become a full refresh.
//! - **Windows**: one recursive `ReadDirectoryChangesW`. notify drops buffer
//!   overflows silently, but an overflow only happens inside a burst whose
//!   other events still trigger a whole-workspace refresh (trailing debounce).
//! - **Linux/other**: inotify cannot watch recursively, and notify's recursive
//!   mode would spend watches on `node_modules`/`target`. We add one
//!   non-recursive watch per *non-ignored* directory, follow new directories,
//!   and stop cleanly at `fs.inotify.max_user_watches`.
//! - **Network mounts** (NFS/SMB/9p/WSL drvfs/sshfs, where inotify misses
//!   remote writes) and `OPENAGENTD_FS_WATCH=poll`: the same per-directory
//!   layout on notify's poll backend. `OPENAGENTD_FS_WATCH=off` disables it.

use appv3_agent::broadcaster;
use appv3_tools::grep::{is_gitignored, is_searchable_ignored_dir, load_gitignore, Ignores, NOISE_DIR_NAMES};
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::{Duration, Instant};

pub const EVENT: &str = "workspace_files_changed";

const DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_BATCH_WAIT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_WATCHED_WORKSPACES: usize = 16;
const MAX_DIRS_NATIVE: usize = 20_000;
const MAX_DIRS_POLL: usize = 2_000;
const MAX_PATHS_REPORTED: usize = 100;
const MAX_ALIASES: usize = 32;
const IDLE_NO_CLIENTS: Duration = Duration::from_secs(120);
const IDLE_MAX: Duration = Duration::from_secs(30 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// How long a gitignored directory's "too big to list" verdict is trusted.
const BIG_DIR_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    /// One recursive native watch (FSEvents / ReadDirectoryChangesW).
    Recursive,
    /// One non-recursive native watch per non-ignored directory (inotify).
    PerDir,
    /// Per-directory polling (network filesystems).
    Poll(Duration),
}

fn backend_for(root: &Path) -> Option<Backend> {
    match std::env::var("OPENAGENTD_FS_WATCH").unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "off" | "0" | "false" | "no" => return None,
        "poll" => return Some(Backend::Poll(POLL_INTERVAL)),
        _ => {}
    }
    if remote_fs(root) {
        return Some(Backend::Poll(POLL_INTERVAL));
    }
    // Wine's ReadDirectoryChangesW ignores bWatchSubtree (only top-level
    // changes arrive); per-directory watches work there.
    if appv3_core::platform::under_wine() {
        return Some(Backend::PerDir);
    }
    Some(if cfg!(any(target_os = "macos", windows)) { Backend::Recursive } else { Backend::PerDir })
}

/// Whether `root` lives on a filesystem where inotify misses remote writes.
#[cfg(target_os = "linux")]
fn remote_fs(root: &Path) -> bool {
    const REMOTE: &[&str] = &["nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "drvfs", "fuse.sshfs", "fuse.rclone"];
    let Ok(mounts) = std::fs::read_to_string("/proc/self/mounts") else { return false };
    mount_fstype(&mounts, root).is_some_and(|t| REMOTE.contains(&t.as_str()))
}

#[cfg(not(target_os = "linux"))]
fn remote_fs(_root: &Path) -> bool {
    false
}

/// Filesystem type of the longest mount point containing `path` (`/proc/mounts` format).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn mount_fstype(mounts: &str, path: &Path) -> Option<String> {
    // /proc/mounts escapes space, tab, newline and backslash as octal.
    fn unescape(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
                out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
                i += 4;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    let mut best: Option<(usize, String)> = None;
    for line in mounts.lines() {
        let mut f = line.split(' ');
        let (Some(_dev), Some(mnt), Some(fstype)) = (f.next(), f.next(), f.next()) else { continue };
        let mnt = unescape(mnt);
        if path.starts_with(&mnt) && best.as_ref().is_none_or(|(len, _)| mnt.len() >= *len) {
            best = Some((mnt.len(), fstype.to_string()));
        }
    }
    best.map(|(_, t)| t)
}

// ── filtering ───────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum Class {
    Ignore,
    /// A ref moved (commit, checkout, fetch): git status/diff may change.
    Git,
    File,
}

/// The outermost gitignored directory holding `rel` (or `rel` itself when it
/// is an ignored directory); `None` for an ignored file outside one.
fn outermost_ignored_dir(rel: &str, is_dir: bool, gi: &Ignores) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let dirs = if is_dir { parts.len() } else { parts.len() - 1 };
    (1..=dirs).map(|n| parts[..n].join("/")).find(|d| is_gitignored(gi, d, true))
}

/// Classify a workspace-relative `/`-separated path. `.git/index` is ignored on
/// purpose: `git status` (run by our own status endpoint) rewrites it, which
/// would otherwise feed back into another refresh.
///
/// Gitignored paths count like any other file — the panel lists them —
/// except inside an ignored directory `is_big` reports as too big to list
/// (`target/`): the listing leaves it out, so its churn during a build would
/// only refresh the panel for nothing.
fn classify(rel: &str, is_dir: bool, gi: &Ignores, is_big: &dyn Fn(&str) -> bool) -> Class {
    if rel.is_empty() {
        return Class::Ignore;
    }
    if let Some(rest) = rel.strip_prefix(".git/") {
        return if rest == "HEAD" || rest == "packed-refs" || (rest.starts_with("refs/") && !rest.ends_with(".lock")) { Class::Git } else { Class::Ignore };
    }
    if rel.split('/').any(|c| NOISE_DIR_NAMES.contains(&c)) {
        return Class::Ignore;
    }
    if is_gitignored(gi, rel, is_dir) && outermost_ignored_dir(rel, is_dir, gi).is_some_and(|d| is_big(&d)) {
        return Class::Ignore;
    }
    Class::File
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

// ── per-workspace state ─────────────────────────────────────────────────────

struct Ctx {
    root: PathBuf,
    backend: Backend,
    gitignore: RwLock<Ignores>,
    /// Gitignored directories (relative) and whether they are too big to list,
    /// with when that was checked.
    big_dirs: Mutex<HashMap<String, (bool, Instant)>>,
    aliases: Mutex<BTreeSet<String>>,
    sessions: Mutex<BTreeSet<String>>,
    limit_warned: std::sync::atomic::AtomicBool,
}

impl Ctx {
    /// Whether the gitignored directory `rel` is too big to list, counted at
    /// most once per [`BIG_DIR_TTL`] so a build's event flood stays cheap.
    fn is_big_ignored_dir(&self, rel: &str) -> bool {
        if let Some((big, at)) = self.big_dirs.lock().unwrap().get(rel) {
            if at.elapsed() < BIG_DIR_TTL {
                return *big;
            }
        }
        let big = !is_searchable_ignored_dir(&self.root.join(rel));
        self.big_dirs.lock().unwrap().insert(rel.to_string(), (big, Instant::now()));
        big
    }

    fn classify(&self, rel: &str, is_dir: bool, gi: &Ignores) -> Class {
        classify(rel, is_dir, gi, &|d| self.is_big_ignored_dir(d))
    }
}

enum Msg {
    Changed { rel: String, git: bool, new_dir: Option<PathBuf> },
    Rescan,
    Limit,
}

type SharedWatcher = Arc<Mutex<Box<dyn Watcher + Send>>>;

fn handle(ctx: &Ctx, tx: &Sender<Msg>, res: notify::Result<Event>) {
    let ev = match res {
        Ok(ev) => ev,
        Err(e) => {
            if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) {
                let _ = tx.send(Msg::Limit);
            } else {
                tracing::debug!("fs_watch_error workspace={} err={}", ctx.root.display(), e);
            }
            return;
        }
    };
    if ev.need_rescan() {
        let _ = tx.send(Msg::Rescan);
        return;
    }
    if matches!(ev.kind, EventKind::Access(_)) {
        return;
    }
    let per_dir = !matches!(ctx.backend, Backend::Recursive);
    for path in &ev.paths {
        let Some(rel) = rel_of(&ctx.root, path) else { continue };
        let is_dir = std::fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        let class = ctx.classify(&rel, is_dir, &ctx.gitignore.read().unwrap());
        if class == Class::Ignore {
            continue;
        }
        let new_dir =
            (per_dir && is_dir && class == Class::File && matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) | EventKind::Any))
                .then(|| path.clone());
        let _ = tx.send(Msg::Changed { rel, git: class == Class::Git, new_dir });
    }
}

/// Non-recursive watches on `dir` and every directory below it that
/// [`classify`] keeps (noise and big gitignored directories are skipped).
/// Returns `Err(())` once the OS watch limit (or our cap) is hit.
fn watch_tree(ctx: &Ctx, watcher: &mut dyn Watcher, dir: &Path, count: &mut usize) -> Result<(), ()> {
    let cap = if matches!(ctx.backend, Backend::Poll(_)) { MAX_DIRS_POLL } else { MAX_DIRS_NATIVE };
    let gi = ctx.gitignore.read().unwrap().clone();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        if *count >= cap {
            return Err(());
        }
        match watcher.watch(&cur, RecursiveMode::NonRecursive) {
            Ok(()) => *count += 1,
            Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => return Err(()),
            Err(_) => continue,
        }
        let Ok(rd) = std::fs::read_dir(&cur) else { continue };
        for e in rd.flatten() {
            // Never follow symlinks: they may leave the workspace or loop.
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let p = e.path();
            let Some(rel) = rel_of(&ctx.root, &p) else { continue };
            if ctx.classify(&rel, true, &gi) == Class::File {
                stack.push(p);
            }
        }
    }
    Ok(())
}

fn warn_limit(ctx: &Ctx, dirs: usize) {
    if !ctx.limit_warned.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!(
            "fs_watch_limit workspace={} watched_dirs={} backend={:?} (external changes in unwatched directories refresh on focus; on Linux raise fs.inotify.max_user_watches)",
            ctx.root.display(),
            dirs,
            ctx.backend
        );
    }
}

fn start(root: PathBuf, backend: Backend) -> notify::Result<(Arc<Ctx>, SharedWatcher)> {
    let ctx = Arc::new(Ctx {
        gitignore: RwLock::new(load_gitignore(&root)),
        big_dirs: Mutex::default(),
        root,
        backend,
        aliases: Mutex::default(),
        sessions: Mutex::default(),
        limit_warned: Default::default(),
    });
    let (tx, rx) = channel::<Msg>();
    let (hctx, htx) = (ctx.clone(), tx);
    let handler = move |res: notify::Result<Event>| handle(&hctx, &htx, res);
    let mut watcher: Box<dyn Watcher + Send> = match backend {
        Backend::Poll(every) => Box::new(PollWatcher::new(handler, Config::default().with_poll_interval(every))?),
        _ => Box::new(RecommendedWatcher::new(handler, Config::default())?),
    };
    let mut dirs = 0;
    match backend {
        Backend::Recursive => watcher.watch(&ctx.root, RecursiveMode::Recursive)?,
        Backend::PerDir | Backend::Poll(_) => {
            let git = ctx.root.join(".git");
            if git.is_dir() {
                // HEAD/packed-refs live directly in .git; refs are few and small.
                let _ = watcher.watch(&git, RecursiveMode::NonRecursive);
                let _ = watcher.watch(&git.join("refs"), RecursiveMode::Recursive);
            }
            if watch_tree(&ctx, watcher.as_mut(), &ctx.root.clone(), &mut dirs).is_err() {
                warn_limit(&ctx, dirs);
            }
        }
    }
    tracing::debug!("fs_watch_started workspace={} backend={:?} dirs={}", ctx.root.display(), backend, dirs);
    let shared: SharedWatcher = Arc::new(Mutex::new(watcher));
    let (tctx, weak) = (ctx.clone(), Arc::downgrade(&shared));
    std::thread::Builder::new().name("oad-fs-watch".into()).spawn(move || run(rx, tctx, weak, dirs)).map_err(notify::Error::io)?;
    Ok((ctx, shared))
}

/// Debounce loop. Exits when the watcher (and with it the handler's sender)
/// is dropped.
fn run(rx: Receiver<Msg>, ctx: Arc<Ctx>, watcher: Weak<Mutex<Box<dyn Watcher + Send>>>, mut dirs: usize) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let started = Instant::now();
        let mut batch = vec![first];
        loop {
            let wait = DEBOUNCE.min(MAX_BATCH_WAIT.saturating_sub(started.elapsed()));
            match rx.recv_timeout(wait) {
                Ok(m) => batch.push(m),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let (mut paths, mut git, mut rescan, mut new_dirs) = (BTreeSet::new(), false, false, vec![]);
        for m in batch {
            match m {
                Msg::Changed { rel, git: g, new_dir } => {
                    git |= g;
                    // Any `.gitignore` (nested ones count too) changes the rules.
                    if rel == ".gitignore" || rel.ends_with("/.gitignore") {
                        *ctx.gitignore.write().unwrap() = load_gitignore(&ctx.root);
                        ctx.big_dirs.lock().unwrap().clear();
                    }
                    if !g {
                        paths.insert(rel);
                    }
                    new_dirs.extend(new_dir);
                }
                Msg::Rescan => rescan = true,
                Msg::Limit => warn_limit(&ctx, dirs),
            }
        }
        if !new_dirs.is_empty() {
            let Some(w) = watcher.upgrade() else { return };
            let mut w = w.lock().unwrap();
            for d in new_dirs {
                if watch_tree(&ctx, w.as_mut(), &d, &mut dirs).is_err() {
                    warn_limit(&ctx, dirs);
                    break;
                }
            }
        }
        if paths.is_empty() && !git && !rescan {
            continue;
        }
        let truncated = paths.len() > MAX_PATHS_REPORTED;
        let paths: Vec<String> = paths.into_iter().take(MAX_PATHS_REPORTED).collect();
        let aliases: Vec<String> = ctx.aliases.lock().unwrap().iter().cloned().collect();
        let sessions: Vec<String> = ctx.sessions.lock().unwrap().iter().cloned().collect();
        broadcaster::publish(
            EVENT,
            json!({
                "workspace": ctx.root.to_string_lossy(),
                "aliases": aliases,
                "session_ids": sessions,
                "paths": paths,
                "truncated": truncated,
                "git": git,
                "rescan": rescan,
            }),
        );
    }
}

// ── registry ────────────────────────────────────────────────────────────────

struct Entry {
    ctx: Option<Arc<Ctx>>,
    /// Kept only to own the watcher; `None` while starting or after a failure.
    _watcher: Option<SharedWatcher>,
    last_touch: Instant,
}

fn registry() -> &'static Mutex<HashMap<PathBuf, Entry>> {
    static R: OnceLock<Mutex<HashMap<PathBuf, Entry>>> = OnceLock::new();
    R.get_or_init(|| {
        let _ = std::thread::Builder::new().name("oad-fs-watch-sweep".into()).spawn(|| loop {
            std::thread::sleep(SWEEP_EVERY);
            sweep();
        });
        Mutex::default()
    })
}

fn sweep() {
    let clients = broadcaster::broadcaster().subscriber_count() > 0;
    let mut reg = registry().lock().unwrap();
    reg.retain(|_, e| {
        let idle = e.last_touch.elapsed();
        idle < IDLE_MAX && (clients || idle < IDLE_NO_CLIENTS)
    });
}

fn remember(set: &Mutex<BTreeSet<String>>, value: Option<&str>) {
    let Some(v) = value.filter(|v| !v.is_empty()) else { return };
    let mut s = set.lock().unwrap();
    if s.len() < MAX_ALIASES || s.contains(v) {
        s.insert(v.to_string());
    }
}

/// The UI just read `workspace` (as the client spelled it): keep it watched.
pub fn touch_workspace(root: &Path, alias: &str) {
    touch(root, Some(alias), None);
}

/// The UI just read the files of session `session_id`, rooted at `root`.
pub fn touch_session(root: &Path, session_id: &str) {
    touch(root, None, Some(session_id));
}

fn touch(root: &Path, alias: Option<&str>, session: Option<&str>) {
    let Ok(root) = dunce::canonicalize(root) else { return };
    if !root.is_dir() {
        return;
    }
    let mut reg = registry().lock().unwrap();
    if let Some(e) = reg.get_mut(&root) {
        e.last_touch = Instant::now();
        if let Some(ctx) = &e.ctx {
            remember(&ctx.aliases, alias);
            remember(&ctx.sessions, session);
        }
        // Still starting, or failed to start: retried only after the idle sweep.
        return;
    }
    let Some(backend) = backend_for(&root) else { return };
    if reg.len() >= MAX_WATCHED_WORKSPACES {
        if let Some(oldest) = reg.iter().min_by_key(|(_, e)| e.last_touch).map(|(k, _)| k.clone()) {
            reg.remove(&oldest);
        }
    }
    reg.insert(root.clone(), Entry { ctx: None, _watcher: None, last_touch: Instant::now() });
    drop(reg);
    let (alias, session) = (alias.map(String::from), session.map(String::from));
    // The per-directory walk can take a moment on big trees: never on the request path.
    let _ = std::thread::Builder::new().name("oad-fs-watch-start".into()).spawn(move || match start(root.clone(), backend) {
        Ok((ctx, watcher)) => {
            remember(&ctx.aliases, alias.as_deref());
            remember(&ctx.sessions, session.as_deref());
            if let Some(e) = registry().lock().unwrap().get_mut(&root) {
                e.ctx = Some(ctx);
                e._watcher = Some(watcher);
            }
        }
        Err(e) => tracing::warn!("fs_watch_unavailable workspace={} backend={:?} err={}", root.display(), backend, e),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn classify_filters_noise_gitignore_and_git_internals() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "build/\ntarget/\n*.log\n").unwrap();
        let gi = load_gitignore(dir.path());
        let classify = |rel: &str, is_dir: bool, gi: &Ignores| classify(rel, is_dir, gi, &|d| d == "target");
        assert_eq!(classify("src/main.rs", false, &gi), Class::File);
        assert_eq!(classify("", true, &gi), Class::Ignore);
        assert_eq!(classify("node_modules/x/index.js", false, &gi), Class::Ignore);
        assert_eq!(classify("a/.venv/lib.py", false, &gi), Class::Ignore);
        // Gitignored paths are listed, so they count, unless under a big
        // ignored directory the listing leaves out.
        assert_eq!(classify("build/out.o", false, &gi), Class::File);
        assert_eq!(classify("build", true, &gi), Class::File);
        assert_eq!(classify("debug.log", false, &gi), Class::File);
        assert_eq!(classify("target/debug/out.o", false, &gi), Class::Ignore);
        assert_eq!(classify("target", true, &gi), Class::Ignore);
        assert_eq!(classify(".git/HEAD", false, &gi), Class::Git);
        assert_eq!(classify(".git/refs/heads/main", false, &gi), Class::Git);
        assert_eq!(classify(".git/refs/heads/main.lock", false, &gi), Class::Ignore);
        assert_eq!(classify(".git/index", false, &gi), Class::Ignore);
        assert_eq!(classify(".git/objects/ab/cdef", false, &gi), Class::Ignore);
    }

    #[test]
    fn mount_fstype_picks_longest_prefix_and_unescapes() {
        let mounts = "/dev/sda1 / ext4 rw 0 0\nserver:/x /mnt/nfs nfs4 rw 0 0\nC:\\134 /mnt/c drvfs rw 0 0\nfoo /mnt/my\\040share cifs rw 0 0\n";
        assert_eq!(mount_fstype(mounts, Path::new("/home/u/p")).as_deref(), Some("ext4"));
        assert_eq!(mount_fstype(mounts, Path::new("/mnt/nfs/p")).as_deref(), Some("nfs4"));
        assert_eq!(mount_fstype(mounts, Path::new("/mnt/c/Users/p")).as_deref(), Some("drvfs"));
        assert_eq!(mount_fstype(mounts, Path::new("/mnt/my share/p")).as_deref(), Some("cifs"));
    }

    /// Collect `workspace_files_changed` events for `root` until `done` holds.
    async fn wait_for(sub: &mut broadcaster::GlobalSubscription, root: &Path, seen: &mut Vec<Value>, done: impl Fn(&[Value]) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !done(seen) {
            let Ok(Some(ev)) = tokio::time::timeout_at(deadline, sub.next()).await else { return false };
            if ev.event != EVENT {
                continue;
            }
            let v: Value = serde_json::from_str(&ev.data).unwrap();
            if v["workspace"].as_str() == Some(&*root.to_string_lossy()) {
                seen.push(v);
            }
        }
        true
    }

    fn reported(seen: &[Value], path: &str) -> bool {
        seen.iter().any(|v| v["paths"].as_array().unwrap().iter().any(|p| p == path))
    }

    async fn exercise(backend: Backend) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join(".gitignore"), "build/\ntarget/\n").unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        // Too big to list: changes inside are not reported.
        std::fs::create_dir_all(root.join("target")).unwrap();
        for i in 0..=appv3_tools::grep::MAX_IGNORED_DIR_FILES {
            std::fs::write(root.join(format!("target/f{i}.o")), "x").unwrap();
        }
        let mut sub = broadcaster::broadcaster().attach();
        let (ctx, _watcher) = start(root.clone(), backend).unwrap();
        remember(&ctx.aliases, Some("~/alias"));
        tokio::time::sleep(Duration::from_millis(300)).await;

        std::fs::write(root.join("node_modules/pkg.js"), "x").unwrap();
        std::fs::write(root.join("target/new.o"), "x").unwrap();
        std::fs::write(root.join("top.txt"), "x").unwrap();
        let mut seen = vec![];
        assert!(wait_for(&mut sub, &root, &mut seen, |s| reported(s, "top.txt")).await, "{backend:?}: no event for top.txt: {seen:?}");
        // A small gitignored directory is listed, so its changes are reported.
        std::fs::write(root.join("build/out.o"), "x").unwrap();
        assert!(wait_for(&mut sub, &root, &mut seen, |s| reported(s, "build/out.o")).await, "{backend:?}: no event for ignored build/out.o: {seen:?}");
        std::fs::write(root.join("src/lib.rs"), "fn main() {}").unwrap();
        assert!(wait_for(&mut sub, &root, &mut seen, |s| reported(s, "src/lib.rs")).await, "{backend:?}: no event for nested src/lib.rs: {seen:?}");
        assert_eq!(seen[0]["aliases"], serde_json::json!(["~/alias"]));

        // A directory created after start is followed (per-directory backends add a watch).
        std::fs::create_dir_all(root.join("fresh/deeper")).unwrap();
        assert!(wait_for(&mut sub, &root, &mut seen, |s| reported(s, "fresh")).await, "{backend:?}: no event for fresh/: {seen:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
        std::fs::write(root.join("fresh/deeper/new.txt"), "hi").unwrap();
        assert!(wait_for(&mut sub, &root, &mut seen, |s| reported(s, "fresh/deeper/new.txt")).await, "{backend:?}: new dir not followed: {seen:?}");

        tokio::time::sleep(Duration::from_millis(500)).await;
        for v in &seen {
            for p in v["paths"].as_array().unwrap() {
                let p = p.as_str().unwrap();
                assert!(!p.starts_with("node_modules") && !p.starts_with("target"), "{backend:?}: noise or big ignored path reported: {p}");
            }
        }
    }

    #[tokio::test]
    async fn native_recursive_backend_reports_changes() {
        // Wine never reports nested changes on a recursive watch; `backend_for` avoids it there.
        if cfg!(any(target_os = "macos", windows)) && !appv3_core::platform::under_wine() {
            exercise(Backend::Recursive).await;
        }
    }

    #[tokio::test]
    async fn native_per_directory_backend_reports_changes() {
        exercise(Backend::PerDir).await;
    }

    #[tokio::test]
    async fn poll_backend_reports_changes() {
        exercise(Backend::Poll(Duration::from_millis(100))).await;
    }
}
