//! Idle eviction must not stop a lead whose subagents are still working.
//!
//! A lead's turn ends right after it delegates, so the lead sits `idle`
//! while its members run. Eviction once looked only at the lead's own state:
//! 30 minutes into a long member job, any lookup evicted the lead, and
//! stopping it cancelled every member. A cancelled member skips its report,
//! so the lead never heard back. The manager is process-wide, so this file
//! is its own test binary.

use appv3_agent::loader::ProviderFactory;
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
    // Title generation would take scripted turns off the mock provider.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lead_with_a_working_subagent_is_not_evicted() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let release = root.join("release");
    let build = format!("while [ ! -f '{}' ]; do sleep 0.05; done; echo built", release.display());
    let args = serde_json::json!({ "command": build }).to_string();
    // Lead turn, member tool call, member report, then the lead's turn on that report.
    let mock = Arc::new(MockProvider::new(vec![
        MockProvider::text("delegated"),
        MockProvider::tool_call("call_1", "shell", &args),
        MockProvider::text("build finished"),
        MockProvider::text("thanks"),
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

    let lead = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    lead.handle_user_message(UserMessage { content: "build it".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("lead turn finishes");

    subagents::spawn_subagent(&sid, "worker", "run the build", None, None, None, &ws, &pool, &factory).await.expect("member spawned");
    // The member's first model call asked for the build, which now blocks.
    wait_until("the member's build to start", || mock.calls.lock().unwrap().len() >= 2).await;
    assert_eq!(lead.state(), "idle");
    assert!(subagents::has_working_subagents(&sid));
    // The active-sessions list (and the notch) keep the idle lead as busy.
    assert!(subagents::has_pending_work(&sid));
    assert!(subagents::sessions_with_pending_work().contains(&sid));

    // Idle for the full cutoff while the member is still building.
    let cutoff = Duration::from_secs(manager::SESSION_IDLE_SECONDS);
    manager::evict_idle_sessions(Some(Instant::now() + cutoff)).await;
    let live = manager::find_live_session(&ws, Some(&sid)).expect("a lead with a working subagent was evicted");
    assert!(Arc::ptr_eq(&live, &lead), "the lead was replaced");
    assert!(subagents::has_working_subagents(&sid), "eviction stopped the working member");

    // The member finishes; its report runs the lead again.
    std::fs::write(&release, "").unwrap();
    let report_read = || {
        mock.calls.lock().unwrap().iter().any(|(messages, _, _)| messages.iter().any(|m| matches!(m, ChatMessage::User { content: Some(c), .. } if c.contains("build finished"))))
    };
    wait_until("the lead to read the member's report", report_read).await;
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("lead turn on the report finishes");
    assert!(!subagents::has_working_subagents(&sid));
    assert!(!subagents::sessions_with_pending_work().contains(&sid));

    // With no member working, an idle lead is evicted as before.
    manager::evict_idle_sessions(Some(Instant::now() + cutoff)).await;
    assert!(manager::find_live_session(&ws, Some(&sid)).is_none(), "an idle lead was kept");
}
