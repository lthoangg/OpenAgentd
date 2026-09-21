"""Retry streaming for LLM provider calls.

Wraps a provider's ``stream()`` so transient errors (429, 5xx, connection,
and read errors) that surface mid-stream are retried from the beginning.
Non-retryable HTTP errors (4xx except 429) are raised immediately.

Lives outside the :class:`~app.agent.agent_loop.Agent` class because
none of this depends on instance state — only the provider and a label
for logging.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import email.utils
import http.client
import json
import random
import re
import socket
import ssl
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Literal

import httpx
from loguru import logger

from app.agent.errors import (
    ProviderAuthenticationError,
    ProviderRateLimitError,
    ProviderRequestError,
)

if TYPE_CHECKING:
    from app.agent.hooks import BaseAgentHook
    from app.agent.providers.base import LLMProviderBase
    from app.agent.state import AgentState, RunContext


# Public retry budget.  Tests reference this directly to assert that
# ``stream_with_retry`` performed exactly ``MAX_RETRIES`` attempts before
# raising.
MAX_RETRIES = 5

# Maximum seconds to wait for a provider quota reset (24 hours).
MAX_QUOTA_WAIT_SECONDS = 86_400
# Maximum consecutive quota wait attempts before raising ProviderRateLimitError.
MAX_QUOTA_WAITS = 3
# Safety buffer added to reset wait delay to avoid waking before provider clock rolls over.
CLOCK_SKEW_BUFFER_SECONDS = 2.0

# Transient transport and socket errors indicating network blips, connection
# resets, DNS failures, or timeouts that should be retried automatically. These
# are broad families; ``is_transient_network_error`` vetoes the members that
# are misconfiguration rather than weather. (``socket.timeout`` is an alias of
# ``TimeoutError`` and ``ssl.SSLError`` an ``OSError``, so both are covered.)
TRANSIENT_NETWORK_ERRORS = (
    httpx.RequestError,
    ConnectionError,
    TimeoutError,
    socket.gaierror,
    socket.herror,
    ssl.SSLError,
    http.client.HTTPException,
)

# Subclasses of the families above that will never succeed on retry: a cert
# that fails verification, a base URL without a scheme, a body the client
# cannot decode. Retrying them burns the whole backoff budget (~30 s) before
# the user learns about a problem they have to fix by hand.
_NON_TRANSIENT_NETWORK_ERRORS = (
    ssl.SSLCertVerificationError,
    httpx.UnsupportedProtocol,
    httpx.DecodingError,
    httpx.TooManyRedirects,
)


def is_transient_network_error(exc: BaseException) -> bool:
    """Whether *exc* is a network blip worth retrying (see the tuples above)."""
    return isinstance(exc, TRANSIENT_NETWORK_ERRORS) and not isinstance(
        exc, _NON_TRANSIENT_NETWORK_ERRORS
    )


class StreamRestart:
    """Sentinel yielded by :func:`stream_with_retry` when a retry restarts the
    provider stream *after* real chunks were already emitted.

    The provider's ``stream()`` is re-run from the beginning on each retry, so
    any partial content/tool-call deltas the assembler already buffered must be
    discarded — otherwise the retry's output is concatenated onto the partial
    first attempt, producing duplicated content or corrupted tool-call JSON.
    :func:`~app.agent.agent_loop.streaming.stream_and_assemble` resets its
    buffers when it sees this marker.
    """


STREAM_RESTART = StreamRestart()


async def _notify_provider_retry(
    hooks: list[BaseAgentHook] | None,
    ctx: RunContext | None,
    state: AgentState | None,
    *,
    model: str,
    attempt: int,
    delay: float,
    error_type: str,
    status_code: int | None = None,
    retry_after: int | None = None,
    status: Literal["retrying", "waiting_quota"] = "retrying",
    message: str | None = None,
    resets_at: int | None = None,
) -> None:
    if ctx is None or state is None:
        return
    for hook in hooks or []:
        await hook.on_provider_retry(
            ctx,
            state,
            model,
            attempt,
            MAX_RETRIES,
            delay,
            error_type,
            status_code=status_code,
            retry_after=retry_after,
            status=status,
            message=message,
            resets_at=resets_at,
        )


async def _notify_provider_exhausted(
    hooks: list[BaseAgentHook] | None,
    ctx: RunContext | None,
    state: AgentState | None,
    *,
    model: str,
    error_type: str,
    status_code: int | None = None,
) -> None:
    if ctx is None or state is None:
        return
    for hook in hooks or []:
        await hook.on_provider_exhausted(
            ctx,
            state,
            model,
            MAX_RETRIES,
            error_type,
            status_code=status_code,
        )


# Module-private timing knobs.
# 529 is Anthropic's "overloaded" status — transient and explicitly retryable.
# It also arrives via SSE error frames mid-stream (see the anthropic provider's
# _raise_stream_error_event), which is the common case in practice.
# Every other 5xx (502/503/504, Cloudflare 520–524, 529) is handled by the
# range check in ``_is_retryable_http_error`` minus the permanent exclusions.
_RETRYABLE_STATUS_CODES = {408, 429}
# 501 Not Implemented and 505 HTTP Version Not Supported describe the request,
# not the server's health; they never clear on retry.
_PERMANENT_5XX_STATUS_CODES = {501, 505}
_NON_RETRYABLE_429_MARKERS = (
    "usage_limit_reached",
    "usage_not_included",
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
    "quota_exceeded",
    "insufficient_quota",
    "insufficient balance",
    "no resource package",
    "billing_not_active",
    # Grok Build's well-known free-tier paywall code (flat body:
    # {"code": "subscription:free-usage-exhausted", "error": "..."}).
    # Quota resets on a rolling 24h window server-side — no client backoff
    # (even the full MAX_RETRIES budget) will make it succeed sooner, so
    # retrying just burns ~42s per turn before failing anyway. Matches
    # xAI's own grok-build CLI, which treats this exact code as a terminal
    # paywall rather than a transient 429
    # (xai-org/grok-build crates/codegen/xai-grok-pager/src/app/dispatch/billing.rs
    # FREE_USAGE_EXHAUSTED_ERROR_CODE).
    "subscription:free-usage-exhausted",
)
_BASE_DELAY = 1.0  # seconds — exponential base 3: 1, 3, 9, 27, 81
_MAX_DELAY = 60.0  # seconds


_DURATION_UNIT_MAP: dict[str, float] = {
    "d": 86400.0,
    "day": 86400.0,
    "days": 86400.0,
    "h": 3600.0,
    "hr": 3600.0,
    "hrs": 3600.0,
    "hour": 3600.0,
    "hours": 3600.0,
    "m": 60.0,
    "min": 60.0,
    "mins": 60.0,
    "minute": 60.0,
    "minutes": 60.0,
    "s": 1.0,
    "sec": 1.0,
    "secs": 1.0,
    "second": 1.0,
    "seconds": 1.0,
    "ms": 0.001,
    "millisecond": 0.001,
    "milliseconds": 0.001,
}

_DURATION_UNIT_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|milliseconds?|ms|minutes?|mins?|m|seconds?|secs?|s)(?![a-zA-Z])",
    re.IGNORECASE,
)

_TIME_AFTER_RE = re.compile(
    r"try again after\s+(\d{1,2}):(\d{2})(?:\s*([ap]\.?m\.?))?",
    re.IGNORECASE,
)


def parse_duration_string(text: str) -> float | None:
    """Parse duration strings like '2 hours 15 minutes', '6m0s', '11.054s', '45m'.

    Returns seconds as float, or None if no duration matched.
    """
    matches = _DURATION_UNIT_RE.findall(text)
    if not matches:
        return None
    total = 0.0
    for val_str, unit in matches:
        multiplier = _DURATION_UNIT_MAP.get(unit.lower())
        if multiplier is not None:
            try:
                total += float(val_str) * multiplier
            except ValueError:
                continue
    return total if total > 0 else None


def parse_reset_timestamp(value: str | int | float) -> int | None:
    """Parse a reset timestamp (epoch, HTTP-date, or ISO date) into remaining seconds."""
    if isinstance(value, int | float):
        ts = float(value)
        if ts > 1e11:
            ts /= 1000.0
        if ts > 1e8:
            return max(0, int(ts - time.time()))
        if 0 < ts <= MAX_QUOTA_WAIT_SECONDS:
            return int(ts)
        return None

    if not isinstance(value, str):
        return None
    val = value.strip()
    if not val:
        return None

    if val.isdigit():
        ts_int = int(val)
        if ts_int > 1e11:
            return max(0, int(ts_int / 1000.0 - time.time()))
        if ts_int > 1e8:
            return max(0, int(ts_int - time.time()))
        return ts_int

    try:
        dt = email.utils.parsedate_to_datetime(val)
        return max(0, int((dt - datetime.now(timezone.utc)).total_seconds()))
    except Exception:
        pass

    try:
        dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, int((dt - datetime.now(timezone.utc)).total_seconds()))
    except Exception:
        pass

    return None


def _parse_time_after(text: str) -> int | None:
    match = _TIME_AFTER_RE.search(text)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    ampm = (match.group(3) or "").lower().replace(".", "")
    if ampm == "pm" and hour < 12:
        hour += 12
    elif ampm == "am" and hour == 12:
        hour = 0
    now = datetime.now()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    diff = (target - now).total_seconds()
    if diff < 0:
        diff += 86400
    return max(0, int(diff))


def format_duration(seconds: float) -> str:
    """Format seconds into human-readable duration: '2h 15m', '45m 10s', or '30s'."""
    secs = int(max(0, seconds))
    days = secs // 86400
    hours = (secs % 86400) // 3600
    minutes = (secs % 3600) // 60
    remaining_secs = secs % 60
    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
        if days == 0:
            parts.append(f"{minutes:02d}m")
    elif minutes > 0:
        parts.append(f"{minutes}m")
        if remaining_secs > 0:
            parts.append(f"{remaining_secs:02d}s")
    elif not parts or remaining_secs > 0:
        parts.append(f"{remaining_secs}s")
    return " ".join(parts)


def _backoff_delay(attempt: int, *, retry_after: int = 0) -> float:
    """Seconds to wait before ``attempt``'s retry.

    A server-specified ``Retry-After`` wins and is used verbatim (clamped to
    ``_MAX_DELAY``): shortening a directive the provider gave us would be
    wrong, so no jitter is applied to it.

    Otherwise the exponential fallback gets *equal jitter* — a uniform draw
    from ``[base / 2, base]``.  Deterministic backoff made every concurrent
    agent retry at the same instants (observed in production as five 529
    attempts in exact lockstep at 1s/3s/9s/27s), which is precisely the
    thundering-herd pattern an overloaded provider handles worst.  Jittering
    only downward also guarantees a retry never waits *longer* than the old
    fixed schedule, so no turn gets slower.
    """
    if retry_after > 0:
        return min(float(retry_after), _MAX_DELAY)
    base = min(_BASE_DELAY * (3**attempt), _MAX_DELAY)
    return base / 2 + random.uniform(0, base / 2)


def _is_retryable_http_error(exc: httpx.HTTPStatusError) -> bool:
    status = exc.response.status_code
    if status in _RETRYABLE_STATUS_CODES:
        return True
    if 500 <= status < 600 and status not in _PERMANENT_5XX_STATUS_CODES:
        return True
    try:
        payload = exc.response.json()
    except (ValueError, json.JSONDecodeError):
        return False
    error = payload.get("error") if isinstance(payload, dict) else None
    return isinstance(error, dict) and error.get("code") == "server_error"


def parse_retry_after(exc: httpx.HTTPStatusError) -> int:
    """Extract ``retry_after`` seconds from a retryable error response.

    Applies to any retryable status, not only 429 — providers signal a wait on
    503/529 as well.

    Checks (in order):
    1. Standard headers (Retry-After, x-ratelimit-reset, ratelimit-reset,
       anthropic-ratelimit-*-reset, x-ratelimit-reset-requests/tokens)
    2. JSON body metadata (retryDelay, reset_at, resets_at, reset_after_seconds,
       quotaResetTimeStamp)
    3. Text phrasing in body ('try again in ...', 'reset in ...', 'try again after HH:MM')
    Returns 0 if none found.
    """
    headers = exc.response.headers

    # 1. Retry-After header (seconds or HTTP-date)
    header = headers.get("retry-after", "")
    if header:
        ts = parse_reset_timestamp(header)
        if ts is not None and ts > 0:
            return ts

    # 2. x-ratelimit-reset / ratelimit-reset (Unix epoch timestamp or seconds)
    for h_name in ("x-ratelimit-reset", "ratelimit-reset", "x-ratelimit-user-reset"):
        val = headers.get(h_name, "")
        if val:
            ts = parse_reset_timestamp(val)
            if ts is not None and ts > 0:
                return ts

    # 3. Anthropic rate limit headers (ISO 8601 timestamps)
    for h_name in (
        "anthropic-ratelimit-requests-reset",
        "anthropic-ratelimit-tokens-reset",
    ):
        val = headers.get(h_name, "")
        if val:
            ts = parse_reset_timestamp(val)
            if ts is not None and ts > 0:
                return ts

    # 4. OpenAI / Codex reset headers (duration strings e.g. "6m0s", "2h15m")
    for h_name in ("x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
        val = headers.get(h_name, "")
        if val:
            dur = parse_duration_string(val)
            if dur is not None and dur > 0:
                return max(1, int(dur))

    # 5. Parse body
    try:
        body = exc.response.text
    except Exception:
        return 0

    if not body:
        return 0

    try:
        payload = json.loads(body)
    except Exception:
        payload = None

    if isinstance(payload, dict):
        error_dict = (
            payload.get("error") if isinstance(payload.get("error"), dict) else payload
        )
        if isinstance(error_dict, dict):
            details = error_dict.get("details")
            if isinstance(details, list):
                for item in details:
                    if isinstance(item, dict):
                        meta = item.get("metadata")
                        if isinstance(meta, dict):
                            delay_str = meta.get("retryDelay")
                            if isinstance(delay_str, str):
                                dur = parse_duration_string(delay_str)
                                if dur is not None and dur > 0:
                                    return max(1, int(dur))
                            q_ts = meta.get("quotaResetTimeStamp")
                            if q_ts:
                                ts = parse_reset_timestamp(q_ts)
                                if ts is not None and ts > 0:
                                    return ts

            for key in ("reset_after_seconds", "reset_after", "reset_at", "resets_at"):
                val = error_dict.get(key)
                if val is not None:
                    ts = parse_reset_timestamp(val)
                    if ts is not None and ts > 0:
                        return ts

    # Google API: {"error": {"details": [{"metadata": {"retryDelay": "33s"}}]}}
    for match in re.finditer(r'"retryDelay"\s*:\s*"(\d+)s"', body):
        return int(match.group(1))

    # Fallback: "reset after / in <duration>" or "try again in <duration>"
    for match in re.finditer(
        r"(?:try again in|resets?\s+(?:in|after)|reset\s+after|retry\s+after|wait)\s+([0-9a-zA-Z\s\.,]+)",
        body,
        re.I,
    ):
        dur = parse_duration_string(match.group(1))
        if dur is not None and dur > 0:
            return max(1, int(dur))

    # "try again after HH:MM [AM/PM]"
    time_after = _parse_time_after(body)
    if time_after is not None and time_after > 0:
        return time_after

    return 0


async def resolve_quota_reset_delay(
    exc: httpx.HTTPStatusError,
    *,
    provider: LLMProviderBase | None = None,
    provider_label: str = "",
) -> int:
    """Resolve wait time until quota resets, using headers, body, or provider usage APIs."""
    delay = parse_retry_after(exc)
    if delay > 0:
        return delay

    p_name = getattr(provider, "provider_name", "") or ""
    label = provider_label.lower()

    if p_name == "codex" or "codex" in label or "chatgpt" in label:
        try:
            from app.agent.providers.codex.usage import get_usage as codex_get_usage

            usage_resp = await asyncio.wait_for(codex_get_usage(), timeout=3.0)
            for limit in usage_resp.limits:
                if limit.primary and limit.primary.resets_at:
                    diff = max(0, limit.primary.resets_at - int(time.time()))
                    if diff > 0:
                        return diff
                if limit.spend and limit.spend.resets_at:
                    diff = max(0, limit.spend.resets_at - int(time.time()))
                    if diff > 0:
                        return diff
        except Exception as u_exc:
            logger.debug("codex_usage_quota_lookup_failed error={!r}", u_exc)

    if p_name == "copilot" or "copilot" in label:
        try:
            from app.agent.providers.copilot.usage import get_usage as copilot_get_usage

            usage_resp = await asyncio.wait_for(copilot_get_usage(), timeout=3.0)
            for limit in usage_resp.limits:
                if limit.primary and limit.primary.resets_at:
                    diff = max(0, limit.primary.resets_at - int(time.time()))
                    if diff > 0:
                        return diff
        except Exception as u_exc:
            logger.debug("copilot_usage_quota_lookup_failed error={!r}", u_exc)

    if p_name == "grok" or "grok" in label:
        try:
            from app.agent.providers.grok.usage import get_usage as grok_get_usage

            usage_resp = await asyncio.wait_for(grok_get_usage(), timeout=3.0)
            for limit in usage_resp.limits:
                if limit.primary and limit.primary.resets_at:
                    diff = max(0, limit.primary.resets_at - int(time.time()))
                    if diff > 0:
                        return diff
        except Exception as u_exc:
            logger.debug("grok_usage_quota_lookup_failed error={!r}", u_exc)

    return 0


def is_non_retryable_429(exc: httpx.HTTPStatusError) -> bool:
    """Return true for quota-style 429s where retrying cannot help."""
    if exc.response.status_code != 429:
        return False
    try:
        body = exc.response.text.lower()
    except Exception:
        return False
    return any(marker in body for marker in _NON_RETRYABLE_429_MARKERS)


def _extract_provider_error_message(body: str) -> str | None:
    """Pull the human-readable error string out of a provider error body.

    Handles common JSON shapes:
    - Anthropic: ``{"type": "error", "error": {"type": "invalid_request_error", "message": "..."}}``
    - OpenAI / DeepSeek / Copilot: ``{"error": {"message": "...", ...}}``
    - Google GenAI: ``{"error": {"message": "...", "status": "..."}}``

    Falls back to a top-level ``message``/``detail`` key, then returns
    ``None`` when nothing useful is found so the caller can use the raw
    status line instead.
    """
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None

    error = data.get("error")
    if isinstance(error, dict):
        msg = error.get("message")
        if isinstance(msg, str) and msg.strip():
            # For Anthropic, include the error type for extra context
            # e.g. "invalid_request_error: Prefilling assistant messages is not supported"
            error_type = error.get("type")
            if isinstance(error_type, str) and error_type.strip():
                return f"{error_type}: {msg.strip()}"
            return msg.strip()
    if isinstance(error, str) and error.strip():
        return error.strip()
    for key in ("message", "detail"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


# Provider bodies that blame the *model* rather than the credential. Some
# gateways (OpenCode Zen) return these under 401, which would otherwise route
# to the "reconnect provider" banner and send the user to re-login for nothing.
_MODEL_PROBLEM_RE = re.compile(
    r"\bmodel\b.*\b(not supported|unsupported|unavailable|not available|"
    r"does not exist|not found|no access|decommissioned|deprecated|retired)\b",
    re.IGNORECASE,
)


def blames_the_model(detail: str | None) -> bool:
    """Return whether a provider error body blames the requested model id."""
    return bool(detail) and _MODEL_PROBLEM_RE.search(detail) is not None


def classify_provider_http_error(
    exc: httpx.HTTPStatusError, *, provider_label: str
) -> Exception:
    """Map a non-retryable provider HTTP error to a typed, user-visible error.

    The raw :class:`httpx.HTTPStatusError` only carries an opaque status
    line (e.g. ``Client error '400 Bad Request'``). This reads the
    response body to recover the provider's own explanation and wraps it
    in a domain error the UI knows how to render:

    - 401 / 403 → :class:`ProviderAuthenticationError` (UI shows a
      "reconnect provider" banner) — unless the body blames the model
      (retired / unsupported id), which is a request error like a 404.
    - 400 / 404 / 422 → :class:`ProviderRequestError` (UI shows the
      specific reason — bad model, unsupported param, context too long…)
    - any other 4xx → :class:`ProviderRequestError` (best-effort)

    Returns the original ``exc`` for status codes that should keep
    bubbling unchanged (callers only invoke this for non-retryable 4xx).
    """
    status = exc.response.status_code
    try:
        detail = _extract_provider_error_message(exc.response.text)
    except Exception:
        detail = None

    suffix = f": {detail}" if detail else ""
    punctuation = "" if detail and detail.endswith((".", "!", "?")) else "."
    if status in (401, 403) and not blames_the_model(detail):
        return ProviderAuthenticationError(
            f"{provider_label} rejected the request — authentication failed "
            f"(HTTP {status}){suffix}{punctuation} Check the provider's API key "
            f"/ login in Settings → Providers.",
            status_code=status,
            provider=provider_label,
        )
    return ProviderRequestError(
        f"{provider_label} rejected the request (HTTP {status}){suffix}{punctuation}",
        status_code=status,
        provider=provider_label,
    )


async def stream_with_retry(
    *,
    primary_provider: LLMProviderBase,
    primary_label: str,
    ctx: RunContext | None,
    state: AgentState | None,
    hooks: list[BaseAgentHook] | None,
    interrupt_event: asyncio.Event | None = None,
    **kwargs,
) -> AsyncIterator:
    """Stream from ``primary_provider`` with retry.

    Wraps both the provider call *and* the full stream iteration so
    that transient errors surfacing mid-stream are retried from the
    beginning.

    When ``ctx``, ``state`` and ``hooks`` are supplied, fires
    ``on_rate_limit`` on each 429 so the streaming hook can push the
    event to the SSE consumer.
    """
    last_exc: Exception | None = None
    # Set once any provider attempt has yielded a real chunk downstream.  When a
    # subsequent attempt begins we must tell the assembler to drop the partial
    # buffer from the failed attempt (see ``StreamRestart``).
    emitted_any = False
    quota_waits = 0
    attempt = 0
    while attempt < MAX_RETRIES:
        if interrupt_event is not None and interrupt_event.is_set():
            return
        try:
            if emitted_any:
                yield STREAM_RESTART
                emitted_any = False
            async for chunk in primary_provider.stream(**kwargs):
                emitted_any = True
                yield chunk
            return  # successful completion — stop retry loop
        except httpx.HTTPStatusError as exc:
            if not _is_retryable_http_error(exc):
                try:
                    await exc.response.aread()
                    body = exc.response.text[:500]
                except Exception:
                    body = "<unreadable>"
                logger.warning(
                    "llm_provider_error model={} status={} body={}",
                    primary_label,
                    exc.response.status_code,
                    body,
                )
                raise classify_provider_http_error(
                    exc, provider_label=primary_label
                ) from exc
            last_exc = exc
            # Body read is best-effort, and needed for *any* retryable status:
            # providers put Retry-After in the headers or the body on 503/529
            # just as they do on 429.  Gating this behind 429 meant an
            # overloaded-provider directive was silently ignored and the
            # exponential fallback used instead.
            try:
                await exc.response.aread()
            except Exception as read_exc:
                # Headers may still carry Retry-After even when the body is gone.
                logger.debug("retry_body_read_failed error={!r}", read_exc)
            if exc.response.status_code == 429:
                reset_seconds = await resolve_quota_reset_delay(
                    exc, provider=primary_provider, provider_label=primary_label
                )
                if reset_seconds > _MAX_DELAY:
                    if reset_seconds > MAX_QUOTA_WAIT_SECONDS:
                        logger.warning(
                            "llm_provider_quota_wait_too_long model={} status=429 reset_in={}s max_wait={}s",
                            primary_label,
                            reset_seconds,
                            MAX_QUOTA_WAIT_SECONDS,
                        )
                        raise ProviderRateLimitError(
                            f"The configured LLM provider quota is exhausted. Reset in {format_duration(reset_seconds)}, "
                            f"which exceeds the maximum auto-wait of {format_duration(MAX_QUOTA_WAIT_SECONDS)}."
                        ) from exc

                    if quota_waits >= MAX_QUOTA_WAITS:
                        logger.warning(
                            "llm_provider_quota_wait_exhausted model={} status=429 waits={}",
                            primary_label,
                            quota_waits,
                        )
                        break

                    quota_waits += 1
                    wait_delay = reset_seconds + CLOCK_SKEW_BUFFER_SECONDS
                    resets_at = int(time.time() + reset_seconds)
                    msg = (
                        f"Provider quota exhausted for {primary_label}. "
                        f"Waiting {format_duration(wait_delay)} for reset. "
                        "Agent will automatically resume work. You can stop at any time."
                    )
                    logger.warning(
                        "llm_provider_quota_wait model={} status=429 reset_in={}s wait_delay={}s wait_attempt={}/{}",
                        primary_label,
                        reset_seconds,
                        wait_delay,
                        quota_waits,
                        MAX_QUOTA_WAITS,
                    )
                    await _notify_provider_retry(
                        hooks,
                        ctx,
                        state,
                        model=primary_label,
                        attempt=attempt + 1,
                        delay=wait_delay,
                        error_type="HTTPStatusError",
                        status_code=exc.response.status_code,
                        retry_after=reset_seconds,
                        status="waiting_quota",
                        message=msg,
                        resets_at=resets_at,
                    )

                    wall_deadline = time.time() + wait_delay
                    if await _sleep_until_wall_deadline_or_interrupted(
                        wall_deadline, interrupt_event
                    ):
                        logger.info(
                            "llm_provider_quota_wait_interrupted model={}",
                            primary_label,
                        )
                        return
                    logger.info(
                        "llm_provider_quota_wait_completed model={} resuming_stream",
                        primary_label,
                    )
                    continue

                if is_non_retryable_429(exc) and reset_seconds == 0:
                    logger.warning(
                        "llm_provider_non_retryable_rate_limit model={} status={} attempt={}/{}",
                        primary_label,
                        exc.response.status_code,
                        attempt + 1,
                        MAX_RETRIES,
                    )
                    break

                retry_after = reset_seconds
                if state and ctx:
                    for hook in hooks or []:
                        await hook.on_rate_limit(
                            ctx,
                            state,
                            retry_after=retry_after,
                            attempt=attempt + 1,
                            max_attempts=MAX_RETRIES,
                        )
            else:
                retry_after = parse_retry_after(exc)

            # Skip sleep on the last attempt — raise immediately.
            if attempt + 1 >= MAX_RETRIES:
                logger.warning(
                    "llm_provider_exhausted model={} status={} attempts={}",
                    primary_label,
                    exc.response.status_code,
                    MAX_RETRIES,
                )
                await _notify_provider_exhausted(
                    hooks,
                    ctx,
                    state,
                    model=primary_label,
                    error_type="HTTPStatusError",
                    status_code=exc.response.status_code,
                )
                break
            # The bail-out below must key off the *un-jittered* requirement:
            # "the wait this attempt needs is at or above the ceiling" is a
            # property of the schedule, not of a particular random draw.
            required_delay = min(
                retry_after if retry_after > 0 else _BASE_DELAY * (3**attempt),
                _MAX_DELAY,
            )
            delay = _backoff_delay(attempt, retry_after=retry_after)
            if exc.response.status_code == 429 and required_delay >= _MAX_DELAY:
                logger.warning(
                    "llm_provider_rate_limit_too_long model={} status={} attempt={}/{} delay={:.1f}s retry_after={}s",
                    primary_label,
                    exc.response.status_code,
                    attempt + 1,
                    MAX_RETRIES,
                    delay,
                    retry_after,
                )
                break
            logger.warning(
                "llm_provider_retry model={} status={} attempt={}/{} delay={:.1f}s retry_after={}s",
                primary_label,
                exc.response.status_code,
                attempt + 1,
                MAX_RETRIES,
                delay,
                retry_after,
            )
            await _notify_provider_retry(
                hooks,
                ctx,
                state,
                model=primary_label,
                attempt=attempt + 1,
                delay=delay,
                error_type="HTTPStatusError",
                status_code=exc.response.status_code,
                retry_after=retry_after,
            )
            if await _sleep_or_interrupted(delay, interrupt_event):
                return
            attempt += 1
        except TRANSIENT_NETWORK_ERRORS as exc:
            if not is_transient_network_error(exc):
                raise
            last_exc = exc
            # Skip sleep on the last attempt.
            if attempt + 1 >= MAX_RETRIES:
                logger.warning(
                    "llm_provider_exhausted model={} error={} attempts={}",
                    primary_label,
                    type(exc).__name__,
                    MAX_RETRIES,
                )
                await _notify_provider_exhausted(
                    hooks,
                    ctx,
                    state,
                    model=primary_label,
                    error_type=type(exc).__name__,
                )
                break
            delay = _backoff_delay(attempt)
            logger.warning(
                "llm_provider_retry model={} error={} attempt={}/{} delay={:.1f}s",
                primary_label,
                type(exc).__name__,
                attempt + 1,
                MAX_RETRIES,
                delay,
            )
            await _notify_provider_retry(
                hooks,
                ctx,
                state,
                model=primary_label,
                attempt=attempt + 1,
                delay=delay,
                error_type=type(exc).__name__,
            )
            if await _sleep_or_interrupted(delay, interrupt_event):
                return
            attempt += 1

    assert last_exc is not None
    if (
        isinstance(last_exc, httpx.HTTPStatusError)
        and last_exc.response.status_code == 429
    ):
        raise ProviderRateLimitError(
            "The configured LLM provider is rate-limited or quota-exhausted."
        ) from last_exc
    raise last_exc


async def _sleep_or_interrupted(
    delay: float, interrupt_event: asyncio.Event | None
) -> bool:
    """Sleep for retry delay, returning True when user interrupt fires first."""
    if interrupt_event is None:
        await asyncio.sleep(delay)
        return False
    if interrupt_event.is_set():
        return True
    try:
        await asyncio.wait_for(interrupt_event.wait(), timeout=delay)
    except TimeoutError:
        return False
    return True


async def _sleep_until_wall_deadline_or_interrupted(
    wall_deadline: float,
    interrupt_event: asyncio.Event | None,
    *,
    chunk_size: float = 30.0,
) -> bool:
    """Sleep until wall_deadline (seconds since epoch) in chunks, returning True when interrupted."""
    while True:
        if interrupt_event is not None and interrupt_event.is_set():
            return True
        remaining = wall_deadline - time.time()
        if remaining <= 0:
            return False
        sleep_chunk = min(chunk_size, max(0.05, remaining))
        if await _sleep_or_interrupted(sleep_chunk, interrupt_event):
            return True
