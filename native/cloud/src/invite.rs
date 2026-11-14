//! Invitations (spec section 4.3): the link and the two MACs; and scan to
//! add (section 4.3.1): the code a new device shows, and the number.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::encoding::{b64, from_b64};
use crate::endpoints::valid_user_code;
use crate::keys::{is_device_id, random_bytes};
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

pub(crate) fn id_ok(s: &str) -> bool {
    (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The values of a query that has exactly the fields `names`, once each.
fn fields<'a, const N: usize>(query: &'a str, names: [&str; N]) -> Result<[&'a str; N]> {
    let mut found: [Option<&str>; N] = [None; N];
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').ok_or(Error::Invite)?;
        let i = names.iter().position(|n| *n == name).ok_or(Error::Invite)?;
        if found[i].replace(value).is_some() {
            return Err(Error::Invite);
        }
    }
    let mut out = [""; N];
    for (o, f) in out.iter_mut().zip(found) {
        *o = f.ok_or(Error::Invite)?;
    }
    Ok(out)
}

/// Parses a link exactly as [`link`] writes it.
pub fn parse_link(text: &str) -> Result<Invitation> {
    let query = text.trim().strip_prefix("agentd://invite?").ok_or(Error::Invite)?;
    let [a, s, k] = fields(query, ["a", "s", "k"])?;
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

/// Scan to add: `agentd://add?c=<user_code without the dash>&d=<device_id>&k=<b64(secret)>`.
pub fn add_link(user_code: &str, device_id: &str, secret: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(format!("agentd://add?c={}&d={device_id}&k={}", user_code.replace('-', ""), b64(secret)))
}

/// What a scan-to-add code names.
pub struct AddCode {
    /// `XXXX-XXXX`, as the cloud issues it.
    pub user_code: String,
    pub device_id: String,
    pub secret: Zeroizing<Vec<u8>>,
}

impl std::fmt::Debug for AddCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AddCode({}, {}, [redacted])", self.user_code, self.device_id)
    }
}

/// Parses a scan-to-add code exactly as [`add_link`] writes it.
pub fn parse_add_link(text: &str) -> Result<AddCode> {
    let query = text.trim().strip_prefix("agentd://add?").ok_or(Error::Invite)?;
    let [c, d, k] = fields(query, ["c", "d", "k"])?;
    if c.len() != 8 || !c.is_ascii() {
        return Err(Error::Invite);
    }
    let user_code = format!("{}-{}", &c[..4], &c[4..]);
    let secret = Zeroizing::new(from_b64(k)?);
    if !valid_user_code(&user_code) || !is_device_id(d) || secret.len() != 16 {
        return Err(Error::Invite);
    }
    Ok(AddCode { user_code, device_id: d.to_string(), secret })
}

/// What the scan-to-add number covers: the roster that added `device_id`,
/// written by `signer_id`.
pub struct NumberInput<'a> {
    pub account_id: &'a str,
    pub slot_id: &'a str,
    pub signer_id: &'a str,
    pub device_id: &'a str,
    pub version: u64,
    /// b64(SHA-256(envelope bytes)) of the roster that added the device.
    pub roster_hash: &'a str,
}

/// The 2-digit number the signer shows and the person picks on the new
/// device (spec section 4.3.1, step 5).
pub fn add_number(secret: &[u8], n: &NumberInput<'_>) -> String {
    let m = mac(secret, &lines!["agentd-add-number-v1", n.account_id, n.slot_id, n.signer_id, n.device_id, n.version, n.roster_hash]);
    format!("{:02}", u32::from_be_bytes([m[0], m[1], m[2], m[3]]) % 100)
}

/// `number` and two other 2-digit numbers chosen at random, with `number`
/// at a random place: what the new device offers the person to pick from.
pub fn number_choices(number: &str) -> [String; 3] {
    let mut out = vec![number.to_string()];
    while out.len() < 3 {
        let [r] = random_bytes::<1>();
        // 200 = 2 * 100: rejection keeps each number equally likely.
        let n = format!("{:02}", r % 100);
        if r < 200 && !out.contains(&n) {
            out.push(n);
        }
    }
    let place = loop {
        let [r] = random_bytes::<1>();
        // 255 = 3 * 85.
        if r < 255 {
            break r as usize % 3;
        }
    };
    out.swap(0, place);
    [out[0].clone(), out[1].clone(), out[2].clone()]
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "Mehu2cOzX7i8ikGeWpl0ag";

    #[test]
    fn a_scan_code_reads_back_as_written() {
        let link = add_link("BCDF-GHJK", ID, &[7u8; 16]);
        assert_eq!(link.as_str(), "agentd://add?c=BCDFGHJK&d=Mehu2cOzX7i8ikGeWpl0ag&k=BwcHBwcHBwcHBwcHBwcHBw");
        let code = parse_add_link(&link).unwrap();
        assert_eq!((code.user_code.as_str(), code.device_id.as_str(), code.secret.as_slice()), ("BCDF-GHJK", ID, &[7u8; 16][..]));
    }

    #[test]
    fn only_a_well_formed_scan_code_parses() {
        let k = "BwcHBwcHBwcHBwcHBwcHBw";
        for bad in [
            format!("agentd://invite?c=BCDFGHJK&d={ID}&k={k}"),
            format!("agentd://add?c=bcdfghjk&d={ID}&k={k}"),
            format!("agentd://add?c=BCDFGHJA&d={ID}&k={k}"),
            format!("agentd://add?c=BCDFGHJ&d={ID}&k={k}"),
            format!("agentd://add?c=BCDFGHÉ&d={ID}&k={k}"),
            format!("agentd://add?c=BCDFGHJK&d=short&k={k}"),
            format!("agentd://add?c=BCDFGHJK&d={ID}&k=BwcH"),
            format!("agentd://add?c=BCDFGHJK&d={ID}"),
            format!("agentd://add?c=BCDFGHJK&d={ID}&k={k}&k={k}"),
            format!("agentd://add?c=BCDFGHJK&d={ID}&k={k}&next=x"),
        ] {
            assert!(parse_add_link(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_number_is_two_digits_and_names_the_signer_that_added() {
        let n = |signer_id: &str| add_number(&[1u8; 16], &NumberInput { account_id: "acct", slot_id: "slot", signer_id, device_id: ID, version: 2, roster_hash: "h" });
        let ours = n("signer-a");
        assert_eq!(ours.len(), 2);
        assert!(ours.bytes().all(|b| b.is_ascii_digit()));
        let others: Vec<String> = (0..20).map(|i| n(&format!("signer-{i}"))).collect();
        assert!(others.iter().any(|o| *o != ours), "another signer's number differs");
    }

    #[test]
    fn the_choices_hold_the_number_and_two_others() {
        for _ in 0..200 {
            let c = number_choices("07");
            assert_eq!(c.iter().filter(|n| *n == "07").count(), 1, "{c:?}");
            assert!(c[0] != c[1] && c[1] != c[2] && c[0] != c[2], "{c:?}");
            assert!(c.iter().all(|n| n.len() == 2 && n.bytes().all(|b| b.is_ascii_digit())));
        }
    }
}
