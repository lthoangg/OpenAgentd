"""Tests for ``SessionRuntime._try_emit_done``.

Covers:
- Done emission once the session's agent is idle or in error
- No done emission while the agent is working or no turn is active
- Done flag reset and completion notifications after emission
"""

from __future__ import annotations

from contextlib import asynccontextmanager
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.agent_loop import Agent
from app.agent.mode.team.runtime import SessionRuntime
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


def _make_runtime(session=None, workspace=None):
    """Create a test session runtime."""
    return SessionRuntime(
        Agent(
            name="openagentd",
            llm_provider=MockTeamProvider(),
            system_prompt="openagentd",
        ),
        session_id="018f0000-0000-7000-8000-000000000001",
        db_factory=_make_db_factory(session),
        workspace=workspace or tempfile.mkdtemp(prefix="openagentd-session-"),
    )


async def _collect_done_events(runtime) -> list:
    """Run ``_try_emit_done`` and return the events pushed to the stream."""
    pushed = []

    async def fake_push(sid, event):
        pushed.append(event)

    with patch("app.services.memory_stream_store.push_event", new=fake_push):
        with patch(
            "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
        ):
            await runtime._try_emit_done()
    return pushed


class TestDoneDetection:
    """Test _try_emit_done across the agent's terminal and busy states."""

    @pytest.mark.asyncio
    async def test_completion_notification_uses_coding_workspace_and_title(
        self, tmp_path
    ):
        """Assistant completion notification names the coding workspace and session."""
        session = MagicMock(
            title="Fix desktop notifications",
            mode="coding",
            workspace=str(tmp_path),
        )
        runtime = _make_runtime(session=session, workspace=str(tmp_path))
        runtime._has_active_turn = True
        runtime.state = "idle"

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
                    await runtime._try_emit_done()

        assert len(notifications) == 2
        event, notification = notifications[0]
        assert event == "desktop_notification"
        assert notification["kind"] == "assistant_done"
        assert notification["session_id"] == "018f0000-0000-7000-8000-000000000001"
        assert notification["notification_id"]
        assert notification["title"] == f"Session completed - {tmp_path.name}"
        assert notification["body"] == "Fix desktop notifications"
        assert notification["metadata"] == {
            "session_id": "018f0000-0000-7000-8000-000000000001",
            "title": "Fix desktop notifications",
            "workspace": str(tmp_path),
        }
        event2, payload2 = notifications[1]
        assert event2 == "session_turn_completed"
        assert payload2 == {
            "session_id": "018f0000-0000-7000-8000-000000000001",
            "status": "completed",
        }
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_completion_notification_falls_back_to_session_id_without_title(
        self, tmp_path
    ):
        """Untitled sessions still emit useful completion text."""
        session = MagicMock(title="   ", mode="coding", workspace=str(tmp_path))
        runtime = _make_runtime(session=session, workspace=str(tmp_path))
        runtime._has_active_turn = True
        runtime.state = "idle"

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
                    await runtime._try_emit_done()

        assert len(notifications) == 2
        event, notification = notifications[0]
        assert event == "desktop_notification"
        assert notification["title"] == f"Session completed - {tmp_path.name}"
        assert notification["body"] == "Session 018f0000"
        event2, payload2 = notifications[1]
        assert event2 == "session_turn_completed"
        assert payload2 == {
            "session_id": "018f0000-0000-7000-8000-000000000001",
            "status": "completed",
        }
        assert [event.event for event in pushed] == ["done"]

    @pytest.mark.asyncio
    async def test_done_emits_when_agent_is_idle(self):
        runtime = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "idle"

        assert [event.event for event in await _collect_done_events(runtime)] == [
            "done"
        ]

    @pytest.mark.asyncio
    async def test_done_emits_when_agent_errored(self):
        """A failed turn is still a finished turn — the stream must be closed."""
        runtime = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "error"

        assert [event.event for event in await _collect_done_events(runtime)] == [
            "done"
        ]

    @pytest.mark.asyncio
    async def test_done_does_not_emit_while_the_agent_is_working(self):
        runtime = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "working"

        assert await _collect_done_events(runtime) == []

    @pytest.mark.asyncio
    async def test_done_does_not_emit_without_an_active_turn(self):
        runtime = _make_runtime()
        runtime._has_active_turn = False
        runtime.state = "idle"

        assert await _collect_done_events(runtime) == []

    @pytest.mark.asyncio
    async def test_done_flag_not_double_reset(self):
        """After done fires, a second call is a no-op (flag already false)."""
        runtime = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "idle"

        assert [event.event for event in await _collect_done_events(runtime)] == [
            "done"
        ]
        assert runtime._has_active_turn is False

        assert await _collect_done_events(runtime) == []

    @pytest.mark.asyncio
    async def test_done_swallows_error(self):
        """Stream store error during done emission is swallowed."""
        runtime = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "idle"

        async def fake_push(sid, event):
            raise ConnectionError("stream down")

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            with patch(
                "app.services.memory_stream_store.mark_done", new_callable=AsyncMock
            ):
                # Must not raise
                await runtime._try_emit_done()

        assert runtime._has_active_turn is False
