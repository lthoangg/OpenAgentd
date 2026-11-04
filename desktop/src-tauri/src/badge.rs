//! The attention badge: how many sessions wait on the user.
//!
//! The page counts them (`web/src/hooks/use-needs-you-badge.ts`) and reports
//! the number here. macOS and Linux have an app-level badge, set once;
//! Windows has only a per-window taskbar overlay, so each window gets a small
//! icon drawn in the accent colour.

use std::sync::atomic::{AtomicU32, Ordering};
use tauri::AppHandle;
#[cfg(windows)]
use tauri::Manager;

/// What every window last reported; a window created later starts with it.
static COUNT: AtomicU32 = AtomicU32::new(0);

/// Set the app's attention badge to `count`; zero clears it. Every window
/// reports the same number, so the last report wins without disagreeing.
#[tauri::command]
pub fn set_attention_badge(app: AppHandle, count: u32) -> Result<(), String> {
    COUNT.store(count, Ordering::Relaxed);
    apply_everywhere(&app, count);
    Ok(())
}

#[cfg(not(windows))]
fn apply_everywhere(app: &AppHandle, count: u32) {
    // One app-level badge: any app window can set it.
    let Some(window) = crate::window::target_webview_window(app) else {
        return;
    };
    let badge = (count > 0).then_some(i64::from(count));
    // Linux without Unity's launcher API has no badge; never worth an error.
    if let Err(e) = window.set_badge_count(badge) {
        log::debug!("attention badge unavailable: {e}");
    }
}

#[cfg(windows)]
fn apply_everywhere(app: &AppHandle, count: u32) {
    for (label, window) in app.webview_windows() {
        if !crate::window::is_overlay_window(&label) {
            set_overlay(&window, count);
        }
    }
}

/// Give a window created after the count was reported the same overlay.
/// Elsewhere the badge is app-level and needs nothing per window.
pub fn apply_to_window(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let count = COUNT.load(Ordering::Relaxed);
        if count > 0 {
            set_overlay(window, count);
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
fn set_overlay(window: &tauri::WebviewWindow, count: u32) {
    let icon = (count > 0).then(|| tauri::image::Image::new_owned(overlay_rgba(count), OVERLAY_SIZE, OVERLAY_SIZE));
    if let Err(e) = window.set_overlay_icon(icon) {
        log::debug!("taskbar overlay unavailable on {}: {e}", window.label());
    }
}

/// Side of the square overlay icon in pixels. The taskbar draws it at 16 px
/// (more on high-DPI screens), so 32 stays sharp when scaled down.
#[cfg(any(windows, test))]
const OVERLAY_SIZE: u32 = 32;

/// The theme's accent orange, RGBA: a step deep enough that the white digits
/// read at AA (5.1:1; the old #C2571A sat on the line at 4.49:1).
#[cfg(any(windows, test))]
const ACCENT: [u8; 4] = [0xb5, 0x50, 0x1a, 0xff];

/// What the overlay spells: one digit, or "9+" from ten sessions up, which
/// is all a 16 px icon can hold.
#[cfg(any(windows, test))]
fn overlay_label(count: u32) -> &'static str {
    const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    match count {
        0..=9 => DIGITS[count as usize],
        _ => "9+",
    }
}

/// 3×5 pixel glyphs, one row of three bits per line, top first.
#[cfg(any(windows, test))]
fn glyph(ch: char) -> [u8; 5] {
    match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

/// A filled accent circle with the count in white, as RGBA rows.
#[cfg(any(windows, test))]
fn overlay_rgba(count: u32) -> Vec<u8> {
    let size = OVERLAY_SIZE as usize;
    let mut pixels = vec![0u8; size * size * 4];
    let radius = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let (dx, dy) = (x as f32 + 0.5 - radius, y as f32 + 0.5 - radius);
            // One pixel of anti-aliasing along the rim.
            let coverage = (radius - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0);
            if coverage > 0.0 {
                let at = (y * size + x) * 4;
                pixels[at..at + 3].copy_from_slice(&ACCENT[..3]);
                pixels[at + 3] = (coverage * 255.0).round() as u8;
            }
        }
    }
    let label = overlay_label(count);
    // A lone digit is drawn larger than the two-glyph "9+" so it reads at 16 px.
    let scale = if label.len() == 1 { 4 } else { 3 };
    let gap = scale;
    let width = label.len() * 3 * scale + (label.len() - 1) * gap;
    let height = 5 * scale;
    let (left, top) = ((size - width) / 2, (size - height) / 2);
    for (index, ch) in label.chars().enumerate() {
        let origin = left + index * (3 * scale + gap);
        for (row, bits) in glyph(ch).into_iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let (x, y) = (origin + col * scale + dx, top + row * scale + dy);
                        let at = (y * size + x) * 4;
                        pixels[at..at + 4].copy_from_slice(&[0xff, 0xff, 0xff, 0xff]);
                    }
                }
            }
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(rgba: &[u8], x: usize, y: usize) -> [u8; 4] {
        let at = (y * OVERLAY_SIZE as usize + x) * 4;
        [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
    }

    #[test]
    fn the_overlay_spells_one_digit_and_caps_at_nine_plus() {
        assert_eq!(overlay_label(1), "1");
        assert_eq!(overlay_label(9), "9");
        assert_eq!(overlay_label(10), "9+");
        assert_eq!(overlay_label(400), "9+");
    }

    #[test]
    fn the_white_digits_read_at_aa_on_the_accent_disc() {
        fn luminance([r, g, b, _]: [u8; 4]) -> f64 {
            let channel = |c: u8| {
                let c = f64::from(c) / 255.0;
                if c <= 0.039_28 {
                    c / 12.92
                } else {
                    ((c + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }
        let ratio = (luminance([0xff; 4]) + 0.05) / (luminance(ACCENT) + 0.05);
        assert!(ratio >= 4.5, "white on the accent is {ratio:.2}:1");
    }

    #[test]
    fn the_overlay_is_an_accent_circle_with_white_digits() {
        for count in [1, 7, 12] {
            let rgba = overlay_rgba(count);
            let size = OVERLAY_SIZE as usize;
            assert_eq!(rgba.len(), size * size * 4);
            // Corners lie outside the circle: fully transparent.
            assert_eq!(pixel(&rgba, 0, 0)[3], 0);
            assert_eq!(pixel(&rgba, size - 1, size - 1)[3], 0);
            // The disc is opaque accent orange next to its rim…
            assert_eq!(pixel(&rgba, 3, size / 2), ACCENT);
            // …and the digits are opaque white.
            let white = rgba.chunks_exact(4).filter(|p| *p == [0xff; 4]).count();
            assert!(white > 20, "count {count} drew only {white} white pixels");
        }
    }

    #[test]
    fn the_overlay_text_stays_inside_the_disc() {
        // No white pixel may touch the transparent corners or the rim, or the
        // icon would look clipped at 16 px.
        for count in [0, 1, 8, 10] {
            let rgba = overlay_rgba(count);
            let size = OVERLAY_SIZE as usize;
            let centre = size as f32 / 2.0;
            for y in 0..size {
                for x in 0..size {
                    if pixel(&rgba, x, y) == [0xff, 0xff, 0xff, 0xff] {
                        let (dx, dy) = (x as f32 + 0.5 - centre, y as f32 + 0.5 - centre);
                        assert!((dx * dx + dy * dy).sqrt() < centre - 1.5, "count {count}: white pixel at {x},{y} reaches the rim");
                    }
                }
            }
        }
    }
}
