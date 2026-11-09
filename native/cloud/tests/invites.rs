//! Invitations (spec section 4.3) against the fake cloud: the signer never
//! adds a candidate on its own, two valid proofs add nobody, and the new
//! device trusts its first roster only through `confirm`.

mod fake_cloud;

use std::time::Duration;

use fake_cloud::Fake;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, Candidates, FlowError, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::DeviceKeys;
use serde_json::json;

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
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.account(&account).version, 1, "checking candidates never adds one");

    let r = flows::add_invited(&mut phone, invite, &c.enrollment_id).await.unwrap();
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
    let r = flows::add_invited(&mut phone, invite, &c.enrollment_id).await;
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
    let r = flows::add_invited(&mut phone, invite, "not-the-shown-candidate").await;
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
    flows::add_invited(&mut phone, invite, &c.enrollment_id).await.unwrap();
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
