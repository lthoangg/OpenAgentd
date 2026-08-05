"""Tests for app/teams/mailbox.py — TeamMailbox send/receive."""

from __future__ import annotations

import asyncio
import pytest
import pytest_asyncio

from app.agent.mode.team.mailbox import Message, TeamMailbox


class TestMailboxRegistration:
    """Test mailbox agent registration."""

    def test_register_idempotent(self):
        """Registering same agent twice is safe."""
        mailbox = TeamMailbox()
        mailbox.register("agent_a")
        mailbox.register("agent_a")
        assert "agent_a" in mailbox.registered_agents

    def test_registered_agents_list(self):
        """registered_agents returns list of registered agents."""
        mailbox = TeamMailbox()
        mailbox.register("a")
        mailbox.register("b")
        agents = mailbox.registered_agents
        assert "a" in agents
        assert "b" in agents
        assert len(agents) == 2


class TestMailboxSend:
    """Test mailbox.send() — deliver to single inbox."""

    @pytest_asyncio.fixture
    async def setup(self):
        """Setup mailbox and agents."""
        mailbox = TeamMailbox()
        mailbox.register("receiver")
        return mailbox

    async def test_send_to_unregistered_raises(self, setup):
        """Sending to unregistered agent raises KeyError."""
        mailbox = setup
        msg = Message(from_agent="sender", to_agent="receiver", content="hi")
        with pytest.raises(KeyError, match="No inbox"):
            await mailbox.send("nonexistent", msg)

    async def test_send_single_message(self, setup):
        """Send single message to inbox."""
        mailbox = setup
        msg = Message(from_agent="sender", to_agent="receiver", content="hi")
        await mailbox.send("receiver", msg)
        received = await mailbox.receive("receiver")
        assert received.content == "hi"
        assert received.from_agent == "sender"

    async def test_send_multiple_messages_fifo(self, setup):
        """Multiple messages are received in FIFO order."""
        mailbox = setup
        msgs = [
            Message(from_agent="s", to_agent="r", content="first"),
            Message(from_agent="s", to_agent="r", content="second"),
            Message(from_agent="s", to_agent="r", content="third"),
        ]
        for msg in msgs:
            await mailbox.send("receiver", msg)

        received = []
        for _ in range(3):
            received.append(await mailbox.receive("receiver"))

        assert [m.content for m in received] == ["first", "second", "third"]

    async def test_send_preserves_message_id(self, setup):
        """Message ID is preserved when sent."""
        mailbox = setup
        msg = Message(from_agent="s", to_agent="r", content="hi")
        original_id = msg.id
        await mailbox.send("receiver", msg)
        received = await mailbox.receive("receiver")
        assert received.id == original_id

    async def test_send_drops_oldest_past_inbox_backlog_cap(self, setup):
        """A stalled receiver's inbox is capped: oldest messages are dropped
        instead of growing without bound."""
        from app.agent.mode.team.mailbox import _MAX_INBOX_BACKLOG

        mailbox = setup
        total = _MAX_INBOX_BACKLOG + 5
        for i in range(total):
            await mailbox.send("receiver", Message(from_agent="s", content=str(i)))

        received = []
        while not mailbox.inbox_empty("receiver"):
            received.append(mailbox.receive_nowait("receiver"))

        # Capped at the backlog limit, and the oldest 5 were dropped in
        # favor of keeping the most recent messages.
        assert len(received) == _MAX_INBOX_BACKLOG
        assert [m.content for m in received] == [str(i) for i in range(5, total)]


class TestMailboxReceive:
    """Test mailbox.receive() — blocking receive."""

    @pytest_asyncio.fixture
    async def setup(self):
        mailbox = TeamMailbox()
        mailbox.register("agent")
        return mailbox

    async def test_receive_unregistered_raises(self, setup):
        """Receiving from unregistered agent raises KeyError."""
        mailbox = setup
        with pytest.raises(KeyError, match="No inbox"):
            await mailbox.receive("nonexistent")

    async def test_receive_blocks_until_message(self, setup):
        """receive() blocks until message arrives."""
        mailbox = setup
        received = []

        async def receiver():
            msg = await mailbox.receive("agent")
            received.append(msg.content)

        async def sender():
            await asyncio.sleep(0.1)
            msg = Message(from_agent="s", content="delayed")
            await mailbox.send("agent", msg)

        await asyncio.gather(receiver(), sender())
        assert received == ["delayed"]

    async def test_receive_nowait_empty_raises(self, setup):
        """receive_nowait() on empty inbox raises QueueEmpty."""
        mailbox = setup
        with pytest.raises(asyncio.QueueEmpty):
            mailbox.receive_nowait("agent")

    async def test_receive_nowait_returns_message(self, setup):
        """receive_nowait() returns next message without blocking."""
        mailbox = setup
        msg = Message(from_agent="s", content="immediate")
        await mailbox.send("agent", msg)
        received = mailbox.receive_nowait("agent")
        assert received.content == "immediate"

    async def test_receive_nowait_unregistered_raises(self, setup):
        """receive_nowait() on unregistered agent raises KeyError."""
        mailbox = setup
        with pytest.raises(KeyError, match="No inbox"):
            mailbox.receive_nowait("nonexistent")


class TestMailboxInboxEmpty:
    """Test mailbox.inbox_empty() — check if inbox has messages."""

    @pytest_asyncio.fixture
    async def setup(self):
        mailbox = TeamMailbox()
        mailbox.register("agent")
        return mailbox

    def test_inbox_empty_returns_true_on_empty(self, setup):
        """inbox_empty returns True when inbox is empty."""
        mailbox = setup
        assert mailbox.inbox_empty("agent") is True

    async def test_inbox_empty_returns_false_with_message(self, setup):
        """inbox_empty returns False when inbox has messages."""
        mailbox = setup
        msg = Message(from_agent="s", content="test")
        await mailbox.send("agent", msg)
        assert mailbox.inbox_empty("agent") is False

    def test_inbox_empty_unregistered_returns_true(self, setup):
        """inbox_empty returns True for unregistered agent."""
        mailbox = setup
        assert mailbox.inbox_empty("nonexistent") is True
