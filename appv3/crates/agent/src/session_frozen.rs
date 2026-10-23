//! Prompt text frozen for a session's lifetime.
//!
//! The tools block and the system prompt open the cached prompt prefix: one
//! changed byte there re-sends the whole context at full price. Text read
//! from disk (`AGENTS.md`, the skills list) is therefore read on a session's
//! first call and reused for the rest of it; edits apply to the next session.
//!
//! Keyed by session id rather than stored on `AgentSession` because the
//! readers (per-turn hooks, tool definitions, `/btw` frame rebuilds) only
//! see the id.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

/// Sessions live in memory far fewer at a time than this; the oldest entry
/// goes first when it is exceeded.
const MAX_ENTRIES: usize = 2048;

#[derive(Default)]
struct Store {
    values: HashMap<String, String>,
    order: VecDeque<String>,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// `key`'s value for `session_id`, computed by `compute` on first use and
/// reused afterwards. Without a session there is nothing to freeze, so
/// `compute` runs every time.
pub fn get_or_freeze(session_id: Option<&str>, key: &str, compute: impl FnOnce() -> String) -> String {
    let Some(sid) = session_id.filter(|s| !s.is_empty()) else { return compute() };
    let k = format!("{sid}\u{0}{key}");
    if let Some(v) = store().lock().unwrap().values.get(&k) {
        return v.clone();
    }
    // Computed unlocked: it reads files. Two racing first calls both
    // compute; the first stored value wins so they agree afterwards.
    let value = compute();
    let mut s = store().lock().unwrap();
    if let Some(v) = s.values.get(&k) {
        return v.clone();
    }
    if s.order.len() >= MAX_ENTRIES {
        if let Some(old) = s.order.pop_front() {
            s.values.remove(&old);
        }
    }
    s.order.push_back(k.clone());
    s.values.insert(k, value.clone());
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_keeps_its_first_value() {
        let sid = format!("frozen-{}", uuid::Uuid::new_v4());
        assert_eq!(get_or_freeze(Some(&sid), "k", || "one".into()), "one");
        assert_eq!(get_or_freeze(Some(&sid), "k", || "two".into()), "one");
        assert_eq!(get_or_freeze(Some(&format!("{sid}-other")), "k", || "two".into()), "two");
        assert_eq!(get_or_freeze(Some(&sid), "other key", || "three".into()), "three");
    }

    #[test]
    fn without_a_session_nothing_is_frozen() {
        assert_eq!(get_or_freeze(None, "k", || "one".into()), "one");
        assert_eq!(get_or_freeze(None, "k", || "two".into()), "two");
    }
}
