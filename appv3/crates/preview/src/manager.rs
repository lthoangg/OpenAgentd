//! Preview registry: one listener per (workspace, backend).

use crate::agent::AgentChannel;
use crate::console::{ConsoleBuffer, ConsoleEntry};
use crate::target::Backend;
use appv3_tools::denied::DeniedPaths;
use serde::Serialize;
use std::collections::VecDeque;
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

/// Most listeners kept open at once; the least recently used one closes.
pub const MAX_PREVIEWS: usize = 8;
/// A preview with no open connection closes after this long.
pub const IDLE_SECS: u64 = 30 * 60;
/// Most extra loopback ports (device relays) one preview answers on.
pub const MAX_ALIAS_PORTS: usize = 4;
/// Most tunnels (`/api/preview/{id}/tunnel`) open into one preview.
pub const MAX_TUNNELS: usize = 32;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PreviewInfo {
    pub id: String,
    pub workspace: String,
    /// `url` for a dev server, `file` for a workspace directory.
    pub kind: &'static str,
    /// The proxied origin, or the served directory.
    pub target: String,
    pub port: u16,
    /// Where the iframe loads the preview from.
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewError {
    Invalid(String),
    Bind(String),
}

impl fmt::Display for PreviewError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PreviewError::Invalid(m) | PreviewError::Bind(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for PreviewError {}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub struct Entry {
    pub id: String,
    pub workspace: String,
    pub backend: Backend,
    pub port: u16,
    /// Denied-path rules for static previews.
    pub(crate) denied: Option<DeniedPaths>,
    last_active: AtomicU64,
    active: AtomicUsize,
    console: Mutex<ConsoleBuffer>,
    /// Commands from the agent to the page open in the Preview tab.
    pub agent: AgentChannel,
    /// Ports of device relays that reach this listener through a tunnel:
    /// their pages send `Host: 127.0.0.1:<relay port>`.
    alias_ports: Mutex<VecDeque<u16>>,
    tunnels: AtomicUsize,
    stop: watch::Sender<bool>,
}

/// Marks a request or WebSocket as in flight; the preview is not idle while
/// one is alive.
pub struct ActiveGuard(Arc<Entry>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        self.0.touch();
    }
}

/// One open tunnel into a preview; frees its slot when dropped.
pub struct TunnelSlot(Arc<Entry>);

impl Drop for TunnelSlot {
    fn drop(&mut self) {
        self.0.tunnels.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Entry {
    pub fn info(&self) -> PreviewInfo {
        let (kind, target) = match &self.backend {
            Backend::Upstream(t) => ("url", t.origin()),
            Backend::Static(root) => ("file", root.display().to_string()),
        };
        PreviewInfo { id: self.id.clone(), workspace: self.workspace.clone(), kind, target, port: self.port, origin: format!("http://127.0.0.1:{}", self.port) }
    }

    fn touch(&self) {
        self.last_active.store(now_secs(), Ordering::SeqCst);
    }

    pub fn begin(self: &Arc<Self>) -> ActiveGuard {
        self.active.fetch_add(1, Ordering::SeqCst);
        self.touch();
        ActiveGuard(self.clone())
    }

    pub fn stop_rx(&self) -> watch::Receiver<bool> {
        self.stop.subscribe()
    }

    /// Answer `Host: 127.0.0.1:<port>` too (a device relay's origin). Ports
    /// at or below 1024 are refused; the oldest alias drops past
    /// [`MAX_ALIAS_PORTS`].
    pub fn add_alias_port(&self, port: u16) -> bool {
        if port <= 1024 {
            return false;
        }
        let mut aliases = self.alias_ports.lock().unwrap_or_else(|e| e.into_inner());
        aliases.retain(|p| *p != port);
        if aliases.len() >= MAX_ALIAS_PORTS {
            aliases.pop_front();
        }
        aliases.push_back(port);
        true
    }

    /// Whether a loopback `Host` on `port` addresses this listener.
    pub fn accepts_port(&self, port: u16) -> bool {
        port == self.port || self.alias_ports.lock().unwrap_or_else(|e| e.into_inner()).contains(&port)
    }

    /// A tunnel slot, or `None` when [`MAX_TUNNELS`] are already open.
    pub fn reserve_tunnel(self: &Arc<Self>) -> Option<TunnelSlot> {
        let prev = self.tunnels.fetch_add(1, Ordering::SeqCst);
        if prev >= MAX_TUNNELS {
            self.tunnels.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(TunnelSlot(self.clone()))
    }

    fn close(&self) {
        let _ = self.stop.send(true);
    }

    pub fn push_console(&self, entries: Vec<ConsoleEntry>) {
        let mut buf = self.console.lock().unwrap_or_else(|e| e.into_inner());
        for e in entries {
            buf.push(e);
        }
    }

    pub fn console(&self) -> Vec<ConsoleEntry> {
        self.console.lock().unwrap_or_else(|e| e.into_inner()).entries()
    }

    pub fn console_error_count(&self) -> usize {
        self.console.lock().unwrap_or_else(|e| e.into_inner()).error_count()
    }

    pub fn clear_console(&self) {
        self.console.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[derive(Default)]
pub struct Manager {
    entries: Mutex<Vec<Arc<Entry>>>,
    blocked_ports: Mutex<Vec<u16>>,
    reaper_started: AtomicBool,
}

static GLOBAL: OnceLock<Manager> = OnceLock::new();

/// The process-wide preview registry.
pub fn global() -> &'static Manager {
    GLOBAL.get_or_init(|| {
        let m = Manager::default();
        // The configured API port is blocked even before the server binds.
        m.block_port(appv3_core::settings().api_port);
        m
    })
}

impl Manager {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Arc<Entry>>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn block_port(&self, port: u16) {
        let mut b = self.blocked_ports.lock().unwrap_or_else(|e| e.into_inner());
        if !b.contains(&port) {
            b.push(port);
        }
    }

    fn check_target(&self, backend: &Backend) -> Result<(), PreviewError> {
        let Backend::Upstream(t) = backend else { return Ok(()) };
        let blocked = self.blocked_ports.lock().unwrap_or_else(|e| e.into_inner()).contains(&t.port);
        if blocked {
            return Err(PreviewError::Invalid(format!("Port {} is the OpenAgentd API and cannot be previewed.", t.port)));
        }
        if self.lock().iter().any(|e| e.port == t.port) {
            return Err(PreviewError::Invalid(format!("Port {} is another preview and cannot be previewed.", t.port)));
        }
        Ok(())
    }

    /// The preview for `backend` in `workspace`, starting its listener if
    /// needed. `preferred_port` keeps a target on the same origin (and so the
    /// same cookies and storage) across restarts when that port is free.
    pub async fn ensure(&'static self, workspace: &str, backend: Backend, preferred_port: Option<u16>) -> Result<PreviewInfo, PreviewError> {
        self.ensure_inner(workspace, backend, preferred_port, true).await
    }

    async fn ensure_inner(&'static self, workspace: &str, backend: Backend, preferred_port: Option<u16>, reaper: bool) -> Result<PreviewInfo, PreviewError> {
        self.check_target(&backend)?;
        if let Some(e) = self.find(workspace, &backend) {
            e.touch();
            return Ok(e.info());
        }
        let listener = bind(preferred_port).await?;
        let port = listener.local_addr().map_err(|e| PreviewError::Bind(e.to_string()))?.port();
        let denied = match &backend {
            Backend::Static(root) => Some(DeniedPaths::new(root, None)),
            Backend::Upstream(_) => None,
        };
        let (stop, stop_rx) = watch::channel(false);
        let entry = Arc::new(Entry {
            id: uuid::Uuid::new_v4().to_string(),
            workspace: workspace.to_string(),
            backend: backend.clone(),
            port,
            denied,
            last_active: AtomicU64::new(now_secs()),
            active: AtomicUsize::new(0),
            console: Mutex::new(ConsoleBuffer::default()),
            agent: AgentChannel::default(),
            alias_ports: Mutex::new(VecDeque::new()),
            tunnels: AtomicUsize::new(0),
            stop,
        });
        {
            let mut entries = self.lock();
            // Another request may have started the same preview meanwhile.
            if let Some(e) = entries.iter().find(|e| e.workspace == workspace && e.backend == backend) {
                return Ok(e.info());
            }
            if entries.len() >= MAX_PREVIEWS {
                let victim = entries.iter().enumerate().min_by_key(|(_, e)| (e.active.load(Ordering::SeqCst) > 0, e.last_active.load(Ordering::SeqCst))).map(|(i, _)| i);
                if let Some(i) = victim {
                    let old = entries.remove(i);
                    tracing::info!("preview_evicted id={} port={}", old.id, old.port);
                    old.close();
                }
            }
            entries.push(entry.clone());
        }
        tracing::info!("preview_started id={} port={} target={}", entry.id, port, entry.info().target);
        tokio::spawn(crate::proxy::serve(listener, entry.clone(), stop_rx));
        if reaper && !self.reaper_started.swap(true, Ordering::SeqCst) {
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    self.reap(now_secs(), IDLE_SECS);
                }
            });
        }
        Ok(entry.info())
    }

    fn find(&self, workspace: &str, backend: &Backend) -> Option<Arc<Entry>> {
        self.lock().iter().find(|e| e.workspace == workspace && &e.backend == backend).cloned()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Entry>> {
        self.lock().iter().find(|e| e.id == id).cloned()
    }

    /// Previews of `workspace` (every preview when `None`).
    pub fn list(&self, workspace: Option<&str>) -> Vec<Arc<Entry>> {
        self.lock().iter().filter(|e| workspace.is_none_or(|w| e.workspace == w)).cloned().collect()
    }

    pub fn close(&self, id: &str) -> bool {
        let mut entries = self.lock();
        let Some(i) = entries.iter().position(|e| e.id == id) else { return false };
        let e = entries.remove(i);
        tracing::info!("preview_closed id={} port={}", e.id, e.port);
        e.close();
        true
    }

    /// Close previews with no connection and no activity for `idle_secs`.
    fn reap(&self, now: u64, idle_secs: u64) -> Vec<String> {
        let mut entries = self.lock();
        let (idle, keep): (Vec<_>, Vec<_>) =
            entries.drain(..).partition(|e| e.active.load(Ordering::SeqCst) == 0 && now.saturating_sub(e.last_active.load(Ordering::SeqCst)) >= idle_secs);
        *entries = keep;
        idle.iter()
            .map(|e| {
                tracing::info!("preview_idle_closed id={} port={}", e.id, e.port);
                e.close();
                e.id.clone()
            })
            .collect()
    }

    pub fn shutdown(&self) {
        for e in self.lock().drain(..) {
            e.close();
        }
    }
}

async fn bind(preferred: Option<u16>) -> Result<tokio::net::TcpListener, PreviewError> {
    if let Some(p) = preferred.filter(|p| *p > 1024) {
        if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
            return Ok(l);
        }
    }
    tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| PreviewError::Bind(format!("Could not start the preview listener: {e}")))
}

/// A static backend for `root`, which must be an existing directory.
pub fn static_backend(root: &Path) -> Backend {
    Backend::Static(appv3_tools::denied::resolve(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::parse_url_target;

    fn leak() -> &'static Manager {
        Box::leak(Box::default())
    }

    fn upstream(raw: &str) -> Backend {
        Backend::Upstream(parse_url_target(raw).unwrap().0)
    }

    #[tokio::test]
    async fn reuses_the_preview_for_the_same_target() {
        let m = leak();
        let a = m.ensure_inner("/w", upstream("http://localhost:5173"), None, false).await.unwrap();
        let b = m.ensure_inner("/w", upstream("http://localhost:5173/other"), None, false).await.unwrap();
        let c = m.ensure_inner("/w", upstream("http://localhost:3000"), None, false).await.unwrap();
        let d = m.ensure_inner("/x", upstream("http://localhost:5173"), None, false).await.unwrap();
        assert_eq!(a.id, b.id);
        assert_ne!(a.id, c.id);
        assert_ne!(a.id, d.id);
        assert_eq!(a.origin, format!("http://127.0.0.1:{}", a.port));
        assert_eq!(m.list(Some("/w")).len(), 2);
        m.shutdown();
    }

    #[tokio::test]
    async fn refuses_the_api_port_and_other_previews() {
        let m = leak();
        m.block_port(4082);
        assert!(m.ensure_inner("/w", upstream("http://127.0.0.1:4082"), None, false).await.is_err());
        let a = m.ensure_inner("/w", upstream("http://localhost:5173"), None, false).await.unwrap();
        let err = m.ensure_inner("/w", upstream(&format!("http://127.0.0.1:{}", a.port)), None, false).await.unwrap_err();
        assert!(err.to_string().contains("another preview"));
        m.shutdown();
    }

    #[tokio::test]
    async fn uses_a_free_preferred_port() {
        let m = leak();
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let a = m.ensure_inner("/w", upstream("http://localhost:5173"), Some(port), false).await.unwrap();
        assert_eq!(a.port, port);
        m.shutdown();
    }

    #[tokio::test]
    async fn evicts_the_least_recently_used_preview() {
        let m = leak();
        let first = m.ensure_inner("/w", upstream("http://localhost:9000"), None, false).await.unwrap();
        m.get(&first.id).unwrap().last_active.store(1, Ordering::SeqCst);
        for i in 1..MAX_PREVIEWS {
            m.ensure_inner("/w", upstream(&format!("http://localhost:{}", 9000 + i)), None, false).await.unwrap();
        }
        assert!(m.get(&first.id).is_some());
        m.ensure_inner("/w", upstream("http://localhost:9999"), None, false).await.unwrap();
        assert!(m.get(&first.id).is_none());
        assert_eq!(m.list(None).len(), MAX_PREVIEWS);
        m.shutdown();
    }

    #[tokio::test]
    async fn close_and_reap() {
        let m = leak();
        let a = m.ensure_inner("/w", upstream("http://localhost:5173"), None, false).await.unwrap();
        let b = m.ensure_inner("/w", upstream("http://localhost:3000"), None, false).await.unwrap();
        let busy = m.get(&b.id).unwrap();
        let _guard = busy.begin();
        assert_eq!(m.reap(now_secs() + IDLE_SECS + 1, IDLE_SECS), vec![a.id.clone()]);
        assert!(m.get(&b.id).is_some());
        assert!(m.close(&b.id));
        assert!(!m.close(&b.id));
    }

    #[tokio::test]
    async fn alias_ports_and_tunnel_slots() {
        let m = leak();
        let a = m.ensure_inner("/w", upstream("http://localhost:5173"), None, false).await.unwrap();
        let e = m.get(&a.id).unwrap();
        assert!(e.accepts_port(a.port));
        assert!(!e.accepts_port(40001));
        assert!(!e.add_alias_port(80));
        assert!(e.add_alias_port(40001));
        assert!(e.accepts_port(40001));
        for p in 40002..40002 + MAX_ALIAS_PORTS as u16 {
            e.add_alias_port(p);
        }
        assert!(!e.accepts_port(40001), "the oldest alias drops past the cap");
        assert!(e.accepts_port(40002 + MAX_ALIAS_PORTS as u16 - 1));

        let slots: Vec<_> = (0..MAX_TUNNELS).map(|_| e.reserve_tunnel().unwrap()).collect();
        assert!(e.reserve_tunnel().is_none());
        drop(slots);
        assert!(e.reserve_tunnel().is_some());
        m.shutdown();
    }
}
