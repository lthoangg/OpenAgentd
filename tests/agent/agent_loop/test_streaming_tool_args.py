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


class _ReasoningEncryptedContentProvider(LLMProviderBase):
    """Emits a reasoning-item-completion delta followed by plain text."""

    async def chat(self, messages, tools=None, **kwargs):  # type: ignore[no-untyped-def]
        raise NotImplementedError

    async def stream(
        self,
        messages,
        tools=None,
        **kwargs: Any,  # type: ignore[no-untyped-def]
    ) -> AsyncIterator[ChatCompletionChunk]:
        del messages, tools, kwargs
        yield ChatCompletionChunk(
            id="chunk",
            created=1,
            model="test",
            choices=[
                ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionDelta(
                        reasoning_item_id="rs_1",
                        reasoning_encrypted_content="cipher123",
                    ),
                )
            ],
        )
        yield ChatCompletionChunk(
            id="chunk",
            created=1,
            model="test",
            choices=[
                ChatCompletionChunkChoice(
                    index=0, delta=ChatCompletionDelta(content="Done")
                )
            ],
        )


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


@pytest.mark.asyncio
async def test_stream_and_assemble_carries_reasoning_encrypted_content() -> None:
    """The reasoning item id/encrypted_content delta must land on the final
    AssistantMessage and in `extra` for DB persistence — required to replay
    the reasoning item ahead of its function_call on the next turn."""
    message, _usage = await stream_and_assemble(
        req=ModelRequest(messages=(), system_prompt=""),
        ctx=RunContext(session_id="session", run_id="run", agent_name="agent"),
        state=AgentState(messages=[]),
        hooks=[],
        interrupt_event=None,
        tool_defs=[],
        primary_provider=_ReasoningEncryptedContentProvider(),
        primary_label="test:model",
        agent_name="agent",
        agent_id="agent",
    )

    assert message.content == "Done"
    assert message.reasoning_item_id == "rs_1"
    assert message.reasoning_encrypted_content == "cipher123"
    assert message.extra is not None
    assert message.extra["reasoning_item_id"] == "rs_1"
    assert message.extra["reasoning_encrypted_content"] == "cipher123"


class _MultiReasoningEncryptedContentProvider(LLMProviderBase):
    """Emits multiple reasoning-item-completion deltas followed by plain text."""

    async def chat(self, messages, tools=None, **kwargs):  # type: ignore[no-untyped-def]
        raise NotImplementedError

    async def stream(
        self,
        messages,
        tools=None,
        **kwargs: Any,  # type: ignore[no-untyped-def]
    ) -> AsyncIterator[ChatCompletionChunk]:
        del messages, tools, kwargs
        yield ChatCompletionChunk(
            id="chunk",
            created=1,
            model="test",
            choices=[
                ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionDelta(
                        reasoning_item_id="rs_1",
                        reasoning_encrypted_content="cipher1",
                        reasoning_item_summary=[
                            {"type": "summary_text", "text": "Thought 1"}
                        ],
                    ),
                )
            ],
        )
        yield ChatCompletionChunk(
            id="chunk",
            created=1,
            model="test",
            choices=[
                ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionDelta(
                        reasoning_item_id="rs_2",
                        reasoning_encrypted_content="cipher2",
                        reasoning_item_summary=[
                            {"type": "summary_text", "text": "Thought 2"}
                        ],
                    ),
                )
            ],
        )
        yield ChatCompletionChunk(
            id="chunk",
            created=1,
            model="test",
            choices=[
                ChatCompletionChunkChoice(
                    index=0, delta=ChatCompletionDelta(content="Done")
                )
            ],
        )


@pytest.mark.asyncio
async def test_stream_and_assemble_collects_multiple_reasoning_encrypted_items() -> (
    None
):
    """All completed encrypted reasoning items must land on AssistantMessage in order."""
    message, _usage = await stream_and_assemble(
        req=ModelRequest(messages=(), system_prompt=""),
        ctx=RunContext(session_id="session", run_id="run", agent_name="agent"),
        state=AgentState(messages=[]),
        hooks=[],
        interrupt_event=None,
        tool_defs=[],
        primary_provider=_MultiReasoningEncryptedContentProvider(),
        primary_label="test:model",
        agent_name="agent",
        agent_id="agent",
    )

    assert message.content == "Done"
    assert message.reasoning_items is not None
    assert len(message.reasoning_items) == 2
    assert message.reasoning_items[0].id == "rs_1"
    assert message.reasoning_items[0].encrypted_content == "cipher1"
    assert message.reasoning_items[1].id == "rs_2"
    assert message.reasoning_items[1].encrypted_content == "cipher2"
    assert message.reasoning_item_id == "rs_2"
    assert message.reasoning_encrypted_content == "cipher2"
    assert message.extra is not None
    assert len(message.extra["reasoning_items"]) == 2
    assert message.extra["reasoning_item_id"] == "rs_2"
    assert message.extra["reasoning_encrypted_content"] == "cipher2"


class _CodexSpyProvider(LLMProviderBase):
    provider_name = "codex"

    def __init__(self) -> None:
        super().__init__()
        self.received_kwargs: dict[str, Any] = {}

    async def chat(self, messages, tools=None, **kwargs):  # type: ignore[no-untyped-def]
        raise NotImplementedError

    async def stream(
        self,
        messages,
        tools=None,
        **kwargs: Any,  # type: ignore[no-untyped-def]
    ) -> AsyncIterator[ChatCompletionChunk]:
        self.received_kwargs = kwargs
        yield ChatCompletionChunk(
            id="chunk",
            created=1,
            model="test",
            choices=[
                ChatCompletionChunkChoice(
                    index=0, delta=ChatCompletionDelta(content="Hello")
                )
            ],
        )


@pytest.mark.asyncio
async def test_stream_and_assemble_passes_session_id_to_codex_provider() -> None:
    """Codex provider stream call receives session_id from RunContext."""
    provider = _CodexSpyProvider()
    message, _usage = await stream_and_assemble(
        req=ModelRequest(messages=(), system_prompt=""),
        ctx=RunContext(session_id="session-xyz", run_id="run", agent_name="agent"),
        state=AgentState(messages=[]),
        hooks=[],
        interrupt_event=None,
        tool_defs=[],
        primary_provider=provider,
        primary_label="test:model",
        agent_name="agent",
        agent_id="agent",
    )

    assert message.content == "Hello"
    assert provider.received_kwargs.get("session_id") == "session-xyz"
