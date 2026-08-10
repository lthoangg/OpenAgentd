"""OpenTelemetryHook — industry-standard observability for every agent run.

Emits OpenTelemetry traces and metrics following the GenAI semantic conventions
(https://opentelemetry.io/docs/specs/semconv/gen-ai/).

Span hierarchy
--------------
Single-agent turn::

    [agent_run: {agent_name}]          ← before_agent … after_agent
      ├── [chat {model}]               ← wrap_model_call (per LLM call)
      └── [execute_tool: {tool_name}]  ← wrap_tool_call (per tool)

Team turn (pass ``lead_session_id``)::

    [agent_run: lead]                  ← lead member span
      ├── [chat gpt-4o]
      └── [execute_tool: team_message]

    [agent_run: researcher]            ← child of same trace via context propagation
      └── [chat gpt-4o]

Metrics emitted (via ``gen_ai.*`` OTel semantic conventions)
-----------------------------------------------------
- ``gen_ai.client.operation.duration``  — histogram (seconds) per LLM call
- ``gen_ai.client.token.usage``         — histogram (tokens) input + output
- ``openagentd.tool.execution.duration``   — histogram (seconds) per tool call
- ``openagentd.agent.runs.total``          — counter per completed agent run

Span attributes
---------------
All spans carry the standard ``gen_ai.*`` attributes where data is available.
``gen_ai.conversation.id`` is set to ``ctx.session_id`` (stable per conversation).
``run_id`` is a custom attribute that differentiates turns within a session.

Exporter
--------
By default spans/metrics go to the console (Python logging / structlog).
Set ``OTEL_EXPORTER_OTLP_ENDPOINT`` env var to forward to Jaeger / SigNoz /
Grafana without touching any hook code.

Usage::

    # Single-agent
    from app.agent.hooks.otel import OpenTelemetryHook
    hook = OpenTelemetryHook(agent_name="OpenAgentd", model_id="openai:gpt-4o")

    # Team member
    hook = OpenTelemetryHook(
        agent_name="researcher",
        model_id="openai:gpt-4o",
        lead_session_id=team.lead.session_id,
    )
"""

from __future__ import annotations

import time
import logging
from typing import TYPE_CHECKING

from contextvars import Token

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.context import Context as OtelContext
from opentelemetry.trace import SpanKind, StatusCode

from app.agent.errors import QuestionSuspended
from app.agent.usage import set_usage_span_attributes
from app.agent.hooks.base import BaseAgentHook
from app.core.otel import get_meter, get_tracer

if TYPE_CHECKING:
    from app.agent.schemas.chat import AssistantMessage, ToolCall
    from app.agent.state import AgentState, ModelCallHandler, ModelRequest, RunContext

_logger = logging.getLogger(__name__)

# Me stable trace context store: lead_session_id → OTel context
# Used to parent member spans under the lead's root span
_lead_contexts: dict[str, OtelContext] = {}


def _parse_model_id(model_id: str | None) -> tuple[str, str]:
    """Split 'provider:model' → (provider, model).  Graceful on bad input."""
    if not model_id:
        return "unknown", "unknown"
    if ":" in model_id:
        provider, _, model = model_id.partition(":")
        return provider or "unknown", model or "unknown"
    return "unknown", model_id


class OpenTelemetryHook(BaseAgentHook):
    """OTel-instrumented hook.  Replaces TelemetryHook for production observability.

    Args:
        agent_name: Display name for this agent (used in span names + attributes).
        model_id:   ``"provider:model"`` string from agent config (e.g. ``"openai:gpt-4o"``).
        lead_session_id: For team members — the lead's stable session_id used as
            the trace anchor.  ``None`` for single-agent mode.
    """

    def __init__(
        self,
        agent_name: str = "agent",
        model_id: str | None = None,
        lead_session_id: str | None = None,
    ) -> None:
        self._agent_name = agent_name
        self._lead_session_id = lead_session_id
        self._provider, self._model = _parse_model_id(model_id)

        self._tracer = get_tracer()
        self._meter = get_meter()

        # Me set up metrics instruments
        self._op_duration = self._meter.create_histogram(
            name="gen_ai.client.operation.duration",
            description="GenAI operation duration",
            unit="s",
        )
        self._token_usage = self._meter.create_histogram(
            name="gen_ai.client.token.usage",
            description="Number of input and output tokens used",
            unit="{token}",
        )
        self._tool_duration = self._meter.create_histogram(
            name="openagentd.tool.execution.duration",
            description="Tool execution duration",
            unit="s",
        )
        self._runs_counter = self._meter.create_counter(
            name="openagentd.agent.runs.total",
            description="Total completed agent runs",
        )

        # Me per-run state (reset in before_agent)
        self._agent_span: trace.Span | None = None
        self._agent_ctx_token: "Token[OtelContext] | None" = None
        self._run_start: float = 0.0

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def before_agent(
        self,
        ctx: "RunContext",
        state: "AgentState",
    ) -> None:
        """Start root agent-run span.  For team members, child under lead trace."""
        self._run_start = time.monotonic()
        session_id = ctx.session_id or "no-session"

        # Me resolve parent context — team member links under lead's trace
        parent_ctx = self._resolve_parent_context(session_id)

        span = self._tracer.start_span(
            f"agent_run {self._agent_name}",
            kind=SpanKind.INTERNAL,
            context=parent_ctx,
            attributes={
                "gen_ai.agent.name": self._agent_name,
                "gen_ai.provider.name": self._provider,
                "gen_ai.request.model": self._model,
                "gen_ai.conversation.id": session_id,
                "run_id": ctx.run_id,
            },
        )
        # Me attach span to current context so child spans nest under it
        ctx_with_span = trace.set_span_in_context(span)
        self._agent_ctx_token = otel_context.attach(ctx_with_span)
        self._agent_span = span

        # Me register lead context so team members can parent under it
        if self._lead_session_id is None:
            # Single-agent: register own session as anchor
            _lead_contexts[session_id] = ctx_with_span
        # Team members use lead_session_id — already registered by lead's before_agent

    async def after_agent(
        self,
        ctx: "RunContext",
        state: "AgentState",
        response: "AssistantMessage",
    ) -> None:
        """End root span, emit run counter metric."""
        elapsed = time.monotonic() - self._run_start

        if self._agent_span is not None:
            # Me attach final token totals to the root span
            usage = state.usage
            if usage.last_prompt_tokens:
                self._agent_span.set_attribute(
                    "gen_ai.usage.input_tokens", usage.last_prompt_tokens
                )
            if usage.last_completion_tokens:
                self._agent_span.set_attribute(
                    "gen_ai.usage.output_tokens", usage.last_completion_tokens
                )
            self._agent_span.set_status(StatusCode.OK)
            self._agent_span.end()
            self._agent_span = None

        if self._agent_ctx_token is not None:
            otel_context.detach(self._agent_ctx_token)
            self._agent_ctx_token = None

        # Me emit run counter
        self._runs_counter.add(
            1,
            {
                "gen_ai.agent.name": self._agent_name,
                "gen_ai.provider.name": self._provider,
                "gen_ai.request.model": self._model,
            },
        )

        _logger.debug(
            "otel_agent_run_complete agent=%s session=%s elapsed_s=%.3f",
            self._agent_name,
            ctx.session_id,
            elapsed,
        )

    # ── LLM call wrapping ─────────────────────────────────────────────────────

    async def wrap_model_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        request: "ModelRequest",
        handler: "ModelCallHandler",
    ) -> "AssistantMessage":
        """Wrap each LLM call in a span, record latency + token metrics."""
        t0 = time.monotonic()
        span_name = f"chat {self._model}"

        with self._tracer.start_as_current_span(
            span_name,
            kind=SpanKind.CLIENT,
            attributes={
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": self._provider,
                "gen_ai.request.model": self._model,
                "gen_ai.conversation.id": ctx.session_id or "no-session",
                "run_id": ctx.run_id,
                "gen_ai.agent.name": self._agent_name,
                "gen_ai.request.message_count": len(request.messages),
            },
        ) as span:
            try:
                result = await handler(request)
            except Exception as exc:
                span.set_attribute("error.type", type(exc).__name__)
                span.set_status(StatusCode.ERROR, str(exc))
                raise

            elapsed = time.monotonic() - t0

            # Me attach token usage from result extras.  `_stream_and_assemble`
            # populates `extra["usage"]` on the returned AssistantMessage so
            # these values are present whenever the provider streamed a usage
            # chunk (essentially always for supported providers).
            usage = result.extra.get("usage", {}) if result.extra else {}
            input_tokens: int = usage.get("input", 0)
            output_tokens: int = usage.get("output", 0)
            set_usage_span_attributes(span, usage)

            # Me response model if provider returns it
            resp_model = (result.extra or {}).get("model")
            if resp_model:
                span.set_attribute("gen_ai.response.model", resp_model)

            span.set_status(StatusCode.OK)

            # Me emit latency metric
            metric_attrs = {
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": self._provider,
                "gen_ai.request.model": self._model,
            }
            self._op_duration.record(elapsed, metric_attrs)

            # Me emit token usage metrics (input + output as separate observations)
            if input_tokens:
                self._token_usage.record(
                    input_tokens, {**metric_attrs, "gen_ai.token.type": "input"}
                )
            if output_tokens:
                self._token_usage.record(
                    output_tokens, {**metric_attrs, "gen_ai.token.type": "output"}
                )

            return result

    # ── Tool call wrapping ────────────────────────────────────────────────────

    async def wrap_tool_call(
        self,
        ctx: "RunContext",
        state: "AgentState",
        tool_call: "ToolCall",
        handler,
    ) -> str:
        """Wrap each tool execution in a child span."""
        tool_name = tool_call.function.name
        t0 = time.monotonic()

        with self._tracer.start_as_current_span(
            f"execute_tool {tool_name}",
            kind=SpanKind.INTERNAL,
            attributes={
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": tool_name,
                "gen_ai.tool.call.id": tool_call.id or "",
                "gen_ai.agent.name": self._agent_name,
                "gen_ai.conversation.id": ctx.session_id or "no-session",
                "run_id": ctx.run_id,
            },
        ) as span:
            try:
                result = await handler(ctx, state, tool_call)
            except QuestionSuspended:
                # Control flow, not a failure: ``ask_user`` handed the turn to
                # the user and the turn resumes from here once they answer.
                # Recording it as an error span made suspensions the single
                # largest "error" category in production telemetry.
                span.set_attribute("tool.suspended", True)
                span.set_status(StatusCode.OK)
                raise
            except Exception as exc:
                span.set_attribute("error.type", type(exc).__name__)
                span.set_status(StatusCode.ERROR, str(exc))
                raise

            elapsed = time.monotonic() - t0
            span.set_attribute("tool.result.length", len(result))
            span.set_status(StatusCode.OK)

            self._tool_duration.record(
                elapsed,
                {
                    "gen_ai.tool.name": tool_name,
                    "gen_ai.agent.name": self._agent_name,
                },
            )
            return result

    # ── Rate limit event ──────────────────────────────────────────────────────

    async def on_rate_limit(
        self,
        ctx: "RunContext",
        state: "AgentState",
        retry_after: float,
        attempt: int,
        max_attempts: int,
    ) -> None:
        """Record rate-limit retry as a span event on the active agent span."""
        if self._agent_span is not None:
            self._agent_span.add_event(
                "rate_limit",
                {
                    "retry_after_s": retry_after,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                },
            )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _resolve_parent_context(self, session_id: str) -> OtelContext | None:
        """Return OTel context to use as parent.

        - Team member: use lead's registered context so spans nest under lead trace.
        - Single-agent: no parent (root span).
        """
        if self._lead_session_id and self._lead_session_id in _lead_contexts:
            return _lead_contexts[self._lead_session_id]
        return None
