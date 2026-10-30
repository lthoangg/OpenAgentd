//! A turn records the thinking level its provider ran with
//! (`extra.thinking_level`) on the assistant row and on its live `message`
//! deltas, so the transcript footer can name it beside the model. Its own
//! binary: the env and settings are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
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

/// Run one turn; returns the `metadata` of every live `message` delta.
async fn turn(session: &AgentSession, m: UserMessage) -> Vec<Value> {
    let sid = m.session_id.clone();
    session.handle_user_message(m).await.unwrap();
    let mut sub = store().attach(&sid).expect("turn is streaming");
    let mut metas = vec![];
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(e) = sub.next().await {
            if e.event == "message" {
                let v: Value = serde_json::from_str(&e.data).unwrap();
                metas.push(v["metadata"].clone());
            }
        }
    })
    .await
    .expect("stream ends with done");
    session.wait_turn_finished().await;
    metas
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turns_record_the_thinking_level_they_ran_with() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();

    // No scripted turns: every call answers "mock", so a title request
    // cannot steal a turn meant for the transcript.
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let mut agent = Agent::new(provider.clone(), "code", "You are a test agent.", vec![], Some("mock:mock".into()));
    agent.thinking_level = Some("high".into());
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let sid = uuid::Uuid::now_v7().to_string();
    let msg = |content: &str| UserMessage { content: content.into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() };

    // The agent's own level applies when the session sets none.
    let default_deltas = turn(&session, msg("one")).await;
    // A session level replaces it.
    let override_deltas = turn(&session, UserMessage { thinking_level: Some("low".into()), thinking_level_provided: true, ..msg("two") }).await;
    // A session model builds its own provider with only the session's level,
    // so the agent's level no longer applies and nothing is recorded.
    let model_deltas =
        turn(&session, UserMessage { model: Some("mock:other".into()), model_provided: true, thinking_level: None, thinking_level_provided: true, ..msg("three") }).await;

    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let levels: Vec<Option<String>> =
        rows.iter().filter(|r| r.role == "assistant").map(|r| r.extra_json().unwrap().get("thinking_level").and_then(|v| v.as_str()).map(String::from)).collect();
    assert_eq!(levels, vec![Some("high".into()), Some("low".into()), None]);

    // Each prompt records the model and level it was sent with, even when the
    // send changed neither, so its bubble names them after a reload.
    let str_of = |r: &appv3_db::SessionMessage, k: &str| r.extra_json().and_then(|e| e.get(k).and_then(|v| v.as_str()).map(String::from));
    let prompts: Vec<(Option<String>, Option<String>)> = rows.iter().filter(|r| r.role == "user").map(|r| (str_of(r, "model"), str_of(r, "thinking_level"))).collect();
    assert_eq!(prompts, vec![(Some("mock:mock".into()), Some("high".into())), (Some("mock:mock".into()), Some("low".into())), (Some("mock:other".into()), None),]);

    let delta_level = |metas: &[Value]| -> Vec<Option<String>> { metas.iter().map(|m| m.get("thinking_level").and_then(|v| v.as_str()).map(String::from)).collect() };
    assert!(!default_deltas.is_empty() && !override_deltas.is_empty() && !model_deltas.is_empty());
    assert!(delta_level(&default_deltas).iter().all(|l| l.as_deref() == Some("high")), "{default_deltas:?}");
    assert!(delta_level(&override_deltas).iter().all(|l| l.as_deref() == Some("low")), "{override_deltas:?}");
    assert!(delta_level(&model_deltas).iter().all(Option::is_none), "{model_deltas:?}");
}
