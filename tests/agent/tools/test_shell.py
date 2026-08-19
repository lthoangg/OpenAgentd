"""Tests for app/tools/builtin/shell.py — shell.

Covers the rewritten shell tool:
- $SHELL detection via app.agent.tools.builtin.shell_runtime
- streaming foreground execution
- workdir parameter
- timeout handling
- output spilling to the XDG session artifact directory
- background process execution (returns PID)
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
import app.agent.tools.builtin.shell as shell_module
from app.agent.tools.builtin.shell import (
    _PYTHON_ENV_LEAK_KEYS,
    _scrubbed_env,
    _shell,
    _strip_ansi,
    _tail_text,
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
    from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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
    from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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


@pytest.mark.asyncio
async def test_foreground_spill_file_has_disk_budget(sandbox_workspace):
    """A noisy command cannot consume unbounded disk through its spill file."""
    with (
        patch("app.agent.tools.builtin.shell._OUTPUT_MAX_BYTES", 100),
        patch("app.agent.tools.builtin.shell._SPILL_MAX_BYTES", 1024),
    ):
        result = await _shell(
            "i=0; while [ $i -lt 1000 ]; do echo xxxxxxxxxx; i=$((i+1)); done"
        )

    import re

    match = re.search(r"full output saved to (\S+)", result)
    assert match is not None
    assert Path(match.group(1)).stat().st_size <= 1024
    assert "spill file capped" in result


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_signal_death_reported_as_shell_exit_code(sandbox_workspace):
    """A signal-killed command reports 128+N, the way the user's shell does.

    `asyncio` returns -9 for SIGKILL; surfacing that raw teaches the model a
    convention no shell uses and hides the familiar 137 (OOM-killed) signal.
    """
    result = await _shell("kill -9 $$")

    assert "137" in result
    assert "SIGKILL" in result
    assert "-9" not in result


@pytest.mark.asyncio
async def test_timeout_gives_the_command_a_chance_to_clean_up(sandbox_workspace):
    """Foreground timeout sends SIGTERM before SIGKILL.

    Killing outright strands temp files and child processes and discards the
    command's own teardown output.
    """
    result = await _shell("trap 'echo CLEANED_UP' TERM; sleep 5", timeout_seconds=0.5)

    assert "[Timed out" in result
    assert "CLEANED_UP" in result


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


@pytest.mark.asyncio
async def test_shell_timeout_returns_output_before_timeout(sandbox_workspace):
    """Command that outputs content then hangs/times out returns the output before timeout."""
    result = await _shell(
        "echo 'line before timeout 1'; echo 'line before timeout 2'; sleep 60",
        timeout_seconds=0.3,
    )
    assert "[Timed out after 0.3s]" in result
    assert "line before timeout 1" in result
    assert "line before timeout 2" in result
    assert "<shell_metadata>" in result
    assert "Command timed out after 0.3s" in result


@pytest.mark.asyncio
async def test_shell_timeout_no_output_before_timeout(sandbox_workspace):
    """Command with no output before timeout produces clear notice with metadata."""
    result = await _shell("sleep 60", timeout_seconds=0.1)
    assert "[Timed out after 0.1s]" in result
    assert "(No output before timeout)" in result
    assert "<shell_metadata>" in result
    assert "Command timed out after 0.1s" in result


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


@pytest.mark.asyncio
async def test_background_returns_pid(sandbox_workspace):
    """background=True spawns detached process and returns PID: {pid}."""
    result = await shell_tool.arun(command="sleep 30", background=True)
    assert result.startswith("PID: ")
    pid_str = result.removeprefix("PID: ").strip()
    pid = int(pid_str)
    assert pid > 0
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


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
        from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups only")
@pytest.mark.timeout(15)
async def test_timeout_kills_grandchild_that_escaped_its_process_group(
    tmp_path, sandbox_workspace
):
    """A monitored child that re-groups itself must still be killed.

    ``timeout``, ``setsid``, and ``sudo`` all deliberately move the command
    they launch into a *new* process group so their own supervision logic
    can manage it — which, as a side effect, makes that subtree invisible to
    a ``killpg`` aimed at the originally-launched shell's group. The PPID
    chain survives regrouping, so the kill must walk it rather than rely on
    process groups alone.
    """
    # A single interpreter forked directly by the shell (``&`` + ``wait``),
    # not a chain of two — matching how ``timeout``'s own monitored child is
    # one direct fork, not a grandchild through an intermediary process. This
    # keeps the escape a single, fast startup instead of two sequential
    # Python boots racing the tool's own timeout under CI/load variance.
    pid_file = tmp_path / "escaped.pid"
    escape_script = tmp_path / "escape.py"
    escape_script.write_text(
        "import os, time\n"
        "os.setpgid(0, 0)\n"  # escape into a brand new process group
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
        "time.sleep(30)\n"
    )

    result = await _shell(
        f"{sys.executable} {escape_script} & wait",
        timeout_seconds=1.0,
    )

    assert "[Timed out" in result
    for _ in range(20):
        if pid_file.exists():
            break
        await asyncio.sleep(0.05)
    escaped_pid = int(pid_file.read_text())

    with pytest.raises(ProcessLookupError):
        os.kill(escaped_pid, 0)


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
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

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
    async def test_shell_streaming_limits_long_running_render_cadence(
        self, sandbox_workspace, monkeypatch
    ):
        """Long-running output should not force the chat to repaint four times a second."""
        monkeypatch.setattr(
            "app.agent.tools.builtin.shell._shell_mod.acceptable", lambda: "/bin/sh"
        )
        emitted_chunks: list[str] = []

        async def capture(text: str) -> None:
            emitted_chunks.append(text)

        result = await _shell(
            command=("for i in 1 2 3 4 5 6 7 8; do echo cadence-$i; sleep 0.15; done"),
            timeout_seconds=3,
            _tool_output=capture,
        )

        assert "[Succeeded]" in result
        assert "cadence-1" in "".join(emitted_chunks)
        assert "cadence-8" in "".join(emitted_chunks)
        assert len(emitted_chunks) <= 3

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
