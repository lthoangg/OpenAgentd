//! Backend access keys in the OS credential store, keyed by canonical origin.

const ACCESS_KEY_SERVICE: &str = "openagentd.backend-access-key";

/// Resolve the keyring entry for `origin`.
///
/// Only `http(s)` origins are accepted, and the key is the *canonical*
/// origin (`scheme://host[:port]`), so `https://example.com/api` and
/// `https://example.com/` share one credential.
pub fn access_key_entry(origin: &str) -> Result<keyring::Entry, String> {
    let parsed = url::Url::parse(origin).map_err(|_| "invalid backend origin".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("invalid backend origin".to_string());
    }
    let canonical = parsed.origin().ascii_serialization();
    keyring::Entry::new(ACCESS_KEY_SERVICE, &canonical)
        .map_err(|_| "credential store unavailable".to_string())
}

pub fn get_access_key(origin: &str) -> Result<Option<String>, String> {
    match access_key_entry(origin)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("credential store unavailable".to_string()),
    }
}

/// Store `key` for `origin`.
///
/// The value is trimmed before persisting. Validating `key.trim()` but
/// persisting `key` once meant a pasted key with a trailing newline
/// authenticated on desktop and failed on mobile — the drift bug this crate
/// exists to prevent.
pub fn set_access_key(origin: &str, key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("access key is required".to_string());
    }
    access_key_entry(origin)?
        .set_password(trimmed)
        .map_err(|_| "credential store unavailable".to_string())
}

pub fn delete_access_key(origin: &str) -> Result<(), String> {
    match access_key_entry(origin)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("credential store unavailable".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_key_origin_must_be_a_canonical_http_origin() {
        assert!(access_key_entry("https://example.com").is_ok());
        assert!(access_key_entry("https://example.com/api").is_ok());
        assert!(access_key_entry("https://example.com/").is_ok());
        assert!(access_key_entry("ftp://example.com").is_err());
        assert!(access_key_entry("not a url").is_err());
    }

    #[test]
    fn blank_access_keys_are_rejected_before_touching_the_store() {
        assert_eq!(
            set_access_key("https://example.com", "   \n"),
            Err("access key is required".to_string())
        );
    }
}
