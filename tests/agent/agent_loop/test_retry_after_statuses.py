"""``Retry-After`` must be honoured for every retryable status, not just 429.

``_STREAM_ERROR_STATUS`` in the Anthropic provider maps ``overloaded_error`` to
529 specifically so ``stream_with_retry`` applies "the same retry budget,
backoff, Retry-After parsing, and user-facing classification" it gives HTTP
errors.  ``Retry-After`` parsing was in fact gated behind ``status_code == 429``,
so a 529 or 503 carrying the header was ignored and the exponential fallback
used instead.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from app.agent.agent_loop.retry import stream_with_retry


def _http_error(
    status: int, *, retry_after: str | None = None
) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://example.test/v1/messages")
    headers = {"content-type": "application/json"}
    if retry_after is not None:
        headers["retry-after"] = retry_after
    response = httpx.Response(
        status,
        content=b'{"error":{"message":"nope"}}',
        headers=headers,
        request=request,
    )
    return httpx.HTTPStatusError(f"HTTP {status}", request=request, response=response)


class _AlwaysFailing:
    """Provider whose stream raises the same retryable error every attempt."""

    def __init__(self, exc: httpx.HTTPStatusError) -> None:
        self._exc = exc

    async def stream(self, **_kwargs) -> AsyncIterator:  # pragma: no cover - raises
        raise self._exc
        yield  # unreachable, keeps this an async generator


async def _collect_delays(
    monkeypatch: pytest.MonkeyPatch, exc: httpx.HTTPStatusError
) -> list[float]:
    delays: list[float] = []

    async def fake_sleep(delay: float) -> None:
        delays.append(delay)

    monkeypatch.setattr("app.agent.agent_loop.retry.asyncio.sleep", fake_sleep)

    with pytest.raises(Exception):
        async for _ in stream_with_retry(
            primary_provider=_AlwaysFailing(exc),  # type: ignore[arg-type]
            primary_label="claude:claude-sonnet-5",
            ctx=None,
            state=None,
            hooks=None,
            messages=[],
            tools=[],
        ):
            pass
    return delays


@pytest.mark.parametrize("status", [529, 503, 500, 502, 504])
async def test_retry_after_header_is_honoured_for_retryable_statuses(
    status: int, monkeypatch: pytest.MonkeyPatch
):
    delays = await _collect_delays(monkeypatch, _http_error(status, retry_after="7"))
    assert delays, "a retryable status must produce at least one backoff"
    assert all(d == 7.0 for d in delays), (
        f"HTTP {status} ignored its Retry-After header: {delays}"
    )


async def test_missing_retry_after_still_uses_jittered_backoff(
    monkeypatch: pytest.MonkeyPatch,
):
    """Without the header, the exponential fallback (jittered) still applies."""
    delays = await _collect_delays(monkeypatch, _http_error(529))
    assert delays
    assert all(0 < d <= 27.0 for d in delays)
    assert any(d != 1.0 for d in delays), "backoff should grow, not stay flat"
