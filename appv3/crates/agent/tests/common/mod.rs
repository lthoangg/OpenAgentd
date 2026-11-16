//! Helpers shared by this crate's integration tests. Each test file is its
//! own binary and uses only some of them.
#![allow(dead_code)]

use std::time::{Duration, Instant};

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
