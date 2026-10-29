//! Self-update from GitHub release archives (`agentd upgrade` when the
//! binary was not installed by Homebrew).
//!
//! v3 is not published to PyPI, so v2's uv/pipx/pip paths would install
//! the old Python package instead. This downloads
//! `openagentd-<version>-<target>.<tar.gz|zip>` plus its `.sha256` (the
//! contract written by `.github/workflows/release.yml`), verifies it, and
//! swaps every executable in the archive into the running binary's
//! directory by rename. The archive name keeps the project name; inside are
//! `agentd` and the `openagentd` compatibility alias.

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const RELEASES_URL_ENV: &str = "OPENAGENTD_RELEASES_URL";
const DEFAULT_RELEASES_URL: &str = "https://github.com/lthoangg/openagentd/releases";

/// Rust target triple of the release archive for this build.
pub fn target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unsupported"
    }
}

pub fn archive_name(version: &str, target: &str) -> String {
    let ext = if target.contains("windows") { "zip" } else { "tar.gz" };
    format!("openagentd-{version}-{target}.{ext}")
}

pub fn releases_base() -> String {
    std::env::var(RELEASES_URL_ENV).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_RELEASES_URL.into()).trim_end_matches('/').to_string()
}

/// `X.Y.Z` → comparable tuple; pre-release/build suffixes are ignored.
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some(v)
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

/// Binaries shipped inside the desktop app are updated by the app itself.
pub fn is_desktop_bundled(exe: &Path) -> bool {
    let parent = exe.parent();
    parent.and_then(|p| p.file_name()).is_some_and(|n| n == "bin") && parent.and_then(|p| p.parent()).and_then(|p| p.file_name()).is_some_and(|n| n == "sidecar")
}

/// `<hex>  <name>` (sha256sum format) → verified or an error.
pub fn verify_sha256(bytes: &[u8], sha_file: &str) -> Result<()> {
    let expected = sha_file.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    let actual: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if expected.len() != 64 || expected != actual {
        bail!("checksum mismatch (expected {expected:?}, got {actual})");
    }
    Ok(())
}

/// Unpack the archive into `dest` and return the executables at its root.
pub fn extract(archive: &Path, dest: &Path) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dest)?;
    let name = archive.to_string_lossy();
    if name.ends_with(".tar.gz") {
        let file = std::fs::File::open(archive)?;
        tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(dest).context("unpack tar.gz")?;
    } else if name.ends_with(".zip") {
        // bsdtar ships with Windows 10+ and reads zip archives.
        let tar = std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("System32").join("tar.exe")).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("tar"));
        let status = std::process::Command::new(tar).arg("-xf").arg(archive).arg("-C").arg(dest).status().context("run tar to unpack the zip")?;
        if !status.success() {
            bail!("tar could not unpack {name}");
        }
    } else {
        bail!("unknown archive type: {name}");
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dest)? {
        let path = entry?.path();
        // Dotfiles are never binaries; macOS tar adds `._name` AppleDouble
        // entries for files with extended attributes.
        let hidden = path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
        if !hidden && path.is_file() && is_executable(&path) {
            out.push(path);
        }
    }
    out.sort();
    if !out.iter().any(|p| p.file_stem().is_some_and(|s| s == "agentd")) {
        bail!("the archive does not contain the agentd binary");
    }
    Ok(out)
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
}

/// Swap each file into `dir` by rename. On Windows a running `.exe` cannot
/// be replaced, but it can be renamed aside to `<name>.old` first.
pub fn install_into(dir: &Path, files: &[PathBuf]) -> Result<()> {
    for src in files {
        let name = src.file_name().ok_or_else(|| anyhow!("bad file name"))?;
        let dest = dir.join(name);
        let tmp = dir.join(format!(".{}.new.{}", name.to_string_lossy(), std::process::id()));
        std::fs::copy(src, &tmp).with_context(|| format!("write {} (is the directory writable? reinstall with the installer to change it)", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        }
        #[cfg(windows)]
        if dest.exists() {
            let old = dir.join(format!("{}.old", name.to_string_lossy()));
            let _ = std::fs::remove_file(&old);
            std::fs::rename(&dest, &old).with_context(|| format!("move {} aside", dest.display()))?;
        }
        if let Err(e) = std::fs::rename(&tmp, &dest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e).with_context(|| format!("replace {}", dest.display()));
        }
    }
    Ok(())
}

/// Remove `<exe>.old` copies left by a previous Windows update.
pub fn cleanup_old(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.to_string_lossy().ends_with(".exe.old") {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

pub enum Outcome {
    UpToDate(String),
    Updated { from: String, to: String },
}

async fn latest_version(client: &reqwest::Client, base: &str) -> Result<String> {
    let resp = client.get(format!("{base}/latest")).send().await.context("resolve the latest release")?.error_for_status()?;
    let tag = resp.url().path_segments().and_then(|mut s| s.next_back().map(str::to_string)).unwrap_or_default();
    let version = tag.trim_start_matches('v').to_string();
    if parse_version(&version).is_none() {
        bail!("unexpected latest release tag: {tag:?}");
    }
    Ok(version)
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let resp = client.get(url).send().await.with_context(|| format!("download {url}"))?.error_for_status().with_context(|| format!("download {url}"))?;
    Ok(resp.bytes().await?.to_vec())
}

/// Update the binaries in `install_dir` from `base` if a newer release than
/// `current` exists.
pub async fn update(base: &str, current: &str, install_dir: &Path) -> Result<Outcome> {
    let target = target_triple();
    if target == "unsupported" {
        bail!("no prebuilt agentd release for this platform");
    }
    let client = reqwest::Client::builder().user_agent(format!("openagentd/{current}")).build()?;
    let latest = latest_version(&client, base).await?;
    if !is_newer(&latest, current) {
        return Ok(Outcome::UpToDate(current.to_string()));
    }
    let name = archive_name(&latest, target);
    let url = format!("{base}/download/v{latest}/{name}");
    let bytes = fetch(&client, &url).await?;
    let sha = fetch(&client, &format!("{url}.sha256")).await?;
    verify_sha256(&bytes, &String::from_utf8_lossy(&sha)).with_context(|| format!("verify {name}"))?;

    let work = tempdir_in(install_dir)?;
    let result = (|| {
        let archive = work.join(&name);
        std::fs::write(&archive, &bytes)?;
        let files = extract(&archive, &work.join("stage"))?;
        install_into(install_dir, &files)
    })();
    let _ = std::fs::remove_dir_all(&work);
    result?;
    Ok(Outcome::Updated { from: current.to_string(), to: latest })
}

/// A scratch dir beside the binary, so the final rename stays on one
/// filesystem; falls back to the system temp dir.
fn tempdir_in(dir: &Path) -> Result<PathBuf> {
    let name = format!(".openagentd-update-{}", std::process::id());
    for base in [dir.to_path_buf(), std::env::temp_dir()] {
        let p = base.join(&name);
        if std::fs::create_dir_all(&p).is_ok() {
            return Ok(p);
        }
    }
    bail!("could not create a temporary directory")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("3.0.1", "3.0.0"));
        assert!(is_newer("3.10.0", "3.9.9"));
        assert!(is_newer("v4.0.0", "3.99.0"));
        assert!(!is_newer("3.0.0", "3.0.0"));
        assert!(!is_newer("2.27.0", "3.0.0"), "never moves back to v2");
        assert!(!is_newer("garbage", "3.0.0"));
    }

    #[test]
    fn archive_names_match_the_release_contract() {
        assert_eq!(archive_name("3.0.0", "aarch64-apple-darwin"), "openagentd-3.0.0-aarch64-apple-darwin.tar.gz");
        assert_eq!(archive_name("3.0.0", "x86_64-pc-windows-msvc"), "openagentd-3.0.0-x86_64-pc-windows-msvc.zip");
        assert_ne!(target_triple(), "unsupported");
    }

    #[test]
    fn desktop_sidecar_is_detected() {
        assert!(is_desktop_bundled(Path::new("/Applications/OpenAgentd.app/Contents/Resources/sidecar/bin/agentd")));
        assert!(!is_desktop_bundled(Path::new("/home/u/.local/bin/agentd")));
    }

    #[test]
    fn checksum_must_match() {
        let good = format!("{}  a.tar.gz\n", sha_hex(b"data"));
        assert!(verify_sha256(b"data", &good).is_ok());
        assert!(verify_sha256(b"tampered", &good).is_err());
        assert!(verify_sha256(b"data", "").is_err());
    }

    /// A `.tar.gz` holding executables named `names` (each a shell script
    /// printing `body`) plus a non-executable LICENSE.
    #[cfg(unix)]
    fn fake_archive(names: &[&str], body: &str) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let executables = names.iter().map(|n| (*n, 0o755, format!("#!/bin/sh\necho {body}\n")));
        // Plus an AppleDouble entry, as macOS tar writes for files with xattrs.
        let extras = [("LICENSE", 0o644, "license".to_string()), ("._agentd", 0o755, "appledouble".to_string())];
        for (name, mode, data) in executables.chain(extras) {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(mode);
            h.set_cksum();
            builder.append_data(&mut h, name, data.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    /// Serve `/latest` → `/tag/v<latest>` and the archive + `.sha256` under
    /// `/download/v<latest>/`, like GitHub.
    #[cfg(unix)]
    async fn fake_releases(latest: &'static str, archive: Vec<u8>, sha: String) -> String {
        use axum::{extract::Path as P, response::Redirect, routing::get, Router};
        let name = archive_name(latest, target_triple());
        let app = Router::new()
            .route("/latest", get(move || async move { Redirect::temporary(&format!("/tag/v{latest}")) }))
            .route("/tag/{tag}", get(|| async { "release page" }))
            .route(
                "/download/{tag}/{file}",
                get(move |P((_tag, file)): P<(String, String)>| {
                    let (archive, sha, name) = (archive.clone(), sha.clone(), name.clone());
                    async move {
                        if file == name {
                            Ok(archive)
                        } else if file == format!("{name}.sha256") {
                            Ok(sha.into_bytes())
                        } else {
                            Err(axum::http::StatusCode::NOT_FOUND)
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_replaces_every_binary_from_a_verified_archive() {
        let archive = fake_archive(&["agentd", "openagentd"], "new");
        let sha = format!("{}  x\n", sha_hex(&archive));
        let base = fake_releases("3.1.0", archive, sha).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("agentd"), "old").unwrap();

        let outcome = update(&base, "3.0.0", dir.path()).await.unwrap();
        assert!(matches!(outcome, Outcome::Updated { ref to, .. } if to == "3.1.0"));
        assert!(std::fs::read_to_string(dir.path().join("agentd")).unwrap().contains("echo new"));
        assert!(dir.path().join("openagentd").is_file(), "the compatibility alias is installed too");
        assert!(!dir.path().join("LICENSE").exists(), "only executables are installed");
        assert!(!dir.path().join("._agentd").exists(), "AppleDouble entries are skipped");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with('.')).collect();
        assert!(leftovers.is_empty(), "no scratch files left behind");

        assert!(matches!(update(&base, "3.1.0", dir.path()).await.unwrap(), Outcome::UpToDate(_)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_refuses_a_tampered_archive() {
        let archive = fake_archive(&["agentd"], "evil");
        let base = fake_releases("3.1.0", archive, format!("{}  x\n", sha_hex(b"something else"))).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("agentd"), "old").unwrap();

        let err = update(&base, "3.0.0", dir.path()).await.err().expect("must fail");
        assert!(format!("{err:#}").contains("checksum mismatch"), "{err:#}");
        assert_eq!(std::fs::read_to_string(dir.path().join("agentd")).unwrap(), "old");
    }

    #[cfg(unix)]
    #[test]
    fn extract_requires_agentd() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar.gz");
        std::fs::write(&archive, fake_archive(&["openagentd"], "old name only")).unwrap();
        let err = extract(&archive, &dir.path().join("x")).expect_err("must fail");
        assert!(err.to_string().contains("agentd binary"), "{err:#}");
    }
}
