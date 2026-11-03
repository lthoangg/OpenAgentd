//! The desktop pet (macOS and Windows): a small pixel cat that stands
//! wherever it was dragged on a display (the bottom edge, above the Dock or
//! taskbar, by default), walks left and right at that height, and shows
//! agent notifications in a speech bubble instead of the system banner.
//!
//! The window (`web/pet.html`) is transparent and covers only a lane of the
//! display's work area: the full width, and just the height of what the pet
//! needs now (the pet and its marks, a bubble, a ladder, a balloon, a fall;
//! the whole area while it is dragged). Everywhere else the desktop has no
//! window of ours, so a meeting app's window picker can pick what is behind
//! the pet. The page works in the work area's CSS pixels ("area" pixels) and
//! asks for the frame it needs in `pet_fit`; this module clamps it to the
//! work area and moves the window ([`window_frame`]), then tells the page
//! the frame it got (`pet-frame`), so the page can draw at the right offset.
//! The lane never moves sideways. On macOS the page does not move with it:
//! the webview stays the size of the work area, fixed on screen, and the
//! window is only a viewport over it ([`viewport`]), so a lane whose top
//! edge moves shows no stale picture and the pet never has to hide. Where
//! that is not possible (Windows: WebView2 always fills its window), the
//! page hides the pet for a moment while the lane's top edge moves.
//!
//! Hit areas, the pointer, other windows' ledges and the saved position are
//! all in area pixels, whatever the window's frame is. Clicks pass through
//! the window except over the hit areas the page reports (`pet_fit`): Rust
//! polls the pointer and switches the window's click-through, like the notch
//! island does. The window never takes keyboard focus.
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
//!
//! A question stays with the pet until it is answered: "Later" only folds
//! its bubble behind the badge, and the right-click menu lists it first.
//! The bubble only tells: a click on it opens the session ([`pet_open`]),
//! where the question is answered.

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
/// The pointer near the pet, in the page's CSS pixels, or null once it leaves.
pub const PET_POINTER_EVENT: &str = "pet-pointer";
/// A session's question was answered somewhere: the page drops its bubble.
pub const PET_QUESTION_ANSWERED_EVENT: &str = "pet-question-answered";
/// Other apps' windows the pet can climb, front first, in the page's CSS pixels.
pub const PET_WINDOWS_EVENT: &str = "pet-windows";
/// The window's frame changed: the work area and the window in it (CSS px).
pub const PET_FRAME_EVENT: &str = "pet-frame";
/// The pet settings changed; sent to every window.
pub const PET_SETTINGS_EVENT: &str = "pet-settings-changed";
/// The tray menu item that turns the pet on or off.
pub const MENU_TOGGLE_PET: &str = "toggle_pet";

/// Built this long after launch, so its page load does not compete with
/// the main window's.
const PREWARM_DELAY: Duration = Duration::from_secs(3);
/// Pointer polling: often while it is near the pet, rarely far from it
/// or while the pet is hidden (then only the full-screen state is checked).
const POLL_NEAR: Duration = Duration::from_millis(50);
const POLL_FAR: Duration = Duration::from_millis(250);
const POLL_HIDDEN: Duration = Duration::from_secs(1);
/// How close (logical px from the pet or a bubble) counts as near.
const NEAR: f64 = 200.0;
/// How often the displays are re-read (plugged in, resolution, Dock moved).
const GEOMETRY_EVERY: Duration = Duration::from_secs(2);
/// How often the Dock or taskbar settings (hiding, size, side) are re-read.
const BAR_EVERY: Duration = Duration::from_secs(15);
const MAX_SEEN: usize = 64;
const MAX_ROUTES: usize = 50;
/// How long a question's bubble waits for the server to say what its
/// options are; past it the bubble shows with "Open to answer" only.
const QUESTION_WAIT: Duration = Duration::from_secs(3);

// ── Settings ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetCharacter {
    #[default]
    Cat,
    Duck,
    Crab,
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
    /// Playful, and runs about (zoomies) now and then.
    Chaotic,
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

/// Where the pet was last dropped: the display (by name), how far across
/// it, 0 (left) to 1 (right), and the height its feet stand at, 0 (top) to
/// 1 (bottom). Settings saved before it could move up lack `y`: the bottom.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PetPosition {
    pub display: String,
    pub x: f64,
    #[serde(default = "bottom_edge")]
    pub y: f64,
}

fn bottom_edge() -> f64 {
    1.0
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
    /// Jump onto other apps' windows (when playful or chaotic).
    pub climb: bool,
    /// Ladders and balloons: it now and then climbs a ladder or floats up on
    /// a balloon to change height. Settings saved before default to on.
    pub toys: bool,
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
            climb: true,
            toys: true,
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
    pub climb: Option<bool>,
    pub toys: Option<bool>,
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
            climb: patch.climb.unwrap_or(self.climb),
            toys: patch.toys.unwrap_or(self.toys),
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

/// Whether the pet should be on screen. It always steps aside for a
/// full-screen app or presentation (macOS keeps it off their Spaces).
pub fn should_show(settings: &PetSettings, frontmost: bool, fullscreen: bool) -> bool {
    settings.enabled && (!frontmost || settings.show_when_frontmost) && !fullscreen
}

/// Whether the pet climbs onto other windows, so the page needs them.
pub fn climbs(settings: &PetSettings) -> bool {
    settings.climb && matches!(settings.movement, PetMovement::Playful | PetMovement::Chaotic)
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

/// A notification's title in the app's one vocabulary. The backend titles a
/// question "Needs input · web"; every surface (the bubble, the system
/// notification, the lists) says "Needs you".
pub fn display_title(kind: &str, title: &str) -> String {
    match title.strip_prefix("Needs input").filter(|_| kind == "input_needed") {
        Some(rest) => format!("Needs you{rest}"),
        None => title.to_string(),
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

/// The pet window's frame: the whole work area, in physical pixels.
pub fn pet_frame(work: Area) -> Area {
    let scale = if work.scale.is_finite() && work.scale > 0.0 { work.scale } else { 1.0 };
    Area { scale, ..work }
}

// ── The window's frame ──────────────────────────────────────────────────────

/// The pet's height at medium size in CSS px (`PET_HEIGHT` in `state.ts`).
const PET_HEIGHT: f64 = 48.0;
/// Room the window keeps above the pet (its marks, its poke reply) and
/// below its feet, in CSS px (`FRAME_ABOVE`, `FRAME_BELOW` in `state.ts`).
const FRAME_ABOVE: f64 = 56.0;
const FRAME_BELOW: f64 = 12.0;
/// The smallest window, in physical px.
const MIN_FRAME: u32 = 16;

/// The pet's size against medium (`SIZE_SCALE` in `state.ts`).
pub fn size_scale(size: PetSize) -> f64 {
    match size {
        PetSize::Small => 0.75,
        PetSize::Medium => 1.0,
        PetSize::Large => 1.4,
    }
}

/// How big the page's world is: the work area, in CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

/// The window's frame inside the work area, in the page's CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PageFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The work area in CSS pixels.
pub fn page_size(work: &Area) -> PageSize {
    let scale = pet_frame(*work).scale;
    PageSize { width: f64::from(work.width) / scale, height: f64::from(work.height) / scale }
}

/// One axis of a frame: `start` and `len` (CSS px) rounded to physical
/// pixels inside `0..total`, at least [`MIN_FRAME`] long.
fn frame_axis(start: f64, len: f64, total: u32, scale: f64) -> (u32, u32) {
    let total = f64::from(total);
    let a = (start * scale).round().clamp(0.0, total);
    let b = ((start + len) * scale).round().clamp(0.0, total);
    let (a, mut b) = (a.min(b), a.max(b));
    let min = f64::from(MIN_FRAME).min(total);
    let mut a = a;
    if b - a < min {
        b = (a + min).min(total);
        a = (b - min).max(0.0);
    }
    (a as u32, (b - a) as u32)
}

/// The window's frame, in physical screen pixels, for the frame the page
/// asks for (CSS px in the work area): clamped to the work area and rounded
/// to whole pixels. While dragging, or without a usable request, it is the
/// whole work area, so the pet can be dropped anywhere.
pub fn window_frame(request: Option<&HitRect>, work: &Area, dragging: bool) -> Area {
    let work = pet_frame(*work);
    let Some(r) = request.filter(|r| r.is_valid() && !dragging) else {
        return work;
    };
    let (x, width) = frame_axis(r.x, r.width, work.width, work.scale);
    let (y, height) = frame_axis(r.y, r.height, work.height, work.scale);
    Area { x: work.x + x as i32, y: work.y + y as i32, width, height, scale: work.scale }
}

/// The window's frame in the page's CSS pixels, from its place on screen.
pub fn page_frame(window: &Area, work: &Area) -> PageFrame {
    let scale = pet_frame(*work).scale;
    PageFrame {
        x: f64::from(window.x - work.x) / scale,
        y: f64::from(window.y - work.y) / scale,
        width: f64::from(window.width) / scale,
        height: f64::from(window.height) / scale,
    }
}

/// The lane the window starts with, before the page has said what it needs:
/// the full width, around the pet's saved feet height (default: the bottom).
pub fn initial_request(position: Option<&PetPosition>, size: PetSize, work: &Area) -> HitRect {
    let area = page_size(work);
    let fraction = position.map(|p| p.y).filter(|y| y.is_finite()).unwrap_or_else(bottom_edge).clamp(0.0, 1.0);
    let feet = fraction * area.height;
    let top = (feet - PET_HEIGHT * size_scale(size) - FRAME_ABOVE).max(0.0).round();
    let bottom = (feet + FRAME_BELOW).min(area.height).round();
    HitRect { x: 0.0, y: top, width: area.width, height: (bottom - top).max(0.0) }
}

/// Move and resize the pet window to `frame` (physical px). Main thread only.
/// On macOS the window becomes a viewport over a page fixed on screen
/// (`work`, the work area), in one step; true when it did. Otherwise: size
/// first (it keeps the window's top-left), and the page hides the pet while
/// the frame changes, so no half-way frame is seen.
fn set_window_frame(window: &WebviewWindow, frame: Area, work: Area) -> bool {
    if native::set_viewport(window, frame, work) {
        return true;
    }
    let _ = window.set_size(tauri::PhysicalSize::new(frame.width, frame.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(frame.x, frame.y));
    false
}

/// A rectangle in AppKit points, origin at the bottom left.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The window's frame on screen and the page's frame inside the window,
/// for a viewport over a page fixed on the work area.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    /// The window, in screen points (AppKit: from the primary display's bottom left).
    pub window: PointRect,
    /// The page in the window's content view (from its bottom left): the
    /// whole work area, wherever the window is over it.
    pub page: PointRect,
}

/// [`Viewport`] for the window at `frame` over `work` (both physical px,
/// top-left origin, as Tauri gives them), with the primary display
/// `primary_height` points tall. Tauri's physical pixels are the display's
/// points times its scale, and its top-left origin is the primary display's
/// top left; AppKit counts up from that display's bottom.
pub fn viewport(frame: &Area, work: &Area, primary_height: f64) -> Viewport {
    let scale = pet_frame(*work).scale;
    let pt = |v: f64| v / scale;
    let (top, height) = (pt(f64::from(frame.y)), pt(f64::from(frame.height)));
    let window = PointRect { x: pt(f64::from(frame.x)), y: primary_height - top - height, width: pt(f64::from(frame.width)), height };
    // The page's bottom sits on the work area's bottom, below the window's
    // bottom edge (or on it); its left on the work area's left.
    let work_bottom = f64::from(work.y) + f64::from(work.height);
    let frame_bottom = f64::from(frame.y) + f64::from(frame.height);
    let page = PointRect {
        x: pt(f64::from(work.x - frame.x)),
        y: -pt(work_bottom - frame_bottom),
        width: pt(f64::from(work.width)),
        height: pt(f64::from(work.height)),
    };
    Viewport { window, page }
}

/// What the page is told about its window: the world (the work area) and
/// where the window is in it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct FrameView {
    pub area: PageSize,
    pub frame: PageFrame,
    /// The page is fixed on screen and the window is a viewport over it:
    /// draw in area pixels with no offset, and never hide for a move.
    pub fixed: bool,
}

fn frame_view() -> Option<FrameView> {
    let s = shared().lock().unwrap();
    let (work, window) = (s.strip?, s.window?);
    Some(FrameView { area: page_size(&work), frame: page_frame(&window, &work), fixed: s.fixed })
}

/// The window moved or was resized: tell the page where it is now.
fn emit_frame(app: &AppHandle) {
    if let Some(view) = frame_view() {
        let _ = app.emit_to(PET_WINDOW, PET_FRAME_EVENT, view);
    }
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

/// A screen point (physical) in the pet window's CSS pixels.
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

/// Whether the pointer is close enough to the pet or a bubble to poll often.
pub fn near_hits(hits: &[HitRect], capture: bool, point: Option<(f64, f64)>) -> bool {
    capture
        || point.is_some_and(|(x, y)| {
            hits.iter().any(|h| x >= h.x - NEAR && x <= h.x + h.width + NEAR && y >= h.y - NEAR && y <= h.y + h.height + NEAR)
        })
}

/// The pointer, when it is near the pet itself (the first hit area): the
/// page turns the pet to look at it, and pounces at it.
pub fn pointer_near_pet(hits: &[HitRect], point: Option<(f64, f64)>) -> Option<(f64, f64)> {
    let pet = hits.first()?;
    point.filter(|&(x, y)| x >= pet.x - NEAR && x <= pet.x + pet.width + NEAR && y >= pet.y - NEAR && y <= pet.y + pet.height + NEAR)
}

// ── Other windows ───────────────────────────────────────────────────────────

/// Another app's window on screen, in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenWindow {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Another app's window in the page's CSS pixels: the page picks the top
/// edges the pet can stand on.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PageWindow {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Smaller windows (palettes, popups) are no place to stand, in CSS px.
const MIN_WINDOW: (f64, f64) = (120.0, 60.0);
/// Front windows sent to the page, at most.
const MAX_WINDOWS: usize = 24;
/// How often the other windows are read while the pet climbs.
const WINDOWS_EVERY: Duration = Duration::from_millis(200);

/// The windows over the pet's area, front first, in the page's CSS pixels
/// and rounded to whole pixels (so an unmoved window compares equal).
pub fn page_windows(windows: &[ScreenWindow], strip: &Area) -> Vec<PageWindow> {
    let (area_w, area_h) = (f64::from(strip.width) / strip.scale, f64::from(strip.height) / strip.scale);
    windows
        .iter()
        .filter(|w| [w.x, w.y, w.width, w.height].iter().all(|v| v.is_finite()))
        .map(|w| {
            let (x, y) = local_point(strip, w.x, w.y);
            PageWindow { id: w.id, x: x.round(), y: y.round(), width: (w.width / strip.scale).round(), height: (w.height / strip.scale).round() }
        })
        .filter(|w| w.width >= MIN_WINDOW.0 && w.height >= MIN_WINDOW.1)
        .filter(|w| w.x < area_w && w.x + w.width > 0.0 && w.y < area_h && w.y + w.height > 0.0)
        .take(MAX_WINDOWS)
        .collect()
}

/// Where across the display a drop at `x` lands, as a 0..1 fraction.
pub fn edge_fraction(x: f64, width: f64) -> f64 {
    if !x.is_finite() || !width.is_finite() || width <= 0.0 {
        return 0.3;
    }
    (x / width).clamp(0.0, 1.0)
}

/// How far down the display a drop with the feet at `y` lands, as a 0..1
/// fraction (unknown: the bottom).
pub fn height_fraction(y: f64, height: f64) -> f64 {
    if !y.is_finite() || !height.is_finite() || height <= 0.0 {
        return bottom_edge();
    }
    (y / height).clamp(0.0, 1.0)
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
    /// The notification's kind: a question is never read away by a dismiss.
    kind: String,
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
    /// The window's frame on screen (physical px): a lane of `strip`.
    window: Option<Area>,
    /// The window is a viewport over a page fixed on screen ([`viewport`]):
    /// the page draws with no offset and never hides for a move.
    fixed: bool,
    hits: Vec<HitRect>,
    /// A drag is under way: keep taking clicks wherever the pointer is.
    capture: bool,
    /// The window takes clicks now.
    taking_clicks: bool,
    /// The pointer near the pet as last sent to the page, rounded.
    pointer: Option<(i32, i32)>,
    /// Other windows as last sent to the page, and when they were read.
    windows: Vec<PageWindow>,
    windows_read: Option<Instant>,
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
            window: None,
            fixed: false,
            hits: Vec::new(),
            capture: false,
            taking_clicks: false,
            pointer: None,
            windows: Vec::new(),
            windows_read: None,
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
        .inner_size(800.0, 600.0)
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
            s.window = None;
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
    native::configure(&window);
    let list = displays(app);
    let Some(display) = pick_display(&list, settings.position.as_ref().map(|p| p.display.as_str())) else {
        return;
    };
    let bar = *hidden_bar().lock().unwrap();
    let frame = pet_frame(leave_room_for_hidden_bar(display.work, display.bottom, bar));
    let lane = window_frame(Some(&initial_request(settings.position.as_ref(), settings.size, &frame)), &frame, false);
    let (moved, was_shown) = {
        let mut s = shared().lock().unwrap();
        let moved = s.strip.replace(frame) != Some(frame);
        if moved {
            s.window = Some(lane);
        }
        (moved, s.shown)
    };
    if moved {
        let fixed = set_window_frame(&window, lane, frame);
        shared().lock().unwrap().fixed = fixed;
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
        log::info!("pet: shown on {:?} {}x{} (window {}x{})", display.name, frame.width, frame.height, lane.width, lane.height);
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
    let near = pointer_near_pet(&hits, point);
    let rounded = near.map(|(x, y)| (x.round() as i32, y.round() as i32));
    let pointer_moved = {
        let mut s = shared().lock().unwrap();
        s.taking_clicks = take;
        s.occluded = occluded;
        std::mem::replace(&mut s.pointer, rounded) != rounded
    };
    if pointer_moved {
        let payload = near.map(|(x, y)| serde_json::json!({ "x": x, "y": y }));
        let _ = app.emit_to(PET_WINDOW, PET_POINTER_EVENT, payload);
    }
    send_windows(app, &strip);
    if near_hits(&hits, capture, point) {
        POLL_NEAR
    } else {
        POLL_FAR
    }
}

// ── Feed ────────────────────────────────────────────────────────────────────

/// Send the page the other apps' windows while the pet climbs (at most
/// every [`WINDOWS_EVERY`], and only when they changed), or an empty list
/// once it stops. Main thread only.
fn send_windows(app: &AppHandle, strip: &Area) {
    let (climbing, due) = {
        let s = shared().lock().unwrap();
        (climbs(&s.settings), s.windows_read.map_or(true, |at| at.elapsed() >= WINDOWS_EVERY))
    };
    let next = if climbing {
        if !due {
            return;
        }
        page_windows(&native::other_windows(strip.scale), strip)
    } else {
        Vec::new()
    };
    let changed = {
        let mut s = shared().lock().unwrap();
        s.windows_read = climbing.then(Instant::now);
        if s.windows == next {
            false
        } else {
            s.windows = next.clone();
            true
        }
    };
    if changed {
        let _ = app.emit_to(PET_WINDOW, PET_WINDOWS_EVENT, next);
    }
}

/// The pet's view of the agents, as the page reads it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetView {
    settings: PetSettings,
    status: PetStatus,
    shown: bool,
    /// The world the page draws in (the work area) and the window's frame in
    /// it, in CSS px; absent until the window is placed.
    area: Option<PageSize>,
    frame: Option<PageFrame>,
    /// See [`FrameView::fixed`].
    fixed: bool,
}

fn view() -> PetView {
    let s = shared().lock().unwrap();
    let frames = s.strip.zip(s.window).map(|(work, window)| (page_size(&work), page_frame(&window, &work)));
    PetView {
        settings: s.settings.clone(),
        status: s.status,
        shown: s.shown,
        area: frames.map(|f| f.0),
        frame: frames.map(|f| f.1),
        fixed: s.fixed,
    }
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
    /// A question's id, once the server has said it (see [`with_question`]).
    pub question_id: Option<String>,
}

/// The bubble for a `desktop_notification` event, if it is one.
pub fn bubble_from_event(data: &str) -> Option<PetBubble> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let id = v["notification_id"].as_str()?.to_string();
    let kind = v["kind"].as_str()?.to_string();
    let title = display_title(&kind, v["title"].as_str()?);
    let body = v["body"].as_str().unwrap_or_default().to_string();
    let session_id = v["session_id"].as_str().map(str::to_string);
    Some(PetBubble { tone: bubble_tone(&kind, &title), id, kind, session_id, title, body, question_id: None })
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
            s.routes.push_back(Route { notification_id: bubble.id.clone(), session_id, server: server.clone(), kind: bubble.kind.clone() });
        }
    }
    log::info!("pet: bubble kind={} tone={}", bubble.kind, bubble.tone);
    if bubble.kind == "input_needed" && bubble.session_id.is_some() {
        // The notification only says what was asked; the options and the id
        // to answer come from the server.
        let (app, server) = (app.clone(), server.clone());
        tauri::async_runtime::spawn(async move {
            let bubble = with_question(&app, &server, bubble).await;
            let _ = app.emit_to(PET_WINDOW, PET_NOTIFICATION_EVENT, bubble);
        });
    } else {
        let _ = app.emit_to(PET_WINDOW, PET_NOTIFICATION_EVENT, bubble);
    }
    true
}

/// `bubble` with the options and the id of the question its session holds.
/// Best effort: without them the bubble offers "Open to answer" alone.
async fn with_question(app: &AppHandle, server: &ServerId, bubble: PetBubble) -> PetBubble {
    let Some(session_id) = bubble.session_id.clone() else {
        return bubble;
    };
    match tokio::time::timeout(QUESTION_WAIT, crate::answers::fetch_question(app, server, &session_id)).await {
        Ok(Ok(Some(question))) => with_open_question(bubble, &question),
        Ok(Ok(None)) => bubble,
        Ok(Err(e)) => {
            log::debug!("pet: could not read the question of {session_id}: {e:#}");
            bubble
        }
        Err(_) => bubble,
    }
}

/// `bubble` carrying what `question` says: its id. The notification's own
/// body stays unless it was empty.
pub fn with_open_question(mut bubble: PetBubble, question: &crate::answers::OpenQuestion) -> PetBubble {
    bubble.question_id = Some(question.id.clone());
    if bubble.body.trim().is_empty() {
        bubble.body = question.text().unwrap_or_default().to_string();
    }
    bubble
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
        title: display_title(kind, title),
        body: body.to_string(),
        question_id: None,
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

/// The page's clickable areas (the pet and its bubbles) in area pixels,
/// whether a drag is under way, and the frame (area pixels) the window
/// should have now: the lane the pet needs, or the whole area while it is
/// dragged. A new frame is applied at once and sent back as `pet-frame`.
#[tauri::command]
pub fn pet_fit(app: AppHandle, window: WebviewWindow, rects: Vec<HitRect>, capture: bool, frame: Option<HitRect>) {
    if window.label() != PET_WINDOW {
        return;
    }
    let next = {
        let mut s = shared().lock().unwrap();
        s.hits = rects.into_iter().filter(HitRect::is_valid).take(16).collect();
        s.capture = capture;
        let next = s.strip.filter(|_| frame.is_some()).map(|work| window_frame(frame.as_ref(), &work, capture));
        let next = next.filter(|next| s.window.is_some_and(|now| now != *next)).inspect(|next| s.window = Some(*next));
        next.zip(s.strip)
    };
    if let Some((next, work)) = next {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window(PET_WINDOW) {
                let fixed = set_window_frame(&window, next, work);
                shared().lock().unwrap().fixed = fixed;
            }
            emit_frame(&handle);
        });
    }
    wake().notify_one();
}

/// Open the session a bubble is about, in an app window on its server.
#[tauri::command]
pub fn pet_open(app: AppHandle, window: WebviewWindow, notification_id: String) {
    if window.label() != PET_WINDOW {
        return;
    }
    open_notification(&app, &notification_id);
}

fn open_notification(app: &AppHandle, notification_id: &str) {
    let route = shared().lock().unwrap().routes.iter().find(|r| r.notification_id == notification_id).cloned();
    let Some(route) = route else {
        log::warn!("pet: no session for bubble {notification_id}");
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::island::open_session(&app, route.server, &route.session_id, crate::island::OpenIn::Existing).await {
            Ok(()) => crate::island::mark_session_read(&app, &route.session_id, None),
            Err(e) => log::warn!("pet: could not open session: {e:#}"),
        }
    });
}

/// A session's question was answered (an [`id_key`]), here or elsewhere: the
/// page drops its bubble.
pub fn question_answered(app: &AppHandle, key: &str) {
    if !is_enabled() {
        return;
    }
    let _ = app.emit_to(PET_WINDOW, PET_QUESTION_ANSWERED_EVENT, serde_json::json!({ "sessionKey": key }));
}

/// The sessions the dismissed bubbles are about, once each. A question is
/// not one of them: it still waits on the user, so "Later" must not read it away.
fn dismissed_sessions(routes: &VecDeque<Route>, notification_ids: &[String]) -> Vec<String> {
    let mut sessions: Vec<String> = Vec::new();
    for id in notification_ids.iter().take(MAX_ROUTES) {
        if let Some(route) = routes.iter().find(|r| &r.notification_id == id && r.kind != "input_needed") {
            if !sessions.iter().any(|s| id_key(s) == id_key(&route.session_id)) {
                sessions.push(route.session_id.clone());
            }
        }
    }
    sessions
}

/// The user dismissed bubbles (×, or Clear Notifications): their sessions
/// are read everywhere, as a dismiss on the island is.
#[tauri::command]
pub fn pet_dismiss(app: AppHandle, window: WebviewWindow, notification_ids: Vec<String>) {
    if window.label() != PET_WINDOW {
        return;
    }
    // Never hold the pet's lock while the island takes its own.
    let sessions = dismissed_sessions(&shared().lock().unwrap().routes, &notification_ids);
    for session_id in sessions {
        crate::island::mark_session_read(&app, &session_id, None);
    }
}

/// A session was read somewhere (an [`id_key`]): the page drops its bubbles
/// about it, except a question still waiting on the user.
pub fn forget_session(app: &AppHandle, key: &str) {
    if !is_enabled() {
        return;
    }
    let _ = app.emit_to(PET_WINDOW, PET_SESSION_READ_EVENT, serde_json::json!({ "sessionKey": key }));
}

// ── Right-click menu ────────────────────────────────────────────────────────

/// Sent to the pet page when a menu item changes its bubbles.
pub const PET_MENU_EVENT: &str = "pet-menu-action";
/// Sent to the pet page when a session was read somewhere.
pub const PET_SESSION_READ_EVENT: &str = "pet-session-read";
/// Unread notifications listed in the menu, at most.
const MENU_MAX_UNREAD: usize = 6;
/// A notification title in the menu is cut to this many characters.
const MENU_TITLE_MAX: usize = 48;

/// An unread bubble the page lists in the menu.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct MenuUnread {
    pub id: String,
    pub title: String,
}

/// What a pet menu item does. Items the tray has too (open the app, a new
/// session, settings, hide the pet) reuse the tray's ids instead.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PetMenuAction<'a> {
    Open(&'a str),
    Clear,
    Movement(PetMovement),
    Character(PetCharacter),
}

fn movement_key(movement: PetMovement) -> &'static str {
    match movement {
        PetMovement::Still => "still",
        PetMovement::Calm => "calm",
        PetMovement::Playful => "playful",
        PetMovement::Chaotic => "chaotic",
    }
}

const CHARACTERS: [(PetCharacter, &str, &str); 3] = [(PetCharacter::Cat, "cat", "Cat"), (PetCharacter::Duck, "duck", "Duck"), (PetCharacter::Crab, "crab", "Crab")];

fn character_key(character: PetCharacter) -> &'static str {
    CHARACTERS.iter().find(|(c, _, _)| *c == character).map_or("cat", |(_, key, _)| key)
}

pub fn menu_id(action: PetMenuAction) -> String {
    match action {
        PetMenuAction::Open(id) => format!("pet:open:{id}"),
        PetMenuAction::Clear => "pet:clear".to_string(),
        PetMenuAction::Movement(m) => format!("pet:movement:{}", movement_key(m)),
        PetMenuAction::Character(c) => format!("pet:character:{}", character_key(c)),
    }
}

pub fn parse_menu_id(id: &str) -> Option<PetMenuAction<'_>> {
    let rest = id.strip_prefix("pet:")?;
    if rest == "clear" {
        return Some(PetMenuAction::Clear);
    }
    if let Some(notification_id) = rest.strip_prefix("open:").filter(|n| !n.is_empty()) {
        return Some(PetMenuAction::Open(notification_id));
    }
    if let Some(key) = rest.strip_prefix("character:") {
        return CHARACTERS.iter().find(|(_, k, _)| *k == key).map(|(c, _, _)| PetMenuAction::Character(*c));
    }
    let movement = match rest.strip_prefix("movement:")? {
        "still" => PetMovement::Still,
        "calm" => PetMovement::Calm,
        "playful" => PetMovement::Playful,
        "chaotic" => PetMovement::Chaotic,
        _ => return None,
    };
    Some(PetMenuAction::Movement(movement))
}

/// The rows of one menu section (questions, or unread): the newest few,
/// titles cut to fit, and whether each can be opened (only a notification
/// about a session can).
pub fn unread_rows(unread: &[MenuUnread], openable: impl Fn(&str) -> bool) -> Vec<(String, String, bool)> {
    unread
        .iter()
        .take(MENU_MAX_UNREAD)
        .map(|u| {
            let title = u.title.trim();
            let title = if title.chars().count() > MENU_TITLE_MAX {
                format!("{}…", title.chars().take(MENU_TITLE_MAX - 1).collect::<String>())
            } else if title.is_empty() {
                "Notification".to_string()
            } else {
                title.to_string()
            };
            (u.id.clone(), title, openable(&u.id))
        })
        .collect()
}

/// Called by the app's single menu listener. False when `id` is not a pet item.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some(action) = parse_menu_id(id) else {
        return false;
    };
    match action {
        PetMenuAction::Open(notification_id) => {
            open_notification(app, notification_id);
            let _ = app.emit_to(PET_WINDOW, PET_MENU_EVENT, serde_json::json!({ "action": "dismiss", "id": notification_id }));
        }
        PetMenuAction::Clear => {
            let _ = app.emit_to(PET_WINDOW, PET_MENU_EVENT, serde_json::json!({ "action": "clear" }));
        }
        PetMenuAction::Movement(movement) => {
            let patch = PetSettingsPatch { movement: Some(movement), ..PetSettingsPatch::default() };
            if let Err(e) = update_settings(app, patch) {
                log::warn!("pet: could not change movement: {e:#}");
            }
        }
        PetMenuAction::Character(character) => {
            let patch = PetSettingsPatch { character: Some(character), ..PetSettingsPatch::default() };
            if let Err(e) = update_settings(app, patch) {
                log::warn!("pet: could not change character: {e:#}");
            }
        }
    }
    true
}

/// Right-click on the pet: a native menu at (`x`, `y`), CSS pixels in the
/// pet window, listing what waits on the user (`questions`) before what was
/// missed (`unread`). The promise stays pending until the menu closes.
#[tauri::command]
pub async fn pet_menu(
    app: AppHandle,
    window: WebviewWindow,
    x: f64,
    y: f64,
    unread: Vec<MenuUnread>,
    questions: Option<Vec<MenuUnread>>,
) -> Result<(), String> {
    if window.label() != PET_WINDOW {
        return Err("Only the pet can show its menu.".into());
    }
    let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
    if !x.is_finite() || !y.is_finite() || !(0.0..=size.width).contains(&x) || !(0.0..=size.height).contains(&y) {
        return Err("Invalid menu position.".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = show_menu(&handle, &window, x, y, &questions.unwrap_or_default(), &unread);
        if let Err(e) = &result {
            log::warn!("pet: could not show its menu: {e:#}");
        }
        let _ = tx.send(result.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

/// Main thread only.
fn show_menu(app: &AppHandle, window: &WebviewWindow, x: f64, y: f64, questions: &[MenuUnread], unread: &[MenuUnread]) -> Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let (movement, character, question_rows, rows) = {
        let s = shared().lock().unwrap();
        let openable = |id: &str| s.routes.iter().any(|r| r.notification_id == id);
        (s.settings.movement, s.settings.character, unread_rows(questions, openable), unread_rows(unread, openable))
    };
    let menu = Menu::new(app)?;
    // What waits on the user comes first.
    if !question_rows.is_empty() {
        menu.append(&MenuItem::with_id(app, "pet:heading:needs-you", "Needs you", false, None::<&str>)?)?;
        for (id, title, openable) in &question_rows {
            menu.append(&MenuItem::with_id(app, menu_id(PetMenuAction::Open(id)), title, *openable, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    if !rows.is_empty() {
        menu.append(&MenuItem::with_id(app, "pet:heading:unread", "Unread", false, None::<&str>)?)?;
        for (id, title, openable) in &rows {
            menu.append(&MenuItem::with_id(app, menu_id(PetMenuAction::Open(id)), title, *openable, None::<&str>)?)?;
        }
        menu.append(&MenuItem::with_id(app, menu_id(PetMenuAction::Clear), "Clear Notifications", true, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, crate::menu::MENU_SHOW, "Open OpenAgentd", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, crate::menu::MENU_NEW_SESSION, "New Session", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let moves = Submenu::with_id(app, "pet:movement", "Movement", true)?;
    for (choice, label) in [(PetMovement::Still, "Stay Put"), (PetMovement::Calm, "Calm"), (PetMovement::Playful, "Playful"), (PetMovement::Chaotic, "Chaotic")] {
        moves.append(&CheckMenuItem::with_id(app, menu_id(PetMenuAction::Movement(choice)), label, true, choice == movement, None::<&str>)?)?;
    }
    menu.append(&moves)?;
    let characters = Submenu::with_id(app, "pet:character", "Character", true)?;
    for (choice, _, label) in CHARACTERS {
        characters.append(&CheckMenuItem::with_id(app, menu_id(PetMenuAction::Character(choice)), label, true, choice == character, None::<&str>)?)?;
    }
    menu.append(&characters)?;
    menu.append(&MenuItem::with_id(app, crate::menu::MENU_SETTINGS, "Desktop Pet Settings…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, MENU_TOGGLE_PET, "Hide Desktop Pet", true, None::<&str>)?)?;
    // Keep taking clicks while the menu tracks the pointer (AppKit runs a
    // nested loop), and hold no lock across it.
    shared().lock().unwrap().capture = true;
    let result = window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y));
    shared().lock().unwrap().capture = false;
    wake().notify_one();
    result.context("show the pet menu")
}

/// The pet was dropped with its left edge at `x` and its feet at `y` (CSS
/// pixels in the window). Dropped over another display, it moves there.
#[tauri::command]
pub fn pet_drag_end(app: AppHandle, window: WebviewWindow, x: f64, y: f64) {
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
            y: height_fraction(c.y - f64::from(display.work.y), f64::from(display.work.height)),
            display: display.name,
        },
        _ => PetPosition {
            display: here.unwrap_or_default(),
            x: edge_fraction(x, f64::from(strip.width) / strip.scale),
            y: height_fraction(y, f64::from(strip.height) / strip.scale),
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
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowOcclusionState, NSWindowSharingType};

    fn with_ns_window<T>(window: &tauri::WebviewWindow, f: impl FnOnce(&NSWindow) -> T) -> Option<T> {
        MainThreadMarker::new()?;
        match window.ns_window() {
            // SAFETY: Tauri hands out the window's live NSWindow, and we are on
            // the main thread, where AppKit objects may be used.
            Ok(ptr) if !ptr.is_null() => Some(f(unsafe { &*(ptr as *const NSWindow) })),
            _ => None,
        }
    }

    /// On every Space but full-screen ones, out of Cmd-` cycling and
    /// Mission Control, and out of screen sharing.
    pub fn configure(window: &tauri::WebviewWindow) {
        with_ns_window(window, |ns| {
            let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle;
            if ns.collectionBehavior() != behavior {
                ns.setCollectionBehavior(behavior);
            }
            ns.setHasShadow(false);
            // The window is a transparent sheet over the whole work area, so
            // a meeting app's window picker took it for the window under the
            // pointer and nothing behind it could be picked. Not shareable,
            // it stays out of pickers and captures that honour the flag
            // (ScreenCaptureKit on macOS 15+ may still capture it).
            if ns.sharingType() != NSWindowSharingType::None {
                ns.setSharingType(NSWindowSharingType::None);
            }
            prevent_activation(ns);
        });
    }

    /// A click on the pet (a poke) must leave the app you are in frontmost.
    /// `focusable(false)` only refuses key status: AppKit still activates
    /// the whole app on a mouse-down in one of its windows. A
    /// non-activating NSPanel avoids that through this same private switch,
    /// which plain NSWindows honour too. Windows gets the same from
    /// `focusable(false)` (`WS_EX_NOACTIVATE`).
    fn prevent_activation(ns: &NSWindow) {
        let set = sel!(_setPreventsActivation:);
        if ns.respondsToSelector(set) {
            // SAFETY: the selector exists on this window (checked above) and
            // takes one BOOL argument.
            let _: () = unsafe { msg_send![ns, _setPreventsActivation: Bool::YES] };
        } else {
            log::warn!("pet: cannot keep clicks from activating the app on this macOS");
        }
    }

    /// Bring to the front without activating the app.
    pub fn show(window: &tauri::WebviewWindow) {
        with_ns_window(window, |ns| ns.orderFrontRegardless());
    }

    /// Make the window a viewport over a page fixed on screen: move the
    /// window to `frame` and the webview inside it so the page stays on the
    /// work area (`work`), both in one Core Animation transaction, so no
    /// frame shows the page at its old offset. A webview that is resized
    /// keeps showing its old picture, anchored at the old top-left, until it
    /// has redrawn; this one never changes size or place on screen. False
    /// (and nothing changed) when the webview is not where wry puts it: a
    /// WKWebView inside the window's content view.
    pub fn set_viewport(window: &tauri::WebviewWindow, frame: super::Area, work: super::Area) -> bool {
        use objc2::runtime::AnyClass;
        use objc2_app_kit::{NSAutoresizingMaskOptions, NSScreen};
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        use objc2_quartz_core::CATransaction;

        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let Some(class) = AnyClass::get(c"WKWebView") else {
            return false;
        };
        let rect = |r: super::PointRect| NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.width, r.height));
        with_ns_window(window, |ns| {
            // The primary display (the one with the menu bar) is AppKit's origin.
            let Some(primary) = NSScreen::screens(mtm).firstObject() else {
                return false;
            };
            let Some(content) = ns.contentView() else {
                return false;
            };
            let Some(webview) = content.subviews().iter().find(|view| view.isKindOfClass(class)) else {
                warn_once();
                return false;
            };
            let target = super::viewport(&frame, &work, primary.frame().size.height);
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            // wry stretches the webview with its window; here its frame is ours.
            if !webview.autoresizingMask().is_empty() {
                webview.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
            }
            ns.setFrame_display(rect(target.window), false);
            webview.setFrame(rect(target.page));
            CATransaction::commit();
            true
        })
        .unwrap_or(false)
    }

    /// A newer wry laid the window out differently: the pet falls back to
    /// hiding while its lane moves. Said once.
    fn warn_once() {
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| log::warn!("pet: no WKWebView in the window's content view; the lane moves the page with it"));
    }

    /// Other apps' ordinary windows on screen, front first, in physical
    /// pixels of a display at `scale`. Reads frames only (no titles), which
    /// needs no Screen Recording permission.
    pub fn other_windows(scale: f64) -> Vec<super::ScreenWindow> {
        use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGRect};
        use objc2_core_graphics::{
            kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerPID, CGRectMakeWithDictionaryRepresentation,
            CGWindowListCopyWindowInfo, CGWindowListOption,
        };

        let options = CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
        let Some(list) = CGWindowListCopyWindowInfo(options, kCGNullWindowID) else {
            return Vec::new();
        };
        // SAFETY: CoreGraphics documents the list as an array of
        // dictionaries keyed by CFString.
        let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> = unsafe { CFRetained::cast_unchecked(list) };
        // SAFETY: the keys are constant CFStrings exported by CoreGraphics.
        let (bounds_key, layer_key, number_key, pid_key, alpha_key) = unsafe { (kCGWindowBounds, kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerPID, kCGWindowAlpha) };
        let own_pid = i64::from(std::process::id());
        let mut found = Vec::new();
        for entry in list.iter() {
            let number = |key: &CFString| entry.get(key).and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_f64));
            if number(layer_key) != Some(0.0) || number(pid_key) == Some(own_pid as f64) || number(alpha_key).is_some_and(|a| a <= 0.0) {
                continue;
            }
            let Some(id) = number(number_key) else { continue };
            let Some(bounds) = entry.get(bounds_key) else { continue };
            let Some(bounds) = bounds.downcast_ref::<CFDictionary>() else { continue };
            let mut rect = CGRect::default();
            // SAFETY: `bounds` is the window's bounds dictionary and `rect`
            // a valid place to write it.
            if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect) } {
                continue;
            }
            found.push(super::ScreenWindow {
                id: id as u64,
                x: rect.origin.x * scale,
                y: rect.origin.y * scale,
                width: rect.size.width * scale,
                height: rect.size.height * scale,
            });
        }
        found
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
    /// Out of screen sharing: the window is a transparent sheet over the
    /// whole work area, so a meeting app's window picker listed or picked it
    /// instead of the window behind it. A tool window is left out of window
    /// lists (Alt-Tab, Chrome's and Zoom's pickers), and the display
    /// affinity keeps it out of captures (Windows 10 2004 and later).
    pub fn configure(window: &tauri::WebviewWindow) {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowDisplayAffinity, SetWindowLongPtrW, GWL_EXSTYLE, WDA_EXCLUDEFROMCAPTURE, WS_EX_TOOLWINDOW,
        };
        let Ok(hwnd) = window.hwnd() else { return };
        // SAFETY: `hwnd` is this app window's live handle; both calls only
        // change its own styles.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let tool = WS_EX_TOOLWINDOW.0 as isize;
            if ex & tool == 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | tool);
            }
            if let Err(e) = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
                log::warn!("pet: cannot keep the window out of screen captures: {e}");
            }
        }
    }

    pub fn show(window: &tauri::WebviewWindow) {
        let _ = window.show();
    }

    /// WebView2 always fills its window (wry resets its bounds on every
    /// resize), so the page moves with the window and hides for a move.
    pub fn set_viewport(_window: &tauri::WebviewWindow, _frame: super::Area, _work: super::Area) -> bool {
        false
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

    /// Other apps' ordinary windows on screen, front first, in physical
    /// pixels (the app is per-monitor DPI aware). Reads frames only.
    pub fn other_windows(_scale: f64) -> Vec<super::ScreenWindow> {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, RECT};
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowLongW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
        };

        struct Found {
            own_pid: u32,
            windows: Vec<super::ScreenWindow>,
        }

        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            // SAFETY: `lparam` is the `Found` passed to EnumWindows below,
            // alive and not otherwise borrowed for the whole enumeration.
            let found = unsafe { &mut *(lparam.0 as *mut Found) };
            // SAFETY: plain queries about a window EnumWindows handed us.
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                    return BOOL(1);
                }
                if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                    return BOOL(1);
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid == found.own_pid {
                    return BOOL(1);
                }
                // Suspended UWP apps and windows on other virtual desktops
                // are "cloaked": visible to the API, not on screen.
                let mut cloaked = 0u32;
                let size = std::mem::size_of::<u32>() as u32;
                if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), size).is_ok() && cloaked != 0 {
                    return BOOL(1);
                }
                // The frame without the invisible resize borders.
                let mut rect = RECT::default();
                let size = std::mem::size_of::<RECT>() as u32;
                if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, (&mut rect as *mut RECT).cast(), size).is_err() {
                    return BOOL(1);
                }
                found.windows.push(super::ScreenWindow {
                    id: hwnd.0 as usize as u64,
                    x: f64::from(rect.left),
                    y: f64::from(rect.top),
                    width: f64::from(rect.right - rect.left),
                    height: f64::from(rect.bottom - rect.top),
                });
            }
            BOOL(1)
        }

        let mut found = Found { own_pid: std::process::id(), windows: Vec::new() };
        // SAFETY: `each` only touches `found` through `lparam`, and the
        // enumeration finishes before `found` goes out of scope.
        let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut found as *mut Found as isize)) };
        found.windows
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod native {
    pub fn configure(_window: &tauri::WebviewWindow) {}

    pub fn show(window: &tauri::WebviewWindow) {
        let _ = window.show();
    }

    pub fn set_viewport(_window: &tauri::WebviewWindow, _frame: super::Area, _work: super::Area) -> bool {
        false
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

    pub fn other_windows(_scale: f64) -> Vec<super::ScreenWindow> {
        Vec::new()
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
        assert_eq!(defaults.position, None);
    }

    #[test]
    fn it_shows_only_when_on_and_steps_aside_for_the_app_and_full_screen_apps() {
        assert!(!should_show(&PetSettings::default(), false, false));
        assert!(should_show(&on(), false, false));
        assert!(!should_show(&on(), true, false), "OpenAgentd in front");
        assert!(should_show(&PetSettings { show_when_frontmost: true, ..on() }, true, false));
        assert!(!should_show(&on(), false, true), "full-screen app in front");
    }

    #[test]
    fn settings_saved_with_the_old_full_screen_switch_still_load() {
        let old: PetSettings = serde_json::from_str(r#"{"enabled": true, "hideInFullscreen": false, "colour": "blue"}"#).unwrap();
        assert_eq!(old, PetSettings { enabled: true, colour: PetColour::Blue, ..PetSettings::default() });
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
                question_id: None,
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
    fn a_question_is_titled_in_the_one_vocabulary_whatever_the_backend_calls_it() {
        assert_eq!(display_title("input_needed", "Needs input · api"), "Needs you · api");
        assert_eq!(display_title("input_needed", "Needs input"), "Needs you");
        assert_eq!(display_title("input_needed", "Needs you · api"), "Needs you · api");
        assert_eq!(display_title("assistant_done", "Needs input · api"), "Needs input · api", "only a question's title is renamed");
        let event = r#"{"notification_id":"n1","kind":"input_needed","session_id":"s1","title":"Needs input · api","body":"Keep v1?"}"#;
        assert_eq!(bubble_from_event(event).unwrap().title, "Needs you · api");
        assert_eq!(bubble_from_request("input_needed", Some("n1"), Some("s1"), "Needs input · api", "Keep v1?").title, "Needs you · api");
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
            question_id: None,
            server: None,
            server_id: None,
            goal: None,
            account: None,
        };
        let status = IslandStatus {
            seq: 1,
            sessions: vec![session("a", SessionState::NeedsInput), session("b", SessionState::Running), session("c", SessionState::Running)],
            unread: vec![session("d", SessionState::Done)],
            unreachable: Vec::new(),
        };
        assert_eq!(pet_status(&status), PetStatus { running: 2, needs_input: 1 });
    }

    #[test]
    fn the_window_covers_the_work_area() {
        let work = Area { x: 0, y: 25, width: 1440, height: 800, scale: 2.0 };
        assert_eq!(pet_frame(work), work);
        let bad_scale = pet_frame(Area { scale: f64::NAN, ..work });
        assert_eq!(bad_scale.scale, 1.0);
    }

    #[test]
    fn the_pointer_is_read_in_the_strips_css_pixels() {
        let strip = Area { x: 100, y: 500, width: 2000, height: 520, scale: 2.0 };
        assert_eq!(local_point(&strip, 300.0, 700.0), (100.0, 100.0));
    }

    fn work() -> Area {
        // A 2x display whose work area starts below a menu bar: 1440 x 800 CSS px.
        Area { x: 0, y: 50, width: 2880, height: 1600, scale: 2.0 }
    }

    #[test]
    fn a_viewport_keeps_the_page_on_the_work_area_wherever_the_lane_is() {
        // A 2x display 1000 pt tall, its work area below a 25 pt menu bar and above a 25 pt Dock.
        let work = Area { x: 0, y: 50, width: 3000, height: 1900, scale: 2.0 };
        let page = PointRect { x: 0.0, y: 0.0, width: 1500.0, height: 950.0 };
        // A lane at the bottom: the page's bottom is the window's.
        let low = viewport(&Area { x: 0, y: 1700, width: 3000, height: 250, scale: 2.0 }, &work, 1000.0);
        assert_eq!(low.window, PointRect { x: 0.0, y: 25.0, width: 1500.0, height: 125.0 });
        assert_eq!(low.page, page);
        // Higher up: the window moves, the page reaches below it by as much and stays put on screen.
        let high = viewport(&Area { x: 0, y: 1000, width: 3000, height: 250, scale: 2.0 }, &work, 1000.0);
        assert_eq!(high.window, PointRect { x: 0.0, y: 375.0, width: 1500.0, height: 125.0 });
        assert_eq!(high.page, PointRect { y: -350.0, ..page });
        for v in [low, high] {
            // The page's bottom on screen is the work area's (25 pt up), its top the work area's top (975 pt).
            assert_eq!(v.window.y + v.page.y, 25.0);
            assert_eq!(v.window.y + v.page.y + v.page.height, 975.0);
        }
    }

    #[test]
    fn the_window_is_a_full_width_lane_of_the_height_asked_for() {
        let ask = HitRect { x: 0.0, y: 700.0, width: 1440.0, height: 100.0 };
        let frame = window_frame(Some(&ask), &work(), false);
        // Physical pixels on screen: the work area's top (50) plus 700 CSS px at 2x.
        assert_eq!(frame, Area { x: 0, y: 50 + 1400, width: 2880, height: 200, scale: 2.0 });
        assert!(u64::from(frame.width) * u64::from(frame.height) < u64::from(work().width) * u64::from(work().height) / 4);
    }

    #[test]
    fn the_window_never_leaves_the_work_area() {
        let w = work();
        // Reaching past every edge is cut to the edges.
        let past = HitRect { x: -50.0, y: -30.0, width: 5000.0, height: 5000.0 };
        assert_eq!(window_frame(Some(&past), &w, false), w);
        let below = HitRect { x: 100.0, y: 760.0, width: 300.0, height: 200.0 };
        let frame = window_frame(Some(&below), &w, false);
        assert_eq!((frame.y + frame.height as i32), w.y + w.height as i32, "ends at the bottom edge");
        assert_eq!(frame.x, 200);
        // Nowhere near it: a window of at least the least size, inside.
        let off = HitRect { x: 9000.0, y: 9000.0, width: 10.0, height: 10.0 };
        let frame = window_frame(Some(&off), &w, false);
        assert!(frame.width >= MIN_FRAME && frame.height >= MIN_FRAME);
        assert!(frame.x + frame.width as i32 <= w.width as i32);
        assert!(frame.y + frame.height as i32 <= w.y + w.height as i32);
    }

    #[test]
    fn a_drag_gives_the_window_the_whole_work_area_and_a_drop_takes_it_back() {
        let ask = HitRect { x: 0.0, y: 700.0, width: 1440.0, height: 100.0 };
        assert_eq!(window_frame(Some(&ask), &work(), true), work());
        assert_ne!(window_frame(Some(&ask), &work(), false), work());
    }

    #[test]
    fn the_window_is_the_whole_work_area_without_a_usable_request() {
        assert_eq!(window_frame(None, &work(), false), work());
        let bad = HitRect { x: f64::NAN, y: 0.0, width: 10.0, height: 10.0 };
        assert_eq!(window_frame(Some(&bad), &work(), false), work());
        let odd_scale = Area { scale: f64::NAN, ..work() };
        assert_eq!(window_frame(None, &odd_scale, false).scale, 1.0);
    }

    #[test]
    fn the_frame_is_rounded_to_whole_physical_pixels() {
        let w = Area { x: 0, y: 0, width: 1500, height: 1000, scale: 1.25 };
        let ask = HitRect { x: 0.0, y: 100.3, width: 1200.0, height: 50.2 };
        let f = window_frame(Some(&ask), &w, false);
        assert_eq!((f.y, f.height), (125, 63));
        assert_eq!((f.x, f.width), (0, 1500));
    }

    #[test]
    fn the_page_is_told_its_frame_in_css_pixels_inside_the_work_area() {
        let w = work();
        let ask = HitRect { x: 0.0, y: 700.0, width: 1440.0, height: 100.0 };
        let frame = window_frame(Some(&ask), &w, false);
        assert_eq!(page_frame(&frame, &w), PageFrame { x: 0.0, y: 700.0, width: 1440.0, height: 100.0 });
        assert_eq!(page_size(&w), PageSize { width: 1440.0, height: 800.0 });
        assert_eq!(page_frame(&w, &w), PageFrame { x: 0.0, y: 0.0, width: 1440.0, height: 800.0 });
    }

    // Hit areas, the pointer and the ledges stay in the work area's pixels
    // whatever the window's frame is: a point read in the window's own pixels
    // and moved by the window's offset is the same point.
    #[test]
    fn the_pointer_means_the_same_point_in_the_window_and_in_the_work_area() {
        let w = work();
        let ask = HitRect { x: 0.0, y: 700.0, width: 1440.0, height: 100.0 };
        let window = window_frame(Some(&ask), &w, false);
        let frame = page_frame(&window, &w);
        for (x, y) in [(300.0, 1500.0), (2000.0, 1600.0), (5.0, 1450.0)] {
            let (ax, ay) = local_point(&w, x, y);
            let (wx, wy) = local_point(&window, x, y);
            assert_eq!((wx + frame.x, wy + frame.y), (ax, ay), "at {x},{y}");
        }
    }

    #[test]
    fn other_windows_are_placed_in_the_work_area_not_in_the_window() {
        let w = work();
        let screen = ScreenWindow { id: 5, x: 400.0, y: 650.0, width: 800.0, height: 400.0 };
        let in_area = page_windows(&[screen], &w);
        assert_eq!(in_area, [PageWindow { id: 5, x: 200.0, y: 300.0, width: 400.0, height: 200.0 }]);
        // A window above the lane is still a ledge: the lane does not hide it.
        assert_eq!(in_area[0].y, 300.0);
    }

    #[test]
    fn the_window_starts_as_a_lane_around_where_the_pet_was_dropped() {
        let w = work();
        // Default: standing on the bottom edge, medium size.
        let ask = initial_request(None, PetSize::Medium, &w);
        assert_eq!(ask, HitRect { x: 0.0, y: 800.0 - 12.0 - 48.0 - 56.0 + 12.0, width: 1440.0, height: 48.0 + 56.0 });
        let frame = window_frame(Some(&ask), &w, false);
        assert_eq!(frame.y + frame.height as i32, w.y + w.height as i32, "reaches the bottom");
        // Dropped higher up, large: the lane follows, and is taller.
        let high = PetPosition { display: String::new(), x: 0.5, y: 0.5 };
        let ask = initial_request(Some(&high), PetSize::Large, &w);
        assert_eq!(ask.y, (400.0_f64 - 48.0 * 1.4 - 56.0).round());
        assert_eq!(ask.y + ask.height, 412.0);
        // Near the top it stops at the top.
        let top = PetPosition { display: String::new(), x: 0.5, y: 0.0 };
        let ask = initial_request(Some(&top), PetSize::Medium, &w);
        assert_eq!(ask.y, 0.0);
        assert!(ask.height >= 12.0);
        assert_eq!(size_scale(PetSize::Small), 0.75);
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
    fn the_pointer_is_polled_often_only_near_the_pet_or_while_dragging() {
        let hits = [HitRect { x: 1000.0, y: 300.0, width: 64.0, height: 48.0 }];
        assert!(near_hits(&hits, false, Some((1100.0, 200.0))), "just above and beside it");
        assert!(!near_hits(&hits, false, Some((100.0, 320.0))), "far to the left");
        assert!(!near_hits(&hits, false, Some((1020.0, 900.0))), "far below");
        assert!(!near_hits(&[], false, Some((0.0, 0.0))), "nothing to click");
        assert!(near_hits(&hits, true, None), "dragging");
    }

    #[test]
    fn the_page_hears_of_the_pointer_only_near_the_pet_itself() {
        let pet = HitRect { x: 1000.0, y: 300.0, width: 64.0, height: 48.0 };
        let bubble = HitRect { x: 100.0, y: 40.0, width: 290.0, height: 140.0 };
        assert_eq!(pointer_near_pet(&[pet, bubble], Some((1100.0, 250.0))), Some((1100.0, 250.0)));
        assert_eq!(pointer_near_pet(&[pet, bubble], Some((150.0, 60.0))), None, "near the bubble only");
        assert_eq!(pointer_near_pet(&[pet], Some((1020.0, 900.0))), None, "far below");
        assert_eq!(pointer_near_pet(&[], Some((0.0, 0.0))), None, "no pet drawn");
        assert_eq!(pointer_near_pet(&[pet], None), None, "pointer unknown");
    }

    #[test]
    fn other_windows_reach_the_page_in_its_css_pixels_front_first() {
        let strip = Area { x: 0, y: 50, width: 2000, height: 1000, scale: 2.0 };
        let front = ScreenWindow { id: 7, x: 200.0, y: 450.0, width: 800.0, height: 400.0 };
        let behind = ScreenWindow { id: 3, x: 1000.0, y: 250.0, width: 900.0, height: 700.0 };
        assert_eq!(
            page_windows(&[front, behind], &strip),
            [PageWindow { id: 7, x: 100.0, y: 200.0, width: 400.0, height: 200.0 }, PageWindow { id: 3, x: 500.0, y: 100.0, width: 450.0, height: 350.0 }],
        );
    }

    #[test]
    fn tiny_and_off_screen_windows_are_left_out() {
        let strip = Area { x: 0, y: 0, width: 1000, height: 800, scale: 1.0 };
        let tiny = ScreenWindow { id: 1, x: 10.0, y: 10.0, width: 40.0, height: 20.0 };
        let elsewhere = ScreenWindow { id: 2, x: 3000.0, y: 100.0, width: 600.0, height: 400.0 };
        let partly = ScreenWindow { id: 3, x: 800.0, y: 100.0, width: 600.0, height: 400.0 };
        let broken = ScreenWindow { id: 4, x: f64::NAN, y: 0.0, width: 600.0, height: 400.0 };
        let ids: Vec<u64> = page_windows(&[tiny, elsewhere, partly, broken], &strip).iter().map(|w| w.id).collect();
        assert_eq!(ids, [3]);
    }

    #[test]
    fn it_climbs_on_windows_by_default_but_only_when_playful_or_chaotic() {
        assert!(PetSettings::default().climb);
        let climber = |movement| PetSettings { movement, ..on() };
        assert!(climbs(&climber(PetMovement::Playful)));
        assert!(climbs(&climber(PetMovement::Chaotic)));
        assert!(!climbs(&climber(PetMovement::Calm)));
        assert!(!climbs(&climber(PetMovement::Still)));
        assert!(!climbs(&PetSettings { climb: false, ..climber(PetMovement::Chaotic) }));
        let old: PetSettings = serde_json::from_str(r#"{"enabled": true}"#).unwrap();
        assert!(old.climb, "settings saved before it could climb");
    }

    #[test]
    fn ladders_and_balloons_are_on_for_old_settings_and_follow_the_patch() {
        assert!(PetSettings::default().toys);
        // A file written before the setting existed has no `toys` key.
        let old: PetSettings = serde_json::from_str(r#"{"enabled": true, "climb": false, "movement": "playful"}"#).unwrap();
        assert!(old.toys, "settings saved before ladders and balloons");
        assert!(!old.climb, "the other options are kept");
        // It round-trips.
        let saved: PetSettings = serde_json::from_str(&serde_json::to_string(&PetSettings { toys: false, ..on() }).unwrap()).unwrap();
        assert!(!saved.toys);
        // A patch from Settings turns it off and on, and leaves it alone when absent.
        let patch: PetSettingsPatch = serde_json::from_str(r#"{"toys": false}"#).unwrap();
        let off = old.clone().with(patch);
        assert!(!off.toys);
        assert_eq!(off.movement, PetMovement::Playful);
        let other: PetSettingsPatch = serde_json::from_str(r#"{"colour": "blue"}"#).unwrap();
        assert!(!off.clone().with(other).toys, "absent: unchanged");
        let back: PetSettingsPatch = serde_json::from_str(r#"{"toys": true}"#).unwrap();
        assert!(off.with(back).toys);
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
    fn a_drop_is_kept_as_a_fraction_of_the_height_and_defaults_to_the_bottom() {
        assert_eq!(height_fraction(450.0, 900.0), 0.5);
        assert_eq!(height_fraction(-20.0, 900.0), 0.0);
        assert_eq!(height_fraction(5000.0, 900.0), 1.0);
        assert_eq!(height_fraction(f64::NAN, 900.0), 1.0);
        assert_eq!(height_fraction(10.0, 0.0), 1.0);
    }

    #[test]
    fn a_position_saved_before_the_pet_could_move_up_stays_on_the_bottom() {
        let old: PetPosition = serde_json::from_str(r#"{"display":"LG","x":0.4}"#).unwrap();
        assert_eq!(old, PetPosition { display: "LG".into(), x: 0.4, y: 1.0 });
        let placed: PetPosition = serde_json::from_str(r#"{"display":"LG","x":0.4,"y":0.25}"#).unwrap();
        assert_eq!(placed.y, 0.25);
    }

    #[test]
    fn it_keeps_clear_of_a_dock_or_taskbar_that_hides_itself() {
        // 1680 x 1050 pt at 2x, menu bar 30 pt, Dock hidden: the work area
        // reaches the bottom of the display.
        let work = Area { x: 0, y: 60, width: 3360, height: 2040, scale: 2.0 };
        let raised = leave_room_for_hidden_bar(work, 2100, Some(53.0));
        assert_eq!(raised, Area { height: 2040 - 106, ..work });
        assert_eq!(pet_frame(raised).y + pet_frame(raised).height as i32, 2100 - 106, "the window ends above the Dock");
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
        let placed = PetSettings { position: Some(PetPosition { display: "LG".into(), x: 0.5, y: 0.4 }), ..on() };
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
            ["core:event:default", "allow-pet-state", "allow-pet-fit", "allow-pet-open", "allow-pet-dismiss", "allow-pet-drag-end", "allow-pet-menu"],
        );
    }

    #[test]
    fn dismissing_bubbles_reads_their_sessions_once_each() {
        let route = |n: &str, s: &str| Route { notification_id: n.into(), session_id: s.into(), server: ServerId::Bundled, kind: "assistant_done".into() };
        let routes: VecDeque<Route> = [route("n1", "aa-bb"), route("n2", "AABB"), route("n3", "cc")].into_iter().collect();
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(dismissed_sessions(&routes, &ids(&["n1", "n2", "n3", "unknown"])), ["aa-bb", "cc"]);
        assert!(dismissed_sessions(&routes, &ids(&["reminder-without-session"])).is_empty());
    }

    // The pet's × used to read the session of a question away, and with it
    // the pet's only way back to the question.
    #[test]
    fn later_on_a_question_never_reads_its_session() {
        let route = |n: &str, s: &str, kind: &str| Route { notification_id: n.into(), session_id: s.into(), server: ServerId::Bundled, kind: kind.into() };
        let routes: VecDeque<Route> = [route("q1", "aa", "input_needed"), route("d1", "bb", "assistant_done")].into_iter().collect();
        let ids = ["q1".to_string(), "d1".to_string()];
        assert_eq!(dismissed_sessions(&routes, &ids), ["bb"]);
    }

    #[test]
    fn a_question_bubble_carries_the_id_the_server_holds() {
        let body = serde_json::json!({ "question": { "id": "q-1", "questions": [{ "question": "Use which account?", "options": [{ "label": "Work" }, { "label": "Auto" }] }] } });
        let question = crate::answers::parse_question(&body).unwrap();
        let bubble = bubble_from_request("input_needed", Some("n1"), Some("s1"), "Needs you · api", "Use which account?");
        let asked = with_open_question(bubble, &question);
        assert_eq!(asked.question_id.as_deref(), Some("q-1"));
        assert_eq!(asked.body, "Use which account?");

        // An empty notification body takes the question's own text.
        let silent = with_open_question(bubble_from_request("input_needed", Some("n2"), Some("s1"), "Needs you", ""), &question);
        assert_eq!(silent.body, "Use which account?");

        let json = serde_json::to_value(&asked).unwrap();
        assert_eq!(json["questionId"], "q-1");
        assert!(json.get("choices").is_none(), "the pet answers nothing in place");
    }

    #[test]
    fn menu_ids_round_trip_and_ignore_other_items() {
        for action in [
            PetMenuAction::Open("n-1"),
            PetMenuAction::Clear,
            PetMenuAction::Movement(PetMovement::Still),
            PetMenuAction::Movement(PetMovement::Calm),
            PetMenuAction::Movement(PetMovement::Playful),
            PetMenuAction::Movement(PetMovement::Chaotic),
            PetMenuAction::Character(PetCharacter::Cat),
            PetMenuAction::Character(PetCharacter::Duck),
            PetMenuAction::Character(PetCharacter::Crab),
        ] {
            assert_eq!(parse_menu_id(&menu_id(action)), Some(action));
        }
        assert_eq!(parse_menu_id("pet:open:a:b"), Some(PetMenuAction::Open("a:b")), "ids may hold colons");
        for other in ["pet:open:", "pet:movement:fast", "pet:movement", "pet:character:dog", "pet:character", "show", "toggle_pet", "island:open:s1", ""] {
            assert_eq!(parse_menu_id(other), None, "{other}");
        }
    }

    #[test]
    fn a_character_is_saved_by_name_and_the_cat_stays_the_default() {
        assert_eq!(PetSettings::default().character, PetCharacter::Cat);
        let duck: PetSettings = serde_json::from_str(r#"{"enabled": true, "character": "duck"}"#).unwrap();
        assert_eq!(duck.character, PetCharacter::Duck);
        assert_eq!(serde_json::to_value(PetCharacter::Crab).unwrap(), "crab");
    }

    #[test]
    fn the_menu_lists_the_newest_unread_with_short_titles() {
        let unread: Vec<MenuUnread> = (0..8).map(|i| MenuUnread { id: format!("n{i}"), title: format!("Done · web {i}") }).collect();
        let rows = unread_rows(&unread, |id| id != "n1");
        assert_eq!(rows.len(), 6, "capped");
        assert_eq!(rows[0], ("n0".into(), "Done · web 0".into(), true));
        assert!(!rows[1].2, "a reminder with no session cannot be opened");

        let long = [MenuUnread { id: "x".into(), title: "a".repeat(80) }, MenuUnread { id: "y".into(), title: "  ".into() }];
        let rows = unread_rows(&long, |_| true);
        assert_eq!(rows[0].1.chars().count(), 48);
        assert!(rows[0].1.ends_with('…'));
        assert_eq!(rows[1].1, "Notification");
    }
}
