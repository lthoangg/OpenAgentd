from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from loguru import logger
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import HumanMessage
from app.models.chat import SessionMessage

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
    row_extra.update({"queue_status": "queued", "queued_at": queued_at})
    return await save_message(
        db,
        session_id,
        HumanMessage(content=content),
        is_hidden=True,
        extra=row_extra,
    )


async def release_queued_user_messages(
    db: AsyncSession,
    session_id: UUID,
) -> list[SessionMessage]:
    rows = await db.exec(
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.role) == "user")
        .where(col(SessionMessage.exclude_from_context))
        .where(col(SessionMessage.extra)["queue_status"].as_string() == "queued")
        .order_by(col(SessionMessage.created_at).asc())
    )
    queued = list(rows.all())
    released_at = datetime.now(timezone.utc)
    for i, row in enumerate(queued):
        extra = dict(row.extra or {})
        extra.pop("queue_status", None)
        extra.pop("queued_at", None)
        row.extra = extra or None
        row.exclude_from_context = False
        row.created_at = released_at + timedelta(microseconds=i)
        db.add(row)
    await db.flush()
    return queued


async def pop_queued_user_messages(
    db: AsyncSession,
    session_id: UUID,
) -> list[SessionMessage]:
    rows = await db.exec(
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.role) == "user")
        .where(col(SessionMessage.exclude_from_context))
        .where(col(SessionMessage.extra)["queue_status"].as_string() == "queued")
        .order_by(col(SessionMessage.created_at).asc())
    )
    queued = list(rows.all())
    activated_at = datetime.now(timezone.utc)
    for i, row in enumerate(queued):
        extra = dict(row.extra or {})
        extra.pop("queue_status", None)
        extra.pop("queued_at", None)
        row.extra = extra or None
        row.exclude_from_context = False
        row.created_at = activated_at + timedelta(microseconds=i)
        db.add(row)
    await db.flush()
    return queued


async def cancel_queued_user_message(
    db: AsyncSession,
    session_id: UUID,
    message_id: UUID,
) -> bool:
    row = await db.get(SessionMessage, message_id)
    if (
        row is None
        or row.session_id != session_id
        or not row.extra
        or row.extra.get("queue_status") != "queued"
    ):
        return False

    # Delete any attachment files persisted at queue time.  Each meta dict
    # carries the absolute ``path`` written by ``_persist_attachment``.
    for att in row.extra.get("attachments") or []:
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
    for synthetic in synthetic_rows.all():
        await db.delete(synthetic)

    await db.delete(row)
    await db.flush()
    return True
