"""QueuedMessageInjectionHook — splices user-queued messages into a running turn."""

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
        support_interrupt: bool = True,
    ) -> None:
        self._session_id = session_id
        self._agent_name = agent_name
        self._db_factory = db_factory
        self._support_interrupt = support_interrupt

    async def before_model(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
    ) -> "ModelRequest | None":
        if not self._support_interrupt:
            return None

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

        # Clear any question_resume marker so turns with injected queued messages
        # can ask further clarifying questions.
        state.metadata.pop("question_resume", None)

        from app.services import memory_stream_store as stream_store
        from app.services.stream_envelope import StreamEnvelope

        message_ids = [str(row.id) for row in queued]
        messages_data = [
            {"id": str(row.id), "content": row.content or ""} for row in queued
        ]
        try:
            await stream_store.push_event(
                self._session_id,
                StreamEnvelope.from_parts(
                    "queued_turn_start",
                    {
                        "type": "queued_turn_start",
                        "agent": self._agent_name,
                        "message_ids": message_ids,
                        "messages": messages_data,
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
