"""Retry + fallback streaming for LLM provider calls.

Wraps a provider's ``stream()`` so transient errors (429, 5xx,
connection errors) that surface mid-stream are retried from the
beginning.  Non-retryable HTTP errors (4xx except 429) are raised
immediately.

If a fallback provider is supplied and the primary exhausts its
retry budget, the fallback is tried with the same budget.

Lives outside the :class:`~app.agent.agent_loop.Agent` class because
none of this depends on instance state — only the provider, the
fallback (if any), and a couple of labels for logging.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

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
# falling back / raising.
MAX_RETRIES = 5


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


async def _notify_provider_fallback(
    hooks: list[BaseAgentHook] | None,
    ctx: RunContext | None,
    state: AgentState | None,
    *,
    primary: str,
    fallback: str,
    error_type: str | None = None,
    status_code: int | None = None,
) -> None:
    if ctx is None or state is None:
        return
    state.metadata["effective_model"] = fallback
    state.metadata["provider_fallback"] = {
        "primary": primary,
        "fallback": fallback,
        "reason": "primary_exhausted",
        **({"error_type": error_type} if error_type else {}),
        **({"status_code": status_code} if status_code is not None else {}),
    }
    for hook in hooks or []:
        await hook.on_provider_fallback(ctx, state, primary, fallback)


# Module-private timing knobs.
_RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
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
)
_BASE_DELAY = 1.0  # seconds — exponential base 3: 1, 3, 9, 27, 81
_MAX_DELAY = 60.0  # seconds


def parse_retry_after(exc: httpx.HTTPStatusError) -> int:
    """Extract ``retry_after`` seconds from a 429 response.

    Checks (in order):
    1. ``Retry-After`` HTTP header
    2. ``error.details[].metadata.retryDelay`` in the JSON body (Google API format)
    3. Regex match on the response text (e.g. "reset after 33s")
    Returns 0 if none found.
    """
    # 1. Standard header
    header = exc.response.headers.get("retry-after", "")
    if header.isdigit():
        return int(header)

    # 2 & 3. Parse body
    try:
        body = exc.response.text
    except Exception:
        return 0

    # Google API: {"error": {"details": [{"metadata": {"retryDelay": "33s"}}]}}
    for match in re.finditer(r'"retryDelay"\s*:\s*"(\d+)s"', body):
        return int(match.group(1))

    # Fallback: "reset after Ns"
    for match in re.finditer(r"reset after (\d+)s", body):
        return int(match.group(1))

    # Codex/OpenAI stream errors: "try again in 11.054s" or "35 seconds".
    for match in re.finditer(
        r"try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|seconds?)", body, re.I
    ):
        value = float(match.group(1))
        unit = match.group(2).lower()
        if unit == "ms":
            return max(1, int(value / 1000))
        return max(1, int(value))

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

    Handles the two common JSON shapes:
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
            return msg.strip()
    if isinstance(error, str) and error.strip():
        return error.strip()
    for key in ("message", "detail"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def classify_provider_http_error(
    exc: httpx.HTTPStatusError, *, provider_label: str
) -> Exception:
    """Map a non-retryable provider HTTP error to a typed, user-visible error.

    The raw :class:`httpx.HTTPStatusError` only carries an opaque status
    line (e.g. ``Client error '400 Bad Request'``). This reads the
    response body to recover the provider's own explanation and wraps it
    in a domain error the UI knows how to render:

    - 401 / 403 → :class:`ProviderAuthenticationError` (UI shows a
      "reconnect provider" banner)
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
    if status in (401, 403):
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
    fallback_provider: LLMProviderBase | None,
    fallback_label: str,
    agent_name: str,
    ctx: RunContext | None,
    state: AgentState | None,
    hooks: list[BaseAgentHook] | None,
    interrupt_event: asyncio.Event | None = None,
    **kwargs,
) -> AsyncIterator:
    """Stream from ``primary_provider`` with retry; fall back if exhausted.

    Wraps both the provider call *and* the full stream iteration so
    that transient errors surfacing mid-stream are retried from the
    beginning.

    When ``ctx``, ``state`` and ``hooks`` are supplied, fires
    ``on_rate_limit`` on each 429 so the streaming hook can push the
    event to the SSE consumer.
    """
    providers: list[tuple[LLMProviderBase, str]] = [(primary_provider, primary_label)]
    if fallback_provider is not None:
        providers.append((fallback_provider, fallback_label))

    last_exc: Exception | None = None
    # Set once any provider attempt has yielded a real chunk downstream.  When a
    # subsequent attempt begins we must tell the assembler to drop the partial
    # buffer from the failed attempt (see ``StreamRestart``).
    emitted_any = False
    for provider, provider_label in providers:
        for attempt in range(MAX_RETRIES):
            if interrupt_event is not None and interrupt_event.is_set():
                return
            try:
                if emitted_any:
                    yield STREAM_RESTART
                    emitted_any = False
                async for chunk in provider.stream(**kwargs):
                    emitted_any = True
                    yield chunk
                return  # successful completion — stop retry loop
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code not in _RETRYABLE_STATUS_CODES:
                    try:
                        await exc.response.aread()
                        body = exc.response.text[:500]
                    except Exception:
                        body = "<unreadable>"
                    logger.error(
                        "llm_provider_error model={} status={} body={}",
                        provider_label,
                        exc.response.status_code,
                        body,
                    )
                    raise classify_provider_http_error(
                        exc, provider_label=provider_label
                    ) from exc
                last_exc = exc
                retry_after = 0
                if exc.response.status_code == 429:
                    try:
                        await exc.response.aread()
                    except Exception:
                        pass
                    if is_non_retryable_429(exc):
                        logger.warning(
                            "llm_provider_non_retryable_rate_limit model={} status={} attempt={}/{}",
                            provider_label,
                            exc.response.status_code,
                            attempt + 1,
                            MAX_RETRIES,
                        )
                        break
                    retry_after = parse_retry_after(exc)
                    if state and ctx:
                        for hook in hooks or []:
                            await hook.on_rate_limit(
                                ctx,
                                state,
                                retry_after=retry_after,
                                attempt=attempt + 1,
                                max_attempts=MAX_RETRIES,
                            )
                # Skip sleep on the last attempt — move to fallback (or raise) immediately
                if attempt + 1 >= MAX_RETRIES:
                    logger.warning(
                        "llm_provider_exhausted model={} status={} attempts={}",
                        provider_label,
                        exc.response.status_code,
                        MAX_RETRIES,
                    )
                    await _notify_provider_exhausted(
                        hooks,
                        ctx,
                        state,
                        model=provider_label,
                        error_type="HTTPStatusError",
                        status_code=exc.response.status_code,
                    )
                    break
                delay = min(
                    retry_after if retry_after > 0 else _BASE_DELAY * (3**attempt),
                    _MAX_DELAY,
                )
                if exc.response.status_code == 429 and delay >= _MAX_DELAY:
                    logger.warning(
                        "llm_provider_rate_limit_too_long model={} status={} attempt={}/{} delay={:.1f}s retry_after={}s",
                        provider_label,
                        exc.response.status_code,
                        attempt + 1,
                        MAX_RETRIES,
                        delay,
                        retry_after,
                    )
                    break
                logger.warning(
                    "llm_provider_retry model={} status={} attempt={}/{} delay={:.1f}s retry_after={}s",
                    provider_label,
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
                    model=provider_label,
                    attempt=attempt + 1,
                    delay=delay,
                    error_type="HTTPStatusError",
                    status_code=exc.response.status_code,
                    retry_after=retry_after,
                )
                if await _sleep_or_interrupted(delay, interrupt_event):
                    return
            except (httpx.ConnectError, httpx.ReadTimeout, TimeoutError) as exc:
                last_exc = exc
                # Skip sleep on the last attempt
                if attempt + 1 >= MAX_RETRIES:
                    logger.warning(
                        "llm_provider_exhausted model={} error={} attempts={}",
                        provider_label,
                        type(exc).__name__,
                        MAX_RETRIES,
                    )
                    await _notify_provider_exhausted(
                        hooks,
                        ctx,
                        state,
                        model=provider_label,
                        error_type=type(exc).__name__,
                    )
                    break
                delay = min(_BASE_DELAY * (3**attempt), _MAX_DELAY)
                logger.warning(
                    "llm_provider_retry model={} error={} attempt={}/{} delay={:.1f}s",
                    provider_label,
                    type(exc).__name__,
                    attempt + 1,
                    MAX_RETRIES,
                    delay,
                )
                await _notify_provider_retry(
                    hooks,
                    ctx,
                    state,
                    model=provider_label,
                    attempt=attempt + 1,
                    delay=delay,
                    error_type=type(exc).__name__,
                )
                if await _sleep_or_interrupted(delay, interrupt_event):
                    return

        # Primary model exhausted all retries — try fallback
        if fallback_provider is not None and provider is primary_provider:
            logger.warning(
                "llm_provider_fallback agent={} primary={} fallback={}",
                agent_name,
                primary_label,
                fallback_label,
            )
            error_type = type(last_exc).__name__ if last_exc is not None else None
            status_code = (
                last_exc.response.status_code
                if isinstance(last_exc, httpx.HTTPStatusError)
                else None
            )
            await _notify_provider_fallback(
                hooks,
                ctx,
                state,
                primary=primary_label,
                fallback=fallback_label,
                error_type=error_type,
                status_code=status_code,
            )

    assert last_exc is not None
    if (
        isinstance(last_exc, httpx.HTTPStatusError)
        and last_exc.response.status_code == 429
    ):
        raise ProviderRateLimitError(
            "All configured LLM providers are rate-limited or quota-exhausted."
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
