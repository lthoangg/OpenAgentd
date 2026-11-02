//! The system share sheet for a link (a session's `openagentd://` link, or a
//! browser address): `NSSharingServicePicker` on macOS, the Share window of
//! `DataTransferManager` on Windows. Linux has no system share sheet, so the
//! page falls back to copying the link.

use tauri::{AppHandle, WebviewWindow};

/// What the command answers where there is no share sheet; the page treats
/// any error as "share another way".
#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
const UNSUPPORTED: &str = "unsupported";

const MAX_LINK_BYTES: usize = 2048;
const MAX_TITLE_CHARS: usize = 300;
const DEFAULT_TITLE: &str = "OpenAgentd";

/// `link` as a URL the share targets can take. Only the links the app hands
/// out: its own deep links and web addresses, never `file:` or script URLs.
#[cfg_attr(not(any(target_os = "macos", windows, test)), allow(dead_code))]
fn validate_link(link: &str) -> Result<url::Url, String> {
    if link.len() > MAX_LINK_BYTES {
        return Err("The link is too long to share.".into());
    }
    let url = url::Url::parse(link).map_err(|_| "Not a valid link.".to_string())?;
    match url.scheme() {
        "http" | "https" | "openagentd" => Ok(url),
        other => Err(format!("Cannot share a {other}: link.")),
    }
}

/// The title the share window shows: the session's, or the app's name.
#[cfg_attr(not(any(target_os = "macos", windows, test)), allow(dead_code))]
fn share_title(title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        return DEFAULT_TITLE.to_string();
    }
    title.chars().take(MAX_TITLE_CHARS).collect()
}

/// Show the system share sheet for `url`. On macOS it opens anchored at (`x`,
/// `y`), CSS pixels from the page's top-left corner; Windows places its own
/// window and ignores them. `title` is the name the share window shows
/// (Windows only; macOS shares the link alone). Resolves once the sheet is
/// shown, not once something is shared.
#[tauri::command]
pub async fn share_url(
    app: AppHandle,
    window: WebviewWindow,
    url: String,
    title: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if crate::window::is_overlay_window(window.label()) {
        return Err("Only app windows can share.".into());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, url, title, x, y);
        Err(UNSUPPORTED.into())
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        let link = validate_link(&url)?;
        let at = crate::context_menu::window_point(x, y, crate::context_menu::zoom_of(&app, window.label()))?;
        let title = share_title(&title);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        // The sheet belongs to the main thread's window and event loop.
        app.run_on_main_thread(move || {
            let _ = done_tx.send(platform::show(&window, link.as_str(), &title, at).map_err(|e| format!("{e:#}")));
        })
        .map_err(|e| e.to_string())?;
        done_rx
            .await
            .map_err(|e| e.to_string())?
            .inspect_err(|e| log::warn!("could not show the share sheet: {e}"))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use anyhow::{anyhow, Result};
    use objc2::{rc::Retained, runtime::AnyObject, AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSSharingServicePicker, NSWindow};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
    use std::cell::RefCell;
    use tauri::{LogicalPosition, WebviewWindow};

    thread_local! {
        // The picker has no owner once shown; keep the last one alive until
        // the next share so its services can finish.
        static PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> = const { RefCell::new(None) };
    }

    /// Main thread only.
    pub fn show(window: &WebviewWindow, url: &str, _title: &str, at: LogicalPosition<f64>) -> Result<()> {
        MainThreadMarker::new().ok_or_else(|| anyhow!("the share sheet needs the main thread"))?;
        let ptr = window.ns_window()?;
        if ptr.is_null() {
            return Err(anyhow!("the window has no NSWindow"));
        }
        // SAFETY: Tauri hands out the window's live NSWindow, and we are on
        // the main thread (checked above).
        let ns_window = unsafe { &*(ptr as *const NSWindow) };
        let view = ns_window.contentView().ok_or_else(|| anyhow!("the window has no content view"))?;
        let link = NSURL::URLWithString(&NSString::from_str(url)).ok_or_else(|| anyhow!("not a valid link"))?;
        let item: &AnyObject = &link;
        let items = NSArray::from_slice(&[item]);
        // SAFETY: `items` holds one NSURL, which conforms to NSPasteboardWriting.
        let picker = unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items) };
        // AppKit measures from the bottom edge unless the view is flipped.
        let y = if view.isFlipped() { at.y } else { view.frame().size.height - at.y };
        let anchor = NSRect::new(NSPoint::new(at.x, y), NSSize::new(1.0, 1.0));
        // Opens below the point (flipping above it near the screen's edge). An
        // edge is named by its coordinate, so "below" is the larger y in a
        // flipped view and the smaller one otherwise.
        let below = if view.isFlipped() { NSRectEdge::MaxY } else { NSRectEdge::MinY };
        picker.showRelativeToRect_ofView_preferredEdge(anchor, &view, below);
        PICKER.with(|slot| *slot.borrow_mut() = Some(picker));
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::validate_link;
    use anyhow::{Context, Result};
    use std::sync::Mutex;
    use tauri::{LogicalPosition, WebviewWindow};
    use windows::{
        core::{factory, HSTRING},
        ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager},
        Foundation::{TypedEventHandler, Uri},
        Win32::UI::Shell::IDataTransferManagerInterop,
    };

    /// The window and event token of the last share's data handler.
    static LAST: Mutex<Option<(isize, i64)>> = Mutex::new(None);

    /// Main thread only. The Share window places itself, so the point is unused.
    pub fn show(window: &WebviewWindow, url: &str, title: &str, _at: LogicalPosition<f64>) -> Result<()> {
        let hwnd = window.hwnd().context("the window has no handle")?;
        let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()
            .context("the share interface is not available")?;
        // SAFETY: `hwnd` is this app window's live handle.
        let manager = unsafe { interop.GetForWindow::<DataTransferManager>(hwnd) }
            .context("the window has no share manager")?;
        // One manager serves the window for good; an earlier share's handler
        // would still answer first, with the wrong link.
        if let Ok(mut last) = LAST.lock() {
            if let Some((previous, token)) = last.take() {
                if previous == hwnd.0 as isize {
                    let _ = manager.RemoveDataRequested(token);
                }
            }
        }
        let is_web = validate_link(url).is_ok_and(|link| link.scheme() != "openagentd");
        let (url, title) = (url.to_string(), title.to_string());
        let handler = TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            let data = args.Request()?.Data()?;
            // Windows refuses a share without a title.
            data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
            // Text first: every target takes it, including for `openagentd://`.
            data.SetText(&HSTRING::from(url.as_str()))?;
            if let Ok(uri) = Uri::CreateUri(&HSTRING::from(url.as_str())) {
                if is_web {
                    data.SetWebLink(&uri)?;
                } else {
                    data.SetApplicationLink(&uri)?;
                }
            }
            Ok(())
        });
        let token = manager.DataRequested(&handler).context("could not listen for the share request")?;
        if let Ok(mut last) = LAST.lock() {
            *last = Some((hwnd.0 as isize, token));
        }
        // SAFETY: as above.
        unsafe { interop.ShowShareUIForWindow(hwnd) }.context("could not show the share window")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_links_and_web_addresses_can_be_shared() {
        assert!(validate_link("openagentd://session/abc%20def").is_ok());
        assert!(validate_link("https://example.com/abc").is_ok());
        assert!(validate_link("http://localhost:5173/abc").is_ok());
        for refused in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "not a url", ""] {
            assert!(validate_link(refused).is_err(), "{refused}");
        }
        assert!(validate_link(&format!("https://example.com/{}", "a".repeat(MAX_LINK_BYTES))).is_err());
    }

    #[test]
    fn the_share_title_is_the_sessions_or_the_apps_name() {
        assert_eq!(share_title("  Fix updater  "), "Fix updater");
        assert_eq!(share_title(""), "OpenAgentd");
        assert_eq!(share_title("   "), "OpenAgentd");
        assert_eq!(share_title(&"x".repeat(400)).chars().count(), MAX_TITLE_CHARS);
    }
}
