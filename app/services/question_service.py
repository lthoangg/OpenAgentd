"""Durable storage for ``ask_user`` suspensions.

When the lead agent calls ``ask_user`` its turn is suspended rather
than blocked: the loop stops, the activation exits, and *the conversation is
left in a resumable state on disk*.  Two rows make that work, written together
in one transaction by :func:`create_pending_question`:

``pending_questions``
    The question itself, so a restarted daemon (or a second device) can
    re-render the card and know the session is awaiting input.

placeholder ``ToolMessage``
    A stand-in result for the suspended tool call.  Without it the assistant
    message would carry a ``tool_call`` with no matching ``tool`` reply, and
    :func:`app.services.chat_service.heal_orphaned_tool_calls` — which runs on
    session start and after shell turns — would "heal" it into a synthetic
    *interrupted* result, silently destroying the suspension.

Resolution rewrites the placeholder **in place** with the user's answer, so the
resumed turn sees exactly one complete, ordinary tool result where it left off.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Sequence
from uuid import UUID

import sqlalchemy as sa
from loguru import logger
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import ToolMessage
from app.models.chat import PendingQuestion, SessionMessage
from app.services.chat_service import save_message

TOOL_NAME = "ask_user"

#: Stand-in tool result held while the user has not replied.  Only reaches a
#: model if a resume path bypasses the pending-question guard, so it reads as
#: an instruction rather than as data.
PLACEHOLDER_RESULT = (
    "Waiting for the user to answer. Do not continue until their reply arrives."
)

ResolvedStatus = Literal["answered", "dismissed", "superseded", "expired"]

_RESOLUTION_TEXT: dict[str, str] = {
    # No instruction to the model: dismissing ends the lead's turn, so nothing
    # reads this until a *later* turn replays the history. At that point it is a
    # record of what happened, and telling a future turn to "stop and wait"
    # would be stale advice about an instruction the user has already given.
    "dismissed": "Question(s) being dismissed.",
    "superseded": (
        "Superseded — the user sent a new instruction instead of answering."
    ),
    "expired": "This question is no longer relevant and was discarded.",
}


def format_answers_for_model(
    questions: Sequence[dict[str, Any]],
    answers: Sequence[Sequence[str]] | None,
) -> str:
    """Render the user's reply as one sentence for the model.

    Answers are index-matched to *questions*; a question with no selections is
    reported as ``Unanswered`` rather than omitted, so the model can tell the
    difference between "they chose nothing" and "I never asked".
    """
    answers = answers or []
    parts: list[str] = []
    for index, question in enumerate(questions):
        selected = list(answers[index]) if index < len(answers) else []
        rendered = ", ".join(selected) if selected else "Unanswered"
        parts.append(f'"{question.get("question", "")}"="{rendered}"')
    return (
        "User has answered your questions: "
        + ", ".join(parts)
        + ". Continue with the user's answers in mind."
    )


async def create_pending_question(
    db: AsyncSession,
    *,
    session_id: UUID,
    tool_call_id: str,
    questions: Sequence[dict[str, Any]],
) -> PendingQuestion:
    """Record a suspension for *tool_call_id* and close its tool call.

    The caller owns the commit so the row and the placeholder land atomically
    with whatever else the suspending turn persisted.
    """
    row = PendingQuestion(
        session_id=session_id,
        tool_call_id=tool_call_id,
        payload={"questions": [dict(question) for question in questions]},
    )
    db.add(row)
    await save_message(
        db,
        session_id,
        ToolMessage(
            content=PLACEHOLDER_RESULT,
            tool_call_id=tool_call_id,
            name=TOOL_NAME,
        ),
        extra={"pending_question": True},
    )
    await db.flush()
    logger.info(
        "question_asked session_id={} question_id={} tool_call_id={} count={}",
        session_id,
        row.id,
        tool_call_id,
        len(questions),
    )
    return row


async def get_pending_question(
    db: AsyncSession, session_id: UUID
) -> PendingQuestion | None:
    """Return the open question for *session_id*, if the session is waiting."""
    return (
        await db.exec(
            select(PendingQuestion)
            .where(PendingQuestion.session_id == session_id)
            .where(PendingQuestion.status == "pending")
        )
    ).first()


async def sessions_awaiting_input(db: AsyncSession) -> set[UUID]:
    """Return every session id that currently has an open question."""
    rows = (
        await db.exec(
            select(PendingQuestion.session_id).where(
                PendingQuestion.status == "pending"
            )
        )
    ).all()
    return set(rows)


async def resolve_pending_question(
    db: AsyncSession,
    *,
    question_id: UUID,
    status: ResolvedStatus,
    answers: Sequence[Sequence[str]] | None = None,
) -> PendingQuestion | None:
    """Close an open question and rewrite its placeholder tool result.

    Returns ``None`` when the question is already resolved — two devices can
    race to answer, and the loser must not resume the turn a second time.  The
    guarded ``UPDATE`` is what makes that check atomic rather than advisory.
    """
    resolved_at = datetime.now(timezone.utc)
    result = await db.exec(  # type: ignore[call-overload]
        sa.update(PendingQuestion)
        .where(col(PendingQuestion.id) == question_id)
        .where(col(PendingQuestion.status) == "pending")
        .values(
            status=status,
            answers=[list(answer) for answer in answers] if answers else None,
            answered_at=resolved_at,
        )
    )
    if result.rowcount == 0:
        logger.info(
            "question_resolve_ignored question_id={} status={}", question_id, status
        )
        return None

    row = await db.get(PendingQuestion, question_id)
    if row is None:  # pragma: no cover — deleted between UPDATE and SELECT
        return None
    await db.refresh(row)

    if status == "answered":
        content = format_answers_for_model(
            row.payload.get("questions", []), row.answers
        )
    else:
        content = _RESOLUTION_TEXT[status]
    await _rewrite_placeholder(db, row.session_id, row.tool_call_id, content)

    logger.info(
        "question_resolved session_id={} question_id={} status={}",
        row.session_id,
        question_id,
        status,
    )
    return row


async def _rewrite_placeholder(
    db: AsyncSession, session_id: UUID, tool_call_id: str, content: str
) -> None:
    """Replace the held tool result with the real outcome, in place."""
    placeholder = (
        await db.exec(
            select(SessionMessage)
            .where(SessionMessage.session_id == session_id)
            .where(SessionMessage.tool_call_id == tool_call_id)
        )
    ).first()
    if placeholder is None:
        logger.warning(
            "question_placeholder_missing session_id={} tool_call_id={}",
            session_id,
            tool_call_id,
        )
        return
    placeholder.content = content
    extra = dict(placeholder.extra or {})
    extra.pop("pending_question", None)
    placeholder.extra = extra or None
    db.add(placeholder)
