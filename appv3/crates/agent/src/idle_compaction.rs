//! Opt-in idle compaction (`summarization.idle_compaction`, v3 only).
//!
//! After a lead turn completes, the session waits [`IDLE_COMPACTION_DELAY`].
//! If it is still idle and its last prompt reached the configured share of
//! the auto-compaction trigger, it runs the same forced compaction as
//! `/compact`. The delay sits just under the 5-minute prompt-cache TTL some
//! providers use, so the summariser reuses the warm cached prefix and the
//! next message starts from a short context. The timer lives in
//! [`crate::session::AgentSession`]; this module holds the pure decisions.

use appv3_providers::ChatMessage;
use serde_json::Value;
use std::time::Duration;

/// Idle time after a completed turn before compaction is considered.
pub const IDLE_COMPACTION_DELAY: Duration = Duration::from_secs(270);

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
}
