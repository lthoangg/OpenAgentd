//! Which provider a session's turn calls: the session's model and thinking
//! level over the agent's own, a pinned credential, and what a failed
//! provider call makes the session forget.

use super::{AgentSession, RuntimeProvider};
use crate::agent::Agent;
use crate::errors::AgentError;
use appv3_db as db;
use appv3_providers::{Kwargs, ProviderError};
use serde_json::{json, Map};

fn split_provider_model(model_id: Option<&str>) -> Option<(String, String)> {
    let m = model_id?;
    let (p, rest) = m.split_once(':')?;
    if p.is_empty() || rest.is_empty() {
        return None;
    }
    Some((p.to_string(), rest.to_string()))
}

pub(super) fn forget_provider_credentials(model_id: Option<&str>) {
    let Some((pid, _)) = split_provider_model(model_id) else {
        return;
    };
    // A provider with one OAuth account loses that login (it shows as
    // needing a reconnect). With several, the failed one was already put on
    // cooldown and the others may still work.
    let f = appv3_core::credentials::snapshot();
    let enabled = f.enabled(&pid);
    if appv3_providers::oauth::is_builtin(&pid) && enabled.len() == 1 {
        appv3_providers::oauth::TokenSlot::new(&pid, &enabled[0].id).revoke();
        let _ = appv3_core::runtime_settings::forget_provider_models(&pid);
    } else if enabled.len() <= 1 {
        let _ = appv3_core::runtime_settings::forget_provider_models(&pid);
    }
}

pub(super) fn forget_retired_model(model_id: Option<&str>) {
    if let Some((p, m)) = split_provider_model(model_id) {
        let _ = appv3_core::runtime_settings::remove_provider_model(&p, &m);
    }
}

pub(super) fn provider_error_to_agent(e: ProviderError) -> AgentError {
    match e {
        ProviderError::Unconfigured(m) => AgentError::Unconfigured(m),
        ProviderError::Auth(m) => AgentError::Auth { message: m, status: None, provider: None },
        other => AgentError::Other(other.to_string()),
    }
}

/// The model and thinking level a turn runs with, from the session's
/// overrides (its row) over the agent's own. Shared by the provider a turn
/// calls and the prompt row, which records what it was sent with.
pub(super) struct TurnSettings {
    /// The session's model, else the agent's.
    pub(super) model: Option<String>,
    pub(super) thinking_level: Option<String>,
    /// The overrides change something, so the turn needs its own provider.
    needs_runtime: bool,
}

/// Whether pinned credential `id` belongs to the provider of `model`
/// (`provider:model`); a pin to another provider's credential is ignored.
fn pin_fits(model: Option<&str>, id: &str) -> bool {
    let Some((provider, _)) = model.and_then(|m| m.split_once(':')) else { return false };
    appv3_providers::pool::credential_provider(id).as_deref() == Some(provider)
}

impl TurnSettings {
    pub(super) fn resolve(agent: &Agent, runtime_model: Option<&str>, runtime_thinking: Option<&str>) -> Self {
        let runtime_model = runtime_model.filter(|m| !m.is_empty());
        let model = runtime_model.map(String::from).or_else(|| agent.model_id.clone());
        let overridden = runtime_model.is_some_and(|m| Some(m) != agent.model_id.as_deref()) || runtime_thinking.is_some();
        let needs_runtime = overridden && model.as_deref().is_some_and(|m| !m.is_empty());
        // A runtime provider carries only the session's level; the agent's
        // own level applies only to the agent's own provider.
        let thinking_level = if needs_runtime { runtime_thinking.map(String::from) } else { agent.thinking_level.clone() };
        Self { model, thinking_level, needs_runtime }
    }
}

impl AgentSession {
    /// The provider for the session's `model` / `thinking_level` overrides
    /// (from its row), or the agent's own when neither changes anything.
    /// A pinned credential (`credential`) of the model's provider always
    /// gets its own provider, which sends every request to that credential.
    pub fn resolve_runtime_provider(
        &self,
        agent: &Agent,
        runtime_model: Option<&str>,
        runtime_thinking: Option<&str>,
        credential: Option<&str>,
    ) -> Result<RuntimeProvider, ProviderError> {
        let settings = TurnSettings::resolve(agent, runtime_model, runtime_thinking);
        let pin = credential.filter(|id| pin_fits(settings.model.as_deref(), id));
        let mut runtime = None;
        if settings.needs_runtime || pin.is_some() {
            if let Some(em) = settings.model.as_deref() {
                let mut kw = Kwargs::new();
                if let Some(t) = settings.thinking_level.as_deref() {
                    kw.insert("thinking_level".into(), json!(t));
                }
                if let Some(id) = pin {
                    kw.insert(appv3_providers::pool::PIN_KWARG.into(), json!(id));
                }
                runtime = Some((self.provider_factory)(Some(em), kw)?);
            }
        }
        Ok(RuntimeProvider { effective_model: settings.model, runtime, thinking_level: settings.thinking_level })
    }

    /// The credential this session's turns are pinned to: its own row's, or
    /// for a member, its lead's (members follow the lead's choice live).
    pub async fn pinned_credential(&self, row: &db::ChatSession) -> Option<String> {
        match &self.parent_session_id {
            Some(lead) => db::get_session(&self.pool, lead).await.ok().flatten().and_then(|r| r.credential_id),
            None => row.credential_id.clone(),
        }
    }

    /// A lead whose locked credential was removed or turned off loses the
    /// lock, and the transcript says so.
    pub(super) async fn release_stale_pin(&self, sid: &str, row: &db::ChatSession) {
        let Some(id) = row.credential_id.as_deref() else { return };
        if self.parent_session_id.is_some() {
            return;
        }
        let provider = appv3_providers::pool::credential_provider(id);
        if provider.as_deref().is_some_and(|p| appv3_providers::pool::pin_usable(p, id)) {
            return;
        }
        if let Err(e) = db::update_session(&self.pool, sid, db::SessionUpdate { credential_id: Some(None), ..Default::default() }).await {
            tracing::warn!("session_pin_release_failed session_id={} error={}", sid, e);
            return;
        }
        tracing::info!("session_pin_released session_id={} credential={}", sid, id);
        let mut extra = Map::new();
        extra.insert("message".into(), json!("The account this session started on was removed or turned off, so it uses the provider's next available account."));
        self.emit("provider_status", Some("pin_released"), Some(extra));
    }
}
