//! The manager evicts a live AgentSession only after it has been idle for
//! [`manager::SESSION_IDLE_SECONDS`]. Idle time once counted from the last
//! request that looked the session up, not from the end of its last turn:
//! a turn that ran longer than the cutoff was evicted on the first lookup
//! after it ended. Eviction stops the session, which cancelled its pending
//! idle-compaction timer, so a large context sat uncompacted until the next
//! message. The manager is process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::session::UserMessage;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools: []\n---\nYou are the coding agent.\n").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_time_counts_from_the_end_of_the_last_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![MockProvider::text("done")]));
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);

    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.clone(), ..Default::default() }).await.unwrap();

    let session = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    let looked_up = Instant::now();
    session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), session.wait_turn_finished()).await.expect("turn finishes");
    assert_eq!(session.state(), "idle");
    let cutoff = Duration::from_secs(manager::SESSION_IDLE_SECONDS);

    // The cutoff has passed since the lookup, but not since the turn ended
    // (in production: a 45-minute turn, then any request).
    manager::evict_idle_sessions(Some(looked_up + cutoff)).await;
    let live = manager::find_live_session(&ws, Some(&sid)).expect("a session that just finished a turn was evicted as idle");
    assert!(Arc::ptr_eq(&live, &session), "the session was replaced");
    assert_ne!(session.state(), "offline");

    // Idle for the full cutoff after the turn: evicted.
    let finished = Instant::now();
    manager::evict_idle_sessions(Some(finished + cutoff)).await;
    assert!(manager::find_live_session(&ws, Some(&sid)).is_none(), "an idle session was kept");
    assert_eq!(session.state(), "offline");
}
