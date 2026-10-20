//! Session interaction modes — port of `app/agent/interaction_mode.py` and
//! `app/services/session_interaction_mode.py`.

use anyhow::{anyhow, Result};
use appv3_db::{self as db, DbPool, NewMessage};
use serde_json::{json, Map, Value};

/// Some tools check each call themselves: `mcp` allows search and calls to
/// read-only tools, `patch` writes only plan attachments under
/// `.agents/plans/<folder>/`, and `preview` only looks (no click, fill or press).
pub const PLAN_MODE_ALLOWED_TOOLS: [&str; 14] =
    ["ask_user", "delegate", "glob", "grep", "mcp", "patch", "plan", "preview", "read", "shell", "skill", "submit_plan", "web_fetch", "web_search"];

/// `extra.interaction_mode_prompt_version` of the notes written now. Notes
/// without it are version 1 (the `<proposed_plan>` instructions); version 2
/// wrote implementation-shaped plans; version 3 writes reviewer-shaped plans
/// with visuals in the plan's attachments folder.
pub const MODE_PROMPT_VERSION: u64 = 3;
const MODE_PROMPT_VERSION_KEY: &str = "interaction_mode_prompt_version";

/// Appended to the Plan-mode note that replaces a version-1 one.
pub const PLAN_PROMPT_UPGRADE: &str = "These Plan mode instructions replace the earlier ones in this conversation: write the plan with the `plan` tool and submit it with `submit_plan` instead of a `<proposed_plan>` block.";

pub fn normalize(value: &str) -> &'static str {
    if value == "plan" {
        "plan"
    } else {
        "code"
    }
}

pub fn tool_allowed_in_mode(mode: &str, tool: &str) -> bool {
    mode != "plan" || PLAN_MODE_ALLOWED_TOOLS.contains(&tool)
}

pub fn transition_instruction(mode: &str) -> &'static str {
    crate::prompts::s(if mode == "plan" { "mode_plan" } else { "mode_code" })
}

/// The newest instruction-note version for `mode`, or `None` without one.
async fn mode_prompt_version(pool: &DbPool, sid: &str, mode: &str) -> Result<Option<u64>> {
    let rows: Vec<Option<String>> =
        sqlx::query_scalar("SELECT extra FROM session_messages WHERE session_id = ? AND kind = 'note'").bind(db::codec::db_id(sid)).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|e| {
            let v = db::codec::json_col(e.as_deref())?;
            let is_prompt = v.get("interaction_mode").and_then(|m| m.as_str()) == Some(mode) && v.get("interaction_mode_prompt") == Some(&Value::Bool(true));
            is_prompt.then(|| v.get(MODE_PROMPT_VERSION_KEY).and_then(Value::as_u64).unwrap_or(1))
        })
        .max())
}

async fn append_mode_prompt(pool: &DbPool, sid: &str, mode: &str, transition: bool, upgrade: bool) -> Result<()> {
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert("interaction_mode".into(), json!(mode));
    extra.insert("interaction_mode_prompt".into(), json!(true));
    extra.insert(MODE_PROMPT_VERSION_KEY.into(), json!(MODE_PROMPT_VERSION));
    if transition {
        extra.insert("interaction_mode_transition".into(), json!(true));
    }
    let mut text = transition_instruction(mode).to_string();
    if upgrade {
        text.push_str("\n\n");
        text.push_str(PLAN_PROMPT_UPGRADE);
    }
    db::save_message(pool, sid, NewMessage { kind: Some("note".into()), pinned: Some(true), extra: Some(extra), ..NewMessage::user(text) }).await?;
    db::bump_history_revision(pool, sid, true).await
}

/// `ensure_session_interaction_mode_prompt`. A Plan-mode session whose note
/// is older than [`MODE_PROMPT_VERSION`] gets a new note that replaces it.
/// Only a version-1 note (before the plan tools) also gets the upgrade line.
pub async fn ensure_prompt(pool: &DbPool, sid: &str, mode: &str) -> Result<bool> {
    if mode != "plan" {
        return Ok(false);
    }
    let upgrade = match mode_prompt_version(pool, sid, mode).await? {
        Some(v) if v >= MODE_PROMPT_VERSION => return Ok(false),
        Some(v) => v == 1,
        None => false,
    };
    append_mode_prompt(pool, sid, mode, false, upgrade).await?;
    Ok(true)
}

/// `set_session_interaction_mode` → `(session, changed)`.
pub async fn set_mode(pool: &DbPool, sid: &str, mode: &str) -> Result<(db::ChatSession, bool)> {
    let session = db::get_session(pool, sid).await?.ok_or_else(|| anyhow!("Session not found."))?;
    if session.parent_session_id.is_some() {
        return Err(anyhow!("Session not found."));
    }
    if session.interaction_mode == mode {
        return Ok((session, false));
    }
    db::update_session(pool, sid, db::SessionUpdate { interaction_mode: Some(mode.to_string()), ..Default::default() }).await?;
    append_mode_prompt(pool, sid, mode, true, false).await?;
    let s = db::get_session(pool, sid).await?.ok_or_else(|| anyhow!("Session not found."))?;
    Ok((s, true))
}

/// Align a subagent session with its lead's current mode; returns the mode.
///
/// Members persist across delegations and each turn reads the member's own
/// row, so a mode copied at spawn goes stale when the lead switches: a member
/// spawned in Code mode could still edit files after the lead entered Plan
/// mode, where `delegate` stays available. The member gets the same
/// transition note its lead got.
pub async fn follow_lead(pool: &DbPool, sid: &str, session: &db::ChatSession) -> Result<&'static str> {
    let own = normalize(&session.interaction_mode);
    let Some(lead_id) = session.parent_session_id.as_deref() else {
        return Ok(own);
    };
    let Some(lead) = db::get_session(pool, lead_id).await? else {
        return Ok(own);
    };
    let mode = normalize(&lead.interaction_mode);
    if mode != own {
        db::update_session(pool, sid, db::SessionUpdate { interaction_mode: Some(mode.to_string()), ..Default::default() }).await?;
        append_mode_prompt(pool, sid, mode, true, false).await?;
    }
    Ok(mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool(dir: &tempfile::TempDir) -> DbPool {
        db::create_pool(dir.path().join("oad.db")).await.unwrap()
    }

    async fn session(pool: &DbPool, parent: Option<&str>, mode: &str) -> String {
        let id = uuid::Uuid::now_v7();
        db::create_session(
            pool,
            db::NewSession { id: Some(id), parent_session_id: parent.map(String::from), workspace: "/tmp/ws".into(), interaction_mode: Some(mode.into()), ..Default::default() },
        )
        .await
        .unwrap();
        id.to_string()
    }

    async fn mode_notes(pool: &DbPool, sid: &str) -> Vec<String> {
        let rows = db::llm_window_rows(pool, sid, false).await.unwrap();
        rows.iter()
            .filter_map(|r| {
                let e = r.extra_json()?;
                (e.get("interaction_mode_prompt") == Some(&Value::Bool(true))).then(|| e["interaction_mode"].as_str().unwrap_or_default().to_string())
            })
            .collect()
    }

    async fn follow(pool: &DbPool, sid: &str) -> &'static str {
        let row = db::get_session(pool, sid).await.unwrap().unwrap();
        follow_lead(pool, sid, &row).await.unwrap()
    }

    /// A member spawned in Code mode must not keep write access after the
    /// lead enters Plan mode (`delegate` stays available in Plan mode).
    #[tokio::test]
    async fn subagent_enters_plan_mode_with_its_lead() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let lead = session(&pool, None, "code").await;
        let child = session(&pool, Some(&lead), "code").await;
        set_mode(&pool, &lead, "plan").await.unwrap();

        assert_eq!(follow(&pool, &child).await, "plan");
        assert_eq!(db::get_session(&pool, &child).await.unwrap().unwrap().interaction_mode, "plan");
        assert_eq!(mode_notes(&pool, &child).await, vec!["plan"]);
    }

    #[tokio::test]
    async fn subagent_leaves_plan_mode_with_its_lead() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let lead = session(&pool, None, "plan").await;
        let child = session(&pool, Some(&lead), "plan").await;
        ensure_prompt(&pool, &child, "plan").await.unwrap();
        set_mode(&pool, &lead, "code").await.unwrap();

        assert_eq!(follow(&pool, &child).await, "code");
        assert_eq!(db::get_session(&pool, &child).await.unwrap().unwrap().interaction_mode, "code");
        assert_eq!(mode_notes(&pool, &child).await, vec!["plan", "code"]);
    }

    #[tokio::test]
    async fn following_an_unchanged_lead_adds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let lead = session(&pool, None, "plan").await;
        let child = session(&pool, Some(&lead), "plan").await;
        ensure_prompt(&pool, &child, "plan").await.unwrap();

        assert_eq!(follow(&pool, &child).await, "plan");
        assert_eq!(follow(&pool, &lead).await, "plan");
        assert_eq!(mode_notes(&pool, &child).await, vec!["plan"]);
        assert!(mode_notes(&pool, &lead).await.is_empty());
    }

    /// A Plan-mode session from before the plan tools still has the
    /// `<proposed_plan>` instructions; its next turn gets the new ones once.
    #[tokio::test]
    async fn an_outdated_plan_note_is_replaced_once() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let sid = session(&pool, None, "plan").await;
        let mut extra = Map::new();
        extra.insert("hidden_from_user".into(), json!(true));
        extra.insert("interaction_mode".into(), json!("plan"));
        extra.insert("interaction_mode_prompt".into(), json!(true));
        db::save_message(&pool, &sid, NewMessage { kind: Some("note".into()), pinned: Some(true), extra: Some(extra), ..NewMessage::user("<proposed_plan> rules") }).await.unwrap();

        assert!(ensure_prompt(&pool, &sid, "plan").await.unwrap());
        assert!(!ensure_prompt(&pool, &sid, "plan").await.unwrap());
        let rows = db::llm_window_rows(&pool, &sid, false).await.unwrap();
        let last = rows.last().unwrap();
        assert!(last.content.as_deref().unwrap().ends_with(PLAN_PROMPT_UPGRADE));
        assert_eq!(last.extra_json().unwrap()[MODE_PROMPT_VERSION_KEY], json!(MODE_PROMPT_VERSION));
        assert_eq!(mode_notes(&pool, &sid).await, vec!["plan", "plan"]);
    }

    #[tokio::test]
    async fn a_new_plan_session_gets_the_current_note_without_the_upgrade_line() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let sid = session(&pool, None, "plan").await;
        assert!(ensure_prompt(&pool, &sid, "plan").await.unwrap());
        let rows = db::llm_window_rows(&pool, &sid, false).await.unwrap();
        let text = rows.last().unwrap().content.clone().unwrap();
        assert!(text.contains("`submit_plan`") && !text.contains(PLAN_PROMPT_UPGRADE));
        for section in ["**Outcome:**", "**Decisions:**", "**Preview:**", "## Appendix", "### Visuals", "`mermaid`", ".agents/plans/"] {
            assert!(text.contains(section), "missing {section}");
        }
    }

    /// A Plan-mode session with a version-2 note gets the current one once,
    /// without the `<proposed_plan>` upgrade line.
    #[tokio::test]
    async fn an_outdated_v2_plan_note_is_refreshed_once() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let sid = session(&pool, None, "plan").await;
        let mut extra = Map::new();
        extra.insert("hidden_from_user".into(), json!(true));
        extra.insert("interaction_mode".into(), json!("plan"));
        extra.insert("interaction_mode_prompt".into(), json!(true));
        extra.insert(MODE_PROMPT_VERSION_KEY.into(), json!(2));
        db::save_message(&pool, &sid, NewMessage { kind: Some("note".into()), pinned: Some(true), extra: Some(extra), ..NewMessage::user("v2 rules") }).await.unwrap();

        assert!(ensure_prompt(&pool, &sid, "plan").await.unwrap());
        assert!(!ensure_prompt(&pool, &sid, "plan").await.unwrap());
        let rows = db::llm_window_rows(&pool, &sid, false).await.unwrap();
        let text = rows.last().unwrap().content.clone().unwrap();
        assert_eq!(text, transition_instruction("plan"));
    }
}
