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
    for f in
        ["out/clip.mp4", "out/nested/frame.png", "out/node_modules/p.js", "out/.DS_Store", "web/node_modules/q.js", "debug.log", ".DS_Store", "keep.txt", ".env", "out/.env.local"]
    {
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
    // The first call started a watcher, so the listing may be reused
    // until its event for `new.txt` arrives.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let changed = with_etag(&h, list_workspace_files(ws_query(d.path(), "")).await.unwrap()).await;
        if changed.status() == 200 {
            assert_ne!(changed.headers()[axum::http::header::ETAG], tag);
            break;
        }
        assert!(Instant::now() < deadline, "the listing never showed new.txt");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

static GIT_SPAWNS: LazyLock<Mutex<HashMap<PathBuf, usize>>> = LazyLock::new(Mutex::default);

pub(super) fn count_git_spawn(cwd: &Path) {
    *GIT_SPAWNS.lock().unwrap().entry(cwd.to_path_buf()).or_default() += 1;
}

/// Git processes started so far for `root` or a directory inside it.
fn git_spawns(root: &Path) -> usize {
    GIT_SPAWNS.lock().unwrap().iter().filter(|(p, _)| p.starts_with(root)).map(|(_, n)| n).sum()
}

/// `dir`, canonical, with its file watcher running.
fn watched(dir: &Path) -> PathBuf {
    let root = dunce::canonicalize(dir).unwrap();
    crate::watch::touch_workspace(&root, "test");
    assert!(eventually(|| crate::watch::generation(&root).is_some()), "the watcher never started");
    root
}

/// Whether `cond` holds within 10 s (file watcher events take a moment).
fn eventually(cond: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    true
}

#[test]
fn a_watched_listing_is_reused_until_the_workspace_changes() {
    let d = repo_on_main();
    let root = watched(d.path());
    let first = listed(&root);
    let spawns = git_spawns(&root);
    assert!(spawns > 0);
    assert_eq!(listed(&root), first);
    assert_eq!(git_spawns(&root), spawns, "an unchanged workspace ran git again");

    std::fs::write(root.join("new.txt"), "n").unwrap();
    assert!(eventually(|| listed(&root).contains(&"new.txt".to_string())), "a new file never showed up");
    std::fs::remove_file(root.join("a.txt")).unwrap();
    assert!(eventually(|| !listed(&root).contains(&"a.txt".to_string())), "a deleted file stayed listed");

    git_ok(&root, &["checkout", "-q", "-b", "side"]);
    commit(&root, "side.txt");
    git_ok(&root, &["checkout", "-q", "main"]);
    assert!(eventually(|| !listed(&root).contains(&"side.txt".to_string())), "a checkout that removed side.txt was not seen");
}

#[test]
fn untracking_an_ignored_file_is_seen_without_a_watcher_event() {
    let d = repo_on_main();
    std::fs::write(d.path().join(".gitignore"), "*.log\n").unwrap();
    std::fs::write(d.path().join("keep.log"), "k").unwrap();
    git_ok(d.path(), &["add", ".gitignore"]);
    git_ok(d.path(), &["add", "-f", "keep.log"]);
    git_ok(d.path(), &["commit", "-qm", "logs"]);
    let root = watched(d.path());
    assert!(eventually(|| {
        listed(&root);
        listed(&root) == [".gitignore", "a.txt", "keep.log"] && ignored_of(&root).is_empty()
    }));
    // Only `.git/index` changes, which the watcher skips.
    git_ok(&root, &["rm", "-q", "--cached", "keep.log"]);
    assert_eq!(ignored_of(&root), ["keep.log"]);
}

#[test]
fn an_unwatched_workspace_is_listed_afresh_every_time() {
    let d = repo_on_main();
    let root = dunce::canonicalize(d.path()).unwrap();
    listed(&root);
    let spawns = git_spawns(&root);
    listed(&root);
    assert!(git_spawns(&root) > spawns);
    std::fs::write(root.join("new.txt"), "n").unwrap();
    assert!(listed(&root).contains(&"new.txt".to_string()));
}

/// Make the next listing of `root` miss the cache, as a watcher event would.
fn force_miss(root: &Path) {
    listings().lock().unwrap().get_mut(root).expect("a cached listing").generation = u64::MAX;
}

fn cached_index(root: &Path) -> Option<PathBuf> {
    listings().lock().unwrap().get(root).expect("a cached listing").index.as_ref().map(|(p, _)| p.clone())
}

/// Git processes one listing of `root` starts.
fn spawns_of_one_listing(root: &Path) -> usize {
    let before = git_spawns(root);
    listed(root);
    git_spawns(root) - before
}

#[test]
fn a_cache_miss_reuses_the_known_index_path() {
    let d = repo_on_main();
    let root = watched(d.path());
    let first = spawns_of_one_listing(&root);
    force_miss(&root);
    // `git ls-files` for the listing, but no `git rev-parse` for the index again.
    let again = spawns_of_one_listing(&root);
    assert_eq!(again, 2, "a miss on a known root ran {again} git processes (first listing: {first})");
    assert_eq!(first, again + 1);
    // Still checked: `git rm --cached` is seen without a watcher event.
    assert!(cached_index(&root).is_some());
}

#[test]
fn a_miss_notices_git_init_and_a_removed_git_dir() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("a.txt"), "a").unwrap();
    let root = watched(d.path());
    listed(&root);
    assert_eq!(cached_index(&root), None);
    git_ok(&root, &["init", "-q"]);
    force_miss(&root);
    listed(&root);
    assert!(cached_index(&root).is_some_and(|p| p.ends_with(".git/index")), "git init was not noticed");
    std::fs::remove_dir_all(root.join(".git")).unwrap();
    force_miss(&root);
    listed(&root);
    assert_eq!(cached_index(&root), None, "a removed .git kept its index path");
}

#[test]
fn a_miss_notices_git_init_in_a_subdirectory_workspace() {
    let d = repo_on_main();
    std::fs::create_dir_all(d.path().join("app")).unwrap();
    std::fs::write(d.path().join("app/m.rs"), "m").unwrap();
    let root = watched(&d.path().join("app"));
    listed(&root);
    assert!(cached_index(&root).is_some_and(|p| !p.starts_with(root.join(".git"))));
    git_ok(&root, &["init", "-q"]);
    force_miss(&root);
    listed(&root);
    assert!(cached_index(&root).is_some_and(|p| p.starts_with(root.join(".git"))), "the workspace's own repo was not noticed");
}

#[test]
fn list_files_handles_conflicts_and_nested_repos() {
    let d = repo_on_main();
    let root = d.path();
    git_ok(root, &["checkout", "-q", "-b", "side"]);
    std::fs::write(root.join("a.txt"), "side\n").unwrap();
    git_ok(root, &["commit", "-qam", "side"]);
    git_ok(root, &["checkout", "-q", "main"]);
    std::fs::write(root.join("a.txt"), "main\n").unwrap();
    git_ok(root, &["commit", "-qam", "main"]);
    // The merge conflicts, so it fails: run it without git_ok's assert. It
    // still needs an identity, or git stops before writing the conflict on
    // a machine without a global user (CI).
    let _ = std::process::Command::new("git").arg("-C").arg(root).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "merge", "-q", "side"]).output();
    assert!(git_stdout(root, &["ls-files", "-u"]).is_some_and(|u| u.lines().count() == 3), "no conflict to list");
    let nested = root.join("vendor/lib");
    std::fs::create_dir_all(&nested).unwrap();
    git_ok(&nested, &["init", "-q"]);
    std::fs::write(nested.join("n.rs"), "n").unwrap();
    std::fs::write(root.join("u.txt"), "u").unwrap();
    // One row per conflicted path; a nested repo is listed through its own git.
    assert_eq!(listed(root), ["a.txt", "u.txt", "vendor/lib/n.rs"]);
}
