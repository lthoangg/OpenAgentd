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
//! Routes: the relay only, for now. A direct route can be added as another
//! [`Route`] without changing callers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::sync::{mpsc, watch};

use crate::account_state::{self, AccountProblem};
use crate::api::Cloud;
use crate::mux::{MuxError, Session, Stream};
use crate::relay::{self, Join, Keepalive, RelayError, Tunnel, TunnelEnd, Waits};

/// How a link reaches its host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Through the account's relay.
    Relay,
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
            let connect = relay::connect_within(&target.cloud, &target.http1, &device_id, &target.host_box, self.opts.join, self.opts.keepalive, self.opts.waits);
            let Some(result) = self.unless_closed(connect).await else { return };
            drop(target);
            let next = match result {
                Ok(tunnel) => self.hold(tunnel).await,
                Err(e) => self.refused(e).await,
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

    /// Keeps a tunnel until it ends; what to do then.
    async fn hold(&mut self, mut tunnel: Tunnel) -> Next {
        *self.session.lock().expect("link session") = Some(tunnel.session.clone());
        self.state.send_replace(LinkState::Up { route: Route::Relay, since: SystemTime::now() });
        let up_at = tokio::time::Instant::now();
        let end = loop {
            tokio::select! {
                end = tunnel.wait_ended() => break end,
                cmd = self.cmds.recv() => match cmd {
                    None | Some(Cmd::Close) => {
                        tunnel.end(1000);
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
                    }
                },
            }
        };
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
        self.back_off(DownReason::Network).await
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

#[cfg(test)]
mod tests {
    use super::*;

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
