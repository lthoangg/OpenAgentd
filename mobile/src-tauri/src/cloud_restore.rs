//! The account stored on this phone, read when the app starts.
//!
//! The read runs beside the page's first load, and until it ends the
//! status says guest for a phone that is signed in. The page keeps the
//! answer it gets until the app comes back, and drops a tapped "A device
//! wants to join your account" on a guest one. So `cloud_status` waits
//! here first ([`finished`]), for at most [`WAIT`].

use super::*;

/// How long `cloud_status` waits. A key store that never answers must not
/// leave the page without a status.
pub(super) const WAIT: Duration = Duration::from_secs(3);

/// Loads a stored account at launch and brings its roster up to date.
pub(super) async fn run() {
    let found = read().await;
    // What is stored is known from here; the roster catches up afterwards.
    if let Some(p) = PHONE.get() {
        p.restored.send_replace(true);
    }
    if found {
        let _ = refresh().await;
    }
}

/// Reads the stored account into the status and the member; whether there
/// is one.
async fn read() -> bool {
    let Ok(p) = phone() else { return false };
    let loaded = tauri::async_runtime::spawn_blocking(|| {
        #[cfg(test)]
        tests::hold_this_read();
        phone().and_then(|p| p.keys.load())
    })
    .await
    .unwrap_or(Err("load failed".into()));
    let id = match loaded {
        Ok(Some(id)) if id.account_id.is_some() && id.roster.is_some() => id,
        Ok(_) => return false,
        Err(e) => {
            eprintln!("cloud: stored account unreadable: {e}");
            set_status(guest(Some(Notice::Failed)));
            return false;
        }
    };
    let Ok(keys) = id.keys_without_sign() else {
        return false;
    };
    let Some(Ok(known)) = id.roster.as_deref().map(roster::parse) else {
        return false;
    };
    let member = Member::new(
        Cloud::new(http(), Endpoints::current(), keys, id.account_id.clone()),
        Some(known),
    );
    set_status(connected_status(&member));
    publish_push_context(Some(&member));
    *p.member.lock().await = Some(member);
    true
}

/// Waits, for at most `limit`, until the stored account has been read;
/// whether it has.
pub(crate) async fn finished(limit: Duration) -> bool {
    let Some(p) = PHONE.get() else { return true };
    let mut restored = p.restored.subscribe();
    let read = tokio::time::timeout(limit, restored.wait_for(|read| *read))
        .await
        .is_ok_and(|open| open.is_ok());
    read
}

#[cfg(test)]
#[path = "tests/cloud_restore.rs"]
mod tests;
