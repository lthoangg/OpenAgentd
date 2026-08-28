"""SessionRuntimeProtocolHook — injects the operating protocol into system prompts.

Fires via ``wrap_model_call`` before each LLM call. Delegates protocol
assembly to :class:`SessionRuntime` via ``build_protocol()``.

The yaml ``system_prompt`` only needs the agent's own instructions (what to
research, how to write, etc.). Everything about *how delegation works* is
injected by ``build_protocol()``.

Usage::

    hook = SessionRuntimeProtocolHook(runtime=runtime)
    agent.run(messages, hooks=[hook, ...])

Created per turn in ``SessionRuntime._handle_messages()``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.agent.hooks.base import BaseAgentHook

if TYPE_CHECKING:
    from app.agent.schemas.chat import AssistantMessage
    from app.agent.state import AgentState, ModelCallHandler, ModelRequest, RunContext
    from app.agent.mode.team.runtime import SessionRuntime


class SessionRuntimeProtocolHook(BaseAgentHook):
    """Inject the operating protocol into the system prompt before each model call."""

    def __init__(self, runtime: "SessionRuntime") -> None:
        self._runtime = runtime

    async def wrap_model_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
        handler: "ModelCallHandler",
    ) -> "AssistantMessage":
        """Inject the protocol into the system prompt on every model call.

        The injected protocol is static per session, so the system prompt stays
        byte-stable across turns (prompt-cache friendly).
        """
        new_prompt = self._runtime.build_protocol(request.system_prompt)
        return await handler(request.override(system_prompt=new_prompt))
