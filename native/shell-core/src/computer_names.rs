//! The last name each computer gave for itself, kept beside the saved
//! servers so both shells show "Work" where they showed a key or an address.
//!
//! A server names its computer (`GET /api/server/name`: the host name, or
//! what the person called it). The app reads that over the connection it
//! already has and remembers it here, under the account device id of a
//! computer of the account or the normalised base URL of a saved server.
//! The account service never sees a name.
//!
//! A name is text a computer says about itself. It is kept as one short
//! line of plain text, cleaned again here whatever the server sent, and
//! nothing here or in the shells uses it to decide anything: a computer is
//! identified by its key or its address.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};

/// The longest name kept, in characters (the server's own limit).
pub const NAME_MAX_CHARS: usize = 40;
/// The longest key accepted: a device id or a base URL.
const KEY_MAX_CHARS: usize = 512;

static MUTATION: Mutex<()> = Mutex::new(());

/// Names by account device id or saved server base URL.
pub type ComputerNames = BTreeMap<String, String>;

/// Characters that change the direction of the text after them. A list
/// shows a key right after a name, and a name must not reorder it.
fn is_direction_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// One line of plain text: no control or text-direction characters, single
/// spaces, at most [`NAME_MAX_CHARS`]. `None` when nothing is left.
pub fn clean_computer_name(raw: &str) -> Option<String> {
    let raw: String = raw.chars().filter(|c| !is_direction_control(*c)).collect();
    let words: Vec<&str> = raw
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect();
    let name: String = words.join(" ").chars().take(NAME_MAX_CHARS).collect();
    let name = name.trim_end().to_string();
    (!name.is_empty()).then_some(name)
}

/// The remembered names; none when the file is missing or unreadable (the
/// lists then fall back to the key or the address).
pub fn load_computer_names_from(path: &Path) -> ComputerNames {
    let stored: ComputerNames = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    stored
        .into_iter()
        .filter_map(|(key, name)| Some((key, clean_computer_name(&name)?)))
        .collect()
}

/// Remember `name` for `key`, or forget it when the name cleans to nothing.
/// Returns the names as stored.
pub fn remember_computer_name_at(
    path: &Path,
    key: &str,
    name: Option<&str>,
) -> Result<ComputerNames> {
    let key = key.trim();
    if key.is_empty() || key.chars().count() > KEY_MAX_CHARS || key.chars().any(char::is_control) {
        return Err(anyhow!("not a computer"));
    }
    let _guard = MUTATION
        .lock()
        .map_err(|_| anyhow!("computer names lock poisoned"))?;
    let mut names = load_computer_names_from(path);
    match name.and_then(clean_computer_name) {
        Some(name) => names.insert(key.to_string(), name),
        None => names.remove(key),
    };
    let parent = path
        .parent()
        .context("computer names must have a parent directory")?;
    std::fs::create_dir_all(parent)?;
    // Written whole, then moved into place: a reader never sees half a file.
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&names).context("serialize computer names")?,
    )
    .and_then(|()| std::fs::rename(&temporary, path))
    .with_context(|| format!("write {}", path.display()))?;
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn a_name_is_one_short_line_of_plain_text() {
        assert_eq!(clean_computer_name("  Work  ").as_deref(), Some("Work"));
        assert_eq!(
            clean_computer_name("Work\n\tMac\u{7}mini").as_deref(),
            Some("Work Mac mini")
        );
        assert_eq!(
            clean_computer_name("\u{202e}evil\u{2066}").as_deref(),
            Some("evil"),
            "a name cannot reorder the key shown after it"
        );
        assert_eq!(
            clean_computer_name("مكتب").as_deref(),
            Some("مكتب"),
            "right-to-left text itself is a name"
        );
        assert_eq!(clean_computer_name(" \n "), None);
        assert_eq!(
            clean_computer_name(&"é".repeat(100))
                .unwrap()
                .chars()
                .count(),
            NAME_MAX_CHARS
        );
    }

    #[test]
    fn names_are_remembered_per_computer_and_survive_a_reload() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("computer-names.json");
        assert!(
            load_computer_names_from(&path).is_empty(),
            "nothing before the first connection"
        );

        remember_computer_name_at(&path, "dev-mac", Some("Work")).unwrap();
        let names =
            remember_computer_name_at(&path, "http://192.168.1.30:4082", Some("  Office\nNAS "))
                .unwrap();
        assert_eq!(names.get("dev-mac").map(String::as_str), Some("Work"));
        assert_eq!(
            names.get("http://192.168.1.30:4082").map(String::as_str),
            Some("Office NAS")
        );
        assert_eq!(load_computer_names_from(&path), names);

        // Renamed on the computer: the next connection replaces the name.
        let names = remember_computer_name_at(&path, "dev-mac", Some("Personal")).unwrap();
        assert_eq!(names.get("dev-mac").map(String::as_str), Some("Personal"));
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn an_empty_name_forgets_the_computer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("computer-names.json");
        remember_computer_name_at(&path, "dev-mac", Some("Work")).unwrap();
        assert!(remember_computer_name_at(&path, "dev-mac", Some(" \u{7} "))
            .unwrap()
            .is_empty());
        remember_computer_name_at(&path, "dev-mac", Some("Work")).unwrap();
        assert!(remember_computer_name_at(&path, "dev-mac", None)
            .unwrap()
            .is_empty());
        assert!(load_computer_names_from(&path).is_empty());
    }

    #[test]
    fn a_key_must_name_a_computer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("computer-names.json");
        assert!(remember_computer_name_at(&path, "  ", Some("Work")).is_err());
        assert!(remember_computer_name_at(&path, &"k".repeat(600), Some("Work")).is_err());
        assert!(remember_computer_name_at(&path, "dev\nmac", Some("Work")).is_err());
        assert!(!path.exists(), "nothing is written for a refused key");
    }

    #[test]
    fn an_unreadable_file_reads_as_no_names_and_is_replaced_by_the_next_one() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("computer-names.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(load_computer_names_from(&path).is_empty());
        std::fs::write(&path, br#"{"dev-mac": 7, "dev-nas": "NAS"}"#).unwrap();
        assert!(
            load_computer_names_from(&path).is_empty(),
            "a file of another shape is not half-read"
        );

        // Names are a cache of what the computers say: nothing is lost by starting over.
        let names = remember_computer_name_at(&path, "dev-mac", Some("Work")).unwrap();
        assert_eq!(names.len(), 1);
        assert_eq!(load_computer_names_from(&path), names);
    }

    #[test]
    fn names_read_from_disk_are_cleaned_again() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("computer-names.json");
        std::fs::write(
            &path,
            format!(r#"{{"dev-mac": "{}", "dev-nas": "  "}}"#, "x".repeat(90)),
        )
        .unwrap();
        let names = load_computer_names_from(&path);
        assert_eq!(
            names.get("dev-mac").unwrap().chars().count(),
            NAME_MAX_CHARS
        );
        assert!(!names.contains_key("dev-nas"));
    }
}
