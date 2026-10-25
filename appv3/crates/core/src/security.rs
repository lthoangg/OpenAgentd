use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};

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

/// Validate that a workspace path exists, is a directory, and is safe to use.
pub fn validate_workspace_path(path_str: &str) -> AppResult<PathBuf> {
    if path_str.trim().is_empty() {
        return Err(AppError::Validation("Workspace path cannot be empty".into()));
    }
    let path = PathBuf::from(path_str);
    let canonical = match dunce::canonicalize(path) {
        Ok(p) => p,
        Err(e) => return Err(AppError::Validation(format!("Invalid workspace path '{}': {}", path_str, e))),
    };

    if !canonical.is_dir() {
        return Err(AppError::Validation(format!("Workspace path '{}' is not a directory", path_str)));
    }

    if is_denied_path(&canonical) {
        return Err(AppError::Forbidden(format!("Access to path '{}' is denied", path_str)));
    }

    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_denied_paths() {
        assert!(is_denied_path(Path::new("/home/user/.git/config")));
        assert!(is_denied_path(Path::new("/home/user/.env")));
        assert!(is_denied_path(Path::new("/home/user/.env.production")));
        assert!(is_denied_path(Path::new("/home/user/.config/openagentd/credentials.yaml")));
        assert!(is_denied_path(Path::new("/home/user/.ssh/id_rsa")));
        assert!(!is_denied_path(Path::new("/home/user/src/main.rs")));
    }

    #[test]
    fn test_validate_workspace() {
        let dir = tempdir().unwrap();
        let validated = validate_workspace_path(dir.path().to_str().unwrap()).unwrap();
        assert!(validated.exists());
        assert!(validated.is_dir());
    }
}
