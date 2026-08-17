"""Shell execution tool — streaming output, workdir, platform shell selection.

Design parity with opencode's bash.ts:

- On POSIX, runs via ``$SHELL`` → zsh → bash → sh and rejects incompatible
  shells such as fish/nu. On Windows, uses PowerShell 7 → Windows PowerShell →
  cmd.exe.
- Streaming output: bytes are read incrementally into a bounded head+tail
  buffer; once they exceed ``max_output_bytes`` every byte is streamed to a
  spill file in the XDG session artifact directory, so memory stays bounded
  no matter how much a command prints.  The LLM receives the first and last
  output lines inline, with the spill path advertised so it can ``read`` the
  full output if needed.
- ``workdir`` parameter (optional): run the command in a specific directory.
  Relative paths resolve inside the sandbox workspace. Absolute paths are
  allowed when the caller intentionally needs to run outside the workspace.
- Abort via task cancellation: foreground commands are killed as a process group
  before cancellation propagates.
- Foreground commands default to ``_DEFAULT_TIMEOUT_SECONDS``; callers can raise it
  explicitly. On timeout the command is SIGTERMed, given a short grace period to
  clean up, then SIGKILLed.
- Background mode preserved for long-running processes (dev servers etc.).

Output format (foreground)::

    [Succeeded]

    <output>

Or when truncated::

    [Succeeded]

    ...output truncated (full output saved to the XDG session artifact directory)

    <first N/2 lines>
    ...output truncated...
    <last N/2 lines>

``[Failed — exit code N]`` prefix when the command exits non-zero.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import sys
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any, BinaryIO

from loguru import logger
from pydantic import BaseModel, Field

from app.agent.artifacts import shell_output_dir
from app.agent.denied_paths import get_denied_paths

# Import the sibling module directly — going through the package __init__
# (``from app.agent.tools.builtin import shell_runtime``) reads an attribute
# of the partially-initialized package while builtin/__init__.py is itself
# importing this module, creating a module-level cycle.
import app.agent.tools.builtin.shell_runtime as _shell_mod
from app.agent.tools.registry import InjectedArg, Tool

_SHELL_KIND = "native Windows shell" if sys.platform == "win32" else "POSIX shell"
_SHELL_CAPABILITIES = (
    "PowerShell/cmd-native chaining, pipes, and variables"
    if sys.platform == "win32"
    else "&&, ||, pipes, variables, and subshells"
)
_SHELL_DESCRIPTION = (
    f"Run a command through the user's {_SHELL_KIND}; supports {_SHELL_CAPABILITIES}. "
    "Returns stdout and stderr combined. "
    "stdin is /dev/null, so use non-interactive flags for commands that may prompt. "
    "Use background=true only for long-lived processes. "
    "Prefer file tools for file operations."
)


class ShellArgs(BaseModel):
    """Arguments for the shell tool."""

    command: str = Field(description=f"{_SHELL_KIND.capitalize()} command to run.")
    description: str = Field(
        default="",
        description=("Purpose shown in logs and the activity UI."),
    )
    workdir: str | None = Field(
        default=None,
        description=(
            "Working directory; relative paths resolve inside the workspace, while "
            "absolute paths may run outside it. Prefer this over cd."
        ),
    )
    timeout_seconds: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Timeout in seconds; default 120, with no ceiling. Use a larger foreground "
            "timeout for slow commands."
        ),
    )
    background: bool = Field(
        default=False,
        description=(
            "Only for long-lived processes; returns the PID. Stay in the "
            "foreground when you need the command result."
        ),
    )


# ── Constants ────────────────────────────────────────────────────────────────

# 60 s pushed models to background test suites just to dodge the timeout (25 of
# 29 observed background launches were one-shot builds), then block on a capped
# `wait`. The foreground path has no ceiling, so a roomier default plus an
# explicit `timeout_seconds` hint removes the incentive.
_DEFAULT_TIMEOUT_SECONDS = 120
# Bound on reaping after SIGKILL — a D-state (uninterruptible I/O) process can
# survive it; log instead of hanging the tool call.
_POST_KILL_WAIT_SECONDS = 5.0
# Grace given to a timed-out foreground command between SIGTERM and SIGKILL.
# Long enough for a trap handler or interpreter shutdown hook to run, short
# enough that a hung command does not visibly extend the timeout.
_TIMEOUT_TERM_GRACE_SECONDS = 2.0

# Maximum lines and bytes to include inline in the result
_OUTPUT_MAX_LINES = 300
# Bytes kept inline; output beyond this spills to a temp file
_OUTPUT_MAX_BYTES = 131_072  # 128 KB (matches opencode Truncate.MAX_BYTES)
# Hard disk budget for one foreground command's spill artifact.  A command may
# print indefinitely; retaining a bounded inline result must not turn that into
# unbounded persistent disk usage.
_SPILL_MAX_BYTES = 10 * 1024 * 1024
# Limit live-output UI churn for noisy commands while keeping progress responsive.
# Two updates per second keeps progress readable without forcing the chat transcript,
# terminal row, and auto-follow observers through four layout cycles per second.
_OUTPUT_STREAM_INTERVAL_SECONDS = 0.5
_LIVE_OUTPUT_MAX_CHARS = 100_000
_LIVE_OUTPUT_MAX_LINES = 100
_LIVE_OUTPUT_TRUNCATED = "... [truncated live output] ...\n"
_WINDOWS_CREATE_NEW_PROCESS_GROUP = 0x0000_0200
_WINDOWS_CREATE_NO_WINDOW = 0x0800_0000
_FORCE_KILL_SIGNAL = getattr(signal, "SIGKILL", signal.SIGTERM)


# ── Helpers ───────────────────────────────────────────────────────────────────

# Environment variables that point at *our* Python runtime (the bundled
# sidecar's site-packages, the daemon's virtualenv, etc.).  Leaking these
# into a user-spawned subprocess is dangerous: another Python interpreter
# the agent invokes — ``browser-use``, ``pipx`` tools, ``uv tool`` shims
# installed under a different Python version — will find *our* pure-Python
# packages on ``sys.path`` and then crash when it tries to load a
# native extension built for our Python ABI (e.g. ``pydantic_core``
# compiled for cpython-3.14 vs. the tool's cpython-3.12).
_PYTHON_ENV_LEAK_KEYS: frozenset[str] = frozenset(
    {
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONEXECUTABLE",
        "PYTHONUSERBASE",
        "PYTHONSTARTUP",
        "VIRTUAL_ENV",
        "VIRTUAL_ENV_PROMPT",
        # uv injects these when it activates a tool venv; they steer
        # uv invocations to *our* cache/python and break user tools.
        "UV_PYTHON",
        "UV_PROJECT_ENVIRONMENT",
    }
)


def _scrubbed_env() -> dict[str, str]:
    """Return ``os.environ`` minus daemon-Python leak vars.

    The desktop sidecar sets ``PYTHONPATH`` so the bundled interpreter can
    import ``app`` (see ``desktop/src-tauri/src/sidecar.rs``).  That env
    var is inherited by every subprocess we spawn — including the shell
    tool — and shadows other Python tools' own packages.  We strip the
    known leak vars before spawning the user's shell command.
    """
    env = {k: v for k, v in os.environ.items() if k not in _PYTHON_ENV_LEAK_KEYS}
    env["PYTHONUNBUFFERED"] = "1"
    return env


def _format_exit_code(returncode: int | None) -> str:
    """Render an exit code the way the user's own shell would.

    ``asyncio`` reports a signal death as a negative number (``-9``), a Python
    convention no shell uses. Shells report ``128 + signal``, so a SIGKILL is
    the widely recognised ``137``. Naming the signal keeps the common causes
    (OOM killer, our own timeout) diagnosable.
    """
    if returncode is None:
        return "unknown"
    if returncode >= 0:
        return str(returncode)
    signum = -returncode
    try:
        return f"{128 + signum} ({signal.Signals(signum).name})"
    except ValueError:
        return str(128 + signum)


def _signal_posix_group(pid: int, sig: signal.Signals) -> bool:
    """Signal the process group *pid* leads; True when a group was signalled."""
    try:
        os.killpg(os.getpgid(pid), sig)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        pass
    # The leader may already be reaped while the group it led (pgid == pid,
    # thanks to start_new_session=True) still has live members — e.g. a child
    # started with ``cmd &``.  Signal the group id directly.
    try:
        os.killpg(pid, sig)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


async def _taskkill_tree(pid: int) -> bool:
    """Kill a Windows process tree without blocking the event loop."""
    try:
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return False
    try:
        return await asyncio.wait_for(killer.wait(), timeout=5) == 0
    except asyncio.TimeoutError:
        killer.kill()
        return False


async def _kill_process_group(
    proc: asyncio.subprocess.Process, sig: signal.Signals
) -> None:
    """Send *sig* to the process group led by *proc*, falling back to direct kill."""
    pid = proc.pid
    if pid is None:
        return
    if os.name == "nt":
        if await _taskkill_tree(pid):
            return
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass
        return
    if _signal_posix_group(pid, sig):
        return
    try:
        proc.send_signal(sig)
    except (ProcessLookupError, OSError):
        pass


async def _terminate_after_timeout(proc: asyncio.subprocess.Process) -> None:
    """End a timed-out foreground command, letting it clean up if it can.

    SIGKILL cannot be trapped, so killing outright strands whatever the command
    was mid-way through — temp files, child processes, an unflushed log — and
    discards its teardown output. Escalating mirrors the
    ``timeout(1)`` convention. Windows has no graceful equivalent for a process
    tree, so it goes straight to the forceful path.
    """
    if os.name == "nt":
        await _kill_process_group(proc, _FORCE_KILL_SIGNAL)
        return
    await _kill_process_group(proc, signal.SIGTERM)
    try:
        await _wait_exit(proc, _TIMEOUT_TERM_GRACE_SECONDS)
    except asyncio.TimeoutError:
        await _kill_process_group(proc, _FORCE_KILL_SIGNAL)


async def _wait_exit(proc: asyncio.subprocess.Process, timeout: float) -> int:
    """Wait for *proc* to exit, bounded by *timeout*; returns the exit code.

    ``Process.wait()`` only resolves once every transport pipe has
    disconnected — a child that inherited stdout (``cmd &``) delays it long
    past the tracked process's actual exit.  ``returncode`` is populated the
    moment the exit is reaped, so poll it (with backoff) instead.

    Raises:
        asyncio.TimeoutError: when the process is still running at deadline.
    """
    if proc.returncode is not None:
        return proc.returncode
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    delay = 0.005
    while proc.returncode is None:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise asyncio.TimeoutError
        await asyncio.sleep(min(delay, remaining))
        delay = min(delay * 2, 0.2)
    return proc.returncode


async def _wait_after_kill(proc: asyncio.subprocess.Process) -> None:
    """Reap *proc* after a force-kill without risking an unbounded hang."""
    try:
        await _wait_exit(proc, _POST_KILL_WAIT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("shell_process_survived_kill pid={}", proc.pid)


def _subprocess_platform_kwargs() -> dict[str, Any]:
    """Return process-group options accepted by the current platform."""
    if os.name == "nt":
        return {
            "creationflags": (
                _WINDOWS_CREATE_NEW_PROCESS_GROUP | _WINDOWS_CREATE_NO_WINDOW
            )
        }
    return {"start_new_session": True}


# Terminal escape sequences that survive into captured output when a program
# force-enables color despite the missing TTY (e.g. tools honoring
# FORCE_COLOR, or CI-styled loggers).  Covers CSI (colors, cursor movement,
# erase), OSC (hyperlinks/titles — BEL- or ST-terminated), and lone two-byte
# ESC sequences.  The LLM and the UI both receive plain text.
_ANSI_ESCAPE_RE = re.compile(
    r"""
    \x1b
    (?:
        \[ [0-?]* [ -/]* [@-~]            # CSI ... final byte
      | \] .*? (?: \x07 | \x1b \\ )       # OSC ... BEL or ST
      | [@-Z\\-_]                         # two-byte Fe escapes
    )
    """,
    re.VERBOSE | re.DOTALL,
)


_ANSI_ESCAPE_BYTES_RE = re.compile(
    _ANSI_ESCAPE_RE.pattern.encode(), re.VERBOSE | re.DOTALL
)


def _strip_ansi(text: str) -> str:
    """Remove ANSI/VT escape sequences from *text*, keeping printable content."""
    return _ANSI_ESCAPE_RE.sub("", text)


def _strip_ansi_bytes(data: bytes) -> bytes:
    """Byte-level :func:`_strip_ansi` for spill writes (no decode round-trip)."""
    return _ANSI_ESCAPE_BYTES_RE.sub(b"", data)


def _tail_text(text: str, max_lines: int, max_bytes: int) -> tuple[str, bool]:
    """Return first and last lines that fit within *max_lines* and *max_bytes*.

    Returns ``(tail_text, was_cut)`` where ``was_cut`` is True when not all
    output is included.  The head always starts at the first byte and the
    tail always ends at the last byte, so both ends stay deterministic.
    """
    lines = text.split("\n")
    if len(lines) <= max_lines and len(text.encode()) <= max_bytes:
        return text, False

    if len(lines) > max_lines:
        head_limit = max_lines // 2
        tail_limit = max_lines - head_limit
        text = "\n".join(
            lines[:head_limit] + ["...output truncated..."] + lines[-tail_limit:]
        )

    encoded = text.encode()
    if len(encoded) <= max_bytes:
        return text, True

    marker = b"\n...output truncated...\n"
    if max_bytes <= len(marker):
        return encoded[-max_bytes:].decode("utf-8", errors="ignore"), True
    content_bytes = max_bytes - len(marker)
    head_bytes = content_bytes // 2
    tail_bytes = content_bytes - head_bytes
    head = encoded[:head_bytes].decode("utf-8", errors="ignore")
    tail = encoded[-tail_bytes:].decode("utf-8", errors="ignore")
    return head + marker.decode() + tail, True


def _spill_dest() -> Path:
    """Return a fresh spill file path in the session shell-output directory."""
    spill_dir = shell_output_dir()
    spill_dir.mkdir(parents=True, exist_ok=True)
    return spill_dir / f"{str(uuid.uuid4())[:8]}.txt"


class _ForegroundOutput:
    """Bounded head+tail buffer with incremental spill for foreground output.

    Keeps the first and last ``_OUTPUT_MAX_BYTES`` in memory.  The moment
    output overflows the head budget, every byte (head included) is streamed
    to a spill file, so RAM stays bounded regardless of how much the command
    prints.  Spilled bytes are ANSI-stripped per chunk — an escape sequence
    split exactly across a chunk boundary may survive, which is acceptable
    for a plain-text artifact.
    """

    def __init__(self) -> None:
        self.total_bytes = 0
        self.spill_path: Path | None = None
        self._head: list[bytes] = []
        self._head_bytes = 0
        self._tail: deque[bytes] = deque()
        self._tail_bytes = 0
        self._file: BinaryIO | None = None
        self._spill_bytes = 0
        self._spill_capped = False
        self._spill_failed = False

    def add(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        rest = chunk
        if self._head_bytes < _OUTPUT_MAX_BYTES:
            take = min(len(chunk), _OUTPUT_MAX_BYTES - self._head_bytes)
            self._head.append(chunk[:take])
            self._head_bytes += take
            rest = chunk[take:]
        if not rest:
            return
        if self._file is None and not self._spill_failed:
            self._open_spill()
        if self._file is not None:
            try:
                payload = _strip_ansi_bytes(rest)
                remaining = _SPILL_MAX_BYTES - self._spill_bytes
                if remaining <= 0:
                    self._spill_capped = True
                else:
                    self._file.write(payload[:remaining])
                    self._spill_bytes += min(len(payload), remaining)
                    if len(payload) > remaining:
                        self._spill_capped = True
            except OSError as exc:
                logger.warning("shell_spill_write_failed error={!r}", exc)
                self.close()
                self._spill_failed = True
        self._tail.append(rest)
        self._tail_bytes += len(rest)
        while self._tail_bytes > _OUTPUT_MAX_BYTES and len(self._tail) > 1:
            self._tail_bytes -= len(self._tail.popleft())

    def _open_spill(self) -> None:
        """Open the spill file and backfill the buffered head bytes."""
        try:
            dest = _spill_dest()
            self._file = dest.open("wb")
            head = _strip_ansi_bytes(b"".join(self._head))
            self._file.write(head[:_SPILL_MAX_BYTES])
            self._spill_bytes = min(len(head), _SPILL_MAX_BYTES)
            self._spill_capped = len(head) > _SPILL_MAX_BYTES
            self.spill_path = dest
        except OSError as exc:
            logger.warning("shell_spill_open_failed error={!r}", exc)
            self.close()
            self.spill_path = None
            self._spill_failed = True

    def close(self) -> None:
        """Close the spill file handle (idempotent)."""
        if self._file is not None:
            try:
                self._file.close()
            except OSError:
                pass
            self._file = None

    def finalize(self) -> tuple[str, bool]:
        """Close the spill file and return ``(inline_text, was_cut)``.

        When output was cut only by the line limit (no byte overflow, so no
        streaming spill happened), the buffered output — complete in that
        case — is persisted so the full text remains readable.
        """
        self.close()
        inline, was_cut = self._inline_text()
        if was_cut and self.spill_path is None and not self._spill_failed:
            try:
                dest = _spill_dest()
                payload = _strip_ansi_bytes(b"".join(self._head) + b"".join(self._tail))
                dest.write_bytes(payload[:_SPILL_MAX_BYTES])
                self._spill_bytes = min(len(payload), _SPILL_MAX_BYTES)
                self._spill_capped = len(payload) > _SPILL_MAX_BYTES
                self.spill_path = dest
            except OSError as exc:
                logger.warning("shell_spill_write_failed error={!r}", exc)
        return inline, was_cut

    def _inline_text(self) -> tuple[str, bool]:
        dropped = self.total_bytes - self._head_bytes - self._tail_bytes
        if dropped <= 0:
            # Head (+ tail) hold the complete output — decode as one buffer
            # so no replacement char appears at the head/tail seam.
            text = _strip_ansi(
                (b"".join(self._head) + b"".join(self._tail)).decode(
                    "utf-8", errors="replace"
                )
            )
            return _tail_text(text, _OUTPUT_MAX_LINES, _OUTPUT_MAX_BYTES)
        head_text = _strip_ansi(b"".join(self._head).decode("utf-8", errors="replace"))
        tail_text = _strip_ansi(b"".join(self._tail).decode("utf-8", errors="replace"))
        combined = head_text + "\n...output truncated...\n" + tail_text
        inline, _ = _tail_text(combined, _OUTPUT_MAX_LINES, _OUTPUT_MAX_BYTES)
        return inline, True


def _resolve_workdir(workdir: str | None) -> Path:
    """Resolve *workdir* against the sandbox workspace and deny rules.

    Relative paths resolve against the workspace root; absolute paths are
    allowed by design (the caller may intentionally run outside the
    workspace) but must not point inside a denied sandbox root.

    Raises:
        PermissionError: when the resolved path falls under a denied root.
    """
    denied_paths = get_denied_paths()
    if workdir is None:
        return denied_paths.workspace_root
    return denied_paths.validate_path(os.path.expanduser(workdir))


def _live_output_window(text: str) -> tuple[str, bool]:
    """Trim *text* to the trailing window the chat UI actually renders.

    Returns ``(text, was_cut)``. The tail is preserved because that is what
    a user watching a running command reads; the head is what the client
    would discard on arrival anyway.
    """
    cut = False
    # Line cap first — it is the binding constraint for line-oriented output
    # (test runners, build logs) and is far cheaper than slicing 24 KB.
    if text.count("\n") > _LIVE_OUTPUT_MAX_LINES:
        index = len(text)
        for _ in range(_LIVE_OUTPUT_MAX_LINES):
            index = text.rfind("\n", 0, index)
            if index == -1:
                break
        if index != -1:
            text = text[index + 1 :]
            cut = True
    # Char cap still applies: a single line can be arbitrarily long.
    if len(text) > _LIVE_OUTPUT_MAX_CHARS:
        text = text[-_LIVE_OUTPUT_MAX_CHARS:]
        cut = True
    return text, cut


async def _emit_tool_output(
    callback: Callable[[str], Awaitable[None]] | None,
    text: str,
) -> None:
    if callback is None:
        return
    # Strip escape sequences before pushing to the live-output UI; the
    # frontend renders plain text, not a terminal emulator.
    text = _strip_ansi(text)
    if not text:
        return
    text, cut = _live_output_window(text)
    if cut:
        text = _LIVE_OUTPUT_TRUNCATED + text
    try:
        await callback(text)
    except Exception as exc:
        # Streaming callback (SSE push) failures must never kill the command.
        logger.debug("shell_stream_callback_failed error={!r}", exc)


# ── Foreground execute ────────────────────────────────────────────────────────


async def _shell(
    command: str,
    description: str = "",
    workdir: str | None = None,
    timeout_seconds: int | None = None,
    background: bool = False,
    _tool_output: Annotated[
        Callable[[str], Awaitable[None]] | None,
        InjectedArg(),
    ] = None,
) -> str:
    """Run a shell command and return combined stdout+stderr.

    Uses the native platform shell: ``$SHELL`` → zsh/bash/sh on POSIX, or
    PowerShell 7 → Windows PowerShell → cmd.exe on Windows.
    Large output is streamed: the first and last output lines are returned inline;
    the full output is saved to the XDG session artifact directory.
    Set ``background=true`` for long-running processes.
    """
    denied_paths = get_denied_paths()

    # ── Path scan ─────────────────────────────────────────────────────
    # Best-effort: walk path-like tokens in the command and reject if
    # any resolve under a denied root or match a deny pattern. Mirrors
    # how file tools self-validate via denied_paths.validate_path. See
    # DeniedPathsConfig.check_command for limitations (no $VAR/$()/base64
    # evaluation — OS perms remain the last line of defence).
    hit = denied_paths.check_command(command)
    if hit is not None:
        raise PermissionError(
            f"Sandbox blocked 'shell': command would touch denied path or pattern '{hit}'."
        )

    cwd = _resolve_workdir(workdir)
    timeout = (
        timeout_seconds if timeout_seconds is not None else _DEFAULT_TIMEOUT_SECONDS
    )
    shell_bin = _shell_mod.acceptable()
    shell_name = _shell_mod.name(shell_bin)

    desc_tag = f" ({description})" if description else ""
    logger.info(
        "shell_execute_start shell={} command={} cwd={} timeout={} background={}{}",
        shell_name,
        command[:200],
        cwd,
        timeout,
        background,
        desc_tag,
    )

    try:
        if not command.strip():
            return "[Succeeded]\n\n"

        # Build the subprocess.  For zsh/bash we use ``-l`` and explicitly
        # source the user's rc files (~/.zshenv, ~/.zshrc, ~/.bashrc) so the
        # agent sees the same PATH the user has in their terminal — including
        # ``~/.local/bin``, ``~/.bun/bin``, etc.  This matters when the daemon
        # is launched from a GUI/launchd context where PATH is minimal.
        # See ``shell_runtime.build_argv`` for details.
        argv = _shell_mod.build_argv(shell_bin, command)

        # ── Background mode ───────────────────────────────────────────
        if background:
            proc = await asyncio.create_subprocess_exec(
                shell_bin,
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                cwd=str(cwd),
                env=_scrubbed_env(),
                **_subprocess_platform_kwargs(),
            )
            logger.info(
                "shell_background_started pid={} command={}",
                proc.pid,
                command[:200],
            )
            return f"PID: {proc.pid}"

        # ── Foreground mode — streaming read ──────────────────────────
        proc = await asyncio.create_subprocess_exec(
            shell_bin,
            *argv,
            stdin=asyncio.subprocess.DEVNULL,  # no TTY — interactive prompts must not hang
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(cwd),
            env=_scrubbed_env(),
            **_subprocess_platform_kwargs(),
        )

        # Read incrementally into a bounded head+tail collector; overflow
        # streams to a spill file so memory stays flat for huge outputs.
        assert proc.stdout is not None

        collector = _ForegroundOutput()
        aborted = False

        # Single event loop, and join+clear happens with no await between
        # them, so no lock is needed around this buffer.
        pending: list[str] = []
        pending_chars = 0

        async def flush_pending() -> None:
            nonlocal pending_chars
            if not pending:
                return
            to_emit = "".join(pending)
            pending.clear()
            pending_chars = 0
            await _emit_tool_output(_tool_output, to_emit)

        async def flusher() -> None:
            try:
                while True:
                    await asyncio.sleep(_OUTPUT_STREAM_INTERVAL_SECONDS)
                    await flush_pending()
            except asyncio.CancelledError:
                await flush_pending()
                raise

        def buffer_live(chunk: bytes) -> None:
            nonlocal pending_chars
            pending.append(chunk.decode("utf-8", errors="replace"))
            pending_chars += len(pending[-1])
            # The UI only ever renders the trailing _LIVE_OUTPUT_MAX_LINES;
            # compact torrential output between flushes instead of hoarding it.
            if pending_chars > 2 * _LIVE_OUTPUT_MAX_CHARS:
                kept, _ = _live_output_window("".join(pending))
                pending[:] = [_LIVE_OUTPUT_TRUNCATED, kept]
                pending_chars = len(_LIVE_OUTPUT_TRUNCATED) + len(kept)

        flusher_task = asyncio.create_task(flusher())

        try:
            async with asyncio.timeout(timeout):
                while True:
                    chunk = await proc.stdout.read(8192)
                    if not chunk:
                        break
                    collector.add(chunk)
                    buffer_live(chunk)
                # Keep waiting for the exit code under the same deadline: a
                # command can close stdout (EOF) and keep running.
                await proc.wait()

        except asyncio.TimeoutError:
            await _terminate_after_timeout(proc)
            # Drain any remaining output after kill
            try:
                async with asyncio.timeout(2):
                    while True:
                        remaining = await proc.stdout.read(8192)
                        if not remaining:
                            break
                        collector.add(remaining)
                        buffer_live(remaining)
            except Exception as exc:
                # Post-kill drain is best-effort; the process is already dead.
                logger.debug("shell_postkill_drain_failed error={!r}", exc)
            await _wait_after_kill(proc)
            aborted = True
        except asyncio.CancelledError:
            await _kill_process_group(proc, _FORCE_KILL_SIGNAL)
            await _wait_after_kill(proc)
            raise
        finally:
            collector.close()
            flusher_task.cancel()
            try:
                await flusher_task
            except asyncio.CancelledError:
                pass  # expected: we just cancelled it
            except Exception as exc:
                logger.debug("shell_flusher_task_failed error={!r}", exc)

        exit_code = proc.returncode if proc.returncode is not None else 0

        logger.info(
            "shell_execute_complete exit_code={} output_bytes={}{}",
            exit_code,
            collector.total_bytes,
            desc_tag,
        )

        status = (
            "[Succeeded]"
            if not aborted and exit_code == 0
            else (
                f"[Timed out after {timeout}s]"
                if aborted
                else f"[Failed — exit code {_format_exit_code(exit_code)}]"
            )
        )

        inline, was_cut = collector.finalize()

        if was_cut:
            if collector.spill_path is not None:
                suffix = " (spill file capped)" if collector._spill_capped else ""
                header = (
                    f"{status}\n\n...output truncated{suffix} — full output saved to "
                    f"{collector.spill_path}\n\n"
                )
            else:
                header = f"{status}\n\n...output truncated\n\n"
            result = header + inline
        else:
            if aborted and not inline.strip():
                result = f"{status}\n\n(No output before timeout)"
            else:
                result = f"{status}\n\n{inline}" if inline else status

        if aborted:
            result += (
                f"\n\n<shell_metadata>\n"
                f"Command timed out after {timeout}s. "
                f"If this command legitimately takes longer, retry with a higher timeout_seconds value.\n"
                f"</shell_metadata>"
            )

        return result

    except PermissionError:
        raise
    except asyncio.TimeoutError:
        raise TimeoutError(
            f"Command timed out after {timeout}s: {command!r}. "
            f"Retry with a higher timeout_seconds value."
        )
    except Exception as e:
        logger.error("shell_execute_error command={} error={}", command[:200], e)
        raise RuntimeError(f"Command execution failed: {e}") from e


shell_tool = Tool(
    _shell,
    name="shell",
    description=_SHELL_DESCRIPTION,
    args_schema=ShellArgs,
)
