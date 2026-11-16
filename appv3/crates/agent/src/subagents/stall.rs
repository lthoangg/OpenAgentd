//! A member that cannot reach its model: [`StallWatch`] tracks its failed
//! calls, and [`MemberStallHook`] tells its lead once per stall, so the lead
//! can go on without it instead of waiting in silence.

use super::report::deliver_message_to_lead;
use super::with_instance;
use crate::events::ProviderStatus;
use crate::hooks::{AgentState, Hook, RunContext};
use appv3_db::DbPool;
use appv3_providers::AssistantMessage;
use async_trait::async_trait;
use std::sync::Mutex;
use std::time::Duration;

/// A member that has failed to reach its model for this long tells its lead
/// once, so the lead can go on without it instead of waiting in silence.
pub(super) const STALL_NOTICE_AFTER: Duration = Duration::from_secs(120);

/// Tracks one member turn's failed model calls, and says when its lead
/// should hear about it: once per stall, at its first quota wait or once
/// retries have gone on for [`STALL_NOTICE_AFTER`].
#[derive(Default)]
pub(super) struct StallWatch {
    since: Option<tokio::time::Instant>,
    notified: bool,
}

impl StallWatch {
    /// A retry was announced; `Some(reason)` when the lead should be told now.
    pub fn on_retry(&mut self, info: &ProviderStatus, now: tokio::time::Instant) -> Option<String> {
        let model = info.model.as_deref().filter(|m| !m.is_empty()).unwrap_or("its model");
        let reason = match info.status.as_str() {
            "waiting_quota" | "waiting_credential" => {
                let wait = info.delay_seconds.map(crate::retry::format_duration).unwrap_or_else(|| "a while".into());
                format!("{model} is out of quota, and it is waiting {wait} for the reset")
            }
            "retrying" => {
                let since = *self.since.get_or_insert(now);
                if now.duration_since(since) < STALL_NOTICE_AFTER {
                    return None;
                }
                let cause = match (info.status_code, info.error_type.as_deref()) {
                    (Some(c), _) => format!("HTTP {c}"),
                    (None, Some(t)) if !t.is_empty() => t.to_string(),
                    _ => "no response".into(),
                };
                let mins = now.duration_since(since).as_secs().div_ceil(60);
                format!("it has not reached {model} for {mins} min ({cause})")
            }
            _ => return None,
        };
        self.since.get_or_insert(now);
        if std::mem::replace(&mut self.notified, true) {
            return None;
        }
        Some(reason)
    }

    /// A model call went through: any stall is over. `true` when one was on.
    pub fn on_progress(&mut self) -> bool {
        self.notified = false;
        self.since.take().is_some()
    }
}

/// The notice a stalled member sends its lead.
pub(super) fn stall_notice(handle: &str, reason: &str) -> String {
    format!(
        "{handle} is stalled: {reason}. It keeps trying on its own, and its report will follow if it recovers. To go on without it, stop it with team(action='stop', target='{handle}')."
    )
}

/// Watches a member's model calls and tells its lead when it stalls.
pub(crate) struct MemberStallHook {
    pub lead: String,
    pub handle: String,
    pub pool: DbPool,
    watch: Mutex<StallWatch>,
}

impl MemberStallHook {
    pub fn new(lead: &str, handle: &str, pool: DbPool) -> Self {
        Self { lead: lead.into(), handle: handle.into(), pool, watch: Mutex::default() }
    }
}

#[async_trait]
impl Hook for MemberStallHook {
    async fn on_provider_retry(&self, _ctx: &RunContext, info: &ProviderStatus) {
        let now = tokio::time::Instant::now();
        let Some(reason) = self.watch.lock().unwrap().on_retry(info, now) else { return };
        with_instance(&self.lead, &self.handle, |i| i.stall = Some(reason.clone()));
        tracing::warn!("subagent_stalled lead={} handle={} reason={}", self.lead, self.handle, reason);
        if let Err(e) = deliver_message_to_lead(&self.lead, &self.handle, &stall_notice(&self.handle, &reason), &self.pool).await {
            tracing::warn!("Failed to deliver subagent stall notice to lead: {}", e);
        }
    }

    async fn after_model(&self, _ctx: &RunContext, _state: &mut AgentState, _resp: &mut AssistantMessage) {
        if self.watch.lock().unwrap().on_progress() {
            with_instance(&self.lead, &self.handle, |i| i.stall = None);
        }
    }
}
