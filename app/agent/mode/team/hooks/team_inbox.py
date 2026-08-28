"""TeamInboxHook — drains the mailbox before each LLM call.

After every tool-execution round, the agent loop calls ``before_model`` at the
top of the next iteration.  This hook drains any messages that arrived in the
agent's mailbox during tool execution, persists them to DB, emits inbox SSE
events, and appends them to ``state.messages`` so the next LLM call sees them.

This means a mid-run inbox message is injected exactly here:

    iteration N:
        LLM call -> tool_calls
        tool execution -> results appended to state.messages
        checkpointer.sync()
        |  next iteration starts
    iteration N+1:
        TeamInboxHook.before_model -> drains inbox -> appends to state.messages
        LLM call sees new inbox message in context
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from loguru import logger

from app.agent.hooks.base import BaseAgentHook

if TYPE_CHECKING:
    from app.agent.state import AgentState, ModelRequest, RunContext
    from app.agent.mode.team.runtime import SessionRuntime


class TeamInboxHook(BaseAgentHook):
    """Drain the session inbox before each LLM call, injecting new messages."""

    def __init__(self, runtime: "SessionRuntime") -> None:
        self._runtime = runtime

    async def before_model(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
    ) -> ModelRequest | None:
        """Drain inbox and append any new messages to state before the LLM call."""
        from app.agent.mode.team.mailbox import Message

        runtime = self._runtime

        pending: list[Message] = []
        while not runtime.inbox_empty():
            try:
                pending.append(runtime._inbox.get_nowait())
            except asyncio.QueueEmpty:
                break

        if not pending:
            return None

        inbox_msgs = await runtime._persist_inbox(pending)

        for msg_obj, raw_msg in zip(inbox_msgs, pending):
            # A user message is already rendered from the request that sent it;
            # only agent-authored inbox rows need an SSE.
            if raw_msg.from_agent != "user":
                await runtime._emit(
                    event="inbox",
                    extra={
                        "id": str(msg_obj.db_id) if msg_obj.db_id else None,
                        "message_id": str(msg_obj.db_id) if msg_obj.db_id else None,
                        "content": msg_obj.content,
                        "from_agent": raw_msg.from_agent,
                    },
                )
            state.messages.append(msg_obj)
            logger.info(
                "team_inbox_injected agent={} from={} content_len={}",
                runtime.name,
                raw_msg.from_agent,
                len(msg_obj.content or ""),
            )

        # Rebuild ModelRequest so the LLM call sees the newly injected messages.
        # Without this, model_request.messages is a stale tuple snapshot taken
        # before before_model hooks ran — the LLM would not see inbox messages.
        return request.override(messages=tuple(state.messages_for_llm))
