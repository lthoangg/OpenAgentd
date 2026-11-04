//! A member that asks its lead (`ask_lead`) reads the lead's answer as the
//! result of that call, at the end of its next request.
//!
//! In production the answer was saved at `seq = 0`, so it loaded first, was
//! dropped as an orphan, and the `ask_lead` call was stripped from the
//! member's last message. The request then ended with an assistant message:
//! models without prefill rejected it (HTTP 400), and the rest silently lost
//! the answer. The registry is process-wide, so this file is its own test
//! binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::UserMessage;
use appv3_agent::{manager, subagents};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatCompletionChunk, ChatCompletionDelta, ChatMessage, LlmProvider};
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
    std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\ndescription: Runs builds.\nmodel: mock:mock\ntools: []\n---\nYou run builds.\n").unwrap();
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A reply with text and an `ask_lead` call, as models usually write it: the
/// text is what kept the stripped message in the failing request.
fn text_and_ask_lead(text: &str, id: &str, question: &str) -> MockTurn {
    let MockTurn::Chunks(mut chunks) = MockProvider::tool_call(id, "ask_lead", &serde_json::json!({ "question": question }).to_string()) else { unreachable!() };
    chunks.insert(0, ChatCompletionChunk::delta("mock", "mock", ChatCompletionDelta { content: Some(text.into()), ..Default::default() }, None, None));
    MockTurn::Chunks(chunks)
}

fn is_member_call(messages: &[ChatMessage]) -> bool {
    messages.iter().any(|m| matches!(m, ChatMessage::User { content: Some(c), .. } if c.contains("pick a branch")))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_lead_answer_ends_the_members_next_request() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    // The lead's turn, then the member asks. Every later call (the lead
    // reading the question, the member after the answer) gets "mock".
    let mock = Arc::new(MockProvider::new(vec![MockProvider::text("delegated"), text_and_ask_lead("I need a decision.", "call_ask", "Which branch?")]));
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

    subagents::spawn_subagent(&sid, "worker", "pick a branch", None, None, None, &ws, &pool, &factory).await.expect("member spawned");
    let member = subagents::with_instance(&sid, "worker#1", |i| i.session.clone()).expect("member registered");
    wait_until("the member to wait on its lead", || member.state() == "waiting_lead").await;
    let asked = mock.calls.lock().unwrap().iter().filter(|(m, _, _)| is_member_call(m)).count();

    subagents::send_subagent_message(&sid, "worker#1", "main", &pool).await.expect("answer delivered");
    wait_until("the member's next request", || mock.calls.lock().unwrap().iter().filter(|(m, _, _)| is_member_call(m)).count() > asked).await;

    let calls = mock.calls.lock().unwrap();
    let (messages, _, _) = calls.iter().rfind(|(m, _, _)| is_member_call(m)).unwrap();
    match messages.last() {
        Some(ChatMessage::Tool { tool_call_id, content, .. }) => {
            assert_eq!(tool_call_id, "call_ask");
            assert_eq!(content.as_deref(), Some("Lead answered: main"));
        }
        other => panic!("the member's request must end with the ask_lead result, got {other:?}"),
    }
    let asked_call = messages.iter().rev().nth(1);
    assert!(
        matches!(asked_call, Some(ChatMessage::Assistant(a)) if a.tool_calls.as_ref().is_some_and(|t| t.iter().any(|tc| tc.id == "call_ask"))),
        "the ask_lead call must stay paired with its answer, got {asked_call:?}"
    );
}
