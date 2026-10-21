//! Session manager — port of `app/services/agent_manager.py`.

use crate::loader::{self, ProviderFactory};
use crate::session::AgentSession;
use appv3_core::settings::settings;
use appv3_db::DbPool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const SESSION_IDLE_SECONDS: u64 = 30 * 60;

type Key = (String, String);

struct Manager {
    pool: DbPool,
    factory: ProviderFactory,
    sessions: Mutex<HashMap<Key, Arc<AgentSession>>>,
    last_used: Mutex<HashMap<Key, Instant>>,
    start_locks: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<()>>>>,
    lock: tokio::sync::Mutex<()>,
}

static MANAGER: OnceLock<Manager> = OnceLock::new();

/// Install the process-wide manager (call once at startup).
pub fn init(pool: DbPool, factory: ProviderFactory) {
    let _ = MANAGER.set(Manager {
        pool,
        factory,
        sessions: Mutex::new(HashMap::new()),
        last_used: Mutex::new(HashMap::new()),
        start_locks: Mutex::new(HashMap::new()),
        lock: tokio::sync::Mutex::new(()),
    });
}

fn mgr() -> &'static Manager {
    MANAGER.get().expect("agent manager not initialised")
}

pub fn pool() -> DbPool {
    mgr().pool.clone()
}

pub fn provider_factory() -> ProviderFactory {
    mgr().factory.clone()
}

const BLOCKED: &[&str] = &["/etc", "/proc", "/sys", "/dev", "/run", "/boot", "/sbin", "/bin", "/usr/bin", "/usr/sbin", "/private/etc"];

fn expanduser(p: &str) -> PathBuf {
    appv3_core::home::expanduser(p)
}

/// `validate_workspace`.
pub fn validate_workspace(workspace: &str, require_exists: bool) -> Result<String, String> {
    let resolved = appv3_tools::denied::resolve(&expanduser(workspace));
    if require_exists && !resolved.is_dir() {
        return Err(format!("Workspace does not exist or is not a directory: {}", resolved.display()));
    }
    for b in BLOCKED {
        if resolved.starts_with(b) {
            return Err(format!("Workspace '{}' is inside a restricted system directory.", resolved.display()));
        }
    }
    Ok(resolved.display().to_string())
}

pub fn resolve_agents_dir() -> PathBuf {
    let p = &settings().agents_dir;
    if p.is_absolute() {
        p.clone()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
}

/// `validate_agents_dir` (no cache: the check is cheap).
pub fn validate_agents_dir(dir: Option<&Path>) -> Result<bool, String> {
    let resolved = appv3_tools::denied::resolve(&dir.map(Path::to_path_buf).unwrap_or_else(resolve_agents_dir));
    if !resolved.is_dir() {
        return Ok(false);
    }
    let canonical = resolved.join("code.md");
    if !canonical.is_file() {
        return Ok(false);
    }
    loader::validate_canonical_code_profile(&canonical)?;
    Ok(true)
}

fn evictable(s: &AgentSession) -> bool {
    let st = s.state();
    st != "working" && st != "waiting_input" && !s.is_busy()
}

pub async fn evict_idle_sessions(now: Option<Instant>) {
    let m = mgr();
    let now = now.unwrap_or_else(Instant::now);
    let cutoff = Duration::from_secs(SESSION_IDLE_SECONDS);
    // Idle since the later of the last lookup and the last turn's end: a
    // turn can run far longer than the cutoff without any lookup, and
    // evicting right after it ends would drop its idle-compaction timer.
    let idle = |k: &Key, s: &AgentSession, last: &HashMap<Key, Instant>| last.get(k).is_some_and(|t| now.saturating_duration_since((*t).max(s.last_turn_activity())) >= cutoff);
    let to_stop: Vec<Arc<AgentSession>> = {
        let _g = m.lock.lock().await;
        let mut sessions = m.sessions.lock().unwrap();
        let mut last = m.last_used.lock().unwrap();
        let mut keys: Vec<Key> = sessions.iter().filter(|(k, s)| idle(k, s, &last) && evictable(s)).map(|(k, _)| k.clone()).collect();
        keys.sort();
        let mut out = vec![];
        for k in keys {
            if let Some(s) = sessions.remove(&k) {
                out.push(s);
            }
            last.remove(&k);
            m.start_locks.lock().unwrap().remove(&k);
        }
        out
    };
    for s in to_stop {
        s.stop().await;
    }
}

pub fn find_live_session(workspace: &str, session_id: Option<&str>) -> Option<Arc<AgentSession>> {
    let resolved = validate_workspace(workspace, false).ok()?;
    let sessions = mgr().sessions.lock().unwrap();
    match session_id.filter(|s| !s.is_empty()) {
        Some(sid) => sessions.get(&(resolved, sid.to_string())).cloned(),
        None => sessions.iter().find(|((ws, _), _)| *ws == resolved).map(|(_, s)| s.clone()),
    }
}

pub fn find_live_session_serving_session(session_id: &str) -> Option<Arc<AgentSession>> {
    let m = MANAGER.get()?;
    let sessions = m.sessions.lock().unwrap();
    // Prefer the session started for this id over one later bound to it, so
    // the pick never depends on map order.
    let exact: Vec<&Arc<AgentSession>> = sessions.iter().filter(|((_, sid), _)| sid == session_id).map(|(_, s)| s).collect();
    let bound: Vec<&Arc<AgentSession>> = sessions.iter().filter(|((_, sid), s)| sid != session_id && s.session_id() == session_id).map(|(_, s)| s).collect();
    let first = exact.first().or(bound.first()).map(|s| (*s).clone())?;
    let ws = first.workspace();
    if exact.iter().chain(bound.iter()).any(|s| s.workspace() != ws) {
        tracing::warn!("live_sessions_disagree_on_workspace session_id={} chosen={}", session_id, ws);
    }
    Some(first)
}

pub fn current_agent_session() -> Option<Arc<AgentSession>> {
    mgr().sessions.lock().unwrap().values().next().cloned()
}

pub fn all_sessions() -> Vec<Arc<AgentSession>> {
    MANAGER.get().map(|m| m.sessions.lock().unwrap().values().cloned().collect()).unwrap_or_default()
}

#[derive(Debug, thiserror::Error)]
pub enum ManagerError {
    #[error("{0}")]
    InvalidWorkspace(String),
    /// The session id belongs to another workspace.
    #[error("{0}")]
    WorkspaceMismatch(String),
    #[error("{0}")]
    Profile(String),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

/// `get_or_start_agent_session`.
pub async fn get_or_start_agent_session(workspace: &str, session_id: Option<&str>) -> Result<Option<Arc<AgentSession>>, ManagerError> {
    let m = mgr();
    let resolved = validate_workspace(workspace, true).map_err(ManagerError::InvalidWorkspace)?;
    let key: Key = (resolved.clone(), session_id.unwrap_or("").to_string());
    let start_lock = {
        let _g = m.lock.lock().await;
        m.start_locks.lock().unwrap().entry(key.clone()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    };
    let _sg = start_lock.lock().await;
    let now = Instant::now();
    evict_idle_sessions(Some(now)).await;
    if let Some(s) = m.sessions.lock().unwrap().get(&key).cloned() {
        m.last_used.lock().unwrap().insert(key, now);
        return Ok(Some(s));
    }
    let Some(agent) = loader::load_code_agent(&resolve_agents_dir(), &m.factory).map_err(ManagerError::Profile)? else {
        return Ok(None);
    };
    if let Some(sid) = session_id.filter(|s| appv3_db::codec::parse_uuid(s).is_some()) {
        check_session_workspace(&m.pool, sid, &resolved).await?;
    }
    let session = AgentSession::new(agent, None, Some(resolved), m.pool.clone(), m.factory.clone(), None);
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        session.attach_to_session(sid, None).await?;
    }
    session.start().await;
    m.sessions.lock().unwrap().insert(key.clone(), session.clone());
    m.last_used.lock().unwrap().insert(key, now);
    Ok(Some(session))
}

/// A saved session runs only in the workspace on its row: an AgentSession
/// started elsewhere would run its tools in the wrong directory.
async fn check_session_workspace(pool: &DbPool, session_id: &str, resolved: &str) -> Result<(), ManagerError> {
    let Some(row) = appv3_db::get_session(pool, session_id).await? else { return Ok(()) };
    if row.workspace.is_empty() {
        return Ok(());
    }
    let persisted = validate_workspace(&row.workspace, false).unwrap_or_else(|_| row.workspace.clone());
    if persisted != resolved {
        tracing::warn!("agent_session_workspace_mismatch session_id={} requested={} persisted={}", session_id, resolved, persisted);
        return Err(ManagerError::WorkspaceMismatch(format!("Session {session_id} belongs to workspace {persisted}.")));
    }
    Ok(())
}

pub async fn evict_sessions(ids: &std::collections::HashSet<String>) {
    let m = mgr();
    let to_stop: Vec<Arc<AgentSession>> = {
        let _g = m.lock.lock().await;
        let mut sessions = m.sessions.lock().unwrap();
        let keys: Vec<Key> = sessions.iter().filter(|(k, s)| (ids.contains(&k.1) || ids.contains(&s.session_id())) && evictable(s)).map(|(k, _)| k.clone()).collect();
        let mut out = vec![];
        for k in keys {
            if let Some(s) = sessions.remove(&k) {
                out.push(s);
            }
            m.last_used.lock().unwrap().remove(&k);
            m.start_locks.lock().unwrap().remove(&k);
        }
        out
    };
    for s in to_stop {
        s.stop().await;
    }
}

/// `agent_manager.stop()`.
pub async fn stop() {
    let Some(m) = MANAGER.get() else { return };
    let all: Vec<Arc<AgentSession>> = {
        let _g = m.lock.lock().await;
        let mut s = m.sessions.lock().unwrap();
        let mut seen = std::collections::HashSet::new();
        let v: Vec<_> = s.drain().map(|(_, v)| v).filter(|x| seen.insert(Arc::as_ptr(x) as usize)).collect();
        m.last_used.lock().unwrap().clear();
        m.start_locks.lock().unwrap().clear();
        v
    };
    for s in all {
        s.stop().await;
    }
}
