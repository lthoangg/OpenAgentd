"""StreamPublisherHook — publishes agent events to the shared stream store.

Reuses the same stream_store.push_event() / mark_done() infrastructure as the
single-agent chat route, so the team SSE stream is identical in shape to the
single-agent stream.  The frontend can subscribe to GET /team/stream/{session_id}
and receive exactly the same event types it already handles.

All events carry an ``agent`` field so the frontend can distinguish who is
speaking when multiple members are active simultaneously.
"""

from __future__ import annotations

import contextlib
import time
from typing import TYPE_CHECKING, Any

from app.agent.hooks.base import BaseAgentHook
from app.agent.tool_id_resolver import ToolIdResolver
from app.services import memory_stream_store as stream_store
from app.agent.schemas.events import (
    MessageEvent,
    PermissionAskedEvent,
    ProviderStatusEvent,
    RateLimitEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolEndEvent,
    ToolOutputDeltaEvent,
    ToolStartEvent,
    UsageEvent,
)
from app.services.stream_envelope import AnyStreamEvent, StreamEnvelope

if TYPE_CHECKING:
    from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ToolCall
    from app.agent.state import AgentState, ModelRequest, RunContext, ToolCallHandler


class StreamPublisherHook(BaseAgentHook):
    """Publishes every agent event to the stream store via stream_store.push_event().

    Designed for team members: each member gets its own instance bound to the
    shared lead session_id so all agents write to the same stream key,
    and the frontend receives a unified event feed tagged by agent name.

    ``mark_done`` is intentionally NOT called here — the team coordinator
    (AgentTeam) calls it once after all members are idle, not per-member.

    Args:
        session_id: The stream key suffix (team lead's session_id).
        agent_name: Name of the agent this hook is attached to.
        publish_reasoning: When false, suppress live ``thinking`` events while
            still allowing reasoning content to be assembled and persisted.
    """

    def __init__(
        self,
        session_id: str,
        agent_name: str,
        *,
        publish_reasoning: bool = True,
    ) -> None:
        self._session_id = session_id
        self._agent_name = agent_name
        self._publish_reasoning = publish_reasoning
        self._resolver = ToolIdResolver()
        self._turn_started: float | None = None
        self._model_started: float | None = None
        # Me track per-turn usage for turn-total summary
        self._total_prompt = 0
        self._total_completion = 0
        self._total_cached: int | None = None
        self._total_thoughts: int | None = None
        self._total_tool_use: int | None = None
        self._usage_count = 0
        self._used_models: set[str] = set()
        self._current_model: str | None = None

    async def _push(self, event: AnyStreamEvent) -> None:
        """Fire-and-forget push to stream store. Never raises."""
        with contextlib.suppress(Exception):
            await stream_store.push_event(
                self._session_id, StreamEnvelope.from_event(event)
            )

    async def before_agent(self, ctx: "RunContext", state: "AgentState") -> None:
        self._turn_started = time.monotonic()

    async def before_model(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
    ) -> None:
        self._model_started = time.monotonic()

    async def after_model(
        self, ctx: "RunContext", state: "AgentState", response: "AssistantMessage"
    ) -> None:
        started = (
            self._turn_started
            if self._turn_started is not None
            else self._model_started
        )
        if started is not None:
            response.extra = dict(response.extra or {})
            response.extra["duration_ms"] = round(
                (time.monotonic() - started) * 1000,
                3,
            )
        usage = (response.extra or {}).get("usage")
        if isinstance(usage, dict):
            await self._publish_usage(usage, state)

    async def _publish_usage(self, usage: dict[str, Any], state: "AgentState") -> None:
        """Publish the one usage frame this model call produced.

        ``stream_and_assemble`` already collapses the provider's usage chunks
        into a single snapshot on ``extra["usage"]`` — the very dict the OTel
        span and the persisted message carry. Reading it here means the live
        meter cannot disagree with telemetry, and providers that repeat a
        cumulative usage snapshot on every streamed chunk (Gemini, several
        OpenAI-compatible gateways) can no longer multiply the totals.
        """
        prompt_tokens = int(usage.get("input") or 0)
        completion_tokens = int(usage.get("output") or 0)
        cached = usage.get("cache")
        thoughts = usage.get("thoughts")
        tool_use = usage.get("tool_use")
        cost = usage.get("cost")
        estimated_cost = cost.get("estimated_usd") if isinstance(cost, dict) else None

        self._total_prompt += prompt_tokens
        self._total_completion += completion_tokens
        if cached is not None:
            self._total_cached = (self._total_cached or 0) + int(cached)
        if thoughts is not None:
            self._total_thoughts = (self._total_thoughts or 0) + int(thoughts)
        if tool_use is not None:
            self._total_tool_use = (self._total_tool_use or 0) + int(tool_use)
        self._usage_count += 1

        metadata: dict[str, Any] = {"agent": self._agent_name}
        display_model = self._current_model or state.metadata.get("effective_model")
        if isinstance(display_model, str) and display_model:
            metadata["model"] = display_model

        # Per-call values, exactly as the message persists them: input is this
        # call's context size, output and cost are what this call alone added.
        # The client accumulates output and cost the same way
        # ``sumUsageFromMessages`` does when it replays persisted messages, so
        # a mid-turn reconcile and the live stream agree. Publishing a
        # turn-cumulative total here would double-count every call the
        # reconcile had already folded in.
        await self._push(
            UsageEvent(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
                cached_tokens=cached,
                thoughts_tokens=thoughts,
                tool_use_tokens=tool_use,
                estimated_cost_usd=estimated_cost,
                metadata=metadata,
            )
        )

    async def on_model_delta(
        self, ctx: "RunContext", state: "AgentState", chunk: "ChatCompletionChunk"
    ) -> None:
        metadata: dict[str, Any] = {}
        display_model = (
            chunk.model or self._current_model or state.metadata.get("effective_model")
        )
        if isinstance(display_model, str) and display_model:
            metadata["model"] = display_model
        if chunk.model:
            self._current_model = chunk.model
            self._used_models.add(chunk.model)

        if not chunk.choices:
            return

        delta = chunk.choices[0].delta

        if self._publish_reasoning and delta.reasoning_content:
            await self._push(
                ThinkingEvent(
                    agent=self._agent_name,
                    text=delta.reasoning_content,
                    metadata=metadata,
                )
            )

        if delta.content:
            await self._push(
                MessageEvent(
                    agent=self._agent_name, text=delta.content, metadata=metadata
                )
            )

        for tc in delta.tool_calls or []:
            fn_name = tc.function.name if tc.function and tc.function.name else ""
            if not fn_name:
                continue
            tc_id = tc.id or f"{self._agent_name}:{fn_name}:{tc.index}"
            if not self._resolver.register(fn_name, tc_id):
                continue
            await self._push(
                ToolCallEvent(
                    agent=self._agent_name,
                    tool_call_id=tc_id,
                    name=fn_name,
                )
            )

    async def wrap_tool_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        tool_call: "ToolCall",
        handler: "ToolCallHandler",
    ) -> str:
        import json as _json

        from app.agent.permission import get_permission_service

        fn_name = tool_call.function.name if tool_call.function else ""
        tc_id = self._resolver.resolve_start(fn_name, tool_call.id)

        # ── Permission check before tool execution ────────────────────
        # Extract a human-readable "command pattern" from the tool arguments
        # so the permission system can show the user what the agent wants to do.
        try:
            args_dict: dict = (
                _json.loads(tool_call.function.arguments or "{}")
                if tool_call.function
                else {}
            )
        except Exception:
            args_dict = {}

        # Build patterns: use the command/path argument if present, else tool name
        patterns: list[str] = []
        if "command" in args_dict:
            # Extract the command prefix (first 1-3 tokens, matching opencode's BashArity)
            cmd_str = str(args_dict["command"]).strip()
            patterns.append(cmd_str[:200] if cmd_str else fn_name)
        elif "path" in args_dict or "file_path" in args_dict:
            p = args_dict.get("path") or args_dict.get("file_path") or fn_name
            patterns.append(str(p))
        else:
            patterns.append(fn_name)

        permission_service = get_permission_service()

        # Fire SSE events for ask/reply (even in auto-allow mode)
        def _on_ask_callback(req):
            """Fire-and-forget SSE event when permission is requested."""
            import asyncio as _asyncio
            import contextlib as _contextlib

            async def _emit():
                with _contextlib.suppress(Exception):
                    await stream_store.push_event(
                        self._session_id,
                        StreamEnvelope.from_event(
                            PermissionAskedEvent(
                                request_id=req.id,
                                session_id=self._session_id,
                                tool=fn_name,
                                patterns=req.patterns,
                                metadata=req.metadata,
                            )
                        ),
                    )

            # Schedule without blocking wrap_tool_call
            _asyncio.create_task(_emit())

        await permission_service.ask(
            tool=fn_name,
            patterns=patterns,
            always_patterns=patterns,
            metadata={"tool_call_id": tc_id, "agent": self._agent_name},
            on_ask=_on_ask_callback,
        )

        # ── Execute tool ──────────────────────────────────────────────
        started = time.monotonic()
        await self._push(
            ToolStartEvent(
                agent=self._agent_name,
                tool_call_id=tc_id,
                name=fn_name,
                arguments=tool_call.function.arguments if tool_call.function else None,
            )
        )

        callbacks: dict[str, object] = state.metadata.setdefault(
            "_tool_output_callbacks", {}
        )
        sequence = 0

        async def _emit_output_delta(text: str) -> None:
            nonlocal sequence
            if not text:
                return
            sequence += 1
            await self._push(
                ToolOutputDeltaEvent(
                    agent=self._agent_name,
                    tool_call_id=tc_id,
                    name=fn_name,
                    text=text,
                    sequence=sequence,
                )
            )

        callbacks[tool_call.id] = _emit_output_delta
        try:
            result = await handler(ctx, state, tool_call)
        finally:
            callbacks.pop(tool_call.id, None)

        duration_ms = round((time.monotonic() - started) * 1000, 3)
        state.metadata.setdefault("_tool_duration_ms", {})[tool_call.id] = duration_ms
        event_metadata = {"duration_ms": duration_ms}
        mcp_app = state.metadata.get("_mcp_apps", {}).get(tool_call.id)
        if mcp_app:
            event_metadata["mcp_app"] = mcp_app
        end_tc_id = self._resolver.resolve_end(tool_call.id)
        await self._push(
            ToolEndEvent(
                agent=self._agent_name,
                tool_call_id=end_tc_id,
                name=fn_name,
                result=result or None,
                metadata=event_metadata,
            )
        )
        return result

    async def on_rate_limit(
        self,
        ctx: "RunContext",
        state: "AgentState",
        retry_after: int,
        attempt: int,
        max_attempts: int,
    ) -> None:
        await self._push(
            RateLimitEvent(
                retry_after=retry_after,
                attempt=attempt,
                max_attempts=max_attempts,
            )
        )

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
        await self._push(
            ProviderStatusEvent(
                agent=self._agent_name,
                status="retrying",
                model=model,
                attempt=attempt,
                max_attempts=max_attempts,
                delay_seconds=delay_seconds,
                error_type=error_type,
                status_code=status_code,
                retry_after=retry_after,
            )
        )

    async def on_provider_exhausted(
        self,
        ctx: "RunContext",
        state: "AgentState",
        model: str,
        max_attempts: int,
        error_type: str,
        status_code: int | None = None,
    ) -> None:
        await self._push(
            ProviderStatusEvent(
                agent=self._agent_name,
                status="exhausted",
                model=model,
                max_attempts=max_attempts,
                error_type=error_type,
                status_code=status_code,
            )
        )

    async def after_agent(
        self, ctx: "RunContext", state: "AgentState", response: "AssistantMessage"
    ) -> None:
        # Me emit turn-total usage summary when multiple model calls were made
        if self._usage_count > 1 and (self._total_prompt or self._total_completion):
            await self._push(
                UsageEvent(
                    prompt_tokens=self._total_prompt,
                    completion_tokens=self._total_completion,
                    total_tokens=self._total_prompt + self._total_completion,
                    cached_tokens=self._total_cached,
                    thoughts_tokens=self._total_thoughts,
                    tool_use_tokens=self._total_tool_use,
                    metadata={
                        "turn_total": True,
                        "agent": self._agent_name,
                        "models": sorted(self._used_models) or None,
                    },
                )
            )
        # Me reset counters so hook can be reused across turns
        self._total_prompt = 0
        self._total_completion = 0
        self._total_cached = None
        self._total_thoughts = None
        self._total_tool_use = None
        self._usage_count = 0
        self._used_models = set()
        self._current_model = None
