//! `session_goals` — `/goal` objectives a session keeps working toward
//! across turns (v3 only, revision 00000028).
//!
//! Clustered on `(session_id, id)` with UUIDv7 ids, so a session's goals
//! are one time-ordered range. At most one goal per session is live
//! (`active` or `paused`); ended ones stay as the session's goal history.

use crate::codec::{api_dt, api_uuid, db_id, json_db, new_id, now_db};
use crate::pool::DbPool;
use crate::NewMessage;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const GOAL_ACTIVE: &str = "active";
pub const GOAL_PAUSED: &str = "paused";
pub const GOAL_ACHIEVED: &str = "achieved";
pub const GOAL_CLEARED: &str = "cleared";

const LIVE: &str = "status IN ('active', 'paused')";

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct SessionGoal {
    pub session_id: String,
    pub id: String,
    pub objective: String,
    pub status: String,
    pub pause_reason: Option<String>,
    pub detail: Option<String>,
    pub max_turns: i64,
    pub token_budget: Option<i64>,
    pub turns_used: i64,
    pub tokens_used: i64,
    pub active_seconds: i64,
    pub rejected_claims: i64,
    pub idle_turns: i64,
    pub created_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
}

impl SessionGoal {
    pub fn is_live(&self) -> bool {
        self.status == GOAL_ACTIVE || self.status == GOAL_PAUSED
    }

    pub fn is_active(&self) -> bool {
        self.status == GOAL_ACTIVE
    }

    /// API form: hyphenated ids and ISO datetimes.
    pub fn to_api(&self) -> Value {
        json!({
            "id": api_uuid(&self.id),
            "session_id": api_uuid(&self.session_id),
            "objective": self.objective,
            "status": self.status,
            "pause_reason": self.pause_reason,
            "detail": self.detail,
            "max_turns": self.max_turns,
            "token_budget": self.token_budget,
            "turns_used": self.turns_used,
            "tokens_used": self.tokens_used,
            "active_seconds": self.active_seconds,
            "rejected_claims": self.rejected_claims,
            "created_at": api_dt(&self.created_at),
            "updated_at": api_dt(&self.updated_at),
            "ended_at": self.ended_at.as_deref().map(api_dt),
        })
    }
}

/// Start a new active goal, clearing the session's live one (if any) in the
/// same transaction. Returns the new goal.
pub async fn insert_session_goal(pool: &DbPool, session_id: &str, objective: &str, max_turns: i64, token_budget: Option<i64>) -> Result<SessionGoal> {
    let sid = db_id(session_id);
    let now = now_db();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let clear = format!("UPDATE session_goals SET status = ?, pause_reason = NULL, ended_at = ?, updated_at = ? WHERE session_id = ? AND {LIVE}");
    sqlx::query(sqlx::AssertSqlSafe(&*clear)).bind(GOAL_CLEARED).bind(&now).bind(&now).bind(&sid).execute(&mut *tx).await?;
    let row = sqlx::query_as::<_, SessionGoal>(
        "INSERT INTO session_goals (session_id, id, objective, status, max_turns, token_budget, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(&sid)
    .bind(new_id())
    .bind(objective)
    .bind(GOAL_ACTIVE)
    .bind(max_turns)
    .bind(token_budget)
    .bind(&now)
    .bind(&now)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

/// The session's live (active or paused) goal.
pub async fn live_session_goal(pool: &DbPool, session_id: &str) -> Result<Option<SessionGoal>> {
    let sql = format!("SELECT * FROM session_goals WHERE session_id = ? AND {LIVE} ORDER BY id DESC LIMIT 1");
    Ok(sqlx::query_as::<_, SessionGoal>(sqlx::AssertSqlSafe(&*sql)).bind(db_id(session_id)).fetch_optional(pool).await?)
}

/// The session's newest goal, live or ended.
pub async fn latest_session_goal(pool: &DbPool, session_id: &str) -> Result<Option<SessionGoal>> {
    Ok(sqlx::query_as::<_, SessionGoal>("SELECT * FROM session_goals WHERE session_id = ? ORDER BY id DESC LIMIT 1").bind(db_id(session_id)).fetch_optional(pool).await?)
}

pub async fn get_session_goal(pool: &DbPool, session_id: &str, id: &str) -> Result<Option<SessionGoal>> {
    Ok(sqlx::query_as::<_, SessionGoal>("SELECT * FROM session_goals WHERE session_id = ? AND id = ?").bind(db_id(session_id)).bind(db_id(id)).fetch_optional(pool).await?)
}

/// Write every mutable field of `goal` (and move `updated_at`). Returns the
/// stored row, or `None` when it no longer exists.
pub async fn save_session_goal(pool: &DbPool, goal: &SessionGoal) -> Result<Option<SessionGoal>> {
    Ok(sqlx::query_as::<_, SessionGoal>(
        "UPDATE session_goals SET status = ?, pause_reason = ?, detail = ?, max_turns = ?, token_budget = ?, turns_used = ?, \
         tokens_used = ?, active_seconds = ?, rejected_claims = ?, idle_turns = ?, updated_at = ?, ended_at = ? \
         WHERE session_id = ? AND id = ? RETURNING *",
    )
    .bind(&goal.status)
    .bind(&goal.pause_reason)
    .bind(&goal.detail)
    .bind(goal.max_turns)
    .bind(goal.token_budget)
    .bind(goal.turns_used)
    .bind(goal.tokens_used)
    .bind(goal.active_seconds)
    .bind(goal.rejected_claims)
    .bind(goal.idle_turns)
    .bind(now_db())
    .bind(&goal.ended_at)
    .bind(db_id(&goal.session_id))
    .bind(db_id(&goal.id))
    .fetch_optional(pool)
    .await?)
}

/// Pause every active goal with `reason` (server startup: no turn survives
/// a restart). Returns the paused goals.
pub async fn pause_active_session_goals(pool: &DbPool, reason: &str) -> Result<Vec<SessionGoal>> {
    Ok(sqlx::query_as::<_, SessionGoal>("UPDATE session_goals SET status = ?, pause_reason = ?, updated_at = ? WHERE status = ? RETURNING *")
        .bind(GOAL_PAUSED)
        .bind(reason)
        .bind(now_db())
        .bind(GOAL_ACTIVE)
        .fetch_all(pool)
        .await?)
}

/// Live goal status by on-disk session id, for the given session ids.
pub async fn live_goal_statuses(pool: &DbPool, session_ids: &[String]) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    for chunk in session_ids.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT session_id, status FROM session_goals WHERE {LIVE} AND session_id IN ({marks})");
        let mut q = sqlx::query_as::<_, (String, String)>(sqlx::AssertSqlSafe(&*sql));
        for sid in chunk {
            q = q.bind(db_id(sid));
        }
        out.extend(q.fetch_all(pool).await?);
    }
    Ok(out)
}

/// Drop the session's queued goal continuations (`extra.goal_turn`), so a
/// paused, cleared or restarted goal does not run the turn it had queued.
/// Queued user messages stay. Returns how many were dropped.
pub async fn delete_queued_goal_reminders(pool: &DbPool, session_id: &str) -> Result<u64> {
    let done = sqlx::query("DELETE FROM session_messages WHERE session_id = ? AND kind = 'queued' AND json_extract(extra, '$.goal_turn') IS NOT NULL")
        .bind(db_id(session_id))
        .execute(pool)
        .await?;
    Ok(done.rows_affected())
}

/// The session's goal rules notes still pinned and kept out of summaries:
/// `(row id, extra)`.
pub async fn unreleased_goal_notes(pool: &DbPool, session_id: &str) -> Result<Vec<(String, Option<String>)>> {
    Ok(sqlx::query_as(
        "SELECT id, extra FROM session_messages WHERE session_id = ? AND kind = 'note' \
         AND json_extract(extra, '$.goal_note') = 1 AND json_extract(extra, '$.hidden_from_summary') IS NOT NULL",
    )
    .bind(db_id(session_id))
    .fetch_all(pool)
    .await?)
}

/// Release one rules note: unpin it with `note_extra` (no longer hidden from
/// summaries) and append `ended`, in one transaction, so a crash cannot
/// release the note without its end note.
pub async fn release_goal_note(pool: &DbPool, session_id: &str, note_id: &str, note_extra: &Value, ended: NewMessage) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("UPDATE session_messages SET pinned = 0, extra = ? WHERE id = ?").bind(json_db(Some(note_extra))).bind(note_id).execute(&mut *tx).await?;
    crate::save_message_id(&mut tx, session_id, ended).await?;
    tx.commit().await?;
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
    const OTHER: &str = "0190f2a8-7c1e-7d3a-9b2c-222222222222";

    #[tokio::test]
    async fn a_new_goal_clears_the_live_one() {
        let (_d, pool) = pool().await;
        let first = insert_session_goal(&pool, SID, "tests pass", 50, None).await.unwrap();
        assert_eq!((first.status.as_str(), first.turns_used, first.max_turns), (GOAL_ACTIVE, 0, 50));
        let second = insert_session_goal(&pool, SID, "lint clean", 10, Some(1_000)).await.unwrap();
        insert_session_goal(&pool, OTHER, "elsewhere", 5, None).await.unwrap();

        let live = live_session_goal(&pool, SID).await.unwrap().unwrap();
        assert_eq!((live.id.as_str(), live.token_budget), (second.id.as_str(), Some(1_000)));
        let old = get_session_goal(&pool, SID, &api_uuid(&first.id)).await.unwrap().unwrap();
        assert_eq!(old.status, GOAL_CLEARED);
        assert!(old.ended_at.is_some());
        assert_eq!(latest_session_goal(&pool, SID).await.unwrap().unwrap().id, second.id);
    }

    #[tokio::test]
    async fn save_writes_progress_and_ending_leaves_no_live_goal() {
        let (_d, pool) = pool().await;
        let mut g = insert_session_goal(&pool, SID, "ship it", 50, None).await.unwrap();
        g.turns_used = 3;
        g.tokens_used = 12_345;
        g.detail = Some("evidence".into());
        g.status = GOAL_ACHIEVED.into();
        g.ended_at = Some(now_db());
        let saved = save_session_goal(&pool, &g).await.unwrap().unwrap();
        assert_eq!((saved.turns_used, saved.tokens_used, saved.status.as_str()), (3, 12_345, GOAL_ACHIEVED));
        assert!(live_session_goal(&pool, SID).await.unwrap().is_none());
        assert_eq!(saved.to_api()["detail"], "evidence");
        assert_eq!(saved.to_api()["session_id"], SID);
    }

    #[tokio::test]
    async fn startup_pauses_active_goals_only() {
        let (_d, pool) = pool().await;
        insert_session_goal(&pool, SID, "a", 50, None).await.unwrap();
        let mut b = insert_session_goal(&pool, OTHER, "b", 50, None).await.unwrap();
        b.status = GOAL_PAUSED.into();
        b.pause_reason = Some("user".into());
        save_session_goal(&pool, &b).await.unwrap();

        let paused = pause_active_session_goals(&pool, "restart").await.unwrap();
        assert_eq!(paused.len(), 1);
        assert_eq!(live_session_goal(&pool, SID).await.unwrap().unwrap().pause_reason.as_deref(), Some("restart"));
        assert_eq!(live_session_goal(&pool, OTHER).await.unwrap().unwrap().pause_reason.as_deref(), Some("user"));

        let statuses = live_goal_statuses(&pool, &[SID.to_string(), OTHER.to_string()]).await.unwrap();
        assert_eq!(statuses.get(&db_id(SID)).map(String::as_str), Some(GOAL_PAUSED));
        assert_eq!(statuses.len(), 2);
    }

    #[tokio::test]
    async fn only_one_live_goal_per_session() {
        let (_d, pool) = pool().await;
        insert_session_goal(&pool, SID, "a", 50, None).await.unwrap();
        let dup = sqlx::query("INSERT INTO session_goals (session_id, id, objective, status, max_turns, created_at, updated_at) VALUES (?, ?, 'b', 'paused', 5, ?, ?)")
            .bind(db_id(SID))
            .bind(new_id())
            .bind(now_db())
            .bind(now_db())
            .execute(&pool)
            .await;
        assert!(dup.is_err(), "a second live goal was stored");
    }

    #[tokio::test]
    async fn dropping_queued_reminders_keeps_queued_user_messages() {
        let (_d, pool) = pool().await;
        for sid in [SID, OTHER] {
            crate::create_session(&pool, crate::NewSession { id: Some(uuid::Uuid::parse_str(sid).unwrap()), workspace: "/w".into(), ..Default::default() }).await.unwrap();
        }
        let Value::Object(reminder) = json!({"goal_turn": {"turn": 2}}) else { unreachable!() };
        crate::save_queued_user_message(&pool, SID, "<goal_reminder>", Some(reminder.clone())).await.unwrap();
        crate::save_queued_user_message(&pool, SID, "also fix the README", None).await.unwrap();
        crate::save_queued_user_message(&pool, OTHER, "<goal_reminder>", Some(reminder)).await.unwrap();

        assert_eq!(delete_queued_goal_reminders(&pool, SID).await.unwrap(), 1);
        assert!(crate::has_queued_user_messages(&pool, SID).await.unwrap(), "the user's message stays");
        assert!(crate::has_queued_user_messages(&pool, OTHER).await.unwrap(), "other sessions keep theirs");
    }
}
