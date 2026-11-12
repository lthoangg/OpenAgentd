//! The host's removal ledger (spec 3.3 and 5.5): devices the cloud said
//! were removed or left while the signed roster still lists them, and when
//! the host last heard from the cloud. Kept on disk with `K`, so a restart
//! without internet still refuses a device that left.
//!
//! Believing the cloud here is safe: it can only take access away.

use std::collections::BTreeSet;
use std::time::Duration;

use openagentd_cloud::api::DeviceInfo;
use openagentd_cloud::direct::CONTACT_VALID;
use openagentd_cloud::roster::Roster;
use openagentd_cloud::store::Identity;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ledger {
    departed: BTreeSet<String>,
    last_contact: Option<u64>,
}

impl Ledger {
    pub fn from_identity(id: &Identity) -> Ledger {
        Ledger { departed: id.departed.iter().cloned().collect(), last_contact: id.last_contact }
    }

    pub fn write_into(&self, id: &mut Identity) {
        id.departed = self.departed.iter().cloned().collect();
        id.last_contact = self.last_contact;
    }

    /// Whether `device` left or was removed.
    pub fn is_departed(&self, device: &str) -> bool {
        self.departed.contains(device)
    }

    /// Adds the listed ids the roster still lists (never `me`), and drops
    /// ids the roster no longer lists (it refuses those anyway). Returns the
    /// ids that are new.
    pub fn note(&mut self, roster: &Roster, me: &str, ids: &[String]) -> Vec<String> {
        self.prune(roster);
        let mut added = Vec::new();
        for d in ids {
            if d != me && roster.body.device(d).is_some() && self.departed.insert(d.clone()) {
                added.push(d.clone());
            }
        }
        added
    }

    /// [`Ledger::note`] for the devices `GET /v1/devices` shows as revoked.
    pub fn note_devices(&mut self, roster: &Roster, me: &str, devices: &[DeviceInfo]) -> Vec<String> {
        let ids: Vec<String> = devices.iter().filter(|d| d.revoked_at.is_some()).map(|d| d.device_id.clone()).collect();
        self.note(roster, me, &ids)
    }

    /// Keeps only ids `roster` still lists.
    pub fn prune(&mut self, roster: &Roster) {
        self.departed.retain(|d| roster.body.device(d).is_some());
    }

    /// The host heard from the cloud at `now_ms`.
    pub fn contacted(&mut self, now_ms: u64) {
        self.last_contact = Some(self.last_contact.map_or(now_ms, |t| t.max(now_ms)));
    }

    /// Whether the last contact is recent enough for direct sessions: at
    /// most [`CONTACT_VALID`] ago. Never contacted: not fresh.
    pub fn fresh(&self, now_ms: u64) -> bool {
        self.fresh_within(now_ms, CONTACT_VALID)
    }

    fn fresh_within(&self, now_ms: u64, valid: Duration) -> bool {
        self.last_contact.is_some_and(|t| now_ms.saturating_sub(t) < valid.as_millis() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openagentd_cloud::keys::{DeviceKeys, Roles};
    use openagentd_cloud::roster::{sign, Body, Device};

    fn roster(me: &DeviceKeys, others: &[&DeviceKeys]) -> Roster {
        let both = Roles::BOTH;
        let body = Body::genesis("acct", &[7; 32], Device::of(me, true, both));
        let mut devices = vec![Device::of(me, true, both)];
        devices.extend(others.iter().map(|k| Device::of(k, false, both)));
        sign(&Body { devices, ..body }, &me.id(), &me.sign)
    }

    fn info(id: &str, revoked: bool) -> DeviceInfo {
        serde_json::from_value(serde_json::json!({"device_id": id, "signer": false, "added_at": 1, "revoked_at": if revoked { Some(2) } else { None }})).unwrap()
    }

    #[test]
    fn a_device_that_left_is_remembered_from_either_source() {
        let (me, a, b) = (DeviceKeys::generate(), DeviceKeys::generate(), DeviceKeys::generate());
        let r = roster(&me, &[&a, &b]);
        let mut l = Ledger::default();
        assert_eq!(l.note(&r, &me.id(), &[a.id(), me.id(), "stranger".into()]), vec![a.id()]);
        assert_eq!(l.note_devices(&r, &me.id(), &[info(&a.id(), true), info(&b.id(), true), info(&me.id(), false)]), vec![b.id()]);
        assert!(l.is_departed(&a.id()) && l.is_departed(&b.id()) && !l.is_departed(&me.id()));
    }

    #[test]
    fn the_ledger_survives_a_restart_and_shrinks_with_the_roster() {
        let (me, a, b) = (DeviceKeys::generate(), DeviceKeys::generate(), DeviceKeys::generate());
        let r = roster(&me, &[&a, &b]);
        let mut l = Ledger::default();
        l.note(&r, &me.id(), &[a.id()]);
        l.contacted(1_000);
        let mut id = Identity::new(&me);
        l.write_into(&mut id);
        let json = serde_json::to_string(&id).unwrap();
        let back: Identity = serde_json::from_str(&json).unwrap();
        let l2 = Ledger::from_identity(&back);
        assert_eq!(l2, l);
        // A signer rewrote the roster without `a`: it leaves the ledger.
        let r2 = roster(&me, &[&b]);
        let mut l3 = l2.clone();
        l3.prune(&r2);
        assert!(!l3.is_departed(&a.id()));
        // An identity from before the ledger reads as empty.
        let old: Identity = serde_json::from_str(&json.replace(&format!(",\"departed\":[\"{}\"],\"last_contact\":1000", a.id()), "")).unwrap();
        assert_eq!(Ledger::from_identity(&old), Ledger::default());
    }

    #[test]
    fn direct_sessions_need_contact_within_seven_days() {
        let day = 86_400_000u64;
        let mut l = Ledger::default();
        assert!(!l.fresh(10 * day), "never contacted");
        l.contacted(10 * day);
        assert!(l.fresh(10 * day));
        assert!(l.fresh(16 * day + day - 1));
        assert!(!l.fresh(17 * day), "7 days without the cloud");
        // A clock that went back keeps the latest contact.
        l.contacted(9 * day);
        assert!(l.fresh(16 * day));
    }
}
