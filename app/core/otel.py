"""OpenTelemetry SDK bootstrap — file-based export, no external service required.

Output layout (default; overridden when ``OTEL_EXPORTER_OTLP_ENDPOINT`` is set):

    {STATE_DIR}/otel/spans/YYYY-MM-DD-HH.jsonl      (hourly partitions)
    {STATE_DIR}/otel/metrics/YYYY-MM-DD.jsonl       (daily partitions)

Design
------
- **Always-sample at head** so the filter below can make tail-like decisions on
  error status + duration.  Cardinality is controlled by a deterministic
  per-trace ratio in the export filter, not by dropping at span-start.
- **Tier at export time** — every span that ended is inspected:
    1. Error spans are always exported.
    2. Spans longer than ``OTEL_SLOW_SPAN_MS`` are always exported.
    3. Others are exported only when the deterministic trace hash falls under
       ``OTEL_SPAN_SAMPLE_RATIO`` (default 1.0 — keep everything; lower the
       ratio only if span volume becomes unmanageable).
- **JsonlBatchWriter** is used for both spans and metrics — bounded queue,
  drop-on-backpressure, and hourly span partitioning.

Env vars
--------
- ``OTEL_EXPORTER_OTLP_ENDPOINT`` — forward to real OTLP backend, skip file.
- ``OTEL_SPAN_SAMPLE_RATIO`` — float in [0.0, 1.0]; default 1.0. Keep the
  default so every tool invocation shows up in the waterfall; only lower it
  if span volume becomes unmanageable.
- ``OTEL_SLOW_SPAN_MS`` — int; spans slower than this are always kept, even
  if the ratio drops them. Default 1000.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    MetricExporter,
    MetricExportResult,
    MetricsData,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.sdk.trace.sampling import ALWAYS_ON
from opentelemetry.trace.status import StatusCode

from app.core.jsonl_writer import (
    JsonlBatchWriter,
    daily_partition,
    hourly_partition,
)

_INSTRUMENTATION_SCOPE = "openagentd"
_logger = logging.getLogger(__name__)

_tracer_provider: TracerProvider | None = None
_meter_provider: MeterProvider | None = None
_span_writer: JsonlBatchWriter | None = None
_metric_writer: JsonlBatchWriter | None = None


# ── Sampling config ───────────────────────────────────────────────────────────


def _sample_ratio() -> float:
    raw = os.getenv("OTEL_SPAN_SAMPLE_RATIO", "1.0")
    try:
        v = float(raw)
    except ValueError:
        return 1.0
    return max(0.0, min(1.0, v))


def _slow_span_threshold_ns() -> int:
    raw = os.getenv("OTEL_SLOW_SPAN_MS", "1000")
    try:
        return int(float(raw) * 1_000_000)
    except ValueError:
        return 1_000_000_000


def _trace_passes_ratio(trace_id: int, ratio: float) -> bool:
    """Deterministic per-trace sampling: use the low 64 bits as a pseudo-random
    value.  Equivalent to ``TraceIdRatioBased`` so collectors stay consistent.
    """
    if ratio >= 1.0:
        return True
    if ratio <= 0.0:
        return False
    # Same normalisation used by OTel's TraceIdRatioBased.
    threshold = int(ratio * (1 << 64))
    return (trace_id & ((1 << 64) - 1)) < threshold


# ── File exporters ────────────────────────────────────────────────────────────


class _FilteringJsonlSpanExporter(SpanExporter):
    """Feeds spans to ``JsonlBatchWriter`` after applying the error/slow/ratio tier."""

    def __init__(self, writer: JsonlBatchWriter) -> None:
        self._writer = writer
        self._ratio = _sample_ratio()
        self._slow_ns = _slow_span_threshold_ns()

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        for span in spans:
            if not self._should_export(span):
                continue
            self._writer.write(_span_to_dict(span), ts=_span_end_datetime(span))
        return SpanExportResult.SUCCESS

    def _should_export(self, span: ReadableSpan) -> bool:
        # Tier 1: errors always exported.
        if span.status.status_code == StatusCode.ERROR:
            return True
        # Tier 2: slow spans always exported.
        if span.start_time is not None and span.end_time is not None:
            duration = span.end_time - span.start_time
            if duration >= self._slow_ns:
                return True
        # Tier 3: deterministic ratio.
        ctx = span.get_span_context()
        if ctx is None:
            return False
        return _trace_passes_ratio(ctx.trace_id, self._ratio)

    def shutdown(self) -> None:
        pass


class _JsonlMetricExporter(MetricExporter):
    """Feeds metric batches to ``JsonlBatchWriter`` (daily partitions)."""

    def __init__(self, writer: JsonlBatchWriter) -> None:
        super().__init__()
        self._writer = writer

    def export(
        self, metrics_data: MetricsData, timeout_millis: float = 10_000, **_: object
    ) -> MetricExportResult:
        self._writer.write(
            _metrics_to_dict(metrics_data),
            ts=datetime.now(timezone.utc),
        )
        return MetricExportResult.SUCCESS

    def force_flush(self, timeout_millis: float = 30_000) -> bool:
        return True

    def shutdown(self, timeout_millis: float = 30_000, **_: object) -> None:
        pass


# ── Serialisation helpers ─────────────────────────────────────────────────────


def _span_end_datetime(span: ReadableSpan) -> datetime:
    if span.end_time:
        return datetime.fromtimestamp(span.end_time / 1_000_000_000, tz=timezone.utc)
    return datetime.now(timezone.utc)


def _span_to_dict(span: ReadableSpan) -> dict:
    ctx = span.context
    parent_id = (
        f"0x{span.parent.span_id:016x}" if span.parent and span.parent.span_id else None
    )
    return {
        "name": span.name,
        "trace_id": f"0x{ctx.trace_id:032x}" if ctx else None,
        "span_id": f"0x{ctx.span_id:016x}" if ctx else None,
        "parent_id": parent_id,
        "kind": str(span.kind.name),
        "start_time": span.start_time,
        "end_time": span.end_time,
        "duration_ms": round((span.end_time - span.start_time) / 1_000_000, 3)
        if span.start_time and span.end_time
        else None,
        "status": span.status.status_code.name,
        "attributes": dict(span.attributes or {}),
        "events": [
            {
                "name": e.name,
                "timestamp": e.timestamp,
                "attributes": dict(e.attributes or {}),
            }
            for e in (span.events or [])
        ],
        "resource": dict((span.resource or Resource.create()).attributes),
    }


def _metrics_to_dict(data: MetricsData) -> dict:
    """Minimal flat dict for metrics JSONL — readable without OTel SDK."""
    out: list[dict] = []
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for m in sm.metrics:
                out.append(
                    {
                        "name": m.name,
                        "description": m.description,
                        "unit": m.unit,
                        "data": str(m.data),
                    }
                )
    return {"metrics": out}


# ── Setup / teardown ──────────────────────────────────────────────────────────


def setup_otel(
    service_name: str = "openagentd",
    otel_dir: Path | None = None,
) -> None:
    """Bootstrap OTel SDK.  Safe to call multiple times — idempotent.

    Args:
        service_name: Emitted as ``service.name`` resource attribute.
        otel_dir: Directory for span/metric files.  Defaults to
            ``{OPENAGENTD_STATE_DIR}/otel/`` resolved from settings.
    """
    global _tracer_provider, _meter_provider, _span_writer, _metric_writer

    if _tracer_provider is not None:
        return  # Me already set up

    if otel_dir is None:
        from app.core.config import settings

        otel_dir = Path(settings.OPENAGENTD_STATE_DIR) / "otel"

    resource = Resource.create({"service.name": service_name})

    # ── Tracer provider ───────────────────────────────────────────────────────
    # Head sampler is ALWAYS_ON; tiering happens at export via the filter.
    _tracer_provider = TracerProvider(resource=resource, sampler=ALWAYS_ON)

    otlp_endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if otlp_endpoint:
        try:
            # Optional dep; ImportError is handled below.
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (  # ty: ignore[unresolved-import]
                OTLPSpanExporter,
            )

            _tracer_provider.add_span_processor(
                BatchSpanProcessor(OTLPSpanExporter(endpoint=otlp_endpoint))
            )
            _logger.info("otel_trace_exporter=otlp endpoint=%s", otlp_endpoint)
        except ImportError:
            _logger.warning(
                "otel_otlp_exporter_unavailable "
                "install opentelemetry-exporter-otlp-proto-grpc"
            )
    else:
        spans_dir = otel_dir / "spans"
        _span_writer = JsonlBatchWriter(
            root=spans_dir,
            partition_fn=hourly_partition,
            name="spans",
        )
        _tracer_provider.add_span_processor(
            BatchSpanProcessor(_FilteringJsonlSpanExporter(_span_writer))
        )
        _logger.info(
            "otel_trace_exporter=file dir=%s sample_ratio=%.3f slow_ms=%d",
            spans_dir,
            _sample_ratio(),
            _slow_span_threshold_ns() // 1_000_000,
        )

    trace.set_tracer_provider(_tracer_provider)

    # ── Meter provider ────────────────────────────────────────────────────────
    metrics_dir = otel_dir / "metrics"
    _metric_writer = JsonlBatchWriter(
        root=metrics_dir,
        partition_fn=daily_partition,
        name="metrics",
    )
    metric_reader = PeriodicExportingMetricReader(
        _JsonlMetricExporter(_metric_writer),
        export_interval_millis=60_000,  # Me flush metrics every 60 s
    )
    _meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(_meter_provider)

    _logger.info(
        "otel_setup_complete service=%s spans_dir=%s metrics_dir=%s",
        service_name,
        otel_dir / "spans",
        metrics_dir,
    )


def shutdown_otel() -> None:
    """Flush and shut down providers gracefully on app shutdown."""
    global _span_writer, _metric_writer
    if _tracer_provider is not None:
        _tracer_provider.shutdown()
    if _meter_provider is not None:
        _meter_provider.shutdown()
    if _span_writer is not None:
        _span_writer.close()
        _span_writer = None
    if _metric_writer is not None:
        _metric_writer.close()
        _metric_writer = None


def get_tracer() -> trace.Tracer:
    """Return the openagentd tracer. setup_otel() must have been called first."""
    return trace.get_tracer(_INSTRUMENTATION_SCOPE)


def get_meter() -> metrics.Meter:
    """Return the openagentd meter. setup_otel() must have been called first."""
    return metrics.get_meter(_INSTRUMENTATION_SCOPE)
