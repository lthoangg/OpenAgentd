//! Files only the current user can read, for secrets kept outside the OS
//! credential store.

use std::io::Write;
use std::path::Path;

/// The file's bytes, or `None` when it does not exist.
pub fn read(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Replace `path` with `bytes`. The data goes to a sibling temp file created
/// with mode 0600 (on Unix) and is renamed into place, so the secret is never
/// readable by others, not even briefly, and a crash leaves either the old or
/// the new file. On Windows the per-user app config directory's ACL applies.
pub fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".tmp-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut file = builder.tempfile_in(dir)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(&dir.path().join("absent")).unwrap(), None);
    }

    #[test]
    fn writes_replace_the_file_and_are_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/secret");
        write(&path, b"one").unwrap();
        write(&path, b"two").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some(&b"two"[..]));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let leftovers = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1, "no temp files are left behind");
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_world_readable_file_becomes_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write(&path, b"new").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
