//! Release facts shared by `agentd upgrade`, `agentd doctor`, and the
//! server's update API (`/api/server/update`): where releases live, which
//! archive fits this build, how versions compare, and how this binary was
//! installed. No network here: callers resolve `<base>/latest` themselves.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const RELEASES_URL_ENV: &str = "OPENAGENTD_RELEASES_URL";
const DEFAULT_RELEASES_URL: &str = "https://github.com/lthoangg/openagentd/releases";

/// Set on the detached `agentd upgrade --from-server` the server starts, so
/// its second stage knows it already left the server's process tree.
pub const UPGRADE_STAGE_ENV: &str = "OPENAGENTD_UPGRADE_STAGE";

/// What `agentd upgrade --from-server` prints: it outlives the server.
pub fn upgrade_log_path() -> std::path::PathBuf {
    crate::settings().state_dir.join("logs").join("upgrade.log")
}

/// The last server-started upgrade, as JSON: `{"state": "running" |
/// "finished", "ok", "from", "to", "message", "started_at", "finished_at"}`.
/// The server that comes back reads it to say how the upgrade went.
pub fn upgrade_status_path() -> std::path::PathBuf {
    crate::settings().state_dir.join("upgrade-status.json")
}

/// The release feed: `OPENAGENTD_RELEASES_URL` (tests, mirrors), else GitHub.
pub fn releases_base() -> String {
    std::env::var(RELEASES_URL_ENV).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_RELEASES_URL.into()).trim_end_matches('/').to_string()
}

/// The release notes page of `version`.
pub fn release_page(version: &str) -> String {
    format!("{}/tag/v{}", releases_base(), version.trim_start_matches('v'))
}

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

/// `X.Y.Z` → comparable tuple; pre-release/build suffixes are ignored.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some(v)
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

/// The version in the URL `<base>/latest` redirects to (`…/tag/v3.1.0`).
pub fn version_from_tag_url(path: &str) -> Option<String> {
    let tag = path.trim_end_matches('/').rsplit('/').next()?;
    let version = tag.trim_start_matches('v');
    parse_version(version).map(|_| version.to_string())
}

/// Binaries shipped inside the desktop app are updated by the app itself.
pub fn is_desktop_bundled(exe: &Path) -> bool {
    let parent = exe.parent();
    parent.and_then(|p| p.file_name()).is_some_and(|n| n == "bin") && parent.and_then(|p| p.parent()).and_then(|p| p.file_name()).is_some_and(|n| n == "sidecar")
}

/// How this binary updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMethod {
    /// Homebrew's `openagentd` formula: `brew upgrade`.
    Brew,
    /// The installer or a release archive: swap in the verified archive.
    Release,
    /// Inside the desktop app, which ships and updates it.
    DesktopBundled,
}

impl InstallMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            InstallMethod::Brew => "brew",
            InstallMethod::Release => "release",
            InstallMethod::DesktopBundled => "desktop",
        }
    }
}

/// The running binary, symlinks resolved.
pub fn current_exe() -> std::path::PathBuf {
    std::env::current_exe().ok().and_then(|p| dunce::canonicalize(p).ok()).unwrap_or_default()
}

/// How `exe` was installed. Asks `brew` (up to 5 s) only when the path
/// does not already say.
pub fn install_method(exe: &Path) -> InstallMethod {
    if is_desktop_bundled(exe) {
        return InstallMethod::DesktopBundled;
    }
    let parts: Vec<String> = exe.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.iter().any(|p| p == "Cellar") || (parts.iter().any(|p| p == "Homebrew") && parts.iter().any(|p| p == "opt")) {
        return InstallMethod::Brew;
    }
    let Some(brew) = crate::which::which("brew") else { return InstallMethod::Release };
    if exit_code(&brew, &["list", "--formula", "openagentd"], Duration::from_secs(5)) == Some(0) {
        InstallMethod::Brew
    } else {
        InstallMethod::Release
    }
}

/// Exit code of `program args` within `timeout` (killed after it).
fn exit_code(program: &Path, args: &[&str], timeout: Duration) -> Option<i32> {
    let mut child = crate::proctree::hide_window_std(&mut Command::new(program)).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status.code().unwrap_or(-1));
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn the_latest_tag_url_names_the_version() {
        assert_eq!(version_from_tag_url("/lthoangg/openagentd/releases/tag/v3.51.0").as_deref(), Some("3.51.0"));
        assert_eq!(version_from_tag_url("/tag/v3.51.0/").as_deref(), Some("3.51.0"));
        assert_eq!(version_from_tag_url("/releases"), None);
    }

    #[test]
    fn desktop_sidecar_is_detected() {
        let app = Path::new("/Applications/OpenAgentd.app/Contents/Resources/sidecar/bin/agentd");
        assert!(is_desktop_bundled(app));
        assert_eq!(install_method(app), InstallMethod::DesktopBundled);
        assert!(!is_desktop_bundled(Path::new("/home/u/.local/bin/agentd")));
        assert_eq!(install_method(Path::new("/opt/homebrew/Cellar/openagentd/3.0.0/bin/agentd")), InstallMethod::Brew);
    }
}
