//! Which sessions a scheduled task marks as scheduled, and which tools a
//! marked session gets. Only a session the scheduler owns (`session_id:
//! "auto"`) is marked, before its first run, and it keeps `preview` and
//! `delegate` while losing the tools that wait on a person. A task that runs
//! in the user's own session leaves it unmarked with every tool. The manager
//! and scheduler are process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::scheduler::{self, TaskCreate};
use appv3_agent::session::UserMessage;
use appv3_agent::{manager, store};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use std::collections::BTreeSet;
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
    std::fs::write(root.join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools: []\n---\nYou are the coding agent.\n").unwrap();
}

/// Tool names of the last model call whose messages contain `marker`.
fn tools_of_call_with(mock: &MockProvider, marker: &str) -> BTreeSet<String> {
    let calls = mock.calls.lock().unwrap();
    let (_, tools, _) = calls
        .iter()
        .rev()
        .find(|(msgs, _, _)| msgs.iter().any(|m| matches!(m, ChatMessage::User { .. }) && format!("{m:?}").contains(marker)))
        .unwrap_or_else(|| panic!("no model call mentions {marker:?}"));
    tools.clone().unwrap_or_default().iter().filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str()).map(String::from)).collect()
}

async fn scheduled_task_name(pool: &appv3_db::DbPool, sid: &str) -> Option<String> {
    appv3_db::get_session(pool, sid).await.unwrap().expect("session row").scheduled_task_name
}

/// Fire `slug` now and wait for the run's turn to end.
async fn fire_and_wait(ws: &str, slug: &str, sid: &str) {
    let s = scheduler::scheduler();
    s.trigger(slug).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while s.get_task(slug).await.unwrap().unwrap().run_count == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the task fired");
    let live = manager::find_live_session(ws, Some(sid)).expect("the fired session is live");
    tokio::time::timeout(Duration::from_secs(10), live.wait_turn_finished()).await.expect("the scheduled turn finishes");
}

fn task(name: &str, ws: &str, session_id: &str) -> TaskCreate {
    TaskCreate {
        name: name.into(),
        slug: Some(name.into()),
        workspace: ws.into(),
        schedule_type: "every".into(),
        every_seconds: Some(3600),
        timezone: "UTC".into(),
        prompt: format!("prompt for {name}"),
        session_id: Some(session_id.into()),
        enabled: false,
        ..Default::default()
    }
}

const WAITS_ON_A_PERSON: [&str; 3] = ["ask_user", "plan", "submit_plan"];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_sessions_the_scheduler_owns_are_marked_and_they_keep_preview_and_delegate() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let mock = Arc::new(MockProvider::new((0..8).map(|_| MockProvider::text("Done.")).collect()));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);
    scheduler::init(pool.clone());
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();

    // A task created with `session_id: "current"` runs in the user's session.
    let user_id = uuid::Uuid::now_v7();
    let user_sid = user_id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(user_id), workspace: ws.clone(), ..Default::default() }).await.unwrap();
    let t = scheduler::scheduler().create(task("check-in-my-session", &ws, &user_sid)).await.unwrap();
    fire_and_wait(&ws, &t.slug, &user_sid).await;
    assert_eq!(scheduled_task_name(&pool, &user_sid).await, None, "the user's own session was marked as scheduled");

    let live = manager::find_live_session(&ws, Some(&user_sid)).unwrap();
    live.handle_user_message(UserMessage { content: "my next message".into(), session_id: user_sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    if let Some(mut sub) = store().attach(&user_sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), live.wait_turn_finished()).await.unwrap();
    let tools = tools_of_call_with(&mock, "my next message");
    for name in WAITS_ON_A_PERSON.iter().chain(&["preview", "delegate"]) {
        assert!(tools.contains(*name), "the user's session lost {name} after a scheduled run: {tools:?}");
    }

    // A task with `session_id: "auto"` owns its session, from the first run.
    let t = scheduler::scheduler().create(task("check-on-its-own", &ws, "auto")).await.unwrap();
    let auto_sid = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, b"scheduler:check-on-its-own").to_string();
    fire_and_wait(&ws, &t.slug, &auto_sid).await;
    assert_eq!(scheduled_task_name(&pool, &auto_sid).await.as_deref(), Some("check-on-its-own"));
    let tools = tools_of_call_with(&mock, "prompt for check-on-its-own");
    for name in ["preview", "delegate"] {
        assert!(tools.contains(name), "the scheduler's own session lacks {name}: {tools:?}");
    }
    for name in WAITS_ON_A_PERSON {
        assert!(!tools.contains(name), "the scheduler's own session offers {name} on its first run: {tools:?}");
    }
}
