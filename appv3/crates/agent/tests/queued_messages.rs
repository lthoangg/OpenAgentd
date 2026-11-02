//! Queued user messages ("steers") keep the order they were sent in.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Settings are process-wide, so every test shares one set of roots.
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

struct Harness {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    mock: Arc<MockProvider>,
    sid: String,
}

async fn harness(name: &str) -> Harness {
    harness_with(name, uuid::Uuid::now_v7().to_string(), vec![MockProvider::text("First."), MockProvider::text("Second.")], |_, _| vec![]).await
}

async fn harness_with(name: &str, sid: String, turns: Vec<appv3_providers::mock::MockTurn>, tools: impl FnOnce(appv3_db::DbPool, String) -> Vec<Arc<dyn Tool>>) -> Harness {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join(name);
    std::fs::create_dir_all(&ws).unwrap();
    let mock = Arc::new(MockProvider::new(turns));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, name, "You are a test agent.", tools(pool.clone(), sid.clone()), Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    Harness { pool, session, mock, sid }
}

impl Harness {
    async fn send(&self, text: &str) {
        self.session.handle_user_message(UserMessage { content: text.into(), session_id: self.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
        if let Some(mut sub) = store().attach(&self.sid) {
            let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
        }
        tokio::time::timeout(Duration::from_secs(10), self.session.wait_turn_finished()).await.expect("turn finishes");
    }

    /// User texts of the model call at `index`, in the order the model read them.
    fn user_texts(&self, index: usize) -> Vec<String> {
        let calls = self.mock.calls.lock().unwrap();
        let (messages, _, _) = calls.get(index).expect("the model was called");
        messages
            .iter()
            .filter_map(|m| match m {
                ChatMessage::User { content, .. } => content.clone(),
                _ => None,
            })
            .collect()
    }

    /// Visible user rows in transcript order.
    async fn stored_user_texts(&self) -> Vec<String> {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.into_iter().filter(|r| r.role == "user" && r.kind != "note").filter_map(|r| r.content).collect()
    }

    /// Every user row the model reads on later turns (hidden context notes
    /// included), in transcript order.
    async fn stored_model_user_texts(&self) -> Vec<String> {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.into_iter().filter(|r| r.role == "user").filter_map(|r| r.content).collect()
    }

    /// Stored roles in transcript order.
    async fn stored_roles(&self) -> Vec<String> {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.into_iter().map(|r| r.role).collect()
    }
}

/// A tool result must directly follow the assistant message that called it
/// (tool results of the same call may follow each other).
fn tool_results_follow_their_calls<'a>(roles: impl IntoIterator<Item = &'a str>) -> bool {
    let mut prev: Option<&str> = None;
    for role in roles {
        if role == "tool" && !matches!(prev, Some("assistant") | Some("tool")) {
            return false;
        }
        prev = Some(role);
    }
    true
}

/// A turn that fails leaves its unread steers queued. The next message must
/// not overtake them: the model reads them, and the transcript stores them,
/// in send order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_message_does_not_overtake_steers_left_queued() {
    let h = harness("overtake").await;
    h.send("start").await;
    // As after a failed turn: queued, with no turn left to read it.
    appv3_db::save_queued_user_message(&h.pool, &h.sid, "older steer", None).await.unwrap();

    h.send("newer message").await;

    // Consecutive user turns may be merged into one message; order is what counts.
    let read = h.user_texts(1).join("\n\n");
    let (older, newer) = (read.find("older steer").expect("steer read"), read.find("newer message").expect("message read"));
    assert!(older < newer, "the model read the newer message first: {read:?}");
    assert_eq!(h.stored_user_texts().await, ["start", "older steer", "newer message"]);
}

const STEER: &str = "also check @src/a.rs";
const CONTEXT: &str = "<file path=\"src/a.rs\">fn a() {}</file>";

/// While it runs, saves a steer with an @-mention the way the chat route does
/// (`persist_queued_user_message`): a queued row, plus a hidden context row
/// pointing at it.
struct SteerWhileRunning {
    pool: appv3_db::DbPool,
    sid: String,
}

#[async_trait::async_trait]
impl Tool for SteerWhileRunning {
    fn name(&self) -> &str {
        "steer_now"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        let queued = appv3_db::save_queued_user_message(&self.pool, &self.sid, STEER, None).await.unwrap();
        let extra = json!({
            "hidden_from_user": true,
            "hidden_from_summary": true,
            "attachment_for_message_id": appv3_db::codec::api_uuid(&queued.id),
            "mention_context": true,
        });
        let mut ctx = appv3_db::NewMessage::user(CONTEXT.to_string());
        ctx.extra = extra.as_object().cloned();
        appv3_db::save_message(&self.pool, &self.sid, ctx).await.unwrap();
        Ok(ToolOutput::text("ok"))
    }
}

/// A steer read mid-turn reaches the model with the files it mentions, and
/// the transcript keeps that context with it, after the steer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steer_read_mid_turn_brings_its_mention_context() {
    let h = harness_with("mention", uuid::Uuid::now_v7().to_string(), vec![MockProvider::tool_call("call_1", "steer_now", "{}"), MockProvider::text("Done.")], |pool, sid| {
        vec![Arc::new(SteerWhileRunning { pool, sid }) as Arc<dyn Tool>]
    })
    .await;

    h.send("look").await;

    let read = h.user_texts(1).join("\n\n");
    let steer = read.find(STEER).unwrap_or_else(|| panic!("steer not read: {read:?}"));
    let context = read.find(CONTEXT).unwrap_or_else(|| panic!("the steer's context was not read with it: {read:?}"));
    assert!(steer < context, "context read before its steer: {read:?}");
    let sent_roles: Vec<&str> = {
        let calls = h.mock.calls.lock().unwrap();
        calls[1]
            .0
            .iter()
            .map(|m| match m {
                ChatMessage::System { .. } => "system",
                ChatMessage::User { .. } => "user",
                ChatMessage::Assistant(_) => "assistant",
                ChatMessage::Tool { .. } => "tool",
            })
            .collect()
    };
    assert!(tool_results_follow_their_calls(sent_roles.iter().copied()), "a user message split a tool call from its result: {sent_roles:?}");

    // The context stays hidden in the transcript, and later turns read it right after the steer.
    assert_eq!(h.stored_user_texts().await, ["look", STEER]);
    assert_eq!(h.stored_model_user_texts().await, ["look", STEER, CONTEXT]);
    let roles = h.stored_roles().await;
    assert!(tool_results_follow_their_calls(roles.iter().map(String::as_str)), "a stored user row split a tool call from its result: {roles:?}");
}

/// A sender queues behind a turn it sees running, under the session's
/// `user_message_lock`, and leaves the row for that turn. A turn finishing at
/// that moment has already made its last check of the queue, so it may only
/// read as idle under the same lock, after looking again: otherwise the row
/// waits for the next message (a subagent's report delivered as its lead's
/// turn closed sat queued for good).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_queued_as_the_turn_finishes_still_runs() {
    let h = harness("queued_at_turn_end").await;
    let sender = h.session.user_message_lock.lock().await;
    h.session.handle_user_message(UserMessage { content: "first".into(), session_id: h.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while h.mock.calls.lock().unwrap().is_empty() {
        assert!(std::time::Instant::now() < deadline, "the first turn never called the model");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Well past the turn's own last look at the queue.
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert!(h.session.has_active_user_turn(), "the turn read as idle while a sender held the lock");
    appv3_db::save_queued_user_message(&h.pool, &h.sid, "late", None).await.unwrap();
    drop(sender);

    tokio::time::timeout(Duration::from_secs(10), async {
        while h.mock.calls.lock().unwrap().len() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the late row started a turn");
    tokio::time::timeout(Duration::from_secs(10), h.session.wait_turn_finished()).await.expect("turn finishes");
    assert!(h.user_texts(1).iter().any(|t| t.contains("late")), "{:?}", h.user_texts(1));
    assert!(!appv3_db::has_queued_user_messages(&h.pool, &h.sid).await.unwrap(), "a row was left queued");
}
