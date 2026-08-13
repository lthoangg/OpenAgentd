import json

import pytest

from app.agent.providers.anthropic.anthropic import AnthropicProvider
from app.agent.schemas.chat import HumanMessage


class _FakeResponse:
    status_code: int = 200

    def raise_for_status(self) -> None:
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def aiter_lines(self):
        yield "data: " + json.dumps(
            {
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 3,
                        "cache_read_input_tokens": 9132,
                        "cache_creation_input_tokens": 24,
                        "output_tokens": 0,
                    }
                },
            }
        )
        yield "data: " + json.dumps(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "OK"},
            }
        )
        yield "data: " + json.dumps(
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 5},
            }
        )
        yield "data: [DONE]"


class _FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def stream(self, *args, **kwargs):
        return _FakeResponse()


@pytest.mark.asyncio
async def test_anthropic_stream_usage_counts_cache_read_and_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.agent.providers.anthropic.anthropic.httpx.AsyncClient", _FakeClient
    )

    provider = AnthropicProvider(
        api_key="test-key",
        model="claude-sonnet-4-6",
    )

    chunks = [chunk async for chunk in provider.stream([HumanMessage(content="hi")])]
    usage_chunks = [chunk for chunk in chunks if chunk.usage is not None]

    assert usage_chunks
    usage = usage_chunks[-1].usage
    assert usage is not None
    assert usage.prompt_tokens == 9159
    assert usage.cached_tokens == 9132
    # Cache creation is priced separately from both fresh input and cache
    # reads, so it has to survive as its own count rather than being folded
    # into prompt_tokens and lost.
    assert usage.cache_write_tokens == 24
    assert usage.completion_tokens == 5
    assert usage.total_tokens == 9164
