//! yamux (version 0, the hashicorp/yamux spec) over a relay session's
//! plaintext, as spec section 5.3 uses it:
//!
//! - the controller opens odd stream ids from 1; the host opens none;
//! - the initial window is 256 KiB, and each side grows its receive window
//!   to 2 MiB with one window update when a stream opens;
//! - no pings are sent (WebSocket pings keep the socket alive), but a ping
//!   is answered; Go Away ends the session.
//!
//! Received data beyond the window we advertised is a protocol error that
//! ends the session, so a peer cannot make us buffer more than
//! [`GROWN_WINDOW`] per stream.
//!
//! What a session sends waits in an [`Outbound`] queue: one queue per
//! stream, taken in turn, so a large transfer does not hold a small request
//! up behind it, and frames without data (opens, window updates, pings, Go
//! Away) ahead of all of them. A stream's FIN and reset stay behind its data.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;

pub const INITIAL_WINDOW: u32 = 256 * 1024;
pub const GROWN_WINDOW: u32 = 2 * 1024 * 1024;
/// Most bytes in one data frame we send.
pub const MAX_FRAME_DATA: usize = 16 * 1024;
/// Most streams open at once on one session.
pub const MAX_STREAMS: usize = 64;

const TYPE_DATA: u8 = 0;
const TYPE_WINDOW: u8 = 1;
const TYPE_PING: u8 = 2;
const TYPE_GO_AWAY: u8 = 3;
const SYN: u16 = 1;
const ACK: u16 = 2;
const FIN: u16 = 4;
const RST: u16 = 8;

/// Why the session ended.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MuxError {
    #[error("yamux protocol error: {0}")]
    Protocol(&'static str),
    #[error("session closed")]
    Closed,
    #[error("too many streams")]
    TooManyStreams,
}

pub fn header(kind: u8, flags: u16, stream: u32, length: u32) -> [u8; 12] {
    let mut h = [0u8; 12];
    h[1] = kind;
    h[2..4].copy_from_slice(&flags.to_be_bytes());
    h[4..8].copy_from_slice(&stream.to_be_bytes());
    h[8..12].copy_from_slice(&length.to_be_bytes());
    h
}

#[derive(Default)]
struct StreamState {
    recv: VecDeque<u8>,
    /// Bytes the peer may still send before it needs a window update.
    recv_window: u32,
    /// Bytes read by the application since our last window update.
    consumed: u32,
    send_window: u32,
    read_waker: Option<Waker>,
    write_waker: Option<Waker>,
    remote_fin: bool,
    local_fin: bool,
    reset: bool,
}

struct State {
    streams: HashMap<u32, StreamState>,
    next_id: u32,
    client: bool,
    buf: Vec<u8>,
    closed: bool,
    accept: VecDeque<u32>,
    /// Whether this side sent Go Away already (it is sent once).
    went_away: bool,
    /// The reason in the Go Away the peer sent, once it did. On a direct
    /// session (spec section 5.5) it carries the close reason.
    peer_go_away: Option<u32>,
}

struct Shared {
    state: Mutex<State>,
    accept_ready: Notify,
    out: Arc<Outbox>,
}

impl Shared {
    fn send(&self, bytes: Vec<u8>) {
        self.out.push(bytes);
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.out.close();
    }
}

#[derive(Default)]
struct OutState {
    /// Frames without data, and Go Away: sent first.
    control: VecDeque<Vec<u8>>,
    /// Each stream's data frames, with its FIN or reset after them.
    streams: HashMap<u32, VecDeque<Vec<u8>>>,
    /// Streams with something queued, in the order they take turns.
    turn: VecDeque<u32>,
    bytes: usize,
    closed: bool,
}

/// The send queue a session's frames wait in.
#[derive(Default)]
struct Outbox {
    state: Mutex<OutState>,
    ready: Notify,
}

impl Outbox {
    fn push(&self, frame: Vec<u8>) {
        let mut st = self.state.lock().expect("outbox lock");
        if st.closed {
            return;
        }
        let flags = u16::from_be_bytes([frame[2], frame[3]]);
        let id = u32::from_be_bytes([frame[4], frame[5], frame[6], frame[7]]);
        let has_data = frame.len() > 12;
        st.bytes += frame.len();
        if id == 0 || (!has_data && flags & (FIN | RST) == 0) {
            st.control.push_back(frame);
        } else {
            let queue = st.streams.entry(id).or_default();
            if queue.is_empty() {
                queue.push_back(frame);
                st.turn.push_back(id);
            } else {
                queue.push_back(frame);
            }
        }
        drop(st);
        self.ready.notify_one();
    }

    fn close(&self) {
        self.state.lock().expect("outbox lock").closed = true;
        self.ready.notify_one();
    }
}

/// Takes up to `max - out.len()` bytes from the front of `queue` into `out`;
/// whether the front frame was taken whole.
fn take_front(queue: &mut VecDeque<Vec<u8>>, out: &mut Vec<u8>, max: usize) -> bool {
    let room = max - out.len();
    let Some(front) = queue.front_mut() else { return true };
    if front.len() <= room {
        out.extend_from_slice(front);
        queue.pop_front();
        true
    } else {
        out.extend_from_slice(&front[..room]);
        front.drain(..room);
        false
    }
}

/// The bytes a session wants sent, in fair order (see the module docs).
pub struct Outbound {
    outbox: Arc<Outbox>,
}

impl Outbound {
    /// Bytes waiting.
    pub fn queued(&self) -> usize {
        self.outbox.state.lock().expect("outbox lock").bytes
    }

    /// Whether the session is gone and nothing is left to send.
    pub fn is_done(&self) -> bool {
        let st = self.outbox.state.lock().expect("outbox lock");
        st.closed && st.bytes == 0
    }

    /// Up to `max` bytes: frames without data first, then one frame from
    /// each stream in turn. A frame may be split; the rest goes next.
    pub fn take(&self, max: usize) -> Vec<u8> {
        let mut st = self.outbox.state.lock().expect("outbox lock");
        let mut out = Vec::with_capacity(st.bytes.min(max));
        while out.len() < max && !st.control.is_empty() {
            take_front(&mut st.control, &mut out, max);
        }
        while out.len() < max {
            let Some(id) = st.turn.pop_front() else { break };
            let st = &mut *st;
            let queue = st.streams.get_mut(&id).expect("a queued stream");
            take_front(queue, &mut out, max);
            if queue.is_empty() {
                st.streams.remove(&id);
            } else {
                st.turn.push_back(id);
            }
        }
        st.bytes -= out.len();
        out
    }

    /// Waits until something is queued, or the session is done.
    pub async fn ready(&self) {
        loop {
            let notified = self.outbox.ready.notified();
            {
                let st = self.outbox.state.lock().expect("outbox lock");
                if st.bytes > 0 || st.closed {
                    return;
                }
            }
            notified.await;
        }
    }

    /// Waits for the next push (or the end): wakes a sender that keeps
    /// joining, to see whether a full message waits now.
    pub async fn pushed(&self) {
        self.outbox.ready.notified().await;
    }

    /// Everything queued, once there is something; `None` once the session
    /// is done.
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        self.ready().await;
        if self.is_done() {
            return None;
        }
        Some(self.take(usize::MAX))
    }
}

/// One yamux session. Feed received plaintext to [`Session::receive`];
/// send what comes out of the receiver returned by [`Session::new`].
#[derive(Clone)]
pub struct Session {
    shared: Arc<Shared>,
}

impl Session {
    /// `client`: the controller (odd ids). Returns the session and the
    /// queue of the bytes it wants sent.
    pub fn new(client: bool) -> (Session, Outbound) {
        let outbox = Arc::new(Outbox::default());
        let state = State {
            streams: HashMap::new(),
            next_id: if client { 1 } else { 2 },
            client,
            buf: Vec::new(),
            closed: false,
            accept: VecDeque::new(),
            went_away: false,
            peer_go_away: None,
        };
        (Session { shared: Arc::new(Shared { state: Mutex::new(state), accept_ready: Notify::new(), out: outbox.clone() }) }, Outbound { outbox })
    }

    fn new_stream(window_grown: bool) -> StreamState {
        StreamState { recv_window: if window_grown { GROWN_WINDOW } else { INITIAL_WINDOW }, send_window: INITIAL_WINDOW, ..Default::default() }
    }

    /// Opens a stream (controller only, spec section 5.3).
    pub fn open(&self) -> Result<Stream, MuxError> {
        let mut st = self.shared.state.lock().expect("mux lock");
        if st.closed {
            return Err(MuxError::Closed);
        }
        if !st.client {
            return Err(MuxError::Protocol("the host opens no streams"));
        }
        if st.streams.len() >= MAX_STREAMS {
            return Err(MuxError::TooManyStreams);
        }
        let id = st.next_id;
        st.next_id = st.next_id.checked_add(2).ok_or(MuxError::TooManyStreams)?;
        st.streams.insert(id, Self::new_stream(true));
        drop(st);
        // SYN, and the one window update that grows our receive window.
        self.shared.send(header(TYPE_WINDOW, SYN, id, GROWN_WINDOW - INITIAL_WINDOW).to_vec());
        Ok(Stream { id, shared: self.shared.clone(), closed: false })
    }

    /// The next stream the peer opened, or `None` once the session ends.
    pub async fn accept(&self) -> Option<Stream> {
        loop {
            let notified = self.shared.accept_ready.notified();
            {
                let mut st = self.shared.state.lock().expect("mux lock");
                if let Some(id) = st.accept.pop_front() {
                    return Some(Stream { id, shared: self.shared.clone(), closed: false });
                }
                if st.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    /// Go Away: we will open no more streams (normal termination).
    pub fn go_away(&self) {
        self.go_away_with(0);
    }

    /// Go Away carrying `reason` in its length field (spec section 5.5),
    /// once: a later call sends nothing.
    pub fn go_away_with(&self, reason: u32) {
        let mut st = self.shared.state.lock().expect("mux lock");
        if st.went_away {
            return;
        }
        st.went_away = true;
        drop(st);
        self.shared.send(header(TYPE_GO_AWAY, 0, 0, reason).to_vec());
    }

    /// The reason of the Go Away the peer sent, if it sent one.
    pub fn peer_go_away(&self) -> Option<u32> {
        self.shared.state.lock().expect("mux lock").peer_go_away
    }

    /// A ping (SYN) carrying `value`; the peer answers with an ACK.
    pub fn ping(&self, value: u32) {
        self.shared.send(header(TYPE_PING, SYN, 0, value).to_vec());
    }

    /// Ends the session: every stream sees an error.
    pub fn close(&self) {
        let mut st = self.shared.state.lock().expect("mux lock");
        st.closed = true;
        for s in st.streams.values_mut() {
            s.reset = true;
            if let Some(w) = s.read_waker.take() {
                w.wake();
            }
            if let Some(w) = s.write_waker.take() {
                w.wake();
            }
        }
        drop(st);
        self.shared.accept_ready.notify_waiters();
    }

    pub fn is_closed(&self) -> bool {
        self.shared.state.lock().expect("mux lock").closed
    }

    /// Streams currently open.
    pub fn open_streams(&self) -> usize {
        self.shared.state.lock().expect("mux lock").streams.len()
    }

    /// Feeds received plaintext. An error means the session must close.
    pub fn receive(&self, bytes: &[u8]) -> Result<(), MuxError> {
        let mut st = self.shared.state.lock().expect("mux lock");
        if st.closed {
            return Err(MuxError::Closed);
        }
        st.buf.extend_from_slice(bytes);
        let mut at = 0;
        let mut outcome = Ok(());
        loop {
            let rest = &st.buf[at..];
            if rest.len() < 12 {
                break;
            }
            if rest[0] != 0 {
                outcome = Err(MuxError::Protocol("yamux version"));
                break;
            }
            let kind = rest[1];
            let flags = u16::from_be_bytes([rest[2], rest[3]]);
            let id = u32::from_be_bytes([rest[4], rest[5], rest[6], rest[7]]);
            let length = u32::from_be_bytes([rest[8], rest[9], rest[10], rest[11]]);
            let body_len = if kind == TYPE_DATA { length as usize } else { 0 };
            if body_len > GROWN_WINDOW as usize {
                outcome = Err(MuxError::Protocol("data frame larger than any window"));
                break;
            }
            if rest.len() < 12 + body_len {
                break;
            }
            let body = rest[12..12 + body_len].to_vec();
            at += 12 + body_len;
            if let Err(e) = self.frame(&mut st, kind, flags, id, length, body) {
                outcome = Err(e);
                break;
            }
        }
        st.buf.drain(..at);
        drop(st);
        if outcome.is_err() {
            self.close();
        }
        outcome
    }

    fn frame(&self, st: &mut State, kind: u8, flags: u16, id: u32, length: u32, body: Vec<u8>) -> Result<(), MuxError> {
        match kind {
            TYPE_PING => {
                if flags & SYN != 0 {
                    self.shared.send(header(TYPE_PING, ACK, 0, length).to_vec());
                }
                return Ok(());
            }
            TYPE_GO_AWAY => {
                st.closed = true;
                st.peer_go_away.get_or_insert(length);
                for s in st.streams.values_mut() {
                    s.reset = true;
                    if let Some(w) = s.read_waker.take() {
                        w.wake();
                    }
                    if let Some(w) = s.write_waker.take() {
                        w.wake();
                    }
                }
                self.shared.accept_ready.notify_waiters();
                return Ok(());
            }
            TYPE_DATA | TYPE_WINDOW => {}
            _ => return Err(MuxError::Protocol("unknown frame type")),
        }
        if id == 0 {
            return Err(MuxError::Protocol("stream 0"));
        }
        if flags & SYN != 0 && !st.streams.contains_key(&id) {
            // Only the controller opens streams, with odd ids.
            if st.client || id % 2 == 0 {
                return Err(MuxError::Protocol("unexpected stream open"));
            }
            if st.streams.len() >= MAX_STREAMS {
                self.shared.send(header(TYPE_WINDOW, RST, id, 0).to_vec());
                return Ok(());
            }
            st.streams.insert(id, Self::new_stream(true));
            st.accept.push_back(id);
            self.shared.send(header(TYPE_WINDOW, ACK, id, GROWN_WINDOW - INITIAL_WINDOW).to_vec());
            self.shared.accept_ready.notify_one();
        }
        let Some(s) = st.streams.get_mut(&id) else {
            // A frame for a stream that is gone (late data after a reset).
            return Ok(());
        };
        if kind == TYPE_WINDOW {
            s.send_window = s.send_window.saturating_add(length);
            if let Some(w) = s.write_waker.take() {
                w.wake();
            }
        } else if !body.is_empty() {
            if s.remote_fin {
                return Err(MuxError::Protocol("data after FIN"));
            }
            if body.len() as u32 > s.recv_window {
                return Err(MuxError::Protocol("receive window exceeded"));
            }
            s.recv_window -= body.len() as u32;
            s.recv.extend(body);
            if let Some(w) = s.read_waker.take() {
                w.wake();
            }
        }
        if flags & RST != 0 {
            s.reset = true;
            if let Some(w) = s.read_waker.take() {
                w.wake();
            }
            if let Some(w) = s.write_waker.take() {
                w.wake();
            }
            // Kept until the Stream is dropped, so data that arrived with
            // the reset is still read before the error.
        } else if flags & FIN != 0 {
            s.remote_fin = true;
            if let Some(w) = s.read_waker.take() {
                w.wake();
            }
            if s.local_fin && s.recv.is_empty() {
                st.streams.remove(&id);
            }
        }
        Ok(())
    }
}

/// One stream: one HTTP exchange (spec section 5.4).
pub struct Stream {
    id: u32,
    shared: Arc<Shared>,
    closed: bool,
}

impl Stream {
    pub fn id(&self) -> u32 {
        self.id
    }
}

impl std::fmt::Debug for Stream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Stream({})", self.id)
    }
}

fn reset_err() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionReset, "relay stream reset")
}

impl AsyncRead for Stream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let mut st = self.shared.state.lock().expect("mux lock");
        let id = self.id;
        let Some(s) = st.streams.get_mut(&id) else {
            return Poll::Ready(Ok(())); // removed after both FINs: EOF
        };
        if !s.recv.is_empty() {
            let n = buf.remaining().min(s.recv.len());
            let (a, b) = s.recv.as_slices();
            let from_a = n.min(a.len());
            buf.put_slice(&a[..from_a]);
            buf.put_slice(&b[..n - from_a]);
            s.recv.drain(..n);
            s.consumed += n as u32;
            // Give credit back once half the grown window is consumed.
            if s.consumed >= GROWN_WINDOW / 2 && !s.remote_fin {
                let credit = s.consumed;
                s.recv_window += credit;
                s.consumed = 0;
                self.shared.out.push(header(TYPE_WINDOW, 0, id, credit).to_vec());
            }
            return Poll::Ready(Ok(()));
        }
        if s.reset {
            return Poll::Ready(Err(reset_err()));
        }
        if s.remote_fin {
            if s.local_fin {
                st.streams.remove(&id);
            }
            return Poll::Ready(Ok(()));
        }
        s.read_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl AsyncWrite for Stream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        let mut st = self.shared.state.lock().expect("mux lock");
        let Some(s) = st.streams.get_mut(&self.id) else { return Poll::Ready(Err(reset_err())) };
        if s.reset {
            return Poll::Ready(Err(reset_err()));
        }
        if s.local_fin {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "relay stream closed")));
        }
        if s.send_window == 0 {
            s.write_waker = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let n = data.len().min(s.send_window as usize).min(MAX_FRAME_DATA);
        s.send_window -= n as u32;
        let mut frame = header(TYPE_DATA, 0, self.id, n as u32).to_vec();
        frame.extend_from_slice(&data[..n]);
        self.shared.out.push(frame);
        Poll::Ready(Ok(n))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let id = self.id;
        let mut st = self.shared.state.lock().expect("mux lock");
        if let Some(s) = st.streams.get_mut(&id) {
            if !s.local_fin && !s.reset {
                s.local_fin = true;
                self.shared.out.push(header(TYPE_WINDOW, FIN, id, 0).to_vec());
            }
            if s.remote_fin && s.recv.is_empty() {
                st.streams.remove(&id);
            }
        }
        drop(st);
        self.closed = true;
        Poll::Ready(Ok(()))
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let Ok(mut st) = self.shared.state.lock() else { return };
        if let Some(s) = st.streams.remove(&self.id) {
            // Dropped before we finished writing: reset it. The host, after
            // its FIN, has answered: a reset could race the controller's
            // reading of that answer, so late frames are just dropped. A
            // controller that drops a stream before the host finished no
            // longer wants the rest (a closed event stream): reset it, or
            // the host's writer would wait on a window that never reopens.
            let abandoned = !s.local_fin || (st.client && !s.remote_fin);
            if abandoned && !s.reset && !st.closed {
                self.shared.out.push(header(TYPE_WINDOW, RST, self.id, 0).to_vec());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Two sessions wired back to back.
    fn pair() -> (Session, Session) {
        let (a, mut a_out) = Session::new(true);
        let (b, mut b_out) = Session::new(false);
        let (a2, b2) = (a.clone(), b.clone());
        tokio::spawn(async move {
            while let Some(bytes) = a_out.recv().await {
                if b2.receive(&bytes).is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(bytes) = b_out.recv().await {
                if a2.receive(&bytes).is_err() {
                    break;
                }
            }
        });
        (a, b)
    }

    #[tokio::test]
    async fn an_exchange_with_fin_both_ways_and_more_than_a_window() {
        let (ctl, host) = pair();
        let server = tokio::spawn(async move {
            let mut s = host.accept().await.unwrap();
            let mut got = Vec::new();
            s.read_to_end(&mut got).await.unwrap();
            s.write_all(&got).await.unwrap();
            s.shutdown().await.unwrap();
            got.len()
        });
        let mut s = ctl.open().unwrap();
        let big = vec![7u8; 5 * 1024 * 1024];
        let (mut r, mut w) = tokio::io::split(&mut s);
        let writer = async {
            w.write_all(&big).await.unwrap();
            w.shutdown().await.unwrap();
        };
        let mut back = Vec::new();
        let reader = r.read_to_end(&mut back);
        let (_, n) = tokio::join!(writer, reader);
        n.unwrap();
        assert_eq!(server.await.unwrap(), big.len());
        assert_eq!(back, big);
    }

    #[tokio::test]
    async fn a_controller_that_stops_reading_resets_the_host_writer() {
        let (ctl, host) = pair();
        let mut s = ctl.open().unwrap();
        s.write_all(b"GET /api/events").await.unwrap();
        s.shutdown().await.unwrap();
        let mut h = host.accept().await.unwrap();
        let mut req = Vec::new();
        h.read_to_end(&mut req).await.unwrap();
        // The page closed its event stream: the controller drops the stream.
        drop(s);
        // The host's endless writer fails instead of waiting forever.
        let writer = async {
            loop {
                h.write_all(&[1u8; 16 * 1024]).await?;
            }
            #[allow(unreachable_code)]
            Ok::<(), std::io::Error>(())
        };
        let r = tokio::time::timeout(std::time::Duration::from_secs(5), writer).await.expect("the writer ended");
        assert!(r.is_err());
        drop(h);
        assert_eq!(host.open_streams(), 0);
    }

    #[tokio::test]
    async fn a_host_answer_survives_its_own_drop() {
        let (ctl, host) = pair();
        let mut s = ctl.open().unwrap();
        s.write_all(b"GET /").await.unwrap();
        let server = tokio::spawn(async move {
            let mut h = host.accept().await.unwrap();
            let mut one = [0u8; 3];
            h.read_exact(&mut one).await.unwrap();
            h.write_all(b"answer").await.unwrap();
            h.shutdown().await.unwrap();
            // Dropped before the controller's FIN: no reset follows.
        });
        server.await.unwrap();
        let mut back = Vec::new();
        s.read_to_end(&mut back).await.unwrap();
        assert_eq!(back, b"answer");
    }

    #[tokio::test]
    async fn the_host_cannot_open_streams_and_a_window_overrun_ends_the_session() {
        let (host, _out) = Session::new(false);
        assert!(host.open().is_err());
        // A controller opens stream 1, then sends past the 2 MiB window.
        host.receive(&header(TYPE_WINDOW, SYN, 1, 0)).unwrap();
        let mut frame = header(TYPE_DATA, 0, 1, GROWN_WINDOW).to_vec();
        frame.extend(vec![0u8; GROWN_WINDOW as usize]);
        host.receive(&frame).unwrap();
        let mut more = header(TYPE_DATA, 0, 1, 1).to_vec();
        more.push(0);
        assert!(host.receive(&more).is_err());
        assert!(host.is_closed());
    }

    #[tokio::test]
    async fn even_stream_ids_from_a_controller_are_refused() {
        let (host, _out) = Session::new(false);
        assert!(host.receive(&header(TYPE_WINDOW, SYN, 2, 0)).is_err());
    }

    #[tokio::test]
    async fn frames_split_across_messages_reassemble() {
        let (host, _out) = Session::new(false);
        let mut bytes = header(TYPE_WINDOW, SYN, 1, 0).to_vec();
        bytes.extend(header(TYPE_DATA, FIN, 1, 3));
        bytes.extend(b"abc");
        for b in bytes.chunks(5) {
            host.receive(b).unwrap();
        }
        let mut s = host.accept().await.unwrap();
        let mut got = String::new();
        s.read_to_string(&mut got).await.unwrap();
        assert_eq!(got, "abc");
    }

    /// The stream ids of the data frames in `bytes`, in order.
    fn data_ids(bytes: &[u8]) -> Vec<u32> {
        let mut ids = Vec::new();
        let mut at = 0;
        while at + 12 <= bytes.len() {
            let h = &bytes[at..at + 12];
            let id = u32::from_be_bytes([h[4], h[5], h[6], h[7]]);
            let len = u32::from_be_bytes([h[8], h[9], h[10], h[11]]) as usize;
            if h[1] == TYPE_DATA {
                ids.push(id);
                at += 12 + len;
            } else {
                at += 12;
            }
        }
        ids
    }

    #[tokio::test]
    async fn a_small_request_does_not_wait_behind_a_large_transfer() {
        let (ctl, out) = Session::new(true);
        let mut big = ctl.open().unwrap();
        big.write_all(&vec![1u8; 200 * 1024]).await.unwrap();
        let mut small = ctl.open().unwrap();
        small.write_all(b"GET /api/health").await.unwrap();
        small.shutdown().await.unwrap();
        // One message's worth: both opens first, and the small request is
        // in it although 200 KiB were queued before it.
        let first = out.take(crate::noise::MAX_PLAINTEXT);
        assert_eq!(first[1], TYPE_WINDOW, "an open goes first");
        let ids = data_ids(&first);
        assert!(ids.contains(&3), "{ids:?}");
        assert_eq!(ids.iter().filter(|&&i| i == 3).count(), 1);
        // The rest of the transfer follows, in order, and nothing is lost.
        let mut rest = first.len();
        while out.queued() > 0 {
            rest += out.take(crate::noise::MAX_PLAINTEXT).len();
        }
        let frames = (200 * 1024usize).div_ceil(MAX_FRAME_DATA);
        assert_eq!(rest, 12 * 2 + (200 * 1024 + 12 * frames) + (12 + 15) + 12);
    }

    #[tokio::test]
    async fn a_streams_fin_stays_behind_its_data() {
        let (ctl, out) = Session::new(true);
        let mut s = ctl.open().unwrap();
        s.write_all(&vec![2u8; 40 * 1024]).await.unwrap();
        s.shutdown().await.unwrap();
        let all = out.take(usize::MAX);
        // The open, three data frames, then the FIN last.
        let fin = &all[all.len() - 12..];
        assert_eq!(u16::from_be_bytes([fin[2], fin[3]]), FIN);
        assert_eq!(data_ids(&all), vec![1, 1, 1]);
    }

    /// Reads what the peer has for `stream` now, without waiting for more.
    async fn read_now(s: &mut Stream) -> Vec<u8> {
        use futures_util::FutureExt;
        let mut got = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        while let Some(Ok(n)) = s.read(&mut buf).now_or_never() {
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n]);
        }
        got
    }

    #[tokio::test]
    async fn the_rest_of_a_split_frame_goes_out_before_a_new_stream_opens() {
        let (ctl, out) = Session::new(true);
        let (host, _host_out) = Session::new(false);
        let big: Vec<u8> = (0..200 * 1024).map(|i| (i % 251) as u8).collect();
        let mut first = ctl.open().unwrap();
        first.write_all(&big).await.unwrap();
        first.shutdown().await.unwrap();
        // One message: the open and three frames, and the fourth split.
        let message = out.take(crate::noise::MAX_PLAINTEXT);
        assert_eq!(message.len(), crate::noise::MAX_PLAINTEXT);
        host.receive(&message).unwrap();
        // A second request opens while the rest of that frame waits.
        let mut second = ctl.open().unwrap();
        second.write_all(b"GET /api/health").await.unwrap();
        second.shutdown().await.unwrap();
        while out.queued() > 0 {
            host.receive(&out.take(crate::noise::MAX_PLAINTEXT)).expect("no protocol error");
        }
        let mut a = host.accept().await.unwrap();
        let mut b = host.accept().await.unwrap();
        assert_eq!(read_now(&mut a).await, big);
        assert_eq!(read_now(&mut b).await, b"GET /api/health");
    }

    /// A small deterministic generator (xorshift64*).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[tokio::test]
    async fn any_mix_of_writes_opens_and_control_frames_arrives_unchanged() {
        for seed in 1..=40u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let (ctl, out) = Session::new(true);
            let (host, host_out) = Session::new(false);
            let mut streams: Vec<(Stream, Vec<u8>)> = Vec::new();
            let mut accepted: Vec<(u32, Stream)> = Vec::new();
            let mut got: HashMap<u32, Vec<u8>> = HashMap::new();
            for _ in 0..60 {
                // Between takes: opens, writes on any stream, pings, and
                // the peer's own frames (acks, window updates) coming back.
                for _ in 0..rng.below(4) {
                    match rng.below(4) {
                        0 if streams.len() < 8 => streams.push((ctl.open().unwrap(), Vec::new())),
                        1 => ctl.ping(rng.below(1000) as u32),
                        _ if !streams.is_empty() => {
                            let i = rng.below(streams.len() as u64) as usize;
                            let (s, sent) = &mut streams[i];
                            if sent.len() < 200 * 1024 {
                                let n = 1 + rng.below(40 * 1024) as usize;
                                let data: Vec<u8> = (0..n).map(|_| rng.below(256) as u8).collect();
                                s.write_all(&data).await.unwrap();
                                sent.extend_from_slice(&data);
                            }
                        }
                        _ => {}
                    }
                }
                let max = 1 + rng.below(70_000) as usize;
                let bytes = out.take(max);
                assert!(bytes.len() <= max);
                host.receive(&bytes).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
                ctl.receive(&host_out.take(usize::MAX)).unwrap();
                while let Some(Some(s)) = futures_util::FutureExt::now_or_never(host.accept()) {
                    accepted.push((s.id(), s));
                }
                for (id, s) in accepted.iter_mut() {
                    let more = read_now(s).await;
                    got.entry(*id).or_default().extend(more);
                }
            }
            while out.queued() > 0 {
                host.receive(&out.take(1 + rng.below(70_000) as usize)).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
            }
            while let Some(Some(s)) = futures_util::FutureExt::now_or_never(host.accept()) {
                accepted.push((s.id(), s));
            }
            for (id, s) in accepted.iter_mut() {
                let more = read_now(s).await;
                got.entry(*id).or_default().extend(more);
            }
            for (s, sent) in &streams {
                assert_eq!(got.get(&s.id()).map(Vec::len).unwrap_or(0), sent.len(), "seed {seed}, stream {}", s.id());
                assert!(got.get(&s.id()).map(|g| g == sent).unwrap_or(sent.is_empty()), "seed {seed}, stream {}", s.id());
            }
        }
    }
}
