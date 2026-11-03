//! Opt-in idle compaction: a lead session that stays idle after a turn is
//! compacted in the background once its context reaches the configured
//! share of the compaction trigger. Subagents still working for the lead do
//! not hold it back; an open question does.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{broadcaster, manager, subagents, Agent};
use appv3_core::runtime_settings::{load_runtime_settings, save_runtime_settings};
use appv3_providers::mock::MockProvider;
use appv3_providers::{AssistantMessage, ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderResult, ToolSpec};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Settings and env are process-wide, so both tests share one root and run
/// one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ROOT: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();

fn setup_env() -> &'static Path {
    ROOT.get_or_init(|| {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
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
        // Title generation would take scripted turns off the mock providers.
        std::fs::write(root.join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        let agents = appv3_core::settings::settings().agents_dir.clone();
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:lead\ntools: []\n---\nYou are the coding agent.\n").unwrap();
        std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\ndescription: Runs builds.\nmodel: mock:worker\ntools:\n  - shell\n---\nYou run builds.\n")
            .unwrap();
        tmp
    })
    .path()
}

/// The mock reports 10 prompt tokens per call, so `threshold` and `percent`
/// decide whether that is enough to compact.
fn configure(enabled: bool, threshold: i64, percent: Option<i64>) {
    let mut cfg = load_runtime_settings().unwrap();
    cfg.summarization.prompt_token_threshold = Some(threshold);
    cfg.summarization.idle_compaction = enabled;
    cfg.summarization.idle_compaction_percent = percent;
    save_runtime_settings(&cfg).unwrap();
}

fn new_session(pool: &appv3_db::DbPool, ws: &Path, delay: Duration) -> Arc<AgentSession> {
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, "code", "You are a test agent.", vec![], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    session.set_idle_compaction_delay(delay);
    session
}

async fn turn(session: &AgentSession, sid: &str, text: &str) {
    session.handle_user_message(UserMessage { content: text.into(), session_id: sid.into(), origin: "user".into(), ..Default::default() }).await.unwrap();
    session.wait_turn_finished().await;
}

async fn summaries(pool: &appv3_db::DbPool, sid: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM session_messages WHERE session_id = ? AND kind = 'summary'").bind(appv3_db::codec::db_id(sid)).fetch_one(pool).await.unwrap()
}

async fn wait_for_summary(pool: &appv3_db::DbPool, sid: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while summaries(pool, sid).await == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("idle compaction ran");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_session_compacts_only_when_enabled_and_full_enough() {
    let _serial = SERIAL.lock().await;
    let root = setup_env();
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let ws = root.join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let short = Duration::from_millis(150);
    let mut global = broadcaster::broadcaster().attach();

    // Enabled, 10 tokens >= 70% of 12: compacts once, without notifying.
    configure(true, 12, None);
    let s = new_session(&pool, &ws, short);
    let sid = uuid::Uuid::now_v7().to_string();
    turn(&s, &sid, "hi").await;
    wait_for_summary(&pool, &sid).await;
    s.wait_turn_finished().await;
    assert_eq!(s.state(), "idle");
    // The compaction turn does not re-arm the timer.
    tokio::time::sleep(short * 4).await;
    assert_eq!(summaries(&pool, &sid).await, 1, "compacted again");
    let mut notifications = 0;
    let mut started = vec![];
    let mut completed = vec![];
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(200), global.next()).await {
        if e.data.contains(&sid) {
            notifications += usize::from(e.event == "desktop_notification");
            let flagged = || serde_json::from_str::<serde_json::Value>(&e.data).unwrap()["idle_compaction"].as_bool().unwrap_or(false);
            match e.event.as_str() {
                "session_turn_started" => started.push(flagged()),
                "session_turn_completed" => completed.push(flagged()),
                _ => {}
            }
        }
    }
    // Clients use the flag to not mark the session unread (nothing new to
    // read) and to keep a background compaction out of "working" lists.
    assert_eq!(started, [false, true], "user turn, then the flagged idle compaction turn");
    assert_eq!(completed, [false, true], "user turn, then the flagged idle compaction turn");
    assert_eq!(notifications, 1, "idle compaction must not notify");

    // Disabled: nothing happens.
    configure(false, 12, None);
    let s = new_session(&pool, &ws, short);
    let sid = uuid::Uuid::now_v7().to_string();
    turn(&s, &sid, "hi").await;
    tokio::time::sleep(short * 4).await;
    assert_eq!(summaries(&pool, &sid).await, 0, "compacted while disabled");

    // Enabled but 10 tokens < 70% of 20: nothing happens…
    configure(true, 20, None);
    let s = new_session(&pool, &ws, short);
    let sid = uuid::Uuid::now_v7().to_string();
    turn(&s, &sid, "hi").await;
    tokio::time::sleep(short * 4).await;
    assert_eq!(summaries(&pool, &sid).await, 0, "compacted below the percent");

    // …until the percent is lowered to 40%: 10 >= 40% of 20.
    configure(true, 20, Some(40));
    let s = new_session(&pool, &ws, short);
    let sid = uuid::Uuid::now_v7().to_string();
    turn(&s, &sid, "hi").await;
    wait_for_summary(&pool, &sid).await;
    s.wait_turn_finished().await;

    // An open question keeps the session from compacting, even at the percent.
    configure(true, 12, None);
    let delay = Duration::from_millis(300);
    let s = new_session(&pool, &ws, delay);
    let sid = uuid::Uuid::now_v7().to_string();
    turn(&s, &sid, "hi").await;
    let qs = vec![serde_json::json!({"question": "Proceed?", "header": "Go", "options": []})];
    appv3_db::create_pending_question(&pool, &sid, "call_q", &qs).await.unwrap();
    tokio::time::sleep(delay * 3).await;
    assert_eq!(summaries(&pool, &sid).await, 0, "compacted with a question open");

    // A new turn before the delay cancels the pending timer; the second
    // turn's own timer compacts later.
    configure(true, 12, None);
    let delay = Duration::from_millis(600);
    let s = new_session(&pool, &ws, delay);
    let sid = uuid::Uuid::now_v7().to_string();
    turn(&s, &sid, "first").await;
    let first_done = tokio::time::Instant::now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    turn(&s, &sid, "second").await;
    tokio::time::sleep_until(first_done + delay + Duration::from_millis(100)).await;
    assert_eq!(summaries(&pool, &sid).await, 0, "the first turn's timer fired after a newer turn");
    wait_for_summary(&pool, &sid).await;
    s.wait_turn_finished().await;
    assert_eq!(summaries(&pool, &sid).await, 1);

    // A session a scheduled task owns compacts after the scheduler's turn too.
    configure(true, 12, None);
    let s = new_session(&pool, &ws, short);
    let id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, b"scheduler:nightly");
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), scheduled_task_name: Some("nightly".into()), ..Default::default() })
        .await
        .unwrap();
    s.handle_user_message(UserMessage { content: "[Scheduled Task: nightly]\ncheck".into(), session_id: sid.clone(), origin: "scheduler".into(), ..Default::default() })
        .await
        .unwrap();
    s.wait_turn_finished().await;
    wait_for_summary(&pool, &sid).await;
    s.wait_turn_finished().await;
}

/// Wraps a mock so one chosen `stream` call (the idle compaction's summariser
/// request) blocks until the test releases it.
struct Gated {
    inner: Arc<MockProvider>,
    hold_call: usize,
    streams: AtomicUsize,
    entered: AtomicBool,
    release: tokio::sync::Semaphore,
}

#[async_trait::async_trait]
impl LlmProvider for Gated {
    fn model(&self) -> &str {
        self.inner.model()
    }
    fn provider_name(&self) -> Option<&str> {
        self.inner.provider_name()
    }
    fn base_kwargs(&self) -> &Kwargs {
        self.inner.base_kwargs()
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        self.inner.chat(messages, tools, kwargs).await
    }
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        if self.streams.fetch_add(1, Ordering::SeqCst) == self.hold_call {
            self.entered.store(true, Ordering::SeqCst);
            self.release.acquire().await.unwrap().forget();
        }
        self.inner.stream(messages, tools, kwargs).await
    }
}

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

/// A lead whose turn ended while its subagent still works is compacted once
/// the delay passes, and the subagent's report that arrives mid-compaction
/// is not lost: it runs a lead turn right after the compaction.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_compaction_runs_while_a_subagent_works_and_its_report_follows() {
    let _serial = SERIAL.lock().await;
    let root = setup_env();
    let release = root.join("release");
    let build = format!("while [ ! -f '{}' ]; do sleep 0.05; done; echo built", release.display());
    let build_args = serde_json::json!({ "command": build }).to_string();
    let delegate_args = serde_json::json!({ "profile": "worker", "task": "run the build" }).to_string();
    // The lead delegates and ends its turn (calls 0-1), summarises when idle
    // (call 2, held), then reads the member's report (call 3).
    let lead_mock = Arc::new(MockProvider::new(vec![
        MockProvider::tool_call("call_d", "team", &delegate_args),
        MockProvider::text("delegated"),
        MockProvider::text("the summary"),
        MockProvider::text("thanks"),
    ]));
    let worker_mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_w", "shell", &build_args), MockProvider::text("build finished")]));
    let gate = Arc::new(Gated { inner: lead_mock.clone(), hold_call: 2, streams: AtomicUsize::new(0), entered: AtomicBool::new(false), release: tokio::sync::Semaphore::new(0) });
    let (lead_p, worker_p): (Arc<dyn LlmProvider>, Arc<dyn LlmProvider>) = (gate.clone(), worker_mock.clone());
    let factory: ProviderFactory = Arc::new(move |model, _| Ok(if model == Some("mock:worker") { worker_p.clone() } else { lead_p.clone() }));
    let pool = appv3_db::create_pool(root.join("oad_subagents.db")).await.unwrap();
    manager::init(pool.clone(), factory);
    configure(true, 12, None);

    let dir = root.join("project_subagents");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.clone(), ..Default::default() }).await.unwrap();
    let lead = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    lead.set_idle_compaction_delay(Duration::from_millis(150));
    lead.handle_user_message(UserMessage { content: "build it".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    // (`wait_turn_finished` would also wait out the compaction held below.)
    wait_for("the member's build to start", || !worker_mock.calls.lock().unwrap().is_empty()).await;
    assert!(subagents::has_working_subagents(&sid), "the member works for the lead");

    // The delay passes with the member still working: the compaction starts.
    wait_for("the idle compaction to start", || gate.entered.load(Ordering::SeqCst)).await;
    // Keep the report's own turn from arming another compaction.
    lead.set_idle_compaction_delay(Duration::from_secs(3600));
    assert_eq!(lead.state(), "working", "the compaction turn is running");
    assert!(subagents::has_working_subagents(&sid), "the member still works during the compaction");
    assert_eq!(summaries(&pool, &sid).await, 0);

    // The member reports while the compaction is held: the report queues.
    std::fs::write(&release, "").unwrap();
    let reports = || async {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_messages WHERE session_id = ? AND content LIKE '%build finished%'")
            .bind(appv3_db::codec::db_id(&sid))
            .fetch_one(&pool)
            .await
            .unwrap();
        n
    };
    tokio::time::timeout(Duration::from_secs(20), async {
        while reports().await == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the member's report lands");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(lead_mock.calls.lock().unwrap().len(), 2, "no lead turn runs over the compaction");
    assert_eq!(lead.state(), "working");
    assert_eq!(summaries(&pool, &sid).await, 0);

    // The compaction finishes, then the lead reads the report.
    gate.release.add_permits(1);
    wait_for("the lead to answer the report", || lead_mock.calls.lock().unwrap().len() >= 4).await;
    tokio::time::timeout(Duration::from_secs(20), lead.wait_turn_finished()).await.expect("lead turn on the report finishes");
    assert_eq!(summaries(&pool, &sid).await, 1, "the compaction completed");
    let calls = lead_mock.calls.lock().unwrap();
    assert_eq!(calls.len(), 4, "delegate, delegated, summary, report turn");
    assert!(calls[3].0.iter().any(|m| matches!(m, ChatMessage::User { content: Some(c), .. } if c.contains("build finished"))), "the report turn did not read the member's report");
    drop(calls);
    assert_eq!(lead.state(), "idle");
    assert!(!subagents::sessions_with_pending_work().contains(&sid));
}
