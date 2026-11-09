//! Encodings of the spec's section 1: unpadded base64url and `lines(...)`.

use data_encoding::BASE64URL_NOPAD;

use crate::{Error, Result};

/// `b64(x)`: RFC 4648 section 5, no padding.
pub fn b64(bytes: &[u8]) -> String {
    BASE64URL_NOPAD.encode(bytes)
}

/// Decodes unpadded base64url, refusing padding, other alphabets and
/// non-canonical trailing bits, so every value has exactly one spelling.
pub fn from_b64(text: &str) -> Result<Vec<u8>> {
    BASE64URL_NOPAD.decode(text.as_bytes()).map_err(|_| Error::Encoding)
}

/// Decodes base64url that must be exactly `N` bytes.
pub fn from_b64_array<const N: usize>(text: &str) -> Result<[u8; N]> {
    from_b64(text)?.try_into().map_err(|_| Error::Encoding)
}

/// One argument of `lines(...)`.
pub enum Line<'a> {
    Str(&'a str),
    Int(u64),
}

impl<'a> From<&'a str> for Line<'a> {
    fn from(s: &'a str) -> Self {
        Line::Str(s)
    }
}

impl<'a> From<&'a String> for Line<'a> {
    fn from(s: &'a String) -> Self {
        Line::Str(s)
    }
}

impl From<u64> for Line<'_> {
    fn from(n: u64) -> Self {
        Line::Int(n)
    }
}

/// The UTF-8 bytes of the arguments joined with `\n`, no trailing newline.
/// An argument holding `\n` would make two messages collide, so it panics:
/// callers pass only labels, ids, integers and base64url, which never do.
pub fn lines<'a>(parts: impl IntoIterator<Item = Line<'a>>) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            out.push(b'\n');
        }
        match part {
            Line::Str(s) => {
                assert!(!s.contains('\n'), "a lines() argument contains a newline");
                out.extend_from_slice(s.as_bytes());
            }
            Line::Int(n) => out.extend_from_slice(n.to_string().as_bytes()),
        }
    }
    out
}

/// `lines(...)` with mixed arguments: `lines![ "label", id, 5u64 ]`.
#[macro_export]
macro_rules! lines {
    ($($part:expr),+ $(,)?) => {
        $crate::encoding::lines([$($crate::encoding::Line::from($part)),+])
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_is_strict() {
        assert_eq!(b64(&[0xfb, 0xff]), "-_8");
        assert_eq!(from_b64("-_8").unwrap(), vec![0xfb, 0xff]);
        assert!(from_b64("-_8=").is_err(), "padding");
        assert!(from_b64("+/8").is_err(), "standard alphabet");
        assert!(from_b64("-_9").is_err(), "non-canonical trailing bits");
        assert!(from_b64("A").is_err(), "impossible length");
        assert_eq!(from_b64("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn lines_joins_without_trailing_newline() {
        assert_eq!(lines!["a", "b", 12u64], b"a\nb\n12".to_vec());
    }

    #[test]
    #[should_panic]
    fn lines_refuses_newlines() {
        lines!["a\nb"];
    }
}
