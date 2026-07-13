"""Tests for app/teams/mailbox.py — TeamMailbox send/receive/broadcast."""

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


class TestMailboxBroadcast:
    """Test mailbox.broadcast() — deliver to all except sender."""

    @pytest_asyncio.fixture
    async def setup(self):
        """Setup mailbox with multiple agents."""
        mailbox = TeamMailbox()
        mailbox.register("sender")
        mailbox.register("a")
        mailbox.register("b")
        mailbox.register("c")
        return mailbox

    async def test_broadcast_to_all_except_sender(self, setup):
        """Broadcast delivers to all agents except sender."""
        mailbox = setup
        msg = Message(from_agent="sender", content="broadcast")
        await mailbox.broadcast(msg)

        # Sender should NOT receive
        assert mailbox.inbox_empty("sender")

        # Others should receive
        for agent in ["a", "b", "c"]:
            received = await mailbox.receive(agent)
            assert received.content == "broadcast"
            assert received.is_broadcast is True
            assert received.to_agent is None

    async def test_broadcast_is_broadcast_flag(self, setup):
        """Broadcast message has is_broadcast=True."""
        mailbox = setup
        msg = Message(from_agent="sender", content="test")
        await mailbox.broadcast(msg)
        received = await mailbox.receive("a")
        assert received.is_broadcast is True

    async def test_broadcast_to_agent_none(self, setup):
        """Broadcast message has to_agent=None."""
        mailbox = setup
        msg = Message(from_agent="sender", content="test")
        await mailbox.broadcast(msg)
        received = await mailbox.receive("a")
        assert received.to_agent is None

    async def test_broadcast_logged(self, setup):
        """Broadcast messages are logged in broadcast_log."""
        mailbox = setup
        msg1 = Message(from_agent="sender", content="msg1")
        msg2 = Message(from_agent="sender", content="msg2")
        await mailbox.broadcast(msg1)
        await mailbox.broadcast(msg2)

        log = mailbox.broadcast_log
        assert len(log) == 2
        assert log[0].content == "msg1"
        assert log[1].content == "msg2"

    async def test_broadcast_empty_agents(self):
        """Broadcasting with only sender registered still works."""
        mailbox = TeamMailbox()
        mailbox.register("sender")
        msg = Message(from_agent="sender", content="test")
        await mailbox.broadcast(msg)
        # No error, log updated
        assert len(mailbox.broadcast_log) == 1

    async def test_broadcast_delivers_to_later_inboxes_while_callback_is_blocked(self):
        callback_started = asyncio.Event()
        release_callback = asyncio.Event()

        async def on_message(agent_name: str, message: Message) -> None:
            if agent_name == "a":
                callback_started.set()
                await release_callback.wait()

        mailbox = TeamMailbox(on_message=on_message)
        for agent_name in ("sender", "a", "b"):
            mailbox.register(agent_name)

        broadcast = asyncio.create_task(
            mailbox.broadcast(Message(from_agent="sender", content="status"))
        )
        await callback_started.wait()
        try:
            received = await asyncio.wait_for(mailbox.receive("b"), timeout=0.1)
            assert received.content == "status"
        finally:
            release_callback.set()
            await broadcast


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


class TestMailboxBroadcastLog:
    """Test mailbox.broadcast_log property."""

    async def test_broadcast_log_read_only(self):
        """broadcast_log returns a copy, not the internal list."""
        mailbox = TeamMailbox()
        mailbox.register("a")
        msg = Message(from_agent="a", content="test")
        await mailbox.broadcast(msg)

        log1 = mailbox.broadcast_log
        log2 = mailbox.broadcast_log
        assert log1 is not log2
        assert len(log1) == len(log2) == 1

    async def test_broadcast_log_preserves_message_data(self):
        """broadcast_log preserves all message fields."""
        mailbox = TeamMailbox()
        mailbox.register("sender")
        mailbox.register("other")

        msg = Message(from_agent="sender", content="test", to_agent="other")
        await mailbox.broadcast(msg)

        log_msg = mailbox.broadcast_log[0]
        assert log_msg.content == "test"
        assert log_msg.from_agent == "sender"
        assert log_msg.is_broadcast is True
