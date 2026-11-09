//! `/api/cloud/*`: this server's OpenAgentd Cloud account. Separate from
//! `/api/auth/*`, which is model-provider sign-in.
//!
//! Anyone who may use the API can read the status. Signing in or out only
//! answers the machine itself: an unproxied loopback caller on the private
//! listener, never a relayed device or a LAN client.

use axum::extract::ConnectInfo;
use axum::http::Extensions;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;

use crate::error::{ApiError, ApiResult};
use crate::middleware::{ConnInfo, Peer, RelayPeer};
use crate::util::json;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", get(status))
        .route("/login", post(login))
        .route("/login/cancel", post(cancel))
        .route("/join", post(join))
        .route("/logout", post(logout))
        .route("/reload", post(reload))
}

/// Whether the caller is this machine's own user: not relayed, not
/// proxied, a loopback peer on the private listener.
pub fn is_local_caller(ext: &Extensions) -> bool {
    if ext.get::<RelayPeer>().is_some() {
        return false;
    }
    if ext.get::<Peer>().is_some_and(|p| p.proxied) {
        return false;
    }
    let Some(conn) = ext.get::<ConnectInfo<ConnInfo>>().map(|c| c.0) else { return false };
    let loopback = conn.remote.is_some_and(|a| a.ip().to_canonical().is_loopback());
    // Before `install` (no server listening yet) nothing is local.
    let private = super::private_port().is_some_and(|p| conn.local.is_some_and(|a| a.port() == p));
    loopback && private
}

fn local_only(ext: &Extensions) -> ApiResult<()> {
    if is_local_caller(ext) {
        Ok(())
    } else {
        tracing::warn!("cloud_account_route_refused relayed={}", ext.get::<RelayPeer>().is_some());
        Err(ApiError::new(403, "Only this computer can change its account."))
    }
}

fn status_json() -> ApiResult<Response> {
    Ok(json(serde_json::to_value(super::status()).map_err(ApiError::internal)?))
}

/// Anyone who may use the API sees the state; only this computer sees a
/// sign-in code in progress (it would let another device finish it) or
/// the 6-digit code of a join (a relayed device must not read it off).
async fn status(ext: Extensions) -> ApiResult<Response> {
    let mut v = serde_json::to_value(super::status()).map_err(ApiError::internal)?;
    redact_for_remote(&mut v, is_local_caller(&ext));
    Ok(json(v))
}

fn redact_for_remote(v: &mut serde_json::Value, local: bool) {
    if local {
        return;
    }
    let state = v["state"].as_str().unwrap_or_default().to_string();
    if let Some(o) = v.as_object_mut() {
        match state.as_str() {
            "signing_in" => o.retain(|k, _| k == "state" || k == "fingerprint"),
            "joining" => {
                o.remove("code");
            }
            _ => {}
        }
    }
}

async fn login(ext: Extensions) -> ApiResult<Response> {
    local_only(&ext)?;
    super::begin_sign_in();
    // The first answer (the user code) usually arrives within a second.
    for _ in 0..30 {
        if !matches!(super::status(), super::Status::Guest { .. }) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    status_json()
}

/// Longest invitation link accepted (the real ones are about 150 bytes).
const MAX_LINK: usize = 512;

/// Joins by invitation link, `{ "link": "agentd://invite?…" }`. The link is
/// a bearer secret: it is held only for the claim, and never logged.
async fn join(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    local_only(&ext)?;
    #[derive(serde::Deserialize)]
    struct Body {
        link: String,
    }
    if body.len() > MAX_LINK + 64 {
        return Err(ApiError::new(400, "That is not an invitation link."));
    }
    let parsed: Body = serde_json::from_slice(&body).map_err(|_| ApiError::new(400, "That is not an invitation link."))?;
    let link = zeroize::Zeroizing::new(parsed.link);
    if link.len() > MAX_LINK {
        return Err(ApiError::new(400, "That is not an invitation link."));
    }
    super::begin_join(link).map_err(|_| ApiError::new(400, "That is not an invitation link."))?;
    // The claim usually answers within a second.
    for _ in 0..30 {
        if !matches!(super::status(), super::Status::Guest { .. }) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    status_json()
}

async fn cancel(ext: Extensions) -> ApiResult<Response> {
    local_only(&ext)?;
    super::cancel_sign_in();
    status_json()
}

async fn logout(ext: Extensions) -> ApiResult<Response> {
    local_only(&ext)?;
    super::sign_out().await;
    status_json()
}

async fn reload(ext: Extensions) -> ApiResult<Response> {
    local_only(&ext)?;
    super::reload().await;
    status_json()
}

#[cfg(test)]
mod tests {
    use super::super::{RelayState, Status};
    use super::redact_for_remote;

    fn seen(s: Status, local: bool) -> serde_json::Value {
        let mut v = serde_json::to_value(s).unwrap();
        redact_for_remote(&mut v, local);
        v
    }

    #[test]
    fn a_remote_caller_never_sees_a_code() {
        let joining = || Status::Joining { fingerprint: "3F9A 21C4".into(), code: Some("123456".into()) };
        assert_eq!(seen(joining(), true)["code"], "123456");
        let v = seen(joining(), false);
        assert!(v.get("code").is_none(), "{v}");
        assert_eq!((v["state"].as_str(), v["fingerprint"].as_str()), (Some("joining"), Some("3F9A 21C4")));
        let signing =
            Status::SigningIn { user_code: "ABCD-EFGH".into(), url: "https://account.openagentd.dev/device?code=ABCD-EFGH".into(), fingerprint: "3F9A".into(), expires_in: 600 };
        let v = seen(signing, false);
        assert!(v.get("user_code").is_none() && v.get("url").is_none(), "{v}");
        // Other states are unchanged.
        let connected = Status::Connected { fingerprint: "3F9A".into(), signer: false, relay: RelayState::Online, sessions: 1 };
        assert_eq!(seen(connected.clone(), false), serde_json::to_value(connected).unwrap());
    }
}
