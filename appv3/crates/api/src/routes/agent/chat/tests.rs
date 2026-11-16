use super::*;
use appv3_providers::mock::MockProvider;
use std::sync::Arc;

fn agent(thinking_level: Option<&str>) -> appv3_agent::Agent {
    let mut agent = appv3_agent::Agent::new(Arc::new(MockProvider::new(vec![])), "code", "Hi", vec![], Some("mock:mock".into()));
    agent.thinking_level = thinking_level.map(String::from);
    agent
}

#[test]
fn a_message_waits_behind_a_running_turn_and_a_held_one_behind_a_question() {
    // (busy, awaiting a question, held) -> queued
    assert!(waits_behind_turn(true, false, false), "a steer queues behind a running turn");
    assert!(waits_behind_turn(true, false, true));
    assert!(!waits_behind_turn(true, true, false), "a steer replaces an open question");
    assert!(waits_behind_turn(true, true, true), "a held message waits for the question to be answered");
    assert!(!waits_behind_turn(false, false, true), "an idle agent runs a held message at once");
}

fn row(role: &str, content: &str, reasoning: Option<&str>, tool_calls: Option<&str>) -> db::SessionMessage {
    db::SessionMessage {
        id: "0123456789abcdef0123456789abcdef".into(),
        session_id: "fedcba9876543210fedcba9876543210".into(),
        role: role.into(),
        content: Some(content.into()),
        reasoning_content: reasoning.map(String::from),
        tool_calls: tool_calls.map(String::from),
        tool_call_id: None,
        name: None,
        extra: Some("{}".into()),
        created_at: String::new(),
        seq: 0,
        kind: "message".into(),
        pinned: false,
    }
}

#[test]
fn page_bytes_are_split_by_what_the_rows_hold() {
    let mut b = RowBytes::default();
    let goal = db::SessionMessage { name: Some("update_goal".into()), ..row("tool", "output!", None, None) };
    let read = db::SessionMessage { name: Some("read".into()), ..row("tool", "left out", None, None) };
    b.add(&[row("assistant", "hello", Some("hmm"), Some("[{\"a\":1}]")), goal, read, row("user", "hi", None, None)]);
    assert_eq!(b, RowBytes { content: 7, reasoning: 3, tool_args: 9, tool_results: 7, extra: 8 });
}

#[test]
fn page_bytes_count_extra_as_sent_not_as_stored() {
    let mut r = row("tool", "", None, None);
    r.extra = Some(r#"{"parts": [{"type": "image", "data": "AAAA"}], "duration_ms": 5}"#.into());
    let mut b = RowBytes::default();
    b.add(&[r]);
    assert_eq!(b.extra, r#"{"duration_ms":5}"#.len());
}

#[test]
fn serialized_agent_carries_its_thinking_level() {
    let info = serialize_agent(&agent(Some("high")), None, None);
    assert_eq!(info["model"], "mock:mock");
    assert_eq!(info["thinking_level"], "high");
    assert_eq!(serialize_agent(&agent(None), None, None)["thinking_level"], Value::Null);
}

#[test]
fn serialized_agent_lists_preview_only_for_coding_workspaces() {
    let names = |info: &Value| info["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let dir = tempfile::tempdir().unwrap();
    let coding = serialize_agent(&agent(None), Some(&dir.path().to_string_lossy()), None);
    assert!(names(&coding).contains(&"preview".to_string()), "{coding}");
    assert!(!names(&serialize_agent(&agent(None), None, None)).contains(&"preview".to_string()));
}

#[test]
fn history_body_keeps_its_wire_shape() {
    let row = db::SessionMessage {
        id: "0123456789abcdef0123456789abcdef".into(),
        session_id: "fedcba9876543210fedcba9876543210".into(),
        role: "assistant".into(),
        content: None,
        reasoning_content: None,
        tool_calls: Some(r#"[{"id": "c"}]"#.into()),
        tool_call_id: None,
        name: None,
        extra: None,
        created_at: "2026-09-23 06:56:28.000000".into(),
        seq: 5,
        kind: "chat".into(),
        pinned: false,
    };
    let rows = [row];
    let session: Map<String, Value> = [("id".to_string(), json!("l"))].into_iter().collect();
    let member = MemberPart { name: "m".into(), session_id: "s".into(), messages: MessagesView(&[]), running: true, estimated_cost_usd: 0.5, completion_tokens: 3 };
    let body = HistoryBody {
        lead: WithMessages { session, messages: MessagesView(&rows) },
        members: vec![member],
        has_more: true,
        next_cursor: Some("5|x".into()),
        truncated: false,
        pending_question: None,
        latest_prompt: None,
    };
    let msg = r#"{"id":"01234567-89ab-cdef-0123-456789abcdef","role":"assistant","tool_calls":[{"id": "c"}],"seq":5,"kind":"chat","created_at":"2026-09-23T06:56:28Z"}"#;
    let expected = format!(
        r#"{{"lead":{{"id":"l","messages":[{msg}]}},"members":[{{"name":"m","session_id":"s","messages":[],"running":true,"estimated_cost_usd":0.5,"completion_tokens":3}}],"has_more":true,"next_cursor":"5|x","truncated":false,"pending_question":null}}"#
    );
    assert_eq!(String::from_utf8(serde_json::to_vec(&body).unwrap()).unwrap(), expected);
    // A run longer than the page carries its prompt; the key is absent otherwise.
    let pinned = HistoryBody { latest_prompt: Some(MessageView(&rows[0])), ..body };
    let expected = format!(r#"{},"latest_prompt":{msg}}}"#, &expected[..expected.len() - 1]);
    assert_eq!(serde_json::to_string(&pinned).unwrap(), expected);
    let delta = HistoryBody {
        lead: WithMessages { session: Map::new(), messages: MessagesView(&[]) },
        members: vec![],
        has_more: false,
        next_cursor: None,
        truncated: true,
        pending_question: Some(json!({"id": "q"})),
        latest_prompt: None,
    };
    assert_eq!(
        serde_json::to_string(&delta).unwrap(),
        r#"{"lead":{"messages":[]},"members":[],"has_more":false,"next_cursor":null,"truncated":true,"pending_question":{"id":"q"}}"#
    );
}
