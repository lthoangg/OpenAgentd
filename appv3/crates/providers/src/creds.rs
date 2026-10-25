//! `ProviderCredentialStore` — port of `plugin_registry.ProviderCredentialStore`
//! (overrides → real process env → `credentials.yaml`).

use appv3_core::{credentials, settings};
use indexmap::IndexMap;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Default)]
pub struct CredentialStore {
    pub provider_id: String,
    overrides: HashMap<String, String>,
    /// One specific stored credential's values (a credential pool's pick);
    /// `None` reads whichever credential currently serves the provider.
    pinned: Option<IndexMap<String, String>>,
}

impl CredentialStore {
    pub fn new(overrides: HashMap<String, String>) -> Self {
        Self::for_provider("", overrides)
    }

    pub fn for_provider(provider_id: &str, overrides: HashMap<String, String>) -> Self {
        CredentialStore { provider_id: provider_id.to_string(), overrides, pinned: None }
    }

    /// Reads `values` (one stored credential) after overrides and the
    /// exported environment.
    pub fn for_credential(provider_id: &str, values: IndexMap<String, String>) -> Self {
        CredentialStore { provider_id: provider_id.to_string(), overrides: HashMap::new(), pinned: Some(values) }
    }

    /// Explicit overrides (values being validated before they are saved).
    pub fn overrides(&self) -> &HashMap<String, String> {
        &self.overrides
    }

    /// `get(name, default="")`.
    pub fn get(&self, name: &str) -> String {
        if let Some(v) = self.overrides.get(name) {
            return v.clone();
        }
        if let Some(v) = credentials::env_override(name) {
            return v;
        }
        match &self.pinned {
            Some(values) => values.get(name).cloned().unwrap_or_default(),
            None => credentials::stored(Some(&self.provider_id).filter(|p| !p.is_empty()).map(String::as_str), name).unwrap_or_default(),
        }
    }

    /// `{CACHE_DIR}/provider-plugins/<id>` (created).
    pub fn token_dir(&self) -> PathBuf {
        let root = settings().cache_dir.join("provider-plugins").join(&self.provider_id);
        let _ = std::fs::create_dir_all(&root);
        root
    }

    /// `token_path(filename)`.
    pub fn token_path(&self, filename: &str) -> PathBuf {
        self.token_dir().join(filename.replace('/', "_"))
    }
}
