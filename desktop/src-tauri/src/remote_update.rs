//! Update this computer's app from another device.
//!
//! A phone connected to the built-in server sees "Update to vX" on it. Its
//! tap reaches the server as `POST /api/server/update`; the server only
//! records it, because the app installs the app. This module asks the
//! server for that request on the private desktop route (desktop token,
//! loopback: a device on the network can ask for an update but never
//! collect or settle one) and runs the updater the app already has: the
//! signed release from the app's own feed, whatever the request says. The
//! phone follows the server through the restart.
//!
//! Not on Linux: the app is a .deb, which the updater cannot replace, so
//! the server is not told the app updates itself and reports why not.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::AppState;

const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Whether this app installs its own updates.
pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// What the server hands over: the release the other device saw.
#[derive(Debug, Deserialize)]
struct Request {
    target: String,
}

#[derive(Deserialize)]
struct Pending {
    request: Option<Request>,
}

/// The effects of one requested update, in the order [`run_request`] runs
/// them. The app's are `AppUpdate`; tests record them.
pub(crate) trait UpdateSteps {
    /// The version the app's feed lists, if any is newer than this app.
    async fn check(&mut self) -> Result<Option<String>, String>;
    /// Tell whoever sits at the computer that the app is about to restart.
    fn announce(&mut self, version: &str);
    async fn download(&mut self) -> Result<(), String>;
    /// Verify and install what was downloaded, then restart. Returns only
    /// when it failed, or when another install already owns the restart.
    async fn install(&mut self) -> Result<(), String>;
}

/// Check, announce, download and install. An error is what the device that
/// asked is told; the app and its server keep running on the old version.
pub(crate) async fn run_request<S: UpdateSteps>(steps: &mut S, target: &str) -> Result<(), String> {
    // The server reads the release list; the app's bundles are published a
    // little later, so the app's feed can still be behind it.
    let Some(version) = steps.check().await? else {
        return Err(format!("v{target} is not out for the desktop app yet. Try again in a few minutes."));
    };
    steps.announce(&version);
    steps.download().await?;
    steps.install().await
}

/// The app's update effects for [`run_request`].
struct AppUpdate {
    app: AppHandle,
    /// The listed version is already downloaded (someone pressed Download).
    downloaded: bool,
}

impl UpdateSteps for AppUpdate {
    async fn check(&mut self) -> Result<Option<String>, String> {
        let status = crate::updater::run_update_check(self.app.clone(), false).await?;
        self.downloaded = status.status == "downloaded";
        Ok(status.version.filter(|_| status.status != "up_to_date"))
    }

    fn announce(&mut self, version: &str) {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = self
            .app
            .notification()
            .builder()
            .title(format!("Updating OpenAgentd to v{version}"))
            .body("One of your devices asked for the update. OpenAgentd restarts when the download finishes, and running sessions resume.")
            .show()
        {
            log::warn!("remote_update_notification_failed error={e:#}");
        }
    }

    async fn download(&mut self) -> Result<(), String> {
        if self.downloaded {
            return Ok(());
        }
        crate::updater::run_update_download(self.app.clone()).await.map(|_| ())
    }

    async fn install(&mut self) -> Result<(), String> {
        crate::updater::run_update_install(self.app.clone()).await
    }
}

fn request_url(base: &str) -> String {
    format!("{}/api/desktop/update-request", base.trim_end_matches('/'))
}

/// The request waiting on the built-in server, if any. A server that does
/// not answer has none.
async fn pending(base: &str, token: &str) -> Option<Request> {
    let res = crate::usage::loopback_client().get(request_url(base)).bearer_auth(token).send().await.ok()?;
    res.error_for_status().ok()?.json::<Pending>().await.ok()?.request
}

/// Tell the server, and through it the device that asked, why the update
/// did not happen. A failed install restarts the server, so its address is
/// read again.
async fn report_failure(app: &AppHandle, message: &str) {
    let Some((base, token)) = crate::network_access::sidecar(app).await else {
        return;
    };
    let body = serde_json::json!({"ok": false, "message": message});
    if let Err(e) = crate::usage::loopback_client().put(request_url(&base)).bearer_auth(token).json(&body).send().await {
        log::warn!("remote_update_report_failed error={e}");
    }
}

/// Ask the built-in server for an update request every [`POLL_INTERVAL`]
/// and run it. On success the app restarts inside `install`.
pub async fn run(app: AppHandle) {
    let mut tick = tokio::time::interval(POLL_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
            continue;
        }
        let Some((base, token)) = crate::network_access::sidecar(&app).await else {
            continue;
        };
        let Some(request) = pending(&base, &token).await else {
            continue;
        };
        log::info!("remote update requested target={}", request.target);
        let mut steps = AppUpdate { app: app.clone(), downloaded: false };
        if let Err(message) = run_request(&mut steps, &request.target).await {
            log::warn!("remote update failed: {message}");
            report_failure(&app, &message).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        events: Vec<String>,
        listed: Option<&'static str>,
        download_ok: bool,
        install_ok: bool,
    }

    impl UpdateSteps for Recorder {
        async fn check(&mut self) -> Result<Option<String>, String> {
            self.events.push("check".into());
            Ok(self.listed.map(String::from))
        }
        fn announce(&mut self, version: &str) {
            self.events.push(format!("announce {version}"));
        }
        async fn download(&mut self) -> Result<(), String> {
            self.events.push("download".into());
            if self.download_ok { Ok(()) } else { Err("Failed to download update: offline".into()) }
        }
        async fn install(&mut self) -> Result<(), String> {
            self.events.push("install".into());
            if self.install_ok { Ok(()) } else { Err("Failed to install update: disk full".into()) }
        }
    }

    fn recorder(listed: Option<&'static str>) -> Recorder {
        Recorder { listed, download_ok: true, install_ok: true, ..Default::default() }
    }

    #[tokio::test]
    async fn a_request_checks_announces_downloads_and_installs_in_that_order() {
        let mut steps = recorder(Some("3.54.0"));

        run_request(&mut steps, "3.54.0").await.expect("update");

        assert_eq!(steps.events, ["check", "announce 3.54.0", "download", "install"]);
    }

    #[tokio::test]
    async fn the_apps_own_feed_decides_what_is_installed_not_the_request() {
        let mut steps = recorder(Some("3.55.0"));

        run_request(&mut steps, "3.54.0").await.expect("update");

        assert_eq!(steps.events[1], "announce 3.55.0", "the feed moved on since the phone looked");
    }

    #[tokio::test]
    async fn a_release_the_apps_feed_does_not_list_yet_is_not_announced_or_installed() {
        let mut steps = recorder(None);

        let err = run_request(&mut steps, "3.54.0").await.unwrap_err();

        assert!(err.contains("v3.54.0") && err.contains("not out for the desktop app yet"), "{err}");
        assert_eq!(steps.events, ["check"]);
    }

    #[tokio::test]
    async fn a_failed_download_or_install_is_reported_as_it_happened() {
        let mut steps = Recorder { download_ok: false, ..recorder(Some("3.54.0")) };
        let err = run_request(&mut steps, "3.54.0").await.unwrap_err();
        assert_eq!(err, "Failed to download update: offline");
        assert_eq!(steps.events, ["check", "announce 3.54.0", "download"], "nothing is installed");

        let mut steps = Recorder { install_ok: false, ..recorder(Some("3.54.0")) };
        let err = run_request(&mut steps, "3.54.0").await.unwrap_err();
        assert_eq!(err, "Failed to install update: disk full");
    }
}
