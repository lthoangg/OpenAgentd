"""Persist append-only Plan/Code session transitions."""

from __future__ import annotations

from uuid import UUID

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.interaction_mode import InteractionMode, transition_instruction
from app.agent.schemas.chat import HumanMessage
from app.models.chat import ChatSession, SessionMessage
from app.services.chat_service import bump_history_revision, save_message


async def _has_mode_prompt(
    db: AsyncSession, session_id: UUID, mode: InteractionMode
) -> bool:
    result = await db.exec(
        select(SessionMessage.extra).where(
            col(SessionMessage.session_id) == session_id,
            col(SessionMessage.kind) == "note",
        )
    )
    return any(
        extra
        and extra.get("interaction_mode") == mode
        and extra.get("interaction_mode_prompt") is True
        for extra in result.all()
    )


async def _append_mode_prompt(
    db: AsyncSession,
    session_id: UUID,
    mode: InteractionMode,
    *,
    transition: bool,
) -> None:
    extra: dict[str, object] = {
        "hidden_from_user": True,
        "interaction_mode": mode,
        "interaction_mode_prompt": True,
    }
    if transition:
        extra["interaction_mode_transition"] = True
    await save_message(
        db,
        session_id,
        HumanMessage(content=transition_instruction(mode), extra=extra),
        is_hidden=True,
        pinned=True,
    )
    await bump_history_revision(db, session_id, structural=True)


async def ensure_session_interaction_mode_prompt(
    db: AsyncSession, session_id: UUID, mode: InteractionMode
) -> bool:
    """Ensure an active non-default mode (plan) has an active instruction in context.

    Default Code sessions do not inject synthetic notes at session start.
    If a session has active interaction_mode == 'plan' but lacks any plan mode
    prompt, this appends it once.
    """
    if mode != "plan":
        return False
    if await _has_mode_prompt(db, session_id, mode):
        return False
    await _append_mode_prompt(db, session_id, mode, transition=False)
    return True


async def set_session_interaction_mode(
    db: AsyncSession, session_id: UUID, mode: InteractionMode
) -> tuple[ChatSession, bool]:
    """Set a top-level session's mode and append its effective instruction."""
    session = await db.get(ChatSession, session_id)
    if session is None or session.parent_session_id is not None:
        raise LookupError("Session not found.")
    if session.interaction_mode == mode:
        return session, False

    session.interaction_mode = mode
    db.add(session)
    await _append_mode_prompt(db, session_id, mode, transition=True)
    await db.flush()
    await db.refresh(session)
    return session, True
