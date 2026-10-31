//! A turn clears the in-flight mark of the session it ran for, even when
//! the AgentSession was bound to another session while it ran (two scheduled
//! runs sharing one AgentSession did that). The leftover mark made the next
//! server start continue a turn that had finished hours before. The manager
//! is process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::session::UserMessage;
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderResult, ToolSpec};
use async_trait::async_trait;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
}

/// The first model call waits for `gate`; every later one answers at once.
struct GatedProvider {
    gate: tokio::sync::Notify,
    calls: AtomicUsize,
    kw: Kwargs,
}

#[async_trait]
impl LlmProvider for GatedProvider {
    fn model(&self) -> &str {
        "mock"
    }
    fn provider_name(&self) -> Option<&str> {
        Some("mock")
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<appv3_providers::AssistantMessage> {
        Ok(appv3_providers::AssistantMessage { content: Some("Title".into()), ..Default::default() })
    }
    async fn stream(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<ChunkStream> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            self.gate.notified().await;
        }
        let MockTurn::Chunks(chunks) = MockProvider::text("Done.") else { unreachable!() };
        Ok(Box::pin(futures::stream::iter(chunks.into_iter().map(Ok))))
    }
}

async fn in_flight(pool: &appv3_db::DbPool) -> Vec<String> {
    appv3_db::list_inflight_turns(pool).await.unwrap().into_iter().map(|r| appv3_db::codec::api_uuid(&r.session_id)).collect()
}

async fn answered(pool: &appv3_db::DbPool, sid: &str) -> bool {
    appv3_db::llm_window_rows(pool, sid, false).await.unwrap().last().is_some_and(|r| r.role == "assistant" && r.content.as_deref() == Some("Done."))
}

async fn wait_for(what: &str, mut done: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !done().await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_clears_its_own_mark_after_its_agent_session_moved_to_another_session() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let provider = Arc::new(GatedProvider { gate: tokio::sync::Notify::new(), calls: AtomicUsize::new(0), kw: Kwargs::new() });
    let shared: Arc<dyn LlmProvider> = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(shared.clone()));
    manager::init(pool.clone(), factory);
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    // The workspace's sessionless AgentSession, as a scheduled task without a
    // session used to get.
    let session = manager::get_or_start_agent_session(&ws, None).await.unwrap().expect("agent configured");
    let send = |sid: &str| UserMessage { content: "clean up".into(), session_id: sid.into(), workspace: Some(ws.clone()), origin: "scheduler".into(), ..Default::default() };
    let first = uuid::Uuid::now_v7().to_string();
    let second = uuid::Uuid::now_v7().to_string();

    // The first run waits on its model call; the second binds the same
    // AgentSession to its own session and finishes first.
    session.handle_user_message(send(&first)).await.unwrap();
    wait_for("the first run's model call", async || provider.calls.load(Ordering::SeqCst) >= 1).await;
    assert_eq!(in_flight(&pool).await, vec![first.clone()]);
    session.handle_user_message(send(&second)).await.unwrap();
    wait_for("the second run's answer", async || answered(&pool, &second).await).await;

    // The first run answers and ends: no mark is left behind.
    provider.gate.notify_one();
    wait_for("the first run's answer", async || answered(&pool, &first).await).await;
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while !in_flight(&pool).await.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert_eq!(in_flight(&pool).await, Vec::<String>::new(), "a finished turn left its mark, so the next start would run it again");
}
