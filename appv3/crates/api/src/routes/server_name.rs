//! `GET|PUT /api/server/name`: what this computer is called in the apps'
//! lists (v3 only; `api.server_name` in the health capabilities).
//!
//! The name starts as the computer's host name and is changed from any
//! client that may use the server, like its other settings. An app reads it
//! over its own connection to the server and remembers it per computer, so
//! the account service never sees it.
//!
//! It is text a computer says about itself: capped, stripped of control
//! and text-direction characters, shown as plain text, and never used to
//! decide trust (the device key is).

use crate::error::{ApiError, ApiResult};
use crate::util::{body_value, json};
use crate::AppState;
use appv3_core::runtime_settings as rs;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use serde_json::json as j;

/// The longest name kept, in characters.
pub const NAME_MAX_CHARS: usize = 40;

pub fn router() -> Router<AppState> {
    Router::new().route("/name", get(get_name).put(put_name))
}

/// Characters that change the direction of the text after them. An app
/// shows a key right after a name, and a name must not reorder it.
fn is_direction_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// One line of plain text: no control or text-direction characters, single
/// spaces, at most [`NAME_MAX_CHARS`]. `None` when nothing is left.
pub fn clean_name(raw: &str) -> Option<String> {
    let raw: String = raw.chars().filter(|c| !is_direction_control(*c)).collect();
    let words: Vec<&str> = raw.split(|c: char| c.is_whitespace() || c.is_control()).filter(|w| !w.is_empty()).collect();
    let name: String = words.join(" ").chars().take(NAME_MAX_CHARS).collect();
    let name = name.trim_end().to_string();
    (!name.is_empty()).then_some(name)
}

/// The host name without its domain ("studio-mini", not "studio-mini.local").
fn host_label(hostname: &str) -> Option<String> {
    clean_name(hostname.split('.').next().unwrap_or_default())
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer outlives the call and its length is passed with it.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

#[cfg(windows)]
fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

fn body(custom: Option<String>) -> serde_json::Value {
    let default = hostname().as_deref().and_then(host_label);
    j!({"name": custom.clone().or_else(|| default.clone()), "default": default, "custom": custom.is_some()})
}

async fn get_name() -> ApiResult<Response> {
    let cfg = rs::load_runtime_settings().map_err(ApiError::internal)?;
    Ok(json(body(cfg.computer_name.as_deref().and_then(clean_name))))
}

/// `{name}`; an empty name gives the computer its host name back.
async fn put_name(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let name = v.get("name").and_then(|n| n.as_str()).ok_or_else(|| ApiError::unprocessable("name must be a string"))?;
    let mut cfg = rs::load_runtime_settings().map_err(ApiError::internal)?;
    cfg.computer_name = clean_name(name);
    rs::save_runtime_settings(&cfg).map_err(ApiError::internal)?;
    Ok(json(body(cfg.computer_name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_one_short_line_of_plain_text() {
        assert_eq!(clean_name("  Work  ").as_deref(), Some("Work"));
        assert_eq!(clean_name("Work\n\tMac\u{7}mini").as_deref(), Some("Work Mac mini"));
        assert_eq!(clean_name("\u{202e}evil\u{2066}").as_deref(), Some("evil"), "a name cannot reorder the key shown after it");
        assert_eq!(clean_name("\u{200f}\u{202a}"), None);
        assert_eq!(clean_name("مكتب").as_deref(), Some("مكتب"), "right-to-left text itself is a name");
        assert_eq!(clean_name(" \n "), None);
        assert_eq!(clean_name(&"é".repeat(100)).unwrap().chars().count(), NAME_MAX_CHARS);
        assert_eq!(clean_name(&format!("{} tail", "x".repeat(39))).as_deref(), Some("x".repeat(39).as_str()), "no trailing space after the cut");
    }

    #[test]
    fn the_default_is_the_host_name_without_its_domain() {
        assert_eq!(host_label("studio-mini.local").as_deref(), Some("studio-mini"));
        assert_eq!(host_label("build-box").as_deref(), Some("build-box"));
        assert_eq!(host_label(""), None);
    }
}
