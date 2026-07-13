"""Tests for _try_emit_done with mixed agent states.

Covers:
- Done emission when lead + all members are idle or error
- No done emission when any agent is working
- Done flag reset after emission
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.agent_loop import Agent
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam
from tests.agent.mode.team.conftest import MockTeamProvider


def _make_db_factory(session=None):
    """Create a mock async session factory."""
    mock_db = MagicMock()
    mock_db.commit = AsyncMock()
    mock_db.flush = AsyncMock()
    mock_db.get = AsyncMock(return_value=session)
    mock_db.add = MagicMock()
    mock_db.exec = AsyncMock(
        return_value=MagicMock(
            all=MagicMock(return_value=[]),
            first=MagicMock(return_value=None),
        )
    )

    @asynccontextmanager
    async def factory():
        yield mock_db

    return factory


def _make_agent(name):
    """Create a mock agent."""
    return Agent(name=name, llm_provider=MockTeamProvider(), system_prompt=name)


def _make_team(session=None):
    """Create a test team."""
    lead_agent = _make_agent("lead")
    member_agent = _make_agent("worker")
    db_factory = _make_db_factory(session)
    lead = TeamLead(
        lead_agent,
        session_id="018f0000-0000-7000-8000-000000000001",
        db_factory=db_factory,
    )
    member = TeamMember(member_agent, session_id="worker-sid", db_factory=db_factory)
    team = AgentTeam(lead=lead, members={"worker": member})
    return team


class TestDoneDetectionMixedStates:
    """Test _try_emit_done with various state combinations."""

    @pytest.mark.asyncio
    async def test_completion_notification_uses_coding_workspace_and_title(self):
        """Assistant completion notification names the coding workspace and session."""
        session = MagicMock(
            title="Fix desktop notifications",
            mode="coding",
            workspace=str(Path("/repo/openagentd")),
        )
        team = _make_team(session=session)
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        pushed = []
        notifications = []

        async def fake_push(sid, event):
            pushed.append(event)

        async def fake_publish(event, payload):
            notifications.append((event, payload))

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch("app.services.event_broadcaster.publish", new=fake_publish):
                with patch(
                    "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
                ):
                    await team._try_emit_done()

        event, notification = notifications[0]
        assert event == "desktop_notification"
        assert notification["kind"] == "assistant_done"
        assert notification["session_id"] == "018f0000-0000-7000-8000-000000000001"
        assert notification["notification_id"]
        assert notification["title"] == "Session completed - openagentd"
        assert notification["body"] == "Fix desktop notifications"
        assert notification["metadata"] == {
            "session_id": "018f0000-0000-7000-8000-000000000001",
            "title": "Fix desktop notifications",
            "mode": "coding",
            "workspace": str(Path("/repo/openagentd")),
        }
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_completion_notification_falls_back_to_session_id_without_title(self):
        """Untitled sessions still emit useful completion text."""
        session = MagicMock(title="   ", mode="chat", workspace="/repo/openagentd")
        team = _make_team(session=session)
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        pushed = []
        notifications = []

        async def fake_push(sid, event):
            pushed.append(event)

        async def fake_publish(event, payload):
            notifications.append((event, payload))

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch("app.services.event_broadcaster.publish", new=fake_publish):
                with patch(
                    "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
                ):
                    await team._try_emit_done()

        event, notification = notifications[0]
        assert event == "desktop_notification"
        assert notification["title"] == "Session completed"
        assert notification["body"] == "Session 018f0000"
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_done_emits_when_lead_idle_member_error(self):
        """Lead idle + member error → done fires."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "error"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should have emitted done
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_done_emits_when_lead_error_member_idle(self):
        """Lead error + member idle → done fires."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "error"
        team.members["worker"].state = "idle"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should have emitted done
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_done_not_emits_when_lead_working_member_error(self):
        """Lead working + member error → no done."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "working"
        team.members["worker"].state = "error"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should NOT have emitted done
        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_done_not_emits_when_any_working(self):
        """Any agent working → no done."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "working"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should NOT have emitted done
        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_done_flag_not_double_reset(self):
        """After done fires, second call is no-op (flag already false)."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # First call should emit done plus the desktop completion notification
        assert [event.event for event in pushed] == ["done"]
        assert team._has_active_turn is False

        # Second call should be no-op
        pushed.clear()
        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should not have emitted again
        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_done_not_emits_when_no_active_turn(self):
        """When _has_active_turn is False, done is not emitted."""
        team = _make_team()
        team._has_active_turn = False
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should not emit when no active turn
        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_done_emits_when_both_error(self):
        """Lead error + member error → done fires."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "error"
        team.members["worker"].state = "error"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should have emitted done (both are done, even if error)
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_done_emits_when_both_idle(self):
        """Lead idle + member idle → done fires."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                await team._try_emit_done()

        # Should have emitted done
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_done_swallows_error(self):
        """Stream store error during done emission is swallowed."""
        team = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        async def fake_push(sid, event):
            raise ConnectionError("stream down")

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                # Must not raise
                await team._try_emit_done()

        # Flag should still be reset
        assert team._has_active_turn is False
