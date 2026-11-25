//! A lead's follow-up to a working member must not cost it the member's
//! report: the lead gets the report of the task first, then the reply to the
//! follow-up, each as its own message.
//!
//! It used to lose the first: a follow-up sent while the member worked was
//! either read inside that same turn (one answer came back, to the
//! follow-up), or, queued at the turn's end, started the next turn before
//! the finished one reported. The registry is process-wide, so this file is
//! its own test binary.

use crate::common;

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::UserMessage;
use appv3_agent::{manager, subagents};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::wait_until;

fn setup_roots(root: &Path) {
    common::setup_roots(root);
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\ndescription: Runs builds.\nmodel: mock:member\ntools:\n  - shell\n---\nYou run builds.\n").unwrap();
}

/// Every user message text the provider was sent, call by call.
fn user_texts(mock: &MockProvider) -> Vec<String> {
    mock.calls
        .lock()
        .unwrap()
        .iter()
        .map(|(messages, _, _)| {
            messages
                .iter()
                .filter_map(|m| match m {
                    ChatMessage::User { content: Some(c), .. } => Some(c.to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_follow_up_sent_while_a_member_works_keeps_its_report() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let release = root.join("release");
    let build = serde_json::json!({ "command": common::wait_for_file(&release, "built") }).to_string();
    // The member: a build that waits, the task's report, then the follow-up's reply.
    let member = Arc::new(MockProvider::new(vec![
        MockProvider::tool_call("call_1", "shell", &build),
        MockProvider::text("REPORT-OF-THE-TASK"),
        MockProvider::text("REPLY-TO-THE-FOLLOW-UP"),
    ]));
    // The lead answers "mock" to everything after its first turn.
    let lead_model = Arc::new(MockProvider::new(vec![MockProvider::text("delegated")]));
    let (m, l): (Arc<dyn LlmProvider>, Arc<dyn LlmProvider>) = (member.clone(), lead_model.clone());
    let factory: ProviderFactory = Arc::new(move |model, _| Ok(if model.is_some_and(|m| m.ends_with("member")) { m.clone() } else { l.clone() }));
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

    subagents::spawn_subagent(&sid, "worker", "run the build", &ws, &pool, &factory).await.expect("member spawned");
    wait_until("the member's build to start", || !member.calls.lock().unwrap().is_empty()).await;

    // The lead follows up while the member is still building.
    let sent = subagents::send_subagent_message(&sid, "worker#1", "ALSO-RUN-THE-TESTS", &pool).await.expect("follow-up accepted");
    assert_eq!(sent["queued"], serde_json::json!(true));
    std::fs::write(&release, "").unwrap();

    wait_until("the lead to hear the follow-up's reply", || user_texts(&lead_model).iter().any(|t| t.contains("REPLY-TO-THE-FOLLOW-UP"))).await;

    // The member wrote its report before it saw the follow-up.
    let member_saw = user_texts(&member);
    assert_eq!(member_saw.len(), 3, "{member_saw:#?}");
    assert!(!member_saw[1].contains("ALSO-RUN-THE-TESTS"), "the follow-up was read inside the task's turn");
    assert!(member_saw[2].contains("ALSO-RUN-THE-TESTS"));
    // The lead got both messages, the report first.
    let lead_saw = user_texts(&lead_model).last().cloned().unwrap();
    let report = lead_saw.find("REPORT-OF-THE-TASK").expect("the task's report never reached the lead");
    let reply = lead_saw.find("REPLY-TO-THE-FOLLOW-UP").unwrap();
    assert!(report < reply, "{lead_saw}");
}
