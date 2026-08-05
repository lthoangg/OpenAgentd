"""An LLM call that yields nothing must be retried, not reported as a finished turn.

Production symptom this pins down: a provider stream aborted upstream and yielded
zero chunks.  The loop's empty-response guard was gated on the previous message
being a ``ToolMessage``, so an abort on the *first* iteration after a user message
fell straight through — the loop appended an empty assistant message, logged
``action=final_response``, and reported ``has_response=True``.  The checkpointer
then declined to persist the empty message, so the user saw no reply and no error.
"""

from __future__ import annotations

from typing import AsyncIterator

import pytest

from app.agent.agent_loop import Agent
from app.agent.errors import ProviderRequestError
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatMessage,
    HumanMessage,
)

from app.agent.schemas.chat import ChatCompletionChunkChoice, ChatCompletionDelta

from tests.agent.test_agent_run import make_text_chunk


def _completed_empty_chunk() -> ChatCompletionChunk:
    """A well-formed end-of-turn carrying no content — the provider explicitly
    signalled it was done.  Distinct from an aborted stream, which never sends a
    finish_reason at all."""
    return ChatCompletionChunk(
        id="chunk-finish",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0, delta=ChatCompletionDelta(), finish_reason="stop"
            )
        ],
    )


class ScriptedProvider(LLMProviderBase):
    """Mock provider replaying a script of chunk batches; an empty batch models a
    stream that aborted upstream without emitting anything."""

    model = "mock-model"

    def __init__(self, responses: list[list[ChatCompletionChunk]]):
        super().__init__()
        self._responses = iter(responses)
        self.call_count = 0

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AsyncIterator[ChatCompletionChunk]:
        self.call_count += 1
        chunks = next(self._responses)

        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            for chunk in chunks:
                yield chunk

        return _gen()

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        return AssistantMessage(content="mock")


async def test_aborted_first_iteration_is_retried_after_user_message():
    """The regression: a stream that dies on iteration 1 without ever signalling
    end-of-turn must be retried, not silently accepted as the final response."""
    provider = ScriptedProvider([[], [make_text_chunk("recovered answer")]])
    agent = Agent(name="bot", llm_provider=provider)

    msgs = await agent.run([HumanMessage(content="hello")])

    assert provider.call_count == 2
    final = [m for m in msgs if isinstance(m, AssistantMessage)][-1]
    assert final.content == "recovered answer"


async def test_completed_empty_response_ends_the_turn_without_retrying():
    """A provider that explicitly signals end-of-turn with no content has not
    failed — it said it was done.  Retrying would burn a full prompt per attempt
    for no reason, so this must cost exactly one call."""
    provider = ScriptedProvider([[_completed_empty_chunk()]])
    agent = Agent(name="bot", llm_provider=provider)

    await agent.run([HumanMessage(content="hello")])

    assert provider.call_count == 1


async def test_persistently_aborted_stream_raises_a_visible_provider_error():
    """Exhausting the retry budget must surface an error, not end the turn
    "successfully" with nothing — a contentless assistant message is never
    persisted or rendered, so a silent break is the very failure being fixed.
    Team members translate ProviderRequestError into a visible turn error."""
    provider = ScriptedProvider([[] for _ in range(50)])
    agent = Agent(name="bot", llm_provider=provider)

    with pytest.raises(ProviderRequestError) as excinfo:
        await agent.run([HumanMessage(content="hello")])

    assert "empty" in str(excinfo.value).lower()
    # Bounded: must not spin the full 5000-iteration budget.
    assert provider.call_count <= 5


async def test_normal_response_is_not_retried():
    """Guard: a first-shot non-empty response still costs exactly one call."""
    provider = ScriptedProvider([[make_text_chunk("straight answer")]])
    agent = Agent(name="bot", llm_provider=provider)

    msgs = await agent.run([HumanMessage(content="hello")])

    assert provider.call_count == 1
    final = [m for m in msgs if isinstance(m, AssistantMessage)][-1]
    assert final.content == "straight answer"
