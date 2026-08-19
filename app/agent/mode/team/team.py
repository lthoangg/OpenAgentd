"""AgentTeam — coordinates a team lead + members via mailbox activation.

Members are not built at startup; they exist as **blueprints** on the team
and are constructed on demand when the lead calls ``team_manage`` (see
:meth:`AgentTeam.spawn`).  Each spawn yields an instance handle of the form
``blueprint#N`` so the lead can run multiple parallel instances of the same
blueprint (e.g. ``executor#1`` and ``executor#2`` working in parallel) and
each instance has its own DB session / chat history.

Agents do **not** run persistent background loops.  Instead, ``register``
attaches an agent to the mailbox and installs an ``on_message`` callback
that activates the receiving agent on demand.

Streaming to the frontend uses the in-memory stream store: lifecycle events
(agent_status, done) are pushed to the same stream key as the LLM deltas,
so the frontend receives one unified event feed per session.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from uuid import UUID, uuid7

import sqlalchemy as sa
from loguru import logger
from sqlmodel import col, func, select

from app.agent.mode.team.mailbox import Message, TeamMailbox
from app.agent.mode.team.member import (
    AlreadyWorkingError,
    TeamLead,
    TeamMember,
    TeamMemberBase,
    is_busy,
)
from app.agent.mode.team.manage import make_team_manage_tool
from app.agent.mode.team.question import make_ask_user_tool
from app.agent.mode.team.tools import make_team_message_tool
from app.agent.schemas.chat import AssistantMessage, HumanMessage, ToolMessage
from app.agent.schemas.events import DoneEvent
from app.agent.tools.registry import Tool
from app.core.db import DbFactory, resolve_db_factory
from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession
from app.services import event_broadcaster, memory_stream_store as stream_store
from app.services import snapshot_service
from app.services.stream_envelope import StreamEnvelope
from app.services.chat_service import (
    BoundaryShift,
    cleanup_reverted_tail,
    get_messages_for_llm,
    heal_orphaned_tool_calls,
    pop_queued_user_messages,
    redo_all_session_messages,
    redo_session_messages,
    save_message,
    undo_session_messages,
)

if TYPE_CHECKING:
    from app.agent.agent_loop import Agent
    from app.agent.providers.factory import ProviderFactory
    from app.services import question_service


# ---------------------------------------------------------------------------
# Blueprint registry
# ---------------------------------------------------------------------------


@dataclass
class MemberBlueprint:
    """A member ``.md`` file the lead can spawn instances from.

    Construction is deferred — the team holds blueprint metadata + the
    factories needed to build an Agent, and ``AgentTeam.spawn`` does the
    actual construction.
    """

    name: str  # blueprint name (matches the ``.md`` ``name:`` field)
    description: str
    source_path: Path
    # Monotonic per-blueprint counter — bumped each time an instance is
    # spawned in this process.  Spawning seeds it from the DB on first use
    # so it survives restarts (see AgentTeam._next_instance_id).
    next_instance_id: int = 1
    # ``True`` once spawn() has reconciled the counter against existing DB
    # sessions for the *current* lead session.  Reset when the lead session
    # changes so a fresh chat starts the counter at #1 again.
    counter_reconciled_for: str | None = field(default=None)
    # Rebuilding from disk is needed only when the source file changes. The
    # cached Agent is used for read-only API serialization, never as a live
    # member instance.
    _serialized_agent: Agent | None = field(default=None, init=False, repr=False)
    _serialized_agent_fingerprint: tuple[str, int, int] | None = field(
        default=None, init=False, repr=False
    )


# ---------------------------------------------------------------------------
# Instance handle parsing
# ---------------------------------------------------------------------------


_INSTANCE_HANDLE_RE = re.compile(r"^(?P<blueprint>[^#]+)#(?P<n>\d+)$")


def parse_instance_handle(handle: str) -> tuple[str, int] | None:
    """Parse ``blueprint#N`` into ``(blueprint, N)``.  Return ``None`` on miss."""
    m = _INSTANCE_HANDLE_RE.match(handle)
    if not m:
        return None
    return m.group("blueprint"), int(m.group("n"))


def make_instance_handle(blueprint: str, n: int) -> str:
    """Format an instance handle from a blueprint name + counter."""
    return f"{blueprint}#{n}"


class QuestionPendingError(Exception):
    """Raised when a machine-originated message arrives during a live question.

    A scheduled task must not answer — or silently cancel — a question the user
    has not seen yet, so the fire is refused and rescheduled. The scheduler
    already skips while a turn is active; this covers the case where the team
    was rebuilt (restart) and its in-memory ``waiting_input`` state was lost.
    """

    def __init__(self, session_id: str) -> None:
        super().__init__(
            f"Session {session_id} is waiting on a user answer; try again later."
        )
        self.session_id = session_id


class ContinuePreconditionError(Exception):
    """Raised when ``/continue`` is requested on a session that can't be continued.

    Carries a ``reason`` (human-readable, surfaced to the user) and an HTTP
    ``status`` so the route layer can map straight to a response.  All
    precondition failures use 409 (Conflict) — the session exists but is in
    a state where continuation is not meaningful.
    """

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


def _is_interrupted_thinking_only_tail(messages: list) -> bool:
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


def _tool_tail_has_matching_assistant_call(messages: list) -> bool:
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


class AgentTeam:
    """Singleton team: one lead, N member blueprints, dynamic instance roster.

    Lifecycle::

        team = AgentTeam(lead=lead, blueprints={...}, ...)
        await team.start()   # registers lead with mailbox; members stay un-built
        ...
        await team.stop()    # cancels active tasks, deregisters all instances

    Spawn / dismiss::

        instance = await team.spawn("executor")          # → executor#1
        instance = await team.spawn("executor")          # → executor#2
        await team.dismiss("executor#1")                 # frees the agent
        instance = await team.spawn("executor", instance_id=1)  # restore #1

    Handling a user message::

        session_id = await team.handle_user_message(content="...", session_id="...")
        # client subscribes to GET /team/stream/{session_id}
    """

    def __init__(
        self,
        lead: TeamLead,
        blueprints: dict[str, "MemberBlueprint"] | None = None,
        *,
        provider_factory: "ProviderFactory | None" = None,
        extra_tools: dict[str, Tool] | None = None,
        db_factory: DbFactory | None = None,
        mode: str = "normal",
        workspace: str | None = None,
        # Back-compat: callers (especially older tests) can still pass a
        # pre-built members map.  These instances are registered as if they
        # were spawned by name; their handles stay verbatim (no ``#1``
        # suffix is added) so existing tests keep passing.
        members: dict[str, "TeamMember"] | None = None,
    ) -> None:
        self.lead = lead
        self.blueprints: dict[str, MemberBlueprint] = blueprints or {}
        self.members: dict[str, TeamMember] = dict(members or {})

        self._provider_factory = provider_factory
        self._extra_tools = extra_tools
        self._db_factory = db_factory
        self.mode = mode
        self.workspace = workspace

        self.mailbox = TeamMailbox(on_message=self._on_message)

        # Guard: only emit done after at least one user turn has started
        self._has_active_turn: bool = False

        # Index agents by name for fast lookup in on_message.  Kept in sync
        # by spawn() / dismiss().
        self._members_by_name: dict[str, TeamMemberBase] = {lead.name: lead}
        for name, m in self.members.items():
            self._members_by_name[name] = m

        # Serialise spawn / dismiss against each other.  The mailbox + DB
        # work is short, but two concurrent roster-management calls from the
        # same lead turn could otherwise race the counter.
        self._roster_lock = asyncio.Lock()

        # Serialise user ingress so quick follow-ups queue behind the active
        # turn instead of racing in as adjacent normal user rows.
        self._user_message_lock = asyncio.Lock()

        # Restore re-wake dedupe — ``lead_session:task_id`` keys already
        # re-woken this process.  The restore path runs on every lead-session
        # switch, not just restarts; without this a user toggling between
        # sessions would re-wake the same open task (one LLM call each time).
        self._restore_rewakes: set[str] = set()

    @property
    def user_message_lock(self) -> asyncio.Lock:
        """Lock that serialises route-level user message dispatch decisions."""
        return self._user_message_lock

    def has_active_user_turn(self) -> bool:
        """Return whether the team is still handling a user turn."""
        return self._has_active_turn or is_busy(self.lead.state)

    def has_active_lead_turn(self) -> bool:
        """Return whether the lead itself owns an open turn.

        Includes a lead suspended on a question: the turn is unfinished even
        though nothing is running.
        """
        return is_busy(self.lead.state)

    async def attach_lead_to_session(
        self, session_id: str, *, title: str | None = None
    ) -> None:
        """Point the lead at *session_id* and realign the roster behind it.

        A team is cached per (workspace, session) but its lead starts on a
        freshly minted session id, so anything that acts on an existing
        conversation has to bind the lead first — otherwise the turn runs
        against the wrong history. Callers must check the lead is not busy:
        rebinding mid-turn would move a running activation to another session.
        """
        self.lead.session_id = session_id
        await self.lead._ensure_db_session(
            title=title,
            mode=self.mode,
            workspace=self.workspace,
        )

        # Reset blueprint counters so a fresh chat starts at #1 for each
        # blueprint.  (Reconciliation against existing DB rows is done
        # lazily on the first spawn for the new lead session.)
        for bp in self.blueprints.values():
            bp.counter_reconciled_for = None

        # Restore previously-spawned-and-not-dismissed instances by
        # rehydrating their session ids from DB.  Any instance that was
        # alive (registered) when we entered this branch keeps its
        # mailbox registration; we only update its DB session pointer
        # so its view of history matches whatever child rows exist
        # for the current lead session.
        #
        # This preserves the existing "restart restores members"
        # behaviour for instances that had been spawned earlier in the
        # process — but only for those that actually had child rows
        # under THIS lead session.  Anything else is dropped from the
        # roster (the lead can re-spawn at will).
        await self._restore_or_drop_members_for_lead(session_id)

    def is_awaiting_question_answer(self) -> bool:
        """Whether the lead is parked on a question the user has not resolved.

        Distinguishes "busy, will finish on its own" from "busy, and only the
        user can move it". Callers that would otherwise queue behind an active
        turn need the difference: nothing drains a queue while a question owns
        the turn, so a message queued here would be stranded.
        """
        return self.lead.state == "waiting_input"

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Register the lead with the mailbox.

        Members are NOT registered here — they exist as blueprints and are
        registered when ``team_manage`` materialises an instance.  Pre-existing
        members in ``self.members`` (e.g. supplied directly by tests via the
        ``members=`` constructor kwarg) are also registered for back-compat.
        """
        self.lead.register(self)
        for member in self.members.values():
            member.register(self)
        logger.info(
            "agent_team_started lead={} blueprints={} eager_members={}",
            self.lead.name,
            sorted(self.blueprints.keys()),
            list(self.members.keys()),
        )

    async def stop(self) -> None:
        """Gracefully stop all agents: cancel active tasks and deregister."""
        for member in list(self.members.values()):
            await member.stop()
        await self.lead.stop()
        logger.info("agent_team_stopped")

    # ------------------------------------------------------------------
    # On-message activation callback
    # ------------------------------------------------------------------

    async def _on_message(self, agent_name: str, message: Message) -> None:
        """Called by the mailbox after every send.  Activates the target agent."""
        member = self._members_by_name.get(agent_name)
        if member is None:
            logger.warning("team_on_message_unknown_agent agent={}", agent_name)
            return
        member._maybe_activate()

    # ------------------------------------------------------------------
    # Stream event helpers
    # ------------------------------------------------------------------

    async def _emit(
        self,
        agent: str,
        event: str,
        status: Literal["idle", "working", "waiting_input", "offline", "error"]
        | None = None,
        extra: dict | None = None,
    ) -> None:
        """Push a lifecycle event to the stream store for the current session."""
        from app.agent.schemas.events import AgentStatusEvent

        session_id = self.lead.session_id
        if event == "agent_status" and status is not None:
            envelope = StreamEnvelope.from_event(
                AgentStatusEvent(
                    agent=agent,
                    status=status,
                    metadata=extra or {},
                )
            )
        else:
            envelope = StreamEnvelope.from_parts(
                event,
                {"type": event, "agent": agent, "event": event, **(extra or {})},
            )

        try:
            await stream_store.push_event(session_id, envelope)
        except Exception as exc:
            logger.warning("team_emit_failed event={} error={}", event, exc)

    async def end_turn_after_question_dismissed(self, session_id: str) -> bool:
        """Close the turn a dismissed ``ask_user`` left open. ``True`` if handled.

        Dismissing means "stop", so there is deliberately no further model
        call — but the turn itself never closed, and something has to say so or
        the session keeps reading as busy on every client.

        Returns ``False`` when this team's lead is not bound to *session_id*,
        which happens whenever a team is looked up by its coding-registry key:
        an evicted team is rebuilt with a freshly minted lead session. Driving
        the lead then would end a turn on the wrong stream, so the caller must
        close the stream directly instead.
        """
        if self.lead.session_id != session_id:
            return False

        # Free the lead without starting a turn.
        self.lead.clear_question_suspension()
        # A pending row means the turn never closed, so let the canonical closer
        # close it: it drains a message queued while the lead was still working,
        # which a bare ``done`` would strand.
        self._has_active_turn = True
        try:
            await self._try_emit_done()
        except Exception as exc:
            logger.warning(
                "question_dismiss_turn_end_failed session_id={} error={}",
                session_id,
                exc,
            )
        return True

    async def _try_emit_done(self) -> None:
        """Emit 'done' when lead + all live members are idle.

        Called from every member's _run_activation finally block.
        Guard: only fires after at least one user turn has started.
        """
        if not self._has_active_turn:
            return
        lead_done = self.lead.state in ("idle", "error")
        all_members_done = all(
            m.state in ("idle", "error") for m in self.members.values()
        )
        if lead_done and all_members_done:
            self._has_active_turn = False  # reset for next turn
            session_id = self.lead.session_id

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
                logger.warning("team_emit_done_failed error={}", exc)
            logger.info("team_turn_done session_id={}", session_id)

    async def _emit_completion_notification(self, session_id: str) -> None:
        try:
            session_uuid = UUID(session_id)
        except ValueError:
            return

        title: str | None = None
        mode: str | None = None
        workspace: str | None = None
        try:
            db_factory = resolve_db_factory(self.lead.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, session_uuid)
                if row is not None:
                    title = row.title
                    mode = row.mode
                    workspace = row.workspace
        except Exception as exc:
            logger.warning(
                "team_completion_notification_metadata_failed session_id={} error={}",
                session_id,
                exc,
            )

        workspace_name = (
            Path(workspace).name if mode == "coding" and workspace else None
        )
        notification_title = (
            f"Session completed - {workspace_name}"
            if workspace_name
            else "Session completed"
        )
        title_text = title.strip() if title else ""
        notification_body = title_text or f"Session {session_id[:8]}"
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
                    "title": title,
                    "mode": mode,
                    "workspace": workspace,
                },
            },
        )

    async def _try_activate_queued_after_lead_turn(self) -> None:
        """Wake the lead with queued user messages as soon as its loop ends.

        Team ``done`` still waits for all members to finish. This only shortens
        the handoff from the persisted queue into the lead mailbox when the lead
        has completed its own activation but delegated members are still busy.
        """
        if not self._has_active_turn:
            return
        if self.lead.state not in ("idle", "error"):
            return

        if not self.mailbox.inbox_empty(self.lead.name):
            return

        if await self._activate_queued_user_messages(self.lead.session_id):
            self._has_active_turn = True

        # If sending to the mailbox did not spawn a new lead activation because
        # the lead was still marked working by its finally block, start it after
        # returning to idle.
        if not self.mailbox.inbox_empty(self.lead.name) and not is_busy(
            self.lead.state
        ):
            self.lead._maybe_activate()

    async def _activate_queued_user_messages(self, session_id: str) -> bool:
        try:
            session_uuid = UUID(session_id)
        except ValueError:
            return False

        db_factory = resolve_db_factory(self.lead.db_factory)
        async with db_factory() as db:
            queued = await pop_queued_user_messages(db, session_uuid)
            if not queued:
                await db.commit()
                return False
            await db.commit()

        # Starting a fresh turn blob is only correct when the *whole* team is
        # idle. When the lead finished but delegated members are still
        # streaming, this same function is called from the route's lead-idle
        # queue branch and from ``_try_activate_queued_after_lead_turn``.
        # Resetting the shared stream state there would wipe those members'
        # accumulated replay state (tool calls, content, and their
        # ``working`` agent_status), which makes their tool cards vanish and
        # drops the working status on the next reconnect. Keep the existing
        # turn blob in that case and let the new lead turn append to it.
        any_agent_still_streaming = any(is_busy(m.state) for m in self.all_members)
        if not any_agent_still_streaming:
            try:
                await stream_store.init_turn(session_id, keep_subscribers=True)
            except Exception as exc:
                logger.warning("team_init_queued_turn_failed error={}", exc)
                return False

        message_ids = [str(row.id) for row in queued]
        await stream_store.push_event(
            session_id,
            StreamEnvelope.from_parts(
                "queued_turn_start",
                {
                    "type": "queued_turn_start",
                    "agent": self.lead.name,
                    "message_ids": message_ids,
                    "messages": [
                        {"id": str(row.id), "content": row.content or ""}
                        for row in queued
                    ],
                },
            ),
        )
        self._has_active_turn = True
        for row in queued:
            msg = Message(
                from_agent="user",
                to_agent=self.lead.name,
                content=f"[user]: {row.content or ''}",
            )
            await self.mailbox.send(to=self.lead.name, message=msg)
        logger.info(
            "team_queued_messages_activated session_id={} count={} message_ids={}",
            session_id,
            len(queued),
            message_ids,
        )
        return True

    # ------------------------------------------------------------------
    # User message entry point
    # ------------------------------------------------------------------

    async def handle_user_message(
        self,
        content: str,
        session_id: str,
        interrupt: bool = False,
        attachment_metas: list[dict] | None = None,
        mention_context_blocks: list[str] | None = None,
        mode: str | None = None,
        workspace: str | None = None,
        model: str | None = None,
        model_provided: bool = False,
        thinking_level: str | None = None,
        thinking_level_provided: bool = False,
        service_tier: str | None = None,
        mentions: list[str] | None = None,
        origin: str = "user",
    ) -> tuple[str, str]:
        """Deliver a user message to the team lead. Returns ``(session_id, message_id)``.

        ``session_id`` controls which conversation the lead continues.
        Passing a new UUID starts a fresh lead conversation. ``message_id`` is
        the id of the persisted user message row — callers use it to give the
        frontend's optimistic bubble a stable id that matches the eventual
        persisted row exactly, instead of reconciling by content/timestamp.

        If interrupt=True, all working agents are cancelled immediately and
        all non-completed tasks are reset so the lead can re-plan.

        The caller should subscribe to GET /team/stream/{session_id} to
        receive the SSE event stream.
        """
        # Update the lead's active session

        if mode is not None:
            self.mode = mode
        if workspace is not None:
            self.workspace = workspace

        is_new_session = self.lead.session_id != session_id
        if is_new_session:
            await self.attach_lead_to_session(
                session_id, title=content[:100] if content else None
            )

        # A question on screen owns the turn. A person typing instead of
        # answering has moved on, so the question is superseded. A machine
        # (scheduler) must not make that call for them — it defers.
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
            cancelled = [m for m in self.all_members if is_busy(m.state)]
            for member in cancelled:
                member._cancel_event.set()

            logger.info(
                "team_interrupted cancelled={}",
                [m.name for m in cancelled],
            )
            # Stop is team-wide and outranks a pending question: leaving the
            # row open would keep the session badged "needs input" with no turn
            # left to resume.
            await self.dismiss_pending_question(reason="dismissed")
        # Persist the user message before any turn state or mailbox delivery.
        db_factory = resolve_db_factory(self.lead.db_factory)
        lead_uuid = UUID(session_id)
        async with db_factory() as db:
            # Heal any tool_calls left orphaned by a previous crash /
            # restart *before* persisting the new user message so the
            # next turn's LLM input is well-formed.  See
            # ``heal_orphaned_tool_calls`` for the full rationale.
            await heal_orphaned_tool_calls(db, lead_uuid)

            lead_row = await db.get(ChatSession, lead_uuid)
            effective_model = model if model_provided else None
            effective_thinking_level = (
                thinking_level if thinking_level_provided else None
            )
            if lead_row is not None:
                lead_row.mode = self.mode
                lead_row.workspace = self.workspace
                if model_provided:
                    lead_row.model = model
                if thinking_level_provided:
                    lead_row.thinking_level = thinking_level
                effective_model = lead_row.model or self.lead.agent.model_id
                effective_thinking_level = lead_row.thinking_level
                # A scheduler-owned session has no human watching it, so the
                # lead must not be offered ``ask_user``.
                self.lead.is_scheduler_session = (
                    lead_row.scheduled_task_name is not None
                )
                db.add(lead_row)
            else:
                effective_model = model or self.lead.agent.model_id

            user_msg = HumanMessage(content=content)
            msg_extra: dict | None = (
                {"attachments": attachment_metas} if attachment_metas else None
            )
            if mentions:
                if msg_extra is None:
                    msg_extra = {}
                msg_extra["mentions"] = mentions

            workspace_path = session_workspace_dir(str(lead_uuid), self.workspace)
            snapshot_hash = await snapshot_service.track(str(lead_uuid), workspace_path)
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
                db, lead_uuid, user_msg, extra=msg_extra
            )

            for synthetic_content in mention_context_blocks or []:
                await save_message(
                    db,
                    lead_uuid,
                    HumanMessage(content=synthetic_content),
                    extra={
                        "hidden_from_user": True,
                        "hidden_from_summary": True,
                        "attachment_for_message_id": str(saved_user_msg.id),
                        "mention_context": True,
                    },
                )

            member_ids: list[UUID] = []
            for member in self.members.values():
                try:
                    member_ids.append(UUID(member.session_id))
                except Exception as inner_exc:
                    logger.warning(
                        "team_parent_member_session_failed member={} error={}",
                        member.name,
                        inner_exc,
                    )
            if member_ids:
                try:
                    stmt = (
                        sa.update(ChatSession)
                        .where(col(ChatSession.id).in_(member_ids))
                        .where(
                            sa.or_(
                                col(ChatSession.parent_session_id).is_(None),
                                col(ChatSession.parent_session_id) != lead_uuid,
                            )
                        )
                        .values(parent_session_id=lead_uuid)
                    )
                    await db.exec(stmt)
                except Exception as inner_exc:
                    logger.warning(
                        "team_parent_member_sessions_failed error={}", inner_exc
                    )

            await db.commit()

        # Initialise a fresh state blob for this turn synchronously before
        # delivering the message to the lead. This guarantees the state key
        # exists by the time the client's GET /team/stream/{sid} arrives.
        try:
            await stream_store.init_turn(session_id)
        except Exception as exc:
            logger.warning("team_init_turn_failed error={}", exc)

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

        # Mark that a turn is now active
        self._has_active_turn = True

        # Deliver user message to lead inbox (on_message callback activates lead)
        msg = Message(
            from_agent="user",
            to_agent=self.lead.name,
            content=f"[user]: {content}",
        )
        try:
            await self.mailbox.send(to=self.lead.name, message=msg)
        except BaseException:
            self._has_active_turn = False
            raise

        return session_id, str(saved_user_msg.id)

    async def handle_compact(self, session_id: str) -> str:
        """Start a normal lead turn that forces summarization before the model call."""
        if self._has_active_turn:
            raise ContinuePreconditionError("Lead is already working.")

        try:
            lead_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        db_factory = resolve_db_factory(self.lead.db_factory)
        async with db_factory() as db:
            row = await db.get(ChatSession, lead_uuid)
            if row is None:
                raise ContinuePreconditionError("Session not found.")
            if row.agent_name and row.agent_name != self.lead.name:
                raise ContinuePreconditionError(
                    f"Session belongs to '{row.agent_name}', not '{self.lead.name}'."
                )
            messages = await get_messages_for_llm(db, lead_uuid)
            if not messages:
                raise ContinuePreconditionError("Session has no messages to compact.")
            # Compaction creates a new durable branch, just like sending an
            # edited message after /undo. Drop the undone tail and clear the
            # redo boundary before the summarizer persists its replacement;
            # otherwise the new summary lands beyond that boundary and is
            # immediately treated as reverted itself.
            await cleanup_reverted_tail(db, lead_uuid)
            await db.commit()

        if self.lead.session_id != session_id:
            self.lead.session_id = session_id

        try:
            await stream_store.init_turn(session_id)
        except Exception as exc:
            logger.warning("team_init_turn_failed error={}", exc)

        try:
            self.lead.activate_for_compaction()
        except AlreadyWorkingError as exc:
            raise ContinuePreconditionError(str(exc)) from exc

        self._has_active_turn = True

        logger.info(
            "team_compact_dispatched session_id={} agent={}", session_id, self.lead.name
        )
        return session_id

    async def handle_undo(self, session_id: str) -> tuple[str, BoundaryShift]:
        """Move the revert boundary to the latest visible user turn.

        Returns ``(session_id, shift)`` where ``shift.target`` is the
        user message we landed on and ``shift.added/modified/removed``
        carry the workspace paths the snapshot restore touched. The
        HTTP layer forwards both up to the client so the React store
        can apply the boundary locally *and* splice a scoped Coding
        Workspace diff without a full sidebar refetch.
        """
        if self._has_active_turn:
            raise ContinuePreconditionError("Lead is already working.")
        # A member can still be streaming even when the lead is idle
        # (e.g. delegated turn). Reverting the boundary mid-stream
        # orphans the in-flight assistant tokens on the client, so
        # require the team to be fully quiescent first.
        busy = next(
            (m for m in self.all_members if is_busy(m.state)),
            None,
        )
        if busy is not None:
            raise ContinuePreconditionError(
                f"Agent '{busy.name}' is still working. Stop it before /undo."
            )

        try:
            lead_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        # Serialise concurrent /undo (and /redo) on the same session —
        # see ``_command_locks`` rationale above. The lock spans the
        # whole DB read→commit cycle so a burst of clicks sees each
        # other's committed boundary.
        async with _command_lock(session_id):
            db_factory = resolve_db_factory(self.lead.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, lead_uuid)
                if row is None:
                    raise ContinuePreconditionError("Session not found.")
                if row.agent_name and row.agent_name != self.lead.name:
                    raise ContinuePreconditionError(
                        f"Session belongs to '{row.agent_name}', not '{self.lead.name}'."
                    )
                shift = await undo_session_messages(db, lead_uuid)
                if not shift.applied or shift.target is None:
                    raise ContinuePreconditionError("No user message to undo.")
                await db.commit()
                await db.refresh(shift.target)

        logger.info(
            "team_undo_applied session_id={} agent={}", session_id, self.lead.name
        )
        return session_id, shift

    async def handle_redo(self, session_id: str) -> tuple[str, BoundaryShift]:
        """Move the revert boundary forward or clear it.

        Returns ``(session_id, shift)``. ``shift.target`` is the user
        message the boundary now points at, or ``None`` when the
        boundary was cleared back to the live tip. The path partition
        rides along so the HTTP layer can drive scoped cache
        invalidations on the client, skipping a full history *and*
        sidebar refetch.
        """
        if self._has_active_turn:
            raise ContinuePreconditionError("Lead is already working.")

        try:
            lead_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        # Same per-session serialisation as ``handle_undo`` — two quick
        # /redo clicks must each see the other's committed boundary,
        # otherwise both compute the same ``next_user`` and the
        # boundary moves one step instead of two.
        async with _command_lock(session_id):
            db_factory = resolve_db_factory(self.lead.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, lead_uuid)
                if row is None:
                    raise ContinuePreconditionError("Session not found.")
                if row.agent_name and row.agent_name != self.lead.name:
                    raise ContinuePreconditionError(
                        f"Session belongs to '{row.agent_name}', not '{self.lead.name}'."
                    )
                shift = await redo_session_messages(db, lead_uuid)
                if not shift.applied:
                    raise ContinuePreconditionError("No undone message to redo.")
                await db.commit()
                if shift.target is not None:
                    await db.refresh(shift.target)

        logger.info(
            "team_redo_applied session_id={} agent={}", session_id, self.lead.name
        )
        return session_id, shift

    async def handle_redo_all(self, session_id: str) -> tuple[str, BoundaryShift]:
        """Clear the revert boundary back to the live tip in one step.

        Returns ``(session_id, shift)``. ``shift.target`` is ``None``.
        The path partition rides along so the HTTP layer can drive scoped
        cache invalidations on the client.
        """
        if self._has_active_turn:
            raise ContinuePreconditionError("Lead is already working.")

        try:
            lead_uuid = UUID(session_id)
        except ValueError as exc:
            raise ContinuePreconditionError("Invalid session id.") from exc

        async with _command_lock(session_id):
            db_factory = resolve_db_factory(self.lead.db_factory)
            async with db_factory() as db:
                row = await db.get(ChatSession, lead_uuid)
                if row is None:
                    raise ContinuePreconditionError("Session not found.")
                if row.agent_name and row.agent_name != self.lead.name:
                    raise ContinuePreconditionError(
                        f"Session belongs to '{row.agent_name}', not '{self.lead.name}'."
                    )
                shift = await redo_all_session_messages(db, lead_uuid)
                if not shift.applied:
                    raise ContinuePreconditionError("No undone message to redo.")
                await db.commit()

        logger.info(
            "team_redo_all_applied session_id={} agent={}", session_id, self.lead.name
        )
        return session_id, shift

    async def _restore_or_drop_members_for_lead(self, lead_session_id: str) -> None:
        """Realign live spawned instances to child sessions of *lead_session_id*.

        For each currently-live ``blueprint#N`` instance:
          - If a child ``ChatSession`` row with matching ``agent_name``
            exists under this lead, point the member at it (history is
            preserved).
          - Otherwise, dismiss it: the lead can re-spawn it explicitly,
            and we don't want to silently mint a fresh DB session for a
            member that may have been spawned for a different conversation.

        Plain-name eager members (those constructed directly via the
        ``members=`` constructor kwarg, used by tests) are left untouched —
        they own their own session id and are not part of the dynamic
        blueprint roster.
        """
        if not self.members:
            return

        db_factory = resolve_db_factory(self._db_factory or self.lead.db_factory)
        try:
            lead_uuid = UUID(lead_session_id)
        except ValueError:
            return  # caller passed a non-UUID; nothing we can do

        try:
            handles = list(self.members.keys())
            async with db_factory() as db:
                # One batched query for the whole roster (was one SELECT per
                # member). Rank child sessions within each handle so SQLite
                # returns at most one row per live member.
                ranked = (
                    select(
                        col(ChatSession.id).label("id"),
                        func.row_number()
                        .over(
                            partition_by=col(ChatSession.agent_name),
                            order_by=col(ChatSession.created_at).desc(),
                        )
                        .label("rank"),
                    )
                    .where(col(ChatSession.parent_session_id) == lead_uuid)
                    .where(col(ChatSession.agent_name).in_(handles))
                    .subquery()
                )
                result = await db.exec(
                    select(ChatSession)
                    .join(ranked, col(ChatSession.id) == ranked.c.id)
                    .where(ranked.c.rank == 1)
                )
                newest_by_handle = {
                    row.agent_name: row for row in result.all() if row.agent_name
                }

                for handle, member in list(self.members.items()):
                    is_spawned = parse_instance_handle(handle) is not None
                    existing = newest_by_handle.get(handle)
                    if existing is not None:
                        # Realign to the existing child row regardless of
                        # whether the member was blueprint-spawned or eager:
                        # this preserves the legacy "restart restores
                        # members" behaviour.
                        member.session_id = str(existing.id)
                    elif is_spawned:
                        # No child session for this lead AND it's a
                        # blueprint-spawned instance → drop it.  The lead
                        # can re-spawn explicitly.  Eager / test-injected
                        # members are left in place with their existing
                        # session id.
                        await self._dismiss_live_member(handle)
        except Exception as exc:
            logger.warning("team_restore_members_failed error={}", exc)

        await self._rewake_members_with_open_tasks(lead_session_id)

    async def _rewake_members_with_open_tasks(self, lead_session_id: str) -> None:
        """Re-wake surviving members whose board tasks outlived the mailbox.

        The todo store persists across restarts; in-flight mailbox messages
        (including assignment wakes) do not.  After realigning the roster,
        any live member holding a claimed in-progress task or an assigned,
        unblocked pending task gets a system wake so the work resumes without
        the lead having to notice and re-delegate.
        """
        if not self.members:
            return
        try:
            import json as _json

            from app.agent.artifacts import todos_path
            from app.agent.mode.team.board import (
                format_resume_message,
                resumable_tasks,
            )

            path = todos_path(lead_session_id)
            if not path.exists():
                return
            store = _json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(store, dict):
                return

            for handle in list(self.members.keys()):
                tasks = [
                    task
                    for task in resumable_tasks(store, handle)
                    if f"{lead_session_id}:{task.get('task_id')}"
                    not in self._restore_rewakes
                ]
                if not tasks:
                    continue
                self._restore_rewakes.update(
                    f"{lead_session_id}:{task.get('task_id')}" for task in tasks
                )
                logger.info(
                    "team_restore_rewake handle={} tasks={}",
                    handle,
                    [t.get("task_id") for t in tasks],
                )
                await self.mailbox.send(
                    to=handle,
                    message=Message(
                        from_agent="system",
                        to_agent=handle,
                        content=format_resume_message(tasks),
                    ),
                )
        except Exception as exc:
            # Best-effort: a failed re-wake must never block session restore.
            logger.warning("team_restore_rewake_failed error={}", exc)

    # ------------------------------------------------------------------
    # Spawn / dismiss
    # ------------------------------------------------------------------

    async def spawn(
        self,
        blueprint: str,
        *,
        instance_id: int | None = None,
    ) -> TeamMember:
        """Materialise a member instance from a blueprint and register it.

        Args:
            blueprint: Blueprint name (matches a ``.md`` file's ``name:``).
            instance_id: If given, spawn (or restore) the instance with that
                ``#N``.  If a DB ``ChatSession`` already exists for this
                ``(lead_session, handle)`` it is restored (history preserved).
                Otherwise a fresh session is created.  When omitted, the
                next free ``#N`` is auto-assigned (handles auto-suffixing
                when the same blueprint is spawned multiple times).

        Raises:
            KeyError: blueprint not found.
            ValueError: instance with that handle is already live.
        """
        async with self._roster_lock:
            return await self._spawn_locked(blueprint, instance_id=instance_id)

    async def _spawn_locked(
        self,
        blueprint: str,
        *,
        instance_id: int | None,
    ) -> TeamMember:
        bp = self.blueprints.get(blueprint)
        if bp is None:
            idle = sorted(self.blueprints.keys())
            raise KeyError(f"Unknown blueprint '{blueprint}'. Available: {idle}.")

        # Reconcile counter for this lead session if not yet done.  This
        # ensures auto-assigned ``#N`` values are restart-safe and don't
        # collide with old child sessions.
        await self._reconcile_counter(bp)

        if instance_id is None:
            instance_id = bp.next_instance_id
            # Skip over any handle that's already live for this blueprint.
            while make_instance_handle(blueprint, instance_id) in self.members:
                instance_id += 1
            bp.next_instance_id = instance_id + 1
        else:
            if instance_id < 1:
                raise ValueError(f"instance_id must be >= 1 (got {instance_id}).")
            # Keep the auto-counter ahead of any explicit id so subsequent
            # auto-spawns don't immediately collide.
            if instance_id >= bp.next_instance_id:
                bp.next_instance_id = instance_id + 1

        handle = make_instance_handle(blueprint, instance_id)
        if handle in self.members:
            raise ValueError(f"Instance '{handle}' is already live.")

        # Build the agent from the blueprint's .md file.
        from app.agent.loader import rebuild_agent_from_disk

        agent = rebuild_agent_from_disk(
            bp.source_path,
            provider_factory=self._provider_factory,
            extra_tools=self._extra_tools,
            mode=self.mode,
        )
        # The blueprint name on disk is e.g. ``executor``; the runtime name
        # (mailbox key, DB ``agent_name``) is the instance handle.
        agent.name = handle

        member = TeamMember(agent, db_factory=self._db_factory)

        # Resolve session id: restore if an existing row matches this
        # (lead, handle) — including the legacy "bare blueprint name"
        # adoption for instance #1 (see ``_resolve_session_for_handle``).
        session_id = await self._resolve_session_for_handle(blueprint, handle)
        if session_id is not None:
            member.session_id = session_id
        # Ensure the row exists (idempotent on restore) and parent it
        # under the current lead session so the team-history endpoint
        # and the counter reconciler can find it.
        await member._ensure_db_session(mode=self.mode, workspace=self.workspace)
        await self._parent_member_session(member)

        # Register with mailbox.  The team is currently started iff the
        # lead has a registered inbox; in that case we activate immediately
        # so any queued messages are picked up.
        member.register(self)
        self.members[handle] = member
        self._members_by_name[handle] = member
        await self._emit(
            agent=handle,
            event="agent_status",
            status="idle",
            extra={"blueprint": blueprint},
        )

        logger.info(
            "team_member_spawned blueprint={} handle={} session_id={}",
            blueprint,
            handle,
            member.session_id,
        )
        await self._persist_roster_change(f"Member spawned: {handle}.")
        return member

    async def _persist_roster_change(self, change: str) -> None:
        """Persist an LLM-visible, UI-hidden roster-change marker."""
        try:
            lead_uuid = UUID(self.lead.session_id)
        except (ValueError, AttributeError):
            return

        live = ", ".join(sorted(self.members)) or "none"
        content = f"[system]: Available members changed. {change} Live members: {live}."
        db_factory = resolve_db_factory(self._db_factory or self.lead.db_factory)
        try:
            async with db_factory() as db:
                await save_message(
                    db,
                    lead_uuid,
                    HumanMessage(content=content),
                    exclude_from_context=False,
                    extra={
                        "hidden_from_user": True,
                        "hidden_from_summary": True,
                        "roster_change": True,
                    },
                )
                await db.commit()
        except Exception as exc:
            logger.warning("team_roster_change_persist_failed error={}", exc)

    async def _parent_member_session(self, member: TeamMember) -> None:
        """Set ``parent_session_id`` on *member*'s DB row to the lead's session.

        The team's lead session is the canonical parent for all member
        sessions.  ``handle_user_message`` already does this for *every*
        member at the start of a turn, but spawn happens mid-turn so we
        need to set it eagerly so counter reconciliation, history APIs,
        and dismiss-then-respawn all see the row under the right lead.
        """
        try:
            lead_uuid = UUID(self.lead.session_id)
            member_uuid = UUID(member.session_id)
        except (ValueError, AttributeError):
            return

        db_factory = resolve_db_factory(self._db_factory or self.lead.db_factory)
        try:
            async with db_factory() as db:
                row = await db.get(ChatSession, member_uuid)
                if row is None:
                    return
                if row.parent_session_id != lead_uuid:
                    row.parent_session_id = lead_uuid
                    db.add(row)
                    await db.commit()
        except Exception as exc:
            logger.warning(
                "team_parent_member_session_failed handle={} error={}",
                member.name,
                exc,
            )

    async def dismiss(self, handle: str) -> bool:
        """Stop and deregister an instance by handle.  Returns ``True`` if found.

        DB session row is preserved so the instance can later be respawned
        with its history intact via ``spawn(blueprint, instance_id=N)``.
        """
        async with self._roster_lock:
            return await self._dismiss_live_member(handle)

    async def _dismiss_live_member(self, handle: str) -> bool:
        member = self.members.get(handle)
        if member is None:
            return False
        try:
            await member.stop()
        except Exception as exc:
            logger.warning("team_dismiss_stop_failed handle={} error={}", handle, exc)
        self.members.pop(handle, None)
        self._members_by_name.pop(handle, None)
        logger.info("team_member_dismissed handle={}", handle)
        await self._persist_roster_change(f"Member dismissed: {handle}.")
        await self._emit(agent=handle, event="agent_status", status="offline")
        return True

    # ------------------------------------------------------------------
    # Counter reconciliation + session resolution
    # ------------------------------------------------------------------

    async def _reconcile_counter(self, bp: "MemberBlueprint") -> None:
        """Seed ``bp.next_instance_id`` from the DB for the current lead session.

        Counter scope is **per-lead-session**: each fresh chat starts a
        blueprint at ``#1``.  The DB is the source of truth — the counter
        becomes ``max(existing #N for this lead) + 1`` so it survives a
        process restart in the middle of a live conversation.

        The first time a session sees a particular blueprint with no
        ``#N`` rows but an existing legacy bare-name row, the bare name is
        adopted as ``#1`` (see ``_resolve_session_for_handle``).
        """
        lead_session_id = self.lead.session_id
        if bp.counter_reconciled_for == lead_session_id:
            return

        try:
            lead_uuid = UUID(lead_session_id)
        except (ValueError, AttributeError):
            bp.counter_reconciled_for = lead_session_id
            return

        db_factory = resolve_db_factory(self._db_factory or self.lead.db_factory)
        max_n = 0
        try:
            async with db_factory() as db:
                # Look only at rows that already use the new ``blueprint#N``
                # naming.  Legacy bare-name rows are NOT counted here —
                # they are adopted as ``#1`` on first spawn (see
                # ``_resolve_session_for_handle``), and counting them as
                # ``#1`` ahead of time would cause the first spawn to
                # auto-pick ``#2`` and skip the adoption opportunity.
                result = await db.exec(
                    select(ChatSession.agent_name).where(
                        col(ChatSession.parent_session_id) == lead_uuid
                    )
                )
                names = result.all()
                for name in names:
                    if not name:
                        continue
                    parsed = parse_instance_handle(name)
                    if parsed and parsed[0] == bp.name:
                        max_n = max(max_n, parsed[1])
        except Exception as exc:
            logger.warning(
                "team_counter_reconcile_failed blueprint={} error={}",
                bp.name,
                exc,
            )

        bp.next_instance_id = max_n + 1
        bp.counter_reconciled_for = lead_session_id

    async def _resolve_session_for_handle(
        self,
        blueprint: str,
        handle: str,
    ) -> str | None:
        """Return an existing DB session id for this (lead, handle), if any.

        Adoption rule: the very first time blueprint ``X`` is spawned for a
        given lead session as ``X#1`` AND no row already exists for the
        ``X#1`` agent_name, but a legacy bare-name row ``X`` exists under
        the same lead — adopt that row as ``X#1`` (rewrite ``agent_name``
        in place).  This makes the move from the old single-instance model
        lossless: the lead's existing ``executor`` history shows up under
        ``executor#1`` without manual migration.
        """
        try:
            lead_uuid = UUID(self.lead.session_id)
        except (ValueError, AttributeError):
            return None

        db_factory = resolve_db_factory(self._db_factory or self.lead.db_factory)
        try:
            async with db_factory() as db:
                # 1) Exact handle match (e.g. respawning ``executor#3``).
                result = await db.exec(
                    select(ChatSession)
                    .where(col(ChatSession.parent_session_id) == lead_uuid)
                    .where(col(ChatSession.agent_name) == handle)
                    .order_by(col(ChatSession.created_at).desc())
                    .limit(1)
                )
                row = result.first()
                if row is not None:
                    return str(row.id)

                # 2) Legacy adoption — only for the ``#1`` instance.
                parsed = parse_instance_handle(handle)
                if parsed is not None and parsed == (blueprint, 1):
                    legacy_q = await db.exec(
                        select(ChatSession)
                        .where(col(ChatSession.parent_session_id) == lead_uuid)
                        .where(col(ChatSession.agent_name) == blueprint)
                        .order_by(col(ChatSession.created_at).desc())
                        .limit(1)
                    )
                    legacy = legacy_q.first()
                    if legacy is not None:
                        legacy.agent_name = handle
                        db.add(legacy)
                        await db.commit()
                        logger.info(
                            "team_member_legacy_adopted blueprint={} handle={} "
                            "session_id={}",
                            blueprint,
                            handle,
                            legacy.id,
                        )
                        return str(legacy.id)
        except Exception as exc:
            logger.warning(
                "team_resolve_session_failed handle={} error={}", handle, exc
            )
        return None

    # ------------------------------------------------------------------
    # Recipient resolution (for team_message)
    # ------------------------------------------------------------------

    def resolve_recipient(self, name: str) -> str | None:
        """Resolve a recipient name to a live mailbox key.

        - Exact handle match (``executor#2``) → returned as-is if live.
        - Bare blueprint name (``executor``) → routes to the unique live
          instance if exactly one exists.  Returns ``None`` to signal
          ambiguity (caller should produce a tailored error) when zero or
          multiple live instances exist.
        - Lead name → returned as-is.

        Returns the live name to address, or ``None`` if there is no
        unambiguous match.
        """
        if name == self.lead.name:
            return name
        if name in self.members:
            return name
        # Bare blueprint name: collect all live ``blueprint#N`` instances.
        candidates = [
            handle
            for handle in self.members
            if (parsed := parse_instance_handle(handle)) is not None
            and parsed[0] == name
        ]
        if len(candidates) == 1:
            return candidates[0]
        return None

    def live_instances_for_blueprint(self, blueprint: str) -> list[str]:
        """Return live instance handles for *blueprint* in spawn order."""
        matches: list[tuple[int, str]] = []
        for handle in self.members:
            parsed = parse_instance_handle(handle)
            if parsed is not None and parsed[0] == blueprint:
                matches.append((parsed[1], handle))
        matches.sort(key=lambda x: x[0])
        return [handle for _, handle in matches]

    # ------------------------------------------------------------------
    # Tool injection
    # ------------------------------------------------------------------

    def get_injected_tools(self, agent_name: str) -> list[Tool]:
        """Return runtime tools to inject into agent.run() for the given agent.

        Everyone gets ``team_message`` and a board-aware ``todo_manage``
        (mutations dispatch activation events — see
        :mod:`app.agent.mode.team.board`). The lead additionally gets
        ``team_manage`` (roster spawn/dismiss).
        """
        from app.agent.mode.team.board import make_team_todo_tool

        role = "lead" if agent_name == self.lead.name else "member"
        tools: list[Tool] = [
            make_team_message_tool(
                self.mailbox, agent_name=agent_name, role=role, team=self
            ),
            make_team_todo_tool(self, agent_name=agent_name, role=role),
        ]

        # LSP navigation tool is temporarily detached — agents were not using
        # it. Code kept in app/agent/tools/builtin/lsp.py for future reuse.
        # if self.mode == "coding":
        #     from app.agent.tools.builtin.lsp import lsp_navigation
        #
        #     tools.append(lsp_navigation)

        if agent_name == self.lead.name:
            tools.append(make_team_manage_tool(self))
            if self._question_tool_enabled():
                tools.append(make_ask_user_tool(self))

        return tools

    async def _has_open_question(self) -> bool:
        """Cheap existence check for an unanswered question on the lead session."""
        from app.services import question_service

        try:
            db_factory = resolve_db_factory(self.lead.db_factory)
            async with db_factory() as db:
                return (
                    await question_service.get_pending_question(
                        db, UUID(self.lead.session_id)
                    )
                    is not None
                )
        except Exception as exc:
            logger.warning(
                "question_lookup_failed session_id={} error={}",
                self.lead.session_id,
                exc,
            )
            return False

    async def dismiss_pending_question(
        self,
        *,
        reason: "question_service.ResolvedStatus",
        session_id: str | None = None,
    ) -> bool:
        """Close any open question on *session_id* and free the lead.

        Used by Stop (team-wide interrupt) and by a superseding user message.
        Returns ``True`` when a question was actually closed.

        ``session_id`` defaults to the lead's own binding, but callers that
        already know which session they are acting on should pass it. A coding
        team is cached per (workspace, session) and rebuilt after the idle
        window with a *freshly minted* lead session id — only
        ``handle_user_message`` rebinds it. An interrupt-only request returns
        before that runs, so trusting the lead's binding there searches a
        session that never had a question and closes nothing.
        """
        from app.services import question_service

        target_session = session_id or self.lead.session_id
        try:
            db_factory = resolve_db_factory(self.lead.db_factory)
            async with db_factory() as db:
                pending = await question_service.get_pending_question(
                    db, UUID(target_session)
                )
                if pending is None:
                    # Not an error — most interrupts have no question open. Logged
                    # because a silent ``False`` here is indistinguishable from a
                    # dismissal that targeted the wrong session.
                    logger.debug(
                        "question_dismiss_nothing_pending session_id={} reason={}",
                        target_session,
                        reason,
                    )
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

        # Only free the lead when the question was actually its own; a stale
        # binding means this suspension belongs to some other session's turn.
        if target_session == self.lead.session_id:
            self.lead.clear_question_suspension()

        # The card is only on screen. Every other resolution path broadcasts;
        # without this one a client that typed instead of answering keeps an
        # open question the server has already closed, with no way to find out
        # until a reload.
        from app.agent.schemas.events import QuestionDismissedEvent
        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

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
            # The row is already closed; a failed fan-out only costs the client
            # a refetch on reconnect.
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
        """Whether the lead may interrupt the user with ``ask_user``.

        Coding mode only (that is where a wrong guess costs real work), lead
        only (members escalate through ``team_message``), and never on a
        scheduler-owned session — a cron job has no one to answer, and a tool
        the model cannot usefully call is better left out of the schema than
        offered and refused.
        """
        if self.mode != "coding":
            return False
        return not getattr(self.lead, "is_scheduler_session", False)

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    @property
    def all_members(self) -> list[TeamMemberBase]:
        """Lead + all live members (instances)."""
        return [self.lead, *self.members.values()]

    def status(self) -> dict:
        """Return current state of all live agents + blueprint roster."""
        return {
            "lead": {
                "name": self.lead.name,
                "state": self.lead.state,
                "model": self.lead.agent.llm_provider.model,
            },
            "members": [
                {
                    "name": m.name,
                    "state": m.state,
                    "model": m.agent.llm_provider.model,
                }
                for m in self.members.values()
            ],
            "blueprints": [
                {
                    "name": bp.name,
                    "description": bp.description,
                    "live_instances": self.live_instances_for_blueprint(bp.name),
                }
                for bp in self.blueprints.values()
            ],
        }
