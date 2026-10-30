//! Out-of-tree Git-based workspace snapshots for session undo/redo — a
//! line-for-line port of `app/services/snapshot_service.py`.
//!
//! The on-disk layout (`{STATE_DIR}/snapshot/<sid>`, refs under
//! `refs/openagentd/snapshots/<tree>`, alternates seeding) and every git
//! invocation match v2, so v2 and v3 can share snapshot repos.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use appv3_core::settings::settings;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RestoreResult {
    pub ok: bool,
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

impl RestoreResult {
    fn fail() -> Self {
        Self::default()
    }
}

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
const CORE_FLAGS: &[&str] =
    &["--no-optional-locks", "-c", "core.longpaths=true", "-c", "core.symlinks=true", "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"];
const MAINTENANCE_INTERVAL: u64 = 16;
pub(crate) const SNAPSHOT_REF_PREFIX: &str = "refs/openagentd/snapshots";
const SIZE_CAP_ROUNDS: usize = 12;

type Lock = Arc<tokio::sync::Mutex<()>>;
static LOCKS: LazyLock<Mutex<HashMap<String, Lock>>> = LazyLock::new(Default::default);
static LAST_HASHES: LazyLock<Mutex<HashMap<(String, PathBuf), String>>> = LazyLock::new(Default::default);
static TRACK_COUNTS: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);
static SEED_ATTEMPTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// `OPENAGENTD_SNAPSHOT_SEED_OBJECTS` (default on).
pub fn seed_objects_enabled() -> bool {
    match appv3_core::settings::env_var("OPENAGENTD_SNAPSHOT_SEED_OBJECTS") {
        None => true,
        Some(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
    }
}

fn lock(session_id: &str) -> Lock {
    LOCKS.lock().unwrap().entry(session_id.to_string()).or_default().clone()
}

fn resolve(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| p.to_path_buf()) })
}

/// On-disk `GIT_DIR` for the session's snapshot repo.
pub fn snapshot_dir(session_id: &str) -> PathBuf {
    resolve(&settings().state_dir).join("snapshot").join(session_id)
}

/// `shutil.which("git") is not None`.
pub fn is_available() -> bool {
    appv3_core::which::which("git").is_some()
}

/// Which implementation runs `track`/`restore`.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Engine {
    /// In-process `gix` (default): no `git` executable needed, no process
    /// launches per turn. Falls back to the CLI on error when git exists.
    Gix,
    /// The git CLI, exactly like v2 (`OPENAGENTD_SNAPSHOT_ENGINE=git`).
    Git,
}

fn engine() -> Engine {
    match appv3_core::settings::env_var("OPENAGENTD_SNAPSHOT_ENGINE").map(|v| v.trim().to_lowercase()) {
        Some(v) if v == "git" => Engine::Git,
        _ => Engine::Gix,
    }
}

/// Snapshots can run: gix needs nothing, the CLI engine needs `git`.
fn usable() -> bool {
    engine() == Engine::Gix || is_available()
}

struct Out {
    code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Out {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    fn err(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Never fails: spawn errors surface as exit code 1.
async fn git(args: &[&str], cwd: Option<&Path>, env: &[(&str, &str)], stdin: Option<Vec<u8>>) -> Out {
    let mut cmd = tokio::process::Command::new("git");
    appv3_core::proctree::hide_window(&mut cmd).args(args).envs(env.iter().copied());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("snapshot_git_spawn_failed args={:?} error={}", args, e);
            return Out { code: 1, stdout: vec![], stderr: e.to_string().into_bytes() };
        }
    };
    if let (Some(data), Some(mut w)) = (stdin, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = w.write_all(&data).await;
            let _ = w.shutdown().await;
        });
    }
    match child.wait_with_output().await {
        Ok(o) => Out { code: o.status.code().unwrap_or(1), stdout: o.stdout, stderr: o.stderr },
        Err(e) => Out { code: 1, stdout: vec![], stderr: e.to_string().into_bytes() },
    }
}

fn p(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `[*CORE_FLAGS, --git-dir, G, --work-tree, W, *rest]`.
fn wt_args<'a>(gd: &'a str, wt: &'a str, rest: &[&'a str]) -> Vec<&'a str> {
    let mut v: Vec<&str> = CORE_FLAGS.to_vec();
    v.extend(["--git-dir", gd, "--work-tree", wt]);
    v.extend_from_slice(rest);
    v
}

fn gd_args<'a>(gd: &'a str, rest: &[&'a str]) -> Vec<&'a str> {
    let mut v = vec!["--git-dir", gd];
    v.extend_from_slice(rest);
    v
}

fn snapshot_ref(tree: &str) -> String {
    format!("{SNAPSHOT_REF_PREFIX}/{tree}")
}

async fn repack(gitdir: &Path) {
    prune_dead_alternates(gitdir);
    let gd = p(gitdir);
    let mut a: Vec<&str> = CORE_FLAGS.to_vec();
    a.extend(["--git-dir", &gd, "repack", "-a", "-d", "-q", "-l"]);
    let o = git(&a, None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_repack_failed gitdir={} stderr={}", gd, o.err());
    }
}

/// Drop `objects/info/alternates` entries whose directory is gone (the
/// workspace repo was deleted or moved). git refuses to repack with an
/// unreadable alternate ("unable to normalize alternate object path"), so
/// one deleted repo would otherwise fail every maintenance run. Objects that
/// lived only there are already unreadable; dropping the line loses nothing.
fn prune_dead_alternates(gitdir: &Path) {
    let objects = gitdir.join("objects");
    let file = objects.join("info").join("alternates");
    let Ok(raw) = std::fs::read_to_string(&file) else {
        return;
    };
    let mut dropped = 0usize;
    let kept: Vec<&str> = raw
        .lines()
        .filter(|line| {
            let e = line.trim();
            if e.is_empty() || e.starts_with('#') {
                return true;
            }
            let c = PathBuf::from(e);
            let alive = if c.is_absolute() { c.is_dir() } else { objects.join(c).is_dir() };
            if !alive {
                dropped += 1;
            }
            alive
        })
        .collect();
    if dropped == 0 {
        return;
    }
    let res =
        if kept.iter().all(|l| l.trim().is_empty() || l.trim().starts_with('#')) { std::fs::remove_file(&file) } else { std::fs::write(&file, format!("{}\n", kept.join("\n"))) };
    match res {
        Ok(()) => tracing::info!("snapshot_alternates_pruned gitdir={} dropped={} kept={}", p(gitdir), dropped, kept.len()),
        Err(e) => tracing::warn!("snapshot_alternates_prune_failed gitdir={} error={}", p(gitdir), e),
    }
}

async fn prune_loose(gitdir: &Path) {
    let gd = p(gitdir);
    let o = git(&gd_args(&gd, &["prune", "--expire=now"]), None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_prune_failed gitdir={} stderr={}", gd, o.err());
    }
}

fn clean_temp_packs(gitdir: &Path) {
    if let Ok(rd) = std::fs::read_dir(gitdir.join("objects").join("pack")) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("tmp_pack_") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

async fn maintain_repo(gitdir: &Path) {
    repack(gitdir).await;
    clean_temp_packs(gitdir);
}

async fn ensure_ref(gitdir: &Path, tree: &str) {
    if tree.is_empty() {
        return;
    }
    let gd = p(gitdir);
    let r = snapshot_ref(tree);
    if git(&gd_args(&gd, &["rev-parse", "--verify", "--quiet", &r]), None, &[], None).await.code == 0 {
        return;
    }
    let o = git(&gd_args(&gd, &["commit-tree", tree, "-m", "snapshot"]), None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_ref_commit_failed gitdir={} tree={} stderr={}", gd, tree, o.err());
        return;
    }
    let commit = o.text().trim().to_string();
    if commit.is_empty() {
        return;
    }
    let o = git(&gd_args(&gd, &["update-ref", &r, &commit]), None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_ref_update_failed gitdir={} tree={} stderr={}", gd, tree, o.err());
    }
}

async fn list_snapshot_refs(gitdir: &Path) -> HashMap<String, String> {
    let gd = p(gitdir);
    let o = git(&gd_args(&gd, &["for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX]), None, &[], None).await;
    let mut refs = HashMap::new();
    if o.code != 0 {
        return refs;
    }
    for line in o.text().lines() {
        let name = line.trim();
        let tree = name.rsplit('/').next().unwrap_or("");
        if !tree.is_empty() {
            refs.insert(tree.to_string(), name.to_string());
        }
    }
    refs
}

async fn present_trees(gitdir: &Path, trees: &[String]) -> HashSet<String> {
    if trees.is_empty() {
        return HashSet::new();
    }
    let gd = p(gitdir);
    let stdin = format!("{}\n", trees.join("\n")).into_bytes();
    let o = git(&gd_args(&gd, &["cat-file", "--batch-check=%(objectname)"]), None, &[], Some(stdin)).await;
    if o.code != 0 {
        return trees.iter().cloned().collect();
    }
    o.text().lines().map(str::trim).filter(|v| !v.is_empty() && !v.ends_with("missing")).map(String::from).collect()
}

async fn local_size(gitdir: &Path) -> u64 {
    let gd = p(gitdir);
    let o = git(&gd_args(&gd, &["count-objects", "-v"]), None, &[], None).await;
    if o.code != 0 {
        return 0;
    }
    let mut kib = 0u64;
    for line in o.text().lines() {
        let (k, v) = line.split_once(':').unwrap_or((line, ""));
        if matches!(k.trim(), "size" | "size-pack") {
            kib += v.trim().parse::<u64>().unwrap_or(0);
        }
    }
    kib * 1024
}

/// Local object-store bytes for this session's snapshot repo.
pub async fn local_size_bytes(session_id: &str) -> u64 {
    let gd = snapshot_dir(session_id);
    if !gd.join("HEAD").exists() {
        return 0;
    }
    local_size(&gd).await
}

async fn enforce_size_cap(gitdir: &Path, ordered: &[String], max_bytes: u64, protected: &HashSet<String>) {
    let gd = p(gitdir);
    let mut remaining: Vec<String> = ordered.to_vec();
    for _ in 0..SIZE_CAP_ROUNDS {
        let size = local_size(gitdir).await;
        if size <= max_bytes {
            return;
        }
        let droppable: Vec<String> = remaining.iter().filter(|t| !protected.contains(*t)).cloned().collect();
        if droppable.is_empty() {
            tracing::warn!("snapshot_size_cap_exceeded gitdir={} size={} cap={}", gd, size, max_bytes);
            return;
        }
        let per = (size / (remaining.len().max(1) as u64)).max(1);
        let n = (droppable.len() as u64).min(((size - max_bytes) / per + 1).max(1)) as usize;
        for tree in &droppable[..n] {
            let r = snapshot_ref(tree);
            git(&gd_args(&gd, &["update-ref", "-d", &r]), None, &[], None).await;
            remaining.retain(|t| t != tree);
        }
        repack(gitdir).await;
        prune_loose(gitdir).await;
    }
}

/// Reclaim snapshot objects the session no longer references.
pub async fn prune(session_id: &str, keep: &[String], max_bytes: Option<u64>, protected: &[String]) {
    if !is_available() {
        return;
    }
    let gitdir = snapshot_dir(session_id);
    if !gitdir.join("HEAD").exists() {
        return;
    }
    let mut seen = HashSet::new();
    let candidates: Vec<String> = keep.iter().filter(|t| !t.is_empty() && seen.insert((*t).clone())).cloned().collect();
    let present = present_trees(&gitdir, &candidates).await;
    let ordered: Vec<String> = candidates.into_iter().filter(|t| present.contains(t)).collect();
    let protected: HashSet<String> = protected.iter().filter(|t| !t.is_empty()).cloned().collect();
    let l = lock(session_id);
    let _g = l.lock().await;
    let existing = list_snapshot_refs(&gitdir).await;
    let wanted: HashSet<&String> = ordered.iter().collect();
    for tree in &ordered {
        if !existing.contains_key(tree) {
            ensure_ref(&gitdir, tree).await;
        }
    }
    let gd = p(&gitdir);
    for (tree, r) in &existing {
        if !wanted.contains(tree) {
            git(&gd_args(&gd, &["update-ref", "-d", r]), None, &[], None).await;
        }
    }
    repack(&gitdir).await;
    prune_loose(&gitdir).await;
    if let Some(cap) = max_bytes {
        enforce_size_cap(&gitdir, &ordered, cap, &protected).await;
    }
    clean_temp_packs(&gitdir);
}

fn read_alternates(objects_dir: &Path) -> Vec<PathBuf> {
    let Ok(raw) = std::fs::read(objects_dir.join("info").join("alternates")) else {
        return vec![];
    };
    String::from_utf8_lossy(&raw)
        .lines()
        .map(str::trim)
        .filter(|e| !e.is_empty() && !e.starts_with('#'))
        .map(|e| {
            let c = PathBuf::from(e);
            if c.is_absolute() {
                c
            } else {
                resolve(&objects_dir.join(c))
            }
        })
        .collect()
}

fn alternate_object_dirs(source: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in std::iter::once(source.to_path_buf()).chain(read_alternates(source)) {
        if !c.is_dir() {
            continue;
        }
        let t = p(&c);
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

async fn seed_objects(gitdir: &Path, worktree: &Path, copy_index: bool) -> bool {
    if !seed_objects_enabled() {
        return false;
    }
    let wt = worktree.to_path_buf();
    let Ok(Some(common)) = tokio::task::spawn_blocking(move || crate::snapshot_gix::common_git_dir(&wt)).await else {
        return false;
    };
    let common = p(&common);
    let alts = alternate_object_dirs(&Path::new(&common).join("objects"));
    if alts.is_empty() {
        return false;
    }
    let info = gitdir.join("objects").join("info");
    if std::fs::create_dir_all(&info).is_err() || std::fs::write(info.join("alternates"), format!("{}\n", alts.join("\n"))).is_err() {
        return false;
    }
    if copy_index {
        let src = Path::new(&common).join("index");
        if src.is_file() {
            if let Err(e) = std::fs::copy(&src, gitdir.join("index")) {
                tracing::debug!("snapshot_seed_index_failed gitdir={} error={}", p(gitdir), e);
            }
        }
    }
    tracing::info!("snapshot_seeded_objects gitdir={} alternates={}", p(gitdir), alts.len());
    true
}

async fn ensure_seed(gitdir: &Path, worktree: &Path, copy_index: bool) {
    if !SEED_ATTEMPTED.lock().unwrap().insert(p(gitdir)) {
        return;
    }
    seed_objects(gitdir, worktree, copy_index).await;
}

async fn init_repo(gitdir: &Path, worktree: &Path) -> bool {
    let _ = std::fs::create_dir_all(gitdir);
    if gitdir.join("HEAD").exists() {
        ensure_seed(gitdir, worktree, false).await;
        return true;
    }
    let gd = p(gitdir);
    if engine() == Engine::Gix {
        let (g2, w2) = (gitdir.to_path_buf(), worktree.to_path_buf());
        match tokio::task::spawn_blocking(move || crate::snapshot_gix::init(&g2, &w2)).await {
            Ok(Ok(())) => {
                ensure_seed(gitdir, worktree, true).await;
                tracing::info!("snapshot_initialised session_gitdir={} engine=gix", gd);
                return true;
            }
            Ok(Err(e)) => tracing::warn!("snapshot_gix_init_failed gitdir={} error={}", gd, e),
            Err(e) => tracing::warn!("snapshot_gix_init_failed gitdir={} error={}", gd, e),
        }
        if !is_available() {
            return false;
        }
    }
    init_repo_cli(gitdir, worktree).await
}

/// `git init` + config keys + seeding, via the git CLI (v2's sequence).
async fn init_repo_cli(gitdir: &Path, worktree: &Path) -> bool {
    let (gd, wt) = (p(gitdir), p(worktree));
    let o = git(&["init"], None, &[("GIT_DIR", &gd), ("GIT_WORK_TREE", &wt)], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_init_failed gitdir={} stderr={}", gd, o.err());
        return false;
    }
    for (k, v) in [
        ("core.autocrlf", "false"),
        ("core.longpaths", "true"),
        ("core.symlinks", "true"),
        ("core.fsmonitor", "false"),
        ("user.email", "snapshot@openagentd.local"),
        ("user.name", "openagentd-snapshot"),
    ] {
        git(&["--git-dir", &gd, "config", k, v], None, &[], None).await;
    }
    ensure_seed(gitdir, worktree, true).await;
    tracing::info!("snapshot_initialised session_gitdir={}", gd);
    true
}

fn split_nul(b: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(b).split('\0').filter(|s| !s.is_empty()).map(String::from).collect()
}

async fn list_candidate_paths(gitdir: &Path, worktree: &Path) -> Vec<String> {
    let (gd, wt) = (p(gitdir), p(worktree));
    let a1 = wt_args(&gd, &wt, &["diff-files", "--name-only", "-z", "--", "."]);
    let a2 = wt_args(&gd, &wt, &["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
    let (d, o) = tokio::join!(git(&a1, Some(worktree), &[], None), git(&a2, Some(worktree), &[], None));
    if d.code != 0 || o.code != 0 {
        return vec![];
    }
    let tracked = split_nul(&d.stdout);
    let untracked = split_nul(&o.stdout);
    let mut seen = HashSet::new();
    if untracked.is_empty() {
        return tracked.into_iter().filter(|x| seen.insert(x.clone())).collect();
    }
    let untracked_set: HashSet<&String> = untracked.iter().collect();
    let mut out = Vec::new();
    for path in tracked.iter().chain(untracked.iter()) {
        if !seen.insert(path.clone()) {
            continue;
        }
        if untracked_set.contains(path) {
            match std::fs::metadata(worktree.join(path)) {
                Ok(m) if m.len() > MAX_FILE_SIZE => continue,
                Ok(_) => {}
                Err(_) => continue,
            }
        }
        out.push(path.clone());
    }
    out
}

async fn stage(gitdir: &Path, worktree: &Path, paths: &[String]) -> bool {
    if paths.is_empty() {
        return true;
    }
    let (gd, wt) = (p(gitdir), p(worktree));
    let stdin = format!("{}\0", paths.join("\0")).into_bytes();
    let a = wt_args(&gd, &wt, &["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"]);
    let o = git(&a, Some(worktree), &[], Some(stdin)).await;
    if o.code != 0 {
        tracing::warn!("snapshot_stage_failed stderr={}", o.err());
        return false;
    }
    true
}

/// Snapshot the workspace and return its tree hash (`None` on any failure,
/// for chat workspaces, or when git is missing).
pub async fn track(session_id: &str, workspace: &Path) -> Option<String> {
    if !usable() || !workspace.is_dir() {
        return None;
    }
    if settings().is_chat_workspace(Some(workspace)) {
        return None;
    }
    let started = std::time::Instant::now();
    let gitdir = snapshot_dir(session_id);
    let key = (session_id.to_string(), resolve(workspace));
    let l = lock(session_id);
    let _g = l.lock().await;
    if !init_repo(&gitdir, workspace).await {
        return None;
    }
    let hash = match engine() {
        Engine::Gix => match track_gix(session_id, &gitdir, workspace, &key).await {
            Some(h) => Some(h),
            None if is_available() => track_cli(session_id, &gitdir, workspace, &key).await,
            None => None,
        },
        Engine::Git => track_cli(session_id, &gitdir, workspace, &key).await,
    }?;
    LAST_HASHES.lock().unwrap().insert(key, hash.clone());
    let n = {
        let mut c = TRACK_COUNTS.lock().unwrap();
        let e = c.entry(session_id.to_string()).or_insert(0);
        *e += 1;
        *e
    };
    if n % MAINTENANCE_INTERVAL == 0 && is_available() {
        maintain_repo(&gitdir).await;
    }
    tracing::debug!("snapshot_tracked session_id={} hash={} elapsed_ms={}", session_id, hash, started.elapsed().as_millis());
    Some(hash)
}

async fn track_gix(session_id: &str, gitdir: &Path, workspace: &Path, key: &(String, PathBuf)) -> Option<String> {
    let last = LAST_HASHES.lock().unwrap().get(key).cloned();
    let (g2, w2) = (gitdir.to_path_buf(), workspace.to_path_buf());
    match tokio::task::spawn_blocking(move || crate::snapshot_gix::track(&g2, &w2, last.as_deref(), MAX_FILE_SIZE)).await {
        Ok(Ok(h)) => Some(h),
        Ok(Err(e)) => {
            tracing::warn!("snapshot_gix_track_failed session_id={} error={}", session_id, e);
            None
        }
        Err(e) => {
            tracing::warn!("snapshot_gix_track_failed session_id={} error={}", session_id, e);
            None
        }
    }
}

/// The git CLI engine (v2's exact command sequence).
async fn track_cli(session_id: &str, gitdir: &Path, workspace: &Path, key: &(String, PathBuf)) -> Option<String> {
    let gitdir = gitdir.to_path_buf();
    let paths = list_candidate_paths(&gitdir, workspace).await;
    if !paths.is_empty() {
        stage(&gitdir, workspace, &paths).await;
    } else if let Some(h) = LAST_HASHES.lock().unwrap().get(key).cloned() {
        return Some(h);
    }
    let (gd, wt) = (p(&gitdir), p(workspace));
    let o = git(&wt_args(&gd, &wt, &["write-tree"]), Some(workspace), &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_write_tree_failed session_id={} stderr={}", session_id, o.err());
        return None;
    }
    let hash = o.text().trim().to_string();
    if hash.is_empty() {
        return None;
    }
    ensure_ref(&gitdir, &hash).await;
    Some(hash)
}

/// Restore the workspace to the given snapshot tree.
pub async fn restore(session_id: &str, workspace: &Path, snapshot: &str, skip_stage: bool) -> RestoreResult {
    if !usable() || snapshot.is_empty() {
        return RestoreResult::fail();
    }
    let gitdir = snapshot_dir(session_id);
    if !gitdir.join("HEAD").exists() {
        tracing::warn!("snapshot_restore_no_repo session_id={} hash={}", session_id, snapshot);
        return RestoreResult::fail();
    }
    let _ = std::fs::create_dir_all(workspace);
    let l = lock(session_id);
    let _g = l.lock().await;
    if engine() == Engine::Gix {
        let (g2, w2, s2) = (gitdir.clone(), workspace.to_path_buf(), snapshot.to_string());
        match tokio::task::spawn_blocking(move || crate::snapshot_gix::restore(&g2, &w2, &s2, skip_stage, MAX_FILE_SIZE)).await {
            Ok(Ok(r)) => {
                delete_extras(workspace, &r.removed);
                tracing::debug!(
                    "snapshot_restored session_id={} hash={} checkout={} extras={} engine=gix",
                    session_id,
                    snapshot,
                    r.added.len() + r.modified.len(),
                    r.removed.len()
                );
                return RestoreResult { ok: true, added: r.added, modified: r.modified, removed: r.removed };
            }
            Ok(Err(e)) => tracing::warn!("snapshot_gix_restore_failed session_id={} hash={} error={}", session_id, snapshot, e),
            Err(e) => tracing::warn!("snapshot_gix_restore_failed session_id={} hash={} error={}", session_id, snapshot, e),
        }
        if !is_available() {
            return RestoreResult::fail();
        }
    }
    if !skip_stage {
        let live = list_candidate_paths(&gitdir, workspace).await;
        if !live.is_empty() {
            stage(&gitdir, workspace, &live).await;
        }
    }
    let (gd, wt) = (p(&gitdir), p(workspace));
    let a = wt_args(&gd, &wt, &["diff-index", "-R", "--cached", "--name-status", "-r", "-z", "--no-renames", snapshot]);
    let d = git(&a, Some(workspace), &[], None).await;
    if d.code != 0 {
        tracing::warn!("snapshot_diff_index_failed session_id={} hash={}", session_id, snapshot);
        return RestoreResult::fail();
    }
    let (mut added, mut modified, mut to_delete) = (vec![], vec![], vec![]);
    let text = String::from_utf8_lossy(&d.stdout).into_owned();
    let parts: Vec<&str> = text.split('\0').collect();
    let mut i = 0;
    while i + 1 < parts.len() {
        let (status, path) = (parts[i], parts[i + 1]);
        i += 2;
        if status.is_empty() || path.is_empty() {
            continue;
        }
        match status.as_bytes()[0] {
            b'A' => added.push(path.to_string()),
            b'M' | b'T' => modified.push(path.to_string()),
            b'D' => to_delete.push(path.to_string()),
            _ => {}
        }
    }
    let to_checkout: Vec<String> = added.iter().chain(modified.iter()).cloned().collect();
    if !to_checkout.is_empty() {
        let temp_index = gitdir.join(format!("restore-{}-{}.idx", std::process::id(), &snapshot[..snapshot.len().min(8)]));
        let ti = p(&temp_index);
        let env = [("GIT_INDEX_FILE", ti.as_str())];
        let result = async {
            let o = git(&wt_args(&gd, &wt, &["read-tree", snapshot]), Some(workspace), &env, None).await;
            if o.code != 0 {
                tracing::warn!("snapshot_read_tree_failed session_id={} hash={} stderr={}", session_id, snapshot, o.err());
                return false;
            }
            let stdin = format!("{}\0", to_checkout.join("\0")).into_bytes();
            let o = git(&wt_args(&gd, &wt, &["checkout-index", "-f", "-z", "--stdin"]), Some(workspace), &env, Some(stdin)).await;
            if o.code != 0 {
                tracing::warn!("snapshot_checkout_failed session_id={} hash={} stderr={} count={}", session_id, snapshot, o.err(), to_checkout.len());
                return false;
            }
            true
        }
        .await;
        let _ = std::fs::remove_file(&temp_index);
        if !result {
            return RestoreResult::fail();
        }
    }
    delete_extras(workspace, &to_delete);
    tracing::debug!("snapshot_restored session_id={} hash={} checkout={} extras={}", session_id, snapshot, to_checkout.len(), to_delete.len());
    RestoreResult { ok: true, added, modified, removed: to_delete }
}

fn delete_extras(workspace: &Path, extras: &[String]) {
    let root = resolve(workspace);
    let mut parents: HashSet<PathBuf> = HashSet::new();
    let uniq: HashSet<&String> = extras.iter().collect();
    for rel in uniq {
        let rp = Path::new(rel);
        if rp.is_absolute() || rp.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }
        let target = root.join(rp);
        let Some(parent) = target.parent() else {
            continue;
        };
        if !resolve(parent).starts_with(&root) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&target) {
            tracing::debug!("snapshot_extra_unlink_failed path={} error={}", p(&target), e);
        }
        let mut d = parent.to_path_buf();
        while d != root && d.starts_with(&root) {
            parents.insert(d.clone());
            if !d.pop() {
                break;
            }
        }
    }
    let mut dirs: Vec<PathBuf> = parents.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(&d);
    }
}

/// Delete the session's snapshot repo (best effort).
pub async fn remove(session_id: &str) {
    let gitdir = snapshot_dir(session_id);
    {
        let l = lock(session_id);
        let _g = l.lock().await;
        if gitdir.exists() {
            let g2 = gitdir.clone();
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(g2)).await;
        }
        LAST_HASHES.lock().unwrap().retain(|k, _| k.0 != session_id);
        TRACK_COUNTS.lock().unwrap().remove(session_id);
        SEED_ATTEMPTED.lock().unwrap().remove(&p(&gitdir));
    }
    LOCKS.lock().unwrap().remove(session_id);
}

/// Clear a session's lock entry (used by artifact cleanup).
pub fn forget_lock(session_id: &str) {
    LOCKS.lock().unwrap().remove(session_id);
}

/// v2 `_promote_queued`: snapshot the session workspace (only when queued rows
/// exist) and promote every queued row, stamping the snapshot on each.
pub async fn release_queued(pool: &appv3_db::DbPool, session_id: &str) -> anyhow::Result<Vec<appv3_db::SessionMessage>> {
    release_queued_with(pool, session_id, true).await
}

/// What a running turn reads before its next step: [`release_queued`]
/// without the rows held until the turn ends.
pub async fn release_queued_steers(pool: &appv3_db::DbPool, session_id: &str) -> anyhow::Result<Vec<appv3_db::SessionMessage>> {
    release_queued_with(pool, session_id, false).await
}

async fn release_queued_with(pool: &appv3_db::DbPool, session_id: &str, include_held: bool) -> anyhow::Result<Vec<appv3_db::SessionMessage>> {
    let mut snap = None;
    let any = if include_held { appv3_db::has_queued_user_messages(pool, session_id).await? } else { appv3_db::has_queued_steers(pool, session_id).await? };
    if any {
        if let Some(row) = appv3_db::get_session(pool, session_id).await? {
            let ws = crate::session::session_workspace_dir(session_id, Some(&row.workspace));
            snap = track(session_id, &ws).await;
        }
    }
    appv3_db::release_queued_user_messages_with(pool, session_id, snap.as_deref(), include_held).await
}

// ── Retention sweep (port of `snapshot_maintenance.py`) ─────────────────────

fn int_env(name: &str, default: i64, min: i64) -> i64 {
    match appv3_core::settings::env_var(name) {
        None => default,
        Some(v) => v.trim().parse::<i64>().map(|x| x.max(min)).unwrap_or(default),
    }
}

fn maintenance_enabled() -> bool {
    match appv3_core::settings::env_var("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED") {
        None => true,
        Some(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
    }
}

/// `(ordered_keep, protected)` snapshot hashes for a session (db-form id).
pub async fn collect_keep_snapshots(pool: &appv3_db::DbPool, db_sid: &str) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let rows = sqlx::query_as::<_, appv3_db::SessionMessage>("SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC, id ASC").bind(db_sid).fetch_all(pool).await?;
    let mut ordered: Vec<String> = Vec::new();
    for r in &rows {
        if let Some(s) = r.snapshot() {
            if !ordered.contains(&s) {
                ordered.push(s);
            }
        }
    }
    let anchor = appv3_db::get_session(pool, db_sid).await?.and_then(|s| s.redo_anchor());
    Ok((ordered, anchor.into_iter().collect()))
}

/// One sweep over every session → `(sessions, freed_bytes)`.
pub async fn sweep_snapshots(pool: &appv3_db::DbPool, max_bytes: Option<u64>) -> anyhow::Result<(u64, u64)> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM chat_sessions").fetch_all(pool).await?;
    let (mut sessions, mut freed) = (0u64, 0u64);
    for id in ids {
        let sid = appv3_db::codec::api_uuid(&id);
        let before = local_size_bytes(&sid).await;
        if before == 0 {
            continue;
        }
        let (ordered, protected) = match collect_keep_snapshots(pool, &id).await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!("snapshot_maintenance_session_failed session_id={} error={}", sid, e);
                continue;
            }
        };
        prune(&sid, &ordered, max_bytes, &protected).await;
        sessions += 1;
        let after = local_size_bytes(&sid).await;
        if after < before {
            freed += before - after;
        }
    }
    tracing::info!("snapshot_maintenance_swept sessions={} freed_bytes={}", sessions, freed);
    Ok((sessions, freed))
}

static MAINTENANCE: LazyLock<Mutex<Option<tokio::task::JoinHandle<()>>>> = LazyLock::new(Default::default);

/// `start_snapshot_maintenance` — idempotent background sweeper.
pub fn start_maintenance(pool: appv3_db::DbPool) {
    if !maintenance_enabled() {
        tracing::info!("snapshot_maintenance_disabled");
        return;
    }
    let mut slot = MAINTENANCE.lock().unwrap();
    if slot.as_ref().is_some_and(|h| !h.is_finished()) {
        return;
    }
    let hours = int_env("OPENAGENTD_SNAPSHOT_MAINTENANCE_INTERVAL_HOURS", 6, 1) as u64;
    let delay = int_env("OPENAGENTD_SNAPSHOT_MAINTENANCE_START_DELAY_SECONDS", 60, 0) as u64;
    let max_bytes = int_env("OPENAGENTD_SNAPSHOT_MAX_BYTES", 256 * 1024 * 1024, 0) as u64;
    *slot = Some(tokio::spawn(async move {
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        }
        loop {
            if let Err(e) = sweep_snapshots(&pool, (max_bytes > 0).then_some(max_bytes)).await {
                tracing::warn!("snapshot_maintenance_failed error={}", e);
            }
            tokio::time::sleep(std::time::Duration::from_secs(hours * 3600)).await;
        }
    }));
    tracing::info!("snapshot_maintenance_started interval_h={} max_bytes={}", hours, max_bytes);
}

/// `stop_snapshot_maintenance`.
pub fn stop_maintenance() {
    if let Some(h) = MAINTENANCE.lock().unwrap().take() {
        h.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn track_restore_roundtrip() {
        if !is_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::write(ws.join("a.txt"), "one").unwrap();
        std::fs::write(ws.join("sub/b.txt"), "bee").unwrap();
        // Use an explicit gitdir under tmp by pointing snapshot internals at it.
        let gitdir = tmp.path().join("snap");
        assert!(init_repo(&gitdir, &ws).await);
        let paths = list_candidate_paths(&gitdir, &ws).await;
        assert_eq!(paths.len(), 2);
        assert!(stage(&gitdir, &ws, &paths).await);
        let (gd, wt) = (p(&gitdir), p(&ws));
        let t1 = git(&wt_args(&gd, &wt, &["write-tree"]), Some(&ws), &[], None).await.text().trim().to_string();
        assert_eq!(t1.len(), 40);
        std::fs::write(ws.join("a.txt"), "two").unwrap();
        std::fs::write(ws.join("c.txt"), "new").unwrap();
        std::fs::remove_file(ws.join("sub/b.txt")).unwrap();
        let live = list_candidate_paths(&gitdir, &ws).await;
        stage(&gitdir, &ws, &live).await;
        let d = git(&wt_args(&gd, &wt, &["diff-index", "-R", "--cached", "--name-status", "-r", "-z", "--no-renames", &t1]), Some(&ws), &[], None).await;
        let s = String::from_utf8_lossy(&d.stdout).replace('\0', "|");
        assert!(s.contains("M|a.txt") && s.contains("A|sub/b.txt") && s.contains("D|c.txt"), "{s}");
        delete_extras(&ws, &["c.txt".into()]);
        assert!(!ws.join("c.txt").exists());
    }

    #[tokio::test]
    async fn repack_drops_alternates_whose_repo_was_deleted() {
        if !is_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let gitdir = tmp.path().join("snap");
        assert!(init_repo(&gitdir, &ws).await);
        let live = tmp.path().join("live-objects");
        std::fs::create_dir_all(&live).unwrap();
        let gone = tmp.path().join("deleted-repo/.git/objects");
        let alternates = gitdir.join("objects/info/alternates");
        std::fs::create_dir_all(alternates.parent().unwrap()).unwrap();
        std::fs::write(&alternates, format!("{}\n{}\n", p(&gone), p(&live))).unwrap();

        repack(&gitdir).await;

        assert_eq!(std::fs::read_to_string(&alternates).unwrap(), format!("{}\n", p(&live)));
        let o = git(&gd_args(&p(&gitdir), &["repack", "-a", "-d", "-q", "-l"]), None, &[], None).await;
        assert_eq!(o.code, 0, "{}", o.err());
    }

    #[tokio::test]
    async fn repack_removes_alternates_file_when_every_entry_is_gone() {
        if !is_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let gitdir = tmp.path().join("snap");
        assert!(init_repo(&gitdir, &ws).await);
        let alternates = gitdir.join("objects/info/alternates");
        std::fs::create_dir_all(alternates.parent().unwrap()).unwrap();
        std::fs::write(&alternates, format!("{}\n", p(&tmp.path().join("gone/.git/objects")))).unwrap();

        repack(&gitdir).await;

        assert!(!alternates.exists());
    }

    // ── gix engine vs git CLI engine ────────────────────────────────────────

    fn sh(dir: &Path, args: &[&str]) {
        // Both workspaces must produce the same nested commit (its hash is
        // the gitlink in the tree), so pin the dates and ignore the
        // developer's global config.
        let st = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_AUTHOR_DATE", "@1700000000 +0000")
            .env("GIT_COMMITTER_DATE", "@1700000000 +0000")
            .output()
            .unwrap();
        assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
    }

    fn write(ws: &Path, rel: &str, data: &[u8]) {
        let p = ws.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, data).unwrap();
    }

    /// One mutation step applied identically to both workspaces.
    fn mutate(ws: &Path, step: usize) {
        match step {
            0 => {
                write(ws, "a.txt", b"alpha\n");
                write(ws, "dir/b.txt", b"bee\n");
                write(ws, "dir/sub/c.md", b"# c\n");
                write(ws, "space name.txt", b"s\n");
                write(ws, "\u{fc}n\u{ef}.txt", b"unicode\n");
                write(ws, "empty.txt", b"");
                write(ws, ".gitignore", b"ignored/\n*.log\n");
                write(ws, "ignored/x.txt", b"no\n");
                write(ws, "debug.log", b"no\n");
                write(ws, ".gitattributes", b"*.crlf text eol=lf\n");
                write(ws, "file.crlf", b"one\r\ntwo\r\n");
                write(ws, "big.bin", &vec![b'x'; (MAX_FILE_SIZE + 1) as usize]);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    write(ws, "run.sh", b"#!/bin/sh\n");
                    std::fs::set_permissions(ws.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
                    std::os::unix::fs::symlink("a.txt", ws.join("link")).unwrap();
                }
            }
            1 => {
                write(ws, "a.txt", b"alpha two\n");
                std::fs::remove_file(ws.join("dir/b.txt")).unwrap();
                write(ws, "dir/new.txt", b"new\n");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(ws.join("run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
                }
            }
            2 => {
                // file → directory and directory → file
                std::fs::remove_file(ws.join("a.txt")).unwrap();
                write(ws, "a.txt/inner", b"inner\n");
                std::fs::remove_dir_all(ws.join("dir/sub")).unwrap();
                write(ws, "dir/sub", b"now a file\n");
            }
            3 => {
                // stat-only change: same bytes rewritten
                write(ws, "space name.txt", b"s\n");
            }
            4 => {
                // embedded repository → gitlink
                write(ws, "nested/readme", b"n\n");
                let n = ws.join("nested");
                sh(&n, &["init", "-q"]);
                sh(&n, &["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
                sh(&n, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "n"]);
            }
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn gix_engine_matches_git_cli() {
        if !is_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (ws_g, ws_c) = (tmp.path().join("ws_gix"), tmp.path().join("ws_cli"));
        let (gd_g, gd_c) = (tmp.path().join("snap_gix"), tmp.path().join("snap_cli"));
        std::fs::create_dir_all(&ws_g).unwrap();
        std::fs::create_dir_all(&ws_c).unwrap();
        // Same canonical paths the real callers pass.
        let (ws_g, ws_c) = (resolve(&ws_g), resolve(&ws_c));
        crate::snapshot_gix::init(&gd_g, &ws_g).unwrap();
        assert!(init_repo_cli(&gd_c, &ws_c).await);
        let key_c = ("cli".to_string(), ws_c.clone());
        let mut last_g: Option<String> = None;
        let mut first = None;
        for step in 0..5 {
            mutate(&ws_g, step);
            mutate(&ws_c, step);
            let tg = crate::snapshot_gix::track(&gd_g, &ws_g, last_g.as_deref(), MAX_FILE_SIZE).unwrap();
            let tc = track_cli("cli", &gd_c, &ws_c, &key_c).await.unwrap();
            LAST_HASHES.lock().unwrap().insert(key_c.clone(), tc.clone());
            assert_eq!(tg, tc, "tree mismatch after step {step}");
            // Every step changes the snapshot except the stat-only one.
            assert_eq!(last_g.as_deref() == Some(tg.as_str()), step == 3, "step {step} tree {tg} vs previous {last_g:?}");
            last_g = Some(tg.clone());
            first.get_or_insert(tg);
            // The index gix wrote must give git (v2) the same tree.
            let (gd, wt) = (p(&gd_g), p(&ws_g));
            let cli_tree = git(&wt_args(&gd, &wt, &["write-tree"]), Some(&ws_g), &[], None).await.text().trim().to_string();
            assert_eq!(cli_tree, last_g.clone().unwrap(), "git write-tree disagrees with gix index after step {step}");
        }
        // The big untracked file and ignored paths are not in the snapshot.
        let (gd, wt) = (p(&gd_g), p(&ws_g));
        let ls = git(&wt_args(&gd, &wt, &["ls-files", "-s"]), Some(&ws_g), &[], None).await.text();
        assert!(!ls.contains("big.bin") && !ls.contains("debug.log") && !ls.contains("ignored/"), "{ls}");
        assert!(ls.contains("160000") && ls.contains("\tnested"), "gitlink missing: {ls}");

        // Restore the first snapshot with gix; re-tracking must reproduce it.
        let first = first.unwrap();
        let r = crate::snapshot_gix::restore(&gd_g, &ws_g, &first, false, MAX_FILE_SIZE).unwrap();
        delete_extras(&ws_g, &r.removed);
        assert!(r.added.contains(&"dir/b.txt".to_string()), "{:?}", r.added);
        assert!(r.removed.contains(&"dir/new.txt".to_string()), "{:?}", r.removed);
        assert_eq!(std::fs::read(ws_g.join("a.txt")).unwrap(), b"alpha\n");
        assert_eq!(std::fs::read(ws_g.join("dir/sub/c.md")).unwrap(), b"# c\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(std::fs::metadata(ws_g.join("run.sh")).unwrap().permissions().mode() & 0o111 != 0);
            assert_eq!(std::fs::read_link(ws_g.join("link")).unwrap(), Path::new("a.txt"));
        }
        let again = crate::snapshot_gix::track(&gd_g, &ws_g, None, MAX_FILE_SIZE).unwrap();
        // `nested/` (an untracked repo dir after restore) re-adds as a gitlink.
        let (gd, wt) = (p(&gd_g), p(&ws_g));
        let d = git(&wt_args(&gd, &wt, &["diff-tree", "-r", "--name-only", &first, &again]), Some(&ws_g), &[], None).await.text();
        assert!(d.trim().is_empty() || d.trim() == "nested", "restore not faithful: {d}");
    }
}
