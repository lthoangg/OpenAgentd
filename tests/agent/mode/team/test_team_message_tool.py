"""Tests for team_message tool — message delivery and formatting.

Covers:
- Single and multiple recipient delivery
- Self-filtering
- Error handling for missing recipients
- Content prefix stripping and formatting
- Role-specific descriptions (lead vs member)
"""

from __future__ import annotations

from app.agent.mode.team.mailbox import TeamMailbox
from app.agent.mode.team.tools import make_team_message_tool


def _make_mailbox(*agents: str) -> TeamMailbox:
    """Create a mailbox with the given agents registered."""
    mb = TeamMailbox()
    for name in agents:
        mb.register(name)
    return mb


class TestTeamMessageTool:
    """Test team_message tool delivery and formatting."""

    async def test_send_to_single_recipient(self):
        """Send to one agent, verify mailbox delivery."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="Work done.")

        msg = await mb.receive("bob")
        assert msg.content == "[alice]: Work done."
        assert msg.from_agent == "alice"
        assert msg.to_agent == "bob"

    async def test_send_to_multiple_recipients(self):
        """Send to 2 agents, verify both receive."""
        mb = _make_mailbox("lead", "researcher", "writer")
        tool = make_team_message_tool(mb, agent_name="lead")

        await tool(to=["researcher", "writer"], content="Start work.")

        msg_r = await mb.receive("researcher")
        msg_w = await mb.receive("writer")

        assert msg_r.content == "[lead]: Start work."
        assert msg_w.content == "[lead]: Start work."
        assert msg_r.from_agent == "lead"
        assert msg_w.from_agent == "lead"

    async def test_self_filtered_from_recipients(self):
        """Include self in `to`, verify self removed."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["alice", "bob"], content="hello")

        # Should only deliver to bob
        msg = await mb.receive("bob")
        assert msg.to_agent == "bob"

        # alice's inbox should be empty
        assert mb.inbox_empty("alice")
        assert "bob" in result

    async def test_self_only_returns_error(self):
        """Send to only self, get 'No valid recipients' error."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["alice"], content="hello")

        assert "No valid recipients" in result
        assert mb.inbox_empty("alice")
        assert mb.inbox_empty("bob")

    async def test_missing_recipient_returns_error(self):
        """Send to non-existent agent, get error listing available agents."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["ghost"], content="hello")

        assert "not found" in result
        assert "ghost" in result
        assert "Available" in result
        # Should list available agents (excluding self)
        assert "bob" in result

    async def test_content_prefix_stripped(self):
        """Content = '[agent_name]: msg' → becomes '[agent_name]: msg' (no double prefix)."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="[alice]: hello")

        msg = await mb.receive("bob")
        # Should not double-prefix
        assert msg.content == "[alice]: hello"
        assert msg.content.count("[alice]:") == 1

    async def test_content_without_prefix_gets_prefixed(self):
        """Content = 'hello' → '[agent_name]: hello'."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="hello")

        msg = await mb.receive("bob")
        assert msg.content == "[alice]: hello"

    async def test_other_prefix_not_stripped(self):
        """Content = '[other]: msg' → '[agent_name]: [other]: msg'."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="[bob]: some data")

        msg = await mb.receive("bob")
        # Should add alice's prefix, not strip bob's
        assert msg.content == "[alice]: [bob]: some data"

    async def test_lead_gets_lead_description(self):
        """make_team_message_tool with role='lead' has lead description."""
        mb = _make_mailbox("lead", "worker")
        tool = make_team_message_tool(mb, agent_name="lead", role="lead")

        assert (
            "delegate" in tool.description.lower()
            or "member" in tool.description.lower()
        )
        assert "silently discarded" not in tool.description

    async def test_member_gets_member_description(self):
        """make_team_message_tool with role='member' has member description."""
        mb = _make_mailbox("lead", "worker")
        tool = make_team_message_tool(mb, agent_name="worker", role="member")

        assert "silently discarded" in tool.description.lower()
        assert "peer handoffs" in tool.description
        # Members must not double-report completed board work to the lead.
        assert "todo_manage" in tool.description

    async def test_returns_success_message(self):
        """Tool returns 'Message sent to ...' on success."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["bob"], content="hi")

        assert "Message sent" in result
        assert "bob" in result

    async def test_multicast_returns_all_recipients(self):
        """Multicast returns all recipients in success message."""
        mb = _make_mailbox("lead", "researcher", "writer")
        tool = make_team_message_tool(mb, agent_name="lead")

        result = await tool(to=["researcher", "writer"], content="work")

        assert "researcher" in result
        assert "writer" in result

    async def test_prefix_with_brackets_stripped(self):
        """Content = '[alice]: msg' with brackets is stripped correctly."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="[alice]: data")

        msg = await mb.receive("bob")
        # Should not have double brackets
        assert msg.content == "[alice]: data"
        assert msg.content.count("[alice]:") == 1

    async def test_prefix_without_brackets_stripped(self):
        """Content = 'alice: msg' without brackets is stripped correctly."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        await tool(to=["bob"], content="alice: data")

        msg = await mb.receive("bob")
        # Should add proper brackets
        assert msg.content == "[alice]: data"

    async def test_mixed_known_unknown_recipients_error(self):
        """Mix of known and unknown recipients returns error (all-or-nothing)."""
        mb = _make_mailbox("alice", "bob")
        tool = make_team_message_tool(mb, agent_name="alice")

        result = await tool(to=["bob", "ghost"], content="hello")

        assert "not found" in result
        assert "ghost" in result
        # Should not have delivered to bob
        assert mb.inbox_empty("bob")

    async def test_coerce_recipients_list(self):
        """Verify list-coercion for recipients in team_message."""
        mb = _make_mailbox("alice", "bob", "charlie")
        tool = make_team_message_tool(mb, agent_name="alice")

        # Coerce single string: "bob"
        await tool.arun(to="bob", content="Hello bob")
        msg1 = await mb.receive("bob")
        assert msg1.content == "[alice]: Hello bob"

        # Coerce comma-separated string: "bob, charlie"
        await tool.arun(to="bob, charlie", content="Hello both")
        msg2 = await mb.receive("bob")
        msg3 = await mb.receive("charlie")
        assert msg2.content == "[alice]: Hello both"
        assert msg3.content == "[alice]: Hello both"

        # Coerce JSON-stringified list: '["bob"]'
        await tool.arun(to='["bob"]', content="Hello again")
        msg4 = await mb.receive("bob")
        assert msg4.content == "[alice]: Hello again"
