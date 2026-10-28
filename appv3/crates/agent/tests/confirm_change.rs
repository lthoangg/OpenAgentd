//! Changes the user confirms on a card (`appv3_agent::confirm`), end to end
//! through `workspace(action='set_groups')`: the call pauses the turn, only
//! **Apply** changes anything, it applies once, and it re-checks the state
//! it was proposed against.

use appv3_agent::confirm::{self, CONFIRM_DEFERRED, CONFIRM_KIND};
use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::tools::workspace::WorkspaceTool;
use appv3_agent::Agent;
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::{Tool, ToolContext, ToolError};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

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
        std::fs::create_dir_all(dir.path().join("config")).unwrap();
        std::fs::write(dir.path().join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        dir
    })
    .path()
}

/// Registered repositories `api` and `web` (`web` in group `acme`), and a
/// worktree of `api`.
struct Repos {
    api: String,
    web: String,
    api_wt: String,
    acme: String,
}

async fn repos(pool: &appv3_db::DbPool, name: &str) -> Repos {
    let base = root().join(name);
    let mk = |d: &str| {
        let p = base.join(d);
        std::fs::create_dir_all(&p).unwrap();
        appv3_db::resolve_path(&p.display().to_string())
    };
    let (api, web, api_wt) = (mk("api"), mk("web"), mk("api-wt"));
    appv3_db::upsert_coding_workspace(pool, &api, "repo", None, None, false, false).await.unwrap();
    appv3_db::upsert_coding_workspace(pool, &web, "repo", None, None, false, false).await.unwrap();
    appv3_db::upsert_coding_workspace(pool, &api_wt, "worktree", Some(&api), None, false, false).await.unwrap();
    let acme = appv3_db::create_workspace_group(pool, "acme", None, None).await.unwrap().id;
    appv3_db::set_workspace_groups(pool, &web, std::slice::from_ref(&acme)).await.unwrap();
    Repos { api, web, api_wt, acme }
}

async fn groups_of(pool: &appv3_db::DbPool, path: &str) -> Vec<String> {
    let names: Vec<(String, String)> = appv3_db::list_workspace_groups(pool).await.unwrap().into_iter().map(|g| (g.id, g.name)).collect();
    appv3_db::list_group_memberships(pool)
        .await
        .unwrap()
        .into_iter()
        .filter(|(_, p)| p == path)
        .filter_map(|(g, _)| names.iter().find(|(id, _)| *id == g).map(|(_, n)| n.clone()))
        .collect()
}

struct Harness {
    pool: appv3_db::DbPool,
    session: Arc<AgentSession>,
    provider: Arc<MockProvider>,
    sid: String,
    repos: Repos,
}

async fn harness(name: &str, turns: Vec<MockTurn>) -> Harness {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let repos = repos(&pool, name).await;
    let provider = Arc::new(MockProvider::new(turns));
    let p: Arc<dyn LlmProvider> = provider.clone();
    let p2 = p.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    let tool = Arc::new(WorkspaceTool::new(sid.clone(), pool.clone()));
    let agent = Agent::new(p, "code", "You are a test agent.", vec![tool], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(repos.api.clone()), pool.clone(), factory, None);
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: repos.api.clone(), ..Default::default() }).await.unwrap();
    Harness { pool, session, provider, sid, repos }
}

impl Harness {
    async fn send(&self, text: &str) {
        self.session.handle_user_message(UserMessage { content: text.into(), session_id: self.sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
        self.settle().await;
    }

    async fn settle(&self) {
        tokio::time::timeout(Duration::from_secs(10), self.session.wait_turn_finished()).await.expect("turn settles");
    }

    async fn card(&self) -> appv3_db::PendingQuestion {
        let row = appv3_db::get_pending_question(&self.pool, &self.sid).await.unwrap().expect("an open card");
        assert_eq!(row.kind().as_deref(), Some(CONFIRM_KIND));
        row
    }

    async fn answer(&self, row: &appv3_db::PendingQuestion, answer: &str) -> Option<String> {
        let qid = appv3_db::codec::api_uuid(&row.id);
        confirm::answer(&self.pool, &self.sid, &qid, &[vec![answer.to_string()]]).await.unwrap()
    }

    fn last_tool_result(&self, i: usize) -> String {
        let calls = self.provider.calls.lock().unwrap();
        calls[i].0.iter().rev().find(|m| matches!(m, ChatMessage::Tool { .. })).and_then(|m| m.content().map(String::from)).expect("a tool result")
    }
}

fn join(workspace: &str, groups: &[&str]) -> String {
    json!({"action": "set_groups", "workspace": workspace, "join": groups}).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_group_change_waits_for_apply_and_applies_once() {
    let wt = root().join("apply").join("api-wt").display().to_string();
    let h = harness("apply", vec![MockProvider::tool_call("c1", "workspace", &join(&wt, &["acme"])), MockProvider::text("Grouped.")]).await;
    assert_eq!(appv3_db::resolve_path(&wt), h.repos.api_wt);
    h.send("Group this repo with web.").await;

    assert_eq!(h.session.state(), "waiting_input", "the call pauses the turn");
    let row = h.card().await;
    let change = confirm::change_of(&row).unwrap();
    assert_eq!(change["repo"], json!(h.repos.api), "a worktree is grouped through its repository");
    let q = row.questions()[0]["question"].as_str().unwrap().to_string();
    assert!(q.contains("join `acme`") && q.contains("Agents in **api** and **web** can then message each other."), "{q}");
    assert!(groups_of(&h.pool, &h.repos.api).await.is_empty(), "nothing changes before Apply");

    let text = h.answer(&row, "Apply").await.expect("the card was open");
    assert_eq!(text, "The user applied the change. 'api' is now in groups: acme. It can message (and be messaged by): web.");
    assert_eq!(groups_of(&h.pool, &h.repos.api).await, vec!["acme"]);
    assert_eq!(h.answer(&row, "Apply").await, None, "a second answer applies nothing");

    h.session.resume_after_question_answer().await;
    h.settle().await;
    assert_eq!(h.last_tool_result(1), text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_or_a_typed_answer_changes_nothing() {
    let h = harness(
        "cancel",
        vec![MockProvider::tool_call("c1", "workspace", &join("api", &["acme"])), MockProvider::tool_call("c2", "workspace", &join("api", &["acme"])), MockProvider::text("OK.")],
    )
    .await;
    h.send("Group api with web.").await;
    let text = h.answer(&h.card().await, "Cancel").await.unwrap();
    assert!(text.starts_with("The user cancelled the change; nothing changed."), "{text}");
    h.session.resume_after_question_answer().await;
    h.settle().await;

    let text = h.answer(&h.card().await, "Put it in a new group 'backend' instead").await.unwrap();
    assert_eq!(text, "The user did not apply the change; nothing changed. They said:\n\nPut it in a new group 'backend' instead");
    assert!(groups_of(&h.pool, &h.repos.api).await.is_empty());
    h.session.resume_after_question_answer().await;
    h.settle().await;
    assert_eq!(h.last_tool_result(2), text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_rechecks_what_the_card_showed() {
    let h = harness(
        "recheck",
        vec![
            MockProvider::tool_call("c1", "workspace", &join("api", &["acme"])),
            MockProvider::tool_call("c2", "workspace", &join("api", &["backend"])),
            MockProvider::text("OK."),
        ],
    )
    .await;
    h.send("Group api with web.").await;
    let row = h.card().await;
    // The user changes api's groups in Settings while the card is open.
    let other = appv3_db::create_workspace_group(&h.pool, "other", None, None).await.unwrap().id;
    appv3_db::set_workspace_groups(&h.pool, &h.repos.api, std::slice::from_ref(&other)).await.unwrap();
    let text = h.answer(&row, "Apply").await.unwrap();
    assert!(text.contains("not applied: the groups of 'api' changed since this was proposed."), "{text}");
    assert_eq!(groups_of(&h.pool, &h.repos.api).await, vec!["other"]);
    h.session.resume_after_question_answer().await;
    h.settle().await;

    // A new group the card announced is created by someone else first.
    let row = h.card().await;
    let q = row.questions()[0]["question"].as_str().unwrap().to_string();
    assert!(q.contains("join `backend (new)`") && q.contains("does not change"), "{q}");
    let backend = appv3_db::create_workspace_group(&h.pool, "backend", None, None).await.unwrap().id;
    appv3_db::set_workspace_groups(&h.pool, &h.repos.web, &[h.repos.acme.clone(), backend]).await.unwrap();
    let text = h.answer(&row, "Apply").await.unwrap();
    assert!(text.contains("not applied: a group named 'backend' was created since this was proposed"), "{text}");
    assert_eq!(groups_of(&h.pool, &h.repos.api).await, vec!["other"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_change_is_confirmed_at_a_time() {
    let h =
        harness("two", vec![MockProvider::tool_calls(&[("c1", "workspace", &join("api", &["acme"])), ("c2", "workspace", &join("web", &["backend"]))]), MockProvider::text("OK.")])
            .await;
    h.send("Group them.").await;
    let row = h.card().await;
    assert_eq!(row.tool_call_id, "c1");
    h.answer(&row, "Cancel").await.unwrap();
    h.session.resume_after_question_answer().await;
    h.settle().await;
    let calls = h.provider.calls.lock().unwrap();
    let deferred = calls[1].0.iter().find(|m| matches!(m, ChatMessage::Tool { tool_call_id, .. } if tool_call_id == "c2")).and_then(|m| m.content().map(String::from));
    assert_eq!(deferred.as_deref(), Some(CONFIRM_DEFERRED));
}

fn ctx(ws: &str, sid: &str, mode: Option<&str>) -> ToolContext {
    let mut metadata = serde_json::Map::new();
    if let Some(m) = mode {
        metadata.insert("interaction_mode".into(), json!(m));
    }
    ToolContext {
        session_id: Some(sid.into()),
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::with(Path::new(ws), None, Some(vec![]), Some(vec![]))),
        workspace: Some(ws.into()),
        output: None,
        metadata: Arc::new(std::sync::Mutex::new(metadata)),
        messages: None,
    }
}

async fn text(tool: &WorkspaceTool, c: &ToolContext, args: Value) -> String {
    match tool.run(c, args).await {
        Ok(o) => format!("{o:?}"),
        Err(ToolError::Suspended(_)) => "suspended".into(),
        Err(e) => e.to_string(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unregistered_chat_and_plan_mode_are_refused() {
    let root = root();
    let pool = appv3_db::create_pool(root.join("refused.db")).await.unwrap();
    let r = repos(&pool, "refused").await;
    let sid = uuid::Uuid::now_v7();
    appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(sid), workspace: r.api.clone(), ..Default::default() }).await.unwrap();
    let tool = WorkspaceTool::new(sid.to_string(), pool.clone());
    let code = ctx(&r.api, &sid.to_string(), None);

    let unregistered: PathBuf = root.join("refused").join("elsewhere");
    let t = text(&tool, &code, json!({"action": "set_groups", "workspace": unregistered.display().to_string(), "join": ["acme"]})).await;
    assert!(t.contains("is not a workspace registered in OpenAgentd") && t.contains("paths are not registered from chat"), "{t}");
    let chat = appv3_core::settings::settings().chat_workspace_root().display().to_string();
    let t = text(&tool, &code, json!({"action": "set_groups", "workspace": chat, "join": ["acme"]})).await;
    assert!(t.contains("Chat is in no group"), "{t}");
    let t = text(&tool, &code, json!({"action": "set_groups", "workspace": "web", "join": ["acme"]})).await;
    assert!(t.contains("No change"), "{t}");
    let t = text(&tool, &code, json!({"action": "set_groups", "workspace": "web"})).await;
    assert!(t.contains("needs group names in join, leave, or both"), "{t}");
    let t = text(&tool, &code, json!({"action": "set_groups", "workspace": "web", "leave": ["nope"]})).await;
    assert!(t.contains("no group named 'nope'"), "{t}");
    assert!(appv3_db::get_pending_question(&pool, &sid.to_string()).await.unwrap().is_none(), "no card for a refused change");

    let plan = ctx(&r.api, &sid.to_string(), Some("plan"));
    let t = text(&tool, &plan, json!({"action": "set_groups", "workspace": "api", "join": ["acme"]})).await;
    assert!(t.contains("unavailable in Plan mode; only action='list' is"), "{t}");
    let t = text(&tool, &plan, json!({"workspace": "web", "message": "hi"})).await;
    assert!(t.contains("unavailable in Plan mode"), "{t}");
    let t = text(&tool, &plan, json!({"action": "list"})).await;
    assert!(t.contains("Workspaces you can message"), "{t}");
    assert!(groups_of(&pool, &r.api).await.is_empty());
}
