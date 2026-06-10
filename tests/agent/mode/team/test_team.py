"""Tests for app/agent/mode/team/team.py — AgentTeam coordination."""

from __future__ import annotations

import asyncio
import uuid
from contextlib import suppress
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.mode.team.team import LoopState
from app.models.chat import ChatSession, SessionMessage


class TestAgentTeamConstruction:
    """Test AgentTeam initialization."""

    async def test_construct_basic_team(self, basic_team):
        team = basic_team
        assert team.lead.name == "lead"
        assert "member_a" in team.members
        assert "member_b" in team.members

    async def test_team_owns_mailbox(self, basic_team):
        assert basic_team.mailbox is not None

    async def test_team_has_on_message_callback(self, basic_team):
        """Mailbox is wired with the team's on_message callback."""
        assert basic_team.mailbox._on_message is not None


class TestAgentTeamStartStop:
    """Test team lifecycle — start and stop."""

    async def test_start_registers_agents_in_mailbox(self, basic_team):
        team = basic_team
        await team.start()

        registered = team.mailbox.registered_agents
        assert "lead" in registered
        assert "member_a" in registered
        assert "member_b" in registered

        await team.stop()

    async def test_start_does_not_create_background_tasks(self, basic_team):
        """After start(), agents are idle but no tasks are running."""
        team = basic_team
        await team.start()

        assert team.lead._active_task is None
        assert team.members["member_a"]._active_task is None
        assert team.members["member_b"]._active_task is None

        await team.stop()

    async def test_start_sets_agents_to_idle(self, basic_team):
        """After start(), all agents are in 'idle' state."""
        team = basic_team
        await team.start()

        assert team.lead.state == "idle"
        assert team.members["member_a"].state == "idle"
        assert team.members["member_b"].state == "idle"

        await team.stop()

    async def test_stop_deregisters_agents(self, basic_team):
        team = basic_team
        await team.start()
        await team.stop()

        # After stop, agents should be deregistered
        assert "lead" not in team.mailbox.registered_agents
        assert "member_a" not in team.mailbox.registered_agents
        assert "member_b" not in team.mailbox.registered_agents


class TestAgentTeamUserMessage:
    """Test handle_user_message() — user interaction entry point."""

    async def test_handle_user_message_delivers_to_lead(self, basic_team):
        team = basic_team
        await team.start()

        session_id = str(uuid.uuid7())
        await team.handle_user_message("Hello team", session_id=session_id)

        # Message was delivered — lead should be activated
        # Give the activation task a moment to start
        await asyncio.sleep(0.1)
        await team.stop()

    async def test_handle_user_message_sets_lead_session(self, basic_team):
        team = basic_team
        await team.start()

        old_session = team.lead.session_id
        new_session = str(uuid.uuid7())

        await team.handle_user_message("Hi", session_id=new_session)

        assert team.lead.session_id == new_session
        assert team.lead.session_id != old_session

        await asyncio.sleep(0.1)
        await team.stop()

    async def test_handle_user_message_preserves_same_session(self, basic_team):
        team = basic_team
        await team.start()

        session = str(uuid.uuid7())
        await team.handle_user_message("First", session_id=session)
        await team.handle_user_message("Second", session_id=session)
        assert team.lead.session_id == session

        await asyncio.sleep(0.1)
        await team.stop()

    async def test_handle_user_message_with_interrupt(self, basic_team):
        team = basic_team
        await team.start()

        team.lead.state = "working"
        team.members["member_a"].state = "working"

        await team.handle_user_message(
            "New direction", session_id=str(uuid.uuid7()), interrupt=True
        )

        assert team.lead._cancel_event.is_set()
        assert team.members["member_a"]._cancel_event.is_set()
        assert not team.members["member_b"]._cancel_event.is_set()

        await team.stop()

    async def test_handle_user_message_sets_active_turn_flag(self, basic_team):
        team = basic_team
        await team.start()

        assert not team._has_active_turn
        await team.handle_user_message("Hi", session_id=str(uuid.uuid7()))
        assert team._has_active_turn

        await asyncio.sleep(0.1)
        await team.stop()

    async def test_handle_user_message_continues_on_db_failure(self, basic_team):
        team = basic_team
        team.lead.db_factory = MagicMock(
            side_effect=RuntimeError("DB connection failed")
        )
        await team.start()

        session_id = str(uuid.uuid7())
        await team.handle_user_message("Hello", session_id=session_id)

        assert team._has_active_turn

        if team.lead._active_task is not None:
            with suppress(RuntimeError):
                await team.lead._active_task
        await team.stop()

    async def test_handle_user_message_returns_session_id(self, basic_team):
        """handle_user_message() returns the session_id for stream subscription."""
        team = basic_team
        await team.start()
        session_id = str(uuid.uuid7())
        returned = await team.handle_user_message("Hello", session_id=session_id)
        assert returned == session_id
        await asyncio.sleep(0.1)
        await team.stop()

    async def test_handle_user_message_initialises_turn(self, basic_team):
        """handle_user_message() calls stream_store.init_turn() synchronously."""
        from unittest.mock import AsyncMock, patch

        team = basic_team
        await team.start()

        session_id = str(uuid.uuid7())
        with patch(
            "app.services.memory_stream_store.init_turn", new_callable=AsyncMock
        ) as mock_init:
            await team.handle_user_message("Hello", session_id=session_id)
            mock_init.assert_awaited_once_with(session_id)

        await asyncio.sleep(0.1)
        await team.stop()

    async def test_handle_user_message_persists_session_model_settings_and_turn_metadata(
        self, basic_team
    ):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        team = basic_team
        team.lead.db_factory = db_factory
        team.mailbox.send = AsyncMock()
        session_id = str(uuid.uuid7())

        try:
            await team.handle_user_message(
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

    async def test_loop_control_command_does_not_persist_or_deliver_user_message(
        self, basic_team, mock_stream_store
    ):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        team = basic_team
        team.mode = "coding"
        team.lead.db_factory = db_factory
        team.mailbox.send = AsyncMock()
        session_id = str(uuid.uuid7())

        try:
            await team.handle_user_message("/loop:set 20", session_id=session_id)

            assert team._loop_limits[session_id] == 20
            team.mailbox.send.assert_not_awaited()
            pushed_events = [
                call.args[1].event for call in mock_stream_store.await_args_list
            ]
            assert "loop_status" in pushed_events
            async with db_factory() as db:
                messages = (await db.exec(select(SessionMessage))).all()
                assert messages == []
        finally:
            await engine.dispose()

    async def test_loop_start_persists_only_prompt_and_delivers_prompt(
        self, basic_team
    ):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        team = basic_team
        team.mode = "coding"
        team.lead.db_factory = db_factory
        team.mailbox.send = AsyncMock()
        session_id = str(uuid.uuid7())

        try:
            await team.handle_user_message("/loop just say hi", session_id=session_id)

            team.mailbox.send.assert_awaited_once()
            sent = team.mailbox.send.await_args.kwargs["message"]
            assert sent.content == "[user]: just say hi"
            async with db_factory() as db:
                messages = (await db.exec(select(SessionMessage))).all()
                user_rows = [row for row in messages if row.role == "user"]
                assert len(user_rows) == 1
                assert user_rows[0].content == "just say hi"
        finally:
            await engine.dispose()

    async def test_loop_pause_resume_stop_are_control_commands_only(self, basic_team):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        team = basic_team
        team.mode = "coding"
        team.lead.db_factory = db_factory
        team.mailbox.send = AsyncMock()
        session_id = str(uuid.uuid7())
        team._loop_states[session_id] = LoopState(prompt="keep going", remaining=2)

        try:
            await team.handle_user_message("/loop:pause", session_id=session_id)
            assert team._loop_states[session_id].paused is True
            await team.handle_user_message("/loop:resume", session_id=session_id)
            assert team._loop_states[session_id].paused is False
            await team.handle_user_message("/loop:stop", session_id=session_id)
            assert session_id not in team._loop_states
            team.mailbox.send.assert_not_awaited()
            async with db_factory() as db:
                messages = (await db.exec(select(SessionMessage))).all()
                assert messages == []
        finally:
            await engine.dispose()

    async def test_handle_user_message_reset_clears_session_override_but_stamps_default_model(
        self, basic_team
    ):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        team = basic_team
        team.lead.db_factory = db_factory
        team.mailbox.send = AsyncMock()
        session_uuid = uuid.uuid7()

        async with db_factory() as db:
            db.add(
                ChatSession(
                    id=session_uuid,
                    agent_name="lead",
                    model="openai:gpt-5.5",
                    thinking_level="high",
                )
            )
            await db.commit()

        try:
            await team.handle_user_message(
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
                assert user_rows[0].extra["model"] == team.lead.agent.model_id
                assert "thinking_level" not in user_rows[0].extra
        finally:
            await engine.dispose()


class TestAgentTeamDoneDetection:
    """Test _try_emit_done() — detecting when team is done."""

    async def test_try_emit_done_requires_active_turn(
        self, basic_team, mock_stream_store
    ):
        """_try_emit_done() doesn't emit if _has_active_turn is False."""
        team = basic_team
        team._has_active_turn = False
        team.lead.state = "idle"
        for m in team.members.values():
            m.state = "idle"

        initial_calls = mock_stream_store.call_count
        await team._try_emit_done()

        # No new stream push for done
        done_calls = [
            c
            for c in mock_stream_store.call_args_list[initial_calls:]
            if c.args[1].event == "done"
        ]
        assert len(done_calls) == 0

    async def test_try_emit_done_emits_when_all_idle(
        self, basic_team, mock_stream_store
    ):
        """_try_emit_done() pushes done when all idle."""
        team = basic_team
        team._has_active_turn = True
        team.lead.state = "idle"
        for m in team.members.values():
            m.state = "idle"

        await team._try_emit_done()

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "done" in events

    async def test_try_emit_done_does_not_emit_if_any_working(
        self, basic_team, mock_stream_store
    ):
        """_try_emit_done() doesn't emit if any member is working."""
        team = basic_team
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["member_a"].state = "working"
        team.members["member_b"].state = "idle"

        initial_calls = mock_stream_store.call_count
        await team._try_emit_done()

        done_calls = [
            c
            for c in mock_stream_store.call_args_list[initial_calls:]
            if c.args[1].event == "done"
        ]
        assert len(done_calls) == 0

    async def test_try_emit_done_emits_when_error_state(
        self, basic_team, mock_stream_store
    ):
        """_try_emit_done() emits done even when agents are in error state."""
        team = basic_team
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["member_a"].state = "error"
        team.members["member_b"].state = "idle"

        await team._try_emit_done()

        events = [c.args[1].event for c in mock_stream_store.call_args_list]
        assert "done" in events

    async def test_try_emit_done_resets_flag(self, basic_team):
        """_try_emit_done() resets _has_active_turn after emitting."""
        team = basic_team
        team._has_active_turn = True
        team.lead.state = "idle"
        for m in team.members.values():
            m.state = "idle"

        await team._try_emit_done()
        assert team._has_active_turn is False

    async def test_activate_queued_messages_emits_queued_turn_start(
        self, basic_team, mock_stream_store
    ):
        team = basic_team
        queued = [MagicMock(id=uuid.uuid7(), content="queued")]
        team.mailbox.send = AsyncMock()

        with patch(
            "app.agent.mode.team.team.pop_queued_user_messages",
            new=AsyncMock(return_value=queued),
        ):
            activated = await team._activate_queued_user_messages(str(uuid.uuid7()))

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
        team.mailbox.send.assert_awaited_once()

    async def test_activates_queued_messages_after_lead_done_before_members_idle(
        self, basic_team
    ):
        """Lead-idle queue handoff must not wait for delegated members."""
        team = basic_team
        team._has_active_turn = True
        team.lead.session_id = str(uuid.uuid7())
        team.lead.state = "idle"
        team.members["member_a"].state = "working"
        team.members["member_b"].state = "idle"
        team._activate_queued_user_messages = AsyncMock(return_value=True)

        await team._try_activate_queued_after_lead_turn()

        team._activate_queued_user_messages.assert_awaited_once_with(
            team.lead.session_id
        )
        assert team._has_active_turn is True

    async def test_does_not_activate_queue_before_lead_turn_is_done(self, basic_team):
        """Queued rows stay persisted while the lead is still inside its loop."""
        team = basic_team
        team._has_active_turn = True
        team.lead.session_id = str(uuid.uuid7())
        team.lead.state = "working"
        team._activate_queued_user_messages = AsyncMock(return_value=True)

        await team._try_activate_queued_after_lead_turn()

        team._activate_queued_user_messages.assert_not_awaited()

    async def test_does_not_activate_queue_without_active_turn(self, basic_team):
        """No queued handoff should happen after cancellation/done reset the turn."""
        team = basic_team
        team._has_active_turn = False
        team.lead.session_id = str(uuid.uuid7())
        team.lead.state = "idle"
        team._activate_queued_user_messages = AsyncMock(return_value=True)

        await team._try_activate_queued_after_lead_turn()

        team._activate_queued_user_messages.assert_not_awaited()

    async def test_does_not_pop_persisted_queue_when_lead_inbox_already_has_work(
        self, basic_team
    ):
        """Avoid merging persisted queued messages into an already-pending lead turn."""
        team = basic_team
        await team.start()
        team._has_active_turn = True
        team.lead.session_id = str(uuid.uuid7())
        team.lead.state = "idle"
        team._activate_queued_user_messages = AsyncMock(return_value=True)

        await team.mailbox.send(
            to=team.lead.name,
            message=MagicMock(from_agent="member_a", to_agent=team.lead.name),
        )
        team.lead.state = "idle"  # isolate the inbox guard from activation state

        await team._try_activate_queued_after_lead_turn()

        team._activate_queued_user_messages.assert_not_awaited()
        await team.stop()

    async def test_reactivates_lead_if_queued_send_left_inbox_pending(self, basic_team):
        """If send happened while lead was still working, wake it once idle."""
        team = basic_team
        await team.start()
        team._has_active_turn = True
        team.lead.session_id = str(uuid.uuid7())
        team.lead.state = "idle"
        team.lead._maybe_activate = MagicMock()

        async def activate(_session_id: str) -> bool:
            await team.mailbox._inboxes[team.lead.name].put(
                MagicMock(from_agent="user", to_agent=team.lead.name)
            )
            return True

        team._activate_queued_user_messages = AsyncMock(side_effect=activate)

        await team._try_activate_queued_after_lead_turn()

        team.lead._maybe_activate.assert_called_once_with()
        await team.stop()


class TestAgentTeamToolInjection:
    """Test get_injected_tools() — tool injection per agent role (peer model)."""

    async def test_lead_gets_team_message_tool(self, basic_team):
        """Lead gets team_message — same as members (peer model)."""
        team = basic_team
        tools = team.get_injected_tools("lead")
        names = {t.name for t in tools}
        assert "team_message" in names

    async def test_lead_gets_team_message_and_manage(self, basic_team):
        """Lead gets messaging and roster management tools."""
        team = basic_team
        tools = team.get_injected_tools("lead")
        names = {t.name for t in tools}
        assert names == {
            "team_message",
            "todo_manage",
            "team_manage",
        }
        assert "remember" not in names
        assert "recall" not in names
        assert "forget" not in names

    async def test_lead_does_not_get_send_message(self, basic_team):
        """Old send_message removed — lead uses team_message now."""
        team = basic_team
        tools = team.get_injected_tools("lead")
        names = {t.name for t in tools}
        assert "send_message" not in names

    async def test_lead_does_not_get_team_tasks(self, basic_team):
        """team_tasks no longer injected via get_injected_tools."""
        team = basic_team
        tools = team.get_injected_tools("lead")
        names = {t.name for t in tools}
        assert "team_tasks" not in names

    async def test_lead_does_not_get_broadcast(self, basic_team):
        """broadcast removed — lead no longer has it."""
        team = basic_team
        tools = team.get_injected_tools("lead")
        names = {t.name for t in tools}
        assert "broadcast" not in names

    async def test_member_gets_team_message_tool(self, basic_team):
        """Members get team_message."""
        team = basic_team
        tools = team.get_injected_tools("member_a")
        names = {t.name for t in tools}
        assert "team_message" in names

    async def test_member_gets_message_and_todo_tools(self, basic_team):
        """Members get messaging plus todo claiming."""
        team = basic_team
        tools = team.get_injected_tools("member_a")
        names = {t.name for t in tools}
        assert names == {"team_message", "todo_manage"}

    async def test_member_does_not_get_old_message_tools(self, basic_team):
        """Old message_leader and send_message removed from member tools."""
        team = basic_team
        tools = team.get_injected_tools("member_a")
        names = {t.name for t in tools}
        assert "message_leader" not in names
        assert "send_message" not in names

    async def test_member_does_not_get_broadcast(self, basic_team):
        """broadcast removed from member tools."""
        team = basic_team
        tools = team.get_injected_tools("member_a")
        names = {t.name for t in tools}
        assert "broadcast" not in names

    async def test_member_does_not_get_team_tasks(self, basic_team):
        """team_tasks no longer injected via get_injected_tools."""
        team = basic_team
        tools = team.get_injected_tools("member_a")
        names = {t.name for t in tools}
        assert "team_tasks" not in names

    async def test_lead_and_member_both_get_team_message(self, basic_team):
        """Lead and members both get 'team_message' — true peer model."""
        team = basic_team
        lead_names = {t.name for t in team.get_injected_tools("lead")}
        member_names = {t.name for t in team.get_injected_tools("member_a")}
        assert "team_message" in lead_names
        assert "team_message" in member_names
        assert "todo_manage" in lead_names
        assert "todo_manage" in member_names

    async def test_member_does_not_get_memory_tools(self, basic_team):
        """Members don't get memory tools — only the lead writes memory."""
        team = basic_team
        tools = team.get_injected_tools("member_a")
        names = {t.name for t in tools}
        assert "remember" not in names
        assert "recall" not in names
        assert "forget" not in names
        assert names == {"team_message", "todo_manage"}


class TestAgentTeamStatus:
    """Test status() — introspection."""

    async def test_status_returns_dict(self, basic_team):
        status = basic_team.status()
        assert isinstance(status, dict)

    async def test_status_includes_lead_info(self, basic_team):
        status = basic_team.status()
        assert status["lead"]["name"] == "lead"
        assert "state" in status["lead"]

    async def test_status_includes_member_info(self, basic_team):
        status = basic_team.status()
        member_names = {m["name"] for m in status["members"]}
        assert "member_a" in member_names
        assert "member_b" in member_names

    async def test_status_reflects_current_states(self, basic_team):
        team = basic_team
        team.lead.state = "working"
        team.members["member_a"].state = "idle"
        team.members["member_b"].state = "working"

        status = team.status()
        assert status["lead"]["state"] == "working"
        assert (
            next(m for m in status["members"] if m["name"] == "member_a")["state"]
            == "idle"
        )
        assert (
            next(m for m in status["members"] if m["name"] == "member_b")["state"]
            == "working"
        )


class TestAgentTeamAllMembers:
    """Test all_members property."""

    async def test_all_members_includes_lead(self, basic_team):
        assert basic_team.lead in basic_team.all_members

    async def test_all_members_includes_regular_members(self, basic_team):
        member_names = {m.name for m in basic_team.all_members}
        assert "lead" in member_names
        assert "member_a" in member_names
        assert "member_b" in member_names

    async def test_all_members_count(self, basic_team):
        assert len(basic_team.all_members) == 3
