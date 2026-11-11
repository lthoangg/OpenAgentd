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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareTextPayload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
}

/// One row of a [`AndroidShell::pick_one`] dialog.
#[derive(Serialize)]
pub struct PickChoice<'a> {
    pub id: &'a str,
    pub label: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickPayload<'a> {
    title: &'a str,
    options: &'a [PickChoice<'a>],
    #[serde(skip_serializing_if = "Option::is_none")]
    selected: Option<&'a str>,
}

#[derive(Deserialize)]
struct PickAnswer {
    /// Absent when the dialog was dismissed.
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
struct LaunchNotification {
    #[serde(default)]
    id: Option<i64>,
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

    /// Offer a link and/or text to other apps through the system share
    /// chooser. Blocks until the chooser is shown; call it off the async
    /// runtime.
    pub fn share_text(
        &self,
        text: Option<&str>,
        url: Option<&str>,
        title: Option<&str>,
    ) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>(
                "shareText",
                ShareTextPayload { text, url, title },
            )
            .map(|_| ())
            .map_err(|e| format!("Share text: {e}"))
    }

    /// Show a single-choice dialog and wait for the answer: the chosen
    /// option's id, or `None` when the user dismissed it. Async because the
    /// dialog stays up for as long as the user takes.
    pub async fn pick_one(
        &self,
        title: &str,
        options: &[PickChoice<'_>],
        selected: Option<&str>,
    ) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin_async::<PickAnswer>(
                "pickOne",
                PickPayload {
                    title,
                    options,
                    selected,
                },
            )
            .await
            .map(|answer| answer.id)
            .map_err(|e| format!("Pick one: {e}"))
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

    /// The id of the app's notification whose tap started the app, once
    /// (the notification plugin reports that tap before the page listens).
    /// Blocks on the JNI call; call it off the async runtime.
    pub fn take_launch_notification(&self) -> Result<Option<i64>, String> {
        self.0
            .run_mobile_plugin::<LaunchNotification>("takeLaunchNotification", ())
            .map(|n| n.id)
            .map_err(|e| format!("Launch notification: {e}"))
    }

    /// Match the status bar and webview background to the web UI's theme
    /// preference (`"light"`, `"dark"`, or `"system"`) and remember it for
    /// the next launch. Blocks on the JNI call; call it off the async runtime.
    pub fn set_app_theme(&self, preference: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("setAppTheme", ThemePayload { preference })
            .map(|_| ())
            .map_err(|e| format!("Set app theme: {e}"))
    }

    /// Hand a downloaded APK (inside the app cache directory) to the system
    /// installer. The first time, Android asks the user to allow installs
    /// from OpenAgentd; this opens that setting and returns an error asking
    /// them to try again. Blocks on the JNI call; call it off the async
    /// runtime.
    pub fn install_apk(&self, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("installApk", SharePayload { path })
            .map(|_| ())
            .map_err(|e| format!("{e}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemePayload<'a> {
    preference: &'a str,
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
