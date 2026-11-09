use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Connection, SqlitePool};
use std::path::Path;
use std::str::FromStr;

pub type DbPool = SqlitePool;

/// Open (creating if needed) the OpenAgentd SQLite database.
///
/// Connection pragmas match v2's so v2 and
/// v3 behave identically when both touch the same file (WAL, NORMAL sync,
/// FK enforcement, 5 s busy handler, bounded WAL, in-memory temp store,
/// 256 MiB mmap).
///
/// `":memory:"` yields a single-connection pool: every SQLite in-memory
/// connection is a separate database, so a multi-connection pool would
/// scatter reads and writes across unrelated empty databases.
pub async fn create_pool(db_path: impl AsRef<Path>) -> Result<DbPool> {
    disable_sqlite_memstatus();
    let path_str = db_path.as_ref().to_string_lossy().to_string();
    let in_memory = path_str.starts_with(":memory:");

    if !in_memory {
        if let Some(parent) = db_path.as_ref().parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
    }

    let connection_string = if in_memory { "sqlite::memory:".to_string() } else { format!("sqlite://{}", path_str) };

    let mut opts = SqliteConnectOptions::from_str(&connection_string)?
        .create_if_missing(true)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .pragma("journal_size_limit", "67108864")
        .pragma("temp_store", "MEMORY")
        .pragma("mmap_size", "268435456");
    if !in_memory {
        opts = opts.journal_mode(SqliteJournalMode::Wal);
    }

    let pool = pool_options(in_memory).connect_with(opts).await?;

    crate::migrations::run_migrations(&pool).await?;

    Ok(pool)
}

/// The pool settings [`create_pool`] uses.
fn pool_options(in_memory: bool) -> SqlitePoolOptions {
    let (max, min) = if in_memory { (1, 1) } else { (16, 1) };
    // sqlx's network-database defaults cost SQLite for nothing: a ping round
    // trip to the connection's worker thread on every acquire, and recycling
    // connections every 30 minutes, which throws away their page cache. The
    // single in-memory connection *is* the database, so it is never reaped.
    let idle_timeout = if in_memory { None } else { Some(std::time::Duration::from_secs(600)) };
    let opts = SqlitePoolOptions::new()
        .max_connections(max)
        .min_connections(min)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .test_before_acquire(false)
        .max_lifetime(None)
        .idle_timeout(idle_timeout);
    // Closing the single in-memory connection would drop the database itself.
    if in_memory {
        return opts;
    }
    opts.after_release(|conn, _meta| {
        Box::pin(async move {
            if !conn.is_in_transaction() {
                return Ok(true);
            }
            // A dropped transaction queues its ROLLBACK; the ping runs after it.
            conn.ping().await?;
            if conn.is_in_transaction() {
                // The ROLLBACK failed (SQLite had already rolled back, as on a
                // full disk) and sqlx still counts a transaction: every later
                // `BEGIN IMMEDIATE` on this connection would fail. Close it;
                // the pool opens a fresh one.
                tracing::warn!("db_connection_discarded_stuck_transaction");
                return Ok(false);
            }
            Ok(true)
        })
    })
}

/// Turn off SQLite's global allocation statistics before the library
/// initialises. With `SQLITE_DEFAULT_MEMSTATUS=1` (the bundled default) every
/// `sqlite3_malloc`/`free` takes one process-wide mutex; sqlx frees row values
/// from whichever tokio worker drops the row, so concurrent large reads
/// (session history) serialise on that mutex. Behaviour is otherwise unchanged
/// (`sqlite3_memory_used` just reports 0). Must run before the first
/// connection; later calls are no-ops (`SQLITE_MISUSE`, ignored).
fn disable_sqlite_memstatus() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let rc = libsqlite3_sys::sqlite3_config(libsqlite3_sys::SQLITE_CONFIG_MEMSTATUS, 0 as std::os::raw::c_int);
        if rc != libsqlite3_sys::SQLITE_OK {
            tracing::debug!("sqlite_memstatus_config_skipped rc={}", rc);
        }
    });
}

/// Checkpoint and truncate the WAL; called on graceful shutdown like v2.
pub async fn close_pool(pool: &DbPool) {
    let _ = sqlx::query("PRAGMA analysis_limit=1000").execute(pool).await;
    let _ = sqlx::query("PRAGMA optimize=0x10002").execute(pool).await;
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(pool).await;
    pool.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connections_are_kept_and_not_pinged() {
        let dir = tempfile::tempdir().unwrap();
        let file = create_pool(dir.path().join("t.db")).await.unwrap();
        let opts = file.options();
        assert!(!opts.get_test_before_acquire(), "a ping per acquire buys nothing on SQLite");
        assert_eq!(opts.get_max_lifetime(), None, "recycling drops each connection's page cache");

        // The single in-memory connection *is* the database: never reap it.
        let mem = create_pool(":memory:").await.unwrap();
        assert_eq!(mem.options().get_idle_timeout(), None);
        assert_eq!(mem.options().get_max_lifetime(), None);
    }

    /// The disk filled mid-write, SQLite rolled the transaction back on its
    /// own, sqlx's ROLLBACK then failed and left the
    /// connection's transaction depth at 1. Back in the pool, every later
    /// `BEGIN IMMEDIATE` on it failed with "non-zero transaction depth" until
    /// the app restarted, long after the disk had room again.
    #[tokio::test]
    async fn a_write_that_fills_the_disk_does_not_break_later_transactions() {
        let dir = tempfile::tempdir().unwrap();
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", dir.path().join("t.db").display())).unwrap().create_if_missing(true).journal_mode(SqliteJournalMode::Wal);
        // One connection, so the next transaction reuses the one that failed.
        let pool = pool_options(false).max_connections(1).connect_with(opts).await.unwrap();
        sqlx::query("CREATE TABLE t (v BLOB)").execute(&pool).await.unwrap();
        let pages: i64 = sqlx::query_scalar("PRAGMA page_count").fetch_one(&pool).await.unwrap();
        // The "disk" holds only a few more pages.
        sqlx::query(sqlx::AssertSqlSafe(format!("PRAGMA max_page_count = {}", pages + 4))).execute(&pool).await.unwrap();

        {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            let full = sqlx::query("INSERT INTO t VALUES (zeroblob(1000000))").execute(&mut *tx).await;
            assert!(full.is_err(), "the write should have hit the page limit");
            // Dropped like `?` drops it in the checkpointer.
        }

        // Room again.
        sqlx::query("PRAGMA max_page_count = 1073741823").execute(&pool).await.unwrap();
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.expect("a transaction after the disk had room again");
        sqlx::query("INSERT INTO t VALUES (x'01')").execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }
}
