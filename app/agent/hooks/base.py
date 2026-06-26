from __future__ import annotations

from abc import ABC
from typing import TYPE_CHECKING

from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
)

if TYPE_CHECKING:
    from app.agent.state import (
        AgentState,
        ModelCallHandler,
        ModelRequest,
        RunContext,
        ToolCallHandler,
    )
    from app.agent.schemas.chat import ToolCall


class BaseAgentHook(ABC):
    """Base class for agent lifecycle hooks.

    Sub-class and override only the methods you need — all defaults are
    transparent no-ops or pass-throughs.

    Lifecycle events (observe)
    --------------------------
    ``on_start``, ``on_end``, ``before_agent``, ``after_agent``,
    ``before_model``, ``on_model_delta``, ``after_model``, ``on_rate_limit``
    — called by the agent loop at each phase.  May read or mutate state.

    ``before_model`` receives the current :class:`~app.agent.state.ModelRequest`
    and may return a modified one via ``request.override(...)``::

        async def before_model(self, ctx, state, request):
            return request.override(system_prompt=request.system_prompt + " Be concise.")

    Intercept points (transform)
    ----------------------------
    ``wrap_model_call`` — wraps each LLM call.  Receives an immutable
    :class:`~app.agent.state.ModelRequest` and a ``handler`` callable.
    Call ``await handler(request)`` to execute and return the result::

        async def wrap_model_call(self, ctx, state, request, handler):
            request = request.override(system_prompt=build_prompt(state))
            return await handler(request)

    ``wrap_tool_call`` — wraps each tool execution::

        async def wrap_tool_call(self, ctx, state, tc, handler):
            result = await handler(ctx, state, tc)
            return result
    """

    async def on_start(self) -> None:
        """Called once when the agent system starts up."""

    async def on_end(self) -> None:
        """Called once when the agent system shuts down."""

    async def before_agent(self, ctx: "RunContext", state: "AgentState") -> None:
        """Called before the agent loop begins."""

    async def after_agent(
        self, ctx: "RunContext", state: "AgentState", response: AssistantMessage
    ) -> None:
        """Called after the agent loop completes."""

    async def before_model(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
    ) -> "ModelRequest | None":
        """Called before each LLM call.

        Return a modified :class:`~app.agent.state.ModelRequest` to change what
        the LLM sees (e.g. updated system prompt, injected messages).  Return
        ``None`` to leave the request unchanged.
        """
        return None

    async def on_model_delta(
        self, ctx: "RunContext", state: "AgentState", chunk: ChatCompletionChunk
    ) -> None:
        """Called for each streaming chunk from the LLM."""

    async def after_model(
        self, ctx: "RunContext", state: "AgentState", response: AssistantMessage
    ) -> None:
        """Called after each full LLM response is assembled."""

    async def on_rate_limit(
        self,
        ctx: "RunContext",
        state: "AgentState",
        retry_after: int,
        attempt: int,
        max_attempts: int,
    ) -> None:
        """Called when the provider returns 429 Too Many Requests."""

    async def on_provider_retry(
        self,
        ctx: "RunContext",
        state: "AgentState",
        model: str,
        attempt: int,
        max_attempts: int,
        delay_seconds: float,
        error_type: str,
        status_code: int | None = None,
        retry_after: int | None = None,
    ) -> None:
        """Called when a provider call will be retried."""

    async def on_provider_exhausted(
        self,
        ctx: "RunContext",
        state: "AgentState",
        model: str,
        max_attempts: int,
        error_type: str,
        status_code: int | None = None,
    ) -> None:
        """Called when a provider exhausts its retry budget."""

    async def wrap_model_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
        handler: "ModelCallHandler",
    ) -> AssistantMessage:
        """Intercept each LLM call.

        Pass-through by default.  Override to retry, swap models, rewrite
        the request, or short-circuit with a cached response::

            async def wrap_model_call(self, ctx, state, request, handler):
                request = request.override(system_prompt=build_dynamic_prompt(state))
                return await handler(request)
        """
        return await handler(request)

    async def wrap_tool_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        tool_call: "ToolCall",
        handler: "ToolCallHandler",
    ) -> str:
        """Intercept each tool execution.  Pass-through by default."""
        return await handler(ctx, state, tool_call)
