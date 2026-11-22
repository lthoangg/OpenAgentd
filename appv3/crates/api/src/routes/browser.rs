//! `/api/browser`: the sites the agent may use in the Preview tab.
//!
//! Settings → Browser reads and replaces the rules; the card the agent's
//! `preview` tool opens adds to them. The rules and their meaning are in
//! `appv3_agent::site_access`.

use crate::error::{ApiError, ApiResult};
use crate::util::json;
use crate::AppState;
use appv3_agent::site_access::{self, SiteRules};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new().route("/sites", get(read_sites).put(write_sites))
}

fn rules_json(rules: &SiteRules) -> Response {
    json(json!({"default": rules.default, "allowed": rules.allowed, "blocked": rules.blocked}))
}

async fn read_sites() -> ApiResult<Response> {
    Ok(rules_json(&site_access::store().read()))
}

/// Replace the rules. Entries are normalized (a pasted URL becomes its
/// host); one that is not a site refuses the whole change.
async fn write_sites(body: Bytes) -> ApiResult<Response> {
    let rules: SiteRules = serde_json::from_slice(&body).map_err(|e| ApiError::unprocessable(format!("Invalid site rules: {e}")))?;
    let rules = rules.checked().map_err(ApiError::unprocessable)?;
    site_access::store().write(&rules).map_err(ApiError::internal)?;
    Ok(rules_json(&rules))
}
