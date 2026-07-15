"""Tests for StreamPublisherHook usage event — agent name in metadata."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch


from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    Usage,
)
from app.agent.state import AgentState
from app.agent.schemas.chat import HumanMessage
from app.agent.providers.model_metadata import ModelCost


def _make_hook(session_id="sess-1", agent_name="lead") -> StreamPublisherHook:
    return StreamPublisherHook(session_id=session_id, agent_name=agent_name)


def _make_chunk_with_usage(
    prompt=100,
    completion=40,
    total=140,
    cached=None,
    model="mock",
):
    usage = Usage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
    )
    if cached is not None:
        object.__setattr__(usage, "cached_tokens", cached)
    delta = ChatCompletionDelta(content=None)
    choice = ChatCompletionChunkChoice(index=0, delta=delta, finish_reason="stop")
    return ChatCompletionChunk(
        id="c1", created=1000, model=model, choices=[choice], usage=usage
    )


def _make_chunk_no_usage():
    delta = ChatCompletionDelta(content="hello")
    choice = ChatCompletionChunkChoice(index=0, delta=delta, finish_reason=None)
    return ChatCompletionChunk(
        id="c1", created=1000, model="mock", choices=[choice], usage=None
    )


def _make_state() -> AgentState:
    return AgentState(messages=[HumanMessage(content="hi")])


async def test_on_model_delta_emits_usage_event():
    """usage event is pushed when chunk has usage data."""
    hook = _make_hook(agent_name="lead")
    pushed = []

    with (
        patch(
            "app.services.memory_stream_store.push_event",
            new_callable=AsyncMock,
            side_effect=lambda sid, ev: pushed.append(ev),
        ),
        patch(
            "app.agent.usage.get_model_cost",
            return_value=ModelCost(input=2.0, output=5.0),
        ),
    ):
        state = _make_state()
        await hook.on_model_delta(MagicMock(), state, _make_chunk_with_usage())

    assert len(pushed) == 1
    event = pushed[0]
    assert event.event == "usage"
    assert event.data["type"] == "usage"
    assert event.data["prompt_tokens"] == 100
    assert event.data["completion_tokens"] == 40
    assert event.data["total_tokens"] == 140
    assert event.data["estimated_cost_usd"] == 0.0004


async def test_on_model_delta_usage_agent_name_in_metadata():
    """agent name is stored in metadata.agent, not as a top-level field."""
    hook = _make_hook(agent_name="researcher")
    pushed = []

    with patch(
        "app.services.memory_stream_store.push_event",
        new_callable=AsyncMock,
        side_effect=lambda sid, ev: pushed.append(ev),
    ):
        state = _make_state()
        await hook.on_model_delta(MagicMock(), state, _make_chunk_with_usage())

    data = pushed[0].data
    assert data.get("agent") is None, "agent must not be top-level"
    assert data["metadata"]["agent"] == "researcher"


async def test_on_model_delta_no_usage_event_when_chunk_has_no_usage():
    """No usage event pushed when chunk.usage is None."""
    hook = _make_hook()
    pushed = []

    with patch(
        "app.services.memory_stream_store.push_event",
        new_callable=AsyncMock,
        side_effect=lambda sid, ev: pushed.append(ev),
    ):
        state = _make_state()
        await hook.on_model_delta(MagicMock(), state, _make_chunk_no_usage())

    usage_events = [e for e in pushed if e.event == "usage"]
    assert len(usage_events) == 0


async def test_on_model_delta_usage_session_id_correct():
    """Usage event is pushed to the correct session_id stream."""
    hook = _make_hook(session_id="team-lead-sess", agent_name="lead")
    pushed_to = []

    with patch(
        "app.services.memory_stream_store.push_event",
        new_callable=AsyncMock,
        side_effect=lambda sid, ev: pushed_to.append(sid),
    ):
        state = _make_state()
        await hook.on_model_delta(MagicMock(), state, _make_chunk_with_usage())

    assert pushed_to[0] == "team-lead-sess"


async def test_after_agent_emits_turn_total_after_multiple_usage_events():
    """Multiple model calls also publish a final aggregate turn usage event."""
    hook = _make_hook(agent_name="lead")
    pushed = []

    with patch(
        "app.services.memory_stream_store.push_event",
        new_callable=AsyncMock,
        side_effect=lambda sid, ev: pushed.append(ev),
    ):
        state = _make_state()
        await hook.on_model_delta(
            MagicMock(),
            state,
            _make_chunk_with_usage(
                prompt=100,
                completion=20,
                total=120,
                cached=10,
                model="model-a",
            ),
        )
        await hook.on_model_delta(
            MagicMock(),
            state,
            _make_chunk_with_usage(
                prompt=120,
                completion=30,
                total=150,
                cached=15,
                model="model-b",
            ),
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
