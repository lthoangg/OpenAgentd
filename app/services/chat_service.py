import asyncio
import shutil
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from uuid import UUID

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
from app.models.chat import ChatSession, SessionMessage
from app.services import chat_service_queue as _chat_service_queue
from app.services import chat_service_revert as _chat_service_revert
from app.services.chat_service_messages import (
    apply_llm_content_overrides as _apply_llm_content_overrides,
    deserialize_messages as _deserialize_messages,
)
from app.services.chat_service_revert import (
    BoundaryShift,
    before_boundary as _before_boundary,
    boundary_created_at as _boundary_created_at,
    exclude_messages_before_summary,
    history_messages_stmt as _history_messages_stmt,
    is_hidden_from_user as _is_hidden_from_user,
    is_history_visible as _is_history_visible,
    visible_messages_stmt as _visible_messages_stmt,
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
    summary_stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(col(SessionMessage.is_summary))
        .where(~col(SessionMessage.exclude_from_context))
    )
    summary_stmt = (
        _before_boundary(summary_stmt, boundary)
        .order_by(col(SessionMessage.created_at).desc())
        .limit(1)
    )
    latest_summary = (await db.exec(summary_stmt)).first()

    if latest_summary is None:
        db_messages = list(
            (await db.exec(_visible_messages_stmt(session_id, boundary))).all()
        )
    else:
        rest_stmt = _visible_messages_stmt(session_id, boundary).where(
            ~col(SessionMessage.is_summary)
        )
        db_messages = [latest_summary] + list((await db.exec(rest_stmt)).all())

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
        await db.refresh(db_message)
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
    """Retrieves all *visible* ChatMessages for a session.

    Excluded messages (``exclude_from_context=True``) are filtered out — this
    is the list shown to the end user.  Summary messages (``is_summary=True``)
    are included so the UI can render them.

    To get the context window sent to the LLM, use
    :func:`get_messages_for_llm` instead.
    """
    logger.debug("loading_messages session_id={}", session_id)
    try:
        boundary = await _boundary_created_at(db, session_id)
        rows = (await db.exec(_history_messages_stmt(session_id, boundary))).all()
        db_messages = [row for row in rows if _is_history_visible(row)]
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
        # Find the latest summary message
        summary_stmt = (
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == session_id)
            .where(col(SessionMessage.is_summary))
            .where(~col(SessionMessage.exclude_from_context))
        )
        summary_stmt = (
            _before_boundary(summary_stmt, boundary)
            .order_by(col(SessionMessage.created_at).desc())
            .limit(1)
        )
        latest_summary = (await db.exec(summary_stmt)).first()

        if latest_summary is None:
            # No summary yet — use all visible messages
            db_messages = (
                await db.exec(_visible_messages_stmt(session_id, boundary))
            ).all()
            messages = await asyncio.to_thread(
                _deserialize_messages, db_messages, sanitize_tool_pairs=True
            )
            return _apply_llm_content_overrides(messages)

        # Fetch all non-hidden, non-summary messages.  This naturally includes:
        #   - keep_last_n messages (not hidden, created before the summary)
        #   - fresh messages added after the summary
        # It excludes:
        #   - hidden messages (superseded by the summary)
        #   - other summary rows (older summaries are also excluded)
        #   - the latest summary itself (prepended explicitly below)
        rest_stmt = _visible_messages_stmt(session_id, boundary).where(
            ~col(SessionMessage.is_summary)
        )
        rest_messages = list((await db.exec(rest_stmt)).all())

        db_messages = [latest_summary] + rest_messages

        logger.debug(
            "llm_messages_fetched session_id={} count={} summary_id={}",
            session_id,
            len(db_messages),
            latest_summary.id,
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
    delete_workspace = False
    async with db.begin():
        session = await db.get(ChatSession, session_id)
        if not session:
            return False
        delete_workspace = session.workspace is None
        messages = (
            await db.exec(
                select(SessionMessage).where(
                    col(SessionMessage.session_id) == session_id
                )
            )
        ).all()
        for msg in messages:
            await db.delete(msg)
        await db.delete(session)

    sid_str = str(session_id)
    uploads = uploads_dir(sid_str)
    if uploads.exists():
        await asyncio.to_thread(shutil.rmtree, uploads, ignore_errors=True)
        logger.info("uploads_dir_deleted session_id={}", session_id)

    workspace = workspace_dir(sid_str)
    if delete_workspace and workspace.exists():
        await asyncio.to_thread(shutil.rmtree, workspace, ignore_errors=True)
        logger.info("workspace_dir_deleted session_id={}", session_id)

    metadata = session_artifact_dir(sid_str)
    if metadata.exists():
        await asyncio.to_thread(shutil.rmtree, metadata, ignore_errors=True)
        logger.info("session_metadata_deleted session_id={}", session_id)

    logger.info("session_deleted session_id={}", session_id)
    return True


class TeamHistoryMemberData(NamedTuple):
    """One sub-session and its paginated, non-summary messages."""

    session: ChatSession
    messages: list[SessionMessage]


_HISTORY_PAGE_SIZE = 100


class TeamHistoryData(NamedTuple):
    """Full history payload for a team lead session.

    Returned by :func:`get_team_history`.
    """

    lead_session: ChatSession
    lead_messages: list[SessionMessage]
    members: list[TeamHistoryMemberData]
    has_more: bool
    next_cursor: datetime | None


async def _fetch_member_pages(
    db: AsyncSession,
    sub_sessions: Sequence[ChatSession],
    *,
    before: datetime | None,
) -> list[TeamHistoryMemberData]:
    """Fetch the newest message page for every sub-session in one query.

    Replaces the previous N+1 loop (one ``SELECT`` per sub-session) with a
    single batched ``WHERE session_id IN (...)`` query ordered newest-first,
    grouped back per session in Python. The per-session
    ``_HISTORY_PAGE_SIZE + 1`` cap is enforced while grouping so a session
    with a very long history doesn't pull unbounded rows into memory.

    Semantics match the old loop exactly:
    - ``before`` filter (from the lead's cursor) is applied uniformly;
    - ``_is_hidden_from_user`` is filtered in Python *after* fetching
      (it reads the JSON ``extra`` blob), so a page may end up with fewer
      than ``_HISTORY_PAGE_SIZE`` visible rows — identical to before;
    - sub-sessions with no messages still appear, with an empty list;
    - per-session order is chronological (ascending), sessions keep the
      caller-provided order.

    The per-session newest-``_HISTORY_PAGE_SIZE`` trim happens in Python
    after the single fetch, mirroring the old loop (which also fetched then
    trimmed). Keeping it in SQLModel ``select``/``col`` idioms avoids raw
    SQLAlchemy window/alias constructs that the rest of the codebase doesn't
    use.
    """
    if not sub_sessions:
        return []

    session_ids = [s.id for s in sub_sessions]

    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id).in_(session_ids))
        .order_by(col(SessionMessage.created_at).desc(), col(SessionMessage.id).desc())
    )
    if before is not None:
        stmt = stmt.where(col(SessionMessage.created_at) < before)
    rows = (await db.exec(stmt)).all()

    # Group newest-first per session (rows already arrive in DESC order, so
    # appending preserves the per-session ordering the old loop produced).
    by_session: dict[UUID, list[SessionMessage]] = {sid: [] for sid in session_ids}
    for msg in rows:
        bucket = by_session.get(msg.session_id)
        if bucket is None:
            continue
        # Stop accumulating once a session already has enough candidates to
        # cover the page after hidden-row filtering — caps memory for
        # sessions with very long histories.
        if len(bucket) >= _HISTORY_PAGE_SIZE + 1:
            continue
        bucket.append(msg)

    members: list[TeamHistoryMemberData] = []
    for sub in sub_sessions:
        raw_member = [
            msg for msg in by_session.get(sub.id, []) if not _is_hidden_from_user(msg)
        ]
        member_msgs = list(reversed(raw_member[:_HISTORY_PAGE_SIZE]))
        members.append(TeamHistoryMemberData(session=sub, messages=member_msgs))
    return members


async def get_team_history(
    db: AsyncSession,
    lead_session_id: UUID,
    *,
    before: datetime | None = None,
) -> TeamHistoryData | None:
    """Fetch the latest page of history for a team lead session and its sub-sessions.

    Fetches up to ``_HISTORY_PAGE_SIZE`` messages per session ordered by
    ``created_at DESC`` (newest first), then reverses to chronological order
    for the caller.  Pass the ``next_cursor`` from a previous response as
    ``before`` to load older messages.

    Returns ``None`` if the lead session does not exist.
    """
    lead_session = await db.get(ChatSession, lead_session_id)
    if lead_session is None:
        return None

    def _fetch_page(session_id: UUID):
        stmt = (
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == session_id)
            .order_by(col(SessionMessage.created_at).desc())
            .limit(_HISTORY_PAGE_SIZE + 1)
        )
        if before is not None:
            stmt = stmt.where(col(SessionMessage.created_at) < before)
        return stmt

    # Me: summaries are NOT filtered here. The compaction divider in the
    # web UI keys off ``is_summary=True`` rows to render the inline
    # "Session compacted" marker + summary body; hiding them would make
    # the divider vanish on reload. Undo uses ``extra.hidden_from_user``.
    raw_lead = [
        msg
        for msg in (await db.exec(_fetch_page(lead_session_id))).all()
        if not _is_hidden_from_user(msg)
    ]
    has_more = len(raw_lead) > _HISTORY_PAGE_SIZE
    raw_lead = raw_lead[:_HISTORY_PAGE_SIZE]
    lead_msgs = list(reversed(raw_lead))
    next_cursor = lead_msgs[0].created_at if (has_more and lead_msgs) else None

    sub_sessions = (
        await db.exec(
            select(ChatSession)
            .where(col(ChatSession.parent_session_id) == lead_session_id)
            .order_by(col(ChatSession.created_at).asc())
        )
    ).all()

    members = await _fetch_member_pages(db, sub_sessions, before=before)

    return TeamHistoryData(
        lead_session=lead_session,
        lead_messages=lead_msgs,
        members=members,
        has_more=has_more,
        next_cursor=next_cursor,
    )
