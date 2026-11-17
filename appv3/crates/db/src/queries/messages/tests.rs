use super::*;

async fn plan(pool: &DbPool, sql: &str, binds: usize) -> String {
    let explain = format!("EXPLAIN QUERY PLAN {sql}");
    let mut q = sqlx::query_as::<_, (i64, i64, i64, String)>(sqlx::AssertSqlSafe(&*explain));
    for _ in 0..binds {
        q = q.bind("s");
    }
    q.fetch_all(pool).await.unwrap().into_iter().map(|r| r.3).collect::<Vec<_>>().join("\n")
}

/// Tool results and image parts live in `extra`; summing usage from the
/// table parsed every one of them on each history load.
#[tokio::test]
async fn usage_totals_use_the_usage_index() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    for marks in ["?", "?, ?"] {
        let p = plan(&pool, &usage_totals_sql(marks), marks.matches('?').count()).await;
        assert!(p.contains("INDEX ix_session_messages_usage"), "{p}");
    }
}

/// Scanning the session for queued rows cost O(session) per model call.
#[tokio::test]
async fn queued_queries_use_the_queued_index() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    // The probe may seek either index on `kind`; both skip the session.
    let p = plan(&pool, HAS_QUEUED_SQL, 1).await;
    assert!(p.contains("ix_session_messages_queued") || p.contains("kind=?"), "{p}");
    let p = plan(&pool, QUEUED_ROWS_SQL, 1).await;
    assert!(p.contains("ix_session_messages_queued") && !p.contains("TEMP B-TREE"), "{p}");
}

/// v3's extra indexes must not take the history page off `(seq, id)`.
/// Restoring who is owed a reply read every message on each server start
/// (5 to 55 s on a large database), delaying the turns it resumes.
#[tokio::test]
async fn reply_requests_in_flight_reads_only_reply_requests() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    let p = plan(&pool, REPLY_REQUESTS_IN_FLIGHT_SQL, 0).await;
    assert!(p.contains("ix_session_messages_reply_requests") && !p.contains("TEMP B-TREE"), "{p}");
}

/// v3's extra indexes must not take the history page off `(seq, id)`.
#[tokio::test]
async fn history_page_keeps_the_seq_index() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    let sql = format!("SELECT * FROM session_messages WHERE session_id = ? AND {USER_VISIBLE} ORDER BY seq DESC, id DESC LIMIT ?");
    let p = plan(&pool, &sql, 2).await;
    assert!(p.contains("ix_session_messages_session_seq_id") && !p.contains("TEMP B-TREE"), "{p}");
}

/// Opening a tool call fetched its output and arguments by walking every
/// row of the session tree on every click.
#[tokio::test]
async fn tool_call_lookups_seek_instead_of_scanning_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    let p = plan(&pool, TOOL_MESSAGE_IN_TREE_SQL, 2).await;
    assert!(p.contains("ix_session_messages_tool_call_id"), "{p}");
    let p = plan(&pool, CALL_BEFORE_RESULT_SQL, 4).await;
    assert!(p.contains("ix_session_messages_session_seq_id") && !p.contains("TEMP B-TREE"), "{p}");
}

/// A call's arguments are found next to its result, in a member session
/// too, and before the result exists (a call still running).
#[tokio::test]
async fn finds_a_call_by_its_result_and_without_one() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    let lead = uuid::Uuid::now_v7();
    let member = uuid::Uuid::now_v7();
    crate::create_session(&pool, crate::NewSession { id: Some(lead), workspace: "/w".into(), ..Default::default() }).await.unwrap();
    crate::create_session(&pool, crate::NewSession { id: Some(member), workspace: "/w".into(), parent_session_id: Some(lead.to_string()), ..Default::default() }).await.unwrap();
    let call = |id: &str, name: &str, args: &str| serde_json::json!({"id": id, "type": "function", "function": {"name": name, "arguments": args}});
    let assistant = |calls: Vec<Value>| NewMessage { tool_calls: Some(Value::Array(calls)), ..NewMessage::assistant(None) };
    let (lead, member) = (lead.to_string(), member.to_string());
    save_message(&pool, &member, assistant(vec![call("c1", "shell", "{\"command\":\"ls\"}"), call("c2", "read", "{\"path\":\"a\"}")])).await.unwrap();
    save_message(&pool, &member, NewMessage::tool("c1", "shell", "[Succeeded]")).await.unwrap();
    save_message(&pool, &member, NewMessage::tool("c2", "read", "[1-1/1]\na")).await.unwrap();
    save_message(&pool, &member, assistant(vec![call("c3", "patch", "{\"patch_text\":\"x\"}")])).await.unwrap();
    assert_eq!(find_tool_message_in_tree(&pool, &lead, "c2").await.unwrap().unwrap().content.as_deref(), Some("[1-1/1]\na"));
    assert_eq!(find_tool_call_in_tree(&pool, &lead, "c2").await.unwrap(), Some(("read".into(), "{\"path\":\"a\"}".into())));
    assert_eq!(find_tool_call_in_tree(&pool, &lead, "c3").await.unwrap(), Some(("patch".into(), "{\"patch_text\":\"x\"}".into())), "no result yet");
    assert_eq!(find_tool_call_in_tree(&pool, &member, "nope").await.unwrap(), None);
}

#[tokio::test]
async fn workspace_message_requests() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    crate::create_session(&pool, crate::NewSession { id: Some(id), workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let with = |sent: Value| {
        let mut e = Map::new();
        e.insert("sent_from".into(), sent);
        NewMessage { extra: Some(e), ..NewMessage::user("do it") }
    };
    assert!(latest_sent_from(&pool, &sid).await.unwrap().is_none());
    save_message(&pool, &sid, NewMessage::user("plain")).await.unwrap();
    save_message(&pool, &sid, with(serde_json::json!({"session_id": "a", "reply": false, "hops": 1}))).await.unwrap();
    let pending = save_message(&pool, &sid, with(serde_json::json!({"session_id": "b", "reply": true, "hops": 2}))).await.unwrap();
    save_message(&pool, &sid, with(serde_json::json!({"session_id": "c", "reply": true, "replied_at": "x", "hops": 1}))).await.unwrap();
    save_queued_user_message(&pool, &sid, "later", Some(with(serde_json::json!({"session_id": "d", "reply": true, "hops": 3})).extra.unwrap())).await.unwrap();
    let rows = pending_reply_requests(&pool, &sid).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![pending.id]);
    assert_eq!(latest_sent_from(&pool, &sid).await.unwrap().unwrap()["session_id"], "d", "queued rows count for hops");
    // Who still waits on whom, for a server that just started: a request
    // still queued counts, one already told of a failure does not.
    save_message(&pool, &sid, with(serde_json::json!({"session_id": "e", "reply": true, "error_notified_at": "x", "hops": 1}))).await.unwrap();
    let target = crate::codec::api_uuid(&sid);
    assert_eq!(reply_requests_in_flight(&pool).await.unwrap(), vec![(target.clone(), "b".to_string()), (target, "d".to_string())]);
}

/// The snapshot sweep read every column of every row (13k rows with their
/// tool output on a long session) only to find `extra.snapshot`.
#[tokio::test]
async fn snapshot_marks_match_the_full_rows_without_reading_them() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
    let id = uuid::Uuid::now_v7();
    let sid = id.to_string();
    crate::create_session(&pool, crate::NewSession { id: Some(id), workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let snap = |s: Value| {
        let mut e = Map::new();
        e.insert("snapshot".into(), s);
        NewMessage { extra: Some(e), ..NewMessage::user("turn") }
    };
    save_message(&pool, &sid, snap(serde_json::json!("t1"))).await.unwrap();
    save_message(&pool, &sid, NewMessage::tool("c1", "shell", "\"snapshot\" in the output")).await.unwrap();
    save_message(&pool, &sid, snap(serde_json::json!(""))).await.unwrap();
    save_message(&pool, &sid, snap(serde_json::json!(7))).await.unwrap();
    save_message(&pool, &sid, NewMessage::user("no snapshot")).await.unwrap();
    save_message(&pool, &sid, snap(serde_json::json!("t2"))).await.unwrap();
    save_message(&pool, &sid, snap(serde_json::json!("t1"))).await.unwrap();
    let db_sid = crate::codec::db_id(&sid);
    let full: Vec<String> = sqlx::query_as::<_, SessionMessage>("SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC, id ASC")
        .bind(&db_sid)
        .fetch_all(&pool)
        .await
        .unwrap()
        .iter()
        .filter_map(SessionMessage::snapshot)
        .collect();
    assert_eq!(full, ["t1", "t2", "t1"]);
    assert_eq!(snapshot_marks(&pool, &db_sid).await.unwrap(), full);
    let p = plan(&pool, SNAPSHOT_MARKS_SQL, 1).await;
    assert!(p.contains("ix_session_messages_session_seq_id") && !p.contains("TEMP B-TREE"), "{p}");
}
