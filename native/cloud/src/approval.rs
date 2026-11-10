//! The local approval proof (`tunnel-threats.md`, "Computer signers"): how
//! the desktop app shows its own server that the person at the screen
//! approved a roster change, so that a process that only reaches the
//! loopback API (an agent's shell, say) cannot.
//!
//! The app makes a random 32-byte key at each launch and hands it to the
//! server it starts over the server's stdin. After the person confirms
//! (Touch ID or the login password where the computer has one), the app
//! sends
//!
//! ```text
//! X-Agentd-Approval: b64url(HMAC-SHA256(key,
//!     "agentd-approve-v1" 0x00 action 0x00 id 0x00 signer "," server "," client))
//! ```
//!
//! where `action` is `approve` (id: the enrollment id), `remove` (id: the
//! device id) or `invite` (id: `start`, or the open invitation's slot id to
//! look at its candidates), and each role is `1` or `0` (all `0` for
//! `remove` and `invite`). The MAC binds the request: it does not carry over
//! to another device, other roles, or another action. `invite` signs no
//! roster: it keeps the invitation link, a bearer secret, from callers that
//! only reach the loopback API (an agent's shell); the app makes it without
//! asking for Touch ID.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::encoding::{b64, from_b64_array};

/// The header the proof travels in.
pub const HEADER: &str = "X-Agentd-Approval";
/// The key's length in bytes.
pub const KEY_LEN: usize = 32;

/// What the person approved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Add the device that signed in (`id`: its enrollment id).
    Approve { signer: bool, server: bool, client: bool },
    /// Remove a device (`id`: its device id).
    Remove,
    /// Show an invitation (`id`: `start`) or look at its candidates (`id`:
    /// its slot id).
    Invite,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Action::Approve { .. } => "approve",
            Action::Remove => "remove",
            Action::Invite => "invite",
        }
    }

    fn flags(self) -> [bool; 3] {
        match self {
            Action::Approve { signer, server, client } => [signer, server, client],
            Action::Remove | Action::Invite => [false; 3],
        }
    }
}

/// The bytes the MAC covers.
pub fn message(action: Action, id: &str) -> Vec<u8> {
    let flag = |b: bool| if b { "1" } else { "0" };
    let [signer, server, client] = action.flags();
    let mut m = Vec::with_capacity(48 + id.len());
    m.extend_from_slice(b"agentd-approve-v1\0");
    m.extend_from_slice(action.name().as_bytes());
    m.push(0);
    m.extend_from_slice(id.as_bytes());
    m.push(0);
    m.extend_from_slice(format!("{},{},{}", flag(signer), flag(server), flag(client)).as_bytes());
    m
}

fn mac(key: &[u8; KEY_LEN], action: Action, id: &str) -> [u8; 32] {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(&message(action, id));
    m.finalize().into_bytes().into()
}

/// The header value for `action` on `id`.
pub fn proof(key: &[u8; KEY_LEN], action: Action, id: &str) -> String {
    b64(&mac(key, action, id))
}

/// Whether `header` is the proof for `action` on `id`, compared in constant
/// time. A malformed header is simply wrong.
pub fn verify(key: &[u8; KEY_LEN], action: Action, id: &str, header: &str) -> bool {
    let Ok(given) = from_b64_array::<32>(header.trim()) else { return false };
    bool::from(mac(key, action, id).ct_eq(&given))
}

/// The key as the desktop app writes it to its server's stdin: unpadded
/// base64url, surrounding whitespace ignored. Decoded straight into memory
/// that is zeroized on drop.
pub fn parse_key(text: &[u8]) -> Option<Zeroizing<[u8; KEY_LEN]>> {
    let text = text.trim_ascii();
    let engine = data_encoding::BASE64URL_NOPAD;
    if engine.decode_len(text.len()).ok()? != KEY_LEN {
        return None;
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    let n = engine.decode_mut(text, &mut key[..]).ok()?;
    (n == KEY_LEN).then_some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; KEY_LEN] = [7; KEY_LEN];
    const ENR: &str = "enr_0123456789abcdef";

    #[test]
    fn the_key_reads_back_from_its_line() {
        let line = format!("{}\n", b64(&KEY));
        assert_eq!(*parse_key(line.as_bytes()).unwrap(), KEY);
        assert!(parse_key(b"").is_none());
        assert!(parse_key(b"short").is_none());
        assert!(parse_key(format!("{}=", b64(&KEY)).as_bytes()).is_none(), "padding");
        assert!(parse_key(b64(&[7; 31]).as_bytes()).is_none(), "wrong length");
    }

    #[test]
    fn the_message_is_exactly_as_documented() {
        let a = Action::Approve { signer: true, server: false, client: true };
        assert_eq!(message(a, ENR), b"agentd-approve-v1\0approve\0enr_0123456789abcdef\x001,0,1");
        assert_eq!(message(Action::Remove, "dev1"), b"agentd-approve-v1\0remove\0dev1\x000,0,0");
        assert_eq!(message(Action::Invite, "start"), b"agentd-approve-v1\0invite\0start\x000,0,0");
    }

    #[test]
    fn a_fixed_vector_matches_the_desktop_app() {
        // desktop/src-tauri/src/approval.rs checks the same value.
        let a = Action::Approve { signer: true, server: false, client: true };
        assert_eq!(proof(&KEY, a, ENR), "HtzmpxpUO72Cg4tbGCLd5e7CyrS9LB79H7Bl_TZ3iKs");
    }

    #[test]
    fn the_proof_binds_key_action_id_and_roles() {
        let a = Action::Approve { signer: false, server: true, client: true };
        let p = proof(&KEY, a, ENR);
        assert!(verify(&KEY, a, ENR, &p));
        assert!(!verify(&[8; KEY_LEN], a, ENR, &p), "another key");
        assert!(!verify(&KEY, a, "enr_other0000000000", &p), "another enrollment");
        assert!(!verify(&KEY, Action::Approve { signer: true, server: true, client: true }, ENR, &p), "another signer flag");
        assert!(!verify(&KEY, Action::Approve { signer: false, server: false, client: true }, ENR, &p), "other roles");
        assert!(!verify(&KEY, Action::Remove, ENR, &p), "another action");
        assert!(!verify(&KEY, Action::Invite, ENR, &p), "another action");
        assert!(!verify(&KEY, Action::Invite, "start", &proof(&KEY, Action::Invite, "slot")), "another id");
        assert!(!verify(&KEY, a, ENR, ""), "empty");
        assert!(!verify(&KEY, a, ENR, "not base64!"), "malformed");
        assert!(!verify(&KEY, a, ENR, &p[..p.len() - 2]), "truncated");
    }
}
