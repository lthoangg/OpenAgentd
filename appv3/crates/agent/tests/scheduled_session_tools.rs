//! Scheduled tasks and the tools a session gets. Only a session the
//! scheduler owns (`session_id: "auto"`) is marked as scheduled. Every turn of
//! every session lists the same tools, so a scheduled run never changes the
//! cached prompt prefix; a turn the scheduler started refuses the tools that
//! wait on a person when they are called. The manager and scheduler are
//! process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::scheduler::{self, TaskCreate};
use appv3_agent::session::UserMessage;
use appv3_agent::{manager, store};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use std::collections::BTreeSet;
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

/// Model calls whose user messages contain `marker`, oldest first.
fn calls_with(mock: &MockProvider, marker: &str) -> Vec<appv3_providers::mock::MockCall> {
    let calls = mock.calls.lock().unwrap();
    let found: Vec<_> = calls.iter().filter(|(msgs, _, _)| msgs.iter().any(|m| matches!(m, ChatMessage::User { .. }) && format!("{m:?}").contains(marker))).cloned().collect();
    assert!(!found.is_empty(), "no model call mentions {marker:?}");
    found
}

fn tool_names(call: &appv3_providers::mock::MockCall) -> BTreeSet<String> {
    call.1.clone().unwrap_or_default().iter().filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str()).map(String::from)).collect()
}

/// The result text the model got back for tool call `id`.
fn tool_result(call: &appv3_providers::mock::MockCall, id: &str) -> String {
    call.0
        .iter()
        .find_map(|m| match m {
            ChatMessage::Tool { tool_call_id, content, .. } if tool_call_id == id => content.clone(),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no result for tool call {id}"))
}

async fn scheduled_task_name(pool: &appv3_db::DbPool, sid: &str) -> Option<String> {
    appv3_db::get_session(pool, sid).await.unwrap().expect("session row").scheduled_task_name
}

/// Fire `slug` now and wait for the run's turn to end.
async fn fire_and_wait(ws: &str, slug: &str, sid: &str) {
    let s = scheduler::scheduler();
    s.trigger(slug).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while s.get_task(slug).await.unwrap().unwrap().run_count == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the task fired");
    let live = manager::find_live_session(ws, Some(sid)).expect("the fired session is live");
    tokio::time::timeout(Duration::from_secs(10), live.wait_turn_finished()).await.expect("the scheduled turn finishes");
}

/// Send a user message to a live session and wait for its turn to end.
async fn user_turn(ws: &str, sid: &str, text: &str) {
    let live = manager::find_live_session(ws, Some(sid)).unwrap();
    live.handle_user_message(UserMessage { content: text.into(), session_id: sid.into(), origin: "user".into(), ..Default::default() }).await.unwrap();
    if let Some(mut sub) = store().attach(sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), live.wait_turn_finished()).await.unwrap();
}

fn task(name: &str, ws: &str, session_id: &str) -> TaskCreate {
    TaskCreate {
        name: name.into(),
        slug: Some(name.into()),
        workspace: ws.into(),
        schedule_type: "every".into(),
        every_seconds: Some(3600),
        timezone: "UTC".into(),
        prompt: format!("prompt for {name}"),
        session_id: Some(session_id.into()),
        enabled: false,
        ..Default::default()
    }
}

const LEAD_TOOLS: [&str; 4] = ["ask_user", "team", "plan", "preview"];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduled_runs_keep_every_tool_and_refuse_the_ones_that_wait_on_a_person() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let ask = r#"{"questions": [{"question": "Which one?", "header": "Pick", "options": [{"label": "A"}, {"label": "B"}]}]}"#;
    let mock = Arc::new(MockProvider::new(vec![
        // The task in the user's session, then the user's next message.
        MockProvider::text("Done."),
        MockProvider::text("Done."),
        // The "auto" task tries to ask and to submit a plan, then finishes.
        MockProvider::tool_calls(&[("ask1", "ask_user", ask), ("submit1", "plan", r##"{"action": "write", "content": "# Auto", "submit": true}"##)]),
        MockProvider::text("Decided on my own."),
        // The user then writes in the scheduler's session.
        MockProvider::text("Done."),
    ]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);
    scheduler::init(pool.clone());
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();

    // A task created with `session_id: "current"` runs in the user's session.
    let user_id = uuid::Uuid::now_v7();
    let user_sid = user_id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(user_id), workspace: ws.clone(), ..Default::default() }).await.unwrap();
    let t = scheduler::scheduler().create(task("check-in-my-session", &ws, &user_sid)).await.unwrap();
    fire_and_wait(&ws, &t.slug, &user_sid).await;
    assert_eq!(scheduled_task_name(&pool, &user_sid).await, None, "the user's own session was marked as scheduled");
    user_turn(&ws, &user_sid, "my next message").await;
    let scheduled = tool_names(&calls_with(&mock, "prompt for check-in-my-session")[0]);
    let mine = tool_names(&calls_with(&mock, "my next message")[0]);
    for name in LEAD_TOOLS {
        assert!(mine.contains(name), "the user's session lacks {name} after a scheduled run: {mine:?}");
    }
    assert_eq!(scheduled, mine, "the scheduled run and the user's turn listed different tools");

    // A task with `session_id: "auto"` owns its session, from the first run,
    // and lists the same tools as any other session.
    let t = scheduler::scheduler().create(task("check-on-its-own", &ws, "auto")).await.unwrap();
    let auto_sid = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, b"scheduler:check-on-its-own").to_string();
    fire_and_wait(&ws, &t.slug, &auto_sid).await;
    assert_eq!(scheduled_task_name(&pool, &auto_sid).await.as_deref(), Some("check-on-its-own"));
    let run = calls_with(&mock, "prompt for check-on-its-own");
    assert_eq!(run.len(), 2, "the scheduled run: a call that uses tools, then one that reads their results");
    let after_tools = &run[1];
    assert_eq!(tool_names(&run[0]), mine, "the scheduler's session listed different tools");

    // Nobody is watching the scheduled run, so the tools that wait refuse.
    for id in ["ask1", "submit1"] {
        let text = tool_result(after_tools, id);
        assert!(text.contains("scheduled task started this turn"), "{id} was not refused: {text}");
    }
    assert!(tool_result(after_tools, "submit1").contains("\nPlan saved as revision 1 "), "the plan is still saved");
    assert_eq!(appv3_db::get_pending_question(&pool, &auto_sid).await.unwrap().map(|q| q.id), None, "the scheduled run left a question open");

    // The user writing in that session gets the same tools, so the cache holds.
    user_turn(&ws, &auto_sid, "my message in its session").await;
    assert_eq!(tool_names(&calls_with(&mock, "my message in its session")[0]), mine);
}
