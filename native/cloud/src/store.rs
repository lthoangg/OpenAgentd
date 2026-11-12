//! Where a device keeps its account: its keys and its last verified roster.
//!
//! The keys are secret. Each platform supplies a [`SecretStore`]: the
//! Keychain on iOS (`mobile/src-tauri/src/cloud.rs`), and otherwise
//! [`FileStore`], a file only the user can read (`appv3/contract/tunnel-threats.md`,
//! "Storage"). Nothing here ever goes to settings, SQLite, logs or telemetry.

use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::account_state::AccountProblem;
use crate::keys::{DeviceKeys, Seed};

/// A device's account, as stored.
#[derive(Clone, Serialize, Deserialize)]
pub struct Identity {
    pub v: u8,
    pub auth: String,
    #[serde(rename = "box")]
    pub r#box: String,
    pub sign: String,
    pub account_id: Option<String>,
    /// The last roster this device verified (its `K`), as the API's blob.
    pub roster: Option<String>,
    /// The account problem last seen, so it survives a restart.
    #[serde(default)]
    pub problem: Option<AccountProblem>,
    /// Devices the cloud said were removed or left while the roster still
    /// lists them (spec section 3.3). Not secret; kept with `K`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub departed: Vec<String>,
    /// When this host last heard from the cloud (Unix ms): a verified
    /// roster fetch and the device list (spec section 5.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_contact: Option<u64>,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Identity(account {:?}, keys [redacted])", self.account_id.as_ref().map(|_| "set"))
    }
}

impl Drop for Identity {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.auth.zeroize();
        self.r#box.zeroize();
        self.sign.zeroize();
    }
}

impl Identity {
    pub fn new(keys: &DeviceKeys) -> Self {
        Identity {
            v: 1,
            auth: keys.auth.seed().expose_b64().to_string(),
            r#box: keys.r#box.seed().expose_b64().to_string(),
            sign: keys.sign.seed().expose_b64().to_string(),
            account_id: None,
            roster: None,
            problem: None,
            departed: Vec::new(),
            last_contact: None,
        }
    }

    pub fn keys(&self) -> io::Result<DeviceKeys> {
        let bad = |_| io::Error::new(io::ErrorKind::InvalidData, "stored device keys are unreadable");
        if self.sign.is_empty() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the signing key is locked"));
        }
        Ok(DeviceKeys::from_seeds(Seed::from_b64(&self.auth).map_err(bad)?, Seed::from_b64(&self.r#box).map_err(bad)?, Seed::from_b64(&self.sign).map_err(bad)?))
    }

    /// The keys for everything but roster writes. Where the signing key is
    /// kept apart (the phone keeps it behind Face ID or the passcode, see
    /// [`Identity::split_sign`]) it is replaced by a random key that signs
    /// nothing anyone accepts: `Member::write` verifies its own roster
    /// before sending it, so a write without the real key fails locally.
    pub fn keys_without_sign(&self) -> io::Result<DeviceKeys> {
        if !self.sign.is_empty() {
            return self.keys();
        }
        let bad = |_| io::Error::new(io::ErrorKind::InvalidData, "stored device keys are unreadable");
        Ok(DeviceKeys::from_seeds(Seed::from_b64(&self.auth).map_err(bad)?, Seed::from_b64(&self.r#box).map_err(bad)?, Seed::random()))
    }

    /// Moves the signing seed out of this identity, for a store that keeps
    /// it under stricter access control. `sign` is empty afterwards.
    pub fn split_sign(&mut self) -> Zeroizing<String> {
        Zeroizing::new(std::mem::take(&mut self.sign))
    }

    /// The full keys, given a signing seed kept apart.
    pub fn keys_with_sign(&self, sign_seed: &str) -> io::Result<DeviceKeys> {
        let bad = |_| io::Error::new(io::ErrorKind::InvalidData, "stored device keys are unreadable");
        Ok(DeviceKeys::from_seeds(Seed::from_b64(&self.auth).map_err(bad)?, Seed::from_b64(&self.r#box).map_err(bad)?, Seed::from_b64(sign_seed).map_err(bad)?))
    }

    pub fn to_secret(&self) -> Zeroizing<String> {
        Zeroizing::new(serde_json::to_string(self).expect("an identity serializes"))
    }

    pub fn from_secret(text: &str) -> io::Result<Self> {
        serde_json::from_str(text).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "stored identity is unreadable"))
    }
}

/// One secret item, read and written whole.
pub trait SecretStore: Send + Sync {
    fn load(&self) -> io::Result<Option<Zeroizing<String>>>;
    fn save(&self, value: &str) -> io::Result<()>;
    fn clear(&self) -> io::Result<()>;
    /// Shown in status ("file", "keychain", "secret service").
    fn kind(&self) -> &'static str;
}

/// Loads the stored identity, if any.
pub fn load(store: &dyn SecretStore) -> io::Result<Option<Identity>> {
    match store.load()? {
        Some(text) => Identity::from_secret(&text).map(Some),
        None => Ok(None),
    }
}

pub fn save(store: &dyn SecretStore, identity: &Identity) -> io::Result<()> {
    store.save(&identity.to_secret())
}

/// A file only the user can read and write (mode 600 on Unix). Written by
/// replacing it atomically, so a crash never leaves half an identity.
/// Windows sets no ACL of its own: the file inherits its folder's, which
/// under the user's profile admits the user, SYSTEM and Administrators
/// (`appv3/contract/tunnel-threats.md`, Storage).
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        FileStore { path }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl SecretStore for FileStore {
    fn load(&self) -> io::Result<Option<Zeroizing<String>>> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => Ok(Some(Zeroizing::new(s))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn save(&self, value: &str) -> io::Result<()> {
        let dir = self.path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent directory"))?;
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let tmp = self.path.with_extension(format!("tmp-{}", std::process::id()));
        {
            use std::io::Write;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(value.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)
    }

    fn clear(&self) -> io::Result<()> {
        match std::fs::remove_file(&self.path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    fn kind(&self) -> &'static str {
        "file"
    }
}

/// An in-memory store, for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<Option<Zeroizing<String>>>);

impl SecretStore for MemoryStore {
    fn load(&self) -> io::Result<Option<Zeroizing<String>>> {
        Ok(self.0.lock().expect("store lock").clone())
    }
    fn save(&self, value: &str) -> io::Result<()> {
        *self.0.lock().expect("store lock") = Some(Zeroizing::new(value.to_string()));
        Ok(())
    }
    fn clear(&self) -> io::Result<()> {
        *self.0.lock().expect("store lock") = None;
        Ok(())
    }
    fn kind(&self) -> &'static str {
        "memory"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_is_user_only_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("oad-cloud-store-{}", std::process::id()));
        let store = FileStore::new(dir.join("cloud").join("identity.json"));
        let keys = DeviceKeys::generate();
        let mut id = Identity::new(&keys);
        id.account_id = Some("acct".into());
        save(&store, &id).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let back = load(&store).unwrap().unwrap();
        assert_eq!(back.keys().unwrap().id(), keys.id());
        assert!(!format!("{back:?}").contains(&back.auth));
        store.clear().unwrap();
        assert!(load(&store).unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_split_signing_key_is_needed_for_the_full_keys() {
        let keys = DeviceKeys::generate();
        let mut id = Identity::new(&keys);
        let seed = id.split_sign();
        assert!(id.sign.is_empty() && !id.to_secret().contains(seed.as_str()));
        assert_eq!(id.keys().unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        let without = id.keys_without_sign().unwrap();
        assert_eq!(without.id(), keys.id());
        assert_ne!(without.sign.public(), keys.sign.public());
        assert_eq!(id.keys_with_sign(&seed).unwrap().sign.public(), keys.sign.public());
    }
}
