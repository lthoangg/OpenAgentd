//! The account's other computers in this app ("Your computers" in Settings
//! → Server, and ⌘K → Switch Server…).
//!
//! The built-in server holds this computer's account keys, so it owns the
//! links to the other computers and a loopback bridge in front of each
//! (`appv3/crates/api/src/cloud/controller.rs`). Opening a computer asks it
//! for one (`POST /api/cloud/open`), then switches the window to the
//! bridge's origin like a saved server; the bridge key becomes that
//! origin's access key (`secure_get_access_key`), in memory only. The
//! bridge closes once no window uses it.
//!
//! Account calls always go to the built-in server (`desktop_cloud_call`),
//! whatever server the window shows: the account is this computer's. The
//! webview never holds the built-in server's token while it shows another
//! server; this module adds it.

use std::collections::HashMap;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::config::AppBackendStatus;
use crate::servers::ServerId;
use crate::AppState;

/// The computer an account bridge reaches, as the built-in server named it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountDevice {
    pub device_id: String,
    pub fingerprint: String,
    /// "macos", … when the account said (a label, never a check).
    pub kind: Option<String>,
}

impl AccountDevice {
    /// "macOS · 3F9A 21C4": what lists call it (the web UI's `deviceLabel`).
    pub fn label(&self) -> String {
        let kind = match self.kind.as_deref() {
            Some("macos") => Some("macOS"),
            Some("linux") => Some("Linux"),
            Some("windows") => Some("Windows"),
            Some("ios") => Some("iOS"),
            Some("android") => Some("Android"),
            _ => None,
        };
        kind.into_iter()
            .chain([self.fingerprint.as_str()])
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

struct BridgeEntry {
    key: String,
    device: AccountDevice,
}

/// Open bridges by origin (`http://127.0.0.1:<port>`).
fn bridges() -> &'static StdMutex<HashMap<String, BridgeEntry>> {
    static B: OnceLock<StdMutex<HashMap<String, BridgeEntry>>> = OnceLock::new();
    B.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn origin_of(base: &str) -> String {
    base.trim()
        .trim_end_matches('/')
        .trim_end_matches("/api")
        .to_string()
}

/// The bridge key for a bridge origin (the web UI's access key for it).
pub fn bridge_key(origin: &str) -> Option<String> {
    bridges()
        .lock()
        .unwrap()
        .get(&origin_of(origin))
        .map(|b| b.key.clone())
}

/// The account computer behind `base`, when it is an open bridge.
pub fn account_device(base: &str) -> Option<AccountDevice> {
    bridges()
        .lock()
        .unwrap()
        .get(&origin_of(base))
        .map(|b| b.device.clone())
}

/// Every open bridge's origin and computer.
pub fn bridged_devices() -> Vec<(String, AccountDevice)> {
    bridges()
        .lock()
        .unwrap()
        .iter()
        .map(|(o, b)| (o.clone(), b.device.clone()))
        .collect()
}

/// One client for calls to the built-in server: no total timeout of its
/// own (approving waits up to 3 minutes for the other device).
fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    })
}

/// Said when the built-in server is not running: it holds the account.
pub const BUILTIN_STOPPED: &str = "The built-in server is stopped. Your account lives there: start it to use your other computers.";

/// What the built-in server answered: its status and body.
#[derive(Debug, Serialize)]
pub struct CloudAnswer {
    pub status: u16,
    pub body: String,
}

/// An account route the web UI may call: `/status`, `/devices`, … under
/// `/api/cloud`. Nothing else goes through here.
fn valid_cloud_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 64
        && !path.contains("//")
        && path[1..].split('/').all(|seg| {
            !seg.is_empty()
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'-')
        })
}

/// Calls `/api/cloud{path}` on the built-in server with its token.
async fn builtin_call(
    app: &AppHandle,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    proof: Option<&str>,
    timeout: Duration,
) -> Result<CloudAnswer, String> {
    if !valid_cloud_path(path) {
        return Err("Unknown account route.".into());
    }
    let Some((base, token)) = crate::servers::endpoint(app, &ServerId::Bundled).await else {
        return Err(BUILTIN_STOPPED.into());
    };
    let url = format!("{}/api/cloud{path}", base.trim_end_matches('/'));
    let mut request = match method {
        "GET" => client().get(url),
        "POST" => client().post(url),
        _ => return Err("Unknown method.".into()),
    }
    .timeout(timeout);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(proof) = proof {
        request = request.header("X-Agentd-Approval", proof);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The built-in server did not answer.".to_string())?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|_| "The built-in server did not answer.".to_string())?;
    Ok(CloudAnswer { status, body })
}

/// The `detail` of an error answer, else a plain message.
fn detail_of(answer: &CloudAnswer) -> String {
    serde_json::from_str::<serde_json::Value>(&answer.body)
        .ok()
        .and_then(|v| v["detail"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("The built-in server answered {}.", answer.status))
}

/// The web UI's account calls (`web/src/api/cloud.ts`): always to the
/// built-in server, whatever server the window shows.
#[tauri::command]
pub async fn desktop_cloud_call(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    method: String,
    body: Option<serde_json::Value>,
    proof: Option<String>,
) -> Result<CloudAnswer, String> {
    if crate::window::is_overlay_window(window.label()) {
        return Err("Only app windows can use the account.".into());
    }
    builtin_call(
        &app,
        &method,
        &path,
        body,
        proof.as_deref(),
        Duration::from_secs(200),
    )
    .await
}

/// Tells the links that the app came back or the network changed.
#[tauri::command]
pub async fn cloud_poke(app: AppHandle, why: String) -> Result<(), String> {
    if !matches!(why.as_str(), "resumed" | "network_changed" | "user_retry") {
        // `background`: the notch still shows sessions, so links keep going.
        return Ok(());
    }
    let _ = builtin_call(
        &app,
        "POST",
        "/poke",
        Some(serde_json::json!({ "why": why })),
        None,
        Duration::from_secs(5),
    )
    .await;
    Ok(())
}

#[derive(Serialize)]
pub struct OpenedComputer {
    status: AppBackendStatus,
    /// "lan" when its saved address answered, else "account".
    via: &'static str,
}

/// How long the saved LAN address has to answer before the account is used.
const LAN_ANSWER_WITHIN: Duration = Duration::from_millis(400);

/// Whether the saved LAN address answers within [`LAN_ANSWER_WITHIN`] and
/// accepts the access key stored for it (as the phone checks).
async fn lan_answers(lan: &str) -> bool {
    let base = lan.trim_end_matches('/');
    let live = client()
        .get(format!("{base}/api/health/live"))
        .timeout(LAN_ANSWER_WITHIN)
        .send()
        .await
        .is_ok_and(|r| r.status().is_success());
    if !live {
        return false;
    }
    let key = crate::commands::secure_get_access_key(base.to_string())
        .await
        .ok()
        .flatten();
    let mut check = client()
        .get(format!("{base}/api/auth/check"))
        .timeout(Duration::from_secs(2));
    if let Some(key) = key {
        check = check.bearer_auth(key);
    }
    check
        .send()
        .await
        .is_ok_and(|r| r.status().is_success() || r.status().as_u16() == 404)
}

#[derive(Deserialize)]
struct Opened {
    origin: String,
    key: String,
    device: AccountDevice,
}

/// Opens a computer of the account in this window: over its saved LAN
/// address when that answers fast and takes its key, else through the
/// account (the built-in server's link and bridge). The same command as the
/// phone's, so the web UI's `connectAccountComputer` serves both.
#[tauri::command]
pub async fn cloud_open_computer(
    app: AppHandle,
    window: tauri::WebviewWindow,
    device_id: String,
    lan_base_url: Option<String>,
) -> Result<OpenedComputer, String> {
    if crate::window::is_overlay_window(window.label()) {
        return Err("Only app windows can open a computer.".into());
    }
    if let Some(lan) =
        lan_base_url.and_then(|u| crate::config::normalize_external_base_url(&u).ok())
    {
        if lan_answers(&lan).await {
            let status = crate::commands::point_window_at(&app, &window, &lan).await?;
            return Ok(OpenedComputer { status, via: "lan" });
        }
    }
    let answer = builtin_call(
        &app,
        "POST",
        "/open",
        Some(serde_json::json!({ "device_id": device_id })),
        None,
        Duration::from_secs(30),
    )
    .await?;
    if !(200..300).contains(&answer.status) {
        return Err(detail_of(&answer));
    }
    let opened: Opened = serde_json::from_str(&answer.body)
        .map_err(|_| "The built-in server answered something unexpected.".to_string())?;
    let origin = origin_of(&opened.origin);
    let local = url::Url::parse(&origin)
        .ok()
        .is_some_and(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1"));
    if !local {
        return Err("The built-in server answered something unexpected.".into());
    }
    bridges().lock().unwrap().insert(
        origin.clone(),
        BridgeEntry {
            key: opened.key,
            device: opened.device,
        },
    );
    let status = crate::commands::point_window_at(&app, &window, &origin).await?;
    Ok(OpenedComputer {
        status,
        via: "account",
    })
}

/// Closes the bridges no window uses any more (a window switched away or
/// closed). The built-in server ends their links.
pub fn release_unused(app: &AppHandle) {
    let used: Vec<String> = app
        .state::<AppState>()
        .window_backend_base_urls
        .lock()
        .unwrap()
        .values()
        .map(|b| origin_of(b))
        .collect();
    let unused: Vec<AccountDevice> = {
        let mut map = bridges().lock().unwrap();
        let gone: Vec<String> = map.keys().filter(|o| !used.contains(o)).cloned().collect();
        gone.into_iter()
            .filter_map(|o| map.remove(&o))
            .map(|b| b.device)
            .collect()
    };
    if unused.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for device in unused {
            let _ = builtin_call(
                &app,
                "POST",
                "/close",
                Some(serde_json::json!({ "device_id": device.device_id })),
                None,
                Duration::from_secs(5),
            )
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_account_routes_go_to_the_built_in_server() {
        for p in [
            "/status",
            "/devices",
            "/approve/begin",
            "/invite/poll",
            "/devices/remove",
        ] {
            assert!(valid_cloud_path(p), "{p}");
        }
        for p in [
            "",
            "status",
            "/",
            "//status",
            "/../agent",
            "/status?x=1",
            "/Status",
            "/a b",
            "/devices/",
        ] {
            assert!(!valid_cloud_path(p), "{p}");
        }
    }

    #[test]
    fn a_computer_is_named_like_its_row() {
        let d = |kind: Option<&str>| AccountDevice {
            device_id: "d".into(),
            fingerprint: "3F9A 21C4".into(),
            kind: kind.map(String::from),
        };
        assert_eq!(d(Some("macos")).label(), "macOS · 3F9A 21C4");
        assert_eq!(
            d(Some("plan9")).label(),
            "3F9A 21C4",
            "free text is never shown"
        );
        assert_eq!(d(None).label(), "3F9A 21C4");
    }

    #[test]
    fn a_bridge_is_found_by_its_origin_and_its_key_stays_in_memory() {
        let origin = "http://127.0.0.1:59999";
        let device = AccountDevice {
            device_id: "dev".into(),
            fingerprint: "AAAA BBBB".into(),
            kind: None,
        };
        bridges().lock().unwrap().insert(
            origin.into(),
            BridgeEntry {
                key: "k".into(),
                device: device.clone(),
            },
        );
        assert_eq!(bridge_key("http://127.0.0.1:59999/").as_deref(), Some("k"));
        assert_eq!(account_device("http://127.0.0.1:59999/api"), Some(device));
        assert_eq!(bridge_key("http://127.0.0.1:59998"), None);
        bridges().lock().unwrap().remove(origin);
    }

    #[test]
    fn an_error_answer_shows_its_detail() {
        let a = CloudAnswer {
            status: 409,
            body: r#"{"detail":"This computer is offline, or not signed in to your account."}"#
                .into(),
        };
        assert_eq!(
            detail_of(&a),
            "This computer is offline, or not signed in to your account."
        );
        assert_eq!(
            detail_of(&CloudAnswer {
                status: 502,
                body: "nope".into()
            }),
            "The built-in server answered 502."
        );
    }
}
