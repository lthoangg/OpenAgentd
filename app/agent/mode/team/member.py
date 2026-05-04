"""Team member classes — TeamMemberBase, TeamLead, TeamMember.

TeamMemberBase holds the shared worker infrastructure (activation, inbox, history).
TeamLead and TeamMember subclass it with role-specific behaviour:
- TeamLead: no safety-net, skips user-only inbox persistence, owns lead protocol
- TeamMember: safety-net auto-reply, member protocol

Agents do **not** run persistent background loops.  Instead, they are
*activated on demand*: when a message arrives in their mailbox the team calls
``_maybe_activate()`` which spawns a single ``asyncio.Task`` that drains the
inbox, calls ``agent.run()``, and returns to ``available`` state.

Streaming is handled by StreamPublisherHook, which pushes every LLM delta
directly to the shared in-memory stream store (keyed by the team lead's session_id).
The frontend subscribes to GET /team/stream/{lead_session_id} and receives a
unified event feed tagged by agent name.
"""

from __future__ import annotations

import abc
import asyncio
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from uuid import uuid7

from loguru import logger

from sqlmodel import col, select

from app.agent.agent_loop import Agent
from app.agent.checkpointer import SQLiteCheckpointer
from app.agent.drift import detect_drift, stamp_agent_files
from app.agent.hooks.base import BaseAgentHook
from app.agent.hooks.dynamic_prompt import inject_current_date
from app.agent.hooks.memory_flush import build_memory_flush_hook
from app.agent.hooks.wiki_injection import default_wiki_injection_hook
from app.agent.hooks.otel import OpenTelemetryHook
from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.hooks.summarization import build_summarization_hook
from app.agent.hooks.title_generation import build_title_generation_hook
from app.agent.mode.team.hooks.team_inbox import TeamInboxHook
from app.agent.mode.team.hooks.team_prompt import AgentTeamProtocolHook
from app.agent.hooks.tool_result_offload import ToolResultOffloadHook
from app.agent.plugins.role import reset_role, set_role
from app.agent.sandbox import SandboxConfig, _sandbox_ctx, set_sandbox
from app.core.paths import workspace_dir
from app.agent.permission import (
    AutoAllowPermissionService,
    set_permission_service,
    _permission_ctx,
)
from app.agent.schemas.agent import RunConfig
from app.agent.schemas.chat import HumanMessage
from app.agent.mode.team.mailbox import Message
from app.core.db import DbFactory, resolve_db_factory
from app.models.chat import ChatSession, SessionMessage
from app.services.chat_service import get_messages_for_llm, save_message

if TYPE_CHECKING:
    from app.agent.mode.team.mailbox import TeamMailbox
    from app.agent.mode.team.team import AgentTeam


# -- Protocol prompt blocks (shared by build_protocol) -------------------------

LEAD_MESSAGE_FORMAT = """\
## Message format
- `[name]: content` — message from a teammate (the `[name]:` prefix is added automatically by the system)
- `[user]: content` — message from the user"""

MEMBER_MESSAGE_FORMAT = """\
## Message format
- `[{lead_name}]: content` — message from the team lead
- `[name]: content` — message from a teammate"""

LEAD_COMMUNICATION_RULES = """\
## Communication protocol
- You are working for the **user** — a real person. Everything the team does is to help them.
- Plain text output is visible to the user. Use it only for your final response, or for one brief progress note after delegation.
- **Default: delegate heavy tasks.** Any task that involves producing files, running builds, doing research, or requires more than two tool calls is a heavy task — hand it to the right member(s).
- **Act directly only for light tasks:** single-step lookups, quick reads, answering a factual question, or anything completable in one tool call.
- **Routing guide** (use this when deciding who to delegate to):
  - Building, writing files, running commands → **executor**
  - Research, web search, reading docs or codebases → **explorer**
  - Hard decisions, architecture review, trade-off analysis → **consultant**
  - Multiple concerns → assign multiple members in parallel
- Coordination with members must go through the `team_message` tool. Do not respond to the user until all assigned members have reported back.
- Always format your responses in **Markdown**. No emoji."""

LEAD_PROTOCOL = """\
## Lead workflow
1. Receive user request. Classify: **light or heavy?**
   - Light (single-step, one tool call, factual answer) → handle it yourself directly.
   - Heavy (produces files, needs research, needs reasoning, 3+ steps) → delegate. Do not do this work yourself.
2. When delegating:
   - Identify which members cover the work using the routing guide above.
   - Assign every relevant member **in parallel** via `team_message`.
   - When one member's output feeds another, instruct the producer to send directly to the consumer; the last in the chain reports back to you.
   - Briefly let the user know work is underway (plain text — 1 sentence max).
3. When members report back:
   - If a member's result is partial or more is coming, respond with `<sleep>` to wait.
   - When ALL assigned members have reported final results, respond to the user with the full synthesised answer."""

MEMBER_COMMUNICATION_RULES = """\
## Communication protocol
- **Do not use plain text output.** Every result MUST go through `team_message(to=[recipient])`.
- When you have nothing left to do, end your turn by responding exactly `<sleep>` with no tool calls.
- NEVER send social messages ("hi", "got it", "working on it", "standing by").
- **Collaborate directly with peers.** If you need information, ask the right teammate. If your output feeds into another member's work, send it to them directly via `team_message`. Do not route everything through the lead.
- Do NOT message the lead until your result is complete, unless the lead asked for partial updates or you are blocked.
- Always format your output in **Markdown**."""

MEMBER_PROTOCOL = """\
## Member workflow
1. Receive task instructions via `[{lead_name}]: ...` or from a peer.
2. Do your work (research, write, calculate, etc.).
3. If you need help or input from a peer, call `team_message(to=[peer_name])`, then `<sleep>` — the answer arrives next wake.
4. When sending results to peers, call `team_message` incrementally as you complete batches. State whether the result is partial (more coming) or final.
5. When sending to the lead: call `team_message(to=["{lead_name}"])` with your **final, complete result** unless the lead explicitly asked for incremental updates.
6. If you have nothing to do: `<sleep>` immediately.

**NEVER write plain text without a `team_message` call.**"""


# -- Helpers -------------------------------------------------------------------


async def _append_interrupted_to_last_assistant(
    db_factory: DbFactory, session_id: uuid.UUID
) -> None:
    """Append ' [interrupted]' to the most recent assistant message in the DB session."""
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
                msg.content = (msg.content or "") + " [interrupted]"
                db.add(msg)
                await db.commit()
    except Exception as exc:
        logger.warning(
            "append_interrupted_failed session_id={} error={}", session_id, exc
        )


# =============================================================================
# TeamMemberBase — shared worker infrastructure
# =============================================================================


class TeamMemberBase(abc.ABC):
    """Base class for team agents.  Owns on-demand activation, inbox, and history.

    Agents do **not** run a persistent background loop.  When a message arrives
    in the mailbox, ``_maybe_activate()`` is called.  If the agent is already
    working the message just queues; otherwise a one-shot ``_run_activation()``
    task is spawned to drain the inbox and call ``agent.run()``.

    Subclasses implement role-specific hooks:
    - ``_on_wake``: called after draining inbox, before processing
    - ``_on_turn_success``: called after _handle_messages succeeds
    - ``_on_turn_error``: called when _handle_messages raises
    - ``_on_turn_finally``: always called in finally block
    - ``build_protocol``: assembles role-specific system prompt protocol
    - ``_skip_inbox_persistence``: whether to skip persisting certain inbox messages
    """

    def __init__(
        self,
        agent: Agent,
        *,
        session_id: str | None = None,
        db_factory: DbFactory | None = None,
    ) -> None:
        self.name = agent.name
        self.agent = agent
        self.session_id: str = session_id or str(uuid7())
        self.db_factory = db_factory

        self.state: Literal["available", "working", "error"] = "available"
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

        # Bound at register() time
        self._team: AgentTeam | None = None
        self._mailbox: TeamMailbox | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def register(self, team: "AgentTeam") -> None:
        """Register this member with the team. Called by AgentTeam.start().

        Registers the mailbox inbox but does **not** spawn any background task.
        The agent becomes ``available`` and will be activated on demand when a
        message arrives.
        """
        self._team = team
        self._mailbox = team.mailbox
        self._mailbox.register(self.name)

        self.state = "available"
        logger.info(
            "team_member_registered name={} session_id={}", self.name, self.session_id
        )

    async def _ensure_db_session(
        self,
        title: str | None = None,
    ) -> None:
        """Ensure a DB chat session row exists for self.session_id."""
        db_factory = resolve_db_factory(self.db_factory)
        session_uuid = uuid.UUID(self.session_id)
        try:
            async with db_factory() as db:
                existing = await db.get(ChatSession, session_uuid)
                if existing is None:
                    row = ChatSession(
                        id=session_uuid,
                        title=title or f"Team {self._role_label}: {self.name}",
                        agent_name=self.name,
                    )
                    db.add(row)
                    await db.commit()
                    logger.info(
                        "team_member_session_created name={} session_id={}",
                        self.name,
                        self.session_id,
                    )
        except Exception as e:
            logger.warning(
                "team_member_session_ensure_failed name={} error={}", self.name, e
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

        if self._mailbox and self.name in self._mailbox.registered_agents:
            self._mailbox.deregister(self.name)

        self.state = "available"
        logger.info("team_member_stopped name={}", self.name)

    # ------------------------------------------------------------------
    # On-demand activation
    # ------------------------------------------------------------------

    def _maybe_activate(self) -> None:
        """Spawn an activation task if the agent is not already working.

        Called by the team's on_message callback when a message arrives.
        If the agent is already working, the message is in the queue and
        ``TeamInboxHook`` will inject it before the next LLM call.
        """
        if self.state == "working":
            return  # already active — inbox hook will drain the new message

        # Me: set state synchronously before create_task so that any
        # _try_emit_done() call that follows in the same coroutine sees
        # "working" and does not fire a premature done event.
        self.state = "working"
        self._active_task = asyncio.create_task(
            self._run_activation(), name=f"activate:{self.name}"
        )

    # ── Live-config drift ──────────────────────────────────────────────

    def refresh_if_dirty(self) -> bool:
        """Detect config drift and rebuild the agent in place if dirty.

        Public wrapper used by callers that want fresh frontmatter without
        reaching into private drift internals (e.g. read-only listing
        endpoints). Safe to call on any member; the caller is responsible
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
        # Deferred — ``app.agent.loader`` imports ``app.agent.mode.team.member``
        # to wire teams; resolving ``rebuild_agent_from_disk`` at call time
        # avoids the cycle without re-introducing one in ``app.agent.drift``.
        from app.agent.loader import rebuild_agent_from_disk

        source = self.agent.source_path
        if source is None:
            self._config_dirty = False
            return

        try:
            new_agent = rebuild_agent_from_disk(source)
        except Exception as exc:
            logger.warning(
                "agent_config_refresh_failed name={} error={}",
                self.name,
                exc,
            )
            from app.agent.mcp.config import config_path as _mcp_config_path
            from app.core.config import settings as _settings

            self.agent.config_stamp = stamp_agent_files(
                agent_md_path=source,
                skill_names=self.agent.skills,
                skills_dir=Path(_settings.SKILLS_DIR),
                mcp_config_path=_mcp_config_path(),
            )
            self._config_dirty = False
            return

        # Re-inject teammates section (same logic as load_team_from_dir).
        if self._team is not None:
            roster_lines = []
            for other in self._team.all_members:
                if other.name == self.name:
                    continue
                role_label = "lead" if other is self._team.lead else "member"
                desc = other.agent.description or other.name
                roster_lines.append(f"- **{other.name}** ({role_label}): {desc}")
            if roster_lines:
                new_agent.system_prompt += (
                    "\n## Teammates\n" + "\n".join(roster_lines) + "\n"
                )

        old_model = self.agent.model_id
        self.agent = new_agent
        self._config_dirty = False
        logger.info(
            "agent_config_refreshed name={} model={} tools={} skills={}",
            self.name,
            new_agent.model_id,
            sorted(new_agent._tools.keys()),
            new_agent.skills,
        )
        if old_model != new_agent.model_id:
            logger.info(
                "agent_model_changed name={} old={} new={}",
                self.name,
                old_model,
                new_agent.model_id,
            )

    async def _run_activation(self) -> None:
        """One-shot activation: drain inbox, process, return to available."""
        assert self._mailbox is not None
        assert self._team is not None

        self._cancel_event.clear()

        # Drain all queued messages
        pending: list[Message] = []
        while not self._mailbox.inbox_empty(self.name):
            try:
                pending.append(self._mailbox.receive_nowait(self.name))
            except asyncio.QueueEmpty:
                break

        if not pending:
            # Spurious activation — nothing to process. Reset state that
            # _maybe_activate pre-set to "working" and bail out.
            self.state = "available"
            return

        # state was already set to "working" by _maybe_activate
        await self._team._emit(agent=self.name, event="agent_status", status="working")
        logger.info(
            "team_member_activated name={} messages={}",
            self.name,
            len(pending),
        )

        # Re-check drift at turn start so edits made between turns
        # (settings UI, external editor, self-healing skill) take effect on
        # the very next turn, not two turns later.
        self._detect_config_drift()
        if self._config_dirty:
            self._refresh_agent_from_disk()

        # Let subclass reset bookkeeping
        self._on_wake(pending)

        # Format + persist inbox RIGHT AFTER receiving (one row per message)
        inbox_msgs = await self._persist_inbox(pending)

        # Emit one inbox SSE per message for split view
        for msg_obj, raw_msg in zip(inbox_msgs, pending):
            if self._should_emit_inbox_sse([raw_msg.from_agent]):
                await self._team._emit(
                    agent=self.name,
                    event="inbox",
                    extra={
                        "content": msg_obj.content,
                        "from_agent": raw_msg.from_agent,
                    },
                )

        try:
            await self._handle_messages()
            await self._on_turn_success()

        except Exception as exc:
            logger.exception("team_member_error name={} error={}", self.name, exc)
            await self._on_turn_error(exc)
            self.state = "error"
            await self._team._emit(
                agent=self.name,
                event="agent_status",
                status="error",
                extra={"message": str(exc)},
            )

        finally:
            self._on_turn_finally()
            if self.state != "error":
                self.state = "available"
            await self._team._emit(
                agent=self.name, event="agent_status", status="available"
            )
            logger.info("team_member_available name={}", self.name)

            # Did mcp.json / agent.md / SKILL.md change during this turn?
            # Drift → rebuild the agent at the start of the next turn.
            self._detect_config_drift()

            # Me: re-activate if messages arrived while agent.run() was executing.
            # agent.run() breaks on <sleep>/final-response without running
            # TeamInboxHook again, so any message queued during that last LLM call
            # sits in the inbox.  Calling _maybe_activate here is safe: state is
            # already "available", so it spawns a fresh activation task that loads
            # history from DB and wakes the agent — exactly like a normal wakeup.
            if not self._mailbox.inbox_empty(self.name):
                logger.info(
                    "team_member_late_inbox_reactivate name={}",
                    self.name,
                )
                self._maybe_activate()

            await self._team._try_emit_done()

    # ------------------------------------------------------------------
    # Abstract / override points
    # ------------------------------------------------------------------

    @property
    @abc.abstractmethod
    def _role_label(self) -> str:
        """Short role label for logs and DB titles (e.g. 'lead', 'member')."""

    @abc.abstractmethod
    def build_protocol(self, base_prompt: str, team: "AgentTeam") -> str:
        """Assemble role-specific protocol-injected system prompt."""

    def _on_wake(self, pending: list[Message]) -> None:
        """Called after draining inbox, before processing. Override to reset bookkeeping."""

    def _skip_inbox_persistence(self, senders: list[str]) -> bool:
        """Return True to skip DB persistence for this inbox batch."""
        return False

    def _should_emit_inbox_sse(self, senders: list[str]) -> bool:
        """Return True to emit an inbox SSE event for this batch."""
        return True

    async def _on_turn_success(self) -> None:
        """Called after _handle_messages completes successfully."""

    async def _on_turn_error(self, exc: Exception) -> None:
        """Called when _handle_messages raises. Override for error recovery."""

    def _on_turn_finally(self) -> None:
        """Called in the finally block of every turn. Override for cleanup."""

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

        for msg in messages:
            # tool always delivers "[agent]: content" — user/broadcast pass through as-is
            content = msg.content

            human_msg = HumanMessage(content=content)
            extra = {
                "from_agent": msg.from_agent,
                "is_broadcast": msg.is_broadcast,
            }

            # Let subclass decide whether to skip persistence
            if not self._skip_inbox_persistence([msg.from_agent]):
                db_factory = resolve_db_factory(self.db_factory)
                session_uuid = uuid.UUID(self.session_id)
                async with db_factory() as db:
                    async with db.begin():
                        saved_row = await save_message(
                            db, session_uuid, human_msg, extra=extra
                        )
                        human_msg.db_id = saved_row.id  # stash db_id for sync()

            result.append(human_msg)

        return result

    # ------------------------------------------------------------------
    # Message handling
    # ------------------------------------------------------------------

    async def _handle_messages(self) -> None:
        """Load full history from DB and call agent.run()."""
        assert self._team is not None

        db_factory = resolve_db_factory(self.db_factory)
        session_uuid = uuid.UUID(self.session_id)

        async with db_factory() as db:
            try:
                history = await get_messages_for_llm(db, session_uuid)
            except Exception:
                history = []

        run_messages = history

        # Build hooks — StreamPublisherHook writes to shared team stream
        lead_session_id = self._team.lead.session_id
        publisher_hook = StreamPublisherHook(
            session_id=lead_session_id,
            agent_name=self.name,
        )

        # Inject team protocol via hook
        team_prompt_hook = AgentTeamProtocolHook(
            team=self._team,
            agent_name=self.name,
        )
        team_inbox_hook = TeamInboxHook(member=self)

        # OTel hook — child span under lead's trace
        otel_hook = OpenTelemetryHook(
            agent_name=self.name,
            model_id=self.agent.model_id,
            lead_session_id=lead_session_id,
        )

        hooks: list[BaseAgentHook] = [
            inject_current_date,
            default_wiki_injection_hook,
            team_prompt_hook,
            team_inbox_hook,
            publisher_hook,
            otel_hook,
        ]

        # Title generation — lead only (members don't need session titles).
        # Returns None with a warning when the feature is disabled or
        # unconfigured — non-fatal, sessions just keep the fallback title.
        if self._role_label == "lead" and self.db_factory:
            title_hook = build_title_generation_hook(
                default_provider=self.agent.llm_provider,
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
                stream_session_id=lead_session_id,
                agent_name=self.name,
            )
            checkpointer.mark_loaded(self.session_id, history)
            # Tool result offload uses the hook's module-level defaults
            # (see app.agent.hooks.tool_result_offload.DEFAULT_CHAR_THRESHOLD).
            hooks.append(ToolResultOffloadHook())
            summ_hook = build_summarization_hook(
                self.agent.llm_provider, self.agent.summarization_config
            )
            if summ_hook:
                # Flush memory before the summariser compresses the window —
                # same threshold so both fire on the same turn, flush first.
                flush_hook = build_memory_flush_hook(
                    llm_provider=self.agent.llm_provider,
                    prompt_token_threshold=summ_hook.prompt_token_threshold,
                )
                if flush_hook is not None:
                    hooks.append(flush_hook)
                hooks.append(summ_hook)

        # Inject team tools
        injected = self._team.get_injected_tools(self.name)

        config = RunConfig(session_id=self.session_id)

        # Scope filesystem tools to per-team workspace
        workspace = str(workspace_dir(lead_session_id))
        session_sandbox = SandboxConfig(workspace=workspace)
        token = set_sandbox(session_sandbox)

        # Scope permission service to this agent run — auto-allows by default,
        # fires SSE events so the frontend can optionally show an approval UI.
        permission_service = AutoAllowPermissionService(session_id=self.session_id)
        perm_token = set_permission_service(permission_service)

        # Scope agent role for plugin applies_to filtering ("lead"/"member").
        role_token = set_role(self._role_label)

        try:
            await self.agent.run(
                run_messages,
                config=config,
                hooks=hooks,
                injected_tools=injected,
                interrupt_event=self._cancel_event,
                checkpointer=checkpointer,
            )
        finally:
            reset_role(role_token)
            _sandbox_ctx.reset(token)
            _permission_ctx.reset(perm_token)

        # If interrupted, mark last assistant message
        if self._cancel_event.is_set() and self.db_factory:
            await _append_interrupted_to_last_assistant(
                self.db_factory, uuid.UUID(self.session_id)
            )


# =============================================================================
# TeamLead — the team coordinator
# =============================================================================


class TeamLead(TeamMemberBase):
    """Team lead agent. Coordinates members, does not do work itself.

    No safety-net, no _replied flag, no task requeue.
    Skips inbox persistence when only "user" senders (already saved by route handler).
    """

    @property
    def _role_label(self) -> str:
        return "lead"

    def _skip_inbox_persistence(self, senders: list[str]) -> bool:
        """Skip for lead when only "user" messages — already saved by route handler."""
        return all(s == "user" for s in senders)

    def _should_emit_inbox_sse(self, senders: list[str]) -> bool:
        """Skip SSE for lead when only user messages — already shown as UserBubble."""
        return any(s != "user" for s in senders)

    async def _on_turn_error(self, exc: Exception) -> None:
        """Emit a user-visible ``error`` event when the lead itself fails.

        Members notify the lead via the mailbox on error, but the lead has no
        one to notify — the failure would otherwise be silent (only an
        ``agent_status=error`` blip in the SSE stream, which the frontend
        treats as a status indicator, not a fatal turn failure).  Emitting a
        typed :class:`ErrorEvent` lets the UI show *why* the turn stopped.
        """
        from app.agent.schemas.events import ErrorEvent
        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

        try:
            await stream_store.push_event(
                self.session_id,
                StreamEnvelope.from_event(
                    ErrorEvent(
                        message=f"Lead agent '{self.name}' failed: {exc}",
                        metadata={"agent": self.name, "exception": type(exc).__name__},
                    )
                ),
            )
        except Exception as push_exc:
            # Defensive: never let an emit failure escape the finally block.
            logger.warning("team_lead_error_emit_failed error={}", push_exc)

    def build_protocol(self, base_prompt: str, team: "AgentTeam") -> str:
        """Assemble lead protocol + roster into system prompt."""
        sections: list[str] = [
            LEAD_COMMUNICATION_RULES,
            LEAD_MESSAGE_FORMAT,
            LEAD_PROTOCOL,
        ]

        # Build roster — list all members
        roster_lines: list[str] = []
        for member in team.members.values():
            desc = member.agent.description or member.name
            roster_lines.append(f"- **{member.name}**: {desc}")
        if roster_lines:
            sections.append("## Team members\n" + "\n".join(roster_lines))

        protocol = "\n\n".join(sections)
        return f"{base_prompt}\n\n---\n\n{protocol}"


# =============================================================================
# TeamMember — a worker agent
# =============================================================================


class TeamMember(TeamMemberBase):
    """Worker agent. Does tasks, reports to lead, stops.

    Has safety-net auto-reply, task requeue on error.
    """

    def __init__(
        self,
        agent: Agent,
        *,
        session_id: str | None = None,
        db_factory: DbFactory | None = None,
    ) -> None:
        super().__init__(agent, session_id=session_id, db_factory=db_factory)

    @property
    def _role_label(self) -> str:
        return "member"

    async def _on_turn_error(self, exc: Exception) -> None:
        """Notify lead on error."""
        assert self._team is not None
        assert self._mailbox is not None

        await self._mailbox.send(
            to=self._team.lead.name,
            message=Message(
                from_agent=self.name,
                to_agent=self._team.lead.name,
                content=(
                    f"[{self.name}]: System error — temporarily unavailable. "
                    f"Please reassign my work to another member."
                ),
            ),
        )

    def build_protocol(self, base_prompt: str, team: "AgentTeam") -> str:
        """Assemble member protocol + roster into system prompt."""
        lead_name = team.lead.name
        sections: list[str] = [
            MEMBER_COMMUNICATION_RULES,
            MEMBER_MESSAGE_FORMAT.format(lead_name=lead_name),
            MEMBER_PROTOCOL.format(lead_name=lead_name),
        ]

        # Build roster — show lead + other members
        roster_lines: list[str] = []
        lead = team.lead
        lead_desc = lead.agent.description or lead.name
        roster_lines.append(f"- **{lead.name}** [lead]: {lead_desc}")
        for name, member in team.members.items():
            if name == self.name:
                continue
            desc = member.agent.description or member.name
            roster_lines.append(f"- **{name}**: {desc}")
        if roster_lines:
            sections.append("## Team members\n" + "\n".join(roster_lines))

        protocol = "\n\n".join(sections)
        return f"{base_prompt}\n\n---\n\n{protocol}"
