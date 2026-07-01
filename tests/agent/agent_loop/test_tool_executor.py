"""Tests for the innermost tool executor — how it handles validation failures.

These complement ``tests/agent/tools/test_registry.py`` (which tests ``arun``
in isolation). Here we exercise the full executor path used by the agent loop:
parse JSON args → look up the tool → ``arun`` with injected state → coerce the
result, and crucially **how a validation failure is surfaced back to the LLM**.

Contract under test
-------------------
A bad argument set must NOT propagate as an exception out of ``execute`` — the
agent loop relies on the executor turning every failure into a short
``"Error: ..."`` *string* result. That string becomes the ``ToolMessage``
content the model reads on its next turn, so it can self-correct. The tool's
underlying function must never run when validation fails.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field, field_validator

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


# ---------------------------------------------------------------------------
# Happy path — baseline
# ---------------------------------------------------------------------------


async def test_executor_returns_result_string_on_success():
    @tool
    def add(
        a: Annotated[int, Field(description="First.")],
        b: Annotated[int, Field(description="Second.")],
    ) -> int:
        """Add."""
        return a + b

    execute = make_tool_executor({"add": add}, agent_name="tester")
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("add", '{"a": 2, "b": 3}')
    )
    assert result == "5"


# ---------------------------------------------------------------------------
# Validation failure handling — the focus of this module
# ---------------------------------------------------------------------------


async def test_executor_validation_failure_returns_error_string_not_exception():
    """A type-mismatch arg becomes an 'Error: ...' string, not a raised exc."""

    @tool
    def typed(x: Annotated[int, Field(description="Integer.")]) -> int:
        """Typed."""
        return x

    execute = make_tool_executor({"typed": typed}, agent_name="tester")
    # Must not raise — the executor swallows it into a result string.
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("typed", '{"x": "nope"}')
    )
    assert isinstance(result, str)
    assert result.startswith("Error:")
    assert "typed" in result  # tool named so the LLM knows what to fix


async def test_executor_validation_failure_does_not_run_function():
    """The function body is skipped when validation fails."""
    calls: list[int] = []

    @tool
    def record(x: Annotated[int, Field(description="Integer.")]) -> int:
        """Record."""
        calls.append(x)
        return x

    execute = make_tool_executor({"record": record}, agent_name="tester")
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("record", '{"x": "bad"}')
    )
    assert result.startswith("Error:")
    assert calls == []


async def test_executor_missing_required_field_returns_error_string():
    @tool
    def needs(required: Annotated[str, Field(description="Required.")]) -> str:
        """Needs."""
        return required

    execute = make_tool_executor({"needs": needs}, agent_name="tester")
    result = await execute(_make_ctx(), _make_state(), _tool_call("needs", "{}"))
    assert result.startswith("Error:")
    assert "needs" in result


async def test_executor_malformed_json_arguments_returns_error_string():
    """Unparseable arguments JSON is reported, not raised."""

    @tool
    def noop(x: Annotated[int, Field(description="Integer.")]) -> int:
        """Noop."""
        return x

    execute = make_tool_executor({"noop": noop}, agent_name="tester")
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("noop", "{not valid json")
    )
    assert result.startswith("Error:")
    assert "noop" in result


async def test_executor_unknown_tool_returns_error_string():
    execute = make_tool_executor({}, agent_name="tester")
    result = await execute(_make_ctx(), _make_state(), _tool_call("ghost", "{}"))
    assert result.startswith("Error:")
    assert "ghost" in result


async def test_executor_args_schema_constraint_failure_returns_error_string():
    """An args_schema constraint violation is surfaced as an error string."""

    class Args(BaseModel):
        n: int = Field(ge=1, le=10, description="1-10.")

    @tool(args_schema=Args)
    def bounded(n: int) -> int:
        """Bounded."""
        return n

    execute = make_tool_executor({"bounded": bounded}, agent_name="tester")
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("bounded", '{"n": 50}')
    )
    assert result.startswith("Error:")
    assert "bounded" in result


async def test_executor_args_schema_custom_validator_failure_returns_error_string():
    """A custom @field_validator rejection is surfaced as an error string."""

    class Args(BaseModel):
        query: str = Field(description="Query.")

        @field_validator("query")
        @classmethod
        def _not_blank(cls, v: str) -> str:
            if not v.strip():
                raise ValueError("query must not be blank")
            return v

    @tool(args_schema=Args)
    def search(query: str) -> str:
        """Search."""
        return query

    execute = make_tool_executor({"search": search}, agent_name="tester")
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("search", '{"query": "   "}')
    )
    assert result.startswith("Error:")
    assert "search" in result


async def test_executor_validation_failure_then_corrected_retry_succeeds():
    """After an error string, a corrected retry runs normally (LLM self-correct)."""

    @tool
    def squared(x: Annotated[int, Field(description="Integer.")]) -> int:
        """Square."""
        return x * x

    execute = make_tool_executor({"squared": squared}, agent_name="tester")
    bad = await execute(
        _make_ctx(), _make_state(), _tool_call("squared", '{"x": "five"}')
    )
    assert bad.startswith("Error:")
    good = await execute(_make_ctx(), _make_state(), _tool_call("squared", '{"x": 5}'))
    assert good == "25"


async def test_executor_runtime_error_also_returns_error_string():
    """A failure *inside* the tool body (post-validation) is also stringified."""

    @tool
    def explode(x: Annotated[int, Field(description="Integer.")]) -> int:
        """Explode."""
        raise RuntimeError("kaboom")

    execute = make_tool_executor({"explode": explode}, agent_name="tester")
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("explode", '{"x": 1}')
    )
    assert result.startswith("Error:")


async def test_executor_tool_timeout_returns_error_string(monkeypatch):
    """A tool call exceeding the global timeout is intercepted and returns an error string."""
    import asyncio
    import app.agent.agent_loop.tool_executor as te

    # Patch the timeout constant to be very short for this test
    monkeypatch.setattr(te, "TOOL_TIMEOUT_SECONDS", 0.05)

    @tool
    async def slow_tool() -> str:
        """A tool that runs slowly."""
        await asyncio.sleep(0.5)
        return "finished"

    execute = te.make_tool_executor({"slow_tool": slow_tool}, agent_name="tester")
    result = await execute(_make_ctx(), _make_state(), _tool_call("slow_tool", "{}"))
    assert result.startswith("Error:")
    assert "timed out after 0.05s" in result


async def test_executor_shell_tool_bypasses_global_timeout(monkeypatch):
    """The 'shell' tool bypasses the global executor timeout because it has its own internal timeout handling."""
    import asyncio
    import app.agent.agent_loop.tool_executor as te

    # Patch the timeout constant to be very short for this test
    monkeypatch.setattr(te, "TOOL_TIMEOUT_SECONDS", 0.05)

    @tool(name="shell")
    async def slow_shell() -> str:
        """A mocked shell tool that runs slowly."""
        await asyncio.sleep(0.1)
        return "shell finished"

    execute = te.make_tool_executor({"shell": slow_shell}, agent_name="tester")
    result = await execute(_make_ctx(), _make_state(), _tool_call("shell", "{}"))
    # Should not time out because it bypassed the 0.05s limit
    assert result == "shell finished"


async def test_executor_tool_custom_timeout_error_retains_message():
    """A tool that raises a TimeoutError with a custom message retains that message instead of using the generic global timeout error text."""

    @tool
    async def custom_timeout_tool() -> str:
        """A tool that raises an internal TimeoutError."""
        raise TimeoutError("Internal connection failed to database")

    execute = make_tool_executor(
        {"custom_timeout_tool": custom_timeout_tool}, agent_name="tester"
    )
    result = await execute(
        _make_ctx(), _make_state(), _tool_call("custom_timeout_tool", "{}")
    )
    assert result == "Error: Internal connection failed to database"
