//! `/api/cloud/*`: this server's OpenAgentd Cloud account. Separate from
//! `/api/auth/*`, which is model-provider sign-in.
//!
//! Anyone who may use the API can read the status. Everything else (signing
//! in or out, the recovery step, and the signer routes: devices, pending
//! requests, approving, removing) only answers the machine itself: an
//! unproxied loopback caller on the private listener, never a relayed
//! device or a LAN client.

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
        .route("/recovery", post(recovery))
        .route("/devices", get(devices))
        .route("/devices/remove", post(remove_device))
        .route("/pending", get(pending))
        .route("/approve/begin", post(approve_begin))
        .route("/approve/confirm", post(approve_confirm))
        .route("/approve/reject", post(approve_reject))
}

/// The roles a computer asks for when it signs in or joins (spec 4):
/// `{ "server": bool, "client": bool }`, both on when absent.
#[derive(serde::Deserialize, Default)]
struct RolesBody {
    server: Option<bool>,
    client: Option<bool>,
}

impl RolesBody {
    fn roles(&self) -> ApiResult<openagentd_cloud::keys::Roles> {
        let roles = openagentd_cloud::keys::Roles { server: self.server.unwrap_or(true), client: self.client.unwrap_or(true) };
        if roles.is_valid() {
            Ok(roles)
        } else {
            Err(ApiError::new(400, "Choose at least one: use as server, or use as client."))
        }
    }
}

/// A small JSON body, or the default for an empty one.
fn body_or_default<T: serde::de::DeserializeOwned + Default>(body: &[u8]) -> ApiResult<T> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    if body.len() > 4096 {
        return Err(ApiError::new(400, "Request too large."));
    }
    serde_json::from_slice(body).map_err(|_| ApiError::new(400, "Malformed request."))
}

fn body_of<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    if body.len() > 4096 {
        return Err(ApiError::new(400, "Request too large."));
    }
    serde_json::from_slice(body).map_err(|_| ApiError::new(400, "Malformed request."))
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
            // The recovery code is for the person at this computer only.
            "recovery" => o.retain(|k, _| k == "state"),
            "joining" => {
                o.remove("code");
            }
            _ => {}
        }
    }
}

async fn login(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    local_only(&ext)?;
    let roles = body_or_default::<RolesBody>(&body)?.roles()?;
    super::begin_sign_in(roles);
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
        #[serde(flatten)]
        roles: RolesBody,
    }
    if body.len() > MAX_LINK + 64 {
        return Err(ApiError::new(400, "That is not an invitation link."));
    }
    let parsed: Body = serde_json::from_slice(&body).map_err(|_| ApiError::new(400, "That is not an invitation link."))?;
    let roles = parsed.roles.roles()?;
    let link = zeroize::Zeroizing::new(parsed.link);
    if link.len() > MAX_LINK {
        return Err(ApiError::new(400, "That is not an invitation link."));
    }
    super::begin_join(link, roles).map_err(|_| ApiError::new(400, "That is not an invitation link."))?;
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

/// `{ "first": "ABCD", "second": "EFGH" }`: two groups of the recovery
/// code typed back. Creates the account with this computer as its first
/// device.
async fn recovery(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    local_only(&ext)?;
    #[derive(serde::Deserialize)]
    struct Body {
        first: String,
        second: String,
    }
    let b: Body = body_of(&body)?;
    match super::confirm_recovery(&b.first, &b.second).await {
        Ok(_) => status_json(),
        Err(super::RecoveryError::NotAsked) => Err(ApiError::new(409, "Sign in again to set up the account.")),
        Err(super::RecoveryError::Mismatch { first, second }) => Err(ApiError::new(400, format!("Those are not groups {first} and {second}. Check the code you saved."))),
        Err(super::RecoveryError::Failed(e)) => Err(signer_error(super::signer::SignerError::Flow(e))),
    }
}

/// What a signer route's failure says to the person.
fn signer_error(e: super::signer::SignerError) -> ApiError {
    use super::signer::SignerError;
    use openagentd_cloud::flows::FlowError;
    match e {
        SignerError::NotSignedIn => ApiError::new(409, "This computer is not signed in."),
        SignerError::NoApproval => ApiError::new(409, "Start the approval again."),
        SignerError::Flow(f) => {
            tracing::info!("cloud_signer_route_failed reason={}", super::engine::reason(&f));
            match f {
                FlowError::NotSigner => ApiError::new(403, "This computer cannot approve devices."),
                FlowError::Roles => ApiError::new(400, "A device can only get the roles it asked for, and needs at least one."),
                FlowError::JoinEnded | FlowError::TimedOut => ApiError::new(409, "The request was cancelled or expired."),
                FlowError::CommitMismatch => ApiError::new(409, "Request cancelled. If you didn't start it, someone may be trying to join your account."),
                FlowError::Roster(rule) => ApiError::new(502, format!("The account's device list failed a check ({rule}). Nothing was changed.")),
                FlowError::Problem(_) => ApiError::new(409, "Your account is not available right now."),
                FlowError::Api(a) if a.status == 0 => ApiError::new(502, "No connection to OpenAgentd. Check your network."),
                FlowError::Api(a) => ApiError::new(502, format!("OpenAgentd answered {} ({}).", a.status, a.code)),
                other => ApiError::new(502, other.to_string()),
            }
        }
    }
}

fn json_of<T: serde::Serialize>(v: &T) -> ApiResult<Response> {
    Ok(json(serde_json::to_value(v).map_err(ApiError::internal)?))
}

async fn devices(ext: Extensions) -> ApiResult<Response> {
    local_only(&ext)?;
    json_of(&super::signer::devices().await.map_err(signer_error)?)
}

async fn pending(ext: Extensions) -> ApiResult<Response> {
    local_only(&ext)?;
    json_of(&super::signer::pending().await.map_err(signer_error)?)
}

#[derive(serde::Deserialize)]
struct EnrollmentBody {
    enrollment_id: String,
}

fn enrollment_id(body: &[u8]) -> ApiResult<String> {
    let b: EnrollmentBody = body_of(body)?;
    // Ids go into a URL path: the shape is checked before anything else.
    if !openagentd_cloud::api::valid_enrollment_id(&b.enrollment_id) {
        return Err(ApiError::new(400, "Malformed request."));
    }
    Ok(b.enrollment_id)
}

async fn approve_begin(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    local_only(&ext)?;
    let id = enrollment_id(&body)?;
    json_of(&super::signer::approve_begin(&id).await.map_err(signer_error)?)
}

/// `{ enrollment_id, signer, server, client }`: the codes matched and the
/// person approved (in the desktop app, after Touch ID where available).
async fn approve_confirm(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    local_only(&ext)?;
    #[derive(serde::Deserialize)]
    struct Body {
        enrollment_id: String,
        signer: bool,
        server: bool,
        client: bool,
    }
    let b: Body = body_of(&body)?;
    if !openagentd_cloud::api::valid_enrollment_id(&b.enrollment_id) {
        return Err(ApiError::new(400, "Malformed request."));
    }
    super::signer::approve_confirm(&b.enrollment_id, super::signer::grant(b.signer, b.server, b.client)).await.map_err(signer_error)?;
    status_json()
}

async fn approve_reject(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    local_only(&ext)?;
    let id = enrollment_id(&body)?;
    super::signer::approve_reject(&id).await.map_err(signer_error)?;
    status_json()
}

async fn remove_device(ext: Extensions, body: axum::body::Bytes) -> ApiResult<Response> {
    local_only(&ext)?;
    #[derive(serde::Deserialize)]
    struct Body {
        device_id: String,
    }
    let b: Body = body_of(&body)?;
    if !openagentd_cloud::keys::is_device_id(&b.device_id) {
        return Err(ApiError::new(400, "Malformed request."));
    }
    super::signer::remove(&b.device_id).await.map_err(signer_error)?;
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
        let connected = Status::Connected { fingerprint: "3F9A".into(), signer: false, server: true, client: true, relay: RelayState::Online, sessions: 1 };
        assert_eq!(seen(connected.clone(), false), serde_json::to_value(connected).unwrap());
        // The recovery code never leaves this computer.
        let recovery = Status::Recovery { code: "AAAA-BBBB".into(), check: [1, 2] };
        assert_eq!(seen(recovery.clone(), true)["code"], "AAAA-BBBB");
        assert_eq!(seen(recovery, false), serde_json::json!({"state": "recovery"}));
    }

    #[test]
    fn roles_default_to_both_and_need_one() {
        use super::RolesBody;
        use openagentd_cloud::keys::Roles;
        assert_eq!(RolesBody::default().roles().unwrap(), Roles::BOTH);
        assert_eq!(RolesBody { server: Some(false), client: None }.roles().unwrap(), Roles::CLIENT);
        assert!(RolesBody { server: Some(false), client: Some(false) }.roles().is_err());
    }
}
