//! One usage gate per resolved credential, shared by summary and profile requests.
use crate::usage::UsageError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio::time::Instant;

const TTL: Duration = Duration::from_secs(60);
const MAX_AGE: Duration = Duration::from_secs(30 * 60);
const MAX_ENTRIES: usize = 512;

#[derive(Clone, Hash, Eq, PartialEq)]
pub(crate) struct Key {
    pub provider: String,
    pub credential: Option<String>,
}

#[derive(Default)]
struct Entry {
    good: Option<(Instant, Value)>,
    failure: Option<(Instant, Duration, UsageError)>,
    failures: u32,
    generation: u64,
}

struct FetchGuard<'a> {
    entry: &'a mut Entry,
    finished: bool,
}

impl Drop for FetchGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.entry.failure = Some((Instant::now(), Duration::from_secs(5), UsageError::Unavailable("Usage request was interrupted.".into())));
            self.entry.generation = self.entry.generation.wrapping_add(1);
        }
    }
}

pub(crate) struct UsageCache {
    entries: Mutex<HashMap<Key, Arc<AsyncMutex<Entry>>>>,
    concurrency: Semaphore,
}

impl Default for UsageCache {
    fn default() -> Self {
        Self { entries: Mutex::new(HashMap::new()), concurrency: Semaphore::new(4) }
    }
}

impl UsageCache {
    pub async fn uncached<F, Fut>(&self, fetch: F) -> Result<Value, UsageError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, UsageError>>,
    {
        let _permit = self.concurrency.acquire().await.expect("usage semaphore is never closed");
        fetch().await
    }

    pub fn invalidate(&self, provider: &str, credential: Option<&str>) {
        self.entries.lock().unwrap().retain(|key, _| key.provider != provider || credential.is_some_and(|c| key.credential.as_deref() != Some(c)));
    }

    /// Reset changes the measurements, not the usage endpoint's Retry-After.
    pub async fn invalidate_measurements(&self, key: &Key) {
        let slot = self.entries.lock().unwrap().get(key).cloned();
        if let Some(slot) = slot {
            slot.lock().await.good = None;
        }
    }

    pub async fn last_good(&self, key: &Key) -> Option<Value> {
        let slot = self.entries.lock().unwrap().get(key).cloned()?;
        let entry = slot.lock().await;
        snapshot(&entry)
    }

    fn slot(&self, key: &Key) -> Result<Arc<AsyncMutex<Entry>>, UsageError> {
        let mut entries = self.entries.lock().unwrap();
        if !entries.contains_key(key) && entries.len() >= MAX_ENTRIES {
            let removable = entries.iter().find_map(|(key, slot)| {
                let entry = slot.try_lock().ok()?;
                let good_old = entry.good.as_ref().is_none_or(|(at, _)| at.elapsed() > MAX_AGE);
                let failure_old = entry.failure.as_ref().is_none_or(|(at, delay, _)| at.elapsed() >= *delay);
                (good_old && failure_old).then(|| key.clone())
            });
            if let Some(old) = removable {
                entries.remove(&old);
            } else {
                return Err(UsageError::Unavailable("Usage cache is busy. Try again later.".into()));
            }
        }
        Ok(entries.entry(key.clone()).or_default().clone())
    }

    pub async fn get<F, Fut>(&self, key: Key, force: bool, fetch: F) -> Result<Value, UsageError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, UsageError>>,
    {
        let slot = self.slot(&key)?;
        let observed = slot.try_lock().ok().map(|entry| entry.generation);
        let mut entry = slot.lock().await;
        if let Some(error) = cached_failure(&entry) {
            return Err(error);
        }
        if let Some((at, good)) = &entry.good {
            if at.elapsed() < TTL && (!force || observed != Some(entry.generation)) {
                return Ok(good.clone());
            }
        }
        let _permit = self.concurrency.acquire().await.expect("usage semaphore is never closed");
        let result = {
            let mut guard = FetchGuard { entry: &mut entry, finished: false };
            let result = tokio::time::timeout(Duration::from_secs(12), fetch()).await.unwrap_or_else(|_| Err(UsageError::Unavailable("Usage request timed out.".into())));
            guard.finished = true;
            result
        };
        // A reconnect/delete may race an in-flight fetch. Never publish the old identity.
        if !self.entries.lock().unwrap().get(&key).is_some_and(|current| Arc::ptr_eq(current, &slot)) {
            return Err(UsageError::Credentials("The account changed. Refresh usage.".into()));
        }
        entry.generation = entry.generation.wrapping_add(1);
        match result {
            Ok(mut value) => {
                value["updated_at"] = json!(chrono::Utc::now().timestamp());
                entry.good = Some((Instant::now(), value.clone()));
                entry.failure = None;
                entry.failures = 0;
                Ok(value)
            }
            Err(error) => {
                entry.failures = entry.failures.saturating_add(1);
                let delay = match &error {
                    UsageError::RateLimited { retry_after, .. } => {
                        let backoff = 60_u64.saturating_mul(1 << entry.failures.saturating_sub(1).min(4)).min(15 * 60);
                        Duration::from_secs(retry_after.unwrap_or(backoff).max(1))
                    }
                    UsageError::Credentials(_) => Duration::from_secs(60_u64.saturating_mul(1 << entry.failures.saturating_sub(1).min(4)).min(15 * 60)),
                    _ => Duration::from_secs(5),
                };
                if matches!(error, UsageError::Credentials(_) | UsageError::Rejected(_)) {
                    entry.good = None;
                }
                entry.failure = Some((Instant::now(), delay, error));
                Err(cached_failure(&entry).expect("new failure has a positive cooldown"))
            }
        }
    }
}

fn cached_failure(entry: &Entry) -> Option<UsageError> {
    let (at, delay, error) = entry.failure.as_ref()?;
    let remaining = delay.checked_sub(at.elapsed())?;
    if remaining.is_zero() {
        return None;
    }
    match error {
        UsageError::RateLimited { .. } => {
            let seconds = remaining.as_secs().saturating_add(u64::from(remaining.subsec_nanos() > 0));
            let last_good = snapshot(entry);
            Some(UsageError::RateLimited {
                retry_after: Some(seconds),
                retry_at: Some(chrono::Utc::now().timestamp().saturating_add(i64::try_from(seconds).unwrap_or(i64::MAX))),
                last_good,
            })
        }
        UsageError::Unavailable(_) => Some(snapshot(entry).map(UsageError::UnavailableWithData).unwrap_or_else(|| error.clone())),
        other => Some(other.clone()),
    }
}

fn snapshot(entry: &Entry) -> Option<Value> {
    entry.good.as_ref().filter(|(at, _)| at.elapsed() <= MAX_AGE).map(|(_, value)| {
        let mut value = value.clone();
        value["stale"] = json!(true);
        value
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn key(id: &str) -> Key {
        Key { provider: "provider".into(), credential: Some(id.into()) }
    }

    fn good() -> Value {
        json!({"provider":"provider","limits":[{"primary":{"used_percent":0}}]})
    }

    fn limited(after: Option<u64>) -> Result<Value, UsageError> {
        Err(UsageError::rate_limited(after))
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_force_requests_join_the_same_fetch() {
        let cache = UsageCache::default();
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(good())
        };
        let (a, b, c) = tokio::join!(cache.get(key("a"), true, fetch), cache.get(key("a"), true, fetch), cache.get(key("a"), true, fetch));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(a.unwrap(), b.unwrap());
        assert!(c.unwrap()["updated_at"].is_i64());
    }

    #[tokio::test(start_paused = true)]
    async fn ttl_and_cooldown_are_shared_and_force_cannot_bypass_retry_after() {
        let cache = UsageCache::default();
        let original = cache.get(key("a"), false, || async { Ok(good()) }).await.unwrap();
        let hit = cache.get(key("a"), false, || async { panic!("fresh usage must be cached") }).await.unwrap();
        assert_eq!(hit, original);
        let error = cache.get(key("a"), true, || async { limited(Some(188)) }).await.unwrap_err();
        let UsageError::RateLimited { retry_after, last_good, .. } = error else { panic!("expected throttling") };
        assert_eq!(retry_after, Some(188));
        assert_eq!(last_good.as_ref().unwrap()["updated_at"], original["updated_at"]);
        assert_eq!(last_good.as_ref().unwrap()["stale"], true);
        tokio::time::advance(Duration::from_secs(100)).await;
        let error = cache.get(key("a"), true, || async { panic!("must honor cooldown") }).await.unwrap_err();
        assert!(matches!(error, UsageError::RateLimited { retry_after: Some(88), .. }));
        tokio::time::advance(Duration::from_secs(88)).await;
        assert!(cache.get(key("a"), false, || async { Ok(good()) }).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn one_accounts_cooldown_never_blocks_another_account() {
        let cache = UsageCache::default();
        assert!(cache.get(key("a"), false, || async { limited(Some(188)) }).await.is_err());
        assert!(cache.get(key("b"), false, || async { Ok(good()) }).await.is_ok());
        let other_provider = Key { provider: "other".into(), ..key("a") };
        assert!(cache.get(other_provider, false, || async { Ok(good()) }).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn last_good_expires_without_shortening_the_upstream_cooldown() {
        let cache = UsageCache::default();
        cache.get(key("a"), false, || async { Ok(good()) }).await.unwrap();
        let result = cache.get(key("a"), true, || async { limited(Some(7200)) }).await;
        assert!(matches!(result, Err(UsageError::RateLimited { last_good: Some(_), .. })));
        tokio::time::advance(MAX_AGE + Duration::from_secs(1)).await;
        let result = cache.get(key("a"), true, || async { panic!("must not truncate Retry-After") }).await;
        assert!(matches!(result, Err(UsageError::RateLimited { last_good: None, .. })));
    }

    #[tokio::test(start_paused = true)]
    async fn reset_invalidates_measurements_without_unblocking_usage_throttling() {
        let cache = UsageCache::default();
        cache.get(key("a"), false, || async { Ok(good()) }).await.unwrap();
        let _ = cache.get(key("a"), true, || async { limited(Some(188)) }).await;
        cache.invalidate_measurements(&key("a")).await;
        let result = cache.get(key("a"), true, || async { panic!("reset must not bypass cooldown") }).await;
        assert!(matches!(result, Err(UsageError::RateLimited { last_good: None, .. })));
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_drops_only_the_target_accounts_snapshot_and_cooldown() {
        let cache = UsageCache::default();
        let _ = cache.get(key("a"), false, || async { limited(Some(188)) }).await;
        let _ = cache.get(key("b"), false, || async { limited(Some(188)) }).await;
        cache.invalidate("provider", Some("a"));
        assert!(cache.get(key("a"), false, || async { Ok(good()) }).await.is_ok());
        let result = cache.get(key("b"), true, || async { panic!("other account keeps cooldown") }).await;
        assert!(matches!(result, Err(UsageError::RateLimited { .. })));
    }

    #[tokio::test(start_paused = true)]
    async fn authentication_failures_clear_old_usage_instead_of_masking_reconnect() {
        let cache = UsageCache::default();
        cache.get(key("a"), false, || async { Ok(good()) }).await.unwrap();
        let result = cache.get(key("a"), true, || async { Err(UsageError::Credentials("expired".into())) }).await;
        assert!(matches!(result, Err(UsageError::Credentials(_))));
        tokio::time::advance(Duration::from_secs(60)).await;
        let result = cache.get(key("a"), true, || async { limited(None) }).await;
        assert!(matches!(result, Err(UsageError::RateLimited { last_good: None, .. })));
    }

    #[tokio::test(start_paused = true)]
    async fn missing_retry_after_uses_increasing_bounded_backoff() {
        let cache = UsageCache::default();
        for expected in [60, 120, 240, 480, 900, 900] {
            let result = cache.get(key("a"), true, || async { limited(None) }).await;
            assert!(matches!(result, Err(UsageError::RateLimited { retry_after: Some(seconds), .. }) if seconds == expected));
            tokio::time::advance(Duration::from_secs(expected)).await;
        }
    }

    #[tokio::test]
    async fn deletion_during_fetch_cannot_publish_the_previous_identity() {
        let cache = Arc::new(UsageCache::default());
        let (started, wait_started) = tokio::sync::oneshot::channel();
        let (finish, wait_finish) = tokio::sync::oneshot::channel();
        let worker = cache.clone();
        let task = tokio::spawn(async move {
            worker
                .get(key("a"), false, || async {
                    started.send(()).unwrap();
                    wait_finish.await.unwrap();
                    Ok(good())
                })
                .await
        });
        wait_started.await.unwrap();
        cache.invalidate("provider", Some("a"));
        finish.send(()).unwrap();
        assert!(matches!(task.await.unwrap(), Err(UsageError::Credentials(_))));
        assert!(cache.get(key("a"), false, || async { Ok(good()) }).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn transient_failure_keeps_last_good_without_pretending_to_be_success() {
        let cache = UsageCache::default();
        let original = cache.get(key("a"), false, || async { Ok(good()) }).await.unwrap();
        let result = cache.get(key("a"), true, || async { Err(UsageError::Unavailable("network failure".into())) }).await;
        let Err(UsageError::UnavailableWithData(snapshot)) = result else { panic!("expected explicit stale failure") };
        assert_eq!(snapshot["updated_at"], original["updated_at"]);
        assert_eq!(snapshot["stale"], true);
    }

    #[tokio::test]
    async fn cancelled_fetch_records_backoff_before_the_next_poll() {
        let cache = Arc::new(UsageCache::default());
        let (started, ready) = tokio::sync::oneshot::channel();
        let worker = cache.clone();
        let task = tokio::spawn(async move {
            worker
                .get(key("a"), false, || async {
                    started.send(()).unwrap();
                    std::future::pending::<Result<Value, UsageError>>().await
                })
                .await
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let result = cache.get(key("a"), true, || async { panic!("cancellation must back off before another upstream call") }).await;
        assert!(matches!(result, Err(UsageError::Unavailable(_))));
    }
}
