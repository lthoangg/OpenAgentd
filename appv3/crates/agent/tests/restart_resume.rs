//! A turn the server's shutdown cuts off continues on the next start; one
//! the user stopped does not. The manager and the shutdown flag are
//! process-wide, so this file is its own test binary and runs the whole
//! life of one session in order.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::restart_resume::{self, CONTINUE_NOTE, NOTE_KEY};
use appv3_agent::session::UserMessage;
use appv3_agent::{manager, store};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use serde_json::Value;
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

async fn finish(sid: &str, session: &appv3_agent::session::AgentSession) {
    if let Some(mut sub) = store().attach(sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("turn finishes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_cut_off_by_shutdown_continues_on_the_next_start_and_a_stopped_one_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    // Turn 1 hangs until the user stops it, turn 2 until the server stops,
    // and the continued turn 2 answers.
    let mock = Arc::new(MockProvider::new(vec![MockProvider::hang(), MockProvider::hang(), MockProvider::text("Back at it.")]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let sid = uuid::Uuid::now_v7().to_string();
    let send = |text: &str| UserMessage { content: text.into(), session_id: sid.clone(), workspace: Some(ws.clone()), origin: "user".into(), ..Default::default() };

    // A running turn is marked; the user's Stop clears the mark.
    let session = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    session.set_stop_grace(Duration::from_millis(200));
    session.handle_user_message(send("first")).await.unwrap();
    wait_for("the first turn's mark", async || in_flight(&pool).await == std::slice::from_ref(&sid)).await;
    assert!(session.handle_stop().await);
    finish(&sid, &session).await;
    assert!(in_flight(&pool).await.is_empty(), "a turn the user stopped is not continued");

    // A turn running when the server shuts down keeps its mark.
    session.handle_user_message(send("second")).await.unwrap();
    wait_for("the second turn's mark", async || in_flight(&pool).await == std::slice::from_ref(&sid)).await;
    restart_resume::begin_shutdown();
    manager::stop().await;
    assert_eq!(in_flight(&pool).await, std::slice::from_ref(&sid), "the shutdown left the turn marked");
    drop(session);

    // The next start continues it, with a note the agent and the user see.
    let report = restart_resume::resume_after_restart(&pool).await;
    assert_eq!(report.continued, std::slice::from_ref(&sid));
    let resumed = manager::find_live_session(&ws, Some(&sid)).expect("loaded again");
    finish(&sid, &resumed).await;
    assert!(in_flight(&pool).await.is_empty(), "the continued turn ended and cleared its mark");

    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let note = rows.iter().find(|r| r.extra_json().is_some_and(|e| e.get(NOTE_KEY).is_some())).expect("restart note saved");
    assert_eq!((note.role.as_str(), note.kind.as_str(), note.content.as_deref()), ("user", "chat", Some(CONTINUE_NOTE)));
    assert_eq!(note.extra_json().unwrap()[NOTE_KEY]["continued"], Value::Bool(true));
    let last = rows.last().unwrap();
    assert_eq!((last.role.as_str(), last.content.as_deref()), ("assistant", Some("Back at it.")));
    let calls = mock.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    // Consecutive user messages reach the model merged into one.
    let last_sent = calls[2].0.last().and_then(|m| m.content()).unwrap_or_default().to_string();
    assert!(last_sent.contains("second") && last_sent.ends_with(CONTINUE_NOTE), "{last_sent}");
}
