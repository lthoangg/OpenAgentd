"""Interactive terminal PTY sessions for the user-facing terminal emulator.

Spawns the user's shell in a real pseudo-terminal on the **backend host**
and exposes an async read/write/resize interface consumed by the
``/api/terminal`` WebSocket route.

Design notes
------------

- **Human-operated, not an agent tool.** Unlike the sandboxed ``shell``
  builtin (``app/agent/tools/builtin/shell.py``), this is a raw
  interactive shell driven by the user. It deliberately does NOT route
  through ``SandboxConfig.check_command`` — fencing a human out of their
  own machine would be both futile (any shell escapes a token filter)
  and hostile. The security boundary is *who can open a session*
  (WS auth via ``DesktopTokenMiddleware`` + single-use tickets in the
  route layer), not *what they can type*.
- **Shell selection** reuses ``shell_runtime.acceptable()`` — the same
  ``$SHELL`` → zsh → bash → sh detection the shell tool uses, so the
  terminal matches the user's environment. The shell is spawned as an
  interactive login shell (``-il`` where supported) since this IS a
  real terminal, unlike the tool's non-interactive ``-c`` invocations.
- **POSIX only** (``pty`` stdlib module). Backend hosts are macOS/Linux;
  Windows desktop builds were dropped in v1.23.0 and Windows server
  users run under WSL2.
- **Spawned via ``subprocess.Popen`` + ``pty.openpty()`` + ``os.login_tty``
  in ``preexec_fn``, not ``pty.fork()``.** By the time a user opens a
  terminal the process already has background threads (OTel span/metric
  exporters, the jsonl writer thread — see ``app/core/otel.py``), and
  CPython 3.12+ emits ``DeprecationWarning: This process is
  multi-threaded, use of forkpty() may lead to deadlocks in the child``
  for exactly that combination (tracked upstream as
  https://github.com/pexpect/pexpect/issues/827 — pexpect/ptyprocess hit
  the same wall). ``subprocess.Popen`` forks+execs through
  ``_posixsubprocess`` in C without the malloc/GIL hazards a pure-Python
  fork carries, so it doesn't trigger the warning while still giving us
  ``os.login_tty(slave_fd)`` for a real controlling terminal (job
  control / Ctrl+C works identically — see ``TestJobControl`` in the
  test module).
- **Resource bounds:** hard cap on concurrent sessions and an idle
  reaper so abandoned tabs can't accumulate PTYs.
"""

from __future__ import annotations

import asyncio
import fcntl
import functools
import os
import pty
import signal
import struct
import subprocess
import termios
import time
import uuid

from loguru import logger

from app.agent.tools.builtin import shell_runtime as _shell_mod
from app.agent.tools.builtin.shell import _scrubbed_env

# ── Tunables ─────────────────────────────────────────────────────────────────

#: Hard cap on simultaneously open PTY sessions across all clients.
MAX_SESSIONS = 8

#: Sessions with no read/write activity for this long are closed by the
#: reaper. Tests monkeypatch this module attribute.
IDLE_TIMEOUT_SECONDS: float = 30 * 60.0


def _reaper_tick_seconds() -> float:
    """Reaper wake-up interval — adaptive so tests with a tiny timeout
    stay fast while the 30-min production default only wakes every 30 s."""
    return min(max(IDLE_TIMEOUT_SECONDS / 10, 0.05), 30.0)


_READ_CHUNK = 65536

#: Outer-terminal identity vars that must not leak into the spawned shell.
#: The backend process itself may be running inside a real terminal (a
#: developer's ``uvicorn`` in Terminal.app/iTerm2, for example), and these
#: vars name *that* session — not the new one we're creating. Left
#: in place, macOS's ``/etc/zshrc_Apple_Terminal`` treats a matching
#: ``TERM_SESSION_ID`` as "resume this session" and prints
#: ``Restored session: <date>`` into the PTY at whatever point its precmd
#: hook fires, which can land mid-write and corrupt output that happens
#: to be a multibyte UTF-8 sequence at that byte offset.
_TERMINAL_IDENTITY_LEAK_KEYS: frozenset[str] = frozenset(
    {
        "TERM_SESSION_ID",
        "ITERM_SESSION_ID",
    }
)


# ── Session ──────────────────────────────────────────────────────────────────


class TerminalSession:
    """One live PTY: a shell process plus its controlling terminal fd."""

    def __init__(
        self,
        session_id: str,
        pid: int,
        master_fd: int,
        workspace: str,
        proc: subprocess.Popen | None = None,
    ) -> None:
        self.session_id = session_id
        self.pid = pid
        self.workspace = workspace
        self._master_fd = master_fd
        # Keeps the Popen object alive for the session's lifetime and lets
        # close() reap through it — letting a Popen get garbage collected
        # while its child is still running emits a ResourceWarning (and,
        # worse, its __del__ registers the pid in subprocess._active for a
        # *different* later reap than the explicit waitpid() below expects).
        self._proc = proc
        self._closed = False
        self._eof = False
        self.last_activity = time.monotonic()
        loop = asyncio.get_running_loop()
        self._read_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        # Reader: fd-readable callback pushes chunks onto the queue. Using
        # add_reader (not a thread) keeps everything on the event loop.
        loop.add_reader(master_fd, self._on_readable)

    # ── Reading ──────────────────────────────────────────────────────

    def _on_readable(self) -> None:
        try:
            data = os.read(self._master_fd, _READ_CHUNK)
        except (OSError, ValueError):
            data = b""
        if data:
            self.last_activity = time.monotonic()
            self._read_queue.put_nowait(data)
        else:
            # EOF — shell exited or fd closed.
            self._eof = True
            try:
                asyncio.get_running_loop().remove_reader(self._master_fd)
            except (ValueError, OSError):
                pass
            self._read_queue.put_nowait(None)

    async def read(self) -> bytes | None:
        """Await the next output chunk; ``None`` signals EOF."""
        if self._closed and self._read_queue.empty():
            return None
        chunk = await self._read_queue.get()
        return chunk

    # ── Writing / resize ─────────────────────────────────────────────

    async def write(self, data: bytes) -> None:
        """Write keystrokes to the PTY."""
        if self._closed or self._eof:
            return
        self.last_activity = time.monotonic()
        try:
            os.write(self._master_fd, data)
        except OSError:
            pass

    def resize(self, rows: int, cols: int) -> None:
        """Propagate a client resize to the PTY (TIOCSWINSZ + SIGWINCH)."""
        if self._closed:
            return
        rows = max(1, min(rows, 1000))
        cols = max(1, min(cols, 4000))
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        try:
            fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)
            os.killpg(os.getpgid(self.pid), signal.SIGWINCH)
        except (OSError, ProcessLookupError):
            pass

    # ── Lifecycle ────────────────────────────────────────────────────

    @property
    def alive(self) -> bool:
        if self._closed:
            return False
        if self._proc is not None:
            # Popen.poll() does a WNOHANG waitpid and caches the result —
            # the single source of truth for this child's status, so every
            # other place that needs "is it dead yet" goes through it too
            # (mixing this with a bare os.waitpid() risks an ECHILD race
            # if both reap the same exit concurrently).
            return self._proc.poll() is None
        try:
            pid, _status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            return False
        return pid == 0

    async def close(self) -> None:
        """Kill the shell's process group and release the PTY fd."""
        if self._closed:
            return
        self._closed = True
        _SESSIONS.pop(self.session_id, None)

        try:
            asyncio.get_running_loop().remove_reader(self._master_fd)
        except (ValueError, OSError):
            pass

        try:
            os.killpg(os.getpgid(self.pid), signal.SIGHUP)
        except (ProcessLookupError, PermissionError, OSError):
            pass

        # Grace period, then SIGKILL. `alive` polls (non-blocking) so this
        # never stalls the event loop.
        for _ in range(10):
            if not self.alive:
                break
            await asyncio.sleep(0.05)
        else:
            try:
                os.killpg(os.getpgid(self.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            # SIGKILL can't be caught/blocked, so a short *blocking* reap
            # here is safe (won't hang) and guarantees no zombie is left
            # behind — matching the pre-SIGKILL loop's non-blocking style
            # would risk returning from close() while the pid is still
            # unreaped.
            try:
                if self._proc is not None:
                    self._proc.wait(timeout=2.0)
                else:
                    os.waitpid(self.pid, 0)
            except (ChildProcessError, subprocess.TimeoutExpired, OSError):
                pass

        try:
            os.close(self._master_fd)
        except OSError:
            pass
        # Unblock any pending read().
        self._read_queue.put_nowait(None)
        logger.info(
            "terminal_session_closed session_id={} pid={}", self.session_id, self.pid
        )


# ── Registry ─────────────────────────────────────────────────────────────────

_SESSIONS: dict[str, TerminalSession] = {}
_reaper_task: asyncio.Task | None = None


def get_session(session_id: str) -> TerminalSession | None:
    """Return the live session for *session_id*, if any."""
    return _SESSIONS.get(session_id)


async def create_session(
    *,
    workspace: str,
    rows: int = 24,
    cols: int = 80,
) -> TerminalSession:
    """Spawn the user's shell in a new PTY rooted at *workspace*.

    Callers are responsible for workspace validation
    (``team_manager.validate_workspace``) — this function trusts its input.
    """
    if len(_SESSIONS) >= MAX_SESSIONS:
        raise RuntimeError(
            f"Too many open terminal sessions (max {MAX_SESSIONS}). "
            "Close an existing terminal first."
        )

    shell_bin = _shell_mod.acceptable()
    shell_name = _shell_mod.name(shell_bin)
    # Interactive login shell for zsh/bash so the user's rc files load
    # and the prompt behaves exactly like their normal terminal.
    argv = [shell_bin, "-il"] if shell_name in ("zsh", "bash") else [shell_bin, "-i"]

    env = _scrubbed_env()
    for key in _TERMINAL_IDENTITY_LEAK_KEYS:
        env.pop(key, None)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"

    proc, master_fd = _fork_pty(argv, cwd=workspace, env=env)

    session = TerminalSession(
        session_id=uuid.uuid4().hex,
        pid=proc.pid,
        master_fd=master_fd,
        workspace=workspace,
        proc=proc,
    )
    session.resize(rows, cols)
    _SESSIONS[session.session_id] = session
    _ensure_reaper()
    logger.info(
        "terminal_session_created session_id={} pid={} shell={} workspace={}",
        session.session_id,
        proc.pid,
        shell_name,
        workspace,
    )
    return session


def _fork_pty(
    argv: list[str], *, cwd: str, env: dict[str, str]
) -> tuple[subprocess.Popen, int]:
    """Spawn *argv* attached to a fresh PTY, returning ``(proc, master_fd)``.

    Deliberately ``subprocess.Popen`` + ``pty.openpty()`` rather than
    ``pty.fork()`` — see the module docstring for why (avoids the
    multi-threaded-fork ``DeprecationWarning``/deadlock hazard while
    keeping identical job-control semantics via ``os.login_tty``).
    """
    master_fd, slave_fd = pty.openpty()
    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            # Runs in the child before exec: makes the pty slave the
            # child's controlling terminal (new session leader + ctty +
            # stdin/stdout/stderr), exactly what pty.fork()'s child side
            # did — job control (Ctrl+C/Ctrl+Z) depends on this.
            preexec_fn=functools.partial(os.login_tty, slave_fd),
            close_fds=True,
            start_new_session=False,  # login_tty already calls setsid()
        )
    finally:
        os.close(slave_fd)
    os.set_blocking(master_fd, False)
    return proc, master_fd


async def close_all() -> None:
    """Close every live session (server shutdown / test isolation)."""
    global _reaper_task
    for session in list(_SESSIONS.values()):
        await session.close()
    _SESSIONS.clear()
    if _reaper_task is not None:
        _reaper_task.cancel()
        try:
            await _reaper_task
        except (asyncio.CancelledError, Exception):
            pass
        _reaper_task = None


# ── Idle reaper ──────────────────────────────────────────────────────────────


def _ensure_reaper() -> None:
    global _reaper_task
    if _reaper_task is None or _reaper_task.done():
        _reaper_task = asyncio.create_task(_reap_idle_loop())


async def _reap_idle_loop() -> None:
    while _SESSIONS:
        await asyncio.sleep(_reaper_tick_seconds())
        now = time.monotonic()
        for session in list(_SESSIONS.values()):
            idle = now - session.last_activity
            if idle > IDLE_TIMEOUT_SECONDS or not session.alive:
                logger.info(
                    "terminal_session_reaped session_id={} idle_s={:.0f}",
                    session.session_id,
                    idle,
                )
                await session.close()
