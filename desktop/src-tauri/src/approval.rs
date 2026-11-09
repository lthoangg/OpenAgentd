//! The approval key (`native/cloud/src/approval.rs`, `tunnel-threats.md`,
//! "Computer signers"): how this app proves to the server it started that
//! the person at the screen approved adding or removing a device, so that a
//! process that only reaches the server's loopback API (an agent's shell)
//! cannot.
//!
//! The key is 32 random bytes made once per launch, in memory only. It
//! reaches the bundled server as one line on that process's stdin
//! (`sidecar.rs`, `--approval-key-stdin`): never an environment variable, a
//! file, an argument or a log line. Each restart of the server gets the same
//! key.
//!
//! The proof is `b64url(HMAC-SHA256(key, "agentd-approve-v1" 0x00 action
//! 0x00 id 0x00 signer "," server "," client))`, roles as `1`/`0`; the
//! server checks it in constant time. HMAC is written out here over `sha2`
//! (already in the lock) and checked against the same vector as the server.

use std::sync::OnceLock;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const KEY_LEN: usize = 32;

static KEY: OnceLock<Zeroizing<[u8; KEY_LEN]>> = OnceLock::new();

fn key() -> &'static [u8; KEY_LEN] {
    KEY.get_or_init(|| {
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        getrandom::fill(&mut key[..]).expect("the system's random source");
        key
    })
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The line written to the bundled server's stdin.
pub fn key_line() -> Zeroizing<String> {
    Zeroizing::new(format!("{}\n", b64(key())))
}

/// What the person approved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Approve {
        signer: bool,
        server: bool,
        client: bool,
    },
    Remove,
}

fn message(action: Action, id: &str) -> Vec<u8> {
    let flag = |b: bool| if b { "1" } else { "0" };
    let (name, [signer, server, client]) = match action {
        Action::Approve {
            signer,
            server,
            client,
        } => ("approve", [signer, server, client]),
        Action::Remove => ("remove", [false; 3]),
    };
    format!(
        "agentd-approve-v1\0{name}\0{id}\0{},{},{}",
        flag(signer),
        flag(server),
        flag(client)
    )
    .into_bytes()
}

/// HMAC-SHA256 (RFC 2104) for a key no longer than the block.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    assert!(key.len() <= BLOCK, "short keys only");
    let mut ipad = Zeroizing::new([0x36u8; BLOCK]);
    let mut opad = Zeroizing::new([0x5cu8; BLOCK]);
    for (i, b) in key.iter().enumerate() {
        ipad[i] ^= b;
        opad[i] ^= b;
    }
    let inner = Sha256::new()
        .chain_update(&ipad[..])
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(&opad[..])
        .chain_update(inner)
        .finalize()
        .into()
}

fn proof_with(key: &[u8; KEY_LEN], action: Action, id: &str) -> String {
    b64(&hmac_sha256(key, &message(action, id)))
}

/// The `X-Agentd-Approval` value for `action` on `id`. Only after the person
/// confirmed (`presence.rs`).
pub fn proof(action: Action, id: &str) -> String {
    proof_with(key(), action, id)
}

/// Enrollment and device ids: what the server accepts, nothing longer.
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2.
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn the_proof_matches_the_servers_vector() {
        let key = [7u8; KEY_LEN];
        let a = Action::Approve {
            signer: true,
            server: false,
            client: true,
        };
        // native/cloud/src/approval.rs checks the same value.
        assert_eq!(
            proof_with(&key, a, "enr_0123456789abcdef"),
            "HtzmpxpUO72Cg4tbGCLd5e7CyrS9LB79H7Bl_TZ3iKs"
        );
    }

    #[test]
    fn the_proof_binds_action_id_and_roles() {
        let key = [9u8; KEY_LEN];
        let a = Action::Approve {
            signer: false,
            server: true,
            client: false,
        };
        let p = proof_with(&key, a, "enr_a");
        assert_ne!(p, proof_with(&key, a, "enr_b"));
        assert_ne!(
            p,
            proof_with(
                &key,
                Action::Approve {
                    signer: false,
                    server: true,
                    client: true
                },
                "enr_a"
            )
        );
        assert_ne!(p, proof_with(&key, Action::Remove, "enr_a"));
        assert_ne!(p, proof_with(&[8u8; KEY_LEN], a, "enr_a"));
    }

    #[test]
    fn the_key_line_is_one_line_of_base64url() {
        let line = key_line();
        assert!(line.ends_with('\n'));
        assert_eq!(line.trim_end().len(), 43);
        assert_eq!(*key_line(), *line, "one key per launch");
    }

    #[test]
    fn ids_are_bounded() {
        assert!(valid_id("enr_0123456789abcdef"));
        assert!(!valid_id(""));
        assert!(!valid_id("a\0b"));
        assert!(!valid_id(&"a".repeat(65)));
    }
}
