"""Prometheus metrics registry + ASGI middleware.

Exposes a ``/metrics`` endpoint (text/plain in Prometheus exposition format)
and an ``HTTPMetricsMiddleware`` that records per-request duration + status
histograms.

Metric naming follows the Prometheus convention ``{namespace}_{subsystem}_
{name}_{unit}``.  Namespace is always ``openagentd``.

Usage::

    from app.core.metrics import (
        HTTPMetricsMiddleware,
        metrics_endpoint,
        SPANS_DROPPED,
        TURNS_TOTAL,
    )

    app.add_middleware(HTTPMetricsMiddleware)
    app.add_route("/metrics", metrics_endpoint)

    SPANS_DROPPED.inc()
    TURNS_TOTAL.labels(status="ok").inc()
"""

from __future__ import annotations

import time

from fastapi import Request
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.responses import Response
from starlette.routing import Match

# ── Registry ──────────────────────────────────────────────────────────────────
# Single process — use a dedicated registry so tests can reset it without
# touching the global default_registry (which would nuke other tests).

REGISTRY: CollectorRegistry = CollectorRegistry()

# ── HTTP metrics ──────────────────────────────────────────────────────────────

HTTP_REQUESTS = Counter(
    "openagentd_http_requests_total",
    "Total HTTP requests grouped by method, route template, and status class.",
    labelnames=("method", "route", "status"),
    registry=REGISTRY,
)

HTTP_REQUEST_DURATION = Histogram(
    "openagentd_http_request_duration_seconds",
    "HTTP request duration in seconds grouped by method and route template.",
    labelnames=("method", "route"),
    # Buckets tuned for API traffic: 1ms → 30s.
    buckets=(
        0.005,
        0.01,
        0.025,
        0.05,
        0.1,
        0.25,
        0.5,
        1.0,
        2.5,
        5.0,
        10.0,
        30.0,
    ),
    registry=REGISTRY,
)

# ── Agent / turn metrics ──────────────────────────────────────────────────────

TURNS_TOTAL = Counter(
    "openagentd_turns_total",
    "Total agent turns completed, grouped by status (ok|error|cancelled).",
    labelnames=("status",),
    registry=REGISTRY,
)

TURN_DURATION = Histogram(
    "openagentd_turn_duration_seconds",
    "End-to-end turn duration in seconds.",
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600),
    registry=REGISTRY,
)

# ── Observability plumbing metrics ────────────────────────────────────────────

SPANS_DROPPED = Counter(
    "openagentd_otel_spans_dropped_total",
    "Spans dropped by the JSONL writer due to backpressure.",
    registry=REGISTRY,
)

SPANS_WRITTEN = Counter(
    "openagentd_otel_spans_written_total",
    "Spans successfully flushed to the JSONL writer.",
    registry=REGISTRY,
)


# ── Middleware ────────────────────────────────────────────────────────────────


def _route_template(request: Request) -> str:
    """Return a stable route template ('/api/team/{sid}') for label cardinality.

    Falls back to the raw path when no route matches (404, /metrics, etc).
    """
    for route in request.app.router.routes:
        match, _ = route.matches(request.scope)
        if match == Match.FULL:
            return getattr(route, "path", request.url.path)
    return request.url.path


def _status_class(status_code: int) -> str:
    """Reduce cardinality: group status codes into 2xx/3xx/4xx/5xx."""
    return f"{status_code // 100}xx"


class HTTPMetricsMiddleware:
    """Record per-request duration + status counter."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Skip the /metrics endpoint itself — otherwise every scrape would
        # bump the counter and the histogram would drown in self-traffic.
        path = scope.get("path", "")
        if path == "/metrics":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        start = time.perf_counter()
        status_code = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 500)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            elapsed = time.perf_counter() - start
            route = _route_template(request)
            HTTP_REQUESTS.labels(method=request.method, route=route, status="5xx").inc()
            HTTP_REQUEST_DURATION.labels(method=request.method, route=route).observe(
                elapsed
            )
            raise

        elapsed = time.perf_counter() - start
        route = _route_template(request)
        HTTP_REQUESTS.labels(
            method=request.method, route=route, status=_status_class(status_code)
        ).inc()
        HTTP_REQUEST_DURATION.labels(method=request.method, route=route).observe(
            elapsed
        )


# ── /metrics endpoint ─────────────────────────────────────────────────────────


async def metrics_endpoint(_request: Request) -> Response:
    """Expose the registry in Prometheus exposition format."""
    return Response(
        content=generate_latest(REGISTRY),
        media_type=CONTENT_TYPE_LATEST,
    )
