"""Regression coverage for ``AgentTeam.handle_compact``."""

from __future__ import annotations

import uuid

from sqlmodel import col, select

import app.core.db as _db
from app.agent.agent_loop import Agent
from app.agent.mode.team.member import TeamLead
from app.agent.mode.team.team import AgentTeam
from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.models.chat import ChatSession, SessionMessage
from app.services.chat_service import (
    exclude_messages_before_summary,
    get_messages,
    get_messages_for_llm,
    redo_session_messages,
    save_message,
    undo_session_messages,
)
from tests.agent.mode.team.conftest import MockTeamProvider


async def test_compact_after_undo_commits_reverted_branch(monkeypatch):
    session_id = uuid.uuid7()
    lead = TeamLead(
        Agent(name="lead", llm_provider=MockTeamProvider("ok")),
        db_factory=_db.async_session_factory,
    )
    team = AgentTeam(
        lead=lead,
        members={},
        db_factory=_db.async_session_factory,
    )

    async with _db.async_session_factory() as db:
        db.add(ChatSession(id=session_id, agent_name="lead"))
        await db.flush()
        await save_message(db, session_id, HumanMessage(content="first"))
        await save_message(db, session_id, AssistantMessage(content="first answer"))
        second = await save_message(db, session_id, HumanMessage(content="second"))
        await save_message(db, session_id, AssistantMessage(content="second answer"))
        await db.commit()

    async with _db.async_session_factory() as db:
        shift = await undo_session_messages(db, session_id)
        await db.commit()
    assert shift.target is not None and shift.target.id == second.id

    monkeypatch.setattr(team.lead, "activate_for_compaction", lambda: None)

    returned = await team.handle_compact(str(session_id))

    assert returned == str(session_id)
    async with _db.async_session_factory() as db:
        session = await db.get(ChatSession, session_id)
        rows = list(
            (
                await db.exec(
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == session_id)
                    .order_by(col(SessionMessage.created_at).asc())
                )
            ).all()
        )
        compact_input = await get_messages_for_llm(db, session_id)

    assert session is not None
    assert session.revert is None
    assert [message.content for message in compact_input] == ["first", "first answer"]
    assert [row.content for row in rows if row.kind == "reverted"] == [
        "second",
        "second answer",
    ]

    async with _db.async_session_factory() as db:
        summary = await save_message(
            db,
            session_id,
            HumanMessage(content="summary"),
            is_summary=True,
        )
        await exclude_messages_before_summary(db, session_id, summary.id)
        await db.commit()

    async with _db.async_session_factory() as db:
        visible = await get_messages(db, session_id)
        redo = await redo_session_messages(db, session_id)

    assert [message.content for message in visible] == ["summary"]
    assert redo.applied is False


async def test_handle_compact_uses_session_model_override_end_to_end():
    """``/compact`` must run the summariser on the session's overridden
    model, not the agent's configured default — the same override a normal
    chat turn on this session would use."""
    session_id = uuid.uuid7()
    default_provider = MockTeamProvider("default-summary")
    override_provider = MockTeamProvider("override-summary")

    def provider_factory(model: str, model_kwargs=None):
        assert model == "googlegenai:gemini-3.1-flash-lite"
        return override_provider

    lead = TeamLead(
        Agent(name="lead", llm_provider=default_provider),
        db_factory=_db.async_session_factory,
    )
    team = AgentTeam(
        lead=lead,
        members={},
        db_factory=_db.async_session_factory,
        provider_factory=provider_factory,
    )
    await team.start()

    async with _db.async_session_factory() as db:
        db.add(
            ChatSession(
                id=session_id,
                agent_name="lead",
                model="googlegenai:gemini-3.1-flash-lite",
            )
        )
        await db.flush()
        await save_message(db, session_id, HumanMessage(content="first"))
        await save_message(db, session_id, AssistantMessage(content="first answer"))
        await db.commit()

    await team.handle_compact(str(session_id))
    assert lead._active_task is not None
    await lead._active_task

    assert override_provider.call_count > 0, "override provider was never called"
    assert default_provider.call_count == 0, "default provider was called instead"
