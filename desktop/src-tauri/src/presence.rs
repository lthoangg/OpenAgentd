//! Asks the person at this computer to confirm before the account adds a
//! device (`tunnel-threats.md`, "Computer signers: the trade-off"): Touch ID
//! or the login password through LocalAuthentication on macOS. Elsewhere,
//! and on a Mac with neither, the click in the app is the confirmation.
//!
//! This is about the person, not about secrecy: the signing key sits in the
//! user-only identity file, which anything running as the user can read
//! anyway. What it stops is an approval nobody at the screen meant.

/// Most characters of the reason shown in the system prompt.
const MAX_REASON_CHARS: usize = 120;

fn reason_text(reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        return "approve a device for your account".to_string();
    }
    reason.chars().take(MAX_REASON_CHARS).collect()
}

/// True when the person confirmed (or the platform has no such check),
/// false when they cancelled or failed it.
#[tauri::command]
pub async fn confirm_user_presence(
    window: tauri::WebviewWindow,
    reason: String,
) -> Result<bool, String> {
    if crate::window::is_overlay_window(window.label()) {
        return Err("Only app windows can approve devices.".into());
    }
    let reason = reason_text(&reason);
    tauri::async_runtime::spawn_blocking(move || platform::confirm(&reason))
        .await
        .map_err(|e| format!("presence check failed: {e}"))?
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    #[link(name = "LocalAuthentication", kind = "framework")]
    extern "C" {}

    /// `LAPolicyDeviceOwnerAuthentication`: Touch ID, a paired watch, or the
    /// login password.
    const DEVICE_OWNER_AUTHENTICATION: isize = 2;

    pub fn confirm(reason: &str) -> Result<bool, String> {
        let context: Option<Retained<AnyObject>> = unsafe { msg_send![class!(LAContext), new] };
        let Some(context) = context else {
            return Ok(true);
        };
        let can: Bool = unsafe {
            msg_send![&*context, canEvaluatePolicy: DEVICE_OWNER_AUTHENTICATION, error: std::ptr::null_mut::<*mut AnyObject>()]
        };
        if !can.as_bool() {
            // No Touch ID and no password to ask for: the click stands.
            return Ok(true);
        }
        let (tx, rx) = std::sync::mpsc::sync_channel::<bool>(1);
        let reply = RcBlock::new(move |ok: Bool, _error: *mut AnyObject| {
            let _ = tx.try_send(ok.as_bool());
        });
        let text = NSString::from_str(reason);
        let _: () = unsafe {
            msg_send![&*context, evaluatePolicy: DEVICE_OWNER_AUTHENTICATION, localizedReason: &*text, reply: &*reply]
        };
        Ok(rx.recv().unwrap_or(false))
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn confirm(_reason: &str) -> Result<bool, String> {
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reason_is_bounded_and_never_empty() {
        assert_eq!(reason_text("  "), "approve a device for your account");
        assert_eq!(
            reason_text(&"x".repeat(500)).chars().count(),
            MAX_REASON_CHARS
        );
    }
}
