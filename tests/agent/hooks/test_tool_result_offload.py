"""Tests for app/agent/hooks/tool_result_offload.py — ToolResultOffloadHook."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch


from app.agent.artifacts import TOOL_RESULTS_DIR, tool_results_dir
from app.agent.hooks.tool_result_offload import ToolResultOffloadHook, _NEVER_OFFLOAD
from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.schemas.chat import FunctionCall, ToolCall
from app.agent.state import AgentState, RunContext


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_ctx(agent_name: str = "test-agent", session_id: str = "s") -> RunContext:
    return RunContext(session_id=session_id, run_id="r", agent_name=agent_name)


def make_state() -> AgentState:
    return AgentState(messages=[], system_prompt="")


def make_tool_call(name: str = "list_files", id: str = "tc_1") -> ToolCall:
    return ToolCall(id=id, function=FunctionCall(name=name, arguments="{}"))


# ---------------------------------------------------------------------------
# Small result — no offload
# ---------------------------------------------------------------------------


class TestSmallResult:
    async def test_small_result_returned_unchanged(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=100)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            handler = AsyncMock(return_value="short result")

            result = await hook.wrap_tool_call(ctx, state, tc, handler)
            assert result == "short result"
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_small_result_no_file_written(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=100)
            ctx = make_ctx(session_id="s_no_file")
            state = make_state()
            tc = make_tool_call()
            handler = AsyncMock(return_value="x" * 50)

            await hook.wrap_tool_call(ctx, state, tc, handler)

            offload_file = tool_results_dir("test-agent", "s_no_file") / "tc_1.txt"
            assert not offload_file.exists()
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_result_exactly_at_threshold_not_offloaded(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            threshold = 100
            hook = ToolResultOffloadHook(char_threshold=threshold)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            exact_result = "x" * threshold
            handler = AsyncMock(return_value=exact_result)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)
            assert result == exact_result
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)


# ---------------------------------------------------------------------------
# Large result — offload
# ---------------------------------------------------------------------------


class TestLargeResult:
    async def test_large_result_offloaded(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10, preview_chars=5)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call(name="list_files", id="tc_big")
            big_result = "x" * 100
            handler = AsyncMock(return_value=big_result)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            assert "offloaded" in result.lower()
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_compact_result_contains_file_path(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10, preview_chars=5)
            ctx = make_ctx(agent_name="myagent")
            state = make_state()
            tc = make_tool_call(name="list_files", id="tc_path")
            handler = AsyncMock(return_value="x" * 100)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            assert "File:" in result
            assert "myagent" in result
            assert "tc_path.txt" in result
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_compact_result_contains_size(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10, preview_chars=5)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            handler = AsyncMock(return_value="x" * 100)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            assert "Size:" in result
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_compact_result_contains_preview(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10, preview_chars=5)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            big_result = "ABCDE" + "x" * 100
            handler = AsyncMock(return_value=big_result)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            assert "Preview (first):" in result
            assert "ABCDE" in result
            # With head+tail preview, both ends should appear
            assert "Preview (last):" in result
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_preview_truncated_to_preview_chars(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            preview_chars = 10
            hook = ToolResultOffloadHook(char_threshold=5, preview_chars=preview_chars)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            big_result = "A" * 200
            handler = AsyncMock(return_value=big_result)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            # Me head preview section should not contain more than preview_chars of 'A'
            head_section = result.split("Preview (first):\n")[1].split("\n")[0]
            assert len(head_section) <= preview_chars
            # Me tail preview section should also be bounded
            assert "Preview (last):" in result
            tail_section = result.split("Preview (last):\n")[1].split("\n")[0]
            assert len(tail_section) <= preview_chars
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_full_content_written_to_file(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10)
            ctx = make_ctx(agent_name="agent1")
            state = make_state()
            tc = make_tool_call(id="tc_file")
            full_content = "full content " * 20
            handler = AsyncMock(return_value=full_content)

            await hook.wrap_tool_call(ctx, state, tc, handler)

            dest = tool_results_dir("agent1", "s") / "tc_file.txt"
            assert dest.exists()
            assert dest.read_text() == full_content
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_metadata_stored_on_state(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call(id="tc_meta")
            handler = AsyncMock(return_value="x" * 100)

            await hook.wrap_tool_call(ctx, state, tc, handler)

            offloaded = state.metadata.get("_offloaded_tool_results", {})
            assert "tc_meta" in offloaded
            meta = offloaded["tc_meta"]
            assert meta["offloaded"] is True
            assert "path" in meta
            assert "lines" in meta
            assert "chars" in meta
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)


# ---------------------------------------------------------------------------
# Never-offload tools
# ---------------------------------------------------------------------------


class TestNeverOffload:
    async def test_read_file_never_offloaded(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=1)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call(name="read", id="tc_rf")
            big_result = "x" * 10000
            handler = AsyncMock(return_value=big_result)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            # Me result returned unchanged — no offload
            assert result == big_result
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    def test_never_offload_set_contains_expected_tools(self):
        assert "read" in _NEVER_OFFLOAD
        # shell is NOT in _NEVER_OFFLOAD — it self-truncates via session metadata.
        assert "shell" not in _NEVER_OFFLOAD


# ---------------------------------------------------------------------------
# Threshold = 0 disables offloading
# ---------------------------------------------------------------------------


class TestThresholdZero:
    async def test_zero_threshold_disables_offloading(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=0)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            big_result = "x" * 100000
            handler = AsyncMock(return_value=big_result)

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            assert result == big_result
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)


# ---------------------------------------------------------------------------
# File write failure — graceful degradation
# ---------------------------------------------------------------------------


class TestWriteFailure:
    async def test_write_failure_returns_original_result(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            big_result = "x" * 100
            handler = AsyncMock(return_value=big_result)

            with patch.object(hook, "_write_offload", side_effect=OSError("disk full")):
                result = await hook.wrap_tool_call(ctx, state, tc, handler)

            # Me original result returned — no exception raised
            assert result == big_result
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    async def test_write_failure_does_not_raise(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook(char_threshold=10)
            ctx = make_ctx()
            state = make_state()
            tc = make_tool_call()
            handler = AsyncMock(return_value="x" * 100)

            with patch.object(
                hook, "_write_offload", side_effect=PermissionError("no write")
            ):
                # Me must not raise
                result = await hook.wrap_tool_call(ctx, state, tc, handler)

            assert result is not None
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)


# ---------------------------------------------------------------------------
# _write_offload — internal helper
# ---------------------------------------------------------------------------


class TestWriteOffload:
    def test_creates_directories_and_file(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook()
            path = hook._write_offload("myagent", "tc_123", "file content here")

            assert path.exists()
            assert path.read_text() == "file content here"
            assert path.name == "tc_123.txt"
            assert path.parent.name == "myagent"
            assert path.parent.parent.name == TOOL_RESULTS_DIR
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)

    def test_path_outside_workspace(self, tmp_path):
        sandbox = SandboxConfig(workspace=str(tmp_path))
        token = set_sandbox(sandbox)
        try:
            hook = ToolResultOffloadHook()
            path = hook._write_offload("agent_x", "tc_abc", "content", "s")

            assert not str(path).startswith(str(tmp_path))
        finally:
            from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

            _sandbox_ctx.reset(token)
