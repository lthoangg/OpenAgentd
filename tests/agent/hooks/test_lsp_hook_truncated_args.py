"""Regression tests for LspHook handling of truncated tool-call arguments.

Background
----------
When a model hits its output-token cap mid-``write``, the streamed tool-call
arguments can assemble to an empty string or invalid JSON. ``LspHook`` did an
unguarded ``json.loads(tool_call.function.arguments)``, which raised
``JSONDecodeError``. The broad ``except Exception`` caught it, so nothing broke
outwardly, but every truncated write logged a misleading

    Error in LspHook: Expecting value: line 1 column 1 (char 0)

which sent debugging down the wrong path. The hook has no diagnostics work to do
when it cannot tell which file was touched — it should pass the result through
quietly instead of raising and logging an error.
"""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock

from app.agent.hooks.lsp import LspHook
from app.agent.schemas.chat import FunctionCall, ToolCall


def _tool_call(arguments: str, name: str = "write") -> ToolCall:
    return ToolCall(
        id="call_1",
        type="function",
        function=FunctionCall(name=name, arguments=arguments),
    )


async def _handler(ctx, state, tool_call):  # noqa: ANN001 - test stub
    return "tool output"


@pytest.mark.parametrize(
    "arguments",
    [
        "",
        '{"path": "tests/agent/hooks/test_x.py"',  # truncated mid-object
        '{"path": "a.py", "content": "def f(',  # truncated mid-string
        "not json at all",
    ],
    ids=["empty", "truncated_object", "truncated_string", "garbage"],
)
async def test_lsp_hook_passes_through_unparseable_arguments(arguments: str) -> None:
    hook = LspHook()

    result = await hook.wrap_tool_call(
        MagicMock(), MagicMock(), _tool_call(arguments), _handler
    )

    assert result == "tool output"


async def test_lsp_hook_does_not_log_error_on_truncated_arguments() -> None:
    """A truncated call is an expected condition, not an LspHook failure."""
    from loguru import logger

    records: list[str] = []
    sink_id = logger.add(records.append, level="WARNING")
    try:
        hook = LspHook()
        await hook.wrap_tool_call(MagicMock(), MagicMock(), _tool_call(""), _handler)
    finally:
        logger.remove(sink_id)

    assert not any("Error in LspHook" in record for record in records), records
