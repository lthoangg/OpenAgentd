"""Extra ``SessionRuntime`` tests — ``_emit``, ``_try_emit_done``, and the
``handle_user_message`` init-turn/attachment paths."""

from __future__ import annotations

from contextlib import asynccontextmanager
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.agent.mode.team.runtime import SessionRuntime
from tests.agent.mode.team.conftest import MockTeamProvider


def _make_db_factory(existing_row=None):
    mock_db = MagicMock()
    mock_db.commit = AsyncMock()
    mock_db.flush = AsyncMock()
    mock_db.refresh = AsyncMock()
    mock_db.get = AsyncMock(return_value=existing_row)
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

    return factory, mock_db


def _make_agent(name):
    from app.agent.agent_loop import Agent

    return Agent(name=name, llm_provider=MockTeamProvider(), system_prompt=name)


def _make_runtime():
    db_factory, mock_db = _make_db_factory()
    runtime = SessionRuntime(
        _make_agent("openagentd"),
        session_id="00000000-0000-0000-0000-000000000001",
        db_factory=db_factory,
    )
    return runtime, mock_db


# ---------------------------------------------------------------------------
# _emit — non-agent_status path (lines 96-98)
# ---------------------------------------------------------------------------


class TestEmitNonAgentStatus:
    @pytest.mark.asyncio
    async def test_emit_non_agent_status_uses_json_dumps(self):
        runtime, _ = _make_runtime()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await runtime._emit(event="custom_event", extra={"key": "val"})

        assert len(pushed) == 1
        assert pushed[0].event == "custom_event"
        assert pushed[0].data["agent"] == "openagentd"
        assert pushed[0].data["event"] == "custom_event"
        assert pushed[0].data["key"] == "val"

    @pytest.mark.asyncio
    async def test_emit_swallows_error(self):
        runtime, _ = _make_runtime()

        async def fake_push(sid, event):
            raise ConnectionError("stream down")

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            # Must not raise
            await runtime._emit(event="custom_event")


# ---------------------------------------------------------------------------
# _on_turn_error
# ---------------------------------------------------------------------------


class TestOnTurnError:
    @pytest.mark.asyncio
    async def test_error_event_names_the_agent_not_a_lead(self):
        """The message is rendered verbatim in the UI error banner.

        With one agent per session there is no lead/member distinction left to
        report, so the banner should just name the agent.
        """
        runtime, _ = _make_runtime()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch(
            "app.services.memory_stream_store.push_event",
            new=fake_push,
        ):
            await runtime._on_turn_error(RuntimeError("provider exploded"))

        assert len(pushed) == 1
        assert pushed[0].data["message"] == (
            "Agent 'openagentd' failed: provider exploded"
        )


# ---------------------------------------------------------------------------
# _try_emit_done (lines 127-128)
# ---------------------------------------------------------------------------


class TestTryEmitDone:
    @pytest.mark.asyncio
    async def test_try_emit_done_fires_when_the_agent_is_idle(self):
        runtime, _ = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "idle"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        async def fake_mark_done(sid):
            pass

        with (
            patch("app.services.memory_stream_store.push_event", new=fake_push),
            patch("app.services.memory_stream_store.mark_done", new=fake_mark_done),
        ):
            await runtime._try_emit_done()

        done_events = [e for e in pushed if e.event == "done"]
        assert len(done_events) == 1
        assert runtime._has_active_turn is False

    @pytest.mark.asyncio
    async def test_try_emit_done_skips_when_no_active_turn(self):
        runtime, _ = _make_runtime()
        runtime._has_active_turn = False

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await runtime._try_emit_done()

        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_try_emit_done_skips_while_the_agent_is_working(self):
        runtime, _ = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "working"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await runtime._try_emit_done()

        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_try_emit_done_swallows_error(self):
        runtime, _ = _make_runtime()
        runtime._has_active_turn = True
        runtime.state = "idle"

        async def fake_push(sid, event):
            raise ConnectionError("stream down")

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            # Must not raise
            await runtime._try_emit_done()


# ---------------------------------------------------------------------------
# _try_emit_done — handle_user_message calls init_turn (lines 215-216)
# ---------------------------------------------------------------------------


class TestHandleUserMessageInitTurn:
    @pytest.mark.asyncio
    async def test_handle_user_message_calls_init_turn(self):
        runtime, _ = _make_runtime()

        init_turn_called = []

        async def fake_init_turn(sid):
            init_turn_called.append(sid)

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=fake_init_turn),
        ):
            await runtime.handle_user_message("test", session_id=runtime.session_id)

        assert len(init_turn_called) == 1
        assert init_turn_called[0] == runtime.session_id

    @pytest.mark.asyncio
    async def test_handle_user_message_init_turn_failure_swallowed(self):
        runtime, _ = _make_runtime()

        async def fake_init_turn(sid):
            raise ConnectionError("stream down")

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=fake_init_turn),
        ):
            # Must not raise
            await runtime.handle_user_message("test", session_id=runtime.session_id)


# ---------------------------------------------------------------------------
# handle_user_message — attachment_metas path
# ---------------------------------------------------------------------------


class TestHandleUserMessageAttachments:
    @pytest.mark.asyncio
    async def test_handle_user_message_with_attachment_metas(self):
        """attachment_metas are stored in extra."""
        import uuid
        from unittest.mock import patch

        runtime, mock_db = _make_runtime()

        session_id = str(uuid.uuid7())

        attachment_metas = [{"filename": "notes.txt", "category": "text"}]

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=AsyncMock()),
        ):
            returned_session_id, message_id = await runtime.handle_user_message(
                "check this file",
                session_id=session_id,
                attachment_metas=attachment_metas,
            )

        assert returned_session_id == session_id
        assert message_id
        assert runtime._has_active_turn is True
