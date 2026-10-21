//! Built-in web preview.
//!
//! Each preview gets its own loopback listener (`127.0.0.1:<port>`), so the
//! previewed page runs on an origin separate from the app: it cannot read
//! the app's DOM, storage, or access key, and cannot call `/api`. The
//! listener either proxies a local dev server or serves a workspace
//! directory, and adds [`INSPECTOR_PATH`] to HTML pages. That script
//! reports navigation, picks elements for design comments, and forwards
//! console output to [`CONSOLE_PATH`]. It also runs the agent's commands
//! (snapshot, click, fill, …) that it long-polls from [`AGENT_PATH`].
//!
//! Clients on another device reach a listener through [`tunnel`]: their
//! native relay listens on the device's own loopback and carries raw TCP
//! over an authenticated WebSocket.

pub mod agent;
pub mod console;
mod inject;
mod manager;
mod proxy;
mod static_files;
pub mod target;
pub mod tunnel;
mod ws;

pub use manager::{global, static_backend, Entry, Manager, PreviewError, PreviewInfo, TunnelSlot, IDLE_SECS, MAX_ALIAS_PORTS, MAX_PREVIEWS, MAX_TUNNELS};
pub use static_files::{resolve_workspace_file, url_path};
pub use target::{parse_url_target, Backend, TargetError, UrlTarget};

/// Paths the preview listener answers itself instead of forwarding.
pub const RESERVED_PREFIX: &str = "/__openagentd/";
pub const INSPECTOR_PATH: &str = "/__openagentd/inspector.js";
pub const CONSOLE_PATH: &str = "/__openagentd/console";
pub const AGENT_PATH: &str = "/__openagentd/agent";

pub(crate) const INSPECTOR_JS: &str = include_str!("../assets/inspector.js");

/// Record a port the API listens on, so no preview can proxy to it.
pub fn block_port(port: u16) {
    global().block_port(port);
}

/// Stop every preview listener (server shutdown).
pub fn shutdown() {
    global().shutdown();
}
