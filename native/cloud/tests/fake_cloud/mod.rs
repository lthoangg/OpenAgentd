//! An in-process fake of the cloud's device API, enough to drive every
//! client flow. All data is synthetic and made per test. It checks request
//! signatures and rosters like the real cloud, so a client bug fails here.

#![allow(dead_code, clippy::result_large_err)]

pub mod proxy;
pub mod relay;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Form, Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use openagentd_cloud::encoding::{b64, from_b64, from_b64_array};
use openagentd_cloud::keys::{self, device_id, random_bytes};
use openagentd_cloud::lines;
use openagentd_cloud::roster::{self, Chain};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq)]
pub enum CodeStatus {
    Pending,
    Approved(String),
    Denied,
    Expired,
}

#[derive(Clone, Debug)]
pub struct DeviceCodeRow {
    pub user_code: String,
    pub device_id: String,
    pub status: CodeStatus,
    pub redeemed: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Account {
    pub roster: Option<String>,
    pub version: u64,
    /// device id → (auth_pub b64, active, signer)
    pub devices: HashMap<String, (String, bool, bool)>,
    pub pending: HashMap<String, Value>,
    /// An account-level error every device request gets (`account_closing`, …).
    pub problem: Option<(u16, Value)>,
    pub letters: Vec<Value>,
    /// Devices removed or departed, oldest first (the relay's recent list).
    pub revoked: Vec<String>,
    /// device id → declared kind.
    pub kinds: HashMap<String, String>,
}

#[derive(Default)]
pub struct Inner {
    pub codes: HashMap<String, DeviceCodeRow>,
    pub sessions: HashMap<String, (String, String, bool)>,
    pub nonces: HashMap<String, (String, String)>,
    pub accounts: HashMap<String, Account>,
    /// Rewrites the next pending object served (a malicious cloud).
    pub tamper_pending: Option<fn(&mut Value)>,
    pub signed_requests: usize,
    /// relay token → (account, device)
    pub tokens: HashMap<String, (String, String)>,
    /// slot id → invitation.
    pub invites: HashMap<String, InviteRow>,
    /// The usage view leaves `online` out (a cloud from before it existed).
    pub usage_without_online: bool,
    /// Answers the next device-code polls get instead of the real one:
    /// (status, error code, Retry-After seconds).
    pub token_failures: std::collections::VecDeque<(u16, &'static str, Option<u64>)>,
    /// Most pending enrollments per account (`too_many_pending` past it),
    /// as the cloud does with 3. `None`: no cap.
    pub pending_cap: Option<usize>,
    /// Relay tokens issued so far.
    pub relay_tokens_issued: usize,
    /// The server's own time for a relay token (the real one writes to the
    /// account's Durable Object).
    pub relay_token_delay: Option<std::time::Duration>,
}

#[derive(Clone, Debug, Default)]
pub struct InviteRow {
    pub account: String,
    pub used_by: Option<String>,
    pub used_version: Option<u64>,
    pub confirm: Option<String>,
}

/// Claims allowed per invitation, as in the cloud.
pub const INVITE_CANDIDATES: usize = 8;

#[derive(Clone, Default)]
pub struct Fake(pub Arc<Mutex<Inner>>, pub relay::Shared);

fn err(status: u16, code: &str) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(json!({ "error": code }))).into_response()
}

fn rand_id(n: usize) -> String {
    let bytes: [u8; 32] = random_bytes();
    b64(&bytes[..n])
}

impl Fake {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serves the fake on a random local port; returns its base URL.
    pub async fn serve(&self) -> String {
        let app = Router::new()
            .route("/v1/device/code", post(device_code))
            .route("/v1/device/token", post(device_token))
            .route("/v1/enroll/genesis", post(genesis))
            .route("/v1/enroll/pending", post(pending_create).get(pending_list))
            .route("/v1/enroll/pending/{id}", get(pending_get).delete(pending_delete))
            .route("/v1/enroll/pending/{id}/na", post(pending_na))
            .route("/v1/enroll/pending/{id}/nn", post(pending_nn))
            .route("/v1/auth/nonce", post(nonce))
            .route("/v1/roster", get(roster_get).put(roster_put))
            .route("/v1/devices", get(devices))
            .route("/v1/devices/self/leave", post(leave))
            .route("/v1/relay/token", post(relay_token))
            .route("/v1/relay/usage", get(relay_usage))
            .route("/v1/mailbox/{to}", post(mailbox_send))
            .route("/v1/mailbox", get(mailbox_get))
            .route("/v1/push/register", post(push_register))
            .route("/v1/invite", post(invite_create))
            .route("/v1/invite/{slot}", get(invite_get).delete(invite_delete))
            .route("/v1/invite/{slot}/claim", post(invite_claim))
            .route("/v1/invite/{slot}/confirm", post(invite_confirm))
            .route("/v1/relay/host/{host}/presence", get(relay::presence))
            .route("/v1/relay/host/{host}/data/{session}", get(relay::data))
            .with_state(self.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    pub fn new_account(&self) -> String {
        let id = rand_id(28);
        self.0.lock().unwrap().accounts.insert(id.clone(), Account::default());
        id
    }

    /// The person approves `user_code` for `account` on the account pages.
    pub fn approve(&self, user_code: &str, account: &str) {
        let mut s = self.0.lock().unwrap();
        let row = s.codes.values_mut().find(|r| r.user_code == user_code).expect("a code");
        row.status = CodeStatus::Approved(account.to_string());
    }

    pub fn set_code(&self, user_code: &str, status: CodeStatus) {
        let mut s = self.0.lock().unwrap();
        s.codes.values_mut().find(|r| r.user_code == user_code).expect("a code").status = status;
    }

    pub fn set_problem(&self, account: &str, problem: Option<(u16, Value)>) {
        self.0.lock().unwrap().accounts.get_mut(account).unwrap().problem = problem;
    }

    pub fn account(&self, id: &str) -> Account {
        self.0.lock().unwrap().accounts[id].clone()
    }

    /// The relay's presence `roster` message to every host: the stored
    /// version and every recent revocation (repeats included).
    pub fn notify_roster(&self, version: u64, revoked: Vec<String>) {
        let note = json!({"type": "roster", "version": version, "revocation_floor": version, "revoked": revoked});
        for out in self.1.lock().unwrap().presence.values() {
            let _ = out.send(axum::extract::ws::Message::Text(note.to_string().into()));
        }
    }

    /// Closes every host's presence socket with `code`.
    pub fn close_presence(&self, code: u16) {
        for out in self.1.lock().unwrap().presence.values() {
            let _ = out.send(axum::extract::ws::Message::Close(Some(axum::extract::ws::CloseFrame { code, reason: "".into() })));
        }
    }

    /// Fills the account with `n` stand-in active devices (for the cap).
    pub fn add_stand_ins(&self, account: &str, n: usize) {
        let mut s = self.0.lock().unwrap();
        let a = s.accounts.get_mut(account).unwrap();
        for _ in 0..n {
            a.devices.insert(rand_id(16), (rand_id(32), true, false));
        }
    }

    /// Replaces the stored roster without any check (a malicious cloud).
    pub fn force_roster(&self, account: &str, blob: String, version: u64) {
        let mut s = self.0.lock().unwrap();
        let a = s.accounts.get_mut(account).unwrap();
        a.roster = Some(blob);
        a.version = version;
    }
}

fn user_code() -> String {
    const A: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
    let r: [u8; 8] = random_bytes();
    let c: String = r.iter().map(|b| A[*b as usize % A.len()] as char).collect();
    format!("{}-{}", &c[..4], &c[4..])
}

async fn device_code(State(f): State<Fake>, Form(form): Form<HashMap<String, String>>) -> Response {
    let Some(auth) = form.get("auth_pub").and_then(|a| from_b64_array::<32>(a).ok()) else {
        return err(400, "invalid_request");
    };
    let code = user_code();
    let device_code = format!("{code}.{}", rand_id(24));
    let id = device_id(&auth);
    f.0.lock().unwrap().codes.insert(device_code.clone(), DeviceCodeRow { user_code: code.clone(), device_id: id.clone(), status: CodeStatus::Pending, redeemed: false });
    Json(json!({
        "device_code": device_code, "user_code": code, "device_id": id,
        // A malicious-looking URL: clients must ignore it.
        "verification_uri": "https://attacker.example/device",
        "verification_uri_complete": "https://attacker.example/device?code=x",
        "expires_in": 600, "interval": 1
    }))
    .into_response()
}

async fn device_token(State(f): State<Fake>, Form(form): Form<HashMap<String, String>>) -> Response {
    let mut s = f.0.lock().unwrap();
    if let Some((status, code, retry_after)) = s.token_failures.pop_front() {
        let mut r = err(status, code);
        if let Some(secs) = retry_after {
            r.headers_mut().insert("retry-after", secs.to_string().parse().unwrap());
        }
        return r;
    }
    let Some(row) = form.get("device_code").and_then(|c| s.codes.get(c)).cloned() else {
        return err(400, "invalid_grant");
    };
    match row.status {
        CodeStatus::Pending => err(400, "authorization_pending"),
        CodeStatus::Denied => err(400, "access_denied"),
        CodeStatus::Expired => err(400, "expired_token"),
        CodeStatus::Approved(account) => {
            if row.redeemed {
                return err(400, "invalid_grant");
            }
            s.codes.get_mut(&form["device_code"]).unwrap().redeemed = true;
            let token = format!("e1.{}.{}", rand_id(24), rand_id(24));
            s.sessions.insert(token.clone(), (account.clone(), row.device_id.clone(), false));
            Json(json!({ "access_token": token, "token_type": "Bearer", "expires_in": 900, "account_id": account, "device_id": row.device_id })).into_response()
        }
    }
}

/// Checks an enrollment session; returns (account, device).
fn session_of(s: &Inner, headers: &HeaderMap) -> Result<(String, String), Response> {
    let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).ok_or_else(|| err(401, "unauthorized"))?;
    match s.sessions.get(token) {
        Some((_, _, true)) => Err(err(401, "session_used")),
        Some((a, d, false)) => Ok((a.clone(), d.clone())),
        None => Err(err(401, "unauthorized")),
    }
}

fn spend(s: &mut Inner, headers: &HeaderMap) {
    let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap().to_string();
    s.sessions.get_mut(&token).unwrap().2 = true;
}

pub(crate) fn problem(a: &Account) -> Option<Response> {
    a.problem.as_ref().map(|(status, body)| (StatusCode::from_u16(*status).unwrap(), Json(body.clone())).into_response())
}

async fn genesis(State(f): State<Fake>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device) = match session_of(&s, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Some(r) = problem(&s.accounts[&account]) {
        return r;
    }
    if body["device_id"] != json!(device) {
        return err(403, "wrong_device");
    }
    if s.accounts[&account].roster.is_some() {
        return err(409, "roster_exists");
    }
    let Ok(r) = roster::verify(body["roster"].as_str().unwrap_or(""), &account, None, Chain::Linked) else {
        return err(400, "invalid_roster");
    };
    let rpub: [u8; 32] = from_b64_array(body["recovery_pub"].as_str().unwrap()).unwrap();
    let rsig: [u8; 64] = from_b64_array(body["recovery_sig"].as_str().unwrap()).unwrap();
    if !keys::verify(&rpub, &rsig, &lines!["agentd-cloud-recovery-key-v1", &account, body["recovery_pub"].as_str().unwrap()]) {
        return err(400, "invalid_recovery_sig");
    }
    if r.body.recovery_pub != body["recovery_pub"].as_str().unwrap() || r.body.devices[0].auth != body["auth_pub"].as_str().unwrap() {
        return err(400, "invalid_roster");
    }
    spend(&mut s, &headers);
    let a = s.accounts.get_mut(&account).unwrap();
    a.roster = Some(r.blob.clone());
    a.version = 1;
    a.devices.insert(device, (body["auth_pub"].as_str().unwrap().to_string(), true, true));
    (StatusCode::CREATED, Json(json!({ "account_id": account, "version": 1 }))).into_response()
}

async fn pending_create(State(f): State<Fake>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device) = match session_of(&s, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Some(r) = problem(&s.accounts[&account]) {
        return r;
    }
    if s.accounts[&account].roster.is_none() {
        return err(409, "no_roster");
    }
    if body["device_id"] != json!(device) {
        return err(403, "wrong_device");
    }
    if s.pending_cap.is_some_and(|cap| s.accounts[&account].pending.values().filter(|p| p["invite_slot"].is_null()).count() >= cap) {
        return err(409, "too_many_pending");
    }
    spend(&mut s, &headers);
    let id = rand_id(16);
    let obj = json!({
        "enrollment_id": id, "device_id": device, "auth_pub": body["auth_pub"], "pubs": body["pubs"], "commit": body["commit"],
        "n_a": null, "n_a_by": null, "n_n": null, "country": "XX", "created_at": 0, "expires_at": 0, "invite_slot": null, "proof": null,
        "kind": body["kind"]
    });
    let a = s.accounts.get_mut(&account).unwrap();
    if let Some(k) = body["kind"].as_str() {
        a.kinds.insert(device.clone(), k.to_string());
    }
    a.pending.insert(id.clone(), obj);
    a.devices.insert(device, (body["auth_pub"].as_str().unwrap().to_string(), false, false));
    (StatusCode::CREATED, Json(json!({ "account_id": account, "enrollment_id": id, "expires_at": 0 }))).into_response()
}

/// Checks a signed request like the cloud does. `allow_pending`: the
/// routes a pending device may call.
fn signed(s: &mut Inner, method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8], allow_pending: bool) -> Result<(String, String, bool, HeaderMap), Response> {
    let (account, device, auth) = signature(s, method, uri, headers, body)?;
    let a = s.accounts.get(&account).ok_or_else(|| err(401, "unauthorized"))?;
    let (stored_auth, active, signer) = a.devices.get(&device).cloned().ok_or_else(|| err(401, "unauthorized"))?;
    // Like the cloud: a removed or departed device signing with its own
    // registered key gets device_revoked (nonce spent), ahead of any lock.
    let removed = stored_auth == auth && a.revoked.contains(&device);
    let locked = problem(a);
    let out = next_nonce(s, &account, &device);
    if removed {
        return Err((StatusCode::FORBIDDEN, out, Json(json!({ "error": "device_revoked" }))).into_response());
    }
    if let Some(r) = locked {
        return Err(r);
    }
    if stored_auth != auth || (!active && !allow_pending) {
        return Err(err(401, "unauthorized"));
    }
    Ok((account, device, signer, out))
}

fn next_nonce(s: &mut Inner, account: &str, device: &str) -> HeaderMap {
    let next = format!("n1.{}.{}", rand_id(24), rand_id(24));
    s.nonces.insert(next.clone(), (account.to_string(), device.to_string()));
    let mut out = HeaderMap::new();
    out.insert("x-agentd-next-nonce", next.parse().unwrap());
    out
}

/// The signature and nonce checks alone: (account, device, auth_pub b64).
fn signature(s: &mut Inner, method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> Result<(String, String, String), Response> {
    s.signed_requests += 1;
    let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(str::to_string).ok_or_else(|| err(401, "unauthorized"));
    let (account, device, auth, nonce, sig) = (h("x-agentd-account")?, h("x-agentd-device")?, h("x-agentd-auth-pub")?, h("x-agentd-nonce")?, h("x-agentd-signature")?);
    let auth_pub: [u8; 32] = from_b64_array(&auth).map_err(|_| err(401, "unauthorized"))?;
    if device_id(&auth_pub) != device {
        return Err(err(401, "unauthorized"));
    }
    match s.nonces.remove(&nonce) {
        Some((a, d)) if a == account && d == device => {}
        _ => return Err(err(401, "unauthorized")),
    }
    let path = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let message = lines!["agentd-cloud-request-v1", method.as_str(), path, &account, &device, &nonce, &b64(&Sha256::digest(body))];
    let sig: [u8; 64] = from_b64_array(&sig).map_err(|_| err(401, "unauthorized"))?;
    if !keys::verify(&auth_pub, &sig, &message) {
        return Err(err(401, "unauthorized"));
    }
    Ok((account, device, auth))
}

macro_rules! signed_or_return {
    ($s:expr, $method:expr, $uri:expr, $headers:expr, $body:expr, $pending:expr) => {
        match signed(&mut $s, &$method, &$uri, &$headers, $body, $pending) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}

async fn nonce(State(f): State<Fake>, Json(body): Json<Value>) -> Response {
    let mut s = f.0.lock().unwrap();
    let n = format!("n1.{}.{}", rand_id(24), rand_id(24));
    s.nonces.insert(n.clone(), (body["account_id"].as_str().unwrap_or("").into(), body["device_id"].as_str().unwrap_or("").into()));
    Json(json!({ "nonce": n, "expires_in": 120, "expires_at": 0 })).into_response()
}

async fn pending_get(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device, signer, h) = signed_or_return!(s, method, uri, headers, b"", true);
    let tamper = s.tamper_pending;
    let Some(mut p) = s.accounts[&account].pending.get(&id).cloned() else {
        return err(404, "not_found");
    };
    if !signer && p["device_id"] != json!(device) {
        return err(404, "not_found");
    }
    if let Some(t) = tamper {
        if signer {
            t(&mut p);
        }
    }
    (h, Json(p)).into_response()
}

async fn pending_list(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, signer, h) = signed_or_return!(s, method, uri, headers, b"", false);
    if !signer {
        return err(403, "not_signer");
    }
    let tamper = s.tamper_pending;
    let mut list: Vec<Value> = s.accounts[&account].pending.values().cloned().collect();
    if let Some(t) = tamper {
        list.iter_mut().for_each(t);
    }
    (h, Json(json!({ "pending": list }))).into_response()
}

async fn pending_delete(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, _, h) = signed_or_return!(s, method, uri, headers, b"", true);
    let a = s.accounts.get_mut(&account).unwrap();
    // Like the cloud: the device is forgotten with its request, so its
    // next signed request is 401.
    if let Some(p) = a.pending.remove(&id) {
        let d = p["device_id"].as_str().unwrap().to_string();
        if a.devices.get(&d).is_some_and(|e| !e.1) {
            a.devices.remove(&d);
        }
    }
    (h, Json(json!({}))).into_response()
}

async fn pending_na(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(id): Path<String>, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device, signer, h) = signed_or_return!(s, method, uri, headers, &body, false);
    if !signer {
        return err(403, "not_signer");
    }
    let v: Value = serde_json::from_slice(&body).unwrap();
    let Some(p) = s.accounts.get_mut(&account).unwrap().pending.get_mut(&id) else {
        return err(404, "not_found");
    };
    if !p["n_a"].is_null() {
        return err(409, "already_set");
    }
    p["n_a"] = v["n_a"].clone();
    p["n_a_by"] = json!(device);
    (h, Json(json!({}))).into_response()
}

async fn pending_nn(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(id): Path<String>, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, _, h) = signed_or_return!(s, method, uri, headers, &body, true);
    let v: Value = serde_json::from_slice(&body).unwrap();
    let Some(p) = s.accounts.get_mut(&account).unwrap().pending.get_mut(&id) else {
        return err(404, "not_found");
    };
    if p["n_a"].is_null() {
        return err(409, "not_ready");
    }
    p["n_n"] = v["n_n"].clone();
    (h, Json(json!({}))).into_response()
}

async fn roster_get(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device, _, h) = signed_or_return!(s, method, uri, headers, b"", true);
    let a = &s.accounts[&account];
    if a.pending.values().any(|p| p["device_id"] == json!(device) && !p["invite_slot"].is_null()) {
        return err(403, "not_enrolled");
    }
    match &a.roster {
        Some(blob) => (h, Json(json!({ "version": a.version, "blob": blob, "revocation_floor": 0 }))).into_response(),
        None => err(409, "no_roster"),
    }
}

async fn roster_put(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, signer, h) = signed_or_return!(s, method, uri, headers, &body, false);
    if !signer {
        return err(403, "not_signer");
    }
    let v: Value = serde_json::from_slice(&body).unwrap();
    let a = s.accounts.get_mut(&account).unwrap();
    if v["base_version"].as_u64() != Some(a.version) {
        return err(409, "version_conflict");
    }
    let known = roster::parse(a.roster.as_deref().unwrap()).unwrap();
    let Ok(next) = roster::verify(v["roster"].as_str().unwrap_or(""), &account, Some(&known), Chain::Linked) else {
        return err(400, "invalid_roster");
    };
    let change = roster::diff(&known.body, &next.body);
    for added in &change.added {
        let ok = a.pending.values().any(|p| p["device_id"] == json!(added) && (!p["n_n"].is_null() || !p["invite_slot"].is_null()));
        if !ok {
            return err(409, "enrollment_not_ready");
        }
        // Spec 3.3: the added entry has the keys of its pubs, and only the
        // roles its pubs asked for (or fewer).
        let p = a.pending.values().find(|p| p["device_id"] == json!(added)).unwrap();
        let asked = openagentd_cloud::keys::parse_pubs(&from_b64(p["pubs"].as_str().unwrap_or("")).unwrap_or_default());
        let entry = next.body.device(added).unwrap();
        let fits = asked.is_ok_and(|asked| entry.box_key() == asked.r#box && entry.sign_key() == asked.sign && entry.roles().within(asked.roles));
        if !fits {
            return err(400, "invalid_roster");
        }
    }
    let mut used = Vec::new();
    for added in &change.added {
        let id = a.pending.iter().find(|(_, p)| p["device_id"] == json!(added)).map(|(k, _)| k.clone()).unwrap();
        let p = a.pending.remove(&id).unwrap();
        if let Some(slot) = p["invite_slot"].as_str() {
            used.push((slot.to_string(), added.clone()));
        }
    }
    // Adding a candidate spends the invitation and drops its other candidates.
    for (slot, _) in &used {
        let others: Vec<(String, String)> =
            a.pending.iter().filter(|(_, p)| p["invite_slot"] == json!(slot)).map(|(k, p)| (k.clone(), p["device_id"].as_str().unwrap().to_string())).collect();
        for (k, d) in others {
            a.pending.remove(&k);
            a.devices.remove(&d);
        }
    }
    for d in &next.body.devices {
        let e = a.devices.entry(d.id.clone()).or_insert((d.auth.clone(), true, d.signer));
        e.1 = true;
        e.2 = d.signer;
    }
    for removed in &change.removed {
        if let Some(e) = a.devices.get_mut(removed) {
            e.1 = false;
        }
        if !a.revoked.contains(removed) {
            a.revoked.push(removed.clone());
        }
    }
    a.roster = Some(next.blob.clone());
    a.version = next.version();
    let (version, revoked) = (a.version, a.revoked.clone());
    for (slot, device) in used {
        if let Some(row) = s.invites.get_mut(&slot) {
            row.used_by = Some(device);
            row.used_version = Some(version);
        }
    }
    drop(s);
    f.notify_roster(version, revoked);
    (h, Json(json!({ "version": version, "revocation_floor": version }))).into_response()
}

async fn devices(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, _, h) = signed_or_return!(s, method, uri, headers, b"", false);
    let list: Vec<Value> = s.accounts[&account]
        .devices
        .iter()
        .map(|(id, (_, active, signer))| json!({ "device_id": id, "signer": signer, "added_at": 0, "revoked_at": if *active { Value::Null } else { json!(1) }, "kind": s.accounts[&account].kinds.get(id) }))
        .collect();
    (h, Json(json!({ "devices": list, "device_cap": openagentd_cloud::roster::MAX_DEVICES }))).into_response()
}

/// Today's relay use: the account's active devices that ever opened presence,
/// `online` while the socket is open.
async fn relay_usage(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let (devices, without_online, h) = {
        let mut s = f.0.lock().unwrap();
        let (account, _, _, h) = signed_or_return!(s, method, uri, headers, b"", false);
        let devices: Vec<String> = s.accounts[&account].devices.iter().filter(|(_, (_, active, _))| *active).map(|(id, _)| id.clone()).collect();
        (devices, s.usage_without_online, h)
    };
    let relay = f.1.lock().unwrap();
    let hosts: Vec<Value> = devices
        .into_iter()
        .filter(|id| relay.seen.contains(id))
        .map(|id| {
            let mut host = json!({ "device_id": id, "percent": 0, "relay_messages": 0, "paused_until": null });
            if !without_online {
                host["online"] = json!(relay.presence.contains_key(&id));
            }
            host
        })
        .collect();
    (h, Json(json!({ "resets_at": 0, "hosts": hosts }))).into_response()
}

async fn leave(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device, _, h) = signed_or_return!(s, method, uri, headers, &body, false);
    let a = s.accounts.get_mut(&account).unwrap();
    let active_signers = a.devices.values().filter(|(_, act, sig)| *act && *sig).count();
    if a.devices[&device].2 && active_signers <= 1 {
        return err(409, "last_signer");
    }
    a.devices.get_mut(&device).unwrap().1 = false;
    if !a.revoked.contains(&device) {
        a.revoked.push(device.clone());
    }
    // A leave changes no version; the relay still tells the hosts.
    let (version, revoked) = (a.version, a.revoked.clone());
    drop(s);
    f.notify_roster(version, revoked);
    (h, Json(json!({}))).into_response()
}

async fn relay_token(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let delay = f.0.lock().unwrap().relay_token_delay;
    if let Some(d) = delay {
        tokio::time::sleep(d).await;
    }
    let mut s = f.0.lock().unwrap();
    let (account, device, _, h) = signed_or_return!(s, method, uri, headers, &body, false);
    let v = s.accounts[&account].version;
    let token = format!("t1.{}.{}", rand_id(24), rand_id(24));
    s.tokens.insert(token.clone(), (account, device));
    s.relay_tokens_issued += 1;
    (h, Json(json!({ "token": token, "expires_in": 900, "roster_version": v }))).into_response()
}

async fn mailbox_send(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(to): Path<String>, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, from, _, h) = signed_or_return!(s, method, uri, headers, &body, false);
    let mut v: Value = serde_json::from_slice(&body).unwrap();
    v["from"] = json!(from);
    v["to"] = json!(to);
    v["id"] = json!(rand_id(16));
    s.accounts.get_mut(&account).unwrap().letters.push(v.clone());
    (StatusCode::CREATED, h, Json(json!({ "id": v["id"] }))).into_response()
}

async fn mailbox_get(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, me, _, h) = signed_or_return!(s, method, uri, headers, b"", false);
    let letters: Vec<Value> = s.accounts[&account].letters.iter().filter(|l| l["to"] == json!(me)).cloned().collect();
    (h, Json(json!({ "letters": letters }))).into_response()
}

async fn push_register(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (_, _, _, h) = signed_or_return!(s, method, uri, headers, &body, false);
    (h, Json(json!({}))).into_response()
}

async fn invite_create(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, signer, h) = signed_or_return!(s, method, uri, headers, &body, false);
    if !signer {
        return err(403, "not_signer");
    }
    if s.accounts[&account].devices.values().filter(|d| d.1).count() >= openagentd_cloud::roster::MAX_DEVICES {
        return err(403, "device_limit");
    }
    let slot = rand_id(16);
    s.invites.insert(slot.clone(), InviteRow { account, ..Default::default() });
    // Unix ms, ten minutes from now, as the cloud answers.
    let expires_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 600_000;
    (StatusCode::CREATED, h, Json(json!({ "slot_id": slot, "expires_at": expires_at }))).into_response()
}

/// A device not yet in the account claims with its own key.
async fn invite_claim(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(slot): Path<String>, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device, auth) = match signature(&mut s, &method, &uri, &headers, &body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let h = next_nonce(&mut s, &account, &device);
    let Some(row) = s.invites.get(&slot).cloned() else {
        return err(404, "not_found");
    };
    if row.account != account {
        return err(404, "not_found");
    }
    if row.used_by.is_some() {
        return err(409, "invite_used");
    }
    let v: Value = serde_json::from_slice(&body).unwrap();
    let a = s.accounts.get_mut(&account).unwrap();
    if let Some(r) = problem(a) {
        return r;
    }
    if let Some((id, p)) = a.pending.iter().find(|(_, p)| p["device_id"] == json!(device)) {
        let same = p["invite_slot"] == json!(slot) && p["auth_pub"] == json!(auth) && p["pubs"] == v["pubs"] && p["proof"] == v["proof"];
        return if same { (StatusCode::CREATED, h, Json(json!({ "enrollment_id": id, "expires_at": 600_000 }))).into_response() } else { err(409, "device_exists") };
    }
    if a.devices.contains_key(&device) {
        return err(409, "device_exists");
    }
    if a.pending.values().filter(|p| p["invite_slot"] == json!(slot)).count() >= INVITE_CANDIDATES {
        return err(409, "invite_busy");
    }
    if a.devices.values().filter(|d| d.1).count() >= openagentd_cloud::roster::MAX_DEVICES {
        return err(403, "device_limit");
    }
    let id = rand_id(16);
    a.pending.insert(
        id.clone(),
        json!({
            "enrollment_id": id, "device_id": device, "auth_pub": auth, "pubs": v["pubs"], "commit": null,
            "n_a": null, "n_a_by": null, "n_n": null, "country": "XX", "created_at": 0, "expires_at": 600_000,
            "invite_slot": slot, "proof": v["proof"], "kind": v["kind"]
        }),
    );
    a.devices.insert(device.clone(), (auth, false, false));
    if let Some(k) = v["kind"].as_str() {
        a.kinds.insert(device, k.to_string());
    }
    (StatusCode::CREATED, h, Json(json!({ "enrollment_id": id, "expires_at": 600_000 }))).into_response()
}

async fn invite_get(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(slot): Path<String>) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, device, _, h) = signed_or_return!(s, method, uri, headers, b"", true);
    let Some(row) = s.invites.get(&slot).cloned().filter(|r| r.account == account) else {
        return err(404, "not_found");
    };
    if row.used_by.as_deref() == Some(device.as_str()) {
        return (h, Json(json!({ "status": "added", "roster_version": row.used_version, "confirm": row.confirm, "expires_at": 600_000 }))).into_response();
    }
    if s.accounts[&account].pending.values().any(|p| p["device_id"] == json!(device) && p["invite_slot"] == json!(slot)) {
        return (h, Json(json!({ "status": "waiting", "expires_at": 600_000 }))).into_response();
    }
    err(404, "not_found")
}

async fn invite_delete(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(slot): Path<String>) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, _, h) = signed_or_return!(s, method, uri, headers, b"", false);
    if !s.invites.get(&slot).is_some_and(|r| r.account == account) {
        return err(404, "not_found");
    }
    s.invites.remove(&slot);
    let a = s.accounts.get_mut(&account).unwrap();
    let gone: Vec<(String, String)> =
        a.pending.iter().filter(|(_, p)| p["invite_slot"] == json!(slot)).map(|(k, p)| (k.clone(), p["device_id"].as_str().unwrap().to_string())).collect();
    for (k, d) in gone {
        a.pending.remove(&k);
        a.devices.remove(&d);
    }
    (h, Json(json!({}))).into_response()
}

async fn invite_confirm(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, Path(slot): Path<String>, body: axum::body::Bytes) -> Response {
    let mut s = f.0.lock().unwrap();
    let (account, _, _, h) = signed_or_return!(s, method, uri, headers, &body, false);
    let v: Value = serde_json::from_slice(&body).unwrap();
    let Some(row) = s.invites.get_mut(&slot).filter(|r| r.account == account) else {
        return err(404, "not_found");
    };
    if row.used_by.as_ref().map(|d| json!(d)) != Some(v["device_id"].clone()) {
        return err(404, "not_found");
    }
    if row.confirm.is_some() {
        return err(409, "already_set");
    }
    row.confirm = v["confirm"].as_str().map(String::from);
    (h, Json(json!({}))).into_response()
}

pub fn tamper_swap_pubs(p: &mut Value) {
    // The cloud swaps in its own keys for the joining device's.
    let k = openagentd_cloud::keys::DeviceKeys::generate();
    p["pubs"] = json!(b64(&k.pubs(openagentd_cloud::keys::Roles::BOTH)));
}

pub fn tamper_raise_roles(p: &mut Value) {
    // The cloud asks for more roles than the joining device did, with the
    // same keys.
    let pubs = from_b64(p["pubs"].as_str().unwrap()).unwrap();
    let parsed = openagentd_cloud::keys::parse_pubs(&pubs).unwrap();
    p["pubs"] = json!(b64(&openagentd_cloud::keys::pubs_bytes(&parsed.r#box, &parsed.sign, openagentd_cloud::keys::Roles::BOTH)));
}

pub fn decoded(s: &str) -> Vec<u8> {
    from_b64(s).unwrap()
}
