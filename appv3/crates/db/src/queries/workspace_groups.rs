//! `workspace_groups` / `workspace_group_members` — named tags on repository
//! paths (v3 only, revision 00000025). Workspaces whose repositories share a
//! group may message each other (`workspace`); worktrees use their
//! source repository's groups, so members are always repository paths.

use crate::codec::{api_dt, api_uuid, db_id, new_id, now_db};
use crate::pool::DbPool;
use crate::queries::workspaces::resolve_path;
use serde_json::{json, Value};

pub const GROUP_NAME_MAX_CHARS: usize = 40;
pub const GROUP_BRIEF_MAX_CHARS: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum GroupError {
    /// The request is invalid (bad name, duplicate, unknown group id).
    #[error("{0}")]
    Invalid(String),
    #[error("Workspace group not found.")]
    NotFound,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

pub type GroupResult<T> = Result<T, GroupError>;

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: String,
    pub brief: Option<String>,
    /// `#rrggbb`, or `None` for a colour the UI derives from the id.
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkspaceGroup {
    /// API form: hyphenated id, ISO datetimes.
    pub fn to_api(&self) -> Value {
        json!({
            "id": api_uuid(&self.id),
            "name": self.name,
            "brief": self.brief,
            "color": self.color,
            "created_at": api_dt(&self.created_at),
            "updated_at": api_dt(&self.updated_at),
        })
    }
}

/// A valid group name, trimmed.
pub fn clean_name(name: &str) -> GroupResult<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(GroupError::Invalid("Group name must not be blank.".into()));
    }
    if n.chars().count() > GROUP_NAME_MAX_CHARS {
        return Err(GroupError::Invalid(format!("Group name must be at most {GROUP_NAME_MAX_CHARS} characters.")));
    }
    if n.contains(['\n', '\r']) {
        return Err(GroupError::Invalid("Group name must be one line.".into()));
    }
    Ok(n.to_string())
}

/// A valid group brief, trimmed; `None` when blank.
pub fn clean_brief(brief: Option<&str>) -> GroupResult<Option<String>> {
    let Some(b) = brief.map(str::trim).filter(|b| !b.is_empty()) else { return Ok(None) };
    if b.chars().count() > GROUP_BRIEF_MAX_CHARS {
        return Err(GroupError::Invalid(format!("Group brief must be at most {GROUP_BRIEF_MAX_CHARS} characters.")));
    }
    Ok(Some(b.to_string()))
}

/// A `#rrggbb` hex colour, stored lowercase.
fn clean_color(color: Option<&str>) -> GroupResult<Option<String>> {
    let Some(c) = color.map(str::trim).filter(|c| !c.is_empty()) else { return Ok(None) };
    let hex = c.strip_prefix('#').unwrap_or("");
    if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(GroupError::Invalid("Group colour must be a hex colour such as #3b82f6.".into()));
    }
    Ok(Some(c.to_ascii_lowercase()))
}

async fn ensure_unique_name(pool: &DbPool, name: &str, except: Option<&str>) -> GroupResult<()> {
    let taken: Option<String> =
        sqlx::query_scalar("SELECT id FROM workspace_groups WHERE name = ? COLLATE NOCASE AND id != ?").bind(name).bind(except.unwrap_or("")).fetch_optional(pool).await?;
    match taken {
        Some(_) => Err(GroupError::Invalid(format!("A group named '{name}' already exists."))),
        None => Ok(()),
    }
}

/// Every group, by name (case-insensitive).
pub async fn list_workspace_groups(pool: &DbPool) -> GroupResult<Vec<WorkspaceGroup>> {
    Ok(sqlx::query_as::<_, WorkspaceGroup>("SELECT * FROM workspace_groups ORDER BY name COLLATE NOCASE, id").fetch_all(pool).await?)
}

pub async fn get_workspace_group(pool: &DbPool, id: &str) -> GroupResult<Option<WorkspaceGroup>> {
    Ok(sqlx::query_as::<_, WorkspaceGroup>("SELECT * FROM workspace_groups WHERE id = ?").bind(db_id(id)).fetch_optional(pool).await?)
}

/// Every `(group_id, repository path)` membership, group ids in db form.
pub async fn list_group_memberships(pool: &DbPool) -> GroupResult<Vec<(String, String)>> {
    Ok(sqlx::query_as("SELECT group_id, path FROM workspace_group_members ORDER BY created_at, path").fetch_all(pool).await?)
}

pub async fn create_workspace_group(pool: &DbPool, name: &str, brief: Option<&str>, color: Option<&str>) -> GroupResult<WorkspaceGroup> {
    let name = clean_name(name)?;
    let brief = clean_brief(brief)?;
    let color = clean_color(color)?;
    ensure_unique_name(pool, &name, None).await?;
    let now = now_db();
    let row = WorkspaceGroup { id: new_id(), name, brief, color, created_at: now.clone(), updated_at: now };
    sqlx::query("INSERT INTO workspace_groups (id, name, brief, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&row.id)
        .bind(&row.name)
        .bind(&row.brief)
        .bind(&row.color)
        .bind(&row.created_at)
        .bind(&row.updated_at)
        .execute(pool)
        .await?;
    Ok(row)
}

/// Rename a group and/or set its brief or colour (`Some(None)` clears one).
pub async fn update_workspace_group(pool: &DbPool, id: &str, name: Option<&str>, brief: Option<Option<&str>>, color: Option<Option<&str>>) -> GroupResult<WorkspaceGroup> {
    let Some(mut row) = get_workspace_group(pool, id).await? else { return Err(GroupError::NotFound) };
    if let Some(n) = name {
        let n = clean_name(n)?;
        ensure_unique_name(pool, &n, Some(&row.id)).await?;
        row.name = n;
    }
    if let Some(b) = brief {
        row.brief = clean_brief(b)?;
    }
    if let Some(c) = color {
        row.color = clean_color(c)?;
    }
    row.updated_at = now_db();
    sqlx::query("UPDATE workspace_groups SET name = ?, brief = ?, color = ?, updated_at = ? WHERE id = ?")
        .bind(&row.name)
        .bind(&row.brief)
        .bind(&row.color)
        .bind(&row.updated_at)
        .bind(&row.id)
        .execute(pool)
        .await?;
    Ok(row)
}

/// Delete a group and its memberships. `false` when it did not exist.
pub async fn delete_workspace_group(pool: &DbPool, id: &str) -> GroupResult<bool> {
    let id = db_id(id);
    let mut tx = pool.begin().await?;
    // Explicit, not `ON DELETE CASCADE`: correct with foreign keys off too.
    sqlx::query("DELETE FROM workspace_group_members WHERE group_id = ?").bind(&id).execute(&mut *tx).await?;
    let n = sqlx::query("DELETE FROM workspace_groups WHERE id = ?").bind(&id).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    Ok(n > 0)
}

/// Replace the groups of repository `path` with `group_ids` (any UUID
/// spelling). Returns the stored ids in API form, deduplicated, in order.
pub async fn set_workspace_groups(pool: &DbPool, path: &str, group_ids: &[String]) -> GroupResult<Vec<String>> {
    let path = resolve_path(path);
    let mut ids: Vec<String> = vec![];
    for raw in group_ids {
        let id = db_id(raw.trim());
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut tx = pool.begin().await?;
    for id in &ids {
        let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM workspace_groups WHERE id = ?").bind(id).fetch_optional(&mut *tx).await?;
        if found.is_none() {
            return Err(GroupError::Invalid(format!("Unknown workspace group '{}'.", api_uuid(id))));
        }
    }
    sqlx::query("DELETE FROM workspace_group_members WHERE path = ?").bind(&path).execute(&mut *tx).await?;
    let now = now_db();
    for id in &ids {
        sqlx::query("INSERT INTO workspace_group_members (group_id, path, created_at) VALUES (?, ?, ?)").bind(id).bind(&path).bind(&now).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(ids.iter().map(|i| api_uuid(i)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh() -> (tempfile::TempDir, DbPool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::create_pool(dir.path().join("oad.db")).await.unwrap();
        (dir, pool)
    }

    #[tokio::test]
    async fn create_rename_and_reject_duplicates() {
        let (_d, pool) = fresh().await;
        let g = create_workspace_group(&pool, "  Acme ", Some("web = frontend"), Some(" #A78BFA ")).await.unwrap();
        assert_eq!((g.name.as_str(), g.brief.as_deref(), g.color.as_deref()), ("Acme", Some("web = frontend"), Some("#a78bfa")));
        let dup = create_workspace_group(&pool, "acme", None, None).await.unwrap_err();
        assert!(dup.to_string().contains("already exists"), "{dup}");
        assert!(matches!(create_workspace_group(&pool, "  ", None, None).await, Err(GroupError::Invalid(_))));
        assert!(matches!(create_workspace_group(&pool, &"x".repeat(41), None, None).await, Err(GroupError::Invalid(_))));
        for bad in ["teal", "#fff", "a78bfa", "#a78bfg", "#a78bfa0"] {
            assert!(matches!(create_workspace_group(&pool, "Teal", None, Some(bad)).await, Err(GroupError::Invalid(_))), "{bad}");
        }
        let other = create_workspace_group(&pool, "Billing", None, None).await.unwrap();
        assert_eq!(other.color, None);
        assert!(update_workspace_group(&pool, &other.id, Some("ACME"), None, None).await.is_err());
        // Renaming a group to a new spelling of its own name is fine.
        let g2 = update_workspace_group(&pool, &api_uuid(&g.id), Some("ACME"), Some(None), None).await.unwrap();
        assert_eq!((g2.name.as_str(), g2.brief, g2.color.as_deref()), ("ACME", None, Some("#a78bfa")), "an absent colour is left as is");
        let g3 = update_workspace_group(&pool, &g.id, None, None, Some(Some("#10B981"))).await.unwrap();
        assert_eq!(get_workspace_group(&pool, &g.id).await.unwrap().unwrap().color.as_deref(), Some("#10b981"));
        assert_eq!(g3.name, "ACME");
        let g4 = update_workspace_group(&pool, &g.id, None, None, Some(None)).await.unwrap();
        assert_eq!(g4.color, None, "null clears the colour");
        assert!(matches!(update_workspace_group(&pool, &g.id, None, None, Some(Some("red"))).await, Err(GroupError::Invalid(_))));
        assert!(matches!(update_workspace_group(&pool, &new_id(), Some("x"), None, None).await, Err(GroupError::NotFound)));
        let names: Vec<String> = list_workspace_groups(&pool).await.unwrap().into_iter().map(|g| g.name).collect();
        assert_eq!(names, ["ACME", "Billing"]);
    }

    #[tokio::test]
    async fn memberships_replace_and_go_with_their_group() {
        let (_d, pool) = fresh().await;
        let a = create_workspace_group(&pool, "a", None, None).await.unwrap();
        let b = create_workspace_group(&pool, "b", None, None).await.unwrap();
        let set = set_workspace_groups(&pool, "/nonexistent/web", &[api_uuid(&a.id), b.id.clone(), a.id.clone()]).await.unwrap();
        assert_eq!(set, [api_uuid(&a.id), api_uuid(&b.id)]);
        set_workspace_groups(&pool, "/nonexistent/api", std::slice::from_ref(&a.id)).await.unwrap();
        set_workspace_groups(&pool, "/nonexistent/web", std::slice::from_ref(&b.id)).await.unwrap();
        // Stored paths are resolved (absolute, platform-native: `D:\…` on Windows).
        let (api, web) = (resolve_path("/nonexistent/api"), resolve_path("/nonexistent/web"));
        let mut m = list_group_memberships(&pool).await.unwrap();
        m.sort();
        let mut want = vec![(a.id.clone(), api), (b.id.clone(), web.clone())];
        want.sort();
        assert_eq!(m, want);
        assert!(matches!(set_workspace_groups(&pool, "/nonexistent/api", &[new_id()]).await, Err(GroupError::Invalid(_))));
        assert_eq!(list_group_memberships(&pool).await.unwrap().len(), 2, "a failed set changes nothing");
        assert!(delete_workspace_group(&pool, &api_uuid(&a.id)).await.unwrap());
        assert!(!delete_workspace_group(&pool, &a.id).await.unwrap());
        assert_eq!(list_group_memberships(&pool).await.unwrap(), [(b.id.clone(), web)]);
        set_workspace_groups(&pool, "/nonexistent/web", &[]).await.unwrap();
        assert!(list_group_memberships(&pool).await.unwrap().is_empty());
    }
}
