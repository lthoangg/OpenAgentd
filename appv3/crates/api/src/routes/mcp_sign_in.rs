//! `/api/mcp/.../oauth/*`: a connector's sign-in, driven by the client the
//! user is holding, wherever the server runs.
//!
//! `start` hands the client the service's sign-in page. A browser on this
//! machine gets the code back on the loopback listener; a client on another
//! device (another computer, the phone app, a request through a proxy or the
//! relay) has it sent to the relay page, which passes it to the client's
//! `/oauth-done.html` page or `openagentd://mcp-oauth` link, and the client brings
//! it here with `finish`. The PKCE verifier never leaves the server, and a
//! code is accepted only for the exact `state` a sign-in is waiting on.

use super::mcp::{internal, status_json};
use crate::error::{ApiError, ApiResult};
use crate::middleware::Peer;
use crate::schema::Body;
use crate::util::*;
use crate::AppState;
use appv3_mcp::config::{self as cfgmod, ServerConfig};
use appv3_mcp::{mcp_manager, oauth};
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Extension, Router};
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::watch;

/// The relay page production builds send codes to.
pub const DEFAULT_CALLBACK_PAGE: &str = "https://account.openagentd.dev/oauth/callback";
/// How long `finish` waits for the server to come up with its new tokens.
const FINISH_WAIT: Duration = Duration::from_secs(60);
/// The longest `return_to` accepted.
const MAX_RETURN_TO: usize = 2048;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/servers/{name}/oauth/start", post(start))
        .route("/servers/{name}/oauth/status", get(status))
        .route("/servers/{name}/oauth/cancel", post(cancel))
        .route("/servers/{name}/oauth/sign-out", post(sign_out))
        .route("/oauth/finish", post(finish))
}

/// Where relayed codes go: `OPENAGENTD_MCP_OAUTH_CALLBACK` names another
/// relay page, or `self` to send them straight to the client's own
/// `https` address (a self-hosted server with a certificate). `None`: self.
fn callback_page() -> Option<String> {
    match std::env::var("OPENAGENTD_MCP_OAUTH_CALLBACK").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        Some(v) if v == "self" => None,
        Some(v) => Some(v),
        None => Some(DEFAULT_CALLBACK_PAGE.to_string()),
    }
}

/// A `return_to` the relay page may send a code on to: the client's own
/// `…/oauth-done.html` page, or the app's `openagentd://mcp-oauth` link.
pub fn valid_return_to(raw: &str) -> Option<String> {
    if raw.len() > MAX_RETURN_TO {
        return None;
    }
    let u = reqwest::Url::parse(raw).ok()?;
    if u.query().is_some() || u.fragment().is_some() || !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    match u.scheme() {
        "http" | "https" => (u.host_str().is_some_and(|h| !h.is_empty()) && u.path().ends_with("/oauth-done.html")).then(|| u.to_string()),
        "openagentd" | "openagentd-dev" => (raw == format!("{}://mcp-oauth", u.scheme())).then(|| raw.to_string()),
        _ => None,
    }
}

// ── sign-ins in progress ────────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum Outcome {
    Waiting,
    Done(Value),
    Failed(String),
}

struct SignIn {
    id: u64,
    outcome: watch::Receiver<Outcome>,
}

fn sign_ins() -> &'static Mutex<HashMap<String, SignIn>> {
    static S: OnceLock<Mutex<HashMap<String, SignIn>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn outcome_json(o: &Outcome) -> Value {
    match o {
        Outcome::Waiting => json!({"status": "waiting"}),
        Outcome::Done(server) => json!({"status": "done", "server": server}),
        Outcome::Failed(error) => json!({"status": "failed", "error": error}),
    }
}

/// The server's config, from `mcp.json` or the plugin that provides it.
fn server_config(name: &str) -> ApiResult<(ServerConfig, Option<cfgmod::McpConfig>)> {
    if let Some(sc) = mcp_manager().plugin_of(name).and_then(|_| mcp_manager().plugin_server_config(name)) {
        return Ok((sc, None));
    }
    let cfg = cfgmod::load_config().map_err(internal)?;
    let Some(sc) = cfg.servers.get(name).cloned() else { return Err(ApiError::not_found(format!("MCP server '{name}' not found."))) };
    Ok((sc, Some(cfg)))
}

async fn start(AxPath(name): AxPath<String>, peer: Option<Extension<Peer>>, raw: Bytes) -> ApiResult<Response> {
    let v = if raw.is_empty() { json!({}) } else { body_value(&raw)? };
    let mut b = Body::new(&v)?;
    let return_to = b.opt_str("return_to");
    b.finish(&["return_to"])?;
    let (sc, user_cfg) = server_config(&name)?;
    if !sc.signs_in_with_oauth() {
        return Err(ApiError::bad_request(format!("MCP server '{name}' does not sign in with OAuth: it is a stdio server, or its Authorization header sets its credentials.")));
    }
    // A browser on this machine reaches the loopback listener; anything that
    // crossed a network (another device, a proxy, the relay) cannot.
    let local = peer.is_some_and(|Extension(p)| !p.remote());
    let relay = if local {
        None
    } else {
        let Some(return_to) = return_to.as_deref().and_then(valid_return_to) else {
            return Err(ApiError::unprocessable("return_to is required from another device: the client's /oauth-done.html page or openagentd://mcp-oauth."));
        };
        let redirect_uri = match callback_page() {
            Some(page) => page,
            None if return_to.starts_with("https://") => return_to.clone(),
            None => DEFAULT_CALLBACK_PAGE.to_string(),
        };
        Some(oauth::Relay { redirect_uri, return_to })
    };
    let relayed = relay.is_some();

    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let mut announced = oauth::allow_client_oauth(&name, relay);
    oauth::clear_cached_oauth(&name);
    let (tx, mut rx) = watch::channel(Outcome::Waiting);
    sign_ins().lock().unwrap().insert(name.clone(), SignIn { id, outcome: rx.clone() });
    {
        let name = name.clone();
        tokio::spawn(async move {
            let res = mcp_manager().restart_server(&name, oauth::CLIENT_SIGN_IN_TIMEOUT + Duration::from_secs(30)).await;
            let current = sign_ins().lock().unwrap().get(&name).is_some_and(|s| s.id == id);
            if current {
                oauth::disallow_interactive_oauth(&name);
            }
            let outcome = match res {
                Ok(st) if st.state == "ready" => {
                    if let Some(cfg) = &user_cfg {
                        if let Err(e) = cfgmod::save_config(cfg) {
                            tracing::warn!("mcp_sign_in_save_failed server={} error={}", name, e);
                        }
                    }
                    Outcome::Done(status_json(&st, Some(&sc)))
                }
                Ok(st) => Outcome::Failed(st.error.clone().unwrap_or_else(|| format!("MCP server '{name}' did not connect."))),
                Err(e) => Outcome::Failed(e),
            };
            tracing::info!("mcp_sign_in_settled server={} outcome={}", name, outcome_json(&outcome)["status"]);
            let _ = tx.send(outcome);
        });
    }
    let announced_url = tokio::select! {
        url = &mut announced => url.ok(),
        _ = rx.wait_for(|o| !matches!(o, Outcome::Waiting)) => None,
    };
    match announced_url {
        Some(auth_url) => Ok(json(json!({"status": "sign_in", "auth_url": auth_url, "return": if relayed { "relay" } else { "loopback" }}))),
        // Connected without signing in, failed, or was replaced: its outcome says which.
        None => {
            let settled = tokio::time::timeout(FINISH_WAIT, rx.wait_for(|o| !matches!(o, Outcome::Waiting))).await;
            match settled.ok().and_then(|r| r.ok()).map(|o| o.clone()) {
                Some(Outcome::Done(server)) => Ok(json(json!({"status": "done", "server": server}))),
                Some(Outcome::Failed(e)) => Err(ApiError::conflict(e)),
                _ => Err(ApiError::conflict(format!("MCP server '{name}' did not connect."))),
            }
        }
    }
}

async fn status(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let o = sign_ins().lock().unwrap().get(&name).map(|s| s.outcome.borrow().clone());
    Ok(json(o.map(|o| outcome_json(&o)).unwrap_or_else(|| json!({"status": "none"}))))
}

async fn cancel(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    oauth::cancel_client_oauth(&name);
    Ok(json(json!({"name": name})))
}

/// Forget the tokens and the registered client; the connector stays.
async fn sign_out(AxPath(name): AxPath<String>) -> ApiResult<Response> {
    let (sc, _) = server_config(&name)?;
    oauth::disallow_interactive_oauth(&name);
    oauth::clear_cached_oauth(&name);
    sign_ins().lock().unwrap().remove(&name);
    let st = mcp_manager().restart_server(&name, Duration::from_secs(15)).await.map_err(internal)?;
    Ok(json(status_json(&st, Some(&sc))))
}

/// The code and state a pasted address carries.
fn from_pasted(raw: &str) -> Option<(String, String, Option<String>)> {
    let u = reqwest::Url::parse(raw.trim()).ok()?;
    let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
    let code = q.get("code").filter(|c| !c.is_empty())?.clone();
    let state = q.get("state").filter(|s| !s.is_empty())?.clone();
    Some((code, state, q.get("iss").cloned()))
}

async fn finish(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let code = b.opt_str("code");
    let state = b.opt_str("state");
    let iss = b.opt_str("iss");
    let pasted = b.opt_str("url");
    b.finish(&["code", "state", "iss", "url"])?;
    let (code, state, iss) = match (code, state, pasted) {
        (Some(c), Some(s), _) if !c.is_empty() && !s.is_empty() => (c, s, iss),
        (_, _, Some(p)) => match from_pasted(&p) {
            Some((c, s, i)) => (c, s, i),
            None => return Err(ApiError::unprocessable("That address has no sign-in code in it. Copy the whole address of the page the sign-in ended on.")),
        },
        _ => return Err(ApiError::unprocessable("code and state are required, or url.")),
    };
    let Ok(server) = oauth::finish_client_oauth(&state, &code, iss.as_deref()) else {
        return Err(ApiError::conflict("This sign-in has expired or already finished. Start it again."));
    };
    let rx = sign_ins().lock().unwrap().get(&server).map(|s| s.outcome.clone());
    let Some(mut rx) = rx else { return Ok(json(json!({"status": "waiting", "name": server}))) };
    let settled = tokio::time::timeout(FINISH_WAIT, rx.wait_for(|o| !matches!(o, Outcome::Waiting))).await;
    let outcome = match settled {
        Ok(Ok(o)) => o.clone(),
        _ => Outcome::Waiting,
    };
    match outcome {
        Outcome::Failed(e) => Err(ApiError::conflict(e)),
        o => {
            let mut v = outcome_json(&o);
            v["name"] = json!(server);
            Ok(json(v))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_to_is_a_done_page_or_the_apps_link() {
        assert_eq!(valid_return_to("https://agent.example/oauth-done.html").as_deref(), Some("https://agent.example/oauth-done.html"));
        assert!(valid_return_to("http://192.168.1.20:7681/oauth-done.html").is_some());
        assert!(valid_return_to("https://agent.example/base/oauth-done.html").is_some());
        assert_eq!(valid_return_to("openagentd://mcp-oauth").as_deref(), Some("openagentd://mcp-oauth"));
        assert!(valid_return_to("openagentd-dev://mcp-oauth").is_some());
        for bad in [
            "https://evil.example/steal",
            "https://agent.example/oauth-done.html?next=https://evil.example",
            "https://user:pw@agent.example/oauth-done.html",
            "javascript:alert(1)//oauth-done.html",
            "openagentd://session/x",
            "file:///oauth-done.html",
            "/oauth-done.html",
        ] {
            assert_eq!(valid_return_to(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_pasted_address_gives_its_code_and_state() {
        let (code, state, iss) = from_pasted(" https://account.openagentd.dev/oauth/callback?code=abc&state=s1.e30&iss=https%3A%2F%2Fas ").unwrap();
        assert_eq!((code.as_str(), state.as_str(), iss.as_deref()), ("abc", "s1.e30", Some("https://as")));
        assert!(from_pasted("https://x.example/?state=s").is_none());
        assert!(from_pasted("not a url").is_none());
    }
}
