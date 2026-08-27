"""Tests for the StreamPublisherHook usage event.

The hook publishes usage from ``after_model``, reading the ``extra["usage"]``
snapshot ``stream_and_assemble`` attaches to the assembled assistant message —
the same dict the OTel span records and the DatabaseHook persists. These tests
pin that single-source-of-truth wiring, because the live token meter reads
nothing else.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    HumanMessage,
    Usage,
)
from app.agent.state import AgentState
from app.agent.providers.model_metadata import ModelCost
from app.agent.usage import usage_to_dict


def _make_hook(session_id="sess-1", agent_name="lead") -> StreamPublisherHook:
    return StreamPublisherHook(session_id=session_id, agent_name=agent_name)


def _make_response(
    prompt=100,
    completion=40,
    cached=None,
    thoughts=None,
    cost_model=None,
) -> AssistantMessage:
    """Build the message ``stream_and_assemble`` would hand to ``after_model``."""
    usage = Usage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
    )
    if cached is not None:
        object.__setattr__(usage, "cached_tokens", cached)
    if thoughts is not None:
        object.__setattr__(usage, "thoughts_tokens", thoughts)
    return AssistantMessage(
        content="ok", extra={"usage": usage_to_dict(usage, cost_model)}
    )


def _make_chunk(model="mock", content="hello"):
    delta = ChatCompletionDelta(content=content)
    choice = ChatCompletionChunkChoice(index=0, delta=delta, finish_reason=None)
    return ChatCompletionChunk(
        id="c1", created=1000, model=model, choices=[choice], usage=None
    )


def _make_state() -> AgentState:
    return AgentState(messages=[HumanMessage(content="hi")])


def _pushes():
    pushed: list = []
    return pushed, patch(
        "app.services.memory_stream_store.push_event",
        new_callable=AsyncMock,
        side_effect=lambda sid, ev: pushed.append(ev),
    )


async def test_after_model_emits_usage_event():
    """A completed model call publishes exactly one usage event."""
    hook = _make_hook(agent_name="lead")
    pushed, capture = _pushes()

    with (
        capture,
        patch(
            "app.agent.usage.get_model_cost",
            return_value=ModelCost(input=2.0, output=5.0),
        ),
    ):
        state = _make_state()
        await hook.after_model(MagicMock(), state, _make_response())

    usage_events = [event for event in pushed if event.event == "usage"]
    assert len(usage_events) == 1
    data = usage_events[0].data
    assert data["prompt_tokens"] == 100
    assert data["completion_tokens"] == 40
    assert data["total_tokens"] == 140
    assert data["estimated_cost_usd"] == 0.0004


async def test_published_usage_is_the_message_snapshot_telemetry_records():
    """The event must carry the assistant message's own usage extra verbatim.

    That dict is what ``set_usage_span_attributes`` writes to the OTel span and
    what the DatabaseHook persists for ``sumUsageFromMessages`` to read back on
    reload, so publishing anything else lets the meter drift from telemetry.
    """
    hook = _make_hook(agent_name="lead")
    pushed, capture = _pushes()

    with (
        capture,
        patch(
            "app.agent.usage.get_model_cost",
            return_value=ModelCost(input=3.0, output=6.0, cache_read=0.5),
        ),
    ):
        state = _make_state()
        response = _make_response(prompt=1000, completion=200, cached=400)
        await hook.after_model(MagicMock(), state, response)

    usage = response.extra["usage"]
    data = [event for event in pushed if event.event == "usage"][0].data
    assert data["prompt_tokens"] == usage["input"]
    assert data["completion_tokens"] == usage["output"]
    assert data["cached_tokens"] == usage["cache"]
    assert data["estimated_cost_usd"] == usage["cost"]["estimated_usd"]


async def test_no_usage_event_when_the_message_carries_no_usage():
    """Providers that never reported usage must not publish a zeroed event."""
    hook = _make_hook()
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        await hook.after_model(
            MagicMock(), state, AssistantMessage(content="ok", extra=None)
        )

    assert [event for event in pushed if event.event == "usage"] == []


async def test_streamed_chunks_do_not_publish_usage():
    """Per-chunk publication is what let providers repeating a cumulative usage
    snapshot on every chunk (Gemini, several OpenAI-compatible gateways)
    multiply the meter's totals and cost.
    """
    hook = _make_hook()
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        for _ in range(5):
            await hook.on_model_delta(MagicMock(), state, _make_chunk())

    assert [event for event in pushed if event.event == "usage"] == []


async def test_usage_agent_name_in_metadata():
    """agent name is stored in metadata.agent, not as a top-level field."""
    hook = _make_hook(agent_name="researcher")
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        await hook.after_model(MagicMock(), state, _make_response())

    data = [event for event in pushed if event.event == "usage"][0].data
    assert data.get("agent") is None, "agent must not be top-level"
    assert data["metadata"]["agent"] == "researcher"


async def test_usage_metadata_shows_the_model_the_provider_echoed():
    """Display metadata keeps the raw model string seen on the stream."""
    hook = _make_hook()
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        state.metadata["effective_model"] = "openai:gpt-4o"
        await hook.on_model_delta(MagicMock(), state, _make_chunk(model="gpt-4o"))
        await hook.after_model(MagicMock(), state, _make_response())

    data = [event for event in pushed if event.event == "usage"][0].data
    assert data["metadata"]["model"] == "gpt-4o"


async def test_usage_event_session_id_correct():
    """Usage event is pushed to the correct session_id stream."""
    hook = _make_hook(session_id="team-lead-sess", agent_name="lead")
    pushed_to: list[str] = []

    with patch(
        "app.services.memory_stream_store.push_event",
        new_callable=AsyncMock,
        side_effect=lambda sid, ev: pushed_to.append(sid),
    ):
        state = _make_state()
        await hook.after_model(MagicMock(), state, _make_response())

    assert pushed_to[0] == "team-lead-sess"


async def test_published_values_are_per_call_not_turn_cumulative():
    """Each event describes only its own model call.

    The client accumulates output and cost exactly as ``sumUsageFromMessages``
    does over persisted messages. Publishing a turn-cumulative total instead
    would double-count on a mid-turn reconcile, where a ``loadSession`` has
    already folded this turn's finished calls into the displayed total.
    """
    hook = _make_hook()
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=100, completion=20)
        )
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=150, completion=30)
        )

    usage_events = [event for event in pushed if event.event == "usage"]
    assert [event.data["prompt_tokens"] for event in usage_events] == [100, 150]
    assert [event.data["completion_tokens"] for event in usage_events] == [20, 30]
    assert [event.data["total_tokens"] for event in usage_events] == [120, 180]


async def test_published_cost_sums_to_the_turn_cost():
    """Cost is published per model call and summed by the client, so the
    published values must add up to exactly the turn's cost — once."""
    hook = _make_hook()
    pushed, capture = _pushes()

    with (
        capture,
        patch(
            "app.agent.usage.get_model_cost",
            return_value=ModelCost(input=2.0, output=5.0),
        ),
    ):
        state = _make_state()
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=100, completion=20)
        )
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=150, completion=30)
        )

    published = sum(
        event.data["estimated_cost_usd"] or 0
        for event in pushed
        if event.event == "usage"
    )
    expected = (100 + 150) * 2.0 / 1e6 + (20 + 30) * 5.0 / 1e6
    assert published == pytest.approx(expected)


async def test_after_agent_emits_turn_total_after_multiple_model_calls():
    """Multiple model calls also publish a final aggregate turn usage event."""
    hook = _make_hook(agent_name="lead")
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        await hook.on_model_delta(MagicMock(), state, _make_chunk(model="model-a"))
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=100, completion=20, cached=10)
        )
        await hook.on_model_delta(MagicMock(), state, _make_chunk(model="model-b"))
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=120, completion=30, cached=15)
        )
        await hook.after_agent(MagicMock(), state, MagicMock())

    usage_events = [event for event in pushed if event.event == "usage"]
    assert len(usage_events) == 3
    assert usage_events[0].data["metadata"].get("turn_total") is None
    assert usage_events[1].data["metadata"].get("turn_total") is None

    total = usage_events[2].data
    assert total["prompt_tokens"] == 220
    assert total["completion_tokens"] == 50
    assert total["total_tokens"] == 270
    assert total["cached_tokens"] == 25
    assert total["metadata"] == {
        "turn_total": True,
        "agent": "lead",
        "models": ["model-a", "model-b"],
    }


async def test_no_turn_total_for_a_single_model_call():
    """One model call needs no aggregate — the single event already is one."""
    hook = _make_hook()
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        await hook.after_model(MagicMock(), state, _make_response())
        await hook.after_agent(MagicMock(), state, MagicMock())

    assert len([event for event in pushed if event.event == "usage"]) == 1


async def test_turn_counters_reset_between_turns():
    """The turn_total aggregate must not inherit the previous turn's counts."""
    hook = _make_hook()
    pushed, capture = _pushes()

    with capture:
        state = _make_state()
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=100, completion=20)
        )
        await hook.after_agent(MagicMock(), state, MagicMock())
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=200, completion=30)
        )
        await hook.after_model(
            MagicMock(), state, _make_response(prompt=250, completion=40)
        )
        await hook.after_agent(MagicMock(), state, MagicMock())

    total = [
        event.data
        for event in pushed
        if event.event == "usage" and event.data["metadata"].get("turn_total")
    ][-1]
    assert total["prompt_tokens"] == 450
    assert total["completion_tokens"] == 70
