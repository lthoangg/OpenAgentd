//! Scheduled task engine — port of `app/scheduler/{scheduler,schemas,utils}.py`
//! plus the `schedule_task` tool (`tools/builtin/schedule.py`).

pub mod cron;

use crate::broadcaster;
use crate::service::{dispatch_user_message, Dispatch, DispatchError};
use crate::session::SessionError;
use appv3_db::{self as db, codec, DbPool, ScheduledTask};
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

pub use cron::{next_fire, validate_cron};

// ── utils / schemas ──────────────────────────────────────────────────────────

/// `slugify` (byte-for-byte with the frontend).
pub fn slugify(text: &str) -> String {
    appv3_core::slug::slugify(text)
}

fn slug_ok(s: &str) -> bool {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[a-z0-9][a-z0-9._-]{0,99}").unwrap());
    RE.is_match(s)
}

const SLUG_ERR: &str = "slug must consist of lowercase letters, numbers, hyphens, underscores, or dots, and start with a letter or number";

/// `ScheduledTaskCreate`.
#[derive(Debug, Clone, Default)]
pub struct TaskCreate {
    pub name: String,
    pub slug: Option<String>,
    pub workspace: String,
    pub schedule_type: String,
    pub at_datetime: Option<DateTime<Utc>>,
    pub every_seconds: Option<i64>,
    pub cron_expression: Option<String>,
    pub timezone: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub max_runs: Option<i64>,
    pub enabled: bool,
}

fn schedule_fields_check(st: &str, at: bool, every: bool, cron_expr: Option<&str>) -> Result<(), String> {
    match st {
        "at" => {
            if !at {
                return Err("at_datetime is required for schedule_type='at'".into());
            }
            if every || cron_expr.is_some() {
                return Err("Only at_datetime may be set for schedule_type='at'".into());
            }
        }
        "every" => {
            if !every {
                return Err("every_seconds is required for schedule_type='every'".into());
            }
            if at || cron_expr.is_some() {
                return Err("Only every_seconds may be set for schedule_type='every'".into());
            }
        }
        "cron" => {
            let Some(c) = cron_expr else {
                return Err("cron_expression is required for schedule_type='cron'".into());
            };
            if at || every {
                return Err("Only cron_expression may be set for schedule_type='cron'".into());
            }
            if !validate_cron(c) {
                return Err(format!("Invalid cron expression: '{c}'"));
            }
        }
        other => return Err(format!("schedule_type must be 'at', 'every', or 'cron'; got '{other}'")),
    }
    Ok(())
}

impl TaskCreate {
    /// Field constraints + `_validate_schedule`. Returns `(loc, msg)` pairs.
    pub fn validate(&mut self) -> Result<(), Vec<(String, String)>> {
        let mut errs = vec![];
        if self.workspace.is_empty() {
            errs.push(("workspace".into(), "String should have at least 1 character".into()));
        }
        if matches!(self.every_seconds, Some(s) if s <= 0) {
            errs.push(("every_seconds".into(), "Input should be greater than 0".into()));
        }
        if matches!(self.max_runs, Some(s) if s <= 0) {
            errs.push(("max_runs".into(), "Input should be greater than 0".into()));
        }
        if !errs.is_empty() {
            return Err(errs);
        }
        let ve = |m: String| vec![(String::new(), format!("Value error, {m}"))];
        if self.name.trim().is_empty() {
            return Err(ve("name cannot be empty or whitespace only".into()));
        }
        if self.name.chars().count() > 100 {
            return Err(ve("name must be 100 characters or less".into()));
        }
        match self.slug.clone().filter(|s| !s.is_empty()) {
            Some(s) => {
                let s = s.trim().to_lowercase();
                if !slug_ok(&s) {
                    return Err(ve(SLUG_ERR.into()));
                }
                self.slug = Some(s);
            }
            None => self.slug = Some(slugify(&self.name)),
        }
        schedule_fields_check(&self.schedule_type, self.at_datetime.is_some(), self.every_seconds.is_some(), self.cron_expression.as_deref()).map_err(ve)
    }
}

/// Render validation errors like pydantic's `ValidationError.__str__` (without urls).
pub fn pydantic_error_text(model: &str, errs: &[(String, String)]) -> String {
    let mut s = format!("{} validation error{} for {model}", errs.len(), if errs.len() == 1 { "" } else { "s" });
    for (loc, msg) in errs {
        if !loc.is_empty() {
            s.push_str(&format!("\n{loc}"));
        }
        s.push_str(&format!("\n  {msg}"));
    }
    s
}

/// `ScheduledTaskUpdate`.
#[derive(Debug, Clone, Default)]
pub struct TaskUpdate {
    pub slug: Option<String>,
    pub workspace: Option<String>,
    pub schedule_type: Option<String>,
    pub at_datetime: Option<DateTime<Utc>>,
    pub every_seconds: Option<i64>,
    pub cron_expression: Option<String>,
    pub timezone: Option<String>,
    pub prompt: Option<String>,
    pub session_id: Option<String>,
    pub max_runs: Option<i64>,
    pub max_runs_set: bool,
    pub enabled: Option<bool>,
}

impl TaskUpdate {
    pub fn validate(&mut self) -> Result<(), Vec<(String, String)>> {
        let mut errs = vec![];
        if matches!(&self.workspace, Some(w) if w.is_empty()) {
            errs.push(("workspace".into(), "String should have at least 1 character".into()));
        }
        if matches!(self.every_seconds, Some(s) if s <= 0) {
            errs.push(("every_seconds".into(), "Input should be greater than 0".into()));
        }
        if matches!(self.max_runs, Some(s) if s <= 0) {
            errs.push(("max_runs".into(), "Input should be greater than 0".into()));
        }
        if !errs.is_empty() {
            return Err(errs);
        }
        let ve = |m: String| vec![(String::new(), format!("Value error, {m}"))];
        if let Some(s) = &self.slug {
            let s = s.trim().to_lowercase();
            if !slug_ok(&s) {
                return Err(ve(SLUG_ERR.into()));
            }
            self.slug = Some(s);
        }
        let Some(st) = self.schedule_type.clone() else {
            return Ok(());
        };
        schedule_fields_check(&st, self.at_datetime.is_some(), self.every_seconds.is_some(), self.cron_expression.as_deref()).map_err(ve)
    }
}

// ── scheduler ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SchedulerError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    InvalidTarget(String),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

fn exhausted(t: &ScheduledTask) -> bool {
    if t.status == "completed" {
        return true;
    }
    if t.status == "failed" {
        return false;
    }
    matches!(t.max_runs, Some(m) if t.run_count >= m)
}

fn dt(s: &Option<String>) -> Option<DateTime<Utc>> {
    s.as_deref().and_then(codec::parse_dt)
}

fn nf(t: &ScheduledTask, after: Option<DateTime<Utc>>) -> Option<String> {
    next_fire(&t.schedule_type, t.cron_expression.as_deref(), t.every_seconds, dt(&t.at_datetime), &t.timezone, after, t.run_count).map(|d| codec::dt_db(&d))
}

fn validate_target(workspace: &str) -> Result<(), SchedulerError> {
    if workspace.is_empty() {
        return Err(SchedulerError::InvalidTarget("workspace is required".into()));
    }
    crate::manager::validate_workspace(workspace, true).map(|_| ()).map_err(SchedulerError::InvalidTarget)
}

async fn validate_session_compat(pool: &DbPool, session_id: Option<&str>, workspace: &str) -> Result<(), SchedulerError> {
    let Some(sid) = session_id.filter(|s| !s.is_empty() && *s != "auto") else {
        return Ok(());
    };
    if codec::parse_uuid(sid).is_none() || uuid::Uuid::parse_str(sid).is_err() {
        return Err(SchedulerError::InvalidTarget(format!("session_id must be a UUID or 'auto'; got {}", appv3_tools::py_repr_str(sid))));
    }
    if let Some(row) = db::get_session(pool, sid).await? {
        if row.workspace != workspace {
            return Err(SchedulerError::InvalidTarget(format!("Session {sid} is bound to workspace '{}', but task targets '{workspace}'.", row.workspace)));
        }
    }
    Ok(())
}

/// Mark `sid` as the scheduled session of task `name` (`session_id: "auto"`),
/// creating its row if the session has none yet.
async fn mark_scheduler_owned(pool: &DbPool, sid: &str, name: &str, workspace: &str) -> anyhow::Result<()> {
    let mark = Some(name.to_string());
    match db::get_session(pool, sid).await? {
        Some(row) if row.scheduled_task_name == mark => {}
        Some(_) => {
            db::update_session(pool, sid, db::SessionUpdate { scheduled_task_name: Some(mark), ..Default::default() }).await?;
        }
        None => {
            let id = uuid::Uuid::parse_str(sid)?;
            db::create_session(pool, db::NewSession { id: Some(id), scheduled_task_name: mark, workspace: workspace.into(), ..Default::default() }).await?;
        }
    }
    Ok(())
}

#[derive(Default)]
struct State {
    timers: HashMap<String, tokio::task::JoinHandle<()>>,
    firing: HashSet<String>,
    versions: HashMap<String, u64>,
    pending: HashMap<String, u64>,
}

pub struct TaskScheduler {
    pool: DbPool,
    st: Mutex<State>,
    state_lock: tokio::sync::Mutex<()>,
}

static SCHED: OnceLock<Arc<TaskScheduler>> = OnceLock::new();

pub fn init(pool: DbPool) -> Arc<TaskScheduler> {
    SCHED.get_or_init(|| Arc::new(TaskScheduler { pool, st: Mutex::new(State::default()), state_lock: tokio::sync::Mutex::new(()) })).clone()
}

pub fn scheduler() -> Arc<TaskScheduler> {
    SCHED.get().cloned().unwrap_or_else(|| init(crate::manager::pool()))
}

impl TaskScheduler {
    fn version(&self, id: &str) -> u64 {
        *self.st.lock().unwrap().versions.get(id).unwrap_or(&0)
    }

    pub async fn start(self: &Arc<Self>) -> anyhow::Result<()> {
        let tasks: Vec<ScheduledTask> = db::list_tasks(&self.pool).await?.into_iter().filter(|t| t.enabled).collect();
        let now = Utc::now();
        for t in &tasks {
            if dt(&t.next_fire_at).map(|n| n <= now).unwrap_or(false) {
                let v = self.version(&t.id);
                let me = self.clone();
                let tc = t.clone();
                self.spawn_fire(&t.id, async move { me.fire_overdue_and_restart(tc, v).await });
                continue;
            }
            if t.schedule_type == "at" && t.run_count == 0 && dt(&t.at_datetime).map(|a| a <= now).unwrap_or(false) {
                let v = self.version(&t.id);
                let me = self.clone();
                let tc = t.clone();
                self.spawn_fire(&t.id, async move { me.fire_task(tc, Some(v)).await });
            } else {
                self.start_timer(t.clone());
            }
        }
        tracing::info!("scheduler_started tasks={}", tasks.len());
        Ok(())
    }

    async fn fire_overdue_and_restart(self: Arc<Self>, task: ScheduledTask, v: u64) {
        let slug = task.slug.clone();
        self.clone().fire_task(task, Some(v)).await;
        if let Ok(Some(fresh)) = db::get_task_by_slug(&self.pool, &slug).await {
            if fresh.enabled && fresh.schedule_type != "at" {
                self.start_timer(fresh);
            }
        }
    }

    pub async fn has_enabled_tasks(&self) -> bool {
        db::has_enabled_tasks(&self.pool).await.unwrap_or(false)
    }

    pub fn stop(&self) {
        let mut st = self.st.lock().unwrap();
        for (_, h) in st.timers.drain() {
            h.abort();
        }
        tracing::info!("scheduler_stopped");
    }

    async fn persist(&self, t: &ScheduledTask) -> anyhow::Result<ScheduledTask> {
        db::save_task(&self.pool, t).await
    }

    /// `add`.
    pub async fn add(self: &Arc<Self>, mut t: ScheduledTask) -> anyhow::Result<ScheduledTask> {
        if exhausted(&t) {
            t.enabled = false;
            t.status = "completed".into();
            t.next_fire_at = None;
        } else {
            t.next_fire_at = nf(&t, None);
        }
        let t = db::insert_task(&self.pool, &t).await?;
        if t.enabled {
            self.start_timer(t.clone());
        }
        Ok(t)
    }

    /// `create`.
    pub async fn create(self: &Arc<Self>, body: TaskCreate) -> Result<ScheduledTask, SchedulerError> {
        validate_target(&body.workspace)?;
        validate_session_compat(&self.pool, body.session_id.as_deref(), &body.workspace).await?;
        let now = codec::now_db();
        let t = ScheduledTask {
            id: String::new(),
            name: body.name,
            schedule_type: body.schedule_type,
            at_datetime: body.at_datetime.map(|d| codec::dt_db(&d)),
            every_seconds: body.every_seconds,
            cron_expression: body.cron_expression,
            timezone: body.timezone,
            prompt: body.prompt,
            session_id: body.session_id,
            enabled: body.enabled,
            status: "pending".into(),
            run_count: 0,
            last_run_at: None,
            last_error: None,
            next_fire_at: None,
            created_at: now.clone(),
            updated_at: now,
            workspace: body.workspace,
            max_runs: body.max_runs,
            slug: body.slug.unwrap_or_default(),
        };
        Ok(self.add(t).await?)
    }

    pub async fn apply_update(self: &Arc<Self>, slug: &str, body: TaskUpdate) -> Result<ScheduledTask, SchedulerError> {
        let _g = self.state_lock.lock().await;
        let Some(mut task) = self.get_task(slug).await? else {
            return Err(SchedulerError::NotFound(slug.to_string()));
        };
        let new_ws = body.workspace.clone().unwrap_or_else(|| task.workspace.clone());
        let new_sid = body.session_id.clone().or_else(|| task.session_id.clone());
        if body.workspace.is_some() {
            validate_target(&new_ws)?;
            task.workspace = new_ws.clone();
        }
        if body.workspace.is_some() || body.session_id.is_some() {
            validate_session_compat(&self.pool, new_sid.as_deref(), &new_ws).await?;
        }
        if let Some(s) = body.slug.clone().filter(|s| *s != task.slug) {
            self.invalidate_fire(&task.id);
            self.cancel_timer(&task.slug);
            task.slug = s;
        }
        if let Some(st) = body.schedule_type {
            task.schedule_type = st;
            task.at_datetime = None;
            task.every_seconds = None;
            task.cron_expression = None;
        }
        if let Some(a) = body.at_datetime {
            task.at_datetime = Some(codec::dt_db(&a));
        }
        if let Some(e) = body.every_seconds {
            task.every_seconds = Some(e);
        }
        if let Some(c) = body.cron_expression {
            task.cron_expression = Some(c);
        }
        if let Some(tz) = body.timezone {
            task.timezone = tz;
        }
        if let Some(p) = body.prompt {
            task.prompt = p;
        }
        if let Some(s) = body.session_id {
            task.session_id = Some(s);
        }
        if body.max_runs_set {
            task.max_runs = body.max_runs;
        }
        if let Some(e) = body.enabled {
            task.enabled = e;
        }
        Ok(self.update_locked(task).await?)
    }

    pub async fn update(self: &Arc<Self>, task: ScheduledTask) -> anyhow::Result<ScheduledTask> {
        let _g = self.state_lock.lock().await;
        self.update_locked(task).await
    }

    async fn update_locked(self: &Arc<Self>, mut task: ScheduledTask) -> anyhow::Result<ScheduledTask> {
        self.invalidate_fire(&task.id);
        self.cancel_timer(&task.slug);
        if task.status == "running" {
            task.status = if task.enabled { "pending".into() } else { "paused".into() };
        }
        if exhausted(&task) {
            task.enabled = false;
            task.status = "completed".into();
            task.next_fire_at = None;
        } else {
            task.next_fire_at = nf(&task, None);
        }
        let t = self.persist(&task).await?;
        if t.enabled {
            self.start_timer(t.clone());
        }
        Ok(t)
    }

    pub async fn remove(&self, slug: &str) -> anyhow::Result<()> {
        let _g = self.state_lock.lock().await;
        if let Some(t) = self.get_task(slug).await? {
            self.invalidate_fire(&t.id);
            self.cancel_timer(slug);
            db::delete_task(&self.pool, &t.id).await?;
        } else {
            self.cancel_timer(slug);
        }
        Ok(())
    }

    pub async fn pause(&self, slug: &str) -> anyhow::Result<ScheduledTask> {
        let _g = self.state_lock.lock().await;
        let mut t = self.get_task(slug).await?.ok_or_else(|| anyhow::anyhow!("No row was found when one was required"))?;
        self.invalidate_fire(&t.id);
        self.cancel_timer(slug);
        t.enabled = false;
        t.status = "paused".into();
        self.persist(&t).await
    }

    pub async fn resume(self: &Arc<Self>, slug: &str) -> anyhow::Result<ScheduledTask> {
        let _g = self.state_lock.lock().await;
        let mut t = self.get_task(slug).await?.ok_or_else(|| anyhow::anyhow!("No row was found when one was required"))?;
        self.invalidate_fire(&t.id);
        t.enabled = true;
        t.status = "pending".into();
        if exhausted(&t) {
            t.enabled = false;
            t.status = "completed".into();
            t.next_fire_at = None;
        } else {
            t.next_fire_at = nf(&t, None);
        }
        let t = self.persist(&t).await?;
        if t.enabled {
            self.start_timer(t.clone());
        }
        Ok(t)
    }

    pub async fn trigger(self: &Arc<Self>, slug: &str) -> anyhow::Result<()> {
        let _g = self.state_lock.lock().await;
        let mut t = self.get_task(slug).await?.ok_or_else(|| anyhow::anyhow!("No row was found when one was required"))?;
        if exhausted(&t) {
            t.enabled = false;
            t.status = "completed".into();
            t.next_fire_at = None;
            self.persist(&t).await?;
            return Ok(());
        }
        let was_disabled = !t.enabled || t.status == "paused";
        if was_disabled {
            t.enabled = true;
            t.status = "pending".into();
            t.next_fire_at = nf(&t, None);
            t = self.persist(&t).await?;
            self.start_timer(t.clone());
        }
        let v = self.version(&t.id);
        let me = self.clone();
        let id = t.id.clone();
        self.spawn_fire(&id, async move { me.fire_task(t, Some(v)).await });
        Ok(())
    }

    pub async fn list_tasks(&self) -> anyhow::Result<Vec<ScheduledTask>> {
        db::list_tasks(&self.pool).await
    }

    pub async fn get_task(&self, slug: &str) -> anyhow::Result<Option<ScheduledTask>> {
        db::get_task_by_slug(&self.pool, slug).await
    }

    fn spawn_fire<F>(self: &Arc<Self>, id: &str, fut: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        *self.st.lock().unwrap().pending.entry(id.to_string()).or_insert(0) += 1;
        let me = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            fut.await;
            let mut st = me.st.lock().unwrap();
            let remaining = st.pending.get(&id).copied().unwrap_or(1).saturating_sub(1);
            if remaining > 0 {
                st.pending.insert(id.clone(), remaining);
            } else {
                st.pending.remove(&id);
                if !st.firing.contains(&id) {
                    st.versions.remove(&id);
                }
            }
        });
    }

    fn invalidate_fire(&self, id: &str) {
        let mut st = self.st.lock().unwrap();
        *st.versions.entry(id.to_string()).or_insert(0) += 1;
        if !st.firing.contains(id) && !st.pending.contains_key(id) {
            st.versions.remove(id);
        }
    }

    fn start_timer(self: &Arc<Self>, task: ScheduledTask) {
        self.cancel_timer(&task.slug);
        let me = self.clone();
        let slug = task.slug.clone();
        let h = tokio::spawn(async move { me.timer_loop(task).await });
        self.st.lock().unwrap().timers.insert(slug, h);
    }

    fn cancel_timer(&self, slug: &str) {
        if let Some(h) = self.st.lock().unwrap().timers.remove(slug) {
            h.abort();
        }
    }

    async fn timer_loop(self: Arc<Self>, mut task: ScheduledTask) {
        while let Some(nxt) = next_fire(&task.schedule_type, task.cron_expression.as_deref(), task.every_seconds, dt(&task.at_datetime), &task.timezone, None, task.run_count) {
            let delay = (nxt - Utc::now()).num_milliseconds();
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay as u64)).await;
            }
            // Firing runs detached so aborting the timer never cancels a dispatch mid-way.
            let me = self.clone();
            let t = task.clone();
            let _ = tokio::spawn(async move { me.fire_task(t, None).await }).await;
            let fresh = match db::get_task_by_slug(&self.pool, &task.slug).await {
                Ok(Some(f)) => f,
                _ => break,
            };
            task = fresh;
            if !task.enabled || exhausted(&task) || task.schedule_type == "at" {
                break;
            }
        }
        self.st.lock().unwrap().timers.remove(&task.slug);
    }

    async fn fire_task(self: Arc<Self>, task: ScheduledTask, v: Option<u64>) {
        let v = v.unwrap_or_else(|| self.version(&task.id));
        {
            let mut st = self.st.lock().unwrap();
            if *st.versions.get(&task.id).unwrap_or(&0) != v || st.firing.contains(&task.id) {
                return;
            }
            st.firing.insert(task.id.clone());
        }
        self.fire_locked(&task, v).await;
        let mut st = self.st.lock().unwrap();
        st.firing.remove(&task.id);
        if !st.pending.contains_key(&task.id) {
            st.versions.remove(&task.id);
        }
    }

    async fn reschedule_without_firing(&self, task: &ScheduledTask, v: u64) {
        let _g = self.state_lock.lock().await;
        if let Ok(Some(mut t)) = db::get_task(&self.pool, &task.id).await {
            if t.enabled && t.status != "paused" && self.version(&task.id) == v {
                t.status = "pending".into();
                t.next_fire_at = nf(&t, Some(Utc::now()));
                let _ = self.persist(&t).await;
            }
        }
    }

    async fn fire_locked(&self, task: &ScheduledTask, v: u64) {
        let now = Utc::now();
        {
            let _g = self.state_lock.lock().await;
            match db::get_task(&self.pool, &task.id).await {
                Ok(Some(mut t)) if t.enabled && !exhausted(&t) => {
                    t.status = "running".into();
                    t.last_run_at = Some(codec::dt_db(&now));
                    let _ = self.persist(&t).await;
                }
                _ => return,
            }
        }
        let resolved_sid: Option<String> = match task.session_id.as_deref() {
            None => None,
            Some("auto") => Some(uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, format!("scheduler:{}", task.name).as_bytes()).to_string()),
            Some(s) => Some(s.to_string()),
        };
        let mut error: Option<String> = None;
        let mut fired_sid: Option<String> = None;
        let mut dispatch_attempted = false;
        let res: Result<(), String> = async {
            if task.workspace.is_empty() {
                return Err("Task has no workspace configured.".to_string());
            }
            let agent = crate::manager::get_or_start_agent_session(&task.workspace, resolved_sid.as_deref()).await.map_err(|e| e.to_string())?;
            let Some(agent) = agent else { return Err("No agent configured.".to_string()) };
            if self.version(&task.id) != v {
                return Ok(());
            }
            if resolved_sid.is_some() && agent.has_active_user_turn() {
                self.reschedule_without_firing(task, v).await;
                tracing::info!("scheduler_skip_active_session task_slug={} name={} session_id={:?}", task.slug, task.name, resolved_sid);
                return Err("__skip__".into());
            }
            // Only a session the scheduler owns is marked as the task's, from
            // its first turn. A task running in the user's own session leaves
            // it unmarked. (The mark records ownership; tools never depend on
            // it, since `origin: "scheduler"` makes the turn unattended.)
            if let (Some("auto"), Some(sid)) = (task.session_id.as_deref(), resolved_sid.as_deref()) {
                mark_scheduler_owned(&self.pool, sid, &task.name, &agent.workspace()).await.map_err(|e| e.to_string())?;
            }
            dispatch_attempted = true;
            match dispatch_user_message(
                &agent,
                Dispatch { content: format!("[Scheduled Task: {}]\n{}", task.name, task.prompt), session_id: resolved_sid.clone(), workspace: Some(task.workspace.clone()), origin: "scheduler".into(), ..Default::default() },
            )
            .await
            {
                Ok((sid, _, _)) => {
                    broadcaster::publish(
                        "session_turn_started",
                        json!({"session_id": sid, "source": "scheduled_task", "task_slug": task.slug, "task_name": task.name, "workspace": task.workspace, "started_at": codec::py_isoformat(&Utc::now())}),
                    );
                    fired_sid = Some(sid);
                    Ok(())
                }
                Err(DispatchError::Session(SessionError::QuestionPending(_))) => {
                    self.reschedule_without_firing(task, v).await;
                    tracing::info!("scheduler_skip_pending_question task_slug={} name={} session_id={:?}", task.slug, task.name, resolved_sid);
                    Err("__skip__".into())
                }
                Err(e) => Err(e.to_string()),
            }
        }
        .await;
        match res {
            Err(e) if e == "__skip__" => return,
            Err(e) => {
                tracing::error!("scheduler_fire_error task_slug={} name={} error={}", task.slug, task.name, e);
                error = Some(e);
            }
            Ok(()) => {}
        }
        if !dispatch_attempted && error.is_none() && fired_sid.is_none() {
            // Stale fire version: nothing dispatched, nothing to account.
            return;
        }
        if !dispatch_attempted && self.version(&task.id) != v {
            return;
        }
        let _g = self.state_lock.lock().await;
        let Ok(Some(mut t)) = db::get_task(&self.pool, &task.id).await else {
            return;
        };
        let was_paused = !t.enabled || t.status == "paused";
        t.run_count += 1;
        t.last_error = error.clone();
        if !was_paused {
            let nxt = nf(&t, Some(Utc::now()));
            let finite_complete = error.is_none() && matches!(t.max_runs, Some(m) if t.run_count >= m);
            t.next_fire_at = if finite_complete { None } else { nxt };
            t.status = if error.is_some() {
                "failed".into()
            } else if finite_complete {
                t.enabled = false;
                "completed".into()
            } else if t.schedule_type == "at" {
                "completed".into()
            } else {
                "pending".into()
            };
        }
        let _ = self.persist(&t).await;
        tracing::info!("scheduler_fired task_slug={} name={} run_count={} error={:?}", task.slug, task.name, task.run_count + 1, error);
    }
}

// ── schedule_task tool ───────────────────────────────────────────────────────

/// Python `str(datetime)` for an aware UTC datetime stored in DB form.
fn py_str_dt(raw: &Option<String>) -> Option<String> {
    raw.as_deref().and_then(codec::parse_dt).map(|d| codec::py_isoformat(&d).replacen('T', " ", 1))
}

fn fmt_task(t: &ScheduledTask) -> String {
    let schedule = match t.schedule_type.as_str() {
        "at" => py_str_dt(&t.at_datetime).map(|d| format!("at {d}")).unwrap_or_else(|| "at ?".into()),
        "every" => t.every_seconds.filter(|s| *s != 0).map(|s| format!("every {s}s")).unwrap_or_else(|| "every ?".into()),
        "cron" => t.cron_expression.clone().filter(|c| !c.is_empty()).map(|c| format!("cron '{c}' ({})", t.timezone)).unwrap_or_else(|| "cron ?".into()),
        _ => String::new(),
    };
    let target = if t.workspace.is_empty() { "coding workspace".to_string() } else { format!("workspace={}", t.workspace) };
    let mut parts = vec![
        format!("slug={}", t.slug),
        format!("name={}", t.name),
        target,
        format!("schedule={schedule}"),
        format!("status={}/{}", if t.enabled { "enabled" } else { "paused" }, t.status),
        format!("runs={}{}", t.run_count, t.max_runs.map(|m| format!("/{m}")).unwrap_or_default()),
    ];
    if let Some(n) = py_str_dt(&t.next_fire_at) {
        parts.push(format!("next={n}"));
    }
    format!("  {}", parts.join(" | "))
}

fn lax_int(v: &Value) -> Result<i64, &'static str> {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i)
            } else if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 {
                    Ok(f as i64)
                } else {
                    Err("Input should be a valid integer, got a number with a fractional part")
                }
            } else {
                Err("Input should be a valid integer")
            }
        }
        Value::String(s) => s.trim().parse::<i64>().map_err(|_| "Input should be a valid integer, unable to parse string as an integer"),
        Value::Bool(b) => Ok(*b as i64),
        _ => Err("Input should be a valid integer"),
    }
}

/// Python `datetime.fromisoformat` (3.11+) → `(naive, offset_seconds)`.
fn py_fromisoformat(s: &str) -> Result<(chrono::NaiveDateTime, Option<i32>), String> {
    let err = || format!("Invalid isoformat string: {}", appv3_tools::py_repr_str(s));
    let t = s.trim();
    let (body, off) = if let Some(b) = t.strip_suffix('Z').or_else(|| t.strip_suffix('z')) {
        (b.to_string(), Some(0))
    } else if let Some(i) = t.rfind(['+', '-']).filter(|i| *i > 10) {
        let (b, o) = t.split_at(i);
        let sign = if o.starts_with('-') { -1 } else { 1 };
        let digits: String = o[1..].chars().filter(|c| c.is_ascii_digit()).collect();
        let (h, m) = match digits.len() {
            2 => (digits[..2].parse::<i32>().map_err(|_| err())?, 0),
            4 | 6 => (digits[..2].parse::<i32>().map_err(|_| err())?, digits[2..4].parse::<i32>().map_err(|_| err())?),
            _ => return Err(err()),
        };
        (b.to_string(), Some(sign * (h * 3600 + m * 60)))
    } else {
        (t.to_string(), None)
    };
    let fmts = ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H", "%Y%m%dT%H%M%S"];
    for f in fmts {
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(&body, f) {
            return Ok((n, off));
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(&body, "%Y-%m-%d") {
        return Ok((d.and_hms_opt(0, 0, 0).unwrap(), off));
    }
    Err(err())
}

pub struct ScheduleTaskTool;

#[async_trait]
impl Tool for ScheduleTaskTool {
    fn name(&self) -> &str {
        "schedule_task"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let o: Map<String, Value> = args.as_object().cloned().unwrap_or_default();
        let mut errs: Vec<String> = vec![];
        let action = match o.get("action") {
            None => {
                errs.push("action: Field required".into());
                String::new()
            }
            Some(Value::String(s)) if ["create", "list", "pause", "resume", "delete", "trigger"].contains(&s.as_str()) => s.clone(),
            Some(_) => {
                errs.push("action: Input should be 'create', 'list', 'pause', 'resume', 'delete' or 'trigger'".into());
                String::new()
            }
        };
        // Blank strings count as unset: strict-schema models send `""` for
        // every field they do not use.
        let opt_s = |errs: &mut Vec<String>, k: &str, v: Option<&Value>| -> Option<String> {
            match v {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.trim().is_empty() => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => {
                    errs.push(format!("{k}: Input should be a valid string"));
                    None
                }
            }
        };
        let name = opt_s(&mut errs, "name", o.get("name"));
        let schedule_type = match o.get("schedule_type") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if ["at", "every", "cron"].contains(&s.as_str()) => Some(s.clone()),
            Some(_) => {
                errs.push("schedule_type: Input should be 'at', 'every' or 'cron'".into());
                None
            }
        };
        let at_datetime = opt_s(&mut errs, "at_datetime", o.get("at_datetime"));
        let mut int_field = |k: &str| -> Option<i64> {
            match o.get(k) {
                None | Some(Value::Null) => None,
                Some(v) => match lax_int(v) {
                    Ok(i) if i > 0 => Some(i),
                    Ok(_) => {
                        errs.push(format!("{k}: Input should be greater than 0"));
                        None
                    }
                    Err(m) => {
                        errs.push(format!("{k}: {m}"));
                        None
                    }
                },
            }
        };
        let every_seconds = int_field("every_seconds");
        let max_runs = int_field("max_runs");
        let cron_expression = opt_s(&mut errs, "cron_expression", o.get("cron_expression"));
        let timezone = match o.get("timezone") {
            None | Some(Value::Null) => "UTC".to_string(),
            Some(Value::String(s)) if s.trim().is_empty() => "UTC".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                errs.push("timezone: Input should be a valid string".into());
                "UTC".into()
            }
        };
        let prompt = opt_s(&mut errs, "prompt", o.get("prompt"));
        let session_id = opt_s(&mut errs, "session_id", o.get("session_id"));
        let enabled = match o.get("enabled") {
            None => true,
            Some(v) => match appv3_tools::args::coerce_bool(v) {
                Some(b) => b,
                None => {
                    errs.push("enabled: Input should be a valid boolean".into());
                    true
                }
            },
        };
        let slug = opt_s(&mut errs, "slug", o.get("slug").or_else(|| o.get("task_slug")));
        if errs.is_empty() {
            let ve = |m: String| format!("Value error, {m}");
            if ["pause", "resume", "delete", "trigger"].contains(&action.as_str()) {
                if slug.as_deref().unwrap_or("").is_empty() {
                    errs.push(ve(format!("slug is required for action='{action}'")));
                }
            } else if action == "create" {
                if name.as_deref().unwrap_or("").is_empty() {
                    errs.push(ve("name is required for action='create'".into()));
                } else if schedule_type.is_none() {
                    errs.push(ve("schedule_type is required for action='create'".into()));
                } else if prompt.as_deref().unwrap_or("").is_empty() {
                    errs.push(ve("prompt is required for action='create'".into()));
                } else {
                    let st = schedule_type.as_deref().unwrap();
                    let m = match st {
                        "at" if at_datetime.as_deref().unwrap_or("").is_empty() => Some("at_datetime is required for schedule_type='at'"),
                        "at" if every_seconds.is_some() || cron_expression.is_some() => Some("Only at_datetime may be set for schedule_type='at'"),
                        "every" if every_seconds.is_none() => Some("every_seconds is required for schedule_type='every'"),
                        "every" if at_datetime.is_some() || cron_expression.is_some() => Some("Only every_seconds may be set for schedule_type='every'"),
                        "cron" if cron_expression.as_deref().unwrap_or("").is_empty() => Some("cron_expression is required for schedule_type='cron'"),
                        "cron" if at_datetime.is_some() || every_seconds.is_some() => Some("Only cron_expression may be set for schedule_type='cron'"),
                        _ => None,
                    };
                    if let Some(m) = m {
                        errs.push(ve(m.into()));
                    }
                }
            }
        }
        if !errs.is_empty() {
            return Err(crate::tools::invalid_args("schedule_task", &errs));
        }
        let ws = ctx.workspace.clone().unwrap_or_default();
        let s = scheduler();
        let in_scope = |t: &ScheduledTask| t.workspace == ws;
        let exec = appv3_tools::ToolError::exec;
        if action == "list" {
            let tasks: Vec<ScheduledTask> = s.list_tasks().await.map_err(exec)?.into_iter().filter(|t| in_scope(t)).collect();
            if tasks.is_empty() {
                return Ok(ToolOutput::text("No scheduled tasks."));
            }
            let mut lines = vec![format!("Scheduled tasks ({}):", tasks.len())];
            lines.extend(tasks.iter().map(fmt_task));
            return Ok(ToolOutput::text(lines.join("\n")));
        }
        if action != "create" {
            let slug = slug.unwrap_or_default();
            let existing = s.get_task(&slug).await.map_err(exec)?;
            let Some(existing) = existing.filter(|t| in_scope(t)) else {
                return Ok(ToolOutput::text(format!("Error: no task with slug '{slug}'.")));
            };
            let text = match action.as_str() {
                "pause" => {
                    let t = s.pause(&slug).await.map_err(exec)?;
                    format!("Task '{}' paused.", t.name)
                }
                "resume" => {
                    let t = s.resume(&slug).await.map_err(exec)?;
                    format!("Task '{}' resumed. Next fire: {}", t.name, py_str_dt(&t.next_fire_at).unwrap_or_else(|| "None".into()))
                }
                "delete" => {
                    s.remove(&slug).await.map_err(exec)?;
                    format!("Task '{}' deleted.", existing.name)
                }
                _ => {
                    s.trigger(&slug).await.map_err(exec)?;
                    format!("Task '{}' triggered immediately.", existing.name)
                }
            };
            return Ok(ToolOutput::text(text));
        }
        // ── create ──
        let mut session_id = session_id;
        if session_id.as_deref() == Some("current") {
            let cur = ctx.metadata.lock().unwrap().get("session_id").and_then(|v| v.as_str()).map(String::from).filter(|s| !s.is_empty());
            match cur {
                Some(c) => session_id = Some(c),
                None => return Ok(ToolOutput::text("Error: session_id='current' is unavailable outside an active chat session.")),
            }
        }
        let mut at_dt: Option<DateTime<Utc>> = None;
        if let Some(a) = at_datetime.as_deref().filter(|a| !a.is_empty()) {
            let (naive, off) = match py_fromisoformat(a) {
                Ok(x) => x,
                Err(e) => return Ok(ToolOutput::text(format!("Error: invalid at_datetime '{a}': {e}"))),
            };
            at_dt = Some(match off {
                Some(o) => chrono::FixedOffset::east_opt(o).and_then(|fo| naive.and_local_timezone(fo).single()).map(|d| d.with_timezone(&Utc)).unwrap_or_else(|| naive.and_utc()),
                None => {
                    let Some(tz) = cron::parse_tz(&timezone) else {
                        return Ok(ToolOutput::text(format!("Error: unknown timezone '{timezone}'.")));
                    };
                    naive.and_local_timezone(tz).earliest().map(|d| d.with_timezone(&Utc)).unwrap_or_else(|| naive.and_utc())
                }
            });
        }
        let mut body = TaskCreate {
            name: name.unwrap_or_default(),
            slug,
            workspace: ws,
            schedule_type: schedule_type.unwrap_or_default(),
            at_datetime: at_dt,
            every_seconds,
            cron_expression,
            timezone,
            prompt: prompt.unwrap_or_default(),
            session_id,
            max_runs,
            enabled,
        };
        if let Err(e) = body.validate() {
            return Ok(ToolOutput::text(format!("Error: invalid task configuration — {}", pydantic_error_text("ScheduledTaskCreate", &e))));
        }
        let created = match s.create(body).await {
            Ok(c) => c,
            Err(e) => return Ok(ToolOutput::text(format!("Error: failed to create task — {e}"))),
        };
        tracing::info!("schedule_tool_create name={} workspace={} schedule_type={} next_fire={:?}", created.name, created.workspace, created.schedule_type, created.next_fire_at);
        let mut out = format!(
            "Scheduled task created.\n  id          : {}\n  slug        : {}\n  name        : {}\n  workspace   : {}\n  schedule    : {}\n  next fire   : {}\n",
            codec::api_uuid(&created.id),
            created.slug,
            created.name,
            created.workspace,
            created.schedule_type,
            py_str_dt(&created.next_fire_at).unwrap_or_else(|| "None".into())
        );
        if let Some(m) = created.max_runs.filter(|m| *m != 0) {
            out.push_str(&format!("  max runs    : {m}\n"));
        }
        out.push_str(&format!("  prompt      : {}", appv3_tools::py_repr_str(&created.prompt)));
        Ok(ToolOutput::text(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_v2() {
        assert_eq!(slugify("Check Build Status!"), "check-build-status");
        assert_eq!(slugify("Café déjà vu"), "cafe-deja-vu");
        assert_eq!(slugify("..__Hello__.."), "hello");
        let mut c = TaskCreate { name: "x".into(), workspace: "/tmp".into(), schedule_type: "every".into(), timezone: "UTC".into(), prompt: "p".into(), ..Default::default() };
        assert_eq!(c.validate().unwrap_err()[0].1, "Value error, every_seconds is required for schedule_type='every'");
        assert!(py_fromisoformat("2026-09-10T15:00:00Z").is_ok());
        assert_eq!(py_fromisoformat("2026-09-10 15:00").unwrap().1, None);
    }

    /// Strict-schema models fill every field, sending `""` for the unused
    /// ones; those count as unset, not as a conflicting schedule.
    #[tokio::test]
    async fn create_treats_blank_unused_fields_as_unset() {
        let dir = tempfile::tempdir().unwrap().keep();
        init(appv3_db::create_pool(dir.join("t.db")).await.unwrap());
        let ctx = ToolContext {
            session_id: None,
            agent_name: "code".into(),
            tool_call_id: "c1".into(),
            denied: std::sync::Arc::new(appv3_tools::DeniedPaths::with(&dir, None, Some(vec![]), Some(vec![]))),
            workspace: Some(dir.to_string_lossy().to_string()),
            output: None,
            metadata: Default::default(),
            messages: None,
        };
        let args = serde_json::json!({
            "action": "create", "name": "check-deploy", "schedule_type": "every",
            "at_datetime": "", "every_seconds": 90, "cron_expression": "", "timezone": "",
            "prompt": "x", "session_id": "", "max_runs": 2, "enabled": false, "slug": ""
        });
        let out = match ScheduleTaskTool.run(&ctx, args).await {
            Ok(ToolOutput::Text(t)) => t,
            other => panic!("unexpected: {other:?}"),
        };
        assert!(out.starts_with("Scheduled task created."), "{out}");
        assert!(out.contains("schedule    : every"), "{out}");
    }
}
