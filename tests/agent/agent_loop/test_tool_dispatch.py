"""Tests for bounded cancellation of parallel tool calls."""

from __future__ import annotations

import asyncio

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

    assert results == [(_tool_call(), "Cancelled by user.")]
    assert started.is_set()
    release.set()
    await finished.wait()
