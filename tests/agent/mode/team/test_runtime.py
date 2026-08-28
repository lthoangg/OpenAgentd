"""Tests for app/agent/mode/team/runtime.py — SessionRuntime coordination."""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import ChatSession, SessionMessage
from app.agent.mode.team.mailbox import Message


class TestSessionRuntimeConstruction:
    """Test SessionRuntime initialization."""

    async def test_construct_runtime(self, runtime):
        assert runtime.name == "openagentd"

    async def test_runtime_starts_with_an_empty_inbox(self, runtime):
        assert runtime.inbox_empty() is True


class TestSessionRuntimeStartStop:
    """Test runtime lifecycle — start and stop."""

    async def test_start_does_not_create_background_tasks(self, runtime):
        """After start(), the agent is idle but no task is running."""
        await runtime.start()

        assert runtime._active_task is None

        await runtime.stop()

    async def test_start_sets_the_agent_to_idle(self, runtime):
        await runtime.start()

        assert runtime.state == "idle"

        await runtime.stop()

    async def test_stop_discards_undelivered_inbox_messages(self, runtime):
        await runtime.start()
        runtime.state = "working"  # keep delivery from activating a turn
        await runtime.deliver(Message(from_agent="child", content="late report"))

        await runtime.stop()

        assert runtime.inbox_empty() is True


class TestSessionRuntimeUserMessage:
    """Test handle_user_message() — user interaction entry point."""

    async def test_handle_user_message_delivers_to_the_agent(self, runtime):
        await runtime.start()

        session_id = str(uuid.uuid7())
        await runtime.handle_user_message("Hello", session_id=session_id)

        # Message was delivered — the agent should be activated.
        # Give the activation task a moment to start.
        await asyncio.sleep(0.1)
        await runtime.stop()

    async def test_handle_user_message_binds_the_session(self, runtime):
        await runtime.start()

        old_session = runtime.session_id
        new_session = str(uuid.uuid7())

        await runtime.handle_user_message("Hi", session_id=new_session)

        assert runtime.session_id == new_session
        assert runtime.session_id != old_session

        await asyncio.sleep(0.1)
        await runtime.stop()

    async def test_handle_user_message_preserves_same_session(self, runtime):
        await runtime.start()

        session = str(uuid.uuid7())
        await runtime.handle_user_message("First", session_id=session)
        await runtime.handle_user_message("Second", session_id=session)
        assert runtime.session_id == session

        await asyncio.sleep(0.1)
        await runtime.stop()

    async def test_handle_user_message_with_interrupt(self, runtime):
        await runtime.start()

        runtime.state = "working"
        await runtime.handle_user_message(
            "New direction", session_id=str(uuid.uuid7()), interrupt=True
        )

        assert runtime._cancel_event.is_set()

        await runtime.stop()

    async def test_handle_user_message_sets_active_turn_flag(self, runtime):
        await runtime.start()

        assert not runtime._has_active_turn
        await runtime.handle_user_message("Hi", session_id=str(uuid.uuid7()))
        assert runtime._has_active_turn

        await asyncio.sleep(0.1)
        await runtime.stop()

    async def test_handle_user_message_propagates_db_failure_without_delivery(
        self, runtime
    ):
        runtime.db_factory = MagicMock(side_effect=RuntimeError("DB connection failed"))
        runtime.deliver = AsyncMock()
        await runtime.start()

        session_id = str(uuid.uuid7())
        try:
            with pytest.raises(RuntimeError, match="DB connection failed"):
                await runtime.handle_user_message("Hello", session_id=session_id)

            assert not runtime._has_active_turn
            runtime.deliver.assert_not_awaited()
        finally:
            await runtime.stop()

    async def test_handle_user_message_rolls_back_active_turn_when_delivery_fails(
        self, runtime
    ):
        await runtime.start()
        runtime.deliver = AsyncMock(side_effect=RuntimeError("activation failed"))

        try:
            with pytest.raises(RuntimeError, match="activation failed"):
                await runtime.handle_user_message("Hello", session_id=str(uuid.uuid7()))
            assert not runtime._has_active_turn
        finally:
            await runtime.stop()

    async def test_handle_user_message_rolls_back_active_turn_when_delivery_is_cancelled(
        self, runtime
    ):
        await runtime.start()
        runtime.deliver = AsyncMock(side_effect=asyncio.CancelledError)

        try:
            with pytest.raises(asyncio.CancelledError):
                await runtime.handle_user_message("Hello", session_id=str(uuid.uuid7()))
            assert not runtime._has_active_turn
        finally:
            await runtime.stop()

    async def test_handle_user_message_returns_session_id(self, runtime):
        """handle_user_message() returns (session_id, message_id) for stream subscription."""
        await runtime.start()
        session_id = str(uuid.uuid7())
        returned_session_id, message_id = await runtime.handle_user_message(
            "Hello", session_id=session_id
        )
        assert returned_session_id == session_id
        assert message_id
        await asyncio.sleep(0.1)
        await runtime.stop()

    async def test_handle_user_message_initialises_turn(self, runtime):
        """handle_user_message() calls stream_store.init_turn() synchronously."""
        await runtime.start()

        session_id = str(uuid.uuid7())
        with patch(
            "app.services.memory_stream_store.init_turn", new_callable=AsyncMock
        ) as mock_init:
            await runtime.handle_user_message("Hello", session_id=session_id)
            mock_init.assert_awaited_once_with(session_id)

        await asyncio.sleep(0.1)
        await runtime.stop()

    async def test_handle_user_message_persists_session_model_settings_and_turn_metadata(
        self, runtime
    ):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        runtime.db_factory = db_factory
        runtime.deliver = AsyncMock()
        session_id = str(uuid.uuid7())

        try:
            await runtime.handle_user_message(
                "Use the stronger model",
                session_id=session_id,
                model="openai:gpt-5.5",
                model_provided=True,
                thinking_level="high",
                thinking_level_provided=True,
            )

            async with db_factory() as db:
                session_row = await db.get(ChatSession, uuid.UUID(session_id))
                assert session_row is not None
                assert session_row.model == "openai:gpt-5.5"
                assert session_row.thinking_level == "high"
                messages = (await db.exec(select(SessionMessage))).all()
                user_rows = [row for row in messages if row.role == "user"]
                assert len(user_rows) == 1
                assert user_rows[0].extra is not None
                assert user_rows[0].extra["model"] == "openai:gpt-5.5"
                assert user_rows[0].extra["thinking_level"] == "high"
        finally:
            await engine.dispose()

    async def test_handle_user_message_reset_clears_session_override_but_stamps_default_model(
        self, runtime, tmp_path
    ):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        runtime.db_factory = db_factory
        runtime.deliver = AsyncMock()
        session_uuid = uuid.uuid7()

        async with db_factory() as db:
            db.add(
                ChatSession(
                    id=session_uuid,
                    agent_name="openagentd",
                    mode="coding",
                    workspace=str(tmp_path),
                    model="openai:gpt-5.5",
                    thinking_level="high",
                )
            )
            await db.commit()

        try:
            await runtime.handle_user_message(
                "Reset to default",
                session_id=str(session_uuid),
                model=None,
                model_provided=True,
                thinking_level=None,
                thinking_level_provided=True,
            )

            async with db_factory() as db:
                session_row = await db.get(ChatSession, session_uuid)
                assert session_row is not None
                assert session_row.model is None
                assert session_row.thinking_level is None
                messages = (await db.exec(select(SessionMessage))).all()
                user_rows = [row for row in messages if row.role == "user"]
                assert len(user_rows) == 1
                assert user_rows[0].extra is not None
                assert user_rows[0].extra["model"] == runtime.agent.model_id
                assert "thinking_level" not in user_rows[0].extra
        finally:
            await engine.dispose()


class TestSessionRuntimeDoneDetection:
    """Test _try_emit_done() — detecting when team is done."""

    async def test_try_emit_done_requires_active_turn(self, runtime, mock_stream_store):
        """_try_emit_done() doesn't emit if _has_active_turn is False."""
        runtime._has_active_turn = False
        runtime.state = "idle"

        initial_calls = mock_stream_store.call_count
        await runtime._try_emit_done()

        # No new stream push for done
        done_calls = [
            c
            for c in mock_stream_store.call_args_list[initial_calls:]
            if c.args[1].event == "done"
        ]
        assert len(done_calls) == 0

    async def test_try_emit_done_emits_when_all_idle(self, runtime, mock_stream_store):
        """_try_emit_done() pushes done when lead idle."""
        runtime._has_active_turn = True
        runtime.state = "idle"
        await runtime._try_emit_done()

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "done" in events

    async def test_try_emit_done_does_not_emit_if_any_working(
        self, runtime, mock_stream_store
    ):
        runtime._has_active_turn = True
        runtime.state = "working"

        initial_calls = mock_stream_store.call_count
        await runtime._try_emit_done()

        done_calls = [
            c
            for c in mock_stream_store.call_args_list[initial_calls:]
            if c.args[1].event == "done"
        ]
        assert len(done_calls) == 0

    async def test_try_emit_done_emits_when_error_state(
        self, runtime, mock_stream_store
    ):
        runtime._has_active_turn = True
        runtime.state = "error"

        await runtime._try_emit_done()

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "done" in events

    async def test_try_emit_done_resets_flag(self, runtime):
        """_try_emit_done() resets _has_active_turn after emitting."""
        runtime._has_active_turn = True
        runtime.state = "idle"

        await runtime._try_emit_done()
        assert runtime._has_active_turn is False

    async def test_activate_queued_messages_emits_queued_turn_start(
        self, runtime, mock_stream_store
    ):
        queued = [MagicMock(id=uuid.uuid7(), content="queued")]
        runtime.deliver = AsyncMock()

        with patch(
            "app.agent.mode.team.runtime.pop_queued_user_messages",
            new=AsyncMock(return_value=queued),
        ):
            activated = await runtime._activate_queued_user_messages(str(uuid.uuid7()))

        assert activated is True
        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "queued_turn_start" in events
        event = next(
            c.args[1]
            for c in mock_stream_store.call_args_list
            if c.args[1].event == "queued_turn_start"
        )
        assert event.data["message_ids"] == [str(queued[0].id)]
        assert event.data["messages"] == [
            {"id": str(queued[0].id), "content": "queued"}
        ]
        runtime.deliver.assert_awaited_once()

    async def test_activate_queued_messages_resets_stream_when_team_idle(self, runtime):
        """The post-turn drain starts a fresh turn blob."""
        runtime.state = "idle"
        queued = [MagicMock(id=uuid.uuid7(), content="queued")]
        runtime.deliver = AsyncMock()

        with (
            patch(
                "app.agent.mode.team.runtime.pop_queued_user_messages",
                new=AsyncMock(return_value=queued),
            ),
            patch(
                "app.agent.mode.team.runtime.stream_store.init_turn",
                new=AsyncMock(),
            ) as init_turn,
        ):
            activated = await runtime._activate_queued_user_messages(runtime.session_id)

        assert activated is True
        init_turn.assert_awaited_once_with(runtime.session_id, keep_subscribers=True)

    async def test_does_not_activate_queue_before_lead_turn_is_done(self, runtime):
        """Queued rows stay persisted while the lead is still inside its loop."""
        runtime._has_active_turn = True
        runtime.session_id = str(uuid.uuid7())
        runtime.state = "working"
        runtime._activate_queued_user_messages = AsyncMock(return_value=True)

        await runtime._try_activate_queued_after_turn()

        runtime._activate_queued_user_messages.assert_not_awaited()

    async def test_activates_queue_after_lead_done_when_provider_disables_interrupt(
        self, runtime
    ):
        runtime.agent.llm_provider.support_interrupt = False
        runtime._has_active_turn = True
        runtime.session_id = str(uuid.uuid7())
        runtime.state = "idle"
        runtime._activate_queued_user_messages = AsyncMock(return_value=True)

        await runtime._try_activate_queued_after_turn()

        runtime._activate_queued_user_messages.assert_awaited_once_with(
            runtime.session_id
        )

    async def test_does_not_activate_queue_without_active_turn(self, runtime):
        """No queued handoff should happen after cancellation/done reset the turn."""
        runtime._has_active_turn = False
        runtime.session_id = str(uuid.uuid7())
        runtime.state = "idle"
        runtime._activate_queued_user_messages = AsyncMock(return_value=True)

        await runtime._try_activate_queued_after_turn()

        runtime._activate_queued_user_messages.assert_not_awaited()

    async def test_does_not_pop_persisted_queue_when_lead_inbox_already_has_work(
        self, runtime
    ):
        """Avoid merging persisted queued messages into an already-pending lead turn."""
        await runtime.start()
        runtime._has_active_turn = True
        runtime.session_id = str(uuid.uuid7())
        runtime.state = "idle"
        runtime._activate_queued_user_messages = AsyncMock(return_value=True)

        runtime.state = "working"  # keep delivery from starting a turn
        await runtime.deliver(Message(from_agent="child", content="report"))
        runtime.state = "idle"  # isolate the inbox guard from activation state

        await runtime._try_activate_queued_after_turn()

        runtime._activate_queued_user_messages.assert_not_awaited()
        await runtime.stop()

    async def test_reactivates_lead_if_queued_send_left_inbox_pending(self, runtime):
        """If send happened while lead was still working, wake it once idle."""
        await runtime.start()
        runtime._has_active_turn = True
        runtime.session_id = str(uuid.uuid7())
        runtime.state = "idle"
        runtime._maybe_activate = MagicMock()

        async def activate(_session_id: str) -> bool:
            runtime._inbox.put_nowait(Message(from_agent="user", content="queued"))
            return True

        runtime._activate_queued_user_messages = AsyncMock(side_effect=activate)

        await runtime._try_activate_queued_after_turn()

        runtime._maybe_activate.assert_called_once_with()
        await runtime.stop()


class TestSessionRuntimeToolInjection:
    """Test get_injected_tools() — runtime tools injected into every turn."""

    async def test_agent_gets_the_delegation_tools(self, runtime):
        """The single session agent gets the spawn/send/list/stop/merge set."""
        tools = runtime.get_injected_tools()
        names = {t.name for t in tools}
        assert {
            "ask_user",
            "agent_spawn",
            "agent_send",
            "agent_list",
            "agent_stop",
            "agent_merge",
        }.issubset(names)
        assert "remember" not in names
        assert "recall" not in names
        assert "forget" not in names

    async def test_retired_roster_tools_are_not_injected(self, runtime):
        """Guard against the pre-``SessionRuntime`` roster surface coming back."""
        names = {t.name for t in runtime.get_injected_tools()}
        assert names.isdisjoint(
            {
                "send_message",
                "team_tasks",
                "broadcast",
                "team_message",
                "team_manage",
            }
        )

    # ``ask_user`` is reachable *only* through this injection point —
    # it is not in any prompt, registry, or agent config — so these are the
    # assertions that decide whether the feature exists at runtime at all.

    async def test_coding_agent_gets_ask_user(self, runtime):
        names = {t.name for t in runtime.get_injected_tools()}
        assert "ask_user" in names

    async def test_scheduler_session_does_not_get_ask_user(self, runtime):
        runtime.is_scheduler_session = True
        names = {t.name for t in runtime.get_injected_tools()}
        assert "ask_user" not in names

    async def test_max_depth_child_does_not_get_spawn_tool(self, runtime):
        from app.services.agent_spawn_service import MAX_SPAWN_DEPTH

        runtime.spawn_depth = MAX_SPAWN_DEPTH

        names = {tool.name for tool in runtime.get_injected_tools()}

        assert "agent_spawn" not in names
