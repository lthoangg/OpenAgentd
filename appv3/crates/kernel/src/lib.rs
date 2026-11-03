//! Module lifecycle for the server.
//!
//! A module has an id, the modules it depends on, and start/stop hooks.
//! The kernel starts modules in dependency order (ties keep the order they
//! were added), stops them in reverse, and records each module's state. An
//! optional module that fails is marked failed, its dependents are blocked,
//! and the rest keep going; a critical one stops the modules already started
//! and fails the boot.
//!
//! Modules can also hand the kernel typed contributions
//! ([`Registrar::add`]). Each is tagged with the module that made it and
//! removed when that module stops, so restarting a module (a plugin reload)
//! replaces everything it registered. The kernel knows nothing about tools,
//! hooks or routes: consumers define the contribution types and read them
//! with [`Kernel::contributions`].

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

#[cfg(test)]
mod tests;

/// A unit of the server with its own start and stop.
#[async_trait::async_trait]
pub trait Module: Send + Sync + 'static {
    /// Unique id, e.g. `lsp` or `plugin:changelog-tools`.
    fn id(&self) -> &str;
    /// Modules this one starts after and stops before.
    fn deps(&self) -> &[&str] {
        &[]
    }
    /// A critical module that fails to start fails the whole boot.
    fn critical(&self) -> bool {
        false
    }
    /// Hands the kernel this module's contributions. Runs right before
    /// every start, and must not do I/O.
    fn register(&self, _r: &mut Registrar) -> anyhow::Result<()> {
        Ok(())
    }
    async fn start(&self, _k: &Kernel) -> anyhow::Result<()> {
        Ok(())
    }
    async fn stop(&self) {}
}

/// Collects a module's contributions while it registers.
#[derive(Default)]
pub struct Registrar {
    items: Vec<(TypeId, Arc<dyn Any + Send + Sync>)>,
}

impl Registrar {
    /// Adds `c` to the kernel's list of `C` contributions.
    pub fn add<C: Send + Sync + 'static>(&mut self, c: C) {
        self.items.push((TypeId::of::<C>(), Arc::new(c)));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Added, not started yet.
    Pending,
    Running,
    Stopped,
    /// `register` or `start` returned an error.
    Failed,
    /// Not started: a dependency is missing, not running, or part of a cycle.
    Blocked,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Pending => "pending",
            State::Running => "running",
            State::Stopped => "stopped",
            State::Failed => "failed",
            State::Blocked => "blocked",
        }
    }
}

/// One module as `GET /api/modules` and `agentd doctor` report it.
#[derive(Clone, Debug)]
pub struct ModuleStatus {
    pub id: String,
    pub deps: Vec<String>,
    pub critical: bool,
    pub state: State,
    /// Why the module failed or is blocked.
    pub error: Option<String>,
    /// How long its last start took.
    pub start_ms: Option<f64>,
}

struct Slot {
    module: Arc<dyn Module>,
    state: State,
    error: Option<String>,
    start_ms: Option<f64>,
}

struct Entry {
    module: Arc<str>,
    value: Arc<dyn Any + Send + Sync>,
}

/// What starting one module came to.
enum Outcome {
    Running,
    Blocked(String),
    Failed(anyhow::Error),
}

/// The module registry and lifecycle. The server uses [`global`]; tests
/// build their own.
pub struct Kernel {
    /// In the order they were added.
    modules: Mutex<Vec<Slot>>,
    /// Running modules, in the order they started.
    started: Mutex<Vec<String>>,
    contributions: RwLock<HashMap<TypeId, Vec<Entry>>>,
    /// One lifecycle operation at a time. Module hooks must not call back
    /// into `start`/`stop`/`restart`/`remove`.
    ops: tokio::sync::Mutex<()>,
}

impl Default for Kernel {
    fn default() -> Self {
        Self::new()
    }
}

/// The server's kernel.
pub fn global() -> &'static Kernel {
    static K: OnceLock<Kernel> = OnceLock::new();
    K.get_or_init(Kernel::new)
}

impl Kernel {
    pub fn new() -> Self {
        Self { modules: Mutex::new(vec![]), started: Mutex::new(vec![]), contributions: RwLock::new(HashMap::new()), ops: tokio::sync::Mutex::new(()) }
    }

    /// Adds a module without starting it. A module with the same id that
    /// is not running is replaced; a running one is an error.
    pub fn add<M: Module>(&self, m: M) -> anyhow::Result<()> {
        let m: Arc<dyn Module> = Arc::new(m);
        let mut mods = self.modules.lock().unwrap();
        let slot = Slot { module: m.clone(), state: State::Pending, error: None, start_ms: None };
        match mods.iter().position(|s| s.module.id() == m.id()) {
            Some(i) if mods[i].state == State::Running => anyhow::bail!("module {} is already running", m.id()),
            Some(i) => mods[i] = slot,
            None => mods.push(slot),
        }
        Ok(())
    }

    /// Starts every module that is not running, in dependency order. Fails
    /// only when a critical module cannot start; the modules this call
    /// started are then stopped again, and the module's own error is
    /// returned.
    pub async fn start_all(&self) -> anyhow::Result<()> {
        let _g = self.ops.lock().await;
        let t = Instant::now();
        let ids: Vec<String> = self.modules.lock().unwrap().iter().filter(|s| s.state != State::Running).map(|s| s.module.id().to_string()).collect();
        let (order, cycle) = self.order(&ids);
        for id in &cycle {
            self.set(id, State::Blocked, Some("dependency cycle".into()), None);
            tracing::warn!("module_blocked id={} reason=dependency_cycle", id);
        }
        let mut began = vec![];
        let mut failed = 0;
        for id in &order {
            let Some(m) = self.module(id) else { continue };
            match self.start_one(&m).await {
                Outcome::Running => began.push(id.clone()),
                Outcome::Blocked(why) if m.critical() => {
                    self.stop_ids(&began).await;
                    anyhow::bail!("module {id} cannot start: {why}");
                }
                Outcome::Failed(e) if m.critical() => {
                    self.stop_ids(&began).await;
                    return Err(e);
                }
                Outcome::Blocked(_) | Outcome::Failed(_) => failed += 1,
            }
        }
        let cycle_critical = cycle.iter().filter_map(|id| self.module(id)).find(|m| m.critical());
        if let Some(m) = cycle_critical {
            self.stop_ids(&began).await;
            anyhow::bail!("module {} cannot start: dependency cycle", m.id());
        }
        tracing::info!("kernel_started modules={} not_running={} ms={:.1}", began.len(), failed + cycle.len(), t.elapsed().as_secs_f64() * 1e3);
        Ok(())
    }

    /// Stops every running module, in the reverse of the order they started.
    pub async fn stop_all(&self) {
        let _g = self.ops.lock().await;
        let ids = self.started.lock().unwrap().clone();
        self.stop_ids(&ids).await;
    }

    /// Starts one module whose dependencies are running.
    pub async fn start(&self, id: &str) -> anyhow::Result<()> {
        let _g = self.ops.lock().await;
        self.start_by_id(id).await
    }

    /// Stops one module, and first every running module that depends on it.
    pub async fn stop(&self, id: &str) {
        let _g = self.ops.lock().await;
        let ids = self.with_dependents(id);
        self.stop_ids(&ids).await;
    }

    /// Stops a module (and its running dependents), then starts them again.
    /// Also starts a module that failed or never ran. Returns the module's
    /// own start error.
    pub async fn restart(&self, id: &str) -> anyhow::Result<()> {
        let _g = self.ops.lock().await;
        let ids = self.with_dependents(id);
        self.stop_ids(&ids).await;
        let res = self.start_by_id(id).await;
        for other in ids.iter().filter(|d| d.as_str() != id) {
            let _ = self.start_by_id(other).await;
        }
        res
    }

    /// Stops a module (and its running dependents) and forgets it.
    pub async fn remove(&self, id: &str) {
        let _g = self.ops.lock().await;
        let ids = self.with_dependents(id);
        self.stop_ids(&ids).await;
        self.modules.lock().unwrap().retain(|s| s.module.id() != id);
    }

    /// Every module, in the order they were added.
    pub fn status(&self) -> Vec<ModuleStatus> {
        self.modules
            .lock()
            .unwrap()
            .iter()
            .map(|s| ModuleStatus {
                id: s.module.id().to_string(),
                deps: s.module.deps().iter().map(|d| d.to_string()).collect(),
                critical: s.module.critical(),
                state: s.state,
                error: s.error.clone(),
                start_ms: s.start_ms,
            })
            .collect()
    }

    /// The `C` contributions of running modules, in the order they were made.
    pub fn contributions<C: Send + Sync + 'static>(&self) -> Vec<Arc<C>> {
        self.contributions_by_module::<C>().into_iter().map(|(_, c)| c).collect()
    }

    /// Like [`Kernel::contributions`], with the id of the module behind each.
    pub fn contributions_by_module<C: Send + Sync + 'static>(&self) -> Vec<(Arc<str>, Arc<C>)> {
        let all = self.contributions.read().unwrap();
        let Some(list) = all.get(&TypeId::of::<C>()) else { return vec![] };
        list.iter().filter_map(|e| Some((e.module.clone(), e.value.clone().downcast::<C>().ok()?))).collect()
    }

    fn module(&self, id: &str) -> Option<Arc<dyn Module>> {
        self.modules.lock().unwrap().iter().find(|s| s.module.id() == id).map(|s| s.module.clone())
    }

    fn state(&self, id: &str) -> Option<State> {
        self.modules.lock().unwrap().iter().find(|s| s.module.id() == id).map(|s| s.state)
    }

    fn set(&self, id: &str, state: State, error: Option<String>, start_ms: Option<f64>) {
        if let Some(s) = self.modules.lock().unwrap().iter_mut().find(|s| s.module.id() == id) {
            s.state = state;
            s.error = error;
            if start_ms.is_some() {
                s.start_ms = start_ms;
            }
        }
    }

    /// `ids` in dependency order, ties in the order they were added, and
    /// the ids caught in a dependency cycle. A dependency outside `ids` does
    /// not hold a module back here; starting it checks that it runs.
    fn order(&self, ids: &[String]) -> (Vec<String>, Vec<String>) {
        let deps: HashMap<String, Vec<String>> = ids.iter().filter_map(|id| Some((id.clone(), self.module(id)?.deps().iter().map(|d| d.to_string()).collect()))).collect();
        let mut left: Vec<String> = ids.to_vec();
        let mut order = vec![];
        while let Some(i) = left.iter().position(|id| deps.get(id).is_none_or(|ds| ds.iter().all(|d| !left.contains(d)))) {
            order.push(left.remove(i));
        }
        (order, left)
    }

    async fn start_by_id(&self, id: &str) -> anyhow::Result<()> {
        let Some(m) = self.module(id) else { anyhow::bail!("no module {id}") };
        if self.state(id) == Some(State::Running) {
            return Ok(());
        }
        match self.start_one(&m).await {
            Outcome::Running => Ok(()),
            Outcome::Blocked(why) => anyhow::bail!("module {id} cannot start: {why}"),
            Outcome::Failed(e) => Err(e),
        }
    }

    async fn start_one(&self, m: &Arc<dyn Module>) -> Outcome {
        let id = m.id();
        let waiting = m.deps().iter().find_map(|d| match self.state(d) {
            Some(State::Running) => None,
            Some(s) => Some(format!("needs {d}, which is {}", s.as_str())),
            None => Some(format!("needs {d}, which is not installed")),
        });
        if let Some(why) = waiting {
            tracing::warn!("module_blocked id={} reason={}", id, why);
            self.set(id, State::Blocked, Some(why.clone()), None);
            return Outcome::Blocked(why);
        }
        let t = Instant::now();
        let mut r = Registrar::default();
        let res = match m.register(&mut r) {
            Ok(()) => {
                self.commit(id, r);
                m.start(self).await
            }
            Err(e) => Err(e),
        };
        let ms = t.elapsed().as_secs_f64() * 1e3;
        match res {
            Ok(()) => {
                self.set(id, State::Running, None, Some(ms));
                self.started.lock().unwrap().push(id.to_string());
                tracing::debug!("module_started id={} ms={:.1}", id, ms);
                Outcome::Running
            }
            Err(e) => {
                self.uncommit(id);
                tracing::error!("module_failed id={} critical={} error={:#}", id, m.critical(), e);
                self.set(id, State::Failed, Some(format!("{e:#}")), Some(ms));
                Outcome::Failed(e)
            }
        }
    }

    /// Stops the running modules among `ids`, last started first.
    async fn stop_ids(&self, ids: &[String]) {
        let order: Vec<String> = self.started.lock().unwrap().iter().rev().filter(|id| ids.contains(id)).cloned().collect();
        for id in order {
            let Some(m) = self.module(&id) else { continue };
            self.started.lock().unwrap().retain(|s| *s != id);
            self.uncommit(&id);
            m.stop().await;
            self.set(&id, State::Stopped, None, None);
            tracing::debug!("module_stopped id={}", id);
        }
    }

    /// `id` and every running module that depends on it, directly or not.
    fn with_dependents(&self, id: &str) -> Vec<String> {
        let running: Vec<(String, Vec<String>)> = self
            .modules
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.state == State::Running)
            .map(|s| (s.module.id().to_string(), s.module.deps().iter().map(|d| d.to_string()).collect()))
            .collect();
        let mut out = vec![id.to_string()];
        loop {
            let more: Vec<String> = running.iter().filter(|(m, ds)| !out.contains(m) && ds.iter().any(|d| out.contains(d))).map(|(m, _)| m.clone()).collect();
            if more.is_empty() {
                return out;
            }
            out.extend(more);
        }
    }

    fn commit(&self, id: &str, r: Registrar) {
        if r.items.is_empty() {
            return;
        }
        let module: Arc<str> = Arc::from(id);
        let mut all = self.contributions.write().unwrap();
        for (t, value) in r.items {
            all.entry(t).or_default().push(Entry { module: module.clone(), value });
        }
    }

    fn uncommit(&self, id: &str) {
        for list in self.contributions.write().unwrap().values_mut() {
            list.retain(|e| &*e.module != id);
        }
    }
}

type StartFn = Box<dyn Fn() -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> + Send + Sync>;
type StopFn = Box<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// A module built from closures, for modules that only wrap a start and a
/// stop call.
pub struct FnModule {
    id: &'static str,
    deps: Vec<&'static str>,
    critical: bool,
    start: Option<StartFn>,
    stop: Option<StopFn>,
}

impl FnModule {
    pub fn new(id: &'static str) -> Self {
        Self { id, deps: vec![], critical: false, start: None, stop: None }
    }

    pub fn depends_on(mut self, deps: &[&'static str]) -> Self {
        self.deps = deps.to_vec();
        self
    }

    pub fn critical(mut self, critical: bool) -> Self {
        self.critical = critical;
        self
    }

    pub fn on_start<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        self.start = Some(Box::new(move || Box::pin(f())));
        self
    }

    pub fn on_stop<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.stop = Some(Box::new(move || Box::pin(f())));
        self
    }
}

#[async_trait::async_trait]
impl Module for FnModule {
    fn id(&self) -> &str {
        self.id
    }
    fn deps(&self) -> &[&str] {
        &self.deps
    }
    fn critical(&self) -> bool {
        self.critical
    }
    async fn start(&self, _k: &Kernel) -> anyhow::Result<()> {
        match &self.start {
            Some(f) => f().await,
            None => Ok(()),
        }
    }
    async fn stop(&self) {
        if let Some(f) = &self.stop {
            f().await;
        }
    }
}
