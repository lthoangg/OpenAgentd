//! Invitations (spec section 4.3): the link and the two MACs.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::encoding::{b64, from_b64};
use crate::{lines, Error, Result};

type HmacSha256 = Hmac<Sha256>;

fn mac(secret: &[u8], message: &[u8]) -> [u8; 32] {
    let mut m = HmacSha256::new_from_slice(secret).expect("HMAC takes any key length");
    m.update(message);
    m.finalize().into_bytes().into()
}

/// `agentd://invite?a=<account_id>&s=<slot_id>&k=<b64(secret)>`.
pub fn link(account_id: &str, slot_id: &str, secret: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(format!("agentd://invite?a={account_id}&s={slot_id}&k={}", b64(secret)))
}

/// What an invitation link names.
pub struct Invitation {
    pub account_id: String,
    pub slot_id: String,
    pub secret: Zeroizing<Vec<u8>>,
}

impl std::fmt::Debug for Invitation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Invitation({}, {}, [redacted])", self.account_id, self.slot_id)
    }
}

fn id_ok(s: &str) -> bool {
    (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Parses a link exactly as [`link`] writes it.
pub fn parse_link(text: &str) -> Result<Invitation> {
    let query = text.trim().strip_prefix("agentd://invite?").ok_or(Error::Invite)?;
    let (mut a, mut s, mut k) = (None, None, None);
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').ok_or(Error::Invite)?;
        let slot = match name {
            "a" => &mut a,
            "s" => &mut s,
            "k" => &mut k,
            _ => return Err(Error::Invite),
        };
        if slot.replace(value).is_some() {
            return Err(Error::Invite);
        }
    }
    let (a, s, k) = (a.ok_or(Error::Invite)?, s.ok_or(Error::Invite)?, k.ok_or(Error::Invite)?);
    let secret = Zeroizing::new(from_b64(k)?);
    if !id_ok(a) || !id_ok(s) || secret.len() != 16 {
        return Err(Error::Invite);
    }
    Ok(Invitation { account_id: a.to_string(), slot_id: s.to_string(), secret })
}

pub struct Candidate<'a> {
    pub account_id: &'a str,
    pub slot_id: &'a str,
    pub device_id: &'a str,
    pub auth_pub: &'a [u8; 32],
    pub pubs: &'a [u8],
}

/// The candidate's `proof`.
pub fn candidate_proof(secret: &[u8], c: &Candidate<'_>) -> [u8; 32] {
    mac(secret, &lines!["agentd-invite-candidate-v1", c.account_id, c.slot_id, c.device_id, &b64(c.auth_pub), &b64(c.pubs)])
}

/// Whether a candidate's `proof` checks out (constant time).
pub fn proof_matches(secret: &[u8], c: &Candidate<'_>, proof: &[u8]) -> bool {
    proof.ct_eq(&candidate_proof(secret, c)).into()
}

pub struct Confirmation<'a> {
    pub account_id: &'a str,
    pub slot_id: &'a str,
    pub device_id: &'a str,
    pub version: u64,
    /// b64(SHA-256(envelope bytes)) of the roster that added the device.
    pub roster_hash: &'a str,
}

/// The signer's `confirm`.
pub fn signer_confirm(secret: &[u8], c: &Confirmation<'_>) -> [u8; 32] {
    mac(secret, &lines!["agentd-invite-signer-v1", c.account_id, c.slot_id, c.device_id, c.version, c.roster_hash])
}

/// Whether `confirm` checks out (constant time).
pub fn confirm_matches(secret: &[u8], c: &Confirmation<'_>, confirm: &[u8]) -> bool {
    confirm.ct_eq(&signer_confirm(secret, c)).into()
}
