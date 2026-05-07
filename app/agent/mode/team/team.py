"""AgentTeam — coordinates a team lead + members via mailbox activation.

Agents do **not** run persistent background loops.  Instead, ``start()``
registers all agents with the mailbox and installs an ``on_message`` callback
that activates the receiving agent on demand.

Streaming to the frontend uses the in-memory stream store: lifecycle events
(agent_status, done) are pushed to the same stream key as the LLM deltas,
so the frontend receives one unified event feed per session.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid7

from loguru import logger

from app.agent.mode.team.mailbox import Message, TeamMailbox
from app.agent.mode.team.member import TeamLead, TeamMember, TeamMemberBase
from app.agent.mode.team.manage import make_team_manage_tool
from app.agent.mode.team.tools import make_team_message_tool
from app.agent.multimodal import build_parts_from_metas
from app.agent.schemas.chat import HumanMessage
from app.agent.schemas.events import DoneEvent
from app.agent.tools.registry import Tool
from app.core.db import resolve_db_factory
from app.models.chat import ChatSession
from app.services import memory_stream_store as stream_store
from app.services.stream_envelope import StreamEnvelope
from app.services.chat_service import heal_orphaned_tool_calls, save_message


class AgentTeam:
    """Singleton team: one lead, N members, shared mailbox.

    Lifecycle::

        team = AgentTeam(name="research-team", lead=lead, members={...})
        await team.start()   # registers agents, installs activation callback
        ...
        await team.stop()    # cancels active tasks, deregisters

    Handling a user message::

        session_id = await team.handle_user_message(content="...", session_id="...")
        # client subscribes to GET /team/stream/{session_id}
    """

    def __init__(
        self,
        lead: TeamLead,
        members: dict[str, TeamMember],
    ) -> None:
        self.lead = lead
        self.members = members  # name -> member (excludes lead)

        self.mailbox = TeamMailbox(on_message=self._on_message)

        # Guard: only emit done after at least one user turn has started
        self._has_active_turn: bool = False

        # Index all members by name for fast lookup in on_message
        self._members_by_name: dict[str, TeamMemberBase] = {lead.name: lead}
        for m in members.values():
            self._members_by_name[m.name] = m

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Register all agents with the mailbox.  No background tasks are started.

        Agents become ``available`` and will be activated on demand when a
        message arrives in their inbox.
        """
        self.lead.register(self)
        for member in self.members.values():
            member.register(self)
        logger.info(
            "agent_team_started lead={} members={}",
            self.lead.name,
            list(self.members.keys()),
        )

    async def stop(self) -> None:
        """Gracefully stop all agents: cancel active tasks and deregister."""
        for member in self.members.values():
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
        status: Literal["working", "available", "error"] | None = None,
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

    async def _try_emit_done(self) -> None:
        """Emit 'done' when lead + all members are available.

        Called from every member's _run_activation finally block.
        Guard: only fires after at least one user turn has started.
        """
        if not self._has_active_turn:
            return
        lead_done = self.lead.state in ("available", "error")
        all_members_done = all(
            m.state in ("available", "error") for m in self.members.values()
        )
        if lead_done and all_members_done:
            self._has_active_turn = False  # reset for next turn
            session_id = self.lead.session_id

            try:
                await stream_store.push_event(
                    session_id,
                    StreamEnvelope.from_event(DoneEvent()),
                )
                await stream_store.mark_done(session_id)
            except Exception as exc:
                logger.warning("team_emit_done_failed error={}", exc)
            logger.info("team_turn_done session_id={}", session_id)

    # ------------------------------------------------------------------
    # User message entry point
    # ------------------------------------------------------------------

    async def handle_user_message(
        self,
        content: str,
        session_id: str,
        interrupt: bool = False,
        attachment_metas: list[dict] | None = None,
    ) -> str:
        """Deliver a user message to the team lead. Returns the session_id.

        ``session_id`` controls which conversation the lead continues.
        Passing a new UUID starts a fresh lead conversation.

        If interrupt=True, all working agents are cancelled immediately and
        all non-completed tasks are reset so the lead can re-plan.

        The caller should subscribe to GET /team/stream/{session_id} to
        receive the SSE event stream.
        """
        # Update the lead's active session
        is_new_session = self.lead.session_id != session_id
        if is_new_session:
            self.lead.session_id = session_id
            await self.lead._ensure_db_session(
                title=content[:100] if content else None,
            )

            # Restore or rotate member sessions.
            # If the DB already has member sessions parented to this lead (e.g.
            # after a backend restart), reuse them — don't throw away history.
            # Only assign fresh UUIDs when no existing session is found.
            lead_uuid = UUID(session_id)
            db_factory = resolve_db_factory(self.lead.db_factory)
            from sqlmodel import col, select

            try:
                async with db_factory() as db:
                    for member in self.members.values():
                        result = await db.exec(
                            select(ChatSession)
                            .where(col(ChatSession.parent_session_id) == lead_uuid)
                            .where(col(ChatSession.agent_name) == member.name)
                            .order_by(col(ChatSession.created_at).desc())
                            .limit(1)
                        )
                        existing = result.first()
                        if existing is not None:
                            member.session_id = str(existing.id)
                            logger.info(
                                "team_member_session_restored name={} session_id={}",
                                member.name,
                                member.session_id,
                            )
                        else:
                            member.session_id = str(uuid7())
                            await member._ensure_db_session()
            except Exception as exc:
                logger.warning("team_member_session_restore_failed error={}", exc)
                for member in self.members.values():
                    member.session_id = str(uuid7())
                    await member._ensure_db_session()

        if interrupt:
            cancelled = [m for m in self.all_members if m.state == "working"]
            for member in cancelled:
                member._cancel_event.set()

            logger.info(
                "team_interrupted cancelled={}",
                [m.name for m in cancelled],
            )

        # Persist user message and parent member sessions
        try:
            db_factory = resolve_db_factory(self.lead.db_factory)
            lead_uuid = UUID(session_id)
            async with db_factory() as db:
                # Build multimodal HumanMessage if attachments present
                if attachment_metas:
                    parts = build_parts_from_metas(content, attachment_metas)
                    user_msg = HumanMessage(content=content, parts=parts)
                    msg_extra: dict | None = {"attachments": attachment_metas}
                else:
                    user_msg = HumanMessage(content=content)
                    msg_extra = None

                # Heal any tool_calls left orphaned by a previous crash /
                # restart *before* persisting the new user message so the
                # next turn's LLM input is well-formed.  See
                # ``heal_orphaned_tool_calls`` for the full rationale.
                await heal_orphaned_tool_calls(db, lead_uuid)

                await save_message(db, lead_uuid, user_msg, extra=msg_extra)

                for member in self.members.values():
                    try:
                        member_uuid = UUID(member.session_id)
                        member_row = await db.get(ChatSession, member_uuid)
                        if (
                            member_row is not None
                            and member_row.parent_session_id != lead_uuid
                        ):
                            member_row.parent_session_id = lead_uuid
                            db.add(member_row)
                    except Exception as inner_exc:
                        logger.warning(
                            "team_parent_member_session_failed member={} error={}",
                            member.name,
                            inner_exc,
                        )

                await db.commit()
        except Exception as exc:
            logger.warning("team_save_user_message_failed error={}", exc)

        # Initialise a fresh state blob for this turn synchronously before
        # delivering the message to the lead. This guarantees the state key
        # exists by the time the client's GET /team/stream/{sid} arrives.
        try:
            await stream_store.init_turn(session_id)
        except Exception as exc:
            logger.warning("team_init_turn_failed error={}", exc)

        # Mark that a turn is now active
        self._has_active_turn = True

        # Deliver user message to lead inbox (on_message callback activates lead)
        msg = Message(
            from_agent="user",
            to_agent=self.lead.name,
            content=f"[user]: {content}",
        )
        await self.mailbox.send(to=self.lead.name, message=msg)

        return session_id

    # ------------------------------------------------------------------
    # Tool injection
    # ------------------------------------------------------------------

    def get_injected_tools(self, agent_name: str) -> list[Tool]:
        """Return runtime tools to inject into agent.run() for the given agent.

        Everyone gets ``team_message``. The lead additionally gets
        ``team_manage`` to grant or revoke member capabilities at runtime.
        """
        role = "lead" if agent_name == self.lead.name else "member"
        tools: list[Tool] = [
            make_team_message_tool(self.mailbox, agent_name=agent_name, role=role)
        ]

        if agent_name == self.lead.name:
            tools.append(make_team_manage_tool(self))

        return tools

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    @property
    def all_members(self) -> list[TeamMemberBase]:
        """Lead + all regular members."""
        return [self.lead, *self.members.values()]

    def status(self) -> dict:
        """Return current state of all agents."""
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
        }
