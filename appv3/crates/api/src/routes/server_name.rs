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
//! decide trust (the device key is). The rule is the cloud client's
//! (`openagentd_cloud::names`), so the account accepts every name kept here.
//! A signed-in computer also tells the account its new name, in the
//! background ([`crate::cloud::push_own_name`]).

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
pub const NAME_MAX_CHARS: usize = openagentd_cloud::names::NAME_MAX_CHARS;

pub fn router() -> Router<AppState> {
    Router::new().route("/name", get(get_name).put(put_name))
}

/// One line of plain text: no control or text-direction characters, single
/// spaces, at most [`NAME_MAX_CHARS`]. `None` when nothing is left.
pub fn clean_name(raw: &str) -> Option<String> {
    openagentd_cloud::names::clean(raw)
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

/// The name in use: the one someone gave, else the host name. `None` when
/// the computer has neither (or its settings cannot be read and it has no
/// host name).
pub fn current_name() -> Option<String> {
    let custom = rs::load_runtime_settings().ok().and_then(|cfg| cfg.computer_name.as_deref().and_then(clean_name));
    custom.or_else(|| hostname().as_deref().and_then(host_label))
}

async fn get_name() -> ApiResult<Response> {
    let cfg = rs::load_runtime_settings().map_err(ApiError::internal)?;
    Ok(json(body(cfg.computer_name.as_deref().and_then(clean_name))))
}

/// `{name}`; an empty name gives the computer its host name back.
async fn put_name(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let name = v.get("name").and_then(|n| n.as_str()).ok_or_else(|| ApiError::unprocessable("name must be a string"))?;
    let custom = clean_name(name);
    store_custom_name(custom.clone()).map_err(ApiError::internal)?;
    // The account keeps the name too; the cloud never fails a rename here.
    tokio::spawn(crate::cloud::push_own_name());
    Ok(json(body(custom)))
}

/// Keeps `custom` as this computer's own name (`None`: use the host name).
pub fn store_custom_name(custom: Option<String>) -> anyhow::Result<()> {
    let mut cfg = rs::load_runtime_settings()?;
    cfg.computer_name = custom;
    rs::save_runtime_settings(&cfg)?;
    Ok(())
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
