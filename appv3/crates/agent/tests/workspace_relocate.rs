//! Relocating a workspace whose folder is gone, on a real git repo: the
//! repository is renamed on disk, and "Locate folder…" points the sidebar
//! row at the new folder. Sessions, scheduled tasks, groups and worktrees
//! follow it; git keeps working in the worktrees, and OpenAgentd's own
//! worktree moves into the new repository's worktree folder.

use appv3_agent::worktrees::{self as wt, RelocateError};
use std::path::Path;

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
    std::env::remove_var("CHAT_WORKSPACE_DIR");
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(root.join("config")).unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    std::fs::create_dir_all(dir.join("web")).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false")] {
        git(dir, &["config", k, v]);
    }
    std::fs::write(dir.join("web/index.html"), "hi\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "init"]);
}

async fn new_session(pool: &appv3_db::DbPool, ws: &str) {
    appv3_db::create_session(pool, appv3_db::NewSession { id: Some(uuid::Uuid::now_v7()), workspace: ws.into(), ..Default::default() }).await.unwrap();
}

async fn session_workspaces(pool: &appv3_db::DbPool) -> Vec<String> {
    sqlx::query_scalar("SELECT workspace FROM chat_sessions ORDER BY workspace").fetch_all(pool).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renamed_repository_keeps_everything_after_locate_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();

    let old = root.join("agentd");
    init_repo(&old);
    let old_ws = appv3_agent::manager::validate_workspace(&old.display().to_string(), true).unwrap();
    wt::register_workspace(&pool, &old_ws).await.unwrap();
    // A worktree OpenAgentd made, and one made by hand beside the repo.
    let managed = wt::create_worktree(&pool, &old_ws, Some("fix-login"), None, false).await.unwrap();
    let by_hand = root.join("agentd-spike");
    git(&old, &["worktree", "add", "-q", "-b", "spike", by_hand.to_str().unwrap()]);
    let by_hand_ws = appv3_agent::manager::validate_workspace(&by_hand.display().to_string(), true).unwrap();
    wt::register_workspace(&pool, &by_hand_ws).await.unwrap();
    new_session(&pool, &old_ws).await;
    new_session(&pool, &format!("{old_ws}/web")).await;
    new_session(&pool, &managed.directory).await;
    let group = appv3_db::create_workspace_group(&pool, "backend", None, None).await.unwrap();
    appv3_db::set_workspace_groups(&pool, &old_ws, std::slice::from_ref(&group.id)).await.unwrap();

    // While the folder is there, it cannot be relocated.
    let target = root.join("openagentd");
    std::fs::create_dir_all(&target).unwrap();
    let err = wt::relocate_repository(&pool, &old_ws, &target.display().to_string(), true).await.unwrap_err();
    assert!(matches!(err, RelocateError::Invalid(ref d) if d.contains("still exists")), "{err:?}");
    std::fs::remove_dir(&target).unwrap();

    // The repo is renamed on disk: git in the worktrees breaks.
    std::fs::rename(&old, &target).unwrap();
    let new_ws = appv3_agent::manager::validate_workspace(&target.display().to_string(), true).unwrap();
    assert!(!std::process::Command::new("git").arg("-C").arg(&by_hand).arg("status").output().unwrap().status.success());

    let preview = wt::relocate_repository(&pool, &old_ws, &new_ws, true).await.unwrap();
    assert_eq!((preview.summary.sessions, preview.summary.merge), (3, false), "worktree sessions count too");
    assert_eq!(preview.summary.worktrees.len(), 2);
    assert_eq!(preview.summary.groups, vec!["backend".to_string()]);
    assert_eq!(session_workspaces(&pool).await.iter().filter(|w| w.starts_with(&old_ws)).count(), 2, "a dry run moves nothing");

    let report = wt::relocate_repository(&pool, &old_ws, &new_ws, false).await.unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    // git works again in both worktrees.
    git(&by_hand, &["status", "--short"]);
    let moved_to = wt::worktree_root(Path::new(&new_ws), false).join("fix-login");
    let moved_ws = moved_to.display().to_string();
    assert_eq!(report.moved, vec![(managed.directory.clone(), moved_ws.clone())]);
    assert!(!Path::new(&managed.directory).exists());
    git(&moved_to, &["status", "--short"]);
    assert!(wt::is_managed_for(&moved_to, Path::new(&new_ws)), "the moved worktree is still OpenAgentd's");

    // Sessions, rows and groups follow; the row takes the new name.
    let mut want = vec![new_ws.clone(), format!("{new_ws}/web"), moved_ws.clone()];
    want.sort();
    assert_eq!(session_workspaces(&pool).await, want);
    let repo = appv3_db::get_workspace_by_path(&pool, &new_ws).await.unwrap().unwrap();
    assert_eq!((repo.kind.as_str(), repo.name.as_deref()), ("repo", Some("openagentd")));
    assert!(appv3_db::get_workspace_by_path(&pool, &old_ws).await.unwrap().is_none());
    for wt_path in [&moved_ws, &by_hand_ws] {
        let row = appv3_db::get_workspace_by_path(&pool, wt_path).await.unwrap().unwrap();
        assert_eq!(row.source_path.as_deref(), Some(new_ws.as_str()), "{wt_path}");
    }
    let members = appv3_db::list_group_memberships(&pool).await.unwrap();
    assert_eq!(members.into_iter().map(|(_, p)| p).collect::<Vec<_>>(), vec![new_ws.clone()]);
    // And git agrees the moved repository is the one the worktree belongs to.
    assert_eq!(wt::placement(&by_hand).await, wt::Placement::Worktree { source: new_ws.clone(), managed: false });
}
