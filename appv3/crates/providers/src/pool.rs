//! A provider backed by every enabled credential of one provider id. Each
//! request goes to the credential selected by `appv3_core::credentials`
//! (sticky, falling through in priority order); `rotate_credential` moves
//! the provider on after a quota, rate-limit, or auth failure.

use crate::creds::CredentialStore;
use crate::factory::build_member;
use crate::oauth::TokenSlot;
use crate::types::*;
use appv3_core::credentials::{self as store, Credential};
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Header added to a pooled request's HTTP error naming the credential
/// that served it (never a secret: the stored id).
pub const CREDENTIAL_HEADER: &str = "x-openagentd-credential";

/// How long a credential whose member failed to build (a revoked login, a
/// bad stored value) is skipped.
const BUILD_FAILURE_COOLDOWN: f64 = 600.0;

/// The variable that, exported in the server's environment, pins the
/// provider to that value instead of the stored credentials.
pub fn env_pin_var(provider_id: &str) -> Option<&'static str> {
    if let Some(spec) = crate::factory::compat_spec(provider_id) {
        return Some(spec.env_var);
    }
    match provider_id {
        "vertexai" => Some("VERTEXAI_API_KEY"),
        "bedrock" => Some("AWS_BEARER_TOKEN_BEDROCK"),
        _ => crate::catalog::provider_key_var(provider_id),
    }
}

/// Whether an exported variable pins `provider_id` (stored credentials are
/// then not used).
pub fn env_pinned(provider_id: &str) -> bool {
    if provider_id == "copilot" {
        return crate::copilot::env_github_token().is_some();
    }
    if provider_id == "bedrock" && store::env_override("AWS_BEDROCK_PROFILE").is_some() {
        return true;
    }
    env_pin_var(provider_id).is_some_and(|v| store::env_override(v).is_some())
}

/// Builtin providers draw from the credential pool; plugin providers keep
/// their own single-credential contract.
pub fn is_poolable(provider_id: &str) -> bool {
    crate::catalog::builtin_providers().iter().any(|e| e["id"] == provider_id)
}

/// The factory entry for `"<name>:<model>"`.
pub fn build_pooled(name: &str, model: &str, kw: Kwargs) -> ProviderResult<Arc<dyn LlmProvider>> {
    let has_stored = !store::snapshot().enabled(name).is_empty();
    if !is_poolable(name) || env_pinned(name) || !has_stored {
        return build_member(name, model, kw, &CredentialStore::for_provider(name, Default::default()), None);
    }
    let pool = PooledProvider { provider_id: name.into(), model: model.into(), kw, members: Mutex::default(), first: OnceLock::new() };
    // Build the credential in use now, so a bad model or credential fails
    // the build as it did before pooling.
    pool.member_blocking()?;
    Ok(Arc::new(pool))
}

/// credential id → (fingerprint of its stored values, built provider).
type Members = Mutex<HashMap<String, (String, Arc<dyn LlmProvider>)>>;

pub struct PooledProvider {
    provider_id: String,
    model: String,
    kw: Kwargs,
    members: Members,
    /// The first member built; answers the synchronous metadata calls,
    /// which are the same for every credential of a provider and model.
    first: OnceLock<Arc<dyn LlmProvider>>,
}

fn fingerprint(c: &Credential) -> String {
    let doc = serde_json::json!({"v": c.values, "o": c.oauth});
    crate::plugin::sha256_hex(&doc.to_string())
}

/// An OAuth document whose access token is (about to be) expired.
fn oauth_expired(c: &Credential) -> bool {
    c.oauth
        .as_ref()
        .and_then(|d| d.get("expires_at"))
        .and_then(|e| e.as_f64().or_else(|| e.as_str().and_then(|s| s.trim().parse().ok())))
        .is_some_and(|at| store::now_s() >= at - 60.0)
}

impl PooledProvider {
    fn build(&self, c: &Credential) -> ProviderResult<Arc<dyn LlmProvider>> {
        let creds = CredentialStore::for_credential(&self.provider_id, c.values.clone());
        let slot = TokenSlot::new(&self.provider_id, &c.id);
        build_member(&self.provider_id, &self.model, self.kw.clone(), &creds, Some(&slot))
    }

    fn cached(&self, c: &Credential) -> Option<Arc<dyn LlmProvider>> {
        if oauth_expired(c) {
            return None;
        }
        let fp = fingerprint(c);
        self.members.lock().unwrap().get(&c.id).filter(|(f, _)| *f == fp).map(|(_, p)| p.clone())
    }

    fn remember(&self, c: &Credential, p: Arc<dyn LlmProvider>) {
        // Re-read: a refresh during the build rewrote the stored tokens.
        let fresh = store::snapshot().find(&self.provider_id, &c.id).cloned().unwrap_or_else(|| c.clone());
        self.members.lock().unwrap().insert(c.id.clone(), (fingerprint(&fresh), p.clone()));
        let _ = self.first.set(p);
    }

    /// Candidates in the order to try: the selected one first, then the
    /// rest of the ready ones in priority order.
    fn candidates(&self) -> ProviderResult<Vec<Credential>> {
        let f = store::snapshot();
        let enabled = f.enabled(&self.provider_id);
        let Some(first) = store::select(&self.provider_id, &enabled).cloned() else {
            return Err(ProviderError::Unconfigured(format!("No enabled credential for '{}'. Add or enable one in Settings → Providers.", self.provider_id)));
        };
        let mut out = vec![first.clone()];
        out.extend(enabled.iter().filter(|c| c.id != first.id && store::cooldown(&self.provider_id, &c.id).is_none()).map(|c| (*c).clone()));
        Ok(out)
    }

    fn on_build_failure(&self, c: &Credential, e: &ProviderError) {
        tracing::warn!("provider_credential_unusable provider={} credential={} error={}", self.provider_id, c.id, e);
        store::set_cooldown(&self.provider_id, &c.id, store::now_s() + BUILD_FAILURE_COOLDOWN, "auth");
    }

    /// Synchronous pick (the factory's eager build).
    fn member_blocking(&self) -> ProviderResult<(String, Arc<dyn LlmProvider>)> {
        let mut last = None;
        for c in self.candidates()? {
            if let Some(p) = self.cached(&c) {
                store::set_current(&self.provider_id, &c.id);
                return Ok((c.id, p));
            }
            match self.build(&c) {
                Ok(p) => {
                    self.remember(&c, p.clone());
                    store::set_current(&self.provider_id, &c.id);
                    return Ok((c.id, p));
                }
                Err(e) => {
                    self.on_build_failure(&c, &e);
                    last = Some(e);
                }
            }
        }
        Err(last.expect("at least one candidate"))
    }

    /// The member for the next request; builds run off the async workers
    /// (an OAuth refresh blocks on the network).
    async fn member(&self) -> ProviderResult<(String, Arc<dyn LlmProvider>)> {
        let mut last = None;
        for c in self.candidates()? {
            if let Some(p) = self.cached(&c) {
                store::set_current(&self.provider_id, &c.id);
                return Ok((c.id, p));
            }
            let (pid, model, kw, cc) = (self.provider_id.clone(), self.model.clone(), self.kw.clone(), c.clone());
            let built = tokio::task::spawn_blocking(move || {
                let creds = CredentialStore::for_credential(&pid, cc.values.clone());
                build_member(&pid, &model, kw, &creds, Some(&TokenSlot::new(&pid, &cc.id)))
            })
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
            match built {
                Ok(p) => {
                    self.remember(&c, p.clone());
                    store::set_current(&self.provider_id, &c.id);
                    return Ok((c.id, p));
                }
                Err(e) => {
                    self.on_build_failure(&c, &e);
                    last = Some(e);
                }
            }
        }
        Err(last.expect("at least one candidate"))
    }
}

/// Name the credential that served a failed request on its HTTP error.
fn tag(e: ProviderError, credential_id: &str) -> ProviderError {
    match e {
        ProviderError::Http { status, body, mut headers, message } => {
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case(CREDENTIAL_HEADER));
            headers.push((CREDENTIAL_HEADER.to_string(), credential_id.to_string()));
            ProviderError::Http { status, body, headers, message }
        }
        other => other,
    }
}

#[async_trait::async_trait]
impl LlmProvider for PooledProvider {
    fn model(&self) -> &str {
        self.first.get().map(|p| p.model()).unwrap_or(&self.model)
    }
    fn provider_name(&self) -> Option<&str> {
        self.first.get().and_then(|p| p.provider_name()).or(Some(&self.provider_id))
    }
    fn support_interrupt(&self) -> bool {
        self.first.get().map(|p| p.support_interrupt()).unwrap_or(true)
    }
    fn base_kwargs(&self) -> &Kwargs {
        self.first.get().map(|p| p.base_kwargs()).unwrap_or(&self.kw)
    }
    fn merged_kwargs(&self, call: &Kwargs) -> Kwargs {
        match self.first.get() {
            Some(p) => p.merged_kwargs(call),
            None => call.clone(),
        }
    }
    fn cost_model_id(&self) -> Option<String> {
        match self.first.get() {
            Some(p) => p.cost_model_id(),
            None => Some(format!("{}:{}", self.provider_id, self.model)),
        }
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        let (id, p) = self.member().await?;
        p.chat(messages, tools, kwargs).await.map_err(|e| tag(e, &id))
    }
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        let (id, p) = self.member().await?;
        let s = p.stream(messages, tools, kwargs).await.map_err(|e| tag(e, &id))?;
        Ok(Box::pin(s.map(move |r| r.map_err(|e| tag(e, &id)))))
    }
    fn rotate_credential(&self, err: &ProviderError, reason: &str, cooldown_secs: f64) -> Option<String> {
        let failed = err.header(CREDENTIAL_HEADER)?.to_string();
        store::set_cooldown(&self.provider_id, &failed, store::now_s() + cooldown_secs.max(1.0), reason);
        let f = store::snapshot();
        let enabled = f.enabled(&self.provider_id);
        let label = |c: &Credential| if c.label.is_empty() { c.id.clone() } else { c.label.clone() };
        // Another session may already have moved on.
        if let Some(cur) = store::current(&self.provider_id).filter(|c| *c != failed) {
            if let Some(c) = enabled.iter().find(|c| c.id == cur && store::cooldown(&self.provider_id, &c.id).is_none()) {
                return Some(label(c));
            }
        }
        let next = store::rotate_from(&self.provider_id, &failed, &enabled)?;
        tracing::warn!("provider_credential_switched provider={} from={} to={} reason={} cooldown_s={:.0}", self.provider_id, failed, next.id, reason, cooldown_secs);
        Some(label(next))
    }
    fn credential_recovery_secs(&self) -> Option<f64> {
        let f = store::snapshot();
        let enabled = f.enabled(&self.provider_id);
        if enabled.len() < 2 {
            return None;
        }
        store::earliest_recovery(&self.provider_id, &enabled, None)
    }
}

/// The label of a pooled error's credential (for messages).
pub fn credential_label(provider_id: &str, err: &ProviderError) -> Option<String> {
    let id = err.header(CREDENTIAL_HEADER)?;
    store::snapshot().find(provider_id, id).map(|c| if c.label.is_empty() { c.id.clone() } else { c.label.clone() })
}
