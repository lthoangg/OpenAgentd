"""Derived message-window logic: active summary, LLM window, undo/redo.

The old model stored context membership as mutable flags
(``exclude_from_context``, ``extra.hidden_from_user``) that compaction and
revert flipped across many rows. This module derives everything from two
immutable-ish columns instead:

* ``seq``  — sparse per-session position; ordering key ``(seq, id)``.
* ``kind`` — chat | note | queued | summary | reverted (+ ``pinned`` bool).

Rules
-----
* **Active summary** — the ``kind='summary'`` row with the highest ``id``
  (uuid7 encodes creation time, so the newest summary always supersedes older
  ones no matter where they are anchored positionally). Under an undo
  boundary, only summaries positioned before the boundary are candidates —
  undoing past a summary therefore reactivates the previous one with no row
  mutation at all.
* **LLM window** — ``pinned`` rows, plus every ``chat``/``note``/``queued``
  row positioned at/after the active summary, plus the active summary itself.
  ``reverted`` rows and non-active summaries never appear.
* **Undo/redo** — the boundary is a message row; all comparisons are
  ``(seq, id)`` tuple tests. Nothing is restored or re-excluded dynamically:
  the window under a boundary falls out of the same two rules above.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from uuid import UUID

import sqlalchemy as sa
from sqlmodel import col, or_, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession, MessageKind, SessionMessage
from app.services import snapshot_service


@dataclass(slots=True)
class BoundaryShift:
    """Result of moving the session's revert boundary."""

    applied: bool
    target: SessionMessage | None = None
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)


# ── Position helpers ──────────────────────────────────────────────────────────


def _pos() -> sa.Tuple:
    """The ``(seq, id)`` ordering key as a SQL row value.

    Row-value comparisons (``(seq, id) < (?, ?)``) compile to a single range
    bound on ``ix_session_messages_session_seq_id``; the equivalent OR-chain
    (``seq < ? OR (seq = ? AND id < ?)``) only bounds the index on ``seq``
    and evaluates the tie-break as a residual filter.
    """
    return sa.tuple_(col(SessionMessage.seq), col(SessionMessage.id))


def _pos_value(seq: int, message_id: UUID) -> sa.Tuple:
    """A concrete ``(seq, id)`` row value with correctly typed binds."""
    return sa.tuple_(
        sa.literal(seq),
        # ``SessionMessage.id`` maps to ``sa.Uuid()`` — bind with the same
        # type so the literal serialises to the stored 32-char hex form.
        sa.literal(message_id, type_=sa.Uuid()),
    )


def before_pos(row: SessionMessage):
    """SQL predicate: strictly before *row* in ``(seq, id)`` order."""
    return _pos() < _pos_value(row.seq, row.id)


def at_or_after_pos(row: SessionMessage):
    """SQL predicate: at/after *row* in ``(seq, id)`` order."""
    return _pos() >= _pos_value(row.seq, row.id)


def after_pos(row: SessionMessage):
    """SQL predicate: strictly after *row* in ``(seq, id)`` order."""
    return _pos() > _pos_value(row.seq, row.id)


def before_cursor_predicate(seq: int, message_id: UUID):
    """SQL predicate: strictly before the ``(seq, id)`` cursor."""
    return _pos() < _pos_value(seq, message_id)


def after_cursor_predicate(seq: int, message_id: UUID):
    """SQL predicate: strictly after the ``(seq, id)`` cursor."""
    return _pos() > _pos_value(seq, message_id)


def order_by_pos(stmt, *, desc: bool = False):
    if desc:
        return stmt.order_by(
            col(SessionMessage.seq).desc(), col(SessionMessage.id).desc()
        )
    return stmt.order_by(col(SessionMessage.seq).asc(), col(SessionMessage.id).asc())


# ── Revert boundary ───────────────────────────────────────────────────────────


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


# ── Active summary and window statements ─────────────────────────────────────


async def get_active_summary(
    db: AsyncSession,
    session_id: UUID,
    boundary: SessionMessage | None = None,
) -> SessionMessage | None:
    """Newest-created summary row, optionally restricted to before *boundary*."""
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.kind) == MessageKind.SUMMARY)
        .order_by(col(SessionMessage.id).desc())
        .limit(1)
    )
    if boundary is not None:
        stmt = stmt.where(before_pos(boundary))
    return (await db.exec(stmt)).first()


def history_messages_stmt(session_id: UUID, boundary: SessionMessage | None = None):
    """Every row of the session in position order (audit view)."""
    stmt = select(SessionMessage).where(col(SessionMessage.session_id) == session_id)
    if boundary is not None:
        stmt = stmt.where(before_pos(boundary))
    return order_by_pos(stmt)


def llm_window_stmt(
    session_id: UUID,
    summary: SessionMessage | None,
    boundary: SessionMessage | None = None,
):
    """Rows of the derived LLM window in position order.

    Callers obtain *summary* via :func:`get_active_summary` (with the same
    *boundary*) so the two queries agree on which summary is active.
    """
    return _apply_llm_window(select(SessionMessage), session_id, summary, boundary)


def llm_tool_pair_stmt(
    session_id: UUID,
    summary: SessionMessage | None,
    boundary: SessionMessage | None = None,
):
    """Narrow LLM-window projection used by orphaned tool-call healing."""
    stmt = select(
        SessionMessage.seq,
        SessionMessage.tool_calls,
        SessionMessage.tool_call_id,
        SessionMessage.created_at,
    )
    return _apply_llm_window(stmt, session_id, summary, boundary)


def _apply_llm_window(
    stmt,
    session_id: UUID,
    summary: SessionMessage | None,
    boundary: SessionMessage | None,
):
    """Apply derived-window filters/order to a model or column projection."""
    stmt = stmt.where(col(SessionMessage.session_id) == session_id).where(
        col(SessionMessage.kind) != MessageKind.REVERTED
    )
    if summary is not None:
        stmt = stmt.where(
            or_(col(SessionMessage.pinned), at_or_after_pos(summary))
        ).where(
            or_(
                col(SessionMessage.kind) != MessageKind.SUMMARY,
                col(SessionMessage.id) == summary.id,
            )
        )
    else:
        # No active summary (none exist, or all sit beyond the boundary /
        # were reverted) — those rows are excluded by the predicates below.
        stmt = stmt.where(col(SessionMessage.kind) != MessageKind.SUMMARY)
    if boundary is not None:
        stmt = stmt.where(before_pos(boundary))
    return order_by_pos(stmt)


def user_visible_predicate():
    """SQL predicate for rows the user-facing transcript shows."""
    return col(SessionMessage.kind).notin_((MessageKind.NOTE, MessageKind.REVERTED))


# ── Undo / redo ───────────────────────────────────────────────────────────────


def _real_user_predicate():
    """Rows authored by the human user (not another agent).

    ``from_agent`` lives in ``extra`` — it is only consulted by these cold,
    LIMIT-1 undo/redo lookups, never on a hot path.
    """
    from_agent = col(SessionMessage.extra)["from_agent"].as_string()
    return sa.and_(
        col(SessionMessage.role) == "user",
        or_(from_agent.is_(None), from_agent == "user"),
    )


def is_undo_target(row: SessionMessage) -> bool:
    if row.kind not in (MessageKind.CHAT, MessageKind.SUMMARY):
        return False
    if row.extra and row.extra.get("from_agent") not in (None, "user"):
        return False
    return True


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

    # Undo targets: real user messages still in the LLM window (rows compacted
    # below the active summary are not targets — same as the old model), plus
    # any summary row (undoing "to" a summary reverts the compaction itself).
    active = await get_active_summary(db, session_id)
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(_real_user_predicate())
        .where(col(SessionMessage.kind).in_((MessageKind.CHAT, MessageKind.SUMMARY)))
    )
    if active is not None:
        stmt = stmt.where(
            or_(
                col(SessionMessage.kind) == MessageKind.SUMMARY,
                at_or_after_pos(active),
            )
        )
    if boundary is not None:
        stmt = stmt.where(before_pos(boundary))
    stmt = order_by_pos(stmt, desc=True).limit(1)
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
    next_user = (
        await db.exec(
            order_by_pos(
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == session_id)
                .where(_real_user_predicate())
                .where(col(SessionMessage.kind) == MessageKind.CHAT)
                .where(after_pos(boundary))
            ).limit(1)
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


async def redo_all_session_messages(
    db: AsyncSession, session_id: UUID
) -> BoundaryShift:
    session = await db.get(ChatSession, session_id)
    boundary = await revert_boundary(db, session_id)
    if session is None or boundary is None:
        return BoundaryShift(applied=False)
    anchor = redo_anchor(session)
    workspace = session_workspace_dir(str(session_id), session.workspace)
    added: list[str] = []
    modified: list[str] = []
    removed: list[str] = []
    if anchor:
        result = await snapshot_service.restore(str(session_id), workspace, anchor)
        added, modified, removed = result.added, result.modified, result.removed
    session.revert = None
    db.add(session)
    await db.flush()
    return BoundaryShift(
        applied=True,
        target=None,
        added=added,
        modified=modified,
        removed=removed,
    )


async def cleanup_reverted_tail(db: AsyncSession, session_id: UUID) -> int:
    """Materialise an undo: everything at/after the boundary becomes ``reverted``.

    Queued rows survive (they belong to the *next* turn). No restoration
    bookkeeping is needed for anything else: with the tail reverted, the
    previous summary — and the rows it kept — are back in the derived window
    automatically.
    """
    session = await db.get(ChatSession, session_id)
    boundary = await revert_boundary(db, session_id)
    if session is None or boundary is None:
        return 0
    result = await db.exec(
        sa.update(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(at_or_after_pos(boundary))
        .where(col(SessionMessage.kind) != MessageKind.QUEUED)
        .values(kind=MessageKind.REVERTED)
    )
    cleaned = int(getattr(result, "rowcount", 0) or 0)
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
    """Anchor a freshly saved summary so it covers all but the last *n* rows.

    The caller has already saved the summary row (it is the newest summary, so
    it is the active one by construction). Compaction coverage is positional:
    reposition the summary's ``seq`` directly before the ``keep_last_n``-th
    visible row from the end, and clear ``pinned`` on anything left below it —
    a manual compact keeps nothing scattered.

    Returns the number of rows that left the LLM window.
    """
    summary_msg = await db.get(SessionMessage, summary_message_id)
    if summary_msg is None or summary_msg.session_id != session_id:
        return 0

    previous = await get_active_summary(db, session_id)

    # Candidate rows: window kinds positioned before the summary — rows after
    # it belong to the ongoing conversation and are never covered. When the
    # caller compacts with a non-newest summary (legacy path), restrict to
    # the current active summary's window, mirroring what the derived view
    # considers live.
    def _candidates_stmt(stmt):
        stmt = (
            stmt.where(col(SessionMessage.session_id) == session_id)
            .where(
                col(SessionMessage.kind).in_(
                    (MessageKind.CHAT, MessageKind.NOTE, MessageKind.QUEUED)
                )
            )
            .where(before_pos(summary_msg))
        )
        if previous is not None and previous.id != summary_msg.id:
            stmt = stmt.where(
                or_(col(SessionMessage.pinned), at_or_after_pos(previous))
            )
        return stmt

    total_before = (
        await db.exec(
            _candidates_stmt(select(sa.func.count()).select_from(SessionMessage))
        )
    ).first() or 0

    # ``first_kept`` is the keep_last_n-th candidate from the end (or the
    # oldest candidate when fewer exist) — fetched directly instead of
    # loading the whole window into memory.
    first_kept: SessionMessage | None = None
    if keep_last_n > 0 and total_before > 0:
        first_kept = (
            await db.exec(
                order_by_pos(_candidates_stmt(select(SessionMessage)), desc=True)
                .limit(1)
                .offset(min(keep_last_n, total_before) - 1)
            )
        ).first()
    covered = total_before if keep_last_n <= 0 else max(0, total_before - keep_last_n)

    if first_kept is not None:
        prev_seq_result = await db.exec(
            select(sa.func.max(SessionMessage.seq))
            .where(col(SessionMessage.session_id) == session_id)
            .where(col(SessionMessage.seq) < first_kept.seq)
        )
        prev_seq = prev_seq_result.first() or 0
        gap = first_kept.seq - prev_seq
        summary_msg.seq = prev_seq + gap // 2 if gap >= 2 else prev_seq
        db.add(summary_msg)

    # A manual compact retains nothing below the summary.
    await db.exec(
        sa.update(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.pinned))
        .where(
            or_(
                col(SessionMessage.seq) < summary_msg.seq,
                sa.and_(
                    col(SessionMessage.seq) == summary_msg.seq,
                    col(SessionMessage.id) < summary_msg.id,
                ),
            )
        )
        .values(pinned=False)
    )

    await db.flush()
    return covered
