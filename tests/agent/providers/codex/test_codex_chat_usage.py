"""``CodexProvider.chat`` drained its own stream but discarded the usage that the
stream reports, so every non-streaming Codex call (title generation, the settings
connection test) reported zero tokens regardless of what was actually billed.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    HumanMessage,
)
from app.agent.usage import Usage


def _chunk(
    content: str | None = None, usage: Usage | None = None
) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk-1",
        created=1_000_000,
        model="gpt-5.4",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content=content),
                finish_reason=None,
            )
        ],
        usage=usage,
    )


async def test_chat_surfaces_usage_reported_by_the_stream() -> None:
    from app.agent.providers.codex.codex import _CodexResponsesHandler

    handler = _CodexResponsesHandler.__new__(_CodexResponsesHandler)

    def _fake_stream(
        _messages: Any, _tools: Any, _merged: Any
    ) -> AsyncIterator[ChatCompletionChunk]:
        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            yield _chunk(content="Hello")
            yield _chunk(
                usage=Usage(prompt_tokens=11, completion_tokens=7, total_tokens=18)
            )

        return _gen()

    handler.stream = _fake_stream  # type: ignore[method-assign]
    handler.model = "gpt-5.4"

    msg = await handler.chat([HumanMessage(content="Hi")], None, {})

    assert msg.content == "Hello"
    assert (msg.extra or {}).get("usage", {}).get("input") == 11
    assert (msg.extra or {}).get("usage", {}).get("output") == 7


async def test_chat_without_usage_reports_none_rather_than_fabricating_zeros() -> None:
    from app.agent.providers.codex.codex import _CodexResponsesHandler

    handler = _CodexResponsesHandler.__new__(_CodexResponsesHandler)

    def _fake_stream(
        _messages: Any, _tools: Any, _merged: Any
    ) -> AsyncIterator[ChatCompletionChunk]:
        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            yield _chunk(content="Hello")

        return _gen()

    handler.stream = _fake_stream  # type: ignore[method-assign]
    handler.model = "gpt-5.4"

    msg = await handler.chat([HumanMessage(content="Hi")], None, {})

    assert msg.content == "Hello"
    assert "usage" not in (msg.extra or {})
