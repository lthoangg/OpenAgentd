//! Opt-in idle compaction: a lead session that stays idle after a turn is
//! compacted in the background once its context reaches the configured
//! share of the compaction trigger.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{broadcaster, Agent};
use appv3_core::runtime_settings::{load_runtime_settings, save_runtime_settings};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
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

/// One test so the process-wide settings and env are not shared across threads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_session_compacts_only_when_enabled_and_full_enough() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
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
    let mut completed = 0;
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(200), global.next()).await {
        if e.data.contains(&sid) {
            notifications += usize::from(e.event == "desktop_notification");
            completed += usize::from(e.event == "session_turn_completed");
        }
    }
    assert_eq!(completed, 2, "user turn + idle compaction turn");
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
}
