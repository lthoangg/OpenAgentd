//! The phone's account keys on Android: the Keystore store of the shell
//! plugin (`android-plugin/android/src/main/java/CloudKeyStore.kt`), the
//! Android counterpart of `ios_keys` in `cloud.rs`, with the same three
//! items (`appv3/contract/tunnel-threats.md`, "Storage").
//!
//! Whether the phone can hold an account at all is asked off the main
//! thread (a plugin call from it would wait on itself) and kept here:
//! [`refresh`] runs at launch and whenever the page reads the status, so a
//! screen lock set or removed meanwhile counts at the next look.
//!
//! The rules that need no phone ([`reason`], [`answer`]) also build on the
//! host, for the unit tests.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "android")]
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "android")]
use tauri_plugin_openagentd_android::{AndroidShell, KeyRead, KeysAvailability};
use zeroize::Zeroizing;

#[cfg(target_os = "android")]
use super::{Identity, PhoneKeys, Status};
use super::SIGN_KEY_GONE;

const IDENTITY: i32 = 0;
const BOX: i32 = 1;
const SIGN: i32 = 2;

/// Android 11: the first whose Keystore keys can need a strong biometric
/// or the screen lock on every use, through one system prompt (as iOS
/// `.userPresence`). Older phones get no account (plan, decision 1).
const MIN_API: u32 = 30;

const TOO_OLD: &str = "Accounts need Android 11 or later.";
const NO_HARDWARE: &str = "This phone can't keep account keys safely: its key store has no secure hardware.";

#[cfg(target_os = "android")]
static SHELL: OnceLock<AndroidShell<tauri::Wry>> = OnceLock::new();
#[cfg(target_os = "android")]
static AVAILABILITY: Mutex<Option<KeysAvailability>> = Mutex::new(None);
#[cfg(target_os = "android")]
static REFRESHING: AtomicBool = AtomicBool::new(false);

/// Keeps the plugin handle and returns the key store; starts the first
/// [`refresh`].
#[cfg(target_os = "android")]
pub fn install(shell: AndroidShell<tauri::Wry>) -> Box<dyn PhoneKeys> {
    let _ = SHELL.set(shell);
    refresh();
    Box::new(Keystore)
}

/// Asks the plugin again whether the phone can hold the keys, in the
/// background; a guest's status follows the answer.
#[cfg(target_os = "android")]
pub fn refresh() {
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn_blocking(|| {
        if let Some(Ok(a)) = SHELL.get().map(|s| s.cloud_keys_availability()) {
            *AVAILABILITY.lock().expect("key availability") = Some(a);
            if let Status::Guest { notice, retry_after, .. } = super::status() {
                super::set_status(Status::Guest {
                    notice,
                    supported: super::supported(),
                    unsupported: super::unsupported_reason(),
                    retry_after,
                });
            }
        }
        REFRESHING.store(false, Ordering::SeqCst);
    });
}

#[cfg(target_os = "android")]
fn availability() -> Option<KeysAvailability> {
    *AVAILABILITY.lock().expect("key availability")
}

/// Why this phone can never hold the account keys (`None`: it can, or the
/// first answer has not come yet; a key store that then refuses says so).
#[cfg(target_os = "android")]
pub fn unsupported() -> Option<&'static str> {
    let a = availability()?;
    reason(a.api, a.hardware, cfg!(debug_assertions))
}

/// Debug builds accept a software Keystore, so the emulator works for
/// development; release builds refuse it (plan, decision 2).
fn reason(api: u32, hardware: bool, debug: bool) -> Option<&'static str> {
    if api < MIN_API {
        return Some(TOO_OLD);
    }
    if !hardware && !debug {
        return Some(NO_HARDWARE);
    }
    None
}

/// The phone has no PIN, pattern or password, so the signing key cannot be
/// made. Asked of Android at once (sign-in starts from the main thread,
/// where a plugin call would wait on itself), else the last [`refresh`].
#[cfg(target_os = "android")]
pub fn no_screen_lock() -> bool {
    match device_secure() {
        Some(secure) => !secure,
        None => availability().is_some_and(|a| !a.secure_lock),
    }
}

/// `KeyguardManager.isDeviceSecure()`, through JNI on the calling thread.
#[cfg(target_os = "android")]
fn device_secure() -> Option<bool> {
    use jni::objects::JObject;
    let ctx = ndk_context::android_context();
    // SAFETY: tao fills the context with the process's JavaVM and a global
    // reference to the application context before any command runs.
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let result = (|| {
        let name = env.new_string("keyguard").ok()?;
        let keyguard = env
            .call_method(&context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[(&name).into()])
            .ok()?
            .l()
            .ok()?;
        if keyguard.is_null() {
            return None;
        }
        env.call_method(&keyguard, "isDeviceSecure", "()Z", &[]).ok()?.z().ok()
    })();
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    result
}

/// What the push service needs to open letters (account id, this phone's
/// device id, its computers' box keys; not secret), or `None` to forget it.
/// Written in the background: the roster changes on async workers.
#[cfg(target_os = "android")]
pub fn set_push_context(context: Option<serde_json::Value>) {
    let Some(shell) = SHELL.get().cloned() else { return };
    let text = context.map(|c| c.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let _ = shell.set_push_context(text.as_deref());
    });
}

/// Debug Android builds: an Android app gets no environment of its own, so
/// the variables a developer sets elsewhere to use a development cloud
/// (`OPENAGENTD_CLOUD_API`, `OPENAGENTD_CLOUD_ACCOUNT`, read only by debug
/// builds, `native/cloud/src/endpoints.rs`) come from `<app data>/dev.env`,
/// one `NAME=value` per line, written with `adb shell run-as`. Other names
/// are ignored.
#[cfg(all(target_os = "android", debug_assertions))]
pub fn load_dev_env(dir: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(dir.join("dev.env")) else { return };
    for line in text.lines() {
        if let Some((name, value)) = line.trim().split_once('=') {
            if matches!(name, "OPENAGENTD_CLOUD_API" | "OPENAGENTD_CLOUD_ACCOUNT") {
                std::env::set_var(name, value);
            }
        }
    }
}

#[cfg(target_os = "android")]
fn shell() -> Result<&'static AndroidShell<tauri::Wry>, String> {
    SHELL.get().ok_or_else(|| "The key store is not ready.".to_string())
}

/// What a read means (`status`, `value`, `message` of `CloudKeyStore.Read`),
/// in the words iOS uses for the same cases.
fn answer(status: &str, value: Option<&str>, message: Option<&str>) -> Result<Option<Zeroizing<String>>, String> {
    match status {
        "ok" => Ok(value.map(|v| Zeroizing::new(v.to_owned()))),
        "not_found" => Ok(None),
        "cancelled" => Err("Cancelled.".to_string()),
        "invalidated" => Err(SIGN_KEY_GONE.to_string()),
        _ => Err(format!(
            "The key store could not read the account keys ({}).",
            message.unwrap_or("unknown error")
        )),
    }
}

#[cfg(target_os = "android")]
fn set(item: i32, value: &str) -> Result<(), String> {
    shell()?
        .cloud_key_set(item, value)
        .map_err(|e| format!("The key store refused the account keys ({e})."))
}

#[cfg(target_os = "android")]
fn get(item: i32, reason: &str) -> Result<Option<Zeroizing<String>>, String> {
    let read: KeyRead = shell()?.cloud_key_get(item, reason)?;
    answer(&read.status, read.value.as_deref(), read.message.as_deref())
}

#[cfg(target_os = "android")]
struct Keystore;

#[cfg(target_os = "android")]
impl PhoneKeys for Keystore {
    fn load(&self) -> Result<Option<Identity>, String> {
        match get(IDENTITY, "")? {
            Some(text) => Identity::from_secret(&text)
                .map(Some)
                .map_err(|e| e.to_string()),
            None => Ok(None),
        }
    }
    fn save(&self, id: &Identity) -> Result<(), String> {
        // Asked again here, off the main thread: a sign-in may start before
        // the first `refresh` answered, and new keys must never land in a
        // key store the account refuses.
        let a = shell()?.cloud_keys_availability()?;
        *AVAILABILITY.lock().expect("key availability") = Some(a);
        if let Some(why) = reason(a.api, a.hardware, cfg!(debug_assertions)) {
            return Err(why.to_string());
        }
        if !a.secure_lock {
            return Err(super::NO_PASSCODE.to_string());
        }
        let mut id = id.clone();
        let sign = id.split_sign();
        set(SIGN, &sign)?;
        set(BOX, &id.r#box)?;
        set(IDENTITY, &id.to_secret())
    }
    fn update(&self, id: &Identity) -> Result<(), String> {
        let mut id = id.clone();
        let _ = id.split_sign();
        set(IDENTITY, &id.to_secret())
    }
    fn unlock_sign(&self, reason: &str) -> Result<Zeroizing<String>, String> {
        get(SIGN, reason)?.ok_or_else(|| SIGN_KEY_GONE.to_string())
    }
    fn clear(&self) -> Result<(), String> {
        if shell()?.cloud_keys_clear()? {
            return Err("Some account keys could not be erased. Sign out again.".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_android_and_software_keys_are_refused() {
        assert_eq!(reason(29, true, false), Some(TOO_OLD));
        assert_eq!(reason(30, false, false), Some(NO_HARDWARE));
        // Debug builds (the emulator) accept a software key store.
        assert_eq!(reason(30, false, true), None);
        assert_eq!(reason(35, true, false), None);
    }

    #[test]
    fn key_store_answers_read_as_ios_reports_them() {
        assert_eq!(answer("ok", Some("seed"), None).unwrap().as_deref().map(String::as_str), Some("seed"));
        assert_eq!(answer("not_found", None, None).unwrap(), None);
        assert_eq!(answer("cancelled", None, None).unwrap_err(), "Cancelled.");
        assert_eq!(answer("invalidated", None, None).unwrap_err(), SIGN_KEY_GONE);
        assert_eq!(
            answer("error", None, Some("Key user not authenticated")).unwrap_err(),
            "The key store could not read the account keys (Key user not authenticated)."
        );
    }
}
