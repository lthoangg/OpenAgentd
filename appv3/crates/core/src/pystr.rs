//! Python string renderings that more than one crate writes into messages:
//! `repr(str)`, `f"{n:,}"`, and `urllib.parse.unquote_plus`.

/// Python `repr(str)`: single-quoted unless the string has a `'` and no `"`.
pub fn py_repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// Python `f"{n:,}"`: `62426` → `62,426`.
pub fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Python `urllib.parse.unquote_plus`: `+` is a space, `%XX` a byte, and a
/// `%` without two hex digits stays as it is.
pub fn unquote_plus(s: &str) -> String {
    let s = s.replace('+', " ");
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hexv = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hexv(bytes[i + 1]), hexv(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repr_picks_the_quote_python_picks() {
        assert_eq!(py_repr_str("plain"), "'plain'");
        assert_eq!(py_repr_str("it's"), "\"it's\"");
        assert_eq!(py_repr_str("say \"hi\""), "'say \"hi\"'");
        assert_eq!(py_repr_str("it's \"both\""), "'it\\'s \"both\"'");
        assert_eq!(py_repr_str("a\\b\n\t\r\u{1}\u{7f}é"), "'a\\\\b\\n\\t\\r\\x01\\x7fé'");
    }

    #[test]
    fn thousands_groups_by_three() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(62426), "62,426");
        assert_eq!(thousands(1_000_000), "1,000,000");
        assert_eq!(thousands(1234567), "1,234,567");
    }

    #[test]
    fn unquote_plus_decodes_what_it_can() {
        assert_eq!(unquote_plus("a+b%20c"), "a b c");
        assert_eq!(unquote_plus("caf%C3%A9"), "café");
        assert_eq!(unquote_plus("100%"), "100%");
        assert_eq!(unquote_plus("%zz%4"), "%zz%4");
        assert_eq!(unquote_plus("x%41"), "xA");
        assert_eq!(unquote_plus("%41x"), "Ax");
    }
}
