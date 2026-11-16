use super::super::git_stdout;
use super::super::tests::{commit, git_ok, repo_on_main, ws_query};
use super::*;
use axum::response::IntoResponse;

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
async fn history_pages_the_current_branch_with_no_graph() {
    let d = repo_on_main();
    commit(d.path(), "b.txt");
    commit(d.path(), "c.txt");
    // Another branch's commit never shows, even to an older client that
    // still sends the removed `all=true`.
    git_ok(d.path(), &["checkout", "-q", "-b", "side"]);
    commit(d.path(), "side.txt");
    git_ok(d.path(), &["checkout", "-q", "main"]);
    let v = body_of(git_history(ws_query(d.path(), "&limit=2&all=true")).await.unwrap()).await;
    let subjects: Vec<&str> = v["commits"].as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap()).collect();
    assert_eq!(subjects, ["c.txt", "b.txt"]);
    assert_eq!(v["commits"][0]["refs"], "HEAD -> main");
    assert_eq!(v["next_cursor"], v["commits"][1]["sha"]);
    assert!(v.get("graph").is_none(), "{v}");
    let cursor = v["next_cursor"].as_str().unwrap().to_string();
    let next = body_of(git_history(ws_query(d.path(), &format!("&limit=2&cursor={cursor}"))).await.unwrap()).await;
    assert_eq!(next["commits"].as_array().unwrap().len(), 1);
    assert_eq!(next["commits"][0]["subject"], "init");
    assert_eq!(next["next_cursor"], Value::Null);
    let plain = tempfile::tempdir().unwrap();
    let none = body_of(git_history(ws_query(plain.path(), "")).await.unwrap()).await;
    assert_eq!(none["is_git_repo"], false);
    assert!(none.get("graph").is_none(), "{none}");
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

/// A tracked diff of `bytes` characters in `big.txt`.
fn big_tracked_change(dir: &Path, bytes: usize) {
    std::fs::write(dir.join("big.txt"), "x\n").unwrap();
    git_ok(dir, &["add", "big.txt"]);
    git_ok(dir, &["commit", "-qm", "big"]);
    std::fs::write(dir.join("big.txt"), "y\n".repeat(bytes / 2)).unwrap();
}

#[tokio::test]
async fn diff_keeps_the_untracked_list_when_the_tracked_diff_is_cut() {
    let d = repo_on_main();
    big_tracked_change(d.path(), MAX_GIT_DIFF_CHARS * 2);
    std::fs::write(d.path().join("new.txt"), "n\n").unwrap();
    let v = body_of(git_diff(ws_query(d.path(), "")).await.unwrap()).await;
    assert_eq!(v["truncated"], true);
    assert_eq!(v["untracked"], json!(["new.txt"]));
}

/// A scoped diff names one file; glob characters in it (Next.js
/// `[id].tsx` routes) must not be read as a pathspec pattern.
#[tokio::test]
async fn scoped_diff_treats_paths_literally() {
    let d = repo_on_main();
    commit(d.path(), "[id].txt");
    commit(d.path(), "i.txt");
    std::fs::write(d.path().join("[id].txt"), "changed\n").unwrap();
    std::fs::write(d.path().join("i.txt"), "changed\n").unwrap();
    let v = body_of(git_diff(ws_query(d.path(), "&paths=%5Bid%5D.txt")).await.unwrap()).await;
    let diff = v["diff"].as_str().unwrap();
    assert!(diff.contains("diff --git a/[id].txt b/[id].txt"), "{diff}");
    assert!(!diff.contains("a/i.txt"), "{diff}");
}

async fn changed_files(dir: &Path) -> Value {
    body_of(git_diff_files(ws_query(dir, "")).await.unwrap()).await
}

/// `(path, status, additions, deletions)` per listed file.
fn rows(v: &Value) -> Vec<(String, String, Value, Value)> {
    v["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap().to_string(), f["status"].as_str().unwrap().to_string(), f["additions"].clone(), f["deletions"].clone()))
        .collect()
}

fn paths_of(v: &Value) -> Vec<String> {
    rows(v).into_iter().map(|r| r.0).collect()
}

#[tokio::test]
async fn changed_files_lists_every_file_past_the_diff_cap() {
    let d = repo_on_main();
    commit(d.path(), "zz.txt");
    big_tracked_change(d.path(), MAX_GIT_DIFF_CHARS * 2);
    std::fs::write(d.path().join("zz.txt"), "after the cut\n").unwrap();
    std::fs::write(d.path().join("new.txt"), "n\n").unwrap();
    // The diff body stops inside big.txt: zz.txt and new.txt are not in it.
    let view = body_of(git_diff(ws_query(d.path(), "")).await.unwrap()).await;
    assert!(!view["diff"].as_str().unwrap().contains("zz.txt"));
    let v = changed_files(d.path()).await;
    assert_eq!(paths_of(&v), ["big.txt", "new.txt", "zz.txt"]);
    assert_eq!((v["total"].clone(), v["truncated"].clone()), (json!(3), json!(false)));
}

#[tokio::test]
async fn changed_files_report_status_and_line_counts() {
    let d = repo_on_main();
    commit(d.path(), "gone.txt");
    commit(d.path(), "old.txt");
    std::fs::write(d.path().join("bin.dat"), [0u8, 1, 2]).unwrap();
    git_ok(d.path(), &["add", "bin.dat"]);
    git_ok(d.path(), &["commit", "-qm", "bin"]);
    std::fs::write(d.path().join("a.txt"), "a\nb\n").unwrap();
    std::fs::remove_file(d.path().join("gone.txt")).unwrap();
    git_ok(d.path(), &["mv", "old.txt", "renamed.txt"]);
    std::fs::write(d.path().join("bin.dat"), [0u8, 1, 3]).unwrap();
    std::fs::write(d.path().join("new.txt"), "1\r\n2\n3").unwrap();
    std::fs::write(d.path().join("large.txt"), "z".repeat(MAX_UNTRACKED_DIFF_BYTES as usize + 1)).unwrap();
    let v = changed_files(d.path()).await;
    let row = |p: &str, s: &str, a: i64, d: i64| (p.to_string(), s.to_string(), json!(a), json!(d));
    assert_eq!(
        rows(&v),
        [
            row("a.txt", "M", 1, 0),
            row("bin.dat", "M", 0, 0),
            row("gone.txt", "D", 0, 1),
            row("large.txt", "A", 0, 0),
            row("new.txt", "A", 3, 0),
            row("old.txt", "D", 0, 1),
            row("renamed.txt", "A", 1, 0),
        ]
    );
}

#[tokio::test]
async fn changed_files_cap_the_list_and_report_the_total() {
    let d = repo_on_main();
    std::fs::create_dir(d.path().join("gen")).unwrap();
    for i in 0..=MAX_FILES_LISTED {
        std::fs::write(d.path().join(format!("gen/{i:05}.txt")), "g\n").unwrap();
    }
    let v = changed_files(d.path()).await;
    assert_eq!(v["files"].as_array().unwrap().len(), MAX_FILES_LISTED);
    assert_eq!((v["total"].clone(), v["truncated"].clone()), (json!(MAX_FILES_LISTED + 1), json!(true)));
}

#[tokio::test]
async fn changed_files_stop_counting_untracked_lines_past_the_read_budget() {
    let d = repo_on_main();
    let size = MAX_UNTRACKED_DIFF_BYTES as usize - 1;
    let n = UNTRACKED_COUNT_BUDGET_BYTES as usize / size + 2;
    for i in 0..n {
        std::fs::write(d.path().join(format!("u{i:03}.txt")), "u\n".repeat(size / 2)).unwrap();
    }
    let v = changed_files(d.path()).await;
    let files = v["files"].as_array().unwrap();
    assert_eq!(files[0]["additions"], json!(size / 2));
    assert_eq!(files[n - 1]["additions"], Value::Null);
}

#[tokio::test]
async fn changed_files_work_before_the_first_commit_and_outside_git() {
    let d = tempfile::tempdir().unwrap();
    let v = changed_files(d.path()).await;
    assert_eq!((v["is_git_repo"].clone(), v["files"].clone()), (json!(false), json!([])));
    git_ok(d.path(), &["init", "-q"]);
    std::fs::write(d.path().join("b.txt"), "b\n").unwrap();
    let v = changed_files(d.path()).await;
    assert_eq!(v["is_git_repo"], true);
    assert_eq!(rows(&v), [("b.txt".to_string(), "A".to_string(), json!(1), json!(0))]);
}

fn ws_body(dir: &Path, extra: Value) -> Bytes {
    let mut b = json!({"workspace": dir.to_str().unwrap()});
    b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    Bytes::from(b.to_string())
}

fn head_subject(dir: &Path) -> String {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(["log", "-1", "--format=%s"]).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

#[tokio::test]
async fn discard_restores_a_tracked_file_and_deletes_an_added_one() {
    let d = repo_on_main();
    std::fs::write(d.path().join("a.txt"), "changed\n").unwrap();
    std::fs::write(d.path().join("new.txt"), "n").unwrap();
    let v = body_of(git_discard(ws_body(d.path(), json!({"path": "a.txt", "status": "M"}))).await.unwrap()).await;
    assert_eq!(v, json!({"workspace": d.path().to_str().unwrap(), "path": "a.txt", "status": "M"}));
    assert_eq!(std::fs::read_to_string(d.path().join("a.txt")).unwrap(), "a\n");
    body_of(git_discard(ws_body(d.path(), json!({"path": "new.txt", "status": "A"}))).await.unwrap()).await;
    assert!(!d.path().join("new.txt").exists());
    let status = |r: ApiResult<Response>| r.err().map(|e| e.into_response().status().as_u16());
    assert_eq!(status(git_discard(ws_body(d.path(), json!({"path": "../x", "status": "M"}))).await), Some(400));
    assert_eq!(status(git_discard(ws_body(d.path(), json!({"path": "", "status": "M"}))).await), Some(400));
    assert_eq!(status(git_discard(ws_body(d.path(), json!({"path": "a.txt"}))).await), Some(422));
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(status(git_discard(ws_body(plain.path(), json!({"path": "a.txt", "status": "M"}))).await), Some(400));
}

#[tokio::test]
async fn commit_diff_shows_one_commit_and_rejects_a_bad_sha() {
    let d = repo_on_main();
    commit(d.path(), "b.txt");
    let sha = git_stdout(d.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
    let v = body_of(commit_diff(ws_query(d.path(), &format!("&sha={sha}"))).await.unwrap()).await;
    assert_eq!(v["sha"], json!(sha));
    assert!(v["diff"].as_str().unwrap().contains("+++ b/b.txt"), "{v}");
    let status = |r: ApiResult<Response>| r.err().map(|e| e.into_response().status().as_u16());
    assert_eq!(status(commit_diff(ws_query(d.path(), "&sha=xyz")).await), Some(422));
    assert_eq!(status(commit_diff(ws_query(d.path(), "&sha=abcdef0")).await), Some(404));
    assert_eq!(status(commit_diff(ws_query(d.path(), "")).await), Some(422));
}

#[tokio::test]
async fn undo_moves_head_back_one_commit() {
    let d = repo_on_main();
    commit(d.path(), "b.txt");
    let v = body_of(git_undo(ws_body(d.path(), json!({}))).await.unwrap()).await;
    assert_eq!(v, json!({"workspace": d.path().to_str().unwrap(), "success": true}));
    assert_eq!(head_subject(d.path()), "init");
    assert!(d.path().join("b.txt").exists(), "a soft reset keeps the files");
    // The first commit is undone by deleting HEAD; then nothing is left.
    body_of(git_undo(ws_body(d.path(), json!({}))).await.unwrap()).await;
    let status = |r: ApiResult<Response>| r.err().map(|e| e.into_response().status().as_u16());
    assert_eq!(status(git_undo(ws_body(d.path(), json!({}))).await), Some(400));
    assert_eq!(status(git_undo(Bytes::from(r#"{"workspace": ""}"#)).await), Some(400));
}

#[tokio::test]
async fn revert_adds_a_reverting_commit() {
    let d = repo_on_main();
    git_ok(d.path(), &["config", "user.name", "t"]);
    git_ok(d.path(), &["config", "user.email", "t@t"]);
    git_ok(d.path(), &["config", "commit.gpgsign", "false"]);
    commit(d.path(), "b.txt");
    let sha = git_stdout(d.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
    let v = body_of(git_revert(ws_body(d.path(), json!({"sha": sha}))).await.unwrap()).await;
    assert_eq!(v, json!({"workspace": d.path().to_str().unwrap(), "sha": sha, "success": true}));
    assert_eq!(head_subject(d.path()), "Revert \"b.txt\"");
    assert!(!d.path().join("b.txt").exists());
    let status = |r: ApiResult<Response>| r.err().map(|e| e.into_response().status().as_u16());
    assert_eq!(status(git_revert(ws_body(d.path(), json!({"sha": "xyz"}))).await), Some(422));
    assert_eq!(status(git_revert(ws_body(d.path(), json!({"sha": "abcdef0"}))).await), Some(400));
    assert_eq!(status(git_revert(ws_body(d.path(), json!({}))).await), Some(422));
}
