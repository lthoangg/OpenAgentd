//! `session_messages` — ports `chat_service.py`, `chat_service_revert.py`
//! and `chat_service_queue.py`. Ordering is always `(seq, id)`.

use crate::codec::{db_id, json_col, json_db, new_id, now_db, parse_dt, py_isoformat};
use crate::models::{kind, ChatSession, SessionMessage, ToolPairRow, SEQ_STEP};
use crate::pool::DbPool;
use crate::queries::sessions::{bump_history_revision, get_session};
use anyhow::Result;
use serde_json::{Map, Value};

/// v2 history page size (`_HISTORY_PAGE_SIZE`).
pub const HISTORY_PAGE_SIZE: i64 = 100;

/// A message to persist (v2 `save_message` arguments).
#[derive(Debug, Default, Clone)]
pub struct NewMessage {
    pub role: String,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Value>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub extra: Option<Map<String, Value>>,
    /// Explicit kind; derived like v2 when `None`.
    pub kind: Option<String>,
    pub is_summary: bool,
    pub pinned: Option<bool>,
    pub seq: Option<i64>,
    pub created_at: Option<String>,
}

impl NewMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: Some(content.into()), ..Default::default() }
    }
    pub fn assistant(content: Option<String>) -> Self {
        Self { role: "assistant".into(), content, ..Default::default() }
    }
    pub fn tool(call_id: impl Into<String>, name: impl Into<String>, content: impl Into<String>) -> Self {
        Self { role: "tool".into(), content: Some(content.into()), tool_call_id: Some(call_id.into()), name: Some(name.into()), ..Default::default() }
    }
}

pub async fn next_seq<'e, E: sqlx::SqliteExecutor<'e>>(ex: E, session_id: &str) -> Result<i64> {
    let max: Option<i64> = sqlx::query_scalar("SELECT MAX(seq) FROM session_messages WHERE session_id = ?").bind(db_id(session_id)).fetch_one(ex).await?;
    Ok(max.unwrap_or(0) + SEQ_STEP)
}

/// Midpoint strictly between two positions; ties when the gap is exhausted.
pub fn seq_between(prev: i64, next: i64) -> i64 {
    let gap = next - prev;
    if gap >= 2 {
        prev + gap / 2
    } else {
        prev
    }
}

pub async fn get_message<'e, E: sqlx::SqliteExecutor<'e>>(ex: E, id: &str) -> Result<Option<SessionMessage>> {
    Ok(sqlx::query_as::<_, SessionMessage>("SELECT * FROM session_messages WHERE id = ?").bind(db_id(id)).fetch_optional(ex).await?)
}

/// The values `save_message` inserts, derived like v2.
struct InsertRow {
    id: String,
    sid: String,
    msg: NewMessage,
    tool_calls: String,
    extra: String,
    created: String,
    kind: String,
    pinned: bool,
}

fn insert_row(session_id: &str, mut msg: NewMessage) -> InsertRow {
    let extra_hidden = msg.extra.as_ref().and_then(|e| e.get("hidden_from_user")).map(|v| !v.is_null() && v != &Value::Bool(false)).unwrap_or(false);
    let row_kind = msg.kind.clone().unwrap_or_else(|| {
        if msg.is_summary {
            kind::SUMMARY.into()
        } else if extra_hidden {
            kind::NOTE.into()
        } else {
            kind::CHAT.into()
        }
    });
    let pinned = msg
        .pinned
        .unwrap_or_else(|| row_kind == kind::NOTE && msg.extra.as_ref().and_then(|e| e.get("hidden_from_summary")).map(|v| v.as_bool().unwrap_or(!v.is_null())).unwrap_or(false));
    let extra = msg.extra.take().filter(|e| !e.is_empty()).map(Value::Object);
    let tool_calls = msg.tool_calls.take().filter(|t| !t.is_null());
    let created = msg.created_at.as_deref().and_then(crate::codec::db_dt).unwrap_or_else(now_db);
    InsertRow { id: new_id(), sid: db_id(session_id), tool_calls: json_db(tool_calls.as_ref()), extra: json_db(extra.as_ref()), created, kind: row_kind, pinned, msg }
}

// `seq` is allocated inside the INSERT: SQLite takes the write lock for the
// whole statement, so concurrent saves (a queued message while the agent
// writes its reply) cannot read the same MAX(seq).
const INSERT_MESSAGE: &str = r#"INSERT INTO session_messages
           (id, session_id, role, content, reasoning_content, tool_calls,
            tool_call_id, name, extra, created_at, seq, kind, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   COALESCE(?, (SELECT COALESCE(MAX(seq), 0) + ? FROM session_messages WHERE session_id = ?)),
                   ?, ?)"#;

fn bind_insert<'q, O>(
    q: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    r: &'q InsertRow,
) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
    q.bind(&r.id)
        .bind(&r.sid)
        .bind(&r.msg.role)
        .bind(&r.msg.content)
        .bind(&r.msg.reasoning_content)
        .bind(&r.tool_calls)
        .bind(&r.msg.tool_call_id)
        .bind(&r.msg.name)
        .bind(&r.extra)
        .bind(&r.created)
        .bind(r.msg.seq)
        .bind(SEQ_STEP)
        .bind(&r.sid)
        .bind(&r.kind)
        .bind(r.pinned)
}

/// v2 `save_message`: derives `kind`/`pinned`, allocates `seq`, bumps the
/// structural revision for summaries.
pub async fn save_message(pool: &DbPool, session_id: &str, msg: NewMessage) -> Result<SessionMessage> {
    let r = insert_row(session_id, msg);
    let sql = format!("{INSERT_MESSAGE} RETURNING *");
    let row = bind_insert(sqlx::query_as::<_, SessionMessage>(sqlx::AssertSqlSafe(&*sql)), &r).fetch_one(pool).await?;
    if r.kind == kind::SUMMARY {
        bump_history_revision(pool, &r.sid, true).await?;
    }
    Ok(row)
}

/// [`save_message`] returning only the new row's id, on one connection (so a
/// batch can share a transaction). The stored row, whole tool results and
/// image parts included, is not read back.
pub async fn save_message_id(conn: &mut sqlx::SqliteConnection, session_id: &str, msg: NewMessage) -> Result<String> {
    let r = insert_row(session_id, msg);
    let sql = format!("{INSERT_MESSAGE} RETURNING id");
    let (id,): (String,) = bind_insert(sqlx::query_as(sqlx::AssertSqlSafe(&*sql)), &r).fetch_one(&mut *conn).await?;
    if r.kind == kind::SUMMARY {
        bump_history_revision(&mut *conn, &r.sid, true).await?;
    }
    Ok(id)
}

/// Update a row's content/extra in place (placeholder rewrites, usage).
pub async fn update_message_content(pool: &DbPool, id: &str, content: Option<&str>, extra: Option<&Map<String, Value>>) -> Result<()> {
    let extra_val = extra.filter(|e| !e.is_empty()).map(|e| Value::Object(e.clone()));
    sqlx::query("UPDATE session_messages SET content = ?, extra = ? WHERE id = ?").bind(content).bind(json_db(extra_val.as_ref())).bind(db_id(id)).execute(pool).await?;
    Ok(())
}

// ── Revert boundary / active summary ─────────────────────────────────────────

/// The staged undo boundary row, if any (v2 `revert_boundary`).
pub async fn revert_boundary(pool: &DbPool, session: &ChatSession) -> Result<Option<SessionMessage>> {
    let Some(mid) = session.revert_message_id() else { return Ok(None) };
    let row = get_message(pool, &mid.to_string()).await?;
    Ok(row.filter(|r| r.session_id == session.id))
}

/// Newest-created summary, optionally only those positioned before `boundary`.
pub async fn get_active_summary(pool: &DbPool, session_id: &str, boundary: Option<&SessionMessage>) -> Result<Option<SessionMessage>> {
    let sid = db_id(session_id);
    let row = match boundary {
        Some(b) => {
            sqlx::query_as::<_, SessionMessage>(
                "SELECT * FROM session_messages WHERE session_id = ? AND kind = 'summary' \
             AND (seq, id) < (?, ?) ORDER BY id DESC LIMIT 1",
            )
            .bind(&sid)
            .bind(b.seq)
            .bind(&b.id)
            .fetch_optional(pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, SessionMessage>(
                "SELECT * FROM session_messages WHERE session_id = ? AND kind = 'summary' \
             ORDER BY id DESC LIMIT 1",
            )
            .bind(&sid)
            .fetch_optional(pool)
            .await?
        }
    };
    Ok(row)
}

/// Derived LLM window (v2 `_llm_window_rows`): pinned rows + active summary +
/// chat/note rows at/after it, before the undo boundary, `(seq, id)` order.
pub async fn llm_window_rows(pool: &DbPool, session_id: &str, exclude_queued: bool) -> Result<Vec<SessionMessage>> {
    let w = LlmWindow::load(pool, session_id, exclude_queued).await?;
    let sql = w.sql("*", "");
    Ok(w.bind(sqlx::query_as::<_, SessionMessage>(sqlx::AssertSqlSafe(&*sql))).fetch_all(pool).await?)
}

/// Assistant and tool rows of the LLM window, tool-pairing columns only.
pub async fn llm_window_tool_pairs(pool: &DbPool, session_id: &str) -> Result<Vec<ToolPairRow>> {
    let w = LlmWindow::load(pool, session_id, false).await?;
    let sql = w.sql("session_id, role, tool_calls, tool_call_id, created_at, seq", " AND (role = 'tool' OR (role = 'assistant' AND tool_calls IS NOT NULL))");
    Ok(w.bind(sqlx::query_as::<_, ToolPairRow>(sqlx::AssertSqlSafe(&*sql))).fetch_all(pool).await?)
}

/// Which rows the model sees: after the active summary, before the revert
/// boundary. Shared so every reader agrees on the window.
struct LlmWindow {
    sid: String,
    exclude_queued: bool,
    summary: Option<SessionMessage>,
    boundary: Option<SessionMessage>,
}

impl LlmWindow {
    async fn load(pool: &DbPool, session_id: &str, exclude_queued: bool) -> Result<Self> {
        let sid = db_id(session_id);
        // v2 tolerates a missing session row (no revert boundary then).
        let boundary = match get_session(pool, &sid).await? {
            Some(session) => revert_boundary(pool, &session).await?,
            None => None,
        };
        let summary = get_active_summary(pool, &sid, boundary.as_ref()).await?;
        Ok(Self { sid, exclude_queued, summary, boundary })
    }

    fn sql(&self, columns: &str, extra_filter: &str) -> String {
        let mut sql = format!("SELECT {columns} FROM session_messages WHERE session_id = ? AND kind != 'reverted'");
        if self.exclude_queued {
            sql.push_str(" AND kind != 'queued'");
        }
        if self.summary.is_some() {
            sql.push_str(" AND (pinned = 1 OR (seq, id) >= (?, ?)) AND (kind != 'summary' OR id = ?)");
        } else {
            sql.push_str(" AND kind != 'summary'");
        }
        if self.boundary.is_some() {
            sql.push_str(" AND (seq, id) < (?, ?)");
        }
        sql.push_str(extra_filter);
        sql.push_str(" ORDER BY seq ASC, id ASC");
        sql
    }

    fn bind<'q, O>(
        &'q self,
        mut q: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    ) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
        q = q.bind(&self.sid);
        if let Some(s) = &self.summary {
            q = q.bind(s.seq).bind(&s.id).bind(&s.id);
        }
        if let Some(b) = &self.boundary {
            q = q.bind(b.seq).bind(&b.id);
        }
        q
    }
}

// ── History (user-visible transcript) ────────────────────────────────────────

const USER_VISIBLE: &str = "kind NOT IN ('note', 'reverted')";

/// Usage totals over `session_id IN (<marks>)`, read from the indexed
/// `json_extract` values of `ix_session_messages_usage`.
fn usage_totals_sql(marks: &str) -> String {
    format!(
        "SELECT session_id, \
                CAST(COALESCE(SUM(json_extract(extra, '$.usage.cost.estimated_usd')), 0) AS REAL), \
                CAST(COALESCE(SUM(json_extract(extra, '$.usage.output')), 0) AS REAL) \
         FROM session_messages WHERE session_id IN ({marks}) AND {USER_VISIBLE} GROUP BY session_id"
    )
}

/// Probed before every model call; answered from an index, not by scanning
/// the session.
const HAS_QUEUED_SQL: &str = "SELECT EXISTS (SELECT 1 FROM session_messages WHERE session_id = ? AND role = 'user' AND kind = 'queued')";

/// Queued rows in transcript order (listing and promotion).
const QUEUED_ROWS_SQL: &str = "SELECT * FROM session_messages WHERE session_id = ? AND kind = 'queued' ORDER BY seq ASC, id ASC";

/// Newest-first page, returned chronological. `(rows, has_more, boundary)`.
pub async fn history_page(pool: &DbPool, session_id: &str, before: Option<(i64, Option<String>)>) -> Result<(Vec<SessionMessage>, bool, Option<SessionMessage>)> {
    let sid = db_id(session_id);
    let mut sql = format!("SELECT * FROM session_messages WHERE session_id = ? AND {USER_VISIBLE}");
    match &before {
        Some((_, Some(_))) => sql.push_str(" AND (seq, id) < (?, ?)"),
        Some((_, None)) => sql.push_str(" AND seq < ?"),
        None => {}
    }
    sql.push_str(" ORDER BY seq DESC, id DESC LIMIT ?");
    let mut q = sqlx::query_as::<_, SessionMessage>(sqlx::AssertSqlSafe(&*sql)).bind(&sid);
    if let Some((seq, id)) = &before {
        q = q.bind(*seq);
        if let Some(id) = id {
            q = q.bind(db_id(id));
        }
    }
    let mut rows = q.bind(HISTORY_PAGE_SIZE + 1).fetch_all(pool).await?;
    let has_more = rows.len() as i64 > HISTORY_PAGE_SIZE;
    rows.truncate(HISTORY_PAGE_SIZE as usize);
    rows.reverse();
    let boundary = if has_more { rows.first().cloned() } else { None };
    Ok((rows, has_more, boundary))
}

/// Rows created after the uuid7 `since` cursor, `(seq, id)` ordered.
/// Returns `(rows, truncated)`.
pub async fn history_since(pool: &DbPool, session_id: &str, since_id: &str, limit: i64) -> Result<(Vec<SessionMessage>, bool)> {
    let sql = format!(
        "SELECT * FROM session_messages WHERE session_id = ? AND id > ? AND {USER_VISIBLE} \
         ORDER BY id ASC LIMIT ?"
    );
    let mut rows = sqlx::query_as::<_, SessionMessage>(sqlx::AssertSqlSafe(&*sql)).bind(db_id(session_id)).bind(db_id(since_id)).bind(limit + 1).fetch_all(pool).await?;
    let truncated = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    rows.sort_by(|a, b| (a.seq, &a.id).cmp(&(b.seq, &b.id)));
    Ok((rows, truncated))
}

/// `(estimated_cost_usd, completion_tokens)` over user-visible rows.
pub async fn session_usage_totals(pool: &DbPool, session_id: &str) -> Result<(f64, i64)> {
    Ok(session_usage_totals_many(pool, &[session_id]).await?.remove(session_id).unwrap_or((0.0, 0)))
}

/// [`session_usage_totals`] for several sessions in one scan, keyed by the
/// caller's id. A session with no rows maps to `(0.0, 0)`.
pub async fn session_usage_totals_many(pool: &DbPool, session_ids: &[&str]) -> Result<std::collections::HashMap<String, (f64, i64)>> {
    let mut out: std::collections::HashMap<String, (f64, i64)> = session_ids.iter().map(|id| (id.to_string(), (0.0, 0))).collect();
    if session_ids.is_empty() {
        return Ok(out);
    }
    let by_db: std::collections::HashMap<String, &str> = session_ids.iter().map(|id| (db_id(id), *id)).collect();
    let marks = vec!["?"; by_db.len()].join(", ");
    let sql = usage_totals_sql(&marks);
    let mut q = sqlx::query_as::<_, (String, f64, f64)>(sqlx::AssertSqlSafe(&*sql));
    for id in by_db.keys() {
        q = q.bind(id);
    }
    for (sid, cost, completion) in q.fetch_all(pool).await? {
        if let Some(caller) = by_db.get(&sid) {
            out.insert(caller.to_string(), (appv3_core::pymath::py_round(cost, 8), completion as i64));
        }
    }
    Ok(out)
}

/// Newest row cursor `(seq, id)` of a session.
pub async fn get_history_cursor(pool: &DbPool, session_id: &str) -> Result<Option<(i64, String)>> {
    Ok(sqlx::query_as::<_, (i64, String)>("SELECT seq, id FROM session_messages WHERE session_id = ? ORDER BY seq DESC, id DESC LIMIT 1")
        .bind(db_id(session_id))
        .fetch_optional(pool)
        .await?)
}

// ── Undo / redo ──────────────────────────────────────────────────────────────

/// Real human-authored user rows (not another agent's inbox message).
const REAL_USER: &str = "role = 'user' AND (json_extract(extra, '$.from_agent') IS NULL \
                         OR json_extract(extra, '$.from_agent') = 'user')";

/// Next undo target (v2 `undo_session_messages` target selection).
pub async fn find_undo_target(pool: &DbPool, session: &ChatSession) -> Result<Option<SessionMessage>> {
    let boundary = revert_boundary(pool, session).await?;
    let active = get_active_summary(pool, &session.id, boundary.as_ref()).await?;
    let mut sql = format!("SELECT * FROM session_messages WHERE session_id = ? AND {REAL_USER} AND kind IN ('chat', 'summary')");
    if active.is_some() {
        sql.push_str(" AND (kind = 'summary' OR (seq, id) >= (?, ?))");
    }
    if boundary.is_some() {
        sql.push_str(" AND (seq, id) < (?, ?)");
    }
    sql.push_str(" ORDER BY seq DESC, id DESC LIMIT 1");
    let mut q = sqlx::query_as::<_, SessionMessage>(sqlx::AssertSqlSafe(&*sql)).bind(&session.id);
    if let Some(a) = &active {
        q = q.bind(a.seq).bind(&a.id);
    }
    if let Some(b) = &boundary {
        q = q.bind(b.seq).bind(&b.id);
    }
    let row = q.fetch_optional(pool).await?;
    Ok(row.filter(|r| (r.kind == kind::CHAT || r.kind == kind::SUMMARY) && r.is_from_user()))
}

/// Next real user chat row after the boundary (v2 redo target).
pub async fn find_redo_target(pool: &DbPool, session: &ChatSession, boundary: &SessionMessage) -> Result<Option<SessionMessage>> {
    let sql = format!(
        "SELECT * FROM session_messages WHERE session_id = ? AND {REAL_USER} AND kind = 'chat' \
         AND (seq, id) > (?, ?) ORDER BY seq ASC, id ASC LIMIT 1"
    );
    Ok(sqlx::query_as::<_, SessionMessage>(sqlx::AssertSqlSafe(&*sql)).bind(&session.id).bind(boundary.seq).bind(&boundary.id).fetch_optional(pool).await?)
}

/// The `chat_sessions.revert` blob v2 writes for a boundary at `target`.
pub fn revert_state(target: &SessionMessage, anchor: Option<&str>) -> Value {
    let created = parse_dt(&target.created_at).map(|d| py_isoformat(&d)).unwrap_or_else(|| target.created_at.clone());
    let mut m = Map::new();
    m.insert("message_id".into(), Value::String(crate::codec::api_uuid(&target.id)));
    m.insert("created_at".into(), Value::String(created));
    if let Some(a) = anchor.filter(|a| !a.is_empty()) {
        m.insert("snapshot".into(), Value::String(a.to_string()));
    }
    Value::Object(m)
}

/// Materialise an undo: rows at/after the boundary become `reverted`
/// (queued rows survive). Clears the boundary. v2 `cleanup_reverted_tail`.
pub async fn cleanup_reverted_tail(pool: &DbPool, session_id: &str) -> Result<u64> {
    let sid = db_id(session_id);
    let Some(session) = get_session(pool, &sid).await? else { return Ok(0) };
    let Some(boundary) = revert_boundary(pool, &session).await? else { return Ok(0) };
    let mut tx = pool.begin().await?;
    let cleaned = sqlx::query(
        "UPDATE session_messages SET kind = 'reverted' WHERE session_id = ? \
         AND (seq, id) >= (?, ?) AND kind != 'queued'",
    )
    .bind(&sid)
    .bind(boundary.seq)
    .bind(&boundary.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query("UPDATE chat_sessions SET revert = 'null', updated_at = ? WHERE id = ?").bind(now_db()).bind(&sid).execute(&mut *tx).await?;
    tx.commit().await?;
    if cleaned > 0 {
        bump_history_revision(pool, &sid, true).await?;
    }
    Ok(cleaned)
}

/// v2 `exclude_messages_before_summary`: anchor a fresh summary so it covers
/// all but the last `keep_last_n` window rows. Returns rows covered.
pub async fn exclude_messages_before_summary(pool: &DbPool, session_id: &str, summary_id: &str, keep_last_n: i64) -> Result<i64> {
    let sid = db_id(session_id);
    let Some(summary) = get_message(pool, summary_id).await? else { return Ok(0) };
    if summary.session_id != sid {
        return Ok(0);
    }
    let previous = get_active_summary(pool, &sid, None).await?;
    let mut cond = String::from("session_id = ? AND kind IN ('chat', 'note') AND (seq, id) < (?, ?)");
    let restrict = previous.as_ref().filter(|p| p.id != summary.id).cloned();
    if restrict.is_some() {
        cond.push_str(" AND (pinned = 1 OR (seq, id) >= (?, ?))");
    }
    let count_sql = format!("SELECT COUNT(*) FROM session_messages WHERE {cond}");
    let mut count_q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(&*count_sql)).bind(sid.clone()).bind(summary.seq).bind(summary.id.clone());
    if let Some(p) = &restrict {
        count_q = count_q.bind(p.seq).bind(p.id.clone());
    }
    let total_before = count_q.fetch_one(pool).await?;

    let mut new_seq = summary.seq;
    if keep_last_n > 0 && total_before > 0 {
        let offset = keep_last_n.min(total_before) - 1;
        let kept_sql = format!("SELECT * FROM session_messages WHERE {cond} ORDER BY seq DESC, id DESC LIMIT 1 OFFSET {offset}");
        let mut kept_q = sqlx::query_as::<_, SessionMessage>(sqlx::AssertSqlSafe(&*kept_sql)).bind(sid.clone()).bind(summary.seq).bind(summary.id.clone());
        if let Some(p) = &restrict {
            kept_q = kept_q.bind(p.seq).bind(p.id.clone());
        }
        let first_kept = kept_q.fetch_optional(pool).await?;
        if let Some(fk) = first_kept {
            let prev: Option<i64> = sqlx::query_scalar("SELECT MAX(seq) FROM session_messages WHERE session_id = ? AND seq < ?").bind(&sid).bind(fk.seq).fetch_one(pool).await?;
            new_seq = seq_between(prev.unwrap_or(0), fk.seq);
            sqlx::query("UPDATE session_messages SET seq = ? WHERE id = ?").bind(new_seq).bind(&summary.id).execute(pool).await?;
        }
    }
    let covered = if keep_last_n <= 0 { total_before } else { (total_before - keep_last_n).max(0) };
    sqlx::query(
        "UPDATE session_messages SET pinned = 0 WHERE session_id = ? AND pinned = 1 \
         AND (seq < ? OR (seq = ? AND id < ?))",
    )
    .bind(&sid)
    .bind(new_seq)
    .bind(new_seq)
    .bind(&summary.id)
    .execute(pool)
    .await?;
    if covered > 0 {
        bump_history_revision(pool, &sid, true).await?;
    }
    Ok(covered)
}

// ── Queue ────────────────────────────────────────────────────────────────────

/// v2 `save_queued_user_message`.
pub async fn save_queued_user_message(pool: &DbPool, session_id: &str, content: &str, extra: Option<Map<String, Value>>) -> Result<SessionMessage> {
    let mut e = extra.unwrap_or_default();
    e.insert("queue_status".into(), Value::String("queued".into()));
    e.insert("queued_at".into(), Value::String(py_isoformat(&chrono::Utc::now())));
    save_message(pool, session_id, NewMessage { kind: Some(kind::QUEUED.into()), extra: Some(e), ..NewMessage::user(content) }).await
}

/// True when the session has any queued user rows awaiting promotion.
pub async fn has_queued_user_messages(pool: &DbPool, session_id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar(HAS_QUEUED_SQL).bind(db_id(session_id)).fetch_one(pool).await?)
}

/// Whether `row` belongs to another message (its @-mention context or an
/// attachment's text, `extra.attachment_for_message_id`) rather than being
/// one the user wrote.
pub fn is_attached_row(row: &SessionMessage) -> bool {
    row.extra_json().is_some_and(|e| e.get("attachment_for_message_id").is_some_and(|v| !v.is_null()))
}

/// Promote all queued rows to `chat` at the tail (v2 `_promote_queued`).
/// `snapshot` is stored on each promoted row's `extra`.
///
/// The rows attached to each one (its @-mention context, saved separately at
/// queue time) move right after it and are pinned, as an immediate send's
/// mention note is. Left where they were saved, the context sat before its
/// steer, and an injection mid-turn delivered the steer without it. Returns
/// every moved row in transcript order; [`is_attached_row`] tells them apart.
pub async fn release_queued_user_messages(pool: &DbPool, session_id: &str, snapshot: Option<&str>) -> Result<Vec<SessionMessage>> {
    let sid = db_id(session_id);
    let queued = sqlx::query_as::<_, SessionMessage>(
        "SELECT * FROM session_messages WHERE session_id = ? AND role = 'user' AND kind = 'queued' \
         ORDER BY seq ASC, id ASC",
    )
    .bind(&sid)
    .fetch_all(pool)
    .await?;
    if queued.is_empty() {
        return Ok(queued);
    }
    let released = chrono::Utc::now();
    // IMMEDIATE takes the write lock up front, so the tail read below and
    // the updates cannot interleave with a concurrent `save_message`.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let max: Option<i64> = sqlx::query_scalar("SELECT MAX(seq) FROM session_messages WHERE session_id = ?").bind(&sid).fetch_one(&mut *tx).await?;
    let mut next_seq = max.unwrap_or(0) + SEQ_STEP;
    let mut moved: i64 = 0;
    let mut out = Vec::with_capacity(queued.len());
    for row in &queued {
        let mut extra = match row.extra_json() {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        extra.remove("queue_status");
        extra.remove("queued_at");
        if let Some(s) = snapshot {
            extra.insert("snapshot".into(), Value::String(s.into()));
        }
        let extra_v = if extra.is_empty() { None } else { Some(Value::Object(extra)) };
        // A row cancelled since the read above updates nothing and is skipped.
        let Some(promoted) = sqlx::query_as::<_, SessionMessage>("UPDATE session_messages SET kind = 'chat', seq = ?, created_at = ?, extra = ? WHERE id = ? RETURNING *")
            .bind(next_seq)
            .bind(crate::codec::dt_db(&(released + chrono::Duration::microseconds(moved))))
            .bind(json_db(extra_v.as_ref()))
            .bind(&row.id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            continue;
        };
        next_seq += SEQ_STEP;
        moved += 1;
        out.push(promoted);
        let attached: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM session_messages WHERE session_id = ? \
             AND json_extract(extra, '$.attachment_for_message_id') IN (?, ?) ORDER BY seq ASC, id ASC",
        )
        .bind(&sid)
        .bind(crate::codec::api_uuid(&row.id))
        .bind(&row.id)
        .fetch_all(&mut *tx)
        .await?;
        for id in attached {
            let row = sqlx::query_as::<_, SessionMessage>("UPDATE session_messages SET seq = ?, created_at = ?, pinned = 1 WHERE id = ? RETURNING *")
                .bind(next_seq)
                .bind(crate::codec::dt_db(&(released + chrono::Duration::microseconds(moved))))
                .bind(&id)
                .fetch_one(&mut *tx)
                .await?;
            next_seq += SEQ_STEP;
            moved += 1;
            out.push(row);
        }
    }
    // Same transaction: readers never see promoted rows under the old revision.
    bump_history_revision(&mut *tx, &sid, true).await?;
    tx.commit().await?;
    Ok(out)
}

/// v2 `cancel_queued_user_message`. Returns false when not a queued row of
/// this session. Attachment files listed in `extra.attachments[].path` are
/// deleted best-effort, as are mention rows tied to it.
pub async fn cancel_queued_user_message(pool: &DbPool, session_id: &str, message_id: &str) -> Result<bool> {
    let sid = db_id(session_id);
    let Some(row) = get_message(pool, message_id).await? else { return Ok(false) };
    if row.session_id != sid || row.kind != kind::QUEUED {
        return Ok(false);
    }
    if let Some(Value::Array(atts)) = row.extra_json().and_then(|e| e.get("attachments").cloned()) {
        for att in atts {
            if let Some(p) = att.get("path").and_then(|p| p.as_str()) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    let mut tx = pool.begin().await?;
    sqlx::query(
        "DELETE FROM session_messages WHERE session_id = ? \
         AND json_extract(extra, '$.attachment_for_message_id') IN (?, ?)",
    )
    .bind(&sid)
    .bind(crate::codec::api_uuid(&row.id))
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM session_messages WHERE id = ?").bind(&row.id).execute(&mut *tx).await?;
    tx.commit().await?;
    bump_history_revision(pool, &sid, true).await?;
    Ok(true)
}

/// Queued rows of a session (for the UI queue display / activation).
pub async fn list_queued_messages(pool: &DbPool, session_id: &str) -> Result<Vec<SessionMessage>> {
    Ok(sqlx::query_as::<_, SessionMessage>(QUEUED_ROWS_SQL).bind(db_id(session_id)).fetch_all(pool).await?)
}

/// The newest assistant row by `(seq, id)` gets `extra.interrupted = true`.
/// `seq` is transcript order and walks the `(session_id, seq, id)` index;
/// `created_at` sorted the whole session and can step back with the clock.
pub async fn mark_last_assistant_interrupted(pool: &DbPool, session_id: &str) -> Result<()> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT id, extra FROM session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC, id DESC LIMIT 1")
            .bind(db_id(session_id))
            .fetch_optional(pool)
            .await?;
    if let Some((id, extra)) = row {
        let mut extra = match json_col(extra.as_deref()) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        extra.insert("interrupted".into(), Value::Bool(true));
        sqlx::query("UPDATE session_messages SET extra = ? WHERE id = ?").bind(json_db(Some(&Value::Object(extra)))).bind(&id).execute(pool).await?;
    }
    Ok(())
}

/// Content of the newest assistant row by `(seq, id)` (subagent deliverables).
pub async fn last_assistant_content(pool: &DbPool, session_id: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT content FROM session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC, id DESC LIMIT 1")
        .bind(db_id(session_id))
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|r| r.0))
}

// ── Workspace messages (`extra.sent_from`) ───────────────────────────────────

/// Requests from another workspace that asked for a reply and have not had
/// their final answer yet, in transcript order. Queued, reverted and
/// summary rows are not pending.
pub async fn pending_reply_requests(pool: &DbPool, session_id: &str) -> Result<Vec<SessionMessage>> {
    Ok(sqlx::query_as::<_, SessionMessage>(
        "SELECT * FROM session_messages WHERE session_id = ? AND role = 'user' AND kind = 'chat' \
         AND extra LIKE '%\"sent_from\"%' \
         AND json_extract(extra, '$.sent_from.reply') = 1 \
         AND json_extract(extra, '$.sent_from.replied_at') IS NULL \
         ORDER BY seq ASC, id ASC",
    )
    .bind(db_id(session_id))
    .fetch_all(pool)
    .await?)
}

/// `extra.sent_from` of the newest user row that came from another
/// workspace (for hop counting), queued rows included.
pub async fn latest_sent_from(pool: &DbPool, session_id: &str) -> Result<Option<Value>> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT json_extract(extra, '$.sent_from') FROM session_messages WHERE session_id = ? AND role = 'user' \
         AND kind IN ('chat', 'queued') AND extra LIKE '%\"sent_from\"%' \
         AND json_extract(extra, '$.sent_from') IS NOT NULL ORDER BY seq DESC, id DESC LIMIT 1",
    )
    .bind(db_id(session_id))
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|r| r.0).and_then(|s| serde_json::from_str(&s).ok()))
}

/// Direct `SessionMessage(...)` insert with model defaults (seq 0, kind chat),
/// as v2 `send_subagent_message` does for the `ask_lead` answer.
pub async fn insert_raw_tool_message(pool: &DbPool, session_id: &str, content: &str, tool_call_id: &str, name: &str) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO session_messages
           (id, session_id, role, content, reasoning_content, tool_calls,
            tool_call_id, name, extra, created_at, seq, kind, pinned)
           VALUES (?, ?, 'tool', ?, NULL, 'null', ?, ?, 'null', ?, 0, 'chat', 0)"#,
    )
    .bind(new_id())
    .bind(db_id(session_id))
    .bind(content)
    .bind(tool_call_id)
    .bind(name)
    .bind(now_db())
    .execute(pool)
    .await?;
    Ok(())
}

/// First `role='tool'` row for *tool_call_id* in a session (`_load_bound_mcp_app`).
pub async fn find_tool_message(pool: &DbPool, session_id: &str, tool_call_id: &str) -> Result<Option<SessionMessage>> {
    Ok(sqlx::query_as::<_, SessionMessage>("SELECT * FROM session_messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ? LIMIT 1")
        .bind(db_id(session_id))
        .bind(tool_call_id)
        .fetch_optional(pool)
        .await?)
}

#[cfg(test)]
mod tests {
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
    #[tokio::test]
    async fn history_page_keeps_the_seq_index() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::create_pool(dir.path().join("t.db")).await.unwrap();
        let sql = format!("SELECT * FROM session_messages WHERE session_id = ? AND {USER_VISIBLE} ORDER BY seq DESC, id DESC LIMIT ?");
        let p = plan(&pool, &sql, 2).await;
        assert!(p.contains("ix_session_messages_session_seq_id") && !p.contains("TEMP B-TREE"), "{p}");
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
    }
}
