//! Streamable HTTP sessions kept across restarts.
//!
//! A server may keep state for a session (what an MCP app drew on a canvas,
//! for one). A session ended with every restart of this process loses that
//! state, so the session a server gave is written down when it opens and the
//! next process goes on with it; the server answers 404 once it has dropped
//! the session, and a new one is opened then. The file holds session ids, so
//! it is readable by the owner alone.

use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

/// What a later client needs to go on with a session.
#[derive(Clone, Debug, PartialEq)]
pub struct Saved {
    /// The server the session is with: a server moved to another URL starts over.
    pub url: String,
    pub session_id: String,
    /// The protocol version the session was opened under.
    pub protocol: String,
}

/// Sessions by server name, in one file.
#[derive(Default)]
pub struct SessionStore {
    /// `None`: `mcp-sessions.json` in the state directory.
    file: Option<PathBuf>,
    one_at_a_time: Mutex<()>,
}

impl SessionStore {
    pub fn at(file: PathBuf) -> Self {
        SessionStore { file: Some(file), one_at_a_time: Mutex::default() }
    }

    fn file(&self) -> PathBuf {
        self.file.clone().unwrap_or_else(|| appv3_core::settings::settings().state_dir.join("mcp-sessions.json"))
    }

    fn read(&self) -> Map<String, Value> {
        std::fs::read(self.file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn write(&self, all: &Map<String, Value>) {
        let file = self.file();
        let done = if all.is_empty() {
            match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            }
        } else {
            appv3_core::secret_files::write_secret_file(&file, &Value::Object(all.clone()).to_string())
        };
        if let Err(e) = done {
            tracing::warn!("mcp_sessions_save_failed path={} error={}", file.display(), e);
        }
    }

    /// The session kept for `name`, if it is with the server at `url`.
    pub fn get(&self, name: &str, url: &str) -> Option<Saved> {
        let _g = self.one_at_a_time.lock().unwrap();
        let all = self.read();
        let entry = all.get(name)?;
        let text = |key: &str| entry.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
        let saved = Saved { url: text("url")?, session_id: text("session_id")?, protocol: text("protocol")? };
        (saved.url == url).then_some(saved)
    }

    pub fn put(&self, name: &str, saved: &Saved) {
        let _g = self.one_at_a_time.lock().unwrap();
        let mut all = self.read();
        all.insert(name.into(), json!({"url": saved.url, "session_id": saved.session_id, "protocol": saved.protocol}));
        self.write(&all);
    }

    /// Nothing is written when there was no session for `name`.
    pub fn forget(&self, name: &str) {
        let _g = self.one_at_a_time.lock().unwrap();
        let mut all = self.read();
        if all.remove(name).is_some() {
            self.write(&all);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_is_kept_for_its_server_at_its_url() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state").join("mcp-sessions.json");
        let store = SessionStore::at(file.clone());
        assert_eq!(store.get("canvas", "https://a.example/mcp"), None);
        store.forget("canvas");
        assert!(!file.exists(), "nothing to forget, nothing written");

        let saved = Saved { url: "https://a.example/mcp".into(), session_id: "s-1".into(), protocol: "2025-06-18".into() };
        store.put("canvas", &saved);
        store.put("docs", &Saved { session_id: "s-2".into(), ..saved.clone() });
        // A later process reads the same file.
        let later = SessionStore::at(file.clone());
        assert_eq!(later.get("canvas", "https://a.example/mcp"), Some(saved));
        assert_eq!(later.get("canvas", "https://b.example/mcp"), None, "the server moved");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }

        later.forget("canvas");
        assert_eq!(store.get("canvas", "https://a.example/mcp"), None);
        assert_eq!(store.get("docs", "https://a.example/mcp").unwrap().session_id, "s-2");
        later.forget("docs");
        assert!(!file.exists(), "no sessions, no file");
    }
}
