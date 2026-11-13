//! Invitations (spec section 4.3) against the fake cloud: the signer never
//! adds a candidate on its own, two valid proofs add nobody, and the new
//! device trusts its first roster only through `confirm`.

mod fake_cloud;

use std::time::Duration;

use fake_cloud::Fake;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, Candidates, FlowError, GenesisDraft, Member, Pace, SignIn};
use openagentd_cloud::invite;
use openagentd_cloud::keys::DeviceKeys;
use serde_json::json;

const BOTH: flows::Grant = flows::Grant { signer: false, roles: openagentd_cloud::keys::Roles::BOTH };

const FAST: Pace = Pace { every: Duration::from_millis(20), timeout: Duration::from_secs(10) };

fn cloud(base: &str) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None)
}

/// A phone that created an account: the only signer.
async fn phone_with_account(fake: &Fake, base: &str) -> (Member, String) {
    let account = fake.new_account();
    let phone = cloud(base);
    let code = phone.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&phone, &code).await.unwrap();
    let mut member = Member::new(phone, None);
    flows::genesis(&mut member, &session, GenesisDraft::new()).await.unwrap();
    (member, account)
}

/// A new device that has nothing but the link.
fn newcomer(base: &str) -> Member {
    Member::new(cloud(base), None)
}

/// Waits until the signer sees exactly one valid candidate.
async fn one_candidate(phone: &Member, invite: &flows::Invite) -> flows::InviteCandidate {
    for _ in 0..200 {
        if let Candidates::One(c) = flows::check_candidates(phone, invite).await.unwrap() {
            return c;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no candidate");
}

#[tokio::test]
async fn a_server_joins_by_invitation_after_the_person_confirms() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let link = invite.link();
    assert!(link.starts_with("agentd://invite?"));

    let mut server = newcomer(&base);
    let claim = flows::claim_invite(&mut server, &link).await.unwrap();
    let joined = tokio::spawn(async move {
        let r = flows::await_invited(&mut server, claim, FAST).await;
        (server, r)
    });

    // The signer shows the candidate; it is not added until the person taps.
    let c = one_candidate(&phone, &invite).await;
    assert_eq!(c.kind.as_deref(), openagentd_cloud::api::this_kind());
    assert_eq!(c.roles, openagentd_cloud::keys::Roles::BOTH, "the roles it asked for, covered by its proof");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.account(&account).version, 1, "checking candidates never adds one");

    let r = flows::add_invited(&mut phone, invite, &c.enrollment_id, BOTH).await.unwrap();
    assert_eq!(r.version(), 2);
    let (server, ours) = joined.await.unwrap();
    let ours = ours.unwrap();
    assert_eq!(ours.blob, r.blob, "the new device holds the signer's roster as K");
    assert_eq!(c.fingerprint, server.cloud.keys.fingerprint(), "both screens show the same fingerprint");
    assert!(!server.is_signer());
    // The invitation is spent.
    let mut again = newcomer(&base);
    assert!(matches!(flows::claim_invite(&mut again, &link).await, Err(FlowError::JoinEnded)));
}

#[tokio::test]
async fn two_valid_proofs_add_nobody_and_cancel_the_invitation() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let link = invite.link();
    // Someone else saw the QR code too.
    let mut ours = newcomer(&base);
    let mut theirs = newcomer(&base);
    let claim = flows::claim_invite(&mut ours, &link).await.unwrap();
    flows::claim_invite(&mut theirs, &link).await.unwrap();

    let first = flows::check_candidates(&phone, &invite).await;
    assert!(matches!(first, Err(FlowError::InviteCompromised)), "{first:?}");
    assert!(fake.0.lock().unwrap().invites.is_empty(), "the invitation was cancelled");
    assert!(fake.account(&account).pending.is_empty(), "its candidates went with it");
    assert_eq!(fake.account(&account).version, 1, "nobody was added");
    // The new device learns the invitation ended.
    assert!(matches!(flows::await_invited(&mut ours, claim, FAST).await, Err(FlowError::JoinEnded)));
}

#[tokio::test]
async fn a_second_proof_after_the_first_still_stops_the_add() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let link = invite.link();
    let mut ours = newcomer(&base);
    flows::claim_invite(&mut ours, &link).await.unwrap();
    let c = one_candidate(&phone, &invite).await;
    // While the person looks at the card, a second device claims.
    let mut theirs = newcomer(&base);
    flows::claim_invite(&mut theirs, &link).await.unwrap();
    let r = flows::add_invited(&mut phone, invite, &c.enrollment_id, BOTH).await;
    assert!(matches!(r, Err(FlowError::InviteCompromised)), "{r:?}");
    assert_eq!(fake.account(&account).version, 1);
}

#[tokio::test]
async fn only_the_candidate_the_person_picked_is_added() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let mut n = newcomer(&base);
    flows::claim_invite(&mut n, &invite.link()).await.unwrap();
    one_candidate(&phone, &invite).await;
    let r = flows::add_invited(&mut phone, invite, "not-the-shown-candidate", BOTH).await;
    assert!(matches!(r, Err(FlowError::JoinEnded)), "{r:?}");
    assert_eq!(fake.account(&account).version, 1);
}

#[tokio::test]
async fn a_candidate_without_the_secret_or_with_swapped_keys_is_dropped() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    // Knows the slot id (the cloud does) but not the secret.
    let guess = format!("agentd://invite?a={account}&s={}&k=AAAAAAAAAAAAAAAAAAAAAA", invite.slot_id);
    let mut guesser = newcomer(&base);
    flows::claim_invite(&mut guesser, &guess).await.unwrap();
    // A real candidate, whose auth key the cloud swaps for its own.
    let mut real = newcomer(&base);
    flows::claim_invite(&mut real, &invite.link()).await.unwrap();
    {
        let mut s = fake.0.lock().unwrap();
        let a = s.accounts.get_mut(&account).unwrap();
        let p = a.pending.values_mut().find(|p| p["device_id"] == json!(real.cloud.device_id())).unwrap();
        p["auth_pub"] = json!(openagentd_cloud::encoding::b64(&DeviceKeys::generate().auth.public()));
    }
    assert_eq!(flows::check_candidates(&phone, &invite).await.unwrap(), Candidates::Waiting);
    assert!(fake.account(&account).pending.is_empty(), "both were dropped");
}

#[tokio::test]
async fn the_new_device_refuses_a_roster_the_confirm_does_not_cover() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let slot = invite.slot_id.clone();
    let mut n = newcomer(&base);
    let claim = flows::claim_invite(&mut n, &invite.link()).await.unwrap();
    let c = one_candidate(&phone, &invite).await;
    flows::add_invited(&mut phone, invite, &c.enrollment_id, BOTH).await.unwrap();
    // The cloud forges the confirmation it relays.
    fake.0.lock().unwrap().invites.get_mut(&slot).unwrap().confirm = Some(openagentd_cloud::encoding::b64(&[7u8; 32]));
    assert!(matches!(flows::await_invited(&mut n, claim, FAST).await, Err(FlowError::ConfirmMismatch)));
    assert!(n.roster.is_none());
    let _ = account;
}

#[tokio::test]
async fn an_eleventh_device_is_refused() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    fake.add_stand_ins(&account, openagentd_cloud::roster::MAX_DEVICES - 1);
    let mut n = newcomer(&base);
    match flows::claim_invite(&mut n, &invite.link()).await {
        Err(FlowError::Api(e)) => assert!(e.is("device_limit"), "{e:?}"),
        other => panic!("expected device_limit, got {other:?}"),
    }
}

#[tokio::test]
async fn the_secret_never_shows_in_debug_output() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, _) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let link = invite.link();
    let k = link.split("&k=").nth(1).unwrap().to_string();
    let mut n = newcomer(&base);
    let claim = flows::claim_invite(&mut n, &link).await.unwrap();
    for text in [format!("{invite:?}"), format!("{claim:?}"), format!("{:?}", openagentd_cloud::invite::parse_link(&link).unwrap())] {
        assert!(!text.contains(&k), "{text}");
    }
    flows::cancel_invite(&phone, invite).await.unwrap();
    assert!(fake.0.lock().unwrap().invites.is_empty());
}

#[tokio::test]
async fn an_invited_device_gets_fewer_roles_never_more() {
    use openagentd_cloud::keys::Roles;
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, _account) = phone_with_account(&fake, &base).await;
    let invite = flows::start_invite(&mut phone).await.unwrap();
    let mut n = newcomer(&base);
    n.cloud.roles = Roles::SERVER;
    let claim = flows::claim_invite(&mut n, &invite.link()).await.unwrap();
    let c = one_candidate(&phone, &invite).await;
    assert_eq!(c.roles, Roles::SERVER);
    // Asking for client too is refused before anything is written.
    let more = flows::Grant { signer: false, roles: Roles::BOTH };
    assert!(matches!(flows::add_invited(&mut phone, invite, &c.enrollment_id, more).await, Err(FlowError::Roles)));
    assert_eq!(phone.roster.as_ref().unwrap().version(), 1, "nothing was written");
    drop(claim);
}

// ---- Scan to add (spec section 4.3.1) ------------------------------------

/// A new computer that asked for a device code and shows its scan code.
async fn computer_showing_code(base: &str) -> (Member, openagentd_cloud::api::DeviceCode, flows::ScanCode) {
    let computer = newcomer(base);
    let code = computer.cloud.device_code().await.unwrap();
    let scan = flows::scan_code(&computer.cloud, &code);
    (computer, code, scan)
}

/// The computer's side up to the number: waits for the offer, claims it,
/// and waits for the roster that adds it.
fn computer_joins(mut computer: Member, code: openagentd_cloud::api::DeviceCode, scan: flows::ScanCode) -> tokio::task::JoinHandle<(Member, Result<flows::Scanned, FlowError>)> {
    tokio::spawn(async move {
        let result = async {
            let offer = match flows::wait_for_sign_in(&computer.cloud, &code).await? {
                SignIn::Offered(o) => o,
                SignIn::Session(_) => panic!("the code was approved, not offered"),
            };
            let claim = flows::claim_offer(&mut computer, &scan, offer).await?;
            flows::await_scanned(&mut computer, claim, FAST).await
        }
        .await;
        (computer, result)
    })
}

#[tokio::test]
async fn a_computer_joins_when_a_phone_scans_its_code_and_both_show_one_number() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let (computer, code, scan) = computer_showing_code(&base).await;
    let id = computer.cloud.device_id();
    let link = scan.link();
    assert!(link.starts_with("agentd://add?"), "{}", link.as_str());
    let joined = computer_joins(computer, code, scan);

    let invite = flows::offer_scanned(&mut phone, &link).await.unwrap();
    assert_eq!(invite.scanned(), Some(id.as_str()), "the phone knows which device it scanned before it claims");
    let c = one_candidate(&phone, &invite).await;
    assert_eq!(c.device_id, id);
    assert_eq!(fake.account(&account).version, 1, "nobody is added before the person taps Add");
    let (r, number) = flows::add_scanned(&mut phone, invite, &c.enrollment_id, BOTH).await.unwrap();

    let (computer, scanned) = joined.await.unwrap();
    let scanned = scanned.unwrap();
    assert_eq!(scanned.number, number, "both screens show the same number");
    assert_eq!(number.len(), 2);
    assert_eq!(scanned.roster.blob, r.blob);
    assert_eq!(scanned.signer_id, phone.cloud.device_id());
    assert!(computer.me().is_some(), "the roster lists the computer");
    let choices = invite::number_choices(&number);
    assert!(choices.contains(&number));
    assert!(choices[0] != choices[1] && choices[1] != choices[2] && choices[0] != choices[2], "{choices:?}");
}

#[tokio::test]
async fn a_wrong_number_makes_the_computer_leave_the_account() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let (computer, code, scan) = computer_showing_code(&base).await;
    let id = computer.cloud.device_id();
    let link = scan.link();
    let joined = computer_joins(computer, code, scan);
    let invite = flows::offer_scanned(&mut phone, &link).await.unwrap();
    let c = one_candidate(&phone, &invite).await;
    flows::add_scanned(&mut phone, invite, &c.enrollment_id, BOTH).await.unwrap();
    let (computer, scanned) = joined.await.unwrap();
    scanned.unwrap();
    assert!(fake.account(&account).devices[&id].1, "added");

    flows::Withdraw::leave(&computer.cloud).now().await;
    assert!(!fake.account(&account).devices[&id].1, "the computer left");
    assert!(fake.account(&account).revoked.contains(&id));
}

#[tokio::test]
async fn a_second_phone_that_scans_the_same_code_is_refused() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut ours, _) = phone_with_account(&fake, &base).await;
    let (mut theirs, _) = phone_with_account(&fake, &base).await;
    let (computer, code, scan) = computer_showing_code(&base).await;
    let link = scan.link();
    let first = flows::offer_scanned(&mut ours, &link).await.unwrap();
    match flows::offer_scanned(&mut theirs, &link).await {
        Err(FlowError::Api(e)) => assert!(e.is("already_decided"), "{e:?}"),
        other => panic!("expected already_decided, got {other:?}"),
    }
    let invites = fake.0.lock().unwrap().invites.keys().cloned().collect::<Vec<_>>();
    assert_eq!(invites, vec![first.slot_id.clone()], "the refused phone cancelled its invitation");
    drop((computer, code));
}

#[tokio::test]
async fn a_code_a_strangers_phone_answered_leaves_the_computer_in_no_account() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut owner, owners) = phone_with_account(&fake, &base).await;
    let (mut stranger, strangers) = phone_with_account(&fake, &base).await;
    let (computer, code, scan) = computer_showing_code(&base).await;
    let id = computer.cloud.device_id();
    let link = scan.link();
    let joined = computer_joins(computer, code, scan);
    // Someone who saw the code on a shared screen scans it first.
    let invite = flows::offer_scanned(&mut stranger, &link).await.unwrap();
    let c = one_candidate(&stranger, &invite).await;
    let (_, their_number) = flows::add_scanned(&mut stranger, invite, &c.enrollment_id, BOTH).await.unwrap();
    // The owner's phone is told the code was already answered.
    assert!(matches!(flows::offer_scanned(&mut owner, &link).await, Err(FlowError::Api(e)) if e.is("already_decided")));
    let (computer, scanned) = joined.await.unwrap();
    assert_eq!(scanned.unwrap().number, their_number, "only the stranger's phone shows the number");
    // The owner sees no number on their phone and cancels.
    flows::Withdraw::leave(&computer.cloud).now().await;
    assert!(!fake.account(&strangers).devices[&id].1);
    assert!(!fake.account(&owners).devices.contains_key(&id));
}

#[tokio::test]
async fn a_device_that_proves_the_secret_under_another_id_is_dropped_not_added() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let (computer, code, scan) = computer_showing_code(&base).await;
    let id = computer.cloud.device_id();
    let link = scan.link();
    let invite = flows::offer_scanned(&mut phone, &link).await.unwrap();
    // An onlooker read the code and learned the slot: its proof checks out.
    let seen = invite::parse_add_link(&link).unwrap();
    let mut onlooker = newcomer(&base);
    flows::claim_invite(&mut onlooker, &invite::link(&account, &invite.slot_id, &seen.secret)).await.unwrap();
    assert_eq!(flows::check_candidates(&phone, &invite).await.unwrap(), Candidates::Waiting, "dropped, and the invitation is not cancelled");
    assert!(fake.0.lock().unwrap().invites.contains_key(&invite.slot_id));

    let joined = computer_joins(computer, code, scan);
    let c = one_candidate(&phone, &invite).await;
    assert_eq!(c.device_id, id);
    let (r, _) = flows::add_scanned(&mut phone, invite, &c.enrollment_id, BOTH).await.unwrap();
    assert!(r.body.device(&onlooker.cloud.device_id()).is_none());
    joined.await.unwrap().1.unwrap();
}

#[tokio::test]
async fn a_cloud_without_the_secret_can_neither_swap_the_computers_keys_nor_confirm_a_roster() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let (mut computer, code, scan) = computer_showing_code(&base).await;
    let link = scan.link();
    let invite = flows::offer_scanned(&mut phone, &link).await.unwrap();
    let SignIn::Offered(offer) = flows::wait_for_sign_in(&computer.cloud, &code).await.unwrap() else { panic!("offered") };
    let claim = flows::claim_offer(&mut computer, &scan, offer).await.unwrap();
    // The cloud swaps in keys of its own: it cannot make the proof for them.
    {
        let mut s = fake.0.lock().unwrap();
        let p = s.accounts.get_mut(&account).unwrap().pending.values_mut().find(|p| p["device_id"] == json!(computer.cloud.device_id())).unwrap();
        fake_cloud::tamper_swap_pubs(p);
    }
    assert_eq!(flows::check_candidates(&phone, &invite).await.unwrap(), Candidates::Waiting);
    assert_eq!(fake.account(&account).version, 1);

    // A new code, claimed honestly, added; the cloud then forges `confirm`.
    let (mut computer, code, scan) = computer_showing_code(&base).await;
    let invite = flows::offer_scanned(&mut phone, &scan.link()).await.unwrap();
    let slot = invite.slot_id.clone();
    let SignIn::Offered(offer) = flows::wait_for_sign_in(&computer.cloud, &code).await.unwrap() else { panic!("offered") };
    let claim2 = flows::claim_offer(&mut computer, &scan, offer).await.unwrap();
    let c = one_candidate(&phone, &invite).await;
    flows::add_scanned(&mut phone, invite, &c.enrollment_id, BOTH).await.unwrap();
    fake.0.lock().unwrap().invites.get_mut(&slot).unwrap().confirm = Some(openagentd_cloud::encoding::b64(&[7u8; 32]));
    assert!(matches!(flows::await_scanned(&mut computer, claim2, FAST).await, Err(FlowError::ConfirmMismatch)));
    assert!(computer.roster.is_none());
    drop(claim);
}

#[tokio::test]
async fn a_device_that_showed_no_scan_code_refuses_an_offer() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, _) = phone_with_account(&fake, &base).await;
    let (computer, code, scan) = computer_showing_code(&base).await;
    flows::offer_scanned(&mut phone, &scan.link()).await.unwrap();
    // A sign-in that only expects the browser answer has no secret to claim with.
    assert!(matches!(flows::wait_for_session(&computer.cloud, &code).await, Err(FlowError::JoinEnded)));
}

#[tokio::test]
async fn the_scan_code_never_shows_its_secret_in_debug_output() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (_computer, _code, scan) = computer_showing_code(&base).await;
    let link = scan.link();
    let k = link.split("&k=").nth(1).unwrap().to_string();
    for text in [format!("{scan:?}"), format!("{:?}", invite::parse_add_link(&link).unwrap())] {
        assert!(!text.contains(&k), "{text}");
    }
}

#[tokio::test]
async fn cancelling_a_scanned_claim_already_added_but_not_confirmed_leaves_the_account() {
    let fake = Fake::new();
    let base = fake.serve().await;
    let (mut phone, account) = phone_with_account(&fake, &base).await;
    let (mut computer, code, scan) = computer_showing_code(&base).await;
    let invite = flows::offer_scanned(&mut phone, &scan.link()).await.unwrap();
    let flows::SignIn::Offered(offer) = flows::wait_for_sign_in(&computer.cloud, &code).await.unwrap() else { panic!("offered") };
    let claim = flows::claim_offer(&mut computer, &scan, offer).await.unwrap();
    let withdraw = flows::Withdraw::scanned(&computer.cloud, &claim.enrollment_id);
    let c = one_candidate(&phone, &invite).await;
    flows::add_scanned(&mut phone, invite, &c.enrollment_id, BOTH).await.unwrap();
    // The device is added, but its task is dropped before it reads confirm.
    let id = computer.cloud.device_id();
    assert!(fake.account(&account).devices[&id].1);
    drop(withdraw);
    flows::settle_withdrawals(Duration::from_secs(5)).await;
    assert!(!fake.account(&account).devices[&id].1);
    assert!(computer.roster.is_none());
}
