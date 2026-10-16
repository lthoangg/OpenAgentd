//! Stop always ends a turn: work that ignores the stop (here a hook that
//! never returns while the cancelled tool is recorded) is dropped after the
//! grace period, and the turn still closes normally. Its own binary: the env
//! and settings are process-global.

use appv3_agent::hooks::{Hook, RunContext};
use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::{LlmProvider, ToolCall};
use appv3_tools::{Tool, ToolContext, ToolResult};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// Runs until it is cancelled.
struct NeverEnds;

#[async_trait::async_trait]
impl Tool for NeverEnds {
    fn name(&self) -> &str {
        "never_ends"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        std::future::pending().await
    }
}

/// Hangs where the agent loop awaits it after a stop.
struct HangsOnCancel;

#[async_trait::async_trait]
impl Hook for HangsOnCancel {
    async fn on_tool_cancelled(&self, _ctx: &RunContext, _tc: &ToolCall, _result: &str, _duration_ms: Option<f64>) {
        std::future::pending::<()>().await
    }
}

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
async fn stop_ends_a_turn_whose_hook_hangs() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();

    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_1", "never_ends", "{}")]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider.clone(), "code", "You are a test agent.", vec![Arc::new(NeverEnds)], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    session.set_stop_grace(Duration::from_millis(200));
    session.push_test_hook(Arc::new(HangsOnCancel));

    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "build".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let mut sub = store().attach(&sid).expect("turn is streaming");
    let mut done = false;
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(ev) = sub.next().await {
            match ev.event.as_str() {
                "tool_start" => assert!(session.handle_stop().await, "turn was running"),
                "done" => done = true,
                _ => {}
            }
        }
    })
    .await
    .expect("stream ends");
    assert!(done, "the force-stopped turn still sends done");
    assert!(session.wait_for_stop(Duration::from_secs(2)).await, "turn ended");
    assert_eq!(session.state(), "idle");

    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    // The tool call was never saved, so nothing is marked (in particular not
    // an earlier turn's answer); the transcript ends on the prompt.
    assert_eq!(rows.last().map(|r| r.role.as_str()), Some("user"));
    assert!(rows.iter().all(|r| !r.extra.as_deref().unwrap_or_default().contains("interrupted")));
}
