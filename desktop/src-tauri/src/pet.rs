//! The desktop pet (macOS and Windows): a small pixel cat that walks along
//! the bottom of a display, above the Dock or taskbar, and shows agent
//! notifications in a speech bubble instead of the system banner.
//!
//! The window (`web/pet.html`) is a transparent strip as wide as the
//! display's work area and [`STRIP_HEIGHT`] tall at its bottom. The pet and
//! its bubbles move inside it with CSS, so the window itself never moves
//! while it walks. Clicks pass through the strip except over the hit areas
//! the page reports (`pet_fit`): Rust polls the pointer and switches the
//! window's click-through, like the notch island does. The window never
//! takes keyboard focus.
//!
//! Its data comes from the island's server feed (`island.rs`), which runs
//! while the island or the pet is on: the active-session snapshot drives
//! the pet's pose, and each `desktop_notification` event the feed sees is
//! offered to the pet ([`on_feed_notification`]). It works with every app
//! window closed, and, like the island, never sees the backend token.
//!
//! The pet replaces a system banner only while it is actually on screen
//! ([`claims`]): `show_desktop_notification` asks [`claims_banner`] and the
//! feed asks the same question, so a notification shows in exactly one
//! place. Hidden (a full-screen app, OpenAgentd in front with that option
//! off, the screen locked), the banner is used as before.

#![cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::island::{id_key, IslandStatus, SessionState};
use crate::servers::ServerId;

pub const PET_WINDOW: &str = "pet";
/// Settings and agent status, sent to the pet page.
pub const PET_STATE_EVENT: &str = "pet-state";
/// A notification for the pet's bubble.
pub const PET_NOTIFICATION_EVENT: &str = "pet-notification";
/// The pet settings changed; sent to every window.
pub const PET_SETTINGS_EVENT: &str = "pet-settings-changed";
/// The tray menu item that turns the pet on or off.
pub const MENU_TOGGLE_PET: &str = "toggle_pet";

/// Height of the strip the pet lives in, in logical pixels: room for the
/// largest pet and a bubble above it.
pub const STRIP_HEIGHT: f64 = 260.0;
/// Built this long after launch, so its page load does not compete with
/// the main window's.
const PREWARM_DELAY: Duration = Duration::from_secs(3);
/// Pointer polling: often while it is near the strip, rarely far from it
/// or while the pet is hidden (then only the full-screen state is checked).
const POLL_NEAR: Duration = Duration::from_millis(50);
const POLL_FAR: Duration = Duration::from_millis(250);
const POLL_HIDDEN: Duration = Duration::from_secs(1);
/// How close (logical px above the strip) counts as near.
const NEAR: f64 = 200.0;
/// How often the displays are re-read (plugged in, resolution, Dock moved).
const GEOMETRY_EVERY: Duration = Duration::from_secs(2);
/// How often the Dock or taskbar settings (hiding, size, side) are re-read.
const BAR_EVERY: Duration = Duration::from_secs(15);
const MAX_SEEN: usize = 64;
const MAX_ROUTES: usize = 50;

// ── Settings ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetCharacter {
    #[default]
    Cat,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetColour {
    #[default]
    Orange,
    Paper,
    Bark,
    Blue,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetSize {
    Small,
    #[default]
    Medium,
    Large,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetMovement {
    /// Stays where it was dropped.
    Still,
    #[default]
    Calm,
    Playful,
}

/// Which notification kinds use the bubble; the others keep the banner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BubbleKinds {
    pub input_needed: bool,
    pub assistant_done: bool,
    pub reminder_fired: bool,
}

impl Default for BubbleKinds {
    fn default() -> Self {
        Self { input_needed: true, assistant_done: true, reminder_fired: true }
    }
}

impl BubbleKinds {
    fn allows(&self, kind: &str) -> bool {
        match kind {
            "input_needed" => self.input_needed,
            "assistant_done" => self.assistant_done,
            "reminder_fired" => self.reminder_fired,
            _ => false,
        }
    }
}

/// Where the pet was last dropped: the display (by name) and how far
/// along its bottom edge, 0 (left) to 1 (right).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PetPosition {
    pub display: String,
    pub x: f64,
}

/// What the user chose in Settings → General (`desktop-pet.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PetSettings {
    pub enabled: bool,
    pub character: PetCharacter,
    pub colour: PetColour,
    pub size: PetSize,
    pub movement: PetMovement,
    /// Show notifications in the bubble instead of the system banner.
    pub bubbles: bool,
    pub bubble_kinds: BubbleKinds,
    /// Also show while an OpenAgentd window is in front.
    pub show_when_frontmost: bool,
    /// Step aside while a full-screen app or presentation is in front.
    pub hide_in_fullscreen: bool,
    pub position: Option<PetPosition>,
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            character: PetCharacter::Cat,
            colour: PetColour::Orange,
            size: PetSize::Medium,
            movement: PetMovement::Calm,
            bubbles: true,
            bubble_kinds: BubbleKinds::default(),
            show_when_frontmost: false,
            hide_in_fullscreen: true,
            position: None,
        }
    }
}

/// A partial update from Settings; absent fields keep their value. The
/// position only changes by dragging the pet.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSettingsPatch {
    pub enabled: Option<bool>,
    pub character: Option<PetCharacter>,
    pub colour: Option<PetColour>,
    pub size: Option<PetSize>,
    pub movement: Option<PetMovement>,
    pub bubbles: Option<bool>,
    pub bubble_kinds: Option<BubbleKinds>,
    pub show_when_frontmost: Option<bool>,
    pub hide_in_fullscreen: Option<bool>,
}

impl PetSettings {
    pub fn with(self, patch: PetSettingsPatch) -> Self {
        Self {
            enabled: patch.enabled.unwrap_or(self.enabled),
            character: patch.character.unwrap_or(self.character),
            colour: patch.colour.unwrap_or(self.colour),
            size: patch.size.unwrap_or(self.size),
            movement: patch.movement.unwrap_or(self.movement),
            bubbles: patch.bubbles.unwrap_or(self.bubbles),
            bubble_kinds: patch.bubble_kinds.unwrap_or(self.bubble_kinds),
            show_when_frontmost: patch.show_when_frontmost.unwrap_or(self.show_when_frontmost),
            hide_in_fullscreen: patch.hide_in_fullscreen.unwrap_or(self.hide_in_fullscreen),
            position: self.position,
        }
    }
}

/// The platforms with a pet. Linux (Wayland) can't place an always-on-top
/// window or let clicks through it.
pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

// ── Decisions ───────────────────────────────────────────────────────────────

/// Whether the pet should be on screen.
pub fn should_show(settings: &PetSettings, frontmost: bool, fullscreen: bool) -> bool {
    settings.enabled && (!frontmost || settings.show_when_frontmost) && !(fullscreen && settings.hide_in_fullscreen)
}

/// Whether a notification of `kind` goes to the pet's bubble instead of the
/// system banner: only while the pet is on screen (`visible`).
pub fn claims(settings: &PetSettings, visible: bool, kind: &str) -> bool {
    settings.enabled && visible && settings.bubbles && settings.bubble_kinds.allows(kind)
}

/// How the bubble looks: a question, a reminder, a failed turn, or done.
pub fn bubble_tone(kind: &str, title: &str) -> &'static str {
    match kind {
        "input_needed" => "input",
        "reminder_fired" => "remind",
        _ if title.starts_with("Failed") => "failed",
        _ => "done",
    }
}

/// How many sessions run and how many wait on the user: the pet's pose.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetStatus {
    pub running: usize,
    pub needs_input: usize,
}

pub fn pet_status(status: &IslandStatus) -> PetStatus {
    let count = |state| status.sessions.iter().filter(|s| s.state == state).count();
    PetStatus { running: count(SessionState::Running), needs_input: count(SessionState::NeedsInput) }
}

/// A display's work area (without the Dock or taskbar), in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

impl Area {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= f64::from(self.x)
            && x < f64::from(self.x) + f64::from(self.width)
            && y >= f64::from(self.y)
            && y < f64::from(self.y) + f64::from(self.height)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DisplayInfo {
    pub name: String,
    pub work: Area,
    /// The display's bottom edge (physical), Dock or taskbar included.
    pub bottom: i32,
}

/// The display the pet lives on: the one it was dropped on, else the
/// primary one (listed first by the caller).
pub fn pick_display<'a>(displays: &'a [DisplayInfo], saved: Option<&str>) -> Option<&'a DisplayInfo> {
    saved.and_then(|name| displays.iter().find(|d| d.name == name)).or_else(|| displays.first())
}

/// The strip along the bottom of `work`, in physical pixels.
pub fn strip_frame(work: Area) -> Area {
    let scale = if work.scale.is_finite() && work.scale > 0.0 { work.scale } else { 1.0 };
    let height = ((STRIP_HEIGHT * scale).round() as u32).min(work.height);
    Area { x: work.x, y: work.y + (work.height - height) as i32, width: work.width, height, scale }
}

/// A Dock or taskbar that hides itself leaves the work area reaching the
/// bottom of the display, and pops up over whatever walks there. Keep its
/// room (`bar_height`, logical px) clear when nothing is reserved at the
/// bottom already.
pub fn leave_room_for_hidden_bar(work: Area, display_bottom: i32, bar_height: Option<f64>) -> Area {
    let Some(bar) = bar_height.filter(|h| h.is_finite() && *h > 0.0) else {
        return work;
    };
    if work.y + (work.height as i32) < display_bottom {
        return work;
    }
    let scale = if work.scale.is_finite() && work.scale > 0.0 { work.scale } else { 1.0 };
    let reserve = ((bar * scale).round() as u32).min(work.height / 2);
    Area { height: work.height - reserve, ..work }
}

/// The macOS Dock's height while it hides itself at the bottom of the
/// screen, from its preferences (`defaults read com.apple.dock …`); None
/// when it stays up (the work area already leaves its room) or sits at a
/// side.
pub fn hidden_dock_height(autohide: Option<&str>, orientation: Option<&str>, tilesize: Option<&str>) -> Option<f64> {
    /// Icon size when the user never changed it, and the Dock's padding
    /// around its icons.
    const DEFAULT_TILE: f64 = 48.0;
    const PADDING: f64 = 18.0;
    let autohide = matches!(autohide.map(str::trim), Some("1" | "true" | "YES"));
    let bottom = orientation.map(str::trim).map_or(true, |o| o == "bottom");
    if !autohide || !bottom {
        return None;
    }
    let tile = tilesize.and_then(|t| t.trim().parse::<f64>().ok()).filter(|t| t.is_finite()).unwrap_or(DEFAULT_TILE);
    Some(tile.clamp(16.0, 128.0) + PADDING)
}

/// The self-hiding bar's height, as last read off the main thread
/// ([`refresh_hidden_bar`]).
fn hidden_bar() -> &'static Mutex<Option<f64>> {
    static BAR: OnceLock<Mutex<Option<f64>>> = OnceLock::new();
    BAR.get_or_init(|| Mutex::new(None))
}

/// Re-read the Dock or taskbar settings; true when they changed.
async fn refresh_hidden_bar() -> bool {
    let height = tauri::async_runtime::spawn_blocking(native::hidden_bar_height).await.ok().flatten();
    std::mem::replace(&mut *hidden_bar().lock().unwrap(), height) != height
}

/// A screen point (physical) in the strip's CSS pixels.
pub fn local_point(strip: &Area, x: f64, y: f64) -> (f64, f64) {
    ((x - f64::from(strip.x)) / strip.scale, (y - f64::from(strip.y)) / strip.scale)
}

/// A clickable area of the page (the pet, a bubble), in CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl HitRect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }

    fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite()) && self.width >= 0.0 && self.height >= 0.0
    }
}

/// Whether the strip should take clicks at this pointer position.
pub fn takes_clicks(hits: &[HitRect], capture: bool, point: Option<(f64, f64)>) -> bool {
    capture || point.is_some_and(|(x, y)| hits.iter().any(|h| h.contains(x, y)))
}

/// Where along the edge a drop at `x` lands, as a 0..1 fraction.
pub fn edge_fraction(x: f64, width: f64) -> f64 {
    if !x.is_finite() || !width.is_finite() || width <= 0.0 {
        return 0.3;
    }
    (x / width).clamp(0.0, 1.0)
}

/// Remember a key in a capped list; false when it was already there.
fn remember(seen: &mut VecDeque<String>, key: &str, cap: usize) -> bool {
    if seen.iter().any(|k| k == key) {
        return false;
    }
    if seen.len() >= cap {
        seen.pop_front();
    }
    seen.push_back(key.to_string());
    true
}

// ── Shared state ────────────────────────────────────────────────────────────

/// Where a bubble's session lives, to open it on a click.
#[derive(Clone, Debug)]
struct Route {
    notification_id: String,
    session_id: String,
    server: ServerId,
}

struct Shared {
    settings: PetSettings,
    /// Windows: a full-screen app or a presentation is in front.
    fullscreen: bool,
    /// macOS: the window is not visible on the current Space (a full-screen
    /// app, the lock screen), although it was shown.
    occluded: bool,
    /// The window is ordered on screen.
    shown: bool,
    strip: Option<Area>,
    hits: Vec<HitRect>,
    /// A drag is under way: keep taking clicks wherever the pointer is.
    capture: bool,
    /// The window takes clicks now.
    taking_clicks: bool,
    status: PetStatus,
    seen: VecDeque<String>,
    routes: VecDeque<Route>,
}

fn shared() -> &'static Mutex<Shared> {
    static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
    SHARED.get_or_init(|| {
        Mutex::new(Shared {
            settings: PetSettings::default(),
            fullscreen: false,
            occluded: false,
            shown: false,
            strip: None,
            hits: Vec::new(),
            capture: false,
            taking_clicks: false,
            status: PetStatus::default(),
            seen: VecDeque::new(),
            routes: VecDeque::new(),
        })
    })
}

/// Wakes the pointer watch when the pet is switched on.
fn wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

pub fn is_enabled() -> bool {
    supported() && shared().lock().unwrap().settings.enabled
}

/// An app window asks for a system banner: when the pet is on screen and
/// handles this kind, it shows the bubble instead (once, whether this or
/// its own feed gets there first) and the banner is skipped. True when the
/// pet took it.
pub fn take_banner(app: &AppHandle, window_label: &str, bubble: PetBubble) -> bool {
    if !supported() {
        return false;
    }
    let server = crate::servers::window_server(window_label, &crate::servers::external_map(app));
    offer(app, &server, bubble)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/// Load the settings and, when the pet is on, show it shortly after launch.
pub fn start(app: &AppHandle) {
    if !supported() {
        return;
    }
    let settings = crate::config::load_pet_settings(app);
    let enabled = settings.enabled;
    shared().lock().unwrap().settings = settings;
    tauri::async_runtime::spawn(run_watch(app.clone()));
    if enabled {
        crate::island::wake_feed();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PREWARM_DELAY).await;
            refresh(&app);
        });
    }
}

/// Re-decide whether and where the pet shows, on the main thread.
pub fn refresh(app: &AppHandle) {
    if !supported() {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply(&handle));
}

/// The pet window, built on first use. Main thread only.
fn ensure_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        return Ok(window);
    }
    let window = tauri::WebviewWindowBuilder::new(app, PET_WINDOW, tauri::WebviewUrl::App("pet.html".into()))
        .title("OpenAgentd pet")
        .inner_size(800.0, STRIP_HEIGHT)
        .visible(false)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        // Never take keyboard focus from the app the user is typing in, but
        // let the first click on the pet or a bubble count as a click.
        .focusable(false)
        .focused(false)
        .accept_first_mouse(true)
        .skip_taskbar(true)
        .build()?;
    let _ = window.set_ignore_cursor_events(true);
    log::info!("pet: window built");
    Ok(window)
}

fn displays(app: &AppHandle) -> Vec<DisplayInfo> {
    let info = |m: &tauri::Monitor| DisplayInfo {
        name: m.name().cloned().unwrap_or_default(),
        work: Area {
            x: m.work_area().position.x,
            y: m.work_area().position.y,
            width: m.work_area().size.width,
            height: m.work_area().size.height,
            scale: m.scale_factor(),
        },
        bottom: m.position().y + m.size().height as i32,
    };
    let primary = app.primary_monitor().ok().flatten().map(|m| info(&m));
    let mut list: Vec<DisplayInfo> = primary.iter().cloned().collect();
    for monitor in app.available_monitors().unwrap_or_default() {
        let display = info(&monitor);
        if !list.contains(&display) {
            list.push(display);
        }
    }
    list
}

/// Show, place, or hide the pet to match the shared state. Main thread only.
fn apply(app: &AppHandle) {
    // Read before taking the pet's lock: never hold both.
    let frontmost = crate::island::app_frontmost();
    let (show, settings) = {
        let s = shared().lock().unwrap();
        (should_show(&s.settings, frontmost, s.fullscreen), s.settings.clone())
    };
    if !show || !supported() {
        let was_shown = {
            let mut s = shared().lock().unwrap();
            s.strip = None;
            s.taking_clicks = false;
            std::mem::replace(&mut s.shown, false)
        };
        if let Some(window) = app.get_webview_window(PET_WINDOW) {
            let _ = window.hide();
            let _ = window.set_ignore_cursor_events(true);
        }
        if was_shown {
            log::info!("pet: hidden");
            emit_state(app);
        }
        return;
    }
    let window = match ensure_window(app) {
        Ok(window) => window,
        Err(e) => {
            log::warn!("pet: build failed: {e:#}");
            return;
        }
    };
    native::configure(&window, settings.hide_in_fullscreen);
    let list = displays(app);
    let Some(display) = pick_display(&list, settings.position.as_ref().map(|p| p.display.as_str())) else {
        return;
    };
    let bar = *hidden_bar().lock().unwrap();
    let frame = strip_frame(leave_room_for_hidden_bar(display.work, display.bottom, bar));
    let (moved, was_shown) = {
        let mut s = shared().lock().unwrap();
        (s.strip.replace(frame) != Some(frame), s.shown)
    };
    if moved {
        let _ = window.set_size(tauri::PhysicalSize::new(frame.width, frame.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(frame.x, frame.y));
    }
    if !was_shown {
        native::show(&window);
        let _ = window.set_ignore_cursor_events(true);
        {
            let mut s = shared().lock().unwrap();
            s.shown = true;
            s.occluded = false;
            s.taking_clicks = false;
        }
        log::info!("pet: shown on {:?} {}x{}", display.name, frame.width, frame.height);
        wake().notify_one();
    }
    if moved || !was_shown {
        emit_state(app);
    }
}

/// Poll the pointer (click-through), the full-screen state and the
/// displays while the pet is on.
async fn run_watch(app: AppHandle) {
    let mut last_geometry = Instant::now();
    let mut last_bar: Option<Instant> = None;
    loop {
        if !is_enabled() {
            wake().notified().await;
            continue;
        }
        // The Dock or taskbar settings are read off the main thread, now
        // and then; a change re-places the pet at once.
        let bar_changed = if last_bar.map_or(true, |at| at.elapsed() >= BAR_EVERY) {
            last_bar = Some(Instant::now());
            refresh_hidden_bar().await
        } else {
            false
        };
        let geometry_due = bar_changed || last_geometry.elapsed() >= GEOMETRY_EVERY;
        if geometry_due {
            last_geometry = Instant::now();
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = tx.send(tick(&handle, geometry_due));
        });
        let interval = rx.await.unwrap_or(POLL_HIDDEN);
        let _ = tokio::time::timeout(interval, wake().notified()).await;
    }
}

/// One poll. Main thread only. Returns how long until the next.
fn tick(app: &AppHandle, geometry_due: bool) -> Duration {
    // Full-screen apps (Windows; macOS hides the window from their Space).
    if geometry_due || !shared().lock().unwrap().shown {
        let fullscreen = native::fullscreen_app_in_front();
        let changed = {
            let mut s = shared().lock().unwrap();
            std::mem::replace(&mut s.fullscreen, fullscreen) != fullscreen
        };
        if changed || geometry_due {
            apply(app);
        }
    }
    let Some(window) = app.get_webview_window(PET_WINDOW) else {
        return POLL_HIDDEN;
    };
    let (strip, hits, capture, taking) = {
        let s = shared().lock().unwrap();
        if !s.shown {
            return POLL_HIDDEN;
        }
        (s.strip, s.hits.clone(), s.capture, s.taking_clicks)
    };
    let Some(strip) = strip else {
        return POLL_HIDDEN;
    };
    let occluded = !native::on_screen(&window);
    let point = app.cursor_position().ok().map(|p| local_point(&strip, p.x, p.y));
    let take = takes_clicks(&hits, capture, point);
    if take != taking {
        let _ = window.set_ignore_cursor_events(!take);
    }
    {
        let mut s = shared().lock().unwrap();
        s.taking_clicks = take;
        s.occluded = occluded;
    }
    match point {
        Some((x, y)) if x >= -NEAR && x <= f64::from(strip.width) / strip.scale + NEAR && y >= -NEAR => POLL_NEAR,
        _ => POLL_FAR,
    }
}

// ── Feed ────────────────────────────────────────────────────────────────────

/// The pet's view of the agents, as the page reads it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetView {
    settings: PetSettings,
    status: PetStatus,
    shown: bool,
}

fn view() -> PetView {
    let s = shared().lock().unwrap();
    PetView { settings: s.settings.clone(), status: s.status, shown: s.shown }
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit_to(PET_WINDOW, PET_STATE_EVENT, view());
}

/// The island's snapshot changed: update the pet's pose.
pub fn status_changed(app: &AppHandle, status: &IslandStatus) {
    let next = pet_status(status);
    let changed = {
        let mut s = shared().lock().unwrap();
        s.settings.enabled && std::mem::replace(&mut s.status, next) != next
    };
    if changed {
        emit_state(app);
    }
}

/// What the page shows in a bubble.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBubble {
    pub id: String,
    pub kind: String,
    pub tone: &'static str,
    pub session_id: Option<String>,
    pub title: String,
    pub body: String,
}

/// The bubble for a `desktop_notification` event, if it is one.
pub fn bubble_from_event(data: &str) -> Option<PetBubble> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let id = v["notification_id"].as_str()?.to_string();
    let kind = v["kind"].as_str()?.to_string();
    let title = v["title"].as_str()?.to_string();
    let body = v["body"].as_str().unwrap_or_default().to_string();
    let session_id = v["session_id"].as_str().map(str::to_string);
    Some(PetBubble { tone: bubble_tone(&kind, &title), id, kind, session_id, title, body })
}

/// The feed saw a notification on `server`: show it in the bubble when the
/// pet takes it.
pub fn on_feed_notification(app: &AppHandle, server: &ServerId, data: &str) {
    if let Some(bubble) = bubble_from_event(data) {
        offer(app, server, bubble);
    }
}

/// Show `bubble` when the pet takes its kind right now. True when the pet
/// took it: shown now, shown already (the feed and the app window both
/// offer each notification), or about the session on screen, which needs
/// neither a bubble nor a banner.
fn offer(app: &AppHandle, server: &ServerId, bubble: PetBubble) -> bool {
    let viewed = crate::island::viewed_session(app);
    {
        let mut s = shared().lock().unwrap();
        if !claims(&s.settings, s.shown && !s.occluded, &bubble.kind) {
            return false;
        }
        // A server reached through two URLs sends it twice, too.
        if !remember(&mut s.seen, &bubble.id, MAX_SEEN) {
            return true;
        }
        if bubble.session_id.as_deref().map(id_key).is_some_and(|key| viewed.as_deref() == Some(key.as_str())) {
            return true;
        }
        if let Some(session_id) = bubble.session_id.clone() {
            if s.routes.len() >= MAX_ROUTES {
                s.routes.pop_front();
            }
            s.routes.push_back(Route { notification_id: bubble.id.clone(), session_id, server: server.clone() });
        }
    }
    log::info!("pet: bubble kind={} tone={}", bubble.kind, bubble.tone);
    let _ = app.emit_to(PET_WINDOW, PET_NOTIFICATION_EVENT, bubble);
    true
}

/// A bubble for a notification an app window asked to show.
pub fn bubble_from_request(kind: &str, notification_id: Option<&str>, session_id: Option<&str>, title: &str, body: &str) -> PetBubble {
    PetBubble {
        // Backend notifications always carry an id; without one, the text
        // stands in so a repeat is still shown once.
        id: notification_id.map(str::to_string).unwrap_or_else(|| format!("{kind}\n{title}\n{body}")),
        kind: kind.to_string(),
        tone: bubble_tone(kind, title),
        session_id: session_id.map(str::to_string),
        title: title.to_string(),
        body: body.to_string(),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// The pet's settings and status, read when the page mounts.
#[tauri::command]
pub fn pet_state(window: WebviewWindow) -> Result<PetView, String> {
    if window.label() != PET_WINDOW {
        return Err("only the pet reads its state".into());
    }
    Ok(view())
}

/// The page's clickable areas (the pet and its bubbles) in CSS pixels, and
/// whether a drag is under way.
#[tauri::command]
pub fn pet_fit(window: WebviewWindow, rects: Vec<HitRect>, capture: bool) {
    if window.label() != PET_WINDOW {
        return;
    }
    let mut s = shared().lock().unwrap();
    s.hits = rects.into_iter().filter(HitRect::is_valid).take(16).collect();
    s.capture = capture;
    drop(s);
    wake().notify_one();
}

/// Open the session a bubble is about, in an app window on its server.
#[tauri::command]
pub fn pet_open(app: AppHandle, window: WebviewWindow, notification_id: String) {
    if window.label() != PET_WINDOW {
        return;
    }
    let route = shared().lock().unwrap().routes.iter().find(|r| r.notification_id == notification_id).cloned();
    let Some(route) = route else {
        log::warn!("pet: no session for bubble {notification_id}");
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::island::open_session_on_server(&app, route.server, &route.session_id).await {
            log::warn!("pet: could not open session: {e:#}");
        }
    });
}

/// The pet was dropped at `x` (CSS pixels along the strip). Dropped over
/// another display, it moves there.
#[tauri::command]
pub fn pet_drag_end(app: AppHandle, window: WebviewWindow, x: f64) {
    if window.label() != PET_WINDOW {
        return;
    }
    let Some(strip) = shared().lock().unwrap().strip else {
        return;
    };
    let list = displays(&app);
    let cursor = app.cursor_position().ok();
    let current = shared().lock().unwrap().settings.position.as_ref().map(|p| p.display.clone());
    let here = pick_display(&list, current.as_deref()).map(|d| d.name.clone());
    let dropped_on = cursor.and_then(|c| list.iter().find(|d| d.work.contains(c.x, c.y)).map(|d| (d.clone(), c)));
    let position = match dropped_on {
        Some((display, c)) if Some(&display.name) != here.as_ref() => PetPosition {
            x: edge_fraction(c.x - f64::from(display.work.x), f64::from(display.work.width)),
            display: display.name,
        },
        _ => PetPosition {
            display: here.unwrap_or_default(),
            x: edge_fraction(x, f64::from(strip.width) / strip.scale),
        },
    };
    let settings = {
        let mut s = shared().lock().unwrap();
        s.capture = false;
        s.settings.position = Some(position);
        s.settings.clone()
    };
    if let Err(e) = crate::config::save_pet_settings(&app, &settings) {
        log::warn!("pet: could not save its position: {e:#}");
    }
    apply(&app);
    emit_state(&app);
}

/// The pet settings, or None where there is no pet (Linux).
#[tauri::command]
pub fn pet_settings() -> Option<PetSettings> {
    supported().then(|| shared().lock().unwrap().settings.clone())
}

/// Change some pet settings and remember them; returns all of them.
#[tauri::command]
pub fn pet_update_settings(app: AppHandle, patch: PetSettingsPatch) -> Result<PetSettings, String> {
    update_settings(&app, patch).map_err(|e| format!("{e:#}"))
}

fn update_settings(app: &AppHandle, patch: PetSettingsPatch) -> Result<PetSettings> {
    anyhow::ensure!(supported(), "The desktop pet is only available on macOS and Windows.");
    let current = shared().lock().unwrap().settings.clone();
    let next = current.clone().with(patch);
    crate::config::save_pet_settings(app, &next).context("save pet settings")?;
    shared().lock().unwrap().settings = next.clone();
    if next.enabled != current.enabled {
        crate::island::wake_feed();
        wake().notify_waiters();
        if !next.enabled {
            let mut s = shared().lock().unwrap();
            s.status = PetStatus::default();
            s.routes.clear();
        }
    }
    log::info!("pet: settings={next:?}");
    refresh(app);
    emit_state(app);
    let _ = app.emit(PET_SETTINGS_EVENT, &next);
    crate::menu::update_tray_pet(app, next.enabled);
    Ok(next)
}

/// The tray's "Desktop Pet" item.
pub fn toggle(app: &AppHandle) {
    let enabled = shared().lock().unwrap().settings.enabled;
    let patch = PetSettingsPatch { enabled: Some(!enabled), ..PetSettingsPatch::default() };
    if let Err(e) = update_settings(app, patch) {
        log::warn!("pet: toggle failed: {e:#}");
    }
}

// ── Platform ────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod native {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowOcclusionState};

    fn with_ns_window<T>(window: &tauri::WebviewWindow, f: impl FnOnce(&NSWindow) -> T) -> Option<T> {
        MainThreadMarker::new()?;
        match window.ns_window() {
            // SAFETY: Tauri hands out the window's live NSWindow, and we are on
            // the main thread, where AppKit objects may be used.
            Ok(ptr) if !ptr.is_null() => Some(f(unsafe { &*(ptr as *const NSWindow) })),
            _ => None,
        }
    }

    /// On every Space, out of Cmd-` cycling and Mission Control. Full-screen
    /// Spaces too only when the user wants it there.
    pub fn configure(window: &tauri::WebviewWindow, hide_in_fullscreen: bool) {
        with_ns_window(window, |ns| {
            let mut behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle;
            if !hide_in_fullscreen {
                behavior |= NSWindowCollectionBehavior::FullScreenAuxiliary;
            }
            if ns.collectionBehavior() != behavior {
                ns.setCollectionBehavior(behavior);
            }
            ns.setHasShadow(false);
        });
    }

    /// Bring to the front without activating the app.
    pub fn show(window: &tauri::WebviewWindow) {
        with_ns_window(window, |ns| ns.orderFrontRegardless());
    }

    /// Any part of the window is visible: false on a full-screen app's
    /// Space, the lock screen, or with the display asleep.
    pub fn on_screen(window: &tauri::WebviewWindow) -> bool {
        with_ns_window(window, |ns| ns.occlusionState().contains(NSWindowOcclusionState::Visible)).unwrap_or(true)
    }

    /// macOS keeps the window off full-screen Spaces itself (see [`configure`]).
    pub fn fullscreen_app_in_front() -> bool {
        false
    }

    /// The Dock's height while it hides itself at the bottom. Blocking:
    /// runs `defaults`, so call it off the main thread.
    pub fn hidden_bar_height() -> Option<f64> {
        let read = |key: &str| {
            std::process::Command::new("/usr/bin/defaults")
                .args(["read", "com.apple.dock", key])
                .output()
                .ok()
                .filter(|out| out.status.success())
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        super::hidden_dock_height(read("autohide").as_deref(), read("orientation").as_deref(), read("tilesize").as_deref())
    }
}

#[cfg(target_os = "windows")]
mod native {
    pub fn configure(_window: &tauri::WebviewWindow, _hide_in_fullscreen: bool) {}

    pub fn show(window: &tauri::WebviewWindow) {
        let _ = window.show();
    }

    pub fn on_screen(_window: &tauri::WebviewWindow) -> bool {
        true
    }

    /// A full-screen app (a game, a video) or a presentation is in front,
    /// as Windows decides it for its own notifications.
    pub fn fullscreen_app_in_front() -> bool {
        use windows::Win32::UI::Shell::{
            SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
        };
        // SAFETY: takes no arguments and only reads the shell's state.
        match unsafe { SHQueryUserNotificationState() } {
            Ok(state) => state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE,
            Err(_) => false,
        }
    }

    /// The taskbar's height (logical px) while it hides itself at the
    /// bottom of the screen.
    pub fn hidden_bar_height() -> Option<f64> {
        use windows::Win32::UI::Shell::{SHAppBarMessage, ABE_BOTTOM, ABM_GETSTATE, ABM_GETTASKBARPOS, ABS_AUTOHIDE, APPBARDATA};
        /// The Windows 11 taskbar; Windows 10's is a little shorter.
        const TASKBAR_HEIGHT: f64 = 48.0;
        let mut data = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
        // SAFETY: `data` is a valid, sized APPBARDATA for both queries.
        let state = unsafe { SHAppBarMessage(ABM_GETSTATE, &mut data) } as u32;
        if state & ABS_AUTOHIDE == 0 {
            return None;
        }
        // SAFETY: as above.
        let found = unsafe { SHAppBarMessage(ABM_GETTASKBARPOS, &mut data) } != 0;
        (found && data.uEdge == ABE_BOTTOM).then_some(TASKBAR_HEIGHT)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod native {
    pub fn configure(_window: &tauri::WebviewWindow, _hide_in_fullscreen: bool) {}

    pub fn show(window: &tauri::WebviewWindow) {
        let _ = window.show();
    }

    pub fn on_screen(_window: &tauri::WebviewWindow) -> bool {
        true
    }

    pub fn fullscreen_app_in_front() -> bool {
        false
    }

    pub fn hidden_bar_height() -> Option<f64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::island::IslandSession;

    fn on() -> PetSettings {
        PetSettings { enabled: true, ..PetSettings::default() }
    }

    #[test]
    fn the_pet_is_off_by_default_with_bubbles_ready_once_it_is_turned_on() {
        let defaults = PetSettings::default();
        assert!(!defaults.enabled);
        assert!(defaults.bubbles);
        assert_eq!(defaults.bubble_kinds, BubbleKinds { input_needed: true, assistant_done: true, reminder_fired: true });
        assert!(!defaults.show_when_frontmost);
        assert!(defaults.hide_in_fullscreen);
        assert_eq!(defaults.position, None);
    }

    #[test]
    fn it_shows_only_when_on_and_steps_aside_for_the_app_and_full_screen_apps() {
        assert!(!should_show(&PetSettings::default(), false, false));
        assert!(should_show(&on(), false, false));
        assert!(!should_show(&on(), true, false), "OpenAgentd in front");
        assert!(should_show(&PetSettings { show_when_frontmost: true, ..on() }, true, false));
        assert!(!should_show(&on(), false, true), "full-screen app in front");
        assert!(should_show(&PetSettings { hide_in_fullscreen: false, ..on() }, false, true));
    }

    #[test]
    fn it_takes_a_notification_only_while_on_screen_with_bubbles_for_that_kind() {
        for kind in ["input_needed", "assistant_done", "reminder_fired"] {
            assert!(claims(&on(), true, kind), "{kind}");
            assert!(!claims(&on(), false, kind), "{kind}: hidden pets fall back to the banner");
            assert!(!claims(&PetSettings::default(), true, kind), "{kind}: pet off");
            assert!(!claims(&PetSettings { bubbles: false, ..on() }, true, kind), "{kind}: bubbles off");
        }
        let no_done = PetSettings { bubble_kinds: BubbleKinds { assistant_done: false, ..BubbleKinds::default() }, ..on() };
        assert!(!claims(&no_done, true, "assistant_done"));
        assert!(claims(&no_done, true, "input_needed"));
        assert!(!claims(&on(), true, "something_new"), "unknown kinds keep the banner");
    }

    #[test]
    fn bubble_tones_follow_the_kind_and_a_failed_title() {
        assert_eq!(bubble_tone("input_needed", "Needs input · web"), "input");
        assert_eq!(bubble_tone("reminder_fired", "Reminder"), "remind");
        assert_eq!(bubble_tone("assistant_done", "Failed · web"), "failed");
        assert_eq!(bubble_tone("assistant_done", "Done · web"), "done");
        assert_eq!(bubble_tone("assistant_done", "Goal achieved · web"), "done");
    }

    #[test]
    fn a_notification_event_becomes_a_bubble() {
        let data = r#"{"type":"desktop_notification","notification_id":"n1","kind":"assistant_done","session_id":"s1","title":"Failed · web","body":"Fix login"}"#;
        assert_eq!(
            bubble_from_event(data),
            Some(PetBubble {
                id: "n1".into(),
                kind: "assistant_done".into(),
                tone: "failed",
                session_id: Some("s1".into()),
                title: "Failed · web".into(),
                body: "Fix login".into(),
            })
        );
        assert_eq!(bubble_from_event(r#"{"kind":"assistant_done","title":"x"}"#), None, "no id");
        assert_eq!(bubble_from_event("not json"), None);
    }

    #[test]
    fn a_window_request_becomes_the_same_bubble_as_the_event() {
        let event = r#"{"notification_id":"n1","kind":"input_needed","session_id":"s1","title":"Needs input · api","body":"Keep v1?"}"#;
        let request = bubble_from_request("input_needed", Some("n1"), Some("s1"), "Needs input · api", "Keep v1?");
        assert_eq!(Some(request), bubble_from_event(event), "same id, so it shows once");
        let no_id = bubble_from_request("assistant_done", None, None, "Done", "x");
        assert_eq!(no_id.id, bubble_from_request("assistant_done", None, None, "Done", "x").id);
    }

    #[test]
    fn each_notification_is_taken_once() {
        let mut seen = VecDeque::new();
        assert!(remember(&mut seen, "a", 2));
        assert!(!remember(&mut seen, "a", 2));
        assert!(remember(&mut seen, "b", 2));
        assert!(remember(&mut seen, "c", 2));
        assert!(remember(&mut seen, "a", 2), "the oldest id was dropped at the cap");
    }

    #[test]
    fn the_pose_counts_running_and_waiting_sessions() {
        let session = |id: &str, state| IslandSession {
            id: id.into(),
            title: id.into(),
            workspace: None,
            state,
            question: None,
            server: None,
            server_id: None,
            goal: None,
        };
        let status = IslandStatus {
            seq: 1,
            sessions: vec![session("a", SessionState::NeedsInput), session("b", SessionState::Running), session("c", SessionState::Running)],
            unread: vec![session("d", SessionState::Done)],
        };
        assert_eq!(pet_status(&status), PetStatus { running: 2, needs_input: 1 });
    }

    #[test]
    fn the_strip_sits_on_the_bottom_of_the_work_area() {
        let work = Area { x: 0, y: 25, width: 1440, height: 800, scale: 2.0 };
        let strip = strip_frame(work);
        assert_eq!(strip, Area { x: 0, y: 25 + 800 - 520, width: 1440, height: 520, scale: 2.0 });
        let tiny = strip_frame(Area { x: 10, y: 0, width: 300, height: 100, scale: 1.0 });
        assert_eq!((tiny.y, tiny.height), (0, 100), "never taller than the work area");
        let bad_scale = strip_frame(Area { scale: f64::NAN, ..work });
        assert_eq!(bad_scale.scale, 1.0);
    }

    #[test]
    fn the_pointer_is_read_in_the_strips_css_pixels() {
        let strip = Area { x: 100, y: 500, width: 2000, height: 520, scale: 2.0 };
        assert_eq!(local_point(&strip, 300.0, 700.0), (100.0, 100.0));
    }

    #[test]
    fn clicks_go_through_except_over_the_pet_and_its_bubbles_or_while_dragging() {
        let hits = [HitRect { x: 100.0, y: 200.0, width: 64.0, height: 48.0 }, HitRect { x: 90.0, y: 40.0, width: 290.0, height: 140.0 }];
        assert!(takes_clicks(&hits, false, Some((120.0, 220.0))), "on the pet");
        assert!(takes_clicks(&hits, false, Some((300.0, 100.0))), "on a bubble");
        assert!(!takes_clicks(&hits, false, Some((600.0, 220.0))), "beside the pet");
        assert!(!takes_clicks(&hits, false, None), "pointer unknown");
        assert!(takes_clicks(&hits, true, Some((600.0, 220.0))), "dragging");
        assert!(!HitRect { x: f64::NAN, y: 0.0, width: 1.0, height: 1.0 }.is_valid());
    }

    #[test]
    fn the_saved_display_is_used_when_it_is_still_there() {
        let display = |name: &str| DisplayInfo { name: name.into(), work: Area { x: 0, y: 0, width: 10, height: 10, scale: 1.0 }, bottom: 10 };
        let list = [display("Built-in"), display("LG")];
        assert_eq!(pick_display(&list, Some("LG")).unwrap().name, "LG");
        assert_eq!(pick_display(&list, Some("Unplugged")).unwrap().name, "Built-in");
        assert_eq!(pick_display(&list, None).unwrap().name, "Built-in");
        assert!(pick_display(&[], None).is_none());
    }

    #[test]
    fn a_drop_is_kept_as_a_fraction_of_the_edge() {
        assert_eq!(edge_fraction(360.0, 1440.0), 0.25);
    }

    #[test]
    fn it_keeps_clear_of_a_dock_or_taskbar_that_hides_itself() {
        // 1680 x 1050 pt at 2x, menu bar 30 pt, Dock hidden: the work area
        // reaches the bottom of the display.
        let work = Area { x: 0, y: 60, width: 3360, height: 2040, scale: 2.0 };
        let raised = leave_room_for_hidden_bar(work, 2100, Some(53.0));
        assert_eq!(raised, Area { height: 2040 - 106, ..work });
        assert_eq!(strip_frame(raised).y + strip_frame(raised).height as i32, 2100 - 106, "the strip ends above the Dock");
        assert_eq!(leave_room_for_hidden_bar(work, 2100, None), work, "the bar stays up or sits at a side");
        let reserved = Area { height: 1900, ..work };
        assert_eq!(leave_room_for_hidden_bar(reserved, 2100, Some(53.0)), reserved, "the work area already leaves its room");
        assert_eq!(leave_room_for_hidden_bar(work, 2100, Some(f64::NAN)), work);
    }

    #[test]
    fn the_hidden_docks_height_comes_from_its_preferences() {
        assert_eq!(hidden_dock_height(Some("1"), None, Some("35")), Some(53.0));
        assert_eq!(hidden_dock_height(Some("1"), Some("bottom"), None), Some(66.0), "default icon size");
        assert_eq!(hidden_dock_height(Some("0"), None, Some("35")), None, "the Dock stays up");
        assert_eq!(hidden_dock_height(None, None, Some("35")), None, "never hidden");
        assert_eq!(hidden_dock_height(Some("1"), Some("left"), Some("35")), None, "at a side");
        assert_eq!(hidden_dock_height(Some("1"), None, Some("nonsense")), Some(66.0));
        assert_eq!(hidden_dock_height(Some("1"), None, Some("999")), Some(146.0), "clamped");
    }

    #[test]
    fn a_drop_far_out_is_kept_on_the_edge() {
        assert_eq!(edge_fraction(-50.0, 1440.0), 0.0);
        assert_eq!(edge_fraction(5000.0, 1440.0), 1.0);
        assert_eq!(edge_fraction(10.0, 0.0), 0.3);
    }

    #[test]
    fn a_patch_changes_only_what_it_names_and_keeps_the_position() {
        let placed = PetSettings { position: Some(PetPosition { display: "LG".into(), x: 0.5 }), ..on() };
        let patch: PetSettingsPatch = serde_json::from_str(r#"{"colour":"blue","size":"large","bubbleKinds":{"inputNeeded":true,"assistantDone":false,"reminderFired":true}}"#).unwrap();
        let next = placed.clone().with(patch);
        assert_eq!(next.colour, PetColour::Blue);
        assert_eq!(next.size, PetSize::Large);
        assert!(!next.bubble_kinds.assistant_done);
        assert_eq!(next.position, placed.position);
        assert_eq!(next.movement, PetMovement::Calm);
    }

    // The pet page shows notifications and opens sessions; it must not get
    // the app windows' grant (access keys, settings, backend switching).
    #[test]
    fn the_pet_gets_only_its_own_commands() {
        let strings = |v: &serde_json::Value| -> Vec<String> {
            v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
        };
        let default: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(!strings(&default["windows"]).contains(&PET_WINDOW.to_string()));
        let pet: serde_json::Value = serde_json::from_str(include_str!("../capabilities/pet.json")).unwrap();
        assert_eq!(strings(&pet["windows"]), [PET_WINDOW]);
        assert!(pet.get("remote").is_none());
        assert_eq!(
            strings(&pet["permissions"]),
            ["core:event:default", "allow-pet-state", "allow-pet-fit", "allow-pet-open", "allow-pet-drag-end"],
        );
    }
}
