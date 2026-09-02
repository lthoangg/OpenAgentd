"""Checkpointer protocol and implementations for agent state persistence.

A :class:`Checkpointer` is responsible for two operations:

* **load** — reconstruct an :class:`~app.agent.state.AgentState` from durable
  storage at the start of a run.
* **sync** — flush any new messages from the live :class:`~app.agent.state.AgentState`
  to durable storage during or after a run.

Two implementations are provided:

* :class:`InMemoryCheckpointer` — dict-backed, zero dependencies, suitable for
  unit tests and single-process development.
* :class:`SQLiteCheckpointer` — persists via the application's async SQLAlchemy
  session factory; production-grade.
"""

from __future__ import annotations

import copy
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING
from uuid import UUID

import sqlalchemy as sa
from loguru import logger
from sqlmodel import col

from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from app.agent.state import AgentState, RunContext
from app.models.chat import SEQ_STEP, SessionMessage
from app.services.chat_service import (
    bump_history_revision,
    get_history_cursor,
    get_history_revision,
    get_messages_for_llm,
    next_seq,
    save_message,
    seq_before_row,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from sqlmodel.ext.asyncio.session import AsyncSession


# ── Helpers ───────────────────────────────────────────────────────────────────


def _last_prompt_tokens_from_history(history: list[ChatMessage]) -> int:
    """Return input token count from the most recent assistant message in *history*.

    Used by :meth:`SQLiteCheckpointer.load` to seed
    ``AgentState.usage.last_prompt_tokens`` on session resume so that
    :class:`~app.agent.hooks.SummarizationHook` can fire correctly without
    any call-site workaround.

    Scans in reverse so the most-recent usage wins.  Returns ``0`` when no
    usage metadata is found (fresh session or provider didn't report tokens).

    Summary rows are skipped: they carry the *summariser call's* usage (kept
    for cost accounting), whose ``input`` is the pre-compaction context size.
    Seeding from it would tell the SummarizationHook the context is still over
    threshold and re-compact an already-compacted session on the next turn.
    """
    for msg in reversed(history):
        if getattr(msg, "is_summary", False):
            continue
        usage = (getattr(msg, "extra", None) or {}).get("usage")
        if usage and isinstance(usage.get("input"), int):
            return usage["input"]
    return 0


def _summary_anchor_ids(
    messages: list[ChatMessage], persisted_ids: set[int]
) -> dict[int, UUID]:
    """Map each unpersisted summary to the stored row it must sort ahead of.

    :class:`~app.agent.hooks.SummarizationHook` *inserts* its summary into the
    middle of ``state.messages`` — directly before the window it kept verbatim —
    but a fresh row takes the next append ``seq`` and would therefore sort
    after that whole window. The summary's position *is* its compaction
    boundary in the derived model, so it must be anchored before the first
    kept row of the contiguous tail: pick the first persisted row after the
    summary that is still in the window (not excluded) and not pinned —
    pinned rows are scattered retained rows that live *below* the boundary
    by design.

    Keyed by ``id(msg)`` so :meth:`SQLiteCheckpointer.sync` can look the anchor
    up while iterating its own filtered list of new messages.
    """
    anchors: dict[int, UUID] = {}
    for idx, msg in enumerate(messages):
        if not msg.is_summary or id(msg) in persisted_ids:
            continue
        anchor = next(
            (
                m.db_id
                for m in messages[idx + 1 :]
                if m.db_id is not None and not m.exclude_from_context and not m.pinned
            ),
            None,
        )
        if anchor is not None:
            anchors[id(msg)] = anchor
    return anchors


async def _resolve_summary_seqs(
    db: "AsyncSession", anchors: dict[int, UUID]
) -> dict[int, int]:
    """Turn anchor row ids into the ``seq`` each summary should take.

    The midpoint of the gap before the anchor row: sorts ahead of the kept
    tail, behind everything the summary covers.
    """
    resolved: dict[int, int] = {}
    for key, anchor_id in anchors.items():
        row = await db.get(SessionMessage, anchor_id)
        if row is not None:
            resolved[key] = await seq_before_row(db, row.session_id, row)
    return resolved


# ── Base class ────────────────────────────────────────────────────────────────


class Checkpointer(ABC):
    """Abstract base for loading and persisting agent state.

    Subclass this to implement a custom checkpointer.  Only :meth:`load`
    and :meth:`sync` are required; :meth:`seed_state` is optional and
    defaults to a no-op.
    """

    @abstractmethod
    async def load(self, session_id: str) -> AgentState | None:
        """Load persisted state for *session_id*.

        Returns ``None`` when no prior state exists (fresh session).
        """

    @abstractmethod
    async def sync(self, ctx: RunContext, state: AgentState) -> None:
        """Persist any new messages in *state* to durable storage.

        Called by the agent loop after each model turn and at run completion.
        Implementations must be idempotent — calling sync twice with the same
        state must not produce duplicate rows.
        """

    def seed_state(self, session_id: str, state: AgentState) -> None:
        """Seed ``state.usage.last_prompt_tokens`` from loaded history.

        Called by the agent loop right after building the initial
        :class:`~app.agent.state.AgentState` so that
        :class:`~app.agent.hooks.SummarizationHook` fires correctly on
        session resume.  Default is a no-op — override only when the
        checkpointer has persisted token counts to restore.
        """


# ── In-memory (tests / dev) ───────────────────────────────────────────────────


class InMemoryCheckpointer(Checkpointer):
    """Dict-backed checkpointer. No I/O — safe for unit tests.

    Stores a deep copy of the message list on every :meth:`sync` so that
    subsequent mutations to the live state do not corrupt the stored snapshot.
    """

    def __init__(self) -> None:
        # Me keep states in plain dict — simple and fast
        self._store: dict[str, AgentState] = {}

    async def load(self, session_id: str) -> AgentState | None:
        """Return a copy of the stored state, or ``None`` if not found."""
        stored = self._store.get(session_id)
        if stored is None:
            return None

        # Me deep-copy messages so caller can mutate freely
        return AgentState(
            messages=copy.deepcopy(stored.messages),
            system_prompt=stored.system_prompt,
        )

    async def sync(self, ctx: RunContext, state: AgentState) -> None:
        """Snapshot current state into the dict store."""
        # Me store copy so future mutations no corrupt snapshot
        self._store[ctx.session_id or ""] = AgentState(
            messages=copy.deepcopy(state.messages),
            system_prompt=state.system_prompt,
        )
        logger.debug(
            "in_memory_checkpoint_synced session_id={} message_count={}",
            ctx.session_id,
            len(state.messages),
        )


# ── SQLite (production) ───────────────────────────────────────────────────────


class SQLiteCheckpointer(Checkpointer):
    """Async SQLAlchemy-backed checkpointer for production use.

    Tracks which message objects have already been written to the DB using a
    set of object ids (``id(msg)``).  On each :meth:`sync` call only *new*
    messages are inserted, making the operation safe to call repeatedly within
    a single run.

    Additionally handles the ``exclude_from_context`` transition: if a message
    that was previously persisted now has ``exclude_from_context=True`` (set by
    :class:`~app.agent.hooks.SummarizationHook`), the corresponding DB row is
    updated via ``exclude_from_context=True``.

    Args:
        session_factory: An ``async_sessionmaker[AsyncSession]`` produced by
            the application's database setup (``app.core.db``).
        stream_session_id: Optional session id used to address the shared SSE
            stream store.  Together with *agent_name*, this lets ``sync()``
            call ``stream_store.commit_agent_content`` after persisting an
            assistant message so the replay buffer does not duplicate content
            that is already in the DB. This is the chat session id. When
            ``None`` the cleanup step is skipped.
        agent_name: Optional agent name that owns messages persisted through
            this checkpointer.  Required together with *stream_session_id*.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        stream_session_id: str | None = None,
        agent_name: str | None = None,
    ) -> None:
        self._session_factory = session_factory
        # Me track persisted message object ids — key: session_id
        self._persisted: dict[str, set[int]] = {}
        # Me store seeded prompt tokens per session — set by mark_loaded(), read by seed_state()
        self._seeded_tokens: dict[str, int] = {}
        # Me stream cleanup target — see class docstring.  Both must be set
        # for cleanup to fire; either one missing means we do not know which
        # bucket to drop so we leave the state blob alone.
        self._stream_session_id = stream_session_id
        self._agent_name = agent_name
        self._loaded: dict[str, AgentState] = {}
        self._loaded_revision: dict[str, tuple[int, int]] = {}
        self._loaded_cursor: dict[str, tuple[int, UUID] | None] = {}
        # Last pinned state flushed to (or loaded from) the DB per row —
        # sync() only issues UPDATEs for rows whose in-memory ``pinned``
        # diverged, so a settled conversation writes nothing.
        self._flushed_pinned: dict[str, dict[UUID, bool]] = {}

    def mark_loaded(self, session_id: str, messages: list[ChatMessage]) -> None:
        """Register *messages* as already persisted in the DB.

        Call this right after loading history from the database (via
        ``get_messages_for_llm``) and **before** ``agent.run()``.  This
        prevents ``sync()`` from re-inserting messages that were loaded
        from the DB — they have new Python ``id()`` values but are
        already stored.

        Also computes and stores the seeded prompt token count from the
        most-recent assistant message so :meth:`seed_state` can apply it.
        """
        ids = self._persisted.setdefault(session_id, set())
        pinned = self._flushed_pinned.setdefault(session_id, {})
        for msg in messages:
            ids.add(id(msg))
            if msg.db_id is not None:
                pinned.setdefault(msg.db_id, msg.pinned)
        # Me compute token seed — only overwrite if we find actual usage.
        # A second call (e.g. for the current user message) must not zero out
        # the value seeded by the first call (history with assistant usage).
        tokens = _last_prompt_tokens_from_history(messages)
        if tokens > 0:
            self._seeded_tokens[session_id] = tokens
        logger.debug(
            "checkpointer_mark_loaded session_id={} count={} seeded_prompt_tokens={}",
            session_id,
            len(messages),
            self._seeded_tokens.get(session_id, 0),
        )

    def invalidate(self, session_id: str) -> None:
        """Drop cached history after an external database mutation."""
        self._loaded.pop(session_id, None)
        self._loaded_revision.pop(session_id, None)
        self._loaded_cursor.pop(session_id, None)

    def seed_state(self, session_id: str, state: "AgentState") -> None:
        """Seed ``state.usage.last_prompt_tokens`` from loaded history.

        Call this right after ``agent.run()`` builds the initial
        :class:`~app.agent.state.AgentState` — or, more precisely, the agent
        loop calls this **before** the first ``before_model`` so that
        :class:`~app.agent.hooks.SummarizationHook` can fire on session resume
        without any call-site workaround.

        Safe to call even when no tokens were found — defaults to ``0``.
        """
        tokens = self._seeded_tokens.get(session_id, 0)
        if tokens > 0:
            state.usage.last_prompt_tokens = tokens
            logger.debug(
                "checkpointer_seed_state session_id={} last_prompt_tokens={}",
                session_id,
                tokens,
            )

    async def load(self, session_id: str) -> AgentState | None:
        """Load the LLM context window from the database.

        Calls :func:`~app.services.chat_service.get_messages_for_llm` which
        applies the summary-window strategy (latest summary + recent messages).

        Seeds ``state.usage.last_prompt_tokens`` from the last assistant
        message's ``extra.usage.input`` so :class:`SummarizationHook` fires
        correctly on session resume without any hook-level workaround.

        Returns ``None`` when the session has no messages yet.
        """
        logger.debug("checkpointer_load session_id={}", session_id)
        async with self._session_factory() as db:
            revision = await get_history_revision(db, UUID(session_id))
            cursor = await get_history_cursor(db, UUID(session_id))
            cached = self._loaded.get(session_id)
            if (
                cached is not None
                and self._loaded_revision.get(session_id) == revision
                and self._loaded_cursor.get(session_id) == cursor
            ):
                return AgentState(messages=copy.deepcopy(cached.messages))

            # Keep revision/cursor/window reads on one checked-out connection.
            # The old two-context shape paid a second pool checkout and could
            # label a window loaded after a concurrent write with the cursor
            # observed before it, causing one needless cache miss next load.
            messages = await get_messages_for_llm(db, UUID(session_id))

        if not messages:
            logger.debug("checkpointer_load_empty session_id={}", session_id)
            return None

        # Me auto-register loaded messages + compute seed tokens via mark_loaded()
        self.mark_loaded(session_id, messages)
        self._loaded[session_id] = AgentState(messages=copy.deepcopy(messages))
        self._loaded_revision[session_id] = revision
        self._loaded_cursor[session_id] = cursor

        seeded_tokens = self._seeded_tokens.get(session_id, 0)
        logger.debug(
            "checkpointer_load_ok session_id={} count={} seeded_prompt_tokens={}",
            session_id,
            len(messages),
            seeded_tokens,
        )
        state = AgentState(messages=messages)
        self.seed_state(session_id, state)
        return state

    async def sync(self, ctx: RunContext, state: AgentState) -> None:
        """Persist new messages and flush ``pinned`` flag changes.

        Rules
        -----
        * ``AssistantMessage`` — saved with ``extra`` and its kind.
        * ``ToolMessage`` — saved with defaults.
        * ``SystemMessage`` / ``HumanMessage`` — skipped (human messages are
          saved by the route handler; system messages are never persisted).
        * Compaction never rewrites history: exclusion is derived from the
          summary row's anchored ``seq`` (see :func:`_summary_anchor_ids`).
          The only per-row updates are ``pinned`` flips for the handful of
          retained skill pairs, and only when they actually changed.
        """
        sid = ctx.session_id or ""
        # Me init tracking sets for this session on first sync
        if sid not in self._persisted:
            self._persisted[sid] = set()

        persisted_ids = self._persisted[sid]

        # Me split messages into new vs already-seen
        new_messages = [m for m in state.messages if id(m) not in persisted_ids]
        seen_messages = [m for m in state.messages if id(m) in persisted_ids]

        if not new_messages and not seen_messages:
            return

        # ── Diff pinned flags on already-persisted messages ────────────────
        # SummarizationHook pins retained skill pairs and unpins rows it
        # compacts away. Only rows whose flag actually diverged from what the
        # DB holds are updated, so a settled conversation writes nothing.
        flushed_pinned = self._flushed_pinned.setdefault(sid, {})
        pin_updates: dict[UUID, bool] = {}
        for msg in seen_messages:
            if isinstance(msg, SystemMessage) or msg.db_id is None:
                continue
            if flushed_pinned.get(msg.db_id, False) != msg.pinned:
                pin_updates[msg.db_id] = msg.pinned

        summary_anchors = _summary_anchor_ids(state.messages, persisted_ids)

        # NOTE: the stream-buffer commit further down must still run on a no-op
        # sync, so this guards only the DB work — it is deliberately not an
        # early return.
        if new_messages or pin_updates:
            async with self._session_factory() as db:
                async with db.begin():
                    anchored_seq = await _resolve_summary_seqs(db, summary_anchors)

                    # Allocate the append tail once for the whole flush;
                    # per-row MAX(seq) pre-selects would put a redundant
                    # query on the hottest write path in the app. Lazy so a
                    # flush of only anchored/skipped rows allocates nothing.
                    tail: int | None = None

                    async def _next_tail() -> int:
                        nonlocal tail
                        if tail is None:
                            tail = await next_seq(db, UUID(sid))
                        else:
                            tail += SEQ_STEP
                        return tail

                    for flag in (True, False):
                        ids = [k for k, v in pin_updates.items() if v is flag]
                        if not ids:
                            continue
                        await db.exec(
                            sa.update(SessionMessage)
                            .where(col(SessionMessage.id).in_(ids))
                            .values(pinned=flag)
                        )
                    if pin_updates:
                        flushed_pinned.update(pin_updates)
                        logger.debug(
                            "checkpointer_pinned_flags_updated session_id={} count={}",
                            sid,
                            len(pin_updates),
                        )

                    # ── Persist new messages ──────────────────────────────────────────
                    # Rows are added without per-row flushes (``flush=False``)
                    # and flushed once after the loop: ids are client-side
                    # uuid7, so nothing needs an early flush, and one
                    # executemany beats N round-trips on the hottest write
                    # path in the app.
                    saved_summary = False
                    for msg in new_messages:
                        if isinstance(msg, AssistantMessage):
                            # Skip empty assistant messages (e.g. interrupted before
                            # any content was generated).
                            has_content = bool(
                                (msg.content and msg.content.strip())
                                or (
                                    msg.reasoning_content
                                    and msg.reasoning_content.strip()
                                )
                                or msg.tool_calls
                                or msg.reasoning_encrypted_content
                                or msg.is_summary
                            )
                            if not has_content:
                                logger.debug(
                                    "checkpointer_skip_empty_assistant session_id={}",
                                    sid,
                                )
                                continue
                            seq = anchored_seq.get(id(msg))
                            row = await save_message(
                                db,
                                UUID(sid),
                                msg,
                                is_summary=msg.is_summary,
                                pinned=msg.pinned,
                                extra=msg.extra,
                                seq=seq if seq is not None else await _next_tail(),
                                flush=False,
                            )
                            msg.db_id = row.id
                            saved_summary = saved_summary or msg.is_summary
                        elif isinstance(msg, ToolMessage):
                            row = await save_message(
                                db,
                                UUID(sid),
                                msg,
                                pinned=msg.pinned,
                                extra=msg.extra,
                                seq=await _next_tail(),
                                flush=False,
                            )
                            msg.db_id = row.id
                        elif isinstance(msg, HumanMessage):
                            if msg.is_summary or (
                                msg.extra and msg.extra.get("hidden_from_user")
                            ):
                                # Me save summary or hidden HumanMessages (e.g. truncation recovery)
                                seq = anchored_seq.get(id(msg))
                                row = await save_message(
                                    db,
                                    UUID(sid),
                                    msg,
                                    is_summary=msg.is_summary,
                                    pinned=msg.pinned,
                                    extra=msg.extra,
                                    seq=seq if seq is not None else await _next_tail(),
                                    flush=False,
                                )
                                msg.db_id = row.id
                                saved_summary = saved_summary or msg.is_summary
                                logger.debug(
                                    "checkpointer_saved_hidden_human session_id={} db_id={}",
                                    sid,
                                    row.id,
                                )
                            # Me real user messages already saved by route handler — skip
                        else:
                            logger.debug(
                                "checkpointer_skip_role session_id={} role={}",
                                sid,
                                msg.role,
                            )
                            continue

                        persisted_ids.add(id(msg))
                        if msg.db_id is not None:
                            flushed_pinned[msg.db_id] = msg.pinned
                    await db.flush()
                    if pin_updates or saved_summary:
                        await bump_history_revision(db, UUID(sid), structural=True)

        # Me drop this agent's stream buffer — once the assistant text is in
        # the DB, a mid-turn reconnect loading it via loadSession must not
        # also replay it from the in-flight state blob.  Import here to
        # avoid a circular import at module load time.
        if self._stream_session_id and self._agent_name:
            from app.services import memory_stream_store as stream_store

            await stream_store.commit_agent_content(
                self._stream_session_id, self._agent_name
            )

        # Only report syncs that actually wrote something.  ``sync`` is called
        # on every agent step, and in production most calls had nothing new to
        # persist — those no-op lines were the single largest DEBUG source
        # (7.9k lines / 2 days) while carrying no information.  The per-message
        # ``saved_assistant`` / ``saved_tool`` lines are gone too; ``new`` and
        # ``total_persisted`` summarise the same outcome, and ``db_id`` values
        # are recoverable from the session's message rows.
        if new_messages or pin_updates:
            self.invalidate(sid)
        if new_messages:
            logger.debug(
                "checkpointer_sync_done session_id={} new={} total_persisted={}",
                sid,
                len(new_messages),
                len(persisted_ids),
            )
