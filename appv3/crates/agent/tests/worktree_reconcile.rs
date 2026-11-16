//! The sidebar's worktree list follows the disk and git: rows whose folder
//! is gone drop off (their sessions stay findable), checkouts git lists
//! without a row show up, and an unreachable repository is left alone.

use appv3_agent::manager;
use appv3_agent::worktrees::{self as wt, UnlistedWorktree, UnusedWorktree};
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
    std::fs::create_dir_all(root.join("home")).unwrap();
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
    std::fs::write(dir.join("web/a.txt"), "a\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "init"]);
}

fn canon(p: &Path) -> String {
    appv3_db::resolve_path(&p.display().to_string())
}

async fn listed(pool: &appv3_db::DbPool) -> Vec<String> {
    let mut v: Vec<String> = appv3_db::list_visible_coding_workspaces(pool).await.unwrap().into_iter().filter(|r| r.kind != "repo").map(|r| r.path).collect();
    v.sort();
    v
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_list_follows_the_disk_and_git() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let app = root.join("app");
    init_repo(&app);
    let repo = manager::validate_workspace(&app.display().to_string(), true).unwrap();
    wt::register_workspace(&pool, &repo).await.unwrap();

    // Two OpenAgentd worktrees, one made with plain git, and a subfolder.
    let kept = wt::create_worktree(&pool, &repo, Some("kept"), None, false).await.unwrap().directory;
    let merged = wt::create_worktree(&pool, &repo, Some("merged"), None, false).await.unwrap().directory;
    let fix = root.join("app-fix");
    git(&app, &["worktree", "add", "-q", "-b", "fix", fix.to_str().unwrap()]);
    wt::register_workspace(&pool, &canon(&fix)).await.unwrap();
    let web = canon(&app.join("web"));
    wt::register_workspace(&pool, &web).await.unwrap();
    let sid = uuid::Uuid::now_v7();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(sid), workspace: merged.clone(), ..Default::default() }).await.unwrap();
    assert_eq!(wt::reconcile_repo(&pool, &repo).await.unwrap(), vec![], "everything git lists has a row");
    let mut all = vec![kept.clone(), merged.clone(), canon(&fix), web.clone()];
    all.sort();
    assert_eq!(listed(&pool).await, all);

    // Removed outside the app: with git, and by deleting the folder.
    git(&app, &["worktree", "remove", "--force", &merged]);
    std::fs::remove_dir_all(&fix).unwrap();
    wt::reconcile_repo(&pool, &repo).await.unwrap();
    let mut left = vec![kept.clone(), web.clone()];
    left.sort();
    assert_eq!(listed(&pool).await, left, "gone checkouts drop off; the rest stay");
    // The removed worktree's session stays with the repository.
    let former: Vec<_> = appv3_db::list_former_checkouts(&pool).await.unwrap().into_iter().map(|r| (r.path, r.source_path)).collect();
    assert_eq!(former, vec![(merged.clone(), Some(repo.clone()))], "only gone checkouts that hold sessions");

    // Made with plain git and never opened: listed, not recorded.
    let side = root.join("app-side");
    git(&app, &["worktree", "add", "-q", "-b", "side", side.to_str().unwrap()]);
    let own = wt::worktree_root(Path::new(&repo), true).join("by-hand");
    git(&app, &["worktree", "add", "-q", "-b", "oad/by-hand", own.to_str().unwrap()]);
    wt::forget_listing(Path::new(&repo));
    let mut found = wt::reconcile_repo(&pool, &repo).await.unwrap();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    let mut want = vec![
        UnlistedWorktree { path: canon(&side), branch: Some("side".into()), managed: false },
        UnlistedWorktree { path: canon(&own), branch: Some("oad/by-hand".into()), managed: true },
    ];
    want.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(found, want);
    assert_eq!(listed(&pool).await, left, "listing one does not record it");

    // Hiding one files it under its repository first, and keeps it hidden.
    wt::ensure_registered(&pool, &canon(&side)).await.unwrap();
    appv3_db::hide_coding_workspace(&pool, &canon(&side)).await.unwrap();
    let row = appv3_db::get_workspace_by_path(&pool, &canon(&side)).await.unwrap().unwrap();
    assert_eq!((row.kind.as_str(), row.source_path.as_deref(), row.hidden), ("worktree", Some(repo.as_str()), true));
    let found: Vec<String> = wt::reconcile_repo(&pool, &repo).await.unwrap().into_iter().map(|w| w.path).collect();
    assert_eq!(found, vec![canon(&own)], "a hidden checkout stays hidden");

    // Renaming one files it too, instead of a row with no repository.
    wt::ensure_registered(&pool, &canon(&own)).await.unwrap();
    let row = appv3_db::rename_coding_workspace(&pool, &canon(&own), "By hand").await.unwrap();
    assert_eq!((row.kind.as_str(), row.source_path.as_deref(), row.managed, row.name.as_deref()), ("worktree", Some(repo.as_str()), true, Some("By hand")));

    // The repository's own folder is unreachable (an unplugged drive): its
    // worktrees look gone too, but nothing is dropped.
    let parked = root.join("parked");
    std::fs::rename(&app, &parked).unwrap();
    std::fs::remove_dir_all(&kept).unwrap();
    assert_eq!(wt::reconcile_repo(&pool, &repo).await.unwrap(), vec![]);
    let mut still = vec![kept.clone(), web.clone(), canon(&own)];
    still.sort();
    assert_eq!(listed(&pool).await, still, "an unreachable repository keeps its rows");
    std::fs::rename(&parked, &app).unwrap();
    wt::reconcile_repo(&pool, &repo).await.unwrap();
    let mut back = vec![web.clone(), canon(&own)];
    back.sort();
    assert_eq!(listed(&pool).await, back, "once it is back, the gone worktree drops off");

    // ── a worktree whose last session is deleted ────────────────────────
    let session_in = |ws: String| {
        let pool = pool.clone();
        async move {
            let id = uuid::Uuid::now_v7();
            appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws, ..Default::default() }).await.unwrap();
            id.to_string()
        }
    };
    let clean = wt::create_worktree(&pool, &repo, Some("clean"), None, false).await.unwrap().directory;
    let dirty = wt::create_worktree(&pool, &repo, Some("dirty"), None, false).await.unwrap().directory;
    let ahead = wt::create_worktree(&pool, &repo, Some("ahead"), None, false).await.unwrap().directory;
    let (s_clean, s_dirty, s_ahead) = (session_in(clean.clone()).await, session_in(dirty.clone()).await, session_in(ahead.clone()).await);
    let other_clean = session_in(clean.clone()).await;
    std::fs::write(Path::new(&dirty).join("notes.txt"), "wip\n").unwrap();
    std::fs::write(Path::new(&ahead).join("b.txt"), "b\n").unwrap();
    git(Path::new(&ahead), &["add", "b.txt"]);
    git(Path::new(&ahead), &["commit", "-qm", "b"]);

    appv3_db::delete_session_rows(&pool, &s_clean).await.unwrap();
    assert_eq!(wt::remove_if_unused(&pool, &clean).await.unwrap(), UnusedWorktree::InUse, "another session still runs there");
    for (sid, dir) in [(&s_dirty, &dirty), (&s_ahead, &ahead)] {
        appv3_db::delete_session_rows(&pool, sid).await.unwrap();
        assert!(matches!(wt::remove_if_unused(&pool, dir).await.unwrap(), UnusedWorktree::Kept { .. }), "{dir} keeps work");
        assert!(Path::new(dir).is_dir());
    }
    let UnusedWorktree::Kept { reason, .. } = wt::remove_if_unused(&pool, &dirty).await.unwrap() else { unreachable!() };
    assert_eq!(reason, "it has uncommitted changes");
    let UnusedWorktree::Kept { reason, .. } = wt::remove_if_unused(&pool, &ahead).await.unwrap() else { unreachable!() };
    assert_eq!(reason, "its branch has 1 commit on no other branch");

    appv3_db::delete_session_rows(&pool, &other_clean).await.unwrap();
    assert_eq!(wt::remove_if_unused(&pool, &clean).await.unwrap(), UnusedWorktree::Removed { name: "clean".into() });
    assert!(!Path::new(&clean).exists(), "the folder goes");
    assert!(!git(&app, &["branch", "--list", "openagentd/clean"]).contains("clean"), "its merged branch goes too");
    assert!(appv3_db::get_workspace_by_path(&pool, &clean).await.unwrap().unwrap().deleted_at.is_some());
    // Not OpenAgentd's: never removed.
    assert_eq!(wt::remove_if_unused(&pool, &canon(&side)).await.unwrap(), UnusedWorktree::InUse);
    assert!(side.is_dir());
}
