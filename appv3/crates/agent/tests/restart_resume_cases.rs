//! What the next start does with each kind of turn a restart left behind:
//! one already continued once, one parked on a question, a member's, an
//! active goal between turns, and a mark left by a turn that had already
//! answered. The manager is process-wide, so this file is its own test
//! binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::restart_resume::{self, member_notice, NOTE_KEY, NOT_CONTINUED_NOTE, RESTART_TOOL_RESULT};
use appv3_db::NewMessage;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use serde_json::{json, Value};
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
    std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\nmodel: mock:mock\ntools: []\n---\nYou run builds.\n").unwrap();
}

/// A session an earlier process saved: a prompt, then a tool call with no
/// result (the process went down mid-tool).
async fn cut_off_session(pool: &appv3_db::DbPool, ws: &str, parent: Option<String>, name: Option<&str>) -> String {
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(
        pool,
        appv3_db::NewSession { id: Some(id), workspace: ws.into(), parent_session_id: parent, agent_name: name.map(String::from), ..Default::default() },
    )
    .await
    .unwrap();
    appv3_db::save_message(pool, &sid, NewMessage::user("do the thing")).await.unwrap();
    let mut a = NewMessage::assistant(None);
    a.tool_calls = Some(json!([{"id": "c1", "type": "function", "function": {"name": "shell", "arguments": "{}"}}]));
    appv3_db::save_message(pool, &sid, a).await.unwrap();
    sid
}

async fn rows(pool: &appv3_db::DbPool, sid: &str) -> Vec<appv3_db::SessionMessage> {
    appv3_db::llm_window_rows(pool, sid, false).await.unwrap()
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_kind_of_cut_off_turn_gets_its_own_outcome() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![]));
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();

    // Continued once already, and cut off again: stays stopped, goal paused.
    let capped = cut_off_session(&pool, &ws, None, None).await;
    appv3_db::mark_turn_in_flight(&pool, &capped, false).await.unwrap();
    appv3_db::count_restart_resume(&pool, &capped).await.unwrap();
    appv3_db::insert_session_goal(&pool, &capped, "ship it", 5, None).await.unwrap();
    // Parked on a question: not running, its answer resumes it.
    let parked = cut_off_session(&pool, &ws, None, None).await;
    appv3_db::mark_turn_in_flight(&pool, &parked, false).await.unwrap();
    appv3_db::create_pending_question(&pool, &parked, "q1", &[json!({"question": "Which?"})]).await.unwrap();
    // A member cut off mid-task: its idle lead hears about it.
    let lead = cut_off_session(&pool, &ws, None, None).await;
    appv3_db::save_message(&pool, &lead, NewMessage::tool("c1", "shell", "ok")).await.unwrap();
    appv3_db::save_message(&pool, &lead, NewMessage::assistant(Some("Delegated.".into()))).await.unwrap();
    let member = cut_off_session(&pool, &ws, Some(appv3_db::codec::db_id(&lead)), Some("worker#1")).await;
    appv3_db::mark_turn_in_flight(&pool, &member, false).await.unwrap();
    // An active goal between turns: it goes on.
    let between = cut_off_session(&pool, &ws, None, None).await;
    appv3_db::save_message(&pool, &between, NewMessage::tool("c1", "shell", "ok")).await.unwrap();
    appv3_db::save_message(&pool, &between, NewMessage::assistant(Some("Step one done.".into()))).await.unwrap();
    appv3_db::insert_session_goal(&pool, &between, "finish it", 2, None).await.unwrap();
    // Marked, but its turn had answered: an older build could leave such a
    // mark behind. It is not run again.
    let answered = cut_off_session(&pool, &ws, None, None).await;
    appv3_db::save_message(&pool, &answered, NewMessage::tool("c1", "shell", "ok")).await.unwrap();
    appv3_db::save_message(&pool, &answered, NewMessage::assistant(Some("All cleaned up.".into()))).await.unwrap();
    appv3_db::mark_turn_in_flight(&pool, &answered, false).await.unwrap();

    let report = restart_resume::resume_after_restart(&pool).await;
    assert!(report.continued.is_empty(), "{report:?}");
    assert_eq!(report.not_continued, std::slice::from_ref(&capped));
    assert_eq!(report.members_reported, std::slice::from_ref(&member));
    // (The lead's and the goal's new turns may be running and marked now.)
    let marked: Vec<String> = appv3_db::list_inflight_turns(&pool).await.unwrap().into_iter().map(|r| appv3_db::codec::api_uuid(&r.session_id)).collect();
    for (name, sid) in [("capped", &capped), ("parked", &parked), ("member", &member), ("answered", &answered)] {
        assert!(!marked.contains(sid), "{name} is still marked");
    }

    // Answered: left as it was, with no restart note and no new turn.
    let answered_rows = rows(&pool, &answered).await;
    assert_eq!(answered_rows.last().and_then(|r| r.content.as_deref()), Some("All cleaned up."));
    assert!(!answered_rows.iter().any(|r| r.extra_json().is_some_and(|e| e.get(NOTE_KEY).is_some())), "a restart note was added");
    assert!(manager::find_live_session(&ws, Some(&answered)).is_none(), "an agent was started for it");

    // Capped: its tool call says a restart cut it off, a note says it was not continued.
    let capped_rows = rows(&pool, &capped).await;
    let tool = capped_rows.iter().find(|r| r.role == "tool").expect("cut-off call healed");
    assert_eq!(tool.content.as_deref(), Some(RESTART_TOOL_RESULT));
    let note = capped_rows.last().unwrap();
    assert_eq!((note.role.as_str(), note.content.as_deref()), ("user", Some(NOT_CONTINUED_NOTE)));
    assert_eq!(note.extra_json().unwrap()[NOTE_KEY]["continued"], Value::Bool(false));
    let g = appv3_db::latest_session_goal(&pool, &capped).await.unwrap().unwrap();
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref()), ("paused", Some("restart")));

    // Parked: left waiting for its answer.
    assert!(appv3_db::get_pending_question(&pool, &parked).await.unwrap().is_some());
    assert!(manager::find_live_session(&ws, Some(&parked)).is_none());

    // Member: the lead got the report and took a turn on it.
    wait_for("the lead's turn on the report", async || rows(&pool, &lead).await.last().is_some_and(|r| r.role == "assistant" && r.content.as_deref() == Some("mock"))).await;
    let report_row = rows(&pool, &lead).await.into_iter().find(|r| r.extra_json().is_some_and(|e| e["from_agent"] == "worker#1")).expect("member report");
    assert_eq!(report_row.content.as_deref(), Some(member_notice("worker#1").as_str()));
    // It is listed again, stopped, and its cut-off call says a restart stopped it.
    assert_eq!(appv3_agent::subagents::describe_subagents(&lead), "- worker#1: stopped by a server restart (send it a task to resume)");
    let member_tool = rows(&pool, &member).await.into_iter().find(|r| r.role == "tool").expect("member's cut-off call healed");
    assert_eq!(member_tool.content.as_deref(), Some(RESTART_TOOL_RESULT));

    // Between turns: the goal took its next turn instead of pausing.
    wait_for("the goal's next turn", async || appv3_db::latest_session_goal(&pool, &between).await.unwrap().unwrap().turns_used >= 1).await;
    let g = appv3_db::latest_session_goal(&pool, &between).await.unwrap().unwrap();
    assert_ne!(g.pause_reason.as_deref(), Some("restart"), "{g:?}");
    for sid in [&lead, &between] {
        if let Some(s) = manager::find_live_session(&ws, Some(sid)) {
            tokio::time::timeout(Duration::from_secs(10), s.wait_turn_finished()).await.expect("turns finish");
        }
    }
}
