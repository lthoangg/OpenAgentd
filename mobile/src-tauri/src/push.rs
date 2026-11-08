//! APNs device registration (iOS only; nothing else supports push yet).
//!
//! Produces the registration agentd-cloud's `POST /v1/push/register` takes,
//! field for field: `{ provider: "apns", token, environment }`. Nothing here
//! sends it anywhere; a cloud client will.
//!
//! The environment comes from the app's own signature, never a guess: a
//! token sent to the wrong APNs host is answered `BadDeviceToken` and the
//! cloud deletes it. See [`environment_from_profile`].
//!
//! The authorization status, prompt, and token come from the Swift bridge
//! `mobile/ios-widget/App/PushBridge.swift`, which also explains how the
//! token callbacks are attached to Tauri's app delegate.

// Off iOS only the `unsupported` path runs; the rest is still compiled
// (and unit-tested) on the host.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use serde::Serialize;

/// `UNAuthorizationStatus`, as far as push is concerned. Provisional and
/// ephemeral authorization count as `Authorized`. `Unsupported`: a platform
/// without APNs (everything but iOS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PushAuthorization {
    NotDetermined,
    Denied,
    Authorized,
    Unsupported,
}

/// The APNs host a token belongs to, named as agentd-cloud names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApnsEnvironment {
    Production,
    Sandbox,
}

/// The body of agentd-cloud's `POST /v1/push/register`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PushRegistration {
    pub provider: &'static str,
    /// The APNs device token, lowercase hex.
    pub token: String,
    pub environment: ApnsEnvironment,
}

/// What both commands resolve to. `registration` is set only when the app
/// is authorized, signed for push, and APNs gave a token; `error` says why
/// not when something failed (a denied or undetermined status is not an
/// error).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PushState {
    pub status: PushAuthorization,
    pub registration: Option<PushRegistration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PushState {
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    fn unsupported() -> Self {
        Self {
            status: PushAuthorization::Unsupported,
            registration: None,
            error: Some("Push notifications are only available on iOS.".to_string()),
        }
    }
}

/// The APNs environment an app's signature allows, from the
/// `embedded.mobileprovision` in its bundle (`None`: the bundle has none).
///
/// * No profile: App Store and TestFlight builds, whose profile Apple strips;
///   they are signed with a distribution profile, so `Production`.
/// * A profile whose `aps-environment` is `development` → `Sandbox`,
///   `production` → `Production`.
/// * A profile without `aps-environment` (or with another value): the build
///   cannot receive push, so an error rather than a guess.
///
/// The profile is a CMS envelope around an XML plist stored as is, so the
/// entitlement is read straight from the plist text.
pub fn environment_from_profile(profile: Option<&[u8]>) -> Result<ApnsEnvironment, String> {
    let Some(profile) = profile else {
        return Ok(ApnsEnvironment::Production);
    };
    let text = String::from_utf8_lossy(profile);
    let plist = match (text.find("<plist"), text.rfind("</plist>")) {
        (Some(start), Some(end)) if start < end => &text[start..end],
        _ => return Err("The provisioning profile has no readable plist.".to_string()),
    };
    match plist_string(plist, "aps-environment").as_deref() {
        Some("development") => Ok(ApnsEnvironment::Sandbox),
        Some("production") => Ok(ApnsEnvironment::Production),
        Some(other) => Err(format!(
            "Unknown aps-environment {other:?} in the provisioning profile."
        )),
        None => {
            Err("This build is not signed for push notifications (no aps-environment).".to_string())
        }
    }
}

/// The `<string>` value right after `<key>{key}</key>` in plist XML.
fn plist_string(plist: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let rest = plist[plist.find(&marker)? + marker.len()..].trim_start();
    let value = rest.strip_prefix("<string>")?;
    Some(value[..value.find("</string>")?].trim().to_string())
}

/// Current status without prompting. When already authorized, also
/// registers with APNs (that never prompts) to return the current token.
#[tauri::command]
pub async fn push_status() -> PushState {
    run_blocking(|| platform::state(false)).await
}

/// Prompt for notification permission if it was never asked, then register
/// with APNs when authorized.
#[tauri::command]
pub async fn push_register() -> PushState {
    run_blocking(|| platform::state(true)).await
}

/// The platform calls wait on iOS callbacks; keep them off the async workers.
async fn run_blocking(call: impl FnOnce() -> PushState + Send + 'static) -> PushState {
    tauri::async_runtime::spawn_blocking(call)
        .await
        .unwrap_or_else(|e| PushState {
            status: PushAuthorization::Unsupported,
            registration: None,
            error: Some(format!("Push registration failed: {e}")),
        })
}

/// At launch: refresh the registration if the user already allowed
/// notifications (the token can change between launches), without
/// prompting. Debug builds (`make ios-dev`) may prompt, and log the result
/// once so a real token can be tested; release builds never log the token.
/// Returns at once; the work runs on its own thread, never the main one the
/// iOS callbacks need.
#[cfg(target_os = "ios")]
pub fn refresh_at_launch() {
    std::thread::spawn(|| {
        let state = platform::state(cfg!(debug_assertions));
        if cfg!(debug_assertions) {
            // tauri routes stdout to the unified log on iOS.
            println!(
                "[openagentd push] {}",
                serde_json::to_string(&state).unwrap_or_default()
            );
        }
    });
}

#[cfg(target_os = "ios")]
mod platform {
    use super::{environment_from_profile, PushAuthorization, PushRegistration, PushState};
    use std::ffi::{c_char, c_void, CStr};
    use std::sync::mpsc::{channel, Sender};
    use std::time::Duration;

    /// How long to wait for iOS. APNs registration needs the network; a
    /// phone offline may not answer for a long time.
    const TIMEOUT: Duration = Duration::from_secs(30);

    type StatusCallback = extern "C" fn(i32, *mut c_void);
    type TokenCallback = extern "C" fn(*const c_char, *const c_char, *mut c_void);

    extern "C" {
        // `mobile/ios-widget/App/PushBridge.swift`, compiled into the app
        // target by `scripts/patch-ios-widget.sh`. Each calls its callback
        // exactly once, with `context`, on any thread.
        fn openagentd_push_authorization_status(callback: StatusCallback, context: *mut c_void);
        fn openagentd_push_request_authorization(callback: StatusCallback, context: *mut c_void);
        fn openagentd_push_register(callback: TokenCallback, context: *mut c_void);
    }

    type Token = Result<String, String>;

    extern "C" fn on_status(code: i32, context: *mut c_void) {
        // SAFETY: `context` is the `Box<Sender<i32>>` leaked in `status`, and
        // the bridge calls back exactly once.
        let sender = unsafe { Box::from_raw(context.cast::<Sender<i32>>()) };
        let _ = sender.send(code);
    }

    extern "C" fn on_token(token: *const c_char, error: *const c_char, context: *mut c_void) {
        // SAFETY: as in `on_status`; the strings are NUL-terminated and live
        // for the duration of the call.
        let sender = unsafe { Box::from_raw(context.cast::<Sender<Token>>()) };
        let read = |p: *const c_char| {
            (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
        };
        let result = match (read(token), read(error)) {
            (Some(token), _) if !token.is_empty() => Ok(token),
            (_, Some(error)) => Err(error),
            _ => Err("APNs returned no device token".to_string()),
        };
        let _ = sender.send(result);
    }

    /// Ask the bridge with `call` and wait for its answer. On a timeout the
    /// boxed sender is freed whenever the bridge does answer.
    fn ask<T: Send + 'static, C>(call: impl FnOnce(C, *mut c_void), callback: C) -> Option<T> {
        let (sender, receiver) = channel::<T>();
        let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
        call(callback, context);
        receiver.recv_timeout(TIMEOUT).ok()
    }

    fn status(prompt: bool) -> Option<PushAuthorization> {
        let code: i32 = if prompt {
            // SAFETY: `on_status` matches the bridge's callback type.
            ask(
                |cb, ctx| unsafe { openagentd_push_request_authorization(cb, ctx) },
                on_status as StatusCallback,
            )?
        } else {
            ask(
                |cb, ctx| unsafe { openagentd_push_authorization_status(cb, ctx) },
                on_status as StatusCallback,
            )?
        };
        Some(match code {
            0 => PushAuthorization::NotDetermined,
            2 => PushAuthorization::Authorized,
            _ => PushAuthorization::Denied,
        })
    }

    fn token() -> Token {
        // SAFETY: `on_token` matches the bridge's callback type.
        ask(
            |cb, ctx| unsafe { openagentd_push_register(cb, ctx) },
            on_token as TokenCallback,
        )
        .unwrap_or_else(|| Err("APNs did not answer in time".to_string()))
    }

    /// `embedded.mobileprovision` sits next to the executable in the bundle.
    fn profile() -> Result<Option<Vec<u8>>, String> {
        let exe = std::env::current_exe().map_err(|e| format!("Locate the app bundle: {e}"))?;
        let Some(bundle) = exe.parent() else {
            return Ok(None);
        };
        match std::fs::read(bundle.join("embedded.mobileprovision")) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Read the provisioning profile: {e}")),
        }
    }

    pub fn state(prompt: bool) -> PushState {
        let failed = |status, error: String| PushState {
            status,
            registration: None,
            error: Some(error),
        };
        let Some(mut current) = status(false) else {
            return failed(
                PushAuthorization::NotDetermined,
                "iOS did not report the notification status".into(),
            );
        };
        if prompt && current == PushAuthorization::NotDetermined {
            match status(true) {
                Some(after) => current = after,
                None => return failed(current, "iOS did not answer the permission request".into()),
            }
        }
        if current != PushAuthorization::Authorized {
            return PushState {
                status: current,
                registration: None,
                error: None,
            };
        }
        // Simulators have no profile but get sandbox tokens.
        let environment = if cfg!(target_abi = "sim") {
            Ok(super::ApnsEnvironment::Sandbox)
        } else {
            profile().and_then(|p| environment_from_profile(p.as_deref()))
        };
        let environment = match environment {
            Ok(environment) => environment,
            Err(error) => return failed(current, error),
        };
        match token() {
            Ok(token) => PushState {
                status: current,
                registration: Some(PushRegistration {
                    provider: "apns",
                    token,
                    environment,
                }),
                error: None,
            },
            Err(error) => failed(current, error),
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod platform {
    use super::PushState;

    pub fn state(_prompt: bool) -> PushState {
        PushState::unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A provisioning profile as Xcode writes it: binary CMS around the plist.
    fn profile(entitlements: &str) -> Vec<u8> {
        let mut bytes = vec![0x30, 0x82, 0x1f, 0x00, 0x06, 0x09, 0xff, 0xfe];
        bytes.extend_from_slice(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AppIDName</key>
	<string>OpenAgentd Dev</string>
	<key>Entitlements</key>
	<dict>
		<key>application-identifier</key>
		<string>XLRF257KSP.com.dev.openagentd.mobile</string>
{entitlements}
		<key>get-task-allow</key>
		<true/>
	</dict>
	<key>Name</key>
	<string>iOS Team Provisioning Profile: com.dev.openagentd.mobile</string>
</dict>
</plist>"#
            )
            .as_bytes(),
        );
        bytes.extend_from_slice(&[0xa0, 0x82, 0x0b, 0x00, 0x00]);
        bytes
    }

    #[test]
    fn a_development_profile_means_sandbox() {
        let p = profile("\t\t<key>aps-environment</key>\n\t\t<string>development</string>");
        assert_eq!(
            environment_from_profile(Some(&p)),
            Ok(ApnsEnvironment::Sandbox)
        );
    }

    #[test]
    fn a_production_profile_means_production() {
        let p = profile("\t\t<key>aps-environment</key>\n\t\t<string>production</string>");
        assert_eq!(
            environment_from_profile(Some(&p)),
            Ok(ApnsEnvironment::Production)
        );
    }

    /// App Store and TestFlight installs carry no profile.
    #[test]
    fn no_profile_means_production() {
        assert_eq!(
            environment_from_profile(None),
            Ok(ApnsEnvironment::Production)
        );
    }

    #[test]
    fn a_profile_without_push_is_an_error_not_a_guess() {
        assert!(environment_from_profile(Some(&profile(""))).is_err());
        let odd = profile("\t\t<key>aps-environment</key>\n\t\t<string>staging</string>");
        assert!(environment_from_profile(Some(&odd)).is_err());
        assert!(environment_from_profile(Some(b"not a profile")).is_err());
    }

    /// The registration is agentd-cloud's `POST /v1/push/register` body as is.
    #[test]
    fn serializes_in_the_shape_the_cloud_takes() {
        let state = PushState {
            status: PushAuthorization::Authorized,
            registration: Some(PushRegistration {
                provider: "apns",
                token: "a1b2".into(),
                environment: ApnsEnvironment::Sandbox,
            }),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({
                "status": "authorized",
                "registration": { "provider": "apns", "token": "a1b2", "environment": "sandbox" },
            }),
        );
        let denied = PushState {
            status: PushAuthorization::NotDetermined,
            registration: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&denied).unwrap(),
            json!({ "status": "not_determined", "registration": null }),
        );
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn other_platforms_report_unsupported() {
        assert_eq!(platform::state(true).status, PushAuthorization::Unsupported);
    }
}
