//! Builtin OAuth login flows (`app/cli/commands/auth.py::_PROVIDERS`).

use crate::plugin::OAuthSink;
use appv3_core::credentials::{self as store, Credential};
use serde_json::Value;

/// `(provider, description)` — `agentd auth` listing order is sorted.
pub const PROVIDERS: [(&str, &str); 3] = [
    ("copilot", "GitHub Copilot — device-flow OAuth"),
    ("codex", "OpenAI Codex — PKCE OAuth (ChatGPT subscription)"),
    ("grok", "Grok Build — device-flow OAuth (Grok subscription)"),
];

pub fn is_builtin(provider_id: &str) -> bool {
    PROVIDERS.iter().any(|(p, _)| *p == provider_id)
}

/// Where one OAuth account's token document lives: a credential of the
/// provider in `credentials.yaml`. A slot whose credential does not exist
/// yet is a new account; saving creates it.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenSlot {
    pub provider_id: String,
    pub credential_id: String,
}

impl TokenSlot {
    pub fn new(provider_id: &str, credential_id: &str) -> Self {
        TokenSlot { provider_id: provider_id.into(), credential_id: credential_id.into() }
    }

    /// A slot for an account that is not stored yet.
    pub fn new_account(provider_id: &str) -> Self {
        Self::new(provider_id, &store::new_id())
    }

    /// The account currently serving the provider (a fresh slot when none).
    pub fn active(provider_id: &str) -> Self {
        match store::active(provider_id) {
            Some(c) => Self::new(provider_id, &c.id),
            None => Self::new_account(provider_id),
        }
    }

    fn credential(&self) -> Option<Credential> {
        store::snapshot().find(&self.provider_id, &self.credential_id).cloned()
    }

    /// Whether the credential exists (connected or waiting for reconnect).
    pub fn exists(&self) -> bool {
        self.credential().is_some()
    }

    pub fn label(&self) -> Option<String> {
        self.credential().map(|c| c.label).filter(|l| !l.is_empty())
    }

    /// The stored token document.
    pub fn load(&self) -> Option<Value> {
        self.credential()?.oauth
    }

    /// Store `doc`. A new account is appended, unless another credential of
    /// the provider is the same account (`identity`), which is updated
    /// instead (and this slot then points at it).
    pub fn save(&mut self, doc: Value, identity: Option<&str>) -> std::io::Result<()> {
        let identity = identity.filter(|i| !i.is_empty()).map(String::from);
        let pid = self.provider_id.clone();
        let id = self.credential_id.clone();
        let target = store::update(|f| {
            let ident_of = |c: &Credential| c.oauth.as_ref().and_then(|d| oauth_identity(&pid, d));
            let existing = f
                .find(&pid, &id)
                .map(|c| c.id.clone())
                .or_else(|| identity.as_ref().and_then(|i| f.provider(&pid).iter().find(|c| ident_of(c).as_deref() == Some(i)).map(|c| c.id.clone())));
            match existing {
                Some(eid) => {
                    let c = f.find_mut(&pid, &eid).expect("exists");
                    c.oauth = Some(doc);
                    eid
                }
                None => {
                    let n = f.provider(&pid).len() + 1;
                    let label = crate::credentials_migration::oauth_account_label(&doc).unwrap_or_else(|| format!("Account {n}"));
                    let mut c = Credential { id: id.clone(), label, ..Default::default() };
                    c.oauth = Some(doc);
                    f.provider_mut(&pid).push(c);
                    id.clone()
                }
            }
        })?;
        if target != self.credential_id {
            self.credential_id = target;
        }
        store::clear_cooldown(&self.provider_id, &self.credential_id);
        Ok(())
    }

    /// The provider rejected the session: keep the account in the list but
    /// drop its tokens, so it shows as needing a reconnect.
    pub fn revoke(&self) {
        let (pid, id) = (self.provider_id.clone(), self.credential_id.clone());
        let _ = store::update(|f| {
            if let Some(c) = f.find_mut(&pid, &id) {
                c.oauth = None;
            }
        });
    }

    /// Remove the account entirely.
    pub fn remove(&self) -> bool {
        let (pid, id) = (self.provider_id.clone(), self.credential_id.clone());
        store::update(|f| f.remove(&pid, &id).is_some()).unwrap_or(false)
    }

    /// Where the tokens are saved, for messages.
    pub fn display(&self) -> String {
        format!("{} ({}: {})", store::path().display(), self.provider_id, self.label().unwrap_or_else(|| self.credential_id.clone()))
    }
}

/// What makes two token documents the same account, when the provider
/// says: Codex's ChatGPT account id, Grok's user (`sub`) claim.
pub fn oauth_identity(provider_id: &str, doc: &Value) -> Option<String> {
    match provider_id {
        "codex" => doc.get("account_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from),
        "grok" => doc.get("access_token").and_then(|v| v.as_str()).and_then(crate::grok::token_subject),
        _ => None,
    }
}

/// Forget the provider's discovered models once no enabled account of it
/// holds tokens any more (a revoked session), as removing the token file did.
pub fn forget_models_if_disconnected(provider_id: &str) {
    if store::snapshot().enabled(provider_id).iter().all(|c| !c.has_secret()) {
        let _ = appv3_core::runtime_settings::forget_provider_models(provider_id);
    }
}

/// Run the builtin `login(event_sink=sink)` for `codex` / `copilot` / `grok`
/// (UI flow: codex defaults to the device flow unless `browser`). `slot`
/// is the account to reconnect, or a new one to add.
pub async fn builtin_login(provider_id: &str, browser: bool, sink: OAuthSink, slot: TokenSlot) -> Result<(), String> {
    match provider_id {
        "codex" => crate::codex::login(Some(sink), false, browser, slot).await,
        "copilot" => crate::copilot::login(Some(sink), None, slot).await,
        "grok" => crate::grok::login(Some(sink), slot).await,
        _ => Err(format!("Unknown OAuth provider '{provider_id}'.")),
    }
}

/// Builtin OAuth modules expose no `callback`/`oauth_callback` in v2.
pub async fn builtin_callback(_provider_id: &str, _code: &str, _sink: OAuthSink) -> Option<Result<(), String>> {
    None
}
