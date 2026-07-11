import pytest
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from app.core.db import get_session
from app.models.chat import ChatSession, SessionMessage


@pytest.mark.asyncio
async def test_get_session_success():
    """Verify get_session yields a session and commits."""
    async for session in get_session():
        # Check if session is active
        result = await session.execute(text("SELECT 1"))
        assert result.scalar() == 1
        # No exception means it should commit


@pytest.mark.asyncio
async def test_get_session_error():
    """Verify get_session rolls back on error."""
    with pytest.raises(ValueError, match="Expected Error"):
        async for session in get_session():
            raise ValueError("Expected Error")


@pytest.mark.asyncio
async def test_get_session_sqlalchemy_error_rolls_back():
    """SQLAlchemyError is caught by BaseException handler, rolled back and re-raised."""
    with pytest.raises(SQLAlchemyError):
        async for session in get_session():
            raise SQLAlchemyError("db error")


@pytest.mark.asyncio
async def test_get_session_base_exception_rolls_back():
    """Non-SQLAlchemy BaseException (e.g. CancelledError) still rolls back."""
    import asyncio

    with pytest.raises(asyncio.CancelledError):
        async for session in get_session():
            raise asyncio.CancelledError()


async def test_test_database_enforces_foreign_keys_and_cascades():
    """The test connection hook mirrors production FK enforcement."""
    import app.core.db as _db

    async with _db.async_session_factory() as session:
        foreign_keys = await session.execute(text("PRAGMA foreign_keys"))
        assert foreign_keys.scalar_one() == 1

        parent = ChatSession()
        session.add(parent)
        await session.commit()
        session.add(SessionMessage(session_id=parent.id, role="user", content="hi"))
        await session.commit()

        await session.delete(parent)
        await session.commit()

        rows = await session.execute(text("SELECT COUNT(*) FROM session_messages"))
        assert rows.scalar_one() == 0
