//! Bundled-backend crash watcher. Notices a sidecar that exited on its own
//! (panic, OOM kill, crash) while the app runs, restarts it with the same
//! desktop token, and points the windows on the bundled backend at the new
//! port. Deliberate stops (quit, reload, "stop bundled backend") take the
//! sidecar out of `AppState` first, so the watcher never sees them.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::menu::update_tray_status;
use crate::window::frontend_init_script;
use crate::{AppState, BackendError, BackendReady};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Restarts counted against the budget within this sliding window.
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Back-off before each automatic restart inside the window.
const RESTART_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(15),
];

/// Automatic restarts left in the sliding window. A backend that keeps
/// dying stops being restarted and the user gets the recovery screen.
#[derive(Default)]
pub struct RestartBudget {
    recent: VecDeque<Instant>,
}

impl RestartBudget {
    /// Delay before the next automatic restart; `None` once the budget is spent.
    pub fn next_delay(&mut self, now: Instant) -> Option<Duration> {
        while self
            .recent
            .front()
            .is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW)
        {
            self.recent.pop_front();
        }
        let delay = RESTART_DELAYS.get(self.recent.len()).copied()?;
        self.recent.push_back(now);
        Some(delay)
    }
}

pub async fn run(app: AppHandle) {
    let mut budget = RestartBudget::default();
    let mut tick = tokio::time::interval(POLL_INTERVAL);
    loop {
        tick.tick().await;
        let Some(status) = take_exited_sidecar(&app).await else {
            continue;
        };
        log::error!("bundled backend exited unexpectedly: {status}");
        update_tray_status(&app, "Status: Restarting…");
        let mut recovered = false;
        while let Some(delay) = budget.next_delay(Instant::now()) {
            tokio::time::sleep(delay).await;
            if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                return;
            }
            match crate::commands::start_bundled_sidecar(&app).await {
                Ok(ready) => {
                    log::info!("bundled backend restarted on port {}", ready.port);
                    notify_bundled_windows(&app, ready);
                    recovered = true;
                    break;
                }
                Err(e) => log::warn!("bundled backend restart failed: {e}"),
            }
        }
        if !recovered {
            let state = app.state::<AppState>();
            state.backend_failed.store(true, Ordering::SeqCst);
            update_tray_status(&app, "Status: Error");
            let external = state.window_backend_base_urls.lock().unwrap().clone();
            app.emit_filter(
                "backend-error",
                BackendError {
                    message: format!("The local backend stopped unexpectedly ({status})."),
                },
                |target| !target_label(target).is_some_and(|l| external.contains_key(l)),
            )
            .ok();
        }
    }
}

/// Take the sidecar out of `AppState` if it exited while nothing was
/// stopping or starting it.
async fn take_exited_sidecar(app: &AppHandle) -> Option<std::process::ExitStatus> {
    let state = app.state::<AppState>();
    if state.quitting.load(Ordering::SeqCst)
        || state.force_reloading.load(Ordering::SeqCst)
        || state.backend_starting.load(Ordering::SeqCst)
    {
        return None;
    }
    let mut guard = state.sidecar.lock().await;
    let status = guard.as_mut()?.exit_status()?;
    guard.take();
    Some(status)
}

fn target_label(target: &tauri::EventTarget) -> Option<&str> {
    match target {
        tauri::EventTarget::WebviewWindow { label }
        | tauri::EventTarget::Window { label }
        | tauri::EventTarget::Webview { label }
        | tauri::EventTarget::AnyLabel { label } => Some(label.as_str()),
        _ => None,
    }
}

/// Windows connected to an external server keep their backend; only the
/// bundled ones move to the restarted sidecar (same rule as a manual restart).
pub(crate) fn notify_bundled_windows(app: &AppHandle, ready: BackendReady) {
    let external = app
        .state::<AppState>()
        .window_backend_base_urls
        .lock()
        .unwrap()
        .clone();
    let init_script = frontend_init_script(ready.token.as_deref(), &ready.base_url);
    for window in app.webview_windows().into_values() {
        if !external.contains_key(window.label()) {
            if let Err(e) = window.eval(&init_script) {
                log::warn!(
                    "inject restarted backend config into {}: {e}",
                    window.label()
                );
            }
        }
    }
    app.emit_filter("backend-ready", ready, |target| {
        !target_label(target).is_some_and(|l| external.contains_key(l))
    })
    .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_back_off_then_stop() {
        let mut b = RestartBudget::default();
        let t0 = Instant::now();
        assert_eq!(b.next_delay(t0), Some(Duration::from_secs(1)));
        assert_eq!(b.next_delay(t0), Some(Duration::from_secs(5)));
        assert_eq!(b.next_delay(t0), Some(Duration::from_secs(15)));
        assert_eq!(
            b.next_delay(t0),
            None,
            "a backend that keeps dying is left for the user"
        );
    }

    #[test]
    fn the_budget_refills_after_the_window() {
        let mut b = RestartBudget::default();
        let t0 = Instant::now();
        for _ in 0..3 {
            b.next_delay(t0);
        }
        let later = t0 + RESTART_WINDOW + Duration::from_secs(1);
        assert_eq!(b.next_delay(later), Some(Duration::from_secs(1)));
    }
}
