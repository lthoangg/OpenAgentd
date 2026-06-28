import pytest
import pytest_asyncio
from pathlib import Path
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    ImageDataBlock,
    TextBlock,
    ToolCall,
    ToolMessage,
)
from app.models.chat import SessionMessage
from app.services.chat_service import (
    create_chat_session,
    get_messages,
    get_messages_for_llm,
    save_message,
)
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


@pytest.mark.asyncio
async def test_cancel_queued_message_deletes_attachment_files(
    session: AsyncSession, tmp_path: Path
):
    """Cancelling a queued message with attachments removes the persisted files."""
    file_a = tmp_path / "a.txt"
    file_b = tmp_path / "b.png"
    file_a.write_text("hello")
    file_b.write_bytes(b"\x89PNG")

    chat_session = await create_chat_session(session)
    queued = await save_queued_user_message(
        session,
        chat_session.id,
        "with files",
        extra={
            "attachments": [
                {"filename": "a.txt", "path": str(file_a), "category": "text"},
                {"filename": "b.png", "path": str(file_b), "category": "image"},
            ]
        },
        save_message=save_message,
    )
    await session.commit()

    assert file_a.exists()
    assert file_b.exists()

    result = await cancel_queued_user_message(session, chat_session.id, queued.id)
    await session.commit()

    assert result is True
    assert await session.get(SessionMessage, queued.id) is None
    assert not file_a.exists(), "attachment file should be deleted on cancel"
    assert not file_b.exists(), "attachment file should be deleted on cancel"


@pytest.mark.asyncio
async def test_cancel_queued_message_tolerates_missing_attachment_file(
    session: AsyncSession, tmp_path: Path
):
    """Cancel succeeds even if an attachment file was already removed from disk."""
    missing = tmp_path / "gone.txt"
    # deliberately do NOT create the file

    chat_session = await create_chat_session(session)
    queued = await save_queued_user_message(
        session,
        chat_session.id,
        "ghost file",
        extra={
            "attachments": [
                {"filename": "gone.txt", "path": str(missing), "category": "text"},
            ]
        },
        save_message=save_message,
    )
    await session.commit()

    # Should not raise even though the file is absent
    result = await cancel_queued_user_message(session, chat_session.id, queued.id)
    await session.commit()

    assert result is True
    assert await session.get(SessionMessage, queued.id) is None


@pytest.mark.asyncio
async def test_get_messages_for_llm_hydrates_image_attachment_hint_and_skips_synthetic_shadow(
    session: AsyncSession,
):
    chat_session = await create_chat_session(session)
    user = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="whats in this image"),
        extra={
            "attachments": [
                {
                    "filename": "Screenshot.png",
                    "original_name": "Screenshot.png",
                    "category": "image",
                    "media_type": "image/png",
                    "path": "/tmp/should-not-be-read-for-llm-hint.png",
                }
            ]
        },
    )
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[Attached image: Screenshot.png]"),
        extra={
            "hidden_from_user": True,
            "hidden_from_summary": True,
            "attachment_for_message_id": str(user.id),
        },
    )
    await session.commit()

    messages = await get_messages_for_llm(session, chat_session.id)

    assert len(messages) == 1
    msg = messages[0]
    assert isinstance(msg, HumanMessage)
    assert msg.parts is not None
    assert [part.type for part in msg.parts] == ["text", "text"]
    assert (
        msg.parts[0].text
        == "[Attached image path: ./uploads/Screenshot.png. Use the read tool to inspect it.]"
    )
    assert msg.parts[1].text == "whats in this image"


@pytest.mark.asyncio
async def test_tool_message_multimodal_parts_round_trip_from_db(session: AsyncSession):
    chat_session = await create_chat_session(session)
    await save_message(
        session,
        chat_session.id,
        AssistantMessage(
            content="",
            tool_calls=[
                ToolCall(
                    id="tool-1",
                    function=FunctionCall(
                        name="read", arguments='{"path":"./uploads/Screenshot.png"}'
                    ),
                )
            ],
        ),
    )
    tool_msg = ToolMessage(
        content="[Image: ./uploads/Screenshot.png]",
        tool_call_id="tool-1",
        name="read",
        parts=[
            TextBlock(text="[Image: ./uploads/Screenshot.png]"),
            ImageDataBlock(data="ZmFrZQ==", media_type="image/png"),
        ],
    )
    await save_message(session, chat_session.id, tool_msg)
    await session.commit()

    messages = await get_messages_for_llm(session, chat_session.id)

    assert len(messages) == 2
    assert isinstance(messages[0], AssistantMessage)
    msg = messages[1]
    assert isinstance(msg, ToolMessage)
    assert msg.parts is not None
    assert msg.parts[0].type == "text"
    assert msg.parts[1].type == "image_data"
    assert msg.parts[1].data == "ZmFrZQ=="
    assert msg.parts[1].media_type == "image/png"


@pytest.mark.asyncio
async def test_cancel_queued_message_deletes_synthetic_attachment_rows(
    session: AsyncSession,
):
    chat_session = await create_chat_session(session)
    queued = await save_queued_user_message(
        session,
        chat_session.id,
        "with hidden attachment",
        extra={"attachments": [{"filename": "a.txt", "category": "text"}]},
        save_message=save_message,
    )
    synthetic = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[File: a.txt]\nhello\n[End file: a.txt]"),
        exclude_from_context=False,
        extra={
            "hidden_from_user": True,
            "hidden_from_summary": True,
            "attachment_for_message_id": str(queued.id),
        },
    )
    unrelated = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[File: other.txt]\nkeep\n[End file: other.txt]"),
        exclude_from_context=False,
        extra={
            "hidden_from_user": True,
            "hidden_from_summary": True,
            "attachment_for_message_id": "different-message",
        },
    )
    await session.commit()

    result = await cancel_queued_user_message(session, chat_session.id, queued.id)
    await session.commit()

    assert result is True
    assert await session.get(SessionMessage, queued.id) is None
    assert await session.get(SessionMessage, synthetic.id) is None
    assert await session.get(SessionMessage, unrelated.id) is not None
