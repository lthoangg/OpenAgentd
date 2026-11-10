//! Hide the WebView's form accessory bar (the "< > ✓" row above the iOS
//! keyboard).
//!
//! The app has one field in view at a time, so the arrows have nowhere to go
//! and the check duplicates the composer's swipe down and the tap on the
//! transcript. On iOS 26 the bar floats over the page without being taken out
//! of `visualViewport`, so it hid the bottom of the composer. WKWebView asks
//! its private content view for `inputAccessoryView`; the content view is
//! moved to a subclass that answers `nil` (the technique Capacitor's
//! `Keyboard.setAccessoryBarVisible(false)` and Cordova use). If a later iOS
//! renames the view, nothing matches and the bar simply shows again.

use std::ffi::CString;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::{ffi, msg_send, sel};
use objc2_foundation::NSArray;
use tauri::{AppHandle, Manager};

const SUFFIX: &str = "_OADNoAccessoryBar";

/// Hide the bar on the main window. Call once the window exists (setup).
pub fn hide(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // `with_webview` runs on the main thread, as UIKit requires.
    let _ = window.with_webview(|webview| {
        // SAFETY: on iOS `inner()` is the window's live `WKWebView`.
        unsafe { hide_on(webview.inner().cast::<AnyObject>()) }
    });
}

/// SAFETY: `webview` is null or a live `WKWebView`; main thread only.
unsafe fn hide_on(webview: *mut AnyObject) {
    let Some(webview) = webview.as_ref() else {
        return;
    };
    let scroll: Option<Retained<AnyObject>> = msg_send![webview, scrollView];
    let Some(scroll) = scroll else { return };
    let subviews: Option<Retained<NSArray<AnyObject>>> = msg_send![&*scroll, subviews];
    let Some(subviews) = subviews else { return };
    for view in subviews.iter() {
        let cls = view.class();
        let Ok(name) = cls.name().to_str() else {
            continue;
        };
        if !name.starts_with("WKContent") || name.ends_with(SUFFIX) {
            continue;
        }
        let Some(subclass) = no_accessory_subclass(cls, name) else {
            return;
        };
        ffi::object_setClass(Retained::as_ptr(&view).cast_mut(), subclass);
    }
}

/// `cls` with `inputAccessoryView` returning nil, created once.
fn no_accessory_subclass(cls: &'static AnyClass, name: &str) -> Option<&'static AnyClass> {
    let sub_name = CString::new(format!("{name}{SUFFIX}")).ok()?;
    if let Some(existing) = AnyClass::get(&sub_name) {
        return Some(existing);
    }
    extern "C-unwind" fn no_accessory(_this: *mut AnyObject, _cmd: Sel) -> *mut AnyObject {
        std::ptr::null_mut()
    }
    let mut builder = ClassBuilder::new(&sub_name, cls)?;
    // SAFETY: the signature matches `-[UIResponder inputAccessoryView]`
    // (`- (UIView *)inputAccessoryView`, encoding `@@:`).
    unsafe {
        builder.add_method(
            sel!(inputAccessoryView),
            no_accessory as extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject,
        );
    }
    Some(builder.register())
}
