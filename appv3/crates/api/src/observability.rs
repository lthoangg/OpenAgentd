//! Port of `app/services/observability_service.py` — aggregate the OTEL span
//! JSONL files (`{STATE_DIR}/otel/spans/YYYY-MM-DD-HH.jsonl`) into the
//! observability page payloads.
//!
//! Results are memoised per 5 s bucket + file signatures `(path, size,
//! mtime_ns, inode)` exactly like v2's `lru_cache` wrappers, so repeated
//! calls inside one bucket return the same window.
//! v3 also keeps the latest window's parsed spans and turn index (see
//! `SpanWindowCache`), so filter changes and the page's other requests
//! reuse one parse until a span file changes.
//!
//! v3 additions (not in v2): workspace / model filters, `by_workspace`,
//! filter `facets`, per-day cost, and `workspace` on trace rows. Filters
//! apply per turn — a span belongs to the workspace and model of the
//! `agent_run` span in its trace — so every aggregate stays consistent.
//! A span's workspace is, in order: its turn's, its own
//! (`openagentd.workspace` on chat / tool / summarization spans), one
//! another span in its trace carries, then its session's — from spans in
//! the window, else from the database (`KnownWorkspaces`). The fallbacks
//! cover traces without an `agent_run` span (a turn still running;
//! compaction and failed runs recorded before v3.21) and turns recorded
//! before spans carried a workspace.
//! Also v3: a `session` filter and the `by_session` breakdown, under the
//! same per-turn rule (spans outside a run use their own conversation id
//! and their own `provider:model`). The session filter is a set: the route
//! adds the selected session's sub-agent sessions.
//! Also v3: streaming speed from `chat` spans — time to first chunk
//! (`latency_ms.ttft_*`, `by_model[].ttft_p50_ms`) and output tokens per
//! second (`output_tps`, `by_model[].output_tps_p50`). Calls recorded
//! before spans carried them count as calls but not as samples.

use appv3_agent::hooks::otel::{OUTPUT_TPS_ATTR, TTFT_ATTR, WORKSPACE_ATTR};
use appv3_core::pymath::py_round;
use chrono::{DateTime, Duration, TimeZone, Utc};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

/// A parsed span, shared between a span file's parse and every window that
/// selects it.
type Span = Arc<Map<String, Value>>;

const CACHE_BUCKET_SECONDS: i64 = 5;
const CACHE_MAXSIZE: usize = 64;
/// Conversation id the OTEL hook records for runs outside a session.
const NO_SESSION: &str = "no-session";
/// `by_session` keeps the top sessions by spend; the rest stay reachable
/// through the session filter.
const BY_SESSION_LIMIT: usize = 100;

type Signatures = Vec<(String, u64, i128, u64)>;

/// Optional narrowing for the summary and trace list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Filters {
    /// Workspace root, exactly as recorded on the `agent_run` span.
    pub workspace: Option<String>,
    /// `provider:model`, as in `by_model[].provider_model`.
    pub model: Option<String>,
    /// Session ids, as recorded in `gen_ai.conversation.id`: the selected
    /// session plus its sub-agent sessions.
    pub sessions: Option<BTreeSet<String>>,
}

impl Filters {
    fn is_empty(&self) -> bool {
        self.workspace.is_none() && self.model.is_none() && self.sessions.is_none()
    }

    fn key_parts(&self) -> [String; 3] {
        let sessions = self.sessions.as_ref().map(|ids| ids.iter().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default();
        [self.workspace.clone().unwrap_or_default(), self.model.clone().unwrap_or_default(), sessions]
    }
}

fn spans_dir() -> PathBuf {
    appv3_core::settings().state_dir.join("otel").join("spans")
}

/// `datetime.isoformat()` for an aware UTC datetime.
pub fn py_iso(dt: DateTime<Utc>) -> String {
    if dt.timestamp_subsec_micros() == 0 {
        dt.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        dt.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    }
}

/// Python-truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => {
            let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
            let mut out = String::from(q);
            for c in s.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if c == q => {
                        out.push('\\');
                        out.push(c);
                    }
                    c => out.push(c),
                }
            }
            out.push(q);
            out
        }
        other => py_str(other),
    }
}

/// Python `str(value)` for a JSON-decoded value.
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => appv3_core::pyjson::float_repr(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => s.clone(),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", py_repr(&json!(k)), py_repr(v))).collect::<Vec<_>>().join(", ")),
    }
}

/// `_safe_int`.
fn safe_int(v: Option<&Value>) -> i64 {
    match v {
        None | Some(Value::Null) => 0,
        Some(Value::Bool(b)) => *b as i64,
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().replace('_', "").parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// `_safe_float`.
fn safe_float(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => *b as i64 as f64,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => {
            let t = s.trim().to_ascii_lowercase();
            match t.as_str() {
                "nan" | "+nan" | "-nan" => f64::NAN,
                "inf" | "+inf" | "infinity" | "+infinity" => f64::INFINITY,
                "-inf" | "-infinity" => f64::NEG_INFINITY,
                _ => t.replace('_', "").parse::<f64>().unwrap_or(0.0),
            }
        }
        _ => 0.0,
    }
}

/// Numeric view of a JSON number for comparisons / `x or 0`.
fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(*b as i64 as f64),
        _ => None,
    }
}

/// `x or 0` for an ns timestamp, as an integer when it is one.
fn ns_or_zero(v: Option<&Value>) -> Value {
    match v {
        Some(val) if truthy(val) => val.clone(),
        _ => json!(0),
    }
}

/// `int(ns // 1_000_000)`.
fn ns_to_ms(v: &Value) -> i64 {
    match v {
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.div_euclid(1_000_000),
            None => match n.as_u64() {
                Some(u) => (u / 1_000_000) as i64,
                None => (n.as_f64().unwrap_or(0.0) / 1_000_000.0).floor() as i64,
            },
        },
        Value::Bool(b) => (*b as i64).div_euclid(1_000_000),
        _ => 0,
    }
}

fn percent(part: f64, total: f64) -> f64 {
    if total <= 0.0 {
        return 0.0;
    }
    py_round(part / total * 100.0, 1)
}

fn quantile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let n = v.len();
    if n == 1 {
        return v[0];
    }
    let idx = (n - 1) as f64 * q;
    let i = idx as usize;
    let frac = idx - i as f64;
    if i + 1 < n {
        v[i] + frac * (v[i + 1] - v[i])
    } else {
        v[i]
    }
}

fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
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

fn cache_context(days: i64) -> (DateTime<Utc>, i64, String, Signatures) {
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

/// Every span in one file that has an `end_time`, with that time.
fn parse_span_file(path: &std::path::Path) -> Vec<(f64, Span)> {
    let Ok(bytes) = std::fs::read(path) else { return vec![] };
    let mut out = vec![];
    for line in bytes.split(|b| *b == b'\n') {
        if line.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let Ok(Value::Object(s)) = serde_json::from_slice::<Value>(line) else { continue };
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

fn attrs_of(s: &Map<String, Value>) -> &Map<String, Value> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    match s.get("attributes") {
        Some(Value::Object(m)) => m,
        _ => &EMPTY,
    }
}

fn str_or(v: Option<&Value>, default: &str) -> String {
    match v {
        Some(x) if truthy(x) => py_str(x),
        _ => default.to_string(),
    }
}

fn is_run_span(s: &Map<String, Value>) -> bool {
    str_or(s.get("name"), "").starts_with("agent_run")
}

fn trace_id_of(s: &Map<String, Value>) -> Option<String> {
    s.get("trace_id").filter(|v| truthy(v)).map(py_str)
}

/// `provider:model` of a turn, with the same `unknown` fallbacks as `by_model`.
fn turn_model(attrs: &Map<String, Value>) -> String {
    format!("{}:{}", str_or(attrs.get("gen_ai.provider.name"), "unknown"), str_or(attrs.get("gen_ai.request.model"), "unknown"))
}

fn workspace_attr(attrs: &Map<String, Value>) -> Option<String> {
    attrs.get(WORKSPACE_ATTR).filter(|v| truthy(v)).map(py_str)
}

fn conversation_attr(attrs: &Map<String, Value>) -> Option<String> {
    attrs.get("gen_ai.conversation.id").filter(|v| truthy(v)).map(py_str)
}

/// UTC day (`YYYY-MM-DD`) of a span's end time.
fn end_day(s: &Map<String, Value>) -> Option<String> {
    let et = s.get("end_time").filter(|v| truthy(v)).and_then(|v| num(Some(v)))?;
    let secs = et / 1e9;
    let dt = Utc.timestamp_opt(secs.floor() as i64, ((secs - secs.floor()) * 1e9) as u32).single().unwrap_or_default();
    Some(dt.format("%Y-%m-%d").to_string())
}

struct TurnKey {
    model: String,
    workspace: Option<String>,
    session: Option<String>,
    agent: Option<String>,
}

/// Session id (stored hex form, see `appv3_db::codec::db_id`) → workspace,
/// from the database. Fills in spans that name a session but no
/// workspace (turns recorded before spans carried one).
pub type KnownWorkspaces = HashMap<String, String>;

/// Per-trace turn identity, built from the `agent_run` spans in a window,
/// plus what any span in a trace says about its session and workspace, for
/// traces without a run span (a turn still running, compaction runs and
/// failed runs recorded before v3.21, title generation outside a run).
#[derive(Default)]
struct TurnIndex {
    by_trace: HashMap<String, TurnKey>,
    /// The first session any span in the trace names.
    trace_session: HashMap<String, String>,
    /// The first workspace any span in the trace carries.
    trace_workspace: HashMap<String, String>,
    session_workspace: HashMap<String, String>,
}

impl TurnIndex {
    fn build<S: Borrow<Map<String, Value>>>(spans: &[S]) -> Self {
        let mut index = Self::default();
        for s in spans.iter().map(Borrow::borrow) {
            let Some(tid) = trace_id_of(s) else { continue };
            let attrs = attrs_of(s);
            let workspace = workspace_attr(attrs);
            let session = conversation_attr(attrs);
            let named = session.as_ref().filter(|id| *id != NO_SESSION);
            if let Some(conv) = named {
                index.trace_session.entry(tid.clone()).or_insert_with(|| conv.clone());
            }
            if let Some(ws) = &workspace {
                index.trace_workspace.entry(tid.clone()).or_insert_with(|| ws.clone());
                if let Some(conv) = named {
                    index.session_workspace.insert(conv.clone(), ws.clone());
                }
            }
            if !is_run_span(s) {
                continue;
            }
            let agent = attrs.get("gen_ai.agent.name").filter(|v| truthy(v)).map(py_str);
            index.by_trace.insert(tid, TurnKey { model: turn_model(attrs), workspace, session, agent });
        }
        index
    }

    fn turn(&self, s: &Map<String, Value>) -> Option<&TurnKey> {
        trace_id_of(s).and_then(|tid| self.by_trace.get(&tid))
    }
}

/// A window's [`TurnIndex`] plus the database's session workspaces: who
/// each span belongs to.
struct Resolver<'a> {
    index: &'a TurnIndex,
    known: &'a KnownWorkspaces,
}

impl Resolver<'_> {
    fn turn(&self, s: &Map<String, Value>) -> Option<&TurnKey> {
        self.index.turn(s)
    }

    /// The turn's workspace, else the span's own, else one another span
    /// in its trace carries, else its session's (from spans, then from
    /// the database).
    fn workspace_of(&self, s: &Map<String, Value>) -> Option<String> {
        if let Some(ws) = self.turn(s).and_then(|t| t.workspace.clone()).or_else(|| workspace_attr(attrs_of(s))) {
            return Some(ws);
        }
        if let Some(ws) = trace_id_of(s).and_then(|tid| self.index.trace_workspace.get(&tid)) {
            return Some(ws.clone());
        }
        let conv = self.session_of(s).filter(|id| id != NO_SESSION)?;
        self.index.session_workspace.get(&conv).or_else(|| self.known.get(&appv3_db::codec::db_id(&conv))).cloned()
    }

    /// The turn's session, else the span's own (title generation runs
    /// outside the turn's trace), else one another span in its trace
    /// names (a summarization LLM call recorded before it carried one).
    fn session_of(&self, s: &Map<String, Value>) -> Option<String> {
        match self.turn(s) {
            Some(t) => t.session.clone(),
            None => conversation_attr(attrs_of(s)).or_else(|| trace_id_of(s).and_then(|tid| self.index.trace_session.get(&tid).cloned())),
        }
    }

    /// The turn's model, else the span's own `provider:model` (title
    /// generation often runs on a different model, outside the turn), so a
    /// `by_model` row filters to the spans it counted.
    fn model_of(&self, s: &Map<String, Value>) -> String {
        match self.turn(s) {
            Some(t) => t.model.clone(),
            None => turn_model(attrs_of(s)),
        }
    }

    fn matches(&self, s: &Map<String, Value>, f: &Filters) -> bool {
        if let Some(model) = &f.model {
            if self.model_of(s) != *model {
                return false;
            }
        }
        if let Some(sessions) = &f.sessions {
            if !self.session_of(s).is_some_and(|id| sessions.contains(&id)) {
                return false;
            }
        }
        match &f.workspace {
            Some(ws) => self.workspace_of(s).as_ref() == Some(ws),
            None => true,
        }
    }
}

fn apply_filters<'a, S: Borrow<Map<String, Value>>>(spans: &'a [S], r: &Resolver, f: &Filters) -> Vec<&'a Map<String, Value>> {
    let spans = spans.iter().map(Borrow::borrow);
    if f.is_empty() {
        return spans.collect();
    }
    spans.filter(|s| r.matches(s, f)).collect()
}

/// Filter options for the whole window, independent of the active filters,
/// most-used first. Workspaces are each turn's resolved workspace, so a
/// turn attributed through its session can be filtered to.
fn facets<S: Borrow<Map<String, Value>>>(spans: &[S], r: &Resolver) -> Value {
    let mut workspaces: IndexMap<String, i64> = IndexMap::new();
    let mut models: IndexMap<String, i64> = IndexMap::new();
    for s in spans.iter().map(Borrow::borrow).filter(|s| is_run_span(s)) {
        let attrs = attrs_of(s);
        if let Some(ws) = r.workspace_of(s) {
            *workspaces.entry(ws).or_default() += 1;
        }
        *models.entry(turn_model(attrs)).or_default() += 1;
    }
    let ranked = |m: IndexMap<String, i64>| {
        let mut v: Vec<(String, i64)> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.into_iter().map(|(k, _)| k).collect::<Vec<_>>()
    };
    json!({"workspaces": ranked(workspaces), "models": ranked(models)})
}

// ── cache ───────────────────────────────────────────────────────────────────

fn cache() -> &'static Mutex<IndexMap<String, Option<Value>>> {
    static C: OnceLock<Mutex<IndexMap<String, Option<Value>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(IndexMap::new()))
}

fn cached(key: String, compute: impl FnOnce() -> Option<Value>) -> Option<Value> {
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

fn sig_key(kind: &str, parts: &[String], bucket: i64, dir: &str, sigs: &Signatures) -> String {
    json!([kind, parts, bucket, dir, sigs.iter().map(|(p, s, m, i)| json!([p, s, m.to_string(), i])).collect::<Vec<_>>()]).to_string()
}

// ── parsed span windows ─────────────────────────────────────────────────────

/// One window's parsed spans and their turn index. A page's summary, trace
/// list and trace detail, and every filter change, read the same window, so
/// the span files are parsed once per change instead of once per request
/// (`cached` above only short-cuts identical requests).
struct SpanWindow {
    key: String,
    bounds: WindowBounds,
    spans: Vec<Span>,
    index: TurnIndex,
}

/// One span file's parse, valid while its `(size, mtime_ns, inode)` holds.
struct ParsedFile {
    sig: (u64, i128, u64),
    spans: Arc<Vec<(f64, Span)>>,
}

/// The latest window, plus the parse of each file it read. While an agent
/// runs only the live hour's file changes, so a new window re-reads that
/// file and reuses the rest. Files outside the latest window are dropped,
/// so what is held stays bounded to one window's files.
#[derive(Default)]
struct SpanCacheState {
    window: Option<Arc<SpanWindow>>,
    files: HashMap<String, ParsedFile>,
}

#[derive(Default)]
struct SpanWindowCache(Mutex<SpanCacheState>);

impl SpanWindowCache {
    fn get(&self, dir: &str, sigs: &Signatures, start: DateTime<Utc>, end: DateTime<Utc>) -> Arc<SpanWindow> {
        let key = sig_key("spans", &[], 0, dir, sigs);
        // Held while loading, so requests sent together wait for one parse
        // instead of each starting their own.
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = state.window.as_ref().filter(|w| w.key == key && w.bounds.selects_same(window_ns(start), window_ns(end))) {
            return w.clone();
        }
        let mut parsed = Vec::with_capacity(sigs.len());
        let mut files = HashMap::with_capacity(sigs.len());
        for (path, size, mtime, ino) in sigs {
            let sig = (*size, *mtime, *ino);
            let spans = match state.files.remove(path) {
                Some(f) if f.sig == sig => f.spans,
                _ => Arc::new(parse_span_file(std::path::Path::new(path))),
            };
            parsed.push(spans.clone());
            files.insert(path.clone(), ParsedFile { sig, spans });
        }
        let (spans, bounds) = select_window(parsed.iter().map(|f| f.as_slice()), start, end);
        let window = Arc::new(SpanWindow { key, bounds, index: TurnIndex::build(&spans), spans });
        *state = SpanCacheState { window: Some(window.clone()), files };
        window
    }
}

fn span_windows() -> &'static SpanWindowCache {
    static C: OnceLock<SpanWindowCache> = OnceLock::new();
    C.get_or_init(SpanWindowCache::default)
}

// ── summary ─────────────────────────────────────────────────────────────────

fn empty_summary(start: DateTime<Utc>, end: DateTime<Utc>) -> Value {
    let mut v = summary_json(start, end, Totals::default(), [0.0; 6], [0.0; 2], Breakdowns::default());
    v["facets"] = json!({"workspaces": [], "models": []});
    v
}

#[derive(Default)]
struct Totals {
    turns: i64,
    llm_calls: i64,
    tool_calls: i64,
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
    cost: f64,
    errors: i64,
}

/// The ranked per-dimension tables of a summary.
#[derive(Default)]
struct Breakdowns {
    daily: Vec<Value>,
    by_model: Vec<Value>,
    by_step: Vec<Value>,
    by_tool: Vec<Value>,
    by_workspace: Vec<Value>,
    by_session: Vec<Value>,
}

/// `lat`: turn, LLM-call and time-to-first-chunk p50/p95 (ms); `tps`:
/// output tokens per second p50 and p5 (the slow tail).
fn summary_json(start: DateTime<Utc>, end: DateTime<Utc>, t: Totals, lat: [f64; 6], tps: [f64; 2], b: Breakdowns) -> Value {
    json!({
        "window_start": py_iso(start),
        "window_end": py_iso(end),
        "sample_ratio": appv3_core::otel::sample_ratio(),
        "totals": {
            "turns": t.turns,
            "llm_calls": t.llm_calls,
            "tool_calls": t.tool_calls,
            "input_tokens": t.input,
            "output_tokens": t.output,
            "cached_tokens": t.cached,
            "cache_write_tokens": t.cache_write,
            "cache_percent": percent(t.cached as f64, t.input as f64),
            "estimated_cost_usd": t.cost,
            "errors": t.errors,
        },
        "latency_ms": {"turn_p50": lat[0], "turn_p95": lat[1], "llm_p50": lat[2], "llm_p95": lat[3], "ttft_p50": lat[4], "ttft_p95": lat[5]},
        "output_tps": {"p50": tps[0], "p5": tps[1]},
        "daily_turns": b.daily,
        "by_model": b.by_model,
        "cache_by_step": b.by_step,
        "by_tool": b.by_tool,
        "by_workspace": b.by_workspace,
        "by_session": b.by_session,
    })
}

#[derive(Default)]
struct ModelAgg {
    calls: i64,
    in_tok: i64,
    out_tok: i64,
    cached_tok: i64,
    cache_write_tok: i64,
    cost: f64,
    durations: Vec<f64>,
    ttfts: Vec<f64>,
    tps: Vec<f64>,
}

#[derive(Default)]
struct ToolAgg {
    calls: i64,
    errors: i64,
    durations: Vec<f64>,
}

#[derive(Default)]
struct DayAgg {
    turns: i64,
    errors: i64,
    cost: f64,
}

#[derive(Default)]
struct WorkspaceAgg {
    turns: i64,
    errors: i64,
    input: i64,
    output: i64,
    cost: f64,
}

#[derive(Default)]
struct SessionAgg {
    turns: i64,
    errors: i64,
    input: i64,
    output: i64,
    cached: i64,
    cost: f64,
    last_active_ms: i64,
    /// From the session's latest turn.
    last_turn_ms: i64,
    workspace: Option<String>,
    model: Option<String>,
    agent: Option<String>,
}

fn run_queries(spans: &[&Map<String, Value>], index: &Resolver, start: DateTime<Utc>, end: DateTime<Utc>) -> Value {
    if spans.is_empty() {
        return empty_summary(start, end);
    }
    let mut t = Totals::default();
    let mut turn_d = vec![];
    let mut llm_d = vec![];
    let mut ttft_d = vec![];
    let mut tps_d = vec![];
    let mut daily: IndexMap<String, DayAgg> = IndexMap::new();
    let mut models: IndexMap<(String, String), ModelAgg> = IndexMap::new();
    let mut steps: IndexMap<(String, String, String), ModelAgg> = IndexMap::new();
    let mut tools: IndexMap<String, ToolAgg> = IndexMap::new();
    // `None` collects spans no workspace could be resolved for (turns
    // recorded before workspaces were, of sessions no longer on record).
    let mut workspaces: IndexMap<Option<String>, WorkspaceAgg> = IndexMap::new();
    let mut sessions: IndexMap<String, SessionAgg> = IndexMap::new();

    for &s in spans {
        let name = str_or(s.get("name"), "");
        let is_error = s.get("status").and_then(|v| v.as_str()) == Some("ERROR");
        let dur = safe_float(s.get("duration_ms"));
        let attrs = attrs_of(s);
        let is_run = name.starts_with("agent_run");
        let is_chat = name.starts_with("chat");
        let is_tool = name.starts_with("execute_tool");
        let end_ms = ns_to_ms(&ns_or_zero(s.get("end_time")));
        let mut session = index.session_of(s).filter(|id| id != NO_SESSION).map(|id| sessions.entry(id).or_default());
        if let Some(agg) = session.as_mut() {
            agg.last_active_ms = agg.last_active_ms.max(end_ms);
        }
        if is_error {
            t.errors += 1;
        }
        if is_run {
            t.turns += 1;
            turn_d.push(dur);
            if let Some(day) = end_day(s) {
                let e = daily.entry(day).or_default();
                e.turns += 1;
                if is_error {
                    e.errors += 1;
                }
            }
            let w = workspaces.entry(index.workspace_of(s)).or_default();
            w.turns += 1;
            if is_error {
                w.errors += 1;
            }
            if let Some(agg) = session.as_mut() {
                agg.turns += 1;
                if is_error {
                    agg.errors += 1;
                }
                if end_ms >= agg.last_turn_ms {
                    agg.last_turn_ms = end_ms;
                    let turn = index.turn(s);
                    agg.workspace = index.workspace_of(s);
                    agg.model = turn.map(|t| t.model.clone());
                    agg.agent = turn.and_then(|t| t.agent.clone());
                }
            }
        } else {
            if is_chat {
                t.llm_calls += 1;
                llm_d.push(dur);
            } else if is_tool {
                t.tool_calls += 1;
            }
            let ttft_ms = num(attrs.get(TTFT_ATTR)).map(|s| s * 1000.0);
            let tps = num(attrs.get(OUTPUT_TPS_ATTR));
            ttft_d.extend(ttft_ms);
            tps_d.extend(tps);
            let it = safe_int(attrs.get("gen_ai.usage.input_tokens"));
            let ot = safe_int(attrs.get("gen_ai.usage.output_tokens"));
            let ct = safe_int(attrs.get("gen_ai.usage.cache_read.input_tokens"));
            let cw = safe_int(attrs.get("gen_ai.usage.cache_creation.input_tokens"));
            let cost = safe_float(attrs.get("gen_ai.usage.estimated_cost_usd"));
            t.input += it;
            t.output += ot;
            t.cached += ct;
            t.cache_write += cw;
            t.cost += cost;
            if cost != 0.0 {
                if let Some(day) = end_day(s) {
                    daily.entry(day).or_default().cost += cost;
                }
            }
            if it != 0 || ot != 0 || cost != 0.0 {
                let w = workspaces.entry(index.workspace_of(s)).or_default();
                w.input += it;
                w.output += ot;
                w.cost += cost;
            }
            if let Some(agg) = session.as_mut() {
                agg.input += it;
                agg.output += ot;
                agg.cached += ct;
                agg.cost += cost;
            }
            let provider = str_or(attrs.get("gen_ai.provider.name"), "unknown");
            let model = str_or(attrs.get("gen_ai.request.model"), "unknown");
            if attrs.contains_key("gen_ai.usage.input_tokens") || attrs.contains_key("gen_ai.usage.output_tokens") {
                let m = models.entry((provider.clone(), model.clone())).or_default();
                m.calls += 1;
                m.in_tok += it;
                m.out_tok += ot;
                m.cached_tok += ct;
                m.cache_write_tok += cw;
                m.cost += cost;
                m.durations.push(dur);
                m.ttfts.extend(ttft_ms);
                m.tps.extend(tps);
            }
            if attrs.contains_key("gen_ai.usage.input_tokens") || attrs.contains_key("gen_ai.usage.cache_read.input_tokens") {
                let step = match attrs.get("gen_ai.operation.name").filter(|v| truthy(v)) {
                    Some(op) => py_str(op),
                    None if name.starts_with("summarization") => "summarization".into(),
                    None if name.starts_with("title_generation") => "title_generation".into(),
                    None if name.starts_with("chat") => "chat".into(),
                    None => name.clone(),
                };
                let e = steps.entry((step, provider, model)).or_default();
                e.calls += 1;
                e.in_tok += it;
                e.cached_tok += ct;
                e.cache_write_tok += cw;
                e.cost += cost;
            }
        }
        if is_tool {
            let e = tools.entry(str_or(attrs.get("gen_ai.tool.name"), "unknown")).or_default();
            e.calls += 1;
            if is_error {
                e.errors += 1;
            }
            e.durations.push(dur);
        }
    }

    let mut daily_v: Vec<(String, DayAgg)> = daily.into_iter().collect();
    daily_v.sort_by(|a, b| a.0.cmp(&b.0));
    let daily_turns = daily_v.into_iter().map(|(day, d)| json!({"day": day, "turns": d.turns, "errors": d.errors, "estimated_cost_usd": py_round(d.cost, 8)})).collect();

    let mut mv: Vec<_> = models.into_iter().collect();
    mv.sort_by(|a, b| cmp_f64(b.1.cost, a.1.cost).then(b.1.calls.cmp(&a.1.calls)));
    let by_model = mv
        .into_iter()
        .map(|((p, m), d)| {
            json!({
                "provider": p, "model": m, "provider_model": format!("{p}:{m}"),
                "calls": d.calls, "input_tokens": d.in_tok, "output_tokens": d.out_tok,
                "cached_tokens": d.cached_tok, "cache_write_tokens": d.cache_write_tok,
                "cache_percent": percent(d.cached_tok as f64, d.in_tok as f64),
                "estimated_cost_usd": py_round(d.cost, 8),
                "p95_ms": py_round(quantile(&d.durations, 0.95), 1),
                "ttft_p50_ms": py_round(quantile(&d.ttfts, 0.5), 1),
                "output_tps_p50": py_round(quantile(&d.tps, 0.5), 1),
            })
        })
        .collect();

    let mut sv: Vec<_> = steps.into_iter().collect();
    sv.sort_by(|a, b| cmp_f64(b.1.cost, a.1.cost).then(b.1.in_tok.cmp(&a.1.in_tok)));
    let by_step = sv
        .into_iter()
        .map(|((step, p, m), d)| {
            json!({
                "step": step, "provider": p, "model": m, "provider_model": format!("{p}:{m}"),
                "calls": d.calls, "input_tokens": d.in_tok, "cached_tokens": d.cached_tok,
                "cache_write_tokens": d.cache_write_tok, "miss_tokens": (d.in_tok - d.cached_tok).max(0),
                "cache_percent": percent(d.cached_tok as f64, d.in_tok as f64),
                "estimated_cost_usd": py_round(d.cost, 8),
            })
        })
        .collect();

    let mut tv: Vec<_> = tools.into_iter().collect();
    tv.sort_by_key(|t| std::cmp::Reverse(t.1.calls));
    let by_tool = tv.into_iter().map(|(tool, d)| json!({"tool": tool, "calls": d.calls, "errors": d.errors, "p95_ms": py_round(quantile(&d.durations, 0.95), 1)})).collect();

    let mut wv: Vec<_> = workspaces.into_iter().collect();
    wv.sort_by(|a, b| cmp_f64(b.1.cost, a.1.cost).then(b.1.turns.cmp(&a.1.turns)));
    let by_workspace = wv
        .into_iter()
        .map(|(ws, d)| {
            json!({
                "workspace": ws, "turns": d.turns, "errors": d.errors,
                "input_tokens": d.input, "output_tokens": d.output,
                "estimated_cost_usd": py_round(d.cost, 8),
            })
        })
        .collect();

    let mut sv_rows: Vec<_> = sessions.into_iter().collect();
    sv_rows.sort_by(|a, b| cmp_f64(b.1.cost, a.1.cost).then(b.1.turns.cmp(&a.1.turns)).then(b.1.last_active_ms.cmp(&a.1.last_active_ms)));
    let by_session = sv_rows
        .into_iter()
        .take(BY_SESSION_LIMIT)
        .map(|(id, d)| {
            json!({
                "session_id": id, "workspace": d.workspace, "model": d.model, "agent_name": d.agent,
                "turns": d.turns, "errors": d.errors,
                "input_tokens": d.input, "output_tokens": d.output, "cached_tokens": d.cached,
                "cache_percent": percent(d.cached as f64, d.input as f64),
                "estimated_cost_usd": py_round(d.cost, 8),
                "last_active_ms": d.last_active_ms,
            })
        })
        .collect();

    t.cost = py_round(t.cost, 8);
    let q = |v: &[f64], p: f64| py_round(quantile(v, p), 1);
    let lat = [q(&turn_d, 0.5), q(&turn_d, 0.95), q(&llm_d, 0.5), q(&llm_d, 0.95), q(&ttft_d, 0.5), q(&ttft_d, 0.95)];
    summary_json(start, end, t, lat, [q(&tps_d, 0.5), q(&tps_d, 0.05)], Breakdowns { daily: daily_turns, by_model, by_step, by_tool, by_workspace, by_session })
}

/// `summarize(days)`, narrowed by `filters`. `facets` always covers the
/// whole window so the filter options do not collapse to the selection.
/// `known` fills in workspaces the spans do not record; it only adds
/// attribution, so it stays out of the cache key (the 5 s bucket bounds
/// any staleness).
pub fn summarize(days: i64, filters: &Filters, known: &KnownWorkspaces) -> Value {
    let days = days.clamp(1, 90);
    let (now, bucket, dir, sigs) = cache_context(days);
    let ratio = appv3_core::otel::sample_ratio();
    let [ws_key, model_key, session_key] = filters.key_parts();
    let key = sig_key("summary", &[days.to_string(), appv3_core::pyjson::float_repr(ratio), ws_key, model_key, session_key], bucket, &dir, &sigs);
    cached(key, || {
        let start = now - Duration::days(days);
        if sigs.is_empty() {
            return Some(empty_summary(start, now));
        }
        let w = span_windows().get(&dir, &sigs, start, now);
        let r = Resolver { index: &w.index, known };
        let mut v = run_queries(&apply_filters(&w.spans, &r, filters), &r, start, now);
        v["facets"] = facets(&w.spans, &r);
        Some(v)
    })
    .unwrap_or(Value::Null)
}

// ── traces ──────────────────────────────────────────────────────────────────

/// `list_traces_with_count` → `(items, total)`; `errors_only` keeps failed turns.
pub fn list_traces_with_count(days: i64, limit: i64, offset: i64, filters: &Filters, errors_only: bool, known: &KnownWorkspaces) -> (Vec<Value>, i64) {
    let days = days.clamp(1, 90);
    let limit = limit.clamp(1, 200);
    let offset = offset.max(0);
    let (now, bucket, dir, sigs) = cache_context(days);
    let [ws_key, model_key, session_key] = filters.key_parts();
    let key = sig_key("traces", &[days.to_string(), limit.to_string(), offset.to_string(), ws_key, model_key, session_key, errors_only.to_string()], bucket, &dir, &sigs);
    let v = cached(key, || {
        let start = now - Duration::days(days);
        if sigs.is_empty() {
            return Some(json!([[], 0]));
        }
        let w = span_windows().get(&dir, &sigs, start, now);
        let r = Resolver { index: &w.index, known };
        let (items, total) = list_traces(&apply_filters(&w.spans, &r, filters), &r, limit, offset, errors_only);
        Some(json!([items, total]))
    })
    .unwrap_or(json!([[], 0]));
    (v[0].as_array().cloned().unwrap_or_default(), v[1].as_i64().unwrap_or(0))
}

#[derive(Default)]
struct TraceAgg {
    llm_calls: i64,
    tool_calls: i64,
    input: i64,
    output: i64,
    cached: i64,
    cost: f64,
}

fn opt_str(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::Null,
        Some(x) => json!(py_str(x)),
    }
}

fn list_traces(spans: &[&Map<String, Value>], index: &Resolver, limit: i64, offset: i64, errors_only: bool) -> (Vec<Value>, i64) {
    let mut counts: IndexMap<String, TraceAgg> = IndexMap::new();
    let mut runs: Vec<&Map<String, Value>> = vec![];
    for &s in spans {
        let name = str_or(s.get("name"), "");
        let Some(tid) = s.get("trace_id").filter(|v| truthy(v)) else { continue };
        let attrs = attrs_of(s);
        let c = counts.entry(py_str(tid)).or_default();
        if name.starts_with("agent_run") {
            if !errors_only || s.get("status").and_then(|v| v.as_str()) == Some("ERROR") {
                runs.push(s);
            }
        } else {
            if name.starts_with("chat") {
                c.llm_calls += 1;
            } else if name.starts_with("execute_tool") {
                c.tool_calls += 1;
            }
            c.input += safe_int(attrs.get("gen_ai.usage.input_tokens"));
            c.output += safe_int(attrs.get("gen_ai.usage.output_tokens"));
            c.cached += safe_int(attrs.get("gen_ai.usage.cache_read.input_tokens"));
            c.cost += safe_float(attrs.get("gen_ai.usage.estimated_cost_usd"));
        }
    }
    let end_key = |s: &Map<String, Value>| num(Some(&ns_or_zero(s.get("end_time")))).unwrap_or(0.0);
    runs.sort_by(|a, b| cmp_f64(end_key(b), end_key(a)));
    let total = runs.len() as i64;
    let empty = TraceAgg::default();
    let items = runs
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|s| {
            let tid = py_str(s.get("trace_id").unwrap_or(&Value::Null));
            let attrs = attrs_of(s);
            let c = counts.get(&tid).unwrap_or(&empty);
            let provider = opt_str(attrs.get("gen_ai.provider.name"));
            let model = opt_str(attrs.get("gen_ai.request.model"));
            let pm = match (provider.as_str(), model.as_str()) {
                (Some(p), Some(m)) => json!(format!("{p}:{m}")),
                _ => Value::Null,
            };
            json!({
                "trace_id": tid,
                "span_id": py_str(s.get("span_id").unwrap_or(&Value::Null)),
                "run_id": opt_str(attrs.get("run_id")),
                "session_id": opt_str(attrs.get("gen_ai.conversation.id")),
                "agent_name": opt_str(attrs.get("gen_ai.agent.name")),
                "workspace": index.workspace_of(s),
                "provider": provider,
                "model": model,
                "provider_model": pm,
                "start_ms": ns_to_ms(&ns_or_zero(s.get("start_time"))),
                "end_ms": ns_to_ms(&ns_or_zero(s.get("end_time"))),
                "duration_ms": py_round(safe_float(s.get("duration_ms")), 1),
                "input_tokens": c.input,
                "output_tokens": c.output,
                "cached_tokens": c.cached,
                "estimated_cost_usd": py_round(c.cost, 8),
                "tool_calls": c.tool_calls,
                "llm_calls": c.llm_calls,
                "error": s.get("status").and_then(|v| v.as_str()) == Some("ERROR"),
            })
        })
        .collect();
    (items, total)
}

/// `get_trace(trace_id, days)`.
pub fn get_trace(trace_id: &str, days: i64) -> Option<Value> {
    let days = days.clamp(1, 90);
    let mut tid = trace_id.to_lowercase();
    if !tid.starts_with("0x") {
        tid = format!("0x{tid}");
    }
    let (now, bucket, dir, sigs) = cache_context(days);
    let key = sig_key("trace", &[tid.clone(), days.to_string()], bucket, &dir, &sigs);
    cached(key, || {
        let start = now - Duration::days(days);
        if sigs.is_empty() {
            return None;
        }
        let w = span_windows().get(&dir, &sigs, start, now);
        let mut matching: Vec<&Map<String, Value>> = w.spans.iter().map(|s| &**s).filter(|s| py_str(s.get("trace_id").unwrap_or(&Value::Null)).to_lowercase() == tid).collect();
        if matching.is_empty() {
            return None;
        }
        let start_key = |s: &Map<String, Value>| num(Some(&ns_or_zero(s.get("start_time")))).unwrap_or(0.0);
        matching.sort_by(|a, b| cmp_f64(start_key(a), start_key(b)));
        let out: Vec<Value> = matching
            .into_iter()
            .map(|s| {
                let attrs: Map<String, Value> = match s.get("attributes") {
                    Some(Value::Object(m)) => m.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect(),
                    _ => Map::new(),
                };
                json!({
                    "span_id": py_str(s.get("span_id").unwrap_or(&Value::Null)),
                    "parent_span_id": opt_str(s.get("parent_id")),
                    "trace_id": py_str(s.get("trace_id").unwrap_or(&Value::Null)),
                    "name": str_or(s.get("name"), ""),
                    "kind": str_or(s.get("kind"), "INTERNAL"),
                    "start_ms": ns_to_ms(&ns_or_zero(s.get("start_time"))),
                    "end_ms": ns_to_ms(&ns_or_zero(s.get("end_time"))),
                    "duration_ms": py_round(safe_float(s.get("duration_ms")), 1),
                    "status": str_or(s.get("status"), "UNSET"),
                    "attributes": attrs,
                })
            })
            .collect();
        Some(json!({"trace_id": out[0]["trace_id"], "spans": out}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_and_percent() {
        assert_eq!(quantile(&[], 0.5), 0.0);
        assert_eq!(quantile(&[3.0], 0.95), 3.0);
        assert!((quantile(&[1.0, 2.0, 3.0, 4.0], 0.95) - 3.85).abs() < 1e-9);
        assert_eq!(percent(1.0, 3.0), 33.3);
        assert_eq!(percent(1.0, 0.0), 0.0);
    }

    #[test]
    fn py_str_forms() {
        assert_eq!(py_str(&json!(1.0)), "1.0");
        assert_eq!(py_str(&json!(true)), "True");
        assert_eq!(py_str(&json!(["a", 1])), "['a', 1]");
        assert_eq!(safe_int(Some(&json!(2.9))), 2);
        assert_eq!(safe_int(Some(&json!("7"))), 7);
        assert_eq!(safe_int(Some(&json!("7.5"))), 0);
    }

    const DAY_NS: f64 = 86_400e9;

    fn span(name: &str, trace: &str, status: &str, end_ns: f64, attrs: Value) -> Map<String, Value> {
        let Value::Object(m) = json!({
            "name": name, "trace_id": trace, "span_id": format!("{trace}-{name}"), "status": status,
            "start_time": end_ns - 1e9, "end_time": end_ns, "duration_ms": 1000.0, "attributes": attrs,
        }) else {
            unreachable!()
        };
        m
    }

    fn turn(trace: &str, workspace: Option<&str>, model: &str, status: &str, end_ns: f64, cost: f64) -> Vec<Map<String, Value>> {
        let (provider, model) = model.split_once(':').unwrap();
        let mut run_attrs = json!({"gen_ai.provider.name": provider, "gen_ai.request.model": model, "gen_ai.conversation.id": format!("s-{trace}")});
        if let Some(ws) = workspace {
            run_attrs[WORKSPACE_ATTR] = json!(ws);
        }
        vec![
            span("agent_run lead", trace, status, end_ns, run_attrs),
            span(
                "chat m",
                trace,
                "OK",
                end_ns,
                json!({"gen_ai.provider.name": provider, "gen_ai.request.model": model, "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10, "gen_ai.usage.estimated_cost_usd": cost, "gen_ai.conversation.id": format!("s-{trace}")}),
            ),
        ]
    }

    fn fixture() -> Vec<Map<String, Value>> {
        let base = 1_700_000_000e9;
        let mut spans = vec![];
        spans.extend(turn("0xa", Some("/w/app"), "openai:gpt", "OK", base, 0.5));
        spans.extend(turn("0xb", Some("/w/app"), "anthropic:claude", "ERROR", base + DAY_NS, 1.25));
        spans.extend(turn("0xc", Some("/w/site"), "openai:gpt", "OK", base + DAY_NS, 0.25));
        // Recorded before workspaces were written on spans.
        spans.extend(turn("0xd", None, "openai:gpt", "OK", base, 0.125));
        // Title generation outside any run, attributed through its session.
        spans.push(span("title_generation", "0xe", "OK", base, json!({"gen_ai.conversation.id": "s-0xc", "gen_ai.usage.estimated_cost_usd": 0.01})));
        spans
    }

    fn summary_for(spans: &[Map<String, Value>], f: &Filters) -> Value {
        summary_with(spans, f, &KnownWorkspaces::new())
    }

    fn summary_with(spans: &[Map<String, Value>], f: &Filters, known: &KnownWorkspaces) -> Value {
        let index = TurnIndex::build(spans);
        let r = Resolver { index: &index, known };
        let now = Utc::now();
        run_queries(&apply_filters(spans, &r, f), &r, now, now)
    }

    fn workspace_row<'a>(v: &'a Value, ws: Option<&str>) -> Option<&'a Value> {
        v["by_workspace"].as_array().unwrap().iter().find(|w| w["workspace"].as_str() == ws)
    }

    fn cost(v: &Value) -> f64 {
        v["estimated_cost_usd"].as_f64().unwrap()
    }

    /// `/compact` and idle compaction wrote no `agent_run` span before
    /// v3.21, and their LLM-call span names no session: only its parent
    /// `summarization` span in the same trace does.
    #[test]
    fn compaction_spend_without_a_run_span_is_attributed_through_its_trace() {
        let mut spans = fixture();
        let base = 1_700_000_000e9;
        spans.push(span("summarization", "0xs", "OK", base, json!({"gen_ai.conversation.id": "s-0xc", "gen_ai.agent.name": "lead"})));
        spans.push(span(
            "summarization_llm_call",
            "0xs",
            "OK",
            base,
            json!({"gen_ai.operation.name": "summarization", "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.estimated_cost_usd": 0.5}),
        ));
        let v = summary_for(&spans, &Filters::default());
        assert!((cost(workspace_row(&v, Some("/w/site")).unwrap()) - 0.76).abs() < 1e-9, "{}", v["by_workspace"]);
        // Only the pre-tracking turn stays unrecorded.
        assert!((cost(workspace_row(&v, None).unwrap()) - 0.125).abs() < 1e-9, "{}", v["by_workspace"]);

        let site = summary_for(&spans, &Filters { workspace: Some("/w/site".into()), ..Default::default() });
        assert!((site["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.76).abs() < 1e-9);
        let session = summary_for(&spans, &Filters { sessions: Some(BTreeSet::from(["s-0xc".to_string()])), ..Default::default() });
        assert!((session["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.76).abs() < 1e-9);
    }

    /// A running turn has no `agent_run` span yet; its chat spans carry
    /// the workspace themselves.
    #[test]
    fn spans_of_a_turn_still_running_use_their_own_workspace() {
        let mut spans = fixture();
        let base = 1_700_000_000e9;
        spans.push(span(
            "chat m",
            "0xp",
            "OK",
            base,
            json!({"gen_ai.conversation.id": "s-new", WORKSPACE_ATTR: "/w/app", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.estimated_cost_usd": 0.3}),
        ));
        let v = summary_for(&spans, &Filters::default());
        assert!((cost(workspace_row(&v, Some("/w/app")).unwrap()) - 2.05).abs() < 1e-9, "{}", v["by_workspace"]);
        let app = summary_for(&spans, &Filters { workspace: Some("/w/app".into()), ..Default::default() });
        assert_eq!(app["totals"]["turns"], 2);
        assert!((app["totals"]["estimated_cost_usd"].as_f64().unwrap() - 2.05).abs() < 1e-9);
    }

    /// Turns recorded before spans carried a workspace take their
    /// session's workspace from the database.
    #[test]
    fn turns_before_workspace_tracking_use_the_session_workspace_on_record() {
        let spans = fixture();
        let known = KnownWorkspaces::from([("s-0xd".to_string(), "/w/old".to_string())]);
        let v = summary_with(&spans, &Filters::default(), &known);
        let old = workspace_row(&v, Some("/w/old")).unwrap_or_else(|| panic!("{}", v["by_workspace"]));
        assert_eq!(old["turns"], 1);
        assert!((cost(old) - 0.125).abs() < 1e-9);
        assert!(workspace_row(&v, None).is_none(), "{}", v["by_workspace"]);

        let index = TurnIndex::build(&spans);
        let r = Resolver { index: &index, known: &known };
        assert!(facets(&spans, &r)["workspaces"].as_array().unwrap().contains(&json!("/w/old")));
        let old_only = Filters { workspace: Some("/w/old".into()), ..Default::default() };
        let (items, total) = list_traces(&apply_filters(&spans, &r, &old_only), &r, 50, 0, false);
        assert_eq!(total, 1);
        assert_eq!(items[0]["trace_id"], "0xd");
        assert_eq!(items[0]["workspace"], "/w/old");
    }

    #[test]
    fn session_workspaces_on_record_match_either_id_form() {
        let spans = vec![span(
            "agent_run lead",
            "0x1",
            "OK",
            1_700_000_000e9,
            json!({"gen_ai.conversation.id": "0190a1b2-0000-7000-8000-000000000000", "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt"}),
        )];
        // Stored (hex) id; the span holds the hyphenated form.
        let known = KnownWorkspaces::from([("0190a1b2000070008000000000000000".to_string(), "/w/old".to_string())]);
        let v = summary_with(&spans, &Filters::default(), &known);
        assert_eq!(v["by_workspace"][0]["workspace"], "/w/old");
    }

    #[test]
    fn workspace_filter_keeps_whole_turns_and_session_spans() {
        let spans = fixture();
        let v = summary_for(&spans, &Filters { workspace: Some("/w/site".into()), ..Default::default() });
        assert_eq!(v["totals"]["turns"], 1);
        assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.26).abs() < 1e-9);
        assert_eq!(v["by_workspace"][0]["workspace"], "/w/site");
    }

    #[test]
    fn model_filter_matches_the_turn_model() {
        let spans = fixture();
        let v = summary_for(&spans, &Filters { model: Some("openai:gpt".into()), ..Default::default() });
        assert_eq!(v["totals"]["turns"], 3);
        assert_eq!(v["by_model"].as_array().unwrap().len(), 1);
        assert_eq!(v["totals"]["errors"], 0);
    }

    #[test]
    fn model_filter_keeps_spans_outside_a_turn_by_their_own_model() {
        let mut spans = fixture();
        let base = 1_700_000_000e9;
        spans.push(span(
            "title_generation",
            "0xg",
            "OK",
            base,
            json!({"gen_ai.conversation.id": "s-0xa", "gen_ai.provider.name": "openai", "gen_ai.request.model": "mini", "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 5, "gen_ai.usage.estimated_cost_usd": 0.02}),
        ));
        let v = summary_for(&spans, &Filters { model: Some("openai:mini".into()), ..Default::default() });
        assert_eq!(v["totals"]["turns"], 0);
        assert_eq!(v["by_model"][0]["provider_model"], "openai:mini");
        assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.02).abs() < 1e-9);

        // Inside a turn the turn's model still decides, and a span with no
        // recorded model stays out of every real model filter.
        let v = summary_for(&spans, &Filters { model: Some("openai:gpt".into()), ..Default::default() });
        assert_eq!(v["totals"]["turns"], 3);
        assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.875).abs() < 1e-9);
    }

    #[test]
    fn breakdowns_carry_daily_cost_and_unrecorded_workspaces() {
        let spans = fixture();
        let v = summary_for(&spans, &Filters::default());
        let days = v["daily_turns"].as_array().unwrap();
        assert_eq!(days.len(), 2);
        assert_eq!(days[1]["turns"], 2);
        assert!((days[1]["estimated_cost_usd"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        let unrecorded = v["by_workspace"].as_array().unwrap().iter().find(|w| w["workspace"].is_null()).unwrap();
        assert_eq!(unrecorded["turns"], 1);
        assert_eq!(v["by_workspace"][0]["workspace"], "/w/app");
    }

    #[test]
    fn facets_rank_the_whole_window() {
        let spans = fixture();
        let index = TurnIndex::build(&spans);
        let v = facets(&spans, &Resolver { index: &index, known: &KnownWorkspaces::new() });
        assert_eq!(v["workspaces"], json!(["/w/app", "/w/site"]));
        assert_eq!(v["models"], json!(["openai:gpt", "anthropic:claude"]));
    }

    #[test]
    fn summary_reports_time_to_first_chunk_and_output_speed() {
        let base = 1_700_000_000e9;
        let chat = |trace: &str, model: &str, timing: Option<(f64, f64)>| {
            let (provider, model) = model.split_once(':').unwrap();
            let mut attrs = json!({"gen_ai.provider.name": provider, "gen_ai.request.model": model, "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10});
            if let Some((ttft_s, tps)) = timing {
                attrs[TTFT_ATTR] = json!(ttft_s);
                attrs[OUTPUT_TPS_ATTR] = json!(tps);
            }
            span("chat m", trace, "OK", base, attrs)
        };
        let spans = vec![
            chat("0x1", "openai:gpt", Some((0.5, 40.0))),
            chat("0x2", "openai:gpt", Some((1.5, 60.0))),
            // Recorded before timing was: counts as a call, not as a sample.
            chat("0x3", "openai:gpt", None),
            chat("0x4", "anthropic:claude", Some((2.0, 100.0))),
        ];
        let v = summary_for(&spans, &Filters::default());
        assert_eq!(v["latency_ms"]["ttft_p50"], 1500.0);
        assert_eq!(v["latency_ms"]["ttft_p95"], 1950.0);
        assert_eq!(v["output_tps"]["p50"], 60.0);
        assert_eq!(v["output_tps"]["p5"], 42.0);
        let gpt = v["by_model"].as_array().unwrap().iter().find(|m| m["provider_model"] == "openai:gpt").unwrap();
        assert_eq!(gpt["calls"], 3);
        assert_eq!(gpt["ttft_p50_ms"], 1000.0);
        assert_eq!(gpt["output_tps_p50"], 50.0);

        let v = summary_for(&fixture(), &Filters::default());
        assert_eq!(v["latency_ms"]["ttft_p50"], 0.0);
        assert_eq!(v["by_model"][0]["output_tps_p50"], 0.0);
    }

    #[test]
    fn trace_list_filters_failed_turns_and_reports_workspace() {
        let spans = fixture();
        let turns = TurnIndex::build(&spans);
        let index = Resolver { index: &turns, known: &KnownWorkspaces::new() };
        let all: Vec<&Map<String, Value>> = spans.iter().collect();
        let (items, total) = list_traces(&all, &index, 50, 0, true);
        assert_eq!(total, 1);
        assert_eq!(items[0]["trace_id"], "0xb");
        assert_eq!(items[0]["workspace"], "/w/app");
        assert_eq!(items[0]["error"], true);

        let (items, _) = list_traces(&apply_filters(&spans, &index, &Filters { workspace: Some("/w/app".into()), ..Default::default() }), &index, 50, 0, false);
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn session_filter_keeps_the_session_turns_and_its_title_span() {
        let spans = fixture();
        let v = summary_for(&spans, &Filters { sessions: Some(BTreeSet::from(["s-0xc".to_string()])), ..Default::default() });
        assert_eq!(v["totals"]["turns"], 1);
        assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.26).abs() < 1e-9);

        let turns = TurnIndex::build(&spans);
        let index = Resolver { index: &turns, known: &KnownWorkspaces::new() };
        let f = Filters { sessions: Some(BTreeSet::from(["s-0xb".to_string()])), ..Default::default() };
        let (items, total) = list_traces(&apply_filters(&spans, &index, &f), &index, 50, 0, false);
        assert_eq!(total, 1);
        assert_eq!(items[0]["session_id"], "s-0xb");
    }

    #[test]
    fn session_filter_keeps_every_session_in_the_set() {
        let spans = fixture();
        let family = Filters { sessions: Some(BTreeSet::from(["s-0xa".to_string(), "s-0xb".to_string()])), ..Default::default() };
        let v = summary_for(&spans, &family);
        assert_eq!(v["totals"]["turns"], 2);
        assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 1.75).abs() < 1e-9);
        let ids: Vec<&str> = v["by_session"].as_array().unwrap().iter().map(|s| s["session_id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["s-0xb", "s-0xa"]);
        // The whole set is part of the cache key.
        let lead_only = Filters { sessions: Some(BTreeSet::from(["s-0xa".to_string()])), ..Default::default() };
        assert_ne!(family.key_parts(), lead_only.key_parts());
    }

    #[test]
    fn by_session_ranks_by_spend_and_skips_runs_outside_sessions() {
        let mut spans = fixture();
        let base = 1_700_000_000e9;
        spans.push(span("agent_run lead", "0xf", "OK", base, json!({"gen_ai.conversation.id": "no-session", "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt"})));
        spans.push(span(
            "chat m",
            "0xf",
            "OK",
            base,
            json!({"gen_ai.usage.input_tokens": 400, "gen_ai.usage.cache_read.input_tokens": 100, "gen_ai.usage.estimated_cost_usd": 9.0, "gen_ai.conversation.id": "no-session"}),
        ));
        let v = summary_for(&spans, &Filters::default());
        let sessions = v["by_session"].as_array().unwrap();
        let ids: Vec<&str> = sessions.iter().map(|s| s["session_id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["s-0xb", "s-0xa", "s-0xc", "s-0xd"]);
        let top = &sessions[0];
        assert_eq!(top["turns"], 1);
        assert_eq!(top["errors"], 1);
        assert_eq!(top["workspace"], "/w/app");
        assert_eq!(top["model"], "anthropic:claude");
        assert_eq!(top["input_tokens"], 100);
        assert_eq!(top["last_active_ms"], ns_to_ms(&json!(base + DAY_NS)));
        // The title span counts toward its session.
        assert!((sessions[2]["estimated_cost_usd"].as_f64().unwrap() - 0.26).abs() < 1e-9);
    }

    fn write_spans(path: &std::path::Path, spans: &[Map<String, Value>]) -> Signatures {
        let body: String = spans.iter().map(|s| format!("{}\n", Value::Object(s.clone()))).collect();
        std::fs::write(path, body).unwrap();
        let m = std::fs::metadata(path).unwrap();
        vec![(path.to_string_lossy().into_owned(), m.len(), mtime_ns(&m), inode(&m))]
    }

    fn at(ns: f64) -> DateTime<Utc> {
        Utc.timestamp_nanos(ns as i64)
    }

    #[test]
    fn span_window_is_reused_until_the_selection_or_a_file_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let path = tmp.path().join("2023-11-14-22.jsonl");
        let base = 1_700_000_000e9;
        let mut spans = turn("0xa", Some("/w/app"), "openai:gpt", "OK", base, 0.5);
        spans.extend(turn("0xb", Some("/w/app"), "openai:gpt", "OK", base + 60e9, 0.25));
        let sigs = write_spans(&path, &spans);
        let cache = SpanWindowCache::default();

        let first = cache.get(&dir, &sigs, at(base - 3600e9), at(base + 120e9));
        assert_eq!(first.spans.len(), 4);
        assert!(first.index.by_trace.contains_key("0xb"));

        // A later window that selects the same spans (a filter change, the
        // trace list, the next poll) reuses the parse.
        let same = cache.get(&dir, &sigs, at(base - 60e9), at(base + 300e9));
        assert!(Arc::ptr_eq(&first, &same));

        // Once the start passes a span, the window drops it.
        let aged = cache.get(&dir, &sigs, at(base + 30e9), at(base + 300e9));
        assert!(!Arc::ptr_eq(&first, &aged));
        assert_eq!(aged.spans.len(), 2);
        assert!(!aged.index.by_trace.contains_key("0xa"));

        // An earlier start would bring the aged-out span back, so no reuse.
        let wider = cache.get(&dir, &sigs, at(base - 60e9), at(base + 300e9));
        assert_eq!(wider.spans.len(), 4);

        // A written span changes the file signature.
        spans.extend(turn("0xc", Some("/w/app"), "openai:gpt", "OK", base + 90e9, 0.125));
        let grown = write_spans(&path, &spans);
        let fresh = cache.get(&dir, &grown, at(base - 60e9), at(base + 300e9));
        assert_eq!(fresh.spans.len(), 6);
        assert!(fresh.index.by_trace.contains_key("0xc"));
    }

    /// While an agent runs, only the live hour's file changes; the closed
    /// hours (a week of them on the telemetry page) must not be re-parsed.
    #[test]
    fn only_changed_span_files_are_parsed_again() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let (closed, live) = (tmp.path().join("2023-11-14-21.jsonl"), tmp.path().join("2023-11-14-22.jsonl"));
        let base = 1_700_000_000e9;
        let mut live_spans = turn("0xb", None, "openai:gpt", "OK", base, 0.25);
        let closed_sig = write_spans(&closed, &turn("0xa", None, "openai:gpt", "OK", base - 1800e9, 0.5));
        let sigs = [closed_sig.clone(), write_spans(&live, &live_spans)].concat();
        let cache = SpanWindowCache::default();
        let (start, end) = (at(base - 7200e9), at(base + 300e9));
        let first = cache.get(&dir, &sigs, start, end);
        assert_eq!(first.spans.len(), 4);

        live_spans.extend(turn("0xc", None, "openai:gpt", "OK", base + 60e9, 0.125));
        let grown = [closed_sig.clone(), write_spans(&live, &live_spans)].concat();
        let next = cache.get(&dir, &grown, start, end);
        assert_eq!(next.spans.len(), 6);
        assert!(next.index.by_trace.contains_key("0xc"));
        let span_of = |w: &SpanWindow, trace: &str| w.spans.iter().find(|s| s.get("trace_id") == Some(&json!(trace))).unwrap().clone();
        assert!(Arc::ptr_eq(&span_of(&first, "0xa"), &span_of(&next, "0xa")), "the closed file was parsed again");
        assert!(!Arc::ptr_eq(&span_of(&first, "0xb"), &span_of(&next, "0xb")), "the live file was not re-read");

        // A file that leaves the window is dropped from the cache.
        let live_only = [write_spans(&live, &live_spans)].concat();
        let _ = cache.get(&dir, &live_only, at(base - 60e9), end);
        assert_eq!(cache.0.lock().unwrap().files.len(), 1);
    }
}
