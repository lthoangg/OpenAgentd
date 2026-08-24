import asyncio
import shutil
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from uuid import UUID

import sqlalchemy as sa
from loguru import logger
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    ToolMessage,
)
from app.agent.artifacts import session_artifact_dir
from app.core.paths import session_workspace_dir, uploads_dir, workspace_dir
from app.models.chat import (
    SEQ_STEP,
    ChatSession,
    MessageKind,
    SessionMessage,
    TZDateTime,
)
from app.services import chat_service_queue as _chat_service_queue
from app.services import chat_service_revert as _chat_service_revert
from app.services.chat_service_messages import (
    apply_llm_content_overrides as _apply_llm_content_overrides,
    deserialize_messages as _deserialize_messages,
)
from app.services.chat_service_revert import (
    BoundaryShift,
    after_cursor_predicate as _after_cursor_predicate,
    exclude_messages_before_summary as _exclude_messages_before_summary,
    get_active_summary as _get_active_summary,
    llm_window_stmt as _llm_window_stmt,
    llm_tool_pair_stmt as _llm_tool_pair_stmt,
    revert_boundary as _revert_boundary,
    user_visible_predicate as _user_visible_predicate,
)


async def create_chat_session(
    db: AsyncSession,
    title: str | None = None,
    parent_session_id: UUID | None = None,
    agent_name: str | None = None,
    workspace: str | None = None,
) -> ChatSession:
    """Creates a new chat session.

    Args:
        db: Async database session.
        title: Optional human-readable title.
        parent_session_id: If set, links this session as a child of another
            (e.g. a subagent session within a supervisor run).
        agent_name: Name of the agent that owns this session.
    """
    logger.debug("creating_chat_session title={} agent_name={}", title, agent_name)
    try:
        session = ChatSession(
            title=title,
            parent_session_id=parent_session_id,
            agent_name=agent_name,
            workspace=workspace or "",
        )
        db.add(session)
        await db.flush()
        await db.refresh(session)
        logger.info("chat_session_created session_id={} title={}", session.id, title)
        return session
    except Exception as e:
        logger.error("chat_session_creation_failed error={} title={}", e, title)
        raise


async def bump_history_revision(
    db: AsyncSession, session_id: UUID, *, structural: bool = False
) -> None:
    """Mark a session's effective LLM history as changed in this transaction."""
    if not isinstance(db, AsyncSession):
        return
    values: dict[str, object] = {
        "history_revision": col(ChatSession.history_revision) + 1
    }
    if structural:
        values["history_structure_revision"] = (
            col(ChatSession.history_structure_revision) + 1
        )
    statement = (
        sa.update(ChatSession).where(col(ChatSession.id) == session_id).values(**values)
    )
    await db.exec(statement)


async def get_history_revision(db: AsyncSession, session_id: UUID) -> tuple[int, int]:
    """Read history revisions used by incremental turn loading."""
    result = await db.exec(
        select(
            ChatSession.history_revision,
            ChatSession.history_structure_revision,
        ).where(col(ChatSession.id) == session_id)
    )
    row = result.first()
    return (int(row[0]), int(row[1])) if row else (0, 0)


async def get_history_cursor(
    db: AsyncSession, session_id: UUID
) -> tuple[int, UUID] | None:
    """Return the newest persisted row's ordering cursor."""
    result = await db.exec(
        select(SessionMessage.seq, SessionMessage.id)
        .where(col(SessionMessage.session_id) == session_id)
        .order_by(col(SessionMessage.seq).desc(), col(SessionMessage.id).desc())
        .limit(1)
    )
    row = result.first()
    return (row[0], row[1]) if row else None


async def next_seq(db: AsyncSession, session_id: UUID) -> int:
    """Allocate the next append position for *session_id*."""
    result = await db.exec(
        select(sa.func.max(SessionMessage.seq)).where(
            col(SessionMessage.session_id) == session_id
        )
    )
    highest = result.first() or 0
    return highest + SEQ_STEP


def seq_between(prev_seq: int, next_seq_value: int) -> int:
    """Midpoint position strictly between two rows.

    When the gap is exhausted, returns *prev_seq* — the new row ties with the
    previous one and uuid7 ``id`` tie-breaking (creation order) places it
    after that row but before the next.
    """
    gap = next_seq_value - prev_seq
    return prev_seq + gap // 2 if gap >= 2 else prev_seq


async def seq_before_row(
    db: AsyncSession, session_id: UUID, anchor: SessionMessage
) -> int:
    """Position for a row anchored directly *before* an existing row."""
    result = await db.exec(
        select(sa.func.max(SessionMessage.seq))
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.seq) < anchor.seq)
    )
    prev = result.first() or 0
    return seq_between(prev, anchor.seq)


async def _llm_window_rows(db: AsyncSession, session_id: UUID) -> list[SessionMessage]:
    """Fetch the derived LLM window (boundary-aware)."""
    boundary = await _revert_boundary(db, session_id)
    summary = await _get_active_summary(db, session_id, boundary)
    stmt = _llm_window_stmt(session_id, summary, boundary)
    return list((await db.exec(stmt)).all())


async def get_messages_for_llm_after(
    db: AsyncSession,
    session_id: UUID,
    cursor: tuple[int, UUID],
) -> list[ChatMessage]:
    """Deserialize only visible LLM rows after an append-only cursor."""
    boundary = await _revert_boundary(db, session_id)
    summary = await _get_active_summary(db, session_id, boundary)
    stmt = _llm_window_stmt(session_id, summary, boundary)
    seq, message_id = cursor
    stmt = stmt.where(_after_cursor_predicate(seq, message_id))
    rows = (await db.exec(stmt)).all()
    messages = await asyncio.to_thread(
        _deserialize_messages, rows, sanitize_tool_pairs=True
    )
    return _apply_llm_content_overrides(messages)


_INTERRUPTED_TOOL_RESULT = (
    "Tool execution was interrupted before a result could be recorded."
)


class _ToolPairRow(NamedTuple):
    seq: int
    tool_calls: list[dict] | None
    tool_call_id: str | None
    created_at: datetime


async def heal_orphaned_tool_calls(db: AsyncSession, session_id: UUID) -> int:
    """Insert synthetic ``ToolMessage`` rows for unmatched visible tool_calls.

    Background — the agent loop persists the assistant turn (with
    ``tool_calls``) *before* tools run, so a server restart mid-tool
    leaves an assistant message whose ``tool_calls`` have no following
    ``tool`` rows.  The next turn would then 400 against any provider
    that enforces the assistant→tool pairing (OpenAI, Anthropic, …)::

        No tool output found for function call fc_…

    Heal strategy: inspect every *visible* assistant message in the same
    LLM-facing window as :func:`get_messages_for_llm`.  If an assistant row
    has ``tool_calls``, look up which IDs are already paired with visible
    ``tool`` replies and INSERT a stub for any that are missing.  The stub
    sits in the same DB transaction as the caller, so the heal lands
    atomically with the next user message.

    Earlier versions only inspected the latest assistant row.  That missed
    compacted sessions where ``[latest_summary] + keep_last_n`` exposed an
    older orphan before the current tail, causing OpenAI to reject the full
    request even though the last assistant message looked healthy.

    Returns the number of synthetic rows inserted (``0`` in the healthy
    case).  Caller is responsible for the commit.
    """
    # Use the exact same derived window predicates as the LLM load, but do not
    # materialise every message body/reasoning blob just to inspect tool ids.
    # The normal path loads the full window moments later; this narrow
    # projection removes that duplicate multi-megabyte read.
    boundary = await _revert_boundary(db, session_id)
    summary = await _get_active_summary(db, session_id, boundary)
    stmt = _llm_tool_pair_stmt(session_id, summary, boundary).where(
        sa.or_(
            sa.and_(
                col(SessionMessage.role) == "assistant",
                col(SessionMessage.tool_calls).is_not(None),
            ),
            sa.and_(
                col(SessionMessage.role) == "tool",
                col(SessionMessage.tool_call_id).is_not(None),
            ),
        )
    )
    db_messages = [_ToolPairRow(*row) for row in (await db.exec(stmt)).all()]

    assistant_rows = [row for row in db_messages if row.tool_calls]
    if not assistant_rows:
        return 0

    expected_ids: list[str] = []
    for row in assistant_rows:
        expected_ids.extend(tc["id"] for tc in row.tool_calls or [] if tc.get("id"))
    if not expected_ids:
        return 0

    matched_ids = {
        row.tool_call_id for row in db_messages if row.tool_call_id in expected_ids
    }
    missing_by_row: list[tuple[_ToolPairRow, list[dict]]] = []
    for row in assistant_rows:
        missing = [tc for tc in row.tool_calls or [] if tc.get("id") not in matched_ids]
        if missing:
            missing_by_row.append((row, missing))

    if not missing_by_row:
        return 0

    # Anchor synthetic positions directly after the orphaned assistant row so
    # the LLM input order is unambiguous even if the user sends the next
    # message while the heal runs:
    # ``assistant{tool_calls} → tool (synth) → tool (synth) → … → user``.
    # Successive midpoints keep multiple stubs strictly monotonic relative to
    # one another; when a gap is exhausted the stubs tie with the assistant
    # row and uuid7 id ordering keeps them directly behind it.
    healed_ids: list[str] = []
    for row, missing in missing_by_row:
        next_row_seq = (
            await db.exec(
                select(sa.func.min(SessionMessage.seq))
                .where(col(SessionMessage.session_id) == session_id)
                .where(col(SessionMessage.seq) > row.seq)
            )
        ).first()
        upper = next_row_seq if next_row_seq is not None else row.seq + 2 * SEQ_STEP
        anchor_seq = row.seq
        for i, tc in enumerate(missing):
            stub = ToolMessage(
                content=_INTERRUPTED_TOOL_RESULT,
                tool_call_id=tc["id"],
                name=tc.get("function", {}).get("name", "unknown"),
            )
            anchor_seq = max(seq_between(anchor_seq, upper), anchor_seq)
            await save_message(
                db,
                session_id,
                stub,
                seq=anchor_seq,
                created_at=row.created_at + timedelta(microseconds=i + 1),
            )
            healed_ids.append(tc["id"])

    logger.warning(
        "tool_call_orphans_healed session_id={} count={} ids=[{}]",
        session_id,
        len(healed_ids),
        ", ".join(healed_ids),
    )
    return len(healed_ids)


async def save_message(
    db: AsyncSession,
    session_id: UUID,
    message: ChatMessage,
    *,
    is_summary: bool = False,
    is_hidden: bool = False,
    extra: dict | None = None,
    created_at: datetime | None = None,
    kind: str | None = None,
    pinned: bool | None = None,
    seq: int | None = None,
    flush: bool = True,
) -> SessionMessage:
    """Saves a ChatMessage to the database.

    Args:
        db: Async database session.
        session_id: The session to attach the message to.
        message: The chat message to persist.
        is_summary: Convenience for ``kind='summary'``.
        is_hidden: Convenience for ``kind='note'`` (kept for callers that
            predate the kind column).
        kind: Explicit row kind — overrides the conveniences. When omitted it
            is derived: summary → ``summary``; ``extra.hidden_from_user`` →
            ``note``; otherwise ``chat``.
        pinned: Position-independent LLM membership. Defaults to ``True`` for
            notes saved with ``extra.hidden_from_summary`` (mention blocks,
            roster changes — permanent internal context), else ``False``.
        seq: Explicit position (heal stubs, anchored summaries). Defaults to
            the next append position.
        created_at: Optional explicit timestamp (display metadata only —
            ordering is by ``seq``).
        flush: Flush the session after adding the row (default). Batch
            writers (the checkpointer sync loop) pass ``False`` and flush
            once for the whole turn — ``id`` is client-generated uuid7, so
            nothing needs the flush to learn its primary key.
    """
    tool_calls = None
    tool_call_id = None
    name = None
    reasoning_content = None

    if isinstance(message, AssistantMessage):
        reasoning_content = message.reasoning_content
        if message.tool_calls:
            tool_calls = [tc.model_dump() for tc in message.tool_calls]
    elif isinstance(message, ToolMessage):
        tool_call_id = message.tool_call_id
        name = message.name
        if message.parts:
            next_extra = dict(extra or {})
            next_extra["parts"] = [part.model_dump() for part in message.parts]
            extra = next_extra

    if kind is None:
        if is_summary:
            kind = MessageKind.SUMMARY
        elif is_hidden or (extra or {}).get("hidden_from_user"):
            kind = MessageKind.NOTE
        else:
            kind = MessageKind.CHAT
    if pinned is None:
        pinned = kind == MessageKind.NOTE and bool(
            (extra or {}).get("hidden_from_summary")
        )

    try:
        if seq is None:
            seq = await next_seq(db, session_id)
        kwargs: dict = dict(
            session_id=session_id,
            role=message.role,
            content=message.content,
            reasoning_content=reasoning_content,
            tool_calls=tool_calls,
            tool_call_id=tool_call_id,
            name=name,
            seq=seq,
            kind=kind,
            pinned=pinned,
            extra=extra,
        )
        if created_at is not None:
            kwargs["created_at"] = created_at
        db_message = SessionMessage(**kwargs)
        db.add(db_message)
        if flush:
            await db.flush()
        if flush and kind == MessageKind.SUMMARY:
            await bump_history_revision(db, session_id, structural=True)
        # Single post-save record for the whole operation.  This deliberately
        # carries the role-specific detail (tool-call count, tool name) that
        # used to be logged as separate pre-save lines, so one grep still
        # answers "what was persisted" without four lines per message.
        logger.debug(
            "message_saved session_id={} message_id={} role={} content_length={} "
            "tool_calls={} tool={} kind={} seq={} pinned={}",
            session_id,
            db_message.id,
            message.role,
            len(message.content or ""),
            len(tool_calls) if tool_calls else 0,
            name or "-",
            kind,
            seq,
            pinned,
        )
        return db_message
    except Exception as e:
        logger.error(
            "message_save_failed session_id={} role={} error={}",
            session_id,
            message.role,
            e,
        )
        raise


async def get_messages(db: AsyncSession, session_id: UUID) -> list[ChatMessage]:
    """Return the full conversation history for the session.

    This is the list shown to the end user: the derived LLM window (active
    summary divider included) minus internal ``note`` rows.

    To get the context window sent to the LLM, use
    :func:`get_messages_for_llm` instead.
    """
    logger.debug("loading_messages session_id={}", session_id)
    try:
        db_messages = [
            row
            for row in await _llm_window_rows(db, session_id)
            if row.kind != MessageKind.NOTE
        ]
        logger.debug(
            "messages_fetched session_id={} count={}", session_id, len(db_messages)
        )
        # Me run in thread — _deserialize_messages does disk I/O for image hydration
        messages = await asyncio.to_thread(_deserialize_messages, db_messages)
        return messages
    except Exception as e:
        logger.error("load_messages_failed session_id={} error={}", session_id, e)
        raise


async def get_messages_for_llm(db: AsyncSession, session_id: UUID) -> list[ChatMessage]:
    """Return the message window that should be sent to the LLM.

    Strategy
    --------
    Fully derived — see :func:`chat_service_revert.llm_window_stmt`:

    1. Active summary = newest-created ``kind='summary'`` row (before the
       undo boundary, when one is staged).
    2. Window = pinned rows + the active summary + every chat/note/queued row
       positioned at/after it, in ``(seq, id)`` order. The summary is
       *anchored* before the window it kept, so the order the LLM sees is
       ``[pinned…, summary, kept tail…, new messages…]``.
    3. No summary → all non-reverted rows.
    """
    logger.debug("loading_llm_messages session_id={}", session_id)
    try:
        db_messages = await _llm_window_rows(db, session_id)
        logger.debug(
            "llm_messages_fetched session_id={} count={}",
            session_id,
            len(db_messages),
        )
        # Me run in thread — _deserialize_messages does disk I/O for image hydration
        messages = await asyncio.to_thread(
            _deserialize_messages, db_messages, sanitize_tool_pairs=True
        )
        return _apply_llm_content_overrides(messages)
    except Exception as e:
        logger.error("load_llm_messages_failed session_id={} error={}", session_id, e)
        raise


async def save_queued_user_message(
    db: AsyncSession,
    session_id: UUID,
    content: str,
    *,
    extra: dict | None = None,
) -> SessionMessage:
    return await _chat_service_queue.save_queued_user_message(
        db,
        session_id,
        content,
        extra=extra,
        save_message=save_message,
    )


async def release_queued_user_messages(
    db: AsyncSession,
    session_id: UUID,
) -> list[SessionMessage]:
    rows = await _chat_service_queue.release_queued_user_messages(db, session_id)
    if rows:
        await bump_history_revision(db, session_id, structural=True)
    return rows


async def pop_queued_user_messages(
    db: AsyncSession,
    session_id: UUID,
) -> list[SessionMessage]:
    rows = await _chat_service_queue.pop_queued_user_messages(db, session_id)
    if rows:
        await bump_history_revision(db, session_id, structural=True)
    return rows


async def cancel_queued_user_message(
    db: AsyncSession,
    session_id: UUID,
    message_id: UUID,
) -> bool:
    cancelled = await _chat_service_queue.cancel_queued_user_message(
        db, session_id, message_id
    )
    if cancelled:
        await bump_history_revision(db, session_id, structural=True)
    return cancelled


# Preserve patchability from tests and existing callers by rebinding the
# extracted revert module to the local path helper on each call.
async def undo_session_messages(db: AsyncSession, session_id: UUID) -> BoundaryShift:
    _chat_service_revert.session_workspace_dir = session_workspace_dir
    shift = await _chat_service_revert.undo_session_messages(db, session_id)
    if shift.applied:
        await bump_history_revision(db, session_id, structural=True)
    return shift


async def redo_session_messages(db: AsyncSession, session_id: UUID) -> BoundaryShift:
    _chat_service_revert.session_workspace_dir = session_workspace_dir
    shift = await _chat_service_revert.redo_session_messages(db, session_id)
    if shift.applied:
        await bump_history_revision(db, session_id, structural=True)
    return shift


async def redo_all_session_messages(
    db: AsyncSession, session_id: UUID
) -> BoundaryShift:
    _chat_service_revert.session_workspace_dir = session_workspace_dir
    shift = await _chat_service_revert.redo_all_session_messages(db, session_id)
    if shift.applied:
        await bump_history_revision(db, session_id, structural=True)
    return shift


async def cleanup_reverted_tail(db: AsyncSession, session_id: UUID) -> int:
    _chat_service_revert.session_workspace_dir = session_workspace_dir
    cleaned = await _chat_service_revert.cleanup_reverted_tail(db, session_id)
    if cleaned:
        await bump_history_revision(db, session_id, structural=True)
    return cleaned


async def exclude_messages_before_summary(
    db: AsyncSession,
    session_id: UUID,
    summary_message_id: UUID,
    keep_last_n: int = 0,
) -> int:
    """Hide pre-summary rows and invalidate incremental LLM history."""
    hidden = await _exclude_messages_before_summary(
        db, session_id, summary_message_id, keep_last_n
    )
    if hidden:
        await bump_history_revision(db, session_id, structural=True)
    return hidden


# Keep the historical name used by callers and manual scenarios.
hide_messages_before_summary = exclude_messages_before_summary


# ── Session CRUD ─────────────────────────────────────────────────────────────


async def list_sessions_page(
    db: AsyncSession,
    *,
    before: str | None = None,
    limit: int = 20,
    mode: str | None = None,
    workspace: str | None = None,
) -> tuple[list[ChatSession], str | None, bool]:
    """Return a cursor-paginated page of top-level sessions (newest-first).

    Top-level sessions are those without a ``parent_session_id`` (team leads
    and scheduled tasks). Sub-sessions are excluded.

    Args:
        db: Async database session.
        before: Opaque ``<created_at>|<uuid>`` cursor — return older sessions.
            A bare ISO timestamp from an older client remains accepted.
        limit: Maximum number of sessions to return (1–100).
        mode: Optional session mode filter.
        workspace: Optional workspace filter for coding sessions.

    Returns:
        A tuple of ``(sessions, next_cursor, has_more)`` where ``next_cursor``
        is the ISO 8601 ``created_at`` of the last session on this page, or
        ``None`` if this is the last page.

    Raises:
        ValueError: If *before* is not a valid ISO 8601 datetime string.
    """
    stmt = (
        select(ChatSession)
        .where(col(ChatSession.parent_session_id).is_(None))
        .order_by(col(ChatSession.created_at).desc(), col(ChatSession.id).desc())
    )

    if workspace is not None:
        stmt = stmt.where(col(ChatSession.workspace) == workspace)

    if before:
        raw_dt, separator, raw_id = before.partition("|")
        cursor_dt = datetime.fromisoformat(raw_dt.replace("Z", "+00:00"))
        if separator:
            cursor_id = UUID(raw_id)
            stmt = stmt.where(
                sa.tuple_(col(ChatSession.created_at), col(ChatSession.id))
                < sa.tuple_(
                    sa.literal(cursor_dt, type_=TZDateTime()),
                    sa.literal(cursor_id, type_=sa.Uuid()),
                )
            )
        else:
            # Legacy timestamp-only cursor. It cannot disambiguate ties but
            # preserving its old semantics keeps rolling upgrades compatible.
            stmt = stmt.where(col(ChatSession.created_at) < cursor_dt)

    rows = (await db.exec(stmt.limit(limit + 1))).all()

    has_more = len(rows) > limit
    rows = list(rows[:limit])

    next_cursor: str | None = None
    if has_more and rows:
        last_created = rows[-1].created_at
        if last_created is not None:
            if last_created.tzinfo is None:
                last_created = last_created.replace(tzinfo=timezone.utc)
            next_cursor = (
                f"{last_created.isoformat().replace('+00:00', 'Z')}|{rows[-1].id}"
            )

    return rows, next_cursor, has_more


async def get_latest_top_level_session(
    db: AsyncSession,
    *,
    mode: str,
    workspace: str | None,
) -> ChatSession | None:
    """Return the newest top-level session for a mode/workspace pair."""
    stmt = (
        select(ChatSession)
        .where(col(ChatSession.parent_session_id).is_(None))
        .order_by(col(ChatSession.created_at).desc())
    )
    stmt = stmt.where(ChatSession.workspace == (workspace or ""))
    return (await db.exec(stmt.limit(1))).first()


async def update_session_title(
    db: AsyncSession, session_id: UUID, title: str
) -> ChatSession | None:
    """Update a top-level session title and return the refreshed session."""
    async with db.begin():
        session = await db.get(ChatSession, session_id)
        if not session or session.parent_session_id is not None:
            return None
        session.title = title
        db.add(session)
        await db.flush()
        await db.refresh(session)
        return session


async def delete_session(db: AsyncSession, session_id: UUID) -> bool:
    """Delete a session, all its messages, and associated on-disk artifacts.

    Deletes the ``ChatSession`` row plus all ``SessionMessage`` children inside
    a single transaction, then removes the uploads and workspace directories
    from disk (outside the transaction — best-effort).

    Args:
        db: Async database session.
        session_id: UUID of the session to delete.

    Returns:
        ``True`` if the session existed and was deleted, ``False`` if not found.
    """
    from sqlmodel import delete
    from app.services import memory_stream_store, snapshot_service, team_manager

    async with db.begin():
        session = await db.get(ChatSession, session_id)
        if not session:
            return False
        descendants_cte = (
            select(ChatSession.id)
            .where(ChatSession.id == session_id)
            .cte("descendants", recursive=True)
        )
        descendants_cte = descendants_cte.union(
            select(ChatSession.id).join(
                descendants_cte,
                col(ChatSession.parent_session_id) == descendants_cte.c.id,
            )
        )
        descendants = set((await db.exec(select(descendants_cte.c.id))).all())
        managed_workspace_ids = {
            str(session_id)
            for session_id, workspace in (
                await db.exec(
                    select(ChatSession.id, ChatSession.workspace).where(
                        col(ChatSession.id).in_(descendants)
                    )
                )
            ).all()
            if workspace is None
        }

    # Stop producers before rows disappear so they cannot persist a late turn.
    session_ids = {str(sid) for sid in descendants}
    await team_manager.evict_session_teams(session_ids)

    async with db.begin():
        await db.exec(
            delete(SessionMessage).where(
                col(SessionMessage.session_id).in_(descendants)
            )
        )
        # Explicitly delete descendants for SQLite deployments where foreign
        # key enforcement is disabled, and for portability across engines.
        await db.exec(delete(ChatSession).where(col(ChatSession.id).in_(descendants)))

    for descendant_id in session_ids:
        try:
            await memory_stream_store.clear(descendant_id)
        except Exception:
            logger.exception(
                "session_stream_cleanup_failed session_id={}", descendant_id
            )
        try:
            await snapshot_service.remove(descendant_id)
        except Exception:
            logger.exception(
                "session_snapshot_cleanup_failed session_id={}", descendant_id
            )

    async def remove_path(path, label: str) -> None:
        if not path.exists():
            return
        try:
            await asyncio.to_thread(shutil.rmtree, path)
        except Exception:
            logger.exception(
                "session_path_cleanup_failed path={} label={}", path, label
            )
        else:
            logger.info("{}_deleted session_id={}", label, session_id)

    for descendant_id in session_ids:
        await remove_path(uploads_dir(descendant_id), "uploads_dir")
        # Managed workspaces are disposable; a coding session's user-selected
        # workspace is never here.
        if descendant_id in managed_workspace_ids:
            await remove_path(workspace_dir(descendant_id), "workspace_dir")
        await remove_path(session_artifact_dir(descendant_id), "session_metadata")

    logger.info("session_deleted session_id={}", session_id)
    return True


class TeamHistoryMemberData(NamedTuple):
    """One sub-session and its paginated, non-summary messages."""

    session: ChatSession
    messages: list[SessionMessage]


_HISTORY_PAGE_SIZE = 100


def _before_cursor_predicate(before_seq: int | None, before_id: UUID | None):
    """SQL predicate for "strictly older than the ``(seq, id)`` cursor"."""
    if before_seq is None:
        return None
    if before_id is None:
        return col(SessionMessage.seq) < before_seq
    return _chat_service_revert.before_cursor_predicate(before_seq, before_id)


async def resolve_legacy_history_cursor(
    db: AsyncSession,
    session_id: UUID,
    before: datetime,
    before_id: UUID | None,
) -> tuple[int, UUID | None] | None:
    """Translate a legacy ``(created_at, id)`` cursor into ``(seq, id)``.

    Cursors are opaque strings the client echoes back; one persisted before
    the seq remodel carries a timestamp. The boundary row's id (when present)
    resolves it exactly; otherwise fall back to the newest row older than the
    timestamp.
    """
    if before_id is not None:
        row = await db.get(SessionMessage, before_id)
        if row is not None and row.session_id == session_id:
            return row.seq, row.id
    result = await db.exec(
        select(SessionMessage.seq, SessionMessage.id)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.created_at) >= before)
        .order_by(col(SessionMessage.seq).asc(), col(SessionMessage.id).asc())
        .limit(1)
    )
    row = result.first()
    return (row[0], row[1]) if row else None


async def resolve_legacy_delta_cursor(
    db: AsyncSession,
    lead_session_id: UUID,
    since: datetime,
) -> UUID:
    """Translate the old timestamp delta watermark to a uuid7 cursor.

    Older web bundles may survive a daemon upgrade and send their last
    ``created_at`` watermark once. This cold compatibility scan finds the
    newest-created row at/before it across the lead and direct members; all
    subsequent requests from the updated client use the indexed uuid7 path.
    """
    tree_session_ids = select(ChatSession.id).where(
        sa.or_(
            col(ChatSession.id) == lead_session_id,
            col(ChatSession.parent_session_id) == lead_session_id,
        )
    )
    row = (
        await db.exec(
            select(SessionMessage.id)
            .where(col(SessionMessage.session_id).in_(tree_session_ids))
            .where(col(SessionMessage.created_at) <= since)
            .order_by(
                col(SessionMessage.created_at).desc(),
                col(SessionMessage.id).desc(),
            )
            .limit(1)
        )
    ).first()
    return row if row is not None else UUID(int=0)


class TeamHistoryData(NamedTuple):
    """Full history payload for a team lead session.

    Returned by :func:`get_team_history`.

    ``next_cursor``/``next_cursor_id`` together form the pagination cursor.
    The id component is required: ``created_at`` alone cannot break ties, and
    team turns batch-insert lead and member rows that routinely share a
    timestamp, so a timestamp-only cursor silently skips the tied rows.
    """

    lead_session: ChatSession
    lead_messages: list[SessionMessage]
    members: list[TeamHistoryMemberData]
    has_more: bool
    next_cursor: int | None
    next_cursor_id: UUID | None = None


async def _fetch_member_pages(
    db: AsyncSession,
    sub_sessions: Sequence[ChatSession],
    *,
    before_seq: int | None,
    before_id: UUID | None = None,
) -> list[TeamHistoryMemberData]:
    """Fetch an index-bounded newest page for every sub-session.

    Each member uses one ``(session_id, seq, id)`` index walk capped at
    ``_HISTORY_PAGE_SIZE + 1``. A previous single-query implementation used
    ``ROW_NUMBER() OVER (PARTITION BY session_id ...)`` to avoid N queries,
    but SQLite had to rank every historical row and build two temp B-trees
    before applying the page cap. On the production clone (10 members / 3,340
    rows) the bounded index walks are ~5x faster despite the extra round trips.

    Semantics match the old loop exactly:
    - the ``(seq, id)`` cursor (from the lead's page) is applied uniformly;
    - hidden rows are excluded in SQL via the typed ``kind`` filter, so the
      ``ROW_NUMBER()`` window ranks only user-visible rows — a member whose
      newest rows were all hidden (an undone batch of work) still returns
      its older visible rows;
    - sub-sessions with no messages still appear, with an empty list;
    - per-session order is chronological (ascending), sessions keep the
      caller-provided order.
    """
    if not sub_sessions:
        return []
    before_predicate = _before_cursor_predicate(before_seq, before_id)

    members: list[TeamHistoryMemberData] = []
    for sub in sub_sessions:
        stmt = (
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == sub.id)
            .where(_user_visible_predicate())
            .order_by(
                col(SessionMessage.seq).desc(),
                col(SessionMessage.id).desc(),
            )
            .limit(_HISTORY_PAGE_SIZE + 1)
        )
        if before_predicate is not None:
            stmt = stmt.where(before_predicate)
        raw_member = list((await db.exec(stmt)).all())
        member_msgs = list(reversed(raw_member[:_HISTORY_PAGE_SIZE]))
        members.append(TeamHistoryMemberData(session=sub, messages=member_msgs))
    return members


class TeamHistoryDelta(NamedTuple):
    """Messages persisted *after* a client-supplied cursor.

    Returned by :func:`get_team_history_since`.  ``truncated`` means the delta
    hit ``limit`` and the caller should fall back to a full page instead of
    stitching an incomplete tail onto its local state.
    """

    lead_session: ChatSession
    lead_messages: list[SessionMessage]
    members: list[TeamHistoryMemberData]
    truncated: bool


async def _fetch_member_delta(
    db: AsyncSession,
    sub_sessions: Sequence[ChatSession],
    *,
    since_id: UUID,
    limit: int,
) -> list[TeamHistoryMemberData]:
    """Rows created after ``since_id`` for every member, page-bounded.

    uuid7 ids are globally creation-ordered, so one cursor is valid across
    the lead and all member sessions. The per-member ``(session_id, id)``
    index stops after ``limit + 1`` rows; sorting by logical ``(seq, id)``
    happens on that bounded result so anchored summaries land correctly.
    """
    if not sub_sessions:
        return []

    members: list[TeamHistoryMemberData] = []
    for sub in sub_sessions:
        visible = list(
            (
                await db.exec(
                    select(SessionMessage)
                    .where(col(SessionMessage.session_id) == sub.id)
                    .where(col(SessionMessage.id) > since_id)
                    .where(_user_visible_predicate())
                    .order_by(col(SessionMessage.id).asc())
                    .limit(limit + 1)
                )
            ).all()
        )
        visible.sort(key=lambda row: (row.seq, row.id))
        members.append(TeamHistoryMemberData(session=sub, messages=visible[:limit]))
    return members


async def get_team_history_since(
    db: AsyncSession,
    lead_session_id: UUID,
    *,
    since_id: UUID,
    limit: int = _HISTORY_PAGE_SIZE,
) -> TeamHistoryDelta | None:
    """Fetch only rows created after the uuid7 ``since_id`` cursor.

    Exists so the frontend's turn-completion reconciliation can adopt canonical
    message ids/timestamps without re-downloading the whole visible page — that
    page reaches well over a megabyte on an active session, and the client
    already received the same content over SSE.

    ``since_id`` is exclusive: the cursor row is already on the client. uuid7
    creation order is global across the lead and its members, unlike per-session
    ``seq``. It also discovers newly anchored summaries whose logical ``seq``
    sits before the previous tail. Results are returned in logical ``(seq, id)``
    order so callers can reuse the same block parser.

    Returns ``None`` when the lead session does not exist.
    """
    lead_session = await db.get(ChatSession, lead_session_id)
    if lead_session is None:
        return None

    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == lead_session_id)
        .where(col(SessionMessage.id) > since_id)
        .where(_user_visible_predicate())
        .order_by(col(SessionMessage.id).asc())
        .limit(limit + 1)
    )
    rows = list((await db.exec(stmt)).all())
    truncated = len(rows) > limit
    lead_messages = rows[:limit]
    lead_messages.sort(key=lambda row: (row.seq, row.id))

    sub_sessions = (
        await db.exec(
            select(ChatSession)
            .where(col(ChatSession.parent_session_id) == lead_session_id)
            .order_by(col(ChatSession.created_at).asc())
        )
    ).all()
    members = await _fetch_member_delta(
        db, sub_sessions, since_id=since_id, limit=limit
    )
    if any(len(member.messages) >= limit for member in members):
        truncated = True

    return TeamHistoryDelta(
        lead_session=lead_session,
        lead_messages=lead_messages,
        members=members,
        truncated=truncated,
    )


async def get_team_history(
    db: AsyncSession,
    lead_session_id: UUID,
    *,
    before_seq: int | None = None,
    before_id: UUID | None = None,
) -> TeamHistoryData | None:
    """Fetch the latest page of history for a team lead session and its sub-sessions.

    Fetches up to ``_HISTORY_PAGE_SIZE`` messages per session ordered by
    ``(seq, id) DESC`` (newest first), then reverses to chronological order
    for the caller.  Pass the ``next_cursor`` from a previous response as
    ``before_seq`` — and ``next_cursor_id`` as ``before_id`` — to load older
    messages.

    Returns ``None`` if the lead session does not exist.
    """
    lead_session = await db.get(ChatSession, lead_session_id)
    if lead_session is None:
        return None

    # Summaries are NOT filtered here: the compaction divider in the web UI
    # keys off summary rows to render the inline "Session compacted" marker.
    # ``kind`` is a typed column, so the SQL filter is exact — no Python
    # backstop or refill loop is needed anymore.
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == lead_session_id)
        .where(_user_visible_predicate())
        .order_by(
            col(SessionMessage.seq).desc(),
            col(SessionMessage.id).desc(),
        )
        .limit(_HISTORY_PAGE_SIZE + 1)
    )
    scan_predicate = _before_cursor_predicate(before_seq, before_id)
    if scan_predicate is not None:
        stmt = stmt.where(scan_predicate)
    raw_lead = list((await db.exec(stmt)).all())

    has_more = len(raw_lead) > _HISTORY_PAGE_SIZE
    raw_lead = raw_lead[:_HISTORY_PAGE_SIZE]
    lead_msgs = list(reversed(raw_lead))
    boundary = lead_msgs[0] if (has_more and lead_msgs) else None
    next_cursor = boundary.seq if boundary is not None else None
    next_cursor_id = boundary.id if boundary is not None else None

    sub_sessions = (
        await db.exec(
            select(ChatSession)
            .where(col(ChatSession.parent_session_id) == lead_session_id)
            .order_by(col(ChatSession.created_at).asc())
        )
    ).all()

    members = await _fetch_member_pages(
        db, sub_sessions, before_seq=before_seq, before_id=before_id
    )

    return TeamHistoryData(
        lead_session=lead_session,
        lead_messages=lead_msgs,
        members=members,
        has_more=has_more,
        next_cursor=next_cursor,
        next_cursor_id=next_cursor_id,
    )
