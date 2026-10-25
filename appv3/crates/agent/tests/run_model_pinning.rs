//! A run keeps the agent config it started with. Changing the agent's
//! default model in Settings while a session runs must not switch the
//! turns that continue that run (a subagent report, a queued steer, an
//! answered question); the next message the user sends picks it up. Its own
//! binary: the env and settings are process-global.

use appv3_agent::loader::{self, ProviderFactory};
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::store;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

fn setup_env(root: &Path) {
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

/// Write the agent file with `model`, stamped `age_secs` in the past so a
/// rewrite always reads as a change.
fn write_agent(path: &Path, model: &str, age_secs: u64) {
    std::fs::write(path, format!("---\nname: tester\nmodel: {model}\n---\n\nYou are a test agent.\n")).unwrap();
    let f = std::fs::File::options().write(true).open(path).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
}

async fn wait_turn(session: &AgentSession, sid: &str) {
    if let Some(mut sub) = store().attach(sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("turn finishes");
}

/// The model recorded on the newest assistant row.
async fn last_model(pool: &appv3_db::DbPool, sid: &str) -> Option<String> {
    let rows = appv3_db::llm_window_rows(pool, sid, false).await.unwrap();
    let last = rows.iter().rev().find(|r| r.role == "assistant").expect("an assistant row");
    last.extra_json().and_then(|e| e.get("model").and_then(|v| v.as_str()).map(String::from))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changing_the_default_model_mid_run_keeps_the_run_on_its_model() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let agent_md = root.path().join("tester.md");
    write_agent(&agent_md, "mock:a", 60);

    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![]));
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    let cfg = loader::parse_agent_md(&agent_md).unwrap();
    let agent = loader::build_agent(cfg, &loader::default_tool_registry(), &factory, Some(&agent_md));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let sid = uuid::Uuid::now_v7().to_string();
    // As the web sends it for a session that follows the agent's default.
    let msg = |content: &str| UserMessage { content: content.into(), session_id: sid.clone(), model: None, model_provided: true, origin: "user".into(), ..Default::default() };

    session.handle_user_message(msg("start")).await.unwrap();
    wait_turn(&session, &sid).await;
    assert_eq!(last_model(&pool, &sid).await.as_deref(), Some("mock:a"));

    // The user switches the agent's default model while the run goes on.
    write_agent(&agent_md, "mock:b", 0);

    // A member's report wakes the lead (as `deliver_agent_message` does).
    appv3_db::save_queued_user_message(&pool, &sid, "[Report from explorer#1]: done", None).await.unwrap();
    assert!(session.activate_queued_user_messages(&sid).await);
    wait_turn(&session, &sid).await;
    assert_eq!(last_model(&pool, &sid).await.as_deref(), Some("mock:a"), "a report turn switched the run's model");

    // An answered question resumes the same run.
    session.resume_after_question_answer().await;
    wait_turn(&session, &sid).await;
    assert_eq!(last_model(&pool, &sid).await.as_deref(), Some("mock:a"), "a resumed turn switched the run's model");

    // The next message from the user starts a new run on the new default.
    session.handle_user_message(msg("next")).await.unwrap();
    wait_turn(&session, &sid).await;
    assert_eq!(last_model(&pool, &sid).await.as_deref(), Some("mock:b"));
}
