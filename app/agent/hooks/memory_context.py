"""Run-level memory prompt injection hook."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.agent.hooks.base import BaseAgentHook

if TYPE_CHECKING:
    from app.agent.session import AgentSession
    from app.agent.state import AgentState, RunContext


class MemoryContextHook(BaseAgentHook):
    """Inject dynamic, XML-framed persistent memory into state.system_prompt once per run."""

    def __init__(self, session: AgentSession) -> None:
        self.session = session

    async def before_agent(self, ctx: RunContext, state: AgentState) -> None:
        snapshot = await self.session.ensure_memory_context_current()
        if snapshot.content:
            state.system_prompt = f"{state.system_prompt}\n\n{snapshot.content}"
