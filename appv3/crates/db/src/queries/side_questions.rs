//! `side_questions` — `/btw` exchanges kept beside a session, never part of
//! its transcript (v3 only, revision 00000023).
//!
//! The table is clustered on `(session_id, id)` with UUIDv7 ids, so every
//! query here is a range scan over one session's rows in time order.

use crate::codec::{api_dt, api_uuid, db_id, json_col, json_db, new_id, now_db};
use crate::pool::DbPool;
use anyhow::Result;
use appv3_core::machine::Machine;
use serde_json::{json, Value};

pub const SIDE_STREAMING: &str = "streaming";
pub const SIDE_DONE: &str = "done";
pub const SIDE_ERROR: &str = "error";
pub const SIDE_STOPPED: &str = "stopped";

/// A side question's status column (`appv3/AGENTS.md` → State machines): it
/// streams, then ends once. The row is the state; [`finish_side_question`]
/// makes the one move, guarded in SQL by `status = 'streaming'`.
pub struct SideStatusMachine;

/// Ending a side question with a status.
pub struct Finish<'a>(pub &'a str);

impl Machine for SideStatusMachine {
    const NAME: &'static str = "side question";
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] =
        &[("streaming", "finish:done", "done"), ("streaming", "finish:error", "error"), ("streaming", "finish:stopped", "stopped")];
    type State = &'static str;
    type Event = Finish<'static>;

    fn state_kind(s: &&'static str) -> &'static str {
        s
    }

    fn event_kind(e: &Finish<'static>) -> &'static str {
        match e.0 {
            SIDE_DONE => "finish:done",
            SIDE_ERROR => "finish:error",
            SIDE_STOPPED => "finish:stopped",
            _ => "finish:streaming",
        }
    }

    fn step(s: &&'static str, e: &Finish<'static>) -> Option<&'static str> {
        match (*s, e.0) {
            (SIDE_STREAMING, SIDE_DONE) => Some(SIDE_DONE),
            (SIDE_STREAMING, SIDE_ERROR) => Some(SIDE_ERROR),
            (SIDE_STREAMING, SIDE_STOPPED) => Some(SIDE_STOPPED),
            _ => None,
        }
    }
}

/// The final status `status` names, if it is one a side question may end with.
fn final_status(status: &str) -> Option<&'static str> {
    [SIDE_DONE, SIDE_ERROR, SIDE_STOPPED].into_iter().find(|s| *s == status).and_then(|s| SideStatusMachine::step(&SIDE_STREAMING, &Finish(s)))
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct SideQuestion {
    pub session_id: String,
    pub id: String,
    pub question: String,
    pub answer: String,
    pub status: String,
    pub error: Option<String>,
    pub model: Option<String>,
    pub usage: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl SideQuestion {
    /// API form: hyphenated ids, ISO datetimes, `usage` parsed.
    pub fn to_api(&self) -> Value {
        json!({
            "id": api_uuid(&self.id),
            "session_id": api_uuid(&self.session_id),
            "question": self.question,
            "answer": self.answer,
            "status": self.status,
            "error": self.error,
            "model": self.model,
            "usage": json_col(self.usage.as_deref()),
            "created_at": api_dt(&self.created_at),
            "updated_at": api_dt(&self.updated_at),
        })
    }
}

/// Record a new side question as `streaming`.
pub async fn insert_side_question(pool: &DbPool, session_id: &str, question: &str) -> Result<SideQuestion> {
    let now = now_db();
    let row = SideQuestion {
        session_id: db_id(session_id),
        id: new_id(),
        question: question.to_string(),
        answer: String::new(),
        status: SIDE_STREAMING.into(),
        error: None,
        model: None,
        usage: None,
        created_at: now.clone(),
        updated_at: now,
    };
    sqlx::query("INSERT INTO side_questions (session_id, id, question, answer, status, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?)")
        .bind(&row.session_id)
        .bind(&row.id)
        .bind(&row.question)
        .bind(&row.status)
        .bind(&row.created_at)
        .bind(&row.updated_at)
        .execute(pool)
        .await?;
    Ok(row)
}

/// How a side question ended.
#[derive(Debug, Clone, Default)]
pub struct SideOutcome<'a> {
    pub status: &'a str,
    pub answer: &'a str,
    pub error: Option<&'a str>,
    pub model: Option<&'a str>,
    pub usage: Option<&'a Value>,
}

/// Write the final state of a side question that is still streaming.
/// Returns whether it was (`false`: it had already ended, or is gone).
pub async fn finish_side_question(pool: &DbPool, session_id: &str, id: &str, out: SideOutcome<'_>) -> Result<bool> {
    let Some(status) = final_status(out.status) else {
        anyhow::bail!("illegal_transition machine=side question from=streaming event=finish:{}", out.status);
    };
    let usage = out.usage.map(|u| json_db(Some(u)));
    // Streaming is the only state a side question leaves, once: a finished
    // answer is never overwritten (a list healing a row it read as
    // streaming just before the answer landed).
    let res =
        sqlx::query("UPDATE side_questions SET status = ?, answer = ?, error = ?, model = ?, usage = ?, updated_at = ? WHERE session_id = ? AND id = ? AND status = 'streaming'")
            .bind(status)
            .bind(out.answer)
            .bind(out.error)
            .bind(out.model)
            .bind(usage)
            .bind(now_db())
            .bind(db_id(session_id))
            .bind(db_id(id))
            .execute(pool)
            .await?;
    Ok(res.rows_affected() > 0)
}

/// The newest `limit` side questions of a session, oldest first.
pub async fn list_side_questions(pool: &DbPool, session_id: &str, limit: i64) -> Result<Vec<SideQuestion>> {
    let mut rows =
        sqlx::query_as::<_, SideQuestion>("SELECT * FROM side_questions WHERE session_id = ? ORDER BY id DESC LIMIT ?").bind(db_id(session_id)).bind(limit).fetch_all(pool).await?;
    rows.reverse();
    Ok(rows)
}

/// The newest `limit` answered side questions, oldest first: the thread a
/// new side question is asked in.
pub async fn recent_done_side_questions(pool: &DbPool, session_id: &str, limit: i64) -> Result<Vec<SideQuestion>> {
    let mut rows = sqlx::query_as::<_, SideQuestion>("SELECT * FROM side_questions WHERE session_id = ? AND status = 'done' ORDER BY id DESC LIMIT ?")
        .bind(db_id(session_id))
        .bind(limit)
        .fetch_all(pool)
        .await?;
    rows.reverse();
    Ok(rows)
}

pub async fn count_side_questions(pool: &DbPool, session_id: &str) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM side_questions WHERE session_id = ?").bind(db_id(session_id)).fetch_one(pool).await?)
}

/// Delete every side question of a session. Returns how many went.
pub async fn clear_side_questions(pool: &DbPool, session_id: &str) -> Result<u64> {
    Ok(sqlx::query("DELETE FROM side_questions WHERE session_id = ?").bind(db_id(session_id)).execute(pool).await?.rows_affected())
}

/// Keep only the newest `keep` side questions of a session.
pub async fn prune_side_questions(pool: &DbPool, session_id: &str, keep: i64) -> Result<u64> {
    let sid = db_id(session_id);
    let res = sqlx::query("DELETE FROM side_questions WHERE session_id = ? AND id < (SELECT id FROM side_questions WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)")
        .bind(&sid)
        .bind(&sid)
        .bind(keep - 1)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> (tempfile::TempDir, DbPool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
        (dir, pool)
    }

    const SID: &str = "0190f2a8-7c1e-7d3a-9b2c-111111111111";
    const OTHER: &str = "0190f2a8-7c1e-7d3a-9b2c-222222222222";

    #[test]
    fn the_statuses_are_the_ones_the_database_accepts() {
        assert_eq!([SIDE_STREAMING, SIDE_DONE, SIDE_ERROR, SIDE_STOPPED], crate::migrations::status_values("side_questions"));
    }

    #[test]
    fn a_side_question_moves_only_from_streaming_to_an_end() {
        appv3_core::machine::check_table::<SideStatusMachine>(
            &[SIDE_STREAMING, SIDE_DONE, SIDE_ERROR, SIDE_STOPPED],
            &[Finish(SIDE_DONE), Finish(SIDE_ERROR), Finish(SIDE_STOPPED), Finish(SIDE_STREAMING)],
        );
    }

    #[tokio::test]
    async fn finishing_with_streaming_is_refused() {
        let (_d, pool) = pool().await;
        let q = insert_side_question(&pool, SID, "why?").await.unwrap();
        let out = SideOutcome { status: SIDE_STREAMING, answer: "", ..Default::default() };
        assert!(finish_side_question(&pool, SID, &q.id, out).await.unwrap_err().to_string().contains("illegal_transition"));
        assert_eq!(list_side_questions(&pool, SID, 10).await.unwrap()[0].status, SIDE_STREAMING);
    }

    #[tokio::test]
    async fn a_side_question_finishes_once() {
        let (_d, pool) = pool().await;
        let q = insert_side_question(&pool, SID, "why?").await.unwrap();
        let done = SideOutcome { status: SIDE_DONE, answer: "because", ..Default::default() };
        assert!(finish_side_question(&pool, SID, &q.id, done).await.unwrap());
        // A list that read it as streaming before the answer landed heals it late.
        let stale = SideOutcome { status: SIDE_STOPPED, answer: "", ..Default::default() };
        assert!(!finish_side_question(&pool, SID, &q.id, stale).await.unwrap());
        let row = list_side_questions(&pool, SID, 10).await.unwrap().remove(0);
        assert_eq!((row.status.as_str(), row.answer.as_str()), (SIDE_DONE, "because"));
    }

    #[tokio::test]
    async fn insert_finish_list_count_clear() {
        let (_d, pool) = pool().await;
        let a = insert_side_question(&pool, SID, "first?").await.unwrap();
        let b = insert_side_question(&pool, SID, "second?").await.unwrap();
        insert_side_question(&pool, OTHER, "elsewhere?").await.unwrap();
        let usage = json!({"input": 7, "output": 3});
        let out = SideOutcome { status: SIDE_DONE, answer: "one", model: Some("mock:m"), usage: Some(&usage), ..Default::default() };
        assert!(finish_side_question(&pool, SID, &api_uuid(&a.id), out).await.unwrap());

        let rows = list_side_questions(&pool, SID, 50).await.unwrap();
        assert_eq!(rows.iter().map(|r| r.question.as_str()).collect::<Vec<_>>(), ["first?", "second?"]);
        assert_eq!((rows[0].status.as_str(), rows[0].answer.as_str()), (SIDE_DONE, "one"));
        assert_eq!(rows[0].to_api()["usage"], usage);
        assert_eq!(rows[1].status, SIDE_STREAMING);
        assert_eq!(rows[1].id, b.id);
        // Only answered ones form the thread.
        let done = recent_done_side_questions(&pool, SID, 20).await.unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(count_side_questions(&pool, SID).await.unwrap(), 2);

        assert_eq!(clear_side_questions(&pool, SID).await.unwrap(), 2);
        assert_eq!(count_side_questions(&pool, SID).await.unwrap(), 0);
        assert_eq!(count_side_questions(&pool, OTHER).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn list_returns_the_newest_in_time_order_and_prune_keeps_them() {
        let (_d, pool) = pool().await;
        for i in 0..6 {
            insert_side_question(&pool, SID, &format!("q{i}")).await.unwrap();
        }
        let newest = list_side_questions(&pool, SID, 3).await.unwrap();
        assert_eq!(newest.iter().map(|r| r.question.as_str()).collect::<Vec<_>>(), ["q3", "q4", "q5"]);
        assert_eq!(prune_side_questions(&pool, SID, 10).await.unwrap(), 0);
        assert_eq!(prune_side_questions(&pool, SID, 4).await.unwrap(), 2);
        let kept = list_side_questions(&pool, SID, 50).await.unwrap();
        assert_eq!(kept.iter().map(|r| r.question.as_str()).collect::<Vec<_>>(), ["q2", "q3", "q4", "q5"]);
    }

    /// Every query is a range over the clustered primary key.
    #[tokio::test]
    async fn queries_seek_the_primary_key() {
        let (_d, pool) = pool().await;
        for sql in [
            "SELECT * FROM side_questions WHERE session_id = ? ORDER BY id DESC LIMIT 5",
            "SELECT COUNT(*) FROM side_questions WHERE session_id = ?",
            "DELETE FROM side_questions WHERE session_id = ?",
        ] {
            let explain = format!("EXPLAIN QUERY PLAN {sql}");
            let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(sqlx::AssertSqlSafe(&*explain)).bind("s").fetch_all(&pool).await.unwrap();
            let text = plan.into_iter().map(|r| r.3).collect::<Vec<_>>().join("\n");
            assert!(text.contains("USING PRIMARY KEY (session_id=?)"), "{sql}: {text}");
        }
    }
}
