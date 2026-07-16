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
from app.models.chat import SessionMessage
from app.services.chat_service import get_messages_for_llm, save_message

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
    """
    for msg in reversed(history):
        usage = (getattr(msg, "extra", None) or {}).get("usage")
        if usage and isinstance(usage.get("input"), int):
            return usage["input"]
    return 0


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
            that is already in the DB.  In team mode this is the **lead's**
            session id (not the member's); in single-agent chat it would be
            the chat session id.  When ``None`` the cleanup step is skipped.
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
        for msg in messages:
            ids.add(id(msg))
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
            messages = await get_messages_for_llm(db, UUID(session_id))

        if not messages:
            logger.debug("checkpointer_load_empty session_id={}", session_id)
            return None

        # Me auto-register loaded messages + compute seed tokens via mark_loaded()
        self.mark_loaded(session_id, messages)

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
        """Persist new messages and propagate ``exclude_from_context`` changes.

        Rules
        -----
        * ``AssistantMessage`` — saved with ``extra``, ``is_summary``, and
          ``exclude_from_context``.
        * ``ToolMessage`` — saved with defaults.
        * ``SystemMessage`` / ``HumanMessage`` — skipped (human messages are
          saved by the route handler; system messages are never persisted).
        * Already-persisted messages whose ``exclude_from_context`` flipped to
          ``True`` are updated in the DB (``exclude_from_context=True``).
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

        async with self._session_factory() as db:
            async with db.begin():
                # ── Update exclude_from_context on already-persisted messages ─────
                # One-way conditional UPDATE avoids re-reading every tracked row.
                exclude_ids = [
                    msg.db_id
                    for msg in seen_messages
                    if not isinstance(msg, SystemMessage)
                    and msg.exclude_from_context
                    and msg.db_id is not None
                ]
                if exclude_ids:
                    stmt = (
                        sa.update(SessionMessage)
                        .where(col(SessionMessage.id).in_(exclude_ids))
                        .where(col(SessionMessage.exclude_from_context).is_(False))
                        .values(exclude_from_context=True)
                    )
                    await db.exec(stmt)
                    logger.debug(
                        "checkpointer_exclude_flags_updated session_id={} count={}",
                        sid,
                        len(exclude_ids),
                    )

                # ── Persist new messages ──────────────────────────────────────────
                for msg in new_messages:
                    if isinstance(msg, AssistantMessage):
                        # Skip empty assistant messages (e.g. interrupted before
                        # any content was generated).
                        has_content = bool(
                            (msg.content and msg.content.strip())
                            or (msg.reasoning_content and msg.reasoning_content.strip())
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
                        row = await save_message(
                            db,
                            UUID(sid),
                            msg,
                            is_summary=msg.is_summary,
                            exclude_from_context=msg.exclude_from_context,
                            extra=msg.extra,
                        )
                        msg.db_id = row.id
                        logger.debug(
                            "checkpointer_saved_assistant session_id={} db_id={} is_summary={} exclude={}",
                            sid,
                            row.id,
                            msg.is_summary,
                            msg.exclude_from_context,
                        )
                    elif isinstance(msg, ToolMessage):
                        row = await save_message(db, UUID(sid), msg, extra=msg.extra)
                        msg.db_id = row.id
                        logger.debug(
                            "checkpointer_saved_tool session_id={} db_id={} tool={}",
                            sid,
                            row.id,
                            msg.name,
                        )
                    elif isinstance(msg, HumanMessage):
                        if msg.is_summary or (
                            msg.extra and msg.extra.get("hidden_from_user")
                        ):
                            # Me save summary or hidden HumanMessages (e.g. truncation recovery)
                            row = await save_message(
                                db,
                                UUID(sid),
                                msg,
                                is_summary=msg.is_summary,
                                exclude_from_context=msg.exclude_from_context,
                                extra=msg.extra,
                            )
                            msg.db_id = row.id
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

        # Me drop this agent's stream buffer — once the assistant text is in
        # the DB, a mid-turn reconnect loading it via loadSession must not
        # also replay it from the in-flight state blob.  Import here to
        # avoid a circular import at module load time.
        if self._stream_session_id and self._agent_name:
            from app.services import memory_stream_store as stream_store

            await stream_store.commit_agent_content(
                self._stream_session_id, self._agent_name
            )

        logger.debug(
            "checkpointer_sync_done session_id={} new={} total_persisted={}",
            sid,
            len(new_messages),
            len(persisted_ids),
        )
