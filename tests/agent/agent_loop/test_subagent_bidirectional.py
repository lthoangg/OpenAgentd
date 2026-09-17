from __future__ import annotations

import json
from typing import AsyncIterator
from uuid import uuid7
import pytest

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    FunctionCallDelta,
    HumanMessage,
    ToolCallDelta,
)
from app.agent.schemas.agent import RunConfig
from app.agent.tools.builtin.member import make_ask_lead_tool, make_send_to_lead_tool


class ScriptedProvider(LLMProviderBase):
    """Provider that yields pre-programmed response chunks."""

    model = "mock-model"

    def __init__(self, turns: list[list[ChatCompletionChunk]]) -> None:
        super().__init__()
        self._responses = iter(turns)
        self.call_count = 0

    def stream(
        self, messages, tools=None, **kwargs
    ) -> AsyncIterator[ChatCompletionChunk]:
        self.call_count += 1
        chunks = next(self._responses)

        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            for chunk in chunks:
                yield chunk

        return _gen()

    async def chat(self, messages, tools=None, **kwargs):
        from app.agent.schemas.chat import AssistantMessage

        return AssistantMessage(content="mock")


def make_tool_chunk(call_id: str, name: str, arguments: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-tool",
        created=1,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id=call_id,
                            function=FunctionCallDelta(name=name, arguments=arguments),
                        )
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )


def make_text_chunk(text: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-text",
        created=1,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=text),
                finish_reason="stop",
            )
        ],
    )


@pytest.mark.asyncio
async def test_member_send_to_lead_and_ask_lead() -> None:
    lead_id = str(uuid7())
    member_handle = "explorer#1"

    send_tool = make_send_to_lead_tool(lead_id, member_handle)
    ask_tool = make_ask_lead_tool(lead_id, member_handle)

    # 1. Member calls send_to_lead
    res = await send_tool.arun(message="Found 3 files", end_turn=True)
    assert "Message successfully delivered" in res

    # 2. Member calls ask_lead in agent loop -> suspends
    provider = ScriptedProvider(
        [
            [
                make_tool_chunk(
                    "call-1",
                    "ask_lead",
                    json.dumps(
                        {"question": "Which auth?", "options": ["jwt", "session"]}
                    ),
                )
            ]
        ]
    )

    agent = Agent(
        llm_provider=provider,
        system_prompt="You are explorer#1",
        tools=[],
        name=member_handle,
    )

    config = RunConfig(session_id="child-session", metadata={})
    history = [HumanMessage(content="Audit auth flow")]

    await agent.run(history, config=config, injected_tools=[ask_tool, send_tool])

    # Verify turn suspended on ask_lead
    assert "lead_suspended" in config.metadata
    assert config.metadata["lead_suspended"]["question"] == "Which auth?"
    assert config.metadata["lead_suspended"]["options"] == ["jwt", "session"]
