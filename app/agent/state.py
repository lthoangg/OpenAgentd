"""Mutable agent state that flows through the agent loop and hooks.

:class:`RunContext` is frozen, immutable metadata created once at the start of
:meth:`Agent.run`.  It carries identity fields that never change mid-run.

:class:`ModelRequest` is an immutable per-LLM-call view built just before each
``stream()`` call.  Hooks receive it via :meth:`~app.agent.hooks.BaseAgentHook.before_model`
and :meth:`~app.agent.hooks.BaseAgentHook.wrap_model_call`.  Use
:meth:`ModelRequest.override` to produce a modified copy — never mutate in place.

:class:`AgentState` is created at the start of each :meth:`Agent.run` call and
passed to every hook.  Hooks may read or mutate it.

:class:`UsageInfo` tracks token consumption across all model calls in a run.

The :data:`ToolCallHandler` and :data:`ModelCallHandler` type aliases define
the signatures for the innermost executor and each hook wrapper.

Usage::

    ctx = RunContext(
        session_id="abc-123",
        run_id=str(uuid7()),
        agent_name="assistant",
    )
    state = AgentState(messages=messages)
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any

from app.agent.providers.capabilities import ModelCapabilities
from app.agent.schemas.agent import AgentContext
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    SystemMessage,
    ToolCall,
)

# Signature for innermost tool executor and each hook wrapper.
# ``(ctx, state, tool_call) -> result_string``
ToolCallHandler = Callable[["RunContext", "AgentState", ToolCall], Awaitable[str]]

# Signature for innermost model executor and each wrap_model_call wrapper.
# ``(request) -> AssistantMessage``
ModelCallHandler = Callable[["ModelRequest"], Awaitable[AssistantMessage]]


@dataclass(frozen=True)
class RunContext:
    """Immutable per-run metadata. Created once at the start of Agent.run()."""

    session_id: str | None
    run_id: str
    agent_name: str
    # UTC datetime when the session was first created.  Frozen here so that
    # dynamic prompts inject a stable date for the lifetime of the session —
    # even if the user sends a follow-up message after midnight.
    session_created_at: datetime | None = None


@dataclass(frozen=True)
class ModelRequest:
    """Immutable per-LLM-call view passed to hooks via ``before_model`` and
    ``wrap_model_call``.

    Built by the agent loop just before each ``stream()`` call.  Never mutate
    directly — use :meth:`override` to produce a modified copy::

        request = request.override(system_prompt=request.system_prompt + " Be concise.")

    Attributes
    ----------
    messages:
        The message list the LLM will see (already filtered by
        ``exclude_from_context``).
    system_prompt:
        The system prompt string for this call.
    context:
        Optional :class:`~app.agent.schemas.agent.AgentContext` instance
        carrying typed per-invocation data (user role, locale, …).
    """

    messages: tuple[ChatMessage, ...]
    system_prompt: str
    context: AgentContext | None = None

    def override(self, **kw: Any) -> "ModelRequest":
        """Return a new :class:`ModelRequest` with the given fields replaced."""
        return replace(self, **kw)


@dataclass
class UsageInfo:
    """Token usage tracking for the current run."""

    last_prompt_tokens: int = 0
    last_completion_tokens: int = 0
    total_tokens: int = 0
    # Me store per-call usage so checkpointer can persist
    last_usage: dict[str, Any] | None = None


@dataclass
class AgentState:
    """Per-run mutable state shared across the agent loop and hooks.

    Fields
    ------
    messages:
        The live message list for the current agent turn.  Hooks may append
        or inspect messages (e.g. summarization appends a summary message).
    usage:
        Token usage counters updated after each model call.
    system_prompt:
        The base system prompt used to construct each ``ModelRequest``.
        Read by the loop each iteration — not directly sent to the LLM
        (use ``wrap_model_call`` + ``request.override(system_prompt=...)``
        to change what the model sees per call).
    context:
        Optional :class:`~app.agent.schemas.agent.AgentContext` instance
        carrying typed per-invocation data (user role, locale, feature flags, …).
        Accessible in hooks as ``state.context`` and in tools via injection.
    capabilities:
        :class:`~app.agent.providers.capabilities.ModelCapabilities` for the
        active model.  Set once by the agent loop at run start; tools use this
        to gate multimodal behaviour (e.g. skip image data for non-vision models).
    tool_names:
        Sorted list of tool names available for this run.  Set once at run start
        by the agent loop; read by hooks (e.g. session logging).
    metadata:
        Open-ended bag for hooks and tools to share ephemeral data within a run.
    """

    messages: list[ChatMessage]
    usage: UsageInfo = field(default_factory=UsageInfo)
    metadata: dict[str, Any] = field(default_factory=dict)
    system_prompt: str = ""
    context: AgentContext | None = None
    capabilities: ModelCapabilities = field(default_factory=ModelCapabilities)
    tool_names: list[str] = field(default_factory=list)
    tool_defs: list[dict[str, Any]] = field(default_factory=list)

    @property
    def messages_for_llm(self) -> list[ChatMessage]:
        """Computed view: messages visible to the LLM (no system, no excluded)."""
        return [
            m
            for m in self.messages
            if not m.exclude_from_context and not isinstance(m, SystemMessage)
        ]


def _wrap_tool_hook(hook: Any, next_handler: ToolCallHandler) -> ToolCallHandler:
    """Wrap *next_handler* with a single hook's ``wrap_tool_call``."""

    async def _wrapped(ctx: RunContext, state: AgentState, tc: ToolCall) -> str:
        return await hook.wrap_tool_call(ctx, state, tc, next_handler)

    return _wrapped


def build_tool_chain(
    hooks: list[Any],
    execute_fn: ToolCallHandler,
) -> ToolCallHandler:
    """Build a tool execution chain from *hooks* wrapping *execute_fn*.

    The first hook in the list becomes the outermost wrapper::

        Hook0 → Hook1 → … → execute_fn

    Hooks that don't override ``wrap_tool_call`` pass through unchanged.
    """
    from app.agent.hooks.base import BaseAgentHook

    handler = execute_fn
    for hook in reversed(hooks):
        # Skip hooks that do not override wrap_tool_call
        if getattr(type(hook), "wrap_tool_call", None) is BaseAgentHook.wrap_tool_call:
            continue
        handler = _wrap_tool_hook(hook, handler)
    return handler


def build_model_chain(
    hooks: list[Any],
    ctx: RunContext,
    state: AgentState,
    execute_fn: ModelCallHandler,
) -> ModelCallHandler:
    """Build a model call chain from *hooks* wrapping *execute_fn*.

    ``ctx`` and ``state`` are captured in each wrapper closure so
    ``wrap_model_call`` receives them on every call.

    The first hook in the list becomes the outermost wrapper::

        Hook0 → Hook1 → … → execute_fn
    """
    from app.agent.hooks.base import BaseAgentHook

    handler = execute_fn
    for hook in reversed(hooks):
        # Skip hooks that do not override wrap_model_call
        if (
            getattr(type(hook), "wrap_model_call", None)
            is BaseAgentHook.wrap_model_call
        ):
            continue

        def _make_wrapper(_hook: Any, _next: ModelCallHandler) -> ModelCallHandler:
            async def _wrapped(request: ModelRequest) -> AssistantMessage:
                return await _hook.wrap_model_call(ctx, state, request, _next)

            return _wrapped

        handler = _make_wrapper(hook, handler)
    return handler
