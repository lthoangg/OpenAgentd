//! A computer that approves shows an invitation (spec 4.3): the QR code the
//! new device scans with its own key, so it needs no sign-in and no 6-digit
//! code. The same rules as the phone (`mobile/src-tauri/src/cloud.rs`,
//! `cloud_invite_*`; `tunnel-threats.md`, "Joining an account"):
//!
//! - one invitation at a time, in this process's memory only; it is
//!   cancelled when the person cancels, after [`INVITE_TTL`], when another
//!   one starts, and when the server stops or signs out;
//! - the link is a bearer secret: it is answered once, to the start call,
//!   and never logged;
//! - a candidate is only shown (kind and fingerprint); adding it needs the
//!   person's Add and the desktop app's approval proof (`routes.rs`);
//! - when two candidates prove the secret, nobody is added and the
//!   invitation is cancelled (`flows::check_candidates`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use openagentd_cloud::flows::{self, FlowError, Grant, Invite};
use serde::Serialize;
use tokio::sync::Mutex;

use super::signer::SignerError;

/// How long an invitation lives at most, whatever the cloud allows.
pub const INVITE_TTL: Duration = Duration::from_secs(600);

static TTL_MS: AtomicU64 = AtomicU64::new(INVITE_TTL.as_millis() as u64);

/// Shortens [`INVITE_TTL`] (tests only).
#[doc(hidden)]
pub fn set_ttl_for_tests(ttl: Duration) {
    TTL_MS.store(ttl.as_millis() as u64, Ordering::Relaxed);
}

struct Open {
    invite: Invite,
    /// Unix ms: the earlier of the cloud's expiry and [`INVITE_TTL`].
    expires_at: u64,
    generation: u64,
}

fn slot() -> &'static Mutex<Option<Open>> {
    static SLOT: OnceLock<Mutex<Option<Open>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// What the sheet shows for an open invitation. `link` is a bearer secret:
/// drawn as the QR code, or shown after the "works like a password" step.
#[derive(Serialize)]
pub struct InviteView {
    pub link: String,
    pub slot_id: String,
    pub expires_at: u64,
}

impl std::fmt::Debug for InviteView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InviteView({}, [redacted], {})", self.slot_id, self.expires_at)
    }
}

impl Drop for InviteView {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.link);
    }
}

/// A device whose proof checks out, as the person sees it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CandidateRow {
    pub enrollment_id: String,
    pub fingerprint: String,
    pub kind: Option<String>,
    pub server: bool,
    pub client: bool,
}

/// One look at the open invitation.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum InvitePoll {
    Waiting,
    Candidate {
        candidate: CandidateRow,
    },
    /// Two devices proved the secret; the invitation was cancelled.
    Compromised,
    /// Expired, cancelled, or no invitation open.
    Ended,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Opens an invitation, cancelling any earlier one.
pub async fn start() -> Result<InviteView, SignerError> {
    cancel().await;
    let mut m = super::signer::synced().await?;
    let invite = flows::start_invite(&mut m).await?;
    let expires_at = invite.expires_at.min(now_ms() + TTL_MS.load(Ordering::Relaxed));
    let view = InviteView { link: invite.link().to_string(), slot_id: invite.slot_id.clone(), expires_at };
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let previous = slot().lock().await.replace(Open { invite, expires_at, generation });
    if let Some(old) = previous {
        // A start raced another one: only the newest stays open.
        if let Ok(m) = super::signer::member() {
            let _ = flows::cancel_invite(&m, old.invite).await;
        }
    }
    tracing::info!("cloud_invite_opened");
    let wait = Duration::from_millis(expires_at.saturating_sub(now_ms()));
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        expire(generation).await;
    });
    Ok(view)
}

/// The timer's end: cancels the invitation it was started for, if open.
async fn expire(generation: u64) {
    let open = {
        let mut guard = slot().lock().await;
        if guard.as_ref().is_some_and(|o| o.generation == generation) {
            guard.take()
        } else {
            None
        }
    };
    if let Some(open) = open {
        tracing::info!("cloud_invite_expired");
        cancel_open(open).await;
    }
}

async fn cancel_open(open: Open) {
    if let Ok(m) = super::signer::member() {
        let _ = flows::cancel_invite(&m, open.invite).await;
    }
}

/// Checks the candidates of the invitation `slot_id`. Never adds anyone.
pub async fn poll(slot_id: &str) -> Result<InvitePoll, SignerError> {
    let mut guard = slot().lock().await;
    let Some(open) = guard.as_ref().filter(|o| o.invite.slot_id == slot_id) else { return Ok(InvitePoll::Ended) };
    if now_ms() >= open.expires_at {
        let open = guard.take().expect("checked");
        drop(guard);
        cancel_open(open).await;
        return Ok(InvitePoll::Ended);
    }
    let m = super::signer::member()?;
    match flows::check_candidates(&m, &open.invite).await {
        Ok(flows::Candidates::Waiting) => Ok(InvitePoll::Waiting),
        Ok(flows::Candidates::One(c)) => Ok(InvitePoll::Candidate {
            candidate: CandidateRow { enrollment_id: c.enrollment_id, fingerprint: c.fingerprint, kind: c.kind, server: c.roles.server, client: c.roles.client },
        }),
        Err(FlowError::InviteCompromised) => {
            // `check_candidates` cancelled it in the cloud.
            guard.take();
            tracing::warn!("cloud_invite_compromised");
            Ok(InvitePoll::Compromised)
        }
        Err(FlowError::JoinEnded) => {
            guard.take();
            Ok(InvitePoll::Ended)
        }
        Err(e) => Err(e.into()),
    }
}

/// The person checked the candidate and clicked Add (the route checked the
/// app's proof): adds it, re-checking every candidate first, and spends the
/// invitation.
pub async fn add(enrollment_id: &str, grant: Grant) -> Result<(), SignerError> {
    let open = slot().lock().await.take().ok_or(SignerError::Flow(FlowError::JoinEnded))?;
    if now_ms() >= open.expires_at {
        cancel_open(open).await;
        return Err(FlowError::JoinEnded.into());
    }
    let mut m = super::signer::member()?;
    match flows::add_invited(&mut m, open.invite, enrollment_id, grant).await {
        Ok(r) => {
            tracing::info!("cloud_device_invited version={}", r.version());
            super::signer::wrote(&r);
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

/// The sheet closed: the QR code and link stop working.
pub async fn cancel() {
    let open = slot().lock().await.take();
    if let Some(open) = open {
        cancel_open(open).await;
    }
}

/// Whether an invitation is open (tests).
#[doc(hidden)]
pub async fn is_open() -> bool {
    slot().lock().await.is_some()
}
