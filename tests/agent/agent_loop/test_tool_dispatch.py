"""Tests for bounded cancellation of parallel tool calls."""

from __future__ import annotations

import asyncio

from app.agent.agent_loop import tool_dispatch
from app.agent.agent_loop.tool_dispatch import gather_or_cancel
from app.agent.schemas.chat import FunctionCall, ToolCall


def _tool_call() -> ToolCall:
    return ToolCall(id="call-1", function=FunctionCall(name="stubborn", arguments="{}"))


async def test_interrupt_returns_when_tool_swallows_cancellation(monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()
    interrupt = asyncio.Event()
    interrupt.set()

    async def stubborn_tool():
        try:
            started.set()
            await release.wait()
        except asyncio.CancelledError:
            await release.wait()
        finished.set()
        return (_tool_call(), "finished")

    real_wait = asyncio.wait

    async def immediate_timeout(fs, *, timeout=None, return_when=asyncio.ALL_COMPLETED):
        if timeout is not None:
            return set(), set(fs)
        return await real_wait(fs, return_when=return_when)

    monkeypatch.setattr(
        "app.agent.agent_loop.tool_dispatch.asyncio.wait", immediate_timeout
    )

    results = await gather_or_cancel(
        [stubborn_tool()], interrupt, [_tool_call()], "agent"
    )

    assert results == [
        (_tool_call(), "Cancellation requested; tool is still stopping.")
    ]
    assert started.is_set()
    assert len(tool_dispatch._detached_tool_tasks) == 1
    release.set()
    await finished.wait()
    await asyncio.sleep(0)
    assert len(tool_dispatch._detached_tool_tasks) == 0


async def test_parent_cancellation_cancels_inflight_tools():
    started = asyncio.Event()
    cancelled = asyncio.Event()
    interrupt = asyncio.Event()

    async def blocking_tool():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    dispatch = asyncio.create_task(
        gather_or_cancel([blocking_tool()], interrupt, [_tool_call()], "agent")
    )
    await started.wait()
    dispatch.cancel()
    await asyncio.gather(dispatch, return_exceptions=True)
    await asyncio.sleep(0)

    assert cancelled.is_set()


async def test_parent_cancellation_returns_when_tool_resists_cancellation():
    """Stopping a response must not wait for a tool's cancellation cleanup."""
    started = asyncio.Event()
    release = asyncio.Event()
    interrupt = asyncio.Event()

    async def stubborn_tool():
        try:
            started.set()
            await release.wait()
        except asyncio.CancelledError:
            await release.wait()
        return (_tool_call(), "finished")

    dispatch = asyncio.create_task(
        gather_or_cancel([stubborn_tool()], interrupt, [_tool_call()], "agent")
    )
    await started.wait()
    dispatch.cancel()

    try:
        results = await asyncio.wait_for(asyncio.shield(dispatch), timeout=0.3)
    finally:
        release.set()
        await asyncio.gather(dispatch, return_exceptions=True)

    assert results == [(_tool_call(), "Cancelled by user.")]
