//! What a host does as a signer (spec 4.2, 4.5): lists the account's
//! devices and pending requests, approves a new device after the person
//! compares the 6-digit code, and removes devices.
//!
//! Only this computer's own user reaches these (`routes.rs`, local callers
//! only, never a relayed device or the LAN). The signing key is in the
//! user-only identity file (`tunnel-threats.md`, "Computer signers: the
//! trade-off"): the page asks the person to click, and the desktop app adds
//! Touch ID where the Mac has it, before it calls the confirm route.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, Approval, FlowError, Grant, Member, Pace};
use openagentd_cloud::keys::{self, Roles};
use openagentd_cloud::roster;
use openagentd_cloud::store as idstore;
use serde::Serialize;

/// Why a signer route did nothing.
#[derive(Debug)]
pub enum SignerError {
    NotSignedIn,
    /// Confirm or reject without a begun approval (or after it ended).
    NoApproval,
    Flow(FlowError),
}

impl From<FlowError> for SignerError {
    fn from(e: FlowError) -> Self {
        SignerError::Flow(e)
    }
}

impl From<openagentd_cloud::api::ApiError> for SignerError {
    fn from(e: openagentd_cloud::api::ApiError) -> Self {
        SignerError::Flow(e.into())
    }
}

/// One device of the account, from the verified roster.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeviceRow {
    pub device_id: String,
    pub fingerprint: String,
    pub signer: bool,
    pub server: bool,
    pub client: bool,
    pub me: bool,
    /// Self-reported by the device ("macos", "ios", …); a label only.
    pub kind: Option<String>,
    /// For a server: whether its presence socket is open now (the cloud's
    /// relay usage view; a server it does not list is offline). `None` for
    /// other devices, or when the cloud could not say.
    pub online: Option<bool>,
}

/// A device asking to join, with the roles it asked for.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PendingRow {
    pub enrollment_id: String,
    pub fingerprint: String,
    pub country: Option<String>,
    pub created_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub kind: Option<String>,
    pub server: bool,
    pub client: bool,
}

/// What the approval sheet shows once both codes are known.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApprovalView {
    pub code: String,
    pub fingerprint: String,
    pub kind: Option<String>,
    /// The roles it asked for: the approver may turn one off, never on.
    pub server: bool,
    pub client: bool,
}

/// Begun approvals, by enrollment id. A few at most: each is one sheet.
fn approvals() -> &'static Mutex<HashMap<String, Approval>> {
    static APPROVALS: OnceLock<Mutex<HashMap<String, Approval>>> = OnceLock::new();
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

const MAX_OPEN_APPROVALS: usize = 4;

/// This host's account as a member with its full keys and verified roster.
pub(super) fn member() -> Result<Member, SignerError> {
    let id = idstore::load(&super::identity_store()).ok().flatten().filter(|i| i.account_id.is_some()).ok_or(SignerError::NotSignedIn)?;
    let keys = id.keys().map_err(|_| SignerError::NotSignedIn)?;
    let known = id.roster.as_deref().and_then(|b| roster::parse(b).ok()).ok_or(SignerError::NotSignedIn)?;
    Ok(Member::new(Cloud::new(super::http(), Endpoints::current(), keys, id.account_id.clone()), Some(known)))
}

/// Brings `K` up to date and stores it; the connection loop hears of it.
pub(super) async fn synced() -> Result<Member, SignerError> {
    let mut m = member()?;
    let sync = m.sync().await;
    if let Some(r) = m.roster.as_ref() {
        super::persist_roster(r);
    }
    match sync {
        Ok(s) => {
            // Links out see a computer added a moment ago.
            super::controller::publish(Some(&m));
            if s.changed {
                super::poke_roster();
            }
            Ok(m)
        }
        Err(e) => {
            super::poke_roster();
            Err(e.into())
        }
    }
}

/// After a roster write here: store it and tell the connection loop.
pub(super) fn wrote(r: &roster::Roster) {
    super::persist_roster(r);
    super::poke_roster();
}

pub fn device_rows(r: &roster::Roster, me: &str, kinds: &HashMap<String, Option<String>>, online: Option<&HashMap<String, bool>>) -> Vec<DeviceRow> {
    r.body
        .devices
        .iter()
        .map(|d| DeviceRow {
            device_id: d.id.clone(),
            fingerprint: keys::fingerprint(&d.id).unwrap_or_default(),
            signer: d.signer,
            server: d.server,
            client: d.client,
            me: d.id == me,
            kind: kinds.get(&d.id).cloned().flatten(),
            online: if d.server { online.map(|o| o.get(&d.id).copied().unwrap_or(false)) } else { None },
        })
        .collect()
}

/// The account's devices, from the verified roster (kinds and whether each
/// server is online from the cloud; a failed call there never fails the
/// list, the dots are only a hint). The cloud allows 60 usage reads per
/// device per 10 minutes: the desktop reads every 30 s while the list shows.
pub async fn devices() -> Result<Vec<DeviceRow>, SignerError> {
    let m = synced().await?;
    let (devices, usage) = tokio::join!(m.cloud.devices(), m.cloud.relay_usage());
    let kinds: HashMap<String, Option<String>> = devices.map(|ds| ds.into_iter().map(|d| (d.device_id, d.kind)).collect()).unwrap_or_default();
    super::controller::set_kinds(&kinds);
    let online = usage.ok().and_then(|u| u.online());
    Ok(m.roster.as_ref().map(|r| device_rows(r, &m.cloud.device_id(), &kinds, online.as_ref())).unwrap_or_default())
}

/// Requests to join that a signer can approve: sign-ins that committed
/// (invitation claims are for the signer that showed the invitation).
pub fn pending_rows(list: Vec<openagentd_cloud::api::Pending>) -> Vec<PendingRow> {
    list.into_iter()
        .filter(|p| p.commit.is_some() && p.auth_pub.is_some() && p.invite_slot.is_none())
        .filter_map(|p| {
            let roles = p.requested()?.roles;
            Some(PendingRow {
                fingerprint: keys::fingerprint(&p.device_id)?,
                enrollment_id: p.enrollment_id,
                country: p.country,
                created_at: p.created_at,
                expires_at: p.expires_at,
                kind: p.kind,
                server: roles.server,
                client: roles.client,
            })
        })
        .collect()
}

/// Pending requests, or none when this host is not a signer.
pub async fn pending() -> Result<Vec<PendingRow>, SignerError> {
    let m = member()?;
    if !m.is_signer() {
        return Ok(vec![]);
    }
    Ok(pending_rows(m.cloud.pending_list().await?))
}

/// Starts approving `enrollment_id` and waits (up to 3 minutes) for the
/// other device to reveal, so both screens show the code.
pub async fn approve_begin(enrollment_id: &str) -> Result<ApprovalView, SignerError> {
    let mut m = synced().await?;
    if !m.is_signer() {
        return Err(FlowError::NotSigner.into());
    }
    let pending = m.cloud.pending(enrollment_id).await?;
    let mut approval = flows::begin_approval(&mut m, pending).await?;
    let pace = Pace { every: Duration::from_secs(1), timeout: Duration::from_secs(180) };
    let code = flows::await_reveal(&mut m, &mut approval, pace).await?;
    let mut open = approvals().lock().expect("approvals");
    if open.len() >= MAX_OPEN_APPROVALS && !open.contains_key(enrollment_id) {
        // Drop the oldest-looking entry: a sheet that was left open.
        if let Some(k) = open.keys().next().cloned() {
            open.remove(&k);
        }
    }
    open.insert(enrollment_id.to_string(), approval);
    Ok(ApprovalView { code: code.code, fingerprint: code.fingerprint, kind: code.kind, server: code.roles.server, client: code.roles.client })
}

/// The person compared the codes and approved: write the roster that adds
/// the device with `grant` (its requested roles or fewer).
pub async fn approve_confirm(enrollment_id: &str, grant: Grant) -> Result<(), SignerError> {
    let approval = {
        let mut open = approvals().lock().expect("approvals");
        let asked = open.get(enrollment_id).ok_or(SignerError::NoApproval)?.requested();
        // A role it did not ask for: refused, and the approval stays open
        // so the person can confirm with the right roles.
        if !grant.roles.is_valid() || !grant.roles.within(asked) {
            return Err(FlowError::Roles.into());
        }
        open.remove(enrollment_id).expect("checked")
    };
    let mut m = member()?;
    let r = flows::confirm_approval(&mut m, approval, grant).await?;
    tracing::info!("cloud_device_approved version={}", r.version());
    wrote(&r);
    Ok(())
}

/// The codes differ, or the person said no: cancel the request.
pub async fn approve_reject(enrollment_id: &str) -> Result<(), SignerError> {
    let approval = approvals().lock().expect("approvals").remove(enrollment_id);
    let m = member()?;
    let result = match approval {
        Some(a) => flows::reject_approval(&m, a).await,
        None => m.cloud.cancel_pending(enrollment_id).await.map_err(FlowError::from),
    };
    match result {
        Ok(()) => Ok(()),
        Err(FlowError::Api(a)) if a.is("not_found") => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Removes another device from the account.
pub async fn remove(device_id: &str) -> Result<(), SignerError> {
    let mut m = synced().await?;
    if device_id == m.cloud.device_id() {
        return Err(FlowError::NotSigner.into());
    }
    let r = m.remove(device_id).await?;
    tracing::info!("cloud_device_removed version={}", r.version());
    wrote(&r);
    Ok(())
}

/// The grant a confirm asks for, checked by `flows::confirm_approval`.
pub fn grant(signer: bool, server: bool, client: bool) -> Grant {
    Grant { signer, roles: Roles { server, client } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openagentd_cloud::api::Pending;
    use openagentd_cloud::encoding::b64;
    use openagentd_cloud::keys::DeviceKeys;

    fn pending(k: &DeviceKeys, roles: Roles, slot: Option<&str>) -> Pending {
        Pending {
            enrollment_id: "e".repeat(22),
            device_id: k.id(),
            auth_pub: Some(b64(&k.auth.public())),
            pubs: b64(&k.pubs(roles)),
            commit: Some(b64(&[1; 32])),
            n_a: None,
            n_a_by: None,
            n_n: None,
            country: Some("VN".into()),
            created_at: Some(1),
            expires_at: Some(2),
            invite_slot: slot.map(String::from),
            proof: None,
            kind: Some("linux".into()),
        }
    }

    #[test]
    fn pending_rows_show_the_requested_roles_and_skip_invitations() {
        let a = DeviceKeys::generate();
        let rows = pending_rows(vec![pending(&a, Roles::SERVER, None), pending(&DeviceKeys::generate(), Roles::BOTH, Some("slot"))]);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].server, rows[0].client), (true, false));
        assert_eq!(rows[0].fingerprint, a.fingerprint());
        // A request whose pubs do not parse is not shown at all.
        let mut bad = pending(&a, Roles::BOTH, None);
        bad.pubs = b64(br#"{"v":1}"#);
        assert!(pending_rows(vec![bad]).is_empty());
    }
}
