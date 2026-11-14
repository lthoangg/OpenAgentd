//! A panic inside a turn (a provider or tool bug) must end that turn like
//! an error instead of leaving the session "working" until restart.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_providers::{AssistantMessage, ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderResult, ToolSpec};
use std::sync::Arc;
use std::time::Duration;

struct PanickingProvider {
    kw: Kwargs,
}

#[async_trait::async_trait]
impl LlmProvider for PanickingProvider {
    fn model(&self) -> &str {
        "boom"
    }
    fn provider_name(&self) -> Option<&str> {
        Some("mock")
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<AssistantMessage> {
        panic!("provider bug")
    }
    async fn stream(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<ChunkStream> {
        panic!("provider bug")
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
async fn a_panic_mid_turn_ends_the_turn_as_an_error() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();

    let provider: Arc<dyn LlmProvider> = Arc::new(PanickingProvider { kw: Kwargs::new() });
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, "code", "You are a test agent.", vec![], Some("mock:boom".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let mut global = appv3_agent::broadcaster::broadcaster().attach();

    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("turn still active after a panic");
    assert_eq!(session.state(), "error");
    assert!(!session.is_busy());
    let err = session.last_error().unwrap_or_default();
    assert!(err.contains("provider bug"), "{err}");

    // Someone away from the app learns the turn failed.
    let mut notification = None;
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(200), global.next()).await {
        if e.event == "desktop_notification" && e.data.contains(&sid) {
            notification = Some(serde_json::from_str::<serde_json::Value>(&e.data).unwrap());
        }
    }
    let notification = notification.expect("a failed turn notifies");
    assert_eq!(notification["kind"], "assistant_done");
    assert_eq!(notification["title"], "Failed · project");
    assert_eq!(notification["body"], "hi");
    assert_eq!(notification["outcome"], "failed");

    // The session stays usable: the next message starts (and ends) a turn.
    session.handle_user_message(UserMessage { content: "again".into(), session_id: sid, origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("second turn finishes");
}
