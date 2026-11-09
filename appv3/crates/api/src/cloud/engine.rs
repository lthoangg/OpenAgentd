//! Joining an account for a host, shared by the routes and the CLI: by
//! invitation link (`POST /api/cloud/join`, `agentd cloud join`), the
//! default, or by device code and the 6-digit code (`POST /api/cloud/login`,
//! `agentd cloud login`), the fallback.
//! Computers do not create accounts here: an empty account ends in
//! [`Outcome::EmptyAccount`], and only `agentd cloud login --first-device`
//! continues with genesis.

use openagentd_cloud::api::{Cloud, DeviceCode};
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, FlowError, Member, Pace, Session};
use openagentd_cloud::keys::DeviceKeys;
use openagentd_cloud::store::Identity;

use super::Notice;

/// Progress a UI shows.
pub enum Event<'a> {
    /// Show the user code, the page and this device's fingerprint.
    Code(&'a DeviceCode),
    /// Waiting for a phone to approve; `code` once the 6 digits are known.
    Joining { fingerprint: String, code: Option<String> },
    /// Claimed an invitation: the phone shows this fingerprint and kind, and
    /// the person adds it there.
    Invited { fingerprint: String, kind: Option<&'static str> },
}

pub enum Outcome {
    /// Joined: the identity to store.
    Joined(Identity),
    /// The account has no devices yet. The session is unspent, so a caller
    /// that may create the account (`--first-device`) can still do genesis.
    EmptyAccount { member: Box<Member>, session: Session },
}

/// A short, non-secret reason for logs.
pub fn reason(e: &FlowError) -> String {
    match e {
        FlowError::Api(a) => format!("api:{}:{}", a.status, a.code),
        FlowError::Problem(p) => format!("problem:{p:?}"),
        FlowError::Roster(r) => format!("roster:{r}"),
        other => format!("{other:?}").split_whitespace().next().unwrap_or("error").to_string(),
    }
}

pub fn notice(e: &FlowError) -> Notice {
    match e {
        FlowError::Denied => Notice::Denied,
        FlowError::Expired | FlowError::TimedOut => Notice::Expired,
        FlowError::JoinEnded => Notice::JoinEnded,
        FlowError::CommitMismatch => Notice::CommitMismatch,
        FlowError::ConfirmMismatch => Notice::ConfirmMismatch,
        FlowError::Protocol(openagentd_cloud::Error::Invite) => Notice::InviteInvalid,
        FlowError::EmptyAccount => Notice::EmptyAccount,
        FlowError::Problem(openagentd_cloud::account_state::AccountProblem::Deleted) => Notice::Deleted,
        _ => Notice::Failed,
    }
}

/// Signs in a fresh device identity and joins the account through a signer.
pub async fn sign_in(endpoints: Endpoints, http: reqwest::Client, mut on: impl FnMut(Event<'_>)) -> Result<Outcome, FlowError> {
    let keys = DeviceKeys::generate();
    let fingerprint = keys.fingerprint();
    let cloud = Cloud::new(http, endpoints, keys, None);
    let code = cloud.device_code().await?;
    on(Event::Code(&code));
    let session = flows::wait_for_session(&cloud, &code).await?;
    let mut member = Member::new(cloud, None);
    let req = match flows::request_to_join(&mut member, &session).await {
        Ok(r) => r,
        Err(FlowError::EmptyAccount) => return Ok(Outcome::EmptyAccount { member: Box::new(member), session }),
        Err(e) => return Err(e),
    };
    on(Event::Joining { fingerprint: fingerprint.clone(), code: None });
    let join = flows::await_signer(&mut member, &req, Pace::default()).await?;
    on(Event::Joining { fingerprint, code: Some(join.code.clone()) });
    let roster = flows::await_added(&mut member, join, &req, Pace::default()).await?;
    Ok(Outcome::Joined(identity_of(&member, &roster)))
}

/// Joins the account in an invitation link with a fresh device identity.
/// The link is a bearer secret: it is never logged or stored.
pub async fn join_invite(endpoints: Endpoints, http: reqwest::Client, link: &str, mut on: impl FnMut(Event<'_>)) -> Result<Outcome, FlowError> {
    let keys = DeviceKeys::generate();
    let fingerprint = keys.fingerprint();
    let mut member = Member::new(Cloud::new(http, endpoints, keys, None), None);
    let claim = flows::claim_invite(&mut member, link).await?;
    on(Event::Invited { fingerprint, kind: openagentd_cloud::api::this_kind() });
    let roster = flows::await_invited(&mut member, claim, Pace::default()).await?;
    Ok(Outcome::Joined(identity_of(&member, &roster)))
}

/// The identity to store for an enrolled member.
pub fn identity_of(member: &Member, roster: &openagentd_cloud::roster::Roster) -> Identity {
    let mut id = Identity::new(&member.cloud.keys);
    id.account_id = member.cloud.account_id.clone();
    id.roster = Some(roster.blob.clone());
    id
}
