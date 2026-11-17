//! Sign-in driven by a client: the server hands the client the sign-in
//! page's address, and the code comes back through the client (a relay page
//! on another device) or the loopback listener (a browser on this machine).
//! A fake MCP server is its own authorization server, with dynamic client
//! registration.

use appv3_mcp::client::McpClient;
use appv3_mcp::config::{HttpKind, OAuthConfig};
use appv3_mcp::oauth::{self, build_oauth_provider, Relay};
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Once};

const RELAY_PAGE: &str = "https://account.example/oauth/callback";

#[derive(Clone, Default)]
struct Fake {
    base: Arc<Mutex<String>>,
    /// client_id → registered redirect_uris.
    clients: Arc<Mutex<HashMap<String, Vec<String>>>>,
    /// code → (client_id, redirect_uri) of the authorization that made it.
    codes: Arc<Mutex<HashMap<String, (String, String)>>>,
    registrations: Arc<Mutex<usize>>,
}

fn form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes()).into_owned().collect()
}

async fn handle(State(f): State<Fake>, method: Method, uri: Uri, headers: HeaderMap, body: String) -> Response {
    let base = f.base.lock().unwrap().clone();
    match (method.as_str(), uri.path()) {
        ("GET", "/.well-known/oauth-protected-resource/mcp") | ("GET", "/.well-known/oauth-protected-resource") => {
            Json(json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]})).into_response()
        }
        ("GET", "/.well-known/oauth-authorization-server") => Json(json!({
            "issuer": base, "authorization_endpoint": format!("{base}/authorize"), "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"), "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"],
        }))
        .into_response(),
        ("POST", "/register") => {
            let v: Value = serde_json::from_str(&body).unwrap();
            let uris: Vec<String> = v["redirect_uris"].as_array().unwrap().iter().map(|u| u.as_str().unwrap().to_string()).collect();
            let mut n = f.registrations.lock().unwrap();
            *n += 1;
            let id = format!("client-{n}");
            f.clients.lock().unwrap().insert(id.clone(), uris.clone());
            (StatusCode::CREATED, Json(json!({"client_id": id, "redirect_uris": uris, "token_endpoint_auth_method": "none"}))).into_response()
        }
        ("POST", "/token") => {
            let p = form(&body);
            let Some((client, redirect)) = f.codes.lock().unwrap().remove(&p["code"]) else { return (StatusCode::BAD_REQUEST, "bad code").into_response() };
            if p["client_id"] != client || p["redirect_uri"] != redirect {
                return (StatusCode::BAD_REQUEST, "redirect_uri mismatch").into_response();
            }
            Json(json!({"access_token": "tok-1", "token_type": "Bearer", "expires_in": 3600})).into_response()
        }
        ("POST", "/mcp") => {
            if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer tok-1") {
                let www = format!(r#"Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp""#);
                return (StatusCode::UNAUTHORIZED, [("www-authenticate", www)]).into_response();
            }
            let m: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let Some(id) = m.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
            let result = match m["method"].as_str() {
                Some("initialize") => json!({"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake", "version": "1"}}),
                _ => json!({"tools": []}),
            };
            Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// What the service does when the user approves: a code for that client,
/// sent to the redirect_uri the authorization named.
fn approve(f: &Fake, auth_url: &str) -> (String, String, String) {
    let u = url::Url::parse(auth_url).unwrap();
    let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
    let client = q["client_id"].clone();
    let redirect = q["redirect_uri"].clone();
    assert!(f.clients.lock().unwrap()[&client].contains(&redirect), "{redirect} is registered for {client}");
    let code = format!("code-{}", f.codes.lock().unwrap().len() + 1);
    f.codes.lock().unwrap().insert(code.clone(), (client, redirect.clone()));
    (code, q["state"].clone(), redirect)
}

async fn serve() -> (String, Fake) {
    static ENV: Once = Once::new();
    ENV.call_once(|| {
        let dir = tempfile::tempdir().unwrap().keep();
        std::env::set_var("OPENAGENTD_CACHE_DIR", &dir);
    });
    let fake = Fake::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    *fake.base.lock().unwrap() = base.clone();
    let app = Router::new().fallback(any(handle)).with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("{base}/mcp"), fake)
}

fn client(name: &str, url: &str) -> McpClient {
    let p = build_oauth_provider(name, url, Some(&OAuthConfig { client_id: None, client_secret: None })).unwrap();
    McpClient::http(url, &[], p, HttpKind::Auto).unwrap()
}

fn relay() -> Relay {
    Relay { redirect_uri: RELAY_PAGE.into(), return_to: "https://agent.example:8443/oauth-done.html".into() }
}

#[tokio::test]
async fn a_client_on_another_device_signs_in_through_the_relay_page() {
    let (url, fake) = serve().await;
    let announced = oauth::allow_client_oauth("t-relay", Some(relay()));
    let c = client("t-relay", &url);
    let init = tokio::spawn(async move {
        let r = c.initialize().await;
        (c, r)
    });
    let auth_url = announced.await.expect("the client gets the sign-in address");
    let (code, state, redirect) = approve(&fake, &auth_url);
    assert_eq!(redirect, RELAY_PAGE, "the service sends the code to the relay page, not localhost");
    // The state tells the relay page what it shows and where the code goes.
    let (_, info) = state.split_once('.').expect("a relayed state carries its return info");
    let info: Value = serde_json::from_slice(&base64url(info)).unwrap();
    assert_eq!(info, json!({"v": 1, "server": "t-relay", "return_to": "https://agent.example:8443/oauth-done.html"}));

    assert_eq!(oauth::finish_client_oauth("wrong-state", &code, None), Err(oauth::FinishError::Unknown));
    assert_eq!(oauth::finish_client_oauth(&state, &code, None).as_deref(), Ok("t-relay"));
    let (c, r) = init.await.unwrap();
    r.expect("signed in");
    c.close().await;
    // Single use: the same code and state cannot finish a second sign-in.
    assert_eq!(oauth::finish_client_oauth(&state, &code, None), Err(oauth::FinishError::Unknown));
    oauth::disallow_interactive_oauth("t-relay");
}

#[tokio::test]
async fn a_cancelled_sign_in_fails_instead_of_waiting() {
    let (url, _fake) = serve().await;
    let announced = oauth::allow_client_oauth("t-cancel", Some(relay()));
    let c = client("t-cancel", &url);
    let init = tokio::spawn(async move { c.initialize().await });
    announced.await.unwrap();
    // The flow registers its state right after announcing; wait for it.
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        oauth::cancel_client_oauth("t-cancel");
        if init.is_finished() {
            break;
        }
    }
    let e = init.await.unwrap().unwrap_err();
    assert!(e.to_string().contains("cancelled"), "{e}");
    oauth::disallow_interactive_oauth("t-cancel");
}

#[tokio::test]
async fn a_local_sign_in_can_be_cancelled_or_finished_by_a_pasted_code() {
    let (url, fake) = serve().await;
    // Cancelled: the flow fails instead of waiting on localhost.
    let announced = oauth::allow_client_oauth("t-local-cancel", None);
    let c = client("t-local-cancel", &url);
    let init = tokio::spawn(async move { c.initialize().await });
    announced.await.unwrap();
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        oauth::cancel_client_oauth("t-local-cancel");
        if init.is_finished() {
            break;
        }
    }
    assert!(init.await.unwrap().unwrap_err().to_string().contains("cancelled"));
    oauth::disallow_interactive_oauth("t-local-cancel");

    // Finished from a pasted address: the code arrives through the client, not localhost.
    let announced = oauth::allow_client_oauth("t-local-paste", None);
    let c = client("t-local-paste", &url);
    let init = tokio::spawn(async move { c.initialize().await.map(|_| c) });
    let (code, state, redirect) = approve(&fake, &announced.await.unwrap());
    assert!(redirect.starts_with("http://localhost:"));
    let mut delivered = Err(oauth::FinishError::Unknown);
    for _ in 0..50 {
        delivered = oauth::finish_client_oauth(&state, &code, None);
        if delivered.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(delivered.as_deref(), Ok("t-local-paste"));
    init.await.unwrap().unwrap().close().await;
    oauth::disallow_interactive_oauth("t-local-paste");
}

#[tokio::test]
async fn a_browser_on_this_machine_signs_in_through_localhost() {
    let (url, fake) = serve().await;
    let announced = oauth::allow_client_oauth("t-local", None);
    let c = client("t-local", &url);
    let init = tokio::spawn(async move {
        let r = c.initialize().await;
        (c, r)
    });
    let auth_url = announced.await.unwrap();
    let (code, state, redirect) = approve(&fake, &auth_url);
    assert!(redirect.starts_with("http://localhost:"), "{redirect}");
    assert!(!state.contains('.'), "a local sign-in's state carries nothing: {state}");
    // The browser follows the redirect to the loopback listener.
    let back = format!("{redirect}?code={code}&state={state}");
    reqwest::get(&back).await.unwrap();
    let (c, r) = init.await.unwrap();
    r.expect("signed in");
    c.close().await;
    oauth::disallow_interactive_oauth("t-local");
}

#[tokio::test]
async fn a_registration_for_localhost_is_not_reused_for_the_relay_page() {
    let (url, fake) = serve().await;
    // First a local sign-in registers a client for localhost…
    let announced = oauth::allow_client_oauth("t-switch", None);
    let c = client("t-switch", &url);
    let init = tokio::spawn(async move { c.initialize().await.map(|_| c) });
    let (code, state, redirect) = approve(&fake, &announced.await.unwrap());
    reqwest::get(format!("{redirect}?code={code}&state={state}")).await.unwrap();
    init.await.unwrap().unwrap().close().await;
    assert_eq!(*fake.registrations.lock().unwrap(), 1);

    // …then the token stops working, and the next sign-in comes from another device.
    fake.codes.lock().unwrap().clear();
    let announced = oauth::allow_client_oauth("t-switch", Some(relay()));
    let cache = std::env::var("OPENAGENTD_CACHE_DIR").unwrap();
    let file = std::path::Path::new(&cache).join("mcp-oauth/t-switch.json");
    let mut stored: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    stored["tokens"] = Value::Null;
    std::fs::write(&file, stored.to_string()).unwrap();
    let c = client("t-switch", &url);
    let init = tokio::spawn(async move { c.initialize().await.map(|_| c) });
    let (code, state, redirect) = approve(&fake, &announced.await.unwrap());
    assert_eq!(redirect, RELAY_PAGE);
    assert_eq!(*fake.registrations.lock().unwrap(), 2, "registered again for the relay page");
    oauth::finish_client_oauth(&state, &code, None).unwrap();
    init.await.unwrap().unwrap().close().await;
    oauth::disallow_interactive_oauth("t-switch");
}

fn base64url(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).unwrap()
}
