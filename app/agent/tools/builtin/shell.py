"""Shell execution tool — streaming output, workdir, $SHELL selection.

Design parity with opencode's bash.ts:

- Runs via the user's preferred POSIX shell (``$SHELL`` → zsh → bash → sh).
  Incompatible shells (fish, nu) are rejected in favour of zsh/bash.
- Streaming output: bytes are read incrementally and spilled to a temp file
  in the workspace when they exceed ``max_output_bytes``.  The LLM receives
  the first and last output lines inline, with the spill path advertised so
  it can ``read`` the full output if needed.
- ``workdir`` parameter (optional): run the command in a specific directory.
  Relative paths resolve inside the sandbox workspace. Absolute paths are
  allowed when the caller intentionally needs to run outside the workspace.
- Abort via ``asyncio.Event``: callers can inject an ``asyncio.Event`` via
  the injected ``_state`` mechanism; the shell tool checks ``interrupt_event``
  from the run context when the helper is called from the agent loop.
- Default timeout raised to 120 seconds (2 minutes) matching opencode.
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
import signal
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Literal

from loguru import logger
from pydantic import BaseModel, Field

from app.agent.artifacts import shell_output_dir
from app.agent.sandbox import get_sandbox
from app.agent.tools.builtin import shell_runtime as _shell_mod
from app.agent.tools.registry import InjectedArg, Tool

_SHELL_DESCRIPTION = (
    "Run a shell command via the user's POSIX shell. "
    "Supports &&, ||, pipes, $VAR, subshells. "
    "Default CWD is the session workspace. Relative workdir paths resolve inside it; "
    "use an absolute path to run elsewhere. "
    "Set background=true for long-running processes; returns a PID. "
    "Prefer file tools for file ops. "
    "IMPORTANT: stdin is /dev/null — the shell is non-interactive. "
    "Always use non-interactive flags to suppress prompts "
    "(e.g. npm init -y, npm create vite@latest -- --template react, "
    "pip install -q, apt-get install -y, npx --yes, python3 -m venv --without-pip)."
)

_BG_DESCRIPTION = (
    "Manage background processes started with shell(background=true). "
    "Actions: list, status, output, stop, wait."
)


class ShellArgs(BaseModel):
    """Arguments for the shell tool."""

    command: str = Field(
        description=(
            "Shell command to run. Supports &&, ||, pipes, $VAR, subshells. "
            "Runs via the user's preferred POSIX shell."
        )
    )
    description: str = Field(
        default="",
        description=(
            "Clear, concise description of what this command does in 5-10 words. "
            "Example: 'Run tests', 'Install dependencies', 'List directory'."
        ),
    )
    workdir: str | None = Field(
        default=None,
        description=(
            "Working directory for the command. "
            "Omit (or null) to run in the session workspace root. "
            "Relative paths (e.g. 'subdir') resolve inside the session workspace. "
            "Use an absolute path to run outside the workspace. "
            "Use this instead of 'cd' commands."
        ),
    )
    timeout_seconds: int | None = Field(
        default=None,
        description=(
            "Timeout in seconds. Defaults to 60. Increase for long builds. "
            "If the command legitimately takes longer, retry with a higher value."
        ),
    )
    background: bool = Field(
        default=False,
        description=(
            "Run without waiting. Use for dev servers/watchers. "
            "Returns a PID; use bg tool to manage it."
        ),
    )


class BgArgs(BaseModel):
    """Arguments for the bg tool."""

    action: Literal["list", "status", "output", "stop", "wait"] = Field(
        description="Action: 'list' (all processes), 'status', 'output', 'stop', or 'wait' (requires pid)."
    )
    pid: int | None = Field(
        default=None, description="PID (required for status/output/stop)."
    )
    last_n_lines: int | None = Field(
        default=None,
        description="Lines to return for 'output' and 'wait' actions (default all, max 200).",
    )


# ── Constants ────────────────────────────────────────────────────────────────

_DEFAULT_TIMEOUT_SECONDS = (
    60  # 60 s default; background mode handles long-running processes
)
_BG_OUTPUT_MAX_LINES = 200  # ring-buffer per background process

# Maximum lines and bytes to include inline in the result
_OUTPUT_MAX_LINES = 300
# Bytes kept inline; output beyond this spills to a temp file
_OUTPUT_MAX_BYTES = 131_072  # 128 KB (matches opencode Truncate.MAX_BYTES)


# ── Background process registry ──────────────────────────────────────────────


class _BgProcess:
    """Tracks a single background subprocess and its ring-buffer output."""

    __slots__ = ("proc", "command", "output", "_reader_task")

    def __init__(
        self,
        proc: asyncio.subprocess.Process,
        command: str,
    ) -> None:
        self.proc = proc
        self.command = command
        self.output: deque[str] = deque(maxlen=_BG_OUTPUT_MAX_LINES)
        self._reader_task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        """Read lines from stdout until EOF."""
        assert self.proc.stdout is not None
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace").rstrip("\n")
                self.output.append(decoded)
        except Exception:
            pass

    @property
    def pid(self) -> int:
        return self.proc.pid

    @property
    def alive(self) -> bool:
        return self.proc.returncode is None

    def read_output(self, last_n: int | None = None) -> str:
        lines = list(self.output)
        if last_n is not None:
            lines = lines[-last_n:]
        return "\n".join(lines)

    async def stop(self) -> int | None:
        if self.alive:
            _kill_process_group(self.proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                _kill_process_group(self.proc, signal.SIGKILL)
                await self.proc.wait()
        self._reader_task.cancel()
        return self.proc.returncode

    async def wait(self) -> int | None:
        await self.proc.wait()
        await self._reader_task
        return self.proc.returncode


def _limited_bg_output(text: str) -> str:
    """Return background output capped to the same inline limits as shell."""
    limited, was_cut = _tail_text(text, _OUTPUT_MAX_LINES, _OUTPUT_MAX_BYTES)
    if was_cut:
        return "...output truncated...\n" + limited
    return limited


# Module-level registry: PID → _BgProcess
_bg_processes: dict[int, _BgProcess] = {}


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
    return {k: v for k, v in os.environ.items() if k not in _PYTHON_ENV_LEAK_KEYS}


def _kill_process_group(proc: asyncio.subprocess.Process, sig: signal.Signals) -> None:
    """Send *sig* to the process group led by *proc*, falling back to direct kill."""
    pid = proc.pid
    if pid is None:
        return
    try:
        os.killpg(os.getpgid(pid), sig)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.send_signal(sig)
        except (ProcessLookupError, OSError):
            pass


def _tail_text(text: str, max_lines: int, max_bytes: int) -> tuple[str, bool]:
    """Return first and last lines that fit within *max_lines* and *max_bytes*.

    Returns ``(tail_text, was_cut)`` where ``was_cut`` is True when not all
    output is included.
    """
    lines = text.split("\n")
    if len(lines) <= max_lines and len(text.encode()) <= max_bytes:
        return text, False

    head_limit = max_lines // 2
    tail_limit = max_lines - head_limit
    out = lines[:head_limit] + ["...output truncated..."] + lines[-tail_limit:]

    while len("\n".join(out).encode()) > max_bytes and len(out) > 1:
        if len(out) % 2 == 0:
            del out[-2]
        else:
            del out[0]

    return "\n".join(out), True


def _spill_output(content: str, workspace: Path, call_id: str) -> Path:
    """Write *content* to the current sandbox shell output directory."""
    spill_dir = shell_output_dir()
    spill_dir.mkdir(parents=True, exist_ok=True)
    dest = spill_dir / f"{call_id}.txt"
    dest.write_text(content, encoding="utf-8")
    return dest


def _resolve_workdir(workdir: str | None) -> Path:
    """Resolve *workdir* to an absolute path anchored at the sandbox workspace.

    When *workdir* is None or a relative path, it resolves against the sandbox
    workspace root — keeping the agent confined to its session workspace.
    Absolute paths are passed through unchanged.
    """
    workspace = get_sandbox().workspace_root
    if workdir is None:
        return workspace
    p = Path(workdir)
    if p.is_absolute():
        return p
    return (workspace / p).resolve()


async def _emit_tool_output(
    callback: Callable[[str], Awaitable[None]] | None,
    text: str,
) -> None:
    if callback is None or not text:
        return
    try:
        await callback(text)
    except Exception:
        pass


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

    Uses the user's preferred POSIX shell (``$SHELL`` → zsh → bash → sh).
    Supports ``&&``, ``||``, pipes, ``$VAR``, subshells.
    Large output is streamed: the first and last output lines are returned inline;
    the full output is saved to the XDG session artifact directory.
    Set ``background=true`` for long-running processes.
    """
    sandbox = get_sandbox()

    # ── Sandbox path scan ─────────────────────────────────────────────
    # Best-effort: walk path-like tokens in the command and reject if
    # any resolve under a denied root or match a deny pattern. Mirrors
    # how file tools self-validate via sandbox.validate_path. See
    # SandboxConfig.check_command for limitations (no $VAR/$()/base64
    # evaluation — OS perms remain the last line of defence).
    hit = sandbox.check_command(command)
    if hit is not None:
        resolved, denied = hit
        raise PermissionError(
            f"Sandbox blocked 'shell': command would touch "
            f"'{resolved}' (denied by '{denied}')."
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
        proc = await asyncio.create_subprocess_exec(
            shell_bin,
            *argv,
            stdin=asyncio.subprocess.DEVNULL,  # no TTY — interactive prompts must not hang
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(cwd),
            env=_scrubbed_env(),
            start_new_session=True,  # new process group → clean killTree
        )

        # ── Background mode ───────────────────────────────────────────
        if background:
            bg = _BgProcess(proc, command)
            _bg_processes[bg.pid] = bg

            # Wait up to 3s to capture initial output and detect instant crashes
            warmup_secs = min(max(3, timeout_seconds or 3), 5)
            await asyncio.sleep(warmup_secs)

            if not bg.alive:
                del _bg_processes[bg.pid]
                exit_code = proc.returncode or 1
                initial = bg.read_output()
                status = f"[Failed — exit code {exit_code}]"
                return f"{status}\n\nProcess exited immediately:\n{initial}"

            initial = bg.read_output()
            logger.info(
                "shell_background_started pid={} command={}",
                bg.pid,
                command[:200],
            )
            lines = [
                f"[Background — PID {bg.pid}]",
                f"Command: {command}",
                "",
                "Use bg tool with this PID to check output, status, or stop it.",
            ]
            if initial:
                lines.append(f"\nInitial output:\n{initial}")
            return "\n".join(lines)

        # ── Foreground mode — streaming read ──────────────────────────
        # Read incrementally so we are not blocked on a huge buffer.
        assert proc.stdout is not None

        chunks: list[bytes] = []
        total_bytes = 0
        aborted = False

        pending_output: list[str] = []
        pending_lock = asyncio.Lock()

        async def flusher() -> None:
            try:
                while True:
                    await asyncio.sleep(0.1)
                    async with pending_lock:
                        if pending_output:
                            to_emit = "".join(pending_output)
                            pending_output.clear()
                            await _emit_tool_output(_tool_output, to_emit)
            except asyncio.CancelledError:
                async with pending_lock:
                    if pending_output:
                        to_emit = "".join(pending_output)
                        pending_output.clear()
                        await _emit_tool_output(_tool_output, to_emit)

        flusher_task = asyncio.create_task(flusher())

        try:
            async with asyncio.timeout(timeout):
                while True:
                    chunk = await proc.stdout.read(8192)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total_bytes += len(chunk)
                    decoded = chunk.decode("utf-8", errors="replace")
                    async with pending_lock:
                        pending_output.append(decoded)

        except asyncio.TimeoutError:
            _kill_process_group(proc, signal.SIGKILL)
            # Drain any remaining output after kill
            try:
                async with asyncio.timeout(2):
                    remaining = await proc.stdout.read()
                    if remaining:
                        chunks.append(remaining)
                        decoded = remaining.decode("utf-8", errors="replace")
                        async with pending_lock:
                            pending_output.append(decoded)
            except (asyncio.TimeoutError, Exception):
                pass
            await proc.wait()
            aborted = True
        finally:
            flusher_task.cancel()
            try:
                await flusher_task
            except Exception:
                pass

        # Wait for exit code
        if not aborted:
            await proc.wait()

        raw_bytes = b"".join(chunks)
        text = raw_bytes.decode("utf-8", errors="replace")
        exit_code = proc.returncode or 0

        logger.info(
            "shell_execute_complete exit_code={} output_bytes={}{}",
            exit_code,
            total_bytes,
            desc_tag,
        )

        status = (
            "[Succeeded]"
            if not aborted and exit_code == 0
            else (
                f"[Timed out after {timeout}s]"
                if aborted
                else f"[Failed — exit code {exit_code}]"
            )
        )

        # Spill to file if output is large
        tail, was_cut = _tail_text(text, _OUTPUT_MAX_LINES, _OUTPUT_MAX_BYTES)

        if was_cut:
            call_id = str(uuid.uuid4())[:8]
            try:
                spill_path = _spill_output(text, sandbox.workspace_root, call_id)
                rel = str(spill_path)
                header = (
                    f"{status}\n\n...output truncated — full output saved to {rel}\n\n"
                )
            except Exception:
                header = f"{status}\n\n...output truncated\n\n"
            result = header + tail
        else:
            result = f"{status}\n\n{text}"

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


# ── Background process management tool ────────────────────────────────────────


async def _background_process(
    action: Literal["list", "status", "output", "stop", "wait"],
    pid: int | None = None,
    last_n_lines: int | None = None,
) -> str:
    """Manage background processes started with shell(background=true)."""
    if action == "list":
        if not _bg_processes:
            return "No background processes running."
        lines = ["PID     | Status  | Command"]
        lines.append("--------|---------|--------")
        for pid_key, bg in _bg_processes.items():
            status = "running" if bg.alive else f"exited ({bg.proc.returncode})"
            lines.append(f"{pid_key:<7} | {status:<7} | {bg.command[:60]}")
        return "\n".join(lines)

    if pid is None:
        return "Error: 'pid' is required for action '{}'.".format(action)

    bg = _bg_processes.get(pid)
    if bg is None:
        known = ", ".join(str(p) for p in _bg_processes) if _bg_processes else "none"
        return (
            f"Error: No tracked background process with PID {pid}. Known PIDs: {known}."
        )

    if action == "status":
        if bg.alive:
            return f"PID {pid}: running\nCommand: {bg.command}\nBuffered lines: {len(bg.output)}"
        else:
            return f"PID {pid}: exited (code {bg.proc.returncode})\nCommand: {bg.command}\nBuffered lines: {len(bg.output)}"

    if action == "output":
        text = bg.read_output(last_n=last_n_lines)
        if not text:
            return f"PID {pid}: no output captured yet."
        return f"PID {pid} output:\n{_limited_bg_output(text)}"

    if action == "wait":
        exit_code = await bg.wait()
        text = bg.read_output(last_n=last_n_lines)
        if not text:
            return f"PID {pid}: exited (code {exit_code})\nNo output captured."
        return f"PID {pid}: exited (code {exit_code})\nFinal output:\n{_limited_bg_output(text)}"

    # action == "stop"
    exit_code = await bg.stop()
    _bg_processes.pop(pid, None)
    return f"PID {pid}: stopped (exit code {exit_code})\nFinal output:\n{bg.read_output(last_n=20)}"


background_process = Tool(
    _background_process,
    name="bg",
    description=_BG_DESCRIPTION,
    args_schema=BgArgs,
)
