"""Cleanup semantics of ``_interruptible_stream``'s ``finally`` block.

The block did two best-effort awaits, each guarded by
``except (asyncio.CancelledError, BaseException)``.  That tuple is redundant —
``CancelledError`` *is* a ``BaseException`` — so both were effectively
``except BaseException: pass``, which also swallows ``SystemExit`` and
``KeyboardInterrupt``.  A shutdown signal arriving during stream teardown was
therefore discarded.

Cleanup must stay resilient to ordinary failures (a socket close that errors
must not mask the real exception) while letting shutdown signals through.
"""

from __future__ import annotations

import asyncio

import pytest

from app.agent.agent_loop.streaming import _interruptible_stream


class _Source:
    """Async iterator with a controllable ``aclose``."""

    def __init__(self, items: list[str], *, aclose_raises: BaseException | None = None):
        self._items = list(items)
        self._aclose_raises = aclose_raises
        self.aclose_called = False

    def __aiter__(self) -> "_Source":
        return self

    async def __anext__(self) -> str:
        if not self._items:
            raise StopAsyncIteration
        return self._items.pop(0)

    async def aclose(self) -> None:
        self.aclose_called = True
        if self._aclose_raises is not None:
            raise self._aclose_raises


async def _drain(source: _Source, event: asyncio.Event | None) -> list[str]:
    return [item async for item in _interruptible_stream(source, event)]


async def test_source_is_closed_after_normal_completion():
    source = _Source(["a", "b"])
    assert await _drain(source, asyncio.Event()) == ["a", "b"]
    assert source.aclose_called, "cleanup must close the upstream generator"


async def test_ordinary_aclose_failure_is_suppressed():
    """A failing socket close must not surface to the consumer."""
    source = _Source(["a"], aclose_raises=RuntimeError("socket already closed"))
    assert await _drain(source, asyncio.Event()) == ["a"]


async def test_cancelled_error_during_aclose_is_suppressed():
    source = _Source(["a"], aclose_raises=asyncio.CancelledError())
    assert await _drain(source, asyncio.Event()) == ["a"]


async def test_system_exit_during_aclose_propagates():
    """A shutdown signal must not be swallowed by best-effort cleanup."""
    source = _Source(["a"], aclose_raises=SystemExit(3))
    with pytest.raises(SystemExit):
        await _drain(source, asyncio.Event())


async def test_keyboard_interrupt_during_aclose_propagates():
    source = _Source(["a"], aclose_raises=KeyboardInterrupt())
    with pytest.raises(KeyboardInterrupt):
        await _drain(source, asyncio.Event())


async def test_interrupt_path_still_closes_source():
    """The interrupt path must keep releasing the upstream stream."""
    event = asyncio.Event()
    event.set()  # pre-set: generator returns before yielding anything
    source = _Source(["a", "b"])
    assert await _drain(source, event) == []
    assert source.aclose_called


async def test_no_interrupt_event_bypasses_cleanup_wrapper():
    """With no event the fast path is a plain ``async for`` (no waiter)."""
    source = _Source(["a", "b"])
    assert await _drain(source, None) == ["a", "b"]
