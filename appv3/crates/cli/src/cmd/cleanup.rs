//! `agentd cleanup`: expired sessions and generated artifacts (session
//! files, snapshots, telemetry, managed worktrees). Dry run unless `--apply`.

use crate::cli::CleanupArgs;
use crate::ui::{self, bold, dim, tilde, Table};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

struct Candidate {
    path: PathBuf,
    reason: &'static str,
    bytes: u64,
}

#[derive(Default)]
struct CleanupResult {
    dry_run: bool,
    candidates: Vec<Candidate>,
    deleted: Vec<PathBuf>,
    expired_sessions: usize,
    expired_messages: i64,
    vacuum_reclaimed_bytes: Option<u64>,
    vacuum_error: Option<String>,
    /// Set when the database has no sessions table yet (nothing was scanned).
    not_initialized: bool,
}

fn mtime(p: &Path) -> Option<DateTime<Utc>> {
    std::fs::metadata(p).ok()?.modified().ok().map(DateTime::<Utc>::from)
}

fn old_enough(p: &Path, cutoff: Option<DateTime<Utc>>) -> bool {
    match cutoff {
        None => true,
        Some(c) => mtime(p).is_some_and(|m| m < c),
    }
}

/// Total size of regular files under `path` (symlinks followed by `stat`).
fn dir_size(path: &Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(m) = std::fs::metadata(&p) {
                if m.is_file() {
                    total += m.len();
                }
            }
            if std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                stack.push(p);
            }
        }
    }
    total
}

fn child_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()
}

/// Accepts the forms Python's `uuid.UUID(value)` does.
fn is_uuid(v: &str) -> bool {
    let h = v.replace("urn:", "").replace("uuid:", "");
    let h = h.trim_matches(|c| c == '{' || c == '}').replace('-', "");
    h.len() == 32 && h.chars().all(|c| c.is_ascii_hexdigit())
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

struct SessionRow {
    id: String,
    workspace: String,
    created_at: Option<DateTime<Utc>>,
}

async fn session_rows(db: &SqlitePool) -> Result<Option<Vec<SessionRow>>, sqlx::Error> {
    match sqlx::query("SELECT id, workspace, created_at FROM chat_sessions").fetch_all(db).await {
        Ok(rows) => Ok(Some(
            rows.iter()
                .map(|r| SessionRow {
                    id: appv3_db::codec::api_uuid(&r.try_get::<String, _>(0).unwrap_or_default()),
                    workspace: r.try_get::<String, _>(1).unwrap_or_default(),
                    created_at: r.try_get::<String, _>(2).ok().and_then(|s| appv3_db::codec::parse_dt(&s)),
                })
                .collect(),
        )),
        Err(e) => {
            let d = e.to_string().to_lowercase();
            if d.contains("no such table") && d.contains("chat_sessions") {
                Ok(None)
            } else {
                Err(e)
            }
        }
    }
}

fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    appv3_tools::denied::resolve(&abs)
}

async fn cleanup_generated_artifacts(db: &SqlitePool, db_path: &Path, older_than_days: Option<i64>, dry_run: bool, vacuum: bool) -> Result<CleanupResult, sqlx::Error> {
    let s = appv3_core::settings();
    let cutoff = older_than_days.map(|d| Utc::now() - chrono::Duration::days(d));
    let Some(rows) = session_rows(db).await? else {
        return Ok(CleanupResult { dry_run, not_initialized: true, ..Default::default() });
    };
    let live: HashSet<String> = rows.iter().map(|r| r.id.clone()).collect();
    let mut expired: Vec<String> = vec![];
    let mut coding_workspaces: HashSet<String> = HashSet::new();
    for r in &rows {
        coding_workspaces.insert(resolve(Path::new(&r.workspace)).display().to_string());
        if let (Some(c), Some(at)) = (cutoff, r.created_at) {
            if at < c && !expired.contains(&r.id) {
                expired.push(r.id.clone());
            }
        }
    }
    let coding: &HashSet<String> = &live;
    let mut candidates = vec![];

    for (rel, reason) in [(Path::new("logs").join("sessions"), "old session logs"), (PathBuf::from("telemetry"), "old telemetry files"), (PathBuf::from("otel"), "old otel files")]
    {
        for child in child_dirs(&s.state_dir.join(rel)) {
            if old_enough(&child, cutoff) {
                let bytes = dir_size(&child);
                candidates.push(Candidate { path: child, reason, bytes });
            }
        }
    }
    let scan = |root: PathBuf, expired_reason: (&'static str, &'static str), orphan_reason: &'static str, out: &mut Vec<Candidate>| {
        for child in child_dirs(&root) {
            let n = name(&child);
            if is_uuid(&n) && expired.contains(&n) {
                let reason = if coding.contains(&n) { expired_reason.0 } else { expired_reason.1 };
                let bytes = dir_size(&child);
                out.push(Candidate { path: child, reason, bytes });
            } else if !live.contains(&n) && is_uuid(&n) && old_enough(&child, cutoff) {
                let bytes = dir_size(&child);
                out.push(Candidate { path: child, reason: orphan_reason, bytes });
            }
        }
    };
    scan(s.data_dir.join(appv3_tools::denied::SESSIONS_DIR), ("expired coding session artifacts", "expired session artifacts"), "orphaned session artifacts", &mut candidates);
    scan(s.state_dir.join("snapshot"), ("expired coding session snapshots", "expired session snapshots"), "old session snapshots", &mut candidates);

    // The current worktrees root and the pre-v3.50.0 one in the data dir.
    for repo in s.worktree_roots().iter().flat_map(|root| child_dirs(root)) {
        for child in child_dirs(&repo) {
            if coding_workspaces.contains(&resolve(&child).display().to_string()) {
                continue;
            }
            if old_enough(&child, cutoff) && appv3_api::routes::agent::worktrees::find_managed_worktree_source(&child).await.is_some() {
                let bytes = dir_size(&child);
                candidates.push(Candidate { path: child, reason: "old managed git worktrees", bytes });
            }
        }
    }

    let db_ids: Vec<String> = expired.iter().map(|id| appv3_db::codec::db_id(id)).collect();
    let in_list = || vec!["?"; db_ids.len()].join(", ");
    let mut expired_messages = 0;
    if !db_ids.is_empty() {
        let sql = format!("SELECT count(*) FROM session_messages WHERE session_messages.session_id IN ({})", in_list());
        let mut q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(&*sql));
        for id in &db_ids {
            q = q.bind(id);
        }
        expired_messages = q.fetch_one(db).await?;
    }
    let mut deleted = vec![];
    if !dry_run {
        if !db_ids.is_empty() {
            let mut tx = db.begin().await?;
            for table in ["session_messages", "chat_sessions"] {
                let col = if table == "session_messages" { "session_id" } else { "id" };
                let sql = format!("DELETE FROM {table} WHERE {table}.{col} IN ({})", in_list());
                let mut q = sqlx::query(sqlx::AssertSqlSafe(&*sql));
                for id in &db_ids {
                    q = q.bind(id);
                }
                q.execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        for c in &candidates {
            let _ = std::fs::remove_dir_all(&c.path);
            deleted.push(c.path.clone());
        }
    }
    let (mut reclaimed, mut verr) = (None, None);
    if vacuum && !dry_run {
        match vacuum_sqlite(db_path).await {
            Ok((before, after)) => reclaimed = Some(before.saturating_sub(after)),
            Err(e) => {
                tracing::warn!("cleanup_vacuum_failed db={} error={}", db_path.display(), e);
                verr = Some(e);
            }
        }
    }
    Ok(CleanupResult {
        dry_run,
        candidates,
        deleted,
        expired_sessions: expired.len(),
        expired_messages,
        vacuum_reclaimed_bytes: reclaimed,
        vacuum_error: verr,
        not_initialized: false,
    })
}

/// `VACUUM` + WAL checkpoint → `(size_before, size_after)`.
async fn vacuum_sqlite(path: &Path) -> Result<(u64, u64), String> {
    use sqlx::Connection;
    let before = std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())?;
    let msg = |e: sqlx::Error| e.as_database_error().map(|d| d.message().to_string()).unwrap_or_else(|| e.to_string());
    let opts = SqliteConnectOptions::new().filename(path).busy_timeout(std::time::Duration::from_secs(5));
    let mut conn = sqlx::SqliteConnection::connect_with(&opts).await.map_err(msg)?;
    for sql in ["VACUUM", "PRAGMA wal_checkpoint(TRUNCATE)"] {
        sqlx::query(sql).execute(&mut conn).await.map_err(msg)?;
    }
    let _ = conn.close().await;
    let after = std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())?;
    Ok((before, after))
}

fn format_bytes(size: u64) -> String {
    let mut v = size as f64;
    for unit in ["B", "KB", "MB", "GB"] {
        if v < 1024.0 || unit == "GB" {
            return if unit == "B" { format!("{} B", v as u64) } else { format!("{v:.1} {unit}") };
        }
        v /= 1024.0;
    }
    unreachable!()
}

pub fn cleanup(args: &CleanupArgs) -> Result<()> {
    let dry_run = !args.apply;
    let db_path = appv3_core::settings().database_path.clone();
    // Without a database every session file would look orphaned, so skip
    // the whole pass (and do not create an empty database).
    let r = if !db_path.is_file() {
        CleanupResult { dry_run, not_initialized: true, ..Default::default() }
    } else {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
        rt.block_on(async {
            let opts = SqliteConnectOptions::new().filename(&db_path).busy_timeout(std::time::Duration::from_secs(5));
            let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?;
            let r = cleanup_generated_artifacts(&pool, &db_path, Some(args.older_than_days.into()), dry_run, args.vacuum).await;
            pool.close().await;
            r
        })
        .with_context(|| format!("clean up {}", db_path.display()))?
    };
    print_result(&r, args.older_than_days, args.limit);
    Ok(())
}

/// `62426` → `62,426`.
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A session folder as `~/…/snapshot/01a04658…`: the UUID cut to 8 chars.
fn short_path(p: &Path) -> String {
    let n = name(p);
    if is_uuid(&n) && n.len() > 8 {
        if let Some(parent) = p.parent() {
            return format!("{}/{}…", tilde(parent), &n[..8]);
        }
    }
    tilde(p)
}

fn print_result(r: &CleanupResult, days: u32, limit: usize) {
    let mode = if r.dry_run { "dry run" } else { "applied" };
    ui::header("Cleanup", &format!("{mode} · older than {days} days"));
    if r.not_initialized {
        ui::mark_line(&ui::idle_mark(), "Database not initialized yet; session-backed cleanup was skipped.");
        println!();
        return;
    }
    let total: u64 = r.candidates.iter().map(|c| c.bytes).sum();
    let verb = if r.dry_run { "expire" } else { "removed" };
    println!("  {} sessions · {} messages {}", bold(&thousands(r.expired_sessions as u64)), bold(&thousands(r.expired_messages.max(0) as u64)), dim(verb));
    if r.candidates.is_empty() {
        println!();
        ui::mark_line(&ui::ok_mark(), "No old files to remove");
        println!();
        return;
    }

    // By kind, largest first.
    let mut kinds: Vec<(&str, u64, usize)> = vec![];
    for c in &r.candidates {
        match kinds.iter_mut().find(|(k, ..)| *k == c.reason) {
            Some(k) => {
                k.1 += c.bytes;
                k.2 += 1;
            }
            None => kinds.push((c.reason, c.bytes, 1)),
        }
    }
    kinds.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let folders = |n: usize| format!("{n} {}", if n == 1 { "folder" } else { "folders" });
    let mut table = Table::new();
    for (kind, bytes, n) in &kinds {
        table.row([format!("{:>9}", format_bytes(*bytes)), (*kind).to_string(), dim(&folders(*n))]);
    }
    table.row([format!("{:>9}", bold(&format_bytes(total))), bold("total"), dim(&folders(r.candidates.len()))]);
    println!();
    table.print();

    let mut sorted: Vec<&Candidate> = r.candidates.iter().collect();
    sorted.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    let shown = if limit == 0 { sorted.len() } else { limit.min(sorted.len()) };
    if shown > 0 {
        ui::section(if shown == sorted.len() { "Folders" } else { "Largest" });
        let mut table = Table::new();
        for c in &sorted[..shown] {
            table.row([format!("{:>9}", format_bytes(c.bytes)), short_path(&c.path)]);
        }
        table.print();
        if shown < sorted.len() {
            ui::hint(&format!("… {} more (--limit 0 lists every folder)", sorted.len() - shown));
        }
    }
    println!();
    if let Some(b) = r.vacuum_reclaimed_bytes {
        ui::mark_line(&ui::ok_mark(), &format!("Vacuum reclaimed {}", format_bytes(b)));
    }
    if let Some(e) = &r.vacuum_error {
        ui::mark_line(&ui::warn_mark(), &format!("Vacuum skipped: {e}"));
    }
    if r.dry_run {
        ui::next("No files deleted. Delete them with:", "agentd cleanup --apply");
        ui::hint("Add --vacuum to compact the database afterwards.");
    } else {
        ui::mark_line(&ui::ok_mark(), &format!("Deleted {} ({})", folders(r.deleted.len()), format_bytes(total)));
    }
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_paths_read_short() {
        assert_eq!(thousands(62426), "62,426");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000_000), "1,000,000");
        let p = Path::new("/x/snapshot/01a04658-5218-7498-8788-14a4be521c27");
        assert_eq!(short_path(p), "/x/snapshot/01a04658…");
        assert_eq!(short_path(Path::new("/x/otel/2026-01")), "/x/otel/2026-01");
    }
}
