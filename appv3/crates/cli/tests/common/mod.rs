//! Helpers shared by this crate's integration tests. Each test file is its
//! own binary and uses only some of them.
#![allow(dead_code)]

use std::net::TcpListener;
use std::path::Path;
use std::process::Command;

/// Point `cmd` at throw-away `HOME`/XDG roots under `root`, and drop every
/// variable that could aim it at real data or hand it a real secret.
pub fn sandbox(cmd: &mut Command, root: &Path) {
    std::fs::create_dir_all(root.join("home")).unwrap();
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ("HOME", "home"),
    ] {
        cmd.env(k, root.join(d));
    }
    cmd.env("OPENAGENTD_ENV", "production").env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false").env("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false").env("NO_COLOR", "1");
    for k in [
        "OPENAGENTD_DESKTOP_TOKEN",
        "OPENAGENTD_ACCESS_KEY",
        "OPENAGENTD_HANDSHAKE_FILE",
        "DATABASE_URL",
        "OPENAGENTD_DATABASE_URL",
        "AGENTS_DIR",
        "OPENAGENTD_AGENTS_DIR",
        "SKILLS_DIR",
        "OPENAGENTD_SKILLS_DIR",
        "OPENAGENTD_PLUGINS_DIRS",
        "CHAT_WORKSPACE_DIR",
        "OPENAGENTD_CHAT_WORKSPACE_DIR",
        "APP_ENV",
        "RUST_LOG",
        "LOG_LEVEL",
        "OPENAGENTD_LOG_LEVEL",
        "OPENAI_API_KEY",
    ] {
        cmd.env_remove(k);
    }
}

/// A port nothing listens on right now.
pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}
