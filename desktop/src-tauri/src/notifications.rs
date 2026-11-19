//! OS notifications for finished turns and questions: one request per
//! notification id, the pet's bubble instead of a banner when it is on
//! screen, a question's options as buttons, and a click routed to the
//! session's window.
//!
//! A session has one notification at a time: a newer one takes the place of
//! the earlier, and reading the session anywhere in the app takes its
//! notification down ([`session_read`]). macOS and Linux; a Windows toast
//! cannot be withdrawn yet (the toast library gives no handle on one).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::servers::ServerId;
use crate::window::show_main_window;

#[cfg(target_os = "macos")]
fn notification_application_identifier(dev: bool, identifier: &str) -> &str {
    if dev {
        // Development builds are not bundled applications, so macOS only
        // delivers their notifications when attributed to Terminal.
        "com.apple.Terminal"
    } else {
        identifier
    }
}

/// Register the notification-delivering application exactly once.
///
/// `mac_notification_sys::set_application` is itself guarded by a
/// `call_once`, so every call after the first returns `AlreadySet` — a
/// single production log carried 65 of those warnings. Match its one-shot
/// semantics rather than retrying (and warning) per notification.
#[cfg(target_os = "macos")]
fn ensure_notification_application(app: &AppHandle) {
    static REGISTERED: std::sync::Once = std::sync::Once::new();
    REGISTERED.call_once(|| {
        let identifier =
            notification_application_identifier(tauri::is_dev(), &app.config().identifier);
        if let Err(error) = notify_rust::set_application(identifier) {
            log::warn!("desktop_notification_application_failed error={error:#}");
        }
    });
}

/// Ceiling on notification threads parked waiting for user interaction.
///
/// On macOS `Notification::show()` only wraps the notification in a handle
/// — delivery happens inside `wait_for_action`, which blocks its thread
/// until the user acts (notify-rust maps our single action to a
/// `MainButton`, which sets mac-notification-sys' `should_wait`). macOS
/// keeps unacted notifications in Notification Center indefinitely, so an
/// ignored notification parks its thread for the life of the process.
const MAX_PENDING_NOTIFICATIONS: usize = 8;

static PENDING_NOTIFICATIONS: AtomicUsize = AtomicUsize::new(0);

/// Reserve a slot for a notification that waits on user interaction.
/// Returns false once `MAX_PENDING_NOTIFICATIONS` are already parked.
#[allow(deprecated)] // `try_update`, its new name, needs Rust 1.95, above our rust-version.
fn claim_notification_slot() -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    let claim = |pending| (pending < MAX_PENDING_NOTIFICATIONS).then_some(pending + 1);
    PENDING_NOTIFICATIONS.fetch_update(SeqCst, SeqCst, claim).is_ok()
}

/// Notification ids already shown, newest last.
const MAX_SEEN_NOTIFICATIONS: usize = 64;
static SEEN_NOTIFICATIONS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Record `id`; false when it was already shown. Every app window receives
/// the same backend event and asks for the same notification.
fn first_notification_request(id: &str) -> bool {
    let mut seen = SEEN_NOTIFICATIONS.lock().unwrap_or_else(|e| e.into_inner());
    if seen.iter().any(|s| s == id) {
        return false;
    }
    if seen.len() == MAX_SEEN_NOTIFICATIONS {
        seen.pop_front();
    }
    seen.push_back(id.to_string());
    true
}

/// `id` could not be shown after all: let a later request (another window,
/// or the event replayed after a reconnect) show it.
fn forget_notification_request(id: &str) {
    let mut seen = SEEN_NOTIFICATIONS.lock().unwrap_or_else(|e| e.into_inner());
    seen.retain(|s| s != id);
}

// ── One notification per session ────────────────────────────────────────

/// Sessions the board remembers a notification for. One that is never read
/// or replaced (its buttons were dropped past [`MAX_PENDING_NOTIFICATIONS`],
/// so nothing reports it gone) would stay for the life of the process.
const MAX_POSTED: usize = 64;

/// The notification each session has on screen. `T` is what takes one down.
struct Board<T> {
    last: u64,
    posted: HashMap<String, (u64, T)>,
}

impl<T> Default for Board<T> {
    fn default() -> Self {
        Self { last: 0, posted: HashMap::new() }
    }
}

impl<T> Board<T> {
    /// `session` has a notification on screen. Answers its number, for
    /// [`gone`](Self::gone). The caller has taken the earlier one down.
    fn post(&mut self, session: &str, takedown: T) -> u64 {
        if self.posted.len() >= MAX_POSTED && !self.posted.contains_key(session) {
            let oldest = self.posted.iter().min_by_key(|(_, (number, _))| *number).map(|(session, _)| session.clone());
            if let Some(oldest) = oldest {
                self.posted.remove(&oldest);
            }
        }
        self.last += 1;
        self.posted.insert(session.to_string(), (self.last, takedown));
        self.last
    }

    /// The session's notification, for the caller to take down: the session
    /// was read, or a newer notification is about to take its place.
    fn take(&mut self, session: &str) -> Option<T> {
        self.posted.remove(session).map(|(_, takedown)| takedown)
    }

    /// Notification `number` left the screen by itself (clicked, closed).
    /// A newer one for the session stays.
    fn gone(&mut self, session: &str, number: u64) {
        if self.posted.get(session).is_some_and(|(posted, _)| *posted == number) {
            self.posted.remove(session);
        }
    }
}

/// The handle a shown notification is waited on through. On Linux it is
/// shared, so [`take_down`] can close the notification while its thread
/// waits for a click.
#[cfg(all(unix, not(target_os = "macos")))]
type Shown = std::sync::Arc<notify_rust::NotificationHandle>;
#[cfg(not(all(unix, not(target_os = "macos"))))]
type Shown = notify_rust::NotificationHandle;

/// What takes a notification down again. macOS: its title and body, since
/// `NSUserNotificationCenter` hands back no id for one. Linux: its handle.
/// Windows: nothing.
#[cfg(target_os = "macos")]
type Takedown = (String, String);
#[cfg(all(unix, not(target_os = "macos")))]
type Takedown = Shown;
#[cfg(target_os = "windows")]
type Takedown = ();

fn board() -> std::sync::MutexGuard<'static, Board<Takedown>> {
    static BOARD: std::sync::OnceLock<Mutex<Board<Takedown>>> = std::sync::OnceLock::new();
    BOARD.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(target_os = "macos")]
fn shown(handle: notify_rust::NotificationHandle, title: &str, body: &str) -> (Shown, Takedown) {
    (handle, (title.to_string(), body.to_string()))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn shown(handle: notify_rust::NotificationHandle, _title: &str, _body: &str) -> (Shown, Takedown) {
    let handle = std::sync::Arc::new(handle);
    (handle.clone(), handle)
}

#[cfg(target_os = "windows")]
fn shown(handle: notify_rust::NotificationHandle, _title: &str, _body: &str) -> (Shown, Takedown) {
    (handle, ())
}

/// Block until the person acts on the notification or it leaves the screen,
/// then call `on_action` with the action's id (`default`: a click on it;
/// `__closed`: it went away).
#[cfg(not(all(unix, not(target_os = "macos"))))]
fn wait_for_action(shown: Shown, on_action: impl FnOnce(&str)) {
    shown.wait_for_action(on_action);
}

#[cfg(all(unix, not(target_os = "macos")))]
fn wait_for_action(shown: Shown, on_action: impl FnOnce(&str)) {
    use notify_rust::NotificationResponse;
    // The waiting call that borrows the handle: the blocking one takes it,
    // and nothing could close the notification meanwhile.
    tauri::async_runtime::block_on(shown.wait_for_action_async(|response: &NotificationResponse| match response {
        NotificationResponse::Default => on_action("default"),
        NotificationResponse::Action(action) => on_action(action),
        _ => on_action("__closed"),
    }));
}

/// Take a notification off the screen and out of Notification Center. Its
/// waiting thread then ends by itself: the notification service reports it
/// closed (Linux), or mac-notification-sys sees it gone at its next
/// half-second check. Call it off the main thread and off the async runtime.
#[cfg(target_os = "macos")]
fn take_down((title, body): Takedown) {
    crate::notification_center::remove_delivered(&title, &body);
}

#[cfg(all(unix, not(target_os = "macos")))]
fn take_down(handle: Takedown) {
    tauri::async_runtime::block_on(handle.close_async());
}

#[cfg(target_os = "windows")]
fn take_down(_: Takedown) {}

/// `session` (an `island::id_key`) was read somewhere in the app: its
/// notification has nothing left to say.
pub fn session_read(session: &str) {
    let Some(takedown) = board().take(session) else {
        return;
    };
    // Off the caller's thread, which may be the main one: taking it down
    // asks the notification service and waits for the answer.
    std::thread::spawn(move || take_down(takedown));
}

/// Whether an app window other than `caller`, on the same server, has
/// focus. The user is then looking at the app, and that window got the same
/// event and decides for itself whether to notify (it knows which session is
/// on screen). A focused window on another server never sees the event.
fn another_app_window_focused(app: &AppHandle, caller: &str) -> bool {
    let focused = crate::servers::focused_app_window(app);
    crate::servers::focused_window_covers(caller, focused.as_deref(), &crate::servers::external_map(app))
}

/// How long a question's notification waits for the server to say what its
/// options are; past it the notification shows with "Open to answer" alone.
const QUESTION_WAIT: Duration = Duration::from_secs(3);

/// A notification's buttons, in order, as (id, label): one per option of a
/// question that can be answered in place, and the way into the app. A click
/// on the notification itself is `default`, the same as that one.
///
/// With `open_first` the way into the app leads. macOS folds several actions
/// into one "Options" dropdown, and notify-rust answers a click on the
/// dropdown's face with the *first* action: that must open the app, never
/// answer a question by accident. Elsewhere the options lead.
fn notification_actions(choices: &[String], asks: bool, open_first: bool) -> Vec<(String, String)> {
    let mut actions: Vec<(String, String)> = choices
        .iter()
        .take(crate::answers::MAX_QUICK_CHOICES)
        .enumerate()
        .map(|(index, choice)| (format!("answer:{index}"), choice.clone()))
        .collect();
    let open = ("default".to_string(), if asks { "Open to answer" } else { "Open" }.to_string());
    if open_first {
        actions.insert(0, open);
    } else {
        actions.push(open);
    }
    actions
}

/// The option an action id picks (`answer:<index>`), if it is one.
fn picked_choice<'a>(action: &str, choices: &'a [String]) -> Option<&'a str> {
    let index: usize = action.strip_prefix("answer:")?.parse().ok()?;
    choices.get(index).map(String::as_str)
}

/// The question a notification is about, from the server, when it is one.
/// Runs on the notification's own thread, never the async runtime's.
fn open_question(app: &AppHandle, server: &ServerId, payload: &DesktopNotificationPayload) -> Option<crate::answers::OpenQuestion> {
    if payload.kind != "input_needed" {
        return None;
    }
    let session_id = payload.session_id.as_deref()?;
    match wait_on_thread(QUESTION_WAIT, crate::answers::fetch_question(app, server, session_id)) {
        Some(Ok(question)) => question,
        Some(Err(error)) => {
            log::debug!("desktop_notification_question_unavailable error={error:#}");
            None
        }
        None => None,
    }
}

/// Run `work` to completion from a plain thread, giving up after `wait`.
/// The timeout is made inside the future `block_on` drives: a Tokio timer
/// needs the runtime when it is created, and a plain thread has none.
fn wait_on_thread<F: std::future::Future>(wait: Duration, work: F) -> Option<F::Output> {
    tauri::async_runtime::block_on(async move { tokio::time::timeout(wait, work).await.ok() })
}

/// A click on a notification: open its session through the shared router
/// (the window that shows it, else the server's). With no session, or if the
/// router fails, bring the asking window (or any) forward.
fn open_from_notification(app: &AppHandle, sender: &str, server: ServerId, session_id: Option<&str>) {
    if let Some(session_id) = session_id {
        let opened = crate::island::open_session(app, server, session_id, crate::island::OpenIn::Existing, false);
        match tauri::async_runtime::block_on(opened) {
            Ok(()) => return,
            Err(error) => log::warn!("desktop_notification_open_failed error={error:#}"),
        }
    }
    match app.get_webview_window(sender) {
        Some(window) => crate::window::show_window(&window),
        None => show_main_window(app),
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPayload {
    kind: String,
    session_id: Option<String>,
    title: String,
    body: String,
    #[serde(default)]
    notification_id: Option<String>,
    /// How the turn ended, as the server's event said it (`done`, `failed`,
    /// `goal_blocked`, …); absent from older pages and servers.
    #[serde(default)]
    outcome: Option<String>,
}

/// Shows the notification and returns true, or returns false when another
/// window already showed it or has the user's focus.
#[tauri::command]
pub fn show_desktop_notification(
    app: AppHandle,
    window: tauri::WebviewWindow,
    payload: DesktopNotificationPayload,
) -> Result<bool, String> {
    if another_app_window_focused(&app, window.label()) {
        return Ok(false);
    }
    if let Some(id) = payload.notification_id.as_deref() {
        if !first_notification_request(id) {
            return Ok(false);
        }
    }
    // The desktop pet is on screen and shows this kind in its bubble
    // instead (its own feed gets the same event; each shows once).
    let bubble = crate::pet::bubble_from_request(
        &payload.kind,
        payload.notification_id.as_deref(),
        payload.session_id.as_deref(),
        &payload.title,
        &payload.body,
        payload.outcome.as_deref(),
    );
    if crate::pet::take_banner(&app, window.label(), bubble) {
        return Ok(false);
    }
    // Past the cap the notification is still delivered, just without its
    // actions — with no actions `needs_response()` is false, so
    // `wait_for_action` sends and returns instead of parking the thread.
    // Losing click-routing on a backlogged notification beats leaking an
    // unbounded number of threads.
    let routes_clicks = claim_notification_slot();
    // The asking window is on the session's server, which the focused window
    // may not be: that is where the session, and its question, live.
    let sender = window.label().to_string();
    let server = crate::servers::window_server(&sender, &crate::servers::external_map(&app));
    // The OS notification alone says which computer: the pet's bubble and
    // the island keep the title as the server sent it.
    let summary = crate::servers::notification_title(&app, &server, &crate::pet::display_title(&payload.kind, &payload.title));
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        ensure_notification_application(&app);
        // A question the shell can answer gets its options as buttons: the
        // notification APIs carry them as actions (XDG actions on Linux, a
        // dropdown beside the macOS banner, buttons on a Windows toast).
        let question = if routes_clicks { open_question(&app, &server, &payload) } else { None };
        let choices = question.as_ref().map(|q| q.quick_choices()).unwrap_or_default();
        let asks = payload.kind == "input_needed" && payload.session_id.is_some();
        // One notification per session: the earlier one goes before this
        // one shows (on macOS they may carry the same words).
        let session = payload.session_id.as_deref().map(crate::island::id_key);
        if let Some(earlier) = session.as_deref().and_then(|session| board().take(session)) {
            take_down(earlier);
        }
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&summary)
            .body(&payload.body);
        if routes_clicks {
            for (id, label) in notification_actions(&choices, asks, cfg!(target_os = "macos")) {
                notification.action(&id, &label);
            }
        }

        match notification.show() {
            Ok(handle) => {
                let (shown, takedown) = shown(handle, &summary, &payload.body);
                let posted = session.as_deref().map(|session| (session, board().post(session, takedown)));
                wait_for_action(shown, |action| {
                    if let (Some(choice), Some(question), Some(session_id)) =
                        (picked_choice(action, &choices), question.as_ref(), payload.session_id.as_deref())
                    {
                        // A button: post the answer. If the server refuses it
                        // (not a "no longer open", which clears the question
                        // everywhere), open the session to answer it there.
                        let answers = vec![vec![choice.to_string()]];
                        let sent = crate::island::answer_question(&app, &server, session_id, &question.id, &answers);
                        if let Err(error) = tauri::async_runtime::block_on(sent) {
                            log::warn!("desktop_notification_answer_failed error={error:#}");
                            open_from_notification(&app, &sender, server, Some(session_id));
                        }
                        return;
                    }
                    if action != "default" {
                        return;
                    }
                    open_from_notification(&app, &sender, server, payload.session_id.as_deref());
                });
                // The wait saw it leave the screen. Without buttons macOS
                // does not wait: it stays up until its session is read.
                if let (Some((session, number)), true) = (posted, routes_clicks) {
                    board().gone(session, number);
                }
            }
            Err(error) => {
                log::warn!("desktop_notification_failed error={error:#}");
                if let Some(id) = payload.notification_id.as_deref() {
                    forget_notification_request(id);
                }
            }
        }
        if routes_clicks {
            PENDING_NOTIFICATIONS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    // ── wait_on_thread ──────────────────────────────────────────────────
    //
    // A notification asks the server for its question from its own std
    // thread, outside any Tokio context. A question notification panicked
    // there ("there is no reactor running") and never showed.

    #[test]
    fn a_timed_wait_runs_from_a_plain_thread() {
        let got = std::thread::spawn(|| wait_on_thread(Duration::from_secs(5), async { 7 }))
            .join()
            .expect("the wait must not panic outside the async runtime");
        assert_eq!(got, Some(7));
    }

    #[test]
    fn a_timed_wait_gives_up_after_its_limit() {
        let got = std::thread::spawn(|| wait_on_thread(Duration::from_millis(20), std::future::pending::<()>()))
            .join()
            .expect("the wait must not panic outside the async runtime");
        assert_eq!(got, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dev_notifications_use_terminal_as_the_registered_application() {
        assert_eq!(
            notification_application_identifier(true, "com.openagentd.desktop.dev"),
            "com.apple.Terminal"
        );
        assert_eq!(
            notification_application_identifier(false, "com.openagentd.desktop"),
            "com.openagentd.desktop"
        );
    }

    // ── claim_notification_slot ─────────────────────────────────────────
    //
    // `wait_for_action` parks its thread until the user acts, and macOS
    // keeps unacted notifications in Notification Center indefinitely, so
    // the number of threads that can be parked has to be bounded.

    #[test]
    fn notification_slots_are_capped_and_released() {
        for slot in 0..MAX_PENDING_NOTIFICATIONS {
            assert!(claim_notification_slot(), "slot {slot} should be free");
        }

        // Over the cap: the notification is still delivered, just without
        // the action that would park another thread.
        assert!(!claim_notification_slot());

        // A thread finishing frees exactly one slot.
        PENDING_NOTIFICATIONS.fetch_sub(1, Ordering::SeqCst);
        assert!(claim_notification_slot());
        assert!(!claim_notification_slot());

        PENDING_NOTIFICATIONS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn each_notification_id_is_shown_once() {
        assert!(first_notification_request("dedupe-a"));
        assert!(!first_notification_request("dedupe-a"), "a second window asks for the same id");
        assert!(first_notification_request("dedupe-b"));

        // The oldest id is forgotten once the list is full.
        for n in 0..MAX_SEEN_NOTIFICATIONS {
            assert!(first_notification_request(&format!("dedupe-fill-{n}")));
        }
        assert!(first_notification_request("dedupe-a"));
    }

    #[test]
    fn a_notification_that_failed_to_show_can_be_shown_later() {
        assert!(first_notification_request("failed-show"));
        forget_notification_request("failed-show");
        assert!(first_notification_request("failed-show"), "another window, or a replay, shows it");
        assert!(!first_notification_request("failed-show"));
    }

    fn labels(actions: &[(String, String)]) -> Vec<&str> {
        actions.iter().map(|(_, label)| label.as_str()).collect()
    }

    #[test]
    fn a_notification_keeps_its_single_open_button_unless_it_asks_something() {
        let plain = notification_actions(&[], false, false);
        assert_eq!(plain, [("default".to_string(), "Open".to_string())]);
        // A question that can't be answered here still says what opening does.
        assert_eq!(labels(&notification_actions(&[], true, false)), ["Open to answer"]);
    }

    #[test]
    fn a_question_gets_one_button_per_option_and_a_way_into_the_app() {
        let choices = vec!["Wait for Work".to_string(), "Use Auto".to_string()];
        let actions = notification_actions(&choices, true, false);
        assert_eq!(labels(&actions), ["Wait for Work", "Use Auto", "Open to answer"]);
        assert_eq!(actions.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["answer:0", "answer:1", "default"]);

        // Windows toasts take five buttons; four options and Open fit.
        let many: Vec<String> = (0..9).map(|i| format!("Option {i}")).collect();
        assert_eq!(notification_actions(&many, true, false).len(), crate::answers::MAX_QUICK_CHOICES + 1);
    }

    // notify-rust turns a click on macOS's "Options" button itself into the
    // first action: that must not be an answer.
    #[test]
    fn on_macos_the_way_into_the_app_leads_so_a_stray_click_never_answers() {
        let choices = vec!["Wait for Work".to_string(), "Use Auto".to_string()];
        let actions = notification_actions(&choices, true, true);
        assert_eq!(actions[0].0, "default");
        assert_eq!(labels(&actions), ["Open to answer", "Wait for Work", "Use Auto"]);
    }

    #[test]
    fn a_clicked_action_picks_its_option_and_nothing_else_does() {
        let choices = vec!["Wait for Work".to_string(), "Use Auto".to_string()];
        assert_eq!(picked_choice("answer:1", &choices), Some("Use Auto"));
        for other in ["default", "__closed", "answer:2", "answer:x", "answer:", "Use Auto"] {
            assert_eq!(picked_choice(other, &choices), None, "{other}");
        }
    }

    // ── One notification per session ────────────────────────────────────

    #[test]
    fn a_newer_notification_takes_the_place_of_the_sessions_earlier_one() {
        let mut board = Board::default();
        board.post("a", "needs you");
        // The caller takes the earlier one down before it shows the next.
        assert_eq!(board.take("a"), Some("needs you"));
        board.post("a", "done");
        assert_eq!(board.take("a"), Some("done"));
        assert_eq!(board.take("a"), None);
    }

    #[test]
    fn reading_a_session_takes_down_its_notification_and_no_other() {
        let mut board = Board::default();
        board.post("a", "for a");
        board.post("b", "for b");
        assert_eq!(board.take("a"), Some("for a"));
        assert_eq!(board.take("a"), None, "read twice: nothing left to take down");
        assert_eq!(board.take("never-notified"), None);
        assert_eq!(board.take("b"), Some("for b"));
    }

    #[test]
    fn a_notification_that_left_by_itself_is_forgotten_but_not_its_successor() {
        let mut board = Board::default();
        let first = board.post("a", "first");
        board.gone("a", first);
        assert_eq!(board.take("a"), None, "clicked or closed: nothing to take down");

        // The earlier one's wait ends after the newer one was posted.
        let earlier = board.post("a", "earlier");
        board.take("a");
        board.post("a", "newer");
        board.gone("a", earlier);
        assert_eq!(board.take("a"), Some("newer"));
    }

    #[test]
    fn the_board_forgets_its_oldest_notification_when_full() {
        let mut board = Board::default();
        for n in 0..=MAX_POSTED {
            board.post(&format!("s{n}"), n);
        }
        assert_eq!(board.take("s0"), None);
        assert_eq!(board.take("s1"), Some(1));
        assert_eq!(board.take(&format!("s{MAX_POSTED}")), Some(MAX_POSTED));
    }

    // The only check of the Linux half that runs it: a session bus with a
    // notification service (dunst under Xvfb does), then
    // `cargo test -- --ignored closing_a_notification`.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    #[ignore = "needs a session bus with a notification service"]
    fn closing_a_notification_ends_the_wait_for_its_click() {
        let mut notification = notify_rust::Notification::new();
        notification.summary("OpenAgentd test").body("Closed again by the test that posted it.").action("default", "Open");
        let (waited_on, takedown) = shown(notification.show().expect("a notification service"), "", "");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            wait_for_action(waited_on, |action| {
                let _ = tx.send(action.to_string());
            })
        });
        assert!(rx.recv_timeout(Duration::from_millis(700)).is_err(), "it waits while the notification is up");
        take_down(takedown);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).as_deref(), Ok("__closed"));
    }
}
