use crate::codec::{api_dt_from, db_id, dt_db, new_id, now_db, parse_dt, parse_uuid, uuid_db};
use crate::models::ChatSession;
use crate::pool::DbPool;
use anyhow::{anyhow, Result};
use uuid::Uuid;

/// Fields for a new `chat_sessions` row. Unset fields take v2 defaults.
#[derive(Debug, Default, Clone)]
pub struct NewSession {
    pub id: Option<Uuid>,
    pub parent_session_id: Option<String>,
    pub agent_name: Option<String>,
    pub title: Option<String>,
    pub scheduled_task_name: Option<String>,
    pub workspace: String,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub interaction_mode: Option<String>,
}

pub async fn create_session(pool: &DbPool, new: NewSession) -> Result<ChatSession> {
    let id = new.id.map(|u| uuid_db(&u)).unwrap_or_else(new_id);
    let now = now_db();
    sqlx::query(
        r#"INSERT INTO chat_sessions
           (id, parent_session_id, agent_name, title, scheduled_task_name,
            created_at, updated_at, workspace, revert, model, thinking_level,
            history_revision, history_structure_revision, interaction_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'null', ?, ?, 0, 0, ?)"#,
    )
    .bind(&id)
    .bind(new.parent_session_id.as_deref().map(db_id))
    .bind(new.agent_name)
    .bind(new.title)
    .bind(new.scheduled_task_name)
    .bind(&now)
    .bind(&now)
    .bind(new.workspace)
    .bind(new.model)
    .bind(new.thinking_level)
    .bind(new.interaction_mode.unwrap_or_else(|| "code".into()))
    .execute(pool)
    .await?;
    get_session(pool, &id).await?.ok_or_else(|| anyhow!("session vanished after insert"))
}

pub async fn get_session(pool: &DbPool, id: &str) -> Result<Option<ChatSession>> {
    Ok(sqlx::query_as::<_, ChatSession>("SELECT * FROM chat_sessions WHERE id = ?").bind(db_id(id)).fetch_optional(pool).await?)
}

/// Cursor page of top-level sessions, newest first (v2 `list_sessions_page`).
///
/// `before` is the `"<iso created_at>|<uuid>"` cursor this returns.
/// `workspaces` keeps sessions in any of the listed paths; empty lists every
/// workspace. (v2 takes a single workspace; the list is a v3 addition.)
/// `title_query` (a v3 addition) keeps titles containing it, ignoring ASCII
/// case, with `%` and `_` matched literally.
/// Returns `(rows, next_cursor, has_more)`; errors on a malformed cursor.
pub async fn list_sessions_page(
    pool: &DbPool,
    before: Option<&str>,
    limit: i64,
    workspaces: &[String],
    title_query: Option<&str>,
) -> Result<(Vec<ChatSession>, Option<String>, bool)> {
    let mut sql = String::from("SELECT * FROM chat_sessions WHERE parent_session_id IS NULL");
    let mut binds: Vec<String> = Vec::new();
    if !workspaces.is_empty() {
        sql.push_str(&format!(" AND workspace IN ({})", vec!["?"; workspaces.len()].join(",")));
        binds.extend(workspaces.iter().cloned());
    }
    if let Some(q) = title_query.filter(|q| !q.is_empty()) {
        sql.push_str(" AND title LIKE ? ESCAPE '\\'");
        binds.push(format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    }
    if let Some(cursor) = before.filter(|c| !c.is_empty()) {
        let (raw_dt, raw_id) = cursor.split_once('|').ok_or_else(|| anyhow!("invalid before cursor"))?;
        let dt = parse_dt(raw_dt).ok_or_else(|| anyhow!("invalid before cursor"))?;
        let id = parse_uuid(raw_id).ok_or_else(|| anyhow!("invalid before cursor"))?;
        sql.push_str(" AND (created_at, id) < (?, ?)");
        binds.push(dt_db(&dt));
        binds.push(uuid_db(&id));
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
    let mut q = sqlx::query_as::<_, ChatSession>(sqlx::AssertSqlSafe(&*sql));
    for b in &binds {
        q = q.bind(b);
    }
    let mut rows = q.bind(limit + 1).fetch_all(pool).await?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit.max(0) as usize);
    let next_cursor =
        if has_more { rows.last().and_then(|last| parse_dt(&last.created_at).map(|dt| format!("{}|{}", api_dt_from(&dt), crate::codec::api_uuid(&last.id)))) } else { None };
    Ok((rows, next_cursor, has_more))
}

/// Direct children of the given sessions, oldest first.
pub async fn list_child_sessions(pool: &DbPool, parent_ids: &[String]) -> Result<Vec<ChatSession>> {
    if parent_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; parent_ids.len()].join(",");
    let sql = format!("SELECT * FROM chat_sessions WHERE parent_session_id IN ({placeholders}) ORDER BY created_at ASC");
    let mut q = sqlx::query_as::<_, ChatSession>(sqlx::AssertSqlSafe(&*sql));
    for id in parent_ids {
        q = q.bind(db_id(id));
    }
    Ok(q.fetch_all(pool).await?)
}

/// The sessions among `ids` (hex or hyphenated) that still exist, in no
/// particular order. Missing ids are simply absent.
pub async fn get_sessions_by_ids(pool: &DbPool, ids: &[String]) -> Result<Vec<ChatSession>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT * FROM chat_sessions WHERE id IN ({placeholders})");
    let mut q = sqlx::query_as::<_, ChatSession>(sqlx::AssertSqlSafe(&*sql));
    for id in ids {
        q = q.bind(db_id(id));
    }
    Ok(q.fetch_all(pool).await?)
}

/// Newest top-level session for a workspace (v2 `get_latest_top_level_session`).
pub async fn get_latest_top_level_session(pool: &DbPool, workspace: &str) -> Result<Option<ChatSession>> {
    Ok(sqlx::query_as::<_, ChatSession>(
        "SELECT * FROM chat_sessions WHERE parent_session_id IS NULL AND workspace = ? \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(workspace)
    .fetch_optional(pool)
    .await?)
}

/// Partial update; `None` leaves a column untouched. Like SQLAlchemy's
/// dirty tracking, only columns whose value actually changes are written,
/// and `updated_at` moves only when something changed.
#[derive(Debug, Default, Clone)]
pub struct SessionUpdate {
    pub title: Option<Option<String>>,
    pub interaction_mode: Option<String>,
    pub model: Option<Option<String>>,
    pub thinking_level: Option<Option<String>>,
    pub agent_name: Option<Option<String>>,
    pub workspace: Option<String>,
    pub scheduled_task_name: Option<Option<String>>,
    /// `Some(None)` clears the boundary (stores JSON `null`, like v2).
    pub revert: Option<Option<serde_json::Value>>,
}

impl SessionUpdate {
    pub fn title(t: impl Into<String>) -> Self {
        Self { title: Some(Some(t.into())), ..Default::default() }
    }
}

pub async fn update_session(pool: &DbPool, id: &str, upd: SessionUpdate) -> Result<Option<ChatSession>> {
    let sid = db_id(id);
    let Some(cur) = get_session(pool, &sid).await? else { return Ok(None) };
    let mut sets: Vec<(&str, Option<String>)> = Vec::new();
    let mut push = |col: &'static str, new: Option<String>, old: Option<String>| {
        if new != old {
            sets.push((col, new));
        }
    };
    if let Some(t) = upd.title {
        push("title", t, cur.title.clone());
    }
    if let Some(m) = upd.interaction_mode {
        push("interaction_mode", Some(m), Some(cur.interaction_mode.clone()));
    }
    if let Some(m) = upd.model {
        push("model", m, cur.model.clone());
    }
    if let Some(t) = upd.thinking_level {
        push("thinking_level", t, cur.thinking_level.clone());
    }
    if let Some(a) = upd.agent_name {
        push("agent_name", a, cur.agent_name.clone());
    }
    if let Some(w) = upd.workspace {
        push("workspace", Some(w), Some(cur.workspace.clone()));
    }
    if let Some(n) = upd.scheduled_task_name {
        push("scheduled_task_name", n, cur.scheduled_task_name.clone());
    }
    if let Some(r) = upd.revert {
        let new = crate::codec::json_db(r.as_ref());
        let old_v = cur.revert.as_deref().and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
        if old_v.as_ref() != Some(&r.clone().unwrap_or(serde_json::Value::Null)) {
            sets.push(("revert", Some(new)));
        }
    }
    if sets.is_empty() {
        return Ok(Some(cur));
    }
    let cols: Vec<String> = sets.iter().map(|(c, _)| format!("{c} = ?")).collect();
    let sql = format!("UPDATE chat_sessions SET {}, updated_at = ? WHERE id = ?", cols.join(", "));
    let mut q = sqlx::query(sqlx::AssertSqlSafe(&*sql));
    for (_, v) in sets {
        q = q.bind(v);
    }
    q.bind(now_db()).bind(&sid).execute(pool).await?;
    get_session(pool, &sid).await
}

/// v2 `bump_history_revision`. SQLAlchemy's `onupdate=_utcnow` also fires for
/// this Core UPDATE, so `updated_at` moves too.
pub async fn bump_history_revision<'e, E: sqlx::SqliteExecutor<'e>>(ex: E, id: &str, structural: bool) -> Result<()> {
    let sql = if structural {
        "UPDATE chat_sessions SET history_revision = history_revision + 1, \
         history_structure_revision = history_structure_revision + 1, updated_at = ? WHERE id = ?"
    } else {
        "UPDATE chat_sessions SET history_revision = history_revision + 1, updated_at = ? WHERE id = ?"
    };
    sqlx::query(sql).bind(now_db()).bind(db_id(id)).execute(ex).await?;
    Ok(())
}

/// Session plus all descendants (recursive), in the on-disk id form.
pub async fn session_descendants(pool: &DbPool, id: &str) -> Result<Vec<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        r#"WITH RECURSIVE descendants(id) AS (
               SELECT id FROM chat_sessions WHERE id = ?
               UNION
               SELECT c.id FROM chat_sessions c JOIN descendants d ON c.parent_session_id = d.id
           )
           SELECT s.id, s.workspace FROM chat_sessions s WHERE s.id IN (SELECT id FROM descendants)"#,
    )
    .bind(db_id(id))
    .fetch_all(pool)
    .await?)
}

/// Delete a session tree's rows. Returns the deleted `(id, workspace)` pairs
/// (empty when the session did not exist) so callers can clean up disk state.
pub async fn delete_session_rows(pool: &DbPool, id: &str) -> Result<Vec<(String, String)>> {
    let tree = session_descendants(pool, id).await?;
    if tree.is_empty() {
        return Ok(tree);
    }
    let placeholders = vec!["?"; tree.len()].join(",");
    let mut tx = pool.begin().await?;
    for table_sql in [
        format!("DELETE FROM session_messages WHERE session_id IN ({placeholders})"),
        format!("DELETE FROM pending_questions WHERE session_id IN ({placeholders})"),
        format!("DELETE FROM chat_sessions WHERE id IN ({placeholders})"),
    ] {
        let mut q = sqlx::query(sqlx::AssertSqlSafe(&*table_sql));
        for (sid, _) in &tree {
            q = q.bind(sid);
        }
        q.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(tree)
}
