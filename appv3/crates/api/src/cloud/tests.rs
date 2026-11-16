use super::*;

#[test]
fn the_backoff_starts_over_only_after_presence_stayed_up_a_minute() {
    assert_eq!(attempt_after(4, None), 4, "never opened");
    assert_eq!(attempt_after(4, Some(Duration::from_secs(5))), 4, "opened and died at once");
    assert_eq!(attempt_after(4, Some(Duration::from_secs(59))), 4);
    assert_eq!(attempt_after(4, Some(STEADY_AFTER)), 0);
    assert_eq!(attempt_after(4, Some(Duration::from_secs(3600))), 0);
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn roster_note_checks_only_when_this_host_is_listed() {
    // Listed: confirm with a signed request; the note itself erases nothing.
    assert_eq!(read_roster_note("me", 3, 3, &ids(&["other", "me"])), RosterNote::Check);
    // Listed again on a later message: check again (idempotent).
    assert_eq!(read_roster_note("me", 3, 4, &ids(&["me"])), RosterNote::Check);
}

#[test]
fn roster_note_fetches_only_a_newer_version() {
    assert_eq!(read_roster_note("me", 3, 4, &[]), RosterNote::Fetch);
}

#[test]
fn direct_admission_asks_the_same_question_as_the_relay_plus_contact() {
    use openagentd_cloud::keys::DeviceKeys;
    use openagentd_cloud::roster::{sign, Body, Device};
    let both = Roles::BOTH;
    let (me, phone, left, ci) = (DeviceKeys::generate(), DeviceKeys::generate(), DeviceKeys::generate(), DeviceKeys::generate());
    let server_only = Roles { server: true, client: false };
    let body = Body::genesis("acct", &[7; 32], Device::of(&me, true, both));
    let devices = vec![Device::of(&me, true, both), Device::of(&phone, true, both), Device::of(&left, false, both), Device::of(&ci, false, server_only)];
    let r = sign(&Body { devices, ..body }, &me.id(), &me.sign);
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut l = ledger::Ledger::default();
    l.note(&r, &me.id(), &[left.id()]);
    l.contacted(now_ms());
    let h = Handler { roster: Arc::new(RwLock::new(r)), me: me.id(), ledger: Arc::new(RwLock::new(l)), resync: tx };
    host().direct_ok.store(true, Ordering::Relaxed);
    note_contact(&h.ledger.read().unwrap());
    assert_eq!(h.admit_direct(&phone.r#box.public()), Some(phone.id()), "an active client");
    assert_eq!(h.admit_direct(&left.r#box.public()), None, "left the account: still in the roster, refused");
    assert_eq!(h.controller_box(&left.id()), None, "on the relay too");
    assert_eq!(h.admit_direct(&ci.r#box.public()), None, "no client role");
    assert_eq!(h.admit_direct(&me.r#box.public()), None, "not itself");
    assert_eq!(h.admit_direct(&DeviceKeys::generate().r#box.public()), None, "a stranger");
    // Two entries with one `box` key: the host refuses rather than pick.
    {
        let mut twin = Device::of(&DeviceKeys::generate(), false, both);
        twin.r#box = Device::of(&phone, false, both).r#box;
        let mut r = h.roster.write().unwrap();
        r.body.devices.push(twin);
    }
    assert_eq!(h.admit_direct(&phone.r#box.public()), None, "a shared box key names no one");
    h.roster.write().unwrap().body.devices.pop();
    assert_eq!(h.admit_direct(&phone.r#box.public()), Some(phone.id()));
    // Eight days without the cloud: no direct sessions until it hears again.
    h.ledger.write().unwrap().contacted(0);
    let mut stale = ledger::Ledger::default();
    stale.contacted(now_ms() - 8 * DAY_MS);
    *h.ledger.write().unwrap() = stale;
    assert_eq!(h.admit_direct(&phone.r#box.public()), None, "7-day rule");
    h.ledger.write().unwrap().contacted(now_ms());
    assert_eq!(h.admit_direct(&phone.r#box.public()), Some(phone.id()));
    // An account problem or a removal signal turns it off.
    host().direct_ok.store(false, Ordering::Relaxed);
    assert_eq!(h.admit_direct(&phone.r#box.public()), None);
}

#[test]
fn direct_sessions_stop_seven_days_after_the_last_contact() {
    let now = 100 * DAY_MS;
    assert!(!contact_fresh(0, now), "never heard from the cloud");
    assert!(contact_fresh(now - DAY_MS, now));
    assert!(contact_fresh(now - 7 * DAY_MS + 1, now));
    assert!(!contact_fresh(now - 7 * DAY_MS, now), "the listener, the answer and live sessions stop");
}

#[test]
fn roster_note_ignores_old_versions_and_leaves() {
    // A leave changes no version; repeats of the revoked list are normal.
    assert_eq!(read_roster_note("me", 3, 3, &ids(&["left"])), RosterNote::Nothing);
    assert_eq!(read_roster_note("me", 3, 3, &ids(&["left"])), RosterNote::Nothing);
    assert_eq!(read_roster_note("me", 4, 3, &[]), RosterNote::Nothing);
}

#[test]
fn a_4010_close_pauses_at_once_until_the_next_utc_midnight() {
    // 2026-01-02 22:00 UTC.
    let now = 1_767_391_200_000;
    let midnight = 1_767_398_400_000;
    assert_eq!(after_presence(&RelayError::Closed(4010), now), Next::Paused { until: midnight, wait: Duration::from_secs(2 * 3600) });
}

#[test]
fn a_refused_token_pauses_until_the_time_the_cloud_gave() {
    let now = 1_767_391_200_000;
    let quota = |until: u64| {
        RelayError::Refused(openagentd_cloud::api::ApiError {
            status: 429,
            code: "quota_exhausted".into(),
            body: Some(serde_json::json!({"error": "quota_exhausted", "paused_until": until})),
            retry_after: None,
        })
    };
    assert_eq!(after_presence(&quota(now + 600_000), now), Next::Paused { until: now + 600_000, wait: Duration::from_secs(600) });
    // A time already past (a skewed clock) still waits a minute.
    assert_eq!(after_presence(&quota(now - 1), now), Next::Paused { until: now - 1, wait: Duration::from_secs(60) });
}

#[test]
fn presence_taken_over_by_another_copy_backs_off_long() {
    assert_eq!(after_presence(&RelayError::Closed(4000), 0), Next::TakenOver);
    assert!(TAKEN_OVER_WAIT >= Duration::from_secs(60));
}

#[test]
fn other_presence_ends_retry_soon() {
    for ended in [RelayError::Closed(4008), RelayError::Closed(1006), RelayError::Network, RelayError::TimedOut] {
        assert_eq!(after_presence(&ended, 0), Next::Retry, "{ended:?}");
    }
}

#[test]
fn a_guest_status_carries_the_wait_only_when_there_is_one() {
    let v = serde_json::to_value(guest(Some(Notice::TooManyPending))).unwrap();
    assert_eq!(v, serde_json::json!({"state": "guest", "notice": "too_many_pending"}));
    let e = FlowError::Api(openagentd_cloud::api::ApiError { status: 429, code: "rate_limited".into(), body: None, retry_after: Some(60) });
    let v = serde_json::to_value(guest_after(&e)).unwrap();
    assert_eq!(v, serde_json::json!({"state": "guest", "notice": "rate_limited", "retry_after": 60}));
    let v = serde_json::to_value(RelayState::TakenOver).unwrap();
    assert_eq!(v, serde_json::json!({"state": "taken_over"}));
}
