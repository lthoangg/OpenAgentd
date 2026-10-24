//! Benchmark: one tool-using turn on a long session, end to end through
//! `AgentSession` (history load, hooks, model calls, tools, persistence).
//!
//! Ignored by default. Drives public behaviour only, so the same file runs on
//! any revision:
//!
//!   cargo test --release -p appv3-agent --test bench_turn -- --ignored --nocapture
//!
//!   # compare with an older revision
//!   git worktree add --detach /tmp/before <ref>
//!   cp crates/agent/tests/bench_turn.rs /tmp/before/appv3/crates/agent/tests/
//!   (cd /tmp/before/appv3 && BENCH_JSON=/tmp/turn-before.json cargo test --release -p appv3-agent --test bench_turn -- --ignored --nocapture)
//!   BENCH_BASELINE=/tmp/turn-before.json cargo test --release -p appv3-agent --test bench_turn -- --ignored --nocapture
//!
//! The session holds BENCH_EXCHANGES (default 300) exchanges of a prompt,
//! three ~8 kB tool results (every tenth with a ~200 kB image part) and an
//! answer. Each turn makes BENCH_ITERATIONS (default 10) `read` calls, one
//! per model call, then answers. The provider returns scripted chunks and
//! does no work of its own, so the numbers are the agent's overhead only.
//! A counting allocator reports the bytes allocated while a turn runs.
//! Times and bytes are medians of BENCH_RUNS (default 5) turns.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_db::{NewMessage, NewSession};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatMessage, ChunkStream, Kwargs, LlmProvider, ProviderResult, ToolSpec};
use async_trait::async_trait;
use serde_json::{json, Map, Value};

struct Counting;
static ALLOCATED: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size() as u64, Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATED.fetch_add(new_size.saturating_sub(layout.size()) as u64, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Scripted like `MockProvider`, but keeps no copy of each request.
struct ScriptedProvider {
    turns: Mutex<VecDeque<MockTurn>>,
    kw: Kwargs,
}

#[async_trait]
impl LlmProvider for ScriptedProvider {
    fn model(&self) -> &str {
        "mock"
    }
    fn provider_name(&self) -> Option<&str> {
        Some("mock")
    }
    fn support_interrupt(&self) -> bool {
        true
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<appv3_providers::AssistantMessage> {
        Ok(appv3_providers::AssistantMessage { content: Some("Title".into()), ..Default::default() })
    }
    async fn stream(&self, messages: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<ChunkStream> {
        assert!(!messages.is_empty());
        let turn = self.turns.lock().unwrap().pop_front().unwrap_or_else(|| MockProvider::text("done"));
        match turn {
            MockTurn::Chunks(chunks) => Ok(Box::pin(futures::stream::iter(chunks.into_iter().map(Ok)))),
            MockTurn::Error(e) => Err(e),
            MockTurn::Hang => Ok(Box::pin(futures::stream::pending())),
        }
    }
}

fn env_num(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

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
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

async fn seed(pool: &appv3_db::DbPool, sid: &str, exchanges: usize) {
    let result = "x".repeat(8_000);
    let image = "A".repeat(200_000);
    for n in 0..exchanges {
        appv3_db::save_message(pool, sid, NewMessage::user(format!("Prompt {n}: update module {n}."))).await.unwrap();
        for k in 0..3 {
            let call = format!("seed-{n}-{k}");
            let mut asst = NewMessage::assistant(None);
            asst.tool_calls = Some(json!([{ "id": call, "type": "function", "function": { "name": "read", "arguments": "{\"path\":\"a.txt\"}" } }]));
            asst.extra = Some(obj(json!({ "usage": { "input": 12000, "output": 80 } })));
            appv3_db::save_message(pool, sid, asst).await.unwrap();
            let mut tool = NewMessage::tool(call, "read", result.clone());
            let mut extra = json!({ "duration_ms": 40 });
            if (n * 3 + k) % 10 == 0 {
                extra["parts"] = json!([{ "type": "image_data", "media_type": "image/png", "data": image }]);
            }
            tool.extra = Some(obj(extra));
            appv3_db::save_message(pool, sid, tool).await.unwrap();
        }
        appv3_db::save_message(pool, sid, NewMessage::assistant(Some(format!("Done with step {n}.")))).await.unwrap();
    }
}

struct Sample {
    accept_ms: f64,
    turn_ms: f64,
    alloc_mb: f64,
}

async fn one_turn(pool: &appv3_db::DbPool, ws: &std::path::Path, sid: &str, iterations: usize) -> Sample {
    let mut script: Vec<MockTurn> = (0..iterations).map(|i| MockProvider::tool_call(&format!("call_{i}"), "read", r#"{"path":"hello.txt"}"#)).collect();
    script.push(MockProvider::text("All done."));
    let provider: Arc<dyn LlmProvider> = Arc::new(ScriptedProvider { turns: Mutex::new(script.into()), kw: Kwargs::new() });
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, "code", "You are a test agent.", vec![appv3_tools::builtin_tool("read").unwrap()], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);

    let alloc0 = ALLOCATED.load(Ordering::Relaxed);
    let t0 = Instant::now();
    session.handle_user_message(UserMessage { content: "go on".into(), session_id: sid.to_string(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let accept_ms = t0.elapsed().as_secs_f64() * 1e3;
    let mut sub = store().attach(sid).expect("turn is streaming");
    tokio::time::timeout(Duration::from_secs(120), async { while sub.next().await.is_some() {} }).await.expect("stream ends with done");
    session.wait_turn_finished().await;
    let turn_ms = t0.elapsed().as_secs_f64() * 1e3;
    let alloc_mb = (ALLOCATED.load(Ordering::Relaxed) - alloc0) as f64 / 1e6;
    assert_eq!(session.state(), "idle");
    Sample { accept_ms, turn_ms, alloc_mb }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark; run with --ignored --nocapture"]
async fn bench_long_session_turn() {
    let exchanges = env_num("BENCH_EXCHANGES", 300);
    let iterations = env_num("BENCH_ITERATIONS", 10);
    let runs = env_num("BENCH_RUNS", 5);
    let files = env_num("BENCH_WORKSPACE_FILES", 2000);
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    for i in 0..files {
        let dir = ws.join(format!("src/m{}", i / 100));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("f{i}.rs")), format!("pub fn f{i}() -> usize {{ {i} }}\n").repeat(20)).unwrap();
    }
    std::fs::write(ws.join("hello.txt"), "hello world\n").unwrap();
    let sid = uuid::Uuid::now_v7();
    appv3_db::create_session(&pool, NewSession { id: Some(sid), workspace: ws.display().to_string(), ..Default::default() }).await.unwrap();
    let sid = sid.to_string();
    seed(&pool, &sid, exchanges).await;

    one_turn(&pool, &ws, &sid, iterations).await; // warm-up: first snapshot, caches
    let samples: Vec<Sample> = {
        let mut v = vec![];
        for _ in 0..runs {
            v.push(one_turn(&pool, &ws, &sid, iterations).await);
        }
        v
    };
    let mut results: BTreeMap<String, f64> = BTreeMap::new();
    results.insert("message accepted (ms)".into(), median(samples.iter().map(|s| s.accept_ms).collect()));
    results.insert("whole turn (ms)".into(), median(samples.iter().map(|s| s.turn_ms).collect()));
    results.insert("allocated per turn (MB)".into(), median(samples.iter().map(|s| s.alloc_mb).collect()));

    if let Ok(path) = std::env::var("BENCH_JSON") {
        std::fs::write(&path, serde_json::to_string_pretty(&results).unwrap()).unwrap();
    }
    let baseline: Option<BTreeMap<String, f64>> = std::env::var("BENCH_BASELINE").ok().map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap());
    println!(
        "\nturn on a long session — {} history rows, {iterations} tool calls, {files} workspace files, median of {runs} turns{}\n",
        exchanges * 8,
        if baseline.is_some() { " — baseline → this revision" } else { "" }
    );
    for (name, v) in &results {
        match baseline.as_ref().and_then(|b| b.get(name)) {
            Some(before) => println!("  {name:<26} {before:>10.1} → {v:>10.1}  ({:.1}×)", before / v),
            None => println!("  {name:<26} {v:>10.1}"),
        }
    }
    println!();
}
