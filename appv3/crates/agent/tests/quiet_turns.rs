//! A turn only agents worked in stays quiet: a session another workspace's
//! send started runs its request without a "Done" notification and with
//! `quiet` on `session_turn_completed`, so clients do not mark it unread.
//! Once the user writes into a turn, it notifies as usual, and a question
//! for the user always does.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::tools::ask_user::AskUserTool;
use appv3_agent::{broadcaster, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use serde_json::{json, Value};
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
    // Title generation would take scripted turns off the mock provider.
    let config = root.join("config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(config.join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

/// The `session_turn_completed` payload for `sid`, and whether a
/// `desktop_notification` for it went out, from what the turn published.
async fn turn_end(global: &mut broadcaster::GlobalSubscription, sid: &str) -> (Value, bool) {
    let mut completed = None;
    let mut notified = false;
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(300), global.next()).await {
        if !e.data.contains(sid) {
            continue;
        }
        match e.event.as_str() {
            "desktop_notification" => notified = true,
            "session_turn_completed" => completed = Some(serde_json::from_str::<Value>(&e.data).unwrap()),
            _ => {}
        }
    }
    (completed.expect("session_turn_completed"), notified)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_only_turn_is_quiet_and_the_users_own_turn_notifies() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("infra");
    std::fs::create_dir_all(&ws).unwrap();
    let ws = ws.display().to_string();

    let sender = appv3_db::create_session(&pool, appv3_db::NewSession { workspace: "/r/app".into(), title: Some("Orders API".into()), ..Default::default() }).await.unwrap();
    let sid = uuid::Uuid::now_v7();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(sid), workspace: ws.clone(), title: Some("Orders table".into()), ..Default::default() }).await.unwrap();
    appv3_db::set_sent_from_session(&pool, &sid.to_string(), &sender.id).await.unwrap();
    let sid = sid.to_string();

    let ask = r#"{"questions":[{"question":"Which region?","header":"Region"}]}"#;
    let provider: Arc<dyn LlmProvider> =
        Arc::new(MockProvider::new(vec![MockProvider::text("Queue created."), MockProvider::text("Renamed it."), MockProvider::tool_call("q1", "ask_user", ask)]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let ask_user = AskUserTool { session_id: sid.clone(), pool: pool.clone(), agent_name: "code".into() };
    let agent = Agent::new(provider.clone(), "code", "You are a test agent.", vec![Arc::new(ask_user) as appv3_tools::ToolRef], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.clone()), pool.clone(), factory, None);
    let mut global = broadcaster::broadcaster().attach();

    // The other workspace's agent asks; nobody needs to read the answer.
    let mut extra = serde_json::Map::new();
    extra.insert("sent_from".into(), json!({"session_id": appv3_db::codec::api_uuid(&sender.id), "workspace": "/r/app", "workspace_name": "app", "reply": false, "hops": 1}));
    let request = |content: &str| UserMessage { content: content.into(), session_id: sid.clone(), origin: "workspace".into(), extra: Some(extra.clone()), ..Default::default() };
    session.handle_user_message(request("Create the orders queue.")).await.unwrap();
    session.wait_turn_finished().await;
    let (completed, notified) = turn_end(&mut global, &sid).await;
    assert_eq!(completed["quiet"], json!(true), "{completed}");
    assert!(!notified, "an agent-only turn sends no Done");

    // The user writes into the same session: that turn is theirs.
    session.handle_user_message(UserMessage { content: "Rename it to orders-v2.".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    session.wait_turn_finished().await;
    let (completed, notified) = turn_end(&mut global, &sid).await;
    assert!(completed.get("quiet").is_none(), "{completed}");
    assert!(notified, "the user's turn notifies");

    // An agent-only turn that needs the user still says so.
    session.handle_user_message(request("Add a dead-letter queue.")).await.unwrap();
    let mut asked = None;
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_secs(5), global.next()).await {
        if e.event == "desktop_notification" && e.data.contains(&sid) {
            asked = Some(serde_json::from_str::<Value>(&e.data).unwrap());
            break;
        }
    }
    assert_eq!(asked.expect("a question notifies")["kind"], "input_needed");
}
