"""FastAPI application factory."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from app.agent.mcp import mcp_manager
from app.api.routes.agents import router as agents_router
from app.api.routes.dream import router as dream_router
from app.api.routes.health import router as health_router
from app.api.routes.mcp import router as mcp_router
from app.api.routes.observability import router as observability_router
from app.api.routes.quote import router as quote_router
from app.api.routes.scheduler import router as scheduler_router
from app.api.routes.settings import router as settings_router
from app.api.routes.skills import router as skills_router
from app.api.routes.speech import router as speech_router
from app.api.routes.team import router as team_router
from app.api.routes.wiki import router as wiki_router
from app.core.config import settings
from app.core.exception_handlers import EXCEPTION_HANDLERS
from app.core.metrics import HTTPMetricsMiddleware, metrics_endpoint
from app.core.middlewares import RequestSizeLimitMiddleware, SecurityHeadersMiddleware
from app.core.otel import setup_otel, shutdown_otel
from app.core.otel_retention import start_otel_retention, stop_otel_retention
from app.scheduler.scheduler import task_scheduler
from app.services import memory_stream_store as stream_store, team_manager

from app.core.version import VERSION


# ── Bundled web UI discovery ─────────────────────────────────────────────────
# Checked in order: 1) package-embedded assets  2) dev build in web/dist/


def _find_web_dist() -> Path | None:
    """Return the path to the built web UI assets, or None if not found."""
    # 1. Inside the installed package (pip install / wheel)
    pkg_dist = Path(__file__).resolve().parent.parent / "_web_dist"
    if (pkg_dist / "index.html").is_file():
        return pkg_dist
    # 2. Development: built via `make build-web` in the project tree
    dev_dist = Path(__file__).resolve().parent.parent.parent / "web" / "dist"
    if (dev_dist / "index.html").is_file():
        return dev_dist
    return None


def _mount_web_ui(app: FastAPI) -> None:
    """Mount the pre-built web UI as static files with SPA fallback.

    Only activates when built assets exist (i.e. after `make build-web` or in a
    wheel that includes them).  In dev mode with `bun dev`, the Vite dev server
    handles the frontend — this mount is silently skipped.
    """
    dist = _find_web_dist()
    if dist is None:
        logger.debug("web_ui_not_found serving_api_only")
        return

    logger.info("web_ui_mounted path={}", dist)

    # Serve /assets/<hash>.js, /assets/<hash>.css, etc.
    assets_dir = dist / "assets"
    if assets_dir.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=str(assets_dir)),
            name="web-assets",
        )

    # Serve other static files at root (favicon, vite.svg, etc.)
    # Using a catch-all route rather than mounting "/" to avoid conflicts with
    # /api routes. FastAPI evaluates routes top-down, so /api/* wins first.
    index_html = dist / "index.html"

    @app.get("/{full_path:path}")
    async def _serve_spa(full_path: str):
        """SPA fallback: serve the file if it exists, otherwise index.html.

        Explicitly 404s for unmatched /api/* and /metrics paths so typo'd API
        routes surface clearly during client dev instead of being masked by
        the index.html fallback.
        """
        if full_path.startswith(("api/", "metrics")):
            raise HTTPException(status_code=404)
        file = (dist / full_path).resolve()
        if file.is_file() and file.is_relative_to(dist):
            return FileResponse(str(file))
        return FileResponse(str(index_html))


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("server_starting version={}", VERSION)

    # ── Auto-migrate DB in production ───────────────────────────────
    if settings.APP_ENV == "production":
        # Alembic's ``env.py`` calls ``asyncio.run(run_migrations_online())``
        # which fails when invoked from inside uvicorn's running loop. Push
        # the sync call onto a worker thread so its private loop is isolated.
        from app.core.db import run_migrations

        await asyncio.to_thread(run_migrations)

    # ── Seed wiki directory on first boot ──────────────────────────────
    from app.core.wiki_seed import seed_wiki

    seed_wiki()

    setup_otel(service_name="openagentd")
    start_otel_retention()

    # Start MCP servers and wait for them to finish initializing before the
    # team loads — otherwise the loader resolves agents' `mcp:` lists against
    # not-yet-ready runners and they end up with zero MCP tools forever.
    # Servers still pending after the timeout fall back to graceful empty.
    await mcp_manager.start()
    await mcp_manager.wait_until_ready()

    team = await team_manager.start()
    if team is None:
        logger.warning("agents_dir_empty_or_missing path={}", settings.AGENTS_DIR)
    else:
        logger.info("team_started")

    await task_scheduler.start()

    # Start dream scheduler (only if dream.md exists and enabled: true)
    from app.core.db import async_session_factory
    from app.services.dream_scheduler import DreamScheduler

    dream_scheduler = DreamScheduler(db_factory=async_session_factory)
    await dream_scheduler.start()
    app.state.dream_scheduler = dream_scheduler

    yield

    await dream_scheduler.stop()
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
    app.include_router(wiki_router, prefix="/api/wiki", tags=["wiki"])
    app.include_router(agents_router, prefix="/api/agents", tags=["agents"])
    app.include_router(skills_router, prefix="/api/skills", tags=["skills"])
    app.include_router(
        observability_router, prefix="/api/observability", tags=["observability"]
    )
    app.include_router(scheduler_router, prefix="/api/scheduler", tags=["scheduler"])
    app.include_router(mcp_router, prefix="/api/mcp", tags=["mcp"])
    app.include_router(settings_router, prefix="/api/settings", tags=["settings"])
    app.include_router(speech_router, prefix="/api/speech", tags=["speech"])
    app.include_router(dream_router, prefix="/api", tags=["dream"])

    # ── Static web UI (production: bundled assets) ────────────────────────
    _mount_web_ui(app)

    return app
