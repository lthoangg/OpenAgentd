//! The name this computer goes by in the account, kept the same in both
//! places: the server name here (`routes::server_name`, what the person
//! typed or the host name) and the name the account keeps for the device
//! (`PUT /v1/devices/{id}/name`, what the other devices list).
//!
//! The identity file remembers the name both last agreed on
//! (`name_synced`), which tells a rename made here from one made on another
//! device: each contact merges three values ([`merge`]) and never loses the
//! newer change. Names are plain text and never decide trust.

use openagentd_cloud::api::{Cloud, DeviceInfo};
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::names::clean;
use openagentd_cloud::store as idstore;

use crate::routes::server_name::{current_name, store_custom_name};

/// What a contact does about the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Nothing,
    /// Tell the account this name (`None` clears it).
    Push(Option<String>),
    /// Take the account's name here (`None`: back to the host name).
    Adopt(Option<String>),
}

/// The step, and the name both agree on once it is done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    pub step: Step,
    pub synced: Option<String>,
}

fn merge_of(step: Step, synced: Option<&str>) -> Merge {
    Merge { step, synced: synced.map(String::from) }
}

/// Three-way merge of this computer's `local` name, the `cloud`'s name for
/// it and the name they last agreed on (`synced`):
///
/// - Never agreed: the account's name wins when it has one (a computer just
///   added is named by whoever added it, or here); otherwise ours is pushed.
/// - Agreed before: a change made here is pushed; else a change made in the
///   account is taken here (no name there: the host name again).
///
/// A computer with no name at all (`local` is `None`, it cannot read its
/// host name) never clears the account's name.
pub fn merge(local: Option<&str>, cloud: Option<&str>, synced: Option<&str>) -> Merge {
    match synced {
        None => match (cloud, local) {
            (Some(c), _) => merge_of(Step::Adopt(Some(c.to_string())), Some(c)),
            (None, Some(l)) => merge_of(Step::Push(Some(l.to_string())), Some(l)),
            (None, None) => merge_of(Step::Nothing, None),
        },
        Some(s) if local.is_some() && local != Some(s) => merge_of(Step::Push(local.map(String::from)), local),
        Some(s) if cloud != Some(s) => merge_of(Step::Adopt(cloud.map(String::from)), cloud),
        Some(s) => merge_of(Step::Nothing, Some(s)),
    }
}

/// Remembers the name this device and the account agree on.
pub(super) fn store_synced(name: Option<String>) {
    let store = super::identity_store();
    if let Ok(Some(mut id)) = idstore::load(&store) {
        if id.name_synced != name {
            id.name_synced = name;
            if let Err(e) = idstore::save(&store, &id) {
                tracing::warn!("cloud_name_save_failed error={e}");
            }
        }
    }
}

/// Takes `name` as this computer's own name (`None`: the host name).
pub(super) fn adopt(name: Option<String>) -> anyhow::Result<()> {
    if name.is_some() && current_name() == name {
        return Ok(());
    }
    store_custom_name(name)
}

/// After a contact (the device list `devices` was just read): makes this
/// computer's name and the account's one name. Best effort: a failure is
/// tried again at the next contact.
pub async fn sync(cloud: &Cloud, devices: &[DeviceInfo]) {
    let me = cloud.device_id();
    // Not listed (an older cloud) or departed: nothing to agree on.
    let Some(mine) = devices.iter().find(|d| d.device_id == me && !d.departed()) else { return };
    let Ok(Some(id)) = idstore::load(&super::identity_store()) else { return };
    let remote = mine.name.as_deref().and_then(clean);
    let m = merge(current_name().as_deref(), remote.as_deref(), id.name_synced.as_deref());
    match &m.step {
        Step::Nothing => {}
        Step::Push(name) => {
            if let Err(e) = cloud.set_device_name(&me, name.as_deref()).await {
                tracing::info!("cloud_name_push_failed code={}", e.code);
                return;
            }
        }
        Step::Adopt(name) => {
            if let Err(e) = adopt(name.clone()) {
                tracing::warn!("cloud_name_adopt_failed error={e}");
                return;
            }
        }
    }
    store_synced(m.synced);
}

/// Tells the account this computer's name now (`PUT /api/server/name`
/// changed it). Does nothing when this computer is not signed in, and
/// never fails: the next contact merges again.
pub async fn push_own_name() {
    let store = super::identity_store();
    let Ok(Some(id)) = idstore::load(&store) else { return };
    if id.account_id.is_none() || id.roster.is_none() {
        return;
    }
    let Ok(keys) = id.keys() else { return };
    let cloud = Cloud::new(super::http(), Endpoints::current(), keys, id.account_id.clone());
    let name = current_name();
    match cloud.set_device_name(&cloud.device_id(), name.as_deref()).await {
        Ok(_) => store_synced(name),
        Err(e) => tracing::info!("cloud_name_push_failed code={}", e.code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Option<&str> {
        Some(v)
    }

    fn step(local: Option<&str>, cloud: Option<&str>, synced: Option<&str>) -> (Step, Option<String>) {
        let m = merge(local, cloud, synced);
        (m.step, m.synced)
    }

    fn push(n: &str) -> Step {
        Step::Push(Some(n.into()))
    }

    fn adopt_of(n: &str) -> Step {
        Step::Adopt(Some(n.into()))
    }

    #[test]
    fn a_device_never_agreed_takes_the_accounts_name_or_gives_its_own() {
        // Just added: the account names it (whoever added it did).
        assert_eq!(step(s("studio"), s("Work Mac"), None), (adopt_of("Work Mac"), Some("Work Mac".into())));
        // The account has none: the computer names itself, so it is listed by name at once.
        assert_eq!(step(s("studio"), None, None), (push("studio"), Some("studio".into())));
        assert_eq!(step(None, None, None), (Step::Nothing, None));
    }

    #[test]
    fn a_change_made_here_is_pushed() {
        assert_eq!(step(s("Desk"), s("studio"), s("studio")), (push("Desk"), Some("Desk".into())));
        // Both changed since they agreed: this computer's rename wins.
        assert_eq!(step(s("Desk"), s("Work Mac"), s("studio")), (push("Desk"), Some("Desk".into())));
        // The account lost the name while this computer was renamed.
        assert_eq!(step(s("Desk"), None, s("studio")), (push("Desk"), Some("Desk".into())));
    }

    #[test]
    fn a_change_made_in_the_account_is_taken_here() {
        assert_eq!(step(s("studio"), s("Work Mac"), s("studio")), (adopt_of("Work Mac"), Some("Work Mac".into())));
        // Cleared there: the host name again.
        assert_eq!(step(s("studio"), None, s("studio")), (Step::Adopt(None), None));
    }

    #[test]
    fn nothing_changed_nothing_happens() {
        assert_eq!(step(s("studio"), s("studio"), s("studio")), (Step::Nothing, Some("studio".into())));
    }

    #[test]
    fn a_computer_that_cannot_name_itself_does_not_clear_the_accounts_name() {
        assert_eq!(step(None, s("studio"), s("studio")), (Step::Nothing, Some("studio".into())));
        assert_eq!(step(None, s("Work Mac"), s("studio")), (adopt_of("Work Mac"), Some("Work Mac".into())));
    }
}
