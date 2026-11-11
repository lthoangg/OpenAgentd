//! Which notification the person tapped, kept until the web UI asks
//! (`notification_take_taps`). A tap that launches the app happens before
//! the page has loaded, so the platform side queues it:
//! * iOS: `ios-widget/App/NotificationTapBridge.swift` wraps the
//!   notification delegate and queues every tap; after each one the page is
//!   told with a `notification-tapped` event.
//! * Android: the notification plugin reports a tap that started the app
//!   before the page listens, so the launch intent's notification id is
//!   read here; later taps reach the page through the plugin.

use serde::{Deserialize, Serialize};
#[cfg(target_os = "ios")]
use std::sync::OnceLock;
use tauri::AppHandle;

/// The event the page gets after a tap was queued (iOS).
#[cfg(target_os = "ios")]
pub const TAPPED_EVENT: &str = "notification-tapped";

/// One tap, as the web UI reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Tap {
    /// "A device wants to join your account".
    Approval,
    /// An account push the phone opened: the session it is about, and the
    /// computer that sealed it.
    Session {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sender: Option<String>,
    },
    /// A notification the app posted itself, by its id.
    Local { id: i64 },
}

/// Session and device ids: what the backend and the cloud use (uuids and
/// base64url), nothing that could reshape a route.
fn id_ok(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Tap {
    fn valid(self) -> Option<Tap> {
        match self {
            Tap::Session { session, sender } => id_ok(&session).then(|| Tap::Session {
                session,
                sender: sender.filter(|s| id_ok(s)),
            }),
            other => Some(other),
        }
    }
}

/// The platform's JSON array of taps; anything malformed is left out.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn parse(json: &str) -> Vec<Tap> {
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Tap>(v).ok())
        .filter_map(Tap::valid)
        .collect()
}

#[cfg(target_os = "ios")]
static APP: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "ios")]
extern "C" fn tapped() {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit(TAPPED_EVENT, ());
    }
}

/// Starts queueing taps. Call once from `setup`, after the notification
/// plugin is registered.
pub fn install(app: &AppHandle) {
    #[cfg(target_os = "ios")]
    {
        extern "C" {
            fn openagentd_notification_taps_install(on_tap: Option<extern "C" fn()>);
        }
        let _ = APP.set(app.clone());
        unsafe { openagentd_notification_taps_install(Some(tapped)) };
    }
    #[cfg(not(target_os = "ios"))]
    let _ = app;
}

#[cfg(target_os = "ios")]
fn take_platform(_app: &AppHandle) -> Vec<Tap> {
    use std::ffi::{c_char, CStr};
    extern "C" {
        fn openagentd_notification_take_taps(out: *mut *mut c_char) -> i32;
        fn openagentd_notification_free(p: *mut c_char);
    }
    let mut out: *mut c_char = std::ptr::null_mut();
    if unsafe { openagentd_notification_take_taps(&mut out) } != 0 || out.is_null() {
        return Vec::new();
    }
    let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
    unsafe { openagentd_notification_free(out) };
    parse(&text)
}

#[cfg(target_os = "android")]
fn take_platform(app: &AppHandle) -> Vec<Tap> {
    use tauri_plugin_openagentd_android::AndroidShellExt;
    app.android_shell()
        .take_launch_notification()
        .ok()
        .flatten()
        .map(|id| vec![Tap::Local { id }])
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn take_platform(_app: &AppHandle) -> Vec<Tap> {
    Vec::new()
}

/// The taps since the last call, oldest first.
#[tauri::command]
pub async fn notification_take_taps(app: AppHandle) -> Result<Vec<Tap>, String> {
    tauri::async_runtime::spawn_blocking(move || take_platform(&app))
        .await
        .map_err(|e| format!("Notification taps: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_kind_of_tap() {
        let taps = parse(
            r#"[{"kind":"approval"},
                {"kind":"session","session":"0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10","sender":"dev_Mac-1"},
                {"kind":"session","session":"s2"},
                {"kind":"local","id":123456}]"#,
        );
        assert_eq!(
            taps,
            vec![
                Tap::Approval,
                Tap::Session {
                    session: "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10".into(),
                    sender: Some("dev_Mac-1".into())
                },
                Tap::Session {
                    session: "s2".into(),
                    sender: None
                },
                Tap::Local { id: 123456 },
            ]
        );
    }

    #[test]
    fn leaves_out_what_is_not_a_tap() {
        assert!(parse("not json").is_empty());
        assert!(parse(r#"{"kind":"approval"}"#).is_empty());
        let taps = parse(
            r#"[{"kind":"session","session":"../settings"},
                {"kind":"session","session":""},
                {"kind":"session","session":"ok","sender":"a/b"},
                {"kind":"local","id":"7"},
                {"kind":"other"}]"#,
        );
        assert_eq!(
            taps,
            vec![Tap::Session {
                session: "ok".into(),
                sender: None
            }]
        );
    }

    #[test]
    fn serializes_for_the_web_ui() {
        let json = serde_json::to_value(vec![
            Tap::Approval,
            Tap::Session {
                session: "s".into(),
                sender: None,
            },
            Tap::Local { id: 5 },
        ])
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!([{"kind":"approval"},{"kind":"session","session":"s"},{"kind":"local","id":5}])
        );
    }
}
