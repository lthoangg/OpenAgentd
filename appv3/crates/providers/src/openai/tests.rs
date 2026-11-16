use super::*;

fn h(d: CompletionsDialect) -> CompletionsHandler {
    CompletionsHandler::new("m", "https://api.openai.com/v1", vec![], d)
}

fn content_types(req: &reqwest::Request) -> Vec<String> {
    req.headers().get_all(reqwest::header::CONTENT_TYPE).iter().map(|v| v.to_str().unwrap().to_string()).collect()
}

/// ChatGPT's Codex backend rejects a doubled header with HTTP 400
/// "Unsupported content type"; `.json()` must not add a second one.
#[test]
fn codex_request_sends_one_content_type() {
    let headers = vec![("Content-Type".into(), "application/json".into()), ("Authorization".into(), "Bearer t".into())];
    let mut h = ResponsesHandler::new("m", "http://127.0.0.1:1", headers, false);
    h.flavor = Flavor::Codex(Arc::new(CodexTurn { turn_state: Default::default(), supports_reasoning_summary: true }));
    let req = h.request(&reqwest::Client::new(), &json!({"model": "m"}), &Kwargs::new()).build().unwrap();
    assert_eq!(content_types(&req), vec!["application/json"]);
}

#[test]
fn completions_request_sends_one_content_type() {
    let headers = vec![("Content-Type".into(), "application/json".into())];
    let h = CompletionsHandler::new("m", "http://127.0.0.1:1", headers, CompletionsDialect::OpenAi);
    let req = h.request(&reqwest::Client::new(), &json!({"model": "m"}), &Kwargs::new()).build().unwrap();
    assert_eq!(content_types(&req), vec!["application/json"]);
}

#[test]
fn grok_flavor_adds_request_headers_on_both_apis() {
    let mut kw = Kwargs::new();
    kw.insert("session_id".into(), json!("s1"));
    let has_conv = |req: &reqwest::Request| req.headers().get("x-grok-conv-id").and_then(|v| v.to_str().ok()) == Some("s1");
    let mut c = CompletionsHandler::new("m", "http://127.0.0.1:1", vec![], CompletionsDialect::OpenAi);
    c.flavor = Flavor::Grok;
    assert!(has_conv(&c.request(&reqwest::Client::new(), &json!({"model": "m"}), &kw).build().unwrap()));
    let mut r = ResponsesHandler::new("m", "http://127.0.0.1:1", vec![], true);
    r.flavor = Flavor::Grok;
    assert!(has_conv(&r.request(&reqwest::Client::new(), &json!({"model": "m"}), &kw).build().unwrap()));
}

#[test]
fn assistant_content_rules_match_v2() {
    let tc = ToolCall::new("c1", "read", "{}");
    let msgs = vec![
        ChatMessage::user("hi"),
        ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![tc]), ..Default::default() }),
        ChatMessage::tool("c1", Some("read".into()), "ok"),
        ChatMessage::Assistant(AssistantMessage { reasoning_content: Some("thinking".into()), ..Default::default() }),
        ChatMessage::Assistant(AssistantMessage::default()),
    ];
    let out = convert_messages(&msgs, CompletionsDialect::OpenAi);
    assert_eq!(out[1]["content"], "");
    assert_eq!(out[1]["tool_calls"][0]["function"]["name"], "read");
    assert_eq!(out[2], json!({"role": "tool", "content": "ok", "tool_call_id": "c1", "name": "read"}));
    assert_eq!(out[3]["content"], "thinking");
    assert_eq!(out[4]["content"], "...");
}

#[test]
fn request_fields_per_dialect() {
    let mut kw = Kwargs::new();
    kw.insert("max_tokens".into(), json!(100));
    kw.insert("thinking_level".into(), json!("high"));
    let b = h(CompletionsDialect::OpenAi).build_request(&[ChatMessage::user("x")], None, true, &kw);
    assert_eq!(b["max_completion_tokens"], 100);
    assert_eq!(b["reasoning_effort"], "high");
    assert_eq!(b["stream_options"], json!({"include_usage": true}));
    let b = h(CompletionsDialect::DeepSeek).build_request(&[ChatMessage::user("x")], None, true, &kw);
    assert_eq!(b["max_tokens"], 100);
    assert_eq!(b["thinking"], json!({"type": "enabled"}));
    let mut kw2 = Kwargs::new();
    kw2.insert("thinking_level".into(), json!("none"));
    let b = h(CompletionsDialect::Zai).build_request(&[ChatMessage::user("x")], None, false, &kw2);
    assert_eq!(b["thinking"], json!({"type": "disabled"}));
    assert!(b.get("reasoning_effort").is_none());
}

#[test]
fn sanitize_drops_orphans() {
    let msgs = vec![
        ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("a", "x", "{}")]), ..Default::default() }),
        ChatMessage::user("interrupt"),
        ChatMessage::tool("a", None, "late"),
    ];
    let out = sanitize_tool_pairs(&msgs);
    assert_eq!(out.len(), 2);
    assert!(out[0].as_assistant().unwrap().tool_calls.is_none());
}

#[test]
fn sanitize_borrows_a_well_paired_transcript() {
    let msgs = vec![
        ChatMessage::user("go"),
        ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("a", "x", "{}"), ToolCall::new("b", "y", "{}")]), ..Default::default() }),
        ChatMessage::tool("b", None, "rb"),
        ChatMessage::tool("a", None, "ra"),
        ChatMessage::Assistant(AssistantMessage { content: Some("done".into()), ..Default::default() }),
    ];
    assert!(matches!(sanitize_tool_pairs(&msgs), std::borrow::Cow::Borrowed(_)));
}

#[test]
fn sanitize_keeps_good_pairs_while_fixing_bad_ones() {
    let msgs = vec![
        ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("a", "x", "{}")]), ..Default::default() }),
        ChatMessage::tool("a", None, "ra"),
        ChatMessage::tool("a", None, "duplicate"),
        ChatMessage::Assistant(AssistantMessage {
            content: Some("half".into()),
            tool_calls: Some(vec![ToolCall::new("b", "x", "{}"), ToolCall::new("c", "x", "{}")]),
            ..Default::default()
        }),
        ChatMessage::tool("b", None, "rb"),
        ChatMessage::user("next"),
    ];
    let out = sanitize_tool_pairs(&msgs);
    let shape: Vec<(String, Option<String>, bool)> =
        out.iter().map(|m| (m.role().to_string(), m.content().map(String::from), m.as_assistant().map(|a| a.tool_calls.is_some()).unwrap_or(false))).collect();
    assert_eq!(
        shape,
        vec![
            ("assistant".into(), None, true),
            ("tool".into(), Some("ra".into()), false),
            ("assistant".into(), Some("half".into()), false),
            ("user".into(), Some("next".into()), false),
        ]
    );
}

#[test]
fn responses_stream_tool_call() {
    let mut p = ResponsesStreamParser::new("m".into());
    p.feed(&json!({"type": "response.created", "response": {"id": "r1"}}), "").unwrap();
    p.feed(&json!({"type": "response.output_item.added", "output_index": 0, "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read"}}), "").unwrap();
    let c = p.feed(&json!({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 0, "delta": "{\"a\""}), "").unwrap();
    let d = &c[0].choices[0].delta.tool_calls.as_ref().unwrap()[0];
    assert_eq!(d.id.as_deref(), Some("call_1"));
    assert_eq!(d.function.as_ref().unwrap().name.as_deref(), Some("read"));
    let c = p.feed(&json!({"type": "response.function_call_arguments.done", "item_id": "fc_1", "arguments": "{\"a\":1}"}), "").unwrap();
    assert_eq!(c[0].choices[0].delta.tool_calls.as_ref().unwrap()[0].function.as_ref().unwrap().arguments, None);
}

fn streamed_text(chunks: &[ChatCompletionChunk]) -> String {
    chunks.iter().filter_map(|c| c.choices.first()).filter_map(|ch| ch.delta.content.clone()).collect()
}

/// A message delivered only as a finished item (no `output_text.delta`)
/// used to read as an empty response and trigger retries.
#[test]
fn responses_stream_keeps_text_sent_only_in_the_finished_item() {
    let mut p = ResponsesStreamParser::new("m".into());
    p.feed(&json!({"type": "response.created", "response": {"id": "r1"}}), "").unwrap();
    let item = json!({"type": "message", "id": "msg_1", "role": "assistant", "content": [{"type": "output_text", "text": "CI is still running."}]});
    let c = p.feed(&json!({"type": "response.output_item.done", "output_index": 1, "item": item}), "").unwrap();
    assert_eq!(streamed_text(&c), "CI is still running.");
}

#[test]
fn responses_stream_does_not_repeat_streamed_text_from_the_finished_item() {
    let mut p = ResponsesStreamParser::new("m".into());
    let mut all = vec![];
    all.extend(p.feed(&json!({"type": "response.output_text.delta", "item_id": "msg_1", "delta": "Hello"}), "").unwrap());
    all.extend(p.feed(&json!({"type": "response.output_text.done", "item_id": "msg_1", "text": "Hello"}), "").unwrap());
    let item = json!({"type": "message", "id": "msg_1", "content": [{"type": "output_text", "text": "Hello"}]});
    all.extend(p.feed(&json!({"type": "response.output_item.done", "item": item}), "").unwrap());
    assert_eq!(streamed_text(&all), "Hello");
}

#[test]
fn responses_stream_keeps_text_sent_only_in_output_text_done() {
    let mut p = ResponsesStreamParser::new("m".into());
    let c = p.feed(&json!({"type": "response.output_text.done", "item_id": "msg_1", "text": "Done."}), "").unwrap();
    assert_eq!(streamed_text(&c), "Done.");
}

#[test]
fn responses_stream_reads_usage_from_an_incomplete_response() {
    let mut p = ResponsesStreamParser::new("m".into());
    let ev = json!({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "usage": {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14}}});
    let c = p.feed(&ev, "").unwrap();
    assert!(c.iter().any(|c| c.usage.is_some()), "usage chunk missing");
}

/// Local SSE server: records request heads, answers with a Codex-style
/// stream and a sticky `x-codex-turn-state` header.
async fn codex_server(turn: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let seen: Arc<Mutex<Vec<String>>> = Default::default();
    let seen2 = seen.clone();
    tokio::spawn(async move {
        let mut n = 0;
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let mut got = 0;
            loop {
                let k = s.read(&mut buf[got..]).await.unwrap();
                got += k;
                let text = String::from_utf8_lossy(&buf[..got]).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let cl: usize = text[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                    if got >= h + 4 + cl || k == 0 {
                        seen2.lock().unwrap().push(text);
                        break;
                    }
                }
            }
            n += 1;
            let body = concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc\",\"call_id\":\"c1\",\"name\":\"read\"}}\n\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"output_index\":0,\"delta\":\"{\\\"p\\\":\"}\n\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"output_index\":0,\"delta\":\"1}\"}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n",
            );
            let ts = format!("{turn}-{n}");
            let head = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nx-codex-turn-state: {ts}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
            s.write_all(head.as_bytes()).await.unwrap();
            s.write_all(body.as_bytes()).await.unwrap();
            let _ = s.shutdown().await;
        }
    });
    (format!("http://{addr}"), seen)
}

#[tokio::test]
async fn codex_turn_state_and_stream_assembly() {
    let (base, seen) = codex_server("tok").await;
    let turn = Arc::new(CodexTurn { turn_state: Default::default(), supports_reasoning_summary: true });
    let mut h = ResponsesHandler::new("gpt-5.4", &base, vec![("Authorization".into(), "Bearer t".into())], false);
    h.flavor = Flavor::Codex(turn.clone());
    let client = reqwest::Client::new();
    let mut kw = Kwargs::new();
    kw.insert("session_id".into(), json!("s1"));
    // Turn start: no sticky token sent; the first response's is captured.
    let msg = h.chat(&client, &[ChatMessage::system("sys"), ChatMessage::user("hi")], None, &kw, Some("gpt-5.4")).await.unwrap();
    let tc = &msg.tool_calls.as_ref().unwrap()[0];
    assert_eq!((tc.id.as_str(), tc.function.name.as_str(), tc.function.arguments.as_str()), ("c1", "read", "{\"p\":1}"));
    assert_eq!(msg.meta.extra.as_ref().unwrap()["usage"]["output"], 2);
    assert_eq!(turn.turn_state.lock().unwrap().as_deref(), Some("tok-1"));
    // Continuing the turn (tool result last): token echoed and not overwritten.
    let cont = vec![ChatMessage::user("hi"), ChatMessage::Assistant(msg.clone()), ChatMessage::tool("c1", Some("read".into()), "ok")];
    let s = h.stream(&client, &cont, None, &kw).await.unwrap();
    let _: Vec<_> = s.collect().await;
    assert_eq!(turn.turn_state.lock().unwrap().as_deref(), Some("tok-1"));
    // New user turn: token dropped, a fresh one captured.
    let s = h.stream(&client, &[ChatMessage::user("next")], None, &kw).await.unwrap();
    let _: Vec<_> = s.collect().await;
    assert_eq!(turn.turn_state.lock().unwrap().as_deref(), Some("tok-3"));
    let reqs = seen.lock().unwrap().clone();
    let has = |i: usize, h: &str| reqs[i].to_lowercase().contains(&h.to_lowercase());
    assert!(!has(0, "x-codex-turn-state") && has(1, "x-codex-turn-state: tok-1") && !has(2, "x-codex-turn-state"));
    assert!(has(0, "session-id: s1") && has(0, "x-codex-routing-hint: model=gpt-5.4"));
    assert!(reqs[0].contains("\"instructions\":\"sys\"") && reqs[0].contains("\"prompt_cache_key\":\"s1\""));
}
