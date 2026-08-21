"""Process-local live SSE fan-out for application-wide events.

Unlike the chat stream store, this broadcaster deliberately retains no state:
clients only receive events published while they are connected.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from typing import Any, cast
import orjson

from loguru import logger

_QUEUE_SIZE = 256
_SENTINEL = object()
_subscribers: set[asyncio.Queue[dict[str, str] | object]] = set()


async def publish(event: str, data: dict[str, Any]) -> None:
    """Fan out one global event to current subscribers without retaining it."""
    wire = {"event": event, "data": orjson.dumps(data).decode("utf-8")}
    dead: list[asyncio.Queue[dict[str, str] | object]] = []
    for queue in tuple(_subscribers):
        try:
            queue.put_nowait(wire)
        except asyncio.QueueFull:
            logger.warning("global_sse_subscriber_queue_full event={}", event)
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                queue.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                pass
            dead.append(queue)
    for queue in dead:
        _subscribers.discard(queue)


async def attach() -> AsyncGenerator[dict[str, str], None]:
    """Yield live global SSE events until the client disconnects or is dropped."""
    queue: asyncio.Queue[dict[str, str] | object] = asyncio.Queue(maxsize=_QUEUE_SIZE)
    _subscribers.add(queue)
    try:
        while True:
            item = await queue.get()
            if item is _SENTINEL:
                return
            if isinstance(item, dict):
                yield cast(dict[str, str], item)
    finally:
        _subscribers.discard(queue)


async def close() -> None:
    """Unblock and discard subscribers during application shutdown."""
    subscribers = tuple(_subscribers)
    _subscribers.clear()
    for queue in subscribers:
        try:
            queue.put_nowait(_SENTINEL)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                queue.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                pass
