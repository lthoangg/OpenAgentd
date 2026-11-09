//! `coding_workspaces` queries.

use crate::codec::{new_id, now_db};
use crate::models::CodingWorkspace;
use crate::pool::DbPool;
use anyhow::Result;
use std::path::Path;

/// `Path(p).expanduser().resolve()` — resolves symlinks when the path exists,
/// otherwise normalises lexically (Python's non-strict resolve).
pub fn resolve_path(p: &str) -> String {
    let expanded = if let Some(rest) = p.strip_prefix("~") {
        let home = appv3_core::home::home_dir_opt().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
        format!("{home}{rest}")
    } else {
        p.to_string()
    };
    let path = Path::new(&expanded);
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    if let Ok(c) = dunce::canonicalize(&abs) {
        return c.to_string_lossy().to_string();
    }
    let mut out = std::path::PathBuf::new();
    for comp in abs.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out.to_string_lossy().to_string()
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

pub async fn get_workspace_by_path(pool: &DbPool, path: &str) -> Result<Option<CodingWorkspace>> {
    Ok(sqlx::query_as::<_, CodingWorkspace>("SELECT * FROM coding_workspaces WHERE path = ?").bind(path).fetch_optional(pool).await?)
}

/// Upsert a coding workspace (preserves an existing worktree row when a
/// plain repo upsert without source arrives).
pub async fn upsert_coding_workspace(pool: &DbPool, path: &str, kind: &str, source_path: Option<&str>, name: Option<&str>, managed: bool, hidden: bool) -> Result<CodingWorkspace> {
    let resolved = resolve_path(path);
    let source = source_path.map(resolve_path);
    let now = now_db();
    match get_workspace_by_path(pool, &resolved).await? {
        None => {
            sqlx::query(
                "INSERT INTO coding_workspaces (id, path, kind, source_path, name, managed, hidden, deleted_at, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
            )
            .bind(new_id())
            .bind(&resolved)
            .bind(kind)
            .bind(&source)
            .bind(name.map(str::to_string).unwrap_or_else(|| basename(&resolved)))
            .bind(managed)
            .bind(hidden)
            .bind(&now)
            .bind(&now)
            .execute(pool)
            .await?;
        }
        Some(row) => {
            let preserve = row.kind == "worktree" && kind == "repo" && source.is_none();
            if !preserve {
                sqlx::query("UPDATE coding_workspaces SET kind = ?, source_path = ?, name = ?, managed = ?, hidden = ?, deleted_at = NULL, updated_at = ? WHERE id = ?")
                    .bind(kind)
                    .bind(&source)
                    .bind(name.map(str::to_string).unwrap_or_else(|| basename(&resolved)))
                    .bind(managed)
                    .bind(hidden)
                    .bind(&now)
                    .bind(&row.id)
                    .execute(pool)
                    .await?;
            } else {
                let new_name = name.map(str::to_string).or(row.name.clone());
                sqlx::query("UPDATE coding_workspaces SET name = ?, hidden = ?, deleted_at = NULL, updated_at = ? WHERE id = ?")
                    .bind(new_name)
                    .bind(hidden)
                    .bind(&now)
                    .bind(&row.id)
                    .execute(pool)
                    .await?;
            }
        }
    }
    Ok(get_workspace_by_path(pool, &resolved).await?.expect("upserted"))
}

pub async fn hide_coding_workspace(pool: &DbPool, path: &str) -> Result<u64> {
    let resolved = resolve_path(path);
    let n = sqlx::query("UPDATE coding_workspaces SET hidden = 1, updated_at = ? WHERE path = ?").bind(now_db()).bind(&resolved).execute(pool).await?.rows_affected();
    if n > 0 {
        return Ok(n);
    }
    let now = now_db();
    sqlx::query(
        "INSERT INTO coding_workspaces (id, path, kind, source_path, name, managed, hidden, deleted_at, created_at, updated_at) \
         VALUES (?, ?, 'repo', NULL, ?, 0, 1, NULL, ?, ?)",
    )
    .bind(new_id())
    .bind(&resolved)
    .bind(basename(&resolved))
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(1)
}

pub async fn mark_coding_workspace_deleted(pool: &DbPool, path: &str) -> Result<u64> {
    let resolved = resolve_path(path);
    let now = now_db();
    let n = sqlx::query("UPDATE coding_workspaces SET hidden = 1, deleted_at = ?, updated_at = ? WHERE path = ?")
        .bind(&now)
        .bind(&now)
        .bind(&resolved)
        .execute(pool)
        .await?
        .rows_affected();
    if n > 0 {
        return Ok(n);
    }
    sqlx::query(
        "INSERT INTO coding_workspaces (id, path, kind, source_path, name, managed, hidden, deleted_at, created_at, updated_at) \
         VALUES (?, ?, 'worktree', NULL, ?, 0, 1, ?, ?, ?)",
    )
    .bind(new_id())
    .bind(&resolved)
    .bind(basename(&resolved))
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(1)
}

pub async fn rename_coding_workspace(pool: &DbPool, path: &str, name: &str) -> Result<CodingWorkspace> {
    let resolved = resolve_path(path);
    let now = now_db();
    if get_workspace_by_path(pool, &resolved).await?.is_some() {
        sqlx::query("UPDATE coding_workspaces SET name = ?, updated_at = ? WHERE path = ?").bind(name).bind(&now).bind(&resolved).execute(pool).await?;
    } else {
        sqlx::query(
            "INSERT INTO coding_workspaces (id, path, kind, source_path, name, managed, hidden, deleted_at, created_at, updated_at) \
             VALUES (?, ?, 'worktree', NULL, ?, 0, 0, NULL, ?, ?)",
        )
        .bind(new_id())
        .bind(&resolved)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }
    Ok(get_workspace_by_path(pool, &resolved).await?.expect("row exists"))
}

pub async fn list_visible_coding_workspaces(pool: &DbPool) -> Result<Vec<CodingWorkspace>> {
    Ok(sqlx::query_as::<_, CodingWorkspace>("SELECT * FROM coding_workspaces WHERE hidden = 0 AND deleted_at IS NULL ORDER BY created_at ASC").fetch_all(pool).await?)
}

// ── relocate ────────────────────────────────────────────────────────────────

/// `path` moved from under `from` to under `to`: `from` itself, or a path
/// inside it (`from/web`), rebased; anything else is `None`. A sibling that
/// merely shares the prefix (`from-fix`) is not inside it.
pub fn rebase_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let rest = path.strip_prefix(from)?;
    (rest.starts_with('/') || rest.starts_with('\\')).then(|| format!("{to}{rest}"))
}

/// A relocate's `from` or `to` in the form the stored rows use: through
/// [`resolve_path`], as every writer stores it (absolute, no trailing
/// separator, no `.`/`..`), with a Windows drive letter in upper case, as
/// canonicalising stores it. Without this, the plain string comparisons in
/// [`rebase_path`] miss rows whenever the caller's spelling differs.
pub fn relocate_path(p: &str) -> String {
    let mut s = resolve_path(p);
    if cfg!(windows) && s.as_bytes().get(1) == Some(&b':') {
        if let Some(drive) = s.get_mut(..1) {
            drive.make_ascii_uppercase();
        }
    }
    s
}

/// What a relocate from `from` to `to` would carry over (the confirmation's
/// counts).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelocateSummary {
    /// Top-level sessions (subagents ride along with their lead).
    pub sessions: i64,
    pub scheduled_tasks: i64,
    /// Worktree rows filed under the repository: `(path, managed)`.
    pub worktrees: Vec<(String, bool)>,
    /// Names of the groups the repository is in.
    pub groups: Vec<String>,
    /// `to` is already a listed workspace: the two are merged.
    pub merge: bool,
    /// Top-level sessions already at `to` (shown when merging).
    pub target_sessions: i64,
}

async fn distinct_paths(pool: &DbPool, sql: &'static str) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>(sql).fetch_all(pool).await?)
}

pub async fn relocate_summary(pool: &DbPool, from: &str, to: &str) -> Result<RelocateSummary> {
    let (from, to) = (relocate_path(from), relocate_path(to));
    let (from, to) = (from.as_str(), to.as_str());
    let mut s = RelocateSummary::default();
    let rows =
        sqlx::query_as::<_, CodingWorkspace>("SELECT * FROM coding_workspaces WHERE kind = 'worktree' AND deleted_at IS NULL AND source_path IS NOT NULL ORDER BY created_at ASC")
            .fetch_all(pool)
            .await?;
    s.worktrees = rows.into_iter().filter(|r| r.source_path.as_deref().is_some_and(|p| rebase_path(p, from, to).is_some())).map(|r| (r.path, r.managed)).collect();
    // The repository's folder and everything filed under it: its worktrees too.
    let under = |p: &String| rebase_path(p, from, from).is_some() || s.worktrees.iter().any(|(w, _)| rebase_path(p, w, w).is_some());
    let mut sessions = 0;
    for ws in distinct_paths(pool, "SELECT DISTINCT workspace FROM chat_sessions").await?.iter().filter(|p| under(p)) {
        sessions += sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM chat_sessions WHERE workspace = ? AND parent_session_id IS NULL").bind(ws).fetch_one(pool).await?;
    }
    let mut tasks = 0;
    for ws in distinct_paths(pool, "SELECT DISTINCT workspace FROM scheduled_task").await?.iter().filter(|p| under(p)) {
        tasks += sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM scheduled_task WHERE workspace = ?").bind(ws).fetch_one(pool).await?;
    }
    s.sessions = sessions;
    s.scheduled_tasks = tasks;
    s.groups = sqlx::query_scalar::<_, String>(
        "SELECT g.name FROM workspace_groups g JOIN workspace_group_members m ON m.group_id = g.id WHERE m.path = ? ORDER BY g.name COLLATE NOCASE",
    )
    .bind(from)
    .fetch_all(pool)
    .await?;
    s.target_sessions = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM chat_sessions WHERE workspace = ? AND parent_session_id IS NULL").bind(to).fetch_one(pool).await?;
    let target_row = get_workspace_by_path(pool, to).await?;
    s.merge = target_row.is_some_and(|r| !r.hidden && r.deleted_at.is_none()) || s.target_sessions > 0;
    Ok(s)
}

/// Move everything recorded under `from` (the folder and paths inside it) to
/// `to`, in one transaction: sessions, scheduled tasks, sidebar rows (their
/// own paths and the repository they are filed under), and group
/// memberships. When `to` already has a row, the two merge: `to`'s row stays
/// (shown again), `from`'s goes, and group memberships are unioned. A row
/// still named after `from`'s folder takes `to`'s folder name.
///
/// Paths in old messages and tool calls are history and stay as they were.
pub async fn relocate_workspace(pool: &DbPool, from: &str, to: &str) -> Result<()> {
    let (from, to) = (relocate_path(from), relocate_path(to));
    let (from, to) = (from.as_str(), to.as_str());
    let now = now_db();
    let mut tx = pool.begin().await?;
    // Sessions and scheduled tasks: one UPDATE per distinct path.
    const TABLES: [(&str, &str); 2] = [
        ("SELECT DISTINCT workspace FROM chat_sessions", "UPDATE chat_sessions SET workspace = ? WHERE workspace = ?"),
        ("SELECT DISTINCT workspace FROM scheduled_task", "UPDATE scheduled_task SET workspace = ? WHERE workspace = ?"),
    ];
    for (select, update) in TABLES {
        let paths: Vec<String> = sqlx::query_scalar(select).fetch_all(&mut *tx).await?;
        for old in paths {
            if let Some(new) = rebase_path(&old, from, to) {
                sqlx::query(update).bind(&new).bind(&old).execute(&mut *tx).await?;
            }
        }
    }
    // Group memberships: union into the new path, then drop the old one.
    let member_paths: Vec<String> = sqlx::query_scalar("SELECT DISTINCT path FROM workspace_group_members").fetch_all(&mut *tx).await?;
    for old in member_paths {
        if let Some(new) = rebase_path(&old, from, to) {
            sqlx::query("INSERT OR IGNORE INTO workspace_group_members (group_id, path, created_at) SELECT group_id, ?, created_at FROM workspace_group_members WHERE path = ?")
                .bind(&new)
                .bind(&old)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM workspace_group_members WHERE path = ?").bind(&old).execute(&mut *tx).await?;
        }
    }
    // Sidebar rows. Rows filed under the repository first (their
    // `source_path`), then each row's own path, merging into a row already
    // at the new path.
    let rows: Vec<CodingWorkspace> = sqlx::query_as("SELECT * FROM coding_workspaces").fetch_all(&mut *tx).await?;
    for row in &rows {
        if let Some(new_source) = row.source_path.as_deref().and_then(|s| rebase_path(s, from, to)) {
            sqlx::query("UPDATE coding_workspaces SET source_path = ?, updated_at = ? WHERE id = ?").bind(&new_source).bind(&now).bind(&row.id).execute(&mut *tx).await?;
        }
    }
    for row in &rows {
        let Some(new_path) = rebase_path(&row.path, from, to) else { continue };
        let existing: Option<String> = sqlx::query_scalar("SELECT id FROM coding_workspaces WHERE path = ?").bind(&new_path).fetch_optional(&mut *tx).await?;
        match existing {
            Some(id) => {
                sqlx::query("UPDATE coding_workspaces SET hidden = 0, deleted_at = NULL, updated_at = ? WHERE id = ?").bind(&now).bind(&id).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM coding_workspaces WHERE id = ?").bind(&row.id).execute(&mut *tx).await?;
            }
            None => {
                let renamed = match row.name.as_deref() {
                    None | Some("") => basename(&new_path),
                    Some(n) if n == basename(&row.path) => basename(&new_path),
                    Some(n) => n.to_string(),
                };
                sqlx::query("UPDATE coding_workspaces SET path = ?, name = ?, hidden = 0, deleted_at = NULL, updated_at = ? WHERE id = ?")
                    .bind(&new_path)
                    .bind(renamed)
                    .bind(&now)
                    .bind(&row.id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh() -> (tempfile::TempDir, DbPool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::create_pool(dir.path().join("oad.db")).await.unwrap();
        (dir, pool)
    }

    async fn add_session(pool: &DbPool, workspace: &str) {
        sqlx::query("INSERT INTO chat_sessions (id, created_at, updated_at, workspace) VALUES (?, '2026-01-01 00:00:00.000000', '2026-01-01 00:00:00.000000', ?)")
            .bind(new_id())
            .bind(workspace)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn add_task(pool: &DbPool, name: &str, workspace: &str) {
        sqlx::query(
            "INSERT INTO scheduled_task (id, name, schedule_type, prompt, created_at, updated_at, workspace, slug) \
             VALUES (?, ?, 'every', 'p', '2026-01-01 00:00:00.000000', '2026-01-01 00:00:00.000000', ?, ?)",
        )
        .bind(new_id())
        .bind(name)
        .bind(workspace)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn workspaces_of(pool: &DbPool, table: &str) -> Vec<String> {
        let sql = match table {
            "chat_sessions" => "SELECT workspace FROM chat_sessions ORDER BY workspace",
            _ => "SELECT workspace FROM scheduled_task ORDER BY workspace",
        };
        sqlx::query_scalar(sql).fetch_all(pool).await.unwrap()
    }

    /// `rel` under the temp dir, in the stored form, so the paths are real
    /// absolute paths on every platform (`/c/agentd` is not one on Windows).
    fn at(dir: &tempfile::TempDir, rel: &str) -> String {
        resolve_path(&dir.path().join(rel).to_string_lossy())
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    #[test]
    fn rebase_takes_the_folder_and_paths_inside_it_only() {
        assert_eq!(rebase_path("/c/agentd", "/c/agentd", "/c/oad").as_deref(), Some("/c/oad"));
        assert_eq!(rebase_path("/c/agentd/web", "/c/agentd", "/c/oad").as_deref(), Some("/c/oad/web"));
        assert_eq!(rebase_path("C:\\c\\agentd\\web", "C:\\c\\agentd", "C:\\c\\oad").as_deref(), Some("C:\\c\\oad\\web"));
        assert_eq!(rebase_path("/c/agentd-fix", "/c/agentd", "/c/oad"), None);
        assert_eq!(rebase_path("/c/other", "/c/agentd", "/c/oad"), None);
    }

    #[test]
    fn relocate_path_takes_the_stored_form() {
        let dir = tempfile::tempdir().unwrap();
        let from = at(&dir, "agentd");
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(relocate_path(&format!("{from}{sep}")), from, "a trailing separator");
        assert_eq!(relocate_path(&format!("{from}{sep}web{sep}..")), from);
        #[cfg(windows)]
        {
            assert_eq!(relocate_path(r"c:\gone\agentd\"), r"C:\gone\agentd");
            let lower_drive = format!("{}{}", from[..1].to_ascii_lowercase(), &from[1..]);
            assert_eq!(relocate_path(&lower_drive), from, "a lower-case drive letter");
        }
    }

    #[tokio::test]
    async fn moves_sessions_tasks_rows_and_groups_and_takes_the_new_name() {
        let (d, pool) = fresh().await;
        let (from, to) = (at(&d, "agentd"), at(&d, "openagentd"));
        let (from, to) = (from.as_str(), to.as_str());
        let (web, wt, other, new_web) = (at(&d, "agentd/web"), at(&d, "wt/agentd-1/fix"), at(&d, "agentd-other"), at(&d, "openagentd/web"));
        upsert_coding_workspace(&pool, from, "repo", None, None, false, false).await.unwrap();
        upsert_coding_workspace(&pool, &web, "folder", Some(from), None, false, false).await.unwrap();
        upsert_coding_workspace(&pool, &wt, "worktree", Some(from), Some("fix"), true, false).await.unwrap();
        upsert_coding_workspace(&pool, &other, "repo", None, None, false, false).await.unwrap();
        for ws in [from, from, &web, &wt, &other] {
            add_session(&pool, ws).await;
        }
        add_task(&pool, "nightly", from).await;
        let g = crate::create_workspace_group(&pool, "backend", None, None).await.unwrap();
        crate::set_workspace_groups(&pool, from, std::slice::from_ref(&g.id)).await.unwrap();

        let summary = relocate_summary(&pool, from, to).await.unwrap();
        assert_eq!((summary.sessions, summary.scheduled_tasks, summary.merge), (4, 1, false), "the worktree's session counts too");
        assert_eq!(summary.worktrees, vec![(wt.clone(), true)]);
        assert_eq!(summary.groups, vec!["backend".to_string()]);

        relocate_workspace(&pool, from, to).await.unwrap();
        assert_eq!(workspaces_of(&pool, "chat_sessions").await, sorted(vec![other.clone(), to.into(), to.into(), new_web.clone(), wt.clone()]));
        assert_eq!(workspaces_of(&pool, "scheduled_task").await, vec![to]);
        let repo = get_workspace_by_path(&pool, to).await.unwrap().unwrap();
        assert_eq!(repo.name.as_deref(), Some("openagentd"));
        assert!(get_workspace_by_path(&pool, from).await.unwrap().is_none());
        let folder = get_workspace_by_path(&pool, &new_web).await.unwrap().unwrap();
        assert_eq!(folder.source_path.as_deref(), Some(to));
        let wt_row = get_workspace_by_path(&pool, &wt).await.unwrap().unwrap();
        assert_eq!((wt_row.source_path.as_deref(), wt_row.name.as_deref()), (Some(to), Some("fix")));
        let members = crate::list_group_memberships(&pool).await.unwrap();
        assert_eq!(members.iter().map(|(_, p)| p.as_str()).collect::<Vec<_>>(), vec![to]);
        // A sibling sharing the prefix is untouched.
        assert!(get_workspace_by_path(&pool, &other).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn merges_into_a_workspace_already_at_the_new_folder() {
        let (d, pool) = fresh().await;
        let (from, to) = (at(&d, "agentd"), at(&d, "openagentd"));
        let (from, to) = (from.as_str(), to.as_str());
        upsert_coding_workspace(&pool, from, "repo", None, None, false, false).await.unwrap();
        upsert_coding_workspace(&pool, to, "repo", None, Some("My app"), false, false).await.unwrap();
        add_session(&pool, from).await;
        add_session(&pool, to).await;
        let a = crate::create_workspace_group(&pool, "a", None, None).await.unwrap();
        let b = crate::create_workspace_group(&pool, "b", None, None).await.unwrap();
        crate::set_workspace_groups(&pool, from, &[a.id.clone(), b.id.clone()]).await.unwrap();
        crate::set_workspace_groups(&pool, to, std::slice::from_ref(&a.id)).await.unwrap();

        let summary = relocate_summary(&pool, from, to).await.unwrap();
        assert!(summary.merge);
        assert_eq!(summary.target_sessions, 1);

        relocate_workspace(&pool, from, to).await.unwrap();
        assert_eq!(workspaces_of(&pool, "chat_sessions").await, vec![to, to]);
        assert!(get_workspace_by_path(&pool, from).await.unwrap().is_none());
        assert_eq!(get_workspace_by_path(&pool, to).await.unwrap().unwrap().name.as_deref(), Some("My app"));
        let mut groups: Vec<String> = crate::list_group_memberships(&pool).await.unwrap().into_iter().filter(|(_, p)| p == to).map(|(g, _)| g).collect();
        groups.sort();
        let mut want = vec![a.id, b.id];
        want.sort();
        assert_eq!(groups, want);
    }
}
