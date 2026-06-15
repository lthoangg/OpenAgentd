"""Team member classes — TeamMemberBase, TeamLead, TeamMember.

TeamMemberBase holds the shared worker infrastructure (activation, inbox, history).
TeamLead and TeamMember subclass it with role-specific behaviour:
- TeamLead: no safety-net, skips user-only inbox persistence, owns lead protocol
- TeamMember: safety-net auto-reply, member protocol

Agents do **not** run persistent background loops.  Instead, they are
*activated on demand*: when a message arrives in their mailbox the team calls
``_maybe_activate()`` which spawns a single ``asyncio.Task`` that drains the
inbox, calls ``agent.run()``, and returns to ``idle`` state.

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
from app.agent.hooks.continuation import ContinuationHook
from app.agent.hooks.dynamic_prompt import inject_current_date
from app.agent.hooks.memory_context import default_memory_context_hook
from app.agent.hooks.memory_flush import build_memory_flush_hook
from app.agent.hooks.wiki_injection import default_wiki_injection_hook
from app.agent.hooks.workspace_instructions import WorkspaceInstructionsHook
from app.agent.hooks.otel import OpenTelemetryHook
from app.agent.hooks.stream_publisher import StreamPublisherHook
from app.agent.hooks.summarization import build_summarization_hook
from app.agent.hooks.title_generation import build_title_generation_hook
from app.agent.mode.team.hooks.queued_injection import QueuedMessageInjectionHook
from app.agent.mode.team.hooks.team_inbox import TeamInboxHook
from app.agent.mode.team.hooks.team_prompt import AgentTeamProtocolHook
from app.agent.hooks.tool_result_offload import ToolResultOffloadHook
from app.agent.plugins.role import reset_role, set_role
from app.agent.sandbox import SandboxConfig, _sandbox_ctx, set_sandbox
from app.core.paths import session_workspace_dir
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

MAX_OPEN_TASK_NUDGES = 1

if TYPE_CHECKING:
    from app.agent.mode.team.mailbox import TeamMailbox
    from app.agent.mode.team.team import AgentTeam
    from app.agent.providers.base import LLMProviderBase


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
- **Right-size delegation.** Spawning a member adds latency and token cost, so don't delegate trivia — handle small, quick, self-contained tasks yourself (a short answer, a couple of reads, a small edit).
- **Delegate only when the work is genuinely substantial:**
  - **Role fit** — it matches an available blueprint's specialty; use `team_manage` to discover/spawn or reuse the right member.
  - **Parallel work** — multiple independent streams that can run concurrently.
  - **Context hygiene** — it would flood your own context with noise (long build logs, large file dumps, exhaustive search results).
  - **Sustained multi-step work** — a real workstream, not just two quick tool calls.
- **Prefer reusing a live member** over spawning a fresh one, and skip delegation entirely when you can finish the task yourself in a step or two.
- **Routing guide** (when you do delegate):
  - Building, writing files, running commands → **executor**
  - Research, web search, reading docs or codebases → **explorer**
  - Hard decisions, architecture review, trade-off analysis → **consultant**
  - Multiple concerns → spawn / message multiple members in parallel
- **Roster management — `team_manage`.** Members are spawned on demand. Use the `team_manage` tool description and schema for spawn/restore/dismiss usage and available blueprint discovery. Spawn what you need, address returned handles via `team_message`, and **keep useful members alive across turns** — reusing a live instance preserves its warm context and is faster and cheaper than dismiss-then-respawn. Dismiss only to free resources or clear clutter when an instance clearly won't be needed again.
- Coordination with members must go through the `team_message` tool. Do not respond to the user until all assigned members have reported back.
- Member capabilities come from their blueprint/root configuration at spawn time. If a member lacks a required capability, use an appropriately configured blueprint or update durable settings rather than mutating a live member.
- Always format your responses in **Markdown**. No emoji."""

LEAD_PROTOCOL = """\
## Lead workflow
1. Receive user request. **Assess scope first.** For small, quick requests, just handle them yourself — don't spin up members for trivia. For substantial work, plan delegation: break the request into pieces, match each to the right blueprint, and prefer reusing a live member over spawning a fresh one.
2. **Before delegating, consult your skills.** If the user's request matches one of your declared skills (e.g. install/setup/configure/add a skill body → `skill-installer`; MCP server → `mcp-installer`; plugin → `plugin-installer`; agent config/model/tools → `self-healing`; brand or design work → relevant skill), call `skill(skill_name='<name>')` *before* spawning members. Skills carry canonical paths, file formats, and conventions members would otherwise guess wrong. Skipping this step is the #1 cause of members writing to the wrong location.
3. When delegating:
   - For multi-step work, create a todo plan first. Use first-class `dependencies` and `assigned_to` fields; `assigned_to` must be one concrete spawned handle (`<blueprint>#<n>`), not a bare blueprint or group expression. Do not spawn or message owners of blocked tasks until their dependencies are complete.
   - Identify which blueprints cover the work using the routing guide above.
   - Prefer restoring a relevant prior instance over spawning fresh when `team_manage` shows a restorable handle whose prior work overlaps with the new task.
   - **Spawn before assigning member todos.** Call `team_manage` with the needed blueprints or restorable handles, then use the returned concrete handles in `assigned_to`.
   - Assign every relevant instance **in parallel** via `team_message(to=['<handle>'])`.
   - **Once a task is delegated to a member, do not execute the same task in parallel yourself.** Stay in coordination/verification mode unless you explicitly reclaim or cancel the member task first.
   - For dependent workflows, delegate a peer handoff chain from the todo dependencies. Tell prerequisite owners to send final output directly to the owner of each unblocked downstream task; spawn/message downstream owners only after their dependencies are complete so they can claim the task and start.
   - Do not make yourself the default relay for member outputs. Use the lead as the synthesizer/final verifier, not as a message bus between members.
   - Briefly let the user know work is underway (plain text — 1 sentence max).
4. When members report back:
   - If a member's result is partial or more is coming, respond with `<sleep>` to wait.
   - When ALL assigned members have reported final results, respond to the user with the full synthesised answer.
   - **Sanity-check claims before promising "done" to the user.** When a member says they wrote a file or changed state, verify with a cheap read (`ls`, `read`) when feasible. Members can hallucinate success after a failed tool call — one verification beats one wrong answer.
5. After delivering the answer, **keep members alive by default.** A live instance carries warm context and prompt-cache state, so reusing it on the next related turn is faster and cheaper than dismiss-then-respawn — message the same live handle again rather than recreating it. Dismiss (`team_manage(action='dismiss', members=['<handle>'])`) only when an instance is clearly finished for the rest of the session, or the roster is cluttered with idle members you won't reuse. Dismissal preserves history on disk, so you can still restore a dismissed handle with `team_manage(action='spawn', members=['<blueprint>#<n>'])` if a later turn revives that work."""

MEMBER_COMMUNICATION_RULES = """\
## Communication protocol
- **Do not use plain text output for responses/results.** Plain text is discarded — every message MUST go through `team_message`, addressed to **anyone on the team who needs it**, a peer or the lead: `team_message(to=["<teammate_name>"])`.
- **Talk to peers directly — you are not limited to the lead.** If you need information, ask the teammate who has it. If your output feeds another member's work, send it straight to them. Do not route everything through the lead.
- Message the lead specifically only when you owe *them* your final deliverable, or you are blocked and need a decision; otherwise prefer peer-to-peer.
- **Idle, waiting, or done? Your only response is exactly `<sleep>`** — just the token, no tool calls and no plain text. Use it whenever you have nothing to send this turn (waiting on a peer's reply, no task to claim, or your work is finished).
- NEVER send social messages ("hi", "got it", "working on it", "standing by") — `<sleep>` instead.
- **Missing a capability?** If the task needs something you can't do with your current tools, describe **what you're trying to do** in plain language to the lead via `team_message` (e.g. "I need to write files to disk", "I need to run shell commands", "I need shadcn component examples"). Do **not** guess tool/skill/MCP names — you may not know what's actually available. The lead picks the exact capability and grants it; you'll see it on your next turn.
- **Verify before you claim.** Read each tool result before reporting. If a tool returned an error, NEVER say the operation succeeded. When you write a file or mutate state, confirm with a cheap follow-up (e.g. `ls` the directory, `read` the file) before telling anyone it's done.
- Always format your output in **Markdown**."""

MEMBER_PROTOCOL = """\
## Member workflow
1. Receive task instructions via `[{lead_name}]: ...` or from a peer.
2. If the instruction names a todo task, call `todo_manage(actions=[{{"action":"claim","task_id":"..."}}])` before starting. If the claim is blocked, respond `<sleep>` and wait for the dependency owner to finish instead of starting early.
3. Do your work (research, write, calculate, etc.).
4. If you need help or input from any teammate, call `team_message(to=[teammate_name])`, then `<sleep>` — the answer arrives next wake.
5. **Send output straight to whoever needs it.** If your result is an input to a peer's task, `team_message` it directly to that peer; call it incrementally as you complete batches and state whether each is partial (more coming) or final. Route through the lead only when the deliverable is for the lead.
6. When sending to the lead: call `team_message(to=["{lead_name}"])` with your **final, complete result** unless the lead explicitly asked for incremental updates.
7. If you have nothing to do: `<sleep>` immediately.

**NEVER write plain text for responses/results; use `team_message` to the right teammate, or return exactly `<sleep>` directly when waiting or idle.**"""


# -- Helpers -------------------------------------------------------------------


class AlreadyWorkingError(Exception):
    """Raised by :meth:`TeamMemberBase.activate_for_continuation` when the
    target agent is already running a turn.

    Carries the agent name so callers can build a useful error message.
    Caught by :meth:`AgentTeam.handle_continue` and translated to a
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


def _open_task_nudge_content(open_todos: list[dict], lead_name: str) -> str:
    """Build the hidden task-reminder prompt for a member."""
    lines = [
        "[system]: You still have open assigned task(s). Do not stop yet.",
        "",
    ]
    for index, todo in enumerate(open_todos, start=1):
        task_id = todo.get("task_id", "unknown")
        content = todo.get("content", "Untitled task")
        status = todo.get("status", "unknown")
        lines.append(f'{index}. "{content}" ({task_id}, status: {status})')
    lines.extend(
        [
            "",
            "If a task is complete, report the result to the lead using "
            f'`team_message(to=["{lead_name}"])`.',
            "If you are blocked, report the blocker to the lead using `team_message`.",
            "If more work is needed, continue working. If you need to wait, "
            "respond exactly `<sleep>`.",
        ]
    )
    return "\n".join(lines)


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

        self.state: Literal["idle", "working", "error"] = "idle"
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
        self._open_task_nudge_counts: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def register(self, team: "AgentTeam") -> None:
        """Register this member with the team. Called by AgentTeam.start().

        Registers the mailbox inbox but does **not** spawn any background task.
        The agent becomes ``idle`` and will be activated on demand when a
        message arrives.
        """
        self._team = team
        self._mailbox = team.mailbox
        self._mailbox.register(self.name)

        self.state = "idle"
        logger.info(
            "team_member_registered name={} session_id={}", self.name, self.session_id
        )

    async def _ensure_db_session(
        self,
        title: str | None = None,
        mode: str = "normal",
        workspace: str | None = None,
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
                        mode=mode,
                        workspace=workspace,
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

        self.state = "idle"
        logger.info("team_member_stopped name={}", self.name)

    def interrupt(self) -> None:
        """Request cancellation of the current activation without deregistering."""
        self._cancel_event.set()

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

    def activate_for_continuation(self) -> None:
        """Spawn an activation task that resumes from existing DB history.

        Used by ``AgentTeam.handle_continue`` to run the agent without an
        inbox message — the LLM call uses the existing session history
        verbatim, which (for /continue) ends in the prior assistant turn.
        The resulting first assistant message is stamped with
        ``extra["is_continuation"] = True`` by :class:`ContinuationHook`.

        The state check + state mutation form one logical step here so two
        concurrent ``/continue`` requests cannot both observe ``idle`` and
        race into ``_run_activation``.  Callers (notably
        :meth:`AgentTeam.handle_continue`) should catch
        :class:`AlreadyWorkingError` and translate it to their own
        precondition error type.

        Raises:
            AlreadyWorkingError: if the agent is already working.
        """
        if self.state == "working":
            raise AlreadyWorkingError(self.name)
        self.state = "working"
        self._active_task = asyncio.create_task(
            self._run_activation(is_continuation=True),
            name=f"continue:{self.name}",
        )

    def activate_for_compaction(self) -> None:
        """Spawn an activation task that forces summarization before the model call."""
        if self.state == "working":
            raise AlreadyWorkingError(self.name)
        self.state = "working"
        self._active_task = asyncio.create_task(
            self._run_activation(force_compaction=True),
            name=f"compact:{self.name}",
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
            mode = self._team.mode if self._team is not None else "normal"
            new_agent = rebuild_agent_from_disk(source, mode=mode)
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

        # File-backed blueprints use the base role name (e.g. ``executor``),
        # but live spawned instances must keep their concrete handle.
        new_agent.name = self.name

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

    async def _run_activation(
        self, *, is_continuation: bool = False, force_compaction: bool = False
    ) -> None:
        """One-shot activation: drain inbox, process, return to idle.

        When ``is_continuation`` is True the inbox drain/persist/SSE-emit
        steps are skipped — the agent runs against the current DB history
        verbatim, which (for /continue) ends in the prior assistant turn so
        the provider continues from there.  The resulting first assistant
        message is stamped via :class:`ContinuationHook`.
        """
        assert self._mailbox is not None
        assert self._team is not None

        self._cancel_event.clear()

        if is_continuation or force_compaction:
            # Control-command path — no inbox messages; run on DB history.
            pending: list[Message] = []
        else:
            # Drain all queued messages
            pending = []
            while not self._mailbox.inbox_empty(self.name):
                try:
                    pending.append(self._mailbox.receive_nowait(self.name))
                except asyncio.QueueEmpty:
                    break

            if not pending:
                # Spurious activation — nothing to process. Reset state that
                # _maybe_activate pre-set to "working" and bail out.
                self.state = "idle"
                return

        # state was already set to "working" by _maybe_activate
        await self._team._emit(agent=self.name, event="agent_status", status="working")
        logger.info(
            "team_member_activated name={} messages={} continuation={}",
            self.name,
            len(pending),
            is_continuation,
        )

        # Re-check drift at turn start so edits made between turns
        # (settings UI, external editor, self-healing skill) take effect on
        # the very next turn, not two turns later.
        self._detect_config_drift()
        if self._config_dirty:
            self._refresh_agent_from_disk()

        # Let subclass reset bookkeeping
        self._on_wake(pending)

        if not is_continuation:
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
            await self._handle_messages(
                is_continuation=is_continuation,
                force_compaction=force_compaction,
            )
            await self._on_turn_success()

        except Exception as exc:
            from app.agent.errors import (
                ProviderAuthenticationError,
                ProviderRateLimitError,
            )

            if isinstance(exc, ProviderRateLimitError):
                logger.warning(
                    "team_member_provider_rate_limit name={} error={}", self.name, exc
                )
            elif isinstance(exc, ProviderAuthenticationError):
                logger.warning(
                    "team_member_provider_auth_failed name={} error={}", self.name, exc
                )
            else:
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
                self.state = "idle"
                await self._team._emit(
                    agent=self.name,
                    event="agent_status",
                    status="idle",
                )
                logger.info("team_member_idle name={}", self.name)

            # Did mcp.json / agent.md / SKILL.md change during this turn?
            # Drift → rebuild the agent at the start of the next turn.
            self._detect_config_drift()

            # Me: re-activate if messages arrived while agent.run() was executing.
            # agent.run() breaks on <sleep>/final-response without running
            # TeamInboxHook again, so any message queued during that last LLM call
            # sits in the inbox.  Calling _maybe_activate here is safe: state is
            # already "idle", so it spawns a fresh activation task that loads
            # history from DB and wakes the agent — exactly like a normal wakeup.
            if not self._mailbox.inbox_empty(self.name):
                logger.info(
                    "team_member_late_inbox_reactivate name={}",
                    self.name,
                )
                self._maybe_activate()

            if self is self._team.lead:
                await self._team._try_activate_queued_after_lead_turn()

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
        """Called when _handle_messages raises. Override for error recovery.

        Subclasses should call ``await super()._on_turn_error(exc)`` first
        so the base can emit the typed
        :class:`~app.agent.schemas.events.AgentNotConfiguredEvent` for
        :class:`~app.agent.providers.unconfigured.UnconfiguredProviderError`
        before any role-specific handling runs.
        """
        from app.agent.errors import ProviderAuthenticationError
        from app.agent.providers.unconfigured import UnconfiguredProviderError

        if isinstance(exc, UnconfiguredProviderError | ProviderAuthenticationError):
            from app.agent.schemas.events import AgentNotConfiguredEvent
            from app.services import memory_stream_store as stream_store
            from app.services.stream_envelope import StreamEnvelope

            try:
                await stream_store.push_event(
                    self._team.lead.session_id
                    if self._team is not None
                    else self.session_id,
                    StreamEnvelope.from_event(
                        AgentNotConfiguredEvent(
                            agent=self.name,
                            message=str(exc),
                        )
                    ),
                )
            except Exception as push_exc:
                logger.warning("agent_not_configured_emit_failed error={}", push_exc)

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

    async def _handle_messages(
        self, *, is_continuation: bool = False, force_compaction: bool = False
    ) -> None:
        """Load full history from DB and call agent.run().

        When ``is_continuation`` is True a one-shot
        :class:`ContinuationHook` is appended to the hooks list so the
        very first assistant message produced by this run gets
        ``extra["is_continuation"] = True``.
        """
        assert self._team is not None

        db_factory = resolve_db_factory(self.db_factory)
        session_uuid = uuid.UUID(self.session_id)

        async with db_factory() as db:
            try:
                history = await get_messages_for_llm(db, session_uuid)
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
        effective_model = session_model or (
            self.agent.model_id if session_thinking_level or last_service_tier else None
        )
        if (
            self._role_label == "lead"
            and effective_model
            and self._team._provider_factory is not None
        ):
            model_kwargs: dict[str, object] = {}
            if session_thinking_level:
                model_kwargs["thinking_level"] = session_thinking_level
            if last_service_tier and effective_model.startswith("codex:"):
                model_kwargs["service_tier"] = last_service_tier
            runtime_provider = self._team._provider_factory(
                effective_model,
                model_kwargs=model_kwargs,
            )
            runtime_model = effective_model

        # Build hooks — StreamPublisherHook writes to shared team stream
        lead_session_id = self._team.lead.session_id
        publisher_hook = StreamPublisherHook(
            session_id=lead_session_id,
            agent_name=self.name,
            publish_reasoning=not is_continuation,
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
            model_id=runtime_model or self.agent.model_id,
            lead_session_id=lead_session_id,
        )

        hooks: list[BaseAgentHook] = [
            inject_current_date,
            default_wiki_injection_hook,
            default_memory_context_hook,
            team_prompt_hook,
            team_inbox_hook,
            publisher_hook,
            otel_hook,
        ]
        # Splice user-queued messages into the running turn — lead only, since
        # the user-facing queue lives on the lead's session.  Must precede
        # summarization so a freshly-injected message participates in window
        # accounting on the same iteration.
        if self._role_label == "lead" and self.db_factory:
            hooks.append(
                QueuedMessageInjectionHook(
                    session_id=self.session_id,
                    agent_name=self.name,
                    db_factory=self.db_factory,
                )
            )
        if self._team.mode == "coding":
            hooks.append(WorkspaceInstructionsHook(self._team.workspace))

        # Title generation — lead only (members don't need session titles).
        # Returns None with a warning when the feature is disabled or
        # unconfigured — non-fatal, sessions just keep the fallback title.
        if self._role_label == "lead" and self.db_factory:
            title_hook = build_title_generation_hook(
                default_provider=runtime_provider or self.agent.llm_provider,
                db_factory=self.db_factory,
            )
            if title_hook is not None:
                hooks.append(title_hook)

        # Continuation stamp — one-shot, flags the first assistant message
        # of this run as a continuation of the prior assistant turn so the
        # frontend can render it tight against that prior bubble.
        if is_continuation:
            hooks.append(ContinuationHook())

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
            summarization_provider = runtime_provider or self.agent.llm_provider
            summarization_model = runtime_model or self.agent.model_id
            summ_hook = build_summarization_hook(
                summarization_provider,
                mode=self._team.mode,
                model_id=summarization_model,
            )
            if summ_hook:
                # Flush memory before the summariser compresses the window —
                # same threshold so both fire on the same turn, flush first.
                flush_hook = build_memory_flush_hook(
                    llm_provider=summarization_provider,
                    prompt_token_threshold=summ_hook.prompt_token_threshold,
                )
                if flush_hook is not None:
                    hooks.append(flush_hook)
                hooks.append(summ_hook)

        # Inject team tools
        injected = self._team.get_injected_tools(self.name)

        # Surface team routing context to tools via state.metadata.  The
        # schedule tool reads these as injected args so the LLM never has
        # to specify (or could lie about) the routing target.
        run_metadata: dict[str, object] = {
            "team_mode": self._team.mode,
        }
        if force_compaction:
            run_metadata["force_summarization"] = True
            run_metadata["stop_after_before_model"] = True
        if self._team.workspace:
            run_metadata["team_workspace"] = self._team.workspace
        config = RunConfig(session_id=self.session_id, metadata=run_metadata)

        # Coding mode uses the exact project workspace for every team member.
        workspace = str(session_workspace_dir(lead_session_id, self._team.workspace))
        session_sandbox = SandboxConfig(workspace=workspace, session_id=lead_session_id)
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
                llm_provider=runtime_provider,
                model_id=runtime_model,
            )

            await self._maybe_inject_open_task_nudge()
        finally:
            reset_role(role_token)
            _sandbox_ctx.reset(token)
            _permission_ctx.reset(perm_token)

        # If interrupted, mark last assistant message
        if self._cancel_event.is_set() and self.db_factory:
            await _mark_last_assistant_interrupted(
                self.db_factory, uuid.UUID(self.session_id)
            )

    async def _maybe_inject_open_task_nudge(self) -> None:
        """Wake members that ended normally while assigned todos remain open."""
        if self._role_label != "member" or self.db_factory is None:
            return
        assert self._team is not None
        assert self._mailbox is not None

        try:
            from app.agent.tools.builtin.todo import open_assigned_todos_for_actor

            open_todos = open_assigned_todos_for_actor(
                self._team.lead.session_id,
                self.name,
            )
        except Exception as exc:
            logger.warning(
                "team_member_open_task_lookup_failed name={} error={}", self.name, exc
            )
            return
        if not open_todos:
            return

        try:
            async with resolve_db_factory(self.db_factory)() as db:
                rows = (
                    await db.exec(
                        select(SessionMessage)
                        .where(
                            col(SessionMessage.session_id) == uuid.UUID(self.session_id)
                        )
                        .order_by(col(SessionMessage.created_at).desc())
                        .limit(10)
                    )
                ).all()
        except Exception as exc:
            logger.warning(
                "team_member_open_task_history_failed name={} error={}", self.name, exc
            )
            return
        if not rows:
            return

        last = rows[0]
        if last.role != "assistant" or last.tool_calls:
            return
        if (last.content or "").strip() in {"<sleep>", "[sleep]"}:
            return

        for row in rows:
            tool_calls = row.tool_calls or []
            if any(
                call.get("function", {}).get("name") == "team_message"
                for call in tool_calls
            ):
                return
            if row.id == last.id:
                break

        task_ids = [
            todo.get("task_id")
            for todo in open_todos
            if isinstance(todo.get("task_id"), str)
        ]
        nudge_keys = [f"{self._team.lead.session_id}:{task_id}" for task_id in task_ids]
        if nudge_keys and all(
            self._open_task_nudge_counts.get(key, 0) >= MAX_OPEN_TASK_NUDGES
            for key in nudge_keys
        ):
            logger.info(
                "team_member_open_task_nudge_suppressed name={} tasks={}",
                self.name,
                task_ids,
            )
            return
        for key in nudge_keys:
            self._open_task_nudge_counts[key] = (
                self._open_task_nudge_counts.get(key, 0) + 1
            )

        content = _open_task_nudge_content(open_todos, self._team.lead.name)
        logger.info("team_member_open_task_nudge name={} tasks={}", self.name, task_ids)
        await self._mailbox.send(
            to=self.name,
            message=Message(
                from_agent="system",
                to_agent=self.name,
                content=content,
            ),
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

        Unconfigured-provider errors are routed to the typed
        :class:`AgentNotConfiguredEvent` by the base class; we skip the
        generic ``ErrorEvent`` here so the UI doesn't show two banners.
        """
        from app.agent.errors import ProviderAuthenticationError
        from app.agent.providers.unconfigured import UnconfiguredProviderError

        await super()._on_turn_error(exc)
        if isinstance(exc, UnconfiguredProviderError | ProviderAuthenticationError):
            return

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
        """Assemble lead protocol into the system prompt."""
        sections: list[str] = [
            LEAD_COMMUNICATION_RULES,
            LEAD_MESSAGE_FORMAT,
            LEAD_PROTOCOL,
        ]
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
        """Notify lead on error.

        Unconfigured-provider errors are surfaced to the UI directly by the
        base class via :class:`AgentNotConfiguredEvent`; we also notify the
        lead so it can pick a different member instead of retrying us.
        """
        from app.agent.errors import (
            ProviderAuthenticationError,
            ProviderConnectionError,
            ProviderRequestError,
        )
        from app.agent.providers.unconfigured import UnconfiguredProviderError

        await super()._on_turn_error(exc)

        assert self._team is not None
        assert self._mailbox is not None

        from app.agent.tools.builtin.todo import release_in_progress_for_actor
        from app.core.paths import session_workspace_dir

        released = release_in_progress_for_actor(
            session_workspace_dir(self._team.lead.session_id, self._team.workspace),
            self.name,
            self._team.lead.session_id,
        )
        suffix = (
            f" In-progress todos reset to pending: {', '.join(released)}."
            if released
            else ""
        )

        # Member with no model: tell the lead exactly that so it doesn't
        # retry. Generic errors keep the existing "temporarily unavailable"
        # framing.
        if isinstance(exc, UnconfiguredProviderError):
            reason = (
                f"[{self.name}]: I have no model configured. "
                f"Ask the user to add a provider in Settings, then re-spawn me.{suffix}"
            )
        elif isinstance(exc, ProviderAuthenticationError):
            reason = (
                f"[{self.name}]: My provider credentials are not authenticated. "
                f"Ask the user to reconnect the provider in Settings, then re-spawn me.{suffix}"
            )
        elif isinstance(exc, ProviderRequestError):
            reason = (
                f"[{self.name}]: My provider rejected the request — {exc}. "
                f"This will not fix itself on retry; tell the user.{suffix}"
            )
        elif isinstance(exc, ProviderConnectionError):
            reason = (
                f"[{self.name}]: I could not reach my provider — {exc} "
                f"Reassign my work to another member or ask the user to check "
                f"connectivity.{suffix}"
            )
        else:
            reason = (
                f"[{self.name}]: System error — temporarily unavailable. "
                f"Please reassign my work to another member.{suffix}"
            )

        await self._mailbox.send(
            to=self._team.lead.name,
            message=Message(
                from_agent=self.name,
                to_agent=self._team.lead.name,
                content=reason,
            ),
        )

    def build_protocol(self, base_prompt: str, team: "AgentTeam") -> str:
        """Assemble member protocol + roster into system prompt."""
        lead_name = team.lead.name
        sections: list[str] = [
            (
                "## Runtime identity\n"
                f"You are `{self.name}`. Use this exact handle when identifying "
                "yourself or reporting back; do not use the blueprint name."
            ),
            MEMBER_COMMUNICATION_RULES,
            MEMBER_MESSAGE_FORMAT.format(lead_name=lead_name),
            MEMBER_PROTOCOL.format(lead_name=lead_name),
        ]

        protocol = "\n\n".join(sections)
        return f"{base_prompt}\n\n---\n\n{protocol}"
