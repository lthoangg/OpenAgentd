"""QueuedMessageInjectionHook — splices user-queued messages into a running turn.

When the lead is ``working``, additional messages posted via ``POST /team/chat``
are saved as queued ``SessionMessage`` rows (``queue_status="queued"``,
``exclude_from_context=True``).  Historically those rows only activated *after*
the current turn finished — :meth:`AgentTeam._activate_queued_user_messages`
would pop them and start a new turn.

This hook runs ``before_model`` and pops any pending queued rows on every
iteration boundary, appending them to ``state.messages`` so the next LLM call
sees them in the same turn.  Mid-tool-call splicing is impossible by
construction: ``before_model`` only fires between LLM steps, never during one.

Out of scope (same as the existing post-turn drain path):
- ``model`` / ``thinking_level`` / ``service_tier`` stored on the queued row's ``extra`` are not
  applied — the current turn keeps its originally-selected model.
- Attachments stored on the queued row are not forwarded.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from loguru import logger

from app.agent.hooks.base import BaseAgentHook
from app.agent.schemas.chat import HumanMessage
from app.core.db import DbFactory, resolve_db_factory
from app.services.chat_service import pop_queued_user_messages

if TYPE_CHECKING:
    from app.agent.state import AgentState, ModelRequest, RunContext


class QueuedMessageInjectionHook(BaseAgentHook):
    """Drain user-queued messages before each LLM call and append them to state."""

    def __init__(
        self,
        *,
        session_id: str,
        agent_name: str,
        db_factory: DbFactory,
    ) -> None:
        self._session_id = session_id
        self._agent_name = agent_name
        self._db_factory = db_factory

    async def before_model(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
    ) -> "ModelRequest | None":
        try:
            session_uuid = UUID(self._session_id)
        except ValueError:
            return None

        db_factory = resolve_db_factory(self._db_factory)
        async with db_factory() as db:
            queued = await pop_queued_user_messages(db, session_uuid)
            if not queued:
                await db.commit()
                return None
            await db.commit()

        for row in queued:
            state.messages.append(
                HumanMessage(content=row.content or "", extra=row.extra)
            )

        # Emit the same SSE event the post-turn drain path uses so the UI
        # unblurs the queued bubbles and renders them in the transcript.
        # init_turn is intentionally NOT called — the turn is already live.
        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

        message_ids = [str(row.id) for row in queued]
        try:
            await stream_store.push_event(
                self._session_id,
                StreamEnvelope.from_parts(
                    "queued_turn_start",
                    {
                        "type": "queued_turn_start",
                        "agent": self._agent_name,
                        "message_ids": message_ids,
                    },
                ),
            )
        except Exception as exc:
            logger.warning("queued_injection_emit_failed error={}", exc)

        logger.info(
            "queued_messages_injected session_id={} count={} message_ids={}",
            self._session_id,
            len(queued),
            message_ids,
        )

        return request.override(messages=tuple(state.messages_for_llm))
