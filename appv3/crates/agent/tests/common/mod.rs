//! Helpers shared by this crate's integration tests. Each test file is its
//! own binary and uses only some of them.
#![allow(dead_code)]

use std::time::{Duration, Instant};

/// Point every settings root, `HOME` and the agents folder at `root`, with
/// title generation off and one `code` agent on the mock model. Settings are
/// process-wide, so call it once per test binary.
pub fn setup_roots(root: &std::path::Path) {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("USERPROFILE", root.join("home"));
    std::env::remove_var("CHAT_WORKSPACE_DIR");
    std::env::remove_var("AGENTS_DIR");
    std::env::set_var("OPENAGENTD_SHELL_SNAPSHOT", "false");
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config").join("settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let agents = appv3_core::settings::settings().agents_dir.clone();
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("code.md"), "---\nname: code\nmodel: mock:mock\ntools: []\n---\nYou are the coding agent.\n").unwrap();
}

/// How long a test waits for something the runtime does in the background.
/// Far longer than it takes, so a loaded machine does not fail the test.
const LIMIT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(20);

/// Returns once `done` is true; panics, naming `what`, if that takes 20 s.
/// Use it instead of sleeping for a time the work is expected to fit in.
pub async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + LIMIT;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(POLL).await;
    }
}

/// [`wait_until`] for a condition that has to await (a database read).
pub async fn wait_until_async(what: &str, mut done: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + LIMIT;
    while !done().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(POLL).await;
    }
}
