//! Resolving a question is a guarded handoff: an old answer or dismissal
//! cannot resume execution again or change a newer pending interaction.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::LlmProvider;
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

fn root() -> &'static Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        for (key, directory) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ] {
            std::env::set_var(key, root.path().join(directory));
        }
        std::env::set_var("HOME", root.path().join("home"));
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        root
    })
    .path()
}

fn ask(id: &str) -> MockTurn {
    MockProvider::tool_call(id, "ask_user", r#"{"questions":[{"question":"Which file?","header":"File"}]}"#)
}

struct Harness {
    session: Arc<AgentSession>,
    pool: appv3_db::DbPool,
    provider: Arc<MockProvider>,
    sid: String,
}

impl Harness {
    async fn new(name: &str, turns: Vec<MockTurn>) -> Self {
        let pool = appv3_db::create_pool(root().join(format!("{name}.db"))).await.unwrap();
        let workspace = root().join(name);
        std::fs::create_dir_all(&workspace).unwrap();
        let provider = Arc::new(MockProvider::new(turns));
        let llm: Arc<dyn LlmProvider> = provider.clone();
        let shared = llm.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(shared.clone()));
        let agent = Agent::new(llm, name, "You are a test agent.", vec![], Some("mock:mock".into()));
        let session = AgentSession::new(agent, None, Some(workspace.display().to_string()), pool.clone(), factory, None);
        let sid = uuid::Uuid::now_v7().to_string();
        session.handle_user_message(UserMessage { content: "pick one".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
        let h = Self { session, pool, provider, sid };
        h.finished().await;
        h
    }

    async fn finished(&self) {
        tokio::time::timeout(Duration::from_secs(10), self.session.wait_turn_finished()).await.expect("the turn finishes or suspends");
    }

    async fn pending(&self) -> appv3_db::PendingQuestion {
        appv3_db::get_pending_question(&self.pool, &self.sid).await.unwrap().expect("a question is open")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answering_an_already_resolved_question_does_not_start_another_turn() {
    let h = Harness::new("duplicate_answer", vec![ask("ask_1"), MockProvider::text("Done.")]).await;
    let question = h.pending().await;
    let answers = json!([["src/main.rs"]]);
    h.session.handle_question_answer(&question.id, &answers).await.unwrap();
    h.finished().await;
    assert_eq!(h.provider.calls.lock().unwrap().len(), 2);

    h.session.handle_question_answer(&question.id, &answers).await.unwrap();
    h.finished().await;

    assert_eq!(h.provider.calls.lock().unwrap().len(), 2, "only the successful pending-row claimant may resume");
    assert!(appv3_db::get_pending_question(&h.pool, &h.sid).await.unwrap().is_none());
}

/// "Queue until done" sent while a question waits (the chat route queues it
/// held): answering resumes the turn without it, then it runs as its own turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_held_during_a_question_runs_after_the_answer() {
    let h = Harness::new("held_during_question", vec![ask("ask_1"), MockProvider::text("Done."), MockProvider::text("Deployed.")]).await;
    let question = h.pending().await;
    let mut extra = serde_json::Map::new();
    extra.insert(appv3_db::HOLD_UNTIL_TURN_END.into(), json!(true));
    appv3_db::save_queued_user_message(&h.pool, &h.sid, "then deploy", Some(extra)).await.unwrap();
    assert_eq!(h.session.state(), "waiting_input", "queuing it left the question open");

    h.session.handle_question_answer(&question.id, &json!([["src/main.rs"]])).await.unwrap();
    h.finished().await;

    let users = |call: usize| -> Vec<String> {
        h.provider.calls.lock().unwrap()[call]
            .0
            .iter()
            .filter_map(|m| match m {
                appv3_providers::ChatMessage::User { content, .. } => content.clone(),
                _ => None,
            })
            .collect()
    };
    assert_eq!(h.provider.calls.lock().unwrap().len(), 3, "the held message never got a turn");
    assert!(!users(1).iter().any(|c| c.contains("then deploy")), "the resumed turn read the held message");
    assert!(users(2).iter().any(|c| c.contains("then deploy")));
    assert!(!appv3_db::has_queued_user_messages(&h.pool, &h.sid).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dismissing_an_old_question_does_not_hide_a_new_question() {
    let h = Harness::new("stale_dismiss", vec![ask("ask_1"), ask("ask_2")]).await;
    let old = h.pending().await;
    h.session.handle_question_answer(&old.id, &json!([["src/main.rs"]])).await.unwrap();
    h.finished().await;
    let current = h.pending().await;
    assert_ne!(old.id, current.id);
    assert_eq!(h.session.state(), "waiting_input");

    h.session.handle_question_dismiss(&old.id, "dismissed").await.unwrap();

    assert_eq!(h.session.state(), "waiting_input", "an old resolution cannot change the current interaction");
    assert_eq!(h.pending().await.id, current.id);
}
