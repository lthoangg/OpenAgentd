"""Diagnostic logging for Anthropic 400 rejections.

Recurring production incidents ("thinking or redacted_thinking blocks in the
latest assistant message cannot be modified", HTTP 400) have never been
reproducible from persisted session history: an exhaustive DB-wide scan found
no assistant message with anywhere near the block count in the error index,
in any session, ever. That means the corrupted payload only ever existed live,
in memory, at request time — and today the code discards it. ``payload`` is
built and in scope right where ``response.status_code >= 400`` is checked, but
nothing about its shape is ever logged before the exception propagates.

These tests pin down a structural (role + content-block-type list per
message) summary logged at WARNING on a 400/4xx response, *before* raising —
bounded and free of tool-output/user-content text, so the next real occurrence
gives the actual wire shape instead of another guess.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.agent.providers.anthropic import AnthropicProvider
from app.agent.schemas.chat import AssistantMessage, HumanMessage, ToolCall, ToolMessage
from app.agent.schemas.chat import FunctionCall as FC


def _client_returning_400(body: bytes) -> type:
    class _Response:
        status_code = 400

        def raise_for_status(self) -> None:
            request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
            response = httpx.Response(400, request=request, content=body)
            raise httpx.HTTPStatusError(
                "Client error '400 Bad Request'", request=request, response=response
            )

        async def aread(self) -> bytes:
            return body

        async def aiter_lines(self) -> AsyncIterator[str]:
            return
            yield  # pragma: no cover - never reached; makes this an async generator

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


_ERROR_BODY = (
    b'{"type":"error","error":{"type":"invalid_request_error",'
    b'"message":"messages.1.content.2: `thinking` or `redacted_thinking` '
    b'blocks in the latest assistant message cannot be modified."}}'
)


async def test_stream_logs_payload_shape_on_400_before_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.agent.providers.anthropic.anthropic as anthropic_module

    monkeypatch.setattr(
        anthropic_module.httpx,
        "AsyncClient",
        _client_returning_400(_ERROR_BODY),
    )
    provider = AnthropicProvider(api_key="[REDACTED]", model="claude-sonnet-4-6")

    assistant = AssistantMessage(
        content=None,
        tool_calls=[ToolCall(id="t1", function=FC(name="read", arguments="{}"))],
    )
    assistant.raw_content_blocks = [
        {"type": "thinking", "thinking": "check the file", "signature": "sig-1"},
        {"type": "tool_use_ref", "id": "t1"},
    ]

    with pytest.MonkeyPatch().context() as mp:
        logged: list[tuple[tuple, dict]] = []
        real_warning = anthropic_module.logger.warning

        def _capture(*args: object, **kwargs: object) -> None:
            logged.append((args, kwargs))
            return real_warning(*args, **kwargs)

        mp.setattr(anthropic_module.logger, "warning", _capture)

        with pytest.raises(httpx.HTTPStatusError):
            [
                chunk
                async for chunk in provider.stream(
                    [
                        HumanMessage(content="go"),
                        assistant,
                        ToolMessage(
                            content="file contents", tool_call_id="t1", name="read"
                        ),
                    ],
                    tools=[],
                )
            ]

    matches = [c for c in logged if "anthropic_400_request_shape" in c[0][0]]
    assert matches, (
        "a 400 response must log the outgoing payload's structural shape "
        f"before raising; captured warnings: {logged}"
    )
    call_args = matches[0][0]
    # message_index 1 == the assistant turn; block_types must show the exact
    # per-message block-type sequence (not raw content) that was sent.
    assert call_args[1] == 400
    shapes = call_args[-1]
    assert isinstance(shapes, list)
    assert shapes[1]["role"] == "assistant"
    assert shapes[1]["block_types"] == ["thinking", "tool_use"]


def _client_post_returning_400(body: bytes) -> type:
    class _Response:
        status_code = 400

        def raise_for_status(self) -> None:
            request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
            response = httpx.Response(400, request=request, content=body)
            raise httpx.HTTPStatusError(
                "Client error '400 Bad Request'", request=request, response=response
            )

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *_exc: object) -> None:
            return None

        async def post(self, *args: Any, **kwargs: Any) -> _Response:
            return _Response()

    return _Client


async def test_chat_logs_payload_shape_on_400_before_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same guard for the non-streaming ``chat()`` path (used by title
    generation, connectivity probes, etc.)."""
    import app.agent.providers.anthropic.anthropic as anthropic_module

    monkeypatch.setattr(
        anthropic_module.httpx,
        "AsyncClient",
        _client_post_returning_400(_ERROR_BODY),
    )
    provider = AnthropicProvider(api_key="[REDACTED]", model="claude-sonnet-4-6")

    assistant = AssistantMessage(
        content=None,
        tool_calls=[ToolCall(id="t1", function=FC(name="read", arguments="{}"))],
    )
    assistant.raw_content_blocks = [
        {"type": "thinking", "thinking": "check the file", "signature": "sig-1"},
        {"type": "tool_use_ref", "id": "t1"},
    ]

    logged: list[tuple] = []
    real_warning = anthropic_module.logger.warning
    monkeypatch.setattr(
        anthropic_module.logger,
        "warning",
        lambda *a, **kw: (logged.append(a), real_warning(*a, **kw))[1],
    )

    with pytest.raises(httpx.HTTPStatusError):
        await provider.chat(
            [
                HumanMessage(content="go"),
                assistant,
                ToolMessage(content="file contents", tool_call_id="t1", name="read"),
            ],
            tools=[],
        )

    matches = [c for c in logged if "anthropic_400_request_shape" in c[0]]
    assert matches, f"chat() must also log request shape on 400; got {logged}"
    assert matches[0][1] == 400
    assert matches[0][-1][1]["block_types"] == ["thinking", "tool_use"]
