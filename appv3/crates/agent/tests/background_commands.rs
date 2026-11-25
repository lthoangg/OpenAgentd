//! Background `shell` commands report back: the lead is told when one ends,
//! and a command it waits for holds its goal, keeps it on the active list,
//! and starts its next turn. The manager is process-wide, so every test
//! here needs its own process (nextest gives it one).

use crate::common;

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{background_commands, manager, subagents};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::jobs;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{wait_until, wait_until_async};

struct Lead {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    mock: Arc<MockProvider>,
    sid: String,
}

/// A lead with the real `shell` tool, on a scripted model.
async fn lead(root: &Path, turns: Vec<MockTurn>) -> Lead {
    common::setup_roots(root);
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools:\n  - shell\n---\nYou are the coding agent.\n").unwrap();
    let mock = Arc::new(MockProvider::new(turns));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(provider.clone()));
    let pool = appv3_db::create_pool(root.join("oad.db")).await.unwrap();
    manager::init(pool.clone(), factory);
    background_commands::install();
    let dir = root.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.clone(), ..Default::default() }).await.unwrap();
    let session = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("agent configured");
    Lead { pool, session, mock, sid }
}

impl Lead {
    async fn send(&self, text: &str) {
        self.session.handle_user_message(UserMessage { content: text.into(), session_id: self.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    }

    async fn turn_ends(&self) {
        tokio::time::timeout(Duration::from_secs(20), self.session.wait_turn_finished()).await.expect("the turn finishes");
    }

    /// Add the model's next answer.
    fn script(&self, turn: MockTurn) {
        self.mock.turns.lock().unwrap().push_back(turn);
    }

    fn calls(&self) -> usize {
        self.mock.calls.lock().unwrap().len()
    }

    /// Every message the model was sent in call `n` (from 0), as text.
    fn sent(&self, n: usize) -> Vec<String> {
        self.mock.calls.lock().unwrap()[n]
            .0
            .iter()
            .filter_map(|m| match m {
                ChatMessage::User { content, .. } | ChatMessage::Tool { content, .. } => content.clone(),
                _ => None,
            })
            .collect()
    }

    /// A call the model made that carried a message containing `text`.
    fn read(&self, text: &str) -> bool {
        (0..self.calls()).any(|n| self.sent(n).iter().any(|m| m.contains(text)))
    }

    /// A background `shell` call for a command that ends once `release` exists.
    fn background(&self, id: &str, release: &Path, says: &str, wait: bool) -> MockTurn {
        MockProvider::tool_call(id, "shell", &json!({"command": common::wait_for_file(release, says), "background": true, "wait": wait}).to_string())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waited_command_brings_the_lead_back_with_its_result() {
    let tmp = tempfile::tempdir().unwrap();
    let release = tmp.path().join("release");
    let l = lead(tmp.path(), vec![]).await;
    l.script(l.background("c1", &release, "built", true));
    l.script(MockProvider::text("The build is running."));
    l.script(MockProvider::text("It passed."));
    l.send("run the build").await;
    l.turn_ends().await;

    // The call returned at once with the command's number and log.
    assert_eq!(l.calls(), 2, "the lead started the command, then ended its turn");
    let result = l.sent(1).into_iter().find(|m| m.starts_with("[Started in the background: command 1]")).expect("the call's result");
    let log = appv3_core::settings::settings().data_dir.join("sessions").join(&l.sid).join("commands").join("1.log");
    assert!(result.contains(&format!("Output: {}", log.display())) && result.contains("arrives as a message when it exits"), "{result}");

    // Its turn is over, and the session still counts as working.
    assert_eq!(l.session.state(), "idle");
    assert!(subagents::has_pending_work(&l.sid) && subagents::sessions_with_pending_work().contains(&l.sid), "a waited command is work coming back");
    assert_eq!(background_commands::running(&l.sid).len(), 1);

    // The command ends; nothing polled for it, and its result starts a turn.
    std::fs::write(&release, "").unwrap();
    wait_until("the lead to read the command's result", || l.read("[Background command 1 succeeded after")).await;
    l.turn_ends().await;
    assert_eq!(l.calls(), 3, "one more call, started by the result");
    let report = l.sent(2).into_iter().find(|m| m.contains("[Background command 1 succeeded after")).unwrap();
    assert!(report.contains("built") && report.contains(&log.display().to_string()), "{report}");
    assert!(!subagents::has_pending_work(&l.sid) && background_commands::running(&l.sid).is_empty());
    assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "built");

    // The report is a row from `shell`, not a prompt the user wrote.
    let rows = appv3_db::llm_window_rows(&l.pool, &l.sid, false).await.unwrap();
    let row = rows.iter().find(|r| r.extra_json().is_some_and(|e| e["from_agent"] == "shell")).expect("the report's row");
    let exit = &row.extra_json().unwrap()[background_commands::EXIT_KEY];
    assert_eq!((exit["number"].as_u64(), exit["exit_code"].as_i64(), exit["succeeded"].as_bool(), exit["end"].as_str()), (Some(1), Some(0), Some(true), Some("exited")), "{exit}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stored_credential_in_a_commands_output_is_masked_in_its_report() {
    use appv3_core::agent_secrets::{self, Change};
    let tmp = tempfile::tempdir().unwrap();
    let release = tmp.path().join("release");
    let l = lead(tmp.path(), vec![]).await;
    // Saved the way `PUT /api/secrets` saves one.
    let change = Change { value: Some("mask_me_bg_value_4321".into()), projects: Some(vec!["*".into()]), source: "chat".into(), ..Default::default() };
    appv3_core::credentials::update(|f| agent_secrets::set(f, "BG_API_KEY", change)).unwrap().unwrap();
    // The command prints the value, and the model typed it into the command.
    l.script(l.background("c1", &release, "key=mask_me_bg_value_4321", true));
    l.script(MockProvider::text("Deploying."));
    l.script(MockProvider::text("Deployed."));
    l.send("deploy").await;
    l.turn_ends().await;
    let listed = background_commands::shown(&background_commands::running(&l.sid)[0].command);
    assert!(listed.contains("[secret BG_API_KEY]") && !listed.contains("mask_me_bg_value_4321"), "{listed}");

    std::fs::write(&release, "").unwrap();
    wait_until("the lead to read the command's result", || l.read("[Background command 1 succeeded after")).await;
    l.turn_ends().await;
    let report = l.sent(2).into_iter().find(|m| m.contains("[Background command 1 succeeded after")).unwrap();
    assert!(report.contains("key=[secret BG_API_KEY]") && !report.contains("mask_me_bg_value_4321"), "{report}");
    let rows = appv3_db::llm_window_rows(&l.pool, &l.sid, false).await.unwrap();
    let row = rows.iter().find(|r| r.extra_json().is_some_and(|e| e["from_agent"] == "shell")).expect("the report's row");
    let stored = format!("{}\n{}", row.content.clone().unwrap_or_default(), row.extra_json().unwrap());
    assert!(!stored.contains("mask_me_bg_value_4321"), "{stored}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_command_not_waited_for_never_starts_a_turn_and_is_read_by_the_next() {
    let tmp = tempfile::tempdir().unwrap();
    let release = tmp.path().join("release");
    let l = lead(tmp.path(), vec![]).await;
    l.script(l.background("c1", &release, "served", false));
    l.script(MockProvider::text("The server is up."));
    l.script(MockProvider::text("It exited; restarting it."));
    l.send("start the server").await;
    l.turn_ends().await;
    assert!(l.sent(1).iter().any(|m| m.contains("If it exits, a message says so")), "{:?}", l.sent(1));
    assert!(!subagents::has_pending_work(&l.sid), "a server does not hold the session as working");
    assert_eq!(background_commands::running(&l.sid).len(), 1);

    std::fs::write(&release, "").unwrap();
    let reported = async || appv3_db::llm_window_rows(&l.pool, &l.sid, false).await.unwrap().iter().any(|r| r.extra_json().is_some_and(|e| e["from_agent"] == "shell"));
    wait_until_async("the server's exit to be saved", reported).await;
    assert!(!appv3_db::has_queued_user_messages(&l.pool, &l.sid).await.unwrap(), "its exit queued a message on an idle session");
    assert_eq!((l.calls(), l.session.state().as_str()), (2, "idle"));

    // The next turn reads the exit before the user's message (the model
    // gets two user rows in a row as one message).
    l.send("is it still up?").await;
    l.turn_ends().await;
    let sent = l.sent(2).join("\n");
    let exit = sent.find("[Background command 1 succeeded after").expect("the exit report");
    assert!(sent[exit..].contains("is it still up?"), "{sent}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_command_that_ends_while_the_lead_works_is_read_in_the_same_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let (crash, go_on) = (tmp.path().join("crash"), tmp.path().join("go-on"));
    let l = lead(tmp.path(), vec![]).await;
    l.script(l.background("c1", &crash, "crashed", false));
    // A foreground command keeps the turn open while the server dies.
    l.script(MockProvider::tool_call("c2", "shell", &json!({"command": common::wait_for_file(&go_on, "checked")}).to_string()));
    l.script(MockProvider::text("The server died; fixing it."));
    l.send("start the server and check it").await;
    wait_until("the foreground command to start", || l.calls() == 2).await;
    std::fs::write(&crash, "").unwrap();
    wait_until_async("the exit to be queued for the running turn", async || appv3_db::has_queued_user_messages(&l.pool, &l.sid).await.unwrap()).await;
    std::fs::write(&go_on, "").unwrap();
    l.turn_ends().await;
    assert_eq!(l.calls(), 3);
    assert!(l.sent(2).iter().any(|m| m.contains("[Background command 1 succeeded after") && m.contains("crashed")), "{:?}", l.sent(2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_holds_its_next_turn_until_a_waited_command_ends() {
    let tmp = tempfile::tempdir().unwrap();
    let release = tmp.path().join("release");
    let l = lead(tmp.path(), vec![]).await;
    l.script(l.background("c1", &release, "0 failed", true));
    l.script(MockProvider::text("Waiting for the tests."));
    l.script(MockProvider::text("They pass."));
    l.session.start_goal_from_plan(&l.sid, "The tests pass.", Some(2)).await.unwrap();
    l.send("The tests pass.").await;
    l.turn_ends().await;

    // The goal's first turn ended without a claim, and no second turn began.
    let goal = appv3_db::latest_session_goal(&l.pool, &l.sid).await.unwrap().expect("goal stored");
    assert_eq!((goal.status.as_str(), goal.turns_used), ("active", 1));
    assert_eq!((l.calls(), l.session.state().as_str()), (2, "idle"), "the goal went on while its command still ran");
    assert!(!appv3_db::has_queued_user_messages(&l.pool, &l.sid).await.unwrap(), "a goal reminder was queued behind the running command");

    // The command's result is the goal's next turn.
    std::fs::write(&release, "").unwrap();
    wait_until("the goal's next turn to read the result", || l.read("[Background command 1 succeeded after")).await;
    l.turn_ends().await;
    let goal = appv3_db::latest_session_goal(&l.pool, &l.sid).await.unwrap().unwrap();
    assert_eq!(goal.turns_used, 2, "the result's turn counted as the goal's second");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_ends_the_commands_the_session_waits_for_and_leaves_its_servers() {
    let tmp = tempfile::tempdir().unwrap();
    let never = tmp.path().join("never");
    let l = lead(tmp.path(), vec![]).await;
    l.script(l.background("c1", &never, "served", false));
    l.script(l.background("c2", &never, "built", true));
    l.script(MockProvider::text("Both are running."));
    l.send("start the server and the build").await;
    l.turn_ends().await;
    assert_eq!(background_commands::running(&l.sid).len(), 2);

    // The turn is over, and Stop still ends what the session waits for.
    appv3_agent::service::interrupt_agent(&l.session, Some(&l.sid)).await;
    let left: Vec<u64> = background_commands::running(&l.sid).iter().map(|j| j.number).collect();
    assert_eq!(left, [1], "Stop left the waited command running, or ended the server");
    assert!(!subagents::has_pending_work(&l.sid));
    assert!(!appv3_db::has_queued_user_messages(&l.pool, &l.sid).await.unwrap(), "a stopped command reported back");
    assert_eq!((l.calls(), l.session.state().as_str()), (3, "idle"), "Stop started a turn");

    // Stopping one command from the list tells the agent, if it is working.
    assert!(background_commands::stop(&l.sid, 1).await);
    assert!(background_commands::running(&l.sid).is_empty());
    assert!(!jobs::has_waited(&l.sid));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waited_command_the_user_stops_tells_the_lead() {
    let tmp = tempfile::tempdir().unwrap();
    let never = tmp.path().join("never");
    let l = lead(tmp.path(), vec![]).await;
    l.script(l.background("c1", &never, "built", true));
    l.script(MockProvider::text("The build is running."));
    l.script(MockProvider::text("You stopped it; what next?"));
    l.send("run the build").await;
    l.turn_ends().await;
    assert!(background_commands::stop(&l.sid, 1).await);
    wait_until("the lead to read that its command was stopped", || l.read("[Background command 1 was stopped by the user after")).await;
    l.turn_ends().await;
    assert_eq!(l.calls(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commands_cut_off_by_a_restart_are_reported_once() {
    let tmp = tempfile::tempdir().unwrap();
    let l = lead(tmp.path(), vec![MockProvider::text("I will run it again.")]).await;
    // What a server that stopped mid-command leaves behind.
    let dir = appv3_core::settings::settings().data_dir.join("sessions").join(&l.sid).join("commands");
    std::fs::create_dir_all(&dir).unwrap();
    let record = |n: u64, wait: bool, state: &str| {
        let v = json!({"number": n, "pid": 1, "command": format!("make step-{n}"), "wait": wait, "reports": true, "started_at": 0, "state": state});
        std::fs::write(dir.join(format!("{n}.json")), v.to_string()).unwrap();
    };
    record(1, false, "shutdown");
    record(2, true, "running");
    record(3, true, "exited");

    assert_eq!(background_commands::report_cut_off(&l.pool).await, 1);
    wait_until("the lead to read which commands were cut off", || l.read("OpenAgentd restarted")).await;
    l.turn_ends().await;
    let note = l.sent(0).into_iter().find(|m| m.contains("OpenAgentd restarted")).unwrap();
    assert!(note.contains("command 1 (`make step-1`)") && note.contains("command 2 (`make step-2`)") && !note.contains("step-3"), "{note}");
    assert!(note.contains(&dir.join("2.log").display().to_string()), "{note}");
    assert_eq!(background_commands::report_cut_off(&l.pool).await, 0, "a second start reported them again");
    assert_eq!(l.calls(), 1);
}
