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

    assert resp.attachments == [
        {
            "filename": "abc.png",
            "original_name": "photo.png",
            "category": "image",
            "url": "/api/team/sid/uploads/abc.png",
        }
    ]


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
        test_team.handle_user_message = AsyncMock(return_value=str(uuid.uuid7()))
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": "Hello team"})
        assert response.status_code == 202

    def test_team_chat_returns_session_id(self, app_with_team, test_team):
        sid = str(uuid.uuid7())
        test_team.handle_user_message = AsyncMock(return_value=sid)
        client = TestClient(app_with_team)
        response = client.post("/api/team/chat", data={"message": "Hello"})
        data = response.json()
        assert "session_id" in data
        assert data["status"] == "accepted"

    def test_team_chat_with_provided_session_id(self, app_with_team, test_team):
        session_id = str(uuid.uuid7())
        test_team.handle_user_message = AsyncMock(return_value=session_id)
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
        test_team.handle_user_message = AsyncMock(return_value=str(uuid.uuid7()))
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
        test_team.handle_user_message = AsyncMock(return_value=str(uuid.uuid7()))
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
        test_team.handle_user_message = AsyncMock(return_value=str(uuid.uuid7()))
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
        test_team.handle_user_message = AsyncMock(return_value=str(uuid.uuid7()))
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

    def test_team_chat_ignores_fast_mode_for_non_codex_model(
        self, app_with_team, test_team
    ):
        test_team.handle_user_message = AsyncMock(return_value=str(uuid.uuid7()))
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
        assert kwargs["service_tier"] is None

    def test_team_chat_empty_model_settings_reset(self, app_with_team, test_team):
        test_team.handle_user_message = AsyncMock(return_value=str(uuid.uuid7()))
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

    def test_team_chat_queues_when_turn_active_before_lead_state_flips(
        self, app_with_team, test_team
    ):
        """Quick follow-up POSTs must queue once a turn is active.

        Regression guard for two requests arriving close together: the first
        request sets ``_has_active_turn`` before the lead activation task may
        visibly flip ``lead.state`` to ``working``. The second request should
        still persist as queued, not as an adjacent normal user row.
        """
        session_id = str(uuid.uuid7())
        test_team.lead.state = "idle"
        test_team._has_active_turn = True
        test_team._activate_queued_user_messages = AsyncMock(return_value=False)

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
        test_team._activate_queued_user_messages.assert_not_awaited()

    def test_team_chat_queued_message_persists_mention_attachments(
        self, app_with_team, test_team
    ):
        """Mentions on a busy lead must persist on the queued row.

        Before the fix, ``collect_mention_attachments`` only ran on the
        dispatch branch — queued messages silently lost their `@file`
        context. Verify the metas now land in ``extra["attachments"]``.
        """
        from app.services.agent_service import RawAttachment

        session_id = str(uuid.uuid7())
        test_team.lead.state = "working"
        test_team._activate_queued_user_messages = AsyncMock(return_value=False)

        fake_att = RawAttachment(
            filename="note.txt",
            content_type="text/plain",
            data=b"hi",
            truncate_inline_to=32_000,
        )
        captured: dict = {}

        async def save_queue(_db, _session_id, _message, *, extra=None):
            captured["extra"] = extra
            queued = AsyncMock()
            queued.id = uuid.uuid7()
            return queued

        async def fake_collect(**_kwargs):
            return [fake_att]

        async def fake_persist(_team, atts, sid):
            metas = [
                {
                    "filename": a.filename,
                    "original_name": a.filename,
                    "category": "text",
                    "converted_text": "hi",
                }
                for a in atts
            ]
            return sid, metas

        client = TestClient(app_with_team)
        with (
            patch("app.api.routes.team.chat.save_queued_user_message", save_queue),
            patch("app.api.routes.team.chat.collect_mention_attachments", fake_collect),
            patch(
                "app.api.routes.team.chat.agent_service.validate_and_persist_attachments",
                fake_persist,
            ),
        ):
            response = client.post(
                "/api/team/chat",
                data={"message": "look at @note.txt", "session_id": session_id},
            )

        assert response.status_code == 202
        assert response.json()["status"] == "queued"
        atts = captured["extra"]["attachments"]
        assert len(atts) == 1
        assert atts[0]["original_name"] == "note.txt"
        assert atts[0]["converted_text"] == "hi"

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

        async def fake_persist(_team, atts, sid):
            metas = [
                {
                    "filename": a.filename,
                    "original_name": a.filename,
                    "category": "text",
                    "path": f"/fake/uploads/{a.filename}",
                    "converted_text": a.data.decode(),
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
        assert atts[0]["converted_text"] == "hello"

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
