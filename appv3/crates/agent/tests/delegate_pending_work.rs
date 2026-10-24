//! A lead that delegates during its turn stays busy until its subagents
//! report, and each subagent's turn streams live under its own session id.
//!
//! The lead's turn usually ends seconds after `delegate`, while its members
//! still work for minutes. The active-sessions list (sidebar "Needs you",
//! badge counts, the notch island) must keep listing the lead with
//! `background_work` for that whole time. The manager is process-wide, so
//! this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::UserMessage;
use appv3_agent::stream_store::store;
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
    // Title generation would take scripted turns off the mock providers.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lead_that_delegated_mid_turn_stays_busy_until_its_subagent_reports() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let release = root.join("release");
    let build = format!("while [ ! -f '{}' ]; do sleep 0.05; done; echo built", release.display());
    let build_args = serde_json::json!({ "command": build }).to_string();
    let delegate_args = serde_json::json!({ "profile": "worker", "task": "run the build" }).to_string();
    // The lead delegates, ends its turn, then reads the member's report.
    let lead_mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_d", "delegate", &delegate_args), MockProvider::text("delegated"), MockProvider::text("thanks")]));
    // The member's build blocks until the test releases it.
    let worker_mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_w", "shell", &build_args), MockProvider::text("build finished")]));
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
    lead.handle_user_message(UserMessage { content: "build it".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("lead turn finishes");
    assert_eq!(lead_mock.calls.lock().unwrap().len(), 2, "the lead delegated, then ended its turn");

    // The member asked for the build, which now blocks.
    wait_until("the member's build to start", || !worker_mock.calls.lock().unwrap().is_empty()).await;
    let children = appv3_db::list_child_sessions(&pool, std::slice::from_ref(&sid)).await.unwrap();
    assert_eq!(children.len(), 1, "one member session");
    let child = appv3_db::codec::api_uuid(&children[0].id);

    // The lead's turn is over, but its member still works for it.
    assert_eq!(lead.state(), "idle");
    assert!(!store().is_running(&sid), "the lead's own turn is over");
    assert!(subagents::has_working_subagents(&sid), "the member is still working");
    assert!(subagents::sessions_with_pending_work().contains(&sid), "the active list drops a lead whose member still works");

    // The member's turn streams under its own id, so its view can attach.
    assert!(store().is_running(&child), "the member's turn is not streaming under {child}");
    assert!(store().attach(&child).is_some(), "nothing to attach to for the running member");

    // The member finishes; its report runs the lead again.
    std::fs::write(&release, "").unwrap();
    let report_read = || {
        lead_mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(messages, _, _)| messages.iter().any(|m| matches!(m, ChatMessage::User { content: Some(c), .. } if c.contains("build finished"))))
    };
    wait_until("the lead to read the member's report", report_read).await;
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("lead turn on the report finishes");
    assert!(!subagents::sessions_with_pending_work().contains(&sid));
}
