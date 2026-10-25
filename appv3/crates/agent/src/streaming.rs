//! One LLM call with retry + assembly — port of `agent_loop/streaming.py`
//! and the `stream_with_retry` loop of `agent_loop/retry.py`.

use crate::errors::AgentError;
use crate::events::ProviderStatus;
use crate::hooks::{AgentState, HookRef, RunContext};
use crate::retry::*;
use crate::util::Event;
use appv3_providers::{
    usage::usage_to_dict, AssistantMessage, ChatCompletionChunk, ChatMessage, ChunkStream, EncryptedReasoningItem, FunctionCall, Kwargs, LlmProvider, ProviderError, ToolCall,
    ToolSpec, Usage,
};
use futures::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
// Tokio's clock (the same as std's outside paused-time tests).
use tokio::time::Instant;

pub enum RetryItem {
    Chunk(ChatCompletionChunk),
    /// A retry restarted the stream after chunks were emitted.
    Restart,
}

#[derive(Debug, Clone)]
pub enum ModelError {
    Agent(AgentError),
    /// Transient transport failure that exhausted the retry budget.
    Transient {
        error_type: String,
        message: String,
    },
}

impl From<AgentError> for ModelError {
    fn from(e: AgentError) -> Self {
        ModelError::Agent(e)
    }
}

/// Output spread over less than this came in one burst, with no
/// measurable rate.
const MIN_GENERATION: Duration = Duration::from_millis(100);

/// When one streamed model call produced its output, for the `chat` span's
/// time to first chunk and output speed.
#[derive(Debug, Clone, Copy, Default)]
pub struct StreamTiming {
    /// From issuing the request (the attempt whose output was kept) to the
    /// first chunk carrying output: text, reasoning, or a tool-call delta.
    pub ttft: Option<Duration>,
    /// From the first to the last chunk carrying output.
    pub generation: Option<Duration>,
}

impl StreamTiming {
    /// Output tokens (as the provider counts them) per second of streaming
    /// output; `None` without tokens or a measurable window.
    pub fn output_tokens_per_second(&self, output_tokens: i64) -> Option<f64> {
        let window = self.generation.filter(|g| *g >= MIN_GENERATION)?;
        (output_tokens > 0).then(|| output_tokens as f64 / window.as_secs_f64())
    }
}

/// `ChunkStream` is `Send` but not `Sync`; it is only ever touched through
/// `&mut`, so sharing `&RetryStream` across awaits is sound.
struct SyncStream(ChunkStream);
// SAFETY: the inner stream is only accessed via `&mut SyncStream`.
unsafe impl Sync for SyncStream {}

/// Pull-based `stream_with_retry`.
pub struct RetryStream<'a> {
    provider: Arc<dyn LlmProvider>,
    label: String,
    messages: &'a [ChatMessage],
    tools: Option<&'a [ToolSpec]>,
    kwargs: Kwargs,
    hooks: Option<(&'a [HookRef], &'a RunContext)>,
    interrupt: Option<Event>,
    current: Option<SyncStream>,
    /// When the current attempt's request was issued.
    attempt_started: Instant,
    attempt: i64,
    /// Transport failures so far; budgeted apart from HTTP errors.
    network_attempt: i64,
    /// Most attempts through transport failures; `None` retries until the
    /// network is back (or the caller stops the stream).
    network_budget: Option<i64>,
    quota_waits: i64,
    /// Credential switches so far (multi-credential providers).
    switches: i64,
    emitted: bool,
    done: bool,
}

enum Next {
    Continue,
    Stop,
}

impl<'a> RetryStream<'a> {
    pub fn new(
        provider: Arc<dyn LlmProvider>,
        label: impl Into<String>,
        messages: &'a [ChatMessage],
        tools: Option<&'a [ToolSpec]>,
        kwargs: Kwargs,
        hooks: Option<(&'a [HookRef], &'a RunContext)>,
        interrupt: Option<Event>,
    ) -> Self {
        Self {
            provider,
            label: label.into(),
            messages,
            tools,
            kwargs,
            hooks,
            interrupt,
            current: None,
            attempt_started: Instant::now(),
            attempt: 0,
            network_attempt: 0,
            network_budget: Some(MAX_NETWORK_ATTEMPTS),
            quota_waits: 0,
            switches: 0,
            emitted: false,
            done: false,
        }
    }

    /// Retry transport failures without limit. Only for streams the user can
    /// stop: the turn's own model call, which races its interrupt and
    /// hard-cancel. A background call (summarization) keeps the budget.
    pub fn retry_network_indefinitely(mut self) -> Self {
        self.network_budget = None;
        self
    }

    fn interrupted(&self) -> bool {
        self.interrupt.as_ref().map(|e| e.is_set()).unwrap_or(false)
    }

    /// When the request behind the chunks now streaming was issued.
    pub fn attempt_started(&self) -> Instant {
        self.attempt_started
    }

    /// Sleep; `true` when the interrupt fired first.
    async fn sleep(&self, secs: f64) -> bool {
        let d = Duration::from_secs_f64(secs.max(0.0));
        match &self.interrupt {
            None => {
                tokio::time::sleep(d).await;
                false
            }
            Some(ev) => {
                if ev.is_set() {
                    return true;
                }
                ev.wait_timeout(d).await
            }
        }
    }

    async fn notify_retry(&self, info: ProviderStatus) {
        if let Some((hooks, ctx)) = self.hooks {
            for h in hooks {
                h.on_provider_retry(ctx, &info).await;
            }
        }
    }

    async fn notify_exhausted(&self, error_type: &str, status_code: Option<i64>, max_attempts: i64) {
        if let Some((hooks, ctx)) = self.hooks {
            let info = ProviderStatus {
                status: "exhausted".into(),
                model: Some(self.label.clone()),
                max_attempts: Some(max_attempts),
                error_type: Some(error_type.into()),
                status_code,
                ..Default::default()
            };
            for h in hooks {
                h.on_provider_exhausted(ctx, &info).await;
            }
        }
    }

    /// A quota, rate-limit or auth failure on a provider with several
    /// credentials: move to the next ready one and retry at once (the same
    /// model; nothing was emitted by the failed request). `true` when it
    /// switched.
    async fn try_switch_credential(&mut self, err: &ProviderError) -> bool {
        if self.switches >= MAX_CREDENTIAL_SWITCHES {
            return false;
        }
        let Some((reason, cooldown)) = credential_cooldown(err) else { return false };
        let pid = self.provider.provider_name().unwrap_or("").to_string();
        let from = appv3_providers::pool::credential_label(&pid, err);
        let Some(to) = self.provider.rotate_credential(err, reason, cooldown) else { return false };
        self.switches += 1;
        let status = err.status().unwrap_or(0);
        let from = from.unwrap_or_else(|| "The credential in use".into());
        let msg = format!("{from} {}. Continuing on {to} with the same model.", switch_reason_text(reason, cooldown));
        tracing::warn!("llm_provider_credential_switched model={} status={} reason={} switch={}", self.label, status, reason, self.switches);
        self.notify_retry(ProviderStatus {
            status: "switched_credential".into(),
            model: Some(self.label.clone()),
            error_type: Some("HTTPStatusError".into()),
            status_code: Some(status as i64),
            message: Some(msg),
            ..Default::default()
        })
        .await;
        true
    }

    /// Handle one failed attempt. `Ok(Continue)` retries, `Ok(Stop)` ends the
    /// stream (interrupted), `Err` raises.
    async fn on_error(&mut self, err: ProviderError) -> Result<Next, ModelError> {
        self.current = None;
        if self.try_switch_credential(&err).await {
            return Ok(Next::Continue);
        }
        match &err {
            ProviderError::Http { status, body, .. } => {
                let status = *status;
                if !is_retryable_http(status, body) {
                    tracing::warn!("llm_provider_error model={} status={} body={}", self.label, status, crate::util::head_chars(body, 500));
                    return Err(classify_http(status, body, &self.label).into());
                }
                let retry_after;
                if status == 429 {
                    if is_spend_limit_429(status, body) {
                        tracing::warn!("llm_provider_spend_limit model={} body={}", self.label, crate::util::head_chars(body, 300));
                        return Err(AgentError::RateLimit(format!(
                            "{} reached the account's spend limit. Raise the limit in the provider's console, or switch to another model.",
                            self.label
                        ))
                        .into());
                    }
                    let mut reset = parse_retry_after(&err);
                    // Every credential is cooling down: wait for the first
                    // one to recover, not necessarily the one that failed.
                    if let Some(next) = self.provider.credential_recovery_secs() {
                        let next = next.ceil().max(1.0) as i64;
                        reset = if reset > 0 { reset.min(next) } else { next };
                    }
                    if reset as f64 > MAX_DELAY {
                        if reset > MAX_QUOTA_WAIT_SECONDS {
                            return Err(AgentError::RateLimit(format!(
                                "The configured LLM provider quota is exhausted. Reset in {}, which exceeds the maximum auto-wait of {}.",
                                format_duration(reset as f64),
                                format_duration(MAX_QUOTA_WAIT_SECONDS as f64)
                            ))
                            .into());
                        }
                        if self.quota_waits >= MAX_QUOTA_WAITS {
                            return Err(self.final_error(&err));
                        }
                        self.quota_waits += 1;
                        let wait = reset as f64 + CLOCK_SKEW_BUFFER_SECONDS;
                        tracing::warn!("llm_provider_quota_wait model={} status={} wait={:.0}s quota_wait={}/{}", self.label, status, wait, self.quota_waits, MAX_QUOTA_WAITS);
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
                        let msg = format!(
                            "Provider quota exhausted for {}. Waiting {} for reset. Agent will automatically resume work. You can stop at any time.",
                            self.label,
                            format_duration(wait)
                        );
                        self.notify_retry(ProviderStatus {
                            status: "waiting_quota".into(),
                            model: Some(self.label.clone()),
                            attempt: Some(self.attempt + 1),
                            max_attempts: Some(MAX_RETRIES),
                            delay_seconds: Some(wait),
                            error_type: Some("HTTPStatusError".into()),
                            status_code: Some(status as i64),
                            retry_after: Some(reset),
                            message: Some(msg),
                            resets_at: Some((now + reset as f64) as i64),
                        })
                        .await;
                        if self.sleep(wait).await {
                            return Ok(Next::Stop);
                        }
                        return Ok(Next::Continue);
                    }
                    if is_non_retryable_429(status, body) && reset == 0 {
                        return Err(self.final_error(&err));
                    }
                    retry_after = reset;
                    if let Some((hooks, ctx)) = self.hooks {
                        for h in hooks {
                            h.on_rate_limit(ctx, retry_after, self.attempt + 1, MAX_RETRIES).await;
                        }
                    }
                } else {
                    retry_after = parse_retry_after(&err);
                }
                if self.attempt + 1 >= MAX_RETRIES {
                    tracing::warn!("llm_provider_exhausted model={} status={} attempts={}", self.label, status, MAX_RETRIES);
                    self.notify_exhausted("HTTPStatusError", Some(status as i64), MAX_RETRIES).await;
                    return Err(self.final_error(&err));
                }
                let required = required_delay(self.attempt, retry_after);
                let delay = backoff_delay(self.attempt, retry_after);
                if status == 429 && required >= MAX_DELAY {
                    return Err(self.final_error(&err));
                }
                tracing::warn!("llm_provider_retry model={} status={} attempt={}/{} delay={:.1}s", self.label, status, self.attempt + 1, MAX_RETRIES, delay);
                self.notify_retry(ProviderStatus {
                    status: "retrying".into(),
                    model: Some(self.label.clone()),
                    attempt: Some(self.attempt + 1),
                    max_attempts: Some(MAX_RETRIES),
                    delay_seconds: Some(delay),
                    error_type: Some("HTTPStatusError".into()),
                    status_code: Some(status as i64),
                    retry_after: Some(retry_after),
                    ..Default::default()
                })
                .await;
                if self.sleep(delay).await {
                    return Ok(Next::Stop);
                }
                self.attempt += 1;
                Ok(Next::Continue)
            }
            ProviderError::Network(msg) => {
                let et = network_error_type(msg).to_string();
                if let Some(budget) = self.network_budget.filter(|b| self.network_attempt + 1 >= *b) {
                    tracing::warn!("llm_provider_exhausted model={} error={} attempts={}", self.label, et, budget);
                    self.notify_exhausted(&et, None, budget).await;
                    return Err(ModelError::Transient { error_type: et, message: msg.clone() });
                }
                let delay = network_retry_delay();
                let budget = self.network_budget.map(|b| b.to_string()).unwrap_or_else(|| "unlimited".into());
                tracing::warn!("llm_provider_retry model={} error={} attempt={}/{} delay={:.1}s", self.label, et, self.network_attempt + 1, budget, delay);
                self.notify_retry(ProviderStatus {
                    status: "retrying".into(),
                    model: Some(self.label.clone()),
                    attempt: Some(self.network_attempt + 1),
                    max_attempts: self.network_budget,
                    delay_seconds: Some(delay),
                    error_type: Some(et),
                    ..Default::default()
                })
                .await;
                if self.sleep(delay).await {
                    return Ok(Next::Stop);
                }
                self.network_attempt += 1;
                Ok(Next::Continue)
            }
            ProviderError::Unconfigured(m) => Err(AgentError::Unconfigured(m.clone()).into()),
            ProviderError::Auth(m) => Err(AgentError::Auth { message: m.clone(), status: None, provider: None }.into()),
            other => Err(AgentError::Other(other.to_string()).into()),
        }
    }

    /// Error raised after the retry loop gives up on an HTTP error.
    fn final_error(&self, err: &ProviderError) -> ModelError {
        if err.status() == Some(429) {
            return AgentError::RateLimit("The configured LLM provider is rate-limited or quota-exhausted.".into()).into();
        }
        AgentError::Other(err.to_string()).into()
    }

    pub async fn next(&mut self) -> Result<Option<RetryItem>, ModelError> {
        loop {
            if self.done {
                return Ok(None);
            }
            if self.current.is_none() {
                if self.attempt >= MAX_RETRIES || self.interrupted() {
                    self.done = true;
                    return Ok(None);
                }
                if self.emitted {
                    self.emitted = false;
                    return Ok(Some(RetryItem::Restart));
                }
                self.attempt_started = Instant::now();
                match self.provider.stream(self.messages, self.tools, &self.kwargs).await {
                    Ok(s) => self.current = Some(SyncStream(s)),
                    Err(e) => match self.on_error(e).await {
                        Ok(Next::Continue) => continue,
                        Ok(Next::Stop) => {
                            self.done = true;
                            return Ok(None);
                        }
                        Err(e) => {
                            self.done = true;
                            return Err(e);
                        }
                    },
                }
            }
            let item = self.current.as_mut().unwrap().0.next().await;
            match item {
                Some(Ok(chunk)) => {
                    self.emitted = true;
                    return Ok(Some(RetryItem::Chunk(chunk)));
                }
                None => {
                    self.done = true;
                    self.current = None;
                    return Ok(None);
                }
                Some(Err(e)) => match self.on_error(e).await {
                    Ok(Next::Continue) => continue,
                    Ok(Next::Stop) => {
                        self.done = true;
                        return Ok(None);
                    }
                    Err(e) => {
                        self.done = true;
                        return Err(e);
                    }
                },
            }
        }
    }
}

/// `_merge_consecutive_user_messages`.
pub fn merge_consecutive_user_messages(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut merged: Vec<ChatMessage> = Vec::with_capacity(messages.len());
    for m in messages {
        let can = matches!(&m, ChatMessage::User { parts: None, .. }) && matches!(merged.last(), Some(ChatMessage::User { parts: None, .. }));
        if can {
            let prev = merged.pop().unwrap();
            let (pc, pmeta) = match prev {
                ChatMessage::User { content, meta, .. } => (content, meta),
                _ => unreachable!(),
            };
            let mc = m.content().unwrap_or("").to_string();
            let content = format!("{}\n\n{}", pc.unwrap_or_default(), mc).trim().to_string();
            let meta = appv3_providers::MessageMeta { extra: pmeta.extra, ..Default::default() };
            merged.push(ChatMessage::User { content: Some(content), parts: None, meta });
        } else {
            merged.push(m);
        }
    }
    merged
}

#[derive(Default)]
struct TcBuf {
    id: String,
    name: String,
    arguments: String,
    thought: Option<Value>,
    thought_signature: Option<String>,
}

pub struct StreamArgs<'a> {
    pub ctx: &'a RunContext,
    pub state: &'a AgentState,
    pub hooks: &'a [HookRef],
    pub interrupt: Option<&'a Event>,
    pub hard_cancel: Option<&'a Event>,
    pub system_prompt: &'a str,
    /// The request window, owned: the wire list is built around it without
    /// another copy of the history.
    pub messages: Vec<ChatMessage>,
    pub tool_defs: &'a [Value],
    pub provider: Arc<dyn LlmProvider>,
    pub label: &'a str,
    pub agent_name: &'a str,
    pub agent_id: &'a str,
}

async fn wait_opt(e: Option<&Event>) {
    match e {
        Some(e) => e.wait().await,
        None => futures::future::pending::<()>().await,
    }
}

/// Cap outgoing images at `images::MAX_IMAGE_EDGE` for every provider (old
/// history included). The turn and the summarizer both send through this, so
/// their requests stay byte-identical and share the prompt cache.
pub async fn fit_request_images(messages: Vec<ChatMessage>, label: &str) -> Vec<ChatMessage> {
    let t = Instant::now();
    let (messages, resized) = appv3_providers::images::fit_request(messages).await;
    if resized > 0 {
        tracing::info!("llm_request_images_resized model={label} count={resized} ms={}", t.elapsed().as_millis());
    }
    messages
}

/// `stream_and_assemble`.
/// Providers that route or cache by conversation and need the session id
/// as the `session_id` kwarg (Codex `session-id`, Grok Build `x-grok-conv-id`).
pub fn routes_by_session(provider_name: Option<&str>) -> bool {
    matches!(provider_name, Some("codex" | "grok"))
}

pub async fn stream_and_assemble(a: StreamArgs<'_>) -> Result<(AssistantMessage, Option<Usage>, StreamTiming), ModelError> {
    let mut full = String::new();
    let mut reasoning = String::new();
    let mut signature = String::new();
    let mut redacted: Vec<Value> = Vec::new();
    let mut raw_blocks: Option<Vec<Value>> = None;
    let mut items: Vec<EncryptedReasoningItem> = Vec::new();
    let mut buf: BTreeMap<i64, TcBuf> = BTreeMap::new();
    let mut last_usage: Option<Usage> = None;
    let mut finish: Option<String> = None;
    let mut stop_details: Option<Value> = None;
    // (request issued, first output chunk) and the last output chunk.
    let mut first_output: Option<(Instant, Instant)> = None;
    let mut last_output: Option<Instant> = None;

    let mut wire = Vec::with_capacity(a.messages.len() + 1);
    wire.push(ChatMessage::system(a.system_prompt));
    wire.extend(a.messages);
    let wire = merge_consecutive_user_messages(wire);
    let wire = fit_request_images(wire, a.label).await;
    let effective_interrupt = if a.provider.support_interrupt() { a.interrupt.cloned() } else { None };
    let tools = if a.tool_defs.is_empty() { None } else { Some(a.tool_defs) };
    let mut kwargs = Kwargs::new();
    if routes_by_session(a.provider.provider_name()) {
        if let Some(sid) = &a.ctx.session_id {
            kwargs.insert("session_id".into(), json!(sid));
        }
    }
    // The loop below races the interrupt and hard-cancel, so Stop always
    // ends a call that is waiting for the network to come back.
    let mut rs = RetryStream::new(a.provider.clone(), a.label, &wire, tools, kwargs, Some((a.hooks, a.ctx)), effective_interrupt.clone()).retry_network_indefinitely();
    loop {
        if effective_interrupt.as_ref().map(|e| e.is_set()).unwrap_or(false) {
            break;
        }
        let item = tokio::select! {
            biased;
            _ = wait_opt(effective_interrupt.as_ref()) => break,
            _ = wait_opt(a.hard_cancel) => return Err(AgentError::Cancelled.into()),
            r = rs.next() => r?,
        };
        let Some(item) = item else { break };
        let chunk = match item {
            RetryItem::Restart => {
                tracing::warn!("agent_stream_restart_reset agent={} dropped_content_len={} dropped_tool_calls={}", a.agent_name, full.len(), buf.len());
                full.clear();
                reasoning.clear();
                signature.clear();
                redacted.clear();
                raw_blocks = None;
                items.clear();
                buf.clear();
                finish = None;
                stop_details = None;
                first_output = None;
                last_output = None;
                continue;
            }
            RetryItem::Chunk(c) => c,
        };
        let has_output = chunk.choices.first().is_some_and(|c| {
            let d = &c.delta;
            d.content.as_deref().is_some_and(|s| !s.is_empty())
                || d.reasoning_content.as_deref().is_some_and(|s| !s.is_empty())
                || d.tool_calls.as_ref().is_some_and(|t| !t.is_empty())
        });
        if has_output {
            let now = Instant::now();
            first_output.get_or_insert((rs.attempt_started(), now));
            last_output = Some(now);
        }
        for h in a.hooks {
            h.on_model_delta(a.ctx, a.state, &chunk).await;
        }
        if chunk.usage.is_some() {
            last_usage = chunk.usage.clone();
        }
        let Some(choice) = chunk.choices.into_iter().next() else {
            continue;
        };
        if let Some(f) = choice.finish_reason.filter(|f| !f.is_empty()) {
            finish = Some(f);
        }
        let d = choice.delta;
        if let Some(sd) = d.stop_details {
            stop_details = Some(sd);
        }
        if let Some(r) = d.reasoning_content {
            reasoning.push_str(&r);
        }
        if let Some(s) = d.reasoning_signature {
            signature.push_str(&s);
        }
        if let Some(b) = d.redacted_thinking_block {
            redacted.push(b);
        }
        if let Some(rb) = d.anthropic_raw_blocks {
            raw_blocks = Some(rb);
        }
        if let Some(it) = d.reasoning_item {
            items.push(it);
        }
        if let Some(c) = d.content {
            full.push_str(&c);
        }
        for tc in d.tool_calls.into_iter().flatten() {
            let idx = tc.index.unwrap_or(0);
            let f = tc.function.unwrap_or_default();
            match buf.get_mut(&idx) {
                None => {
                    buf.insert(
                        idx,
                        TcBuf {
                            id: tc.id.unwrap_or_default(),
                            name: f.name.unwrap_or_default(),
                            arguments: f.arguments.unwrap_or_default(),
                            thought: f.thought.filter(crate::util::truthy),
                            thought_signature: f.thought_signature.filter(|s| !s.is_empty()),
                        },
                    );
                }
                Some(b) => {
                    if let Some(id) = tc.id.filter(|s| !s.is_empty()) {
                        if b.id.is_empty() {
                            b.id = id;
                        } else if b.id != id {
                            tracing::warn!("tool_call_index_collision idx={} existing_id={} new_id={}", idx, b.id, id);
                        }
                    }
                    if let Some(n) = f.name.filter(|s| !s.is_empty()) {
                        if b.name.is_empty() {
                            b.name = n;
                        }
                    }
                    if let Some(arg) = f.arguments {
                        b.arguments.push_str(&arg);
                    }
                    if let Some(t) = f.thought.filter(crate::util::truthy) {
                        b.thought = Some(t);
                    }
                    if let Some(s) = f.thought_signature.filter(|s| !s.is_empty()) {
                        b.thought_signature = Some(b.thought_signature.take().unwrap_or_default() + &s);
                    }
                }
            }
        }
    }

    let mut tcs = Vec::new();
    let mut dropped: Vec<Value> = Vec::new();
    for (i, b) in buf {
        if b.name.is_empty() {
            tracing::warn!("drop_partial_tool_call_no_name agent={} idx={} finish_reason={:?}", a.agent_name, i, finish);
            dropped.push(json!({"index": i, "reason": "missing_name"}));
            continue;
        }
        if !b.arguments.is_empty() && serde_json::from_str::<Value>(&b.arguments).is_err() {
            tracing::warn!("drop_partial_tool_call_bad_json agent={} idx={} name={} chars={}", a.agent_name, i, b.name, b.arguments.len());
            dropped.push(json!({
                "index": i, "reason": "bad_json", "name": b.name,
                "arguments_prefix": crate::util::head_chars(&b.arguments, 200),
            }));
            continue;
        }
        tcs.push(ToolCall {
            id: b.id,
            kind: "function".into(),
            function: FunctionCall { name: b.name, arguments: b.arguments, thought: b.thought, thought_signature: b.thought_signature },
        });
    }
    let mut extra: Option<Map<String, Value>> = None;
    if let Some(u) = &last_usage {
        let model = a.state.meta_str("effective_model").unwrap_or_else(|| a.label.to_string());
        extra.get_or_insert_with(Map::new).insert("usage".into(), usage_to_dict(u, Some(&model)));
    }
    if let Some(f) = &finish {
        extra.get_or_insert_with(Map::new).insert("finish_reason".into(), json!(f));
    }
    if let Some(sd) = stop_details {
        extra.get_or_insert_with(Map::new).insert("stop_details".into(), sd);
    }
    if !dropped.is_empty() {
        extra.get_or_insert_with(Map::new).insert("dropped_tool_calls".into(), Value::Array(dropped));
    }
    if !signature.is_empty() {
        extra.get_or_insert_with(Map::new).insert("reasoning_signature".into(), json!(signature));
    }
    if !redacted.is_empty() {
        extra.get_or_insert_with(Map::new).insert("redacted_thinking_blocks".into(), Value::Array(redacted.clone()));
    }
    if let Some(rb) = raw_blocks.as_ref().filter(|r| !r.is_empty()) {
        extra.get_or_insert_with(Map::new).insert("raw_content_blocks".into(), Value::Array(rb.clone()));
    }
    if !items.is_empty() {
        extra.get_or_insert_with(Map::new).insert("reasoning_items".into(), Value::Array(items.iter().map(|i| serde_json::to_value(i).unwrap_or(Value::Null)).collect()));
    }
    let meta = appv3_providers::MessageMeta { extra, ..Default::default() };
    let msg = AssistantMessage {
        content: if full.is_empty() { None } else { Some(full) },
        reasoning_content: if reasoning.is_empty() { None } else { Some(reasoning) },
        reasoning_signature: if signature.is_empty() { None } else { Some(signature) },
        redacted_thinking_blocks: if redacted.is_empty() { None } else { Some(redacted) },
        raw_content_blocks: raw_blocks.filter(|r| !r.is_empty()),
        reasoning_items: if items.is_empty() { None } else { Some(items) },
        tool_calls: if tcs.is_empty() { None } else { Some(tcs) },
        agent_id: Some(a.agent_id.to_string()),
        agent_name: Some(a.agent_name.to_string()),
        meta,
    };
    let timing = match (first_output, last_output) {
        (Some((requested, first)), Some(last)) => StreamTiming { ttft: Some(first - requested), generation: Some(last - first) },
        _ => StreamTiming::default(),
    };
    Ok((msg, last_usage, timing))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::Hook;
    use appv3_providers::mock::{MockProvider, MockTurn};
    use appv3_providers::ChatCompletionDelta;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[test]
    fn session_routed_providers_get_the_session_id() {
        assert!(routes_by_session(Some("codex")));
        assert!(routes_by_session(Some("grok")));
        assert!(!routes_by_session(Some("openai")));
        assert!(!routes_by_session(None));
    }

    #[derive(Default)]
    struct StatusLog(Mutex<Vec<ProviderStatus>>);

    #[async_trait]
    impl Hook for StatusLog {
        async fn on_provider_retry(&self, _ctx: &RunContext, info: &ProviderStatus) {
            self.0.lock().unwrap().push(info.clone());
        }
        async fn on_provider_exhausted(&self, _ctx: &RunContext, info: &ProviderStatus) {
            self.0.lock().unwrap().push(info.clone());
        }
    }

    fn ctx() -> RunContext {
        RunContext { session_id: None, run_id: "run".into(), agent_name: "lead".into(), workspace: None }
    }

    fn dropped() -> MockTurn {
        MockTurn::Error(ProviderError::Network("SSE stream ended before terminal \"message_stop\" frame".into()))
    }

    /// A provider with two credentials: "a" is out of quota for an hour,
    /// "b" answers. It switches when asked to, or (`recovers_after`) by
    /// itself once enough time has passed.
    struct TwoKeys {
        on_b: Mutex<bool>,
        can_rotate: bool,
        recovers_after: Option<Duration>,
        started: Instant,
        ok: MockProvider,
        calls: Mutex<Vec<&'static str>>,
        kw: Kwargs,
    }

    impl TwoKeys {
        fn new(can_rotate: bool, recovers_after: Option<Duration>) -> Self {
            TwoKeys {
                on_b: Mutex::new(false),
                can_rotate,
                recovers_after,
                started: Instant::now(),
                ok: MockProvider::new(vec![MockProvider::text("from work")]),
                calls: Mutex::default(),
                kw: Kwargs::new(),
            }
        }
        fn serving_b(&self) -> bool {
            *self.on_b.lock().unwrap() || self.recovers_after.is_some_and(|d| self.started.elapsed() >= d)
        }
    }

    #[async_trait]
    impl LlmProvider for TwoKeys {
        fn model(&self) -> &str {
            "m"
        }
        fn provider_name(&self) -> Option<&str> {
            Some("pool-test")
        }
        fn base_kwargs(&self) -> &Kwargs {
            &self.kw
        }
        async fn chat(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> appv3_providers::ProviderResult<AssistantMessage> {
            unreachable!()
        }
        async fn stream(&self, m: &[ChatMessage], t: Option<&[ToolSpec]>, k: &Kwargs) -> appv3_providers::ProviderResult<ChunkStream> {
            if self.serving_b() {
                self.calls.lock().unwrap().push("b");
                return self.ok.stream(m, t, k).await;
            }
            self.calls.lock().unwrap().push("a");
            let body = r#"{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}"#;
            Err(ProviderError::http(
                429,
                "https://example.test/v1/chat",
                body.into(),
                vec![("retry-after".into(), "3600".into()), (appv3_providers::pool::CREDENTIAL_HEADER.into(), "a".into())],
            ))
        }
        fn rotate_credential(&self, err: &ProviderError, _reason: &str, _cooldown: f64) -> Option<String> {
            if !self.can_rotate || err.header(appv3_providers::pool::CREDENTIAL_HEADER) != Some("a") {
                return None;
            }
            *self.on_b.lock().unwrap() = true;
            Some("Work".into())
        }
        fn credential_recovery_secs(&self) -> Option<f64> {
            self.recovers_after.map(|d| d.saturating_sub(self.started.elapsed()).as_secs_f64())
        }
    }

    /// Quota on one credential moves the same call to the next credential
    /// at once, with a transcript note, instead of waiting out the reset.
    #[tokio::test(start_paused = true)]
    async fn a_quota_429_switches_to_the_next_credential_without_waiting() {
        let provider = Arc::new(TwoKeys::new(true, None));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider.clone(), "codex:gpt-5.4", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        let started = Instant::now();
        assert_eq!(drain(&mut rs).await.unwrap(), "from work");
        assert!(started.elapsed() < Duration::from_secs(1), "waited {:?}", started.elapsed());
        assert_eq!(*provider.calls.lock().unwrap(), ["a", "b"]);
        let statuses = log.0.lock().unwrap();
        assert_eq!(statuses.len(), 1, "{statuses:?}");
        assert_eq!(statuses[0].status, "switched_credential");
        let msg = statuses[0].message.as_deref().unwrap();
        assert!(msg.contains("usage limit") && msg.contains("Continuing on Work with the same model"), "{msg}");
    }

    /// With every credential cooling down, the wait is for the first one to
    /// recover (30 s), not the reset of the one that just failed (1 h).
    #[tokio::test(start_paused = true)]
    async fn with_every_credential_cooling_it_waits_for_the_first_to_recover() {
        let provider = Arc::new(TwoKeys::new(false, Some(Duration::from_secs(30))));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider.clone(), "codex:gpt-5.4", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        let started = Instant::now();
        assert_eq!(drain(&mut rs).await.unwrap(), "from work");
        let waited = started.elapsed().as_secs_f64();
        assert!((30.0..40.0).contains(&waited), "waited {waited}s");
        assert!(log.0.lock().unwrap().iter().all(|s| s.status != "waiting_quota"));
    }

    async fn drain(rs: &mut RetryStream<'_>) -> Result<String, ModelError> {
        let mut text = String::new();
        while let Some(item) = rs.next().await? {
            if let RetryItem::Chunk(c) = item {
                text.extend(c.choices.iter().filter_map(|ch| ch.delta.content.clone()));
            }
        }
        Ok(text)
    }

    /// A dropped connection is retried on a short, flat interval for as
    /// long as it takes, so the turn resumes within seconds of the network
    /// coming back instead of sitting out an exponential backoff or failing.
    #[tokio::test(start_paused = true)]
    async fn turn_stream_retries_dropped_connections_every_few_seconds_until_back() {
        let drops = 100;
        let mut turns: Vec<MockTurn> = (0..drops).map(|_| dropped()).collect();
        turns.push(MockProvider::text("back online"));
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(turns));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None).retry_network_indefinitely();

        let started = tokio::time::Instant::now();
        assert_eq!(drain(&mut rs).await.unwrap(), "back online");
        let waited = started.elapsed().as_secs_f64();
        assert!((drops as f64 * NETWORK_RETRY_MIN_DELAY..=drops as f64 * NETWORK_RETRY_MAX_DELAY).contains(&waited), "waited {waited}s");
        let statuses = log.0.lock().unwrap();
        assert_eq!(statuses.len(), drops);
        for (i, s) in statuses.iter().enumerate() {
            assert_eq!(s.status, "retrying");
            assert_eq!(s.error_type.as_deref(), Some("RemoteProtocolError"));
            assert_eq!(s.attempt, Some(i as i64 + 1));
            assert_eq!(s.max_attempts, None, "no retry budget");
            let delay = s.delay_seconds.unwrap();
            assert!((NETWORK_RETRY_MIN_DELAY..=NETWORK_RETRY_MAX_DELAY).contains(&delay), "attempt {} waited {delay}s", i + 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stop_ends_the_wait_for_the_network() {
        let turns: Vec<MockTurn> = (0..1000).map(|_| dropped()).collect();
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(turns));
        let messages = vec![ChatMessage::user("hi")];
        let stop = Event::new();
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), None, Some(stop.clone())).retry_network_indefinitely();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            stop.set();
        });

        let started = tokio::time::Instant::now();
        assert_eq!(drain(&mut rs).await.unwrap(), "");
        assert!(started.elapsed() < Duration::from_secs(31), "stopped after {:?}", started.elapsed());
    }

    /// Summarization cannot be stopped mid-call, so it keeps a budget.
    #[tokio::test(start_paused = true)]
    async fn background_streams_give_up_after_the_network_budget() {
        let turns: Vec<MockTurn> = (0..MAX_NETWORK_ATTEMPTS).map(|_| dropped()).collect();
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(turns));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        let err = drain(&mut rs).await.unwrap_err();
        assert!(matches!(err, ModelError::Transient { ref error_type, .. } if error_type == "RemoteProtocolError"), "{err:?}");
        let statuses = log.0.lock().unwrap();
        assert_eq!(statuses.len() as i64, MAX_NETWORK_ATTEMPTS);
        assert_eq!(statuses.last().unwrap().status, "exhausted");
    }

    /// An account's spend cap does not lift on its own within the quota
    /// wait, whatever reset time the response carries: in production a turn
    /// parked on Anthropic's monthly cap for 79 minutes. It fails at once and
    /// says what to do.
    #[tokio::test(start_paused = true)]
    async fn a_spend_limit_429_fails_at_once_with_what_to_do() {
        let body = r#"{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's monthly spend limit. Please try again later."}}"#;
        let spend_limit = MockTurn::Error(ProviderError::http(429, "https://api.anthropic.com/v1/messages", body.into(), vec![("retry-after".into(), "3600".into())]));
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![spend_limit, MockProvider::text("too late")]));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "claude:claude-opus", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None).retry_network_indefinitely();

        let started = tokio::time::Instant::now();
        let err = drain(&mut rs).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1), "waited {:?}", started.elapsed());
        let ModelError::Agent(AgentError::RateLimit(message)) = err else { panic!("{err:?}") };
        assert!(message.contains("spend limit"), "{message}");
        assert!(message.contains("claude:claude-opus"), "{message}");
        assert!(log.0.lock().unwrap().iter().all(|s| s.status != "waiting_quota"), "it waited for a quota reset");
    }

    /// Answers after `latency`, then streams each chunk after its delay.
    struct Paced {
        latency: Duration,
        chunks: Mutex<Option<Vec<(Duration, ChatCompletionChunk)>>>,
        kw: Kwargs,
    }

    #[async_trait]
    impl LlmProvider for Paced {
        fn model(&self) -> &str {
            "mock"
        }
        fn provider_name(&self) -> Option<&str> {
            Some("mock")
        }
        fn base_kwargs(&self) -> &Kwargs {
            &self.kw
        }
        async fn chat(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> appv3_providers::ProviderResult<AssistantMessage> {
            unreachable!()
        }
        async fn stream(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> appv3_providers::ProviderResult<ChunkStream> {
            tokio::time::sleep(self.latency).await;
            let chunks = self.chunks.lock().unwrap().take().unwrap();
            Ok(Box::pin(futures::stream::iter(chunks).then(|(delay, chunk)| async move {
                tokio::time::sleep(delay).await;
                Ok(chunk)
            })))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn timing_measures_first_output_and_generation_speed() {
        let delta =
            |content: Option<&str>| ChatCompletionChunk::delta("mock", "mock", ChatCompletionDelta { content: content.map(String::from), ..Default::default() }, None, None);
        let usage = Usage { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110, ..Default::default() };
        let provider: Arc<dyn LlmProvider> = Arc::new(Paced {
            latency: Duration::from_millis(300),
            chunks: Mutex::new(Some(vec![
                // A role-only opener carries no output and does not count.
                (Duration::ZERO, delta(None)),
                (Duration::from_millis(500), delta(Some("Hello"))),
                (Duration::from_secs(2), delta(Some(" world"))),
                (Duration::from_millis(100), ChatCompletionChunk::delta("mock", "mock", ChatCompletionDelta::default(), Some("stop".into()), Some(usage))),
            ])),
            kw: Kwargs::new(),
        });
        let ctx = ctx();
        let state = AgentState::new(vec![], String::new());
        let (msg, _, timing) = stream_and_assemble(StreamArgs {
            ctx: &ctx,
            state: &state,
            hooks: &[],
            interrupt: None,
            hard_cancel: None,
            system_prompt: "",
            messages: vec![ChatMessage::user("hi")],
            tool_defs: &[],
            provider,
            label: "mock:mock",
            agent_name: "lead",
            agent_id: "lead-id",
        })
        .await
        .unwrap();

        assert_eq!(msg.content.as_deref(), Some("Hello world"));
        let near = |d: Option<Duration>, secs: f64| (d.unwrap().as_secs_f64() - secs).abs() < 0.01;
        assert!(near(timing.ttft, 0.8), "{timing:?}");
        assert!(near(timing.generation, 2.0), "{timing:?}");
        assert!((timing.output_tokens_per_second(100).unwrap() - 50.0).abs() < 0.5);
    }

    #[test]
    fn output_speed_needs_tokens_and_a_measurable_window() {
        let t = |ms: u64| StreamTiming { ttft: Some(Duration::from_millis(200)), generation: Some(Duration::from_millis(ms)) };
        assert_eq!(t(1000).output_tokens_per_second(40), Some(40.0));
        assert_eq!(t(1000).output_tokens_per_second(0), None);
        // Everything in one burst: no rate to speak of.
        assert_eq!(t(5).output_tokens_per_second(500), None);
        assert_eq!(StreamTiming::default().output_tokens_per_second(40), None);
    }

    /// Old history with an oversized image reaches the provider shrunk;
    /// the agent's own copy of the history is left untouched.
    #[tokio::test]
    async fn requests_cap_history_images_for_every_provider() {
        use appv3_providers::images::{dimensions_b64, fixtures};
        use appv3_providers::ContentBlock;
        let mock = Arc::new(MockProvider::new(vec![MockProvider::text("seen")]));
        let provider: Arc<dyn LlmProvider> = mock.clone();
        let big = ContentBlock::ImageData { data: fixtures::b64(&fixtures::png(2600, 1200)).into(), media_type: "image/png".into() };
        let messages = vec![
            ChatMessage::user("look"),
            ChatMessage::Assistant(AssistantMessage { tool_calls: Some(vec![ToolCall::new("c1", "read", "{}")]), ..Default::default() }),
            ChatMessage::Tool {
                content: Some("[Image: a.png]".into()),
                tool_call_id: "c1".into(),
                name: Some("read".into()),
                parts: Some(vec![big.clone()]),
                meta: Default::default(),
            },
        ];
        let ctx = ctx();
        let state = AgentState::new(vec![], String::new());
        let (msg, _, _) = stream_and_assemble(StreamArgs {
            ctx: &ctx,
            state: &state,
            hooks: &[],
            interrupt: None,
            hard_cancel: None,
            system_prompt: "sys",
            messages: messages.clone(),
            tool_defs: &[],
            provider,
            label: "mock:mock",
            agent_name: "lead",
            agent_id: "lead-id",
        })
        .await
        .unwrap();
        assert_eq!(msg.content.as_deref(), Some("seen"));
        let calls = mock.calls.lock().unwrap();
        let sent = calls[0].0.iter().find_map(|m| if let ChatMessage::Tool { parts: Some(p), .. } = m { Some(p.clone()) } else { None }).unwrap();
        let ContentBlock::ImageData { data, .. } = &sent[0] else { panic!("image") };
        assert_eq!(dimensions_b64(data), Some((2000, 923)));
        let ChatMessage::Tool { parts: Some(p), .. } = &messages[2] else { panic!() };
        assert_eq!(p[0], big);
    }
}
