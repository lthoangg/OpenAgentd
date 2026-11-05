//! A steer sent with another model or thinking level switches the running
//! turn to it from the model call that reads the steer, not the next turn.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Every log line of this test binary.
fn logs() -> &'static Arc<Mutex<Vec<u8>>> {
    static LOGS: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();
    LOGS.get_or_init(|| {
        let buf: Arc<Mutex<Vec<u8>>> = Arc::default();
        let b = buf.clone();
        let sub = tracing_subscriber::fmt().with_ansi(false).with_max_level(tracing::Level::INFO).with_writer(move || LogWriter(b.clone())).finish();
        let _ = tracing::subscriber::set_global_default(sub);
        buf
    })
}

struct LogWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn root() -> &'static Path {
    logs();
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
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
        root
    })
    .path()
}

/// Sends a steer the way the chat route does (`persist_queued_user_message`):
/// the session row takes the new settings and the queued row records them.
struct SteerWith {
    pool: appv3_db::DbPool,
    sid: String,
    model: Option<&'static str>,
    thinking: Option<&'static str>,
}

#[async_trait::async_trait]
impl Tool for SteerWith {
    fn name(&self) -> &str {
        "steer_now"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        let upd = appv3_db::SessionUpdate { model: Some(self.model.map(String::from)), thinking_level: Some(self.thinking.map(String::from)), ..Default::default() };
        appv3_db::update_session(&self.pool, &self.sid, upd).await.unwrap();
        let mut extra = serde_json::Map::new();
        extra.insert("model".into(), json!(self.model.unwrap_or("mock:a")));
        if let Some(t) = self.thinking {
            extra.insert("thinking_level".into(), json!(t));
        }
        appv3_db::save_queued_user_message(&self.pool, &self.sid, "steer", Some(extra)).await.unwrap();
        Ok(ToolOutput::text("ok"))
    }
}

type Built = Arc<Mutex<HashMap<(String, Option<String>), Arc<MockProvider>>>>;

struct Run {
    pool: appv3_db::DbPool,
    sid: String,
    agent_mock: Arc<MockProvider>,
    built: Built,
}

/// Runs one turn on `mock:a`: it calls `steer_now` (which steers with
/// `model`/`thinking`), then answers.
async fn run(name: &str, model: Option<&'static str>, thinking: Option<&'static str>) -> Run {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join(name);
    std::fs::create_dir_all(&ws).unwrap();
    let sid = uuid::Uuid::now_v7().to_string();
    let agent_mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("c1", "steer_now", "{}"), MockProvider::text("old settings")]));
    let built: Built = Arc::default();
    let b2 = built.clone();
    let factory: ProviderFactory = Arc::new(move |m, kw| {
        let key = (m.unwrap_or_default().to_string(), kw.get("thinking_level").and_then(|v| v.as_str()).map(String::from));
        let p = b2.lock().unwrap().entry(key).or_insert_with(|| Arc::new(MockProvider::new(vec![MockProvider::text("new settings")]))).clone();
        Ok(p as Arc<dyn LlmProvider>)
    });
    let tool: Arc<dyn Tool> = Arc::new(SteerWith { pool: pool.clone(), sid: sid.clone(), model, thinking });
    let agent = Agent::new(agent_mock.clone(), name, "You are a test agent.", vec![tool], Some("mock:a".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    session.handle_user_message(UserMessage { content: "go".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    if let Some(mut sub) = store().attach(&sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("turn finishes");
    Run { pool, sid, agent_mock, built }
}

impl Run {
    fn calls_to(&self, model: &str, thinking: Option<&str>) -> usize {
        self.built.lock().unwrap().get(&(model.to_string(), thinking.map(String::from))).map(|p| p.calls.lock().unwrap().len()).unwrap_or(0)
    }
    async fn last_assistant(&self) -> (Option<String>, Option<String>, Option<String>) {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        let last = rows.iter().rev().find(|r| r.role == "assistant").expect("an assistant row");
        let e = last.extra_json().unwrap_or_default();
        let s = |k: &str| e.get(k).and_then(|v| v.as_str()).map(String::from);
        (last.content.clone(), s("model"), s("thinking_level"))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steer_with_another_model_switches_the_running_turn() {
    let r = run("switch_model", Some("mock:b"), Some("low")).await;
    assert_eq!(r.agent_mock.calls.lock().unwrap().len(), 1, "the call reading the steer still went to the old model");
    assert_eq!(r.calls_to("mock:b", Some("low")), 1, "the new model was not called");
    assert_eq!(r.last_assistant().await, (Some("new settings".into()), Some("mock:b".into()), Some("low".into())));
    let logs = String::from_utf8_lossy(&logs().lock().unwrap()).to_string();
    let line = format!("steer_model_switched session_id={} from=mock:a to=mock:b thinking=low", r.sid);
    assert!(logs.contains(&line), "missing log line {line:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steer_with_another_thinking_level_switches_the_running_turn() {
    let r = run("switch_thinking", Some("mock:a"), Some("low")).await;
    assert_eq!(r.agent_mock.calls.lock().unwrap().len(), 1, "the call reading the steer kept the old thinking level");
    assert_eq!(r.calls_to("mock:a", Some("low")), 1);
    assert_eq!(r.last_assistant().await, (Some("new settings".into()), Some("mock:a".into()), Some("low".into())));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steer_with_the_same_settings_keeps_the_provider() {
    let r = run("switch_none", None, None).await;
    assert_eq!(r.agent_mock.calls.lock().unwrap().len(), 2);
    assert!(r.built.lock().unwrap().is_empty(), "a provider was rebuilt for unchanged settings");
}
