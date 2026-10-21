//! Idle compaction after a restart. The countdown lives in memory, so a
//! restart during it used to drop it. On startup, a lead session whose turn
//! completed within the prompt-cache TTL resumes the countdown where it
//! stopped; older sessions are left alone, since compacting them would pay
//! full price for sessions the user may never reopen. The manager is
//! process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_db::NewMessage;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use serde_json::{json, Map, Value};
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
    std::fs::create_dir_all(root.join("config")).unwrap();
    // 10 reported prompt tokens >= 70% of a 12-token trigger.
    std::fs::write(root.join("config").join("settings.yaml"), "title_generation:\n  enabled: false\nsummarization:\n  prompt_token_threshold: 12\n  idle_compaction: true\n")
        .unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools: []\n---\nYou are the coding agent.\n").unwrap();
}

fn ago(secs: i64) -> String {
    appv3_db::codec::dt_db(&(chrono::Utc::now() - chrono::Duration::seconds(secs)))
}

enum Ending {
    Completed,
    Interrupted,
    /// The process died mid-tool: the last row is a tool result.
    MidTool,
}

/// A session saved by an earlier server process: a user message, then the
/// end of a turn `secs_ago` seconds ago.
async fn past_session(pool: &appv3_db::DbPool, ws: &str, parent: Option<String>, secs_ago: i64, ending: Ending) -> String {
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(pool, appv3_db::NewSession { id: Some(id), workspace: ws.into(), parent_session_id: parent, ..Default::default() }).await.unwrap();
    let mut q = NewMessage::user("hi");
    q.created_at = Some(ago(secs_ago + 5));
    appv3_db::save_message(pool, &sid, q).await.unwrap();
    let mut extra = Map::new();
    extra.insert("usage".into(), json!({"input": 10, "output": 2}));
    if matches!(ending, Ending::Interrupted) {
        extra.insert("interrupted".into(), Value::Bool(true));
    }
    let mut a = NewMessage::assistant(Some("done".into()));
    a.extra = Some(extra);
    a.created_at = Some(ago(secs_ago));
    if matches!(ending, Ending::MidTool) {
        a.content = None;
        a.tool_calls = Some(json!([{"id": "c1", "type": "function", "function": {"name": "shell", "arguments": "{}"}}]));
    }
    appv3_db::save_message(pool, &sid, a).await.unwrap();
    if matches!(ending, Ending::MidTool) {
        let mut t = NewMessage::tool("c1", "shell", "partial");
        t.created_at = Some(ago(secs_ago));
        appv3_db::save_message(pool, &sid, t).await.unwrap();
    }
    sid
}

async fn summaries(pool: &appv3_db::DbPool, sid: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM session_messages WHERE session_id = ? AND kind = 'summary'").bind(appv3_db::codec::db_id(sid)).fetch_one(pool).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_resumes_the_countdown_only_for_turns_inside_the_cache_ttl() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![]));
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();

    // Past the 4.5-minute delay but inside the 5-minute TTL: compacts now.
    let due = past_session(&pool, &ws, None, 280, Ending::Completed).await;
    // Not resumed: the cache has expired…
    let stale = past_session(&pool, &ws, None, 400, Ending::Completed).await;
    // …the user stopped the turn…
    let stopped = past_session(&pool, &ws, None, 280, Ending::Interrupted).await;
    // …the turn never finished…
    let crashed = past_session(&pool, &ws, None, 280, Ending::MidTool).await;
    // …or it is not a lead session.
    let child = past_session(&pool, &ws, Some(stale.clone()), 280, Ending::Completed).await;

    let resumed = appv3_agent::idle_compaction::resume_after_restart(&pool).await;
    assert_eq!(resumed, 1, "only the lead session with a completed turn inside the TTL resumes");

    tokio::time::timeout(Duration::from_secs(10), async {
        while summaries(&pool, &due).await == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the resumed countdown compacted the session");
    manager::find_live_session(&ws, Some(&due)).expect("live").wait_turn_finished().await;
    for (name, sid) in [("stale", &stale), ("stopped", &stopped), ("crashed", &crashed), ("child", &child)] {
        assert_eq!(summaries(&pool, sid).await, 0, "{name} session was compacted");
        assert!(manager::find_live_session(&ws, Some(sid)).is_none(), "{name} session was loaded");
    }
}
