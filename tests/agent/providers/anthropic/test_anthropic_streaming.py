from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.agent.providers.anthropic import AnthropicProvider


class _FakeStreamResponse:
    status_code: int = 200

    def raise_for_status(self) -> None:
        return None

    async def aiter_lines(self) -> AsyncIterator[str]:
        lines = [
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_big","name":"write","input":{}}}',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"big.txt\\","}}',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"content\\":\\"hello"}}',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" world\\"}"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
        ]
        for line in lines:
            yield line


class _FakeStreamContext:
    async def __aenter__(self) -> _FakeStreamResponse:
        return _FakeStreamResponse()

    async def __aexit__(self, *_exc: object) -> None:
        return None


class _FakeAsyncClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    def stream(self, *args: Any, **kwargs: Any) -> _FakeStreamContext:
        return _FakeStreamContext()


@pytest.mark.asyncio
async def test_anthropic_stream_concatenates_large_tool_argument_deltas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.agent.providers.anthropic.anthropic as anthropic_module

    monkeypatch.setattr(anthropic_module.httpx, "AsyncClient", _FakeAsyncClient)
    provider = AnthropicProvider(api_key="sk-ant-test", model="claude-sonnet-4-6")

    chunks = [chunk async for chunk in provider.stream([], tools=[])]
    argument_deltas = [
        tool_delta.function.arguments
        for chunk in chunks
        for choice in chunk.choices
        for tool_delta in (choice.delta.tool_calls or [])
        if tool_delta.function and tool_delta.function.arguments
    ]

    assert argument_deltas == [
        '{"path":"big.txt",',
        '"content":"hello',
        ' world"}',
    ]
