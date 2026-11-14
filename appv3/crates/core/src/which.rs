//! Cross-platform `shutil.which`.
//!
//! - Unix: a regular file with any execute bit set.
//! - Windows: tries `PATHEXT` extensions (`.COM;.EXE;.BAT;.CMD` by default);
//!   a name that already ends in one of them is also tried as-is.
//! - `PATH` is split with the platform separator (`:` or `;`); duplicate and
//!   empty entries are skipped, as in Python.
//! - A name containing a path separator is checked directly, not searched.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// `shutil.which(name)` against the process `PATH`.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    which_in(name, &path)
}

/// `shutil.which(name, path=path)`.
pub fn which_in(name: &str, path: impl AsRef<OsStr>) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    if name.contains('/') || (cfg!(windows) && name.contains('\\')) {
        return candidates(Path::new(name)).into_iter().find(|c| is_executable(c));
    }
    let mut seen = std::collections::HashSet::new();
    for dir in std::env::split_paths(path.as_ref()) {
        if dir.as_os_str().is_empty() || !seen.insert(normalise(&dir)) {
            continue;
        }
        if let Some(hit) = candidates(&dir.join(name)).into_iter().find(|c| is_executable(c)) {
            return Some(hit);
        }
    }
    None
}

/// Whether `p` is a file this platform would execute.
pub fn is_executable(p: &Path) -> bool {
    let Ok(md) = std::fs::metadata(p) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.is_file() && md.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        md.is_file()
    }
}

#[cfg(windows)]
fn candidates(p: &Path) -> Vec<PathBuf> {
    let raw = std::env::var("PATHEXT").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<String> = raw.split(';').filter(|e| !e.is_empty()).map(|e| e.to_ascii_lowercase()).collect();
    let lower = p.to_string_lossy().to_ascii_lowercase();
    let mut out = Vec::with_capacity(exts.len() + 1);
    if exts.iter().any(|e| lower.ends_with(e.as_str())) {
        out.push(p.to_path_buf());
    }
    for e in &exts {
        let mut s = p.as_os_str().to_owned();
        s.push(e);
        out.push(PathBuf::from(s));
    }
    out
}

#[cfg(not(windows))]
fn candidates(p: &Path) -> Vec<PathBuf> {
    vec![p.to_path_buf()]
}

/// Key for de-duplicating `PATH` entries (case-insensitive on Windows).
fn normalise(dir: &Path) -> String {
    let s = dir.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_exe(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    #[test]
    fn finds_first_match_in_path_order() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let file = if cfg!(windows) { "tool.exe" } else { "tool" };
        make_exe(b.path(), file);
        let hit = make_exe(a.path(), file);
        let path = std::env::join_paths([a.path(), b.path()]).unwrap();
        assert_eq!(which_in("tool", &path), Some(hit));
        assert_eq!(which_in("missing", &path), None);
        assert_eq!(which_in("", &path), None);
    }

    #[cfg(unix)]
    #[test]
    fn skips_non_executable_and_dirs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("plain"), b"").unwrap();
        std::fs::create_dir(d.path().join("sub")).unwrap();
        assert_eq!(which_in("plain", d.path()), None);
        assert_eq!(which_in("sub", d.path()), None);
    }

    #[test]
    fn direct_path_is_not_searched() {
        let d = tempfile::tempdir().unwrap();
        let file = if cfg!(windows) { "x.exe" } else { "x" };
        let exe = make_exe(d.path(), file);
        let direct = d.path().join("x");
        assert_eq!(which_in(&direct.to_string_lossy(), ""), Some(exe));
    }
}
