//! A failed checkpoint batch keeps its persistence identities unclaimed,
//! so the next checkpoint retries the whole batch rather than losing rows.

use appv3_agent::checkpointer::Checkpointer;
use appv3_agent::hooks::{AgentState, RunContext};
use appv3_providers::ChatMessage;

#[tokio::test]
async fn a_failed_batch_keeps_all_messages_retryable() {
    let root = tempfile::tempdir().unwrap();
    let pool = appv3_db::create_pool(root.path().join("checkpoint.db")).await.unwrap();
    let row = appv3_db::create_session(&pool, appv3_db::NewSession { workspace: root.path().display().to_string(), ..Default::default() }).await.unwrap();
    let sid = appv3_db::codec::api_uuid(&row.id);
    let ctx = RunContext { session_id: Some(sid.clone()), run_id: "checkpoint-test".into(), agent_name: "worker".into(), workspace: None };
    let cp = Checkpointer::new(pool.clone(), None, None);
    let mut state = AgentState::new(vec![ChatMessage::assistant("Calling a tool."), ChatMessage::tool("call_1", Some("test".into()), "Done.")], String::new());
    sqlx::query(
        "CREATE TRIGGER reject_test_tool BEFORE INSERT ON session_messages \
         WHEN NEW.role = 'tool' BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END",
    )
    .execute(&pool)
    .await
    .unwrap();

    cp.sync(&ctx, &mut state).await;

    assert!(state.messages.iter().all(|message| message.meta().db_id.is_none()), "a rolled-back row was marked persisted");
    assert!(appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap().is_empty(), "the failed batch was only partly rolled back");

    sqlx::query("DROP TRIGGER reject_test_tool").execute(&pool).await.unwrap();
    cp.sync(&ctx, &mut state).await;

    assert!(state.messages.iter().all(|message| message.meta().db_id.is_some()));
    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    assert_eq!(rows.iter().map(|row| row.role.as_str()).collect::<Vec<_>>(), ["assistant", "tool"]);
    cp.sync(&ctx, &mut state).await;
    assert_eq!(appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap().len(), 2, "a repeated checkpoint duplicated the committed batch");
}
