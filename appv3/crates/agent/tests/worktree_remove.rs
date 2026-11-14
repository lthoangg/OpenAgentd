//! Removing a managed worktree never loses commits: its branch goes only
//! when another branch already holds every commit on it.

use appv3_agent::manager;
use appv3_agent::worktrees::{self as wt};
use std::path::{Path, PathBuf};

fn setup_roots(root: &Path) {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ("OPENAGENTD_WORKTREES_DIR", "worktrees"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("USERPROFILE", root.join("home"));
    std::fs::create_dir_all(root.join("home")).unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn has_branch(repo: &Path, branch: &str) -> bool {
    std::process::Command::new("git").arg("-C").arg(repo).args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).status().unwrap().success()
}

fn commit(dir: &Path, file: &str) {
    std::fs::write(dir.join(file), "x\n").unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-qm", file]);
}

/// A managed worktree of `repo` on `branch` (OpenAgentd's own name when `None`).
async fn worktree(pool: &appv3_db::DbPool, repo: &str, name: &str, branch: Option<&str>) -> PathBuf {
    let info = wt::create_worktree(pool, repo, Some(name), branch, false).await.unwrap();
    PathBuf::from(info.directory)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removing_a_worktree_keeps_commits_that_are_nowhere_else() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let app = root.join("app");
    std::fs::create_dir_all(&app).unwrap();
    git(&app, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false")] {
        git(&app, &["config", k, v]);
    }
    commit(&app, "init.txt");
    let repo = manager::validate_workspace(&app.display().to_string(), true).unwrap();
    let source = Path::new(&repo);

    // Two commits that are on no other branch: the branch stays.
    let dir = worktree(&pool, &repo, "feat", None).await;
    commit(&dir, "a.txt");
    commit(&dir, "b.txt");
    let preview = wt::remove_worktree(source, &dir, true).await.unwrap();
    assert_eq!((preview.branch.as_deref(), preview.unmerged_commits, preview.branch_deleted), (Some("openagentd/feat"), 2, false));
    assert!(dir.is_dir(), "a dry run removes nothing");
    let removed = wt::remove_worktree(source, &dir, false).await.unwrap();
    assert_eq!((removed.branch.as_deref(), removed.unmerged_commits, removed.branch_deleted), (Some("openagentd/feat"), 2, false));
    assert!(!dir.exists(), "the worktree folder is gone");
    assert!(has_branch(&app, "openagentd/feat"), "the branch with unmerged commits was deleted");
    assert_eq!(git(&app, &["rev-list", "--count", "main..openagentd/feat"]), "2", "its commits are still reachable");

    // Merged into main: nothing is lost, so the branch goes as before.
    let dir = worktree(&pool, &repo, "merged", None).await;
    commit(&dir, "c.txt");
    git(&app, &["merge", "-q", "--ff-only", "openagentd/merged"]);
    let preview = wt::remove_worktree(source, &dir, true).await.unwrap();
    assert_eq!((preview.unmerged_commits, preview.branch_deleted), (0, true));
    assert!(has_branch(&app, "openagentd/merged"), "a dry run deletes nothing");
    let removed = wt::remove_worktree(source, &dir, false).await.unwrap();
    assert_eq!((removed.unmerged_commits, removed.branch_deleted), (0, true));
    assert!(!has_branch(&app, "openagentd/merged"));

    // Never committed to: the branch goes as before.
    let dir = worktree(&pool, &repo, "empty", None).await;
    let removed = wt::remove_worktree(source, &dir, false).await.unwrap();
    assert_eq!((removed.unmerged_commits, removed.branch_deleted), (0, true));
    assert!(!has_branch(&app, "openagentd/empty"));

    // A branch the user named is never deleted, as before.
    let dir = worktree(&pool, &repo, "named", Some("feature/named")).await;
    commit(&dir, "d.txt");
    let removed = wt::remove_worktree(source, &dir, false).await.unwrap();
    assert_eq!((removed.branch.as_deref(), removed.branch_deleted), (Some("feature/named"), false));
    assert!(has_branch(&app, "feature/named"));
}
