//! Native system UI the web UI asks for by name: the share sheet and a
//! single-choice picker.
//!
//! Both are presented by the platform (iOS `UIActivityViewController` /
//! `UIAlertController` action sheet, Android `ACTION_SEND` chooser /
//! `AlertDialog`) so they look, scroll, and announce themselves like the
//! rest of the OS. The web UI currently calls neither: its menus, pickers and
//! sheets are its own (DESIGN.md → Native first), so a caller must bring its
//! own fallback for when a command fails.
//!
//! Input is validated here, once, for both platforms: the platform code
//! only ever sees a bounded, non-empty request.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Longest text or URL the share sheet is given. Longer input is refused
/// rather than cut: a truncated link is a broken link.
const MAX_SHARE_CHARS: usize = 8_192;
/// Longest title (share subject, picker heading); longer is cut, not refused.
const MAX_TITLE_CHARS: usize = 200;
/// Most options one picker shows. Past this a searchable in-app list is the
/// right control, not a system sheet.
const MAX_OPTIONS: usize = 100;
/// Longest option label; longer is cut, not refused.
const MAX_LABEL_CHARS: usize = 200;

/// A request to share, after [`normalize_share`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct ShareContent {
    text: Option<String>,
    url: Option<String>,
    title: Option<String>,
}

/// One row of a picker.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PickOption {
    pub id: String,
    pub label: String,
}

/// A picker request, after [`normalize_pick`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct PickRequest {
    title: String,
    options: Vec<PickOption>,
    selected: Option<String>,
}

fn clip(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Trim, and treat whitespace-only as absent.
fn non_blank(text: Option<String>) -> Option<String> {
    text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

fn normalize_share(
    text: Option<String>,
    url: Option<String>,
    title: Option<String>,
) -> Result<ShareContent, String> {
    let text = non_blank(text);
    let url = non_blank(url);
    if text.is_none() && url.is_none() {
        return Err("Nothing to share: give a text or a URL.".to_string());
    }
    if text
        .as_ref()
        .is_some_and(|t| t.chars().count() > MAX_SHARE_CHARS)
    {
        return Err("The text to share is too long.".to_string());
    }
    if let Some(url) = &url {
        if url.chars().count() > MAX_SHARE_CHARS {
            return Err("The URL to share is too long.".to_string());
        }
        // Any scheme: a deep link is as shareable as a web link. What must
        // hold is that it is an absolute URL, so a bare word is not offered
        // to other apps as a "link".
        url::Url::parse(url).map_err(|e| format!("Not a valid URL: {e}"))?;
    }
    Ok(ShareContent {
        text,
        url,
        title: non_blank(title).map(|t| clip(&t, MAX_TITLE_CHARS)),
    })
}

fn normalize_pick(
    title: String,
    options: Vec<PickOption>,
    selected: Option<String>,
) -> Result<PickRequest, String> {
    if options.is_empty() {
        return Err("A picker needs at least one option.".to_string());
    }
    if options.len() > MAX_OPTIONS {
        return Err(format!("A picker shows at most {MAX_OPTIONS} options."));
    }
    let mut seen = std::collections::HashSet::with_capacity(options.len());
    let mut cleaned = Vec::with_capacity(options.len());
    for option in options {
        let label = option.label.trim();
        if option.id.is_empty() || label.is_empty() {
            return Err("Every option needs an id and a label.".to_string());
        }
        // Ids are what comes back; two rows with one id could not be told
        // apart, so refuse instead of guessing.
        if !seen.insert(option.id.clone()) {
            return Err(format!("Duplicate option id: {}", option.id));
        }
        cleaned.push(PickOption {
            id: option.id,
            label: clip(label, MAX_LABEL_CHARS),
        });
    }
    Ok(PickRequest {
        title: clip(title.trim(), MAX_TITLE_CHARS),
        options: cleaned,
        selected: selected.filter(|id| seen.contains(id)),
    })
}

/// How iOS marks the current choice. `UIAlertAction` has no public
/// checkmark or image, and its KVC "checked" key is private API, so the
/// check goes in the title. Action-sheet titles are centred, so rows that
/// lack the prefix still line up.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn checked_label(label: &str, selected: bool) -> String {
    if selected {
        format!("\u{2713}  {label}")
    } else {
        label.to_string()
    }
}

/// Open the system share sheet for a link and/or some text.
///
/// iOS shows the text and the URL as separate activity items (the title has
/// no slot on a `UIActivityViewController`); Android sends them as one
/// `text/plain` body with the title as the subject. Resolves once the sheet
/// is up, not when the user finishes with it.
#[tauri::command]
pub async fn share_text(
    app: AppHandle,
    text: Option<String>,
    url: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    present_share(app, normalize_share(text, url, title)?).await
}

/// Let the user choose one of `options` in the system's own control: an
/// action sheet on iOS, a single-choice dialog on Android. Resolves with
/// the chosen option's `id`, or `None` when dismissed. `selected` is the
/// current choice, which the sheet marks.
#[tauri::command]
pub async fn pick_one(
    app: AppHandle,
    title: String,
    options: Vec<PickOption>,
    selected: Option<String>,
) -> Result<Option<String>, String> {
    present_picker(app, normalize_pick(title, options, selected)?).await
}

// ── iOS ─────────────────────────────────────────────────────────────────
//
// UIKit must be driven from the main thread, but Tauri runs async commands
// on a worker. Work is queued on the main GCD queue and its result comes
// back over a channel, so no worker blocks while the main thread is busy.

#[cfg(target_os = "ios")]
async fn present_share(_app: AppHandle, content: ShareContent) -> Result<(), String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<(), String>>(1);
    dispatch2::DispatchQueue::main().exec_async(move || {
        let result = match objc2::MainThreadMarker::new() {
            Some(mtm) => ios::present_share(mtm, &content),
            None => Err("The share sheet must be shown on the main thread.".to_string()),
        };
        let _ = tx.try_send(result);
    });
    rx.recv()
        .await
        .unwrap_or_else(|| Err("Main thread dispatch failed.".to_string()))
}

#[cfg(target_os = "ios")]
async fn present_picker(_app: AppHandle, request: PickRequest) -> Result<Option<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<Option<String>, String>>(1);
    dispatch2::DispatchQueue::main().exec_async(move || {
        let presented = match objc2::MainThreadMarker::new() {
            Some(mtm) => ios::present_picker(mtm, &request, &tx),
            None => Err("The picker must be shown on the main thread.".to_string()),
        };
        if let Err(e) = presented {
            let _ = tx.try_send(Err(e));
        }
        // `tx` drops here. Each action's handler holds its own clone, so the
        // channel stays open exactly as long as the sheet can still answer.
    });
    // `None` means every sender is gone without an answer: the sheet was
    // torn down by the system (scene closed, app killed the controller).
    // That is a dismissal, not an error.
    match rx.recv().await {
        Some(answer) => answer,
        None => Ok(None),
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use objc2_ui_kit::{
        UIActivityViewController, UIAlertAction, UIAlertActionStyle, UIAlertController,
        UIAlertControllerStyle, UIApplication, UIPopoverArrowDirection, UIViewController,
        UIWindowScene,
    };
    use tauri::async_runtime::Sender;

    use super::{checked_label, PickRequest, ShareContent};

    type Answer = Result<Option<String>, String>;
    type ActionHandler = RcBlock<dyn Fn(NonNull<UIAlertAction>)>;

    /// The view controller to present from: the root controller, or
    /// whatever it is already presenting. Presenting from a controller that
    /// has a presentation up is silently ignored by UIKit.
    fn top_view_controller(mtm: MainThreadMarker) -> Result<Retained<UIViewController>, String> {
        let mut top: Retained<UIViewController> = UIApplication::sharedApplication(mtm)
            .connectedScenes()
            .iter()
            .find_map(|scene| {
                let scene = scene.downcast::<UIWindowScene>().ok()?;
                let window = scene
                    .keyWindow()
                    .or_else(|| scene.windows().firstObject())?;
                window.rootViewController()
            })
            .ok_or("Root view controller not found")?;
        while let Some(presented) = top.presentedViewController() {
            top = presented;
        }
        Ok(top)
    }

    /// On iPad a sheet is a popover and must be anchored; on iPhone there is
    /// no popover and this does nothing. Anchored to the bottom centre of the
    /// host view, arrow down, so it opens upward over the content rather
    /// than over the control the web UI drew.
    fn anchor_to_bottom_centre(presented: &UIViewController, host: &UIViewController) {
        let (Some(popover), Some(view)) = (presented.popoverPresentationController(), host.view())
        else {
            return;
        };
        let bounds: CGRect = view.bounds();
        popover.setSourceView(Some(&view));
        popover.setSourceRect(CGRect::new(
            CGPoint::new(bounds.size.width / 2.0, bounds.size.height),
            CGSize::new(0.0, 0.0),
        ));
        popover.setPermittedArrowDirections(UIPopoverArrowDirection::Down);
    }

    /// Erase an object's static type for an untyped `NSArray`.
    fn erase<T: objc2::Message>(object: Retained<T>) -> Retained<AnyObject> {
        // SAFETY: every Objective-C object is an `AnyObject`; this only
        // forgets the static type.
        unsafe { Retained::cast_unchecked::<AnyObject>(object) }
    }

    pub fn present_share(mtm: MainThreadMarker, content: &ShareContent) -> Result<(), String> {
        let mut items: Vec<Retained<AnyObject>> = Vec::new();
        if let Some(text) = &content.text {
            items.push(erase(NSString::from_str(text)));
        }
        if let Some(url) = &content.url {
            let string = NSString::from_str(url);
            // `NSURL` is stricter than the `url` crate; a link it rejects is
            // still worth sharing as text.
            match NSURL::URLWithString(&string) {
                Some(url) => items.push(erase(url)),
                None => items.push(erase(string)),
            }
        }
        let items: Retained<NSArray> = NSArray::from_retained_slice(&items);

        let host = top_view_controller(mtm)?;
        // SAFETY: `items` holds only `NSString` and `NSURL` objects, which
        // are valid activity items, and no custom activities are passed.
        let sheet = unsafe {
            UIActivityViewController::initWithActivityItems_applicationActivities(
                UIActivityViewController::alloc(mtm),
                &items,
                None,
            )
        };
        anchor_to_bottom_centre(&sheet, &host);
        host.presentViewController_animated_completion(&sheet, true, None);
        Ok(())
    }

    /// An action's handler: report `choice` to the awaiting command. Only one
    /// action ever fires, and `try_send` on the 1-slot channel is a no-op for
    /// any later call.
    fn answer_with(tx: &Sender<Answer>, choice: Option<String>) -> ActionHandler {
        let tx = tx.clone();
        RcBlock::new(move |_action: NonNull<UIAlertAction>| {
            let _ = tx.try_send(Ok(choice.clone()));
        })
    }

    fn action(
        mtm: MainThreadMarker,
        title: &NSString,
        style: UIAlertActionStyle,
        handler: &ActionHandler,
    ) -> Retained<UIAlertAction> {
        UIAlertAction::actionWithTitle_style_handler(Some(title), style, Some(handler), mtm)
    }

    pub fn present_picker(
        mtm: MainThreadMarker,
        request: &PickRequest,
        tx: &Sender<Answer>,
    ) -> Result<(), String> {
        let host = top_view_controller(mtm)?;
        let heading = NSString::from_str(&request.title);
        let sheet = UIAlertController::alertControllerWithTitle_message_preferredStyle(
            Some(&heading),
            None,
            UIAlertControllerStyle::ActionSheet,
            mtm,
        );
        for option in &request.options {
            let selected = request.selected.as_deref() == Some(option.id.as_str());
            let label = NSString::from_str(&checked_label(&option.label, selected));
            let handler = answer_with(tx, Some(option.id.clone()));
            sheet.addAction(&action(mtm, &label, UIAlertActionStyle::Default, &handler));
        }
        // On iPad the system omits the Cancel row and calls its handler when
        // the popover is dismissed by tapping outside, so a dismissal still
        // answers.
        let cancel = answer_with(tx, None);
        // English like the rest of the app, which has no localisations.
        let cancel_title = NSString::from_str("Cancel");
        sheet.addAction(&action(
            mtm,
            &cancel_title,
            UIAlertActionStyle::Cancel,
            &cancel,
        ));

        anchor_to_bottom_centre(&sheet, &host);
        host.presentViewController_animated_completion(&sheet, true, None);
        Ok(())
    }
}

// ── Android ─────────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
async fn present_share(app: AppHandle, content: ShareContent) -> Result<(), String> {
    use tauri_plugin_openagentd_android::AndroidShellExt;
    // The JNI call blocks until the chooser is up; keep it off the async
    // workers (same as `save_workspace_file`'s share).
    tauri::async_runtime::spawn_blocking(move || {
        app.android_shell().share_text(
            content.text.as_deref(),
            content.url.as_deref(),
            content.title.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Share task failed: {e}"))?
}

#[cfg(target_os = "android")]
async fn present_picker(app: AppHandle, request: PickRequest) -> Result<Option<String>, String> {
    use tauri_plugin_openagentd_android::{AndroidShellExt, PickChoice};
    let choices: Vec<PickChoice<'_>> = request
        .options
        .iter()
        .map(|o| PickChoice {
            id: &o.id,
            label: &o.label,
        })
        .collect();
    // Async: the dialog stays up for as long as the user takes, and a
    // blocking JNI call would pin a worker thread for all of it.
    app.android_shell()
        .pick_one(&request.title, &choices, request.selected.as_deref())
        .await
}

// ── Everything else ─────────────────────────────────────────────────────
//
// Only so the crate checks and tests on a development host. The web side
// only calls these inside the mobile shell.

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn present_share(_app: AppHandle, _content: ShareContent) -> Result<(), String> {
    Err("The system share sheet is only available in the mobile app.".to_string())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn present_picker(_app: AppHandle, _request: PickRequest) -> Result<Option<String>, String> {
    Err("The system picker is only available in the mobile app.".to_string())
}

#[cfg(test)]
mod tests {
    use super::{checked_label, normalize_pick, normalize_share, PickOption, MAX_OPTIONS};

    fn option(id: &str, label: &str) -> PickOption {
        PickOption {
            id: id.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn a_link_alone_is_shareable() {
        let content =
            normalize_share(None, Some(" https://box.example/s/1 ".into()), None).unwrap();
        assert_eq!(content.url.as_deref(), Some("https://box.example/s/1"));
        assert_eq!(content.text, None);
    }

    #[test]
    fn blank_text_and_url_leave_nothing_to_share() {
        assert!(normalize_share(Some("  ".into()), None, Some("Title".into())).is_err());
        assert!(normalize_share(None, Some("".into()), None).is_err());
        assert!(normalize_share(None, None, None).is_err());
    }

    #[test]
    fn a_url_must_be_absolute_but_any_scheme_will_do() {
        assert!(normalize_share(None, Some("not a url".into()), None).is_err());
        assert!(normalize_share(None, Some("/relative/path".into()), None).is_err());
        assert!(normalize_share(None, Some("openagentd://session/abc".into()), None).is_ok());
    }

    #[test]
    fn oversized_share_input_is_refused_not_cut() {
        let long = "a".repeat(9_000);
        assert!(normalize_share(Some(long.clone()), None, None).is_err());
        assert!(normalize_share(None, Some(format!("https://x.example/{long}")), None).is_err());
    }

    #[test]
    fn a_long_title_is_cut_and_a_blank_one_dropped() {
        let content = normalize_share(Some("hi".into()), None, Some("t".repeat(500))).unwrap();
        assert_eq!(content.title.map(|t| t.chars().count()), Some(200));
        let content = normalize_share(Some("hi".into()), None, Some("   ".into())).unwrap();
        assert_eq!(content.title, None);
    }

    #[test]
    fn a_picker_keeps_option_order_and_the_selected_id() {
        let request = normalize_pick(
            " Theme ".into(),
            vec![option("light", "Light"), option("dark", " Dark ")],
            Some("dark".into()),
        )
        .unwrap();
        assert_eq!(request.title, "Theme");
        assert_eq!(
            request.options,
            vec![option("light", "Light"), option("dark", "Dark")]
        );
        assert_eq!(request.selected.as_deref(), Some("dark"));
    }

    #[test]
    fn a_selected_id_that_is_not_an_option_marks_nothing() {
        let request =
            normalize_pick("T".into(), vec![option("a", "A")], Some("gone".into())).unwrap();
        assert_eq!(request.selected, None);
    }

    #[test]
    fn a_picker_refuses_empty_oversized_blank_and_duplicate_options() {
        assert!(normalize_pick("T".into(), vec![], None).is_err());
        let many: Vec<PickOption> = (0..=MAX_OPTIONS)
            .map(|i| option(&i.to_string(), "x"))
            .collect();
        assert!(normalize_pick("T".into(), many, None).is_err());
        assert!(normalize_pick("T".into(), vec![option("", "A")], None).is_err());
        assert!(normalize_pick("T".into(), vec![option("a", "  ")], None).is_err());
        assert!(
            normalize_pick("T".into(), vec![option("a", "A"), option("a", "B")], None).is_err()
        );
    }

    #[test]
    fn a_long_label_is_cut() {
        let request =
            normalize_pick("T".into(), vec![option("a", &"l".repeat(500))], None).unwrap();
        assert_eq!(request.options[0].label.chars().count(), 200);
    }

    #[test]
    fn the_current_choice_is_marked_in_the_title() {
        assert_eq!(checked_label("Dark", true), "\u{2713}  Dark");
        assert_eq!(checked_label("Dark", false), "Dark");
    }
}
