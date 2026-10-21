//! Opt-in idle compaction (`summarization.idle_compaction`, v3 only).
//!
//! After a lead turn completes, the session waits [`IDLE_COMPACTION_DELAY`].
//! If it is still idle and its last prompt reached the configured share of
//! the auto-compaction trigger, it runs the same forced compaction as
//! `/compact`. The delay sits just under the 5-minute prompt-cache TTL some
//! providers use, so the summariser reuses the warm cached prefix and the
//! next message starts from a short context. The timer lives in
//! [`crate::session::AgentSession`]; this module holds the decisions and
//! [`resume_after_restart`], which restores countdowns a restart dropped.

use appv3_db::{self as db, DbPool};
use appv3_providers::ChatMessage;
use serde_json::Value;
use std::time::Duration;

/// Idle time after a completed turn before compaction is considered.
pub const IDLE_COMPACTION_DELAY: Duration = Duration::from_secs(270);

/// The provider prompt-cache lifetime [`IDLE_COMPACTION_DELAY`] is chosen
/// against. The cache lives on the provider, so it outlives a restart here.
pub const PROMPT_CACHE_TTL: Duration = Duration::from_secs(300);

/// Countdown left for a turn that completed `idle_for` ago, or `None` once
/// the prompt cache has expired: compacting then pays full price for a
/// session the user may never reopen, and the next message would pay the
/// same anyway.
pub fn resumed_delay(delay: Duration, idle_for: Duration) -> Option<Duration> {
    (idle_for < PROMPT_CACHE_TTL).then(|| delay.saturating_sub(idle_for))
}

/// Whether a session's newest row is the answer of a completed turn: an
/// assistant reply that calls no tools (a turn cut off mid-tool ends on a
/// call or a tool row) and was not stopped by the user.
fn ends_completed_turn(role: &str, kind: &str, tool_calls: Option<&str>, extra: Option<&str>) -> bool {
    let json = |s: Option<&str>| s.and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(Value::Null);
    let calls = match json(tool_calls) {
        Value::Null => false,
        Value::Array(a) => !a.is_empty(),
        _ => true,
    };
    role == "assistant" && kind == db::kind::CHAT && !calls && json(extra).get("interrupted") != Some(&Value::Bool(true))
}

/// Lead sessions whose newest non-note row is newer than `since`, with that
/// row: `(id, workspace, role, kind, tool_calls, extra, created_at)`.
/// `last_message_at` only narrows the scan through its index; the row's own
/// time decides (stored times are fixed-width, so text order is time order).
const RECENT_LEAD_TURNS_SQL: &str = r#"
    SELECT s.id, s.workspace, m.role, m.kind, m.tool_calls, m.extra, m.created_at
    FROM chat_sessions s
    JOIN session_messages m ON m.id = (
        SELECT id FROM session_messages
        WHERE session_id = s.id AND kind != 'note'
        ORDER BY seq DESC, id DESC LIMIT 1)
    WHERE s.parent_session_id IS NULL AND s.scheduled_task_name IS NULL
      AND s.last_message_at >= ?1 AND m.created_at >= ?1"#;

type RecentTurn = (String, String, String, String, Option<String>, Option<String>, String);

/// Restore the countdowns a restart dropped: every lead session whose last
/// turn completed within [`PROMPT_CACHE_TTL`] is loaded and resumes its
/// countdown where it stopped (or compacts now when the delay has already
/// passed). Returns how many resumed. Call once, after
/// [`crate::manager::init`].
pub async fn resume_after_restart(pool: &DbPool) -> usize {
    match appv3_core::runtime_settings::load_runtime_settings() {
        Ok(c) if c.summarization.idle_compaction => {}
        Ok(_) => return 0,
        Err(e) => {
            tracing::warn!("idle_compaction_resume_settings_failed error={}", e);
            return 0;
        }
    }
    let ttl = chrono::Duration::from_std(PROMPT_CACHE_TTL).unwrap_or_default();
    let since = db::codec::dt_db(&(chrono::Utc::now() - ttl));
    let rows: Vec<RecentTurn> = match sqlx::query_as(RECENT_LEAD_TURNS_SQL).bind(&since).fetch_all(pool).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("idle_compaction_resume_query_failed error={}", e);
            return 0;
        }
    };
    let mut resumed = 0;
    for (id, workspace, role, kind, tool_calls, extra, created_at) in rows {
        if !ends_completed_turn(&role, &kind, tool_calls.as_deref(), extra.as_deref()) {
            continue;
        }
        let Some(ended) = db::codec::parse_dt(&created_at) else { continue };
        let sid = db::codec::api_uuid(&id);
        let session = match crate::manager::get_or_start_agent_session(&workspace, Some(&sid)).await {
            Ok(Some(s)) => s,
            Ok(None) => break, // no code agent configured: nothing can run
            Err(e) => {
                tracing::warn!("idle_compaction_resume_failed session_id={} error={}", sid, e);
                continue;
            }
        };
        let idle_for = (chrono::Utc::now() - ended).to_std().unwrap_or_default();
        if session.resume_idle_compaction(idle_for) {
            tracing::info!("idle_compaction_resumed session_id={} idle_s={}", sid, idle_for.as_secs());
            resumed += 1;
        }
    }
    resumed
}

/// The prompt size of the session's last model call, or `None` when the
/// session was compacted after it (a summary is newer than the last
/// assistant usage) or no model call is recorded.
pub fn idle_prompt_tokens(history: &[ChatMessage]) -> Option<i64> {
    for m in history.iter().rev() {
        if m.meta().is_summary() {
            return None;
        }
        if let Some(Value::Object(u)) = m.meta().extra.as_ref().and_then(|e| e.get("usage")) {
            if let Some(n) = u.get("input").and_then(|v| v.as_i64()) {
                return Some(n);
            }
        }
    }
    None
}

/// Whether `tokens` reached `percent`% of the compaction `threshold`.
pub fn should_compact(tokens: i64, threshold: i64, percent: i64) -> bool {
    threshold > 0 && tokens.saturating_mul(100) >= threshold.saturating_mul(percent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_providers::MessageMeta;
    use serde_json::{json, Map};

    fn with_usage(input: i64) -> ChatMessage {
        let mut m = ChatMessage::assistant("a");
        let mut e = Map::new();
        e.insert("usage".into(), json!({"input": input, "output": 5}));
        m.meta_mut().extra = Some(e);
        m
    }

    fn summary() -> ChatMessage {
        let mut e = Map::new();
        e.insert("usage".into(), json!({"input": 999_999}));
        ChatMessage::User { content: Some("s".into()), parts: None, meta: MessageMeta { kind: "summary".into(), extra: Some(e), ..Default::default() } }
    }

    #[test]
    fn reads_the_last_assistant_usage() {
        let h = vec![ChatMessage::user("q"), with_usage(100), ChatMessage::user("q2"), with_usage(250), ChatMessage::user("trailing")];
        assert_eq!(idle_prompt_tokens(&h), Some(250));
    }

    #[test]
    fn none_once_compacted_or_empty() {
        assert_eq!(idle_prompt_tokens(&[]), None);
        assert_eq!(idle_prompt_tokens(&[ChatMessage::user("q")]), None);
        assert_eq!(idle_prompt_tokens(&[ChatMessage::user("q"), with_usage(800), summary()]), None);
        // A turn after the summary counts again.
        assert_eq!(idle_prompt_tokens(&[with_usage(800), summary(), ChatMessage::user("q"), with_usage(300)]), Some(300));
    }

    #[test]
    fn compacts_at_the_percent_of_the_trigger() {
        assert!(should_compact(7_000, 10_000, 70));
        assert!(!should_compact(6_999, 10_000, 70));
        assert!(should_compact(5_000, 10_000, 50));
        assert!(!should_compact(4_999, 10_000, 50));
        assert!(should_compact(10_000, 10_000, 100));
        assert!(!should_compact(9_999, 10_000, 100));
        assert!(should_compact(20_000, 10_000, 70));
        assert!(!should_compact(5_000, 0, 70));
        assert!(!should_compact(5_000, -1, 70));
    }

    #[test]
    fn resumes_the_remaining_countdown_until_the_cache_expires() {
        let s = Duration::from_secs;
        assert_eq!(resumed_delay(s(270), s(0)), Some(s(270)));
        assert_eq!(resumed_delay(s(270), s(100)), Some(s(170)));
        // Past the delay but the cache is still warm: compact now.
        assert_eq!(resumed_delay(s(270), s(285)), Some(s(0)));
        assert_eq!(resumed_delay(s(270), s(299)), Some(s(0)));
        assert_eq!(resumed_delay(s(270), s(300)), None);
        assert_eq!(resumed_delay(s(270), s(3_600)), None);
    }

    #[test]
    fn only_a_finished_reply_ends_a_completed_turn() {
        assert!(ends_completed_turn("assistant", "chat", None, None));
        assert!(ends_completed_turn("assistant", "chat", Some("null"), Some(r#"{"usage": {"input": 5}}"#)));
        assert!(ends_completed_turn("assistant", "chat", Some("[]"), None));
        assert!(!ends_completed_turn("assistant", "chat", Some(r#"[{"id": "c1"}]"#), None), "a call left mid-tool");
        assert!(!ends_completed_turn("assistant", "chat", None, Some(r#"{"interrupted": true}"#)), "stopped by the user");
        assert!(!ends_completed_turn("tool", "chat", None, None));
        assert!(!ends_completed_turn("user", "chat", None, None));
        assert!(!ends_completed_turn("user", "queued", None, None));
        assert!(!ends_completed_turn("user", "summary", None, None));
    }
}
