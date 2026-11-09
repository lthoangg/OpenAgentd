//! What a device does to join an account and stay in it (spec section 4),
//! as steps a UI can drive: each step is one `async fn`, and dropping its
//! future cancels it.

use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use crate::account_state::AccountProblem;
use crate::api::{ApiError, Cloud, DeviceCode, Pending, Secret, TokenPoll};
use crate::code::{self, CodeInput, Joiner, Signer};
use crate::encoding::{b64, from_b64};
use crate::keys::{self, random_bytes, Ed25519, Roles, Seed};
use crate::roster::{self, Chain, Device, Roster};
use crate::{invite, lines, recovery};

/// Why a flow stopped.
#[derive(Debug, thiserror::Error)]
pub enum FlowError {
    #[error("{0}")]
    Api(ApiError),
    /// The account itself is in trouble (closing, unavailable, deleted, or
    /// this device was removed).
    #[error("account problem: {0:?}")]
    Problem(AccountProblem),
    #[error("the cloud served a roster that breaks rule {0}")]
    Roster(roster::Rule),
    #[error("sign-in was denied")]
    Denied,
    #[error("the sign-in code expired")]
    Expired,
    /// The account has no devices yet (the first device sets it up).
    #[error("the account has no devices yet")]
    EmptyAccount,
    #[error("the request to join was cancelled or expired")]
    JoinEnded,
    #[error("the joining device's commitment did not match; the request was cancelled")]
    CommitMismatch,
    #[error("this device cannot approve devices")]
    NotSigner,
    /// The approver tried to give a role the joining device did not ask
    /// for, or no role at all.
    #[error("a device can only get the roles it asked for, and at least one")]
    Roles,
    #[error("timed out")]
    TimedOut,
    /// More than one device proved it holds the invitation's secret, so
    /// someone else has it. The invitation was cancelled; nobody was added.
    #[error("someone else has this invitation; it was cancelled")]
    InviteCompromised,
    /// The signer's `confirm` does not match the roster the cloud served.
    #[error("the invitation's confirmation did not match the roster")]
    ConfirmMismatch,
    #[error("{0}")]
    Protocol(crate::Error),
}

impl From<ApiError> for FlowError {
    fn from(e: ApiError) -> Self {
        match e.problem() {
            Some(p) => FlowError::Problem(p),
            None => FlowError::Api(e),
        }
    }
}

impl From<crate::Error> for FlowError {
    fn from(e: crate::Error) -> Self {
        match e {
            crate::Error::Roster(rule) => FlowError::Roster(rule),
            other => FlowError::Protocol(other),
        }
    }
}

pub type FlowResult<T> = Result<T, FlowError>;

/// What [`Member::confirm_removal`] found.
#[derive(Debug)]
pub enum Removal {
    /// The cloud confirmed it with a signed answer: erase the keys.
    Removed,
    /// This device is still in the verified roster (which may have changed).
    NotRemoved(Sync),
    /// No signed answer either way (offline, another problem): keep the
    /// keys and ask again later.
    Unsure(FlowError),
}

/// How often the steps that wait on another device poll the cloud.
#[derive(Debug, Clone, Copy)]
pub struct Pace {
    pub every: Duration,
    pub timeout: Duration,
}

impl Default for Pace {
    fn default() -> Self {
        Pace { every: Duration::from_secs(2), timeout: Duration::from_secs(10 * 60) }
    }
}

async fn poll<T, F, Fut>(pace: Pace, mut read: F) -> FlowResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = FlowResult<Option<T>>>,
{
    let deadline = Instant::now() + pace.timeout;
    loop {
        if let Some(v) = read().await? {
            return Ok(v);
        }
        if Instant::now() > deadline {
            return Err(FlowError::TimedOut);
        }
        tokio::time::sleep(pace.every).await;
    }
}

/// Whether a joining device's request is gone: `not_found` for its own
/// entry, or `401` once its pending row was deleted (the cloud no longer
/// knows the device; `Cloud::signed` already retried with a fresh nonce).
fn request_gone(e: &ApiError) -> bool {
    e.is("not_found") || e.status == 401
}

// ---- Sign-in -----------------------------------------------------------

/// An approved device code: a single-use enrollment session.
#[derive(Debug)]
pub struct Session {
    pub session: Secret,
    pub account_id: String,
}

/// Polls until the person approves the device code, denies it, or it
/// expires. A person on the waitlist cannot approve, so this ends in
/// [`FlowError::Expired`] for them; the UI says so.
pub async fn wait_for_session(cloud: &Cloud, code: &DeviceCode) -> FlowResult<Session> {
    let deadline = Instant::now() + Duration::from_secs(code.expires_in);
    let mut interval = Duration::from_secs(code.interval);
    loop {
        // The first poll goes at once: the person may have approved already.
        let poll = cloud.device_token(code).await?;
        match &poll {
            TokenPoll::Session { session, account_id } => return Ok(Session { session: session.clone(), account_id: account_id.clone() }),
            TokenPoll::Denied => return Err(FlowError::Denied),
            TokenPoll::Expired => return Err(FlowError::Expired),
            TokenPoll::Pending | TokenPoll::SlowDown => {}
        }
        interval = crate::api::next_interval(interval, &poll);
        if Instant::now() + interval > deadline {
            return Err(FlowError::Expired);
        }
        tokio::time::sleep(interval).await;
    }
}

// ---- Member: a device in an account -------------------------------------

/// A device with its last verified roster (its `K`).
#[derive(Debug)]
pub struct Member {
    pub cloud: Cloud,
    pub roster: Option<Roster>,
}

/// What [`Member::sync`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sync {
    pub changed: bool,
    /// Devices that were in `K` and are not anymore.
    pub removed: Vec<String>,
}

impl Member {
    pub fn new(cloud: Cloud, roster: Option<Roster>) -> Self {
        Member { cloud, roster }
    }

    pub fn account_id(&self) -> Option<&str> {
        self.cloud.account_id.as_deref()
    }

    /// This device's entry in `K`.
    pub fn me(&self) -> Option<&Device> {
        let id = self.cloud.device_id();
        self.roster.as_ref()?.body.devices.iter().find(|d| d.id == id)
    }

    pub fn is_signer(&self) -> bool {
        self.me().is_some_and(|d| d.signer)
    }

    /// Uses `sign` for roster writes (a signing key kept apart and unlocked
    /// for one approval). Returns the key it replaced.
    pub fn set_sign_key(&mut self, sign: Ed25519) -> Ed25519 {
        std::mem::replace(&mut self.cloud.keys.sign, sign)
    }

    /// The `box` key of an active device in `K`.
    pub fn box_of(&self, device_id: &str) -> Option<[u8; 32]> {
        self.roster.as_ref()?.body.device(device_id).map(|d| d.box_key())
    }

    /// The `box` key of a device in `K` that may open sessions to this
    /// host (`client: true`); `None` refuses it (spec section 3.4).
    pub fn controller_box(&self, device_id: &str) -> Option<[u8; 32]> {
        self.roster.as_ref()?.body.client(device_id).map(|d| d.box_key())
    }

    /// Whether this device's own entry in `K` says it runs a host.
    pub fn is_server(&self) -> bool {
        self.me().is_some_and(|d| d.server)
    }

    /// Whether this device's own entry in `K` lets it open sessions.
    pub fn is_client(&self) -> bool {
        self.me().is_some_and(|d| d.client)
    }

    /// Fetches the head and verifies it after `K`. A roster that no longer
    /// lists this device means it was removed.
    pub async fn sync(&mut self) -> FlowResult<Sync> {
        let account = self.account_id().ok_or(FlowError::EmptyAccount)?.to_string();
        let head = self.cloud.roster().await?;
        let known = self.roster.as_ref().ok_or(FlowError::EmptyAccount)?;
        if head.blob == known.blob {
            return Ok(Sync { changed: false, removed: vec![] });
        }
        let next = roster::verify(&head.blob, &account, Some(known), Chain::Skip)?;
        let change = roster::diff(&known.body, &next.body);
        let still_here = next.body.device(&self.cloud.device_id()).is_some();
        self.roster = Some(next);
        if !still_here {
            return Err(FlowError::Problem(AccountProblem::Revoked));
        }
        Ok(Sync { changed: true, removed: change.removed })
    }

    /// After an unsigned removal signal from the relay, asks the cloud with
    /// one signed `GET /v1/roster`. Only `403 device_revoked`, or a verified
    /// roster that no longer lists this device, confirms the removal; any
    /// other answer keeps the keys.
    pub async fn confirm_removal(&mut self) -> Removal {
        match self.sync().await {
            Ok(sync) => Removal::NotRemoved(sync),
            Err(FlowError::Problem(AccountProblem::Revoked)) => Removal::Removed,
            Err(e) => Removal::Unsure(e),
        }
    }

    /// Signs and writes the next roster with `devices`.
    pub async fn write(&mut self, devices: Vec<Device>) -> FlowResult<Roster> {
        self.sync().await?;
        if !self.is_signer() {
            return Err(FlowError::NotSigner);
        }
        let known = self.roster.as_ref().expect("synced");
        let next = roster::sign(&known.next_body(devices), &self.cloud.device_id(), &self.cloud.keys.sign);
        // Check our own writer against the rules before the cloud does.
        roster::verify(&next.blob, known.account_id(), Some(known), Chain::Linked)?;
        self.cloud.put_roster(known.version(), &next).await?;
        self.roster = Some(next.clone());
        Ok(next)
    }

    /// Removes `device_id` from the account (signer only).
    pub async fn remove(&mut self, device_id: &str) -> FlowResult<Roster> {
        self.sync().await?;
        let devices = self.roster.as_ref().expect("synced").body.devices.iter().filter(|d| d.id != device_id).cloned().collect();
        self.write(devices).await
    }
}

// ---- Genesis (spec section 4.1) ----------------------------------------

/// The recovery key, made before genesis so its code can be shown first.
pub struct GenesisDraft {
    recovery: Ed25519,
    /// The recovery code, for showing once.
    pub code: Zeroizing<String>,
}

impl std::fmt::Debug for GenesisDraft {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GenesisDraft([redacted])")
    }
}

impl GenesisDraft {
    pub fn new() -> Self {
        let recovery = Ed25519::from_seed(Seed::random());
        let code = recovery::encode(recovery.seed());
        GenesisDraft { recovery, code }
    }

    /// The two groups (1-based) the person must type back.
    pub fn check_groups(&self) -> (usize, usize) {
        let r: [u8; 2] = random_bytes();
        let a = 1 + (r[0] as usize % recovery::GROUPS);
        let mut b = 1 + (r[1] as usize % recovery::GROUPS);
        if b == a {
            b = a % recovery::GROUPS + 1;
        }
        (a.min(b), a.max(b))
    }
}

impl Default for GenesisDraft {
    fn default() -> Self {
        Self::new()
    }
}

/// `lines("agentd-cloud-recovery-key-v1", account_id, b64(recovery_pub))`.
pub fn recovery_key_message(account_id: &str, recovery_pub: &[u8; 32]) -> Vec<u8> {
    lines!["agentd-cloud-recovery-key-v1", account_id, &b64(recovery_pub)]
}

/// Creates the account's first roster with this device as its signer and
/// `member.cloud.roles` as its roles. Any device may be first. The draft
/// (and with it the recovery private key) is dropped and wiped here.
pub async fn genesis(member: &mut Member, session: &Session, draft: GenesisDraft) -> FlowResult<Roster> {
    let account = session.account_id.clone();
    member.cloud.account_id = Some(account.clone());
    let recovery_pub = draft.recovery.public();
    if !member.cloud.roles.is_valid() {
        return Err(FlowError::Roles);
    }
    let body = roster::Body::genesis(&account, &recovery_pub, Device::of(&member.cloud.keys, true, member.cloud.roles));
    let r = roster::sign(&body, &member.cloud.device_id(), &member.cloud.keys.sign);
    let r = roster::verify(&r.blob, &account, None, Chain::Linked)?;
    let sig = draft.recovery.sign(&recovery_key_message(&account, &recovery_pub));
    drop(draft);
    member.cloud.enroll_genesis(&session.session, &recovery_pub, &sig, &r.blob).await?;
    member.roster = Some(r.clone());
    Ok(r)
}

// ---- Joining with the 6-digit code (spec section 4.2, device N) ---------

/// A posted request to join.
pub struct JoinRequest {
    pub enrollment_id: String,
    n_n: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for JoinRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JoinRequest({})", self.enrollment_id)
    }
}

/// Posts the pending enrollment, asking for `member.cloud.roles`. An
/// account without a roster answers [`FlowError::EmptyAccount`], and the
/// session stays unspent for genesis.
pub async fn request_to_join(member: &mut Member, session: &Session) -> FlowResult<JoinRequest> {
    if !member.cloud.roles.is_valid() {
        return Err(FlowError::Roles);
    }
    member.cloud.account_id = Some(session.account_id.clone());
    let n_n = Zeroizing::new(random_bytes::<32>());
    let commit = code::commit(&member.cloud.pubs(), n_n.as_ref());
    match member.cloud.enroll_pending(&session.session, &commit).await {
        Ok(enrollment_id) => Ok(JoinRequest { enrollment_id, n_n }),
        Err(e) if e.is("no_roster") => Err(FlowError::EmptyAccount),
        Err(e) => Err(e.into()),
    }
}

/// The code both screens show, and what N needs to recognise the roster
/// that adds it.
#[derive(Debug)]
pub struct JoinCode {
    pub code: String,
    pub signer_id: String,
    head: Roster,
}

/// Waits for a signer to answer, reveals `n_n`, and computes the code.
pub async fn await_signer(member: &mut Member, req: &JoinRequest, pace: Pace) -> FlowResult<JoinCode> {
    let cloud = &member.cloud;
    let asked: Pending = poll(pace, || async {
        match cloud.pending(&req.enrollment_id).await {
            Ok(p) if p.n_a.is_some() && p.n_a_by.is_some() => Ok(Some(p)),
            Ok(_) => Ok(None),
            Err(e) if request_gone(&e) => Err(FlowError::JoinEnded),
            Err(e) => Err(e.into()),
        }
    })
    .await?;
    let account = cloud.account_id.clone().expect("set when the request was posted");
    let head = roster::trust_head(&cloud.roster().await?.blob, &account)?;
    let signer_id = asked.n_a_by.clone().expect("checked");
    let a = head.body.signer(&signer_id).ok_or(FlowError::NotSigner)?.clone();
    let n_a = from_b64(asked.n_a.as_deref().expect("checked")).map_err(FlowError::Protocol)?;
    cloud.post_n_n(&req.enrollment_id, req.n_n.as_ref()).await?;
    let pubs = cloud.pubs();
    let me = cloud.device_id();
    let input = CodeInput {
        account_id: &account,
        enrollment_id: &req.enrollment_id,
        a: Signer { id: &a.id, r#box: a.box_key(), sign: a.sign_key() },
        n: Joiner { id: &me, pubs: &pubs, r#box: cloud.keys.r#box.public() },
        n_a: &n_a,
        n_n: req.n_n.as_ref(),
    };
    let code = code::six_digit_code(&cloud.keys.r#box, &input)?;
    Ok(JoinCode { code, signer_id, head })
}

/// Waits for the roster that adds this device, signed by the signer whose
/// code the person compared. It becomes `K`.
pub async fn await_added(member: &mut Member, join: JoinCode, req: &JoinRequest, pace: Pace) -> FlowResult<Roster> {
    let account = member.cloud.account_id.clone().expect("set");
    let mine = Device::of(&member.cloud.keys, false, member.cloud.roles);
    let cloud = &member.cloud;
    let head = &join.head;
    let added = poll(pace, || async {
        let now = match cloud.roster().await {
            Ok(n) => n,
            Err(e) if request_gone(&e) => return Err(FlowError::JoinEnded),
            Err(e) => return Err(e.into()),
        };
        if now.blob == head.blob {
            // Still waiting, unless the request is gone (rejected or expired).
            return match cloud.pending(&req.enrollment_id).await {
                Err(e) if request_gone(&e) => Err(FlowError::JoinEnded),
                Err(e) => Err(e.into()),
                Ok(_) => Ok(None),
            };
        }
        let r = roster::verify(&now.blob, &account, Some(head), Chain::Skip)?;
        match r.body.device(&mine.id) {
            // Roles may be fewer than asked (the approver turned one off),
            // never more: the cloud refuses that, and so does this device.
            Some(me) if r.by == join.signer_id && me.auth == mine.auth && me.r#box == mine.r#box && me.sign == mine.sign => {
                if me.roles().within(mine.roles()) {
                    Ok(Some(r))
                } else {
                    Err(FlowError::Roles)
                }
            }
            Some(_) => Err(FlowError::Roster(roster::Rule::Keys)),
            None => Ok(None),
        }
    })
    .await?;
    member.roster = Some(added.clone());
    Ok(added)
}

// ---- Approving (spec section 4.2, signer A) -----------------------------

/// An approval in progress: `n_a` posted.
pub struct Approval {
    pub pending: Pending,
    n_a: Zeroizing<[u8; 32]>,
    pubs: keys::Pubs,
}

impl std::fmt::Debug for Approval {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Approval({})", self.pending.enrollment_id)
    }
}

/// The code A shows, next to the joining device's fingerprint and the
/// roles it asked for.
#[derive(Debug, Clone)]
pub struct ApprovalCode {
    pub code: String,
    pub fingerprint: String,
    pub kind: Option<String>,
    pub roles: Roles,
}

/// What the approver gives the joining device: signer or member, and its
/// roles (those it asked for, or fewer, at least one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grant {
    pub signer: bool,
    pub roles: Roles,
}

impl Approval {
    /// The roles the joining device asked for (covered by the code).
    pub fn requested(&self) -> Roles {
        self.pubs.roles
    }
}

/// Checks a grant against what the device asked for.
fn granted(asked: Roles, grant: Grant) -> FlowResult<Roles> {
    if grant.roles.is_valid() && grant.roles.within(asked) {
        Ok(grant.roles)
    } else {
        Err(FlowError::Roles)
    }
}

/// Step 2: post `n_a` for a pending request.
pub async fn begin_approval(member: &mut Member, pending: Pending) -> FlowResult<Approval> {
    member.sync().await?;
    if !member.is_signer() {
        return Err(FlowError::NotSigner);
    }
    if pending.commit.is_none() || pending.auth_pub.is_none() {
        return Err(FlowError::JoinEnded);
    }
    let pubs = keys::parse_pubs(&from_b64(&pending.pubs).map_err(FlowError::Protocol)?).map_err(FlowError::Protocol)?;
    let n_a = Zeroizing::new(random_bytes::<32>());
    member.cloud.post_n_a(&pending.enrollment_id, n_a.as_ref()).await?;
    Ok(Approval { pending, n_a, pubs })
}

/// Step 4: waits for `n_n`, checks the commitment (cancelling on a
/// mismatch), and computes the code.
pub async fn await_reveal(member: &mut Member, approval: &mut Approval, pace: Pace) -> FlowResult<ApprovalCode> {
    let cloud = &member.cloud;
    let id = approval.pending.enrollment_id.clone();
    let revealed: Pending = poll(pace, || async {
        match cloud.pending(&id).await {
            Ok(p) if p.n_n.is_some() => Ok(Some(p)),
            Ok(_) => Ok(None),
            // The signer stays known: only `not_found` means the request ended.
            Err(e) if e.is("not_found") => Err(FlowError::JoinEnded),
            Err(e) => Err(e.into()),
        }
    })
    .await?;
    let n_n = from_b64(revealed.n_n.as_deref().expect("checked")).map_err(FlowError::Protocol)?;
    let pubs_bytes = from_b64(&approval.pending.pubs).map_err(FlowError::Protocol)?;
    let commit = from_b64(approval.pending.commit.as_deref().unwrap_or_default()).map_err(FlowError::Protocol)?;
    // The joining device's keys must be the ones it committed to and that
    // its id derives from.
    let auth_pub: [u8; 32] = crate::encoding::from_b64_array(approval.pending.auth_pub.as_deref().unwrap_or_default()).map_err(FlowError::Protocol)?;
    if !code::commit_matches(&commit, &pubs_bytes, &n_n) || keys::device_id(&auth_pub) != approval.pending.device_id {
        let _ = cloud.cancel_pending(&id).await;
        return Err(FlowError::CommitMismatch);
    }
    let me = member.me().ok_or(FlowError::NotSigner)?.clone();
    let input = CodeInput {
        account_id: member.account_id().expect("a member has an account"),
        enrollment_id: &id,
        a: Signer { id: &me.id, r#box: me.box_key(), sign: me.sign_key() },
        n: Joiner { id: &approval.pending.device_id, pubs: &pubs_bytes, r#box: approval.pubs.r#box },
        n_a: approval.n_a.as_ref(),
        n_n: &n_n,
    };
    let code = code::six_digit_code(&member.cloud.keys.r#box, &input)?;
    approval.pending.n_n = revealed.n_n;
    Ok(ApprovalCode { code, fingerprint: keys::fingerprint(&approval.pending.device_id).unwrap_or_default(), kind: approval.pending.kind.clone(), roles: approval.pubs.roles })
}

/// The person confirmed the codes match: write the roster that adds it
/// with `grant`. A role it did not ask for is refused ([`FlowError::Roles`])
/// before anything is written.
pub async fn confirm_approval(member: &mut Member, approval: Approval, grant: Grant) -> FlowResult<Roster> {
    let roles = granted(approval.pubs.roles, grant)?;
    let auth_pub: [u8; 32] = crate::encoding::from_b64_array(approval.pending.auth_pub.as_deref().unwrap_or_default()).map_err(FlowError::Protocol)?;
    member.sync().await?;
    let mut devices = member.roster.as_ref().expect("synced").body.devices.clone();
    devices.push(Device::enrolled(&auth_pub, &approval.pubs, grant.signer, roles));
    member.write(devices).await
}

/// The codes differ, or the person said no: cancel the request.
pub async fn reject_approval(member: &Member, approval: Approval) -> FlowResult<()> {
    member.cloud.cancel_pending(&approval.pending.enrollment_id).await?;
    Ok(())
}

// ---- Invitations (spec section 4.3) --------------------------------------
//
// The invitation secret is a bearer secret until it is used. The signer
// side never adds a candidate on its own: `add_invited` needs the
// enrollment id a person picked, and it re-checks every candidate first.
// When more than one proof checks out, nobody is added and the invitation
// is cancelled.

/// An open invitation on the signer. Dropping it zeroizes the secret; call
/// [`cancel_invite`] first when the person closes the sheet.
pub struct Invite {
    pub account_id: String,
    pub slot_id: String,
    /// Unix ms.
    pub expires_at: u64,
    secret: Zeroizing<[u8; 16]>,
}

impl std::fmt::Debug for Invite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Invite({}, [redacted])", self.slot_id)
    }
}

impl Invite {
    /// The link (and QR code content). A bearer secret: show it only while
    /// the person is adding a device.
    pub fn link(&self) -> Zeroizing<String> {
        invite::link(&self.account_id, &self.slot_id, self.secret.as_ref())
    }
}

/// A device whose `proof` checks out, as the person sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteCandidate {
    pub enrollment_id: String,
    pub device_id: String,
    pub fingerprint: String,
    /// Self-reported; a label only.
    pub kind: Option<String>,
    /// The roles it asked for (covered by its proof).
    pub roles: Roles,
    auth_pub: [u8; 32],
    pubs: keys::Pubs,
}

/// What the signer found among an invitation's candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Candidates {
    /// No candidate proved the secret yet.
    Waiting,
    /// Exactly one did. Show it; add it only when the person confirms.
    One(InviteCandidate),
}

/// Sorts an invitation's candidates (pure): the ones whose proof checks
/// out, and the enrollment ids of the rest.
pub fn sort_candidates(secret: &[u8], account_id: &str, slot_id: &str, pending: &[Pending]) -> (Vec<InviteCandidate>, Vec<String>) {
    let (mut valid, mut invalid) = (Vec::new(), Vec::new());
    for p in pending.iter().filter(|p| p.invite_slot.as_deref() == Some(slot_id)) {
        match check_candidate(secret, account_id, slot_id, p) {
            Some(c) => valid.push(c),
            None => invalid.push(p.enrollment_id.clone()),
        }
    }
    (valid, invalid)
}

fn check_candidate(secret: &[u8], account_id: &str, slot_id: &str, p: &Pending) -> Option<InviteCandidate> {
    let auth_pub: [u8; 32] = crate::encoding::from_b64_array(p.auth_pub.as_deref()?).ok()?;
    if keys::device_id(&auth_pub) != p.device_id {
        return None;
    }
    let pubs_bytes = from_b64(&p.pubs).ok()?;
    let proof = from_b64(p.proof.as_deref()?).ok()?;
    let c = invite::Candidate { account_id, slot_id, device_id: &p.device_id, auth_pub: &auth_pub, pubs: &pubs_bytes };
    if !invite::proof_matches(secret, &c, &proof) {
        return None;
    }
    let pubs = keys::parse_pubs(&pubs_bytes).ok()?;
    Some(InviteCandidate {
        enrollment_id: p.enrollment_id.clone(),
        device_id: p.device_id.clone(),
        fingerprint: keys::fingerprint(&p.device_id)?,
        kind: p.kind.clone(),
        roles: pubs.roles,
        auth_pub,
        pubs,
    })
}

/// Opens an invitation (signer only).
pub async fn start_invite(member: &mut Member) -> FlowResult<Invite> {
    member.sync().await?;
    if !member.is_signer() {
        return Err(FlowError::NotSigner);
    }
    let account_id = member.account_id().ok_or(FlowError::EmptyAccount)?.to_string();
    let slot = member.cloud.invite_create().await?;
    Ok(Invite { account_id, slot_id: slot.slot_id, expires_at: slot.expires_at, secret: Zeroizing::new(random_bytes::<16>()) })
}

/// Looks at the invitation's candidates. Drops those whose proof fails.
/// When more than one proof checks out, cancels the invitation and returns
/// [`FlowError::InviteCompromised`]. Never adds anyone.
pub async fn check_candidates(member: &Member, invite: &Invite) -> FlowResult<Candidates> {
    let pending = match member.cloud.pending_list().await {
        Ok(p) => p,
        Err(e) if e.is("not_found") => return Err(FlowError::JoinEnded),
        Err(e) => return Err(e.into()),
    };
    let (valid, invalid) = sort_candidates(invite.secret.as_ref(), &invite.account_id, &invite.slot_id, &pending);
    for id in invalid {
        let _ = member.cloud.cancel_pending(&id).await;
    }
    match valid.len() {
        0 => Ok(Candidates::Waiting),
        1 => Ok(Candidates::One(valid.into_iter().next().expect("one"))),
        _ => {
            let _ = member.cloud.invite_cancel(&invite.slot_id).await;
            Err(FlowError::InviteCompromised)
        }
    }
}

/// The person confirmed `enrollment_id` (its fingerprint and kind match the
/// new device's screen): checks every candidate again, writes the roster
/// that adds it with `grant`, and posts `confirm`. Consumes the invitation.
pub async fn add_invited(member: &mut Member, invite: Invite, enrollment_id: &str, grant: Grant) -> FlowResult<Roster> {
    let chosen = match check_candidates(member, &invite).await? {
        Candidates::One(c) if c.enrollment_id == enrollment_id => c,
        // The person's choice is gone or no longer the only valid one.
        _ => return Err(FlowError::JoinEnded),
    };
    let roles = granted(chosen.pubs.roles, grant)?;
    member.sync().await?;
    let mut devices = member.roster.as_ref().ok_or(FlowError::EmptyAccount)?.body.devices.clone();
    devices.push(Device::enrolled(&chosen.auth_pub, &chosen.pubs, grant.signer, roles));
    let r = member.write(devices).await?;
    let confirm = invite::signer_confirm(
        invite.secret.as_ref(),
        &invite::Confirmation { account_id: &invite.account_id, slot_id: &invite.slot_id, device_id: &chosen.device_id, version: r.version(), roster_hash: &r.hash },
    );
    member.cloud.invite_confirm(&invite.slot_id, &chosen.device_id, &confirm).await?;
    Ok(r)
}

/// The person closed the sheet, or wants a new invitation.
pub async fn cancel_invite(member: &Member, invite: Invite) -> FlowResult<()> {
    match member.cloud.invite_cancel(&invite.slot_id).await {
        Ok(()) => Ok(()),
        Err(e) if e.is("not_found") => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// A claimed invitation on the new device.
pub struct InviteClaim {
    pub enrollment_id: String,
    invitation: invite::Invitation,
}

impl std::fmt::Debug for InviteClaim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InviteClaim({})", self.enrollment_id)
    }
}

/// Claims the invitation in `link` with this device's keys. The person
/// then compares this device's fingerprint and kind with the signer's
/// screen.
pub async fn claim_invite(member: &mut Member, link: &str) -> FlowResult<InviteClaim> {
    let invitation = invite::parse_link(link)?;
    member.cloud.account_id = Some(invitation.account_id.clone());
    let auth_pub = member.cloud.keys.auth.public();
    if !member.cloud.roles.is_valid() {
        return Err(FlowError::Roles);
    }
    let pubs = member.cloud.pubs();
    let me = member.cloud.device_id();
    let proof = invite::candidate_proof(
        invitation.secret.as_ref(),
        &invite::Candidate { account_id: &invitation.account_id, slot_id: &invitation.slot_id, device_id: &me, auth_pub: &auth_pub, pubs: &pubs },
    );
    match member.cloud.invite_claim(&invitation.slot_id, &proof).await {
        Ok(enrollment_id) => Ok(InviteClaim { enrollment_id, invitation }),
        Err(e) if e.is("not_found") || e.is("invite_used") => Err(FlowError::JoinEnded),
        Err(e) => Err(e.into()),
    }
}

/// Waits until a signer added this device, checks `confirm` with the
/// secret, and takes the roster as `K`.
pub async fn await_invited(member: &mut Member, claim: InviteClaim, pace: Pace) -> FlowResult<Roster> {
    let inv = &claim.invitation;
    let cloud = &member.cloud;
    let confirm: Vec<u8> = poll(pace, || async {
        match cloud.invite_status(&inv.slot_id).await {
            Ok(s) if s.status == "added" => match s.confirm.as_deref() {
                Some(c) => Ok(Some(from_b64(c).map_err(FlowError::Protocol)?)),
                None => Ok(None),
            },
            Ok(_) => Ok(None),
            Err(e) if request_gone(&e) => Err(FlowError::JoinEnded),
            Err(e) => Err(e.into()),
        }
    })
    .await?;
    let head = cloud.roster().await?;
    let me = cloud.device_id();
    let ok = invite::confirm_matches(
        inv.secret.as_ref(),
        &invite::Confirmation {
            account_id: &inv.account_id,
            slot_id: &inv.slot_id,
            device_id: &me,
            version: head.version,
            roster_hash: &crate::encoding::b64(&<sha2::Sha256 as sha2::Digest>::digest(from_b64(&head.blob).map_err(FlowError::Protocol)?)),
        },
        &confirm,
    );
    if !ok {
        return Err(FlowError::ConfirmMismatch);
    }
    let mine = Device::of(&cloud.keys, false, cloud.roles);
    let r = roster::verify_first(&head.blob, &inv.account_id, &mine)?;
    if !r.body.device(&mine.id).is_some_and(|d| d.roles().within(mine.roles())) {
        return Err(FlowError::Roles);
    }
    if r.version() != head.version {
        return Err(FlowError::ConfirmMismatch);
    }
    member.roster = Some(r.clone());
    Ok(r)
}
