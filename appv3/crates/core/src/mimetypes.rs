//! `mimetypes.guess_type` — Python's strict table captured verbatim from the
//! v2 interpreter (`data/mimetypes.json`, includes the host's
//! `/etc/**/mime.types` files that CPython reads at init).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

struct Db {
    types: HashMap<String, String>,
    suffix: HashMap<String, String>,
    encodings: HashMap<String, String>,
}

fn db() -> &'static Db {
    static DB: OnceLock<Db> = OnceLock::new();
    DB.get_or_init(|| {
        let raw: Value = serde_json::from_str(include_str!("../data/mimetypes.json")).expect("mimetypes contract");
        let map = |k: &str| -> HashMap<String, String> {
            raw.get(k).and_then(|v| v.as_object()).map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default()
        };
        Db { types: map("types_map"), suffix: map("suffix_map"), encodings: map("encodings_map") }
    })
}

/// `os.path.splitext` (posix): leading dots of the basename never start an
/// extension.
pub fn splitext(path: &str) -> (String, String) {
    let base_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let name = &path[base_start..];
    let Some(dot) = name.rfind('.') else {
        return (path.to_string(), String::new());
    };
    if name[..dot].chars().all(|c| c == '.') {
        return (path.to_string(), String::new());
    }
    let at = base_start + dot;
    (path[..at].to_string(), path[at..].to_string())
}

/// `mimetypes.guess_type(path)` → `(type, encoding)` (strict).
pub fn guess_type_full(path: &str) -> (Option<String>, Option<String>) {
    let d = db();
    let (mut base, mut ext) = splitext(path);
    let mut guard = 0;
    while let Some(rep) = d.suffix.get(&ext.to_lowercase()) {
        let joined = format!("{base}{rep}");
        (base, ext) = splitext(&joined);
        guard += 1;
        if guard > 8 {
            break;
        }
    }
    let encoding = if let Some(enc) = d.encodings.get(&ext) {
        let e = enc.clone();
        (base, ext) = splitext(&base);
        Some(e)
    } else {
        None
    };
    let _ = base;
    (d.types.get(&ext.to_lowercase()).cloned(), encoding)
}

/// `mimetypes.guess_type(path)[0]`.
pub fn guess_type(path: &str) -> Option<String> {
    guess_type_full(path).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_python() {
        assert_eq!(guess_type("a.ts").as_deref(), Some("video/mp2t"));
        assert_eq!(guess_type("/x/a.py").as_deref(), Some("text/x-python"));
        assert_eq!(guess_type_full("a.tar.gz"), (Some("application/x-tar".into()), Some("gzip".into())));
        assert_eq!(guess_type_full("a.tgz"), (Some("application/x-tar".into()), Some("gzip".into())));
        assert_eq!(guess_type("a.PNG").as_deref(), Some("image/png"));
        assert_eq!(guess_type("a.tsx"), None);
        assert_eq!(guess_type("Makefile"), None);
        assert_eq!(guess_type(".bashrc"), None);
    }
}
