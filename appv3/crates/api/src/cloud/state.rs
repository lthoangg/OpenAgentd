//! The host's cloud state machine (`appv3/AGENTS.md` → State machines):
//! the one [`Status`] `GET /api/cloud/status` reports, and the one owner of
//! writes to the stored identity.
//!
//! [`Status`] moves in two groups. Signing in or joining (guest and its
//! steps) may go to any of its steps, back to guest, or to connected; a
//! signed-in host (connected, closing, unavailable) moves among those or
//! back to guest. A signed-in host never shows a sign-in step, and an
//! account problem only follows signing in.
//!
//! The identity file is read, changed and saved by several tasks (the
//! roster, the ledger, the name sync). [`update_identity`] is the one way
//! to change it, under one lock, so two changes at once both survive.

use super::Status;
use appv3_core::machine::{self, IllegalTransition, Machine};
use openagentd_cloud::store::{self as idstore, Identity, SecretStore};
use std::sync::Mutex;

/// Moves to the status the event carries.
pub struct StatusMachine;

impl Machine for StatusMachine {
    const NAME: &'static str = "cloud host";
    const TRANSITIONS: &'static [(&'static str, &'static str, &'static str)] = &[
        ("guest", "guest", "guest"),
        ("guest", "signing_in", "signing_in"),
        ("guest", "recovery", "recovery"),
        ("guest", "joining", "joining"),
        ("guest", "invited", "invited"),
        ("guest", "scanned", "scanned"),
        ("guest", "confirming", "confirming"),
        ("guest", "connected", "connected"),
        ("signing_in", "guest", "guest"),
        ("signing_in", "signing_in", "signing_in"),
        ("signing_in", "recovery", "recovery"),
        ("signing_in", "joining", "joining"),
        ("signing_in", "invited", "invited"),
        ("signing_in", "scanned", "scanned"),
        ("signing_in", "confirming", "confirming"),
        ("signing_in", "connected", "connected"),
        ("recovery", "guest", "guest"),
        ("recovery", "signing_in", "signing_in"),
        ("recovery", "recovery", "recovery"),
        ("recovery", "joining", "joining"),
        ("recovery", "invited", "invited"),
        ("recovery", "scanned", "scanned"),
        ("recovery", "confirming", "confirming"),
        ("recovery", "connected", "connected"),
        ("joining", "guest", "guest"),
        ("joining", "signing_in", "signing_in"),
        ("joining", "recovery", "recovery"),
        ("joining", "joining", "joining"),
        ("joining", "invited", "invited"),
        ("joining", "scanned", "scanned"),
        ("joining", "confirming", "confirming"),
        ("joining", "connected", "connected"),
        ("invited", "guest", "guest"),
        ("invited", "signing_in", "signing_in"),
        ("invited", "recovery", "recovery"),
        ("invited", "joining", "joining"),
        ("invited", "invited", "invited"),
        ("invited", "scanned", "scanned"),
        ("invited", "confirming", "confirming"),
        ("invited", "connected", "connected"),
        ("scanned", "guest", "guest"),
        ("scanned", "signing_in", "signing_in"),
        ("scanned", "recovery", "recovery"),
        ("scanned", "joining", "joining"),
        ("scanned", "invited", "invited"),
        ("scanned", "scanned", "scanned"),
        ("scanned", "confirming", "confirming"),
        ("scanned", "connected", "connected"),
        ("confirming", "guest", "guest"),
        ("confirming", "signing_in", "signing_in"),
        ("confirming", "recovery", "recovery"),
        ("confirming", "joining", "joining"),
        ("confirming", "invited", "invited"),
        ("confirming", "scanned", "scanned"),
        ("confirming", "confirming", "confirming"),
        ("confirming", "connected", "connected"),
        ("connected", "connected", "connected"),
        ("connected", "closing", "closing"),
        ("connected", "unavailable", "unavailable"),
        ("connected", "guest", "guest"),
        ("closing", "connected", "connected"),
        ("closing", "closing", "closing"),
        ("closing", "unavailable", "unavailable"),
        ("closing", "guest", "guest"),
        ("unavailable", "connected", "connected"),
        ("unavailable", "closing", "closing"),
        ("unavailable", "unavailable", "unavailable"),
        ("unavailable", "guest", "guest"),
    ];
    type State = Status;
    type Event = Status;

    fn state_kind(s: &Status) -> &'static str {
        match s {
            Status::Guest { .. } => "guest",
            Status::SigningIn { .. } => "signing_in",
            Status::Recovery { .. } => "recovery",
            Status::Joining { .. } => "joining",
            Status::Invited { .. } => "invited",
            Status::Scanned { .. } => "scanned",
            Status::Confirming { .. } => "confirming",
            Status::Connected { .. } => "connected",
            Status::Closing { .. } => "closing",
            Status::Unavailable { .. } => "unavailable",
        }
    }

    fn event_kind(e: &Status) -> &'static str {
        Self::state_kind(e)
    }

    fn step(s: &Status, e: &Status) -> Option<Status> {
        let signed_in = |k: &str| matches!(k, "connected" | "closing" | "unavailable");
        let (from, to) = (Self::state_kind(s), Self::state_kind(e));
        let allowed = if signed_in(from) { signed_in(to) || to == "guest" } else { !signed_in(to) || to == "connected" };
        allowed.then(|| e.clone())
    }
}

/// Move the host's status to `next`.
pub(super) fn transition(status: &mut Status, next: Status) -> Result<(), IllegalTransition> {
    machine::apply::<StatusMachine>(status, &next)
}

static IDENTITY_WRITES: Mutex<()> = Mutex::new(());

/// Change the stored identity with `change`, which returns whether it
/// changed anything; nothing is saved when it did not, or when no identity
/// is stored. Every writer goes through here, under one lock.
pub(crate) fn update_identity(store: &dyn SecretStore, change: impl FnOnce(&mut Identity) -> bool) -> std::io::Result<bool> {
    let _one_writer = IDENTITY_WRITES.lock().unwrap_or_else(|p| p.into_inner());
    let Some(mut id) = idstore::load(store)? else { return Ok(false) };
    if !change(&mut id) {
        return Ok(false);
    }
    idstore::save(store, &id)?;
    Ok(true)
}

/// Erase the identity (sign-out, a deleted or revoked account), under the
/// same lock: a change loaded before the erase cannot save it back.
pub(crate) fn clear_identity(store: &openagentd_cloud::store::FileStore) -> std::io::Result<()> {
    let _one_writer = IDENTITY_WRITES.lock().unwrap_or_else(|p| p.into_inner());
    store.clear()
}

/// Store a whole identity (a join), under the same lock.
pub(crate) fn save_identity(store: &dyn SecretStore, identity: &Identity) -> std::io::Result<()> {
    let _one_writer = IDENTITY_WRITES.lock().unwrap_or_else(|p| p.into_inner());
    idstore::save(store, identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::{Notice, RelayState};

    fn samples() -> Vec<Status> {
        let fp = || "fp".to_string();
        vec![
            Status::Guest { notice: Some(Notice::SignedOut), retry_after: None },
            Status::SigningIn { user_code: "c".into(), url: "u".into(), fingerprint: fp(), expires_in: 1, add_link: None, recovering: false },
            Status::Recovery { code: "c".into(), check: [1, 2] },
            Status::Joining { fingerprint: fp(), code: None },
            Status::Invited { fingerprint: fp(), kind: None },
            Status::Scanned { fingerprint: fp() },
            Status::Confirming { fingerprint: fp(), choices: ["a".into(), "b".into(), "c".into()] },
            Status::Connected { fingerprint: fp(), signer: false, server: true, client: true, relay: RelayState::Connecting, sessions: 0, recovered: false },
            Status::Closing { fingerprint: fp(), deletes_at: None },
            Status::Unavailable { fingerprint: fp() },
        ]
    }

    #[test]
    fn step_allows_exactly_the_table() {
        machine::check_table::<StatusMachine>(&samples(), &samples());
    }

    #[test]
    fn a_signed_in_host_never_shows_a_sign_in_step() {
        let s = samples();
        assert_eq!(StatusMachine::step(&s[7], &s[1]), None, "connected → signing in");
        assert_eq!(StatusMachine::step(&s[1], &s[8]), None, "signing in → closing");
    }

    /// Two writers changing different fields at once both keep their change.
    #[test]
    fn concurrent_identity_changes_both_survive() {
        let dir = tempfile::tempdir().unwrap();
        let store = openagentd_cloud::store::FileStore::new(dir.path().join("identity.json"));
        let id = Identity {
            v: 1,
            auth: String::new(),
            r#box: String::new(),
            sign: String::new(),
            account_id: None,
            roster: None,
            problem: None,
            departed: vec![],
            last_contact: None,
            name_synced: None,
        };
        idstore::save(&store, &id).unwrap();
        std::thread::scope(|s| {
            for i in 0..2 {
                let store = &store;
                s.spawn(move || {
                    for n in 0..40 {
                        update_identity(store, |id| {
                            if i == 0 {
                                id.roster = Some(format!("r{n}"))
                            } else {
                                id.name_synced = Some(format!("n{n}"))
                            }
                            true
                        })
                        .unwrap();
                    }
                });
            }
        });
        let id = idstore::load(&store).unwrap().unwrap();
        assert_eq!((id.roster.as_deref(), id.name_synced.as_deref()), (Some("r39"), Some("n39")));
    }
}
