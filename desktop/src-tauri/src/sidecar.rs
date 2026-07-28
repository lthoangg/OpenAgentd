//! Python sidecar supervisor.
//!
//! Spawns `python -m app.cli serve --handshake --generate-token
//! --parent-pid <us>`, parses the first JSON handshake line from stdout,
//! and exposes the child for graceful shutdown.
//!
//! Layout expectations (paths relative to the bundled resources dir):
//!
//! - `sidecar/python/bin/python3`: the bundled CPython interpreter.
//! - `sidecar/site-packages/`: pre-installed openagentd + dependencies.
//! - `sidecar/_web_dist/`: the built React frontend (also embedded in
//!   `site-packages/app/_web_dist/`; either works).
//!
//! Windows uses a Job Object with kill-on-close semantics so the sidecar cannot
//! outlive the desktop shell, including after a crash.
//!
//! Windows handshake delivery is dual-channel: stdout (primary) raced
//! against a JSON file the child writes via ``OPENAGENTD_HANDSHAKE_FILE``
//! (fallback), because the anonymous-pipe + tokio overlapped-I/O
//! combination has failed to deliver the stdout handshake line on real
//! user installs (v1.22.8). The spawn path also strips the verbatim
//! ``\\?\`` prefix from the resolved python path — some Python launcher
//! executables mis-parse it and exit before producing any output.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::timeout;

const HANDSHAKE_PREFIX: &str = "OPENAGENTD_HANDSHAKE ";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize, Clone)]
pub struct Handshake {
    pub port: u16,
    pub pid: u32,
    pub version: String,
    pub token: String,
}

pub struct Sidecar {
    child: Child,
    handshake: Option<Handshake>,
    stdout_reader: Option<BufReader<tokio::process::ChildStdout>>,
    log_path: PathBuf,
    /// Windows-only fallback channel: the child also writes the handshake
    /// JSON to this path (see ``OPENAGENTD_HANDSHAKE_FILE``). ``None`` on
    /// other platforms.
    #[cfg_attr(not(windows), allow(dead_code))]
    handshake_file: Option<PathBuf>,
}

impl Sidecar {
    pub fn spawn(app: &AppHandle) -> Result<Self> {
        Self::spawn_with_desktop_token(app, None)
    }

    pub fn spawn_with_desktop_token(app: &AppHandle, desktop_token: Option<&str>) -> Result<Self> {
        let resource_dir = app
            .path()
            .resource_dir()
            .context("locate resource dir")?;
        let sidecar_root = resource_dir.join("sidecar");

        let python_bin = resolve_python_bin(&sidecar_root)
            .with_context(|| format!("locate python binary under {}", sidecar_root.display()))?;
        // Tauri's resource resolver can hand back a verbatim ``\\?\``
        // extended-length path on Windows; strip it before spawning —
        // see ``strip_unc_prefix`` for why.
        let python_bin = strip_unc_prefix(&python_bin);

        let log_dir = app
            .path()
            .app_log_dir()
            .context("resolve app log dir")?;
        std::fs::create_dir_all(&log_dir).context("create app log dir")?;
        let log_path = log_dir.join("backend.log");

        // Windows-only: prepare a handshake file path that the child can
        // write to as a fallback for the stdout-piped handshake line.
        // We delete any stale copy here so an old payload from a previous
        // (crashed) launch can't be mistaken for the new run.
        #[cfg(windows)]
        let handshake_file = {
            let path = log_dir.join("handshake.json");
            let _ = std::fs::remove_file(&path);
            Some(path)
        };
        #[cfg(not(windows))]
        let handshake_file: Option<PathBuf> = None;

        let parent_pid = std::process::id();

        log::info!(
            "spawning sidecar: {} (parent_pid={}, log={})",
            python_bin.display(),
            parent_pid,
            log_path.display()
        );

        // Explicit script path (not ``-m app.cli``) so we know exactly
        // which CLI module is invoked. ``-m`` would let Python search
        // ``sys.path`` and could surface a vendored ``app.cli`` from a
        // user-extended directory later.
        let cli_entry = sidecar_root
            .join("site-packages")
            .join("app")
            .join("cli")
            .join("__main__.py");
        if !cli_entry.is_file() {
            return Err(anyhow!(
                "sidecar bundle missing CLI entry at {}",
                cli_entry.display()
            ));
        }

        let site_packages = sidecar_root.join("site-packages");

        // Bootstrap ``sys.path`` from inside the child instead of via the
        // ``PYTHONPATH`` environment variable.
        //
        // Background:  ``PYTHONPATH`` is inherited by every grandchild
        // process the agent spawns.  Another Python interpreter the user
        // has installed (``uv tool install browser-use``, ``pipx`` tools,
        // Homebrew Python scripts, …) then finds *our* pure-Python
        // packages on ``sys.path`` before its own.  When that package
        // tries to load a native extension built for our ABI
        // (``pydantic_core`` cpython-3.14 vs. the tool's cpython-3.12),
        // the import crashes with ``ModuleNotFoundError`` because
        // Python's import system has already committed to our package
        // directory.
        //
        // ``PYTHONHOME`` is still intentionally NOT set — python-build-
        // standalone is relocatable and finds its own stdlib from the
        // executable path; setting PYTHONHOME would leak into every
        // subprocess and override the user's other Python interpreters'
        // stdlib resolution.
        //
        // Paths arrive via ``sys.argv[1]`` (site-packages dir) and
        // ``sys.argv[2]`` (CLI entry) so we never embed them into Python
        // source — that would break on directories containing quotes.
        // ``sys.argv`` is then rewritten to look like a normal
        // ``python <entry> serve …`` invocation before ``runpy``.
        let bootstrap = "import sys, runpy, site; \
             _site = sys.argv.pop(1); \
             _entry = sys.argv.pop(1); \
             site.addsitedir(_site); \
             sys.argv[0] = _entry; \
             runpy.run_path(_entry, run_name='__main__')";

        let mut cmd = Command::new(&python_bin);
        cmd.arg("-c")
            .arg(bootstrap)
            .arg(site_packages.as_os_str())
            .arg(cli_entry.as_os_str())
            .arg("serve")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("0")
            .arg("--handshake");

        if let Some(token) = desktop_token {
            cmd.env("OPENAGENTD_DESKTOP_TOKEN", token);
        } else {
            cmd.arg("--generate-token");
        }

        // ``APP_ENV`` defaults to ``production`` (XDG dirs shared with a
        // terminal ``openagentd`` install). Dev-bundled runs can set
        // ``OPENAGENTD_APP_ENV=development`` and explicit ``OPENAGENTD_*_DIR``
        // roots so local desktop testing does not share production state.
        let app_env = std::env::var("OPENAGENTD_APP_ENV")
            .unwrap_or_else(|_| "production".to_string());

        // Open backend.log up-front and hand it to the child as stderr.
        // ``Stdio::from(File)`` causes the kernel to write child stderr
        // directly into the file with no intermediate buffer in our process,
        // so a Python crash within the first millisecond still leaves a
        // useful traceback on disk.  The previous design piped stderr and
        // copied bytes in a background task; if the child died before the
        // task was scheduled, ``backend.log`` ended up empty and we had
        // nothing to debug from.
        let stderr_log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("open backend log at {}", log_path.display()))?;
        // Clone the file handle so we can also append our own diagnostic
        // lines from this side (e.g. the spawn banner) without racing the
        // child for the write cursor.
        let stderr_for_child = stderr_log
            .try_clone()
            .context("clone backend log handle for child stderr")?;

        cmd.arg("--parent-pid")
            .arg(parent_pid.to_string())
            .env("PYTHONUNBUFFERED", "1")
            .env("APP_ENV", app_env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr_for_child));

        // Windows-only: tell the child to also persist the handshake to
        // a file.  ``_emit_handshake`` in ``app/cli/commands/serve.py``
        // checks this env var and writes the JSON atomically (tmp+rename).
        #[cfg(windows)]
        if let Some(ref path) = handshake_file {
            cmd.env("OPENAGENTD_HANDSHAKE_FILE", path.as_os_str());
        }

        // Path resolution is delegated to the Python backend
        // (app.core.paths). It already resolves the XDG-spec directories
        // — ~/.config/openagentd, ~/.local/share/openagentd, etc. — that
        // the CLI uses, with $OPENAGENTD_*_DIR env-var overrides for
        // anyone who wants different paths. Setting Tauri's per-app
        // app_data_dir / app_config_dir here would silently bifurcate
        // the desktop from a terminal ``openagentd`` install — same
        // product, different data, different agents, different DB.
        // Keep them unified.

        #[cfg(windows)]
        {
            // ``tokio::process::Command`` exposes its own inherent
            // ``creation_flags`` on Windows; we don't need to bring the
            // ``std::os::windows::process::CommandExt`` trait into scope.
            // CREATE_NO_WINDOW | CREATE_SUSPENDED.
            //
            // ``CREATE_SUSPENDED`` is critical: it lets us attach the child
            // to our Job Object *before* it runs a single instruction. If we
            // skipped this and Tauri died between ``spawn()`` and
            // ``AssignProcessToJobObject``, the sidecar would orphan.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_SUSPENDED: u32 = 0x0000_0004;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }

        let mut child = cmd.spawn().context("spawn python sidecar")?;

        #[cfg(windows)]
        {
            // Attach to the Job Object (kills the child on Tauri exit),
            // then resume the suspended primary thread. If anything in
            // this sequence fails we kill the child rather than leave a
            // suspended orphan.
            if let Err(e) = attach_to_job_object(&child) {
                let _ = child.start_kill();
                return Err(e.context("attach to job object"));
            }
            if let Err(e) = resume_primary_thread(&child) {
                let _ = child.start_kill();
                return Err(e.context("resume primary thread"));
            }
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("sidecar stdout missing"))?;
        // Stderr was wired directly to ``backend.log`` via ``Stdio::from(File)``
        // above (see ``stderr_for_child``); there is nothing to drain here.
        // Keep ``stderr_log`` alive for the rest of this function — dropping
        // it would close one of the two duplicated file descriptors, which
        // is harmless but also pointless.  We let it drop naturally at the
        // end of ``spawn_with_desktop_token``.
        drop(stderr_log);

        Ok(Sidecar {
            child,
            handshake: None,
            stdout_reader: Some(BufReader::new(stdout)),
            log_path,
            handshake_file,
        })
    }

    pub async fn read_handshake(&mut self, max_wait: Duration) -> Result<Handshake> {
        let reader = self
            .stdout_reader
            .take()
            .ok_or_else(|| anyhow!("stdout already consumed"))?;
        let log_path = self.log_path.clone();

        // Wrap the stdout reader in a shared Arc<Mutex<...>> so we can
        // pass it either to ``parse_task`` (which extracts the handshake
        // from a stdout line) or to the post-handshake drain task — even
        // when the file-handshake wins the race on Windows and parse_task
        // is dropped mid-await without ever spawning its own drain.
        let reader = std::sync::Arc::new(tokio::sync::Mutex::new(Some(reader)));

        let parse_log_path = log_path.clone();
        let parse_reader = reader.clone();
        let parse_task = async move {
            let mut guard = parse_reader.lock().await;
            let Some(reader) = guard.as_mut() else {
                // Drain task already took ownership — parse_task lost
                // the race, just park forever.
                std::future::pending::<()>().await;
                unreachable!();
            };
            let mut line = String::new();
            let mut line_count: u64 = 0;
            loop {
                line.clear();
                let n = reader
                    .read_line(&mut line)
                    .await
                    .context("read sidecar stdout")?;
                if n == 0 {
                    log::warn!(
                        "sidecar stdout EOF after {line_count} lines without handshake"
                    );
                    return Err(anyhow!("sidecar exited before handshake"));
                }
                line_count += 1;
                let trimmed = line.trim_end();
                // Diagnostic: log every stdout line we successfully read.
                // The Windows handshake-delivery bug (v1.22.8) manifests
                // as the child writing the handshake line but our tokio
                // reader never producing it; this log lets us tell "we
                // received non-handshake bytes but never the handshake"
                // from "we received nothing at all".
                log::info!(
                    "sidecar stdout line {line_count} ({n} bytes): {trimmed:?}"
                );
                if !trimmed.starts_with(HANDSHAKE_PREFIX) {
                    append_log_line(&parse_log_path, trimmed).await;
                    continue;
                }
                let json = trimmed.trim_start_matches(HANDSHAKE_PREFIX);
                let hs: Handshake =
                    serde_json::from_str(json).context("parse handshake JSON")?;
                return Ok(hs);
            }
        };

        // Windows-only secondary channel: poll for the handshake file
        // the child writes via ``OPENAGENTD_HANDSHAKE_FILE``.  Races
        // against ``parse_task`` (stdout); whichever delivers first
        // wins.  This sidesteps the anonymous-pipe + tokio overlapped-I/O
        // combination that, on at least two user installs, failed to
        // deliver the stdout-piped handshake line even though the child
        // had clearly written it (verified by running the same spawn
        // command manually from PowerShell — which produced the line
        // instantly).
        #[cfg(windows)]
        let file_task = {
            let file_path = self.handshake_file.clone();
            let log_path_for_file = log_path.clone();
            async move {
                let Some(path) = file_path else {
                    std::future::pending::<()>().await;
                    unreachable!();
                };
                let mut interval = tokio::time::interval(Duration::from_millis(50));
                interval.set_missed_tick_behavior(
                    tokio::time::MissedTickBehavior::Delay,
                );
                loop {
                    interval.tick().await;
                    match tokio::fs::read_to_string(&path).await {
                        Ok(content) => {
                            let trimmed = content.trim();
                            log::info!(
                                "sidecar handshake file {} ({} bytes): {trimmed:?}",
                                path.display(),
                                content.len()
                            );
                            return serde_json::from_str::<Handshake>(trimmed)
                                .with_context(|| {
                                    format!(
                                        "parse handshake JSON from {}",
                                        path.display()
                                    )
                                });
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                            continue;
                        }
                        Err(err) => {
                            append_log_line(
                                &log_path_for_file,
                                &format!(
                                    "handshake file read error path={} error={err}",
                                    path.display()
                                ),
                            )
                            .await;
                        }
                    }
                }
            }
        };

        #[cfg(windows)]
        let race = async {
            tokio::select! {
                res = parse_task => {
                    log::info!("sidecar handshake delivered via stdout");
                    res
                }
                res = file_task => {
                    log::info!("sidecar handshake delivered via file");
                    res
                }
            }
        };

        #[cfg(not(windows))]
        let race = parse_task;

        let hs = timeout(max_wait, race)
            .await
            .map_err(|_| anyhow!("timed out waiting for handshake"))??;
        self.handshake = Some(hs.clone());

        // Drain remaining stdout into backend.log in the background.
        // On Windows when the file-handshake won the race, parse_task
        // was cancelled mid-read; we take the reader out of the shared
        // Mutex and resume draining here.  When parse_task won, it
        // released its lock cleanly and we still take ownership.
        let drain_reader = reader.clone();
        let drain_log_path = log_path.clone();
        tokio::spawn(async move {
            if let Some(reader) = drain_reader.lock().await.take() {
                pipe_lines_to_log(reader, drain_log_path).await;
            }
        });

        Ok(hs)
    }

    /// True iff the child process is still running.
    ///
    /// ``Child::id()`` is *not* a liveness check — it returns ``Some``
    /// for the lifetime of the ``Child`` struct, even after the process
    /// has exited. ``try_wait`` is the only correct probe.
    pub fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,     // still running
            Ok(Some(_)) => false, // exited (and reaped)
            Err(_) => false,      // can't query — treat as dead
        }
    }

    pub async fn shutdown(&mut self) {
        self.shutdown_with_grace(SHUTDOWN_GRACE).await;
    }

    pub async fn shutdown_with_grace(&mut self, grace: Duration) {
        let Some(pid) = self.child.id() else {
            return;
        };
        log::info!("shutting down sidecar pid={pid}");
        #[cfg(unix)]
        {
            // SIGTERM lets uvicorn drain in-flight requests + run shutdown hooks
            // (mcp.stop(), team.stop(), otel.shutdown(), …).
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
        #[cfg(windows)]
        {
            // Windows has no SIGTERM equivalent. ``start_kill`` issues a
            // non-blocking ``TerminateProcess`` immediately so we don't sit on
            // a 5-second timeout in the common clean-exit path. The Job
            // Object's ``KILL_ON_JOB_CLOSE`` is still our backstop if Tauri
            // itself dies without running this code.
            let _ = self.child.start_kill();
        }
        match timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => log::info!("sidecar exited: {status}"),
            Ok(Err(e)) => log::warn!("sidecar wait error: {e}"),
            Err(_) => {
                log::warn!("sidecar did not exit in {grace:?}; force-killing");
                let _ = self.child.kill().await;
            }
        }
    }
}

fn resolve_python_bin(sidecar_root: &Path) -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    let candidates = [
        sidecar_root.join("python").join("python.exe"),
        sidecar_root.join("python").join("install").join("python.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = [
        sidecar_root.join("python").join("bin").join("python3"),
        sidecar_root.join("python").join("install").join("bin").join("python3"),
    ];
    for c in candidates.iter() {
        if c.is_file() {
            return Ok(c.clone());
        }
    }
    Err(anyhow!(
        "no python binary found in sidecar bundle (looked in: {:?})",
        candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
    ))
}

/// Drop a Windows ``\\?\`` extended-length prefix from *path*, if present.
///
/// Tauri's resource resolver canonicalises paths through Windows APIs that
/// sometimes return the verbatim form (``\\?\C:\Program Files\...``).
/// ``CreateProcessW`` accepts it, but some launcher ``.exe``s shipped
/// inside Python distributions mis-parse it as a UNC share name and exit
/// before their stderr is even wired up — the spawn "succeeds" and then
/// nothing happens: no handshake, no backend.log content.
///
/// No-op on paths without the prefix (and on macOS/Linux, where the
/// prefix never appears).
fn strip_unc_prefix(path: &Path) -> PathBuf {
    const VERBATIM: &str = r"\\?\";
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(VERBATIM) {
        // ``\\?\UNC\server\share`` is a UNC path; preserve the share form.
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

async fn pipe_lines_to_log<R>(mut reader: BufReader<R>, log_path: PathBuf)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::fs::OpenOptions;
    use tokio::io::AsyncWriteExt;
    let mut line = String::new();
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await
    else {
        return;
    };
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => return,
            Ok(_) => {
                let _ = file.write_all(line.as_bytes()).await;
                let _ = file.flush().await;
            }
            Err(_) => return,
        }
    }
}

async fn append_log_line(log_path: &Path, line: &str) {
    use tokio::fs::OpenOptions;
    use tokio::io::AsyncWriteExt;
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .await
    {
        let _ = f.write_all(line.as_bytes()).await;
        let _ = f.write_all(b"\n").await;
    }
}

#[cfg(windows)]
fn attach_to_job_object(child: &Child) -> Result<()> {
    use once_cell::sync::OnceCell;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // Single process-wide Job Object. ``KILL_ON_JOB_CLOSE`` means every
    // child attached here dies when Tauri exits — even on hard crash —
    // because closing the last handle to the job (which happens at
    // process teardown) terminates all members.
    //
    // ``HANDLE`` is ``*mut c_void`` under the hood and therefore not
    // ``Send`` / ``Sync`` by default — Rust has no way to know the Win32
    // kernel object behind the pointer is safe to use from any thread.
    // For a kernel job-object handle it *is* safe, so we wrap in a
    // newtype and assert it. Standard pattern for storing Win32 handles
    // in a ``static`` / ``OnceCell``.
    #[repr(transparent)]
    #[derive(Copy, Clone)]
    struct JobHandle(HANDLE);
    // SAFETY: Win32 job-object handles are kernel objects; the userland
    // pointer is just an opaque token whose dereferences happen inside
    // the kernel and are thread-safe by contract.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceCell<JobHandle> = OnceCell::new();

    let job = JOB.get_or_try_init::<_, anyhow::Error>(|| unsafe {
        let h = CreateJobObjectW(None, None)?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        Ok(JobHandle(h))
    })?;

    let pid = child.id().ok_or_else(|| anyhow!("child pid missing"))?;
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid)?;
        AssignProcessToJobObject(job.0, process)?;
    }
    Ok(())
}

/// Resume the primary thread of a process spawned with ``CREATE_SUSPENDED``.
///
/// We snapshot the system's thread list and find the first thread whose
/// owner PID matches the child. That's deterministically the primary
/// thread because the child hasn't run yet (it's suspended) so it cannot
/// have created any secondary threads.
#[cfg(windows)]
fn resume_primary_thread(child: &Child) -> Result<()> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let pid = child.id().ok_or_else(|| anyhow!("child pid missing"))?;

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
            .context("CreateToolhelp32Snapshot")?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if Thread32First(snap, &mut entry).is_err() {
            let _ = CloseHandle(snap);
            return Err(anyhow!("Thread32First returned no threads"));
        }
        loop {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                    .context("OpenThread")?;
                let prev_count = ResumeThread(thread);
                let _ = CloseHandle(thread);
                let _ = CloseHandle(snap);
                if prev_count == u32::MAX {
                    return Err(anyhow!("ResumeThread failed"));
                }
                return Ok(());
            }
            if Thread32Next(snap, &mut entry).is_err() {
                let _ = CloseHandle(snap);
                return Err(anyhow!("no thread found for pid {}", pid));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::strip_unc_prefix;
    use std::path::{Path, PathBuf};

    // ``strip_unc_prefix`` is pure string manipulation, so these run on
    // every platform — the v1.22.6 regression (verbatim ``\\?\`` path
    // handed to a Python launcher .exe, which mis-parses it and dies
    // silently) is guarded even by macOS/Linux CI.

    #[test]
    fn strip_local_path_verbatim_prefix() {
        let stripped = strip_unc_prefix(Path::new(r"\\?\C:\Program Files\OpenAgentd\python.exe"));
        assert_eq!(
            stripped,
            PathBuf::from(r"C:\Program Files\OpenAgentd\python.exe")
        );
    }

    #[test]
    fn strip_unc_share_verbatim_prefix() {
        let stripped = strip_unc_prefix(Path::new(r"\\?\UNC\server\share\python.exe"));
        assert_eq!(stripped, PathBuf::from(r"\\server\share\python.exe"));
    }

    #[test]
    fn unprefixed_local_path_is_unchanged() {
        let p = Path::new(r"C:\Program Files\OpenAgentd\python.exe");
        assert_eq!(strip_unc_prefix(p), p.to_path_buf());
    }

    #[test]
    fn unprefixed_unc_path_is_unchanged() {
        let p = Path::new(r"\\server\share\python.exe");
        assert_eq!(strip_unc_prefix(p), p.to_path_buf());
    }
}


