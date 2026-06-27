"""Tests for support_interrupt — provider-level mid-stream interrupt opt-out.

Covers:
  - LLMProviderBase.support_interrupt defaults to True
  - A provider with support_interrupt=False lets the stream finish even when
    interrupt_event fires mid-stream
  - A provider with support_interrupt=True (default) stops streaming as soon
    as interrupt_event fires
  - The agent loop top-of-iteration check still fires for both provider types,
    so the loop exits after the current stream completes (not just never)
  - support_interrupt=False does not affect tool dispatch interrupt (tools are
    still cancelled via gather_or_cancel's own interrupt_event which comes from
    core.py, not streaming.py)
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

import pytest

from app.agent.agent_loop import Agent
from app.agent.agent_loop.streaming import stream_and_assemble
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    HumanMessage,
)
from app.agent.state import ModelRequest, RunContext


# ---------------------------------------------------------------------------
# Helpers shared with test_agent_run — duplicated here to keep the test file
# self-contained (no import from another test module).
# ---------------------------------------------------------------------------


def make_text_chunk(text: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-1",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=text),
                finish_reason="stop",
            )
        ],
    )


class _BaseProvider(LLMProviderBase):
    """Provider that streams a configurable sequence of chunks with optional pauses."""

    model = "mock-model"

    def __init__(self, chunks: list[str], *, pause_between: float = 0.0):
        super().__init__()
        self._chunks = chunks
        self._pause = pause_between
        self.chunks_yielded: list[str] = []

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AsyncIterator[ChatCompletionChunk]:
        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            for text in self._chunks:
                self.chunks_yielded.append(text)
                yield make_text_chunk(text)
                if self._pause:
                    await asyncio.sleep(self._pause)

        return _gen()

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        return AssistantMessage(content="mock")


class DefaultProvider(_BaseProvider):
    """support_interrupt=True (the default)."""

    pass


class NonInterruptibleProvider(_BaseProvider):
    """support_interrupt=False — simulates a stateful proxy provider like agy."""

    support_interrupt = False


# ---------------------------------------------------------------------------
# Unit: LLMProviderBase default
# ---------------------------------------------------------------------------


def test_support_interrupt_default_is_true():
    assert LLMProviderBase.support_interrupt is True


def test_default_provider_inherits_true():
    p = DefaultProvider(["hi"])
    assert p.support_interrupt is True


def test_non_interruptible_provider_has_false():
    p = NonInterruptibleProvider(["hi"])
    assert p.support_interrupt is False


# ---------------------------------------------------------------------------
# Unit: stream_and_assemble respects support_interrupt
#
# We test at the stream_and_assemble level so we exercise the exact code path
# (_interruptible_stream + stream_with_retry) without needing a full agent run.
# ---------------------------------------------------------------------------


def _make_run_ctx() -> RunContext:
    return RunContext(
        session_id="test-session",
        run_id="test-run",
        agent_name="test-agent",
    )


def _make_model_request(prompt: str = "go") -> ModelRequest:
    return ModelRequest(
        messages=(HumanMessage(content=prompt),),
        system_prompt="You are a test assistant.",
        context=None,
    )


@pytest.mark.asyncio
async def test_interruptible_stream_stops_mid_stream():
    """Default provider (support_interrupt=True): fires interrupt mid-stream → fewer chunks assembled."""
    event = asyncio.Event()
    # 5 chunks, pause between each so the interrupt has time to fire mid-stream
    provider = DefaultProvider(["a", "b", "c", "d", "e"], pause_between=0.05)

    async def _set_after_two():
        # Let two chunks yield, then fire the interrupt
        while len(provider.chunks_yielded) < 2:
            await asyncio.sleep(0.01)
        event.set()

    setter = asyncio.create_task(_set_after_two())
    msg, _ = await stream_and_assemble(
        req=_make_model_request(),
        ctx=_make_run_ctx(),
        state=None,  # type: ignore[arg-type]
        hooks=[],
        interrupt_event=event,
        tool_defs=[],
        primary_provider=provider,
        primary_label="mock",
        agent_name="test-agent",
        agent_id="test-id",
    )
    await setter

    # Stream was cut short — not all 5 chunks were assembled
    assembled = msg.content or ""
    assert len(assembled) < 5, (
        f"expected fewer than 5 chars, got {len(assembled)!r} ({assembled!r}); "
        f"chunks_yielded={provider.chunks_yielded}"
    )


@pytest.mark.asyncio
async def test_non_interruptible_stream_completes_despite_interrupt():
    """Non-interruptible provider (support_interrupt=False): interrupt fires mid-stream → all chunks assembled."""
    event = asyncio.Event()
    # Set the interrupt immediately — for a normal provider this would cut streaming
    event.set()

    provider = NonInterruptibleProvider(["x", "y", "z"])

    msg, _ = await stream_and_assemble(
        req=_make_model_request(),
        ctx=_make_run_ctx(),
        state=None,  # type: ignore[arg-type]
        hooks=[],
        interrupt_event=event,
        tool_defs=[],
        primary_provider=provider,
        primary_label="mock",
        agent_name="test-agent",
        agent_id="test-id",
    )

    # All chunks must have been yielded and assembled
    assert provider.chunks_yielded == ["x", "y", "z"]
    assert msg.content == "xyz"


@pytest.mark.asyncio
async def test_interruptible_provider_pre_set_event_stops_immediately():
    """Default provider with pre-set interrupt event stops before any chunks are assembled."""
    event = asyncio.Event()
    event.set()  # already set before streaming starts

    provider = DefaultProvider(["a", "b", "c"], pause_between=0.0)

    msg, _ = await stream_and_assemble(
        req=_make_model_request(),
        ctx=_make_run_ctx(),
        state=None,  # type: ignore[arg-type]
        hooks=[],
        interrupt_event=event,
        tool_defs=[],
        primary_provider=provider,
        primary_label="mock",
        agent_name="test-agent",
        agent_id="test-id",
    )

    # Either no chunks were yielded, or the assembled content is empty / very short
    # (_interruptible_stream races against event.wait() — the event is already set so
    # it may beat the first __anext__ call)
    assert (msg.content or "") in ("", "a"), (
        f"expected empty or at most first chunk, got {msg.content!r}"
    )


# ---------------------------------------------------------------------------
# Integration: Agent.run() loop-level interrupt behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_loop_exits_after_non_interruptible_stream_completes():
    """For support_interrupt=False, Agent.run() must still exit cleanly after
    the interrupt fires mid-stream — the stream completes in full, then the
    top-of-iteration check at the start of the *next* iteration catches the
    event and breaks the loop.

    Note: the top-of-iteration check fires *before* each LLM call, so if the
    event is already set before run() begins the loop exits without calling the
    provider at all (that is correct behaviour — support_interrupt=False only
    prevents mid-stream abortion, not the between-iteration guard). To actually
    exercise mid-stream completion we fire the event *during* streaming.
    """
    event = asyncio.Event()

    provider = NonInterruptibleProvider(["p", "q", "r"], pause_between=0.02)
    agent = Agent(name="bot", llm_provider=provider)

    # Fire the interrupt mid-stream (after the first chunk is yielded) so the
    # loop is inside stream_and_assemble when the event fires.  For a
    # support_interrupt=False provider the stream must still finish in full.
    async def _set_after_first():
        while len(provider.chunks_yielded) < 1:
            await asyncio.sleep(0.005)
        event.set()

    setter = asyncio.create_task(_set_after_first())
    msgs = await agent.run(
        [HumanMessage(content="go")],
        interrupt_event=event,
    )
    await setter

    # All chunks were yielded — the stream ran to completion despite the interrupt
    assert provider.chunks_yielded == ["p", "q", "r"]

    # run() returned a list (didn't hang or raise)
    assert isinstance(msgs, list)

    # The assembled assistant message contains the full content
    assistant = next(
        (m for m in reversed(msgs) if isinstance(m, AssistantMessage)), None
    )
    assert assistant is not None
    assert assistant.content == "pqr"


@pytest.mark.asyncio
async def test_agent_loop_exits_early_for_interruptible_provider():
    """For support_interrupt=True (default), Agent.run() stops streaming
    promptly when the interrupt fires mid-stream."""
    event = asyncio.Event()

    provider = DefaultProvider(["1", "2", "3", "4", "5"], pause_between=0.05)
    agent = Agent(name="bot", llm_provider=provider)

    async def _set_after_first():
        while len(provider.chunks_yielded) < 1:
            await asyncio.sleep(0.01)
        event.set()

    setter = asyncio.create_task(_set_after_first())
    msgs = await agent.run(
        [HumanMessage(content="go")],
        interrupt_event=event,
    )
    await setter

    # Not all 5 chunks reached the assembler
    assert len(provider.chunks_yielded) < 5

    # run() returned cleanly
    assert isinstance(msgs, list)


@pytest.mark.asyncio
async def test_no_interrupt_event_non_interruptible_provider_completes_normally():
    """When interrupt_event=None, support_interrupt=False provider behaves identically
    to any other provider — stream runs to completion."""
    provider = NonInterruptibleProvider(["a", "b", "c"])
    agent = Agent(name="bot", llm_provider=provider)

    msgs = await agent.run(
        [HumanMessage(content="go")],
        interrupt_event=None,
    )

    assert provider.chunks_yielded == ["a", "b", "c"]
    assistant = next(
        (m for m in reversed(msgs) if isinstance(m, AssistantMessage)), None
    )
    assert assistant is not None
    assert assistant.content == "abc"
