//! Android-only native bridge for the OpenAgentd mobile shell.
//!
//! Things the iOS shell gets from the platform for free need Kotlin
//! on Android:
//!
//! * **Credential store.** `keyring` 3 has no Android backend and silently
//!   falls back to an in-memory mock, so access keys vanished between calls.
//!   [`init`] registers a keyring credential builder backed by the Android
//!   Keystore, so `openagentd-shell-core`'s access-key functions work
//!   unchanged.
//! * **Account keys.** The phone's OpenAgentd account keys for Remote
//!   control (`CloudKeyStore.kt`): Keystore-wrapped, the signing seed behind
//!   a strong biometric or the screen lock on every use
//!   ([`AndroidShell::cloud_key_get`]), as the iOS Keychain bridge does.
//! * **File sharing.** `tauri-plugin-opener` cannot open a local path on
//!   Android (it fires `ACTION_VIEW` with a bare path); [`AndroidShell::share_file`]
//!   shares a cached file through a `FileProvider` and the system chooser,
//!   matching the iOS share sheet.
//! * **WebView text size.** The WebView follows the system font size
//!   (capped like iOS Dynamic Type), Kotlin-side.
//! * **Cleartext LAN servers.** The library manifest ships a network
//!   security config that permits `http://` origins (the server has no
//!   built-in TLS), which the release APK otherwise blocks in the WebView.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
mod android;

#[cfg(target_os = "android")]
pub use android::{AndroidShell, AndroidShellExt, KeyRead, KeysAvailability, LaunchTaps, PushState};

/// Build the plugin. On Android this registers the Kotlin `ShellPlugin`,
/// manages an [`AndroidShell`] handle, and installs the Keystore-backed
/// keyring store; elsewhere it is an inert placeholder.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("openagentd-android")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            android::setup(_app, _api)?;
            Ok(())
        })
        .build()
}
