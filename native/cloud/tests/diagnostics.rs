//! The phone's "Copy diagnostics" lines: what happened to its bridges and
//! links, in plain words, and never a key, token, id, address or query.

use std::time::{Duration, SystemTime};

use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::diag::{Diagnostics, Event, KEPT};
use openagentd_cloud::keys::{fingerprint, DeviceKeys};
use openagentd_cloud::link::{DownReason, LinkState, Route};
use openagentd_cloud::relay::{EndCause, TunnelEnd};

#[test]
fn the_lines_name_computers_by_fingerprint_and_hold_no_secret() {
    let device_id = DeviceKeys::generate().id();
    let fp = fingerprint(&device_id).unwrap();
    let d = Diagnostics::default();
    let at = SystemTime::now();
    let id = || device_id.clone();
    d.record(Event::AppAway);
    d.record(Event::AppBack);
    d.record(Event::BridgeChecked { device_id: id(), answering: false });
    d.record(Event::BridgeReopened { device_id: id(), moved: false });
    d.record(Event::Link { device_id: id(), state: LinkState::Connecting });
    d.record(Event::Link { device_id: id(), state: LinkState::Up { route: Route::Direct { addr: "192.168.1.20:4181".parse().unwrap() }, since: at } });
    d.record(Event::Link { device_id: id(), state: LinkState::Up { route: Route::Relay, since: at } });
    d.record(Event::Link { device_id: id(), state: LinkState::Down { reason: DownReason::Refused("bad?_token=s3cret&url=https://x.example/?q=1".into()), retry_at: None } });
    d.record(Event::Link { device_id: id(), state: LinkState::Down { reason: DownReason::Account(AccountProblem::RemovalSignal), retry_at: Some(at + Duration::from_secs(3)) } });
    d.record(Event::SessionEnded {
        device_id: id(),
        end: TunnelEnd { cause: EndCause::Protocol, code: 4002, lived: Duration::from_millis(700), quiet: Duration::ZERO, ponged: false },
    });
    d.record(Event::BridgeRequests { device_id: id(), served: 14, unauthorized: 2, forbidden: 1 });
    d.record(Event::OpenFailed { device_id: id() });
    let lines = d.lines();
    let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    let all = text.join("\n");
    assert!(text.contains(&"app away") && text.contains(&"app back"), "{all}");
    assert!(text.contains(&format!("bridge {fp}: not answering").as_str()), "{all}");
    assert!(text.contains(&format!("bridge {fp}: reopened on the same address").as_str()), "{all}");
    assert!(text.contains(&format!("link {fp}: up, on your network").as_str()), "{all}");
    assert!(text.contains(&format!("link {fp}: up, through your account").as_str()), "{all}");
    assert!(all.contains("cause=protocol code=4002"), "{all}");
    assert!(all.contains("14 requests, 3 refused (401: 2, 403: 1)"), "{all}");
    for secret in [device_id.as_str(), "192.168", "4181", "s3cret", "_token", "https", "x.example", "?", "&", "="] {
        // `cause=… code=…` is the one place '=' may appear.
        let scan = all.replace("cause=", "").replace("code=", "").replace("secs=", "").replace("quiet_secs=", "").replace("ponged=", "");
        assert!(!scan.contains(secret), "{secret:?} in:\n{all}");
    }
    assert!(lines.iter().all(|l| l.at_ms > 0));
}

#[test]
fn only_the_last_events_are_kept() {
    let d = Diagnostics::default();
    for _ in 0..KEPT + 10 {
        d.record(Event::AppAway);
    }
    d.record(Event::AppBack);
    let lines = d.lines();
    assert_eq!(lines.len(), KEPT);
    assert_eq!(lines.last().unwrap().text, "app back");
}
