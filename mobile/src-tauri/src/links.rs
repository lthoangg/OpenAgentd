//! How many links (`openagentd://…`) the app has been opened with this run.
//!
//! The deep-link plugin reports the last link for the life of the app, so a
//! page that reloads reads it again, and the web UI skips a link it already
//! handled (`web/src/hooks/useDeepLinkRouter.ts`). The link alone cannot
//! tell a handled one from the same one opened again while no page was
//! listening: a home-screen widget's row or its New session button has one
//! fixed link, and iOS ends the page of an app in the background. The count
//! tells them apart: it moves with every link that arrives.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Listener};

/// The event the deep-link plugin emits for each link that arrives.
const NEW_URL_EVENT: &str = "deep-link://new-url";

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn arrived() {
    SEQUENCE.fetch_add(1, Ordering::SeqCst);
}

/// Starts counting. Call once from `setup`, before any link arrives.
pub fn install(app: &AppHandle) {
    app.listen(NEW_URL_EVENT, |_| arrived());
}

/// The links that have arrived this run. Not a secret, and never the links.
#[tauri::command]
pub fn deep_link_sequence() -> u64 {
    SEQUENCE.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_link_that_arrives_moves_the_count() {
        let before = deep_link_sequence();
        arrived();
        arrived();
        assert_eq!(deep_link_sequence(), before + 2);
    }
}
