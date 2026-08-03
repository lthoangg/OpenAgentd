"""OTel telemetry tests for ``generate_image``.

Swap the global tracer/meter providers for in-memory ones, drive
``_generate_image`` through success + several error paths, then assert on
span names, attributes, status codes, and histogram datapoints.

Reuses helpers from ``test_openai_backend`` so mock-transport wiring stays
consistent across the suite.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import base64
import httpx2
import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode

from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.multimodalities import _config as mm_config
from app.agent.tools.multimodalities import _metrics as mm_metrics
from app.agent.tools.multimodalities.image import _generate_image

# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def tmp_sandbox(tmp_path: Path) -> Iterator[SandboxConfig]:
    sandbox = SandboxConfig(workspace=str(tmp_path / "workspace"))
    token = set_sandbox(sandbox)
    try:
        yield sandbox
    finally:
        del token


@pytest.fixture
def config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg = tmp_path / "config"
    cfg.mkdir()
    monkeypatch.setattr("app.core.config.settings.OPENAGENTD_CONFIG_DIR", str(cfg))
    monkeypatch.setattr(mm_config, "_cache", None)
    return cfg


@pytest.fixture(autouse=True)
def _clear_api_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip provider keys that may have been loaded from a dev ``.env``."""
    monkeypatch.setattr("app.core.config.settings.OPENAI_API_KEY", None)


@pytest.fixture
def span_exporter(monkeypatch: pytest.MonkeyPatch) -> InMemorySpanExporter:
    """Route ``image.py`` span creation through a fresh in-memory tracer.

    Monkeypatches ``get_tracer`` at the module import site rather than flipping
    the global provider — OTel refuses to override an already-set provider,
    so global-level swaps are unreliable in a shared test process. Uses
    ``SimpleSpanProcessor`` so spans are flushed synchronously.
    """
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.image.get_tracer",
        lambda: provider.get_tracer("test"),
    )

    yield exporter


@pytest.fixture
def metric_reader(monkeypatch: pytest.MonkeyPatch) -> InMemoryMetricReader:
    """Route histogram creation in ``_metrics`` through a fresh in-memory meter.

    Same rationale as ``span_exporter``: monkeypatch the import site so each
    test gets an isolated reader, no matter what the global meter provider is.
    Also resets the lazy-histogram singletons so the next call rebuilds them
    against the test-local meter.
    """
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])

    monkeypatch.setattr(mm_metrics, "get_meter", lambda: provider.get_meter("test"))
    monkeypatch.setattr(mm_metrics, "_image_duration", None)
    monkeypatch.setattr(mm_metrics, "_image_output_bytes", None)

    yield reader


# ── Mock-transport helpers (mirror test_openai_backend) ───────────────────────


def _write_config(config_dir: Path, body: str) -> None:
    (config_dir / "multimodal.yaml").write_text(body, encoding="utf-8")


def _install_openai_mock(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx2.Request], httpx2.Response],
) -> None:
    transport = httpx2.MockTransport(handler)
    real_async_client = httpx2.AsyncClient

    def _mock_async_client(*args: object, **kwargs: object) -> httpx2.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(
        "app.agent.tools.multimodalities.backends.openai.httpx2.AsyncClient",
        _mock_async_client,
    )


def _get_span(exporter: InMemorySpanExporter, *, name_startswith: str) -> ReadableSpan:
    spans = [
        s for s in exporter.get_finished_spans() if s.name.startswith(name_startswith)
    ]
    assert spans, (
        f"no span starting with '{name_startswith}' — "
        f"got {[s.name for s in exporter.get_finished_spans()]}"
    )
    assert len(spans) == 1, (
        f"expected exactly 1, got {len(spans)}: {[s.name for s in spans]}"
    )
    return spans[0]


def _histogram_points(
    reader: InMemoryMetricReader, *, metric_name: str
) -> list[dict[str, object]]:
    """Return the flat list of ``{attributes, sum, count}`` datapoints."""
    data = reader.get_metrics_data()
    if data is None:
        return []
    points: list[dict[str, object]] = []
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                if metric.name != metric_name:
                    continue
                for dp in metric.data.data_points:
                    points.append(
                        {
                            "attributes": dict(dp.attributes),
                            "sum": dp.sum,
                            "count": dp.count,
                        }
                    )
    return points


# ─────────────────────────────────────────────────────────────────────────────
# Happy path: generate
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_generate_span_and_metrics_on_success(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    span_exporter: InMemorySpanExporter,
    metric_reader: InMemoryMetricReader,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(
        config_dir,
        "image:\n  model: openai:gpt-image-2\n  size: 1024x1024\n",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    fake_png = b"\x89PNG\r\n\x1a\nFAKEDATA"
    b64 = base64.b64encode(fake_png).decode("ascii")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_openai_mock(monkeypatch, _handler)

    result = await _generate_image(
        prompt="a red cube",
        filename="cube",
        output_format="png",
    )
    assert result.startswith("![a red cube](")

    # ── Span assertions ──
    span = _get_span(span_exporter, name_startswith="generate_image")
    assert span.name == "generate_image openai:gpt-image-2"
    assert span.status.status_code == StatusCode.OK

    attrs = dict(span.attributes or {})
    assert attrs["gen_ai.operation.name"] == "generate_image"
    assert attrs["gen_ai.provider.name"] == "openai"
    assert attrs["gen_ai.request.model"] == "gpt-image-2"
    assert attrs["image.mode"] == "generate"
    assert attrs["image.prompt_length"] == len("a red cube")
    assert attrs["image.input_count"] == 0
    assert attrs["image.output_format"] == "png"
    assert attrs["image.output_bytes"] == len(fake_png)
    assert "error.type" not in attrs

    # ── Metric assertions ──
    duration = _histogram_points(
        metric_reader, metric_name="openagentd.image.generation.duration"
    )
    assert len(duration) == 1
    assert duration[0]["count"] == 1
    assert duration[0]["attributes"] == {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-image-2",
        "image.mode": "generate",
        "status": "ok",
    }
    assert isinstance(duration[0]["sum"], (int, float))
    assert duration[0]["sum"] >= 0

    bytes_points = _histogram_points(
        metric_reader, metric_name="openagentd.image.output.bytes"
    )
    assert len(bytes_points) == 1
    assert bytes_points[0]["count"] == 1
    assert bytes_points[0]["sum"] == len(fake_png)
    assert bytes_points[0]["attributes"] == {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-image-2",
        "image.mode": "generate",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Happy path: edit (input_count populated)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_edit_span_sets_input_count(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    span_exporter: InMemorySpanExporter,
    metric_reader: InMemoryMetricReader,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    # Seed two source images in the workspace so _load_input_images resolves.
    tmp_sandbox.workspace_root.mkdir(parents=True, exist_ok=True)
    (tmp_sandbox.workspace_root / "a.png").write_bytes(b"\x89PNG-A")
    (tmp_sandbox.workspace_root / "b.png").write_bytes(b"\x89PNG-B")

    fake_png = b"\x89PNG\r\n\x1a\nEDITED"
    b64 = base64.b64encode(fake_png).decode("ascii")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/v1/images/edits"
        return httpx2.Response(200, json={"data": [{"b64_json": b64}]})

    _install_openai_mock(monkeypatch, _handler)

    result = await _generate_image(prompt="swap backgrounds", images=["a.png", "b.png"])
    assert result.startswith("![swap backgrounds](")

    span = _get_span(span_exporter, name_startswith="generate_image")
    attrs = dict(span.attributes or {})
    assert attrs["image.mode"] == "edit"
    assert attrs["image.input_count"] == 2
    assert span.status.status_code == StatusCode.OK

    # Metric label must match span mode.
    duration = _histogram_points(
        metric_reader, metric_name="openagentd.image.generation.duration"
    )
    assert duration[0]["attributes"]["image.mode"] == "edit"
    assert duration[0]["attributes"]["status"] == "ok"


# ─────────────────────────────────────────────────────────────────────────────
# Error: configuration missing (pre-provider)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_configuration_error_marks_span_and_metric(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    span_exporter: InMemorySpanExporter,
    metric_reader: InMemoryMetricReader,
) -> None:
    # No multimodal.yaml written ⇒ cfg is None.
    result = await _generate_image(prompt="anything")
    assert result.startswith("Error: image generation is not configured")

    span = _get_span(span_exporter, name_startswith="generate_image")
    assert span.name == "generate_image"  # provider/model never resolved
    assert span.status.status_code == StatusCode.ERROR
    attrs = dict(span.attributes or {})
    assert attrs["error.type"] == "configuration"
    # Provider/model attrs shouldn't exist at this stage.
    assert "gen_ai.provider.name" not in attrs
    assert "gen_ai.request.model" not in attrs

    duration = _histogram_points(
        metric_reader, metric_name="openagentd.image.generation.duration"
    )
    assert len(duration) == 1
    assert duration[0]["attributes"] == {
        "gen_ai.provider.name": "unknown",
        "gen_ai.request.model": "unknown",
        "image.mode": "unknown",
        "status": "error",
    }

    # No output_bytes datapoint on failure.
    bytes_points = _histogram_points(
        metric_reader, metric_name="openagentd.image.output.bytes"
    )
    assert bytes_points == []


# ─────────────────────────────────────────────────────────────────────────────
# Error: backend (HTTP 401 from provider)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_backend_error_marks_span_and_metric(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    span_exporter: InMemorySpanExporter,
    metric_reader: InMemoryMetricReader,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(config_dir, "image:\n  model: openai:gpt-image-2\n")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    def _handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(401, json={"error": {"message": "bad key"}})

    _install_openai_mock(monkeypatch, _handler)

    result = await _generate_image(prompt="a cat")
    assert result.startswith("Error:")

    span = _get_span(span_exporter, name_startswith="generate_image")
    assert span.name == "generate_image openai:gpt-image-2"
    assert span.status.status_code == StatusCode.ERROR
    attrs = dict(span.attributes or {})
    assert attrs["error.type"] == "backend"
    assert attrs["gen_ai.provider.name"] == "openai"
    assert attrs["gen_ai.request.model"] == "gpt-image-2"

    duration = _histogram_points(
        metric_reader, metric_name="openagentd.image.generation.duration"
    )
    assert len(duration) == 1
    assert duration[0]["attributes"] == {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-image-2",
        "image.mode": "generate",
        "status": "error",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Error: unknown provider
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_provider_error_classification(
    tmp_sandbox: SandboxConfig,
    config_dir: Path,
    span_exporter: InMemorySpanExporter,
    metric_reader: InMemoryMetricReader,
) -> None:
    _write_config(config_dir, "image:\n  model: stability:sdxl\n")

    result = await _generate_image(prompt="a cat")
    assert result.startswith("Error:")

    span = _get_span(span_exporter, name_startswith="generate_image")
    # Provider is set before the registry lookup fails.
    assert span.name == "generate_image stability:sdxl"
    attrs = dict(span.attributes or {})
    assert span.status.status_code == StatusCode.ERROR
    assert attrs["error.type"] == "unknown_provider"
    assert attrs["gen_ai.provider.name"] == "stability"

    duration = _histogram_points(
        metric_reader, metric_name="openagentd.image.generation.duration"
    )
    assert duration[0]["attributes"]["gen_ai.provider.name"] == "stability"
    assert duration[0]["attributes"]["status"] == "error"
    # Model + mode still unknown at this branch.
    assert duration[0]["attributes"]["gen_ai.request.model"] == "unknown"
    assert duration[0]["attributes"]["image.mode"] == "unknown"
