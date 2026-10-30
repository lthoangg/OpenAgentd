//! Agent status island in the MacBook notch (macOS).
//!
//! A borderless black webview (`web/island.html`) sits over the notch, or
//! hangs from the middle of the menu bar on a Mac without one. It shows
//! whether any session is running or waiting on the user, and the sessions
//! that finished since you last looked at them (unread).
//!
//! It covers every server an app window is on (`servers::followed_servers`):
//! windows can each be on a different server, and a session waiting on you
//! matters whichever window it is in. A saved server no window is on is
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
//! user stopped, or a background idle compaction, has nothing new to read.
//! A session only finishes on its own server: a server that is no longer
//! followed (its last window closed) drops out without reporting anything.
//! Clicking a row opens it in a window on its server.
//!
//! A session working toward a goal shows how far it has got (the list's
//! `goal_turns_used` / `goal_max_turns`), and when its last turn ends the row
//! says what became of the goal, from the `goal` the finishing turn's
//! `desktop_notification` carries, so the notch and the notification agree.

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
const POINTER_NEAR: f64 = 240.0;
/// Unread sessions kept; older ones drop off.
const MAX_UNREAD: usize = 6;
/// How the memo records a turn that only compacted an idle session.
const IDLE_COMPACTION_STATUS: &str = "idle_compaction";
/// What a row calls the builtin sidecar, as the Backend connection panel does.
const BUILTIN_NAME: &str = "Builtin";

// ── Settings ────────────────────────────────────────────────────────────────

/// What the user chose in Settings → General (`desktop-island.json`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandSettings {
    pub enabled: bool,
    /// Also show while an OpenAgentd window is in front.
    pub show_when_frontmost: bool,
    /// Keep finished sessions ("Done" / "Failed") until they are opened.
    pub show_finished: bool,
    pub expand_on_hover: bool,
}

impl Default for IslandSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            show_when_frontmost: false,
            show_finished: true,
            expand_on_hover: true,
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
pub fn active_sessions(rows: Vec<SessionRow>, questions: &HashMap<String, String>, chat_root: Option<&str>) -> Vec<IslandSession> {
    let mut sessions: Vec<IslandSession> = rows
        .into_iter()
        .filter(|row| row.parent_session_id.is_none() && (row.running || row.background_work || row.needs_input))
        .map(|row| {
            let state = if row.needs_input { SessionState::NeedsInput } else { SessionState::Running };
            let question = row.needs_input.then(|| questions.get(&id_key(&row.id)).cloned()).flatten();
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
                question,
                server: None,
                server_id: None,
                goal,
            }
        })
        .collect();
    // Stable: keeps the server's order within each group.
    sessions.sort_by_key(|s| s.state != SessionState::NeedsInput);
    sessions
}

/// Sessions that left the active list, as finished rows. A turn the user
/// stopped is their own doing, and an idle compaction only summarised what
/// was already read; neither is reported. Without an outcome (a missed
/// event) the turn counts as done. A goal's last turn carries what became of
/// the goal (`goals`, from its notification).
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
                Some("stopped" | IDLE_COMPACTION_STATUS) => return None,
                Some("error" | "failed") => SessionState::Failed,
                _ => SessionState::Done,
            };
            let goal = goals.get(&key).cloned();
            Some(IslandSession { state, question: None, goal, ..session.clone() })
        })
        .collect()
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
    /// Its active sessions, as last fetched.
    pub sessions: Vec<IslandSession>,
    pub watch: WatchState,
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
        self.servers.insert(server.clone(), ServerFeed { name, sessions: Vec::new(), watch: WatchState::Connecting });
        true
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
        let finished = if show_finished { newly_finished(&feed.sessions, &next, statuses, goals) } else { Vec::new() };
        let sessions_changed = feed.sessions != next;
        // A fresh list means the server is reachable.
        let watch_changed = std::mem::replace(&mut feed.watch, WatchState::Connected) != WatchState::Connected;
        let unread_changed = merge_unread(&mut self.unread, finished, &next, viewed);
        feed.sessions = next;
        sessions_changed || unread_changed || watch_changed
    }

    /// Empty `server`'s active list without reporting a finish: stale
    /// "running" rows are worse than none while it can't be reached. What
    /// finished before stays unread. True when it changed.
    pub fn clear_sessions(&mut self, server: &ServerId) -> bool {
        self.servers.get_mut(server).is_some_and(|feed| !std::mem::take(&mut feed.sessions).is_empty())
    }

    /// The island's lists (see [`merged_lists`]).
    pub fn lists(&self) -> (Vec<IslandSession>, Vec<IslandSession>) {
        merged_lists(&self.servers, &self.unread)
    }
}

/// The island's two lists across `servers`: waiting sessions first, each
/// session once (a server reached through two URLs reports it twice), and,
/// with more than one server in play (connected, or holding unread rows),
/// each row named after its server. An enabled server that is off does not
/// make the others' rows carry a name.
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
    let mut sessions: Vec<IslandSession> = servers
        .values()
        .flat_map(|feed| &feed.sessions)
        .filter(|session| seen.insert(id_key(&session.id)))
        .map(label)
        .collect();
    // Stable: keeps each server's order within each group.
    sessions.sort_by_key(|s| s.state != SessionState::NeedsInput);
    let unread = unread.iter().filter(|u| seen.insert(id_key(&u.id))).map(label).collect();
    (sessions, unread)
}

/// What the stream told us between refetches: each waiting session's
/// question, how each turn ended, and what became of a goal whose last turn
/// just ended.
#[derive(Debug, Default)]
pub struct FeedMemo {
    questions: HashMap<String, String>,
    statuses: HashMap<String, String>,
    goals: HashMap<String, IslandGoal>,
    /// Sessions running an idle compaction, kept out of the list.
    compacting: HashSet<String>,
    /// Path of the backend's Chat workspace, fetched once per connection.
    chat_root: Option<String>,
}

impl FeedMemo {
    /// Record what the event says; true when the active list may have changed.
    pub fn note(&mut self, event: &SseEvent) -> bool {
        let data = || serde_json::from_str::<serde_json::Value>(&event.data).unwrap_or_default();
        match event.event.as_str() {
            "session_turn_started" => {
                let data = data();
                if let Some(id) = data["session_id"].as_str() {
                    let key = id_key(id);
                    self.statuses.remove(&key);
                    self.goals.remove(&key);
                    if data["idle_compaction"].as_bool() == Some(true) {
                        self.compacting.insert(key);
                    } else {
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
                    let status = if data["idle_compaction"].as_bool() == Some(true) { IDLE_COMPACTION_STATUS } else { status };
                    self.statuses.insert(key, status.to_string());
                }
                true
            }
            "desktop_notification" => {
                let data = data();
                // A goal's last turn: its row says what became of the goal.
                // The turn's own completion event follows and refetches.
                if data["kind"].as_str() == Some("assistant_done") {
                    if let (Some(id), Some(goal)) = (data["session_id"].as_str(), data["goal"].as_str().and_then(IslandGoal::outcome)) {
                        self.goals.insert(id_key(id), goal);
                    }
                    return false;
                }
                if data["kind"].as_str() != Some("input_needed") {
                    return false;
                }
                if let (Some(id), Some(body)) = (data["session_id"].as_str(), data["body"].as_str()) {
                    let body = body.trim();
                    if !body.is_empty() {
                        self.questions.insert(id_key(id), body.to_string());
                    }
                }
                true
            }
            _ => false,
        }
    }

    /// Drop what no longer applies once `sessions` is current.
    fn settle(&mut self, sessions: &[IslandSession]) {
        self.questions.retain(|key, _| {
            sessions.iter().any(|s| s.state == SessionState::NeedsInput && id_key(&s.id) == *key)
        });
        self.statuses.retain(|key, _| sessions.iter().any(|s| id_key(&s.id) == *key));
        self.goals.retain(|key, _| sessions.iter().any(|s| id_key(&s.id) == *key));
    }

    /// Drop sessions that are only compacting: a background summary is not work to watch.
    fn hide_compacting(&self, sessions: &mut Vec<IslandSession>) {
        sessions.retain(|s| !self.compacting.contains(&id_key(&s.id)));
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

/// Clamp a pill size the webview asked for to the canvas.
pub fn fit_size(width: f64, height: f64) -> (f64, f64) {
    let clamp = |value: f64, max: f64| if value.is_finite() { value.clamp(MIN_SIZE, max) } else { MIN_SIZE };
    (clamp(width, CANVAS_WIDTH).ceil(), clamp(height, CANVAS_HEIGHT).ceil())
}

/// A box centred on the notch (or the screen), flush with the top: the
/// canvas, or the pill inside it.
pub fn island_frame(screen: &ScreenInfo, width: f64, height: f64) -> Rect {
    let (width, height) = fit_size(width, height);
    let center = if screen.has_notch() {
        let notch = notch_geometry(screen).width;
        screen.frame.x + screen.aux_left_width + notch / 2.0
    } else {
        screen.frame.x + screen.frame.width / 2.0
    };
    Rect {
        x: (center - width / 2.0).round(),
        y: screen.frame.y + screen.frame.height - height,
        width,
        height,
    }
}

/// The pill's frame: [`island_frame`] moved sideways by `shift` (negative is
/// left), held inside the canvas. The compact pill shifts left so it ends at
/// the notch's right edge and leaves the status icons beside it uncovered.
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
}

impl Shared {
    /// Merge the feeds into `status`. The new snapshot, if it changed.
    fn rebuild(&mut self) -> Option<IslandStatus> {
        let (sessions, unread) = self.feeds.lists();
        if self.status.sessions == sessions && self.status.unread == unread {
            return None;
        }
        self.status = IslandStatus { seq: self.status.seq + 1, sessions, unread };
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
        })
    })
}

/// Wakes the feed when the feature is switched on or off.
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
/// The feed runs on every platform: the desktop pet (`pet.rs`) follows it
/// too. It does nothing while neither the island nor the pet is on.
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
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let pill = {
                let s = shared().lock().unwrap();
                if s.menu_open {
                    return;
                }
                // The canvas may have moved or hidden since it was read.
                if s.canvas != Some(canvas) {
                    return;
                }
                s.pill
            };
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
                    mark_read(&handle, &key);
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

/// The feed runs while the island or the pet is on.
fn is_enabled() -> bool {
    // Never hold the island's lock while taking the pet's.
    let island = shared().lock().unwrap().settings.enabled;
    island || crate::pet::is_enabled()
}

/// The island or the pet was switched on or off: start or stop the feed now.
pub fn wake_feed() {
    feed_wake().notify_waiters();
}

/// Wait up to `duration`, or less if the feature is switched on or off.
async fn pause(duration: Duration) {
    let _ = tokio::time::timeout(duration, feed_wake().notified()).await;
}

/// Keep one feed per server an app window is on: start following a server
/// when a window connects to it or it is enabled, stop when its last window
/// leaves it and it is not enabled.
async fn run_feed(app: AppHandle) {
    let mut tasks: HashMap<ServerId, tauri::async_runtime::JoinHandle<()>> = HashMap::new();
    loop {
        let saved = shared().lock().unwrap().saved.clone();
        let wanted = if is_enabled() {
            crate::servers::app_followed_servers(&app, &crate::servers::enabled_servers(&saved)).await
        } else {
            Vec::new()
        };
        // A feed also ends by itself when the feature is switched off; one
        // switched straight back on is started again below.
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
            let name = server.display_name(BUILTIN_NAME, &saved);
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

/// Re-read the saved servers (kept in memory so the supervisor does not
/// read the file every tick). An unreadable file keeps what was there.
fn refresh_saved(app: &AppHandle) {
    if let Ok(config) = crate::config::load_app_backend_config(app) {
        shared().lock().unwrap().saved = config.servers;
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

/// Follow one server's event stream, reconnecting with a backoff, until the
/// feature is turned off (or [`run_feed`] stops it).
async fn follow_server(app: AppHandle, server: ServerId) {
    let client = stream_client();
    let mut failures: u32 = 0;
    let retry_max = if server == ServerId::Bundled { RETRY_MAX } else { RETRY_MAX_REMOTE };
    while is_enabled() {
        let Some((base, token)) = crate::servers::endpoint(&app, &server).await else {
            pause(RETRY_BASE).await;
            continue;
        };
        if let Err(e) = follow(&app, &client, &server, &base, token.as_deref(), &mut failures).await {
            failures = failures.saturating_add(1);
            let rejected = e.downcast_ref::<AuthRejected>().is_some();
            let watch = if rejected { WatchState::KeyRejected } else { WatchState::Reconnecting };
            edit_feeds(&app, |feeds| {
                let emptied = feeds.clear_sessions(&server);
                feeds.set_watch(&server, watch) || emptied
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

/// Follow `server`'s event stream at `base` until it fails or the feature
/// is turned off. Resets `failures` once connected.
async fn follow(
    app: &AppHandle,
    client: &reqwest::Client,
    server: &ServerId,
    base: &str,
    token: Option<&str>,
    failures: &mut u32,
) -> Result<()> {
    let base = base.trim_end_matches('/');
    let mut memo = FeedMemo::default();
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
    refresh(app, client, server, base, token, &mut memo).await?;
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
        if !is_enabled() {
            return Ok(());
        }
        let now = Instant::now();
        let active = shared().lock().unwrap().feeds.is_active(server);
        let due = refresh_at.is_some_and(|at| now >= at)
            || (active && now.duration_since(last_refresh) >= SAFETY_REFRESH);
        if due {
            refresh_at = None;
            last_refresh = now;
            refresh(app, client, server, base, token, &mut memo).await?;
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
    let mut next = active_sessions(page.data, &memo.questions, memo.chat_root.as_deref());
    memo.hide_compacting(&mut next);
    publish(app, server, next, memo);
    Ok(())
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
        // The outcomes of sessions that just left the list are read here,
        // before `settle` drops them.
        let changed = s.feeds.update(server, next.clone(), &memo.statuses, &memo.goals, viewed.as_deref(), show_finished);
        changed.then(|| s.rebuild()).flatten()
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

/// Send a new snapshot to the island and the pet.
fn send_status(app: &AppHandle, status: &IslandStatus) {
    let _ = app.emit_to(ISLAND_WINDOW, ISLAND_STATUS_EVENT, status);
    crate::pet::status_changed(app, status);
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

/// The session on screen in the focused app window, while OpenAgentd is in front.
pub(crate) fn viewed_session(app: &AppHandle) -> Option<String> {
    let label = crate::window::target_window_label(app);
    let s = shared().lock().unwrap();
    if !s.frontmost {
        return None;
    }
    s.viewing.get(&label).cloned()
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
        mark_read(app, &id_key(session_id));
        return Ok(());
    }
    if action == SessionAction::NewWindow {
        crate::window::create_app_window_on_server(app, server, &format!("/{session_id}")).await?;
        mark_read(app, &id_key(session_id));
        return Ok(());
    }
    open_session_on_server(app, server, session_id).await?;
    mark_read(app, &id_key(session_id));
    Ok(())
}

/// Open `session_id` in an app window on `server`, opening a window there
/// if none is on it. Also used by the desktop pet.
pub(crate) async fn open_session_on_server(app: &AppHandle, server: ServerId, session_id: &str) -> Result<()> {
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
            let payload = serde_json::json!({ "sessionId": session_id });
            app.emit_to(target.label(), "desktop-notification-clicked", payload)?;
            crate::window::show_window(&target);
        }
        // No window is on that server (an enabled saved server watched in
        // the background, or the last window there just closed): open one
        // on it. Never on another server, where the session is not found.
        None => {
            crate::window::create_app_window_on_server(app, server, &format!("/{session_id}")).await?;
        }
    }
    Ok(())
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

/// The × on an unread row: forget it without opening it.
#[tauri::command]
pub fn island_dismiss(app: AppHandle, window: WebviewWindow, session_id: String) {
    if window.label() == ISLAND_WINDOW {
        mark_read(&app, &id_key(&session_id));
    }
}

/// An app window reports the session it shows (None: none). Showing it in
/// the focused window reads it.
#[tauri::command]
pub fn island_viewing(app: AppHandle, window: WebviewWindow, session_id: Option<String>) {
    let label = window.label().to_string();
    if crate::window::is_overlay_window(&label) {
        return;
    }
    let key = session_id.as_deref().map(id_key);
    {
        let mut s = shared().lock().unwrap();
        match &key {
            Some(key) => s.viewing.insert(label, key.clone()),
            None => s.viewing.remove(&label),
        };
    }
    if let Some(key) = key.filter(|_| window.is_focused().unwrap_or(false)) {
        mark_read(&app, &key);
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
        ScreenInfo { frame, visible_top: visible.y + visible.height, safe_top, aux_left_width, aux_right_width }
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
mod tests {
    use super::*;

    fn row(id: &str, title: Option<&str>, running: bool, needs_input: bool) -> SessionRow {
        SessionRow {
            id: id.into(),
            title: title.map(Into::into),
            workspace: Some("/Users/me/code/openagentd".into()),
            running,
            needs_input,
            background_work: false,
            parent_session_id: None,
            goal_status: None,
            goal_turns_used: None,
            goal_max_turns: None,
        }
    }

    fn session(id: &str, state: SessionState) -> IslandSession {
        IslandSession { id: id.into(), title: format!("T{id}"), workspace: None, state, question: None, server: None, server_id: None, goal: None }
    }

    const REMOTE: &str = "http://192.168.1.30:4082";
    const REMOTE_NAME: &str = "LAN server";

    fn remote() -> ServerId {
        ServerId::External(REMOTE.into())
    }

    #[test]
    fn session_menus_only_offer_dismiss_for_finished_work() {
        for state in [SessionState::Running, SessionState::NeedsInput, SessionState::Done, SessionState::Failed] {
            let item = session("a", state);
            let actions = menu_actions(&item);
            assert_eq!(actions[..2], [SessionAction::Open, SessionAction::NewWindow]);
            assert_eq!(actions.contains(&SessionAction::Dismiss), matches!(state, SessionState::Done | SessionState::Failed));
        }
    }

    #[test]
    fn menu_actions_revalidate_the_target_and_keep_its_server() {
        let mut item = session("r", SessionState::Done);
        item.server_id = Some(remote());
        let mut status = IslandStatus { unread: vec![item], ..IslandStatus::default() };
        for action in [SessionAction::Open, SessionAction::NewWindow, SessionAction::Dismiss] {
            assert_eq!(action_session(&status, "r", action).unwrap().server_id, Some(remote()));
        }
        assert!(action_session(&status, "unknown", SessionAction::Open).is_err());
        status.unread.clear();
        assert!(action_session(&status, "r", SessionAction::NewWindow).is_err());
        let mut running = session("r", SessionState::Running);
        running.server_id = Some(remote());
        status.sessions.push(running);
        assert!(action_session(&status, "r", SessionAction::Dismiss).is_err());
    }

    #[test]
    fn menu_actions_cannot_open_sessions_without_a_known_server() {
        let status = IslandStatus { sessions: vec![session("a", SessionState::Running)], ..IslandStatus::default() };
        assert!(action_session(&status, "a", SessionAction::Open).is_err());
        assert!(action_session(&status, "a", SessionAction::NewWindow).is_err());
    }

    #[test]
    fn menu_events_are_scoped_to_the_island_and_encode_the_selected_session() {
        for action in [SessionAction::Open, SessionAction::NewWindow, SessionAction::Dismiss] {
            let id = format!("island:{}:a-b-c", action.key());
            assert_eq!(menu_selection(&id), Some((action, "a-b-c")));
        }
        assert_eq!(menu_selection("settings"), None);
        assert_eq!(menu_selection("island:delete:a"), None);
        assert_eq!(menu_selection("island:open"), None);
    }

    fn ids(sessions: &[IslandSession]) -> Vec<&str> {
        sessions.iter().map(|s| s.id.as_str()).collect()
    }

    /// The builtin and a remote server both followed, with these active lists.
    fn two_servers(on_builtin: &[&str], on_remote: &[&str]) -> Feeds {
        let mut feeds = Feeds::default();
        feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
        feeds.join(&remote(), REMOTE_NAME.into());
        let running = |list: &[&str]| -> Vec<IslandSession> { list.iter().map(|id| session(id, SessionState::Running)).collect() };
        feeds.update(&ServerId::Bundled, running(on_builtin), &HashMap::new(), &HashMap::new(), None, true);
        feeds.update(&remote(), running(on_remote), &HashMap::new(), &HashMap::new(), None, true);
        feeds
    }

    // The notch used to follow one server at a time, so sessions running or
    // waiting on you on any other server never showed.
    #[test]
    fn sessions_from_every_followed_server_are_shown_and_named() {
        let mut feeds = two_servers(&["a", "b"], &["r"]);
        let mut asked = session("q", SessionState::NeedsInput);
        asked.question = Some("Which branch?".into());
        feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running), asked], &HashMap::new(), &HashMap::new(), None, true);

        let (sessions, _) = feeds.lists();
        assert_eq!(ids(&sessions), ["q", "a", "r"], "waiting first, across servers");
        let servers: Vec<Option<&str>> = sessions.iter().map(|s| s.server.as_deref()).collect();
        assert_eq!(servers, [Some(BUILTIN_NAME), Some(BUILTIN_NAME), Some(REMOTE_NAME)]);
    }

    #[test]
    fn one_server_needs_no_name_on_its_rows() {
        let mut feeds = Feeds::default();
        feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
        feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
        assert_eq!(feeds.lists().0[0].server, None);
    }

    // A saved server watched in the background but switched off (or away)
    // must not make the builtin's rows carry a name.
    #[test]
    fn an_unreachable_server_does_not_force_names_on_the_others_rows() {
        let mut feeds = Feeds::default();
        feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
        feeds.join(&remote(), REMOTE_NAME.into());
        feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
        assert_eq!(feeds.lists().0[0].server, None, "the remote never connected");

        feeds.update(&remote(), vec![session("r", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
        assert_eq!(feeds.lists().0[0].server.as_deref(), Some(BUILTIN_NAME), "both connected");

        assert!(feeds.clear_sessions(&remote()));
        assert!(feeds.set_watch(&remote(), WatchState::Reconnecting));
        assert_eq!(feeds.lists().0[0].server, None, "only the builtin is in play again");
    }

    #[test]
    fn watch_states_follow_the_connection_and_a_list_means_connected() {
        let mut feeds = Feeds::default();
        feeds.join(&remote(), REMOTE_NAME.into());
        assert_eq!(feeds.watch_states(), [(remote(), WatchState::Connecting)]);
        assert!(feeds.set_watch(&remote(), WatchState::KeyRejected));
        assert!(!feeds.set_watch(&remote(), WatchState::KeyRejected), "no change");
        assert!(feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true), "becoming connected is a change");
        assert_eq!(feeds.watch_states(), [(remote(), WatchState::Connected)]);
        assert!(!feeds.set_watch(&ServerId::Bundled, WatchState::Reconnecting), "not followed");
        assert_eq!(serde_json::to_value(WatchState::KeyRejected).unwrap(), "key_rejected");
    }

    #[test]
    fn a_rename_updates_the_label_the_rows_carry() {
        let mut feeds = two_servers(&["a"], &["r"]);
        assert!(feeds.rename(&remote(), "Renamed"));
        assert!(!feeds.rename(&remote(), "Renamed"));
        assert_eq!(feeds.lists().0[1].server.as_deref(), Some("Renamed"));
    }

    #[test]
    fn a_key_rejection_is_told_apart_from_other_failures() {
        let rejected: anyhow::Error = AuthRejected(401).into();
        assert!(rejected.downcast_ref::<AuthRejected>().is_some());
        assert!(rejected.to_string().contains("401"));
        let other = anyhow::anyhow!("event stream closed");
        assert!(other.downcast_ref::<AuthRejected>().is_none());
    }

    // Switching the followed server used to diff the old server's list
    // against the new one's: every session still running there turned Done.
    #[test]
    fn a_server_dropping_out_reports_nothing_as_finished() {
        let mut feeds = two_servers(&["a"], &["r"]);
        assert!(feeds.forget(&remote()));
        let (sessions, unread) = feeds.lists();
        assert_eq!(ids(&sessions), ["a"]);
        assert!(unread.is_empty());
    }

    // Following another server used to wipe the previous server's unread rows.
    #[test]
    fn unread_survives_activity_on_another_server() {
        let mut feeds = two_servers(&["a"], &["r"]);
        assert!(feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true));
        assert_eq!(ids(&feeds.lists().1), ["r"]);

        feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running), session("b", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
        let (_, unread) = feeds.lists();
        assert_eq!(ids(&unread), ["r"]);
        assert_eq!(unread[0].server.as_deref(), Some(REMOTE_NAME));
        assert_eq!(unread[0].server_id, Some(remote()), "a click opens it on its own server");
    }

    #[test]
    fn a_server_that_cannot_be_reached_empties_its_list_but_keeps_unread() {
        let mut feeds = two_servers(&["a"], &["r", "s"]);
        feeds.update(&remote(), vec![session("s", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
        assert!(feeds.clear_sessions(&remote()));
        let (sessions, unread) = feeds.lists();
        assert_eq!(ids(&sessions), ["a"]);
        assert_eq!(ids(&unread), ["r"], "s did not finish: the server went away");
        assert!(!feeds.clear_sessions(&remote()), "already empty");
    }

    #[test]
    fn a_forgotten_server_takes_its_unread_rows_with_it() {
        let mut feeds = two_servers(&["a"], &["r"]);
        feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true);
        feeds.update(&ServerId::Bundled, vec![], &HashMap::new(), &HashMap::new(), None, true);
        assert_eq!(ids(&feeds.lists().1), ["a", "r"]);
        feeds.forget(&remote());
        assert_eq!(ids(&feeds.lists().1), ["a"]);
    }

    #[test]
    fn a_list_from_a_server_no_longer_followed_is_ignored() {
        let mut feeds = two_servers(&["a"], &[]);
        feeds.forget(&remote());
        assert!(!feeds.update(&remote(), vec![session("late", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true));
        assert_eq!(ids(&feeds.lists().0), ["a"]);
    }

    #[test]
    fn the_same_session_seen_through_two_urls_is_listed_once() {
        let lan = ServerId::External("http://192.168.1.40:4082".into());
        let mut feeds = Feeds::default();
        feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
        feeds.join(&lan, "This Mac over LAN".into());
        feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
        feeds.update(&lan, vec![session("A", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
        assert_eq!(ids(&feeds.lists().0), ["a"]);
    }

    #[test]
    fn a_finish_keeps_its_outcome_and_respects_show_finished() {
        let mut feeds = two_servers(&[], &["r", "s"]);
        let statuses = HashMap::from([(id_key("r"), "error".to_string())]);
        feeds.update(&remote(), vec![session("s", SessionState::Running)], &statuses, &HashMap::new(), None, true);
        assert_eq!(feeds.lists().1[0].state, SessionState::Failed);

        feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, false);
        assert_eq!(ids(&feeds.lists().1), ["r"], "s finished while finished sessions are hidden");
    }

    fn event(name: &str, data: serde_json::Value) -> SseEvent {
        SseEvent { event: name.into(), data: data.to_string() }
    }

    #[test]
    fn waiting_sessions_come_first_and_idle_or_child_rows_are_dropped() {
        let mut child = row("c", Some("child"), true, false);
        child.parent_session_id = Some("a".into());
        let rows = vec![
            row("a", Some("Refactor"), true, false),
            row("b", Some("Ask"), true, true),
            row("idle", Some("Idle"), false, false),
            child,
            row("d", Some("Docs"), true, false),
        ];
        let sessions = active_sessions(rows, &HashMap::new(), None);
        let ids: Vec<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["b", "a", "d"]);
        assert_eq!(sessions[0].state, SessionState::NeedsInput);
        assert_eq!(sessions[1].workspace.as_deref(), Some("openagentd"));
    }

    #[test]
    fn a_lead_waiting_on_its_subagents_is_still_working() {
        let mut waiting = row("a", Some("Delegating"), false, false);
        waiting.background_work = true;
        let sessions = active_sessions(vec![waiting], &HashMap::new(), None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].state, SessionState::Running);

        // Its turn completed, but it stays in the list: not finished, not unread.
        let mut memo = FeedMemo::default();
        let done = serde_json::json!({"session_id": "a", "status": "completed"});
        assert!(memo.note(&event("session_turn_completed", done)));
        assert!(newly_finished(&sessions, &sessions, &memo.statuses, &memo.goals).is_empty());
    }

    #[test]
    fn an_older_backend_without_background_work_still_parses() {
        let page: SessionPage = serde_json::from_str(r#"{"data": [{"id": "a", "running": true}]}"#).unwrap();
        assert!(!page.data[0].background_work);
        let page: SessionPage = serde_json::from_str(r#"{"data": [{"id": "a", "background_work": true}]}"#).unwrap();
        assert!(page.data[0].background_work);
    }

    #[test]
    fn a_blank_title_reads_untitled_and_the_question_follows_the_session() {
        let questions = HashMap::from([(id_key("AB-CD"), "Keep the old format?".to_string())]);
        let sessions = active_sessions(vec![row("ab-cd", Some("  "), false, true)], &questions, None);
        assert_eq!(sessions[0].title, "Untitled session");
        assert_eq!(sessions[0].question.as_deref(), Some("Keep the old format?"));
    }

    #[test]
    fn a_session_in_the_chat_workspace_is_labelled_chat() {
        let mut chat = row("a", Some("Hi"), true, false);
        chat.workspace = Some("/Users/me/".into());
        let mut project = row("b", Some("Code"), true, false);
        project.workspace = Some("/Users/me/code/web".into());
        let sessions = active_sessions(vec![chat, project], &HashMap::new(), Some("/Users/me"));
        assert_eq!(sessions[0].workspace.as_deref(), Some("Chat"));
        assert_eq!(sessions[1].workspace.as_deref(), Some("web"));
    }

    #[test]
    fn a_session_that_leaves_the_list_is_finished_with_its_outcome() {
        let mut asked = session("b", SessionState::NeedsInput);
        asked.question = Some("Which branch?".into());
        let previous = [session("a", SessionState::Running), asked, session("c", SessionState::Running)];
        let statuses = HashMap::from([(id_key("b"), "error".to_string())]);
        let finished = newly_finished(&previous, &previous[2..], &statuses, &HashMap::new());
        let got: Vec<(&str, SessionState)> = finished.iter().map(|s| (s.id.as_str(), s.state)).collect();
        assert_eq!(got, [("a", SessionState::Done), ("b", SessionState::Failed)]);
        assert_eq!(finished[1].question, None);
    }

    #[test]
    fn stopped_and_idle_compaction_turns_are_not_finished() {
        let previous = [session("a", SessionState::Running), session("b", SessionState::Running)];
        let statuses = HashMap::from([
            (id_key("a"), "stopped".to_string()),
            (id_key("b"), IDLE_COMPACTION_STATUS.to_string()),
        ]);
        assert!(newly_finished(&previous, &[], &statuses, &HashMap::new()).is_empty());
    }

    #[test]
    fn a_session_working_toward_a_goal_shows_the_turn_it_is_on() {
        let goal = |mut r: SessionRow, status: &str| {
            (r.goal_status, r.goal_turns_used, r.goal_max_turns) = (Some(status.into()), Some(6), Some(50));
            r
        };
        let mut between = goal(row("b", Some("Waits on subagents"), false, false), "active");
        between.background_work = true;
        let rows = vec![goal(row("a", Some("Migrate"), true, false), "active"), between, goal(row("c", Some("Paused one"), true, false), "paused")];
        let sessions = active_sessions(rows, &HashMap::new(), None);
        let goals: Vec<Option<IslandGoal>> = sessions.iter().map(|s| s.goal.clone()).collect();
        assert_eq!(
            goals,
            [Some(IslandGoal::Active { turn: 7, max_turns: 50 }), Some(IslandGoal::Active { turn: 6, max_turns: 50 }), None],
            "the running turn, the last one between turns, and nothing for a paused goal's own turn"
        );
        assert_eq!(serde_json::to_value(&goals[0]).unwrap(), serde_json::json!({"status": "active", "turn": 7, "maxTurns": 50}));

        let page: SessionPage = serde_json::from_str(r#"{"data": [{"id": "a", "running": true}]}"#).unwrap();
        assert_eq!(page.data[0].goal_status, None, "an older backend has no goals");
    }

    #[test]
    fn a_goal_s_last_turn_says_what_became_of_the_goal() {
        let mut memo = FeedMemo::default();
        let note = serde_json::json!({"kind": "assistant_done", "session_id": "a", "title": "Goal achieved · web", "goal": "achieved"});
        assert!(!memo.note(&event("desktop_notification", note)), "the turn's completion refetches");
        let blocked = serde_json::json!({"kind": "assistant_done", "session_id": "b", "goal": "blocked"});
        memo.note(&event("desktop_notification", blocked));

        let previous = [session("a", SessionState::Running), session("b", SessionState::Running), session("c", SessionState::Running)];
        let finished = newly_finished(&previous, &[], &memo.statuses, &memo.goals);
        let got: Vec<(&str, SessionState, Option<IslandGoal>)> = finished.iter().map(|s| (s.id.as_str(), s.state, s.goal.clone())).collect();
        assert_eq!(
            got,
            [
                ("a", SessionState::Done, Some(IslandGoal::Achieved)),
                ("b", SessionState::Done, Some(IslandGoal::Blocked)),
                ("c", SessionState::Done, None),
            ]
        );
        assert_eq!(serde_json::to_value(&finished[0].goal).unwrap(), serde_json::json!({"status": "achieved"}));

        // A new turn (the user moved on) is not the goal's.
        assert!(memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"}))));
        assert!(!memo.goals.contains_key("a"));
        assert!(memo.note(&event("session_goal", serde_json::json!({"session_id": "a"}))), "goal progress refetches");
    }

    #[test]
    fn unread_is_newest_first_and_skips_the_session_on_screen() {
        let mut unread = vec![session("old", SessionState::Done)];
        let finished = vec![session("a", SessionState::Done), session("seen", SessionState::Failed)];
        assert!(merge_unread(&mut unread, finished, &[], Some(&id_key("seen"))));
        let ids: Vec<&str> = unread.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a", "old"]);

        assert!(!merge_unread(&mut unread, vec![], &[], None), "nothing changed");
    }

    #[test]
    fn unread_drops_a_session_that_runs_again_and_keeps_the_newest_few() {
        let mut unread = vec![session("a", SessionState::Done)];
        assert!(merge_unread(&mut unread, vec![], &[session("a", SessionState::Running)], None));
        assert!(unread.is_empty());

        let finished: Vec<IslandSession> = (0..MAX_UNREAD + 2).map(|i| session(&format!("s{i}"), SessionState::Done)).collect();
        merge_unread(&mut unread, finished, &[], None);
        assert_eq!(unread.len(), MAX_UNREAD);
        assert_eq!(unread[0].id, "s0");
    }

    #[test]
    fn an_idle_compaction_stays_out_of_the_list_and_is_not_news() {
        let mut memo = FeedMemo::default();
        let start = serde_json::json!({"session_id": "a", "idle_compaction": true});
        assert!(memo.note(&event("session_turn_started", start)));
        let mut next = vec![session("a", SessionState::Running), session("b", SessionState::Running)];
        memo.hide_compacting(&mut next);
        assert_eq!(next.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b"]);

        let end = serde_json::json!({"session_id": "a", "status": "completed", "idle_compaction": true});
        assert!(memo.note(&event("session_turn_completed", end)));
        assert_eq!(memo.statuses.get("a").map(String::as_str), Some(IDLE_COMPACTION_STATUS));
        let mut next = vec![session("a", SessionState::Running)];
        memo.hide_compacting(&mut next);
        assert_eq!(next.len(), 1, "the compaction is over");
    }

    #[test]
    fn turn_events_trigger_a_refetch_and_others_do_not() {
        let mut memo = FeedMemo::default();
        assert!(memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"}))));
        assert!(memo.note(&event("title_update", serde_json::json!({}))));
        assert!(!memo.note(&event("config_changed", serde_json::json!({}))));
        assert!(!memo.note(&event("desktop_notification", serde_json::json!({"kind": "assistant_done"}))));
        // A subagent ending can finish its lead, but leaves no outcome to keep.
        let subagent = serde_json::json!({"session_id": "s", "status": "completed", "parent_session_id": "a"});
        assert!(memo.note(&event("session_turn_completed", subagent)));
        assert!(memo.statuses.is_empty());
    }

    #[test]
    fn the_memo_keeps_questions_and_outcomes_only_while_they_apply() {
        let mut memo = FeedMemo::default();
        let ask = serde_json::json!({"kind": "input_needed", "session_id": "a", "body": "Which branch?"});
        assert!(memo.note(&event("desktop_notification", ask)));
        let done = serde_json::json!({"session_id": "b", "status": "error"});
        assert!(memo.note(&event("session_turn_completed", done)));
        assert_eq!(memo.questions.get("a").map(String::as_str), Some("Which branch?"));
        assert_eq!(memo.statuses.get("b").map(String::as_str), Some("error"));

        memo.settle(&[session("a", SessionState::Running)]);
        assert!(memo.questions.is_empty(), "answered: the question no longer applies");
        assert!(memo.statuses.is_empty());

        memo.statuses.insert("a".into(), "completed".into());
        assert!(memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"}))));
        assert!(memo.statuses.is_empty(), "a new turn forgets the last outcome");
    }

    #[test]
    fn sse_events_survive_chunks_split_anywhere() {
        let wire = "event: session_turn_started\r\ndata: {\"session_id\":\"a\u{e9}\"}\r\n\r\n: ping\r\n\r\nevent: title_update\r\ndata: one\r\ndata: two\r\n\r\n";
        let bytes = wire.as_bytes();
        for split in 0..bytes.len() {
            let mut parser = SseParser::default();
            let mut events = parser.push(&bytes[..split]);
            events.extend(parser.push(&bytes[split..]));
            assert_eq!(
                events,
                vec![
                    SseEvent { event: "session_turn_started".into(), data: "{\"session_id\":\"a\u{e9}\"}".into() },
                    SseEvent { event: "title_update".into(), data: "one\ntwo".into() },
                ],
                "split at {split}"
            );
        }
    }

    fn notched() -> ScreenInfo {
        // A 14" MacBook Pro at its default scaling.
        ScreenInfo {
            frame: Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 },
            visible_top: 944.0,
            safe_top: 38.0,
            aux_left_width: 662.0,
            aux_right_width: 662.0,
        }
    }

    fn external() -> ScreenInfo {
        ScreenInfo {
            frame: Rect { x: 1512.0, y: -200.0, width: 2560.0, height: 1440.0 },
            visible_top: 1215.0,
            safe_top: 0.0,
            aux_left_width: 0.0,
            aux_right_width: 0.0,
        }
    }

    #[test]
    fn the_notched_display_wins_and_otherwise_the_primary_one() {
        assert_eq!(pick_screen(&[external(), notched()]), Some(notched()));
        assert_eq!(pick_screen(&[external()]), Some(external()));
        assert_eq!(pick_screen(&[]), None);
    }

    #[test]
    fn notch_geometry_comes_from_the_menu_bar_areas_beside_it() {
        assert_eq!(notch_geometry(&notched()), NotchGeometry { has_notch: true, width: 188.0, height: 38.0 });
        let plain = notch_geometry(&external());
        assert_eq!(plain, NotchGeometry { has_notch: false, width: FALLBACK_PILL_WIDTH, height: 25.0 });

        let mut hidden_menu_bar = external();
        hidden_menu_bar.visible_top = hidden_menu_bar.frame.y + hidden_menu_bar.frame.height;
        assert_eq!(notch_geometry(&hidden_menu_bar).height, FALLBACK_MENU_BAR_HEIGHT);
    }

    #[test]
    fn the_island_is_centred_on_the_notch_and_flush_with_the_top() {
        let frame = island_frame(&notched(), 340.0, 38.0);
        assert_eq!(frame, Rect { x: 586.0, y: 944.0, width: 340.0, height: 38.0 });
        let frame = island_frame(&external(), 220.0, 25.0);
        assert_eq!(frame, Rect { x: 1512.0 + 1170.0, y: 1215.0, width: 220.0, height: 25.0 });
    }

    #[test]
    fn a_shifted_pill_ends_at_the_notch_and_stays_inside_the_canvas() {
        // Notch 662..850. The compact pill (notch + 44pt wing + 8pt corner)
        // ends exactly at the notch's right edge, clear of the status icons.
        let pill = pill_frame(&notched(), 188.0 + 44.0 + 8.0, 38.0, -26.0);
        assert_eq!(pill, Rect { x: 610.0, y: 944.0, width: 240.0, height: 38.0 });
        assert_eq!(pill.x + pill.width, 662.0 + 188.0);
        // No shift is the centred frame.
        assert_eq!(pill_frame(&notched(), 340.0, 38.0, 0.0), island_frame(&notched(), 340.0, 38.0));
        // A shift past the canvas edge, or garbage, is held to the canvas.
        let canvas = island_frame(&notched(), CANVAS_WIDTH, CANVAS_HEIGHT);
        let far = pill_frame(&notched(), 400.0, 38.0, -500.0);
        assert_eq!(far.x, canvas.x);
        assert_eq!(pill_frame(&notched(), 340.0, 38.0, f64::NAN), island_frame(&notched(), 340.0, 38.0));
    }

    #[test]
    fn requested_sizes_are_clamped() {
        assert_eq!(fit_size(2_000.0, 2_000.0), (CANVAS_WIDTH, CANVAS_HEIGHT));
        assert_eq!(fit_size(f64::NAN, -4.0), (MIN_SIZE, MIN_SIZE));
        assert_eq!(fit_size(300.4, 37.2), (301.0, 38.0));
    }

    #[test]
    fn the_island_shows_only_when_on_wanted_and_the_app_is_in_the_background() {
        let on = IslandSettings::default();
        assert!(should_show(&on, false, true));
        assert!(!should_show(&IslandSettings { enabled: false, ..on }, false, true));
        assert!(!should_show(&on, true, true), "hidden while OpenAgentd is in front");
        assert!(!should_show(&on, false, false), "nothing to show");
    }

    #[test]
    fn opting_in_keeps_the_island_up_while_the_app_is_in_front() {
        let opted_in = IslandSettings { show_when_frontmost: true, ..IslandSettings::default() };
        assert!(should_show(&opted_in, true, true));
        assert!(!should_show(&IslandSettings { enabled: false, ..opted_in }, true, true));
    }

    #[test]
    fn a_settings_patch_changes_only_what_it_names() {
        let patch: IslandSettingsPatch = serde_json::from_str(r#"{"showWhenFrontmost": true}"#).unwrap();
        let next = IslandSettings::default().with(patch);
        assert_eq!(next, IslandSettings { show_when_frontmost: true, ..IslandSettings::default() });
        let json = serde_json::to_value(next).unwrap();
        assert_eq!(json["showWhenFrontmost"], true, "the web reads camelCase: {json}");
    }

    // The setting was removed; a file saved with it still loads.
    #[test]
    fn settings_saved_with_the_removed_idle_option_still_load() {
        let saved: IslandSettings = serde_json::from_str(r#"{"enabled": false, "showWhenIdle": true}"#).unwrap();
        assert_eq!(saved, IslandSettings { enabled: false, ..IslandSettings::default() });
    }

    #[test]
    fn the_pointer_is_reported_in_canvas_pixels_from_the_top_left() {
        let canvas = Rect { x: 526.0, y: 602.0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
        assert_eq!(canvas_point(&canvas, 526.0, 982.0), (0.0, 0.0));
        assert_eq!(canvas_point(&canvas, 756.0, 962.0), (230.0, 20.0));
    }

    #[test]
    fn the_pointer_is_over_the_island_inside_its_frame_edges_included() {
        let frame = Rect { x: 586.0, y: 944.0, width: 340.0, height: 38.0 };
        assert!(frame.contains(700.0, 960.0));
        assert!(frame.contains(586.0, 982.0), "top-left corner");
        assert!(!frame.contains(585.0, 960.0));
        assert!(!frame.contains(700.0, 943.0), "just below");
    }

    #[test]
    fn workspace_labels_are_the_folder_name() {
        assert_eq!(workspace_label("/Users/me/code/web/"), Some("web".into()));
        assert_eq!(workspace_label("C:\\code\\api"), Some("api".into()));
        assert_eq!(workspace_label("/"), None);
    }

    #[test]
    fn the_pointer_is_read_less_often_the_further_it_is_from_the_island() {
        let canvas = Rect { x: 526.0, y: 602.0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
        let at = |inside, x, y| Some(PointerPayload { inside, x, y });
        assert_eq!(pointer_poll_interval(&canvas, at(true, 230.0, 20.0)), POINTER_POLL_INSIDE, "over the pill");
        assert_eq!(pointer_poll_interval(&canvas, at(false, 230.0, CANVAS_HEIGHT + 100.0)), POINTER_POLL, "just below the canvas");
        assert_eq!(pointer_poll_interval(&canvas, at(false, -100.0, 10.0)), POINTER_POLL, "beside it in the menu bar");
        assert_eq!(pointer_poll_interval(&canvas, at(false, 230.0, CANVAS_HEIGHT + 600.0)), POINTER_FAR_POLL, "down in a window");
        assert_eq!(pointer_poll_interval(&canvas, at(false, CANVAS_WIDTH + 500.0, 10.0)), POINTER_FAR_POLL, "far along the menu bar");
        assert_eq!(pointer_poll_interval(&canvas, None), POINTER_POLL, "not read yet");
    }
}
