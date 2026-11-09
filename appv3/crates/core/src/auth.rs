//! Access-token policy (the HTTP middleware lives in the api crate).

use crate::runtime_settings::load_server_settings;
use std::sync::OnceLock;

pub const DESKTOP_TOKEN_ENV: &str = "OPENAGENTD_DESKTOP_TOKEN";
pub const ACCESS_KEY_ENV: &str = "OPENAGENTD_ACCESS_KEY";
/// Windows desktop fallback: where `server serve --handshake` also writes
/// its handshake line.
pub const HANDSHAKE_FILE_ENV: &str = "OPENAGENTD_HANDSHAKE_FILE";
pub const QS_TOKEN_PARAM: &str = "_token";

/// Server-process variables no child process may inherit: any child holding
/// the token could call the API with full rights.
pub const CHILD_ENV_SECRETS: [&str; 3] = [DESKTOP_TOKEN_ENV, ACCESS_KEY_ENV, HANDSHAKE_FILE_ENV];

/// Set to `1` in every process an agent can drive: the server and
/// `agentd run` set it on themselves before any thread starts, so the
/// agent's shell commands, git hooks, plugins and package installs inherit
/// it, and the spawners that start from an empty environment (MCP servers,
/// language servers) add it back. The user's own terminal tabs drop it.
/// `agentd cloud approve` refuses to run under it: approving a device is for
/// the person, not for an agent (`tunnel-threats.md`, "Computer signers").
pub const AGENT_MARKER_ENV: &str = "AGENTD_AGENT";

/// Marks this process (and so its children) as agent-driven. Call before
/// the async runtime starts: environment mutation is not thread-safe.
pub fn mark_agent_process() {
    std::env::set_var(AGENT_MARKER_ENV, "1");
}

/// Whether an agent drives this process (see [`AGENT_MARKER_ENV`]).
pub fn is_agent_process() -> bool {
    std::env::var_os(AGENT_MARKER_ENV).is_some_and(|v| !v.is_empty())
}

static DESKTOP_SESSION: OnceLock<bool> = OnceLock::new();

/// Whether the desktop app started this process (it passes a token).
pub fn is_desktop_session() -> bool {
    *DESKTOP_SESSION.get_or_init(|| std::env::var(DESKTOP_TOKEN_ENV).is_ok_and(|v| !v.is_empty()))
}

/// Remove [`CHILD_ENV_SECRETS`] from the process environment once the
/// server has read them, so nothing it spawns (agent shell, terminal, git
/// hooks, package installs, MCP servers, plugins) inherits them. Call before
/// the async runtime starts: environment mutation is not thread-safe.
pub fn scrub_child_env_secrets() {
    is_desktop_session();
    for k in CHILD_ENV_SECRETS {
        std::env::remove_var(k);
    }
}

/// `configured_access_token()`: desktop token > access-key env > server.yaml.
pub fn configured_access_token() -> String {
    std::env::var(DESKTOP_TOKEN_ENV)
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var(ACCESS_KEY_ENV).ok().filter(|v| !v.is_empty()))
        .or_else(|| load_server_settings().ok().and_then(|s| s.access_key).filter(|v| !v.is_empty()))
        .unwrap_or_default()
}

const EXEMPT_EXACT: [&str; 9] = ["/api/health/live", "/api/health/ready", "/", "/index.html", "/favicon.ico", "/favicon.svg", "/vite.svg", "/robots.txt", "/manifest.json"];
const EXEMPT_PREFIXES: [&str; 3] = ["/api/health/", "/assets/", "/static/"];

pub fn path_is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// Paths reachable without a token (probes and the SPA shell).
pub fn path_is_exempt(path: &str) -> bool {
    EXEMPT_EXACT.contains(&path) || EXEMPT_PREFIXES.iter().any(|p| path.starts_with(p)) || !path_is_api(path)
}

/// Constant-time string comparison (`hmac.compare_digest`).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether `host` names a loopback address.
pub fn is_loopback_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    h.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// Host part of a `Host` header or origin authority (`h`, `h:port`,
/// `[v6]:port`). `None` for anything with userinfo or a malformed port.
pub fn authority_host(authority: &str) -> Option<&str> {
    if authority.is_empty() || authority.contains(['@', '/', '?', '#']) {
        return None;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        return (tail.is_empty() || tail.strip_prefix(':').is_some_and(|p| p.bytes().all(|b| b.is_ascii_digit()))).then_some(host);
    }
    match authority.split_once(':') {
        None => Some(authority),
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => Some(host),
        _ => None,
    }
}

/// Whether a host name can only mean this machine. Browsers resolve
/// `*.localhost` to loopback themselves, so DNS rebinding cannot reach it.
pub fn is_local_host_name(host: &str) -> bool {
    let h = host.strip_suffix('.').unwrap_or(host);
    const SUFFIX: &[u8] = b".localhost";
    let b = h.as_bytes();
    is_loopback_host(h) || b.len() > SUFFIX.len() && b[b.len() - SUFFIX.len()..].eq_ignore_ascii_case(SUFFIX)
}

/// Whether an `Origin` belongs to a first-party client on this machine: the
/// Tauri webviews (`tauri://localhost` on macOS/iOS/Linux,
/// `http(s)://tauri.localhost` on Windows/Android) and pages served from
/// loopback, such as the Vite dev server.
pub fn is_first_party_origin(origin: &str) -> bool {
    if origin == "tauri://localhost" {
        return true;
    }
    let Some(authority) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else { return false };
    authority_host(authority).is_some_and(is_local_host_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exemptions_match_v2() {
        assert!(path_is_exempt("/api/health/live"));
        assert!(path_is_exempt("/api/health/anything"));
        assert!(path_is_exempt("/assets/app.js"));
        assert!(path_is_exempt("/settings/providers"));
        assert!(!path_is_exempt("/api/health"));
        assert!(!path_is_exempt("/api/agent/chat"));
        assert!(!path_is_exempt("/api"));
    }

    #[test]
    fn compare() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(!is_loopback_host("192.168.1.2"));
    }

    #[test]
    fn authority_host_parsing() {
        assert_eq!(authority_host("localhost:8000"), Some("localhost"));
        assert_eq!(authority_host("127.0.0.1"), Some("127.0.0.1"));
        assert_eq!(authority_host("[::1]:4082"), Some("::1"));
        assert_eq!(authority_host("[::1]"), Some("::1"));
        assert_eq!(authority_host("evil.example@localhost"), None);
        assert_eq!(authority_host("localhost:80x"), None);
        assert_eq!(authority_host("localhost:"), None);
        assert_eq!(authority_host("[::1]x"), None);
        assert_eq!(authority_host(""), None);
    }

    #[test]
    fn local_host_names() {
        for h in ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.8.9.10", "::1", "app.localhost", "a.b.LocalHost"] {
            assert!(is_local_host_name(h), "{h}");
        }
        for h in ["attacker.example", "localhost.evil.example", "127.0.0.1.nip.io", "192.168.1.100", ".localhost", "evillocalhost", "", "é.localhosté"] {
            assert!(!is_local_host_name(h), "{h}");
        }
    }

    #[test]
    fn first_party_origins() {
        for o in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://[::1]:5173",
            "https://app.localhost",
        ] {
            assert!(is_first_party_origin(o), "{o}");
        }
        for o in [
            "null",
            "https://evil.example",
            "tauri://evil",
            "http://localhost.evil.example",
            "http://192.168.1.100:5173",
            "file://",
            "http://evil.example@localhost",
            "http://localhost:5173/path",
            "ws://localhost",
        ] {
            assert!(!is_first_party_origin(o), "{o}");
        }
    }
}
