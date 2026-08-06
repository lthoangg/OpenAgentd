"""Tests for the ``pending_questions`` table backing ``ask_user``.

The table is the durability anchor for a suspended lead turn: the row
survives a daemon restart so the question can be re-rendered and the turn
resumed.  Two DB-level invariants matter and are asserted here:

* at most **one** open (``status="pending"``) question per session, and
* a question dies with its session (FK cascade), leaving no rows that would
  make a recreated session look like it is awaiting input.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from app.models.chat import ChatSession, PendingQuestion


def _payload() -> dict:
    return {
        "questions": [
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
    }


async def _make_session(db, session_id: uuid.UUID) -> None:
    db.add(ChatSession(id=session_id, agent_name="openagentd", mode="coding"))
    await db.commit()


async def test_new_row_defaults_to_pending_with_no_answers():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _make_session(db, session_id)
        db.add(
            PendingQuestion(
                session_id=session_id,
                tool_call_id="call_abc",
                payload=_payload(),
            )
        )
        await db.commit()

        row = (
            await db.exec(
                select(PendingQuestion).where(PendingQuestion.session_id == session_id)
            )
        ).one()

    assert row.status == "pending"
    assert row.answers is None
    assert row.answered_at is None
    assert row.payload["questions"][0]["header"] == "Package manager"
    assert row.created_at.tzinfo is not None


async def test_second_pending_question_for_same_session_is_rejected():
    """One suspension per session — enforced in the DB, not just in code."""
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _make_session(db, session_id)
        db.add(
            PendingQuestion(
                session_id=session_id, tool_call_id="call_1", payload=_payload()
            )
        )
        await db.commit()

        db.add(
            PendingQuestion(
                session_id=session_id, tool_call_id="call_2", payload=_payload()
            )
        )
        with pytest.raises(IntegrityError):
            await db.commit()


async def test_resolved_question_does_not_block_a_new_one():
    """The uniqueness guard is scoped to open questions only."""
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _make_session(db, session_id)
        first = PendingQuestion(
            session_id=session_id, tool_call_id="call_1", payload=_payload()
        )
        db.add(first)
        await db.commit()

        first.status = "answered"
        first.answers = [["pnpm"]]
        first.answered_at = datetime.now(timezone.utc)
        db.add(first)
        await db.commit()

        db.add(
            PendingQuestion(
                session_id=session_id, tool_call_id="call_2", payload=_payload()
            )
        )
        await db.commit()

        rows = (
            await db.exec(
                select(PendingQuestion).where(PendingQuestion.session_id == session_id)
            )
        ).all()

    assert {row.status for row in rows} == {"answered", "pending"}


async def test_deleting_the_session_removes_its_pending_question():
    from app.core import db as core_db

    session_id = uuid.uuid4()
    async with core_db.async_session_factory() as db:
        await _make_session(db, session_id)
        db.add(
            PendingQuestion(
                session_id=session_id, tool_call_id="call_1", payload=_payload()
            )
        )
        await db.commit()

        chat_session = await db.get(ChatSession, session_id)
        assert chat_session is not None
        await db.delete(chat_session)
        await db.commit()

        remaining = (
            await db.exec(
                select(PendingQuestion).where(PendingQuestion.session_id == session_id)
            )
        ).all()

    assert remaining == []
