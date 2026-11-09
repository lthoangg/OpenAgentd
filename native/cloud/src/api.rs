//! The cloud's device API: device code sign-in, enrollment, signed
//! requests, the roster, relay tokens and the mailbox.
//!
//! Credentials (enrollment sessions, relay tokens, nonces) are held in
//! [`Secret`], which never prints, and are never written anywhere.

use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::account_state::{self, AccountProblem};
use crate::encoding::b64;
use crate::endpoints::{valid_user_code, Endpoints};
use crate::keys::DeviceKeys;
use crate::lines;

/// A credential string. `Debug` and `Display` never show it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Secret(Zeroizing::new(s.into()))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

/// An error answer from the cloud, or a transport failure (`status` 0).
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: u16,
    /// The stable snake_case code (`account_closing`, `rate_limited`, …), or
    /// `network` / `bad_response` for failures before an answer.
    pub code: String,
    pub body: Option<Value>,
    /// `Retry-After`, in seconds.
    pub retry_after: Option<u64>,
}

impl ApiError {
    fn network(e: &reqwest::Error) -> Self {
        // reqwest's message names the URL, never a header or body.
        let _ = e;
        ApiError { status: 0, code: "network".into(), body: None, retry_after: None }
    }

    fn bad_response() -> Self {
        ApiError { status: 0, code: "bad_response".into(), body: None, retry_after: None }
    }

    /// The account problem this error names, if any.
    pub fn problem(&self) -> Option<AccountProblem> {
        account_state::from_error(&self.code, self.body.as_ref())
    }

    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.status == 0 {
            write!(f, "cloud unreachable ({})", self.code)
        } else {
            write!(f, "cloud answered {} {}", self.status, self.code)
        }
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

/// What the device shows while the person approves the device code.
#[derive(Clone)]
pub struct DeviceCode {
    pub device_code: Secret,
    pub user_code: String,
    /// The page to open: the pinned account host and the checked user code.
    pub url: String,
    pub fingerprint: String,
    pub expires_in: u64,
    pub interval: u64,
}

impl fmt::Debug for DeviceCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceCode({}, {})", self.user_code, self.fingerprint)
    }
}

/// One poll of `/v1/device/token`.
#[derive(Debug, Clone, PartialEq)]
pub enum TokenPoll {
    /// Approved: a single-use enrollment session for this device.
    Session {
        session: Secret,
        account_id: String,
    },
    /// Not yet (a slow approval, or a person on the waitlist, who cannot
    /// approve until the account opens).
    Pending,
    /// Poll more slowly.
    SlowDown,
    Denied,
    /// The code expired before it was approved.
    Expired,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Pending {
    pub enrollment_id: String,
    pub device_id: String,
    pub auth_pub: Option<String>,
    pub pubs: String,
    pub commit: Option<String>,
    pub n_a: Option<String>,
    pub n_a_by: Option<String>,
    pub n_n: Option<String>,
    pub country: Option<String>,
    pub created_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub invite_slot: Option<String>,
    pub proof: Option<String>,
    /// The joining device's self-reported kind (spec section 7).
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RosterHead {
    pub version: u64,
    pub blob: String,
    pub revocation_floor: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device_id: String,
    pub signer: bool,
    pub added_at: Option<u64>,
    pub revoked_at: Option<u64>,
    /// The self-reported kind, or `None` when the device declared none.
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Letter {
    pub id: String,
    pub kind: String,
    pub from: String,
    pub sealed: String,
    pub created_at: Option<u64>,
}

/// An open invitation's slot (API section 8). Not a secret.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct InviteSlot {
    pub slot_id: String,
    pub expires_at: u64,
}

/// What a device that claimed an invitation reads about it.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct InviteStatus {
    /// `waiting` or `added`.
    pub status: String,
    #[serde(default)]
    pub roster_version: Option<u64>,
    /// b64 of the signer's `confirm`, once posted.
    #[serde(default)]
    pub confirm: Option<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
}

/// Slot ids go into URL paths: only the cloud's id alphabet.
pub fn valid_slot_id(s: &str) -> bool {
    (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Enrollment ids go into URL paths and into `lines(...)` (the 6-digit
/// code): the same rule as slot ids.
pub fn valid_enrollment_id(s: &str) -> bool {
    valid_slot_id(s)
}

/// Nonces go into a header and into `lines(...)`: the token alphabet
/// (base64url and `.`), of a bounded length.
pub fn valid_nonce(s: &str) -> bool {
    (1..=1024).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// Largest response body read from the cloud.
pub const MAX_BODY: usize = 1024 * 1024;

/// Reads a response body, refusing one larger than [`MAX_BODY`] before
/// holding more than that in memory.
pub async fn read_body(mut resp: reqwest::Response) -> ApiResult<Vec<u8>> {
    if resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err(ApiError::bad_response());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| ApiError::network(&e))? {
        if out.len() + chunk.len() > MAX_BODY {
            return Err(ApiError::bad_response());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// A relay token and when to stop using it.
#[derive(Debug, Clone)]
pub struct RelayToken {
    pub token: Secret,
    pub expires_in: u64,
    pub roster_version: u64,
}

/// The device kind the cloud shows beside the fingerprint.
pub fn this_kind() -> Option<&'static str> {
    if cfg!(target_os = "ios") {
        Some("ios")
    } else if cfg!(target_os = "android") {
        Some("android")
    } else if cfg!(target_os = "macos") {
        Some("macos")
    } else if cfg!(target_os = "windows") {
        Some("windows")
    } else if cfg!(target_os = "linux") {
        Some("linux")
    } else {
        None
    }
}

/// A device's connection to the cloud.
pub struct Cloud {
    http: reqwest::Client,
    pub endpoints: Endpoints,
    pub keys: DeviceKeys,
    /// Set once the device knows its account.
    pub account_id: Option<String>,
    nonce: Mutex<Option<Secret>>,
}

impl fmt::Debug for Cloud {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Cloud({}, device {})", self.endpoints.api, self.keys.id())
    }
}

fn sha256_b64(data: &[u8]) -> String {
    b64(&Sha256::digest(data))
}

impl Cloud {
    pub fn new(http: reqwest::Client, endpoints: Endpoints, keys: DeviceKeys, account_id: Option<String>) -> Self {
        Cloud { http, endpoints, keys, account_id, nonce: Mutex::new(None) }
    }

    pub fn device_id(&self) -> String {
        self.keys.id()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoints.api, path)
    }

    async fn answer<T: DeserializeOwned>(resp: reqwest::Response) -> ApiResult<T> {
        let status = resp.status();
        let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
        let bytes = read_body(resp).await?;
        if status.is_success() {
            let body = if bytes.is_empty() { b"{}".as_slice() } else { &bytes };
            return serde_json::from_slice(body).map_err(|_| ApiError::bad_response());
        }
        let body: Option<Value> = serde_json::from_slice(&bytes).ok();
        let code = body.as_ref().and_then(|b| b.get("error")).and_then(|e| e.as_str()).unwrap_or("unknown").to_string();
        Err(ApiError { status: status.as_u16(), code, body, retry_after })
    }

    // ---- 1. Device code -------------------------------------------------

    /// Starts sign-in for this device's key.
    pub async fn device_code(&self) -> ApiResult<DeviceCode> {
        #[derive(Deserialize)]
        struct Raw {
            device_code: String,
            user_code: String,
            device_id: String,
            expires_in: u64,
            interval: u64,
        }
        let resp = self
            .http
            .post(self.url("/v1/device/code"))
            .form(&[("client_id", "agentd"), ("auth_pub", &b64(&self.keys.auth.public()))])
            .send()
            .await
            .map_err(|e| ApiError::network(&e))?;
        let raw: Raw = Self::answer(resp).await?;
        // The cloud must bind the code to this key, and the code we show
        // and open must be a well-formed one on the pinned host.
        if raw.device_id != self.device_id() || !valid_user_code(&raw.user_code) {
            return Err(ApiError::bad_response());
        }
        let url = self.endpoints.device_page(&raw.user_code).ok_or_else(ApiError::bad_response)?;
        Ok(DeviceCode {
            device_code: Secret::new(raw.device_code),
            user_code: raw.user_code,
            url,
            fingerprint: self.keys.fingerprint(),
            expires_in: raw.expires_in.min(3600),
            interval: raw.interval.clamp(1, 60),
        })
    }

    /// One poll for the device code's outcome.
    pub async fn device_token(&self, code: &DeviceCode) -> ApiResult<TokenPoll> {
        #[derive(Deserialize)]
        struct Raw {
            access_token: String,
            account_id: String,
        }
        let resp = self
            .http
            .post(self.url("/v1/device/token"))
            .form(&[("client_id", "agentd"), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"), ("device_code", code.device_code.expose())])
            .send()
            .await
            .map_err(|e| ApiError::network(&e))?;
        match Self::answer::<Raw>(resp).await {
            Ok(raw) => Ok(TokenPoll::Session { session: Secret::new(raw.access_token), account_id: raw.account_id }),
            Err(e) if e.status == 400 => match e.code.as_str() {
                "authorization_pending" => Ok(TokenPoll::Pending),
                "slow_down" => Ok(TokenPoll::SlowDown),
                "access_denied" => Ok(TokenPoll::Denied),
                "expired_token" | "invalid_grant" => Ok(TokenPoll::Expired),
                _ => Err(e),
            },
            Err(e) => Err(e),
        }
    }

    // ---- 2. Enrollment --------------------------------------------------

    async fn enroll<T: DeserializeOwned>(&self, path: &str, session: &Secret, body: Value) -> ApiResult<T> {
        let resp = self.http.post(self.url(path)).bearer_auth(session.expose()).json(&body).send().await.map_err(|e| ApiError::network(&e))?;
        Self::answer(resp).await
    }

    pub async fn enroll_genesis(&self, session: &Secret, recovery_pub: &[u8; 32], recovery_sig: &[u8; 64], roster_blob: &str) -> ApiResult<()> {
        let _: Value = self
            .enroll(
                "/v1/enroll/genesis",
                session,
                json!({
                    "device_id": self.device_id(),
                    "auth_pub": b64(&self.keys.auth.public()),
                    "recovery_pub": b64(recovery_pub),
                    "recovery_sig": b64(recovery_sig),
                    "version": 1,
                    "roster": roster_blob,
                    "kind": this_kind(),
                }),
            )
            .await?;
        Ok(())
    }

    /// Step 1 of commit-reveal. Returns the enrollment id.
    pub async fn enroll_pending(&self, session: &Secret, commit: &[u8; 32]) -> ApiResult<String> {
        #[derive(Deserialize)]
        struct Raw {
            enrollment_id: String,
        }
        let raw: Raw = self
            .enroll(
                "/v1/enroll/pending",
                session,
                json!({
                    "device_id": self.device_id(),
                    "auth_pub": b64(&self.keys.auth.public()),
                    "pubs": b64(&self.keys.pubs()),
                    "commit": b64(commit),
                    "kind": this_kind(),
                }),
            )
            .await?;
        if !valid_enrollment_id(&raw.enrollment_id) {
            return Err(ApiError::bad_response());
        }
        Ok(raw.enrollment_id)
    }

    /// Recovery: a roster signed by the recovery key that adds this device.
    pub async fn enroll_recover(&self, session: &Secret, base_version: u64, roster: &crate::roster::Roster, signature: &[u8; 64]) -> ApiResult<()> {
        let _: Value = self
            .enroll(
                "/v1/enroll/recover",
                session,
                json!({
                    "device_id": self.device_id(),
                    "auth_pub": b64(&self.keys.auth.public()),
                    "base_version": base_version,
                    "version": roster.version(),
                    "roster": roster.blob,
                    "signature": b64(signature),
                    "kind": this_kind(),
                }),
            )
            .await?;
        Ok(())
    }

    // ---- 3. Signed requests ---------------------------------------------

    fn account(&self) -> ApiResult<&str> {
        self.account_id.as_deref().ok_or_else(ApiError::bad_response)
    }

    async fn fresh_nonce(&self) -> ApiResult<Secret> {
        #[derive(Deserialize)]
        struct Raw {
            nonce: String,
        }
        let resp = self
            .http
            .post(self.url("/v1/auth/nonce"))
            .json(&json!({ "account_id": self.account()?, "device_id": self.device_id() }))
            .send()
            .await
            .map_err(|e| ApiError::network(&e))?;
        Ok(Secret::new(Self::answer::<Raw>(resp).await?.nonce))
    }

    async fn signed_once(&self, method: &Method, path: &str, body: &[u8]) -> ApiResult<reqwest::Response> {
        let held = self.nonce.lock().expect("nonce lock").take();
        let nonce = match held {
            Some(n) => n,
            None => self.fresh_nonce().await?,
        };
        // A nonce goes into `lines(...)`, which refuses a newline by panicking.
        if !valid_nonce(nonce.expose()) {
            return Err(ApiError::bad_response());
        }
        let account = self.account()?;
        let device = self.device_id();
        let message = lines!["agentd-cloud-request-v1", method.as_str(), path, account, &device, nonce.expose(), &sha256_b64(body)];
        let sig = self.keys.auth.sign(&message);
        let mut req = self
            .http
            .request(method.clone(), self.url(path))
            .header("X-Agentd-Account", account)
            .header("X-Agentd-Device", &device)
            .header("X-Agentd-Auth-Pub", b64(&self.keys.auth.public()))
            .header("X-Agentd-Nonce", nonce.expose())
            .header("X-Agentd-Signature", b64(&sig));
        if !body.is_empty() {
            req = req.header("Content-Type", "application/json").body(body.to_vec());
        }
        let resp = req.send().await.map_err(|e| ApiError::network(&e))?;
        if let Some(next) = resp.headers().get("x-agentd-next-nonce").and_then(|v| v.to_str().ok()) {
            *self.nonce.lock().expect("nonce lock") = Some(Secret::new(next));
        }
        Ok(resp)
    }

    /// A signed request. A `401` is retried once with a fresh nonce; nothing
    /// else is (a `403 device_revoked` is final).
    pub async fn signed<T: DeserializeOwned>(&self, method: Method, path: &str, body: Option<Value>) -> ApiResult<T> {
        let bytes = match &body {
            Some(b) => serde_json::to_vec(b).expect("JSON serializes"),
            None => Vec::new(),
        };
        let mut resp = self.signed_once(&method, path, &bytes).await?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            *self.nonce.lock().expect("nonce lock") = None;
            resp = self.signed_once(&method, path, &bytes).await?;
        }
        Self::answer(resp).await
    }

    // ---- Pending enrollments --------------------------------------------

    fn pending_path(enrollment_id: &str, tail: &str) -> ApiResult<String> {
        if !valid_enrollment_id(enrollment_id) {
            return Err(ApiError::bad_response());
        }
        Ok(format!("/v1/enroll/pending/{enrollment_id}{tail}"))
    }

    pub async fn pending(&self, enrollment_id: &str) -> ApiResult<Pending> {
        let p: Pending = self.signed(Method::GET, &Self::pending_path(enrollment_id, "")?, None).await?;
        if p.enrollment_id != enrollment_id {
            return Err(ApiError::bad_response());
        }
        Ok(p)
    }

    /// The account's pending requests. Entries whose enrollment id breaks
    /// the id rule are left out: they could not be approved or cancelled.
    pub async fn pending_list(&self) -> ApiResult<Vec<Pending>> {
        #[derive(Deserialize)]
        struct Raw {
            pending: Vec<Pending>,
        }
        let mut list = self.signed::<Raw>(Method::GET, "/v1/enroll/pending", None).await?.pending;
        list.retain(|p| valid_enrollment_id(&p.enrollment_id));
        Ok(list)
    }

    pub async fn post_n_a(&self, enrollment_id: &str, n_a: &[u8]) -> ApiResult<()> {
        let _: Value = self.signed(Method::POST, &Self::pending_path(enrollment_id, "/na")?, Some(json!({ "n_a": b64(n_a) }))).await?;
        Ok(())
    }

    pub async fn post_n_n(&self, enrollment_id: &str, n_n: &[u8]) -> ApiResult<()> {
        let _: Value = self.signed(Method::POST, &Self::pending_path(enrollment_id, "/nn")?, Some(json!({ "n_n": b64(n_n) }))).await?;
        Ok(())
    }

    pub async fn cancel_pending(&self, enrollment_id: &str) -> ApiResult<()> {
        let _: Value = self.signed(Method::DELETE, &Self::pending_path(enrollment_id, "")?, None).await?;
        Ok(())
    }

    // ---- 4. Roster and devices ------------------------------------------

    pub async fn roster(&self) -> ApiResult<RosterHead> {
        self.signed(Method::GET, "/v1/roster", None).await
    }

    pub async fn put_roster(&self, base_version: u64, next: &crate::roster::Roster) -> ApiResult<()> {
        let _: Value = self.signed(Method::PUT, "/v1/roster", Some(json!({ "base_version": base_version, "version": next.version(), "roster": next.blob }))).await?;
        Ok(())
    }

    pub async fn devices(&self) -> ApiResult<Vec<DeviceInfo>> {
        #[derive(Deserialize)]
        struct Raw {
            devices: Vec<DeviceInfo>,
        }
        Ok(self.signed::<Raw>(Method::GET, "/v1/devices", None).await?.devices)
    }

    pub async fn leave(&self) -> ApiResult<()> {
        let _: Value = self.signed(Method::POST, "/v1/devices/self/leave", Some(json!({}))).await?;
        Ok(())
    }

    // ---- 5. Relay tokens ------------------------------------------------

    pub async fn relay_token(&self) -> ApiResult<RelayToken> {
        #[derive(Deserialize)]
        struct Raw {
            token: String,
            expires_in: u64,
            roster_version: u64,
        }
        let raw: Raw = self.signed(Method::POST, "/v1/relay/token", Some(json!({}))).await?;
        Ok(RelayToken { token: Secret::new(raw.token), expires_in: raw.expires_in, roster_version: raw.roster_version })
    }

    // ---- 7. Mailbox and push --------------------------------------------

    pub async fn send_letter(&self, to: &str, kind: crate::letter::Kind, sealed: &[u8], collapse: Option<&str>) -> ApiResult<()> {
        let mut body = json!({ "kind": kind.as_str(), "sealed": b64(sealed) });
        if let Some(c) = collapse {
            body["collapse"] = json!(c);
        }
        let _: Value = self.signed(Method::POST, &format!("/v1/mailbox/{to}"), Some(body)).await?;
        Ok(())
    }

    pub async fn letters(&self) -> ApiResult<Vec<Letter>> {
        #[derive(Deserialize)]
        struct Raw {
            letters: Vec<Letter>,
        }
        Ok(self.signed::<Raw>(Method::GET, "/v1/mailbox", None).await?.letters)
    }

    pub async fn ack_letters(&self, ids: &[String]) -> ApiResult<()> {
        let _: Value = self.signed(Method::POST, "/v1/mailbox/ack", Some(json!({ "ids": ids }))).await?;
        Ok(())
    }

    /// Registers this device's push token (`{provider, token, environment}`).
    pub async fn register_push(&self, registration: Value) -> ApiResult<()> {
        let _: Value = self.signed(Method::POST, "/v1/push/register", Some(registration)).await?;
        Ok(())
    }

    // ---- 8. Invitations -------------------------------------------------

    fn slot_path(slot_id: &str, tail: &str) -> ApiResult<String> {
        if !valid_slot_id(slot_id) {
            return Err(ApiError::bad_response());
        }
        Ok(format!("/v1/invite/{slot_id}{tail}"))
    }

    /// Opens an invitation (signer). The secret never goes to the cloud.
    pub async fn invite_create(&self) -> ApiResult<InviteSlot> {
        let slot: InviteSlot = self.signed(Method::POST, "/v1/invite", Some(json!({}))).await?;
        if !valid_slot_id(&slot.slot_id) {
            return Err(ApiError::bad_response());
        }
        Ok(slot)
    }

    /// Claims an invitation with this device's own key (it is not in the
    /// account yet). Returns the enrollment id.
    pub async fn invite_claim(&self, slot_id: &str, proof: &[u8; 32]) -> ApiResult<String> {
        #[derive(Deserialize)]
        struct Raw {
            enrollment_id: String,
        }
        let path = Self::slot_path(slot_id, "/claim")?;
        let raw: Raw = self.signed(Method::POST, &path, Some(json!({ "pubs": b64(&self.keys.pubs()), "proof": b64(proof), "kind": this_kind() }))).await?;
        if !valid_enrollment_id(&raw.enrollment_id) {
            return Err(ApiError::bad_response());
        }
        Ok(raw.enrollment_id)
    }

    /// The invitation as the device that claimed it sees it.
    pub async fn invite_status(&self, slot_id: &str) -> ApiResult<InviteStatus> {
        self.signed(Method::GET, &Self::slot_path(slot_id, "")?, None).await
    }

    /// The signer's `confirm` for the device it added.
    pub async fn invite_confirm(&self, slot_id: &str, device_id: &str, confirm: &[u8; 32]) -> ApiResult<()> {
        let _: Value = self.signed(Method::POST, &Self::slot_path(slot_id, "/confirm")?, Some(json!({ "device_id": device_id, "confirm": b64(confirm) }))).await?;
        Ok(())
    }

    /// Cancels the invitation and its candidates (signer).
    pub async fn invite_cancel(&self, slot_id: &str) -> ApiResult<()> {
        let _: Value = self.signed(Method::DELETE, &Self::slot_path(slot_id, "")?, None).await?;
        Ok(())
    }
}

/// How long to wait before the next device-code poll.
pub fn next_interval(current: Duration, poll: &TokenPoll) -> Duration {
    match poll {
        TokenPoll::SlowDown => current + Duration::from_secs(5),
        _ => current,
    }
}
