//! This computer opening the account's other computers (the desktop app's
//! "Your computers"; spec 3.4: a client opens sessions on servers).
//!
//! The server holds the account keys, so it owns the controller side: one
//! [`Link`] per opened computer (`openagentd_cloud::link`, which keeps its
//! relay session up by itself) behind a loopback bridge
//! (`openagentd_cloud::bridge`), as the phone shell does. The desktop app
//! switches a window to the bridge's origin like a saved server, with the
//! bridge key as that origin's access key; the key is handed only to this
//! computer's own user (`POST /api/cloud/open` is local only) and never
//! stored.
//!
//! Trust: a computer is opened only when it is a server in this host's
//! verified roster, and only by a host that is a client there; the host's
//! `box` key comes from that roster. What a connect needs is copied out of
//! the roster whenever it changes ([`publish`]), so no link waits on a lock
//! held across a network call.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use openagentd_cloud::account_state::AccountProblem;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::bridge::{Bridge, Io, Opener};
use openagentd_cloud::flows::Member;
use openagentd_cloud::keys;
use openagentd_cloud::link::{DownReason, Link, LinkDeps, LinkError, LinkState, Poke, Target};
use openagentd_cloud::relay::{self, TunnelEnd};
use serde::Serialize;

/// Longest a bridged request waits for its computer's link.
pub const LINK_WAIT: Duration = Duration::from_secs(10);
/// Longest opening a computer waits for its link to come up.
pub const OPEN_WAIT: Duration = Duration::from_secs(15);

/// Why a link has nothing to connect with (`DownReason::Refused`).
const SIGNED_OUT: &str = "signed_out";
const NOT_CLIENT: &str = "not_client";
const NOT_IN_ACCOUNT: &str = "not_in_account";

// The phone's words wherever it has them (`mobile/src-tauri/src/cloud.rs`).
pub const OFFLINE: &str = "This computer is offline, or not signed in to your account.";
const UNREACHABLE: &str = "This computer cannot be reached through your account right now.";
const TIMED_OUT: &str = "This computer did not answer in time. Check that it is awake and online.";
pub const CANNOT_OPEN: &str = "This computer can't open your other computers: it isn't used as a client. Roles are chosen when it signs in.";

/// What a link needs, copied from the verified roster.
struct RelayContext {
    cloud: Arc<Cloud>,
    /// This host may open sessions (`client` in the roster).
    client: bool,
    /// The account's servers other than this host, with their box keys.
    servers: HashMap<String, [u8; 32]>,
}

/// A computer's link and the loopback bridge in front of it.
struct AccountLink {
    link: Link,
    bridge: Bridge,
}

struct Controller {
    relay: Mutex<Option<RelayContext>>,
    links: tokio::sync::Mutex<HashMap<String, AccountLink>>,
    /// Held per computer while its bridge opens, so two opens share one.
    opening: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The kind the cloud last reported for each device, for labels.
    kinds: Mutex<HashMap<String, Option<String>>>,
    /// The one HTTP/1.1 client for relay sockets: its TLS sessions resume.
    http1: reqwest::Client,
}

fn controller() -> &'static Controller {
    static C: OnceLock<Controller> = OnceLock::new();
    C.get_or_init(|| Controller {
        relay: Mutex::new(None),
        links: tokio::sync::Mutex::new(HashMap::new()),
        opening: Mutex::new(HashMap::new()),
        kinds: Mutex::new(HashMap::new()),
        http1: relay::http1_client(),
    })
}

/// Copies what links need from `member`'s verified roster (`None`: signed
/// out). The relay client is kept while the account is the same, so its
/// relay token is shared by every link. Links to computers the roster no
/// longer lists as servers are closed.
pub fn publish(member: Option<&Member>) {
    let c = controller();
    let mut slot = c.relay.lock().expect("controller context");
    let old = slot.take();
    *slot = member.map(|m| {
        let me = m.cloud.device_id();
        let servers: HashMap<String, [u8; 32]> =
            m.roster.as_ref().map(|r| r.body.servers().filter(|d| d.id != me).map(|d| (d.id.clone(), d.box_key())).collect()).unwrap_or_default();
        let cloud = match old {
            Some(old) if old.cloud.device_id() == me && old.cloud.account_id == m.cloud.account_id => old.cloud,
            _ => Arc::new(Cloud::new(super::http(), m.cloud.endpoints.clone(), m.cloud.keys.clone(), m.cloud.account_id.clone())),
        };
        RelayContext { cloud, client: m.is_client(), servers }
    });
    let keep: Option<Vec<String>> = slot.as_ref().map(|ctx| if ctx.client { ctx.servers.keys().cloned().collect() } else { Vec::new() });
    drop(slot);
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    rt.spawn(async move {
        let mut links = controller().links.lock().await;
        links.retain(|id, l| {
            let kept = keep.as_ref().is_some_and(|k| k.contains(id));
            if !kept {
                l.link.close();
            }
            kept
        });
    });
}

/// Remembers the kinds the cloud reported, for the opened computer's label.
pub fn set_kinds(kinds: &HashMap<String, Option<String>>) {
    if !kinds.is_empty() {
        *controller().kinds.lock().expect("controller kinds") = kinds.clone();
    }
}

/// Closes every link and bridge (signed out, the account paused, the server
/// stopping).
pub async fn close_all() {
    let mut links = controller().links.lock().await;
    for (_, l) in links.drain() {
        l.link.close();
    }
}

/// Closes one computer's link and bridge (no window uses it any more).
pub async fn close(device_id: &str) {
    if let Some(l) = controller().links.lock().await.remove(device_id) {
        l.link.close();
    }
}

/// Tells every link that the app came back or the network changed.
pub fn poke(why: Poke) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    rt.spawn(async move {
        for l in controller().links.lock().await.values() {
            l.link.poke(why);
        }
    });
}

/// The computer an opened bridge reaches: enough to name it like its row
/// under "Your computers".
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AccountDevice {
    pub device_id: String,
    pub fingerprint: String,
    /// "macos", … when the cloud said (a label, never a check).
    pub kind: Option<String>,
}

/// An opened computer: its bridge's loopback origin and key (the web UI's
/// access key for that origin; a bearer secret, never logged).
#[derive(Serialize)]
pub struct Opened {
    pub origin: String,
    pub key: String,
    pub device: AccountDevice,
}

impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Opened({}, key [redacted], {:?})", self.origin, self.device)
    }
}

/// What the person reads when a link is down.
pub fn down_message(reason: &DownReason) -> String {
    match reason {
        DownReason::HostOffline => OFFLINE.into(),
        DownReason::Paused { .. } => "Today's relay allowance is used up. It resets tomorrow.".into(),
        DownReason::Refused(r) if r == "handshake" => "This computer did not prove its identity. Nothing was sent.".into(),
        DownReason::Refused(r) if r == NOT_CLIENT => CANNOT_OPEN.into(),
        DownReason::Refused(r) if r == NOT_IN_ACCOUNT => "This computer is not in your account.".into(),
        DownReason::Refused(r) if r == SIGNED_OUT => "Not signed in.".into(),
        DownReason::Account(AccountProblem::Closing { .. }) => "Account scheduled for deletion. Remote access is paused; servers on your network still work.".into(),
        DownReason::Account(AccountProblem::Unavailable) => "Account unavailable. Remote access is paused; servers on your network still work.".into(),
        _ => UNREACHABLE.into(),
    }
}

fn link_message(e: &LinkError) -> String {
    match e {
        LinkError::Down(reason) => down_message(reason),
        LinkError::TimedOut => TIMED_OUT.into(),
        _ => UNREACHABLE.into(),
    }
}

/// What a link asks of this host: no lock is held once `target` returns.
struct HostDeps;

impl LinkDeps for HostDeps {
    fn target(&self, device_id: &str) -> Result<Target, DownReason> {
        let c = controller();
        target_in(c.relay.lock().expect("controller context").as_ref(), &c.http1, device_id)
    }

    fn on_problem(&self, _problem: AccountProblem) {
        // The connection loop finds out with a signed roster fetch and
        // applies it (closing these links when the account cannot be used).
        super::poke_roster();
    }

    fn on_end(&self, _device_id: &str, end: &TunnelEnd) {
        tracing::info!("cloud_link_session_ended {end}");
    }
}

/// The connect target for `device_id`: only a server of the verified
/// roster, from a client (spec 3.4).
fn target_in(ctx: Option<&RelayContext>, http1: &reqwest::Client, device_id: &str) -> Result<Target, DownReason> {
    let refused = |r: &str| DownReason::Refused(r.to_string());
    let ctx = ctx.ok_or_else(|| refused(SIGNED_OUT))?;
    if !ctx.client {
        return Err(refused(NOT_CLIENT));
    }
    let host_box = *ctx.servers.get(device_id).ok_or_else(|| refused(NOT_IN_ACCOUNT))?;
    Ok(Target { cloud: ctx.cloud.clone(), http1: http1.clone(), host_box })
}

/// Whether a page may use a bridge: this app's webviews and pages served
/// from this machine, as the server itself allows.
fn first_party(origin: &str) -> bool {
    appv3_core::auth::is_first_party_origin(origin)
}

/// Opens (or reuses) the link and bridge to an account computer and waits
/// for the link. Fails at once when the computer is not a server of the
/// account, this host is not a client, or the relay says it is offline.
pub async fn open(device_id: &str) -> Result<Opened, String> {
    let c = controller();
    // Refused before anything starts: nothing to connect with.
    target_in(c.relay.lock().expect("controller context").as_ref(), &c.http1, device_id).map_err(|r| down_message(&r))?;
    let gate = c.opening.lock().expect("controller opening").entry(device_id.to_string()).or_default().clone();
    let _opening = gate.lock().await;
    let (origin, key, link, created) = {
        let mut links = c.links.lock().await;
        match links.get(device_id) {
            Some(l) => {
                // Opened before and maybe down: try again now.
                l.link.poke(Poke::UserRetry);
                (l.bridge.origin.clone(), l.bridge.key().to_string(), l.link.clone(), false)
            }
            None => {
                let link = Link::start(Arc::new(HostDeps), device_id.to_string());
                let for_bridge = link.clone();
                let opener: Opener = Arc::new(move || {
                    let link = for_bridge.clone();
                    Box::pin(async move {
                        match link.open_stream(LINK_WAIT).await {
                            Ok(stream) => Ok(Box::new(stream) as Box<dyn Io>),
                            Err(e) => Err(std::io::Error::new(std::io::ErrorKind::NotConnected, link_message(&e))),
                        }
                    })
                });
                let bridge = match Bridge::start(opener, first_party).await {
                    Ok(b) => b,
                    Err(e) => {
                        link.close();
                        return Err(format!("Could not open the local bridge: {e}"));
                    }
                };
                let out = (bridge.origin.clone(), bridge.key().to_string(), link.clone(), true);
                links.insert(device_id.to_string(), AccountLink { link, bridge });
                out
            }
        }
    };
    if let Err(e) = wait_up(&link, OPEN_WAIT).await {
        // A bridge a window already uses stays: its link keeps trying.
        if created {
            close(device_id).await;
        }
        return Err(e);
    }
    let kind = c.kinds.lock().expect("controller kinds").get(device_id).cloned().flatten();
    let device = AccountDevice { device_id: device_id.to_string(), fingerprint: keys::fingerprint(device_id).unwrap_or_default(), kind };
    Ok(Opened { origin, key, device })
}

/// Waits until `link` is up. Fails at once on a refusal that will not
/// change by itself (offline, refused, the account), and after `wait` on a
/// network that does not answer.
async fn wait_up(link: &Link, wait: Duration) -> Result<(), String> {
    let mut state = link.state();
    let r = tokio::time::timeout(wait, async {
        loop {
            match &*state.borrow_and_update() {
                LinkState::Up { .. } => return Ok(()),
                LinkState::Down { reason, .. } if *reason != DownReason::Network => return Err(down_message(reason)),
                LinkState::Down { retry_at: None, reason } => return Err(down_message(reason)),
                _ => {}
            }
            if state.changed().await.is_err() {
                return Err(UNREACHABLE.to_string());
            }
        }
    })
    .await;
    r.unwrap_or_else(|_| Err(TIMED_OUT.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openagentd_cloud::endpoints::Endpoints;
    use openagentd_cloud::keys::DeviceKeys;

    fn ctx(client: bool, servers: &[&str]) -> RelayContext {
        RelayContext {
            cloud: Arc::new(Cloud::new(reqwest::Client::new(), Endpoints::current(), DeviceKeys::generate(), Some("acct".into()))),
            client,
            servers: servers.iter().map(|s| (s.to_string(), [7; 32])).collect(),
        }
    }

    fn refused(r: Result<Target, DownReason>) -> String {
        match r {
            Ok(_) => "connects".into(),
            Err(reason) => down_message(&reason),
        }
    }

    #[test]
    fn only_a_server_of_the_roster_is_opened_and_only_by_a_client() {
        let http1 = reqwest::Client::new();
        let target = target_in(Some(&ctx(true, &["host"])), &http1, "host").map(|t| t.host_box);
        assert_eq!(target.ok(), Some([7; 32]), "the box key comes from the roster");
        assert_eq!(refused(target_in(Some(&ctx(true, &["host"])), &http1, "phone")), "This computer is not in your account.");
        assert_eq!(refused(target_in(Some(&ctx(false, &["host"])), &http1, "host")), CANNOT_OPEN);
        assert_eq!(refused(target_in(None, &http1, "host")), "Not signed in.");
    }

    #[test]
    fn an_offline_computer_says_what_the_phone_says() {
        assert_eq!(down_message(&DownReason::HostOffline), "This computer is offline, or not signed in to your account.");
        assert_eq!(link_message(&LinkError::TimedOut), TIMED_OUT);
    }

    #[test]
    fn a_bridge_serves_only_first_party_pages() {
        assert!(first_party("tauri://localhost") && first_party("http://tauri.localhost") && first_party("http://localhost:5173"));
        assert!(!first_party("https://attacker.example") && !first_party("null"));
    }
}
