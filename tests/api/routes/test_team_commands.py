"""Tests for ``POST /team/commands`` — slash-command dispatch.

Covers the route layer only — the team-level behaviour is tested in
``tests/agent/mode/team/test_team_continue.py``.  These tests verify
the HTTP shape: response codes, response body, and that
``ContinuePreconditionError`` maps to a 409 with a usable ``detail``.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlmodel import col, select

import app.core.db as _db
from app.agent.agent_loop import Agent
from app.agent.mode.team.member import TeamLead
from app.agent.mode.team.team import AgentTeam
from app.models.chat import ChatSession, SessionMessage
from app.services.chat_service import get_messages_for_llm
from tests.api.routes.test_team_db import MockProvider


@pytest_asyncio.fixture
async def app_with_lead_only_team():
    """App + a started team with one lead, no members.

    ``team.start()`` is awaited so the lead has a registered mailbox by the
    time ``handle_continue`` calls ``activate_for_continuation`` on the
    happy path — otherwise the spawned task hits
    ``assert self._mailbox is not None`` and the test leaks an orphan
    ``AssertionError``.
    """
    from app.api.app import create_app
    from app.services.team_manager import set_team

    lead = TeamLead(
        Agent(name="lead", llm_provider=MockProvider(), system_prompt="Lead"),
        db_factory=_db.async_session_factory,
    )
    team = AgentTeam(lead=lead, members={})
    await team.start()
    app = create_app()
    app.state.test_team = team
    set_team(team)
    get_session_team = AsyncMock(return_value=team)
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.services.team_manager.get_or_start_team_for_session",
            get_session_team,
        )
        try:
            yield app
        finally:
            set_team(None)
            await team.stop()


async def _seed_session_and_messages(
    session_id: uuid.UUID,
    msgs: list[tuple[str, str | None, list[dict] | None]],
) -> None:
    """Seed a session + a list of ``(role, content, tool_calls)`` rows."""
    import app.core.db as _db

    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(ChatSession(id=session_id, agent_name="lead"))
            for role, content, tool_calls in msgs:
                db.add(
                    SessionMessage(
                        session_id=session_id,
                        role=role,
                        content=content,
                        tool_calls=tool_calls,
                    )
                )


class TestPostTeamCommands:
    @pytest.mark.asyncio
    async def test_compact_returns_202_on_happy_path(
        self, app_with_lead_only_team, monkeypatch
    ):
        sid = uuid.uuid7()
        await _seed_session_and_messages(sid, [("user", "hello", None)])
        team = app_with_lead_only_team.state.test_team

        async def fake_compact(session_id: str) -> str:
            return session_id

        monkeypatch.setattr(team, "handle_compact", fake_compact)

        client = TestClient(app_with_lead_only_team)
        resp = client.post(
            "/api/team/commands",
            json={"command": "compact", "session_id": str(sid)},
        )

        assert resp.status_code == 202
        body = resp.json()
        assert body["status"] == "accepted"
        assert body["session_id"] == str(sid)
        assert body["command"] == "compact"

    @pytest.mark.asyncio
    async def test_compact_uses_coding_team_for_coding_session(
        self, app_with_lead_only_team, monkeypatch, tmp_path
    ):
        sid = uuid.uuid7()
        workspace = str(tmp_path)
        async with _db.async_session_factory() as db:
            async with db.begin():
                db.add(
                    ChatSession(
                        id=sid,
                        agent_name="lead",
                        mode="coding",
                        workspace=workspace,
                    )
                )
                db.add(SessionMessage(session_id=sid, role="user", content="hello"))

        default_team = app_with_lead_only_team.state.test_team
        coding_team = AgentTeam(
            lead=TeamLead(
                Agent(name="lead", llm_provider=MockProvider(), system_prompt="Lead"),
                db_factory=_db.async_session_factory,
            ),
            members={},
            mode="coding",
            workspace=workspace,
        )
        await coding_team.start()
        called: dict[str, object] = {}

        async def fake_get_or_start_coding_team(requested_workspace, session_id):
            called["workspace"] = requested_workspace
            called["session_id"] = session_id
            return coding_team

        async def default_compact(session_id: str) -> str:
            raise AssertionError("default team must not handle coding compaction")

        async def coding_compact(session_id: str) -> str:
            called["compact_session_id"] = session_id
            return session_id

        monkeypatch.setattr(default_team, "handle_compact", default_compact)
        monkeypatch.setattr(coding_team, "handle_compact", coding_compact)
        monkeypatch.setattr(
            "app.api.routes.team.chat.team_manager.get_or_start_coding_team",
            fake_get_or_start_coding_team,
        )

        try:
            client = TestClient(app_with_lead_only_team)
            resp = client.post(
                "/api/team/commands",
                json={"command": "compact", "session_id": str(sid)},
            )
        finally:
            await coding_team.stop()

        assert resp.status_code == 202
        assert called == {
            "workspace": workspace,
            "session_id": str(sid),
            "compact_session_id": str(sid),
        }

    @pytest.mark.asyncio
    async def test_undo_hides_latest_user_turn(self, app_with_lead_only_team):
        sid = uuid.uuid7()
        await _seed_session_and_messages(
            sid,
            [
                ("user", "first", None),
                ("assistant", "first answer", None),
                ("user", "second", None),
                ("assistant", "second answer", None),
            ],
        )

        client = TestClient(app_with_lead_only_team)
        resp = client.post(
            "/api/team/commands",
            json={"command": "undo", "session_id": str(sid)},
        )

        assert resp.status_code == 202
        body = resp.json()
        assert body["command"] == "undo"
        assert body["message"]["content"] == "second"
        assert body["changed_paths"] == {
            "added": [],
            "modified": [],
            "removed": [],
        }

        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, sid)
            rows = (
                await db.exec(
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == sid)
                    .order_by(col(SessionMessage.created_at).asc())
                )
            ).all()
            llm_messages = await get_messages_for_llm(db, sid)
        assert session is not None
        assert session.revert == {"message_id": body["message"]["id"]}
        assert [row.content for row in rows if row.exclude_from_context] == []
        assert [msg.content for msg in llm_messages] == ["first", "first answer"]

        history = client.get(f"/api/team/{sid}/history")
        assert history.status_code == 200
        history_body = history.json()
        assert history_body["lead"]["revert"] == {"message_id": body["message"]["id"]}
        assert [msg["content"] for msg in history_body["lead"]["messages"]] == [
            "first",
            "first answer",
            "second",
            "second answer",
        ]

    @pytest.mark.asyncio
    async def test_redo_restores_next_undone_turn(self, app_with_lead_only_team):
        sid = uuid.uuid7()
        await _seed_session_and_messages(
            sid,
            [
                ("user", "first", None),
                ("assistant", "first answer", None),
                ("user", "second", None),
                ("assistant", "second answer", None),
            ],
        )

        client = TestClient(app_with_lead_only_team)
        first = client.post(
            "/api/team/commands",
            json={"command": "undo", "session_id": str(sid)},
        )
        second = client.post(
            "/api/team/commands",
            json={"command": "undo", "session_id": str(sid)},
        )
        redo = client.post(
            "/api/team/commands",
            json={"command": "redo", "session_id": str(sid)},
        )

        assert first.status_code == 202
        assert second.status_code == 202
        assert redo.status_code == 202
        redo_body = redo.json()
        assert redo_body["command"] == "redo"
        assert redo_body["message"] is not None
        assert redo_body["message"]["id"] == first.json()["message"]["id"]
        assert redo_body["message"]["content"] == "second"
        assert redo_body["changed_paths"] == {
            "added": [],
            "modified": [],
            "removed": [],
        }

        cleared = client.post(
            "/api/team/commands",
            json={"command": "redo", "session_id": str(sid)},
        )
        assert cleared.status_code == 202
        cleared_body = cleared.json()
        assert cleared_body["command"] == "redo"
        assert cleared_body["message"] is None

        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, sid)
            rows = (
                await db.exec(
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == sid)
                    .order_by(col(SessionMessage.created_at).asc())
                )
            ).all()
            llm_messages = await get_messages_for_llm(db, sid)
        assert session is not None
        assert session.revert is None
        assert [row.content for row in rows if row.exclude_from_context] == []
        assert [msg.content for msg in llm_messages] == [
            "first",
            "first answer",
            "second",
            "second answer",
        ]

    @pytest.mark.asyncio
    async def test_redo_all_restores_all_undone_turns(self, app_with_lead_only_team):
        sid = uuid.uuid7()
        await _seed_session_and_messages(
            sid,
            [
                ("user", "first", None),
                ("assistant", "first answer", None),
                ("user", "second", None),
                ("assistant", "second answer", None),
                ("user", "third", None),
                ("assistant", "third answer", None),
            ],
        )

        client = TestClient(app_with_lead_only_team)
        # Undo two turns
        client.post(
            "/api/team/commands",
            json={"command": "undo", "session_id": str(sid)},
        )
        client.post(
            "/api/team/commands",
            json={"command": "undo", "session_id": str(sid)},
        )

        # Redo-all restores directly to the live tip in one step
        redo_all = client.post(
            "/api/team/commands",
            json={"command": "redo-all", "session_id": str(sid)},
        )
        assert redo_all.status_code == 202
        redo_body = redo_all.json()
        assert redo_body["command"] == "redo-all"
        assert redo_body["message"] is None

        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, sid)
            llm_messages = await get_messages_for_llm(db, sid)
        assert session is not None
        assert session.revert is None
        assert [msg.content for msg in llm_messages] == [
            "first",
            "first answer",
            "second",
            "second answer",
            "third",
            "third answer",
        ]

    @pytest.mark.asyncio
    async def test_undo_rejected_when_lead_is_working(self, app_with_lead_only_team):
        """Pre-existing precondition: lead's own turn is in flight.

        Regression guard for the original ``_has_active_turn`` check —
        the new member-busy guard must NOT short-circuit it.
        """
        sid = uuid.uuid7()
        await _seed_session_and_messages(
            sid,
            [("user", "first", None), ("assistant", "first answer", None)],
        )
        team = app_with_lead_only_team.state.test_team
        team._has_active_turn = True
        try:
            client = TestClient(app_with_lead_only_team)
            resp = client.post(
                "/api/team/commands",
                json={"command": "undo", "session_id": str(sid)},
            )
        finally:
            team._has_active_turn = False

        assert resp.status_code == 409
        # Must surface the original lead-working message, not the
        # new member-busy one — keeps existing UX intact.
        assert "lead is already working" in resp.json()["detail"].lower()

        # DB untouched.
        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, sid)
        assert session is not None
        assert session.revert is None

    @pytest.mark.asyncio
    async def test_undo_rejected_when_member_is_working(self, app_with_lead_only_team):
        """New behaviour: a member streaming while the lead is idle still
        blocks /undo. Without this guard the in-flight assistant tokens
        on the client get orphaned (the bug this fix addresses).
        """
        import types

        sid = uuid.uuid7()
        await _seed_session_and_messages(
            sid,
            [("user", "first", None), ("assistant", "first answer", None)],
        )
        team = app_with_lead_only_team.state.test_team
        assert team.lead.state != "working"

        # Stub a busy member — only ``.state`` and ``.name`` are read by
        # the guard, so a SimpleNamespace is sufficient and avoids
        # spinning up a real Agent + mailbox.
        team.members["worker"] = types.SimpleNamespace(name="worker", state="working")
        try:
            client = TestClient(app_with_lead_only_team)
            resp = client.post(
                "/api/team/commands",
                json={"command": "undo", "session_id": str(sid)},
            )
        finally:
            team.members.pop("worker", None)

        assert resp.status_code == 409
        detail = resp.json()["detail"].lower()
        # Error must identify *which* agent is busy so the UI can
        # surface a useful message.
        assert "worker" in detail
        assert "working" in detail

        # The /undo must short-circuit before touching the DB — no
        # boundary, no commit.
        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, sid)
        assert session is not None
        assert session.revert is None

    @pytest.mark.asyncio
    async def test_undo_member_in_error_state_does_not_block(
        self, app_with_lead_only_team
    ):
        """Negative case: only ``state == 'working'`` blocks /undo.

        A member that crashed (state='error') or went offline must not
        permanently lock the user out of /undo.
        """
        import types

        sid = uuid.uuid7()
        await _seed_session_and_messages(
            sid,
            [
                ("user", "first", None),
                ("assistant", "first answer", None),
                ("user", "second", None),
                ("assistant", "second answer", None),
            ],
        )
        team = app_with_lead_only_team.state.test_team
        team.members["dead"] = types.SimpleNamespace(name="dead", state="error")
        team.members["gone"] = types.SimpleNamespace(name="gone", state="offline")
        try:
            client = TestClient(app_with_lead_only_team)
            resp = client.post(
                "/api/team/commands",
                json={"command": "undo", "session_id": str(sid)},
            )
        finally:
            team.members.pop("dead", None)
            team.members.pop("gone", None)

        assert resp.status_code == 202, resp.text
        assert resp.json()["message"]["content"] == "second"

    @pytest.mark.asyncio
    async def test_unknown_command_rejected_by_validator(self, app_with_lead_only_team):
        """Pydantic Literal rejects unknown command strings as 422."""
        client = TestClient(app_with_lead_only_team)
        resp = client.post(
            "/api/team/commands",
            json={"command": "blow_up_session", "session_id": str(uuid.uuid7())},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_concurrent_redos_each_advance_boundary_one_step(
        self, app_with_lead_only_team
    ):
        """Two parallel /redo calls must NOT both land on the same target."""
        import asyncio

        from httpx import ASGITransport, AsyncClient

        sid = uuid.uuid7()
        await _seed_session_and_messages(
            sid,
            [
                ("user", "u1", None),
                ("assistant", "a1", None),
                ("user", "u2", None),
                ("assistant", "a2", None),
                ("user", "u3", None),
                ("assistant", "a3", None),
            ],
        )

        client = TestClient(app_with_lead_only_team)
        for _ in range(3):
            r = client.post(
                "/api/team/commands",
                json={"command": "undo", "session_id": str(sid)},
            )
            assert r.status_code == 202

        transport = ASGITransport(app=app_with_lead_only_team)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            r1, r2 = await asyncio.gather(
                ac.post(
                    "/api/team/commands",
                    json={"command": "redo", "session_id": str(sid)},
                ),
                ac.post(
                    "/api/team/commands",
                    json={"command": "redo", "session_id": str(sid)},
                ),
            )

        assert r1.status_code == 202
        assert r2.status_code == 202
        m1 = r1.json()["message"]
        m2 = r2.json()["message"]
        assert m1 is not None and m2 is not None
        assert m1["id"] != m2["id"], (
            f"both /redo responses landed on the same boundary "
            f"({m1['content']!r}) — concurrency race regressed"
        )
        assert {m1["content"], m2["content"]} == {"u2", "u3"}

        async with _db.async_session_factory() as db:
            session = await db.get(ChatSession, sid)
        assert session is not None
        assert session.revert is not None
        assert session.revert["message_id"] != m1["id"] or m1["content"] == "u3"
