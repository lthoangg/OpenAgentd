//! A member whose model call fails tells its lead why, and whether retrying
//! can help.
//!
//! The lead used to read "Subagent turn failed with error." for every cause:
//! the turn's error was recorded on the member's session but never passed
//! on, so the lead could not tell a rate limit from a revoked key. The
//! manager is process-wide, so this file is its own test binary.

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

fn lead_read(mock: &MockProvider, needle: &str) -> Option<String> {
    mock.calls.lock().unwrap().iter().flat_map(|(messages, _, _)| messages.iter()).find_map(|m| match m {
        ChatMessage::User { content: Some(c), .. } if c.contains(needle) => Some(c.clone()),
        _ => None,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_member_whose_key_is_rejected_tells_the_lead_why_and_that_retrying_wont_help() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let lead_mock = Arc::new(MockProvider::new(vec![]));
    let unauthorized = ProviderError::http(401, "https://api.example.test/v1/messages", r#"{"error":{"message":"Invalid API key."}}"#.into(), vec![]);
    let worker_mock = Arc::new(MockProvider::new(vec![MockTurn::Error(unauthorized)]));
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
    manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");

    subagents::spawn_subagent(&sid, "worker", "run the build", None, None, None, &ws, &pool, &factory).await.expect("member spawned");

    wait_until("the lead to read the member's failure", || lead_read(&lead_mock, "worker#1 failed").is_some()).await;
    let report = lead_read(&lead_mock, "worker#1 failed").unwrap();
    assert!(report.contains("worker#1 failed: Provider Authentication Failed: "), "{report}");
    assert!(report.contains("Invalid API key"), "{report}");
    assert!(report.contains("Retrying won't help until its model or provider is fixed."), "{report}");
    assert!(!report.contains("Subagent turn failed with error"), "{report}");
    let listed = subagents::describe_subagents(&sid);
    assert!(listed.starts_with("- worker#1: failed: mock:worker rejected the request"), "{listed}");
}
