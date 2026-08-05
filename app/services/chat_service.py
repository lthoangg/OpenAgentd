import asyncio
import shutil
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from uuid import UUID

import sqlalchemy as sa
from loguru import logger
from sqlalchemy.orm import aliased
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    ToolMessage,
)
from app.agent.artifacts import session_artifact_dir
from app.core.paths import session_workspace_dir, uploads_dir, workspace_dir
from app.models.chat import ChatSession, SessionMessage
from app.services import chat_service_queue as _chat_service_queue
from app.services import chat_service_revert as _chat_service_revert
from app.services.chat_service_messages import (
    apply_llm_content_overrides as _apply_llm_content_overrides,
    deserialize_messages as _deserialize_messages,
)
from app.services.chat_service_revert import (
    BoundaryShift,
    boundary_created_at as _boundary_created_at,
    exclude_messages_before_summary,
    get_dynamically_visible_messages as _get_dynamically_visible_messages,
    history_messages_stmt as _history_messages_stmt,
    is_hidden_from_user as _is_hidden_from_user,
    llm_history_messages_stmt as _llm_history_messages_stmt,
)


async def create_chat_session(
    db: AsyncSession,
    title: str | None = None,
    parent_session_id: UUID | None = None,
    agent_name: str | None = None,
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
        )
        db.add(session)
        await db.flush()
        await db.refresh(session)
        logger.info("chat_session_created session_id={} title={}", session.id, title)
        return session
    except Exception as e:
        logger.error("chat_session_creation_failed error={} title={}", e, title)
        raise


_INTERRUPTED_TOOL_RESULT = (
    "Tool execution was interrupted before a result could be recorded."
)


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
    boundary = await _boundary_created_at(db, session_id)
    stmt = (
        _llm_history_messages_stmt(session_id)
        if boundary is None
        else _history_messages_stmt(session_id, boundary)
    )
    rows = (await db.exec(stmt)).all()
    db_messages = await _get_dynamically_visible_messages(
        db, session_id, boundary, rows
    )

    assistant_rows = [
        row for row in db_messages if row.role == "assistant" and row.tool_calls
    ]
    if not assistant_rows:
        return 0

    expected_ids: list[str] = []
    for row in assistant_rows:
        expected_ids.extend(tc["id"] for tc in row.tool_calls or [] if tc.get("id"))
    if not expected_ids:
        return 0

    matched_ids = {
        row.tool_call_id
        for row in db_messages
        if row.role == "tool" and row.tool_call_id in expected_ids
    }
    missing_by_row: list[tuple[SessionMessage, list[dict]]] = []
    for row in assistant_rows:
        missing = [tc for tc in row.tool_calls or [] if tc.get("id") not in matched_ids]
        if missing:
            missing_by_row.append((row, missing))

    if not missing_by_row:
        return 0

    # Anchor synthetic timestamps to the orphaned assistant message so
    # that even if the user sends the next message in the same micro-
    # second as the heal runs, the LLM input order is unambiguous:
    # ``assistant{tool_calls} → tool (synth) → tool (synth) → … → user``.
    # ``+1µs * (i+1)`` keeps multiple stubs strictly monotonic relative
    # to one another, and well before any new ``utcnow()`` write.
    healed_ids: list[str] = []
    for row, missing in missing_by_row:
        for i, tc in enumerate(missing):
            stub = ToolMessage(
                content=_INTERRUPTED_TOOL_RESULT,
                tool_call_id=tc["id"],
                name=tc.get("function", {}).get("name", "unknown"),
            )
            await save_message(
                db,
                session_id,
                stub,
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
    exclude_from_context: bool | None = None,
    extra: dict | None = None,
    created_at: datetime | None = None,
) -> SessionMessage:
    """Saves a ChatMessage to the database.

    Args:
        db: Async database session.
        session_id: The session to attach the message to.
        message: The chat message to persist.
        is_summary: When ``True`` this message is a conversation summary
            (produced by :class:`~app.hooks.summarization.SummarizationHook`).
        is_hidden: Deprecated alias for ``exclude_from_context``.
        exclude_from_context: When ``True`` this message is excluded from the
            LLM context window but retained for audit / history.
        created_at: Optional explicit timestamp.  Defaults to ``utcnow()``
            via the model's Field default.  Used by
            :func:`heal_orphaned_tool_calls` to anchor synthetic tool
            replies immediately after the orphaned assistant message
            (so the LLM sees ``assistant{tool_calls} → tool → user``,
            not ``assistant{tool_calls} → user → tool``).
    """
    # Me support both old and new param names during transition
    _exclude = exclude_from_context if exclude_from_context is not None else is_hidden
    logger.debug(
        "saving_message session_id={} role={} content_length={} is_summary={} exclude_from_context={}",
        session_id,
        message.role,
        len(message.content or ""),
        is_summary,
        _exclude,
    )

    tool_calls = None
    tool_call_id = None
    name = None
    reasoning_content = None

    if isinstance(message, AssistantMessage):
        reasoning_content = message.reasoning_content
        if message.tool_calls:
            tool_calls = [tc.model_dump() for tc in message.tool_calls]
            logger.debug(
                "assistant_message_has_tool_calls session_id={} count={}",
                session_id,
                len(tool_calls),
            )
    elif isinstance(message, ToolMessage):
        tool_call_id = message.tool_call_id
        name = message.name
        logger.debug(
            "tool_message_with_result session_id={} tool={} id={}",
            session_id,
            name,
            tool_call_id,
        )
        if message.parts:
            next_extra = dict(extra or {})
            next_extra["parts"] = [part.model_dump() for part in message.parts]
            extra = next_extra

    try:
        kwargs: dict = dict(
            session_id=session_id,
            role=message.role,
            content=message.content,
            reasoning_content=reasoning_content,
            tool_calls=tool_calls,
            tool_call_id=tool_call_id,
            name=name,
            is_summary=is_summary,
            exclude_from_context=_exclude,
            extra=extra,
        )
        if created_at is not None:
            kwargs["created_at"] = created_at
        db_message = SessionMessage(**kwargs)
        db.add(db_message)
        await db.flush()
        logger.debug(
            "message_saved session_id={} message_id={} role={}",
            session_id,
            db_message.id,
            message.role,
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

    This is the list shown to the end user.  Summary messages (``is_summary=True``)
    are included so the UI can render them.

    To get the context window sent to the LLM, use
    :func:`get_messages_for_llm` instead.
    """
    logger.debug("loading_messages session_id={}", session_id)
    try:
        boundary = await _boundary_created_at(db, session_id)
        rows = (await db.exec(_history_messages_stmt(session_id, boundary))).all()
        db_messages = await _get_dynamically_visible_messages(
            db, session_id, boundary, rows
        )
        logger.debug(
            "messages_fetched session_id={} count={}", session_id, len(db_messages)
        )
        # Me run in thread — _deserialize_messages does disk I/O for image hydration
        messages = await asyncio.to_thread(_deserialize_messages, db_messages)
        return [
            m for m in messages if not (m.extra and m.extra.get("hidden_from_user"))
        ]
    except Exception as e:
        logger.error("load_messages_failed session_id={} error={}", session_id, e)
        raise


async def get_messages_for_llm(db: AsyncSession, session_id: UUID) -> list[ChatMessage]:
    """Return the message window that should be sent to the LLM.

    Strategy
    --------
    1. Find the most recent ``is_summary=True`` message.
    2. If one exists, return ``[latest_summary] + [non-hidden, non-summary
       messages ordered by created_at]``.  This correctly handles:
       - Multiple summaries: only the latest is prepended; older summary rows
         are excluded by the ``not is_summary`` filter.
       - ``keep_last_n`` messages: they were not hidden so they appear after
         the summary in chronological order, even though their ``created_at``
         is earlier than the summary's.
       - Fresh messages added after the summary: included in order.
    3. If no summary exists, fall back to all visible (non-hidden) messages —
       identical to :func:`get_messages`.
    """
    logger.debug("loading_llm_messages session_id={}", session_id)
    try:
        boundary = await _boundary_created_at(db, session_id)
        stmt = (
            _llm_history_messages_stmt(session_id)
            if boundary is None
            else _history_messages_stmt(session_id, boundary)
        )
        rows = (await db.exec(stmt)).all()
        db_messages = await _get_dynamically_visible_messages(
            db, session_id, boundary, rows
        )

        # Move the active summary to position 0 so the LLM always sees the
        # context window as [summary → kept_last_n → post-summary messages].
        # This is a no-op when there is no active summary (e.g. after undo).
        active_summary = next((m for m in db_messages if m.is_summary), None)
        if active_summary is not None:
            db_messages = [active_summary] + [
                m for m in db_messages if m.id != active_summary.id
            ]
        logger.debug(
            "llm_messages_fetched session_id={} count={} summary_id={}",
            session_id,
            len(db_messages),
            active_summary.id if active_summary else None,
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
    return await _chat_service_queue.release_queued_user_messages(db, session_id)


async def pop_queued_user_messages(
    db: AsyncSession,
    session_id: UUID,
) -> list[SessionMessage]:
    return await _chat_service_queue.pop_queued_user_messages(db, session_id)


async def cancel_queued_user_message(
    db: AsyncSession,
    session_id: UUID,
    message_id: UUID,
) -> bool:
    return await _chat_service_queue.cancel_queued_user_message(
        db, session_id, message_id
    )


# Preserve patchability from tests and existing callers by rebinding the
# extracted revert module to the local path helper on each call.
async def undo_session_messages(db: AsyncSession, session_id: UUID) -> BoundaryShift:
    _chat_service_revert.session_workspace_dir = session_workspace_dir
    return await _chat_service_revert.undo_session_messages(db, session_id)


async def redo_session_messages(db: AsyncSession, session_id: UUID) -> BoundaryShift:
    _chat_service_revert.session_workspace_dir = session_workspace_dir
    return await _chat_service_revert.redo_session_messages(db, session_id)


async def cleanup_reverted_tail(db: AsyncSession, session_id: UUID) -> int:
    _chat_service_revert.session_workspace_dir = session_workspace_dir
    return await _chat_service_revert.cleanup_reverted_tail(db, session_id)


# Me keep backward-compat alias during transition
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
        before: ISO 8601 ``created_at`` cursor — return sessions older than this.
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
        .order_by(col(ChatSession.created_at).desc())
    )

    if mode is not None:
        stmt = stmt.where(col(ChatSession.mode) == mode)
    if workspace is not None:
        stmt = stmt.where(col(ChatSession.workspace) == workspace)

    if before:
        cursor_dt = datetime.fromisoformat(before.replace("Z", "+00:00"))
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
            next_cursor = last_created.isoformat().replace("+00:00", "Z")

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
        .where(
            col(ChatSession.parent_session_id).is_(None),
            ChatSession.mode == mode,
        )
        .order_by(col(ChatSession.created_at).desc())
    )
    if workspace is None:
        stmt = stmt.where(col(ChatSession.workspace).is_(None))
    else:
        stmt = stmt.where(ChatSession.workspace == workspace)
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
            str(row.id)
            for row in (
                await db.exec(
                    select(ChatSession.id, ChatSession.workspace).where(
                        col(ChatSession.id).in_(descendants)
                    )
                )
            ).all()
            if row.workspace is None
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


def _visible_to_user_predicate():
    """SQL predicate matching rows not marked ``extra.hidden_from_user``.

    Shared by the lead and member history queries so both pages agree on which
    layer owns the filter. A Python-side :func:`_is_hidden_from_user` pass is
    still applied after fetching, because the JSON ``as_boolean()`` cast here
    and Python truthiness disagree on non-boolean values (e.g. a stored
    ``"1"``); the SQL predicate is the bulk filter, Python is the backstop.
    """
    hidden = col(SessionMessage.extra)["hidden_from_user"].as_boolean()
    return sa.or_(hidden.is_(None), hidden.is_(False))


def _before_cursor_predicate(before: datetime | None, before_id: UUID | None):
    """SQL predicate for "strictly older than the ``(created_at, id)`` cursor".

    ``created_at`` alone cannot order rows that share a timestamp, so paging on
    it drops the tied rows. When *before_id* is supplied the comparison becomes
    a proper compound tuple test; without it the predicate degrades to the
    timestamp-only form for backwards compatibility with older cursors.
    """
    if before is None:
        return None
    if before_id is None:
        return col(SessionMessage.created_at) < before
    return sa.or_(
        col(SessionMessage.created_at) < before,
        sa.and_(
            col(SessionMessage.created_at) == before,
            col(SessionMessage.id) < before_id,
        ),
    )


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
    next_cursor: datetime | None
    next_cursor_id: UUID | None = None


async def _fetch_member_pages(
    db: AsyncSession,
    sub_sessions: Sequence[ChatSession],
    *,
    before: datetime | None,
    before_id: UUID | None = None,
) -> list[TeamHistoryMemberData]:
    """Fetch the newest message page for every sub-session in one query.

    Replaces the previous N+1 loop (one ``SELECT`` per sub-session) with a
    single batched ``WHERE session_id IN (...)`` query ordered newest-first,
    grouped back per session in Python. The per-session
    ``_HISTORY_PAGE_SIZE + 1`` cap is enforced in SQL via a
    ``ROW_NUMBER() OVER (PARTITION BY session_id ...)`` window so a session
    with a very long history never pulls unbounded rows into memory.

    Semantics match the old loop exactly:
    - ``before`` filter (from the lead's cursor) is applied uniformly;
    - hidden rows are excluded in SQL, mirroring the lead query, so the
      ``ROW_NUMBER()`` window ranks only user-visible rows. Without this a
      member whose newest ``_HISTORY_PAGE_SIZE + 1`` rows were all hidden
      (an undone batch of work) returned an *empty* page, and since member
      histories carry no cursor of their own the older visible rows were
      unreachable. A Python ``_is_hidden_from_user`` pass still runs as a
      backstop for values the JSON boolean cast cannot express;
    - sub-sessions with no messages still appear, with an empty list;
    - per-session order is chronological (ascending), sessions keep the
      caller-provided order.

    The final newest-``_HISTORY_PAGE_SIZE`` trim (after hidden-row
    filtering) still happens in Python, but operates on at most
    ``_HISTORY_PAGE_SIZE + 1`` rows per session.
    """
    if not sub_sessions:
        return []

    session_ids = [s.id for s in sub_sessions]

    # Rank rows newest-first *within each session* so SQL enforces the
    # per-session page cap. Without this, a member with a very long history
    # materialized every row before the Python-side trim (unbounded memory).
    rank = (
        sa.func.row_number()
        .over(
            partition_by=col(SessionMessage.session_id),
            order_by=(
                col(SessionMessage.created_at).desc(),
                col(SessionMessage.id).desc(),
            ),
        )
        .label("rank")
    )
    inner = select(SessionMessage, rank).where(
        col(SessionMessage.session_id).in_(session_ids),
        _visible_to_user_predicate(),
    )
    before_predicate = _before_cursor_predicate(before, before_id)
    if before_predicate is not None:
        inner = inner.where(before_predicate)
    ranked = inner.subquery()
    msg_alias = aliased(SessionMessage, ranked)
    stmt = (
        select(msg_alias)
        .where(ranked.c.rank <= _HISTORY_PAGE_SIZE + 1)
        .order_by(ranked.c.created_at.desc(), ranked.c.id.desc())
    )
    rows = (await db.exec(stmt)).all()

    # Group newest-first per session (rows already arrive in DESC order, so
    # appending preserves the per-session ordering the old loop produced).
    by_session: dict[UUID, list[SessionMessage]] = {sid: [] for sid in session_ids}
    for msg in rows:
        bucket = by_session.get(msg.session_id)
        if bucket is not None:
            bucket.append(msg)

    members: list[TeamHistoryMemberData] = []
    for sub in sub_sessions:
        raw_member = [
            msg for msg in by_session.get(sub.id, []) if not _is_hidden_from_user(msg)
        ]
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
    since: datetime,
    limit: int,
) -> list[TeamHistoryMemberData]:
    """Newest-after-``since`` messages for every sub-session in one query.

    Mirrors :func:`_fetch_member_pages` (single batched ``IN`` query with a
    per-session ``ROW_NUMBER()`` cap so one chatty member cannot pull unbounded
    rows) but scans *forward* from the cursor and returns chronological order.
    """
    if not sub_sessions:
        return []

    session_ids = [s.id for s in sub_sessions]
    rank = (
        sa.func.row_number()
        .over(
            partition_by=col(SessionMessage.session_id),
            order_by=(
                col(SessionMessage.created_at).asc(),
                col(SessionMessage.id).asc(),
            ),
        )
        .label("rank")
    )
    inner = select(SessionMessage, rank).where(
        col(SessionMessage.session_id).in_(session_ids),
        col(SessionMessage.created_at) > since,
    )
    ranked = inner.subquery()
    msg_alias = aliased(SessionMessage, ranked)
    stmt = (
        select(msg_alias)
        .where(ranked.c.rank <= limit + 1)
        .order_by(ranked.c.created_at.asc(), ranked.c.id.asc())
    )
    rows = (await db.exec(stmt)).all()

    by_session: dict[UUID, list[SessionMessage]] = {sid: [] for sid in session_ids}
    for msg in rows:
        bucket = by_session.get(msg.session_id)
        if bucket is not None:
            bucket.append(msg)

    members: list[TeamHistoryMemberData] = []
    for sub in sub_sessions:
        visible = [
            msg for msg in by_session.get(sub.id, []) if not _is_hidden_from_user(msg)
        ]
        members.append(TeamHistoryMemberData(session=sub, messages=visible[:limit]))
    return members


async def get_team_history_since(
    db: AsyncSession,
    lead_session_id: UUID,
    *,
    since: datetime,
    limit: int = _HISTORY_PAGE_SIZE,
) -> TeamHistoryDelta | None:
    """Fetch only the messages persisted after ``since``.

    Exists so the frontend's turn-completion reconciliation can adopt canonical
    message ids/timestamps without re-downloading the whole visible page — that
    page reaches well over a megabyte on an active session, and the client
    already received the same content over SSE.

    ``since`` is exclusive: the cursor row is already on the client. Ordering is
    chronological (ascending), matching :func:`get_team_history`, so callers can
    reuse the same block parser.

    Returns ``None`` when the lead session does not exist.
    """
    lead_session = await db.get(ChatSession, lead_session_id)
    if lead_session is None:
        return None

    hidden_from_user = col(SessionMessage.extra)["hidden_from_user"].as_boolean()
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == lead_session_id)
        .where(col(SessionMessage.created_at) > since)
        .where(sa.or_(hidden_from_user.is_(None), hidden_from_user.is_(False)))
        .order_by(
            col(SessionMessage.created_at).asc(),
            col(SessionMessage.id).asc(),
        )
        .limit(limit + 1)
    )
    rows = list((await db.exec(stmt)).all())
    visible = [msg for msg in rows if not _is_hidden_from_user(msg)]
    truncated = len(visible) > limit
    lead_messages = visible[:limit]

    sub_sessions = (
        await db.exec(
            select(ChatSession)
            .where(col(ChatSession.parent_session_id) == lead_session_id)
            .order_by(col(ChatSession.created_at).asc())
        )
    ).all()
    members = await _fetch_member_delta(db, sub_sessions, since=since, limit=limit)
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
    before: datetime | None = None,
    before_id: UUID | None = None,
) -> TeamHistoryData | None:
    """Fetch the latest page of history for a team lead session and its sub-sessions.

    Fetches up to ``_HISTORY_PAGE_SIZE`` messages per session ordered by
    ``created_at DESC`` (newest first), then reverses to chronological order
    for the caller.  Pass the ``next_cursor`` from a previous response as
    ``before`` — and ``next_cursor_id`` as ``before_id`` — to load older
    messages. Supplying only ``before`` still works but cannot break
    ``created_at`` ties, so rows sharing the boundary timestamp are skipped.

    Returns ``None`` if the lead session does not exist.
    """
    lead_session = await db.get(ChatSession, lead_session_id)
    if lead_session is None:
        return None

    # Me: summaries are NOT filtered here. The compaction divider in the
    # web UI keys off ``is_summary=True`` rows to render the inline
    # "Session compacted" marker + summary body; hiding them would make
    # the divider vanish on reload. Undo uses ``extra.hidden_from_user``.
    raw_lead: list[SessionMessage] = []
    scan_before = before
    scan_before_id: UUID | None = before_id
    # Bound the refill loop. Hidden rows are already excluded in SQL, so a
    # second pass only happens for rows the JSON boolean cast and Python
    # truthiness disagree on. Without a cap that disagreement would scan the
    # whole session one page at a time.
    max_scans = 4
    scans_used = 0
    for _ in range(max_scans):
        if len(raw_lead) > _HISTORY_PAGE_SIZE:
            break
        scans_used += 1
        stmt = (
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == lead_session_id)
            .where(_visible_to_user_predicate())
            .order_by(
                col(SessionMessage.created_at).desc(),
                col(SessionMessage.id).desc(),
            )
            .limit(_HISTORY_PAGE_SIZE + 1)
        )
        scan_predicate = _before_cursor_predicate(scan_before, scan_before_id)
        if scan_predicate is not None:
            stmt = stmt.where(scan_predicate)
        rows = list((await db.exec(stmt)).all())
        raw_lead.extend(msg for msg in rows if not _is_hidden_from_user(msg))
        if len(rows) < _HISTORY_PAGE_SIZE + 1:
            break
        scan_before = rows[-1].created_at
        scan_before_id = rows[-1].id

    if scans_used >= max_scans and len(raw_lead) <= _HISTORY_PAGE_SIZE:
        # Only reachable when the SQL boolean cast and Python truthiness
        # disagree about ``hidden_from_user`` often enough to drain four
        # consecutive pages. That means malformed ``extra`` payloads — log it
        # rather than keep scanning the session one page at a time.
        logger.warning(
            "team_history_scan_cap_hit session_id={} scans={} visible_rows={}",
            lead_session_id,
            scans_used,
            len(raw_lead),
        )

    has_more = len(raw_lead) > _HISTORY_PAGE_SIZE
    raw_lead = raw_lead[:_HISTORY_PAGE_SIZE]
    lead_msgs = list(reversed(raw_lead))
    boundary = lead_msgs[0] if (has_more and lead_msgs) else None
    next_cursor = boundary.created_at if boundary is not None else None
    next_cursor_id = boundary.id if boundary is not None else None

    sub_sessions = (
        await db.exec(
            select(ChatSession)
            .where(col(ChatSession.parent_session_id) == lead_session_id)
            .order_by(col(ChatSession.created_at).asc())
        )
    ).all()

    members = await _fetch_member_pages(
        db, sub_sessions, before=before, before_id=before_id
    )

    return TeamHistoryData(
        lead_session=lead_session,
        lead_messages=lead_msgs,
        members=members,
        has_more=has_more,
        next_cursor=next_cursor,
        next_cursor_id=next_cursor_id,
    )
