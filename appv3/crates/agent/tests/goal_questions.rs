//! A goal with `goals.allow_questions` on: a goal turn may ask the user,
//! and the goal waits for the answer instead of refusing the question or
//! starting another turn. Its own binary: the setting is process-wide.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_questions_on_a_goal_waits_for_the_answer() {
    let root = tempfile::tempdir().unwrap();
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.path().join(d));
    }
    std::env::set_var("HOME", root.path().join("home"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    std::fs::create_dir_all(root.path().join("config")).unwrap();
    std::fs::write(root.path().join("config/settings.yaml"), "title_generation:\n  enabled: false\ngoals:\n  allow_questions: true\n").unwrap();
    assert!(appv3_core::runtime_settings::goal_settings().allow_questions);

    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let ask = r#"{"questions": [{"question": "Which file?", "header": "File"}]}"#;
    let mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("a", "ask_user", ask)]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, "code", "You are a test agent.", vec![], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let sid = uuid::Uuid::now_v7().to_string();
    let id = uuid::Uuid::parse_str(&sid).unwrap();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), ..Default::default() }).await.unwrap();

    session.start_goal_from_plan(&sid, "fix it", Some(5)).await.unwrap();
    session.handle_user_message(UserMessage { content: "fix it".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while session.state() != "waiting_input" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the question is asked, not refused");
    assert!(session.wait_for_stop(Duration::from_secs(5)).await, "the turn ends on the question");

    assert!(appv3_db::get_pending_question(&pool, &sid).await.unwrap().is_some());
    let g = appv3_db::latest_session_goal(&pool, &sid).await.unwrap().unwrap();
    assert_eq!((g.status.as_str(), g.turns_used), ("active", 1), "{g:?}");
    assert!(!appv3_db::has_queued_user_messages(&pool, &sid).await.unwrap(), "no turn queued while the question is open");
    assert_eq!(mock.calls.lock().unwrap().len(), 1);
    // The rules told the model it may ask.
    let first = mock.calls.lock().unwrap()[0].0.iter().filter_map(|m| m.content().map(String::from)).collect::<Vec<_>>().join("\n");
    assert!(first.contains("ask with `ask_user` only when you are truly blocked"), "{first}");
}
