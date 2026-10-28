//! Port of `app/core/{otel,jsonl_writer,otel_retention}.py` — file-based
//! OpenTelemetry-shaped spans and metrics, no external service.
//!
//! Layout (unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set):
//!   `{STATE_DIR}/otel/spans/YYYY-MM-DD-HH.jsonl`  (hourly, by span end)
//!   `{STATE_DIR}/otel/metrics/YYYY-MM-DD.jsonl`   (daily)
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
    metrics: JsonlWriter,
    service: String,
    ratio: f64,
    slow_ns: u64,
    metric_thread_stop: Mutex<Option<SyncSender<()>>>,
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
    let metrics = JsonlWriter::new(dir.join("metrics"), daily_partition, "metrics");
    let o = Otel { spans, metrics, service: service_name.to_string(), ratio: sample_ratio(), slow_ns: slow_span_threshold_ns(), metric_thread_stop: Mutex::new(None) };
    if OTEL.set(o).is_err() {
        return;
    }
    let (tx, rx) = sync_channel::<()>(1);
    *OTEL.get().unwrap().metric_thread_stop.lock().unwrap() = Some(tx);
    std::thread::Builder::new()
        .name("otel-metrics".into())
        .spawn(move || loop {
            match rx.recv_timeout(Duration::from_secs(60)) {
                Err(RecvTimeoutError::Timeout) => export_metrics(),
                _ => return,
            }
        })
        .ok();
    tracing::info!("otel_setup_complete service={} spans_dir={} metrics_dir={}", service_name, dir.join("spans").display(), dir.join("metrics").display());
}

/// `shutdown_otel` — final metric export, flush and close the writers.
pub fn shutdown() {
    let Some(o) = OTEL.get() else { return };
    if let Some(tx) = o.metric_thread_stop.lock().unwrap().take() {
        let _ = tx.try_send(());
        export_metrics();
    }
    if let Some(w) = &o.spans {
        w.close();
    }
    o.metrics.close();
}

/// Flush pending span/metric records now (tests and harnesses).
pub fn flush() {
    if let Some(o) = OTEL.get() {
        if let Some(w) = &o.spans {
            w.flush_now();
        }
        o.metrics.flush_now();
    }
}

// ── JSONL batch writer ──────────────────────────────────────────────────────

pub fn hourly_partition(ts: DateTime<Utc>) -> String {
    ts.format("%Y-%m-%d-%H").to_string()
}

pub fn daily_partition(ts: DateTime<Utc>) -> String {
    ts.format("%Y-%m-%d").to_string()
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

// ── metrics ─────────────────────────────────────────────────────────────────

const DEFAULT_BOUNDS: [f64; 15] = [0.0, 5.0, 10.0, 25.0, 50.0, 75.0, 100.0, 250.0, 500.0, 750.0, 1000.0, 2500.0, 5000.0, 7500.0, 10000.0];

#[derive(Clone)]
enum Num {
    I(i64),
    F(f64),
}

impl Num {
    fn f(&self) -> f64 {
        match self {
            Num::I(i) => *i as f64,
            Num::F(f) => *f,
        }
    }
    fn add(&self, o: &Num) -> Num {
        match (self, o) {
            (Num::I(a), Num::I(b)) => Num::I(a + b),
            _ => Num::F(self.f() + o.f()),
        }
    }
    fn repr(&self) -> String {
        match self {
            Num::I(i) => i.to_string(),
            Num::F(f) => crate::pyjson::float_repr(*f),
        }
    }
}

type Attrs = Vec<(String, Value)>;

fn same_attrs(a: &Attrs, b: &Attrs) -> bool {
    a.len() == b.len() && a.iter().all(|(k, v)| b.iter().any(|(k2, v2)| k == k2 && v == v2))
}

/// A measurement taken while a (sampled) span was current — the SDK's
/// `TraceBasedExemplarFilter`.
#[derive(Clone)]
struct Exemplar {
    value: Num,
    time: u64,
    span_id: u64,
    trace_id: u128,
}

impl Exemplar {
    fn new(v: &Num, ctx: Option<SpanCtx>) -> Option<Exemplar> {
        ctx.map(|c| Exemplar { value: v.clone(), time: now_ns(), span_id: c.span_id, trace_id: c.trace_id })
    }
    fn repr(&self) -> String {
        format!("Exemplar(filtered_attributes={{}}, value={}, time_unix_nano={}, span_id={}, trace_id={})", self.value.repr(), self.time, self.span_id, self.trace_id)
    }
}

struct HistPoint {
    attrs: Attrs,
    start: u64,
    count: u64,
    sum: Num,
    buckets: [u64; 16],
    min: Num,
    max: Num,
    /// `AlignedHistogramBucketExemplarReservoir`: last measurement per bucket
    /// since the previous collection.
    exemplars: [Option<Exemplar>; 16],
}

struct SumPoint {
    attrs: Attrs,
    start: u64,
    value: Num,
    /// `SimpleFixedSizeExemplarReservoir(size=1)`.
    exemplar: Option<Exemplar>,
    seen: u64,
}

enum Points {
    Hist(Vec<HistPoint>),
    Sum(Vec<SumPoint>),
}

struct Instrument {
    name: String,
    description: String,
    unit: String,
    points: Points,
    /// Sequence of the first measurement: the Python SDK's reader storage
    /// creates per-instrument state lazily, so export order is
    /// first-measurement order, not creation order.
    first_seen: u64,
}

fn mark_seen(i: &mut Instrument) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if i.first_seen == u64::MAX {
        i.first_seen = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn instruments() -> &'static Mutex<Vec<Instrument>> {
    static I: OnceLock<Mutex<Vec<Instrument>>> = OnceLock::new();
    I.get_or_init(|| Mutex::new(vec![]))
}

fn register(name: &str, description: &str, unit: &str, hist: bool) {
    let mut g = instruments().lock().unwrap();
    if g.iter().any(|i| i.name == name) {
        return;
    }
    g.push(Instrument {
        name: name.into(),
        description: description.into(),
        unit: unit.into(),
        points: if hist { Points::Hist(vec![]) } else { Points::Sum(vec![]) },
        first_seen: u64::MAX,
    });
}

fn to_num(v: &Value) -> Num {
    match v.as_i64() {
        Some(i) if !v.is_f64() => Num::I(i),
        _ => Num::F(v.as_f64().unwrap_or(0.0)),
    }
}

fn attrs_of(attrs: Vec<(&str, Value)>) -> Attrs {
    attrs.into_iter().filter(|(_, v)| valid_attr(v)).map(|(k, v)| (k.to_string(), v)).collect()
}

/// A histogram instrument (`meter.create_histogram`).
#[derive(Clone, Copy)]
pub struct Histogram {
    name: &'static str,
}

pub fn histogram(name: &'static str, description: &str, unit: &str) -> Histogram {
    register(name, description, unit, true);
    Histogram { name }
}

impl Histogram {
    /// Record under the current span context.
    pub fn record(&self, value: impl Into<Value>, attrs: Vec<(&str, Value)>) {
        self.record_in(current(), value, attrs)
    }

    /// Record with an explicit span context (the span the measurement was
    /// taken in, for the exemplar).
    pub fn record_in(&self, ctx: Option<SpanCtx>, value: impl Into<Value>, attrs: Vec<(&str, Value)>) {
        let v = to_num(&value.into());
        let ex = Exemplar::new(&v, ctx);
        let attrs = attrs_of(attrs);
        let mut g = instruments().lock().unwrap();
        let Some(inst) = g.iter_mut().find(|i| i.name == self.name) else { return };
        mark_seen(inst);
        let Instrument { points: Points::Hist(pts), .. } = inst else { return };
        let idx = DEFAULT_BOUNDS.iter().position(|b| v.f() <= *b).unwrap_or(DEFAULT_BOUNDS.len());
        match pts.iter_mut().find(|p| same_attrs(&p.attrs, &attrs)) {
            Some(p) => {
                p.count += 1;
                p.sum = p.sum.add(&v);
                p.buckets[idx] += 1;
                if ex.is_some() {
                    p.exemplars[idx] = ex;
                }
                if v.f() < p.min.f() {
                    p.min = v.clone();
                }
                if v.f() > p.max.f() {
                    p.max = v;
                }
            }
            None => {
                let mut buckets = [0u64; 16];
                buckets[idx] = 1;
                let mut exemplars: [Option<Exemplar>; 16] = Default::default();
                exemplars[idx] = ex;
                pts.push(HistPoint { attrs, start: now_ns(), count: 1, sum: v.clone(), buckets, min: v.clone(), max: v, exemplars });
            }
        }
    }
}

/// A monotonic counter instrument (`meter.create_counter`).
#[derive(Clone, Copy)]
pub struct Counter {
    name: &'static str,
}

pub fn counter(name: &'static str, description: &str) -> Counter {
    register(name, description, "", false);
    Counter { name }
}

impl Counter {
    pub fn add(&self, value: impl Into<Value>, attrs: Vec<(&str, Value)>) {
        let v = to_num(&value.into());
        let ex = Exemplar::new(&v, current());
        let attrs = attrs_of(attrs);
        let mut g = instruments().lock().unwrap();
        let Some(inst) = g.iter_mut().find(|i| i.name == self.name) else { return };
        mark_seen(inst);
        let Instrument { points: Points::Sum(pts), .. } = inst else { return };
        let idx = match pts.iter().position(|p| same_attrs(&p.attrs, &attrs)) {
            Some(i) => {
                pts[i].value = pts[i].value.add(&v);
                i
            }
            None => {
                pts.push(SumPoint { attrs, start: now_ns(), value: v, exemplar: None, seen: 0 });
                pts.len() - 1
            }
        };
        if ex.is_some() {
            // `randrange(0, seen) < 1` — the first offer always lands.
            let p = &mut pts[idx];
            p.seen += 1;
            if uuid::Uuid::new_v4().as_u128().is_multiple_of(p.seen as u128) {
                p.exemplar = ex;
            }
        }
    }
}

fn py_value_repr(v: &Value) -> String {
    match v {
        Value::String(s) => py_str_repr(s),
        Value::Bool(b) => {
            if *b {
                "True".into()
            } else {
                "False".into()
            }
        }
        Value::Number(_) => to_num(v).repr(),
        Value::Array(a) => format!("({}{})", a.iter().map(py_value_repr).collect::<Vec<_>>().join(", "), if a.len() == 1 { "," } else { "" }),
        _ => "None".into(),
    }
}

fn py_str_repr(s: &str) -> String {
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
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

fn attrs_repr(a: &Attrs) -> String {
    format!("{{{}}}", a.iter().map(|(k, v)| format!("{}: {}", py_str_repr(k), py_value_repr(v))).collect::<Vec<_>>().join(", "))
}

/// Collect every instrument with data into v2's `{"metrics": [...]}` shape
/// (`data` is the Python SDK's dataclass `repr`).
pub fn collect_metrics() -> Option<Value> {
    let now = now_ns();
    let mut g = instruments().lock().unwrap();
    let mut ordered: Vec<&mut Instrument> = g.iter_mut().collect();
    ordered.sort_by_key(|i| i.first_seen);
    let mut out = vec![];
    for i in ordered {
        let data = match &mut i.points {
            Points::Hist(p) if !p.is_empty() => {
                // Exemplar reservoirs reset on every collection.
                let exs: Vec<String> = p.iter_mut().map(|h| std::mem::take(&mut h.exemplars).iter().flatten().map(Exemplar::repr).collect::<Vec<_>>().join(", ")).collect();
                let bounds = format!("({})", DEFAULT_BOUNDS.iter().map(|b| crate::pyjson::float_repr(*b)).collect::<Vec<_>>().join(", "));
                let pts: Vec<String> = p
                    .iter()
                    .zip(exs)
                    .map(|(h, ex)| {
                        format!(
                            "HistogramDataPoint(attributes={}, start_time_unix_nano={}, time_unix_nano={now}, count={}, sum={}, bucket_counts=({}), explicit_bounds={bounds}, min={}, max={}, exemplars=[{ex}])",
                            attrs_repr(&h.attrs),
                            h.start,
                            h.count,
                            h.sum.repr(),
                            h.buckets.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", "),
                            h.min.repr(),
                            h.max.repr()
                        )
                    })
                    .collect();
                format!("Histogram(data_points=[{}], aggregation_temporality=<AggregationTemporality.CUMULATIVE: 2>)", pts.join(", "))
            }
            Points::Sum(p) if !p.is_empty() => {
                let pts: Vec<String> = p
                    .iter_mut()
                    .map(|s| {
                        let ex = s.exemplar.take().map(|e| e.repr()).unwrap_or_default();
                        s.seen = 0;
                        format!(
                            "NumberDataPoint(attributes={}, start_time_unix_nano={}, time_unix_nano={now}, value={}, exemplars=[{ex}])",
                            attrs_repr(&s.attrs),
                            s.start,
                            s.value.repr()
                        )
                    })
                    .collect();
                format!("Sum(data_points=[{}], aggregation_temporality=<AggregationTemporality.CUMULATIVE: 2>, is_monotonic=True)", pts.join(", "))
            }
            _ => continue,
        };
        out.push(json!({"name": i.name, "description": i.description, "unit": i.unit, "data": data}));
    }
    (!out.is_empty()).then(|| json!({"metrics": out}))
}

fn export_metrics() {
    let Some(o) = OTEL.get() else { return };
    if let Some(m) = collect_metrics() {
        o.metrics.write(m, Utc::now());
    }
}

// ── retention ───────────────────────────────────────────────────────────────

fn int_env(name: &str, default: i64, min: i64) -> i64 {
    match crate::settings::env_var(name) {
        None => default,
        Some(raw) => py_int(&raw).map(|v| v.max(min)).unwrap_or(default),
    }
}

/// Whether the retention sweep runs (`OPENAGENTD_OTEL_RETENTION_ENABLED`, default on).
pub fn retention_enabled() -> bool {
    match crate::settings::env_var("OPENAGENTD_OTEL_RETENTION_ENABLED") {
        None => true,
        Some(raw) => ["1", "true", "yes", "on"].contains(&raw.trim().to_lowercase().as_str()),
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

/// Days spans and metrics are kept: the `telemetry.retention_days` setting.
/// Read on every sweep, so a change in Settings applies without a restart.
fn retention_days() -> i64 {
    crate::runtime_settings::telemetry_settings().retention_days()
}

/// One retention pass over spans and metrics.
pub fn run_retention_once(otel_dir: Option<&Path>) -> (SweepResult, SweepResult) {
    let base = otel_dir.map(Path::to_path_buf).unwrap_or_else(|| crate::settings().state_dir.join("otel"));
    let days = retention_days();
    let s = sweep_old_partitions(&base.join("spans"), days, None);
    let m = sweep_old_partitions(&base.join("metrics"), days, None);
    if s.deleted > 0 || m.deleted > 0 {
        tracing::info!(
            "otel_retention_swept spans_deleted={} spans_bytes={} metrics_deleted={} metrics_bytes={} days={}",
            s.deleted,
            s.bytes_freed,
            m.deleted,
            m.bytes_freed,
            days
        );
    } else {
        tracing::debug!("otel_retention_swept nothing_to_delete spans_scanned={} metrics_scanned={}", s.scanned, m.scanned);
    }
    (s, m)
}

fn retention_task() -> &'static Mutex<Option<tokio::task::JoinHandle<()>>> {
    static T: OnceLock<Mutex<Option<tokio::task::JoinHandle<()>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
}

/// `start_otel_retention` — one sweep now, then every interval.
pub fn start_retention() {
    if !retention_enabled() {
        tracing::info!("otel_retention_disabled");
        return;
    }
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
/// changes), unless retention is disabled. Needs a Tokio runtime.
pub fn sweep_retention_now() {
    if !retention_enabled() {
        return;
    }
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
    fn metrics_repr() {
        let h = histogram("t.h", "desc", "s");
        h.record(0.5, vec![("k", json!("v"))]);
        h.record(7, vec![("k", json!("v"))]);
        let c = counter("t.c", "count");
        c.add(1, vec![("a", json!("x"))]);
        c.add(1, vec![("a", json!("x"))]);
        let m = collect_metrics().unwrap().to_string();
        assert!(m.contains("count=2, sum=7.5, bucket_counts=(0, 1, 1, 0"));
        assert!(m.contains("min=0.5, max=7"));
        assert!(m.contains("value=2, exemplars=[]"));
    }
}
