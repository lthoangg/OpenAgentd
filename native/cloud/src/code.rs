//! Commit-reveal and the 6-digit code (spec section 4.2).

use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::encoding::b64;
use crate::keys::X25519;
use crate::{lines, Result};

/// `commit = SHA-256(lines("agentd-commit-v1", b64(pubs), b64(nN)))`.
pub fn commit(pubs: &[u8], n_n: &[u8]) -> [u8; 32] {
    Sha256::digest(lines!["agentd-commit-v1", &b64(pubs), &b64(n_n)]).into()
}

/// Whether a revealed `n_n` opens `commit` (constant time).
pub fn commit_matches(commit_value: &[u8], pubs: &[u8], n_n: &[u8]) -> bool {
    commit_value.ct_eq(&commit(pubs, n_n)).into()
}

/// The signer `A`, as its roster entry lists it.
pub struct Signer<'a> {
    pub id: &'a str,
    pub r#box: [u8; 32],
    pub sign: [u8; 32],
}

/// The new device `N`: its id, `pubs` bytes, and the box key in them.
pub struct Joiner<'a> {
    pub id: &'a str,
    pub pubs: &'a [u8],
    pub r#box: [u8; 32],
}

pub struct CodeInput<'a> {
    pub account_id: &'a str,
    pub enrollment_id: &'a str,
    pub a: Signer<'a>,
    pub n: Joiner<'a>,
    pub n_a: &'a [u8],
    pub n_n: &'a [u8],
}

/// The 6 digits as `own` computes them: A with its box key, N with its own.
pub fn six_digit_code(own: &X25519, input: &CodeInput<'_>) -> Result<String> {
    let other = if own.public() == input.a.r#box { input.n.r#box } else { input.a.r#box };
    let dh = own.exchange(&other)?;
    let info = lines![
        "agentd-code-v1",
        input.account_id,
        input.enrollment_id,
        input.a.id,
        &b64(&input.a.r#box),
        &b64(&input.a.sign),
        input.n.id,
        &b64(input.n.pubs),
        &b64(input.n_a),
        &b64(input.n_n),
    ];
    let mut okm = [0u8; 4];
    Hkdf::<Sha256>::new(Some(&[]), dh.as_ref()).expand(&info, &mut okm).expect("4 bytes is a valid HKDF length");
    Ok(format!("{:06}", u32::from_be_bytes(okm) % 1_000_000))
}

/// `123456` as people read it: `123 456`.
pub fn display(code: &str) -> String {
    if code.len() == 6 {
        format!("{} {}", &code[..3], &code[3..])
    } else {
        code.to_string()
    }
}
