//! Cross-workspace messages end to end: a lead in one workspace sends a
//! prompt to another workspace's session, that session runs as if the user
//! typed it, and its final answer comes back as a report that wakes the
//! sender. The manager is process-wide, so one test runs every scenario on
//! one scripted provider.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::workspace_messages::{self as wm, Delivery, SendRequest};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{LlmProvider, ProviderError};
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
    std::fs::create_dir_all(root.join("home")).unwrap();
    write_settings(root, true);
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\n---\nYou are the coding agent.\n").unwrap();
}

/// Title generation would take scripted turns off the mock provider.
fn write_settings(root: &Path, messages: bool) {
    let dir = root.join("config");
    std::fs::create_dir_all(&dir).unwrap();
    let extra = if messages { "" } else { "workspace_messages:\n  enabled: false\n" };
    std::fs::write(dir.join("settings.yaml"), format!("title_generation:\n  enabled: false\n{extra}")).unwrap();
}

async fn user_rows(pool: &appv3_db::DbPool, sid: &str) -> Vec<(String, String, Value)> {
    let rows: Vec<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT kind, content, extra FROM session_messages WHERE session_id = ? AND role = 'user' ORDER BY seq, id")
            .bind(appv3_db::codec::db_id(sid))
            .fetch_all(pool)
            .await
            .unwrap();
    rows.into_iter().map(|(k, c, e)| (k, c.unwrap_or_default(), e.and_then(|e| serde_json::from_str(&e).ok()).unwrap_or(Value::Null))).collect()
}

async fn wait_turn(ws: &str, sid: &str) {
    let s = manager::find_live_session(ws, Some(sid)).expect("live session");
    tokio::time::timeout(Duration::from_secs(20), s.wait_turn_finished()).await.expect("turn finishes");
}

fn tool_names(mock: &MockProvider, call: usize) -> Vec<String> {
    let calls = mock.calls.lock().unwrap();
    calls[call].1.clone().unwrap_or_default().iter().filter_map(|t| t["function"]["name"].as_str().map(String::from)).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_reply_retry_and_guards() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let mock = Arc::new(MockProvider::new(vec![
        // 1. infra answers the request, then the app reads the reply.
        MockProvider::text("Queue URL is sqs://orders."),
        MockProvider::text("Wired it in."),
        // 2. infra fails, the app reads the notice; a retry answers.
        MockTurn::Error(ProviderError::Unconfigured("no key".into())),
        MockProvider::text("Noted, waiting."),
        MockProvider::text("Retried: done."),
        MockProvider::text("Thanks."),
        // 3. a plan-mode session.
        MockProvider::text("Plan drafted."),
        // 4. a follow-up in the first infra session.
        MockProvider::text("Follow-up done."),
        // 5. a turn with the switch off.
        MockProvider::text("No tool."),
    ]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);

    let app = root.join("app");
    let infra = root.join("infra");
    for d in [&app, &infra] {
        std::fs::create_dir_all(d).unwrap();
    }
    let app_ws = manager::validate_workspace(&app.display().to_string(), true).unwrap();
    let infra_ws = manager::validate_workspace(&infra.display().to_string(), true).unwrap();
    appv3_db::upsert_coding_workspace(&pool, &app_ws, "repo", None, None, false, false).await.unwrap();
    appv3_db::upsert_coding_workspace(&pool, &infra_ws, "repo", None, None, false, false).await.unwrap();

    let app_id = uuid::Uuid::now_v7();
    let app_sid = app_id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(app_id), title: Some("Orders service".into()), workspace: app_ws.clone(), ..Default::default() })
        .await
        .unwrap();
    let send = |workspace: &str, message: &str, session_id: Option<String>, reply: bool, mode: Option<&str>| SendRequest {
        source_session_id: app_sid.clone(),
        source_workspace: app_ws.clone(),
        workspace: workspace.into(),
        message: message.into(),
        session_id,
        reply,
        mode: mode.map(String::from),
    };

    // ── 1. new session + reply ──────────────────────────────────────────
    let sent = wm::send(&pool, send("INFRA", "Create the orders queue.", None, true, None)).await.unwrap();
    assert_eq!(sent.delivery, Delivery::Started);
    assert_eq!(sent.target.name, "infra");
    let infra_sid = sent.session_id.clone();
    assert!(wm::has_outstanding_replies(&app_sid));
    wait_turn(&infra_ws, &infra_sid).await;
    let rows = user_rows(&pool, &infra_sid).await;
    assert_eq!(rows[0].1, "Create the orders queue.", "the UI shows the plain message");
    let from = &rows[0].2["sent_from"];
    assert_eq!(
        (from["session_id"].as_str(), from["workspace_name"].as_str(), from["reply"].as_bool(), from["hops"].as_i64()),
        (Some(app_sid.as_str()), Some("app"), Some(true), Some(1))
    );
    assert_eq!(from["session_title"], "Orders service");
    assert!(from["replied_at"].is_string(), "{from}");
    assert!(tool_names(&mock, 0).contains(&"send_to_workspace".to_string()), "leads get the tool");
    {
        let calls = mock.calls.lock().unwrap();
        let seen = format!("{:?}", calls[0].0);
        assert!(seen.contains("[Message from the agent in workspace 'app'"), "model sees the header");
    }
    // The reply woke the app session.
    wait_turn(&app_ws, &app_sid).await;
    let app_rows = user_rows(&pool, &app_sid).await;
    let reply = app_rows.iter().find(|r| r.2.get("reply_from").is_some()).expect("reply row");
    assert_eq!(reply.0, "chat");
    assert_eq!(reply.1, "Queue URL is sqs://orders.");
    assert_eq!(reply.2["from_agent"], "infra");
    assert_eq!(reply.2["reply_from"]["status"], "completed");
    assert_eq!(reply.2["reply_from"]["session_id"], infra_sid.as_str());
    assert!(!wm::has_outstanding_replies(&app_sid));
    assert_eq!(mock.calls.lock().unwrap().len(), 2);

    // ── 2. error notice, then the retried answer ────────────────────────
    let sent = wm::send(&pool, send(&infra_ws, "Rotate the key.", None, true, None)).await.unwrap();
    let retry_sid = sent.session_id.clone();
    wait_turn(&infra_ws, &retry_sid).await;
    wait_turn(&app_ws, &app_sid).await;
    let notices: Vec<_> = user_rows(&pool, &app_sid).await.into_iter().filter(|r| r.2["reply_from"]["session_id"] == retry_sid.as_str()).collect();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].2["reply_from"]["status"], "error");
    assert!(notices[0].1.contains("failed: ") && notices[0].1.contains("its final answer will follow"), "{}", notices[0].1);
    assert!(wm::has_outstanding_replies(&app_sid), "the request stays pending");
    let infra_session = manager::find_live_session(&infra_ws, Some(&retry_sid)).unwrap();
    infra_session.handle_continue(&retry_sid, Some(&infra_ws), None, None).await.unwrap();
    wait_turn(&infra_ws, &retry_sid).await;
    wait_turn(&app_ws, &app_sid).await;
    let replies: Vec<_> = user_rows(&pool, &app_sid).await.into_iter().filter(|r| r.2["reply_from"]["session_id"] == retry_sid.as_str()).collect();
    assert_eq!(replies.len(), 2);
    assert_eq!((replies[1].1.as_str(), replies[1].2["reply_from"]["status"].as_str()), ("Retried: done.", Some("completed")));
    assert!(!wm::has_outstanding_replies(&app_sid));

    // ── 3. plan mode, fire-and-forget ───────────────────────────────────
    let sent = wm::send(&pool, send("infra", "Plan the migration.", None, false, Some("plan"))).await.unwrap();
    wait_turn(&infra_ws, &sent.session_id).await;
    let row = appv3_db::get_session(&pool, &sent.session_id).await.unwrap().unwrap();
    assert_eq!(row.interaction_mode, "plan");
    assert!(user_rows(&pool, &app_sid).await.iter().all(|r| r.2["reply_from"]["session_id"] != sent.session_id.as_str()), "no reply was asked for");

    // ── 4. guards ───────────────────────────────────────────────────────
    let e = wm::send(&pool, send("infra", "x", Some(app_sid.clone()), false, None)).await.unwrap_err();
    assert!(e.contains("is this session"), "{e}");
    let e = wm::send(&pool, send("infra", "x", Some(uuid::Uuid::now_v7().to_string()), false, None)).await.unwrap_err();
    assert!(e.contains("not found"), "{e}");
    let continued = wm::send(&pool, send("infra", "And a dead-letter queue.", Some(infra_sid.clone()), false, None)).await.unwrap();
    assert_eq!(continued.delivery, Delivery::Delivered);
    wait_turn(&infra_ws, &infra_sid).await;
    let e = wm::send(&pool, send("app", "x", Some(infra_sid.clone()), false, None)).await.unwrap_err();
    assert!(e.contains("belongs to workspace"), "{e}");
    // A request that already crossed three workspaces goes no further.
    let deep = uuid::Uuid::now_v7();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(deep), workspace: app_ws.clone(), ..Default::default() }).await.unwrap();
    let mut extra = serde_json::Map::new();
    extra.insert("sent_from".into(), json!({"session_id": "s", "hops": 3}));
    appv3_db::save_message(&pool, &deep.to_string(), appv3_db::NewMessage { extra: Some(extra), ..appv3_db::NewMessage::user("chain") }).await.unwrap();
    let e = wm::send(&pool, SendRequest { source_session_id: deep.to_string(), ..send("infra", "x", None, false, None) }).await.unwrap_err();
    assert!(e.contains("Refused"), "{e}");
    let listing = wm::list(&pool, &app_ws, None).await.unwrap();
    assert!(listing.contains("- Chat — ") && listing.contains(&format!("- app — {app_ws} (current)")) && listing.contains("- infra — "), "{listing}");
    let sessions = wm::list(&pool, &app_ws, Some("infra")).await.unwrap();
    assert!(sessions.contains(&infra_sid) && sessions.contains("Create the orders queue."), "{sessions}");

    // ── 5. the switch removes the tool ──────────────────────────────────
    write_settings(root, false);
    let calls_before = mock.calls.lock().unwrap().len();
    let s = manager::find_live_session(&infra_ws, Some(&infra_sid)).unwrap();
    s.handle_continue(&infra_sid, Some(&infra_ws), None, None).await.unwrap();
    wait_turn(&infra_ws, &infra_sid).await;
    let names = tool_names(&mock, calls_before);
    assert!(!names.is_empty() && !names.contains(&"send_to_workspace".to_string()), "{names:?}");
}
