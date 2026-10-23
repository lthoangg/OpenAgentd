//! Rate limit for upstream connection errors. A preview tab whose dev
//! server stopped keeps reconnecting (Vite's client pings about once a
//! second), which wrote ~8k identical log lines in three days.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Throttle {
    /// Per upstream authority: when it was last logged, and errors since.
    last: HashMap<String, (Instant, u64)>,
}

impl Throttle {
    /// `Some(suppressed)` when an error for `key` should be logged now,
    /// with the number of errors skipped since the last logged one.
    fn check(&mut self, key: &str, now: Instant) -> Option<u64> {
        match self.last.get_mut(key) {
            Some((at, skipped)) if now.duration_since(*at) < WINDOW => {
                *skipped += 1;
                None
            }
            Some((at, skipped)) => {
                let n = *skipped;
                *at = now;
                *skipped = 0;
                Some(n)
            }
            None => {
                self.last.insert(key.to_string(), (now, 0));
                Some(0)
            }
        }
    }
}

/// Whether to log an upstream error for `authority` (`host:port`) now, and
/// how many were skipped before it.
pub(crate) fn upstream_error(authority: &str) -> Option<u64> {
    static T: OnceLock<Mutex<Throttle>> = OnceLock::new();
    T.get_or_init(Default::default).lock().unwrap().check(authority, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_once_a_minute_per_upstream_and_counts_the_rest() {
        let mut t = Throttle::default();
        let t0 = Instant::now();
        assert_eq!(t.check("localhost:5173", t0), Some(0));
        assert_eq!(t.check("localhost:5173", t0 + Duration::from_secs(1)), None);
        assert_eq!(t.check("localhost:5173", t0 + Duration::from_secs(2)), None);
        assert_eq!(t.check("localhost:5174", t0 + Duration::from_secs(2)), Some(0), "another dev server is logged on its own");
        assert_eq!(t.check("localhost:5173", t0 + Duration::from_secs(61)), Some(2));
    }
}
