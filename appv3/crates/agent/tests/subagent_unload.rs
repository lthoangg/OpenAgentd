//! A member that finished leaves memory a few minutes after its report
//! reached the lead; before, it stayed loaded until its lead was deleted.
//! Nothing the lead can do with it changes: it is still listed as done,
//! and a message to its handle loads the same session back with its whole
//! conversation. The registry and manager are process-wide, so this file
//! is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::{manager, subagents};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
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
    std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\ndescription: Runs builds.\nmodel: mock:mock\ntools:\n  - shell\n---\nYou run builds.\n").unwrap();
}

async fn wait_until(what: &str, mut f: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !f().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn sent_text(messages: &[ChatMessage]) -> String {
    messages.iter().filter_map(|m| m.content()).collect::<Vec<_>>().join("\n")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_finished_member_is_unloaded_and_resumes_by_its_handle() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    // The member's answer, the lead's turn on it, then the same again for
    // the follow-up.
    let mock = Arc::new(MockProvider::new(vec![
        MockProvider::text("build finished"),
        MockProvider::text("thanks"),
        MockProvider::text("tests pass too"),
        MockProvider::text("all done"),
        MockProvider::text("shipped"),
        MockProvider::text("good"),
    ]));
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
    let calls = || mock.calls.lock().unwrap().len();
    let lead_idle = async || {
        if let Some(l) = manager::find_live_session(&ws, Some(&sid)) {
            tokio::time::timeout(Duration::from_secs(20), l.wait_turn_finished()).await.expect("lead turn finishes");
        }
    };
    let loaded = || subagents::with_instance(&sid, "worker#1", |i| i.session_id.clone());

    let before_spawn = Instant::now();
    subagents::spawn_subagent(&sid, "worker", "run the build", &ws, &pool, &factory).await.expect("member spawned");
    let member_sid = loaded().expect("member registered");
    wait_until("the lead's turn on the report", async || calls() >= 2).await;
    lead_idle().await;

    // It stays loaded until the full wait has passed since its report.
    assert_eq!(subagents::unload_finished(before_spawn + subagents::UNLOAD_FINISHED_AFTER).await, 0);
    assert_eq!(loaded().as_deref(), Some(member_sid.as_str()));
    assert_eq!(subagents::describe_subagents(&sid, &pool).await, "- worker#1: done (report delivered)");

    // Then any session lookup drops it from memory.
    wait_until("the member to be unloaded", async || {
        subagents::unload_finished(Instant::now() + subagents::UNLOAD_FINISHED_AFTER).await;
        loaded().is_none()
    })
    .await;

    // The lead still sees it, in its list and in the app's roster.
    assert_eq!(subagents::describe_subagents(&sid, &pool).await, "- worker#1: done (send it a task to continue)");
    let roster = subagents::list_subagents(&sid, &pool).await;
    let listed = &roster["live_members"][0];
    assert_eq!((listed["member_id"].as_str(), listed["status"].as_str()), (Some("worker#1"), Some("completed")));
    // Stopping it answers as it did while it was loaded.
    let stopped = subagents::stop_subagent(&sid, "worker#1", &pool).await.expect("stop answers");
    assert_eq!(stopped, serde_json::json!({"status": "completed", "member_id": "worker#1", "was_running": false}));
    assert!(loaded().is_none(), "listing or stopping loaded it back");

    // A message to its handle runs the same session, with its conversation.
    let out = subagents::send_subagent_message(&sid, "worker#1", "now run the tests", &pool).await.expect("worker#1 resumed");
    assert_eq!(out["member_id"], "worker#1");
    assert_eq!(loaded().as_deref(), Some(member_sid.as_str()));
    wait_until("the member's follow-up model call", async || calls() >= 3).await;
    let seen = sent_text(&mock.calls.lock().unwrap()[2].0);
    assert!(seen.contains("[Task from Lead]: run the build"), "{seen}");
    assert!(seen.contains("build finished"), "the member lost its earlier answer: {seen}");
    assert!(seen.contains("[Lead]: now run the tests"), "{seen}");

    // Its new report reaches the lead, and it is unloaded again.
    wait_until("the follow-up report on the lead", async || {
        appv3_db::llm_window_rows(&pool, &sid, false)
            .await
            .unwrap()
            .iter()
            .any(|r| r.extra_json().is_some_and(|e| e["from_agent"] == "worker#1") && r.content.as_deref() == Some("tests pass too"))
    })
    .await;
    wait_until("the lead's turn on the follow-up report", async || calls() >= 4).await;
    lead_idle().await;
    wait_until("the member to be unloaded again", async || {
        subagents::unload_finished(Instant::now() + subagents::UNLOAD_FINISHED_AFTER).await;
        loaded().is_none()
    })
    .await;

    // Loaded back, it reads as done, not stopped (nothing cut it off), and
    // it stays until it has reported again.
    subagents::rehydrate_member(&sid, "worker#1", &pool, &factory, false).await.expect("loaded back");
    assert_eq!(subagents::with_instance(&sid, "worker#1", |i| i.status().as_str()), Some("completed"));
    assert_eq!(subagents::unload_finished(Instant::now() + subagents::UNLOAD_FINISHED_AFTER).await, 0);
    assert_eq!(loaded().as_deref(), Some(member_sid.as_str()));

    // A new member still gets the next number.
    let second = subagents::spawn_subagent(&sid, "worker", "ship it", &ws, &pool, &factory).await.expect("second member spawned");
    assert_eq!(second["member_id"], "worker#2");
}
