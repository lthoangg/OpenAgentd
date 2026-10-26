//! Port of `app/core/logging_config.py` (loguru sinks) on top of `tracing`.
//!
//! - stderr: loguru's colourised `HH:mm:ss.SSS | LEVEL | name:function:line | message`
//!   at `OPENAGENTD_LOG_LEVEL` (default INFO).
//! - `{STATE_DIR}/logs/app/app.log`: loguru `serialize=True` JSON lines at
//!   `OPENAGENTD_FILE_LOG_LEVEL` (default DEBUG), rotated past 10 MB, rotated files
//!   older than 7 days removed on rotation.
//! - `{STATE_DIR}/logs/app/app-error.log`: same format, ERROR+, 14 days.
//!
//! Records from third-party crates are kept at WARNING+ (v2 silences
//! httpx/httpcore/uvicorn.access the same way). `RUST_LOG`, when set,
//! replaces the level logic with a tracing `EnvFilter`.
//!
//! `tracing` has no function names: the `function` field is `<module>`.

use serde_json::{json, Value};
use std::fmt::Write as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

const ROTATION_BYTES: u64 = 10 * 1000 * 1000;

/// loguru level numbers / names / icons.
fn level_info(l: &Level) -> (u32, &'static str, &'static str) {
    match *l {
        Level::TRACE => (5, "TRACE", "✏️"),
        Level::DEBUG => (10, "DEBUG", "🐞"),
        Level::INFO => (20, "INFO", "ℹ️"),
        Level::WARN => (30, "WARNING", "⚠️"),
        Level::ERROR => (40, "ERROR", "❌"),
    }
}

/// `logger.add(level=...)` by name (unknown names fall back to `default`).
pub fn parse_level(raw: &str, default: u32) -> u32 {
    match raw.trim().to_ascii_uppercase().as_str() {
        "TRACE" => 5,
        "DEBUG" => 10,
        "INFO" => 20,
        "SUCCESS" => 25,
        "WARNING" | "WARN" => 30,
        "ERROR" => 40,
        "CRITICAL" => 50,
        other => other.parse().unwrap_or(default),
    }
}

fn level_color(no: u32) -> &'static str {
    match no {
        5 => "\x1b[36m\x1b[1m",
        10 => "\x1b[34m\x1b[1m",
        30 => "\x1b[33m\x1b[1m",
        40 => "\x1b[31m\x1b[1m",
        _ => "\x1b[1m",
    }
}

/// Python `str(timedelta)` for a non-negative duration in microseconds.
fn timedelta_repr(micros: u128) -> String {
    let days = micros / 86_400_000_000;
    let rem = micros % 86_400_000_000;
    let (h, m, s, us) = (rem / 3_600_000_000, rem / 60_000_000 % 60, rem / 1_000_000 % 60, rem % 1_000_000);
    let mut out = String::new();
    if days > 0 {
        let _ = write!(out, "{days} day{}, ", if days == 1 { "" } else { "s" });
    }
    let _ = write!(out, "{h}:{m:02}:{s:02}");
    if us > 0 {
        let _ = write!(out, ".{us:06}");
    }
    out
}

fn thread_ident() -> u64 {
    let raw = format!("{:?}", std::thread::current().id());
    raw.trim_start_matches("ThreadId(").trim_end_matches(')').parse().unwrap_or(0)
}

#[derive(Default)]
struct MessageVisitor {
    message: String,
    extra: String,
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.extra, " {}={}", field.name(), value);
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            let _ = write!(self.extra, " {}={:?}", field.name(), value);
        }
    }
}

/// One loguru `FileSink` (mode "a", line buffered, size rotation, age retention).
struct FileSink {
    path: PathBuf,
    min_level: u32,
    retention_secs: u64,
    /// The open file and its size: counting the bytes written spares an
    /// `fstat` per line (the size only decides when to rotate).
    file: Mutex<Option<(std::fs::File, u64)>>,
}

fn open_append(path: &Path) -> Option<(std::fs::File, u64)> {
    let f = std::fs::OpenOptions::new().create(true).append(true).open(path).ok()?;
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    Some((f, size))
}

impl FileSink {
    fn new(path: PathBuf, min_level: u32, retention_days: u64) -> Self {
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let f = open_append(&path);
        FileSink { path, min_level, retention_secs: retention_days * 86_400, file: Mutex::new(f) }
    }

    fn write(&self, line: &str) {
        let mut g = self.file.lock().unwrap();
        if g.is_none() {
            if let Some(d) = self.path.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            *g = open_append(&self.path);
        }
        let size = g.as_ref().map(|(_, n)| *n).unwrap_or(0);
        if size + line.len() as u64 > ROTATION_BYTES {
            *g = None;
            self.rotate();
            *g = open_append(&self.path);
        }
        if let Some((f, n)) = g.as_mut() {
            if f.write_all(line.as_bytes()).is_ok() {
                *n += line.len() as u64;
            }
        }
    }

    /// `_terminate_file(is_rotating=True)`: rename to
    /// `app.<ctime %Y-%m-%d_%H-%M-%S_%f>[.N].log`, then apply retention.
    fn rotate(&self) {
        let created = std::fs::metadata(&self.path).ok().and_then(|m| m.created().or_else(|_| m.modified()).ok()).unwrap_or_else(SystemTime::now);
        let date = chrono::DateTime::<chrono::Local>::from(created).format("%Y-%m-%d_%H-%M-%S_%6f").to_string();
        let stem = self.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = self.path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let dir = self.path.parent().map(Path::to_path_buf).unwrap_or_default();
        let mut renamed = dir.join(format!("{stem}.{date}{ext}"));
        let mut counter = 1;
        while renamed.exists() {
            counter += 1;
            renamed = dir.join(format!("{stem}.{date}.{counter}{ext}"));
        }
        let _ = std::fs::rename(&self.path, &renamed);
        self.apply_retention(&dir, &stem, &ext);
    }

    /// `retention_age` over loguru's glob patterns
    /// (`app.log`, `app.log.*`, `app.*.log`, `app.*.log.*`).
    fn apply_retention(&self, dir: &Path, stem: &str, ext: &str) {
        let name = format!("{stem}{ext}");
        let cutoff = SystemTime::now().checked_sub(std::time::Duration::from_secs(self.retention_secs));
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let matches = n == name
                || n.starts_with(&format!("{name}."))
                || (n.starts_with(&format!("{stem}.")) && (n.ends_with(ext) || n.contains(&format!("{ext}."))) && n.len() > stem.len() + ext.len());
            if !matches {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            if !m.is_file() {
                continue;
            }
            if let (Some(c), Ok(mt)) = (cutoff, m.modified()) {
                if mt <= c {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}

pub struct LoguruLayer {
    stderr_level: u32,
    files: Vec<FileSink>,
    start: Instant,
    env_filter: bool,
}

fn is_own_target(target: &str) -> bool {
    target.starts_with("appv3") || target.starts_with("openagentd")
}

impl LoguruLayer {
    fn min_level(&self) -> u32 {
        self.files.iter().map(|f| f.min_level).chain([self.stderr_level]).min().unwrap_or(20)
    }

    fn passes(&self, meta: &Metadata<'_>, sink_level: u32) -> bool {
        let (no, ..) = level_info(meta.level());
        if self.env_filter {
            return true;
        }
        no >= sink_level && (is_own_target(meta.target()) || no >= 30)
    }
}

impl<S: Subscriber> Layer<S> for LoguruLayer {
    fn enabled(&self, meta: &Metadata<'_>, _ctx: Context<'_, S>) -> bool {
        self.passes(meta, self.min_level())
    }

    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut v = MessageVisitor::default();
        event.record(&mut v);
        let message = format!("{}{}", v.message, v.extra);
        let (no, lname, icon) = level_info(meta.level());
        let name = meta.module_path().unwrap_or(meta.target()).replace("::", ".");
        let function = "<module>";
        let line = meta.line().unwrap_or(0);
        let now = chrono::Local::now();
        if self.passes(meta, self.stderr_level) {
            let mut err = std::io::stderr().lock();
            let _ = writeln!(
                err,
                "\x1b[32m{}\x1b[0m | {}{lname:<8}\x1b[0m | \x1b[36m{name}\x1b[0m:\x1b[36m{function}\x1b[0m:\x1b[36m{line}\x1b[0m | {message}",
                now.format("%H:%M:%S%.3f"),
                level_color(no)
            );
        }
        let sinks: Vec<&FileSink> = self.files.iter().filter(|f| self.passes(meta, f.min_level)).collect();
        if sinks.is_empty() {
            return;
        }
        let file_path = meta.file().unwrap_or("");
        let file_name = Path::new(file_path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let module = Path::new(file_path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let elapsed = self.start.elapsed().as_micros();
        let ts_micros = now.timestamp() as i128 * 1_000_000 + now.timestamp_subsec_micros() as i128;
        let thread = std::thread::current();
        let record = json!({
            "text": format!("{} | {lname:<8} | {name}:{function}:{line} - {message}\n", now.format("%Y-%m-%d %H:%M:%S%.3f")),
            "record": {
                "elapsed": {"repr": timedelta_repr(elapsed), "seconds": elapsed as f64 / 1e6},
                "exception": Value::Null,
                "extra": {},
                "file": {"name": file_name, "path": file_path},
                "function": function,
                "level": {"icon": icon, "name": lname, "no": no},
                "line": line,
                "message": message,
                "module": module,
                "name": name,
                "process": {"id": std::process::id(), "name": "MainProcess"},
                "thread": {"id": thread_ident(), "name": thread.name().map(|n| if n == "main" { "MainThread" } else { n }).unwrap_or("Thread")},
                "time": {"repr": now.format("%Y-%m-%d %H:%M:%S%.6f%:z").to_string(), "timestamp": ts_micros as f64 / 1e6},
            },
        });
        // Same loguru record schema the log tools read; compact serde_json
        // instead of Python's json.dumps spacing (about 4x cheaper per line).
        let mut line = serde_json::to_string(&record).expect("serde_json::Value always serializes");
        line.push('\n');
        for s in sinks {
            s.write(&line);
        }
    }
}

static START: OnceLock<Instant> = OnceLock::new();

/// Record the process start (loguru's `elapsed` origin). Call first thing.
pub fn mark_start() {
    START.get_or_init(Instant::now);
}

/// `setup_logging(log_level, file_log_level)`. `files=false` keeps stderr only
/// (CLI helpers that never configured file sinks in v2).
pub fn setup(log_level: &str, file_log_level: &str, files: bool) {
    let app_dir = appv3_core::settings().state_dir.join("logs").join("app");
    let mut sinks = vec![];
    if files {
        sinks.push(FileSink::new(app_dir.join("app.log"), parse_level(file_log_level, 10), 7));
        sinks.push(FileSink::new(app_dir.join("app-error.log"), 40, 14));
    }
    let env = std::env::var("RUST_LOG").ok().filter(|v| !v.is_empty());
    let layer = LoguruLayer { stderr_level: parse_level(log_level, 20), files: sinks, start: *START.get_or_init(Instant::now), env_filter: env.is_some() };
    let reg = tracing_subscriber::registry();
    let _ = match env {
        Some(f) => reg.with(tracing_subscriber::EnvFilter::new(f)).with(layer).try_init(),
        None => reg.with(layer).try_init(),
    };
}

/// Record every panic in the structured log (`app-error.log`) as well.
/// Panics are caught per request and per agent turn, so without this the
/// only trace would be the default hook's line on stderr.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        tracing::error!("panic thread={} location={} message={}", thread, location, appv3_core::panic_message(info.payload()));
        default(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timedelta_forms() {
        assert_eq!(timedelta_repr(616_860), "0:00:00.616860");
        assert_eq!(timedelta_repr(1_000_000), "0:00:01");
        assert_eq!(timedelta_repr(86_400_000_000 + 3_723_000_001), "1 day, 1:02:03.000001");
        assert_eq!(timedelta_repr(2 * 86_400_000_000), "2 days, 0:00:00");
    }

    #[test]
    fn file_records_are_compact_loguru_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        let layer = LoguruLayer { stderr_level: 100, files: vec![FileSink::new(path.clone(), 10, 7)], start: Instant::now(), env_filter: false };
        let sub = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(sub, || tracing::info!(target: "appv3_test", call_id = "c1", "tool_start name=shell Tiếng Việt"));
        let line = std::fs::read_to_string(&path).unwrap();
        assert!(line.ends_with('\n') && line.lines().count() == 1, "{line}");
        assert!(line.contains("Tiếng Việt"), "non-ASCII stays verbatim: {line}");
        assert!(!line.contains("\", \"") && !line.contains("\": "), "compact separators: {line}");
        let v: Value = serde_json::from_str(&line).unwrap();
        let rec = &v["record"];
        assert_eq!(rec["message"], "tool_start name=shell Tiếng Việt call_id=c1");
        assert_eq!(rec["level"]["name"], "INFO");
        assert!(rec["time"]["repr"].is_string() && rec["time"]["timestamp"].is_f64());
        assert!(v["text"].as_str().unwrap().contains(" | INFO     | "));
    }

    #[test]
    fn levels() {
        assert_eq!(parse_level("warning", 20), 30);
        assert_eq!(parse_level("bogus", 20), 20);
    }

    #[test]
    fn rotation_and_retention() {
        let dir = std::env::temp_dir().join(format!("oad-logrot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("app.2000-01-01_00-00-00_000000.log");
        std::fs::write(&old, "x").unwrap();
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(SystemTime::now() - std::time::Duration::from_secs(8 * 86_400)).unwrap();
        drop(f); // Windows cannot delete a file that is still open.
        std::fs::write(dir.join("app-error.log"), "keep").unwrap();
        let sink = FileSink::new(dir.join("app.log"), 10, 7);
        let big = "y".repeat(6_000_000);
        sink.write(&big);
        sink.write(&big);
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(!names.contains(&"app.2000-01-01_00-00-00_000000.log".to_string()), "{names:?}");
        assert!(names.contains(&"app-error.log".to_string()));
        assert_eq!(names.iter().filter(|n| n.starts_with("app.") && n.ends_with(".log") && *n != "app.log").count(), 1, "{names:?}");
        assert_eq!(std::fs::metadata(dir.join("app.log")).unwrap().len(), 6_000_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
