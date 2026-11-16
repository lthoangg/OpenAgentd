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
            "The request could not be completed, and trying again will not help. Check the provider's base URL in Settings → Models. Your messages and the files changed so far are kept."
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
    let delta = |content: Option<&str>| ChatCompletionChunk::delta("mock", "mock", ChatCompletionDelta { content: content.map(String::from), ..Default::default() }, None, None);
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
