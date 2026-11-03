//! `slugify` (byte-for-byte with the frontend).

/// `slugify`.
pub fn slugify(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let stripped: String = text.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect();
    let lower = stripped.to_lowercase();
    use std::sync::LazyLock;
    static RE1: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"[^a-z0-9._-]").unwrap());
    static RE2: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"-+").unwrap());
    static RE3: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[._-]+|[._-]+$").unwrap());
    let s = RE1.replace_all(&lower, "-");
    let s = RE2.replace_all(&s, "-");
    let mut s = RE3.replace_all(&s, "").to_string();
    if !s.is_empty() && !s.chars().next().map(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).unwrap_or(false) {
        s = s.trim_start_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).to_string();
    }
    s.chars().take(64).collect()
}
