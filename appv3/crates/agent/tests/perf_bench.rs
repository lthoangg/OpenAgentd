//! Backend microbenchmarks: stream-store fan-out, `save_message`, turn-start
//! heal, request-body build, provider stream parsing, Codex provider build.
//!
//! Ignored by default; it is a module of this binary so that every
//! `make verify-v3` compiles it. `scripts/perf/run-backend.sh` runs it in
//! release mode, and copies this file into an older checkout to compare.
//!
//!   cargo test --release -p appv3-agent --test integration perf_bench:: -- --ignored --nocapture
//!
//! Output: one `BENCH <name> median_ms=<x> min_ms=<y> runs=<n>` line each.

use appv3_agent::events;
use appv3_agent::stream_store::StreamStore;
use appv3_db::queries::*;
use appv3_providers::openai::{CompletionsDialect, OpenAiProvider};
use appv3_providers::{AssistantMessage, ChatMessage, Kwargs, LlmProvider, ToolCall};
use futures::StreamExt;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn report(name: &str, mut ms: Vec<f64>) {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("BENCH {name} median_ms={:.3} min_ms={:.3} runs={}", ms[ms.len() / 2], ms[0], ms.len());
}

fn elapsed_ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// Serves `body` raw (Connection: close) to every request, in 16 KB writes.
async fn sse_server(body: std::sync::Arc<Vec<u8>>) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            let body = body.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut buf = [0u8; 65536];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    head.extend_from_slice(&buf[..n]);
                }
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n").await;
                for c in body.chunks(16 * 1024) {
                    if s.write_all(c).await.is_err() {
                        return;
                    }
                }
                let _ = s.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

async fn drain(p: &dyn LlmProvider) -> usize {
    let mut s = p.stream(&[ChatMessage::user("hi")], None, &Kwargs::new()).await.unwrap();
    let mut n = 0;
    while let Some(c) = s.next().await {
        c.unwrap();
        n += 1;
    }
    n
}

fn transcript(pairs: usize, tool_bytes: usize) -> Vec<ChatMessage> {
    let mut msgs = Vec::new();
    for i in 0..pairs {
        msgs.push(ChatMessage::user(format!("step {i}: {}", "please continue the work ".repeat(20))));
        msgs.push(ChatMessage::Assistant(AssistantMessage {
            content: Some("Lass mich das prüfen — đang kiểm tra.".into()),
            tool_calls: Some(vec![ToolCall::new(format!("call_{i}"), "read", r#"{"path":"src/main.rs"}"#)]),
            ..Default::default()
        }));
        msgs.push(ChatMessage::tool(format!("call_{i}"), Some("read".into()), "x".repeat(tool_bytes)));
    }
    msgs
}

#[test]
#[ignore]
fn perf_bench() {
    let root = tempfile::tempdir().unwrap();
    for (k, d) in [("OPENAGENTD_DATA_DIR", "data"), ("OPENAGENTD_CONFIG_DIR", "config"), ("OPENAGENTD_STATE_DIR", "state"), ("OPENAGENTD_CACHE_DIR", "cache"), ("HOME", "home")] {
        std::fs::create_dir_all(root.path().join(d)).unwrap();
        std::env::set_var(k, root.path().join(d));
    }
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
    rt.block_on(async {
        // Stream store: 20k token events with one attached client. Deltas
        // are joined before they go out, so the client cannot count frames:
        // each batch ends with a status event, which sends what is held,
        // and the client reads up to it.
        let store: &'static StreamStore = Box::leak(Box::new(StreamStore::default()));
        let mut runs = vec![];
        for r in 0..7 {
            let sid = format!("s{r}");
            store.init_turn(&sid, false);
            let mut sub = store.attach(&sid).unwrap();
            let t = Instant::now();
            for batch in 0..20 {
                for i in 0..1000 {
                    store.push_event(&sid, &events::message("lead", &format!("tok{batch}-{i} "), None), false);
                }
                store.push_event(&sid, &events::agent_status("lead", "working", None), false);
                while sub.next().await.expect("the subscriber was dropped").event != "agent_status" {}
            }
            runs.push(elapsed_ms(t));
            store.clear(&sid);
        }
        report("stream_store_20k_tokens_1_client", runs);

        // save_message: 1000 assistant rows with non-ASCII text.
        let pool = appv3_db::create_pool(root.path().join("bench.db")).await.unwrap();
        let mut runs = vec![];
        for _ in 0..5 {
            let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
            let t = Instant::now();
            for i in 0..1000 {
                save_message(&pool, &s.id, NewMessage::assistant(Some(format!("Bước {i}: đang chỉnh sửa tệp — naïve café ✓ {}", "lorem ".repeat(300))))).await.unwrap();
            }
            runs.push(elapsed_ms(t));
        }
        report("save_message_x1000", runs);

        // Turn start heal over a 300-row window with 50 KB tool outputs.
        let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
        for i in 0..150 {
            let tc = serde_json::json!([{"id": format!("c{i}"), "type": "function", "function": {"name": "read", "arguments": "{}"}}]);
            save_message(&pool, &s.id, NewMessage { tool_calls: Some(tc), ..NewMessage::assistant(Some("reading".into())) }).await.unwrap();
            save_message(&pool, &s.id, NewMessage::tool(format!("c{i}"), "read", "y".repeat(50_000))).await.unwrap();
        }
        // Fold the WAL into the main file first: otherwise how much of the
        // window is still read through the WAL depends on when SQLite's
        // auto-checkpoint happened to run, which made this bimodal.
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&pool).await.unwrap();
        let mut runs = vec![];
        for _ in 0..21 {
            let t = Instant::now();
            assert_eq!(appv3_agent::history::heal_orphaned_tool_calls(&pool, &s.id).await.unwrap(), 0);
            runs.push(elapsed_ms(t));
        }
        report("heal_window_300_rows_50kb_tools", runs);

        // OpenAI request body for a 300-message transcript.
        let p = OpenAiProvider::with_headers("gpt-4o", "http://127.0.0.1:9", vec![], Kwargs::new(), CompletionsDialect::OpenAi, false);
        let msgs = transcript(100, 20_000);
        let mut runs = vec![];
        for _ in 0..21 {
            let t = Instant::now();
            std::hint::black_box(p.completions.build_request(&msgs, None, true, &Kwargs::new()));
            runs.push(elapsed_ms(t));
        }
        report("openai_build_request_300_msgs", runs);

        // OpenAI stream: 20k small content deltas.
        let mut body = Vec::new();
        for i in 0..20_000 {
            body.extend_from_slice(format!("data: {{\"id\":\"c\",\"created\":0,\"model\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"tok{i} \"}}}}]}}\n\n").as_bytes());
        }
        body.extend_from_slice(b"data: [DONE]\n\n");
        let base = sse_server(std::sync::Arc::new(body)).await;
        let p = OpenAiProvider::with_headers("gpt-4o", &base, vec![], Kwargs::new(), CompletionsDialect::OpenAi, false);
        let mut runs = vec![];
        for _ in 0..7 {
            let t = Instant::now();
            assert!(drain(&p).await >= 20_000);
            runs.push(elapsed_ms(t));
        }
        report("openai_stream_20k_deltas", runs);

        // One 4 MB SSE data line delivered in 16 KB writes.
        let big = format!("data: {{\"id\":\"c\",\"created\":0,\"model\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{}\"}}}}]}}\n\ndata: [DONE]\n\n", "z".repeat(4 << 20));
        let base = sse_server(std::sync::Arc::new(big.into_bytes())).await;
        let p = OpenAiProvider::with_headers("gpt-4o", &base, vec![], Kwargs::new(), CompletionsDialect::OpenAi, false);
        let mut runs = vec![];
        for _ in 0..5 {
            let t = Instant::now();
            drain(&p).await;
            runs.push(elapsed_ms(t));
        }
        report("openai_stream_one_4mb_line", runs);

        // Anthropic stream: 20k text deltas into one block.
        let mut body = String::from("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"model\":\"claude\",\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n");
        for i in 0..20_000 {
            body.push_str(&format!("event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"tok{i} \"}}}}\n\n"));
        }
        body.push_str("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        let base = sse_server(std::sync::Arc::new(body.into_bytes())).await;
        let p = appv3_providers::anthropic::AnthropicProvider::new("k", "claude-sonnet-4-5", &base, Kwargs::new()).unwrap();
        let mut runs = vec![];
        for _ in 0..7 {
            let t = Instant::now();
            assert!(drain(&p).await >= 20_000);
            runs.push(elapsed_ms(t));
        }
        report("anthropic_stream_20k_deltas", runs);

        // Codex provider build with a valid stored token, on a runtime worker.
        let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() + 1e6;
        let auth = appv3_providers::codex::CodexAuth { access_token: "bench".into(), refresh_token: "r".into(), expires_at: exp, account_id: Some("acc".into()) };
        auth.save(&mut appv3_providers::codex::oauth_slot()).unwrap();
        let runs = tokio::spawn(async {
            let mut runs = vec![];
            for _ in 0..7 {
                let t = Instant::now();
                for _ in 0..200 {
                    std::hint::black_box(appv3_providers::codex::build("gpt-5", Kwargs::new()).unwrap());
                }
                runs.push(elapsed_ms(t));
            }
            runs
        })
        .await
        .unwrap();
        report("codex_build_x200_valid_token", runs);
    });
}
