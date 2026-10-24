//! `/goal`: a lead session keeps taking turns toward its goal until the
//! completion check confirms it, a limit pauses it, or the user stops it.

use appv3_agent::goal;
use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_db::SessionGoal;
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Settings are process-wide, so every test shares one set of roots.
fn root() -> &'static Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ] {
            std::env::set_var(k, root.path().join(d));
        }
        std::env::set_var("HOME", root.path().join("home"));
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        // Titles would take scripted model turns.
        std::fs::create_dir_all(root.path().join("config")).unwrap();
        std::fs::write(root.path().join("config/settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
        root
    })
    .path()
}

/// A tool that does some work.
struct Work;

#[async_trait]
impl Tool for Work {
    fn name(&self) -> &str {
        "work"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        Ok(ToolOutput::text("worked"))
    }
}

/// A tool that runs until the turn is stopped.
struct Slow(Arc<AtomicBool>);

/// A stand-in `shell` whose every command passes, so the runtime log sees it.
struct Shell;

#[async_trait]
impl Tool for Shell {
    fn name(&self) -> &str {
        "shell"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        Ok(ToolOutput::text("[Succeeded]\n\n0 fail"))
    }
}

#[async_trait]
impl Tool for Slow {
    fn name(&self) -> &str {
        "slow"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        self.0.store(true, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(60)).await;
        Ok(ToolOutput::text("finished"))
    }
}

/// Holds a stopped turn open (until the stop grace ends it) by hanging where
/// the loop records the cancelled tool.
struct HangsOnCancel;

#[async_trait]
impl appv3_agent::hooks::Hook for HangsOnCancel {
    async fn on_tool_cancelled(&self, _ctx: &appv3_agent::hooks::RunContext, _tc: &appv3_providers::ToolCall, _result: &str, _duration_ms: Option<f64>) {
        std::future::pending::<()>().await
    }
}

const QUEUED_OBJECTIVE: &str = "ship the export";

/// Sets a goal while the turn runs, the way the chat route does for a busy
/// session (`persist_queued_user_message`): the goal, the queued objective,
/// and its rules note attached to that message.
struct QueueGoal {
    pool: appv3_db::DbPool,
    sid: String,
}

#[async_trait]
impl Tool for QueueGoal {
    fn name(&self) -> &str {
        "queue_goal"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        let g = appv3_db::insert_session_goal(&self.pool, &self.sid, QUEUED_OBJECTIVE, 1, None).await.unwrap();
        let (extra, mut note) = goal::message_extras(&g);
        let queued = appv3_db::save_queued_user_message(&self.pool, &self.sid, QUEUED_OBJECTIVE, Some(extra)).await.unwrap();
        note.insert("attachment_for_message_id".into(), json!(appv3_db::codec::api_uuid(&queued.id)));
        let row = appv3_db::NewMessage { kind: Some("note".into()), extra: Some(note), ..appv3_db::NewMessage::user(goal::note_text(QUEUED_OBJECTIVE, false)) };
        appv3_db::save_message(&self.pool, &self.sid, row).await.unwrap();
        Ok(ToolOutput::text("queued"))
    }
}

struct Harness {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    mock: Arc<MockProvider>,
    sid: String,
}

async fn harness(name: &str, turns: Vec<appv3_providers::mock::MockTurn>, slow: Arc<AtomicBool>) -> Harness {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join(name);
    std::fs::create_dir_all(&ws).unwrap();
    let mock = Arc::new(MockProvider::new(turns));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let sid = uuid::Uuid::now_v7().to_string();
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(Work), Arc::new(Shell), Arc::new(Slow(slow)), Arc::new(QueueGoal { pool: pool.clone(), sid: sid.clone() })];
    let agent = Agent::new(provider, name, "You are a test agent.", tools, Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    Harness { pool, session, mock, sid }
}

impl Harness {
    /// Set a goal the way the chat route does: store it, then send the
    /// objective with its rules note.
    async fn start_goal(&self, objective: &str, max_turns: i64) -> SessionGoal {
        let g = self.session.start_goal(&self.sid, objective, Some(max_turns), None).await.unwrap();
        let (extra, note) = goal::message_extras(&g);
        self.session
            .handle_user_message(UserMessage {
                content: objective.into(),
                session_id: self.sid.clone(),
                origin: "user".into(),
                extra: Some(extra),
                context_notes: vec![(goal::note_text(objective, false), note)],
                ..Default::default()
            })
            .await
            .unwrap();
        g
    }

    async fn finish(&self) {
        if let Some(mut sub) = store().attach(&self.sid) {
            let _ = tokio::time::timeout(Duration::from_secs(20), async { while sub.next().await.is_some() {} }).await;
        }
        tokio::time::timeout(Duration::from_secs(20), self.session.wait_turn_finished()).await.expect("turns finish");
    }

    async fn goal(&self) -> SessionGoal {
        appv3_db::latest_session_goal(&self.pool, &self.sid).await.unwrap().expect("goal stored")
    }

    /// Visible user rows in transcript order: `(text, goal_turn)`.
    async fn user_rows(&self) -> Vec<(String, Option<i64>)> {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.into_iter()
            .filter(|r| r.role == "user" && r.kind == "chat")
            .map(|r| {
                let turn = r.extra_json().and_then(|e| e.pointer("/goal_turn/turn").and_then(Value::as_i64));
                (r.content.unwrap_or_default(), turn)
            })
            .collect()
    }

    async fn notes(&self, key: &str) -> Vec<appv3_db::SessionMessage> {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.into_iter().filter(|r| r.kind == "note" && r.extra_json().is_some_and(|e| e.get(key).is_some())).collect()
    }

    fn calls(&self) -> usize {
        self.mock.calls.lock().unwrap().len()
    }
}

fn verdict(met: bool, reason: &str) -> appv3_providers::mock::MockTurn {
    MockProvider::text(&json!({"met": met, "reason": reason}).to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_keeps_taking_turns_until_its_turn_limit() {
    let turns = vec![
        MockProvider::tool_call("a", "work", "{}"),
        MockProvider::text("Step one."),
        MockProvider::tool_call("b", "work", "{}"),
        MockProvider::text("Step two."),
        MockProvider::tool_call("c", "work", "{}"),
        MockProvider::text("Step three."),
    ];
    let h = harness("turn-limit", turns, Arc::default()).await;
    h.start_goal("make it work", 3).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.turns_used), ("paused", Some(goal::reason::TURN_LIMIT), 3), "{g:?}");
    assert!(g.tokens_used > 0, "turn tokens are counted");
    assert_eq!(h.calls(), 6);

    let users = h.user_rows().await;
    assert_eq!(users.iter().map(|u| u.1).collect::<Vec<_>>(), [None, Some(2), Some(3)]);
    assert_eq!(users[0].0, "make it work");
    assert!(users[1].0.starts_with("<goal_reminder turn=\"2\" max_turns=\"3\""), "{}", users[1].0);
    assert!(!users[1].0.contains("last turn"));
    assert!(users[2].0.contains("last turn the goal allows"), "{}", users[2].0);
    // The rules stay pinned while the goal is live.
    let notes = h.notes(goal::GOAL_NOTE_KEY).await;
    assert_eq!(notes.len(), 1);
    assert!(notes[0].pinned);
    assert!(notes[0].content.as_deref().unwrap().contains("<objective>\nmake it work\n</objective>"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turns_without_tool_calls_pause_the_goal() {
    let h = harness("no-progress", vec![MockProvider::text("Thinking."), MockProvider::text("Still thinking.")], Arc::default()).await;
    h.start_goal("make it work", 10).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.turns_used), ("paused", Some(goal::reason::NO_PROGRESS), 2));
    assert_eq!(h.calls(), 2);
}

/// A goal runs many turns while the user is away: one notification at the
/// end, and it says what became of the goal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_notifies_once_with_its_outcome() {
    let turns = vec![MockProvider::tool_call("a", "work", "{}"), MockProvider::text("One."), MockProvider::tool_call("b", "work", "{}"), MockProvider::text("Two.")];
    let h = harness("notify", turns, Arc::default()).await;
    let mut global = appv3_agent::broadcaster::broadcaster().attach();
    h.start_goal("make it work", 2).await;
    h.finish().await;

    let mut titles = vec![];
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(300), global.next()).await {
        if e.event == "desktop_notification" && e.data.contains(&h.sid) {
            titles.push(serde_json::from_str::<Value>(&e.data).unwrap()["title"].as_str().unwrap_or_default().to_string());
        }
    }
    assert_eq!(titles, ["Goal paused · notify"], "one notification, after the last turn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_early_claim_is_rejected_and_a_proven_one_achieves_the_goal() {
    let claim = r#"{"status": "complete", "evidence": "tests pass"}"#;
    let turns = vec![
        MockProvider::tool_call("a", "update_goal", claim),
        verdict(false, "No test output is shown."),
        MockProvider::text("I'll run the tests."),
        MockProvider::tool_call("t", "shell", r#"{"command": "bun test"}"#),
        MockProvider::tool_call("b", "update_goal", claim),
        verdict(true, "The test run shows 0 failures."),
        MockProvider::text("Done: tests pass."),
    ];
    let h = harness("claims", turns, Arc::default()).await;
    h.start_goal("tests pass", 10).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.turns_used, g.rejected_claims), ("achieved", 2, 1), "{g:?}");
    assert_eq!(g.detail.as_deref(), Some("The test run shows 0 failures."));
    assert!(g.ended_at.is_some());
    assert_eq!(h.calls(), 7, "no turn after the goal is achieved");

    let calls = h.mock.calls.lock().unwrap().clone();
    let (turn_msgs, turn_tools, _) = &calls[0];
    let (check_msgs, check_tools, check_kw) = &calls[1];
    assert_eq!(check_msgs[0].content(), turn_msgs[0].content(), "the check reuses the turn's system prompt");
    assert_eq!(check_tools, turn_tools, "the check reuses the turn's tools");
    assert!(!check_kw.contains_key("tool_choice"), "tool_choice would invalidate the cached messages");
    let ask = check_msgs.last().unwrap().content().unwrap();
    assert!(ask.contains("<goal_check>") && ask.contains("<claimed_evidence>\ntests pass"), "{ask}");
    assert!(ask.contains("<runtime_log>\nNothing ran"), "the first check has no commands to go on: {ask}");
    let second = calls[5].0.last().unwrap().content().unwrap();
    assert!(second.contains("1. ran `bun test`: succeeded\nChanged after the last finished command: none."), "the runtime's record of the run: {second}");
    assert!(
        !check_msgs.iter().any(|m| matches!(m, ChatMessage::Assistant(a) if a.tool_calls.as_ref().is_some_and(|t| !t.is_empty()))),
        "the claiming reply is not part of the check"
    );

    // The rejection came back as the tool result, and the next turn carries it.
    let users = h.user_rows().await;
    assert_eq!(users.len(), 2);
    assert!(users[1].0.contains("The last completion check did not accept the claim: No test output is shown."), "{}", users[1].0);
    let rows = appv3_db::llm_window_rows(&h.pool, &h.sid, false).await.unwrap();
    let results: Vec<String> = rows.iter().filter(|r| r.role == "tool").filter_map(|r| r.content.clone()).collect();
    assert!(results[0].starts_with("The check did not accept the claim: No test output is shown."), "{}", results[0]);
    assert!(results[2].starts_with("The check confirmed the goal is met"), "{}", results[2]);
    // Nothing of the check is stored in the transcript.
    assert!(!rows.iter().any(|r| r.content.as_deref().is_some_and(|c| c.contains("<goal_check>"))));

    // The ended goal's rules are released and an end note follows.
    let note = &h.notes(goal::GOAL_NOTE_KEY).await[0];
    assert!(!note.pinned);
    assert!(note.extra_json().unwrap().get("hidden_from_summary").is_none());
    let ended = h.notes(goal::GOAL_ENDED_KEY).await;
    assert_eq!(ended.len(), 1);
    assert!(ended[0].content.as_deref().unwrap().starts_with("<goal_ended status=\"achieved\">"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_check_that_answers_without_a_verdict_is_asked_once_more() {
    let claim = r#"{"status": "complete", "evidence": "bun test: 0 failures"}"#;
    let turns = vec![
        MockProvider::tool_call("a", "update_goal", claim),
        // The check answers like the agent instead of judging.
        MockProvider::tool_call("x", "update_goal", claim),
        verdict(true, "The test run shows 0 failures."),
        MockProvider::text("Done."),
    ];
    let h = harness("check-retry", turns, Arc::default()).await;
    h.start_goal("tests pass", 10).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.rejected_claims), ("achieved", 0), "{g:?}");
    assert_eq!(h.calls(), 4);
    let calls = h.mock.calls.lock().unwrap().clone();
    assert_eq!(calls[1].0, calls[2].0, "the second ask is the same request, so it is cached too");
}

/// Claiming again with nothing run since the check said no would show the
/// check what it rejected: it is turned down without a check, and counts as
/// a rejection. Work in between earns a real check.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repeat_claim_with_nothing_new_is_rejected_without_a_check() {
    let claim = r#"{"status": "complete", "evidence": "tests pass"}"#;
    let turns = vec![
        MockProvider::tool_call("a", "update_goal", claim),
        verdict(false, "No test output is shown."),
        MockProvider::tool_call("b", "update_goal", claim),
        MockProvider::tool_call("t", "shell", r#"{"command": "bun test"}"#),
        MockProvider::tool_call("c", "update_goal", claim),
        verdict(true, "The test run shows 0 failures."),
        MockProvider::text("Done."),
    ];
    let h = harness("repeat-claim", turns, Arc::default()).await;
    h.start_goal("tests pass", 10).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.rejected_claims), ("achieved", 2), "{g:?}");
    assert_eq!(h.calls(), 7, "the repeat claim ran no check");
    let rows = appv3_db::llm_window_rows(&h.pool, &h.sid, false).await.unwrap();
    let results: Vec<String> = rows.iter().filter(|r| r.role == "tool").filter_map(|r| r.content.clone()).collect();
    assert!(results[1].starts_with("The check did not accept the claim: Nothing ran since the last rejected claim"), "{}", results[1]);
    assert!(results[1].contains("No test output is shown."), "it repeats the check's reason: {}", results[1]);
    assert!(results[3].starts_with("The check confirmed the goal is met"), "{}", results[3]);
}

/// A check that never gives a verdict says nothing about the work, so it
/// does not count toward the rejections that pause a goal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_check_without_a_verdict_is_not_a_rejected_claim() {
    let claim = r#"{"status": "complete", "evidence": "bun test: 0 failures"}"#;
    let turns = vec![
        MockProvider::tool_call("a", "update_goal", claim),
        MockProvider::text("Looks fine to me."),
        MockProvider::text("Looks fine to me."),
        MockProvider::text("I'll claim again once the check is back."),
    ];
    let h = harness("check-no-verdict", turns, Arc::default()).await;
    h.start_goal("tests pass", 1).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.rejected_claims, g.pause_reason.as_deref()), (0, Some(goal::reason::TURN_LIMIT)), "{g:?}");
    assert_eq!(h.calls(), 4);
    let rows = appv3_db::llm_window_rows(&h.pool, &h.sid, false).await.unwrap();
    let result = rows.iter().find(|r| r.role == "tool").and_then(|r| r.content.clone()).unwrap();
    assert!(result.starts_with("The completion check failed: The check replied without a verdict."), "{result}");
    assert!(result.contains("neither accepted nor rejected"), "{result}");
}

/// A check that keeps failing would make the agent claim again and again in
/// one turn; three failures in a row pause the goal instead.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checks_that_keep_failing_pause_the_goal() {
    let claim = r#"{"status": "complete", "evidence": "bun test: 0 failures"}"#;
    let mut turns = vec![];
    for id in ["a", "b", "c"] {
        turns.extend([MockProvider::tool_call(id, "update_goal", claim), MockProvider::text("Fine."), MockProvider::text("Fine.")]);
    }
    turns.push(MockProvider::text("Stopping here."));
    let h = harness("check-failing", turns, Arc::default()).await;
    h.start_goal("tests pass", 10).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.rejected_claims), ("paused", Some(goal::reason::CHECK_FAILED), 0), "{g:?}");
    assert_eq!(g.detail.as_deref(), Some("The check replied without a verdict."));
    assert_eq!(h.calls(), 10, "no turn starts after the goal pauses");
    let rows = appv3_db::llm_window_rows(&h.pool, &h.sid, false).await.unwrap();
    let last = rows.iter().filter(|r| r.role == "tool").filter_map(|r| r.content.clone()).next_back().unwrap();
    assert!(last.contains("failed 3 times in a row, so the goal is paused"), "{last}");
}

/// Once a goal is paused (here by three rejected claims), a claim in the
/// same turn runs no check: no more spend, and no achieving a goal the
/// user has to resume first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paused_goal_takes_no_claims() {
    let claim = r#"{"status": "complete", "evidence": "bun test: 0 failures"}"#;
    let mut turns = vec![];
    for (i, id) in ["a", "b", "c"].into_iter().enumerate() {
        if i > 0 {
            // Work between claims, so each one gets a check.
            turns.push(MockProvider::tool_call(&format!("w{i}"), "work", "{}"));
        }
        turns.extend([MockProvider::tool_call(id, "update_goal", claim), verdict(false, "No test output is shown.")]);
    }
    turns.extend([MockProvider::tool_call("d", "update_goal", claim), MockProvider::text("Stopping here.")]);
    let h = harness("paused-claims", turns, Arc::default()).await;
    h.start_goal("tests pass", 10).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.rejected_claims), ("paused", Some(goal::reason::UNVERIFIED), 3), "{g:?}");
    assert_eq!(h.calls(), 10, "the fourth claim ran no check");
    let rows = appv3_db::llm_window_rows(&h.pool, &h.sid, false).await.unwrap();
    let last = rows.iter().filter(|r| r.role == "tool").filter_map(|r| r.content.clone()).next_back().unwrap();
    assert!(last.contains("The goal is paused"), "{last}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_turns_refuse_questions_by_default() {
    let ask = r#"{"questions": [{"question": "Which file?", "header": "File"}]}"#;
    let turns = vec![MockProvider::tool_call("a", "ask_user", ask), MockProvider::text("I picked a.rs.")];
    let h = harness("unattended", turns, Arc::default()).await;
    h.start_goal("fix it", 1).await;
    h.finish().await;

    let rows = appv3_db::llm_window_rows(&h.pool, &h.sid, false).await.unwrap();
    let result = rows.iter().find(|r| r.role == "tool").and_then(|r| r.content.clone()).unwrap();
    assert!(result.contains("this turn works on the session goal and nobody is watching"), "{result}");
    assert_eq!(h.goal().await.pause_reason.as_deref(), Some(goal::reason::TURN_LIMIT));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_pauses_the_goal() {
    let started = Arc::new(AtomicBool::new(false));
    let h = harness("stop", vec![MockProvider::tool_call("a", "slow", "{}")], started.clone()).await;
    h.start_goal("make it work", 10).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("tool started");
    appv3_agent::service::interrupt_agent(&h.session, Some(&h.sid)).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.turns_used), ("paused", Some(goal::reason::STOPPED), 1));
    assert_eq!(h.calls(), 1, "a stopped goal starts no turn");
    assert_eq!(h.user_rows().await.len(), 1);
}

/// Stop ends a turn whose completion check is still waiting on the model,
/// without waiting out the stop grace.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_ends_a_completion_check_at_once() {
    let claim = r#"{"status": "complete", "evidence": "bun test: 0 failures"}"#;
    let h = harness("stop-check", vec![MockProvider::tool_call("a", "update_goal", claim), MockProvider::hang()], Arc::default()).await;
    h.session.set_stop_grace(Duration::from_secs(60));
    h.start_goal("tests pass", 10).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while h.calls() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the check started");

    assert!(h.session.handle_stop().await);
    assert!(h.session.wait_for_stop(Duration::from_secs(5)).await, "the turn ended without the 60 s grace");
    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.rejected_claims), ("paused", Some(goal::reason::STOPPED), 0), "{g:?}");
}

/// Resume while a stopped turn is still ending would leave the goal active
/// with no turn to continue it, so it is refused until that turn has ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_waits_for_a_stopped_turn_to_end() {
    let started = Arc::new(AtomicBool::new(false));
    let turns = vec![MockProvider::tool_call("a", "slow", "{}"), MockProvider::tool_call("b", "work", "{}"), MockProvider::text("Done.")];
    let h = harness("stop-resume", turns, started.clone()).await;
    h.session.set_stop_grace(Duration::from_millis(300));
    h.session.push_test_hook(Arc::new(HangsOnCancel));
    h.start_goal("make it work", 2).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("tool started");
    assert!(h.session.handle_stop().await);

    let err = h.session.resume_goal(&h.sid).await.expect_err("refused while the stopped turn ends");
    assert!(err.to_string().contains("still ending"), "{err}");
    h.finish().await;

    assert_eq!(h.session.resume_goal(&h.sid).await.unwrap().status, "active");
    h.finish().await;
    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.turns_used), ("paused", Some(goal::reason::TURN_LIMIT), 2), "{g:?}");
}

/// A continuation queued just before the user pauses or clears the goal must
/// not run as a turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pausing_or_clearing_drops_a_queued_continuation() {
    let h = harness("drop-reminder", vec![], Arc::default()).await;
    let id = uuid::Uuid::parse_str(&h.sid).unwrap();
    appv3_db::create_session(&h.pool, appv3_db::NewSession { id: Some(id), workspace: h.session.workspace(), ..Default::default() }).await.unwrap();
    let g = h.session.start_goal(&h.sid, "make it work", Some(5), None).await.unwrap();
    let Value::Object(reminder) = json!({"goal_turn": {"id": appv3_db::codec::api_uuid(&g.id), "turn": 2, "max_turns": 5}}) else { unreachable!() };

    appv3_db::save_queued_user_message(&h.pool, &h.sid, "<goal_reminder>", Some(reminder.clone())).await.unwrap();
    h.session.pause_goal(&h.sid).await.unwrap();
    assert!(!appv3_db::has_queued_user_messages(&h.pool, &h.sid).await.unwrap(), "pause drops it");

    appv3_db::save_queued_user_message(&h.pool, &h.sid, "<goal_reminder>", Some(reminder)).await.unwrap();
    h.session.clear_goal(&h.sid).await.unwrap();
    assert!(!appv3_db::has_queued_user_messages(&h.pool, &h.sid).await.unwrap(), "clear drops it");
    assert_eq!(h.calls(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_waits_in_plan_mode_and_starts_in_code_mode() {
    let turns = vec![MockProvider::text("Here is a plan."), MockProvider::tool_call("a", "work", "{}"), MockProvider::text("Built it.")];
    let h = harness("plan-mode", turns, Arc::default()).await;
    let id = uuid::Uuid::parse_str(&h.sid).unwrap();
    appv3_db::create_session(&h.pool, appv3_db::NewSession { id: Some(id), workspace: h.session.workspace(), ..Default::default() }).await.unwrap();
    appv3_db::update_session(&h.pool, &h.sid, appv3_db::SessionUpdate { interaction_mode: Some("plan".into()), ..Default::default() }).await.unwrap();
    h.start_goal("build it", 1).await;
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.turns_used), ("active", 0), "a Plan mode turn is not a goal turn");
    assert_eq!(h.calls(), 1);

    appv3_agent::interaction_mode::set_mode(&h.pool, &h.sid, "code").await.unwrap();
    assert!(h.session.kick_goal(&h.sid, false).await);
    h.finish().await;
    let g = h.goal().await;
    assert_eq!((g.turns_used, g.pause_reason.as_deref()), (1, Some(goal::reason::TURN_LIMIT)));
    assert_eq!(h.user_rows().await.iter().map(|u| u.1).collect::<Vec<_>>(), [None, Some(1)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_grants_more_turns_and_says_so() {
    // After the scripted turns the mock only answers text: two quiet turns
    // after the resume pause the goal again.
    let h = harness("resume", vec![MockProvider::tool_call("a", "work", "{}"), MockProvider::text("One.")], Arc::default()).await;
    h.start_goal("make it work", 1).await;
    h.finish().await;
    assert_eq!(h.goal().await.pause_reason.as_deref(), Some(goal::reason::TURN_LIMIT));

    let resumed = h.session.resume_goal(&h.sid).await.unwrap();
    assert_eq!(resumed.max_turns, 1 + appv3_core::runtime_settings::DEFAULT_GOAL_MAX_TURNS);
    h.finish().await;
    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.turns_used), ("paused", Some(goal::reason::NO_PROGRESS), 3));
    let users = h.user_rows().await;
    assert!(users[1].0.contains("The user resumed this goal."), "{}", users[1].0);
    assert!(!users[2].0.contains("resumed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clearing_an_idle_goal_releases_its_rules() {
    let h = harness("clear", vec![MockProvider::tool_call("a", "work", "{}"), MockProvider::text("One.")], Arc::default()).await;
    h.start_goal("make it work", 1).await;
    h.finish().await;
    let cleared = h.session.clear_goal(&h.sid).await.unwrap().unwrap();
    assert_eq!(cleared.status, "cleared");
    assert!(appv3_db::live_session_goal(&h.pool, &h.sid).await.unwrap().is_none());
    assert!(!h.notes(goal::GOAL_NOTE_KEY).await[0].pinned);
    let ended = h.notes(goal::GOAL_ENDED_KEY).await;
    assert!(ended[0].content.as_deref().unwrap().contains("cleared by the user"));
    // `update_goal` now fails.
    assert!(h.session.clear_goal(&h.sid).await.unwrap().is_none());
}

/// Undo takes back one turn at a time: a goal turn's undo keeps the goal,
/// and taking back its objective ends it, since its rules go with that
/// message.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_ends_a_goal_only_with_its_objective() {
    let turns = vec![MockProvider::tool_call("a", "work", "{}"), MockProvider::text("One."), MockProvider::tool_call("b", "work", "{}"), MockProvider::text("Two.")];
    let h = harness("undo-goal", turns, Arc::default()).await;
    h.start_goal("make it work", 2).await;
    h.finish().await;
    let undo = || appv3_agent::revert::undo_session_messages(h.pool.clone(), h.sid.clone());

    let shift = undo().await.unwrap();
    assert!(shift.target.as_ref().is_some_and(|t| t.extra_json().is_some_and(|e| e.get("goal_turn").is_some())), "the last goal turn goes first");
    assert_eq!(h.goal().await.status, "paused");

    let shift = undo().await.unwrap();
    assert_eq!(shift.target.and_then(|t| t.content).as_deref(), Some("make it work"));
    assert_eq!(h.goal().await.status, "cleared", "the objective took its goal with it");
}

/// Compaction summarizes the goal's turns but keeps its rules: the next
/// goal turn still reads the objective after the summary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_keeps_the_goal_rules() {
    let mut turns = vec![];
    for (id, said) in [("a", "One."), ("b", "Two."), ("c", "Three.")] {
        turns.extend([MockProvider::tool_call(id, "work", "{}"), MockProvider::text(said)]);
    }
    turns.push(MockProvider::text("Summary: three steps of work are done."));
    let h = harness("compaction", turns, Arc::default()).await;
    h.start_goal("make it work", 3).await;
    h.finish().await;
    let ws = h.session.workspace();
    h.session.handle_compact(&h.sid, Some(&ws)).await.unwrap();
    h.finish().await;
    assert_eq!(h.calls(), 7, "three goal turns and the summary");

    h.session.resume_goal(&h.sid).await.unwrap();
    h.finish().await;
    let calls = h.mock.calls.lock().unwrap().clone();
    let read: Vec<String> = calls[7].0.iter().filter_map(|m| m.content().map(String::from)).collect();
    let read = read.join("\n\n");
    assert!(read.contains("Summary: three steps of work are done."), "the turn reads the summary: {read}");
    assert!(read.contains("<session_goal>") && read.contains("<objective>\nmake it work\n</objective>"), "the rules survive compaction: {read}");
    assert!(h.notes(goal::GOAL_NOTE_KEY).await[0].pinned);
}

/// A goal set while a turn runs is queued like a steer: the running turn
/// reads the objective with its rules, and the goal's turns follow it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_set_during_a_turn_reads_its_rules_and_runs_after_it() {
    let turns = vec![MockProvider::tool_call("a", "queue_goal", "{}"), MockProvider::text("Noted."), MockProvider::tool_call("b", "work", "{}"), MockProvider::text("Shipped.")];
    let h = harness("queued-goal", turns, Arc::default()).await;
    h.session.handle_user_message(UserMessage { content: "look around".into(), session_id: h.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    h.finish().await;

    let g = h.goal().await;
    assert_eq!((g.status.as_str(), g.pause_reason.as_deref(), g.turns_used), ("paused", Some(goal::reason::TURN_LIMIT), 1), "{g:?}");
    assert_eq!(h.calls(), 4);

    // The steer brought the rules to the model, right after the objective.
    let read: String = {
        let calls = h.mock.calls.lock().unwrap();
        calls[1].0.iter().filter(|m| m.role() == "user").filter_map(|m| m.content().map(String::from)).collect::<Vec<_>>().join("\n\n")
    };
    let objective = read.find(QUEUED_OBJECTIVE).unwrap_or_else(|| panic!("objective not read: {read}"));
    let rules = read.find("<session_goal>").unwrap_or_else(|| panic!("rules not read: {read}"));
    assert!(objective < rules, "rules read before the objective: {read}");
    assert!(h.notes(goal::GOAL_NOTE_KEY).await[0].pinned, "the rules stay pinned while the goal is live");

    let users = h.user_rows().await;
    assert_eq!(users.iter().map(|u| u.0.as_str()).take(2).collect::<Vec<_>>(), ["look around", QUEUED_OBJECTIVE]);
    assert_eq!(users.iter().map(|u| u.1).collect::<Vec<_>>(), [None, None, Some(1)]);
}

/// Cancelling the queued objective of a goal set mid-turn takes back its
/// rules note too (attached to that message), so the goal must end with it,
/// as an undo of the objective ends it. Another queued message does not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_queued_objective_ends_its_goal() {
    let h = harness("cancel-queued", vec![], Arc::default()).await;
    let id = uuid::Uuid::parse_str(&h.sid).unwrap();
    appv3_db::create_session(&h.pool, appv3_db::NewSession { id: Some(id), workspace: h.session.workspace(), ..Default::default() }).await.unwrap();
    let g = h.session.start_goal(&h.sid, QUEUED_OBJECTIVE, Some(5), None).await.unwrap();
    let (extra, _) = goal::message_extras(&g);
    let steer = appv3_db::save_queued_user_message(&h.pool, &h.sid, "and the docs", None).await.unwrap();
    let objective = appv3_db::save_queued_user_message(&h.pool, &h.sid, QUEUED_OBJECTIVE, Some(extra)).await.unwrap();

    assert!(h.session.clear_cancelled_goal(&h.sid, &steer).await.unwrap().is_none());
    assert_eq!(h.goal().await.status, "active");

    let cleared = h.session.clear_cancelled_goal(&h.sid, &objective).await.unwrap().expect("its goal ends");
    assert_eq!((cleared.id.as_str(), cleared.status.as_str()), (g.id.as_str(), "cleared"));

    // A newer goal is not the cancelled objective's: it stays.
    let newer = h.session.start_goal(&h.sid, "something else", Some(5), None).await.unwrap();
    assert!(h.session.clear_cancelled_goal(&h.sid, &objective).await.unwrap().is_none());
    assert_eq!(h.goal().await.id, newer.id);
    assert_eq!(h.goal().await.status, "active");
}
