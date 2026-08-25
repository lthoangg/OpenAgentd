from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from app.agent import usage as usage_module
from app.agent.hooks import summarization as summarization_module
from app.agent.hooks.summarization import build_summarization_hook
from app.agent.providers.model_metadata import ModelCost
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    Usage,
)
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


class ProviderWithBareModel(MagicMock):
    """Mirrors real providers: `.model` is the bare id used to build the URL."""

    provider_name = "codex"
    model = "gpt-5.6-sol"

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
                model="gpt-5.6-sol",
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(content="Summary text."),
                    )
                ],
                usage=Usage(
                    prompt_tokens=1_000,
                    completion_tokens=100,
                    total_tokens=1_100,
                    cached_tokens=200,
                ),
            )

        return _gen()


@pytest.mark.asyncio
async def test_summarization_span_records_cost_when_provider_model_is_unqualified(
    span_exporter, monkeypatch
):
    """Cost lookups need the qualified `provider:model` registry key.

    Providers expose a bare `.model` (it builds the request URL), so preferring
    it over the configured `model_id` resolves to an unknown registry entry and
    silently drops `gen_ai.usage.estimated_cost_usd` — tokens land, dollars do
    not. Stubbed the registry the way the real one behaves: qualified key hits,
    anything else returns empty prices.
    """
    monkeypatch.setattr(
        usage_module,
        "get_cost_at",
        lambda model_id, at: (
            ModelCost(input=5.0, output=30.0, cache_read=0.5)
            if model_id == "codex:gpt-5.6-sol"
            else ModelCost()
        ),
    )

    hook = build_summarization_hook(
        ProviderWithBareModel(),
        model_id="codex:gpt-5.6-sol",
    )
    assert hook is not None

    ctx = RunContext(session_id="test-session", run_id="run-1", agent_name="lead")

    await hook._call_llm(ctx, messages=[])

    spans = span_exporter.get_finished_spans()
    span = next(s for s in spans if s.name == "summarization_llm_call")

    # 800 fresh input @ $5/M + 200 cache read @ $0.5/M + 100 output @ $30/M
    assert span.attributes["gen_ai.usage.estimated_cost_usd"] == pytest.approx(0.0071)
    # Telemetry keeps reporting the bare model name.
    assert span.attributes["gen_ai.request.model"] == "gpt-5.6-sol"
    assert span.attributes["gen_ai.provider.name"] == "codex"
