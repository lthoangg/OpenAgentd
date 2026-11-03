//! The lead's messages to a member (the spawn task, a follow-up queued behind
//! a running turn, a follow-up to an idle member) carry `extra.from_lead`, so
//! the UI can link a member's transcript back to its lead. It is UI metadata
//! only: the model never sees it, and the rows stay ordinary user prompts.
//! The manager is process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::tools::team::DelegateTool;
use appv3_agent::{manager, subagents};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::denied::DeniedPaths;
use appv3_tools::{Tool, ToolContext, ToolOutput};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:lead\ntools: []\n---\nYou are the coding agent.\n").unwrap();
    std::fs::write(agents.join("worker.md"), "---\nname: worker\nrole: member\ndescription: Runs builds.\nmodel: mock:worker\ntools:\n  - shell\n---\nYou run builds.\n").unwrap();
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn text(out: ToolOutput) -> String {
    match out {
        ToolOutput::Text(t) => t,
        other => panic!("expected text, got {other:?}"),
    }
}

/// The user rows a member's transcript holds that start with `prefix`.
async fn rows_starting(pool: &appv3_db::DbPool, sid: &str, prefix: &str) -> Vec<appv3_db::SessionMessage> {
    let (rows, _, _) = appv3_db::history_page(pool, sid, None).await.unwrap();
    rows.into_iter().filter(|r| r.role == "user" && r.content.as_deref().is_some_and(|c| c.starts_with(prefix))).collect()
}

fn from_lead(row: &appv3_db::SessionMessage) -> Option<Value> {
    row.extra_json().and_then(|e| e.get("from_lead").cloned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_lead_tags_every_message_it_sends_a_member() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let release = root.join("release");
    let block = serde_json::json!({ "command": format!("while [ ! -f '{}' ]; do sleep 0.05; done; echo done", release.display()) }).to_string();
    let lead_mock = Arc::new(MockProvider::new(vec![]));
    let worker_mock = Arc::new(MockProvider::new(vec![
        MockProvider::tool_call("call_w", "shell", &block),
        MockProvider::text("first report"),
        MockProvider::text("second report"),
        MockProvider::text("third report"),
    ]));
    let (lead_p, worker_p): (Arc<dyn LlmProvider>, Arc<dyn LlmProvider>) = (lead_mock.clone(), worker_mock.clone());
    let factory: ProviderFactory = Arc::new(move |model, _| {
        Ok(match model {
            Some("mock:worker") => worker_p.clone(),
            _ => lead_p.clone(),
        })
    });
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    manager::init(pool.clone(), factory.clone());

    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.clone(), ..Default::default() }).await.unwrap();
    manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    let delegate = DelegateTool { lead_session_id: sid.clone(), pool: pool.clone(), provider_factory: factory.clone() };
    let ctx = ToolContext {
        session_id: Some(sid.clone()),
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: Arc::new(DeniedPaths::new(&dir, Some(sid.clone()))),
        workspace: Some(ws.clone()),
        output: None,
        metadata: Default::default(),
        messages: None,
    };
    let call = |args: Value| {
        let (delegate, ctx) = (&delegate, &ctx);
        async move { text(delegate.run(ctx, args).await.expect("delegate ran")) }
    };
    // The id the HTTP API gives as `parent_session_id`, which the web client navigates to.
    let lead_api_id = appv3_db::codec::api_uuid(&sid);
    let want = json!({ "session_id": lead_api_id });

    // The spawn task.
    call(json!({"profile": "worker", "task": "check every crate"})).await;
    let worker = subagents::with_instance(&sid, "worker#1", |i| i.session.clone()).unwrap();
    let child = subagents::with_instance(&sid, "worker#1", |i| i.session_id.clone()).unwrap();
    wait_until("the command to start", || !worker_mock.calls.lock().unwrap().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let tasks = rows_starting(&pool, &child, "[Task from Lead]: check every crate").await;
    assert_eq!(tasks.len(), 1);
    assert_eq!(from_lead(&tasks[0]), Some(want.clone()), "the spawn task row: {:?}", tasks[0].extra);

    // A follow-up behind the running turn is tagged while it waits, and after it is promoted.
    let queued = call(json!({"target": "worker#1", "task": "queued follow-up"})).await;
    assert!(queued.contains("will read this when its current work ends"), "{queued}");
    let waiting = appv3_db::list_queued_messages(&pool, &child).await.unwrap();
    let waiting: Vec<_> = waiting.iter().filter(|r| r.content.as_deref() == Some("[Lead]: queued follow-up")).collect();
    assert_eq!(waiting.len(), 1);
    assert_eq!(from_lead(waiting[0]), Some(want.clone()), "the queued row: {:?}", waiting[0].extra);
    std::fs::write(&release, "").unwrap();
    wait_until("the turn to end", || worker.active_task_done() && !worker.is_busy()).await;
    let promoted = rows_starting(&pool, &child, "[Lead]: queued follow-up").await;
    assert_eq!(promoted.len(), 1);
    assert_eq!(promoted[0].kind, "chat", "the follow-up was not read");
    assert_eq!(from_lead(&promoted[0]), Some(want.clone()), "the promoted row: {:?}", promoted[0].extra);

    // A follow-up to an idle member.
    let sent = call(json!({"target": "worker#1", "task": "idle follow-up"})).await;
    assert!(!sent.contains("will read this when its current work ends"), "{sent}");
    wait_until("the idle follow-up's turn to end", || worker.active_task_done() && !worker.is_busy() && worker_mock.calls.lock().unwrap().len() >= 4).await;
    let idle = rows_starting(&pool, &child, "[Lead]: idle follow-up").await;
    assert_eq!(idle.len(), 1);
    assert_eq!(from_lead(&idle[0]), Some(want.clone()), "the idle follow-up row: {:?}", idle[0].extra);

    // The model reads the plain text: no tag, and no lead id in any request.
    for (messages, _, _) in worker_mock.calls.lock().unwrap().iter() {
        for m in messages {
            if let ChatMessage::User { content: Some(c), .. } = m {
                assert!(!c.contains(&lead_api_id) && !c.contains("from_lead"), "the tag reached the model: {c}");
                assert!(!c.starts_with("[code]"), "the lead's rows became reports: {c}");
            }
        }
    }
}
