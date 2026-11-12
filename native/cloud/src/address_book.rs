//! Where a controller may reach each host directly (spec 5.5): the last
//! answer each host gave, by device id, with the networks this device was
//! on when it learned it. An address is offered only on that network
//! again ([`direct::may_try`]), so the phone does not greet strangers on
//! a café's network or try at all on mobile data.
//!
//! Only ever filled from a host's own answer inside a session: never from
//! a saved server, which is a different thing (the LAN listener and its
//! access key).

use std::collections::HashMap;
use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use crate::direct::{self, DirectAnswer, Subnet};

/// What is known about one host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub addrs: Vec<SocketAddr>,
    /// The networks this device was on when the host answered.
    pub networks: Vec<Subnet>,
}

/// Addresses by host device id. Serializable, so an app keeps it on disk
/// (it is not secret: private addresses of the account's own hosts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddressBook {
    hosts: HashMap<String, Entry>,
}

impl AddressBook {
    /// The host `device` answered `answer` while this device was on
    /// `networks`. Replaces what was known; an answer that is off, or has
    /// no private address, forgets the host.
    pub fn learned(&mut self, device: &str, answer: &DirectAnswer, networks: &[Subnet]) -> bool {
        let addrs = answer.targets();
        let networks: Vec<Subnet> = networks.iter().map(|n| n.network()).collect();
        let before = self.hosts.get(device).cloned();
        if addrs.is_empty() || networks.is_empty() {
            self.hosts.remove(device);
        } else {
            self.hosts.insert(device.to_string(), Entry { addrs, networks });
        }
        before != self.hosts.get(device).cloned()
    }

    /// The addresses to try for `device` on the networks this device is on
    /// now.
    pub fn candidates(&self, device: &str, current: &[Subnet]) -> Vec<SocketAddr> {
        let Some(e) = self.hosts.get(device) else { return Vec::new() };
        e.addrs.iter().filter(|a| direct::may_try(a.ip(), current, &e.networks)).copied().collect()
    }

    /// Drops hosts that are no longer among `devices` (removed from the
    /// account, or no longer servers).
    pub fn retain(&mut self, devices: impl Fn(&str) -> bool) {
        self.hosts.retain(|d, _| devices(d));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(s: &str, p: u8) -> Subnet {
        Subnet { ip: s.parse().unwrap(), prefix: p }
    }

    #[test]
    fn addresses_follow_the_network_they_were_learned_on() {
        let mut b = AddressBook::default();
        let answer: DirectAnswer = serde_json::from_str(r#"{"v":1,"on":true,"port":4181,"addrs":["192.168.1.20","fd12::20","8.8.8.8"]}"#).unwrap();
        let home = [sub("192.168.1.30", 24), sub("fd12::30", 64)];
        assert!(b.learned("H", &answer, &home));
        assert!(!b.learned("H", &answer, &home), "the same answer changes nothing");
        assert_eq!(b.candidates("H", &home).len(), 2);
        assert_eq!(b.candidates("H", &[sub("192.168.1.31", 24)]), vec!["192.168.1.20:4181".parse().unwrap()]);
        assert!(b.candidates("H", &[]).is_empty(), "mobile data");
        assert!(b.candidates("H", &[sub("10.0.0.2", 8)]).is_empty(), "another network");
        assert!(b.candidates("other", &home).is_empty());
        // Off forgets it; so does leaving the account.
        b.learned("H", &DirectAnswer::off(), &home);
        assert!(b.candidates("H", &home).is_empty());
        b.learned("H", &answer, &home);
        b.retain(|d| d != "H");
        assert!(b.candidates("H", &home).is_empty());
        // It round-trips through JSON.
        b.learned("H", &answer, &home);
        let back: AddressBook = serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
        assert_eq!(back, b);
    }
}
