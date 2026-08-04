"""Loop-level end-turn signal — structured replacement for the ``<sleep>`` sentinel.

A tool that sets ``state.metadata["end_turn"] = True`` ends the agent loop
after its tool batch completes: tools run, results are persisted, and no
further LLM call is made. The legacy ``<sleep>`` / ``[sleep]`` text sentinel
keeps working for old histories/models, but is no longer required.
"""

from __future__ import annotations

from typing import Annotated, Any, AsyncIterator

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatMessage,
    HumanMessage,
    ToolMessage,
)
from app.agent.tools.registry import InjectedArg, Tool

from tests.agent.test_agent_run import make_text_chunk, make_tool_chunk


class CountingProvider(LLMProviderBase):
    """Mock provider that counts stream() calls."""

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


def _make_end_turn_tool() -> Tool:
    async def finish_up(_state: Annotated[Any, InjectedArg()] = None) -> str:
        """Tool that requests the turn to end after this batch."""
        if _state is not None:
            _state.metadata["end_turn"] = True
        return "done"

    return Tool(finish_up, name="finish_up", description="Finish and end the turn.")


def _make_noop_tool() -> Tool:
    async def noop() -> str:
        """Tool that does nothing."""
        return "ok"

    return Tool(noop, name="noop", description="No-op.")


async def test_end_turn_flag_breaks_loop_after_tools():
    """No further LLM call after a tool sets the end_turn flag."""
    provider = CountingProvider(
        [
            [make_tool_chunk("finish_up", "call-1", "{}")],
            [make_text_chunk("SHOULD NOT BE REQUESTED")],
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[_make_end_turn_tool()])

    msgs = await agent.run([HumanMessage(content="wrap it up")])

    assert provider.call_count == 1
    # Tool executed and its result persisted.
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert [m.content for m in tool_msgs] == ["done"]
    assert not any(
        isinstance(m, AssistantMessage) and m.content == "SHOULD NOT BE REQUESTED"
        for m in msgs
    )


async def test_end_turn_flag_is_one_shot():
    """The flag only ends the turn it was set in — a fresh run is unaffected."""
    provider = CountingProvider(
        [
            [make_tool_chunk("finish_up", "call-1", "{}")],
            [make_tool_chunk("noop", "call-2", "{}")],
            [make_text_chunk("second turn final")],
        ]
    )
    agent = Agent(
        name="bot",
        llm_provider=provider,
        tools=[_make_end_turn_tool(), _make_noop_tool()],
    )

    first = await agent.run([HumanMessage(content="turn one")])
    assert provider.call_count == 1

    second = await agent.run([*first, HumanMessage(content="turn two")])
    # Second turn runs normally: noop tool call, then a final text response.
    assert provider.call_count == 3
    final = [m for m in second if isinstance(m, AssistantMessage)][-1]
    assert final.content == "second turn final"


async def test_loop_without_flag_continues_after_tools():
    """Guard: a normal tool batch still loops back to the LLM."""
    provider = CountingProvider(
        [
            [make_tool_chunk("noop", "call-1", "{}")],
            [make_text_chunk("final answer")],
        ]
    )
    agent = Agent(name="bot", llm_provider=provider, tools=[_make_noop_tool()])

    msgs = await agent.run([HumanMessage(content="do a thing")])

    assert provider.call_count == 2
    final = [m for m in msgs if isinstance(m, AssistantMessage)][-1]
    assert final.content == "final answer"
