//! "Open at login" (Settings → Desktop → Startup).
//!
//! The switch registers this app with the OS (a Launch Agent on macOS, the
//! current user's `Run` key on Windows, an XDG autostart entry on Linux),
//! always with [`LOGIN_ARG`]. A launch that carries it starts everything
//! except a window: the backend, the tray, the notch and the pet, so
//! scheduled tasks run and the account's other devices can reach this
//! computer; the window opens when the person asks for it.
//!
//! The OS holds the state: nothing is saved beside it, so an entry removed
//! in System Settings reads as off here.
//!
//! `auto-launch` writes the entry. It is used directly, not through
//! `tauri-plugin-autostart`, because the plugin hands it the bare binary
//! path (unquoted in the `Run` value and the `Exec` line, so a folder with a
//! space in its name breaks the entry or runs another program), registers
//! for every user when the app happens to run as an administrator, and adds
//! commands of its own to the webview's surface.

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use tauri::AppHandle;
#[cfg(target_os = "linux")]
use tauri::Manager;

/// What a launch registered by the switch is started with.
pub const LOGIN_ARG: &str = "--at-login";

/// Whether this process was started by the login entry. `args` is the whole
/// command line, the program's own path first.
pub fn launched_at_login(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().skip(1).any(|arg| arg == LOGIN_ARG)
}

/// Why this build must not register itself, if it must not. A development
/// build would put its own binary in the login items, where it would start,
/// without its dev server, at every sign-in.
fn refusal(debug_build: bool) -> Option<&'static str> {
    debug_build.then_some("A development build does not open at login. Install OpenAgentd to use this.")
}

/// The systems an entry is written for, each with its own syntax.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Os {
    Mac,
    Windows,
    Linux,
}

const THIS_OS: Os = if cfg!(target_os = "macos") {
    Os::Mac
} else if cfg!(windows) {
    Os::Windows
} else {
    Os::Linux
};

/// What the entry is called: the Launch Agent's label and file on macOS
/// (reverse-DNS, and not the bundle id itself, which launchd uses for the
/// app), the name Task Manager and the autostart folder show elsewhere.
fn entry_name(os: Os, product: &str, identifier: &str) -> String {
    match os {
        Os::Mac => format!("{identifier}.login"),
        Os::Windows | Os::Linux => product.to_string(),
    }
}

/// The program as the entry must spell it, or why this path cannot be
/// registered. `auto-launch` pastes it into a command line (Windows, Linux)
/// or an XML string (macOS) as it is.
fn entry_program(os: Os, path: &str) -> Result<String, String> {
    match os {
        // The `Run` value is a command line: quoted, or `C:\Users\Ann Lee\…`
        // is read as the program `C:\Users\Ann`. A Windows path has no `"`.
        Os::Windows => Ok(format!("\"{path}\"")),
        // An `Exec` argument with a reserved character is quoted, with
        // `"`, `` ` ``, `$` and `\` escaped (Desktop Entry Specification).
        Os::Linux => {
            let plain = path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+@:,".contains(c));
            if plain {
                return Ok(path.to_string());
            }
            let mut quoted = String::with_capacity(path.len() + 2);
            quoted.push('"');
            for c in path.chars() {
                if matches!(c, '"' | '`' | '$' | '\\') {
                    quoted.push('\\');
                }
                // `%` starts a field code in `Exec`; `%%` is a literal one.
                if c == '%' {
                    quoted.push('%');
                }
                quoted.push(c);
            }
            quoted.push('"');
            Ok(quoted)
        }
        // The plist takes the path as text and checks that it exists, so it
        // can be neither escaped nor left with characters XML reads.
        Os::Mac if path.contains(['&', '<', '>']) => {
            Err("OpenAgentd can't open at login from this folder: its path has &, < or > in it. Move OpenAgentd to Applications.".to_string())
        }
        Os::Mac => Ok(path.to_string()),
    }
}

/// The login entry for the binary that runs now.
fn entry(app: &AppHandle) -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().and_then(|path| path.canonicalize()).map_err(|e| format!("Couldn't find this app's own program: {e}"))?;
    // An AppImage runs from a mount that is gone after it quits: the entry
    // starts the image.
    #[cfg(target_os = "linux")]
    let exe = app.env().appimage.map(std::path::PathBuf::from).unwrap_or(exe);
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name(&entry_name(THIS_OS, &app.package_info().name, &app.config().identifier))
        .set_app_path(&entry_program(THIS_OS, &exe.to_string_lossy())?)
        .set_args(&[LOGIN_ARG]);
    #[cfg(target_os = "macos")]
    builder
        .set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent)
        // System Settings → Login Items names the app, not the binary.
        .set_bundle_identifiers(&[app.config().identifier.as_str()]);
    // This user only: never the machine-wide key, even when run as an administrator.
    #[cfg(windows)]
    builder.set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser);
    builder.build().map_err(|e| e.to_string())
}

/// Whether the OS has the login entry now.
fn enabled(app: &AppHandle) -> bool {
    match entry(app).and_then(|entry| entry.is_enabled().map_err(|e| e.to_string())) {
        Ok(enabled) => enabled,
        Err(e) => {
            log::warn!("autostart: could not read the login entry: {e}");
            false
        }
    }
}

/// Point an existing login entry at the binary that runs now: the app may
/// have been moved (out of Downloads, say) since the switch was turned on.
pub fn refresh(app: &AppHandle) {
    if refusal(cfg!(debug_assertions)).is_some() || !enabled(app) {
        return;
    }
    if let Err(e) = entry(app).and_then(|entry| entry.enable().map_err(|e| e.to_string())) {
        log::warn!("autostart: could not refresh the login entry: {e}");
    }
}

#[tauri::command]
pub fn autostart_enabled(app: AppHandle) -> bool {
    enabled(&app)
}

/// Turn the login entry on or off; answers what the OS says afterwards.
#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let entry = entry(&app)?;
    if enabled {
        if let Some(why) = refusal(cfg!(debug_assertions)) {
            return Err(why.to_string());
        }
        entry.enable().map_err(|e| e.to_string())?;
    } else {
        entry.disable().map_err(|e| e.to_string())?;
    }
    let now = self::enabled(&app);
    log::info!("autostart: open at login set wanted={enabled} now={now}");
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_launch_from_the_login_entry_is_told_by_its_argument() {
        assert!(launched_at_login(args(&["/Applications/OpenAgentd.app/Contents/MacOS/OpenAgentd", LOGIN_ARG])));
        assert!(launched_at_login(args(&["openagentd.exe", "--other", LOGIN_ARG])));
    }

    #[test]
    fn any_other_launch_opens_as_usual() {
        assert!(!launched_at_login(args(&["openagentd"])));
        assert!(!launched_at_login(args(&["openagentd", "openagentd://session/abc"])));
        assert!(!launched_at_login(args(&[])));
        // Only a whole argument counts, and never the program's own path.
        assert!(!launched_at_login(args(&["openagentd", "--at-login-later"])));
        assert!(!launched_at_login(args(&[LOGIN_ARG])));
    }

    #[test]
    fn a_development_build_never_registers_itself() {
        assert!(refusal(true).is_some());
        assert!(refusal(false).is_none());
    }

    #[test]
    fn a_windows_program_is_always_quoted() {
        assert_eq!(
            entry_program(Os::Windows, r"C:\Users\Ann Lee\AppData\Local\OpenAgentd\OpenAgentd.exe").unwrap(),
            r#""C:\Users\Ann Lee\AppData\Local\OpenAgentd\OpenAgentd.exe""#
        );
        assert_eq!(entry_program(Os::Windows, r"C:\OpenAgentd\OpenAgentd.exe").unwrap(), r#""C:\OpenAgentd\OpenAgentd.exe""#);
    }

    #[test]
    fn a_linux_program_is_quoted_only_when_it_needs_it() {
        assert_eq!(entry_program(Os::Linux, "/usr/bin/openagentd-desktop").unwrap(), "/usr/bin/openagentd-desktop");
        assert_eq!(
            entry_program(Os::Linux, "/home/ann/My Apps/OpenAgentd.AppImage").unwrap(),
            r#""/home/ann/My Apps/OpenAgentd.AppImage""#
        );
        // The characters a quoted Exec argument must escape, and a literal %.
        assert_eq!(
            entry_program(Os::Linux, r#"/opt/a"b`c$d\e 100%/app"#).unwrap(),
            r#""/opt/a\"b\`c\$d\\e 100%%/app""#
        );
    }

    #[test]
    fn a_mac_program_is_its_path_unless_xml_would_misread_it() {
        let path = "/Applications/OpenAgentd.app/Contents/MacOS/OpenAgentd";
        assert_eq!(entry_program(Os::Mac, path).unwrap(), path);
        // A space needs nothing in a plist string.
        assert_eq!(entry_program(Os::Mac, "/Users/ann/My Apps/OpenAgentd.app/Contents/MacOS/OpenAgentd").unwrap(), "/Users/ann/My Apps/OpenAgentd.app/Contents/MacOS/OpenAgentd");
        let refused = entry_program(Os::Mac, "/Users/ann/R&D/OpenAgentd.app/Contents/MacOS/OpenAgentd").unwrap_err();
        assert!(refused.contains("Move OpenAgentd to Applications"), "{refused}");
    }

    #[test]
    fn the_entry_is_named_for_where_the_system_shows_it() {
        assert_eq!(entry_name(Os::Mac, "OpenAgentd", "com.openagentd.desktop"), "com.openagentd.desktop.login");
        assert_eq!(entry_name(Os::Windows, "OpenAgentd", "com.openagentd.desktop"), "OpenAgentd");
        assert_eq!(entry_name(Os::Linux, "OpenAgentd", "com.openagentd.desktop"), "OpenAgentd");
    }
}
