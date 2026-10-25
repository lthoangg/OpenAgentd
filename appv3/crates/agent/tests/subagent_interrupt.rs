//! The lead steers one member without touching the others: `interrupt` cuts
//! its current step short and starts it on the new message, and `stop` ends
//! another's work. Neither cut-short turn reports to the lead. The manager is
//! process-wide, so this file is its own test binary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::tools::team::DelegateTool;
use appv3_agent::{manager, subagents};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::denied::DeniedPaths;
use appv3_tools::{Tool, ToolContext, ToolOutput};
use serde_json::json;
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
    std::fs::write(agents.join("helper.md"), "---\nname: helper\nrole: member\ndescription: Runs tests.\nmodel: mock:helper\ntools:\n  - shell\n---\nYou run tests.\n").unwrap();
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn user_texts(mock: &MockProvider) -> Vec<String> {
    mock.calls
        .lock()
        .unwrap()
        .iter()
        .flat_map(|(messages, _, _)| messages.iter())
        .filter_map(|m| match m {
            ChatMessage::User { content: Some(c), .. } => Some(c.clone()),
            _ => None,
        })
        .collect()
}

fn text(out: ToolOutput) -> String {
    match out {
        ToolOutput::Text(t) => t,
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_lead_interrupts_one_member_and_stops_another() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    // Both members start a command that blocks until the test releases it.
    let block = |name: &str| {
        let file = root.join(name);
        serde_json::json!({ "command": format!("while [ ! -f '{}' ]; do sleep 0.05; done; echo done", file.display()) }).to_string()
    };
    let lead_mock = Arc::new(MockProvider::new(vec![]));
    let worker_mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_w", "shell", &block("never-w")), MockProvider::text("redirected report")]));
    let helper_mock = Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_h", "shell", &block("never-h")), MockProvider::text("helper report")]));
    let (lead_p, worker_p, helper_p): (Arc<dyn LlmProvider>, Arc<dyn LlmProvider>, Arc<dyn LlmProvider>) = (lead_mock.clone(), worker_mock.clone(), helper_mock.clone());
    let factory: ProviderFactory = Arc::new(move |model, _| {
        Ok(match model {
            Some("mock:worker") => worker_p.clone(),
            Some("mock:helper") => helper_p.clone(),
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
    let call = |args: serde_json::Value| {
        let (delegate, ctx) = (&delegate, &ctx);
        async move { text(delegate.run(ctx, args).await.expect("delegate ran")) }
    };

    call(json!({"profile": "worker", "task": "check every crate"})).await;
    call(json!({"profile": "helper", "task": "run the tests"})).await;
    let worker = subagents::with_instance(&sid, "worker#1", |i| i.session.clone()).unwrap();
    let helper = subagents::with_instance(&sid, "helper#1", |i| i.session.clone()).unwrap();
    wait_until("both commands to start", || !worker_mock.calls.lock().unwrap().is_empty() && !helper_mock.calls.lock().unwrap().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A follow-up to a busy member waits for its turn, and says so.
    let queued = call(json!({"target": "worker#1", "task": "also note the crate sizes"})).await;
    assert!(queued.contains("will read this when its current work ends"), "{queued}");

    // Interrupt: the blocked command is dropped and the new message runs now.
    let interrupted = call(json!({"action": "interrupt", "target": "worker#1", "task": "only check the API crate"})).await;
    assert!(interrupted.contains("was interrupted and is now working on your message"), "{interrupted}");
    wait_until("the lead to read the redirected report", || user_texts(&lead_mock).iter().any(|t| t.contains("redirected report"))).await;
    let seen = worker_mock.calls.lock().unwrap().last().unwrap().0.clone();
    let seen: Vec<String> = seen.iter().filter_map(|m| if let ChatMessage::User { content: Some(c), .. } = m { Some(c.clone()) } else { None }).collect();
    assert!(seen.iter().any(|c| c.contains("[Lead]: only check the API crate")), "{seen:?}");
    assert!(seen.iter().any(|c| c.contains("[Lead]: also note the crate sizes")), "the queued follow-up was lost: {seen:?}");
    assert!(helper.is_busy(), "interrupting one member touched another");

    // Stop the other: it ends without a report.
    let stopped = call(json!({"action": "stop", "target": "helper#1"})).await;
    assert!(stopped.starts_with("Subagent 'helper#1' stopped."), "{stopped}");
    wait_until("the helper's turn to end", || helper.active_task_done() && !helper.is_busy()).await;
    wait_until("the worker's turn to end", || worker.active_task_done() && !worker.is_busy()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let listed = call(json!({"action": "list"})).await;
    assert_eq!(listed, "- worker#1: done (report delivered)\n- helper#1: stopped (send it a task to resume)");
    let texts = user_texts(&lead_mock);
    let from_members: Vec<&String> = texts.iter().filter(|t| t.starts_with("[worker#1]") || t.starts_with("[helper#1]")).collect();
    assert!(!from_members.is_empty() && from_members.iter().all(|t| t.contains("redirected report")), "a cut-short turn reported to the lead: {from_members:?}");
    assert!(!texts.iter().any(|t| t.contains("helper report")), "the stopped helper went on");
}
