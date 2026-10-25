use std::any::Any;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "app.openagentd.shell";

pub(crate) fn setup<R: Runtime>(
    app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ShellPlugin")?;
    // Runs inside `Builder::run`, before the webview loads, so no access-key
    // command can reach keyring's default (mock) store first.
    keyring::set_default_credential_builder(Box::new(KeystoreCredentialBuilder {
        handle: handle.clone(),
    }));
    app.manage(AndroidShell(handle));
    Ok(())
}

/// Managed handle to the Kotlin `ShellPlugin`.
pub struct AndroidShell<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharePayload<'a> {
    path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetPayload<'a> {
    /// The snapshot JSON, already validated by the shell.
    snapshot: &'a str,
}

impl<R: Runtime> AndroidShell<R> {
    /// Offer `path` (a file inside the app cache directory) to other apps
    /// through the system share chooser. Blocks until the chooser is shown;
    /// call it off the async runtime.
    pub fn share_file(&self, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("shareFile", SharePayload { path })
            .map(|_| ())
            .map_err(|e| format!("Share file: {e}"))
    }

    /// Save the home-screen widget snapshot and redraw every placed widget.
    /// Blocks on the JNI call; call it off the async runtime.
    pub fn update_widgets(&self, snapshot: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("updateWidgets", WidgetPayload { snapshot })
            .map(|_| ())
            .map_err(|e| format!("Update widgets: {e}"))
    }

    /// Send the app to the background, as Back does on a root activity.
    /// Blocks on the JNI call; call it off the async runtime.
    pub fn move_task_to_back(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("moveTaskToBack", ())
            .map(|_| ())
            .map_err(|e| format!("Move to background: {e}"))
    }
}

pub trait AndroidShellExt<R: Runtime> {
    fn android_shell(&self) -> &AndroidShell<R>;
}

impl<R: Runtime, T: Manager<R>> AndroidShellExt<R> for T {
    fn android_shell(&self) -> &AndroidShell<R> {
        self.state::<AndroidShell<R>>().inner()
    }
}

// ── Keystore-backed keyring store ───────────────────────────────────────

struct KeystoreCredentialBuilder<R: Runtime> {
    handle: PluginHandle<R>,
}

impl<R: Runtime> CredentialBuilderApi for KeystoreCredentialBuilder<R> {
    fn build(
        &self,
        _target: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<Credential>> {
        Ok(Box::new(KeystoreCredential {
            handle: self.handle.clone(),
            service: service.to_string(),
            user: user.to_string(),
        }))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn persistence(&self) -> keyring::credential::CredentialPersistence {
        keyring::credential::CredentialPersistence::UntilDelete
    }
}

struct KeystoreCredential<R: Runtime> {
    handle: PluginHandle<R>,
    service: String,
    user: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretRef<'a> {
    service: &'a str,
    user: &'a str,
    /// Base64 of the secret bytes; only sent by `secretSet`.
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Deserialize)]
struct SecretValue {
    value: Option<String>,
}

#[derive(Deserialize)]
struct SecretDeleted {
    deleted: bool,
}

fn platform_failure(e: impl std::error::Error + Send + Sync + 'static) -> keyring::Error {
    keyring::Error::PlatformFailure(Box::new(e))
}

impl<R: Runtime> KeystoreCredential<R> {
    fn secret_ref(&self, value: Option<String>) -> SecretRef<'_> {
        SecretRef {
            service: &self.service,
            user: &self.user,
            value,
        }
    }
}

impl<R: Runtime> CredentialApi for KeystoreCredential<R> {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        self.handle
            .run_mobile_plugin::<serde::de::IgnoredAny>(
                "secretSet",
                self.secret_ref(Some(STANDARD.encode(secret))),
            )
            .map(|_| ())
            .map_err(platform_failure)
    }

    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        let stored: SecretValue = self
            .handle
            .run_mobile_plugin("secretGet", self.secret_ref(None))
            .map_err(platform_failure)?;
        let encoded = stored.value.ok_or(keyring::Error::NoEntry)?;
        STANDARD
            .decode(encoded)
            .map_err(|e| keyring::Error::BadEncoding(e.to_string().into_bytes()))
    }

    fn delete_credential(&self) -> keyring::Result<()> {
        let result: SecretDeleted = self
            .handle
            .run_mobile_plugin("secretDelete", self.secret_ref(None))
            .map_err(platform_failure)?;
        if result.deleted {
            Ok(())
        } else {
            Err(keyring::Error::NoEntry)
        }
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}
