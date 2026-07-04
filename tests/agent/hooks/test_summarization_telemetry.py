from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from app.agent.hooks import summarization as summarization_module
from app.agent.hooks.summarization import build_summarization_hook
from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ChatMessage
from app.agent.state import ModelRequest, RunContext


@pytest.fixture
def span_exporter(monkeypatch):
    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("test")
    monkeypatch.setattr(summarization_module, "get_tracer", lambda: tracer)
    yield exporter


class ProviderWithoutModel(MagicMock):
    provider_name = "googlegenai"
    model = None

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        async def _gen():
            yield ChatCompletionChunk(
                id="chunk-1",
                created=1,
                model="gemini-3.1-flash-lite",
                choices=[],
            )
            delta = MagicMock()
            delta.content = "Summary text."
            choice = MagicMock()
            choice.delta = delta
            chunk = MagicMock()
            chunk.choices = [choice]
            chunk.usage = None
            yield chunk

        return _gen()


async def _noop_model_handler(request: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="done")


@pytest.mark.asyncio
async def test_summarization_span_uses_configured_model_id_when_provider_lacks_model(
    span_exporter,
):
    provider = ProviderWithoutModel()
    hook = build_summarization_hook(
        provider,
        model_id="googlegenai:gemini-3.1-flash-lite",
    )
    assert hook is not None

    ctx = RunContext(session_id="test-session", run_id="run-1", agent_name="lead")

    await hook._call_llm(
        ctx,
        messages=[],
    )

    spans = span_exporter.get_finished_spans()
    span = next(s for s in spans if s.name == "summarization_llm_call")
    assert span.attributes["gen_ai.provider.name"] == "googlegenai"
    assert span.attributes["gen_ai.request.model"] == "gemini-3.1-flash-lite"
