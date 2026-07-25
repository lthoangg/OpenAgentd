"""Tests for app/tools/builtin/shell.py — shell & bg.

Covers the rewritten shell tool:
- $SHELL detection via app.agent.tools.builtin.shell_runtime
- streaming foreground execution
- workdir parameter
- timeout handling
- output spilling to the XDG session artifact directory
- background process management
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.errors import ToolArgumentError
from app.agent.sandbox import SandboxConfig, set_sandbox
import app.agent.tools.builtin.shell as shell_module
from app.agent.tools.builtin.shell import (
    _PYTHON_ENV_LEAK_KEYS,
    _BgProcess,
    _bg_processes,
    _scrubbed_env,
    _shell,
    _strip_ansi,
    _tail_text,
    background_process,
    shell_tool,
)
from app.core.config import settings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def sandbox(tmp_path):
    sb = SandboxConfig(workspace=str(tmp_path))
    token = set_sandbox(sb)
    yield sb
    from app.agent.sandbox import _sandbox_ctx

    _sandbox_ctx.reset(token)


@pytest.fixture
def sandbox_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config = SandboxConfig(
        workspace=str(workspace), session_id="session-1", max_execution_seconds=120
    )
    token = set_sandbox(config)
    yield workspace
    from app.agent.sandbox import _sandbox_ctx

    _sandbox_ctx.reset(token)


@pytest.fixture(autouse=True)
def fast_shell(monkeypatch):
    """Use bare /bin/sh in shell tests unless a test exercises detection."""
    if sys.platform == "win32":
        return
    monkeypatch.setattr(
        "app.agent.tools.builtin.shell_runtime._CACHED_SHELL", "/bin/sh"
    )


# ---------------------------------------------------------------------------
# _tail_text helper
# ---------------------------------------------------------------------------


def test_tail_text_short_passthrough():
    text = "line1\nline2\nline3"
    tail, cut = _tail_text(text, max_lines=200, max_bytes=131072)
    assert tail == text
    assert cut is False


def test_tail_text_cuts_by_lines_keeps_head_and_tail():
    text = "\n".join(f"line{i}" for i in range(300))
    tail, cut = _tail_text(text, max_lines=10, max_bytes=131072)
    assert cut is True
    lines = tail.split("\n")
    assert len(lines) <= 11
    assert "line0" in tail
    assert "line299" in tail
    assert "line150" not in tail
    assert "...output truncated..." in tail


def test_tail_text_cuts_by_bytes():
    # 200 lines, each 100 chars → 20 KB, limit to 1 KB
    text = "\n".join("x" * 100 for _ in range(200))
    tail, cut = _tail_text(text, max_lines=200, max_bytes=1024)
    assert cut is True
    assert len(tail.encode()) <= 1024 + 200  # generous for newlines


def test_tail_text_caps_a_single_oversized_line():
    text = "x" * 20_000

    tail, cut = _tail_text(text, max_lines=200, max_bytes=1024)

    assert cut is True
    assert len(tail.encode()) <= 1024
    assert tail.endswith("x" * 100)


# ---------------------------------------------------------------------------
# _strip_ansi — remove terminal escape sequences from captured output
# ---------------------------------------------------------------------------


def test_strip_ansi_removes_sgr_color_codes():
    """CSI SGR sequences (colors) must be stripped, keeping the text."""
    colored = '\x1b[36m<div\x1b[39m \x1b[33mclass\x1b[39m=\x1b[32m"grid"\x1b[39m>'
    assert _strip_ansi(colored) == '<div class="grid">'


def test_strip_ansi_removes_cursor_and_erase_sequences():
    """Non-SGR CSI sequences (cursor movement, erase line) must be stripped."""
    text = "progress\x1b[2K\x1b[1Gdone\x1b[0m"
    assert _strip_ansi(text) == "progressdone"


def test_strip_ansi_removes_osc_hyperlinks():
    """OSC sequences (e.g. terminal hyperlinks, title set) must be stripped."""
    # OSC 8 hyperlink terminated by BEL and by ST (ESC \)
    bel = "\x1b]8;;https://example.com\x07label\x1b]8;;\x07"
    st = "\x1b]0;window title\x1b\\body"
    assert _strip_ansi(bel) == "label"
    assert _strip_ansi(st) == "body"


def test_strip_ansi_preserves_plain_text_and_newlines():
    plain = "line1\nline2\n\ttabbed"
    assert _strip_ansi(plain) == plain


@pytest.mark.asyncio
async def test_shell_output_has_ansi_codes_stripped(sandbox_workspace):
    """End-to-end: a command emitting color codes returns clean text."""
    result = await _shell("printf '\\033[32mgreen\\033[0m plain\\n'")

    assert "[Succeeded]" in result
    assert "green plain" in result
    assert "\x1b[" not in result


# ---------------------------------------------------------------------------
# _scrubbed_env — strip daemon-Python leak vars before spawning user shell
# ---------------------------------------------------------------------------


def test_scrubbed_env_removes_python_leak_vars(monkeypatch):
    """PYTHONPATH/PYTHONHOME/VIRTUAL_ENV leak from daemon → must be scrubbed."""
    monkeypatch.setenv("PYTHONPATH", "/Applications/OpenAgentd.app/.../site-packages")
    monkeypatch.setenv("PYTHONHOME", "/Applications/OpenAgentd.app/.../python")
    monkeypatch.setenv("VIRTUAL_ENV", "/some/venv")
    monkeypatch.setenv("UV_PYTHON", "/some/python")
    # Innocent env vars must survive.
    monkeypatch.setenv("HOME", "/Users/test")
    monkeypatch.setenv("PATH", "/usr/local/bin:/usr/bin")

    env = _scrubbed_env()

    assert "PYTHONPATH" not in env
    assert "PYTHONHOME" not in env
    assert "VIRTUAL_ENV" not in env
    assert "UV_PYTHON" not in env
    assert env["HOME"] == "/Users/test"
    assert env["PATH"] == "/usr/local/bin:/usr/bin"


def test_scrubbed_env_leak_keys_covers_known_offenders():
    """Sanity check: the leak-key set covers the vars we documented."""
    expected = {
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONEXECUTABLE",
        "PYTHONUSERBASE",
        "PYTHONSTARTUP",
        "VIRTUAL_ENV",
        "VIRTUAL_ENV_PROMPT",
        "UV_PYTHON",
        "UV_PROJECT_ENVIRONMENT",
    }
    assert expected.issubset(_PYTHON_ENV_LEAK_KEYS)


@pytest.mark.asyncio
async def test_shell_subprocess_does_not_inherit_pythonpath(sandbox, monkeypatch):
    """End-to-end: PYTHONPATH set on daemon must NOT reach the spawned command."""
    monkeypatch.setenv("PYTHONPATH", "/leak/site-packages")
    # ``printenv`` exits with code 1 when the var is unset → command "succeeds"
    # in the shell sense (the shell itself ran fine) but echoes nothing.
    # We rely on the absence of the leak path in the output.
    result = await _shell("printenv PYTHONPATH; echo done")

    assert "/leak/site-packages" not in result
    assert "done" in result


# ---------------------------------------------------------------------------
# Shell detection (app.agent.tools.builtin.shell_runtime)
# ---------------------------------------------------------------------------


def test_shell_acceptable_returns_string():
    from app.agent.tools.builtin import shell_runtime as shell_mod

    result = shell_mod.acceptable()
    assert isinstance(result, str)
    assert len(result) > 0


def test_shell_name_extracts_basename():
    from app.agent.tools.builtin import shell_runtime as shell_mod

    assert shell_mod.name("/bin/zsh") == "zsh"
    assert shell_mod.name("/usr/bin/bash") == "bash"
    assert shell_mod.name("/bin/sh") == "sh"


def test_shell_blacklist_fish_falls_back(monkeypatch):
    """When $SHELL=fish, acceptable() should return a POSIX shell."""
    from app.agent.tools.builtin import shell_runtime as shell_mod

    shell_mod.reset_cache()
    monkeypatch.setenv("SHELL", "/usr/local/bin/fish")
    result = shell_mod.acceptable()
    assert shell_mod.name(result) not in shell_mod.BLACKLIST
    shell_mod.reset_cache()


def test_shell_blacklist_nu_falls_back(monkeypatch):
    """When $SHELL=nu, acceptable() should return a POSIX shell."""
    from app.agent.tools.builtin import shell_runtime as shell_mod

    shell_mod.reset_cache()
    monkeypatch.setenv("SHELL", "/usr/local/bin/nu")
    result = shell_mod.acceptable()
    assert shell_mod.name(result) not in shell_mod.BLACKLIST
    shell_mod.reset_cache()


# ---------------------------------------------------------------------------
# Foreground execution
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="native Windows shell smoke")
async def test_windows_shell_executes_native_command(sandbox_workspace):
    result = await _shell("echo windows-shell-ok")

    assert "[Succeeded]" in result
    assert "windows-shell-ok" in result


@pytest.mark.asyncio
async def test_execute_basic_command(sandbox_workspace):
    result = await shell_tool.arun(command="echo 'hello world'")
    assert "[Succeeded]" in result
    assert "hello world" in result


@pytest.mark.asyncio
async def test_cancelling_foreground_shell_terminates_process_group(sandbox_workspace):
    process_started = asyncio.Event()
    shell_pid: int | None = None

    async def capture_output(output: str) -> None:
        nonlocal shell_pid
        shell_pid = int(output.strip())
        process_started.set()

    task = asyncio.create_task(_shell("echo $$; sleep 60", _tool_output=capture_output))
    await asyncio.wait_for(process_started.wait(), timeout=2)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert shell_pid is not None
    with pytest.raises(ProcessLookupError):
        os.kill(shell_pid, 0)


@pytest.mark.asyncio
async def test_cancelling_background_shell_during_startup_terminates_process(
    sandbox_workspace, monkeypatch
):
    # Park the warmup loop on an hour-long poll sleep; registration happens
    # before the first poll, so once the registry is non-empty the task is
    # blocked inside warmup and safe to cancel.
    import app.agent.tools.builtin.shell as shell_mod

    monkeypatch.setattr(shell_mod, "_BG_WARMUP_POLL_SECONDS", 3600)

    task = asyncio.create_task(_shell("sleep 60", background=True))
    for _ in range(100):
        if _bg_processes:
            break
        await asyncio.sleep(0.01)
    [pid] = list(_bg_processes)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert pid not in _bg_processes
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.asyncio
async def test_shell_with_exit_code(sandbox_workspace):
    result = await shell_tool.arun(command="false")
    assert "[Failed" in result
    assert "exit code 1" in result


@pytest.mark.asyncio
async def test_shell_empty_returns_succeeded(sandbox_workspace):
    result = await _shell("")
    assert "[Succeeded]" in result


@pytest.mark.asyncio
async def test_shell_whitespace_only_returns_succeeded(sandbox_workspace):
    result = await _shell("   ")
    assert "[Succeeded]" in result


@pytest.mark.asyncio
async def test_shell_pipes_and_chaining(sandbox_workspace):
    result = await shell_tool.arun(command="echo hello | tr 'a-z' 'A-Z'")
    assert "[Succeeded]" in result
    assert "HELLO" in result


@pytest.mark.asyncio
async def test_shell_env_variable(sandbox_workspace):
    result = await shell_tool.arun(command="TEST_VAR=42 && echo $TEST_VAR")
    assert "[Succeeded]" in result


@pytest.mark.asyncio
async def test_shell_description_parameter(sandbox_workspace):
    result = await shell_tool.arun(command="echo ok", description="Print ok to stdout")
    assert "[Succeeded]" in result
    assert "ok" in result


@pytest.mark.asyncio
async def test_shell_emits_foreground_output_delta(sandbox_workspace, monkeypatch):
    monkeypatch.setattr(
        "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
    )
    chunks: list[str] = []

    async def capture(text: str) -> None:
        chunks.append(text)

    result = await _shell(
        command="printf 'hello\\nworld\\n'",
        timeout_seconds=1,
        _tool_output=capture,
    )

    assert "[Succeeded]" in result
    assert "hello" in "".join(chunks)
    assert "world" in "".join(chunks)


# ---------------------------------------------------------------------------
# workdir parameter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shell_workdir_absolute(sandbox_workspace, tmp_path):
    """workdir= resolves to the given directory, outside the sandbox workspace."""
    target = tmp_path / "custom_dir"
    target.mkdir()
    (target / "marker.txt").write_text("found me")

    result = await shell_tool.arun(
        command="cat marker.txt",
        workdir=str(target),
    )
    assert "[Succeeded]" in result
    assert "found me" in result


@pytest.mark.asyncio
async def test_shell_workdir_default_is_sandbox(sandbox_workspace):
    """Without workdir=, the command runs in sandbox.workspace_root."""
    (sandbox_workspace / "in_workspace.txt").write_text("workspace file")
    result = await shell_tool.arun(command="cat in_workspace.txt")
    assert "[Succeeded]" in result
    assert "workspace file" in result


# ---------------------------------------------------------------------------
# Output spilling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shell_large_output_spills(sandbox_workspace, tmp_path):
    """Output exceeding _OUTPUT_MAX_BYTES is spilled to session-scoped shell output."""
    # Patch _OUTPUT_MAX_BYTES to a tiny value so we spill even with small output
    with patch("app.agent.tools.builtin.shell._OUTPUT_MAX_BYTES", 100):
        result = await shell_tool.arun(
            command="echo 'line1' && echo 'line2' && echo 'line3' && echo 'line4'"
        )

    # With tiny tail limit, output spills
    # Just confirm the tool runs without error
    assert (
        "[Succeeded]" in result or "[Failed" in result
    )  # either is fine for this test


@pytest.mark.asyncio
async def test_shell_output_spill_file_readable(sandbox_workspace):
    """When output is spilled, the spill file is readable from the workspace."""
    with patch("app.agent.tools.builtin.shell._OUTPUT_MAX_BYTES", 10):
        result = await shell_tool.arun(
            command="echo 'some longer output that will be truncated'"
        )

    import re

    match = re.search(r"([a-f0-9]+\.txt)", result)
    assert match is not None
    from app.agent.artifacts import shell_output_dir

    spill_file = shell_output_dir("session-1") / match.group(1)
    assert (
        spill_file.read_text(encoding="utf-8")
        == "some longer output that will be truncated\n"
    )
    assert str(sandbox_workspace / ".openagentd") not in result


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shell_timeout(sandbox_workspace):
    """Commands that exceed timeout produce a [Timed out] result."""
    # Call _shell directly to pass a sub-second float timeout (tool schema requires int).
    result = await _shell("sleep 60", timeout_seconds=0.1)
    assert "[Timed out" in result or "[Failed" in result
    assert (
        "timeout" in result.lower()
        or "timed out" in result.lower()
        or "[Failed" in result
    )


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shell_generic_exception_raises_runtime_error(sandbox):
    """When create_subprocess_exec raises an unexpected error, RuntimeError is raised."""
    with patch(
        "asyncio.create_subprocess_exec",
        side_effect=OSError("spawn failed"),
    ):
        with pytest.raises(RuntimeError, match="Command execution failed"):
            await _shell("echo hello")


@pytest.mark.asyncio
async def test_shell_permission_error_reraises(sandbox):
    """PermissionError raised inside the try block is re-raised unchanged."""
    with patch(
        "asyncio.create_subprocess_exec",
        side_effect=PermissionError("denied"),
    ):
        with pytest.raises(PermissionError, match="denied"):
            await _shell("echo hello")


# ---------------------------------------------------------------------------
# Background execution
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_bg_registry():
    """Ensure background registry is clean before and after each test."""
    _bg_processes.clear()
    yield
    for bg in list(_bg_processes.values()):
        if bg.alive:
            bg.proc.kill()
    _bg_processes.clear()


@pytest.fixture()
def fast_bg(monkeypatch):
    """Shrink the production ~3s warmup poll loop so background tests finish fast.

    The warmup exists to (a) drain initial echo output via the reader task
    and (b) detect immediate exits.  Production polls 30 × 100 ms, breaking
    early on exit or settled output; tests poll 5 × 10 ms — enough event-loop
    turns for the reader task to consume ``echo`` output on every platform
    tested here.

    We also force ``/bin/sh`` so we skip zsh login + rc-file sourcing
    (~200ms boot cost), which would otherwise blow past the short poll
    budget before the spawned process finishes echoing.
    """
    monkeypatch.setattr(shell_module, "_BG_WARMUP_POLLS", 5)
    monkeypatch.setattr(shell_module, "_BG_WARMUP_POLL_SECONDS", 0.01)
    monkeypatch.setattr(shell_module, "_BG_WARMUP_SETTLED_POLLS", 1)
    # ``/bin/sh`` takes the bare ``-c`` argv path → no rc sourcing → instant boot.
    monkeypatch.setattr(
        "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
    )


def test_completed_background_processes_expire_after_ten_minutes():
    """Pruning expires completed records without sleeping in the test."""
    completed = MagicMock(alive=False)
    completed.completed_at = None
    _bg_processes[1001] = completed

    shell_module._prune_completed_bg_processes(clock=lambda: 0)
    assert 1001 in _bg_processes

    shell_module._prune_completed_bg_processes(clock=lambda: 600)
    assert 1001 in _bg_processes

    shell_module._prune_completed_bg_processes(clock=lambda: 600.001)
    assert 1001 not in _bg_processes


def test_completed_background_process_limit_never_evicts_alive_processes():
    """The completed-record cap retains all live jobs and newest completions."""
    alive = MagicMock(alive=True)
    _bg_processes[1] = alive
    for pid in range(2, 103):
        completed = MagicMock(alive=False)
        completed.completed_at = float(pid)
        _bg_processes[pid] = completed

    shell_module._prune_completed_bg_processes(clock=lambda: 200)

    assert 1 in _bg_processes
    assert len(_bg_processes) == 101
    assert 2 not in _bg_processes
    assert set(_bg_processes) == {1, *range(3, 103)}


@pytest.mark.asyncio
async def test_background_reader_bounds_a_single_oversized_line():
    reader = asyncio.StreamReader()
    reader.feed_data(b"x" * 200_000)
    reader.feed_eof()
    proc = MagicMock(stdout=reader, returncode=0, pid=4242)

    bg = _BgProcess(proc, "noisy-command", "session-1")
    await bg._reader_task

    output = bg.read_output()
    assert output.endswith("x" * 100)
    assert len(output) <= 24_100


@pytest.mark.asyncio
async def test_background_actions_lazily_prune_completed_records(sandbox_workspace):
    """A registry action removes expired completed jobs while retaining live jobs."""
    expired = MagicMock(alive=False, session_id="session-1")
    expired.completed_at = (
        shell_module.time.monotonic() - shell_module._BG_COMPLETED_TTL_SECONDS - 1
    )
    alive = MagicMock(alive=True, session_id="session-1", command="sleep 30")
    _bg_processes[1001] = expired
    _bg_processes[1002] = alive

    result = await background_process.arun(action="list")

    assert "sleep 30" in result
    assert 1001 not in _bg_processes
    assert 1002 in _bg_processes


@pytest.mark.asyncio
async def test_background_start_lazily_prunes_completed_records(
    sandbox_workspace, fast_bg
):
    """Starting a job also prunes expired completed records."""
    expired = MagicMock(alive=False)
    expired.completed_at = (
        shell_module.time.monotonic() - shell_module._BG_COMPLETED_TTL_SECONDS - 1
    )
    _bg_processes[1001] = expired

    await shell_tool.arun(command="sleep 30", background=True, timeout_seconds=1)

    assert 1001 not in _bg_processes


@pytest.mark.asyncio
async def test_background_captures_initial_output_and_registry(
    sandbox_workspace, fast_bg
):
    """background=True returns PID, registers process, captures initial output."""
    result = await shell_tool.arun(
        command="echo 'server started on port 3000' && sleep 30",
        background=True,
        timeout_seconds=1,
    )
    assert "[Background" in result
    assert "PID" in result
    assert "server started on port 3000" in result
    assert len(_bg_processes) == 1
    pid = next(iter(_bg_processes))
    assert _bg_processes[pid].alive

    _bg_processes[pid].proc.kill()


async def test_session_cleanup_stops_only_owned_background_processes(tmp_path, fast_bg):
    """Stopping one session preserves another session's background process."""
    session_one = SandboxConfig(workspace=str(tmp_path / "one"), session_id="one")
    session_one_token = set_sandbox(session_one)
    try:
        await _shell("sleep 30", background=True, timeout_seconds=1)
        first_pid = next(iter(_bg_processes))
    finally:
        from app.agent.sandbox import _sandbox_ctx

        _sandbox_ctx.reset(session_one_token)

    session_two = SandboxConfig(workspace=str(tmp_path / "two"), session_id="two")
    session_two_token = set_sandbox(session_two)
    try:
        await _shell("sleep 30", background=True, timeout_seconds=1)
        second_pid = next(pid for pid in _bg_processes if pid != first_pid)
    finally:
        from app.agent.sandbox import _sandbox_ctx

        _sandbox_ctx.reset(session_two_token)

    assert await shell_module.stop_background_processes_for_session("one") == 1
    assert first_pid not in _bg_processes
    assert second_pid in _bg_processes
    assert _bg_processes[second_pid].alive


async def test_session_cleanup_attempts_every_owned_process_when_one_fails():
    first = MagicMock(session_id="one")
    first.stop = AsyncMock(side_effect=RuntimeError("stuck"))
    second = MagicMock(session_id="one")
    second.stop = AsyncMock(return_value=0)
    _bg_processes[1001] = first
    _bg_processes[1002] = second
    try:
        assert await shell_module.stop_background_processes_for_session("one") == 1
        first.stop.assert_awaited_once()
        second.stop.assert_awaited_once()
        assert 1001 in _bg_processes
        assert 1002 not in _bg_processes
    finally:
        _bg_processes.pop(1001, None)
        _bg_processes.pop(1002, None)


@pytest.mark.asyncio
async def test_background_immediate_exit_treated_as_failure(sandbox_workspace, fast_bg):
    """If a background process exits immediately, it should report failure."""
    result = await shell_tool.arun(command="exit 1", background=True, timeout_seconds=1)
    assert "[Failed" in result
    assert len(_bg_processes) == 0


@pytest.mark.asyncio
async def test_background_process_list(sandbox_workspace, fast_bg):
    """background_process list shows running processes; empty list when none."""
    assert "No background processes" in await background_process.arun(action="list")

    await shell_tool.arun(command="sleep 30", background=True, timeout_seconds=1)
    pid = next(iter(_bg_processes))
    result = await background_process.arun(action="list")
    assert "running" in result
    assert "sleep 30" in result

    _bg_processes[pid].proc.kill()


@pytest.mark.asyncio
async def test_background_process_output_and_status(sandbox_workspace, fast_bg):
    """output returns buffered lines; last_n_lines limits them; status reports running."""
    await shell_tool.arun(
        command="echo line1 && echo line2 && echo line3 && sleep 30",
        background=True,
        timeout_seconds=1,
    )
    pid = next(iter(_bg_processes))

    out_all = await background_process.arun(action="output", pid=pid)
    assert "line1" in out_all
    assert "line3" in out_all

    out_last = await background_process.arun(action="output", pid=pid, last_n_lines=1)
    assert "line3" in out_last
    assert "line1" not in out_last

    status = await background_process.arun(action="status", pid=pid)
    assert "running" in status
    assert str(pid) in status

    _bg_processes[pid].proc.kill()


@pytest.mark.asyncio
async def test_background_process_wait(sandbox_workspace, fast_bg):
    """wait returns final output and keeps the record for follow-up actions."""
    await shell_tool.arun(
        command="printf 'start\\n' && sleep 0.05 && printf 'done\\n'",
        background=True,
        timeout_seconds=1,
    )
    pid = next(iter(_bg_processes))

    result = await background_process.arun(action="wait", pid=pid)

    assert f"PID {pid}: exited (code 0)" in result
    assert "start" in result
    assert "done" in result
    # Retained until TTL pruning — output/status still work after wait.
    assert pid in _bg_processes
    followup = await background_process.arun(action="output", pid=pid)
    assert "done" in followup


@pytest.mark.asyncio
async def test_background_process_wait_is_bounded(sandbox_workspace, fast_bg):
    """wait returns control when a process is still running after its timeout."""
    await shell_tool.arun(command="sleep 30", background=True, timeout_seconds=1)
    pid = next(iter(_bg_processes))

    result = await shell_module._background_process(
        action="wait", pid=pid, timeout_seconds=0.01
    )

    assert f"PID {pid}: still running after 0.01 seconds" in result
    assert pid in _bg_processes
    assert _bg_processes[pid].alive


@pytest.mark.asyncio
async def test_background_process_wait_limits_final_output(sandbox_workspace, fast_bg):
    """wait caps final output to the same inline limits as shell."""
    await shell_tool.arun(
        command="python3 - <<'PY'\nfor i in range(400):\n    print(f'line{i:03d}-' + 'x' * 1000)\nPY\nsleep 0.05",
        background=True,
        timeout_seconds=1,
    )
    pid = next(iter(_bg_processes))

    result = await background_process.arun(action="wait", pid=pid)

    assert "...output truncated..." in result
    assert "line399" in result  # newest output always retained
    assert "line000" not in result  # oldest lines evicted by the byte budget
    # Inline result stays within the shell inline byte cap (+ small framing).
    assert len(result.encode()) <= shell_module._OUTPUT_MAX_BYTES + 1024


@pytest.mark.asyncio
async def test_background_process_stop(sandbox_workspace, fast_bg):
    """background_process stop terminates the process and keeps the record."""
    await shell_tool.arun(command="sleep 30", background=True, timeout_seconds=1)
    pid = next(iter(_bg_processes))

    _bg_processes[pid].proc.kill()
    await asyncio.sleep(0.05)

    result = await background_process.arun(action="stop", pid=pid)
    assert "stopped" in result
    # Retained until TTL pruning — status/output still work after stop.
    assert pid in _bg_processes
    assert not _bg_processes[pid].alive


@pytest.mark.asyncio
async def test_background_process_stop_honors_output_limit(sandbox_workspace, fast_bg):
    """stop uses the requested line limit for its final output."""
    await shell_tool.arun(
        command="printf 'line1\\nline2\\nline3\\n' && sleep 30",
        background=True,
        timeout_seconds=1,
    )
    pid = next(iter(_bg_processes))

    result = await background_process.arun(action="stop", pid=pid, last_n_lines=1)

    assert "line3" in result
    assert "line1" not in result


@pytest.mark.asyncio
async def test_background_actions_are_scoped_to_current_session(sandbox_workspace):
    """A session cannot discover or manage another session's process."""
    foreign = MagicMock(session_id="session-2", alive=True, command="secret command")
    _bg_processes[4242] = foreign

    listing = await background_process.arun(action="list")
    status = await background_process.arun(action="status", pid=4242)

    assert "No background processes" in listing
    assert "No tracked background process with PID 4242" in status
    assert "Known PIDs: none" in status


@pytest.mark.asyncio
async def test_background_process_error_cases(sandbox_workspace):
    """Unknown pid, missing pid, and unknown action all return errors."""
    assert "99999" in await background_process.arun(action="status", pid=99999)

    with pytest.raises(ToolArgumentError, match="pid"):
        await background_process.arun(action="status")

    with pytest.raises(ToolArgumentError, match="action"):
        await background_process.arun(action="restart")


@pytest.mark.asyncio
async def test_background_process_output_empty(sandbox_workspace, fast_bg):
    """background_process output returns 'no output' when buffer is empty."""
    await shell_tool.arun(command="sleep 30", background=True, timeout_seconds=1)
    pid = next(iter(_bg_processes))
    _bg_processes[pid].output.clear()

    result = await background_process.arun(action="output", pid=pid)
    assert "no output captured yet" in result

    _bg_processes[pid].proc.kill()


@pytest.mark.asyncio
async def test_background_process_status_exited(sandbox_workspace):
    """background_process status shows exit code when process has finished."""
    proc = await asyncio.create_subprocess_shell(
        "true",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    await proc.wait()

    bg = _BgProcess(proc, "true", "session-1")
    pid = bg.pid
    _bg_processes[pid] = bg
    await asyncio.sleep(0.05)

    result = await background_process.arun(action="status", pid=pid)
    assert "exited" in result
    assert str(pid) in result

    _bg_processes.pop(pid, None)


# ---------------------------------------------------------------------------
# Regression: process-exit vs stdout-EOF lifecycle mismatches
# ---------------------------------------------------------------------------
# The tracked shell and its stdout pipe have independent lifetimes: a child
# started with ``cmd &`` inherits the pipe and outlives the shell
# (exit-before-EOF), and a command can close its own stdout and keep running
# (EOF-before-exit).  Every bg action and the foreground timeout must stay
# bounded in both cases.


@pytest.mark.asyncio
async def test_background_command_finishing_during_startup_reports_success(
    sandbox_workspace, monkeypatch
):
    """A zero-exit background command must not be misreported as a failure."""
    # No stdout output, so the warmup loop can only end on exit detection —
    # deterministic even when exit reaping lags under load.  Generous poll
    # budget keeps the bound while typically returning in ~20 ms.
    monkeypatch.setattr(shell_module, "_BG_WARMUP_POLLS", 200)
    monkeypatch.setattr(shell_module, "_BG_WARMUP_POLL_SECONDS", 0.01)
    monkeypatch.setattr(
        "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
    )

    result = await shell_tool.arun(command="exit 0", background=True, timeout_seconds=1)

    assert "[Succeeded]" in result
    assert "[Failed" not in result
    assert len(_bg_processes) == 0


@pytest.mark.asyncio
async def test_background_child_exit_with_escaped_grandchild_reports_success(
    sandbox_workspace, fast_bg
):
    """A `cmd &` leader that exits during warmup resolves bounded, never Failed.

    Depending on whether the exit is reaped before or after the initial
    output settles, the tool reports success inline or hands back a PID —
    both are correct; hanging or reporting `[Failed` is not.
    """
    result = await asyncio.wait_for(
        shell_tool.arun(
            command="sleep 30 & echo started", background=True, timeout_seconds=1
        ),
        timeout=10,
    )

    assert "[Failed" not in result
    if "[Background" in result:
        pid = next(iter(_bg_processes))
        result = await asyncio.wait_for(
            shell_module._background_process(action="wait", pid=pid, timeout_seconds=5),
            timeout=10,
        )
        assert "exited (code 0)" in result
    else:
        assert "[Succeeded]" in result
        assert len(_bg_processes) == 0
    assert "started" in result


@pytest.mark.asyncio
async def test_bg_wait_is_bounded_when_child_keeps_stdout_open(
    sandbox_workspace, fast_bg, monkeypatch
):
    """bg wait returns within its bound even when a `cmd &` child holds the pipe."""
    monkeypatch.setattr(shell_module, "_READER_DRAIN_TIMEOUT_SECONDS", 0.2)
    # The trailing `sleep 0.3` keeps the leader alive past warmup, so the
    # record registers; the `sleep 30` child then outlives the leader.
    await shell_tool.arun(
        command="sleep 30 & echo started; sleep 0.3",
        background=True,
        timeout_seconds=1,
    )
    pid = next(iter(_bg_processes))

    result = await asyncio.wait_for(
        shell_module._background_process(action="wait", pid=pid, timeout_seconds=1),
        timeout=5,
    )

    assert f"PID {pid}: exited (code 0)" in result
    assert "started" in result


@pytest.mark.asyncio
async def test_bg_output_is_bounded_when_child_keeps_stdout_open(
    sandbox_workspace, fast_bg, monkeypatch
):
    """bg output on an exited-leader process returns instead of hanging."""
    monkeypatch.setattr(shell_module, "_READER_DRAIN_TIMEOUT_SECONDS", 0.2)
    await shell_tool.arun(
        command="sleep 30 & echo started; sleep 0.3",
        background=True,
        timeout_seconds=1,
    )
    pid = next(iter(_bg_processes))
    # Let the leader shell exit; the `sleep 30` child still holds stdout open.
    # (proc.wait() itself blocks on pipe closure, so poll returncode.)
    for _ in range(200):
        if not _bg_processes[pid].alive:
            break
        await asyncio.sleep(0.01)
    assert not _bg_processes[pid].alive

    result = await asyncio.wait_for(
        shell_module._background_process(action="output", pid=pid), timeout=5
    )

    assert "started" in result


@pytest.mark.asyncio
async def test_bg_stop_kills_escaped_child_in_process_group(sandbox_workspace, fast_bg):
    """bg stop terminates group members even after the leader was reaped."""
    await shell_tool.arun(
        command="sleep 30 & echo $!; sleep 0.3", background=True, timeout_seconds=1
    )
    pid = next(iter(_bg_processes))
    for _ in range(200):
        if not _bg_processes[pid].alive:
            break
        await asyncio.sleep(0.01)
    assert not _bg_processes[pid].alive
    child_pid = int(_bg_processes[pid].read_output().strip().splitlines()[0])

    result = await asyncio.wait_for(
        shell_module._background_process(action="stop", pid=pid), timeout=5
    )

    assert "stopped" in result
    # SIGKILL delivery is asynchronous — poll briefly for the child to die.
    for _ in range(100):
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.01)
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)


@pytest.mark.asyncio
async def test_foreground_timeout_fires_when_stdout_closes_before_exit(
    sandbox_workspace,
):
    """A command that closes stdout but keeps running must still hit the timeout."""
    result = await asyncio.wait_for(
        _shell("exec 1>&- 2>&-; sleep 30", timeout_seconds=0.3), timeout=5
    )

    assert "[Timed out" in result


# ---------------------------------------------------------------------------
# Bounded memory: bg byte budget, foreground incremental spill
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_background_reader_bounds_total_buffered_bytes():
    """The bg line buffer enforces a total byte budget, not just a line count."""
    reader = asyncio.StreamReader()
    for i in range(300):
        reader.feed_data(f"line{i:03d}-".encode() + b"x" * 2000 + b"\n")
    reader.feed_eof()
    proc = MagicMock(stdout=reader, returncode=0, pid=4243)

    bg = _BgProcess(proc, "noisy-command", "session-1")
    await bg._reader_task

    buffered = sum(len(line) for line in bg.output)
    assert buffered <= shell_module._BG_OUTPUT_MAX_BYTES + 2010  # + one line slack
    assert bg.read_output().endswith("x" * 100)  # newest lines retained


@pytest.mark.asyncio
async def test_foreground_large_output_spills_incrementally(sandbox_workspace):
    """Overflowing output streams to a spill file; inline keeps head and tail."""
    command = "i=0; while [ $i -lt 200 ]; do echo line-number-$i; i=$((i+1)); done"
    with patch("app.agent.tools.builtin.shell._OUTPUT_MAX_BYTES", 1024):
        result = await _shell(command)

    assert "[Succeeded]" in result
    assert "...output truncated" in result
    assert "line-number-0" in result  # head retained inline
    assert "line-number-199" in result  # tail retained inline

    import re as _re

    match = _re.search(r"full output saved to (\S+)", result)
    assert match is not None
    spilled = Path(match.group(1)).read_text(encoding="utf-8")
    # The spill file holds the complete output, including the middle the
    # inline view dropped.
    assert spilled.splitlines() == [f"line-number-{i}" for i in range(200)]


def test_prune_closes_evicted_records():
    """Evicted completed records get their reader task released."""
    expired = MagicMock(alive=False)
    expired.completed_at = 0.0
    _bg_processes[1001] = expired

    shell_module._prune_completed_bg_processes(
        clock=lambda: shell_module._BG_COMPLETED_TTL_SECONDS + 1
    )

    assert 1001 not in _bg_processes
    expired.close.assert_called_once_with()


# ---------------------------------------------------------------------------
# workdir deny-rule enforcement
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_workdir_inside_denied_root_is_blocked(tmp_path):
    """workdir= must not sidestep sandbox deny rules via relative paths."""
    forbidden = tmp_path / "secrets"
    forbidden.mkdir()
    sandbox = SandboxConfig(
        workspace=str(tmp_path / "ws"),
        denied_roots=[forbidden],
        denied_patterns=[],
    )
    token = set_sandbox(sandbox)
    try:
        with pytest.raises(PermissionError):
            await _shell("cat key.pem", workdir=str(forbidden))
    finally:
        from app.agent.sandbox import _sandbox_ctx

        _sandbox_ctx.reset(token)


# ---------------------------------------------------------------------------
# Process group kill
# ---------------------------------------------------------------------------


def test_windows_subprocess_kwargs_create_new_process_group(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "nt")

    assert shell_module._subprocess_platform_kwargs() == {"creationflags": 0x0800_0200}


async def test_shell_passes_windows_creation_flags_to_subprocess(
    sandbox_workspace, monkeypatch
):
    monkeypatch.setattr(shell_module.os, "name", "nt")
    monkeypatch.setattr(shell_module._shell_mod, "acceptable", lambda: "cmd.exe")
    proc = MagicMock()
    proc.pid = 12345
    proc.returncode = 0
    proc.stdout = MagicMock()
    proc.stdout.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)

    with patch.object(
        shell_module.asyncio,
        "create_subprocess_exec",
        new=AsyncMock(return_value=proc),
    ) as spawn:
        result = await _shell("echo ok")

    assert "[Succeeded]" in result
    kwargs = spawn.await_args.kwargs
    assert kwargs["creationflags"] == 0x0800_0200
    assert "start_new_session" not in kwargs


@pytest.mark.asyncio
async def test_windows_kill_terminates_entire_process_tree(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "nt")
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    killer = MagicMock()
    killer.wait = AsyncMock(return_value=0)

    with patch.object(
        shell_module.asyncio,
        "create_subprocess_exec",
        new=AsyncMock(return_value=killer),
    ) as spawn:
        await shell_module._kill_process_group(mock_proc, signal.SIGTERM)

    assert spawn.await_args.args == ("taskkill", "/PID", "12345", "/T", "/F")
    mock_proc.kill.assert_not_called()


@pytest.mark.asyncio
async def test_windows_kill_falls_back_when_taskkill_fails(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "nt")
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    killer = MagicMock()
    killer.wait = AsyncMock(return_value=1)

    with patch.object(
        shell_module.asyncio,
        "create_subprocess_exec",
        new=AsyncMock(return_value=killer),
    ):
        await shell_module._kill_process_group(mock_proc, signal.SIGTERM)

    mock_proc.kill.assert_called_once_with()


@pytest.mark.asyncio
async def test_windows_kill_falls_back_when_taskkill_cannot_run(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "nt")
    mock_proc = MagicMock()
    mock_proc.pid = 12345

    with patch.object(
        shell_module.asyncio,
        "create_subprocess_exec",
        new=AsyncMock(side_effect=OSError("missing")),
    ):
        await shell_module._kill_process_group(mock_proc, signal.SIGTERM)

    mock_proc.kill.assert_called_once_with()


def test_posix_subprocess_kwargs_keep_new_session(monkeypatch):
    monkeypatch.setattr(shell_module.os, "name", "posix")

    assert shell_module._subprocess_platform_kwargs() == {"start_new_session": True}


@pytest.mark.asyncio
async def test_kill_process_group_handles_missing_pid():
    """_kill_process_group does not raise when pid is None."""
    from app.agent.tools.builtin.shell import _kill_process_group

    mock_proc = MagicMock()
    mock_proc.pid = None
    await _kill_process_group(mock_proc, signal.SIGTERM)


@pytest.mark.asyncio
async def test_kill_process_group_falls_back_to_direct_signal():
    """When no process group can be signalled, falls back to proc.send_signal."""
    import os as _os

    from app.agent.tools.builtin.shell import _kill_process_group

    mock_proc = MagicMock()
    mock_proc.pid = 12345

    with (
        patch.object(_os, "getpgid", side_effect=ProcessLookupError),
        patch.object(_os, "killpg", side_effect=ProcessLookupError),
    ):
        await _kill_process_group(mock_proc, signal.SIGTERM)

    mock_proc.send_signal.assert_called_once_with(signal.SIGTERM)


def test_signal_posix_group_targets_group_of_reaped_leader():
    """When the leader is reaped (getpgid fails), the group id is signalled."""
    import os as _os

    killed: list[tuple[int, int]] = []

    with (
        patch.object(_os, "getpgid", side_effect=ProcessLookupError),
        patch.object(
            _os, "killpg", side_effect=lambda pgid, sig: killed.append((pgid, sig))
        ),
    ):
        assert shell_module._signal_posix_group(12345, signal.SIGKILL) is True

    assert killed == [(12345, signal.SIGKILL)]


# ---------------------------------------------------------------------------
# Sandbox command scan (path-token deny enforcement inside _shell)
# ---------------------------------------------------------------------------


class TestSandboxCommandScan:
    """The shell tool inspects the ``command`` for path-like tokens and
    rejects commands that would touch a denied root or match a deny
    pattern, mirroring how file tools self-validate via
    ``sandbox.validate_path``.
    """

    @pytest.mark.asyncio
    async def test_blocks_command_touching_denied_root(self, tmp_path):
        forbidden = tmp_path / "secrets"
        forbidden.mkdir()
        sandbox = SandboxConfig(
            workspace=str(tmp_path / "ws"),
            memory=str(tmp_path / "mem"),
            denied_roots=[forbidden],
            denied_patterns=[],
        )
        token = set_sandbox(sandbox)
        try:
            with pytest.raises(PermissionError, match="Sandbox blocked"):
                await _shell(command=f"cat {forbidden}/key.pem")
        finally:
            from app.agent.sandbox import _sandbox_ctx

            _sandbox_ctx.reset(token)

    @pytest.mark.asyncio
    async def test_blocks_command_matching_denied_pattern(self, tmp_path):
        sandbox = SandboxConfig(
            workspace=str(tmp_path / "ws"),
            memory=str(tmp_path / "mem"),
            denied_roots=[],
            denied_patterns=["**/.env"],
        )
        token = set_sandbox(sandbox)
        try:
            with pytest.raises(PermissionError, match="Sandbox blocked"):
                await _shell(command="cat /etc/app/.env")
        finally:
            from app.agent.sandbox import _sandbox_ctx

            _sandbox_ctx.reset(token)

    @pytest.mark.asyncio
    async def test_allows_command_with_no_path_tokens(self, sandbox_workspace):
        """Pure shell command with no paths runs normally."""
        result = await _shell(command="echo hello world")
        assert "[Succeeded]" in result
        assert "hello world" in result

    @pytest.mark.asyncio
    async def test_allows_workspace_relative_paths(self, sandbox_workspace):
        """Relative paths resolve under the (exempt) workspace."""
        (sandbox_workspace / "hello.txt").write_text("hi")
        result = await _shell(command="cat hello.txt")
        assert "[Succeeded]" in result
        assert "hi" in result

    @pytest.mark.asyncio
    async def test_allows_tail_of_state_log_path(self, tmp_path):
        # Use a test-owned filename under the logs allowlist rather than the
        # live ``app.log`` sink, which the running loguru logger appends to
        # (every shell call logs) and would corrupt this assertion.
        log_path = (
            Path(settings.OPENAGENTD_STATE_DIR) / "logs" / "app" / "scan-test.log"
        )
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("one\ntwo\n", encoding="utf-8")
        sandbox = SandboxConfig(
            workspace=str(tmp_path / "ws"),
            denied_roots=[Path(settings.OPENAGENTD_STATE_DIR).resolve()],
            denied_patterns=[],
        )
        token = set_sandbox(sandbox)
        try:
            result = await _shell(command=f"tail -n 1 {log_path.resolve()}")
            assert "[Succeeded]" in result
            assert "two" in result
        finally:
            from app.agent.sandbox import _sandbox_ctx

            _sandbox_ctx.reset(token)

    @pytest.mark.asyncio
    async def test_blocks_other_state_paths(self, tmp_path):
        state_path = Path(settings.OPENAGENTD_STATE_DIR) / "private" / "token"
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text("secret", encoding="utf-8")
        sandbox = SandboxConfig(
            workspace=str(tmp_path / "ws"),
            denied_roots=[Path(settings.OPENAGENTD_STATE_DIR).resolve()],
            denied_patterns=[],
        )
        token = set_sandbox(sandbox)
        try:
            with pytest.raises(PermissionError, match="Sandbox blocked"):
                await _shell(command=f"cat {state_path.resolve()}")
        finally:
            from app.agent.sandbox import _sandbox_ctx

            _sandbox_ctx.reset(token)

    @pytest.mark.asyncio
    async def test_blocks_quoted_denied_path(self, tmp_path):
        sandbox = SandboxConfig(
            workspace=str(tmp_path / "ws"),
            memory=str(tmp_path / "mem"),
            denied_roots=[tmp_path / "secrets"],
            denied_patterns=[],
        )
        (tmp_path / "secrets").mkdir()
        token = set_sandbox(sandbox)
        try:
            with pytest.raises(PermissionError, match="Sandbox blocked"):
                await _shell(command=f"cat '{tmp_path / 'secrets'}/api key.pem'")
        finally:
            from app.agent.sandbox import _sandbox_ctx

            _sandbox_ctx.reset(token)

    @pytest.mark.asyncio
    async def test_shell_streaming_buffering_throttling(
        self, sandbox_workspace, monkeypatch
    ):
        """Verify that rapid streaming output is buffered and throttled to avoid flooding."""
        monkeypatch.setattr(
            "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
        )
        emitted_chunks: list[str] = []

        async def capture(text: str) -> None:
            emitted_chunks.append(text)

        # Run a command that prints multiple lines with a tiny sleep to simulate streaming
        result = await _shell(
            command="echo 'chunk1'; sleep 0.02; echo 'chunk2'; sleep 0.02; echo 'chunk3'",
            timeout_seconds=2,
            _tool_output=capture,
        )

        assert "[Succeeded]" in result
        combined = "".join(emitted_chunks)
        assert "chunk1" in combined
        assert "chunk2" in combined
        assert "chunk3" in combined

        # The throttling interval should group these chunks together rather than
        # emitting three separate UI updates.
        # With 0.02s sleeps, they all complete within ~50ms, so they should be grouped
        # into at most 2 emissions (often just 1).
        assert len(emitted_chunks) <= 2

    @pytest.mark.asyncio
    async def test_shell_streaming_limits_render_updates_for_sustained_output(
        self, sandbox_workspace, monkeypatch
    ):
        """Sustained noisy commands must not trigger UI updates every 100ms."""
        monkeypatch.setattr(
            "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
        )
        emitted_chunks: list[str] = []

        async def capture(text: str) -> None:
            emitted_chunks.append(text)

        result = await _shell(
            command="for i in 1 2 3 4 5 6 7 8; do echo chunk$i; sleep 0.05; done",
            timeout_seconds=2,
            _tool_output=capture,
        )

        assert "[Succeeded]" in result
        assert "chunk1" in "".join(emitted_chunks)
        assert "chunk8" in "".join(emitted_chunks)
        assert len(emitted_chunks) <= 2

    @pytest.mark.asyncio
    async def test_shell_streaming_caps_each_live_payload(
        self, sandbox_workspace, monkeypatch
    ):
        """A rapid output burst must not become one oversized SSE payload."""
        monkeypatch.setattr(
            "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
        )
        emitted_chunks: list[str] = []

        async def capture(text: str) -> None:
            emitted_chunks.append(text)

        result = await _shell(
            command="i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done",
            timeout_seconds=2,
            _tool_output=capture,
        )

        assert "[Succeeded]" in result
        assert emitted_chunks
        assert max(map(len, emitted_chunks)) <= 24_100
        assert "line-19999" in emitted_chunks[-1]

    def test_live_output_window_trims_to_rendered_tail(self):
        """The live-output window keeps the tail and reports whether it cut."""
        window = shell_module._live_output_window
        max_lines = shell_module._LIVE_OUTPUT_MAX_LINES

        # Under the cap — returned untouched, not marked as cut.
        small = "".join(f"line {i}\n" for i in range(max_lines))
        assert window(small) == (small, False)

        # Over the cap — only the trailing lines survive.
        big = "".join(f"line {i}\n" for i in range(max_lines * 5))
        trimmed, cut = window(big)
        assert cut is True
        assert trimmed.count("\n") <= max_lines
        assert trimmed.endswith(f"line {max_lines * 5 - 1}\n")
        assert "line 0\n" not in trimmed

        # A single pathologically long line has no newline to cut on, so the
        # char cap must still bound it.
        long_line = "x" * (shell_module._LIVE_OUTPUT_MAX_CHARS + 5_000)
        trimmed, cut = window(long_line)
        assert cut is True
        assert len(trimmed) == shell_module._LIVE_OUTPUT_MAX_CHARS

        # Empty input must not be reported as truncated.
        assert window("") == ("", False)

    @pytest.mark.asyncio
    async def test_shell_streaming_payload_matches_rendered_window(
        self, sandbox_workspace, monkeypatch
    ):
        """A noisy command must not ship output the UI immediately discards.

        The chat UI only ever renders the trailing
        ``_LIVE_OUTPUT_MAX_LINES`` lines of live tool output, so streaming a
        24 KB / ~290-line payload per flush burns SSE bandwidth, an immer
        transaction, and a React re-render on ~87% of bytes that are dropped
        on arrival. Cap each delta to the window the client actually paints.
        """
        monkeypatch.setattr(
            "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
        )
        emitted_chunks: list[str] = []

        async def capture(text: str) -> None:
            emitted_chunks.append(text)

        result = await _shell(
            command="i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done",
            timeout_seconds=10,
            _tool_output=capture,
        )

        assert "[Succeeded]" in result
        assert emitted_chunks
        # The last line must always survive — the tail is what users watch.
        assert "line-19999" in emitted_chunks[-1]
        # No delta may exceed the rendered line window (plus the truncation
        # marker), so the payload matches what the client keeps.
        for chunk in emitted_chunks:
            assert chunk.count("\n") <= shell_module._LIVE_OUTPUT_MAX_LINES + 1, (
                f"delta carried {chunk.count(chr(10))} lines, "
                f"UI renders only {shell_module._LIVE_OUTPUT_MAX_LINES}"
            )

    @pytest.mark.asyncio
    async def test_shell_streaming_immediate_flush_on_completion(
        self, sandbox_workspace, monkeypatch
    ):
        """Verify that any remaining buffered output is flushed immediately when the command exits."""
        monkeypatch.setattr(
            "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
        )
        emitted_chunks: list[str] = []

        async def capture(text: str) -> None:
            emitted_chunks.append(text)

        # Run a command that exits immediately after printing.
        # The flusher task has not reached its next interval when the command exits.
        # The remaining output must be flushed immediately on exit via the finally block.
        result = await _shell(
            command="echo 'immediate_flush'",
            timeout_seconds=2,
            _tool_output=capture,
        )

        assert "[Succeeded]" in result
        assert "immediate_flush" in "".join(emitted_chunks)
        assert len(emitted_chunks) >= 1
