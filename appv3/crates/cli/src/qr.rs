//! The `openagentd://connect` link as a terminal QR code (`server start
//! --qr`, `server status --qr`). It is the link the desktop Network access
//! card shows (`web/src/lib/connect-link.ts`); the mobile app opens it with
//! the address and access key filled in.

use anyhow::{Context, Result};
use qrcode::{Color, EcLevel, QrCode};

/// `MAX_URLS` in `connect-link.ts`: the parser ignores the rest.
const MAX_URLS: usize = 8;
/// Light modules around the code (the spec asks for 4; 2 scans fine on a
/// screen and keeps the code small).
const QUIET_ZONE: usize = 2;

/// `application/x-www-form-urlencoded`, byte for byte what
/// `URLSearchParams.toString()` writes.
fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `buildConnectLink({ urls, key })`.
pub fn connect_link(urls: &[String], key: &str) -> String {
    let mut params: Vec<String> = urls.iter().take(MAX_URLS).map(|u| format!("url={}", form_encode(u))).collect();
    params.push(format!("key={}", form_encode(key)));
    format!("openagentd://connect?{}", params.join("&"))
}

/// `text` as a QR code, two module rows per line (`▀`). With `ansi` every
/// cell gets explicit black/white colours, so the code reads the same on
/// dark and light themes. Without it, light modules are drawn as blocks,
/// which is right on the usual dark terminal background.
pub fn render(text: &str, ansi: bool) -> Result<String> {
    let code = QrCode::with_error_correction_level(text, EcLevel::L).context("encode the QR code")?;
    let width = code.width();
    let colors = code.to_colors();
    let size = width + 2 * QUIET_ZONE;
    let dark = |x: usize, y: usize| -> bool {
        let (Some(cx), Some(cy)) = (x.checked_sub(QUIET_ZONE), y.checked_sub(QUIET_ZONE)) else { return false };
        cx < width && cy < width && colors[cy * width + cx] == Color::Dark
    };
    let mut out = String::new();
    for y in (0..size).step_by(2) {
        let mut last = None;
        for x in 0..size {
            let (top, bottom) = (dark(x, y), dark(x, y + 1));
            if ansi {
                let pair = (if top { 30 } else { 97 }, if bottom { 40 } else { 107 });
                if last != Some(pair) {
                    out.push_str(&format!("\x1b[{};{}m", pair.0, pair.1));
                    last = Some(pair);
                }
                out.push('▀');
            } else {
                out.push(match (top, bottom) {
                    (false, false) => '█',
                    (false, true) => '▀',
                    (true, false) => '▄',
                    (true, true) => ' ',
                });
            }
        }
        if ansi {
            out.push_str("\x1b[0m");
        }
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same string is parsed in `web/src/__tests__/lib/connect-link.test.ts`.
    #[test]
    fn link_matches_url_search_params() {
        let urls = ["http://192.168.1.5:4082".to_string(), "http://10.0.0.2:4082".to_string()];
        assert_eq!(connect_link(&urls, "a b+c/=é~"), "openagentd://connect?url=http%3A%2F%2F192.168.1.5%3A4082&url=http%3A%2F%2F10.0.0.2%3A4082&key=a+b%2Bc%2F%3D%C3%A9%7E");
    }

    #[test]
    fn link_keeps_at_most_eight_urls() {
        let urls: Vec<String> = (0..12).map(|i| format!("http://10.0.0.{i}:4082")).collect();
        assert_eq!(connect_link(&urls, "k").matches("url=").count(), 8);
    }

    fn strip_ansi(s: &str) -> String {
        let mut out = String::new();
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c == '\x1b' {
                for e in chars.by_ref() {
                    if e == 'm' {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    #[test]
    fn render_is_a_square_of_half_blocks() {
        let link = connect_link(&["http://192.168.1.5:4082".into()], "0123456789abcdef0123456789abcdef");
        let width = QrCode::with_error_correction_level(&link, EcLevel::L).unwrap().width();
        let size = width + 2 * QUIET_ZONE;
        for ansi in [false, true] {
            let text = render(&link, ansi).unwrap();
            assert_eq!(text.contains('\x1b'), ansi);
            let plain = strip_ansi(&text);
            let lines: Vec<&str> = plain.lines().collect();
            assert_eq!(lines.len(), size.div_ceil(2));
            assert!(lines.iter().all(|l| l.chars().count() == size), "ragged lines");
        }
        // The quiet zone is light: plain mode draws its top row as full blocks.
        let plain = render(&link, false).unwrap();
        assert!(plain.lines().next().unwrap().chars().all(|c| c == '█'));
    }
}
