//! Worktrees and the `workspace` tool, end to end on a real git repo:
//! folders file under their repository by git's own link, a lead opens a
//! worktree per feature with `worktree='<name>'`, follow-ups reuse it, and a
//! worktree session reaches the main checkout with `worktree='main'`.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::tools::workspace::WorkspaceTool;
use appv3_agent::workspace_messages::{self as wm, Delivery, SendRequest};
use appv3_agent::worktrees::{self as wt, Placement};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

fn setup_roots(root: &Path) {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("USERPROFILE", root.join("home"));
    std::env::remove_var("CHAT_WORKSPACE_DIR");
    std::env::remove_var("AGENTS_DIR");
    std::fs::create_dir_all(root.join("home")).unwrap();
    let config = root.join("config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(config.join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\n---\nYou are the coding agent.\n").unwrap();
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

async fn user_rows(pool: &appv3_db::DbPool, sid: &str) -> Vec<(String, Value)> {
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as("SELECT content, extra FROM session_messages WHERE session_id = ? AND role = 'user' ORDER BY seq, id")
        .bind(appv3_db::codec::db_id(sid))
        .fetch_all(pool)
        .await
        .unwrap();
    rows.into_iter().map(|(c, e)| (c.unwrap_or_default(), e.and_then(|e| serde_json::from_str(&e).ok()).unwrap_or(Value::Null))).collect()
}

async fn wait_turn(ws: &str, sid: &str) {
    let s = manager::find_live_session(ws, Some(sid)).expect("live session");
    tokio::time::timeout(Duration::from_secs(20), s.wait_turn_finished()).await.expect("turn finishes");
}

fn ctx(ws: &str, sid: &str) -> ToolContext {
    ToolContext {
        session_id: Some(sid.into()),
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::with(Path::new(ws), None, Some(vec![]), Some(vec![]))),
        workspace: Some(ws.into()),
        output: None,
        metadata: Default::default(),
        messages: None,
    }
}

async fn new_session(pool: &appv3_db::DbPool, ws: &str) -> String {
    let id = uuid::Uuid::now_v7();
    appv3_db::create_session(pool, appv3_db::NewSession { id: Some(id), workspace: ws.into(), ..Default::default() }).await.unwrap();
    id.to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worktrees_file_under_their_repo_and_leads_open_them() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let mock = Arc::new(MockProvider::new(vec![
        MockProvider::text("Auth done."),
        MockProvider::text("Got auth."),
        MockProvider::text("Billing done."),
        MockProvider::text("Got billing."),
        MockProvider::text("Logout added."),
        MockProvider::text("Merged on main."),
    ]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);

    let app = root.join("app");
    init_repo(&app);
    let app_ws = manager::validate_workspace(&app.display().to_string(), true).unwrap();
    wt::register_workspace(&pool, &app_ws).await.unwrap();

    // ── a worktree made outside the app, and a subfolder ────────────────
    let fix = root.join("app-fix");
    git(&app, &["worktree", "add", "-q", "-b", "fix", fix.to_str().unwrap()]);
    let fix_ws = manager::validate_workspace(&fix.display().to_string(), true).unwrap();
    assert_eq!(wt::placement(&fix).await, Placement::Worktree { source: app_ws.clone(), managed: false });
    wt::register_workspace(&pool, &fix_ws).await.unwrap();
    let row = appv3_db::get_workspace_by_path(&pool, &fix_ws).await.unwrap().unwrap();
    assert_eq!((row.kind.as_str(), row.source_path.as_deref(), row.managed), ("worktree", Some(app_ws.as_str()), false));
    let web_ws = manager::validate_workspace(&app.join("web").display().to_string(), true).unwrap();
    wt::register_workspace(&pool, &web_ws).await.unwrap();
    let row = appv3_db::get_workspace_by_path(&pool, &web_ws).await.unwrap().unwrap();
    assert_eq!((row.kind.as_str(), row.source_path.as_deref()), ("folder", Some(app_ws.as_str())));
    // A folder outside any repository stays a repository row.
    let plain = root.join("notes");
    std::fs::create_dir_all(&plain).unwrap();
    assert_eq!(wt::placement(&plain).await, Placement::Repo);

    // The outside worktree reaches its repository with no group.
    let fix_sid = new_session(&pool, &fix_ws).await;
    let listing = wm::list(&pool, &fix_ws, None).await.unwrap();
    assert!(listing.contains("(worktree of app)") && listing.contains("(folder of app)") && listing.contains("worktree='<name>'"), "{listing}");

    // ── the lead opens a worktree per feature ───────────────────────────
    let app_sid = new_session(&pool, &app_ws).await;
    let tool = WorkspaceTool::new(app_sid.clone(), pool.clone());
    let c = ctx(&app_ws, &app_sid);
    let mut sessions = vec![];
    for (feature, reply) in [("auth", "Auth done."), ("billing", "Billing done.")] {
        let out = format!("{:?}", tool.run(&c, json!({"worktree": feature, "message": format!("Build {feature}."), "reply": true})).await.unwrap());
        assert!(out.contains(&format!("Created worktree '{feature}' on branch oad/{feature}")), "{out}");
        let dir = appv3_db::list_visible_coding_workspaces(&pool).await.unwrap().into_iter().find(|r| r.name.as_deref() == Some(feature)).expect("registered");
        assert_eq!((dir.kind.as_str(), dir.source_path.as_deref(), dir.managed), ("worktree", Some(app_ws.as_str()), true));
        assert_eq!(git(Path::new(&dir.path), &["rev-parse", "--abbrev-ref", "HEAD"]), format!("oad/{feature}"));
        let sid = appv3_db::list_sessions_page(&pool, None, 5, &appv3_db::SessionListFilter { workspaces: std::slice::from_ref(&dir.path), ..Default::default() })
            .await
            .unwrap()
            .0
            .remove(0)
            .id;
        let sid = appv3_db::codec::api_uuid(&sid);
        wait_turn(&dir.path, &sid).await;
        wait_turn(&app_ws, &app_sid).await;
        let replies: Vec<_> = user_rows(&pool, &app_sid).await.into_iter().filter(|r| r.1["reply_from"]["session_id"] == sid.as_str()).collect();
        assert_eq!(replies.len(), 1, "{feature} reports back");
        assert_eq!(replies[0].0, reply);
        sessions.push((dir.path, sid));
    }

    // ── a follow-up reuses the feature's worktree ───────────────────────
    let (auth_ws, auth_sid) = sessions[0].clone();
    let sent = wm::send(
        &pool,
        SendRequest {
            source_session_id: app_sid.clone(),
            source_workspace: app_ws.clone(),
            workspace: "app".into(),
            worktree: Some("Auth".into()),
            session_id: Some(auth_sid.clone()),
            message: "Also add logout.".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!((sent.target.path.as_str(), sent.created_worktree.is_none(), sent.delivery), (auth_ws.as_str(), true, Delivery::Delivered));
    wait_turn(&auth_ws, &auth_sid).await;
    let worktrees = git(&app, &["worktree", "list", "--porcelain"]);
    assert_eq!(worktrees.matches("\nworktree ").count() + 1, 4, "main, app-fix, auth and billing only: {worktrees}");

    // ── a worktree session reaches the main checkout ────────────────────
    let wt_tool = WorkspaceTool::new(fix_sid.clone(), pool.clone());
    let out = format!("{:?}", wt_tool.run(&ctx(&fix_ws, &fix_sid), json!({"worktree": "main", "message": "Merge fix."})).await.unwrap());
    assert!(out.contains(&format!("Sent to 'app' ({app_ws})")) && !out.contains("Created worktree"), "{out}");
    let main_sid = appv3_db::list_sessions_page(&pool, None, 5, &appv3_db::SessionListFilter { workspaces: std::slice::from_ref(&app_ws), ..Default::default() })
        .await
        .unwrap()
        .0
        .into_iter()
        .map(|s| appv3_db::codec::api_uuid(&s.id))
        .find(|id| *id != app_sid)
        .expect("a new session on the main checkout");
    wait_turn(&app_ws, &main_sid).await;

    // ── guards ──────────────────────────────────────────────────────────
    let notes_ws = manager::validate_workspace(&plain.display().to_string(), true).unwrap();
    wt::register_workspace(&pool, &notes_ws).await.unwrap();
    let notes_sid = new_session(&pool, &notes_ws).await;
    let notes_tool = WorkspaceTool::new(notes_sid.clone(), pool.clone());
    let out = format!("{:?}", notes_tool.run(&ctx(&notes_ws, &notes_sid), json!({"worktree": "x", "message": "y"})).await.unwrap());
    assert!(out.contains("not a git repository, so it cannot have worktrees"), "{out}");
    let e = wm::send(
        &pool,
        SendRequest {
            source_session_id: app_sid.clone(),
            source_workspace: app_ws.clone(),
            workspace: "app".into(),
            worktree: Some("main".into()),
            message: "x".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(e.contains("is this checkout"), "{e}");
}
