//! Where an authorization code comes back to: the loopback listener on this
//! machine, or, for a client on another device, the code that client hands
//! the server ([`finish_client_oauth`]).
//!
//! A sign-in is interactive only while one of the gates here is open for
//! its server: [`allow_interactive_oauth`] (this machine opens the page and
//! listens on localhost) or [`allow_client_oauth`] (the client opens the
//! page; the code returns to localhost, or through the relay page when the
//! client is elsewhere).

use super::{required, urlsplit, CALLBACK_PATH};
use crate::client::McpError;
use appv3_providers::plugin::{parse_qs, qs_first};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// How long a client has to bring the code back.
pub const CLIENT_SIGN_IN_TIMEOUT: Duration = Duration::from_secs(600);

// ── interactive gates ───────────────────────────────────────────────────────

/// How an interactive sign-in reaches the user.
pub(super) enum Mode {
    /// This machine opens the page and the loopback listener gets the code.
    ServerBrowser,
    /// The client opens the page ([`allow_client_oauth`]).
    Client(ClientSignIn),
}

pub(super) struct ClientSignIn {
    /// `None`: the code returns to the loopback listener (the browser is on
    /// this machine).
    pub relay: Option<Relay>,
    announce: Mutex<Option<oneshot::Sender<String>>>,
}

/// The return path for a client on another device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Relay {
    /// The `redirect_uri` the service sends the code to (the relay page).
    pub redirect_uri: String,
    /// Where the relay page hands the code on: the client's own
    /// `/oauth-done.html` page or the app's `openagentd://mcp-oauth` link.
    pub return_to: String,
}

impl ClientSignIn {
    /// Hand the sign-in page's address to the client that is waiting for it.
    pub(super) fn announce(&self, url: &str) {
        if let Some(tx) = self.announce.lock().unwrap().take() {
            let _ = tx.send(url.to_string());
        }
    }
}

fn gates() -> &'static Mutex<HashMap<String, Arc<Mode>>> {
    static S: OnceLock<Mutex<HashMap<String, Arc<Mode>>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// This machine opens the sign-in page itself (desktop "Sign in" of old).
pub fn allow_interactive_oauth(name: &str) {
    gates().lock().unwrap().insert(name.to_string(), Arc::new(Mode::ServerBrowser));
}

/// The client opens the sign-in page: the receiver gets its address once the
/// flow has one. `relay: None` keeps the loopback return (the client is on
/// this machine).
pub fn allow_client_oauth(name: &str, relay: Option<Relay>) -> oneshot::Receiver<String> {
    let (tx, rx) = oneshot::channel();
    cancel_client_oauth(name);
    let mode = Mode::Client(ClientSignIn { relay, announce: Mutex::new(Some(tx)) });
    gates().lock().unwrap().insert(name.to_string(), Arc::new(mode));
    rx
}

pub fn disallow_interactive_oauth(name: &str) {
    gates().lock().unwrap().remove(name);
    cancel_client_oauth(name);
}

pub fn interactive_oauth_allowed(name: &str) -> bool {
    gates().lock().unwrap().contains_key(name)
}

pub(super) fn mode(name: &str) -> Option<Arc<Mode>> {
    gates().lock().unwrap().get(name).cloned()
}

// ── codes a client brings back ──────────────────────────────────────────────

struct Pending {
    server: String,
    tx: oneshot::Sender<CodeResult>,
    at: Instant,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static S: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// A sign-in that accepts the client's code for one `state`. Register it
/// before the client learns the sign-in page: a code or Cancel that arrives
/// first must find it.
pub(super) struct ClientWait {
    server: String,
    state: String,
    rx: oneshot::Receiver<CodeResult>,
}

pub(super) fn expect_client(server: &str, state: &str) -> ClientWait {
    let (tx, rx) = oneshot::channel();
    let mut p = pending().lock().unwrap();
    p.retain(|_, f| f.at.elapsed() < CLIENT_SIGN_IN_TIMEOUT && !f.tx.is_closed());
    p.insert(state.to_string(), Pending { server: server.to_string(), tx, at: Instant::now() });
    ClientWait { server: server.to_string(), state: state.to_string(), rx }
}

impl ClientWait {
    /// Wait for the client to bring back the code.
    pub(super) async fn wait(self) -> Result<CodeResult, McpError> {
        let ClientWait { server, state, rx } = self;
        let res = tokio::time::timeout(CLIENT_SIGN_IN_TIMEOUT, rx).await;
        pending().lock().unwrap().remove(&state);
        match res {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(_)) => Err(required(format!("Sign-in to MCP server '{server}' was cancelled."))),
            Err(_) => Err(McpError::Transport("TimeoutError", "Timed out waiting for OAuth callback.".into())),
        }
    }
}

/// Why a code could not be delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinishError {
    /// No sign-in is waiting for this `state`: it expired, was cancelled,
    /// already finished, or never started here.
    Unknown,
}

/// Deliver the code a client brought back. Returns the server it signs in.
/// The `state` names one waiting sign-in exactly; it is single-use.
pub fn finish_client_oauth(state: &str, code: &str, iss: Option<&str>) -> Result<String, FinishError> {
    let flow = {
        let mut p = pending().lock().unwrap();
        let key = p.keys().find(|k| super::constant_eq(k.as_bytes(), state.as_bytes())).cloned();
        key.and_then(|k| p.remove(&k))
    };
    let Some(flow) = flow.filter(|f| f.at.elapsed() < CLIENT_SIGN_IN_TIMEOUT) else { return Err(FinishError::Unknown) };
    let server = flow.server.clone();
    let result = CodeResult { code: code.to_string(), state: Some(state.to_string()), iss: iss.filter(|s| !s.is_empty()).map(String::from) };
    flow.tx.send(result).map_err(|_| FinishError::Unknown)?;
    Ok(server)
}

/// Drop every code `name` is waiting for: its sign-in fails as cancelled.
pub fn cancel_client_oauth(name: &str) {
    pending().lock().unwrap().retain(|_, f| f.server != name);
}

// ── loopback callback ───────────────────────────────────────────────────────

#[derive(Clone)]
pub(super) struct CodeResult {
    pub code: String,
    pub state: Option<String>,
    pub iss: Option<String>,
}

pub(super) struct Loopback {
    listener: Mutex<Option<std::net::TcpListener>>,
    pub redirect_uri: String,
    /// v2 keeps the first callback's result and `done` event set, so a
    /// second authorization on the same connection re-reads it at once.
    last: Mutex<Option<Result<CodeResult, McpError>>>,
}

impl Loopback {
    pub fn bind() -> Result<Loopback, McpError> {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| McpError::Transport("OSError", e.to_string()))?;
        let port = l.local_addr().map_err(|e| McpError::Transport("OSError", e.to_string()))?.port();
        let _ = l.set_nonblocking(true);
        Ok(Loopback { listener: Mutex::new(Some(l)), redirect_uri: format!("http://localhost:{port}{CALLBACK_PATH}"), last: Mutex::new(None) })
    }

    pub async fn wait(&self) -> Result<CodeResult, McpError> {
        let timeout = || McpError::Transport("TimeoutError", "Timed out waiting for OAuth callback.".into());
        let taken = self.listener.lock().unwrap().take();
        let Some(std_l) = taken else { return self.last.lock().unwrap().clone().unwrap_or_else(|| Err(timeout())) };
        let listener = tokio::net::TcpListener::from_std(std_l).map_err(|e| McpError::Transport("OSError", e.to_string()))?;
        match tokio::time::timeout(Duration::from_secs(300), serve_callback(listener)).await {
            Ok(r) => {
                *self.last.lock().unwrap() = Some(r.clone());
                r
            }
            Err(_) => Err(timeout()),
        }
    }
}

async fn serve_callback(listener: tokio::net::TcpListener) -> Result<CodeResult, McpError> {
    use appv3_providers::plugin::write_response;
    loop {
        let Ok((mut sock, _)) = listener.accept().await else { continue };
        let target = appv3_providers::codex::read_request_target(&mut sock).await;
        let p = urlsplit(&target);
        if p.path != CALLBACK_PATH {
            write_response(&mut sock, 404, "Not Found", None).await;
            continue;
        }
        let qs = parse_qs(&p.query);
        let error = qs_first(&qs, "error");
        if !error.is_empty() {
            write_response(&mut sock, 200, "OK", Some("<h1>Authorization failed</h1><p>You can close this window.</p>".into())).await;
            return Err(McpError::Transport("RuntimeError", format!("OAuth failed: {error}")));
        }
        let (code, state, iss) = (qs_first(&qs, "code"), qs_first(&qs, "state"), qs_first(&qs, "iss"));
        write_response(&mut sock, 200, "OK", Some("<h1>Authorization successful</h1><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script>".into()))
            .await;
        return Ok(CodeResult { code, state: Some(state).filter(|s| !s.is_empty()), iss: Some(iss).filter(|s| !s.is_empty()) });
    }
}

/// `webbrowser.open(url)` — honours `$BROWSER` like Python's `webbrowser`.
pub(super) fn open_browser(url: &str) -> Result<(), String> {
    let choice = std::env::var("BROWSER").ok().and_then(|b| b.split(':').map(str::trim).find(|c| !c.is_empty()).map(String::from));
    let argv: Vec<String> = match choice {
        Some(cmdline) => {
            let parts: Vec<String> = cmdline.split_whitespace().map(String::from).collect();
            if parts.len() == 1 {
                vec![parts[0].clone(), url.to_string()]
            } else {
                parts.iter().map(|a| a.replace("%s", url)).collect()
            }
        }
        None => {
            let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
            vec![cmd.to_string(), url.to_string()]
        }
    };
    let mut child =
        appv3_core::proctree::hide_window_std(&mut std::process::Command::new(&argv[0])).args(&argv[1..]).stdin(std::process::Stdio::null()).spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
