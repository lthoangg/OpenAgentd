//! The key that proves the person approved a roster change in the desktop
//! app (`openagentd_cloud::approval`, `tunnel-threats.md`, "Computer
//! signers").
//!
//! Only the desktop app's own server has one: the app hands it over the
//! server's stdin at start (`agentd server serve --approval-key-stdin`), and
//! it lives in this process's memory only. A server started any other way
//! has none, so its routes that sign a roster refuse every request; the
//! person approves with `agentd cloud approve` in a terminal instead.
//!
//! The app writes one line (the key, unpadded base64url) into a pipe that is
//! the server's stdin, then closes it. The key is never in the environment,
//! a file, the command line or a log. [`read_key_from_stdin`] reads it
//! straight from the descriptor (not through `std::io::stdin()`, whose
//! buffer would keep a copy for the life of the process) into memory
//! zeroized on drop, then points stdin at `/dev/null`, which closes the
//! pipe: nothing the server starts later (the agent's shell, a terminal, MCP
//! or language servers) can inherit it. Every other descriptor Rust opens is
//! close-on-exec. On Windows the pipe stays open but drained, and the app has
//! closed its end, so a child that inherits it reads end-of-file.

use std::fs::File;
use std::io::Read;
use std::mem::ManuallyDrop;
use std::sync::RwLock;

use axum::http::HeaderMap;
use openagentd_cloud::approval::{self, Action, KEY_LEN};
use zeroize::Zeroizing;

use crate::error::{ApiError, ApiResult};

static KEY: RwLock<Option<Zeroizing<[u8; KEY_LEN]>>> = RwLock::new(None);

/// What a refused approval says; stable, the web UI shows it as is.
pub const APPROVE_ELSEWHERE: &str = "Approve in the OpenAgentd app on this computer, or run agentd cloud approve in Terminal.";
/// What a refused removal says.
pub const REMOVE_ELSEWHERE: &str = "Remove devices in the OpenAgentd app on this computer.";

/// Installs the key the desktop app handed over. The previous one, if any,
/// is zeroized as it drops.
pub fn install_key(key: Zeroizing<[u8; KEY_LEN]>) {
    *KEY.write().expect("approval key") = Some(key);
}

/// Forgets the key (tests: a server the desktop app did not start).
#[doc(hidden)]
pub fn clear_key() {
    *KEY.write().expect("approval key") = None;
}

/// Whether this server can accept an approval from the app at all.
pub fn has_key() -> bool {
    KEY.read().expect("approval key").is_some()
}

/// Refuses unless the request carries the app's proof for `action` on `id`.
pub(super) fn require(headers: &HeaderMap, action: Action, id: &str) -> ApiResult<()> {
    let refused = || {
        let text = if matches!(action, Action::Remove) { REMOVE_ELSEWHERE } else { APPROVE_ELSEWHERE };
        ApiError::new(403, text)
    };
    let guard = KEY.read().expect("approval key");
    let Some(key) = guard.as_ref() else {
        tracing::warn!("cloud_approval_refused reason=no_key");
        return Err(refused());
    };
    let Some(given) = headers.get(approval::HEADER).and_then(|v| v.to_str().ok()) else {
        tracing::warn!("cloud_approval_refused reason=no_proof");
        return Err(refused());
    };
    if !approval::verify(key, action, id, given) {
        tracing::warn!("cloud_approval_refused reason=bad_proof");
        return Err(refused());
    }
    Ok(())
}

/// Longest line accepted: the key is 43 characters.
const MAX_LINE: usize = 128;

/// `agentd server serve --approval-key-stdin`: reads the key from stdin,
/// then detaches stdin. `None` when the line is missing or malformed: the
/// server then refuses every approval, as one the app did not start. Call
/// before any thread starts.
pub fn read_key_from_stdin() -> Option<Zeroizing<[u8; KEY_LEN]>> {
    let mut stdin = ManuallyDrop::new(stdin_file());
    let mut line = Zeroizing::new([0u8; MAX_LINE]);
    let mut n = 0;
    while n < MAX_LINE {
        match stdin.read(&mut line[n..]) {
            Ok(0) => break,
            Ok(k) => {
                n += k;
                if line[..n].contains(&b'\n') {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    detach_stdin();
    let end = line[..n].iter().position(|&b| b == b'\n').unwrap_or(n);
    approval::parse_key(&line[..end])
}

#[cfg(unix)]
fn stdin_file() -> File {
    use std::os::fd::FromRawFd;
    // SAFETY: fd 0 is open for the life of the process; the caller wraps
    // the File in ManuallyDrop, so it is never closed through it.
    unsafe { File::from_raw_fd(0) }
}

#[cfg(windows)]
fn stdin_file() -> File {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    // SAFETY: as above, borrowed and never closed through the File.
    unsafe { File::from_raw_handle(std::io::stdin().as_raw_handle()) }
}

/// Points fd 0 at `/dev/null`, closing the pipe the key came through.
#[cfg(unix)]
fn detach_stdin() {
    use std::os::fd::AsRawFd;
    if let Ok(null) = File::open("/dev/null") {
        // SAFETY: dup2 onto fd 0 from a valid open descriptor.
        unsafe {
            libc::dup2(null.as_raw_fd(), 0);
        }
    }
}

#[cfg(windows)]
fn detach_stdin() {}
