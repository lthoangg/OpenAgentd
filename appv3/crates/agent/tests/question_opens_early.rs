//! `ask_user` beside other tool calls: the question opens before those
//! calls run, so the user can answer while they work. The turn pauses only
//! if the question is still open when they finish. Its own binary: the env
//! and settings are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::service;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

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

/// Says it started, then runs until the test lets it finish.
struct SlowBuild {
    started: Arc<Notify>,
    finish: Arc<Notify>,
}

#[async_trait::async_trait]
impl Tool for SlowBuild {
    fn name(&self) -> &str {
        "slow_build"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        self.started.notify_one();
        self.finish.notified().await;
        Ok(ToolOutput::text("build ok"))
    }
}

struct Harness {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    mock: Arc<MockProvider>,
    finish: Arc<Notify>,
    sid: String,
}

const ASK: &str = r#"{"questions":[{"question":"Which file?","header":"File"}]}"#;

/// A turn whose reply calls the slow tool and asks a question; returns once
/// the slow tool is running.
async fn harness(name: &str) -> Harness {
    harness_with(name, &[("build_1", "slow_build", "{}"), ("ask_1", "ask_user", ASK)]).await
}

/// [`harness`] with the first reply's tool calls given.
async fn harness_with(name: &str, calls: &[(&str, &str, &str)]) -> Harness {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join(name);
    std::fs::create_dir_all(&ws).unwrap();
    let mock = Arc::new(MockProvider::new(vec![MockProvider::tool_calls(calls), MockProvider::text("Done."), MockProvider::text("Later.")]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let (started, finish) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(SlowBuild { started: started.clone(), finish: finish.clone() })];
    let agent = Agent::new(provider, name, "You are a test agent.", tools, Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "build it".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), started.notified()).await.expect("the slow tool starts");
    Harness { pool, session, mock, finish, sid }
}

impl Harness {
    async fn open_question(&self) -> Option<appv3_db::PendingQuestion> {
        appv3_db::get_pending_question(&self.pool, &self.sid).await.unwrap()
    }

    async fn turn_finished(&self) {
        tokio::time::timeout(Duration::from_secs(10), self.session.wait_turn_finished()).await.expect("the turn finishes or suspends");
    }

    fn model_calls(&self) -> usize {
        self.mock.calls.lock().unwrap().len()
    }

    /// Tool results the model read in call `call`, as `(tool_call_id, content)`.
    fn tool_results(&self, call: usize) -> Vec<(String, String)> {
        self.mock.calls.lock().unwrap()[call]
            .0
            .iter()
            .filter_map(|m| match m {
                ChatMessage::Tool { tool_call_id, content, .. } => Some((tool_call_id.clone(), content.clone().unwrap_or_default())),
                _ => None,
            })
            .collect()
    }

    fn user_texts(&self, call: usize) -> Vec<String> {
        self.mock.calls.lock().unwrap()[call]
            .0
            .iter()
            .filter_map(|m| match m {
                ChatMessage::User { content, .. } => content.clone(),
                _ => None,
            })
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_question_is_open_while_the_other_tool_still_runs() {
    let h = harness("opens_early").await;

    let question = h.open_question().await.expect("the question opened before the slow tool finished");
    assert_eq!(question.tool_call_id, "ask_1");
    assert_eq!(h.session.state(), "working");

    // Unanswered when the tool finishes: the turn pauses, as before.
    h.finish.notify_one();
    h.turn_finished().await;
    assert_eq!(h.session.state(), "waiting_input");
    assert_eq!(h.model_calls(), 1);

    h.session.handle_question_answer(&question.id, &json!([["src/main.rs"]])).await.unwrap();
    h.turn_finished().await;
    assert_eq!(h.model_calls(), 2);
    let results = h.tool_results(1);
    assert!(results.iter().any(|(id, c)| id == "build_1" && c == "build ok"), "{results:?}");
    assert!(results.iter().any(|(id, c)| id == "ask_1" && c.contains("src/main.rs")), "{results:?}");
    assert_eq!(h.session.state(), "idle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_given_while_the_tool_runs_continues_the_turn_once() {
    let h = harness("answered_early").await;
    let question = h.open_question().await.expect("the question is open");

    h.session.handle_question_answer(&question.id, &json!([["src/main.rs"]])).await.unwrap();

    // The running turn takes the answer; no second turn starts beside it.
    assert_eq!(h.model_calls(), 1, "the answer started a turn while the tool was still running");
    assert_eq!(h.session.state(), "working");

    h.finish.notify_one();
    h.turn_finished().await;
    assert_eq!(h.model_calls(), 2, "the turn did not continue with the answer");
    let results = h.tool_results(1);
    assert!(results.iter().any(|(id, c)| id == "build_1" && c == "build ok"), "{results:?}");
    assert!(results.iter().any(|(id, c)| id == "ask_1" && c.contains("src/main.rs")), "{results:?}");
    assert_eq!(h.session.state(), "idle", "the turn paused on a question that was already answered");
    assert!(h.open_question().await.is_none());
}

/// The answer is stored just as the tool finishes, and the route's resume
/// call arrives only after the turn has continued and ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resume_that_arrives_after_the_turn_continued_starts_nothing() {
    let h = harness("late_resume").await;
    let question = h.open_question().await.expect("the question is open");
    appv3_db::resolve_pending_question(&h.pool, &question.id, "answered", Some(&json!([["src/main.rs"]]))).await.unwrap().expect("the answer is stored");

    h.finish.notify_one();
    h.turn_finished().await;
    assert_eq!(h.model_calls(), 2);

    h.session.resume_after_answer(&question.id).await;
    h.turn_finished().await;

    assert_eq!(h.model_calls(), 2, "one answer continued the turn twice");
    assert_eq!(h.session.state(), "idle");
}

/// A message sent instead of an answer supersedes the question; the message
/// then runs as the next turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_question_superseded_while_the_tool_runs_does_not_pause_the_turn() {
    let h = harness("superseded_early").await;
    assert!(h.open_question().await.is_some());

    h.session.dismiss_pending_question("superseded", None).await;
    appv3_db::save_queued_user_message(&h.pool, &h.sid, "use lib.rs", None).await.unwrap();
    h.finish.notify_one();
    h.turn_finished().await;

    assert_eq!(h.session.state(), "idle", "the turn paused on a superseded question");
    assert_eq!(h.model_calls(), 2);
    assert!(h.user_texts(1).iter().any(|c| c.contains("use lib.rs")));
    let results = h.tool_results(1);
    assert!(results.iter().any(|(id, c)| id == "ask_1" && c.starts_with("Superseded")), "{results:?}");
    assert!(results.iter().any(|(id, c)| id == "build_1" && c == "build ok"), "{results:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_while_the_tool_runs_dismisses_the_open_question() {
    let h = harness("stopped_early").await;
    let question = h.open_question().await.expect("the question is open");

    service::interrupt_agent(&h.session, Some(&h.sid)).await;

    assert!(h.open_question().await.is_none(), "the question stayed open after Stop");
    let row = appv3_db::get_question(&h.pool, &question.id).await.unwrap().expect("row kept");
    assert_eq!(row.status, "dismissed");
    assert_eq!(h.session.state(), "idle");
    assert_eq!(h.model_calls(), 1);
}

/// The stored rows keep each tool result right after the assistant message
/// that called it, so the history replays as a valid tool exchange.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_question_row_stays_paired_with_its_call() {
    let h = harness("row_order").await;
    h.finish.notify_one();
    h.turn_finished().await;

    let rows = appv3_db::llm_window_rows(&h.pool, &h.sid, false).await.unwrap();
    let shape: Vec<(String, Option<String>)> = rows.into_iter().filter(|r| r.kind != "note").map(|r| (r.role, r.tool_call_id)).collect();
    assert_eq!(
        shape,
        [("user".to_string(), None), ("assistant".to_string(), None), ("tool".to_string(), Some("ask_1".to_string())), ("tool".to_string(), Some("build_1".to_string())),]
    );
}

/// Two `ask_user` calls in one reply still open one card, now at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_questions_open_early_as_one_card() {
    let other = r#"{"questions":[{"question":"Which branch?","header":"Branch"}]}"#;
    let h = harness_with("merged_early", &[("ask_1", "ask_user", ASK), ("build_1", "slow_build", "{}"), ("ask_2", "ask_user", other)]).await;

    let question = h.open_question().await.expect("the question is open");
    let asked: Vec<String> = question.questions().iter().map(|q| q["question"].as_str().unwrap_or_default().to_string()).collect();
    assert_eq!(asked, ["Which file?", "Which branch?"]);

    h.session.handle_question_answer(&question.id, &json!([["src/main.rs"], ["main"]])).await.unwrap();
    h.finish.notify_one();
    h.turn_finished().await;

    assert_eq!(h.model_calls(), 2);
    let results = h.tool_results(1);
    assert!(results.iter().any(|(id, c)| id == "ask_1" && c.contains("src/main.rs") && c.contains("main")), "{results:?}");
    assert!(results.iter().any(|(id, c)| id == "ask_2" && c.starts_with("Merged into your other ask_user call")), "{results:?}");
    assert_eq!(h.session.state(), "idle");
}
