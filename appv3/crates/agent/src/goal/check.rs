//! `update_goal`: a completion claim and the check that judges it, and a
//! blocked report.
//!
//! A `complete` claim is checked by one extra model request over the
//! session's own history and request frame, plus a hidden `<goal_check>`
//! message with the objective, the claimed evidence, the [`runtime_log`] of
//! what actually ran, and the task board. The verdict goes on the goal row;
//! nothing of the check is saved to the transcript.

use super::{end, fence, pause, plan_work, publish, reason, save, spent, GOAL_NOTE_KEY, GOAL_TURN_KEY, MAX_CHECK_FAILURES, MAX_REJECTED_CLAIMS};
use crate::hooks::otel::{set_usage_span_attributes, GOAL_ID_ATTR, WORKSPACE_ATTR};
use crate::session::AgentSession;
use crate::streaming::{fit_request_images, merge_consecutive_user_messages, ModelError, RetryItem, RetryStream};
use anyhow::{anyhow, Result};
use appv3_core::otel::{self, Span, SpanCtx, SpanKind};
use appv3_db::codec::db_id;
use appv3_db::{self as db, SessionGoal, GOAL_ACHIEVED};
use appv3_providers::usage::usage_to_dict;
use appv3_providers::{AssistantMessage, ChatMessage, Kwargs, ToolCall, Usage};
use appv3_tools::ToolContext;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

/// Longest a completion check may take.
const CHECK_TIMEOUT: Duration = Duration::from_secs(300);
/// Times the check is asked when it answers without a verdict (sampling can
/// slip back into the agent's role); a second miss is a failed check.
const CHECK_ATTEMPTS: usize = 2;
/// The hidden message that asks the completion check for a verdict.
/// `log` is the [`runtime_log`], fenced already; `board` the task board.
pub(super) fn check_text(objective: &str, evidence: &str, log: &str, board: &str) -> String {
    let (objective, evidence) = (fence(objective.trim(), &CHECK_TAGS), fence(evidence.trim(), &CHECK_TAGS));
    let tasks = if board.trim().is_empty() { NO_TASKS.to_string() } else { fence(board.trim(), &CHECK_TAGS) };
    let notes = crate::prompts::s("runtime_notes");
    fill(crate::prompts::s("goal_check"), &[("objective", &objective), ("evidence", &evidence), ("log", log), ("tasks", &tasks), ("runtime_notes", notes)])
}

/// The check's task board when the agent tracked no tasks.
pub(super) const NO_TASKS: &str = "No tasks were tracked.";

/// `template` with each `{key}` of `values` filled in one pass, so text put
/// in (an objective, evidence, a command) is never filled in turn.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        match values.iter().find(|(k, _)| tail.strip_prefix(k).is_some_and(|t| t.starts_with('}'))) {
            Some((k, v)) => {
                out.push_str(v);
                rest = &tail[k.len() + 1..];
            }
            None => {
                out.push('{');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Tags of the check message that text inserted into it must not open or close.
const CHECK_TAGS: [&str; 5] = ["goal_check", "claimed_evidence", "objective", "runtime_log", "task_board"];
/// [`spent`] from a provider reply's usage (the completion check).
fn call_tokens(u: &Usage) -> i64 {
    spent(u.prompt_tokens, u.cached_tokens.unwrap_or(0), u.completion_tokens)
}

// ── Verdict ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Verdict {
    pub met: bool,
    pub reason: String,
}

/// The check's JSON verdict, if its reply has one.
pub(super) fn read_verdict(text: &str) -> Option<Verdict> {
    let t = text.trim();
    let (s, e) = (t.find('{')?, t.rfind('}')?);
    let v = serde_json::from_str::<Value>(t.get(s..=e)?).ok()?;
    let met = match v.get("met") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.trim().parse::<bool>().ok()?,
        _ => return None,
    };
    let reason =
        v.get("reason").and_then(Value::as_str).map(str::trim).filter(|r| !r.is_empty()).unwrap_or(if met { "The check found the goal met." } else { "The check gave no reason." });
    Some(Verdict { met, reason: crate::util::head_chars(reason, 1000).to_string() })
}

/// Why a check reply without a verdict failed, for the agent and the user.
const NO_VERDICT: &str = "The check replied without a verdict.";
/// Starts the `update_goal` result of a check that gave no verdict (clients
/// read it to show the card).
const CHECK_FAILED_PREFIX: &str = "The completion check failed:";
/// Starts the `update_goal` result of a rejected claim (clients read it too,
/// and [`nothing_ran_since_rejection`] finds the last rejection by it).
const REJECTED_PREFIX: &str = "The check did not accept the claim:";

/// The check request: the system prompt, the history the claim was made
/// from (the prompt-cache prefix of the call that produced the claim), the
/// claim's words without its tool call or thinking, then the hidden check
/// message. Ending on the claim's words keeps the check a request of its
/// own: merged into the user's last message, a model can read it as more of
/// the task and answer that instead.
pub(super) fn check_messages(system_prompt: &str, history: &[ChatMessage], objective: &str, evidence: &str, log: &str, board: &str) -> Vec<ChatMessage> {
    let cut = history.iter().rposition(|m| matches!(m, ChatMessage::Assistant(_))).unwrap_or(history.len());
    let claim_text = match history.get(cut) {
        Some(ChatMessage::Assistant(AssistantMessage { content: Some(c), .. })) if !c.trim().is_empty() => Some(c.trim().to_string()),
        _ => None,
    };
    let mut msgs = Vec::with_capacity(cut + 3);
    msgs.push(ChatMessage::system(system_prompt));
    msgs.extend(history[..cut].iter().filter(|m| !matches!(m, ChatMessage::System { .. })).cloned());
    // A claim without words, after a user row (a goal reminder), gets a
    // stand-in line so the check does not merge into that row.
    let after_user = matches!(msgs.last(), Some(ChatMessage::User { .. }));
    match claim_text {
        Some(said) => msgs.push(ChatMessage::assistant(said)),
        None if after_user => msgs.push(ChatMessage::assistant(CLAIM_STAND_IN)),
        None => {}
    }
    msgs.push(ChatMessage::user(check_text(objective, evidence, log, board)));
    merge_consecutive_user_messages(msgs)
}

/// The claim's words in the check when the claiming reply had none.
const CLAIM_STAND_IN: &str = "I called `update_goal` with status \"complete\".";

// ── What ran ─────────────────────────────────────────────────────────────────

/// Most steps the runtime log lists; older ones are only counted.
pub(super) const LOG_STEPS: usize = 40;
/// Longest command the runtime log quotes, in characters.
const LOG_COMMAND_CHARS: usize = 200;

/// The part of `history` after `goal_id`'s rules note: the goal's own work.
/// All of it when the note is not there.
fn goal_part<'a>(history: &'a [ChatMessage], goal_id: &str) -> &'a [ChatMessage] {
    let id = db_id(goal_id);
    let is_note = |m: &ChatMessage| {
        matches!(m, ChatMessage::User { .. })
            && m.meta().extra.as_ref().is_some_and(|e| e.contains_key(GOAL_NOTE_KEY) && e.get("goal_id").and_then(Value::as_str).is_some_and(|g| db_id(g) == id))
    };
    history.iter().rposition(is_note).map_or(history, |i| &history[i + 1..])
}

/// Each tool call in `part`, in call order.
fn tool_calls(part: &[ChatMessage]) -> impl Iterator<Item = &ToolCall> {
    part.iter()
        .filter_map(|m| match m {
            ChatMessage::Assistant(a) => a.tool_calls.as_deref(),
            _ => None,
        })
        .flatten()
}

/// One line of the runtime log.
struct Step {
    line: String,
    /// A command that ran to an end (its output was seen).
    finished: bool,
    changed: Vec<String>,
}

/// A shell call's outcome from its result, and whether it ran to an end.
fn shell_outcome(result: Option<&str>, background: bool) -> (String, bool) {
    let Some(r) = result else { return ("no result yet".into(), false) };
    let first = r.lines().next().unwrap_or("").trim();
    if first.starts_with("Error") {
        return (format!("did not run ({})", crate::util::head_chars(first, 160)), false);
    }
    if background {
        return ("started in the background".into(), false);
    }
    let bracketed = |prefix: &str| first.strip_prefix(prefix).and_then(|s| s.strip_suffix(']')).map(str::to_string);
    if first == "[Succeeded]" {
        ("succeeded".into(), true)
    } else if let Some(code) = bracketed("[Failed — exit code ") {
        (format!("failed, exit code {code}"), true)
    } else if let Some(t) = bracketed("[Timed out after ") {
        (format!("timed out after {t}"), true)
    } else {
        ("ended, outcome not shown".into(), true)
    }
}

/// What the runtime saw the goal's work do, oldest first: each `shell`
/// command with its outcome and each applied `patch`, then the files changed
/// after the last command that ran to an end. The check reads it beside the
/// agent's claimed evidence, so a claim cannot cite a run that failed, never
/// happened, or came before later edits. Fenced for the check message.
pub(super) fn runtime_log(history: &[ChatMessage], goal_id: &str) -> String {
    let part = goal_part(history, goal_id);
    let results: HashMap<&str, &str> = part
        .iter()
        .filter_map(|m| match m {
            ChatMessage::Tool { tool_call_id, content, .. } => Some((tool_call_id.as_str(), content.as_deref().unwrap_or(""))),
            _ => None,
        })
        .collect();
    let mut steps = Vec::new();
    for call in tool_calls(part) {
        let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or(Value::Null);
        let result = results.get(call.id.as_str()).copied();
        match call.function.name.as_str() {
            "shell" => {
                // One line, and no backtick to end its quote: a command cannot
                // pose as another step.
                let command = args.get("command").and_then(Value::as_str).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ").replace('`', "'");
                let cut = crate::util::head_chars(&command, LOG_COMMAND_CHARS);
                let command = if cut.len() < command.len() { format!("{cut}…") } else { command.clone() };
                let background = args.get("background").is_some_and(crate::util::truthy);
                let (outcome, finished) = shell_outcome(result, background);
                steps.push(Step { line: format!("ran `{command}`: {outcome}"), finished, changed: vec![] });
            }
            "patch" if !result.is_some_and(|r| r.starts_with("Error")) => {
                let files = args.get("patch_text").and_then(Value::as_str).and_then(|t| appv3_tools::patch::parse_patch(t).ok()).unwrap_or_default();
                let changed: Vec<String> = files.into_iter().map(|f| f.move_to.unwrap_or(f.path)).collect();
                if changed.is_empty() {
                    continue;
                }
                let line = if result.is_some() { format!("changed {}", changed.join(", ")) } else { format!("patching {}: no result yet", changed.join(", ")) };
                steps.push(Step { line, finished: false, changed });
            }
            _ => {}
        }
    }
    if steps.is_empty() {
        return "Nothing ran: there are no shell or patch calls since the goal was set.".into();
    }
    let mut out = vec!["The runtime's record of this goal's shell and patch calls, oldest first (other tools are not listed):".to_string()];
    let skip = steps.len().saturating_sub(LOG_STEPS);
    if skip > 0 {
        out.push(format!("({skip} earlier steps not shown)"));
    }
    out.extend(steps.iter().enumerate().skip(skip).map(|(i, s)| format!("{}. {}", i + 1, s.line)));
    let after = steps.iter().rposition(|s| s.finished).map_or(0, |i| i + 1);
    let mut changed: Vec<&str> = Vec::new();
    for path in steps[after..].iter().flat_map(|s| &s.changed) {
        if !changed.contains(&path.as_str()) {
            changed.push(path);
        }
    }
    out.push(format!("Changed after the last finished command: {}.", if changed.is_empty() { "none".to_string() } else { changed.join(", ") }));
    fence(&out.join("\n"), &CHECK_TAGS)
}

/// Whether nothing new came in since the check last rejected a claim for
/// `goal_id`: no tool call other than `update_goal` has a result after the
/// rejection, and no message arrived (the user's, a subagent's report; a goal
/// reminder does not count). A claim then rests on what the check turned down.
pub(super) fn nothing_ran_since_rejection(history: &[ChatMessage], goal_id: &str) -> bool {
    let part = goal_part(history, goal_id);
    let names: HashMap<&str, &str> = tool_calls(part).map(|c| (c.id.as_str(), c.function.name.as_str())).collect();
    let is_claim = |id: &str| names.get(id).is_some_and(|n| *n == crate::tools::goal::UPDATE_GOAL_TOOL);
    let rejection = part.iter().rposition(|m| matches!(m, ChatMessage::Tool { tool_call_id, content: Some(c), .. } if c.starts_with(REJECTED_PREFIX) && is_claim(tool_call_id)));
    let Some(i) = rejection else { return false };
    !part[i + 1..].iter().any(|m| match m {
        ChatMessage::Tool { tool_call_id, .. } => !is_claim(tool_call_id),
        ChatMessage::User { meta, .. } => !meta.extra.as_ref().is_some_and(|e| e.contains_key(GOAL_TURN_KEY)),
        _ => false,
    })
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/// `goal_check` span attribute: which ask of one claim's check this request
/// is (a reply without a verdict is asked again).
pub(super) const CHECK_ATTEMPT_ATTR: &str = "goal_check.attempt";
/// `goal_check` span attribute: the verdict, absent when the reply had none.
pub(super) const CHECK_MET_ATTR: &str = "goal_check.met";
/// `goal_check` span attribute: the request was dropped unfinished.
pub(super) const CHECK_STOPPED_ATTR: &str = "goal_check.stopped";

/// Whose completion check a request is, for its span (API ids).
pub(super) struct CheckSpanTarget<'a> {
    pub(super) session_id: &'a str,
    pub(super) goal_id: &'a str,
    pub(super) agent: &'a str,
    pub(super) workspace: &'a str,
    pub(super) provider: Option<&'a str>,
    /// `provider:model`.
    pub(super) model_id: Option<&'a str>,
}

/// One completion-check request's `goal_check` span. The check is not an
/// agent run, so no `chat` span covers its request: this span carries its
/// spend, as `/btw` and compaction spans do, so the check counts in
/// telemetry and the spend totals. Dropped unfinished (the user stopped the
/// turn while it ran), it still ends.
pub(super) struct CheckSpan(pub(super) Span);

impl CheckSpan {
    pub(super) fn start(t: &CheckSpanTarget<'_>, attempt: usize) -> Self {
        let split = t.model_id.and_then(|m| m.split_once(':'));
        let mut attrs = vec![
            ("gen_ai.operation.name", json!("goal_check")),
            ("gen_ai.conversation.id", json!(t.session_id)),
            ("gen_ai.agent.name", json!(t.agent)),
            (GOAL_ID_ATTR, json!(t.goal_id)),
            (CHECK_ATTEMPT_ATTR, json!(attempt)),
        ];
        if let Some(p) = t.provider.or(split.map(|(p, _)| p)).filter(|p| !p.is_empty()) {
            attrs.push(("gen_ai.provider.name", json!(p)));
        }
        if let Some(m) = split.map(|(_, m)| m).or(t.model_id).filter(|m| !m.is_empty()) {
            attrs.push(("gen_ai.request.model", json!(m)));
        }
        if !t.workspace.is_empty() {
            attrs.push((WORKSPACE_ATTR, json!(t.workspace)));
        }
        Self(Span::start("goal_check", SpanKind::Client, attrs))
    }

    pub(super) fn ctx(&self) -> SpanCtx {
        self.0.ctx()
    }

    /// The request finished: `usage` as `usage_to_dict` gives it, `met` the
    /// verdict (`None` when the reply had none).
    pub(super) fn finish(self, usage: Option<&Value>, met: Option<bool>) {
        if let Some(u) = usage {
            set_usage_span_attributes(&self.0, u);
        }
        if let Some(met) = met {
            self.0.set_attr(CHECK_MET_ATTR, met);
        }
        self.0.set_ok();
        self.0.end();
    }

    pub(super) fn fail(self, why: &str) {
        self.0.set_attr("error.type", "GoalCheckError");
        self.0.exit_with_exception("GoalCheckError", why);
    }
}

impl Drop for CheckSpan {
    fn drop(&mut self) {
        if self.0.is_recording() {
            self.0.set_attr(CHECK_STOPPED_ATTR, true);
            self.0.set_ok();
            self.0.end();
        }
    }
}

// ── Claims ───────────────────────────────────────────────────────────────────

impl AgentSession {
    /// `update_goal` with `complete`: run the completion check on the claim.
    pub(crate) async fn goal_claim_complete(&self, ctx: &ToolContext, evidence: &str) -> Result<String, String> {
        let sid = ctx.session_id.clone().unwrap_or_else(|| self.session_id());
        let err = |e: anyhow::Error| e.to_string();
        let Some(mut goal) = db::live_session_goal(&self.pool, &sid).await.map_err(err)? else {
            return Err(NO_GOAL.into());
        };
        // A paused goal waits for the user: no check runs (and no spend) until
        // they resume it, even if the agent keeps claiming in the same turn.
        if !goal.is_active() {
            return Err(PAUSED_GOAL.into());
        }
        if evidence.trim().is_empty() {
            return Err("List the evidence: the commands you ran with their results, and the files you changed.".into());
        }
        let history: Vec<ChatMessage> = ctx.messages.as_ref().map(|m| m.as_ref().clone()).unwrap_or_default();
        // The same claim again, with nothing new to show: the check would see
        // what it rejected, so it is not asked (and not paid for) again.
        if goal.rejected_claims > 0 && nothing_ran_since_rejection(&history, &goal.id) {
            let _local = self.goal_lock().lock().await;
            match db::get_session_goal(&self.pool, &sid, &goal.id).await.map_err(err)? {
                Some(fresh) if fresh.is_active() => goal = fresh,
                Some(fresh) if fresh.is_live() => return Err(PAUSED_GOAL.into()),
                _ => return Ok(GOAL_GONE.into()),
            }
            let last = goal.detail.clone().unwrap_or_default();
            let why = format!("Nothing ran since the last rejected claim, so the check was not asked again. Its last reason: {last}");
            tracing::info!("goal_claim_repeated session_id={} goal_id={} rejected={}", sid, goal.id, goal.rejected_claims + 1);
            let text = reject(&mut goal, why.trim());
            let goal = save(&self.pool, &goal).await.map_err(err)?;
            publish(&sid, Some(&goal));
            return Ok(text);
        }
        // `Err` is why the check failed: it neither accepts nor rejects.
        let (checked, tokens) = match self.run_goal_check(&sid, &goal, &history, evidence).await {
            Ok((Some(v), tokens)) => (Ok(v), tokens),
            Ok((None, tokens)) => (Err(NO_VERDICT.to_string()), tokens),
            Err(e) => {
                tracing::warn!("goal_check_failed session_id={} goal_id={} error={}", sid, goal.id, e);
                (Err(format!("The check could not run: {e}.")), 0)
            }
        };
        // Build on the stored row: the user may have paused or cleared it
        // while the check ran.
        let mut local = self.goal_lock().lock().await;
        match db::get_session_goal(&self.pool, &sid, &goal.id).await.map_err(err)? {
            Some(fresh) if fresh.is_live() => goal = fresh,
            _ => return Ok(GOAL_GONE.into()),
        }
        goal.tokens_used += tokens;
        // The user paused it while the check ran: the pause stands, whatever
        // the verdict, and the verdict is kept for them to read.
        if !goal.is_active() {
            if let Ok(v) = &checked {
                let found = if v.met { "met" } else { "not met yet" };
                goal.detail = Some(format!("The check finished after the pause and found the goal {found}: {}", v.reason));
            }
            let goal = save(&self.pool, &goal).await.map_err(err)?;
            publish(&sid, Some(&goal));
            return Ok(PAUSED_DURING_CHECK.into());
        }
        let verdict = match checked {
            Ok(v) => {
                local.check_failures = 0;
                v
            }
            Err(why) => {
                local.check_failures += 1;
                tracing::info!("goal_check_no_result session_id={} goal_id={} failures={}", sid, goal.id, local.check_failures);
                let text = if local.check_failures >= MAX_CHECK_FAILURES {
                    local.check_failures = 0;
                    pause(&mut goal, reason::CHECK_FAILED, Some(why.clone()));
                    format!(
                        "{CHECK_FAILED_PREFIX} {why}\nThe check failed {MAX_CHECK_FAILURES} times in a row, so the goal is paused until the user resumes it. Summarize what is done and what remains."
                    )
                } else {
                    format!("{CHECK_FAILED_PREFIX} {why}\nThe claim was neither accepted nor rejected, and the goal stays active. Make sure the evidence shows in this conversation, then claim completion again.")
                };
                let goal = save(&self.pool, &goal).await.map_err(err)?;
                publish(&sid, Some(&goal));
                return Ok(text);
            }
        };
        goal.detail = Some(verdict.reason.clone());
        tracing::info!("goal_check session_id={} goal_id={} met={}", sid, goal.id, verdict.met);
        let text = if verdict.met {
            end(&mut goal, GOAL_ACHIEVED);
            format!(
                "The check confirmed the goal is met: {}\nThe goal is achieved. Stop goal work and give the user a short summary of what was done and how it was verified.",
                verdict.reason
            )
        } else {
            reject(&mut goal, &verdict.reason)
        };
        let goal = save(&self.pool, &goal).await.map_err(err)?;
        publish(&sid, Some(&goal));
        Ok(text)
    }

    /// `update_goal` with `blocked`: pause the goal with the agent's reason.
    pub(crate) async fn goal_claim_blocked(&self, ctx: &ToolContext, why: &str) -> Result<String, String> {
        let sid = ctx.session_id.clone().unwrap_or_else(|| self.session_id());
        let err = |e: anyhow::Error| e.to_string();
        let _lock = self.goal_lock().lock().await;
        let Some(mut goal) = db::live_session_goal(&self.pool, &sid).await.map_err(err)? else {
            return Err(NO_GOAL.into());
        };
        let why = why.trim();
        if why.is_empty() {
            return Err("Give the reason: what blocks you and what you need.".into());
        }
        pause(&mut goal, reason::BLOCKED, Some(why.to_string()));
        let goal = save(&self.pool, &goal).await.map_err(err)?;
        tracing::info!("goal_blocked session_id={} goal_id={}", sid, goal.id);
        publish(&sid, Some(&goal));
        Ok("The goal is paused as blocked until the user resumes it. Tell the user what blocks you and what you need.".into())
    }

    /// One check request; returns the verdict (`None` when the reply had
    /// none) and the tokens it spent. It runs on the session's own model and
    /// thinking level, like the turn the claim came from, so the provider's
    /// prompt cache covers it.
    async fn run_goal_check(&self, sid: &str, goal: &SessionGoal, history: &[ChatMessage], evidence: &str) -> Result<(Option<Verdict>, i64)> {
        let row = db::get_session(&self.pool, sid).await?.ok_or_else(|| anyhow!("session not found"))?;
        let agent = self.agent();
        let pin = self.pinned_credential(&row).await;
        let rp = self.resolve_runtime_provider(&agent, row.model.as_deref(), row.thinking_level.as_deref(), pin.as_deref()).map_err(|e| anyhow!(e.to_string()))?;
        let (provider, model) = (rp.provider(&agent), rp.effective_model.clone());
        let recorded = self.request_frame().lock().unwrap().clone().filter(|f| f.session_id == sid && !f.system_prompt.is_empty());
        let frame = match recorded {
            Some(f) => f,
            None => crate::side_question::rebuild_frame(self, &agent, sid, &row.workspace).await,
        };
        let label = model.clone().unwrap_or_else(|| "goal_check".into());
        let log = runtime_log(history, &goal.id);
        let board = plan_work(sid).board;
        let messages = fit_request_images(check_messages(&frame.system_prompt, history, &goal.objective, evidence, &log, &board), &label).await;
        let tools = if frame.tool_defs.is_empty() { None } else { Some(frame.tool_defs.as_slice()) };
        let mut kwargs = Kwargs::new();
        if crate::streaming::routes_by_session(provider.provider_name()) {
            kwargs.insert("session_id".into(), json!(sid));
        }
        let model_id = model.clone().or_else(|| provider.cost_model_id()).filter(|m| !m.is_empty());
        let (api_sid, api_goal) = (db::codec::api_uuid(&db_id(sid)), db::codec::api_uuid(&goal.id));
        let target = CheckSpanTarget {
            session_id: &api_sid,
            goal_id: &api_goal,
            agent: &agent.name,
            workspace: &row.workspace,
            provider: provider.provider_name(),
            model_id: model_id.as_deref(),
        };
        // The same request each time, so a second ask is cached too.
        let ask = || async {
            let mut rs = RetryStream::new(provider.clone(), label.clone(), &messages, tools, kwargs.clone(), None, None);
            let (mut text, mut usage, mut calls) = (String::new(), None, Vec::<String>::new());
            loop {
                match rs.next().await {
                    Ok(None) => break,
                    Ok(Some(RetryItem::Restart)) => {
                        text.clear();
                        calls.clear();
                    }
                    Ok(Some(RetryItem::Chunk(c))) => {
                        if c.usage.is_some() {
                            usage = c.usage.clone();
                        }
                        let Some(delta) = c.choices.first().map(|ch| &ch.delta) else { continue };
                        if let Some(t) = delta.content.as_deref() {
                            text.push_str(t);
                        }
                        // A tool call in the reply is dropped; its name is logged.
                        calls.extend(delta.tool_calls.iter().flatten().filter_map(|t| t.function.as_ref()?.name.clone()));
                    }
                    Err(ModelError::Agent(e)) => return Err(anyhow!(e.to_string())),
                    Err(ModelError::Transient { message, .. }) => return Err(anyhow!(message)),
                }
            }
            Ok((text, usage, calls))
        };
        let mut tokens = 0;
        for attempt in 1..=CHECK_ATTEMPTS {
            let span = CheckSpan::start(&target, attempt);
            let (text, usage, calls) = match otel::scope(Some(span.ctx()), tokio::time::timeout(CHECK_TIMEOUT, ask())).await {
                Ok(Ok(reply)) => reply,
                Ok(Err(e)) => {
                    span.fail(&e.to_string());
                    return Err(e);
                }
                Err(_) => {
                    span.fail("timed out");
                    return Err(anyhow!("timed out"));
                }
            };
            tokens += usage.as_ref().map_or(0, call_tokens);
            let verdict = read_verdict(&text);
            span.finish(usage.as_ref().map(|u| usage_to_dict(u, model_id.as_deref())).as_ref(), verdict.as_ref().map(|v| v.met));
            if let Some(v) = verdict {
                return Ok((Some(v), tokens));
            }
            tracing::warn!("goal_check_no_verdict session_id={} goal_id={} attempt={} reply_chars={} tool_calls={:?}", sid, goal.id, attempt, text.chars().count(), calls);
        }
        Ok((None, tokens))
    }
}

const NO_GOAL: &str = "There is no goal. update_goal only works while a goal runs a plan the user approved with \"Keep going until done\".";
const PAUSED_GOAL: &str = "The goal is paused, so no completion check runs until the user resumes it. Stop goal work and summarize what is done and what remains.";
const PAUSED_DURING_CHECK: &str = "The user paused the goal while the check ran, so it stays paused. Stop goal work and summarize what is done and what remains.";
const GOAL_GONE: &str = "The goal was cleared while the check ran. Stop goal work.";

/// Count a rejected claim on `goal`, pausing it at [`MAX_REJECTED_CLAIMS`];
/// returns the `update_goal` result.
fn reject(goal: &mut SessionGoal, why: &str) -> String {
    goal.rejected_claims += 1;
    if goal.rejected_claims >= MAX_REJECTED_CLAIMS {
        pause(goal, reason::UNVERIFIED, None);
        format!(
            "{REJECTED_PREFIX} {why}\nIt rejected {} claims in a row, so the goal is paused until the user resumes it. Summarize what is done and what remains.",
            goal.rejected_claims
        )
    } else {
        format!("{REJECTED_PREFIX} {why}\nThe goal stays active. Keep working on what the check names, show the evidence, then claim completion again.")
    }
}
