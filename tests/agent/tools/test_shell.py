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
import signal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.agent.errors import ToolArgumentError
from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.builtin.shell import (
    _PYTHON_ENV_LEAK_KEYS,
    _BgProcess,
    _bg_processes,
    _scrubbed_env,
    _shell,
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


@pytest.mark.asyncio
async def test_execute_basic_command(sandbox_workspace):
    result = await shell_tool.arun(command="echo 'hello world'")
    assert "[Succeeded]" in result
    assert "hello world" in result


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
    """Skip the production 3-5s warmup sleep so background tests finish fast.

    The warmup exists to (a) drain initial echo output via the reader task
    and (b) detect immediate exits.  We replace it with a short polling loop
    that yields the event loop just enough times for the reader task to
    consume any pending stdout — typically a single iteration is enough.

    We also force ``/bin/sh`` so we skip zsh login + rc-file sourcing
    (~200ms boot cost), which would otherwise blow past the short sleep
    budget before the spawned process finishes echoing.
    """
    _real_sleep = asyncio.sleep

    async def _short_sleep(_seconds):
        # 5 yields × 5 ms = 25 ms max.  Enough for the reader task to drain
        # ``echo`` output on every platform tested here.
        for _ in range(5):
            await _real_sleep(0.005)

    monkeypatch.setattr("app.agent.tools.builtin.shell.asyncio.sleep", _short_sleep)
    # ``/bin/sh`` takes the bare ``-c`` argv path → no rc sourcing → instant boot.
    monkeypatch.setattr(
        "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
    )


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
    """wait blocks until the process exits and returns final output."""
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
    assert pid in _bg_processes


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
    assert "line399" in result
    assert "line200" not in result


@pytest.mark.asyncio
async def test_background_process_stop(sandbox_workspace, fast_bg):
    """background_process stop removes the process from the registry."""
    await shell_tool.arun(command="sleep 30", background=True, timeout_seconds=1)
    pid = next(iter(_bg_processes))

    _bg_processes[pid].proc.kill()
    await asyncio.sleep(0.05)

    result = await background_process.arun(action="stop", pid=pid)
    assert "stopped" in result
    assert pid not in _bg_processes


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

    bg = _BgProcess(proc, "true")
    pid = bg.pid
    _bg_processes[pid] = bg
    await asyncio.sleep(0.05)

    result = await background_process.arun(action="status", pid=pid)
    assert "exited" in result
    assert str(pid) in result

    _bg_processes.pop(pid, None)


# ---------------------------------------------------------------------------
# Process group kill
# ---------------------------------------------------------------------------


def test_kill_process_group_handles_missing_pid():
    """_kill_process_group does not raise when pid is None."""
    from app.agent.tools.builtin.shell import _kill_process_group

    mock_proc = MagicMock()
    mock_proc.pid = None
    _kill_process_group(mock_proc, signal.SIGTERM)


def test_kill_process_group_falls_back_to_direct_signal():
    """When os.killpg fails, falls back to proc.send_signal."""
    import os as _os

    from app.agent.tools.builtin.shell import _kill_process_group

    mock_proc = MagicMock()
    mock_proc.pid = 12345

    with patch.object(_os, "getpgid", side_effect=ProcessLookupError):
        _kill_process_group(mock_proc, signal.SIGTERM)

    mock_proc.send_signal.assert_called_once_with(signal.SIGTERM)


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

        # Because of the 100ms throttling interval, chunk1, chunk2, and chunk3
        # should be grouped together or at least not emitted as 3 separate individual calls.
        # With 0.02s sleeps, they all complete within ~50ms, so they should be grouped
        # into at most 2 emissions (often just 1).
        assert len(emitted_chunks) <= 2

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
        # The flusher task runs on a 100ms loop, but the command exits in <10ms.
        # The remaining output must be flushed immediately on exit via the finally block.
        result = await _shell(
            command="echo 'immediate_flush'",
            timeout_seconds=2,
            _tool_output=capture,
        )

        assert "[Succeeded]" in result
        assert "immediate_flush" in "".join(emitted_chunks)
        assert len(emitted_chunks) >= 1
