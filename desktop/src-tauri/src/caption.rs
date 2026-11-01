//! The Windows title bar, drawn by the page (decision 25 of the UX plan).
//!
//! On Windows the app window has no system frame (`decorations: false`, see
//! `window::build_app_window_sized`): the header doubles as the title bar,
//! with the three caption buttons at its right end
//! (`web/src/components/WindowCaptionButtons.tsx`), as Windows 11 apps do.
//! The window keeps its drop shadow and resize edges (tao draws both for an
//! undecorated, resizable window).
//!
//! Snap Layouts open when the pointer rests on a *system* maximize button:
//! Windows asks the frame (`WM_NCHITTEST` → `HTMAXBUTTON`), but here the
//! webview owns every pixel, so the frame is never asked. The page's
//! maximize button calls [`show_snap_layouts`] after the same short rest,
//! and the shell opens the flyout the way the keyboard does (Win+Z), for
//! this window.

use tauri::WebviewWindow;

/// The keys that open Snap Layouts, in order: Win down, Z down, Z up, Win up.
/// Pairs of (virtual-key code, key up).
#[cfg(any(windows, test))]
pub const SNAP_LAYOUT_KEYS: [(u16, bool); 4] = [(VK_LWIN, false), (VK_Z, false), (VK_Z, true), (VK_LWIN, true)];

#[cfg(any(windows, test))]
const VK_LWIN: u16 = 0x5B;
#[cfg(any(windows, test))]
const VK_Z: u16 = 0x5A;

/// Open Windows 11's Snap Layouts for `window`, as hovering a system
/// maximize button does. Elsewhere it does nothing.
#[tauri::command]
pub fn show_snap_layouts(window: WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        // The flyout belongs to the foreground window.
        window.set_focus().map_err(|e| e.to_string())?;
        send_keys(&SNAP_LAYOUT_KEYS)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(windows)]
fn send_keys(keys: &[(u16, bool)]) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let inputs: Vec<INPUT> = keys
        .iter()
        .map(|&(vk, up)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();
    // SAFETY: `inputs` is a live slice of fully initialised INPUT records and
    // the size passed is that of one record, as SendInput requires.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows did not take the Snap Layouts keys".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_layouts_are_win_z_pressed_and_released_in_order() {
        assert_eq!(SNAP_LAYOUT_KEYS, [(0x5B, false), (0x5A, false), (0x5A, true), (0x5B, true)]);
    }
}
