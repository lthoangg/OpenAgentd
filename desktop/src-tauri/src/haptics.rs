//! The trackpad's "alignment" tick (`haptic_alignment`): the page calls it
//! when a drag (a panel edge, a pane split) snaps onto its default size, the
//! way Finder and Xcode split views do. Only a Mac with a Force Touch
//! trackpad feels it; every other platform (and a Mac without one) answers
//! `Ok` and does nothing, so the page never has to check.

use tauri::AppHandle;

/// Tick the trackpad once, now. Best effort: never an error for the page.
#[tauri::command]
pub fn haptic_alignment(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // AppKit's performer belongs to the main thread; the tick must not
        // wait for the reply, so nothing is awaited here.
        app.run_on_main_thread(platform::alignment).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
        NSHapticFeedbackPerformer,
    };

    /// Main thread only (checked: off it, nothing happens).
    pub fn alignment() {
        if MainThreadMarker::new().is_none() {
            return;
        }
        NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(
            NSHapticFeedbackPattern::Alignment,
            NSHapticFeedbackPerformanceTime::Now,
        );
    }
}
