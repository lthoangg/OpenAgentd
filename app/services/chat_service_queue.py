from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from loguru import logger
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import HumanMessage
from app.models.chat import SEQ_STEP, MessageKind, SessionMessage

_ATTACHMENT_FOR_KEY = "attachment_for_message_id"


async def save_queued_user_message(
    db: AsyncSession,
    session_id: UUID,
    content: str,
    *,
    extra: dict | None = None,
    save_message,
) -> SessionMessage:
    queued_at = datetime.now(timezone.utc).isoformat()
    row_extra = dict(extra or {})
    # queue_status/queued_at remain in ``extra`` as *display metadata only*
    # (the web client renders the queued badge off them). Queue state itself
    # is the typed ``kind='queued'`` column — never queried through JSON.
    row_extra.update({"queue_status": "queued", "queued_at": queued_at})
    return await save_message(
        db,
        session_id,
        HumanMessage(content=content),
        kind=MessageKind.QUEUED,
        extra=row_extra,
    )


def _queued_rows_stmt(session_id: UUID):
    return (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.role) == "user")
        .where(col(SessionMessage.kind) == MessageKind.QUEUED)
        .order_by(col(SessionMessage.seq).asc(), col(SessionMessage.id).asc())
    )


async def _promote_queued(
    db: AsyncSession, session_id: UUID, queued: list[SessionMessage]
) -> None:
    """Flip queued rows to ``chat`` and move them to the end of the session."""
    from app.services.chat_service import next_seq

    released_at = datetime.now(timezone.utc)
    base_seq = await next_seq(db, session_id)
    for i, row in enumerate(queued):
        extra = dict(row.extra or {})
        extra.pop("queue_status", None)
        extra.pop("queued_at", None)
        row.extra = extra or None
        row.kind = MessageKind.CHAT
        row.seq = base_seq + i * SEQ_STEP
        row.created_at = released_at + timedelta(microseconds=i)
        db.add(row)
    await db.flush()


async def release_queued_user_messages(
    db: AsyncSession,
    session_id: UUID,
) -> list[SessionMessage]:
    rows = await db.exec(_queued_rows_stmt(session_id))
    raw_all = rows.all()
    if inspect.isawaitable(raw_all):
        raw_all = await raw_all
    queued: list[SessionMessage] = (
        [r for r in raw_all if isinstance(r, SessionMessage)]
        if isinstance(raw_all, (list, tuple, set))
        else []
    )
    await _promote_queued(db, session_id, queued)
    return queued


async def pop_queued_user_messages(
    db: AsyncSession,
    session_id: UUID,
) -> list[SessionMessage]:
    rows = await db.exec(_queued_rows_stmt(session_id))
    raw_all = rows.all()
    if inspect.isawaitable(raw_all):
        raw_all = await raw_all
    queued: list[SessionMessage] = (
        [r for r in raw_all if isinstance(r, SessionMessage)]
        if isinstance(raw_all, (list, tuple, set))
        else []
    )
    await _promote_queued(db, session_id, queued)
    return queued


async def cancel_queued_user_message(
    db: AsyncSession,
    session_id: UUID,
    message_id: UUID,
) -> bool:
    row = await db.get(SessionMessage, message_id)
    if row is None or row.session_id != session_id or row.kind != MessageKind.QUEUED:
        return False

    # Delete any attachment files persisted at queue time.  Each meta dict
    # carries the absolute ``path`` written by ``_persist_attachment``.
    for att in (row.extra or {}).get("attachments") or []:
        raw_path = att.get("path")
        if not raw_path:
            continue
        try:
            Path(raw_path).unlink(missing_ok=True)
            logger.debug("queued_attachment_deleted path={}", raw_path)
        except OSError as exc:
            # Best-effort — log and continue; the DB row is still removed.
            logger.warning(
                "queued_attachment_delete_failed path={} error={}", raw_path, exc
            )

    # Delete mention context rows that were written at queue time.
    synthetic_rows = await db.exec(
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(
            col(SessionMessage.extra)[_ATTACHMENT_FOR_KEY].as_string()
            == str(message_id)
        )
    )
    raw_synthetics = synthetic_rows.all()
    if inspect.isawaitable(raw_synthetics):
        raw_synthetics = await raw_synthetics
    for synthetic in (
        raw_synthetics if isinstance(raw_synthetics, (list, tuple, set)) else []
    ):
        await db.delete(synthetic)

    await db.delete(row)
    await db.flush()
    return True
