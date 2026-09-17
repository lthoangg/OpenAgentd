"""Tests for quota wait and reset parsing across LLM providers."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.agent.agent_loop.retry import (
    MAX_QUOTA_WAIT_SECONDS,
    format_duration,
    parse_duration_string,
    parse_reset_timestamp,
    parse_retry_after,
    resolve_quota_reset_delay,
    stream_with_retry,
)
from app.agent.errors import ProviderRateLimitError
from app.agent.hooks.base import BaseAgentHook
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
)
from app.agent.state import AgentState, RunContext
from app.api.schemas.settings import (
    ProviderUsageLimit,
    ProviderUsageResponse,
    ProviderUsageWindow,
)


def make_chunk(text: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="c-1",
        created=1_000_000,
        model="test-model",
        choices=[
            ChatCompletionChunkChoice(index=0, delta=ChatCompletionDelta(content=text))
        ],
    )


def _http_429(
    body: str = "",
    headers: dict[str, str] | None = None,
) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://api.example.com/v1/chat")
    response = httpx.Response(
        429,
        content=body.encode(),
        headers=headers or {},
        request=request,
    )
    return httpx.HTTPStatusError(
        "429 Too Many Requests", request=request, response=response
    )


class DummyProvider(LLMProviderBase):
    provider_name = "test"

    def __init__(self):
        super().__init__()
        self.calls = 0

    async def stream(self, **kwargs):
        self.calls += 1
        yield make_chunk("ok")

    async def chat(self, messages, tools=None, **kwargs):
        return None


class TrackingHook(BaseAgentHook):
    def __init__(self):
        self.retries = []

    async def on_provider_retry(
        self,
        ctx,
        state,
        model,
        attempt,
        max_attempts,
        delay_seconds,
        error_type,
        status_code=None,
        retry_after=None,
        *,
        status="retrying",
        message=None,
        resets_at=None,
    ):
        self.retries.append(
            {
                "status": status,
                "delay_seconds": delay_seconds,
                "retry_after": retry_after,
                "message": message,
                "resets_at": resets_at,
                "attempt": attempt,
            }
        )


# ---------------------------------------------------------------------------
# 1. Duration Parsing Tests
# ---------------------------------------------------------------------------


def test_parse_duration_string_multi_unit():
    assert parse_duration_string("2 hours 15 minutes") == 8100.0
    assert parse_duration_string("2 hours and 15 minutes") == 8100.0
    assert parse_duration_string("2h 15m") == 8100.0
    assert parse_duration_string("2h15m") == 8100.0
    assert parse_duration_string("1h 30m 10s") == 5410.0
    assert parse_duration_string("6m0s") == 360.0


def test_parse_duration_string_single_unit():
    assert parse_duration_string("2 hours") == 7200.0
    assert parse_duration_string("45 minutes") == 2700.0
    assert parse_duration_string("45m") == 2700.0
    assert parse_duration_string("30 seconds") == 30.0
    assert parse_duration_string("11.054s") == 11.054
    assert parse_duration_string("250ms") == 0.25
    assert parse_duration_string("1.5 hours") == 5400.0
    assert parse_duration_string("1 day") == 86400.0


def test_parse_duration_string_invalid():
    assert parse_duration_string("no duration here") is None
    assert parse_duration_string("") is None


# ---------------------------------------------------------------------------
# 2. Reset Timestamp Parsing Tests
# ---------------------------------------------------------------------------


def test_parse_reset_timestamp_numeric():
    now = time.time()
    # Future epoch seconds
    target = now + 3600
    res = parse_reset_timestamp(target)
    assert res is not None
    assert 3598 <= res <= 3602

    # Future milliseconds
    res_ms = parse_reset_timestamp((now + 3600) * 1000)
    assert res_ms is not None
    assert 3598 <= res_ms <= 3602

    # Relative seconds
    assert parse_reset_timestamp(120) == 120


def test_parse_reset_timestamp_http_date():
    from email.utils import format_datetime

    now_dt = datetime.now(timezone.utc)
    from datetime import timedelta

    future_dt = now_dt + timedelta(seconds=1800)
    date_str = format_datetime(future_dt, usegmt=True)
    res = parse_reset_timestamp(date_str)
    assert res is not None
    assert 1798 <= res <= 1802


def test_parse_reset_timestamp_iso():
    from datetime import timedelta

    now_dt = datetime.now(timezone.utc)
    future_dt = now_dt + timedelta(seconds=2400)
    iso_str = future_dt.isoformat().replace("+00:00", "Z")
    res = parse_reset_timestamp(iso_str)
    assert res is not None
    assert 2398 <= res <= 2402


# ---------------------------------------------------------------------------
# 3. format_duration Tests
# ---------------------------------------------------------------------------


def test_format_duration():
    assert format_duration(7200) == "2h 00m"
    assert format_duration(8100) == "2h 15m"
    assert format_duration(90) == "1m 30s"
    assert format_duration(45) == "45s"
    assert format_duration(90000) == "1d 1h"


# ---------------------------------------------------------------------------
# 4. parse_retry_after Tests Across Providers
# ---------------------------------------------------------------------------


def test_parse_retry_after_headers():
    # Retry-After numeric
    assert parse_retry_after(_http_429(headers={"retry-after": "7200"})) == 7200

    # x-ratelimit-reset (Copilot / GitHub epoch seconds)
    target_epoch = int(time.time()) + 1500
    res = parse_retry_after(_http_429(headers={"x-ratelimit-reset": str(target_epoch)}))
    assert 1498 <= res <= 1502

    # anthropic-ratelimit-requests-reset (ISO)
    from datetime import timedelta

    iso_str = (datetime.now(timezone.utc) + timedelta(seconds=600)).isoformat()
    res_anthropic = parse_retry_after(
        _http_429(headers={"anthropic-ratelimit-requests-reset": iso_str})
    )
    assert 598 <= res_anthropic <= 602

    # x-ratelimit-reset-requests (OpenAI / Codex duration)
    assert (
        parse_retry_after(_http_429(headers={"x-ratelimit-reset-requests": "2h15m"}))
        == 8100
    )


def test_parse_retry_after_json_body():
    # Google API retryDelay
    body_google = '{"error": {"details": [{"metadata": {"retryDelay": "120s"}}]}}'
    assert parse_retry_after(_http_429(body=body_google)) == 120

    # JSON reset_after_seconds
    body_seconds = '{"error": {"reset_after_seconds": 3600}}'
    assert parse_retry_after(_http_429(body=body_seconds)) == 3600

    # JSON resets_at timestamp
    target_epoch = int(time.time()) + 5000
    body_resets_at = f'{{"error": {{"resets_at": {target_epoch}}}}}'
    res = parse_retry_after(_http_429(body=body_resets_at))
    assert 4998 <= res <= 5002


def test_parse_retry_after_text_phrasing():
    assert (
        parse_retry_after(
            _http_429("Rate limit exceeded. Please try again in 2 hours 15 minutes.")
        )
        == 8100
    )
    assert parse_retry_after(_http_429("Usage limit reached. Reset in 1h 30m")) == 5400
    assert (
        parse_retry_after(_http_429("You have exceeded your quota. Resets in 2 hours."))
        == 7200
    )
    assert parse_retry_after(_http_429("Quota resets in 45m")) == 2700
    assert parse_retry_after(_http_429("Please try again in 11.054s.")) == 11


# ---------------------------------------------------------------------------
# 5. resolve_quota_reset_delay Usage API Fallbacks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_quota_reset_delay_codex_usage_fallback(
    monkeypatch: pytest.MonkeyPatch,
):
    target_epoch = int(time.time()) + 7200
    fake_usage = ProviderUsageResponse(
        provider="codex",
        limits=[
            ProviderUsageLimit(
                limit_id="codex",
                plan_type="plus",
                primary=ProviderUsageWindow(used_percent=100.0, resets_at=target_epoch),
            )
        ],
    )
    monkeypatch.setattr(
        "app.agent.providers.codex.usage.get_usage", AsyncMock(return_value=fake_usage)
    )

    provider = DummyProvider()
    provider.provider_name = "codex"

    exc = _http_429(body="Quota exceeded without inline time.")
    delay = await resolve_quota_reset_delay(
        exc, provider=provider, provider_label="codex:gpt-5.4"
    )
    assert 7198 <= delay <= 7202


@pytest.mark.asyncio
async def test_resolve_quota_reset_delay_copilot_usage_fallback(
    monkeypatch: pytest.MonkeyPatch,
):
    target_epoch = int(time.time()) + 3600
    fake_usage = ProviderUsageResponse(
        provider="copilot",
        limits=[
            ProviderUsageLimit(
                limit_id="copilot",
                plan_type="copilot_individual",
                primary=ProviderUsageWindow(used_percent=100.0, resets_at=target_epoch),
            )
        ],
    )
    monkeypatch.setattr(
        "app.agent.providers.copilot.usage.get_usage",
        AsyncMock(return_value=fake_usage),
    )

    provider = DummyProvider()
    provider.provider_name = "copilot"

    exc = _http_429(body="Quota exceeded without inline time.")
    delay = await resolve_quota_reset_delay(
        exc, provider=provider, provider_label="copilot:claude-sonnet-4"
    )
    assert 3598 <= delay <= 3602


@pytest.mark.asyncio
async def test_resolve_quota_reset_delay_grok_usage_fallback(
    monkeypatch: pytest.MonkeyPatch,
):
    target_epoch = int(time.time()) + 1800
    fake_usage = ProviderUsageResponse(
        provider="grok",
        limits=[
            ProviderUsageLimit(
                limit_id="grok_build",
                primary=ProviderUsageWindow(used_percent=100.0, resets_at=target_epoch),
            )
        ],
    )
    monkeypatch.setattr(
        "app.agent.providers.grok.usage.get_usage", AsyncMock(return_value=fake_usage)
    )

    provider = DummyProvider()
    provider.provider_name = "grok"

    exc = _http_429(body="Quota exceeded without inline time.")
    delay = await resolve_quota_reset_delay(
        exc, provider=provider, provider_label="grok:grok-4.5"
    )
    assert 1798 <= delay <= 1802


# ---------------------------------------------------------------------------
# 6. stream_with_retry Quota Wait & Auto-Resume
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_with_retry_quota_wait_and_resume():
    """When 429 has a reset time > 60s, stream_with_retry waits for reset and resumes work."""
    calls = 0

    class QuotaProvider(LLMProviderBase):
        provider_name = "test-oauth"

        async def stream(self, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                # 429 quota exhausted with 2-hour reset notice
                raise _http_429("Usage limit reached. Try again in 2 hours.")
                yield make_chunk("")
            yield make_chunk("work completed after reset")

        async def chat(self, messages, tools=None, **kwargs):
            return None

    provider = QuotaProvider()
    hook = TrackingHook()
    ctx = RunContext(session_id="s1", run_id="r1", agent_name="test-agent")
    state = AgentState(messages=[])

    with patch(
        "app.agent.agent_loop.retry.asyncio.sleep", new_callable=AsyncMock
    ) as mock_sleep:
        # Advance fake clock during sleep
        async def fake_sleep(d):
            return None

        mock_sleep.side_effect = fake_sleep

        with patch("app.agent.agent_loop.retry.time.time") as mock_time:
            current_t = 1_000_000.0

            def get_t():
                nonlocal current_t
                # Simulate passing time on consecutive calls
                current_t += 3600.0
                return current_t

            mock_time.side_effect = get_t

            chunks = [
                c
                async for c in stream_with_retry(
                    primary_provider=provider,
                    primary_label="test:model",
                    ctx=ctx,
                    state=state,
                    hooks=[hook],
                )
            ]

    assert calls == 2
    assert len(chunks) == 1
    assert chunks[0].choices[0].delta.content == "work completed after reset"
    assert len(hook.retries) >= 1
    quota_retry = hook.retries[0]
    assert quota_retry["status"] == "waiting_quota"
    assert quota_retry["retry_after"] == 7200
    assert "Waiting 2h 00m for reset" in quota_retry["message"]


@pytest.mark.asyncio
async def test_stream_with_retry_quota_wait_user_interrupt():
    """User interrupt stops the quota wait immediately."""
    calls = 0
    interrupt_event = asyncio.Event()

    class QuotaProvider(LLMProviderBase):
        provider_name = "test-oauth"

        async def stream(self, **kwargs):
            nonlocal calls
            calls += 1
            interrupt_event.set()  # user clicked stop during first attempt / wait
            raise _http_429("Usage limit reached. Try again in 2 hours.")
            yield make_chunk("")

        async def chat(self, messages, tools=None, **kwargs):
            return None

    provider = QuotaProvider()

    chunks = [
        c
        async for c in stream_with_retry(
            primary_provider=provider,
            primary_label="test:model",
            ctx=None,
            state=None,
            hooks=[],
            interrupt_event=interrupt_event,
        )
    ]

    assert chunks == []
    assert calls == 1


@pytest.mark.asyncio
async def test_stream_with_retry_quota_wait_exceeds_max():
    """Reset delay exceeding MAX_QUOTA_WAIT_SECONDS raises ProviderRateLimitError immediately."""

    class FarFutureProvider(LLMProviderBase):
        provider_name = "test"

        async def stream(self, **kwargs):
            # Exceeds max auto-wait threshold
            raise _http_429(headers={"retry-after": str(MAX_QUOTA_WAIT_SECONDS + 3600)})
            yield make_chunk("")

        async def chat(self, messages, tools=None, **kwargs):
            return None

    with pytest.raises(ProviderRateLimitError) as exc_info:
        async for _ in stream_with_retry(
            primary_provider=FarFutureProvider(),
            primary_label="test:model",
            ctx=None,
            state=None,
            hooks=[],
        ):
            pass

    assert "exceeds the maximum auto-wait" in str(exc_info.value)


@pytest.mark.asyncio
async def test_stream_with_retry_unresolvable_quota_429_raises():
    """Quota marker without identifiable reset time breaks and raises ProviderRateLimitError."""

    class UnresolvableProvider(LLMProviderBase):
        provider_name = "test"

        async def stream(self, **kwargs):
            # Has quota marker but no numbers/time
            raise _http_429(body='{"error": {"type": "usage_limit_reached"}}')
            yield make_chunk("")

        async def chat(self, messages, tools=None, **kwargs):
            return None

    with pytest.raises(ProviderRateLimitError) as exc_info:
        async for _ in stream_with_retry(
            primary_provider=UnresolvableProvider(),
            primary_label="test:model",
            ctx=None,
            state=None,
            hooks=[],
        ):
            pass

    assert "rate-limited or quota-exhausted" in str(exc_info.value)
