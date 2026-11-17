//! Session goals: an approved plan the lead keeps working through across
//! turns, until a completion check confirms the plan's **Done when**, the
//! agent reports a blocker, or a limit pauses it.
//!
//! - **Start:** the user approves a plan with "Keep going until done". The
//!   review route stores the goal with the plan's Done when as its objective
//!   ([`AgentSession::start_goal_from_plan`]) and saves the rules in a pinned
//!   note kept out of compaction ([`note_text`]); the goal's work is what
//!   follows that note. The note is released (unpinned, summarizable) once
//!   the goal is no longer live, and a short `<goal_ended>` note follows it
//!   ([`release_ended_notes`]).
//! - **Turns:** a lead turn that starts in Code mode while the goal is active
//!   is a goal turn (the turn the approval resumes is the first). It runs
//!   unattended unless `goals.allow_questions` is on, and [`GoalTurnHook`]
//!   counts its tokens and tool calls.
//! - **Continuing:** when a turn ends, the session accounts it and, if the
//!   goal is still active, queues a `<goal_reminder>` message and runs it
//!   like a steer ([`AgentSession::goal_turn_ended`]); the reminder names the
//!   plan and the next unfinished task. Queued messages, running subagents,
//!   an open question, and Plan mode make it wait; limits and turns without
//!   tool calls pause it.
//! - **Done:** the agent calls `update_goal`. A `complete` claim is checked
//!   by one extra model request over the session's own history and request
//!   frame (system prompt and tools), so the provider's prompt cache covers
//!   it, plus a hidden `<goal_check>` message that also carries the task
//!   board. Nothing of the check is saved to the transcript; the verdict goes
//!   on the goal row.
//! - **Telemetry:** a goal turn's `agent_run` span names its goal and turn
//!   ([`run_span_attrs`]), and each check request gets a `goal_check` span
//!   with its spend ([`check::CheckSpan`]).

mod check;
mod state;

use crate::hooks::otel::{GOAL_ID_ATTR, GOAL_TURN_ATTR};
use crate::hooks::{AgentState, Hook, RunContext};
use crate::session::AgentSession;
use anyhow::{anyhow, Result};
use appv3_core::runtime_settings::{self as rs, GoalSettings, MAX_GOAL_MAX_TURNS};
use appv3_db::codec::{db_id, json_col};
use appv3_db::{self as db, DbPool, NewMessage, SessionGoal, GOAL_ACHIEVED, GOAL_CLEARED, GOAL_PAUSED};
use appv3_providers::AssistantMessage;
use appv3_tools::{denied, todo};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use state::GoalEvent;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Longest accepted objective, in characters.
pub const MAX_OBJECTIVE_CHARS: usize = 4000;
/// Rejected completion claims in a row that pause the goal.
pub const MAX_REJECTED_CLAIMS: i64 = 3;
/// Completion checks in a row that fail (no verdict, an error) and pause the
/// goal. They do not count as rejections; this only bounds a loop of claims.
pub const MAX_CHECK_FAILURES: i64 = 3;
/// Goal turns in a row without a tool call that pause the goal.
pub const MAX_IDLE_TURNS: i64 = 2;

/// Goal state a session keeps in memory, guarded by its goal lock.
#[derive(Debug, Default)]
pub struct GoalLocal {
    /// Completion checks in a row that gave no verdict or could not run.
    check_failures: i64,
}

/// `extra` keys: the pinned rules note (with `goal_id`), a continuation
/// message, and the end note.
pub const GOAL_NOTE_KEY: &str = "goal_note";
pub const GOAL_TURN_KEY: &str = "goal_turn";
pub const GOAL_ENDED_KEY: &str = "goal_ended";

/// Why a goal is paused (`session_goals.pause_reason`).
pub mod reason {
    pub const STOPPED: &str = "stopped";
    pub const USER: &str = "user";
    pub const BLOCKED: &str = "blocked";
    pub const TURN_LIMIT: &str = "turn_limit";
    pub const NO_PROGRESS: &str = "no_progress";
    pub const UNVERIFIED: &str = "unverified";
    /// The completion check failed (no verdict, an error) for several claims in a row.
    pub const CHECK_FAILED: &str = "check_failed";
    pub const ERROR: &str = "error";
    pub const RESTART: &str = "restart";
}

#[derive(Debug, thiserror::Error)]
pub enum GoalError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

impl From<sqlx::Error> for GoalError {
    fn from(e: sqlx::Error) -> Self {
        GoalError::Db(e.into())
    }
}

/// Tell every client the session's goal changed. `goal` is its newest goal,
/// ended ones included (an achieved goal shows until the user moves on).
pub fn publish(session_id: &str, goal: Option<&SessionGoal>) {
    let sid = db::codec::api_uuid(&db_id(session_id));
    crate::broadcaster::publish("session_goal", json!({"session_id": sid, "goal": goal.map(SessionGoal::to_api)}));
}

// ── Text ─────────────────────────────────────────────────────────────────────

/// The pinned note with the goal's rules, saved after the objective message.
pub fn note_text(objective: &str, allow_questions: bool) -> String {
    let questions = crate::prompts::s(if allow_questions { "goal_questions_on" } else { "goal_questions_off" });
    crate::prompts::s("goal_note").replace("{questions}", questions).replace("{objective}", &fence(objective.trim(), &NOTE_TAGS))
}

/// Where the plan a goal runs stands: what its reminders point at and what
/// its check reads beside the claim.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PlanWork {
    /// The plan file, as tool results name it.
    pub plan: Option<String>,
    /// The task in progress, else the first pending one.
    pub next_task: Option<String>,
    /// The task board, one task per line; empty without tasks.
    pub board: String,
}

/// The plan and task board of `session_id`, read from its artifacts.
pub fn plan_work(session_id: &str) -> PlanWork {
    plan_work_in(&denied::session_artifacts_dir(Some(session_id)))
}

/// [`plan_work`] for the session whose artifacts dir is `dir`.
fn plan_work_in(dir: &std::path::Path) -> PlanWork {
    let plan = crate::plan::sync(dir).map(|d| d.display_path());
    let store = todo::load_store(&todo::todos_path(dir));
    let items = store["items"].as_array().cloned().unwrap_or_default();
    let with = |s: &str| items.iter().find(|i| i["status"].as_str() == Some(s));
    let next_task = with("in_progress").or_else(|| with("pending")).and_then(|i| i["content"].as_str()).map(String::from);
    let board = if items.is_empty() { String::new() } else { todo::format_items(&items) };
    PlanWork { plan, next_task, board }
}

/// The message that starts continuation turn `turn`.
pub fn reminder_text(goal: &SessionGoal, turn: i64, resumed: bool, work: &PlanWork) -> String {
    let attrs = format!("turn=\"{turn}\" max_turns=\"{}\" tokens_used=\"{}\"", goal.max_turns, goal.tokens_used);
    let mut extra = String::new();
    let mut line = |s: &str| {
        extra.push('\n');
        extra.push_str(s);
    };
    if resumed {
        line(crate::prompts::s("goal_reminder_resumed"));
    }
    if let Some(p) = &work.plan {
        line(&crate::prompts::s("goal_reminder_plan").replace("{path}", &fence(p, &REMINDER_TAGS)));
    }
    if let Some(t) = &work.next_task {
        line(&crate::prompts::s("goal_reminder_next_task").replace("{task}", &fence(t, &REMINDER_TAGS)));
    }
    if let Some(r) = goal.detail.as_deref().filter(|_| goal.rejected_claims > 0) {
        line(&crate::prompts::s("goal_reminder_last_check").replace("{reason}", &fence(r, &REMINDER_TAGS)));
    }
    if turn >= goal.max_turns {
        line(crate::prompts::s("goal_reminder_last_turn"));
    }
    crate::prompts::s("goal_reminder").replace("{attrs}", &attrs).replace("{extra}", &extra)
}

/// Whether two goal ids name the same goal, whatever their hyphenation.
fn same_id(a: &str, b: &str) -> bool {
    a.replace('-', "").eq_ignore_ascii_case(&b.replace('-', ""))
}

fn ended_text(status: &str, replaced: bool) -> String {
    if replaced {
        return crate::prompts::s("goal_replaced").replace("{status}", status);
    }
    let why = if status == GOAL_ACHIEVED { "achieved" } else { "cleared by the user" };
    crate::prompts::s("goal_ended").replace("{status}", status).replace("{why}", why)
}

/// Tags of each message that text inserted into it must not open or close.
const NOTE_TAGS: [&str; 2] = ["session_goal", "objective"];
const REMINDER_TAGS: [&str; 1] = ["goal_reminder"];

/// `text` with every `<tag` / `</tag` of `tags` (any case) defused to
/// `‹tag`, so inserted text (an objective, evidence, a check's reason)
/// cannot end its block and pose as the instructions around it.
pub(crate) fn fence(text: &str, tags: &[&str]) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (i, _) in lower.match_indices('<') {
        let rest = lower[i + 1..].strip_prefix('/').unwrap_or(&lower[i + 1..]);
        if tags.iter().any(|t| rest.starts_with(t)) {
            out.push_str(&text[last..i]);
            out.push('‹');
            last = i + 1;
        }
    }
    out.push_str(&text[last..]);
    out
}

// ── Decisions ────────────────────────────────────────────────────────────────

/// What a goal does when a turn ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// Start continuation turn `n`.
    Continue(i64),
    Pause(&'static str),
}

/// The next step for an active goal whose turns are accounted.
pub fn next_step(goal: &SessionGoal) -> Next {
    if goal.turns_used >= goal.max_turns {
        return Next::Pause(reason::TURN_LIMIT);
    }
    if goal.idle_turns >= MAX_IDLE_TURNS {
        return Next::Pause(reason::NO_PROGRESS);
    }
    Next::Continue(goal.turns_used + 1)
}

/// Add one finished goal turn to `goal`.
pub fn account(goal: &mut SessionGoal, tokens: i64, tool_calls: i64, seconds: i64) {
    goal.turns_used += 1;
    goal.tokens_used += tokens.max(0);
    goal.active_seconds += seconds.max(0);
    goal.idle_turns = if tool_calls == 0 { goal.idle_turns + 1 } else { 0 };
}

pub fn pause(goal: &mut SessionGoal, why: &str, detail: Option<String>) {
    if state::transition(goal, GoalEvent::Pause { reason: why.into() }).is_ok() && detail.is_some() {
        goal.detail = detail;
    }
}

/// End the goal: achieved (only an active one) or cleared.
fn end(goal: &mut SessionGoal, how: GoalEvent) {
    let _ = state::transition(goal, how);
}

/// Make a paused goal active again with a fresh allowance where a limit
/// stopped it: another settings-sized batch of turns.
pub fn resume(goal: &mut SessionGoal, settings: &GoalSettings) {
    if goal.turns_used >= goal.max_turns {
        goal.max_turns = goal.turns_used + settings.max_turns();
    }
    if state::transition(goal, GoalEvent::Resume).is_err() {
        return;
    }
    goal.detail = None;
    goal.rejected_claims = 0;
    goal.idle_turns = 0;
}

/// Tokens one model call spent: uncached input plus output.
fn spent(input: i64, cached: i64, output: i64) -> i64 {
    (input - cached).max(0) + output
}

/// [`spent`] from a call's `usage` event payload.
pub fn usage_tokens(usage: &Value) -> i64 {
    let n = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0);
    spent(n("input"), n("cache"), n("output"))
}

// ── Turn counters ────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct TurnCounters {
    tokens: AtomicI64,
    tool_calls: AtomicI64,
}

impl TurnCounters {
    pub fn tokens(&self) -> i64 {
        self.tokens.load(Ordering::SeqCst)
    }
    pub fn tool_calls(&self) -> i64 {
        self.tool_calls.load(Ordering::SeqCst)
    }
}

/// Counts a goal turn's model tokens and tool calls.
pub struct GoalTurnHook {
    pub counters: Arc<TurnCounters>,
}

#[async_trait]
impl Hook for GoalTurnHook {
    async fn after_model(&self, _ctx: &RunContext, _state: &mut AgentState, resp: &mut AssistantMessage) {
        if let Some(u) = resp.meta.extra.as_ref().and_then(|e| e.get("usage")) {
            self.counters.tokens.fetch_add(usage_tokens(u), Ordering::SeqCst);
        }
        let calls = resp.tool_calls.as_ref().map_or(0, Vec::len) as i64;
        self.counters.tool_calls.fetch_add(calls, Ordering::SeqCst);
    }
}

/// The goal turn a lead turn is running, if any.
pub struct GoalTurn {
    pub goal_id: String,
    pub started: Instant,
    pub counters: Arc<TurnCounters>,
}

/// How a turn ended, for [`AgentSession::goal_turn_ended`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEnd {
    Completed,
    /// Paused on a question or a plan review.
    Suspended,
    Stopped,
    Failed(Option<String>),
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/// The `agent_run` span attributes of a turn working on `goal`, which has
/// accounted the turns before it.
pub fn run_span_attrs(goal: &SessionGoal) -> Vec<(&'static str, Value)> {
    vec![(GOAL_ID_ATTR, json!(db::codec::api_uuid(&goal.id))), (GOAL_TURN_ATTR, json!(goal.turns_used + 1))]
}

// ── Storage ──────────────────────────────────────────────────────────────────

/// Check a new goal's objective (the plan's Done when) and turn limit.
pub fn validate(objective: &str, max_turns: Option<i64>) -> Result<(), GoalError> {
    let objective = objective.trim();
    if objective.is_empty() {
        return Err(GoalError::Invalid("The plan has no Done when: add one to keep going until done.".into()));
    }
    if objective.chars().count() > MAX_OBJECTIVE_CHARS {
        return Err(GoalError::Invalid(format!("The goal must be at most {MAX_OBJECTIVE_CHARS} characters.")));
    }
    if matches!(max_turns, Some(n) if !(1..=MAX_GOAL_MAX_TURNS).contains(&n)) {
        return Err(GoalError::Invalid(format!("max_turns must be from 1 to {MAX_GOAL_MAX_TURNS}.")));
    }
    Ok(())
}

/// `extra` of a goal's pinned rules note.
pub fn note_extra(goal: &SessionGoal) -> Map<String, Value> {
    let mut note = Map::new();
    note.insert("hidden_from_user".into(), json!(true));
    note.insert("hidden_from_summary".into(), json!(true));
    note.insert(GOAL_NOTE_KEY.into(), json!(true));
    note.insert("goal_id".into(), json!(db::codec::api_uuid(&goal.id)));
    note
}

/// Whether `session_id` has an active goal (one that takes turns now, or
/// waits only for Code mode, queued messages or subagents).
pub async fn has_active_goal(pool: &DbPool, session_id: &str) -> Result<bool> {
    Ok(db::live_session_goal(pool, session_id).await?.is_some_and(|g| g.is_active()))
}

/// Release the rules note of every goal that is no longer live: unpin it and
/// let compaction summarize it, then add a `<goal_ended>` note. Only call
/// between turns: it appends rows. Returns how many goals it released.
pub async fn release_ended_notes(pool: &DbPool, session_id: &str) -> Result<usize> {
    // Most sessions never had a goal: skip the note scan for them.
    if db::latest_session_goal(pool, session_id).await?.is_none() {
        return Ok(0);
    }
    let mut released = 0;
    let latest = db::latest_session_goal(pool, session_id).await?.map(|g| g.id);
    for (id, extra) in db::unreleased_goal_notes(pool, session_id).await? {
        let Some(Value::Object(mut extra)) = json_col(extra.as_deref()) else { continue };
        let Some(goal_id) = extra.get("goal_id").and_then(Value::as_str).map(String::from) else { continue };
        let goal = db::get_session_goal(pool, session_id, &goal_id).await?;
        if goal.as_ref().is_some_and(SessionGoal::is_live) {
            continue;
        }
        extra.shift_remove("hidden_from_summary");
        // A newer goal (from a newly approved plan) replaced this one: its
        // end must not read as "stop working".
        let replaced = latest.as_deref().is_some_and(|l| !same_id(l, &goal_id));
        let status = goal.map(|g| g.status).unwrap_or_else(|| GOAL_CLEARED.into());
        let mut e = Map::new();
        e.insert("hidden_from_user".into(), json!(true));
        e.insert(GOAL_ENDED_KEY.into(), json!(status));
        e.insert("goal_id".into(), json!(goal_id));
        let ended = NewMessage { kind: Some("note".into()), extra: Some(e), ..NewMessage::user(ended_text(&status, replaced)) };
        db::release_goal_note(pool, session_id, &id, &Value::Object(extra), ended).await?;
        released += 1;
    }
    if released > 0 {
        db::bump_history_revision(pool, session_id, true).await?;
    }
    Ok(released)
}

/// Save the queued message that starts continuation turn `turn`.
async fn queue_reminder(pool: &DbPool, session_id: &str, goal: &SessionGoal, turn: i64, resumed: bool, check_failed: bool) -> Result<()> {
    let mut extra = Map::new();
    extra.insert(GOAL_TURN_KEY.into(), turn_extra(goal, turn, resumed, check_failed));
    let work = plan_work(session_id);
    db::save_queued_user_message(pool, session_id, &reminder_text(goal, turn, resumed, &work), Some(extra)).await?;
    Ok(())
}

/// `extra.goal_turn` of continuation turn `turn`: which goal and turn, and
/// why the goal went on, for the transcript's turn divider. `why` is
/// `resumed` (the user resumed it), `rejected` (the last check said not yet;
/// `check` is its reason), `check_failed` (the last check gave no verdict),
/// or `unclaimed` (the last turn ended without a claim).
fn turn_extra(goal: &SessionGoal, turn: i64, resumed: bool, check_failed: bool) -> Value {
    let check = goal.detail.as_deref().filter(|_| goal.rejected_claims > 0);
    let why = match (resumed, check, check_failed) {
        (true, ..) => "resumed",
        (_, Some(_), _) => "rejected",
        (_, None, true) => "check_failed",
        _ => "unclaimed",
    };
    let mut v = json!({"id": db::codec::api_uuid(&goal.id), "turn": turn, "max_turns": goal.max_turns, "why": why});
    if let Some(c) = check {
        v["check"] = json!(c);
    }
    v
}

async fn save(pool: &DbPool, goal: &SessionGoal) -> Result<SessionGoal> {
    db::save_session_goal(pool, goal).await?.ok_or_else(|| anyhow!("goal {} disappeared", goal.id))
}

/// End the live goal when an undo takes back `target`, a message from
/// before the goal started: the approval that started it, and its rules
/// note, go with it. Undoing a goal turn, or a message sent during the goal,
/// leaves it alone. Undo runs only while the session is idle.
pub async fn clear_undone_goal(pool: &DbPool, session_id: &str, target: &db::SessionMessage) -> Result<()> {
    let Some(mut goal) = db::live_session_goal(pool, session_id).await? else { return Ok(()) };
    let before = match db::goal_note_seq(pool, session_id, &goal.id).await? {
        Some(seq) => target.seq < seq,
        None => target.created_at < goal.created_at,
    };
    if !before {
        return Ok(());
    }
    end(&mut goal, GoalEvent::Clear);
    let goal = save(pool, &goal).await?;
    db::delete_queued_goal_reminders(pool, session_id).await?;
    tracing::info!("goal_cleared_by_undo session_id={} goal_id={}", session_id, goal.id);
    publish(session_id, Some(&goal));
    Ok(())
}

/// Keep the goals a restart left active running (see
/// [`crate::restart_resume`]). `continued`: lead sessions whose cut-off turn
/// runs again, and goes on with the goal when it ends. `not_continued`:
/// sessions whose turn stays stopped, so their goal pauses (reason
/// `restart`) and waits for Resume. Any other active goal was between turns:
/// its stale continuation is dropped and the next turn starts. Returns how
/// many goals were paused.
pub async fn continue_after_restart(pool: &DbPool, continued: &[String], not_continued: &[String]) -> usize {
    let goals = match db::active_session_goals(pool).await {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!("goal_restart_query_failed error={}", e);
            return 0;
        }
    };
    let has = |list: &[String], sid: &str| list.iter().any(|s| db_id(s) == sid);
    let mut paused = 0;
    for mut g in goals {
        let sid = db::codec::api_uuid(&g.session_id);
        if has(continued, &g.session_id) {
            tracing::info!("goal_continues_after_restart session_id={} goal_id={}", sid, g.id);
            continue;
        }
        if let Err(e) = db::delete_queued_goal_reminders(pool, &sid).await {
            tracing::warn!("goal_stale_reminder_drop_failed session_id={} error={}", sid, e);
        }
        if !has(not_continued, &g.session_id) {
            let ws = db::get_session(pool, &sid).await.ok().flatten().map(|r| r.workspace).filter(|w| !w.is_empty());
            let ws = ws.unwrap_or_else(|| std::env::current_dir().unwrap_or_default().display().to_string());
            match crate::manager::get_or_start_agent_session(&ws, Some(&sid)).await {
                Ok(Some(session)) => {
                    let kicked = session.kick_goal(&sid, false).await;
                    tracing::info!("goal_kept_after_restart session_id={} goal_id={} started_turn={}", sid, g.id, kicked);
                    continue;
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("goal_restart_session_failed session_id={} error={}", sid, e),
            }
        }
        pause(&mut g, reason::RESTART, None);
        match save(pool, &g).await {
            Ok(g) => {
                tracing::info!("goal_paused_after_restart session_id={} goal_id={}", sid, g.id);
                publish(&sid, Some(&g));
                paused += 1;
            }
            Err(e) => tracing::warn!("goal_pause_after_restart_failed session_id={} error={}", sid, e),
        }
    }
    paused
}

// ── Session ──────────────────────────────────────────────────────────────────

impl AgentSession {
    /// Store a new active goal, clearing a live one. `max_turns` defaults
    /// from settings. A goal has no token budget.
    pub async fn start_goal(&self, session_id: &str, objective: &str, max_turns: Option<i64>) -> Result<SessionGoal, GoalError> {
        validate(objective, max_turns)?;
        let settings = rs::goal_settings();
        let mut local = self.goal_lock().lock().await;
        local.check_failures = 0;
        let max_turns = max_turns.unwrap_or_else(|| settings.max_turns());
        let goal = db::insert_session_goal(&self.pool, session_id, objective.trim(), max_turns).await?;
        tracing::info!("goal_started session_id={} goal_id={} max_turns={}", session_id, goal.id, goal.max_turns);
        publish(session_id, Some(&goal));
        Ok(goal)
    }

    /// The user approved a plan with "Keep going until done": start a goal
    /// whose objective is the plan's Done when, and save its pinned rules
    /// note. Call between turns or while the turn waits on the review, before
    /// it resumes, so the resumed turn is the goal's first. A goal this one
    /// replaces has its rules released first.
    pub async fn start_goal_from_plan(&self, session_id: &str, objective: &str, max_turns: Option<i64>) -> Result<SessionGoal, GoalError> {
        let goal = self.start_goal(session_id, objective, max_turns).await?;
        release_ended_notes(&self.pool, session_id).await?;
        let text = note_text(objective, rs::goal_settings().allow_questions);
        let note = NewMessage { kind: Some("note".into()), pinned: Some(true), extra: Some(note_extra(&goal)), ..NewMessage::user(text) };
        db::save_message(&self.pool, session_id, note).await?;
        Ok(goal)
    }

    /// The session switched to Code mode: an active goal that waited in Plan
    /// mode starts its next turn (in the background; a running turn
    /// continues the goal itself when it ends).
    pub fn goal_after_code_mode(self: &Arc<Self>, session_id: &str) {
        let (session, sid) = (self.clone(), session_id.to_string());
        tokio::spawn(async move {
            session.kick_goal(&sid, false).await;
        });
    }

    /// The active goal a lead turn starting now in `interaction` mode works
    /// on, if any.
    pub(crate) async fn goal_for_turn(&self, session_id: &str, interaction: &str) -> Option<SessionGoal> {
        if self.parent_session_id.is_some() || interaction != "code" {
            return None;
        }
        match db::live_session_goal(&self.pool, session_id).await {
            Ok(g) => g.filter(SessionGoal::is_active),
            Err(e) => {
                tracing::warn!("goal_load_failed session_id={} error={}", session_id, e);
                None
            }
        }
    }

    /// Account a finished lead turn and decide what the goal does next. Runs
    /// in the turn's `finally`, before queued messages are started, so a
    /// continuation it queues runs as the next turn.
    pub(crate) async fn goal_turn_ended(&self, session_id: &str, turn: Option<GoalTurn>, how: TurnEnd) {
        if let Err(e) = self.goal_turn_ended_inner(session_id, turn, how).await {
            tracing::warn!("goal_turn_end_failed session_id={} error={}", session_id, e);
        }
    }

    async fn goal_turn_ended_inner(&self, session_id: &str, turn: Option<GoalTurn>, how: TurnEnd) -> Result<()> {
        let pool = &self.pool;
        if let Some(t) = turn {
            let _lock = self.goal_lock().lock().await;
            if let Some(mut g) = db::get_session_goal(pool, session_id, &t.goal_id).await? {
                account(&mut g, t.counters.tokens(), t.counters.tool_calls(), t.started.elapsed().as_secs() as i64);
                let g = save(pool, &g).await?;
                tracing::info!(
                    "goal_turn_accounted session_id={} goal_id={} status={} turns={}/{} tokens={}",
                    session_id,
                    g.id,
                    g.status,
                    g.turns_used,
                    g.max_turns,
                    g.tokens_used
                );
                publish(session_id, Some(&g));
            }
        }
        // A failed turn would fail again: wait for the user.
        if let TurnEnd::Failed(err) = &how {
            let _lock = self.goal_lock().lock().await;
            if let Some(mut g) = db::live_session_goal(pool, session_id).await?.filter(SessionGoal::is_active) {
                pause(&mut g, reason::ERROR, err.clone());
                let g = save(pool, &g).await?;
                tracing::info!("goal_paused session_id={} goal_id={} reason=error", session_id, g.id);
                publish(session_id, Some(&g));
            }
        }
        release_ended_notes(pool, session_id).await?;
        if how == TurnEnd::Completed {
            self.continue_goal(session_id, false).await?;
        }
        Ok(())
    }

    /// Queue the next turn of the session's active goal when nothing else
    /// should run first. Returns whether one was queued.
    async fn continue_goal(&self, session_id: &str, resumed: bool) -> Result<bool> {
        let pool = &self.pool;
        let local = self.goal_lock().lock().await;
        let Some(mut goal) = db::live_session_goal(pool, session_id).await?.filter(SessionGoal::is_active) else { return Ok(false) };
        // Queued messages run first; the goal goes on after them.
        if db::has_queued_user_messages(pool, session_id).await? {
            return Ok(false);
        }
        // Their reports start the next turn.
        if crate::subagents::has_pending_work(session_id) {
            return Ok(false);
        }
        if self.has_open_question().await {
            return Ok(false);
        }
        let mode = db::get_session(pool, session_id).await?.map(|r| r.interaction_mode).unwrap_or_default();
        if crate::interaction_mode::normalize(&mode) != "code" {
            return Ok(false);
        }
        match next_step(&goal) {
            Next::Continue(n) => {
                queue_reminder(pool, session_id, &goal, n, resumed, local.check_failures > 0).await?;
                tracing::info!("goal_continues session_id={} goal_id={} turn={}", session_id, goal.id, n);
                Ok(true)
            }
            Next::Pause(why) => {
                pause(&mut goal, why, None);
                let goal = save(pool, &goal).await?;
                tracing::info!("goal_paused session_id={} goal_id={} reason={}", session_id, goal.id, why);
                publish(session_id, Some(&goal));
                Ok(false)
            }
        }
    }

    /// Start the active goal's next turn when the session is idle (after a
    /// resume or a switch to Code mode). A running turn continues the goal
    /// itself when it ends.
    pub async fn kick_goal(&self, session_id: &str, resumed: bool) -> bool {
        let _guard = self.user_message_lock.lock().await;
        if self.has_active_user_turn() || self.parent_session_id.is_some() {
            return false;
        }
        match self.continue_goal(session_id, resumed).await {
            Ok(true) => self.activate_queued_user_messages(session_id).await,
            Ok(false) => false,
            Err(e) => {
                tracing::warn!("goal_kick_failed session_id={} error={}", session_id, e);
                false
            }
        }
    }

    /// Stop pressed: pause the active goal.
    pub(crate) async fn pause_goal_on_stop(&self, session_id: &str) {
        if self.parent_session_id.is_some() || session_id.is_empty() {
            return;
        }
        if let Err(e) = self.set_goal_paused(session_id, reason::STOPPED).await {
            tracing::warn!("goal_pause_on_stop_failed session_id={} error={}", session_id, e);
        }
    }

    /// Stop & send: the goal stays active. A continuation queued just before
    /// the stop must not run on top of the user's message, so it is dropped.
    pub(crate) async fn drop_goal_reminders_on_stop(&self, session_id: &str) {
        if self.parent_session_id.is_some() || session_id.is_empty() {
            return;
        }
        let _lock = self.goal_lock().lock().await;
        if let Err(e) = db::delete_queued_goal_reminders(&self.pool, session_id).await {
            tracing::warn!("goal_keep_on_stop_failed session_id={} error={}", session_id, e);
        }
    }

    async fn set_goal_paused(&self, session_id: &str, why: &str) -> Result<Option<SessionGoal>> {
        let _lock = self.goal_lock().lock().await;
        let Some(mut goal) = db::live_session_goal(&self.pool, session_id).await?.filter(SessionGoal::is_active) else { return Ok(None) };
        pause(&mut goal, why, None);
        let goal = save(&self.pool, &goal).await?;
        // A continuation queued just before the pause must not run.
        db::delete_queued_goal_reminders(&self.pool, session_id).await?;
        tracing::info!("goal_paused session_id={} goal_id={} reason={}", session_id, goal.id, why);
        publish(session_id, Some(&goal));
        Ok(Some(goal))
    }

    /// Pause: the current turn finishes; no new one starts.
    pub async fn pause_goal(&self, session_id: &str) -> Result<SessionGoal, GoalError> {
        match self.set_goal_paused(session_id, reason::USER).await? {
            Some(g) => Ok(g),
            None => db::live_session_goal(&self.pool, session_id).await?.ok_or_else(|| GoalError::Invalid("There is no goal to pause.".into())),
        }
    }

    /// Resume: make the goal active and start its next turn when
    /// the session is idle.
    pub async fn resume_goal(&self, session_id: &str) -> Result<SessionGoal, GoalError> {
        // The stopped turn ends without continuing the goal, and a turn that
        // is still running cannot be kicked: resumed now, nothing would run.
        if self.is_stopping() {
            return Err(GoalError::Invalid("The stopped turn is still ending. Resume the goal once it has stopped.".into()));
        }
        let goal = {
            let mut local = self.goal_lock().lock().await;
            let Some(mut goal) = db::live_session_goal(&self.pool, session_id).await? else {
                return Err(GoalError::Invalid("There is no goal to resume.".into()));
            };
            if goal.status == GOAL_PAUSED {
                local.check_failures = 0;
                resume(&mut goal, &rs::goal_settings());
                goal = save(&self.pool, &goal).await?;
                tracing::info!("goal_resumed session_id={} goal_id={}", session_id, goal.id);
                publish(session_id, Some(&goal));
            }
            goal
        };
        self.kick_goal(session_id, true).await;
        Ok(db::get_session_goal(&self.pool, session_id, &goal.id).await?.unwrap_or(goal))
    }

    /// Clear: end the live goal. A running turn finishes first.
    pub async fn clear_goal(&self, session_id: &str) -> Result<Option<SessionGoal>, GoalError> {
        let goal = {
            let _lock = self.goal_lock().lock().await;
            let Some(mut goal) = db::live_session_goal(&self.pool, session_id).await? else { return Ok(None) };
            end(&mut goal, GoalEvent::Clear);
            let goal = save(&self.pool, &goal).await?;
            db::delete_queued_goal_reminders(&self.pool, session_id).await?;
            tracing::info!("goal_cleared session_id={} goal_id={}", session_id, goal.id);
            publish(session_id, Some(&goal));
            goal
        };
        self.release_goal_notes_if_idle(session_id).await;
        Ok(Some(goal))
    }

    /// Release ended goals' notes now when no turn runs; a running turn
    /// releases them when it ends.
    pub async fn release_goal_notes_if_idle(&self, session_id: &str) {
        let _guard = self.user_message_lock.lock().await;
        if self.has_active_user_turn() {
            return;
        }
        if let Err(e) = release_ended_notes(&self.pool, session_id).await {
            tracing::warn!("goal_note_release_failed session_id={} error={}", session_id, e);
        }
    }
}

#[cfg(test)]
mod tests;
