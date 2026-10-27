//! `inflight_turns` — sessions whose turn is running (v3 only, revision
//! 00000029).
//!
//! A turn writes its row when it starts and deletes it when it ends. The
//! server stopping (SIGTERM, a crash, the desktop killing its sidecar)
//! leaves the row behind, so the next start knows which turns to continue.

use crate::codec::{db_id, now_db};
use crate::pool::DbPool;
use anyhow::Result;

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct InflightTurn {
    pub session_id: String,
    pub started_at: String,
    /// How many times a restart has already continued this turn.
    pub restart_resumes: i64,
}

/// Record that `session_id` has a turn running. `restart_resume`: a restart
/// is continuing this turn, so it keeps its `restart_resumes` count; any
/// other turn starts its own count at zero.
pub async fn mark_turn_in_flight(pool: &DbPool, session_id: &str, restart_resume: bool) -> Result<()> {
    let sql = if restart_resume {
        "INSERT INTO inflight_turns (session_id, started_at, restart_resumes) VALUES (?, ?, 0) \
         ON CONFLICT(session_id) DO UPDATE SET started_at = excluded.started_at"
    } else {
        "INSERT INTO inflight_turns (session_id, started_at, restart_resumes) VALUES (?, ?, 0) \
         ON CONFLICT(session_id) DO UPDATE SET started_at = excluded.started_at, restart_resumes = 0"
    };
    sqlx::query(sql).bind(db_id(session_id)).bind(now_db()).execute(pool).await?;
    Ok(())
}

/// The turn of `session_id` ended (completed, failed, stopped, or parked
/// on a question).
pub async fn clear_turn_in_flight(pool: &DbPool, session_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM inflight_turns WHERE session_id = ?").bind(db_id(session_id)).execute(pool).await?;
    Ok(())
}

/// Every turn a previous server process left running, oldest first.
pub async fn list_inflight_turns(pool: &DbPool) -> Result<Vec<InflightTurn>> {
    Ok(sqlx::query_as::<_, InflightTurn>("SELECT session_id, started_at, restart_resumes FROM inflight_turns ORDER BY started_at").fetch_all(pool).await?)
}

/// Count one restart continuing the turn of `session_id`.
pub async fn count_restart_resume(pool: &DbPool, session_id: &str) -> Result<()> {
    sqlx::query("UPDATE inflight_turns SET restart_resumes = restart_resumes + 1 WHERE session_id = ?").bind(db_id(session_id)).execute(pool).await?;
    Ok(())
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

    #[tokio::test]
    async fn a_running_turn_is_listed_until_it_ends() {
        let (_d, pool) = pool().await;
        mark_turn_in_flight(&pool, SID, false).await.unwrap();
        let rows = list_inflight_turns(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].session_id.as_str(), rows[0].restart_resumes), (db_id(SID).as_str(), 0));
        clear_turn_in_flight(&pool, SID).await.unwrap();
        assert!(list_inflight_turns(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_the_continued_turn_keeps_its_resume_count() {
        let (_d, pool) = pool().await;
        mark_turn_in_flight(&pool, SID, false).await.unwrap();
        count_restart_resume(&pool, SID).await.unwrap();
        mark_turn_in_flight(&pool, SID, true).await.unwrap();
        assert_eq!(list_inflight_turns(&pool).await.unwrap()[0].restart_resumes, 1);
        // A queued message or a goal's next turn chained on without a clear.
        mark_turn_in_flight(&pool, SID, false).await.unwrap();
        assert_eq!(list_inflight_turns(&pool).await.unwrap()[0].restart_resumes, 0, "a new turn starts its own count");
    }
}
