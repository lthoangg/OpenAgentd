//! Done / Needs you / Failed on the person's phone (spec section 6): each
//! notification this server raises is sealed to every phone of the account
//! (the signers, in v1) and left in its mailbox. The cloud forwards it as a
//! push it cannot read; the phone's Notification Service Extension opens it.
//!
//! Only the text a local notification shows is sent: the status, the
//! workspace name, this computer's name and the session title, clamped to
//! one line. The name is the one the computer gives for itself
//! (`GET /api/server/name`), after the workspace: a phone hears from every
//! computer of the account, and two of them can have a workspace of the
//! same name.
//!
//! A letter the cloud did not take (no network, a cloud error, rate limited)
//! is retried for [`RETRY_WINDOW`], so a computer that was offline for a
//! moment still tells the phone. Later than that it is old news. Retries
//! keep the order per session: a newer letter for a session replaces an
//! older one still waiting, which could otherwise land after it and replace
//! it on the phone (the cloud keeps one per `collapse` key).
//!
//! The screen first, the phone if unseen: every client open on this server
//! shows a notification at once, and its letter waits [`UNSEEN_GRACE`]
//! ([`Holding`]). A client that shows the session in a focused window, or
//! an answer to its question, reports it seen ([`mark_seen`]); a letter
//! whose session was seen after it was raised is dropped, so the phone does
//! not ring for what the person already read at a desk. Nothing here leaves
//! this server: the cloud learns no more than before.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
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
/// How long a letter waits for its notification to be seen on a screen
/// before it goes to the phone.
pub const UNSEEN_GRACE: Duration = Duration::from_secs(60);
/// A report this much before a notification still counts: the client's
/// report and the server's notification can cross.
pub const SEEN_SLACK: Duration = Duration::from_secs(2);
/// [`UNSEEN_GRACE`] in milliseconds, unless a test set another.
static GRACE_MS: AtomicU64 = AtomicU64::new(UNSEEN_GRACE.as_millis() as u64);

/// The wait in force: [`UNSEEN_GRACE`], or what a test set.
pub fn unseen_grace() -> Duration {
    Duration::from_millis(GRACE_MS.load(Ordering::Relaxed))
}

/// Shortens the wait so an end-to-end test need not sleep a minute.
#[doc(hidden)]
pub fn set_unseen_grace(grace: Duration) {
    GRACE_MS.store(grace.as_millis() as u64, Ordering::Relaxed);
}

/// When each session was last seen on a screen, in the API's (hyphenated)
/// id form. Only the last wait matters, so older entries go.
static SEEN: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Default::default);

fn session_key(session: &str) -> String {
    uuid::Uuid::parse_str(session).map_or_else(|_| session.to_string(), |u| u.hyphenated().to_string())
}

/// The person saw `session` now: on screen in a focused window, opened, or
/// its question answered, on any client of this server.
pub fn mark_seen(session: &str) {
    let now = Instant::now();
    let Ok(mut seen) = SEEN.lock() else { return };
    let keep = unseen_grace() + SEEN_SLACK;
    seen.retain(|_, at| now.duration_since(*at) <= keep);
    seen.insert(session_key(session), now);
}

/// When `session` was last seen, within the last wait.
pub(crate) fn seen_at(session: &str) -> Option<Instant> {
    SEEN.lock().ok()?.get(&session_key(session)).copied()
}

/// Whether a letter raised at `raised_at` still goes to the phone: nobody
/// saw its session since (less [`SEEN_SLACK`]). A letter with no session
/// cannot be seen.
pub fn unseen(seen_at: Option<Instant>, raised_at: Instant) -> bool {
    seen_at.is_none_or(|at| at + SEEN_SLACK < raised_at)
}

struct Held {
    letter: Letter,
    session: Option<String>,
    raised_at: Instant,
    due: Instant,
}

/// Letters waiting [`unseen_grace`] for their notification to be seen.
#[derive(Default)]
pub struct Holding {
    held: Vec<Held>,
}

impl Holding {
    /// Holds `letter`, raised at `now`. A newer letter for the same phone
    /// and session replaces the one held, and waits from its own start.
    pub fn hold(&mut self, letter: Letter, session: Option<String>, now: Instant) {
        if letter.collapse.is_some() {
            self.held.retain(|h| !(h.letter.to == letter.to && h.letter.collapse == letter.collapse));
        }
        self.held.push(Held { letter, session, raised_at: now, due: now + unseen_grace() });
        if self.held.len() > OUTBOX_MAX {
            self.held.remove(0);
        }
    }

    pub fn next_due(&self) -> Option<Instant> {
        self.held.iter().map(|h| h.due).min()
    }

    /// The letters whose wait ended at `now` and whose session nobody saw
    /// (`seen_at`), oldest first. Seen ones are dropped.
    pub fn take_due(&mut self, now: Instant, seen_at: impl Fn(&str) -> Option<Instant>) -> Vec<Letter> {
        let (due, later): (Vec<_>, Vec<_>) = std::mem::take(&mut self.held).into_iter().partition(|h| h.due <= now);
        self.held = later;
        let mut out = vec![];
        for h in due {
            if unseen(h.session.as_deref().and_then(&seen_at), h.raised_at) {
                out.push(h.letter);
            } else {
                tracing::info!("cloud_letter_dropped reason=seen");
            }
        }
        out
    }

    /// Every letter held, for a host that stops: better early than lost.
    pub fn drain(&mut self) -> Vec<Letter> {
        std::mem::take(&mut self.held).into_iter().map(|h| h.letter).collect()
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

/// The kind of a `desktop_notification` payload, or `None` to skip it.
/// A turn that failed, or a goal that is blocked, is `Failed`; the payload's
/// `outcome` says so (`appv3_agent::notification::outcome`).
pub fn kind_of(payload: &Value) -> Option<Kind> {
    match payload["kind"].as_str()? {
        "input_needed" => Some(Kind::NeedsYou),
        "assistant_done" => match payload["outcome"].as_str() {
            Some("failed" | "goal_blocked") => Some(Kind::Failed),
            _ => Some(Kind::Done),
        },
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

/// Longest title, in characters.
const TITLE_MAX_CHARS: usize = 120;

/// The payload's title followed by this computer's `name`
/// ("Done · api · studio-mini"). A long title is cut before the name, which
/// is short (40 characters at most), so the name is always there.
fn title_of(payload: &Value, name: Option<&str>) -> String {
    let title = payload["title"].as_str().unwrap_or("OpenAgentd");
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        return clamp(title, TITLE_MAX_CHARS);
    };
    let suffix = format!(" · {name}");
    let room = TITLE_MAX_CHARS.saturating_sub(suffix.chars().count());
    if room < 2 {
        return clamp(title, TITLE_MAX_CHARS);
    }
    format!("{}{suffix}", clamp(title, room))
}

/// `J` for a notification payload, with this computer's `name` after the
/// title; long text is cut so it fits a letter.
pub fn text_of(payload: &Value, name: Option<&str>, now_ms: u64) -> Text {
    let session = payload["session_id"].as_str().filter(|s| collapse_ok(s)).map(str::to_string);
    let mut t = Text { v: 1, title: title_of(payload, name), body: clamp(payload["body"].as_str().unwrap_or(""), 600), session, at: now_ms };
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
    let mut holding = Holding::default();
    loop {
        let wake = [outbox.next_due(), holding.next_due()].into_iter().flatten().min();
        let payload = tokio::select! {
            payload = tap.recv() => match payload {
                Some(p) => p,
                None => {
                    for letter in holding.drain() {
                        outbox.supersede(&letter);
                        deliver(&cloud, &mut outbox, letter, Instant::now(), None).await;
                    }
                    return;
                }
            },
            _ = async { tokio::time::sleep_until(wake.unwrap_or_else(Instant::now)).await }, if wake.is_some() => {
                let now = Instant::now();
                for (letter, first_try, delay) in outbox.take_due(now) {
                    deliver(&cloud, &mut outbox, letter, first_try, Some(delay)).await;
                }
                for letter in holding.take_due(now, seen_at) {
                    outbox.supersede(&letter);
                    deliver(&cloud, &mut outbox, letter, Instant::now(), None).await;
                }
                continue;
            }
        };
        let Some(kind) = kind_of(&payload) else { continue };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        // Read per notification: the computer can be renamed at any time.
        let text = text_of(&payload, crate::routes::server_name::current_name().as_deref(), now);
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
            holding.hold(letter, text.session.clone(), Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notifications_map_to_letter_kinds() {
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Done · api", "outcome": "done"})), Some(Kind::Done));
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Failed · api", "outcome": "failed"})), Some(Kind::Failed));
        // A goal that cannot go on is a failure to the phone; one that ended or paused is not.
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Goal blocked · api", "outcome": "goal_blocked"})), Some(Kind::Failed));
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Goal achieved · api", "outcome": "goal_achieved"})), Some(Kind::Done));
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Goal paused · api", "outcome": "goal_paused"})), Some(Kind::Done));
        assert_eq!(kind_of(&json!({"kind": "input_needed", "title": "Needs you · api"})), Some(Kind::NeedsYou));
        assert_eq!(kind_of(&json!({"kind": "something_else"})), None);
    }

    #[test]
    fn text_fits_the_largest_letter() {
        for long in ["x".repeat(5000), "😀".repeat(5000), "\"".repeat(5000)] {
            let t = text_of(&json!({"title": long, "body": long, "session_id": "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"}), Some(&"😀".repeat(40)), 1);
            let j = serde_json::to_vec(&t).unwrap();
            assert!(j.len() + 2 <= 2048 - 48, "{}", j.len());
            assert_eq!(t.session.as_deref(), Some("0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"));
            let keys = openagentd_cloud::keys::DeviceKeys::generate();
            let to = openagentd_cloud::keys::DeviceKeys::generate();
            let ctx = Context { account_id: "a", sender_id: "s", recipient_id: "r", kind: Kind::Done };
            assert!(letter::seal(&keys.r#box, &to.r#box.public(), &ctx, &t).is_ok());
        }
        let t = text_of(&json!({"title": "Done", "session_id": "not a collapse key!"}), None, 1);
        assert_eq!(t.session, None);
    }

    // A phone hears from every computer of the account: the title says which.
    #[test]
    fn the_title_ends_with_this_computers_name() {
        let t = text_of(&json!({"title": "Needs you · api", "body": "Keep v1?"}), Some("studio-mini"), 1);
        assert_eq!(t.title, "Needs you · api · studio-mini");
        assert_eq!(t.body, "Keep v1?");
        let t = text_of(&json!({"title": "Needs you"}), Some("studio-mini"), 1);
        assert_eq!(t.title, "Needs you · studio-mini", "no workspace");
        for unnamed in [None, Some(""), Some("  ")] {
            assert_eq!(text_of(&json!({"title": "Done · api"}), unnamed, 1).title, "Done · api", "a computer with no name adds nothing");
        }
    }

    #[test]
    fn a_long_title_is_cut_before_the_computers_name() {
        let workspace = "w".repeat(300);
        let t = text_of(&json!({"title": format!("Failed · {workspace}")}), Some("studio-mini"), 1);
        assert_eq!(t.title.chars().count(), 120);
        assert!(t.title.starts_with("Failed · www"), "{}", t.title);
        assert!(t.title.ends_with("… · studio-mini"), "{}", t.title);
    }

    #[test]
    fn the_kind_is_the_outcome_the_server_raised_whatever_the_words_around_it() {
        let payload = json!({"kind": "assistant_done", "title": "Failed · api", "outcome": "failed"});
        assert_eq!(kind_of(&payload), Some(Kind::Failed));
        assert_eq!(text_of(&payload, Some("Done"), 1).title, "Failed · api · Done", "a name cannot change the kind");
        // A workspace called "Failed", or new wording, cannot change it either.
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Failed to launch · api", "outcome": "done"})), Some(Kind::Done));
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

    fn sealed(letters: Vec<Letter>) -> Vec<u8> {
        letters.into_iter().map(|l| l.sealed[0]).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn a_letter_waits_a_minute_then_goes_unless_its_session_was_seen() {
        let mut holding = Holding::default();
        let start = Instant::now();
        holding.hold(letter("phone", "c1", 1), Some("s1".into()), start);
        holding.hold(letter("phone", "c2", 2), Some("s2".into()), start);
        holding.hold(letter("phone", "c3", 3), None, start);
        assert_eq!(holding.next_due(), Some(start + UNSEEN_GRACE));
        // Nothing goes before the minute is over.
        assert!(holding.take_due(start + UNSEEN_GRACE - Duration::from_secs(1), |_| None).is_empty());
        assert_eq!(holding.len(), 3);
        // s1 was seen during the wait; s2 only before it was raised; c3 has no session.
        let seen = |s: &str| match s {
            "s1" => Some(start + Duration::from_secs(20)),
            "s2" => Some(start - Duration::from_secs(5)),
            _ => None,
        };
        assert_eq!(sealed(holding.take_due(start + UNSEEN_GRACE, seen)), [2, 3]);
        assert!(holding.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_newer_letter_for_the_session_replaces_the_held_one_and_waits_anew() {
        let mut holding = Holding::default();
        let start = Instant::now();
        holding.hold(letter("phone", "c1", 1), Some("s1".into()), start);
        holding.hold(letter("tablet", "c1", 2), Some("s1".into()), start);
        let later = start + Duration::from_secs(30);
        holding.hold(letter("phone", "c1", 3), Some("s1".into()), later);
        assert_eq!(sealed(holding.take_due(start + UNSEEN_GRACE, |_| None)), [2]);
        assert_eq!(holding.next_due(), Some(later + UNSEEN_GRACE));
        assert_eq!(sealed(holding.take_due(later + UNSEEN_GRACE, |_| None)), [3]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stopping_host_sends_what_it_holds() {
        let mut holding = Holding::default();
        holding.hold(letter("phone", "c1", 1), Some("s1".into()), Instant::now());
        assert_eq!(sealed(holding.drain()), [1]);
        assert!(holding.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn seen_is_kept_per_session_in_either_id_form() {
        let raised = Instant::now();
        tokio::time::advance(Duration::from_secs(1)).await;
        mark_seen("0192f5a0b1c27d3e8f40a1b2c3d4e5f6");
        let at = seen_at("0192f5a0-b1c2-7d3e-8f40-a1b2c3d4e5f6");
        assert!(at.is_some(), "the stored (hex) form and the API form are one session");
        assert!(!unseen(at, raised));
        assert!(unseen(None, raised));
        assert!(unseen(seen_at("0192f5a0-0000-7d3e-8f40-a1b2c3d4e5f6"), raised));
        // A report that crossed the notification still counts; an older one does not.
        assert!(!unseen(Some(raised), raised + SEEN_SLACK));
        assert!(unseen(Some(raised), raised + SEEN_SLACK + Duration::from_millis(1)));
    }
}
