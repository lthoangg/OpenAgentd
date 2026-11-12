//! One link per computer: the controller's way to one host, kept up by
//! itself.
//!
//! A [`Link`] owns its tunnel in its own task. It connects at once, and
//! again whenever the tunnel ends: after 0.5 s, doubling to 30 s, with
//! jitter; the backoff starts over only once a tunnel lived 60 s, so a
//! tunnel that opens and dies at once does not reconnect in a tight loop.
//! A [`Poke`] (the app came back to the front, the network changed, the
//! person asked) skips the wait, except a wait the cloud asked for (a
//! paused relay allowance, `Retry-After`), and makes a live tunnel prove
//! itself within [`relay::CHECK_WITHIN`]. While the app is in the
//! background the link stops trying; the tunnel it has stays until it dies.
//!
//! No lock is held across a network call: [`LinkDeps::target`] copies what
//! a connect needs (the cloud client, the host's `box` key from the
//! verified roster) and lets go. Each step of a connect waits 10 s at most
//! ([`Waits::INTERACTIVE`]).
//!
//! Close 4013 ([`relay::CLOSE_SILENT`]) means the host went away without a
//! close; the link reconnects at once, and a `host_offline` refusal after
//! it means the host is offline.
//!
//! Routes (spec 5.5): the relay, and a direct session on the home network.
//! Each connect races the two; direct wins. When the relay came up first,
//! the direct try goes on and takes over when it lands; on the relay, the
//! link tries direct again on a poke and every [`LinkOptions::direct_retry`].
//! New streams take the newest route; the old route's streams finish, and
//! it closes once idle or after [`LinkOptions::drain_within`]. A direct
//! route that dies falls back to the race at once. The addresses come from
//! the app ([`Target::direct`], which keeps them per device and network)
//! and are learned again over every session that comes up
//! ([`LinkDeps::learned`]), so an address that changed fixes itself.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::account_state::{self, AccountProblem};
use crate::api::Cloud;
use crate::direct::{self, DialTarget, DirectAnswer};
use crate::mux::{MuxError, Session, Stream};
use crate::relay::{self, Join, Keepalive, RelayError, Tunnel, TunnelEnd, Waits};

/// How a link reaches its host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Through the account's relay.
    Relay,
    /// A direct session on the home network (spec 5.5).
    Direct { addr: SocketAddr },
}

/// Where a link is.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkState {
    Connecting,
    Up {
        route: Route,
        since: SystemTime,
    },
    /// `retry_at`: when it tries again by itself; `None` while it waits for
    /// a poke (the app in the background, an account problem, nothing to
    /// connect with).
    Down {
        reason: DownReason,
        retry_at: Option<SystemTime>,
    },
}

/// Why a link is down.
#[derive(Debug, Clone, PartialEq)]
pub enum DownReason {
    /// The relay says the host has no presence socket.
    HostOffline,
    /// No answer, a timeout, or a tunnel that ended.
    Network,
    /// The host's relay allowance is used up until `until` (Unix ms), when
    /// the relay said.
    Paused { until: Option<u64> },
    /// The account cannot be used (the app was told, [`LinkDeps::on_problem`]).
    Account(AccountProblem),
    /// Refused for another reason: the relay's error code, `handshake`, or
    /// the app's reason from [`LinkDeps::target`].
    Refused(String),
}

/// Something the app tells every link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Poke {
    /// The app came back to the front: try again now, check the tunnel.
    Resumed,
    /// The network changed: try again now, check the tunnel.
    NetworkChanged,
    /// The person asked: try again now.
    UserRetry,
    /// The app went to the background: stop trying until it is back.
    Background,
}

/// Why a stream could not be opened.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkError {
    /// The link is down and will not be up within the wait.
    Down(DownReason),
    /// The link did not come up within the wait.
    TimedOut,
    /// The link was closed.
    Closed,
    /// The session refused another stream.
    Mux(MuxError),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::Down(DownReason::HostOffline) => f.write_str("the host is offline"),
            LinkError::Down(DownReason::Paused { .. }) => f.write_str("the relay allowance is used up"),
            LinkError::Down(DownReason::Account(p)) => write!(f, "account problem: {p:?}"),
            LinkError::Down(DownReason::Refused(r)) => write!(f, "refused: {r}"),
            LinkError::Down(DownReason::Network) => f.write_str("the relay cannot be reached"),
            LinkError::TimedOut => f.write_str("the link did not come up in time"),
            LinkError::Closed => f.write_str("the link is closed"),
            LinkError::Mux(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for LinkError {}

/// What a connect needs, copied out of the app's state.
#[derive(Clone)]
pub struct Target {
    pub cloud: Arc<Cloud>,
    /// The one HTTP/1.1 client for relay sockets ([`relay::http1_client`]).
    pub http1: reqwest::Client,
    /// The host's `box` key, from the verified roster.
    pub host_box: [u8; 32],
    /// Where the host may be reached directly, from the app's address book
    /// for the network this device is on now (empty: relay only).
    pub direct: Vec<SocketAddr>,
}

/// What a link asks of the app.
pub trait LinkDeps: Send + Sync + 'static {
    /// What a connect to `device_id` needs, copied out (no lock may be held
    /// once this returns). `Err`: why there is nothing to connect with now
    /// (signed out, not in the roster, …); the link waits for a poke.
    fn target(&self, device_id: &str) -> Result<Target, DownReason>;
    /// The relay named an account problem; the app applies it. The link
    /// waits for a poke.
    fn on_problem(&self, problem: AccountProblem);
    /// A tunnel ended (for the logs).
    fn on_end(&self, _device_id: &str, _end: &TunnelEnd) {}
    /// The host said where it can be reached directly (asked over a
    /// session that just came up). The app keeps it per device id and the
    /// network it is on now.
    fn learned(&self, _device_id: &str, _answer: DirectAnswer) {}
}

/// A link's timings.
#[derive(Debug, Clone, Copy)]
pub struct LinkOptions {
    pub join: Join,
    pub keepalive: Keepalive,
    pub waits: Waits,
    /// The first wait before a reconnect; it doubles up to `backoff_max`.
    pub backoff_first: Duration,
    pub backoff_max: Duration,
    /// A tunnel that lived this long starts the backoff over.
    pub steady_after: Duration,
    /// How long a tunnel has to answer the ping a poke sends.
    pub check_within: Duration,
    /// The wait after a paused relay that did not say until when.
    pub paused_wait: Duration,
    /// How long a direct try may take (spec 5.5: 2 s).
    pub direct_wait: Duration,
    /// On the relay, how often to try direct again.
    pub direct_retry: Duration,
    /// After a route change, the old route closes once its streams end, or
    /// after this long.
    pub drain_within: Duration,
    /// Tests only: dial direct addresses on loopback too.
    #[doc(hidden)]
    pub direct_loopback: bool,
}

impl Default for LinkOptions {
    fn default() -> Self {
        LinkOptions {
            join: Join::default(),
            keepalive: Keepalive::default(),
            waits: Waits::INTERACTIVE,
            backoff_first: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            steady_after: Duration::from_secs(60),
            check_within: relay::CHECK_WITHIN,
            paused_wait: Duration::from_secs(300),
            direct_wait: direct::DIAL_WAIT,
            direct_retry: Duration::from_secs(120),
            drain_within: Duration::from_secs(30),
            direct_loopback: false,
        }
    }
}

impl LinkOptions {
    /// The wait before reconnect number `attempt` (from 0), with jitter:
    /// between half and all of `backoff_first * 2^attempt`, at most
    /// `backoff_max`.
    pub fn backoff(&self, attempt: u32) -> Duration {
        let full = self.backoff_first.saturating_mul(1u32 << attempt.min(16)).min(self.backoff_max);
        let r = u16::from_le_bytes(crate::keys::random_bytes::<2>()) as f64 / u16::MAX as f64;
        full.mul_f64(0.5 + r / 2.0)
    }
}

enum Cmd {
    Poke(Poke),
    Close,
}

struct Inner {
    state: watch::Receiver<LinkState>,
    session: Arc<Mutex<Option<Session>>>,
    cmds: mpsc::UnboundedSender<Cmd>,
    closed: AtomicBool,
}

/// One computer's link. Clones share it; it closes when the last one is
/// dropped, or on [`Link::close`].
#[derive(Clone)]
pub struct Link {
    inner: Arc<Inner>,
}

impl Link {
    /// Starts a link to `device_id`; it connects at once.
    pub fn start(deps: Arc<dyn LinkDeps>, device_id: String) -> Link {
        Link::start_with(deps, device_id, LinkOptions::default())
    }

    /// [`Link::start`] with its timings chosen.
    pub fn start_with(deps: Arc<dyn LinkDeps>, device_id: String, opts: LinkOptions) -> Link {
        let (state_tx, state) = watch::channel(LinkState::Connecting);
        let (cmds, cmd_rx) = mpsc::unbounded_channel();
        let session = Arc::new(Mutex::new(None));
        let task = Task { deps, device_id, opts, state: state_tx, session: session.clone(), cmds: cmd_rx, background: false, attempt: 0 };
        tokio::spawn(task.run());
        Link { inner: Arc::new(Inner { state, session, cmds, closed: AtomicBool::new(false) }) }
    }

    pub fn state(&self) -> watch::Receiver<LinkState> {
        self.inner.state.clone()
    }

    /// Opens a stream, waiting at most `wait` for the link to be up. Fails
    /// at once when the link is down and will not try again within `wait`.
    pub async fn open_stream(&self, wait: Duration) -> Result<Stream, LinkError> {
        let deadline = tokio::time::Instant::now() + wait;
        let mut state = self.inner.state.clone();
        loop {
            if self.inner.closed.load(Ordering::Relaxed) {
                return Err(LinkError::Closed);
            }
            let session = self.inner.session.lock().expect("link session").clone();
            if let Some(s) = session.filter(|s| !s.is_closed()) {
                match s.open() {
                    Ok(stream) => return Ok(stream),
                    Err(MuxError::Closed) => {}
                    Err(e) => return Err(LinkError::Mux(e)),
                }
            }
            let now = SystemTime::now();
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if let LinkState::Down { reason, retry_at } = &*state.borrow_and_update() {
                let too_late = retry_at.is_none_or(|at| at.duration_since(now).is_ok_and(|d| d > left));
                if too_late {
                    return Err(LinkError::Down(reason.clone()));
                }
            }
            match tokio::time::timeout_at(deadline, state.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(LinkError::Closed),
                Err(_) => {
                    return Err(match &*state.borrow() {
                        LinkState::Down { reason, .. } => LinkError::Down(reason.clone()),
                        _ => LinkError::TimedOut,
                    })
                }
            }
        }
    }

    pub fn poke(&self, why: Poke) {
        let _ = self.inner.cmds.send(Cmd::Poke(why));
    }

    /// Ends the tunnel and stops the link.
    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::Relaxed);
        let _ = self.inner.cmds.send(Cmd::Close);
    }
}

/// What the task does after a wait.
enum Next {
    Retry,
    Exit,
}

struct Task {
    deps: Arc<dyn LinkDeps>,
    device_id: String,
    opts: LinkOptions,
    state: watch::Sender<LinkState>,
    session: Arc<Mutex<Option<Session>>>,
    cmds: mpsc::UnboundedReceiver<Cmd>,
    background: bool,
    attempt: u32,
}

/// Gives up a direct try: stops it, and ends the tunnel if it had already
/// come up (a finished task's tunnel would otherwise run on unclaimed).
fn discard(p: JoinHandle<Option<(Tunnel, SocketAddr)>>) {
    p.abort();
    tokio::spawn(async move {
        if let Ok(Some((t, _))) = p.await {
            t.end(1000);
        }
    });
}

impl Task {
    async fn run(mut self) {
        loop {
            if self.background {
                let reason = match &*self.state.borrow() {
                    LinkState::Down { reason, .. } => reason.clone(),
                    _ => DownReason::Network,
                };
                if let Next::Exit = self.wait(reason, None, false).await {
                    return;
                }
                continue;
            }
            let target = match self.deps.target(&self.device_id) {
                Ok(t) => t,
                Err(reason) => match self.wait(reason, None, false).await {
                    Next::Retry => continue,
                    Next::Exit => return,
                },
            };
            self.state.send_replace(LinkState::Connecting);
            let device_id = self.device_id.clone();
            let mut pending = spawn_direct(&target, &device_id, &self.opts);
            let relay = relay::connect_within(&target.cloud, &target.http1, &device_id, &target.host_box, self.opts.join, self.opts.keepalive, self.opts.waits);
            let Some(raced) = self.unless_closed(race(relay, &mut pending)).await else {
                if let Some(p) = pending {
                    discard(p);
                }
                return;
            };
            drop(target);
            let next = match raced {
                Raced::Direct(tunnel, addr) => self.hold(tunnel, Route::Direct { addr }, None).await,
                Raced::Relay(Ok(tunnel)) => self.hold(tunnel, Route::Relay, pending.take()).await,
                Raced::Relay(Err(e)) => self.refused(e).await,
            };
            if let Next::Exit = next {
                return;
            }
        }
    }

    /// Runs `step` until it ends; `None` if the link was closed meanwhile.
    /// Pokes that come in meanwhile only change `background`.
    async fn unless_closed<T>(&mut self, step: impl std::future::Future<Output = T>) -> Option<T> {
        tokio::pin!(step);
        loop {
            tokio::select! {
                out = &mut step => return Some(out),
                cmd = self.cmds.recv() => match cmd {
                    None | Some(Cmd::Close) => return None,
                    Some(Cmd::Poke(Poke::Background)) => self.background = true,
                    Some(Cmd::Poke(Poke::Resumed)) => self.background = false,
                    Some(Cmd::Poke(_)) => {}
                },
            }
        }
    }

    /// Keeps a tunnel until it ends; what to do then. On the relay, a
    /// direct try (`pending`, or a new one on a poke or now and then) takes
    /// over when it lands; the relay then drains.
    async fn hold(&mut self, mut tunnel: Tunnel, mut route: Route, mut pending: Option<JoinHandle<Option<(Tunnel, SocketAddr)>>>) -> Next {
        self.up(&tunnel, &route);
        let mut up_at = tokio::time::Instant::now();
        let mut draining: Option<(Tunnel, tokio::time::Instant)> = None;
        let mut retry_at = tokio::time::Instant::now() + self.opts.direct_retry;
        let end = loop {
            let on_relay = route == Route::Relay;
            let retry_due = on_relay && pending.is_none();
            let direct_try = async {
                match pending.as_mut() {
                    Some(h) => h.await.ok().flatten(),
                    None => std::future::pending().await,
                }
            };
            let drain_tick = async {
                match draining {
                    Some(_) => tokio::time::sleep(Duration::from_millis(500)).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                end = tunnel.wait_ended() => break end,
                got = direct_try => {
                    pending = None;
                    if let Some((direct_tunnel, addr)) = got {
                        if on_relay {
                            // Direct wins: new streams go direct, the relay drains.
                            let old = std::mem::replace(&mut tunnel, direct_tunnel);
                            draining = Some((old, tokio::time::Instant::now() + self.opts.drain_within));
                            route = Route::Direct { addr };
                            self.up(&tunnel, &route);
                            up_at = tokio::time::Instant::now();
                        } else {
                            direct_tunnel.end(1000);
                        }
                    }
                }
                _ = drain_tick => {
                    if let Some((old, until)) = &draining {
                        if old.is_closed() || old.session.open_streams() == 0 || tokio::time::Instant::now() >= *until {
                            old.end(1000);
                            draining = None;
                        }
                    }
                }
                _ = tokio::time::sleep_until(retry_at), if retry_due => {
                    retry_at = tokio::time::Instant::now() + self.opts.direct_retry;
                    pending = self.try_direct();
                }
                cmd = self.cmds.recv() => match cmd {
                    None | Some(Cmd::Close) => {
                        tunnel.end(1000);
                        if let Some((old, _)) = draining.take() {
                            old.end(1000);
                        }
                        if let Some(p) = pending.take() {
                            discard(p);
                        }
                        self.session.lock().expect("link session").take();
                        self.state.send_replace(LinkState::Down { reason: DownReason::Network, retry_at: None });
                        return Next::Exit;
                    }
                    Some(Cmd::Poke(Poke::Background)) => self.background = true,
                    Some(Cmd::Poke(why)) => {
                        if why == Poke::Resumed {
                            self.background = false;
                        }
                        tunnel.check(self.opts.check_within);
                        // Back home, or a new network: try the direct route now.
                        if on_relay && pending.is_none() && matches!(why, Poke::Resumed | Poke::NetworkChanged) {
                            pending = self.try_direct();
                        }
                    }
                },
            }
        };
        if let Some(p) = pending.take() {
            discard(p);
        }
        if let Some((old, _)) = draining.take() {
            // The newer route died first; the old one still drains nothing.
            old.end(1000);
        }
        self.session.lock().expect("link session").take();
        if up_at.elapsed() >= self.opts.steady_after {
            self.attempt = 0;
        }
        let code = end.map_or(1006, |e| e.code);
        if let Some(end) = &end {
            self.deps.on_end(&self.device_id, end);
        }
        if code == relay::CLOSE_SILENT {
            // The host went away without a close: find out now whether it
            // is still there.
            return Next::Retry;
        }
        if let Some(problem) = account_state::from_close_code(code) {
            return self.account(problem).await;
        }
        if code == relay::CLOSE_QUOTA {
            let wait = self.opts.paused_wait;
            return self.wait(DownReason::Paused { until: None }, Some(wait), true).await;
        }
        if matches!(route, Route::Direct { .. }) {
            // The direct route died (left home, Wi-Fi off): race again at
            // once, so the relay takes over within seconds.
            return Next::Retry;
        }
        self.back_off(DownReason::Network).await
    }

    /// The link is up on `route`: new streams use `tunnel`, and the host is
    /// asked where it can be reached directly.
    fn up(&self, tunnel: &Tunnel, route: &Route) {
        *self.session.lock().expect("link session") = Some(tunnel.session.clone());
        self.state.send_replace(LinkState::Up { route: route.clone(), since: SystemTime::now() });
        let (session, deps, device) = (tunnel.session.clone(), self.deps.clone(), self.device_id.clone());
        tokio::spawn(async move {
            if let Some(answer) = ask_direct(&session).await {
                deps.learned(&device, answer);
            }
        });
    }

    /// A direct try with what the app has now, if it has addresses.
    fn try_direct(&self) -> Option<JoinHandle<Option<(Tunnel, SocketAddr)>>> {
        let target = self.deps.target(&self.device_id).ok()?;
        spawn_direct(&target, &self.device_id, &self.opts)
    }

    async fn refused(&mut self, e: RelayError) -> Next {
        if let Some(problem) = e.problem() {
            return self.account(problem).await;
        }
        if let Some(until) = e.paused() {
            let wait = until
                .and_then(|ms| SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(ms)))
                .and_then(|at| at.duration_since(SystemTime::now()).ok())
                .unwrap_or(self.opts.paused_wait);
            return self.wait(DownReason::Paused { until }, Some(wait), true).await;
        }
        match e {
            RelayError::Refused(a) if a.is("host_offline") => self.back_off(DownReason::HostOffline).await,
            RelayError::Refused(a) => match a.retry_after {
                Some(secs) => self.wait(DownReason::Refused(a.code.clone()), Some(Duration::from_secs(secs)), true).await,
                None if a.status == 0 => self.back_off(DownReason::Network).await,
                None => self.back_off(DownReason::Refused(a.code.clone())).await,
            },
            RelayError::Handshake => self.back_off(DownReason::Refused("handshake".into())).await,
            RelayError::Closed(_) | RelayError::Network | RelayError::TimedOut => self.back_off(DownReason::Network).await,
        }
    }

    async fn account(&mut self, problem: AccountProblem) -> Next {
        self.deps.on_problem(problem);
        self.wait(DownReason::Account(problem), None, false).await
    }

    async fn back_off(&mut self, reason: DownReason) -> Next {
        let wait = self.opts.backoff(self.attempt);
        self.attempt = self.attempt.saturating_add(1);
        self.wait(reason, Some(wait), false).await
    }

    /// Down for `reason`: waits `wait` (`None`: until a poke). A poke ends
    /// the wait, unless the cloud asked for it (`cloud_asked`). Nothing
    /// ends it while the app is in the background but its return.
    async fn wait(&mut self, reason: DownReason, wait: Option<Duration>, cloud_asked: bool) -> Next {
        let deadline = wait.map(|w| tokio::time::Instant::now() + w);
        loop {
            let retry_at = if self.background { None } else { deadline.map(|d| SystemTime::now() + d.saturating_duration_since(tokio::time::Instant::now())) };
            self.state.send_replace(LinkState::Down { reason: reason.clone(), retry_at });
            let background = self.background;
            let sleep = async move {
                match deadline {
                    Some(d) if !background => tokio::time::sleep_until(d).await,
                    _ => std::future::pending().await,
                }
            };
            let cmd = tokio::select! {
                _ = sleep => return Next::Retry,
                cmd = self.cmds.recv() => cmd,
            };
            let waited_out = deadline.is_some_and(|d| tokio::time::Instant::now() >= d);
            match cmd {
                None | Some(Cmd::Close) => return Next::Exit,
                Some(Cmd::Poke(Poke::Background)) => self.background = true,
                Some(Cmd::Poke(why)) => {
                    if why == Poke::Resumed {
                        self.background = false;
                    }
                    if self.background {
                        continue;
                    }
                    if !cloud_asked || waited_out || deadline.is_none() {
                        return Next::Retry;
                    }
                }
            }
        }
    }
}

/// How a race between the routes ended.
enum Raced {
    Direct(Tunnel, SocketAddr),
    Relay(Result<Tunnel, RelayError>),
}

/// Races the relay connect against a direct try: a direct session that
/// lands first wins (the relay connect is dropped). When the relay lands
/// first, `pending` keeps going for the caller.
async fn race(relay: impl std::future::Future<Output = Result<Tunnel, RelayError>>, pending: &mut Option<JoinHandle<Option<(Tunnel, SocketAddr)>>>) -> Raced {
    tokio::pin!(relay);
    loop {
        let direct_try = async {
            match pending.as_mut() {
                Some(h) => h.await.ok().flatten(),
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            got = direct_try => {
                *pending = None;
                if let Some((t, addr)) = got {
                    return Raced::Direct(t, addr);
                }
            }
            r = &mut relay => return Raced::Relay(r),
        }
    }
}

/// Dials every address in `target.direct` at once (spec 5.5); the first
/// handshake that completes wins. `None` when there is no address.
fn spawn_direct(target: &Target, device_id: &str, opts: &LinkOptions) -> Option<JoinHandle<Option<(Tunnel, SocketAddr)>>> {
    if target.direct.is_empty() {
        return None;
    }
    let account = target.cloud.account_id.clone()?;
    let own_box = target.cloud.keys.r#box.seed().clone();
    let (host_id, host_box, addrs) = (device_id.to_string(), target.host_box, target.direct.clone());
    let (join, keepalive, wait, loopback_ok) = (opts.join, opts.keepalive, opts.direct_wait, opts.direct_loopback);
    Some(tokio::spawn(async move {
        let mut tries = futures_util::stream::FuturesUnordered::new();
        for addr in addrs {
            let (account, host_id, own_box) = (account.clone(), host_id.clone(), own_box.clone());
            tries.push(async move {
                let t = DialTarget { addr, account_id: &account, host_id: &host_id, host_box: &host_box, own_box: &own_box, loopback_ok };
                direct::dial(t, join, keepalive, wait).await.map(|tunnel| (tunnel, addr))
            });
        }
        use futures_util::StreamExt;
        while let Some(r) = tries.next().await {
            if let Ok(won) = r {
                return Some(won);
            }
        }
        None
    }))
}

/// Asks the host where it can be reached directly (`GET
/// /api/cloud/direct`, spec 5.5), over one stream of `session`.
pub async fn ask_direct(session: &Session) -> Option<DirectAnswer> {
    let mut stream = session.open().ok()?;
    let req = b"GET /api/cloud/direct HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    let exchange = async {
        stream.write_all(req).await.ok()?;
        stream.shutdown().await.ok()?;
        let mut out = Vec::new();
        (&mut stream).take(64 * 1024).read_to_end(&mut out).await.ok()?;
        Some(out)
    };
    let out = tokio::time::timeout(Duration::from_secs(10), exchange).await.ok()??;
    parse_direct_response(&out)
}

/// The answer in an HTTP/1.1 response to `GET /api/cloud/direct`: a 200
/// with a JSON body (plain, or chunked as the host's server may send it).
pub fn parse_direct_response(raw: &[u8]) -> Option<DirectAnswer> {
    let text = std::str::from_utf8(raw).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    let chunked = head.lines().any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked"));
    let json = if chunked {
        let mut out = String::new();
        let mut rest = body;
        loop {
            let (size, after) = rest.split_once("\r\n")?;
            let n = usize::from_str_radix(size.trim(), 16).ok()?;
            if n == 0 {
                break;
            }
            out.push_str(after.get(..n)?);
            rest = after.get(n + 2..)?;
        }
        out
    } else {
        body.to_string()
    };
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_direct_answer_is_read_from_plain_and_chunked_responses() {
        let body = r#"{"v":1,"on":true,"port":4181,"addrs":["192.168.1.20"]}"#;
        let plain = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        let a = parse_direct_response(plain.as_bytes()).unwrap();
        assert_eq!(a.targets(), vec!["192.168.1.20:4181".parse().unwrap()]);
        let chunked = format!("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len());
        assert_eq!(parse_direct_response(chunked.as_bytes()), Some(a));
        assert_eq!(parse_direct_response(b"HTTP/1.1 403 Forbidden\r\n\r\n{}"), None);
    }

    #[test]
    fn the_backoff_doubles_to_its_cap_with_jitter() {
        let o = LinkOptions::default();
        for (attempt, full) in [(0, 500), (1, 1000), (2, 2000), (5, 16_000), (6, 30_000), (40, 30_000)] {
            for _ in 0..20 {
                let d = o.backoff(attempt).as_millis() as u64;
                assert!(d >= full / 2 && d <= full, "attempt {attempt}: {d} ms");
            }
        }
    }
}
