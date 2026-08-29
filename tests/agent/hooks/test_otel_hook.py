"""Tests for app/agent/hooks/otel.py — OpenTelemetryHook.

Uses an in-memory ``InMemorySpanExporter`` so tests can introspect the spans
emitted by the hook without writing to disk or relying on the global
``setup_otel`` plumbing.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace.status import StatusCode

from app.agent.errors import QuestionSuspended
from app.agent.hooks import otel as otel_module
from app.agent.hooks.otel import OpenTelemetryHook, _parse_model_id
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    ToolCall,
)
from app.agent.state import AgentState, ModelRequest, RunContext


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def span_exporter(monkeypatch):
    """Install an in-memory span exporter and matching tracer.

    The hook reads its tracer via ``get_tracer()``; we monkeypatch that
    helper to point at our isolated provider so each test starts clean.
    """
    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    tracer = provider.get_tracer("test")
    monkeypatch.setattr(otel_module, "get_tracer", lambda: tracer)

    yield exporter


@pytest.fixture(autouse=True)
def stub_meter(monkeypatch):
    """Replace get_meter() with a NoOp implementation so metric instruments
    work without a real MeterProvider."""
    from opentelemetry.metrics import NoOpMeter

    monkeypatch.setattr(otel_module, "get_meter", lambda: NoOpMeter("test"))


def make_ctx(session_id: str | None = "sess_1", run_id: str = "run_1") -> RunContext:
    return RunContext(session_id=session_id, run_id=run_id, agent_name="bot")


def make_state(messages=None, system_prompt: str = "") -> AgentState:
    return AgentState(messages=messages or [], system_prompt=system_prompt)


# ---------------------------------------------------------------------------
# _parse_model_id
# ---------------------------------------------------------------------------


class TestParseModelId:
    def test_provider_colon_model(self):
        assert _parse_model_id("openai:gpt-4o") == ("openai", "gpt-4o")

    def test_no_colon_returns_unknown_provider(self):
        assert _parse_model_id("gpt-4o") == ("unknown", "gpt-4o")

    def test_none_returns_unknown_unknown(self):
        assert _parse_model_id(None) == ("unknown", "unknown")

    def test_empty_string_returns_unknown_unknown(self):
        assert _parse_model_id("") == ("unknown", "unknown")

    def test_only_colon_returns_unknown_unknown(self):
        assert _parse_model_id(":") == ("unknown", "unknown")

    def test_provider_only(self):
        assert _parse_model_id("openai:") == ("openai", "unknown")


# ---------------------------------------------------------------------------
# before_agent / after_agent — root span lifecycle
# ---------------------------------------------------------------------------


class TestAgentSpan:
    async def test_before_agent_starts_root_span(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="alice", model_id="openai:gpt-4o")
        ctx = make_ctx(session_id="s1", run_id="r1")
        state = make_state()

        await hook.before_agent(ctx, state)
        # Span is started but not yet ended; finalise to inspect.
        await hook.after_agent(ctx, state, AssistantMessage(content="ok"))

        spans = span_exporter.get_finished_spans()
        assert len(spans) == 1
        span = spans[0]
        assert span.name == "agent_run alice"
        assert span.attributes["gen_ai.agent.name"] == "alice"
        assert span.attributes["gen_ai.provider.name"] == "openai"
        assert span.attributes["gen_ai.request.model"] == "gpt-4o"
        assert span.attributes["gen_ai.conversation.id"] == "s1"
        assert span.attributes["run_id"] == "r1"
        assert span.status.status_code == StatusCode.OK

    async def test_after_agent_records_token_usage(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bob", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        state.usage.last_prompt_tokens = 250
        state.usage.last_completion_tokens = 100

        await hook.before_agent(ctx, state)
        await hook.after_agent(ctx, state, AssistantMessage(content="ok"))

        span = span_exporter.get_finished_spans()[0]
        assert span.attributes["gen_ai.usage.input_tokens"] == 250
        assert span.attributes["gen_ai.usage.output_tokens"] == 100

    async def test_before_agent_with_no_session_id(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="anon")
        ctx = make_ctx(session_id=None)
        state = make_state()

        await hook.before_agent(ctx, state)
        await hook.after_agent(ctx, state, AssistantMessage(content="ok"))

        span = span_exporter.get_finished_spans()[0]
        assert span.attributes["gen_ai.conversation.id"] == "no-session"


# ---------------------------------------------------------------------------
# wrap_model_call — chat span + token attributes
# ---------------------------------------------------------------------------


class TestWrapModelCall:
    async def test_creates_chat_span(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        request = ModelRequest(
            messages=(HumanMessage(content="hi"),), system_prompt="s"
        )

        async def handler(_req):
            return AssistantMessage(content="response")

        result = await hook.wrap_model_call(ctx, state, request, handler)
        assert result.content == "response"

        spans = span_exporter.get_finished_spans()
        chat_spans = [s for s in spans if s.name == "chat gpt-4o"]
        assert len(chat_spans) == 1
        assert chat_spans[0].attributes["gen_ai.operation.name"] == "chat"
        assert chat_spans[0].attributes["gen_ai.request.message_count"] == 1
        assert chat_spans[0].status.status_code == StatusCode.OK

    async def test_records_usage_attributes_from_extra(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        request = ModelRequest(messages=(), system_prompt="s")

        async def handler(_req):
            return AssistantMessage(
                content="r",
                extra={
                    "usage": {
                        "input": 100,
                        "output": 50,
                        "cache": 25,
                        "cache_write": 40,
                        "thoughts": 10,
                        "tool_use": 5,
                        "cost": {"estimated_usd": 0.00125},
                    },
                    "model": "gpt-4o-2024-08-06",
                },
            )

        await hook.wrap_model_call(ctx, state, request, handler)

        chat = [
            s for s in span_exporter.get_finished_spans() if s.name == "chat gpt-4o"
        ][0]
        assert chat.attributes["gen_ai.usage.input_tokens"] == 100
        assert chat.attributes["gen_ai.usage.output_tokens"] == 50
        assert chat.attributes["gen_ai.usage.cache_read.input_tokens"] == 25
        # Cache writes carry their own price, so the span has to record them
        # or the estimated cost cannot be reconstructed from telemetry.
        assert chat.attributes["gen_ai.usage.cache_creation.input_tokens"] == 40
        assert chat.attributes["gen_ai.usage.reasoning_tokens"] == 10
        assert chat.attributes["gen_ai.usage.tool_use_tokens"] == 5
        assert chat.attributes["gen_ai.usage.estimated_cost_usd"] == 0.00125
        assert chat.attributes["gen_ai.response.model"] == "gpt-4o-2024-08-06"

    async def test_handler_exception_marks_error_status(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        request = ModelRequest(messages=(), system_prompt="s")

        class BoomError(RuntimeError):
            pass

        async def handler(_req):
            raise BoomError("provider down")

        with pytest.raises(BoomError):
            await hook.wrap_model_call(ctx, state, request, handler)

        chat = [
            s for s in span_exporter.get_finished_spans() if s.name == "chat gpt-4o"
        ][0]
        assert chat.status.status_code == StatusCode.ERROR
        assert chat.attributes["error.type"] == "BoomError"

    async def test_missing_extra_does_not_crash(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        request = ModelRequest(messages=(), system_prompt="s")

        async def handler(_req):
            return AssistantMessage(content="r")  # no extra

        result = await hook.wrap_model_call(ctx, state, request, handler)
        assert result.content == "r"
        # No usage attributes set, but span finished OK
        chat = [
            s for s in span_exporter.get_finished_spans() if s.name == "chat gpt-4o"
        ][0]
        assert chat.status.status_code == StatusCode.OK


# ---------------------------------------------------------------------------
# wrap_tool_call — execute_tool span
# ---------------------------------------------------------------------------


class TestWrapToolCall:
    async def test_creates_tool_span_on_success(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        tool_call = ToolCall(
            id="call_123",
            function=FunctionCall(name="search_web", arguments="{}"),
        )

        async def handler(_ctx, _state, _tc):
            return "search results here"

        result = await hook.wrap_tool_call(ctx, state, tool_call, handler)
        assert result == "search results here"

        spans = span_exporter.get_finished_spans()
        tool_spans = [s for s in spans if s.name == "execute_tool search_web"]
        assert len(tool_spans) == 1
        attrs = tool_spans[0].attributes
        assert attrs["gen_ai.tool.name"] == "search_web"
        assert attrs["gen_ai.tool.call.id"] == "call_123"
        assert attrs["tool.result.length"] == len("search results here")
        assert tool_spans[0].status.status_code == StatusCode.OK

    async def test_handler_exception_marks_error(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        tool_call = ToolCall(
            id="t_1",
            function=FunctionCall(name="broken", arguments="{}"),
        )

        async def handler(_ctx, _state, _tc):
            raise ValueError("bad input")

        with pytest.raises(ValueError):
            await hook.wrap_tool_call(ctx, state, tool_call, handler)

        tool = [
            s
            for s in span_exporter.get_finished_spans()
            if s.name == "execute_tool broken"
        ][0]
        assert tool.status.status_code == StatusCode.ERROR
        assert tool.attributes["error.type"] == "ValueError"

    async def test_question_suspension_is_not_an_error(self, span_exporter):
        """``ask_user`` handing the turn to the user is control flow.

        Marking the span ERROR inflated the production error-span count by
        ~2.5x (27 of 44 error spans over 7 days), which made any alert built
        on span status a measure of user-interaction volume instead of health.
        """
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        tool_call = ToolCall(
            id="t_2",
            function=FunctionCall(name="ask_user", arguments="{}"),
        )
        question_id = uuid4()
        session_id = uuid4()

        async def handler(_ctx, _state, _tc):
            raise QuestionSuspended(question_id=question_id, session_id=session_id)

        # Still propagates — the agent loop needs it to unwind cleanly.
        with pytest.raises(QuestionSuspended):
            await hook.wrap_tool_call(ctx, state, tool_call, handler)

        tool = [
            s
            for s in span_exporter.get_finished_spans()
            if s.name == "execute_tool ask_user"
        ][0]
        assert tool.status.status_code != StatusCode.ERROR
        assert "error.type" not in tool.attributes
        assert tool.attributes["tool.suspended"] is True


# ---------------------------------------------------------------------------
# on_rate_limit — span event recorded
# ---------------------------------------------------------------------------


class TestOnRateLimit:
    async def test_records_event_on_active_span(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()

        await hook.before_agent(ctx, state)
        await hook.on_rate_limit(ctx, state, retry_after=1.5, attempt=1, max_attempts=3)
        await hook.after_agent(ctx, state, AssistantMessage(content="ok"))

        span = span_exporter.get_finished_spans()[0]
        events = list(span.events)
        assert len(events) == 1
        evt = events[0]
        assert evt.name == "rate_limit"
        assert evt.attributes["retry_after_s"] == 1.5
        assert evt.attributes["attempt"] == 1
        assert evt.attributes["max_attempts"] == 3

    async def test_no_active_span_is_safe(self):
        """Rate-limit signal before before_agent shouldn't crash."""
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()
        # No before_agent call → _agent_span is None
        await hook.on_rate_limit(ctx, state, retry_after=1.0, attempt=1, max_attempts=3)


# ---------------------------------------------------------------------------
# Integration-style — chat span nested under agent_run span
# ---------------------------------------------------------------------------


class TestSpanNesting:
    async def test_chat_span_nested_under_agent_run(self, span_exporter):
        hook = OpenTelemetryHook(agent_name="bot", model_id="openai:gpt-4o")
        ctx = make_ctx()
        state = make_state()

        await hook.before_agent(ctx, state)

        request = ModelRequest(messages=(), system_prompt="s")
        handler = AsyncMock(return_value=AssistantMessage(content="r"))
        await hook.wrap_model_call(ctx, state, request, handler)

        await hook.after_agent(ctx, state, AssistantMessage(content="ok"))

        spans = {s.name: s for s in span_exporter.get_finished_spans()}
        chat = spans["chat gpt-4o"]
        agent_run = spans["agent_run bot"]
        # Same trace, chat's parent is agent_run
        assert chat.context.trace_id == agent_run.context.trace_id
        assert chat.parent is not None
        assert chat.parent.span_id == agent_run.context.span_id
