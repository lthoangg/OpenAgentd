//! Text the model reads must only point at tools and commands the model has.
//! A stale name (a removed tool, a user slash command, a v2 tool) sends the
//! agent after something that fails, so these tests read the real prompt and
//! tool definitions of a lead turn and a delegated turn.

use appv3_agent::loader::{default_tool_registry, ProviderFactory};
use appv3_agent::prompts;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const TOOL_DEFINITIONS: &str = include_str!("../../tools/data/tool_definitions.json");

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
        std::env::set_var("USERPROFILE", root.path().join("home"));
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        std::fs::create_dir_all(root.path().join("project")).unwrap();
        root
    })
    .path()
}

/// The system prompt and tool definitions of the first model call of a turn.
async fn first_call(name: &str, delegated: bool) -> (String, Vec<Value>) {
    first_call_with(name, delegated, default_tool_registry().into_values().collect()).await
}

async fn first_call_with(name: &str, delegated: bool, tools: Vec<appv3_tools::ToolRef>) -> (String, Vec<Value>) {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join("project");
    let mock = Arc::new(MockProvider::new(vec![MockProvider::text("Done.")]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let parent = if delegated {
        appv3_agent::manager::init(pool.clone(), factory.clone());
        let id = uuid::Uuid::now_v7();
        appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), ..Default::default() }).await.unwrap();
        Some(id.to_string())
    } else {
        None
    };
    let agent = Agent::new(provider, name, prompts::coding_prompt(), tools, Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool, factory, parent);
    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    if let Some(mut sub) = store().attach(&sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("turn finishes");
    let calls = mock.calls.lock().unwrap();
    let (messages, tools, _) = calls.first().expect("the model was called");
    let system = match &messages[0] {
        ChatMessage::System { content, .. } => content.clone().unwrap_or_default(),
        other => panic!("first message is not the system prompt: {other:?}"),
    };
    (system, tools.clone().unwrap_or_default())
}

fn tool_names(defs: &[Value]) -> BTreeSet<String> {
    defs.iter().filter_map(|d| d.pointer("/function/name").and_then(Value::as_str).map(String::from)).collect()
}

fn strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        Value::Object(m) => m.values().for_each(|x| strings(x, out)),
        _ => {}
    }
}

fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            files_under(&p, out);
        } else {
            out.push(p);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_tool_definition_belongs_to_a_tool_an_agent_gets() {
    let (_, lead) = first_call("lead-tools", false).await;
    let (_, member) = first_call("member-tools", true).await;
    let mut live = tool_names(&lead);
    live.extend(tool_names(&member));
    // Opt-in tools a lead adds through `tools:` in its agent file.
    live.extend(default_tool_registry().into_keys());

    let defined: serde_json::Map<String, Value> = serde_json::from_str(TOOL_DEFINITIONS).unwrap();
    let orphans: Vec<&String> = defined.keys().filter(|n| !live.contains(*n)).collect();
    assert!(orphans.is_empty(), "tool_definitions.json describes tools no agent gets: {orphans:?}");
}

/// Every field needs a description, and no rule may sit in a schema key a
/// provider adapter drops (Gemini never sees `exclusiveMinimum`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_tool_schema_reaches_every_provider_intact() {
    let (_, lead) = first_call("lead-schema", false).await;
    let (_, member) = first_call("member-schema", true).await;
    let defined: serde_json::Map<String, Value> = serde_json::from_str(TOOL_DEFINITIONS).unwrap();

    let problems: Vec<String> = lead.iter().chain(&member).chain(defined.values()).flat_map(appv3_tools::schema_problems).collect();

    assert!(problems.is_empty(), "{problems:#?}");
}

/// Characters a coding lead's first request carries before any user text,
/// memory, or `AGENTS.md`: the system prompt plus every tool definition, as
/// they were before the prompt review. Every turn pays for this text, so a
/// change that grows it should be a deliberate one; raise the number then.
const LEAD_ALWAYS_ON_CHARS: usize = 35_849;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_coding_leads_always_on_text_stays_within_its_budget() {
    let registry = default_tool_registry();
    let mut names = prompts::coding_tools();
    names.extend(["skill", "todo_manage", "schedule_task"].map(String::from));
    let (system, mut tools) = first_call_with("budget", false, names.iter().map(|n| registry[n].clone()).collect()).await;
    // Leave out what differs by machine: the temp root and the shell's OS line.
    let root = root().display().to_string();
    let system = system.replace(&root, "").replace(&root.replace('\\', "/"), "");
    for t in tools.iter_mut().filter(|t| t["function"]["name"] == "shell") {
        let d = t["function"]["description"].as_str().unwrap().split(" Environment: ").next().unwrap().to_string();
        t["function"]["description"] = Value::String(d);
    }

    let total = system.chars().count() + serde_json::to_string(&tools).unwrap().chars().count();

    assert!(total <= LEAD_ALWAYS_ON_CHARS, "always-on text grew to {total} chars (budget {LEAD_ALWAYS_ON_CHARS})");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_facing_text_names_no_missing_tool_or_command() {
    let (lead_prompt, lead_tools) = first_call("lead-text", false).await;
    let (member_prompt, member_tools) = first_call("member-text", true).await;
    let mut texts = vec![lead_prompt, member_prompt];
    texts.extend([appv3_agent::agent::TRUNCATED_TOOL_CALL_NOTICE, appv3_agent::agent::TRUNCATED_REPLY_NOTICE].map(String::from));
    strings(prompts::contract(), &mut texts);
    strings(&Value::Array(lead_tools), &mut texts);
    strings(&Value::Array(member_tools), &mut texts);
    strings(&serde_json::from_str::<Value>(TOOL_DEFINITIONS).unwrap(), &mut texts);
    let mut skill_files = vec![];
    files_under(&Path::new(env!("CARGO_MANIFEST_DIR")).join("data/builtin_skills"), &mut skill_files);
    texts.extend(skill_files.iter().map(|p| std::fs::read_to_string(p).unwrap()));

    // Each was once in model-facing text and sent the agent somewhere it
    // cannot go.
    let stale = [
        ("/memory search", "a user slash command; the agent searches memory with grep or glob"),
        ("send_to_lead", "never registered; members answer in their final reply"),
        ("`lsp`", "the lsp tool is not registered"),
        ("skill-installer", "removed skill"),
        ("edit/patch", "there is no edit tool"),
        ("then read the file back", "patch reports failures; re-reading wastes a call"),
        ("`SKILL.md` back", "patch reports failures; re-reading wastes a call"),
    ];
    for (needle, why) in stale {
        let hits: Vec<String> = texts.iter().filter(|t| t.contains(needle)).map(|t| t.chars().take(120).collect()).collect();
        assert!(hits.is_empty(), "model-facing text mentions {needle:?} ({why}): {hits:?}");
    }
}
