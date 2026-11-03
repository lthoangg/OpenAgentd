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
