//! Stopping a session that waits on a question dismisses it: the pending
//! question is resolved as `dismissed` and a `question_dismissed` event
//! reaches the stream, so no client keeps an answerable card. This is the only
//! way a user closes a question without answering (there is no dismiss route).
//! Its own binary: the env and settings are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{service, store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

fn setup_env(root: &std::path::Path) {
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
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_a_session_that_waits_on_a_question_dismisses_it() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();

    let ask = r#"{"questions": [{"question": "Which file?", "header": "File"}]}"#;
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![MockProvider::tool_call("a", "ask_user", ask)]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, "code", "You are a test agent.", vec![], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);

    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "pick one".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let mut sub = store().attach(&sid).expect("turn is streaming");

    tokio::time::timeout(Duration::from_secs(10), async {
        while session.state() != "waiting_input" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the question is asked");
    assert!(session.wait_for_stop(Duration::from_secs(5)).await, "the turn ends on the question");
    let open = appv3_db::get_pending_question(&pool, &sid).await.unwrap().expect("the question is open");
    assert_eq!(open.status, "pending");

    service::interrupt_agent(&session, Some(&sid)).await;

    // The row is closed as dismissed, not left open or answered.
    assert!(appv3_db::get_pending_question(&pool, &sid).await.unwrap().is_none(), "no question left open");
    let row = appv3_db::get_question(&pool, &open.id).await.unwrap().expect("row kept");
    assert_eq!(row.status, "dismissed");

    // Every attached client hears about it.
    let qid = appv3_db::codec::api_uuid(&open.id);
    let mut dismissed = None;
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(ev) = sub.next().await {
            if ev.event == "question_dismissed" {
                dismissed = Some(serde_json::from_str::<Value>(&ev.data).unwrap());
            }
        }
    })
    .await
    .expect("stream ends");
    let ev = dismissed.expect("a question_dismissed event was pushed");
    assert_eq!(ev["question_id"], qid.as_str());
    assert_eq!(ev["reason"], "dismissed");
    assert_eq!(session.state(), "idle");
}
