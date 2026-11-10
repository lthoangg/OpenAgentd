//! Asks the person at this computer to confirm before the account adds a
//! or removes a device (`tunnel-threats.md`, "Computer signers"): Touch ID
//! or the login password through LocalAuthentication on macOS. Elsewhere,
//! and on a Mac with neither, the click in the app is the confirmation.
//! Only then does the app make the proof its server needs for that exact
//! change (`approval.rs`).
//!
//! This is about the person, not about secrecy: the signing key sits in the
//! user-only identity file, which anything running as the user can read
//! anyway. What it stops is an approval nobody at the screen meant, such as
//! one an agent's shell command sends to the server.

use crate::approval::{self, Action};

/// Most characters of the reason shown in the system prompt.
const MAX_REASON_CHARS: usize = 120;

fn reason_text(reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        return "approve a device for your account".to_string();
    }
    reason.chars().take(MAX_REASON_CHARS).collect()
}

/// The `X-Agentd-Approval` proof for `action` (`approve` or `remove`) on
/// `id`, once the person confirmed (or the platform has no such check);
/// `None` when they cancelled or failed it.
///
/// `invite` (showing an invitation, or looking at its candidates) changes
/// nothing in the account, so it asks for no confirmation: its proof only
/// keeps the invitation link from callers outside this app.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cloud_approval_proof(
    window: tauri::WebviewWindow,
    action: String,
    id: String,
    signer: bool,
    server: bool,
    client: bool,
    reason: String,
) -> Result<Option<String>, String> {
    if crate::window::is_overlay_window(window.label()) {
        return Err("Only app windows can approve devices.".into());
    }
    let action = match action.as_str() {
        "approve" => Action::Approve {
            signer,
            server,
            client,
        },
        "remove" => Action::Remove,
        "invite" => Action::Invite,
        _ => return Err("Unknown action.".into()),
    };
    if !approval::valid_id(&id) {
        return Err("Malformed request.".into());
    }
    if action == Action::Invite {
        return Ok(Some(approval::proof(action, &id)));
    }
    let reason = reason_text(&reason);
    let confirmed = tauri::async_runtime::spawn_blocking(move || platform::confirm(&reason))
        .await
        .map_err(|e| format!("presence check failed: {e}"))??;
    Ok(confirmed.then(|| approval::proof(action, &id)))
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
