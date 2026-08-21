"""Shared SSE stream parser for LLM providers.

Both GoogleGenAI and ZAI providers use Server-Sent Events for streaming.
This module provides a reusable async generator that handles the common
SSE parsing logic, letting each provider focus only on data extraction.

Usage::

    from app.agent.providers.streaming import iter_sse_data

    async with client.stream("POST", url, ...) as response:
        response.raise_for_status()
        async for data in iter_sse_data(response, sentinel="[DONE]"):
            # data is already a parsed dict
            process(data)
"""

from __future__ import annotations

import orjson
from collections.abc import AsyncIterator
from typing import Any

from loguru import logger


async def iter_sse_data(
    response,
    *,
    sentinel: str | None = "[DONE]",
) -> AsyncIterator[dict[str, Any]]:
    """Yield parsed JSON objects from an SSE stream.

    Args:
        response: An ``httpx`` streaming response (must support
            ``aiter_lines()``).
        sentinel: The ``data:`` value that signals end-of-stream.
            Pass ``None`` to disable sentinel detection (e.g. Google's
            SSE stream which ends when the connection closes).

    Yields:
        Parsed ``dict`` for each ``data:`` line that is valid JSON.
        Empty lines, ``event:`` lines, and ``id:`` lines are skipped.
        Lines that fail JSON parsing are skipped with a warning.
    """
    async for line in response.aiter_lines():
        line = line.strip()
        if not line or not line.startswith("data: "):
            continue

        data_str = line[len("data: ") :]

        if sentinel is not None and data_str == sentinel:
            break

        try:
            yield orjson.loads(data_str)
        except Exception:
            logger.debug("sse_invalid_json data={}", data_str[:200])
            continue
