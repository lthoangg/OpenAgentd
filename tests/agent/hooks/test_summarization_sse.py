"""SSE emission tests for SummarizationHook.

Verifies that summarization_start / summarization_content / summarization_end
events flow through ``stream_store.push_event`` with the correct types and
payloads.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.hooks.summarization import SummarizationHook
from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.agent.state import AgentState, ModelRequest, RunContext, UsageInfo


def _make_ctx(session_id: str | None = "sid-1") -> RunContext:
    return RunContext(session_id=session_id, run_id="run-1", agent_name="lead")


def _make_state(last_prompt_tokens: int = 1000) -> AgentState:
    return AgentState(
        messages=[
            HumanMessage(content="m1"),
            AssistantMessage(content="a1"),
            HumanMessage(content="m2"),
            AssistantMessage(content="a2"),
        ],
        usage=UsageInfo(last_prompt_tokens=last_prompt_tokens),
    )


def _make_provider(chunks: list[str]) -> MagicMock:
    """Return a provider whose stream yields the given content chunks."""
    provider = MagicMock()

    async def _stream(*_args, **_kwargs):
        for c in chunks:
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = c
            chunk.usage = None
            yield chunk

    provider.stream.return_value = _stream()
    return provider


async def _noop_model_handler(request: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="done")


async def _run_summarization(
    hook: SummarizationHook, ctx: RunContext, state: AgentState
) -> None:
    await hook.before_model(ctx, state)
    await hook.wrap_model_call(
        ctx,
        state,
        ModelRequest(
            messages=tuple(state.messages_for_llm), system_prompt=state.system_prompt
        ),
        _noop_model_handler,
    )


@pytest.mark.asyncio
async def test_emits_start_content_end_on_success():
    """Hook publishes start → N content deltas → end with the full summary."""
    provider = _make_provider(["Hello ", "world", "."])
    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
    )

    fake_push = AsyncMock()
    with patch("app.services.memory_stream_store.push_event", new=fake_push):
        await _run_summarization(hook, _make_ctx(), _make_state())

    events = [c.args[1].event for c in fake_push.call_args_list]
    assert events[0] == "summarization_start"
    assert events[-1] == "summarization_end"
    content_events = [
        c.args[1]
        for c in fake_push.call_args_list
        if c.args[1].event == "summarization_content"
    ]
    assert [e.data["text"] for e in content_events] == ["Hello ", "world", "."]

    start_env = fake_push.call_args_list[0].args[1]
    assert start_env.data["agent"] == "lead"

    end_env = fake_push.call_args_list[-1].args[1]
    assert end_env.data["agent"] == "lead"
    assert end_env.data["summary"] == "Hello world."
    assert end_env.data.get("metadata", {}).get("error") is not True


@pytest.mark.asyncio
async def test_emits_end_with_error_on_llm_failure():
    """When the summariser LLM raises, the hook still emits end{error: true}."""
    provider = MagicMock()

    async def _boom(*_a, **_kw):
        raise RuntimeError("llm down")
        yield  # pragma: no cover — keep this an async generator

    provider.stream.side_effect = lambda *a, **kw: _boom()

    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
    )

    fake_push = AsyncMock()
    with patch("app.services.memory_stream_store.push_event", new=fake_push):
        await _run_summarization(hook, _make_ctx(), _make_state())

    events = [c.args[1].event for c in fake_push.call_args_list]
    assert "summarization_start" in events
    assert events[-1] == "summarization_end"
    end_env = fake_push.call_args_list[-1].args[1]
    assert end_env.data.get("metadata", {}).get("error") is True
    assert end_env.data["summary"] == ""


@pytest.mark.asyncio
async def test_emits_end_with_error_on_empty_summary():
    """An empty LLM response is treated as an error for SSE purposes."""
    provider = _make_provider([])  # stream yields nothing
    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
    )

    fake_push = AsyncMock()
    with patch("app.services.memory_stream_store.push_event", new=fake_push):
        await _run_summarization(hook, _make_ctx(), _make_state())

    events = [c.args[1].event for c in fake_push.call_args_list]
    assert events[-1] == "summarization_end"
    end_env = fake_push.call_args_list[-1].args[1]
    assert end_env.data.get("metadata", {}).get("error") is True


@pytest.mark.asyncio
async def test_no_emission_without_session_id():
    """Headless runs (no session_id on ctx) must not touch the stream store."""
    provider = _make_provider(["Summary."])
    hook = SummarizationHook(
        llm_provider=provider,
        summary_prompt="test summary prompt",
        prompt_token_threshold=1000,
        keep_last_assistants=1,
    )

    fake_push = AsyncMock()
    with patch("app.services.memory_stream_store.push_event", new=fake_push):
        await _run_summarization(hook, _make_ctx(session_id=None), _make_state())

    fake_push.assert_not_called()
