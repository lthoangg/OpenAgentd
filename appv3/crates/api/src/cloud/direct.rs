//! Direct sessions into this host on the home network (spec 5.5): the
//! person's switch, the listener on the private addresses, and the answer
//! that tells a session's device where to reach this host.
//!
//! Separate from LAN access (`network_access.rs`): another socket, another
//! port, another switch. This listener speaks only the tunnel protocol, so
//! it accepts no access key, and the LAN listener accepts no device key.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use openagentd_cloud::direct::{self, DirectAnswer, Gate, HostKeys};
use openagentd_cloud::relay::{HostHandler, Join, Keepalive, Sessions};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// How often the listener looks at the interfaces again (an address came
/// or went) and at the switch.
const RESCAN: Duration = Duration::from_secs(30);

/// What `cloud/direct.json` keeps: the switch and the port in use, so a
/// controller's remembered port stays right across launches. Not secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setting {
    pub on: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

impl Default for Setting {
    /// On by default (for a device with `server: true`; the listener runs
    /// only for one).
    fn default() -> Self {
        Setting { on: true, port: None }
    }
}

fn setting_path() -> PathBuf {
    appv3_core::settings().state_dir.join("cloud").join("direct.json")
}

pub fn setting() -> Setting {
    setting_from(std::fs::read(setting_path()))
}

/// No file: the default (on). A file that can't be read or parsed: off, so
/// a switch the person turned off never comes back on by itself.
fn setting_from(read: std::io::Result<Vec<u8>>) -> Setting {
    match read {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Setting::default(),
        Err(_) => Setting { on: false, port: None },
        Ok(b) => serde_json::from_slice(&b).unwrap_or(Setting { on: false, port: None }),
    }
}

fn save_setting(s: Setting) {
    let path = setting_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, serde_json::to_vec(&s).unwrap_or_default()) {
        tracing::warn!("cloud_direct_setting_save_failed error={e}");
    }
}

/// Turns direct sessions on or off (Settings → Server, local callers
/// only). Off closes the listener and every live direct session.
pub fn set_enabled(on: bool) -> Setting {
    let s = Setting { on, ..setting() };
    save_setting(s);
    if !on {
        super::direct_sessions().close_all(1000);
    }
    wake().notify_one();
    s
}

fn wake() -> &'static Notify {
    static WAKE: std::sync::OnceLock<Notify> = std::sync::OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// The port the listener is on, while it runs.
fn listening() -> &'static std::sync::Mutex<Option<u16>> {
    static PORT: std::sync::OnceLock<std::sync::Mutex<Option<u16>>> = std::sync::OnceLock::new();
    PORT.get_or_init(Default::default)
}

/// The port direct sessions are accepted on right now, if any (shown next
/// to the switch).
pub fn listening_port() -> Option<u16> {
    *listening().lock().expect("direct port")
}

/// What `GET /api/cloud/direct` answers a session's device: the port and
/// this host's private addresses, or off.
pub fn answer() -> DirectAnswer {
    let port = *listening().lock().expect("direct port");
    match port {
        Some(port) if setting().on && super::direct_admits() => DirectAnswer::on(port, direct::local_subnets().into_iter().map(|s| s.ip)),
        _ => DirectAnswer::off(),
    }
}

/// Runs the listener while the host runs: binds the private addresses,
/// looks again every [`RESCAN`] or when the switch changes, and serves each
/// connection that passes the gate. Dropped (aborted) with the host's run.
pub async fn run(keys: Arc<HostKeys>, handler: Arc<dyn HostHandler>, sessions: Sessions) {
    let gate = Gate::default();
    let mut bound: HashMap<IpAddr, Listening> = HashMap::new();
    loop {
        let s = setting();
        if s.on && super::direct_admits() {
            let want: Vec<IpAddr> = direct::local_subnets().into_iter().map(|s| s.ip).collect();
            bound.retain(|ip, _| want.contains(ip));
            let mut port = *listening().lock().expect("direct port");
            for ip in want {
                if bound.contains_key(&ip) {
                    continue;
                }
                let Some((l, p)) = bind(ip, port.or(s.port)).await else { continue };
                if port.is_none() {
                    port = Some(p);
                    if s.port != Some(p) {
                        save_setting(Setting { port: Some(p), ..s });
                    }
                }
                let task = tokio::spawn(accept_loop(l, keys.clone(), handler.clone(), sessions.clone(), gate.clone()));
                bound.insert(ip, Listening(task));
            }
            *listening().lock().expect("direct port") = if bound.is_empty() { None } else { port };
        } else {
            // Off, or the account says no (including 7 days without the
            // cloud): stop listening and end live sessions (Go Away 0).
            bound.clear();
            *listening().lock().expect("direct port") = None;
            sessions.close_all(1000);
        }
        tokio::select! {
            _ = tokio::time::sleep(RESCAN) => {}
            _ = wake().notified() => {}
        }
    }
}

/// Binds `ip` on `port`, else on [`direct::DEFAULT_PORT`], else on a port
/// the system picks (only when no port is in use yet).
async fn bind(ip: IpAddr, port: Option<u16>) -> Option<(TcpListener, u16)> {
    let tries: Vec<u16> = match port {
        Some(p) => vec![p],
        None => vec![direct::DEFAULT_PORT, 0],
    };
    for p in tries {
        match TcpListener::bind(SocketAddr::new(ip, p)).await {
            Ok(l) => {
                let port = l.local_addr().ok()?.port();
                return Some((l, port));
            }
            Err(e) => tracing::debug!("cloud_direct_bind_failed port={p} error={e}"),
        }
    }
    None
}

struct Listening(JoinHandle<()>);

impl Drop for Listening {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn accept_loop(l: TcpListener, keys: Arc<HostKeys>, handler: Arc<dyn HostHandler>, sessions: Sessions, gate: Gate) {
    loop {
        let Ok((tcp, peer)) = l.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let Ok(local) = tcp.local_addr() else { continue };
        // Private on both ends only, and a place among the unfinished
        // handshakes; anything else closes with nothing sent.
        if !direct::acceptable(local, peer) {
            continue;
        }
        let Some(pass) = gate.enter(peer.ip()) else { continue };
        let _ = tcp.set_nodelay(true);
        let (keys, handler, sessions) = (keys.clone(), handler.clone(), sessions.clone());
        tokio::spawn(async move {
            // The place is held until a transport message decrypts: a
            // replayed message 1 never counts as a session.
            let accepted = match direct::accept(tcp, &keys, handler.as_ref()).await {
                Ok((io, transport, from)) => direct::confirm(io, transport).await.map(|(io, t, first)| (io, t, first, from)),
                Err(e) => Err(e),
            };
            drop(pass);
            match accepted {
                Ok((io, transport, first, from)) => {
                    tracing::info!("cloud_direct_session_opened");
                    let _ = direct::serve_accepted(io, transport, first, from, handler, sessions, Join::default(), Keepalive::default()).await;
                }
                Err(e) => tracing::debug!("cloud_direct_refused reason={e}"),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_means_on_and_a_broken_one_off() {
        let missing = Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(setting_from(missing).on);
        assert!(!setting_from(Ok(b"{not json".to_vec())).on);
        assert!(!setting_from(Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))).on);
        assert_eq!(setting_from(Ok(br#"{"on":false,"port":4181}"#.to_vec())), Setting { on: false, port: Some(4181) });
    }

    #[test]
    fn the_setting_is_on_by_default_and_reads_old_files() {
        assert_eq!(Setting::default(), Setting { on: true, port: None });
        let s: Setting = serde_json::from_str(r#"{"on":false}"#).unwrap();
        assert_eq!(s, Setting { on: false, port: None });
        assert_eq!(serde_json::to_string(&Setting { on: true, port: Some(4181) }).unwrap(), r#"{"on":true,"port":4181}"#);
    }
}
