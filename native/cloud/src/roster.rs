//! The roster (spec section 3): the account's signed list of devices.
//!
//! A device trusts nothing about the account that is not in a roster it
//! verified with [`verify`] after the last one it accepted.

use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::encoding::{b64, from_b64, from_b64_array};
use crate::keys::{self, device_id, Ed25519};
use crate::lines;
use crate::{Error, Result};

/// `by` of a roster signed by the recovery key.
pub const RECOVERY: &str = "recovery";
/// Largest envelope, in bytes.
pub const MAX_ENVELOPE: usize = 64 * 1024;
/// Most devices in a roster.
pub const MAX_DEVICES: usize = 10;

/// Which rule of section 3.2 a roster breaks (the vectors use these names).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Format,
    Account,
    Version,
    RecoveryPub,
    Devices,
    Signature,
    UntrustedSigner,
    Prev,
    Keys,
    Genesis,
}

impl Rule {
    pub fn name(self) -> &'static str {
        match self {
            Rule::Format => "format",
            Rule::Account => "account",
            Rule::Version => "version",
            Rule::RecoveryPub => "recovery_pub",
            Rule::Devices => "devices",
            Rule::Signature => "signature",
            Rule::UntrustedSigner => "untrusted_signer",
            Rule::Prev => "prev",
            Rule::Keys => "keys",
            Rule::Genesis => "genesis",
        }
    }
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// One device in a roster. Keys are base64url as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Device {
    pub id: String,
    pub auth: String,
    #[serde(rename = "box")]
    pub r#box: String,
    pub sign: String,
    pub signer: bool,
}

impl Device {
    /// The entry for a device with these keys.
    pub fn of(keys: &keys::DeviceKeys, signer: bool) -> Self {
        Device { id: keys.id(), auth: b64(&keys.auth.public()), r#box: b64(&keys.r#box.public()), sign: b64(&keys.sign.public()), signer }
    }

    /// The entry for a device that enrolled with `auth_pub` and `pubs`.
    pub fn enrolled(auth_pub: &[u8; 32], pubs: &keys::Pubs, signer: bool) -> Self {
        Device { id: device_id(auth_pub), auth: b64(auth_pub), r#box: b64(&pubs.r#box), sign: b64(&pubs.sign), signer }
    }

    pub fn box_key(&self) -> [u8; 32] {
        from_b64_array(&self.r#box).expect("verified roster keys are 32 bytes")
    }

    pub fn sign_key(&self) -> [u8; 32] {
        from_b64_array(&self.sign).expect("verified roster keys are 32 bytes")
    }
}

/// The roster body. Field order is the signed byte order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Body {
    pub v: u8,
    pub account_id: String,
    pub version: u64,
    pub prev: Option<String>,
    pub recovery_pub: String,
    pub devices: Vec<Device>,
}

impl Body {
    pub fn device(&self, id: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.id == id)
    }

    /// The signer with `id`, if it is one.
    pub fn signer(&self, id: &str) -> Option<&Device> {
        self.device(id).filter(|d| d.signer)
    }

    /// The genesis body: `first` alone, a signer.
    pub fn genesis(account_id: &str, recovery_pub: &[u8; 32], first: Device) -> Self {
        Body { v: 1, account_id: account_id.to_string(), version: 1, prev: None, recovery_pub: b64(recovery_pub), devices: vec![Device { signer: true, ..first }] }
    }
}

/// A parsed roster: its envelope bytes and what they say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roster {
    /// b64 of the envelope: the API's `roster` / `blob` field.
    pub blob: String,
    pub envelope: Vec<u8>,
    /// b64(SHA-256(envelope)): the next roster's `prev`.
    pub hash: String,
    pub by: String,
    pub body: Body,
    sig: [u8; 64],
    body_bytes: Vec<u8>,
}

impl Roster {
    pub fn version(&self) -> u64 {
        self.body.version
    }

    pub fn account_id(&self) -> &str {
        &self.body.account_id
    }

    /// The next body after this roster: same account and recovery key,
    /// `prev` linked, one version up.
    pub fn next_body(&self, devices: Vec<Device>) -> Body {
        Body {
            v: 1,
            account_id: self.body.account_id.clone(),
            version: self.body.version + 1,
            prev: Some(self.hash.clone()),
            recovery_pub: self.body.recovery_pub.clone(),
            devices,
        }
    }
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn message(account_id: &str, version: u64, body_bytes: &[u8]) -> Vec<u8> {
    lines!["agentd-roster-v1", account_id, version, &b64(&sha256(body_bytes))]
}

/// Signs `body` as `by` (a device id, or [`RECOVERY`]) with `key`.
pub fn sign(body: &Body, by: &str, key: &Ed25519) -> Roster {
    let body_bytes = serde_json::to_vec(body).expect("a roster body serializes");
    let sig = key.sign(&message(&body.account_id, body.version, &body_bytes));
    let envelope = format!(r#"{{"v":1,"body":"{}","by":{},"sig":"{}"}}"#, b64(&body_bytes), json_string(by), b64(&sig)).into_bytes();
    Roster { blob: b64(&envelope), hash: b64(&sha256(&envelope)), envelope, by: by.to_string(), body: body.clone(), sig, body_bytes }
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).expect("a string serializes")
}

fn exact_keys<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let obj = value.as_object()?;
    (obj.len() == keys.len() && keys.iter().all(|k| obj.contains_key(*k))).then_some(obj)
}

fn b64_len(value: &Value, len: usize) -> Option<String> {
    let s = value.as_str()?;
    (from_b64(s).ok()?.len() == len).then(|| s.to_string())
}

/// Largest integer JavaScript represents exactly (`Number.isSafeInteger`).
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Parses a blob, checking every field's type (rule 1).
pub fn parse(blob: &str) -> Result<Roster> {
    parse_inner(blob).ok_or(Error::Roster(Rule::Format))
}

fn parse_inner(blob: &str) -> Option<Roster> {
    if blob.len() > MAX_ENVELOPE.div_ceil(3) * 4 {
        return None;
    }
    let envelope = from_b64(blob).ok()?;
    if envelope.len() > MAX_ENVELOPE {
        return None;
    }
    let env: Value = serde_json::from_slice(&envelope).ok()?;
    let env = exact_keys(&env, &["v", "body", "by", "sig"])?;
    if env["v"].as_u64() != Some(1) || !env["v"].is_u64() {
        return None;
    }
    let by = env["by"].as_str()?.to_string();
    let sig: [u8; 64] = from_b64_array(env["sig"].as_str()?).ok()?;
    let body_bytes = from_b64(env["body"].as_str()?).ok()?;
    let body: Value = serde_json::from_slice(&body_bytes).ok()?;
    let b = exact_keys(&body, &["v", "account_id", "version", "prev", "recovery_pub", "devices"])?;
    if b["v"].as_u64() != Some(1) {
        return None;
    }
    let account_id = b["account_id"].as_str()?.to_string();
    let version = b["version"].as_u64().filter(|v| (1..=MAX_SAFE_INTEGER).contains(v))?;
    let prev = match &b["prev"] {
        Value::Null => None,
        other => Some(b64_len(other, 32)?),
    };
    let recovery_pub = b64_len(&b["recovery_pub"], 32)?;
    let mut devices = Vec::new();
    for d in b["devices"].as_array()? {
        let d = exact_keys(d, &["id", "auth", "box", "sign", "signer"])?;
        devices.push(Device {
            id: d["id"].as_str()?.to_string(),
            auth: b64_len(&d["auth"], 32)?,
            r#box: b64_len(&d["box"], 32)?,
            sign: b64_len(&d["sign"], 32)?,
            signer: d["signer"].as_bool()?,
        });
    }
    let hash = b64(&sha256(&envelope));
    Some(Roster { blob: blob.to_string(), envelope, hash, by, body: Body { v: 1, account_id, version, prev, recovery_pub, devices }, sig, body_bytes })
}

fn devices_valid(body: &Body) -> bool {
    let mut seen = std::collections::HashSet::new();
    for d in &body.devices {
        let Ok(auth) = from_b64_array::<32>(&d.auth) else {
            return false;
        };
        if !seen.insert(d.id.as_str()) || device_id(&auth) != d.id {
            return false;
        }
        // A low-order box key would make the 6-digit code and Noise trivial.
        if keys::is_low_order(&d.box_key()) {
            return false;
        }
    }
    (1..=MAX_DEVICES).contains(&seen.len()) && body.devices.iter().any(|d| d.signer)
}

fn signature_valid(r: &Roster, public_b64: &str) -> bool {
    let Ok(public) = from_b64_array::<32>(public_b64) else {
        return false;
    };
    keys::verify(&public, &r.sig, &message(&r.body.account_id, r.body.version, &r.body_bytes))
}

/// Whether the cloud's rule that `prev` links to the known roster applies.
/// A device that may have missed versions uses [`Chain::Skip`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chain {
    Linked,
    Skip,
}

/// Verifies `blob` as valid after `known` (section 3.2), or as the genesis
/// roster when `known` is `None`.
pub fn verify(blob: &str, account_id: &str, known: Option<&Roster>, chain: Chain) -> Result<Roster> {
    let r = parse(blob)?;
    let fail = |rule| Err(Error::Roster(rule));
    if r.body.account_id != account_id {
        return fail(Rule::Account);
    }
    if !devices_valid(&r.body) {
        return fail(Rule::Devices);
    }
    let Some(k) = known else {
        let only = &r.body.devices[0];
        if r.body.prev.is_some() || r.body.version != 1 || r.body.devices.len() != 1 || !only.signer || r.by != only.id {
            return fail(Rule::Genesis);
        }
        if !signature_valid(&r, &only.sign) {
            return fail(Rule::Signature);
        }
        return Ok(r);
    };
    if r.body.version <= k.body.version {
        return fail(Rule::Version);
    }
    if r.body.recovery_pub != k.body.recovery_pub {
        return fail(Rule::RecoveryPub);
    }
    if chain == Chain::Linked && r.body.prev.as_deref() != Some(k.hash.as_str()) {
        return fail(Rule::Prev);
    }
    for d in &r.body.devices {
        if let Some(before) = k.body.device(&d.id) {
            if before.r#box != d.r#box || before.sign != d.sign {
                return fail(Rule::Keys);
            }
        }
    }
    let key = if r.by == RECOVERY { Some(k.body.recovery_pub.as_str()) } else { k.body.signer(&r.by).map(|d| d.sign.as_str()) };
    let Some(key) = key else {
        return fail(Rule::UntrustedSigner);
    };
    if !signature_valid(&r, key) {
        return fail(Rule::Signature);
    }
    Ok(r)
}

/// Accepts the roster head a joining device fetches before it has any `K`
/// (spec section 4.2, step 3). It must be well formed, for this account,
/// and signed by a signer it lists or its own recovery key. This is trust
/// on first use: the 6-digit code covers the signer's keys from this
/// roster, so a substituted head fails the comparison.
pub fn trust_head(blob: &str, account_id: &str) -> Result<Roster> {
    let r = parse(blob)?;
    if r.body.account_id != account_id {
        return Err(Error::Roster(Rule::Account));
    }
    if !devices_valid(&r.body) {
        return Err(Error::Roster(Rule::Devices));
    }
    let key = if r.by == RECOVERY { Some(r.body.recovery_pub.as_str()) } else { r.body.signer(&r.by).map(|d| d.sign.as_str()) };
    let Some(key) = key else {
        return Err(Error::Roster(Rule::UntrustedSigner));
    };
    if !signature_valid(&r, key) {
        return Err(Error::Roster(Rule::Signature));
    }
    Ok(r)
}

/// The first roster of a device that joined by invitation (spec section
/// 4.3, step 4). The caller has already checked the signer's `confirm`
/// over this roster's version and envelope, which is what authenticates it.
/// Here: well formed, for this account, signed by a signer it lists (not
/// the recovery key), and listing `me` with exactly its own keys.
pub fn verify_first(blob: &str, account_id: &str, me: &Device) -> Result<Roster> {
    let r = trust_head(blob, account_id)?;
    if r.by == RECOVERY {
        return Err(Error::Roster(Rule::UntrustedSigner));
    }
    match r.body.device(&me.id) {
        Some(d) if d.auth == me.auth && d.r#box == me.r#box && d.sign == me.sign => Ok(r),
        _ => Err(Error::Roster(Rule::Keys)),
    }
}

/// What changed between two verified rosters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Change {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

pub fn diff(before: &Body, after: &Body) -> Change {
    Change {
        added: after.devices.iter().filter(|d| before.device(&d.id).is_none()).map(|d| d.id.clone()).collect(),
        removed: before.devices.iter().filter(|d| after.device(&d.id).is_none()).map(|d| d.id.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{DeviceKeys, Seed};

    fn device(n: u8) -> DeviceKeys {
        DeviceKeys::from_seeds(Seed::from_bytes([n; 32]), Seed::from_bytes([n + 1; 32]), Seed::from_bytes([n + 2; 32]))
    }

    #[test]
    fn genesis_then_add_then_remove() {
        let phone = device(10);
        let server = device(20);
        let recovery = Ed25519::from_seed(Seed::from_bytes([99; 32]));
        let g = sign(&Body::genesis("acct-aaaaaaaaaaaaaaaa", &recovery.public(), Device::of(&phone, true)), &phone.id(), &phone.sign);
        let g = verify(&g.blob, "acct-aaaaaaaaaaaaaaaa", None, Chain::Linked).unwrap();
        let add = sign(&g.next_body(vec![Device::of(&phone, true), Device::of(&server, false)]), &phone.id(), &phone.sign);
        let add = verify(&add.blob, "acct-aaaaaaaaaaaaaaaa", Some(&g), Chain::Linked).unwrap();
        assert_eq!(diff(&g.body, &add.body).added, vec![server.id()]);
        // The member cannot sign the next roster.
        let bad = sign(&add.next_body(vec![Device::of(&server, true)]), &server.id(), &server.sign);
        assert_eq!(verify(&bad.blob, "acct-aaaaaaaaaaaaaaaa", Some(&add), Chain::Linked), Err(Error::Roster(Rule::UntrustedSigner)));
        let rm = sign(&add.next_body(vec![Device::of(&phone, true)]), &phone.id(), &phone.sign);
        let rm = verify(&rm.blob, "acct-aaaaaaaaaaaaaaaa", Some(&add), Chain::Linked).unwrap();
        assert_eq!(diff(&add.body, &rm.body).removed, vec![server.id()]);
    }
}
