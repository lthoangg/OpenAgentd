//! Every account transition of the plan's state machine, against the fake
//! cloud in `fake_cloud/`.

mod fake_cloud;

use std::time::Duration;

use fake_cloud::{CodeStatus, Fake};
use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, FlowError, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::roster::{self, Body, Device};
use openagentd_cloud::{letter, recovery};
use serde_json::json;

const FAST: Pace = Pace { every: Duration::from_millis(20), timeout: Duration::from_secs(10) };

fn cloud(base: &str) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None)
}

/// Signs in a device: the person approves its code for `account`.
async fn sign_in(fake: &Fake, c: &Cloud, account: &str) -> flows::Session {
    let code = c.device_code().await.unwrap();
    // The URL comes from the pinned host, never from the response.
    assert_eq!(code.url, format!("https://account.openagentd.dev/device?code={}", code.user_code));
    assert_eq!(code.fingerprint, c.keys.fingerprint());
    fake.approve(&code.user_code, account);
    flows::wait_for_session(c, &code).await.unwrap()
}

/// A phone that created `account`.
async fn phone_with_account(fake: &Fake, base: &str) -> (Member, String) {
    let account = fake.new_account();
    let mut phone = cloud(base);
    phone.roles = Roles::CLIENT;
    let session = sign_in(fake, &phone, &account).await;
    let mut member = Member::new(phone, None);
    // An empty account: joining is refused and the session stays unspent.
    assert!(matches!(flows::request_to_join(&mut member, &session).await, Err(FlowError::EmptyAccount)));
    let draft = GenesisDraft::new();
    let (g1, g2) = draft.check_groups();
    assert!(g1 < g2 && g2 <= recovery::GROUPS);
    assert!(recovery::group_matches(&draft.code, g1, recovery::group(&draft.code, g1).unwrap()));
    let r = flows::genesis(&mut member, &session, draft).await.unwrap();
    assert_eq!(r.version(), 1);
    assert!(member.is_signer());
    assert_eq!(member.me().unwrap().roles(), Roles::CLIENT, "genesis keeps the roles it chose");
    (member, account)
}

/// A server that joined through the phone; returns both codes it saw.
async fn join(fake: &Fake, base: &str, phone: &mut Member, account: &str) -> Member {
    let mut server = cloud(base);
    server.roles = Roles::SERVER;
    let session = sign_in(fake, &server, account).await;
    let mut server = Member::new(server, None);
    let req = flows::request_to_join(&mut server, &session).await.unwrap();
    let pending = phone.cloud.pending_list().await.unwrap();
    assert_eq!(pending.len(), 1);
    let mut approval = flows::begin_approval(phone, pending[0].clone()).await.unwrap();
    let join_code = flows::await_signer(&mut server, &req, FAST).await.unwrap();
    let shown = flows::await_reveal(phone, &mut approval, FAST).await.unwrap();
    assert_eq!(shown.code, join_code.code, "both screens show the same code");
    assert_eq!(shown.fingerprint, server.cloud.keys.fingerprint());
    assert_eq!(shown.roles, Roles::SERVER, "the approver sees the roles it asked for");
    let grant = flows::Grant { signer: false, roles: Roles::SERVER };
    let (added, ours) = tokio::join!(flows::confirm_approval(phone, approval, grant), flows::await_added(&mut server, join_code, &req, FAST));
    assert_eq!(added.unwrap().version(), ours.unwrap().version());
    assert!(!server.is_signer());
    assert!(server.is_server() && !server.is_client());
    server
}

/// Signs `c` in and takes it as far as both codes, approved by `signer`.
async fn ask(fake: &Fake, signer: &mut Member, c: Cloud, account: &str) -> (Member, flows::JoinRequest, flows::JoinCode, flows::Approval) {
    let session = sign_in(fake, &c, account).await;
    let mut n = Member::new(c, None);
    let req = flows::request_to_join(&mut n, &session).await.unwrap();
    let pending = signer.cloud.pending_list().await.unwrap().into_iter().find(|p| p.enrollment_id == req.enrollment_id).unwrap();
    let mut approval = flows::begin_approval(signer, pending).await.unwrap();
    let jc = flows::await_signer(&mut n, &req, FAST).await.unwrap();
    let shown = flows::await_reveal(signer, &mut approval, FAST).await.unwrap();
    assert_eq!(shown.code, jc.code);
    (n, req, jc, approval)
}

#[tokio::test]
async fn a_computer_signs_in_first_and_approves_a_phone() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let account = fake.new_account();
    let mut mac = cloud(&base);
    mac.roles = Roles::BOTH;
    let session = sign_in(&fake, &mac, &account).await;
    let mut mac = Member::new(mac, None);
    assert!(matches!(flows::request_to_join(&mut mac, &session).await, Err(FlowError::EmptyAccount)));
    flows::genesis(&mut mac, &session, GenesisDraft::new()).await.unwrap();
    assert!(mac.is_signer() && mac.is_server() && mac.is_client());
    let mut phone = cloud(&base);
    phone.roles = Roles::CLIENT;
    let (mut phone, req, jc, approval) = ask(&fake, &mut mac, phone, &account).await;
    assert_eq!(approval.requested(), Roles::CLIENT);
    let grant = flows::Grant { signer: true, roles: Roles::CLIENT };
    let (a, b) = tokio::join!(flows::confirm_approval(&mut mac, approval, grant), flows::await_added(&mut phone, jc, &req, FAST));
    assert_eq!(a.unwrap().blob, b.unwrap().blob);
    assert!(phone.is_signer() && phone.is_client() && !phone.is_server());
    // The Mac hosts sessions for the phone; the phone is no host.
    assert_eq!(mac.controller_box(&phone.cloud.device_id()), Some(phone.cloud.keys.r#box.public()));
    let hosts: Vec<_> = phone.roster.as_ref().unwrap().body.servers().map(|d| d.id.clone()).collect();
    assert_eq!(hosts, vec![mac.cloud.device_id()]);
}

#[tokio::test]
async fn the_approver_cannot_add_a_role() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    for roles in [Roles::BOTH, Roles::CLIENT, Roles { server: false, client: false }] {
        let mut box_ = cloud(&base);
        box_.roles = Roles::SERVER;
        let (_n, _req, _jc, approval) = ask(&fake, &mut phone, box_, &account).await;
        let r = flows::confirm_approval(&mut phone, approval, flows::Grant { signer: false, roles }).await;
        assert!(matches!(r, Err(FlowError::Roles)), "{roles:?}: {r:?}");
    }
    assert_eq!(fake.account(&account).version, 1, "nothing was written");
    // A signer that writes the roster itself is refused by the cloud too.
    let mut box_ = cloud(&base);
    box_.roles = Roles::SERVER;
    let (n, _req, _jc, _approval) = ask(&fake, &mut phone, box_, &account).await;
    let mut devices = phone.roster.as_ref().unwrap().body.devices.clone();
    devices.push(Device::of(&n.cloud.keys, false, Roles::BOTH));
    match phone.write(devices).await {
        Err(FlowError::Api(e)) => assert!(e.is("invalid_roster"), "{e:?}"),
        other => panic!("expected invalid_roster, got {other:?}"),
    }
}

#[tokio::test]
async fn the_approver_may_turn_a_role_off() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let mut mac = cloud(&base);
    mac.roles = Roles::BOTH;
    let (mut mac, req, jc, approval) = ask(&fake, &mut phone, mac, &account).await;
    let grant = flows::Grant { signer: true, roles: Roles::SERVER };
    let (a, b) = tokio::join!(flows::confirm_approval(&mut phone, approval, grant), flows::await_added(&mut mac, jc, &req, FAST));
    a.unwrap();
    b.unwrap();
    assert!(mac.is_server() && !mac.is_client() && mac.is_signer());
}

#[tokio::test]
async fn a_cloud_that_raises_the_requested_roles_is_caught_by_the_commitment() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let mut server = cloud(&base);
    server.roles = Roles::SERVER;
    let session = sign_in(&fake, &server, &account).await;
    let mut server = Member::new(server, None);
    let req = flows::request_to_join(&mut server, &session).await.unwrap();
    fake.0.lock().unwrap().tamper_pending = Some(fake_cloud::tamper_raise_roles);
    let pending = phone.cloud.pending_list().await.unwrap();
    let mut approval = flows::begin_approval(&mut phone, pending[0].clone()).await.unwrap();
    assert_eq!(approval.requested(), Roles::BOTH, "the tampered request");
    let _ = flows::await_signer(&mut server, &req, FAST).await.unwrap();
    let result = flows::await_reveal(&mut phone, &mut approval, FAST).await;
    assert!(matches!(result, Err(FlowError::CommitMismatch)), "{result:?}");
}

#[tokio::test]
async fn genesis_then_a_server_joins_with_the_six_digit_code() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let server = join(&fake, &base, &mut phone, &account).await;
    let stored = fake.account(&account);
    assert_eq!(stored.version, 2);
    assert!(stored.devices[&server.cloud.device_id()].1, "the server is active");
    // Kinds are labels the cloud passes along (pending and device list).
    let kinds: Vec<_> = phone.cloud.devices().await.unwrap().into_iter().map(|d| (d.device_id, d.kind)).collect();
    assert!(kinds.contains(&(server.cloud.device_id(), openagentd_cloud::api::this_kind().map(String::from))), "{kinds:?}");
    // Both hold the same verified roster.
    assert_eq!(phone.roster.as_ref().unwrap().blob, server.roster.as_ref().unwrap().blob);
    assert_eq!(server.box_of(&phone.cloud.device_id()), Some(phone.cloud.keys.r#box.public()));
}

#[tokio::test]
async fn a_cloud_that_swaps_the_joining_keys_is_caught_by_the_commitment() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let server = cloud(&base);
    let session = sign_in(&fake, &server, &account).await;
    let mut server = Member::new(server, None);
    let req = flows::request_to_join(&mut server, &session).await.unwrap();
    fake.0.lock().unwrap().tamper_pending = Some(fake_cloud::tamper_swap_pubs);
    let pending = phone.cloud.pending_list().await.unwrap();
    let mut approval = flows::begin_approval(&mut phone, pending[0].clone()).await.unwrap();
    let _ = flows::await_signer(&mut server, &req, FAST).await.unwrap();
    let result = flows::await_reveal(&mut phone, &mut approval, FAST).await;
    assert!(matches!(result, Err(FlowError::CommitMismatch)), "{result:?}");
    assert!(fake.account(&account).pending.is_empty(), "the request was cancelled");
}

#[tokio::test]
async fn a_rejected_request_ends_the_join() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let server = cloud(&base);
    let session = sign_in(&fake, &server, &account).await;
    let mut server = Member::new(server, None);
    let req = flows::request_to_join(&mut server, &session).await.unwrap();
    let pending = phone.cloud.pending_list().await.unwrap();
    let mut approval = flows::begin_approval(&mut phone, pending[0].clone()).await.unwrap();
    let join_code = flows::await_signer(&mut server, &req, FAST).await.unwrap();
    flows::await_reveal(&mut phone, &mut approval, FAST).await.unwrap();
    flows::reject_approval(&phone, approval).await.unwrap();
    let ended = flows::await_added(&mut server, join_code, &req, FAST).await;
    assert!(matches!(ended, Err(FlowError::JoinEnded)), "{ended:?}");
}

#[tokio::test]
async fn denied_and_expired_codes() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let c = cloud(&base);
    let code = c.device_code().await.unwrap();
    fake.set_code(&code.user_code, CodeStatus::Denied);
    assert!(matches!(flows::wait_for_session(&c, &code).await, Err(FlowError::Denied)));
    // A waiting account cannot approve: the code just expires.
    let code = c.device_code().await.unwrap();
    fake.set_code(&code.user_code, CodeStatus::Expired);
    assert!(matches!(flows::wait_for_session(&c, &code).await, Err(FlowError::Expired)));
}

#[tokio::test]
async fn account_problems_map_to_states() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let cases = [
        ((403, json!({"error": "account_closing", "deletes_at": 1_900_000_000_000u64})), AccountProblem::Closing { deletes_at: Some(1_900_000_000_000) }),
        ((403, json!({"error": "account_unavailable"})), AccountProblem::Unavailable),
        ((410, json!({"error": "account_deleted"})), AccountProblem::Deleted),
    ];
    for (answer, expected) in cases {
        fake.set_problem(&account, Some(answer));
        match phone.sync().await {
            Err(FlowError::Problem(p)) => assert_eq!(p, expected),
            other => panic!("expected {expected:?}, got {other:?}"),
        }
    }
    // Keep account: everything works again with the same keys and roster.
    fake.set_problem(&account, None);
    assert!(phone.sync().await.is_ok());
}

#[tokio::test]
async fn a_removed_device_learns_it_and_the_phone_can_remove() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let mut server = join(&fake, &base, &mut phone, &account).await;
    let r = phone.remove(&server.cloud.device_id()).await.unwrap();
    assert_eq!(r.version(), 3);
    // Its next signed request gets `403 device_revoked`: terminal, and
    // never retried as a stale nonce (one request, not two).
    let before = fake.0.lock().unwrap().signed_requests;
    match server.sync().await {
        Err(FlowError::Problem(p)) => assert_eq!(p, AccountProblem::Revoked),
        other => panic!("expected Revoked, got {other:?}"),
    }
    assert_eq!(fake.0.lock().unwrap().signed_requests - before, 1, "device_revoked is not retried");
    // Even while the account is locked, removal wins.
    fake.set_problem(&account, Some((403, json!({"error": "account_unavailable"}))));
    let e = server.cloud.devices().await.unwrap_err();
    assert_eq!((e.status, e.problem()), (403, Some(AccountProblem::Revoked)));
    fake.set_problem(&account, None);
    assert!(!fake.account(&account).devices[&server.cloud.device_id()].1);
}

#[tokio::test]
async fn only_the_removed_key_learns_of_removal() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let server = join(&fake, &base, &mut phone, &account).await;
    phone.remove(&server.cloud.device_id()).await.unwrap();
    // Any other key gets 401 and no account problem: only the key the
    // removed device registered with is told `device_revoked`.
    let impostor = Cloud::new(reqwest::Client::new(), Endpoints::custom(&base, "https://account.openagentd.dev"), DeviceKeys::generate(), Some(account.clone()));
    let e = impostor.devices().await.unwrap_err();
    assert_eq!((e.status, e.problem()), (401, None));
}

#[tokio::test]
async fn a_forged_roster_is_refused() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    // The cloud adds its own device, signed by a key the roster does not trust.
    let intruder = DeviceKeys::generate();
    let known = phone.roster.clone().unwrap();
    let forged = roster::sign(&known.next_body(vec![Device::of(&phone.cloud.keys, true, Roles::CLIENT), Device::of(&intruder, true, Roles::BOTH)]), &intruder.id(), &intruder.sign);
    fake.force_roster(&account, forged.blob, 2);
    assert!(matches!(phone.sync().await, Err(FlowError::Roster(roster::Rule::UntrustedSigner))));
    assert_eq!(phone.roster.as_ref().unwrap().version(), 1, "K is unchanged");
    let _ = Body::genesis;
}

#[tokio::test]
async fn sign_out_leaves_and_the_last_signer_is_told() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let server = join(&fake, &base, &mut phone, &account).await;
    server.cloud.leave().await.unwrap();
    assert!(!fake.account(&account).devices[&server.cloud.device_id()].1);
    // A device that left is told the same way as a removed one.
    assert_eq!(server.cloud.devices().await.unwrap_err().problem(), Some(AccountProblem::Revoked));
    let last = phone.cloud.leave().await.unwrap_err();
    assert!(last.is("last_signer"));
}

#[tokio::test]
async fn letters_through_the_mailbox_open_only_with_the_roster_key() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let server = join(&fake, &base, &mut phone, &account).await;
    let to = phone.cloud.device_id();
    let ctx = letter::Context { account_id: &account, sender_id: &server.cloud.device_id(), recipient_id: &to, kind: letter::Kind::Done };
    let text = letter::Text { v: 1, title: "Done".into(), body: "Tests pass.".into(), session: Some("s1".into()), at: 1 };
    let sealed = letter::seal(&server.cloud.keys.r#box, &server.box_of(&to).unwrap(), &ctx, &text).unwrap();
    server.cloud.send_letter(&to, letter::Kind::Done, &sealed, Some("s1")).await.unwrap();
    let got = phone.cloud.letters().await.unwrap();
    assert_eq!(got.len(), 1);
    let sender_box = phone.box_of(&got[0].from).unwrap();
    let opened = letter::open(&phone.cloud.keys.r#box, &sender_box, &ctx, &fake_cloud::decoded(&got[0].sealed)).unwrap();
    assert_eq!(opened, text);
}

#[tokio::test]
async fn credentials_never_show_in_debug_output() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let account = fake.new_account();
    let c = cloud(&base);
    let code = c.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&c, &code).await.unwrap();
    let shown = format!("{code:?} {session:?} {c:?}");
    assert!(!shown.contains(code.device_code.expose()));
    assert!(!shown.contains(session.session.expose()));
    assert!(!shown.contains("e1."));
    let draft = GenesisDraft::new();
    assert!(!format!("{draft:?}").contains(draft.code.as_str()));
}

#[tokio::test]
async fn a_signing_key_kept_apart_is_needed_to_write() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let server = join(&fake, &base, &mut phone, &account).await;
    // The phone's signing key is locked away (behind Face ID): a stand-in
    // key signs nothing the roster rules accept, so nothing is sent.
    let stand_in = openagentd_cloud::keys::Ed25519::from_seed(openagentd_cloud::keys::Seed::random());
    let real = phone.set_sign_key(stand_in);
    let refused = phone.remove(&server.cloud.device_id()).await;
    assert!(matches!(refused, Err(FlowError::Roster(_))), "{refused:?}");
    assert_eq!(fake.account(&account).version, 2, "nothing was written");
    // Unlocked: the write goes through.
    phone.set_sign_key(real);
    assert_eq!(phone.remove(&server.cloud.device_id()).await.unwrap().version(), 3);
}
