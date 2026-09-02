"""Tests verifying agent resilience against transient network blips and connectivity drops.

A network blip lasting a few seconds may manifest as connection timeouts, DNS
lookup failures (gaierror), connection resets/aborts, socket timeouts, TLS
handshake errors, remote disconnects, or 5xx/408 gateway errors.

The agent should automatically retry with jittered backoff, resume the turn
when needed, and continue smoothly once connectivity is restored.
"""

from __future__ import annotations

import http.client
import socket
import ssl
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.agent.agent_loop import Agent
from app.agent.agent_loop.retry import (
    MAX_RETRIES,
    TRANSIENT_NETWORK_ERRORS,
    _is_retryable_http_error,
    is_transient_network_error,
    stream_with_retry,
)
from app.agent.hooks.summarization import CODING_SUMMARY_PROMPT, SummarizationHook
from app.agent.providers.base import LLMProviderBase
from app.agent.state import RunContext
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatMessage,
    HumanMessage,
)
from tests.agent.test_agent_run import make_text_chunk


class ScriptedErrorProvider(LLMProviderBase):
    """Provider that raises a list of exceptions before succeeding."""

    model = "mock-model"

    def __init__(
        self,
        errors: list[Exception],
        success_chunks: list[ChatCompletionChunk] | None = None,
    ):
        super().__init__()
        self._errors = list(errors)
        self._success_chunks = success_chunks or [make_text_chunk("recovered output")]
        self.call_count = 0

    async def stream(self, **_kwargs) -> AsyncIterator[ChatCompletionChunk]:
        self.call_count += 1
        if self._errors:
            err = self._errors.pop(0)
            raise err
        for chunk in self._success_chunks:
            yield chunk

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        chunks = [c async for c in self.stream()]
        content = "".join(c.choices[0].delta.content or "" for c in chunks if c.choices)
        return AssistantMessage(content=content)


@pytest.mark.parametrize(
    "network_exc",
    [
        httpx.ConnectTimeout("Connection timed out during handshake"),
        httpx.WriteTimeout("Timed out sending request body"),
        httpx.PoolTimeout("Timed out acquiring pool connection"),
        httpx.WriteError("Socket write error"),
        httpx.NetworkError("Underlying network transport failure"),
        httpx.LocalProtocolError("Local protocol error"),
        ConnectionResetError("[Errno 54] Connection reset by peer"),
        ConnectionRefusedError("[Errno 61] Connection refused"),
        ConnectionAbortedError("Connection aborted"),
        BrokenPipeError("[Errno 32] Broken pipe"),
        socket.gaierror(-2, "Name or service not known"),
        socket.timeout("Socket timed out"),
        ssl.SSLError("SSL handshake EOF"),
        http.client.RemoteDisconnected("Remote end closed connection without response"),
        TimeoutError("General async timeout"),
    ],
)
async def test_stream_with_retry_recovers_from_transient_network_errors(
    network_exc: Exception,
):
    """stream_with_retry recovers after encountering a transient network exception."""
    provider = ScriptedErrorProvider([network_exc])

    with patch(
        "app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock
    ) as mock_sleep:
        chunks = [
            c
            async for c in stream_with_retry(
                primary_provider=provider,
                primary_label="mock-model",
                ctx=None,
                state=None,
                hooks=None,
                messages=[],
                tools=None,
            )
        ]

    assert provider.call_count == 2
    assert mock_sleep.await_count == 1
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "recovered output"


@pytest.mark.parametrize(
    "status_code", [408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]
)
def test_is_retryable_http_error_includes_gateway_and_timeout_statuses(
    status_code: int,
):
    """_is_retryable_http_error classifies transient server, gateway, and timeout codes as retryable."""
    req = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    resp = httpx.Response(status_code, request=req)
    exc = httpx.HTTPStatusError(f"HTTP {status_code}", request=req, response=resp)
    assert _is_retryable_http_error(exc) is True


async def test_stream_with_retry_exhausted_on_prolonged_disconnect():
    """When a network disconnect exceeds MAX_RETRIES, stream_with_retry re-raises."""
    exc = httpx.ConnectTimeout("Network unreachable")
    provider = ScriptedErrorProvider([exc] * (MAX_RETRIES + 1))

    with patch(
        "app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock
    ) as mock_sleep:
        with pytest.raises(httpx.ConnectTimeout):
            async for _ in stream_with_retry(
                primary_provider=provider,
                primary_label="mock-model",
                ctx=None,
                state=None,
                hooks=None,
                messages=[],
                tools=None,
            ):
                pass

    assert provider.call_count == MAX_RETRIES
    assert mock_sleep.await_count == MAX_RETRIES - 1


async def test_transient_network_errors_tuple_contains_all_expected_types():
    """TRANSIENT_NETWORK_ERRORS includes all relevant connection and transport exceptions."""
    for exc in (
        httpx.ConnectTimeout("timeout"),
        httpx.WriteTimeout("timeout"),
        httpx.ReadTimeout("timeout"),
        httpx.PoolTimeout("timeout"),
        httpx.ConnectError("connect"),
        httpx.ReadError("read"),
        httpx.WriteError("write"),
        httpx.NetworkError("network"),
        httpx.RemoteProtocolError("remote"),
        httpx.LocalProtocolError("local"),
        ConnectionResetError("reset"),
        ConnectionRefusedError("refused"),
        ConnectionAbortedError("aborted"),
        BrokenPipeError("pipe"),
        socket.gaierror(-2, "DNS error"),
        socket.timeout("timeout"),
        ssl.SSLError("ssl"),
        http.client.RemoteDisconnected("disconnected"),
        TimeoutError("timeout"),
    ):
        assert isinstance(exc, TRANSIENT_NETWORK_ERRORS), (
            f"{type(exc)} must be in TRANSIENT_NETWORK_ERRORS"
        )


@pytest.mark.parametrize(
    "exc",
    [
        ssl.SSLCertVerificationError("certificate verify failed"),
        httpx.UnsupportedProtocol("Request URL is missing an 'http://' scheme"),
        httpx.DecodingError("bad gzip"),
    ],
    ids=["cert-verify", "unsupported-protocol", "decoding"],
)
def test_configuration_errors_are_not_treated_as_transient(exc: Exception):
    """Cert failures and malformed URLs are misconfiguration, not blips.

    They are subclasses of the broad transient families (``ssl.SSLError``,
    ``httpx.RequestError``) so a bare ``except`` would retry them for the full
    backoff budget before surfacing a problem that will never fix itself.
    """
    assert isinstance(exc, TRANSIENT_NETWORK_ERRORS)
    assert is_transient_network_error(exc) is False
    assert is_transient_network_error(httpx.ConnectTimeout("blip")) is True


async def test_stream_with_retry_fails_fast_on_cert_verification_error():
    provider = ScriptedErrorProvider(
        [ssl.SSLCertVerificationError("certificate verify failed")] * MAX_RETRIES
    )

    with patch(
        "app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock
    ) as mock_sleep:
        with pytest.raises(ssl.SSLCertVerificationError):
            async for _ in stream_with_retry(
                primary_provider=provider,
                primary_label="mock-model",
                ctx=None,
                state=None,
                hooks=None,
                messages=[],
                tools=None,
            ):
                pass

    assert provider.call_count == 1
    assert mock_sleep.await_count == 0


@pytest.mark.parametrize("status_code", [501, 505])
def test_is_retryable_http_error_excludes_permanent_5xx(status_code: int):
    """501 Not Implemented / 505 HTTP Version Not Supported never recover on retry."""
    req = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    resp = httpx.Response(status_code, request=req)
    exc = httpx.HTTPStatusError(f"HTTP {status_code}", request=req, response=resp)
    assert _is_retryable_http_error(exc) is False


async def test_summarization_hook_recovers_from_network_blip():
    """SummarizationHook survives a transient network error during compaction."""
    provider = ScriptedErrorProvider(
        [httpx.ConnectTimeout("Temporary network glitch")],
        success_chunks=[make_text_chunk("Compacted summary content.")],
    )
    hook = SummarizationHook(
        llm_provider=provider,
        prompt_token_threshold=100,
        summary_prompt=CODING_SUMMARY_PROMPT,
    )

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        ctx = RunContext(
            session_id="test-session", run_id="test-run", agent_name="test-agent"
        )
        summary, _ = await hook._call_llm(
            ctx=ctx,
            messages=[HumanMessage(content="Hello")],
            tools=[],
        )

    assert summary == "Compacted summary content."
    assert provider.call_count == 2


async def test_agent_run_recovers_from_network_blip_seamlessly():
    """An Agent turn runs successfully across a transient network error."""
    provider = ScriptedErrorProvider(
        [httpx.ConnectTimeout("temporary disconnect")],
        success_chunks=[make_text_chunk("Hello from agent!")],
    )
    agent = Agent(llm_provider=provider)

    with patch("app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock):
        response = await agent.run([HumanMessage(content="Hi")])

    assert response[-1].content == "Hello from agent!"
    assert provider.call_count == 2
