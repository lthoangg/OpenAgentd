"""``SessionRuntime`` — the runtime that owns one chat session.

One session has exactly one agent. This object holds that agent, its inbox,
its turn state, and the session-level commands the API exposes
(send / compact / undo / redo / stop) so that a turn's invariants live in one
place rather than being split across a coordinator and a worker.

Agents do not run persistent background loops. When a message is delivered,
``_maybe_activate()`` spawns a single ``asyncio.Task`` that drains the inbox,
calls ``agent.run()``, and returns to ``idle``.

Streaming is handled by ``StreamPublisherHook``, which pushes every LLM delta
to the shared in-memory stream store keyed by this session id.
"""

from __future__ import annotations

import asyncio
import copy
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from uuid import UUID, uuid7

from loguru import logger
from sqlmodel import col, select

from app.agent.agent_loop import Agent
from app.agent.checkpointer import SQLiteCheckpointer
from app.agent.denied_paths import (
    DeniedPathsConfig,
    _denied_paths_ctx,
    set_denied_paths,
)
from app.agent.drift import detect_drift, stamp_agent_files
from app.agent.hooks.base import BaseAgentHook
from app.agent.hooks.dynamic_prompt import inject_current_date
from app.agent.hooks.otel import OpenTelemetryHook
from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.hooks.summarization import build_summarization_hook
from app.agent.hooks.title_generation import build_title_generation_hook
from app.agent.hooks.tool_result_offload import ToolResultOffloadHook
from app.agent.hooks.workspace_instructions import WorkspaceInstructionsHook
from app.agent.mode.team.hooks.queued_injection import QueuedMessageInjectionHook
from app.agent.mode.team.hooks.team_inbox import TeamInboxHook
from app.agent.mode.team.hooks.team_prompt import SessionRuntimeProtocolHook
from app.agent.mode.team.mailbox import Message
from app.agent.mode.team.question import make_ask_user_tool
from app.agent.permission import (
    AutoAllowPermissionService,
    set_permission_service,
    _permission_ctx,
)
from app.agent.plugins.role import reset_role, set_role
from app.agent.schemas.agent import RunConfig
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    HumanMessage,
    ToolMessage,
)
from app.agent.schemas.events import DoneEvent
from app.agent.tools.registry import Tool
from app.core.db import DbFactory, resolve_db_factory
from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession, SessionMessage
from app.services import event_broadcaster, memory_stream_store as stream_store
from app.services import snapshot_service
from app.services.stream_envelope import StreamEnvelope
from app.services.chat_service import (
    BoundaryShift,
    cleanup_reverted_tail,
    get_history_cursor,
    get_history_revision,
    get_messages_for_llm,
    get_messages_for_llm_after,
    heal_orphaned_tool_calls,
    pop_queued_user_messages,
    redo_all_session_messages,
    redo_session_messages,
    save_message,
    undo_session_messages,
)

if TYPE_CHECKING:
    from app.agent.providers.base import LLMProviderBase
    from app.agent.providers.factory import ProviderFactory
    from app.services import question_service


#: Bound on the inbox backlog. Generous for normal operation (a healthy agent
#: drains its inbox almost immediately) while capping memory if the agent is
#: stalled or erroring and never drains.
_MAX_INBOX_BACKLOG = 500


async def _close_provider(provider: "LLMProviderBase") -> None:
    try:
        await provider.aclose()
    except Exception as exc:
        logger.warning("provider_close_failed provider={} error={}", provider, exc)


def _schedule_provider_close(provider: "LLMProviderBase") -> None:
    try:
        asyncio.get_running_loop().create_task(_close_provider(provider))
    except RuntimeError:
        logger.warning("provider_close_skipped_no_running_loop provider={}", provider)


def _provider_supports_prompt_cache_key(provider_id: str) -> bool:
    """Whether ``provider_id`` (e.g. ``"grok"``, ``"codex"``) honours
    ``prompt_cache_key`` — looked up from the provider catalog rather than
    hardcoded here, so this stays in sync with
    :data:`app.agent.providers.catalog.ProviderEntry.supports_prompt_cache_key`
    (e.g. xAI/Codex route requests sharing a cache key to the same backend
    server, which is required to hit their per-server prefix KV cache — see
    https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).
    """
    if not provider_id:
        return False
    from app.agent.providers.catalog import find as find_provider

    entry = find_provider(provider_id)
    return bool(entry and entry.get("supports_prompt_cache_key", False))


# -- Protocol prompt blocks (shared by build_protocol) -------------------------

AGENT_COMMUNICATION_RULES = """\
## Communication protocol
- Plain text is user-visible: use it only for the final answer or one brief progress note after delegation.
- Handle small, quick, self-contained tasks yourself; delegate only when role fit, parallelism, context isolation, or a sustained workstream justifies the latency.
- Format responses in **Markdown**. No emoji."""


# -- Helpers -------------------------------------------------------------------

#: Agent states that mean "this agent owns an open turn — do not start another".
#:
#: ``waiting_input`` is a suspended agent: no coroutine is running, but the turn
#: is half-finished and its conversation ends in a placeholder tool result. Any
#: activation started on top of it would feed that placeholder to the model.
#: Every busy-check goes through :func:`is_busy` so adding a state here reaches
#: all of them at once, rather than a dozen scattered ``== "working"`` literals.
BUSY_STATES: frozenset[str] = frozenset({"working", "waiting_input"})


def is_busy(state: str) -> bool:
    """Return whether *state* means the agent already owns an open turn."""
    return state in BUSY_STATES


class AlreadyWorkingError(Exception):
    """Raised by :meth:`SessionRuntime.activate_for_continuation` when the
    target agent is already running a turn.

    Carries the agent name so callers can build a useful error message.
    Caught by :meth:`SessionRuntime.handle_continue` and translated to a
    ``ContinuePreconditionError`` (HTTP 409).
    """

    def __init__(self, agent_name: str) -> None:
        super().__init__(
            f"Cannot continue while {agent_name} is working — "
            "wait for the current turn to finish."
        )
        self.agent_name = agent_name


async def _mark_last_assistant_interrupted(
    db_factory: DbFactory, session_id: uuid.UUID
) -> None:
    """Stamp ``extra["interrupted"] = True`` on the most recent assistant row.

    Used by ``_run_activation`` when the active turn was cancelled (user
    pressed Stop, server shutdown, etc.).  Older revisions of this code
    appended a literal ``" [interrupted]"`` string to ``content``; that
    leaked into the next turn's LLM prompt and caused ``/continue`` to
    restart instead of resuming.  The flag now rides on ``extra`` (which is
    excluded from LLM serialisation via ``BaseMessage.extra``'s
    ``Field(exclude=True)``) so the marker is invisible to the LLM but
    still available to the frontend and audit tooling.
    """
    try:
        async with db_factory() as db:
            stmt = (
                select(SessionMessage)
                .where(col(SessionMessage.session_id) == session_id)
                .where(col(SessionMessage.role) == "assistant")
                .order_by(col(SessionMessage.created_at).desc())
                .limit(1)
            )
            result = await db.exec(stmt)
            msg = result.first()
            if msg is not None:
                existing = msg.extra or {}
                msg.extra = {**existing, "interrupted": True}
                db.add(msg)
                await db.commit()
    except Exception as exc:
        logger.warning(
            "mark_interrupted_failed session_id={} error={}", session_id, exc
        )


# =============================================================================
# SessionRuntime — the session's agent runtime
# =============================================================================


class QuestionPendingError(Exception):
    """Raised when a machine-originated message arrives during a live question."""

    def __init__(self, session_id: str) -> None:
        super().__init__(
            f"Session {session_id} is waiting on a user answer; try again later."
        )
        self.session_id = session_id


class ContinuePreconditionError(Exception):
    """Raised when ``/continue`` is requested on a session that can't be continued."""

    def __init__(self, reason: str, *, status: int = 409) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


_command_locks: dict[str, asyncio.Lock] = {}


def _command_lock(session_id: str) -> asyncio.Lock:
    """Return the (lazily-created) per-session command lock."""
    lock = _command_locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _command_locks[session_id] = lock
    return lock


def _is_interrupted_thinking_only_tail(messages: list[ChatMessage]) -> bool:
    """Return true for a stopped assistant row that has no visible output."""
    if not messages:
        return False
    last = messages[-1]
    return (
        isinstance(last, AssistantMessage)
        and not (last.content and last.content.strip())
        and not last.tool_calls
        and bool(last.extra and last.extra.get("interrupted"))
    )


def _tool_tail_has_matching_assistant_call(messages: list[ChatMessage]) -> bool:
    """A trailing tool result is continuable only if a prior assistant called it."""
    if not messages or not isinstance(messages[-1], ToolMessage):
        return False
    tool_call_id = messages[-1].tool_call_id
    if not tool_call_id:
        return False
    for msg in reversed(messages[:-1]):
        if not isinstance(msg, AssistantMessage):
            continue
        return any(tc.id == tool_call_id for tc in msg.tool_calls or [])
    return False


class SessionRuntime:
    """The agent, inbox, and turn state for a single chat session."""

    def __init__(
        self,
        agent: Agent,
        *,
        session_id: str | None = None,
        db_factory: DbFactory | None = None,
        provider_factory: "ProviderFactory | None" = None,
        extra_tools: dict[str, Tool] | None = None,
        workspace: str | None = None,
    ) -> None:
        self.name = agent.name
        self.agent = agent
        self.session_id: str = session_id or str(uuid7())
        self.db_factory = db_factory
        self.workspace = workspace
        self._provider_factory = provider_factory
        self._extra_tools = extra_tools

        self.state: Literal["idle", "working", "waiting_input", "error"] = "idle"
        # Set by ``_handle_messages`` when ``ask_user`` suspended the
        # turn; read by ``_run_activation``'s finally block so the agent parks
        # in ``waiting_input`` instead of going idle.
        self._question_suspended: dict | None = None
        # True when this session belongs to the scheduler — nobody is there to
        # answer a question, so the tool is never injected.
        self.is_scheduler_session: bool = False
        self.is_child_session: bool = False
        self.parent_session_id: str | None = None
        self.spawn_depth: int = 0
        self._cancel_event = asyncio.Event()
        self._active_task: asyncio.Task | None = None

        # Drift flag set at end-of-turn; next turn rebuilds the agent.
        self._config_dirty: bool = False

        # Track tokens across all turns
        self.usage: dict[str, int] = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "cached_tokens": 0,
        }

        self._inbox: asyncio.Queue[Message] = asyncio.Queue()
        self._has_active_turn: bool = False
        self._user_message_lock = asyncio.Lock()
        self._llm_history: list[ChatMessage] = []
        self._llm_history_revision: tuple[int, int] | None = None
        self._llm_history_cursor: tuple[int, uuid.UUID] | None = None

    # ------------------------------------------------------------------
    # Inbox
    # ------------------------------------------------------------------

    async def deliver(self, message: Message) -> None:
        """Queue *message* for this session's agent and wake it if idle.

        The queue is unbounded so delivery never blocks the sender; past
        ``_MAX_INBOX_BACKLOG`` the oldest pending message is dropped, which
        keeps memory bounded and favours the most recent context once a
        stalled agent recovers.
        """
        if self._inbox.qsize() >= _MAX_INBOX_BACKLOG:
            try:
                self._inbox.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self._inbox.put_nowait(message)
        self._maybe_activate()

    def inbox_empty(self) -> bool:
        """Return whether the inbox has no pending messages."""
        return self._inbox.empty()

    def discard_inbox(self) -> int:
        """Discard queued messages for an interrupted activation."""
        discarded = 0
        while True:
            try:
                self._inbox.get_nowait()
            except asyncio.QueueEmpty:
                return discarded
            discarded += 1

    async def start(self) -> None:
        """Start the runtime. The agent is idle until a message arrives."""
        self.state = "idle"

    async def _ensure_db_session(
        self,
        title: str | None = None,
        workspace: str | None = None,
    ) -> None:
        """Ensure a DB chat session row exists for self.session_id."""
        db_factory = resolve_db_factory(self.db_factory)
        session_uuid = uuid.UUID(self.session_id)
        try:
            async with db_factory() as db:
                existing = await db.get(ChatSession, session_uuid)
                if existing is not None:
                    if existing.parent_session_id is not None:
                        self.parent_session_id = str(existing.parent_session_id)
                        self.is_child_session = True
                        self.spawn_depth = 1
                        ancestor_id = existing.parent_session_id
                        visited = {session_uuid}
                        while ancestor_id not in visited and self.spawn_depth <= 10:
                            visited.add(ancestor_id)
                            ancestor = await db.get(ChatSession, ancestor_id)
                            if ancestor is None or ancestor.parent_session_id is None:
                                break
                            self.spawn_depth += 1
                            ancestor_id = ancestor.parent_session_id
                    else:
                        self.parent_session_id = None
                        self.is_child_session = False
                        self.spawn_depth = 0
                else:
                    row = ChatSession(
                        id=session_uuid,
                        title=title or f"Agent: {self.name}",
                        agent_name=self.name,
                        workspace=(workspace or (self.workspace or "") or ""),
                    )
                    db.add(row)
                    await db.commit()
                    logger.info(
                        "session_runtime_session_created name={} session_id={}",
                        self.name,
                        self.session_id,
                    )
        except Exception as e:
            logger.warning(
                "session_runtime_session_ensure_failed name={} error={}", self.name, e
            )

    async def stop(self) -> None:
        """Gracefully shut down: cancel any active task and deregister."""
        if self._active_task is not None and not self._active_task.done():
            self._cancel_event.set()
            self._active_task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(self._active_task), timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            self._active_task = None

        await _close_provider(self.agent.llm_provider)

        self.discard_inbox()
        self.state = "idle"
        logger.info("session_runtime_stopped name={}", self.name)

    def interrupt(self) -> None:
        """Cancel the current activation without deregistering the agent."""
        self._cancel_event.set()
        if self._active_task is not None and not self._active_task.done():
            self._active_task.cancel()

    # ------------------------------------------------------------------
    # On-demand activation
    # ------------------------------------------------------------------

    def _maybe_activate(self) -> None:
        """Spawn an activation task if the agent is not already working.

        Called by ``deliver`` when a message arrives. If the agent is already
        working, the message stays in the queue and ``TeamInboxHook`` injects
        it before the next LLM call.
        """
        if is_busy(self.state):
            # Working: the inbox hook drains the new message before the next
            # model call.  Suspended: it waits in the inbox until the user
            # answers, and is drained into the resumed turn.
            return

        # Me: set state synchronously before create_task so that any
        # _try_emit_done() call that follows in the same coroutine sees
        # "working" and does not fire a premature done event.
        self.state = "working"
        self._active_task = asyncio.create_task(
            self._run_activation(), name=f"activate:{self.name}"
        )

    def activate_for_compaction(self) -> None:
        """Spawn an activation task that forces summarization before the model call."""
        if is_busy(self.state):
            raise AlreadyWorkingError(self.name)
        self.state = "working"
        self._active_task = asyncio.create_task(
            self._run_activation(force_compaction=True),
            name=f"compact:{self.name}",
        )

    def activate_for_question_answer(self) -> None:
        """Resume a turn that was suspended by ``ask_user``.

        Runs on existing DB history exactly like ``/continue``: by the time
        this is called the placeholder tool result has been rewritten with the
        user's answer, so the conversation ends in a complete
        ``assistant(tool_calls) → tool results`` tail and the next model call
        picks up precisely where the question interrupted it.

        The run is flagged ``question_resume`` so the loop refuses a second
        interruption — one question per turn, however many activations that
        turn happens to span.

        Raises:
            AlreadyWorkingError: if the agent is already running a turn.
        """
        if self.state == "working":
            raise AlreadyWorkingError(self.name)
        self.state = "working"
        self._question_suspended = None
        self._active_task = asyncio.create_task(
            self._run_activation(question_resume=True),
            name=f"answer:{self.name}",
        )

    def clear_question_suspension(self) -> None:
        """Free an agent parked on ``ask_user`` without resuming its turn.

        The state reset and the flag clear must always happen together, and
        this is the only place that pairing lives. ``waiting_input`` counts as
        busy (see :func:`is_busy`), so dropping the state half leaves
        ``_maybe_activate`` refusing to start a turn and the next message
        sitting undelivered; dropping the flag half leaves ``_run_activation``
        parking the agent right back in ``waiting_input``.

        Idempotent, and deliberately does not touch an ``error`` state — a
        failed turn's status is more informative than ``idle``.
        """
        if self.state == "waiting_input":
            self.state = "idle"
        self._question_suspended = None

    # ── Live-config drift ──────────────────────────────────────────────

    def refresh_if_dirty(self) -> bool:
        """Detect config drift and rebuild the agent in place if dirty.

        Public wrapper used by callers that want fresh frontmatter without
        reaching into private drift internals (e.g. read-only listing
        endpoints). The caller is responsible
        for skipping ``state == "working"`` to avoid racing ``run()``.

        Returns:
            ``True`` if a refresh was performed, ``False`` otherwise.
        """
        self._detect_config_drift()
        if self._config_dirty:
            self._refresh_agent_from_disk()
            return True
        return False

    def _detect_config_drift(self) -> None:
        """End-of-turn: flag the agent dirty if any tracked file moved."""
        if not self.agent.config_stamp:
            return  # in-memory agent with no source file
        drifted = detect_drift(self.agent.config_stamp)
        if drifted:
            self._config_dirty = True
            logger.info(
                "agent_config_dirty name={} paths={}",
                self.name,
                [Path(p).name for p in drifted],
            )

    def _refresh_agent_from_disk(self) -> None:
        """Start-of-turn: rebuild ``self.agent`` in place from its ``.md``.

        On parse/registry failure, keep the existing agent and re-stamp
        to avoid looping on the same broken edit.
        """
        # Deferred — ``app.agent.loader`` imports this module to build the
        # session runtime; resolving ``rebuild_agent_from_disk`` at call time
        # avoids the cycle without re-introducing one in ``app.agent.drift``.
        from app.agent.loader import rebuild_agent_from_disk

        source = self.agent.source_path
        if source is None:
            self._config_dirty = False
            return

        try:
            new_agent = rebuild_agent_from_disk(source, mode="coding")
        except Exception as exc:
            logger.warning(
                "agent_config_refresh_failed name={} error={}",
                self.name,
                exc,
            )
            from app.agent.mcp.config import config_path as _mcp_config_path

            self.agent.config_stamp = stamp_agent_files(
                agent_md_path=source,
                mcp_config_path=_mcp_config_path(),
            )
            self._config_dirty = False
            return

        # A rebuilt agent carries the name from its ``.md`` frontmatter; a live
        # spawned instance must keep the concrete handle it was created with.
        new_agent.name = self.name

        old_agent = self.agent
        old_model = old_agent.model_id
        self.agent = new_agent
        _schedule_provider_close(old_agent.llm_provider)
        self._config_dirty = False
        logger.info(
            "agent_config_refreshed name={} model={} tools={}",
            self.name,
            new_agent.model_id,
            sorted(new_agent._tools.keys()),
        )
        if old_model != new_agent.model_id:
            logger.info(
                "agent_model_changed name={} old={} new={}",
                self.name,
                old_model,
                new_agent.model_id,
            )

    async def _run_activation(
        self,
        *,
        force_compaction: bool = False,
        question_resume: bool = False,
    ) -> None:
        """One-shot activation: drain inbox, process, return to idle.

        ``question_resume`` is the history-only path, used after the user
        answered an ``ask_user``.
        """

        # Guard of last resort. ``waiting_input`` already blocks the known wake
        # paths, but it lives in memory: a rebuilt runtime, a restarted daemon, or
        # a path neither of us thought of would otherwise start a turn whose
        # history ends in an unanswered placeholder tool result. The DB is the
        # only source of truth that survives all three.
        if not question_resume and await self._abort_for_pending_question():
            return

        self._cancel_event.clear()

        if force_compaction or question_resume:
            # Control-command path — no inbox messages; run on DB history.
            pending: list[Message] = []
        else:
            # Drain all queued messages
            pending = []
            while not self._inbox.empty():
                try:
                    pending.append(self._inbox.get_nowait())
                except asyncio.QueueEmpty:
                    break

            if not pending:
                # Spurious activation — nothing to process. Reset state that
                # _maybe_activate pre-set to "working" and bail out.
                self.state = "idle"
                return

        # state was already set to "working" by _maybe_activate
        await self._emit(event="agent_status", status="working")
        logger.info(
            "session_runtime_activated name={} messages={}",
            self.name,
            len(pending),
        )

        # Re-check drift at turn start so edits made between turns
        # (settings UI, external editor, self-healing skill) take effect on
        # the very next turn, not two turns later.
        self._detect_config_drift()
        if self._config_dirty:
            self._refresh_agent_from_disk()

        if not question_resume:
            # Format + persist inbox RIGHT AFTER receiving (one row per message)
            inbox_msgs = await self._persist_inbox(pending)

            # Emit one inbox SSE per message for split view
            for msg_obj, raw_msg in zip(inbox_msgs, pending):
                # A user message is already rendered from the request that sent
                # it; only agent-authored inbox rows need an SSE.
                if raw_msg.from_agent != "user":
                    await self._emit(
                        event="inbox",
                        extra={
                            "id": str(msg_obj.db_id) if msg_obj.db_id else None,
                            "message_id": str(msg_obj.db_id) if msg_obj.db_id else None,
                            "content": msg_obj.content,
                            "from_agent": raw_msg.from_agent,
                        },
                    )

        try:
            await self._handle_messages(
                force_compaction=force_compaction,
                question_resume=question_resume,
            )

        except Exception as exc:
            from app.agent.errors import (
                ProviderAuthenticationError,
                ProviderConnectionError,
                ProviderRateLimitError,
                ProviderRequestError,
            )
            from app.agent.providers.unconfigured import UnconfiguredProviderError

            if isinstance(
                exc,
                (
                    ProviderRateLimitError,
                    ProviderAuthenticationError,
                    ProviderRequestError,
                    ProviderConnectionError,
                    # A fresh install whose model is still the
                    # ``__PROVIDER_MODEL__`` placeholder.  Expected first-run
                    # state, already surfaced to the UI as a typed
                    # AgentNotConfiguredEvent banner — not an application fault,
                    # so it must not land in app-error.log with a traceback.
                    UnconfiguredProviderError,
                    RuntimeError,
                ),
            ):
                logger.warning(
                    "session_runtime_turn_error name={} error={}", self.name, exc
                )
            else:
                logger.exception(
                    "session_runtime_turn_error name={} error={}", self.name, exc
                )
            await self._on_turn_error(exc)
            self.state = "error"
            from app.agent.errors import format_agent_error

            err_info = format_agent_error(exc, agent_name=self.name)
            await self._emit(
                event="agent_status",
                status="error",
                extra={
                    "message": err_info["message"],
                    "title": err_info["title"],
                    "code": err_info["code"],
                    "category": err_info["category"],
                },
            )

        finally:
            if self.state != "error" and self._question_suspended is not None:
                # Turn handed to the user. Not idle — the turn is still open and
                # `_try_emit_done` must not close it — and not working, because
                # nothing is running. Held until the answer or a dismissal.
                self.state = "waiting_input"
                await self._emit(
                    event="agent_status",
                    status="waiting_input",
                    extra={"question_id": str(self._question_suspended["question_id"])},
                )
                logger.info(
                    "session_runtime_waiting_input name={} question_id={}",
                    self.name,
                    self._question_suspended["question_id"],
                )
            elif self.state != "error":
                self.state = "idle"
                await self._emit(
                    event="agent_status",
                    status="idle",
                )
                logger.info("session_runtime_idle name={}", self.name)

            # Did mcp.json / agent.md / SKILL.md change during this turn?
            # Drift → rebuild the agent at the start of the next turn.
            self._detect_config_drift()

            # Re-activate for messages that arrived during a normal turn, but
            # discard them after an explicit interrupt. Otherwise a late peer
            # message can clear the cancellation event in a fresh activation and
            # make the agent resume after the user pressed Stop.
            if self._cancel_event.is_set():
                discarded = self.discard_inbox()
                if discarded:
                    logger.info(
                        "session_runtime_interrupted_inbox_discarded name={} count={}",
                        self.name,
                        discarded,
                    )
            elif not self._inbox.empty():
                logger.info(
                    "session_runtime_late_inbox_reactivate name={}",
                    self.name,
                )
                self._maybe_activate()

            await self._try_activate_queued_after_turn()
            await self._try_emit_done()

    # ------------------------------------------------------------------
    # Turn error reporting
    # ------------------------------------------------------------------

    async def _on_turn_error(self, exc: Exception) -> None:
        """Surface a failed turn to the client.

        A bare ``agent_status=error`` is only a status indicator to the
        frontend, so a failure would otherwise stop the turn silently. An
        unconfigured provider gets the typed
        :class:`~app.agent.schemas.events.AgentNotConfiguredEvent` instead of
        the generic :class:`~app.agent.schemas.events.ErrorEvent`, so the UI
        never shows two banners for the same cause.
        """
        from app.agent.errors import ProviderAuthenticationError, format_agent_error
        from app.agent.providers.unconfigured import UnconfiguredProviderError
        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

        if isinstance(exc, UnconfiguredProviderError | ProviderAuthenticationError):
            from app.agent.schemas.events import AgentNotConfiguredEvent

            try:
                await stream_store.push_event(
                    self.session_id,
                    StreamEnvelope.from_event(
                        AgentNotConfiguredEvent(
                            agent=self.name,
                            message=str(exc),
                        )
                    ),
                )
            except Exception as push_exc:
                logger.warning("agent_not_configured_emit_failed error={}", push_exc)
            return

        from app.agent.schemas.events import ErrorEvent

        err_info = format_agent_error(exc, agent_name=self.name)

        try:
            await stream_store.push_event(
                self.session_id,
                StreamEnvelope.from_event(
                    ErrorEvent(
                        message=f"Agent '{self.name}' failed: {exc}",
                        title=err_info["title"],
                        code=err_info["code"],
                        category=err_info["category"],
                        agent=self.name,
                        metadata={"agent": self.name, "exception": type(exc).__name__},
                    )
                ),
            )
        except Exception as push_exc:
            # Defensive: never let an emit failure escape the finally block.
            logger.warning("session_runtime_error_emit_failed error={}", push_exc)

    def build_protocol(self, base_prompt: str) -> str:
        """Assemble the operating protocol into the system prompt."""
        if self.parent_session_id or self.is_child_session:
            from app.agent.builtin_prompts import CODING_CHILD_AGENT_PROTOCOL

            return f"{base_prompt}\n\n---\n\n{CODING_CHILD_AGENT_PROTOCOL}"

        from app.agent.builtin_prompts import CODING_PARENT_DELEGATION_PROTOCOL

        protocol = "\n\n".join(
            [AGENT_COMMUNICATION_RULES, CODING_PARENT_DELEGATION_PROTOCOL]
        )
        return f"{base_prompt}\n\n---\n\n{protocol}"

    # ------------------------------------------------------------------
    # Inbox persistence
    # ------------------------------------------------------------------

    async def _persist_inbox(self, messages: list[Message]) -> list[HumanMessage]:
        """Format inbox messages, persist each as its own HumanMessage row.

        Called in _run_activation right after draining the mailbox — before
        any processing — so the user turn is in DB even if _handle_messages
        crashes.  Returns the list of HumanMessages (may be empty).
        """
        result: list[HumanMessage] = []
        to_persist: list[tuple[HumanMessage, dict[str, object]]] = []

        for msg in messages:
            # tool always delivers "[agent]: content" — user/broadcast pass through as-is
            content = msg.content

            human_msg = HumanMessage(content=content)
            extra: dict[str, object] = {
                "from_agent": msg.from_agent,
                "is_broadcast": msg.is_broadcast,
            }

            if msg.persisted_message_id is not None:
                human_msg.db_id = uuid.UUID(msg.persisted_message_id)
            elif msg.from_agent != "user":
                # User messages are already saved by the route handler.
                to_persist.append((human_msg, extra))

            result.append(human_msg)

        if to_persist:
            db_factory = resolve_db_factory(self.db_factory)
            session_uuid = uuid.UUID(self.session_id)
            async with db_factory() as db:
                async with db.begin():
                    for human_msg, extra in to_persist:
                        saved_row = await save_message(
                            db, session_uuid, human_msg, extra=extra
                        )
                        human_msg.db_id = saved_row.id  # stash db_id for sync()

        return result

    # ------------------------------------------------------------------
    # Message handling
    # ------------------------------------------------------------------

    async def _load_turn_history(
        self, db, session_uuid: uuid.UUID
    ) -> list[ChatMessage]:
        revision = await get_history_revision(db, session_uuid)
        cursor = await get_history_cursor(db, session_uuid)
        cached = self._llm_history
        if (
            cached
            and self._llm_history_revision is not None
            and self._llm_history_cursor is not None
        ):
            if (
                revision == self._llm_history_revision
                and cursor == self._llm_history_cursor
            ):
                return copy.deepcopy(cached)
            if revision == self._llm_history_revision:
                delta = await get_messages_for_llm_after(
                    db, session_uuid, self._llm_history_cursor
                )
                history = cached + delta
            else:
                history = await get_messages_for_llm(db, session_uuid)
        else:
            history = await get_messages_for_llm(db, session_uuid)
        self._llm_history_revision = revision
        self._llm_history_cursor = cursor
        self._llm_history = copy.deepcopy(history)
        return history

    async def _handle_messages(
        self,
        *,
        force_compaction: bool = False,
        question_resume: bool = False,
    ) -> None:
        """Load full history from DB and call agent.run()."""

        db_factory = resolve_db_factory(self.db_factory)
        session_uuid = uuid.UUID(self.session_id)

        async with db_factory() as db:
            try:
                history = await self._load_turn_history(db, session_uuid)
            except Exception:
                history = []
            session_row = await db.get(ChatSession, session_uuid)

        run_messages = history
        runtime_provider: LLMProviderBase | None = None
        runtime_model = None
        session_model = session_row.model if session_row is not None else None
        session_thinking_level = (
            session_row.thinking_level if session_row is not None else None
        )
        last_service_tier: str | None = None
        for msg in reversed(history):
            value = (msg.extra or {}).get("service_tier") if msg.extra else None
            if isinstance(value, str) and value:
                last_service_tier = value
                break
        # Providers whose backend routes on ``prompt_cache_key`` need a
        # stable one on every call, even outside a thinking-level/service-tier
        # override — so this must factor into whether we rebuild the
        # provider at all, not just which kwargs it gets.
        configured_provider_id, _, _ = (self.agent.model_id or "").partition(":")
        provider_wants_cache_key = _provider_supports_prompt_cache_key(
            configured_provider_id
        )
        effective_model = session_model or (
            self.agent.model_id
            if (session_thinking_level or last_service_tier or provider_wants_cache_key)
            else None
        )
        if effective_model and self._provider_factory is not None:
            model_kwargs: dict[str, object] = {}
            effective_thinking_level = session_thinking_level
            if not effective_thinking_level and effective_model == self.agent.model_id:
                configured_level = self.agent.llm_provider.model_kwargs.get(
                    "thinking_level"
                )
                if isinstance(configured_level, str) and configured_level:
                    effective_thinking_level = configured_level
            if effective_thinking_level:
                model_kwargs["thinking_level"] = effective_thinking_level
            if last_service_tier:
                model_kwargs["service_tier"] = last_service_tier
            effective_provider_id, _, _ = effective_model.partition(":")
            if _provider_supports_prompt_cache_key(effective_provider_id):
                model_kwargs["prompt_cache_key"] = f"openagentd:{self.session_id}"
            runtime_provider = self._provider_factory(
                effective_model,
                model_kwargs=model_kwargs,
            )
            runtime_model = effective_model

        # Build hooks — StreamPublisherHook writes to the session stream
        publisher_hook = StreamPublisherHook(
            session_id=self.session_id,
            agent_name=self.name,
            publish_reasoning=True,
        )

        # Inject the operating protocol via hook
        team_prompt_hook = SessionRuntimeProtocolHook(runtime=self)
        team_inbox_hook = TeamInboxHook(runtime=self)

        # OTel hook — child span under the session's trace
        otel_hook = OpenTelemetryHook(
            agent_name=self.name,
            model_id=runtime_model or self.agent.model_id,
            lead_session_id=self.session_id,
        )

        from app.agent.hooks.lsp import LspHook

        # LSP diagnostics injection is only meaningful in coding mode, where the
        # workspace is a real project tree. Decide once here so the hook needs
        # no per-tool-call DB lookups.
        hooks: list[BaseAgentHook] = [
            inject_current_date,
            team_prompt_hook,
            team_inbox_hook,
            publisher_hook,
            otel_hook,
            LspHook(enabled=True),
        ]
        # Splice user-queued messages into the running turn: the user-facing
        # queue lives on this session.  Must precede
        # summarization so a freshly-injected message participates in window
        # accounting on the same iteration.
        if self.db_factory:
            hooks.append(
                QueuedMessageInjectionHook(
                    session_id=self.session_id,
                    agent_name=self.name,
                    db_factory=self.db_factory,
                    support_interrupt=(
                        runtime_provider or self.agent.llm_provider
                    ).support_interrupt,
                )
            )
        hooks.append(WorkspaceInstructionsHook(self.workspace))

        # Title generation.
        # Returns None with a warning when the feature is disabled or
        # unconfigured — non-fatal, sessions just keep the fallback title.
        if self.db_factory:
            title_hook = build_title_generation_hook(
                default_provider=runtime_provider or self.agent.llm_provider,
                db_factory=self.db_factory,
            )
            if title_hook is not None:
                hooks.append(title_hook)

        # Build checkpointer — stream_session_id + agent_name let it clear
        # this agent's stream buffer after each persist, preventing
        # duplicate blocks on mid-turn refresh.
        checkpointer = None
        if self.db_factory:
            checkpointer = SQLiteCheckpointer(
                self.db_factory,
                stream_session_id=self.session_id,
                agent_name=self.name,
            )
            checkpointer.mark_loaded(self.session_id, history)
            # Tool result offload uses the hook's module-level defaults
            # (see app.agent.hooks.tool_result_offload.DEFAULT_CHAR_THRESHOLD).
            hooks.append(ToolResultOffloadHook())
            summarization_provider = runtime_provider or self.agent.llm_provider
            summarization_model = runtime_model or self.agent.model_id
            summ_hook = build_summarization_hook(
                summarization_provider,
                mode="coding",
                model_id=summarization_model,
                support_interrupt=summarization_provider.support_interrupt,
            )
            if summ_hook:
                hooks.append(summ_hook)

        # Inject the runtime-bound tools
        injected = self.get_injected_tools()

        # Surface session routing context to tools via state.metadata.  The
        # schedule tool reads these as injected args so the LLM never has
        # to specify (or could lie about) the routing target.
        run_metadata: dict[str, object] = {
            "lead_session_id": self.session_id,
        }
        if question_resume:
            # Spends this turn's one interruption up-front: the loop refuses a
            # second ask_user, so answering can never loop back into
            # another question.
            run_metadata["question_resume"] = True
        if force_compaction:
            run_metadata["force_summarization"] = True
            run_metadata["stop_after_before_model"] = True
        if self.workspace:
            run_metadata["team_workspace"] = self.workspace
        config = RunConfig(session_id=self.session_id, metadata=run_metadata)

        # Coding mode uses the exact project workspace.
        workspace = str(session_workspace_dir(self.session_id, self.workspace))
        session_sandbox = DeniedPathsConfig(
            workspace=workspace, session_id=self.session_id
        )
        token = set_denied_paths(session_sandbox)

        # Scope permission service to this agent run — auto-allows by default,
        # fires SSE events so the frontend can optionally show an approval UI.
        permission_service = AutoAllowPermissionService(session_id=self.session_id)
        perm_token = set_permission_service(permission_service)

        # Scope agent role for plugin applies_to filtering ("lead"/"member").
        role_token = set_role("lead")

        try:
            run_messages = await self.agent.run(
                run_messages,
                config=config,
                hooks=hooks,
                injected_tools=injected,
                interrupt_event=self._cancel_event,
                checkpointer=checkpointer,
                llm_provider=runtime_provider,
                model_id=runtime_model,
            )
            self._llm_history = copy.deepcopy(run_messages)
            async with db_factory() as history_db:
                self._llm_history_revision = await get_history_revision(
                    history_db, session_uuid
                )
                self._llm_history_cursor = await get_history_cursor(
                    history_db, session_uuid
                )

            # ``ask_user`` suspended the turn: the loop reports it
            # through the run config rather than raising, because the turn is
            # complete-and-resumable, not failed.
            #
            # Read ``config.metadata``, never the ``run_metadata`` dict passed
            # in: ``RunConfig`` is a Pydantic model, so validation *copies* the
            # mapping. The loop writes to the copy, and the original never sees
            # the flag — the agent would go ``idle`` on a turn that is still
            # waiting on the user, and the runtime would emit ``done``.
            suspended = config.metadata.get("question_suspended")
            self._question_suspended = (
                suspended if isinstance(suspended, dict) else None
            )

        finally:
            if runtime_provider is not None:
                await _close_provider(runtime_provider)
            reset_role(role_token)
            _denied_paths_ctx.reset(token)
            _permission_ctx.reset(perm_token)

        # If interrupted, mark last assistant message
        if self._cancel_event.is_set() and self.db_factory:
            await _mark_last_assistant_interrupted(
                self.db_factory, uuid.UUID(self.session_id)
            )

    async def _abort_for_pending_question(self) -> bool:
        """Refuse to start a turn while an unanswered question is on record.

        The in-memory ``waiting_input`` state covers the normal wake paths, but
        it does not survive a runtime rebuild or a daemon restart — and the DB row
        does.  Starting a turn here would hand the model the placeholder tool
        result standing in for the user's answer.

        Returns ``True`` when the activation must not proceed.
        """
        if self.db_factory is None:
            return False
        from app.services import question_service

        try:
            db_factory = resolve_db_factory(self.db_factory)
            async with db_factory() as db:
                pending = await question_service.get_pending_question(
                    db, uuid.UUID(self.session_id)
                )
        except Exception as exc:
            # A lookup failure must not wedge the session — the state flag and
            # the tool's own guards still apply.
            logger.warning(
                "pending_question_check_failed session_id={} error={}",
                self.session_id,
                exc,
            )
            return False

        if pending is None:
            return False

        self.state = "waiting_input"
        logger.info(
            "activation_blocked_pending_question name={} question_id={}",
            self.name,
            pending.id,
        )
        # Re-announce so a client that missed (or lost) the original event
        # re-renders the card instead of showing a session stuck mid-turn.
        await self._emit(
            event="agent_status",
            status="waiting_input",
            extra={"question_id": str(pending.id)},
        )
        return True

    @property
    def user_message_lock(self) -> asyncio.Lock:
        """Lock that serialises route-level user message dispatch decisions."""
        return self._user_message_lock

    def has_active_user_turn(self) -> bool:
        """Return whether this session is still handling a user turn."""
        return self._has_active_turn or is_busy(self.state)

    def has_active_agent_turn(self) -> bool:
        """Return whether the agent itself owns an open turn."""
        return is_busy(self.state)

    async def attach_to_session(
        self, session_id: str, *, title: str | None = None
    ) -> None:
        """Bind this runtime to *session_id*."""
        if self.session_id != session_id:
            self._llm_history = []
            self._llm_history_revision = None
            self._llm_history_cursor = None
        self.session_id = session_id
        await self._ensure_db_session(
            title=title,
            workspace=self.workspace,
        )

    def is_awaiting_question_answer(self) -> bool:
        """Whether the agent is parked on a question the user has not resolved."""
        return self.state == "waiting_input"

    async def _emit(
        self,
        event: str,
        status: Literal["idle", "working", "waiting_input", "offline", "error"]
        | None = None,
        extra: dict | None = None,
    ) -> None:
        """Push a lifecycle event to the stream store for the current session."""
        from app.agent.schemas.events import AgentStatusEvent

        session_id = self.session_id
        if event == "agent_status" and status is not None:
            envelope = StreamEnvelope.from_event(
                AgentStatusEvent(
                    agent=self.name,
                    status=status,
                    metadata=extra or {},
                )
            )
        else:
            envelope = StreamEnvelope.from_parts(
                event,
                {"type": event, "agent": self.name, "event": event, **(extra or {})},
            )

        try:
            await stream_store.push_event(session_id, envelope)
        except Exception as exc:
            logger.debug(
                "session_runtime_lifecycle_emit_failed session_id={} agent={} event={} error={}",
                session_id,
                self.name,
                event,
                exc,
            )

    async def _try_activate_queued_after_turn(self) -> None:
        """When the agent finishes its turn, drain any queued user message."""
        if not self._has_active_turn:
            return
        if is_busy(self.state):
            return
        if not self._inbox.empty():
            return
        session_id = self.session_id
        await self._activate_queued_user_messages(session_id)
        if not self._inbox.empty():
            self._maybe_activate()

    async def _try_emit_done(self) -> None:
        """Emit 'done' when the agent is idle or in error."""
        if not self._has_active_turn:
            return
        if self.state in ("idle", "error"):
            self._has_active_turn = False  # reset for next turn
            session_id = self.session_id

            if await self._activate_queued_user_messages(session_id):
                return

            try:
                await self._emit_completion_notification(session_id)
                await stream_store.push_event(
                    session_id,
                    StreamEnvelope.from_event(DoneEvent()),
                )
                await stream_store.mark_done(session_id)
                await event_broadcaster.publish(
                    "session_turn_completed",
                    {
                        "session_id": session_id,
                        "status": "completed",
                    },
                )
            except Exception as exc:
                logger.warning("session_runtime_emit_done_failed error={}", exc)

            # If this is a child session, deliver the final summary to the parent session
            if self.parent_session_id and not self._cancel_event.is_set():
                try:
                    from app.services.chat_service import get_messages
                    from app.services import team_manager

                    db_factory = resolve_db_factory(self.db_factory)
                    async with db_factory() as db:
                        messages = await get_messages(db, UUID(session_id))
                        last_assistant = None
                        for msg in reversed(messages):
                            if (
                                isinstance(msg, AssistantMessage)
                                and msg.content
                                and not getattr(msg, "hidden", False)
                            ):
                                last_assistant = msg
                                break
                        report_content = (
                            str(last_assistant.content)
                            if last_assistant and last_assistant.content
                            else f"Child agent finished turn with state '{self.state}'."
                        )

                    await team_manager.deliver_agent_report(
                        parent_session_id=str(self.parent_session_id),
                        child_session_id=session_id,
                        child_name=self.name,
                        content=report_content,
                        db_factory=db_factory,
                    )
                except Exception as exc:
                    logger.warning(
                        "child_report_delivery_failed child={} parent={} error={}",
                        session_id,
                        self.parent_session_id,
                        exc,
                    )

            logger.info("session_runtime_turn_done session_id={}", session_id)

    async def _emit_completion_notification(self, session_id: str) -> None:
        try:
            session_uuid = UUID(session_id)
        except ValueError:
            return

        title: str | None = None
        workspace: str | None = None
        try:
            db_factory = resolve_db_factory(self.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, session_uuid)
                if row is not None:
                    title = row.title
                    workspace = row.workspace
        except Exception as exc:
            logger.warning(
                "session_runtime_completion_notification_metadata_failed session_id={} error={}",
                session_id,
                exc,
            )

        workspace_name = Path(workspace).name if workspace else None
        notification_title = (
            f"Session completed - {workspace_name}"
            if workspace_name
            else "Session completed"
        )
        title_text = title.strip() if title else ""
        notification_body = title_text or f"Session {session_id[:8]}"
        try:
            await event_broadcaster.publish(
                "desktop_notification",
                {
                    "type": "desktop_notification",
                    "notification_id": str(uuid7()),
                    "kind": "assistant_done",
                    "session_id": session_id,
                    "title": notification_title,
                    "body": notification_body,
                    "metadata": {
                        "session_id": session_id,
                        "title": title_text,
                        "workspace": workspace,
                    },
                },
            )
        except Exception as exc:
            logger.debug(
                "desktop_notification_failed session_id={} error={}",
                session_id,
                exc,
            )

    async def _activate_queued_user_messages(self, session_id: str) -> bool:
        """Drain queued user messages for *session_id* into a new user turn."""
        try:
            session_uuid = UUID(session_id)
        except ValueError:
            return False

        db_factory = resolve_db_factory(self.db_factory)
        try:
            async with db_factory() as db:
                popped = await pop_queued_user_messages(db, session_uuid)
                if not popped:
                    await db.commit()
                    return False
                await db.commit()

            if not is_busy(self.state):
                try:
                    await stream_store.init_turn(session_id, keep_subscribers=True)
                except Exception as exc:
                    logger.warning(
                        "session_runtime_init_queued_turn_failed error={}", exc
                    )
                    return False

            message_ids = [str(row.id) for row in popped]
            await stream_store.push_event(
                session_id,
                StreamEnvelope.from_parts(
                    "queued_turn_start",
                    {
                        "type": "queued_turn_start",
                        "session_id": session_id,
                        "message_ids": message_ids,
                        "messages": [
                            {"id": str(row.id), "content": row.content}
                            for row in popped
                        ],
                    },
                ),
            )

            content = "\n\n".join(
                row.content for row in popped if row.content is not None
            )
            self._has_active_turn = True
            msg = Message(
                from_agent="user",
                to_agent=self.name,
                content=f"[user]: {content}",
            )
            await self.deliver(msg)
            return True
        except Exception as exc:
            logger.warning(
                "queued_message_activation_failed session_id={} error={}",
                session_id,
                exc,
            )
            return False

    async def handle_user_message(
        self,
        content: str,
        session_id: str,
        *,
        attachment_metas: list[dict] | None = None,
        mention_context_blocks: list[str] | None = None,
        interrupt: bool = False,
        workspace: str | None = None,
        model: str | None = None,
        model_provided: bool = False,
        thinking_level: str | None = None,
        thinking_level_provided: bool = False,
        service_tier: str | None = None,
        mentions: list[str] | None = None,
        origin: str = "user",
    ) -> tuple[str, str]:
        """Handle a new user message sent to this session's agent."""
        if workspace is not None:
            self.workspace = workspace

        is_new_session = self.session_id != session_id
        if is_new_session:
            await self.attach_to_session(
                session_id, title=content[:100] if content else None
            )

        if await self._has_open_question():
            if origin != "user":
                logger.info(
                    "question_deferred_machine_message session_id={} origin={}",
                    session_id,
                    origin,
                )
                raise QuestionPendingError(session_id)
            await self.dismiss_pending_question(reason="superseded")

        if interrupt:
            if is_busy(self.state):
                self._cancel_event.set()
            await self.dismiss_pending_question(reason="dismissed")

        db_factory = resolve_db_factory(self.db_factory)
        session_uuid = UUID(session_id)
        async with db_factory() as db:
            await heal_orphaned_tool_calls(db, session_uuid)

            session_row = await db.get(ChatSession, session_uuid)
            effective_model = model if model_provided else None
            effective_thinking_level = (
                thinking_level if thinking_level_provided else None
            )
            if session_row is not None:
                session_row.workspace = self.workspace or ""
                if model_provided:
                    session_row.model = model
                if thinking_level_provided:
                    session_row.thinking_level = thinking_level
                effective_model = session_row.model or self.agent.model_id
                effective_thinking_level = session_row.thinking_level
                self.is_scheduler_session = session_row.scheduled_task_name is not None
                db.add(session_row)
            else:
                effective_model = model or self.agent.model_id

            user_msg = HumanMessage(content=content)
            msg_extra: dict | None = (
                {"attachments": attachment_metas} if attachment_metas else None
            )
            if mentions:
                if msg_extra is None:
                    msg_extra = {}
                msg_extra["mentions"] = mentions

            workspace_path = session_workspace_dir(str(session_uuid), self.workspace)
            snapshot_hash = await snapshot_service.track(
                str(session_uuid), workspace_path
            )
            if snapshot_hash:
                extra_with_snapshot = dict(msg_extra or {})
                extra_with_snapshot["snapshot"] = snapshot_hash
                msg_extra = extra_with_snapshot

            extra_with_model = dict(msg_extra or {})
            extra_with_model["model"] = effective_model
            if effective_thinking_level:
                extra_with_model["thinking_level"] = effective_thinking_level
            if service_tier:
                extra_with_model["service_tier"] = service_tier
            msg_extra = extra_with_model

            saved_user_msg = await save_message(
                db, session_uuid, user_msg, extra=msg_extra
            )

            for synthetic_content in mention_context_blocks or []:
                await save_message(
                    db,
                    session_uuid,
                    HumanMessage(content=synthetic_content),
                    extra={
                        "hidden_from_user": True,
                        "hidden_from_summary": True,
                        "attachment_for_message_id": str(saved_user_msg.id),
                        "mention_context": True,
                    },
                )

            await db.commit()

        try:
            await stream_store.init_turn(session_id)
        except Exception as exc:
            logger.warning("session_runtime_init_turn_failed error={}", exc)

        if content.startswith("[Scheduled Task: "):
            task_name = (
                content.split("]", 1)[0].removeprefix("[Scheduled Task: ").strip()
            )
            await event_broadcaster.publish(
                "desktop_notification",
                {
                    "type": "desktop_notification",
                    "notification_id": str(uuid7()),
                    "kind": "reminder_fired",
                    "session_id": session_id,
                    "title": "Reminder fired",
                    "body": task_name,
                    "metadata": {},
                },
            )

        self._has_active_turn = True
        msg = Message(
            from_agent="user",
            to_agent=self.name,
            content=f"[user]: {content}",
        )
        try:
            await self.deliver(msg)
        except BaseException:
            self._has_active_turn = False
            raise

        return session_id, str(saved_user_msg.id)

    async def handle_compact(self, session_id: str) -> str:
        """Start a turn that forces summarization before the model call."""
        if self._has_active_turn:
            raise ContinuePreconditionError("Lead is already working.")

        try:
            session_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        db_factory = resolve_db_factory(self.db_factory)
        async with db_factory() as db:
            row = await db.get(ChatSession, session_uuid)
            if row is None:
                raise ContinuePreconditionError("Session not found.")
            if row.agent_name and row.agent_name != self.name:
                raise ContinuePreconditionError(
                    f"Session belongs to '{row.agent_name}', not '{self.name}'."
                )
            messages = await get_messages_for_llm(db, session_uuid)
            if not messages:
                raise ContinuePreconditionError("Session has no messages to compact.")
            await cleanup_reverted_tail(db, session_uuid)
            await db.commit()

        if self.session_id != session_id:
            self.session_id = session_id

        try:
            await stream_store.init_turn(session_id)
        except Exception as exc:
            logger.warning("session_runtime_init_turn_failed error={}", exc)

        try:
            self.activate_for_compaction()
        except AlreadyWorkingError as exc:
            raise ContinuePreconditionError(str(exc)) from exc

        self._has_active_turn = True
        logger.info(
            "session_runtime_compact_dispatched session_id={} agent={}",
            session_id,
            self.name,
        )
        return session_id

    async def handle_undo(self, session_id: str) -> tuple[str, BoundaryShift]:
        """Move the revert boundary to the latest visible user turn."""
        if self._has_active_turn or is_busy(self.state):
            raise ContinuePreconditionError("Lead is already working.")

        try:
            session_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        async with _command_lock(session_id):
            db_factory = resolve_db_factory(self.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, session_uuid)
                if row is None:
                    raise ContinuePreconditionError("Session not found.")
                if row.agent_name and row.agent_name != self.name:
                    raise ContinuePreconditionError(
                        f"Session belongs to '{row.agent_name}', not '{self.name}'."
                    )
                shift = await undo_session_messages(db, session_uuid)
                if not shift.applied or shift.target is None:
                    raise ContinuePreconditionError("No user message to undo.")
                await db.commit()
                await db.refresh(shift.target)

        logger.info(
            "session_runtime_undo_applied session_id={} agent={}", session_id, self.name
        )
        return session_id, shift

    async def handle_redo(self, session_id: str) -> tuple[str, BoundaryShift]:
        """Move the revert boundary forward or clear it."""
        if self._has_active_turn or is_busy(self.state):
            raise ContinuePreconditionError("Lead is already working.")

        try:
            session_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        async with _command_lock(session_id):
            db_factory = resolve_db_factory(self.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, session_uuid)
                if row is None:
                    raise ContinuePreconditionError("Session not found.")
                if row.agent_name and row.agent_name != self.name:
                    raise ContinuePreconditionError(
                        f"Session belongs to '{row.agent_name}', not '{self.name}'."
                    )
                shift = await redo_session_messages(db, session_uuid)
                if not shift.applied:
                    raise ContinuePreconditionError("No undone message to redo.")
                await db.commit()
                if shift.target is not None:
                    await db.refresh(shift.target)

        logger.info(
            "session_runtime_redo_applied session_id={} agent={}", session_id, self.name
        )
        return session_id, shift

    async def handle_redo_all(self, session_id: str) -> tuple[str, BoundaryShift]:
        """Clear the revert boundary back to the live tip in one step."""
        if self._has_active_turn or is_busy(self.state):
            raise ContinuePreconditionError("Lead is already working.")

        try:
            session_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        async with _command_lock(session_id):
            db_factory = resolve_db_factory(self.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, session_uuid)
                if row is None:
                    raise ContinuePreconditionError("Session not found.")
                if row.agent_name and row.agent_name != self.name:
                    raise ContinuePreconditionError(
                        f"Session belongs to '{row.agent_name}', not '{self.name}'."
                    )
                shift = await redo_all_session_messages(db, session_uuid)
                if not shift.applied:
                    raise ContinuePreconditionError("No undone message to redo.")
                await db.commit()

        logger.info(
            "session_runtime_redo_all_applied session_id={} agent={}",
            session_id,
            self.name,
        )
        return session_id, shift

    def get_injected_tools(self) -> list[Tool]:
        """Return runtime tools to inject into agent.run()."""
        tools: list[Tool] = []
        if self._question_tool_enabled():
            tools.append(make_ask_user_tool(self))

        from app.agent.mode.team.agent_tools import (
            make_agent_list_tool,
            make_agent_merge_tool,
            make_agent_send_tool,
            make_agent_spawn_tool,
            make_agent_stop_tool,
        )

        # Deferred with the tools above: ``agent_spawn_service`` imports
        # ``team_manager``, which imports this module.
        from app.services.agent_spawn_service import MAX_SPAWN_DEPTH

        tools.extend(
            [
                make_agent_send_tool(self),
                make_agent_list_tool(self),
                make_agent_stop_tool(self),
                make_agent_merge_tool(self),
            ]
        )
        # Hiding the tool at the cap is a UX nicety; ``spawn_agent_session``
        # re-checks the same limit and is the real enforcement point.
        if self.spawn_depth < MAX_SPAWN_DEPTH:
            tools.append(make_agent_spawn_tool(self))

        return tools

    async def _has_open_question(self) -> bool:
        """Cheap existence check for an unanswered question on this session."""
        from app.services import question_service

        try:
            db_factory = resolve_db_factory(self.db_factory)
            async with db_factory() as db:
                return (
                    await question_service.get_pending_question(
                        db, UUID(self.session_id)
                    )
                    is not None
                )
        except Exception as exc:
            logger.warning(
                "question_lookup_failed session_id={} error={}",
                self.session_id,
                exc,
            )
            return False

    async def dismiss_pending_question(
        self,
        *,
        reason: "question_service.ResolvedStatus",
        session_id: str | None = None,
    ) -> bool:
        """Close any open question on *session_id* and free the agent."""
        from app.services import question_service

        target_session = session_id or self.session_id
        try:
            db_factory = resolve_db_factory(self.db_factory)
            async with db_factory() as db:
                pending = await question_service.get_pending_question(
                    db, UUID(target_session)
                )
                if pending is None:
                    return False
                question_id = pending.id
                await question_service.resolve_pending_question(
                    db, question_id=question_id, status=reason
                )
                await db.commit()
        except Exception as exc:
            logger.warning(
                "question_dismiss_failed session_id={} error={}",
                target_session,
                exc,
            )
            return False

        if target_session == self.session_id:
            self.clear_question_suspension()

        from app.agent.schemas.events import QuestionDismissedEvent

        try:
            await stream_store.push_event(
                target_session,
                StreamEnvelope.from_event(
                    QuestionDismissedEvent(
                        question_id=str(question_id),
                        session_id=target_session,
                        reason=reason,
                    )
                ),
            )
        except Exception as exc:
            logger.warning(
                "question_dismiss_event_failed session_id={} error={}",
                target_session,
                exc,
            )

        logger.info(
            "question_dismissed session_id={} reason={}", target_session, reason
        )
        return True

    def _question_tool_enabled(self) -> bool:
        """Whether the agent may interrupt the user with ``ask_user``."""
        if self.is_scheduler_session:
            return False
        if self.is_child_session or self.parent_session_id:
            return False
        return True
