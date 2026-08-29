"""Question fetch/answer/dismiss endpoints for ``ask_user``.

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

import asyncio
from uuid import UUID

from fastapi import APIRouter, HTTPException
from loguru import logger

from app.agent.schemas.events import QuestionAnsweredEvent, QuestionDismissedEvent
from app.models.chat import PendingQuestion
from app.api.schemas.agent import (
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
from app.services.agent_manager import find_live_session_serving_session

router = APIRouter()


async def _open_question_or_conflict(
    db: DbSession, session_id: UUID, question_id: UUID
) -> PendingQuestion:
    """Return *session_id*'s open question, or raise the right 4xx.

    Shared by both resolution routes so the answer/dismiss distinction lives in
    one place: nothing pending is a ``409`` (a second device already resolved
    it, so the client should close its card), while a pending row under a
    *different* id is a ``404``. Neither is a hard error to surface.
    """
    row = await question_service.get_pending_question(db, session_id)
    if row is None or row.id != question_id:
        raise HTTPException(
            status_code=409 if row is None else 404,
            detail="Question is not open.",
        )
    return row


async def _resolve_or_conflict(
    db: DbSession,
    *,
    question_id: UUID,
    status: question_service.ResolvedStatus,
    answers: list[list[str]] | None = None,
) -> None:
    """Close the question and commit, or raise ``409`` if it lost the race.

    ``resolve_pending_question`` guards its ``UPDATE`` on ``status='pending'``,
    so a concurrent resolution returns ``None`` here rather than resuming the
    turn twice.
    """
    resolved = await question_service.resolve_pending_question(
        db, question_id=question_id, status=status, answers=answers
    )
    if resolved is None:
        raise HTTPException(status_code=409, detail="Question already resolved.")
    await db.commit()


async def get_agent_for_session(session_id: str):
    """Return the live agent session serving *session_id*, or ``None``.

    Indirection is kept module-level so tests can substitute a session without
    booting a real agent.
    """
    return find_live_session_serving_session(session_id)


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
    session_id: UUID, db: DbSession
) -> PendingQuestionEnvelope:
    """Return the open question for *session_id*, if the lead is waiting."""
    row = await question_service.get_pending_question(db, session_id)

    if row is None:
        return PendingQuestionEnvelope(question=None)

    return PendingQuestionEnvelope(question=PendingQuestionResponse.from_row(row))


@router.post("/{session_id}/question/{question_id}/answer")
async def answer_question(
    session_id: UUID,
    question_id: UUID,
    body: QuestionAnswerRequest,
    db: DbSession,
) -> QuestionResolveResponse:
    """Record the user's answer and resume the suspended turn."""
    sid = str(session_id)
    row = await _open_question_or_conflict(db, session_id, question_id)

    _validate_answers(row.payload.get("questions", []), body.answers)
    answers = [list(answer) for answer in body.answers]
    await _resolve_or_conflict(
        db, question_id=question_id, status="answered", answers=answers
    )

    # The suspension outlives the stream state that carried it: a restart drops
    # the table, and the sliding TTL expires a turn that emits nothing while it
    # waits. Both leave this event — and the whole resumed turn — with nowhere
    # to go, hence `create_if_missing`.
    await stream_store.push_event(
        sid,
        StreamEnvelope.from_event(
            QuestionAnsweredEvent(
                question_id=str(question_id),
                session_id=sid,
                answers=answers,
            )
        ),
        create_if_missing=True,
    )

    resumed = await _resume_agent(sid, db)
    if not resumed:
        # Nothing is going to run this turn, and the client is still showing it
        # as live. Close it so the session stops reading as busy; the answer is
        # saved and the user is told to send a message to continue.
        await _end_turn(sid)
    logger.info(
        "question_answered session_id={} question_id={} resumed={}",
        session_id,
        question_id,
        resumed,
    )
    return QuestionResolveResponse(status="ok", resumed=resumed)


@router.post("/{session_id}/question/{question_id}/dismiss")
async def dismiss_question(
    session_id: UUID, question_id: UUID, db: DbSession
) -> QuestionResolveResponse:
    """Close the question without answering; the turn stays ended."""
    sid = str(session_id)
    await _open_question_or_conflict(db, session_id, question_id)
    await _resolve_or_conflict(db, question_id=question_id, status="dismissed")

    # Same reason as the answer path: without turn state this broadcast and the
    # `done` that follows it are dropped, and other devices keep showing an open
    # card on a session that reads as running.
    await stream_store.push_event(
        sid,
        StreamEnvelope.from_event(
            QuestionDismissedEvent(
                question_id=str(question_id),
                session_id=sid,
                reason="dismissed",
            )
        ),
        create_if_missing=True,
    )

    agent = await get_agent_for_session(sid)
    # ``False`` means nothing live owns
    # the session (restarted daemon, or evicted and rebuilt) and the client is
    # still showing an open turn, so close it on the stream directly.
    handled = agent is not None and await agent.end_turn_after_question_dismissed(sid)
    if not handled:
        await _end_turn(sid)

    logger.info(
        "question_dismissed_by_user session_id={} question_id={}",
        session_id,
        question_id,
    )
    return QuestionResolveResponse(status="ok", resumed=False)


async def _end_turn(session_id: str) -> None:
    """Close a suspended turn that has no live agent session left to close it.

    Mirrors the tail of ``interrupt_agent``: the turn is over as far as every
    client and the session list are concerned, and nothing is running to say
    so. Best-effort — the question is already resolved and committed, so a
    failure here must not turn a successful dismissal into an error.
    """
    from app.services import event_broadcaster

    try:
        await stream_store.push_event(
            session_id, StreamEnvelope.from_parts(event="done", data={})
        )
        await stream_store.mark_done(session_id)
        await event_broadcaster.publish(
            "session_turn_completed",
            {"session_id": session_id, "status": "completed"},
        )
    except Exception as exc:
        logger.warning(
            "question_dismiss_stream_close_failed session_id={} error={}",
            session_id,
            exc,
        )


async def _start_agent_for_session(session_id: str, db: DbSession):
    """Boot the agent session that owns *session_id*, or ``None``.

    The suspension is durable, so answering has to work after a daemon restart
    — and the resumed turn reads its history from the database, so a cold session
    can run it. ``ask_user`` is agent-only, so this dispatches the agent session
    for the session's persisted workspace.
    """
    from app.models.chat import ChatSession
    from app.services import agent_manager

    try:
        row = await db.get(ChatSession, UUID(session_id))
    except Exception as exc:
        logger.warning("question_resume_session_lookup_failed error={}", exc)
        return None
    if row is None:
        logger.warning(
            "question_resume_session_not_resumable session_id={}", session_id
        )
        return None
    if row.workspace:
        try:
            return await agent_manager.get_or_start_agent_session(
                row.workspace, session_id
            )
        except Exception as exc:
            logger.warning(
                "question_resume_agent_start_failed session_id={} error={}",
                session_id,
                exc,
            )
            return None
    logger.warning(
        "question_resume_session_not_resumable session_id={} workspace=None", session_id
    )
    return None


async def _resume_agent(session_id: str, db: DbSession) -> bool:
    """Restart the suspended turn. ``False`` when it could not be started.

    The answer is already committed at this point, so a failure here must not
    look like a failed answer — the client surfaces a manual resume instead.
    """
    agent = await get_agent_for_session(session_id)
    if agent is None:
        # Nothing live owns this session (restarted daemon, or evicted after
        # the idle window). Start it: the turn resumes from DB history.
        agent = await _start_agent_for_session(session_id, db)
        if agent is None:
            logger.warning("question_resume_no_live_agent session_id={}", session_id)
            return False

    current_sid = getattr(agent, "session_id", None)
    if current_sid != session_id:
        is_busy_fn = getattr(agent, "is_busy", None)
        is_busy_val = (
            is_busy_fn()
            if callable(is_busy_fn)
            else (getattr(agent, "state", "") in ("working", "waiting_input"))
        )
        if is_busy_val:
            logger.warning(
                "question_resume_agent_busy_elsewhere session_id={} current_sid={}",
                session_id,
                current_sid,
            )
            return False
        await agent.attach_to_session(session_id)

    try:
        agent._question_suspended = None
        agent.state = "working"
        await agent._emit("agent_status", status="working")
        agent._cancel_event.clear()
        agent._has_active_turn = True
        agent._active_task = asyncio.create_task(agent._run_turn(question_resume=True))
    except Exception as exc:
        logger.warning("question_resume_failed session_id={} error={}", session_id, exc)
        agent._question_suspended = None
        return False
    return True
