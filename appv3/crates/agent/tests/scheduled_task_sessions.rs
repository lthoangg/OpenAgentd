//! A scheduled task without a session starts a new session on every run,
//! and each run gets its own AgentSession. Two runs used to share the
//! workspace's sessionless AgentSession: the second rebound it while the
//! first was still running, and the first left its in-flight mark behind,
//! so the next server start ran it again. The manager and scheduler are
//! process-wide, so this file is its own test binary.

mod common;

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::scheduler::{self, TaskCreate};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderResult, ToolSpec};
use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;

use common::{setup_roots, wait_until_async};

/// Every model call waits for a permit from `gate`, then answers.
struct GatedProvider {
    gate: tokio::sync::Semaphore,
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
        self.gate.acquire().await.expect("gate open").forget();
        let MockTurn::Chunks(chunks) = MockProvider::text("Cleaned.") else { unreachable!() };
        Ok(Box::pin(futures::stream::iter(chunks.into_iter().map(Ok))))
    }
}

async fn in_flight(pool: &appv3_db::DbPool) -> Vec<String> {
    appv3_db::list_inflight_turns(pool).await.unwrap().into_iter().map(|r| appv3_db::codec::api_uuid(&r.session_id)).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_run_of_a_task_without_a_session_gets_its_own_agent_session() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let provider = Arc::new(GatedProvider { gate: tokio::sync::Semaphore::new(0), kw: Kwargs::new() });
    let shared: Arc<dyn LlmProvider> = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(shared.clone()));
    manager::init(pool.clone(), factory);
    scheduler::init(pool.clone());
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let s = scheduler::scheduler();
    let t = s
        .create(TaskCreate {
            name: "cleanup".into(),
            slug: Some("cleanup".into()),
            workspace: ws.clone(),
            schedule_type: "every".into(),
            every_seconds: Some(3600),
            timezone: "UTC".into(),
            prompt: "clean up".into(),
            session_id: None,
            enabled: false,
            ..Default::default()
        })
        .await
        .unwrap();

    // Two runs, the second while the first still waits on its model call.
    for n in 1..=2 {
        s.trigger(&t.slug).await.unwrap();
        wait_until_async("the run to fire", async || s.get_task(&t.slug).await.unwrap().unwrap().run_count >= n).await;
    }
    wait_until_async("both runs marked in flight", async || in_flight(&pool).await.len() == 2).await;
    let runs = in_flight(&pool).await;
    assert_ne!(runs[0], runs[1], "the runs shared a session");
    let first = manager::find_live_session(&ws, Some(&runs[0])).expect("the first run has its own AgentSession");
    let second = manager::find_live_session(&ws, Some(&runs[1])).expect("the second run has its own AgentSession");
    assert!(!Arc::ptr_eq(&first, &second), "the runs shared an AgentSession");
    assert_eq!((first.session_id(), second.session_id()), (runs[0].clone(), runs[1].clone()));

    // Both finish, and neither leaves a mark for the next start to run again.
    provider.gate.add_permits(2);
    for live in [&first, &second] {
        tokio::time::timeout(Duration::from_secs(10), live.wait_turn_finished()).await.expect("the run finishes");
    }
    wait_until_async("no run left in flight", async || in_flight(&pool).await.is_empty()).await;
}
