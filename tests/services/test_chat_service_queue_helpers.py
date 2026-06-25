import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import SessionMessage
from app.services.chat_service import create_chat_session, get_messages, save_message
from app.services.chat_service_queue import (
    cancel_queued_user_message,
    pop_queued_user_messages,
    release_queued_user_messages,
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
async def session(engine):
    async_session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with async_session() as session:
        yield session


@pytest.mark.asyncio
async def test_save_and_pop_queued_messages(session: AsyncSession):
    chat_session = await create_chat_session(session)
    queued = await save_queued_user_message(
        session,
        chat_session.id,
        "next",
        save_message=save_message,
    )
    await session.commit()

    visible = await get_messages(session, chat_session.id)
    assert [msg.content for msg in visible] == ["next"]
    assert queued.extra is not None
    assert queued.extra["queue_status"] == "queued"

    popped = await pop_queued_user_messages(session, chat_session.id)
    await session.commit()

    assert [row.content for row in popped] == ["next"]
    visible = await get_messages(session, chat_session.id)
    assert [msg.content for msg in visible] == ["next"]


@pytest.mark.asyncio
async def test_release_queued_messages_clears_queue_metadata(session: AsyncSession):
    chat_session = await create_chat_session(session)
    queued = await save_queued_user_message(
        session,
        chat_session.id,
        "queued",
        extra={"kind": "user_shell"},
        save_message=save_message,
    )
    await session.commit()

    released = await release_queued_user_messages(session, chat_session.id)
    await session.commit()

    assert [row.id for row in released] == [queued.id]
    row = await session.get(SessionMessage, queued.id)
    assert row is not None
    assert row.exclude_from_context is False
    assert row.extra == {"kind": "user_shell"}


@pytest.mark.asyncio
async def test_cancel_queued_message_deletes_row(session: AsyncSession):
    chat_session = await create_chat_session(session)
    queued = await save_queued_user_message(
        session,
        chat_session.id,
        "skip",
        save_message=save_message,
    )
    await session.commit()

    assert await cancel_queued_user_message(session, chat_session.id, queued.id) is True
    await session.commit()
    assert await session.get(SessionMessage, queued.id) is None
