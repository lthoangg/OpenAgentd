//! The phone's optional OpenAgentd Cloud account: sign-in, the account's
//! first roster (genesis) with its recovery code, approving computers with
//! the 6-digit code behind Face ID, the device list, and the relay bridge
//! to a computer.
//!
//! The phone is a client (spec 3.4: it opens sessions, never serves them)
//! and usually a signer. It may be the account's first device, or join an
//! account a computer started. Guests never reach this module's network code. The protocol is
//! `native/cloud`; the threat model is `appv3/contract/tunnel-threats.md`.
//!
//! Keys: on iOS the Keychain (`ios-widget/App/KeychainBridge.swift`), with
//! the signing seed behind Face ID or the passcode. Elsewhere (desktop
//! builds of this shell, used for development, and Android until its
//! Keystore support lands) a file only the user can read.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::{Cloud, Refusal};
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{
    self, Approval, FlowError, GenesisDraft, JoinStep, Member, Pace, Session, Withdraw,
};
use openagentd_cloud::keys::{self, DeviceKeys, Ed25519, Roles, Seed};
use openagentd_cloud::address_book::AddressBook;
use openagentd_cloud::link::{DownReason, Link, LinkDeps, LinkError, LinkState, Poke, Route, Target};
use openagentd_cloud::recovery;
use openagentd_cloud::relay::{self, TunnelEnd};
use openagentd_cloud::roster;
use openagentd_cloud::store::Identity;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::cloud_bridge::{Bridge, Io, Opener};

// ---- Key storage ---------------------------------------------------------

trait PhoneKeys: Send + Sync {
    /// The stored identity. On iOS its signing seed is kept apart (empty).
    fn load(&self) -> Result<Option<Identity>, String>;
    /// Stores a full identity (signing seed included).
    fn save(&self, id: &Identity) -> Result<(), String>;
    /// Stores a changed roster or account state; keys are unchanged.
    fn update(&self, id: &Identity) -> Result<(), String>;
    /// The signing seed. On iOS this asks for Face ID or the passcode.
    fn unlock_sign(&self, reason: &str) -> Result<Zeroizing<String>, String>;
    fn clear(&self) -> Result<(), String>;
}

#[cfg(target_os = "ios")]
mod ios_keys {
    use super::*;
    use std::ffi::{c_char, CStr, CString};

    extern "C" {
        fn openagentd_keychain_set(item: i32, value: *const c_char) -> i32;
        fn openagentd_keychain_get(item: i32, reason: *const c_char, out: *mut *mut c_char) -> i32;
        fn openagentd_keychain_free(p: *mut c_char);
        fn openagentd_keychain_delete(item: i32) -> i32;
    }

    const IDENTITY: i32 = 0;
    const BOX: i32 = 1;
    const SIGN: i32 = 2;

    fn set(item: i32, value: &str) -> Result<(), String> {
        let c = Zeroizing::new(
            CString::new(value)
                .map_err(|_| "bad key text".to_string())?
                .into_bytes_with_nul(),
        );
        match unsafe { openagentd_keychain_set(item, c.as_ptr() as *const c_char) } {
            0 => Ok(()),
            s => Err(format!("The Keychain refused the account keys ({s}).")),
        }
    }

    fn get(item: i32, reason: &str) -> Result<Option<Zeroizing<String>>, String> {
        let reason = CString::new(reason).unwrap_or_default();
        let mut out: *mut c_char = std::ptr::null_mut();
        let status = unsafe { openagentd_keychain_get(item, reason.as_ptr(), &mut out) };
        match status {
            0 if !out.is_null() => {
                let text = Zeroizing::new(
                    unsafe { CStr::from_ptr(out) }
                        .to_string_lossy()
                        .into_owned(),
                );
                unsafe { openagentd_keychain_free(out) };
                Ok(Some(text))
            }
            -25300 => Ok(None),
            -128 => Err("Cancelled.".to_string()),
            s => Err(format!(
                "The Keychain could not read the account keys ({s})."
            )),
        }
    }

    pub struct Keychain;

    impl PhoneKeys for Keychain {
        fn load(&self) -> Result<Option<Identity>, String> {
            match get(IDENTITY, "")? {
                Some(text) => Identity::from_secret(&text)
                    .map(Some)
                    .map_err(|e| e.to_string()),
                None => Ok(None),
            }
        }
        fn save(&self, id: &Identity) -> Result<(), String> {
            let mut id = id.clone();
            let sign = id.split_sign();
            set(SIGN, &sign)?;
            set(BOX, &id.r#box)?;
            set(IDENTITY, &id.to_secret())
        }
        fn update(&self, id: &Identity) -> Result<(), String> {
            let mut id = id.clone();
            let _ = id.split_sign();
            set(IDENTITY, &id.to_secret())
        }
        fn unlock_sign(&self, reason: &str) -> Result<Zeroizing<String>, String> {
            get(SIGN, reason)?.ok_or_else(|| "This phone has no approval key.".to_string())
        }
        fn clear(&self) -> Result<(), String> {
            for item in [SIGN, BOX, IDENTITY] {
                unsafe { openagentd_keychain_delete(item) };
            }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "ios"))]
struct FileKeys(openagentd_cloud::store::FileStore);

#[cfg(not(target_os = "ios"))]
impl PhoneKeys for FileKeys {
    fn load(&self) -> Result<Option<Identity>, String> {
        openagentd_cloud::store::load(&self.0).map_err(|e| e.to_string())
    }
    fn save(&self, id: &Identity) -> Result<(), String> {
        openagentd_cloud::store::save(&self.0, id).map_err(|e| e.to_string())
    }
    /// Keys never change here: the stored signing seed is kept whatever
    /// `id` holds (in memory the member may hold a stand-in, see
    /// `Identity::keys_without_sign`).
    fn update(&self, id: &Identity) -> Result<(), String> {
        let mut next = id.clone();
        let stored = self.load()?.ok_or("Not signed in.")?;
        next.sign = stored.sign.clone();
        self.save(&next)
    }
    fn unlock_sign(&self, _reason: &str) -> Result<Zeroizing<String>, String> {
        let id = self.load()?.ok_or("Not signed in.")?;
        Ok(Zeroizing::new(id.sign.clone()))
    }
    fn clear(&self) -> Result<(), String> {
        use openagentd_cloud::store::SecretStore;
        self.0.clear().map_err(|e| e.to_string())
    }
}

// ---- State ---------------------------------------------------------------

/// Why the phone is a guest again, or an attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Notice {
    Denied,
    Expired,
    Revoked,
    Deleted,
    JoinEnded,
    CommitMismatch,
    /// The cloud's answer did not match the invitation's `confirm`.
    ConfirmMismatch,
    /// The scanned or pasted text is not an invitation link.
    InviteInvalid,
    SignedOut,
    /// Too many requests from this network; `retry_after` says how long to wait.
    RateLimited,
    /// The account has 3 devices waiting to join already.
    TooManyPending,
    /// The account has the most devices it may have (10).
    DeviceLimit,
    /// This device is already in the account or waiting to join.
    DeviceExists,
    /// The account waits to be deleted.
    AccountClosing,
    /// The cloud cannot serve the account for now.
    AccountUnavailable,
    /// No answer from the cloud.
    Unreachable,
    Failed,
}

/// What the phone's Settings → Account shows (the plan's state machine).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    /// `supported`: false where this build cannot keep account keys.
    Guest {
        notice: Option<Notice>,
        supported: bool,
        /// Seconds to wait before trying again (`rate_limited`).
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after: Option<u64>,
    },
    SigningIn {
        user_code: String,
        url: String,
        fingerprint: String,
        expires_in: u64,
    },
    /// A new account: show the recovery code once, then ask for two groups.
    Recovery {
        code: String,
        check: [usize; 2],
    },
    /// Joining an account another phone approves.
    Joining {
        fingerprint: String,
        code: Option<String>,
    },
    /// Claimed an invitation; the other phone adds this one once the
    /// person compares the fingerprint and kind.
    Invited {
        fingerprint: String,
        kind: Option<String>,
    },
    Connected {
        fingerprint: String,
        signer: bool,
    },
    Closing {
        fingerprint: String,
        deletes_at: Option<u64>,
    },
    Unavailable {
        fingerprint: String,
    },
}

struct Genesis {
    member: Member,
    session: Session,
    draft: GenesisDraft,
}

struct Phone {
    keys: Box<dyn PhoneKeys>,
    status: Mutex<Status>,
    /// The account, once signed in. Held across network calls.
    member: tokio::sync::Mutex<Option<Member>>,
    sign_in: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    genesis: Mutex<Option<Genesis>>,
    approvals: tokio::sync::Mutex<HashMap<String, Approval>>,
    /// The one open invitation, while the Add a device sheet shows it.
    invite: tokio::sync::Mutex<Option<flows::Invite>>,
    /// Relay links and their bridges, by computer device id.
    links: tokio::sync::Mutex<HashMap<String, AccountLink>>,
    /// Where each computer may be reached directly (spec 5.5), by device
    /// id and network; kept in `cloud/direct.json`. Never filled from a
    /// saved server.
    addresses: Mutex<AddressBook>,
    /// Each computer's bridge port, kept in `cloud/bridges.json`, so its
    /// origin stays the same across launches.
    bridge_ports: Mutex<HashMap<String, u16>>,
    /// Where those two files live.
    data_dir: std::path::PathBuf,
    /// What a link needs to connect, copied from the member whenever its
    /// roster changes, so no link waits on `member` (held across network
    /// calls, up to minutes while an approval waits).
    relay: Mutex<Option<RelayContext>>,
    /// The one HTTP/1.1 client for relay sockets: its TLS sessions resume.
    http1: reqwest::Client,
    /// Held per computer while its bridge opens, so two opens at once
    /// share one (and a slow computer doesn't hold up the others).
    opening: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Bridge origin → its key (for `secure_get_access_key`) and the
    /// computer it reaches (for the backend status).
    bridge_keys: Mutex<HashMap<String, BridgeEntry>>,
    /// The kind the cloud last reported for each device, for labels.
    kinds: Mutex<HashMap<String, Option<String>>>,
}

struct BridgeEntry {
    key: String,
    device_id: String,
}

/// The account computer an account bridge reaches, as the shell knows it:
/// enough for the web UI to name it like its row under "Your computers".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountDevice {
    pub device_id: String,
    pub fingerprint: String,
    /// "macos", … when the cloud said (a label, never a check).
    pub kind: Option<String>,
}

/// A phone only opens sessions: it has no host to serve (spec 3.4).
const PHONE_ROLES: Roles = Roles::CLIENT;

/// A fresh identity's cloud, asking for the phone's roles.
fn new_cloud() -> (Cloud, String) {
    let keys = DeviceKeys::generate();
    let fingerprint = keys.fingerprint();
    let mut cloud = Cloud::new(http(), Endpoints::current(), keys, None);
    cloud.roles = PHONE_ROLES;
    (cloud, fingerprint)
}

/// A computer's relay link and the loopback bridge in front of it.
struct AccountLink {
    link: Link,
    bridge: Bridge,
}

/// The member's relay client and the box keys of the account's servers,
/// from its verified roster.
struct RelayContext {
    cloud: Arc<Cloud>,
    client: bool,
    servers: HashMap<String, [u8; 32]>,
}

static PHONE: OnceLock<Phone> = OnceLock::new();

fn supported() -> bool {
    // Android keeps keys in its Keystore, which is a later step.
    !cfg!(target_os = "android")
}

/// Called once at startup with the app's data directory.
pub fn init(data_dir: std::path::PathBuf) {
    #[cfg(target_os = "ios")]
    let keys: Box<dyn PhoneKeys> = Box::new(ios_keys::Keychain);
    #[cfg(not(target_os = "ios"))]
    let keys: Box<dyn PhoneKeys> = Box::new(FileKeys(openagentd_cloud::store::FileStore::new(
        data_dir.join("cloud").join("identity.json"),
    )));
    let phone = Phone {
        keys,
        status: Mutex::new(guest(None)),
        member: tokio::sync::Mutex::new(None),
        sign_in: Mutex::new(None),
        genesis: Mutex::new(None),
        approvals: tokio::sync::Mutex::new(HashMap::new()),
        invite: tokio::sync::Mutex::new(None),
        links: tokio::sync::Mutex::new(HashMap::new()),
        addresses: Mutex::new(read_json(&data_dir.join("cloud").join("direct.json"))),
        bridge_ports: Mutex::new(read_json(&data_dir.join("cloud").join("bridges.json"))),
        data_dir: data_dir.clone(),
        relay: Mutex::new(None),
        http1: relay::http1_client(),
        opening: Mutex::new(HashMap::new()),
        bridge_keys: Mutex::new(HashMap::new()),
        kinds: Mutex::new(HashMap::new()),
    };
    if PHONE.set(phone).is_err() {
        return;
    }
    tauri::async_runtime::spawn(restore());
}

fn phone() -> Result<&'static Phone, String> {
    PHONE
        .get()
        .ok_or_else(|| "Accounts are not available in this build.".to_string())
}

fn set_status(s: Status) {
    if let Some(p) = PHONE.get() {
        *p.status.lock().expect("cloud status") = s;
    }
}

fn status() -> Status {
    PHONE
        .get()
        .map(|p| p.status.lock().expect("cloud status").clone())
        .unwrap_or(Status::Guest {
            notice: None,
            supported: false,
            retry_after: None,
        })
}

fn guest(notice: Option<Notice>) -> Status {
    Status::Guest {
        notice,
        supported: supported(),
        retry_after: None,
    }
}

/// Back to guest after a sign-in or join that ended with `e`.
fn guest_after(e: &FlowError) -> Status {
    Status::Guest {
        notice: Some(notice_of(e)),
        supported: supported(),
        retry_after: retry_after(e),
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// The bridge key for a bridge origin (the web UI's access key for it).
pub fn bridge_key(origin: &str) -> Option<String> {
    PHONE
        .get()?
        .bridge_keys
        .lock()
        .ok()?
        .get(origin.trim_end_matches('/'))
        .map(|b| b.key.clone())
}

/// The account computer behind `origin`, when it is an open bridge.
pub fn account_device(origin: &str) -> Option<AccountDevice> {
    let p = PHONE.get()?;
    let bridges = p.bridge_keys.lock().ok()?;
    let kinds = p.kinds.lock().ok()?;
    account_device_in(&bridges, &kinds, origin)
}

fn account_device_in(
    bridges: &HashMap<String, BridgeEntry>,
    kinds: &HashMap<String, Option<String>>,
    origin: &str,
) -> Option<AccountDevice> {
    let entry = bridges.get(origin.trim_end_matches('/'))?;
    Some(AccountDevice {
        device_id: entry.device_id.clone(),
        fingerprint: keys::fingerprint(&entry.device_id).unwrap_or_default(),
        kind: kinds.get(&entry.device_id).cloned().flatten(),
    })
}

fn connected_status(member: &Member) -> Status {
    Status::Connected {
        fingerprint: member.cloud.keys.fingerprint(),
        signer: member.is_signer(),
    }
}

fn identity_of(member: &Member) -> Identity {
    let mut id = Identity::new(&member.cloud.keys);
    id.account_id = member.cloud.account_id.clone();
    id.roster = member.roster.as_ref().map(|r| r.blob.clone());
    id
}

/// What the Notification Service Extension needs to open letters: the
/// account, this phone's id, and the public box keys of the other devices
/// in the verified roster. Not secret.
fn push_context(member: &Member) -> Option<serde_json::Value> {
    let me = member.cloud.device_id();
    let r = member.roster.as_ref()?;
    let senders: serde_json::Map<String, serde_json::Value> = r
        .body
        .devices
        .iter()
        .filter(|d| d.id != me)
        .map(|d| (d.id.clone(), serde_json::Value::String(d.r#box.clone())))
        .collect();
    Some(serde_json::json!({ "account_id": member.account_id()?, "me": me, "senders": senders }))
}

/// Copies what links need from `member` (`None`: signed out). The relay
/// client is a separate one for the same device, so its token is shared
/// by every link and dropped with the account.
fn publish_relay(member: Option<&Member>) {
    let Some(p) = PHONE.get() else { return };
    let mut slot = p.relay.lock().expect("relay context");
    let old = slot.take();
    *slot = member.map(|m| {
        let servers = m
            .roster
            .as_ref()
            .map(|r| {
                r.body
                    .servers()
                    .map(|d| (d.id.clone(), d.box_key()))
                    .collect()
            })
            .unwrap_or_default();
        // Keep the client (and its token) while the account is the same.
        let cloud = match old {
            Some(old)
                if old.cloud.device_id() == m.cloud.device_id()
                    && old.cloud.account_id == m.cloud.account_id =>
            {
                old.cloud
            }
            _ => Arc::new(Cloud::new(
                http(),
                m.cloud.endpoints.clone(),
                m.cloud.keys.clone(),
                m.cloud.account_id.clone(),
            )),
        };
        RelayContext {
            cloud,
            client: m.is_client(),
            servers,
        }
    });
}

/// Shares the push context with the extension (`None`: remove it), and
/// the relay context with the links.
fn publish_push_context(member: Option<&Member>) {
    publish_relay(member);
    #[cfg(target_os = "ios")]
    {
        extern "C" {
            fn openagentd_cloud_push_context(json: *const std::ffi::c_char) -> bool;
        }
        let text = member
            .and_then(push_context)
            .and_then(|v| std::ffi::CString::new(v.to_string()).ok());
        unsafe {
            openagentd_cloud_push_context(text.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()))
        };
    }
    #[cfg(not(target_os = "ios"))]
    let _ = member.map(push_context);
}

/// Loads a stored account at launch and brings its roster up to date.
async fn restore() {
    let Ok(p) = phone() else { return };
    let loaded = tauri::async_runtime::spawn_blocking(|| phone().and_then(|p| p.keys.load()))
        .await
        .unwrap_or(Err("load failed".into()));
    let id = match loaded {
        Ok(Some(id)) if id.account_id.is_some() && id.roster.is_some() => id,
        Ok(_) => return,
        Err(e) => {
            eprintln!("cloud: stored account unreadable: {e}");
            set_status(guest(Some(Notice::Failed)));
            return;
        }
    };
    let Ok(keys) = id.keys_without_sign() else {
        return;
    };
    let Some(Ok(known)) = id.roster.as_deref().map(roster::parse) else {
        return;
    };
    let member = Member::new(
        Cloud::new(http(), Endpoints::current(), keys, id.account_id.clone()),
        Some(known),
    );
    set_status(connected_status(&member));
    publish_push_context(Some(&member));
    *p.member.lock().await = Some(member);
    let _ = refresh().await;
}

/// Applies an account problem. `Err` carries the message to show.
pub(crate) async fn on_problem(problem: AccountProblem) -> String {
    let Ok(p) = phone() else { return String::new() };
    let fingerprint = match status() {
        Status::Connected { fingerprint, .. }
        | Status::Closing { fingerprint, .. }
        | Status::Unavailable { fingerprint } => fingerprint,
        _ => String::new(),
    };
    match problem {
        AccountProblem::Closing { deletes_at } => {
            close_links().await;
            set_status(Status::Closing {
                fingerprint,
                deletes_at,
            });
            "Account scheduled for deletion. Remote access is paused; servers on your network still work.".into()
        }
        AccountProblem::Unavailable => {
            close_links().await;
            set_status(Status::Unavailable { fingerprint });
            "Account unavailable. Remote access is paused; servers on your network still work."
                .into()
        }
        AccountProblem::RemovalSignal => {
            // Unsigned (a 4001 close, a refused relay token): close the
            // relay sessions, then ask with one signed roster fetch. Only a
            // signed answer erases the keys.
            close_links().await;
            let removal = {
                let mut guard = p.member.lock().await;
                let Some(m) = guard.as_mut() else {
                    return String::new();
                };
                let removal = m.confirm_removal().await;
                if matches!(&removal, flows::Removal::NotRemoved(s) if s.changed) {
                    let _ = p.keys.update(&identity_of(m));
                    publish_push_context(Some(m));
                }
                removal
            };
            match removal {
                flows::Removal::Removed => erase(AccountProblem::Revoked).await,
                flows::Removal::NotRemoved(_) => {
                    "This computer cannot be reached through your account right now.".into()
                }
                // Another account problem (closing, unavailable, deleted).
                flows::Removal::Unsure(FlowError::Problem(q))
                    if q != AccountProblem::RemovalSignal =>
                {
                    Box::pin(on_problem(q)).await
                }
                flows::Removal::Unsure(_) => {
                    "This computer cannot be reached through your account right now.".into()
                }
            }
        }
        AccountProblem::Deleted | AccountProblem::Revoked => erase(problem).await,
    }
}

/// Erases the account on this phone after a signed answer said it ended
/// (`Deleted`, or `Revoked`: `device_revoked` or a verified roster without
/// this phone).
async fn erase(problem: AccountProblem) -> String {
    let Ok(p) = phone() else { return String::new() };
    close_links().await;
    *p.member.lock().await = None;
    let _ = p.keys.clear();
    publish_push_context(None);
    let notice = if problem == AccountProblem::Deleted {
        Notice::Deleted
    } else {
        Notice::Revoked
    };
    set_status(guest(Some(notice)));
    if problem == AccountProblem::Deleted {
        "Account deleted. This phone was signed out; servers on your network still work.".into()
    } else {
        "This phone was removed from your account. It was signed out; servers on your network still work.".into()
    }
}

async fn flow_error(e: FlowError) -> String {
    match e {
        FlowError::Problem(p) => on_problem(p).await,
        FlowError::NotSigner => "This phone cannot approve devices.".into(),
        FlowError::JoinEnded => "The request was cancelled or expired.".into(),
        FlowError::CommitMismatch => {
            "Request cancelled. If you didn't start it, someone may be trying to join your account."
                .into()
        }
        FlowError::InviteCompromised => {
            "Someone else has this invitation, so nobody was added. Show a new one.".into()
        }
        FlowError::ConfirmMismatch => {
            "The account's answer did not match the invitation. Nothing was changed.".into()
        }
        FlowError::Roles => {
            "A device can only get the roles it asked for, and needs at least one.".into()
        }
        FlowError::Roster(rule) => {
            format!("The account's device list failed a check ({rule}). Nothing was changed.")
        }
        FlowError::Api(a) if refusal_message(&a).is_some() => {
            refusal_message(&a).unwrap_or_default()
        }
        FlowError::Api(a) if a.status == 0 => {
            "No connection to OpenAgentd. Check your network.".into()
        }
        FlowError::Api(a) => format!("OpenAgentd answered {} ({}).", a.status, a.code),
        other => other.to_string(),
    }
}

/// Syncs the roster; keeps the stored copy current.
async fn refresh() -> Result<(), String> {
    let p = phone()?;
    let mut guard = p.member.lock().await;
    let Some(member) = guard.as_mut() else {
        return Ok(());
    };
    match member.sync().await {
        Ok(sync) => {
            if sync.changed {
                let _ = p.keys.update(&identity_of(member));
                publish_push_context(Some(member));
                let removed = sync.removed;
                drop(guard);
                let mut links = p.links.lock().await;
                for d in removed {
                    if let Some(l) = links.remove(&d) {
                        l.link.close();
                        p.bridge_keys
                            .lock()
                            .expect("bridge keys")
                            .remove(&l.bridge.origin);
                    }
                }
                guard = p.member.lock().await;
            }
            if let Some(m) = guard.as_ref() {
                set_status(connected_status(m));
            }
            Ok(())
        }
        Err(e) => {
            drop(guard);
            Err(flow_error(e).await)
        }
    }
}

async fn close_links() {
    if let Ok(p) = phone() {
        let mut links = p.links.lock().await;
        for (_, link) in links.drain() {
            link.link.close();
            p.bridge_keys
                .lock()
                .expect("bridge keys")
                .remove(&link.bridge.origin);
        }
    }
}

// ---- Sign-in, genesis, joining -------------------------------------------

fn notice_of(e: &FlowError) -> Notice {
    match e {
        FlowError::Denied => Notice::Denied,
        FlowError::Expired | FlowError::TimedOut => Notice::Expired,
        FlowError::JoinEnded => Notice::JoinEnded,
        FlowError::CommitMismatch => Notice::CommitMismatch,
        FlowError::ConfirmMismatch => Notice::ConfirmMismatch,
        FlowError::Protocol(openagentd_cloud::Error::Invite) => Notice::InviteInvalid,
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
fn retry_after(e: &FlowError) -> Option<u64> {
    match e {
        FlowError::Api(a) => match a.refusal() {
            Some(Refusal::RateLimited { retry_after }) => retry_after,
            _ => None,
        },
        _ => None,
    }
}

/// What a refusal says on the phone's sheets (approving, adding). No em
/// or en dashes.
fn refusal_message(a: &openagentd_cloud::api::ApiError) -> Option<String> {
    Some(match a.refusal()? {
        Refusal::RateLimited { .. } => {
            "OpenAgentd is getting too many requests from this network. Try again in a few minutes."
                .into()
        }
        Refusal::TooManyPending => "3 devices are already waiting to join; wait a few minutes or reject them on a device that approves.".into(),
        Refusal::DeviceLimit => "Your account has 10 devices; remove one first.".into(),
        Refusal::DeviceExists => {
            "This device is already in your account or waiting to join.".into()
        }
        Refusal::Unreachable => "No connection to OpenAgentd. Check your network.".into(),
    })
}

/// Joins with an invitation another phone shows (scanned or pasted). The
/// link is a bearer secret: it is dropped once claimed.
fn spawn_join(link: Zeroizing<String>) {
    let task = tauri::async_runtime::spawn(async move {
        let (cloud, fingerprint) = new_cloud();
        let mut member = Member::new(cloud, None);
        let end = |e: FlowError| set_status(guest_after(&e));
        let claim = match flows::claim_invite(&mut member, &link).await {
            Ok(c) => c,
            Err(e) => return end(e),
        };
        drop(link);
        // Withdrawn unless this phone ends up in the account (also when
        // the sheet closes and this task is aborted).
        let withdraw = Withdraw::arm(&member.cloud, &claim.enrollment_id);
        set_status(Status::Invited {
            fingerprint,
            kind: openagentd_cloud::api::this_kind().map(String::from),
        });
        if let Err(e) = flows::await_invited(&mut member, claim, Pace::default()).await {
            withdraw.now().await;
            return end(e);
        }
        withdraw.keep();
        if let Err(e) = finish(member).await {
            eprintln!("cloud: could not store the account keys: {e}");
            set_status(guest(Some(Notice::Failed)));
        }
    });
    if let Ok(p) = phone() {
        if let Some(old) = p.sign_in.lock().expect("sign-in").replace(task) {
            old.abort();
        }
    }
}

/// Joins with an invitation link (the default way for a second phone).
#[tauri::command]
pub fn cloud_join_invite(link: String) -> Result<Status, String> {
    let link = Zeroizing::new(link);
    if !supported() {
        return Err("Accounts are not available on this device yet.".into());
    }
    phone()?;
    if link.len() > 512 || openagentd_cloud::invite::parse_link(&link).is_err() {
        return Err("That is not an invitation link. Scan or copy it again.".into());
    }
    match status() {
        Status::Guest { .. } => {
            spawn_join(link);
            Ok(status())
        }
        s => Ok(s),
    }
}

fn spawn_sign_in() {
    let task = tauri::async_runtime::spawn(async move {
        let (cloud, fingerprint) = new_cloud();
        let end = |e: FlowError| set_status(guest_after(&e));
        let code = match cloud.device_code().await {
            Ok(c) => c,
            Err(e) => return end(e.into()),
        };
        set_status(Status::SigningIn {
            user_code: code.user_code.clone(),
            url: code.url.clone(),
            fingerprint: fingerprint.clone(),
            expires_in: code.expires_in,
        });
        let session = match flows::wait_for_session(&cloud, &code).await {
            Ok(s) => s,
            Err(e) => return end(e),
        };
        let mut member = Member::new(cloud, None);
        // A request that does not end in joining is withdrawn (also when
        // the sheet closes and this task is aborted).
        let joined = flows::join_with_code(&mut member, &session, Pace::default(), |step| {
            set_status(Status::Joining {
                fingerprint: fingerprint.clone(),
                code: match step {
                    JoinStep::Requested => None,
                    JoinStep::Code(c) => Some(c.to_string()),
                },
            })
        })
        .await;
        match joined {
            Ok(_) => {}
            Err(FlowError::EmptyAccount) => {
                // This phone sets the account up: show the recovery code first.
                let draft = GenesisDraft::new();
                let (a, b) = draft.check_groups();
                set_status(Status::Recovery {
                    code: draft.code.to_string(),
                    check: [a, b],
                });
                if let Ok(p) = phone() {
                    *p.genesis.lock().expect("genesis") = Some(Genesis {
                        member,
                        session,
                        draft,
                    });
                }
                return;
            }
            Err(e) => return end(e),
        }
        if let Err(e) = finish(member).await {
            eprintln!("cloud: could not store the account keys: {e}");
            set_status(guest(Some(Notice::Failed)));
        }
    });
    if let Ok(p) = phone() {
        if let Some(old) = p.sign_in.lock().expect("sign-in").replace(task) {
            old.abort();
        }
    }
}

/// Stores the keys of a member that just joined or set up the account.
async fn finish(member: Member) -> Result<(), String> {
    let p = phone()?;
    let id = identity_of(&member);
    tauri::async_runtime::spawn_blocking(move || phone().and_then(|p| p.keys.save(&id)))
        .await
        .map_err(|e| e.to_string())??;
    set_status(connected_status(&member));
    publish_push_context(Some(&member));
    *p.member.lock().await = Some(member);
    Ok(())
}

#[tauri::command]
pub fn cloud_status() -> Status {
    status()
}

#[tauri::command]
pub fn cloud_sign_in() -> Result<Status, String> {
    if !supported() {
        return Err("Accounts are not available on this device yet.".into());
    }
    phone()?;
    match status() {
        Status::Guest { .. } => {
            spawn_sign_in();
            Ok(status())
        }
        s => Ok(s),
    }
}

#[tauri::command]
pub fn cloud_cancel() -> Result<Status, String> {
    let p = phone()?;
    if let Some(h) = p.sign_in.lock().expect("sign-in").take() {
        h.abort();
    }
    p.genesis.lock().expect("genesis").take();
    if matches!(
        status(),
        Status::SigningIn { .. }
            | Status::Joining { .. }
            | Status::Invited { .. }
            | Status::Recovery { .. }
    ) {
        set_status(guest(None));
    }
    Ok(status())
}

/// The person typed two groups of the recovery code back: create the
/// account. The recovery key is wiped once its public half is registered.
#[tauri::command]
pub async fn cloud_confirm_recovery(first: String, second: String) -> Result<Status, String> {
    let p = phone()?;
    let Status::Recovery { check: [a, b], .. } = status() else {
        return Err("Nothing to confirm.".into());
    };
    let mut g = p
        .genesis
        .lock()
        .expect("genesis")
        .take()
        .ok_or("Sign in again to set up the account.")?;
    if !recovery::group_matches(&g.draft.code, a, &first)
        || !recovery::group_matches(&g.draft.code, b, &second)
    {
        let msg = format!("Those are not groups {a} and {b}. Check the code you saved.");
        *p.genesis.lock().expect("genesis") = Some(g);
        return Err(msg);
    }
    match flows::genesis(&mut g.member, &g.session, g.draft).await {
        Ok(_) => {
            finish(g.member).await?;
            Ok(status())
        }
        Err(e) => {
            set_status(guest(Some(Notice::Failed)));
            Err(flow_error(e).await)
        }
    }
}

// ---- Devices and approvals -----------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DeviceRow {
    pub device_id: String,
    pub fingerprint: String,
    pub signer: bool,
    /// Its roles in the verified roster: other devices open sessions to a
    /// server; a client opens them.
    pub server: bool,
    pub client: bool,
    pub me: bool,
    /// "macos", "linux", "windows", "ios", "android" when the cloud says.
    pub kind: Option<String>,
    /// For a server: whether its presence socket is open now (the cloud's
    /// relay usage view; a server it does not list is offline). `None` for
    /// other devices, or when the cloud could not say.
    pub online: Option<bool>,
}

/// The device list: the verified roster, labelled with the cloud's kinds and
/// its online flags (`online`: `None` when that call failed or did not say).
fn device_rows(
    devices: &[roster::Device],
    me: &str,
    kinds: &HashMap<String, Option<String>>,
    online: Option<&HashMap<String, bool>>,
) -> Vec<DeviceRow> {
    devices
        .iter()
        .map(|d| DeviceRow {
            device_id: d.id.clone(),
            fingerprint: keys::fingerprint(&d.id).unwrap_or_default(),
            signer: d.signer,
            server: d.server,
            client: d.client,
            me: d.id == me,
            kind: kinds.get(&d.id).cloned().flatten(),
            online: if d.server {
                online.map(|o| o.get(&d.id).copied().unwrap_or(false))
            } else {
                None
            },
        })
        .collect()
}

#[tauri::command]
pub async fn cloud_devices() -> Result<Vec<DeviceRow>, String> {
    refresh().await?;
    let p = phone()?;
    let guard = p.member.lock().await;
    let member = guard.as_ref().ok_or("Not signed in.")?;
    // A failed usage call never fails the list: the dots are only a hint.
    let (devices, usage) = tokio::join!(member.cloud.devices(), member.cloud.relay_usage());
    let kinds: HashMap<String, Option<String>> = devices
        .map(|ds| ds.into_iter().map(|d| (d.device_id, d.kind)).collect())
        .unwrap_or_default();
    let online = usage.ok().and_then(|u| u.online());
    let me = member.cloud.device_id();
    let rows = member
        .roster
        .as_ref()
        .map(|r| device_rows(&r.body.devices, &me, &kinds, online.as_ref()))
        .unwrap_or_default();
    if !kinds.is_empty() {
        *p.kinds.lock().expect("kinds") = kinds;
    }
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingRow {
    pub enrollment_id: String,
    pub fingerprint: String,
    pub country: Option<String>,
    pub created_at: Option<u64>,
    pub expires_at: Option<u64>,
    /// The joining device's self-reported kind; a label, never a check.
    pub kind: Option<String>,
    /// The roles it asked for (inside the code it shows).
    pub server: bool,
    pub client: bool,
}

#[tauri::command]
pub async fn cloud_pending() -> Result<Vec<PendingRow>, String> {
    let p = phone()?;
    let guard = p.member.lock().await;
    let member = guard.as_ref().ok_or("Not signed in.")?;
    if !member.is_signer() {
        return Ok(vec![]);
    }
    let list = match member.cloud.pending_list().await {
        Ok(l) => l,
        Err(e) => {
            drop(guard);
            return Err(flow_error(e.into()).await);
        }
    };
    Ok(list
        .into_iter()
        .filter(|r| r.commit.is_some() && r.auth_pub.is_some() && r.invite_slot.is_none())
        .filter_map(|r| {
            let roles = r.requested()?.roles;
            Some(PendingRow {
                fingerprint: keys::fingerprint(&r.device_id).unwrap_or_default(),
                enrollment_id: r.enrollment_id,
                country: r.country,
                created_at: r.created_at,
                expires_at: r.expires_at,
                kind: r.kind,
                server: roles.server,
                client: roles.client,
            })
        })
        .collect())
}

/// What the approval sheet shows once both codes are known.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalView {
    pub code: String,
    /// The roles the device asked for: the person may turn one off.
    pub server: bool,
    pub client: bool,
}

/// Starts approving a request and waits for the code both screens show.
#[tauri::command]
pub async fn cloud_approve_begin(enrollment_id: String) -> Result<ApprovalView, String> {
    let p = phone()?;
    let mut guard = p.member.lock().await;
    let member = guard.as_mut().ok_or("Not signed in.")?;
    let pending = match member.cloud.pending(&enrollment_id).await {
        Ok(r) => r,
        Err(e) => {
            drop(guard);
            return Err(flow_error(e.into()).await);
        }
    };
    let pace = Pace {
        every: Duration::from_secs(1),
        timeout: Duration::from_secs(180),
    };
    let result = async {
        let mut approval = flows::begin_approval(member, pending).await?;
        let code = flows::await_reveal(member, &mut approval, pace).await?;
        Ok::<_, FlowError>((approval, code))
    }
    .await;
    drop(guard);
    match result {
        Ok((approval, code)) => {
            p.approvals.lock().await.insert(enrollment_id, approval);
            Ok(ApprovalView {
                code: code.code,
                server: code.roles.server,
                client: code.roles.client,
            })
        }
        Err(e) => Err(flow_error(e).await),
    }
}

/// Runs `write` with the signing key, unlocked by Face ID or the passcode.
async fn with_sign_key<T>(
    reason: &'static str,
    write: impl AsyncFnOnce(&mut Member) -> Result<T, FlowError>,
) -> Result<T, String> {
    let p = phone()?;
    let seed = tauri::async_runtime::spawn_blocking(move || {
        phone().and_then(|p| p.keys.unlock_sign(reason))
    })
    .await
    .map_err(|e| e.to_string())??;
    let key = Ed25519::from_seed(
        Seed::from_b64(&seed).map_err(|_| "The approval key is unreadable.".to_string())?,
    );
    drop(seed);
    let mut guard = p.member.lock().await;
    let member = guard.as_mut().ok_or("Not signed in.")?;
    let locked = member.set_sign_key(key);
    let result = write(member).await;
    member.set_sign_key(locked);
    if result.is_ok() {
        let _ = p.keys.update(&identity_of(member));
        publish_push_context(Some(member));
        set_status(connected_status(member));
    }
    drop(guard);
    match result {
        Ok(v) => Ok(v),
        Err(e) => Err(flow_error(e).await),
    }
}

/// The grant for a device that asked for `asked`: the person's choices,
/// defaulting to what it asked for, and to a signer when it opens sessions
/// (a phone or a desktop app has someone at its screen).
fn grant_of(
    asked: Roles,
    approver: Option<bool>,
    server: Option<bool>,
    client: Option<bool>,
) -> Result<flows::Grant, String> {
    let roles = Roles {
        server: server.unwrap_or(asked.server),
        client: client.unwrap_or(asked.client),
    };
    if !roles.is_valid() || !roles.within(asked) {
        return Err("A device can only get the roles it asked for, and needs at least one.".into());
    }
    Ok(flows::Grant {
        signer: approver.unwrap_or(asked.client),
        roles,
    })
}

/// The codes match: add the device (after Face ID). `approver`: it may
/// approve others too. `server` / `client`: its roles, those it asked for
/// or fewer (a role it did not ask for is refused before Face ID).
#[tauri::command]
pub async fn cloud_approve_confirm(
    enrollment_id: String,
    approver: Option<bool>,
    server: Option<bool>,
    client: Option<bool>,
) -> Result<Status, String> {
    let p = phone()?;
    let grant = {
        let open = p.approvals.lock().await;
        let asked = open
            .get(&enrollment_id)
            .ok_or("Start the approval again.")?
            .requested();
        grant_of(asked, approver, server, client)?
    };
    let approval = p
        .approvals
        .lock()
        .await
        .remove(&enrollment_id)
        .ok_or("Start the approval again.")?;
    with_sign_key(
        "Add this device to your account",
        async move |m: &mut Member| {
            flows::confirm_approval(m, approval, grant)
                .await
                .map(|_| ())
        },
    )
    .await?;
    Ok(status())
}

/// The codes differ, or the person said no.
#[tauri::command]
pub async fn cloud_approve_reject(enrollment_id: String) -> Result<(), String> {
    let p = phone()?;
    let approval = p.approvals.lock().await.remove(&enrollment_id);
    let guard = p.member.lock().await;
    let member = guard.as_ref().ok_or("Not signed in.")?;
    let result = match approval {
        Some(a) => flows::reject_approval(member, a).await,
        None => member
            .cloud
            .cancel_pending(&enrollment_id)
            .await
            .map_err(FlowError::from),
    };
    drop(guard);
    result
        .or_else(|e| match e {
            FlowError::Api(a) if a.is("not_found") => Ok(()),
            e => Err(e),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_remove_device(device_id: String) -> Result<Status, String> {
    let id = device_id.clone();
    with_sign_key(
        "Remove this device from your account",
        async move |m: &mut Member| m.remove(&id).await.map(|_| ()),
    )
    .await?;
    let p = phone()?;
    if let Some(link) = p.links.lock().await.remove(&device_id) {
        link.link.close();
        p.bridge_keys
            .lock()
            .expect("bridge keys")
            .remove(&link.bridge.origin);
    }
    Ok(status())
}

// ---- Invitations (spec section 4.3) -----------------------------------------
//
// The phone shows a QR code only while the Add a device sheet is open. It
// shows each candidate whose proof checks out with its fingerprint and
// kind, and adds one only when the person taps Add (after Face ID). Two
// valid proofs mean someone else has the secret: nobody is added and the
// invitation is cancelled.

/// What the sheet shows for an open invitation. `link` is a bearer secret:
/// rendered as the QR code, or shown after the password-style warning.
#[derive(Serialize)]
pub struct InviteView {
    link: String,
    expires_at: u64,
}

impl std::fmt::Debug for InviteView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InviteView([redacted], {})", self.expires_at)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CandidateRow {
    pub enrollment_id: String,
    pub fingerprint: String,
    pub kind: Option<String>,
    /// The roles it asked for (covered by its proof).
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
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Opens an invitation (cancelling any earlier one) and returns its link.
#[tauri::command]
pub async fn cloud_invite_start() -> Result<InviteView, String> {
    let p = phone()?;
    let _ = cloud_invite_cancel().await;
    let mut guard = p.member.lock().await;
    let member = guard.as_mut().ok_or("Not signed in.")?;
    match flows::start_invite(member).await {
        Ok(invite) => {
            let view = InviteView {
                link: invite.link().to_string(),
                expires_at: invite.expires_at,
            };
            *p.invite.lock().await = Some(invite);
            Ok(view)
        }
        Err(e) => {
            drop(guard);
            Err(flow_error(e).await)
        }
    }
}

/// Checks the open invitation's candidates. Never adds anyone.
#[tauri::command]
pub async fn cloud_invite_poll() -> Result<InvitePoll, String> {
    let p = phone()?;
    let guard = p.member.lock().await;
    let member = guard.as_ref().ok_or("Not signed in.")?;
    let mut slot = p.invite.lock().await;
    let Some(invite) = slot.as_ref() else {
        return Ok(InvitePoll::Ended);
    };
    if now_ms() > invite.expires_at {
        let invite = slot.take().expect("checked");
        let _ = flows::cancel_invite(member, invite).await;
        return Ok(InvitePoll::Ended);
    }
    let result = flows::check_candidates(member, invite).await;
    match result {
        Ok(flows::Candidates::Waiting) => Ok(InvitePoll::Waiting),
        Ok(flows::Candidates::One(c)) => Ok(InvitePoll::Candidate {
            candidate: CandidateRow {
                enrollment_id: c.enrollment_id,
                fingerprint: c.fingerprint,
                kind: c.kind,
                server: c.roles.server,
                client: c.roles.client,
            },
        }),
        Err(FlowError::InviteCompromised) => {
            slot.take();
            Ok(InvitePoll::Compromised)
        }
        Err(FlowError::JoinEnded) => {
            slot.take();
            Ok(InvitePoll::Ended)
        }
        Err(e) => {
            drop(slot);
            drop(guard);
            Err(flow_error(e).await)
        }
    }
}

/// The person checked the fingerprint and tapped Add: adds that candidate
/// (after Face ID) and spends the invitation. `approver`, `server`,
/// `client` as for [`cloud_approve_confirm`]; absent, it gets the roles it
/// asked for and approves others when it opens sessions.
#[tauri::command]
pub async fn cloud_invite_add(
    enrollment_id: String,
    approver: Option<bool>,
    server: Option<bool>,
    client: Option<bool>,
) -> Result<Status, String> {
    let p = phone()?;
    let grant = {
        let guard = p.member.lock().await;
        let member = guard.as_ref().ok_or("Not signed in.")?;
        let slot = p.invite.lock().await;
        let invite = slot
            .as_ref()
            .ok_or("The invitation ended. Show a new one.")?;
        match flows::check_candidates(member, invite).await {
            Ok(flows::Candidates::One(c)) if c.enrollment_id == enrollment_id => {
                grant_of(c.roles, approver, server, client)?
            }
            _ => return Err("The invitation ended. Show a new one.".into()),
        }
    };
    let invite = p
        .invite
        .lock()
        .await
        .take()
        .ok_or("The invitation ended. Show a new one.")?;
    with_sign_key(
        "Add this device to your account",
        async move |m: &mut Member| {
            flows::add_invited(m, invite, &enrollment_id, grant)
                .await
                .map(|_| ())
        },
    )
    .await?;
    Ok(status())
}

/// The sheet closed (or the app went to the background): the QR code and
/// link stop working.
#[tauri::command]
pub async fn cloud_invite_cancel() -> Result<(), String> {
    let p = phone()?;
    let Some(invite) = p.invite.lock().await.take() else {
        return Ok(());
    };
    let guard = p.member.lock().await;
    let member = guard.as_ref().ok_or("Not signed in.")?;
    flows::cancel_invite(member, invite)
        .await
        .map_err(|e| e.to_string())
}

/// Leaves the account and erases this phone's keys. Local data stays.
#[tauri::command]
pub async fn cloud_sign_out() -> Result<Status, String> {
    let p = phone()?;
    close_links().await;
    if let Some(member) = p.member.lock().await.take() {
        let _ = member.cloud.leave().await;
    }
    tauri::async_runtime::spawn_blocking(|| phone().and_then(|p| p.keys.clear()))
        .await
        .map_err(|e| e.to_string())??;
    publish_push_context(None);
    set_status(guest(Some(Notice::SignedOut)));
    Ok(status())
}

/// Sends this phone's APNs registration, so computers can notify it.
pub async fn register_push(registration: serde_json::Value) -> Result<(), String> {
    let p = phone()?;
    let guard = p.member.lock().await;
    let member = guard.as_ref().ok_or("Not signed in.")?;
    match member.cloud.register_push(registration).await {
        Ok(()) => Ok(()),
        // A removed phone learns it here too (`device_revoked`).
        Err(e) if e.problem().is_some() => {
            drop(guard);
            Err(flow_error(e.into()).await)
        }
        Err(e) => Err(format!("OpenAgentd answered {} ({}).", e.status, e.code)),
    }
}

pub fn signed_in() -> bool {
    matches!(status(), Status::Connected { .. })
}

// ---- The relay bridge to a computer --------------------------------------
//
// One `Link` per computer (`openagentd_cloud::link`) keeps its relay session
// up by itself: it reconnects with a backoff, checks itself when the app
// comes back or the network changes (`cloud_poke`), and stops trying in the
// background. The bridge in front of it waits at most `LINK_WAIT` per
// request, then answers 503, which the web UI shows as its "Can't reach …
// · Retrying…" banner.

/// Longest a bridged request waits for its computer's link.
pub const LINK_WAIT: Duration = Duration::from_secs(10);
/// Longest opening a computer waits for its link to come up.
pub const OPEN_WAIT: Duration = Duration::from_secs(15);

/// Why a link has nothing to connect with (`DownReason::Refused`).
const SIGNED_OUT: &str = "signed_out";
const NOT_CLIENT: &str = "not_client";
const NOT_IN_ACCOUNT: &str = "not_in_account";
const UNREACHABLE: &str = "This computer cannot be reached through your account right now.";

fn down_message(reason: &DownReason) -> String {
    match reason {
        DownReason::HostOffline => {
            "This computer is offline, or not signed in to your account.".into()
        }
        DownReason::Paused { .. } => {
            "Today's relay allowance is used up. It resets tomorrow.".into()
        }
        DownReason::Refused(r) if r == "handshake" => {
            "This computer did not prove its identity. Nothing was sent.".into()
        }
        DownReason::Refused(r) if r == NOT_CLIENT => {
            "This phone cannot open computers through your account.".into()
        }
        DownReason::Refused(r) if r == NOT_IN_ACCOUNT => {
            "This computer is not in your account.".into()
        }
        DownReason::Refused(r) if r == SIGNED_OUT => "Not signed in.".into(),
        DownReason::Account(AccountProblem::Closing { .. }) => {
            "Account scheduled for deletion. Remote access is paused; servers on your network still work.".into()
        }
        DownReason::Account(AccountProblem::Unavailable) => {
            "Account unavailable. Remote access is paused; servers on your network still work."
                .into()
        }
        _ => UNREACHABLE.into(),
    }
}

fn link_message(e: &LinkError) -> String {
    match e {
        LinkError::Down(reason) => down_message(reason),
        LinkError::TimedOut => {
            "This computer did not answer in time. Check that it is awake and online.".into()
        }
        _ => UNREACHABLE.into(),
    }
}

/// A small JSON file of the app's own (not secret), or the default.
fn read_json<T: serde::de::DeserializeOwned + Default>(path: &std::path::Path) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_json<T: serde::Serialize>(path: &std::path::Path, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(value) {
        let _ = std::fs::write(path, bytes);
    }
}

/// What a computer's link asks of the phone: no lock is held once
/// `target` returns.
struct PhoneDeps;

impl LinkDeps for PhoneDeps {
    fn target(&self, device_id: &str) -> Result<Target, DownReason> {
        let refused = |r: &str| DownReason::Refused(r.to_string());
        let p = PHONE.get().ok_or_else(|| refused(SIGNED_OUT))?;
        let ctx = p.relay.lock().expect("relay context");
        let ctx = ctx.as_ref().ok_or_else(|| refused(SIGNED_OUT))?;
        // Only a server, from a client (spec 3.4).
        if !ctx.client {
            return Err(refused(NOT_CLIENT));
        }
        let host_box = *ctx
            .servers
            .get(device_id)
            .ok_or_else(|| refused(NOT_IN_ACCOUNT))?;
        // Direct addresses only for the network the phone is on now.
        let direct = p
            .addresses
            .lock()
            .expect("addresses")
            .candidates(device_id, &openagentd_cloud::direct::local_subnets());
        Ok(Target {
            cloud: ctx.cloud.clone(),
            http1: p.http1.clone(),
            host_box,
            direct,
        })
    }

    fn learned(&self, device_id: &str, answer: openagentd_cloud::direct::DirectAnswer) {
        let Some(p) = PHONE.get() else { return };
        let mut book = p.addresses.lock().expect("addresses");
        if book.learned(device_id, &answer, &openagentd_cloud::direct::local_subnets()) {
            write_json(&p.data_dir.join("cloud").join("direct.json"), &*book);
        }
    }

    fn on_problem(&self, problem: AccountProblem) {
        tauri::async_runtime::spawn(async move {
            let _ = on_problem(problem).await;
        });
    }

    fn on_end(&self, _device_id: &str, end: &TunnelEnd) {
        // `cause=deadline` is this phone giving up a socket that went quiet.
        eprintln!("cloud: session ended {end}");
    }
}

/// The route an account computer's link is on, for its row: `direct` ("On
/// your network"), `relay` ("Through your account"), `connecting`, or
/// `down`. `none` when the phone has no link to it.
#[tauri::command]
pub async fn cloud_link_route(device_id: String) -> Result<serde_json::Value, String> {
    let Some(p) = PHONE.get() else {
        return Ok(serde_json::json!({ "route": "none" }));
    };
    let links = p.links.lock().await;
    let Some(l) = links.get(&device_id) else {
        return Ok(serde_json::json!({ "route": "none" }));
    };
    let route = match &*l.link.state().borrow() {
        LinkState::Up { route: Route::Direct { .. }, .. } => "direct",
        LinkState::Up { route: Route::Relay, .. } => "relay",
        LinkState::Connecting => "connecting",
        LinkState::Down { .. } => "down",
    };
    Ok(serde_json::json!({ "route": route }))
}

/// Tells every link that the app came back, went away, or the network
/// changed. From the web UI (`visibilitychange`, `online`).
#[tauri::command]
pub fn cloud_poke(why: String) -> Result<(), String> {
    let why = match why.as_str() {
        "resumed" => Poke::Resumed,
        "network_changed" => Poke::NetworkChanged,
        "user_retry" => Poke::UserRetry,
        "background" => Poke::Background,
        _ => return Err("Unknown reason.".into()),
    };
    let Some(p) = PHONE.get() else { return Ok(()) };
    tauri::async_runtime::spawn(async move {
        for l in p.links.lock().await.values() {
            l.link.poke(why);
        }
    });
    Ok(())
}

/// Starts (or finds) the link and bridge to an account computer, without
/// waiting for the link: its loopback origin and its link.
pub async fn start_bridge(device_id: &str) -> Result<(String, Link), String> {
    let p = phone()?;
    // One open at a time: two at once (a tapped notification while the
    // launch falls back to the account) must share one bridge, or the
    // second replaces the first under a caller already using its origin.
    let gate = p
        .opening
        .lock()
        .expect("opening")
        .entry(device_id.to_string())
        .or_default()
        .clone();
    let _opening = gate.lock().await;
    if let Some(l) = p.links.lock().await.get(device_id) {
        return Ok((l.bridge.origin.clone(), l.link.clone()));
    }
    let link = Link::start(Arc::new(PhoneDeps), device_id.to_string());
    let for_bridge = link.clone();
    let opener: Opener = Arc::new(move || {
        let link = for_bridge.clone();
        Box::pin(async move {
            match link.open_stream(LINK_WAIT).await {
                Ok(stream) => Ok(Box::new(stream) as Box<dyn Io>),
                Err(e) => Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    link_message(&e),
                )),
            }
        })
    });
    let port = p.bridge_ports.lock().expect("bridge ports").get(device_id).copied();
    let bridge = match Bridge::start_on(opener, port).await {
        Ok(b) => b,
        Err(e) => {
            link.close();
            return Err(format!("Could not open the local bridge: {e}"));
        }
    };
    let origin = bridge.origin.clone();
    if let Some(bound) = origin.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
        let mut ports = p.bridge_ports.lock().expect("bridge ports");
        if ports.get(device_id) != Some(&bound) {
            ports.insert(device_id.to_string(), bound);
            write_json(&p.data_dir.join("cloud").join("bridges.json"), &*ports);
        }
    }
    p.bridge_keys.lock().expect("bridge keys").insert(
        origin.clone(),
        BridgeEntry {
            key: bridge.key().to_string(),
            device_id: device_id.to_string(),
        },
    );
    p.links.lock().await.insert(
        device_id.to_string(),
        AccountLink {
            link: link.clone(),
            bridge,
        },
    );
    Ok((origin, link))
}

/// Waits until `link` is up. Fails at once on a refusal that will not
/// change by itself (offline, refused, the account), and after `wait` on
/// a network that does not answer.
pub async fn wait_up(link: &Link, wait: Duration) -> Result<(), String> {
    let mut state = link.state();
    let r = tokio::time::timeout(wait, async {
        loop {
            match &*state.borrow_and_update() {
                LinkState::Up { .. } => return Ok(()),
                LinkState::Down { reason, .. } if *reason != DownReason::Network => {
                    return Err(down_message(reason))
                }
                LinkState::Down {
                    retry_at: None,
                    reason,
                } => return Err(down_message(reason)),
                _ => {}
            }
            if state.changed().await.is_err() {
                return Err(UNREACHABLE.to_string());
            }
        }
    })
    .await;
    r.unwrap_or_else(|_| {
        Err("This computer did not answer in time. Check that it is awake and online.".into())
    })
}

/// Closes a computer's link and bridge (opened for nothing, or failed).
pub async fn drop_bridge(device_id: &str) {
    let Ok(p) = phone() else { return };
    if let Some(l) = p.links.lock().await.remove(device_id) {
        l.link.close();
        p.bridge_keys
            .lock()
            .expect("bridge keys")
            .remove(&l.bridge.origin);
    }
}

/// Opens (or reuses) the bridge to an account computer and waits for its
/// link: its loopback origin.
#[cfg(test)]
pub async fn open_bridge(device_id: &str) -> Result<String, String> {
    let (origin, link) = start_bridge(device_id).await?;
    if let Err(e) = wait_up(&link, OPEN_WAIT).await {
        drop_bridge(device_id).await;
        return Err(e);
    }
    Ok(origin)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn servers_get_the_clouds_online_flag_and_unlisted_ones_are_offline() {
        let (devices, [phone, mac, linux]) = three_devices();
        let kinds = HashMap::from([(mac.clone(), Some("macos".to_string()))]);
        let online = HashMap::from([(mac.clone(), true)]);
        let rows = device_rows(&devices, &phone, &kinds, Some(&online));
        let of = |id: &str| rows.iter().find(|r| r.device_id == id).unwrap().clone();
        assert_eq!(of(&phone).online, None, "a client has no presence");
        assert!(of(&phone).me);
        assert_eq!(of(&mac).online, Some(true));
        assert_eq!(of(&mac).kind.as_deref(), Some("macos"));
        assert_eq!(of(&linux).online, Some(false), "never opened presence");
    }

    #[test]
    fn a_failed_or_silent_usage_call_leaves_online_unknown() {
        let (devices, [phone, mac, linux]) = three_devices();
        let rows = device_rows(&devices, &phone, &HashMap::new(), None);
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
}
