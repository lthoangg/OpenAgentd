"""Tests for app/teams/tools.py — make_team_message_tool."""

from __future__ import annotations


from app.agent.mode.team.mailbox import TeamMailbox
from app.agent.mode.team.tools import make_team_message_tool
from app.agent.tools.registry import Tool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mailbox(*agents: str) -> TeamMailbox:
    """Create a mailbox with the given agents registered."""
    mb = TeamMailbox()
    for name in agents:
        mb.register(name)
    return mb


# ---------------------------------------------------------------------------
# Tool shape
# ---------------------------------------------------------------------------


class TestMakeTeamMessageTool:
    """make_team_message_tool returns a single Tool named 'team_message'."""

    def test_returns_single_tool(self):
        """make_team_message_tool returns a Tool instance."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")
        assert isinstance(tool, Tool)

    def test_tool_named_team_message(self):
        """Returned tool is named 'team_message'."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")
        assert tool.name == "team_message"

    def test_member_description_keeps_non_obvious_delivery_semantics(self):
        """Member guidance explains discarded output and useful delivery cases."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        assert "report blockers" in tool.description
        assert "plain text output is silently discarded" in tool.description.lower()

    def test_content_schema_shapes_useful_team_messages(self):
        """Content guidance permits useful coordination and rejects routine chatter."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")
        content_description = tool.definition["function"]["parameters"]["properties"][
            "content"
        ]["description"]

        assert "listed recipients only" in content_description
        assert "system adds [your-name]" in content_description
        assert "requested progress" in content_description
        assert "blockers" in content_description
        assert "routine status" in content_description


# ---------------------------------------------------------------------------
# Delivery — no mode, just to + content
# ---------------------------------------------------------------------------


class TestDelivery:
    """team_message(to, content) delivers prefixed content."""

    async def test_delivers_to_single_recipient(self):
        """Delivers [name]: content to the recipient."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="Work done.")

        msg = await mb.receive("bob")
        assert msg.content == "[alice]: Work done."

    async def test_sets_from_agent(self):
        """Message has correct from_agent."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="data")

        msg = await mb.receive("bob")
        assert msg.from_agent == "alice"

    async def test_multicast_delivers_to_all_recipients(self):
        """Multiple recipients each receive the message."""
        mb = _make_mailbox("lead", "researcher", "writer")
        tool = make_team_message_tool(mb, agent_name="lead")

        await tool(to=["researcher", "writer"], content="Start work.")

        msg_r = await mb.receive("researcher")
        msg_w = await mb.receive("writer")
        assert "[lead]: Start work." in msg_r.content
        assert "[lead]: Start work." in msg_w.content

    async def test_returns_message_sent(self):
        """Returns 'Message sent to ...' string."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["bob"], content="hi")
        assert "Message sent" in result
        assert "bob" in result

    async def test_no_stop_semantics(self):
        """Tool signature has no stop param — sender keeps working."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        # Me verify tool signature has no stop param
        import inspect

        sig = inspect.signature(tool._func)
        assert "stop" not in sig.parameters

    async def test_no_mode_param(self):
        """Tool signature has no mode param."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        import inspect

        sig = inspect.signature(tool._func)
        assert "mode" not in sig.parameters


# ---------------------------------------------------------------------------
# Unknown recipients
# ---------------------------------------------------------------------------


class TestUnknownRecipients:
    """team_message to unknown agents returns error listing available agents."""

    async def test_unknown_recipient_returns_error(self):
        """Sending to unregistered agent returns error."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["ghost"], content="hello")
        assert "not found" in result
        assert "ghost" in result

    async def test_unknown_recipient_lists_available_agents(self):
        """Error message lists available agents."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["ghost"], content="hello")
        assert "Available" in result
        assert "alice" in result or "bob" in result

    async def test_mix_known_unknown_returns_error(self):
        """Mix of known and unknown recipients returns error (all-or-nothing)."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["bob", "ghost"], content="hello")
        assert "not found" in result
        assert "ghost" in result

    async def test_mix_known_unknown_does_not_deliver_to_known(self):
        """When any recipient is unknown, no messages are delivered."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob", "ghost"], content="hello")

        # Me bob should not receive anything
        assert mb.inbox_empty("bob")


# ---------------------------------------------------------------------------
# Content prefix — tool always wraps
# ---------------------------------------------------------------------------


class TestContentPrefix:
    """Verify content prefix behavior."""

    async def test_always_wraps_content_with_prefix(self):
        """Tool always wraps content with [name]: prefix."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="Some work output")

        msg = await mb.receive("bob")
        assert msg.content == "[alice]: Some work output"

    async def test_bracketed_self_prefix_stripped(self):
        """Tool strips [name]: self-prefix before re-wrapping (no double-prefix)."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="[alice]: Already prefixed")

        msg = await mb.receive("bob")
        assert msg.content == "[alice]: Already prefixed"

    async def test_bare_self_prefix_stripped(self):
        """Tool strips bare 'name: ' self-prefix before re-wrapping."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="alice: Already prefixed")

        msg = await mb.receive("bob")
        assert msg.content == "[alice]: Already prefixed"


# ---------------------------------------------------------------------------
# Self-send guard
# ---------------------------------------------------------------------------


class TestSelfSend:
    """Agents cannot message themselves."""

    async def test_self_dropped_from_recipients(self):
        """Self is silently removed from to list — other recipients still get it."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["alice", "bob"], content="data")

        # Me bob receives it
        msg = await mb.receive("bob")
        assert msg.content == "[alice]: data"
        # Me alice inbox stays empty
        assert mb.inbox_empty("alice")
        assert "bob" in result

    async def test_self_only_returns_error(self):
        """Sending only to self returns a clear error."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["alice"], content="data")

        assert "cannot message yourself" in result
        assert mb.inbox_empty("alice")
