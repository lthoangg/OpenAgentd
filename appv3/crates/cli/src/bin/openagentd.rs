//! `openagentd`: the pre-rename name of `agentd`. Existing installs, scripts,
//! Homebrew users, and `openagentd upgrade` from releases before the rename
//! (which refuses an archive without an `openagentd` executable) still call
//! it, so it forwards every argument to the `agentd` beside it.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

/// `agentd` in this executable's directory, else `agentd` on `PATH`.
fn target() -> PathBuf {
    let name = format!("agentd{}", std::env::consts::EXE_SUFFIX);
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(&name))).filter(|p| p.is_file()).unwrap_or_else(|| name.into())
}

fn main() -> ExitCode {
    if std::io::stderr().is_terminal() {
        eprintln!("note: `openagentd` is now `agentd`; the old name will be removed in a future release");
    }
    let mut cmd = Command::new(target());
    cmd.args(std::env::args_os().skip(1));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        eprintln!("openagentd: could not run agentd: {err}");
        ExitCode::FAILURE
    }
    #[cfg(windows)]
    {
        // The child shares the console and handles Ctrl-C itself; this
        // process only waits for it and forwards its exit code.
        unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 1) };
        match cmd.status() {
            Ok(s) => std::process::exit(s.code().unwrap_or(1)),
            Err(err) => {
                eprintln!("openagentd: could not run agentd: {err}");
                ExitCode::FAILURE
            }
        }
    }
}
