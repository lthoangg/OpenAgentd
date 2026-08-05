"""Anthropic emits mid-stream failures as an SSE ``{"type":"error"}`` frame on an
otherwise-``200 OK`` connection.  Those frames used to fall straight through the
event dispatcher's ``elif`` chain and be silently discarded, so the stream simply
ended: the caller got an empty ``AssistantMessage`` with no usage and no error,
and the agent loop treated it as a successful "model chose to say nothing" turn.

These tests pin the frame down to a typed, retryable ``httpx.HTTPStatusError``
carrying the upstream error type/message, so ``stream_with_retry`` can classify
and retry it exactly like a real HTTP-level failure.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.agent.providers.anthropic import AnthropicProvider


def _client_yielding(lines: list[str]) -> type:
    """Build a fake httpx.AsyncClient whose stream replays ``lines``."""

    class _Response:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        async def aread(self) -> bytes:
            return b""

        async def aiter_lines(self) -> AsyncIterator[str]:
            for line in lines:
                yield line

    class _StreamContext:
        async def __aenter__(self) -> _Response:
            return _Response()

        async def __aexit__(self, *_exc: object) -> None:
            return None

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *_exc: object) -> None:
            return None

        def stream(self, *args: Any, **kwargs: Any) -> _StreamContext:
            return _StreamContext()

    return _Client


async def test_stream_raises_on_overloaded_error_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An ``overloaded_error`` frame must raise as a retryable HTTP 529."""
    import app.agent.providers.anthropic.anthropic as anthropic_module

    monkeypatch.setattr(
        anthropic_module.httpx,
        "AsyncClient",
        _client_yielding(
            [
                'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            ]
        ),
    )
    provider = AnthropicProvider(api_key="[REDACTED]", model="claude-sonnet-4-6")

    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        [chunk async for chunk in provider.stream([], tools=[])]

    assert excinfo.value.response.status_code == 529
    assert "overloaded_error" in str(excinfo.value)
    assert "Overloaded" in str(excinfo.value)


async def test_stream_error_frame_after_partial_content_still_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stream that errors *after* emitting text must not be reported as a
    clean, complete turn — the truncated content is worse than an error."""
    import app.agent.providers.anthropic.anthropic as anthropic_module

    monkeypatch.setattr(
        anthropic_module.httpx,
        "AsyncClient",
        _client_yielding(
            [
                'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}',
                'data: {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
            ]
        ),
    )
    provider = AnthropicProvider(api_key="[REDACTED]", model="claude-sonnet-4-6")

    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        [chunk async for chunk in provider.stream([], tools=[])]

    assert excinfo.value.response.status_code == 500
    assert "api_error" in str(excinfo.value)


async def test_stream_maps_invalid_request_error_to_non_retryable_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A client-fault frame must map to 400 so retry logic fails fast instead of
    burning the full backoff budget on a request that can never succeed."""
    import app.agent.providers.anthropic.anthropic as anthropic_module

    monkeypatch.setattr(
        anthropic_module.httpx,
        "AsyncClient",
        _client_yielding(
            [
                'data: {"type":"error","error":{"type":"invalid_request_error","message":"too many tokens"}}',
            ]
        ),
    )
    provider = AnthropicProvider(api_key="[REDACTED]", model="claude-sonnet-4-6")

    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        [chunk async for chunk in provider.stream([], tools=[])]

    assert excinfo.value.response.status_code == 400


async def test_overloaded_frame_is_retried_then_surfaced_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end reproduction of the production silent-failure.

    An overloaded frame on every attempt must exhaust ``stream_with_retry``'s
    budget and then propagate, rather than yielding zero chunks and letting the
    caller mistake an upstream outage for an empty model response.
    """
    import app.agent.providers.anthropic.anthropic as anthropic_module
    from app.agent.agent_loop.retry import MAX_RETRIES, stream_with_retry

    attempts = 0

    class _CountingClient(
        _client_yielding(
            [
                'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            ]
        )  # type: ignore[misc]
    ):
        def stream(self, *args: Any, **kwargs: Any):
            nonlocal attempts
            attempts += 1
            return super().stream(*args, **kwargs)

    monkeypatch.setattr(anthropic_module.httpx, "AsyncClient", _CountingClient)
    # Never sleep for real in tests — collapse the backoff.
    monkeypatch.setattr(
        "app.agent.agent_loop.retry.asyncio.sleep",
        _immediate_sleep,
    )
    provider = AnthropicProvider(api_key="[REDACTED]", model="claude-sonnet-4-6")

    chunks = []
    with pytest.raises(httpx.HTTPStatusError):
        async for chunk in stream_with_retry(
            primary_provider=provider,
            primary_label="claude:claude-sonnet-4-6",
            ctx=None,
            state=None,
            hooks=None,
            messages=[],
            tools=[],
        ):
            chunks.append(chunk)

    assert chunks == [], "an overloaded stream must not yield content"
    assert attempts == MAX_RETRIES, "transient overload should exhaust the budget"


async def _immediate_sleep(_delay: float) -> None:
    return None


async def test_stream_error_frame_body_is_readable_by_retry_classifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``stream_with_retry`` reads ``exc.response.text`` to build the user-facing
    message, so the synthetic response must carry the original JSON body."""
    import app.agent.providers.anthropic.anthropic as anthropic_module
    from app.agent.agent_loop.retry import classify_provider_http_error

    monkeypatch.setattr(
        anthropic_module.httpx,
        "AsyncClient",
        _client_yielding(
            [
                'data: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}',
            ]
        ),
    )
    provider = AnthropicProvider(api_key="[REDACTED]", model="claude-sonnet-4-6")

    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        [chunk async for chunk in provider.stream([], tools=[])]

    classified = classify_provider_http_error(
        excinfo.value, provider_label="claude:claude-sonnet-4-6"
    )
    assert "prompt is too long" in str(classified)
