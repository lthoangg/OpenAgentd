//! Undo / redo boundary moves, including
//! git workspace snapshot restores via [`crate::snapshot`].

use appv3_db::{self as db, ChatSession, DbPool, SessionMessage};
use serde_json::Value;

use crate::snapshot::{self, RestoreResult};

#[derive(Debug, Clone, Default)]
pub struct BoundaryShift {
    pub applied: bool,
    pub target: Option<SessionMessage>,
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub error: Option<String>,
    /// The staged chain after the move undoes messages only (`revert.keep_files`).
    pub keep_files: bool,
}

impl BoundaryShift {
    fn fail(e: &str) -> Self {
        Self { applied: false, error: Some(e.into()), ..Default::default() }
    }
    fn ok(target: Option<SessionMessage>, r: RestoreResult, keep_files: bool) -> Self {
        Self { applied: true, target, added: r.added, modified: r.modified, removed: r.removed, error: None, keep_files }
    }
}

fn workspace_of(session_id: &str, session: &ChatSession) -> std::path::PathBuf {
    crate::session::session_workspace_dir(session_id, Some(&session.workspace))
}

/// Step the boundary back one prompt. `keep_files` moves the conversation
/// only: no snapshot is taken or restored. Within a chain whose files were
/// already rolled back, a messages-only step leaves them where they are and
/// redo still restores files, since the anchor holds the live tip.
pub async fn undo_session_messages(pool: DbPool, session_id: String, keep_files: bool) -> anyhow::Result<BoundaryShift> {
    let Some(session) = db::get_session(&pool, &session_id).await? else {
        return Ok(BoundaryShift::default());
    };
    let Some(target) = db::find_undo_target(&pool, &session).await? else {
        return Ok(BoundaryShift::fail("No message to undo."));
    };
    if keep_files {
        let chain_kept = session.revert_message_id().is_none() || session.keeps_files();
        let state = db::revert_state(&target, session.redo_anchor().as_deref(), chain_kept);
        db::update_session(&pool, &session_id, db::SessionUpdate { revert: Some(Some(state)), ..Default::default() }).await?;
        crate::goal::clear_undone_goal(&pool, &session_id, &target).await?;
        return Ok(BoundaryShift::ok(Some(target), RestoreResult { ok: true, ..Default::default() }, chain_kept));
    }
    let ws = workspace_of(&session_id, &session);
    let mut anchor = session.redo_anchor();
    let mut just_tracked = false;
    let target_snapshot = target.snapshot();
    if anchor.is_none() {
        anchor = snapshot::track(&session_id, &ws).await;
        if target_snapshot.is_some() && anchor.is_none() {
            return Ok(BoundaryShift::fail("Failed to snapshot workspace state before undo."));
        }
        just_tracked = anchor.is_some();
    }
    let mut result = RestoreResult { ok: true, ..Default::default() };
    if let Some(ts) = &target_snapshot {
        result = snapshot::restore(&session_id, &ws, ts, just_tracked).await;
        if !result.ok {
            return Ok(BoundaryShift::fail("Failed to restore workspace files."));
        }
    }
    let state = db::revert_state(&target, anchor.as_deref(), false);
    db::update_session(&pool, &session_id, db::SessionUpdate { revert: Some(Some(state)), ..Default::default() }).await?;
    // Taking back a goal's objective takes its rules with it: end the goal.
    crate::goal::clear_undone_goal(&pool, &session_id, &target).await?;
    Ok(BoundaryShift::ok(Some(target), result, false))
}

pub async fn redo_session_messages(pool: DbPool, session_id: String) -> anyhow::Result<BoundaryShift> {
    let Some(session) = db::get_session(&pool, &session_id).await? else {
        return Ok(BoundaryShift::fail("No undone message to redo."));
    };
    let Some(boundary) = db::revert_boundary(&pool, &session).await? else {
        return Ok(BoundaryShift::fail("No undone message to redo."));
    };
    let anchor = session.redo_anchor();
    let keep_files = session.keeps_files();
    let next_user = db::find_redo_target(&pool, &session, &boundary).await?;
    let ws = workspace_of(&session_id, &session);
    let mut result = RestoreResult { ok: true, ..Default::default() };
    let revert: Option<Value> = match &next_user {
        None => {
            if let Some(a) = anchor.as_ref().filter(|_| !keep_files) {
                result = snapshot::restore(&session_id, &ws, a, false).await;
                if !result.ok {
                    return Ok(BoundaryShift::fail("Failed to restore workspace files to live tip."));
                }
            }
            None
        }
        Some(n) => {
            if let Some(ns) = n.snapshot().filter(|_| !keep_files) {
                result = snapshot::restore(&session_id, &ws, &ns, false).await;
                if !result.ok {
                    return Ok(BoundaryShift::fail("Failed to restore workspace files."));
                }
            }
            Some(db::revert_state(n, anchor.as_deref(), keep_files))
        }
    };
    db::update_session(&pool, &session_id, db::SessionUpdate { revert: Some(revert), ..Default::default() }).await?;
    let keep_files = keep_files && next_user.is_some();
    Ok(BoundaryShift::ok(next_user, result, keep_files))
}

pub async fn redo_all_session_messages(pool: DbPool, session_id: String) -> anyhow::Result<BoundaryShift> {
    let Some(session) = db::get_session(&pool, &session_id).await? else {
        return Ok(BoundaryShift::fail("No undone message to redo."));
    };
    if db::revert_boundary(&pool, &session).await?.is_none() {
        return Ok(BoundaryShift::fail("No undone message to redo."));
    }
    let mut result = RestoreResult { ok: true, ..Default::default() };
    if let Some(a) = session.redo_anchor().filter(|_| !session.keeps_files()) {
        result = snapshot::restore(&session_id, &workspace_of(&session_id, &session), &a, false).await;
        if !result.ok {
            return Ok(BoundaryShift::fail("Failed to restore workspace files to live tip."));
        }
    }
    db::update_session(&pool, &session_id, db::SessionUpdate { revert: Some(None), ..Default::default() }).await?;
    Ok(BoundaryShift::ok(None, result, false))
}
