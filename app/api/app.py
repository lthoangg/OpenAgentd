"""FastAPI application factory."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from app.agent.mcp import load_config as load_mcp_config, mcp_manager
from app.api.routes.agents import router as agents_router
from app.api.routes.auth import router as auth_router
from app.api.routes.commands import router as commands_router
from app.api.routes.diagnostics import router as diagnostics_router
from app.api.routes.health import router as health_router
from app.api.routes.mcp import router as mcp_router
from app.api.routes.observability import router as observability_router
from app.api.routes.quote import router as quote_router
from app.api.routes.scheduler import router as scheduler_router
from app.api.routes.settings import router as settings_router
from app.api.routes.skills import router as skills_router
from app.api.routes.snippets import router as snippets_router
from app.api.routes.team import router as team_router
from app.core.config import settings
from app.core.desktop_auth import DesktopTokenMiddleware
from app.core.exception_handlers import EXCEPTION_HANDLERS
from app.core.metrics import HTTPMetricsMiddleware, metrics_endpoint
from app.core.middlewares import RequestSizeLimitMiddleware, SecurityHeadersMiddleware
from app.core.otel import setup_otel, shutdown_otel
from app.core.otel_retention import start_otel_retention, stop_otel_retention
from app.core.workspace_init import ensure_workspace_initialized
from app.scheduler.scheduler import task_scheduler
from app.services import memory_stream_store as stream_store, team_manager

from app.core.version import VERSION


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("server_starting version={}", VERSION)

    ensure_workspace_initialized()

    # ── Auto-migrate DB in production ───────────────────────────────
    if settings.APP_ENV == "production":
        # Alembic's ``env.py`` calls ``asyncio.run(run_migrations_online())``
        # which fails when invoked from inside uvicorn's running loop. Push
        # the sync call onto a worker thread so its private loop is isolated.
        from app.core.db import run_migrations

        await asyncio.to_thread(run_migrations)

    setup_otel(service_name="openagentd")
    start_otel_retention()

    try:
        mcp_config = load_mcp_config()
    except ValueError as exc:
        logger.error("mcp_config_invalid err={}", exc)
    else:
        if mcp_config.servers:
            # Start MCP runners best-effort without blocking API startup. Agents already
            # tolerate not-yet-ready MCP servers and pick up tools on their next refresh.
            await mcp_manager.start()
        else:
            logger.info("mcp_no_servers_configured")

    # Parse-only validation at boot: surfaces malformed agent ``.md`` files
    # immediately instead of waiting for the first request to fail.  The
    # team itself is built lazily on the first chat / scheduler fire — see
    # ``app.services.team_manager.get_or_start_team``.
    try:
        if not team_manager.validate_agents_dir():
            logger.warning("agents_dir_empty_or_missing path={}", settings.AGENTS_DIR)
    except ValueError as exc:
        logger.error("agents_dir_invalid path={} error={}", settings.AGENTS_DIR, exc)
        raise

    if await task_scheduler.has_enabled_tasks():
        await task_scheduler.start()
    else:
        logger.info("scheduler_no_enabled_tasks")

    yield

    await task_scheduler.stop()
    await team_manager.stop()
    await mcp_manager.stop()

    await stream_store.close()
    await stop_otel_retention()
    shutdown_otel()

    logger.info("server_shutdown")


def create_app() -> FastAPI:
    """Construct and configure the FastAPI application."""
    app = FastAPI(
        title="OpenAgentd",
        description="On-machine AI agents",
        version=VERSION,
        lifespan=lifespan,
        exception_handlers=EXCEPTION_HANDLERS,
    )

    # ── Middleware ────────────────────────────────────────────────────────────
    # Metrics first (outermost) so it wraps everything else and records the
    # true end-to-end latency, including CORS / size-limit rejects.
    app.add_middleware(HTTPMetricsMiddleware)
    app.add_middleware(RequestSizeLimitMiddleware)
    # Desktop token auth — no-op unless OPENAGENTD_DESKTOP_TOKEN is set
    # (Tauri shell sets it; CLI/server users get the existing open behaviour).
    app.add_middleware(DesktopTokenMiddleware)
    # Security headers run *inside* CORS so CORS preflights still receive the
    # right `Access-Control-*` headers unobstructed.
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── /metrics (Prometheus scrape target) ───────────────────────────────────
    # Deliberately un-prefixed (not under /api) to match Prometheus convention.
    app.add_route("/metrics", metrics_endpoint, methods=["GET"])

    # ── Routers (all under /api) ─────────────────────────────────────────────
    app.include_router(health_router, prefix="/api/health", tags=["health"])
    app.include_router(team_router, prefix="/api/team", tags=["team"])
    app.include_router(quote_router, prefix="/api/quote", tags=["quote"])
    app.include_router(agents_router, prefix="/api/agents", tags=["agents"])
    app.include_router(skills_router, prefix="/api/skills", tags=["skills"])
    app.include_router(commands_router, prefix="/api/commands", tags=["commands"])
    app.include_router(snippets_router, prefix="/api/snippets", tags=["snippets"])
    app.include_router(
        observability_router, prefix="/api/observability", tags=["observability"]
    )
    app.include_router(scheduler_router, prefix="/api/scheduler", tags=["scheduler"])
    app.include_router(mcp_router, prefix="/api/mcp", tags=["mcp"])
    app.include_router(settings_router, prefix="/api/settings", tags=["settings"])
    app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
    app.include_router(
        diagnostics_router, prefix="/api/diagnostics", tags=["diagnostics"]
    )

    logger.debug("api_only_app_ready")

    return app
