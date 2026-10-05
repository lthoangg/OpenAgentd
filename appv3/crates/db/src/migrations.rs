//! Schema management — a replay of v2's Alembic chain
//! (`app/migrations/versions/00000001` … `00000022`).
//!
//! `resources/migrations/000000NN.sql` hold the exact statements v2's Alembic
//! executes for each revision on SQLite (captured once from `alembic upgrade`
//! with a `before_cursor_execute` hook, one revision at a time; reflection
//! PRAGMAs and SELECTs dropped, statements separated by `-- ;;`): the same
//! DDL, batch-mode table copies, backfill SQL and `alembic_version` stamps.
//! A new v2 revision must be captured the same way. Replaying them gives
//! a fresh or older database the same `sqlite_master` and data v2 would
//! leave behind, so both versions can keep sharing the file.
//!
//! The data-dependent or introspecting parts of v2's migrations are done in
//! code: 00000013 slugifies each scheduled task's name in Python, 00000013
//! and 00000019 skip steps whose target already exists (resuming an
//! interrupted run), and `DROP INDEX` statements are skipped when the index
//! is already gone.
//!
//! Like v2's Alembic environment, migrations run with `foreign_keys=OFF`
//! (so the DELETEs in 00000021 do not cascade) under a sibling
//! `<db>.migrate.lock` file lock, and each revision is applied atomically.

use anyhow::{bail, Context, Result};
use sqlx::{Connection, SqliteConnection, SqlitePool};
use std::path::Path;

/// Alembic head revision this build is schema-compatible with.
pub const ALEMBIC_HEAD: &str = "00000022";

/// Indexes v3 adds on top of v2's head schema, outside the Alembic chain:
/// no revision stamp moves, so a v2 build still opens the file, and v2 only
/// ever sees extra indexes. Created idempotently on every open.
pub const V3_INDEXES: [&str; 2] = [
    // History loads sum usage per session: the indexed `json_extract` values
    // spare parsing every row's `extra` (whole tool results and image
    // parts). SQLite ≥ 3.47 also reads the sum from the index alone; the
    // bundled 3.46 still visits each row.
    "CREATE INDEX IF NOT EXISTS ix_session_messages_usage ON session_messages \
     (session_id, kind, json_extract(extra, '$.usage.cost.estimated_usd'), json_extract(extra, '$.usage.output'))",
    // Queued rows in transcript order. Every model call asks whether any
    // exist, and listing or promoting them sorts by `seq`, which otherwise
    // walks the whole session on `(session_id, seq, id)`. Holding only queued
    // rows, it costs ordinary inserts nothing.
    "CREATE INDEX IF NOT EXISTS ix_session_messages_queued ON session_messages (session_id, seq, id) WHERE kind = 'queued'",
];

/// `(revision, statements)` in upgrade order.
pub const MIGRATIONS: [(&str, &str); 22] = [
    ("00000001", include_str!("../resources/migrations/00000001.sql")),
    ("00000002", include_str!("../resources/migrations/00000002.sql")),
    ("00000003", include_str!("../resources/migrations/00000003.sql")),
    ("00000004", include_str!("../resources/migrations/00000004.sql")),
    ("00000005", include_str!("../resources/migrations/00000005.sql")),
    ("00000006", include_str!("../resources/migrations/00000006.sql")),
    ("00000007", include_str!("../resources/migrations/00000007.sql")),
    ("00000008", include_str!("../resources/migrations/00000008.sql")),
    ("00000009", include_str!("../resources/migrations/00000009.sql")),
    ("00000010", include_str!("../resources/migrations/00000010.sql")),
    ("00000011", include_str!("../resources/migrations/00000011.sql")),
    ("00000012", include_str!("../resources/migrations/00000012.sql")),
    ("00000013", include_str!("../resources/migrations/00000013.sql")),
    ("00000014", include_str!("../resources/migrations/00000014.sql")),
    ("00000015", include_str!("../resources/migrations/00000015.sql")),
    ("00000016", include_str!("../resources/migrations/00000016.sql")),
    ("00000017", include_str!("../resources/migrations/00000017.sql")),
    ("00000018", include_str!("../resources/migrations/00000018.sql")),
    ("00000019", include_str!("../resources/migrations/00000019.sql")),
    ("00000020", include_str!("../resources/migrations/00000020.sql")),
    ("00000021", include_str!("../resources/migrations/00000021.sql")),
    ("00000022", include_str!("../resources/migrations/00000022.sql")),
];

/// Split a captured revision file into statements.
pub fn statements(sql: &str) -> Vec<&str> {
    sql.split("\n-- ;;\n").map(str::trim).filter(|s| !s.is_empty()).collect()
}

/// Schema state detected on open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemaState {
    /// No application tables — v3 created the schema (revisions 1..head).
    Created,
    /// Already stamped at [`ALEMBIC_HEAD`].
    Current,
    /// Upgraded from the given older revision to head.
    Upgraded(String),
}

async fn table_exists(conn: &mut SqliteConnection, name: &str) -> Result<bool> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).fetch_optional(&mut *conn).await?;
    Ok(found.is_some())
}

async fn index_exists(conn: &mut SqliteConnection, name: &str) -> Result<bool> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").bind(name).fetch_optional(&mut *conn).await?;
    Ok(found.is_some())
}

async fn column_names(conn: &mut SqliteConnection, table: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT name FROM pragma_table_info(?)").bind(table).fetch_all(&mut *conn).await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

async fn exec(conn: &mut SqliteConnection, stmt: &str) -> Result<()> {
    sqlx::raw_sql(sqlx::AssertSqlSafe(stmt)).execute(&mut *conn).await.with_context(|| format!("migration statement failed: {}", stmt.lines().next().unwrap_or("")))?;
    Ok(())
}

/// Run one statement, skipping `DROP INDEX` of an index that is gone.
async fn exec_guarded(conn: &mut SqliteConnection, stmt: &str) -> Result<()> {
    if let Some(name) = stmt.strip_prefix("DROP INDEX ") {
        if !index_exists(conn, name.trim()).await? {
            return Ok(());
        }
    }
    exec(conn, stmt).await
}

/// `slugify` from `app/scheduler/utils.py` (used by 00000013).
pub fn slugify(text: &str) -> String {
    appv3_core::slug::slugify(text)
}

/// 00000013: add + backfill `scheduled_task.slug`, then Alembic's batch copy.
async fn migrate_13(conn: &mut SqliteConnection, stmts: &[&str]) -> Result<()> {
    let cols = column_names(conn, "scheduled_task").await?;
    let had_index = index_exists(conn, "ix_scheduled_task_slug").await?;
    for (i, stmt) in stmts.iter().enumerate() {
        if i == 0 {
            if !cols.iter().any(|c| c == "slug") {
                exec(conn, stmt).await?;
            }
            let rows: Vec<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as("SELECT id, name, slug FROM scheduled_task").fetch_all(&mut *conn).await?;
            for (id, name, slug) in rows {
                if slug.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
                    continue;
                }
                sqlx::query("UPDATE scheduled_task SET slug=? WHERE scheduled_task.id = ?").bind(slugify(name.as_deref().unwrap_or(""))).bind(id).execute(&mut *conn).await?;
            }
            continue;
        }
        if had_index && stmt.starts_with("CREATE UNIQUE INDEX ix_scheduled_task_slug ") {
            continue;
        }
        exec_guarded(conn, stmt).await?;
    }
    Ok(())
}

/// 00000019: seq/kind/pinned remodel with v2's resume-safe state detection.
async fn migrate_19(conn: &mut SqliteConnection, stmts: &[&str]) -> Result<()> {
    let find = |prefix: &str| stmts.iter().copied().find(|s| s.starts_with(prefix)).unwrap_or_else(|| panic!("00000019 statement {prefix:?} missing"));
    let cols = column_names(conn, "session_messages").await?;
    for (col, prefix) in [
        ("seq", "ALTER TABLE session_messages ADD COLUMN seq "),
        ("kind", "ALTER TABLE session_messages ADD COLUMN kind "),
        ("pinned", "ALTER TABLE session_messages ADD COLUMN pinned "),
    ] {
        if !cols.iter().any(|c| c == col) {
            exec(conn, find(prefix)).await?;
        }
    }
    let cols = column_names(conn, "session_messages").await?;
    let has_is = cols.iter().any(|c| c == "is_summary");
    let has_ex = cols.iter().any(|c| c == "exclude_from_context");
    let active_summary = find("CREATE INDEX ix_session_messages_active_summary ");
    if has_is && has_ex {
        // `_backfill_derived_state`: the five UPDATEs, with the partial index
        // created before the correlated ones.
        let updates: Vec<&str> = stmts.iter().copied().filter(|s| s.starts_with("UPDATE session_messages")).collect();
        if updates.len() != 5 {
            bail!("00000019: expected 5 backfill statements, found {}", updates.len());
        }
        exec(conn, updates[0]).await?;
        exec(conn, updates[1]).await?;
        if !index_exists(conn, "ix_session_messages_active_summary").await? {
            exec(conn, active_summary).await?;
        }
        for u in &updates[2..] {
            exec(conn, u).await?;
        }
    }
    if has_is || has_ex {
        // `_drop_legacy_columns`
        let cols = column_names(conn, "session_messages").await?;
        if cols.iter().any(|c| c == "is_summary") {
            exec(conn, "ALTER TABLE session_messages DROP COLUMN is_summary").await?;
        }
        if cols.iter().any(|c| c == "exclude_from_context") {
            exec(conn, "ALTER TABLE session_messages DROP COLUMN exclude_from_context").await?;
        }
    }
    // `_ensure_indexes`
    if index_exists(conn, "ix_session_messages_session_created_id").await? {
        exec(conn, "DROP INDEX ix_session_messages_session_created_id").await?;
    }
    if !index_exists(conn, "ix_session_messages_session_seq_id").await? {
        exec(conn, find("CREATE INDEX ix_session_messages_session_seq_id ")).await?;
    }
    if !index_exists(conn, "ix_session_messages_active_summary").await? {
        exec(conn, active_summary).await?;
    }
    exec(conn, find("UPDATE alembic_version ")).await
}

async fn apply(conn: &mut SqliteConnection, rev: &str, sql: &str) -> Result<()> {
    // A Windows checkout with `core.autocrlf` embeds the file with CRLF; the
    // separator and the DDL text stored in `sqlite_master` must read as LF.
    let sql = sql.replace("\r\n", "\n");
    let stmts = statements(&sql);
    let mut tx = conn.begin().await?;
    match rev {
        "00000013" => migrate_13(&mut tx, &stmts).await?,
        "00000019" => migrate_19(&mut tx, &stmts).await?,
        _ => {
            for s in &stmts {
                exec_guarded(&mut tx, s).await?;
            }
        }
    }
    tx.commit().await?;
    tracing::info!("alembic_upgrade revision={}", rev);
    Ok(())
}

/// Bring `conn` to [`ALEMBIC_HEAD`] (the body of `alembic upgrade head`).
pub async fn upgrade(conn: &mut SqliteConnection) -> Result<SchemaState> {
    let current = if table_exists(conn, "alembic_version").await? {
        let v: Option<String> = sqlx::query_scalar("SELECT version_num FROM alembic_version LIMIT 1").fetch_optional(&mut *conn).await?;
        v
    } else {
        if table_exists(conn, "chat_sessions").await? {
            bail!(
                "database has OpenAgentd tables but no alembic_version stamp. It was \
                 probably created by a pre-release v3 build with an incompatible \
                 encoding; move it aside and start again."
            );
        }
        None
    };
    if let Some(v) = &current {
        if v == ALEMBIC_HEAD {
            return Ok(SchemaState::Current);
        }
        if !MIGRATIONS.iter().any(|(r, _)| r == v) {
            bail!("database schema is at Alembic revision {v:?}, which this OpenAgentd v3 build does not know (head {ALEMBIC_HEAD}). Upgrade v3.");
        }
    }
    let start = current.clone().unwrap_or_default();
    for (rev, sql) in MIGRATIONS.iter() {
        if rev.as_bytes() > start.as_bytes() {
            apply(conn, rev, sql).await?;
        }
    }
    Ok(match current {
        None => SchemaState::Created,
        Some(v) => SchemaState::Upgraded(v),
    })
}

async fn ensure_v3_indexes(conn: &mut SqliteConnection) -> Result<()> {
    for stmt in V3_INDEXES {
        exec(conn, stmt).await?;
    }
    Ok(())
}

/// `run_migrations()`: upgrade to head with `foreign_keys=OFF` on one pooled
/// connection, serialised by the sibling `.migrate.lock` file, then add
/// [`V3_INDEXES`].
pub async fn run_migrations(pool: &SqlitePool) -> Result<SchemaState> {
    let db_file: Option<std::path::PathBuf> = {
        let rows: Vec<(i64, String, String)> = sqlx::query_as("PRAGMA database_list").fetch_all(pool).await?;
        rows.into_iter().find(|r| r.1 == "main").map(|r| r.2).filter(|f| !f.is_empty()).map(Into::into)
    };
    let _lock = match &db_file {
        Some(f) => Some(migration_lock(f)?),
        None => None,
    };
    let mut conn = pool.acquire().await?;
    sqlx::raw_sql("PRAGMA foreign_keys=OFF").execute(&mut *conn).await?;
    let res = upgrade(&mut conn).await;
    let _ = sqlx::raw_sql("PRAGMA foreign_keys=ON").execute(&mut *conn).await;
    let state = res.inspect_err(|e| tracing::error!("auto_migrate_failed error={}", e))?;
    if state != SchemaState::Current {
        tracing::info!("auto_migrate_complete");
    }
    ensure_v3_indexes(&mut conn).await?;
    if db_file.is_some() {
        // `_optimize_sqlite` (best-effort).
        if state == SchemaState::Current {
            // Nothing changed the schema, so the statistics are only stale,
            // and a WAL left by a crash can take a while to checkpoint: keep
            // both off the path to the server's first request.
            drop(conn);
            let pool = pool.clone();
            tokio::spawn(async move {
                if let Ok(mut conn) = pool.acquire().await {
                    optimize(&mut conn).await;
                }
            });
        } else {
            optimize(&mut conn).await;
        }
    }
    Ok(state)
}

/// One connection: `analysis_limit` applies to the connection that sets it.
async fn optimize(conn: &mut SqliteConnection) {
    let _ = sqlx::query("PRAGMA analysis_limit=1000").execute(&mut *conn).await;
    let _ = sqlx::query("PRAGMA optimize=0x10002").execute(&mut *conn).await;
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut *conn).await;
}

/// `_sqlite_migration_lock`: exclusive lock on `<db>.migrate.lock`.
fn migration_lock(db: &Path) -> Result<std::fs::File> {
    let name = db.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let path = db.with_file_name(format!("{name}.migrate.lock"));
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let f = std::fs::File::create(&path)?;
    f.lock()?;
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DDL of a v2 database at head (`sqlite3 openagentd.db .schema`).
    const SCHEMA_SQL: &str = r#"
CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
CREATE TABLE "chat_sessions" (
	id CHAR(32) NOT NULL, 
	parent_session_id CHAR(32), 
	agent_name VARCHAR(100), 
	title VARCHAR(255), 
	scheduled_task_name VARCHAR(100), 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	workspace VARCHAR NOT NULL, 
	revert JSON, 
	model VARCHAR(255), 
	thinking_level VARCHAR(50), 
	history_revision INTEGER DEFAULT '0' NOT NULL, 
	history_structure_revision INTEGER DEFAULT '0' NOT NULL, interaction_mode VARCHAR(16) DEFAULT 'code' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(parent_session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
);
CREATE TABLE session_messages (
	id CHAR(32) NOT NULL, 
	session_id CHAR(32) NOT NULL, 
	role VARCHAR(50) NOT NULL, 
	content VARCHAR, 
	reasoning_content VARCHAR, 
	tool_calls JSON, 
	tool_call_id VARCHAR(100), 
	name VARCHAR(100), 
	extra JSON, 
	created_at DATETIME NOT NULL, seq INTEGER DEFAULT '0' NOT NULL, kind VARCHAR(16) DEFAULT 'chat' NOT NULL, pinned BOOLEAN DEFAULT 0 NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
);
CREATE TABLE coding_workspaces (
	id CHAR(32) NOT NULL, 
	path VARCHAR NOT NULL, 
	kind VARCHAR(20) DEFAULT 'repo' NOT NULL, 
	source_path VARCHAR, 
	name VARCHAR(255), 
	managed BOOLEAN DEFAULT 0 NOT NULL, 
	hidden BOOLEAN DEFAULT 0 NOT NULL, 
	deleted_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_coding_workspaces_path UNIQUE (path)
);
CREATE TABLE pending_questions (
	id CHAR(32) NOT NULL, 
	session_id CHAR(32) NOT NULL, 
	tool_call_id VARCHAR(100) NOT NULL, 
	payload JSON NOT NULL, 
	status VARCHAR(20) DEFAULT 'pending' NOT NULL, 
	answers JSON, 
	created_at DATETIME NOT NULL, 
	answered_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE, 
	CONSTRAINT uq_pending_questions_tool_call_id UNIQUE (tool_call_id)
);
CREATE TABLE "scheduled_task" (
	id CHAR(32) NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	schedule_type VARCHAR(20) NOT NULL, 
	at_datetime DATETIME, 
	every_seconds INTEGER, 
	cron_expression VARCHAR(100), 
	timezone VARCHAR(50) DEFAULT 'UTC' NOT NULL, 
	prompt TEXT NOT NULL, 
	session_id VARCHAR(200), 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	status VARCHAR(20) DEFAULT 'pending' NOT NULL, 
	run_count INTEGER DEFAULT '0' NOT NULL, 
	last_run_at DATETIME, 
	last_error TEXT, 
	next_fire_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	workspace VARCHAR NOT NULL, 
	max_runs INTEGER, 
	slug VARCHAR(100) NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_coding_workspaces_source_path ON coding_workspaces (source_path);
CREATE INDEX ix_pending_questions_session_id ON pending_questions (session_id);
CREATE INDEX ix_pending_questions_status ON pending_questions (status);
CREATE UNIQUE INDEX uq_pending_questions_open_per_session ON pending_questions (session_id) WHERE status = 'pending';
CREATE INDEX ix_session_messages_active_summary ON session_messages (session_id, id) WHERE kind = 'summary';
CREATE INDEX ix_session_messages_session_seq_id ON session_messages (session_id, seq, id);
CREATE INDEX ix_session_messages_session_id ON session_messages (session_id, id);
CREATE INDEX ix_chat_sessions_parent_agent_created ON chat_sessions (parent_session_id, agent_name, created_at);
CREATE INDEX ix_chat_sessions_parent_created ON chat_sessions (parent_session_id, created_at, id);
CREATE INDEX ix_chat_sessions_top_created ON chat_sessions (parent_session_id, created_at, id);
CREATE INDEX ix_chat_sessions_top_workspace_created ON chat_sessions (parent_session_id, workspace, created_at, id);
CREATE UNIQUE INDEX ix_scheduled_task_slug ON scheduled_task (slug);
CREATE UNIQUE INDEX ix_scheduled_task_name ON scheduled_task (name);
"#;

    async fn master(conn: &mut SqliteConnection) -> Vec<(String, String, String, Option<String>)> {
        sqlx::query_as("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid").fetch_all(&mut *conn).await.unwrap()
    }

    #[tokio::test]
    async fn replay_matches_v2_head_schema() {
        let mut a = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        assert_eq!(upgrade(&mut a).await.unwrap(), SchemaState::Created);
        let v: String = sqlx::query_scalar("SELECT version_num FROM alembic_version").fetch_one(&mut a).await.unwrap();
        assert_eq!(v, ALEMBIC_HEAD);
        assert_eq!(upgrade(&mut a).await.unwrap(), SchemaState::Current);
        let mut b = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(SCHEMA_SQL).execute(&mut b).await.unwrap();
        let (ma, mb) = (master(&mut a).await, master(&mut b).await);
        let norm = |m: Vec<(String, String, String, Option<String>)>| {
            let mut v: Vec<_> = m.into_iter().map(|(t, n, tb, s)| (t, n, tb, s.map(|s| s.trim().to_string()))).collect();
            v.sort();
            v
        };
        assert_eq!(norm(ma), norm(mb));
    }

    /// Windows checkouts with `core.autocrlf` embed the revision files with
    /// CRLF. They must replay to exactly the schema text an LF build writes.
    #[tokio::test]
    async fn crlf_revision_files_replay_like_lf() {
        let mut lf = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        upgrade(&mut lf).await.unwrap();
        let mut crlf = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for (rev, sql) in MIGRATIONS.iter() {
            // From LF first: on a Windows CI checkout `sql` is already CRLF.
            apply(&mut crlf, rev, &sql.replace("\r\n", "\n").replace('\n', "\r\n")).await.unwrap();
        }
        assert_eq!(master(&mut crlf).await, master(&mut lf).await);
    }
}
