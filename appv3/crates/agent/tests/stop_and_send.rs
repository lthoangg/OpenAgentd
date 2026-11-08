//! Stop & send: a stop that lands mid-tool must not strand the message sent
//! right after it, nor put unread steers before the stopped tool's result.
//!
//! The tool here winds down slowly when cancelled (as a shell tool draining
//! stdout and reaping its process does), so the stopped turn is still active
//! for a while after `handle_stop` returns. Its own binary: the env and
//! settings are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::service;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::{Tool, ToolContext, ToolResult};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

/// How long the cancelled tool takes to wind down.
const WIND_DOWN: Duration = Duration::from_millis(500);

fn root() -> &'static Path {
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

/// Blocks its thread while dropped: the cancelled call's slow cleanup.
struct SlowCleanup;

impl Drop for SlowCleanup {
    fn drop(&mut self) {
        std::thread::sleep(WIND_DOWN);
    }
}

/// Streams a line, says it started, then runs until it is cancelled.
struct LongBuild {
    started: Arc<Notify>,
}

#[async_trait::async_trait]
impl Tool for LongBuild {
    fn name(&self) -> &str {
        "long_build"
    }
    async fn run(&self, ctx: &ToolContext, _args: Value) -> ToolResult {
        let _cleanup = SlowCleanup;
        if let Some(out) = ctx.output.clone() {
            out("compiling\n".into());
        }
        self.started.notify_one();
        std::future::pending().await
    }
}

struct Harness {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    mock: Arc<MockProvider>,
    started: Arc<Notify>,
    sid: String,
}

async fn harness(name: &str) -> Harness {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join(name);
    std::fs::create_dir_all(&ws).unwrap();
    let mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_1", "long_build", "{}"), MockProvider::text("Answer.")]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let started = Arc::new(Notify::new());
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(LongBuild { started: started.clone() })];
    let agent = Agent::new(provider, name, "You are a test agent.", tools, Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    Harness { pool, session, mock, started, sid: uuid::Uuid::now_v7().to_string() }
}

impl Harness {
    async fn send(&self, text: &str) {
        self.session.handle_user_message(UserMessage { content: text.into(), session_id: self.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    }

    /// Start a turn and return once its tool is running.
    async fn start_build(&self) {
        self.send("build").await;
        tokio::time::timeout(Duration::from_secs(10), self.started.notified()).await.expect("the tool starts");
    }

    async fn turn_finished(&self) {
        tokio::time::timeout(Duration::from_secs(10), self.session.wait_turn_finished()).await.expect("turn finishes");
    }

    /// Stored rows as `(role, content)`, in transcript order.
    async fn rows(&self) -> Vec<(String, String)> {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.into_iter().filter(|r| r.kind != "note").map(|r| (r.role, r.content.unwrap_or_default())).collect()
    }

    /// Whether any model call read `text` from the user.
    fn model_read(&self, text: &str) -> bool {
        self.mock.calls.lock().unwrap().iter().any(|(messages, _, _)| messages.iter().any(|m| matches!(m, ChatMessage::User { content: Some(c), .. } if c.contains(text))))
    }
}

/// After an interrupt returns, the stopped turn is over: a message sent next
/// starts its own turn rather than queueing behind a turn that never runs it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_then_send_starts_a_turn_mid_tool() {
    let h = harness("stop_send").await;
    h.start_build().await;

    service::interrupt_agent(&h.session, Some(&h.sid)).await;
    // The chat route queues a message while this is true.
    assert!(!h.session.has_active_user_turn(), "the interrupt returned while the stopped turn was still running");

    h.send("next").await;
    h.turn_finished().await;

    assert!(h.model_read("next"), "the model never read the message sent after the stop");
    assert!(!appv3_db::has_queued_user_messages(&h.pool, &h.sid).await.unwrap(), "a message was left queued");
    let rows = h.rows().await;
    let users: Vec<&str> = rows.iter().filter(|(r, _)| r == "user").map(|(_, c)| c.as_str()).collect();
    assert_eq!(users, ["build", "next"]);
    assert_eq!(rows.last().map(|(r, _)| r.as_str()), Some("assistant"), "{rows:?}");
}

/// Unread steers released by a stop go after the stopped turn, not between
/// the tool call and its (cancelled) result.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn steers_released_by_stop_follow_the_stopped_turn() {
    let h = harness("stop_steer").await;
    h.start_build().await;
    appv3_db::save_queued_user_message(&h.pool, &h.sid, "steer", None).await.unwrap();

    service::interrupt_agent(&h.session, Some(&h.sid)).await;
    h.turn_finished().await;

    let rows = h.rows().await;
    let roles: Vec<&str> = rows.iter().map(|(r, _)| r.as_str()).collect();
    let tool = roles.iter().position(|r| *r == "tool").unwrap_or_else(|| panic!("no tool result stored: {rows:?}"));
    let steer = rows.iter().position(|(r, c)| r == "user" && c == "steer").unwrap_or_else(|| panic!("steer not released: {rows:?}"));
    assert!(tool < steer, "the steer landed before the stopped tool's result: {rows:?}");
    assert_eq!(roles[tool - 1], "assistant", "the tool result does not follow its call: {rows:?}");
}

/// A message queued while a stop is still winding down runs once it ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_while_stopping_still_runs() {
    let h = harness("stop_queue").await;
    h.start_build().await;

    assert!(h.session.handle_stop().await);
    assert!(h.session.is_stopping(), "the stopped turn ended before the test could queue");
    appv3_db::save_queued_user_message(&h.pool, &h.sid, "queued after stop", None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), service::activate_queued_after_stop(h.session.clone(), h.sid.clone())).await.expect("activation runs");
    h.turn_finished().await;

    assert!(h.model_read("queued after stop"), "the queued message never ran");
    assert!(!appv3_db::has_queued_user_messages(&h.pool, &h.sid).await.unwrap());
}

/// `wait_for_stop` reports whether the stopped turn ended within the limit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_for_stop_reports_whether_the_turn_ended() {
    let h = harness("stop_wait").await;
    h.start_build().await;

    assert!(h.session.handle_stop().await);
    assert_eq!(h.session.state(), "idle", "Stop changes the display before the task has drained");
    assert!(h.session.is_busy(), "the stopped task still owns execution");
    assert!(h.session.has_active_user_turn());
    assert!(h.session.is_stopping());
    assert!(!h.session.wait_for_stop(Duration::from_millis(50)).await, "the turn ended before its tool wound down");
    assert!(h.session.wait_for_stop(Duration::from_secs(5)).await);
    assert!(!h.session.is_stopping());
    assert!(!h.session.is_busy());
    assert!(!h.session.has_active_user_turn());
    assert!(h.session.is_cancelled(), "cancellation may remain set after ownership is released");
}
