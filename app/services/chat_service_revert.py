from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from sqlmodel import col, or_, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession, SessionMessage
from app.services import snapshot_service


@dataclass(slots=True)
class BoundaryShift:
    """Result of moving the session's revert boundary."""

    applied: bool
    target: SessionMessage | None = None
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)


def revert_message_id(session: ChatSession | None) -> UUID | None:
    value = session.revert if session else None
    if not isinstance(value, dict):
        return None
    raw = value.get("message_id")
    if not isinstance(raw, str):
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


async def revert_boundary(db: AsyncSession, session_id: UUID) -> SessionMessage | None:
    session = await db.get(ChatSession, session_id)
    message_id = revert_message_id(session)
    if message_id is None:
        return None
    row = await db.get(SessionMessage, message_id)
    if row is None or row.session_id != session_id:
        return None
    return row


async def boundary_created_at(db: AsyncSession, session_id: UUID) -> datetime | None:
    boundary = await revert_boundary(db, session_id)
    return boundary.created_at if boundary else None


def before_boundary(stmt, boundary: datetime | None):
    if boundary is None:
        return stmt
    return stmt.where(col(SessionMessage.created_at) < boundary)


def visible_messages_stmt(session_id: UUID, boundary: datetime | None = None):
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(~col(SessionMessage.exclude_from_context))
    )
    return before_boundary(stmt, boundary).order_by(
        col(SessionMessage.created_at).asc()
    )


def history_messages_stmt(session_id: UUID, boundary: datetime | None = None):
    stmt = select(SessionMessage).where(col(SessionMessage.session_id) == session_id)
    if boundary is not None:
        stmt = before_boundary(stmt, boundary)
    return stmt.order_by(col(SessionMessage.created_at).asc())


def llm_history_messages_stmt(session_id: UUID):
    """Select the rows needed for the ordinary, non-reverted LLM window."""
    queued = col(SessionMessage.extra)["queue_status"].as_string() == "queued"
    return (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(
            or_(
                ~col(SessionMessage.exclude_from_context),
                col(SessionMessage.is_summary),
                queued,
            )
        )
        .order_by(col(SessionMessage.created_at).asc())
    )


def is_history_visible(row: SessionMessage) -> bool:
    if not row.exclude_from_context:
        return True
    return bool(row.extra and row.extra.get("queue_status") == "queued")


async def get_dynamically_visible_messages(
    db: AsyncSession,
    session_id: UUID,
    boundary: datetime | None,
    rows: list[SessionMessage],
) -> list[SessionMessage]:
    """Filter rows dynamically taking the latest active summary into account.

    If the latest summary is at or after the boundary it is excluded from rows
    and therefore not active.  The latest active summary is the last summary
    remaining in rows.  When an undo is in effect (boundary is not None) any
    message that was excluded *only* because of a summary that has itself been
    undone is dynamically restored.

    Over-restore guard: we only un-exclude a message when the *nearest* undone
    summary that would have excluded it is the summary being undone — not just
    any summary beyond the boundary.  Concretely, a message is restorable when
    the boundary falls inside a range (prev_summary.created_at, undone_summary
    .created_at] — meaning no still-active summary sits between the message and
    the boundary.
    """
    # Collect the created_at of the immediately-undone summary (the one at or
    # just after the boundary).  We only want the *earliest* one >= boundary so
    # we avoid restoring messages that belong to a later, still-active summary.
    undone_summary_time: datetime | None = None
    if boundary is not None:
        result = (
            await db.exec(
                select(SessionMessage.created_at)
                .where(col(SessionMessage.session_id) == session_id)
                .where(col(SessionMessage.is_summary))
                .where(col(SessionMessage.created_at) >= boundary)
                .order_by(col(SessionMessage.created_at).asc())
                .limit(1)
            )
        ).first()
        undone_summary_time = result  # None when no summary was undone

    # Find the latest active summary still visible in rows (i.e., not undone).
    active_summary = None
    for row in reversed(rows):
        if row.is_summary and not is_hidden_from_user(row):
            active_summary = row
            break

    # Compute the lower bound below which a restored message must not fall.
    # If there is still an active summary, messages at or before it that are
    # excluded remain excluded (they belong to that summary's compaction window).
    restore_floor: datetime | None = (
        active_summary.created_at if active_summary is not None else None
    )

    visible: list[SessionMessage] = []
    for row in rows:
        # Queued messages are never excluded from visibility.
        if row.extra and row.extra.get("queue_status") == "queued":
            is_excluded = False
        else:
            is_excluded = row.exclude_from_context
            if is_excluded and undone_summary_time is not None:
                # Restore only if this message was compacted by the undone
                # summary (its created_at < undone_summary_time) and it is not
                # covered by a still-active summary below the boundary.
                before_undone = row.created_at < undone_summary_time
                above_floor = restore_floor is None or row.created_at > restore_floor
                if before_undone and above_floor:
                    is_excluded = False

        if row.is_summary:
            if active_summary is not None and row.id == active_summary.id:
                visible.append(row)
            # All other summary rows (older or hidden) are excluded.
        elif not is_excluded:
            visible.append(row)

    return visible


def is_hidden_from_user(row: SessionMessage) -> bool:
    return bool(row.extra and row.extra.get("hidden_from_user"))


def is_undo_target(row: SessionMessage) -> bool:
    if is_hidden_from_user(row):
        return False
    if row.extra and row.extra.get("from_agent") not in (None, "user"):
        return False
    return row.is_summary or not row.exclude_from_context


def message_snapshot(row: SessionMessage | None) -> str | None:
    if row is None or not row.extra:
        return None
    value = row.extra.get("snapshot")
    return value if isinstance(value, str) and value else None


def redo_anchor(session: ChatSession | None) -> str | None:
    value = session.revert if session else None
    if not isinstance(value, dict):
        return None
    raw = value.get("snapshot")
    return raw if isinstance(raw, str) and raw else None


async def undo_session_messages(db: AsyncSession, session_id: UUID) -> BoundaryShift:
    session = await db.get(ChatSession, session_id)
    if session is None:
        return BoundaryShift(applied=False)
    boundary = await revert_boundary(db, session_id)
    from_agent = col(SessionMessage.extra)["from_agent"].as_string()
    hidden_from_user = col(SessionMessage.extra)["hidden_from_user"].as_boolean()
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.role) == "user")
        .where(or_(from_agent.is_(None), from_agent == "user"))
        .where(or_(hidden_from_user.is_(None), hidden_from_user.is_(False)))
        .where(
            or_(
                col(SessionMessage.is_summary),
                ~col(SessionMessage.exclude_from_context),
            )
        )
        .order_by(col(SessionMessage.created_at).desc())
        .limit(1)
    )
    if boundary is not None:
        stmt = stmt.where(col(SessionMessage.created_at) < boundary.created_at)
    rows = (await db.exec(stmt)).all()
    target = next((row for row in rows if is_undo_target(row)), None)
    if target is None:
        return BoundaryShift(applied=False)

    workspace = session_workspace_dir(str(session_id), session.workspace)
    anchor = redo_anchor(session)
    just_tracked = False
    if anchor is None:
        anchor = await snapshot_service.track(str(session_id), workspace)
        just_tracked = anchor is not None

    added: list[str] = []
    modified: list[str] = []
    removed: list[str] = []
    target_snapshot = message_snapshot(target)
    if target_snapshot:
        result = await snapshot_service.restore(
            str(session_id),
            workspace,
            target_snapshot,
            skip_stage=just_tracked,
        )
        added, modified, removed = result.added, result.modified, result.removed

    revert_state: dict = {"message_id": str(target.id)}
    if anchor:
        revert_state["snapshot"] = anchor
    session.revert = revert_state
    db.add(session)
    await db.flush()
    return BoundaryShift(
        applied=True,
        target=target,
        added=added,
        modified=modified,
        removed=removed,
    )


async def redo_session_messages(db: AsyncSession, session_id: UUID) -> BoundaryShift:
    session = await db.get(ChatSession, session_id)
    boundary = await revert_boundary(db, session_id)
    if session is None or boundary is None:
        return BoundaryShift(applied=False)
    anchor = redo_anchor(session)
    from_agent = col(SessionMessage.extra)["from_agent"].as_string()
    next_user = (
        await db.exec(
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == session_id)
            .where(col(SessionMessage.role) == "user")
            .where(col(SessionMessage.created_at) > boundary.created_at)
            .where(or_(from_agent.is_(None), from_agent == "user"))
            .order_by(col(SessionMessage.created_at).asc())
            .limit(1)
        )
    ).first()

    workspace = session_workspace_dir(str(session_id), session.workspace)
    added: list[str] = []
    modified: list[str] = []
    removed: list[str] = []
    if next_user is None:
        if anchor:
            result = await snapshot_service.restore(str(session_id), workspace, anchor)
            added, modified, removed = result.added, result.modified, result.removed
        session.revert = None
    else:
        next_snapshot = message_snapshot(next_user)
        if next_snapshot:
            result = await snapshot_service.restore(
                str(session_id), workspace, next_snapshot
            )
            added, modified, removed = result.added, result.modified, result.removed
        revert_state: dict = {"message_id": str(next_user.id)}
        if anchor:
            revert_state["snapshot"] = anchor
        session.revert = revert_state
    db.add(session)
    await db.flush()
    return BoundaryShift(
        applied=True,
        target=next_user,
        added=added,
        modified=modified,
        removed=removed,
    )


async def cleanup_reverted_tail(db: AsyncSession, session_id: UUID) -> int:
    session = await db.get(ChatSession, session_id)
    boundary = await revert_boundary(db, session_id)
    if session is None or boundary is None:
        return 0
    rows = (
        await db.exec(
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == session_id)
            .where(col(SessionMessage.created_at) >= boundary.created_at)
        )
    ).all()
    cleaned = 0
    for row in rows:
        if row.extra and row.extra.get("queue_status") == "queued":
            continue
        extra = dict(row.extra or {})
        extra["hidden_from_user"] = True
        row.extra = extra
        row.exclude_from_context = True
        db.add(row)
        cleaned += 1
    if boundary.is_summary:
        previous_summaries = (
            await db.exec(
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == session_id)
                .where(col(SessionMessage.is_summary))
                .where(col(SessionMessage.created_at) < boundary.created_at)
                .order_by(col(SessionMessage.created_at).desc())
            )
        ).all()
        previous_summary = next(
            (row for row in previous_summaries if not is_hidden_from_user(row)), None
        )
        if previous_summary is not None:
            previous_summary.exclude_from_context = False
            db.add(previous_summary)
        restored = (
            await db.exec(
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == session_id)
                .where(col(SessionMessage.created_at) < boundary.created_at)
                .where(~col(SessionMessage.is_summary))
                .where(col(SessionMessage.exclude_from_context))
            )
        ).all()
        for row in restored:
            if is_hidden_from_user(row):
                continue
            if (
                previous_summary is not None
                and row.created_at <= previous_summary.created_at
            ):
                continue
            row.exclude_from_context = False
            db.add(row)
    session.revert = None
    db.add(session)
    await db.flush()
    return cleaned


async def exclude_messages_before_summary(
    db: AsyncSession,
    session_id: UUID,
    summary_message_id: UUID,
    keep_last_n: int = 0,
) -> int:
    summary_msg = await db.get(SessionMessage, summary_message_id)
    if summary_msg is None:
        return 0

    old_summaries_stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.is_summary))
        .where(col(SessionMessage.id) != summary_message_id)
        .where(~col(SessionMessage.exclude_from_context))
    )
    old_summaries = list((await db.exec(old_summaries_stmt)).all())
    for row in old_summaries:
        row.exclude_from_context = True
        db.add(row)

    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(
            or_(
                col(SessionMessage.created_at) < summary_msg.created_at,
                (
                    col(SessionMessage.created_at) == summary_msg.created_at
                    and col(SessionMessage.id) != summary_msg.id
                    and ~col(SessionMessage.is_summary)
                ),
            )
        )
        .where(~col(SessionMessage.exclude_from_context))
        .where(~col(SessionMessage.is_summary))
        .order_by(col(SessionMessage.created_at).asc())
    )
    rows = list((await db.exec(stmt)).all())

    if keep_last_n > 0 and len(rows) > keep_last_n:
        rows_to_exclude = rows[:-keep_last_n]
    else:
        rows_to_exclude = rows if keep_last_n == 0 else []

    for row in rows_to_exclude:
        row.exclude_from_context = True
        db.add(row)

    await db.flush()
    return len(old_summaries) + len(rows_to_exclude)
