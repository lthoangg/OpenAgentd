use std::path::Path;

/// Denied directory and file names. `credentials.yaml` is the secret store's
/// name, so a copy of it is never served or picked up either.
const DENIED_EXACT: &[&str] = &[".git", ".env", ".env.local", ".env.production", crate::credentials::FILE_NAME, "id_rsa", "id_ed25519", ".ssh", ".aws", ".gnupg"];

/// Check if a path or component matches the security denylist.
pub fn is_denied_path(path: &Path) -> bool {
    for comp in path.components() {
        let s = comp.as_os_str().to_string_lossy();
        for denied in DENIED_EXACT {
            if s == *denied {
                return true;
            }
        }
        if s.starts_with(".env.") {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_denied_paths() {
        assert!(is_denied_path(Path::new("/home/user/.git/config")));
        assert!(is_denied_path(Path::new("/home/user/.env")));
        assert!(is_denied_path(Path::new("/home/user/.env.production")));
        assert!(is_denied_path(Path::new("/home/user/.config/openagentd/credentials.yaml")));
        assert!(is_denied_path(Path::new("/home/user/.ssh/id_rsa")));
        assert!(!is_denied_path(Path::new("/home/user/src/main.rs")));
    }
}
