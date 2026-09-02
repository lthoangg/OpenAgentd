//! Bounded file downloads for the "save workspace file" commands.
//!
//! The frontend hands the shells one of three shapes — a base64 payload for
//! `blob:` sources that only exist inside the webview, a `data:` URI, or a
//! remote `http(s)` URL — and both shells must apply the same 100 MB ceiling
//! against a hostile or mistaken `Content-Length`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};

/// Ceiling on a single download. Bounds the in-memory buffer below.
pub const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_FILENAME_COLLISION_ATTEMPTS: usize = 1000;
const LIMIT_MESSAGE: &str = "file exceeds the 100 MB limit";

pub fn ensure_max_download_size(size: usize) -> Result<()> {
    if size > MAX_DOWNLOAD_BYTES {
        Err(anyhow!("{LIMIT_MESSAGE}"))
    } else {
        Ok(())
    }
}

pub fn ensure_content_length_limit(content_length: Option<u64>) -> Result<()> {
    if let Some(length) = content_length {
        let length = usize::try_from(length).map_err(|_| anyhow!("{LIMIT_MESSAGE}"))?;
        ensure_max_download_size(length)?;
    }
    Ok(())
}

/// Decode a standard-alphabet base64 payload, enforcing the size ceiling.
/// `what` prefixes the error so the UI can say which input was bad.
pub fn decode_base64(payload: &str, what: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let bytes = base64::prelude::BASE64_STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("{what}: {e}"))?;
    ensure_max_download_size(bytes.len()).map_err(|e| format!("{what}: {e}"))?;
    Ok(bytes)
}

/// Reduce a frontend-supplied filename to a safe bare file name.
pub fn safe_download_filename(filename: &str) -> String {
    Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download")
        .to_string()
}

/// First non-existing `dir/filename`, adding ` (N)` before the extension
/// on collision.
pub fn unique_cache_path(dir: &Path, filename: &str) -> Result<PathBuf> {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(filename);
    let ext = path.extension().and_then(|value| value.to_str());
    for index in 1..=MAX_FILENAME_COLLISION_ATTEMPTS {
        let candidate_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem} ({index}).{ext}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = dir.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "Could not find a unique filename after {MAX_FILENAME_COLLISION_ATTEMPTS} attempts"
    ))
}

/// The shapes the frontend can send for a download.
pub struct DownloadSource<'a> {
    pub base64: Option<&'a str>,
    pub url: Option<&'a str>,
}

/// Resolve the bytes to save from whichever shape the frontend sent.
///
/// Remote URLs are fetched with `client`, streamed so a server that omits or
/// under-reports `Content-Length` still cannot push past the cap, and carry
/// the stored access key for their origin as a bearer token unless the URL
/// already has a `_token` query parameter.
pub async fn resolve_download_bytes(
    client: &reqwest::Client,
    source: DownloadSource<'_>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    match (source.base64, source.url) {
        (Some(payload), _) => decode_base64(payload, "Decode attachment"),
        (None, Some(url)) if url.starts_with("data:") => {
            // data:<mime>;base64,<payload>
            let payload = url
                .split_once(',')
                .map(|(_, payload)| payload)
                .ok_or("Invalid data URI: missing comma")?;
            decode_base64(payload, "Decode data URI")
        }
        (None, Some(url)) => {
            let mut request = client.get(url).timeout(timeout);
            if let Ok(parsed) = url::Url::parse(url) {
                let has_token_qs = parsed.query_pairs().any(|(k, _)| k == "_token");
                if !has_token_qs {
                    let origin = parsed.origin().ascii_serialization();
                    if let Ok(Some(key)) = crate::access_key::get_access_key(&origin) {
                        request = request.bearer_auth(key);
                    }
                }
            }
            let mut response = request
                .send()
                .await
                .map_err(|e| format!("Download file: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Download file: {e}"))?;
            ensure_content_length_limit(response.content_length())
                .map_err(|e| format!("Download file: {e}"))?;
            // Pre-reserve from the (already cap-checked) Content-Length so a
            // ~100 MB body doesn't pay ~27 doubling reallocations; the `min`
            // keeps a lying header from over-allocating.
            let mut bytes = Vec::with_capacity(
                response
                    .content_length()
                    .map_or(0, |length| length.min(MAX_DOWNLOAD_BYTES as u64) as usize),
            );
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| format!("Read downloaded file: {e}"))?
            {
                let new_len = bytes
                    .len()
                    .checked_add(chunk.len())
                    .ok_or_else(|| format!("Read downloaded file: {LIMIT_MESSAGE}"))?;
                ensure_max_download_size(new_len)
                    .map_err(|e| format!("Read downloaded file: {e}"))?;
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        }
        (None, None) => Err("save_workspace_file: must supply either base64 or url".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ensure_max_download_size_rejects_oversized_payload() {
        assert!(ensure_max_download_size(MAX_DOWNLOAD_BYTES).is_ok());
        assert!(ensure_max_download_size(MAX_DOWNLOAD_BYTES + 1).is_err());
        assert!(ensure_content_length_limit(None).is_ok());
        assert!(ensure_content_length_limit(Some(MAX_DOWNLOAD_BYTES as u64 + 1)).is_err());
        assert!(ensure_content_length_limit(Some(u64::MAX)).is_err());
    }

    #[test]
    fn decode_base64_trims_and_labels_errors() {
        assert_eq!(decode_base64(" aGk= ", "x").unwrap(), b"hi");
        let err = decode_base64("!!!", "Decode data URI").unwrap_err();
        assert!(err.starts_with("Decode data URI: "), "{err}");
    }

    #[test]
    fn oversized_base64_payload_is_rejected() {
        use base64::Engine;
        let payload = base64::prelude::BASE64_STANDARD.encode(vec![0u8; MAX_DOWNLOAD_BYTES + 1]);
        let err = decode_base64(&payload, "Decode attachment").unwrap_err();
        assert!(err.contains("100 MB"), "unexpected error: {err}");
    }

    #[test]
    fn safe_download_filename_strips_directories_and_defaults() {
        assert_eq!(safe_download_filename("../../etc/passwd"), "passwd");
        assert_eq!(safe_download_filename("dir/report.txt"), "report.txt");
        assert_eq!(safe_download_filename(""), "download");
        assert_eq!(safe_download_filename("/"), "download");
    }

    #[test]
    fn unique_cache_path_returns_original_when_no_collision() {
        let dir = tempdir().unwrap();
        let path = unique_cache_path(dir.path(), "report.txt").unwrap();
        assert_eq!(path, dir.path().join("report.txt"));
    }

    #[test]
    fn unique_cache_path_skips_to_next_available_suffix() {
        let dir = tempdir().unwrap();
        for name in ["report.txt", "report (1).txt", "report (2).txt"] {
            std::fs::write(dir.path().join(name), b"existing").unwrap();
        }
        let path = unique_cache_path(dir.path(), "report.txt").unwrap();
        assert_eq!(path, dir.path().join("report (3).txt"));
    }

    #[test]
    fn unique_cache_path_preserves_extension_and_handles_none() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("archive.tar.gz"), b"existing").unwrap();
        std::fs::write(dir.path().join("download"), b"existing").unwrap();
        assert_eq!(
            unique_cache_path(dir.path(), "archive.tar.gz").unwrap(),
            dir.path().join("archive.tar (1).gz")
        );
        assert_eq!(
            unique_cache_path(dir.path(), "download").unwrap(),
            dir.path().join("download (1)")
        );
    }

    #[tokio::test]
    async fn resolve_download_bytes_handles_inline_shapes_without_network() {
        let client = reqwest::Client::new();
        let from_b64 = resolve_download_bytes(
            &client,
            DownloadSource {
                base64: Some("aGk="),
                url: None,
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(from_b64, b"hi");

        let from_data_uri = resolve_download_bytes(
            &client,
            DownloadSource {
                base64: None,
                url: Some("data:text/plain;base64,aGk="),
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(from_data_uri, b"hi");

        let missing_comma = resolve_download_bytes(
            &client,
            DownloadSource {
                base64: None,
                url: Some("data:text/plain"),
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(missing_comma, "Invalid data URI: missing comma");

        let nothing = resolve_download_bytes(
            &client,
            DownloadSource {
                base64: None,
                url: None,
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(nothing.contains("must supply either base64 or url"));
    }
}
