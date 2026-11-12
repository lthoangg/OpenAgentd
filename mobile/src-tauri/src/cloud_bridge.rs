//! The loopback bridge in front of each account computer the phone opens
//! (plan decision D7). The bridge itself is `openagentd_cloud::bridge`,
//! shared with the desktop app's server; the phone allows only its own
//! webview's origins.

pub use openagentd_cloud::bridge::{Bridge, Io, Opener};

/// The webview origins of the mobile app (iOS, then Android).
pub const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// Whether a page origin is this app's webview.
pub fn app_origin(origin: &str) -> bool {
    APP_ORIGINS.contains(&origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_webviews_may_use_a_bridge() {
        for o in APP_ORIGINS {
            assert!(app_origin(o), "{o}");
        }
        for o in ["http://localhost:5173", "https://attacker.example", "null", ""] {
            assert!(!app_origin(o), "{o}");
        }
    }
}
