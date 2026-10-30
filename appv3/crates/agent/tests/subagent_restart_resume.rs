//! A member a server restart cut off can be messaged again by its handle:
//! the same member (same session, its transcript) goes on and reports to
//! its lead. Before, the lead got "Member 'worker#1' not found" and had to
//! start a new member from nothing. The registry and manager are
//! process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::restart_resume::{self, member_notice};
use appv3_agent::session::UserMessage;
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
async fn a_member_cut_off_by_a_restart_resumes_by_its_handle() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    // Lead delegates; the member runs one step, then hangs on its next model
    // call until the server stops. After the restart: the lead's turn on the
    // notice, the member's continued turn, the lead's turn on its report.
    let mock = Arc::new(MockProvider::new(vec![
        MockProvider::text("delegated"),
        MockProvider::tool_call("call_1", "shell", &serde_json::json!({"command": "echo step-one-done"}).to_string()),
        MockProvider::hang(),
        MockProvider::text("resuming worker#1"),
        MockProvider::text("worker finished"),
        MockProvider::text("all done"),
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

    let lead = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    lead.handle_user_message(UserMessage { content: "build it".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("lead turn finishes");
    drop(lead);

    subagents::spawn_subagent(&sid, "worker", "run the build", None, None, None, &ws, &pool, &factory).await.expect("member spawned");
    let member_sid = subagents::with_instance(&sid, "worker#1", |i| i.session_id.clone()).expect("member registered");
    wait_until("the member's hanging model call", async || calls() >= 3).await;

    // The server shuts down mid-task, and the next process starts with no
    // members in memory.
    restart_resume::begin_shutdown();
    subagents::stop_all_members(Duration::from_secs(10)).await;
    manager::stop().await;
    subagents::cleanup_lead_session(&sid);
    let marked = appv3_db::list_inflight_turns(&pool).await.unwrap();
    assert!(marked.iter().any(|r| appv3_db::codec::api_uuid(&r.session_id) == member_sid), "the shutdown left the member's turn marked");

    let report = restart_resume::resume_after_restart(&pool).await;
    assert_eq!(report.members_reported, std::slice::from_ref(&member_sid));

    // The lead hears it can resume the member, and its list says so.
    wait_until("the lead's turn on the notice", async || calls() >= 4).await;
    let lead_rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let notice = lead_rows.iter().find(|r| r.extra_json().is_some_and(|e| e["from_agent"] == "worker#1")).expect("restart notice");
    assert_eq!(notice.content.as_deref(), Some(member_notice("worker#1").as_str()));
    assert!(notice.content.as_deref().unwrap().contains("team(target='worker#1', task='continue')"));
    assert_eq!(subagents::describe_subagents(&sid), "- worker#1: stopped by a server restart (send it a task to resume)");
    if let Some(l) = manager::find_live_session(&ws, Some(&sid)) {
        tokio::time::timeout(Duration::from_secs(20), l.wait_turn_finished()).await.expect("lead turn finishes");
    }

    // The lead messages the same handle: the same session goes on, with its transcript.
    let out = subagents::send_subagent_message(&sid, "worker#1", "continue", &pool).await.expect("worker#1 resumed");
    assert_eq!(out["member_id"], "worker#1");
    assert_eq!(subagents::with_instance(&sid, "worker#1", |i| i.session_id.clone()).as_deref(), Some(member_sid.as_str()));
    wait_until("the member's continued model call", async || calls() >= 5).await;
    let seen = sent_text(&mock.calls.lock().unwrap()[4].0);
    assert!(seen.contains("[Task from Lead]: run the build"), "{seen}");
    assert!(seen.contains("step-one-done"), "the member lost its earlier work: {seen}");
    assert!(seen.contains("[Lead]: continue"), "{seen}");

    // Its report reaches the lead.
    wait_until("the member's report on the lead", async || {
        appv3_db::llm_window_rows(&pool, &sid, false)
            .await
            .unwrap()
            .iter()
            .any(|r| r.extra_json().is_some_and(|e| e["from_agent"] == "worker#1") && r.content.as_deref() == Some("worker finished"))
    })
    .await;
    wait_until("the lead's turn on the report", async || calls() >= 6).await;
    if let Some(l) = manager::find_live_session(&ws, Some(&sid)) {
        tokio::time::timeout(Duration::from_secs(20), l.wait_turn_finished()).await.expect("lead turn finishes");
    }

    // A handle the lead never had is still unknown.
    let err = subagents::send_subagent_message(&sid, "worker#9", "continue", &pool).await.unwrap_err();
    assert!(err.to_string().starts_with("Member 'worker#9' not found."), "{err}");
}
