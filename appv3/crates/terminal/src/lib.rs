//! Interactive PTY sessions for the user-facing terminal — port of
//! `app/services/terminal_service.py` on top of `portable-pty`.
//!
//! v3 sessions outlive their WebSocket. Every session keeps the last
//! [`RING_BYTES`] of raw PTY output in an [`Output`] ring, with a monotonic
//! `seq` (the total number of bytes ever produced). A client
//! [`attach`](TerminalSession::attach)es at a `seq` and reads from there, so a
//! reload or a dropped connection can detach and later reattach, replaying
//! what it missed:
//!
//! - While **detached** the reader thread never blocks; the oldest bytes fall
//!   out of the ring (the reattaching client sees a `seq` gap).
//! - While **attached** nothing is dropped. The reader blocks (PTY
//!   backpressure) only when the bytes not yet handed to the attachment
//!   would exceed the ring.
//! - Attaching again supersedes the older [`Attachment`] (takeover).
//! - A detached session is closed after [`DETACHED_GRACE`] without a
//!   reattach, an idle one after [`IDLE_TIMEOUT`], and an exited one at once.
//!
//! [`Flow`] is the client-ack window the WebSocket layer applies on top.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::Notify;
use tokio::time::Instant as TokioInstant;

/// Hard cap on simultaneously open PTY sessions (`MAX_SESSIONS`).
pub const MAX_SESSIONS: usize = 8;
/// Idle sessions are reaped after this long (`IDLE_TIMEOUT_SECONDS`), unless
/// a command is still running in them ([`TerminalSession::busy`]).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// A session nobody is attached to is closed after this long. Tests can
/// shorten it with [`set_detached_grace`].
pub const DETACHED_GRACE: Duration = Duration::from_secs(10 * 60);
/// Raw PTY output kept per session for replay.
pub const RING_BYTES: usize = 2 * 1024 * 1024;
/// The largest piece of output handed out at once (one WebSocket frame).
pub const CHUNK_BYTES: usize = 64 * 1024;
/// Flow control: stop sending while more than this is unacknowledged…
pub const HIGH_WATER: u64 = 512 * 1024;
/// …and resume once it is back down to this.
pub const LOW_WATER: u64 = 128 * 1024;
const READ_CHUNK: usize = 65536;
/// Outer-terminal identity vars that must not leak into the spawned shell.
const IDENTITY_LEAK_KEYS: [&str; 2] = ["TERM_SESSION_ID", "ITERM_SESSION_ID"];

static GRACE_OVERRIDE_MS: AtomicU64 = AtomicU64::new(0);

/// The detached-session grace in force ([`DETACHED_GRACE`] unless overridden).
pub fn detached_grace() -> Duration {
    match GRACE_OVERRIDE_MS.load(Ordering::Relaxed) {
        0 => DETACHED_GRACE,
        ms => Duration::from_millis(ms),
    }
}

/// Override [`DETACHED_GRACE`] (`None` restores it). For tests.
#[doc(hidden)]
pub fn set_detached_grace(grace: Option<Duration>) {
    GRACE_OVERRIDE_MS.store(grace.map_or(0, |d| (d.as_millis() as u64).max(1)), Ordering::Relaxed);
}

/// Wakes the reaper when a shell's output ends, so exited sessions go at once.
static REAP_NOW: Notify = Notify::const_new();

// ── output ring ─────────────────────────────────────────────────────────────

struct State {
    /// The newest `cap` bytes ever produced (fewer at first).
    buf: VecDeque<u8>,
    /// Bytes ever produced; `total - buf.len()` is the ring start.
    total: u64,
    /// The current attachment's read cursor (what has been handed out).
    sent: u64,
    attached: bool,
    /// Bumped by every attach; an [`Attachment`] is current while it matches.
    generation: u64,
    eof: bool,
    closed: bool,
    detached_since: Option<TokioInstant>,
}

/// A session's output ring: the reader thread pushes into it, at most one
/// [`Attachment`] reads from it. See the crate docs for the drop/block rules.
pub struct Output {
    cap: usize,
    state: Mutex<State>,
    /// Wakes a reader blocked on backpressure.
    space: Condvar,
    /// Wakes attachments: new data, EOF, close, takeover.
    changed: Notify,
}

impl Output {
    pub fn new() -> Arc<Self> {
        Self::with_capacity(RING_BYTES)
    }

    pub fn with_capacity(cap: usize) -> Arc<Self> {
        assert!(cap > 0);
        Arc::new(Output {
            cap,
            state: Mutex::new(State {
                buf: VecDeque::new(),
                total: 0,
                sent: 0,
                attached: false,
                generation: 0,
                eof: false,
                closed: false,
                detached_since: Some(TokioInstant::now()),
            }),
            space: Condvar::new(),
            changed: Notify::new(),
        })
    }

    /// Bytes ever produced.
    pub fn total(&self) -> u64 {
        self.state.lock().unwrap().total
    }

    /// `seq` of the oldest byte still in the ring.
    pub fn ring_start(&self) -> u64 {
        let st = self.state.lock().unwrap();
        st.total - st.buf.len() as u64
    }

    pub fn is_attached(&self) -> bool {
        self.state.lock().unwrap().attached
    }

    pub fn eof(&self) -> bool {
        self.state.lock().unwrap().eof
    }

    /// How long nobody has been attached (`None` while attached).
    pub fn detached_for(&self) -> Option<Duration> {
        self.state.lock().unwrap().detached_since.map(|t| t.elapsed())
    }

    /// Append PTY output (reader thread). Blocks while an attachment is
    /// behind by a full ring; never blocks while detached, where the oldest
    /// bytes are dropped instead. `false` once the output is closed.
    pub fn push(&self, data: &[u8]) -> bool {
        for piece in data.chunks(self.cap) {
            let mut st = self.state.lock().unwrap();
            while st.attached && !st.closed && (st.total - st.sent) + piece.len() as u64 > self.cap as u64 {
                st = self.space.wait(st).unwrap();
            }
            if st.closed {
                return false;
            }
            st.buf.extend(piece);
            st.total += piece.len() as u64;
            if st.buf.len() > self.cap {
                let excess = st.buf.len() - self.cap;
                st.buf.drain(..excess);
            }
            drop(st);
            self.changed.notify_waiters();
        }
        true
    }

    /// The shell's output ended (reader thread).
    pub fn finish(&self) {
        self.state.lock().unwrap().eof = true;
        self.changed.notify_waiters();
        REAP_NOW.notify_one();
    }

    /// The session was closed: wake everything, refuse further output.
    /// Bytes already in the ring can still be read.
    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.space.notify_all();
        self.changed.notify_waiters();
    }

    /// Start reading at `since`, clamped into what the ring holds (`since`
    /// past the end → the end; before the ring start → the ring start). Any
    /// earlier attachment is superseded.
    pub fn attach(self: &Arc<Self>, since: u64) -> Attachment {
        let mut st = self.state.lock().unwrap();
        st.generation += 1;
        let start = st.total - st.buf.len() as u64;
        let cursor = since.min(st.total).max(start);
        st.attached = true;
        st.detached_since = None;
        st.sent = cursor;
        let generation = st.generation;
        drop(st);
        self.changed.notify_waiters();
        self.space.notify_all();
        Attachment { out: self.clone(), generation, start: cursor, cursor: AtomicU64::new(cursor) }
    }

    fn detach(&self, generation: u64) {
        let mut st = self.state.lock().unwrap();
        if st.generation != generation || !st.attached {
            return;
        }
        st.attached = false;
        st.detached_since = Some(TokioInstant::now());
        drop(st);
        self.space.notify_all();
    }
}

/// What [`Attachment::next`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// `bytes` start at `seq`. A `seq` past the previous chunk's end means
    /// output was dropped while detached.
    Data { seq: u64, bytes: Vec<u8> },
    /// The shell exited (or the session closed) and everything was read.
    Eof,
    /// Another attachment took over.
    Superseded,
}

/// A client's read position in a session's [`Output`]. Dropping it detaches
/// (unless another attachment has already taken over).
pub struct Attachment {
    out: Arc<Output>,
    generation: u64,
    start: u64,
    cursor: AtomicU64,
}

impl Attachment {
    /// `seq` of the first byte this attachment will deliver.
    pub fn start_seq(&self) -> u64 {
        self.start
    }

    /// `seq` just past the last byte handed out.
    pub fn cursor(&self) -> u64 {
        self.cursor.load(Ordering::SeqCst)
    }

    /// The next up-to-`max` bytes, waiting for some. Cancel-safe: nothing is
    /// consumed unless the future completes.
    pub async fn next(&self, max: usize) -> Next {
        loop {
            let notified = self.out.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut st = self.out.state.lock().unwrap();
                if st.generation != self.generation {
                    return Next::Superseded;
                }
                let start = st.total - st.buf.len() as u64;
                // Behind the ring (only possible after detaching): jump ahead.
                let cursor = self.cursor.load(Ordering::SeqCst).max(start);
                if st.total > cursor {
                    let off = (cursor - start) as usize;
                    let n = ((st.total - cursor).min(max as u64)) as usize;
                    let bytes: Vec<u8> = st.buf.range(off..off + n).copied().collect();
                    let end = cursor + n as u64;
                    self.cursor.store(end, Ordering::SeqCst);
                    st.sent = end;
                    drop(st);
                    self.out.space.notify_all();
                    return Next::Data { seq: cursor, bytes };
                }
                if st.eof || st.closed {
                    return Next::Eof;
                }
            }
            notified.await;
        }
    }

    /// Plain output only: the next chunk, `None` at EOF or takeover.
    pub async fn read(&self) -> Option<Vec<u8>> {
        match self.next(CHUNK_BYTES).await {
            Next::Data { bytes, .. } => Some(bytes),
            _ => None,
        }
    }

    /// Resolves once another attachment has taken over.
    pub async fn superseded(&self) {
        loop {
            let notified = self.out.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.out.state.lock().unwrap().generation != self.generation {
                return;
            }
            notified.await;
        }
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.out.detach(self.generation);
    }
}

/// The client-ack send window: sending stops once more than [`HIGH_WATER`]
/// bytes are unacknowledged and resumes at [`LOW_WATER`].
#[derive(Debug)]
pub struct Flow {
    acked: u64,
    paused: bool,
}

impl Flow {
    /// `initial_ack` is the `seq` the attachment starts at.
    pub fn new(initial_ack: u64) -> Self {
        Flow { acked: initial_ack, paused: false }
    }

    /// The client processed everything below `seq` (never moves back).
    pub fn ack(&mut self, seq: u64) {
        self.acked = self.acked.max(seq);
    }

    pub fn acked(&self) -> u64 {
        self.acked
    }

    /// May more be sent, with `sent` bytes (a `seq`) already out?
    pub fn may_send(&mut self, sent: u64) -> bool {
        let in_flight = sent.saturating_sub(self.acked);
        if self.paused {
            if in_flight <= LOW_WATER {
                self.paused = false;
            }
        } else if in_flight > HIGH_WATER {
            self.paused = true;
        }
        !self.paused
    }
}

// ── sessions ────────────────────────────────────────────────────────────────

pub struct TerminalSession {
    pub session_id: String,
    pub pid: Option<u32>,
    pub workspace: String,
    pub created_at: SystemTime,
    output: Arc<Output>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    last_activity: Arc<Mutex<Instant>>,
    closed: AtomicBool,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<TerminalSession>>> {
    static S: OnceLock<Mutex<HashMap<String, Arc<TerminalSession>>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

pub fn get_session(id: &str) -> Option<Arc<TerminalSession>> {
    sessions().lock().unwrap().get(id).cloned()
}

pub fn session_count() -> usize {
    sessions().lock().unwrap().len()
}

/// Live sessions, oldest first.
pub fn list_sessions() -> Vec<Arc<TerminalSession>> {
    let mut all: Vec<_> = sessions().lock().unwrap().values().filter(|s| s.alive()).cloned().collect();
    all.sort_by_key(|s| s.created_at);
    all
}

#[cfg(unix)]
fn killpg(pid: u32, sig: nix::sys::signal::Signal) {
    use nix::unistd::{getpgid, Pid};
    if let Ok(pg) = getpgid(Some(Pid::from_raw(pid as i32))) {
        let _ = nix::sys::signal::killpg(pg, sig);
    }
}

impl TerminalSession {
    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        self.last_activity.lock().unwrap().elapsed()
    }

    /// Attach at `since` (see [`Output::attach`]); supersedes any other
    /// attachment. Dropping the [`Attachment`] detaches and leaves the shell
    /// running.
    pub fn attach(&self, since: u64) -> Attachment {
        self.output.attach(since)
    }

    pub fn output(&self) -> &Arc<Output> {
        &self.output
    }

    pub fn is_attached(&self) -> bool {
        self.output.is_attached()
    }

    pub async fn write(&self, data: Vec<u8>) -> std::io::Result<()> {
        if self.closed.load(Ordering::SeqCst) || self.output.eof() {
            return Ok(());
        }
        self.touch();
        let w = self.writer.clone();
        tokio::task::spawn_blocking(move || {
            let mut g = w.lock().unwrap();
            match g.as_mut() {
                Some(w) => w.write_all(&data).and_then(|_| w.flush()),
                None => Ok(()),
            }
        })
        .await
        .unwrap_or(Ok(()))
    }

    /// TIOCSWINSZ + SIGWINCH, clamped like v2.
    pub fn resize(&self, rows: i64, cols: i64) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let rows = rows.clamp(1, 1000) as u16;
        let cols = cols.clamp(1, 4000) as u16;
        if let Some(m) = self.master.lock().unwrap().as_ref() {
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            killpg(pid, nix::sys::signal::Signal::SIGWINCH);
        }
    }

    fn process_alive(&self) -> bool {
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    pub fn alive(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && !self.output.eof() && self.process_alive()
    }

    /// True while a command runs in the shell: the PTY's foreground process
    /// group is no longer the shell's own (job control hands the terminal to
    /// each command it runs). Windows has no such signal and reads false.
    pub fn busy(&self) -> bool {
        #[cfg(unix)]
        {
            let Some(pid) = self.pid else { return false };
            let foreground = self.master.lock().unwrap().as_ref().and_then(|m| m.process_group_leader());
            matches!(foreground, Some(pg) if i64::from(pg) != i64::from(pid))
        }
        #[cfg(not(unix))]
        false
    }

    /// SIGHUP the process group, grace period, then SIGKILL; release the PTY.
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        sessions().lock().unwrap().remove(&self.session_id);
        // Unblock a reader held back by an attachment, and end attachments
        // once they have read what is already in the ring.
        self.output.close();
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            killpg(pid, nix::sys::signal::Signal::SIGHUP);
        }
        let mut exited = false;
        for _ in 0..10 {
            if !self.process_alive() {
                exited = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !exited {
            #[cfg(unix)]
            if let Some(pid) = self.pid {
                killpg(pid, nix::sys::signal::Signal::SIGKILL);
            }
            let _ = self.child.lock().unwrap().kill();
            for _ in 0..40 {
                if !self.process_alive() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        self.writer.lock().unwrap().take();
        self.master.lock().unwrap().take();
        tracing::info!("terminal_session_closed session_id={} pid={:?}", self.session_id, self.pid);
    }
}

/// `create_session` — spawn the user's shell in a PTY rooted at *workspace*.
/// `Err(message)` mirrors v2's RuntimeError / OSError text.
/// Windows uses ConPTY (v2 refuses terminals there).
pub fn create_session(workspace: &str, rows: i64, cols: i64) -> Result<Arc<TerminalSession>, String> {
    if session_count() >= MAX_SESSIONS {
        return Err(format!("Too many open terminal sessions (max {MAX_SESSIONS}). Close an existing terminal first."));
    }
    let shell = appv3_tools::shell::acceptable();
    let name = appv3_tools::shell::shell_name_of(&shell);
    let mut cmd = CommandBuilder::new(&shell);
    match name.as_str() {
        "zsh" | "bash" => cmd.arg("-il"),
        "pwsh" | "powershell" => cmd.arg("-NoLogo"),
        "cmd" => {}
        _ => cmd.arg("-i"),
    }
    for k in appv3_core::env::child_env_blocklist().iter().map(String::as_str).chain(IDENTITY_LEAK_KEYS) {
        cmd.env_remove(k);
    }
    // The person's own terminal, not the agent's: `agentd cloud approve` works here.
    cmd.env_remove(appv3_core::auth::AGENT_MARKER_ENV);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.cwd(workspace);
    let size = PtySize { rows: rows.clamp(1, 1000) as u16, cols: cols.clamp(1, 4000) as u16, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let last_activity = Arc::new(Mutex::new(Instant::now()));
    let output = Output::new();
    let (la, out) = (last_activity.clone(), output.clone());
    std::thread::Builder::new()
        .name("terminal-reader".into())
        .spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        *la.lock().unwrap() = Instant::now();
                        if !out.push(&buf[..n]) {
                            break;
                        }
                    }
                }
            }
            out.finish();
        })
        .map_err(|e| e.to_string())?;
    let session = Arc::new(TerminalSession {
        session_id: uuid::Uuid::new_v4().simple().to_string(),
        pid: child.process_id(),
        workspace: workspace.to_string(),
        created_at: SystemTime::now(),
        output,
        master: Mutex::new(Some(pair.master)),
        writer: Arc::new(Mutex::new(Some(writer))),
        child: Mutex::new(child),
        last_activity,
        closed: Default::default(),
    });
    session.resize(rows, cols);
    sessions().lock().unwrap().insert(session.session_id.clone(), session.clone());
    ensure_reaper();
    tracing::info!("terminal_session_created session_id={} pid={:?} shell={} workspace={}", session.session_id, session.pid, name, workspace);
    Ok(session)
}

/// Why a session should be closed now, if it should: its shell exited, nobody
/// has been attached for [`detached_grace`], or it is idle (with no command
/// running).
fn reap_reason(s: &TerminalSession) -> Option<&'static str> {
    if !s.alive() {
        return Some("exited");
    }
    if s.output.detached_for().is_some_and(|d| d > detached_grace()) {
        return Some("detached");
    }
    // A running command keeps its session, however quiet it is.
    if s.idle_for() > IDLE_TIMEOUT && !s.busy() {
        return Some("idle");
    }
    None
}

/// Close `s` if [`reap_reason`] says so; whether it was closed.
async fn reap_session(s: &Arc<TerminalSession>) -> bool {
    let Some(reason) = reap_reason(s) else { return false };
    tracing::info!("terminal_session_reaped session_id={} reason={} idle_s={:.0}", s.session_id, reason, s.idle_for().as_secs_f64());
    s.close().await;
    true
}

async fn reap_pass() {
    let all: Vec<Arc<TerminalSession>> = sessions().lock().unwrap().values().cloned().collect();
    for s in all {
        reap_session(&s).await;
    }
}

fn ensure_reaper() {
    // Unit tests reap explicitly (the reaper walks every session in the process).
    if cfg!(test) {
        return;
    }
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        RUNNING.store(false, Ordering::SeqCst);
        return;
    };
    handle.spawn(async {
        while session_count() > 0 {
            let tick = (IDLE_TIMEOUT.min(detached_grace()) / 10).clamp(Duration::from_millis(50), Duration::from_secs(30));
            tokio::select! {
                _ = tokio::time::sleep(tick) => {}
                _ = REAP_NOW.notified() => {}
            }
            reap_pass().await;
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

/// `close_all` (shutdown).
pub async fn close_all() {
    let all: Vec<Arc<TerminalSession>> = sessions().lock().unwrap().values().cloned().collect();
    for s in all {
        s.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plain shell: the developer's login shell rc files can swallow
    /// scripted input. Every test that spawns one sets the same value.
    fn plain_shell() {
        std::env::set_var("SHELL", "/bin/sh");
    }

    async fn next_data(a: &Attachment) -> (u64, Vec<u8>) {
        match tokio::time::timeout(Duration::from_secs(5), a.next(CHUNK_BYTES)).await.expect("no output") {
            Next::Data { seq, bytes } => (seq, bytes),
            other => panic!("expected data, got {other:?}"),
        }
    }

    fn wait_until(what: &str, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[tokio::test]
    async fn the_ring_wraps_and_drops_the_oldest_bytes_while_detached() {
        let out = Output::with_capacity(8);
        assert!(out.push(b"abcdef"));
        assert!(out.push(b"ghijkl"));
        // 12 bytes produced, the newest 8 kept: seq 4.. is "efghijkl".
        assert_eq!((out.total(), out.ring_start()), (12, 4));
        // One push larger than the ring keeps its tail.
        assert!(out.push(b"0123456789"));
        assert_eq!((out.total(), out.ring_start()), (22, 14));
        let a = out.attach(0);
        assert_eq!(a.start_seq(), 14);
        assert_eq!(next_data(&a).await, (14, b"23456789".to_vec()));
    }

    #[tokio::test]
    async fn seq_counts_every_byte_ever_produced() {
        let out = Output::with_capacity(4);
        let a = out.attach(0);
        assert_eq!(a.start_seq(), 0, "a fresh session starts at 0");
        assert!(out.push(b"ab"));
        assert_eq!(next_data(&a).await, (0, b"ab".to_vec()));
        assert!(out.push(b"cde"));
        assert_eq!(next_data(&a).await, (2, b"cde".to_vec()));
        assert_eq!((a.cursor(), out.total()), (5, 5));
        // A chunk is capped at `max`.
        assert!(out.push(b"fg"));
        assert_eq!(a.next(1).await, Next::Data { seq: 5, bytes: b"f".to_vec() });
        assert_eq!(a.next(1).await, Next::Data { seq: 6, bytes: b"g".to_vec() });
    }

    #[tokio::test]
    async fn reattaching_replays_from_since_clamped_to_the_ring() {
        let out = Output::with_capacity(8);
        // The ring now holds seq 2..10 = "23456789".
        out.push(b"0123456789");
        // Inside the ring: exactly `since`.
        let a = out.attach(5);
        assert_eq!(a.start_seq(), 5);
        assert_eq!(next_data(&a).await, (5, b"56789".to_vec()));
        drop(a);
        // Before the ring start: the ring start (a gap the client can see).
        let a = out.attach(1);
        assert_eq!(a.start_seq(), 2);
        assert_eq!(next_data(&a).await, (2, b"23456789".to_vec()));
        drop(a);
        // Past the end: the end, so nothing is replayed…
        let a = out.attach(1_000);
        assert_eq!(a.start_seq(), 10);
        assert!(tokio::time::timeout(Duration::from_millis(50), a.next(64)).await.is_err());
        // …and new output follows at the end.
        out.push(b"X");
        assert_eq!(next_data(&a).await, (10, b"X".to_vec()));
    }

    #[tokio::test]
    async fn a_late_cursor_jumps_to_the_ring_start() {
        let out = Output::with_capacity(4);
        let a = out.attach(0);
        out.push(b"abcd");
        assert_eq!(next_data(&a).await, (0, b"abcd".to_vec()));
        // Detached while the handle lives on: output overwrites what it has
        // not read yet, and the next read jumps to the ring start (a seq gap).
        out.detach(a.generation);
        out.push(b"efghij"); // ring is "ghij", seq 6..10
        assert_eq!(next_data(&a).await, (6, b"ghij".to_vec()));
    }

    #[test]
    fn an_attached_reader_blocks_instead_of_dropping_data() {
        let out = Output::with_capacity(8);
        let a = out.attach(0);
        let producer = {
            let out = out.clone();
            std::thread::spawn(move || {
                for i in 0..6u8 {
                    assert!(out.push(&[b'a' + 4 * i, b'b' + 4 * i, b'c' + 4 * i, b'd' + 4 * i]));
                }
            })
        };
        // The ring fills with 8 unread bytes and the producer stops there.
        wait_until("the ring to fill", || out.total() == 8);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(out.total(), 8, "the reader kept going past an unread full ring");
        assert!(!producer.is_finished());

        // Reading frees room one chunk at a time; every byte arrives, in order.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut got = Vec::new();
        let mut next_seq = 0;
        while got.len() < 24 {
            match rt.block_on(a.next(3)) {
                Next::Data { seq, bytes } => {
                    assert_eq!(seq, next_seq, "a gap means bytes were dropped");
                    next_seq += bytes.len() as u64;
                    got.extend(bytes);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        producer.join().unwrap();
        assert_eq!(got, (0..24u8).map(|i| b'a' + i).collect::<Vec<_>>());
        assert_eq!(out.total(), 24);
    }

    #[test]
    fn detaching_unblocks_the_reader_and_drops_the_oldest_bytes() {
        let out = Output::with_capacity(8);
        let a = out.attach(0);
        out.push(b"01234567");
        let producer = {
            let out = out.clone();
            std::thread::spawn(move || out.push(b"89"))
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(!producer.is_finished(), "the attached reader should be blocked");
        drop(a);
        assert!(producer.join().unwrap());
        assert_eq!((out.total(), out.ring_start()), (10, 2));
    }

    #[tokio::test]
    async fn a_second_attach_supersedes_the_first() {
        let out = Output::with_capacity(8);
        let first = out.attach(0);
        let second = out.attach(0);
        assert_eq!(first.next(8).await, Next::Superseded);
        tokio::time::timeout(Duration::from_secs(1), first.superseded()).await.unwrap();
        // The old handle going away must not detach the new one.
        drop(first);
        assert!(out.is_attached());
        out.push(b"hi");
        assert_eq!(next_data(&second).await, (0, b"hi".to_vec()));
        drop(second);
        assert!(!out.is_attached());
    }

    #[tokio::test]
    async fn eof_and_close_are_delivered_after_the_buffered_bytes() {
        let out = Output::with_capacity(8);
        let a = out.attach(0);
        out.push(b"bye");
        out.finish();
        assert_eq!(next_data(&a).await, (0, b"bye".to_vec()));
        assert_eq!(a.next(8).await, Next::Eof);

        let out = Output::with_capacity(8);
        let a = out.attach(0);
        out.push(b"x");
        out.close();
        assert!(!out.push(b"y"), "no output after close");
        assert_eq!(next_data(&a).await, (0, b"x".to_vec()));
        assert_eq!(a.next(8).await, Next::Eof);
    }

    #[tokio::test(start_paused = true)]
    async fn detached_for_counts_from_the_detach_and_stops_while_attached() {
        let out = Output::with_capacity(8);
        tokio::time::advance(Duration::from_secs(5)).await;
        assert_eq!(out.detached_for(), Some(Duration::from_secs(5)), "never attached counts from creation");
        let a = out.attach(0);
        assert_eq!(out.detached_for(), None);
        tokio::time::advance(Duration::from_secs(60)).await;
        drop(a);
        assert_eq!(out.detached_for(), Some(Duration::ZERO));
        tokio::time::advance(Duration::from_secs(7)).await;
        assert_eq!(out.detached_for(), Some(Duration::from_secs(7)));
    }

    #[test]
    fn flow_control_pauses_above_the_high_water_and_resumes_at_the_low_water() {
        let mut f = Flow::new(1_000);
        assert!(f.may_send(1_000 + HIGH_WATER), "exactly the high water still sends");
        assert!(!f.may_send(1_000 + HIGH_WATER + 1));
        // Still paused anywhere above the low water, even below the high water.
        f.ack(1_000 + HIGH_WATER + 1 - LOW_WATER - 1);
        assert!(!f.may_send(1_000 + HIGH_WATER + 1));
        f.ack(1_000 + HIGH_WATER + 1 - LOW_WATER);
        assert!(f.may_send(1_000 + HIGH_WATER + 1));
        // An ack never moves back.
        f.ack(0);
        assert_eq!(f.acked(), 1_000 + HIGH_WATER + 1 - LOW_WATER);
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn a_detached_session_is_reaped_after_the_grace_but_not_before() {
        plain_shell();
        let d = std::env::temp_dir();
        let s = create_session(&d.display().to_string(), 24, 80).unwrap();
        let att = s.attach(0);
        tokio::time::advance(detached_grace() * 2).await;
        assert!(!reap_session(&s).await, "an attached session is never reaped for detaching");
        drop(att);
        assert!(!s.is_attached() && s.alive(), "detaching leaves the shell running");
        tokio::time::advance(detached_grace() - Duration::from_secs(1)).await;
        assert!(!reap_session(&s).await);
        // Reattaching restarts the clock.
        drop(s.attach(0));
        tokio::time::advance(detached_grace() - Duration::from_secs(1)).await;
        assert!(!reap_session(&s).await);
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(reap_reason(&s), Some("detached"));
        assert!(reap_session(&s).await);
        assert!(get_session(&s.session_id).is_none());
        assert!(!s.alive());
    }

    #[tokio::test]
    async fn echo_roundtrip() {
        if appv3_core::platform::under_wine() {
            // Wine's ConPTY starts the shell (screen clear + title arrive) but
            // never delivers its prompt or reads input. CI covers real Windows.
            eprintln!("echo_roundtrip skipped: Wine ConPTY does not pass shell I/O");
            return;
        }
        // Pin a plain shell: the developer's login shell rc files (e.g. an
        // oh-my-zsh update prompt) can swallow the scripted input. Every
        // test that spawns a shell sets the same value.
        plain_shell();
        // The server's own access token must not reach the user's terminal.
        std::env::set_var("OPENAGENTD_DESKTOP_TOKEN", "oad-leak-canary");
        let d = std::env::temp_dir();
        let s = create_session(&d.display().to_string(), 24, 80).unwrap();
        // The output must differ from the echoed input, so compute the "42".
        let script: &[u8] = match appv3_tools::shell::shell_name_of(&appv3_tools::shell::acceptable()).as_str() {
            "pwsh" | "powershell" => b"'oad_term_' + (40+2) + '[' + $env:OPENAGENTD_DESKTOP_TOKEN + ']'\r\nexit\r\n",
            "cmd" => b"echo oad_term_4^2[%OPENAGENTD_DESKTOP_TOKEN%]\r\nexit\r\n",
            _ => b"echo \"oad_term_$((40+2))[${OPENAGENTD_DESKTOP_TOKEN}]\"\nexit\n",
        };
        s.write(script.to_vec()).await.unwrap();
        let mut out = String::new();
        let att = s.attach(0);
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_secs(20), att.read()).await {
                Ok(Some(c)) => out.push_str(&String::from_utf8_lossy(&c)),
                _ => break,
            }
            if out.contains("oad_term_42") {
                break;
            }
        }
        assert!(out.contains("oad_term_42"), "{out:?}");
        assert!(!out.contains("oad-leak-canary"), "desktop token leaked into the terminal: {out:?}");
        // The prompt is idle: no command in the foreground.
        assert!(!s.busy(), "idle shell read as busy");
        s.close().await;
        assert!(get_session(&s.session_id).is_none());

        // A running command makes the session busy; it reads idle again once
        // the command finishes. Windows has no foreground process group.
        #[cfg(unix)]
        {
            let s = create_session(&d.display().to_string(), 24, 80).unwrap();
            let output = drain(&s);
            s.write(b"sleep 1\n".to_vec()).await.unwrap();
            assert!(wait_for(|| s.busy()).await, "running command not reported busy");
            assert!(wait_for(|| !s.busy()).await, "finished command still reported busy");
            s.close().await;
            output.abort();
        }
    }

    /// Keep reading output so the shell never blocks on a full PTY.
    #[cfg(unix)]
    fn drain(s: &Arc<TerminalSession>) -> tokio::task::JoinHandle<()> {
        let att = s.attach(0);
        tokio::spawn(async move { while att.read().await.is_some() {} })
    }

    #[cfg(unix)]
    async fn wait_for(cond: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }
}
