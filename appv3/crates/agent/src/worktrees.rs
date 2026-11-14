//! Git worktrees of a registered repository: the git runner, OpenAgentd's
//! managed worktree folders, and how a folder is filed in the sidebar.
//!
//! A folder belongs to a repository by git's own link (`--git-common-dir`),
//! wherever it lives on disk: a managed worktree, a worktree someone made
//! with `git worktree add`, or a subfolder of either. Shared by the HTTP
//! routes and the lead's `workspace` tool.

use crate::manager;
use appv3_core::settings::settings;
use appv3_db::{self as db, DbPool};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A git failure with the HTTP status the routes answer with.
#[derive(Debug, Clone)]
pub struct GitError {
    pub status: u16,
    pub detail: String,
}

impl GitError {
    pub fn new(status: u16, detail: impl Into<String>) -> Self {
        Self { status, detail: detail.into() }
    }
    fn unprocessable(detail: impl Into<String>) -> Self {
        Self::new(422, detail)
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

pub type GitResult<T> = Result<T, GitError>;

pub struct GitOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// How long a timed-out git gets after SIGTERM to remove its lock files.
const GIT_TERM_GRACE: Duration = Duration::from_secs(2);

/// `subprocess.run(["git", "-C", ws, *args], timeout=20)`.
pub async fn run_git(ws: &Path, args: &[&str]) -> GitResult<GitOut> {
    run_git_timeout(ws, args, Duration::from_secs(20)).await
}

/// Run git to completion even if the caller goes away. git holds
/// `.git/index.lock` (and ref locks) while it writes, and SIGKILL strands
/// them: every later git command then fails until someone deletes the lock.
/// So the process lives in its own task (a dropped request, e.g. a client
/// abort, does not kill it) and a timeout sends SIGTERM first, which git
/// answers by removing its locks.
pub async fn run_git_timeout(ws: &Path, args: &[&str], timeout: Duration) -> GitResult<GitOut> {
    use tokio::io::AsyncReadExt;
    let mut cmd = tokio::process::Command::new("git");
    appv3_core::proctree::configure(&mut cmd);
    cmd.arg("-C").arg(ws).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| GitError::new(500, format!("git failed: {e}")))?;
    let tree = appv3_core::proctree::ProcessTree::attach(&child);
    let (mut so, mut se) = (child.stdout.take(), child.stderr.take());
    let run = tokio::spawn(async move {
        let io = async {
            let (mut out, mut err) = (vec![], vec![]);
            let (_, _, status) = tokio::join!(
                async {
                    if let Some(s) = so.as_mut() {
                        let _ = s.read_to_end(&mut out).await;
                    }
                },
                async {
                    if let Some(s) = se.as_mut() {
                        let _ = s.read_to_end(&mut err).await;
                    }
                },
                child.wait()
            );
            (out, err, status)
        };
        let finished = tokio::time::timeout(timeout, io).await;
        if finished.is_err() {
            tree.terminate(&mut child, GIT_TERM_GRACE).await;
        }
        finished.ok()
    });
    match run.await {
        Ok(Some((out, err, Ok(status)))) => {
            Ok(GitOut { code: status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&out).to_string(), stderr: String::from_utf8_lossy(&err).to_string() })
        }
        Ok(Some((_, _, Err(e)))) => Err(GitError::new(500, format!("git failed: {e}"))),
        Err(e) => Err(GitError::new(500, format!("git failed: {e}"))),
        Ok(None) => {
            let cmdline = std::iter::once("git".to_string())
                .chain(["-C".to_string(), ws.display().to_string()])
                .chain(args.iter().map(|a| a.to_string()))
                .map(|a| format!("'{a}'"))
                .collect::<Vec<_>>()
                .join(", ");
            Err(GitError::new(500, format!("git failed: Command '[{cmdline}]' timed out after {} seconds", timeout.as_secs())))
        }
    }
}

pub fn fail_detail(o: &GitOut, fallback: &str) -> String {
    let e = o.stderr.trim();
    if !e.is_empty() {
        return e.to_string();
    }
    let s = o.stdout.trim();
    if !s.is_empty() {
        return s.to_string();
    }
    fallback.to_string()
}

pub async fn require_git_repo(ws: &Path) -> GitResult<()> {
    let r = run_git(ws, &["rev-parse", "--is-inside-work-tree"]).await?;
    if r.code != 0 || r.stdout.trim() != "true" {
        return Err(GitError::unprocessable("Worktrees are only supported for git projects."));
    }
    Ok(())
}

pub fn slugify(v: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[^a-z0-9]+").unwrap());
    let slug = RE.replace_all(&v.trim().to_lowercase(), "-").trim_matches('-').to_string();
    slug.chars().take(80).collect::<String>().trim_matches('-').to_string()
}

fn validate_name(v: Option<&str>) -> GitResult<String> {
    let mut name = slugify(v.unwrap_or(""));
    if name.is_empty() {
        name = "session".into();
    }
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$").unwrap());
    if !RE.is_match(&name) {
        return Err(GitError::unprocessable("Worktree name may only contain letters, numbers, '.', '_' and '-'."));
    }
    Ok(name)
}

/// Branch prefixes OpenAgentd creates; removing a managed worktree deletes
/// its branch only when it carries one of them (see [`remove_worktree`]).
pub const OWN_BRANCH_PREFIXES: [&str; 2] = ["openagentd/", "oad/"];

/// What removing a worktree did, or (dry run) would do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemovedWorktree {
    /// The branch the worktree was on.
    pub branch: Option<String>,
    /// Commits on an OpenAgentd branch that no other branch holds.
    pub unmerged_commits: u64,
    pub branch_deleted: bool,
}

/// Commits on `branch` that no other local or remote-tracking branch holds.
async fn unmerged_commits(source: &Path, branch: &str) -> GitResult<u64> {
    let exclude = format!("--exclude={branch}");
    let r = run_git(source, &["rev-list", "--count", &format!("refs/heads/{branch}"), "--not", &exclude, "--branches", "--remotes"]).await?;
    if r.code != 0 {
        return Err(GitError::new(500, fail_detail(&r, "Failed to count the branch's commits.")));
    }
    r.stdout.trim().parse().map_err(|_| GitError::new(500, "Failed to count the branch's commits."))
}

/// Remove the worktree `directory` of `source` (a folder git no longer lists
/// is already gone). Its branch goes with it only when OpenAgentd made the
/// branch and no commit would be lost: a branch whose commits are on no
/// other branch is kept. `dry_run` only reports what would happen.
pub async fn remove_worktree(source: &Path, directory: &Path, dry_run: bool) -> GitResult<RemovedWorktree> {
    let target = resolve(directory);
    let entry = list_entries(source).await?.into_iter().find(|(d, _)| !d.is_empty() && canonical(Path::new(d)) == target);
    let Some((_, branch)) = entry else { return Ok(RemovedWorktree::default()) };
    let own = branch.as_deref().filter(|b| OWN_BRANCH_PREFIXES.iter().any(|p| b.starts_with(p)));
    let unmerged = match own {
        Some(b) => unmerged_commits(source, b).await?,
        None => 0,
    };
    let delete = own.is_some() && unmerged == 0;
    if !dry_run {
        let dstr = directory.display().to_string();
        let removed = run_git(source, &["worktree", "remove", "--force", &dstr]).await?;
        if removed.code != 0 {
            return Err(GitError::new(500, fail_detail(&removed, "Failed to remove git worktree.")));
        }
        if let Some(b) = own.filter(|_| delete) {
            run_git(source, &["branch", "-D", b]).await?;
        }
    }
    Ok(RemovedWorktree { branch: branch.clone(), unmerged_commits: unmerged, branch_deleted: delete })
}

async fn validate_branch(source: &Path, v: Option<&str>, name: &str, detached: bool) -> GitResult<Option<String>> {
    if detached {
        return Ok(None);
    }
    let branch = match v {
        Some(b) if !b.is_empty() => b.trim().to_string(),
        _ => format!("openagentd/{name}"),
    };
    if branch.is_empty() || branch.starts_with('-') {
        return Err(GitError::unprocessable("Invalid branch name."));
    }
    if run_git(source, &["check-ref-format", "--branch", &branch]).await?.code != 0 {
        return Err(GitError::unprocessable("Invalid branch name."));
    }
    Ok(Some(branch))
}

pub fn resolve(p: &Path) -> PathBuf {
    appv3_tools::denied::resolve(p)
}

/// The folder for `source`'s new worktrees, under [`Settings::worktrees_dir`].
pub fn worktree_root(source: &Path, create: bool) -> PathBuf {
    let root = settings().worktrees_dir.join(repo_folder(source));
    if create {
        let _ = std::fs::create_dir_all(&root);
    }
    resolve(&root)
}

/// `<repo>-<key>`: one folder per repository under a worktrees root.
fn repo_folder(source: &Path) -> String {
    let key = hex(&sha1(source.display().to_string().as_bytes()))[..10].to_string();
    let name = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    format!("{name}-{key}")
}

/// Whether `dir` is a worktree OpenAgentd made for `source`: under its folder
/// in the current worktrees root, or in the pre-v3.50.0 one in the data dir.
pub fn is_managed_for(dir: &Path, source: &Path) -> bool {
    let folder = repo_folder(source);
    settings().worktree_roots().iter().any(|root| has_ancestor(dir, &resolve(&root.join(&folder))))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// SHA-1 (only used for the v2-compatible worktree directory key).
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub name: String,
    pub directory: String,
    pub branch: Option<String>,
    pub managed: bool,
}

async fn candidate(source: &Path, name: &str, branch: Option<&str>) -> GitResult<WorktreeInfo> {
    let root = worktree_root(source, true);
    for attempt in 0..27 {
        let suffix = if attempt == 0 { String::new() } else { format!("-{attempt}") };
        let cand = format!("{name}{suffix}");
        let dir = resolve(&root.join(&cand));
        if dir.parent() != Some(root.as_path()) {
            return Err(GitError::unprocessable("Invalid worktree path."));
        }
        if dir.exists() {
            continue;
        }
        let cand_branch = match branch {
            Some(b) if attempt > 0 => Some(format!("{b}{suffix}")),
            other => other.map(String::from),
        };
        if let Some(cb) = &cand_branch {
            if run_git(source, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{cb}")]).await?.code == 0 {
                continue;
            }
        }
        return Ok(WorktreeInfo { name: cand, directory: dir.display().to_string(), branch: cand_branch, managed: true });
    }
    Err(GitError::new(409, "Failed to generate a unique worktree name."))
}

pub fn parse_worktree_list(text: &str) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = vec![];
    for line in text.lines() {
        if let Some(d) = line.strip_prefix("worktree ") {
            out.push((d.trim().to_string(), None));
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(last) = out.last_mut() {
                let b = b.trim();
                last.1 = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        }
    }
    out
}

/// `git worktree list`: every checkout of the repository (the main one first).
pub async fn list_entries(source: &Path) -> GitResult<Vec<(String, Option<String>)>> {
    let r = run_git(source, &["worktree", "list", "--porcelain"]).await?;
    if r.code != 0 {
        return Err(GitError::new(500, fail_detail(&r, "Failed to read git worktrees.")));
    }
    Ok(parse_worktree_list(&r.stdout))
}

pub fn canonical(p: &Path) -> PathBuf {
    resolve(&appv3_core::home::expanduser(&p.display().to_string()))
}

pub fn has_ancestor(path: &Path, anc: &Path) -> bool {
    path != anc && path.starts_with(anc)
}

/// Where a folder sits in its git repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placement {
    /// Not inside a git repository, or the top of a repository's main
    /// checkout: a repository row of its own.
    Repo,
    /// The top of a linked worktree of `source` (the main checkout).
    Worktree { source: String, managed: bool },
    /// A folder below the top of a checkout; `source` is the main checkout
    /// of its repository.
    Folder { source: String },
}

/// File `directory` under its repository by git's link between a worktree
/// and its repository (`--git-common-dir`), wherever it lives on disk.
pub async fn placement(directory: &Path) -> Placement {
    let resolved = canonical(directory);
    let Ok(top) = run_git(&resolved, &["rev-parse", "--show-toplevel"]).await else { return Placement::Repo };
    if top.code != 0 || top.stdout.trim().is_empty() {
        return Placement::Repo;
    }
    let top = resolve(Path::new(top.stdout.trim()));
    let Ok(common) = run_git(&resolved, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await else { return Placement::Repo };
    if common.code != 0 {
        return Placement::Repo;
    }
    let cp = resolve(Path::new(common.stdout.trim()));
    // A bare repository's common dir is the repository itself.
    let Some(source) = (if cp.file_name().is_some_and(|n| n == ".git") { cp.parent().map(Path::to_path_buf) } else { Some(cp) }) else { return Placement::Repo };
    let source_str = source.display().to_string();
    if top != resolved {
        return if source.is_dir() { Placement::Folder { source: source_str } } else { Placement::Repo };
    }
    if source == resolved {
        return Placement::Repo;
    }
    let managed = is_managed_for(&resolved, &source);
    Placement::Worktree { source: source_str, managed }
}

/// The repository of a worktree OpenAgentd created under its data folder.
pub async fn find_managed_worktree_source(directory: &Path) -> Option<String> {
    let resolved = canonical(directory);
    if !settings().worktree_roots().iter().any(|root| has_ancestor(&resolved, &resolve(root))) {
        return None;
    }
    match placement(&resolved).await {
        Placement::Worktree { source, managed: true } => Some(source),
        _ => None,
    }
}

/// Record `workspace` as a sidebar workspace, filed under its repository
/// when it is a worktree or a subfolder of one. The Chat workspace is never
/// listed. Un-hides it.
pub async fn register_workspace(pool: &DbPool, workspace: &str) -> anyhow::Result<()> {
    if workspace.is_empty() || settings().is_chat_workspace(Some(Path::new(workspace))) {
        return Ok(());
    }
    match placement(Path::new(workspace)).await {
        Placement::Repo => {
            // Keep a row's existing filing (e.g. one recorded before its
            // folder was deleted) when git cannot place it any more.
            db::upsert_coding_workspace(pool, workspace, "repo", None, None, false, false).await?;
        }
        Placement::Worktree { source, managed } => {
            ensure_repo_row(pool, &source).await?;
            let name = db::get_workspace_by_path(pool, &db::resolve_path(workspace)).await?.and_then(|r| r.name);
            db::upsert_coding_workspace(pool, workspace, "worktree", Some(&source), name.as_deref(), managed, false).await?;
        }
        Placement::Folder { source } => {
            ensure_repo_row(pool, &source).await?;
            db::upsert_coding_workspace(pool, workspace, "folder", Some(&source), None, false, false).await?;
        }
    }
    Ok(())
}

/// Why a relocate was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelocateError {
    /// 422: the request itself does not hold (paths, folder still there…).
    Invalid(String),
    /// 409: sessions in the workspace are running; their titles.
    Busy(Vec<String>),
}

/// What a relocate did, or (dry run) would do.
#[derive(Debug, Clone, Default)]
pub struct RelocateReport {
    pub workspace: String,
    pub summary: db::RelocateSummary,
    /// Managed worktrees moved into the new repository's worktree folder: `(old, new)`.
    pub moved: Vec<(String, String)>,
    /// Git steps that failed; the move itself stands.
    pub warnings: Vec<String>,
}

/// Check a relocate of the repository `from` (its folder gone) to the
/// folder `to`; returns the resolved `to`.
/// Returns `(from, to)` in the stored form (`db::relocate_path`), so a
/// trailing separator or a lower-case drive letter still finds the row.
async fn check_relocate(pool: &DbPool, from: &str, to: &str) -> Result<(String, String), RelocateError> {
    let from = db::relocate_path(from);
    let from = from.as_str();
    let row = db::get_workspace_by_path(pool, from).await.map_err(|e| RelocateError::Invalid(e.to_string()))?;
    if !row.as_ref().is_some_and(|r| r.kind == "repo" && r.deleted_at.is_none()) {
        return Err(RelocateError::Invalid(format!("{from} is not a workspace in the sidebar.")));
    }
    if Path::new(from).exists() {
        return Err(RelocateError::Invalid(format!("The folder {from} still exists; only a missing folder can be located.")));
    }
    let to = manager::validate_workspace(to, true).map_err(RelocateError::Invalid)?;
    if settings().is_chat_workspace(Some(Path::new(&to))) {
        return Err(RelocateError::Invalid("A workspace cannot move to the Chat folder.".into()));
    }
    if db::rebase_path(&to, from, &to).is_some() {
        return Err(RelocateError::Invalid("The new folder cannot be inside the old one.".into()));
    }
    Ok((from.to_string(), to))
}

/// Every path a relocate from `from` touches: `from` and paths inside it,
/// plus the worktrees filed under it.
fn relocated_paths(from: &str, worktrees: &[(String, bool)]) -> impl Fn(&str) -> bool {
    let from = from.to_string();
    let worktrees: Vec<String> = worktrees.iter().map(|(p, _)| p.clone()).collect();
    move |p: &str| db::rebase_path(p, &from, &from).is_some() || worktrees.iter().any(|w| db::rebase_path(p, w, w).is_some())
}

/// Point the repository `from`, whose folder is gone (renamed or moved),
/// at `to`, keeping everything recorded under it: sessions, scheduled
/// tasks, worktree and subfolder rows, and groups (`db::relocate_workspace`;
/// a workspace already at `to` merges). Then git: `worktree repair` relinks
/// the worktrees to the moved repository, and OpenAgentd's own worktrees
/// move into the new repository's worktree folder, where it recognises them
/// as its own. Refused while a session there is running. `dry_run` only
/// reports what would move.
pub async fn relocate_repository(pool: &DbPool, from: &str, to: &str, dry_run: bool) -> Result<RelocateReport, RelocateError> {
    let invalid = |e: anyhow::Error| RelocateError::Invalid(e.to_string());
    let (from, to) = check_relocate(pool, from, to).await?;
    let from = from.as_str();
    let summary = db::relocate_summary(pool, from, &to).await.map_err(invalid)?;
    let under = relocated_paths(from, &summary.worktrees);
    let mut report = RelocateReport { workspace: to.clone(), summary: summary.clone(), ..Default::default() };
    if dry_run {
        return Ok(report);
    }

    // Running sessions hold the old path; so do live idle ones, which are
    // dropped and start again from their row on the next message.
    let (busy, idle) = manager::live_sessions_in(&under);
    let running = crate::stream_store::store().running_session_ids();
    let mut busy_ids: Vec<String> = busy.iter().map(|s| s.session_id()).collect();
    for row in db::get_sessions_by_ids(pool, &running).await.map_err(invalid)? {
        if under(&row.workspace) {
            busy_ids.push(db::codec::api_uuid(&row.id));
        }
    }
    if !busy_ids.is_empty() {
        busy_ids.sort();
        busy_ids.dedup();
        let rows = db::get_sessions_by_ids(pool, &busy_ids).await.map_err(invalid)?;
        let titles = busy_ids
            .iter()
            .map(|id| rows.iter().find(|r| db::codec::api_uuid(&r.id) == *id).and_then(|r| r.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled session".into()))
            .collect();
        return Err(RelocateError::Busy(titles));
    }
    if !idle.is_empty() {
        manager::evict_sessions(&idle.iter().map(|s| s.session_id()).collect()).await;
    }

    db::relocate_workspace(pool, from, &to).await.map_err(invalid)?;

    let target = Path::new(&to);
    let present: Vec<&(String, bool)> = summary.worktrees.iter().filter(|(p, _)| Path::new(p).is_dir()).collect();
    if present.is_empty() {
        return Ok(report);
    }
    let mut args = vec!["worktree", "repair"];
    args.extend(present.iter().map(|(p, _)| p.as_str()));
    match run_git(target, &args).await {
        Ok(o) if o.code == 0 => {}
        Ok(o) => report.warnings.push(fail_detail(&o, "git worktree repair failed.")),
        Err(e) => report.warnings.push(e.detail),
    }
    for (old, _) in present.iter().filter(|(_, managed)| *managed) {
        let Some(name) = Path::new(old).file_name() else { continue };
        let new = worktree_root(target, true).join(name);
        let new_s = new.display().to_string();
        if new_s == *old {
            continue;
        }
        if new.exists() {
            report.warnings.push(format!("Kept {old} in place: {new_s} already exists."));
            continue;
        }
        match run_git(target, &["worktree", "move", old, &new_s]).await {
            Ok(o) if o.code == 0 => {
                let new_s = resolve(&new).display().to_string();
                db::relocate_workspace(pool, old, &new_s).await.map_err(invalid)?;
                report.moved.push((old.clone(), new_s));
            }
            Ok(o) => report.warnings.push(format!("Kept {old} in place: {}", fail_detail(&o, "git worktree move failed."))),
            Err(e) => report.warnings.push(format!("Kept {old} in place: {}", e.detail)),
        }
    }
    Ok(report)
}

/// Make sure the repository row exists without un-hiding a hidden one.
async fn ensure_repo_row(pool: &DbPool, source: &str) -> anyhow::Result<()> {
    match db::get_workspace_by_path(pool, &db::resolve_path(source)).await? {
        Some(row) if row.kind == "repo" && row.deleted_at.is_none() => {
            if row.hidden {
                // Opening one of its checkouts brings the repository back.
                db::upsert_coding_workspace(pool, source, "repo", None, row.name.as_deref(), false, false).await?;
            }
        }
        _ => {
            db::upsert_coding_workspace(pool, source, "repo", None, None, false, false).await?;
        }
    }
    Ok(())
}

/// File every visible repository row that git places under another
/// repository (worktrees and subfolders registered before this filing
/// existed). Run once at startup.
pub async fn reclassify_workspaces(pool: &DbPool) {
    let Ok(rows) = db::list_visible_coding_workspaces(pool).await else { return };
    for row in rows.into_iter().filter(|r| r.kind == "repo") {
        if !Path::new(&row.path).is_dir() {
            continue;
        }
        if placement(Path::new(&row.path)).await != Placement::Repo {
            if let Err(e) = register_workspace(pool, &row.path).await {
                tracing::warn!("workspace_reclassify_failed path={} err={}", row.path, e);
            }
        }
    }
}

/// Create a managed worktree of `source_workspace` (its HEAD) and register it.
pub async fn create_worktree(pool: &DbPool, source_workspace: &str, name: Option<&str>, branch: Option<&str>, detached: bool) -> GitResult<WorktreeInfo> {
    let source = manager::validate_workspace(source_workspace, true).map(PathBuf::from).map_err(GitError::unprocessable)?;
    create_worktree_at(pool, &source, &source, name, branch, detached).await
}

/// Create a managed worktree of the repository `source` whose new branch
/// starts at `base`'s HEAD (`base` is any checkout of the repository).
pub async fn create_worktree_at(pool: &DbPool, source: &Path, base: &Path, name: Option<&str>, branch: Option<&str>, detached: bool) -> GitResult<WorktreeInfo> {
    require_git_repo(source).await?;
    let name = validate_name(name)?;
    let branch = validate_branch(source, branch, &name, detached).await?;
    let info = candidate(source, &name, branch.as_deref()).await?;
    let head = run_git(base, &["rev-parse", "HEAD"]).await?;
    if head.code != 0 {
        return Err(GitError::unprocessable("The repository has no commits yet, so it cannot have a worktree."));
    }
    let head = head.stdout.trim().to_string();
    let mut args = vec!["worktree", "add", "--no-checkout"];
    match &info.branch {
        Some(b) => args.extend(["-b", b.as_str(), info.directory.as_str(), head.as_str()]),
        None => args.extend(["--detach", info.directory.as_str(), head.as_str()]),
    }
    let created = run_git(source, &args).await?;
    if created.code != 0 {
        return Err(GitError::new(500, fail_detail(&created, "Failed to create git worktree.")));
    }
    let populated = run_git(Path::new(&info.directory), &["reset", "--hard"]).await?;
    if populated.code != 0 {
        run_git(source, &["worktree", "remove", "--force", &info.directory]).await?;
        if let Some(b) = &info.branch {
            run_git(source, &["branch", "-D", b]).await?;
        }
        return Err(GitError::new(500, fail_detail(&populated, "Failed to populate worktree.")));
    }
    let src = source.display().to_string();
    let db_err = |e: anyhow::Error| GitError::new(500, e.to_string());
    db::upsert_coding_workspace(pool, &src, "repo", None, None, false, false).await.map_err(db_err)?;
    db::upsert_coding_workspace(pool, &info.directory, "worktree", Some(&src), Some(&info.name), true, false).await.map_err(db_err)?;
    Ok(info)
}

#[cfg(test)]
mod tests {
    #[test]
    fn sha1_known() {
        assert_eq!(super::hex(&super::sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(super::hex(&super::sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    }
}

/// `git commit -a` holds `.git/index.lock` while its hooks run (the hook's
/// `GIT_INDEX_FILE` is the lock), so a slow pre-commit hook is a reliable
/// window for killing git mid-write. A plain `git commit` releases the lock
/// before running hooks.
#[cfg(all(test, unix))]
mod lock_tests {
    use super::run_git_timeout;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    /// A repo with one commit, a modified tracked file, and a pre-commit hook running `hook`.
    fn repo_committing_through(hook: &str) -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let hooks = d.path().join(".git/hooks");
        git_ok(d.path(), &["init", "-q"]);
        for (k, v) in [("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false"), ("core.hooksPath", hooks.to_str().unwrap())] {
            git_ok(d.path(), &["config", k, v]);
        }
        std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
        git_ok(d.path(), &["add", "a.txt"]);
        git_ok(d.path(), &["commit", "-qm", "init"]);
        std::fs::create_dir_all(&hooks).unwrap();
        let pre_commit = hooks.join("pre-commit");
        std::fs::write(&pre_commit, format!("#!/bin/sh\n{hook}\n")).unwrap();
        std::fs::set_permissions(&pre_commit, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(d.path().join("a.txt"), "a\nb\n").unwrap();
        d
    }

    async fn wait_until(limit: Duration, done: impl Fn() -> bool) {
        let deadline = Instant::now() + limit;
        while !done() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The client gave up (React Query cancels superseded requests), so axum
    /// dropped the handler. git must still finish: SIGKILL mid-write leaves
    /// a stale `.git/index.lock` that blocks every later git command.
    #[tokio::test]
    async fn dropped_request_lets_a_writing_git_finish() {
        let d = repo_committing_through("sleep 1");
        let lock = d.path().join(".git/index.lock");
        let dropped = tokio::time::timeout(Duration::from_millis(300), run_git_timeout(d.path(), &["commit", "-aqm", "second"], Duration::from_secs(20))).await;
        assert!(dropped.is_err(), "the commit should still be running");
        assert!(lock.exists(), "precondition: git holds .git/index.lock inside its hook");
        wait_until(Duration::from_secs(10), || !lock.exists()).await;
        assert!(!lock.exists(), "git was killed mid-commit and stranded .git/index.lock");
        assert_eq!(git_ok(d.path(), &["rev-list", "--count", "HEAD"]).trim(), "2", "the commit did not land");
    }

    /// A timed-out git gets SIGTERM, which it answers by removing its locks.
    #[tokio::test]
    async fn timed_out_git_removes_its_index_lock() {
        let d = repo_committing_through("sleep 30");
        let lock = d.path().join(".git/index.lock");
        let r = run_git_timeout(d.path(), &["commit", "-aqm", "second"], Duration::from_millis(500)).await;
        let Err(e) = r else { panic!("the commit should time out") };
        assert!(e.detail.contains("timed out"), "{:?}", e.detail);
        wait_until(Duration::from_secs(5), || !lock.exists()).await;
        assert!(!lock.exists(), "the timeout killed git without letting it remove .git/index.lock");
    }
}
