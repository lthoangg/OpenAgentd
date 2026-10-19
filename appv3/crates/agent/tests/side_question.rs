//! `/btw` side questions: answered from the session's context with the
//! turn's own request frame, stored beside the session, never in it.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{side_question, Agent, Envelope};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatCompletionChunk, ChatCompletionDelta, ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderError, ProviderResult, ToolSpec};
use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

fn setup_env(root: &Path) {
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
    std::fs::create_dir_all(root.join("config")).unwrap();
}

fn session_with(pool: &appv3_db::DbPool, ws: &Path, provider: Arc<dyn LlmProvider>) -> Arc<AgentSession> {
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, "code", "You are a test agent.", vec![], Some("mock:mock".into()));
    AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None)
}

async fn turn(session: &AgentSession, sid: &str, text: &str) {
    session.handle_user_message(UserMessage { content: text.into(), session_id: sid.into(), origin: "user".into(), ..Default::default() }).await.unwrap();
    session.wait_turn_finished().await;
}

async fn drain(mut ask: side_question::SideAsk) -> Vec<Envelope> {
    let mut out = vec![];
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(e) = ask.events.recv().await {
            out.push(e);
        }
    })
    .await
    .expect("side question finished");
    out
}

async fn message_count(pool: &appv3_db::DbPool, sid: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM session_messages WHERE session_id = ?").bind(appv3_db::codec::db_id(sid)).fetch_one(pool).await.unwrap()
}

async fn row(pool: &appv3_db::DbPool, sid: &str, id: &str) -> appv3_db::SideQuestion {
    side_question::list(pool, sid, 100).await.unwrap().into_iter().find(|r| appv3_db::codec::api_uuid(&r.id) == id).expect("row")
}

async fn wait_status(pool: &appv3_db::DbPool, sid: &str, id: &str, status: &str) -> appv3_db::SideQuestion {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let r = appv3_db::list_side_questions(pool, sid, 100).await.unwrap().into_iter().find(|r| appv3_db::codec::api_uuid(&r.id) == id).unwrap();
            if r.status == status {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("side question never became {status}"))
}

/// Streams one chunk, then waits until the request is dropped.
struct Hanging;

#[async_trait]
impl LlmProvider for Hanging {
    fn model(&self) -> &str {
        "hang"
    }
    fn provider_name(&self) -> Option<&str> {
        Some("mock")
    }
    fn base_kwargs(&self) -> &Kwargs {
        static K: std::sync::OnceLock<Kwargs> = std::sync::OnceLock::new();
        K.get_or_init(Kwargs::new)
    }
    async fn chat(&self, _m: &[ChatMessage], _t: Option<&[ToolSpec]>, _k: &Kwargs) -> ProviderResult<appv3_providers::AssistantMessage> {
        Err(ProviderError::Other("unused".into()))
    }
    async fn stream(&self, _m: &[ChatMessage], _t: Option<&[ToolSpec]>, _k: &Kwargs) -> ProviderResult<ChunkStream> {
        let first = ChatCompletionChunk::delta("h", "hang", ChatCompletionDelta { content: Some("Partly".into()), ..Default::default() }, None, None);
        Ok(Box::pin(futures::stream::iter([Ok(first)]).chain(futures::stream::pending())))
    }
}

use futures::StreamExt;

/// One test so the process-wide settings and env are not shared across threads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_questions_answer_from_the_turn_frame_and_stay_out_of_the_transcript() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();

    // ── after a turn: the recorded frame, the history, then the question ──
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Changed config.yaml."), MockProvider::text("It was config.yaml."), MockProvider::text("Yes.")]));
    let s = session_with(&pool, &ws, provider.clone());
    let sid = uuid::Uuid::now_v7().to_string();
    turn(&s, &sid, "fix config").await;
    let before = message_count(&pool, &sid).await;

    let ask = s.ask_side_question(&sid, "which file was it?").await.unwrap();
    let id = ask.id.clone();
    let events = drain(ask).await;
    let names: Vec<&str> = events.iter().map(|e| e.event.as_str()).collect();
    assert_eq!(names, ["btw_start", "btw_delta", "btw_done"]);
    assert_eq!(events[2].str_field("answer"), Some("It was config.yaml."));
    let done = row(&pool, &sid, &id).await;
    assert_eq!((done.status.as_str(), done.answer.as_str()), ("done", "It was config.yaml."));
    assert!(done.usage.is_some());
    assert_eq!(message_count(&pool, &sid).await, before, "side question entered the transcript");

    let calls = provider.calls.lock().unwrap().clone();
    let (turn_msgs, turn_tools, _) = &calls[0];
    let (btw_msgs, btw_tools, btw_kw) = &calls[1];
    assert_eq!(btw_msgs[0].content(), turn_msgs[0].content(), "system prompt differs from the turn's");
    assert!(matches!(btw_msgs[0], ChatMessage::System { .. }));
    assert_eq!(btw_tools, turn_tools, "tools differ from the turn's");
    assert!(btw_tools.as_ref().is_some_and(|t| !t.is_empty()));
    assert!(!btw_kw.contains_key("tool_choice"), "tool_choice would invalidate the cached messages");
    assert!(btw_msgs.iter().any(|m| m.content() == Some("fix config")));
    assert!(btw_msgs.last().unwrap().content().unwrap().ends_with("Side question: which file was it?"));

    // ── a second one replays the first; dropping the stream still stores it ──
    let ask = s.ask_side_question(&sid, "sure?").await.unwrap();
    let id2 = ask.id.clone();
    drop(ask);
    let second = wait_status(&pool, &sid, &id2, "done").await;
    assert_eq!(second.answer, "Yes.");
    let calls = provider.calls.lock().unwrap().clone();
    let texts: Vec<&str> = calls[2].0.iter().filter_map(|m| m.content()).collect();
    let at = texts.iter().position(|t| *t == "[Side question] which file was it?").expect("earlier side question replayed");
    assert_eq!(texts[at + 1], "It was config.yaml.");

    // ── a fresh process (no recorded frame) rebuilds the same frame ──
    let fresh_provider = Arc::new(MockProvider::new(vec![MockProvider::text("Rebuilt.")]));
    let fresh = session_with(&pool, &ws, fresh_provider.clone());
    drain(fresh.ask_side_question(&sid, "again?").await.unwrap()).await;
    let rebuilt = fresh_provider.calls.lock().unwrap()[0].clone();
    assert_eq!(rebuilt.0[0].content(), turn_msgs[0].content(), "rebuilt system prompt differs from the turn's");
    assert_eq!(&rebuilt.1, turn_tools, "rebuilt tools differ from the turn's");

    // ── provider errors are stored as errors ──
    let failing = Arc::new(MockProvider::new(vec![MockTurn::Error(ProviderError::Invalid("bad request".into()))]));
    let f = session_with(&pool, &ws, failing);
    let ask = f.ask_side_question(&sid, "fail?").await.unwrap();
    let fid = ask.id.clone();
    let events = drain(ask).await;
    assert_eq!(events.last().unwrap().event, "btw_error");
    assert_eq!(events.last().unwrap().str_field("status"), Some("error"));
    assert_eq!(row(&pool, &sid, &fid).await.status, "error");

    // ── stop keeps the partial answer ──
    let h = session_with(&pool, &ws, Arc::new(Hanging));
    let mut ask = h.ask_side_question(&sid, "slow?").await.unwrap();
    let hid = ask.id.clone();
    assert_eq!(ask.events.recv().await.unwrap().event, "btw_start");
    assert_eq!(ask.events.recv().await.unwrap().str_field("text"), Some("Partly"));
    assert!(side_question::is_running(&hid));
    assert!(side_question::stop(&sid, &hid));
    let stopped = wait_status(&pool, &sid, &hid, "stopped").await;
    assert_eq!(stopped.answer, "Partly");
    assert!(!side_question::stop(&sid, &hid), "stopped twice");

    // ── clear deletes them all ──
    assert!(side_question::clear(&pool, &sid).await.unwrap() >= 5);
    assert!(side_question::list(&pool, &sid, 100).await.unwrap().is_empty());
    assert_eq!(message_count(&pool, &sid).await, before);
}
