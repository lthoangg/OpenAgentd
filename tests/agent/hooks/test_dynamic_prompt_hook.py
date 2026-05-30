"""Tests for the @dynamic_prompt decorator and inject_current_date hook."""

from datetime import datetime, timezone
import pytest

from app.agent.state import AgentState, ModelRequest, RunContext
from app.agent.hooks.base import BaseAgentHook
from app.agent.hooks.dynamic_prompt import (
    PromptRequest,
    dynamic_prompt,
    inject_current_date,
)
from app.agent.schemas.chat import AssistantMessage, HumanMessage


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_state(prompt: str = "Base prompt.", context=None) -> AgentState:
    return AgentState(
        messages=[HumanMessage(content="hi")],
        system_prompt=prompt,
        context=context,
    )


def make_ctx() -> RunContext:
    return RunContext(session_id="test-session", run_id="test-run", agent_name="bot")


def make_request(
    prompt: str = "Base prompt.", state: AgentState | None = None
) -> ModelRequest:
    s = state or make_state(prompt)
    return ModelRequest(
        messages=tuple(s.messages), system_prompt=prompt, context=s.context
    )


async def _call_wrap(
    hook,
    prompt: str,
    state: AgentState | None = None,
    ctx: RunContext | None = None,
) -> str:
    """Call wrap_model_call and return the system_prompt the handler received."""
    ctx = ctx or make_ctx()
    s = state or make_state(prompt)
    request = make_request(prompt, s)
    received: list[str] = []

    async def handler(req: ModelRequest) -> AssistantMessage:
        received.append(req.system_prompt)
        return AssistantMessage(content="ok")

    await hook.wrap_model_call(ctx, s, request, handler)
    return received[0] if received else prompt


# ---------------------------------------------------------------------------
# @dynamic_prompt decorator
# ---------------------------------------------------------------------------


def test_decorator_returns_base_agent_hook():
    """`@dynamic_prompt` must produce a BaseAgentHook-compatible object."""

    @dynamic_prompt
    def my_prompt(request: PromptRequest) -> str:
        return request.base_prompt + " extra"

    assert isinstance(my_prompt, BaseAgentHook)


@pytest.mark.asyncio
async def test_sync_function_rewrites_system_prompt():
    @dynamic_prompt
    def add_suffix(request: PromptRequest) -> str:
        return request.base_prompt + " [done]"

    result = await _call_wrap(add_suffix, "Hello.")
    assert result == "Hello. [done]"


@pytest.mark.asyncio
async def test_async_function_rewrites_system_prompt():
    @dynamic_prompt
    async def async_add(request: PromptRequest) -> str:
        return request.base_prompt + " [async]"

    result = await _call_wrap(async_add, "Start.")
    assert result == "Start. [async]"


@pytest.mark.asyncio
async def test_request_carries_base_prompt_and_state():
    """The PromptRequest passed to the function has correct base_prompt, state, and ctx."""
    captured = {}

    @dynamic_prompt
    def capture(request: PromptRequest) -> str:
        captured["req"] = request
        return request.base_prompt

    ctx = make_ctx()
    state = make_state("Original.")
    request = make_request("Original.", state)

    async def handler(req):
        return AssistantMessage(content="ok")

    await capture.wrap_model_call(ctx, state, request, handler)

    req = captured["req"]
    assert req.base_prompt == "Original."
    assert req.state is state
    assert req.ctx is ctx


@pytest.mark.asyncio
async def test_agent_context_accessible_in_request():
    """Functions can read state.context for role / locale aware prompts."""
    from unittest.mock import MagicMock

    @dynamic_prompt
    def role_prompt(request: PromptRequest) -> str:
        user_ctx = request.state.context
        if user_ctx and getattr(user_ctx, "user_group", None) == "expert":
            return request.base_prompt + "\n\nProvide detailed technical responses."
        return request.base_prompt + "\n\nExplain simply."

    user_ctx = MagicMock()
    user_ctx.user_group = "expert"
    state = make_state("You are helpful.", context=user_ctx)
    result = await _call_wrap(role_prompt, "You are helpful.", state)
    assert "detailed technical" in result


@pytest.mark.asyncio
async def test_passthrough_when_returning_base_prompt_unchanged():
    @dynamic_prompt
    def passthrough(request: PromptRequest) -> str:
        return request.base_prompt

    result = await _call_wrap(passthrough, "Unchanged.")
    assert result == "Unchanged."


# ---------------------------------------------------------------------------
# inject_current_date (built-in hook)
# ---------------------------------------------------------------------------


def test_inject_current_date_is_base_agent_hook():
    assert isinstance(inject_current_date, BaseAgentHook)


@pytest.mark.asyncio
async def test_inject_current_date_appends_todays_date():
    """Falls back to datetime.now() when ctx has no session_created_at."""
    result = await _call_wrap(inject_current_date, "You are a helpful assistant.")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    assert today in result
    assert result.startswith("You are a helpful assistant.")
    assert "Current date (UTC):" in result


@pytest.mark.asyncio
async def test_inject_current_date_format():
    """The date must be in YYYY-MM-DD format."""
    import re

    result = await _call_wrap(inject_current_date, "Base.")
    assert re.search(r"\d{4}-\d{2}-\d{2}", result)


@pytest.mark.asyncio
async def test_inject_current_date_uses_session_created_at():
    """Uses ctx.session_created_at when set — date is frozen at session creation."""
    frozen = datetime(2025, 1, 15, 10, 0, 0, tzinfo=timezone.utc)
    ctx = RunContext(
        session_id="s1", run_id="r1", agent_name="bot", session_created_at=frozen
    )
    state = make_state("Base.")
    request = make_request("Base.", state)
    received: list[str] = []

    async def handler(req: ModelRequest) -> AssistantMessage:
        received.append(req.system_prompt)
        return AssistantMessage(content="ok")

    await inject_current_date.wrap_model_call(ctx, state, request, handler)
    assert "2025-01-15" in received[0]


@pytest.mark.asyncio
async def test_inject_current_date_static_across_new_day():
    """The injected date does not change even when datetime.now() would return a different day."""
    # Simulate a session created yesterday
    yesterday = datetime(2020, 6, 14, 23, 59, 0, tzinfo=timezone.utc)
    ctx = RunContext(
        session_id="s2", run_id="r2", agent_name="bot", session_created_at=yesterday
    )
    state = make_state("Prompt.")
    request = make_request("Prompt.", state)
    received: list[str] = []

    async def handler(req: ModelRequest) -> AssistantMessage:
        received.append(req.system_prompt)
        return AssistantMessage(content="ok")

    await inject_current_date.wrap_model_call(ctx, state, request, handler)
    # Must use session date, not today's date
    assert "2020-06-14" in received[0]


@pytest.mark.asyncio
async def test_inject_current_date_same_for_same_session_created_at_across_runs():
    """Prompt date is stable across follow-up runs in the same session."""
    frozen = datetime(2024, 12, 31, 23, 59, 0, tzinfo=timezone.utc)
    state = make_state("Base.")

    first = await _call_wrap(
        inject_current_date,
        "Base.",
        state,
        ctx=RunContext(
            session_id="s1", run_id="r1", agent_name="bot", session_created_at=frozen
        ),
    )
    second = await _call_wrap(
        inject_current_date,
        "Base.",
        state,
        ctx=RunContext(
            session_id="s1", run_id="r2", agent_name="bot", session_created_at=frozen
        ),
    )

    assert first == second
    assert "2024-12-31" in first


# ---------------------------------------------------------------------------
# Composing multiple @dynamic_prompt hooks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multiple_hooks_chain_correctly():
    """Two @dynamic_prompt hooks compose correctly via wrap_model_call chain."""

    @dynamic_prompt
    def first(request: PromptRequest) -> str:
        return request.base_prompt + " ->first"

    @dynamic_prompt
    def second(request: PromptRequest) -> str:
        return request.base_prompt + " ->second"

    ctx = make_ctx()
    state = make_state("A")
    request = make_request("A", state)

    received: list[str] = []

    async def handler(req: ModelRequest) -> AssistantMessage:
        received.append(req.system_prompt)
        return AssistantMessage(content="ok")

    # Chain: first wraps second wraps handler
    async def second_handler(req: ModelRequest) -> AssistantMessage:
        return await second.wrap_model_call(ctx, state, req, handler)

    await first.wrap_model_call(ctx, state, request, second_handler)
    assert received[0] == "A ->first ->second"
