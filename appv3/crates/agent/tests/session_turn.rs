//! End-to-end turn through `AgentSession` with a scripted provider.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{broadcaster, store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use std::sync::Arc;
use std::time::Duration;

fn setup_env(root: &std::path::Path) {
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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_turn_persists_and_streams_like_v2() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("hello.txt"), "hello world\n").unwrap();

    let provider: Arc<dyn LlmProvider> =
        Arc::new(MockProvider::new(vec![MockProvider::tool_call("call_1", "read", r#"{"path":"hello.txt"}"#), MockProvider::text("The file says hello world.")]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent =
        Agent::new(provider.clone(), "code", "You are a test agent.", vec![std::sync::Arc::new(appv3_tools::read::ReadTool) as appv3_tools::ToolRef], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let mut global = broadcaster::broadcaster().attach();

    let sid = uuid::Uuid::now_v7().to_string();
    let (rsid, mid) = session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    assert_eq!(rsid, sid);
    let mut sub = store().attach(&sid).expect("turn is streaming");
    let mut events = vec![];
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(e) = sub.next().await {
            events.push((e.event.clone(), e.data.clone()));
        }
    })
    .await
    .expect("stream ends with done");
    session.wait_turn_finished().await;

    let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
    for want in ["agent_status", "tool_call", "tool_start", "tool_end", "message", "usage", "done"] {
        assert!(names.contains(&want), "missing {want} in {names:?}");
    }
    // Tools are always allowed; no client acted on a per-call announcement.
    assert!(!names.contains(&"permission_asked"), "{names:?}");
    assert_eq!(*names.last().unwrap(), "done");
    let tool_end = events.iter().find(|(e, _)| e == "tool_end").unwrap();
    assert!(tool_end.1.contains("hello world"), "{}", tool_end.1);

    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let roles: Vec<&str> = rows.iter().map(|r| r.role.as_str()).collect();
    assert_eq!(roles, vec!["user", "assistant", "tool", "assistant"]);
    assert_eq!(appv3_db::codec::api_uuid(&rows[0].id), mid);
    assert_eq!(rows[3].content.as_deref(), Some("The file says hello world."));
    // No reasoning streamed, so there is no thinking time to record.
    assert!(rows[3].extra_json().unwrap().get("thinking_duration_ms").is_none());
    let tc = rows[1].tool_calls_json().unwrap();
    assert_eq!(tc[0]["function"]["name"], "read");
    let s = appv3_db::get_session(&pool, &sid).await.unwrap().unwrap();
    assert_eq!(s.title.as_deref(), Some("hi"));
    assert_eq!(s.workspace, ws.display().to_string());
    assert_eq!(session.state(), "idle");

    let mut seen = vec![];
    let mut notification = None;
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(200), global.next()).await {
        if e.event == "desktop_notification" && e.data.contains(&sid) {
            notification = Some(serde_json::from_str::<serde_json::Value>(&e.data).unwrap());
        }
        seen.push(e.event.clone());
    }
    assert!(seen.contains(&"session_turn_started".to_string()), "{seen:?}");
    assert!(seen.contains(&"session_turn_completed".to_string()), "{seen:?}");
    let notification = notification.unwrap_or_else(|| panic!("no desktop_notification in {seen:?}"));
    assert_eq!(notification["kind"], "assistant_done");
    assert_eq!(notification["title"], format!("Done · {}", ws.file_name().unwrap().to_string_lossy()));
    assert_eq!(notification["body"], "hi");
}
