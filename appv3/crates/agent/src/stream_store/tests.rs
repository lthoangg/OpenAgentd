use super::*;

fn leak() -> &'static StreamStore {
    Box::leak(Box::new(StreamStore::default()))
}

#[tokio::test]
async fn replay_order_and_commit() {
    let s = leak();
    s.push_event("x", &events::message("a", "dropped", None), false);
    assert!(!s.has_turn("x"));
    s.init_turn("x", false);
    s.push_event("x", &events::agent_status("a", "working", None), false);
    s.push_event("x", &events::thinking("a", "th", None), false);
    s.push_event("x", &events::message("a", "he", None), false);
    s.push_event("x", &events::message("a", "llo", None), false);
    s.push_event("x", &events::tool_call("a", Some("t1"), "read", None), false);
    s.push_event("x", &events::tool_start("a", Some("t1"), "read", Some("{}")), false);
    let mut sub = s.attach("x").unwrap();
    let mut got = vec![];
    for _ in 0..5 {
        got.push(sub.next().await.unwrap().event.clone());
    }
    assert_eq!(got, vec!["agent_status", "thinking", "message", "tool_call", "tool_start"]);
    s.push_event("x", &events::tool_end("a", Some("t1"), "read", Some("r"), None), false);
    assert_eq!(sub.next().await.unwrap().event, "tool_end");
    s.commit_agent_content("x", "a");
    let st = s.debug_state("x").unwrap();
    assert_eq!(st["tool_calls"], json!([]));
    s.mark_done("x");
    assert!(sub.next().await.is_none());
    drop(sub);
    assert!(s.attach("x").is_none());
}

/// A reconnect mid-tool still learns which model called the tool, so the
/// prompt above a tool-only reply can name it.
#[tokio::test]
async fn replay_keeps_the_model_that_called_a_tool() {
    let s = leak();
    s.init_turn("m", false);
    let meta = json!({"model": "openai:gpt-5", "thinking_level": "high"});
    s.push_event("m", &events::tool_call("a", Some("t1"), "ask_user", Some(meta.clone())), false);
    let mut sub = s.attach("m").unwrap();
    let e = sub.next().await.unwrap();
    assert_eq!(e.event, "tool_call");
    let data: Value = serde_json::from_str(&e.data).unwrap();
    assert_eq!(data["metadata"], meta);
}

/// A reconnect during a `/compact` still learns it was forced.
#[tokio::test]
async fn replay_keeps_a_forced_compaction_forced() {
    let s = leak();
    s.init_turn("f", false);
    s.push_event("f", &events::summarization_start("a", true), false);
    s.push_event("f", &events::summarization_end("a", "sum", Some(json!({"forced": true}))), false);
    let mut sub = s.attach("f").unwrap();
    let mut forced = vec![];
    for _ in 0..2 {
        let e = sub.next().await.unwrap();
        let data: Value = serde_json::from_str(&e.data).unwrap();
        forced.push((e.event.clone(), data.get("metadata").and_then(|m| m.get("forced")).cloned()));
    }
    assert_eq!(forced, vec![("summarization_start".to_string(), Some(json!(true))), ("summarization_end".to_string(), Some(json!(true)))]);
}

#[tokio::test]
async fn full_queue_drops_client_with_sentinel() {
    let s = leak();
    s.init_turn("y", false);
    let mut sub = s.attach("y").unwrap();
    // Events that are never joined, one frame each.
    for i in 0..(SUBSCRIBER_QUEUE_SIZE + 1) {
        s.push_event("y", &events::tool_call("a", Some(&i.to_string()), "read", None), false);
    }
    assert_eq!(s.debug_state("y").unwrap()["subscribers"], json!(0));
    let mut n = 0;
    while sub.next().await.is_some() {
        n += 1;
    }
    assert_eq!(n, SUBSCRIBER_QUEUE_SIZE - 1);
}

/// `(event, text)` of every frame already queued for `sub`.
fn queued(sub: &Subscription) -> Vec<(String, String)> {
    let mut out = vec![];
    while let Some(Some(e)) = sub.queue.items_for_test().pop_front() {
        let data: Value = serde_json::from_str(&e.data).unwrap();
        out.push((e.event.clone(), data["text"].as_str().unwrap_or("").to_string()));
    }
    out
}

fn frames(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(e, t)| (e.to_string(), t.to_string())).collect()
}

#[tokio::test(start_paused = true)]
async fn the_first_delta_goes_out_at_once_and_the_rest_are_joined() {
    let s = leak();
    s.init_turn("j", false);
    let sub = s.attach("j").unwrap();
    for t in ["Hel", "lo, ", "wor", "ld"] {
        s.push_event("j", &events::message("a", t, None), false);
    }
    assert_eq!(queued(&sub), frames(&[("message", "Hel")]), "only the first piece is out before the window");
    tokio::time::sleep(DELTA_FLUSH_WINDOW).await;
    tokio::task::yield_now().await;
    assert_eq!(queued(&sub), frames(&[("message", "lo, world")]));
}

#[tokio::test(start_paused = true)]
async fn tools_running_side_by_side_are_joined_each_on_its_own() {
    let s = leak();
    s.init_turn("p", false);
    let sub = s.attach("p").unwrap();
    for n in 1..=3 {
        for id in ["t1", "t2"] {
            s.push_event("p", &events::tool_output_delta("a", Some(id), "shell", &format!("{id}.{n} "), n), false);
        }
    }
    tokio::time::sleep(DELTA_FLUSH_WINDOW).await;
    tokio::task::yield_now().await;
    assert_eq!(queued(&sub), frames(&[("tool_output_delta", "t1.1 "), ("tool_output_delta", "t2.1 "), ("tool_output_delta", "t1.2 t1.3 "), ("tool_output_delta", "t2.2 t2.3 ")]));
}

#[tokio::test(start_paused = true)]
async fn a_joined_frame_keeps_its_stream_fields_and_the_last_sequence() {
    let s = leak();
    s.init_turn("q", false);
    let sub = s.attach("q").unwrap();
    for n in 1..=3 {
        s.push_event("q", &events::tool_output_delta("a", Some("t1"), "shell", &n.to_string(), n), false);
    }
    s.push_event("q", &events::tool_end("a", Some("t1"), "shell", Some("123"), None), false);
    let mut q = sub.queue.items_for_test();
    q.pop_front();
    let joined: Value = serde_json::from_str(&q.pop_front().unwrap().unwrap().data).unwrap();
    assert_eq!(joined, serde_json::from_str::<Value>(&events::tool_output_delta("a", Some("t1"), "shell", "23", 3).to_wire().data).unwrap());
}

#[tokio::test(start_paused = true)]
async fn held_text_goes_out_before_the_next_event() {
    let s = leak();
    s.init_turn("o", false);
    let sub = s.attach("o").unwrap();
    s.push_event("o", &events::message("a", "a", None), false);
    s.push_event("o", &events::message("a", "b", None), false);
    s.push_event("o", &events::tool_call("a", Some("t1"), "read", None), false);
    s.push_event("o", &events::message("a", "c", None), false);
    s.push_event("o", &events::done(None), false);
    assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", "b"), ("tool_call", ""), ("message", "c"), ("done", "")]));
}

/// The client appends an agent's thinking and reply to one transcript in
/// arrival order: held thinking sent after the reply's first words split
/// both blocks (and the next attach's replay no longer matched them).
#[tokio::test(start_paused = true)]
async fn an_agents_held_thinking_goes_out_before_its_reply() {
    let s = leak();
    s.init_turn("r", false);
    let sub = s.attach("r").unwrap();
    s.push_event("r", &events::thinking("a", "r1 ", None), false);
    s.push_event("r", &events::thinking("a", "r2", None), false);
    s.push_event("r", &events::message("b", "member", None), false);
    s.push_event("r", &events::message("a", "t1", None), false);
    assert_eq!(queued(&sub), frames(&[("thinking", "r1 "), ("message", "member"), ("thinking", "r2"), ("message", "t1")]));
}

#[tokio::test(start_paused = true)]
async fn a_tools_held_output_keeps_its_pace_beside_the_agents_text() {
    let s = leak();
    s.init_turn("u", false);
    let sub = s.attach("u").unwrap();
    s.push_event("u", &events::tool_output_delta("a", Some("t1"), "shell", "o1 ", 1), false);
    s.push_event("u", &events::tool_output_delta("a", Some("t1"), "shell", "o2", 2), false);
    s.push_event("u", &events::message("a", "t1", None), false);
    assert_eq!(queued(&sub), frames(&[("tool_output_delta", "o1 "), ("message", "t1")]));
}

#[tokio::test(start_paused = true)]
async fn ending_the_turn_sends_held_text_before_the_end() {
    let s = leak();
    s.init_turn("e", false);
    let mut sub = s.attach("e").unwrap();
    s.push_event("e", &events::message("a", "a", None), false);
    s.push_event("e", &events::message("a", "b", None), false);
    s.mark_done("e");
    assert_eq!(sub.next().await.unwrap().event, "message");
    let last: Value = serde_json::from_str(&sub.next().await.unwrap().data).unwrap();
    assert_eq!(last["text"], "b");
    assert!(sub.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn an_attach_mid_window_neither_repeats_nor_loses_text() {
    let s = leak();
    s.init_turn("m", false);
    let old = s.attach("m").unwrap();
    s.push_event("m", &events::message("a", "he", None), false);
    s.push_event("m", &events::message("a", "llo", None), false);
    let new = s.attach("m").unwrap();
    assert_eq!(queued(&old), frames(&[("message", "he"), ("message", "llo")]), "the old subscriber gets the held text");
    let replay: Vec<String> = new.replay.iter().map(|e| serde_json::from_str::<Value>(&e.data).unwrap()["text"].as_str().unwrap().to_string()).collect();
    assert_eq!(replay, ["hello"]);
    tokio::time::sleep(DELTA_FLUSH_WINDOW * 2).await;
    tokio::task::yield_now().await;
    assert_eq!(queued(&new), vec![], "the new one has it from the replay only");
}

#[tokio::test(start_paused = true)]
async fn a_large_held_piece_goes_out_without_waiting() {
    let s = leak();
    s.init_turn("b", false);
    let sub = s.attach("b").unwrap();
    s.push_event("b", &events::message("a", "a", None), false);
    let big = "x".repeat(DELTA_FLUSH_BYTES);
    s.push_event("b", &events::message("a", &big, None), false);
    assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", &big)]));
}

#[tokio::test(start_paused = true)]
async fn other_metadata_starts_a_new_frame() {
    let s = leak();
    s.init_turn("d", false);
    let sub = s.attach("d").unwrap();
    let m1 = || Some(json!({"model": "a:one"}));
    s.push_event("d", &events::message("a", "a", m1()), false);
    s.push_event("d", &events::message("a", "b", m1()), false);
    s.push_event("d", &events::message("a", "c", Some(json!({"model": "a:two"}))), false);
    assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", "b")]));
    tokio::time::sleep(DELTA_FLUSH_WINDOW).await;
    tokio::task::yield_now().await;
    let q = sub.queue.items_for_test();
    let data: Value = serde_json::from_str(&q[0].as_ref().unwrap().data).unwrap();
    assert_eq!((data["text"].as_str(), data["metadata"]["model"].as_str()), (Some("c"), Some("a:two")));
}

#[test]
fn without_a_runtime_every_delta_goes_out_as_it_comes() {
    let s = leak();
    s.init_turn("n", false);
    let sub = s.attach("n").unwrap();
    s.push_event("n", &events::message("a", "a", None), false);
    s.push_event("n", &events::message("a", "b", None), false);
    assert_eq!(queued(&sub), frames(&[("message", "a"), ("message", "b")]));
}

#[tokio::test]
async fn replay_joins_many_chunks_per_agent_in_order() {
    let s = leak();
    s.init_turn("z", false);
    for i in 0..500 {
        s.push_event("z", &events::message("a", &format!("{i},"), None), false);
        s.push_event("z", &events::thinking("a", "t", None), false);
        s.push_event("z", &events::message("b", "é", None), false);
    }
    s.push_event("z", &events::message("a", "", None), false);
    let mut sub = s.attach("z").unwrap();
    let mut frames = vec![];
    for _ in 0..3 {
        frames.push(sub.next().await.unwrap());
    }
    let expected_a: String = (0..500).map(|i| format!("{i},")).collect();
    assert_eq!(frames[0].data, events::thinking("a", &"t".repeat(500), None).to_wire().data);
    assert_eq!(frames[1].data, events::message("a", &expected_a, None).to_wire().data);
    assert_eq!(frames[2].data, events::message("b", &"é".repeat(500), None).to_wire().data);
    assert_eq!(s.debug_state("z").unwrap()["content"]["a"], json!(expected_a));
}

fn replay_names(s: &'static StreamStore, sid: &str) -> Vec<String> {
    let sub = s.attach(sid).unwrap();
    sub.replay.iter().map(|e| e.event.clone()).collect()
}

#[tokio::test]
async fn an_attach_replays_the_open_question_last() {
    let s = leak();
    s.init_turn("q", false);
    s.push_event("q", &events::agent_status("a", "working", None), false);
    s.push_event("q", &events::tool_call("a", Some("c1"), "submit_plan", None), false);
    s.push_event("q", &events::plan_review_asked("q1", "q", "c1", &[json!({"question": "Review plan revision 2."})], 2), false);
    s.push_event("q", &events::agent_status("a", "waiting_input", None), false);

    let sub = s.attach("q").unwrap();
    let last = sub.replay.back().unwrap();
    assert_eq!(last.event, "question_asked");
    let data: Value = serde_json::from_str(&last.data).unwrap();
    assert_eq!((data["question_id"].as_str(), data["kind"].as_str(), data["plan_revision"].as_u64()), (Some("q1"), Some("plan_review"), Some(2)));
}

#[tokio::test]
async fn a_resolved_question_is_not_replayed() {
    let s = leak();
    for (sid, resolution) in [("r1", events::question_answered("q1", "r1", &json!([["Approve"]]))), ("r2", events::question_dismissed("q1", "r2", "dismissed"))] {
        s.init_turn(sid, false);
        s.push_event(sid, &events::question_asked("q1", sid, "c1", &[json!({"question": "Which?"})]), false);
        s.push_event(sid, &resolution, false);
        assert!(!replay_names(s, sid).contains(&"question_asked".to_string()), "{sid}");
    }
}

#[tokio::test]
async fn a_new_turn_forgets_the_question() {
    let s = leak();
    s.init_turn("n", false);
    s.push_event("n", &events::question_asked("q1", "n", "c1", &[json!({"question": "Which?"})]), false);
    s.init_turn("n", true);
    assert!(!replay_names(s, "n").contains(&"question_asked".to_string()));
}

fn pending_row(qid: &str, payload: Value) -> appv3_db::PendingQuestion {
    appv3_db::PendingQuestion {
        id: qid.into(),
        session_id: "01a163cc269b7076a8b797a60845113c".into(),
        tool_call_id: "c1".into(),
        payload: payload.to_string(),
        status: "pending".into(),
        answers: None,
        created_at: String::new(),
        answered_at: None,
    }
}

#[tokio::test]
async fn a_parked_session_with_no_turn_gets_one_that_replays_its_question() {
    let s = leak();
    s.ensure_parked_turn("p", &pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"questions": [{"question": "Which?"}]})));
    assert_eq!(replay_names(s, "p"), vec!["question_asked"]);
}

/// The row was read just before a new message superseded it and started
/// a turn: that turn must not replay the closed question.
#[tokio::test]
async fn a_row_read_before_a_new_turn_is_not_seeded_into_it() {
    let s = leak();
    s.init_turn("t", false);
    s.push_event("t", &events::agent_status("a", "working", None), false);
    s.ensure_parked_turn("t", &pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"questions": [{"question": "Which?"}]})));
    assert_eq!(replay_names(s, "t"), vec!["agent_status"]);
}

#[tokio::test]
async fn a_live_turn_keeps_its_own_question() {
    let s = leak();
    s.init_turn("l", false);
    s.push_event("l", &events::question_asked("q-live", "l", "c1", &[json!({"question": "Which?"})]), false);
    s.ensure_parked_turn("l", &pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"questions": [{"question": "Other?"}]})));
    let sub = s.attach("l").unwrap();
    assert_eq!(sub.replay.len(), 1);
    assert!(sub.replay[0].data.contains("\"q-live\""));
}

#[tokio::test]
async fn a_parked_plan_review_row_replays_as_a_plan_review() {
    let s = leak();
    let row = pending_row("01a163e0795772a9a1756a6f30bd379e", json!({"kind": "plan_review", "plan_revision": 4, "questions": [{"question": "Review plan revision 4."}]}));
    s.ensure_parked_turn("01a163cc-269b-7076-a8b7-97a60845113c", &row);
    let sub = s.attach("01a163cc-269b-7076-a8b7-97a60845113c").unwrap();
    let data: Value = serde_json::from_str(&sub.replay.back().unwrap().data).unwrap();
    assert_eq!(data["question_id"], "01a163e0-7957-72a9-a175-6a6f30bd379e");
    assert_eq!(data["session_id"], "01a163cc-269b-7076-a8b7-97a60845113c");
    assert_eq!((data["kind"].as_str(), data["plan_revision"].as_u64(), data["tool_call_id"].as_str()), (Some("plan_review"), Some(4), Some("c1")));
}

#[tokio::test]
async fn tool_end_keeps_its_result_on_every_match_path() {
    let s = leak();
    s.init_turn("w", false);
    s.push_event("w", &events::tool_call("a", Some("t1"), "ask_user", None), false);
    s.push_event("w", &events::tool_end("a", Some("t1"), "ask_user", Some("by-id"), None), false);
    s.push_event("w", &events::tool_call("a", None, "update_goal", None), false);
    s.push_event("w", &events::tool_end("a", None, "update_goal", Some("by-name"), None), false);
    s.push_event("w", &events::tool_end("a", Some("t9"), "plan", Some("orphan"), None), false);
    let results: Vec<Value> = s.debug_state("w").unwrap()["tool_calls"].as_array().unwrap().iter().map(|tc| tc["result"].clone()).collect();
    assert_eq!(results, vec![json!("by-id"), json!("by-name"), json!("orphan")]);
}

#[tokio::test]
async fn an_attach_replays_a_left_out_result_as_left_out() {
    let s = leak();
    s.init_turn("lo", false);
    s.push_event("lo", &events::tool_call("a", Some("t1"), "read", None), false);
    s.push_event("lo", &events::tool_start("a", Some("t1"), "read", Some("{}")), false);
    s.push_event("lo", &events::tool_end("a", Some("t1"), "read", Some("12345"), Some(json!({"duration_ms": 2}))), false);
    let sub = s.attach("lo").unwrap();
    let end = sub.replay.iter().find(|e| e.event == "tool_end").unwrap();
    let data: Value = serde_json::from_str(&end.data).unwrap();
    assert_eq!(data["result"], Value::Null);
    assert_eq!(data["metadata"], json!({"result_omitted": true, "result_bytes": 5}));
}

#[tokio::test]
async fn an_attach_replays_what_a_closed_script_row_says() {
    let s = leak();
    s.init_turn("sc", false);
    let result = "calls (2, 0.4 s):\n→ glob *.rs · 3 ms · 9 lines\n→ read a.rs · 1 ms · 40 lines\noutput:\n2\nsaved as count (.agents/scripts/count.ts)";
    s.push_event("sc", &events::tool_call("a", Some("t1"), "script", None), false);
    s.push_event("sc", &events::tool_start("a", Some("t1"), "script", Some("{}")), false);
    s.push_event("sc", &events::tool_end("a", Some("t1"), "script", Some(result), None), false);
    let sub = s.attach("sc").unwrap();
    let end = sub.replay.iter().find(|e| e.event == "tool_end").unwrap();
    let data: Value = serde_json::from_str(&end.data).unwrap();
    assert_eq!(data["result"], Value::Null);
    assert_eq!(data["metadata"], json!({"result_omitted": true, "result_bytes": result.len(), "script_run": {"calls": 2, "saved": "count"}}));
}
