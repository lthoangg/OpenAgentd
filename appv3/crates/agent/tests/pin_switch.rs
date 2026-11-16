//! An account picked while a turn runs serves the turn's next model call,
//! not only the next turn: a long run would otherwise stay on the account
//! the user is trying to leave. Its own binary: the env and the credential
//! store are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_core::credentials as cstore;
use appv3_providers::mock::MockProvider;
use appv3_providers::pool::PIN_KWARG;
use appv3_providers::{ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderResult, ToolSpec};
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Picks an account the way the composer does: only the session row changes.
struct PickAccount {
    pool: appv3_db::DbPool,
    sid: String,
    id: String,
}

#[async_trait::async_trait]
impl Tool for PickAccount {
    fn name(&self) -> &str {
        "pick_account"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        let upd = appv3_db::SessionUpdate { credential_id: Some(Some(self.id.clone())), ..Default::default() };
        appv3_db::update_session(&self.pool, &self.sid, upd).await.unwrap();
        Ok(ToolOutput::text("ok"))
    }
}

/// A provider pinned to one account, naming it as the credential pool does
/// (`served_credential`), so the transcript can say which account answered.
struct OnAccount {
    inner: Arc<MockProvider>,
    id: String,
    label: String,
}

#[async_trait::async_trait]
impl LlmProvider for OnAccount {
    fn model(&self) -> &str {
        self.inner.model()
    }
    fn provider_name(&self) -> Option<&str> {
        self.inner.provider_name()
    }
    fn base_kwargs(&self) -> &Kwargs {
        self.inner.base_kwargs()
    }
    async fn chat(&self, m: &[ChatMessage], t: Option<&[ToolSpec]>, kw: &Kwargs) -> ProviderResult<appv3_providers::AssistantMessage> {
        self.inner.chat(m, t, kw).await
    }
    async fn stream(&self, m: &[ChatMessage], t: Option<&[ToolSpec]>, kw: &Kwargs) -> ProviderResult<ChunkStream> {
        self.inner.stream(m, t, kw).await
    }
    fn served_credential(&self) -> Option<(String, String)> {
        Some((self.id.clone(), self.label.clone()))
    }
    fn pinned_credential(&self) -> Option<String> {
        Some(self.label.clone())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_account_picked_mid_turn_serves_the_next_call() {
    let root = tempfile::tempdir().unwrap();
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.path().join(d));
    }
    std::env::set_var("HOME", root.path().join("home"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let work = cstore::update(|f| {
        let mut c = cstore::Credential::new("Work");
        c.values.insert("ROUTER9_API_KEY".into(), "work-key".into());
        f.provider_mut("router9").push(c.clone());
        c.id
    })
    .unwrap();

    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let sid = uuid::Uuid::now_v7().to_string();
    // The turn starts on the agent's own provider (no pin yet).
    let agent_mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("c1", "pick_account", "{}"), MockProvider::text("old account")]));
    let built: Arc<Mutex<HashMap<Option<String>, Arc<MockProvider>>>> = Arc::default();
    let b2 = built.clone();
    let factory: ProviderFactory = Arc::new(move |_m, kw| {
        let pin = kw.get(PIN_KWARG).and_then(|v| v.as_str()).map(String::from);
        let p = b2.lock().unwrap().entry(pin.clone()).or_insert_with(|| Arc::new(MockProvider::new(vec![MockProvider::text("new account")]))).clone();
        Ok(match pin {
            Some(id) => Arc::new(OnAccount { inner: p, id, label: "Work".into() }) as Arc<dyn LlmProvider>,
            None => p as Arc<dyn LlmProvider>,
        })
    });
    let tool: Arc<dyn Tool> = Arc::new(PickAccount { pool: pool.clone(), sid: sid.clone(), id: work.clone() });
    let agent = Agent::new(agent_mock.clone(), "code", "You are a test agent.", vec![tool], Some("router9:m".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);

    session.handle_user_message(UserMessage { content: "go".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    if let Some(mut sub) = store().attach(&sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("turn finishes");

    assert_eq!(agent_mock.calls.lock().unwrap().len(), 1, "the call after the pick still went to the old account");
    let calls = built.lock().unwrap().get(&Some(work.clone())).map(|p| p.calls.lock().unwrap().len()).unwrap_or(0);
    assert_eq!(calls, 1, "the picked account was not called");

    // The reply names the account that answered (what the composer chip
    // shows as in use) and the session names its lock (what the tray shows).
    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let last = rows.iter().rev().find(|r| r.role == "assistant").expect("an assistant row");
    assert_eq!(last.content.as_deref(), Some("new account"));
    let extra = last.extra_json().unwrap_or_default();
    assert_eq!((extra["credential_id"].as_str(), extra["credential_label"].as_str()), (Some(work.as_str()), Some("Work")));
    let row = appv3_db::get_session(&pool, &sid).await.unwrap().unwrap();
    assert_eq!(row.credential_id.as_deref().and_then(appv3_providers::pool::credential_label_by_id).as_deref(), Some("Work"));
}
