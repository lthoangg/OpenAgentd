//! The session plan end to end: the `plan` tool writes it, `submit_plan`
//! pauses the turn for review, and the answer resumes the same turn.

use appv3_agent::agent::{SUBMIT_DEFERRED, SUBMIT_MERGED};
use appv3_agent::interaction_mode::PLAN_PROMPT_UPGRADE;
use appv3_agent::loader::ProviderFactory;
use appv3_agent::plan::{self, ReviewDecision};
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Settings are process-wide, so every test shares one set of roots.
fn root() -> &'static Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ] {
            std::env::set_var(k, dir.path().join(d));
        }
        std::env::set_var("HOME", dir.path().join("home"));
        std::env::set_var("USERPROFILE", dir.path().join("home"));
        std::env::remove_var("CHAT_WORKSPACE_DIR");
        std::fs::create_dir_all(dir.path().join("home")).unwrap();
        // Title generation would take scripted turns off the mock provider.
        std::fs::create_dir_all(dir.path().join("config")).unwrap();
        std::fs::write(dir.path().join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        dir
    })
    .path()
}

/// Stands in for the user editing the plan file while the turn runs.
struct UserEdit;

#[async_trait]
impl Tool for UserEdit {
    fn name(&self) -> &str {
        "user_edit"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let doc = plan::sync(&ctx.artifacts_dir()).expect("a plan to edit");
        std::fs::write(&doc.path, args["content"].as_str().unwrap()).unwrap();
        Ok(ToolOutput::text("edited"))
    }
}

struct Harness {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    provider: Arc<MockProvider>,
    sid: String,
    ws: PathBuf,
}

/// A lead session in `mode`, in a new git workspace (or in `ws` when given).
async fn harness(name: &str, mode: &str, ws: Option<PathBuf>, turns: Vec<MockTurn>) -> Harness {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = ws.unwrap_or_else(|| {
        let ws = root.join(name);
        std::fs::create_dir_all(&ws).unwrap();
        let ok = std::process::Command::new("git").args(["init", "-q"]).current_dir(&ws).status().unwrap().success();
        assert!(ok, "git init");
        ws
    });
    let provider = Arc::new(MockProvider::new(turns));
    let p: Arc<dyn LlmProvider> = provider.clone();
    let p2 = p.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(p, "code", "You are a test agent.", vec![Arc::new(UserEdit)], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let id = uuid::Uuid::now_v7();
    let new = appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), interaction_mode: Some(mode.into()), ..Default::default() };
    appv3_db::create_session(&pool, new).await.unwrap();
    Harness { pool, session, provider, sid: id.to_string(), ws }
}

impl Harness {
    /// Send a user message and wait until the turn ends or pauses.
    async fn send(&self, text: &str) {
        self.session.handle_user_message(UserMessage { content: text.into(), session_id: self.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
        self.settle().await;
    }

    async fn settle(&self) {
        tokio::time::timeout(Duration::from_secs(10), self.session.wait_turn_finished()).await.expect("turn settles");
    }

    /// Answer the open plan review the way the answer route does.
    async fn review(&self, decision: ReviewDecision, answer: &str) {
        let row = appv3_db::get_pending_question(&self.pool, &self.sid).await.unwrap().expect("an open review");
        let outcome = plan::resolve_review(&self.pool, &self.sid, &row, &decision, &json!([[answer]])).await.unwrap().expect("review was open");
        assert_eq!(outcome.approved, decision == ReviewDecision::Approve);
        self.session.resume_after_question_answer().await;
        self.settle().await;
    }

    /// The messages the provider was sent on call `i`.
    fn request(&self, i: usize) -> Vec<ChatMessage> {
        self.provider.calls.lock().unwrap()[i].0.clone()
    }

    fn last_tool_result(&self, i: usize) -> String {
        self.request(i).iter().rev().find(|m| matches!(m, ChatMessage::Tool { .. })).and_then(|m| m.content().map(String::from)).expect("a tool result")
    }

    async fn stored_result(&self, call: &str) -> String {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.iter().find(|r| r.tool_call_id.as_deref() == Some(call)).and_then(|r| r.content.clone()).expect("tool result row")
    }

    async fn mode(&self) -> String {
        appv3_db::get_session(&self.pool, &self.sid).await.unwrap().unwrap().interaction_mode
    }

    fn id8(&self) -> String {
        self.sid.replace('-', "")[24..].to_string()
    }

    fn data_dir(&self) -> PathBuf {
        root().join("data").join("sessions").join(&self.sid)
    }
}

fn write(content: &str) -> String {
    json!({"action": "write", "content": content}).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submit_pauses_and_approval_resumes_in_code_mode() {
    let h = harness(
        "approve",
        "plan",
        None,
        vec![
            MockProvider::tool_call("c1", "plan", &write("# Fix the bug\n1. Patch it")),
            MockProvider::tool_call("c2", "submit_plan", r#"{"summary": "Ready."}"#),
            MockProvider::text("Implementing step 1."),
        ],
    )
    .await;
    h.send("Plan the fix.").await;

    assert_eq!(h.session.state(), "waiting_input");
    let rel = format!(".openagentd/plans/fix-the-bug-{}.md", h.id8());
    assert_eq!(std::fs::read_to_string(h.ws.join(&rel)).unwrap(), "# Fix the bug\n1. Patch it\n");
    assert_eq!(std::fs::read_to_string(h.ws.join(".openagentd/plans/.gitignore")).unwrap(), "*\n");
    let status = std::process::Command::new("git").args(["status", "--porcelain"]).current_dir(&h.ws).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&status.stdout), "", "the plan stays out of git");
    assert_eq!(h.last_tool_result(1), format!("Plan saved as revision 1 (2 lines) at {rel}. Call submit_plan when it is ready for review."));
    let row = appv3_db::get_pending_question(&h.pool, &h.sid).await.unwrap().unwrap();
    assert_eq!((row.kind().as_deref(), row.plan_revision()), (Some("plan_review"), Some(1)));
    assert_eq!(row.questions()[0]["question"], "Review plan revision 1. Ready.");

    h.review(ReviewDecision::Approve, "Approve").await;
    assert_eq!(h.mode().await, "code");
    assert_eq!(h.session.state(), "idle");
    let resumed = h.request(2);
    let result = h.last_tool_result(2);
    assert!(result.starts_with("The user approved plan revision 1. The session is now in Code mode"), "{result}");
    assert!(result.contains(&format!("`{rel}`")), "{result}");
    assert!(resumed.iter().any(|m| m.content().is_some_and(|c| c.contains("## Code mode"))), "the Code-mode note follows the approval");
    assert_eq!(plan::sync(&h.data_dir()).unwrap().approved_revision, Some(1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn change_request_resumes_in_plan_mode_with_feedback() {
    let h = harness(
        "changes",
        "plan",
        None,
        vec![
            // The plan is written before the submission in the same response.
            MockProvider::tool_calls(&[("c1", "plan", &write("# Plan\n1. a\n2. b")), ("c2", "submit_plan", "{}"), ("c3", "submit_plan", "{}")]),
            MockProvider::text("Revising."),
        ],
    )
    .await;
    h.send("Plan it.").await;
    assert_eq!(h.session.state(), "waiting_input");
    assert_eq!(h.stored_result("c3").await, SUBMIT_MERGED);
    assert_eq!(appv3_db::get_pending_question(&h.pool, &h.sid).await.unwrap().unwrap().tool_call_id, "c2");

    h.review(ReviewDecision::Changes(Some("Drop step 2.".into())), "Drop step 2.").await;
    assert_eq!(h.mode().await, "plan");
    let result = h.last_tool_result(1);
    assert!(result.starts_with("The user requested changes to plan revision 1:\n\nDrop step 2.\n\nYou are still in Plan mode."), "{result}");
    assert_eq!(plan::sync(&h.data_dir()).unwrap().approved_revision, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submit_needs_a_plan() {
    let h = harness("code", "code", None, vec![MockProvider::tool_call("c1", "submit_plan", "{}"), MockProvider::text("OK.")]).await;
    h.send("Submit.").await;
    assert_eq!(h.session.state(), "idle");
    assert_eq!(h.last_tool_result(1), "Error: There is no plan to submit. Write it with the plan tool first.");
    assert!(appv3_db::get_pending_question(&h.pool, &h.sid).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submit_in_code_mode_pauses_and_approval_resumes_in_code_mode() {
    let h = harness(
        "approve_code",
        "code",
        None,
        vec![
            MockProvider::tool_calls(&[("c1", "plan", &write("# Fix the bug\n1. Patch it")), ("c2", "submit_plan", r#"{"summary": "Ready."}"#)]),
            MockProvider::text("Implementing step 1."),
        ],
    )
    .await;
    h.send("Plan the fix.").await;

    assert_eq!(h.session.state(), "waiting_input");
    let rel = format!(".openagentd/plans/fix-the-bug-{}.md", h.id8());
    let row = appv3_db::get_pending_question(&h.pool, &h.sid).await.unwrap().unwrap();
    assert_eq!((row.kind().as_deref(), row.plan_revision()), (Some("plan_review"), Some(1)));
    assert_eq!(row.questions()[0]["question"], "Review plan revision 1. Ready.");

    h.review(ReviewDecision::Approve, "Approve").await;
    assert_eq!(h.mode().await, "code");
    assert_eq!(h.session.state(), "idle");
    let result = h.last_tool_result(1);
    assert!(result.starts_with("The user approved plan revision 1. Implement the plan in"), "{result}");
    assert!(!result.contains("The session is now in Code mode"));
    assert!(result.contains(&format!("`{rel}`")), "{result}");
    assert_eq!(plan::sync(&h.data_dir()).unwrap().approved_revision, Some(1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn change_request_in_code_mode_resumes_in_code_mode_with_feedback() {
    let h = harness(
        "changes_code",
        "code",
        None,
        vec![MockProvider::tool_calls(&[("c1", "plan", &write("# Plan\n1. a\n2. b")), ("c2", "submit_plan", "{}")]), MockProvider::text("Revising in code mode.")],
    )
    .await;
    h.send("Plan it.").await;
    assert_eq!(h.session.state(), "waiting_input");

    h.review(ReviewDecision::Changes(Some("Drop step 2.".into())), "Drop step 2.").await;
    assert_eq!(h.mode().await, "code");
    let result = h.last_tool_result(1);
    assert!(result.starts_with("The user requested changes to plan revision 1:\n\nDrop step 2.\n\nAddress every point,"), "{result}");
    assert!(!result.contains("You are still in Plan mode."));
    assert_eq!(plan::sync(&h.data_dir()).unwrap().approved_revision, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ask_user_in_the_same_response_defers_submit() {
    let ask = json!({"questions": [{"question": "Which database?", "header": "DB"}]}).to_string();
    let h = harness(
        "defer",
        "plan",
        None,
        vec![MockProvider::tool_call("c1", "plan", &write("# Plan")), MockProvider::tool_calls(&[("c2", "submit_plan", "{}"), ("c3", "ask_user", &ask)])],
    )
    .await;
    h.send("Plan it.").await;
    assert_eq!(h.session.state(), "waiting_input");
    let row = appv3_db::get_pending_question(&h.pool, &h.sid).await.unwrap().unwrap();
    assert_eq!((row.tool_call_id.as_str(), row.kind()), ("c3", None), "the question is asked first");
    assert_eq!(h.stored_result("c2").await, SUBMIT_DEFERRED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outdated_plan_note_is_upgraded() {
    let h = harness("upgrade", "plan", None, vec![MockProvider::text("OK."), MockProvider::text("Still OK.")]).await;
    let mut extra = serde_json::Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert("interaction_mode".into(), json!("plan"));
    extra.insert("interaction_mode_prompt".into(), json!(true));
    let old = appv3_db::NewMessage { kind: Some("note".into()), pinned: Some(true), extra: Some(extra), ..appv3_db::NewMessage::user("Finish with a <proposed_plan> block.") };
    appv3_db::save_message(&h.pool, &h.sid, old).await.unwrap();

    h.send("Plan it.").await;
    h.send("And again.").await;
    // Consecutive user-side messages reach the model merged, so count text.
    let upgrades = |i: usize| h.request(i).iter().filter_map(|m| m.content()).map(|c| c.matches(PLAN_PROMPT_UPGRADE).count()).sum::<usize>();
    assert_eq!((upgrades(0), upgrades(1)), (1, 1), "added once, then kept");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_edit_is_announced_once() {
    let h = harness(
        "announce",
        "code",
        None,
        vec![MockProvider::tool_call("c1", "plan", &write("# Plan\n1. a")), MockProvider::text("Saved."), MockProvider::text("Seen."), MockProvider::text("Again.")],
    )
    .await;
    h.send("Write a plan.").await;
    let doc = plan::sync(&h.data_dir()).unwrap();
    std::fs::write(&doc.path, "# Plan\n1. a\n2. added in my editor\n").unwrap();

    // Consecutive user-side messages reach the model merged, so find the text.
    let notes = |i: usize| -> Vec<String> {
        h.request(i).iter().filter_map(|m| m.content()).flat_map(|c| c.match_indices("<plan_updated ").map(|(at, _)| c[at..].to_string()).collect::<Vec<_>>()).collect()
    };
    h.send("Continue.").await;
    let seen = notes(2);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(
        seen[0].starts_with(&format!("<plan_updated path=\".openagentd/plans/plan-{}.md\" revision=\"2\">\n# Plan\n1. a\n2. added in my editor\n</plan_updated>", h.id8())),
        "{}",
        seen[0]
    );
    h.send("Continue again.").await;
    assert_eq!(notes(3).len(), 1, "no second note for the same edit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_refuses_once_over_unseen_edits() {
    let h = harness(
        "guard",
        "code",
        None,
        vec![
            MockProvider::tool_call("c1", "plan", &write("# P\n1. a")),
            MockProvider::tool_call("c2", "user_edit", &json!({"content": "# P\n1. a (user)"}).to_string()),
            MockProvider::tool_call("c3", "plan", &write("# P\n1. mine")),
            MockProvider::tool_call("c4", "plan", &write("# P\n1. mine")),
            MockProvider::text("Done."),
        ],
    )
    .await;
    h.send("Plan.").await;
    let rel = format!(".openagentd/plans/p-{}.md", h.id8());
    assert_eq!(
        h.last_tool_result(3),
        format!("Error: The user edited the plan since you last saw it (revision 2). Read {rel} and apply your change with action \"edit\", or call write again to replace their version.")
    );
    assert_eq!(h.last_tool_result(4), format!("Plan saved as revision 3 (2 lines) at {rel}."));
    assert_eq!(std::fs::read_to_string(h.ws.join(&rel)).unwrap(), "# P\n1. mine\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_workspace_keeps_plan_in_data_dir() {
    let home = root().join("home");
    let h = harness("chat", "code", Some(home.clone()), vec![MockProvider::tool_call("c1", "plan", &write("# Chat plan")), MockProvider::text("Saved.")]).await;
    h.send("Plan.").await;
    let file = h.data_dir().join(plan::PLAN_FILENAME);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Chat plan\n");
    assert!(!home.join(".openagentd").exists());
    let result = h.last_tool_result(1);
    assert!(result.starts_with("Plan saved as revision 1 (1 line) at "), "{result}");
    assert!(result.contains(&h.sid), "{result}");
    assert!(result.ends_with(&format!("{}.", plan::PLAN_FILENAME)), "{result}");
}
