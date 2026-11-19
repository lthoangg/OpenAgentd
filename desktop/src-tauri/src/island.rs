// size-ceiling: 2509 — holds settings, geometry and the server feed: give each its own module
//! Agent status island in the MacBook notch (macOS).
//!
//! A borderless black webview (`web/island.html`) sits over the notch, or
//! hangs from the middle of the menu bar on a Mac without one. It shows
//! whether any session is running or waiting on the user, and the sessions
//! that finished since you last looked at them (unread).
//!
//! It covers the builtin while it runs and every server an app window is on
//! (`servers::followed_servers`): windows can each be on a different server,
//! and a session waiting on you matters whichever window it is in. A saved
//! server no window is on is
//! followed only when the user enabled it (Settings → Connection), so its
//! sessions show with no window open, and a click opens a window on it.
//! With more than one server, each row names its server.
//!
//! The island never sees the backend credentials. The Rust process follows
//! each server's global event stream and treats each turn event only as a
//! signal to refetch `GET /api/agent/sessions?active=true`. That list is the
//! source of truth: every top-level session that is running or waiting on
//! the user, the same data the sidebar's "Needs you" list uses. A lead whose
//! turn ended while its subagents (or another workspace) still work for it
//! is listed with `background_work` and counts as running: its work is not
//! finished until their reports have run it again. The island gets a
//! snapshot of all servers over IPC (`island-status`).
//!
//! The window is a fixed transparent canvas over the notch, so the pill can
//! morph inside it with CSS (window resizes can't be animated smoothly). The
//! webview reports the pill's size and whether it has anything to show
//! (`island_fit`); Rust decides whether the canvas is up (the feature is on,
//! the webview has something to show, and OpenAgentd is not frontmost unless
//! the user opted in).
//!
//! WebKit tracks the mouse only in the key window (with overlay scrollbars,
//! the trackpad default), and the island never becomes key so it cannot take
//! focus. So while the canvas is up, Rust polls the pointer: inside the pill
//! the canvas takes clicks and the webview gets the position
//! (`island-pointer`, for hover); outside it, clicks pass through to the
//! menu bar.
//!
//! Unread is the shell's own: a session whose turn completed or failed is
//! kept until you open it. App windows report the session they show
//! (`island_viewing`), so one finishing on screen in the focused window is
//! never unread, and focusing a window clears the one it shows. A turn the
//! user stopped, a background idle compaction, or a turn only agents worked
//! in (`quiet`: another workspace's request) has nothing new to read, the
//! same rules as the sidebar's unread mark. A turn that ends before any list
//! saw it (a failure within moments) is unread from its notification. A
//! session only finishes on its own server: a server that can't be reached
//! shows no rows, but its last list is kept so what finished meanwhile is
//! reported once it is back; one that is no longer followed (its last
//! window closed) drops out, unread rows and all, without reporting anything.
//! A session another workspace's send started is left out while its sender
//! is listed (the sidebar nests it there), unless it waits on the user.
//! Clicking a row opens it in a window on its server, or focuses the window
//! that already shows it: [`open_session`] is the one router every path
//! that opens a session goes through (this island, the pet, the tray, an OS
//! notification, "Open in new window"), so a session is in one window.
//!
//! Reading is shared: opening or dismissing a session here, on the desktop
//! pet, or in an app window goes through [`mark_session_read`], which clears
//! it from this list, drops the pet's bubbles about it, and tells the other
//! app windows (`session-read`) so their sidebars clear its unread mark.
//!
//! A session waiting on the user carries the question the server holds for
//! it. The row only shows it: a click opens the session, where it is
//! answered. An OS notification can still answer one plain single-choice
//! question in place (`crate::answers`, [`answer_question`]); after an answer
//! the row clears at once and the next refetch confirms it.
//!
//! A session working toward a goal shows how far it has got (the list's
//! `goal_turns_used` / `goal_max_turns`), and when its last turn ends the row
//! says what became of the goal, from the `goal` the finishing turn's
//! `desktop_notification` carries, so the notch and the notification agree.
//!
//! The feed runs on every desktop platform, island or not: the tray's
//! "Needs you" list and mark read it too.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::servers::ServerId;

pub const ISLAND_WINDOW: &str = "island";
/// Snapshot of the active sessions, sent to the island webview.
pub const ISLAND_STATUS_EVENT: &str = "island-status";
/// The notch (or menu bar) geometry changed, e.g. a display was plugged in.
pub const ISLAND_GEOMETRY_EVENT: &str = "island-geometry";
/// Where the pointer is over the canvas, while it is over the pill.
pub const ISLAND_POINTER_EVENT: &str = "island-pointer";
/// The island settings changed; sent to every window.
pub const ISLAND_SETTINGS_EVENT: &str = "island-settings-changed";
/// A session was read somewhere (an app window, the island, the pet); sent
/// to the app windows that did not read it, to clear their unread mark.
pub const SESSION_READ_EVENT: &str = "session-read";

/// Island size when the screen has no notch: a pill this wide, as tall as
/// the menu bar (or this tall when the menu bar is hidden).
const FALLBACK_PILL_WIDTH: f64 = 200.0;
const FALLBACK_MENU_BAR_HEIGHT: f64 = 24.0;
/// The transparent window the pill animates inside, in points. The pill
/// never grows past it.
pub const CANVAS_WIDTH: f64 = 460.0;
pub const CANVAS_HEIGHT: f64 = 380.0;
const MIN_SIZE: f64 = 16.0;

/// Turn events often come in bursts (turn started, title update); one
/// refetch covers them.
const REFRESH_DEBOUNCE: Duration = Duration::from_millis(150);
/// While anything is active, refetch this often even without events, so a
/// missed event cannot leave the island stuck.
const SAFETY_REFRESH: Duration = Duration::from_secs(30);
/// The backend pings every 15 s; this long without a byte means the stream is dead.
const STREAM_IDLE_LIMIT: Duration = Duration::from_secs(45);
/// How often to check which servers the app windows are on. Cheap: no IO.
const SUPERVISE_EVERY: Duration = Duration::from_secs(2);
const RETRY_BASE: Duration = Duration::from_secs(2);
/// Kept short so the island catches up soon after a backend comes back.
const RETRY_MAX: Duration = Duration::from_secs(15);
/// A saved server may be off for days (a laptop asleep, a VPN address
/// away from the VPN): retry less often.
const RETRY_MAX_REMOTE: Duration = Duration::from_secs(30);
/// A server that rejected the access key stays rejected until the user
/// fixes it: check back rarely.
const RETRY_AUTH_REJECTED: Duration = Duration::from_secs(60);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// Window focus moves in two steps (old window loses it, new one gains it);
/// decide whether the app is frontmost once it has settled.
const FOCUS_SETTLE: Duration = Duration::from_millis(150);
/// Built this long after launch, so its page load does not compete with
/// the main window's.
const PREWARM_DELAY: Duration = Duration::from_secs(3);
/// How often the pointer is checked: over the pill (row hover follows it),
/// elsewhere while the island is up, and while it is hidden.
const POINTER_POLL_INSIDE: Duration = Duration::from_millis(40);
const POINTER_POLL: Duration = Duration::from_millis(80);
/// Far from the canvas (more than [`POINTER_NEAR`] away) the pointer needs a
/// few readings to get there, so it is read half as often.
const POINTER_FAR_POLL: Duration = Duration::from_millis(160);
/// How often the shown island checks that it is still on the right display
/// ([`display_changed`]).
const DISPLAY_CHECK: Duration = Duration::from_secs(2);
const POINTER_NEAR: f64 = 240.0;
/// Unread sessions kept; older ones drop off.
const MAX_UNREAD: usize = 6;
/// How the memo records a turn that only compacted an idle session.
const IDLE_COMPACTION_STATUS: &str = "idle_compaction";
/// How the memo records a turn only agents worked in (`quiet` on its
/// completion): another workspace's request, nothing for the user to read.
const QUIET_STATUS: &str = "quiet";
/// Notifications kept until their turn's completion arrives, at most.
const MAX_NOTIFIED: usize = 32;
/// What a row calls the builtin sidecar: one name on every surface.
const BUILTIN_NAME: &str = "This computer";

// ── Settings ────────────────────────────────────────────────────────────────

/// What the user chose in Settings → Desktop (`desktop-island.json`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandSettings {
    pub enabled: bool,
    /// Also show while an OpenAgentd window is in front.
    pub show_when_frontmost: bool,
    /// Keep finished sessions ("Done" / "Failed") until they are opened.
    pub show_finished: bool,
    /// Open the list when the pointer rests on the pill. Off by default: the
    /// pill opens when clicked, so a 400 px black panel never lands over the
    /// menu bar or the window beneath it on a stray hover.
    pub expand_on_hover: bool,
}

impl Default for IslandSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            show_when_frontmost: false,
            show_finished: true,
            expand_on_hover: false,
        }
    }
}

/// A partial update; absent fields keep their value.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandSettingsPatch {
    pub enabled: Option<bool>,
    pub show_when_frontmost: Option<bool>,
    pub show_finished: Option<bool>,
    pub expand_on_hover: Option<bool>,
}

impl IslandSettings {
    pub fn with(self, patch: IslandSettingsPatch) -> Self {
        Self {
            enabled: patch.enabled.unwrap_or(self.enabled),
            show_when_frontmost: patch.show_when_frontmost.unwrap_or(self.show_when_frontmost),
            show_finished: patch.show_finished.unwrap_or(self.show_finished),
            expand_on_hover: patch.expand_on_hover.unwrap_or(self.expand_on_hover),
        }
    }
}

// ── Snapshot model ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    NeedsInput,
    /// Finished, not opened yet.
    Done,
    /// Failed, not opened yet.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandSession {
    pub id: String,
    pub title: String,
    /// Last path component of the session's workspace.
    pub workspace: Option<String>,
    pub state: SessionState,
    /// What the agent asked, while it waits on the user.
    pub question: Option<String>,
    /// The server's name, when the island follows more than one.
    pub server: Option<String>,
    /// The server the session lives on.
    #[serde(skip)]
    pub server_id: Option<ServerId>,
    /// The session's goal: its progress while it runs, what became of it
    /// once its last turn ended.
    pub goal: Option<IslandGoal>,
    /// The open question's id, while the session waits on the user.
    pub question_id: Option<String>,
    /// The session another workspace's send started it from (its id), if one did.
    #[serde(skip)]
    pub sent_from: Option<String>,
    /// On a finished row: which finish this is, so a new one is never
    /// mistaken for one put off with "Later".
    #[serde(rename = "finishedSeq", skip_serializing_if = "Option::is_none")]
    pub finished_seq: Option<u64>,
}

/// A session's goal, as the island shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum IslandGoal {
    /// Working: the turn it is on, of its limit.
    Active {
        turn: i64,
        #[serde(rename = "maxTurns")]
        max_turns: i64,
    },
    Achieved,
    Paused,
    Blocked,
}

impl IslandGoal {
    /// What became of a goal, from a notification's `goal`.
    fn outcome(goal: &str) -> Option<Self> {
        match goal {
            "achieved" => Some(Self::Achieved),
            "paused" => Some(Self::Paused),
            "blocked" => Some(Self::Blocked),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandStatus {
    /// Bumped on every change, so the webview can drop a stale snapshot.
    pub seq: u64,
    /// Waiting-on-the-user sessions first.
    pub sessions: Vec<IslandSession>,
    /// Finished sessions not opened yet, newest first.
    pub unread: Vec<IslandSession>,
    /// Servers that dropped off after being followed, or refuse the key.
    pub unreachable: Vec<UnreachableServer>,
    /// Sessions ([`id_key`]s) that waited on the user when their server was
    /// last reached: it can't be now, so whether they still wait is unknown.
    /// For the pet, which keeps their questions meanwhile.
    #[serde(skip)]
    pub held: Vec<String>,
}

/// A followed server the shell can't talk to: its rows are gone, and the
/// island says so instead of showing nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreachableServer {
    /// [`ServerId::key`].
    pub id: String,
    /// What rows call it.
    pub name: String,
    /// `unreachable` or `key_rejected`.
    pub reason: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionAction {
    Open,
    NewWindow,
    Dismiss,
}

impl SessionAction {
    fn key(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::NewWindow => "new-window",
            Self::Dismiss => "dismiss",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Open => "Open",
            Self::NewWindow => "Open in new window",
            Self::Dismiss => "Dismiss",
        }
    }
}

fn menu_actions(session: &IslandSession) -> Vec<SessionAction> {
    let mut actions = vec![SessionAction::Open, SessionAction::NewWindow];
    if matches!(session.state, SessionState::Done | SessionState::Failed) {
        actions.push(SessionAction::Dismiss);
    }
    actions
}

fn action_session(status: &IslandStatus, session_id: &str, action: SessionAction) -> Result<IslandSession> {
    let session = status.sessions.iter().chain(&status.unread).find(|s| s.id == session_id)
        .context("This session is no longer shown in the notch.")?;
    if session.server_id.is_none() {
        bail!("The session's server is no longer available.");
    }
    if !menu_actions(session).contains(&action) {
        bail!("Only finished sessions can be dismissed.");
    }
    Ok(session.clone())
}

fn menu_selection(id: &str) -> Option<(SessionAction, &str)> {
    let (action, session_id) = id.strip_prefix("island:")?.split_once(':')?;
    let action = match action {
        "open" => SessionAction::Open,
        "new-window" => SessionAction::NewWindow,
        "dismiss" => SessionAction::Dismiss,
        _ => return None,
    };
    Some((action, session_id))
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchGeometry {
    pub has_notch: bool,
    pub width: f64,
    pub height: f64,
}

impl Default for NotchGeometry {
    fn default() -> Self {
        Self { has_notch: false, width: FALLBACK_PILL_WIDTH, height: FALLBACK_MENU_BAR_HEIGHT }
    }
}

/// One row of `GET /api/agent/sessions`; only the fields the island uses.
#[derive(Debug, Deserialize)]
pub struct SessionRow {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub needs_input: bool,
    /// The session's turn ended, but subagents (or another workspace) still
    /// work for it. Missing from older backends.
    #[serde(default)]
    pub background_work: bool,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// The live goal's status and progress; missing without one, or from
    /// older backends.
    #[serde(default)]
    pub goal_status: Option<String>,
    #[serde(default)]
    pub goal_turns_used: Option<i64>,
    #[serde(default)]
    pub goal_max_turns: Option<i64>,
    /// Who started the session from another workspace; missing when the
    /// user did, or from older backends.
    #[serde(default)]
    pub sent_from: Option<SentFrom>,
}

/// The `sent_from` of a session row: the session that sent it.
#[derive(Debug, Default, Deserialize)]
pub struct SentFrom {
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionPage {
    #[serde(default)]
    data: Vec<SessionRow>,
}

/// Session ids reach us hyphenated (API rows) and bare (some events).
pub fn id_key(id: &str) -> String {
    id.chars().filter(|c| *c != '-').flat_map(char::to_lowercase).collect()
}

fn workspace_label(path: &str) -> Option<String> {
    let name = path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next()?;
    (!name.is_empty()).then(|| name.to_string())
}

/// The Chat workspace is the home directory by default, so its folder name
/// would be the user's login name; show it as "Chat" like the app does.
fn session_workspace_label(path: &str, chat_root: Option<&str>) -> Option<String> {
    let trim = |p: &str| p.trim_end_matches(['/', '\\']).to_string();
    if chat_root.is_some_and(|root| !root.trim().is_empty() && trim(root) == trim(path)) {
        return Some("Chat".to_string());
    }
    workspace_label(path)
}

fn session_title(title: Option<&str>) -> String {
    match title.map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => "Untitled session".to_string(),
    }
}

/// The island's list from an active-sessions page. A v2 server ignores
/// `active=true` and returns a normal page, so the flags are checked here too.
pub fn active_sessions(rows: Vec<SessionRow>, questions: &HashMap<String, Asked>, chat_root: Option<&str>) -> Vec<IslandSession> {
    let mut sessions: Vec<IslandSession> = rows
        .into_iter()
        .filter(|row| row.parent_session_id.is_none() && (row.running || row.background_work || row.needs_input))
        .map(|row| {
            let state = if row.needs_input { SessionState::NeedsInput } else { SessionState::Running };
            let asked = row.needs_input.then(|| questions.get(&id_key(&row.id))).flatten();
            // The turn that runs, or between turns (subagents) the last one taken.
            let goal = match (row.goal_status.as_deref(), row.goal_turns_used, row.goal_max_turns) {
                (Some("active"), Some(used), Some(max)) => {
                    Some(IslandGoal::Active { turn: if row.running { (used + 1).min(max) } else { used.max(1) }, max_turns: max })
                }
                _ => None,
            };
            IslandSession {
                title: session_title(row.title.as_deref()),
                workspace: row.workspace.as_deref().and_then(|w| session_workspace_label(w, chat_root)),
                id: row.id,
                state,
                question: asked.and_then(|a| a.text.clone()),
                question_id: asked.and_then(|a| a.id.clone()),
                server: None,
                server_id: None,
                goal,
                sent_from: row.sent_from.and_then(|s| s.session_id),
                finished_seq: None,
            }
        })
        .collect();
    // Stable: keeps the server's order within each group.
    sessions.sort_by_key(|s| s.state != SessionState::NeedsInput);
    sessions
}

/// Sessions that left the active list, as finished rows. A turn the user
/// stopped is their own doing, an idle compaction only summarised what was
/// already read, and a turn only agents worked in (`quiet`) is theirs to
/// read; none is reported. Without an outcome (a missed event) the turn
/// counts as done, except in a session another workspace started: its turns
/// are usually that agent's, so a guess would be noise. A goal's last turn
/// carries what became of the goal (`goals`, from its notification).
pub fn newly_finished(
    previous: &[IslandSession],
    next: &[IslandSession],
    statuses: &HashMap<String, String>,
    goals: &HashMap<String, IslandGoal>,
) -> Vec<IslandSession> {
    previous
        .iter()
        .filter(|p| !next.iter().any(|n| n.id == p.id))
        .filter_map(|session| {
            let key = id_key(&session.id);
            let state = match statuses.get(&key).map(String::as_str) {
                Some("stopped" | IDLE_COMPACTION_STATUS | QUIET_STATUS) => return None,
                Some("error" | "failed") => SessionState::Failed,
                None if session.sent_from.is_some() => return None,
                _ => SessionState::Done,
            };
            let goal = goals.get(&key).cloned();
            Some(IslandSession { state, question: None, question_id: None, goal, finished_seq: Some(next_finish()), ..session.clone() })
        })
        .collect()
}

/// A new number for a finish ([`IslandSession::finished_seq`]).
fn next_finish() -> u64 {
    static FINISHES: AtomicU64 = AtomicU64::new(0);
    FINISHES.fetch_add(1, Ordering::Relaxed) + 1
}

/// Add `finished` to the unread list (newest first), except the session on
/// screen (`viewed`, an [`id_key`]), and drop sessions that run again.
/// True when the list changed.
pub fn merge_unread(
    unread: &mut Vec<IslandSession>,
    finished: Vec<IslandSession>,
    next: &[IslandSession],
    viewed: Option<&str>,
) -> bool {
    let before = unread.clone();
    unread.retain(|u| !next.iter().any(|n| n.id == u.id));
    for session in finished.into_iter().rev() {
        if viewed == Some(id_key(&session.id).as_str()) {
            continue;
        }
        unread.retain(|u| u.id != session.id);
        unread.insert(0, session);
    }
    unread.truncate(MAX_UNREAD);
    *unread != before
}

/// Where the background connection to a followed server stands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchState {
    /// Not connected yet.
    #[default]
    Connecting,
    /// Its event stream is open and its list is current.
    Connected,
    /// Unreachable or dropped; retrying.
    Reconnecting,
    /// The server refused the saved access key (401 / 403).
    KeyRejected,
}

/// One followed server's part of the island.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ServerFeed {
    /// What rows call it: "Builtin", or the name it was saved under.
    pub name: String,
    /// Its active sessions as shown: emptied while it can't be reached.
    pub sessions: Vec<IslandSession>,
    /// Its active sessions as last fetched, kept through an outage: a
    /// session that finished meanwhile is still reported once it is back.
    pub baseline: Vec<IslandSession>,
    pub watch: WatchState,
    /// A list was fetched from it at some point. A server that never answered
    /// (a laptop asleep since launch) is not announced as lost.
    pub ever_connected: bool,
    /// Failed connection attempts in a row.
    pub failures: u32,
}

/// A server that dropped off is announced after this many failed attempts in
/// a row: one retry usually covers a hiccup, and the island should not flash
/// "Can't reach" at every blip.
const UNREACHABLE_AFTER_FAILURES: u32 = 2;

impl ServerFeed {
    /// The reason to tell the user this server can't be reached, if any.
    fn unreachable_reason(&self) -> Option<&'static str> {
        match self.watch {
            WatchState::KeyRejected => Some("key_rejected"),
            WatchState::Reconnecting if self.ever_connected && self.failures >= UNREACHABLE_AFTER_FAILURES => Some("unreachable"),
            _ => None,
        }
    }
}

/// Every followed server's active sessions, and the unread ones from all of
/// them. A session only ever finishes against its own server's last list.
#[derive(Debug, Default)]
pub struct Feeds {
    servers: BTreeMap<ServerId, ServerFeed>,
    /// Finished sessions not opened yet, from any server, newest first.
    unread: Vec<IslandSession>,
}

impl Feeds {
    /// Start following `server`. True when it is new.
    pub fn join(&mut self, server: &ServerId, name: String) -> bool {
        if self.servers.contains_key(server) {
            return false;
        }
        self.servers.insert(server.clone(), ServerFeed { name, ..ServerFeed::default() });
        true
    }

    /// `server`'s connection attempt number `failures` (in a row) failed.
    /// True when that changed whether it is announced as unreachable.
    pub fn set_failures(&mut self, server: &ServerId, failures: u32) -> bool {
        let Some(feed) = self.servers.get_mut(server) else {
            return false;
        };
        let before = feed.unreachable_reason();
        feed.failures = failures;
        feed.unreachable_reason() != before
    }

    /// The followed servers that can't be reached, for the island's rows.
    pub fn unreachable(&self) -> Vec<UnreachableServer> {
        self.servers
            .iter()
            .filter_map(|(id, feed)| {
                feed.unreachable_reason().map(|reason| UnreachableServer { id: id.key().to_string(), name: feed.name.clone(), reason })
            })
            .collect()
    }

    /// `session_key`'s question was answered (here or elsewhere): its row
    /// stops waiting at once; the next fetch confirms it. True when it changed.
    pub fn resolve_question(&mut self, session_key: &str) -> bool {
        let mut changed = false;
        for session in self.servers.values_mut().flat_map(|feed| feed.sessions.iter_mut()) {
            if session.state == SessionState::NeedsInput && id_key(&session.id) == session_key {
                session.state = SessionState::Running;
                session.question = None;
                session.question_id = None;
                changed = true;
            }
        }
        changed
    }

    /// Record where `server`'s connection stands. True when that changed
    /// what is shown (the rows' server names depend on it).
    pub fn set_watch(&mut self, server: &ServerId, watch: WatchState) -> bool {
        self.servers.get_mut(server).is_some_and(|feed| std::mem::replace(&mut feed.watch, watch) != watch)
    }

    /// `server` was renamed. True when its name changed.
    pub fn rename(&mut self, server: &ServerId, name: &str) -> bool {
        self.servers.get_mut(server).is_some_and(|feed| feed.name != name && {
            feed.name = name.to_string();
            true
        })
    }

    /// Each followed server's connection state.
    pub fn watch_states(&self) -> Vec<(ServerId, WatchState)> {
        self.servers.iter().map(|(server, feed)| (server.clone(), feed.watch)).collect()
    }

    /// Stop following `server`: its sessions and unread rows go without
    /// being reported as finished. True when it was followed.
    pub fn forget(&mut self, server: &ServerId) -> bool {
        self.unread.retain(|u| u.server_id.as_ref() != Some(server));
        self.servers.remove(server).is_some()
    }

    /// `server` has sessions in its active list.
    pub fn is_active(&self, server: &ServerId) -> bool {
        self.servers.get(server).is_some_and(|feed| !feed.sessions.is_empty())
    }

    /// Take `next` as `server`'s active list. Sessions that left it are
    /// finished (`statuses` and `goals`, see [`newly_finished`]) and become
    /// unread when `show_finished`, except the one on screen (`viewed`).
    /// Ignored for a server no longer followed. True when anything changed.
    pub fn update(
        &mut self,
        server: &ServerId,
        mut next: Vec<IslandSession>,
        statuses: &HashMap<String, String>,
        goals: &HashMap<String, IslandGoal>,
        viewed: Option<&str>,
        show_finished: bool,
    ) -> bool {
        let Some(feed) = self.servers.get_mut(server) else {
            return false;
        };
        for session in &mut next {
            session.server_id = Some(server.clone());
        }
        let finished = if show_finished { newly_finished(&feed.baseline, &next, statuses, goals) } else { Vec::new() };
        let sessions_changed = feed.sessions != next;
        // A fresh list means the server is reachable.
        let watch_changed = std::mem::replace(&mut feed.watch, WatchState::Connected) != WatchState::Connected;
        feed.ever_connected = true;
        feed.failures = 0;
        let unread_changed = merge_unread(&mut self.unread, finished, &next, viewed);
        feed.baseline = next.clone();
        feed.sessions = next;
        sessions_changed || unread_changed || watch_changed
    }

    /// Turns that finished on `server` without ever being in its list
    /// (`late`, e.g. one that failed within moments of starting): they are
    /// unread like any other, unless the list covers them already (the last
    /// list held them, so [`Feeds::update`] reports them, or `next` holds
    /// them because they run again). Call before `update` with the same
    /// `next`. True when the unread list changed.
    pub fn add_late(
        &mut self,
        server: &ServerId,
        late: Vec<IslandSession>,
        next: &[IslandSession],
        viewed: Option<&str>,
        show_finished: bool,
    ) -> bool {
        let Some(feed) = self.servers.get(server) else {
            return false;
        };
        if !show_finished || late.is_empty() {
            return false;
        }
        let listed = |s: &IslandSession| feed.baseline.iter().chain(next).any(|l| id_key(&l.id) == id_key(&s.id));
        let late: Vec<IslandSession> = late
            .into_iter()
            .filter(|s| !listed(s))
            .map(|s| IslandSession { server_id: Some(server.clone()), ..s })
            .collect();
        !late.is_empty() && merge_unread(&mut self.unread, late, next, viewed)
    }

    /// Empty `server`'s active list without reporting a finish: stale
    /// "running" rows are worse than none while it can't be reached. What
    /// finished before stays unread, and the last list is kept to tell, once
    /// it is back, what finished meanwhile. True when it changed.
    pub fn clear_sessions(&mut self, server: &ServerId) -> bool {
        self.servers.get_mut(server).is_some_and(|feed| !std::mem::take(&mut feed.sessions).is_empty())
    }

    /// The island's lists (see [`merged_lists`]).
    pub fn lists(&self) -> (Vec<IslandSession>, Vec<IslandSession>) {
        merged_lists(&self.servers, &self.unread)
    }

    /// The sessions that waited on the user on a server that can't be
    /// reached now, as last seen ([`IslandStatus::held`]).
    pub fn held(&self) -> Vec<String> {
        let mut held: Vec<String> = self
            .servers
            .values()
            .filter(|feed| feed.watch != WatchState::Connected)
            .flat_map(|feed| &feed.baseline)
            .filter(|s| s.state == SessionState::NeedsInput)
            .map(|s| id_key(&s.id))
            .collect();
        held.sort();
        held.dedup();
        held
    }
}

/// The island's two lists across `servers`: waiting sessions first, each
/// session once (a server reached through two URLs reports it twice), and,
/// with more than one server in play (connected, or holding unread rows),
/// each row named after its server. An enabled server that is off does not
/// make the others' rows carry a name. A session another workspace's send
/// started is shown under its sender, as the sidebar nests it: while the
/// sender is listed (it works until the answer comes) the row is left out,
/// unless it waits on the user.
pub fn merged_lists(
    servers: &BTreeMap<ServerId, ServerFeed>,
    unread: &[IslandSession],
) -> (Vec<IslandSession>, Vec<IslandSession>) {
    let in_play: HashSet<&ServerId> = servers
        .iter()
        .filter(|(_, feed)| feed.watch == WatchState::Connected)
        .map(|(id, _)| id)
        .chain(unread.iter().filter_map(|u| u.server_id.as_ref()))
        .collect();
    let named = in_play.len() > 1;
    let label = |session: &IslandSession| IslandSession {
        server: session
            .server_id
            .as_ref()
            .and_then(|id| servers.get(id))
            .filter(|_| named)
            .map(|feed| feed.name.clone()),
        ..session.clone()
    };
    let mut seen = HashSet::new();
    let listed: HashSet<String> = servers.values().flat_map(|feed| &feed.sessions).map(|s| id_key(&s.id)).collect();
    let under_sender = |session: &IslandSession| {
        session.state != SessionState::NeedsInput
            && session.sent_from.as_deref().map(id_key).is_some_and(|sender| sender != id_key(&session.id) && listed.contains(&sender))
    };
    let mut sessions: Vec<IslandSession> = servers
        .values()
        .flat_map(|feed| &feed.sessions)
        .filter(|session| !under_sender(session))
        .filter(|session| seen.insert(id_key(&session.id)))
        .map(label)
        .collect();
    // Stable: keeps each server's order within each group.
    sessions.sort_by_key(|s| s.state != SessionState::NeedsInput);
    let unread = unread.iter().filter(|u| seen.insert(id_key(&u.id))).map(label).collect();
    (sessions, unread)
}

/// What a waiting session asks, as far as the shell knows: the text comes
/// from the notification until the server's own copy arrives (with the id).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Asked {
    pub text: Option<String>,
    pub id: Option<String>,
}

/// Waiting sessions whose question is fetched on one refresh, at most.
const MAX_QUESTION_FETCHES: usize = 8;

/// What the stream told us between refetches: each waiting session's
/// question, how each turn ended, and what became of a goal whose last turn
/// just ended.
#[derive(Debug, Default)]
pub struct FeedMemo {
    questions: HashMap<String, Asked>,
    statuses: HashMap<String, String>,
    goals: HashMap<String, IslandGoal>,
    /// Sessions running an idle compaction, kept out of the list.
    compacting: HashSet<String>,
    /// Finish notifications (`assistant_done`) waiting for their turn's
    /// completion, as the row they would make: the backend only sends one
    /// for a turn the user should read.
    notified: HashMap<String, IslandSession>,
    /// Turns that finished with a notification, for [`Feeds::add_late`].
    late: Vec<IslandSession>,
    /// Path of the backend's Chat workspace, fetched once per connection.
    chat_root: Option<String>,
    /// Waiting sessions whose question was read from the server on this
    /// connection, since they last asked: it is not read again.
    read: HashSet<String>,
}

impl FeedMemo {
    /// The waiting sessions whose question the server is asked for now: the
    /// ones not read yet, [`MAX_QUESTION_FETCHES`] at most.
    fn questions_to_read<'a>(&self, rows: &'a [SessionRow]) -> Vec<&'a SessionRow> {
        rows.iter()
            .filter(|row| row.parent_session_id.is_none() && row.needs_input && !self.read.contains(&id_key(&row.id)))
            .take(MAX_QUESTION_FETCHES)
            .collect()
    }

    /// A new connection: what was read on the last one may have changed
    /// while nothing was listening.
    fn connected(&mut self) {
        self.read.clear();
    }

    /// Record what the event says; true when the active list may have changed.
    pub fn note(&mut self, event: &SseEvent) -> bool {
        let data = || serde_json::from_str::<serde_json::Value>(&event.data).unwrap_or_default();
        match event.event.as_str() {
            "session_turn_started" => {
                let data = data();
                if let Some(id) = data["session_id"].as_str() {
                    let key = id_key(id);
                    self.goals.remove(&key);
                    self.notified.remove(&key);
                    // An idle compaction is never news, even when the list
                    // saw the session before this event did.
                    if data["idle_compaction"].as_bool() == Some(true) {
                        self.statuses.insert(key.clone(), IDLE_COMPACTION_STATUS.to_string());
                        self.compacting.insert(key);
                    } else {
                        self.statuses.remove(&key);
                        self.compacting.remove(&key);
                    }
                }
                true
            }
            "title_update" => true,
            // Goal progress and status show on the session's row.
            "session_goal" => true,
            "session_turn_completed" => {
                let data = data();
                // Subagent turns: the active list only holds top-level
                // sessions, so there is no outcome to keep. Refetch anyway:
                // the last one ending can finish a lead waiting on it.
                if data["parent_session_id"].is_string() {
                    return true;
                }
                if let (Some(id), Some(status)) = (data["session_id"].as_str(), data["status"].as_str()) {
                    let key = id_key(id);
                    self.compacting.remove(&key);
                    let status = if data["idle_compaction"].as_bool() == Some(true) {
                        IDLE_COMPACTION_STATUS
                    } else if data["quiet"].as_bool() == Some(true) {
                        QUIET_STATUS
                    } else {
                        status
                    };
                    if let Some(mut row) = self.notified.remove(&key) {
                        if !matches!(status, "stopped" | IDLE_COMPACTION_STATUS | QUIET_STATUS) {
                            if matches!(status, "error" | "failed") {
                                row.state = SessionState::Failed;
                            }
                            row.goal = self.goals.get(&key).cloned();
                            row.finished_seq = Some(next_finish());
                            self.late.retain(|l| id_key(&l.id) != key);
                            self.late.push(row);
                        }
                    }
                    self.statuses.insert(key, status.to_string());
                }
                true
            }
            "desktop_notification" => {
                let data = data();
                // A goal's last turn: its row says what became of the goal.
                // The turn's own completion event follows and refetches.
                if data["kind"].as_str() == Some("assistant_done") {
                    if let Some(id) = data["session_id"].as_str() {
                        if let Some(goal) = data["goal"].as_str().and_then(IslandGoal::outcome) {
                            self.goals.insert(id_key(id), goal);
                        }
                        if self.notified.len() >= MAX_NOTIFIED {
                            self.notified.clear();
                        }
                        self.notified.insert(id_key(id), notified_row(id, &data));
                    }
                    return false;
                }
                if data["kind"].as_str() != Some("input_needed") {
                    return false;
                }
                if let (Some(id), Some(body)) = (data["session_id"].as_str(), data["body"].as_str()) {
                    let body = body.trim();
                    if !body.is_empty() {
                        self.questions.entry(id_key(id)).or_default().text = Some(body.to_string());
                    }
                }
                // A new question: the id read before is the last one's, so
                // it is dropped (an answer in place would go to a question
                // that is gone) and read again.
                if let Some(id) = data["session_id"].as_str() {
                    let key = id_key(id);
                    if let Some(asked) = self.questions.get_mut(&key) {
                        asked.id = None;
                    }
                    self.read.remove(&key);
                }
                true
            }
            _ => false,
        }
    }

    /// Take the server's copy of what `session_id` waits on (`None`: nothing
    /// is open any more, so the id from before is stale).
    fn learn(&mut self, session_id: &str, question: Option<&crate::answers::OpenQuestion>) {
        let key = id_key(session_id);
        let asked = self.questions.entry(key.clone()).or_default();
        match question {
            Some(question) => {
                if let Some(text) = question.text() {
                    asked.text = Some(text.to_string());
                }
                asked.id = Some(question.id.clone());
                self.read.insert(key);
            }
            None => {
                asked.id = None;
                self.read.remove(&key);
            }
        }
    }

    /// Drop what no longer applies once `sessions` is current.
    fn settle(&mut self, sessions: &[IslandSession]) {
        let waits = |key: &String| sessions.iter().any(|s| s.state == SessionState::NeedsInput && id_key(&s.id) == *key);
        self.questions.retain(|key, _| waits(key));
        self.read.retain(waits);
        self.statuses.retain(|key, _| sessions.iter().any(|s| id_key(&s.id) == *key));
        self.goals.retain(|key, _| sessions.iter().any(|s| id_key(&s.id) == *key));
    }

    /// Drop sessions that are only compacting: a background summary is not work to watch.
    fn hide_compacting(&self, sessions: &mut Vec<IslandSession>) {
        sessions.retain(|s| !self.compacting.contains(&id_key(&s.id)));
    }

    /// Forget compactions of sessions no longer active (`active`: the
    /// list's [`id_key`]s, before [`Self::hide_compacting`]): such a
    /// compaction is over, though its end was missed (the memo outlives a
    /// reconnect).
    fn prune_compacting(&mut self, active: &HashSet<String>) {
        self.compacting.retain(|key| active.contains(key));
    }

    /// The late finishes noted since the last list.
    fn take_late(&mut self) -> Vec<IslandSession> {
        std::mem::take(&mut self.late)
    }
}

/// How a finished turn ended, as its `desktop_notification` says. The one
/// place the notch and the pet learn it from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Finish {
    Done,
    Failed,
    /// The goal it worked on cannot go on.
    GoalBlocked,
}

impl Finish {
    /// From the notification's `outcome`. A server before v3.55.0 sends
    /// none: its title's first words say it ("Failed · web").
    pub(crate) fn of(outcome: Option<&str>, title: &str) -> Self {
        match outcome {
            Some("failed") => Self::Failed,
            Some("goal_blocked") => Self::GoalBlocked,
            // `done`, the other goal outcomes, and any a newer server adds.
            Some(_) => Self::Done,
            None if title.starts_with("Failed") => Self::Failed,
            None if title.starts_with("Goal blocked") => Self::GoalBlocked,
            None => Self::Done,
        }
    }

    /// The same, read from the notification's JSON.
    pub(crate) fn of_notification(data: &serde_json::Value) -> Self {
        Self::of(data["outcome"].as_str(), data["title"].as_str().unwrap_or_default())
    }
}

/// The finished row a finish notification describes: its body is the
/// session's title (or "Session 1a2b3c4d" without one), its title "Done ·
/// workspace" (or "Failed · …", "Goal achieved · …"). A blocked goal is not
/// a failed row: its `goal` (from the notification's `goal`) marks it.
fn notified_row(session_id: &str, data: &serde_json::Value) -> IslandSession {
    let title = data["title"].as_str().unwrap_or_default();
    let workspace = title.split_once(" · ").map(|(_, w)| w.trim().to_string()).filter(|w| !w.is_empty());
    let state = if Finish::of_notification(data) == Finish::Failed { SessionState::Failed } else { SessionState::Done };
    IslandSession {
        id: session_id.to_string(),
        title: session_title(data["body"].as_str()),
        workspace,
        state,
        question: None,
        question_id: None,
        server: None,
        server_id: None,
        goal: None,
        sent_from: None,
        finished_seq: None,
    }
}

// ── SSE ─────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// Incremental `text/event-stream` parser. Chunks may split lines, and
/// multi-byte characters, anywhere.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    event: String,
    data: Option<String>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line);
            if line.is_empty() {
                if let Some(data) = self.data.take() {
                    let event = std::mem::take(&mut self.event);
                    events.push(SseEvent { event: if event.is_empty() { "message".into() } else { event }, data });
                }
                self.event.clear();
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                None => (line.as_ref(), ""),
            };
            match field {
                "event" => self.event = value.to_string(),
                "data" => match &mut self.data {
                    Some(data) => {
                        data.push('\n');
                        data.push_str(value);
                    }
                    None => self.data = Some(value.to_string()),
                },
                _ => {}
            }
        }
        events
    }
}

// ── Geometry ────────────────────────────────────────────────────────────────

/// A rectangle in AppKit screen coordinates (origin bottom-left, points).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// Whether a point is inside, edges included.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenInfo {
    pub frame: Rect,
    /// Top edge of the area below the menu bar.
    pub visible_top: f64,
    /// `safeAreaInsets.top`: the notch height, 0 without one (or before macOS 12).
    pub safe_top: f64,
    /// Widths of the menu bar areas left and right of the notch.
    pub aux_left_width: f64,
    pub aux_right_width: f64,
    /// Device pixels per point (`backingScaleFactor`): 2 on every notched panel.
    pub scale: f64,
}

impl ScreenInfo {
    fn has_notch(&self) -> bool {
        self.safe_top > 0.0 && self.aux_left_width > 0.0 && self.aux_right_width > 0.0
    }
}

/// The built-in (notched) display if there is one, else the primary display,
/// which AppKit lists first.
pub fn pick_screen(screens: &[ScreenInfo]) -> Option<ScreenInfo> {
    screens.iter().find(|s| s.has_notch()).or_else(|| screens.first()).copied()
}

pub fn notch_geometry(screen: &ScreenInfo) -> NotchGeometry {
    if screen.has_notch() {
        let width = (screen.frame.width - screen.aux_left_width - screen.aux_right_width).max(0.0);
        return NotchGeometry { has_notch: true, width, height: screen.safe_top };
    }
    let menu_bar = screen.frame.y + screen.frame.height - screen.visible_top;
    let height = if menu_bar > 0.0 { menu_bar } else { FALLBACK_MENU_BAR_HEIGHT };
    NotchGeometry { has_notch: false, width: FALLBACK_PILL_WIDTH, height }
}

/// Whether the shown island is in the wrong place or the wrong shape for
/// the displays as they are now (one was plugged in, unplugged, rearranged
/// or changed resolution).
pub fn display_changed(canvas: &Rect, geometry: &NotchGeometry, screens: &[ScreenInfo]) -> bool {
    pick_screen(screens).is_some_and(|screen| island_frame(&screen, CANVAS_WIDTH, CANVAS_HEIGHT) != *canvas || notch_geometry(&screen) != *geometry)
}

/// Clamp a pill size the webview asked for to the canvas.
pub fn fit_size(width: f64, height: f64) -> (f64, f64) {
    let clamp = |value: f64, max: f64| if value.is_finite() { value.clamp(MIN_SIZE, max) } else { MIN_SIZE };
    (clamp(width, CANVAS_WIDTH).ceil(), clamp(height, CANVAS_HEIGHT).ceil())
}

/// A box centred on the notch (or the screen), flush with the top: the
/// canvas, or the pill inside it. Its left edge lands on a whole device
/// pixel, not a whole point: a notch an odd number of points wide (185 on a
/// 14" MacBook Pro) has its centre on a half point, and rounding to whole
/// points left the pill 0.5 pt past one side of the notch, a black sliver.
pub fn island_frame(screen: &ScreenInfo, width: f64, height: f64) -> Rect {
    let (width, height) = fit_size(width, height);
    let center = if screen.has_notch() {
        let notch = notch_geometry(screen).width;
        screen.frame.x + screen.aux_left_width + notch / 2.0
    } else {
        screen.frame.x + screen.frame.width / 2.0
    };
    let scale = if screen.scale.is_finite() && screen.scale >= 1.0 { screen.scale } else { 1.0 };
    Rect {
        x: ((center - width / 2.0) * scale).round() / scale,
        y: screen.frame.y + screen.frame.height - height,
        width,
        height,
    }
}

/// The pill's frame: [`island_frame`] moved sideways by `shift` (negative is
/// left), held inside the canvas. Today's island keeps its pill centred
/// (shift 0); the shift stays for a webview that still sends one.
pub fn pill_frame(screen: &ScreenInfo, width: f64, height: f64, shift: f64) -> Rect {
    let mut pill = island_frame(screen, width, height);
    let room = ((CANVAS_WIDTH - pill.width) / 2.0).max(0.0);
    if shift.is_finite() {
        pill.x += shift.clamp(-room, room).round();
    }
    pill
}

pub fn should_show(settings: &IslandSettings, frontmost: bool, wants_visible: bool) -> bool {
    settings.enabled && wants_visible && (!frontmost || settings.show_when_frontmost)
}

/// The pointer over the canvas, in CSS pixels from its top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PointerPayload {
    pub inside: bool,
    pub x: f64,
    pub y: f64,
}

/// Screen point (origin bottom-left) to canvas CSS pixels (origin top-left).
pub fn canvas_point(canvas: &Rect, x: f64, y: f64) -> (f64, f64) {
    (x - canvas.x, canvas.y + canvas.height - y)
}

// ── Shared state ────────────────────────────────────────────────────────────

struct Shared {
    /// What the island shows: every followed server merged, as last sent.
    status: IslandStatus,
    feeds: Feeds,
    geometry: NotchGeometry,
    settings: IslandSettings,
    /// An OpenAgentd app window has focus.
    frontmost: bool,
    /// The webview has something to show, with the pill at `size`.
    wants_visible: bool,
    size: (f64, f64),
    /// How far the pill sits from the canvas centre ([`pill_frame`]).
    shift: f64,
    /// The canvas and the pill inside it, on screen, while shown.
    canvas: Option<Rect>,
    pill: Option<Rect>,
    /// The pointer as last told to the webview.
    pointer: Option<PointerPayload>,
    /// Native menu tracking must not hide or resize the window beneath it.
    menu_open: bool,
    /// The session each app window shows, by window label ([`id_key`]s).
    viewing: HashMap<String, String>,
    /// The saved servers, as last read from the config file: which are
    /// enabled, and their names. Refreshed by [`servers_changed`].
    saved: Vec<crate::config::SavedAppServer>,
    /// What each computer calls itself, read with `saved`.
    names: openagentd_shell_core::ComputerNames,
    /// Servers whose list should be fetched again soon (an answer was sent),
    /// without waiting for an event.
    refresh_requested: HashSet<ServerId>,
}

impl Shared {
    /// Merge the feeds into `status`. The new snapshot, if it changed.
    fn rebuild(&mut self) -> Option<IslandStatus> {
        let (sessions, unread) = self.feeds.lists();
        let unreachable = self.feeds.unreachable();
        let held = self.feeds.held();
        if self.status.sessions == sessions && self.status.unread == unread && self.status.unreachable == unreachable && self.status.held == held {
            return None;
        }
        self.status = IslandStatus { seq: self.status.seq + 1, sessions, unread, unreachable, held };
        Some(self.status.clone())
    }
}

fn shared() -> &'static Mutex<Shared> {
    static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
    SHARED.get_or_init(|| {
        Mutex::new(Shared {
            status: IslandStatus::default(),
            feeds: Feeds::default(),
            geometry: NotchGeometry::default(),
            settings: IslandSettings { enabled: false, ..IslandSettings::default() },
            frontmost: false,
            wants_visible: false,
            size: (FALLBACK_PILL_WIDTH, FALLBACK_MENU_BAR_HEIGHT),
            shift: 0.0,
            canvas: None,
            pill: None,
            pointer: None,
            menu_open: false,
            viewing: HashMap::new(),
            saved: Vec::new(),
            names: Default::default(),
            refresh_requested: HashSet::new(),
        })
    })
}

/// Wakes the feed: the servers to follow changed, a refresh or a retry was
/// asked for.
fn feed_wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

/// Wakes the pointer watch when the canvas is shown. Hidden (or with the
/// feature off), the watch sleeps until then instead of polling.
fn pointer_wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

static FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);

// ── Lifecycle ───────────────────────────────────────────────────────────────

/// Start the feed, and build the island shortly after launch (macOS only).
/// The feed runs on every platform, whenever the app does: the desktop pet
/// (`pet.rs`) and the tray's count mark read it too, with the island off.
pub fn start(app: &AppHandle) {
    refresh_saved(app);
    tauri::async_runtime::spawn(run_feed(app.clone()));
    #[cfg(target_os = "macos")]
    {
        let settings = crate::config::load_island_settings(app);
        shared().lock().unwrap().settings = settings;
        tauri::async_runtime::spawn(run_pointer_watch(app.clone()));
        if settings.enabled {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(PREWARM_DELAY).await;
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(e) = ensure_island(&handle) {
                        log::warn!("island: build failed: {e:#}");
                    }
                });
            });
        }
    }
}

/// The island window, built on first use. Main thread only.
#[cfg(target_os = "macos")]
fn ensure_island(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(ISLAND_WINDOW) {
        return Ok(window);
    }
    let window = tauri::WebviewWindowBuilder::new(app, ISLAND_WINDOW, tauri::WebviewUrl::App("island.html".into()))
        .title("OpenAgentd status")
        .inner_size(CANVAS_WIDTH, CANVAS_HEIGHT)
        .visible(false)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        // Never take keyboard focus from the app the user is typing in, but
        // let the first click on a row count as a click.
        .focusable(false)
        .focused(false)
        .accept_first_mouse(true)
        .skip_taskbar(true)
        .build()?;
    native::configure(&window);
    log::info!("island: window built at_ms={}", crate::launch_ms());
    Ok(window)
}

/// Show, place, or hide the canvas to match the shared state. Main thread only.
#[cfg(target_os = "macos")]
fn apply(app: &AppHandle) {
    let (show, (width, height), shift) = {
        let s = shared().lock().unwrap();
        if s.menu_open {
            return;
        }
        (should_show(&s.settings, s.frontmost, s.wants_visible), s.size, s.shift)
    };
    let Some(window) = app.get_webview_window(ISLAND_WINDOW) else {
        return;
    };
    if !show {
        {
            let mut s = shared().lock().unwrap();
            s.canvas = None;
            s.pill = None;
        }
        send_pointer(app, None);
        let _ = window.hide();
        return;
    }
    let Some(screen) = refresh_geometry(app) else {
        return;
    };
    let canvas = island_frame(&screen, CANVAS_WIDTH, CANVAS_HEIGHT);
    let pill = pill_frame(&screen, width, height, shift);
    let moved = {
        let mut s = shared().lock().unwrap();
        s.pill = Some(pill);
        s.canvas.replace(canvas) != Some(canvas)
    };
    // A resize of the pill is CSS's job; the canvas only moves on a new show
    // or a display change.
    if moved {
        native::place(&window, canvas);
        // Placing resets click-through; the pointer watch starts over.
        send_pointer(app, None);
        pointer_wake().notify_one();
    }
}

#[cfg(not(target_os = "macos"))]
fn apply(_app: &AppHandle) {}

fn schedule_apply(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply(&handle));
}

/// Tell the webview where the pointer is, if that changed. `None`: gone.
fn send_pointer(app: &AppHandle, pointer: Option<PointerPayload>) {
    let changed = {
        let mut s = shared().lock().unwrap();
        // Once outside, only the first "left" matters.
        let same = match (s.pointer, pointer) {
            (Some(a), Some(b)) => a == b || (!a.inside && !b.inside),
            (None, None) => true,
            (Some(a), None) | (None, Some(a)) => !a.inside,
        };
        s.pointer = pointer;
        !same
    };
    if changed {
        let payload = pointer.unwrap_or(PointerPayload { inside: false, x: -1.0, y: -1.0 });
        let _ = app.emit_to(ISLAND_WINDOW, ISLAND_POINTER_EVENT, payload);
    }
}

/// How long until the pointer is read again while the canvas is up: often
/// over the pill (hover), every [`POINTER_POLL`] near it, and less often far
/// away, so a shown island costs few wakeups while you work elsewhere.
pub fn pointer_poll_interval(canvas: &Rect, pointer: Option<PointerPayload>) -> Duration {
    match pointer {
        Some(p) if p.inside => POINTER_POLL_INSIDE,
        // Canvas coordinates: y grows downwards from the top of the screen.
        Some(p) if p.x < -POINTER_NEAR || p.x > canvas.width + POINTER_NEAR || p.y > canvas.height + POINTER_NEAR => POINTER_FAR_POLL,
        _ => POINTER_POLL,
    }
}

/// Poll the pointer while the canvas is up (see the module docs for why).
#[cfg(target_os = "macos")]
async fn run_pointer_watch(app: AppHandle) {
    let mut displays_checked = std::time::Instant::now();
    loop {
        let (canvas, pointer) = {
            let s = shared().lock().unwrap();
            (s.canvas, s.pointer)
        };
        let Some(canvas) = canvas else {
            pointer_wake().notified().await;
            continue;
        };
        let inside = pointer.is_some_and(|p| p.inside);
        // The same loop keeps the island on the right display: it only runs
        // while the island is up, and a hidden one is placed when it shows.
        let check_displays = displays_checked.elapsed() >= DISPLAY_CHECK;
        if check_displays {
            displays_checked = std::time::Instant::now();
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let (pill, geometry) = {
                let s = shared().lock().unwrap();
                if s.menu_open {
                    return;
                }
                // The canvas may have moved or hidden since it was read.
                if s.canvas != Some(canvas) {
                    return;
                }
                (s.pill, s.geometry)
            };
            if check_displays && display_changed(&canvas, &geometry, &native::screens()) {
                // Moves the canvas, tells the webview the new notch, and
                // starts the pointer over.
                log::info!("island: the displays changed, placing it again");
                apply(&handle);
                return;
            }
            let (Some(pill), Some((x, y))) = (pill, native::mouse_location()) else {
                return;
            };
            let now_inside = pill.contains(x, y);
            if now_inside != inside {
                if let Some(window) = handle.get_webview_window(ISLAND_WINDOW) {
                    native::set_click_through(&window, !now_inside);
                }
            }
            let (cx, cy) = canvas_point(&canvas, x, y);
            send_pointer(&handle, Some(PointerPayload { inside: now_inside, x: cx, y: cy }));
        });
        tokio::time::sleep(pointer_poll_interval(&canvas, pointer)).await;
    }
}

/// Re-read the screen and tell the webview if the notch changed. Main thread
/// only; returns the screen the island belongs on.
#[cfg(target_os = "macos")]
fn refresh_geometry(app: &AppHandle) -> Option<ScreenInfo> {
    let screen = pick_screen(&native::screens())?;
    let geometry = notch_geometry(&screen);
    let changed = {
        let mut s = shared().lock().unwrap();
        std::mem::replace(&mut s.geometry, geometry) != geometry
    };
    if changed {
        let _ = app.emit_to(ISLAND_WINDOW, ISLAND_GEOMETRY_EVENT, geometry);
    }
    Some(screen)
}

#[cfg(not(target_os = "macos"))]
fn refresh_geometry(_app: &AppHandle) -> Option<ScreenInfo> {
    None
}

/// An app window gained or lost focus: hide the island while OpenAgentd is
/// frontmost, the way iOS hides a Live Activity while its app is open.
/// The pet steps aside the same way.
pub fn on_app_focus_changed(app: &AppHandle) {
    let generation = FOCUS_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FOCUS_SETTLE).await;
        if FOCUS_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let focused = crate::window::focused_webview_window(&handle)
                .filter(|w| !crate::window::is_overlay_window(w.label()));
            let frontmost = focused.is_some();
            let changed = {
                let mut s = shared().lock().unwrap();
                std::mem::replace(&mut s.frontmost, frontmost) != frontmost
            };
            // Coming back to a window reads the session it shows.
            if let Some(window) = focused {
                let shown = shared().lock().unwrap().viewing.get(window.label()).cloned();
                if let Some(key) = shown {
                    mark_session_read(&handle, &key, Some(window.label()));
                }
            }
            if changed {
                apply(&handle);
                crate::pet::refresh(&handle);
            }
        });
    });
}

/// An OpenAgentd app window has focus (as last settled).
pub fn app_frontmost() -> bool {
    shared().lock().unwrap().frontmost
}

// ── Feed ────────────────────────────────────────────────────────────────────

/// A client without a total timeout: the event stream stays open for hours.
fn stream_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default()
}

/// The pet was switched on or off, or a server asked to be retried: wake
/// the feed now.
pub fn wake_feed() {
    feed_wake().notify_waiters();
}

/// `server`'s list should be fetched again soon.
fn request_refresh(server: &ServerId) {
    shared().lock().unwrap().refresh_requested.insert(server.clone());
    feed_wake().notify_waiters();
}

fn take_refresh_request(server: &ServerId) -> bool {
    shared().lock().unwrap().refresh_requested.remove(server)
}

/// Wait up to `duration`, or less if the feed is woken ([`feed_wake`]).
async fn pause(duration: Duration) {
    let _ = tokio::time::timeout(duration, feed_wake().notified()).await;
}

/// Keep one feed per server an app window is on: start following a server
/// when a window connects to it or it is enabled, stop when its last window
/// leaves it and it is not enabled.
async fn run_feed(app: AppHandle) {
    let mut tasks: HashMap<ServerId, tauri::async_runtime::JoinHandle<()>> = HashMap::new();
    loop {
        let (saved, names) = {
            let shared = shared().lock().unwrap();
            (shared.saved.clone(), shared.names.clone())
        };
        let wanted = crate::servers::app_followed_servers(&app, &crate::servers::enabled_servers(&saved)).await;
        // A feed whose task ended is started again below.
        let gone: Vec<ServerId> = tasks
            .iter()
            .filter(|(server, task)| !wanted.contains(server) || task.inner().is_finished())
            .map(|(server, _)| server.clone())
            .collect();
        for server in gone {
            if let Some(task) = tasks.remove(&server) {
                task.abort();
            }
            edit_feeds(&app, |feeds| feeds.forget(&server));
            log::info!("island: stopped following {}", server.key());
        }
        for server in wanted {
            let name = server.display_name(BUILTIN_NAME, &saved, &names);
            if tasks.contains_key(&server) {
                // Renamed in Settings since it was joined.
                edit_feeds(&app, |feeds| feeds.rename(&server, &name));
                continue;
            }
            edit_feeds(&app, |feeds| feeds.join(&server, name));
            tasks.insert(server.clone(), tauri::async_runtime::spawn(follow_server(app.clone(), server)));
        }
        pause(SUPERVISE_EVERY).await;
    }
}

/// Re-read the saved servers and the computers' names (kept in memory so
/// the supervisor does not read the files every tick). An unreadable server
/// list keeps what was there.
fn refresh_saved(app: &AppHandle) {
    let names = crate::config::load_computer_names(app);
    let mut shared = shared().lock().unwrap();
    shared.names = names;
    if let Ok(config) = crate::config::load_app_backend_config(app) {
        shared.saved = config.servers;
    }
}

/// The saved servers changed (added, removed, renamed, switched on or
/// off): follow or drop feeds now rather than at the next 2 s check.
pub fn servers_changed(app: &AppHandle) {
    refresh_saved(app);
    feed_wake().notify_waiters();
}

/// The server answered 401 / 403: the access key is wrong or was revoked.
#[derive(Debug)]
struct AuthRejected(u16);

impl std::fmt::Display for AuthRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the server rejected the access key (HTTP {})", self.0)
    }
}

impl std::error::Error for AuthRejected {}

/// Follow one server's event stream, reconnecting with a backoff, until
/// [`run_feed`] stops it.
async fn follow_server(app: AppHandle, server: ServerId) {
    let client = stream_client();
    let mut failures: u32 = 0;
    // Kept across reconnects: how a turn ended (stopped, quiet, a
    // compaction) still applies to a session the next list no longer has.
    let mut memo = FeedMemo::default();
    let retry_max = if server == ServerId::Bundled { RETRY_MAX } else { RETRY_MAX_REMOTE };
    loop {
        let Some((base, token)) = crate::servers::endpoint(&app, &server).await else {
            pause(RETRY_BASE).await;
            continue;
        };
        if let Err(e) = follow(&app, &client, &server, &base, token.as_deref(), &mut failures, &mut memo).await {
            failures = failures.saturating_add(1);
            let rejected = e.downcast_ref::<AuthRejected>().is_some();
            let watch = if rejected { WatchState::KeyRejected } else { WatchState::Reconnecting };
            edit_feeds(&app, |feeds| {
                let emptied = feeds.clear_sessions(&server);
                let watch_changed = feeds.set_watch(&server, watch);
                // A server that keeps failing is announced as unreachable.
                let announced = feeds.set_failures(&server, failures);
                watch_changed || announced || emptied
            });
            let delay = if rejected {
                RETRY_AUTH_REJECTED
            } else {
                crate::usage::backoff_delay(RETRY_BASE, failures, retry_max)
            };
            // Once per outage: a server that is off can stay off for hours.
            if failures == 1 {
                log::info!("island: event stream from {} unavailable, retrying: {e:#}", server.key());
            } else {
                log::debug!("island: event stream from {} unavailable, retrying in {}s: {e:#}", server.key(), delay.as_secs());
            }
            pause(delay).await;
        }
    }
}

/// Follow `server`'s event stream at `base` until it fails. Resets
/// `failures` once connected. `memo` is the server's, kept from earlier
/// connections.
async fn follow(
    app: &AppHandle,
    client: &reqwest::Client,
    server: &ServerId,
    base: &str,
    token: Option<&str>,
    failures: &mut u32,
    memo: &mut FeedMemo,
) -> Result<()> {
    let base = base.trim_end_matches('/');
    let url = format!("{base}/api/events/stream");
    let mut request = client.get(&url).header(reqwest::header::ACCEPT, "text/event-stream");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.context("open event stream")?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AuthRejected(status.as_u16()).into());
    }
    let mut response = response
        .error_for_status()
        .context("event stream returned an error status")?;
    // Seed after connecting, so nothing that happens in between is missed.
    memo.chat_root = chat_root(client, base, token).await;
    memo.connected();
    // Which computer this is: one reached at two addresses is followed once.
    crate::servers::learn_identity(server, crate::servers::server_fingerprint(client, base, token).await);
    refresh(app, client, server, base, token, memo).await?;
    log::info!("island: {} {base}", if *failures > 0 { "reconnected to" } else { "following" });
    *failures = 0;

    let mut parser = SseParser::default();
    let mut refresh_at: Option<Instant> = None;
    let mut last_bytes = Instant::now();
    let mut last_refresh = Instant::now();
    loop {
        let now = Instant::now();
        let wait = refresh_at
            .map(|at| at.saturating_duration_since(now))
            .unwrap_or(Duration::from_secs(1))
            .min(Duration::from_secs(1));
        tokio::select! {
            chunk = response.chunk() => match chunk.context("read event stream")? {
                Some(bytes) => {
                    last_bytes = Instant::now();
                    for event in parser.push(&bytes) {
                        if event.event == "desktop_notification" {
                            crate::pet::on_feed_notification(app, server, &event.data);
                        }
                        if memo.note(&event) {
                            refresh_at.get_or_insert(last_bytes + REFRESH_DEBOUNCE);
                        }
                    }
                }
                None => bail!("event stream closed"),
            },
            _ = tokio::time::sleep(wait) => {}
            _ = feed_wake().notified() => {}
        }
        // An answer was sent: the list changes now, not at the next event.
        if take_refresh_request(server) {
            refresh_at.get_or_insert(Instant::now() + REFRESH_DEBOUNCE);
        }
        let now = Instant::now();
        let active = shared().lock().unwrap().feeds.is_active(server);
        let due = refresh_at.is_some_and(|at| now >= at)
            || (active && now.duration_since(last_refresh) >= SAFETY_REFRESH);
        if due {
            refresh_at = None;
            last_refresh = now;
            refresh(app, client, server, base, token, memo).await?;
        }
        if now.duration_since(last_bytes) >= STREAM_IDLE_LIMIT {
            bail!("event stream went quiet");
        }
    }
}

async fn refresh(
    app: &AppHandle,
    client: &reqwest::Client,
    server: &ServerId,
    base: &str,
    token: Option<&str>,
    memo: &mut FeedMemo,
) -> Result<()> {
    let url = format!("{base}/api/agent/sessions?active=true&limit=100");
    let mut request = client.get(&url).timeout(LIST_TIMEOUT);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let page: SessionPage = request
        .send()
        .await
        .context("list active sessions")?
        .error_for_status()
        .context("active sessions returned an error status")?
        .json()
        .await
        .context("parse active sessions")?;
    learn_questions(client, base, token, &page.data, memo).await;
    let active: HashSet<String> =
        page.data.iter().filter(|row| row.running || row.background_work || row.needs_input).map(|row| id_key(&row.id)).collect();
    memo.prune_compacting(&active);
    let mut next = active_sessions(page.data, &memo.questions, memo.chat_root.as_deref());
    memo.hide_compacting(&mut next);
    publish(app, server, next, memo);
    Ok(())
}

/// Ask the server what each waiting session asks (its text, id and the
/// buttons that can answer it), a few at a time, once per question
/// ([`FeedMemo::questions_to_read`]). Best effort: a session whose question
/// can't be read keeps the notification's text, and is asked again on the
/// next refresh.
async fn learn_questions(client: &reqwest::Client, base: &str, token: Option<&str>, rows: &[SessionRow], memo: &mut FeedMemo) {
    let mut fetches = tokio::task::JoinSet::new();
    for row in memo.questions_to_read(rows) {
        let (client, base, token, id) = (client.clone(), base.to_string(), token.map(str::to_string), row.id.clone());
        fetches.spawn(async move {
            let question = crate::answers::fetch_question_at(&client, &base, token.as_deref(), &id).await;
            (id, question)
        });
    }
    while let Some(done) = fetches.join_next().await {
        match done {
            Ok((id, Ok(question))) => memo.learn(&id, question.as_ref()),
            Ok((id, Err(error))) => log::debug!("island: could not read the question of {id}: {error:#}"),
            Err(error) => log::debug!("island: question fetch ended early: {error}"),
        }
    }
}

/// The Chat workspace path from `GET /api/agent/workspace/tree`. Best effort:
/// without it, Chat sessions fall back to their folder name.
async fn chat_root(client: &reqwest::Client, base: &str, token: Option<&str>) -> Option<String> {
    #[derive(Deserialize)]
    struct Tree {
        chat: Option<Chat>,
    }
    #[derive(Deserialize)]
    struct Chat {
        path: String,
    }
    let mut request = client.get(format!("{base}/api/agent/workspace/tree")).timeout(LIST_TIMEOUT);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let tree: Tree = match async { request.send().await?.error_for_status()?.json().await }.await {
        Ok(tree) => tree,
        Err(err) => {
            log::warn!("island: could not read the Chat workspace: {err}");
            return None;
        }
    };
    tree.chat.map(|c| c.path)
}

/// Take `next` as `server`'s active list and send the island the result.
fn publish(app: &AppHandle, server: &ServerId, next: Vec<IslandSession>, memo: &mut FeedMemo) {
    let viewed = viewed_session(app);
    let status = {
        let mut s = shared().lock().unwrap();
        let show_finished = s.settings.show_finished;
        // Turns that finished before any list saw them, then the list.
        let late = s.feeds.add_late(server, memo.take_late(), &next, viewed.as_deref(), show_finished);
        // The outcomes of sessions that just left the list are read here,
        // before `settle` drops them.
        let changed = s.feeds.update(server, next.clone(), &memo.statuses, &memo.goals, viewed.as_deref(), show_finished);
        (late || changed).then(|| s.rebuild()).flatten()
    };
    memo.settle(&next);
    let Some(status) = status else {
        return;
    };
    let waiting = status.sessions.iter().filter(|s| s.state == SessionState::NeedsInput).count();
    log::info!(
        "island: active={} needs_input={} unread={} (from {})",
        status.sessions.len(),
        waiting,
        status.unread.len(),
        server.key()
    );
    send_status(app, &status);
}

/// Send a new snapshot to the island, the pet and the tray.
fn send_status(app: &AppHandle, status: &IslandStatus) {
    let _ = app.emit_to(ISLAND_WINDOW, ISLAND_STATUS_EVENT, status);
    crate::pet::status_changed(app, status);
    crate::menu::update_tray_needs_you(app, status);
}

/// Change the feeds, and tell the island if that changed what it shows.
fn edit_feeds(app: &AppHandle, edit: impl FnOnce(&mut Feeds) -> bool) {
    let status = {
        let mut s = shared().lock().unwrap();
        if !edit(&mut s.feeds) {
            return;
        }
        match s.rebuild() {
            Some(status) => status,
            None => return,
        }
    };
    send_status(app, &status);
}

/// Change the unread list, and tell the island if that changed it.
fn edit_unread(app: &AppHandle, edit: impl FnOnce(&mut Vec<IslandSession>)) {
    edit_feeds(app, |feeds| {
        let before = feeds.unread.clone();
        edit(&mut feeds.unread);
        feeds.unread != before
    });
}

/// The session (an [`id_key`]) was opened: it is read.
fn mark_read(app: &AppHandle, key: &str) {
    edit_unread(app, |unread| unread.retain(|u| id_key(&u.id) != key));
}

/// The app windows to tell that a session was read: every one but the
/// overlays and the window that read it (it already knows).
pub fn read_recipients(labels: impl IntoIterator<Item = String>, source: Option<&str>) -> Vec<String> {
    labels
        .into_iter()
        .filter(|label| !crate::window::is_overlay_window(label) && Some(label.as_str()) != source)
        .collect()
}

/// `session_id` was read or dismissed somewhere (`source`: the app window
/// that read it, if one did): it is read everywhere. The island drops its
/// row, the pet its bubbles, and the other app windows their unread mark.
pub(crate) fn mark_session_read(app: &AppHandle, session_id: &str, source: Option<&str>) {
    let key = id_key(session_id);
    log::info!("read: session={key} from={}", source.unwrap_or("shell"));
    mark_read(app, &key);
    crate::pet::forget_session(app, &key);
    crate::notifications::session_read(&key);
    let payload = serde_json::json!({ "sessionId": session_id });
    for label in read_recipients(app.webview_windows().into_keys(), source) {
        let _ = app.emit_to(label.as_str(), SESSION_READ_EVENT, &payload);
    }
}

/// The session on screen in the focused app window, while OpenAgentd is in front.
pub(crate) fn viewed_session(app: &AppHandle) -> Option<String> {
    let label = crate::window::target_window_label(app);
    let s = shared().lock().unwrap();
    if !s.frontmost {
        return None;
    }
    s.viewing.get(&label).cloned()
}

/// The snapshot as last sent, for a surface switched on since (the pet).
pub(crate) fn current_status() -> IslandStatus {
    shared().lock().unwrap().status.clone()
}

/// The id and server of a listed session (an [`id_key`]).
pub(crate) fn session_server(key: &str) -> Option<(String, ServerId)> {
    let s = shared().lock().unwrap();
    s.status
        .sessions
        .iter()
        .chain(&s.status.unread)
        .find(|session| id_key(&session.id) == key)
        .and_then(|session| Some((session.id.clone(), session.server_id.clone()?)))
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandView {
    status: IslandStatus,
    geometry: NotchGeometry,
    settings: IslandSettings,
}

/// The island's current snapshot, notch geometry and settings, read when it
/// mounts. Only the island may call it.
#[tauri::command]
pub fn island_state(app: AppHandle, window: WebviewWindow) -> Result<IslandView, String> {
    if window.label() != ISLAND_WINDOW {
        return Err("only the island reads its state".into());
    }
    // Sync commands run on the main thread, where AppKit may be read.
    let _ = refresh_geometry(&app);
    let s = shared().lock().unwrap();
    Ok(IslandView { status: s.status.clone(), geometry: s.geometry, settings: s.settings })
}

/// The pill's size and sideways shift (its hit area for clicks and hover),
/// and whether the island has anything to show.
#[tauri::command]
pub fn island_fit(app: AppHandle, window: WebviewWindow, width: f64, height: f64, visible: bool, shift: Option<f64>) {
    if window.label() != ISLAND_WINDOW {
        return;
    }
    {
        let mut s = shared().lock().unwrap();
        s.size = fit_size(width, height);
        s.shift = shift.filter(|value| value.is_finite()).unwrap_or(0.0);
        s.wants_visible = visible;
    }
    schedule_apply(&app);
}

async fn run_session_action(app: &AppHandle, session_id: &str, action: SessionAction) -> Result<()> {
    let session = action_session(&shared().lock().unwrap().status, session_id, action)?;
    let server = session.server_id.context("The session's server is no longer available.")?;
    if action == SessionAction::Dismiss {
        mark_session_read(app, session_id, None);
        seen_by_shell(app, server, session_id);
        return Ok(());
    }
    let mode = if action == SessionAction::NewWindow { OpenIn::NewWindow } else { OpenIn::Existing };
    // The island is a widget: opening from it leaves focus where it is.
    open_session(app, server.clone(), session_id, mode, true).await?;
    mark_session_read(app, session_id, None);
    // Focus stayed where it was, so the window will not report it seen itself.
    seen_by_shell(app, server, session_id);
    Ok(())
}

/// The user opened or dismissed `session_id`'s notification on a shell
/// surface (the island, the pet): tell its server it was seen, so the phone
/// push it holds is dropped (`cloud/letters.rs`). An app window reports its
/// own sessions (`web/src/api/client/session-seen.ts`). Best effort.
pub(crate) fn seen_by_shell(app: &AppHandle, server: ServerId, session_id: &str) {
    let (app, session_id) = (app.clone(), session_id.to_string());
    tauri::async_runtime::spawn(async move {
        match crate::answers::report_seen(&app, &server, &session_id).await {
            Ok(()) => log::info!("seen: session={} reported", id_key(&session_id)),
            Err(e) => log::debug!("seen: could not report session={}: {e:#}", id_key(&session_id)),
        }
    });
}

// ── The session → window router ─────────────────────────────────────────────

/// Where a session opens when no window shows it yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpenIn {
    /// The server's window: the focused one, the active one, any other.
    Existing,
    /// A window of its own ("Open in new window").
    NewWindow,
}

/// Bring forward the app window that already shows `session_id`, if one
/// does (every app window reports its session: [`island_viewing`]). One
/// session lives in one window, so this comes before any other choice.
pub(crate) fn focus_window_showing(app: &AppHandle, session_id: &str) -> bool {
    let key = id_key(session_id);
    let windows = crate::servers::app_window_labels(app);
    let focused = crate::servers::focused_app_window(app);
    let label = {
        let s = shared().lock().unwrap();
        crate::servers::window_showing_session(&key, &s.viewing, focused.as_deref(), &windows)
    };
    match label.and_then(|label| app.get_webview_window(&label)) {
        Some(window) => {
            crate::window::show_window(&window);
            true
        }
        None => false,
    }
}

/// Open `session_id` of `server`. The one router behind every way to open a
/// session (the island, the pet, the tray, an OS notification, "Open in new
/// window", a session path given to `app_new_window`):
///
/// 1. a window that already shows it comes forward;
/// 2. else, for [`OpenIn::NewWindow`], a new window opens on the server;
/// 3. else the server's window shows it (the focused one, the active one,
///    any other), and with no window on that server (an enabled saved server
///    watched in the background, or its last window just closed) one opens
///    there. Never on another server, where the session is not found.
///
/// `quiet`: a widget (the island, the pet) opens it, and the page does not
/// put focus in the composer ([`open_path`], [`open_payload`]).
pub(crate) async fn open_session(app: &AppHandle, server: ServerId, session_id: &str, mode: OpenIn, quiet: bool) -> Result<()> {
    // After a launch at login the windows of the last run come back first,
    // so the one that showed this session is found below.
    crate::window_session::restore_if_pending(app).await;
    if focus_window_showing(app, session_id) {
        return Ok(());
    }
    let path = open_path(session_id, quiet);
    if mode == OpenIn::NewWindow {
        crate::window::create_app_window_on_server(app, server, &path).await?;
        return Ok(());
    }
    let windows = crate::servers::app_window_labels(app);
    let target = crate::servers::window_for_server(
        &server,
        crate::servers::focused_app_window(app).as_deref(),
        crate::servers::active_app_window(app).as_deref(),
        &windows,
        &crate::servers::external_map(app),
    );
    match target.and_then(|label| app.get_webview_window(&label)) {
        Some(target) => {
            crate::window::show_window(&target);
            // Repeated while the window may still be loading (a reload after
            // a server switch, a window just opened): one emit could land
            // before its listener and the click would open nothing.
            let payload = open_payload(session_id, quiet, crate::window::next_event_id());
            crate::window::emit_while_mounting(app, Some(target.label().to_string()), "desktop-notification-clicked", payload);
        }
        None => {
            crate::window::create_app_window_on_server(app, server, &path).await?;
        }
    }
    Ok(())
}

/// The app path a new window opens `session_id` at; `?quiet=1` asks the page
/// to leave focus alone (`web/src/lib/quiet-open.ts`).
fn open_path(session_id: &str, quiet: bool) -> String {
    if quiet {
        format!("/{session_id}?quiet=1")
    } else {
        format!("/{session_id}")
    }
}

/// What a window that switches to `session_id` is sent, with `quiet` only
/// when set. `id` lets the page open it once although it is sent repeatedly.
fn open_payload(session_id: &str, quiet: bool, id: u64) -> serde_json::Value {
    let mut payload = serde_json::json!({ "sessionId": session_id, "id": id });
    if quiet {
        payload["quiet"] = serde_json::json!(true);
    }
    payload
}

/// The session id in an app path (`/<id>`, maybe with a query or hash).
pub(crate) fn session_id_from_path(path: &str) -> Option<String> {
    let id = path.trim_start_matches('/').split(['/', '?', '#']).next()?;
    crate::answers::is_id(id).then(|| id.to_string())
}

// ── Answering in place ──────────────────────────────────────────────────────

/// Post an answer to `session_id`'s open question on `server`, and clear the
/// question on every surface, whether the server took it (`Answered`) or had
/// already lost it (`Gone`: answered in the app or on another device).
pub(crate) async fn answer_question(
    app: &AppHandle,
    server: &ServerId,
    session_id: &str,
    question_id: &str,
    answers: &[Vec<String>],
) -> Result<crate::answers::AnswerOutcome> {
    let outcome = crate::answers::submit(app, server, session_id, question_id, answers).await?;
    log::info!("answer: session={} outcome={outcome:?}", id_key(session_id));
    mark_answered(app, session_id);
    request_refresh(server);
    Ok(outcome)
}

/// `session_id`'s question is answered: the island's row stops waiting, the
/// pet drops the question's bubble, and the tray reloads.
pub(crate) fn mark_answered(app: &AppHandle, session_id: &str) {
    let key = id_key(session_id);
    edit_feeds(app, |feeds| feeds.resolve_question(&key));
    crate::pet::question_answered(app, &key);
}

/// A click on a server the island says it can't reach: try now, not at the
/// next backoff.
#[tauri::command]
pub fn island_retry(window: WebviewWindow) {
    if window.label() == ISLAND_WINDOW {
        wake_feed();
    }
}

/// A click on a server that refused the saved access key. Trying again
/// would be refused again, so the app shows Settings → Server, where the
/// key is fixed; saving it there wakes the feed (`servers_changed`).
#[tauri::command]
pub fn island_fix_key(window: WebviewWindow) {
    if window.label() == ISLAND_WINDOW {
        crate::window::emit_frontend_command(window.app_handle(), "settings_connection");
    }
}

fn report_island_error(app: &AppHandle, title: &str, error: &anyhow::Error) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    log::warn!("island: {title}: {error:#}");
    app.dialog().message("The session or its server may no longer be available. Try again from OpenAgentd.")
        .title(title)
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn dispatch_session_action(app: &AppHandle, session_id: String, action: SessionAction) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_session_action(&app, &session_id, action).await {
            report_island_error(&app, "Could not open or dismiss session", &error);
        }
    });
}

/// Called by the app's single menu listener, not a new listener per popup.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some((action, session_id)) = menu_selection(id) else {
        return false;
    };
    dispatch_session_action(app, session_id.to_string(), action);
    true
}

/// Open a session the island is showing, in an app window on its server.
#[tauri::command]
pub fn island_open_session(app: AppHandle, window: WebviewWindow, session_id: String) {
    if window.label() == ISLAND_WINDOW {
        dispatch_session_action(&app, session_id, SessionAction::Open);
    }
}

/// Keep the IPC promise pending until native menu tracking ends.
#[tauri::command]
pub async fn island_context_menu(app: AppHandle, window: WebviewWindow, session_id: String, x: f64, y: f64) -> Result<(), String> {
    if window.label() != ISLAND_WINDOW {
        return Err("Only the island can show its session menu.".into());
    }
    if !x.is_finite() || !y.is_finite() || !(0.0..=CANVAS_WIDTH).contains(&x) || !(0.0..=CANVAS_HEIGHT).contains(&y) {
        return Err("Invalid menu position.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = show_session_menu(&handle, &window, &session_id, x, y);
            if let Err(error) = &result {
                report_island_error(&handle, "Could not show session menu", error);
            }
            let _ = tx.send(result.map_err(|error| error.to_string()));
        }).map_err(|error| error.to_string())?;
        rx.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session_id);
        Err("The notch status is only available on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
fn show_session_menu(app: &AppHandle, window: &WebviewWindow, session_id: &str, x: f64, y: f64) -> Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    if !window.is_visible()? {
        return Ok(());
    }
    let session = {
        let s = shared().lock().unwrap();
        if s.menu_open {
            return Ok(());
        }
        action_session(&s.status, session_id, SessionAction::Open)?
    };
    let menu = Menu::new(app)?;
    for action in menu_actions(&session) {
        if action == SessionAction::Dismiss {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        menu.append(&MenuItem::with_id(app, format!("island:{}:{session_id}", action.key()), action.title(), true, None::<&str>)?)?;
    }
    // AppKit runs a nested loop here: pointer/focus updates must leave the
    // island alone, and no shared-state mutex may be held while tracking.
    shared().lock().unwrap().menu_open = true;
    let result = window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y));
    shared().lock().unwrap().menu_open = false;
    apply(app);
    result.context("Show session menu")
}

/// An app window read a session (its sidebar cleared the unread mark): the
/// island, the pet and the other windows clear it too.
#[tauri::command]
pub fn session_read(app: AppHandle, window: WebviewWindow, session_id: String) {
    if crate::window::is_overlay_window(window.label()) || session_id.is_empty() {
        return;
    }
    mark_session_read(&app, &session_id, Some(window.label()));
}

/// An app window reports the session it shows (None: none). Showing it in
/// the focused window reads it.
#[tauri::command]
pub fn island_viewing(app: AppHandle, window: WebviewWindow, session_id: Option<String>) {
    let label = window.label().to_string();
    if crate::window::is_overlay_window(&label) {
        return;
    }
    crate::window_session::note_session(&label, session_id.as_deref());
    let key = session_id.as_deref().map(id_key);
    {
        let mut s = shared().lock().unwrap();
        match &key {
            Some(key) => s.viewing.insert(label, key.clone()),
            None => s.viewing.remove(&label),
        };
    }
    if let Some(key) = key.filter(|_| window.is_focused().unwrap_or(false)) {
        mark_session_read(&app, &key, Some(window.label()));
    }
}

/// A closed window shows nothing; its label may be reused by a new one.
pub fn forget_window(label: &str) {
    shared().lock().unwrap().viewing.remove(label);
}

/// The island settings, or None where there is no island (off macOS).
#[tauri::command]
pub fn island_settings() -> Option<IslandSettings> {
    cfg!(target_os = "macos").then(|| shared().lock().unwrap().settings)
}

/// Each followed server's background connection state, by base URL (the
/// builtin by [`crate::servers::BUNDLED_KEY`]), for Settings → Connection.
/// A saved server that is not followed has no entry.
#[tauri::command]
pub fn app_server_watch_states() -> HashMap<String, WatchState> {
    shared()
        .lock()
        .unwrap()
        .feeds
        .watch_states()
        .into_iter()
        .map(|(server, watch)| (server.key().to_string(), watch))
        .collect()
}

/// Change some island settings and remember them; returns all of them.
#[tauri::command]
pub fn island_update_settings(app: AppHandle, patch: IslandSettingsPatch) -> Result<IslandSettings, String> {
    if !cfg!(target_os = "macos") {
        return Err("The notch status is only available on macOS.".into());
    }
    let current = shared().lock().unwrap().settings;
    let next = current.with(patch);
    crate::config::save_island_settings(&app, &next).map_err(|e| format!("{e:#}"))?;
    shared().lock().unwrap().settings = next;
    if next.enabled != current.enabled {
        feed_wake().notify_waiters();
    }
    if !next.show_finished {
        edit_unread(&app, Vec::clear);
    }
    log::info!("island: settings={next:?}");
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if next.enabled {
            if let Err(e) = ensure_island(&handle) {
                log::warn!("island: build failed: {e:#}");
            }
        }
        apply(&handle);
    });
    let _ = app.emit(ISLAND_SETTINGS_EVENT, next);
    Ok(next)
}

// ── AppKit ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod native {
    use super::{Rect, ScreenInfo};
    use objc2::runtime::NSObjectProtocol;
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSMainMenuWindowLevel, NSScreen, NSWindow, NSWindowCollectionBehavior};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    fn rect(r: NSRect) -> Rect {
        Rect { x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height }
    }

    fn info(screen: &NSScreen) -> ScreenInfo {
        let frame = rect(screen.frame());
        let visible = rect(screen.visibleFrame());
        // The notch APIs arrived in macOS 12; the app supports 11.
        let (safe_top, aux_left_width, aux_right_width) = if screen.respondsToSelector(sel!(safeAreaInsets))
            && screen.respondsToSelector(sel!(auxiliaryTopLeftArea))
        {
            (
                screen.safeAreaInsets().top,
                screen.auxiliaryTopLeftArea().size.width,
                screen.auxiliaryTopRightArea().size.width,
            )
        } else {
            (0.0, 0.0, 0.0)
        };
        let scale = screen.backingScaleFactor();
        ScreenInfo { frame, visible_top: visible.y + visible.height, safe_top, aux_left_width, aux_right_width, scale }
    }

    /// Every display, primary first. Empty off the main thread.
    pub fn screens() -> Vec<ScreenInfo> {
        let Some(mtm) = MainThreadMarker::new() else {
            return Vec::new();
        };
        NSScreen::screens(mtm).iter().map(|screen| info(&screen)).collect()
    }

    /// The pointer in screen coordinates (the same space as window frames).
    /// None off the main thread.
    pub fn mouse_location() -> Option<(f64, f64)> {
        MainThreadMarker::new()?;
        let point = NSEvent::mouseLocation();
        Some((point.x, point.y))
    }

    fn with_ns_window(window: &tauri::WebviewWindow, f: impl FnOnce(&NSWindow)) {
        if MainThreadMarker::new().is_none() {
            log::warn!("island: AppKit call off the main thread skipped");
            return;
        }
        match window.ns_window() {
            // SAFETY: Tauri hands out the window's live NSWindow, and we are on
            // the main thread, where AppKit objects may be used.
            Ok(ptr) if !ptr.is_null() => f(unsafe { &*(ptr as *const NSWindow) }),
            _ => log::warn!("island: no native window"),
        }
    }

    /// Above the menu bar, on every Space but full-screen ones (macOS keeps
    /// a plain window off them), out of Cmd-` cycling and Mission Control.
    pub fn configure(window: &tauri::WebviewWindow) {
        with_ns_window(window, |ns| {
            ns.setLevel(NSMainMenuWindowLevel + 3);
            ns.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            ns.setHasShadow(false);
            // Clicks pass through until the pointer is over the pill.
            ns.setIgnoresMouseEvents(true);
        });
    }

    /// Move to `frame` and bring to the front without activating the app.
    /// Clicks pass through until the pointer is over the pill again.
    pub fn place(window: &tauri::WebviewWindow, frame: Rect) {
        with_ns_window(window, |ns| {
            let target = NSRect::new(NSPoint::new(frame.x, frame.y), NSSize::new(frame.width, frame.height));
            ns.setFrame_display(target, true);
            ns.setIgnoresMouseEvents(true);
            ns.orderFrontRegardless();
        });
    }

    /// Let clicks through to whatever is below (the menu bar), or take them.
    pub fn set_click_through(window: &tauri::WebviewWindow, through: bool) {
        with_ns_window(window, |ns| ns.setIgnoresMouseEvents(through));
    }
}

#[cfg(test)]
#[path = "tests/island.rs"]
mod tests;
