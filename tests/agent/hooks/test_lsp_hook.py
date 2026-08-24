from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig,
    set_denied_paths,
)
from app.agent.hooks.lsp import LspHook
from app.agent.schemas.chat import FunctionCall, ToolCall


def _make_patch_tool_call(file_name: str = "main.py") -> ToolCall:
    return ToolCall(
        id="call_patch_1",
        type="function",
        function=FunctionCall(
            name="patch",
            arguments=json.dumps(
                {
                    "patch_text": (
                        "*** Begin Patch\n"
                        f"*** Update File: {file_name}\n"
                        "@@\n"
                        "-old_code()\n"
                        "+new_code()\n"
                        "*** End Patch\n"
                    )
                }
            ),
        ),
    )


@pytest.mark.asyncio
async def test_lsp_hook_skips_diagnostics_when_patch_returns_error(tmp_path):
    """When patch execution fails with an error, LSP diagnostics should NOT run."""
    file_path = tmp_path / "main.py"
    file_path.write_text("invalid python code :::\n", encoding="utf-8")

    config = DeniedPathsConfig(workspace=str(tmp_path))
    set_denied_paths(config)

    mock_check_diagnostics = AsyncMock(
        return_value="[LSP Diagnostics]\n- main.py:1:1: error: Syntax error"
    )

    try:
        hook = LspHook(enabled=True)
        tc = _make_patch_tool_call("main.py")

        error_result = "Error: Could not find patch context in main.py."

        async def handler(ctx, state, tool_call):
            return error_result

        with patch(
            "app.services.lsp.manager.check_lsp_diagnostics",
            mock_check_diagnostics,
        ):
            result = await hook.wrap_tool_call(MagicMock(), MagicMock(), tc, handler)

        assert result == error_result
        assert "[LSP Diagnostics]" not in result
        mock_check_diagnostics.assert_not_called()
    finally:
        set_denied_paths(None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure_result",
    [
        "Error: Could not find patch context in main.py.",
        "Error: File not found: main.py",
        "Error: Patch must start with '*** Begin Patch' and end with '*** End Patch'.",
        "error: patch failed to apply",
        "[Failed: exit status 1]",
        "[Error: process crashed]",
        "[Timed out after 30.0s]",
        "Exit code 1: command failed",
        "",
    ],
)
async def test_lsp_hook_skips_diagnostics_on_all_error_formats(
    tmp_path, failure_result
):
    file_path = tmp_path / "main.py"
    file_path.write_text("x = 1\n", encoding="utf-8")

    config = DeniedPathsConfig(workspace=str(tmp_path))
    set_denied_paths(config)

    mock_check_diagnostics = AsyncMock(
        return_value="[LSP Diagnostics]\n- main.py:1:1: error: Some issue"
    )

    try:
        hook = LspHook(enabled=True)
        tc = _make_patch_tool_call("main.py")

        async def handler(ctx, state, tool_call):
            return failure_result

        with patch(
            "app.services.lsp.manager.check_lsp_diagnostics",
            mock_check_diagnostics,
        ):
            result = await hook.wrap_tool_call(MagicMock(), MagicMock(), tc, handler)

        assert result == failure_result
        assert "[LSP Diagnostics]" not in result
        mock_check_diagnostics.assert_not_called()
    finally:
        set_denied_paths(None)


@pytest.mark.asyncio
async def test_lsp_hook_runs_diagnostics_on_success(tmp_path):
    file_path = tmp_path / "main.py"
    file_path.write_text("x = 1\n", encoding="utf-8")

    config = DeniedPathsConfig(workspace=str(tmp_path))
    set_denied_paths(config)

    mock_check_diagnostics = AsyncMock(
        return_value="[LSP Diagnostics]\n- main.py:1:1: error: Syntax error (pyright)"
    )

    try:
        hook = LspHook(enabled=True)
        tc = _make_patch_tool_call("main.py")

        success_result = (
            "@@ openagentd-diff-meta {}\n"
            "Patch applied successfully. Updated paths:\nmain.py"
        )

        async def handler(ctx, state, tool_call):
            return success_result

        with patch(
            "app.services.lsp.manager.check_lsp_diagnostics",
            mock_check_diagnostics,
        ):
            result = await hook.wrap_tool_call(MagicMock(), MagicMock(), tc, handler)

        assert success_result in result
        assert "[LSP Diagnostics]" in result
        assert "- main.py:1:1: error: Syntax error (pyright)" in result
        mock_check_diagnostics.assert_called_once()
    finally:
        set_denied_paths(None)
