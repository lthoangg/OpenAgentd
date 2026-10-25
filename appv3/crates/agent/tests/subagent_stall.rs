//! A member stuck on its model tells its lead once, and the lead can stop it
//! and later resume it with its context.
//!
//! A member whose provider is out of quota waits for the reset (up to a day)
//! and one whose network is down retries without limit; the lead heard
//! nothing and stayed "waiting on subagents" the whole time. The manager is
//! process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
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
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:lead\ntools: []\n---\nYou are the coding agent.\n").unwrap();
    std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\ndescription: Runs builds.\nmodel: mock:worker\ntools:\n  - shell\n---\nYou run builds.\n").unwrap();
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

fn user_texts(mock: &MockProvider) -> Vec<String> {
    mock.calls
        .lock()
        .unwrap()
        .iter()
        .flat_map(|(messages, _, _)| messages.iter())
        .filter_map(|m| match m {
            ChatMessage::User { content: Some(c), .. } => Some(c.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_member_out_of_quota_alerts_its_lead_and_can_be_stopped_and_resumed() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let lead_mock = Arc::new(MockProvider::new(vec![]));
    let worker_mock = Arc::new(MockProvider::new(vec![quota_429(), MockProvider::text("resumed report")]));
    let (lead_p, worker_p): (Arc<dyn LlmProvider>, Arc<dyn LlmProvider>) = (lead_mock.clone(), worker_mock.clone());
    let factory: ProviderFactory = Arc::new(move |model, _| Ok(if model == Some("mock:worker") { worker_p.clone() } else { lead_p.clone() }));
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    manager::init(pool.clone(), factory.clone());

    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.clone(), ..Default::default() }).await.unwrap();
    let lead = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");

    subagents::spawn_subagent(&sid, "worker", "run the build", None, None, None, &ws, &pool, &factory).await.expect("member spawned");
    let member = subagents::with_instance(&sid, "worker#1", |i| i.session.clone()).expect("member registered");

    // The member parks in the quota wait; the lead hears about it at once.
    let notified = || user_texts(&lead_mock).iter().any(|t| t.contains("worker#1 is stalled"));
    wait_until("the lead to read the stall notice", notified).await;
    let notice = user_texts(&lead_mock).into_iter().find(|t| t.contains("worker#1 is stalled")).unwrap();
    assert!(notice.contains("mock:worker is out of quota, and it is waiting 1h 00m for the reset"), "{notice}");
    assert!(notice.contains("team(action='stop', target='worker#1')"), "{notice}");
    assert!(member.is_busy(), "the member keeps waiting for the reset");
    assert!(subagents::has_working_subagents(&sid), "a stalled member still works for its lead");
    let listed = subagents::describe_subagents(&sid);
    assert!(listed.contains("stalled: mock:worker is out of quota"), "{listed}");
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("the lead's turn on the notice ends");

    // The lead stops it: no report follows, and it no longer holds the lead.
    let stopped = subagents::stop_subagent(&sid, "worker#1").await.expect("stop accepted");
    assert_eq!(stopped["was_running"], serde_json::json!(true));
    wait_until("the member's turn to end", || member.active_task_done() && !member.is_busy()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!subagents::has_working_subagents(&sid));
    assert_eq!(subagents::with_instance(&sid, "worker#1", |i| i.status.clone()).as_deref(), Some("stopped"));
    assert_eq!(subagents::describe_subagents(&sid), "- worker#1: stopped (send it a task to resume)");
    let reports = user_texts(&lead_mock).into_iter().filter(|t| t.contains("worker#1 failed") || t.contains("no text output")).count();
    assert_eq!(reports, 0, "a stopped member reported to its lead");

    // A later task resumes it with its earlier context, and its report arrives.
    subagents::send_subagent_message(&sid, "worker#1", "try again", &pool).await.expect("resumed");
    wait_until("the lead to read the resumed report", || user_texts(&lead_mock).iter().any(|t| t.contains("resumed report"))).await;
    let resumed_call = worker_mock.calls.lock().unwrap().last().unwrap().0.clone();
    let seen: Vec<String> = resumed_call
        .iter()
        .filter_map(|m| match m {
            ChatMessage::User { content: Some(c), .. } => Some(c.clone()),
            _ => None,
        })
        .collect();
    assert!(seen.iter().any(|c| c.contains("[Task from Lead]: run the build")), "the resumed member lost its task: {seen:?}");
    assert!(seen.iter().any(|c| c.contains("[Lead]: try again")), "{seen:?}");
}
