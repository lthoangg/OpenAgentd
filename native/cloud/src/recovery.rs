//! The recovery code (spec section 2): the recovery key's 32-byte seed in
//! RFC 4648 base32, uppercase and unpadded, as 13 groups of 4 joined by `-`.

use data_encoding::BASE32_NOPAD;
use zeroize::Zeroizing;

use crate::keys::Seed;
use crate::{Error, Result};

/// Characters in a recovery code, without dashes.
pub const CODE_LEN: usize = 52;
/// Groups of 4 characters.
pub const GROUPS: usize = 13;

/// The code for `seed`, for showing once.
pub fn encode(seed: &Seed) -> Zeroizing<String> {
    let plain = Zeroizing::new(BASE32_NOPAD.encode(seed.expose()));
    let mut out = Zeroizing::new(String::with_capacity(CODE_LEN + GROUPS - 1));
    for (i, ch) in plain.chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        out.push(ch);
    }
    out
}

/// The seed a typed code names. Case, spaces and dashes are ignored.
pub fn decode(code: &str) -> Result<Seed> {
    let clean: Zeroizing<String> = Zeroizing::new(code.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_ascii_uppercase()).collect());
    if clean.len() != CODE_LEN {
        return Err(Error::RecoveryCode);
    }
    let bytes = Zeroizing::new(BASE32_NOPAD.decode(clean.as_bytes()).map_err(|_| Error::RecoveryCode)?);
    let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| Error::RecoveryCode)?;
    Ok(Seed::from_bytes(arr))
}

/// Group `n` (1-based) of a code, for the "type group 3 and group 9" check.
pub fn group(code: &str, n: usize) -> Option<&str> {
    code.split('-').nth(n.checked_sub(1)?)
}

/// Whether `typed` matches group `n` of `code` (case and spaces ignored).
pub fn group_matches(code: &str, n: usize, typed: &str) -> bool {
    let typed: String = typed.chars().filter(|c| !c.is_whitespace()).map(|c| c.to_ascii_uppercase()).collect();
    group(code, n).is_some_and(|g| g == typed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_ignores_case_and_separators() {
        let seed = Seed::from_bytes([0xA5; 32]);
        let code = encode(&seed);
        assert_eq!(code.split('-').count(), GROUPS);
        let messy = code.to_lowercase().replace('-', " ");
        assert_eq!(decode(&messy).unwrap(), seed);
        assert!(decode("ABCD").is_err());
        assert!(group_matches(&code, 2, &code[5..9].to_lowercase()));
        assert!(!group_matches(&code, 14, "AAAA"));
    }
}
