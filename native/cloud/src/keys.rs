//! Device keys (spec section 2): `auth` and `sign` are Ed25519, `box` is
//! X25519. Private keys are 32-byte seeds, wiped on drop and never printed.

use std::fmt;

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::encoding::{b64, from_b64};
use crate::{Error, Result};

/// A 32-byte private seed. `Debug` never shows it.
#[derive(Clone, Zeroize, ZeroizeOnDrop, PartialEq, Eq)]
pub struct Seed([u8; 32]);

impl Seed {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Seed(bytes)
    }

    pub fn from_b64(text: &str) -> Result<Self> {
        let bytes = Zeroizing::new(from_b64(text)?);
        let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| Error::Key)?;
        Ok(Seed(arr))
    }

    /// A fresh seed from the operating system's random source.
    pub fn random() -> Self {
        Seed(random_bytes())
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }

    /// base64url of the seed, for the platform key store only.
    pub fn expose_b64(&self) -> Zeroizing<String> {
        Zeroizing::new(b64(&self.0))
    }
}

impl fmt::Debug for Seed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Seed([redacted])")
    }
}

/// `N` random bytes from the operating system.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).expect("the operating system's random source failed");
    out
}

/// An Ed25519 key pair (`auth`, `sign`, or the recovery key).
#[derive(Clone)]
pub struct Ed25519 {
    seed: Seed,
    key: SigningKey,
}

impl Ed25519 {
    pub fn from_seed(seed: Seed) -> Self {
        let key = SigningKey::from_bytes(seed.expose());
        Ed25519 { seed, key }
    }

    pub fn public(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.key.sign(message).to_bytes()
    }

    pub fn seed(&self) -> &Seed {
        &self.seed
    }
}

impl fmt::Debug for Ed25519 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ed25519(pub {})", b64(&self.public()))
    }
}

/// Checks an Ed25519 signature strictly: no small-order keys, no
/// non-canonical encodings, no malleable signatures.
pub fn verify(public: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(public) else {
        return false;
    };
    if key.is_weak() {
        return false;
    }
    let sig = ed25519_dalek::Signature::from_bytes(signature);
    key.verify_strict(message, &sig).is_ok()
}

/// An X25519 key pair (`box`, or an ephemeral key).
#[derive(Clone)]
pub struct X25519 {
    seed: Seed,
    secret: x25519_dalek::StaticSecret,
}

impl X25519 {
    pub fn from_seed(seed: Seed) -> Self {
        let secret = x25519_dalek::StaticSecret::from(*seed.expose());
        X25519 { seed, secret }
    }

    pub fn public(&self) -> [u8; 32] {
        x25519_dalek::PublicKey::from(&self.secret).to_bytes()
    }

    /// The shared secret with `other`. A low-order public key (whose
    /// exchange gives all zeros, whatever our key) is refused.
    pub fn exchange(&self, other: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
        let shared = self.secret.diffie_hellman(&x25519_dalek::PublicKey::from(*other));
        if !shared.was_contributory() {
            return Err(Error::Key);
        }
        Ok(Zeroizing::new(shared.to_bytes()))
    }

    pub fn seed(&self) -> &Seed {
        &self.seed
    }
}

impl fmt::Debug for X25519 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "X25519(pub {})", b64(&self.public()))
    }
}

/// Whether an X25519 public key is one of the low-order points.
pub fn is_low_order(public: &[u8; 32]) -> bool {
    // Any clamped scalar is a multiple of 8, so a low-order point always
    // gives the all-zero output; no other point does.
    let probe = x25519_dalek::StaticSecret::from([9u8; 32]);
    !probe.diffie_hellman(&x25519_dalek::PublicKey::from(*public)).was_contributory()
}

/// `device_id = b64(SHA-256("agentd-device-id-v1" || auth_pub)[0..16])`.
pub fn device_id(auth_pub: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(b"agentd-device-id-v1");
    h.update(auth_pub);
    b64(&h.finalize()[..16])
}

/// Whether `id` has the shape of a device id: base64url of 16 bytes.
pub fn is_device_id(id: &str) -> bool {
    id.len() == 22 && from_b64(id).is_ok_and(|raw| raw.len() == 16)
}

/// The first 8 bytes of the raw device id, uppercase hex in groups of 4
/// (`3F9A 21C4 7B0E 55D2`). `None` when `id` is not a device id.
pub fn fingerprint(id: &str) -> Option<String> {
    let raw = from_b64(id).ok()?;
    if raw.len() != 16 {
        return None;
    }
    let hex: String = raw[..8].iter().map(|b| format!("{b:02X}")).collect();
    Some(format!("{} {} {} {}", &hex[0..4], &hex[4..8], &hex[8..12], &hex[12..16]))
}

/// The three key pairs a device makes when it is set up.
#[derive(Clone)]
pub struct DeviceKeys {
    pub auth: Ed25519,
    pub r#box: X25519,
    pub sign: Ed25519,
}

impl fmt::Debug for DeviceKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceKeys({})", self.id())
    }
}

impl DeviceKeys {
    pub fn generate() -> Self {
        Self::from_seeds(Seed::random(), Seed::random(), Seed::random())
    }

    pub fn from_seeds(auth: Seed, r#box: Seed, sign: Seed) -> Self {
        DeviceKeys { auth: Ed25519::from_seed(auth), r#box: X25519::from_seed(r#box), sign: Ed25519::from_seed(sign) }
    }

    pub fn id(&self) -> String {
        device_id(&self.auth.public())
    }

    pub fn fingerprint(&self) -> String {
        fingerprint(&self.id()).expect("a derived device id")
    }

    /// The `pubs` bytes (spec section 2.1).
    pub fn pubs(&self) -> Vec<u8> {
        pubs_bytes(&self.r#box.public(), &self.sign.public())
    }
}

/// `{"v":1,"box":"…","sign":"…"}`, exactly as the reference writes it.
pub fn pubs_bytes(box_pub: &[u8; 32], sign_pub: &[u8; 32]) -> Vec<u8> {
    format!(r#"{{"v":1,"box":"{}","sign":"{}"}}"#, b64(box_pub), b64(sign_pub)).into_bytes()
}

/// The public keys in a `pubs` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pubs {
    pub r#box: [u8; 32],
    pub sign: [u8; 32],
}

/// Parses `pubs` bytes: exactly `v`, `box` and `sign`, with `v` 1.
pub fn parse_pubs(bytes: &[u8]) -> Result<Pubs> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| Error::Key)?;
    let obj = value.as_object().ok_or(Error::Key)?;
    if obj.len() != 3 || obj.get("v").and_then(|v| v.as_u64()) != Some(1) {
        return Err(Error::Key);
    }
    let key = |name: &str| -> Result<[u8; 32]> { crate::encoding::from_b64_array(obj.get(name).and_then(|v| v.as_str()).ok_or(Error::Key)?) };
    Ok(Pubs { r#box: key("box")?, sign: key("sign")? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_never_print() {
        let seed = Seed::from_bytes([7u8; 32]);
        let shown = format!("{seed:?} {:?} {:?}", Ed25519::from_seed(seed.clone()), X25519::from_seed(seed.clone()));
        assert!(!shown.contains(&b64(&[7u8; 32])));
        assert!(shown.contains("redacted"));
    }

    #[test]
    fn low_order_points_are_refused() {
        let zero = [0u8; 32];
        let mut one = [0u8; 32];
        one[0] = 1;
        assert!(is_low_order(&zero) && is_low_order(&one));
        let k = X25519::from_seed(Seed::from_bytes([3u8; 32]));
        assert!(k.exchange(&zero).is_err());
        assert!(!is_low_order(&X25519::from_seed(Seed::from_bytes([5u8; 32])).public()));
    }

    #[test]
    fn pubs_round_trip_and_reject_extras() {
        let keys = DeviceKeys::from_seeds(Seed::from_bytes([1; 32]), Seed::from_bytes([2; 32]), Seed::from_bytes([3; 32]));
        let parsed = parse_pubs(&keys.pubs()).unwrap();
        assert_eq!(parsed.r#box, keys.r#box.public());
        assert!(parse_pubs(br#"{"v":1,"box":"AA","sign":"AA","x":1}"#).is_err());
    }
}
