//! A scheduled task without a session starts a new session on every run,
//! and each run gets its own AgentSession. Two runs used to share the
//! workspace's sessionless AgentSession: the second rebound it while the
//! first was still running, and the first left its in-flight mark behind,
//! so the next server start ran it again. The manager and scheduler are
//! process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::scheduler::{self, TaskCreate};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderResult, ToolSpec};
use async_trait::async_trait;
use std::path::Path;
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
        wait_for("the run to fire", async || s.get_task(&t.slug).await.unwrap().unwrap().run_count >= n).await;
    }
    wait_for("both runs marked in flight", async || in_flight(&pool).await.len() == 2).await;
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
    wait_for("no run left in flight", async || in_flight(&pool).await.is_empty()).await;
}
