//! Joining an account for a host, shared by the routes and the CLI: by
//! signing in and having a device already in the account approve this one
//! with the 6-digit code (`POST /api/cloud/login`, `agentd cloud login`),
//! the default, or by invitation link (`POST /api/cloud/join`,
//! `agentd cloud join`). An empty account ends in [`Outcome::EmptyAccount`]
//! with the session unspent: the caller shows the recovery code and runs
//! genesis (spec 4.1), so any computer can be the first device.

use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::{Cloud, DeviceCode, Refusal};
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, FlowError, JoinStep, Member, Pace, Session, Withdraw};
use openagentd_cloud::keys::{DeviceKeys, Roles};
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
    /// The account has no devices yet. The session is unspent, so the
    /// caller can create the account with this device (genesis).
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
        FlowError::Roles => Notice::Roles,
        FlowError::Problem(AccountProblem::Deleted) => Notice::Deleted,
        FlowError::Problem(AccountProblem::Closing { .. }) => Notice::AccountClosing,
        FlowError::Problem(AccountProblem::Unavailable) => Notice::AccountUnavailable,
        FlowError::Api(a) => match a.refusal() {
            Some(Refusal::RateLimited { .. }) => Notice::RateLimited,
            Some(Refusal::TooManyPending) => Notice::TooManyPending,
            Some(Refusal::DeviceLimit) => Notice::DeviceLimit,
            Some(Refusal::DeviceExists) => Notice::DeviceExists,
            Some(Refusal::Unreachable) => Notice::Unreachable,
            None => Notice::Failed,
        },
        _ => Notice::Failed,
    }
}

/// Seconds the cloud asked to wait (`rate_limited`), for the notice.
pub fn retry_after(e: &FlowError) -> Option<u64> {
    match e {
        FlowError::Api(a) => match a.refusal() {
            Some(Refusal::RateLimited { retry_after }) => retry_after,
            _ => None,
        },
        _ => None,
    }
}

/// What the person reads when signing in or joining ended with `e`, for
/// the CLI (the web UI words the same notices in `account-copy.tsx`). No
/// em or en dashes.
pub fn message(e: &FlowError) -> Option<String> {
    Some(match notice(e) {
        Notice::RateLimited => match retry_after(e) {
            Some(s) => format!("OpenAgentd is getting too many requests from this network. Try again in {}.", wait_text(s)),
            None => "OpenAgentd is getting too many requests from this network. Try again in a few minutes.".to_string(),
        },
        Notice::TooManyPending => "3 devices are already waiting to join; wait a few minutes or reject them on a device that approves.".to_string(),
        Notice::DeviceLimit => "Your account has 10 devices; remove one first.".to_string(),
        Notice::DeviceExists => "This device is already in your account or waiting to join. Sign in again to start over.".to_string(),
        Notice::Unreachable => "Could not reach OpenAgentd. Check your network and try again.".to_string(),
        _ => return None,
    })
}

/// `45` → `45 seconds`, `60` → `1 minute`, `600` → `10 minutes`.
pub fn wait_text(secs: u64) -> String {
    match secs {
        0..=1 => "a moment".to_string(),
        2..=59 => format!("{secs} seconds"),
        60..=119 => "1 minute".to_string(),
        _ => format!("{} minutes", secs.div_ceil(60)),
    }
}

/// Signs in a fresh device identity asking for `roles`, and joins the
/// account through a signer.
pub async fn sign_in(endpoints: Endpoints, http: reqwest::Client, roles: Roles, mut on: impl FnMut(Event<'_>)) -> Result<Outcome, FlowError> {
    let keys = DeviceKeys::generate();
    let fingerprint = keys.fingerprint();
    let mut cloud = Cloud::new(http, endpoints, keys, None);
    cloud.roles = roles;
    let code = cloud.device_code().await?;
    on(Event::Code(&code));
    let session = flows::wait_for_session(&cloud, &code).await?;
    let mut member = Member::new(cloud, None);
    // A request that does not end in joining is withdrawn (also when this
    // future is dropped: the person closed the sheet).
    let joined = flows::join_with_code(&mut member, &session, Pace::default(), |step| match step {
        JoinStep::Requested => on(Event::Joining { fingerprint: fingerprint.clone(), code: None }),
        JoinStep::Code(code) => on(Event::Joining { fingerprint: fingerprint.clone(), code: Some(code.to_string()) }),
    })
    .await;
    let roster = match joined {
        Ok(r) => r,
        Err(FlowError::EmptyAccount) => return Ok(Outcome::EmptyAccount { member: Box::new(member), session }),
        Err(e) => return Err(e),
    };
    Ok(Outcome::Joined(identity_of(&member, &roster)))
}

/// Joins the account in an invitation link with a fresh device identity.
/// The link is a bearer secret: it is never logged or stored.
pub async fn join_invite(endpoints: Endpoints, http: reqwest::Client, link: &str, roles: Roles, mut on: impl FnMut(Event<'_>)) -> Result<Outcome, FlowError> {
    let keys = DeviceKeys::generate();
    let fingerprint = keys.fingerprint();
    let mut member = Member::new(Cloud::new(http, endpoints, keys, None), None);
    member.cloud.roles = roles;
    let claim = flows::claim_invite(&mut member, link).await?;
    let withdraw = Withdraw::arm(&member.cloud, &claim.enrollment_id);
    on(Event::Invited { fingerprint, kind: openagentd_cloud::api::this_kind() });
    match flows::await_invited(&mut member, claim, Pace::default()).await {
        Ok(roster) => {
            withdraw.keep();
            Ok(Outcome::Joined(identity_of(&member, &roster)))
        }
        Err(e) => {
            withdraw.now().await;
            Err(e)
        }
    }
}

/// The identity to store for an enrolled member.
pub fn identity_of(member: &Member, roster: &openagentd_cloud::roster::Roster) -> Identity {
    let mut id = Identity::new(&member.cloud.keys);
    id.account_id = member.cloud.account_id.clone();
    id.roster = Some(roster.blob.clone());
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use openagentd_cloud::api::ApiError;

    fn refused(status: u16, code: &str, retry_after: Option<u64>) -> FlowError {
        FlowError::Api(ApiError { status, code: code.into(), body: None, retry_after })
    }

    #[test]
    fn each_refusal_has_its_own_notice_and_message() {
        let cases = [
            (refused(429, "rate_limited", Some(120)), Notice::RateLimited, "Try again in 2 minutes."),
            (refused(409, "too_many_pending", None), Notice::TooManyPending, "3 devices are already waiting to join"),
            (refused(403, "device_limit", None), Notice::DeviceLimit, "Your account has 10 devices; remove one first."),
            (refused(409, "device_exists", None), Notice::DeviceExists, "already in your account"),
            (refused(0, "network", None), Notice::Unreachable, "Check your network"),
        ];
        for (e, n, text) in cases {
            assert_eq!(notice(&e), n, "{e:?}");
            let m = message(&e).unwrap();
            assert!(m.contains(text), "{m}");
            assert!(!m.contains('\u{2014}') && !m.contains('\u{2013}'), "no em or en dash: {m}");
        }
        assert_eq!(retry_after(&refused(429, "rate_limited", Some(30))), Some(30));
        assert_eq!(message(&refused(429, "rate_limited", None)).unwrap(), "OpenAgentd is getting too many requests from this network. Try again in a few minutes.");
        assert_eq!(notice(&FlowError::Problem(AccountProblem::Closing { deletes_at: None })), Notice::AccountClosing);
        assert_eq!(notice(&FlowError::Problem(AccountProblem::Unavailable)), Notice::AccountUnavailable);
        assert_eq!(notice(&refused(400, "invalid_request", None)), Notice::Failed);
        assert_eq!(message(&refused(400, "invalid_request", None)), None);
    }

    #[test]
    fn waits_read_naturally() {
        assert_eq!(wait_text(1), "a moment");
        assert_eq!(wait_text(45), "45 seconds");
        assert_eq!(wait_text(60), "1 minute");
        assert_eq!(wait_text(61), "1 minute");
        assert_eq!(wait_text(600), "10 minutes");
        assert_eq!(wait_text(601), "11 minutes");
    }
}
