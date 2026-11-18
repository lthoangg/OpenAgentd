//! The Android push service's way into this library
//! (`android-plugin/android/src/main/java/Letters.kt`): it opens a letter
//! with the code the rest of the account uses ([`crate::push::open_letter`],
//! tested against the contract's vectors in `native/cloud`), and asks which
//! account computer the app is on, to skip a banner for the computer whose
//! own notifications the app already shows (as `ForegroundPush.swift`).
//!
//! A push may start the process with no activity: then this library is
//! loaded by `Letters.kt` alone, Tauri never runs, and [`APP`] stays empty.

use std::sync::OnceLock;

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use tauri::AppHandle;
use zeroize::Zeroizing;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Called once from `setup`.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn read(env: &mut JNIEnv, s: &JString) -> Option<Zeroizing<String>> {
    if s.is_null() {
        return None;
    }
    env.get_string(s).ok().map(|j| Zeroizing::new(String::from(j)))
}

fn answer(env: &mut JNIEnv, text: Option<String>) -> jstring {
    text.and_then(|t| env.new_string(t).ok())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// `Letters.openNative(sealed, boxSeed, context)`: the opened letter as
/// JSON (`push::OpenedLetter`), or null.
#[no_mangle]
pub extern "system" fn Java_app_openagentd_shell_Letters_openNative<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    sealed: JString<'l>,
    box_seed: JString<'l>,
    context: JString<'l>,
) -> jstring {
    let opened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let sealed = read(&mut env, &sealed)?;
        let seed = read(&mut env, &box_seed)?;
        let context = read(&mut env, &context)?;
        let opened = crate::push::open_letter(&sealed, &seed, &context)?;
        serde_json::to_string(&opened).ok()
    }))
    .ok()
    .flatten();
    answer(&mut env, opened)
}

/// `Letters.openDeviceNative()`: the account computer the app is on, or null.
#[no_mangle]
pub extern "system" fn Java_app_openagentd_shell_Letters_openDeviceNative<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
) -> jstring {
    let device = std::panic::catch_unwind(|| APP.get().and_then(crate::open_account_device))
        .ok()
        .flatten();
    answer(&mut env, device)
}
