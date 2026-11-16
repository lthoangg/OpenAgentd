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
                message: format!("The request could not be completed, and trying again will not help. Check the provider's base URL in Settings → Models. {KEPT}"),
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
mod tests;
