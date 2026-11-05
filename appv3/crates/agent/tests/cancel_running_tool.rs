//! Stopping a turn while a tool is running keeps the output that tool had
//! streamed and says how long it ran, both in the persisted tool result the
//! model sees next turn and in the `tool_end` frame the UI renders. Its own
//! binary: the env and settings are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext, ToolResult};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// Streams two lines, then runs until it is cancelled.
struct NeverEnds;

#[async_trait::async_trait]
impl Tool for NeverEnds {
    fn name(&self) -> &str {
        "never_ends"
    }
    async fn run(&self, ctx: &ToolContext, _args: Value) -> ToolResult {
        let out = ctx.output.clone().expect("running tools get an output sink");
        out("compiling crate a\n".into());
        out("compiling crate b\n".into());
        std::future::pending().await
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

fn assert_cancelled_result(text: &str) {
    let (output, note) = text.rsplit_once("\n\n").unwrap_or_else(|| panic!("no captured output in {text:?}"));
    assert_eq!(output, "compiling crate a\ncompiling crate b");
    let secs = note.strip_prefix("Cancelled by user after ").and_then(|s| s.strip_suffix(" seconds.")).unwrap_or_else(|| panic!("unexpected note {note:?}"));
    let secs: f64 = secs.parse().unwrap();
    assert!((0.0..10.0).contains(&secs), "ran {secs}s");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_a_running_tool_keeps_its_output_and_runtime() {
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
    let mut global = appv3_agent::broadcaster::broadcaster().attach();

    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "build".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let mut sub = store().attach(&sid).expect("turn is streaming");
    let mut deltas = 0;
    let mut tool_end: Option<Value> = None;
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(ev) = sub.next().await {
            match ev.event.as_str() {
                "tool_output_delta" => {
                    deltas += 1;
                    if deltas == 2 {
                        assert!(session.handle_stop().await, "turn was running");
                    }
                }
                "tool_end" => tool_end = Some(serde_json::from_str(&ev.data).unwrap()),
                _ => {}
            }
        }
    })
    .await
    .expect("stream ends with done");
    session.wait_turn_finished().await;

    let end = tool_end.expect("the cancelled call still ends in a tool_end frame");
    assert_eq!(end["tool_call_id"], "call_1");
    // The output stays on the server (fetched when opened); the frame says so.
    assert_eq!(end["metadata"]["result_omitted"], true, "{end}");

    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let tool = rows.iter().find(|r| r.role == "tool" && r.tool_call_id.as_deref() == Some("call_1")).expect("tool result persisted");
    assert_cancelled_result(tool.content.as_deref().unwrap());

    // The user stopped it themselves: no "Done" notification.
    let mut seen = vec![];
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(200), global.next()).await {
        if e.data.contains(&sid) {
            seen.push(e.event.clone());
        }
    }
    assert!(seen.contains(&"session_turn_completed".to_string()), "{seen:?}");
    assert!(!seen.contains(&"desktop_notification".to_string()), "{seen:?}");
}
