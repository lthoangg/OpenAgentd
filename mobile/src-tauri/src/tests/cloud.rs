//! Unit tests of `cloud.rs` (kept apart so that file stays under its size limit).

use super::*;

#[test]
fn missing_passcode_and_missing_key_say_what_to_do() {
    assert!(NO_PASSCODE.starts_with("Set a passcode on this iPhone"));
    assert!(SIGN_KEY_GONE.contains("passcode was turned off"));
    assert!(SIGN_KEY_GONE.contains("another phone that can add devices"));
    // A build that keeps keys in a file needs no passcode.
    assert_eq!(keys_unavailable(), None);
}

#[test]
fn a_rename_answers_the_name_or_why_not() {
    let ok = rename_answer(200, r#"{"name":"Work","default":"mini","custom":true}"#).unwrap();
    assert_eq!(ok["name"], "Work");
    assert_eq!(rename_answer(404, "").unwrap_err(), NAME_NEEDS_UPDATE);
    assert_eq!(rename_answer(422, r#"{"detail":"name must be a string"}"#).unwrap_err(), "name must be a string");
    assert_eq!(rename_answer(502, "x").unwrap_err(), "That computer answered 502.");
}

#[test]
fn status_serializes_for_the_web_ui() {
    let s = serde_json::to_value(Status::Guest {
        notice: Some(Notice::SignedOut),
        supported: true,
        retry_after: None,
    })
    .unwrap();
    assert_eq!(
        s,
        serde_json::json!({"state": "guest", "notice": "signed_out", "supported": true})
    );
    let s = serde_json::to_value(Status::Recovery {
        code: "X".into(),
        check: [2, 9],
    })
    .unwrap();
    assert_eq!(
        s,
        serde_json::json!({"state": "recovery", "code": "X", "check": [2, 9]})
    );
    // `recovering` and `recovered` only appear when true.
    let signing_in = |recovering| Status::SigningIn {
        user_code: "ABCD".into(),
        url: "u".into(),
        fingerprint: "f".into(),
        expires_in: 600,
        recovering,
        add_link: None,
    };
    let s = serde_json::to_value(signing_in(false)).unwrap();
    assert!(s.get("recovering").is_none(), "{s}");
    let s = serde_json::to_value(signing_in(true)).unwrap();
    assert_eq!(s["recovering"], true);
    let connected = |recovered| Status::Connected {
        fingerprint: "f".into(),
        signer: true,
        recovered,
    };
    let s = serde_json::to_value(connected(false)).unwrap();
    assert_eq!(
        s,
        serde_json::json!({"state": "connected", "fingerprint": "f", "signer": true})
    );
    let s = serde_json::to_value(connected(true)).unwrap();
    assert_eq!(s["recovered"], true);
}

#[test]
fn each_refusal_gets_its_own_notice_and_the_wait() {
    let refused = |status: u16, code: &str, retry_after: Option<u64>| {
        FlowError::Api(openagentd_cloud::api::ApiError {
            status,
            code: code.into(),
            body: None,
            retry_after,
        })
    };
    let cases = [
        (refused(429, "rate_limited", Some(60)), Notice::RateLimited),
        (
            refused(409, "too_many_pending", None),
            Notice::TooManyPending,
        ),
        (refused(403, "device_limit", None), Notice::DeviceLimit),
        (refused(409, "device_exists", None), Notice::DeviceExists),
        (refused(0, "network", None), Notice::Unreachable),
        (
            FlowError::Problem(AccountProblem::Closing { deletes_at: None }),
            Notice::AccountClosing,
        ),
        (
            FlowError::Problem(AccountProblem::Unavailable),
            Notice::AccountUnavailable,
        ),
        (refused(400, "invalid_request", None), Notice::Failed),
        (FlowError::WrongRecoveryCode, Notice::WrongRecoveryCode),
    ];
    for (e, n) in cases {
        assert_eq!(notice_of(&e), n, "{e:?}");
    }
    let s = serde_json::to_value(guest_after(&refused(429, "rate_limited", Some(60)))).unwrap();
    assert_eq!(s["notice"], "rate_limited");
    assert_eq!(s["retry_after"], 60);
    let s = serde_json::to_value(guest_after(&refused(409, "too_many_pending", None))).unwrap();
    assert_eq!(s["notice"], "too_many_pending");
    assert!(s.get("retry_after").is_none());
    let text = refusal_message(&openagentd_cloud::api::ApiError {
        status: 403,
        code: "device_limit".into(),
        body: None,
        retry_after: None,
    })
    .unwrap();
    assert_eq!(text, "Your account has 10 devices; remove one first.");
}

#[test]
fn an_approver_gives_the_asked_roles_or_fewer() {
    // Defaults: what it asked for; a signer when it opens sessions.
    let g = grant_of(Roles::BOTH, None, None, None).unwrap();
    assert_eq!((g.signer, g.roles), (true, Roles::BOTH));
    let g = grant_of(Roles::SERVER, None, None, None).unwrap();
    assert_eq!((g.signer, g.roles), (false, Roles::SERVER));
    // Turning one off is fine; turning one on, or both off, is not.
    assert_eq!(
        grant_of(Roles::BOTH, Some(false), Some(true), Some(false))
            .unwrap()
            .roles,
        Roles::SERVER
    );
    assert!(grant_of(Roles::CLIENT, None, Some(true), None).is_err());
    assert!(grant_of(Roles::BOTH, None, Some(false), Some(false)).is_err());
}

fn three_devices() -> (Vec<roster::Device>, [String; 3]) {
    let phone = DeviceKeys::generate();
    let mac = DeviceKeys::generate();
    let linux = DeviceKeys::generate();
    let devices = vec![
        roster::Device::of(&phone, true, Roles::CLIENT),
        roster::Device::of(&mac, false, Roles::SERVER),
        roster::Device::of(&linux, false, Roles::BOTH),
    ];
    (devices, [phone.id(), mac.id(), linux.id()])
}

fn info(id: &str, kind: Option<&str>, name: Option<&str>, departed: bool) -> DeviceInfo {
    DeviceInfo {
        device_id: id.into(),
        signer: false,
        added_at: Some(0),
        revoked_at: departed.then_some(1),
        kind: kind.map(String::from),
        name: name.map(String::from),
    }
}

#[test]
fn a_refused_rename_says_why_in_plain_words() {
    let refused = |status: u16, code: &str| openagentd_cloud::api::ApiError {
        status,
        code: code.into(),
        body: None,
        retry_after: None,
    };
    assert_eq!(
        rename_refusal(&refused(403, "not_signer")),
        Some("Only a phone that can add devices can rename this device.")
    );
    assert_eq!(
        rename_refusal(&refused(409, "unknown_device")),
        Some("That device is no longer in your account.")
    );
    assert_eq!(
        rename_refusal(&refused(429, "rate_limited")),
        Some("Too many renames. Try again in a few minutes.")
    );
    assert_eq!(
        rename_refusal(&refused(400, "invalid_request")),
        Some("Use 1 to 40 characters, on one line.")
    );
    assert_eq!(rename_refusal(&refused(500, "boom")), None);
}

#[test]
fn servers_get_the_clouds_online_flag_and_unlisted_ones_are_offline() {
    let (devices, [phone, mac, linux]) = three_devices();
    let infos = [info(&mac, Some("macos"), Some("Studio"), false)];
    let online = HashMap::from([(mac.clone(), true)]);
    let rows = device_rows(&devices, &phone, &infos, Some(&online));
    let of = |id: &str| rows.iter().find(|r| r.device_id == id).unwrap().clone();
    assert_eq!(of(&phone).online, None, "a client has no presence");
    assert!(of(&phone).me);
    assert_eq!(of(&mac).online, Some(true));
    assert_eq!(of(&mac).kind.as_deref(), Some("macos"));
    assert_eq!(of(&mac).name.as_deref(), Some("Studio"));
    assert_eq!(of(&linux).name, None, "unnamed");
    assert_eq!(of(&linux).online, Some(false), "never opened presence");
}

#[test]
fn departed_devices_are_not_listed_but_unlisted_ones_stay() {
    let (devices, [phone, mac, linux]) = three_devices();
    // The cloud lists the mac as departed and says nothing of the linux box.
    let infos = [info(&mac, Some("macos"), None, true)];
    let rows = device_rows(&devices, &phone, &infos, None);
    let ids: Vec<&str> = rows.iter().map(|r| r.device_id.as_str()).collect();
    assert_eq!(ids, [phone.as_str(), linux.as_str()]);
    // This phone stays whatever the cloud says of it.
    let infos = [info(&phone, None, None, true)];
    assert!(device_rows(&devices, &phone, &infos, None)
        .iter()
        .any(|r| r.me));
}

#[test]
fn a_failed_or_silent_usage_call_leaves_online_unknown() {
    let (devices, [phone, mac, linux]) = three_devices();
    let rows = device_rows(&devices, &phone, &[], None);
    assert_eq!(rows.len(), 3, "the list itself still comes back");
    assert!(rows.iter().all(|r| r.online.is_none()), "{rows:?}");
    assert!(rows.iter().any(|r| r.device_id == mac) && rows.iter().any(|r| r.device_id == linux));
    // The web UI reads `online: null` as "no dot".
    let json = serde_json::to_value(&rows[1]).unwrap();
    assert_eq!(json["online"], serde_json::Value::Null);
}

#[test]
fn a_bridge_origin_names_its_computer() {
    let (_, [_, mac, _]) = three_devices();
    let bridges = HashMap::from([(
        "http://127.0.0.1:5999".to_string(),
        BridgeEntry {
            key: "k".into(),
            device_id: mac.clone(),
        },
    )]);
    let kinds = HashMap::from([(mac.clone(), Some("macos".to_string()))]);
    let device = account_device_in(&bridges, &kinds, "http://127.0.0.1:5999/").unwrap();
    assert_eq!(device.device_id, mac);
    assert_eq!(device.fingerprint, keys::fingerprint(&mac).unwrap());
    assert_eq!(device.kind.as_deref(), Some("macos"));
    // Kind not known yet: still named by its fingerprint.
    let device = account_device_in(&bridges, &HashMap::new(), "http://127.0.0.1:5999").unwrap();
    assert_eq!(device.kind, None);
    // Any other server is not an account computer.
    assert_eq!(account_device_in(&bridges, &kinds, "http://192.168.1.20:4082"), None);
}

#[test]
fn file_keys_keep_the_signing_seed_on_update() {
    let dir = tempfile::tempdir().unwrap();
    let store = FileKeys(openagentd_cloud::store::FileStore::new(
        dir.path().join("identity.json"),
    ));
    let keys = DeviceKeys::generate();
    let id = Identity::new(&keys);
    store.save(&id).unwrap();
    let mut without = id.clone();
    let _ = without.split_sign();
    without.account_id = Some("acct".into());
    store.update(&without).unwrap();
    let back = store.load().unwrap().unwrap();
    assert_eq!(back.account_id.as_deref(), Some("acct"));
    assert_eq!(back.keys().unwrap().sign.public(), keys.sign.public());
    // A member restored with a stand-in signing key writes its roster
    // back: the real seed must survive.
    let stand_in = Identity::new(&back.keys_without_sign().unwrap());
    let mut restored = Identity::new(&DeviceKeys::from_seeds(
        Seed::from_b64(&back.auth).unwrap(),
        Seed::from_b64(&back.r#box).unwrap(),
        Seed::from_b64(&stand_in.sign).unwrap(),
    ));
    restored.roster = Some("next".into());
    store.update(&restored).unwrap();
    let back = store.load().unwrap().unwrap();
    assert_eq!(back.roster.as_deref(), Some("next"));
    assert_eq!(back.keys().unwrap().sign.public(), keys.sign.public());
    store.clear().unwrap();
    assert!(store.load().unwrap().is_none());
}
