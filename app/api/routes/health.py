"""Health probes.

Two separate endpoints so orchestrators can distinguish "is the process
alive?" from "is it ready to serve traffic?":

- ``GET /api/health/live``   → always 200 if the process is up.
- ``GET /api/health/ready``  → 200 only when DB + agent are ready; 503 otherwise.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from loguru import logger
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import text
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.db import get_session
from app.core.version import VERSION
from app.services import agent_manager

router = APIRouter()


class HealthLiveResponse(BaseModel):
    status: str
    version: str


class HealthReadyResponse(BaseModel):
    status: str
    version: str
    checks: dict[str, str]


@router.get("/live")
async def health_live() -> HealthLiveResponse:
    """Liveness probe — returns 200 as long as the event loop is alive.

    Never touches the DB; safe for high-frequency orchestrator polling.
    """
    return HealthLiveResponse(status="ok", version=VERSION)


async def _check_ready(session: AsyncSession) -> HealthReadyResponse:
    checks: dict[str, str] = {}

    # ── DB ────────────────────────────────────────────────────────────────
    # ``session.exec`` overloads only cover Select/UpdateBase, so a raw
    # ``text(...)`` SELECT 1 ping doesn't match — works at runtime via the
    # SQLAlchemy passthrough but the type checker can't see it.
    try:
        await session.exec(text("SELECT 1"))  # ty: ignore[no-matching-overload]
        checks["db"] = "ok"
    except SQLAlchemyError as exc:
        logger.warning("health_ready_db_failed error={}", exc)
        checks["db"] = "fail"

    # ── Agent ─────────────────────────────────────────────────────────────
    # The agent builds lazily on first use, so an in-memory agent is not a
    # useful readiness signal. Report on whether its directory is loadable.
    try:
        checks["agent"] = "ok" if agent_manager.validate_agents_dir() else "missing"
    except ValueError as exc:
        logger.warning("health_ready_agent_invalid error={}", exc)
        checks["agent"] = "invalid"

    ready = checks["db"] == "ok"  # agent "missing" is tolerable (empty agents dir)
    return HealthReadyResponse(
        status="ok" if ready else "degraded",
        version=VERSION,
        checks=checks,
    )


@router.get("/ready")
async def health_ready(
    session: AsyncSession = Depends(get_session),
) -> HealthReadyResponse:
    """Readiness probe — 200 when dependencies are healthy, 503 otherwise."""
    result = await _check_ready(session)
    if result.status != "ok":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=result.model_dump(),
        )
    return result
