"""Dynamic System Prompt hook.

Provides a ``@dynamic_prompt`` decorator that turns a plain function into a
hook which rewrites the system prompt via ``wrap_model_call`` before each LLM
call.

The decorated function receives a :class:`PromptRequest` — a lightweight view
over the current :class:`~app.agent.state.ModelRequest` — and returns the new
prompt string.  Both sync and ``async def`` functions are supported.

The prompt is injected via an immutable :class:`~app.agent.state.ModelRequest`
override — ``request.override(system_prompt=...)`` — so it fires on every model
call within the agent loop and never mutates shared state.

Usage — inject the current date::

    from app.agent.hooks.dynamic_prompt import dynamic_prompt

    @dynamic_prompt
    def date_prompt(request):
        from datetime import date
        today = date.today().isoformat()
        return f"{request.base_prompt}\\n\\nCurrent date (UTC): {today}"

    agent = Agent(llm_provider=provider, hooks=[date_prompt])

Usage — context-aware prompt based on user role::

    from app.agent.hooks.dynamic_prompt import dynamic_prompt

    @dynamic_prompt
    def role_prompt(request):
        base = request.base_prompt
        ctx = request.state.context
        if ctx is None:
            return base
        if ctx.user_group == "expert":
            return f"{base}\\n\\nProvide detailed technical responses."
        return f"{base}\\n\\nExplain concepts simply and avoid jargon."

    agent = Agent(
        llm_provider=provider,
        context=UserContext(user_group="expert"),
        hooks=[role_prompt],
    )

The built-in ``inject_current_date`` is a ready-to-use ``@dynamic_prompt``
hook that appends today's UTC date::

    from app.agent.hooks.dynamic_prompt import inject_current_date

    agent = Agent(llm_provider=provider, hooks=[inject_current_date])
"""

from __future__ import annotations

import asyncio
import functools
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from .base import BaseAgentHook

if TYPE_CHECKING:
    from app.agent.schemas.chat import AssistantMessage
    from app.agent.state import AgentState, ModelCallHandler, ModelRequest, RunContext


@dataclass(frozen=True)
class PromptRequest:
    """Lightweight view passed to a ``@dynamic_prompt`` function.

    Attributes
    ----------
    base_prompt:
        The system prompt from the current :class:`~app.agent.state.ModelRequest`.
        This is the value to start from; the decorated function must return
        the replacement string.
    state:
        The live :class:`~app.agent.state.AgentState`.  Use ``state.context``
        to access typed per-invocation data, ``state.messages`` to inspect
        the conversation history, etc.
    ctx:
        The immutable :class:`~app.agent.state.RunContext` for this run.
        Use ``ctx.session_created_at`` to access the session creation timestamp
        for stable date injection across follow-up messages.
    """

    base_prompt: str
    state: "AgentState"
    ctx: "RunContext"


class _DynamicPromptHook(BaseAgentHook):
    """Internal hook produced by the ``@dynamic_prompt`` decorator."""

    def __init__(self, fn: Callable[[PromptRequest], str | Awaitable[str]]) -> None:
        self._fn = fn
        functools.update_wrapper(self, fn)

    async def wrap_model_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
        handler: "ModelCallHandler",
    ) -> "AssistantMessage":
        """Rewrite the system prompt on the immutable request before each model call."""
        prompt_request = PromptRequest(
            base_prompt=request.system_prompt,
            state=state,
            ctx=ctx,
        )
        result = self._fn(prompt_request)
        if asyncio.iscoroutine(result):
            result = await result
        return await handler(request.override(system_prompt=result))

    # Preserve callable identity so the hook can also be called directly
    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._fn(*args, **kwargs)


def dynamic_prompt(
    fn: Callable[[PromptRequest], str | Awaitable[str]],
) -> _DynamicPromptHook:
    """Decorator that turns a prompt-builder function into an agent hook.

    The decorated function must accept a single :class:`PromptRequest`
    argument and return the new system prompt string.  It may be a plain
    function or an ``async def`` coroutine.

    The hook fires via ``wrap_model_call`` — before every LLM call in the
    agent loop, not just the first one.

    Example::

        @dynamic_prompt
        def my_prompt(request: PromptRequest) -> str:
            return request.base_prompt + " Be concise."

    The returned object is a :class:`~app.agent.hooks.base.BaseAgentHook`
    so it can be passed directly to ``Agent(hooks=[...])``.
    """
    return _DynamicPromptHook(fn)


# ---------------------------------------------------------------------------
# Built-in dynamic prompts
# ---------------------------------------------------------------------------


@dynamic_prompt
def inject_current_date(request: PromptRequest) -> str:
    """Append the session date to the system prompt before each model call.

    Uses ``ctx.session_created_at`` when available so the injected date is
    frozen at session creation time — it does not drift to a new day if the
    user sends a follow-up message after midnight in the same session.

    Falls back to ``datetime.now(UTC)`` only when no session timestamp is
    available (e.g. during unit tests or direct ``Agent.run()`` calls without
    a ``RunConfig``).

    Produces a line of the form::

        Current date (UTC): 2026-03-31
    """
    ts = request.ctx.session_created_at
    if ts is not None:
        date_str = ts.astimezone(timezone.utc).strftime("%Y-%m-%d")
    else:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"{request.base_prompt}\n\nCurrent date (UTC): {date_str}"
