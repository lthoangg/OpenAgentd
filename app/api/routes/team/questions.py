"""Question fetch/answer/dismiss endpoints for ``ask_user_question``.

A suspended turn lives in the DB, not in a coroutine, so these routes work
after a reload, from a second device, and across a daemon restart:

``GET /{sid}/question``
    Cold-load the open question. Live clients normally get it from the
    replayed ``question_asked`` SSE event instead.

``POST /{sid}/question/{qid}/answer``
    Validate the reply, rewrite the placeholder tool result with it, then
    restart the lead's turn from exactly where it stopped.

``POST /{sid}/question/{qid}/dismiss``
    Close the question and leave the turn ended — no further model call.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException
from loguru import logger

from app.agent.schemas.events import QuestionAnsweredEvent, QuestionDismissedEvent
from app.api.schemas.team import (
    MAX_ANSWER_CHARS,
    PendingQuestionEnvelope,
    PendingQuestionResponse,
    QuestionAnswerRequest,
    QuestionResolveResponse,
)
from app.api.deps import DbSession
from app.services import memory_stream_store as stream_store
from app.services import question_service
from app.services.stream_envelope import StreamEnvelope
from app.services.team_manager import find_live_team_for_lead_session

router = APIRouter()


def _parse_session_id(session_id: str) -> UUID:
    try:
        return UUID(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid session id") from exc


def _parse_question_id(question_id: str) -> UUID:
    try:
        return UUID(question_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid question id") from exc


async def get_team_for_session(session_id: str):
    """Return the live team owning *session_id*, or ``None``.

    Indirection kept module-level so tests can substitute a lead without
    booting a real team.
    """
    return find_live_team_for_lead_session(session_id)


def _validate_answers(questions: list[dict], answers: list[list[str]]) -> None:
    """Reject anything the asked questions did not offer.

    The payload is the one piece of untrusted input on this path: it becomes a
    tool result the model reads as the user's intent, so a client cannot be
    allowed to invent options, over-select, or paste unbounded text.
    """
    if len(answers) > len(questions):
        raise HTTPException(
            status_code=422,
            detail=f"Expected at most {len(questions)} answer groups, got {len(answers)}.",
        )

    for index, selected in enumerate(answers):
        question = questions[index]
        labels = {
            str(option.get("label", "")) for option in question.get("options") or []
        }
        allows_custom = question.get("custom", True) is True

        if len(selected) > 1 and question.get("multiple") is not True:
            raise HTTPException(
                status_code=422,
                detail=f"Question {index} accepts a single answer.",
            )
        # Bound the *count*, not just each value's length. A multi-select
        # question that also allows free text accepts any string, so a label
        # check alone bounds nothing: without this, a client could post thousands
        # of MAX_ANSWER_CHARS-sized entries straight into the model's context.
        # Everything offered, plus one answer of the user's own, is the most a
        # legitimate reply can contain.
        max_selected = len(labels) + (1 if allows_custom else 0)
        if len(selected) > max_selected:
            raise HTTPException(
                status_code=422,
                detail=f"Question {index} accepts at most {max_selected} answers.",
            )
        for value in selected:
            if len(value) > MAX_ANSWER_CHARS:
                raise HTTPException(
                    status_code=422,
                    detail=f"Answer to question {index} exceeds {MAX_ANSWER_CHARS} characters.",
                )
            if value not in labels and not allows_custom:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Question {index} does not accept a custom answer; "
                        f"choose one of its options."
                    ),
                )


@router.get("/{session_id}/question")
async def get_pending_question(
    session_id: str, db: DbSession
) -> PendingQuestionEnvelope:
    """Return the open question for *session_id*, if the lead is waiting."""
    session_uuid = _parse_session_id(session_id)
    row = await question_service.get_pending_question(db, session_uuid)

    if row is None:
        return PendingQuestionEnvelope(question=None)

    return PendingQuestionEnvelope(question=PendingQuestionResponse.from_row(row))


@router.post("/{session_id}/question/{question_id}/answer")
async def answer_question(
    session_id: str,
    question_id: str,
    body: QuestionAnswerRequest,
    db: DbSession,
) -> QuestionResolveResponse:
    """Record the user's answer and resume the suspended turn."""
    session_uuid = _parse_session_id(session_id)
    question_uuid = _parse_question_id(question_id)

    row = await question_service.get_pending_question(db, session_uuid)
    if row is None or row.id != question_uuid:
        # Either nothing is pending, or this id is stale — a second device
        # already resolved it. Distinguish so the client can close its card
        # instead of showing a hard error.
        raise HTTPException(
            status_code=409 if row is None else 404,
            detail="Question is not open.",
        )

    _validate_answers(row.payload.get("questions", []), body.answers)

    resolved = await question_service.answer_question(
        db, question_id=question_uuid, answers=body.answers
    )
    if resolved is None:
        raise HTTPException(status_code=409, detail="Question already resolved.")
    await db.commit()

    await stream_store.push_event(
        session_id,
        StreamEnvelope.from_event(
            QuestionAnsweredEvent(
                question_id=question_id,
                session_id=session_id,
                answers=[list(answer) for answer in body.answers],
            )
        ),
    )

    resumed = await _resume_lead(session_id)
    logger.info(
        "question_answered session_id={} question_id={} resumed={}",
        session_id,
        question_id,
        resumed,
    )
    return QuestionResolveResponse(status="ok", resumed=resumed)


@router.post("/{session_id}/question/{question_id}/dismiss")
async def dismiss_question(
    session_id: str, question_id: str, db: DbSession
) -> QuestionResolveResponse:
    """Close the question without answering; the turn stays ended."""
    session_uuid = _parse_session_id(session_id)
    question_uuid = _parse_question_id(question_id)

    row = await question_service.get_pending_question(db, session_uuid)
    if row is None or row.id != question_uuid:
        raise HTTPException(
            status_code=409 if row is None else 404,
            detail="Question is not open.",
        )
    resolved = await question_service.resolve_pending_question(
        db, question_id=question_uuid, status="dismissed"
    )
    if resolved is None:
        raise HTTPException(status_code=409, detail="Question already resolved.")
    await db.commit()

    team = await get_team_for_session(session_id)
    if team is not None:
        # Free the lead without starting a turn — dismissing means "stop", so
        # there is deliberately no further model call.
        if team.lead.state == "waiting_input":
            team.lead.state = "idle"
        team.lead._question_suspended = None

    await stream_store.push_event(
        session_id,
        StreamEnvelope.from_event(
            QuestionDismissedEvent(
                question_id=question_id,
                session_id=session_id,
                reason="dismissed",
            )
        ),
    )
    logger.info(
        "question_dismissed_by_user session_id={} question_id={}",
        session_id,
        question_id,
    )
    return QuestionResolveResponse(status="ok", resumed=False)


async def _resume_lead(session_id: str) -> bool:
    """Restart the suspended turn. ``False`` when it could not be started.

    The answer is already committed at this point, so a failure here must not
    look like a failed answer — the client surfaces a manual resume instead.
    """
    team = await get_team_for_session(session_id)
    if team is None:
        logger.warning("question_resume_no_live_team session_id={}", session_id)
        return False
    try:
        team.lead.activate_for_question_answer()
    except Exception as exc:
        logger.warning("question_resume_failed session_id={} error={}", session_id, exc)
        return False
    return True
