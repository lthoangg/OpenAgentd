//! Done / Needs you / Failed on the person's phone (spec section 6): each
//! notification this server raises is sealed to every phone of the account
//! (the signers, in v1) and left in its mailbox. The cloud forwards it as a
//! push it cannot read; the phone's Notification Service Extension opens it.
//!
//! Only the text a local notification shows is sent: the status, the
//! workspace name and the session title, clamped to one line.
//!
//! A letter the cloud did not take (no network, a cloud error, rate limited)
//! is retried for [`RETRY_WINDOW`], so a computer that was offline for a
//! moment still tells the phone. Later than that it is old news. Retries
//! keep the order per session: a newer letter for a session replaces an
//! older one still waiting, which could otherwise land after it and replace
//! it on the phone (the cloud keeps one per `collapse` key).

use std::sync::{Arc, RwLock};
use std::time::Duration;

use openagentd_cloud::api::{ApiError, Cloud};
use openagentd_cloud::letter::{self, Context, Kind, Text};
use openagentd_cloud::roster::Roster;
use serde_json::Value;
use tokio::time::Instant;

/// How long a letter the cloud did not take is retried.
pub const RETRY_WINDOW: Duration = Duration::from_secs(10 * 60);
/// First retry delay; it doubles up to [`RETRY_MAX_DELAY`].
const RETRY_FIRST_DELAY: Duration = Duration::from_secs(5);
const RETRY_MAX_DELAY: Duration = Duration::from_secs(60);
/// Letters waiting at most; the oldest goes first.
const OUTBOX_MAX: usize = 64;

/// The kind of a `desktop_notification` payload, or `None` to skip it.
pub fn kind_of(payload: &Value) -> Option<Kind> {
    match payload["kind"].as_str()? {
        "input_needed" => Some(Kind::NeedsYou),
        "assistant_done" if payload["title"].as_str().is_some_and(|t| t.starts_with("Failed")) => Some(Kind::Failed),
        "assistant_done" => Some(Kind::Done),
        _ => None,
    }
}

fn clamp(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// `J` for a notification payload; long text is cut so it fits a letter.
pub fn text_of(payload: &Value, now_ms: u64) -> Text {
    let session = payload["session_id"].as_str().filter(|s| collapse_ok(s)).map(str::to_string);
    let mut t = Text { v: 1, title: clamp(payload["title"].as_str().unwrap_or("OpenAgentd"), 120), body: clamp(payload["body"].as_str().unwrap_or(""), 600), session, at: now_ms };
    // The largest letter holds 1,998 bytes of `J`; wide characters can
    // need more than the character limits allow.
    while serde_json::to_vec(&t).map_or(0, |j| j.len()) > letter::SIZES[3] - 50 {
        let n = t.body.chars().count();
        if n > 1 {
            t.body = clamp(&t.body, n * 3 / 4);
        } else if t.title.chars().count() > 1 {
            t.title = clamp(&t.title, t.title.chars().count() * 3 / 4);
        } else {
            break;
        }
    }
    t
}

/// The `collapse` key the cloud sees: one per session, so a newer
/// notification replaces the older one, without telling the cloud the
/// session id (which stays inside the sealed letter).
pub fn collapse_key(sender: &str, session: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("agentd-collapse-v1\n{sender}\n{session}").as_bytes());
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn collapse_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The phones to tell: the account's signers other than this server.
fn recipients(roster: &Roster, me: &str) -> Vec<(String, [u8; 32])> {
    roster.body.devices.iter().filter(|d| d.signer && d.id != me).map(|d| (d.id.clone(), d.box_key())).collect()
}

/// One sealed letter for one phone.
#[derive(Debug, Clone, PartialEq)]
pub struct Letter {
    pub to: String,
    pub kind: Kind,
    pub sealed: Vec<u8>,
    pub collapse: Option<String>,
}

/// Whether the cloud may take a letter it refused now: a network failure, a
/// cloud error, or rate limiting. Anything else (a removed phone, a bad
/// request) will not change by trying again.
pub fn retryable(e: &ApiError) -> bool {
    e.status == 0 || e.status == 429 || e.status >= 500
}

struct Waiting {
    letter: Letter,
    first_try: Instant,
    next_try: Instant,
    delay: Duration,
}

/// Letters waiting to be sent again.
#[derive(Default)]
pub struct Outbox {
    waiting: Vec<Waiting>,
}

impl Outbox {
    /// A newer letter for the same phone and session is about to go out: the
    /// older one waiting is dropped.
    pub fn supersede(&mut self, letter: &Letter) {
        if letter.collapse.is_some() {
            self.waiting.retain(|w| !(w.letter.to == letter.to && w.letter.collapse == letter.collapse));
        }
    }

    /// `letter` failed at `now` (its first try at `first_try`): keep it for
    /// another try, unless the window is over.
    pub fn failed(&mut self, letter: Letter, first_try: Instant, now: Instant, previous: Option<Duration>, retry_after: Option<Duration>) {
        let delay = previous.map_or(RETRY_FIRST_DELAY, |d| (d * 2).min(RETRY_MAX_DELAY));
        let next_try = now + retry_after.unwrap_or(delay).max(delay);
        if next_try.duration_since(first_try) > RETRY_WINDOW {
            tracing::info!("cloud_letter_given_up");
            return;
        }
        self.supersede(&letter);
        self.waiting.push(Waiting { letter, first_try, next_try, delay });
        if self.waiting.len() > OUTBOX_MAX {
            self.waiting.remove(0);
        }
    }

    /// When the next letter is due, if any.
    pub fn next_due(&self) -> Option<Instant> {
        self.waiting.iter().map(|w| w.next_try).min()
    }

    /// The letters due at `now`, oldest first, with their first try and last
    /// delay; they leave the outbox (a failure puts them back).
    pub fn take_due(&mut self, now: Instant) -> Vec<(Letter, Instant, Duration)> {
        let (due, later): (Vec<_>, Vec<_>) = std::mem::take(&mut self.waiting).into_iter().partition(|w| w.next_try <= now);
        self.waiting = later;
        due.into_iter().map(|w| (w.letter, w.first_try, w.delay)).collect()
    }

    pub fn len(&self) -> usize {
        self.waiting.len()
    }

    pub fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }
}

/// Sends one letter; a failure the cloud may get over goes to `outbox`.
async fn deliver(cloud: &Cloud, outbox: &mut Outbox, letter: Letter, first_try: Instant, previous: Option<Duration>) {
    match cloud.send_letter(&letter.to, letter.kind, &letter.sealed, letter.collapse.as_deref()).await {
        Ok(()) => {
            if previous.is_some() {
                tracing::info!("cloud_letter_sent_after_retry");
            }
        }
        Err(e) if retryable(&e) => {
            tracing::info!("cloud_letter_retry status={} code={}", e.status, e.code);
            outbox.failed(letter, first_try, Instant::now(), previous, e.retry_after.map(Duration::from_secs));
        }
        Err(e) => tracing::info!("cloud_letter_not_sent status={} code={}", e.status, e.code),
    }
}

/// Runs while the host is connected: forwards each notification.
pub async fn run(cloud: Arc<Cloud>, roster: Arc<RwLock<Roster>>) {
    let mut tap = appv3_agent::broadcaster::broadcaster().tap("desktop_notification");
    let mut outbox = Outbox::default();
    loop {
        let wake = outbox.next_due();
        let payload = tokio::select! {
            payload = tap.recv() => match payload {
                Some(p) => p,
                None => return,
            },
            _ = async { tokio::time::sleep_until(wake.unwrap_or_else(Instant::now)).await }, if wake.is_some() => {
                for (letter, first_try, delay) in outbox.take_due(Instant::now()) {
                    deliver(&cloud, &mut outbox, letter, first_try, Some(delay)).await;
                }
                continue;
            }
        };
        let Some(kind) = kind_of(&payload) else { continue };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let text = text_of(&payload, now);
        let (account, to) = {
            let Ok(r) = roster.read() else { continue };
            (r.account_id().to_string(), recipients(&r, &cloud.device_id()))
        };
        let me = cloud.device_id();
        for (id, box_key) in to {
            let ctx = Context { account_id: &account, sender_id: &me, recipient_id: &id, kind };
            let sealed = match letter::seal(&cloud.keys.r#box, &box_key, &ctx, &text) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("cloud_letter_seal_failed error={e}");
                    continue;
                }
            };
            let collapse = text.session.as_deref().map(|s| collapse_key(&me, s));
            let letter = Letter { to: id, kind, sealed, collapse };
            outbox.supersede(&letter);
            deliver(&cloud, &mut outbox, letter, Instant::now(), None).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notifications_map_to_letter_kinds() {
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Done · api"})), Some(Kind::Done));
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Failed · api"})), Some(Kind::Failed));
        assert_eq!(kind_of(&json!({"kind": "input_needed", "title": "Needs you · api"})), Some(Kind::NeedsYou));
        assert_eq!(kind_of(&json!({"kind": "something_else"})), None);
    }

    #[test]
    fn text_fits_the_largest_letter() {
        for long in ["x".repeat(5000), "😀".repeat(5000), "\"".repeat(5000)] {
            let t = text_of(&json!({"title": long, "body": long, "session_id": "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"}), 1);
            let j = serde_json::to_vec(&t).unwrap();
            assert!(j.len() + 2 <= 2048 - 48, "{}", j.len());
            assert_eq!(t.session.as_deref(), Some("0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"));
            let keys = openagentd_cloud::keys::DeviceKeys::generate();
            let to = openagentd_cloud::keys::DeviceKeys::generate();
            let ctx = Context { account_id: "a", sender_id: "s", recipient_id: "r", kind: Kind::Done };
            assert!(letter::seal(&keys.r#box, &to.r#box.public(), &ctx, &t).is_ok());
        }
        let t = text_of(&json!({"title": "Done", "session_id": "not a collapse key!"}), 1);
        assert_eq!(t.session, None);
    }

    #[test]
    fn the_collapse_key_hides_the_session_id() {
        let k = collapse_key("D1", "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10");
        assert_eq!(k.len(), 32);
        assert!(collapse_ok(&k) && !k.contains("0e6c5a0c"));
        assert_eq!(k, collapse_key("D1", "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"));
        assert_ne!(k, collapse_key("D2", "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"));
    }

    fn letter(to: &str, collapse: &str, byte: u8) -> Letter {
        Letter { to: to.into(), kind: Kind::Done, sealed: vec![byte], collapse: Some(collapse.into()) }
    }

    fn err(status: u16, code: &str) -> ApiError {
        ApiError { status, code: code.into(), body: None, retry_after: None }
    }

    #[test]
    fn only_failures_the_cloud_may_get_over_are_retried() {
        assert!(retryable(&err(0, "network")));
        assert!(retryable(&err(503, "unavailable")));
        assert!(retryable(&err(429, "rate_limited")));
        assert!(!retryable(&err(404, "device_not_found")));
        assert!(!retryable(&err(403, "device_revoked")));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_letter_is_retried_with_backoff_until_the_window_ends() {
        let mut outbox = Outbox::default();
        let start = Instant::now();
        outbox.failed(letter("phone", "s1", 1), start, start, None, None);
        assert_eq!(outbox.next_due(), Some(start + RETRY_FIRST_DELAY));
        assert!(outbox.take_due(start + Duration::from_secs(4)).is_empty());

        // Each failure doubles the wait, up to a minute.
        let mut now = start;
        let mut delays = vec![];
        while let Some(due) = outbox.next_due() {
            delays.push(due.duration_since(now).as_secs());
            now = due;
            let mut taken = outbox.take_due(now);
            assert_eq!(taken.len(), 1);
            let (l, first, delay) = taken.remove(0);
            assert_eq!(first, start);
            outbox.failed(l, first, now, Some(delay), None);
        }
        assert_eq!(&delays[..6], [5, 10, 20, 40, 60, 60]);
        // Given up once the next try would be past the window.
        assert!(now.duration_since(start) <= RETRY_WINDOW && now.duration_since(start) + RETRY_MAX_DELAY > RETRY_WINDOW);
        assert!(outbox.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn the_cloud_asking_to_wait_longer_is_honoured() {
        let mut outbox = Outbox::default();
        let start = Instant::now();
        outbox.failed(letter("phone", "s1", 1), start, start, None, Some(Duration::from_secs(30)));
        assert_eq!(outbox.next_due(), Some(start + Duration::from_secs(30)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_newer_letter_for_the_same_session_replaces_the_one_waiting() {
        let mut outbox = Outbox::default();
        let start = Instant::now();
        outbox.failed(letter("phone", "s1", 1), start, start, None, None);
        outbox.failed(letter("phone", "s2", 2), start, start, None, None);
        outbox.failed(letter("tablet", "s1", 3), start, start, None, None);
        // "Done" for s1 goes out to the phone: its waiting "Needs you" must not follow it.
        outbox.supersede(&letter("phone", "s1", 4));
        let left: Vec<u8> = outbox.take_due(start + RETRY_WINDOW).into_iter().map(|(l, _, _)| l.sealed[0]).collect();
        assert_eq!(left, [2, 3]);
    }
}
