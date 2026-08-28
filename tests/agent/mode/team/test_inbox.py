"""Tests for the SessionRuntime inbox — deliver/drain/discard queue mechanics.

These replace the old ``TeamMailbox`` tests: registration and blocking
``receive`` went away with the multi-agent roster, but the queue's ordering
and backlog-cap guarantees still hold on the runtime's private inbox.

Every test parks the runtime in ``working`` first, because ``deliver()`` on an
idle runtime deliberately starts a turn — activation-on-delivery is covered in
``test_activation.py``; here we only want the queue behaviour.
"""

from __future__ import annotations

import pytest_asyncio

from app.agent.mode.team.mailbox import Message
from app.agent.mode.team.runtime import _MAX_INBOX_BACKLOG


@pytest_asyncio.fixture
async def busy_runtime(runtime):
    """A runtime that queues deliveries instead of activating on them."""
    runtime.state = "working"
    return runtime


def _drain(runtime) -> list[Message]:
    messages = []
    while not runtime.inbox_empty():
        messages.append(runtime._inbox.get_nowait())
    return messages


async def test_inbox_is_empty_before_anything_is_delivered(busy_runtime):
    assert busy_runtime.inbox_empty() is True


async def test_inbox_is_not_empty_after_a_delivery(busy_runtime):
    await busy_runtime.deliver(Message(from_agent="child", content="report"))

    assert busy_runtime.inbox_empty() is False


async def test_deliveries_are_drained_in_fifo_order(busy_runtime):
    for content in ("first", "second", "third"):
        await busy_runtime.deliver(Message(from_agent="child", content=content))

    assert [m.content for m in _drain(busy_runtime)] == [
        "first",
        "second",
        "third",
    ]


async def test_delivery_preserves_the_message_identity(busy_runtime):
    message = Message(from_agent="child", content="report")

    await busy_runtime.deliver(message)

    assert _drain(busy_runtime)[0].id == message.id


async def test_delivery_past_the_backlog_cap_drops_the_oldest_messages(busy_runtime):
    """A stalled agent's inbox is capped instead of growing without bound."""
    total = _MAX_INBOX_BACKLOG + 5
    for i in range(total):
        await busy_runtime.deliver(Message(from_agent="child", content=str(i)))

    drained = _drain(busy_runtime)

    # Capped at the backlog limit, and the oldest 5 were dropped in favour of
    # keeping the most recent context for when the agent recovers.
    assert len(drained) == _MAX_INBOX_BACKLOG
    assert [m.content for m in drained] == [str(i) for i in range(5, total)]


async def test_discard_inbox_empties_the_queue_and_reports_the_count(busy_runtime):
    for content in ("one", "two"):
        await busy_runtime.deliver(Message(from_agent="child", content=content))

    assert busy_runtime.discard_inbox() == 2
    assert busy_runtime.inbox_empty() is True


async def test_discard_inbox_on_an_empty_queue_reports_zero(busy_runtime):
    assert busy_runtime.discard_inbox() == 0
