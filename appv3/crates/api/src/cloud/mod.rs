//! OpenAgentd Cloud accounts on a host (the desktop sidecar or a CLI
//! server): sign-in, the presence socket, and relay sessions into this
//! server.
//!
//! Guest use never touches this module's network side: with no stored
//! identity it only answers `GET /api/cloud/status` with `guest`. The
//! protocol lives in `native/cloud`; the client threat model is
//! `appv3/contract/tunnel-threats.md`.

pub mod approval;
pub mod connector;
pub mod engine;
pub mod invite;
pub mod letters;
pub mod routes;
pub mod signer;

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use axum::Router;
use openagentd_cloud::account_state::{AccountProblem, UNAVAILABLE_RETRY_SECS};
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{FlowError, GenesisDraft, Member, Removal, Session};
use openagentd_cloud::keys::Roles;
use openagentd_cloud::relay::{self, HostHandler, HostOptions, RelayError, Sessions, TunnelEnd};
use openagentd_cloud::roster::{self, Chain, Roster};
use openagentd_cloud::store::{self as idstore, FileStore, Identity, SecretStore};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

/// Where a host keeps its account: a file only the user can read.
pub fn identity_store() -> FileStore {
    FileStore::new(appv3_core::settings().state_dir.join("cloud").join("identity.json"))
}

/// Why the device went back to guest, or an attempt ended.
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
    /// The text pasted is not an invitation link.
    InviteInvalid,
    SignedOut,
    /// No longer happens (any device may create the account); kept so an
    /// older page still reads the status.
    EmptyAccount,
    /// A device needs at least one role, and gets only the ones it asked for.
    Roles,
    Failed,
}

/// The relay connection of a connected host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RelayState {
    Connecting,
    Online,
    /// The daily relay allowance is used up until `until` (Unix ms).
    Paused {
        until: Option<u64>,
    },
    Offline,
    /// This device is not a server in its roster: it runs no connector.
    Off,
}

/// What `GET /api/cloud/status` reports. The web UI shows one screen per
/// state (the plan's state machine).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    Guest {
        notice: Option<Notice>,
    },
    SigningIn {
        user_code: String,
        url: String,
        fingerprint: String,
        expires_in: u64,
    },
    /// A new account (no device in it yet): show the recovery code once,
    /// then ask two of its groups (1-based) back. Only this computer sees it.
    Recovery {
        code: String,
        check: [usize; 2],
    },
    Joining {
        fingerprint: String,
        code: Option<String>,
    },
    /// Claimed an invitation; the phone adds this device once the person
    /// compares the fingerprint and kind.
    Invited {
        fingerprint: String,
        kind: Option<String>,
    },
    Connected {
        fingerprint: String,
        signer: bool,
        /// Its roles in the verified roster: it serves sessions, opens them.
        server: bool,
        client: bool,
        relay: RelayState,
        sessions: usize,
    },
    Closing {
        fingerprint: String,
        deletes_at: Option<u64>,
    },
    Unavailable {
        fingerprint: String,
    },
}

/// A signed-in account with no roster yet, waiting for the person to
/// confirm the recovery code (spec 4.1).
struct Genesis {
    member: Member,
    session: Session,
    draft: GenesisDraft,
}

struct Host {
    status: Mutex<Status>,
    run: Mutex<Option<JoinHandle<()>>>,
    sign_in: Mutex<Option<JoinHandle<()>>>,
    genesis: Mutex<Option<Genesis>>,
    /// Tells the running connection loop that a signer route wrote a roster.
    poke: Mutex<Option<mpsc::UnboundedSender<RosterNote>>>,
    router: OnceLock<Router>,
    private_port: OnceLock<u16>,
    sessions: Sessions,
}

fn host() -> &'static Host {
    static HOST: OnceLock<Host> = OnceLock::new();
    HOST.get_or_init(|| Host {
        status: Mutex::new(Status::Guest { notice: None }),
        run: Mutex::new(None),
        sign_in: Mutex::new(None),
        genesis: Mutex::new(None),
        poke: Mutex::new(None),
        router: OnceLock::new(),
        private_port: OnceLock::new(),
        sessions: Sessions::default(),
    })
}

/// Hands this module the server's router (relay streams are served by it,
/// in-process) and the port of its private listener.
pub fn install(router: Router, private_port: u16) {
    let _ = host().router.set(router);
    let _ = host().private_port.set(private_port);
}

pub(crate) fn router() -> Option<Router> {
    host().router.get().cloned()
}

pub(crate) fn private_port() -> Option<u16> {
    host().private_port.get().copied()
}

pub fn status() -> Status {
    let mut s = host().status.lock().expect("cloud status").clone();
    if let Status::Connected { sessions, .. } = &mut s {
        *sessions = host().sessions.count();
    }
    s
}

fn set_status(s: Status) {
    *host().status.lock().expect("cloud status") = s;
}

fn fingerprint_of(identity: &Identity) -> String {
    identity.keys().map(|k| k.fingerprint()).unwrap_or_default()
}

/// One HTTP client for the API; relay sockets use an HTTP/1.1-only one.
pub(crate) fn http() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(30)).build().unwrap_or_default()
}

/// Module start: a stored, enrolled identity reconnects.
pub async fn start() -> anyhow::Result<()> {
    let store = identity_store();
    match idstore::load(&store) {
        Ok(Some(id)) if id.account_id.is_some() && id.roster.is_some() => spawn_run(id),
        Ok(_) => set_status(Status::Guest { notice: None }),
        Err(e) => {
            tracing::warn!("cloud_identity_unreadable error={e}");
            set_status(Status::Guest { notice: Some(Notice::Failed) });
        }
    }
    Ok(())
}

/// Module stop: closes every relay session and the presence socket.
pub async fn stop() {
    if let Some(h) = host().run.lock().expect("cloud run").take() {
        h.abort();
    }
    if let Some(h) = host().sign_in.lock().expect("cloud sign-in").take() {
        h.abort();
    }
    host().sessions.close_all(1000);
    // An open invitation must not outlive the server that shows it.
    invite::cancel().await;
}

/// Picks up an identity another process (`agentd cloud login`) wrote.
pub async fn reload() {
    stop().await;
    let _ = start().await;
}

/// Starts sign-in in the background (`POST /api/cloud/login`), asking for
/// `roles` when this computer joins or creates the account.
pub fn begin_sign_in(roles: Roles) -> Status {
    let mut slot = host().sign_in.lock().expect("cloud sign-in");
    if let Some(h) = slot.as_ref() {
        if !h.is_finished() {
            return status();
        }
    }
    if !matches!(status(), Status::Guest { .. }) {
        return status();
    }
    *slot = Some(tokio::spawn(async move {
        let outcome = engine::sign_in(Endpoints::current(), http(), roles, on_event).await;
        finish_join(outcome);
    }));
    drop(slot);
    // Give the first answer (the user code) a moment to arrive.
    status()
}

fn on_event(event: engine::Event<'_>) {
    match event {
        engine::Event::Code(code) => {
            set_status(Status::SigningIn { user_code: code.user_code.clone(), url: code.url.clone(), fingerprint: code.fingerprint.clone(), expires_in: code.expires_in })
        }
        engine::Event::Joining { fingerprint, code } => set_status(Status::Joining { fingerprint, code }),
        engine::Event::Invited { fingerprint, kind } => set_status(Status::Invited { fingerprint, kind: kind.map(String::from) }),
    }
}

/// Joins by invitation link in the background (`POST /api/cloud/join`).
/// A link that does not parse is refused here, before any network call.
pub fn begin_join(link: zeroize::Zeroizing<String>, roles: Roles) -> Result<Status, Notice> {
    if openagentd_cloud::invite::parse_link(&link).is_err() {
        return Err(Notice::InviteInvalid);
    }
    let mut slot = host().sign_in.lock().expect("cloud sign-in");
    if slot.as_ref().is_some_and(|h| !h.is_finished()) || !matches!(status(), Status::Guest { .. }) {
        return Ok(status());
    }
    *slot = Some(tokio::spawn(async move {
        let outcome = engine::join_invite(Endpoints::current(), http(), &link, roles, on_event).await;
        drop(link);
        finish_join(outcome);
    }));
    Ok(status())
}

fn finish_join(outcome: Result<engine::Outcome, FlowError>) {
    match outcome {
        Ok(engine::Outcome::Joined(identity)) => {
            if let Err(e) = idstore::save(&identity_store(), &identity) {
                tracing::warn!("cloud_identity_save_failed error={e}");
                set_status(Status::Guest { notice: Some(Notice::Failed) });
                return;
            }
            tracing::info!("cloud_joined");
            spawn_run(identity);
        }
        Ok(engine::Outcome::EmptyAccount { member, session }) => {
            // This computer creates the account: the recovery code comes first.
            let draft = GenesisDraft::new();
            let (a, b) = draft.check_groups();
            set_status(Status::Recovery { code: draft.code.to_string(), check: [a, b] });
            *host().genesis.lock().expect("cloud genesis") = Some(Genesis { member: *member, session, draft });
        }
        Err(e) => {
            tracing::info!("cloud_sign_in_ended reason={}", engine::reason(&e));
            set_status(Status::Guest { notice: Some(engine::notice(&e)) });
        }
    }
}

/// Why the recovery step did not create the account.
#[derive(Debug)]
pub enum RecoveryError {
    /// Not on the recovery step.
    NotAsked,
    /// The groups typed do not match; the step stays open.
    Mismatch { first: usize, second: usize },
    /// Genesis failed; back to guest.
    Failed(FlowError),
}

/// The person typed two groups of the recovery code back: create the
/// account with this computer as its first device (`POST
/// /api/cloud/recovery`). The recovery key is wiped once registered.
pub async fn confirm_recovery(first: &str, second: &str) -> Result<Status, RecoveryError> {
    let Status::Recovery { check: [a, b], .. } = status() else {
        return Err(RecoveryError::NotAsked);
    };
    let mut g = host().genesis.lock().expect("cloud genesis").take().ok_or(RecoveryError::NotAsked)?;
    if !openagentd_cloud::recovery::group_matches(&g.draft.code, a, first) || !openagentd_cloud::recovery::group_matches(&g.draft.code, b, second) {
        *host().genesis.lock().expect("cloud genesis") = Some(g);
        return Err(RecoveryError::Mismatch { first: a, second: b });
    }
    match openagentd_cloud::flows::genesis(&mut g.member, &g.session, g.draft).await {
        Ok(r) => {
            tracing::info!("cloud_genesis");
            finish_join(Ok(engine::Outcome::Joined(engine::identity_of(&g.member, &r))));
            Ok(status())
        }
        Err(e) => {
            tracing::info!("cloud_genesis_failed reason={}", engine::reason(&e));
            set_status(Status::Guest { notice: Some(engine::notice(&e)) });
            Err(RecoveryError::Failed(e))
        }
    }
}

pub fn cancel_sign_in() -> Status {
    if let Some(h) = host().sign_in.lock().expect("cloud sign-in").take() {
        h.abort();
    }
    host().genesis.lock().expect("cloud genesis").take();
    if matches!(status(), Status::SigningIn { .. } | Status::Joining { .. } | Status::Invited { .. } | Status::Recovery { .. }) {
        set_status(Status::Guest { notice: None });
    }
    status()
}

/// Signs this host out: leaves the account (best effort), erases its keys
/// and returns to guest. Local sessions and settings are untouched.
pub async fn sign_out() -> Status {
    // While the keys still sign: an open invitation is cancelled first.
    invite::cancel().await;
    let store = identity_store();
    if let Ok(Some(id)) = idstore::load(&store) {
        if let Ok(keys) = id.keys() {
            let cloud = Cloud::new(http(), Endpoints::current(), keys, id.account_id.clone());
            if let Err(e) = cloud.leave().await {
                tracing::info!("cloud_leave_failed code={}", e.code);
            }
        }
    }
    stop().await;
    if let Err(e) = store.clear() {
        tracing::warn!("cloud_identity_clear_failed error={e}");
    }
    set_status(Status::Guest { notice: Some(Notice::SignedOut) });
    status()
}

fn spawn_run(identity: Identity) {
    let fingerprint = fingerprint_of(&identity);
    set_status(Status::Connected { fingerprint, signer: false, server: false, client: false, relay: RelayState::Connecting, sessions: 0 });
    let handle = tokio::spawn(run(identity));
    if let Some(old) = host().run.lock().expect("cloud run").replace(handle) {
        old.abort();
    }
}

/// What the host does with relay sessions, from its verified roster.
struct Handler {
    roster: Arc<RwLock<Roster>>,
    me: String,
    /// Devices the relay listed as revoked or left. A device that left
    /// stays in the signed roster until a signer rewrites it, so the roster
    /// alone would still admit it. Only ids the verified roster still lists
    /// are kept (the roster refuses the others anyway), so the set never
    /// holds more than the roster's devices.
    revoked: RwLock<HashSet<String>>,
    resync: mpsc::UnboundedSender<RosterNote>,
}

/// What a presence `roster` message asks of the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RosterNote {
    /// This host is listed as revoked. The list is unsigned: stop relaying
    /// and confirm with a signed roster fetch before erasing anything.
    Check,
    /// The stored version is newer than ours: fetch and verify it.
    Fetch,
    /// Nothing new to fetch (a repeat, or a leave, which changes no version).
    Nothing,
}

/// Reads a presence `roster` message. `revoked` repeats devices for about
/// 16 minutes, so this is idempotent; only a newer `version` is fetched.
fn read_roster_note(me: &str, known_version: u64, version: u64, revoked: &[String]) -> RosterNote {
    if revoked.iter().any(|d| d == me) {
        RosterNote::Check
    } else if version > known_version {
        RosterNote::Fetch
    } else {
        RosterNote::Nothing
    }
}

/// Updates the set of departed devices from a presence `revoked` list:
/// drops ids the verified roster no longer lists, then adds the listed
/// ones it still does (never this host).
fn note_revoked(set: &mut HashSet<String>, roster: &Roster, me: &str, revoked: &[String]) {
    set.retain(|d| roster.body.device(d).is_some());
    set.extend(revoked.iter().filter(|d| *d != me && roster.body.device(d).is_some()).cloned());
}

impl HostHandler for Handler {
    fn controller_box(&self, device_id: &str) -> Option<[u8; 32]> {
        if device_id == self.me || self.revoked.read().ok()?.contains(device_id) {
            return None;
        }
        // Only a device the roster lets open sessions (`client`, spec 3.4).
        self.roster.read().ok()?.body.client(device_id).map(|d| d.box_key())
    }

    fn serve(&self, stream: openagentd_cloud::mux::Stream, from: String) {
        tokio::spawn(connector::serve(stream, from));
    }

    fn on_session_end(&self, _from: &str, end: &TunnelEnd) {
        // Why a phone's session ended: `cause=deadline` is this host giving
        // up a socket that went quiet; `cause=closed` came from the relay.
        tracing::info!("cloud_session_ended {end}");
    }

    fn on_roster(&self, version: u64, revoked: Vec<String>) {
        // The relay already closed the listed devices' sessions.
        if let (Ok(mut set), Ok(roster)) = (self.revoked.write(), self.roster.read()) {
            note_revoked(&mut set, &roster, &self.me, &revoked);
        }
        let known = self.roster.read().map(|r| r.version()).unwrap_or(0);
        let note = read_roster_note(&self.me, known, version, &revoked);
        if note != RosterNote::Nothing {
            let _ = self.resync.send(note);
        }
    }
}

/// Ends the account on this host: keys erased, back to guest.
fn forget(notice: Notice) {
    host().sessions.close_all(4001);
    if let Err(e) = identity_store().clear() {
        tracing::warn!("cloud_identity_clear_failed error={e}");
    }
    set_status(Status::Guest { notice: Some(notice) });
}

/// Applies an account problem. Returns whether to keep going.
fn on_problem(p: AccountProblem, fingerprint: &str) -> bool {
    tracing::info!("cloud_account_problem problem={p:?}");
    match p {
        AccountProblem::Closing { deletes_at } => {
            host().sessions.close_all(4011);
            set_status(Status::Closing { fingerprint: fingerprint.to_string(), deletes_at });
            true
        }
        AccountProblem::Unavailable => {
            host().sessions.close_all(4012);
            set_status(Status::Unavailable { fingerprint: fingerprint.to_string() });
            true
        }
        AccountProblem::Deleted => {
            forget(Notice::Deleted);
            false
        }
        AccountProblem::Revoked => {
            forget(Notice::Revoked);
            false
        }
        AccountProblem::RemovalSignal => {
            // Unsigned: close sessions and keep the keys. The next signed
            // roster fetch decides (`Revoked` only on a signed answer).
            host().sessions.close_all(1001);
            true
        }
    }
}

fn set_relay(relay_state: RelayState, member: &Member, fingerprint: &str) {
    let me = member.me();
    set_status(Status::Connected {
        fingerprint: fingerprint.to_string(),
        signer: me.is_some_and(|d| d.signer),
        server: me.is_some_and(|d| d.server),
        client: me.is_some_and(|d| d.client),
        relay: relay_state,
        sessions: 0,
    });
}

/// Tells the running connection loop to fetch the roster again (a signer
/// route on this host wrote one).
pub(crate) fn poke_roster() {
    if let Some(tx) = host().poke.lock().expect("cloud poke").as_ref() {
        let _ = tx.send(RosterNote::Fetch);
    }
}

/// How often a device that is not a server checks its roster, having no
/// presence socket to hear about changes.
const IDLE_SYNC: Duration = Duration::from_secs(300);

/// Exponential backoff with jitter, 1 s to 60 s.
fn backoff(attempt: u32) -> Duration {
    let base = 1u64 << attempt.min(6);
    let jitter: [u8; 1] = openagentd_cloud::keys::random_bytes();
    Duration::from_millis(base.min(60) * 1000 + (jitter[0] as u64) * 4)
}

/// Saves a newly verified roster as the host's `K`.
pub(crate) fn persist_roster(r: &Roster) {
    let store = identity_store();
    if let Ok(Some(mut id)) = idstore::load(&store) {
        id.roster = Some(r.blob.clone());
        id.problem = None;
        if let Err(e) = idstore::save(&store, &id) {
            tracing::warn!("cloud_roster_save_failed error={e}");
        }
    }
}

/// Takes a changed roster as `K`: stores it and closes the sessions of the
/// devices it removed.
fn apply_sync(member: &Member, shared: &RwLock<Roster>, sync: openagentd_cloud::flows::Sync) {
    if sync.changed {
        let r = member.roster.clone().expect("synced");
        persist_roster(&r);
        *shared.write().expect("roster lock") = r;
        for d in sync.removed {
            host().sessions.revoke(&d);
        }
    }
}

async fn run(identity: Identity) {
    let fingerprint = fingerprint_of(&identity);
    let Ok(keys) = identity.keys() else {
        forget(Notice::Failed);
        return;
    };
    let account = identity.account_id.clone().expect("checked by the caller");
    let Some(Ok(known)) = identity.roster.as_deref().map(roster::parse) else {
        forget(Notice::Failed);
        return;
    };
    let me = keys.id();
    let mut member = Member::new(Cloud::new(http(), Endpoints::current(), keys.clone(), Some(account.clone())), Some(known.clone()));
    let presence_cloud = Arc::new(Cloud::new(http(), Endpoints::current(), keys, Some(account.clone())));
    let shared = Arc::new(RwLock::new(known));
    let (resync_tx, mut resync_rx) = mpsc::unbounded_channel();
    *host().poke.lock().expect("cloud poke") = Some(resync_tx.clone());
    let handler: Arc<dyn HostHandler> = Arc::new(Handler { roster: shared.clone(), me: me.clone(), revoked: RwLock::new(HashSet::new()), resync: resync_tx });
    // Notifications go to the phone while this host is signed in; the task
    // ends with this one (dropped when `run` is aborted or returns). Its own
    // client: signed requests each use a fresh nonce from one sequence.
    let _letters = AbortOnDrop(tokio::spawn(letters::run(Arc::new(Cloud::new(http(), Endpoints::current(), presence_cloud.keys.clone(), Some(account.clone()))), shared.clone())));
    let mut attempt = 0u32;
    loop {
        // Bring K up to date (and learn whether the account is usable).
        match member.sync().await {
            Ok(sync) => apply_sync(&member, &shared, sync),
            Err(FlowError::Problem(p)) => {
                if !on_problem(p, &fingerprint) {
                    return;
                }
                set_relay(RelayState::Offline, &member, &fingerprint);
                tokio::time::sleep(Duration::from_secs(UNAVAILABLE_RETRY_SECS)).await;
                continue;
            }
            Err(FlowError::Roster(rule)) => {
                // The cloud served a roster we cannot accept: keep K, stay offline.
                tracing::warn!("cloud_roster_refused rule={rule}");
                set_relay(RelayState::Offline, &member, &fingerprint);
                tokio::time::sleep(backoff(attempt)).await;
                attempt += 1;
                continue;
            }
            Err(e) => {
                tracing::info!("cloud_sync_failed reason={}", engine::reason(&e));
                set_relay(RelayState::Offline, &member, &fingerprint);
                tokio::time::sleep(backoff(attempt)).await;
                attempt += 1;
                continue;
            }
        }
        if !member.is_server() {
            // Not a server in the roster (spec 3.4): no presence socket and
            // no relay sessions. Check the roster now and then, and at once
            // when a signer route here wrote one.
            host().sessions.close_all(4001);
            set_relay(RelayState::Off, &member, &fingerprint);
            attempt = 0;
            tokio::select! {
                _ = tokio::time::sleep(IDLE_SYNC) => {}
                _ = resync_rx.recv() => {}
            }
            continue;
        }
        set_relay(RelayState::Connecting, &member, &fingerprint);
        let (stop_tx, stop_rx) = oneshot::channel();
        // Online once the presence socket really opened (not on a guess).
        let (opened_tx, mut opened) = watch::channel(false);
        let options = HostOptions { opened: Some(opened_tx), ..HostOptions::default() };
        let mut watching = true;
        let mut presence = tokio::spawn(relay::host_with(presence_cloud.clone(), relay::http1_client(), handler.clone(), host().sessions.clone(), stop_rx, options));
        let ended = loop {
            tokio::select! {
                r = &mut presence => break r.unwrap_or(RelayError::Network),
                changed = opened.changed(), if watching => match changed {
                    Ok(()) if *opened.borrow_and_update() => {
                        set_relay(RelayState::Online, &member, &fingerprint);
                        attempt = 0;
                    }
                    Ok(()) => {}
                    // Presence ended; its result is next.
                    Err(_) => watching = false,
                },
                Some(note) = resync_rx.recv() => {
                    if note == RosterNote::Check {
                        // The relay lists this host as removed or departed.
                        // Unsigned: stop relaying and close sessions, then
                        // ask with one signed request. Only that erases keys.
                        let _ = stop_tx.send(());
                        host().sessions.close_all(1001);
                        match member.confirm_removal().await {
                            Removal::Removed => {
                                forget(Notice::Revoked);
                                return;
                            }
                            Removal::NotRemoved(sync) => apply_sync(&member, &shared, sync),
                            Removal::Unsure(FlowError::Problem(p)) => {
                                if !on_problem(p, &fingerprint) {
                                    return;
                                }
                            }
                            Removal::Unsure(e) => tracing::info!("cloud_removal_check_failed reason={}", engine::reason(&e)),
                        }
                        // Keys kept: reconnect after a backoff.
                        break RelayError::Closed(1001);
                    }
                    match member.sync().await {
                        Ok(sync) => apply_sync(&member, &shared, sync),
                        Err(FlowError::Problem(p)) => {
                            let _ = stop_tx.send(());
                            if !on_problem(p, &fingerprint) {
                                return;
                            }
                            break RelayError::Closed(4012);
                        }
                        Err(e) => tracing::info!("cloud_resync_failed reason={}", engine::reason(&e)),
                    }
                }
            }
        };
        tracing::info!("cloud_presence_ended reason={ended}");
        if ended.problem() == Some(AccountProblem::RemovalSignal) {
            // Close 4001 or a refused relay token: unsigned. The signed
            // roster fetch at the top of the loop decides; keys stay.
            on_problem(AccountProblem::RemovalSignal, &fingerprint);
            set_relay(RelayState::Offline, &member, &fingerprint);
            tokio::time::sleep(backoff(attempt)).await;
            attempt += 1;
            continue;
        }
        if let Some(p) = ended.problem() {
            if !on_problem(p, &fingerprint) {
                return;
            }
            tokio::time::sleep(Duration::from_secs(UNAVAILABLE_RETRY_SECS)).await;
            continue;
        }
        if let RelayError::Refused(e) = &ended {
            if e.is("quota_exhausted") {
                let until = e.body.as_ref().and_then(|b| b.get("paused_until")).and_then(|v| v.as_u64());
                set_relay(RelayState::Paused { until }, &member, &fingerprint);
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                let wait = until.map(|u| u.saturating_sub(now)).unwrap_or(3_600_000);
                tokio::time::sleep(Duration::from_millis(wait.clamp(60_000, 86_400_000))).await;
                continue;
            }
        }
        set_relay(RelayState::Offline, &member, &fingerprint);
        tokio::time::sleep(backoff(attempt)).await;
        attempt += 1;
    }
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Verifies a roster blob after `known` for callers outside this module.
pub fn verify_after(blob: &str, account: &str, known: &Roster) -> Result<Roster, openagentd_cloud::Error> {
    roster::verify(blob, account, Some(known), Chain::Skip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn roster_note_checks_only_when_this_host_is_listed() {
        // Listed: confirm with a signed request; the note itself erases nothing.
        assert_eq!(read_roster_note("me", 3, 3, &ids(&["other", "me"])), RosterNote::Check);
        // Listed again on a later message: check again (idempotent).
        assert_eq!(read_roster_note("me", 3, 4, &ids(&["me"])), RosterNote::Check);
    }

    #[test]
    fn roster_note_fetches_only_a_newer_version() {
        assert_eq!(read_roster_note("me", 3, 4, &[]), RosterNote::Fetch);
    }

    #[test]
    fn the_departed_set_holds_only_devices_the_roster_still_lists() {
        use openagentd_cloud::keys::DeviceKeys;
        use openagentd_cloud::roster::{sign, Body, Device};
        let both = Roles::BOTH;
        let (me, a, b) = (DeviceKeys::generate(), DeviceKeys::generate(), DeviceKeys::generate());
        let body = Body::genesis("acct", &[7; 32], Device::of(&me, true, both));
        let one = sign(&Body { devices: vec![Device::of(&me, true, both), Device::of(&a, false, both), Device::of(&b, false, both)], ..body }, &me.id(), &me.sign);
        let mut set = HashSet::new();
        // Ids the roster does not list, and this host, are not kept.
        note_revoked(&mut set, &one, &me.id(), &ids(&[a.id().as_str(), me.id().as_str(), "stranger"]));
        assert_eq!(set, HashSet::from([a.id()]));
        // A later roster without `a` (a signer rewrote it): `a` leaves the set.
        let two = sign(&one.next_body(vec![Device::of(&me, true, both), Device::of(&b, false, both)]), &me.id(), &me.sign);
        note_revoked(&mut set, &two, &me.id(), &ids(&[b.id().as_str()]));
        assert_eq!(set, HashSet::from([b.id()]));
        // A long list cannot grow it past the roster.
        let many: Vec<String> = (0..1000).map(|i| format!("d{i}")).collect();
        note_revoked(&mut set, &two, &me.id(), &many);
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn roster_note_ignores_old_versions_and_leaves() {
        // A leave changes no version; repeats of the revoked list are normal.
        assert_eq!(read_roster_note("me", 3, 3, &ids(&["left"])), RosterNote::Nothing);
        assert_eq!(read_roster_note("me", 3, 3, &ids(&["left"])), RosterNote::Nothing);
        assert_eq!(read_roster_note("me", 4, 3, &[]), RosterNote::Nothing);
    }
}
