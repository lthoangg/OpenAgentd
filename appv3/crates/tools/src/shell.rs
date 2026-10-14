//! `shell` — port of `builtin/shell.py` + `shell_runtime.py`.

use crate::args::Args;
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use regex::bytes::Regex as BRegex;
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub const DEFAULT_TIMEOUT_SECONDS: u64 = 120;
/// Ceiling for a foreground call (4m30s). Provider prompt caches (Anthropic,
/// OpenAI/Codex) expire after ~5 minutes idle, so a turn blocked longer than
/// that re-pays the whole prompt. Anything slower must run with
/// `background=true`. Applies to every provider.
pub const MAX_TIMEOUT_SECONDS: u64 = 270;
const POST_KILL_WAIT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_secs(2);
const OUTPUT_MAX_LINES: usize = 300;
const OUTPUT_MAX_BYTES: usize = 131_072;
const SPILL_MAX_BYTES: usize = 10 * 1024 * 1024;
const STREAM_INTERVAL: Duration = Duration::from_millis(500);
const LIVE_MAX_CHARS: usize = 100_000;
const LIVE_MAX_LINES: usize = 100;
const LIVE_TRUNCATED: &str = "... [truncated live output] ...\n";
/// Server auth variables that must never reach commands the agent or the
/// user runs. `server serve` already drops them from its own environment;
/// this also covers embedders that do not. Children are scrubbed with the
/// wider [`appv3_core::env::child_env_blocklist`], which adds provider keys
/// and other `.env` / API-saved values. v2 stripped its own Python/venv
/// variables here; the native server sets none, so a user's venv passes
/// through consistently with `PATH`.
pub const LEAK_KEYS: &[&str] = &appv3_core::auth::CHILD_ENV_SECRETS;
const BLACKLIST: &[&str] = &["fish", "nu", "nushell"];

pub fn shell_name_of(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    base.split('.').next().unwrap_or(base).to_lowercase()
}

fn which(name: &str) -> Option<String> {
    appv3_core::which::which(name).map(|p| p.display().to_string())
}

/// v2 `shell_runtime.acceptable()`.
pub fn acceptable() -> String {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        if cfg!(windows) {
            // Wine ships a do-nothing powershell.exe; its cmd.exe is real.
            let candidates: &[&str] = if appv3_core::platform::under_wine() { &["cmd"] } else { &["pwsh", "powershell", "cmd"] };
            return candidates.iter().find_map(|n| which(n)).unwrap_or_else(|| "cmd.exe".into());
        }
        if let Ok(env_shell) = std::env::var("SHELL") {
            if !env_shell.is_empty() && !BLACKLIST.contains(&shell_name_of(&env_shell).as_str()) {
                let usable = if Path::new(&env_shell).is_absolute() { Path::new(&env_shell).is_file() } else { which(&env_shell).is_some() };
                if usable {
                    return env_shell;
                }
            }
        }
        if cfg!(target_os = "macos") {
            return "/bin/zsh".into();
        }
        ["zsh", "bash", "sh"].iter().find_map(|n| which(n)).unwrap_or_else(|| "/bin/sh".into())
    })
    .clone()
}

pub fn environment_summary() -> String {
    let os = match std::env::consts::OS {
        "macos" => "Darwin",
        "linux" => "Linux",
        "windows" => "Windows",
        o => o,
    };
    let arch = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "arm64",
        ("windows", "x86_64") => "AMD64",
        (_, a) => a,
    };
    format!("Environment: {os} {arch}, shell={}.", shell_name_of(&acceptable()))
}

pub fn build_argv(shell_bin: &str, command: &str) -> Vec<String> {
    match shell_name_of(shell_bin).as_str() {
        "pwsh" | "powershell" => vec!["-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), command.into()],
        "cmd" => vec!["/d".into(), "/s".into(), "/c".into(), command.into()],
        "zsh" => vec![
            "-l".into(),
            "-c".into(),
            "[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true; [[ -f \"${ZDOTDIR:-$HOME}/.zshrc\" ]] && source \"${ZDOTDIR:-$HOME}/.zshrc\" >/dev/null 2>&1 || true; unset HISTFILE; HISTSIZE=0; SAVEHIST=0; unsetopt appendhistory incappendhistory sharehistory 2>/dev/null; eval \"$1\"".into(),
            "openagentd".into(),
            command.into(),
        ],
        "bash" => vec![
            "-l".into(),
            "-c".into(),
            "shopt -s expand_aliases; [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true; unset HISTFILE; HISTSIZE=0; HISTFILESIZE=0; set +o history 2>/dev/null; eval \"$1\"".into(),
            "openagentd".into(),
            command.into(),
        ],
        _ => vec!["-c".into(), command.into()],
    }
}

fn ansi_rx() -> &'static BRegex {
    static R: OnceLock<BRegex> = OnceLock::new();
    R.get_or_init(|| BRegex::new(r"(?s-u)\x1b(?:\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1b\\)|[@-Z\\-_])").unwrap())
}

pub fn strip_ansi_bytes(b: &[u8]) -> Vec<u8> {
    ansi_rx().replace_all(b, &b""[..]).into_owned()
}

pub fn strip_ansi(s: &str) -> String {
    String::from_utf8_lossy(&strip_ansi_bytes(s.as_bytes())).into_owned()
}

fn decode_ignore(b: &[u8]) -> String {
    // utf-8 decode with errors="ignore" at the cut edges
    let s = String::from_utf8_lossy(b);
    s.trim_start_matches('\u{FFFD}').trim_end_matches('\u{FFFD}').to_string()
}

/// v2 `_tail_text`.
pub fn tail_text(text: &str, max_lines: usize, max_bytes: usize) -> (String, bool) {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= max_lines && text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut text = text.to_string();
    if lines.len() > max_lines {
        let head = max_lines / 2;
        let tail = max_lines - head;
        let omitted = lines.len() - head - tail;
        let mut v: Vec<String> = lines[..head].iter().map(|s| s.to_string()).collect();
        v.push(format!("...output truncated ({omitted} lines omitted)..."));
        v.extend(lines[lines.len() - tail..].iter().map(|s| s.to_string()));
        text = v.join("\n");
    }
    let enc = text.as_bytes();
    if enc.len() <= max_bytes {
        return (text, true);
    }
    let probe = b"\n...output truncated (000000000 bytes omitted)...\n".len();
    if max_bytes <= probe {
        return (decode_ignore(&enc[enc.len() - max_bytes..]), true);
    }
    let content = max_bytes - probe;
    let hb = content / 2;
    let tb = content - hb;
    let omitted = enc.len() - hb - tb;
    (format!("{}\n...output truncated ({omitted} bytes omitted)...\n{}", decode_ignore(&enc[..hb]), decode_ignore(&enc[enc.len() - tb..])), true)
}

/// Appends `bytes` decoded lossily, holding back an incomplete trailing
/// UTF-8 sequence in `carry` so a character split across pipe reads is not
/// shown as two U+FFFD.
fn push_utf8_lossy(out: &mut String, carry: &mut Vec<u8>, bytes: &[u8]) {
    carry.extend_from_slice(bytes);
    let cut = carry.len() - incomplete_utf8_tail(carry);
    out.push_str(&String::from_utf8_lossy(&carry[..cut]));
    carry.drain(..cut);
}

/// Length of a valid-looking but unfinished UTF-8 sequence at the end of `b`.
fn incomplete_utf8_tail(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let c = b[b.len() - back];
        if c & 0xC0 == 0x80 {
            continue;
        }
        let need = match c {
            0xF0..=0xF4 => 4,
            0xE0..=0xEF => 3,
            0xC2..=0xDF => 2,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

fn live_window(text: &str) -> (String, bool) {
    let mut t = text.to_string();
    let mut cut = false;
    if t.matches('\n').count() > LIVE_MAX_LINES {
        let mut idx = t.len();
        let mut found = true;
        for _ in 0..LIVE_MAX_LINES {
            match t[..idx].rfind('\n') {
                Some(i) => idx = i,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            t = t[idx + 1..].to_string();
            cut = true;
        }
    }
    let n = t.chars().count();
    if n > LIVE_MAX_CHARS {
        t = t.chars().skip(n - LIVE_MAX_CHARS).collect();
        cut = true;
    }
    (t, cut)
}

struct Collector {
    total: usize,
    head: Vec<u8>,
    tail: VecDeque<Vec<u8>>,
    tail_bytes: usize,
    spill_dir: PathBuf,
    spill_path: Option<PathBuf>,
    file: Option<std::fs::File>,
    spill_bytes: usize,
    capped: bool,
    failed: bool,
}

impl Collector {
    fn new(spill_dir: PathBuf) -> Self {
        Self { total: 0, head: vec![], tail: VecDeque::new(), tail_bytes: 0, spill_dir, spill_path: None, file: None, spill_bytes: 0, capped: false, failed: false }
    }
    fn dest(&self) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(&self.spill_dir)?;
        Ok(self.spill_dir.join(format!("{}.txt", &uuid::Uuid::new_v4().to_string()[..8])))
    }
    fn write_spill(&mut self, payload: &[u8]) {
        let remaining = SPILL_MAX_BYTES.saturating_sub(self.spill_bytes);
        if remaining == 0 {
            self.capped = true;
            return;
        }
        let take = payload.len().min(remaining);
        if let Some(f) = self.file.as_mut() {
            if f.write_all(&payload[..take]).is_err() {
                self.file = None;
                self.failed = true;
                return;
            }
        }
        self.spill_bytes += take;
        if payload.len() > remaining {
            self.capped = true;
        }
    }
    fn add(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        let mut rest = chunk;
        if self.head.len() < OUTPUT_MAX_BYTES {
            let take = chunk.len().min(OUTPUT_MAX_BYTES - self.head.len());
            self.head.extend_from_slice(&chunk[..take]);
            rest = &chunk[take..];
        }
        if rest.is_empty() {
            return;
        }
        if self.file.is_none() && !self.failed {
            match self.dest().and_then(|d| std::fs::File::create(&d).map(|f| (d, f))) {
                Ok((d, f)) => {
                    self.file = Some(f);
                    self.spill_path = Some(d);
                    let h = strip_ansi_bytes(&self.head);
                    self.write_spill(&h);
                }
                Err(_) => self.failed = true,
            }
        }
        if self.file.is_some() {
            let p = strip_ansi_bytes(rest);
            self.write_spill(&p);
        }
        self.tail.push_back(rest.to_vec());
        self.tail_bytes += rest.len();
        while self.tail_bytes > OUTPUT_MAX_BYTES && self.tail.len() > 1 {
            self.tail_bytes -= self.tail.pop_front().unwrap().len();
        }
    }
    fn inline(&self) -> (String, bool) {
        let tail: Vec<u8> = self.tail.iter().flatten().copied().collect();
        let dropped = self.total as i64 - self.head.len() as i64 - self.tail_bytes as i64;
        if dropped <= 0 {
            let mut all = self.head.clone();
            all.extend_from_slice(&tail);
            return tail_text(&strip_ansi(&String::from_utf8_lossy(&all)), OUTPUT_MAX_LINES, OUTPUT_MAX_BYTES);
        }
        let combined =
            format!("{}\n...output truncated ({dropped} bytes omitted)...\n{}", strip_ansi(&String::from_utf8_lossy(&self.head)), strip_ansi(&String::from_utf8_lossy(&tail)));
        (tail_text(&combined, OUTPUT_MAX_LINES, OUTPUT_MAX_BYTES).0, true)
    }
    fn finalize(&mut self) -> (String, bool) {
        self.file = None;
        let (inline, cut) = self.inline();
        if cut && self.spill_path.is_none() && !self.failed {
            if let Ok(d) = self.dest() {
                let mut all = self.head.clone();
                all.extend(self.tail.iter().flatten());
                let payload = strip_ansi_bytes(&all);
                if std::fs::write(&d, &payload[..payload.len().min(SPILL_MAX_BYTES)]).is_ok() {
                    self.capped = payload.len() > SPILL_MAX_BYTES;
                    self.spill_path = Some(d);
                }
            }
        }
        (inline, cut)
    }
}

#[cfg(unix)]
fn descendants(root: i32) -> Vec<i32> {
    let out = std::process::Command::new("ps").args(["-Ao", "pid=,ppid="]).output();
    let Ok(out) = out else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut children: std::collections::HashMap<i32, Vec<i32>> = Default::default();
    for line in text.lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() == 2 {
            if let (Ok(a), Ok(b)) = (p[0].parse(), p[1].parse()) {
                children.entry(b).or_default().push(a);
            }
        }
    }
    let mut res = vec![];
    let mut frontier = vec![root];
    while !frontier.is_empty() {
        let mut next = vec![];
        for pid in frontier {
            for c in children.get(&pid).cloned().unwrap_or_default() {
                res.push(c);
                next.push(c);
            }
        }
        frontier = next;
    }
    res
}

#[cfg(unix)]
async fn kill_group(pid: u32, sig: nix::sys::signal::Signal) {
    use nix::sys::signal::{kill, killpg};
    use nix::unistd::Pid;
    let pid = pid as i32;
    let desc = tokio::task::spawn_blocking(move || descendants(pid)).await.unwrap_or_default();
    let _ = killpg(Pid::from_raw(pid), sig);
    for d in desc {
        let _ = kill(Pid::from_raw(d), sig);
    }
    let _ = kill(Pid::from_raw(pid), sig);
}

#[cfg(not(unix))]
async fn kill_group(pid: u32, _sig: ()) {
    let _ = appv3_core::proctree::hide_window(&mut tokio::process::Command::new("taskkill")).args(["/PID", &pid.to_string(), "/T", "/F"]).status().await;
}

fn format_exit_code(code: Option<i32>, signal: Option<i32>) -> String {
    if let Some(s) = signal {
        let name = match s {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            15 => "SIGTERM",
            _ => "",
        };
        return if name.is_empty() { format!("{}", 128 + s) } else { format!("{} ({name})", 128 + s) };
    }
    code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
}

fn scrubbed_env(cmd: &mut tokio::process::Command) {
    for k in appv3_core::env::child_env_blocklist() {
        cmd.env_remove(k);
    }
}

fn snapshot_cache() -> &'static crate::shell_snapshot::Cache {
    static C: OnceLock<crate::shell_snapshot::Cache> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// argv that sources a cached rc snapshot instead of the rc files
/// themselves (see `shell_snapshot`); `None` = use v2's [`build_argv`].
async fn snapshot_argv(shell_bin: &str, command: &str) -> Option<Vec<String>> {
    use crate::shell_snapshot as snap;
    if !cfg!(unix) || !snap::enabled() {
        return None;
    }
    let kind = snap::Kind::of(&shell_name_of(shell_bin))?;
    // v2's rc-sourcing prelude, so the snapshot sees what v2's shell sees.
    let prefix = build_argv(shell_bin, "").get(2)?.strip_suffix("eval \"$1\"")?.to_string();
    let blocked = appv3_core::env::child_env_blocklist();
    let env: std::collections::HashMap<String, String> =
        std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).filter(|(k, _)| !blocked.contains(k)).collect();
    let dir = appv3_core::settings().cache_dir.join("shell-snapshots");
    let path = snapshot_cache().get(kind, shell_bin, &prefix, &env, LEAK_KEYS, &dir).await?;
    Some(snap::argv(kind, &path, command))
}

/// Build the rc snapshot in the background so the first `shell` call does not pay for it.
pub fn prewarm_snapshot() {
    if let Ok(rt) = tokio::runtime::Handle::try_current() {
        rt.spawn(async {
            let _ = snapshot_argv(&acceptable(), "true").await;
        });
    }
}

/// Stops the foreground process group if the tool future is cancelled (the
/// user stopped the turn). v2 SIGKILLs the group on `CancelledError`; v3
/// sends SIGTERM first and SIGKILL after [`TERM_GRACE`], like the timeout
/// path, so commands can clean up: git removes `.git/index.lock` on
/// SIGTERM, while SIGKILL strands it and blocks every later git command.
struct GroupGuard {
    pid: u32,
    armed: bool,
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if !self.armed || self.pid == 0 {
            return;
        }
        #[cfg(unix)]
        {
            use nix::sys::signal::{killpg, Signal};
            let pgid = nix::unistd::Pid::from_raw(self.pid as i32);
            let _ = killpg(pgid, Signal::SIGTERM);
            // Drop cannot await, so a thread waits out the grace period.
            let escalate = std::thread::Builder::new().name("oad-shell-stop".into()).spawn(move || {
                std::thread::sleep(TERM_GRACE);
                let _ = killpg(pgid, Signal::SIGKILL);
            });
            if escalate.is_err() {
                let _ = killpg(pgid, Signal::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = appv3_core::proctree::hide_window_std(&mut std::process::Command::new("taskkill")).args(["/PID", &self.pid.to_string(), "/T", "/F"]).status();
        }
    }
}

/// Streams pending live output to the sink every [`STREAM_INTERVAL`].
/// Dropping it stops the timer and hands over what is still pending, both
/// when the command ends and when the call is dropped because the user
/// stopped the turn (the timer task would otherwise outlive the call).
struct LiveFlusher<F: Fn()> {
    task: tokio::task::JoinHandle<()>,
    flush: F,
}

impl<F: Fn()> Drop for LiveFlusher<F> {
    fn drop(&mut self) {
        self.task.abort();
        (self.flush)();
    }
}

pub struct ShellTool;

#[async_trait]
impl Tool for ShellTool {
    fn name(&self) -> &str {
        "shell"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("shell", &args);
        let command = a.req_str(&["command", "cmd"]);
        let description = a.str_or(&["description"], "");
        let workdir = a.opt_str(&["workdir", "cwd", "dir"]);
        let timeout_s = a.opt_int(&["timeout_seconds"], Some(1), None).map(|n| n as u64).unwrap_or(DEFAULT_TIMEOUT_SECONDS).min(MAX_TIMEOUT_SECONDS);
        let background = a.bool_or(&["background"], false);
        a.finish()?;
        if let Some(hit) = ctx.denied.check_command(&command) {
            return Err(ToolError::Execution(format!("Sandbox blocked 'shell': command would touch denied path or pattern '{hit}'.")));
        }
        let cwd = match &workdir {
            None => ctx.denied.workspace_root.clone(),
            Some(w) => {
                let home = appv3_core::home::home_dir_opt().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
                let expanded = if let Some(rest) = w.strip_prefix("~") { format!("{home}{rest}") } else { w.clone() };
                ctx.denied.validate_path(&expanded)?
            }
        };
        let shell_bin = acceptable();
        let desc_tag = if description.is_empty() { String::new() } else { format!(" ({description})") };
        tracing::info!(
            "shell_execute_start shell={} command={} cwd={} timeout={} background={}{}",
            shell_name_of(&shell_bin),
            command.chars().take(200).collect::<String>(),
            cwd.display(),
            timeout_s,
            background,
            desc_tag
        );
        if command.trim().is_empty() {
            return Ok(ToolOutput::text("[Succeeded]\n\n"));
        }
        let argv = match snapshot_argv(&shell_bin, &command).await {
            Some(a) => a,
            None => build_argv(&shell_bin, &command),
        };
        let mut cmd = tokio::process::Command::new(&shell_bin);
        appv3_core::proctree::hide_window(&mut cmd).args(&argv).current_dir(&cwd).stdin(std::process::Stdio::null());
        scrubbed_env(&mut cmd);
        #[cfg(unix)]
        cmd.process_group(0);
        if background {
            cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            let child = cmd.spawn().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
            let pid = child.id().unwrap_or(0);
            tracing::info!("shell_background_started pid={} command={}", pid, command.chars().take(200).collect::<String>());
            // detach: reap in background
            tokio::spawn(async move {
                let mut c = child;
                let _ = c.wait().await;
            });
            return Ok(ToolOutput::Text(format!("PID: {pid}")));
        }
        // stdout+stderr merged via a single pipe
        let (reader, writer) = os_pipe::pipe().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
        let writer2 = writer.try_clone().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
        cmd.stdout(writer).stderr(writer2);
        let mut child = cmd.spawn().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
        drop(cmd); // closes our copies of the write ends
        let pid = child.id().unwrap_or(0);
        let mut group_guard = GroupGuard { pid, armed: true };
        let mut out = tokio::fs::File::from_std(unsafe_file_from_reader(reader));
        let spill_dir = ctx.artifacts_dir().join(".tool_results").join("shell");
        let collector = Arc::new(Mutex::new(Collector::new(spill_dir)));
        let pending = Arc::new(Mutex::new(String::new()));
        let sink = ctx.output.clone();
        let flush = {
            let pending = pending.clone();
            let sink = sink.clone();
            move || {
                let text = std::mem::take(&mut *pending.lock().unwrap());
                if let (Some(s), false) = (&sink, text.is_empty()) {
                    let t = strip_ansi(&text);
                    if !t.is_empty() {
                        let (w, cut) = live_window(&t);
                        s(if cut { format!("{LIVE_TRUNCATED}{w}") } else { w });
                    }
                }
            }
        };
        let live = LiveFlusher {
            task: {
                let flush = flush.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(STREAM_INTERVAL).await;
                        flush();
                    }
                })
            },
            flush,
        };
        let read_all = {
            let collector = collector.clone();
            let pending = pending.clone();
            async move {
                let mut buf = vec![0u8; 8192];
                let mut carry: Vec<u8> = vec![];
                loop {
                    match out.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            collector.lock().unwrap().add(&buf[..n]);
                            let mut p = pending.lock().unwrap();
                            push_utf8_lossy(&mut p, &mut carry, &buf[..n]);
                            if p.chars().count() > 2 * LIVE_MAX_CHARS {
                                let (kept, _) = live_window(&p);
                                *p = format!("{LIVE_TRUNCATED}{kept}");
                            }
                        }
                    }
                }
                if !carry.is_empty() {
                    pending.lock().unwrap().push_str(&String::from_utf8_lossy(&carry));
                }
                out
            }
        };
        let mut aborted = false;
        let status = match tokio::time::timeout(Duration::from_secs(timeout_s), async {
            let out = read_all.await;
            let st = child.wait().await;
            (out, st)
        })
        .await
        {
            Ok((_out, st)) => st.ok(),
            Err(_) => {
                #[cfg(unix)]
                {
                    kill_group(pid, nix::sys::signal::Signal::SIGTERM).await;
                    if tokio::time::timeout(TERM_GRACE, child.wait()).await.is_err() {
                        kill_group(pid, nix::sys::signal::Signal::SIGKILL).await;
                    }
                }
                #[cfg(not(unix))]
                kill_group(pid, ()).await;
                aborted = true;
                tokio::time::timeout(POST_KILL_WAIT, child.wait()).await.ok().and_then(|r| r.ok())
            }
        };
        drop(live);
        group_guard.armed = false;
        let (code, signal) = match status {
            Some(s) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    (s.code(), s.signal())
                }
                #[cfg(not(unix))]
                {
                    (s.code(), None)
                }
            }
            None => (Some(0), None),
        };
        let mut col = collector.lock().unwrap();
        tracing::info!("shell_execute_complete exit_code={:?} output_bytes={}{}", code, col.total, desc_tag);
        let ok = code == Some(0) && signal.is_none();
        let status_line = if !aborted && ok {
            "[Succeeded]".to_string()
        } else if aborted {
            format!("[Timed out after {timeout_s}s]")
        } else {
            format!("[Failed — exit code {}]", format_exit_code(code, signal))
        };
        let (inline, cut) = col.finalize();
        let mut result = if cut {
            match &col.spill_path {
                Some(p) => {
                    format!("{status_line}\n\n...output truncated{} — full output saved to {}\n\n{inline}", if col.capped { " (spill file capped)" } else { "" }, p.display())
                }
                None => format!("{status_line}\n\n...output truncated\n\n{inline}"),
            }
        } else if aborted && inline.trim().is_empty() {
            format!("{status_line}\n\n(No output before timeout)")
        } else if inline.is_empty() {
            status_line
        } else {
            format!("{status_line}\n\n{inline}")
        };
        if aborted {
            result.push_str(&timeout_hint(timeout_s));
        }
        Ok(ToolOutput::Text(result))
    }
}

/// Model-facing advice after a foreground timeout: raise the timeout while
/// under [`MAX_TIMEOUT_SECONDS`], otherwise move the command to the background.
fn timeout_hint(timeout_s: u64) -> String {
    let advice = if timeout_s < MAX_TIMEOUT_SECONDS {
        format!(
            "If this command legitimately takes longer, retry with a higher timeout_seconds value (at most {MAX_TIMEOUT_SECONDS}), or run it with background=true if it may exceed {MAX_TIMEOUT_SECONDS}s."
        )
    } else {
        format!(
            "{MAX_TIMEOUT_SECONDS}s is the foreground ceiling. Rerun it with background=true, redirecting output to a log file (e.g. `cmd > /tmp/out.log 2>&1`), then check the log later."
        )
    };
    format!("\n\n<shell_metadata>\nCommand timed out after {timeout_s}s. {advice}\n</shell_metadata>")
}

#[cfg(unix)]
fn unsafe_file_from_reader(r: os_pipe::PipeReader) -> std::fs::File {
    use std::os::fd::{FromRawFd, IntoRawFd};
    unsafe { std::fs::File::from_raw_fd(r.into_raw_fd()) }
}

#[cfg(windows)]
fn unsafe_file_from_reader(r: os_pipe::PipeReader) -> std::fs::File {
    use std::os::windows::io::{FromRawHandle, IntoRawHandle};
    unsafe { std::fs::File::from_raw_handle(r.into_raw_handle()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_env_never_inherits_openagentd_secrets() {
        let mut cmd = tokio::process::Command::new("sh");
        scrubbed_env(&mut cmd);
        let removed: Vec<String> = cmd.as_std().get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "OPENAGENTD_HANDSHAKE_FILE"] {
            assert!(removed.iter().any(|r| r == k), "{k} reaches agent shell commands: {removed:?}");
        }
    }

    #[test]
    fn tail_text_line_cut() {
        let text = (0..400).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let (t, cut) = tail_text(&text, 300, OUTPUT_MAX_BYTES);
        assert!(cut);
        assert!(t.contains("...output truncated (100 lines omitted)..."));
    }

    #[test]
    fn strips_ansi() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
    }

    #[test]
    fn live_text_keeps_characters_split_across_reads() {
        let (mut out, mut carry) = (String::new(), Vec::new());
        let bytes = "é 日本 🦀".as_bytes();
        // Every split point, including inside 2-, 3- and 4-byte characters.
        for cut in 0..=bytes.len() {
            out.clear();
            push_utf8_lossy(&mut out, &mut carry, &bytes[..cut]);
            push_utf8_lossy(&mut out, &mut carry, &bytes[cut..]);
            assert_eq!(out, "é 日本 🦀", "split at byte {cut}");
            assert!(carry.is_empty());
        }
        // Invalid bytes still decode lossily instead of being held forever.
        out.clear();
        push_utf8_lossy(&mut out, &mut carry, b"a\xffb\x80");
        assert_eq!(out, "a\u{fffd}b\u{fffd}");
        assert!(carry.is_empty());
    }

    fn ctx(ws: &Path) -> ToolContext {
        ToolContext {
            session_id: None,
            agent_name: "t".into(),
            tool_call_id: "c".into(),
            denied: Arc::new(crate::DeniedPaths::with(ws, None, Some(vec![]), Some(vec![]))),
            workspace: None,
            output: None,
            metadata: Default::default(),
            messages: None,
        }
    }

    #[tokio::test]
    async fn runs_commands_like_v2() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx(d.path());
        // Same behaviour, spelled for whichever shell `acceptable()` picked.
        let (both, sleep) = match shell_name_of(&acceptable()).as_str() {
            "pwsh" | "powershell" => ("Write-Output hi; [Console]::Error.WriteLine('err')", "Start-Sleep -Seconds 5"),
            "cmd" => ("echo hi& >&2 echo err", "ping -n 6 127.0.0.1 >nul"),
            _ => ("echo hi; echo err 1>&2", "sleep 5"),
        };
        let out = ShellTool.run(&c, serde_json::json!({"command": both})).await.unwrap();
        let out = match out {
            ToolOutput::Text(t) => ToolOutput::Text(t.replace("\r\n", "\n")),
            o => o,
        };
        assert_eq!(out, ToolOutput::text("[Succeeded]\n\nhi\nerr\n"));
        let out = ShellTool.run(&c, serde_json::json!({"command": "exit 3"})).await.unwrap();
        assert_eq!(out, ToolOutput::text("[Failed — exit code 3]"));
        let out = ShellTool.run(&c, serde_json::json!({"command": sleep, "timeout_seconds": 1})).await.unwrap();
        let ToolOutput::Text(t) = out else { panic!() };
        assert!(t.starts_with("[Timed out after 1s]\n\n(No output before timeout)\n\n<shell_metadata>"), "{t}");
    }

    #[test]
    fn timeout_hint_points_to_background_at_the_ceiling() {
        assert!(timeout_hint(1).contains("higher timeout_seconds value (at most 270)"));
        let at_cap = timeout_hint(MAX_TIMEOUT_SECONDS);
        assert!(at_cap.contains("background=true") && !at_cap.contains("higher timeout_seconds"), "{at_cap}");
    }

    #[tokio::test]
    async fn timeout_is_capped_at_the_ceiling() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx(d.path());
        // A requested 10_000s is clamped; the call still runs and succeeds.
        let out = ShellTool.run(&c, serde_json::json!({"command": "exit 0", "timeout_seconds": 10_000})).await.unwrap();
        assert_eq!(out, ToolOutput::text("[Succeeded]"));
    }

    /// A call dropped mid-command (the user stopped the turn) hands its
    /// pending output to the sink and leaves no live-output timer behind.
    #[cfg(unix)]
    #[tokio::test]
    async fn dropped_call_flushes_its_output_and_stops_streaming() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("printed");
        let seen = Arc::new(Mutex::new(String::new()));
        let sink: crate::OutputSink = {
            let seen = seen.clone();
            Arc::new(move |t: String| seen.lock().unwrap().push_str(&t))
        };
        let mut c = ctx(d.path());
        c.output = Some(sink.clone());
        let command = format!("echo started; touch '{}'; sleep 30", marker.display());
        {
            let run = ShellTool.run(&c, serde_json::json!({"command": command}));
            tokio::pin!(run);
            let printed = async {
                while !marker.exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                // Let the reader pick the line up from the pipe.
                tokio::time::sleep(Duration::from_millis(100)).await;
            };
            tokio::select! {
                _ = &mut run => panic!("the command should still be running"),
                _ = tokio::time::timeout(Duration::from_secs(20), printed) => {}
            }
        }
        assert_eq!(seen.lock().unwrap().trim(), "started");
        drop(c);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(Arc::strong_count(&sink), 1, "a live-output timer outlived the call");
    }

    /// Run `command` through the tool and drop the call (the user stopped
    /// the turn) once it has created `started`.
    #[cfg(unix)]
    async fn run_then_stop(c: &ToolContext, command: String, started: &Path) {
        let run = ShellTool.run(c, serde_json::json!({"command": command}));
        tokio::pin!(run);
        let ready = async {
            while std::fs::read_to_string(started).map(|s| s.trim().is_empty()).unwrap_or(true) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        tokio::select! {
            _ = &mut run => panic!("the command should still be running"),
            _ = tokio::time::timeout(Duration::from_secs(20), ready) => {}
        }
    }

    #[cfg(unix)]
    async fn wait_until(limit: Duration, done: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + limit;
        while !done() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Stopping a turn sends SIGTERM first, so the command can clean up:
    /// git removes `.git/index.lock` on SIGTERM, while SIGKILL strands it.
    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_call_lets_the_command_clean_up() {
        let d = tempfile::tempdir().unwrap();
        let (started, cleaned) = (d.path().join("started"), d.path().join("cleaned"));
        let c = ctx(d.path());
        let command = format!("trap 'touch \"{}\"; exit 0' TERM; echo 1 > \"{}\"; while :; do sleep 0.1; done", cleaned.display(), started.display());
        run_then_stop(&c, command, &started).await;
        wait_until(Duration::from_secs(5), || cleaned.exists()).await;
        assert!(cleaned.exists(), "the command was killed without a SIGTERM to clean up on");
    }

    /// A command that ignores SIGTERM still dies once the grace period ends.
    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_call_kills_what_ignores_sigterm() {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        let d = tempfile::tempdir().unwrap();
        let pidfile = d.path().join("pid");
        let c = ctx(d.path());
        let command = format!("trap '' TERM; sleep 60 & echo $! > \"{}\"; wait", pidfile.display());
        run_then_stop(&c, command, &pidfile).await;
        let pid = Pid::from_raw(std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap());
        wait_until(TERM_GRACE + Duration::from_secs(5), || kill(pid, None).is_err()).await;
        assert!(kill(pid, None).is_err(), "a SIGTERM-ignoring child outlived the stopped call");
    }
}
