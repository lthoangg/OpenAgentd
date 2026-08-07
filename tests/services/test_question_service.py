"""Tests for :mod:`app.services.question_service`.

The service owns the durable half of ``ask_user``: it writes the
``pending_questions`` row *and* the placeholder ``ToolMessage`` in one
transaction, then rewrites that placeholder in place when the user answers or
dismisses.  The placeholder is load-bearing — it is what stops
``heal_orphaned_tool_calls`` from treating the suspended tool call as an
orphan and stuffing a synthetic "interrupted" result into the history.
"""

from __future__ import annotations

import uuid

from sqlmodel import select

from app.models.chat import ChatSession, PendingQuestion, SessionMessage
from app.services import question_service
from app.services.chat_service import heal_orphaned_tool_calls, save_message

QUESTIONS = [
    {
        "question": "Which package manager?",
        "header": "Package manager",
        "multiple": False,
        "custom": True,
        "options": [
            {"label": "pnpm", "description": "Fast", "recommended": True},
            {"label": "bun", "description": "Faster", "recommended": False},
        ],
    }
]


async def _session_with_tool_call(db, session_id: uuid.UUID, call_id: str) -> None:
    """Persist a session whose last assistant message carries *call_id*."""
    from app.agent.schemas.chat import AssistantMessage

    db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
    await db.commit()
    await save_message(
        db,
        session_id,
        AssistantMessage(
            content=None,
            tool_calls=[
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": "ask_user", "arguments": "{}"},
                }
            ],
        ),
    )
    await db.commit()


async def test_create_writes_row_and_placeholder_tool_result():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, session_id, "call_1")
        row = await question_service.create_pending_question(
            db, session_id=session_id, tool_call_id="call_1", questions=QUESTIONS
        )
        await db.commit()

        assert row.status == "pending"

        placeholder = (
            await db.exec(
                select(SessionMessage).where(SessionMessage.tool_call_id == "call_1")
            )
        ).one()

    assert placeholder.role == "tool"
    assert placeholder.name == "ask_user"
    assert placeholder.content == question_service.PLACEHOLDER_RESULT


async def test_placeholder_prevents_orphan_healing():
    """A suspended tool call must not be healed into an interrupted result."""
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, session_id, "call_1")
        await question_service.create_pending_question(
            db, session_id=session_id, tool_call_id="call_1", questions=QUESTIONS
        )
        await db.commit()

        healed = await heal_orphaned_tool_calls(db, session_id)
        await db.commit()

        rows = (
            await db.exec(
                select(SessionMessage).where(SessionMessage.tool_call_id == "call_1")
            )
        ).all()

    assert healed == 0
    assert len(rows) == 1
    assert rows[0].content == question_service.PLACEHOLDER_RESULT


async def test_answer_rewrites_placeholder_and_resolves_row():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, session_id, "call_1")
        row = await question_service.create_pending_question(
            db, session_id=session_id, tool_call_id="call_1", questions=QUESTIONS
        )
        await db.commit()

        resolved = await question_service.resolve_pending_question(
            db, question_id=row.id, status="answered", answers=[["pnpm"]]
        )
        await db.commit()

        assert resolved is not None
        assert resolved.status == "answered"
        assert resolved.answers == [["pnpm"]]
        assert resolved.answered_at is not None

        placeholder = (
            await db.exec(
                select(SessionMessage).where(SessionMessage.tool_call_id == "call_1")
            )
        ).one()

    assert "pnpm" in (placeholder.content or "")
    assert "Which package manager?" in (placeholder.content or "")


async def test_second_answer_is_rejected():
    """Two devices racing: the first write wins, the second is a no-op."""
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, session_id, "call_1")
        row = await question_service.create_pending_question(
            db, session_id=session_id, tool_call_id="call_1", questions=QUESTIONS
        )
        await db.commit()

        first = await question_service.resolve_pending_question(
            db, question_id=row.id, status="answered", answers=[["pnpm"]]
        )
        await db.commit()
        second = await question_service.resolve_pending_question(
            db, question_id=row.id, status="answered", answers=[["bun"]]
        )
        await db.commit()

    assert first is not None
    assert second is None


async def test_dismiss_marks_row_and_placeholder():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, session_id, "call_1")
        row = await question_service.create_pending_question(
            db, session_id=session_id, tool_call_id="call_1", questions=QUESTIONS
        )
        await db.commit()

        resolved = await question_service.resolve_pending_question(
            db, question_id=row.id, status="dismissed"
        )
        await db.commit()

        placeholder = (
            await db.exec(
                select(SessionMessage).where(SessionMessage.tool_call_id == "call_1")
            )
        ).one()

    assert resolved is not None
    assert resolved.status == "dismissed"
    assert "dismissed" in (placeholder.content or "").lower()


async def test_get_pending_question_returns_only_open_rows():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, session_id, "call_1")
        row = await question_service.create_pending_question(
            db, session_id=session_id, tool_call_id="call_1", questions=QUESTIONS
        )
        await db.commit()

        assert (await question_service.get_pending_question(db, session_id)) is not None

        await question_service.resolve_pending_question(
            db, question_id=row.id, status="dismissed"
        )
        await db.commit()

        assert (await question_service.get_pending_question(db, session_id)) is None


async def test_sessions_awaiting_input_lists_only_pending_sessions():
    from app.core import db as core_db

    waiting = uuid.uuid4()
    resolved_session = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, waiting, "call_1")
        await _session_with_tool_call(db, resolved_session, "call_2")
        await question_service.create_pending_question(
            db, session_id=waiting, tool_call_id="call_1", questions=QUESTIONS
        )
        row2 = await question_service.create_pending_question(
            db, session_id=resolved_session, tool_call_id="call_2", questions=QUESTIONS
        )
        await db.commit()
        await question_service.resolve_pending_question(
            db, question_id=row2.id, status="answered"
        )
        await db.commit()

        awaiting = await question_service.sessions_awaiting_input(db)

    assert awaiting == {waiting}


def test_format_answers_marks_unanswered_questions():
    questions = [
        {"question": "Which package manager?", "header": "PM", "options": []},
        {"question": "Run the tests?", "header": "Tests", "options": []},
    ]
    text = question_service.format_answers_for_model(questions, [["pnpm"], []])

    assert "Which package manager?" in text
    assert "pnpm" in text
    assert "Unanswered" in text


async def test_pending_question_survives_a_fresh_db_session():
    """Durability: the suspension outlives the process that created it."""
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _session_with_tool_call(db, session_id, "call_1")
        await question_service.create_pending_question(
            db, session_id=session_id, tool_call_id="call_1", questions=QUESTIONS
        )
        await db.commit()

    async with core_db.async_session_factory() as fresh:
        row = await question_service.get_pending_question(fresh, session_id)
        stored = (
            await fresh.exec(
                select(PendingQuestion).where(PendingQuestion.session_id == session_id)
            )
        ).one()

    assert row is not None
    assert stored.payload["questions"][0]["header"] == "Package manager"
