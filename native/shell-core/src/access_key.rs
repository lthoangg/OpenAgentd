//! Backend access keys, keyed by canonical origin.
//!
//! The desktop shell keeps them in a user-only JSON file
//! ([`use_file_store`]); the mobile shell keeps them in the OS credential
//! store (`keyring` feature). macOS ties a login-keychain item to the Team
//! ID of the app that created it, or to the build's cdhash when there is
//! none: an ad hoc signed desktop app read its own items only until the next
//! update, then asked for keychain access again. The file has the format the
//! desktop used in July 2026 (`{"<origin>": "<key>"}`), so a leftover file
//! from then is read as is.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[cfg(feature = "keyring")]
const ACCESS_KEY_SERVICE: &str = "openagentd.backend-access-key";

const STORE_UNAVAILABLE: &str = "credential store unavailable";

static FILE_STORE: OnceLock<PathBuf> = OnceLock::new();
/// Serialises read-modify-write of the file within this process.
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// Keep access keys in the JSON file at `path` instead of the OS credential
/// store. Set once at startup; later calls are ignored.
pub fn use_file_store(path: PathBuf) {
    let _ = FILE_STORE.set(path);
}

/// The canonical origin (`scheme://host[:port]`) of an `http(s)` URL, so
/// `https://example.com/api` and `https://example.com/` share one key.
pub fn canonical_origin(origin: &str) -> Result<String, String> {
    let parsed = url::Url::parse(origin).map_err(|_| "invalid backend origin".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("invalid backend origin".to_string());
    }
    Ok(parsed.origin().ascii_serialization())
}

pub fn get_access_key(origin: &str) -> Result<Option<String>, String> {
    let origin = canonical_origin(origin)?;
    if let Some(path) = FILE_STORE.get() {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| STORE_UNAVAILABLE.to_string())?;
        return Ok(read_keys(path)?.remove(&origin));
    }
    keyring_store::get(&origin)
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
    let origin = canonical_origin(origin)?;
    if let Some(path) = FILE_STORE.get() {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| STORE_UNAVAILABLE.to_string())?;
        let mut keys = read_keys(path)?;
        keys.insert(origin, trimmed.to_string());
        return write_keys(path, &keys);
    }
    keyring_store::set(&origin, trimmed)
}

pub fn delete_access_key(origin: &str) -> Result<(), String> {
    let origin = canonical_origin(origin)?;
    if let Some(path) = FILE_STORE.get() {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| STORE_UNAVAILABLE.to_string())?;
        let mut keys = read_keys(path)?;
        if keys.remove(&origin).is_some() {
            write_keys(path, &keys)?;
        }
        return Ok(());
    }
    keyring_store::delete(&origin)
}

/// A missing file holds no keys; an unreadable or corrupt one is an error,
/// so a write never replaces keys it could not read.
fn read_keys(path: &Path) -> Result<BTreeMap<String, String>, String> {
    match crate::private_file::read(path) {
        Ok(None) => Ok(BTreeMap::new()),
        Ok(Some(bytes)) => {
            serde_json::from_slice(&bytes).map_err(|_| STORE_UNAVAILABLE.to_string())
        }
        Err(_) => Err(STORE_UNAVAILABLE.to_string()),
    }
}

fn write_keys(path: &Path, keys: &BTreeMap<String, String>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(keys).map_err(|_| STORE_UNAVAILABLE.to_string())?;
    crate::private_file::write(path, &bytes).map_err(|_| STORE_UNAVAILABLE.to_string())
}

#[cfg(feature = "keyring")]
mod keyring_store {
    use super::{ACCESS_KEY_SERVICE, STORE_UNAVAILABLE};

    fn entry(origin: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(ACCESS_KEY_SERVICE, origin).map_err(|_| STORE_UNAVAILABLE.to_string())
    }

    pub fn get(origin: &str) -> Result<Option<String>, String> {
        match entry(origin)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(STORE_UNAVAILABLE.to_string()),
        }
    }

    pub fn set(origin: &str, key: &str) -> Result<(), String> {
        entry(origin)?
            .set_password(key)
            .map_err(|_| STORE_UNAVAILABLE.to_string())
    }

    pub fn delete(origin: &str) -> Result<(), String> {
        match entry(origin)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(STORE_UNAVAILABLE.to_string()),
        }
    }
}

/// Without the `keyring` feature the file store is the only store.
#[cfg(not(feature = "keyring"))]
mod keyring_store {
    use super::STORE_UNAVAILABLE;

    pub fn get(_origin: &str) -> Result<Option<String>, String> {
        Err(STORE_UNAVAILABLE.to_string())
    }

    pub fn set(_origin: &str, _key: &str) -> Result<(), String> {
        Err(STORE_UNAVAILABLE.to_string())
    }

    pub fn delete(_origin: &str) -> Result<(), String> {
        Err(STORE_UNAVAILABLE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_key_origin_must_be_a_canonical_http_origin() {
        assert_eq!(
            canonical_origin("https://example.com").as_deref(),
            Ok("https://example.com")
        );
        assert_eq!(
            canonical_origin("https://example.com/api").as_deref(),
            Ok("https://example.com")
        );
        assert_eq!(
            canonical_origin("https://example.com/").as_deref(),
            Ok("https://example.com")
        );
        assert!(canonical_origin("ftp://example.com").is_err());
        assert!(canonical_origin("not a url").is_err());
    }

    #[test]
    fn blank_access_keys_are_rejected_before_touching_the_store() {
        assert_eq!(
            set_access_key("https://example.com", "   \n"),
            Err("access key is required".to_string())
        );
    }

    #[test]
    fn the_file_store_keeps_trimmed_keys_by_canonical_origin() {
        // The only test that sets the process-wide store.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("access-keys.json");
        use_file_store(path.clone());

        assert_eq!(
            get_access_key("https://a.example"),
            Ok(None),
            "a missing file holds no keys"
        );
        set_access_key("https://a.example/api", " key-a\n").unwrap();
        set_access_key("http://10.0.0.2:4082", "key-b").unwrap();
        assert_eq!(
            get_access_key("https://a.example/"),
            Ok(Some("key-a".to_string()))
        );

        // The July 2026 file format: one flat map of origin to key.
        let on_disk: BTreeMap<String, String> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            on_disk.get("https://a.example").map(String::as_str),
            Some("key-a")
        );
        assert_eq!(
            on_disk.get("http://10.0.0.2:4082").map(String::as_str),
            Some("key-b")
        );

        delete_access_key("https://a.example").unwrap();
        assert_eq!(get_access_key("https://a.example"), Ok(None));
        assert_eq!(
            get_access_key("http://10.0.0.2:4082"),
            Ok(Some("key-b".to_string()))
        );

        // A corrupt file is an error, and a write does not replace it.
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(
            get_access_key("http://10.0.0.2:4082"),
            Err(STORE_UNAVAILABLE.to_string())
        );
        assert!(set_access_key("https://c.example", "key-c").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
    }
}
