//! A lead's follow-up to a member that is still working waits for the
//! member's turn; it must not start a second turn beside it.
//!
//! In production a follow-up started a second turn on a busy member. When the
//! first turn ended, the session read as idle while the second still ran, so
//! Stop, and later deleting the lead, skipped it: it ran on for an hour against
//! a deleted session. The registry is process-wide, so this file is its own
//! test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::UserMessage;
use appv3_agent::{manager, subagents};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, LlmProvider, ProviderError};
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
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools: []\n---\nYou are the coding agent.\n").unwrap();
    std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\ndescription: Runs builds.\nmodel: mock:mock\ntools:\n  - shell\n---\nYou run builds.\n").unwrap();
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A 429 whose reset is an hour away: the retry loop parks in the quota wait.
fn quota_429() -> MockTurn {
    MockTurn::Error(ProviderError::http(
        429,
        "https://api.example.test/v1/messages",
        r#"{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."}}"#.into(),
        vec![("retry-after".into(), "3600".into())],
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_follow_up_to_a_working_member_waits_for_its_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let release = root.join("release");
    let build = format!("while [ ! -f '{}' ]; do sleep 0.05; done; echo built", release.display());
    let args = serde_json::json!({ "command": build }).to_string();
    // Lead turn, the member's blocking build, then whatever model call comes
    // next parks on a quota wait, and a last plain reply.
    let mock =
        Arc::new(MockProvider::new(vec![MockProvider::text("delegated"), MockProvider::tool_call("call_1", "shell", &args), quota_429(), MockProvider::text("build finished")]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    manager::init(pool.clone(), factory.clone());

    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.clone(), ..Default::default() }).await.unwrap();

    let lead = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    lead.handle_user_message(UserMessage { content: "build it".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("lead turn finishes");

    subagents::spawn_subagent(&sid, "worker", "run the build", None, None, None, &ws, &pool, &factory).await.expect("member spawned");
    let member = subagents::with_instance(&sid, "worker#1", |i| i.session.clone()).expect("member registered");
    wait_until("the member's build to start", || mock.calls.lock().unwrap().len() >= 2).await;

    // The lead follows up while the member is still building.
    subagents::send_subagent_message(&sid, "worker#1", "also run the tests", &pool).await.expect("follow-up accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let calls = mock.calls.lock().unwrap().len();
    assert_eq!(calls, 2, "the follow-up started a second model call beside the running turn");

    // The build finishes; the member's own turn makes the next model call,
    // which parks on the quota wait.
    std::fs::write(&release, "").unwrap();
    wait_until("the member's next model call", || mock.calls.lock().unwrap().len() >= 3).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(member.is_busy(), "the member is parked in the quota wait");

    // Stop reaches the only turn there is.
    subagents::stop_all_subagents(&sid).await;
    wait_until("the member's turn to end", || member.active_task_done() && !member.is_busy()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(member.active_task_done(), "a turn kept running after Stop");
    let follow_up_read = mock
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(messages, _, _)| messages.iter().any(|m| matches!(m, ChatMessage::User { content: Some(c), .. } if c.contains("also run the tests"))));
    assert!(!follow_up_read, "a stopped member went on to the queued follow-up");
}
