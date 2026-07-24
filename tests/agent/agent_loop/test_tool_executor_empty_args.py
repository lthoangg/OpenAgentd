"""Regression tests for empty tool-call arguments caused by output truncation.

Background
----------
``""`` arguments are a legitimate no-arg call (``bg``, ``date``), so the executor
treats falsy arguments as ``{}``. But when a model hits its output-token cap
before emitting any argument text, the same empty string arrives for a tool that
requires arguments. Production showed:

    tool_start  tool=write id=toolu_01S6yi... args={}
    tool_error  tool=write error=Invalid arguments for tool 'write':
                path: Field required; content: Field required

"Field required" tells the model its schema was wrong, when in fact its output
was cut off. The distinction matters because the correct recovery differs: split
the work into smaller chunks rather than re-send the same oversized call.

Contract under test
-------------------
Empty arguments for a tool with required parameters must produce an error string
that points at the corrective action (retry smaller) rather than a schema
complaint. Genuinely no-arg tools must still work.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import Field

from app.agent.agent_loop.tool_executor import make_tool_executor
from app.agent.schemas.chat import FunctionCall, ToolCall
from app.agent.state import AgentState, RunContext
from app.agent.tools.registry import tool


def _make_state() -> AgentState:
    return AgentState(messages=[])


def _make_ctx() -> RunContext:
    return RunContext(session_id="s1", run_id="r1", agent_name="tester")


def _tool_call(name: str, arguments: str) -> ToolCall:
    return ToolCall(id="call_1", function=FunctionCall(name=name, arguments=arguments))


@tool
def writes(
    path: Annotated[str, Field(description="Path.")],
    content: Annotated[str, Field(description="Content.")],
) -> str:
    """Write a file."""
    return f"wrote {path}"


@tool
def noargs() -> str:
    """Take no arguments."""
    return "ok"


async def test_empty_args_for_required_tool_asks_for_smaller_payload() -> None:
    execute = make_tool_executor({"writes": writes}, agent_name="tester")

    result = await execute(_make_ctx(), _make_state(), _tool_call("writes", ""))

    assert result.startswith("Error:")
    # Names the required fields and the corrective action, not "Field required"
    # (which reads as a schema mistake and invites the same oversized retry).
    assert "smaller payload" in result
    assert "content" in result and "path" in result


async def test_empty_args_for_required_tool_does_not_run_function() -> None:
    calls: list[str] = []

    @tool
    def record(path: Annotated[str, Field(description="Path.")]) -> str:
        """Record."""
        calls.append(path)
        return path

    execute = make_tool_executor({"record": record}, agent_name="tester")
    result = await execute(_make_ctx(), _make_state(), _tool_call("record", ""))

    assert result.startswith("Error:")
    assert calls == []


async def test_no_arg_tool_still_accepts_empty_arguments() -> None:
    """Empty args stay valid for tools that genuinely take none."""
    execute = make_tool_executor({"noargs": noargs}, agent_name="tester")

    assert await execute(_make_ctx(), _make_state(), _tool_call("noargs", "")) == "ok"
    assert await execute(_make_ctx(), _make_state(), _tool_call("noargs", "{}")) == "ok"


async def test_explicit_empty_object_still_reports_missing_fields() -> None:
    """An explicit '{}' is a schema mistake, not truncation — keep that message."""
    execute = make_tool_executor({"writes": writes}, agent_name="tester")

    result = await execute(_make_ctx(), _make_state(), _tool_call("writes", "{}"))

    assert result.startswith("Error:")
    assert "smaller payload" not in result, result
    assert "Field required" in result
