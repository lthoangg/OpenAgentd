//! Background `shell` commands. Each gets a number, a log file and a record
//! file in its session's `commands/` folder, and stays in the session's
//! list until it ends. The agent crate installs a handler
//! ([`set_event_handler`]) that turns a start or an end into an event and,
//! for a lead's command, a message to the session.

use crate::shell::{strip_ansi_bytes, terminate};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch};

/// The folder under a session's artifacts that holds `<n>.log` and `<n>.json`.
pub const DIR: &str = "commands";
/// Turn metadata: `true` in a turn whose session is told when its commands
/// end (a lead's). A subagent's turn end is its report, so it is not told.
pub const REPORTS_META: &str = "command_reports";
/// How long a command the session waits for may run before it is ended.
pub const WAIT_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);
/// The log keeps at least this much of the newest output.
const LOG_KEEP_BYTES: u64 = 10 * 1024 * 1024;
const TAIL_BYTES: usize = 64 * 1024;
/// What an end report quotes from the end of the output.
pub const TAIL_LINES: usize = 40;
const TAIL_CHARS: usize = 8_000;
/// How long output is still read after the command itself ended: a process
/// it left behind may hold the pipe open for ever.
const READER_GRACE: Duration = Duration::from_secs(1);

/// A background command, as started.
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub session_id: String,
    /// Counts from 1 within the session.
    pub number: u64,
    pub pid: u32,
    pub command: String,
    pub description: String,
    /// The session counts as working until this ends.
    pub wait: bool,
    /// The session is told when this ends (see [`REPORTS_META`]).
    pub reports: bool,
    /// Unix seconds.
    pub started_at: u64,
    pub log_path: PathBuf,
}

/// Why a command is no longer running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    /// It ended by itself.
    Exited,
    /// It ran into its limit ([`WAIT_LIMIT`]) and was ended.
    TimedOut,
    /// The user stopped this command from the session's list.
    StoppedByUser,
    /// The user stopped the session's turn.
    TurnStopped,
    SessionDeleted,
    /// The server shut down. The next start reports it ([`take_cut_off`]).
    Shutdown,
}

impl End {
    pub fn as_str(self) -> &'static str {
        match self {
            End::Exited => "exited",
            End::TimedOut => "timed_out",
            End::StoppedByUser => "stopped_by_user",
            End::TurnStopped => "turn_stopped",
            End::SessionDeleted => "session_deleted",
            End::Shutdown => "shutdown",
        }
    }

    /// Whether the agent hears of this end. Stopping the turn or deleting
    /// the session must not start another turn, and a shutdown is reported
    /// by the next start.
    pub fn tells_agent(self) -> bool {
        matches!(self, End::Exited | End::TimedOut | End::StoppedByUser)
    }
}

/// A command that ended, with the end of its output.
#[derive(Clone, Debug)]
pub struct Ended {
    pub job: Job,
    pub end: End,
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub ran: Duration,
    /// The last [`TAIL_LINES`] lines of output, ANSI codes removed.
    pub tail: String,
    /// Lines of output in all.
    pub lines: usize,
}

impl Ended {
    pub fn succeeded(&self) -> bool {
        self.end == End::Exited && self.code == Some(0) && self.signal.is_none()
    }
}

#[derive(Clone, Debug)]
pub enum Event {
    Started(Job),
    Ended(Arc<Ended>),
}

type Handler = Box<dyn Fn(Event) + Send + Sync>;

static HANDLER: OnceLock<Handler> = OnceLock::new();

/// Wire starts and ends to the session runtime (lives in the agent crate).
pub fn set_event_handler(f: impl Fn(Event) + Send + Sync + 'static) {
    let _ = HANDLER.set(Box::new(f));
}

fn emit(event: Event) {
    if let Some(h) = HANDLER.get() {
        h(event);
    }
}

type Outcome = watch::Receiver<Option<Arc<Ended>>>;

struct Live {
    job: Job,
    stop: mpsc::UnboundedSender<End>,
    outcome: Outcome,
}

#[derive(Default)]
struct Session {
    /// The last number given out; 0 until the folder was read.
    last: u64,
    live: BTreeMap<u64, Live>,
}

fn reg() -> &'static Mutex<HashMap<String, Session>> {
    static R: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// The list's key for a session: its id without hyphens, so the stored
/// (hex) form and the API's hyphenated form name the same session.
pub fn key(session_id: &str) -> String {
    session_id.chars().filter(|c| *c != '-').collect::<String>().to_ascii_lowercase()
}

/// The commands of `session_id` still running, oldest first.
pub fn running(session_id: &str) -> Vec<Job> {
    reg().lock().unwrap().get(&key(session_id)).map(|s| s.live.values().map(|l| l.job.clone()).collect()).unwrap_or_default()
}

/// Whether `session_id` waits for a command still running.
pub fn has_waited(session_id: &str) -> bool {
    reg().lock().unwrap().get(&key(session_id)).is_some_and(|s| s.live.values().any(|l| l.job.wait))
}

/// Every session that [`has_waited`], by [`key`].
pub fn sessions_waiting() -> Vec<String> {
    reg().lock().unwrap().iter().filter(|(_, s)| s.live.values().any(|l| l.job.wait)).map(|(id, _)| id.clone()).collect()
}

/// Resolves to how command `number` of `session_id` ended; `None` when it
/// is not running.
pub fn outcome(session_id: &str, number: u64) -> Option<Outcome> {
    reg().lock().unwrap().get(&key(session_id)).and_then(|s| s.live.get(&number)).map(|l| l.outcome.clone())
}

/// What [`start`] needs beside the prepared command.
pub struct Start<'a> {
    pub session_id: &'a str,
    /// The session's [`DIR`] folder.
    pub dir: PathBuf,
    pub command: &'a str,
    pub description: &'a str,
    pub wait: bool,
    pub reports: bool,
    /// End it after this long ([`WAIT_LIMIT`] for a waited command).
    pub limit: Option<Duration>,
}

/// Start `cmd` (program, arguments, directory and environment already set)
/// as a background command: its output goes to a log, and it is ended with
/// its process group when it is stopped or runs into its limit.
pub fn start(mut cmd: tokio::process::Command, spec: Start<'_>) -> std::io::Result<Job> {
    std::fs::create_dir_all(&spec.dir)?;
    let (reader, writer) = os_pipe::pipe()?;
    let writer2 = writer.try_clone()?;
    // The task that supervises the child owns it: if that task is dropped
    // with its runtime, the command does not outlive it unwatched.
    cmd.stdout(writer).stderr(writer2).kill_on_drop(true);
    let output = output_reader(reader)?;
    // The number is taken and the command listed under one lock, so two
    // calls of one turn never share a number.
    let mut r = reg().lock().unwrap();
    let session = r.entry(key(spec.session_id)).or_default();
    if session.last == 0 {
        session.last = last_recorded(&spec.dir);
    }
    let number = session.last.checked_add(1).ok_or_else(|| std::io::Error::other("this session has no command numbers left"))?;
    let log_path = spec.dir.join(format!("{number}.log"));
    let log = Log::create(log_path.clone(), LOG_KEEP_BYTES)?;
    let child = cmd.spawn()?;
    drop(cmd); // closes our copies of the pipe's write ends
    session.last = number;
    let job = Job {
        session_id: spec.session_id.to_string(),
        number,
        pid: child.id().unwrap_or(0),
        command: spec.command.to_string(),
        description: spec.description.to_string(),
        wait: spec.wait,
        reports: spec.reports,
        started_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        log_path,
    };
    let record = spec.dir.join(format!("{number}.json"));
    write_record(&record, &job, "running", None);
    let (stop_tx, stop_rx) = mpsc::unbounded_channel();
    let (done_tx, done_rx) = watch::channel(None);
    session.live.insert(number, Live { job: job.clone(), stop: stop_tx, outcome: done_rx });
    drop(r);
    tracing::info!("shell_background_started session_id={} number={} pid={} wait={} command={}", job.session_id, number, job.pid, job.wait, crate::shell::clip(&job.command));
    let log = Arc::new(Mutex::new(log));
    let reading = tokio::spawn(read_output(output, log.clone()));
    tokio::spawn(supervise(Supervised { child, job: job.clone(), stop: stop_rx, limit: spec.limit, reading, log, done: done_tx, record }));
    emit(Event::Started(job.clone()));
    Ok(job)
}

/// What the model reads when its background call returns.
pub fn started_text(job: &Job) -> String {
    let report = match (job.reports, job.wait) {
        (true, true) => "Its result arrives as a message when it exits, so do not poll for it: go on with other work or end your turn. It is ended after 2 hours.",
        (true, false) => {
            "It keeps running after your turn. If it exits, a message says so: at once while you are working, otherwise when your next turn starts. Read the log to check on it."
        }
        (false, _) => "No message arrives when it exits; read the log to check on it.",
    };
    let end = if cfg!(windows) { format!("taskkill /PID {} /T /F", job.pid) } else { format!("kill -- -{}", job.pid) };
    format!("[Started in the background: command {}]\nOutput: {}\n{report} To end it early: {end}", job.number, job.log_path.display())
}

/// The read end of the command's output. On Unix it is read without a
/// blocked thread, so giving up on it (a process the command left behind
/// keeps the pipe open) leaves nothing behind.
#[cfg(unix)]
fn output_reader(pipe: os_pipe::PipeReader) -> std::io::Result<tokio::net::unix::pipe::Receiver> {
    tokio::net::unix::pipe::Receiver::from_owned_fd(pipe.into())
}

#[cfg(not(unix))]
fn output_reader(pipe: os_pipe::PipeReader) -> std::io::Result<tokio::fs::File> {
    Ok(tokio::fs::File::from_std(crate::shell::unsafe_file_from_reader(pipe)))
}

async fn read_output(mut pipe: impl tokio::io::AsyncRead + Unpin, log: Arc<Mutex<Log>>) {
    let mut buf = vec![0u8; 8192];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => log.lock().unwrap().add(&buf[..n]),
        }
    }
}

struct Supervised {
    child: tokio::process::Child,
    job: Job,
    stop: mpsc::UnboundedReceiver<End>,
    limit: Option<Duration>,
    reading: tokio::task::JoinHandle<()>,
    log: Arc<Mutex<Log>>,
    done: watch::Sender<Option<Arc<Ended>>>,
    record: PathBuf,
}

/// Owns the child until it ends. Only this task signals it, and only before
/// it is reaped, so a signal never reaches a process that reused its pid.
async fn supervise(s: Supervised) {
    let Supervised { mut child, job, mut stop, limit, mut reading, log, done, record } = s;
    let started = Instant::now();
    let over_limit = async {
        match limit {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending().await,
        }
    };
    let (status, end) = tokio::select! {
        st = child.wait() => (st.ok(), End::Exited),
        Some(end) = stop.recv() => (terminate(job.pid, &mut child).await, end),
        _ = over_limit => (terminate(job.pid, &mut child).await, End::TimedOut),
    };
    if tokio::time::timeout(READER_GRACE, &mut reading).await.is_err() {
        reading.abort();
    }
    let (code, signal) = crate::shell::exit_parts(status);
    let (tail, lines) = {
        let l = log.lock().unwrap();
        (l.tail_text(), l.lines())
    };
    let ended = Arc::new(Ended { job, end, code, signal, ran: started.elapsed(), tail, lines });
    write_record(&record, &ended.job, end.as_str(), Some(&ended));
    // Off the list before anyone hears of it: the session no longer waits.
    if let Some(session) = reg().lock().unwrap().get_mut(&key(&ended.job.session_id)) {
        session.live.remove(&ended.job.number);
    }
    tracing::info!("shell_background_ended session_id={} number={} end={} exit_code={:?} lines={}", ended.job.session_id, ended.job.number, end.as_str(), code, lines);
    let _ = done.send(Some(ended.clone()));
    emit(Event::Ended(ended));
}

/// How long a stop waits for the command to be gone: past the shell tool's
/// SIGTERM grace, its wait after SIGKILL, and [`READER_GRACE`].
const STOP_LIMIT: Duration = Duration::from_secs(10);

async fn stop_these(targets: Vec<(mpsc::UnboundedSender<End>, Outcome)>, end: End) -> usize {
    for (stop, _) in &targets {
        let _ = stop.send(end);
    }
    let mut stopped = 0;
    for (_, mut outcome) in targets {
        if tokio::time::timeout(STOP_LIMIT, outcome.wait_for(Option::is_some)).await.is_ok_and(|r| r.is_ok()) {
            stopped += 1;
        }
    }
    stopped
}

/// End command `number` of `session_id` and wait until it is gone. `false`
/// when it was not running.
pub async fn stop(session_id: &str, number: u64, end: End) -> bool {
    let target = reg().lock().unwrap().get(&key(session_id)).and_then(|s| s.live.get(&number)).map(|l| (l.stop.clone(), l.outcome.clone()));
    match target {
        Some(t) => stop_these(vec![t], end).await == 1,
        None => false,
    }
}

/// End the commands of `session_id` (only those it waits for with
/// `only_waited`) and wait until they are gone. Returns how many ended.
pub async fn stop_session(session_id: &str, end: End, only_waited: bool) -> usize {
    let targets: Vec<_> = reg()
        .lock()
        .unwrap()
        .get(&key(session_id))
        .map(|s| s.live.values().filter(|l| l.job.wait || !only_waited).map(|l| (l.stop.clone(), l.outcome.clone())).collect())
        .unwrap_or_default();
    stop_these(targets, end).await
}

/// End every command of every session (the server shuts down).
pub async fn stop_all(end: End) -> usize {
    let targets: Vec<_> = reg().lock().unwrap().values().flat_map(|s| s.live.values().map(|l| (l.stop.clone(), l.outcome.clone()))).collect();
    stop_these(targets, end).await
}

// ── records on disk ──────────────────────────────────────────────────────────

fn write_record(path: &Path, job: &Job, state: &str, ended: Option<&Ended>) {
    let mut v = json!({
        "number": job.number,
        "pid": job.pid,
        "command": job.command,
        "description": job.description,
        "wait": job.wait,
        "reports": job.reports,
        "started_at": job.started_at,
        "state": state,
    });
    if let Some(e) = ended {
        v["exit_code"] = json!(e.code);
        v["signal"] = json!(e.signal);
        v["ran_seconds"] = json!(e.ran.as_secs());
    }
    if let Err(e) = std::fs::write(path, v.to_string()) {
        tracing::warn!("shell_background_record_failed path={} error={}", path.display(), e);
    }
}

/// The highest command number recorded in `dir`.
fn last_recorded(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries.flatten().filter_map(|e| e.path().file_stem()?.to_str()?.parse::<u64>().ok()).max().unwrap_or(0)
}

/// The commands a server that shut down or crashed left behind, each taken
/// once: every record under `sessions_root` that still reads running (or
/// ended by the shutdown) and is not running in this process. Their
/// processes are not signalled: a pid from an earlier run may be anyone's.
pub fn take_cut_off(sessions_root: &Path) -> Vec<Job> {
    let mut out = vec![];
    let Ok(sessions) = std::fs::read_dir(sessions_root) else { return out };
    for session in sessions.flatten() {
        let session_id = session.file_name().to_string_lossy().into_owned();
        let dir = session.path().join(DIR);
        let Ok(records) = std::fs::read_dir(&dir) else { continue };
        for record in records.flatten().map(|r| r.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
            let Some(mut v) = std::fs::read_to_string(&record).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
            let Some(number) = v.get("number").and_then(Value::as_u64) else { continue };
            if !matches!(v.get("state").and_then(Value::as_str), Some("running" | "shutdown")) || outcome(&session_id, number).is_some() {
                continue;
            }
            let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
            out.push(Job {
                session_id: session_id.clone(),
                number,
                pid: v.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32,
                command: text("command"),
                description: text("description"),
                wait: flag("wait"),
                reports: flag("reports"),
                started_at: v.get("started_at").and_then(Value::as_u64).unwrap_or(0),
                log_path: dir.join(format!("{number}.log")),
            });
            v["state"] = json!("cut_off");
            if let Err(e) = std::fs::write(&record, v.to_string()) {
                tracing::warn!("shell_background_record_failed path={} error={}", record.display(), e);
            }
        }
    }
    out.sort_by(|a, b| (&a.session_id, a.number).cmp(&(&b.session_id, b.number)));
    out
}

// ── the log ──────────────────────────────────────────────────────────────────

/// A command's output on disk, ANSI codes removed, with its end kept in
/// memory for the report. The file is cut back to its newest `keep` bytes
/// each time it reaches twice that.
struct Log {
    path: PathBuf,
    file: Option<std::fs::File>,
    size: u64,
    keep: u64,
    tail: VecDeque<u8>,
    newlines: usize,
    last: Option<u8>,
}

impl Log {
    fn create(path: PathBuf, keep: u64) -> std::io::Result<Self> {
        let file = std::fs::File::create(&path)?;
        Ok(Self { path, file: Some(file), size: 0, keep, tail: VecDeque::new(), newlines: 0, last: None })
    }

    fn add(&mut self, chunk: &[u8]) {
        let clean = strip_ansi_bytes(chunk);
        let Some(&last) = clean.last() else { return };
        self.newlines += clean.iter().filter(|b| **b == b'\n').count();
        self.last = Some(last);
        self.tail.extend(&clean);
        let over = self.tail.len().saturating_sub(TAIL_BYTES);
        self.tail.drain(..over);
        if let Some(f) = self.file.as_mut() {
            if f.write_all(&clean).is_err() {
                self.file = None;
                return;
            }
            self.size += clean.len() as u64;
            if self.size >= self.keep * 2 {
                self.cut_back();
            }
        }
    }

    /// Rewrite the file as its newest `keep` bytes, from a line start.
    fn cut_back(&mut self) {
        self.file = None;
        let Ok(all) = std::fs::read(&self.path) else { return };
        let cut = all.len().saturating_sub(self.keep as usize);
        let from = all[cut..].iter().position(|b| *b == b'\n').map_or(cut, |i| cut + i + 1);
        let mut kept = format!("...earlier output dropped ({from} bytes)...\n").into_bytes();
        kept.extend_from_slice(&all[from..]);
        if std::fs::write(&self.path, &kept).is_ok() {
            self.size = kept.len() as u64;
            self.file = std::fs::OpenOptions::new().append(true).open(&self.path).ok();
        }
    }

    /// Lines of output so far; an unfinished last line counts.
    fn lines(&self) -> usize {
        self.newlines + usize::from(self.last.is_some_and(|b| b != b'\n'))
    }

    /// The last [`TAIL_LINES`] lines, at most [`TAIL_CHARS`] characters.
    fn tail_text(&self) -> String {
        let bytes: Vec<u8> = self.tail.iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes);
        let text = text.trim_start_matches('\u{FFFD}').trim_end_matches('\n');
        let lines: Vec<&str> = text.split('\n').collect();
        let text = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
        let n = text.chars().count();
        if n > TAIL_CHARS {
            text.chars().skip(n - TAIL_CHARS).collect()
        } else {
            text
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// `sh -c script`, in its own process group as the shell tool starts it.
    fn sh(script: &str) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("sh"); // posix-only: this module's tests are unix-only
        cmd.args(["-c", script]).stdin(std::process::Stdio::null()).process_group(0);
        cmd
    }

    fn spec<'a>(session_id: &'a str, dir: &Path, command: &'a str) -> Start<'a> {
        Start { session_id, dir: dir.join(DIR), command, description: "", wait: false, reports: true, limit: None }
    }

    async fn ended(job: &Job) -> Arc<Ended> {
        let mut outcome = outcome(&job.session_id, job.number).expect("the command is listed while it runs");
        let got = tokio::time::timeout(Duration::from_secs(20), outcome.wait_for(Option::is_some)).await.expect("the command ends").unwrap().clone();
        got.unwrap()
    }

    #[tokio::test]
    async fn a_command_gets_a_number_a_log_and_a_record() {
        let d = tempfile::tempdir().unwrap();
        let script = "echo one; echo two 1>&2; exit 3";
        let job = start(sh(script), spec("s-capture", d.path(), script)).unwrap();
        assert_eq!((job.number, job.log_path.clone()), (1, d.path().join("commands/1.log")));
        let e = ended(&job).await;
        assert_eq!((e.end, e.code, e.lines), (End::Exited, Some(3), 2));
        assert!(!e.succeeded());
        assert_eq!(e.tail, "one\ntwo");
        assert_eq!(std::fs::read_to_string(&job.log_path).unwrap(), "one\ntwo\n");
        let record: Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("commands/1.json")).unwrap()).unwrap();
        assert_eq!((record["state"].as_str(), record["exit_code"].as_i64(), record["command"].as_str()), (Some("exited"), Some(3), Some(script)));
        assert!(running("s-capture").is_empty(), "an ended command leaves the list");
        // The next command of the session takes the next number, also after a restart cleared the list.
        reg().lock().unwrap().remove(&key("s-capture"));
        let next = start(sh("true"), spec("s-capture", d.path(), "true")).unwrap();
        assert_eq!(next.number, 2);
        assert!(ended(&next).await.succeeded());
    }

    #[tokio::test]
    async fn the_session_waits_only_for_a_waited_command() {
        let d = tempfile::tempdir().unwrap();
        let server = start(sh("sleep 30"), spec("s-wait", d.path(), "sleep 30")).unwrap();
        assert!(!has_waited("s-wait") && !sessions_waiting().contains(&key("s-wait")));
        let build = start(sh("sleep 30"), Start { wait: true, ..spec("s-wait", d.path(), "sleep 30") }).unwrap();
        assert!(has_waited("S-WAIT") && sessions_waiting().contains(&key("s-wait")), "the id's hyphenated and stored forms name one session");
        assert_eq!(running("s-wait").iter().map(|j| j.number).collect::<Vec<_>>(), [server.number, build.number]);
        // Stopping the turn ends what the session waits for and leaves the server.
        assert_eq!(stop_session("s-wait", End::TurnStopped, true).await, 1);
        assert_eq!(running("s-wait"), std::slice::from_ref(&server));
        assert!(!has_waited("s-wait"));
        // Deleting the session ends the rest.
        assert_eq!(stop_session("s-wait", End::SessionDeleted, false).await, 1);
        assert!(running("s-wait").is_empty());
    }

    #[tokio::test]
    async fn a_stop_ends_the_whole_process_group_and_says_why() {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        let d = tempfile::tempdir().unwrap();
        let pidfile = d.path().join("child");
        let script = format!("sleep 60 & echo $! > '{}'; wait", pidfile.display());
        let job = start(sh(&script), spec("s-stop", d.path(), &script)).unwrap();
        while std::fs::read_to_string(&pidfile).map(|s| s.trim().is_empty()).unwrap_or(true) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let child = Pid::from_raw(std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap());
        let outcome = outcome("s-stop", job.number).unwrap();
        assert!(stop("s-stop", job.number, End::StoppedByUser).await);
        let e = outcome.borrow().clone().unwrap();
        assert_eq!(e.end, End::StoppedByUser);
        assert!(kill(child, None).is_err(), "the command's child outlived the stop");
        assert!(!stop("s-stop", job.number, End::StoppedByUser).await, "a command that ended cannot be stopped again");
    }

    #[tokio::test]
    async fn a_command_over_its_limit_is_ended_as_timed_out() {
        let d = tempfile::tempdir().unwrap();
        let job = start(sh("echo started; sleep 60"), Start { wait: true, limit: Some(Duration::from_millis(300)), ..spec("s-limit", d.path(), "sleep 60") }).unwrap();
        let e = ended(&job).await;
        assert_eq!((e.end, e.tail.as_str()), (End::TimedOut, "started"));
        assert!(!has_waited("s-limit"));
    }

    #[tokio::test]
    async fn a_command_that_leaves_a_process_holding_its_output_still_ends() {
        let d = tempfile::tempdir().unwrap();
        // The shell exits at once; `sleep` keeps the pipe open.
        let job = start(sh("sleep 30 & echo left"), spec("s-orphan", d.path(), "sleep 30 &")).unwrap();
        let e = ended(&job).await;
        assert_eq!((e.end, e.code, e.tail.as_str()), (End::Exited, Some(0), "left"));
        assert!(e.ran < Duration::from_secs(10), "the end waited for the process left behind");
    }

    /// Quitting ends what the server started; the next start finds each
    /// command recorded as ended by the shutdown and reports it. (Every
    /// test has its own process under nextest, so ending "every command"
    /// ends only this test's.)
    #[tokio::test]
    async fn a_shutdown_ends_every_command_and_the_next_start_takes_them() {
        let root = tempfile::tempdir().unwrap();
        let in_session = |id: &str| root.path().join(id);
        let build = start(sh("sleep 60"), Start { wait: true, ..spec("sess-a", &in_session("sess-a"), "make build") }).unwrap();
        let server = start(sh("sleep 60"), spec("sess-b", &in_session("sess-b"), "make dev")).unwrap();
        let (a, b) = (outcome("sess-a", build.number).unwrap(), outcome("sess-b", server.number).unwrap());
        assert_eq!(stop_all(End::Shutdown).await, 2);
        assert!(running("sess-a").is_empty() && running("sess-b").is_empty());
        assert_eq!((a.borrow().as_ref().unwrap().end, b.borrow().as_ref().unwrap().end), (End::Shutdown, End::Shutdown));
        assert!(!End::Shutdown.tells_agent(), "a shutdown is reported by the next start, not while the server goes down");
        let cut = take_cut_off(root.path());
        assert_eq!(cut.iter().map(|j| (j.session_id.as_str(), j.command.as_str(), j.wait)).collect::<Vec<_>>(), [("sess-a", "make build", true), ("sess-b", "make dev", false)]);
    }

    #[tokio::test]
    async fn records_left_running_are_taken_once_as_cut_off() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("sess-1").join(DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let record = |n: u64, state: &str| {
            std::fs::write(
                dir.join(format!("{n}.json")),
                json!({"number": n, "pid": 1, "command": format!("cmd {n}"), "wait": n == 1, "reports": true, "state": state}).to_string(),
            )
            .unwrap()
        };
        record(1, "running");
        record(2, "exited");
        record(3, "shutdown");
        let cut = take_cut_off(d.path());
        assert_eq!(
            cut.iter().map(|j| (j.session_id.as_str(), j.number, j.wait, j.command.as_str())).collect::<Vec<_>>(),
            [("sess-1", 1, true, "cmd 1"), ("sess-1", 3, false, "cmd 3")]
        );
        assert_eq!(cut[0].log_path, dir.join("1.log"));
        assert!(take_cut_off(d.path()).is_empty(), "a cut-off command is reported once");
    }

    #[test]
    fn the_log_keeps_the_newest_output_and_counts_every_line() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("1.log");
        let mut log = Log::create(path.clone(), 100).unwrap();
        for i in 0..60 {
            log.add(format!("\x1b[32mline {i:03}\x1b[0m\n").as_bytes());
        }
        log.add(b"unfinished");
        assert_eq!(log.lines(), 61);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.len() < 300, "the log grew past twice its limit: {} bytes", on_disk.len());
        assert!(on_disk.starts_with("...earlier output dropped (") && on_disk.ends_with("line 059\nunfinished"), "{on_disk}");
        assert!(!on_disk.contains('\x1b'));
        let tail = log.tail_text();
        assert_eq!(tail.lines().count(), TAIL_LINES);
        assert!(tail.starts_with("line 021\n") && tail.ends_with("line 059\nunfinished"), "{tail}");
    }

    #[test]
    fn the_start_text_says_whether_a_message_will_come() {
        let job = |wait, reports| Job {
            session_id: "s".into(),
            number: 3,
            pid: 48211,
            command: "make".into(),
            description: String::new(),
            wait,
            reports,
            started_at: 0,
            log_path: PathBuf::from("/a/commands/3.log"),
        };
        let waited = started_text(&job(true, true));
        assert!(waited.starts_with("[Started in the background: command 3]\nOutput: /a/commands/3.log\n"), "{waited}");
        assert!(waited.contains("arrives as a message when it exits") && waited.ends_with("To end it early: kill -- -48211"), "{waited}");
        assert!(started_text(&job(false, true)).contains("If it exits, a message says so"));
        assert!(started_text(&job(true, false)).contains("No message arrives"));
    }
}
