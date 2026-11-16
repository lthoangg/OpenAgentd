//! Span files into memory: which hourly files a window covers and their
//! signatures, the parse kept to what the queries read ([`SlimSpan`]), the
//! latest window's spans and turn index ([`SpanWindowCache`]), the per-bucket
//! answer cache, and handing it all back once the page goes idle.

use super::{num, TurnIndex};
use appv3_agent::hooks::otel::{OUTPUT_TPS_ATTR, TTFT_ATTR, WORKSPACE_ATTR};
use chrono::{DateTime, Duration, Utc};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// A parsed span, shared between a span file's parse and every window that
/// selects it.
type Span = Arc<Map<String, Value>>;

const CACHE_BUCKET_SECONDS: i64 = 5;
const CACHE_MAXSIZE: usize = 64;

pub(super) type Signatures = Vec<(String, u64, i128, u64)>;

fn spans_dir() -> PathBuf {
    appv3_core::settings().state_dir.join("otel").join("spans")
}

fn candidate_files(window_start: DateTime<Utc>) -> Vec<PathBuf> {
    let dir = spans_dir();
    if !dir.is_dir() {
        tracing::debug!("observability_spans_dir_missing path={}", dir.display());
        return vec![];
    }
    let cutoff = window_start.format("%Y-%m-%d-%H").to_string();
    let mut out: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    name.ends_with(".jsonl") && name.len() > ".jsonl".len() && name[..name.len() - 6] >= *cutoff
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

pub(super) fn cache_context(days: i64) -> (DateTime<Utc>, i64, String, Signatures) {
    let now = Utc::now();
    let mut sigs = vec![];
    for p in candidate_files(now - Duration::days(days)) {
        if let Ok(m) = std::fs::metadata(&p) {
            sigs.push((p.to_string_lossy().into_owned(), m.len(), mtime_ns(&m), inode(&m)));
        }
    }
    (now, now.timestamp().div_euclid(CACHE_BUCKET_SECONDS), spans_dir().to_string_lossy().into_owned(), sigs)
}

/// `st_mtime_ns`.
fn mtime_ns(m: &std::fs::Metadata) -> i128 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as i128).unwrap_or(0)
}

/// `st_ino`; 0 where the platform has no stable inode in std (Windows).
fn inode(_m: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        _m.ino()
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// A window bound in span `end_time` units (ns).
fn window_ns(d: DateTime<Utc>) -> f64 {
    ((d.timestamp() as f64 + d.timestamp_subsec_micros() as f64 / 1e6) * 1e9).trunc()
}

/// Where a loaded window's spans sit, by `end_time`: the latest span before
/// the window, the first and last span kept, and the earliest span after
/// it. Another window selects exactly the same spans while its start and
/// end stay between those.
#[derive(Debug, Clone, Copy)]
struct WindowBounds {
    before: f64,
    first: f64,
    last: f64,
    after: f64,
}

impl Default for WindowBounds {
    fn default() -> Self {
        Self { before: f64::NEG_INFINITY, first: f64::INFINITY, last: f64::NEG_INFINITY, after: f64::INFINITY }
    }
}

impl WindowBounds {
    fn selects_same(&self, start_ns: f64, end_ns: f64) -> bool {
        self.before < start_ns && start_ns <= self.first && self.last <= end_ns && end_ns < self.after
    }
}

/// Top-level span fields the queries read. `events` and the `resource`
/// block older files carry are skipped while parsing.
const SPAN_FIELDS: [&str; 10] = ["name", "trace_id", "span_id", "parent_id", "kind", "start_time", "end_time", "duration_ms", "status", "attributes"];

/// Span attributes the queries read; the others are skipped while parsing.
/// Trace detail shows every attribute, so it re-reads its spans whole
/// ([`reread_whole`]). Add a key here when a query starts reading it.
const READ_ATTRS: [&str; 15] = [
    "gen_ai.agent.name",
    "gen_ai.conversation.id",
    "gen_ai.operation.name",
    "gen_ai.provider.name",
    "gen_ai.request.model",
    "gen_ai.tool.name",
    "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.estimated_cost_usd",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "run_id",
    OUTPUT_TPS_ATTR,
    TTFT_ATTR,
    WORKSPACE_ATTR,
];

/// A span line with only [`SPAN_FIELDS`] and [`READ_ATTRS`]: the rest is
/// skipped by the parser, never allocated. A 90-day window holds hundreds of
/// thousands of spans.
struct SlimSpan(Map<String, Value>);

/// A map key as the matching entry of `keys`, `None` for any other; no
/// allocation either way.
fn known_key<'de, D: serde::Deserializer<'de>>(d: D, keys: &'static [&'static str]) -> Result<Option<&'static str>, D::Error> {
    struct V(&'static [&'static str]);
    impl serde::de::Visitor<'_> for V {
        type Value = Option<&'static str>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a string key")
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
            Ok(self.0.iter().find(|k| **k == v).copied())
        }
    }
    d.deserialize_str(V(keys))
}

/// A span key, `Some` when it is one of [`SPAN_FIELDS`].
struct SpanKey(Option<&'static str>);

impl<'de> serde::Deserialize<'de> for SpanKey {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(SpanKey(known_key(d, &SPAN_FIELDS)?))
    }
}

/// An attribute key, `Some` when it is one of [`READ_ATTRS`].
struct AttrKey(Option<&'static str>);

impl<'de> serde::Deserialize<'de> for AttrKey {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(AttrKey(known_key(d, &READ_ATTRS)?))
    }
}

/// `attributes`, keeping [`READ_ATTRS`] (a `null` stays `null`).
struct SlimAttrs(Value);

impl<'de> serde::Deserialize<'de> for SlimAttrs {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = SlimAttrs;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an attributes object")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<SlimAttrs, E> {
                Ok(SlimAttrs(Value::Null))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<SlimAttrs, A::Error> {
                let mut out = Map::new();
                while let Some(AttrKey(key)) = m.next_key()? {
                    match key {
                        Some(k) => {
                            out.insert(k.to_string(), m.next_value()?);
                        }
                        None => {
                            m.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(SlimAttrs(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}

impl<'de> serde::Deserialize<'de> for SlimSpan {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = SlimSpan;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a span object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<SlimSpan, A::Error> {
                let mut out = Map::new();
                while let Some(SpanKey(key)) = m.next_key()? {
                    match key {
                        Some("attributes") => {
                            out.insert("attributes".into(), m.next_value::<SlimAttrs>()?.0);
                        }
                        Some(k) => {
                            out.insert(k.to_string(), m.next_value()?);
                        }
                        None => {
                            m.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(SlimSpan(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// Every span in one file that has an `end_time`, with that time, kept to
/// what the queries read ([`SlimSpan`]).
fn parse_span_file(path: &std::path::Path) -> Vec<(f64, Span)> {
    let Ok(bytes) = std::fs::read(path) else { return vec![] };
    let mut out = vec![];
    for line in bytes.split(|b| *b == b'\n') {
        if line.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let Ok(SlimSpan(s)) = serde_json::from_slice::<SlimSpan>(line) else { continue };
        if let Some(et) = num(s.get("end_time")) {
            out.push((et, Arc::new(s)));
        }
    }
    out
}

fn select_window<'a>(files: impl IntoIterator<Item = &'a [(f64, Span)]>, window_start: DateTime<Utc>, window_end: DateTime<Utc>) -> (Vec<Span>, WindowBounds) {
    let (start_ns, end_ns) = (window_ns(window_start), window_ns(window_end));
    let mut spans = vec![];
    let mut bounds = WindowBounds::default();
    for &(et, ref s) in files.into_iter().flatten() {
        if et < start_ns {
            bounds.before = bounds.before.max(et);
        } else if et > end_ns {
            bounds.after = bounds.after.min(et);
        } else {
            bounds.first = bounds.first.min(et);
            bounds.last = bounds.last.max(et);
            spans.push(s.clone());
        }
    }
    (spans, bounds)
}

// ── cache ───────────────────────────────────────────────────────────────────

fn cache() -> &'static Mutex<IndexMap<String, Option<Value>>> {
    static C: OnceLock<Mutex<IndexMap<String, Option<Value>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(IndexMap::new()))
}

pub(super) fn cached(key: String, compute: impl FnOnce() -> Option<Value>) -> Option<Value> {
    {
        let mut c = cache().lock().unwrap();
        if let Some(idx) = c.get_index_of(&key) {
            let last = c.len() - 1;
            c.move_index(idx, last);
            return c[last].clone();
        }
    }
    let v = compute();
    let mut c = cache().lock().unwrap();
    c.insert(key, v.clone());
    while c.len() > CACHE_MAXSIZE {
        c.shift_remove_index(0);
    }
    v
}

pub(super) fn sig_key(kind: &str, parts: &[String], bucket: i64, dir: &str, sigs: &Signatures) -> String {
    json!([kind, parts, bucket, dir, sigs.iter().map(|(p, s, m, i)| json!([p, s, m.to_string(), i])).collect::<Vec<_>>()]).to_string()
}

// ── parsed span windows ─────────────────────────────────────────────────────

/// One window's parsed spans and their turn index. A page's summary, trace
/// list and trace detail, and every filter change, read the same window, so
/// the span files are parsed once per change instead of once per request
/// (`cached` above only short-cuts identical requests).
pub(super) struct SpanWindow {
    key: String,
    bounds: WindowBounds,
    pub(super) spans: Vec<Span>,
    pub(super) index: TurnIndex,
}

/// One span file's parse, valid while its `(size, mtime_ns, inode)` holds.
struct ParsedFile {
    sig: (u64, i128, u64),
    spans: Arc<Vec<(f64, Span)>>,
}

/// Span files parsed earlier but outside the latest window (switching 90d →
/// 7d → 90d), kept up to this many bytes of source; the oldest hours go first.
const MAX_OUTSIDE_WINDOW_BYTES: u64 = 300 * 1024 * 1024;

/// With no telemetry request for this long, everything parsed is dropped:
/// a 90-day window holds hundreds of MB.
const IDLE_RELEASE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// The latest window, plus the parse of each file read so far. While an
/// agent runs only the live hour's file changes, so a new window re-reads
/// that file and reuses the rest; switching between ranges re-reads nothing
/// (see [`MAX_OUTSIDE_WINDOW_BYTES`]).
#[derive(Default)]
struct SpanCacheState {
    window: Option<Arc<SpanWindow>>,
    files: HashMap<String, ParsedFile>,
    last_used: Option<std::time::Instant>,
}

#[derive(Default)]
pub(super) struct SpanWindowCache(Mutex<SpanCacheState>);

/// Drop the parsed files outside `window` (paths) beyond `cap` bytes of
/// source, oldest hour (smallest name) first.
fn trim_outside_window(files: &mut HashMap<String, ParsedFile>, window: &std::collections::HashSet<&str>, cap: u64) {
    let mut outside: Vec<(String, u64)> = files.iter().filter(|(p, _)| !window.contains(p.as_str())).map(|(p, f)| (p.clone(), f.sig.0)).collect();
    outside.sort();
    let mut total: u64 = outside.iter().map(|(_, n)| n).sum();
    for (path, size) in outside {
        if total <= cap {
            break;
        }
        files.remove(&path);
        total -= size;
    }
}

impl SpanWindowCache {
    pub(super) fn get(&self, dir: &str, sigs: &Signatures, start: DateTime<Utc>, end: DateTime<Utc>) -> Arc<SpanWindow> {
        use rayon::prelude::*;
        let key = sig_key("spans", &[], 0, dir, sigs);
        // Held while loading, so requests sent together wait for one parse
        // instead of each starting their own.
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.last_used = Some(std::time::Instant::now());
        if let Some(w) = state.window.as_ref().filter(|w| w.key == key && w.bounds.selects_same(window_ns(start), window_ns(end))) {
            return w.clone();
        }
        // Files new or changed since their parse, parsed side by side.
        let stale: Vec<&String> = sigs.iter().filter(|(p, size, mtime, ino)| state.files.get(p).is_none_or(|f| f.sig != (*size, *mtime, *ino))).map(|(p, ..)| p).collect();
        let fresh: Vec<Arc<Vec<(f64, Span)>>> = stale.par_iter().map(|p| Arc::new(parse_span_file(std::path::Path::new(p.as_str())))).collect();
        for (path, spans) in stale.into_iter().zip(fresh) {
            let (_, size, mtime, ino) = sigs.iter().find(|(p, ..)| p == path).unwrap();
            state.files.insert(path.clone(), ParsedFile { sig: (*size, *mtime, *ino), spans });
        }
        let parsed: Vec<Arc<Vec<(f64, Span)>>> = sigs.iter().filter_map(|(p, ..)| state.files.get(p).map(|f| f.spans.clone())).collect();
        let (spans, bounds) = select_window(parsed.iter().map(|f| f.as_slice()), start, end);
        let window = Arc::new(SpanWindow { key, bounds, index: TurnIndex::build(&spans), spans });
        state.window = Some(window.clone());
        let in_window: std::collections::HashSet<&str> = sigs.iter().map(|(p, ..)| p.as_str()).collect();
        trim_outside_window(&mut state.files, &in_window, MAX_OUTSIDE_WINDOW_BYTES);
        window
    }

    /// Drop everything when unused for `idle`; `true` when it did.
    fn release_if_idle(&self, idle: std::time::Duration) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.last_used.is_none_or(|t| t.elapsed() < idle) {
            return false;
        }
        *state = SpanCacheState::default();
        true
    }
}

pub(super) fn span_windows() -> &'static SpanWindowCache {
    static C: OnceLock<SpanWindowCache> = OnceLock::new();
    C.get_or_init(|| {
        let _ = std::thread::Builder::new().name("oad-telemetry-idle".into()).spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if span_windows().release_if_idle(IDLE_RELEASE) {
                cache().lock().unwrap().clear();
                release_freed_memory();
                tracing::debug!("telemetry_cache_released idle_s={}", IDLE_RELEASE.as_secs());
            }
        });
        SpanWindowCache::default()
    })
}

/// Hand freed heap pages back to the OS now, so the process's footprint
/// drops with the cache instead of whenever the allocator gets to it.
fn release_freed_memory() {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: a null zone means every zone; a goal of 0 releases all it can.
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        // SAFETY: glibc's `malloc_trim` only returns free memory to the OS.
        unsafe {
            malloc_trim(0);
        }
    }
}

#[cfg(test)]
mod tests;
