//! The `script` tool end to end: a mock model calls `script`, the script's
//! nested calls run through the agent loop, and the model reads one result.
//! Nested calls get the same Plan-mode, denied-path and plugin-hook checks
//! as direct calls, and a saved script runs again in a new session.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::plugins::{PluginCtx, ToolHooks, ToolPlugin};
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::stream_store::store;
use appv3_agent::Agent;
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, LlmProvider};
use appv3_tools::ToolRef;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

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
        root
    })
    .path()
}

/// A plugin hook that records every call it wraps and blocks `blocked.txt`.
#[derive(Default)]
struct Recorder(Mutex<Vec<(String, String)>>);

#[async_trait::async_trait]
impl ToolPlugin for Recorder {
    fn id(&self) -> &str {
        "recorder"
    }
    fn has_before(&self) -> bool {
        true
    }
    async fn before(&self, ctx: &PluginCtx<'_>, args: &mut Value) -> Result<(), String> {
        self.0.lock().unwrap().push((ctx.tool.to_string(), ctx.call_id.to_string()));
        if args.get("path").and_then(Value::as_str) == Some("blocked.txt") {
            return Err("blocked by the recorder plugin".into());
        }
        Ok(())
    }
}

struct RecorderModule(Arc<Recorder>);

#[async_trait::async_trait]
impl appv3_kernel::Module for RecorderModule {
    fn id(&self) -> &str {
        "test-recorder"
    }
    fn register(&self, r: &mut appv3_kernel::Registrar) -> anyhow::Result<()> {
        r.add(ToolHooks(self.0.clone()));
        Ok(())
    }
}

fn recorder() -> &'static Arc<Recorder> {
    static R: OnceLock<Arc<Recorder>> = OnceLock::new();
    R.get_or_init(|| {
        let r = Arc::new(Recorder::default());
        appv3_kernel::global().add(RecorderModule(r.clone())).unwrap();
        r
    })
}

fn tools() -> Vec<ToolRef> {
    vec![
        Arc::new(appv3_agent::tools::script::ScriptTool),
        Arc::new(appv3_tools::read::ReadTool),
        Arc::new(appv3_tools::grep::GrepTool),
        Arc::new(appv3_tools::glob::GlobTool),
        Arc::new(appv3_tools::todo::TodoTool),
    ]
}

struct Run {
    provider: Arc<MockProvider>,
    pool: appv3_db::DbPool,
    sid: String,
    /// The live feed of the turn: (event name, data).
    events: Vec<(String, Value)>,
}

impl Run {
    /// The tool result the model read for call `id`.
    fn result(&self, id: &str) -> String {
        let calls = self.provider.calls.lock().unwrap();
        for (messages, _, _) in calls.iter() {
            for m in messages {
                if let ChatMessage::Tool { tool_call_id, content, .. } = m {
                    if tool_call_id == id {
                        return content.clone().unwrap_or_default();
                    }
                }
            }
        }
        panic!("no result for {id}")
    }
    async fn stored(&self, id: &str) -> String {
        let rows = appv3_db::llm_window_rows(&self.pool, &self.sid, false).await.unwrap();
        rows.iter().find(|r| r.tool_call_id.as_deref() == Some(id)).and_then(|r| r.content.clone()).expect("stored tool result")
    }
}

/// One turn in a new session on `ws` in `mode`: the model makes `calls`, then answers.
async fn turn(name: &str, ws: &Path, mode: &str, calls: &[(&str, &str, &str)]) -> Run {
    let pool = appv3_db::create_pool(root().join(format!("{name}.db"))).await.unwrap();
    let turns: Vec<MockTurn> = vec![MockProvider::tool_calls(calls), MockProvider::text("Done.")];
    let provider = Arc::new(MockProvider::new(turns));
    let p: Arc<dyn LlmProvider> = provider.clone();
    let p2 = p.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(p, "code", "You are a test agent.", tools(), Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);
    let id = uuid::Uuid::now_v7();
    let new = appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), interaction_mode: Some(mode.into()), ..Default::default() };
    appv3_db::create_session(&pool, new).await.unwrap();
    let sid = id.to_string();
    session.handle_user_message(UserMessage { content: "go".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let mut events = vec![];
    if let Some(mut sub) = store().attach(&sid) {
        let _ = tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(e) = sub.next().await {
                events.push((e.event.clone(), serde_json::from_str(&e.data).unwrap_or(Value::Null)));
            }
        })
        .await;
    }
    tokio::time::timeout(Duration::from_secs(30), session.wait_turn_finished()).await.expect("turn settles");
    Run { provider, pool, sid, events }
}

fn workspace(name: &str) -> PathBuf {
    let ws = root().join(name);
    std::fs::create_dir_all(ws.join("src")).unwrap();
    std::fs::write(ws.join("src/a.txt"), "TODO one\nfine\nTODO two\n").unwrap();
    std::fs::write(ws.join("src/b.txt"), "TODO three\n").unwrap();
    std::fs::write(ws.join(".env"), "SECRET=1\n").unwrap();
    ws
}

fn script(code: &str) -> String {
    json!({ "description": "test", "code": code }).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_script_call_chains_glob_and_reads_and_returns_a_short_result() {
    let ws = workspace("chain");
    let code = r#"
const files = (await tools.glob({ pattern: "src/*.txt" })).split("\n").filter(f => f.endsWith(".txt"));
const texts = await Promise.all(files.map(path => tools.read({ path })));
const counts = files.map((f, i) => [f, (texts[i].match(/TODO/g) || []).length]);
console.log(`${files.length} files`);
return counts;
"#;
    let run = turn("chain", &ws, "code", &[("s1", "script", &script(code))]).await;
    let text = run.result("s1");
    // glob and read show the platform's separator.
    let a = format!("src{}a.txt", std::path::MAIN_SEPARATOR);
    assert!(text.starts_with("calls (3, "), "{text}");
    assert!(text.contains("→ glob src/*.txt · "), "{text}");
    assert!(text.contains(&format!("→ read {a} · ")), "{text}");
    assert!(text.contains(&format!("output:\n2 files\n[\n  [\n    {},\n    2\n  ],", json!(a))), "{text}");
    assert!(!text.contains("error:"), "{text}");
    // Only the script call reached the transcript, and a reload reads the same text.
    let rows = appv3_db::llm_window_rows(&run.pool, &run.sid, false).await.unwrap();
    assert_eq!(rows.iter().filter(|r| r.tool_call_id.is_some() && r.role == "tool").count(), 1);
    assert_eq!(run.stored("s1").await, text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_nested_call_tells_the_live_feed_it_ended_without_a_card_of_its_own() {
    let ws = workspace("nested-events");
    let code = r#"
await tools.todo({ actions: [{ action: "create", content: "from a script" }] });
await tools.read({ path: "src/b.txt" });
"#;
    let run = turn("nested-events", &ws, "code", &[("s1", "script", &script(code))]).await;
    assert!(!run.result("s1").contains("error:"), "{}", run.result("s1"));
    let nested: Vec<&Value> = run.events.iter().filter(|(e, _)| e == "nested_tool_end").map(|(_, d)| d).collect();
    assert_eq!(nested.len(), 2, "{:?}", run.events);
    assert_eq!(nested[0]["name"], "todo");
    assert_eq!(nested[0]["tool_call_id"], "s1.1");
    assert_eq!(nested[0]["agent"], "code");
    assert!(nested[0]["arguments"].as_str().unwrap_or_default().contains("from a script"), "{}", nested[0]);
    assert_eq!(nested[1]["name"], "read");
    assert_eq!(nested[1]["tool_call_id"], "s1.2");
    // The script keeps the only card: no tool_start or tool_end for the nested calls.
    let carded: Vec<&str> = run.events.iter().filter(|(e, _)| e == "tool_start" || e == "tool_end").map(|(_, d)| d["name"].as_str().unwrap_or_default()).collect();
    assert_eq!(carded, ["script", "script"], "{:?}", run.events);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plan_mode_refuses_a_nested_call_exactly_as_a_direct_one() {
    let ws = workspace("plan");
    let code = r#"
try { await tools.todo({ actions: [{ action: "read" }] }); } catch (e) { console.log("todo:", e.message); }
console.log("read:", (await tools.read({ path: "src/b.txt" })).includes("TODO three"));
"#;
    let run = turn("plan", &ws, "plan", &[("s1", "script", &script(code)), ("d1", "todo", r#"{"actions":[{"action":"read"}]}"#)]).await;
    let direct = run.result("d1");
    assert_eq!(direct, "Error: Tool 'todo' is unavailable in Plan mode.");
    let text = run.result("s1");
    assert!(text.contains("todo: Tool 'todo' is unavailable in Plan mode.\nread: true"), "{text}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn denied_paths_stop_a_nested_call_exactly_as_a_direct_one() {
    let ws = workspace("denied");
    let code = r#"try { await tools.read({ path: ".env" }); } catch (e) { return e.message; }"#;
    let run = turn("denied", &ws, "code", &[("s1", "script", &script(code)), ("d1", "read", r#"{"path":".env"}"#)]).await;
    let direct = run.result("d1");
    assert!(direct.starts_with("Error: Path '") && direct.contains("denied root: **/.env"), "{direct}");
    let text = run.result("s1");
    assert!(text.contains(&format!("output:\n{}", direct.trim_start_matches("Error: "))), "{text}\n---\n{direct}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plugin_hooks_see_and_can_block_nested_calls() {
    let rec = recorder();
    appv3_kernel::global().start("test-recorder").await.unwrap();
    let ws = workspace("hooks");
    std::fs::write(ws.join("blocked.txt"), "x").unwrap();
    let code = r#"
await tools.read({ path: "src/a.txt" });
try { await tools.read({ path: "blocked.txt" }); } catch (e) { console.log(e.message); }
"#;
    let run = turn("hooks", &ws, "code", &[("hooked", "script", &script(code))]).await;
    let text = run.result("hooked");
    assert!(text.contains("blocked by the recorder plugin"), "{text}");
    let seen = rec.0.lock().unwrap().clone();
    for want in [("script", "hooked"), ("read", "hooked.1"), ("read", "hooked.2")] {
        assert!(seen.iter().any(|(t, c)| t == want.0 && c == want.1), "{want:?} not in {seen:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_script_cannot_ask_delegate_or_start_another_script() {
    let ws = workspace("refused");
    let code = r#"
for (const t of ["script", "ask_user", "plan", "team"]) {
  try { await tools[t]({}); } catch (e) { console.log(e.message); }
}
"#;
    let run = turn("refused", &ws, "code", &[("s1", "script", &script(code))]).await;
    let text = run.result("s1");
    for t in ["script", "ask_user", "plan", "team"] {
        assert!(text.contains(&format!("{t} cannot be called from a script")), "{t}: {text}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_saved_script_runs_again_in_a_new_session_by_path_and_by_name() {
    let ws = workspace("saved");
    let code = r#"// @arg pattern  What to count. Default "TODO".
const pattern = args.pattern ?? "TODO";
const hits = await tools.grep({ pattern, directory: "src" });
return hits.split("\n").filter(l => l.includes(pattern)).length;"#;
    let save = json!({ "description": "Count matches in src", "code": code, "save_as": "count-hits" }).to_string();
    let run = turn("saved-1", &ws, "code", &[("s1", "script", &save)]).await;
    let text = run.result("s1");
    assert!(text.contains("output:\n3\nsaved as count-hits (.agents/scripts/count-hits.ts)"), "{text}");
    let file = std::fs::read_to_string(ws.join(".agents/scripts/count-hits.ts")).unwrap();
    assert!(file.starts_with("// @description Count matches in src\n// @arg pattern"), "{file}");

    // A personal script, reachable by name only.
    let personal = appv3_core::settings().config_dir.join("scripts");
    std::fs::create_dir_all(&personal).unwrap();
    std::fs::write(personal.join("hello.js"), "// @description Say hello.\nreturn `hello ${args.who}`;").unwrap();

    let run = turn(
        "saved-2",
        &ws,
        "code",
        &[
            ("l1", "script", r#"{"list": true}"#),
            ("p1", "script", r#"{"path": ".agents/scripts/count-hits.ts", "args": {"pattern": "three"}}"#),
            ("n1", "script", r#"{"name": "count-hits", "args": {"pattern": "TODO t"}}"#),
            ("n2", "script", r#"{"name": "hello", "args": {"who": "you"}}"#),
            ("x1", "script", r#"{"path": "../saved-1.db"}"#),
        ],
    )
    .await;
    let list = run.result("l1");
    assert!(list.contains("- count-hits (project, .agents/scripts/count-hits.ts): Count matches in src\n    arg pattern What to count. Default \"TODO\"."), "{list}");
    assert!(list.contains("- hello (personal, "), "{list}");
    assert!(run.result("p1").contains("output:\n1"), "{}", run.result("p1"));
    assert!(run.result("n1").contains("output:\n2"), "{}", run.result("n1"));
    assert!(run.result("n2").contains("output:\nhello you"), "{}", run.result("n2"));
    assert!(run.result("x1").contains("outside the workspace"), "{}", run.result("x1"));

    // A failed run with save_as saves nothing.
    let bad = json!({ "code": "throw new Error('nope')", "save_as": "broken" }).to_string();
    let run = turn("saved-3", &ws, "code", &[("b1", "script", &bad)]).await;
    assert!(run.result("b1").contains("not saved: the script failed"), "{}", run.result("b1"));
    assert!(!ws.join(".agents/scripts/broken.ts").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn any_workspace_file_the_agent_wrote_runs_by_path() {
    let ws = workspace("by-path");
    std::fs::create_dir_all(ws.join("tools/lib")).unwrap();
    std::fs::write(ws.join("tools/lib/fmt.ts"), "export const fmt = (n: number): string => `${n} files`;").unwrap();
    std::fs::write(
        ws.join("tools/count.ts"),
        "import { fmt } from './lib/fmt';\nconst g = await tools.glob({ pattern: 'src/*.txt' });\nreturn fmt(g.split('\\n').filter(l => l.endsWith('.txt')).length);",
    )
    .unwrap();
    let run = turn("by-path", &ws, "code", &[("p1", "script", r#"{"path": "tools/count.ts"}"#)]).await;
    let text = run.result("p1");
    assert!(text.contains("output:\n2 files"), "{text}");
}
