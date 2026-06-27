from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.agent.agent_loop.streaming import stream_and_assemble
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    FunctionCallDelta,
    ToolCallDelta,
)
from app.agent.state import AgentState, ModelRequest, RunContext


class _Provider(LLMProviderBase):
    async def chat(self, messages, tools=None, **kwargs):  # type: ignore[no-untyped-def]
        raise NotImplementedError

    async def stream(
        self,
        messages,
        tools=None,
        **kwargs: Any,  # type: ignore[no-untyped-def]
    ) -> AsyncIterator[ChatCompletionChunk]:
        del messages, tools, kwargs
        for arguments in (
            '{"path":"big.txt",',
            '"content":"hello',
            ' world"}',
        ):
            yield ChatCompletionChunk(
                id="chunk",
                created=1,
                model="test",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(
                            tool_calls=[
                                ToolCallDelta(
                                    index=0,
                                    id="toolu_big",
                                    function=FunctionCallDelta(
                                        name="write",
                                        arguments=arguments,
                                    ),
                                )
                            ]
                        ),
                    )
                ],
            )


@pytest.mark.asyncio
async def test_stream_and_assemble_concatenates_tool_argument_deltas() -> None:
    message, _usage = await stream_and_assemble(
        req=ModelRequest(messages=(), system_prompt=""),
        ctx=RunContext(session_id="session", run_id="run", agent_name="agent"),
        state=AgentState(messages=[]),
        hooks=[],
        interrupt_event=None,
        tool_defs=[],
        primary_provider=_Provider(),
        primary_label="test:model",
        agent_name="agent",
        agent_id="agent",
    )

    assert message.tool_calls is not None
    assert message.tool_calls[0].function.arguments == (
        '{"path":"big.txt","content":"hello world"}'
    )
