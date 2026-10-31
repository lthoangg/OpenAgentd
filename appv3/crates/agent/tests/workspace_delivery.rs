//! How an agent's message reaches a busy session in another workspace: it
//! steers (read before the next step), queues (a turn of its own once the
//! running one ends), or stops the running turn and sends. Also the prompt
//! cache rule: whatever the delivery, the target's model history only grows
//! at the tail. The manager is process-wide, so one test runs every scenario
//! on one scripted provider.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::manager;
use appv3_agent::workspace_messages::{self as wm, Delivery, DeliveryMode, SendRequest};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use std::path::{Path, PathBuf};
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
    let cfg = root.join("config");
    std::fs::create_dir_all(&cfg).unwrap();
    std::fs::write(cfg.join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools:\n  - shell\n---\nYou are the coding agent.\n").unwrap();
}

/// A shell call that says it started, then blocks until `release` exists.
/// The shell tool runs PowerShell on Windows, so the command differs there.
fn blocking_build(dir: &Path, name: &str) -> (String, PathBuf, PathBuf) {
    let (started, release) = (dir.join(format!("{name}.started")), dir.join(format!("{name}.release")));
    let command = if cfg!(windows) {
        format!(
            "New-Item -ItemType File -Force -Path '{}' | Out-Null; while (-not (Test-Path '{}')) {{ Start-Sleep -Milliseconds 50 }}; 'built'",
            started.display(),
            release.display()
        )
    } else {
        format!("touch '{}'; while [ ! -f '{}' ]; do sleep 0.05; done; echo built", started.display(), release.display())
    };
    (serde_json::json!({ "command": command }).to_string(), started, release)
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn wait_turn(ws: &str, sid: &str) {
    let s = manager::find_live_session(ws, Some(sid)).expect("live session");
    tokio::time::timeout(Duration::from_secs(20), s.wait_turn_finished()).await.expect("turn finishes");
}

/// `(role, text)` of every message in one model call: what the provider
/// (and so its prompt cache) sees.
fn seen(mock: &MockProvider, call: usize) -> Vec<(String, String)> {
    let calls = mock.calls.lock().unwrap();
    calls[call]
        .0
        .iter()
        .map(|m| {
            let text = match m {
                ChatMessage::System { content, .. } | ChatMessage::User { content, .. } | ChatMessage::Tool { content, .. } => content.clone().unwrap_or_default(),
                ChatMessage::Assistant(a) => format!("{:?}|{:?}", a.content, a.tool_calls),
            };
            (m.role().to_string(), text)
        })
        .collect()
}

fn has_user(msgs: &[(String, String)], text: &str) -> bool {
    msgs.iter().any(|(r, c)| r == "user" && c.contains(text))
}

/// An earlier model call's history must be a byte-identical prefix of a later one.
fn assert_prefix(earlier: &[(String, String)], later: &[(String, String)]) {
    assert!(later.len() >= earlier.len(), "history shrank: {earlier:?} -> {later:?}");
    assert_eq!(&later[..earlier.len()], earlier, "an earlier message changed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn steer_queue_and_stop_and_send_reach_a_busy_session() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup_roots(root);
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    let (steer_args, steer_started, steer_release) = blocking_build(root, "steer");
    let (queue_args, queue_started, queue_release) = blocking_build(root, "queue");
    let (stop_args, stop_started, stop_release) = blocking_build(root, "stop");
    let mock = Arc::new(MockProvider::new(vec![
        // steer: the build runs, the steer is read before the next model call.
        MockProvider::tool_call("c1", "shell", &steer_args),
        MockProvider::text("Steered."),
        // queue: the first turn ends without the held message, which gets its own turn.
        MockProvider::tool_call("c2", "shell", &queue_args),
        MockProvider::text("First done."),
        MockProvider::text("Second done."),
        // stop & send: the build is stopped, the message starts a new turn.
        MockProvider::tool_call("c3", "shell", &stop_args),
        MockProvider::text("Restarted."),
        // idle target: stop & send has nothing to stop.
        MockProvider::text("Idle done."),
    ]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    manager::init(pool.clone(), factory);

    let (app, infra) = (root.join("app"), root.join("infra"));
    for d in [&app, &infra] {
        std::fs::create_dir_all(d).unwrap();
    }
    let app_ws = manager::validate_workspace(&app.display().to_string(), true).unwrap();
    let infra_ws = manager::validate_workspace(&infra.display().to_string(), true).unwrap();
    for ws in [&app_ws, &infra_ws] {
        appv3_db::upsert_coding_workspace(&pool, ws, "repo", None, None, false, false).await.unwrap();
    }
    let acme = appv3_db::create_workspace_group(&pool, "acme", None, None).await.unwrap();
    for ws in [&app_ws, &infra_ws] {
        appv3_db::set_workspace_groups(&pool, ws, std::slice::from_ref(&acme.id)).await.unwrap();
    }
    let app_id = uuid::Uuid::now_v7();
    let app_sid = app_id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(app_id), title: Some("App".into()), workspace: app_ws.clone(), ..Default::default() }).await.unwrap();
    let send = |message: &str, session_id: Option<String>, delivery: DeliveryMode| SendRequest {
        source_session_id: app_sid.clone(),
        source_workspace: app_ws.clone(),
        workspace: "infra".into(),
        message: message.into(),
        session_id,
        reply: false,
        mode: None,
        delivery,
        worktree: None,
    };
    let calls = || mock.calls.lock().unwrap().len();

    // ── steer: read before the next step, inside the running turn ───────
    let first = wm::send(&pool, send("Build it.", None, DeliveryMode::Steer)).await.unwrap();
    assert_eq!(first.delivery, Delivery::Started);
    let sid = first.session_id.clone();
    until("the build to start", || steer_started.exists()).await;
    let mut global = appv3_agent::broadcaster::broadcaster().attach();
    let s = wm::send(&pool, send("Also lint.", Some(sid.clone()), DeliveryMode::Steer)).await.unwrap();
    assert_eq!(s.delivery, Delivery::Queued);
    assert_eq!(calls(), 1, "nothing read it yet");
    // Queued, no turn starts, but the session was just used: clients that
    // sort by activity hear it, with the time the server now sorts by.
    let activity = loop {
        let e = tokio::time::timeout(Duration::from_secs(5), global.next()).await.expect("session_activity").expect("feed open");
        if e.event == "session_activity" {
            break serde_json::from_str::<serde_json::Value>(&e.data).unwrap();
        }
    };
    assert_eq!(activity["session_id"], sid.as_str());
    let row = appv3_db::get_session(&pool, &sid).await.unwrap().unwrap();
    assert_eq!(activity["last_message_at"], appv3_db::codec::api_dt(row.last_message_at.as_deref().unwrap()), "{activity}");
    drop(global);
    std::fs::write(&steer_release, "").unwrap();
    wait_turn(&infra_ws, &sid).await;
    assert_eq!(calls(), 2, "the steer rode the running turn: no turn of its own");
    let (before, after) = (seen(&mock, 0), seen(&mock, 1));
    assert!(!has_user(&before, "Also lint.") && has_user(&after, "Also lint."));
    assert_prefix(&before, &after);
    // What the model read mid-turn is what a reload renders (same bytes later).
    let reloaded = appv3_agent::history::rows_to_llm_messages(appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap());
    let render =
        |msgs: &[ChatMessage]| -> Vec<String> { msgs.iter().filter_map(|m| if let ChatMessage::User { content: Some(c), .. } = m { Some(c.clone()) } else { None }).collect() };
    let live_users: Vec<String> = after.iter().filter(|(r, _)| r == "user").map(|(_, c)| c.clone()).collect();
    let db_users = render(&reloaded);
    assert_eq!(&db_users[..live_users.len()], &live_users[..], "a reload renders the model's history differently");

    // ── queue: a turn of its own once the running turn ends ─────────────
    let first = wm::send(&pool, send("Build again.", None, DeliveryMode::Steer)).await.unwrap();
    let sid = first.session_id.clone();
    let base = calls();
    until("the build to start", || queue_started.exists()).await;
    let q = wm::send(&pool, send("After that, deploy.", Some(sid.clone()), DeliveryMode::Queue)).await.unwrap();
    assert_eq!(q.delivery, Delivery::Held);
    assert!(appv3_db::has_queued_user_messages(&pool, &sid).await.unwrap());
    assert!(!appv3_db::has_queued_steers(&pool, &sid).await.unwrap(), "a held message is not offered to the running turn");
    std::fs::write(&queue_release, "").unwrap();
    until("the held message's turn", || calls() == base + 3).await;
    wait_turn(&infra_ws, &sid).await;
    assert_eq!(calls(), base + 3);
    let (running_end, own_turn) = (seen(&mock, base + 1), seen(&mock, base + 2));
    assert!(!has_user(&running_end, "After that, deploy."), "the running turn read a held message");
    assert!(has_user(&own_turn, "After that, deploy."), "the held message never started its turn");
    assert_prefix(&seen(&mock, base), &running_end);
    assert_prefix(&running_end, &own_turn);
    assert!(!appv3_db::has_queued_user_messages(&pool, &sid).await.unwrap());

    // ── stop & send: the running turn ends, the message starts a new one ─
    let first = wm::send(&pool, send("Build once more.", None, DeliveryMode::Steer)).await.unwrap();
    let sid = first.session_id.clone();
    let base = calls();
    until("the build to start", || stop_started.exists()).await;
    let x = wm::send(&pool, send("Stop, use the v2 schema.", Some(sid.clone()), DeliveryMode::StopAndSend)).await.unwrap();
    assert_eq!(x.delivery, Delivery::Stopped);
    wait_turn(&infra_ws, &sid).await;
    std::fs::write(&stop_release, "").unwrap();
    assert_eq!(calls(), base + 2);
    let (stopped_turn, restarted) = (seen(&mock, base), seen(&mock, base + 1));
    assert_prefix(&stopped_turn, &restarted);
    assert!(has_user(&restarted, "It stopped your previous turn to send this.") && has_user(&restarted, "Stop, use the v2 schema."));
    assert!(!has_user(&stopped_turn, "It stopped your previous turn"), "the earlier request was rewritten");
    assert!(!has_user(&stopped_turn, "Stop, use the v2 schema."));

    // ── an idle target: nothing to stop, nothing to hold ────────────────
    let base = calls();
    let idle = wm::send(&pool, send("Status?", Some(sid.clone()), DeliveryMode::StopAndSend)).await.unwrap();
    assert_eq!(idle.delivery, Delivery::Delivered);
    wait_turn(&infra_ws, &sid).await;
    assert_eq!(calls(), base + 1);
    let idle_call = seen(&mock, base);
    assert!(has_user(&idle_call, "Status?"));
    let last_request = idle_call.iter().rev().find(|(r, c)| r == "user" && c.contains("Status?")).unwrap();
    assert!(!last_request.1.contains("It stopped your previous turn"), "an idle target had nothing stopped: {}", last_request.1);
}
