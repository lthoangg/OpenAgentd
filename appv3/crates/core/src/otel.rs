//! File-based
//! OpenTelemetry-shaped spans, no external service.
//!
//! Layout (unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set):
//!   `{STATE_DIR}/otel/spans/YYYY-MM-DD-HH.jsonl`  (hourly, by span end)
//!
//! Every number the Telemetry page shows comes from spans. Metrics were
//! dropped: nothing read them, and their cumulative histograms, rewritten
//! every minute, grew the state dir every day. [`run_retention_once`]
//! removes the old `otel/metrics` directory.
//!
//! Context propagation mirrors Python `contextvars`: a task-local "current
//! span" that [`scope`] establishes for a future and [`attach`] mutates in
//! place (v2's `otel_context.attach`). [`spawn`] carries the current span
//! into a new task, like `asyncio.create_task` copying the context.

use chrono::{DateTime, Utc};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Python `float(str)` (lenient enough for env values).
fn py_float(raw: &str) -> Option<f64> {
    raw.trim().parse::<f64>().ok()
}

/// Python `int(str)`.
fn py_int(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

// ── context ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SpanCtx {
    pub trace_id: u128,
    pub span_id: u64,
}

impl SpanCtx {
    /// W3C `traceparent` (always-on sampler → flags `01`).
    pub fn traceparent(&self) -> String {
        format!("00-{:032x}-{:016x}-01", self.trace_id, self.span_id)
    }
}

tokio::task_local! {
    static CURRENT: Cell<Option<SpanCtx>>;
}

/// The active span context, if any.
pub fn current() -> Option<SpanCtx> {
    CURRENT.try_with(|c| c.get()).ok().flatten()
}

/// Run `f` with `ctx` as its (mutable) current span context.
pub fn scope<F: Future>(ctx: Option<SpanCtx>, f: F) -> tokio::task::futures::TaskLocalFuture<Cell<Option<SpanCtx>>, F> {
    CURRENT.scope(Cell::new(ctx), f)
}

/// Run `f` in a fresh context slot inheriting the current span.
pub fn inherit<F: Future>(f: F) -> tokio::task::futures::TaskLocalFuture<Cell<Option<SpanCtx>>, F> {
    scope(current(), f)
}

/// `otel_context.attach` — replace the current span in the innermost scope.
/// Returns the previous value (the "token") when inside a scope.
pub fn attach(ctx: Option<SpanCtx>) -> Option<Option<SpanCtx>> {
    CURRENT.try_with(|c| c.replace(ctx)).ok()
}

/// `tokio::spawn` carrying the current span (asyncio context copy).
pub fn spawn<F>(f: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(scope(current(), f))
}

// ── spans ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpanKind {
    Internal,
    Client,
}

impl SpanKind {
    fn name(self) -> &'static str {
        match self {
            SpanKind::Internal => "INTERNAL",
            SpanKind::Client => "CLIENT",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusCode {
    Unset,
    Ok,
    Error,
}

impl StatusCode {
    fn name(self) -> &'static str {
        match self {
            StatusCode::Unset => "UNSET",
            StatusCode::Ok => "OK",
            StatusCode::Error => "ERROR",
        }
    }
}

struct SpanData {
    name: String,
    ctx: SpanCtx,
    parent: Option<u64>,
    kind: SpanKind,
    start: u64,
    end: Option<u64>,
    status: StatusCode,
    attrs: IndexMap<String, Value>,
    events: Vec<Value>,
}

/// A recording span handle (cheap to clone).
#[derive(Clone)]
pub struct Span(Arc<Mutex<SpanData>>);

pub fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

fn rand_u128() -> u128 {
    loop {
        let v = uuid::Uuid::new_v4().as_u128();
        if v != 0 {
            return v;
        }
    }
}

fn rand_u64() -> u64 {
    loop {
        let v = uuid::Uuid::new_v4().as_u128() as u64;
        if v != 0 {
            return v;
        }
    }
}

/// OTel attribute value validation: primitives and homogeneous primitive
/// sequences are kept; `None`/mappings are dropped.
fn valid_attr(v: &Value) -> bool {
    match v {
        Value::Null | Value::Object(_) => false,
        Value::Array(a) => a.iter().all(|x| matches!(x, Value::String(_) | Value::Bool(_) | Value::Number(_))),
        _ => true,
    }
}

impl Span {
    /// `tracer.start_span(name, kind, attributes)` under the current span.
    pub fn start(name: impl Into<String>, kind: SpanKind, attrs: Vec<(&str, Value)>) -> Span {
        Self::start_with_parent(name, kind, current(), attrs)
    }

    pub fn start_with_parent(name: impl Into<String>, kind: SpanKind, parent: Option<SpanCtx>, attrs: Vec<(&str, Value)>) -> Span {
        let ctx = SpanCtx { trace_id: parent.map(|p| p.trace_id).unwrap_or_else(rand_u128), span_id: rand_u64() };
        let mut map = IndexMap::new();
        for (k, v) in attrs {
            if valid_attr(&v) {
                map.shift_remove(k);
                map.insert(k.to_string(), v);
            }
        }
        Span(Arc::new(Mutex::new(SpanData {
            name: name.into(),
            ctx,
            parent: parent.map(|p| p.span_id),
            kind,
            start: now_ns(),
            end: None,
            status: StatusCode::Unset,
            attrs: map,
            events: vec![],
        })))
    }

    pub fn ctx(&self) -> SpanCtx {
        self.0.lock().unwrap().ctx
    }

    /// `span.set_attribute` (re-setting a key moves it to the end, like
    /// the SDK's `BoundedAttributes`).
    pub fn set_attr(&self, key: &str, value: impl Into<Value>) {
        let v = value.into();
        if !valid_attr(&v) {
            return;
        }
        let mut g = self.0.lock().unwrap();
        if g.end.is_some() {
            return;
        }
        g.attrs.shift_remove(key);
        g.attrs.insert(key.to_string(), v);
    }

    pub fn has_attr(&self, key: &str) -> bool {
        self.0.lock().unwrap().attrs.contains_key(key)
    }

    /// The attribute `key`, if set.
    pub fn attr(&self, key: &str) -> Option<Value> {
        self.0.lock().unwrap().attrs.get(key).cloned()
    }

    /// `span.is_recording()`: true until the span ends.
    pub fn is_recording(&self) -> bool {
        self.0.lock().unwrap().end.is_none()
    }

    pub fn status(&self) -> StatusCode {
        self.0.lock().unwrap().status
    }

    /// `span.update_name`.
    pub fn set_name(&self, name: impl Into<String>) {
        let mut g = self.0.lock().unwrap();
        if g.end.is_none() {
            g.name = name.into();
        }
    }

    /// `set_status` — `OK` is final, later changes are ignored.
    pub fn set_status(&self, code: StatusCode) {
        let mut g = self.0.lock().unwrap();
        if g.end.is_some() || g.status == StatusCode::Ok {
            return;
        }
        g.status = code;
    }

    pub fn set_ok(&self) {
        self.set_status(StatusCode::Ok);
    }

    pub fn set_error(&self) {
        self.set_status(StatusCode::Error);
    }

    pub fn add_event(&self, name: &str, attrs: Vec<(&str, Value)>) {
        let mut g = self.0.lock().unwrap();
        if g.end.is_some() {
            return;
        }
        let mut m = Map::new();
        for (k, v) in attrs {
            if valid_attr(&v) {
                m.insert(k.to_string(), v);
            }
        }
        g.events.push(json!({"name": name, "timestamp": now_ns(), "attributes": m}));
    }

    /// `span.record_exception` (no Python traceback in v3).
    pub fn record_exception(&self, qualified_type: &str, message: &str) {
        self.add_event("exception", vec![("exception.type", json!(qualified_type)), ("exception.message", json!(message))]);
    }

    /// Exit of `start_as_current_span` with an exception in flight.
    pub fn exit_with_exception(&self, qualified_type: &str, message: &str) {
        self.record_exception(qualified_type, message);
        self.set_error();
        self.end();
    }

    pub fn end(&self) {
        let record = {
            let mut g = self.0.lock().unwrap();
            if g.end.is_some() {
                return;
            }
            let end = now_ns().max(g.start);
            g.end = Some(end);
            span_to_dict(&g)
        };
        export_span(record);
    }
}

fn span_to_dict(s: &SpanData) -> (Value, u64, StatusCode, u128, u64) {
    let end = s.end.unwrap_or(s.start);
    let duration = if s.start != 0 && end != 0 { json!(crate::pymath::py_round((end - s.start) as f64 / 1_000_000.0, 3)) } else { Value::Null };
    let v = json!({
        "name": s.name,
        "trace_id": format!("0x{:032x}", s.ctx.trace_id),
        "span_id": format!("0x{:016x}", s.ctx.span_id),
        "parent_id": s.parent.map(|p| format!("0x{p:016x}")),
        "kind": s.kind.name(),
        "start_time": s.start,
        "end_time": end,
        "duration_ms": duration,
        "status": s.status.name(),
        "attributes": s.attrs,
        "events": s.events,
        "resource": resource(),
    });
    (v, end, s.status, s.ctx.trace_id, end - s.start)
}

// ── exporter ────────────────────────────────────────────────────────────────

struct Otel {
    spans: Option<JsonlWriter>,
    service: String,
    ratio: f64,
    slow_ns: u64,
}

static OTEL: OnceLock<Otel> = OnceLock::new();
static INSTANCE_ID: OnceLock<String> = OnceLock::new();

fn resource() -> Value {
    let service = OTEL.get().map(|o| o.service.clone()).unwrap_or_else(|| "openagentd".into());
    json!({
        "telemetry.sdk.language": "rust",
        "telemetry.sdk.name": "openagentd-v3",
        "telemetry.sdk.version": crate::VERSION,
        "service.instance.id": INSTANCE_ID.get_or_init(|| uuid::Uuid::new_v4().to_string()),
        "service.name": service,
    })
}

pub fn sample_ratio() -> f64 {
    let raw = crate::settings::env_var("OPENAGENTD_OTEL_SPAN_SAMPLE_RATIO").unwrap_or_else(|| "1.0".into());
    match py_float(&raw) {
        Some(v) if v.is_nan() => 1.0,
        Some(v) => v.clamp(0.0, 1.0),
        None => 1.0,
    }
}

fn slow_span_threshold_ns() -> u64 {
    let raw = crate::settings::env_var("OPENAGENTD_OTEL_SLOW_SPAN_MS").unwrap_or_else(|| "1000".into());
    match py_float(&raw) {
        Some(v) if v.is_finite() => (v * 1_000_000.0) as i64 as u64,
        _ => 1_000_000_000,
    }
}

fn trace_passes_ratio(trace_id: u128, ratio: f64) -> bool {
    if ratio >= 1.0 {
        return true;
    }
    if ratio <= 0.0 {
        return false;
    }
    let threshold = (ratio * 18446744073709551616.0) as u128;
    ((trace_id as u64) as u128) < threshold
}

fn export_span((v, end, status, trace_id, duration): (Value, u64, StatusCode, u128, u64)) {
    let Some(o) = OTEL.get() else { return };
    let Some(w) = &o.spans else { return };
    let keep = status == StatusCode::Error || duration >= o.slow_ns || trace_passes_ratio(trace_id, o.ratio);
    if keep {
        let ts = DateTime::<Utc>::from_timestamp((end / 1_000_000_000) as i64, (end % 1_000_000_000) as u32).unwrap_or_else(Utc::now);
        w.write(v, ts);
    }
}

/// `setup_otel` — idempotent.
pub fn setup(service_name: &str, otel_dir: Option<&Path>) {
    if OTEL.get().is_some() {
        return;
    }
    let dir = otel_dir.map(Path::to_path_buf).unwrap_or_else(|| crate::settings().state_dir.join("otel"));
    let spans = match std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok().filter(|e| !e.is_empty()) {
        Some(_) => {
            // v2 without the optional gRPC exporter: warn and drop spans.
            tracing::warn!("otel_otlp_exporter_unavailable install opentelemetry-exporter-otlp-proto-grpc");
            None
        }
        None => {
            let d = dir.join("spans");
            tracing::info!("otel_trace_exporter=file dir={} sample_ratio={:.3} slow_ms={}", d.display(), sample_ratio(), slow_span_threshold_ns() / 1_000_000);
            Some(JsonlWriter::new(d, hourly_partition, "spans"))
        }
    };
    let o = Otel { spans, service: service_name.to_string(), ratio: sample_ratio(), slow_ns: slow_span_threshold_ns() };
    if OTEL.set(o).is_err() {
        return;
    }
    tracing::info!("otel_setup_complete service={} spans_dir={}", service_name, dir.join("spans").display());
}

/// `shutdown_otel` — flush and close the span writer.
pub fn shutdown() {
    let Some(o) = OTEL.get() else { return };
    if let Some(w) = &o.spans {
        w.close();
    }
}

/// Flush pending span records now (tests and harnesses).
pub fn flush() {
    if let Some(o) = OTEL.get() {
        if let Some(w) = &o.spans {
            w.flush_now();
        }
    }
}

// ── JSONL batch writer ──────────────────────────────────────────────────────

pub fn hourly_partition(ts: DateTime<Utc>) -> String {
    ts.format("%Y-%m-%d-%H").to_string()
}

enum Msg {
    Rec(Value, DateTime<Utc>),
    Flush(SyncSender<()>),
    Stop,
}

/// Bounded-queue, drop-on-backpressure JSONL writer on a daemon thread.
pub struct JsonlWriter {
    tx: SyncSender<Msg>,
    done: Mutex<Option<Receiver<()>>>,
    name: &'static str,
}

const MAX_QUEUE: usize = 10_000;
const BATCH_SIZE: usize = 128;
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);

impl JsonlWriter {
    pub fn new(root: PathBuf, partition: fn(DateTime<Utc>) -> String, name: &'static str) -> Self {
        let _ = std::fs::create_dir_all(&root);
        let (tx, rx) = sync_channel::<Msg>(MAX_QUEUE);
        let (done_tx, done_rx) = sync_channel::<()>(1);
        std::thread::Builder::new()
            .name(format!("jsonl-writer-{name}"))
            .spawn(move || {
                run_writer(rx, &root, partition, name);
                let _ = done_tx.send(());
            })
            .ok();
        Self { tx, done: Mutex::new(Some(done_rx)), name }
    }

    /// Enqueue one record; `false` when dropped on backpressure.
    pub fn write(&self, obj: Value, ts: DateTime<Utc>) -> bool {
        match self.tx.try_send(Msg::Rec(obj, ts)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
        }
    }

    pub fn flush_now(&self) {
        let (tx, rx) = sync_channel(1);
        if self.tx.send(Msg::Flush(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }
    }

    pub fn close(&self) {
        let _ = self.tx.try_send(Msg::Stop);
        if let Some(done) = self.done.lock().unwrap().take() {
            if done.recv_timeout(Duration::from_secs(5)).is_err() {
                tracing::warn!("jsonl_writer_close_timeout name={}", self.name);
            }
        }
    }
}

/// How long the writer waits for the next message: until one arrives when
/// nothing is batched (`None`), otherwise until the batch's flush deadline.
fn writer_wait(batch_empty: bool, since_flush: Duration) -> Option<Duration> {
    if batch_empty {
        return None;
    }
    Some(FLUSH_INTERVAL.saturating_sub(since_flush).max(Duration::from_millis(50)))
}

fn run_writer(rx: Receiver<Msg>, root: &Path, partition: fn(DateTime<Utc>) -> String, name: &str) {
    let mut batch: Vec<(Value, DateTime<Utc>)> = vec![];
    let mut last_flush = Instant::now();
    loop {
        let mut stop = false;
        let mut ack: Option<SyncSender<()>> = None;
        let next = match writer_wait(batch.is_empty(), last_flush.elapsed()) {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(timeout) => rx.recv_timeout(timeout),
        };
        match next {
            Ok(Msg::Rec(v, ts)) => batch.push((v, ts)),
            Ok(Msg::Flush(a)) => ack = Some(a),
            Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => stop = true,
            Err(RecvTimeoutError::Timeout) => {}
        }
        while !stop && ack.is_none() && batch.len() < BATCH_SIZE {
            match rx.try_recv() {
                Ok(Msg::Rec(v, ts)) => batch.push((v, ts)),
                Ok(Msg::Flush(a)) => ack = Some(a),
                Ok(Msg::Stop) => stop = true,
                Err(_) => break,
            }
        }
        if stop {
            while let Ok(m) = rx.try_recv() {
                if let Msg::Rec(v, ts) = m {
                    batch.push((v, ts));
                }
            }
            flush_batch(&mut batch, root, partition, name);
            return;
        }
        if !batch.is_empty() && (ack.is_some() || batch.len() >= BATCH_SIZE || last_flush.elapsed() >= FLUSH_INTERVAL) {
            flush_batch(&mut batch, root, partition, name);
            last_flush = Instant::now();
        }
        if let Some(a) = ack {
            let _ = a.send(());
        }
    }
}

fn flush_batch(batch: &mut Vec<(Value, DateTime<Utc>)>, root: &Path, partition: fn(DateTime<Utc>) -> String, name: &str) {
    use std::io::Write;
    let mut groups: IndexMap<String, Vec<Value>> = IndexMap::new();
    for (v, ts) in batch.drain(..) {
        groups.entry(partition(ts)).or_default().push(v);
    }
    for (key, objs) in groups {
        let path = root.join(format!("{key}.jsonl"));
        let mut buf = String::new();
        for o in &objs {
            buf.push_str(&serde_json::to_string(o).unwrap_or_default());
            buf.push('\n');
        }
        let res = std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(buf.as_bytes()));
        if let Err(e) = res {
            tracing::warn!("jsonl_writer_flush_failed name={} path={} error={}", name, path.display(), e);
        }
    }
}

// ── retention ───────────────────────────────────────────────────────────────

fn int_env(name: &str, default: i64, min: i64) -> i64 {
    match crate::settings::env_var(name) {
        None => default,
        Some(raw) => py_int(&raw).map(|v| v.max(min)).unwrap_or(default),
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepResult {
    pub scanned: u64,
    pub deleted: u64,
    pub errors: u64,
    pub bytes_freed: u64,
}

/// Delete `*.jsonl` under `root` whose mtime is older than `max_age_days`.
pub fn sweep_old_partitions(root: &Path, max_age_days: i64, now: Option<f64>) -> SweepResult {
    let mut r = SweepResult::default();
    if max_age_days <= 0 || !root.exists() {
        return r;
    }
    let now = now.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0));
    let cutoff = now - (max_age_days * 86400) as f64;
    let Ok(rd) = std::fs::read_dir(root) else {
        return r;
    };
    for e in rd.flatten() {
        let path = e.path();
        let fname = e.file_name().to_string_lossy().into_owned();
        // `glob("*.jsonl")`: hidden files never match.
        if !fname.ends_with(".jsonl") || fname.starts_with('.') || !path.is_file() {
            continue;
        }
        r.scanned += 1;
        let Ok(meta) = std::fs::metadata(&path) else {
            r.errors += 1;
            continue;
        };
        let mtime = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        if mtime >= cutoff {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                r.deleted += 1;
                r.bytes_freed += meta.len();
            }
            Err(err) => {
                r.errors += 1;
                tracing::warn!("otel_retention_unlink_failed path={} error={}", path.display(), err);
            }
        }
    }
    r
}

/// Days spans are kept: the `telemetry.retention_days` setting,
/// where 0 keeps them forever. Read on every sweep, so a change in Settings
/// applies without a restart.
fn retention_days() -> i64 {
    crate::runtime_settings::telemetry_settings().retention_days()
}

/// Remove `{otel_dir}/metrics`, which older versions filled with daily
/// metric files nobody read. Only a real directory: a symlink there is left
/// alone, so its target is never touched. Returns the bytes freed, `None`
/// when there was nothing to remove.
pub fn remove_legacy_metrics(otel_dir: &Path) -> Option<u64> {
    let dir = otel_dir.join("metrics");
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let bytes = dir_bytes(&dir);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {
            tracing::info!("otel_metrics_removed path={} bytes={}", dir.display(), bytes);
            Some(bytes)
        }
        Err(e) => {
            tracing::warn!("otel_metrics_remove_failed path={} error={}", dir.display(), e);
            None
        }
    }
}

/// Total size of the regular files under `dir`, not following symlinks.
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(e.path()),
                Ok(t) if t.is_file() => total += e.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    total
}

/// One retention pass over spans (nothing when retention is 0). Also drops
/// the legacy metrics directory, whatever the retention.
pub fn run_retention_once(otel_dir: Option<&Path>) -> SweepResult {
    let base = otel_dir.map(Path::to_path_buf).unwrap_or_else(|| crate::settings().state_dir.join("otel"));
    remove_legacy_metrics(&base);
    let days = retention_days();
    if days <= 0 {
        tracing::debug!("otel_retention_off keep_forever");
        return SweepResult::default();
    }
    let s = sweep_old_partitions(&base.join("spans"), days, None);
    if s.deleted > 0 {
        tracing::info!("otel_retention_swept spans_deleted={} spans_bytes={} days={}", s.deleted, s.bytes_freed, days);
    } else {
        tracing::debug!("otel_retention_swept nothing_to_delete spans_scanned={}", s.scanned);
    }
    s
}

fn retention_task() -> &'static Mutex<Option<tokio::task::JoinHandle<()>>> {
    static T: OnceLock<Mutex<Option<tokio::task::JoinHandle<()>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
}

/// `start_otel_retention` — one sweep now, then every interval. It always
/// runs; a retention of 0 makes each pass a no-op.
pub fn start_retention() {
    let mut g = retention_task().lock().unwrap();
    if g.as_ref().map(|t| !t.is_finished()).unwrap_or(false) {
        return;
    }
    let hours = int_env("OPENAGENTD_OTEL_RETENTION_SWEEP_INTERVAL_HOURS", 24, 1);
    *g = Some(tokio::spawn(async move {
        loop {
            if let Err(e) = tokio::task::spawn_blocking(|| run_retention_once(None)).await {
                tracing::warn!("otel_retention_sweep_failed error={}", e);
            }
            tokio::time::sleep(Duration::from_secs(hours as u64 * 3600)).await;
        }
    }));
    tracing::info!("otel_retention_started days={} interval_h={}", retention_days(), hours);
}

pub fn stop_retention() {
    if let Some(t) = retention_task().lock().unwrap().take() {
        t.abort();
    }
}

/// Run one sweep in the background now (after the retention setting
/// changes). Needs a Tokio runtime.
pub fn sweep_retention_now() {
    tokio::task::spawn_blocking(|| {
        run_retention_once(None);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_writer_blocks_instead_of_polling() {
        // Nothing batched: wait for the next record, however long ago the
        // last flush was (a 50 ms floor here woke two threads 20x/s forever).
        assert_eq!(writer_wait(true, Duration::from_secs(30)), None);
        assert_eq!(writer_wait(true, Duration::ZERO), None);
        // Something batched: wake for the flush deadline.
        assert_eq!(writer_wait(false, Duration::from_millis(200)), Some(Duration::from_millis(800)));
        assert_eq!(writer_wait(false, Duration::from_secs(5)), Some(Duration::from_millis(50)));
    }

    #[test]
    fn ratio_threshold() {
        assert!(trace_passes_ratio(u128::MAX, 1.0));
        assert!(!trace_passes_ratio(1, 0.0));
        assert!(trace_passes_ratio(5, 0.5));
        assert!(!trace_passes_ratio(u64::MAX as u128, 0.5));
    }

    #[test]
    fn attr_reinsert_moves_to_end() {
        let s = Span::start_with_parent("x", SpanKind::Internal, None, vec![("a", json!(1)), ("b", json!(2)), ("n", Value::Null)]);
        s.set_attr("a", 3);
        let g = s.0.lock().unwrap();
        assert_eq!(g.attrs.keys().collect::<Vec<_>>(), vec!["b", "a"]);
    }

    #[test]
    fn ok_is_final() {
        let s = Span::start_with_parent("x", SpanKind::Internal, None, vec![]);
        s.set_ok();
        s.set_error();
        assert_eq!(s.0.lock().unwrap().status, StatusCode::Ok);
    }

    #[test]
    fn recording_until_ended() {
        let s = Span::start_with_parent("x", SpanKind::Internal, None, vec![("k", json!("v"))]);
        assert!(s.is_recording());
        assert_eq!(s.status(), StatusCode::Unset);
        assert_eq!(s.attr("k"), Some(json!("v")));
        s.set_error();
        s.end();
        assert!(!s.is_recording());
        assert_eq!(s.status(), StatusCode::Error);
    }

    #[tokio::test]
    async fn scope_and_attach() {
        assert_eq!(current(), None);
        let c = SpanCtx { trace_id: 1, span_id: 2 };
        scope(None, async move {
            assert_eq!(attach(Some(c)), Some(None));
            assert_eq!(current(), Some(c));
            let inner = scope(Some(SpanCtx { trace_id: 1, span_id: 3 }), async { current() }).await;
            assert_eq!(inner.unwrap().span_id, 3);
            assert_eq!(current(), Some(c));
            assert_eq!(spawn(async { current() }).await.unwrap(), Some(c));
        })
        .await;
    }

    #[test]
    fn removes_the_legacy_metrics_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let metrics = tmp.path().join("metrics");
        std::fs::create_dir_all(metrics.join("nested")).unwrap();
        std::fs::write(metrics.join("2026-08-07.jsonl"), vec![b'x'; 100]).unwrap();
        std::fs::write(metrics.join("nested/a.jsonl"), vec![b'x'; 20]).unwrap();
        std::fs::create_dir_all(tmp.path().join("spans")).unwrap();
        assert_eq!(remove_legacy_metrics(tmp.path()), Some(120));
        assert!(!metrics.exists());
        assert!(tmp.path().join("spans").is_dir());
        assert_eq!(remove_legacy_metrics(tmp.path()), None);
    }

    #[cfg(unix)]
    #[test]
    fn leaves_a_symlinked_metrics_dir_and_its_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.jsonl"), b"x").unwrap();
        let otel = tmp.path().join("otel");
        std::fs::create_dir_all(&otel).unwrap();
        std::os::unix::fs::symlink(&target, otel.join("metrics")).unwrap();
        assert_eq!(remove_legacy_metrics(&otel), None);
        assert!(target.join("keep.jsonl").is_file());
    }
}
