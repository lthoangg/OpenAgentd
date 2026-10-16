//! A `stop_reason: "refusal"` ends the turn with a visible error; the refused
//! response is neither executed nor saved.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatCompletionChunk, ChatCompletionDelta, FunctionCallDelta, LlmProvider, ToolCallDelta, Usage};
use serde_json::{json, Value};
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

fn refused_turn() -> MockTurn {
    let call = ToolCallDelta {
        index: Some(0),
        id: Some("call_1".into()),
        function: Some(FunctionCallDelta { name: Some("read".into()), arguments: Some(r#"{"path":"hello.txt"}"#.into()), ..Default::default() }),
    };
    MockTurn::Chunks(vec![
        ChatCompletionChunk::delta(
            "mock",
            "mock",
            ChatCompletionDelta { reasoning_content: Some("Thinking.".into()), tool_calls: Some(vec![call]), ..Default::default() },
            None,
            None,
        ),
        ChatCompletionChunk::delta(
            "mock",
            "mock",
            ChatCompletionDelta {
                stop_details: Some(json!({"type": "refusal", "category": "cyber", "explanation": "This request was declined because it could enable cyber harm."})),
                ..Default::default()
            },
            Some("refusal".into()),
            Some(Usage { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, ..Default::default() }),
        ),
    ])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusal_ends_turn_with_error_and_drops_the_response() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("hello.txt"), "hello world\n").unwrap();

    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![refused_turn()]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider.clone(), "code", "You are a test agent.", vec![appv3_tools::builtin_tool("read").unwrap()], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);

    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let mut sub = store().attach(&sid).expect("turn is streaming");
    let mut events = vec![];
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(e) = sub.next().await {
            events.push((e.event.clone(), e.data.clone()));
        }
    })
    .await
    .expect("stream ends with done");
    session.wait_turn_finished().await;

    let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
    assert_eq!(*names.last().unwrap(), "done", "{names:?}");
    assert!(!names.contains(&"tool_start"), "refused tool call must not run: {names:?}");
    let (_, data) = events.iter().find(|(e, _)| e == "error").unwrap_or_else(|| panic!("no error event in {names:?}"));
    let err: Value = serde_json::from_str(data).unwrap();
    assert_eq!(err["code"], "model_refusal", "{err}");
    assert_eq!(err["category"], "provider", "{err}");
    assert!(err["message"].as_str().unwrap().contains("could enable cyber harm"), "{err}");
    assert_eq!(session.state(), "error");

    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let roles: Vec<&str> = rows.iter().map(|r| r.role.as_str()).collect();
    assert_eq!(roles, vec!["user"], "refused response must not be saved");
}
