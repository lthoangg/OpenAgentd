use super::*;
use std::time::Duration;

pub(super) fn git_ok(dir: &Path, args: &[&str]) {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

/// A repo whose index is stale for `a.txt`: same content, newer mtime.
pub(super) fn repo_on_main() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git_ok(d.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
    git_ok(d.path(), &["add", "a.txt"]);
    git_ok(d.path(), &["commit", "-qm", "init"]);
    d
}

pub(super) fn commit(dir: &Path, file: &str) {
    std::fs::write(dir.join(file), file).unwrap();
    git_ok(dir, &["add", file]);
    git_ok(dir, &["commit", "-qm", file]);
}

pub(super) fn ws_query(dir: &Path, extra: &str) -> Qs {
    Qs::parse(&format!("workspace={}{extra}", form_urlencoded::byte_serialize(dir.to_str().unwrap().as_bytes()).collect::<String>()))
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
