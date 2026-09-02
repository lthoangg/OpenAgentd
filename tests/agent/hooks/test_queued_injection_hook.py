"""Tests for QueuedMessageInjectionHook — splices user-queued messages mid-turn."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.hooks.queued_injection import QueuedMessageInjectionHook
from app.agent.schemas.chat import HumanMessage
from app.agent.state import AgentState, ModelRequest, RunContext
from app.services.chat_service import (
    create_chat_session,
    get_messages,
    save_queued_user_message,
)


@pytest_asyncio.fixture
async def engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_factory(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def _ctx(session_id: str) -> RunContext:
    return RunContext(session_id=session_id, run_id="run-1", agent_name="lead")


def _state(messages=None) -> AgentState:
    return AgentState(messages=list(messages or []), system_prompt="sys")


def _request() -> ModelRequest:
    return ModelRequest(messages=(), system_prompt="sys")


@pytest.mark.asyncio
async def test_empty_queue_returns_none(db_factory):
    async with db_factory() as db:
        chat = await create_chat_session(db, title="t")
        await db.commit()

    hook = QueuedMessageInjectionHook(
        session_id=str(chat.id), agent_name="lead", db_factory=db_factory
    )

    state = _state()
    result = await hook.before_model(_ctx(str(chat.id)), state, _request())

    assert result is None
    assert state.messages == []


@pytest.mark.asyncio
async def test_invalid_session_id_returns_none(db_factory):
    hook = QueuedMessageInjectionHook(
        session_id="not-a-uuid", agent_name="lead", db_factory=db_factory
    )
    state = _state()
    result = await hook.before_model(_ctx("not-a-uuid"), state, _request())
    assert result is None
    assert state.messages == []


@pytest.mark.asyncio
async def test_support_interrupt_false_ignores_queued_messages(db_factory):
    async with db_factory() as db:
        chat = await create_chat_session(db, title="t")
        await save_queued_user_message(db, chat.id, "wait until next turn")
        await db.commit()

    hook = QueuedMessageInjectionHook(
        session_id=str(chat.id),
        agent_name="lead",
        db_factory=db_factory,
        support_interrupt=False,
    )

    with patch(
        "app.services.memory_stream_store.push_event", new_callable=AsyncMock
    ) as push:
        state = _state()
        result = await hook.before_model(_ctx(str(chat.id)), state, _request())

    assert result is None
    assert state.messages == []
    push.assert_not_awaited()

    async with db_factory() as db:
        visible = await get_messages(db, chat.id)
    assert len(visible) == 1
    assert visible[0].extra is not None
    assert visible[0].extra.get("queue_status") == "queued"


@pytest.mark.asyncio
async def test_queued_messages_are_drained_and_appended(db_factory):
    async with db_factory() as db:
        chat = await create_chat_session(db, title="t")
        await save_queued_user_message(db, chat.id, "first follow-up")
        await save_queued_user_message(db, chat.id, "second follow-up")
        await db.commit()

    hook = QueuedMessageInjectionHook(
        session_id=str(chat.id), agent_name="lead", db_factory=db_factory
    )

    existing = HumanMessage(content="original")
    state = _state([existing])
    request = _request()

    with patch(
        "app.services.memory_stream_store.push_event", new_callable=AsyncMock
    ) as push:
        result = await hook.before_model(_ctx(str(chat.id)), state, request)

    # state.messages updated in place: original + 2 queued
    assert [m.content for m in state.messages] == [
        "original",
        "first follow-up",
        "second follow-up",
    ]
    assert all(isinstance(m, HumanMessage) for m in state.messages)

    # ModelRequest rebuilt so the LLM sees the injected messages
    assert result is not None
    assert tuple(m.content for m in result.messages) == (
        "original",
        "first follow-up",
        "second follow-up",
    )

    # SSE event emitted, reusing the existing 'queued_turn_start' event type
    push.assert_awaited_once()
    args, _ = push.call_args
    session_id_arg, envelope = args
    assert session_id_arg == str(chat.id)
    assert envelope.event == "queued_turn_start"
    assert envelope.data["type"] == "queued_turn_start"
    assert envelope.data["agent"] == "lead"
    assert len(envelope.data["message_ids"]) == 2


@pytest.mark.asyncio
async def test_queued_rows_become_visible_in_history(db_factory):
    """After draining, the rows are no longer hidden — get_messages includes them."""
    async with db_factory() as db:
        chat = await create_chat_session(db, title="t")
        await save_queued_user_message(db, chat.id, "queued one")
        await db.commit()

    hook = QueuedMessageInjectionHook(
        session_id=str(chat.id), agent_name="lead", db_factory=db_factory
    )

    with patch("app.services.memory_stream_store.push_event", new_callable=AsyncMock):
        await hook.before_model(_ctx(str(chat.id)), _state(), _request())

    async with db_factory() as db:
        visible = await get_messages(db, chat.id)

    assert [m.content for m in visible] == ["queued one"]


@pytest.mark.asyncio
async def test_sse_failure_does_not_break_injection(db_factory):
    """If the SSE push raises, the messages are still injected into state."""
    async with db_factory() as db:
        chat = await create_chat_session(db, title="t")
        await save_queued_user_message(db, chat.id, "still injected")
        await db.commit()

    hook = QueuedMessageInjectionHook(
        session_id=str(chat.id), agent_name="lead", db_factory=db_factory
    )

    with patch(
        "app.services.memory_stream_store.push_event",
        new_callable=AsyncMock,
        side_effect=RuntimeError("boom"),
    ):
        state = _state()
        result = await hook.before_model(_ctx(str(chat.id)), state, _request())

    assert [m.content for m in state.messages] == ["still injected"]
    assert result is not None
