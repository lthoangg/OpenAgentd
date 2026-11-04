//! The first request a lead turn, a member turn and a goal turn send to the
//! model, compared byte for byte with a stored snapshot.
//!
//! The tool definitions and the system prompt open the cached prompt
//! prefix, so a change to how tools are assembled must not move a byte of
//! them for a user who installed nothing. Machine-specific text (the temp
//! root, ids, the shell's environment line) is normalised first. After a
//! deliberate prompt or tool change, rewrite the snapshot with
//! `UPDATE_REQUEST_SNAPSHOT=1 cargo test -p appv3-agent --test request_snapshot`.

use appv3_agent::loader::{self, ProviderFactory};
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::tools::team::DelegateTool;
use appv3_agent::{manager, store};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::denied::DeniedPaths;
use appv3_tools::{Tool, ToolContext};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const SNAPSHOT: &str = "tests/snapshots/requests.json";

/// Settings are process-wide, so every scenario shares one set of roots.
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
        std::env::set_var("USERPROFILE", root.path().join("home"));
        std::env::set_var("OPENAGENTD_SHELL_SNAPSHOT", "false");
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        std::fs::create_dir_all(root.path().join("config")).unwrap();
        std::fs::write(root.path().join("config/settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
        std::fs::create_dir_all(root.path().join("agents")).unwrap();
        root
    })
    .path()
}

/// The first model call of a lead turn of the agent defined by `agent_md`,
/// with a goal running when `goal` is set.
async fn lead_request(name: &str, agent_md: &str, goal: bool) -> Value {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let mock = Arc::new(MockProvider::new(vec![MockProvider::text("Done."), MockProvider::text(&json!({"met": true, "reason": "done"}).to_string())]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let md = root.join("agents").join(format!("{name}.md"));
    std::fs::write(&md, agent_md).unwrap();
    let agent = loader::rebuild_agent_from_disk(&md, &factory).unwrap();
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let sid = uuid::Uuid::now_v7().to_string();
    if goal {
        let id = uuid::Uuid::parse_str(&sid).unwrap();
        appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), ..Default::default() }).await.unwrap();
        session.start_goal_from_plan(&sid, "ship the release notes", Some(1)).await.unwrap();
    }
    session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    if let Some(mut sub) = store().attach(&sid) {
        let _ = tokio::time::timeout(Duration::from_secs(20), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(20), session.wait_turn_finished()).await.expect("turn finishes");
    let calls = mock.calls.lock().unwrap();
    render(calls.first().expect("the model was called"))
}

/// The first model call of a member the lead delegates to through `team`,
/// built the way a real delegation builds it (profile, tools, team context).
async fn member_request() -> Value {
    let root = root();
    let pool = appv3_db::create_pool(root.join("member.db")).await.unwrap();
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:lead\ntools: []\n---\nYou lead.\n").unwrap();
    std::fs::write(
        agents.join("explorer.md"),
        "---\nname: explorer\nrole: member\ndescription: Explores the codebase.\nmodel: mock:member\ntools: [read, grep, glob, shell, web_fetch, todo, team]\n---\nYou explore.\n",
    )
    .unwrap();
    let (lead_mock, member_mock) = (Arc::new(MockProvider::new(vec![])), Arc::new(MockProvider::new(vec![MockProvider::text("Mapped.")])));
    let (lead_p, member_p): (Arc<dyn LlmProvider>, Arc<dyn LlmProvider>) = (lead_mock, member_mock.clone());
    let factory: ProviderFactory = Arc::new(move |model, _| Ok(if model == Some("mock:member") { member_p.clone() } else { lead_p.clone() }));
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
    delegate.run(&ctx, json!({"profile": "explorer", "task": "map the code"})).await.expect("delegated");
    let deadline = Instant::now() + Duration::from_secs(20);
    while member_mock.calls.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "the member never called the model");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let calls = member_mock.calls.lock().unwrap();
    render(&calls[0])
}

fn render((messages, tools, kwargs): &appv3_providers::mock::MockCall) -> Value {
    let messages: Vec<Value> = messages
        .iter()
        .map(|m| match m {
            ChatMessage::System { content, .. } => json!({"role": "system", "content": content}),
            ChatMessage::User { content, parts, .. } => json!({"role": "user", "content": content, "parts": parts.as_ref().map(|p| format!("{p:?}"))}),
            ChatMessage::Assistant(a) => json!({"role": "assistant", "debug": format!("{a:?}")}),
            ChatMessage::Tool { content, tool_call_id, name, .. } => json!({"role": "tool", "content": content, "tool_call_id": tool_call_id, "name": name}),
        })
        .collect();
    let kwargs: serde_json::Map<String, Value> = kwargs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    normalize(json!({"messages": messages, "tools": tools, "kwargs": kwargs}))
}

/// Replaces what differs by machine and by run.
fn normalize(v: Value) -> Value {
    let canonical = std::fs::canonicalize(root()).unwrap().display().to_string();
    let mut roots = vec![canonical.trim_start_matches(r"\\?\").to_string(), canonical.clone(), root().display().to_string()];
    roots.extend(roots.clone().iter().map(|r| r.replace('\\', "/")));
    roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let uuid = regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap();
    let today = regex::Regex::new(r"Current date \(UTC\): \d{4}-\d{2}-\d{2}").unwrap();
    // A path under the root, which Windows writes with backslashes.
    let under_root = regex::Regex::new(r"<ROOT>[^\s`'\x22)]*").unwrap();
    fn walk(v: Value, f: &dyn Fn(&str) -> String) -> Value {
        match v {
            Value::String(s) => Value::String(f(&s)),
            Value::Array(a) => Value::Array(a.into_iter().map(|x| walk(x, f)).collect()),
            Value::Object(m) => Value::Object(m.into_iter().map(|(k, x)| (k, walk(x, f))).collect()),
            other => other,
        }
    }
    walk(v, &|s: &str| {
        let s = roots.iter().fold(s.to_string(), |s, r| s.replace(r.as_str(), "<ROOT>"));
        let s = under_root.replace_all(&s, |m: &regex::Captures| m[0].replace('\\', "/")).into_owned();
        let s = uuid.replace_all(&s, "<UUID>").into_owned();
        let s = today.replace_all(&s, "Current date (UTC): <DATE>").into_owned();
        match s.split_once(" Environment: ") {
            Some((head, _)) if head.contains("shell") || head.contains("command") => format!("{head} Environment: <ENV>"),
            _ => s,
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_match_the_snapshot() {
    let lead = lead_request("code", "---\nname: code\nmodel: mock:mock\n---\n", false).await;
    let member = member_request().await;
    let goal = lead_request("goal", "---\nname: goal\nmodel: mock:mock\ntools: [read, shell, generate_image]\n---\nYou work toward goals.\n", true).await;
    let got = serde_json::to_string_pretty(&json!({"lead": lead, "member": member, "goal": goal})).unwrap() + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SNAPSHOT);
    if std::env::var_os("UPDATE_REQUEST_SNAPSHOT").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).expect("snapshot exists; create it with UPDATE_REQUEST_SNAPSHOT=1");
    if got != want {
        let first_diff = got.lines().zip(want.lines()).enumerate().find(|(_, (g, w))| g != w).map(|(i, (g, w))| format!("line {}:\n  got:  {g}\n  want: {w}", i + 1));
        panic!("the model request changed; {}", first_diff.unwrap_or_else(|| "lengths differ".into()));
    }
}
