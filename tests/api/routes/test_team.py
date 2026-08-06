"""Tests for app/api/routes/team.py — team endpoints."""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.agent.agent_loop import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.tools.builtin.date import get_date
from app.agent.mode.team.member import TeamLead, TeamMember
from app.agent.mode.team.team import AgentTeam
from app.api.routes.team._helpers import _message_response
from app.models.chat import SessionMessage


def test_message_response_strips_internal_attachment_paths():
    msg = SessionMessage(
        session_id=uuid.uuid7(),
        role="user",
        content="see image",
        extra={
            "attachments": [
                {
                    "filename": "abc.png",
                    "original_name": "photo.png",
                    "category": "image",
                    "url": "/api/team/sid/uploads/abc.png",
                    "path": "/tmp/openagentd/sid/uploads/abc.png",
                    "workspace_path": "/tmp/openagentd/sid/uploads/abc.png",
                    "converted_text": "internal",
                }
            ]
        },
    )

    resp = _message_response(msg)

    expected = [
        {
            "filename": "abc.png",
            "original_name": "photo.png",
            "category": "image",
            "url": "/api/team/sid/uploads/abc.png",
        }
    ]
    assert resp.attachments == expected
    assert resp.extra == {"attachments": expected}


class MockTestProvider(LLMProviderBase):
    """Mock LLM provider."""

    model = "mock"

    def stream(self, messages, tools=None, **kwargs):
        from app.agent.schemas.chat import (
            ChatCompletionChunk,
            ChatCompletionChunkChoice,
            ChatCompletionDelta,
        )

        async def gen():
            yield ChatCompletionChunk(
                id="1",
                created=1000,
                model="mock",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(content="OK"),
                        finish_reason="stop",
                    )
                ],
            )

        return gen()

    async def chat(self, messages, tools=None, **kwargs):
        from app.agent.schemas.chat import AssistantMessage

        return AssistantMessage(content="OK")


@pytest.fixture
def test_team():
    """Create a test team (not started)."""
    agent_lead = Agent(
        name="lead",
        llm_provider=MockTestProvider(),
        system_prompt="Lead",
        mcp_servers=["filesystem"],
    )
    agent_worker = Agent(
        name="worker", llm_provider=MockTestProvider(), system_prompt="Worker"
    )

    lead = TeamLead(agent_lead)
    worker = TeamMember(agent_worker)

    team = AgentTeam(lead=lead, members={"worker": worker})
    return team


@pytest.fixture
def app_with_team(test_team, monkeypatch):
    """Create FastAPI app with team attached."""
    from app.api.app import create_app
    from app.services.team_manager import set_team

    app = create_app()
    set_team(test_team)

    async def get_session_team(_session_id: str):
        return test_team

    async def get_coding_team(_workspace: str, _session_id: str):
        return test_team

    monkeypatch.setattr(
        "app.services.team_manager.get_or_start_team_for_session", get_session_team
    )
    monkeypatch.setattr(
        "app.services.team_manager.get_or_start_coding_team", get_coding_team
    )
    yield app
    set_team(None)


@pytest.fixture
def app_without_team():
    """Create FastAPI app without team."""
    from app.api.app import create_app
    from app.services.team_manager import set_team

    app = create_app()
    set_team(None)
    return app


class TestTeamChatRoute:
    """Test POST /team/chat endpoint."""

    def test_team_chat_no_team_returns_404(self, app_without_team):
        client = TestClient(app_without_team)
        response = client.post("/api/team/chat", data={"message": "Hello"})
        assert response.status_code == 404
        assert "No agent team" in response.json()["detail"]

    def test_team_chat_returns_202(self, app_with_team, test_team):
        test_team.handle_user_message = AsyncMock(
            return_value=(str(uuid.uuid7()), str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": "Hello team"})
        assert response.status_code == 202

    def test_team_chat_returns_session_id(self, app_with_team, test_team):
        sid = str(uuid.uuid7())
        test_team.handle_user_message = AsyncMock(return_value=(sid, str(uuid.uuid7())))
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": "Hello"})
        data = response.json()
        assert "session_id" in data
        assert data["status"] == "accepted"

    def test_team_chat_with_provided_session_id(self, app_with_team, test_team):
        session_id = str(uuid.uuid7())
        test_team.handle_user_message = AsyncMock(
            return_value=(session_id, str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        response = client.post(
            "/api/team/chat", data={"message": "Hello", "session_id": session_id}
        )
        data = response.json()
        assert data["session_id"] == session_id

    def test_team_chat_invalid_session_id_returns_422(self, app_with_team):
        client = TestClient(app_with_team)
        response = client.post(
            "/api/team/chat", data={"message": "Hello", "session_id": "not-a-uuid"}
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "Invalid session id."

    def test_team_chat_generates_session_id_when_omitted(
        self, app_with_team, test_team
    ):
        test_team.handle_user_message = AsyncMock(
            return_value=(str(uuid.uuid7()), str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": "Hello"})
        uuid.UUID(response.json()["session_id"])  # Should not raise

    def test_team_chat_interrupt_flag(self, app_with_team, test_team):
        """Interrupt-only (no message) returns 202 with status=interrupted."""
        client = TestClient(app_with_team)
        sid = str(uuid.uuid7())
        response = client.post(
            "/api/team/chat", data={"interrupt": "true", "session_id": sid}
        )
        assert response.status_code == 202
        data = response.json()
        assert data["status"] == "interrupted"
        assert data["session_id"] == sid

    def test_team_chat_interrupt_with_message_rejected(self, app_with_team, test_team):
        """Interrupt + message is mutually exclusive — 422."""
        client = TestClient(app_with_team)
        response = client.post(
            "/api/team/chat",
            data={
                "message": "Redirect",
                "interrupt": "true",
                "session_id": str(uuid.uuid7()),
            },
        )
        assert response.status_code == 422

    def test_team_chat_calls_handle_user_message(self, app_with_team, test_team):
        test_team.handle_user_message = AsyncMock(
            return_value=(str(uuid.uuid7()), str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": "Hello team"})
        assert response.status_code == 202
        test_team.handle_user_message.assert_awaited_once()
        assert test_team.handle_user_message.call_args.kwargs["content"] == "Hello team"

    def test_team_chat_shell_dispatches_bang_command(self, app_with_team, test_team):
        client = TestClient(app_with_team)
        session_id = str(uuid.uuid7())
        with patch(
            "app.api.routes.team.chat.agent_service.dispatch_user_shell_command",
            AsyncMock(return_value=session_id),
        ) as dispatch_shell:
            response = client.post(
                "/api/team/chat",
                data={"message": "!ls -la", "session_id": session_id, "shell": "true"},
            )

        assert response.status_code == 202
        assert response.json()["session_id"] == session_id
        dispatch_shell.assert_awaited_once()
        assert dispatch_shell.call_args.kwargs["command"] == "ls -la"
        assert dispatch_shell.call_args.kwargs["session_id"] == session_id

    def test_team_chat_passes_model_settings(self, app_with_team, test_team):
        test_team.handle_user_message = AsyncMock(
            return_value=(str(uuid.uuid7()), str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        with patch(
            "app.api.routes.team.chat.is_registered_model_id",
            AsyncMock(return_value=True),
        ):
            response = client.post(
                "/api/team/chat",
                data={
                    "message": "Hello team",
                    "model": "openai:gpt-5.5",
                    "thinking_level": "high",
                },
            )
        assert response.status_code == 202
        kwargs = test_team.handle_user_message.call_args.kwargs
        assert kwargs["model"] == "openai:gpt-5.5"
        assert kwargs["model_provided"] is True
        assert kwargs["thinking_level"] == "high"
        assert kwargs["thinking_level_provided"] is True

    def test_team_chat_passes_fast_mode_per_request_for_codex(
        self, app_with_team, test_team
    ):
        test_team.handle_user_message = AsyncMock(
            return_value=(str(uuid.uuid7()), str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        with patch(
            "app.api.routes.team.chat.is_registered_model_id",
            AsyncMock(return_value=True),
        ):
            response = client.post(
                "/api/team/chat",
                data={
                    "message": "Hello team",
                    "model": "codex:gpt-5.4",
                    "fast_mode": "true",
                },
            )
        assert response.status_code == 202
        kwargs = test_team.handle_user_message.call_args.kwargs
        assert kwargs["service_tier"] == "fast"

    def test_team_chat_passes_fast_mode_for_non_codex_model(
        self, app_with_team, test_team
    ):
        test_team.handle_user_message = AsyncMock(
            return_value=(str(uuid.uuid7()), str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        with patch(
            "app.api.routes.team.chat.is_registered_model_id",
            AsyncMock(return_value=True),
        ):
            response = client.post(
                "/api/team/chat",
                data={
                    "message": "Hello team",
                    "model": "openai:gpt-5.5",
                    "fast_mode": "true",
                },
            )
        assert response.status_code == 202
        kwargs = test_team.handle_user_message.call_args.kwargs
        assert kwargs["service_tier"] == "fast"

    def test_team_chat_empty_model_settings_reset(self, app_with_team, test_team):
        test_team.handle_user_message = AsyncMock(
            return_value=(str(uuid.uuid7()), str(uuid.uuid7()))
        )
        client = TestClient(app_with_team)
        response = client.post(
            "/api/team/chat",
            data={"message": "Hello team", "model": "", "thinking_level": ""},
        )
        assert response.status_code == 202
        kwargs = test_team.handle_user_message.call_args.kwargs
        assert kwargs["model"] is None
        assert kwargs["model_provided"] is True
        assert kwargs["thinking_level"] is None
        assert kwargs["thinking_level_provided"] is True

    def test_team_chat_rejects_unregistered_model(self, app_with_team):
        client = TestClient(app_with_team)
        with patch(
            "app.api.routes.team.chat.is_registered_model_id",
            AsyncMock(return_value=False),
        ):
            response = client.post(
                "/api/team/chat",
                data={"message": "Hello team", "model": "bad:model"},
            )
        assert response.status_code == 422

    def test_team_chat_activates_queue_if_lead_goes_idle_after_save(
        self, app_with_team, test_team
    ):
        session_id = str(uuid.uuid7())
        test_team.lead.state = "working"
        test_team._activate_queued_user_messages = AsyncMock(return_value=True)

        async def save_queue(_db, _session_id, _message, *, extra=None):
            assert extra is not None
            test_team.lead.state = "idle"
            queued = AsyncMock()
            queued.id = uuid.uuid7()
            return queued

        client = TestClient(app_with_team)
        with patch("app.api.routes.team.chat.save_queued_user_message", save_queue):
            response = client.post(
                "/api/team/chat",
                data={"message": "queued", "session_id": session_id},
            )

        assert response.status_code == 202
        assert response.json()["status"] == "queued"
        test_team._activate_queued_user_messages.assert_awaited_once_with(session_id)

    def test_team_chat_activates_queue_when_lead_idle_members_running(
        self, app_with_team, test_team
    ):
        """Keep durable ordering, but wake an idle lead without waiting for members."""
        session_id = str(uuid.uuid7())
        test_team.lead.state = "idle"
        test_team._has_active_turn = True  # members from the prior lead turn still run
        test_team._activate_queued_user_messages = AsyncMock(return_value=True)
        test_team.handle_user_message = AsyncMock(
            return_value=(session_id, str(uuid.uuid7()))
        )

        async def save_queue(_db, _session_id, _message, *, extra=None):
            queued = AsyncMock()
            queued.id = uuid.uuid7()
            return queued

        client = TestClient(app_with_team)
        try:
            with patch("app.api.routes.team.chat.save_queued_user_message", save_queue):
                response = client.post(
                    "/api/team/chat",
                    data={"message": "queued", "session_id": session_id},
                )
        finally:
            test_team._has_active_turn = False

        assert response.status_code == 202
        assert response.json()["status"] == "queued"
        test_team._activate_queued_user_messages.assert_awaited_once_with(session_id)
        test_team.handle_user_message.assert_not_awaited()

    def test_team_chat_supersedes_pending_question_instead_of_queueing(
        self, app_with_team, test_team
    ):
        """A person typing instead of answering must reach the supersede path.

        ``waiting_input`` is a busy state, so ``has_active_user_turn()`` is True
        and the naive reading is "queue it". That strands the message: the
        question owns the turn, and dismissing it never drains the queue, so the
        text the user typed disappears with no turn to carry it.
        """
        session_id = str(uuid.uuid7())
        test_team.lead.state = "waiting_input"
        test_team._has_active_turn = True  # a member kept working past the ask
        test_team._activate_queued_user_messages = AsyncMock(return_value=True)
        test_team.handle_user_message = AsyncMock(
            return_value=(session_id, str(uuid.uuid7()))
        )

        client = TestClient(app_with_team)
        try:
            response = client.post(
                "/api/team/chat",
                data={
                    "message": "actually, do it differently",
                    "session_id": session_id,
                },
            )
        finally:
            test_team._has_active_turn = False
            test_team.lead.state = "idle"

        assert response.status_code == 202
        assert response.json()["status"] == "accepted"
        test_team.handle_user_message.assert_awaited_once()
        test_team._activate_queued_user_messages.assert_not_awaited()

    def test_team_chat_queued_message_persists_explicit_uploads(
        self, app_with_team, test_team
    ):
        """Explicit file uploads are persisted and attached to the queued row.

        Previously this returned 409.  Now the upload bytes are validated and
        written to disk at queue time so the dequeue path rehydrates the same
        context the user composed.
        """

        session_id = str(uuid.uuid7())
        test_team.lead.state = "working"
        test_team._activate_queued_user_messages = AsyncMock(return_value=False)

        captured: dict = {}

        async def save_queue(_db, _session_id, _message, *, extra=None):
            captured["extra"] = extra
            queued = AsyncMock()
            queued.id = uuid.uuid7()
            return queued

        async def fake_persist(_team, atts, sid, workspace=None):
            metas = [
                {
                    "filename": a.filename,
                    "original_name": a.filename,
                    "category": "text",
                    "path": f"/fake/uploads/{a.filename}",
                }
                for a in atts
            ]
            return sid, metas

        client = TestClient(app_with_team)
        with (
            patch("app.api.routes.team.chat.save_queued_user_message", save_queue),
            patch(
                "app.api.routes.team.chat.agent_service.validate_and_persist_attachments",
                fake_persist,
            ),
            patch("app.api.routes.team.chat.save_message", AsyncMock()),
        ):
            response = client.post(
                "/api/team/chat",
                data={"message": "check this", "session_id": session_id},
                files={"files": ("report.txt", b"hello", "text/plain")},
            )

        assert response.status_code == 202
        assert response.json()["status"] == "queued"
        atts = captured["extra"]["attachments"]
        assert len(atts) == 1
        assert atts[0]["original_name"] == "report.txt"

    def test_team_chat_queued_message_persists_mention_context_blocks_only(
        self, app_with_team, test_team
    ):
        session_id = str(uuid.uuid7())
        test_team.lead.state = "working"
        test_team._activate_queued_user_messages = AsyncMock(return_value=False)

        captured: dict = {}

        async def save_queue(_db, _session_id, _message, *, extra=None):
            captured["extra"] = extra
            queued = AsyncMock()
            queued.id = uuid.uuid7()
            return queued

        client = TestClient(app_with_team)
        with (
            patch("app.api.routes.team.chat.save_queued_user_message", save_queue),
            patch(
                "app.api.routes.team.chat.build_mention_context_blocks",
                AsyncMock(return_value=["[File: note.txt]\nhi\n[End file: note.txt]"]),
            ),
            patch("app.api.routes.team.chat.save_message", AsyncMock()),
        ):
            response = client.post(
                "/api/team/chat",
                data={"message": "look at @note.txt", "session_id": session_id},
            )

        assert response.status_code == 202
        assert response.json()["status"] == "queued"
        assert "attachments" not in (captured["extra"] or {})

    @pytest.mark.asyncio
    async def test_mention_context_hidden_rows_reach_llm_history(self, test_team):
        from sqlalchemy.ext.asyncio import AsyncSession
        from uuid import UUID

        from app.services.chat_service import get_messages_for_llm, save_message

        await test_team.lead._ensure_db_session(title="x")
        lead_uuid = UUID(test_team.lead.session_id)
        from app.core.db import resolve_db_factory

        async with resolve_db_factory(test_team.lead.db_factory)() as db:
            assert isinstance(db, AsyncSession)
            from app.agent.schemas.chat import HumanMessage

            user = await save_message(
                db, lead_uuid, HumanMessage(content="look at @note.txt")
            )
            await save_message(
                db,
                lead_uuid,
                HumanMessage(content="[File: note.txt]\nhello\n[End file: note.txt]"),
                extra={
                    "hidden_from_user": True,
                    "hidden_from_summary": True,
                    "attachment_for_message_id": str(user.id),
                    "mention_context": True,
                },
            )
            await db.commit()
            msgs = await get_messages_for_llm(db, lead_uuid)

        contents = [m.content for m in msgs]
        assert "look at @note.txt" in contents
        assert "[File: note.txt]\nhello\n[End file: note.txt]" in contents

    def test_team_chat_message_validation_empty_raises(self, app_with_team):
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": ""})
        assert response.status_code == 422

    def test_team_chat_message_validation_missing_raises(self, app_with_team):
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"session_id": str(uuid.uuid7())})
        assert response.status_code == 422


class TestTeamStreamRoute:
    """Test GET /team/{session_id}/stream endpoint."""

    @pytest.mark.asyncio
    async def test_team_stream_returns_sse_events(self, app_with_team):
        """GET /team/{session_id}/stream attaches to the stream store."""
        from httpx import ASGITransport, AsyncClient

        session_id = str(uuid.uuid7())

        async def mock_attach(sid):
            yield {
                "event": "message",
                "data": '{"type":"message","agent":"lead","text":"hi"}',
            }

        with patch(
            "app.services.memory_stream_store.attach",
            return_value=mock_attach(session_id),
        ):
            transport = ASGITransport(app=app_with_team)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.get(f"/api/team/{session_id}/stream")
                assert response.status_code == 200
                assert "text/event-stream" in response.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_stream_reopens_the_turn_for_an_open_question(self):
        """A durably-suspended turn needs somewhere to stream before attach.

        Without turn state ``attach`` returns immediately, and the client — which
        correctly treats an open question as a live turn — reopens on that clean
        close with no backoff, spinning for as long as the card is unanswered.
        """
        from app.core import db as core_db
        from app.models.chat import ChatSession
        from app.services import question_service
        from app.api.routes.team.chat import _ensure_turn_for_open_question
        from app.services.memory_stream_store import _turns

        session_id = uuid.uuid7()
        async with core_db.async_session_factory() as db:
            db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
            await db.commit()
            await question_service.create_pending_question(
                db,
                session_id=session_id,
                tool_call_id="call-stream-open",
                questions=[
                    {
                        "question": "Which?",
                        "header": "Pick",
                        "multiple": False,
                        "custom": False,
                        "options": [{"label": "a"}, {"label": "b"}],
                    }
                ],
            )
            await db.commit()
        _turns.pop(str(session_id), None)

        try:
            async with core_db.async_session_factory() as db:
                await _ensure_turn_for_open_question(str(session_id), db)

            assert str(session_id) in _turns
            # Attachable, or the connection is turned away exactly as before.
            assert _turns[str(session_id)].is_streaming is True
        finally:
            _turns.pop(str(session_id), None)

    @pytest.mark.asyncio
    async def test_stream_does_not_open_a_turn_for_a_quiet_session(self):
        """No open question means no turn to hold — leave the session alone.

        Creating state here would mark an idle session as running and keep an
        SSE connection parked on a turn that does not exist.
        """
        from app.core import db as core_db
        from app.models.chat import ChatSession
        from app.api.routes.team.chat import _ensure_turn_for_open_question
        from app.services.memory_stream_store import _turns

        session_id = uuid.uuid7()
        async with core_db.async_session_factory() as db:
            db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
            await db.commit()
        _turns.pop(str(session_id), None)

        async with core_db.async_session_factory() as db:
            await _ensure_turn_for_open_question(str(session_id), db)

        assert str(session_id) not in _turns


class TestTeamAgentsRoute:
    """Test GET /team/agents endpoint."""

    def test_team_agents_no_team_returns_404(self, app_without_team):
        client = TestClient(app_without_team)
        response = client.get("/api/team/agents")
        assert response.status_code == 404

    def test_team_agents_returns_200(self, app_with_team):
        client = TestClient(app_with_team)
        response = client.get("/api/team/agents")
        assert response.status_code == 200

    def test_team_agents_returns_agents_list(self, app_with_team):
        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()
        assert "agents" in data
        names = {a["name"] for a in data["agents"]}
        assert "lead" in names
        assert "worker" in names

    def test_team_agents_includes_is_lead(self, app_with_team):
        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()
        lead_entry = next(a for a in data["agents"] if a["name"] == "lead")
        assert lead_entry["is_lead"] is True
        worker_entry = next(a for a in data["agents"] if a["name"] == "worker")
        assert worker_entry["is_lead"] is False

    def test_team_agents_refreshes_mcp_tools_without_agent_reload(
        self, app_with_team, monkeypatch
    ):
        from app.agent.mcp.manager import mcp_manager, MCPServerStatus, _ServerRunner

        runner = _ServerRunner(
            shutdown=asyncio.Event(),
            ready=asyncio.Event(),
            status=MCPServerStatus(
                name="filesystem",
                transport="stdio",
                enabled=True,
                state="ready",
            ),
            tools=[get_date],
        )
        runner.status.tool_names = [get_date.name]
        monkeypatch.setattr(mcp_manager, "_runners", {"filesystem": runner})

        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()
        lead_entry = next(a for a in data["agents"] if a["name"] == "lead")
        tool_names = {tool["name"] for tool in lead_entry["tools"]}
        assert get_date.name in tool_names

    def test_team_agents_lists_the_tools_injected_at_run_time(
        self, app_with_team, test_team
    ):
        """Session Settings claims to show "what this session can actually do".

        ``team_message``, ``team_manage`` and ``ask_user`` are built
        per-run by ``get_injected_tools`` and never registered on the agent, so
        the listing omitted three working tools. (``todo_manage`` was already
        there — it is also a static builtin.)
        """
        test_team.mode = "coding"

        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()

        lead_tools = {
            t["name"]
            for t in next(a for a in data["agents"] if a["name"] == "lead")["tools"]
        }
        assert {"team_message", "team_manage", "ask_user"} <= lead_tools

    def test_team_agents_shows_the_injected_todo_manage_not_the_static_one(
        self, app_with_team, test_team
    ):
        """``todo_manage`` exists twice, and the listing must show the winner.

        It is a static builtin *and* a team-bound tool that ``get_injected_tools``
        supplies per run. ``_setup_run`` does ``run_tools[t.name] = t``, so the
        injected, board-aware, role-specific version is what the model actually
        gets — listing the static one's description would document a tool that
        never runs.

        The two share a description and differ only in args schema, which this
        payload does not carry — so precedence is asserted with a stand-in whose
        description is distinguishable.
        """
        from app.agent.tools import todo_manage
        from app.agent.tools.registry import tool as tool_decorator

        @tool_decorator(name="todo_manage", description="INJECTED board-aware variant")
        def _injected_todo() -> str:
            return ""

        test_team.mode = "coding"
        test_team.lead.agent._tools["todo_manage"] = todo_manage
        test_team.get_injected_tools = lambda _name: [_injected_todo]

        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()

        lead_entry = next(a for a in data["agents"] if a["name"] == "lead")
        listed = next(t for t in lead_entry["tools"] if t["name"] == "todo_manage")
        assert listed["description"] == "INJECTED board-aware variant"
        # Exactly one entry — the merge replaces, it does not append a duplicate.
        assert sum(t["name"] == "todo_manage" for t in lead_entry["tools"]) == 1

    def test_team_agents_omits_ask_user_for_members(self, app_with_team, test_team):
        """The listing must mirror injection, not advertise what a member cannot call."""
        test_team.mode = "coding"

        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()

        worker_tools = {
            t["name"]
            for t in next(a for a in data["agents"] if a["name"] == "worker")["tools"]
        }
        assert "team_message" in worker_tools
        assert "ask_user" not in worker_tools
        assert "team_manage" not in worker_tools

    def test_team_agents_omits_ask_user_outside_coding_mode(
        self, app_with_team, test_team
    ):
        test_team.mode = "normal"

        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()

        lead_tools = {
            t["name"]
            for t in next(a for a in data["agents"] if a["name"] == "lead")["tools"]
        }
        assert "team_message" in lead_tools
        assert "ask_user" not in lead_tools

    def test_team_agents_tool_descriptions_are_not_empty_for_injected_tools(
        self, app_with_team, test_team
    ):
        """The panel renders the description; an empty one makes the row useless."""
        test_team.mode = "coding"

        client = TestClient(app_with_team)
        data = client.get("/api/team/agents").json()

        lead_entry = next(a for a in data["agents"] if a["name"] == "lead")
        ask = next(t for t in lead_entry["tools"] if t["name"] == "ask_user")
        assert ask["description"].strip()


class TestTeamHistoryRoute:
    """Test GET /team/{session_id}/history endpoint."""

    def test_team_history_no_team_returns_404(self, app_without_team):
        client = TestClient(app_without_team)
        response = client.get(f"/api/team/{uuid.uuid7()}/history")
        assert response.status_code == 404

    def test_team_history_requires_session_id(self, app_with_team):
        client = TestClient(app_with_team)
        # Without session_id path param the route doesn't match.
        response = client.get("/api/team/history")
        assert response.status_code == 404

    def test_team_history_session_not_found_returns_404(self, app_with_team):
        client = TestClient(app_with_team)
        response = client.get(f"/api/team/{uuid.uuid7()}/history")
        assert response.status_code == 404


class TestTeamChatFormValidation:
    """Test POST /team/chat form validation (FastAPI Form() params)."""

    def test_empty_message_returns_422(self, app_with_team):
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": ""})
        assert response.status_code == 422

    def test_missing_message_returns_422(self, app_with_team):
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={})
        assert response.status_code == 422

    def test_thinking_level_accepts_any_string(self):
        from app.api.schemas.chat import ChatForm

        for level in ["none", "low", "medium", "high", "xhigh", "max", "custom-level"]:
            form = ChatForm(message="hello", thinking_level=level)
            assert form.thinking_level == level
