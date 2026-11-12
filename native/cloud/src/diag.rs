//! Connection diagnostics: the last [`KEPT`] things that happened to an
//! app's bridges and links, in plain words, for the person to copy into a
//! report ("Copy diagnostics" on the phone's Servers screen).
//!
//! Every line is built here from typed events, so nothing secret can get
//! in: a computer is named by its fingerprint (as its row shows it), a
//! direct route says "on your network" without the address, and a refusal
//! code is kept only when it looks like one. Never a key, token, account or
//! session id, IP address, or URL. Memory only.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::account_state::AccountProblem;
use crate::link::{DownReason, LinkState, Route};
use crate::relay::TunnelEnd;

/// Events kept; older ones are dropped.
pub const KEPT: usize = 50;

/// Something that happened to a bridge or a link. `device_id` is the
/// computer's; only its fingerprint is written.
#[derive(Debug, Clone)]
pub enum Event {
    /// The app went to the background.
    AppAway,
    /// The app came back to the front.
    AppBack,
    /// A bridge's self-check, before it was opened again or not.
    BridgeChecked { device_id: String, answering: bool },
    /// A bridge listens again: on the same address, or (`moved`) another.
    BridgeReopened { device_id: String, moved: bool },
    /// A bridge could not listen again.
    BridgeFailed { device_id: String },
    /// A bridge stopped listening for the background.
    BridgePaused { device_id: String },
    /// A bridge and its link were closed.
    BridgeClosed { device_id: String },
    /// What a bridge answered so far.
    BridgeRequests { device_id: String, served: u64, unauthorized: u64, forbidden: u64 },
    /// A link changed state.
    Link { device_id: String, state: LinkState },
    /// A link's session ended.
    SessionEnded { device_id: String, end: TunnelEnd },
    /// The page opened a computer.
    Opened { device_id: String },
    /// The page could not open a computer.
    OpenFailed { device_id: String },
}

/// One line: when (Unix ms; the page writes it in local time) and what.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Line {
    pub at_ms: u64,
    pub text: String,
}

/// The last [`KEPT`] events.
#[derive(Debug, Default)]
pub struct Diagnostics {
    lines: Mutex<VecDeque<Line>>,
}

impl Diagnostics {
    pub fn record(&self, event: Event) {
        let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let line = Line { at_ms, text: text(&event) };
        let mut lines = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        if lines.len() == KEPT {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// Oldest first.
    pub fn lines(&self) -> Vec<Line> {
        self.lines.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }
}

fn computer(device_id: &str) -> String {
    crate::keys::fingerprint(device_id).unwrap_or_else(|| "(unknown computer)".into())
}

/// A refusal code as the relay or the app names it (`host_offline`), or
/// nothing: free text never gets in.
fn code(raw: &str) -> &str {
    let plain = !raw.is_empty() && raw.len() <= 32 && raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if plain {
        raw
    } else {
        "other"
    }
}

fn why(reason: &DownReason) -> String {
    match reason {
        DownReason::HostOffline => "computer offline".into(),
        DownReason::Network => "no connection".into(),
        DownReason::Paused { .. } => "relay allowance used up".into(),
        DownReason::Account(p) => match p {
            AccountProblem::Closing { .. } => "account closing".into(),
            AccountProblem::Unavailable => "account unavailable".into(),
            AccountProblem::Deleted => "account deleted".into(),
            AccountProblem::Revoked => "phone removed".into(),
            AccountProblem::RemovalSignal => "removal to confirm".into(),
        },
        DownReason::Refused(r) => format!("refused: {}", code(r)),
    }
}

fn text(event: &Event) -> String {
    match event {
        Event::AppAway => "app away".into(),
        Event::AppBack => "app back".into(),
        Event::BridgeChecked { device_id, answering } => {
            format!("bridge {}: {}", computer(device_id), if *answering { "answering" } else { "not answering" })
        }
        Event::BridgeReopened { device_id, moved } => {
            format!("bridge {}: reopened on {}", computer(device_id), if *moved { "a new address" } else { "the same address" })
        }
        Event::BridgeFailed { device_id } => format!("bridge {}: could not listen again", computer(device_id)),
        Event::BridgePaused { device_id } => format!("bridge {}: paused", computer(device_id)),
        Event::BridgeClosed { device_id } => format!("bridge {}: closed", computer(device_id)),
        Event::BridgeRequests { device_id, served, unauthorized, forbidden } => {
            let refused = unauthorized + forbidden;
            let detail = if refused > 0 { format!(" (401: {unauthorized}, 403: {forbidden})") } else { String::new() };
            format!("bridge {}: {served} requests, {refused} refused{detail}", computer(device_id))
        }
        Event::Link { device_id, state } => {
            let what = match state {
                LinkState::Connecting => "connecting".to_string(),
                LinkState::Up { route: Route::Direct { .. }, .. } => "up, on your network".into(),
                LinkState::Up { route: Route::Relay, .. } => "up, through your account".into(),
                LinkState::Down { reason, retry_at } => {
                    let next = match retry_at {
                        Some(at) => match at.duration_since(SystemTime::now()) {
                            Ok(d) => format!("retrying in {} s", d.as_secs().max(1)),
                            Err(_) => "retrying now".into(),
                        },
                        None => "waiting for a retry".into(),
                    };
                    format!("down ({}), {next}", why(reason))
                }
            };
            format!("link {}: {what}", computer(device_id))
        }
        Event::SessionEnded { device_id, end } => format!("session {}: ended {end}", computer(device_id)),
        Event::Opened { device_id } => format!("open {}: done", computer(device_id)),
        Event::OpenFailed { device_id } => format!("open {}: failed", computer(device_id)),
    }
}
