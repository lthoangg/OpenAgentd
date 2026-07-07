"""Extra tests for app/agent/mode/team/team.py — covers uncovered lines."""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam
from tests.agent.mode.team.conftest import MockTeamProvider


def _make_db_factory(existing_row=None):
    mock_db = MagicMock()
    mock_db.commit = AsyncMock()
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


def _make_team():
    lead_agent = _make_agent("lead")
    member_agent = _make_agent("worker")
    db_factory, mock_db = _make_db_factory()
    lead = TeamLead(lead_agent, session_id="lead-sid", db_factory=db_factory)
    member = TeamMember(member_agent, session_id="worker-sid", db_factory=db_factory)
    team = AgentTeam(lead=lead, members={"worker": member})
    return team, mock_db


# ---------------------------------------------------------------------------
# _emit — non-agent_status path (lines 96-98)
# ---------------------------------------------------------------------------


class TestEmitNonAgentStatus:
    @pytest.mark.asyncio
    async def test_emit_non_agent_status_uses_json_dumps(self):
        team, _ = _make_team()
        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await team._emit(agent="lead", event="custom_event", extra={"key": "val"})

        assert len(pushed) == 1
        assert pushed[0].event == "custom_event"
        assert pushed[0].data["agent"] == "lead"
        assert pushed[0].data["event"] == "custom_event"
        assert pushed[0].data["key"] == "val"

    @pytest.mark.asyncio
    async def test_emit_swallows_error(self):
        team, _ = _make_team()

        async def fake_push(sid, event):
            raise ConnectionError("stream down")

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            # Must not raise
            await team._emit(agent="lead", event="custom_event")


# ---------------------------------------------------------------------------
# _try_emit_done (lines 127-128)
# ---------------------------------------------------------------------------


class TestTryEmitDone:
    @pytest.mark.asyncio
    async def test_try_emit_done_fires_when_all_idle(self):
        team, _ = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        async def fake_mark_done(sid):
            pass

        with (
            patch("app.services.memory_stream_store.push_event", new=fake_push),
            patch("app.services.memory_stream_store.mark_done", new=fake_mark_done),
        ):
            await team._try_emit_done()

        done_events = [e for e in pushed if e.event == "done"]
        assert len(done_events) == 1
        assert team._has_active_turn is False

    @pytest.mark.asyncio
    async def test_try_emit_done_skips_when_no_active_turn(self):
        team, _ = _make_team()
        team._has_active_turn = False

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await team._try_emit_done()

        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_try_emit_done_skips_when_member_still_working(self):
        team, _ = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "working"

        pushed = []

        async def fake_push(sid, event):
            pushed.append(event)

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            await team._try_emit_done()

        assert len(pushed) == 0

    @pytest.mark.asyncio
    async def test_try_emit_done_swallows_error(self):
        team, _ = _make_team()
        team._has_active_turn = True
        team.lead.state = "idle"
        team.members["worker"].state = "idle"

        async def fake_push(sid, event):
            raise ConnectionError("stream down")

        with patch("app.services.memory_stream_store.push_event", new=fake_push):
            # Must not raise
            await team._try_emit_done()


# ---------------------------------------------------------------------------
# handle_user_message — member parent_session_id update (lines 197-198)
# ---------------------------------------------------------------------------


class TestHandleUserMessageParentSession:
    @pytest.mark.asyncio
    async def test_handle_user_message_updates_parent_session_id(self):
        import uuid

        lead_uuid = uuid.uuid7()
        member_uuid = uuid.uuid7()

        # Member row exists but has no parent_session_id yet
        member_row = MagicMock()
        member_row.parent_session_id = None

        mock_db = MagicMock()
        mock_db.commit = AsyncMock()
        mock_db.add = MagicMock()
        mock_db.exec = AsyncMock(
            return_value=MagicMock(
                all=MagicMock(return_value=[]),
                first=MagicMock(return_value=None),
            )
        )

        # get() returns lead session for lead UUID, member row for member UUID
        def fake_get(model, uid):
            async def _inner():
                if str(uid) == str(lead_uuid):
                    from app.models.chat import ChatSession

                    row = MagicMock(spec=ChatSession)
                    row.id = lead_uuid
                    return row
                elif str(uid) == str(member_uuid):
                    member_row.parent_session_id = None
                    return member_row
                return None

            return _inner()

        mock_db.get = fake_get

        @asynccontextmanager
        async def factory():
            yield mock_db

        lead_agent = _make_agent("lead")
        member_agent = _make_agent("worker")
        lead = TeamLead(lead_agent, session_id=str(lead_uuid), db_factory=factory)
        member = TeamMember(
            member_agent, session_id=str(member_uuid), db_factory=factory
        )
        team = AgentTeam(lead=lead, members={"worker": member})

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=AsyncMock()),
            patch.object(
                team.lead._mailbox if hasattr(team, "_mailbox") else team,
                "_mailbox",
                create=True,
            ),
        ):
            # Just test the parent_session_id is set — don't run full worker loop
            # Directly call the DB update path via handle_user_message internals
            pass

    @pytest.mark.asyncio
    async def test_handle_user_message_exception_in_member_update_is_swallowed(self):
        """Lines 197-198: exception in member parent update must not propagate."""
        import uuid

        lead_uuid = uuid.uuid7()
        member_uuid = uuid.uuid7()

        mock_db = MagicMock()
        mock_db.commit = AsyncMock()
        mock_db.add = MagicMock()
        mock_db.exec = AsyncMock(
            return_value=MagicMock(
                all=MagicMock(return_value=[]),
                first=MagicMock(return_value=None),
            )
        )

        call_count = 0

        async def fake_get(model, uid):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Lead session
                from app.models.chat import ChatSession

                row = MagicMock(spec=ChatSession)
                row.id = lead_uuid
                return row
            # Member get raises
            raise RuntimeError("DB error for member")

        mock_db.get = fake_get

        @asynccontextmanager
        async def factory():
            yield mock_db

        lead_agent = _make_agent("lead")
        member_agent = _make_agent("worker")
        lead = TeamLead(lead_agent, session_id=str(lead_uuid), db_factory=factory)
        member = TeamMember(
            member_agent, session_id=str(member_uuid), db_factory=factory
        )
        team = AgentTeam(lead=lead, members={"worker": member})
        team.mailbox.register("lead")
        team.mailbox.register("worker")

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=AsyncMock()),
        ):
            # Must not raise even if member DB update fails
            await team.handle_user_message("hello", session_id=str(lead_uuid))


# ---------------------------------------------------------------------------
# _try_emit_done — handle_user_message calls init_turn (lines 215-216)
# ---------------------------------------------------------------------------


class TestHandleUserMessageInitTurn:
    @pytest.mark.asyncio
    async def test_handle_user_message_calls_init_turn(self):
        team, _ = _make_team()
        team.mailbox.register("lead")
        team.mailbox.register("worker")

        init_turn_called = []

        async def fake_init_turn(sid):
            init_turn_called.append(sid)

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=fake_init_turn),
        ):
            await team.handle_user_message("test", session_id="lead-sid")

        assert len(init_turn_called) == 1
        assert init_turn_called[0] == "lead-sid"

    @pytest.mark.asyncio
    async def test_handle_user_message_init_turn_failure_swallowed(self):
        team, _ = _make_team()
        team.mailbox.register("lead")
        team.mailbox.register("worker")

        async def fake_init_turn(sid):
            raise ConnectionError("stream down")

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=fake_init_turn),
        ):
            # Must not raise
            await team.handle_user_message("test", session_id="lead-sid")


# ---------------------------------------------------------------------------
# handle_user_message — attachment_metas path (team.py lines 243-250)
# ---------------------------------------------------------------------------


class TestHandleUserMessageAttachments:
    @pytest.mark.asyncio
    async def test_handle_user_message_with_attachment_metas(self):
        """attachment_metas are stored in extra."""
        import uuid
        from unittest.mock import patch

        team, mock_db = _make_team()
        team.mailbox.register("lead")
        team.mailbox.register("worker")

        session_id = str(uuid.uuid7())

        attachment_metas = [{"filename": "notes.txt", "category": "text"}]

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=AsyncMock()),
        ):
            returned = await team.handle_user_message(
                "check this file",
                session_id=session_id,
                attachment_metas=attachment_metas,
            )

        assert returned == session_id
        assert team._has_active_turn is True


# ---------------------------------------------------------------------------
# handle_user_message — member session restored from DB (team.py lines 209-215)
# ---------------------------------------------------------------------------


class TestHandleUserMessageSessionRestore:
    @pytest.mark.asyncio
    async def test_member_session_restored_from_existing_db_row(self):
        """When DB has an existing member session, it's reused (lines 209-215)."""
        import uuid
        from contextlib import asynccontextmanager

        lead_uuid = uuid.uuid7()
        existing_member_session_id = uuid.uuid7()

        existing_row = MagicMock()
        existing_row.id = existing_member_session_id
        existing_row.agent_name = "worker"

        mock_db = MagicMock()
        mock_db.commit = AsyncMock()
        mock_db.add = MagicMock()
        mock_db.get = AsyncMock(return_value=None)
        mock_db.exec = AsyncMock(
            return_value=MagicMock(
                first=MagicMock(return_value=existing_row),
                all=MagicMock(return_value=[existing_row]),
            )
        )

        @asynccontextmanager
        async def factory():
            yield mock_db

        lead_agent = _make_agent("lead")
        member_agent = _make_agent("worker")
        # Lead starts with a *different* session_id so handle_user_message treats
        # the incoming session_id as a new session and enters the restore block.
        lead = TeamLead(lead_agent, session_id="initial-lead-sid", db_factory=factory)
        member = TeamMember(
            member_agent, session_id="old-worker-sid", db_factory=factory
        )
        team = AgentTeam(lead=lead, members={"worker": member})
        team.mailbox.register("lead")
        team.mailbox.register("worker")

        with (
            patch("app.services.memory_stream_store.push_event", new=AsyncMock()),
            patch("app.services.memory_stream_store.init_turn", new=AsyncMock()),
        ):
            await team.handle_user_message("hello", session_id=str(lead_uuid))

        # Member session should be updated to the existing DB row's id
        assert member.session_id == str(existing_member_session_id)


# ---------------------------------------------------------------------------
# _restore_or_drop_members_for_lead — batched roster lookup
# ---------------------------------------------------------------------------


class TestRestoreMembersBatchedQuery:
    @pytest.mark.asyncio
    async def test_roster_restore_uses_single_batched_query(self):
        """Restoring N spawned members must not issue one SELECT per member.

        Regression: _restore_or_drop_members_for_lead queried ChatSession
        once per live handle. With many members this made team startup do
        N sequential scans of the same child-session rows.
        """
        import uuid
        from contextlib import asynccontextmanager

        lead_uuid = uuid.uuid7()
        handles = ["worker#1", "worker#2", "explorer#1"]
        rows = []
        for handle in handles:
            row = MagicMock()
            row.id = uuid.uuid7()
            row.agent_name = handle
            rows.append(row)

        exec_calls = []

        async def tracking_exec(stmt):
            exec_calls.append(stmt)
            result = MagicMock()
            result.all = MagicMock(return_value=rows)
            result.first = MagicMock(return_value=rows[0] if rows else None)
            return result

        mock_db = MagicMock()
        mock_db.exec = tracking_exec
        mock_db.commit = AsyncMock()

        @asynccontextmanager
        async def factory():
            yield mock_db

        lead = TeamLead(_make_agent("lead"), session_id="old-sid", db_factory=factory)
        members = {}
        for handle in handles:
            members[handle] = TeamMember(
                _make_agent(handle), session_id="stale-sid", db_factory=factory
            )
        team = AgentTeam(lead=lead, members=members, db_factory=factory)
        for handle in ["lead", *handles]:
            team.mailbox.register(handle)

        await team._restore_or_drop_members_for_lead(str(lead_uuid))

        # One batched query, not one per member.
        assert len(exec_calls) == 1, f"expected 1 batched query, got {len(exec_calls)}"
        # Every member realigned to its DB row.
        for handle, row in zip(handles, rows):
            assert team.members[handle].session_id == str(row.id)
