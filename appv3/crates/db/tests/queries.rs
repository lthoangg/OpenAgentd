//! Query behaviour against a fresh database, plus reading databases that the
//! v2 (Python) backend wrote (data compat, kept until a migration retires it).
//!
//! `fresh_db_*` tests always run. `real_v2_db_*` run against a copy of a real
//! v2 database when `OAD_V2_DB` points at one (never the original file).

use appv3_db::codec::{api_uuid, db_id};
use appv3_db::migrations::{SchemaState, ALEMBIC_HEAD};
use appv3_db::queries::*;
use appv3_db::{api, create_pool};

async fn fresh() -> (tempfile::TempDir, appv3_db::DbPool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = create_pool(dir.path().join("oad.db")).await.unwrap();
    (dir, pool)
}

/// Deleting a session tree takes its `/btw` side questions and `/goal`
/// goals with it.
#[tokio::test]
async fn deleting_a_session_removes_its_side_questions() {
    let (_d, pool) = fresh().await;
    let lead = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    let child = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), parent_session_id: Some(lead.id.clone()), ..Default::default() }).await.unwrap();
    let other = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    for s in [&lead, &child, &other] {
        insert_side_question(&pool, &s.id, "why?").await.unwrap();
        insert_session_goal(&pool, &s.id, "done", 50, None).await.unwrap();
    }
    delete_session_rows(&pool, &lead.id).await.unwrap();
    assert_eq!(count_side_questions(&pool, &lead.id).await.unwrap(), 0);
    assert_eq!(count_side_questions(&pool, &child.id).await.unwrap(), 0);
    assert_eq!(count_side_questions(&pool, &other.id).await.unwrap(), 1);
    assert!(latest_session_goal(&pool, &lead.id).await.unwrap().is_none());
    assert!(latest_session_goal(&pool, &child.id).await.unwrap().is_none());
    assert!(live_session_goal(&pool, &other.id).await.unwrap().is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_saves_get_distinct_positions() {
    // A queued user message and the agent's reply can be written at the
    // same time; each row must still get its own `seq`.
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    let handles: Vec<_> = (0..40)
        .map(|i| {
            let (pool, sid) = (pool.clone(), s.id.clone());
            tokio::spawn(async move { save_message(&pool, &sid, NewMessage::user(format!("m{i}"))).await.unwrap().seq })
        })
        .collect();
    let mut seqs = vec![];
    for h in handles {
        seqs.push(h.await.unwrap());
    }
    seqs.sort();
    let n = seqs.len();
    seqs.dedup();
    assert_eq!(seqs.len(), n, "duplicate seq values");
}

/// Transcript order is `seq`; `created_at` can step back with the clock.
#[tokio::test]
async fn interrupt_marks_the_last_assistant_row_by_position() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    let earlier = save_message(&pool, &s.id, NewMessage::assistant(Some("first".into()))).await.unwrap();
    let last = save_message(&pool, &s.id, NewMessage::assistant(Some("second".into()))).await.unwrap();
    sqlx::query("UPDATE session_messages SET created_at = '2000-01-01 00:00:00.000000' WHERE id = ?").bind(&last.id).execute(&pool).await.unwrap();
    mark_last_assistant_interrupted(&pool, &s.id).await.unwrap();
    let interrupted = |id: String| {
        let pool = pool.clone();
        async move { get_message(&pool, &id).await.unwrap().unwrap().extra_json().and_then(|e| e.get("interrupted").cloned()) }
    };
    assert_eq!(interrupted(last.id.clone()).await, Some(serde_json::json!(true)));
    assert_eq!(interrupted(earlier.id.clone()).await, None);
}

/// The checkpointer saves through `save_message_id`; the stored row must be
/// the one `save_message` writes.
#[tokio::test]
async fn save_message_id_stores_what_save_message_stores() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    let note = || {
        let mut m = NewMessage::user("ctx");
        m.extra = Some(serde_json::json!({"hidden_from_user": true, "hidden_from_summary": true}).as_object().unwrap().clone());
        m
    };
    let by_row = save_message(&pool, &s.id, note()).await.unwrap();
    let mut conn = pool.acquire().await.unwrap();
    let id = save_message_id(&mut conn, &s.id, note()).await.unwrap();
    drop(conn);
    let by_id = get_message(&pool, &id).await.unwrap().unwrap();
    assert_eq!((by_id.kind.as_str(), by_id.pinned, by_id.extra.clone()), (by_row.kind.as_str(), by_row.pinned, by_row.extra.clone()));
    assert_eq!(by_id.seq, by_row.seq + appv3_db::SEQ_STEP);

    let before = get_session(&pool, &s.id).await.unwrap().unwrap().history_structure_revision;
    let mut conn = pool.acquire().await.unwrap();
    save_message_id(&mut conn, &s.id, NewMessage { is_summary: true, ..NewMessage::user("summary") }).await.unwrap();
    drop(conn);
    assert_eq!(get_session(&pool, &s.id).await.unwrap().unwrap().history_structure_revision, before + 1);
}

#[tokio::test]
async fn save_message_returns_the_stored_row() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    let mut extra = serde_json::Map::new();
    extra.insert("usage".into(), serde_json::json!({"input": 12, "note": "héllo"}));
    let msg = NewMessage {
        reasoning_content: Some("thinking…".into()),
        tool_calls: Some(serde_json::json!([{"id": "c1", "type": "function", "function": {"name": "read", "arguments": "{}"}}])),
        extra: Some(extra),
        ..NewMessage::assistant(Some("naïve ✓".into()))
    };
    let saved = save_message(&pool, &s.id, msg).await.unwrap();
    let stored = get_message(&pool, &saved.id).await.unwrap().unwrap();
    assert_eq!(serde_json::to_value(&saved).unwrap(), serde_json::to_value(&stored).unwrap());
    assert_eq!(saved.session_id, stored.session_id);
    assert_eq!(saved.content.as_deref(), Some("naïve ✓"));
}

#[tokio::test]
async fn sessions_by_ids_accepts_both_id_forms_and_skips_missing() {
    let (_d, pool) = fresh().await;
    let a = create_session(&pool, NewSession { workspace: "/w".into(), title: Some("Fix login".into()), ..Default::default() }).await.unwrap();
    let b = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let ids = vec![api_uuid(&a.id), db_id(&b.id), "0190a1b2-0000-7000-8000-000000000000".to_string()];
    let mut rows = get_sessions_by_ids(&pool, &ids).await.unwrap();
    rows.sort_by(|x, y| x.id.cmp(&y.id));
    let mut expected = vec![a.id.clone(), b.id.clone()];
    expected.sort();
    assert_eq!(rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), expected);
    assert!(get_sessions_by_ids(&pool, &[]).await.unwrap().is_empty());
}

#[tokio::test]
async fn session_workspaces_lists_every_session_with_its_workspace() {
    let (_d, pool) = fresh().await;
    let a = create_session(&pool, NewSession { workspace: "/w/app".into(), ..Default::default() }).await.unwrap();
    let b = create_session(&pool, NewSession { workspace: "/w/site".into(), parent_session_id: Some(a.id.clone()), ..Default::default() }).await.unwrap();
    let mut rows = session_workspaces(&pool).await.unwrap();
    rows.sort();
    let mut expected = vec![(a.id.clone(), "/w/app".to_string()), (b.id.clone(), "/w/site".to_string())];
    expected.sort();
    assert_eq!(rows, expected);
}

#[tokio::test]
async fn session_pages_follow_their_cursor() {
    let (_d, pool) = fresh().await;
    let mut ids = vec![];
    for i in 0..3 {
        ids.push(create_session(&pool, NewSession { workspace: "/tmp/ws".into(), title: Some(format!("s{i}")), ..Default::default() }).await.unwrap().id);
    }
    let all = SessionListFilter::default();
    let (first, cursor, more) = list_sessions_page(&pool, None, 2, &all).await.unwrap();
    assert!(more);
    assert_eq!(first.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), [ids[2].clone(), ids[1].clone()]);
    let cursor = cursor.expect("next cursor");
    let (rest, _, more) = list_sessions_page(&pool, Some(&cursor), 2, &all).await.unwrap();
    assert!(!more);
    assert_eq!(rest.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), [ids[0].clone()]);
    // Only the `<created_at>|<uuid>` form the server hands out is accepted.
    let bare = cursor.split('|').next().unwrap();
    assert!(list_sessions_page(&pool, Some(bare), 2, &all).await.is_err());
}

#[tokio::test]
async fn activity_sort_pages_by_last_message() {
    let (_d, pool) = fresh().await;
    let mut ids = vec![];
    for i in 0..3 {
        ids.push(create_session(&pool, NewSession { workspace: "/tmp/ws".into(), title: Some(format!("s{i}")), ..Default::default() }).await.unwrap().id);
    }
    // A message in the oldest makes it the most recently active.
    save_message(&pool, &ids[0], NewMessage::user("hi")).await.unwrap();
    let filter = SessionListFilter { sort: SessionSort::Activity, ..Default::default() };
    let (first, cursor, more) = list_sessions_page(&pool, None, 2, &filter).await.unwrap();
    assert!(more);
    assert_eq!(first.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), [ids[0].clone(), ids[2].clone()]);
    let cursor = cursor.expect("next cursor");
    let (rest, _, more) = list_sessions_page(&pool, Some(&cursor), 2, &filter).await.unwrap();
    assert!(!more);
    assert_eq!(rest.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), [ids[1].clone()]);
    assert!(list_sessions_page(&pool, Some("not-a-cursor"), 2, &filter).await.is_err());
}

// "Recent activity" follows messages, not edits: it used to sort on
// updated_at, which messages never moved and renames or model switches did.
#[tokio::test]
async fn saving_a_message_bumps_session_activity() {
    let (_d, pool) = fresh().await;
    let old = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    let new = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    assert_eq!(new.last_message_at.as_deref(), Some(new.created_at.as_str()), "an empty session is active from creation");

    save_message(&pool, &old.id, NewMessage::user("one more question")).await.unwrap();

    let touched = get_session(&pool, &old.id).await.unwrap().unwrap();
    assert!(touched.last_message_at > new.last_message_at, "a saved message must move last_message_at forward");
    assert_eq!(touched.updated_at, old.updated_at, "a message is not an edit to the session row");
    let filter = SessionListFilter { sort: SessionSort::Activity, ..Default::default() };
    let (first, _, _) = list_sessions_page(&pool, None, 2, &filter).await.unwrap();
    assert_eq!(first[0].id, old.id);

    // Edits to the row (a rename, a model switch) do not count as activity.
    update_session(&pool, &new.id, SessionUpdate { model: Some(Some("other".into())), ..SessionUpdate::title("renamed") }).await.unwrap().unwrap();
    let (first, _, _) = list_sessions_page(&pool, None, 2, &filter).await.unwrap();
    assert_eq!(first[0].id, old.id, "a rename must not reorder recent activity");

    // The batch path (one connection) and the raw tool insert count too.
    let mut conn = pool.acquire().await.unwrap();
    save_message_id(&mut conn, &new.id, NewMessage::assistant(Some("reply".into()))).await.unwrap();
    drop(conn);
    let (first, _, _) = list_sessions_page(&pool, None, 2, &filter).await.unwrap();
    assert_eq!(first[0].id, new.id);
    insert_raw_tool_message(&pool, &old.id, "answer", "call-1", "ask_lead").await.unwrap();
    let (first, _, _) = list_sessions_page(&pool, None, 2, &filter).await.unwrap();
    assert_eq!(first[0].id, old.id);

    // A back-dated row (an import) never moves it backwards.
    let before = get_session(&pool, &old.id).await.unwrap().unwrap().last_message_at;
    let dated = NewMessage { created_at: Some("2020-01-01T00:00:00Z".into()), ..NewMessage::user("imported") };
    save_message(&pool, &old.id, dated).await.unwrap();
    assert_eq!(get_session(&pool, &old.id).await.unwrap().unwrap().last_message_at, before);
    assert!(api::session_response(&touched, &Default::default())["last_message_at"].as_str().unwrap().ends_with('Z'));
}

#[tokio::test]
async fn pinning_filters_lists_and_keeps_updated_at() {
    let (_d, pool) = fresh().await;
    let a = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let b = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let pinned = set_session_pinned(&pool, &api_uuid(&a.id), true).await.unwrap().unwrap();
    assert!(pinned.pinned_at.is_some());
    assert_eq!(pinned.updated_at, a.updated_at, "pinning must not bump updated_at");
    // Re-pinning keeps the original pin time.
    let again = set_session_pinned(&pool, &a.id, true).await.unwrap().unwrap();
    assert_eq!(again.pinned_at, pinned.pinned_at);
    assert!(api::session_response(&pinned, &Default::default())["pinned_at"].as_str().unwrap().ends_with('Z'));
    assert!(api::session_response(&b, &Default::default()).get("pinned_at").is_none());

    let ids = |rows: Vec<appv3_db::ChatSession>| rows.into_iter().map(|s| s.id).collect::<Vec<_>>();
    let only = SessionListFilter { pinned: Some(true), ..Default::default() };
    assert_eq!(ids(list_sessions_page(&pool, None, 10, &only).await.unwrap().0), vec![a.id.clone()]);
    let unpinned = SessionListFilter { pinned: Some(false), ..Default::default() };
    assert_eq!(ids(list_sessions_page(&pool, None, 10, &unpinned).await.unwrap().0), vec![b.id.clone()]);
    assert_eq!(ids(list_pinned_sessions(&pool, &[]).await.unwrap()), vec![a.id.clone()]);
    assert!(list_pinned_sessions(&pool, &["/elsewhere".to_string()]).await.unwrap().is_empty());

    let cleared = set_session_pinned(&pool, &a.id, false).await.unwrap().unwrap();
    assert!(cleared.pinned_at.is_none());
    assert_eq!(cleared.updated_at, a.updated_at);
    assert!(list_pinned_sessions(&pool, &[]).await.unwrap().is_empty());
    assert!(set_session_pinned(&pool, "0190a1b2-0000-7000-8000-000000000000", true).await.unwrap().is_none());
}

#[tokio::test]
async fn a_user_title_locks_the_session_and_an_auto_title_does_not() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    assert!(!s.title_locked);
    let auto = update_session(&pool, &s.id, SessionUpdate::title("Generated")).await.unwrap().unwrap();
    assert_eq!((auto.title.as_deref(), auto.title_locked), (Some("Generated"), false));
    let typed = update_session(&pool, &s.id, SessionUpdate::user_title("Mine")).await.unwrap().unwrap();
    assert_eq!((typed.title.as_deref(), typed.title_locked), (Some("Mine"), true));
    // Retyping the same title still locks an unlocked session.
    let t = create_session(&pool, NewSession { workspace: "/w".into(), title: Some("Same".into()), ..Default::default() }).await.unwrap();
    assert!(update_session(&pool, &t.id, SessionUpdate::user_title("Same")).await.unwrap().unwrap().title_locked);
}

#[tokio::test]
async fn released_queued_messages_move_to_the_tail() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), ..Default::default() }).await.unwrap();
    let queued = save_message(&pool, &s.id, NewMessage { kind: Some("queued".into()), ..NewMessage::user("later") }).await.unwrap();
    let reply = save_message(&pool, &s.id, NewMessage::user("meanwhile")).await.unwrap();
    let revision = |pool: appv3_db::DbPool, id: String| async move { get_session(&pool, &id).await.unwrap().unwrap().history_structure_revision };
    let before = revision(pool.clone(), s.id.clone()).await;
    let released = release_queued_user_messages(&pool, &s.id, Some("abc")).await.unwrap();
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].id, queued.id);
    assert_eq!(released[0].kind, "chat");
    assert!(released[0].seq > reply.seq, "{} <= {}", released[0].seq, reply.seq);
    // The returned row is the stored one.
    assert_eq!(released[0].snapshot().as_deref(), Some("abc"));
    let stored = get_message(&pool, &queued.id).await.unwrap().unwrap();
    assert_eq!((stored.seq, &stored.created_at, &stored.extra), (released[0].seq, &released[0].created_at, &released[0].extra));
    assert!(revision(pool.clone(), s.id.clone()).await > before);
}

#[tokio::test]
async fn fresh_db_is_stamped_at_alembic_head() {
    let (_d, pool) = fresh().await;
    let v: String = sqlx::query_scalar("SELECT version_num FROM alembic_version").fetch_one(&pool).await.unwrap();
    assert_eq!(v, ALEMBIC_HEAD);
    // Re-opening detects it as current rather than recreating.
    assert_eq!(appv3_db::migrations::run_migrations(&pool).await.unwrap(), SchemaState::Current);
}

#[tokio::test]
async fn fresh_db_writes_v2_encoding() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/tmp/ws".into(), agent_name: Some("code".into()), ..Default::default() }).await.unwrap();
    assert_eq!(s.id.len(), 32, "uuid must be stored as 32-char hex");
    assert!(!s.id.contains('-'));
    assert_eq!(s.created_at.len(), 26, "datetime must be 'YYYY-MM-DD HH:MM:SS.ffffff'");
    assert_eq!(&s.created_at[10..11], " ");
    let m = save_message(&pool, &s.id, NewMessage::user("hi")).await.unwrap();
    assert_eq!(m.id.len(), 32);
    assert_eq!(m.seq, appv3_db::SEQ_STEP);
    // Lookup works with the hyphenated API spelling.
    let hy = api_uuid(&s.id);
    assert!(get_session(&pool, &hy).await.unwrap().is_some());
    let resp = api::session_response(&s, &Default::default());
    assert_eq!(resp["id"], hy);
    assert!(resp["created_at"].as_str().unwrap().ends_with('Z'));
    assert!(resp.get("revert").is_none(), "JSON null revert must be omitted");
}

#[tokio::test]
async fn undo_boundary_then_cleanup_matches_v2_semantics() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let u1 = save_message(&pool, &s.id, NewMessage::user("one")).await.unwrap();
    save_message(&pool, &s.id, NewMessage::assistant(Some("a1".into()))).await.unwrap();
    let u2 = save_message(&pool, &s.id, NewMessage::user("two")).await.unwrap();
    save_message(&pool, &s.id, NewMessage::assistant(Some("a2".into()))).await.unwrap();

    let target = find_undo_target(&pool, &s).await.unwrap().unwrap();
    assert_eq!(target.id, u2.id);
    let s = update_session(&pool, &s.id, SessionUpdate { revert: Some(Some(revert_state(&target, None))), ..Default::default() }).await.unwrap().unwrap();
    // Boundary hides u2+a2 from the LLM window without mutating rows.
    let win = llm_window_rows(&pool, &s.id, true).await.unwrap();
    assert_eq!(win.len(), 2);
    // Undo again walks back to u1.
    assert_eq!(find_undo_target(&pool, &s).await.unwrap().unwrap().id, u1.id);
    // Sending a new message materialises the undo.
    assert_eq!(cleanup_reverted_tail(&pool, &s.id).await.unwrap(), 2);
    let s = get_session(&pool, &s.id).await.unwrap().unwrap();
    assert!(s.revert_json().is_none());
    let (page, _, _) = history_page(&pool, &s.id, None).await.unwrap();
    assert_eq!(page.len(), 2);
}

#[tokio::test]
async fn queued_messages_promote_to_tail() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    save_message(&pool, &s.id, NewMessage::user("first")).await.unwrap();
    let q = save_queued_user_message(&pool, &s.id, "later", None).await.unwrap();
    assert_eq!(q.kind, "queued");
    assert!(llm_window_rows(&pool, &s.id, true).await.unwrap().iter().all(|r| r.kind != "queued"));
    save_message(&pool, &s.id, NewMessage::assistant(Some("reply".into()))).await.unwrap();
    let released = release_queued_user_messages(&pool, &s.id, Some("snap1")).await.unwrap();
    assert_eq!(released.len(), 1);
    let win = llm_window_rows(&pool, &s.id, true).await.unwrap();
    assert_eq!(win.last().unwrap().content.as_deref(), Some("later"));
    assert_eq!(win.last().unwrap().snapshot().as_deref(), Some("snap1"));
}

/// `n` assistant rows, as one long agent run writes them.
async fn save_steps(pool: &appv3_db::DbPool, sid: &str, n: usize) {
    for i in 0..n {
        save_message(pool, sid, NewMessage::assistant(Some(format!("step {i}")))).await.unwrap();
    }
}

/// A user row another agent sent, in the given `extra` shape.
fn from_agent(text: &str, extra: serde_json::Value) -> NewMessage {
    NewMessage { extra: extra.as_object().cloned(), ..NewMessage::user(text) }
}

/// Reopening a run longer than one page starts at the prompt it answers.
#[tokio::test]
async fn first_history_page_reaches_back_to_the_latest_prompt() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    save_steps(&pool, &s.id, 50).await;
    let prompt = save_message(&pool, &s.id, NewMessage::user("go")).await.unwrap();
    save_steps(&pool, &s.id, 150).await;

    let page = first_history_page(&pool, &s).await.unwrap();
    assert_eq!(page.rows.len(), 151);
    assert_eq!(page.rows[0].id, prompt.id);
    assert!(page.has_more);
    assert_eq!(page.boundary.as_ref().map(|b| &b.id), Some(&prompt.id));
    assert!(page.latest_prompt.is_none(), "the prompt is in the page");
}

/// A short run still loads a full page, so the turns before it show too.
#[tokio::test]
async fn first_history_page_keeps_a_full_page_for_a_short_run() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    save_steps(&pool, &s.id, 150).await;
    save_message(&pool, &s.id, NewMessage::user("go")).await.unwrap();
    save_steps(&pool, &s.id, 10).await;

    let page = first_history_page(&pool, &s).await.unwrap();
    assert_eq!(page.rows.len(), HISTORY_PAGE_SIZE as usize);
    assert!(page.has_more);
    assert!(page.latest_prompt.is_none());
}

/// A run over the cap loads its newest rows and hands back the prompt to pin.
#[tokio::test]
async fn first_history_page_caps_a_long_run_and_returns_its_prompt() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let prompt = save_message(&pool, &s.id, NewMessage::user("keep going")).await.unwrap();
    save_steps(&pool, &s.id, FIRST_PAGE_MAX as usize + 20).await;

    let page = first_history_page(&pool, &s).await.unwrap();
    assert_eq!(page.rows.len(), FIRST_PAGE_MAX as usize);
    assert!(page.has_more);
    assert_eq!(page.latest_prompt.map(|p| p.id), Some(prompt.id));
}

/// Only a prompt the user wrote counts: not an agent's report, a queued
/// message, or a compaction summary.
#[tokio::test]
async fn first_history_page_skips_rows_the_user_did_not_write() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let prompt = save_message(&pool, &s.id, NewMessage::user("real")).await.unwrap();
    save_steps(&pool, &s.id, 150).await;
    save_message(&pool, &s.id, from_agent("report", serde_json::json!({"from_agent": "explorer"}))).await.unwrap();
    save_message(&pool, &s.id, from_agent("legacy report", serde_json::json!({"routing": {"from_agent": "worker"}}))).await.unwrap();
    save_message(&pool, &s.id, from_agent("old report", serde_json::json!({"from_agents": ["worker"]}))).await.unwrap();
    save_queued_user_message(&pool, &s.id, "later", None).await.unwrap();
    save_message(&pool, &s.id, NewMessage { is_summary: true, ..NewMessage::user("summary") }).await.unwrap();
    save_steps(&pool, &s.id, 10).await;

    let page = first_history_page(&pool, &s).await.unwrap();
    assert_eq!(page.rows[0].id, prompt.id);
    assert_eq!(page.rows.len(), 1 + 150 + 5 + 10);
}

/// A staged undo hides the newest prompt, so the page reaches the one before.
#[tokio::test]
async fn first_history_page_reaches_past_a_staged_undo() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let first = save_message(&pool, &s.id, NewMessage::user("first")).await.unwrap();
    save_steps(&pool, &s.id, 150).await;
    let undone = save_message(&pool, &s.id, NewMessage::user("second")).await.unwrap();
    save_steps(&pool, &s.id, 20).await;
    assert_eq!(first_history_page(&pool, &s).await.unwrap().rows.len(), HISTORY_PAGE_SIZE as usize);

    let s = update_session(&pool, &s.id, SessionUpdate { revert: Some(Some(revert_state(&undone, None))), ..Default::default() }).await.unwrap().unwrap();
    let page = first_history_page(&pool, &s).await.unwrap();
    assert_eq!(page.rows[0].id, first.id);
    assert_eq!(page.rows.len(), 1 + 150 + 1 + 20);
}

#[tokio::test]
async fn pending_question_round_trip() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let qs = vec![serde_json::json!({"question": "Proceed?", "header": "Go", "options": []})];
    let q = create_pending_question(&pool, &s.id, "call_1", &qs).await.unwrap();
    assert!(sessions_awaiting_input(&pool).await.unwrap().contains(&s.id));
    let answers = serde_json::json!([["Yes"]]);
    let r = resolve_pending_question(&pool, &q.id, "answered", Some(&answers)).await.unwrap();
    assert!(r.is_some());
    // Second resolution loses the race.
    assert!(resolve_pending_question(&pool, &q.id, "answered", Some(&answers)).await.unwrap().is_none());
    let win = llm_window_rows(&pool, &s.id, true).await.unwrap();
    assert_eq!(win.last().unwrap().content.as_deref(), Some("User has answered your questions: \"Proceed?\"=\"Yes\". Continue with the user's answers in mind."));
}

#[tokio::test]
async fn plan_review_question_names_its_tool_and_takes_the_answer_text() {
    let (_d, pool) = fresh().await;
    let s = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let payload = serde_json::json!({"kind": "plan_review", "plan_revision": 3, "questions": [{"question": "Review plan revision 3.", "header": "Plan review", "options": []}]});
    let q = create_pending_question_with(&pool, &s.id, "call_p", "submit_plan", &payload).await.unwrap();
    assert_eq!(q.kind().as_deref(), Some("plan_review"));
    assert_eq!(q.plan_revision(), Some(3));
    let placeholder = llm_window_rows(&pool, &s.id, true).await.unwrap();
    assert_eq!(placeholder.last().unwrap().name.as_deref(), Some("submit_plan"));

    let resp = api::pending_question_response(&q);
    assert_eq!(resp["kind"], "plan_review");
    assert_eq!(resp["plan_revision"], 3);
    let plain = create_session(&pool, NewSession { workspace: "/w".into(), ..Default::default() }).await.unwrap();
    let asked = create_pending_question(&pool, &plain.id, "call_q", &[serde_json::json!({"question": "Q?", "header": "H", "options": []})]).await.unwrap();
    assert!(api::pending_question_response(&asked).get("kind").is_none(), "ask_user rows keep the v2 shape");

    let answers = serde_json::json!([["Approve"]]);
    resolve_pending_question_with(&pool, &q.id, "answered", Some(&answers), Some("The user approved plan revision 3.")).await.unwrap().unwrap();
    let win = llm_window_rows(&pool, &s.id, true).await.unwrap();
    assert_eq!(win.last().unwrap().content.as_deref(), Some("The user approved plan revision 3."));
}

#[tokio::test]
async fn refuses_unstamped_foreign_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}?mode=rwc", path.display())).await.unwrap();
        sqlx::query("CREATE TABLE chat_sessions (id TEXT)").execute(&pool).await.unwrap();
    }
    let err = create_pool(&path).await.unwrap_err().to_string();
    assert!(err.contains("alembic_version"), "{err}");
}

#[tokio::test]
async fn real_v2_db_reads_existing_history() {
    let Ok(src) = std::env::var("OAD_V2_DB") else { return };
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("copy.db");
    std::fs::copy(&src, &copy).unwrap();
    let pool = create_pool(&copy).await.unwrap();

    let (page, _cursor, _more) = list_sessions_page(&pool, None, 5, &SessionListFilter::default()).await.unwrap();
    assert!(!page.is_empty(), "expected sessions in the v2 database");
    for s in &page {
        let hy = api_uuid(&s.id);
        let found = get_session(&pool, &hy).await.unwrap().expect("lookup by hyphenated id");
        assert_eq!(found.id, db_id(&hy));
        let (rows, _, _) = history_page(&pool, &hy, None).await.unwrap();
        for r in &rows {
            let m = api::message_response(r);
            assert_eq!(m["session_id"], hy);
        }
        let _ = session_usage_totals(&pool, &hy).await.unwrap();
        let _ = llm_window_rows(&pool, &hy, true).await.unwrap();
    }
    // Writes from v3 into the v2 file use the v2 encoding.
    let first = &page[0];
    let m = save_message(&pool, &api_uuid(&first.id), NewMessage::user("v3 write")).await.unwrap();
    assert_eq!(m.session_id, first.id);
    assert_eq!(m.id.len(), 32);
}
