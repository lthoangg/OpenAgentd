//! A session's tools run in the workspace on its row, whatever other
//! requests ask for. A stale UI request once paired a session id with
//! another workspace: the manager started a second AgentSession bound to
//! that id in the wrong workspace, and a later question or plan answer
//! resumed that copy, so `shell` and `glob` ran in the other repo. The
//! manager is process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager::{self, ManagerError};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
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
    std::env::set_var("OPENAGENTD_SHELL_SNAPSHOT", "false");
    std::fs::create_dir_all(root.join("home")).unwrap();
    // Title generation would take scripted turns off the mock provider.
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools: [shell, glob]\n---\nYou are the coding agent.\n").unwrap();
}

async fn tool_result(pool: &appv3_db::DbPool, sid: &str, call: &str) -> String {
    let rows = appv3_db::llm_window_rows(pool, sid, true).await.unwrap();
    rows.iter().find(|r| r.tool_call_id.as_deref() == Some(call)).and_then(|r| r.content.clone()).unwrap_or_else(|| panic!("no result for {call}"))
}

/// Every live AgentSession serving `sid` is in `ws`.
fn assert_only_in(sid: &str, ws: &str) {
    let serving: Vec<String> = manager::all_sessions().iter().filter(|s| s.session_id() == sid).map(|s| s.workspace()).collect();
    assert!(!serving.is_empty(), "a live session serves {sid}");
    assert!(serving.iter().all(|w| w == ws), "sessions serving {sid} are in {serving:?}, expected only {ws}");
    assert_eq!(manager::find_live_session_serving_session(sid).expect("live").workspace(), ws);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tools_stay_in_the_session_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let mock = Arc::new(MockProvider::new(vec![
        // 1. a Code-mode continue.
        MockProvider::tool_calls(&[("c1", "shell", r#"{"command": "pwd -P"}"#), ("g1", "glob", r#"{"pattern": "marker-*.txt", "directory": "."}"#)]),
        MockProvider::text("done"),
        // 2. after a Plan → Code switch (what plan approval does).
        MockProvider::tool_calls(&[("c2", "shell", r#"{"command": "pwd -P"}"#), ("g2", "glob", r#"{"pattern": "marker-*.txt", "directory": "."}"#)]),
        MockProvider::text("done"),
    ]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);

    let (a, b) = (root.join("a"), root.join("b"));
    for (d, marker) in [(&a, "marker-a.txt"), (&b, "marker-b.txt")] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join(marker), "x").unwrap();
    }
    let ws_a = manager::validate_workspace(&a.display().to_string(), true).unwrap();
    let ws_b = manager::validate_workspace(&b.display().to_string(), true).unwrap();

    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws_a.clone(), interaction_mode: Some("plan".into()), ..Default::default() }).await.unwrap();
    manager::get_or_start_agent_session(&ws_a, Some(&sid)).await.unwrap().expect("agent configured");

    // The UI asks about this session while showing workspace b.
    let stale = manager::get_or_start_agent_session(&ws_b, Some(&sid)).await;
    assert!(matches!(stale, Err(ManagerError::WorkspaceMismatch(_))), "a session in a must not start in b: {:?}", stale.as_ref().map(|s| s.as_ref().map(|s| s.workspace())));
    // Sessions not yet saved, and other ids in b, still start.
    manager::get_or_start_agent_session(&ws_b, Some(&uuid::Uuid::now_v7().to_string())).await.unwrap().expect("new session in b");
    assert_only_in(&sid, &ws_a);

    let run = || {
        let sid = sid.clone();
        async move {
            let s = manager::find_live_session_serving_session(&sid).expect("live");
            s.handle_continue(&sid, None, None, None).await.unwrap();
            tokio::time::timeout(Duration::from_secs(20), s.wait_turn_finished()).await.expect("turn finishes");
        }
    };

    // ── 1. continue in Code mode ────────────────────────────────────────
    appv3_db::update_session(&pool, &sid, appv3_db::SessionUpdate { interaction_mode: Some("code".into()), ..Default::default() }).await.unwrap();
    run().await;
    let pwd = tool_result(&pool, &sid, "c1").await;
    assert!(pwd.contains(&ws_a), "shell ran outside a: {pwd}");
    let glob = tool_result(&pool, &sid, "g1").await;
    assert!(glob.contains("marker-a.txt") && !glob.contains("marker-b.txt"), "glob searched outside a: {glob}");

    // ── 2. Plan → Code, then resume ─────────────────────────────────────
    appv3_db::update_session(&pool, &sid, appv3_db::SessionUpdate { interaction_mode: Some("plan".into()), ..Default::default() }).await.unwrap();
    assert!(manager::get_or_start_agent_session(&ws_b, Some(&sid)).await.is_err());
    appv3_db::update_session(&pool, &sid, appv3_db::SessionUpdate { interaction_mode: Some("code".into()), ..Default::default() }).await.unwrap();
    run().await;
    assert_only_in(&sid, &ws_a);
    let pwd = tool_result(&pool, &sid, "c2").await;
    assert!(pwd.contains(&ws_a), "shell ran outside a after the mode switch: {pwd}");
    let glob = tool_result(&pool, &sid, "g2").await;
    assert!(glob.contains("marker-a.txt") && !glob.contains("marker-b.txt"), "glob searched outside a after the mode switch: {glob}");
}
