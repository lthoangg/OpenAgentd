import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import ChatSession, SessionMessage
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    SystemMessage,
    ToolCall,
    ToolMessage,
)
from app.services.chat_service import (
    cancel_queued_user_message,
    cleanup_reverted_tail,
    create_chat_session,
    get_messages,
    get_messages_for_llm,
    heal_orphaned_tool_calls,
    hide_messages_before_summary,
    redo_session_messages,
    pop_queued_user_messages,
    save_queued_user_message,
    undo_session_messages,
    save_message,
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
async def test_create_chat_session(session):
    chat_session = await create_chat_session(session, title="Test Session")
    assert chat_session.id is not None
    assert chat_session.title == "Test Session"

    # Verify it exists in DB
    db_session = await session.get(ChatSession, chat_session.id)
    assert db_session is not None


@pytest.mark.asyncio
async def test_save_and_get_messages(session):
    chat_session = await create_chat_session(session)

    messages = [
        SystemMessage(content="system"),
        HumanMessage(content="hello"),
        AssistantMessage(
            content="hi",
            reasoning_content="thinking",
            tool_calls=[
                ToolCall(id="c1", function=FunctionCall(name="f", arguments="{}"))
            ],
        ),
        ToolMessage(
            role="tool", content="result", tool_call_id="call_1", name="tool_name"
        ),
    ]

    for msg in messages:
        await save_message(session, chat_session.id, msg)

    fetched = await get_messages(session, chat_session.id)
    assert len(fetched) == 4
    assert isinstance(fetched[0], SystemMessage)
    assert isinstance(fetched[1], HumanMessage)
    assert isinstance(fetched[2], AssistantMessage)
    assert fetched[2].reasoning_content == "thinking"
    assert isinstance(fetched[2].tool_calls, list)
    assert len(fetched[2].tool_calls) == 1
    assert isinstance(fetched[3], ToolMessage)
    assert fetched[3].tool_call_id == "call_1"
    assert fetched[3].name == "tool_name"


@pytest.mark.asyncio
async def test_get_messages_unhandled_role(session):
    chat_session = await create_chat_session(session)

    # Manually insert a message with an unhandled role
    db_msg = SessionMessage(
        session_id=chat_session.id,
        role="unknown",
        content="something",
    )
    session.add(db_msg)
    await session.commit()

    fetched = await get_messages(session, chat_session.id)
    assert len(fetched) == 0  # It should be skipped by the current loop


# ── Summarisation: save_message flags ────────────────────────────────────────


@pytest.mark.asyncio
async def test_save_message_with_summary_flag(session):
    """save_message persists is_summary=True correctly (summary is a HumanMessage)."""
    chat_session = await create_chat_session(session)
    msg = HumanMessage(content="Summary text.")
    saved = await save_message(session, chat_session.id, msg, is_summary=True)
    assert saved.is_summary is True
    assert saved.exclude_from_context is False
    assert saved.role == "user"


@pytest.mark.asyncio
async def test_save_message_with_hidden_flag(session):
    """save_message persists exclude_from_context=True correctly."""
    chat_session = await create_chat_session(session)
    msg = HumanMessage(content="Old message.")
    saved = await save_message(session, chat_session.id, msg, is_hidden=True)
    assert saved.exclude_from_context is True
    assert saved.is_summary is False


@pytest.mark.asyncio
async def test_cleanup_reverted_summary_restores_compacted_context(session):
    chat_session = await create_chat_session(session)

    u1 = await save_message(session, chat_session.id, HumanMessage(content="u1"))
    a1 = await save_message(session, chat_session.id, AssistantMessage(content="a1"))
    u2 = await save_message(session, chat_session.id, HumanMessage(content="u2"))
    a2 = await save_message(session, chat_session.id, AssistantMessage(content="a2"))
    summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary"),
        is_summary=True,
    )
    await save_message(
        session, chat_session.id, AssistantMessage(content="after summary")
    )

    for row in (u1, a1, u2, a2):
        row.exclude_from_context = True
        session.add(row)
    await session.commit()

    shift = await undo_session_messages(session, chat_session.id)
    assert shift.applied is True
    assert shift.target and shift.target.id == summary.id
    await session.commit()

    await cleanup_reverted_tail(session, chat_session.id)
    await session.commit()

    visible = await get_messages_for_llm(session, chat_session.id)
    assert [m.content for m in visible] == ["u1", "a1", "u2", "a2"]

    refreshed_summary = await session.get(SessionMessage, summary.id)
    assert refreshed_summary is not None
    assert refreshed_summary.exclude_from_context is True
    assert (
        refreshed_summary.extra
        and refreshed_summary.extra.get("hidden_from_user") is True
    )


@pytest.mark.asyncio
async def test_cleanup_reverted_summary_restores_only_to_previous_summary(session):
    chat_session = await create_chat_session(session)

    old_user = await save_message(
        session, chat_session.id, HumanMessage(content="old u")
    )
    old_assistant = await save_message(
        session, chat_session.id, AssistantMessage(content="old a")
    )
    first_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 1"),
        is_summary=True,
    )
    mid_user = await save_message(
        session, chat_session.id, HumanMessage(content="mid u")
    )
    mid_assistant = await save_message(
        session, chat_session.id, AssistantMessage(content="mid a")
    )
    second_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 2"),
        is_summary=True,
    )
    await save_message(session, chat_session.id, AssistantMessage(content="after s2"))

    for row in (old_user, old_assistant, first_summary, mid_user, mid_assistant):
        row.exclude_from_context = True
        session.add(row)
    await session.commit()

    shift = await undo_session_messages(session, chat_session.id)
    assert shift.applied is True
    assert shift.target and shift.target.id == second_summary.id
    await session.commit()

    await cleanup_reverted_tail(session, chat_session.id)
    await session.commit()

    visible = await get_messages_for_llm(session, chat_session.id)
    assert [m.content for m in visible] == ["summary 1", "mid u", "mid a"]

    refreshed_old_user = await session.get(SessionMessage, old_user.id)
    refreshed_old_assistant = await session.get(SessionMessage, old_assistant.id)
    assert refreshed_old_user is not None
    assert refreshed_old_assistant is not None
    assert refreshed_old_user.exclude_from_context is True
    assert refreshed_old_assistant.exclude_from_context is True


@pytest.mark.asyncio
async def test_redo_reapplies_second_summary_without_restoring_old_context(session):
    chat_session = await create_chat_session(session)

    old_user = await save_message(
        session, chat_session.id, HumanMessage(content="old u")
    )
    old_assistant = await save_message(
        session, chat_session.id, AssistantMessage(content="old a")
    )
    first_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 1"),
        is_summary=True,
    )
    mid_user = await save_message(
        session, chat_session.id, HumanMessage(content="mid u")
    )
    mid_assistant = await save_message(
        session, chat_session.id, AssistantMessage(content="mid a")
    )
    second_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 2"),
        is_summary=True,
    )
    after_summary = await save_message(
        session, chat_session.id, AssistantMessage(content="after s2")
    )

    for row in (old_user, old_assistant, first_summary, mid_user, mid_assistant):
        row.exclude_from_context = True
        session.add(row)
    await session.commit()

    undo_shift = await undo_session_messages(session, chat_session.id)
    assert undo_shift.applied is True
    assert undo_shift.target and undo_shift.target.id == second_summary.id
    await session.commit()

    redo_shift = await redo_session_messages(session, chat_session.id)
    assert redo_shift.applied is True
    assert redo_shift.target is None
    await session.commit()

    visible = await get_messages_for_llm(session, chat_session.id)
    assert [m.content for m in visible] == ["summary 2", "after s2"]

    for row in (old_user, old_assistant, first_summary, mid_user, mid_assistant):
        refreshed = await session.get(SessionMessage, row.id)
        assert refreshed is not None
        assert refreshed.exclude_from_context is True
    refreshed_second_summary = await session.get(SessionMessage, second_summary.id)
    refreshed_after_summary = await session.get(SessionMessage, after_summary.id)
    assert refreshed_second_summary is not None
    assert refreshed_after_summary is not None
    assert refreshed_second_summary.exclude_from_context is False
    assert refreshed_after_summary.exclude_from_context is False


@pytest.mark.asyncio
async def test_cleanup_reverted_middle_summary_restores_previous_summary_window(
    session,
):
    chat_session = await create_chat_session(session)

    old_user = await save_message(
        session, chat_session.id, HumanMessage(content="old u")
    )
    old_assistant = await save_message(
        session, chat_session.id, AssistantMessage(content="old a")
    )
    first_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 1"),
        is_summary=True,
    )
    first_window_user = await save_message(
        session, chat_session.id, HumanMessage(content="s1 window u")
    )
    first_window_assistant = await save_message(
        session, chat_session.id, AssistantMessage(content="s1 window a")
    )
    second_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 2"),
        is_summary=True,
    )
    second_window_user = await save_message(
        session, chat_session.id, HumanMessage(content="s2 window u")
    )
    second_window_assistant = await save_message(
        session, chat_session.id, AssistantMessage(content="s2 window a")
    )
    third_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 3"),
        is_summary=True,
    )
    await save_message(session, chat_session.id, AssistantMessage(content="after s3"))

    for row in (
        old_user,
        old_assistant,
        first_summary,
        first_window_user,
        first_window_assistant,
        second_summary,
        second_window_user,
        second_window_assistant,
    ):
        row.exclude_from_context = True
        session.add(row)
    await session.commit()

    first_undo = await undo_session_messages(session, chat_session.id)
    assert first_undo.applied is True
    assert first_undo.target and first_undo.target.id == third_summary.id
    await session.commit()

    second_undo = await undo_session_messages(session, chat_session.id)
    assert second_undo.applied is True
    assert second_undo.target and second_undo.target.id == second_summary.id
    await session.commit()

    await cleanup_reverted_tail(session, chat_session.id)
    await session.commit()

    visible = await get_messages_for_llm(session, chat_session.id)
    assert [m.content for m in visible] == [
        "summary 1",
        "s1 window u",
        "s1 window a",
    ]

    for row in (old_user, old_assistant):
        refreshed = await session.get(SessionMessage, row.id)
        assert refreshed is not None
        assert refreshed.exclude_from_context is True
    for row in (
        second_summary,
        second_window_user,
        second_window_assistant,
        third_summary,
    ):
        refreshed = await session.get(SessionMessage, row.id)
        assert refreshed is not None
        assert refreshed.exclude_from_context is True


@pytest.mark.asyncio
async def test_cleanup_reverted_branched_summary_does_not_restore_old_branch(session):
    chat_session = await create_chat_session(session)

    first_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="summary 1"),
        is_summary=True,
    )
    first_window = await save_message(
        session, chat_session.id, HumanMessage(content="s1 window")
    )

    old_branch_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="old branch summary"),
        is_summary=True,
    )
    old_branch_message = await save_message(
        session, chat_session.id, HumanMessage(content="old branch message")
    )
    for row in (old_branch_summary, old_branch_message):
        row.exclude_from_context = True
        row.extra = {"hidden_from_user": True}
        session.add(row)

    new_second_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="new summary 2"),
        is_summary=True,
    )
    new_second_window = await save_message(
        session, chat_session.id, HumanMessage(content="new s2 window")
    )
    new_third_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="new summary 3"),
        is_summary=True,
    )
    await save_message(
        session, chat_session.id, AssistantMessage(content="after new s3")
    )

    for row in (first_summary, first_window, new_second_summary, new_second_window):
        row.exclude_from_context = True
        session.add(row)
    await session.commit()

    shift = await undo_session_messages(session, chat_session.id)
    assert shift.applied is True
    assert shift.target and shift.target.id == new_third_summary.id
    await session.commit()

    await cleanup_reverted_tail(session, chat_session.id)
    await session.commit()

    visible = await get_messages_for_llm(session, chat_session.id)
    assert [m.content for m in visible] == ["new summary 2", "new s2 window"]

    refreshed_old_summary = await session.get(SessionMessage, old_branch_summary.id)
    refreshed_old_message = await session.get(SessionMessage, old_branch_message.id)
    assert refreshed_old_summary is not None
    assert refreshed_old_message is not None
    assert refreshed_old_summary.exclude_from_context is True
    assert refreshed_old_message.exclude_from_context is True


# ── get_messages excludes hidden ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_messages_excludes_hidden(session):
    """get_messages must not return is_hidden=True messages."""
    chat_session = await create_chat_session(session)

    await save_message(session, chat_session.id, HumanMessage(content="visible"))
    await save_message(
        session, chat_session.id, HumanMessage(content="hidden"), is_hidden=True
    )

    fetched = await get_messages(session, chat_session.id)
    assert len(fetched) == 1
    assert fetched[0].content == "visible"


@pytest.mark.asyncio
async def test_get_messages_excludes_hidden_from_user_extra(session):
    chat_session = await create_chat_session(session)

    await save_message(session, chat_session.id, HumanMessage(content="visible"))
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="hidden from user"),
        extra={"hidden_from_user": True},
    )

    fetched = await get_messages(session, chat_session.id)
    assert [m.content for m in fetched] == ["visible"]

    llm_messages = await get_messages_for_llm(session, chat_session.id)
    assert [m.content for m in llm_messages] == ["visible", "hidden from user"]


async def test_queued_user_messages_are_hidden_until_popped(session):
    chat_session = await create_chat_session(session, "Queue")
    queued = await save_queued_user_message(session, chat_session.id, "next")
    await save_message(
        session, chat_session.id, AssistantMessage(content="current response")
    )
    await session.commit()

    visible = await get_messages(session, chat_session.id)
    assert [msg.content for msg in visible] == ["next", "current response"]
    assert visible[0].extra and visible[0].extra["queue_status"] == "queued"
    assert isinstance(visible[0].extra.get("queued_at"), str)

    popped = await pop_queued_user_messages(session, chat_session.id)
    await session.commit()

    assert [row.id for row in popped] == [queued.id]
    assert popped[0].exclude_from_context is False
    assert popped[0].extra and isinstance(popped[0].extra.get("queued_at"), str)
    visible = await get_messages(session, chat_session.id)
    assert [msg.content for msg in visible] == ["current response", "next"]


async def test_queued_user_message_preserves_model_metadata_when_popped(session):
    chat_session = await create_chat_session(session, "Queue")
    queued = await save_queued_user_message(
        session,
        chat_session.id,
        "next",
        extra={"model": "openai:gpt-5.5", "thinking_level": "high"},
    )
    await session.commit()

    assert queued.extra is not None
    assert queued.extra["model"] == "openai:gpt-5.5"
    assert queued.extra["thinking_level"] == "high"
    assert queued.extra["queue_status"] == "queued"

    popped = await pop_queued_user_messages(session, chat_session.id)
    await session.commit()

    assert [row.id for row in popped] == [queued.id]
    assert popped[0].extra is not None
    assert popped[0].extra["model"] == "openai:gpt-5.5"
    assert popped[0].extra["thinking_level"] == "high"
    assert popped[0].extra["queued_at"] == queued.extra["queued_at"]
    assert "queue_status" not in popped[0].extra


async def test_popped_queued_user_messages_keep_queue_order_after_response(session):
    chat_session = await create_chat_session(session, "Queue")
    first = await save_queued_user_message(session, chat_session.id, "first")
    second = await save_queued_user_message(session, chat_session.id, "second")
    await save_message(session, chat_session.id, AssistantMessage(content="response"))
    await session.commit()

    popped = await pop_queued_user_messages(session, chat_session.id)
    await session.commit()

    visible = await get_messages(session, chat_session.id)
    assert [row.id for row in popped] == [first.id, second.id]
    assert [msg.content for msg in visible] == ["response", "first", "second"]


async def test_cancel_queued_user_message_skips_pop(session):
    chat_session = await create_chat_session(session, "Queue")
    queued = await save_queued_user_message(session, chat_session.id, "skip")
    await session.commit()

    cancelled = await cancel_queued_user_message(session, chat_session.id, queued.id)
    await session.commit()

    assert cancelled is True
    # Row must be hard-deleted from the database.
    assert await session.get(SessionMessage, queued.id) is None
    popped = await pop_queued_user_messages(session, chat_session.id)
    assert popped == []


async def test_cleanup_reverted_tail_preserves_queued_messages(session):
    chat_session = await create_chat_session(session, "Queue")
    await save_message(session, chat_session.id, HumanMessage(content="first"))
    await save_message(session, chat_session.id, AssistantMessage(content="response"))
    queued = await save_queued_user_message(session, chat_session.id, "queued")
    await session.commit()

    shift = await undo_session_messages(session, chat_session.id)
    assert shift.applied is True
    await session.commit()

    cleaned = await cleanup_reverted_tail(session, chat_session.id)
    await session.commit()

    refreshed = await session.get(SessionMessage, queued.id)
    assert cleaned == 2
    assert refreshed is not None
    assert refreshed.extra and refreshed.extra["queue_status"] == "queued"
    assert isinstance(refreshed.extra.get("queued_at"), str)
    assert refreshed.exclude_from_context is True
    popped = await pop_queued_user_messages(session, chat_session.id)
    assert [row.id for row in popped] == [queued.id]


@pytest.mark.asyncio
async def test_get_messages_includes_summary_message(session):
    """Summary messages (HumanMessage) are visible so get_messages returns them."""
    chat_session = await create_chat_session(session)
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="Summary."),
        is_summary=True,
    )

    fetched = await get_messages(session, chat_session.id)
    assert len(fetched) == 1
    assert isinstance(fetched[0], HumanMessage)
    assert fetched[0].content == "Summary."


# ── get_messages_for_llm ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_messages_for_llm_no_summary_returns_all_visible(session):
    """With no summary, get_messages_for_llm behaves like get_messages."""
    chat_session = await create_chat_session(session)

    await save_message(session, chat_session.id, HumanMessage(content="a"))
    await save_message(session, chat_session.id, AssistantMessage(content="b"))

    result = await get_messages_for_llm(session, chat_session.id)
    assert len(result) == 2


@pytest.mark.asyncio
async def test_get_messages_for_llm_returns_summary_plus_newer_messages(session):
    """With a summary present, only the summary and post-summary messages are returned."""
    chat_session = await create_chat_session(session)

    # Old messages that will be hidden
    await save_message(
        session, chat_session.id, HumanMessage(content="old 1"), is_hidden=True
    )
    await save_message(
        session, chat_session.id, AssistantMessage(content="old 2"), is_hidden=True
    )

    # Summary is stored as HumanMessage
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="Summary of old conversation."),
        is_summary=True,
    )

    # New messages after the summary
    await save_message(session, chat_session.id, HumanMessage(content="new 1"))
    await save_message(session, chat_session.id, AssistantMessage(content="new 2"))

    result = await get_messages_for_llm(session, chat_session.id)

    contents = [m.content for m in result]
    # Must include the summary itself
    assert "Summary of old conversation." in contents
    # Summary must be a HumanMessage (not AssistantMessage) for valid role ordering
    summary_msg = next(m for m in result if m.content == "Summary of old conversation.")
    assert isinstance(summary_msg, HumanMessage)
    # Must include post-summary messages
    assert "new 1" in contents
    assert "new 2" in contents
    # Must NOT include hidden old messages
    assert "old 1" not in contents
    assert "old 2" not in contents
    # Summary must be first
    assert result[0].content == "Summary of old conversation."


@pytest.mark.asyncio
async def test_get_messages_for_llm_uses_most_recent_summary(session):
    """When multiple summaries exist, only the latest one and messages after it are included."""
    chat_session = await create_chat_session(session)

    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="First summary."),
        is_summary=True,
        is_hidden=False,
    )
    await save_message(
        session, chat_session.id, HumanMessage(content="middle"), is_hidden=True
    )
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="Latest summary."),
        is_summary=True,
    )
    await save_message(session, chat_session.id, HumanMessage(content="after latest"))

    result = await get_messages_for_llm(session, chat_session.id)
    contents = [m.content for m in result]
    assert "Latest summary." in contents
    assert "after latest" in contents
    # First summary is older than latest_summary.created_at and is_hidden=False
    # but created_at <= latest_summary.created_at so it won't be included via
    # the "after" branch; it's also not the latest summary row selected
    assert "First summary." not in contents
    assert "middle" not in contents


@pytest.mark.asyncio
async def test_get_messages_for_llm_drops_orphan_tool_message(session):
    """LLM context never includes tool rows without visible assistant calls."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="hello"))
    await save_message(
        session,
        chat_session.id,
        ToolMessage(content="orphan", tool_call_id="missing_call", name="search"),
    )
    await session.commit()

    result = await get_messages_for_llm(session, chat_session.id)

    assert [m.role for m in result] == ["user"]


@pytest.mark.asyncio
async def test_get_messages_for_llm_summary_window_drops_orphan_tool_message(session):
    """Summary + keep_last_n windows are sanitized after window selection."""
    chat_session = await create_chat_session(session)
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="Summary of earlier context."),
        is_summary=True,
    )
    await save_message(session, chat_session.id, HumanMessage(content="new turn"))
    await save_message(
        session,
        chat_session.id,
        ToolMessage(content="orphan", tool_call_id="missing_call", name="search"),
    )
    await session.commit()

    result = await get_messages_for_llm(session, chat_session.id)

    assert [m.role for m in result] == ["user", "user"]
    assert [m.content for m in result] == ["Summary of earlier context.", "new turn"]


@pytest.mark.asyncio
async def test_get_messages_for_llm_uses_synthetic_shell_user_marker(session):
    """Visible !command rows become opencode-style synthetic markers for LLM context."""
    chat_session = await create_chat_session(session)
    tool_call = ToolCall(
        id="shell-1",
        function=FunctionCall(
            name="shell",
            arguments='{"command":"pwd","description":"Run user shell command"}',
        ),
    )
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="!pwd"),
        extra={"kind": "user_shell", "command": "pwd"},
    )
    await save_message(
        session,
        chat_session.id,
        AssistantMessage(content=None, tool_calls=[tool_call]),
    )
    await save_message(
        session,
        chat_session.id,
        ToolMessage(content="/repo", tool_call_id="shell-1", name="shell"),
    )
    await session.commit()

    result = await get_messages_for_llm(session, chat_session.id)

    assert [m.role for m in result] == ["user", "assistant", "tool"]
    assert result[0].content == "The following tool was executed by the user"
    assert result[0].extra and result[0].extra["command"] == "pwd"


# ── hide_messages_before_summary ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hide_messages_before_summary(session):
    """hide_messages_before_summary marks all non-summary older messages as hidden."""
    chat_session = await create_chat_session(session)

    m1 = await save_message(session, chat_session.id, HumanMessage(content="msg 1"))
    m2 = await save_message(session, chat_session.id, AssistantMessage(content="msg 2"))
    summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="Summary"),
        is_summary=True,
    )
    m4 = await save_message(session, chat_session.id, HumanMessage(content="msg 4"))

    hidden_count = await hide_messages_before_summary(
        session, chat_session.id, summary.id
    )
    await session.commit()

    assert hidden_count == 2

    # Reload from DB
    from sqlmodel import col, select
    from app.models.chat import SessionMessage

    rows = (
        await session.exec(
            select(SessionMessage).where(
                col(SessionMessage.session_id) == chat_session.id
            )
        )
    ).all()
    by_id = {r.id: r for r in rows}

    assert by_id[m1.id].exclude_from_context is True
    assert by_id[m2.id].exclude_from_context is True
    assert (
        by_id[summary.id].exclude_from_context is False
    )  # summary itself not excluded
    assert by_id[m4.id].exclude_from_context is False  # after summary — not touched


@pytest.mark.asyncio
async def test_hide_messages_before_summary_missing_summary(session):
    """Returns 0 when the summary message id does not exist."""
    from uuid import uuid7

    chat_session = await create_chat_session(session)
    count = await hide_messages_before_summary(session, chat_session.id, uuid7())
    assert count == 0


@pytest.mark.asyncio
async def test_hide_messages_before_summary_keep_last_n_all_spare(session):
    """When keep_last_n >= number of pre-summary messages, nothing is hidden."""
    chat_session = await create_chat_session(session)

    m1 = await save_message(session, chat_session.id, HumanMessage(content="msg 1"))
    m2 = await save_message(session, chat_session.id, AssistantMessage(content="msg 2"))
    summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="Summary"),
        is_summary=True,
    )

    # keep_last_n=5 but only 2 pre-summary messages — all should be spared
    hidden_count = await hide_messages_before_summary(
        session, chat_session.id, summary.id, keep_last_n=5
    )
    await session.commit()
    assert hidden_count == 0

    from sqlmodel import col, select
    from app.models.chat import SessionMessage

    rows = (
        await session.exec(
            select(SessionMessage).where(
                col(SessionMessage.session_id) == chat_session.id
            )
        )
    ).all()
    by_id = {r.id: r for r in rows}
    assert by_id[m1.id].exclude_from_context is False
    assert by_id[m2.id].exclude_from_context is False


@pytest.mark.asyncio
async def test_create_chat_session_error_propagates(session):
    """create_chat_session re-raises on DB error."""
    from unittest.mock import patch

    with patch.object(session, "flush", side_effect=Exception("db error")):
        with pytest.raises(Exception, match="db error"):
            await create_chat_session(session, title="fail")


@pytest.mark.asyncio
async def test_save_message_error_propagates(session):
    """save_message re-raises on DB error."""
    from unittest.mock import patch

    chat_session = await create_chat_session(session)
    with patch.object(session, "flush", side_effect=Exception("write error")):
        with pytest.raises(Exception, match="write error"):
            await save_message(session, chat_session.id, HumanMessage(content="x"))


@pytest.mark.asyncio
async def test_get_messages_error_propagates(session):
    """get_messages re-raises on DB error."""
    from unittest.mock import patch
    from uuid import uuid7

    with patch.object(session, "exec", side_effect=Exception("read error")):
        with pytest.raises(Exception, match="read error"):
            await get_messages(session, uuid7())


@pytest.mark.asyncio
async def test_get_messages_for_llm_error_propagates(session):
    """get_messages_for_llm re-raises on DB error."""
    from unittest.mock import patch
    from uuid import uuid7

    with patch.object(session, "exec", side_effect=Exception("llm read error")):
        with pytest.raises(Exception, match="llm read error"):
            await get_messages_for_llm(session, uuid7())


# ── Summarisation integration: full flow ────────────────────────────────────


@pytest.mark.asyncio
async def test_summary_flow_produces_valid_llm_context(session):
    """Integration: save messages, insert summary, hide old ones, check get_messages_for_llm.

    Verifies:
    - Summary (HumanMessage) is first in the returned list.
    - Post-summary messages follow in order.
    - Hidden pre-summary messages are excluded.
    - Exact count and types are correct.
    """
    chat_session = await create_chat_session(session)

    # Initial conversation (will be hidden after summarization)
    await save_message(session, chat_session.id, HumanMessage(content="Hello"))
    await save_message(session, chat_session.id, AssistantMessage(content="Hi there"))
    await save_message(
        session, chat_session.id, HumanMessage(content="What is Python?")
    )
    await save_message(
        session, chat_session.id, AssistantMessage(content="A programming language.")
    )

    # Summarization fires: save summary as HumanMessage with is_summary=True
    summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(
            content="[Summary] User asked about Python. Bot explained it is a programming language."
        ),
        is_summary=True,
    )

    # Hide all pre-summary messages (keep_last_n=0 for this test)
    hidden_count = await hide_messages_before_summary(
        session, chat_session.id, summary.id, keep_last_n=0
    )
    await session.commit()
    assert hidden_count == 4

    # New conversation turn after summarization
    await save_message(session, chat_session.id, HumanMessage(content="Tell me more"))
    await save_message(session, chat_session.id, AssistantMessage(content="Sure!"))
    await session.commit()

    result = await get_messages_for_llm(session, chat_session.id)

    # Summary is first and is a HumanMessage
    assert len(result) == 3
    assert isinstance(result[0], HumanMessage)
    assert result[0].content is not None
    assert "[Summary]" in result[0].content

    # Followed by the two new messages in order
    assert isinstance(result[1], HumanMessage)
    assert result[1].content == "Tell me more"
    assert isinstance(result[2], AssistantMessage)
    assert result[2].content == "Sure!"

    # Hidden old messages not present
    old_contents = {m.content for m in result}
    assert "Hello" not in old_contents
    assert "Hi there" not in old_contents
    assert "What is Python?" not in old_contents
    assert "A programming language." not in old_contents


@pytest.mark.asyncio
async def test_summary_flow_with_keep_last_n(session):
    """Integration: keep_last_n=2 preserves last 2 messages before summary in LLM context.

    After summarization with keep_last_n=2, get_messages_for_llm should return:
    [summary, kept_msg_3, kept_msg_4, post_summary_msg]
    """
    chat_session = await create_chat_session(session)

    await save_message(session, chat_session.id, HumanMessage(content="msg 1"))
    await save_message(session, chat_session.id, AssistantMessage(content="msg 2"))
    await save_message(session, chat_session.id, HumanMessage(content="msg 3"))
    await save_message(session, chat_session.id, AssistantMessage(content="msg 4"))

    summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[Summary] First two messages covered greetings."),
        is_summary=True,
    )

    hidden_count = await hide_messages_before_summary(
        session, chat_session.id, summary.id, keep_last_n=2
    )
    await session.commit()
    # Only msg 1 and msg 2 should be hidden; msg 3 and msg 4 are kept
    assert hidden_count == 2

    await save_message(session, chat_session.id, HumanMessage(content="msg 5"))
    await session.commit()

    result = await get_messages_for_llm(session, chat_session.id)

    contents = [m.content for m in result]
    # Summary first
    assert result[0].content == "[Summary] First two messages covered greetings."
    assert isinstance(result[0], HumanMessage)
    # Kept messages and post-summary present
    assert "msg 3" in contents
    assert "msg 4" in contents
    assert "msg 5" in contents
    # Hidden messages excluded
    assert "msg 1" not in contents
    assert "msg 2" not in contents
    assert len(result) == 4  # summary + msg3 + msg4 + msg5


# ── exclude_messages_before_summary — old summaries excluded (lines 276-277) ─


@pytest.mark.asyncio
async def test_exclude_messages_before_summary_marks_old_summaries_excluded(session):
    """Lines 276-277: when a second summary is created, the first summary row
    is marked exclude_from_context=True by exclude_messages_before_summary."""
    from app.services.chat_service import exclude_messages_before_summary

    chat_session = await create_chat_session(session)

    # Me first summary (older)
    first_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[Summary] First summary."),
        is_summary=True,
    )

    # Me some messages after first summary
    await save_message(
        session, chat_session.id, HumanMessage(content="msg after first")
    )

    # Me second (newer) summary
    second_summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[Summary] Second summary."),
        is_summary=True,
    )

    # Me call with second summary id — should exclude first summary
    await exclude_messages_before_summary(session, chat_session.id, second_summary.id)
    await session.commit()

    # Me reload first summary row from DB
    from sqlmodel import col, select
    from app.models.chat import SessionMessage

    rows = (
        await session.exec(
            select(SessionMessage).where(col(SessionMessage.id) == first_summary.id)
        )
    ).all()
    assert len(rows) == 1
    # Me first summary should now be excluded
    assert rows[0].exclude_from_context is True

    # Me second summary itself should NOT be excluded
    second_rows = (
        await session.exec(
            select(SessionMessage).where(col(SessionMessage.id) == second_summary.id)
        )
    ).all()
    assert second_rows[0].exclude_from_context is False


@pytest.mark.asyncio
async def test_get_messages_for_llm_preserves_skill_tool_pair_after_summary(session):
    """Skill tool call/result pairs remain visible after compaction.

    The live SummarizationHook already preserves these rows in memory. This
    verifies the persisted summary-window loader keeps the same invariant after
    a compacted session is reloaded.
    """
    chat_session = await create_chat_session(session)

    await save_message(session, chat_session.id, HumanMessage(content="load skill"))
    await save_message(
        session,
        chat_session.id,
        AssistantMessage(
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_skill_1",
                    function=FunctionCall(
                        name="skill", arguments='{"skill_name":"guidelines"}'
                    ),
                )
            ],
        ),
    )
    await save_message(
        session,
        chat_session.id,
        ToolMessage(
            content="Guideline instructions body",
            tool_call_id="call_skill_1",
            name="skill",
        ),
    )
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="Summary of previous non-skill work."),
        is_summary=True,
    )
    await session.commit()

    result = await get_messages_for_llm(session, chat_session.id)

    skill_call = next(
        m
        for m in result
        if isinstance(m, AssistantMessage)
        and m.tool_calls
        and m.tool_calls[0].function.name == "skill"
    )
    skill_result = next(
        m for m in result if isinstance(m, ToolMessage) and m.name == "skill"
    )

    assert result[0].is_summary
    assert skill_call.tool_calls[0].id == "call_skill_1"
    assert skill_result.tool_call_id == "call_skill_1"
    assert skill_result.content == "Guideline instructions body"


@pytest.mark.asyncio
async def test_get_messages_for_llm_summary_appears_exactly_once(session):
    """The summary row must appear exactly once even when other rows share its timestamp.

    get_messages_for_llm prepends the latest summary explicitly and then fetches
    non-summary rows, so the summary is never duplicated regardless of timestamps.
    """
    from app.models.chat import SessionMessage

    chat_session = await create_chat_session(session)

    await save_message(session, chat_session.id, HumanMessage(content="before"))
    summary = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[Summary] Compact history."),
        is_summary=True,
    )
    await session.commit()

    # Force a non-hidden, non-summary message to share the exact created_at as the summary.
    same_ts_msg = SessionMessage(
        session_id=chat_session.id,
        role="user",
        content="same-timestamp sibling",
        exclude_from_context=False,
        is_summary=False,
    )
    same_ts_msg.created_at = summary.created_at
    session.add(same_ts_msg)
    await session.commit()

    result = await get_messages_for_llm(session, chat_session.id)
    contents = [m.content for m in result]

    # Summary appears exactly once — never duplicated by the non-summary query
    assert contents.count("[Summary] Compact history.") == 1
    # Non-hidden, non-summary messages (before + sibling) are included
    assert "before" in contents
    assert "same-timestamp sibling" in contents


# ---------------------------------------------------------------------------
# heal_orphaned_tool_calls
# ---------------------------------------------------------------------------


def _assistant_with_tool_calls(*ids_and_names: tuple[str, str]) -> AssistantMessage:
    """Build an assistant message carrying ``tool_calls`` for each (id, name)."""
    return AssistantMessage(
        content="",
        tool_calls=[
            ToolCall(id=tcid, function=FunctionCall(name=tcname, arguments="{}"))
            for tcid, tcname in ids_and_names
        ],
    )


@pytest.mark.asyncio
async def test_heal_noop_when_no_assistant_messages(session):
    """No assistant message in the session → nothing to heal."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="hi"))
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    assert healed == 0


@pytest.mark.asyncio
async def test_heal_noop_when_last_assistant_has_no_tool_calls(session):
    """Final-answer assistant message → nothing to heal."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="hi"))
    await save_message(session, chat_session.id, AssistantMessage(content="hello!"))
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    assert healed == 0


@pytest.mark.asyncio
async def test_heal_noop_when_all_tool_calls_have_results(session):
    """Healthy turn (assistant{tool_calls} + matching tool replies) → noop."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="hi"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search"), ("c2", "fetch")),
    )
    await save_message(
        session,
        chat_session.id,
        ToolMessage(content="r1", tool_call_id="c1", name="search"),
    )
    await save_message(
        session,
        chat_session.id,
        ToolMessage(content="r2", tool_call_id="c2", name="fetch"),
    )
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    assert healed == 0


@pytest.mark.asyncio
async def test_heal_synthesises_stub_for_fully_orphaned_tool_calls(session):
    """Crash mid-tool: assistant{tool_calls} with zero tool replies → all stubbed."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="hi"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search"), ("c2", "fetch")),
    )
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    await session.commit()

    assert healed == 2

    # Both stubs should now be visible, with the canonical interrupted message.
    msgs = await get_messages(session, chat_session.id)
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert {m.tool_call_id for m in tool_msgs} == {"c1", "c2"}
    assert {m.name for m in tool_msgs} == {"search", "fetch"}
    for tm in tool_msgs:
        assert tm.content is not None and "interrupted" in tm.content.lower()


@pytest.mark.asyncio
async def test_heal_synthesises_stub_only_for_missing_ids(session):
    """Partial orphan: one tool call has a result, the other doesn't.

    Only the missing one is synthesised; the existing result is untouched.
    """
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="hi"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search"), ("c2", "fetch")),
    )
    await save_message(
        session,
        chat_session.id,
        ToolMessage(content="real-result", tool_call_id="c1", name="search"),
    )
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    await session.commit()

    assert healed == 1

    msgs = await get_messages(session, chat_session.id)
    tool_msgs = [m for m in msgs if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 2
    by_id = {m.tool_call_id: m for m in tool_msgs}
    assert by_id["c1"].content == "real-result"
    c2_content = by_id["c2"].content
    assert c2_content is not None and "interrupted" in c2_content.lower()


@pytest.mark.asyncio
async def test_heal_is_idempotent(session):
    """Running the heal twice in a row inserts stubs only the first time."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="hi"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search")),
    )
    await session.commit()

    first = await heal_orphaned_tool_calls(session, chat_session.id)
    await session.commit()
    second = await heal_orphaned_tool_calls(session, chat_session.id)
    await session.commit()

    assert first == 1
    assert second == 0


@pytest.mark.asyncio
async def test_heal_orders_stubs_between_assistant_and_next_user_message(session):
    """The synthesised tool replies must sit *between* the orphaned
    assistant turn and the new user message in chronological order, so
    that ``get_messages_for_llm`` returns
    ``assistant{tool_calls} → tool → user`` instead of
    ``assistant{tool_calls} → user → tool``.

    OpenAI rejects the latter with ``"No tool output found for function
    call …"``; this regression test pins the ordering invariant.
    """
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="first"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search"), ("c2", "fetch")),
    )
    await session.commit()

    # Heal *before* persisting the new user message — same order as the
    # production call site in ``team.handle_user_message``.
    await heal_orphaned_tool_calls(session, chat_session.id)
    await save_message(session, chat_session.id, HumanMessage(content="follow-up"))
    await session.commit()

    msgs = await get_messages_for_llm(session, chat_session.id)
    roles = [m.role for m in msgs]
    # first user, assistant{tool_calls}, two tool stubs, then the new user.
    assert roles == ["user", "assistant", "tool", "tool", "user"]
    # Tool stubs must reference the orphaned assistant's IDs.
    stub_a, stub_b = msgs[2], msgs[3]
    assert isinstance(stub_a, ToolMessage) and isinstance(stub_b, ToolMessage)
    assert {stub_a.tool_call_id, stub_b.tool_call_id} == {"c1", "c2"}
    # And the follow-up user message is the actual tail.
    assert msgs[-1].content == "follow-up"


@pytest.mark.asyncio
async def test_heal_only_inspects_latest_assistant_message(session):
    """An older healthy turn followed by a newer healthy turn must not
    trigger heal even if the older turn has tool_calls.

    Guards the ``LIMIT 1`` peek logic — we only care about the tail."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="q1"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search")),
    )
    await save_message(
        session,
        chat_session.id,
        ToolMessage(content="result", tool_call_id="c1", name="search"),
    )
    await save_message(session, chat_session.id, AssistantMessage(content="answer"))
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    assert healed == 0


@pytest.mark.asyncio
async def test_heal_synthesises_stub_for_older_visible_orphan_after_summary(session):
    """Compacted LLM windows can expose an older orphan before the tail.

    Production regression: ``get_messages_for_llm`` returned
    ``[summary] + keep_last_n`` where the latest assistant had no tool calls,
    but an earlier visible assistant still had unmatched ``tool_calls``. OpenAI
    validates the full message array and rejected the request.
    """
    chat_session = await create_chat_session(session)
    await save_message(
        session,
        chat_session.id,
        HumanMessage(content="[Summary] prior context"),
        is_summary=True,
    )
    await save_message(session, chat_session.id, HumanMessage(content="q1"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search")),
    )
    await save_message(session, chat_session.id, HumanMessage(content="q2"))
    await save_message(session, chat_session.id, AssistantMessage(content="answer"))
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    await session.commit()

    assert healed == 1
    msgs = await get_messages_for_llm(session, chat_session.id)
    roles = [m.role for m in msgs]
    assert roles == ["user", "user", "assistant", "tool", "user", "assistant"]
    stub = msgs[3]
    assert isinstance(stub, ToolMessage)
    assert stub.tool_call_id == "c1"
    assert stub.name == "search"


@pytest.mark.asyncio
async def test_heal_skips_summary_messages_when_finding_latest_assistant(session):
    """SystemMessage rows in between mustn't confuse the lookup.

    The heal targets the latest *assistant* row specifically; system /
    summary rows (which never carry tool_calls) are irrelevant."""
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, SystemMessage(content="sys"))
    await save_message(session, chat_session.id, HumanMessage(content="hi"))
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("c1", "search")),
    )
    await session.commit()

    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    assert healed == 1


@pytest.mark.asyncio
async def test_heal_ignores_reverted_assistant_after_undo_cleanup(session):
    """Undo + edited resend must not heal the hidden stopped tool-call branch.

    Reproduction shape:
    U1 -> A1 -> U2 -> A2(tool_calls, interrupted) -> undo U2 -> send edited U2.
    ``cleanup_reverted_tail`` hides U2/A2 before the resend. The orphan healer
    must not inspect hidden A2 and create a visible tool result with no visible
    matching assistant function call, which the Responses API rejects.
    """
    chat_session = await create_chat_session(session)
    await save_message(session, chat_session.id, HumanMessage(content="first"))
    await save_message(session, chat_session.id, AssistantMessage(content="answer"))
    second = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="second"),
    )
    await save_message(
        session,
        chat_session.id,
        _assistant_with_tool_calls(("fc_hidden", "search")),
        extra={"interrupted": True},
    )
    chat_session.revert = {"message_id": str(second.id)}
    session.add(chat_session)
    await session.commit()

    hidden_count = await cleanup_reverted_tail(session, chat_session.id)
    await save_message(session, chat_session.id, HumanMessage(content="edited second"))
    healed = await heal_orphaned_tool_calls(session, chat_session.id)
    await session.commit()

    assert hidden_count == 2
    assert healed == 0
    msgs = await get_messages_for_llm(session, chat_session.id)
    assert [m.role for m in msgs] == ["user", "assistant", "user"]
    assert msgs[-1].content == "edited second"
    assert not any(isinstance(m, ToolMessage) for m in msgs)


@pytest.mark.asyncio
async def test_undo_and_redo_use_workspace_snapshots(session, tmp_path, monkeypatch):
    """/undo and /redo pass the right snapshot anchors to the workspace layer."""
    from app.services import snapshot_service
    from app.services.chat_service import (
        redo_session_messages,
        undo_session_messages,
    )

    ws = tmp_path / "ws"
    ws.mkdir()
    doc = ws / "doc.md"
    snapshots: dict[str, str] = {}

    async def fake_track(session_id: str, workspace):
        assert workspace == ws
        snapshot = f"{len(snapshots) + 1:040x}"
        snapshots[snapshot] = doc.read_text()
        return snapshot

    async def fake_restore(
        session_id: str,
        workspace,
        snapshot: str,
        *,
        skip_stage: bool = False,
    ):
        assert workspace == ws
        assert snapshot in snapshots
        doc.write_text(snapshots[snapshot])
        return snapshot_service.RestoreResult(ok=True, modified=["doc.md"])

    monkeypatch.setattr(snapshot_service, "track", fake_track)
    monkeypatch.setattr(snapshot_service, "restore", fake_restore)

    import app.services.chat_service as cs

    monkeypatch.setattr(cs, "session_workspace_dir", lambda sid, w: ws)

    chat_session = await create_chat_session(session)

    # ── Turn 1 ────────────────────────────────────────────────────────
    doc = ws / "doc.md"
    doc.write_text("v1")
    snap_u1 = await snapshot_service.track(str(chat_session.id), ws)
    assert snap_u1 is not None
    u1 = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="hello"),
        extra={"snapshot": snap_u1},
    )
    await save_message(session, chat_session.id, AssistantMessage(content="ok"))
    # Simulate the assistant writing v2.
    doc.write_text("v2")

    # ── Turn 2 ────────────────────────────────────────────────────────
    snap_u2 = await snapshot_service.track(str(chat_session.id), ws)
    assert snap_u2 is not None
    u2 = await save_message(
        session,
        chat_session.id,
        HumanMessage(content="again"),
        extra={"snapshot": snap_u2},
    )
    await save_message(session, chat_session.id, AssistantMessage(content="done"))
    # Simulate the assistant writing v3 (current live state).
    doc.write_text("v3")
    await session.commit()

    # ── /undo #1: boundary lands on U2, workspace rewinds to snap_u2 ──
    shift = await undo_session_messages(session, chat_session.id)
    assert shift.applied is True
    assert shift.target is not None
    assert shift.target.id == u2.id
    assert doc.read_text() == "v2"
    # The restore reverted a modification — doc.md should appear in
    # ``modified``, with empty ``added`` and ``removed``. The HTTP
    # layer pipes this partition out to the client.
    assert "doc.md" in shift.modified
    assert shift.added == [] and shift.removed == []

    refreshed = await session.get(ChatSession, chat_session.id)
    assert refreshed is not None
    assert refreshed.revert is not None
    redo_anchor = refreshed.revert.get("snapshot")
    assert isinstance(redo_anchor, str) and len(redo_anchor) == 40

    # ── /undo #2: boundary moves to U1, workspace rewinds to snap_u1 ──
    shift = await undo_session_messages(session, chat_session.id)
    assert shift.applied is True
    assert shift.target is not None
    assert shift.target.id == u1.id
    assert doc.read_text() == "v1"

    refreshed = await session.get(ChatSession, chat_session.id)
    assert refreshed is not None
    # Redo anchor must be the *same* hash captured on the first /undo —
    # so /redo eventually returns to the live tip (v3), not the
    # intermediate v2 state.
    assert refreshed.revert is not None
    assert refreshed.revert.get("snapshot") == redo_anchor

    # ── /redo #1: boundary moves forward to U2, workspace = snap_u2 ───
    shift = await redo_session_messages(session, chat_session.id)
    assert shift.applied is True
    # The next-user pointer is plumbed back so /api/team/commands can
    # echo it to the client for local boundary application.
    assert shift.target is not None
    assert shift.target.id == u2.id
    assert doc.read_text() == "v2"
    assert "doc.md" in shift.modified

    # ── /redo #2: no more user messages ahead → clear revert, restore
    # the live tip via the preserved redo anchor.
    shift = await redo_session_messages(session, chat_session.id)
    assert shift.applied is True
    assert shift.target is None  # cleared, no boundary
    assert doc.read_text() == "v3"
    assert "doc.md" in shift.modified
    refreshed = await session.get(ChatSession, chat_session.id)
    assert refreshed is not None
    assert refreshed.revert is None
