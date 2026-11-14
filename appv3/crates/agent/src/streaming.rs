//! One LLM call with retry + assembly, including the `stream_with_retry` loop.

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

/// Where a [`RetryStream`] is between pulls.
enum Phase {
    /// The next pull issues a request. `restart`: the failed attempt before
    /// it had streamed chunks, so the pull first yields [`RetryItem::Restart`].
    Request { restart: bool },
    /// An attempt is streaming; `emitted` once it has yielded a chunk.
    Streaming { stream: SyncStream, emitted: bool },
    /// The stream completed, Stop ended it, or it returned an error.
    Finished,
}

/// What one call has spent of each retry budget. Each kind of failure spends
/// only its own: HTTP errors, transport failures, quota waits and
/// credential switches never draw on each other.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Spent {
    /// HTTP errors retried (of [`MAX_RETRIES`] attempts).
    http: i64,
    /// Transport failures retried (of the stream's network limit).
    network: i64,
    /// Quota resets waited out (of [`MAX_QUOTA_WAITS`]).
    quota_waits: i64,
    /// Credential switches (of [`MAX_CREDENTIAL_SWITCHES`]).
    switches: i64,
}

impl Spent {
    /// Charges a finished wait to its budget.
    fn charge(&mut self, wait: &Wait) {
        match wait {
            Wait::Quota { .. } => self.quota_waits += 1,
            Wait::Http { .. } => self.http += 1,
            Wait::Network { .. } => self.network += 1,
        }
    }
}

/// A wait before the next attempt; [`Spent::charge`] says which budget it
/// spends.
#[derive(Debug, Clone, PartialEq)]
enum Wait {
    /// A 429 whose reset is past the backoff cap: wait for the reset.
    Quota { status: u16, reset: i64, wait: f64, every_account: bool },
    /// Backoff before retrying an HTTP error.
    Http { status: u16, retry_after: i64, delay: f64 },
    /// A short flat wait before retrying a transport failure.
    Network { error_type: String, delay: f64 },
}

impl Wait {
    fn seconds(&self) -> f64 {
        match self {
            Wait::Quota { wait, .. } => *wait,
            Wait::Http { delay, .. } | Wait::Network { delay, .. } => *delay,
        }
    }
}

/// What to do about one failed attempt that no credential switch fixed.
#[derive(Debug)]
enum Recovery {
    /// Wait, then issue the next request.
    Wait(Wait),
    /// The failure's budget is spent: report it, then fail with `error`.
    Exhausted { error_type: String, status_code: Option<i64>, max_attempts: i64, error: ModelError },
    /// Fail at once.
    Fail(ModelError),
}

/// [`plan_recovery`]'s decision. `rate_limit` is the retry-after a 429 that
/// can be retried announces through `on_rate_limit` before the recovery
/// (even when the recovery then gives up).
#[derive(Debug)]
struct Plan {
    rate_limit: Option<i64>,
    recovery: Recovery,
}

impl Plan {
    fn fail(error: ModelError) -> Self {
        Plan { rate_limit: None, recovery: Recovery::Fail(error) }
    }
}

/// What a failed turn keeps, said on every "unavailable" card.
const KEPT: &str = "Your messages and the files changed so far are kept.";

/// Error raised after the retry loop gives up on an HTTP error. The card
/// says what happened in plain words; the transport's text goes to its
/// details.
fn final_error(err: &ProviderError, label: &str) -> ModelError {
    if err.status() == Some(429) {
        return AgentError::RateLimit("The configured LLM provider is rate-limited or quota-exhausted.".into()).into();
    }
    let status = err.status();
    let http = status.map(|s| format!(" (HTTP {s})")).unwrap_or_default();
    let details = match extract_provider_error_message(err.body()) {
        Some(said) => format!("{err}\n{said}"),
        None => err.to_string(),
    };
    AgentError::Unavailable { message: format!("It answered with an error {MAX_RETRIES} times in a row{http}. {KEPT}"), details, status, provider: Some(label.to_string()) }.into()
}

/// Decides how a call recovers from `err`, given what it has `spent`. Pure
/// apart from backoff jitter and logging; `every_account` (seconds until the
/// first of a pooled provider's credentials recovers) is asked only for a 429.
fn plan_recovery(err: &ProviderError, spent: Spent, network_limit: Option<i64>, every_account: impl FnOnce() -> Option<f64>, label: &str) -> Plan {
    match err {
        ProviderError::Http { status, body, .. } => {
            let status = *status;
            if !is_retryable_http(status, body) {
                tracing::warn!("llm_provider_error model={} status={} body={}", label, status, crate::util::head_chars(body, 500));
                return Plan::fail(classify_http(status, body, label).into());
            }
            let mut rate_limit = None;
            let retry_after = if status == 429 {
                if is_spend_limit_429(status, body) {
                    tracing::warn!("llm_provider_spend_limit model={} body={}", label, crate::util::head_chars(body, 300));
                    return Plan::fail(
                        AgentError::RateLimit(format!("{label} reached the account's spend limit. Raise the limit in the provider's console, or switch to another model.")).into(),
                    );
                }
                let mut reset = parse_retry_after(err);
                // Every credential is cooling down: wait for the first one to
                // recover, not necessarily the one that failed.
                let every_account = every_account();
                if let Some(next) = every_account {
                    let next = next.ceil().max(1.0) as i64;
                    reset = if reset > 0 { reset.min(next) } else { next };
                }
                if reset as f64 > MAX_DELAY {
                    if reset > MAX_QUOTA_WAIT_SECONDS {
                        return Plan::fail(
                            AgentError::RateLimit(format!(
                                "The configured LLM provider quota is exhausted. Reset in {}, which exceeds the maximum auto-wait of {}.",
                                format_duration(reset as f64),
                                format_duration(MAX_QUOTA_WAIT_SECONDS as f64)
                            ))
                            .into(),
                        );
                    }
                    if spent.quota_waits >= MAX_QUOTA_WAITS {
                        return Plan::fail(final_error(err, label));
                    }
                    let wait = reset as f64 + CLOCK_SKEW_BUFFER_SECONDS;
                    return Plan { rate_limit: None, recovery: Recovery::Wait(Wait::Quota { status, reset, wait, every_account: every_account.is_some() }) };
                }
                if is_non_retryable_429(status, body) && reset == 0 {
                    return Plan::fail(final_error(err, label));
                }
                rate_limit = Some(reset);
                reset
            } else {
                parse_retry_after(err)
            };
            if spent.http + 1 >= MAX_RETRIES {
                let recovery =
                    Recovery::Exhausted { error_type: "HTTPStatusError".into(), status_code: Some(status as i64), max_attempts: MAX_RETRIES, error: final_error(err, label) };
                return Plan { rate_limit, recovery };
            }
            if status == 429 && required_delay(spent.http, retry_after) >= MAX_DELAY {
                return Plan { rate_limit, recovery: Recovery::Fail(final_error(err, label)) };
            }
            let delay = backoff_delay(spent.http, retry_after);
            Plan { rate_limit, recovery: Recovery::Wait(Wait::Http { status, retry_after, delay }) }
        }
        ProviderError::Network(msg) => {
            let error_type = network_error_type(msg).to_string();
            if let Some(limit) = network_limit.filter(|l| spent.network + 1 >= *l) {
                let error = ModelError::Transient { error_type: error_type.clone(), message: msg.clone() };
                return Plan { rate_limit: None, recovery: Recovery::Exhausted { error_type, status_code: None, max_attempts: limit, error } };
            }
            Plan { rate_limit: None, recovery: Recovery::Wait(Wait::Network { error_type, delay: network_retry_delay() }) }
        }
        ProviderError::Unconfigured(m) => Plan::fail(AgentError::Unconfigured(m.clone()).into()),
        ProviderError::Auth(m) => Plan::fail(AgentError::Auth { message: m.clone(), status: None, provider: None }.into()),
        // A bad address, a refused certificate, an answer that cannot be read.
        ProviderError::NetworkPermanent(m) => Plan::fail(
            AgentError::Unavailable {
                message: format!("The request could not be completed, and trying again will not help. Check the provider's base URL in Settings → Providers. {KEPT}"),
                details: m.clone(),
                status: None,
                provider: Some(label.to_string()),
            }
            .into(),
        ),
        other => Plan::fail(AgentError::Other(other.to_string()).into()),
    }
}

/// Pull-based `stream_with_retry`: each pull moves it through [`Phase`]s,
/// and each failed attempt goes through a credential switch or
/// [`plan_recovery`].
pub struct RetryStream<'a> {
    provider: Arc<dyn LlmProvider>,
    label: String,
    messages: &'a [ChatMessage],
    tools: Option<&'a [ToolSpec]>,
    kwargs: Kwargs,
    hooks: Option<(&'a [HookRef], &'a RunContext)>,
    interrupt: Option<Event>,
    phase: Phase,
    /// When the current attempt's request was issued.
    attempt_started: Instant,
    spent: Spent,
    /// Most attempts through transport failures; `None` retries until the
    /// network is back (or the caller stops the stream).
    network_limit: Option<i64>,
}

/// How a failed attempt ended: retry, or Stop came during the wait.
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
            phase: Phase::Request { restart: false },
            attempt_started: Instant::now(),
            spent: Spent::default(),
            network_limit: Some(MAX_NETWORK_ATTEMPTS),
        }
    }

    /// Retry transport failures without limit. Only for streams the user can
    /// stop: the turn's own model call, which races its interrupt and
    /// hard-cancel. A background call (summarization) keeps the budget.
    pub fn retry_network_indefinitely(mut self) -> Self {
        self.network_limit = None;
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
        if self.spent.switches >= MAX_CREDENTIAL_SWITCHES {
            return false;
        }
        let Some((reason, cooldown)) = credential_cooldown(err) else { return false };
        let pid = self.provider.provider_name().unwrap_or("").to_string();
        let from = appv3_providers::pool::credential_label(&pid, err);
        let Some(to) = self.provider.rotate_credential(err, reason, cooldown) else { return false };
        self.spent.switches += 1;
        let status = err.status().unwrap_or(0);
        let from = from.unwrap_or_else(|| "The credential in use".into());
        let msg = format!("{from} {}. Continuing on {to} with the same model.", switch_reason_text(reason, cooldown));
        tracing::warn!("llm_provider_credential_switched model={} status={} reason={} switch={}", self.label, status, reason, self.spent.switches);
        self.notify_retry(ProviderStatus {
            status: "switched_credential".into(),
            model: Some(self.label.clone()),
            error_type: Some("HTTPStatusError".into()),
            status_code: Some(status as i64),
            message: Some(msg),
            credential_label: Some(to),
            ..Default::default()
        })
        .await;
        true
    }

    /// Announces `wait` (log and status), then sleeps through it. `Stop`
    /// when the interrupt fired first; the budget is charged only for a wait
    /// that ran to its end.
    async fn wait_out(&mut self, wait: Wait) -> Next {
        let status = match &wait {
            Wait::Quota { status, reset, wait: secs, every_account } => {
                let secs = *secs;
                tracing::warn!("llm_provider_quota_wait model={} status={} wait={:.0}s quota_wait={}/{}", self.label, status, secs, self.spent.quota_waits + 1, MAX_QUOTA_WAITS);
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
                // A provider with several accounts only waits once every one
                // is limited (a locked session included).
                let msg = if *every_account {
                    format!(
                        "Every account for {} is at its usage limit. Waiting {} for the first one to reset. Agent will automatically resume work. You can stop at any time.",
                        self.label,
                        format_duration(secs)
                    )
                } else {
                    format!(
                        "Provider quota exhausted for {}. Waiting {} for reset. Agent will automatically resume work. You can stop at any time.",
                        self.label,
                        format_duration(secs)
                    )
                };
                ProviderStatus {
                    status: "waiting_quota".into(),
                    model: Some(self.label.clone()),
                    attempt: Some(self.spent.http + 1),
                    max_attempts: Some(MAX_RETRIES),
                    delay_seconds: Some(secs),
                    error_type: Some("HTTPStatusError".into()),
                    status_code: Some(*status as i64),
                    retry_after: Some(*reset),
                    message: Some(msg),
                    resets_at: Some((now + *reset as f64) as i64),
                    ..Default::default()
                }
            }
            Wait::Http { status, retry_after, delay } => {
                tracing::warn!("llm_provider_retry model={} status={} attempt={}/{} delay={:.1}s", self.label, status, self.spent.http + 1, MAX_RETRIES, delay);
                ProviderStatus {
                    status: "retrying".into(),
                    model: Some(self.label.clone()),
                    attempt: Some(self.spent.http + 1),
                    max_attempts: Some(MAX_RETRIES),
                    delay_seconds: Some(*delay),
                    error_type: Some("HTTPStatusError".into()),
                    status_code: Some(*status as i64),
                    retry_after: Some(*retry_after),
                    ..Default::default()
                }
            }
            Wait::Network { error_type, delay } => {
                let limit = self.network_limit.map(|b| b.to_string()).unwrap_or_else(|| "unlimited".into());
                tracing::warn!("llm_provider_retry model={} error={} attempt={}/{} delay={:.1}s", self.label, error_type, self.spent.network + 1, limit, delay);
                ProviderStatus {
                    status: "retrying".into(),
                    model: Some(self.label.clone()),
                    attempt: Some(self.spent.network + 1),
                    max_attempts: self.network_limit,
                    delay_seconds: Some(*delay),
                    error_type: Some(error_type.clone()),
                    ..Default::default()
                }
            }
        };
        self.notify_retry(status).await;
        if self.sleep(wait.seconds()).await {
            return Next::Stop;
        }
        self.spent.charge(&wait);
        Next::Continue
    }

    /// Handle one failed attempt: switch credentials, or carry out
    /// [`plan_recovery`]. `Ok(Continue)` retries, `Ok(Stop)` ends the stream
    /// (interrupted), `Err` raises.
    async fn recover(&mut self, err: ProviderError) -> Result<Next, ModelError> {
        if self.try_switch_credential(&err).await {
            return Ok(Next::Continue);
        }
        let provider = self.provider.clone();
        let plan = plan_recovery(&err, self.spent, self.network_limit, || provider.credential_recovery_secs(), &self.label);
        if let (Some(retry_after), Some((hooks, ctx))) = (plan.rate_limit, self.hooks) {
            for h in hooks {
                h.on_rate_limit(ctx, retry_after, self.spent.http + 1, MAX_RETRIES).await;
            }
        }
        match plan.recovery {
            Recovery::Wait(wait) => Ok(self.wait_out(wait).await),
            Recovery::Exhausted { error_type, status_code, max_attempts, error } => {
                match status_code {
                    Some(status) => tracing::warn!("llm_provider_exhausted model={} status={} attempts={}", self.label, status, max_attempts),
                    None => tracing::warn!("llm_provider_exhausted model={} error={} attempts={}", self.label, error_type, max_attempts),
                }
                self.notify_exhausted(&error_type, status_code, max_attempts).await;
                Err(error)
            }
            Recovery::Fail(error) => Err(error),
        }
    }

    /// Ends the current attempt after `err` (`emitted`: it had yielded
    /// chunks). The stream then waits for its next request, or finishes when
    /// Stop came during the wait or the error is final.
    async fn end_attempt(&mut self, err: ProviderError, emitted: bool) -> Result<(), ModelError> {
        self.phase = Phase::Request { restart: emitted };
        match self.recover(err).await {
            Ok(Next::Continue) => Ok(()),
            Ok(Next::Stop) => {
                self.phase = Phase::Finished;
                Ok(())
            }
            Err(e) => {
                self.phase = Phase::Finished;
                Err(e)
            }
        }
    }

    pub async fn next(&mut self) -> Result<Option<RetryItem>, ModelError> {
        loop {
            match self.phase {
                Phase::Finished => return Ok(None),
                Phase::Request { restart } => {
                    if self.interrupted() {
                        self.phase = Phase::Finished;
                        return Ok(None);
                    }
                    if restart {
                        self.phase = Phase::Request { restart: false };
                        return Ok(Some(RetryItem::Restart));
                    }
                    self.attempt_started = Instant::now();
                    match self.provider.stream(self.messages, self.tools, &self.kwargs).await {
                        Ok(s) => self.phase = Phase::Streaming { stream: SyncStream(s), emitted: false },
                        Err(e) => self.end_attempt(e, false).await?,
                    }
                }
                Phase::Streaming { ref mut stream, ref mut emitted } => {
                    let item = stream.0.next().await;
                    match item {
                        Some(Ok(chunk)) => {
                            *emitted = true;
                            return Ok(Some(RetryItem::Chunk(chunk)));
                        }
                        None => {
                            self.phase = Phase::Finished;
                            return Ok(None);
                        }
                        Some(Err(e)) => {
                            let emitted = *emitted;
                            self.end_attempt(e, emitted).await?;
                        }
                    }
                }
            }
        }
    }
}

/// Merge consecutive user messages.
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
        /// The session is pinned to "a" under this label.
        pinned: Option<&'static str>,
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
                pinned: None,
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
        fn pinned_credential(&self) -> Option<String> {
            self.pinned.map(String::from)
        }
    }

    /// A locked session whose account hit its limit moves on like any other
    /// session: the lock does not hold it on the limited account.
    #[tokio::test(start_paused = true)]
    async fn a_locked_account_at_its_limit_moves_on_to_the_next_account() {
        let provider = Arc::new(TwoKeys { pinned: Some("Personal"), ..TwoKeys::new(true, None) });
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
        assert_eq!(statuses[0].credential_label.as_deref(), Some("Work"));
    }

    /// With every account limited, a locked session waits for the first one
    /// to reset, and the notice says every account is limited.
    #[tokio::test(start_paused = true)]
    async fn a_locked_session_waits_only_when_every_account_is_limited() {
        let provider = Arc::new(TwoKeys { pinned: Some("Personal"), ..TwoKeys::new(false, Some(Duration::from_secs(600))) });
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider.clone(), "codex:gpt-5.4", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        let started = Instant::now();
        assert_eq!(drain(&mut rs).await.unwrap(), "from work");
        let waited = started.elapsed().as_secs_f64();
        assert!((600.0..620.0).contains(&waited), "waited {waited}s");
        let statuses = log.0.lock().unwrap();
        let wait = statuses.iter().find(|s| s.status == "waiting_quota").unwrap_or_else(|| panic!("{statuses:?}"));
        let msg = wait.message.as_deref().unwrap();
        assert!(msg.starts_with("Every account for codex:gpt-5.4 is at its usage limit"), "{msg}");
        assert!(statuses.iter().all(|s| s.status != "waiting_credential" && s.status != "switched_credential"), "{statuses:?}");
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
        assert_eq!(statuses[0].credential_label.as_deref(), Some("Work"));
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

    fn server_error() -> MockTurn {
        MockTurn::Error(ProviderError::http(500, "https://example.test/v1/chat", String::new(), vec![]))
    }

    fn http(status: u16, body: &str, retry_after: Option<&str>) -> ProviderError {
        let headers = retry_after.map(|r| vec![("retry-after".to_string(), r.to_string())]).unwrap_or_default();
        ProviderError::http(status, "https://example.test/v1/chat", body.into(), headers)
    }

    fn plan(err: &ProviderError, spent: Spent, network_limit: Option<i64>) -> Plan {
        plan_recovery(err, spent, network_limit, || None, "mock:mock")
    }

    #[test]
    fn each_failure_kind_spends_and_exhausts_only_its_own_budget() {
        let lost = ProviderError::Network("connection reset".into());
        let full = Spent { http: MAX_RETRIES - 1, network: MAX_NETWORK_ATTEMPTS - 1, quota_waits: MAX_QUOTA_WAITS, switches: MAX_CREDENTIAL_SWITCHES };

        // A transport failure looks only at the network budget.
        let spent_elsewhere = Spent { network: 0, ..full };
        assert!(matches!(plan(&lost, spent_elsewhere, Some(MAX_NETWORK_ATTEMPTS)).recovery, Recovery::Wait(Wait::Network { .. })));
        let Recovery::Exhausted { status_code, max_attempts, error, .. } = plan(&lost, full, Some(MAX_NETWORK_ATTEMPTS)).recovery else { panic!("not exhausted") };
        assert_eq!((status_code, max_attempts), (None, MAX_NETWORK_ATTEMPTS));
        assert!(matches!(error, ModelError::Transient { .. }));
        assert!(matches!(plan(&lost, Spent { network: 10_000, ..full }, None).recovery, Recovery::Wait(Wait::Network { .. })), "no limit: never exhausted");

        // An HTTP error looks only at the HTTP budget.
        let err = http(500, "", None);
        let spent_elsewhere = Spent { http: 0, ..full };
        let Recovery::Wait(Wait::Http { status, .. }) = plan(&err, spent_elsewhere, Some(1)).recovery else { panic!("no backoff") };
        assert_eq!(status, 500);
        let Recovery::Exhausted { status_code, max_attempts, .. } = plan(&err, full, Some(1)).recovery else { panic!("not exhausted") };
        assert_eq!((status_code, max_attempts), (Some(500), MAX_RETRIES));

        // A quota reset looks only at the quota waits.
        let quota = http(429, "{}", Some("120"));
        let spent_elsewhere = Spent { quota_waits: 0, ..full };
        let Recovery::Wait(Wait::Quota { reset, wait, every_account, .. }) = plan(&quota, spent_elsewhere, Some(1)).recovery else { panic!("no quota wait") };
        assert_eq!((reset, wait, every_account), (120, 120.0 + CLOCK_SKEW_BUFFER_SECONDS, false));
        assert!(matches!(plan(&quota, full, Some(1)).recovery, Recovery::Fail(ModelError::Agent(AgentError::RateLimit(_)))));
    }

    #[test]
    fn a_wait_is_charged_to_its_own_budget() {
        let mut spent = Spent::default();
        spent.charge(&Wait::Quota { status: 429, reset: 120, wait: 122.0, every_account: false });
        spent.charge(&Wait::Http { status: 500, retry_after: 0, delay: 1.0 });
        spent.charge(&Wait::Network { error_type: "ConnectError".into(), delay: 3.0 });
        spent.charge(&Wait::Network { error_type: "ConnectError".into(), delay: 3.0 });
        assert_eq!(spent, Spent { http: 1, network: 2, quota_waits: 1, switches: 0 });
    }

    #[test]
    fn a_retryable_429_is_announced_as_a_rate_limit_even_when_it_gives_up() {
        let limited = http(429, "{}", Some("5"));
        let p = plan(&limited, Spent::default(), None);
        assert_eq!(p.rate_limit, Some(5));
        assert!(matches!(p.recovery, Recovery::Wait(Wait::Http { retry_after: 5, .. })));
        let p = plan(&limited, Spent { http: MAX_RETRIES - 1, ..Spent::default() }, None);
        assert_eq!(p.rate_limit, Some(5));
        assert!(matches!(p.recovery, Recovery::Exhausted { .. }));
        // Other errors are not rate limits.
        assert_eq!(plan(&http(503, "", Some("5")), Spent::default(), None).rate_limit, None);
        assert_eq!(plan(&http(429, "{}", Some("120")), Spent::default(), None).rate_limit, None, "a quota wait is announced as such");
    }

    /// The card a turn ends on says what failed and what is kept. The
    /// transport's own text (the request URL, a link to MDN) is for Copy
    /// details only.
    #[test]
    fn a_provider_that_keeps_failing_is_reported_in_plain_words() {
        let overloaded = http(503, r#"{"error":{"type":"overloaded_error","message":"Overloaded"}}"#, None);
        let Recovery::Exhausted { error: ModelError::Agent(error), .. } = plan(&overloaded, Spent { http: MAX_RETRIES - 1, ..Spent::default() }, None).recovery else {
            panic!("not exhausted")
        };
        let info = crate::errors::format_agent_error(&error, None);
        assert_eq!(info["title"], "mock:mock is unavailable");
        assert_eq!(info["message"], format!("It answered with an error {MAX_RETRIES} times in a row (HTTP 503). Your messages and the files changed so far are kept."));
        assert_eq!((info["code"].as_str(), info["category"].as_str()), (Some("provider_unavailable"), Some("provider")));
        let details = info["details"].as_str().unwrap_or_default();
        assert!(details.contains("Server error '503 Service Unavailable' for url 'https://example.test/v1/chat'"), "{details}");
        assert!(details.contains("overloaded_error: Overloaded"), "{details}");

        // A request that can never be sent (a bad address, a refused certificate).
        let Recovery::Fail(ModelError::Agent(error)) = plan(&ProviderError::NetworkPermanent("builder error: relative URL without a base".into()), Spent::default(), None).recovery
        else {
            panic!("not final")
        };
        let info = crate::errors::format_agent_error(&error, None);
        assert_eq!(info["title"], "mock:mock is unavailable");
        assert_eq!(
            info["message"],
            "The request could not be completed, and trying again will not help. Check the provider's base URL in Settings → Providers. Your messages and the files changed so far are kept."
        );
        assert_eq!(info["details"], "builder error: relative URL without a base");
    }

    #[test]
    fn final_failures_do_not_retry() {
        let fails = |err: ProviderError| matches!(plan(&err, Spent::default(), None).recovery, Recovery::Fail(_));
        assert!(fails(http(400, r#"{"error":{"message":"bad request"}}"#, None)), "not retryable");
        assert!(fails(http(429, "monthly spend limit reached", Some("60"))), "spend limit");
        assert!(fails(http(429, "{}", Some("172800"))), "reset past the longest quota wait");
        assert!(fails(http(429, "insufficient_quota", None)), "a quota marker with no reset");
        assert!(fails(ProviderError::Unconfigured("no key".into())));
        assert!(fails(ProviderError::Auth("rejected".into())));
    }

    /// A pooled provider whose accounts are all cooling waits for the first
    /// to recover, and the plan says it is every account.
    #[test]
    fn every_cooling_account_shortens_the_quota_wait_to_the_first_recovery() {
        let quota = http(429, "{}", Some("3600"));
        let p = plan_recovery(&quota, Spent::default(), None, || Some(599.2), "mock:mock");
        let Recovery::Wait(Wait::Quota { reset, every_account, .. }) = p.recovery else { panic!("{p:?}") };
        assert_eq!((reset, every_account), (600, true));
        let mut asked = false;
        plan_recovery(
            &http(500, "", None),
            Spent::default(),
            None,
            || {
                asked = true;
                None
            },
            "mock:mock",
        );
        assert!(!asked, "only a 429 asks the pool");
    }

    /// A 429 whose reset is past the backoff cap: a quota wait.
    fn quota_reset_in_two_minutes() -> MockTurn {
        MockTurn::Error(ProviderError::http(429, "https://example.test/v1/chat", "{}".into(), vec![("retry-after".into(), "120".into())]))
    }

    fn statuses_of(log: &StatusLog) -> Vec<String> {
        log.0.lock().unwrap().iter().map(|s| s.status.clone()).collect()
    }

    /// HTTP errors and transport failures each spend their own budget: four
    /// server errors and nine dropped connections still end in an answer.
    #[tokio::test(start_paused = true)]
    async fn http_and_network_failures_draw_on_separate_budgets() {
        let mut turns: Vec<MockTurn> = (0..MAX_RETRIES - 1).map(|_| server_error()).collect();
        turns.extend((0..MAX_NETWORK_ATTEMPTS - 1).map(|_| dropped()));
        turns.push(MockProvider::text("answer"));
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(turns));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        assert_eq!(drain(&mut rs).await.unwrap(), "answer");
        let statuses = log.0.lock().unwrap();
        assert_eq!(statuses.len() as i64, MAX_RETRIES - 1 + MAX_NETWORK_ATTEMPTS - 1);
        assert!(statuses.iter().all(|s| s.status == "retrying"), "{statuses:?}");
        let http: Vec<_> = statuses.iter().filter(|s| s.status_code == Some(500)).map(|s| (s.attempt, s.max_attempts)).collect();
        assert_eq!(http, (1..MAX_RETRIES).map(|a| (Some(a), Some(MAX_RETRIES))).collect::<Vec<_>>());
        let network: Vec<_> = statuses.iter().filter(|s| s.status_code.is_none()).map(|s| (s.attempt, s.max_attempts)).collect();
        assert_eq!(network, (1..MAX_NETWORK_ATTEMPTS).map(|a| (Some(a), Some(MAX_NETWORK_ATTEMPTS))).collect::<Vec<_>>());
    }

    #[tokio::test(start_paused = true)]
    async fn the_last_http_attempt_reports_exhaustion_and_fails() {
        let turns: Vec<MockTurn> = (0..MAX_RETRIES + 1).map(|_| server_error()).collect();
        let mock = Arc::new(MockProvider::new(turns));
        let provider: Arc<dyn LlmProvider> = mock.clone();
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None).retry_network_indefinitely();

        let err = drain(&mut rs).await.unwrap_err();
        // The card names the provider and keeps the transport's text for its details.
        assert!(matches!(&err, ModelError::Agent(AgentError::Unavailable { status: Some(500), provider: Some(p), .. }) if p == "mock:mock"), "{err:?}");
        assert_eq!(mock.calls.lock().unwrap().len() as i64, MAX_RETRIES);
        {
            let statuses = log.0.lock().unwrap();
            let last = statuses.last().unwrap();
            assert_eq!((last.status.as_str(), last.status_code, last.max_attempts), ("exhausted", Some(500), Some(MAX_RETRIES)));
        }
        assert!(rs.next().await.unwrap().is_none(), "a failed stream stays finished");
    }

    /// Waiting out a quota reset is not an HTTP retry: after the quota waits,
    /// the full HTTP budget is still there.
    #[tokio::test(start_paused = true)]
    async fn quota_waits_do_not_charge_the_http_budget() {
        let mut turns: Vec<MockTurn> = (0..MAX_QUOTA_WAITS).map(|_| quota_reset_in_two_minutes()).collect();
        turns.extend((0..MAX_RETRIES - 1).map(|_| server_error()));
        turns.push(MockProvider::text("answer"));
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(turns));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        assert_eq!(drain(&mut rs).await.unwrap(), "answer");
        let mut expected = vec!["waiting_quota".to_string(); MAX_QUOTA_WAITS as usize];
        expected.extend(vec!["retrying".to_string(); MAX_RETRIES as usize - 1]);
        assert_eq!(statuses_of(&log), expected);
        let waits: Vec<_> = log.0.lock().unwrap().iter().filter(|s| s.status == "waiting_quota").map(|s| s.attempt).collect();
        assert_eq!(waits, vec![Some(1); MAX_QUOTA_WAITS as usize], "a quota wait does not advance the HTTP attempt");
    }

    #[tokio::test(start_paused = true)]
    async fn a_quota_reset_after_the_last_wait_fails_as_rate_limited() {
        let turns: Vec<MockTurn> = (0..MAX_QUOTA_WAITS + 1).map(|_| quota_reset_in_two_minutes()).collect();
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(turns));
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        let err = drain(&mut rs).await.unwrap_err();
        let ModelError::Agent(AgentError::RateLimit(message)) = err else { panic!("{err:?}") };
        assert!(message.contains("rate-limited or quota-exhausted"), "{message}");
        assert_eq!(statuses_of(&log), vec!["waiting_quota".to_string(); MAX_QUOTA_WAITS as usize]);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_ends_a_quota_wait() {
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![quota_reset_in_two_minutes(), MockProvider::text("too late")]));
        let messages = vec![ChatMessage::user("hi")];
        let stop = Event::new();
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), None, Some(stop.clone()));
        let stopper = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            stopper.set();
        });

        let started = Instant::now();
        assert_eq!(drain(&mut rs).await.unwrap(), "");
        assert!(started.elapsed() < Duration::from_secs(11), "stopped after {:?}", started.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn stop_ends_an_http_backoff() {
        let error = MockTurn::Error(ProviderError::http(503, "https://example.test/v1/chat", String::new(), vec![("retry-after".into(), "50".into())]));
        let mock = Arc::new(MockProvider::new(vec![error, MockProvider::text("too late")]));
        let provider: Arc<dyn LlmProvider> = mock.clone();
        let messages = vec![ChatMessage::user("hi")];
        let stop = Event::new();
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), None, Some(stop.clone()));
        let stopper = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            stopper.set();
        });

        let started = Instant::now();
        assert_eq!(drain(&mut rs).await.unwrap(), "");
        assert!(started.elapsed() < Duration::from_secs(6), "stopped after {:?}", started.elapsed());
        assert_eq!(mock.calls.lock().unwrap().len(), 1, "no request after Stop");
    }

    /// Every credential is rejected and the provider always has another one:
    /// switching stops after its own budget and the error surfaces.
    struct EndlessKeys {
        kw: Kwargs,
        calls: Mutex<usize>,
    }

    #[async_trait]
    impl LlmProvider for EndlessKeys {
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
        async fn stream(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> appv3_providers::ProviderResult<ChunkStream> {
            *self.calls.lock().unwrap() += 1;
            Err(ProviderError::http(401, "https://example.test/v1/chat", "{}".into(), vec![]))
        }
        fn rotate_credential(&self, _: &ProviderError, _: &str, _: f64) -> Option<String> {
            Some("Next".into())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn credential_switches_stop_at_their_budget() {
        let provider = Arc::new(EndlessKeys { kw: Kwargs::new(), calls: Mutex::new(0) });
        let log = Arc::new(StatusLog::default());
        let hooks: Vec<HookRef> = vec![log.clone()];
        let ctx = ctx();
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider.clone(), "mock:mock", &messages, None, Kwargs::new(), Some((&hooks, &ctx)), None);

        let err = drain(&mut rs).await.unwrap_err();
        assert!(matches!(err, ModelError::Agent(AgentError::Auth { .. })), "{err:?}");
        assert_eq!(*provider.calls.lock().unwrap() as i64, MAX_CREDENTIAL_SWITCHES + 1);
        assert_eq!(statuses_of(&log), vec!["switched_credential".to_string(); MAX_CREDENTIAL_SWITCHES as usize]);
    }

    /// Streams `first` then fails with a dropped connection, then answers
    /// `second` on the retry.
    struct DropsMidStream {
        kw: Kwargs,
        first: Vec<&'static str>,
        calls: Mutex<usize>,
    }

    #[async_trait]
    impl LlmProvider for DropsMidStream {
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
            let call = {
                let mut calls = self.calls.lock().unwrap();
                *calls += 1;
                *calls
            };
            let delta = |s: &str| ChatCompletionChunk::delta("mock", "mock", ChatCompletionDelta { content: Some(s.into()), ..Default::default() }, None, None);
            let items: Vec<Result<ChatCompletionChunk, ProviderError>> = if call == 1 {
                let mut v: Vec<_> = self.first.iter().map(|s| Ok(delta(s))).collect();
                v.push(Err(ProviderError::Network("connection reset".into())));
                v
            } else {
                vec![Ok(delta("second"))]
            };
            Ok(Box::pin(futures::stream::iter(items)))
        }
    }

    async fn items(rs: &mut RetryStream<'_>) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(item) = rs.next().await.unwrap() {
            out.push(match item {
                RetryItem::Restart => "<restart>".into(),
                RetryItem::Chunk(c) => c.choices.iter().filter_map(|ch| ch.delta.content.clone()).collect(),
            });
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn a_retry_after_streamed_output_is_marked_as_a_restart() {
        let provider: Arc<dyn LlmProvider> = Arc::new(DropsMidStream { kw: Kwargs::new(), first: vec!["par", "tial"], calls: Mutex::new(0) });
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), None, None);
        assert_eq!(items(&mut rs).await, ["par", "tial", "<restart>", "second"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_retry_before_any_output_is_not_a_restart() {
        let provider: Arc<dyn LlmProvider> = Arc::new(DropsMidStream { kw: Kwargs::new(), first: vec![], calls: Mutex::new(0) });
        let messages = vec![ChatMessage::user("hi")];
        let mut rs = RetryStream::new(provider, "mock:mock", &messages, None, Kwargs::new(), None, None);
        assert_eq!(items(&mut rs).await, ["second"]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_assembled_message_keeps_only_the_restarted_output() {
        let provider: Arc<dyn LlmProvider> = Arc::new(DropsMidStream { kw: Kwargs::new(), first: vec!["dropped"], calls: Mutex::new(0) });
        let ctx = ctx();
        let state = AgentState::new(vec![], String::new());
        let (msg, _, _) = stream_and_assemble(StreamArgs {
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
        assert_eq!(msg.content.as_deref(), Some("second"));
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
