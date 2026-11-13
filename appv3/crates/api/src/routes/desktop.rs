//! Desktop-shell control routes. Every handler answers 404 unless the
//! caller is the desktop shell itself: a desktop session, authenticated with
//! the desktop token (not the LAN access key), from a loopback peer on the
//! sidecar's private listener.

use crate::error::{ApiError, ApiResult};
use crate::middleware::{AuthenticatedBy, ConnInfo};
use crate::network_access::{self, Controller};
use crate::util::json;
use crate::AppState;
use axum::extract::ConnectInfo;
use axum::http::Extensions;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

pub fn router() -> Router<AppState> {
    Router::new().route("/network-access", get(status).put(apply)).route("/update-request", get(update_request).put(update_result))
}

fn desktop_controller(ext: &Extensions) -> ApiResult<&'static Controller> {
    let not_found = || ApiError::not_found("Not Found");
    let c = network_access::controller().ok_or_else(not_found)?;
    if !appv3_core::auth::is_desktop_session() || ext.get::<AuthenticatedBy>() != Some(&AuthenticatedBy::DesktopToken) {
        return Err(not_found());
    }
    let conn = ext.get::<ConnectInfo<ConnInfo>>().map(|c| c.0).ok_or_else(not_found)?;
    let loopback_peer = conn.remote.is_some_and(|a| a.ip().to_canonical().is_loopback());
    let private_listener = conn.local.is_some_and(|a| a.port() == c.private_port());
    if !loopback_peer || !private_listener {
        tracing::warn!("desktop_control_rejected remote={:?} local={:?}", conn.remote, conn.local);
        return Err(not_found());
    }
    Ok(c)
}

async fn status(ext: Extensions) -> ApiResult<Response> {
    let c = desktop_controller(&ext)?;
    Ok(json(serde_json::to_value(c.status().await).map_err(ApiError::internal)?))
}

#[derive(Deserialize)]
struct ApplyBody {
    enabled: bool,
    port: u16,
    #[serde(default)]
    access_key: String,
}

/// Shape rules for a LAN access key; generated keys are 43 characters.
pub fn validate_access_key(key: &str) -> Result<(), &'static str> {
    let len = key.chars().count();
    if len < 16 {
        return Err("The access key must be at least 16 characters.");
    }
    if len > 512 {
        return Err("The access key must be at most 512 characters.");
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The access key cannot contain spaces or control characters.");
    }
    Ok(())
}

async fn apply(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    let c = desktop_controller(&ext)?;
    let body: ApplyBody = serde_json::from_slice(&body).map_err(|e| ApiError::unprocessable(format!("Invalid request body: {e}")))?;
    if body.port == 0 || body.port == c.private_port() {
        return Err(ApiError::unprocessable("Choose another port."));
    }
    let key = if body.enabled {
        let key = body.access_key.trim().to_string();
        validate_access_key(&key).map_err(ApiError::unprocessable)?;
        Some(key)
    } else {
        None
    };
    let s = c.apply(body.enabled, body.port, key).await;
    Ok(json(serde_json::to_value(s).map_err(ApiError::internal)?))
}

/// The update another device asked this computer's app to install, handed
/// over once (`routes::server_update`): `{request: {target, started_at}}`,
/// or `{request: null}`.
async fn update_request(ext: Extensions) -> ApiResult<Response> {
    desktop_controller(&ext)?;
    Ok(json(serde_json::json!({"request": super::server_update::take_desktop_request()})))
}

#[derive(Deserialize)]
struct UpdateResult {
    ok: bool,
    #[serde(default)]
    message: String,
}

/// How the app's update went, for the device that asked.
async fn update_result(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    desktop_controller(&ext)?;
    let body: UpdateResult = serde_json::from_slice(&body).map_err(|e| ApiError::unprocessable(format!("Invalid request body: {e}")))?;
    let recorded = super::server_update::finish_desktop_update(body.ok, &body.message);
    Ok(json(serde_json::json!({"recorded": recorded})))
}

#[cfg(test)]
mod tests {
    use super::validate_access_key;

    #[test]
    fn access_key_shape() {
        assert!(validate_access_key(&"a".repeat(16)).is_ok());
        assert!(validate_access_key(&"a".repeat(15)).is_err());
        assert!(validate_access_key(&"a".repeat(513)).is_err());
        assert!(validate_access_key("aaaaaaaa aaaaaaaa").is_err());
        assert!(validate_access_key("aaaaaaaa\taaaaaaaa").is_err());
        assert!(validate_access_key("oKffFTEMoFrCAdyNwZYnThXkVdzMKmI9lMpsR2nfB4o").is_ok());
    }
}
