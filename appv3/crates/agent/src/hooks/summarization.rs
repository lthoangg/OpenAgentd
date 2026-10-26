//! `SummarizationHook` — port of `app/agent/hooks/summarization.py`.

use super::{AgentState, Hook, ModelRequest, RunContext};
use crate::events::{self, UsageFrame};
use crate::plan;
use crate::prompts;
use crate::stream_store::store;
use crate::streaming::{merge_consecutive_user_messages, RetryItem, RetryStream};
use appv3_providers::{registry::get_model_limits, usage::usage_to_dict, ChatMessage, ContentBlock, Kwargs, LlmProvider, MessageMeta};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use super::otel::{set_usage_span_attributes, WORKSPACE_ATTR};
use appv3_core::otel::{self, Span, SpanKind};

/// Who a summarization span belongs to. The LLM-call span carries it too:
/// a compaction-only run's spend must stay attributable to its session
/// and workspace even if nothing else in the trace says so.
fn span_identity(ctx: &RunContext) -> Vec<(&'static str, Value)> {
    let mut attrs =
        vec![("gen_ai.agent.name", json!(ctx.agent_name)), ("gen_ai.conversation.id", json!(ctx.session_id.clone().unwrap_or_default())), ("run_id", json!(ctx.run_id))];
    if let Some(ws) = ctx.workspace.as_deref().filter(|w| !w.is_empty()) {
        attrs.push((WORKSPACE_ATTR, json!(ws)));
    }
    attrs
}

/// A failed summariser LLM call (`type(exc).__name__`, qualified name, `str(exc)`).
struct LlmFailure {
    name: String,
    qualified: String,
    message: String,
    cancelled: bool,
}

pub const DEFAULT_PROMPT_TOKEN_THRESHOLD: i64 = 250_000;
pub const CONTEXT_RATIO: f64 = 0.9;
pub const DEFAULT_KEEP_LAST_ASSISTANTS: usize = 3;
pub const CODING_KEEP_LAST_ASSISTANTS: usize = 0;
pub const DEFAULT_MAX_TOKEN_LENGTH: i64 = 16_000;
/// Smallest summary budget worth asking for when the context is nearly full.
pub const MIN_SUMMARY_TOKENS: i64 = 1_024;
pub const DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY: usize = 4;
/// Follows the summary in what the model reads. Most compactions happen
/// mid-turn, where the agent resumes from the summary alone; without this a
/// bare `## Goal…` user message reads like a new request.
const SUMMARY_HANDOFF_NOTE: &str =
    "This summary replaces the earlier conversation; it is not a new message from the user. If the latest request is unfinished, continue from its next steps.";
/// Ends the summary request when the user wrote nothing after the earlier note.
const NO_NEW_PROMPT_RULE: &str = "The user has sent no new message since the earlier handoff note: keep its latest user request unchanged and update only its status.";
/// Names the user-role messages above that the user did not write. The
/// summariser otherwise quoted a Code-mode note or a goal reminder as the
/// user's latest request.
const RUNTIME_NOTES_RULE: &str = "Some user-role messages above come from the runtime or other agents, not the user: notes in tags such as `<interaction_mode>`, `<goal_reminder>`, `<goal_ended>`, `<plan_updated>` or `<session_plan>`, and messages headed `[name]:` or `[Message from …]`. Never quote or record them as the user's words.";
/// Longest latest request repeated in the summary request; the full text is
/// in the conversation above it.
const MAX_LATEST_PROMPT_CHARS: usize = 4_000;

/// What the summariser is told about the user's latest request.
enum LatestPrompt {
    /// The newest message the user wrote, header removed.
    Wrote(String),
    /// A prior summary is newer than any message the user wrote.
    NoneSinceSummary,
    /// Neither: nothing to point at.
    Unknown,
}

impl LatestPrompt {
    fn text(&self) -> Option<&str> {
        match self {
            Self::Wrote(t) => Some(t),
            _ => None,
        }
    }
}

/// The newest message the user wrote among `ids`.
fn latest_prompt(messages: &[ChatMessage], ids: &[usize]) -> LatestPrompt {
    for &i in ids.iter().rev() {
        let m = &messages[i];
        if m.meta().is_summary() {
            return LatestPrompt::NoneSinceSummary;
        }
        if crate::history::is_user_prompt(m) {
            if let Some(text) = crate::history::prompt_text(m).map(str::trim).filter(|t| !t.is_empty()) {
                return LatestPrompt::Wrote(text.to_string());
            }
        }
    }
    LatestPrompt::Unknown
}

/// The part of the summary request that says which message the user wrote.
fn latest_prompt_hint(latest: &LatestPrompt) -> String {
    match latest {
        LatestPrompt::Wrote(text) => {
            let head = crate::util::head_chars(text, MAX_LATEST_PROMPT_CHARS);
            let cut = if head.len() < text.len() { "\n[…cut; the full message is in the conversation above]" } else { "" };
            let quoted = crate::goal::fence(head, &["latest_user_message"]);
            format!("{RUNTIME_NOTES_RULE}\nThe user's most recent message, which is their latest request:\n<latest_user_message>\n{quoted}{cut}\n</latest_user_message>")
        }
        LatestPrompt::NoneSinceSummary => format!("{RUNTIME_NOTES_RULE}\n{NO_NEW_PROMPT_RULE}"),
        LatestPrompt::Unknown => RUNTIME_NOTES_RULE.to_string(),
    }
}

/// `m` as the model reads it: a summary is framed as a handoff note. Applied
/// on every request (never stored), so the prompt-cache prefix stays stable
/// and the UI keeps showing the plain summary.
pub fn for_model(m: &ChatMessage) -> ChatMessage {
    let mut out = m.clone();
    if m.meta().is_summary() {
        if let ChatMessage::User { content: Some(text), .. } = &m {
            out.set_content(Some(format!("<conversation_summary>\n{text}\n</conversation_summary>\n{SUMMARY_HANDOFF_NOTE}")));
        }
    }
    out
}
/// Chars per token assumed for text no reported usage covers. Low on
/// purpose: over-counting the prompt only makes the summary budget smaller.
const FALLBACK_CHARS_PER_TOKEN: usize = 3;
/// Chars an image counts as; its base64 size says nothing about its token
/// cost (~1-2k tokens on current providers).
const IMAGE_CHARS: usize = 6_000;

fn blocks_chars(parts: Option<&[ContentBlock]>) -> usize {
    parts
        .unwrap_or_default()
        .iter()
        .map(|p| match p {
            ContentBlock::Text { text } => text.len(),
            _ => IMAGE_CHARS,
        })
        .sum()
}

/// Prompt text a message contributes, for proportional token estimates.
fn message_chars(m: &ChatMessage) -> usize {
    let len = |s: &Option<String>| s.as_deref().map_or(0, str::len);
    match m {
        ChatMessage::System { content, .. } => len(content),
        ChatMessage::User { content, parts, .. } => len(content) + blocks_chars(parts.as_deref()),
        ChatMessage::Tool { content, parts, name, .. } => len(content) + len(name) + blocks_chars(parts.as_deref()),
        ChatMessage::Assistant(a) => {
            len(&a.content) + len(&a.reasoning_content) + a.tool_calls.iter().flatten().map(|tc| tc.function.name.len() + tc.function.arguments.len()).sum::<usize>()
        }
    }
}

/// Prompt tokens the provider reported for the call that produced `m`.
fn reported_prompt_tokens(m: &ChatMessage) -> Option<i64> {
    let ChatMessage::Assistant(a) = m else { return None };
    a.meta.extra.as_ref()?.get("usage")?.get("input")?.as_i64().filter(|n| *n > 0)
}

/// Estimated prompt tokens of the summariser `request`.
///
/// The newest reply with reported usage gives the token count of everything
/// visible before it; messages after it are estimated from their length.
/// The request is a subset of that context (minus the keep window, plus the
/// summary instructions), so it scales by its share of the context's text.
fn estimate_request_tokens(visible: &[ChatMessage], system_prompt: &str, tools_chars: usize, request: &[ChatMessage]) -> i64 {
    let request_chars = request.iter().map(message_chars).sum::<usize>() + tools_chars;
    let fallback = |chars: usize| chars.div_ceil(FALLBACK_CHARS_PER_TOKEN) as i64;
    let Some((anchor, reported)) = visible.iter().enumerate().rev().find_map(|(i, m)| reported_prompt_tokens(m).map(|t| (i, t))) else {
        return fallback(request_chars);
    };
    let seen_chars = system_prompt.len() + tools_chars + visible[..anchor].iter().map(message_chars).sum::<usize>();
    let tail_chars: usize = visible[anchor..].iter().map(message_chars).sum();
    let context_tokens = reported + fallback(tail_chars);
    let context_chars = (seen_chars + tail_chars).max(1);
    (context_tokens as f64 * request_chars as f64 / context_chars as f64).ceil() as i64
}

/// Output budget for a summary whose request is `prompt_tokens` long: `cap`,
/// shrunk to what the context window leaves (minus a margin for estimate
/// error), but never below [`MIN_SUMMARY_TOKENS`]. `None` sends no limit:
/// with an unknown context window a fixed cap may not fit, while the
/// provider's default does.
fn summary_max_tokens(cap: i64, context_window: Option<i64>, prompt_tokens: i64) -> Option<i64> {
    if cap <= 0 {
        return None;
    }
    let window = context_window?;
    let margin = (prompt_tokens / 50).max(512);
    Some((window - prompt_tokens - margin).clamp(MIN_SUMMARY_TOKENS.min(cap), cap))
}

pub fn prompt_token_threshold_for_model(model_id: Option<&str>) -> i64 {
    let l = get_model_limits(model_id);
    let known: Vec<i64> = [l.context_length, l.max_input_tokens].into_iter().flatten().collect();
    match known.iter().min() {
        Some(m) => (*m as f64 * CONTEXT_RATIO) as i64,
        None => DEFAULT_PROMPT_TOKEN_THRESHOLD,
    }
}

pub fn resolve_prompt_token_threshold(model_id: Option<&str>, custom: Option<i64>) -> i64 {
    let auto = prompt_token_threshold_for_model(model_id);
    match custom {
        Some(c) if c < auto => c,
        _ => auto,
    }
}

/// Source of the user's `summarization.prompt_token_threshold` override.
pub type CustomThreshold = Arc<dyn Fn() -> Option<i64> + Send + Sync>;

fn custom_threshold_from_settings() -> Option<i64> {
    cached_custom_threshold(&appv3_core::settings::settings().runtime_settings_path())
}

/// Files modified this recently are always re-read: on filesystems with
/// coarse mtimes a second save in the same tick keeps the same stamp.
const RACY_WINDOW: Duration = Duration::from_secs(2);

struct CachedThreshold {
    path: PathBuf,
    /// `(mtime, len)` of `settings.yaml`, `None` when it could not be stat'ed.
    stamp: Option<(SystemTime, u64)>,
    value: Option<i64>,
}

static CUSTOM_THRESHOLD_CACHE: Mutex<Option<CachedThreshold>> = Mutex::new(None);

fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// `summarization.prompt_token_threshold` from `path`, re-parsed only when the
/// file's mtime or size changes (a stat is ~1µs; a parse is ~1ms).
fn cached_custom_threshold(path: &Path) -> Option<i64> {
    let stamp = file_stamp(path);
    let racy = stamp.is_some_and(|(mtime, _)| SystemTime::now().duration_since(mtime).map_or(true, |age| age < RACY_WINDOW));
    let mut cache = CUSTOM_THRESHOLD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(hit) = cache.as_ref().filter(|c| !racy && c.path == path && c.stamp == stamp) {
        return hit.value;
    }
    let value = appv3_core::runtime_settings::load_runtime_settings_from(path).ok().and_then(|s| s.summarization.prompt_token_threshold);
    *cache = Some(CachedThreshold { path: path.to_path_buf(), stamp, value });
    value
}

/// Called with `(session_id, summary)` after each successful compaction of a
/// session, and the newest message the user wrote that it covered (`None`
/// when it covered none); see [`crate::hooks::title::build_summary_retitle`].
pub type OnSummary = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

pub struct SummarizationHook {
    provider: Arc<dyn LlmProvider>,
    model_id: Option<String>,
    /// Read on every model call so a settings change applies mid-turn.
    custom_threshold: CustomThreshold,
    keep_last: usize,
    summary_prompt: String,
    /// Upper bound on the summary's `max_tokens`; 0 sends none.
    max_token_length: i64,
    /// Model context window (prompt + output), when the registry knows it.
    context_window: Option<i64>,
    min_since_last: usize,
    support_interrupt: bool,
    at_last_summary: Mutex<usize>,
    pending: Mutex<bool>,
    /// Session artifacts directory holding `plan.md`; see [`crate::plan`].
    plan_dir: Option<PathBuf>,
    on_summary: Option<OnSummary>,
}

/// `build_summarization_hook`.
pub fn build_summarization_hook(provider: Arc<dyn LlmProvider>, mode: &str, model_id: Option<&str>, support_interrupt: bool) -> Option<SummarizationHook> {
    let limits = get_model_limits(model_id);
    let max_len = limits.max_completion_tokens.map(|m| m.min(DEFAULT_MAX_TOKEN_LENGTH)).unwrap_or(DEFAULT_MAX_TOKEN_LENGTH);
    let threshold = resolve_prompt_token_threshold(model_id, custom_threshold_from_settings());
    tracing::info!(
        "summarization_config model={:?} context_length={:?} max_input_tokens={:?} effective_threshold={}",
        model_id,
        limits.context_length,
        limits.max_input_tokens,
        threshold
    );
    let coding = mode == "coding";
    Some(SummarizationHook {
        provider,
        model_id: model_id.map(String::from),
        custom_threshold: Arc::new(custom_threshold_from_settings),
        keep_last: if coding { CODING_KEEP_LAST_ASSISTANTS } else { DEFAULT_KEEP_LAST_ASSISTANTS },
        summary_prompt: prompts::s(if coding { "summary_coding" } else { "summary_chat" }).to_string(),
        max_token_length: max_len,
        context_window: limits.context_length,
        min_since_last: DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY,
        support_interrupt,
        at_last_summary: Mutex::new(0),
        pending: Mutex::new(false),
        plan_dir: None,
        on_summary: None,
    })
}

fn extra_truthy(m: &ChatMessage, key: &str) -> bool {
    m.meta().extra.as_ref().and_then(|e| e.get(key)).map(crate::util::truthy).unwrap_or(false)
}

/// `_find_assistant_cutoff` over `msgs` (indices into eligible).
fn find_assistant_cutoff(msgs: &[&ChatMessage], keep_last: usize) -> usize {
    if keep_last == 0 {
        return msgs.len();
    }
    let mut remaining = keep_last;
    for i in (0..msgs.len()).rev() {
        if msgs[i].role() == "assistant" {
            remaining -= 1;
            if remaining == 0 {
                return i;
            }
        }
    }
    0
}

/// `_expand_tool_pair_ids` over state indices.
fn expand_tool_pairs(messages: &[ChatMessage], pool: &[usize], seed: HashSet<usize>) -> HashSet<usize> {
    if seed.is_empty() {
        return seed;
    }
    let mut a_by: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut t_by: HashMap<String, HashSet<usize>> = HashMap::new();
    for &i in pool {
        match &messages[i] {
            ChatMessage::Assistant(a) => {
                for tc in a.tool_calls.iter().flatten() {
                    if !tc.id.is_empty() {
                        a_by.entry(tc.id.clone()).or_default().insert(i);
                    }
                }
            }
            ChatMessage::Tool { tool_call_id, .. } if !tool_call_id.is_empty() => {
                t_by.entry(tool_call_id.clone()).or_default().insert(i);
            }
            _ => {}
        }
    }
    let mut expanded = seed;
    loop {
        let mut changed = false;
        for &i in pool {
            if !expanded.contains(&i) {
                continue;
            }
            let mut related = HashSet::new();
            match &messages[i] {
                ChatMessage::Assistant(a) => {
                    for tc in a.tool_calls.iter().flatten() {
                        related.extend(t_by.get(&tc.id).cloned().unwrap_or_default());
                    }
                }
                ChatMessage::Tool { tool_call_id, .. } if !tool_call_id.is_empty() => {
                    related.extend(a_by.get(tool_call_id).cloned().unwrap_or_default());
                }
                _ => {}
            }
            for r in related {
                if expanded.insert(r) {
                    changed = true;
                }
            }
        }
        if !changed {
            return expanded;
        }
    }
}

/// `_skill_tool_pair_ids`.
fn skill_tool_pairs(messages: &[ChatMessage], pool: &[usize]) -> HashSet<usize> {
    let mut call_ids = HashSet::new();
    let mut ids = HashSet::new();
    let mut seen = HashSet::new();
    for &i in pool {
        if let ChatMessage::Assistant(a) = &messages[i] {
            for tc in a.tool_calls.iter().flatten() {
                if tc.id.is_empty() || tc.function.name != "skill" {
                    continue;
                }
                let args: Value = serde_json::from_str(if tc.function.arguments.is_empty() { "{}" } else { &tc.function.arguments }).unwrap_or(Value::Null);
                let Some(name) = args.get("skill_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                    continue;
                };
                if !seen.insert(name.to_string()) {
                    continue;
                }
                call_ids.insert(tc.id.clone());
                ids.insert(i);
            }
        }
    }
    if call_ids.is_empty() {
        return HashSet::new();
    }
    for &i in pool {
        if let ChatMessage::Tool { tool_call_id, .. } = &messages[i] {
            if call_ids.contains(tool_call_id) {
                ids.insert(i);
            }
        }
    }
    expand_tool_pairs(messages, pool, ids)
}

/// The newest Plan/Code instruction note in `pool`, if any.
///
/// The note is appended once per mode switch and is not re-added while it
/// exists in history, so compacting it away would leave the model without
/// the active mode's rules (Plan mode's read-only workflow and
/// plan tools) until the next switch. Older notes are
/// superseded and compact like anything else.
fn active_mode_note(messages: &[ChatMessage], pool: &[usize]) -> Option<usize> {
    pool.iter().rev().copied().find(|&i| extra_truthy(&messages[i], "interaction_mode_prompt"))
}

/// Restate the session plan in a pinned note just before the summary at
/// `summary_at`, so the summary (latest progress and request) is still read
/// last and the plan survives the reload window like the mode note does.
///
/// Skipped while an earlier plan note is still in the kept window. Earlier
/// notes that were summarised are already excluded and unpinned like any
/// other message.
fn carry_plan(state: &mut AgentState, summary_at: usize, note: Option<String>) -> bool {
    let Some(note) = note else {
        return false;
    };
    let in_context = state.messages.iter().filter(|m| !m.meta().exclude_from_context).any(|m| extra_truthy(m, plan::SESSION_PLAN_KEY));
    if in_context {
        return false;
    }
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert(plan::SESSION_PLAN_KEY.into(), json!(true));
    let meta = MessageMeta { kind: "note".into(), pinned: true, extra: Some(extra), ..Default::default() };
    state.messages.insert(summary_at, ChatMessage::User { content: Some(note), parts: None, meta });
    true
}

impl SummarizationHook {
    /// Effective trigger for the next model call.
    fn threshold(&self) -> i64 {
        resolve_prompt_token_threshold(self.model_id.as_deref(), (self.custom_threshold)())
    }

    pub fn with_plan_dir(mut self, dir: PathBuf) -> Self {
        self.plan_dir = Some(dir);
        self
    }

    pub fn with_on_summary(mut self, f: OnSummary) -> Self {
        self.on_summary = Some(f);
        self
    }

    fn at_user_turn_boundary(state: &AgentState) -> bool {
        let visible = state.messages_for_llm();
        let Some(last) = visible.last() else {
            return true;
        };
        if !matches!(last, ChatMessage::User { .. }) || last.meta().is_summary() {
            return false;
        }
        if extra_truthy(last, "hidden_from_summary") {
            return false;
        }
        match last.meta().extra.as_ref().and_then(|e| e.get("from_agent")) {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s == "user",
            _ => false,
        }
    }

    /// `_call_llm` inside the `summarization_llm_call` CLIENT span.
    async fn call_llm(&self, ctx: &RunContext, messages: Vec<ChatMessage>, tools: Option<&[Value]>, max_tokens: Option<i64>) -> Result<(String, Option<Value>), LlmFailure> {
        let span = Span::start("summarization_llm_call", SpanKind::Client, span_identity(ctx));
        let t0 = std::time::Instant::now();
        let model_id = self.model_id.clone().or_else(|| self.provider.cost_model_id()).filter(|m| !m.is_empty());
        let mut provider_name = self.provider.provider_name().filter(|p| !p.is_empty()).map(String::from);
        span.set_attr("gen_ai.operation.name", "summarization");
        if let Some(p) = &provider_name {
            span.set_attr("gen_ai.provider.name", p.as_str());
        }
        if let Some(mid) = &model_id {
            let mut model_name = mid.clone();
            if let Some((pp, pm)) = mid.split_once(':') {
                if provider_name.is_none() {
                    provider_name = Some(pp.to_string()).filter(|p| !p.is_empty());
                }
                if !pm.is_empty() {
                    model_name = pm.to_string();
                }
            }
            span.set_attr("gen_ai.request.model", model_name);
            if let Some(p) = &provider_name {
                span.set_attr("gen_ai.provider.name", p.as_str());
            }
        }
        if let Some(m) = max_tokens {
            span.set_attr("gen_ai.request.max_tokens", m);
        }
        let res =
            otel::scope(Some(span.ctx()), self.call_llm_inner(ctx, messages, tools, max_tokens, model_id.clone(), crate::streaming::routes_by_session(provider_name.as_deref())))
                .await;
        match res {
            Err(f) => {
                if f.cancelled {
                    span.exit_with_exception("asyncio.exceptions.CancelledError", "");
                } else {
                    span.set_attr("error.type", f.name.as_str());
                    span.set_error();
                    span.exit_with_exception(&f.qualified, &f.message);
                }
                Err(f)
            }
            Ok((text, last_usage)) => {
                span.set_attr("summarization.llm_duration_s", json!(appv3_core::pymath::py_round(t0.elapsed().as_secs_f64(), 3)));
                span.set_attr("summarization.response_length", text.chars().count());
                let usage = last_usage.map(|u| usage_to_dict(&u, model_id.as_deref()));
                if let Some(u) = &usage {
                    tracing::info!(
                        "summarization_usage model={:?} input={:?} output={:?} cache={}",
                        model_id,
                        u.get("input"),
                        u.get("output"),
                        u.get("cache").cloned().unwrap_or(json!(0))
                    );
                    set_usage_span_attributes(&span, u);
                }
                span.set_ok();
                span.end();
                Ok((text.trim().to_string(), usage))
            }
        }
    }

    async fn call_llm_inner(
        &self,
        ctx: &RunContext,
        messages: Vec<ChatMessage>,
        tools: Option<&[Value]>,
        max_tokens: Option<i64>,
        model_id: Option<String>,
        send_session_id: bool,
    ) -> Result<(String, Option<appv3_providers::Usage>), LlmFailure> {
        let mut kw = Kwargs::new();
        if let Some(m) = max_tokens {
            kw.insert("max_tokens".into(), json!(m));
        }
        kw.insert("tool_choice".into(), json!("none"));
        if send_session_id {
            if let Some(s) = &ctx.session_id {
                kw.insert("session_id".into(), json!(s));
            }
        }
        let label = model_id.clone().unwrap_or_else(|| "summarizer".into());
        let messages = crate::streaming::fit_request_images(messages, &label).await;
        let mut rs = RetryStream::new(self.provider.clone(), label, &messages, tools, kw, None, None);
        let mut text = String::new();
        let mut last_usage = None;
        loop {
            match rs.next().await {
                Ok(Some(RetryItem::Restart)) => text.clear(),
                Ok(Some(RetryItem::Chunk(c))) => {
                    if c.usage.is_some() {
                        last_usage = c.usage.clone();
                    }
                    if let Some(content) = c.choices.first().and_then(|ch| ch.delta.content.clone()).filter(|s| !s.is_empty()) {
                        text.push_str(&content);
                        if let Some(sid) = &ctx.session_id {
                            store().push_event(sid, &events::summarization_content(&ctx.agent_name, &content), false);
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    return Err(match e {
                        crate::streaming::ModelError::Agent(a) => {
                            let (name, qualified) = crate::errors::python_exception_names(&a);
                            LlmFailure { name: name.into(), qualified, message: a.to_string(), cancelled: matches!(a, crate::errors::AgentError::Cancelled) }
                        }
                        crate::streaming::ModelError::Transient { error_type, message } => {
                            LlmFailure { qualified: format!("httpx2.{error_type}"), name: error_type, message, cancelled: false }
                        }
                    })
                }
            }
        }
        Ok((text, last_usage))
    }

    fn emit_end(&self, ctx: &RunContext, summary: &str, error: bool, forced: bool) {
        if let Some(sid) = &ctx.session_id {
            let mut meta = json!({});
            if error {
                meta["error"] = json!(true);
            }
            if forced {
                meta["forced"] = json!(true);
            }
            store().push_event(sid, &events::summarization_end(&ctx.agent_name, summary, Some(meta)), false);
        }
    }

    async fn summarise(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str) -> bool {
        tracing::info!("summarization_started session_id={:?} agent={}", ctx.session_id, ctx.agent_name);
        let mut attrs = span_identity(ctx);
        attrs.push(("summarization.prompt_tokens", json!(state.usage.last_prompt_tokens)));
        attrs.push(("summarization.threshold", json!(self.threshold())));
        let span = Span::start("summarization", SpanKind::Internal, attrs);
        let (done, cancelled) = otel::scope(Some(span.ctx()), self.summarise_inner(ctx, state, system_prompt, &span)).await;
        if cancelled {
            span.exit_with_exception("asyncio.exceptions.CancelledError", "");
        } else {
            span.end();
        }
        done
    }

    /// Returns `(summarised, cancelled)`.
    async fn summarise_inner(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str, span: &Span) -> (bool, bool) {
        // `/compact` and idle compaction run alone, not inside an agent run.
        let forced = state.meta_get("force_summarization") == Some(Value::Bool(true));
        let eligible: Vec<usize> = (0..state.messages.len())
            .filter(|&i| {
                let m = &state.messages[i];
                !m.meta().exclude_from_context && !matches!(m, ChatMessage::System { .. }) && !extra_truthy(m, "hidden_from_summary")
            })
            .collect();
        if eligible.is_empty() {
            tracing::debug!("summarization_skipped_no_messages session_id={:?}", ctx.session_id);
            span.set_attr("summarization.skipped", "no_messages");
            span.set_ok();
            return (false, false);
        }
        let refs: Vec<&ChatMessage> = eligible.iter().map(|&i| &state.messages[i]).collect();
        let cutoff = find_assistant_cutoff(&refs, self.keep_last);
        let seed: HashSet<usize> = if cutoff > 0 { eligible[..cutoff].iter().copied().collect() } else { eligible.iter().copied().collect() };
        let to_ids = expand_tool_pairs(&state.messages, &eligible, seed);
        let mut retained = skill_tool_pairs(&state.messages, &eligible);
        // A mode note already in the kept window stays where it is; retaining
        // it would move the summary below it.
        retained.extend(active_mode_note(&state.messages, &eligible).filter(|i| to_ids.contains(i)));
        let to_summarise: Vec<usize> = eligible.iter().copied().filter(|i| to_ids.contains(i)).collect();
        if to_summarise.is_empty() {
            tracing::debug!("summarization_skipped_all_messages_in_keep_window session_id={:?}", ctx.session_id);
            span.set_attr("summarization.skipped", "all_in_keep_window");
            span.set_ok();
            return (false, false);
        }
        let has_prior = to_summarise.iter().any(|&i| state.messages[i].meta().is_summary());
        let request_line = prompts::s(if has_prior { "summary_merge" } else { "summary_request" });
        let plan_note = self.plan_dir.as_deref().and_then(plan::carry_note);
        let mut prefix = Vec::new();
        if !system_prompt.is_empty() {
            prefix.push(ChatMessage::system(system_prompt));
        }
        // An earlier plan note is restated fresh from the file below; the
        // summariser would only copy it into the summary.
        // `for_model` keeps a prior summary as the main turn sent it, so the
        // request shares that turn's prompt-cache prefix.
        prefix.extend(to_summarise.iter().filter(|&&i| !extra_truthy(&state.messages[i], plan::SESSION_PLAN_KEY)).map(|&i| for_model(&state.messages[i])));
        let mut msgs = merge_consecutive_user_messages(prefix);
        // The hint goes in the final instruction, never into the
        // conversation above it, which shares the main turn's prompt cache.
        let latest = latest_prompt(&state.messages, &to_summarise);
        let mut request = format!("{request_line}\n\n{}\n\n{}", self.summary_prompt, latest_prompt_hint(&latest));
        if plan_note.is_some() {
            request.push_str("\n\n");
            request.push_str(plan::PLAN_SUMMARY_RULE);
        }
        msgs.push(ChatMessage::user(request));
        span.set_attr("summarization.messages_to_summarise", to_summarise.len());
        span.set_attr("summarization.keep_last_assistants", self.keep_last);
        span.set_attr("summarization.has_prior_summary", has_prior);

        if let Some(sid) = &ctx.session_id {
            store().push_event(sid, &events::summarization_start(&ctx.agent_name, forced), false);
        }
        let tools = if state.tool_defs.is_empty() { None } else { Some(state.tool_defs.as_slice()) };
        let tools_chars = tools.map_or(0, |t| serde_json::to_string(t).map_or(0, |s| s.len()));
        let estimated_prompt = estimate_request_tokens(&state.messages_for_llm(), system_prompt, tools_chars, &msgs);
        let max_tokens = summary_max_tokens(self.max_token_length, self.context_window, estimated_prompt);
        span.set_attr("summarization.estimated_prompt_tokens", estimated_prompt);
        let (text, usage) = match self.call_llm(ctx, msgs, tools, max_tokens).await {
            Ok(r) => r,
            Err(e) if e.cancelled => return (false, true),
            Err(e) => {
                tracing::error!("summarization_llm_failed session_id={:?} error={}", ctx.session_id, e.message);
                span.set_attr("error.type", e.name.as_str());
                span.set_error();
                self.emit_end(ctx, "", true, forced);
                return (false, false);
            }
        };
        if text.is_empty() {
            tracing::warn!("summarization_skipped_empty_response session_id={:?} agent={}", ctx.session_id, ctx.agent_name);
            span.set_attr("summarization.skipped", "empty_llm_response");
            span.set_ok();
            self.emit_end(ctx, "", true, forced);
            return (false, false);
        }
        let to_set: HashSet<usize> = to_summarise.iter().copied().collect();
        for (i, m) in state.messages.iter_mut().enumerate() {
            if to_set.contains(&i) && !retained.contains(&i) {
                let meta = m.meta_mut();
                meta.exclude_from_context = true;
                meta.pinned = false;
            }
        }
        for (i, m) in state.messages.iter_mut().enumerate() {
            if m.meta().is_summary() && !to_set.contains(&i) {
                m.meta_mut().exclude_from_context = true;
            }
        }
        let mut first_kept = match retained.iter().max() {
            Some(&mx) => mx + 1,
            None => state.messages.iter().position(|m| !m.meta().exclude_from_context).unwrap_or(state.messages.len()),
        };
        let last_excluded = state.messages.iter().rposition(|m| m.meta().exclude_from_context).map(|i| i as i64).unwrap_or(-1);
        first_kept = first_kept.max((last_excluded + 1) as usize);
        for m in state.messages[..first_kept].iter_mut() {
            if !m.meta().exclude_from_context && !matches!(m, ChatMessage::System { .. }) {
                m.meta_mut().pinned = true;
            }
        }
        let mut meta = MessageMeta { kind: "summary".into(), ..Default::default() };
        let mut e = Map::new();
        if let Some(u) = &usage {
            e.insert("usage".into(), u.clone());
        }
        if forced {
            e.insert("forced".into(), json!(true));
        }
        if !e.is_empty() {
            meta.extra = Some(e);
        }
        state.messages.insert(first_kept, ChatMessage::User { content: Some(text.clone()), parts: None, meta });
        let plan_carried = carry_plan(state, first_kept, plan_note);
        *self.at_last_summary.lock().unwrap() = state.messages.len();
        span.set_attr("summarization.summary_length", text.chars().count());
        span.set_attr("summarization.kept", eligible.len() - to_summarise.len());
        span.set_attr("summarization.plan_carried", plan_carried);
        span.set_ok();

        if let Some(sid) = &ctx.session_id {
            if let Some(u) = &usage {
                let int = |k: &str| u.get(k).and_then(|v| v.as_i64());
                let mut md = json!({"agent": ctx.agent_name, "summarization": true});
                if let Some(m) = self.model_id.clone().or_else(|| self.provider.cost_model_id()).filter(|m| !m.is_empty()) {
                    md["model"] = json!(m);
                }
                let p = int("input").unwrap_or(0);
                let c = int("output").unwrap_or(0);
                store().push_event(
                    sid,
                    &events::usage(
                        &UsageFrame {
                            prompt_tokens: p,
                            completion_tokens: c,
                            total_tokens: p + c,
                            cached_tokens: int("cache"),
                            thoughts_tokens: int("thoughts"),
                            tool_use_tokens: None,
                            estimated_cost_usd: u.get("cost").and_then(|c| c.get("estimated_usd")).cloned(),
                        },
                        md,
                    ),
                    false,
                );
            }
            self.emit_end(ctx, &text, false, forced);
            if let Some(f) = &self.on_summary {
                f(sid, &text, latest.text());
            }
        }
        tracing::info!("summarization_complete session_id={:?} summarised={}", ctx.session_id, to_summarise.len());
        (true, false)
    }
}

#[async_trait]
impl Hook for SummarizationHook {
    async fn before_model(&self, ctx: &RunContext, state: &mut AgentState, _req: &ModelRequest) -> Option<ModelRequest> {
        let force = state.meta_get("force_summarization") == Some(Value::Bool(true));
        let threshold = self.threshold();
        if threshold <= 0 && !force {
            return None;
        }
        if state.usage.last_prompt_tokens < threshold && !force {
            return None;
        }
        if self.min_since_last > 0 && !force {
            let at = *self.at_last_summary.lock().unwrap();
            if at > 0 && state.messages.len().saturating_sub(at) < self.min_since_last {
                return None;
            }
        }
        if !self.support_interrupt && !force && !Self::at_user_turn_boundary(state) {
            return None;
        }
        tracing::info!("summarization_triggered agent={} last_prompt_tokens={}", ctx.agent_name, state.usage.last_prompt_tokens);
        *self.pending.lock().unwrap() = true;
        None
    }

    async fn before_model_call(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str) -> bool {
        let pending = std::mem::replace(&mut *self.pending.lock().unwrap(), false);
        if !pending {
            return false;
        }
        self.summarise(ctx, state, system_prompt).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_providers::mock::MockProvider;

    fn hook(keep_last: usize) -> SummarizationHook {
        hook_with(Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")])), keep_last)
    }

    /// The per-model-call threshold read is served from memory until
    /// `settings.yaml` changes, and picks the change up on the next call.
    #[test]
    fn custom_threshold_is_cached_until_settings_yaml_changes() {
        use std::time::{Duration, SystemTime};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.yaml");
        let write = |value: &str, mtime: SystemTime| {
            std::fs::write(&path, format!("summarization:\n  prompt_token_threshold: {value}\n")).unwrap();
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
        };
        let saved = SystemTime::now() - Duration::from_secs(3600);

        write("15000", saved);
        assert_eq!(cached_custom_threshold(&path), Some(15_000));
        // Same size and mtime: the file is not re-parsed.
        write("16000", saved);
        assert_eq!(cached_custom_threshold(&path), Some(15_000), "unchanged file was re-parsed");
        // A save moves the mtime: the next call sees the new value.
        write("50000", saved + Duration::from_secs(60));
        assert_eq!(cached_custom_threshold(&path), Some(50_000));
        // A just-written file is always re-read, so two saves inside one
        // coarse mtime tick are not missed.
        let now = SystemTime::now();
        write("20000", now);
        assert_eq!(cached_custom_threshold(&path), Some(20_000));
        write("30000", now);
        assert_eq!(cached_custom_threshold(&path), Some(30_000));
        // Deleting the override falls back to the auto threshold.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(cached_custom_threshold(&path), None);
    }

    fn hook_with(provider: Arc<MockProvider>, keep_last: usize) -> SummarizationHook {
        SummarizationHook {
            provider,
            model_id: None,
            custom_threshold: Arc::new(|| Some(1)),
            keep_last,
            summary_prompt: "test summary prompt".into(),
            max_token_length: 0,
            context_window: None,
            min_since_last: 0,
            support_interrupt: true,
            at_last_summary: Mutex::new(0),
            pending: Mutex::new(false),
            plan_dir: None,
            on_summary: None,
        }
    }

    /// A persisted Plan/Code instruction note as history loading yields it.
    fn mode_note(mode: &str) -> ChatMessage {
        let mut m = ChatMessage::user(format!("<interaction_mode>\n## {mode} mode\n</interaction_mode>"));
        let meta = m.meta_mut();
        meta.kind = "note".into();
        meta.pinned = true;
        let mut extra = Map::new();
        extra.insert("hidden_from_user".into(), json!(true));
        extra.insert("interaction_mode".into(), json!(mode));
        extra.insert("interaction_mode_prompt".into(), json!(true));
        meta.extra = Some(extra);
        m
    }

    async fn compact(keep_last: usize, messages: Vec<ChatMessage>) -> AgentState {
        compact_with(&hook(keep_last), messages).await
    }

    fn ctx() -> RunContext {
        RunContext { session_id: None, run_id: "run".into(), agent_name: "test".into(), workspace: None }
    }

    #[test]
    fn summarization_spans_name_their_session_and_workspace() {
        let with_ws = RunContext { session_id: Some("s-1".into()), run_id: "run".into(), agent_name: "lead".into(), workspace: Some("/w/app".into()) };
        let attrs: HashMap<&str, Value> = span_identity(&with_ws).into_iter().collect();
        assert_eq!(attrs["gen_ai.conversation.id"], "s-1");
        assert_eq!(attrs["gen_ai.agent.name"], "lead");
        assert_eq!(attrs["run_id"], "run");
        assert_eq!(attrs[WORKSPACE_ATTR], "/w/app");
        let attrs: HashMap<&str, Value> = span_identity(&ctx()).into_iter().collect();
        assert!(!attrs.contains_key(WORKSPACE_ATTR));
    }

    async fn compact_with(hook: &SummarizationHook, messages: Vec<ChatMessage>) -> AgentState {
        let mut state = AgentState::new(messages, String::new());
        assert!(hook.summarise(&ctx(), &mut state, "sys").await, "compaction did not run");
        state
    }

    fn find<'a>(state: &'a AgentState, content: &str) -> (usize, &'a ChatMessage) {
        state.messages.iter().enumerate().find(|(_, m)| m.content() == Some(content)).unwrap_or_else(|| panic!("no message {content:?}"))
    }

    fn summary_index(state: &AgentState) -> usize {
        state.messages.iter().position(|m| m.meta().is_summary()).expect("summary inserted")
    }

    fn visible(state: &AgentState, content: &str) -> bool {
        state.messages_for_llm().iter().any(|m| m.content() == Some(content))
    }

    /// Compacting a Plan-mode session must not drop the Plan instructions: the
    /// note is appended once per switch and not re-added while it exists in
    /// history, so losing it leaves the model without the read-only workflow
    /// and plan tools for the rest of the mode.
    /// `/compact` and idle compaction mark their summary `forced`, so the UI
    /// can show it apart from the reply before it; auto-compaction does not.
    #[tokio::test]
    async fn forced_compaction_marks_its_summary() {
        let history = || vec![ChatMessage::user("Fix it."), ChatMessage::assistant("Fixed.")];
        let forced_of = |state: &AgentState| {
            let summary = &state.messages[summary_index(state)];
            summary.meta().extra.as_ref().and_then(|e| e.get("forced")).cloned()
        };

        let auto = compact(0, history()).await;
        assert_eq!(forced_of(&auto), None);

        let mut state = AgentState::new(history(), String::new());
        state.meta_set("force_summarization", json!(true));
        assert!(hook(0).summarise(&ctx(), &mut state, "sys").await, "compaction did not run");
        assert_eq!(forced_of(&state), Some(json!(true)));
    }

    #[tokio::test]
    async fn active_plan_mode_note_stays_in_context_after_compaction() {
        let note = mode_note("plan");
        let note_text = note.content().unwrap().to_string();
        let state = compact(0, vec![note, ChatMessage::user("Redesign the settings screen."), ChatMessage::assistant("I will inspect the current UI.")]).await;

        assert!(visible(&state, &note_text), "Plan-mode note left the LLM window");
        let (idx, kept) = find(&state, &note_text);
        // Pinned so the derived DB window (pinned rows + rows after the
        // summary) still contains it when the session is reloaded.
        assert!(kept.meta().pinned);
        assert!(idx < summary_index(&state));
        assert!(!visible(&state, "Redesign the settings screen."));
        assert!(!visible(&state, "I will inspect the current UI."));
    }

    #[tokio::test]
    async fn only_the_newest_mode_note_survives_compaction() {
        let plan = mode_note("plan");
        let code = mode_note("code");
        let (plan_text, code_text) = (plan.content().unwrap().to_string(), code.content().unwrap().to_string());
        let state = compact(
            0,
            vec![
                plan,
                ChatMessage::user("Plan the redesign."),
                ChatMessage::assistant("<proposed_plan>…</proposed_plan>"),
                code,
                ChatMessage::user("Approve, proceed."),
                ChatMessage::assistant("Implementing step 1."),
            ],
        )
        .await;

        assert!(visible(&state, &code_text));
        assert!(find(&state, &code_text).1.meta().pinned);
        assert!(!visible(&state, &plan_text));
        let (_, plan) = find(&state, &plan_text);
        assert!(plan.meta().exclude_from_context);
        assert!(!plan.meta().pinned);
    }

    /// Retention must not move the summary below a note it never covered.
    #[tokio::test]
    async fn mode_note_inside_the_kept_window_is_left_in_place() {
        let note = mode_note("plan");
        let note_text = note.content().unwrap().to_string();
        let state = compact(
            2,
            vec![
                ChatMessage::user("first"),
                ChatMessage::assistant("first reply"),
                ChatMessage::user("second"),
                ChatMessage::assistant("second reply"),
                note,
                ChatMessage::user("third"),
                ChatMessage::assistant("third reply"),
            ],
        )
        .await;

        let summary = summary_index(&state);
        let (kept_reply, _) = find(&state, "second reply");
        let (note_idx, _) = find(&state, &note_text);
        assert!(summary < kept_reply && kept_reply < note_idx, "summary {summary}, kept reply {kept_reply}, note {note_idx}");
        assert!(visible(&state, &note_text));
    }

    const PLAN: &str = "## Steps\n1. Build\n2. Test";

    fn save_plan(dir: &std::path::Path, body: &str) {
        plan::save_agent(dir, plan::PlanTarget::DataDir, plan::PlanChange::Write(body)).unwrap();
    }

    /// A pinned `<session_plan>` note as an earlier compaction left it.
    fn plan_note() -> ChatMessage {
        let mut m = ChatMessage::user(format!("<session_plan path=\"plan.md\">\n{PLAN}\n</session_plan>"));
        let meta = m.meta_mut();
        meta.kind = "note".into();
        meta.pinned = true;
        let mut extra = Map::new();
        extra.insert("hidden_from_user".into(), json!(true));
        extra.insert(plan::SESSION_PLAN_KEY.into(), json!(true));
        meta.extra = Some(extra);
        m
    }

    fn plan_notes(state: &AgentState) -> Vec<(usize, &ChatMessage)> {
        state.messages.iter().enumerate().filter(|(_, m)| extra_truthy(m, plan::SESSION_PLAN_KEY)).collect()
    }

    fn summariser_request(provider: &MockProvider, call: usize) -> Vec<ChatMessage> {
        provider.calls.lock().unwrap()[call].0.clone()
    }

    /// Coding workspaces keep no assistant message verbatim, so without the
    /// note the approved plan only survived as summary bullets and the agent
    /// drifted off it after compaction.
    #[tokio::test]
    async fn compaction_restates_the_saved_plan_before_the_summary() {
        let dir = tempfile::tempdir().unwrap();
        save_plan(dir.path(), PLAN);
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        let hook = hook_with(provider.clone(), 0).with_plan_dir(dir.path().to_path_buf());
        let state =
            compact_with(&hook, vec![mode_note("code"), ChatMessage::user("Plan it."), ChatMessage::assistant("Plan submitted."), ChatMessage::assistant("Implementing step 1.")])
                .await;

        let notes = plan_notes(&state);
        assert_eq!(notes.len(), 1);
        let (idx, note) = notes[0];
        assert!(note.meta().pinned && !note.meta().exclude_from_context);
        assert_eq!(note.meta().kind, "note");
        assert_eq!(idx + 1, summary_index(&state), "the summary is read after the plan");
        assert!(note.content().unwrap().contains(&format!("\n{PLAN}\n</session_plan>")));

        let request = summariser_request(&provider, 0);
        assert!(request.last().unwrap().content().unwrap().ends_with(plan::PLAN_SUMMARY_RULE));
    }

    #[tokio::test]
    async fn a_later_compaction_replaces_the_plan_note() {
        let dir = tempfile::tempdir().unwrap();
        save_plan(dir.path(), PLAN);
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary one."), MockProvider::text("Summary two.")]));
        let hook = hook_with(provider.clone(), 0).with_plan_dir(dir.path().to_path_buf());
        let mut state = compact_with(&hook, vec![ChatMessage::user("Plan it."), ChatMessage::assistant("Plan written.")]).await;
        save_plan(dir.path(), "## Steps\n1. Build\n2. Test\n3. Ship");
        state.messages.push(ChatMessage::user("Add a ship step."));
        state.messages.push(ChatMessage::assistant("Added."));
        assert!(hook.summarise(&ctx(), &mut state, "sys").await);

        let notes = plan_notes(&state);
        assert_eq!(notes.len(), 2);
        let (old, new) = (notes[0].1, notes[1].1);
        assert!(old.meta().exclude_from_context && !old.meta().pinned);
        assert!(new.meta().pinned && !new.meta().exclude_from_context);
        assert!(new.content().unwrap().contains("3. Ship"));
        let request = summariser_request(&provider, 1);
        assert!(!request.iter().any(|m| m.content().is_some_and(|c| c.contains("<session_plan path="))), "old note reached the summariser");
    }

    #[tokio::test]
    async fn no_plan_file_adds_no_note_or_rule() {
        let dir = tempfile::tempdir().unwrap();
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        let hook = hook_with(provider.clone(), 0).with_plan_dir(dir.path().to_path_buf());
        let state = compact_with(&hook, vec![ChatMessage::user("Hi."), ChatMessage::assistant("Hello.")]).await;
        assert!(plan_notes(&state).is_empty());
        assert!(!summariser_request(&provider, 0).last().unwrap().content().unwrap().contains(plan::PLAN_SUMMARY_RULE));
    }

    #[tokio::test]
    async fn plan_note_still_in_the_kept_window_is_not_duplicated() {
        let dir = tempfile::tempdir().unwrap();
        save_plan(dir.path(), PLAN);
        let hook = hook(2).with_plan_dir(dir.path().to_path_buf());
        let state = compact_with(
            &hook,
            vec![
                ChatMessage::user("first"),
                ChatMessage::assistant("first reply"),
                ChatMessage::user("second"),
                ChatMessage::assistant("second reply"),
                plan_note(),
                ChatMessage::user("third"),
                ChatMessage::assistant("third reply"),
            ],
        )
        .await;
        let notes = plan_notes(&state);
        assert_eq!(notes.len(), 1, "the kept note is not restated again");
        assert!(!notes[0].1.meta().exclude_from_context);
    }

    /// A mid-turn compaction leaves the agent resuming from the summary
    /// alone. A bare `## Goal…` user message reads like a new request, so
    /// the model sees it framed as a handoff; the stored row (and the UI)
    /// keep the plain summary.
    #[tokio::test]
    async fn the_model_sees_the_summary_framed_as_a_handoff() {
        let state = compact(0, vec![ChatMessage::user("Fix the login bug."), ChatMessage::assistant("Reading auth.rs.")]).await;
        let stored = &state.messages[summary_index(&state)];
        assert_eq!(stored.content(), Some("Summary."), "the stored summary must stay unwrapped");

        let sent = state.messages_for_llm();
        let summary = sent.iter().find(|m| m.meta().is_summary()).expect("summary sent");
        let text = summary.content().unwrap();
        assert!(text.starts_with("<conversation_summary>\nSummary.\n</conversation_summary>\n"), "{text}");
        assert!(text.contains("not a new message from the user"), "{text}");
    }

    /// The summariser shares the main turn's prompt-cache prefix, so a prior
    /// summary must reach it exactly as the main model saw it.
    #[tokio::test]
    async fn the_summariser_sees_a_prior_summary_as_the_main_model_did() {
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary one."), MockProvider::text("Summary two.")]));
        let hook = hook_with(provider.clone(), 0);
        let mut state = compact_with(&hook, vec![ChatMessage::user("Fix the login bug."), ChatMessage::assistant("Reading auth.rs.")]).await;
        let main_view = state.messages_for_llm().into_iter().find(|m| m.meta().is_summary()).unwrap();
        state.messages.push(ChatMessage::user("Also fix logout."));
        state.messages.push(ChatMessage::assistant("On it."));
        assert!(hook.summarise(&ctx(), &mut state, "sys").await);

        let request = summariser_request(&provider, 1);
        let prior = request.iter().find(|m| m.content().is_some_and(|c| c.contains("Summary one."))).expect("prior summary in request");
        // Consecutive user turns are merged, so the next request follows it.
        assert!(prior.content().unwrap().starts_with(main_view.content().unwrap()), "{:?}", prior.content());
    }

    /// The handoff needs the verbatim latest request (coding keeps no message
    /// verbatim) and the user's open task list, which otherwise shrinks to a
    /// one-line paraphrase and has to be pasted in again.
    #[test]
    fn coding_summary_template_keeps_sections_in_order() {
        let prompt = prompts::s("summary_coding");
        let headings = [
            "## Goal",
            "## Latest User Request",
            "## Constraints & Preferences",
            "## Progress",
            "### Done",
            "### In Progress",
            "### Blocked",
            "## Key Decisions",
            "## Next Steps",
            "## Open Work From the User",
            "## Critical Context",
            "## Relevant Files",
        ];
        let mut at = 0;
        for h in headings {
            let i = prompt[at..].find(&format!("\n{h}\n")).unwrap_or_else(|| panic!("{h} missing or out of order"));
            at += i + 1;
        }
        assert!(prompt.contains("Start your response with exactly `## Goal`."));
    }

    #[test]
    fn plan_rule_keeps_plan_steps_out_of_open_work() {
        assert!(plan::PLAN_SUMMARY_RULE.contains("Open Work From the User"));
    }

    /// The summariser's final instruction: the only message the hint may change.
    fn summary_instruction(provider: &MockProvider, call: usize) -> String {
        summariser_request(provider, call).last().unwrap().content().unwrap().to_string()
    }

    /// After a plan approval the newest user-role message is the Code-mode
    /// note, and summaries quoted it (or the approval) as the user's latest
    /// request; a retitle then named the session after it.
    #[tokio::test]
    async fn the_summariser_is_told_which_message_the_user_wrote() {
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        let hook = hook_with(provider.clone(), 0);
        compact_with(
            &hook,
            vec![ChatMessage::user("Plan the login fix."), ChatMessage::assistant("Plan submitted."), mode_note("code"), ChatMessage::assistant("Implementing step 1.")],
        )
        .await;

        let instruction = summary_instruction(&provider, 0);
        assert!(instruction.contains("<latest_user_message>\nPlan the login fix.\n</latest_user_message>"), "{instruction}");
        assert!(instruction.contains("`<interaction_mode>`"), "the runtime notes are named: {instruction}");
        // The hint rides on the final instruction only, so the conversation
        // before it still matches the main turn's prompt-cache prefix.
        let request = summariser_request(&provider, 0);
        assert!(!request[..request.len() - 1].iter().any(|m| m.content().is_some_and(|c| c.contains("latest_user_message"))));
    }

    #[tokio::test]
    async fn a_goal_reminder_is_not_the_latest_request() {
        let mut reminder = ChatMessage::user("<goal_reminder turn=\"2\">\nKeep working.\n</goal_reminder>");
        let mut extra = Map::new();
        extra.insert("goal_turn".into(), json!({"turn": 2}));
        reminder.meta_mut().extra = Some(extra);
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        compact_with(
            &hook_with(provider.clone(), 0),
            vec![ChatMessage::user("Make the tests pass."), ChatMessage::assistant("Ran tests."), reminder, ChatMessage::assistant("Fixed one.")],
        )
        .await;

        let instruction = summary_instruction(&provider, 0);
        assert!(instruction.contains("<latest_user_message>\nMake the tests pass.\n</latest_user_message>"), "{instruction}");
    }

    /// With no new message since the earlier note, the newest user-role
    /// message is a runtime note; the request the note recorded stands.
    #[tokio::test]
    async fn no_new_prompt_since_the_prior_summary_keeps_its_request() {
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary one."), MockProvider::text("Summary two.")]));
        let hook = hook_with(provider.clone(), 0);
        let mut state = compact_with(&hook, vec![ChatMessage::user("Fix the login bug."), ChatMessage::assistant("Reading auth.rs.")]).await;
        state.messages.push(mode_note("code"));
        state.messages.push(ChatMessage::assistant("Editing auth.rs."));
        assert!(hook.summarise(&ctx(), &mut state, "sys").await);

        let instruction = summary_instruction(&provider, 1);
        assert!(!instruction.contains("<latest_user_message>"), "{instruction}");
        assert!(instruction.contains(NO_NEW_PROMPT_RULE), "{instruction}");
    }

    /// A message from another workspace's agent is the request of a session
    /// it started; its model-only routing header is not part of it.
    #[tokio::test]
    async fn a_workspace_request_is_quoted_without_its_routing_header() {
        let mut sent = ChatMessage::user("Update the site for v3.30.");
        let mut extra = Map::new();
        extra.insert("sent_from".into(), json!({"session_id": "s1", "workspace": "/r/app", "workspace_name": "app", "reply": true}));
        sent.meta_mut().extra = Some(extra);
        let sent = crate::history::apply_llm_content_overrides(vec![sent]).remove(0);
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        compact_with(&hook_with(provider.clone(), 0), vec![sent, ChatMessage::assistant("Updating.")]).await;

        let instruction = summary_instruction(&provider, 0);
        assert!(instruction.contains("<latest_user_message>\nUpdate the site for v3.30.\n</latest_user_message>"), "{instruction}");
    }

    /// An assistant reply carrying the usage its model call reported.
    fn reply_with_usage(content: &str, prompt_tokens: i64) -> ChatMessage {
        let mut m = ChatMessage::assistant(content);
        let mut extra = Map::new();
        extra.insert("usage".into(), json!({"input": prompt_tokens, "output": 100}));
        m.meta_mut().extra = Some(extra);
        m
    }

    fn sent_max_tokens(provider: &MockProvider, call: usize) -> Option<i64> {
        provider.calls.lock().unwrap()[call].2.get("max_tokens").and_then(|v| v.as_i64())
    }

    /// Issue #425: a 262k-context model compacting a 246k-token history was
    /// asked for a summary larger than the 15.4k tokens left in its context.
    #[tokio::test]
    async fn summary_budget_shrinks_to_the_room_left_in_the_context() {
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        let mut hook = hook_with(provider.clone(), 0);
        hook.max_token_length = DEFAULT_MAX_TOKEN_LENGTH;
        hook.context_window = Some(262_144);
        let history = "x".repeat(700_000);
        compact_with(&hook, vec![ChatMessage::user(history), reply_with_usage("Done.", 246_735)]).await;

        let sent = sent_max_tokens(&provider, 0).expect("max_tokens sent");
        assert!(sent <= 262_144 - 246_735, "max_tokens {sent} does not fit the context");
        assert!(sent >= MIN_SUMMARY_TOKENS, "max_tokens {sent} leaves no room for a summary");
    }

    #[tokio::test]
    async fn summary_budget_keeps_the_cap_when_the_context_has_room() {
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        let mut hook = hook_with(provider.clone(), 0);
        hook.max_token_length = DEFAULT_MAX_TOKEN_LENGTH;
        hook.context_window = Some(262_144);
        compact_with(&hook, vec![ChatMessage::user("x".repeat(40_000)), reply_with_usage("Done.", 12_000)]).await;
        assert_eq!(sent_max_tokens(&provider, 0), Some(DEFAULT_MAX_TOKEN_LENGTH));
    }

    /// The reporter's model is not in the registry: a fixed cap could not be
    /// checked against the room left, so the provider picks the budget.
    #[tokio::test]
    async fn unknown_context_window_sends_no_max_tokens() {
        let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
        let mut hook = hook_with(provider.clone(), 0);
        hook.max_token_length = DEFAULT_MAX_TOKEN_LENGTH;
        compact_with(&hook, vec![ChatMessage::user("Hi."), reply_with_usage("Hello.", 246_735)]).await;
        assert_eq!(sent_max_tokens(&provider, 0), None);
    }

    /// The retitle callback gets the session and its summary only when a
    /// summary was written, with the newest message the user wrote.
    #[tokio::test]
    async fn on_summary_runs_only_after_a_successful_summary() {
        type Seen = Arc<Mutex<Vec<(String, String, Option<String>)>>>;
        let seen: Seen = Arc::default();
        let record = |seen: &Seen| -> OnSummary {
            let seen = seen.clone();
            Arc::new(move |sid: &str, text: &str, prompt: Option<&str>| seen.lock().unwrap().push((sid.into(), text.into(), prompt.map(String::from))))
        };
        let ctx = RunContext { session_id: Some("s-retitle".into()), ..ctx() };
        let history = || vec![ChatMessage::user("Fix the login page."), ChatMessage::assistant("Done."), mode_note("code")];

        let hook = hook_with(Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")])), 0).with_on_summary(record(&seen));
        let mut state = AgentState::new(history(), String::new());
        assert!(hook.summarise(&ctx, &mut state, "sys").await);
        assert_eq!(*seen.lock().unwrap(), vec![("s-retitle".to_string(), "Summary.".to_string(), Some("Fix the login page.".to_string()))]);

        // An empty summary writes nothing and calls nothing.
        let hook = hook_with(Arc::new(MockProvider::new(vec![MockProvider::text("")])), 0).with_on_summary(record(&seen));
        let mut state = AgentState::new(history(), String::new());
        assert!(!hook.summarise(&ctx, &mut state, "sys").await);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}
