"""Unit tests for the chat-route resolution helpers in ``_helpers.py``.

Covers ``_validate_workspace_or_422``, ``validate_model_settings``,
``resolve_chat_agent``, and ``persist_queued_user_message`` — extracted
from the ``POST /agent/chat`` handler (see
``app.api.routes.agent.chat.agent_chat``). These tests exercise each helper
directly rather than through the full route, complementing the
route-level tests in ``test_agent.py`` / ``test_agent_routes_extra.py``
which already cover the same behaviour end-to-end and must keep passing
unchanged.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.agent.agent_loop import Agent
from app.agent.session import AgentSession
from app.agent.providers.base import LLMProviderBase
from app.api.routes.agent._helpers import (
    QueuedMessageResult,
    _validate_workspace_or_422,
    persist_queued_user_message,
    resolve_chat_agent,
    resolve_agent_for_existing_session,
    validate_model_settings,
)
from app.models.chat import ChatSession


class MockProvider(LLMProviderBase):
    model = "mock"

    def stream(self, messages, tools=None, **kwargs):
        async def gen():
            return
            yield

        return gen()

    async def chat(self, messages, tools=None, **kwargs):
        from app.agent.schemas.chat import AssistantMessage

        return AssistantMessage(content="OK")


def _make_team() -> AgentSession:
    agent = Agent(name="lead", llm_provider=MockProvider(), system_prompt="Lead")
    return AgentSession(agent=agent)


# ── _validate_workspace_or_422 ────────────────────────────────────────────────


def test_validate_workspace_or_422_returns_resolved_path(tmp_path):
    result = _validate_workspace_or_422(str(tmp_path))
    assert result == str(tmp_path.resolve())


def test_validate_workspace_or_422_raises_422_for_missing_dir(tmp_path):
    missing = tmp_path / "does-not-exist"
    with pytest.raises(HTTPException) as exc_info:
        _validate_workspace_or_422(str(missing))
    assert exc_info.value.status_code == 422


def test_validate_workspace_or_422_raises_422_for_blocked_root():
    with pytest.raises(HTTPException) as exc_info:
        _validate_workspace_or_422("/etc")
    assert exc_info.value.status_code == 422


# ── validate_model_settings ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_validate_model_settings_strips_whitespace():
    async def always_true(_model_id: str) -> bool:
        return True

    model, thinking_level = await validate_model_settings(
        "  openai:gpt-5.5  ",
        "  high  ",
        is_registered_model_id=always_true,
    )
    assert model == "openai:gpt-5.5"
    assert thinking_level == "high"


@pytest.mark.asyncio
async def test_validate_model_settings_none_passthrough():
    async def never_called(_model_id: str) -> bool:
        raise AssertionError("must not be called when model is None")

    model, thinking_level = await validate_model_settings(
        None, None, is_registered_model_id=never_called
    )
    assert model is None
    assert thinking_level is None


@pytest.mark.asyncio
async def test_validate_model_settings_empty_string_resets_to_none():
    async def never_called(_model_id: str) -> bool:
        raise AssertionError("must not be called for an empty model string")

    model, thinking_level = await validate_model_settings(
        "", "", is_registered_model_id=never_called
    )
    assert model is None
    assert thinking_level is None


@pytest.mark.asyncio
async def test_validate_model_settings_rejects_unregistered_model():
    async def always_false(_model_id: str) -> bool:
        return False

    with pytest.raises(HTTPException) as exc_info:
        await validate_model_settings(
            "bad:model", None, is_registered_model_id=always_false
        )
    assert exc_info.value.status_code == 422
    assert "registry" in exc_info.value.detail


# ── resolve_chat_agent ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_chat_agent_raises_422_for_invalid_session_id():
    import app.core.db as _db

    async with _db.async_session_factory() as db:
        with pytest.raises(HTTPException) as exc_info:
            await resolve_chat_agent(db, session_id="not-a-uuid", workspace="/tmp")
    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == "Invalid session id."


@pytest.mark.asyncio
async def test_resolve_chat_agent_starts_coding_team_for_new_session(
    tmp_path, monkeypatch
):
    import app.core.db as _db

    team = _make_team()
    captured = {}

    async def fake_get_or_start_agent_session(workspace: str, session_id: str):
        captured["workspace"] = workspace
        captured["session_id"] = session_id
        return team

    monkeypatch.setattr(
        "app.api.routes.agent._helpers.agent_manager.get_or_start_agent_session",
        fake_get_or_start_agent_session,
    )

    async with _db.async_session_factory() as db:
        result = await resolve_chat_agent(db, session_id=None, workspace=str(tmp_path))

    assert result.agent is team
    assert result.workspace == str(tmp_path.resolve())
    assert captured["workspace"] == str(tmp_path.resolve())
    assert captured["session_id"] == result.session_id


@pytest.mark.asyncio
async def test_existing_session_without_workspace_is_not_routed_to_a_default_team(
    monkeypatch,
):
    """Legacy rows cannot reactivate the removed workspace-less runtime."""
    import app.core.db as _db

    session_id = uuid.uuid7()
    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(ChatSession(id=session_id, agent_name="lead"))

    async def unexpected_default_team(_session_id: str):
        raise AssertionError("workspace-less session must not start a default team")

    monkeypatch.setattr(
        "app.api.routes.agent._helpers.agent_manager.get_or_start_agent_session",
        unexpected_default_team,
    )

    async with _db.async_session_factory() as db:
        with pytest.raises(HTTPException) as exc_info:
            await resolve_agent_for_existing_session(db, str(session_id))

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_resolve_chat_agent_persisted_workspace_wins_over_matching_request(
    tmp_path, monkeypatch
):
    """An existing coding session's workspace is authoritative even when the
    request repeats the same (already-matching) workspace."""
    import app.core.db as _db

    team = _make_team()
    session_id = uuid.uuid7()
    workspace = tmp_path / "project"
    workspace.mkdir()

    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(
                ChatSession(
                    id=session_id,
                    agent_name="lead",
                    workspace=str(workspace),
                )
            )

    async def fake_get_or_start_agent_session(_workspace: str, _session_id: str):
        return team

    monkeypatch.setattr(
        "app.api.routes.agent._helpers.agent_manager.get_or_start_agent_session",
        fake_get_or_start_agent_session,
    )

    async with _db.async_session_factory() as db:
        result = await resolve_chat_agent(
            db,
            session_id=str(session_id),
            workspace=str(workspace),
        )

    assert result.workspace == str(workspace.resolve())
    assert result.session_uuid == session_id


@pytest.mark.asyncio
async def test_resolve_chat_agent_raises_409_for_workspace_mismatch(tmp_path):
    """Security invariant: a session id must not be replayed against a
    different workspace than the one it was persisted with."""
    import app.core.db as _db

    session_id = uuid.uuid7()
    persisted_workspace = tmp_path / "project"
    other_workspace = tmp_path / "other"
    persisted_workspace.mkdir()
    other_workspace.mkdir()

    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(
                ChatSession(
                    id=session_id,
                    agent_name="lead",
                    workspace=str(persisted_workspace),
                )
            )

    async with _db.async_session_factory() as db:
        with pytest.raises(HTTPException) as exc_info:
            await resolve_chat_agent(
                db,
                session_id=str(session_id),
                workspace=str(other_workspace),
            )
    assert exc_info.value.status_code == 409
    assert "different coding workspace" in exc_info.value.detail


# ── persist_queued_user_message ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_persist_queued_user_message_persists_row_and_returns_result():
    import app.core.db as _db

    team = _make_team()
    session_id = uuid.uuid7()

    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(ChatSession(id=session_id, agent_name="lead"))

    save_queue = AsyncMock()
    queued_row = AsyncMock()
    queued_row.id = uuid.uuid7()
    save_queue.return_value = queued_row
    save_message = AsyncMock()

    async with _db.async_session_factory() as db:
        result = await persist_queued_user_message(
            db,
            agent_session=team,
            session_id=str(session_id),
            session_uuid=session_id,
            workspace=None,
            message="hello",
            attachments=[],
            mention_context_blocks=[],
            mentions=None,
            model=None,
            model_provided=False,
            thinking_level=None,
            thinking_level_provided=False,
            fast_mode_service_tier=None,
            save_queued_user_message=save_queue,
            save_message=save_message,
        )

    assert isinstance(result, QueuedMessageResult)
    assert result.message_id == str(queued_row.id)
    assert result.attachment_count == 0
    save_queue.assert_awaited_once()
    save_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_persist_queued_user_message_writes_mention_context_rows():
    import app.core.db as _db

    team = _make_team()
    session_id = uuid.uuid7()

    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(ChatSession(id=session_id, agent_name="lead"))

    queued_row = AsyncMock()
    queued_row.id = uuid.uuid7()
    save_queue = AsyncMock(return_value=queued_row)
    save_message = AsyncMock()

    async with _db.async_session_factory() as db:
        await persist_queued_user_message(
            db,
            agent_session=team,
            session_id=str(session_id),
            session_uuid=session_id,
            workspace=None,
            message="look at @note.txt",
            attachments=[],
            mention_context_blocks=["[File: note.txt]\nhi\n[End file: note.txt]"],
            mentions=["note.txt"],
            model=None,
            model_provided=False,
            thinking_level=None,
            thinking_level_provided=False,
            fast_mode_service_tier=None,
            save_queued_user_message=save_queue,
            save_message=save_message,
        )

    save_message.assert_awaited_once()
    call = save_message.await_args
    assert call.kwargs["extra"]["mention_context"] is True
    assert call.kwargs["extra"]["attachment_for_message_id"] == str(queued_row.id)

    queued_extra = save_queue.await_args.kwargs["extra"]
    assert queued_extra["mentions"] == ["note.txt"]
    assert "attachments" not in queued_extra


@pytest.mark.asyncio
async def test_persist_queued_user_message_prefers_request_model_over_existing_row():
    import app.core.db as _db

    team = _make_team()
    session_id = uuid.uuid7()

    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(
                ChatSession(
                    id=session_id,
                    agent_name="lead",
                    model="openai:gpt-5.5",
                    thinking_level="low",
                )
            )

    queued_row = AsyncMock()
    queued_row.id = uuid.uuid7()
    save_queue = AsyncMock(return_value=queued_row)
    save_message = AsyncMock()

    async with _db.async_session_factory() as db:
        await persist_queued_user_message(
            db,
            agent_session=team,
            session_id=str(session_id),
            session_uuid=session_id,
            workspace=None,
            message="hello",
            attachments=[],
            mention_context_blocks=[],
            mentions=None,
            model="openai:gpt-6",
            model_provided=True,
            thinking_level="high",
            thinking_level_provided=True,
            fast_mode_service_tier="fast",
            save_queued_user_message=save_queue,
            save_message=save_message,
        )

    queued_extra = save_queue.await_args.kwargs["extra"]
    # existing_row.model is overwritten by model_provided before being read
    # back as the effective model — mirrors the original inline behaviour.
    assert queued_extra["model"] == "openai:gpt-6"
    assert queued_extra["thinking_level"] == "high"
    assert queued_extra["service_tier"] == "fast"

    async with _db.async_session_factory() as db:
        refreshed = await db.get(ChatSession, session_id)
        assert refreshed.model == "openai:gpt-6"
        assert refreshed.thinking_level == "high"
