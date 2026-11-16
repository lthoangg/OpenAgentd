//! The session side of idle compaction (see [`crate::idle_compaction`]):
//! the timer a completed lead turn arms, and the background `/compact` it
//! runs when the session stayed idle and its context grew large enough.

use super::control::Transition;
use super::{AgentSession, TurnOptions};
use crate::hooks::summarization::resolve_prompt_token_threshold;
use crate::idle_compaction::{idle_prompt_tokens, resumed_delay, should_compact};
use crate::stream_store::store;
use appv3_db as db;
use std::time::Duration;

impl AgentSession {
    /// Override the idle-compaction delay (tests only).
    #[doc(hidden)]
    pub fn set_idle_compaction_delay(&self, delay: Duration) {
        *self.idle_compaction_delay.lock().unwrap() = delay;
    }

    pub(super) fn cancel_idle_timer(&self) {
        if let Some(h) = self.idle_timer.lock().unwrap().take() {
            h.abort();
        }
    }

    /// Start the idle-compaction timer for the turn that just completed. The
    /// setting is read when it fires, so enabling it mid-idle still applies.
    pub(super) fn arm_idle_compaction(&self) {
        let delay = *self.idle_compaction_delay.lock().unwrap();
        self.arm_idle_compaction_in(delay);
    }

    /// Resume the countdown of a turn that completed `idle_for` ago in an
    /// earlier server process (see
    /// [`crate::idle_compaction::resume_after_restart`]); `false` when the
    /// prompt cache has expired since.
    pub fn resume_idle_compaction(&self, idle_for: Duration) -> bool {
        let delay = *self.idle_compaction_delay.lock().unwrap();
        let Some(left) = resumed_delay(delay, idle_for) else { return false };
        self.arm_idle_compaction_in(left);
        true
    }

    fn arm_idle_compaction_in(&self, delay: Duration) {
        let generation = *self.turn_generation.borrow();
        let me = self.me.clone();
        let h = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(s) = me.upgrade() {
                s.try_idle_compaction(generation).await;
            }
        });
        if let Some(old) = self.idle_timer.lock().unwrap().replace(h) {
            old.abort();
        }
    }

    /// Run `/compact` in the background when the session has stayed idle
    /// since the turn that armed the timer and its context reached the
    /// configured share of the compaction trigger. Subagents still working
    /// for the lead (or workspace replies it is owed) do not hold it back: a
    /// report delivered meanwhile is queued under `user_message_lock` and the
    /// compaction turn's end runs the lead on it.
    async fn try_idle_compaction(&self, generation: u64) {
        if *self.turn_generation.borrow() != generation {
            return;
        }
        // This task is the pending timer; drop its handle so the turn
        // started below does not abort it.
        self.idle_timer.lock().unwrap().take();
        let sid = self.session_id();
        let skip = |reason: &str| tracing::debug!("idle_compaction_skipped session_id={} reason={}", sid, reason);
        let Ok(_guard) = self.user_message_lock.try_lock() else {
            return skip("message_in_flight");
        };
        if sid.is_empty() || *self.turn_generation.borrow() != generation || self.is_busy() || self.state() != "idle" || self.cancel.is_set() {
            return skip("not_idle");
        }
        let cfg = match appv3_core::runtime_settings::load_runtime_settings() {
            Ok(c) => c.summarization,
            Err(e) => {
                tracing::warn!("idle_compaction_settings_failed session_id={} error={}", sid, e);
                return;
            }
        };
        if !cfg.idle_compaction {
            return skip("disabled");
        }
        if self.has_open_question().await {
            return skip("question_open");
        }
        let history = match crate::history::get_messages_for_llm(&self.pool, &sid).await {
            Ok(h) => h,
            Err(e) => {
                tracing::warn!("idle_compaction_history_failed session_id={} error={}", sid, e);
                return;
            }
        };
        let Some(tokens) = idle_prompt_tokens(&history) else {
            return skip("no_usage_or_compacted");
        };
        let row_model = match db::get_session(&self.pool, &sid).await {
            Ok(Some(r)) => r.model.filter(|m| !m.is_empty()),
            _ => None,
        };
        let model = row_model.or_else(|| self.agent().model_id.clone());
        let threshold = resolve_prompt_token_threshold(model.as_deref(), cfg.prompt_token_threshold);
        let percent = cfg.idle_compaction_percent();
        if !should_compact(tokens, threshold, percent) {
            return skip("below_percent");
        }
        tracing::info!("idle_compaction_started session_id={} tokens={} threshold={} percent={}", sid, tokens, threshold, percent);
        store().init_turn(&sid, true);
        self.transition(Transition::StartTurn);
        self.clear_cancel();
        self.transition(Transition::ClaimTurn);
        self.spawn_turn(TurnOptions { force_compaction: true, idle_compaction: true, ..Default::default() });
    }
}
